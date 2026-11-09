/**
 * Scope health.
 *
 * v3 §2.2: any query whose answer depends on a scope whose producing extractor
 * did not PASS returns UNKNOWN for that portion and never a negative finding.
 * Both `why` and `check` need the same answer to "which scopes are degraded",
 * and both must report it distinctly from "clean".
 */

import { compareCodeUnits } from '@seamline/core';
import type { ExtractorStatus, GraphView, RunRecord } from '@seamline/ontology';

export interface DegradedScope {
  readonly scope: string;
  readonly status: ExtractorStatus;
  readonly extractor: string;
  readonly diagnostics: readonly string[];
  /**
   * Set on a scope whose extractor PASSed but did not read this many workspace
   * packages (the `Repo` node says so). The facts it did read are sound; what
   * is absent from them is not evidence of absence.
   */
  readonly unreadPackages?: number;
}

/** The scope `extract-code-ts` owns; the same name the detectors require. */
const CODE_SCOPE = 'code.ts';

/** How many names the diagnostic shows; the count is always exact. */
const NAMES_SHOWN = 5;

/**
 * The unread-package count and names `extract-code-ts` puts on the `Repo` node
 * (`unreadCodePackageCount`, and `unreadCodePackages` as a JSON array).
 */
function unreadCodePackages(view: GraphView): { readonly count: number; readonly named: readonly string[] } {
  let count = 0;
  const named = new Set<string>();
  for (const repo of view.nodesByKind('Repo')) {
    const n = repo.props['unreadCodePackageCount'];
    if (typeof n === 'number' && n > 0) count += n;
    const list = repo.props['unreadCodePackages'];
    if (typeof list !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(list);
      if (Array.isArray(parsed)) for (const s of parsed) if (typeof s === 'string' && s.length > 0) named.add(s);
    } catch {
      // A value that is not a JSON array names nothing; the count still stands.
    }
  }
  return { count, named: [...named].sort() };
}

/**
 * Cross-references the run record's declared authoritative scopes with the
 * store's own view of each scope's status. The store is authoritative: a run
 * record can claim PASS for a scope the store has since seen fail.
 */
export function degradedScopes(view: GraphView, run: RunRecord | undefined): readonly DegradedScope[] {
  if (run === undefined) return [];
  const out: DegradedScope[] = [];
  const seen = new Set<string>();
  for (const result of run.results) {
    for (const auth of result.authoritative) {
      if (seen.has(auth.scope)) continue;
      seen.add(auth.scope);
      const status = safeStatus(view, auth.scope, result.status);
      if (status === 'PASS') {
        const unread = auth.scope === CODE_SCOPE ? unreadCodePackages(view) : { count: 0, named: [] };
        if (unread.count > 0) {
          const shown = unread.named.slice(0, NAMES_SHOWN).join(', ');
          const more = unread.count > Math.min(unread.named.length, NAMES_SHOWN) ? ', ...' : '';
          out.push({
            scope: auth.scope,
            status,
            extractor: result.extractor,
            diagnostics: [`${unread.count} workspace package(s) were not read (${shown}${more})`],
            unreadPackages: unread.count,
          });
        }
        continue;
      }
      out.push({
        scope: auth.scope,
        status,
        extractor: result.extractor,
        diagnostics: result.diagnostics,
      });
    }
  }
  out.sort((a, b) => compareCodeUnits(a.scope, b.scope));
  return out;
}

function safeStatus(view: GraphView, scope: string, fallback: ExtractorStatus): ExtractorStatus {
  try {
    return view.scopeStatus(scope);
  } catch {
    return fallback;
  }
}
