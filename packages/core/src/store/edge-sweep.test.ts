/**
 * Regression suite for `SqliteStore`'s edge sweep: tombstoning is confined to
 * the run's authoritative claim for edges exactly as it is for nodes
 * (AGENTS.md invariant 2, v3 §2.2).
 *
 * The defect these tests pin: `finalizeRun` swept every unseen edge of a scope
 * and applied the claim's selector to nodes only. A run narrowed to one file
 * therefore left the excluded file's nodes live and buried that file's edges,
 * so the next read saw a live file that appeared to import nothing. Tombstones
 * are read straight off the on-disk rows: the read path hides an edge whose
 * endpoint is buried, which would mask exactly the edges at issue.
 *
 * The rule under test is stated once, in `scope-selector.ts` ("What a claim
 * covers").
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';

import { SqliteStore } from './sqlite-store.ts';
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

let dir: string;
let dbCount = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seamline-edge-sweep-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function freshPath(): string {
  dbCount += 1;
  return join(dir, `graph-${String(dbCount)}.db`);
}

function open(path: string): SqliteStore {
  return new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock() });
}

/** `deleted_at` of every edge in a scope, keyed `src -[kind]-> dst`, as persisted. */
function edgeTombstones(path: string, edgeScope = CODE_SCOPE): Record<string, string | null> {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = raw
      .prepare(
        'SELECT src_id, dst_id, kind, deleted_at FROM edges WHERE scope = :scope ORDER BY src_id, dst_id, kind',
      )
      .all({ scope: edgeScope }) as Array<{
      src_id: string;
      dst_id: string;
      kind: string;
      deleted_at: string | null;
    }>;
    return Object.fromEntries(
      rows.map((r) => [`${r.src_id} -[${r.kind}]-> ${r.dst_id}`, r.deleted_at]),
    );
  } finally {
    raw.close();
  }
}

function nodeTombstones(path: string): Record<string, string | null> {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = raw.prepare('SELECT id, deleted_at FROM nodes ORDER BY id').all() as Array<{
      id: string;
      deleted_at: string | null;
    }>;
    return Object.fromEntries(rows.map((r) => [r.id, r.deleted_at]));
  } finally {
    raw.close();
  }
}

const label = (e: SeamlineEdge): string => `${e.src} -[${e.kind}]-> ${e.dst}`;

const fileA = fileNode('src/a.ts');
const fileB = fileNode('src/b.ts');
const symA = makeNode({ name: 'src/a.ts#A', kind: 'Symbol', path: 'src/a.ts' });
const symB = makeNode({ name: 'src/b.ts#B', kind: 'Symbol', path: 'src/b.ts' });

const containsA = makeEdge({
  src: fileA.id,
  dst: symA.id,
  kind: 'CONTAINS',
  srcFile: 'src/a.ts',
  dstFile: 'src/a.ts',
});
const containsB = makeEdge({
  src: fileB.id,
  dst: symB.id,
  kind: 'CONTAINS',
  srcFile: 'src/b.ts',
  dstFile: 'src/b.ts',
});
const aImportsB = importsEdge(fileA, fileB);
const bImportsA = importsEdge(fileB, fileA);

const ALL_NODES = [fileA, fileB, symA, symB];
const ALL_EDGES = [containsA, containsB, aImportsB, bImportsA];

async function runOne(
  s: SqliteStore,
  runId: string,
  claim: ReturnType<typeof scope>,
  nodes: ReadonlyArray<SeamlineNode>,
  edges: ReadonlyArray<SeamlineEdge>,
): Promise<void> {
  await s.beginRun(runRecord(runId));
  await s.upsertNodes(runId, nodes);
  await s.upsertEdges(runId, CODE_SCOPE, edges);
  await s.finalizeRun(runId, [extractorResult('ts', 'PASS', [claim])]);
}

