import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { nodeId } from '@seamline/ontology';
import type { ExtractorResult, NodeId, SeamlineNode } from '@seamline/ontology';

import { SqliteStore } from './sqlite-store.ts';
import { RunStateError, StoreError } from './schema.ts';
import {
  extractorResult,
  fileNode,
  fixedClock,
  importsEdge,
  makeEdge,
  makeNode,
  runRecord,
  scope,
} from './testing.ts';

const CODE_SCOPE = 'code.ts';
const DATA_SCOPE = 'data.sql';

const file = (path: string): NodeId => nodeId('app', 'File', path);

function store(): SqliteStore {
  return new SqliteStore({ ontologyVersion: '1.0.0', now: fixedClock() });
}

/** One run that writes two files and the import between them, then PASSes. */
async function seedTwoFiles(s: SqliteStore, runId = 'r1'): Promise<void> {
  const a = fileNode('src/a.ts');
  const b = fileNode('src/b.ts');
  await s.beginRun(runRecord(runId));
  await s.upsertNodes(runId, [a, b]);
  await s.upsertEdges(runId, CODE_SCOPE, [importsEdge(a, b)]);
  await s.finalizeRun(runId, [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])], { nodeCount: 2, edgeCount: 1 }),
  ]);
}

test('nodes and edges round-trip through the store unchanged', async () => {
  const s = store();
  const a = makeNode({
    name: 'src/a.ts',
    path: 'src/a.ts',
    props: { loc: 12, generated: false, note: null, tag: 'x' },
    sourceRef: 'src/a.ts#L1',
    untrusted: true,
    confidence: 0.75,
  });
  const b = fileNode('src/b.ts');
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [a, b]);
  await s.upsertEdges('r1', CODE_SCOPE, [importsEdge(a, b)]);

  const read = s.node(a.id);
  assert.ok(read !== undefined);
  assert.deepEqual(read, {
    ...a,
    firstSeenRun: 'r1',
    lastSeenRun: 'r1',
  });
  assert.equal(read.props['loc'], 12);
  assert.equal(read.props['generated'], false);
  assert.equal(read.props['note'], null);
  assert.equal(read.untrusted, true);

  const out = s.edgesFrom(a.id);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.dst, b.id);
  assert.equal(out[0]?.srcFile, 'src/a.ts');
  assert.equal(out[0]?.dstFile, 'src/b.ts');
  assert.deepEqual(
    s.edgesTo(b.id, 'IMPORTS').map((e) => e.src),
    [a.id],
  );
  assert.deepEqual(s.edgesTo(b.id, 'CALLS'), []);
  assert.deepEqual(
    s.nodesByKind('File').map((n) => n.id),
    [a.id, b.id],
  );
  assert.deepEqual(s.nodesByKind('Table'), []);
  await s.close();
});

test('upsertEdges rejects two assertions of the same edge identity in one batch', async () => {
  const s = store();
  const a = fileNode('src/a.ts');
  const b = fileNode('src/b.ts');
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [a, b]);
  await assert.rejects(
    s.upsertEdges('r1', CODE_SCOPE, [importsEdge(a, b), importsEdge(a, b)]),
    /duplicate edge in one batch/,
  );
  assert.deepEqual(s.edgesFrom(a.id), []);
  await s.close();
});

test('upsertEdges rejects an edge outside its declared domain and range', async () => {
  const s = store();
  const table = makeNode({ name: 'public.users', kind: 'Table' });
  const f = fileNode('src/a.ts');
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [table, f]);
  await assert.rejects(
    s.upsertEdges('r1', CODE_SCOPE, [makeEdge({ src: f.id, dst: table.id, kind: 'IMPORTS' })]),
    (error: unknown) => {
      assert.ok(error instanceof StoreError);
      assert.match(error.message, /IMPORTS is not declared for File -> Table/);
      return true;
    },
  );
  await s.close();
});

test('re-observing an edge updates it in place instead of duplicating it', async () => {
  const s = store();
  await seedTwoFiles(s, 'r1');
  const a = fileNode('src/a.ts');
  const b = fileNode('src/b.ts');

  await s.beginRun(runRecord('r2'));
  await s.upsertNodes('r2', [a, b]);
  await s.upsertEdges('r2', CODE_SCOPE, [importsEdge(a, b)]);
  await s.finalizeRun('r2', [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])], { nodeCount: 2, edgeCount: 1 }),
  ]);

  const edges = s.edgesFrom(a.id);
  assert.equal(edges.length, 1);
  assert.equal(edges[0]?.firstSeenRun, 'r1', 'history survives the re-observation');
  assert.equal(edges[0]?.lastSeenRun, 'r2');
  assert.equal(s.node(a.id)?.firstSeenRun, 'r1');
  assert.equal(s.node(a.id)?.lastSeenRun, 'r2');
  await s.close();
});

