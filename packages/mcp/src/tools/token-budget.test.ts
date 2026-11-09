import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AUDIT_PROFILE } from '@seamline/core';
import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import {
  BUDGET_EDGES,
  BUDGET_NODES,
  codeField,
  column,
  createOrder,
  currency,
  EDGES,
  money,
  NODES,
  orderClass,
  repoA,
  repoB,
  repoC,
  schemaProp,
  table,
  validateTotal,
} from '../__fixtures__/orders-graph.ts';
import { byteLength } from '../bounds.ts';
import { BYTES_PER_TOKEN, estimateTokens, MAX_TOKEN_BUDGET, MIN_TOKEN_BUDGET } from '../budget.ts';
import type { Bounds } from '../ports.ts';
import { renderToolContent, type ToolEnvelope } from '../result.ts';
import { createServer } from '../server.ts';
import { fixedNonce, makeEdge, makeNode, makeResult, makeRun, memorySource } from '../testing.ts';

const PASS_RUN = makeRun('run-1', [makeResult('extract-code-ts', 'PASS', ['code.ts'])]);

function server(
  nodes: readonly SeamlineNode[] = BUDGET_NODES,
  edges: readonly SeamlineEdge[] = BUDGET_EDGES,
  bounds?: Partial<Bounds>,
) {
  return createServer({
    profile: AUDIT_PROFILE,
    graph: memorySource({ nodes, edges, run: PASS_RUN }),
    nonce: fixedNonce(),
    ...(bounds === undefined ? {} : { bounds }),
  });
}

async function call(
  srv: ReturnType<typeof server>,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  const out = await srv.callTool(tool, args);
  assert.ok(!('error' in out), `${tool} succeeded: ${JSON.stringify(out)}`);
  return out;
}

/** The estimate of the text a client reads for this response, which is what `estimatedTokens` reports. */
const emittedTokens = (env: ToolEnvelope): number =>
  estimateTokens(Buffer.byteLength(renderToolContent(env).text, 'utf8'));

interface ContextResult {
  found: boolean;
  node: { id: string };
  container: { id: string } | null;
  containerOmitted?: boolean;
  related: Array<{ depth: number; via: string; node: { id: string } }>;
  edges: Array<{ src: string; dst: string }>;
  tokenBudget: number;
  estimatedTokens: number;
  tokenEstimator: string;
}

// ---------------------------------------------------------------------------
// Without the parameter, nothing changes
// ---------------------------------------------------------------------------

