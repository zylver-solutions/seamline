import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Contradiction, GraphView, Severity } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo, EXIT_FINDINGS, EXIT_OK } from '../io.ts';
import type { CliDeps, DetectionReport, DetectorRunnerPort, UnknownDetection } from '../ports.ts';
import { runCli } from '../run.ts';
import type { CheckReport } from './check.ts';
import { makeNode, makeResult, makeRun, memoryGraph, memoryStorePort, type MemoryGraph } from '../testing.ts';

async function repoWithConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-check-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')), 'utf8');
  return dir;
}

const left = makeNode({ kind: 'Column', canonicalName: 'users.email' });
const right = makeNode({ kind: 'SchemaProperty', canonicalName: 'UserDto#/email' });

function contradiction(severity: Severity, code: Contradiction['code'] = 'X1_NULLABILITY'): Contradiction {
  return {
    code,
    severity,
    left: left.id,
    right: right.id,
    claim: 'users.email is NOT NULL but UserDto.email is optional',
    leftFact: 'column users.email: nullable=false',
    rightFact: 'schema property UserDto#/email: required=false',
    viaPath: ['EXPOSED_AS'],
    confidence: 0.94,
  };
}

function detectors(report: DetectionReport): DetectorRunnerPort {
  return { run: (_view: GraphView) => Promise.resolve(report) };
}

function deps(
  cwd: string,
  report: DetectionReport,
  graph: MemoryGraph = memoryGraph({ nodes: [left, right] }),
): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env: {} });
  return {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(graph),
    detectors: detectors(report),
  };
}

test('check exits non-zero on a critical contradiction', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, { contradictions: [contradiction('critical', 'X6_PII_UNAUTHENTICATED')], unknown: [] });
  const code = await runCli(d, ['check']);
  assert.equal(code, EXIT_FINDINGS);
  assert.match(d.io.stdout(), /CRITICAL/);
  assert.match(d.io.stdout(), /X6_PII_UNAUTHENTICATED/);
});

test('check exits non-zero on a high contradiction', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, { contradictions: [contradiction('high')], unknown: [] });
  assert.equal(await runCli(d, ['check']), EXIT_FINDINGS);
});

test('check exits zero on medium and low findings', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, {
    contradictions: [contradiction('medium'), contradiction('low', 'X8_ORPHANED_MIGRATION')],
    unknown: [],
  });
  assert.equal(await runCli(d, ['check']), EXIT_OK);
});

test('check exits zero and reports CLEAN when everything ran and found nothing', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, { contradictions: [], unknown: [] });
  assert.equal(await runCli(d, ['check']), EXIT_OK);
  assert.match(d.io.stdout(), /CLEAN/);
  assert.doesNotMatch(d.io.stdout(), /UNKNOWN/);
});

const unknownDetector: UnknownDetection = {
  code: 'X2_TYPE',
  severity: 'high',
  reason: 'required scope `data` did not PASS',
  scopes: ['data'],
  scopeStatus: { data: 'UNAVAILABLE' },
};

test('UNKNOWN is reported distinctly from clean and never claims CLEAN', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, { contradictions: [], unknown: [unknownDetector] });
  const code = await runCli(d, ['check']);
  assert.equal(code, EXIT_OK, 'UNKNOWN alone does not fail the build');
  const out = d.io.stdout();
  assert.match(out, /UNKNOWN/);
  assert.doesNotMatch(out, /CLEAN/, 'a degraded run is never reported as clean');
  assert.match(out, /X2_TYPE/);
  assert.match(out, /data/);
});

test('a degraded scope on the run record makes the outcome UNKNOWN even with no unknown detectors', async () => {
  const dir = await repoWithConfig();
  const graph = memoryGraph({
    nodes: [left, right],
    scopeStatus: { data: 'FAIL' },
    runs: [makeRun('run-1', [makeResult('extract-data', 'FAIL', ['data'], ['connection refused'])])],
  });
  const d = deps(dir, { contradictions: [], unknown: [] }, graph);
  const code = await runCli(d, ['check']);
  assert.equal(code, EXIT_OK);
  const out = d.io.stdout();
  assert.match(out, /UNKNOWN/);
  assert.doesNotMatch(out, /CLEAN/);
  assert.match(out, /connection refused/);
});

test('UNKNOWN plus a critical finding still exits non-zero and shows both', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, { contradictions: [contradiction('critical')], unknown: [unknownDetector] });
  assert.equal(await runCli(d, ['check']), EXIT_FINDINGS);
  assert.match(d.io.stdout(), /CRITICAL/);
  assert.match(d.io.stdout(), /UNKNOWN/);
});

test('check --json emits valid, colour-free JSON with a distinct outcome field', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, { contradictions: [], unknown: [unknownDetector] });
  const code = await runCli(d, ['check', '--json']);
  assert.equal(code, EXIT_OK);
  const out = d.io.stdout();
  assert.doesNotMatch(out, /\u001b\[/, 'no ANSI escapes in --json output');
  const parsed = JSON.parse(out) as { outcome: string; exitCode: number; unknownDetectors: unknown[] };
  assert.equal(parsed.outcome, 'unknown');
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.unknownDetectors.length, 1);
});

test('check --json on a critical finding reports outcome findings and exitCode 1', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, { contradictions: [contradiction('critical')], unknown: [] });
  const code = await runCli(d, ['check', '--json']);
  const parsed = JSON.parse(d.io.stdout()) as { outcome: string; exitCode: number; counts: Record<string, number> };
  assert.equal(code, 1);
  assert.equal(parsed.outcome, 'findings');
  assert.equal(parsed.exitCode, 1);
  assert.equal(parsed.counts['critical'], 1);
});

