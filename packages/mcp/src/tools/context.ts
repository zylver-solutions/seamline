/**
 * `context(symbol)` — what a symbol is, what contains it, and what it touches.
 *
 * The first call an agent makes. Bounded to one hop by default: the point is
 * orientation, not a graph dump.
 */

import { NODE_KINDS, type NodeId, type NodeKind } from '@seamline/ontology';
import { capDepth, capList, fitToByteBudget, mergeTruncation } from '../bounds.ts';
import { TOKEN_BUDGET_PARAM } from '../budget.ts';
import { bfs, CONTEXT_EDGE_KINDS, containerOf, summarizeEdge, summarizeNode, resolveNode } from '../graph.ts';
import { envelope, unknownScopes } from '../result.ts';
import { ambiguousWithinBudget, contextWithinBudget, notFoundWithinBudget } from './context-budget.ts';
import type { ToolDefinition } from './registry.ts';

interface Params {
  readonly symbol: string;
  readonly kind?: string;
  readonly depth?: number;
  readonly tokenBudget?: number;
}

/** Kinds a `context` lookup may resolve to. Broad, because a symbol may be anything. */
const RESOLVE_KINDS: readonly NodeKind[] = [
  'Symbol',
  'CodeField',
  'File',
  'Module',
  'Table',
  'Column',
  'Contract',
  'Operation',
  'SchemaProperty',
  'Entity',
  'RouteHandler',
  'TestCase',
];

export const contextTool: ToolDefinition<Params> = {
  name: 'context',
  title: 'Symbol context',
  description:
    'Resolve a symbol, file, table, column, or schema property and return what contains it and what it directly touches. ' +
    'Bounded: one hop by default. Returns UNKNOWN scopes alongside the result; an empty result while a scope is degraded does not mean the symbol has no context. ' +
    'Pass `tokenBudget` to fit the answer to a context budget: it is assembled in priority order (the node, its container, direct facts, joins, farther hops) ' +
    'and reports `estimatedTokens` (an estimate, not a tokenizer count) and an explicit truncation reason when something was left out.',
  schema: {
    symbol: {
      kind: 'string',
      required: true,
      description: 'A NodeId (repo:Kind:canonicalName), a qualified name, or a bare name.',
      maxLength: 512,
    },
    kind: {
      kind: 'string',
      required: false,
      description: 'Restrict resolution to one node kind.',
      maxLength: 32,
      choices: NODE_KINDS,
    },
    depth: {
      kind: 'integer',
      required: false,
      description: 'Hops to expand. Clamped to the server ceiling.',
      min: 1,
      max: 8,
      fallback: 1,
    },
    tokenBudget: TOKEN_BUDGET_PARAM,
  },
  readOnly: true,
  run(params, ctx) {
    const kinds = params.kind === undefined ? RESOLVE_KINDS : [params.kind as NodeKind];
    const resolved = resolveNode(ctx.view, params.symbol, kinds);
    const unknown = unknownScopes(ctx.view, ctx.run);

    if (resolved.matches.length === 0) {
      if (params.tokenBudget !== undefined) {
        return notFoundWithinBudget({ tokenBudget: params.tokenBudget, ctx, symbol: params.symbol, unknown });
      }
      return envelope('context', { found: false, candidates: [] }, {
        state: { truncated: false },
        unknown,
        emptyResult: true,
        notices: [`No node matches \`${params.symbol}\`.`],
      });
    }

    if (resolved.matches.length > 1) {
      const { items, state } = capList(resolved.matches, Math.min(25, ctx.bounds.maxResults));
      if (params.tokenBudget !== undefined) {
        return ambiguousWithinBudget({
          tokenBudget: params.tokenBudget,
          ctx,
          symbol: params.symbol,
          strategy: resolved.strategy,
          totalMatches: resolved.matches.length,
          items,
          prior: state,
          unknown,
        });
      }
      return envelope(
        'context',
        {
          found: false,
          ambiguous: true,
          matchedBy: resolved.strategy,
          totalMatches: resolved.matches.length,
          candidates: items.map((n) => ({ id: n.id, kind: n.kind, name: n.name, path: n.path ?? null })),
        },
        {
          state,
          unknown,
          notices: [
            `\`${params.symbol}\` matches ${resolved.matches.length} nodes. Call context again with a full NodeId, or pass \`kind\`.`,
          ],
        },
      );
    }

    const target = resolved.matches[0];
    if (target === undefined) {
      return envelope('context', { found: false, candidates: [] }, { state: { truncated: false }, unknown, emptyResult: true });
    }

    const { depth, clamped } = capDepth(params.depth, ctx.bounds);
    const walk = bfs(ctx.view, [target.id], CONTEXT_EDGE_KINDS, {
      maxDepth: depth,
      maxNodes: ctx.bounds.maxResults,
    });

    const container = containerOf(ctx.view, target.id as NodeId);
    if (params.tokenBudget !== undefined) {
      return contextWithinBudget({
        tokenBudget: params.tokenBudget,
        ctx,
        target,
        container,
        strategy: resolved.strategy,
        depth,
        clamped,
        walk,
        prior: mergeTruncation(walk.state, capList(walk.reached, ctx.bounds.maxResults).state),
        unknown,
      });
    }
    const build = (kept: typeof walk.reached): unknown => ({
      found: true,
      matchedBy: resolved.strategy,
      node: summarizeNode(target, ctx.render),
      container: container === undefined ? null : summarizeNode(container, ctx.render),
      depth,
      related: kept.map((r) => ({
        depth: r.depth,
        via: r.viaEdge,
        from: r.viaFrom,
        node: summarizeNode(r.node, ctx.render),
      })),
      edges: walk.edges.slice(0, ctx.bounds.maxResults).map(summarizeEdge),
    });

    const capped = capList(walk.reached, ctx.bounds.maxResults);
    const fitted = fitToByteBudget(capped.items, build, ctx.bounds.maxBytes, mergeTruncation(walk.state, capped.state));

    const notices: string[] = [];
    if (clamped) {
      notices.push(`Requested depth was clamped to the server ceiling of ${ctx.bounds.maxDepth}.`);
    }

    return envelope('context', fitted.body, {
      state: fitted.state,
      unknown,
      notices,
      emptyResult: fitted.items.length === 0,
    });
  },
};
