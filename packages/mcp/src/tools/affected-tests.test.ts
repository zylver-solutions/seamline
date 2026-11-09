import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIT_PROFILE,
  parseExportProfile,
  TEAM_PROFILE,
  type ExportProfile,
} from '@seamline/core';
import type {
  EdgeKind,
  ExtractorStatus,
  NodeKind,
  RunRecord,
  SeamlineEdge,
  SeamlineNode,
} from '@seamline/ontology';
import {
  codeField,
  column,
  createOrder,
  EDGES,
  NODES,
  postOrder,
  priceOrder,
  serviceFile,
  testCreates,
  testGuessed,
  testNamedOnly,
  testPosts,
  unrelated,
} from '../__fixtures__/orders-graph.ts';
import { BYTES_PER_TOKEN, estimateTokens, MIN_TOKEN_BUDGET } from '../budget.ts';
import type { Bounds } from '../ports.ts';
import type { ToolEnvelope } from '../result.ts';
import { createServer, toolResult } from '../server.ts';
import { fixedNonce, makeEdge, makeNode, makeResult, makeRun, memorySource } from '../testing.ts';

/** A run in which `code.ts` and a test scope both PASSed. The test scope declares `TestCase`. */
const TESTS_PASS: RunRecord = makeRun('run-1', [
  makeResult('extract-code-ts', 'PASS', ['code.ts'], [], ['File', 'Symbol']),
  makeResult('extract-tests', 'PASS', ['tests'], [], ['TestCase']),
]);

/** A run that extracted code and nothing about tests. */
const CODE_ONLY: RunRecord = makeRun('run-1', [
  makeResult('extract-code-ts', 'PASS', ['code.ts'], [], ['File', 'Symbol']),
]);

interface Opts {
  nodes?: readonly SeamlineNode[];
  edges?: readonly SeamlineEdge[];
  run?: RunRecord | undefined;
  scopeStatus?: Record<string, ExtractorStatus>;
  profile?: ExportProfile;
  bounds?: Partial<Bounds>;
}

function server(o: Opts = {}) {
  return createServer({
    profile: o.profile ?? AUDIT_PROFILE,
    graph: memorySource({
      nodes: o.nodes ?? NODES,
      edges: o.edges ?? EDGES,
      ...('run' in o ? (o.run === undefined ? {} : { run: o.run }) : { run: TESTS_PASS }),
      ...(o.scopeStatus === undefined ? {} : { scopeStatus: o.scopeStatus }),
    }),
    nonce: fixedNonce(),
    ...(o.bounds === undefined ? {} : { bounds: o.bounds }),
  });
}

async function call(
  srv: ReturnType<typeof server>,
  args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  const out = await srv.callTool('impact', { targets: 'tests', ...args });
  assert.ok(!('error' in out), `impact succeeded: ${JSON.stringify(out)}`);
  return out;
}

interface TestsResult {
  targets: string;
  answer: 'KNOWN' | 'UNKNOWN';
  testScopes: string[];
  roots: string[];
  missing: string[];
  depth: number;
  tests: Array<{
    test: { id: string };
    distance: number;
    path: { nodes: string[]; via: string[] };
  }>;
  edges: Array<{ kind: string; src: string; dst: string; provenance: string }>;
  nonFactLinksNotUsed: number;
  testsReturned?: number;
  testsTotal?: number;
  tokenBudget?: number;
  estimatedTokens?: number;
}

/** The bytes of the text a client reads for this response: what `tokenBudget` is measured on. */
const emittedBytes = (env: ToolEnvelope, bounds: Bounds): number =>
  Buffer.byteLength(
    (toolResult(env, bounds) as { content: Array<{ text: string }> }).content[0]?.text ?? '',
    'utf8',
  );

const resultOf = (env: ToolEnvelope): TestsResult => env.result as TestsResult;
const idsOf = (env: ToolEnvelope): string[] => resultOf(env).tests.map((t) => t.test.id);

// ---------------------------------------------------------------------------
// What is found, and why
// ---------------------------------------------------------------------------

test('a change reaches the tests of its callers: TESTS plus CALLS, nearest first, each with its path', async () => {
  const env = await call(server(), { ids: [priceOrder.id], depth: 2 });
  const r = resultOf(env);

  assert.equal(r.answer, 'KNOWN');
  assert.deepEqual(r.testScopes, ['tests']);
  assert.deepEqual(idsOf(env), [testCreates.id, testPosts.id]);
  assert.deepEqual(r.tests[0], {
    test: r.tests[0]?.test,
    distance: 2,
    path: { nodes: [priceOrder.id, createOrder.id, testCreates.id], via: ['CALLS', 'TESTS'] },
  });
  assert.equal(r.tests[1]?.distance, 3);
  assert.deepEqual(r.tests[1]?.path, {
    nodes: [priceOrder.id, createOrder.id, postOrder.id, testPosts.id],
    via: ['CALLS', 'CALLS', 'TESTS'],
  });
  assert.equal(env.truncated, false);

  // The edges in between are listed once, with the provenance that justifies them.
  assert.deepEqual(
    r.edges.map((e) => `${e.kind} ${e.src} -> ${e.dst} ${e.provenance}`),
    [
      `CALLS ${createOrder.id} -> ${priceOrder.id} EXTRACTED`,
      `CALLS ${postOrder.id} -> ${createOrder.id} EXTRACTED`,
      `TESTS ${testCreates.id} -> ${createOrder.id} EXTRACTED`,
      `TESTS ${testPosts.id} -> ${postOrder.id} EXTRACTED`,
    ].sort(),
  );
});

test('direction matters: a change to a caller does not reach the tests of what it calls', async () => {
  // postOrder calls createOrder, so testCreates exercises createOrder, which postOrder merely uses.
  const env = await call(server(), { ids: [postOrder.id], depth: 4 });
  assert.deepEqual(idsOf(env), [testPosts.id]);
});

test('a test directly on the changed symbol is at distance 1', async () => {
  const env = await call(server(), { ids: [createOrder.id], depth: 1 });
  const first = resultOf(env).tests[0];
  assert.equal(first?.test.id, testCreates.id);
  assert.equal(first?.distance, 1);
  assert.deepEqual(first?.path, { nodes: [createOrder.id, testCreates.id], via: ['TESTS'] });
});

test('depth bounds the dependency hops, and a walk that stopped at the cap says so', async () => {
  const env = await call(server(), { ids: [priceOrder.id], depth: 1 });
  assert.deepEqual(
    idsOf(env),
    [testCreates.id],
    'postOrder is two hops away and its test is not reached',
  );
  assert.equal(env.truncated, true);
  assert.ok((env.truncation as { reasons: string[] }).reasons.includes('depth-cap'));
  assert.match(env.notices.join('\n'), /TRUNCATED/);
});

test('an import path reaches tests: file imports file, the importing file contains the tested symbol', async () => {
  const lib = makeNode({ kind: 'File', canonicalName: 'src/lib.ts' });
  const app = makeNode({ kind: 'File', canonicalName: 'src/app.ts' });
  const main = makeNode({ kind: 'Symbol', canonicalName: 'main' });
  const spec = makeNode({ kind: 'TestCase', canonicalName: 'tests/app.test.ts::boots' });
  const fact = (kind: SeamlineEdge['kind'], src: SeamlineNode, dst: SeamlineNode) =>
    makeEdge({ kind, src: src.id, dst: dst.id, provenance: 'EXTRACTED', confidence: 1 });
  const srv = server({
    nodes: [lib, app, main, spec],
    edges: [fact('IMPORTS', app, lib), fact('CONTAINS', app, main), fact('TESTS', spec, main)],
  });

  const env = await call(srv, { ids: [lib.id], depth: 2 });
  assert.deepEqual(
    resultOf(env).tests.map((t) => t.path),
    [{ nodes: [lib.id, app.id, main.id, spec.id], via: ['IMPORTS', 'CONTAINS', 'TESTS'] }],
  );
  assert.equal(resultOf(env).tests[0]?.distance, 3);

  // And a changed file reaches the tests of the symbols it contains.
  const own = await call(srv, { ids: [app.id], depth: 1 });
  assert.deepEqual(
    resultOf(own).tests.map((t) => t.path.via),
    [['CONTAINS', 'TESTS']],
  );
});

