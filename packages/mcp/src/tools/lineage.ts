/**
 * `lineage(field)` — the cross-domain join, served to an agent.
 *
 * The same wedge `seamline why` renders for a human: database column ↔ ORM
 * field ↔ API schema property ↔ code type field ↔ validator, every hop
 * carrying its own provenance and confidence.
 *
 * The result is a breadth-first tree with parent pointers rather than an
 * enumeration of every simple path. Path enumeration is exponential in a graph
 * with foreign keys, and an agent reconstructs a chain from `from` pointers
 * trivially; `chains` renders the tree's root-to-leaf paths for convenience,
 * one per leaf, so the count stays linear.
 */

import { type NodeId, type NodeKind } from '@seamline/ontology';
import { capDepth, capList, fitToByteBudget, mergeTruncation } from '../bounds.ts';
import { bfs, LINEAGE_EDGE_KINDS, LINEAGE_TARGET_KINDS, summarizeNode, resolveNode } from '../graph.ts';
import { envelope, unknownScopes } from '../result.ts';
import type { ToolDefinition } from './registry.ts';

interface Params {
  readonly field: string;
  readonly kind?: string;
  readonly depth?: number;
}

interface Hop {
  readonly from: string;
  readonly to: string;
  readonly via: string;
  readonly provenance: string;
  readonly confidence: number;
}

export const lineageTool: ToolDefinition<Params> = {
  name: 'lineage',
  title: 'Field lineage',
  description:
    'Trace a field across domains: database column, ORM/model field, API schema property, code type field, validator. ' +
    'Every hop carries its own provenance (EXTRACTED / DECLARED / INFERRED / LLM_SUGGESTED) and confidence — an INFERRED ' +
    'hop is a guess, not a fact, and the chain is only as strong as its weakest hop.',
  schema: {
    field: {
      kind: 'string',
      required: true,
      description: 'A column, field, or schema property: a NodeId, a qualified name (users.email), or a bare name.',
      maxLength: 512,
    },
    kind: {
      kind: 'string',
      required: false,
      description: 'Restrict resolution to one node kind.',
      maxLength: 32,
      choices: LINEAGE_TARGET_KINDS,
    },
    depth: {
      kind: 'integer',
      required: false,
      description: 'Join hops to follow. Clamped to the server ceiling.',
      min: 1,
      max: 8,
      fallback: 4,
    },
  },
  readOnly: true,
  run(params, ctx) {
    const unknown = unknownScopes(ctx.view, ctx.run);
    const kinds: readonly NodeKind[] =
      params.kind === undefined ? LINEAGE_TARGET_KINDS : [params.kind as NodeKind];
    const resolved = resolveNode(ctx.view, params.field, kinds);

    if (resolved.matches.length === 0) {
      return envelope(
        'lineage',
        { found: false, candidates: [], chains: [] },
        {
          state: { truncated: false },
          unknown,
          emptyResult: true,
          notices: [`No column, field, or schema property matches \`${params.field}\`.`],
        },
      );
    }
    if (resolved.matches.length > 1) {
      const { items, state } = capList(resolved.matches, Math.min(25, ctx.bounds.maxResults));
      return envelope(
        'lineage',
        {
          found: false,
          ambiguous: true,
          totalMatches: resolved.matches.length,
          candidates: items.map((n) => ({ id: n.id, kind: n.kind, name: n.name, path: n.path ?? null })),
          chains: [],
        },
        {
          state,
          unknown,
          notices: [`\`${params.field}\` matches ${resolved.matches.length} nodes; call lineage again with a NodeId.`],
        },
      );
    }

    const target = resolved.matches[0];
    if (target === undefined) {
      return envelope('lineage', { found: false, chains: [] }, { state: { truncated: false }, unknown, emptyResult: true });
    }

    const { depth, clamped } = capDepth(params.depth, ctx.bounds);
    const walk = bfs(ctx.view, [target.id as NodeId], LINEAGE_EDGE_KINDS, {
      maxDepth: depth,
      maxNodes: ctx.bounds.maxResults,
    });

    const capped = capList(walk.reached, ctx.bounds.maxResults);

    const build = (kept: typeof walk.reached): unknown => {
      const parent = new Map<string, Hop>();
      const confidenceByEdge = new Map<string, { provenance: string; confidence: number }>();
      for (const e of walk.edges) {
        confidenceByEdge.set(`${e.src}|${e.dst}|${e.kind}`, {
          provenance: e.provenance,
          confidence: e.confidence,
        });
      }
      for (const r of kept) {
        const forward = confidenceByEdge.get(`${r.viaFrom}|${r.node.id}|${r.viaEdge}`);
        const backward = confidenceByEdge.get(`${r.node.id}|${r.viaFrom}|${r.viaEdge}`);
        const meta = forward ?? backward ?? { provenance: 'INFERRED', confidence: 0 };
        parent.set(r.node.id, {
          from: r.viaFrom,
          to: r.node.id,
          via: r.viaEdge,
          provenance: meta.provenance,
          confidence: meta.confidence,
        });
      }

      const hasChild = new Set<string>(kept.map((r) => r.viaFrom));
      const leaves = kept.filter((r) => !hasChild.has(r.node.id));

      const chains = leaves.map((leaf) => {
        const hops: Hop[] = [];
        let cursor: string | undefined = leaf.node.id;
        while (cursor !== undefined && cursor !== target.id) {
          const hop: Hop | undefined = parent.get(cursor);
          if (hop === undefined) break;
          hops.unshift(hop);
          cursor = hop.from;
        }
        const confidence = hops.reduce((acc, h) => acc * h.confidence, 1);
        const weakest = hops.reduce(
          (acc, h) => (PROV_RANK[h.provenance] ?? 0) < (PROV_RANK[acc] ?? 0) ? h.provenance : acc,
          'EXTRACTED',
        );
        return { hops, confidence: Number(confidence.toFixed(4)), weakestProvenance: weakest };
      });

      return {
        found: true,
        target: summarizeNode(target, ctx.render),
        depth,
        nodes: kept.map((r) => ({ depth: r.depth, node: summarizeNode(r.node, ctx.render) })),
        chains,
      };
    };

    const fitted = fitToByteBudget(capped.items, build, ctx.bounds.maxBytes, mergeTruncation(walk.state, capped.state));

    const notices: string[] = [];
    if (clamped) notices.push(`Requested depth was clamped to the server ceiling of ${ctx.bounds.maxDepth}.`);
    if (fitted.items.length === 0) {
      notices.push(
        'No join edges reach this field. That is either a genuinely unjoined field or a scope that did not run — check `unknown` before concluding the former.',
      );
    }

    return envelope('lineage', fitted.body, {
      state: fitted.state,
      unknown,
      notices,
      emptyResult: fitted.items.length === 0,
    });
  },
};

const PROV_RANK: Readonly<Record<string, number>> = {
  LLM_SUGGESTED: 0,
  INFERRED: 1,
  DECLARED: 2,
  EXTRACTED: 3,
};
