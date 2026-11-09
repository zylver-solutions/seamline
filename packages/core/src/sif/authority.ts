/** Validate encoded claim budgets before decoding any selector in that run. */
import type { AuthoritativeScope, ExtractorResult, RunRecord, SifLine } from '@seamline/ontology';
import { canonicalEncodedClaims, isCanonicalSelectorText } from '../store/canonical-selector.ts';
import { assertAuthoritySelectors } from '../store/scope-selector.ts';
import { canonicalStringify } from './canonicalize.ts';

export function assertSifAuthority(lines: readonly SifLine[], framed: boolean): void {
  const groups: AuthoritativeScope[][] = [];
  const statuses: AuthoritativeScope[] = [];
  const runs: RunRecord[] = [];
  const results: ExtractorResult[] = [];
  for (const line of lines) {
    if (line.t === 'run') {
      runs.push(line.run);
      groups.push(line.run.results.flatMap(result => result.authoritative));
    }
    if (line.t === 'status') {
      results.push(line.result);
      for (const scope of line.result.authoritative) statuses.push(scope);
    }
  }
  groups.push(statuses);
  for (const scopes of groups) {
    if (!framed && scopes.some(scope => scope.selector !== undefined && isCanonicalSelectorText(scope.selector)))
      throw new Error('canonical authority requires version-2 SIF framing');
    canonicalEncodedClaims(scopes);
  }
  if (framed || runs.length > 0) assertConsistentMetadata(runs, results);
  // A framed status accompanying a run is an identical copy of that run's
  // result, not extra authority. Decode its rules only in the primary record.
  const primary = runs.length === 1 ? groups.slice(0, -1) : groups;
  for (const scopes of primary) assertAuthoritySelectors(scopes);
}

function resultKey(result: ExtractorResult): string {
  return canonicalStringify({ ...result, authoritative: result.authoritative.map(scope => ({
    ...scope, kinds: [...scope.kinds].sort(),
  })) });
}

function uniqueResults(results: readonly ExtractorResult[]): Map<string, string> {
  const indexed = new Map<string, string>();
  for (const result of results) {
    if (indexed.has(result.extractor)) throw new Error('duplicate SIF extractor result');
    indexed.set(result.extractor, resultKey(result));
  }
  return indexed;
}

function assertConsistentMetadata(runs: readonly RunRecord[], statuses: readonly ExtractorResult[]): void {
  if (runs.length > 1) throw new Error('a SIF document cannot contain multiple run records');
  const emitted = uniqueResults(statuses);
  const run = runs[0];
  if (run === undefined) return; // Worker documents may have no run record.
  const recorded = uniqueResults(run.results);
  for (const [extractor, key] of emitted) {
    if (recorded.get(extractor) !== key) throw new Error('SIF run and status metadata disagree');
  }
}
