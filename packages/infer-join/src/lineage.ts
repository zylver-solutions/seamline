/**
 * Field lineage: the payload `seamline why` prints, and the thing the 10-minute
 * acceptance gate in design v3 §1 is judged on.
 *
 * Given any node on the join, walk the four join relations in **both**
 * directions and return every chain reachable from it, each hop carrying its
 * own provenance and confidence, each chain carrying an aggregate.
 *
 *   Column  --MAPS_TO_FIELD-->  CodeField  --EXPOSED_AS-->  SchemaProperty
 *      |                            |                            |
 *      +--------- EXPOSED_AS -------+------- VALIDATED_BY -------+--> Symbol
 *      ^
 *      +--------- BACKED_BY --------- SchemaProperty
 *
 * Direction is not a property of the query, it is a property of the ontology:
 * `BACKED_BY` points from the API property to the column, `EXPOSED_AS` points
 * the other way, and a user asking "where does this column go?" and a user
 * asking "where does this field come from?" are walking the same edges. So the
 * default is `both`, and every hop records which way it was traversed.
 *
 * ## Why this returns `Maybe`
 *
 * v3 §2.2: a query whose answer depends on a scope whose extractor did not PASS
 * must return UNKNOWN, never a negative finding. An empty lineage map looks
 * exactly like "this column is orphaned", which is a finding. So: if any
 * required scope is degraded **and** the walk found nothing, the answer is
 * `unknown`. If the walk found something, the result is returned with the
 * degraded scopes attached so the caller can say "this may be incomplete"
 * rather than "this is all there is".
 */

import type {
  EdgeKind, ExtractorStatus, GraphView, Maybe, NodeId, NodeKind, Provenance,
  SeamlineEdge, SeamlineNode,
} from '@seamline/ontology';
import { isFact, known, unknown } from '@seamline/ontology';
import type { AggregateOptions } from './confidence.ts';
import { aggregateConfidence } from './confidence.ts';
import { REQUIRED_SCOPES } from './manifest.ts';

/** The relations a lineage walk follows. */
export const JOIN_EDGE_KINDS: ReadonlyArray<EdgeKind> = [
  'BACKED_BY', 'EXPOSED_AS', 'MAPS_TO_FIELD', 'VALIDATED_BY',
];

export type WalkDirection = 'out' | 'in' | 'both';

export interface LineageHop {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly kind: EdgeKind;
  /** `out` traversed the edge along its declared direction, `in` against it. */
  readonly direction: 'out' | 'in';
  readonly provenance: Provenance;
  readonly confidence: number;
  readonly toKind: NodeKind;
  readonly toName: string;
  /** True when this hop is EXTRACTED or DECLARED, i.e. a fact rather than a guess. */
  readonly fact: boolean;
}

export interface LineageChain {
  readonly start: NodeId;
  readonly end: NodeId;
  readonly endKind: NodeKind;
  readonly endName: string;
  readonly hops: ReadonlyArray<LineageHop>;
  /** Aggregated over the hops by `aggregateConfidence`. Non-increasing in path length. */
  readonly aggregate: number;
  /** The lowest single-hop confidence on the chain: an upper bound on `aggregate`. */
  readonly weakestHop: number;
}

export interface LineageResult {
  readonly start: NodeId;
  readonly startKind: NodeKind;
  readonly startName: string;
  readonly chains: ReadonlyArray<LineageChain>;
  /** True when the walk hit `maxChains` or `maxDepth` and stopped early. */
  readonly truncated: boolean;
  /** Required scopes whose extractor did not PASS. Lineage may be incomplete. */
  readonly degradedScopes: ReadonlyArray<string>;
}

export interface LineageOptions {
  readonly direction?: WalkDirection;
  readonly via?: ReadonlyArray<EdgeKind>;
  /** Bounded by construction (v3 §2.6). Default 6, which covers column to validator and back. */
  readonly maxDepth?: number;
  /** Cap on distinct end nodes. Default 256. */
  readonly maxChains?: number;
  /** Follow only EXTRACTED/DECLARED edges. Gates read facts only (v3 §2.4). */
  readonly factsOnly?: boolean;
  readonly aggregation?: AggregateOptions;
  /** Scopes whose status determines whether an empty result is UNKNOWN. */
  readonly requiredScopes?: ReadonlyArray<string>;
}

export const DEFAULT_MAX_DEPTH = 6;
export const DEFAULT_MAX_CHAINS = 256;

