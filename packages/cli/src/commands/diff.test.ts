import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo, EXIT_OK, EXIT_USAGE } from '../io.ts';
import type { CliDeps, Snapshot } from '../ports.ts';
import { runCli } from '../run.ts';
import { fileSnapshots, parseSif, serializeSif } from '../sif.ts';
import { makeEdge, makeNode, makeRun } from '../testing.ts';
import { diffSnapshots, type DiffReport } from './diff.ts';

const a = makeNode({ kind: 'Column', canonicalName: 'public.users.email', props: { nullable: false } });
const b = makeNode({ kind: 'CodeField', canonicalName: 'User.email' });
const c = makeNode({ kind: 'Column', canonicalName: 'public.users.phone' });

const snapshotA: Snapshot = {
  runId: 'run-1',
  run: makeRun('run-1', []),
  nodes: [a, b],
  edges: [makeEdge({ kind: 'MAPS_TO_FIELD', src: a.id, dst: b.id, confidence: 0.9 })],
  results: [],
};

const snapshotB: Snapshot = {
  runId: 'run-2',
  run: makeRun('run-2', []),
  nodes: [{ ...a, props: { nullable: true } }, b, c],
  edges: [makeEdge({ kind: 'MAPS_TO_FIELD', src: a.id, dst: b.id, confidence: 0.5 })],
  results: [],
};

test('SIF round-trips through serialize and parse', () => {
  const text = serializeSif(snapshotA);
  const parsed = parseSif(text, 'test');
  assert.equal(parsed.runId, 'run-1');
  assert.deepEqual(parsed.nodes.map((n) => n.id).sort(), [a.id, b.id].sort());
  assert.equal(parsed.edges.length, 1);
  assert.equal(parsed.edges[0]?.kind, 'MAPS_TO_FIELD');
});

test('SIF serialization is stable under input reordering', () => {
  const reordered: Snapshot = { ...snapshotA, nodes: [...snapshotA.nodes].reverse() };
  assert.equal(serializeSif(reordered), serializeSif(snapshotA));
});

test('diffSnapshots reports added, removed, and changed with the specific field', () => {
  const report = diffSnapshots('run-1', 'run-2', snapshotA, snapshotB);
  assert.equal(report.identical, false);
  assert.deepEqual(report.nodes.added, [c.id]);
  assert.deepEqual(report.nodes.removed, []);
  assert.equal(report.nodes.changed.length, 1);
  assert.equal(report.nodes.changed[0]?.id, a.id);
  assert.deepEqual(report.nodes.changed[0]?.changes.map((ch) => ch.field), ['props']);
  assert.equal(report.edges.changed.length, 1, 'the confidence change on the edge is reported');
});

test('diffSnapshots reports identical for two equal snapshots', () => {
  const report = diffSnapshots('a', 'b', snapshotA, snapshotA);
  assert.equal(report.identical, true);
});

test('seamline diff reads two .sif files and reports the difference', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-diff-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')), 'utf8');
  const outDir = path.join(dir, 'seamline-out');
  await mkdir(path.join(outDir, 'runs'), { recursive: true });
  await writeFile(path.join(outDir, 'runs', 'run-1.sif'), serializeSif(snapshotA), 'utf8');
  await writeFile(path.join(outDir, 'runs', 'run-2.sif'), serializeSif(snapshotB), 'utf8');

  const io = bufferIo({ cwd: dir, isTty: false, env: {} });
  const deps: CliDeps = {
    io,
    clock: { now: () => 'now', runId: () => 'r' },
    snapshots: fileSnapshots(),
  };

  const code = await runCli(deps, ['diff', 'run-1', 'run-2', '--json']);
  assert.equal(code, EXIT_OK, io.stderr());
  const report = JSON.parse(io.stdout()) as DiffReport;
  assert.deepEqual(report.nodes.added, [c.id]);
  assert.equal(report.identical, false);
});

test('diff with one ref is a usage error', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-diff-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')), 'utf8');
  const io = bufferIo({ cwd: dir, isTty: false, env: {} });
  const code = await runCli(
    { io, clock: { now: () => 'n', runId: () => 'r' }, snapshots: fileSnapshots() },
    ['diff', 'run-1'],
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(io.stderr(), /two refs/);
});

test('diff against a missing snapshot names the path it looked at', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-diff-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')), 'utf8');
  const io = bufferIo({ cwd: dir, isTty: false, env: {} });
  const code = await runCli(
    { io, clock: { now: () => 'n', runId: () => 'r' }, snapshots: fileSnapshots() },
    ['diff', 'run-1', 'run-2'],
  );
  assert.equal(code, EXIT_USAGE);
  assert.match(io.stderr(), /cannot read snapshot/);
  assert.match(io.stderr(), /run-1\.sif/);
});
