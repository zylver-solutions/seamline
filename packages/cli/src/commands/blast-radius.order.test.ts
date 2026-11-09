import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo, EXIT_OK } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { runCli } from '../run.ts';
import {
  makeEdge,
  makeNode,
  makeResult,
  makeRun,
  memoryGraph,
  memoryStorePort,
  type MemoryGraph,
} from '../testing.ts';
import type { BlastRadiusReport } from './blast-radius.ts';

// ---------------------------------------------------------------------------
// Order is a code-unit order, never a locale order (invariant 4).
//
// 'B' (0x42) < '_' (0x5F) < 'a' (0x61) by code unit. An en-US collation orders
// `_ a B`.
// ---------------------------------------------------------------------------

async function repoWithConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-blast-order-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')), 'utf8');
  return dir;
}

function depsFor(cwd: string, graph: MemoryGraph): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env: {} });
  return {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(graph),
  };
}

const hub = makeNode({ kind: 'Symbol', canonicalName: 'hub' });
const leaves = ['a', 'B', '_x'].map((canonicalName) => makeNode({ kind: 'Symbol', canonicalName }));

function fanOut(): MemoryGraph {
  return memoryGraph({
    nodes: [hub, ...leaves],
    edges: leaves.map((leaf) => makeEdge({ kind: 'CALLS', src: hub.id, dst: leaf.id })),
    runs: [makeRun('run-1', [makeResult('extract-code-ts', 'PASS', ['code'])])],
  });
}

test('explicit roots are reported in code-unit order of their ids', async () => {
  const d = depsFor(await repoWithConfig(), fanOut());
  // Given in an order that is neither the code-unit order nor the locale order.
  const given = [leaves[0], hub, leaves[2], leaves[1]].map((n) => n?.id).join(',');
  const code = await runCli(d, ['blast-radius', '--ids', given, '--depth', '1', '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const report = JSON.parse(d.io.stdout()) as BlastRadiusReport;
  assert.deepEqual(
    report.roots.map((r) => r.id),
    ['demo:Symbol:B', 'demo:Symbol:_x', 'demo:Symbol:a', 'demo:Symbol:hub'],
  );
});

test('reached nodes of one kind and depth are listed in code-unit order of their ids', async () => {
  const d = depsFor(await repoWithConfig(), fanOut());
  const code = await runCli(d, ['blast-radius', '--ids', hub.id, '--depth', '1', '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const report = JSON.parse(d.io.stdout()) as BlastRadiusReport;
  assert.equal(report.reached.length, 1);
  assert.deepEqual(
    report.reached[0]?.nodes.map((n) => n.id),
    ['demo:Symbol:B', 'demo:Symbol:_x', 'demo:Symbol:a'],
  );
});
