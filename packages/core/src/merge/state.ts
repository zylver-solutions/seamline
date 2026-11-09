/**
 * The merged graph and the merge operation itself (v3 §2.2, §2.4).
 *
 * `mergeStates` is a commutative, associative, idempotent binary operation over
 * `MergeState`, so a run's batches can arrive in any order and be folded in any
 * grouping. Both halves are built that way on purpose:
 *
 * - the winning *body* is the maximum under the total order in `precedence.ts`;
 * - the *lifecycle* fields are a separate min/max/settle fold (`lifecycle.ts`).
 *
 * The winner takes its body whole. Splicing props from a lower-provenance fact
 * into a higher-provenance body would manufacture a composite assertion that no
 * extractor made, which §2.4 exists to prevent — every stored fact stays
 * attributable to exactly one `FactSource`.
 */

import {
  edgeKey,
  type AuthoritativeScope,
  type ExtractorStatus,
  type NodeId,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';

import { mergeLifecycle, observedIn } from './lifecycle.ts';
import { compareFacts, type FactSource } from './precedence.ts';
import { canonicalJson, compareStrings } from './serialize.ts';
import { assertAuthoritySelectors } from '../store/scope-selector.ts';
import { isCanonicalSelectorText } from '../store/canonical-selector.ts';

/** Severity order for combining two statuses observed in the same run. */
const STATUS_RANK: Readonly<Record<ExtractorStatus, number>> = { PASS: 2, UNAVAILABLE: 1, FAIL: 0 };

export interface MergedNode {
  readonly node: SeamlineNode;
  readonly source: FactSource;
}

export interface MergedEdge {
  readonly edge: SeamlineEdge;
  /** The scope the edge is stored under; part of its uniqueness key. */
  readonly scope: string;
  readonly source: FactSource;
}

export interface ScopeStatusEntry {
  readonly scope: string;
  readonly status: ExtractorStatus;
  /** The run this status was observed in. A later run replaces an earlier one. */
  readonly runId: string;
}

export interface MergeState {
  readonly nodes: ReadonlyMap<NodeId, MergedNode>;
  /** Keyed by `edgeKey(scope, edge)`. */
  readonly edges: ReadonlyMap<string, MergedEdge>;
  readonly scopes: ReadonlyMap<string, ScopeStatusEntry>;
}

/** One extractor's output for one run: the unit that is folded into a state. */
export interface MergeBatch {
  readonly runId: string;
  /** Required for canonical authority; legacy path-only callers may omit it. */
  readonly repo?: string;
  readonly extractor: string;
  /** Higher wins a provenance tie. */
  readonly extractorPriority: number;
  readonly status: ExtractorStatus;
  /** Scope the emitted edges are stored under. */
  readonly scope: string;
  /** The (kind, selector) pairs this batch is the authority for; drives tombstoning. */
  readonly authoritative: ReadonlyArray<AuthoritativeScope>;
  readonly nodes: ReadonlyArray<SeamlineNode>;
  readonly edges: ReadonlyArray<SeamlineEdge>;
}

export const EMPTY_STATE: MergeState = {
  nodes: new Map(),
  edges: new Map(),
  scopes: new Map(),
};

export function sourceOf(batch: MergeBatch): FactSource {
  return { extractor: batch.extractor, extractorPriority: batch.extractorPriority, runId: batch.runId };
}

function mergeNodes(a: MergedNode, b: MergedNode): MergedNode {
  const winner = compareFacts(a.node, a.source, b.node, b.source) >= 0 ? a : b;
  const life = mergeLifecycle(a.node, b.node);
  return { node: { ...winner.node, ...life }, source: winner.source };
}

function mergeEdges(a: MergedEdge, b: MergedEdge): MergedEdge {
  const winner = compareFacts(a.edge, a.source, b.edge, b.source) >= 0 ? a : b;
  const life = mergeLifecycle(a.edge, b.edge);
  return { edge: { ...winner.edge, ...life }, scope: winner.scope, source: winner.source };
}

/**
 * Later run wins; within one run the worse status wins, because a scope that
 * any extractor failed to cover is not a scope anything may conclude from
 * (v3 §2.2, "UNAVAILABLE is never PASS").
 */
export function mergeScopeStatus(a: ScopeStatusEntry, b: ScopeStatusEntry): ScopeStatusEntry {
  const byRun = compareStrings(a.runId, b.runId);
  if (byRun !== 0) return byRun > 0 ? a : b;
  const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (byStatus !== 0) return byStatus < 0 ? a : b;
  return compareStrings(a.scope, b.scope) <= 0 ? a : b;
}

function put<K, V>(map: Map<K, V>, key: K, value: V, combine: (x: V, y: V) => V): void {
  const existing = map.get(key);
  map.set(key, existing === undefined ? value : combine(existing, value));
}

/**
 * Lift one extractor batch into a state.
 *
 * A batch whose status is not `PASS` contributes **no facts at all** — only its
 * scope status. A crashed extractor produces no facts, not the absence of
 * facts, and not half a truth either: partial output from a failed run is not
 * evidence of anything (v3 §2.2).
 */
export function stateFromBatch(batch: MergeBatch): MergeState {
  if (batch.runId.length === 0) throw new Error('MergeBatch.runId must not be empty');
  if (batch.scope.length === 0) throw new Error('MergeBatch.scope must not be empty');
  assertAuthoritySelectors(batch.authoritative);
  if (batch.repo === undefined && batch.authoritative.some(claim =>
    claim.selector !== undefined && isCanonicalSelectorText(claim.selector)))
    throw new Error('canonical authority requires the active run repository');

  const scopes = new Map<string, ScopeStatusEntry>();
  for (const scope of [batch.scope, ...batch.authoritative.map((a) => a.scope)]) {
    put(scopes, scope, { scope, status: batch.status, runId: batch.runId }, mergeScopeStatus);
  }

  const nodes = new Map<NodeId, MergedNode>();
  const edges = new Map<string, MergedEdge>();
  if (batch.status !== 'PASS') return { nodes, edges, scopes };

  const source = sourceOf(batch);
  for (const raw of batch.nodes) {
    const node: SeamlineNode = { ...raw, ...observedIn(raw, batch.runId) };
    put(nodes, node.id, { node, source }, mergeNodes);
  }
  for (const raw of batch.edges) {
    const edge: SeamlineEdge = { ...raw, ...observedIn(raw, batch.runId) };
    put(edges, edgeKey(batch.scope, edge), { edge, scope: batch.scope, source }, mergeEdges);
  }
  return { nodes, edges, scopes };
}

/** The merge. Commutative, associative, idempotent — proven in the property suite. */
export function mergeStates(a: MergeState, b: MergeState): MergeState {
  const nodes = new Map(a.nodes);
  for (const [id, value] of b.nodes) put(nodes, id, value, mergeNodes);

  const edges = new Map(a.edges);
  for (const [key, value] of b.edges) put(edges, key, value, mergeEdges);

  const scopes = new Map(a.scopes);
  for (const [scope, value] of b.scopes) put(scopes, scope, value, mergeScopeStatus);

  return { nodes, edges, scopes };
}

export function mergeAll(states: Iterable<MergeState>): MergeState {
  let acc = EMPTY_STATE;
  for (const s of states) acc = mergeStates(acc, s);
  return acc;
}

export function mergeBatches(batches: Iterable<MergeBatch>, prior: MergeState = EMPTY_STATE): MergeState {
  let acc = prior;
  for (const b of batches) acc = mergeStates(acc, stateFromBatch(b));
  return acc;
}

/** The equality relation for a merged state: order-free and byte-stable. */
export function canonicalizeState(state: MergeState): string {
  const nodes = [...state.nodes.values()]
    .sort((x, y) => compareStrings(x.node.id, y.node.id))
    .map((m) => ({ node: m.node as unknown, source: m.source }));
  const edges = [...state.edges.entries()]
    .sort((x, y) => compareStrings(x[0], y[0]))
    .map(([key, m]) => ({ key, scope: m.scope, edge: m.edge as unknown, source: m.source }));
  const scopes = [...state.scopes.values()].sort((x, y) => compareStrings(x.scope, y.scope));
  return canonicalJson({ nodes, edges, scopes });
}

export function statesEqual(a: MergeState, b: MergeState): boolean {
  return canonicalizeState(a) === canonicalizeState(b);
}

/** Nodes that are alive, sorted by id. Tombstoned nodes are retained, not returned. */
export function liveNodes(state: MergeState): ReadonlyArray<SeamlineNode> {
  return [...state.nodes.values()]
    .map((m) => m.node)
    .filter((n) => n.deletedAt === null)
    .sort((x, y) => compareStrings(x.id, y.id));
}

export function liveEdges(state: MergeState): ReadonlyArray<SeamlineEdge> {
  return [...state.edges.entries()]
    .sort((x, y) => compareStrings(x[0], y[0]))
    .map(([, m]) => m.edge)
    .filter((e) => e.deletedAt === null);
}

export type { FactSource };
