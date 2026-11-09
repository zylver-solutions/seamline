/**
 * The `tokenBudget` path of `impact` in its default (`targets: "nodes"`) mode.
 *
 * Without `tokenBudget`, `impact` is untouched; this file is not on that path.
 * With it, the reached nodes are ordered nearest first (facts before guesses
 * within a hop, then node id ascending by UTF-16 code unit) and the longest
 * prefix that fits the budget is returned. `byKind` counts every node the walk
 * reached within the server caps, including those the budget trimmed, so the
 * shape of the blast radius survives even when the detail does not.
 */

import type { SeamlineEdge } from '@seamline/ontology';
import type { TruncationState } from '../bounds.ts';
import {
  assembleWithinBudget,
  compareIds,
  factRank,
  summarizeDetached,
  type DetachedSummary,
} from '../budget.ts';
import type { BfsResult, Reached } from '../graph.ts';
import type { ToolEnvelope, UnknownScope } from '../result.ts';
import type { ToolContext } from './registry.ts';

interface Candidate {
  readonly reached: Reached;
  readonly detached: DetachedSummary;
}

function viaEdgeOf(r: Reached, edges: ReadonlyMap<string, SeamlineEdge>): SeamlineEdge | undefined {
  return (
    edges.get(`${r.viaFrom} ${r.node.id} ${r.viaEdge}`) ??
    edges.get(`${r.node.id} ${r.viaFrom} ${r.viaEdge}`)
  );
}

export function impactNodesWithinBudget(input: {
  readonly tokenBudget: number;
  readonly ctx: ToolContext;
  readonly roots: readonly string[];
  readonly missing: readonly string[];
  readonly depth: number;
  readonly walk: BfsResult;
  readonly prior: TruncationState;
  readonly unknown: readonly UnknownScope[];
  readonly notices: readonly string[];
}): ToolEnvelope {
  const { ctx, walk } = input;
  const edgeIndex = new Map<string, SeamlineEdge>();
  for (const e of walk.edges) edgeIndex.set(`${e.src} ${e.dst} ${e.kind}`, e);

  const items: Candidate[] = walk.reached
    .map((r) => ({ r, rank: factRank(viaEdgeOf(r, edgeIndex)) }))
    .sort(
      (a, b) =>
        a.r.depth - b.r.depth ||
        a.rank - b.rank ||
        compareIds(a.r.node.id, b.r.node.id) ||
        compareIds(a.r.viaEdge, b.r.viaEdge),
    )
    .map(({ r }) => ({ reached: r, detached: summarizeDetached(r.node, ctx.render) }));

  const byKind: Record<string, number> = {};
  for (const c of items) byKind[c.reached.node.kind] = (byKind[c.reached.node.kind] ?? 0) + 1;
  const sortedByKind = Object.fromEntries(
    Object.entries(byKind).sort(([a], [b]) => compareIds(a, b)),
  );

  return assembleWithinBudget({
    tool: 'impact',
    tokenBudget: input.tokenBudget,
    bounds: ctx.bounds,
    items,
    prior: input.prior,
    unknown: input.unknown,
    notices: input.notices,
    render: (kept) => ({
      result: {
        roots: input.roots,
        missing: input.missing,
        depth: input.depth,
        byKind: sortedByKind,
        reached: kept.map((c) => ({
          depth: c.reached.depth,
          via: c.reached.viaEdge,
          from: c.reached.viaFrom,
          node: c.detached.summary,
        })),
      },
      blocks: kept.flatMap((c) => c.detached.blocks),
    }),
    sink: ctx.render,
  });
}

/** Every id unresolved, under a budget: the same answer as without one, plus the budget fields. */
export function impactNothingResolvedWithinBudget(input: {
  readonly tokenBudget: number;
  readonly ctx: ToolContext;
  readonly missing: readonly string[];
  readonly unknown: readonly UnknownScope[];
  readonly notices: readonly string[];
}): ToolEnvelope {
  return assembleWithinBudget({
    tool: 'impact',
    tokenBudget: input.tokenBudget,
    bounds: input.ctx.bounds,
    items: [],
    prior: { truncated: false },
    unknown: input.unknown,
    notices: input.notices,
    render: () => ({
      result: { roots: [], missing: input.missing, reached: [], byKind: {} },
      blocks: [],
    }),
    sink: input.ctx.render,
  });
}