function wire(name: string, args: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function golden(file: string): string {
  return readFileSync(new URL(`../__fixtures__/${file}`, import.meta.url), 'utf8');
}

// The goldens were recorded from the tools as they were before `tokenBudget` and `targets` existed.
test('context without tokenBudget returns the same bytes it always did', async () => {
  const srv = server(NODES, EDGES);
  assert.equal(
    `${await srv.handle(wire('context', { symbol: column.id, depth: 2 }))}\n`,
    golden('context-column-depth2.wire.json'),
  );
  assert.equal(
    `${await srv.handle(wire('context', { symbol: createOrder.id }))}\n`,
    golden('context-symbol-default.wire.json'),
  );
});

test('impact without tokenBudget or targets returns the same bytes it always did', async () => {
  const srv = server(NODES, EDGES);
  assert.equal(
    `${await srv.handle(wire('impact', { ids: [column.id, createOrder.id], depth: 3 }))}\n`,
    golden('impact-two-roots-depth3.wire.json'),
  );
});

test('naming the defaults changes nothing: targets "nodes" is the same answer as omitting it', async () => {
  const srv = server(NODES, EDGES);
  const args = { ids: [column.id, createOrder.id], depth: 3 };
  assert.equal(
    await srv.handle(wire('impact', { ...args, targets: 'nodes' })),
    await srv.handle(wire('impact', args)),
  );
});

// ---------------------------------------------------------------------------
// The parameter itself
// ---------------------------------------------------------------------------

test('tools/list advertises tokenBudget with its bounds on context and impact', async () => {
  const tools = server().listTools() as Array<{
    name: string;
    inputSchema: {
      properties: Record<string, { type?: string; minimum?: number; maximum?: number }>;
    };
  }>;
  for (const name of ['context', 'impact']) {
    const prop = tools.find((t) => t.name === name)?.inputSchema.properties['tokenBudget'];
    assert.equal(prop?.type, 'integer', `${name} advertises tokenBudget`);
    assert.equal(prop?.minimum, MIN_TOKEN_BUDGET);
    assert.equal(prop?.maximum, MAX_TOKEN_BUDGET);
  }
  for (const name of ['lineage', 'explain', 'contradictions']) {
    const props = tools.find((t) => t.name === name)?.inputSchema.properties ?? {};
    assert.ok(!('tokenBudget' in props), `${name} does not take tokenBudget`);
  }
});

test('tokenBudget is validated: out of range, fractional and non-numeric values are refused, the bounds are accepted', async () => {
  const srv = server();
  for (const bad of [MIN_TOKEN_BUDGET - 1, MAX_TOKEN_BUDGET + 1, 0, -5, 1000.5, '2000']) {
    const out = await srv.callTool('context', { symbol: column.id, tokenBudget: bad });
    assert.ok('error' in out, `tokenBudget ${JSON.stringify(bad)} is refused`);
    assert.match(out.details.join('\n'), /tokenBudget/);
  }
  for (const good of [MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET]) {
    await call(srv, 'context', { symbol: column.id, tokenBudget: good });
    await call(srv, 'impact', { ids: [column.id], tokenBudget: good });
  }
});

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

// The resolved node is `Order.total`; these are its neighbours within three hops in the order the budget
// keeps them: direct facts (USES_TYPE), the join (MAPS_TO_FIELD), then farther hops nearest first with facts
// before guesses, then by id.
const EXPECTED_ORDER = [
  currency.id, // depth 1, direct fact
  money.id, // depth 1, direct fact
  column.id, // depth 1, join
  table.id, // depth 2, fact (CONTAINS)
  schemaProp.id, // depth 2, guess (EXPOSED_AS INFERRED)
  repoA.id, // depth 3, facts, by id
  repoB.id,
  repoC.id,
  validateTotal.id,
];

test('a budget that holds everything returns everything, in priority order, and says what it measured', async () => {
  const env = await call(server(), 'context', {
    symbol: codeField.id,
    depth: 3,
    tokenBudget: MAX_TOKEN_BUDGET,
  });
  const r = env.result as ContextResult;

  assert.equal(r.found, true);
  assert.equal(r.node.id, codeField.id);
  assert.equal(r.container?.id, orderClass.id, 'the container comes right after the node');
  assert.deepEqual(
    r.related.map((x) => x.node.id),
    EXPECTED_ORDER,
  );
  assert.equal(env.truncated, false);

  assert.equal(r.tokenBudget, MAX_TOKEN_BUDGET);
  assert.equal(r.tokenEstimator, `ceil(utf8 bytes / ${BYTES_PER_TOKEN})`);
  assert.equal(
    r.estimatedTokens,
    emittedTokens(env),
    'the reported estimate is the estimate of the text as sent',
  );
});

test('a tight budget keeps a prefix of the priority order and reports the truncation', async () => {
  const srv = server();
  const full = (
    await call(srv, 'context', { symbol: codeField.id, depth: 3, tokenBudget: MAX_TOKEN_BUDGET })
  ).result as ContextResult;
  const fullEstimate = full.estimatedTokens;

  let previousKept = -1;
  let sawTruncation = false;
  for (let budget = MIN_TOKEN_BUDGET; budget <= fullEstimate + 100; budget += 25) {
    const env = await call(srv, 'context', { symbol: codeField.id, depth: 3, tokenBudget: budget });
    const r = env.result as ContextResult;
    const kept = r.related.map((x) => x.node.id);

    assert.deepEqual(
      kept,
      EXPECTED_ORDER.slice(0, kept.length),
      `budget ${budget}: kept ids are a prefix of the priority order`,
    );
    assert.ok(kept.length >= previousKept, `budget ${budget}: a larger budget never keeps less`);
    previousKept = kept.length;
    assert.equal(r.tokenBudget, budget);
    assert.equal(r.estimatedTokens, emittedTokens(env));

    const complete = kept.length === EXPECTED_ORDER.length && r.container !== null;
    assert.equal(
      env.truncated,
      !complete,
      `budget ${budget}: truncated exactly when something was left out`,
    );
    if (!complete) {
      sawTruncation = true;
      const t = env.truncation as {
        reasons: string[];
        returned: number;
        total: number;
        message: string;
      };
      assert.ok(t.reasons.includes('token-budget'), `budget ${budget}: the reason is named`);
      assert.equal(t.total, 1 + EXPECTED_ORDER.length, 'the true candidate total is disclosed');
      assert.equal(t.returned, (r.container === null ? 0 : 1) + kept.length);
      assert.match(env.notices.join('\n'), new RegExp(`Token budget ${budget} bit`));
    }
    // Within the budget, unless even the fixed part cannot fit (checked separately below).
    if (kept.length > 0 || r.container !== null) {
      assert.ok(
        r.estimatedTokens <= budget,
        `budget ${budget}: estimated ${r.estimatedTokens} fits`,
      );
    }
  }
  assert.ok(sawTruncation, 'the sweep includes budgets that bite');
  assert.equal(previousKept, EXPECTED_ORDER.length, 'and a budget that holds everything');
});

test('the budget keeps the longest prefix that fits: one more item would not', async () => {
  const srv = server();
  const at = async (budget: number) =>
    (await call(srv, 'context', { symbol: codeField.id, depth: 3, tokenBudget: budget }))
      .result as ContextResult;

  // The smallest budget that keeps the first four related nodes...
  let budget = MIN_TOKEN_BUDGET;
  while ((await at(budget)).related.length < 4) budget += 1;
  const four = await at(budget);
  assert.equal(four.related.length, 4);
  assert.ok(four.estimatedTokens <= budget);
  // ...and one token less keeps strictly fewer: the cut sits exactly where the budget says.
  assert.ok((await at(budget - 1)).related.length < 4);
});

test('edges in a budgeted answer join returned nodes only', async () => {
  const env = await call(server(), 'context', { symbol: codeField.id, depth: 3, tokenBudget: 900 });
  const r = env.result as ContextResult;
  const present = new Set([r.node.id, r.container?.id, ...r.related.map((x) => x.node.id)]);
  assert.ok(r.edges.length > 0);
  for (const e of r.edges) {
    assert.ok(
      present.has(e.src) && present.has(e.dst),
      `${e.src} -> ${e.dst} joins two returned nodes`,
    );
  }
});

test('the server byte cap still wins when it is tighter than the budget, and the reason says so', async () => {
  const maxBytes = 2000;
  const env = await call(server(BUDGET_NODES, BUDGET_EDGES, { maxBytes }), 'context', {
    symbol: codeField.id,
    depth: 3,
    tokenBudget: MAX_TOKEN_BUDGET,
  });
  assert.ok(
    byteLength(env) <= maxBytes,
    `${byteLength(env)} bytes within the ${maxBytes}-byte cap`,
  );
  assert.equal(env.truncated, true);
  const reasons = (env.truncation as { reasons: string[] }).reasons;
  assert.ok(reasons.includes('size-cap'), `reasons: ${reasons.join(', ')}`);
  assert.ok(!reasons.includes('token-budget'), 'the budget was not the binding limit');
  assert.ok((env.result as ContextResult).estimatedTokens <= estimateTokens(maxBytes));
});

test('a budget never lifts the server byte cap: the default response cap bounds even the largest budget', async () => {
  const many = Array.from({ length: 90 }, (_, i) =>
    makeNode({ kind: 'Symbol', canonicalName: `callee${i}`, props: { doc: 'w'.repeat(900) } }),
  );
  const edges = many.map((n) =>
    makeEdge({
      kind: 'CALLS',
      src: createOrder.id,
      dst: n.id,
      provenance: 'EXTRACTED',
      confidence: 1,
    }),
  );
  const srv = server([createOrder, ...many], edges);
  const env = await call(srv, 'context', { symbol: createOrder.id, tokenBudget: MAX_TOKEN_BUDGET });
  assert.ok(byteLength(env) <= srv.bounds.maxBytes);
  assert.equal(env.truncated, true);
});

test('when the resolved node alone exceeds the budget it is returned anyway, with a notice', async () => {
  const props = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`p${String(i).padStart(2, '0')}`, 'v'.repeat(80)]),
  );
  const fat = makeNode({ kind: 'Symbol', canonicalName: 'fat', props });
  const thin = makeNode({ kind: 'Symbol', canonicalName: 'thin' });
  const srv = server(
    [fat, thin],
    [
      makeEdge({
        kind: 'CALLS',
        src: fat.id,
        dst: thin.id,
        provenance: 'EXTRACTED',
        confidence: 1,
      }),
    ],
  );
  const env = await call(srv, 'context', { symbol: fat.id, tokenBudget: MIN_TOKEN_BUDGET });
  const r = env.result as ContextResult;
  assert.equal(r.node.id, fat.id, 'the node the agent asked about is still there');
  assert.deepEqual(r.related, [], 'nothing optional was kept');
  assert.ok(
    r.estimatedTokens > MIN_TOKEN_BUDGET,
    'and the response is honest that it is over the budget',
  );
  assert.equal(env.truncated, true);
  assert.match(env.notices.join('\n'), /alone exceeds the budget of 512/);
});

