/**
 * What the new raw-SQL `QUERIES` edges do to their other readers, measured on
 * real extractor output persisted the way `seamline extract` persists it.
 *
 * Statements written as interpolated templates had no edge before the classifier
 * read a template's own literal text, so every reader of `QUERIES` (the `infer-join`
 * structure score, the traversal allow-lists, X6) gains a symbol. Design:
 * `docs/design/real-world-inputs.md`, 3.4. X6's own half is in
 * `packages/contradictions/src/detectors/x6.test.ts`; this file is the other two
 * consumers, plus retention of prior writers when SQL cannot be read completely.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { IMPACT_EDGE_KINDS, SqliteStore, bfs } from '@seamline/core';
import { CODE_TS_SCOPE, extractCodeTs } from '@seamline/extract-code-ts';
import { DATA_SCOPE, buildDataModelIndex, extractData } from '@seamline/extract-data';
import { inferJoins } from '@seamline/infer-join';
import type { NodeId, SeamlineEdge } from '@seamline/ontology';

const REPO = 'rawsql';
const RUN = 'run-1';

const SCHEMA_SQL = `CREATE TABLE users (
    id     bigserial PRIMARY KEY,
    email  text NOT NULL
);
`;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['src'],
});

const PRELUDE = `declare function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
declare const client: { query(text: string, params?: unknown[]): Promise<unknown> };
`;

/** A class whose only statement against `users` is `statement`, written in a property initialiser. */
function userClass(statement: string | null): string {
  return `${PRELUDE}
export class User {
  email = '';
${statement === null ? '' : `  save = (x: string) => ${statement};\n`}}
`;
}

const INTERPOLATED = 'sql`INSERT INTO users (email) VALUES (${x})`';
const PLAIN = "client.query('INSERT INTO users (email) VALUES (?)')";

const cleanups: string[] = [];

after(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

interface Persisted {
  readonly store: SqliteStore;
  readonly tableId: NodeId;
  readonly repoRoot: string;
}

async function persist(source: string): Promise<Persisted> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'seamline-rawsql-repo-'));
  const dbDir = await mkdtemp(join(tmpdir(), 'seamline-rawsql-db-'));
  cleanups.push(repoRoot, dbDir);
  const files: Record<string, string> = {
    'db/schema.sql': SCHEMA_SQL,
    'src/user.ts': source,
    'tsconfig.json': TSCONFIG,
  };
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(repoRoot, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, text, 'utf8');
  }

  const data = await extractData({ root: repoRoot, repo: REPO, runId: RUN, deterministic: true });
  // The data run's index, as `seamline extract` hands it to the code run: without it the run is UNAVAILABLE.
  const code = extractCodeTs({
    repoRoot,
    repo: REPO,
    runId: RUN,
    deterministic: true,
    dataModelIndex: buildDataModelIndex(data.nodes),
  });
  assert.equal(data.result.status, 'PASS');
  assert.equal(code.result.status, 'PASS');

  const store = new SqliteStore({ path: join(dbDir, 'graph.db'), ontologyVersion: '1.0.0' });
  await store.beginRun({
    runId: RUN,
    repo: REPO,
    commit: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    ontologyVersion: '1.0.0',
  });
  await store.upsertNodes(RUN, [...data.nodes, ...code.nodes]);
  await store.upsertEdges(RUN, DATA_SCOPE, data.edges);
  await store.upsertEdges(RUN, CODE_TS_SCOPE, code.edges);
  await store.finalizeRun(RUN, [data.result, code.result]);
  cleanups.push(dbDir);
  return { store, tableId: `${REPO}:Table:public.users` as NodeId, repoRoot };
}

