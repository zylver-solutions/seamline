import assert from 'node:assert/strict';
import test from 'node:test';

import { nodeId } from '@seamline/ontology';
import type { Maybe, NodeId, SeamlineNode } from '@seamline/ontology';

import { SqliteStore } from './sqlite-store.ts';
import type { SqliteStoreOptions } from './sqlite-store.ts';
import {
  DEFAULT_TRAVERSE_LIMITS,
  TraversalBudgetExceededError,
  TraverseQueryError,
  createStepBudget,
  dependentNodeKinds,
  validateTraverseQuery,
} from './traverse.ts';
import {
  extractorResult,
  fileNode,
  fixedClock,
  importsEdge,
  makeEdge,
  makeNode,
  runRecord,
  scope,
} from './testing.ts';

const CODE_SCOPE = 'code.ts';
const file = (path: string): NodeId => nodeId('app', 'File', path);
const ids = (m: Maybe<ReadonlyArray<SeamlineNode>>): ReadonlyArray<string> => {
  assert.equal(m.known, true, m.known ? '' : `expected a known answer, got: ${m.reason}`);
  return m.known ? m.value.map((n) => n.name) : [];
};

function store(options: SqliteStoreOptions = {}): SqliteStore {
  return new SqliteStore({ ontologyVersion: '1.0.0', now: fixedClock(), ...options });
}

/** f0 -> f1 -> ... -> f(n-1), all in one PASSing scope. */
async function chain(s: SqliteStore, n: number): Promise<void> {
  const nodes = Array.from({ length: n }, (_, i) => fileNode(`src/f${i}.ts`));
  const edges = nodes.slice(0, -1).map((node, i) => importsEdge(node, nodes[i + 1] as SeamlineNode));
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', nodes);
  await s.upsertEdges('r1', CODE_SCOPE, edges);
  await s.finalizeRun('r1', [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])], {
      nodeCount: n,
      edgeCount: edges.length,
    }),
  ]);
}

test('traversal returns the nodes reached within maxDepth and no further', async () => {
  const s = store();
  await chain(s, 5);
  assert.deepEqual(
    ids(await s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 2 })),
    ['src/f1.ts', 'src/f2.ts'],
  );
  assert.deepEqual(
    ids(await s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 1 })),
    ['src/f1.ts'],
  );
  assert.deepEqual(
    ids(await s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 4 })),
    ['src/f1.ts', 'src/f2.ts', 'src/f3.ts', 'src/f4.ts'],
  );
  await s.close();
});

test('a maxDepth above the configured cap is rejected, not clamped', async () => {
  const s = store({ limits: { maxDepth: 2 } });
  await chain(s, 5);
  await assert.rejects(
    s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 3 }),
    (error: unknown) => {
      assert.ok(error instanceof TraverseQueryError);
      assert.match(error.message, /maxDepth 3 exceeds the configured cap of 2/);
      return true;
    },
  );
  // The cap itself still answers, so the rejection is about the cap and not the query.
  assert.deepEqual(
    ids(await s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 2 })),
    ['src/f1.ts', 'src/f2.ts'],
  );
  await s.close();
});

test('the result cap bounds the answer, and a limit above it is rejected', async () => {
  const s = store({ limits: { maxResults: 2 } });
  await chain(s, 6);
  const capped = await s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 5 });
  assert.deepEqual(ids(capped), ['src/f1.ts', 'src/f2.ts']);
  assert.deepEqual(
    ids(await s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 5, limit: 1 })),
    ['src/f1.ts'],
  );
  await assert.rejects(
    s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 5, limit: 3 }),
    /limit 3 exceeds the configured result cap of 2/,
  );
  await s.close();
});

