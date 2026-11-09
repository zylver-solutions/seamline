/**
 * Field lineage — the engine behind `seamline why`.
 *
 * v3 §1 makes this the acceptance gate: on a repo nobody annotated, `why` must
 * produce a field-lineage map joining database column, ORM/model field, API
 * schema property, code type field, and validator, every hop carrying its own
 * provenance and confidence.
 *
 * Traversal is bounded by construction (v3 §2.6): depth cap, visited-node cap,
 * and chain cap, all supplied by the caller.
 */

import { compareCodeUnits } from '@seamline/core';
import {
  parseNodeId,
  type EdgeKind,
  type GraphView,
  type NodeId,
  type NodeKind,
  type Provenance,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';

/**
 * The join edges (v3 §4, "the wedge"). `FK_TO` and `ALIAS_OF` are included
 * because a column's lineage does not stop at a foreign key or a rename.
 */
export const LINEAGE_EDGE_KINDS: readonly EdgeKind[] = [
  'MAPS_TO_FIELD',
  'BACKED_BY',
  'EXPOSED_AS',
  'VALIDATED_BY',
  'PERSISTED_IN',
  'STORED_IN',
  'FK_TO',
  'ALIAS_OF',
];

/** Kinds a `why` target may resolve to. */
export const LINEAGE_TARGET_KINDS: readonly NodeKind[] = [
  'Column',
  'CodeField',
  'SchemaProperty',
  'DomainProperty',
  'Parameter',
  'Table',
  'Entity',
  'Operation',
  'Symbol',
];

export interface LineageHop {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly edge: EdgeKind;
  /** 'out' when the traversed edge points away from `from`, 'in' otherwise. */
  readonly direction: 'out' | 'in';
  readonly provenance: Provenance;
  readonly confidence: number;
  readonly sourceRef: string | undefined;
}

export interface LineageChain {
  readonly hops: readonly LineageHop[];
  /** Product of every hop's confidence. The chain is only as good as its weakest join. */
  readonly confidence: number;
  /** Lowest-ranked provenance on the chain: one INFERRED hop makes the chain INFERRED. */
  readonly weakestProvenance: Provenance;
}

export interface LineageResult {
  readonly target: SeamlineNode;
  /** Every node reachable within the caps, keyed by id. */
  readonly nodes: ReadonlyMap<NodeId, SeamlineNode>;
  /** Container (via `CONTAINS`) of each visited node, for display. */
  readonly containers: ReadonlyMap<NodeId, SeamlineNode>;
  readonly chains: readonly LineageChain[];
  /** True when a cap stopped the walk before the graph was exhausted. */
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
}

export interface LineageOptions {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxChains: number;
}

const PROVENANCE_ORDER: readonly Provenance[] = ['LLM_SUGGESTED', 'INFERRED', 'DECLARED', 'EXTRACTED'];

function weaker(a: Provenance, b: Provenance): Provenance {
  return PROVENANCE_ORDER.indexOf(a) <= PROVENANCE_ORDER.indexOf(b) ? a : b;
}

interface Adjacent {
  readonly node: NodeId;
  readonly hop: LineageHop;
}

function adjacent(view: GraphView, id: NodeId): readonly Adjacent[] {
  const out: Adjacent[] = [];
  for (const kind of LINEAGE_EDGE_KINDS) {
    for (const e of view.edgesFrom(id, kind)) {
      if (e.deletedAt !== null) continue;
      out.push({ node: e.dst, hop: toHop(id, e.dst, e, 'out') });
    }
    for (const e of view.edgesTo(id, kind)) {
      if (e.deletedAt !== null) continue;
      out.push({ node: e.src, hop: toHop(id, e.src, e, 'in') });
    }
  }
  // Stable ordering: determinism is a gate (v3 §2.3), and this output is
  // rendered, diffed, and asserted on.
  out.sort((a, b) => compareCodeUnits(a.hop.edge, b.hop.edge) || compareCodeUnits(a.node, b.node));
  return out;
}

function toHop(from: NodeId, to: NodeId, e: SeamlineEdge, direction: 'out' | 'in'): LineageHop {
  return {
    from,
    to,
    edge: e.kind,
    direction,
    provenance: e.provenance,
    confidence: e.confidence,
    sourceRef: e.sourceRef,
  };
}

/** The `CONTAINS` parent of a node, if there is one. Display only. */
export function containerOf(view: GraphView, id: NodeId): SeamlineNode | undefined {
  for (const e of view.edgesTo(id, 'CONTAINS')) {
    if (e.deletedAt !== null) continue;
    const parent = view.node(e.src);
    if (parent !== undefined) return parent;
  }
  return undefined;
}

/**
 * Breadth-first walk of the join edges from `target`, enumerating simple paths.
 *
 * Simple paths (no repeated node) are what a human reads as a lineage chain;
 * cycles through `FK_TO` would otherwise make the output unbounded even under
 * a depth cap.
 */
export function buildLineage(view: GraphView, target: SeamlineNode, opts: LineageOptions): LineageResult {
  const nodes = new Map<NodeId, SeamlineNode>([[target.id, target]]);
  const containers = new Map<NodeId, SeamlineNode>();
  const chains: LineageChain[] = [];
  const truncationReasons: string[] = [];

  const rootContainer = containerOf(view, target.id);
  if (rootContainer !== undefined) containers.set(target.id, rootContainer);

  let capped = false;
  const queue: Array<{ path: readonly LineageHop[]; visited: ReadonlySet<NodeId>; at: NodeId }> = [
    { path: [], visited: new Set([target.id]), at: target.id },
  ];

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;

    if (nodes.size >= opts.maxNodes) {
      capped = true;
      truncationReasons.push(`visited-node cap of ${opts.maxNodes} reached`);
      break;
    }
    if (chains.length >= opts.maxChains) {
      capped = true;
      truncationReasons.push(`chain cap of ${opts.maxChains} reached`);
      break;
    }

    const neighbours = adjacent(view, item.at).filter((a) => !item.visited.has(a.node));

    if (item.path.length >= opts.maxDepth) {
      if (neighbours.length > 0) {
        capped = true;
        truncationReasons.push(`depth cap of ${opts.maxDepth} reached at ${item.at}`);
      }
      if (item.path.length > 0) chains.push(makeChain(item.path));
      continue;
    }

    if (neighbours.length === 0) {
      if (item.path.length > 0) chains.push(makeChain(item.path));
      continue;
    }

    for (const n of neighbours) {
      const node = view.node(n.node);
      if (node === undefined || node.deletedAt !== null) continue;
      nodes.set(node.id, node);
      if (!containers.has(node.id)) {
        const c = containerOf(view, node.id);
        if (c !== undefined) containers.set(node.id, c);
      }
      const nextVisited = new Set(item.visited);
      nextVisited.add(n.node);
      queue.push({ path: [...item.path, n.hop], visited: nextVisited, at: n.node });
    }
  }

  // Longest, highest-confidence chains first: those carry the most information.
  chains.sort(
    (a, b) =>
      b.hops.length - a.hops.length || b.confidence - a.confidence || compareCodeUnits(chainKey(a), chainKey(b)),
  );

  return {
    target,
    nodes,
    containers,
    chains: chains.slice(0, opts.maxChains),
    truncated: capped || chains.length > opts.maxChains,
    truncationReasons: dedupe(truncationReasons),
  };
}