test('a source file that vanishes is tombstoned and stops appearing in reads', async () => {
  const s = store();
  await seedTwoFiles(s, 'r1');
  assert.equal(s.nodesByKind('File').length, 2);

  // Second run sees only a.ts: b.ts was deleted from the working tree.
  const a = fileNode('src/a.ts');
  await s.beginRun(runRecord('r2'));
  await s.upsertNodes('r2', [a]);
  await s.finalizeRun('r2', [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])], { nodeCount: 1, edgeCount: 0 }),
  ]);

  assert.equal(s.node(file('src/b.ts')), undefined);
  assert.deepEqual(
    s.nodesByKind('File').map((n) => n.id),
    [a.id],
  );
  assert.deepEqual(s.edgesFrom(a.id), [], 'edges into a tombstoned node stop being returned');
  assert.deepEqual(s.edgesTo(file('src/b.ts')), []);

  const reachable = await s.traverse({ from: [a.id], via: ['IMPORTS'], maxDepth: 3 });
  assert.equal(reachable.known, true);
  assert.deepEqual(reachable.known ? reachable.value : null, []);
  await s.close();
});

test('nothing is hard-deleted: the tombstoned row is still on disk with deleted_at set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seamline-store-'));
  const path = join(dir, 'graph.db');
  try {
    const s = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock() });
    await seedTwoFiles(s, 'r1');
    await s.beginRun(runRecord('r2'));
    await s.upsertNodes('r2', [fileNode('src/a.ts')]);
    await s.finalizeRun('r2', [
      extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])], { nodeCount: 1 }),
    ]);
    await s.close();

    const raw = new DatabaseSync(path);
    const row = raw
      .prepare('SELECT deleted_at, first_seen_run, last_seen_run FROM nodes WHERE id = :id')
      .get({ id: file('src/b.ts') }) as
      { deleted_at: string | null; first_seen_run: string; last_seen_run: string } | undefined;
    assert.ok(row !== undefined, 'the row survives as a tombstone');
    // `deleted_at` holds the RUN ID that buried the row, never a wall clock.
    // merge/lifecycle derives liveness as `deletedAt > lastSeenRun` comparing run
    // ids, so a timestamp here compiles (both are `string | null`) and silently
    // computes wrong liveness. Asserting the run id -- and asserting the value is
    // NOT ISO-8601 -- is what makes that divergence a test failure instead of a
    // production bug.
    assert.equal(row.deleted_at, 'r2');
    assert.doesNotMatch(
      row.deleted_at ?? '',
      /^\d{4}-\d{2}-\d{2}T/,
      'deleted_at must be a run id, not a timestamp',
    );
    assert.equal(row.first_seen_run, 'r1');
    assert.equal(row.last_seen_run, 'r1');
    const edge = raw
      .prepare('SELECT deleted_at FROM edges WHERE dst_id = :id')
      .get({ id: file('src/b.ts') }) as { deleted_at: string | null } | undefined;
    assert.equal(edge?.deleted_at, 'r2');
    assert.doesNotMatch(
      edge?.deleted_at ?? '',
      /^\d{4}-\d{2}-\d{2}T/,
      'edge deleted_at must be a run id, not a timestamp',
    );
    raw.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a tombstoned node that reappears is resurrected with deleted_at cleared', async () => {
  const s = store();
  await seedTwoFiles(s, 'r1');

  await s.beginRun(runRecord('r2'));
  await s.upsertNodes('r2', [fileNode('src/a.ts')]);
  await s.finalizeRun('r2', [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])], { nodeCount: 1 }),
  ]);
  assert.equal(s.node(file('src/b.ts')), undefined);

  // The file comes back: a reverted delete, or a branch switch.
  const a = fileNode('src/a.ts');
  const b = fileNode('src/b.ts');
  await s.beginRun(runRecord('r3'));
  await s.upsertNodes('r3', [a, b]);
  await s.upsertEdges('r3', CODE_SCOPE, [importsEdge(a, b)]);
  await s.finalizeRun('r3', [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])], { nodeCount: 2, edgeCount: 1 }),
  ]);

  const revived = s.node(b.id);
  assert.ok(revived !== undefined, 'the node is visible again');
  assert.equal(revived.deletedAt, null);
  assert.equal(revived.firstSeenRun, 'r1', 'resurrected, not shadowed by a new row');
  assert.equal(revived.lastSeenRun, 'r3');
  assert.equal(s.edgesFrom(a.id).length, 1);
  assert.equal(s.edgesFrom(a.id)[0]?.deletedAt, null);
  await s.close();
});