test('a cyclic import graph terminates and reports each node at its shortest depth', async () => {
  const s = store();
  const a = fileNode('src/a.ts');
  const b = fileNode('src/b.ts');
  const c = fileNode('src/c.ts');
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [a, b, c]);
  await s.upsertEdges('r1', CODE_SCOPE, [importsEdge(a, b), importsEdge(b, c), importsEdge(c, a)]);
  await s.finalizeRun('r1', [extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])])]);

  // Without the UNION dedupe and the depth cap this walk does not come back.
  assert.deepEqual(
    ids(await s.traverse({ from: [a.id], via: ['IMPORTS'], maxDepth: DEFAULT_TRAVERSE_LIMITS.maxDepth })),
    ['src/b.ts', 'src/c.ts', 'src/a.ts'],
  );
  // A self-loop is the degenerate case of the same problem.
  await s.beginRun(runRecord('r2'));
  await s.upsertNodes('r2', [a, b, c]);
  await s.upsertEdges('r2', CODE_SCOPE, [
    importsEdge(a, b),
    importsEdge(b, c),
    importsEdge(c, a),
    importsEdge(a, a),
  ]);
  await s.finalizeRun('r2', [extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])])]);
  assert.deepEqual(ids(await s.traverse({ from: [a.id], via: ['IMPORTS'], maxDepth: 8 })), [
    'src/a.ts',
    'src/b.ts',
    'src/c.ts',
  ]);
  await s.close();
});

test('a traversal that outruns its step budget raises rather than returning a short answer', async () => {
  const s = store({ limits: { maxSteps: 3 } });
  await chain(s, 12);
  await assert.rejects(
    s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 8 }),
    (error: unknown) => {
      assert.ok(error instanceof TraversalBudgetExceededError);
      assert.match(error.message, /step budget of 3/);
      assert.ok(error.steps > 3);
      return true;
    },
  );
  await s.close();
});

test('a traversal that outruns its time budget raises', () => {
  // Exercises createStepBudget directly rather than through a real
  // SqliteStore.traverse() call. guard() is registered as the SQL function
  // the recursive CTE invokes per candidate row (sqlite-store.ts), and it is
  // deliberately registered non-deterministic so the query planner cannot
  // hoist it out of the loop -- which also means how many times it actually
  // fires for a given graph is up to that planner, not something a test can
  // pin down by graph size. Observed directly: the same chain/depth/budget
  // that reliably tripped the time check on one Node version's bundled
  // SQLite did not reach the check's every-512-steps sampling point on
  // another. The step-budget *wiring* (that traverse() calls guard() and
  // propagates what it throws) is already covered by 'a traversal that
  // outruns its step budget raises' above; this only needs to prove
  // createStepBudget's own time-check logic, with the guard-call count and
  // the clock both under the test's control.
  let now = 0;
  const budget = createStepBudget(() => now);
  budget.arm({ ...DEFAULT_TRAVERSE_LIMITS, maxSteps: 10_000_000, timeoutMs: 1 });
  now = 1000; // now() > deadline (arm()'s 0 + timeoutMs 1) for every check from here on
  assert.throws(() => {
    for (let i = 0; i < 512; i++) budget.guard();
  }, TraversalBudgetExceededError);
});

test('direction selects which way the edges are walked', async () => {
  const s = store();
  await chain(s, 5);
  const from = [file('src/f2.ts')];
  assert.deepEqual(ids(await s.traverse({ from, via: ['IMPORTS'], maxDepth: 2 })), [
    'src/f3.ts',
    'src/f4.ts',
  ]);
  assert.deepEqual(
    ids(await s.traverse({ from, via: ['IMPORTS'], direction: 'in', maxDepth: 2 })),
    ['src/f1.ts', 'src/f0.ts'],
  );
  assert.deepEqual(
    ids(await s.traverse({ from, via: ['IMPORTS'], direction: 'both', maxDepth: 1 })),
    ['src/f1.ts', 'src/f3.ts'],
  );
  await s.close();
});