function chainKey(c: LineageChain): string {
  return c.hops.map((h) => `${h.edge}>${h.to}`).join('|');
}

function makeChain(hops: readonly LineageHop[]): LineageChain {
  let confidence = 1;
  let prov: Provenance = 'EXTRACTED';
  for (const h of hops) {
    confidence *= h.confidence;
    prov = weaker(prov, h.provenance);
  }
  return { hops, confidence, weakestProvenance: prov };
}

function dedupe(xs: readonly string[]): readonly string[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

export interface ResolveResult {
  readonly matches: readonly SeamlineNode[];
  /** How the match was made, for the "did you mean" message. */
  readonly strategy: 'node-id' | 'canonical-name' | 'suffix' | 'name' | 'none';
}

/**
 * Resolves a user-typed target to nodes.
 *
 * Tried in order, stopping at the first strategy that matches anything:
 *   1. exact `NodeId` (`repo:kind:canonicalName`)
 *   2. exact canonical name (`public.users.email`)
 *   3. dotted suffix of a canonical name (`users.email`)
 *   4. exact node `name` (`email`)
 *
 * Returning every match rather than guessing is deliberate: silently picking
 * one of eight `email` columns is worse than asking.
 */
export function resolveTarget(view: GraphView, raw: string, kinds: readonly NodeKind[] = LINEAGE_TARGET_KINDS): ResolveResult {
  const query = raw.trim();
  if (query.length === 0) return { matches: [], strategy: 'none' };

  if (query.split(':').length >= 3) {
    try {
      parseNodeId(query as NodeId);
      const direct = view.node(query as NodeId);
      if (direct !== undefined && direct.deletedAt === null) {
        return { matches: [direct], strategy: 'node-id' };
      }
    } catch {
      // fall through to the name strategies
    }
  }

  const pool: SeamlineNode[] = [];
  for (const kind of kinds) {
    for (const n of view.nodesByKind(kind)) {
      if (n.deletedAt === null) pool.push(n);
    }
  }
  pool.sort((a, b) => compareCodeUnits(a.id, b.id));

  const canonical = pool.filter((n) => parseNodeId(n.id).canonicalName === query);
  if (canonical.length > 0) return { matches: canonical, strategy: 'canonical-name' };

  const lower = query.toLowerCase();
  const suffix = pool.filter((n) => {
    const cn = parseNodeId(n.id).canonicalName.toLowerCase();
    return cn === lower || cn.endsWith(`.${lower}`) || cn.endsWith(`/${lower}`) || cn.endsWith(`#${lower}`);
  });
  if (suffix.length > 0) return { matches: suffix, strategy: 'suffix' };

  const byName = pool.filter((n) => n.name.toLowerCase() === lower);
  if (byName.length > 0) return { matches: byName, strategy: 'name' };

  return { matches: [], strategy: 'none' };
}