test('a run outside a scope leaves that scope rows bit-identical', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seamline-scope-'));
  const path = join(dir, 'graph.db');
  try {
    const s = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock() });
    const a = fileNode('src/a.ts');
    const b = fileNode('src/b.ts');
    const users = makeNode({ name: 'public.users', kind: 'Table' });
    const orderUserId = makeNode({ name: 'public.orders.user_id', kind: 'Column' });
    const userId = makeNode({ name: 'public.users.id', kind: 'Column' });

    await s.beginRun(runRecord('r1'));
    await s.upsertNodes('r1', [a, b, users, orderUserId, userId]);
    await s.upsertEdges('r1', CODE_SCOPE, [importsEdge(a, b)]);
    await s.upsertEdges('r1', DATA_SCOPE, [
      makeEdge({ src: orderUserId.id, dst: userId.id, kind: 'FK_TO' }),
    ]);
    await s.finalizeRun('r1', [
      extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])]),
      extractorResult('sql', 'PASS', [scope(DATA_SCOPE, ['Table', 'Column'])]),
    ]);
    await s.close();

    const dump = (): string => {
      const raw = new DatabaseSync(path);
      const nodes = raw
        .prepare("SELECT * FROM nodes WHERE kind IN ('Table', 'Column') ORDER BY id")
        .all();
      const edges = raw.prepare('SELECT * FROM edges WHERE scope = :s ORDER BY src_id').all({
        s: DATA_SCOPE,
      });
      raw.close();
      return JSON.stringify({ nodes, edges });
    };
    const before = dump();

    // A code-only run: it re-extracts nothing in the data scope and does not
    // claim authority over it, so it may not touch a single one of its rows.
    const s2 = new SqliteStore({
      path,
      ontologyVersion: '1.0.0',
      now: fixedClock('2027-01-01T00:00:00.000Z'),
    });
    await s2.beginRun(runRecord('r2'));
    await s2.upsertNodes('r2', [fileNode('src/a.ts')]);
    await s2.finalizeRun('r2', [extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])])]);
    assert.equal(s2.node(file('src/b.ts')), undefined, 'the code scope was still swept');
    await s2.close();

    assert.equal(dump(), before, 'the data scope is byte-identical after a code-only run');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a non-PASS extractor tombstones nothing', async () => {
  for (const status of ['FAIL', 'UNAVAILABLE'] as const) {
    const s = store();
    await seedTwoFiles(s, 'r1');
    const before = s.nodesByKind('File');

    // The extractor crashed after emitting nothing. Sweeping here would delete
    // the graph and then report it as clean.
    await s.beginRun(runRecord('r2'));
    await s.finalizeRun('r2', [
      extractorResult('ts', status, [scope(CODE_SCOPE, ['File'])], {
        diagnostics: ['worker exited with signal SIGKILL'],
      }),
    ]);

    assert.deepEqual(s.nodesByKind('File'), before, `${status} left the nodes untouched`);
    assert.equal(s.edgesFrom(file('src/a.ts')).length, 1, `${status} left the edges untouched`);
    assert.equal(s.scopeStatus(CODE_SCOPE), status);
    await s.close();
  }
});

test('a selector narrows the sweep to the paths the run was authoritative for', async () => {
  const s = store();
  const app = fileNode('src/app/a.ts');
  const lib = fileNode('src/lib/b.ts');
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [app, lib]);
  await s.finalizeRun('r1', [extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])])]);

  // Run 2 is authoritative only for src/app, and sees nothing there any more.
  await s.beginRun(runRecord('r2'));
  await s.finalizeRun('r2', [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'], 'src/app/*')]),
  ]);

  assert.equal(s.node(app.id), undefined, 'inside the selector, the vanished file is tombstoned');
  assert.ok(s.node(lib.id) !== undefined, 'outside the selector, nothing is touched');
  await s.close();
});

test('a brace selector with a leading **/ sweeps root-level and nested files, and nothing else', async () => {
  // The shipped code.ts selector is a POSIX brace glob. Handed to SQLite GLOB
  // verbatim it matched no path at all, and `**/*.ts` alone misses `a.ts`.
  const s = store();
  const rootLevel = fileNode('a.ts');
  const nested = fileNode('src/deep/b.tsx');
  const readme = fileNode('README.md');
  const snapshot = fileNode('src/b.tsx.snap');
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [rootLevel, nested, readme, snapshot]);
  await s.finalizeRun('r1', [extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])])]);

  await s.beginRun(runRecord('r2'));
  await s.finalizeRun('r2', [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'], '**/*.{ts,tsx}')]),
  ]);

  assert.equal(s.node(rootLevel.id), undefined, 'a root-level file is inside **/*.ts');
  assert.equal(s.node(nested.id), undefined);
  assert.deepEqual(
    s.nodesByKind('File').map((n) => n.path),
    ['README.md', 'src/b.tsx.snap'],
  );
  await s.close();
});