test('toKinds filters the answer without truncating the walk', async () => {
  const s = store();
  const f0 = fileNode('src/f0.ts');
  const f1 = fileNode('src/f1.ts');
  const sym = makeNode({ name: 'src/f1.ts#handler', kind: 'Symbol', path: 'src/f1.ts' });
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [f0, f1, sym]);
  await s.upsertEdges('r1', CODE_SCOPE, [
    importsEdge(f0, f1),
    makeEdge({ src: f1.id, dst: sym.id, kind: 'CONTAINS' }),
  ]);
  await s.finalizeRun('r1', [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File', 'Symbol'])]),
  ]);

  assert.deepEqual(
    ids(await s.traverse({ from: [f0.id], via: ['IMPORTS', 'CONTAINS'], maxDepth: 2 })),
    ['src/f1.ts', 'src/f1.ts#handler'],
  );
  assert.deepEqual(
    ids(
      await s.traverse({
        from: [f0.id],
        via: ['IMPORTS', 'CONTAINS'],
        maxDepth: 2,
        toKinds: ['Symbol'],
      }),
    ),
    ['src/f1.ts#handler'],
    'the Symbol is two hops away, so the File hop is walked but not returned',
  );
  await s.close();
});

test('factsOnly refuses to route the answer through an inference', async () => {
  const s = store();
  const a = fileNode('src/a.ts');
  const b = fileNode('src/b.ts');
  const c = fileNode('src/c.ts');
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [a, b, c]);
  await s.upsertEdges('r1', CODE_SCOPE, [
    importsEdge(a, b),
    makeEdge({ src: b.id, dst: c.id, kind: 'IMPORTS', provenance: 'INFERRED', confidence: 0.4 }),
  ]);
  await s.finalizeRun('r1', [extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])])]);

  assert.deepEqual(ids(await s.traverse({ from: [a.id], via: ['IMPORTS'], maxDepth: 3 })), [
    'src/b.ts',
    'src/c.ts',
  ]);
  assert.deepEqual(
    ids(await s.traverse({ from: [a.id], via: ['IMPORTS'], maxDepth: 3, factsOnly: true })),
    ['src/b.ts'],
  );
  await s.close();
});

test('a traversal over a FAILed scope returns UNKNOWN, not an empty result', async () => {
  const s = store();
  await chain(s, 3);
  assert.deepEqual(ids(await s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 2 })), [
    'src/f1.ts',
    'src/f2.ts',
  ]);

  await s.beginRun(runRecord('r2'));
  await s.finalizeRun('r2', [
    extractorResult('ts', 'FAIL', [scope(CODE_SCOPE, ['File'])], {
      diagnostics: ['tsc crashed'],
    }),
  ]);

  const answer = await s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 2 });
  assert.equal(answer.known, false, 'a crashed extractor must not look like "no such edge"');
  if (!answer.known) {
    assert.deepEqual(answer.scopes, [CODE_SCOPE]);
    assert.match(answer.reason, /did not PASS/);
    assert.match(answer.reason, /code\.ts=FAIL/);
  }
  await s.close();
});

test('a traversal over an UNAVAILABLE scope returns UNKNOWN', async () => {
  const s = store();
  await chain(s, 3);
  await s.beginRun(runRecord('r2'));
  await s.finalizeRun('r2', [
    extractorResult('ts', 'UNAVAILABLE', [scope(CODE_SCOPE, ['File'])], {
      diagnostics: ['no toolchain on this host'],
    }),
  ]);
  const answer = await s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 2 });
  assert.equal(answer.known, false);
  if (!answer.known) assert.deepEqual(answer.scopes, [CODE_SCOPE]);
  await s.close();
});

test('a scope that failed on its first run, having written nothing, still yields UNKNOWN', async () => {
  // The data-independent half of the dependency rule. Asking only "which scopes
  // wrote an edge of this kind" would find none here and answer a confident,
  // wrong, empty result.
  const s = store();
  await s.beginRun(runRecord('r1'));
  await s.finalizeRun('r1', [
    extractorResult('ts', 'FAIL', [scope(CODE_SCOPE, ['File'])], {
      diagnostics: ['out of memory'],
    }),
  ]);
  const answer = await s.traverse({ from: [file('src/f0.ts')], via: ['IMPORTS'], maxDepth: 2 });
  assert.equal(answer.known, false);
  if (!answer.known) assert.deepEqual(answer.scopes, [CODE_SCOPE]);
  await s.close();
});

