import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLineage, resolveTarget } from './lineage.ts';
import { makeEdge, makeNode, memoryGraph } from './testing.ts';

// ---------------------------------------------------------------------------
// Lineage order is a code-unit order, never a locale order (invariant 4): the
// chains are rendered, diffed, and asserted on, and `seamline why --json` is
// compared byte for byte.
//
// 'B' (0x42) < '_' (0x5F) < 'a' (0x61) by code unit. An en-US collation orders
// `_ a B`.
// ---------------------------------------------------------------------------

const OPTS = { maxDepth: 1, maxNodes: 100, maxChains: 100 } as const;

test('chains with equal length and confidence are ordered by code unit on their hop ids', () => {
  const column = makeNode({ kind: 'Column', canonicalName: 'public.users.email' });
  const fields = ['a', 'B', '_x'].map((canonicalName) =>
    makeNode({ kind: 'CodeField', canonicalName }),
  );
  const graph = memoryGraph({
    nodes: [column, ...fields],
    edges: fields.map((f) => makeEdge({ kind: 'MAPS_TO_FIELD', src: column.id, dst: f.id })),
  });

  const result = buildLineage(graph.store, column, OPTS);
  assert.deepEqual(
    result.chains.map((c) => c.hops.map((h) => h.to)),
    [['demo:CodeField:B'], ['demo:CodeField:_x'], ['demo:CodeField:a']],
  );
});

test('the chain cap keeps the code-unit-first chains', () => {
  const column = makeNode({ kind: 'Column', canonicalName: 'public.users.email' });
  const fields = ['a', 'B', '_x'].map((canonicalName) =>
    makeNode({ kind: 'CodeField', canonicalName }),
  );
  const graph = memoryGraph({
    nodes: [column, ...fields],
    edges: fields.map((f) => makeEdge({ kind: 'MAPS_TO_FIELD', src: column.id, dst: f.id })),
  });

  const result = buildLineage(graph.store, column, { ...OPTS, maxChains: 2 });
  assert.deepEqual(
    result.chains.map((c) => c.hops.map((h) => h.to)),
    [['demo:CodeField:B'], ['demo:CodeField:_x']],
  );
  assert.equal(result.truncated, true);
});

test('a target that matches several repos lists its candidates in code-unit order', () => {
  const nodes = ['a', 'B', '_r'].map((repo) =>
    makeNode({ repo, kind: 'Column', canonicalName: 'users.email' }),
  );
  const graph = memoryGraph({ nodes });

  const resolved = resolveTarget(graph.store, 'users.email');
  assert.equal(resolved.strategy, 'canonical-name');
  assert.deepEqual(
    resolved.matches.map((n) => n.id),
    ['B:Column:users.email', '_r:Column:users.email', 'a:Column:users.email'],
  );
});
