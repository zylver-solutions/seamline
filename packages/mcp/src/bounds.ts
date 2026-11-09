/**
 * Response bounding.
 *
 * v3 §2.6: every response is bounded. An agent must never be able to pull the
 * whole graph through one call. Three independent caps apply — result count,
 * traversal depth, and total serialized size — and when any of them bites, the
 * response says so explicitly. A silently short list is worse than a truncated
 * one: the agent reads it as "that is everything".
 *
 * `TruncationReason`/`Truncation`/`TruncationState`/`NOT_TRUNCATED`/
 * `truncation`/`mergeTruncation`/`capList` are `@seamline/core`'s — shared with
 * the CLI — and re-exported here unchanged. `capString`, `fitToByteBudget`,
 * `byteLength`, and `Bounds` stay local: they are agent-response-size concerns
 * (serialized-byte budgets, string elision) specific to this MCP surface.
 */

import { capDepth as coreCapDepth, capList, mergeTruncation, NOT_TRUNCATED, truncation } from '@seamline/core';
import type { Truncation, TruncationReason, TruncationState } from '@seamline/core';
import type { Bounds } from './ports.ts';

export { NOT_TRUNCATED, capList, mergeTruncation, truncation };
export type { Truncation, TruncationReason, TruncationState };

/** Elides an over-long string, leaving a visible marker. */
export function capString(s: string, max: number): { value: string; truncated: boolean } {
  if (s.length <= max) return { value: s, truncated: false };
  return { value: `${s.slice(0, max)}… [TRUNCATED ${s.length - max} more characters]`, truncated: true };
}

/**
 * Fits a list into a byte budget.
 *
 * `build` renders a candidate body from a prefix of `items`; the largest prefix
 * whose serialization fits is chosen by binary search. An empty result that
 * still exceeds the budget is returned anyway with a size-cap marker, because
 * an error would tell the agent less than a marked-truncated response does.
 */
export function fitToByteBudget<T>(
  items: readonly T[],
  build: (kept: readonly T[]) => unknown,
  maxBytes: number,
  prior: TruncationState = NOT_TRUNCATED,
): { items: readonly T[]; body: unknown; bytes: number; state: TruncationState } {
  const full = build(items);
  const fullBytes = byteLength(full);
  if (fullBytes <= maxBytes) return { items, body: full, bytes: fullBytes, state: prior };

  let lo = 0;
  let hi = items.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (byteLength(build(items.slice(0, mid))) <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const kept = items.slice(0, best);
  const body = build(kept);
  const state = mergeTruncation(prior, truncation(['size-cap'], kept.length, items.length));
  return { items: kept, body, bytes: byteLength(body), state };
}

export function byteLength(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
}

/** Clamps a caller-supplied depth to the server ceiling, reporting the clamp. */
export function capDepth(requested: number | undefined, bounds: Bounds): { depth: number; clamped: boolean } {
  return coreCapDepth(requested, bounds.maxDepth);
}