test('a change to one symbol does not reach its siblings through the file that contains both', async () => {
  const file = makeNode({ kind: 'File', canonicalName: 'src/two.ts' });
  const a = makeNode({ kind: 'Symbol', canonicalName: 'a' });
  const b = makeNode({ kind: 'Symbol', canonicalName: 'b' });
  const spec = makeNode({ kind: 'TestCase', canonicalName: 'tests/two.test.ts::only b' });
  const fact = (kind: SeamlineEdge['kind'], src: SeamlineNode, dst: SeamlineNode) =>
    makeEdge({ kind, src: src.id, dst: dst.id, provenance: 'EXTRACTED', confidence: 1 });
  const srv = server({
    nodes: [file, a, b, spec],
    edges: [fact('CONTAINS', file, a), fact('CONTAINS', file, b), fact('TESTS', spec, b)],
  });

  const env = await call(srv, { ids: [a.id], depth: 4 });
  assert.deepEqual(idsOf(env), [], 'b is a sibling, not a dependent');
  assert.equal(resultOf(env).answer, 'KNOWN', 'and that is a real, known absence');
});

test('a join reaches tests across domains: a column to the model field that maps it, to the class that holds the field', async () => {
  const model = makeNode({ kind: 'Symbol', canonicalName: 'Order' });
  const field = makeNode({ kind: 'CodeField', canonicalName: 'Order.total' });
  const col = makeNode({ kind: 'Column', canonicalName: 'public.orders.total' });
  const spec = makeNode({ kind: 'TestCase', canonicalName: 'tests/order.test.ts::totals' });
  const link = (
    kind: SeamlineEdge['kind'],
    src: SeamlineNode,
    dst: SeamlineNode,
    provenance: SeamlineEdge['provenance'],
  ) => makeEdge({ kind, src: src.id, dst: dst.id, provenance, confidence: 1 });
  const nodes = [model, field, col, spec];

  const declared = server({
    nodes,
    edges: [
      link('MAPS_TO_FIELD', col, field, 'DECLARED'),
      link('CONTAINS', model, field, 'EXTRACTED'),
      link('TESTS', spec, model, 'EXTRACTED'),
    ],
  });
  const env = await call(declared, { ids: [col.id], depth: 3 });
  assert.deepEqual(
    resultOf(env).tests.map((t) => t.path.via),
    [['MAPS_TO_FIELD', 'CONTAINS', 'TESTS']],
  );

  // The same shape with the join merely INFERRED is not a justification.
  const guessed = server({
    nodes,
    edges: [
      link('MAPS_TO_FIELD', col, field, 'INFERRED'),
      link('CONTAINS', model, field, 'EXTRACTED'),
      link('TESTS', spec, model, 'EXTRACTED'),
    ],
  });
  const none = await call(guessed, { ids: [col.id], depth: 3 });
  assert.deepEqual(idsOf(none), []);
  assert.equal(resultOf(none).nonFactLinksNotUsed, 1, 'the guess is counted, not used');
});

// ---------------------------------------------------------------------------
// Facts only
// ---------------------------------------------------------------------------

test('an INFERRED TESTS edge never justifies a test', async () => {
  // testGuessed -> priceOrder is INFERRED; the changed symbol is priceOrder itself.
  const env = await call(server(), { ids: [priceOrder.id], depth: 1 });
  assert.ok(!idsOf(env).includes(testGuessed.id));
  assert.equal(
    resultOf(env).nonFactLinksNotUsed,
    1,
    'it is counted so the agent knows a guess exists',
  );
  assert.match(env.notices.join('\n'), /1 INFERRED or LLM_SUGGESTED link\(s\).*not used/);
});

test('an INFERRED link in the middle of a path breaks it, and an LLM_SUGGESTED test node is not a test', async () => {
  const callee = makeNode({ kind: 'Symbol', canonicalName: 'callee' });
  const caller = makeNode({ kind: 'Symbol', canonicalName: 'caller' });
  const solid = makeNode({ kind: 'TestCase', canonicalName: 'tests/x.test.ts::solid' });
  const fact = (kind: SeamlineEdge['kind'], src: SeamlineNode, dst: SeamlineNode) =>
    makeEdge({ kind, src: src.id, dst: dst.id, provenance: 'EXTRACTED', confidence: 1 });

  // caller CALLS callee only by inference.
  const midGuess = server({
    nodes: [callee, caller, solid],
    edges: [
      makeEdge({
        kind: 'CALLS',
        src: caller.id,
        dst: callee.id,
        provenance: 'INFERRED',
        confidence: 0.99,
      }),
      fact('TESTS', solid, caller),
    ],
  });
  const a = await call(midGuess, { ids: [callee.id], depth: 3 });
  assert.deepEqual(idsOf(a), []);
  assert.equal(resultOf(a).answer, 'KNOWN');

  // The TESTS edge is a fact but the test node itself was only suggested.
  const suggested = makeNode({
    kind: 'TestCase',
    canonicalName: 'tests/x.test.ts::suggested',
    provenance: 'LLM_SUGGESTED',
    confidence: 0.4,
  });
  const nodeGuess = server({
    nodes: [callee, suggested],
    edges: [fact('TESTS', suggested, callee)],
  });
  const b = await call(nodeGuess, { ids: [callee.id], depth: 1 });
  assert.deepEqual(idsOf(b), []);
});

test('a test is never inferred from its name', async () => {
  assert.match(testNamedOnly.id, /createOrder/, 'the fixture test is named after the symbol');
  for (const depth of [1, 2, 4]) {
    const env = await call(server(), { ids: [createOrder.id], depth });
    assert.ok(!idsOf(env).includes(testNamedOnly.id), `depth ${depth}`);
  }
});

test('a tombstoned test, and a test whose only link is tombstoned, are not affected tests', async () => {
  const gone = makeNode({
    kind: 'TestCase',
    canonicalName: 'tests/gone.test.ts::removed',
    deletedAt: '2026-01-01T00:00:00.000Z',
  });
  const orphan = makeNode({ kind: 'TestCase', canonicalName: 'tests/orphan.test.ts::unlinked' });
  const edges = [
    ...EDGES,
    makeEdge({
      kind: 'TESTS',
      src: gone.id,
      dst: createOrder.id,
      provenance: 'EXTRACTED',
      confidence: 1,
    }),
    makeEdge({
      kind: 'TESTS',
      src: orphan.id,
      dst: createOrder.id,
      provenance: 'EXTRACTED',
      confidence: 1,
      deletedAt: '2026-01-01T00:00:00.000Z',
    }),
  ];
  const env = await call(server({ nodes: [...NODES, gone, orphan], edges }), {
    ids: [createOrder.id],
    depth: 1,
  });
  assert.deepEqual(
    idsOf(env),
    [testCreates.id, testPosts.id],
    'only the live tests with live links',
  );
});

// ---------------------------------------------------------------------------
// UNKNOWN is not "no tests"
// ---------------------------------------------------------------------------

test('when no scope produced test facts the answer is UNKNOWN, with a scope and a notice, not an empty list', async () => {
  // The graph holds TESTS edges, but no PASS scope in the run vouches for TestCase facts.
  const env = await call(server({ run: CODE_ONLY }), { ids: [createOrder.id], depth: 2 });
  const r = resultOf(env);

  assert.equal(r.answer, 'UNKNOWN');
  assert.deepEqual(r.tests, []);
  assert.deepEqual(r.testScopes, []);
  assert.deepEqual(env.unknown, [
    { scope: 'tests', status: 'UNAVAILABLE', extractor: 'none declared', diagnostics: [] },
  ]);
  const notices = env.notices.join('\n');
  assert.match(notices, /UNKNOWN: no test facts were extracted/);
  assert.match(notices, /This is not "no affected tests"/);
  assert.match(notices, /EMPTY RESULT WITH DEGRADED SCOPES/);
});

