/**
 * Bounded traversal: query validation, the recursive-CTE builder, and the step
 * budget that stands in for `statement_timeout`.
 *
 * Normative reference: docs/design/v3.md §2.6. There is no query language here
 * and there is not going to be one. `cypher` was removed from the store
 * interface because on the one adapter where it was implementable it amounted
 * to arbitrary query execution inside the database. Every workload this system
 * has is bounded-hop, so bounded-hop is the entire surface.
 */

import {
  EDGE_KINDS,
  EDGE_SIGNATURES,
  NODE_KINDS,
  PROVENANCE,
  isFact,
  parseNodeId,
} from '@seamline/ontology';
import type { EdgeKind, NodeId, NodeKind, TraverseQuery } from '@seamline/ontology';
import { StoreError, nodeColumns } from './schema.ts';

/** A rejected query: malformed, or over a configured cap. Never silently clamped. */
export class TraverseQueryError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'TraverseQueryError';
  }
}

/**
 * The traversal exhausted its step or time budget.
 *
 * This is deliberately an exception and not an empty result. A truncated answer
 * that looks complete is the same failure class as a crashed extractor looking
 * like "no such edge exists", and the whole design exists to not do that.
 */
export class TraversalBudgetExceededError extends StoreError {
  readonly steps: number;
  constructor(message: string, steps: number) {
    super(message);
    this.name = 'TraversalBudgetExceededError';
    this.steps = steps;
  }
}

export interface TraverseLimits {
  /** Hard depth cap. A query above this is rejected, not clamped. */
  readonly maxDepth: number;
  /** Hard result cap, and the default limit when a query names none. */
  readonly maxResults: number;
  /** Expansion budget: how many candidate rows the CTE may consider. */
  readonly maxSteps: number;
  /** Wall-clock backstop, in milliseconds. */
  readonly timeoutMs: number;
}

export const DEFAULT_TRAVERSE_LIMITS: TraverseLimits = Object.freeze({
  maxDepth: 8,
  maxResults: 1000,
  maxSteps: 200_000,
  timeoutMs: 5_000,
});

/** Name of the SQL function that enforces the budget from inside the CTE. */
export const BUDGET_FUNCTION = 'seamline_budget';

export interface NormalizedQuery {
  readonly from: ReadonlyArray<NodeId>;
  readonly via: ReadonlyArray<EdgeKind>;
  readonly direction: 'out' | 'in' | 'both';
  readonly maxDepth: number;
  readonly toKinds: ReadonlyArray<NodeKind> | undefined;
  readonly factsOnly: boolean;
  readonly limit: number;
}

const NODE_KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);
const EDGE_KIND_SET: ReadonlySet<string> = new Set(EDGE_KINDS);
const FACT_PROVENANCE = PROVENANCE.filter(isFact);

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1;
}

/**
 * Reject anything outside the bounded surface. Over-cap depth and over-cap
 * limits are errors: clamping would answer a different question than the one
 * asked and report it as the answer.
 */
