import assert from 'node:assert/strict';
import test from 'node:test';

import { nodeId } from '@seamline/ontology';
import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';

import { memoryGraphIndex } from './memory-graph.ts';

function node(kind: SeamlineNode['kind'], name: string): SeamlineNode {
  return {
    id: nodeId('demo', kind, name),
    kind,
    name,
    sensitivity: 'internal',
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: 'run-1',
    lastSeenRun: 'run-1',
    deletedAt: null,
  };
}

function edge(kind: SeamlineEdge['kind'], src: SeamlineNode, dst: SeamlineNode): SeamlineEdge {
  return {
    kind,
    src: src.id,
    dst: dst.id,
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: 'run-1',
    lastSeenRun: 'run-1',
    deletedAt: null,
  };
}

test('nodesByKind returns only nodes of that kind, in insertion order', () => {
  const index = memoryGraphIndex();
  const a = node('File', 'a.ts');
  const b = node('Symbol', 'a.ts::A');
  const c = node('File', 'b.ts');
  index.addNode(a);
  index.addNode(b);
  index.addNode(c);
  assert.deepEqual(index.nodesByKind('File'), [a, c]);
  assert.deepEqual(index.nodesByKind('Symbol'), [b]);
  assert.deepEqual(index.nodesByKind('Table'), []);
});

test('addNode upserts an existing id in place, without reordering', () => {
  const index = memoryGraphIndex();
  const a = node('File', 'a.ts');
  const b = node('File', 'b.ts');
  index.addNode(a);
  index.addNode(b);
  const aUpdated = { ...a, confidence: 0.5 };
  index.addNode(aUpdated);
  assert.deepEqual(index.nodesByKind('File'), [aUpdated, b]);
  assert.equal(index.node(a.id), aUpdated);
  assert.equal(index.allNodes.length, 2);
});

test('edgesFrom/edgesTo index by endpoint and optionally filter by kind', () => {
  const index = memoryGraphIndex();
  const a = node('File', 'a.ts');
  const b = node('File', 'b.ts');
  const c = node('File', 'c.ts');
  index.addNode(a);
  index.addNode(b);
  index.addNode(c);
  const ab = edge('IMPORTS', a, b);
  const ac = edge('CALLS', a, c);
  index.addEdge(ab);
  index.addEdge(ac);

  assert.deepEqual(index.edgesFrom(a.id), [ab, ac]);
  assert.deepEqual(index.edgesFrom(a.id, 'IMPORTS'), [ab]);
  assert.deepEqual(index.edgesFrom(a.id, 'CALLS'), [ac]);
  assert.deepEqual(index.edgesFrom(b.id), []);
  assert.deepEqual(index.edgesTo(b.id), [ab]);
  assert.deepEqual(index.edgesTo(c.id, 'CALLS'), [ac]);
});

test('allNodes and allEdges expose everything added', () => {
  const index = memoryGraphIndex();
  const a = node('File', 'a.ts');
  const b = node('File', 'b.ts');
  index.addNode(a);
  index.addNode(b);
  const ab = edge('IMPORTS', a, b);
  index.addEdge(ab);
  assert.deepEqual(index.allNodes, [a, b]);
  assert.deepEqual(index.allEdges, [ab]);
});