test('with no run record at all the answer is UNKNOWN too', async () => {
  const env = await call(server({ run: undefined }), { ids: [createOrder.id] });
  assert.equal(resultOf(env).answer, 'UNKNOWN');
  assert.deepEqual(resultOf(env).tests, []);
  assert.equal(env.unknown[0]?.scope, 'tests');
});

test('the UNKNOWN reaches the text an agent reads', async () => {
  const line = await server({ run: CODE_ONLY }).handle(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'impact', arguments: { ids: [createOrder.id], targets: 'tests' } },
    }),
  );
  const text =
    (JSON.parse(line ?? '{}') as { result: { content: Array<{ text: string }> } }).result.content[0]
      ?.text ?? '';
  assert.match(text, /UNKNOWN SCOPES \(1\): tests=UNAVAILABLE/);
  assert.match(text, /no test facts were extracted/);
  assert.match(text, /"answer": "UNKNOWN"/);
});

for (const status of ['FAIL', 'UNAVAILABLE'] as const) {
  test(`a test scope that ended ${status} makes an empty answer UNKNOWN, not "no tests"`, async () => {
    const run = makeRun('run-1', [
      makeResult('extract-code-ts', 'PASS', ['code.ts'], [], ['File', 'Symbol']),
      makeResult(
        'extract-tests',
        status,
        ['tests'],
        ['could not read the test files'],
        ['TestCase'],
      ),
    ]);
    const nodes = NODES.filter((n) => n.kind !== 'TestCase');
    const edges = EDGES.filter((e) => e.kind !== 'TESTS');
    const env = await call(server({ run, scopeStatus: { tests: status }, nodes, edges }), {
      ids: [createOrder.id],
    });
    const r = resultOf(env);

    assert.equal(r.answer, 'UNKNOWN');
    assert.deepEqual(r.tests, []);
    assert.deepEqual(
      env.unknown.map((u) => `${u.scope}=${u.status}`),
      [`tests=${status}`],
    );
    assert.match(env.notices.join('\n'), /a scope that produces test facts did not PASS \(tests\)/);
    assert.match(env.notices.join('\n'), /EMPTY RESULT WITH DEGRADED SCOPES/);
  });
}

test('a degraded test scope still lists the tests facts justify, but never calls the list complete', async () => {
  const run = makeRun('run-1', [
    makeResult('extract-code-ts', 'PASS', ['code.ts'], [], ['File', 'Symbol']),
    makeResult('extract-tests', 'FAIL', ['tests'], [], ['TestCase']),
  ]);
  const env = await call(server({ run, scopeStatus: { tests: 'FAIL' } }), {
    ids: [createOrder.id],
    depth: 1,
  });
  assert.deepEqual(idsOf(env), [testCreates.id, testPosts.id]);
  assert.equal(resultOf(env).answer, 'UNKNOWN');
  assert.match(env.notices.join('\n'), /may be incomplete or stale/);
});

test('when every test scope PASSed, an empty answer is a known "none reach this"', async () => {
  const env = await call(server(), { ids: [unrelated.id], depth: 3 });
  assert.equal(resultOf(env).answer, 'KNOWN');
  assert.deepEqual(resultOf(env).tests, []);
  assert.deepEqual(env.unknown, []);
  assert.match(
    env.notices.join('\n'),
    /No test case reaches these ids over fact-justified paths within 3 dependency hop/,
  );
});

/**
 * `TEAM_PROFILE` with some node kinds and edge kinds no longer released. A
 * profile may only give props to a kind it admits, so the narrowed copy is built
 * through the one parser with `allowProps` and `allowEdgeProps` pruned to the
 * kinds that remain; spreading and filtering `allow` alone is refused.
 */
function teamWithout(dropped: {
  nodeKinds?: readonly NodeKind[];
  edgeKinds?: readonly EdgeKind[];
}): ExportProfile {
  const nodeKinds = dropped.nodeKinds ?? [];
  const edgeKinds = dropped.edgeKinds ?? [];
  const allow = TEAM_PROFILE.allow.filter(([kind]) => !nodeKinds.includes(kind));
  const allowEdges = TEAM_PROFILE.allowEdges.filter((k) => !edgeKinds.includes(k));
  const keep = new Set<string>(allow.map(([kind]) => kind));
  const keepEdge = new Set<string>(allowEdges);
  return parseExportProfile({
    ...TEAM_PROFILE,
    name: 'team-narrowed',
    allow,
    allowEdges,
    allowProps: Object.fromEntries(
      Object.entries(TEAM_PROFILE.allowProps).filter(([kind]) => keep.has(kind)),
    ),
    allowEdgeProps: Object.fromEntries(
      Object.entries(TEAM_PROFILE.allowEdgeProps).filter(([kind]) => keepEdge.has(kind)),
    ),
  });
}

test('a profile that does not release tests makes the answer UNKNOWN rather than "none"', async () => {
  const noTests = teamWithout({ nodeKinds: ['TestCase'] });
  const env = await call(server({ profile: noTests }), { ids: [createOrder.id], depth: 2 });
  assert.equal(resultOf(env).answer, 'UNKNOWN');
  assert.deepEqual(resultOf(env).tests, []);
  assert.match(
    env.notices.join('\n'),
    /export profile in force does not release TestCase nodes and TESTS edges/,
  );

  const noEdge = teamWithout({ edgeKinds: ['TESTS'] });
  const env2 = await call(server({ profile: noEdge }), { ids: [createOrder.id], depth: 2 });
  assert.equal(resultOf(env2).answer, 'UNKNOWN');
});

test('ids that do not resolve are reported and the answer is UNKNOWN', async () => {
  const env = await call(server(), { ids: ['demo:Symbol:ghost'] });
  assert.equal(resultOf(env).answer, 'UNKNOWN');
  assert.deepEqual(resultOf(env).missing, ['demo:Symbol:ghost']);
  assert.match(env.notices.join('\n'), /None of the 1 id\(s\) resolved/);
});

// ---------------------------------------------------------------------------
// Bounds, budget, determinism
// ---------------------------------------------------------------------------

test('targets accepts nodes or tests and nothing else', async () => {
  const out = await server().callTool('impact', { ids: [createOrder.id], targets: 'everything' });
  assert.ok('error' in out);
  assert.match(out.details.join('\n'), /`targets` must be one of: nodes, tests/);
});

function manyTests(count: number) {
  const target = makeNode({ kind: 'Symbol', canonicalName: 'hot' });
  const tests = Array.from({ length: count }, (_, i) =>
    makeNode({
      kind: 'TestCase',
      canonicalName: `tests/hot.test.ts::case ${String(i).padStart(3, '0')}`,
      props: { note: 'x'.repeat(60) },
    }),
  );
  const edges = tests.map((t) =>
    makeEdge({ kind: 'TESTS', src: t.id, dst: target.id, provenance: 'EXTRACTED', confidence: 1 }),
  );
  return { target, tests, nodes: [target, ...tests], edges };
}

test('the result cap bounds the number of tests and reports the true total', async () => {
  const { target, nodes, edges } = manyTests(30);
  const env = await call(server({ nodes, edges, bounds: { maxResults: 10 } }), {
    ids: [target.id],
    depth: 1,
  });
  assert.equal(resultOf(env).tests.length, 10);
  assert.equal(env.truncated, true);
  const t = env.truncation as { reasons: string[]; total: number };
  assert.ok(t.reasons.includes('result-cap'));
  assert.equal(t.total, 30);
});

test('a token budget keeps the nearest tests first, then by id, and reports that it cut', async () => {
  const { target, tests, nodes, edges } = manyTests(40);
  const srv = server({ nodes, edges });
  const sorted = tests.map((t) => t.id).sort();

  const env = await call(srv, { ids: [target.id], depth: 1, tokenBudget: 1500 });
  const r = resultOf(env);
  const ids = r.tests.map((t) => t.test.id);
  assert.ok(ids.length > 0 && ids.length < 40);
  assert.deepEqual(ids, sorted.slice(0, ids.length), 'a prefix of the id order');
  assert.equal(env.truncated, true);
  assert.ok((env.truncation as { reasons: string[] }).reasons.includes('token-budget'));
  assert.equal(r.tokenBudget, 1500);
  assert.ok((r.estimatedTokens ?? Infinity) <= 1500);
  assert.equal(r.estimatedTokens, estimateTokens(emittedBytes(env, srv.bounds)));
  assert.equal(
    r.answer,
    'KNOWN',
    'a cut list is still a known answer; the truncation says what is missing',
  );
});

