/**
 * Claims that passed but cover less than the whole scope.
 *
 * `GraphView.scopeStatus` is keyed by scope alone, so it cannot tell a scope
 * whose extractor read everything from one whose extractor read most of it and
 * narrowed its authoritative claim (`AuthoritativeScope.selector`) to the files
 * it did read. Both are PASS, and a detector over the second can say "no
 * contradiction" about facts that were never re-observed. A reader that prints
 * "clean" or "none" has to be able to say so.
 *
 * The extractor says it in its result: a PASS result whose claim carries a
 * selector and whose diagnostics hold a line of the form
 *
 *     <NAME>_PARTIAL_COVERAGE: <n> file(s) ...
 *
 * has `n` files in scope that it did not read. The count is the number the
 * extractor reported; nothing here re-derives it.
 */

import type { ExtractorStatus, GraphView, RunRecord } from '@seamline/ontology';

export interface NarrowedClaim {
  readonly scope: string;
  readonly extractor: string;
  /** Files in scope the extractor did not read to the end, as it reported them. */
  readonly filesNotRead: number;
}

const PARTIAL_COVERAGE = /^[A-Z][A-Z0-9_]*_PARTIAL_COVERAGE: (\d+) file\(s\)/;

/**
 * The scopes of `run` that PASSed on a claim narrower than the whole scope.
 * Sorted by scope, so the output is stable. Empty when nothing is narrowed.
 */
export function narrowedClaims(
  view: GraphView,
  run: RunRecord | undefined,
): readonly NarrowedClaim[] {
  if (run === undefined) return [];
  const out: NarrowedClaim[] = [];
  const seen = new Set<string>();
  for (const result of run.results) {
    const filesNotRead = reportedFilesNotRead(result.diagnostics);
    if (filesNotRead === 0) continue;
    for (const auth of result.authoritative) {
      if (auth.selector === undefined || seen.has(auth.scope)) continue;
      seen.add(auth.scope);
      // The store's view is authoritative; a scope that did not PASS is
      // reported as UNKNOWN by its own path.
      if (statusOf(view, auth.scope, result.status) !== 'PASS') continue;
      out.push({ scope: auth.scope, extractor: result.extractor, filesNotRead });
    }
  }
  return out.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
}

/** One line a reader can print beside a "clean" or "none". */
export function describeNarrowedClaim(claim: NarrowedClaim): string {
  return (
    `the ${claim.scope} claim is partial: ${claim.filesNotRead} file(s) not read to the end (${claim.extractor}); ` +
    'a contradiction that rests on them is neither found nor ruled out'
  );
}

function reportedFilesNotRead(diagnostics: ReadonlyArray<string>): number {
  let total = 0;
  for (const line of diagnostics) {
    const match = PARTIAL_COVERAGE.exec(line);
    if (match !== null) total += Number(match[1]);
  }
  return total;
}

function statusOf(view: GraphView, scope: string, fallback: ExtractorStatus): ExtractorStatus {
  try {
    return view.scopeStatus(scope);
  } catch {
    return fallback;
  }
}
