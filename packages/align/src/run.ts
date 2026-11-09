/**
 * `runAlign`: the whole `seamline align` pipeline behind one function, which
 * the CLI reaches through its `AlignPort`. Load the tree, evaluate, redact,
 * render, write. The CLI decides what may be emitted (the export profile); this
 * function does what it is told and writes only through `writeOutput`.
 */

import { readBaseline } from './baseline.ts';
import { evaluate } from './engine.ts';
import type { AlignFacts } from './facts.ts';
import { redactPacket, type RedactedPacket } from './redact.ts';
import { gitTree, resolveCommit, worktreeTree, type Tree } from './tree.ts';
import {
  renderPacket,
  renderSummaryJson,
  renderSummaryText,
  writeOutput,
  type AlignSink,
} from './write.ts';

export type AlignOutput =
  /** No profile: the human summary, or with `json` the summary object. */
  | { readonly packet: false; readonly json: boolean }
  /** A profile that allows `packets: ['alignment']`: the packet to stdout, or to `file` (then the summary to stdout). */
  | { readonly packet: true; readonly file: string | null; readonly json: boolean };

export interface AlignRequest {
  readonly repoRoot: string;
  readonly repo: string;
  /** A revision to evaluate; `null` is `HEAD`. Ignored with `worktree`. */
  readonly at: string | null;
  readonly worktree: boolean;
  readonly facts: AlignFacts;
  readonly baselineText: string | null;
  readonly config: { readonly docs?: readonly string[]; readonly exclude?: readonly string[] };
  readonly output: AlignOutput;
  readonly producer: { readonly toolVersion: string; readonly sifVersion: string };
  /** Test seam: a prepared tree and commit instead of reading git. */
  readonly tree?: { readonly tree: Tree; readonly commit: string | null };
}

export async function runAlign(request: AlignRequest, sink: AlignSink): Promise<RedactedPacket> {
  let tree: Tree;
  let commit: string | null;
  if (request.tree !== undefined) {
    ({ tree, commit } = request.tree);
  } else if (request.worktree) {
    tree = worktreeTree(request.repoRoot);
    commit = null;
  } else {
    commit = resolveCommit(request.repoRoot, request.at ?? 'HEAD');
    tree = gitTree(request.repoRoot, commit);
  }
  const baseline = request.baselineText === null ? null : readBaseline(request.baselineText);
  const body = evaluate({
    repo: request.repo,
    tree,
    commit,
    worktree: request.worktree,
    facts: request.facts,
    baseline,
    config: request.config,
    producer: request.producer,
  });
  const redacted = redactPacket(body);
  const summary = request.output.json
    ? renderSummaryJson(redacted)
    : renderSummaryText(redacted, request.output.packet);
  if (request.output.packet) {
    if (request.output.file === null) {
      writeOutput(sink, { to: 'stdout' }, renderPacket(redacted));
    } else {
      writeOutput(sink, { to: 'file', path: request.output.file }, renderPacket(redacted));
      writeOutput(sink, { to: 'stdout' }, summary);
    }
  } else {
    writeOutput(sink, { to: 'stdout' }, summary);
  }
  return redacted;
}
