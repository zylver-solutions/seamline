/**
 * Run identity under `SEAMLINE_DETERMINISTIC=1`, end to end through
 * `seamline extract` and a real SQLite store.
 *
 * Deterministic mode used to give every run the id `run-deterministic-0000`, so
 * a consumer that records or compares runs could not tell two runs apart, and a
 * second run into the same store was refused as a duplicate. The run id is now
 * derived from the run's inputs (see `../run-inputs.ts`). What these tests pin
 * is the observable contract:
 *
 * - runs over different trees get different ids, and the store orders and
 *   tombstones them by the order they ran in, never by the ids' sort order;
 * - runs over the same inputs get the same id and the same bytes, wherever the
 *   tree lives;
 * - running the same inputs again into one store is idempotent;
 * - the run id is only as complete as the inputs it hashes, and the store does not
 *   rely on it being complete: an extractor that reads something the id leaves out
 *   (`node_modules`) can reach the store twice under one id with different facts,
 *   and the second attempt still buries what the first stored and it no longer
 *   produces.
 *
 * The extractor is a stand-in that reads the tree (one `File` node per `*.txt`
 * file at the repository root), so the tests control exactly which facts exist
 * without depending on a real extractor's behaviour. Everything below it, the
 * CLI, the clock, the store and the snapshot writer, is the production wiring.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { SqliteStore } from '@seamline/core';
import { nodeId, type NodeId } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo, EXIT_OK, systemClock } from '../io.ts';
import type { CliDeps, ExtractorPort } from '../ports.ts';
import { runCli } from '../run.ts';
import { fileSnapshots } from '../sif.ts';
import { makeNode } from '../testing.ts';
import { sqliteStorePort } from '../wiring.ts';
import type { DiffReport } from './diff.ts';
import type { ExtractReport } from './extract.ts';

const REPO = 'demo';
const EXTRACTOR = 'fake-tree';
const SCOPE = 'fake.files';

/** The shape of a deterministic run id: stable length, recognisable prefix. */
const DETERMINISTIC_RUN_ID = /^run-det-[0-9a-f]{16}$/;

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `seamline-runid-${label}-`));
  scratch.push(dir);
  return dir;
}

/** A repository containing a config and the given files. */
function tree(files: Readonly<Record<string, string>>, label = 'tree'): string {
  const dir = scratchDir(label);
  const config = {
    ...defaultConfig(REPO),
    extractors: [{ name: EXTRACTOR, enabled: true, options: {} }],
  };
  writeFileSync(path.join(dir, CONFIG_FILENAME), serializeConfig(config), 'utf8');
  for (const [name, text] of Object.entries(files))
    writeFileSync(path.join(dir, name), text, 'utf8');
  return dir;
}

function fileId(name: string): NodeId {
  return nodeId(REPO, 'File', name);
}

/** One `File` node per `*.txt` at the repository root, authoritative for exactly those. */
function treeExtractor(): ExtractorPort {
  return {
    name: EXTRACTOR,
    version: '1.0.0',
    provenanceCeiling: 'EXTRACTED',
    extract: (ctx) => {
      const names = readdirSync(ctx.repoRoot)
        .filter((n) => n.endsWith('.txt'))
        .sort();
      const nodes = names.map((name) => ({
        ...makeNode({ repo: REPO, kind: 'File', canonicalName: name, name, path: name }),
        firstSeenRun: ctx.runId,
        lastSeenRun: ctx.runId,
      }));
      return Promise.resolve({
        result: {
          extractor: EXTRACTOR,
          version: '1.0.0',
          status: 'PASS' as const,
          authoritative: [{ scope: SCOPE, kinds: ['File' as const], selector: '**/*.txt' }],
          nodeCount: nodes.length,
          edgeCount: 0,
          durationMs: 0,
          diagnostics: [],
        },
        nodes,
        edges: [],
      });
    },
  };
}

/**
 * `treeExtractor`, plus an input the run id does not cover: the tool reads
 * `node_modules/dep/names`, one `<name>.txt` file node per line, as a real
 * extractor reads installed dependencies through module resolution. If
 * `node_modules/dep/state` says `down` it reports UNAVAILABLE and emits nothing.
 */