test('a long literal-path selector sweeps exactly the listed paths', async () => {
  // One bound parameter, not an OR chain: SQLite caps expression depth at 1000.
  const s = store();
  const listed = fileNode('src/m1500.ts');
  const bracketed = fileNode('app/[id]/page.tsx');
  const unlisted = fileNode('src/other.ts');
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [listed, bracketed, unlisted]);
  await s.finalizeRun('r1', [extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])])]);

  const paths = [...Array.from({ length: 3000 }, (_, i) => `src/m${i}.ts`), 'app/[id]/page.tsx'];
  await s.beginRun(runRecord('r2'));
  await s.finalizeRun('r2', [
    extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'], `{${paths.join(',')}}`)]),
  ]);

  assert.equal(s.node(listed.id), undefined);
  assert.equal(
    s.node(bracketed.id),
    undefined,
    '[id] is matched literally, not as a character class',
  );
  assert.ok(s.node(unlisted.id) !== undefined);
  await s.close();
});

test('a PASS result whose selector does not compile is refused before anything is written', async () => {
  const s = store();
  await seedTwoFiles(s, 'r1');
  const before = s.nodesByKind('File');

  await s.beginRun(runRecord('r2'));
  await assert.rejects(
    s.finalizeRun('r2', [
      extractorResult('ts', 'PASS', [
        scope(CODE_SCOPE, ['File'], '**/*.sql, **/*.prisma, Drizzle schema modules'),
      ]),
    ]),
    (e: unknown) => {
      assert.ok(e instanceof StoreError);
      assert.match(e.message, /extractor ts, scope code\.ts: invalid authoritative-scope selector/);
      return true;
    },
  );
  assert.deepEqual(s.nodesByKind('File'), before);
  const run = await s.getRun('r2');
  assert.equal(run?.finishedAt, null, 'the run was not finalized');
  assert.deepEqual(run?.results, [], 'no extractor result was recorded');

  // A non-PASS result is never swept, so its selector is recorded, not evaluated.
  await s.finalizeRun('r2', [
    extractorResult('ts', 'FAIL', [scope(CODE_SCOPE, ['File'], 'not a glob, just prose')]),
  ]);
  assert.deepEqual(s.nodesByKind('File'), before);
  assert.equal(s.scopeStatus(CODE_SCOPE), 'FAIL');
  await s.close();
});

test('scopeStatus reports UNAVAILABLE for a scope nobody has declared', async () => {
  const s = store();
  await seedTwoFiles(s, 'r1');
  assert.equal(s.scopeStatus(CODE_SCOPE), 'PASS');
  assert.equal(s.scopeStatus('never-run'), 'UNAVAILABLE');
  await s.close();
});

test('scopeStatus follows the latest run, in both directions', async () => {
  const s = store();
  await seedTwoFiles(s, 'r1');
  await s.beginRun(runRecord('r2'));
  await s.finalizeRun('r2', [extractorResult('ts', 'FAIL', [scope(CODE_SCOPE, ['File'])])]);
  assert.equal(s.scopeStatus(CODE_SCOPE), 'FAIL');

  await s.beginRun(runRecord('r3'));
  await s.upsertNodes('r3', [fileNode('src/a.ts'), fileNode('src/b.ts')]);
  await s.finalizeRun('r3', [extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])])]);
  assert.equal(s.scopeStatus(CODE_SCOPE), 'PASS', 'a recovered extractor restores the scope');
  await s.close();
});

test('edgesByFile finds the edges a changed file invalidates', async () => {
  const s = store();
  await seedTwoFiles(s, 'r1');
  assert.deepEqual(
    s.edgesByFile('src/b.ts').map((e) => `${e.src}->${e.dst}`),
    [`${file('src/a.ts')}->${file('src/b.ts')}`],
  );
  assert.deepEqual(s.edgesByFile('src/never.ts'), []);
  await s.close();
});

test('run lifecycle errors are loud', async () => {
  const s = store();
  await assert.rejects(s.upsertNodes('nope', [fileNode('src/a.ts')]), RunStateError);
  await s.beginRun(runRecord('r1'));
  await assert.rejects(s.beginRun(runRecord('r1')), /already exists/);
  await s.finalizeRun('r1', []);
  await assert.rejects(s.upsertNodes('r1', [fileNode('src/a.ts')]), /already finalized/);
  await s.close();
  assert.throws(() => s.nodesByKind('File'), /store is closed/);
});

test('a node whose declared kind disagrees with its natural key is rejected', async () => {
  const s = store();
  await s.beginRun(runRecord('r1'));
  const bogus = { ...fileNode('src/a.ts'), kind: 'Symbol' } as SeamlineNode;
  await assert.rejects(s.upsertNodes('r1', [bogus]), /natural key says File/);
  await s.close();
});

// ---------------------------------------------------------------------------
// restartRun: running a run id again (deterministic run ids repeat by design)
// ---------------------------------------------------------------------------

/** One extractor, PASS, authoritative over every `File` in `code.ts`. */
const codePass = (nodeCount: number): ExtractorResult =>
  extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])], { nodeCount });

async function runWith(s: SqliteStore, runId: string, paths: readonly string[]): Promise<void> {
  await s.beginRun(runRecord(runId));
  await s.upsertNodes(
    runId,
    paths.map((p) => fileNode(p)),
  );
  await s.finalizeRun(runId, [codePass(paths.length)]);
}

