/**
 * The alignment port's real implementation: reads the implementation facts from
 * a SIF snapshot or from the store, and hands them to `@seamline/align`.
 *
 * `@seamline/align` is kept free of storage and of the SIF codec so that it
 * stays offline and testable with plain data. This file, with
 * `commands/align.ts`, is where the CLI touches it: no pipeline stage imports
 * `@seamline/align` (alignment design 9, ADR-0014 section 6).
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  AlignError,
  buildScopeTable,
  runAlign,
  type AlignFacts,
  type FactsRun,
  type ImportEdge,
} from '@seamline/align';
import {
  SIF_VERSION,
  isFact,
  type RunRecord,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import type { AlignPort, AlignPortRequest, Workspace } from './ports.ts';
import { isCompletedRun } from '@seamline/core';
import { createRedactor } from '@seamline/security';
import { canonicalJson, parseSif } from './sif.ts';

/** How many runs to read from a store: enough to find the newest run that declared each scope. */
const STORE_RUN_WINDOW = 200;

interface GraphParts {
  readonly files: string[];
  readonly symbolPaths: string[];
  readonly imports: ImportEdge[];
}

/**
 * File paths, Symbol paths and file-level `IMPORTS` edges of a set of live nodes and edges (4.4).
 * Only facts count (`isFact`, AGENTS.md invariant 5): an INFERRED or LLM_SUGGESTED node or
 * edge never reaches a probe.
 */
export function graphParts(
  nodes: readonly SeamlineNode[],
  edges: readonly SeamlineEdge[],
): GraphParts {
  const pathOfFile = new Map<string, string>();
  const symbolPaths = new Set<string>();
  for (const node of nodes) {
    if (node.deletedAt !== null || node.path === undefined || !isFact(node.provenance)) continue;
    if (node.kind === 'File') pathOfFile.set(node.id, node.path);
    else if (node.kind === 'Symbol') symbolPaths.add(node.path);
  }
  const imports: ImportEdge[] = [];
  for (const edge of edges) {
    if (edge.kind !== 'IMPORTS' || edge.deletedAt !== null || !isFact(edge.provenance)) continue;
    const src = pathOfFile.get(edge.src);
    const dst = pathOfFile.get(edge.dst);
    if (src !== undefined && dst !== undefined)
      imports.push({ src, dst, reExport: edge.props['reExport'] === true });
  }
  return { files: [...pathOfFile.values()].sort(), symbolPaths: [...symbolPaths].sort(), imports };
}

function sha256(data: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** The caller pairs the evaluated commit when a legacy or uncommitted run carries none. */
export async function factsFromSif(file: string): Promise<AlignFacts> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new AlignError(
      'runtime',
      `cannot read the facts file ${createRedactor({ entropyEnabled: false }).redactString(file)}.`,
      'Pass a SIF snapshot written by `seamline extract`.',
    );
  }
  let snapshot;
  try {
    snapshot = parseSif(bytes.toString('utf8'), file);
  } catch (e) {
    throw new AlignError(
      'runtime',
      `the facts file is not a readable SIF snapshot: ${(e as Error).message}`,
    );
  }
  const run: FactsRun = {
    runId: snapshot.runId,
    commit: snapshot.run?.commit ?? null,
    ontologyVersion: snapshot.run?.ontologyVersion ?? null,
    results: isCompletedRun(snapshot.run) ? snapshot.results : [],
  };
  return {
    source: 'sif',
    digest: sha256(bytes),
    runs: [run],
    ...graphParts(snapshot.nodes, snapshot.edges),
  };
}

/** The store's runs, newest first, and the graph the newest scope table describes. */
export async function factsFromStore(workspace: Workspace): Promise<AlignFacts> {
  const records: readonly RunRecord[] = await workspace.runs.list(STORE_RUN_WINDOW);
  // An unfinished newest run may already have raw upserts. Older completed
  // scope declarations cannot certify that partially replaced graph.
  const completed = isCompletedRun(records[0]);
  const runs: FactsRun[] = records.map((r) => ({
    runId: r.runId,
    commit: r.commit,
    ontologyVersion: r.ontologyVersion,
    results: completed && isCompletedRun(r) ? r.results : [],
  }));
  const files = workspace.store.nodesByKind('File');
  const nodes = [...files, ...workspace.store.nodesByKind('Symbol')];
  const edges = files.flatMap((f) => workspace.store.edgesFrom(f.id, 'IMPORTS'));
  const scopes = [...buildScopeTable(runs).values()];
  return {
    source: 'store',
    digest: sha256(canonicalJson({ run: records[0] ?? null, scopes })),
    runs,
    ...graphParts(nodes, edges),
  };
}

export function alignPort(): AlignPort {
  return {
    async run(request: AlignPortRequest, sink): Promise<void> {
      const facts =
        request.facts.kind === 'sif'
          ? await factsFromSif(request.facts.file)
          : await factsFromStore(request.facts.workspace);
      await runAlign(
        {
          repoRoot: request.repoRoot,
          repo: request.repo,
          at: request.at,
          worktree: request.worktree,
          facts,
          baselineText: request.baselineText,
          config: request.config,
          output: request.output,
          producer: { toolVersion: request.toolVersion, sifVersion: SIF_VERSION },
        },
        sink,
      );
    },
  };
}