function depExtractor(): ExtractorPort {
  const base = treeExtractor();
  return {
    ...base,
    extract: async (ctx) => {
      const dep = path.join(ctx.repoRoot, 'node_modules', 'dep');
      const state = readFileSync(path.join(dep, 'state'), 'utf8').trim();
      const { result, nodes, edges } = await base.extract(ctx);
      if (state === 'down') {
        return {
          result: {
            ...result,
            status: 'UNAVAILABLE' as const,
            nodeCount: 0,
            diagnostics: ['dep is down'],
          },
          nodes: [],
          edges: [],
        };
      }
      const extra = readFileSync(path.join(dep, 'names'), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .sort()
        .map((name) => ({
          ...makeNode({ repo: REPO, kind: 'File', canonicalName: name, name, path: name }),
          firstSeenRun: ctx.runId,
          lastSeenRun: ctx.runId,
        }));
      const all = [...nodes, ...extra].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { result: { ...result, nodeCount: all.length }, nodes: all, edges };
    },
  };
}

/** A repository whose extractor also reads `node_modules/dep`, which the run id skips. */
function treeWithDep(names: readonly string[], state = 'up'): string {
  const dir = tree({ 'a.txt': 'alpha\n' }, 'dep-tree');
  setDep(dir, names, state);
  return dir;
}

function setDep(dir: string, names: readonly string[], state = 'up'): void {
  const dep = path.join(dir, 'node_modules', 'dep');
  mkdirSync(dep, { recursive: true });
  writeFileSync(path.join(dep, 'names'), names.map((n) => `${n}\n`).join(''), 'utf8');
  writeFileSync(path.join(dep, 'state'), `${state}\n`, 'utf8');
}

interface Extraction {
  readonly code: number;
  readonly stderr: string;
  readonly runId: string;
  readonly sifPath: string;
}

/**
 * One `seamline extract`, as a fresh process would run it: a new clock, a new
 * store connection, deterministic mode on.
 */
async function extract(
  repoDir: string,
  outDir: string,
  extractor: ExtractorPort = treeExtractor(),
): Promise<Extraction> {
  const io = bufferIo({ cwd: repoDir, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const deps: CliDeps = {
    io,
    clock: systemClock(io.env),
    store: sqliteStorePort(),
    extractors: [extractor],
    snapshots: fileSnapshots(),
  };
  const code = await runCli(deps, ['extract', '--out', outDir, '--json']);
  const stdout = io.stdout();
  const runId = stdout.trim().length > 0 ? (JSON.parse(stdout) as ExtractReport).runId : '';
  return { code, stderr: io.stderr(), runId, sifPath: path.join(outDir, 'runs', `${runId}.sif`) };
}

function storeDir(): string {
  return path.join(scratchDir('out'), 'seamline-out');
}

/** The stored row for a node, tombstoned or not. `store.node()` hides tombstones. */
function nodeRow(
  outDir: string,
  id: NodeId,
): { first_seen_run: string; last_seen_run: string; deleted_at: string | null } | undefined {
  const db = new DatabaseSync(path.join(outDir, 'graph.db'), { readOnly: true });
  try {
    return db
      .prepare('SELECT first_seen_run, last_seen_run, deleted_at FROM nodes WHERE id = :id')
      .get({ id }) as
      { first_seen_run: string; last_seen_run: string; deleted_at: string | null } | undefined;
  } finally {
    db.close();
  }
}

async function recordedRunIds(outDir: string): Promise<string[]> {
  const store = new SqliteStore({ path: path.join(outDir, 'graph.db') });
  try {
    return (await store.listRuns(50)).map((r) => r.runId);
  } finally {
    await store.close();
  }
}

test('runs over different trees get different run ids, and the second tombstones the file deleted between them', async () => {
  const repoDir = tree({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  const outDir = storeDir();

  const first = await extract(repoDir, outDir);
  assert.equal(first.code, EXIT_OK, first.stderr);

  rmSync(path.join(repoDir, 'b.txt'));
  const second = await extract(repoDir, outDir);
  assert.equal(second.code, EXIT_OK, second.stderr);

  assert.notEqual(second.runId, first.runId, 'a different tree is a different run');
  assert.match(first.runId, DETERMINISTIC_RUN_ID);
  assert.match(second.runId, DETERMINISTIC_RUN_ID);

  const b = nodeRow(outDir, fileId('b.txt'));
  assert.ok(b, 'a tombstoned node keeps its row');
  assert.equal(b.deleted_at, second.runId, 'b.txt vanished in the second run, which buried it');
  assert.equal(b.last_seen_run, first.runId);
  assert.equal(b.first_seen_run, first.runId);

  const a = nodeRow(outDir, fileId('a.txt'));
  assert.ok(a);
  assert.equal(a.deleted_at, null, 'a.txt is in both runs and stays live');
  assert.equal(a.first_seen_run, first.runId);
  assert.equal(a.last_seen_run, second.runId);

  const store = new SqliteStore({ path: path.join(outDir, 'graph.db') });
  try {
    assert.equal(store.node(fileId('b.txt')), undefined, 'the tombstoned node is not returned');
    assert.ok(store.node(fileId('a.txt')));
    assert.deepEqual(
      (await store.listRuns(10)).map((r) => r.runId),
      [second.runId, first.runId],
      'both runs are on record, newest first',
    );
  } finally {
    await store.close();
  }

  const firstBytes = readFileSync(first.sifPath);
  const secondBytes = readFileSync(second.sifPath);
  assert.ok(firstBytes.length > 0 && secondBytes.length > 0, 'each run keeps its own snapshot');
  assert.notDeepEqual(firstBytes, secondBytes);
});

test('seamline diff compares two deterministic runs by id, each of which kept its own snapshot', async () => {
  const repoDir = tree({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  const outDir = storeDir();
  const first = await extract(repoDir, outDir);
  rmSync(path.join(repoDir, 'b.txt'));
  const second = await extract(repoDir, outDir);

  const io = bufferIo({ cwd: repoDir, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const code = await runCli({ io, clock: systemClock(io.env), snapshots: fileSnapshots() }, [
    'diff',
    first.runId,
    second.runId,
    '--out',
    outDir,
    '--json',
  ]);
  assert.equal(code, EXIT_OK, io.stderr());
  const report = JSON.parse(io.stdout()) as DiffReport;
  assert.deepEqual(report.nodes.removed, [fileId('b.txt')]);
  assert.deepEqual(report.nodes.added, []);
  assert.equal(report.identical, false);
});

test('run order comes from the order the runs happened in, not from how the ids sort', async () => {
  const withB = { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' };
  const withoutB = { 'a.txt': 'alpha\n' };

  // The same two trees, run in both orders into two stores. Exactly one of the
  // two stores sees its earlier run's id sort after its later run's id, so the
  // assertions below cover both orderings without hunting for a lucky pair.
  const sequences: Array<{
    readonly earlier: Record<string, string>;
    readonly later: Record<string, string>;
  }> = [
    { earlier: withB, later: withoutB },
    { earlier: withoutB, later: withB },
  ];
  const sortsLater: boolean[] = [];
  for (const { earlier, later } of sequences) {
    const repoDir = tree(earlier);
    const outDir = storeDir();
    const first = await extract(repoDir, outDir);
    for (const name of readdirSync(repoDir).filter((n) => n.endsWith('.txt'))) {
      rmSync(path.join(repoDir, name));
    }
    for (const [name, text] of Object.entries(later))
      writeFileSync(path.join(repoDir, name), text, 'utf8');
    const second = await extract(repoDir, outDir);
    assert.equal(first.code, EXIT_OK, first.stderr);
    assert.equal(second.code, EXIT_OK, second.stderr);
    assert.notEqual(first.runId, second.runId);

    assert.deepEqual(await recordedRunIds(outDir), [second.runId, first.runId]);
    sortsLater.push(first.runId < second.runId);

    const b = nodeRow(outDir, fileId('b.txt'));
    assert.ok(b);
    if (Object.hasOwn(later, 'b.txt')) {
      assert.equal(b.deleted_at, null, 'b.txt is back in the later run');
    } else {
      assert.equal(b.deleted_at, second.runId, 'b.txt is gone from the later run');
    }
  }
  assert.deepEqual(
    [...sortsLater].sort(),
    [false, true],
    'one store ran its lexicographically smaller id first and the other ran it second',
  );
});

test('the same tree in two stores gets the same run id and byte-identical snapshots, wherever it lives', async () => {
  const files = { 'a.txt': 'alpha\n', 'b.txt': 'beta\n' };
  const one = await extract(tree(files, 'here'), storeDir());
  const two = await extract(tree(files, 'there'), storeDir());
  assert.equal(one.code, EXIT_OK, one.stderr);
  assert.equal(two.code, EXIT_OK, two.stderr);

  assert.match(one.runId, DETERMINISTIC_RUN_ID);
  assert.equal(
    two.runId,
    one.runId,
    'the id is a function of the inputs, not of the checkout path',
  );
  assert.deepEqual(readFileSync(two.sifPath), readFileSync(one.sifPath));
});

test('running the identical run twice into one store is idempotent', async () => {
  const repoDir = tree({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  const outDir = storeDir();

  const first = await extract(repoDir, outDir);
  assert.equal(first.code, EXIT_OK, first.stderr);
  const firstBytes = readFileSync(first.sifPath);

  const again = await extract(repoDir, outDir);
  assert.equal(again.code, EXIT_OK, again.stderr);
  assert.equal(again.runId, first.runId);
  assert.deepEqual(readFileSync(again.sifPath), firstBytes, 'the snapshot is byte-identical');

  assert.deepEqual(
    await recordedRunIds(outDir),
    [first.runId],
    'one run on record, not a duplicate and not a successor',
  );
  for (const name of ['a.txt', 'b.txt']) {
    const row = nodeRow(outDir, fileId(name));
    assert.ok(row);
    assert.equal(row.deleted_at, null, `${name} was seen again, so nothing is buried`);
    assert.equal(row.first_seen_run, first.runId);
    assert.equal(row.last_seen_run, first.runId);
  }

  const store = new SqliteStore({ path: path.join(outDir, 'graph.db') });
  try {
    const [run] = await store.listRuns(1);
    assert.ok(run);
    assert.equal(run.results.length, 1, 'the run records one result per extractor, not two');
    assert.equal(run.finishedAt !== null, true, 'the repeated run is finalized');
  } finally {
    await store.close();
  }
});

test('reverting the tree to an earlier state reuses that run id and brings its facts back to life', async () => {
  const repoDir = tree({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  const outDir = storeDir();

  const x = await extract(repoDir, outDir);
  rmSync(path.join(repoDir, 'b.txt'));
  const y = await extract(repoDir, outDir);
  writeFileSync(path.join(repoDir, 'b.txt'), 'beta\n', 'utf8');
  const xAgain = await extract(repoDir, outDir);

  for (const run of [x, y, xAgain]) assert.equal(run.code, EXIT_OK, run.stderr);
  assert.notEqual(y.runId, x.runId);
  assert.equal(
    xAgain.runId,
    x.runId,
    'identical inputs, identical id, even after a different run in between',
  );

  const b = nodeRow(outDir, fileId('b.txt'));
  assert.ok(b);
  assert.equal(b.deleted_at, null, 'b.txt is back, so the tombstone is cleared');
  assert.deepEqual(
    await recordedRunIds(outDir),
    [x.runId, y.runId],
    'the revert ran last, so it is the latest run',
  );

  // And the other direction: the revert must still bury what the tree lost.
  writeFileSync(path.join(repoDir, 'c.txt'), 'gamma\n', 'utf8');
  const z = await extract(repoDir, outDir);
  rmSync(path.join(repoDir, 'c.txt'));
  const xThird = await extract(repoDir, outDir);
  assert.equal(z.code, EXIT_OK, z.stderr);
  assert.equal(xThird.runId, x.runId);
  const c = nodeRow(outDir, fileId('c.txt'));
  assert.ok(c);
  assert.equal(c.deleted_at, x.runId, 'c.txt is gone again, buried by the reused id');
});

test('a run left unfinished can be retried with the same inputs', async () => {
  // A crash between beginRun and finalizeRun leaves the run open. The retry
  // has the same inputs, so the same id; it must not be refused as a duplicate.
  const repoDir = tree({ 'a.txt': 'alpha\n' });
  const outDir = storeDir();
  const done = await extract(repoDir, outDir);
  assert.equal(done.code, EXIT_OK, done.stderr);

  const db = new DatabaseSync(path.join(outDir, 'graph.db'));
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM authority_claims_v2 WHERE run_id = :id').run({ id: done.runId });
    db.prepare('DELETE FROM extractor_results WHERE run_id = :id').run({ id: done.runId });
    db.prepare('UPDATE runs SET finished_at = NULL WHERE run_id = :id').run({ id: done.runId });
  } finally {
    db.close();
  }

  const retry = await extract(repoDir, outDir);
  assert.equal(retry.code, EXIT_OK, retry.stderr);
  assert.equal(retry.runId, done.runId);
  const store = new SqliteStore({ path: path.join(outDir, 'graph.db') });
  try {
    const [run] = await store.listRuns(1);
    assert.ok(run?.finishedAt !== null, 'the retried run is finalized');
    assert.equal(run?.results.length, 1);
  } finally {
    await store.close();
  }
});

test('a config edit that does not change what is extracted leaves the run id alone, one that does changes it', async () => {
  const repoDir = tree({ 'a.txt': 'alpha\n' });
  const first = await extract(repoDir, storeDir());

  // Export profiles shape `seamline export`, not the graph.
  const config = {
    ...defaultConfig(REPO),
    extractors: [{ name: EXTRACTOR, enabled: true, options: {} }],
  };
  const widened = { ...config, exportProfiles: {} };
  writeFileSync(path.join(repoDir, CONFIG_FILENAME), serializeConfig(widened), 'utf8');
  const exportOnly = await extract(repoDir, storeDir());
  assert.equal(exportOnly.runId, first.runId);

  // An extractor option does.
  const withOption = {
    ...config,
    extractors: [{ name: EXTRACTOR, enabled: true, options: { depth: 3 } }],
  };
  writeFileSync(path.join(repoDir, CONFIG_FILENAME), serializeConfig(withOption), 'utf8');
  const optioned = await extract(repoDir, storeDir());
  assert.notEqual(optioned.runId, first.runId);
  assert.match(optioned.runId, DETERMINISTIC_RUN_ID);
});

test('the output directory is not an input: a store inside the repository does not change the run id', async () => {
  const repoDir = tree({ 'a.txt': 'alpha\n' });
  const outside = await extract(repoDir, storeDir());
  const inRepo = path.join(repoDir, 'graph-out');
  const inside = await extract(repoDir, inRepo);
  const insideAgain = await extract(repoDir, inRepo);
  assert.equal(inside.runId, outside.runId);
  assert.equal(
    insideAgain.runId,
    outside.runId,
    'the first run already wrote graph.db and runs/ there',
  );
});

test('an input the run id does not cover changes between two runs: the same id still buries what the second attempt no longer produces', async () => {
  // `node_modules` is not hashed, so editing it leaves the run id alone. The
  // extractor reads it, so the facts change under a repeated id.
  const repoDir = treeWithDep(['x.txt', 'y.txt']);
  const outDir = storeDir();

  const first = await extract(repoDir, outDir, depExtractor());
  assert.equal(first.code, EXIT_OK, first.stderr);
  for (const name of ['a.txt', 'x.txt', 'y.txt']) {
    assert.equal(
      nodeRow(outDir, fileId(name))?.deleted_at,
      null,
      `${name} is live after the first run`,
    );
  }

  setDep(repoDir, ['x.txt']);
  const second = await extract(repoDir, outDir, depExtractor());
  assert.equal(second.code, EXIT_OK, second.stderr);
  assert.equal(second.runId, first.runId, 'the id cannot see node_modules, so it repeats');

  const y = nodeRow(outDir, fileId('y.txt'));
  assert.ok(y, 'a tombstoned node keeps its row');
  assert.equal(y.deleted_at, first.runId, 'y.txt is gone from the second attempt, so it is buried');
  assert.equal(y.last_seen_run, '', 'and no run has seen it since');
  for (const name of ['a.txt', 'x.txt']) {
    const row = nodeRow(outDir, fileId(name));
    assert.equal(row?.deleted_at, null, `${name} was seen again`);
    assert.equal(row?.last_seen_run, first.runId);
  }
  assert.deepEqual(await recordedRunIds(outDir), [first.runId], 'one run on record');

  const store = new SqliteStore({ path: path.join(outDir, 'graph.db') });
  try {
    assert.equal(store.node(fileId('y.txt')), undefined, 'the store no longer returns it');
    assert.ok(store.node(fileId('x.txt')));
  } finally {
    await store.close();
  }

  // And it comes back with the dependency.
  setDep(repoDir, ['x.txt', 'y.txt']);
  const third = await extract(repoDir, outDir, depExtractor());
  assert.equal(third.runId, first.runId);
  assert.equal(nodeRow(outDir, fileId('y.txt'))?.deleted_at, null, 'seen again, so it is live');
});

test('an input the run id does not cover leaves the extractor UNAVAILABLE on the repeated id: the first attempt facts stay live', async () => {
  const repoDir = treeWithDep(['x.txt', 'y.txt']);
  const outDir = storeDir();
  const first = await extract(repoDir, outDir, depExtractor());
  assert.equal(first.code, EXIT_OK, first.stderr);

  setDep(repoDir, [], 'down');
  const second = await extract(repoDir, outDir, depExtractor());
  assert.equal(second.code, EXIT_OK, second.stderr);
  assert.equal(second.runId, first.runId);

  // UNAVAILABLE is never PASS: the extractor did not look, so nothing vanished.
  for (const name of ['a.txt', 'x.txt', 'y.txt']) {
    const row = nodeRow(outDir, fileId(name));
    assert.equal(row?.deleted_at, null, `${name} stays live`);
    assert.equal(
      row?.last_seen_run,
      first.runId,
      `${name} keeps the stamp the first attempt gave it`,
    );
  }
  const store = new SqliteStore({ path: path.join(outDir, 'graph.db') });
  try {
    const [run] = await store.listRuns(1);
    assert.equal(run?.results[0]?.status, 'UNAVAILABLE', 'the latest attempt is what is on record');
  } finally {
    await store.close();
  }
});
