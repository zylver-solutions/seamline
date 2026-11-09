import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EDGE_KINDS,
  NODE_KINDS,
  type EdgeKind,
  type ExtractorStatus,
  type GraphView,
} from '@seamline/ontology';
import { makeEdge, makeNode, memoryGraph } from '../testing.ts';
import { snapshotGraph, viewFromSnapshot } from './snapshot.ts';

function fixture() {
  const table = makeNode({ kind: 'Table', canonicalName: 'public.posts' });
  const title = makeNode({ kind: 'Column', canonicalName: 'public.posts.title' });
  const body = makeNode({ kind: 'Column', canonicalName: 'public.posts.body' });
  const model = makeNode({
    kind: 'Symbol',
    canonicalName: 'src/post.ts#Post',
    path: 'src/post.ts',
  });
  const field = makeNode({
    kind: 'CodeField',
    canonicalName: 'src/post.ts#Post.title',
    path: 'src/post.ts',
  });
  const gone = makeNode({ kind: 'Column', canonicalName: 'public.posts.gone' });
  const nodes = [table, title, body, model, field, gone];
  const edges = [
    makeEdge({ kind: 'CONTAINS', src: table.id, dst: title.id, provenance: 'EXTRACTED' }),
    makeEdge({ kind: 'CONTAINS', src: table.id, dst: body.id, provenance: 'EXTRACTED' }),
    makeEdge({ kind: 'CONTAINS', src: model.id, dst: field.id, provenance: 'EXTRACTED' }),
    makeEdge({ kind: 'MAPS_TO_FIELD', src: title.id, dst: field.id, confidence: 0.8 }),
    makeEdge({ kind: 'QUERIES', src: model.id, dst: table.id, provenance: 'EXTRACTED' }),
  ];
  return { nodes, edges };
}

const SCOPES: Record<string, ExtractorStatus> = { 'code.ts': 'PASS', data: 'FAIL' };

/** Everything a program can ask a view, asked of both, side by side. */
function assertSameAnswers(real: GraphView, copy: GraphView, ids: readonly string[]): void {
  for (const kind of NODE_KINDS)
    assert.deepEqual(copy.nodesByKind(kind), real.nodesByKind(kind), `nodesByKind ${kind}`);
  for (const id of ids) {
    assert.deepEqual(copy.node(id as never), real.node(id as never), `node ${id}`);
    assert.deepEqual(copy.edgesFrom(id as never), real.edgesFrom(id as never), `edgesFrom ${id}`);
    assert.deepEqual(copy.edgesTo(id as never), real.edgesTo(id as never), `edgesTo ${id}`);
    for (const kind of EDGE_KINDS as readonly EdgeKind[]) {
      assert.deepEqual(
        copy.edgesFrom(id as never, kind),
        real.edgesFrom(id as never, kind),
        `edgesFrom ${id} ${kind}`,
      );
      assert.deepEqual(
        copy.edgesTo(id as never, kind),
        real.edgesTo(id as never, kind),
        `edgesTo ${id} ${kind}`,
      );
    }
  }
}

describe('sandbox snapshot', () => {
  it('rebuilds a view that answers every query exactly as the original, in the same order', () => {
    const { nodes, edges } = fixture();
    const graph = memoryGraph({ nodes, edges, scopeStatus: SCOPES }).store;
    const copy = viewFromSnapshot(snapshotGraph(graph, ['code.ts', 'data']));
    assertSameAnswers(graph, copy, [
      ...nodes.map((n) => n.id),
      'demo:Column:public.posts.never-existed',
    ]);
    assert.equal(copy.scopeStatus('code.ts'), 'PASS');
    assert.equal(copy.scopeStatus('data'), 'FAIL');
  });

  it('survives the trip through JSON that the sandbox boundary imposes', () => {
    const { nodes, edges } = fixture();
    const graph = memoryGraph({ nodes, edges, scopeStatus: SCOPES }).store;
    const wire = JSON.parse(JSON.stringify(snapshotGraph(graph, ['code.ts']))) as ReturnType<
      typeof snapshotGraph
    >;
    assertSameAnswers(
      graph,
      viewFromSnapshot(wire),
      nodes.map((n) => n.id),
    );
  });

  it('answers UNAVAILABLE for a scope it was not told about, as a store does for one nobody declared', () => {
    const graph = memoryGraph({ scopeStatus: SCOPES }).store;
    const copy = viewFromSnapshot(snapshotGraph(graph, ['code.ts']));
    assert.equal(copy.scopeStatus('code.ts'), 'PASS');
    assert.equal(copy.scopeStatus('data'), 'UNAVAILABLE');
    assert.equal(copy.scopeStatus('never-declared'), 'UNAVAILABLE');
  });

  it('copies nothing the original does not return: a node the view hides stays hidden', () => {
    const { nodes, edges } = fixture();
    const graph = memoryGraph({ nodes, edges }).store;
    const hidden: GraphView = {
      ...graph,
      nodesByKind: (kind) => graph.nodesByKind(kind).filter((n) => !n.id.endsWith('gone')),
    };
    const copy = viewFromSnapshot(snapshotGraph(hidden, []));
    assert.ok(!copy.nodesByKind('Column').some((n) => n.id.endsWith('gone')));
  });
});
