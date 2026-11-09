/**
 * The graph can forget: real extractors, real store, two runs across a deletion.
 *
 * ADR-0003's conformance gate reads "delete a source file, re-extract; assert
 * the symbol is tombstoned and its edges stop being returned". The store's own
 * suite proves the sweep with hand-written selectors, which is exactly how a
 * selector the store could not evaluate (a POSIX brace glob, or a prose
 * description) shipped in two real manifests without a single failing test:
 * the sweep ran, matched nothing, and every vanished file, symbol, table and
 * column stayed live forever.
 *
 * This suite runs the real `extractCodeTs` and `extractData` twice over a
 * synthetic repository, persists each run the way `seamline extract` does, and
 * reads `deleted_at` straight off the on-disk rows. It asserts both halves of
 * the invariant: what vanished inside a run's authoritative scope is buried
 * with the burying run's id, and what lies outside the scope's selector is
 * never touched.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { nodeId } from '@seamline/ontology';
import type { NodeId, NodeKind, SeamlineNode } from '@seamline/ontology';
import { SqliteStore } from '@seamline/core';
import { CODE_TS_SCOPE, extractCodeTs } from '@seamline/extract-code-ts';
import { DATA_SCOPE, extractData } from '@seamline/extract-data';

const REPO = 'forget';
const RUN_1 = 'run-1';
const RUN_2 = 'run-2';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['*.ts', 'src'],
});

/** Present in both runs. */
const KEPT: Readonly<Record<string, string>> = {
  'tsconfig.json': TSCONFIG,
  'src/keep.ts': 'export interface Kept { id: string }\n',
  'db/users.sql': 'CREATE TABLE users (id bigserial PRIMARY KEY, email text NOT NULL);\n',
};

/** Present in run 1 only. `root.ts` is the root-level case: no directory at all. */
const DELETED: Readonly<Record<string, string>> = {
  'root.ts': 'export function rootHelper(): number { return 1; }\n',
  'src/gone.ts':
    'export class Gone { name = "x"; }\nexport function goneFn(a: string): string { return a; }\n',
  'db/orders.sql': 'CREATE TABLE orders (id bigserial PRIMARY KEY, total numeric NOT NULL);\n',
  'src/db/audit.ts':
    "import { pgTable, text } from 'drizzle-orm/pg-core';\n" +
    "export const auditLog = pgTable('audit_log', { entry: text('entry').notNull() });\n",
};

const id = (kind: NodeKind, canonicalName: string): NodeId => nodeId(REPO, kind, canonicalName);

/**
 * Nodes of an authoritative kind whose path lies outside that scope's
 * selector. A history extractor really does emit `File` nodes for non-source
 * paths such as a README; neither sweep may bury them just because no
 * extractor re-observed them in run 2.
 */
function outsideSelectorNodes(runId: string): SeamlineNode[] {
  const base = {
    sensitivity: 'internal',
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: runId,
    lastSeenRun: runId,
    deletedAt: null,
  } as const;
  return [
    { ...base, id: id('File', 'README.md'), kind: 'File', name: 'README.md', path: 'README.md' },
    {
      ...base,
      id: id('Table', 'public.erd_note'),
      kind: 'Table',
      name: 'erd_note',
      path: 'docs/erd.md',
    },
  ];
}

let fixtureRoot: string;
let storeDir: string;
let storePath: string;

async function writeTree(files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(fixtureRoot, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, text, 'utf8');
  }
}

/** One `seamline extract`: both real extractors, persisted then finalized once. */
async function extractRun(runId: string, extra: ReadonlyArray<SeamlineNode> = []): Promise<void> {
  const code = extractCodeTs({ repoRoot: fixtureRoot, repo: REPO, runId, deterministic: true });
  const data = await extractData({ root: fixtureRoot, repo: REPO, runId, deterministic: true });
  assert.equal(
    code.result.status,
    'PASS',
    `${runId}: extract-code-ts must PASS for its sweep to run`,
  );
  assert.equal(data.result.status, 'PASS', `${runId}: extract-data must PASS for its sweep to run`);

  const store = new SqliteStore({ path: storePath, ontologyVersion: '1.0.0' });
  try {
    await store.beginRun({
      runId,
      repo: REPO,
      commit: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      ontologyVersion: '1.0.0',
    });
    await store.upsertNodes(runId, [...code.nodes, ...data.nodes, ...extra]);
    await store.upsertEdges(runId, CODE_TS_SCOPE, code.edges);
    await store.upsertEdges(runId, DATA_SCOPE, data.edges);
    await store.finalizeRun(runId, [code.result, data.result]);
  } finally {
    await store.close();
  }
}