test('a container the budget cannot afford is reported as omitted, not as absent', async () => {
  const props = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`p${String(i).padStart(2, '0')}`, 'v'.repeat(60)]),
  );
  const node = makeNode({ kind: 'Symbol', canonicalName: 'member', props });
  const box = makeNode({ kind: 'File', canonicalName: 'src/box.ts', props });
  const srv = server(
    [node, box],
    [
      makeEdge({
        kind: 'CONTAINS',
        src: box.id,
        dst: node.id,
        provenance: 'EXTRACTED',
        confidence: 1,
      }),
    ],
  );

  const roomy = (await call(srv, 'context', { symbol: node.id, tokenBudget: MAX_TOKEN_BUDGET }))
    .result as ContextResult;
  assert.equal(roomy.container?.id, box.id);
  assert.equal(roomy.containerOmitted, undefined);

  let tight: ContextResult | undefined;
  for (let budget = MIN_TOKEN_BUDGET; budget < roomy.estimatedTokens; budget += 10) {
    const r = (await call(srv, 'context', { symbol: node.id, tokenBudget: budget }))
      .result as ContextResult;
    if (r.container === null) {
      tight = r;
      break;
    }
  }
  assert.ok(tight !== undefined, 'some budget fits the node but not its container');
  assert.equal(tight.containerOmitted, true, 'null here means "left out", not "has none"');
});

