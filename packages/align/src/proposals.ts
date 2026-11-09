/**
 * Proposals (design 8.6): candidate links that are not anchored. In v1 the only
 * producer is a `CONTROL_ENFORCEMENT` row that came out
 * `Unknown(claim-unanchored)`. No model is called. A candidate is a non-test
 * TypeScript or JavaScript file whose header comment shares at least two word
 * 2-grams with the row's second cell.
 *
 * A proposal is `INFERRED` and the classifier never reads it: a link found by
 * shared wording is a name match, and a name match cannot ground a finding
 * (AGENTS.md invariant 5). A proposal becomes a claim only when a human edits
 * the document to add the anchor.
 */

import type { ProbeEnv } from './env.ts';
import type { PacketProposal } from './packet.ts';
import { replaceCodeSpans } from './scan.ts';
import { readText } from './tree.ts';
import type { ClaimKind } from './types.ts';
import { compareCodeUnits } from './util.ts';
import { isDeclarationFile, isSourceExtension, isTestPath } from './workspace.ts';

const STOP_WORDS: ReadonlySet<string> = new Set(
  'a an and are as at be by for from in is it of on or the to with'.split(' '),
);
export const PROPOSAL_MIN_SHARED = 2;
export const PROPOSAL_CAP = 5;

/**
 * Word 2-grams of a text, lower-cased. Each code span, and each of the
 * characters `. ! ? ; : ( ) , |`, ends a run of words. A word is a maximal run
 * of `[a-z0-9]`, so `allow-list` is the words `allow` and `list`. A 2-gram is
 * two adjacent words of one run, ignored if either is a stop word.
 */
export function wordTwoGrams(text: string): Set<string> {
  const lowered = replaceCodeSpans(text, () => '.')
    .toLowerCase()
    .replace(/[.!?;:(),|]/g, '.');
  const grams = new Set<string>();
  for (const run of lowered.split('.')) {
    const words = run.match(/[a-z0-9]+/g) ?? [];
    for (let i = 0; i + 1 < words.length; i += 1) {
      const a = words[i] ?? '';
      const b = words[i + 1] ?? '';
      if (STOP_WORDS.has(a) || STOP_WORDS.has(b)) continue;
      grams.add(`${a} ${b}`);
    }
  }
  return grams;
}

/** The first block comment of a file, before any statement, with the leading `*` of its lines removed. */
export function headerComment(source: string): string | null {
  let i = 0;
  const n = source.length;
  if (source.startsWith('#!')) i = source.indexOf('\n') < 0 ? n : source.indexOf('\n') + 1;
  while (i < n) {
    const ch = source[i] ?? '';
    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === '/' && source[i + 1] === '/') {
      const eol = source.indexOf('\n', i);
      i = eol < 0 ? n : eol + 1;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return null;
      return source
        .slice(i + 2, end)
        .split('\n')
        .map((line) => line.replace(/^\s*\*+\s?/, ''))
        .join(' ');
    } else {
      return null;
    }
  }
  return null;
}

export interface ProposalRequest {
  readonly repo: string;
  readonly claimKind: ClaimKind;
  readonly subject: string;
  /** The row's second cell as written. */
  readonly secondCell: string;
}

/** Proposals for the claims of one subject, numbered in order. */
export function proposeFor(env: ProbeEnv, requests: readonly ProposalRequest[]): PacketProposal[] {
  const out: PacketProposal[] = [];
  const headers = new Map<string, Set<string>>();
  let scanned = 0;
  for (const path of env.tree.tracked) {
    if (!isSourceExtension(path) || isDeclarationFile(path) || isTestPath(path)) continue;
    if (scanned >= env.limits.maxSourceFiles) break;
    scanned += 1;
    const size = env.tree.size(path);
    if (size !== null && size > env.limits.maxSourceBytes) continue;
    const text = readText(env.tree, path);
    const header = text === null ? null : headerComment(text);
    if (header !== null) headers.set(path, wordTwoGrams(header));
  }
  let n = 0;
  for (const request of requests) {
    const cell = wordTwoGrams(request.secondCell);
    const candidates: { path: string; shared: string[] }[] = [];
    for (const [path, grams] of headers) {
      const shared = [...cell].filter((g) => grams.has(g)).sort(compareCodeUnits);
      if (shared.length >= PROPOSAL_MIN_SHARED) candidates.push({ path, shared });
    }
    candidates.sort(
      (a, b) => b.shared.length - a.shared.length || compareCodeUnits(a.path, b.path),
    );
    for (const candidate of candidates.slice(0, PROPOSAL_CAP)) {
      n += 1;
      out.push({
        id: `${request.repo}:align-proposal:${request.claimKind}:${request.subject}:${n}`,
        claimKind: request.claimKind,
        subject: request.subject,
        provenance: 'INFERRED',
        basis: 'name-match',
        candidate: { kind: 'File', canonicalName: candidate.path },
        note: `the header comment shares the word pairs: ${candidate.shared.join('; ')}`,
      });
    }
  }
  return out;
}
