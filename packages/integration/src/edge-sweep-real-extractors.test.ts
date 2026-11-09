/**
 * A narrowed run buries only what it is the authority for, edges included:
 * the real code extractor, the real store, three runs.
 *
 * `edge-sweep.test.ts` in `@seamline/core` proves the rule with hand-built
 * facts. This suite proves it against the anchors the real extractor really
 * writes: `srcFile` on an edge read out of a file, `dstFile` alone on the
 * `CONTAINS` edges from a repo or module root to a file, and no file at all on
 * the edge from the repo to the root module.
 *
 * Run 1 reads three files. Run 2 loads a tsconfig that no longer includes
 * `src/b.ts`, which stays on disk, so the extractor narrows its authoritative
 * selector to the files it read; it also drops a call out of `src/a.ts`. A
 * run that did not read `src/b.ts` has no say about the edges that file
 * declares, exactly as it has none about its nodes. Run 3 puts everything back.
 * `deleted_at` is read straight off the on-disk rows: the read path hides an
 * edge whose endpoint is buried, which would mask exactly the edges at issue.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { nodeId } from '@seamline/ontology';
import type { EdgeKind, NodeId, NodeKind } from '@seamline/ontology';
import { SqliteStore } from '@seamline/core';
import { CODE_TS_SCOPE, extractCodeTs } from '@seamline/extract-code-ts';

const REPO = 'sweep';
const RUN_1 = 'run-1';
const RUN_2 = 'run-2';
const RUN_3 = 'run-3';

const tsconfig = (include: ReadonlyArray<string>): string =>
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
    },
    include,
  });

const SHARED = 'export function shared(): number { return 1; }\n';
const A_CALLING =
  "import { shared } from './shared.ts';\nexport function fnA(): number { return shared(); }\n";
const A_NOT_CALLING =
  "import { shared } from './shared.ts';\nexport function fnA(): number { return 0; }\n";
const B =
  "import { shared } from './shared.ts';\nexport function fnB(): number { return shared(); }\n";

const id = (kind: NodeKind, name: string): NodeId => nodeId(REPO, kind, name);
const edge = (kind: EdgeKind, src: string, dst: string): string => `${src} -[${kind}]-> ${dst}`;

const repo = id('Repo', REPO);
const root = id('Module', '<root>');
const fileA = id('File', 'src/a.ts');
const fileB = id('File', 'src/b.ts');
const fileShared = id('File', 'src/shared.ts');
const fnA = id('Symbol', '<root>#fnA');
const fnB = id('Symbol', '<root>#fnB');
const shared = id('Symbol', '<root>#shared');

const aCallsShared = edge('CALLS', fnA, shared);

/** Every edge `src/b.ts` declares or is contained by. None is anchored by another file. */
const B_EDGES = [
  edge('CALLS', fnB, shared),
  edge('CONTAINS', fileB, fnB),
  edge('CONTAINS', root, fileB),
  edge('CONTAINS', repo, fileB),
  edge('EXPORTS', fileB, fnB),
  edge('IMPORTS', fileB, fileShared),
].sort();

/** The 17 edges run 1 emits; run 3 emits the same ones. */
const ALL_EDGES = [
  aCallsShared,
  ...B_EDGES,
  edge('CONTAINS', fileA, fnA),
  edge('CONTAINS', fileShared, shared),
  edge('CONTAINS', root, fileA),
  edge('CONTAINS', root, fileShared),
  edge('CONTAINS', repo, fileA),
  edge('CONTAINS', repo, fileShared),
  edge('CONTAINS', repo, root),
  edge('EXPORTS', fileA, fnA),
  edge('EXPORTS', fileShared, shared),
  edge('IMPORTS', fileA, fileShared),
].sort();

let fixtureRoot: string;
let storeDir: string;
let storePath: string;

async function write(files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(fixtureRoot, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, text, 'utf8');
  }
}

/** One `seamline extract` of the code extractor: persisted, then finalized once. */
async function extractRun(runId: string): Promise<void> {
  const code = extractCodeTs({ repoRoot: fixtureRoot, repo: REPO, runId, deterministic: true });
  assert.equal(
    code.result.status,
    'PASS',
    `${runId}: extract-code-ts must PASS for its sweep to run`,
  );
  const store = new SqliteStore({ path: storePath, ontologyVersion: '1.0.0' });
  try {
    await store.beginRun({
      runId,
      repo: REPO,
      commit: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      ontologyVersion: '1.0.0',
    });
    await store.upsertNodes(runId, code.nodes);
    await store.upsertEdges(runId, CODE_TS_SCOPE, code.edges);
    await store.finalizeRun(runId, [code.result]);
  } finally {
    await store.close();
  }
}

