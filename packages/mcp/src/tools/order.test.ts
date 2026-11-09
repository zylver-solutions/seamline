import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Contradiction, NodeId, SeamlineNode, Severity } from '@seamline/ontology';
import { AUDIT_PROFILE } from '@seamline/core';
import type { ToolEnvelope } from '../result.ts';
import { createServer } from '../server.ts';
import { fixedNonce, makeNode, makeResult, makeRun, memorySource } from '../testing.ts';

// ---------------------------------------------------------------------------
// Tool output order is a code-unit order, never a locale order (invariant 4):
// the same graph must produce the same response bytes on every machine.
//
// `X10_UNTESTED_PII_WRITE` vs `X1_NULLABILITY` is a real pair from the code
// vocabulary: by code unit '0' (0x30) sorts before '_' (0x5F), so X10 comes
// first; an ICU collation puts punctuation before digits and would put X1 first.
//
// For ids and scopes: 'B' (0x42) < '_' (0x5F) < 'a' (0x61) by code unit, while an
// en-US collation orders `_ a B`.
// ---------------------------------------------------------------------------

function envelopeOf(
  v: Awaited<ReturnType<ReturnType<typeof createServer>['callTool']>>,
): ToolEnvelope {
  assert.ok(!('error' in v), `tool succeeded: ${JSON.stringify(v)}`);
  return v;
}

const left = makeNode({ kind: 'Column', canonicalName: 'users.email' });
const right = makeNode({ kind: 'SchemaProperty', canonicalName: 'UserDto#/email' });

function finding(
  severity: Severity,
  code: Contradiction['code'],
  leftId: string = left.id,
): Contradiction {
  return {
    code,
    severity,
    left: leftId as NodeId,
    right: right.id,
    claim: 'a claim',
    leftFact: 'left fact',
    rightFact: 'right fact',
    viaPath: [],
    confidence: 0.9,
  };
}

async function findingsOf(
  contradictions: readonly Contradiction[],
  extraNodes: readonly SeamlineNode[] = [],
): Promise<Array<{ code: string; left: string }>> {
  // A finding whose nodes are not in the graph cannot be rendered and is dropped.
  const server = createServer({
    profile: AUDIT_PROFILE,
    graph: memorySource({
      nodes: [left, right, ...extraNodes],
      detection: { contradictions, unknown: [] },
    }),
    nonce: fixedNonce(),
  });
  const env = envelopeOf(await server.callTool('contradictions', {}));
  return (env.result as { findings: Array<{ code: string; left: string }> }).findings;
}

test('contradictions of one severity are ordered by code unit on the code', async () => {
  const shown = await findingsOf([
    finding('high', 'X2_TYPE'),
    finding('high', 'X1_NULLABILITY'),
    finding('high', 'X10_UNTESTED_PII_WRITE'),
  ]);
  assert.deepEqual(
    shown.map((f) => f.code),
    ['X10_UNTESTED_PII_WRITE', 'X1_NULLABILITY', 'X2_TYPE'],
  );
});

test('contradictions with the same severity and code are ordered by code unit on the left id', async () => {
  const lefts = ['a', 'B', '_x'].map((canonicalName) =>
    makeNode({ kind: 'Column', canonicalName }),
  );
  const shown = await findingsOf(
    lefts.map((n) => finding('high', 'X1_NULLABILITY', n.id)),
    lefts,
  );
  assert.deepEqual(
    shown.map((f) => f.left),
    ['demo:Column:B', 'demo:Column:_x', 'demo:Column:a'],
  );
});

test('degraded scopes reach the agent in code-unit order', async () => {
  const scopes = ['a', 'B', '_x'];
  const server = createServer({
    profile: AUDIT_PROFILE,
    graph: memorySource({
      nodes: [left],
      scopeStatus: Object.fromEntries(scopes.map((s) => [s, 'UNAVAILABLE' as const])),
      run: makeRun('run-1', [makeResult('extract-data', 'UNAVAILABLE', scopes, [])]),
    }),
    nonce: fixedNonce(),
  });
  const env = envelopeOf(await server.callTool('context', { symbol: 'users.email' }));
  assert.deepEqual(
    env.unknown.map((u) => u.scope),
    ['B', '_x', 'a'],
  );
});

test('an ambiguous name lists its candidates in code-unit order of their ids', async () => {
  const nodes = ['a', 'B', '_r'].map((repo) =>
    makeNode({ repo, kind: 'Column', canonicalName: 'users.email' }),
  );
  const server = createServer({
    profile: AUDIT_PROFILE,
    graph: memorySource({ nodes }),
    nonce: fixedNonce(),
  });
  const env = envelopeOf(await server.callTool('context', { symbol: 'users.email' }));
  const r = env.result as { ambiguous: boolean; candidates: Array<{ id: string }> };
  assert.equal(r.ambiguous, true);
  assert.deepEqual(
    r.candidates.map((c) => c.id),
    ['B:Column:users.email', '_r:Column:users.email', 'a:Column:users.email'],
  );
});