test('a token budget on an UNKNOWN answer still reports the budget and stays UNKNOWN', async () => {
  const env = await call(server({ run: CODE_ONLY }), {
    ids: [createOrder.id],
    tokenBudget: MIN_TOKEN_BUDGET,
  });
  assert.equal(resultOf(env).answer, 'UNKNOWN');
  assert.equal(resultOf(env).tokenBudget, MIN_TOKEN_BUDGET);
  assert.equal(env.unknown[0]?.scope, 'tests');
});

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

test('affected tests do not depend on the order nodes, edges or ids arrive in', async () => {
  const askings: Array<Record<string, unknown>> = [
    { ids: [priceOrder.id, serviceFile.id, column.id, codeField.id], depth: 3 },
    { ids: [priceOrder.id], depth: 2 },
    { ids: [serviceFile.id], depth: 3, tokenBudget: 700 },
  ];
  const expected = await Promise.all(
    askings.map(async (a) => JSON.stringify(await call(server(), a))),
  );

  for (const seed of [1, 2, 3, 4, 5]) {
    const srv = server({ nodes: shuffled(NODES, seed), edges: shuffled(EDGES, seed * 7) });
    for (const [i, asking] of askings.entries()) {
      const ids = asking['ids'] as string[];
      const reordered = { ...asking, ids: shuffled(ids, seed * 13) };
      assert.equal(
        JSON.stringify(await call(srv, reordered)),
        expected[i],
        `seed ${seed}: ${JSON.stringify(asking)}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The answer is KNOWN only when the whole walk is
// ---------------------------------------------------------------------------

/** The code extractor failed; the test extractor PASSed. The CALLS and IMPORTS edges the first one would have produced may be missing. */
const CODE_FAIL: RunRecord = makeRun('run-1', [
  makeResult('extract-code-ts', 'FAIL', ['code.ts'], ['parse error'], ['File', 'Symbol']),
  makeResult('extract-tests', 'PASS', ['tests'], [], ['TestCase']),
]);

const fact = (kind: SeamlineEdge['kind'], src: SeamlineNode, dst: SeamlineNode) =>
  makeEdge({ kind, src: src.id, dst: dst.id, provenance: 'EXTRACTED', confidence: 1 });

function chain() {
  const callee = makeNode({ kind: 'Symbol', canonicalName: 'callee' });
  const caller = makeNode({ kind: 'Symbol', canonicalName: 'caller' });
  const spec = makeNode({ kind: 'TestCase', canonicalName: 'tests/caller.test.ts::runs' });
  return { callee, caller, spec, nodes: [callee, caller, spec] };
}

test('a failed code scope makes an empty answer UNKNOWN even though every test scope PASSed', async () => {
  const { callee, caller, spec, nodes } = chain();
  // `caller CALLS callee` is the edge the failed extractor would have emitted; it is absent.
  const env = await call(
    server({
      nodes,
      edges: [fact('TESTS', spec, caller)],
      run: CODE_FAIL,
      scopeStatus: { 'code.ts': 'FAIL' },
    }),
    { ids: [callee.id], depth: 2 },
  );
  const r = resultOf(env);

  assert.equal(r.answer, 'UNKNOWN', 'the edges this walk crosses come from a scope that FAILed');
  assert.deepEqual(r.tests, []);
  assert.deepEqual(
    env.unknown.map((u) => `${u.scope}=${u.status}`),
    ['code.ts=FAIL'],
  );
  const notices = env.notices.join('\n');
  assert.match(notices, /did not PASS \(code\.ts\)/);
  assert.match(notices, /not "no affected tests"/);
  assert.doesNotMatch(
    notices,
    /No test case reaches/,
    'the negative notice is never stated next to an UNKNOWN',
  );
});

test('a failed scope that declares no node kinds cannot be ruled out, so it makes the answer UNKNOWN too', async () => {
  const { callee, caller, spec, nodes } = chain();
  const run = makeRun('run-1', [
    makeResult('extract-code-ts', 'FAIL', ['code.ts']),
    makeResult('extract-tests', 'PASS', ['tests'], [], ['TestCase']),
  ]);
  const env = await call(
    server({
      nodes,
      edges: [fact('TESTS', spec, caller)],
      run,
      scopeStatus: { 'code.ts': 'FAIL' },
    }),
    { ids: [callee.id], depth: 2 },
  );
  assert.equal(resultOf(env).answer, 'UNKNOWN');
});

test('a failed scope whose kinds no walked edge touches does not turn a known absence into UNKNOWN', async () => {
  const { callee, caller, spec, nodes } = chain();
  const run = makeRun('run-1', [
    makeResult('extract-code-ts', 'PASS', ['code.ts'], [], ['File', 'Symbol']),
    makeResult('extract-tests', 'PASS', ['tests'], [], ['TestCase']),
    makeResult('extract-change', 'FAIL', ['history'], ['no git'], ['Commit', 'Changeset']),
  ]);
  const env = await call(
    server({
      nodes,
      edges: [fact('CALLS', caller, callee), fact('TESTS', spec, caller)],
      run,
      scopeStatus: { history: 'FAIL' },
    }),
    { ids: [callee.id], depth: 2 },
  );
  assert.equal(resultOf(env).answer, 'KNOWN');
  assert.deepEqual(idsOf(env), [spec.id]);
  assert.deepEqual(
    env.unknown.map((u) => u.scope),
    ['history'],
    'it is still reported in the envelope',
  );
});

test('a degraded code scope still lists the tests that facts justify, but never calls the list complete', async () => {
  const { callee, spec, nodes } = chain();
  const env = await call(
    server({
      nodes,
      edges: [fact('TESTS', spec, callee)],
      run: CODE_FAIL,
      scopeStatus: { 'code.ts': 'FAIL' },
    }),
    { ids: [callee.id], depth: 1 },
  );
  assert.deepEqual(idsOf(env), [spec.id]);
  assert.equal(resultOf(env).answer, 'UNKNOWN');
});

test('ids that were not assessed make the answer UNKNOWN, while the ids that were assessed still report', async () => {
  const env = await call(server(), { ids: [createOrder.id, 'demo:Symbol:Nope'], depth: 1 });
  const r = resultOf(env);
  assert.deepEqual(idsOf(env), [testCreates.id, testPosts.id]);
  assert.deepEqual(r.missing, ['demo:Symbol:Nope']);
  assert.equal(r.answer, 'UNKNOWN', 'a requested id was never assessed');
  assert.match(env.notices.join('\n'), /not assessed/);
});

test('a root that is not a fact is not assessed: it is reported as missing and the answer is UNKNOWN', async () => {
  const guessed = makeNode({ kind: 'Symbol', canonicalName: 'guessed', provenance: 'INFERRED' });
  const solid = makeNode({ kind: 'Symbol', canonicalName: 'solid' });
  const specGuessed = makeNode({ kind: 'TestCase', canonicalName: 'tests/g.test.ts::g' });
  const specSolid = makeNode({ kind: 'TestCase', canonicalName: 'tests/s.test.ts::s' });
  const srv = server({
    nodes: [guessed, solid, specGuessed, specSolid],
    edges: [fact('TESTS', specGuessed, guessed), fact('TESTS', specSolid, solid)],
  });

  const only = await call(srv, { ids: [guessed.id] });
  assert.deepEqual(idsOf(only), [], 'an INFERRED node is not a starting point');
  assert.deepEqual(resultOf(only).roots, []);
  assert.deepEqual(resultOf(only).missing, [guessed.id]);
  assert.equal(resultOf(only).answer, 'UNKNOWN');
  assert.match(only.notices.join('\n'), /INFERRED or LLM_SUGGESTED.*not assessed/);

  const both = await call(srv, { ids: [guessed.id, solid.id] });
  assert.deepEqual(idsOf(both), [specSolid.id]);
  assert.deepEqual(resultOf(both).roots, [solid.id]);
  assert.deepEqual(resultOf(both).missing, [guessed.id]);
  assert.equal(resultOf(both).answer, 'UNKNOWN');
});

test('a walk that stopped at the depth cap or the node cap is UNKNOWN: more dependents lie beyond it', async () => {
  const callee = makeNode({ kind: 'Symbol', canonicalName: 'callee' });
  const caller = makeNode({ kind: 'Symbol', canonicalName: 'caller' });
  const outer = makeNode({ kind: 'Symbol', canonicalName: 'outer' });
  const spec = makeNode({ kind: 'TestCase', canonicalName: 'tests/outer.test.ts::runs' });
  const deep = server({
    nodes: [callee, caller, outer, spec],
    edges: [
      fact('CALLS', caller, callee),
      fact('CALLS', outer, caller),
      fact('TESTS', spec, outer),
    ],
  });
  const shallow = await call(deep, { ids: [callee.id], depth: 1 });
  assert.deepEqual(idsOf(shallow), []);
  assert.equal(shallow.truncated, true);
  assert.equal(resultOf(shallow).answer, 'UNKNOWN', 'depth-cap');
  assert.match(shallow.notices.join('\n'), /stopped at its depth cap.*Raise `depth`/);
  assert.doesNotMatch(shallow.notices.join('\n'), /node cap/, 'it names the cap that bit');
  assert.doesNotMatch(shallow.notices.join('\n'), /No test case reaches/);

  const enough = await call(deep, { ids: [callee.id], depth: 3 });
  assert.deepEqual(idsOf(enough), [spec.id]);
  assert.equal(resultOf(enough).answer, 'KNOWN');

  // Node cap: ten callers and a result cap of three.
  const target = makeNode({ kind: 'Symbol', canonicalName: 'target' });
  const callers = Array.from({ length: 10 }, (_, i) =>
    makeNode({ kind: 'Symbol', canonicalName: `c${i}` }),
  );
  const wide = server({
    nodes: [target, ...callers],
    edges: callers.map((c) => fact('CALLS', c, target)),
    bounds: { maxResults: 3 },
  });
  const capped = await call(wide, { ids: [target.id], depth: 1 });
  assert.equal(resultOf(capped).answer, 'UNKNOWN', 'result-cap on the walk');
  const capNotices = capped.notices.join('\n');
  assert.match(capNotices, /stopped at its node cap \(3 nodes\)/);
  assert.doesNotMatch(capNotices, /Raise `depth`/, 'raising depth would not help a node cap');
  assert.doesNotMatch(capNotices, /depth cap/);
});

test('a list cut after a complete walk keeps its answer: the truncation carries the true total', async () => {
  const { target, nodes, edges } = manyTests(30);
  const cut = await call(server({ nodes, edges, bounds: { maxResults: 10 } }), {
    ids: [target.id],
    depth: 1,
  });
  assert.equal(cut.truncated, true);
  assert.equal(resultOf(cut).answer, 'KNOWN');
  assert.equal((cut.truncation as { total: number }).total, 30);
  // A reader of `result` alone sees the partiality next to the answer.
  assert.equal(resultOf(cut).testsReturned, 10);
  assert.equal(resultOf(cut).testsTotal, 30);

  const whole = await call(server({ nodes, edges }), { ids: [target.id], depth: 1 });
  assert.equal(resultOf(whole).tests.length, 30);
  assert.ok(!('testsReturned' in resultOf(whole)), 'not echoed when nothing was cut');
  assert.ok(!('testsTotal' in resultOf(whole)));
});

test('a list cut by a token budget echoes how many tests were kept of how many were found', async () => {
  const { target, nodes, edges } = manyTests(40);
  const env = await call(server({ nodes, edges }), {
    ids: [target.id],
    depth: 1,
    tokenBudget: 1500,
  });
  const r = resultOf(env);
  assert.ok(r.tests.length > 0 && r.tests.length < 40);
  assert.equal(r.testsReturned, r.tests.length);
  assert.equal(r.testsTotal, 40);
});

// ---------------------------------------------------------------------------
// The walked edge kinds agree with the nodes mode
// ---------------------------------------------------------------------------

function routeFixture() {
  const op = makeNode({ kind: 'Operation', canonicalName: 'POST /orders' });
  const route = makeNode({ kind: 'RouteHandler', canonicalName: 'POST /orders' });
  const handler = makeNode({ kind: 'Symbol', canonicalName: 'postOrder' });
  const spec = makeNode({
    kind: 'TestCase',
    canonicalName: 'tests/orders.test.ts::posts an order',
  });
  return {
    op,
    route,
    handler,
    spec,
    nodes: [op, route, handler, spec],
    edges: [
      fact('IMPLEMENTED_BY', op, route),
      fact('HANDLES_ROUTE', handler, route),
      fact('TESTS', spec, handler),
    ],
  };
}

test('an operation reaches the tests of the handler that implements it: contract to handler to test', async () => {
  const { op, spec, nodes, edges } = routeFixture();
  const env = await call(server({ nodes, edges }), { ids: [op.id], depth: 3 });
  assert.equal(resultOf(env).answer, 'KNOWN');
  assert.deepEqual(
    resultOf(env).tests.map((t) => ({ id: t.test.id, via: t.path.via, distance: t.distance })),
    [{ id: spec.id, via: ['IMPLEMENTED_BY', 'HANDLES_ROUTE', 'TESTS'], distance: 3 }],
  );
});

test('nodes mode and tests mode agree on the contract-to-handler-to-test fixture', async () => {
  const { op, spec, nodes, edges } = routeFixture();
  const srv = server({ nodes, edges });

  const reach = await srv.callTool('impact', { ids: [op.id], depth: 3 });
  assert.ok(!('error' in reach));
  const reached = (reach.result as { reached: Array<{ node: { id: string; kind: string } }> })
    .reached;
  assert.ok(
    reached.some((r) => r.node.id === spec.id),
    'nodes mode reaches the TestCase over fact edges',
  );
  const viaTests = await call(srv, { ids: [op.id], depth: 3 });
  assert.deepEqual(
    idsOf(viaTests),
    reached.filter((r) => r.node.kind === 'TestCase').map((r) => r.node.id),
    'and tests mode returns the same TestCase',
  );
});

test('the contract and domain containment pairs are crossed', async () => {
  const { op, spec, nodes, edges } = routeFixture();
  const contract = makeNode({ kind: 'Contract', canonicalName: 'orders-api' });
  const entity = makeNode({ kind: 'Entity', canonicalName: 'Order' });
  const prop = makeNode({ kind: 'DomainProperty', canonicalName: 'Order.total' });
  const col = makeNode({ kind: 'Column', canonicalName: 'public.orders.total' });
  const model = makeNode({ kind: 'Symbol', canonicalName: 'OrderModel' });
  const field = makeNode({ kind: 'CodeField', canonicalName: 'OrderModel.total' });
  const modelSpec = makeNode({ kind: 'TestCase', canonicalName: 'tests/model.test.ts::totals' });
  const srv = server({
    nodes: [...nodes, contract, entity, prop, col, model, field, modelSpec],
    edges: [
      ...edges,
      fact('CONTAINS', contract, op),
      fact('CONTAINS', entity, prop),
      fact('STORED_IN', prop, col),
      fact('MAPS_TO_FIELD', col, field),
      fact('CONTAINS', model, field),
      fact('TESTS', modelSpec, model),
    ],
  });

  const down = await call(srv, { ids: [contract.id], depth: 4 });
  assert.deepEqual(idsOf(down), [spec.id], 'Contract CONTAINS Operation');

  const domain = await call(srv, { ids: [entity.id], depth: 4 });
  assert.deepEqual(
    idsOf(domain),
    [modelSpec.id],
    'Entity CONTAINS DomainProperty STORED_IN Column MAPS_TO_FIELD CodeField',
  );
});

test('a Contract/SchemaProperty member reaches the contract that holds it, and what exposes it', async () => {
  const contract = makeNode({ kind: 'Contract', canonicalName: 'orders-api' });
  const sprop = makeNode({ kind: 'SchemaProperty', canonicalName: 'orders-api#Order.total' });
  const field = makeNode({ kind: 'CodeField', canonicalName: 'OrderModel.total' });
  const model = makeNode({ kind: 'Symbol', canonicalName: 'OrderModel' });
  const spec = makeNode({ kind: 'TestCase', canonicalName: 'tests/model.test.ts::totals' });
  const srv = server({
    nodes: [contract, sprop, field, model, spec],
    edges: [
      fact('CONTAINS', contract, sprop),
      fact('EXPOSED_AS', field, sprop),
      fact('CONTAINS', model, field),
      fact('TESTS', spec, model),
    ],
  });
  // Down from the contract into its property, across the join to the field, up to the model.
  const env = await call(srv, { ids: [contract.id], depth: 4 });
  assert.deepEqual(idsOf(env), [spec.id]);
  assert.deepEqual(resultOf(env).tests[0]?.path.via, [
    'CONTAINS',
    'EXPOSED_AS',
    'CONTAINS',
    'TESTS',
  ]);
});

test('a decorator is a dependency: a change to it reaches the tests of what it decorates', async () => {
  const decorator = makeNode({ kind: 'Symbol', canonicalName: 'Column' });
  const model = makeNode({ kind: 'Symbol', canonicalName: 'Order' });
  const field = makeNode({ kind: 'CodeField', canonicalName: 'Order.total' });
  const spec = makeNode({ kind: 'TestCase', canonicalName: 'tests/order.test.ts::totals' });
  const env = await call(
    server({
      nodes: [decorator, model, field, spec],
      edges: [
        fact('DECORATED_WITH', field, decorator),
        fact('CONTAINS', model, field),
        fact('TESTS', spec, model),
      ],
    }),
    { ids: [decorator.id], depth: 3 },
  );
  assert.deepEqual(
    resultOf(env).tests.map((t) => t.path.via),
    [['DECORATED_WITH', 'CONTAINS', 'TESTS']],
  );
});

test('a known absence says it holds within the walked edge kinds', async () => {
  const env = await call(server(), { ids: [unrelated.id], depth: 3 });
  assert.equal(resultOf(env).answer, 'KNOWN');
  assert.match(env.notices.join('\n'), /within the walked edge kinds/);
});

// ---------------------------------------------------------------------------
// Audit and budget
// ---------------------------------------------------------------------------

test('the audit event counts the tests a targets:"tests" call returned', async () => {
  const events: Array<{ tool: string; ok: boolean; resultCount: number }> = [];
  const srv = createServer({
    profile: AUDIT_PROFILE,
    graph: memorySource({ nodes: NODES, edges: EDGES, run: TESTS_PASS }),
    nonce: fixedNonce(),
    audit: (e) => events.push({ tool: e.tool, ok: e.ok, resultCount: e.resultCount }),
  });
  const env = await call(srv, { ids: [createOrder.id], depth: 1 });
  assert.equal(resultOf(env).tests.length, 2);
  assert.deepEqual(events, [{ tool: 'impact', ok: true, resultCount: 2 }]);
});

test('the token budget is measured on the text a client is sent, not on compact JSON', async () => {
  // 100 callers with a long prop each: pretty-printing adds about half again to the compact size.
  const target = makeNode({ kind: 'Symbol', canonicalName: 'target' });
  const callers = Array.from({ length: 100 }, (_, i) =>
    makeNode({
      kind: 'Symbol',
      canonicalName: `caller${String(i).padStart(3, '0')}`,
      props: { doc: 'd'.repeat(260) },
    }),
  );
  const srv = server({
    nodes: [target, ...callers],
    edges: callers.map((c) => fact('CALLS', c, target)),
  });
  for (const tokenBudget of [2048, 8000, 20000]) {
    const out = await srv.callTool('context', { symbol: target.id, tokenBudget });
    assert.ok(!('error' in out));
    const sent = toolResult(out, srv.bounds) as {
      content: Array<{ text: string }>;
      structuredContent: { notices: string[] };
    };
    const text = sent.content[0]?.text ?? '';
    const r = out.result as { estimatedTokens: number; related: unknown[] };

    assert.equal(
      r.estimatedTokens,
      estimateTokens(Buffer.byteLength(text, 'utf8')),
      `budget ${tokenBudget}: the estimate is of the text the client reads`,
    );
    assert.ok(
      Buffer.byteLength(text, 'utf8') <= tokenBudget * BYTES_PER_TOKEN,
      `budget ${tokenBudget}: ${Buffer.byteLength(text, 'utf8')} bytes of text`,
    );
    assert.ok(!text.includes('[TRUNCATED'), `budget ${tokenBudget}: the text is not cut mid-JSON`);
    assert.ok(
      !sent.structuredContent.notices.some((n) => n.startsWith('TRUNCATED: the text rendering')),
      `budget ${tokenBudget}: the size gate did not need to cut`,
    );
    assert.ok(r.related.length > 0 && r.related.length < 100, `budget ${tokenBudget}: a real cut`);
  }
});

// ---------------------------------------------------------------------------
// Every id asked about, and every kind the walk crosses, must be accounted for
// ---------------------------------------------------------------------------

test('ids dropped by the input cap were not assessed: UNKNOWN, and no claim that nothing reaches them', async () => {
  const syms = Array.from({ length: 8 }, (_, i) =>
    makeNode({ kind: 'Symbol', canonicalName: `s${i}` }),
  );
  const spec = makeNode({ kind: 'TestCase', canonicalName: 'tests/last.test.ts::last' });
  const srv = server({
    nodes: [...syms, spec],
    edges: [fact('TESTS', spec, syms[7] as SeamlineNode)],
    bounds: { maxInputIds: 5 },
  });

  // The only test hangs off the eighth id, which the cap drops.
  const env = await call(srv, { ids: syms.map((s) => s.id), depth: 1 });
  const r = resultOf(env);
  assert.equal(r.roots.length, 5);
  assert.deepEqual(r.tests, []);
  assert.equal(r.answer, 'UNKNOWN');
  assert.deepEqual(
    r.missing,
    syms
      .slice(5)
      .map((s) => s.id)
      .sort(),
    'the dropped ids are listed as not assessed',
  );
  const notices = env.notices.join('\n');
  assert.match(notices, /Only the first 5 of 8 ids were used/);
  assert.doesNotMatch(notices, /No test case reaches/);

  // Within the cap the same graph is a known answer.
  const within = await call(srv, { ids: syms.slice(0, 5).map((s) => s.id), depth: 1 });
  assert.equal(resultOf(within).answer, 'KNOWN');
});

function plainGraph() {
  const callee = makeNode({ kind: 'Symbol', canonicalName: 'callee' });
  const caller = makeNode({ kind: 'Symbol', canonicalName: 'caller' });
  const spec = makeNode({ kind: 'TestCase', canonicalName: 'tests/caller.test.ts::runs' });
  return {
    callee,
    spec,
    nodes: [callee, caller, spec],
    edges: [fact('CALLS', caller, callee), fact('TESTS', spec, caller)],
  };
}

test('a profile that withholds an edge kind or node kind the walk crosses makes the answer UNKNOWN', async () => {
  const { callee, spec, nodes, edges } = plainGraph();

  const open = await call(server({ nodes, edges, profile: TEAM_PROFILE }), { ids: [callee.id] });
  assert.equal(resultOf(open).answer, 'KNOWN', 'the control: everything walked is released');
  assert.deepEqual(idsOf(open), [spec.id]);

  const withoutCalls = teamWithout({ edgeKinds: ['CALLS'] });
  const withoutFiles = teamWithout({ nodeKinds: ['File'] });
  for (const [label, profile, pattern] of [
    ['CALLS edges', withoutCalls, /does not release.*CALLS/],
    ['File nodes', withoutFiles, /does not release.*File/],
  ] as const) {
    const env = await call(server({ nodes, edges, profile }), { ids: [callee.id] });
    assert.equal(resultOf(env).answer, 'UNKNOWN', `${label} withheld`);
    const notices = env.notices.join('\n');
    assert.match(notices, pattern, label);
    assert.match(notices, /not "no affected tests"/, label);
    assert.doesNotMatch(notices, /No test case reaches/, label);
  }
});

// ---------------------------------------------------------------------------
// Changes to tests, test files and test helpers
// ---------------------------------------------------------------------------

function testCode() {
  const prod = makeNode({ kind: 'Symbol', canonicalName: 'prod', path: 'src/p.ts' });
  const prodFile = makeNode({ kind: 'File', canonicalName: 'src/p.ts', path: 'src/p.ts' });
  const spec = makeNode({
    kind: 'TestCase',
    canonicalName: 'tests/p.test.ts::works',
    path: 'tests/p.test.ts',
  });
  const testFile = makeNode({
    kind: 'File',
    canonicalName: 'tests/p.test.ts',
    path: 'tests/p.test.ts',
  });
  const inTestFile = makeNode({
    kind: 'Symbol',
    canonicalName: 'localHelper',
    path: 'tests/p.test.ts',
  });
  const helperFile = makeNode({
    kind: 'File',
    canonicalName: 'tests/helpers.ts',
    path: 'tests/helpers.ts',
  });
  const helper = makeNode({
    kind: 'Symbol',
    canonicalName: 'makeFixture',
    path: 'tests/helpers.ts',
  });
  const other = makeNode({ kind: 'Symbol', canonicalName: 'other', path: 'src/o.ts' });
  const otherFile = makeNode({ kind: 'File', canonicalName: 'src/o.ts', path: 'src/o.ts' });
  const shared = makeNode({ kind: 'File', canonicalName: 'src/shared.ts', path: 'src/shared.ts' });
  const sharedSym = makeNode({ kind: 'Symbol', canonicalName: 'shared', path: 'src/shared.ts' });
  return {
    prod,
    spec,
    testFile,
    inTestFile,
    helper,
    other,
    sharedSym,
    nodes: [
      prod,
      prodFile,
      spec,
      testFile,
      inTestFile,
      helperFile,
      helper,
      other,
      otherFile,
      shared,
      sharedSym,
    ],
    edges: [
      fact('CONTAINS', prodFile, prod),
      fact('TESTS', spec, prod),
      fact('IMPORTS', testFile, prodFile),
      fact('CONTAINS', testFile, inTestFile),
      // The helper is imported by the test file, by nothing in production, and tested by nothing.
      fact('IMPORTS', testFile, helperFile),
      fact('CONTAINS', helperFile, helper),
      // `shared` is imported by a test file and also by production code.
      fact('IMPORTS', testFile, shared),
      fact('IMPORTS', otherFile, shared),
      fact('CONTAINS', otherFile, other),
      fact('CONTAINS', shared, sharedSym),
    ],
  };
}

test('a changed test case is its own affected test, at distance 0', async () => {
  const { spec, nodes, edges } = testCode();
  const env = await call(server({ nodes, edges }), { ids: [spec.id], depth: 2 });
  const r = resultOf(env);
  assert.equal(r.answer, 'KNOWN');
  assert.deepEqual(
    r.tests.map((t) => ({ id: t.test.id, distance: t.distance, path: t.path })),
    [{ id: spec.id, distance: 0, path: { nodes: [spec.id], via: [] } }],
  );
  assert.deepEqual(r.edges, []);
});

test('a changed test file or test helper is not traced: the answer is UNKNOWN, and says why', async () => {
  const { testFile, inTestFile, helper, nodes, edges } = testCode();
  const srv = server({ nodes, edges });

  for (const [label, root] of [
    ['the test file', testFile],
    ['a symbol defined in the test file', inTestFile],
    ['a helper imported only by test files', helper],
  ] as const) {
    const env = await call(srv, { ids: [root.id], depth: 3 });
    assert.equal(resultOf(env).answer, 'UNKNOWN', label);
    const notices = env.notices.join('\n');
    assert.match(notices, /changes to test files and test helpers are not traced/, label);
    assert.match(notices, /no File to TestCase edge/, label);
    assert.doesNotMatch(notices, /No test case reaches/, label);
  }
});

test('the test-code gate does not fire on production code that tests import', async () => {
  const { prod, spec, other, sharedSym, nodes, edges } = testCode();
  const srv = server({ nodes, edges });

  // Imported by a test file, but it is what the test exercises.
  const tested = await call(srv, { ids: [prod.id], depth: 3 });
  assert.equal(resultOf(tested).answer, 'KNOWN');
  assert.deepEqual(idsOf(tested), [spec.id]);

  // Imported by a test file and by production code: not a helper.
  const used = await call(srv, { ids: [sharedSym.id], depth: 3 });
  assert.equal(resultOf(used).answer, 'KNOWN');

  // Not imported by any test file.
  const apart = await call(srv, { ids: [other.id], depth: 3 });
  assert.equal(resultOf(apart).answer, 'KNOWN');
});

test('a test file is recognised by the file in the test name when the node carries no path', async () => {
  const spec = makeNode({ kind: 'TestCase', canonicalName: 'tests/q.test.ts::runs' });
  const testFile = makeNode({ kind: 'File', canonicalName: 'tests/q.test.ts' });
  const env = await call(server({ nodes: [spec, testFile], edges: [] }), { ids: [testFile.id] });
  assert.equal(resultOf(env).answer, 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// Test support is a fixpoint over importers; what is not recognised is stated
// ---------------------------------------------------------------------------

/** A file node and one symbol it holds, both at `path`. */
function sourceFile(path: string, symbol: string) {
  const file = makeNode({ kind: 'File', canonicalName: path, path });
  const sym = makeNode({ kind: 'Symbol', canonicalName: symbol, path });
  return { file, sym, edge: fact('CONTAINS', file, sym) };
}

/**
 * `tests/a.test.ts` defines `T`, imports `src/prod.ts` (which `T` exercises) and `tests/fixtures.ts`.
 * Nothing in production imports any test support.
 */
function supportBase() {
  const prod = sourceFile('src/prod.ts', 'prod');
  const fixtures = sourceFile('tests/fixtures.ts', 'fixture');
  const testFile = makeNode({
    kind: 'File',
    canonicalName: 'tests/a.test.ts',
    path: 'tests/a.test.ts',
  });
  const spec = makeNode({
    kind: 'TestCase',
    canonicalName: 'tests/a.test.ts::runs',
    path: 'tests/a.test.ts',
  });
  return {
    prod,
    fixtures,
    testFile,
    spec,
    nodes: [prod.file, prod.sym, fixtures.file, fixtures.sym, testFile, spec],
    edges: [
      prod.edge,
      fixtures.edge,
      fact('TESTS', spec, prod.sym),
      fact('IMPORTS', testFile, prod.file),
      fact('IMPORTS', testFile, fixtures.file),
    ],
  };
}

test('a helper behind a helper is test support: a change to it is not traced to the tests', async () => {
  const base = supportBase();
  const db = sourceFile('tests/db.ts', 'openDb');
  const srv = server({
    nodes: [...base.nodes, db.file, db.sym],
    edges: [...base.edges, db.edge, fact('IMPORTS', base.fixtures.file, db.file)],
  });

  for (const [label, root] of [
    ['the helper the test file imports', base.fixtures.sym],
    ['a symbol of the helper behind it', db.sym],
    ['the File of the helper behind it', db.file],
  ] as const) {
    const env = await call(srv, { ids: [root.id], depth: 4 });
    assert.equal(resultOf(env).answer, 'UNKNOWN', label);
    const notices = env.notices.join('\n');
    assert.match(notices, /changes to test files and test helpers are not traced/, label);
    assert.doesNotMatch(notices, /No test case reaches/, label);
  }
});

test('test support is found through any number of importers, and a cycle of helpers is still support', async () => {
  const base = supportBase();
  const level2 = sourceFile('tests/level2.ts', 'two');
  const level3 = sourceFile('tests/level3.ts', 'three');
  const level4 = sourceFile('tests/level4.ts', 'four');
  const srv = server({
    nodes: [
      ...base.nodes,
      level2.file,
      level2.sym,
      level3.file,
      level3.sym,
      level4.file,
      level4.sym,
    ],
    edges: [
      ...base.edges,
      level2.edge,
      level3.edge,
      level4.edge,
      fact('IMPORTS', base.fixtures.file, level2.file),
      fact('IMPORTS', level2.file, level3.file),
      // level3 and level4 import each other; only level3 is imported from above.
      fact('IMPORTS', level3.file, level4.file),
      fact('IMPORTS', level4.file, level3.file),
    ],
  });
  for (const root of [level3.sym, level4.sym]) {
    const env = await call(srv, { ids: [root.id], depth: 6 });
    assert.equal(resultOf(env).answer, 'UNKNOWN', root.id);
  }
});

test('a file with an importer that is not test support stays traced: KNOWN, with the tests it reaches', async () => {
  const base = supportBase();
  const db = sourceFile('tests/db.ts', 'openDb');
  const app = sourceFile('src/app.ts', 'app');
  const usesDb = sourceFile('src/uses-db.ts', 'usesDb');
  const wrapper = sourceFile('src/wrapper.ts', 'wrapper');
  const loop1 = sourceFile('src/loop1.ts', 'loop1');
  const loop2 = sourceFile('src/loop2.ts', 'loop2');
  const lonely = sourceFile('src/lonely.ts', 'lonely');
  const nodes = [
    ...base.nodes,
    ...[db, app, usesDb, wrapper, loop1, loop2, lonely].flatMap((s) => [s.file, s.sym]),
  ];
  const edges = [
    ...base.edges,
    ...[db, app, usesDb, wrapper, loop1, loop2, lonely].map((s) => s.edge),
    // db.ts is test support through fixtures.ts, but production code imports it too.
    fact('IMPORTS', base.fixtures.file, db.file),
    fact('IMPORTS', app.file, db.file),
    // usesDb.ts is imported only by prod.ts, which a test exercises: not test support.
    fact('IMPORTS', base.prod.file, usesDb.file),
    // wrapper.ts is imported by a test file and by a production cycle that nothing enters.
    fact('IMPORTS', base.testFile, wrapper.file),
    fact('IMPORTS', loop1.file, wrapper.file),
    fact('IMPORTS', loop1.file, loop2.file),
    fact('IMPORTS', loop2.file, loop1.file),
    // lonely.ts is imported by nothing at all.
  ];
  const srv = server({ nodes, edges });

  for (const root of [db.sym, usesDb.sym, wrapper.sym, loop1.sym, lonely.sym]) {
    const env = await call(srv, { ids: [root.id], depth: 4 });
    assert.equal(resultOf(env).answer, 'KNOWN', root.id);
  }
  // The tests it reaches are still listed, through the importer that is exercised.
  const env = await call(srv, { ids: [usesDb.sym.id], depth: 4 });
  assert.deepEqual(idsOf(env), [base.spec.id]);
});

test('a symbol whose container edge is missing is still test code when its own path is a test file', async () => {
  const base = supportBase();
  const inTestFile = makeNode({
    kind: 'Symbol',
    canonicalName: 'orphanInTest',
    path: 'tests/a.test.ts',
  });
  const inHelper = makeNode({
    kind: 'Symbol',
    canonicalName: 'orphanInHelper',
    path: 'tests/fixtures.ts',
  });
  const inProd = makeNode({ kind: 'Symbol', canonicalName: 'orphanInProd', path: 'src/prod.ts' });
  const srv = server({
    nodes: [...base.nodes, inTestFile, inHelper, inProd],
    // No CONTAINS edge reaches any of the three.
    edges: base.edges,
  });

  for (const [label, root, answer] of [
    ['a symbol at the test file path', inTestFile, 'UNKNOWN'],
    ['a symbol at the helper path', inHelper, 'UNKNOWN'],
    ['a symbol at a production path', inProd, 'KNOWN'],
  ] as const) {
    const env = await call(srv, { ids: [root.id], depth: 3 });
    assert.equal(resultOf(env).answer, answer, label);
  }
});

test('when a test case names no file the test-code check cannot be trusted: UNKNOWN, with a notice', async () => {
  // A TestCase with neither a path nor a `<file>::<name>` name: the file that defines it is not recoverable.
  const weird = makeNode({ kind: 'TestCase', canonicalName: 'weird name' });
  const prod = sourceFile('src/prod.ts', 'prod');
  const weirdFile = sourceFile('tests/w.test.ts', 'inW');
  const nodes = [weird, prod.file, prod.sym, weirdFile.file, weirdFile.sym];
  const edges = [prod.edge, weirdFile.edge, fact('TESTS', weird, prod.sym)];
  const srv = server({ nodes, edges });

  for (const [label, root] of [
    ['the test file that holds the unlocated case', weirdFile.file],
    ['a symbol in that file', weirdFile.sym],
    ['production code', prod.sym],
  ] as const) {
    const env = await call(srv, { ids: [root.id], depth: 3 });
    assert.equal(resultOf(env).answer, 'UNKNOWN', label);
    const notices = env.notices.join('\n');
    assert.match(notices, /neither a path nor a file in their name/, label);
    assert.ok(notices.includes(weird.id), `${label}: the notice names the case`);
    assert.doesNotMatch(notices, /No test case reaches/, label);
  }

  // The test case itself is returned as itself, whatever file it came from.
  const own = await call(srv, { ids: [weird.id], depth: 3 });
  assert.equal(resultOf(own).answer, 'KNOWN');
  assert.deepEqual(idsOf(own), [weird.id]);
});

test('a test case that is not a fact, or is gone, does not disable the test-code check', async () => {
  const base = supportBase();
  const guessed = makeNode({
    kind: 'TestCase',
    canonicalName: 'guessed name',
    provenance: 'INFERRED',
  });
  const gone = makeNode({
    kind: 'TestCase',
    canonicalName: 'gone name',
    deletedAt: '2026-01-01T00:00:00.000Z',
  });
  const srv = server({ nodes: [...base.nodes, guessed, gone], edges: base.edges });

  const env = await call(srv, { ids: [base.prod.sym.id], depth: 3 });
  assert.equal(resultOf(env).answer, 'KNOWN');
  assert.deepEqual(idsOf(env), [base.spec.id]);
  // And the check still works: the helper file is test code.
  const helper = await call(srv, { ids: [base.fixtures.sym.id], depth: 3 });
  assert.equal(resultOf(helper).answer, 'UNKNOWN');
});

// ---------------------------------------------------------------------------
// Notices must not contradict the answer
// ---------------------------------------------------------------------------

test('a failed scope that no walked edge depends on does not put an UNKNOWN notice next to a KNOWN absence', async () => {
  const { nodes, edges } = plainGraph();
  const run = makeRun('run-1', [
    makeResult('extract-code-ts', 'PASS', ['code.ts'], [], ['File', 'Symbol']),
    makeResult('extract-tests', 'PASS', ['tests'], [], ['TestCase']),
    makeResult('extract-change', 'FAIL', ['history'], ['no git'], ['Commit', 'Changeset']),
  ]);
  // Nothing reaches `lonely`, so the list is empty and the empty-result notice would fire.
  const lonely = makeNode({ kind: 'Symbol', canonicalName: 'lonely' });
  for (const tokenBudget of [undefined, 4000]) {
    const env = await call(
      server({ nodes: [...nodes, lonely], edges, run, scopeStatus: { history: 'FAIL' } }),
      { ids: [lonely.id], ...(tokenBudget === undefined ? {} : { tokenBudget }) },
    );
    const label = `tokenBudget ${tokenBudget}`;
    assert.equal(resultOf(env).answer, 'KNOWN', label);
    assert.deepEqual(idsOf(env), [], label);
    const notices = env.notices.join('\n');
    assert.match(notices, /No test case reaches/, label);
    assert.doesNotMatch(notices, /EMPTY RESULT WITH DEGRADED SCOPES/, label);
    assert.match(
      notices,
      /\(history\) declare no node kind this walk crosses, so this answer does not depend on them/,
      `${label}: the scope in \`unknown\` is accounted for`,
    );
  }
});