interface PartialPath {
  readonly node: SeamlineNode;
  readonly hops: ReadonlyArray<LineageHop>;
  readonly visited: ReadonlySet<NodeId>;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedEdges(edges: ReadonlyArray<SeamlineEdge>): ReadonlyArray<SeamlineEdge> {
  return edges
    .filter((e) => e.deletedAt === null)
    .slice()
    .sort((a, b) => compareIds(a.kind, b.kind) || compareIds(a.src, b.src) || compareIds(a.dst, b.dst));
}

/**
 * Walk the join relations from `start` and return the best chain to every
 * reachable node.
 *
 * "Best" is the highest aggregate, tie-broken by fewest hops and then by the
 * hop sequence, so the answer is a function of the graph and not of traversal
 * order. Chains are returned nearest-first: hop count ascending, then aggregate
 * descending, then end id - which is the order `seamline why` reads in.
 */
export function lineage(
  graph: GraphView,
  start: NodeId,
  options: LineageOptions = {},
): Maybe<LineageResult> {
  const direction = options.direction ?? 'both';
  const via = options.via ?? JOIN_EDGE_KINDS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxChains = options.maxChains ?? DEFAULT_MAX_CHAINS;
  const factsOnly = options.factsOnly ?? false;
  const aggregation = options.aggregation ?? {};
  const requiredScopes = options.requiredScopes ?? REQUIRED_SCOPES;

  const degradedScopes = requiredScopes
    .filter((scope) => scopeStatusOf(graph, scope) !== 'PASS')
    .slice()
    .sort();

  const startNode = graph.node(start);
  if (startNode === undefined || startNode.deletedAt !== null) {
    return unknown(`node ${start} is not in the graph`, degradedScopes);
  }

  const viaSet = new Set(via);
  const best = new Map<NodeId, LineageChain>();
  let truncated = false;

  const queue: PartialPath[] = [{ node: startNode, hops: [], visited: new Set([start]) }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current.hops.length >= maxDepth) {
      if (hasOnwardEdge(graph, current.node.id, viaSet, direction)) truncated = true;
      continue;
    }

    for (const step of stepsFrom(graph, current.node, viaSet, direction, factsOnly)) {
      if (current.visited.has(step.to)) continue;
      const next = graph.node(step.to);
      if (next === undefined || next.deletedAt !== null) continue;

      const hops = [...current.hops, step];
      const chain = toChain(start, next, hops, aggregation);
      const existing = best.get(next.id);
      if (existing === undefined) {
        if (best.size >= maxChains) {
          truncated = true;
          continue;
        }
        best.set(next.id, chain);
      } else if (betterChain(chain, existing)) {
        best.set(next.id, chain);
      }

      const visited = new Set(current.visited);
      visited.add(next.id);
      queue.push({ node: next, hops, visited });
    }
  }

  const chains = [...best.values()].sort((a, b) =>
    a.hops.length - b.hops.length ||
    b.aggregate - a.aggregate ||
    compareIds(a.end, b.end));

  if (chains.length === 0 && degradedScopes.length > 0) {
    return unknown(
      `no lineage found for ${start}, but ${degradedScopes.join(', ')} did not PASS; absence is not a finding`,
      degradedScopes,
    );
  }

  return known({
    start,
    startKind: startNode.kind,
    startName: startNode.name,
    chains,
    truncated,
    degradedScopes,
  });
}

function scopeStatusOf(graph: GraphView, scope: string): ExtractorStatus {
  try {
    return graph.scopeStatus(scope);
  } catch {
    return 'UNAVAILABLE';
  }
}

function stepsFrom(
  graph: GraphView,
  node: SeamlineNode,
  via: ReadonlySet<EdgeKind>,
  direction: WalkDirection,
  factsOnly: boolean,
): ReadonlyArray<LineageHop> {
  const hops: LineageHop[] = [];
  const consider = (edge: SeamlineEdge, way: 'out' | 'in'): void => {
    if (!via.has(edge.kind)) return;
    if (factsOnly && !isFact(edge.provenance)) return;
    const to = way === 'out' ? edge.dst : edge.src;
    const target = graph.node(to);
    if (target === undefined || target.deletedAt !== null) return;
    hops.push({
      from: node.id,
      to,
      kind: edge.kind,
      direction: way,
      provenance: edge.provenance,
      confidence: edge.confidence,
      toKind: target.kind,
      toName: target.name,
      fact: isFact(edge.provenance),
    });
  };

  if (direction === 'out' || direction === 'both') {
    for (const edge of sortedEdges(graph.edgesFrom(node.id))) consider(edge, 'out');
  }
  if (direction === 'in' || direction === 'both') {
    for (const edge of sortedEdges(graph.edgesTo(node.id))) consider(edge, 'in');
  }

  return hops.sort((a, b) =>
    compareIds(a.kind, b.kind) || compareIds(a.direction, b.direction) || compareIds(a.to, b.to));
}

function hasOnwardEdge(
  graph: GraphView,
  id: NodeId,
  via: ReadonlySet<EdgeKind>,
  direction: WalkDirection,
): boolean {
  const outward = direction === 'in' ? [] : graph.edgesFrom(id);
  const inward = direction === 'out' ? [] : graph.edgesTo(id);
  return [...outward, ...inward].some((e) => e.deletedAt === null && via.has(e.kind));
}

function toChain(
  start: NodeId,
  end: SeamlineNode,
  hops: ReadonlyArray<LineageHop>,
  aggregation: AggregateOptions,
): LineageChain {
  const confidences = hops.map((h) => h.confidence);
  return {
    start,
    end: end.id,
    endKind: end.kind,
    endName: end.name,
    hops,
    aggregate: aggregateConfidence(confidences, aggregation),
    weakestHop: confidences.length === 0 ? 1 : Math.min(...confidences),
  };
}

function betterChain(candidate: LineageChain, existing: LineageChain): boolean {
  if (candidate.aggregate !== existing.aggregate) return candidate.aggregate > existing.aggregate;
  if (candidate.hops.length !== existing.hops.length) return candidate.hops.length < existing.hops.length;
  return compareIds(hopSignature(candidate), hopSignature(existing)) < 0;
}

function hopSignature(chain: LineageChain): string {
  return chain.hops.map((h) => `${h.kind}:${h.direction}:${h.to}`).join('>');
}

/**
 * The single chain from `start` to `end`, if one exists within the walk bounds.
 * `seamline why <column> --to <property>` is this call.
 */
export function lineageBetween(
  graph: GraphView,
  start: NodeId,
  end: NodeId,
  options: LineageOptions = {},
): Maybe<LineageChain | undefined> {
  const result = lineage(graph, start, options);
  if (!result.known) return result;
  return known(result.value.chains.find((c) => c.end === end));
}