describe('a run narrowed by a selector', () => {
  test('keeps the excluded file nodes AND its outgoing edges live; buries only a vanished edge of the claimed file', async () => {
    const path = freshPath();
    const s = open(path);
    await runOne(s, 'r1', scope(CODE_SCOPE, ['File', 'Symbol']), ALL_NODES, ALL_EDGES);

    // Same scope, narrower claim: only src/a.ts. Its import of b.ts was removed,
    // so a.ts's facts are now just the file, its symbol and the containment.
    await runOne(
      s,
      'r2',
      scope(CODE_SCOPE, ['File', 'Symbol'], 'src/a.ts'),
      [fileA, symA],
      [containsA],
    );
    await s.close();

    assert.deepEqual(nodeTombstones(path), {
      [fileA.id]: null,
      [fileB.id]: null,
      [symA.id]: null,
      [symB.id]: null,
    });
    assert.deepEqual(edgeTombstones(path), {
      [label(containsA)]: null,
      // Source in the claim, not re-observed: gone.
      [label(aImportsB)]: 'r2',
      // Source outside the claim: the run says nothing about it.
      [label(containsB)]: null,
      [label(bImportsA)]: null,
    });
  });

  test('the excluded file stays fully readable: its edges are returned, not just its nodes', async () => {
    const path = freshPath();
    const s = open(path);
    await runOne(s, 'r1', scope(CODE_SCOPE, ['File', 'Symbol']), ALL_NODES, ALL_EDGES);
    await runOne(
      s,
      'r2',
      scope(CODE_SCOPE, ['File', 'Symbol'], 'src/a.ts'),
      [fileA, symA],
      [containsA],
    );

    assert.deepEqual(
      s.edgesFrom(fileB.id).map(label).sort(),
      [label(bImportsA), label(containsB)].sort(),
    );
    assert.deepEqual(s.edgesTo(fileA.id, 'IMPORTS').map(label), [label(bImportsA)]);
    assert.deepEqual(
      s.edgesByFile('src/b.ts').map(label).sort(),
      [label(bImportsA), label(containsB)].sort(),
    );
    await s.close();
  });

  test('a buried edge is resurrected by a later run: deleted_at cleared, history kept', async () => {
    const path = freshPath();
    const s = open(path);
    await runOne(s, 'r1', scope(CODE_SCOPE, ['File', 'Symbol']), ALL_NODES, ALL_EDGES);
    await runOne(
      s,
      'r2',
      scope(CODE_SCOPE, ['File', 'Symbol'], 'src/a.ts'),
      [fileA, symA],
      [containsA],
    );
    assert.equal(edgeTombstones(path)[label(aImportsB)], 'r2');

    // The import comes back in a full run.
    await runOne(s, 'r3', scope(CODE_SCOPE, ['File', 'Symbol'], '**/*.ts'), ALL_NODES, ALL_EDGES);
    const back = s.edgesFrom(fileA.id, 'IMPORTS');
    assert.equal(back.length, 1);
    assert.equal(back[0]?.deletedAt, null);
    assert.equal(back[0]?.firstSeenRun, 'r1', 'resurrected, not shadowed by a new row');
    assert.equal(back[0]?.lastSeenRun, 'r3');
    await s.close();

    assert.deepEqual(Object.values(edgeTombstones(path)), [null, null, null, null]);
  });

  test('a full-width selector still buries every vanished edge inside it', async () => {
    const path = freshPath();
    const s = open(path);
    await runOne(s, 'r1', scope(CODE_SCOPE, ['File', 'Symbol']), ALL_NODES, ALL_EDGES);
    await runOne(
      s,
      'r2',
      scope(CODE_SCOPE, ['File', 'Symbol'], '**/*.ts'),
      [fileA, symA],
      [containsA],
    );
    await s.close();

    assert.deepEqual(edgeTombstones(path), {
      [label(containsA)]: null,
      [label(aImportsB)]: 'r2',
      [label(containsB)]: 'r2',
      [label(bImportsA)]: 'r2',
    });
  });

  test('a claim with no selector still sweeps its whole edge scope', async () => {
    const path = freshPath();
    const s = open(path);
    await runOne(s, 'r1', scope(CODE_SCOPE, ['File', 'Symbol']), ALL_NODES, ALL_EDGES);
    await runOne(s, 'r2', scope(CODE_SCOPE, ['File', 'Symbol']), [fileA, symA], [containsA]);
    await s.close();

    assert.deepEqual(Object.values(edgeTombstones(path)).sort(), [null, 'r2', 'r2', 'r2']);
  });
});

describe('which file anchors an edge', () => {
  const root = makeNode({ name: 'root', kind: 'Module' });
  const rootContainsA = makeEdge({
    src: root.id,
    dst: fileA.id,
    kind: 'CONTAINS',
    dstFile: 'src/a.ts',
  });
  const rootContainsB = makeEdge({
    src: root.id,
    dst: fileB.id,
    kind: 'CONTAINS',
    dstFile: 'src/b.ts',
  });
  const unanchored = makeEdge({
    src: root.id,
    dst: makeNode({ name: 'other', kind: 'Module' }).id,
    kind: 'IMPORTS',
  });

  async function seed(path: string): Promise<SqliteStore> {
    const s = open(path);
    await s.beginRun(runRecord('r1'));
    await s.upsertNodes('r1', [root, makeNode({ name: 'other', kind: 'Module' }), fileA, fileB]);
    await s.upsertEdges('r1', CODE_SCOPE, [rootContainsA, rootContainsB, unanchored]);
    await s.finalizeRun('r1', [
      extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File', 'Module'])]),
    ]);
    return s;
  }

  test('with no source file, the destination file anchors the edge', async () => {
    const path = freshPath();
    const s = await seed(path);
    await runOne(s, 'r2', scope(CODE_SCOPE, ['File', 'Module'], 'src/a.ts'), [fileA], []);
    await s.close();

    const tombstones = edgeTombstones(path);
    assert.equal(tombstones[label(rootContainsA)], 'r2', 'anchored in the claim, not re-observed');
    assert.equal(tombstones[label(rootContainsB)], null, 'anchored outside the claim');
  });

  test('an edge with no file at all is outside every selector, like a path-less node', async () => {
    const path = freshPath();
    const s = await seed(path);
    await runOne(s, 'r2', scope(CODE_SCOPE, ['File', 'Module'], '**/*.ts'), [fileA, fileB], []);
    await s.close();

    const tombstones = edgeTombstones(path);
    assert.equal(tombstones[label(unanchored)], null);
    assert.equal(tombstones[label(rootContainsA)], 'r2');
    assert.equal(tombstones[label(rootContainsB)], 'r2');
    assert.equal(
      nodeTombstones(path)[root.id],
      null,
      'a path-less node is not swept by a selector either',
    );
  });
});

