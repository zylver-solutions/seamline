import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EdgeKind, GraphView, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { makeEdge, makeNode } from '../store/testing.ts';
import { bfs, IMPACT_EDGE_KINDS, neighbours } from './reachability.ts';

function memoryView(nodes: readonly SeamlineNode[], edges: readonly SeamlineEdge[]): GraphView {
  const byId = new Map<string, SeamlineNode>(nodes.map((n) => [n.id, n]));
  return {
    nodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    node: (id) => byId.get(id),
    edgesFrom: (id, kind) => edges.filter((e) => e.src === id && (kind === undefined || e.kind === kind)),
    edgesTo: (id, kind) => edges.filter((e) => e.dst === id && (kind === undefined || e.kind === kind)),
    scopeStatus: () => 'PASS',
  };
}

// a -CALLS-> b -CALLS-> c ; b -IMPORTS-> d
const a = makeNode({ name: 'a', kind: 'Symbol' });
const b = makeNode({ name: 'b', kind: 'Symbol' });
const c = makeNode({ name: 'c', kind: 'Symbol' });
const d = makeNode({ name: 'd', kind: 'Symbol' });

function chainGraph(): GraphView {
  return memoryView(
    [a, b, c, d],
    [
      makeEdge({ src: a.id, dst: b.id, kind: 'CALLS' }),
      makeEdge({ src: b.id, dst: c.id, kind: 'CALLS' }),
      makeEdge({ src: b.id, dst: d.id, kind: 'IMPORTS' }),
    ],
  );
}

test('neighbours returns both directions, sorted deterministically', () => {
  const view = chainGraph();
  const out = neighbours(view, b.id, ['CALLS', 'IMPORTS'], 'both');
  assert.deepEqual(
    out.map((n) => `${n.direction}:${n.edge.kind}:${n.node.id}`),
    [`out:CALLS:${c.id}`, `in:CALLS:${a.id}`, `out:IMPORTS:${d.id}`].sort(),
  );
});

test('neighbours honours a direction filter', () => {
  const view = chainGraph();
  const out = neighbours(view, b.id, ['CALLS'], 'out');
  assert.deepEqual(out.map((n) => n.node.id), [c.id]);
});

test('neighbours skips tombstoned edges and deleted nodes', () => {
  const deletedC = { ...c, deletedAt: '2026-01-01T00:00:00.000Z' };
  const view = memoryView(
    [a, b, deletedC, d],
    [
      makeEdge({ src: b.id, dst: deletedC.id, kind: 'CALLS' }),
      { ...makeEdge({ src: b.id, dst: d.id, kind: 'IMPORTS' }), deletedAt: '2026-01-01T00:00:00.000Z' },
    ],
  );
  const out = neighbours(view, b.id, ['CALLS', 'IMPORTS'], 'out');
  assert.deepEqual(out, []);
});

test('bfs walks breadth-first and excludes the roots from `reached`', () => {
  const view = chainGraph();
  const result = bfs(view, [a.id], ['CALLS', 'IMPORTS'] as readonly EdgeKind[], { maxDepth: 4, maxNodes: 100 });
  assert.deepEqual(
    result.reached.map((r) => r.node.id).sort(),
    [b.id, c.id, d.id].sort(),
  );
  assert.equal(result.state.truncated, false);
  const viaB = result.reached.find((r) => r.node.id === b.id);
  assert.equal(viaB?.depth, 1);
  const viaC = result.reached.find((r) => r.node.id === c.id);
  assert.equal(viaC?.depth, 2);
});

test('bfs reports a depth-cap truncation when there is more graph past the cap', () => {
  const view = chainGraph();
  const result = bfs(view, [a.id], ['CALLS', 'IMPORTS'] as readonly EdgeKind[], { maxDepth: 1, maxNodes: 100 });
  assert.deepEqual(result.reached.map((r) => r.node.id), [b.id]);
  assert.equal(result.state.truncated, true);
  if (result.state.truncated) assert.ok(result.state.reasons.includes('depth-cap'));
});

test('bfs reports a result-cap truncation when the node cap bites', () => {
  const view = chainGraph();
  const result = bfs(view, [a.id], ['CALLS', 'IMPORTS'] as readonly EdgeKind[], { maxDepth: 4, maxNodes: 1 });
  assert.equal(result.reached.length, 1);
  assert.equal(result.state.truncated, true);
  if (result.state.truncated) assert.ok(result.state.reasons.includes('result-cap'));
});

test('bfs dedupes and sorts the edges it returns', () => {
  const view = memoryView(
    [a, b],
    [makeEdge({ src: a.id, dst: b.id, kind: 'CALLS' }), makeEdge({ src: a.id, dst: b.id, kind: 'CALLS' })],
  );
  const result = bfs(view, [a.id], ['CALLS'] as readonly EdgeKind[], { maxDepth: 2, maxNodes: 10 });
  assert.equal(result.edges.length, 1);
});

test('IMPACT_EDGE_KINDS includes dependency and join edges used by blast-radius/impact', () => {
  for (const k of ['CALLS', 'IMPORTS', 'MAPS_TO_FIELD', 'FK_TO'] as const) {
    assert.ok(IMPACT_EDGE_KINDS.includes(k), `${k} is in IMPACT_EDGE_KINDS`);
  }
});