test('a SQL tokenizer resource limit preserves the prior writer and marks the stored scope unavailable', async () => {
  const { store, tableId, repoRoot } = await persist(userClass(PLAIN));
  try {
    const prior = store.edgesTo(tableId, 'QUERIES');
    assert.equal(prior.length, 1);
    const deep = `INSERT INTO users (email) VALUES ${'('.repeat(10_000)}1${')'.repeat(10_000)}`;
    await writeFile(
      join(repoRoot, 'src/user.ts'),
      userClass(`client.query(${JSON.stringify(deep)})`),
    );
    const data = await extractData({
      root: repoRoot,
      repo: REPO,
      runId: 'run-2',
      deterministic: true,
    });
    const code = extractCodeTs({
      repoRoot,
      repo: REPO,
      runId: 'run-2',
      deterministic: true,
      dataModelIndex: buildDataModelIndex(data.nodes),
    });
    assert.equal(code.nodes.find((n) => n.kind === 'Repo')?.props['untracedWriteCalls'], 1);
    assert.equal(code.result.status, 'UNAVAILABLE');
    await store.beginRun({
      runId: 'run-2',
      repo: REPO,
      commit: null,
      startedAt: '2026-01-02T00:00:00.000Z',
      ontologyVersion: '1.0.0',
    });
    await store.upsertNodes('run-2', code.nodes);
    await store.upsertEdges('run-2', CODE_TS_SCOPE, code.edges);
    await store.finalizeRun('run-2', [code.result]);
    assert.equal(store.scopeStatus(CODE_TS_SCOPE), 'UNAVAILABLE');
    assert.deepEqual(
      store.edgesTo(tableId, 'QUERIES'),
      prior,
      'the incomplete run must not bury the known writer',
    );
  } finally {
    await store.close();
  }
});

/** The confidence and structure signal of the `users.email` to `User.email` join. */
function emailJoin(edges: readonly SeamlineEdge[]): { confidence: number; structure: number } {
  const join = edges.find(
    (e) =>
      e.kind === 'MAPS_TO_FIELD' &&
      String(e.src).endsWith('.users.email') &&
      String(e.dst).includes('User.email'),
  );
  assert.ok(
    join !== undefined,
    `no users.email to User.email join in ${edges.map((e) => `${e.kind} ${e.src} ${e.dst}`).join('; ')}`,
  );
  return { confidence: join.confidence, structure: Number(join.props['signalStructure']) };
}

test('the blast radius of a Table contains a symbol whose only statement against it is an interpolated template', async () => {
  const { store, tableId } = await persist(userClass(INTERPOLATED));
  try {
    const reached = bfs(store, [tableId], IMPACT_EDGE_KINDS, {
      maxDepth: 2,
      maxNodes: 100,
      direction: 'in',
    });
    const viaQueries = reached.reached.filter((r) => r.viaEdge === 'QUERIES');
    assert.equal(viaQueries.length, 1);
    const symbol = viaQueries[0]?.node;
    assert.ok(symbol !== undefined);
    assert.equal(symbol.kind, 'Symbol');
    assert.ok(String(symbol.id).endsWith('#User'), `reached ${symbol.id}`);
  } finally {
    await store.close();
  }
});

test('the set a change to a Table reaches is the same for an interpolated statement and its plain form', async () => {
  const interpolated = await persist(userClass(INTERPOLATED));
  const plain = await persist(userClass(PLAIN));
  const none = await persist(userClass(null));
  try {
    const reach = (p: Persisted): string[] =>
      bfs(p.store, [p.tableId], IMPACT_EDGE_KINDS, { maxDepth: 2, maxNodes: 100, direction: 'in' })
        .reached.map((r) => `${r.viaEdge} ${String(r.node.id)}`)
        .sort();
    assert.deepEqual(reach(interpolated), reach(plain));
    assert.ok(
      reach(interpolated).some((line) => line.startsWith('QUERIES ')),
      'the symbol is reached',
    );
    assert.equal(
      reach(none).filter((line) => line.startsWith('QUERIES ')).length,
      0,
      'and not without a statement',
    );
  } finally {
    await interpolated.store.close();
    await plain.store.close();
    await none.store.close();
  }
});

test('a Column to CodeField join whose class has only an interpolated insert scores as it does with the plain statement', async () => {
  const interpolated = await persist(userClass(INTERPOLATED));
  const plain = await persist(userClass(PLAIN));
  const none = await persist(userClass(null));
  try {
    const score = (p: Persisted): { confidence: number; structure: number } =>
      emailJoin(inferJoins(p.store, { runId: RUN }).edges);
    const withTemplate = score(interpolated);
    const withPlain = score(plain);
    const without = score(none);
    assert.deepEqual(
      withTemplate,
      withPlain,
      'the template contributes exactly what the plain statement does',
    );
    assert.ok(
      withTemplate.structure >= 0.5,
      `the class queries the table: structure ${withTemplate.structure}`,
    );
    assert.ok(
      withTemplate.confidence > without.confidence,
      'and the join is more confident than with no statement',
    );
    assert.ok(!(without.structure >= 0.5), 'the baseline has no such evidence');
  } finally {
    await interpolated.store.close();
    await plain.store.close();
    await none.store.close();
  }
});