async function restartWith(s: SqliteStore, runId: string, paths: readonly string[]): Promise<void> {
  await s.restartRun(runRecord(runId));
  await s.upsertNodes(
    runId,
    paths.map((p) => fileNode(p)),
  );
  await s.finalizeRun(runId, [codePass(paths.length)]);
}

/** A live node's run stamps; `undefined` for a node that is buried or absent. */
function stamps(s: SqliteStore, path: string): { first: string; last: string } | undefined {
  const node = s.node(file(path));
  return node === undefined ? undefined : { first: node.firstSeenRun, last: node.lastSeenRun };
}

const runIds = async (s: SqliteStore): Promise<string[]> =>
  (await s.listRuns(10)).map((r) => r.runId);

test('restartRun repeats a finalized run without burying or duplicating anything', async () => {
  const s = store();
  await runWith(s, 'r1', ['src/a.ts', 'src/b.ts']);
  await restartWith(s, 'r1', ['src/a.ts', 'src/b.ts']);

  assert.deepEqual(await runIds(s), ['r1'], 'one run on record');
  const [run] = await s.listRuns(1);
  assert.equal(run?.results.length, 1, "the first attempt's results were replaced, not added to");
  assert.notEqual(run?.finishedAt, null);
  for (const path of ['src/a.ts', 'src/b.ts']) {
    assert.deepEqual(stamps(s, path), { first: 'r1', last: 'r1' });
  }
  await s.close();
});

test('restartRun makes the repeated run the newest, whatever the ids sort like', async () => {
  const s = store();
  await runWith(s, 'r1', ['src/a.ts', 'src/b.ts']);
  await runWith(s, 'r2', ['src/a.ts']);
  assert.equal(stamps(s, 'src/b.ts'), undefined, 'r2 buried b.ts');

  // r1's inputs come back. It is the same run id as the first, and it ran last.
  await restartWith(s, 'r1', ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(await runIds(s), ['r1', 'r2']);
  assert.deepEqual(
    stamps(s, 'src/b.ts'),
    { first: 'r1', last: 'r1' },
    'resurrected, tombstone cleared',
  );

  // The run after it orders after it, though 'r0' sorts before 'r1'.
  await runWith(s, 'r0', ['src/a.ts']);
  assert.deepEqual(await runIds(s), ['r0', 'r1', 'r2']);
  assert.equal(stamps(s, 'src/b.ts'), undefined, 'r0 ran after r1 and does not see b.ts');
  await s.close();
});

test('restartRun buries what the repeated run no longer sees, though the id was used before', async () => {
  const s = store();
  await runWith(s, 'r1', ['src/a.ts']);
  await runWith(s, 'r2', ['src/a.ts', 'src/c.ts']);
  await restartWith(s, 'r1', ['src/a.ts']);
  assert.equal(stamps(s, 'src/c.ts'), undefined, 'c.ts is not in r1, and r1 ran last');
  assert.equal(stamps(s, 'src/a.ts')?.last, 'r1');
  await s.close();
});

test("restartRun puts a re-declared scope's status back under the repeated run", async () => {
  const s = store();
  await runWith(s, 'r1', ['src/a.ts']);
  await s.beginRun(runRecord('r2'));
  await s.finalizeRun('r2', [extractorResult('ts', 'FAIL', [scope(CODE_SCOPE, ['File'])])]);
  assert.equal(s.scopeStatus(CODE_SCOPE), 'FAIL', 'r2 is the newest declaration');

  await restartWith(s, 'r1', ['src/a.ts']);
  assert.equal(
    s.scopeStatus(CODE_SCOPE),
    'PASS',
    'r1 ran again after r2, so its declaration is the newest',
  );
  await s.close();
});

test('restartRun reopens a run that was never finalized', async () => {
  const s = store();
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [fileNode('src/a.ts')]);
  // The process died here. The retry has the same inputs and so the same id.
  await restartWith(s, 'r1', ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(stamps(s, 'src/b.ts'), { first: 'r1', last: 'r1' });
  const [run] = await s.listRuns(1);
  assert.notEqual(run?.finishedAt, null);
  await s.close();
});

// The id of a run is derived from what its inputs look like, and no digest can
// cover everything an extractor reads (dependencies in node_modules, the tool's own
// version). When the id repeats, `restartRun` must therefore bury on its own what
// the new attempt does not re-observe, whatever the earlier attempt stored under
// the same id. The sweep compares `last_seen_run` with the run id, so the earlier
// attempt's stamps would otherwise pass for the new attempt's.

/** One PASS extractor claiming the `File` nodes of `CODE_SCOPE`, optionally narrowed. */
const codeClaim = (selector?: string): ExtractorResult =>
  extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'], selector)]);

test('restartRun buries what an earlier attempt under the same id stored and this attempt does not produce', async () => {
  const s = store();
  await runWith(s, 'r1', ['src/a.ts', 'src/b.ts']);
  await restartWith(s, 'r1', ['src/a.ts']);

  assert.equal(stamps(s, 'src/b.ts'), undefined, 'b.ts is not in the second attempt');
  assert.deepEqual(stamps(s, 'src/a.ts'), { first: 'r1', last: 'r1' });
  await s.close();
});

test('restartRun buries the edges the second attempt does not re-observe, and keeps the ones it does', async () => {
  const s = store();
  const a = fileNode('src/a.ts');
  const b = fileNode('src/b.ts');
  const c = fileNode('src/c.ts');
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [a, b, c]);
  await s.upsertEdges('r1', CODE_SCOPE, [importsEdge(a, b), importsEdge(a, c)]);
  await s.finalizeRun('r1', [codeClaim()]);

  await s.restartRun(runRecord('r1'));
  await s.upsertNodes('r1', [a, b, c]);
  await s.upsertEdges('r1', CODE_SCOPE, [importsEdge(a, b)]);
  await s.finalizeRun('r1', [codeClaim()]);

  assert.deepEqual(
    s.edgesFrom(a.id).map((e) => e.dst),
    [b.id],
    'the a.ts to c.ts import is gone',
  );
  assert.equal(s.edgesFrom(a.id)[0]?.lastSeenRun, 'r1');
  await s.close();
});