interface PersistedEdge {
  readonly deletedAt: string | null;
  readonly firstSeenRun: string;
  readonly lastSeenRun: string;
}

/** Every edge of the scope exactly as persisted, bypassing the read path. */
function persistedEdges(): Map<string, PersistedEdge> {
  const raw = new DatabaseSync(storePath, { readOnly: true });
  try {
    const rows = raw
      .prepare(
        `SELECT src_id, dst_id, kind, deleted_at, first_seen_run, last_seen_run
         FROM edges WHERE scope = :scope`,
      )
      .all({ scope: CODE_TS_SCOPE }) as Array<{
      src_id: string;
      dst_id: string;
      kind: EdgeKind;
      deleted_at: string | null;
      first_seen_run: string;
      last_seen_run: string;
    }>;
    return new Map(
      rows.map((r) => [
        edge(r.kind, r.src_id, r.dst_id),
        { deletedAt: r.deleted_at, firstSeenRun: r.first_seen_run, lastSeenRun: r.last_seen_run },
      ]),
    );
  } finally {
    raw.close();
  }
}

function persistedNodes(): Map<string, string | null> {
  const raw = new DatabaseSync(storePath, { readOnly: true });
  try {
    const rows = raw.prepare('SELECT id, deleted_at FROM nodes').all() as Array<{
      id: string;
      deleted_at: string | null;
    }>;
    return new Map(rows.map((r) => [r.id, r.deleted_at]));
  } finally {
    raw.close();
  }
}

const buried = (edges: Map<string, PersistedEdge>): Array<[string, string | null]> =>
  [...edges.entries()]
    .filter(([, e]) => e.deletedAt !== null)
    .map(([key, e]): [string, string | null] => [key, e.deletedAt])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'seamline-edge-sweep-repo-'));
  storeDir = await mkdtemp(join(tmpdir(), 'seamline-edge-sweep-db-'));
  storePath = join(storeDir, 'graph.db');

  await write({
    'tsconfig.json': tsconfig(['src']),
    'src/shared.ts': SHARED,
    'src/a.ts': A_CALLING,
    'src/b.ts': B,
  });
  await extractRun(RUN_1);

  // `src/b.ts` stays on disk but leaves the project; `src/a.ts` stops calling.
  await write({
    'tsconfig.json': tsconfig(['src/a.ts', 'src/shared.ts']),
    'src/a.ts': A_NOT_CALLING,
  });
  await extractRun(RUN_2);
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(storeDir, { recursive: true, force: true });
});

test('nothing is hard-deleted: every edge run 1 emitted is still stored after run 2', () => {
  assert.deepEqual([...persistedEdges().keys()].sort(), ALL_EDGES);
});

test('run 2 did not read src/b.ts: its nodes and every edge it declares or sits under stay live', () => {
  const edges = persistedEdges();
  for (const key of B_EDGES) assert.equal(edges.get(key)?.deletedAt, null, `${key} must stay live`);
  const nodes = persistedNodes();
  assert.equal(nodes.get(fileB), null);
  assert.equal(nodes.get(fnB), null);
});

test('run 2 read src/a.ts and no longer saw its call: that edge alone is buried, by run 2', () => {
  assert.deepEqual(buried(persistedEdges()), [[aCallsShared, RUN_2]]);
});

test('the file the run did not read stays fully readable: its edges are returned, not only its nodes', async () => {
  const store = new SqliteStore({ path: storePath, ontologyVersion: '1.0.0' });
  try {
    assert.deepEqual(
      store
        .edgesByFile('src/b.ts')
        .map((e) => edge(e.kind, e.src, e.dst))
        .sort(),
      B_EDGES,
    );
    assert.deepEqual(
      store
        .edgesFrom(fileB)
        .map((e) => edge(e.kind, e.src, e.dst))
        .sort(),
      [
        edge('CONTAINS', fileB, fnB),
        edge('EXPORTS', fileB, fnB),
        edge('IMPORTS', fileB, fileShared),
      ].sort(),
    );
    assert.deepEqual(store.edgesFrom(fnA, 'CALLS'), [], 'the buried call is not returned');
  } finally {
    await store.close();
  }
});

test('run 3 sees the call again: the edge is resurrected, not shadowed, and nothing else changes', async () => {
  await write({ 'tsconfig.json': tsconfig(['src']), 'src/a.ts': A_CALLING });
  await extractRun(RUN_3);

  const edges = persistedEdges();
  assert.deepEqual([...edges.keys()].sort(), ALL_EDGES, 'one row per edge: resurrected in place');
  assert.deepEqual(buried(edges), []);
  const back = edges.get(aCallsShared);
  assert.equal(back?.firstSeenRun, RUN_1, 'history is kept');
  assert.equal(back?.lastSeenRun, RUN_3);
});