test('untrusted blocks are attached once per kept node, however often fitting rebuilt the answer', async () => {
  const hub = makeNode({ kind: 'Symbol', canonicalName: 'hub' });
  const leaves = Array.from({ length: 12 }, (_, i) =>
    makeNode({
      kind: 'Symbol',
      canonicalName: `leaf${String(i).padStart(2, '0')}`,
      untrusted: true,
      props: { comment: `note ${i}` },
    }),
  );
  const edges = leaves.map((l) =>
    makeEdge({ kind: 'CALLS', src: hub.id, dst: l.id, provenance: 'EXTRACTED', confidence: 1 }),
  );
  const srv = server([hub, ...leaves], edges);

  const full = await call(srv, 'context', { symbol: hub.id, tokenBudget: MAX_TOKEN_BUDGET });
  const fullBlocks = (full.result as { untrustedBlocks?: string[] }).untrustedBlocks ?? [];
  assert.equal(fullBlocks.length, 12);

  let budget = MIN_TOKEN_BUDGET;
  let checked = 0;
  for (; budget < (full.result as ContextResult).estimatedTokens; budget += 40) {
    const env = await call(srv, 'context', { symbol: hub.id, tokenBudget: budget });
    const r = env.result as ContextResult & { untrustedBlocks?: string[] };
    const blocks = r.untrustedBlocks ?? [];
    assert.equal(
      blocks.length,
      r.related.length,
      `budget ${budget}: one block per kept untrusted node`,
    );
    assert.equal(new Set(blocks).size, blocks.length, 'no block is repeated');
    assert.equal(r.estimatedTokens, emittedTokens(env), 'the estimate covers the blocks too');
    checked += 1;
  }
  assert.ok(checked > 3);
});

test('an ambiguous name under a budget lists as many candidates as fit, in id order, and says it cut', async () => {
  const dupes = Array.from({ length: 24 }, (_, i) =>
    makeNode({
      kind: 'Column',
      canonicalName: `schema${String(i).padStart(2, '0')}.users.email`,
      props: { note: 'n'.repeat(40) },
    }),
  );
  const srv = server(dupes, []);
  const env = await call(srv, 'context', { symbol: 'users.email', tokenBudget: 700 });
  const r = env.result as {
    found: boolean;
    ambiguous: boolean;
    totalMatches: number;
    candidates: Array<{ id: string }>;
    estimatedTokens: number;
  };
  assert.equal(r.found, false);
  assert.equal(r.ambiguous, true);
  assert.equal(r.totalMatches, 24);
  const ids = r.candidates.map((c) => c.id);
  assert.deepEqual(
    ids,
    [...dupes.map((d) => d.id)].sort().slice(0, ids.length),
    'a prefix of the id order',
  );
  assert.ok(ids.length < 24, 'the budget cut the list');
  assert.equal(env.truncated, true);
  assert.ok((env.truncation as { reasons: string[] }).reasons.includes('token-budget'));
  assert.ok(r.estimatedTokens <= 700);
});