/** `deleted_at` exactly as persisted, bypassing the read path that hides tombstones. */
function deletedAt(nodeIds: ReadonlyArray<NodeId>): Record<string, string | null> {
  const raw = new DatabaseSync(storePath, { readOnly: true });
  try {
    const stmt = raw.prepare('SELECT deleted_at FROM nodes WHERE id = :id');
    const out: Record<string, string | null> = {};
    for (const nid of nodeIds) {
      const row = stmt.get({ id: nid }) as { deleted_at: string | null } | undefined;
      assert.ok(row !== undefined, `expected a persisted row for ${nid}`);
      out[nid] = row.deleted_at;
    }
    return out;
  } finally {
    raw.close();
  }
}

function expectAll(
  nodeIds: ReadonlyArray<NodeId>,
  value: string | null,
): Record<string, string | null> {
  return Object.fromEntries(nodeIds.map((nid) => [nid, value]));
}

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'seamline-forget-repo-'));
  storeDir = await mkdtemp(join(tmpdir(), 'seamline-forget-db-'));
  storePath = join(storeDir, 'graph.db');
  await writeTree({ ...KEPT, ...DELETED });
  await extractRun(RUN_1, outsideSelectorNodes(RUN_1));
  for (const rel of Object.keys(DELETED)) await rm(join(fixtureRoot, rel));
  await extractRun(RUN_2);
});

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(storeDir, { recursive: true, force: true });
});

test('code.ts: a deleted file and everything declared in it is tombstoned by run 2', () => {
  const vanished = [
    id('File', 'src/gone.ts'),
    id('Symbol', '<root>#Gone'),
    id('Symbol', '<root>#goneFn'),
    id('CodeField', '<root>#Gone.name'),
    id('Parameter', '<root>#goneFn(0)a'),
    id('File', 'src/db/audit.ts'),
    id('Symbol', '<root>#auditLog'),
  ];
  assert.deepEqual(deletedAt(vanished), expectAll(vanished, RUN_2));
});

test('code.ts: a root-level file is inside the selector too', () => {
  // `**/*.ts` evaluated as a raw SQLite GLOB needs a `/` before the file name,
  // so a file at the repository root was never swept even once braces worked.
  const vanished = [id('File', 'root.ts'), id('Symbol', '<root>#rootHelper')];
  assert.deepEqual(deletedAt(vanished), expectAll(vanished, RUN_2));
});

test('data: tables and columns from a deleted SQL file and a deleted Drizzle module are tombstoned', () => {
  const vanished = [
    id('Table', 'public.orders'),
    id('Column', 'public.orders.id'),
    id('Column', 'public.orders.total'),
    id('Table', 'public.audit_log'),
    id('Column', 'public.audit_log.entry'),
  ];
  assert.deepEqual(deletedAt(vanished), expectAll(vanished, RUN_2));
});

test('what run 2 re-observed stays live', () => {
  const live = [
    id('File', 'src/keep.ts'),
    id('Symbol', '<root>#Kept'),
    id('Table', 'public.users'),
    id('Column', 'public.users.email'),
    id('Schema', 'public'),
    id('DataSource', 'default'),
  ];
  assert.deepEqual(deletedAt(live), expectAll(live, null));
});

test('a node of an authoritative kind outside the selector is never tombstoned', () => {
  const outside = outsideSelectorNodes(RUN_1).map((n) => n.id);
  assert.deepEqual(deletedAt(outside), expectAll(outside, null));
});

test('the buried file drops out of the read path, edges included', async () => {
  const store = new SqliteStore({ path: storePath, ontologyVersion: '1.0.0' });
  try {
    const gone = id('File', 'src/gone.ts');
    assert.equal(store.node(gone), undefined);
    assert.deepEqual(store.edgesFrom(gone), []);
    assert.deepEqual(store.edgesByFile('src/gone.ts'), []);
    const liveFiles = store
      .nodesByKind('File')
      .map((n) => n.path)
      .sort();
    assert.deepEqual(liveFiles, ['README.md', 'src/keep.ts']);
  } finally {
    await store.close();
  }
});