test('edges written under a scope no run ever declared are UNAVAILABLE, never PASS', async () => {
  const s = store();
  const a = fileNode('src/a.ts');
  const b = fileNode('src/b.ts');
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [a, b]);
  await s.upsertEdges('r1', 'ghost-scope', [importsEdge(a, b)]);
  await s.finalizeRun('r1', [extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])])]);

  const answer = await s.traverse({ from: [a.id], via: ['IMPORTS'], maxDepth: 1 });
  assert.equal(answer.known, false);
  if (!answer.known) assert.deepEqual(answer.scopes, ['ghost-scope']);
  await s.close();
});

test('a failure in an unrelated scope does not degrade the answer', async () => {
  const s = store();
  const a = fileNode('src/a.ts');
  const b = fileNode('src/b.ts');
  const orderUserId = makeNode({ name: 'public.orders.user_id', kind: 'Column' });
  const userId = makeNode({ name: 'public.users.id', kind: 'Column' });
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [a, b, orderUserId, userId]);
  await s.upsertEdges('r1', CODE_SCOPE, [importsEdge(a, b)]);
  await s.upsertEdges('r1', 'data.sql', [
    makeEdge({ src: orderUserId.id, dst: userId.id, kind: 'FK_TO' }),
  ]);
  await s.finalizeRun('r1', [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])]),
    extractorResult('sql', 'FAIL', [scope('data.sql', ['Table', 'Column'])]),
  ]);

  assert.equal(s.scopeStatus('data.sql'), 'FAIL');
  assert.deepEqual(ids(await s.traverse({ from: [a.id], via: ['IMPORTS'], maxDepth: 1 })), [
    'src/b.ts',
  ]);
  await s.close();
});

test('a traversal from a node that does not exist is known-empty, not unknown', async () => {
  const s = store();
  await chain(s, 3);
  const answer = await s.traverse({ from: [file('src/absent.ts')], via: ['IMPORTS'], maxDepth: 2 });
  assert.equal(answer.known, true);
  assert.deepEqual(answer.known ? answer.value : null, []);
  await s.close();
});

test('malformed queries are rejected at the boundary', async () => {
  const s = store();
  await chain(s, 3);
  const from = [file('src/f0.ts')];
  await assert.rejects(s.traverse({ from: [], via: ['IMPORTS'], maxDepth: 1 }), TraverseQueryError);
  await assert.rejects(s.traverse({ from, via: [], maxDepth: 1 }), /at least one edge kind/);
  await assert.rejects(
    s.traverse({ from, via: ['NOT_AN_EDGE' as 'IMPORTS'], maxDepth: 1 }),
    /unknown edge kind/,
  );
  await assert.rejects(s.traverse({ from, via: ['IMPORTS'], maxDepth: 0 }), /positive integer/);
  await assert.rejects(s.traverse({ from, via: ['IMPORTS'], maxDepth: 1.5 }), /positive integer/);
  await assert.rejects(
    s.traverse({ from, via: ['IMPORTS'], maxDepth: 1, toKinds: ['Nope' as 'File'] }),
    /unknown node kind/,
  );
  await assert.rejects(
    s.traverse({ from: ['not-an-id' as NodeId], via: ['IMPORTS'], maxDepth: 1 }),
    /malformed node id/,
  );
  await s.close();
});

test('validateTraverseQuery defaults direction and limit without widening them', () => {
  const q = validateTraverseQuery(
    { from: [file('src/a.ts')], via: ['IMPORTS'], maxDepth: 1 },
    DEFAULT_TRAVERSE_LIMITS,
  );
  assert.equal(q.direction, 'out');
  assert.equal(q.limit, DEFAULT_TRAVERSE_LIMITS.maxResults);
  assert.equal(q.factsOnly, false);
  assert.equal(q.toKinds, undefined);
});

test('dependentNodeKinds covers the declared domain and range of every edge walked', () => {
  const q = validateTraverseQuery(
    { from: [file('src/a.ts')], via: ['QUERIES'], maxDepth: 1 },
    DEFAULT_TRAVERSE_LIMITS,
  );
  const kinds = dependentNodeKinds(q);
  assert.equal(kinds.has('Symbol'), true);
  assert.equal(kinds.has('Table'), true, 'the range of QUERIES is a dependency of the answer');
  assert.equal(kinds.has('File'), true, 'so is the kind of the seed');
  assert.equal(kinds.has('Migration'), false);
});