test('restartRun respects the selector of the second attempt: only the files it claims are buried', async () => {
  const s = store();
  await runWith(s, 'r1', ['src/a.ts', 'src/b.ts']);

  // The retry only claims src/a.ts, and does not see it. It said nothing about b.ts.
  await s.restartRun(runRecord('r1'));
  await s.finalizeRun('r1', [codeClaim('src/a.ts')]);

  assert.equal(stamps(s, 'src/a.ts'), undefined, 'claimed and not seen');
  assert.deepEqual(stamps(s, 'src/b.ts'), { first: 'r1', last: 'r1' }, 'not claimed, untouched');
  await s.close();
});

test('restartRun keeps the first attempt rows live, stamps and all, when the second attempt is not PASS', async () => {
  for (const status of ['FAIL', 'UNAVAILABLE'] as const) {
    const s = store();
    const a = fileNode('src/a.ts');
    const b = fileNode('src/b.ts');
    await s.beginRun(runRecord('r1'));
    await s.upsertNodes('r1', [a, b]);
    await s.upsertEdges('r1', CODE_SCOPE, [importsEdge(a, b)]);
    await s.finalizeRun('r1', [codeClaim()]);

    await s.restartRun(runRecord('r1'));
    await s.upsertNodes('r1', [a]);
    await s.finalizeRun('r1', [extractorResult('ts', status, [scope(CODE_SCOPE, ['File'])])]);

    assert.deepEqual(stamps(s, 'src/a.ts'), { first: 'r1', last: 'r1' }, status);
    assert.deepEqual(
      stamps(s, 'src/b.ts'),
      { first: 'r1', last: 'r1' },
      `${status}: b.ts stays live`,
    );
    const edges = s.edgesFrom(a.id);
    assert.equal(edges.length, 1, `${status}: the import stays live`);
    assert.equal(edges[0]?.lastSeenRun, 'r1', `${status}: with the stamp it had`);
    await s.close();
  }
});

test('restartRun leaves a scope the second attempt does not claim alone', async () => {
  const s = store();
  await runWith(s, 'r1', ['src/a.ts', 'src/b.ts']);

  await s.restartRun(runRecord('r1'));
  await s.finalizeRun('r1', [extractorResult('sql', 'PASS', [scope(DATA_SCOPE, ['Table'])])]);

  for (const path of ['src/a.ts', 'src/b.ts']) {
    assert.deepEqual(stamps(s, path), { first: 'r1', last: 'r1' }, path);
  }
  await s.close();
});

test('restartRun after a restart that never finalized still buries what the last attempt did not re-observe', async () => {
  const s = store();
  await runWith(s, 'r1', ['src/a.ts', 'src/b.ts', 'src/c.ts']);

  // The second attempt re-observes b.ts and dies. The third re-observes only a.ts.
  await s.restartRun(runRecord('r1'));
  await s.upsertNodes('r1', [fileNode('src/b.ts')]);
  await restartWith(s, 'r1', ['src/a.ts']);

  assert.deepEqual(stamps(s, 'src/a.ts'), { first: 'r1', last: 'r1' });
  assert.equal(stamps(s, 'src/b.ts'), undefined, 'seen by the dead attempt, not by the last');
  assert.equal(stamps(s, 'src/c.ts'), undefined);
  await s.close();
});

