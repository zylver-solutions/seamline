/**
 * Rename and copy detection: the part that makes identity survive refactoring.
 *
 * v3 §2.1: a node id is a path-free natural key, and `path` is a property,
 * except for `File`, whose key is its path, and the inputs that ADR-0016
 * item 4 lists. A moved file therefore gets a new id, and without something
 * that notices when a path moves, a single `git mv` orphans every edge whose
 * endpoint that file was. This module is that something. It reads git's own
 * similarity-based detection (`--find-renames`,
 * `--find-copies`) and turns it into `RenameRecord`s that the identity layer in
 * `packages/core/src/identity/` folds into an alias table.
 *
 * See the `RenameRecord` / `RenameLedger` doc comments in `types.ts` for the
 * interface contract between the two packages.
 */
import { nodeId } from '@seamline/ontology';
import type { PreparedHistory } from './session.ts';
import { prepareHistory } from './session.ts';
import type { ChangeExtractorOptions, RenameLedger, RenameRecord } from './types.ts';

/**
 * Builds the ledger from an already-read history.
 *
 * Sort order is the interface guarantee: oldest first in git's topological walk
 * order (`order` counts down from newest), then `from`, then `to`. Folding
 * `a -> b` before `b -> c` resolves a chain in one forward pass.
 */
export function renameLedgerFrom(prepared: PreparedHistory): RenameLedger {
  const { cfg, commits, range } = prepared;
  const threshold = cfg.req.renameThreshold;
  const records: RenameRecord[] = [];

  for (const commit of commits) {
    for (const change of commit.changes) {
      if (change.status !== 'R' && change.status !== 'C') continue;
      const from = change.fromPath;
      const similarity = change.similarity;
      // A record with no score is not evidence of anything. Git always emits
      // one; if it ever does not, dropping beats inventing a number.
      if (from === null || similarity === null) continue;
      if (similarity < threshold) continue;
      records.push({
        kind: change.status === 'R' ? 'rename' : 'copy',
        from,
        to: change.path,
        similarity,
        commit: commit.sha,
        authorDate: commit.authorDate,
        fromId: nodeId(cfg.repo, 'File', from),
        toId: nodeId(cfg.repo, 'File', change.path),
      });
    }
  }

  records.sort(byWalkOrderOldestFirst(commits));

  return {
    repo: cfg.repo,
    status: 'PASS',
    range,
    threshold,
    complete: !range.truncated,
    records,
    diagnostics: [
      ...prepared.diagnostics,
      `renames ${records.filter((r) => r.kind === 'rename').length}`,
      `copies ${records.filter((r) => r.kind === 'copy').length}`,
    ],
  };
}

function byWalkOrderOldestFirst(
  commits: ReadonlyArray<{ readonly sha: string; readonly order: number }>,
): (a: RenameRecord, b: RenameRecord) => number {
  const order = new Map(commits.map((c) => [c.sha, c.order]));
  return (a, b) => {
    const oa = order.get(a.commit) ?? 0;
    const ob = order.get(b.commit) ?? 0;
    if (oa !== ob) return ob - oa; // higher order = older = first
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  };
}

/**
 * Reads rename records for a bounded commit range without building the graph.
 *
 * This is the entry point the identity layer should call. It never throws for
 * an environment problem: a missing git, a non-repository or a shallow clone
 * that cannot answer comes back as `status: 'UNAVAILABLE'` with empty
 * `records`, which the caller must not read as "no renames happened".
 */
export function readRenames(options: ChangeExtractorOptions): RenameLedger {
  const outcome = prepareHistory(options);
  if (!outcome.ok) {
    return {
      repo: typeof options.repo === 'string' ? options.repo : '',
      status: outcome.status,
      range: outcome.range,
      threshold: outcome.threshold,
      complete: false,
      records: [],
      diagnostics: outcome.diagnostics,
    };
  }
  return renameLedgerFrom(outcome.prepared);
}