export function validateTraverseQuery(q: TraverseQuery, limits: TraverseLimits): NormalizedQuery {
  if (q.from.length === 0) throw new TraverseQueryError('traverse requires at least one `from` node');
  for (const id of q.from) {
    let kind: string;
    try {
      kind = parseNodeId(id).kind;
    } catch {
      throw new TraverseQueryError(`malformed node id in \`from\`: ${String(id)}`);
    }
    if (!NODE_KIND_SET.has(kind)) {
      throw new TraverseQueryError(`unknown node kind '${kind}' in \`from\` id ${String(id)}`);
    }
  }

  if (q.via.length === 0) {
    throw new TraverseQueryError('traverse requires at least one edge kind in `via`');
  }
  for (const k of q.via) {
    if (!EDGE_KIND_SET.has(k)) throw new TraverseQueryError(`unknown edge kind in \`via\`: ${String(k)}`);
  }

  const direction = q.direction ?? 'out';
  if (direction !== 'out' && direction !== 'in' && direction !== 'both') {
    throw new TraverseQueryError(`unknown direction: ${String(direction)}`);
  }

  if (!isPositiveInt(q.maxDepth)) {
    throw new TraverseQueryError(`maxDepth must be a positive integer, got ${String(q.maxDepth)}`);
  }
  if (q.maxDepth > limits.maxDepth) {
    throw new TraverseQueryError(
      `maxDepth ${q.maxDepth} exceeds the configured cap of ${limits.maxDepth}`,
    );
  }

  let toKinds: ReadonlyArray<NodeKind> | undefined;
  if (q.toKinds !== undefined) {
    if (q.toKinds.length === 0) throw new TraverseQueryError('`toKinds` must not be empty when present');
    for (const k of q.toKinds) {
      if (!NODE_KIND_SET.has(k)) throw new TraverseQueryError(`unknown node kind in \`toKinds\`: ${String(k)}`);
    }
    toKinds = [...q.toKinds];
  }

  if (q.limit !== undefined) {
    if (!isPositiveInt(q.limit)) {
      throw new TraverseQueryError(`limit must be a positive integer, got ${String(q.limit)}`);
    }
    if (q.limit > limits.maxResults) {
      throw new TraverseQueryError(
        `limit ${q.limit} exceeds the configured result cap of ${limits.maxResults}`,
      );
    }
  }

  return {
    from: [...q.from],
    via: [...q.via],
    direction,
    maxDepth: q.maxDepth,
    toKinds,
    factsOnly: q.factsOnly === true,
    limit: q.limit ?? limits.maxResults,
  };
}

/**
 * The node kinds a traversal's answer can depend on: the declared domain and
 * range of every edge kind it walks, plus the seeds and any result filter.
 *
 * This is what makes UNKNOWN sound rather than best-effort. Asking which scopes
 * have actually written an edge of kind K only finds scopes that already
 * succeeded once; a scope that failed on its first run has written nothing, and
 * inferring "no dependency" from that is exactly the false negative this design
 * forbids. The declared signature is data-independent, so it catches that case.
 */
export function dependentNodeKinds(q: NormalizedQuery): ReadonlySet<NodeKind> {
  const kinds = new Set<NodeKind>();
  for (const edgeKind of q.via) {
    for (const [src, dst] of EDGE_SIGNATURES[edgeKind]) {
      kinds.add(src);
      kinds.add(dst);
    }
  }
  for (const id of q.from) kinds.add(parseNodeId(id).kind);
  if (q.toKinds !== undefined) for (const k of q.toKinds) kinds.add(k);
  return kinds;
}

function placeholders(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `:${prefix}${i}`);
}

function bindList(
  params: Record<string, string | number>,
  prefix: string,
  values: ReadonlyArray<string>,
): string {
  const names = placeholders(prefix, values.length);
  values.forEach((v, i) => {
    params[`${prefix}${i}`] = v;
  });
  return names.join(', ');
}

export interface TraverseSql {
  readonly sql: string;
  readonly params: Record<string, string | number>;
}

/**
 * Build the bounded recursive CTE.
 *
 * Termination argument, since "it terminates on a cyclic import graph" is a
 * property and not a hope:
 *  - the CTE is `UNION`, not `UNION ALL`, so a duplicate `(id, depth)` row is
 *    discarded rather than re-expanded;
 *  - `depth` is strictly increasing and capped by `:maxDepth`;
 *  - therefore the CTE generates at most |nodes| x (maxDepth + 1) rows, whether
 *    or not the graph has cycles. A -> B -> C -> A stops at the depth cap.
 * The step budget is the backstop for a graph large enough that the bound above
 * is still too much work.
 */
