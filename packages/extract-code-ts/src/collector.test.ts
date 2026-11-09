import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidEdge, nodeId } from '@seamline/ontology';
import { Collector, sortProps } from './collector.ts';

function collector(): Collector {
  return new Collector({ runId: 'run-1', scope: 'code.ts', provenance: 'EXTRACTED' });
}

test('an edge outside its declared domain and range is not emitted', () => {
  const c = collector();
  const repo = c.node({ id: nodeId('r', 'Repo', 'r'), kind: 'Repo', name: 'r' });
  const symbol = c.node({ id: nodeId('r', 'Symbol', 'm#A'), kind: 'Symbol', name: 'A' });
  // CONTAINS is declared for Repo->File and Repo->Module, never Repo->Symbol.
  assert.equal(isValidEdge('CONTAINS', 'Repo', 'Symbol'), false);
  c.edge({ kind: 'CONTAINS', src: repo, dst: symbol });
  const out = c.finish();
  assert.equal(out.edges.length, 0);
  assert.deepEqual(out.rejectedEdges, ['invalid CONTAINS: Repo -> Symbol']);
});

test('an edge whose endpoint was never emitted is reported, not silently kept', () => {
  const c = collector();
  const file = c.node({ id: nodeId('r', 'File', 'src/a.ts'), kind: 'File', name: 'src/a.ts' });
  c.edge({ kind: 'EXPORTS', src: file, dst: nodeId('r', 'Symbol', 'm#Missing') });
  const out = c.finish();
  assert.equal(out.edges.length, 0);
  assert.equal(out.rejectedEdges.length, 1);
  assert.match(out.rejectedEdges[0] ?? '', /^dangling EXPORTS: dst /);
});

test('a cross-scope endpoint is signature-checked without claiming authority over it', () => {
  const c = collector();
  const symbol = c.node({ id: nodeId('r', 'Symbol', 'm#Svc'), kind: 'Symbol', name: 'Svc' });
  const table = c.external(nodeId('r', 'Table', 'public.users'), 'Table');
  c.edge({ kind: 'QUERIES', src: symbol, dst: table });
  const out = c.finish();
  assert.equal(out.edges.length, 1);
  assert.deepEqual(out.rejectedEdges, []);
  // The Table node itself is NOT emitted: extract-data owns that kind.
  assert.deepEqual(out.nodes.map((n) => n.kind), ['Symbol']);
});

test('output order is sorted, not insertion order', () => {
  const c = collector();
  for (const name of ['m#C', 'm#A', 'm#B']) {
    c.node({ id: nodeId('r', 'Symbol', name), kind: 'Symbol', name });
  }
  c.node({ id: nodeId('r', 'File', 'src/z.ts'), kind: 'File', name: 'src/z.ts' });
  const out = c.finish();
  assert.deepEqual(out.nodes.map((n) => n.name), ['src/z.ts', 'm#A', 'm#B', 'm#C']);
});

test('a repeated id merges declarations and keeps the smallest path, whatever the order', () => {
  const forward = collector();
  const back = collector();
  const id = nodeId('r', 'Symbol', 'm#Merged');
  for (const path of ['src/b.ts', 'src/a.ts']) {
    forward.node({ id, kind: 'Symbol', name: 'Merged', path, props: { [path]: true } });
  }
  for (const path of ['src/a.ts', 'src/b.ts']) {
    back.node({ id, kind: 'Symbol', name: 'Merged', path, props: { [path]: true } });
  }
  assert.equal(forward.finish().nodes[0]?.path, 'src/a.ts');
  assert.deepEqual(forward.finish().nodes[0]?.props, back.finish().nodes[0]?.props);
});

test('props are key-sorted so the serialized form does not depend on insertion order', () => {
  assert.deepEqual(Object.keys(sortProps({ z: 1, a: 2, m: 3 })), ['a', 'm', 'z']);
});