test('--severity filters what is shown without changing what fails the build', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, { contradictions: [contradiction('low', 'X8_ORPHANED_MIGRATION')], unknown: [] });
  const code = await runCli(d, ['check', '--severity', 'high', '--json']);
  const parsed = JSON.parse(d.io.stdout()) as { contradictions: unknown[] };
  assert.equal(code, EXIT_OK);
  assert.equal(parsed.contradictions.length, 0);
});

test('NO_COLOR suppresses escapes in the human output', async () => {
  const dir = await repoWithConfig();
  const io = bufferIo({ cwd: dir, isTty: true, env: { NO_COLOR: '1' } });
  const graph = memoryGraph({ nodes: [left, right] });
  const d: CliDeps = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(graph),
    detectors: detectors({ contradictions: [contradiction('critical')], unknown: [] }),
  };
  await runCli(d, ['check']);
  assert.doesNotMatch(io.stdout(), /\u001b\[/, 'NO_COLOR is honoured even on a TTY');
});

test('colour IS emitted on a TTY without NO_COLOR, so the previous test is not vacuous', async () => {
  const dir = await repoWithConfig();
  const io = bufferIo({ cwd: dir, isTty: true, env: {} });
  const graph = memoryGraph({ nodes: [left, right] });
  const d: CliDeps = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(graph),
    detectors: detectors({ contradictions: [contradiction('critical')], unknown: [] }),
  };
  await runCli(d, ['check']);
  assert.match(io.stdout(), /\u001b\[/);
});

const PARTIAL_DIAGNOSTIC =
  'CONTRACTS_PARTIAL_COVERAGE: 11 file(s) are outside the authoritative claim; contracts they declare are neither emitted nor tombstoned by this run';

/** A `contracts` result that PASSed on a claim narrowed to the files it read to the end. */
function narrowedContracts() {
  return {
    ...makeResult('extract-contracts', 'PASS', ['contracts'], [PARTIAL_DIAGNOSTIC]),
    authoritative: [{ scope: 'contracts', kinds: [] as const, selector: '{src/a/**,src/main.ts}' }],
  };
}

test('a clean result over a narrowed contracts claim names the files that were not read', async () => {
  const dir = await repoWithConfig();
  const graph = memoryGraph({ nodes: [left, right], runs: [makeRun('run-1', [narrowedContracts()])] });
  const d = deps(dir, { contradictions: [], unknown: [] }, graph);
  assert.equal(await runCli(d, ['check']), EXIT_OK, 'the exit code does not change');
  const out = d.io.stdout();
  assert.doesNotMatch(out, /no contradictions found\./, 'never the unqualified sentence');
  assert.match(out, /CLEAN {2}every detector ran; no contradictions found among the facts it read\./);
  assert.match(out, /the contracts claim is partial: 11 file\(s\) not read to the end \(extract-contracts\)/);

  const json = deps(dir, { contradictions: [], unknown: [] }, graph);
  assert.equal(await runCli(json, ['check', '--json']), EXIT_OK);
  const report = JSON.parse(json.io.stdout()) as CheckReport;
  assert.equal(report.outcome, 'clean', 'a narrowed claim qualifies clean, it does not make it UNKNOWN');
  assert.deepEqual(report.narrowedClaims, [
    { scope: 'contracts', extractor: 'extract-contracts', filesNotRead: 11 },
  ]);
});

test('a high finding over a narrowed contracts claim still fails the build, and still names the gap', async () => {
  const dir = await repoWithConfig();
  const graph = memoryGraph({ nodes: [left, right], runs: [makeRun('run-1', [narrowedContracts()])] });
  const d = deps(dir, { contradictions: [contradiction('high')], unknown: [] }, graph);
  assert.equal(await runCli(d, ['check']), EXIT_FINDINGS);
  assert.match(d.io.stdout(), /11 file\(s\) not read to the end/);
});

test('a claim read in full prints the unqualified sentence and no narrowedClaims field', async () => {
  const dir = await repoWithConfig();
  const graph = memoryGraph({
    nodes: [left, right],
    runs: [makeRun('run-1', [makeResult('extract-contracts', 'PASS', ['contracts'])])],
  });
  const d = deps(dir, { contradictions: [], unknown: [] }, graph);
  await runCli(d, ['check']);
  assert.match(d.io.stdout(), /CLEAN {2}every detector ran; no contradictions found\./);
  assert.doesNotMatch(d.io.stdout(), /partial/);

  const json = deps(dir, { contradictions: [], unknown: [] }, graph);
  await runCli(json, ['check', '--json']);
  assert.ok(!('narrowedClaims' in JSON.parse(json.io.stdout())), 'a report over a whole claim is unchanged');
});

test('a narrowed claim on a scope that did not PASS is reported as UNKNOWN, not as a partial PASS', async () => {
  const dir = await repoWithConfig();
  const failed = { ...narrowedContracts(), status: 'FAIL' as const };
  const graph = memoryGraph({
    nodes: [left, right],
    scopeStatus: { contracts: 'FAIL' },
    runs: [makeRun('run-1', [failed])],
  });
  const d = deps(dir, { contradictions: [], unknown: [] }, graph);
  await runCli(d, ['check', '--json']);
  const report = JSON.parse(d.io.stdout()) as CheckReport;
  assert.equal(report.outcome, 'unknown');
  assert.ok(!('narrowedClaims' in report));
});
