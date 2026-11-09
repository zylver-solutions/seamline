/**
 * In-memory `GraphView` indexing: nodes by id and kind, edges by endpoint and
 * kind.
 *
 * Three packages independently grew a version of this (`@seamline/contradictions`'
 * detector fixtures, `@seamline/infer-join`'s test doubles, `@seamline/cli`'s
 * `StorePort` double) once each package could no longer avoid depending on
 * `@seamline/core`. This is the one place the indexing lives; each caller keeps
 * its own builder API and scope-status policy on top.
 */
import type { EdgeKind, NodeId, NodeKind, SeamlineEdge, SeamlineNode } from '@seamline/ontology';

export interface MemoryGraphIndex {
  addNode(node: SeamlineNode): void;
  addEdge(edge: SeamlineEdge): void;
  nodesByKind(kind: NodeKind): ReadonlyArray<SeamlineNode>;
  node(id: NodeId): SeamlineNode | undefined;
  edgesFrom(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge>;
  edgesTo(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge>;
  readonly allNodes: ReadonlyArray<SeamlineNode>;
  readonly allEdges: ReadonlyArray<SeamlineEdge>;
}

/**
 * `addNode` upserts by id, in place: re-adding an id updates its value without
 * moving it to the end of `nodesByKind`'s order, matching plain-`Map` upsert
 * semantics. `addEdge` always appends; none of the three callers ever needed
 * edge upsert.
 */
export function memoryGraphIndex(): MemoryGraphIndex {
  const nodes = new Map<NodeId, SeamlineNode>();
  const byKind = new Map<NodeKind, Map<NodeId, SeamlineNode>>();
  const from = new Map<NodeId, SeamlineEdge[]>();
  const to = new Map<NodeId, SeamlineEdge[]>();
  const edges: SeamlineEdge[] = [];

  return {
    addNode(node) {
      nodes.set(node.id, node);
      let bucket = byKind.get(node.kind);
      if (bucket === undefined) {
        bucket = new Map();
        byKind.set(node.kind, bucket);
      }
      bucket.set(node.id, node);
    },
    addEdge(edge) {
      edges.push(edge);
      push(from, edge.src, edge);
      push(to, edge.dst, edge);
    },
    nodesByKind(kind) {
      return [...(byKind.get(kind)?.values() ?? [])];
    },
    node(id) {
      return nodes.get(id);
    },
    edgesFrom(id, kind) {
      return filterKind(from.get(id), kind);
    },
    edgesTo(id, kind) {
      return filterKind(to.get(id), kind);
    },
    get allNodes() {
      return [...nodes.values()];
    },
    get allEdges() {
      return edges;
    },
  };
}

function push(map: Map<NodeId, SeamlineEdge[]>, key: NodeId, edge: SeamlineEdge): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [edge]);
  else bucket.push(edge);
}

function filterKind(
  bucket: SeamlineEdge[] | undefined,
  kind: EdgeKind | undefined,
): ReadonlyArray<SeamlineEdge> {
  const all = bucket ?? [];
  return kind === undefined ? all : all.filter((e) => e.kind === kind);
}