test('restartRun leaves rows another run stamped alone, and a stamp it set aside is its own', async () => {
  const s = store();
  await runWith(s, 'r1', ['src/a.ts', 'src/b.ts']);
  await runWith(s, 'r2', ['src/a.ts', 'src/b.ts', 'src/c.ts']);

  // r1 comes back without claiming code.ts: the rows r2 stamped are not its to judge.
  await s.restartRun(runRecord('r1'));
  await s.finalizeRun('r1', [extractorResult('sql', 'PASS', [scope(DATA_SCOPE, ['Table'])])]);

  assert.deepEqual(stamps(s, 'src/c.ts'), { first: 'r2', last: 'r2' });
  assert.deepEqual(stamps(s, 'src/a.ts'), { first: 'r1', last: 'r2' });
  await s.close();
});

test('restartRun leaves no set-aside stamp behind: a buried row is blank and postdated, a live one is stamped r1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seamline-store-'));
  const path = join(dir, 'graph.db');
  try {
    const s = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock() });
    const a = fileNode('src/a.ts');
    const b = fileNode('src/b.ts');
    await s.beginRun(runRecord('r1'));
    await s.upsertNodes('r1', [a, b]);
    await s.upsertEdges('r1', CODE_SCOPE, [importsEdge(a, b)]);
    await s.finalizeRun('r1', [codeClaim()]);
    await restartWith(s, 'r1', ['src/a.ts']);
    await s.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = raw
        .prepare('SELECT id, deleted_at, last_seen_run FROM nodes ORDER BY id')
        .all() as Array<{ id: string; deleted_at: string | null; last_seen_run: string }>;
      assert.deepEqual(
        rows.map((r) => ({ ...r })),
        [
          { id: file('src/a.ts'), deleted_at: null, last_seen_run: 'r1' },
          // Buried by r1 itself: the tombstone is the run id, the last sighting is "none".
          { id: file('src/b.ts'), deleted_at: 'r1', last_seen_run: '' },
        ],
      );
      const edge = raw.prepare('SELECT deleted_at, last_seen_run FROM edges').all() as Array<{
        deleted_at: string | null;
        last_seen_run: string;
      }>;
      assert.deepEqual(
        edge.map((r) => ({ ...r })),
        [{ deleted_at: 'r1', last_seen_run: '' }],
      );
      const stray = raw
        .prepare(
          "SELECT (SELECT COUNT(*) FROM nodes WHERE last_seen_run LIKE '!%') + (SELECT COUNT(*) FROM edges WHERE last_seen_run LIKE '!%') AS n",
        )
        .get() as { n: number };
      assert.equal(stray.n, 0, 'no row is left carrying a set-aside stamp');
    } finally {
      raw.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A crash between `restartRun` and `finalizeRun` leaves the rows the attempt had
// not re-observed carrying the set-aside stamp. The usual next run has another id
// (the tree changed), and its finalize does not settle another run's stamps. The
// stamp is on disk only: a reader is told the run that last saw the row.

const SET_ASIDE = '!superseded:r1';

/** `[id, last_seen_run, deleted_at]` of the file rows and `[kind, last_seen_run, deleted_at]` of the edges, as stored. */
function rawStamps(path: string): { nodes: string[]; edges: string[] } {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const nodes = raw
      .prepare('SELECT id, last_seen_run AS seen, deleted_at AS gone FROM nodes ORDER BY id')
      .all() as Array<{ id: string; seen: string; gone: string | null }>;
    const edges = raw
      .prepare(
        'SELECT dst_id, last_seen_run AS seen, deleted_at AS gone FROM edges ORDER BY dst_id',
      )
      .all() as Array<{ dst_id: string; seen: string; gone: string | null }>;
    return {
      nodes: nodes.map((r) => `${r.id} ${r.seen} ${r.gone ?? '-'}`),
      edges: edges.map((r) => `-> ${r.dst_id} ${r.seen} ${r.gone ?? '-'}`),
    };
  } finally {
    raw.close();
  }
}

/** r1 PASS [a, b, c] with a to b and a to c, restarted, a re-observed, then the process dies. */
async function crashedRestart(path: string): Promise<void> {
  const s = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock() });
  const [a, b, c] = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((p) => fileNode(p));
  assert.ok(a && b && c);
  await s.beginRun(runRecord('r1'));
  await s.upsertNodes('r1', [a, b, c]);
  await s.upsertEdges('r1', CODE_SCOPE, [importsEdge(a, b), importsEdge(a, c)]);
  await s.finalizeRun('r1', [codeClaim()]);
  await s.restartRun(runRecord('r1'));
  await s.upsertNodes('r1', [a]);
  await s.close();
}