test('a name that matches nothing still reports the budget and the estimate', async () => {
  const env = await call(server(), 'context', {
    symbol: 'no.such.thing',
    tokenBudget: MIN_TOKEN_BUDGET,
  });
  const r = env.result as { found: boolean; tokenBudget: number; estimatedTokens: number };
  assert.equal(r.found, false);
  assert.equal(r.tokenBudget, MIN_TOKEN_BUDGET);
  assert.ok(r.estimatedTokens > 0 && r.estimatedTokens <= MIN_TOKEN_BUDGET);
});

// ---------------------------------------------------------------------------
// impact
// ---------------------------------------------------------------------------

interface ImpactResult {
  roots: string[];
  depth: number;
  byKind: Record<string, number>;
  reached: Array<{ depth: number; node: { id: string } }>;
  tokenBudget: number;
  estimatedTokens: number;
}

test('impact under a budget returns the nearest nodes first and counts the rest by kind', async () => {
  const srv = server();
  const args = { ids: [codeField.id, table.id], depth: 3 };
  const full = (await call(srv, 'impact', { ...args, tokenBudget: MAX_TOKEN_BUDGET }))
    .result as ImpactResult;
  const fullIds = full.reached.map((x) => x.node.id);
  assert.ok(fullIds.length >= 4);
  const depths = full.reached.map((x) => x.depth);
  assert.deepEqual(
    depths,
    [...depths].sort((a, b) => a - b),
    'nearest first',
  );

  const env = await call(srv, 'impact', { ...args, tokenBudget: 600 });
  const r = env.result as ImpactResult;
  const ids = r.reached.map((x) => x.node.id);
  assert.ok(ids.length > 0 && ids.length < fullIds.length, 'the budget cut the list');
  assert.deepEqual(ids, fullIds.slice(0, ids.length), 'what is kept is a prefix of the same order');
  assert.deepEqual(r.byKind, full.byKind, 'byKind still counts everything the walk reached');
  assert.equal(env.truncated, true);
  const t = env.truncation as { reasons: string[]; returned: number; total: number };
  assert.ok(t.reasons.includes('token-budget'));
  assert.equal(t.returned, ids.length);
  assert.equal(t.total, fullIds.length);
  assert.ok(r.estimatedTokens <= 600);
  assert.equal(r.estimatedTokens, emittedTokens(env));
  // Facts come before guesses within a hop: the INFERRED column is behind the EXTRACTED symbols at depth 1.
  assert.deepEqual(fullIds.slice(0, 6), [
    currency.id,
    money.id,
    repoA.id,
    repoB.id,
    repoC.id,
    column.id,
  ]);
});

test('impact with only unresolvable ids under a budget is still not an empty blast radius', async () => {
  const env = await call(server(), 'impact', {
    ids: ['demo:Column:ghost'],
    tokenBudget: MIN_TOKEN_BUDGET,
  });
  assert.match(env.notices.join('\n'), /None of the 1 id\(s\) resolved/);
  assert.equal((env.result as ImpactResult).tokenBudget, MIN_TOKEN_BUDGET);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

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

test('budgeted answers do not depend on the order nodes and edges arrive in', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  for (const budget of [MIN_TOKEN_BUDGET, 800, 1100, 1300, MAX_TOKEN_BUDGET]) {
    calls.push(['context', { symbol: codeField.id, depth: 3, tokenBudget: budget }]);
    calls.push(['context', { symbol: table.id, depth: 3, tokenBudget: budget }]);
    calls.push(['impact', { ids: [codeField.id, table.id], depth: 3, tokenBudget: budget }]);
  }
  const baseline = server();
  const expected = await Promise.all(
    calls.map(async ([tool, args]) => JSON.stringify(await call(baseline, tool, args))),
  );

  for (const seed of [1, 2, 3, 4, 5]) {
    const srv = server(shuffled(BUDGET_NODES, seed), shuffled(BUDGET_EDGES, seed * 7));
    for (const [i, [tool, args]] of calls.entries()) {
      assert.equal(
        JSON.stringify(await call(srv, tool, args)),
        expected[i],
        `seed ${seed}: ${tool} ${JSON.stringify(args)}`,
      );
    }
  }
});
