import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { runCli } from '../run.ts';
import {
  fakeGitPort,
  makeEdge,
  makeNode,
  makeResult,
  makeRun,
  memoryGraph,
  memoryStorePort,
  type MemoryGraph,
} from '../testing.ts';
import type { BlastRadiusReport } from './blast-radius.ts';

async function repoWithConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-blast-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')), 'utf8');
  return dir;
}

// moduleA (src/a.ts) IMPORTS moduleB (src/b.ts); symbolFoo (also in src/a.ts)
// CALLS symbolBar (in src/b.ts). Changing src/a.ts should reach both moduleB
// and symbolBar, one hop out, across two different node kinds.
const moduleA = makeNode({ kind: 'File', canonicalName: 'src/a.ts', path: 'src/a.ts' });
const moduleB = makeNode({ kind: 'File', canonicalName: 'src/b.ts', path: 'src/b.ts' });
const symbolFoo = makeNode({ kind: 'Symbol', canonicalName: 'src/a.ts#foo', path: 'src/a.ts' });
const symbolBar = makeNode({ kind: 'Symbol', canonicalName: 'src/b.ts#bar', path: 'src/b.ts' });
const symbolBaz = makeNode({ kind: 'Symbol', canonicalName: 'src/c.ts#baz', path: 'src/c.ts' });

function reachGraph(extra: { scopeStatus?: Record<string, 'PASS' | 'FAIL' | 'UNAVAILABLE'> } = {}): MemoryGraph {
  return memoryGraph({
    nodes: [moduleA, moduleB, symbolFoo, symbolBar, symbolBaz],
    edges: [
      makeEdge({ kind: 'IMPORTS', src: moduleA.id, dst: moduleB.id, provenance: 'EXTRACTED', confidence: 1 }),
      makeEdge({ kind: 'CALLS', src: symbolFoo.id, dst: symbolBar.id, provenance: 'EXTRACTED', confidence: 1 }),
      makeEdge({ kind: 'CALLS', src: symbolBar.id, dst: symbolBaz.id, provenance: 'EXTRACTED', confidence: 1 }),
    ],
    ...(extra.scopeStatus === undefined ? {} : { scopeStatus: extra.scopeStatus }),
    runs: [
      makeRun('run-1', [
        makeResult('extract-code-ts', 'PASS', ['code']),
      ]),
    ],
  });
}

function deps(
  cwd: string,
  graph: MemoryGraph,
  changedFiles?: readonly string[],
): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env: {} });
  return {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(graph),
    ...(changedFiles === undefined ? {} : { git: fakeGitPort(changedFiles) }),
  };
}

test('default mode resolves roots from changed files and walks outward', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, reachGraph(), ['src/a.ts']);
  const code = await runCli(d, ['blast-radius', '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());

  const report = JSON.parse(d.io.stdout()) as BlastRadiusReport;
  assert.equal(report.mode, 'diff');
  assert.equal(report.cleanWorkingTree, false);
  assert.deepEqual(
    report.roots.map((r) => r.id).sort(),
    [moduleA.id, symbolFoo.id].sort(),
  );
  for (const r of report.roots) assert.equal(r.fromPath, 'src/a.ts');

  const kinds = report.reached.map((g) => g.kind).sort();
  assert.deepEqual(kinds, ['File', 'Symbol']);
  const fileGroup = report.reached.find((g) => g.kind === 'File');
  assert.deepEqual(fileGroup?.nodes.map((n) => n.id), [moduleB.id]);
  const symbolGroup = report.reached.find((g) => g.kind === 'Symbol');
  assert.ok(symbolGroup?.nodes.some((n) => n.id === symbolBar.id));
});

test('a clean working tree is a real result, not an error', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, reachGraph(), []);
  const code = await runCli(d, ['blast-radius']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  assert.match(d.io.stdout(), /clean/i);
});

test('a changed path matching no node is reported, not dropped or errored', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, reachGraph(), ['src/nowhere.ts']);
  const code = await runCli(d, ['blast-radius', '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const report = JSON.parse(d.io.stdout()) as BlastRadiusReport;
  assert.deepEqual(report.roots, []);
  assert.deepEqual(report.unmatchedPaths, ['src/nowhere.ts']);
});

test('--ids resolves explicit roots, matching the MCP impact tool shape', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, reachGraph());
  const code = await runCli(d, ['blast-radius', '--ids', `${symbolFoo.id},${moduleA.id}`, '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const report = JSON.parse(d.io.stdout()) as BlastRadiusReport;
  assert.equal(report.mode, 'ids');
  assert.deepEqual(
    report.roots.map((r) => r.id).sort(),
    [moduleA.id, symbolFoo.id].sort(),
  );
  for (const r of report.roots) assert.equal(r.fromPath, null);
});

test('--ids that do not resolve are reported as missing, not a crash', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, reachGraph());
  const bogus = 'demo:Symbol:nope.nothing';
  const code = await runCli(d, ['blast-radius', '--ids', bogus, '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const report = JSON.parse(d.io.stdout()) as BlastRadiusReport;
  assert.deepEqual(report.roots, []);
  assert.deepEqual(report.missingIds, [bogus]);
});

test('--ids with an empty value is a usage error', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, reachGraph());
  const code = await runCli(d, ['blast-radius', '--ids', '']);
  assert.equal(code, EXIT_USAGE);
});

test('--depth caps the walk and reports the truncation explicitly', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, reachGraph(), ['src/a.ts']);
  const code = await runCli(d, ['blast-radius', '--depth', '1', '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const report = JSON.parse(d.io.stdout()) as BlastRadiusReport;
  // symbolBaz is two hops from symbolFoo (foo -> bar -> baz); depth 1 should
  // not reach it, and should say so.
  const allReachedIds = report.reached.flatMap((g) => g.nodes.map((n) => n.id));
  assert.ok(!allReachedIds.includes(symbolBaz.id));
  assert.equal(report.truncated, true);
  assert.ok(report.truncationReasons.length > 0);
});

test('a degraded scope is reported so an absent edge is not read as absence', async () => {
  const dir = await repoWithConfig();
  const graph = reachGraph({ scopeStatus: { code: 'UNAVAILABLE' } });
  const d = deps(dir, graph, ['src/a.ts']);
  const code = await runCli(d, ['blast-radius', '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const report = JSON.parse(d.io.stdout()) as BlastRadiusReport;
  assert.equal(report.unknown.length, 1);
  assert.equal(report.unknown[0]?.scope, 'code');
});

test('no --ids and no git wired is an actionable "not wired" error, not a crash', async () => {
  const dir = await repoWithConfig();
  const io = bufferIo({ cwd: dir, isTty: false, env: {} });
  const d: CliDeps & { io: typeof io } = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(reachGraph()),
  };
  const code = await runCli(d, ['blast-radius']);
  assert.equal(code, EXIT_RUNTIME);
  assert.match(d.io.stderr(), /git/);
  assert.match(d.io.stderr(), /blast-radius/);
});

test('human output names the roots, the reached kinds, and unknown scopes', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, reachGraph({ scopeStatus: { code: 'UNAVAILABLE' } }), ['src/a.ts']);
  const code = await runCli(d, ['blast-radius']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const out = d.io.stdout();
  assert.match(out, /ROOTS/);
  assert.match(out, /REACHED/);
  assert.match(out, /UNKNOWN/);
});
