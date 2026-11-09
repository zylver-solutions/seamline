/**
 * Lifecycle fields: `firstSeenRun`, `lastSeenRun`, `deletedAt` (v3 §2.2).
 *
 * ## `deletedAt` holds a run id, not a timestamp
 *
 * v3 §2.3 forbids a wall-clock timestamp in a node or edge body, and `deletedAt`
 * is in the body. So a tombstone records *the run that buried it*. Run ids are
 * compared as strings, which means they must be lexicographically ordered
 * (a ULID, or a zero-padded monotonic counter) — the same requirement
 * `firstSeenRun`/`lastSeenRun` already impose.
 *
 * That requirement belongs to this pure layer, not to the SQLite store. The
 * store orders runs by its own insertion sequence (`runs.seq`) and tombstones by
 * comparing a row's last-seen run with the finalizing run's id for equality, so
 * it accepts ids that carry no order. Deterministic mode (`SEAMLINE_DETERMINISTIC=1`)
 * relies on that: its run ids are digests of the run's inputs (ADR-0009 §3a), which
 * identify a run and do not sort chronologically. Do not feed such ids to the
 * functions below; they would compare them as if they did.
 *
 * ## Liveness is derived, not asserted
 *
 * A node is dead when it was buried *after* it was last seen:
 * `deletedAt > lastSeenRun`. Everything else is alive. That single rule is what
 * makes resurrection automatic — a tombstoned node re-emitted by a later run
 * has `lastSeenRun >= deletedAt`, so `deletedAt` clears. An earlier internal
 * project shipped a shadowing bug here by treating the tombstone as sticky;
 * this does not.
 *
 * The rule is also why merge is associative over lifecycle: `firstSeenRun` is a
 * min, `lastSeenRun` is a max, and `deletedAt` is a max filtered by a
 * monotonically non-decreasing bound, so dropping a cleared tombstone can never
 * change a later result.
 */

import { compareStrings } from './serialize.ts';

export interface Lifecycle {
  readonly firstSeenRun: string;
  readonly lastSeenRun: string;
  readonly deletedAt: string | null;
}

/** Run ordering. Lexicographic by code unit; run ids must sort chronologically. */
export function compareRuns(a: string, b: string): number {
  return compareStrings(a, b);
}

export function minRun(a: string, b: string): string {
  return compareRuns(a, b) <= 0 ? a : b;
}

export function maxRun(a: string, b: string): string {
  return compareRuns(a, b) >= 0 ? a : b;
}

function maxNullableRun(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return maxRun(a, b);
}

/** True when the tombstone postdates the last sighting. */
export function isDeleted(life: Lifecycle): boolean {
  return life.deletedAt !== null && compareRuns(life.deletedAt, life.lastSeenRun) > 0;
}

/**
 * Normalize a lifecycle triple: a tombstone that no longer postdates the last
 * sighting is cleared, which is the resurrection rule.
 */
export function settle(first: string, last: string, deletedAt: string | null): Lifecycle {
  const cleared = deletedAt !== null && compareRuns(deletedAt, last) > 0 ? deletedAt : null;
  return { firstSeenRun: first, lastSeenRun: last, deletedAt: cleared };
}

/** Commutative, associative, idempotent fold over two lifecycle triples. */
export function mergeLifecycle(a: Lifecycle, b: Lifecycle): Lifecycle {
  return settle(
    minRun(a.firstSeenRun, b.firstSeenRun),
    maxRun(a.lastSeenRun, b.lastSeenRun),
    maxNullableRun(a.deletedAt, b.deletedAt),
  );
}

/**
 * Lifecycle of a fact emitted by `runId`. Emission is a sighting, so
 * `lastSeenRun` advances to at least `runId` and any earlier tombstone clears.
 */
export function observedIn(life: Lifecycle, runId: string): Lifecycle {
  const first = life.firstSeenRun.length === 0 ? runId : minRun(life.firstSeenRun, runId);
  const last = life.lastSeenRun.length === 0 ? runId : maxRun(life.lastSeenRun, runId);
  return settle(first, last, life.deletedAt);
}

/** Bury a fact in `runId`. A no-op on something already buried. */
export function tombstone(life: Lifecycle, runId: string): Lifecycle {
  if (isDeleted(life)) return life;
  return settle(life.firstSeenRun, life.lastSeenRun, maxNullableRun(life.deletedAt, runId));
}