export function buildTraverseSql(q: NormalizedQuery): TraverseSql {
  const params: Record<string, string | number> = {};
  const seeds = bindList(params, 's', q.from);
  const viaKinds = bindList(params, 'k', q.via);
  params['maxDepth'] = q.maxDepth;
  params['limit'] = q.limit;

  const factEdge = q.factsOnly ? `AND e.provenance IN (${bindList(params, 'fe', FACT_PROVENANCE)})` : '';
  const factSeed = q.factsOnly ? `AND sn.provenance IN (${bindList(params, 'fs', FACT_PROVENANCE)})` : '';
  const factNext = q.factsOnly ? `AND dn.provenance IN (${bindList(params, 'fn', FACT_PROVENANCE)})` : '';
  const kindFilter =
    q.toKinds === undefined ? '' : `AND n.kind IN (${bindList(params, 't', q.toKinds)})`;

  // A seed must exist and be live. A tombstoned node is not a place to stand:
  // traversing from one would resurrect its edges into the answer.
  const anchor = `
    SELECT sn.id, 0
    FROM nodes sn
    WHERE sn.id IN (${seeds}) AND sn.deleted_at IS NULL ${factSeed}`;

  const step = (from: 'src_id' | 'dst_id'): string => {
    const to = from === 'src_id' ? 'dst_id' : 'src_id';
    return `
    SELECT dn.id, w.depth + 1
    FROM walk w
    JOIN edges e ON e.${from} = w.id AND e.deleted_at IS NULL AND e.kind IN (${viaKinds}) ${factEdge}
    JOIN nodes dn ON dn.id = e.${to} AND dn.deleted_at IS NULL ${factNext}
    WHERE w.depth < :maxDepth AND ${BUDGET_FUNCTION}() = 1`;
  };

  const steps: string[] = [];
  if (q.direction === 'out' || q.direction === 'both') steps.push(step('src_id'));
  if (q.direction === 'in' || q.direction === 'both') steps.push(step('dst_id'));

  const sql = `
WITH RECURSIVE walk(id, depth) AS (
${[anchor, ...steps].join('\n  UNION\n')}
)
SELECT ${nodeColumns('n')}, MIN(w.depth) AS reached_depth
FROM walk w
JOIN nodes n ON n.id = w.id
WHERE w.depth > 0 AND n.deleted_at IS NULL ${kindFilter}
GROUP BY n.id
ORDER BY reached_depth ASC, n.id ASC
LIMIT :limit`;

  return { sql, params };
}

/**
 * The `statement_timeout` equivalent.
 *
 * `node:sqlite` exposes neither `interrupt()` nor `sqlite3_progress_handler`, so
 * the budget is enforced by a non-deterministic SQL function called once per
 * candidate row inside the recursive term. Throwing from it aborts the statement
 * in SQLite, which is the behaviour a progress handler returning non-zero would
 * have given. It must stay non-deterministic or SQLite is free to hoist the call
 * out of the loop and the budget stops counting.
 */
export interface StepBudget {
  /** Reset the counter and start the clock. Call once per traversal. */
  arm(limits: TraverseLimits): void;
  /** The SQL callback. Returns 1, or throws when the budget is spent. */
  readonly guard: () => number;
  /** Steps consumed by the last armed traversal. */
  used(): number;
}

export function createStepBudget(now: () => number = Date.now): StepBudget {
  let steps = 0;
  let maxSteps = DEFAULT_TRAVERSE_LIMITS.maxSteps;
  let deadline = Number.POSITIVE_INFINITY;

  return {
    arm(limits: TraverseLimits): void {
      steps = 0;
      maxSteps = limits.maxSteps;
      deadline = limits.timeoutMs > 0 ? now() + limits.timeoutMs : Number.POSITIVE_INFINITY;
    },
    guard: (): number => {
      steps += 1;
      if (steps > maxSteps) {
        throw new TraversalBudgetExceededError(
          `traversal exceeded its step budget of ${maxSteps}`,
          steps,
        );
      }
      // Checked every 512 steps: the clock is the backstop, not the hot path.
      if ((steps & 511) === 0 && now() > deadline) {
        throw new TraversalBudgetExceededError(
          `traversal exceeded its time budget after ${steps} steps`,
          steps,
        );
      }
      return 1;
    },
    used: (): number => steps,
  };
}
