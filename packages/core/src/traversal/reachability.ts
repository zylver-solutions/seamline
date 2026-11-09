/**
 * Bounded graph reachability: neighbour expansion and breadth-first search.
 *
 * Traversal here is deliberately narrow: a fixed edge-kind set per caller, a
 * depth cap, and a visited-node cap. There is no general query entry point,
 * because v3 §2.6 removes `cypher` from the store interface — on the Postgres
 * adapter it was arbitrary query execution inside the database.
 *
 * Shared by `@seamline/cli` (`seamline blast-radius`, `seamline why`) and
 * `@seamline/mcp` (the `impact`, `context`, `lineage`, and `explain` tools):
 * both packages sit downstream of `@seamline/core`, so this is the one place
 * the algorithm lives rather than being duplicated per package.
 */

import type { EdgeKind, GraphView, NodeId, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { compareCodeUnits } from '../sif/canonicalize.ts';
import { NOT_TRUNCATED, truncation, type TruncationState } from './bounds.ts';

/** Dependency and join edges: what a change can reach. */
export const IMPACT_EDGE_KINDS: readonly EdgeKind[] = [
  'CALLS',
  'IMPORTS',
  'USES_TYPE',
  'EXTENDS',
  'IMPLEMENTS',
  'QUERIES',
  'HANDLES_ROUTE',
  'IMPLEMENTED_BY',
  'MAPS_TO_FIELD',
  'BACKED_BY',
  'EXPOSED_AS',
  'VALIDATED_BY',
  'PERSISTED_IN',
  'STORED_IN',
  'FK_TO',
  'MIGRATED_BY',
  'TESTS',
  'COVERS',
];

export interface Neighbour {
  readonly node: SeamlineNode;
  readonly edge: SeamlineEdge;
  readonly direction: 'out' | 'in';
}

export function neighbours(
  view: GraphView,
  id: NodeId,
  kinds: readonly EdgeKind[],
  direction: 'out' | 'in' | 'both' = 'both',
): readonly Neighbour[] {
  const out: Neighbour[] = [];
  for (const kind of kinds) {
    if (direction !== 'in') {
      for (const e of view.edgesFrom(id, kind)) {
        if (e.deletedAt !== null) continue;
        const n = view.node(e.dst);
        if (n !== undefined && n.deletedAt === null) out.push({ node: n, edge: e, direction: 'out' });
      }
    }
    if (direction !== 'out') {
      for (const e of view.edgesTo(id, kind)) {
        if (e.deletedAt !== null) continue;
        const n = view.node(e.src);
        if (n !== undefined && n.deletedAt === null) out.push({ node: n, edge: e, direction: 'in' });
      }
    }
  }
  // Determinism: the same graph must produce the same response bytes, so the
  // order is by code unit, never by locale.
  out.sort(
    (a, b) => compareCodeUnits(a.edge.kind, b.edge.kind) || compareCodeUnits(a.node.id, b.node.id),
  );
  return out;
}

export interface Reached {
  readonly node: SeamlineNode;
  readonly depth: number;
  readonly viaEdge: EdgeKind;
  readonly viaFrom: string;
}

export interface BfsResult {
  readonly reached: readonly Reached[];
  readonly edges: readonly SeamlineEdge[];
  readonly state: TruncationState;
}

/** Breadth-first, depth- and count-bounded. Roots are not included in `reached`. */
export function bfs(
  view: GraphView,
  roots: readonly NodeId[],
  kinds: readonly EdgeKind[],
  opts: { readonly maxDepth: number; readonly maxNodes: number; readonly direction?: 'out' | 'in' | 'both' },
): BfsResult {
  const seen = new Set<string>(roots);
  const reached: Reached[] = [];
  const edges: SeamlineEdge[] = [];
  let frontier: NodeId[] = [...roots];
  let hitDepth = false;
  let hitCount = false;

  for (let depth = 1; depth <= opts.maxDepth; depth += 1) {
    const next: NodeId[] = [];
    for (const id of frontier) {
      for (const n of neighbours(view, id, kinds, opts.direction)) {
        edges.push(n.edge);
        if (seen.has(n.node.id)) continue;
        if (reached.length >= opts.maxNodes) {
          hitCount = true;
          break;
        }
        seen.add(n.node.id);
        reached.push({ node: n.node, depth, viaEdge: n.edge.kind, viaFrom: id });
        next.push(n.node.id);
      }
      if (hitCount) break;
    }
    if (hitCount) break;
    if (next.length === 0) break;
    if (depth === opts.maxDepth && next.length > 0) {
      // There was more graph past the cap.
      hitDepth = next.some((id) => neighbours(view, id, kinds, opts.direction).some((n) => !seen.has(n.node.id)));
    }
    frontier = next;
  }

  const reasons: Array<'result-cap' | 'depth-cap'> = [];
  if (hitCount) reasons.push('result-cap');
  if (hitDepth) reasons.push('depth-cap');
  return {
    reached,
    edges: dedupeEdges(edges),
    state: reasons.length === 0 ? NOT_TRUNCATED : truncation(reasons, reached.length, null),
  };
}

function dedupeEdges(edges: readonly SeamlineEdge[]): readonly SeamlineEdge[] {
  const seen = new Set<string>();
  const out: SeamlineEdge[] = [];
  for (const e of edges) {
    const key = `${e.src} ${e.dst} ${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  out.sort(
    (a, b) => compareCodeUnits(a.src, b.src) || compareCodeUnits(a.dst, b.dst) || compareCodeUnits(a.kind, b.kind),
  );
  return out;
}