test('a crashed restart is read as the run that last saw the rows, and another run that does not cover them leaves them so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seamline-store-'));
  const path = join(dir, 'graph.db');
  try {
    await crashedRestart(path);
    // On disk, the rows the attempt did not get to carry the set-aside stamp.
    assert.deepEqual(rawStamps(path).nodes, [
      `${file('src/a.ts')} r1 -`,
      `${file('src/b.ts')} ${SET_ASIDE} -`,
      `${file('src/c.ts')} ${SET_ASIDE} -`,
    ]);

    const s = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock() });
    const readerView = (): string[] => [
      ...s.nodesByKind('File').map((n) => `${n.id} ${n.lastSeenRun}`),
      ...s.edgesFrom(file('src/a.ts')).map((e) => `-> ${e.dst} ${e.lastSeenRun}`),
      ...s.edgesByFile('src/a.ts').map((e) => `file ${e.dst} ${e.lastSeenRun}`),
    ];
    const asRun1 = [
      `${file('src/a.ts')} r1`,
      `${file('src/b.ts')} r1`,
      `${file('src/c.ts')} r1`,
      `-> ${file('src/b.ts')} r1`,
      `-> ${file('src/c.ts')} r1`,
      `file ${file('src/b.ts')} r1`,
      `file ${file('src/c.ts')} r1`,
    ];
    assert.deepEqual(readerView(), asRun1, 'readers see r1, never the set-aside stamp');
    assert.deepEqual(stamps(s, 'src/b.ts'), { first: 'r1', last: 'r1' });
    assert.equal(s.scopeStatus(CODE_SCOPE), 'UNAVAILABLE', 'r1 has no results until it finalizes');

    // r2 has another id and its PASS scope does not cover code.ts files.
    await s.beginRun(runRecord('r2'));
    await s.finalizeRun('r2', [extractorResult('sql', 'PASS', [scope(DATA_SCOPE, ['Table'])])]);
    assert.deepEqual(readerView(), asRun1, 'still r1 after a run that did not cover them');
    assert.deepEqual(
      rawStamps(path).nodes,
      [
        `${file('src/a.ts')} r1 -`,
        `${file('src/b.ts')} ${SET_ASIDE} -`,
        `${file('src/c.ts')} ${SET_ASIDE} -`,
      ],
      'nothing was buried, and the stamp stays on disk until r1 finalizes',
    );
    assert.deepEqual(
      [s.node(file('src/b.ts'))?.deletedAt, s.node(file('src/c.ts'))?.deletedAt],
      [null, null],
    );

    // The attempt at r1 that finalizes settles them, with the run id.
    await s.restartRun(runRecord('r1'));
    await s.finalizeRun('r1', [extractorResult('sql', 'PASS', [scope(DATA_SCOPE, ['Table'])])]);
    await s.close();
    assert.deepEqual(rawStamps(path).nodes, [
      `${file('src/a.ts')} r1 -`,
      `${file('src/b.ts')} r1 -`,
      `${file('src/c.ts')} r1 -`,
    ]);
    assert.deepEqual(rawStamps(path).edges, [
      `-> ${file('src/b.ts')} r1 -`,
      `-> ${file('src/c.ts')} r1 -`,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a crashed restart then a run that does cover the rows: they are buried by that run, and a reader never sees them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seamline-store-'));
  const path = join(dir, 'graph.db');
  try {
    await crashedRestart(path);
    const s = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock() });
    await s.beginRun(runRecord('r2'));
    await s.upsertNodes('r2', [fileNode('src/a.ts')]);
    await s.finalizeRun('r2', [codeClaim()]);

    // r2 did not see b.ts and c.ts, whatever stamp they carried, so r2 buried them.
    assert.deepEqual(stamps(s, 'src/a.ts'), { first: 'r1', last: 'r2' });
    assert.equal(stamps(s, 'src/b.ts'), undefined);
    assert.equal(stamps(s, 'src/c.ts'), undefined);
    assert.deepEqual(s.edgesFrom(file('src/a.ts')), []);
    assert.deepEqual(
      s.nodesByKind('File').map((n) => n.id),
      [file('src/a.ts')],
    );
    await s.close();
    const raw = rawStamps(path);
    assert.deepEqual(
      raw.nodes.map((r) => r.replace(SET_ASIDE, '<set aside>')),
      [
        `${file('src/a.ts')} r2 -`,
        `${file('src/b.ts')} <set aside> r2`,
        `${file('src/c.ts')} <set aside> r2`,
      ],
      'the tombstones are r2s; the old stamp stays on rows no reader is given',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run id that collides with the set-aside stamp is refused, so a stamp cannot pass for a run', async () => {
  const s = store();
  await assert.rejects(s.beginRun(runRecord('!superseded:r1')), /must not start with/);
  await runWith(s, 'r1', ['src/a.ts']);
  await assert.rejects(s.restartRun(runRecord('!superseded:r1')), /must not start with/);
  await s.close();
});

test('restartRun refuses a run it does not hold, a run of another repo, and a closed store', async () => {
  const s = store();
  await assert.rejects(s.restartRun(runRecord('nope')), /unknown run: nope/);
  await runWith(s, 'r1', ['src/a.ts']);
  await assert.rejects(s.restartRun(runRecord('r1', { repo: 'other' })), /belongs to repo app/);
  await assert.rejects(s.restartRun(runRecord('r1', { ontologyVersion: '9.9.9' })), /ontology/);
  await s.close();
  await assert.rejects(s.restartRun(runRecord('r1')), /store is closed/);
});
