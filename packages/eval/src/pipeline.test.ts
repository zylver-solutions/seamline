import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { cliEnv, parseExtractReport, runPipeline } from './pipeline.ts';
import { contradiction, makeTempDir, removeDir, writeFakeCli } from './testing.ts';

async function tree(spec: Record<string, unknown>): Promise<{
  readonly root: string;
  readonly work: string;
  readonly cli: string;
}> {
  const root = await makeTempDir();
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  await writeFile(path.join(work, 'fake.json'), JSON.stringify(spec), 'utf8');
  return { root, work, cli: await writeFakeCli(root) };
}

function options(t: { root: string; work: string; cli: string }, timeoutMs = 20_000) {
  return {
    cli: t.cli,
    workDir: t.work,
    storeDir: path.join(t.root, 'store'),
    logDir: path.join(t.root, 'logs'),
    repoName: 'tiny',
    timeoutMs,
    heapMb: 256,
  };
}

const PASSING = [
  {
    extractor: 'extract-data',
    version: '1',
    status: 'PASS',
    nodeCount: 3,
    edgeCount: 2,
    authoritative: [{ scope: 'data' }],
    diagnostics: [],
  },
];

test('the CLI environment carries the determinism switches and no inherited secrets', () => {
  const env = cliEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    GITHUB_TOKEN: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    NODE_OPTIONS: '--inspect',
  });
  assert.equal(env['SEAMLINE_DETERMINISTIC'], '1');
  assert.equal(env['TZ'], 'UTC');
  assert.equal(env['PATH'], '/usr/bin');
  assert.equal(env['GITHUB_TOKEN'], undefined);
  assert.equal(env['AWS_SECRET_ACCESS_KEY'], undefined);
  assert.equal(env['NODE_OPTIONS'], undefined);
});

test('parseExtractReport reads the extractor table and caps long diagnostics', () => {
  const parsed = parseExtractReport({
    runId: 'r1',
    degradedScopes: ['contracts'],
    results: [
      {
        extractor: 'b',
        version: '2',
        status: 'FAIL',
        nodeCount: 1,
        edgeCount: 0,
        authoritative: [{ scope: 'contracts' }, { scope: 'contracts' }],
        diagnostics: ['x'.repeat(500)],
      },
      {
        extractor: 'a',
        version: '1',
        status: 'PASS',
        nodeCount: 5,
        edgeCount: 4,
        authoritative: [],
        diagnostics: [],
      },
    ],
  });
  assert.deepEqual(
    parsed.extractors.map((e) => e.name),
    ['a', 'b'],
  );
  assert.deepEqual(parsed.extractors[1]?.scopes, ['contracts']);
  assert.equal(parsed.extractors[1]?.diagnostics[0]?.length, 303);
  assert.deepEqual(parsed.degradedScopes, ['contracts']);
  assert.throws(() => parseExtractReport({ results: [] }), /runId/);
});

test('a complete run reports node and edge counts from the snapshot and the findings from check', async () => {
  const t = await tree({
    results: PASSING,
    nodes: { Table: 2, Column: 3 },
    edges: { CONTAINS: 4 },
    contradictions: [contradiction('X1_NULLABILITY', 'tiny:Column:a', 'tiny:SchemaProperty:b')],
    unknown: [{ code: 'X9_CONTRACT_DRIFT', reason: 'scope contracts is FAIL' }],
  });
  try {
    const result = await runPipeline(options(t));
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(result.nodeCounts, { Column: 3, Table: 2 });
    assert.deepEqual(result.edgeCounts, { CONTAINS: 4 });
    assert.equal(result.findings.length, 1);
    assert.equal(result.detectors.X1_NULLABILITY.state, 'fired');
    assert.equal(result.detectors.X2_TYPE.state, 'clean');
    assert.equal(result.detectors.X9_CONTRACT_DRIFT.state, 'unknown');
  } finally {
    await removeDir(t.root);
  }
});

test('a FAIL extractor still completes the run; its detectors are UNKNOWN, not clean', async () => {
  const t = await tree({
    results: [{ ...PASSING[0], status: 'FAIL', diagnostics: ['ZOD_UNSUPPORTED_EXPRESSION'] }],
    degraded: ['data'],
    unknown: [{ code: 'X5_UNWRITTEN_COLUMN', reason: 'scope data is FAIL' }],
  });
  try {
    const result = await runPipeline(options(t));
    assert.equal(result.outcome, 'complete');
    assert.equal(result.extractors[0]?.status, 'FAIL');
    assert.deepEqual(result.degradedScopes, ['data']);
    assert.equal(result.detectors.X5_UNWRITTEN_COLUMN.state, 'unknown');
    assert.equal(result.findings.length, 0);
  } finally {
    await removeDir(t.root);
  }
});

test('a crashing CLI yields every detector UNKNOWN and never an empty clean result', async () => {
  const t = await tree({ crash: true });
  try {
    const result = await runPipeline(options(t));
    assert.equal(result.outcome, 'crashed');
    assert.match(result.detail ?? '', /simulated crash/);
    for (const outcome of Object.values(result.detectors)) assert.equal(outcome.state, 'unknown');
    assert.equal(result.findings.length, 0);
  } finally {
    await removeDir(t.root);
  }
});

test('a CLI that exceeds the timeout is killed and reported as a timeout', async () => {
  const t = await tree({ sleepMs: 30_000, results: PASSING });
  try {
    const started = Date.now();
    const result = await runPipeline(options(t, 400));
    assert.equal(result.outcome, 'timeout');
    assert.match(result.detail ?? '', /timeout/);
    assert.ok(Date.now() - started < 10_000, 'the child was killed, not waited for');
    for (const outcome of Object.values(result.detectors)) assert.equal(outcome.state, 'unknown');
  } finally {
    await removeDir(t.root);
  }
});