describe('a selector that is a label, not a path filter', () => {
  test('a claim naming no node kinds sweeps its whole edge scope', async () => {
    // infer-join: it emits edges only, claims no node kinds, and its selector
    // lists the edge kinds it owns. There are no nodes for a selector to narrow.
    const column = makeNode({ name: 'public.posts.title', kind: 'Column', path: 'db/schema.sql' });
    const field = makeNode({
      name: 'src/post.ts#Post.title',
      kind: 'CodeField',
      path: 'src/post.ts',
    });
    const joined = makeEdge({
      src: column.id,
      dst: field.id,
      kind: 'MAPS_TO_FIELD',
      srcFile: 'db/schema.sql',
      dstFile: 'src/post.ts',
      provenance: 'INFERRED',
      confidence: 0.7,
    });
    const path = freshPath();
    const s = open(path);
    await s.beginRun(runRecord('r1'));
    await s.upsertNodes('r1', [column, field]);
    await s.upsertEdges('r1', 'infer-join', [joined]);
    await s.finalizeRun('r1', [extractorResult('infer-join', 'PASS', [scope('infer-join', [])])]);

    await s.beginRun(runRecord('r2'));
    await s.finalizeRun('r2', [
      extractorResult('infer-join', 'PASS', [
        scope('infer-join', [], 'MAPS_TO_FIELD|BACKED_BY|EXPOSED_AS|VALIDATED_BY'),
      ]),
    ]);
    await s.close();

    assert.deepEqual(edgeTombstones(path, 'infer-join'), { [label(joined)]: 'r2' });
  });

  test('a revision-range label over path-less kinds leaves edges alone, as it leaves their nodes', async () => {
    // extract-change: kinds Commit and Changeset, selector `HEAD max=N`. No
    // file lies in a revision range, so the claim cannot place any edge.
    const commit = makeNode({ name: 'abc123', kind: 'Commit' });
    const touches = makeEdge({
      src: commit.id,
      dst: fileA.id,
      kind: 'TOUCHES',
      dstFile: 'src/a.ts',
    });
    const path = freshPath();
    const s = open(path);
    await s.beginRun(runRecord('r1'));
    await s.upsertNodes('r1', [commit, fileA]);
    await s.upsertEdges('r1', 'change', [touches]);
    await s.finalizeRun('r1', [
      extractorResult('git', 'PASS', [scope('change', ['Commit', 'Changeset'])]),
    ]);

    await s.beginRun(runRecord('r2'));
    await s.finalizeRun('r2', [
      extractorResult('git', 'PASS', [scope('change', ['Commit', 'Changeset'], 'HEAD max=1')]),
    ]);
    await s.close();

    assert.equal(nodeTombstones(path)[commit.id], null);
    assert.deepEqual(edgeTombstones(path, 'change'), { [label(touches)]: null });
  });
});

describe('path-less nodes under a selector', () => {
  test('are never tombstoned, even when their name would match the selector', async () => {
    // The in-memory merge once matched a path-less node by its name. The store
    // never did: no file read vouches for a node that names no file.
    const named = makeNode({ name: 'src/ghost.ts', kind: 'Symbol' });
    const path = freshPath();
    const s = open(path);
    await s.beginRun(runRecord('r1'));
    await s.upsertNodes('r1', [named, fileA]);
    await s.finalizeRun('r1', [
      extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File', 'Symbol'])]),
    ]);

    await s.beginRun(runRecord('r2'));
    await s.finalizeRun('r2', [
      extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File', 'Symbol'], '**/*.ts')]),
    ]);
    await s.close();

    assert.deepEqual(nodeTombstones(path), { [named.id]: null, [fileA.id]: 'r2' });
  });
});

describe('other scopes are untouched', () => {
  test('a narrowed run never reaches an edge stored under another scope', async () => {
    const path = freshPath();
    const s = open(path);
    await s.beginRun(runRecord('r1'));
    await s.upsertNodes('r1', ALL_NODES);
    await s.upsertEdges('r1', CODE_SCOPE, [aImportsB]);
    await s.upsertEdges('r1', 'other', [bImportsA]);
    await s.finalizeRun('r1', [
      extractorResult('ts', 'PASS', [scope(CODE_SCOPE, ['File'])]),
      extractorResult('other', 'PASS', [scope('other', ['File'])]),
    ]);
    await runOne(s, 'r2', scope(CODE_SCOPE, ['File'], 'src/a.ts'), [fileA], []);
    await s.close();

    assert.deepEqual(edgeTombstones(path, 'other'), { [label(bImportsA)]: null });
    assert.deepEqual(edgeTombstones(path, CODE_SCOPE), { [label(aImportsB)]: 'r2' });
  });
});
