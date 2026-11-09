/**
 * Bounded-traversal primitives shared by the CLI and the MCP server.
 *
 * v3 §2.6: every response is bounded. An agent (or a human at the CLI) must
 * never be able to pull the whole graph through one call. Three independent
 * caps apply — result count, traversal depth, and total serialized size — and
 * when any of them bites, the response says so explicitly. A silently short
 * list is worse than a truncated one: the caller reads it as "that is
 * everything".
 *
 * `capString`, `fitToByteBudget`, `byteLength`, and the `Bounds` interface
 * itself stay in `@seamline/mcp` — they are agent-response-size concerns
 * (serialized-byte budgets, string elision for a delimited untrusted block)
 * specific to that surface, not shared with the CLI.
 */

export type TruncationReason = 'result-cap' | 'depth-cap' | 'size-cap' | 'string-cap' | 'token-budget';

export interface Truncation {
  readonly truncated: true;
  readonly reasons: readonly TruncationReason[];
  readonly returned: number;
  /** Total available, when the producer knows it; `null` when the walk stopped early. */
  readonly total: number | null;
  readonly message: string;
}

export type TruncationState = Truncation | { readonly truncated: false };

export const NOT_TRUNCATED: TruncationState = { truncated: false };

export function truncation(
  reasons: readonly TruncationReason[],
  returned: number,
  total: number | null,
): Truncation {
  return {
    truncated: true,
    reasons: [...new Set(reasons)].sort(),
    returned,
    total,
    message:
      `TRUNCATED: this response is incomplete. ${returned} item(s) returned` +
      (total === null ? '' : ` of ${total}`) +
      `. Caps hit: ${[...new Set(reasons)].sort().join(', ')}. ` +
      'Narrow the query or raise the caps on the server; do not treat this as the full result set.',
  };
}

export function mergeTruncation(a: TruncationState, b: TruncationState): TruncationState {
  if (!a.truncated) return b;
  if (!b.truncated) return a;
  return truncation([...a.reasons, ...b.reasons], a.returned + b.returned, sumTotals(a.total, b.total));
}

function sumTotals(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/** Applies the result cap, reporting how many were dropped. */
export function capList<T>(items: readonly T[], cap: number): { items: readonly T[]; state: TruncationState } {
  if (items.length <= cap) return { items, state: NOT_TRUNCATED };
  return { items: items.slice(0, cap), state: truncation(['result-cap'], cap, items.length) };
}

/** Clamps a caller-supplied depth to a ceiling, reporting the clamp. */
export function capDepth(requested: number | undefined, maxDepth: number): { depth: number; clamped: boolean } {
  if (requested === undefined) return { depth: maxDepth, clamped: false };
  if (requested > maxDepth) return { depth: maxDepth, clamped: true };
  return { depth: Math.max(1, requested), clamped: false };
}
