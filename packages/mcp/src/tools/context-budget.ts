/**
 * The `tokenBudget` path of `context`.
 *
 * Without `tokenBudget`, `context` behaves exactly as it always has; this file
 * is not on that path. With it, the answer is the longest prefix of a fixed
 * priority order that fits (see `budget.ts` for how fit is measured):
 *
 *   1. the resolved node (always present);
 *   2. its container;
 *   3. direct facts: nodes one hop away over structural, code and test edges;
 *   4. joins: nodes one hop away over the cross-domain join edges;
 *   5. farther hops, nearest first.
 *
 * Within a tier, facts (EXTRACTED, DECLARED) come before guesses, then node id
 * ascending by UTF-16 code unit, so the order does not depend on the order the
 * store returned anything in. A budgeted response lists the container once, in
 * `container`, and does not repeat it in `related`; `edges` holds the edges
 * between returned nodes only.
 */

import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import type { TruncationState } from '../bounds.ts';
import {
  assembleWithinBudget,
  compareIds,
  factRank,
  summarizeDetached,
  type DetachedSummary,
  type Rendered,
} from '../budget.ts';
import {
  LINEAGE_EDGE_KINDS,
  summarizeEdge,
  type BfsResult,
  type Reached,
  type ResolveResult,
} from '../graph.ts';
import type { ToolEnvelope, UnknownScope } from '../result.ts';
import type { ToolContext } from './registry.ts';

const JOIN_EDGE_KINDS: ReadonlySet<string> = new Set(LINEAGE_EDGE_KINDS);

/** 2 direct fact, 3 join, 4 farther. (0 is the node and 1 its container, which are handled apart.) */
function tierOf(r: Reached): number {
  if (r.depth > 1) return 4;
  return JOIN_EDGE_KINDS.has(r.viaEdge) ? 3 : 2;
}

interface Candidate {
  readonly role: 'container' | 'related';
  readonly node: SeamlineNode;
  readonly detached: DetachedSummary;
  readonly reached?: Reached;
}

export interface ContextBudgetInput {
  readonly tokenBudget: number;
  readonly ctx: ToolContext;
  readonly target: SeamlineNode;
  readonly container: SeamlineNode | undefined;
  readonly strategy: ResolveResult['strategy'];
  readonly depth: number;
  readonly clamped: boolean;
  readonly walk: BfsResult;
  /** Truncation of the walk and the result cap, before the budget. */
  readonly prior: TruncationState;
  readonly unknown: readonly UnknownScope[];
}

/** The edge a node was first reached over, to rank facts before guesses. */
function viaEdgeOf(r: Reached, edges: ReadonlyMap<string, SeamlineEdge>): SeamlineEdge | undefined {
  return (
    edges.get(`${r.viaFrom} ${r.node.id} ${r.viaEdge}`) ??
    edges.get(`${r.node.id} ${r.viaFrom} ${r.viaEdge}`)
  );
}

export function contextWithinBudget(input: ContextBudgetInput): ToolEnvelope {
  const { ctx, target, container, walk } = input;
  const edgeIndex = new Map<string, SeamlineEdge>();
  for (const e of walk.edges) edgeIndex.set(`${e.src} ${e.dst} ${e.kind}`, e);

  const ranked = walk.reached
    .filter((r) => container === undefined || r.node.id !== container.id)
    .map((r) => ({ r, tier: tierOf(r), rank: factRank(viaEdgeOf(r, edgeIndex)) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.r.depth - b.r.depth ||
        a.rank - b.rank ||
        compareIds(a.r.node.id, b.r.node.id) ||
        compareIds(a.r.viaEdge, b.r.viaEdge),
    );

  const items: Candidate[] = [];
  if (container !== undefined) {
    items.push({
      role: 'container',
      node: container,
      detached: summarizeDetached(container, ctx.render),
    });
  }
  for (const { r } of ranked) {
    items.push({
      role: 'related',
      node: r.node,
      detached: summarizeDetached(r.node, ctx.render),
      reached: r,
    });
  }

  const targetSummary = summarizeDetached(target, ctx.render);

  const render = (kept: readonly Candidate[]): Rendered => {
    const keptContainer = kept.find((c) => c.role === 'container');
    const keptRelated = kept.filter((c) => c.role === 'related');
    const present = new Set<string>([target.id, ...kept.map((c) => c.node.id)]);
    const result: Record<string, unknown> = {
      found: true,
      matchedBy: input.strategy,
      node: targetSummary.summary,
      container: keptContainer === undefined ? null : keptContainer.detached.summary,
      ...(container !== undefined && keptContainer === undefined ? { containerOmitted: true } : {}),
      depth: input.depth,
      related: keptRelated.map((c) => {
        const r = c.reached as Reached;
        return { depth: r.depth, via: r.viaEdge, from: r.viaFrom, node: c.detached.summary };
      }),
      edges: walk.edges.filter((e) => present.has(e.src) && present.has(e.dst)).map(summarizeEdge),
    };
    return { result, blocks: [...targetSummary.blocks, ...kept.flatMap((c) => c.detached.blocks)] };
  };

  const notices: string[] = [];
  if (input.clamped)
    notices.push(`Requested depth was clamped to the server ceiling of ${ctx.bounds.maxDepth}.`);

  return assembleWithinBudget({
    tool: 'context',
    tokenBudget: input.tokenBudget,
    bounds: ctx.bounds,
    items,
    prior: input.prior,
    unknown: input.unknown,
    notices,
    render,
    sink: ctx.render,
  });
}

/** An ambiguous name under a budget: the candidates, in id order, as many as fit. */
export function ambiguousWithinBudget(input: {
  readonly tokenBudget: number;
  readonly ctx: ToolContext;
  readonly symbol: string;
  readonly strategy: ResolveResult['strategy'];
  readonly totalMatches: number;
  readonly items: readonly SeamlineNode[];
  readonly prior: TruncationState;
  readonly unknown: readonly UnknownScope[];
}): ToolEnvelope {
  return assembleWithinBudget({
    tool: 'context',
    tokenBudget: input.tokenBudget,
    bounds: input.ctx.bounds,
    items: input.items,
    prior: input.prior,
    unknown: input.unknown,
    notices: [
      `\`${input.symbol}\` matches ${input.totalMatches} nodes. Call context again with a full NodeId, or pass \`kind\`.`,
    ],
    render: (kept) => ({
      result: {
        found: false,
        ambiguous: true,
        matchedBy: input.strategy,
        totalMatches: input.totalMatches,
        candidates: kept.map((n) => ({
          id: n.id,
          kind: n.kind,
          name: n.name,
          path: n.path ?? null,
        })),
      },
      blocks: [],
    }),
    sink: input.ctx.render,
  });
}

/** A name that matches nothing, under a budget: the same answer, with the budget fields. */
export function notFoundWithinBudget(input: {
  readonly tokenBudget: number;
  readonly ctx: ToolContext;
  readonly symbol: string;
  readonly unknown: readonly UnknownScope[];
}): ToolEnvelope {
  return assembleWithinBudget({
    tool: 'context',
    tokenBudget: input.tokenBudget,
    bounds: input.ctx.bounds,
    items: [],
    prior: { truncated: false },
    unknown: input.unknown,
    notices: [`No node matches \`${input.symbol}\`.`],
    render: () => ({ result: { found: false, candidates: [] }, blocks: [] }),
    sink: input.ctx.render,
  });
}
