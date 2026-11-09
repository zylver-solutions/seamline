/**
 * `impact(ids)` — blast radius.
 *
 * "If I change these, what else is reachable?" Undirected reachability over
 * the dependency and join edges, depth- and count-bounded, grouped by kind so
 * an agent can see the shape before asking for the detail.
 */

import { compareCodeUnits } from '@seamline/core';
import type { NodeId } from '@seamline/ontology';
import { capDepth, capList, fitToByteBudget, mergeTruncation } from '../bounds.ts';
import { TOKEN_BUDGET_PARAM } from '../budget.ts';
import { bfs, IMPACT_EDGE_KINDS, summarizeNode } from '../graph.ts';
import { envelope, unknownScopes } from '../result.ts';
import { impactNodesWithinBudget, impactNothingResolvedWithinBudget } from './impact-budget.ts';
import { affectedTests } from './impact-tests.ts';
import type { ToolDefinition } from './registry.ts';

interface Params {
  readonly ids: readonly string[];
  readonly depth?: number;
  readonly targets?: string;
  readonly tokenBudget?: number;
}

export const impactTool: ToolDefinition<Params> = {
  name: 'impact',
  title: 'Blast radius',
  description:
    'Given node ids, return everything reachable from them over dependency and join edges: the blast radius of changing them. ' +
    'Bounded by depth and result count; a truncated answer says so explicitly. Degraded scopes are reported, because an ' +
    'unreachable-looking node may simply come from a scope that did not run. ' +
    'Pass `targets: "tests"` to get the TestCase nodes that reach the ids instead: each is justified by a path of extracted facts ending in a TESTS edge, ' +
    'and the answer is UNKNOWN, never an empty list, when no PASS scope produced test facts, when a scope that produces the edges it crosses did not PASS, ' +
    'when the export profile withholds a kind it crosses, when an id was not assessed, when an id is a recognised test file or helper (changes to those are not traced to tests), when a test case names no file (so test files cannot all be recognised), ' +
    'or when the walk stopped at its depth or node cap. A TestCase given as an id is returned as itself. ' +
    'Known limits: test code is recognised from the graph (a file that defines extracted test cases, or that only test files import, directly or through other helpers, and that no test exercises), ' +
    'so a setup file nothing imports (conftest.py, a jest setupFiles entry), a helper that has tests of its own, and a test file with no extracted TestCase are not recognised: for an id in one the answer can be KNOWN and list only the tests the walk found. ' +
    'Pass `tokenBudget` to fit either answer to a context budget (nearest first; estimated tokens of the response text, not a tokenizer count; an explicit truncation reason when something was left out).',
  schema: {
    ids: {
      kind: 'stringArray',
      required: true,
      description: 'NodeIds (repo:Kind:canonicalName) to start from.',
      maxItems: 32,
      maxLength: 512,
    },
    depth: {
      kind: 'integer',
      required: false,
      description: 'Hops to expand. Clamped to the server ceiling.',
      min: 1,
      max: 8,
      fallback: 2,
    },
    targets: {
      kind: 'string',
      required: false,
      description:
        '`nodes` (default): everything reachable over dependency and join edges. ' +
        '`tests`: only the TestCase nodes that depend on the ids, each with the fact path that justifies it. Inferred links never justify a test.',
      maxLength: 16,
      choices: ['nodes', 'tests'],
    },
    tokenBudget: TOKEN_BUDGET_PARAM,
  },
  readOnly: true,
  run(params, ctx) {
    const unknown = unknownScopes(ctx.view, ctx.run);
    const ids = params.ids.slice(0, ctx.bounds.maxInputIds);

    const roots: NodeId[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const n = ctx.view.node(id as NodeId);
      if (n === undefined || n.deletedAt !== null) missing.push(id);
      else roots.push(n.id);
    }

    const { depth, clamped } = capDepth(params.depth, ctx.bounds);

    /** Notices that hold whichever way the answer is shaped. */
    const baseNotices = (): string[] => {
      const out: string[] = [];
      if (clamped) out.push(`Requested depth was clamped to the server ceiling of ${ctx.bounds.maxDepth}.`);
      if (missing.length > 0) out.push(`${missing.length} id(s) did not resolve: ${missing.join(', ')}`);
      if (params.ids.length > ctx.bounds.maxInputIds) {
        out.push(`Only the first ${ctx.bounds.maxInputIds} of ${params.ids.length} ids were used; the rest were dropped.`);
      }
      return out;
    };

    if (params.targets === 'tests') {
      const notices = baseNotices();
      if (roots.length === 0) {
        notices.push(
          `None of the ${ids.length} id(s) resolved to a live node. Use \`context\` to resolve a name to a NodeId first.`,
        );
      }
      return affectedTests({
        ctx,
        roots,
        missing,
        dropped: params.ids.slice(ctx.bounds.maxInputIds),
        depth,
        unknown,
        notices,
        tokenBudget: params.tokenBudget,
      });
    }

    if (roots.length === 0) {
      const none = `None of the ${ids.length} id(s) resolved to a live node. Use \`context\` to resolve a name to a NodeId first.`;
      if (params.tokenBudget !== undefined) {
        return impactNothingResolvedWithinBudget({
          tokenBudget: params.tokenBudget,
          ctx,
          missing,
          unknown,
          notices: [none],
        });
      }
      return envelope(
        'impact',
        { roots: [], missing, reached: [], byKind: {} },
        {
          state: { truncated: false },
          unknown,
          emptyResult: true,
          notices: [none],
        },
      );
    }

    const walk = bfs(ctx.view, roots, IMPACT_EDGE_KINDS, {
      maxDepth: depth,
      maxNodes: ctx.bounds.maxResults,
    });

    const capped = capList(walk.reached, ctx.bounds.maxResults);
    if (params.tokenBudget !== undefined) {
      return impactNodesWithinBudget({
        tokenBudget: params.tokenBudget,
        ctx,
        roots,
        missing,
        depth,
        walk: { ...walk, reached: capped.items },
        prior: mergeTruncation(walk.state, capped.state),
        unknown,
        notices: baseNotices(),
      });
    }
    const build = (kept: typeof walk.reached): unknown => {
      const byKind: Record<string, number> = {};
      for (const r of kept) byKind[r.node.kind] = (byKind[r.node.kind] ?? 0) + 1;
      return {
        roots,
        missing,
        depth,
        byKind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => compareCodeUnits(a, b))),
        reached: kept.map((r) => ({
          depth: r.depth,
          via: r.viaEdge,
          from: r.viaFrom,
          node: summarizeNode(r.node, ctx.render),
        })),
      };
    };

    const fitted = fitToByteBudget(capped.items, build, ctx.bounds.maxBytes, mergeTruncation(walk.state, capped.state));

    return envelope('impact', fitted.body, {
      state: fitted.state,
      unknown,
      notices: baseNotices(),
      emptyResult: fitted.items.length === 0,
    });
  },
};
