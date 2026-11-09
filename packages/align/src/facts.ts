/**
 * The facts source (design 5.1): the run whose graph facts the probes read, and
 * the scope table that says which of its scopes may be believed.
 *
 * `@seamline/align` does not open a store or parse a SIF. The CLI does that and
 * hands over `AlignFacts`: the runs (a SIF is one run), and the three things
 * `module-wiring` reads from the graph (File nodes, the paths of Symbol nodes,
 * file-level `IMPORTS` edges). Keeping the engine free of storage keeps it
 * offline and testable with plain data.
 */

import type { ExtractorResult, ExtractorStatus } from '@seamline/ontology';
import { compareCodeUnits } from './util.ts';

export interface FactsRun {
  readonly runId: string;
  /** The commit the extraction evaluated, `null` when absent from the source metadata. */
  readonly commit: string | null;
  readonly ontologyVersion: string | null;
  readonly results: readonly ExtractorResult[];
}

export interface ImportEdge {
  /** Repo-relative path of the importing File node. */
  readonly src: string;
  /** Repo-relative path of the imported File node. */
  readonly dst: string;
  /** The edge's `reExport` prop. The `typeOnly` prop is ignored on purpose (4.4). */
  readonly reExport: boolean;
}

export interface AlignFacts {
  readonly source: 'store' | 'sif';
  /** `sha256:<hex>`: of the SIF bytes, or of the canonical JSON of the newest run record and the scope table. */
  readonly digest: string;
  /** Newest first. A SIF is one run. */
  readonly runs: readonly FactsRun[];
  /** Paths of live File nodes of the run. */
  readonly files: readonly string[];
  /** Paths carried by live Symbol nodes. */
  readonly symbolPaths: readonly string[];
  readonly imports: readonly ImportEdge[];
}

export interface ScopeEntry {
  readonly scope: string;
  readonly status: ExtractorStatus;
  readonly kinds: readonly string[];
  /** The run that supplies the entry. */
  readonly runId: string;
}

const STATUS_RANK: Readonly<Record<ExtractorStatus, number>> = { PASS: 0, UNAVAILABLE: 1, FAIL: 2 };

export function worseStatus(a: ExtractorStatus, b: ExtractorStatus): ExtractorStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

/**
 * The scope table (5.1). For each scope an `authoritative` entry names, its
 * status, declared kinds and supplying run. The entry comes from the newest run
 * that declared the scope; within one run the worst status wins and the kinds
 * are the union. Two rules beyond the store's own `scopeStatus`:
 *
 *  1. A scope that no result declares has no entry, and no entry is not `PASS`.
 *  2. A failed extractor does not fall back. If the newest run holds a non-`PASS`
 *     result for an extractor, every scope that extractor declared in an earlier
 *     run is entered with that result's status (a crash may declare no scope, and
 *     an older run's `PASS` must not stand in for it). An extractor with no result
 *     in the newest run keeps its older entries, as `seamline check` does.
 *
 * For a rule-2 entry the kinds come from the earlier declaration and the run id
 * is the newest run, whose result supplies the status.
 */
export function buildScopeTable(runs: readonly FactsRun[]): Map<string, ScopeEntry> {
  const table = new Map<string, ScopeEntry>();
  const newest = runs[0];
  const failedInNewest = new Map<string, ExtractorStatus>();
  if (newest !== undefined) {
    for (const result of newest.results) {
      if (result.status === 'PASS') continue;
      failedInNewest.set(
        result.extractor,
        worseStatus(failedInNewest.get(result.extractor) ?? 'PASS', result.status),
      );
    }
  }
  runs.forEach((run, index) => {
    const declared = new Map<
      string,
      { status: ExtractorStatus; kinds: Set<string>; extractors: Set<string> }
    >();
    for (const result of run.results) {
      for (const entry of result.authoritative) {
        const current = declared.get(entry.scope);
        if (current === undefined) {
          declared.set(entry.scope, {
            status: result.status,
            kinds: new Set(entry.kinds),
            extractors: new Set([result.extractor]),
          });
        } else {
          current.status = worseStatus(current.status, result.status);
          for (const kind of entry.kinds) current.kinds.add(kind);
          current.extractors.add(result.extractor);
        }
      }
    }
    for (const [scope, info] of declared) {
      if (table.has(scope)) continue;
      let status = info.status;
      let runId = run.runId;
      if (index > 0 && newest !== undefined) {
        for (const extractor of info.extractors) {
          const failed = failedInNewest.get(extractor);
          if (failed !== undefined) {
            status = worseStatus(status, failed);
            runId = newest.runId;
          }
        }
      }
      table.set(scope, { scope, status, kinds: [...info.kinds].sort(compareCodeUnits), runId });
    }
  });
  return table;
}

export interface RunProvenance {
  readonly pairing: 'verified' | 'asserted';
  /** Non-null when a supplying run carries a commit that differs from the evaluated one. */
  readonly mismatch: string | null;
}

/**
 * The commit rule (5.1). It applies to a store source only, and only to the runs
 * that supply an entry of the scope table. A `null` commit is not a mismatch:
 * it means the pairing is unknown, so the caller asserts it. A SIF carries no
 * commit, so the rule is not applied and the pairing is asserted. With
 * `--worktree` the evaluated commit is `null` and cannot be verified.
 */
export function runProvenance(
  facts: AlignFacts,
  evaluatedCommit: string | null,
  table: ReadonlyMap<string, ScopeEntry>,
): RunProvenance {
  if (facts.source === 'sif' || evaluatedCommit === null)
    return { pairing: 'asserted', mismatch: null };
  const supplying = new Set([...table.values()].map((e) => e.runId));
  let verified = supplying.size > 0;
  for (const run of facts.runs) {
    if (!supplying.has(run.runId)) continue;
    if (run.commit === null) {
      verified = false;
    } else if (run.commit !== evaluatedCommit) {
      return {
        pairing: 'asserted',
        mismatch: `run ${run.runId} was made at ${run.commit}, not at ${evaluatedCommit}`,
      };
    }
  }
  return { pairing: verified ? 'verified' : 'asserted', mismatch: null };
}
