/**
 * Copying a `GraphView` across the process boundary and back.
 *
 * A `GraphView` is a set of functions over an open store, so it cannot be
 * handed to a child process. A program that infers over other extractors'
 * facts (`infer-join`) is given a `GraphSnapshot` instead and rebuilds a view
 * from it. The rebuilt view answers every query exactly as the store did,
 * including the order of every list, because the snapshot is made of the
 * store's own answers and nothing is re-sorted on either side.
 */

import { NODE_KINDS } from '@seamline/ontology';
import type {
  EdgeKind,
  ExtractorStatus,
  GraphView,
  NodeId,
  NodeKind,
  SeamlineEdge,
  SeamlineNode,
} from '@seamline/ontology';
import type { GraphSnapshot } from './protocol.ts';

/**
 * Copy `view` into a snapshot.
 *
 * `scopes` are the scope names the program will ask `scopeStatus` about; a
 * view cannot be enumerated for them. Every live node is reachable through
 * `nodesByKind` and a live edge has two live endpoints, so walking the kinds
 * and then each node's edges copies everything a program can ask for.
 */
export function snapshotGraph(view: GraphView, scopes: ReadonlyArray<string>): GraphSnapshot {
  const nodes: SeamlineNode[] = [];
  for (const kind of NODE_KINDS) nodes.push(...view.nodesByKind(kind));
  const from: Array<readonly [NodeId, ReadonlyArray<SeamlineEdge>]> = [];
  const to: Array<readonly [NodeId, ReadonlyArray<SeamlineEdge>]> = [];
  for (const node of nodes) {
    const out = view.edgesFrom(node.id);
    if (out.length > 0) from.push([node.id, out]);
    const inn = view.edgesTo(node.id);
    if (inn.length > 0) to.push([node.id, inn]);
  }
  return { nodes, from, to, scopes: scopes.map((s) => [s, view.scopeStatus(s)] as const) };
}

/** A `GraphView` over a snapshot. A scope the snapshot does not name is UNAVAILABLE, as in the store. */
export function viewFromSnapshot(snapshot: GraphSnapshot): GraphView {
  const byId = new Map<NodeId, SeamlineNode>();
  const byKind = new Map<NodeKind, SeamlineNode[]>();
  for (const node of snapshot.nodes) {
    byId.set(node.id, node);
    const bucket = byKind.get(node.kind);
    if (bucket === undefined) byKind.set(node.kind, [node]);
    else bucket.push(node);
  }
  const from = new Map<NodeId, ReadonlyArray<SeamlineEdge>>(snapshot.from);
  const to = new Map<NodeId, ReadonlyArray<SeamlineEdge>>(snapshot.to);
  const scopes = new Map<string, ExtractorStatus>(snapshot.scopes);
  const ofKind = (edges: ReadonlyArray<SeamlineEdge> | undefined, kind: EdgeKind | undefined) =>
    kind === undefined ? (edges ?? []) : (edges ?? []).filter((e) => e.kind === kind);
  return {
    nodesByKind: (kind) => byKind.get(kind) ?? [],
    node: (id) => byId.get(id),
    edgesFrom: (id, kind) => ofKind(from.get(id), kind),
    edgesTo: (id, kind) => ofKind(to.get(id), kind),
    scopeStatus: (scope) => scopes.get(scope) ?? 'UNAVAILABLE',
  };
}
