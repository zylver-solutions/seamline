import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Contradiction, GraphView, NodeId, Severity } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo } from '../io.ts';
import type { CliDeps, DetectionReport, DetectorRunnerPort } from '../ports.ts';
import { runCli } from '../run.ts';
import {
  makeNode,
  makeResult,
  makeRun,
  memoryGraph,
  memoryStorePort,
  type MemoryGraph,
} from '../testing.ts';

// ---------------------------------------------------------------------------
// Finding order is a code-unit order, never a locale order (invariant 4).
//
// `X10_UNTESTED_PII_WRITE` vs `X1_NULLABILITY` is a real pair from the code
// vocabulary: by code unit '0' (0x30) sorts before '_' (0x5F), so X10 comes
// first; an ICU collation puts punctuation before digits and would put X1 first.
//
// For ids: 'B' (0x42) < '_' (0x5F) < 'a' (0x61) by code unit, while an en-US
// collation orders `_ a B`.
// ---------------------------------------------------------------------------

async function repoWithConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-check-order-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')), 'utf8');
  return dir;
}

const left = makeNode({ kind: 'Column', canonicalName: 'users.email' });
const right = makeNode({ kind: 'SchemaProperty', canonicalName: 'UserDto#/email' });

function contradiction(
  severity: Severity,
  code: Contradiction['code'] = 'X1_NULLABILITY',
  over: { left?: string; right?: string } = {},
): Contradiction {
  return {
    code,
    severity,
    left: (over.left ?? left.id) as NodeId,
    right: (over.right ?? right.id) as NodeId,
    claim: 'users.email is NOT NULL but UserDto.email is optional',
    leftFact: 'column users.email: nullable=false',
    rightFact: 'schema property UserDto#/email: required=false',
    viaPath: ['EXPOSED_AS'],
    confidence: 0.94,
  };
}

function depsFor(
  cwd: string,
  report: DetectionReport,
  graph: MemoryGraph = memoryGraph({ nodes: [left, right] }),
): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env: {} });
  const detectors: DetectorRunnerPort = { run: (_view: GraphView) => Promise.resolve(report) };
  return {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(graph),
    detectors,
  };
}

async function findingsJson(report: DetectionReport): Promise<readonly Contradiction[]> {
  const d = depsFor(await repoWithConfig(), report);
  await runCli(d, ['check', '--json']);
  return (JSON.parse(d.io.stdout()) as { contradictions: Contradiction[] }).contradictions;
}

test('findings of one severity are ordered by code unit on the code', async () => {
  const shown = await findingsJson({
    contradictions: [
      contradiction('high', 'X2_TYPE'),
      contradiction('high', 'X1_NULLABILITY'),
      contradiction('high', 'X10_UNTESTED_PII_WRITE'),
    ],
    unknown: [],
  });
  assert.deepEqual(
    shown.map((c) => c.code),
    ['X10_UNTESTED_PII_WRITE', 'X1_NULLABILITY', 'X2_TYPE'],
  );
});

test('findings with the same severity and code are ordered by code unit on the left id', async () => {
  const shown = await findingsJson({
    contradictions: ['demo:Column:a', 'demo:Column:B', 'demo:Column:_x'].map((id) =>
      contradiction('high', 'X1_NULLABILITY', { left: id }),
    ),
    unknown: [],
  });
  assert.deepEqual(
    shown.map((c) => c.left),
    ['demo:Column:B', 'demo:Column:_x', 'demo:Column:a'],
  );
});

test('findings that differ only in the right id are ordered by code unit on the right id', async () => {
  const shown = await findingsJson({
    contradictions: [
      'demo:SchemaProperty:a',
      'demo:SchemaProperty:B',
      'demo:SchemaProperty:_x',
    ].map((id) => contradiction('high', 'X1_NULLABILITY', { right: id })),
    unknown: [],
  });
  assert.deepEqual(
    shown.map((c) => c.right),
    ['demo:SchemaProperty:B', 'demo:SchemaProperty:_x', 'demo:SchemaProperty:a'],
  );
});

test('severity still outranks the code-unit tiebreak', async () => {
  const shown = await findingsJson({
    contradictions: [
      contradiction('high', 'X10_UNTESTED_PII_WRITE'),
      contradiction('critical', 'X9_CONTRACT_DRIFT'),
    ],
    unknown: [],
  });
  assert.deepEqual(
    shown.map((c) => c.code),
    ['X9_CONTRACT_DRIFT', 'X10_UNTESTED_PII_WRITE'],
  );
});

test('degraded scopes are listed in code-unit order', async () => {
  const scopes = ['a', 'B', '_x'];
  const graph = memoryGraph({
    nodes: [left, right],
    scopeStatus: Object.fromEntries(scopes.map((s) => [s, 'FAIL' as const])),
    runs: [makeRun('run-1', [makeResult('extract-data', 'FAIL', scopes, ['connection refused'])])],
  });
  const d = depsFor(await repoWithConfig(), { contradictions: [], unknown: [] }, graph);
  await runCli(d, ['check', '--json']);
  const parsed = JSON.parse(d.io.stdout()) as { degradedScopes: Array<{ scope: string }> };
  assert.deepEqual(
    parsed.degradedScopes.map((s) => s.scope),
    ['B', '_x', 'a'],
  );
});
