/**
 * Real-extraction proof of dialect-specific nullability against a stated
 * response contract. Generic model fields remain extracted and joined but
 * cannot substitute for a stored-row role. All cases retain genuine response
 * positives as well as the dialect-specific negative control.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { x1Nullability, x2Type } from '@seamline/contradictions';
import { SqliteStore } from '@seamline/core';
import { CODE_TS_SCOPE, extractCodeTs } from '@seamline/extract-code-ts';
import { CONTRACTS_SCOPE, extractContracts } from '@seamline/extract-contracts';
import { DATA_SCOPE, extractData } from '@seamline/extract-data';
import { INFER_JOIN_SCOPE, inferJoins, toExtractorResult } from '@seamline/infer-join';

const REPO = 'chfixture';
const RUN_EXTRACT = 'run-1';
const RUN_JOIN = 'run-2';

const TSCONFIG = JSON.stringify(
  {
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
  },
  null,
  2,
);

/** Model fields typed as always present, one per column of `web_event`. */
const MODEL_TS = `export interface WebEvent {
  sessionId: string;
  referrer: string;
  hits: string;
  visits: string;
}
`;

/** Inline response properties carry direction without guessing from names. */
const RESPONSE_CONTRACT = JSON.stringify({
  openapi: '3.0.3', info: { title: 'Events', version: '1' },
  paths: { '/events': { get: { responses: { '200': {
    description: 'Event', content: { 'application/json': { schema: {
      type: 'object', properties: { WebEvent: {
        type: 'object', required: ['sessionId', 'referrer', 'hits', 'visits'],
        properties: Object.fromEntries(['sessionId', 'referrer', 'hits', 'visits'].map((name) => [name, { type: 'string', nullable: false }])),
      } },
    } } },
  } } } } },
});

const clickhouseTable = (sessionId: string): string => `CREATE TABLE umami.web_event
(
    session_id ${sessionId},
    referrer Nullable(String),
    hits SimpleAggregateFunction(sum, UInt64),
    visits UInt32
)
ENGINE = MergeTree
    ORDER BY (session_id);
`;

const POSTGRES_TABLE = `CREATE TABLE public.web_event (
    session_id uuid,
    referrer text,
    hits text,
    visits integer NOT NULL
);
`;

interface Findings {
  readonly x1: readonly string[];
  readonly x2: readonly string[];
}

/** Extracts, joins and runs X1 and X2 over a repository holding `sqlFiles`. */
async function detect(sqlFiles: Readonly<Record<string, string>>): Promise<Findings> {
  const root = await mkdtemp(join(tmpdir(), 'seamline-chnull-repo-'));
  const storeDir = await mkdtemp(join(tmpdir(), 'seamline-chnull-db-'));
  try {
    const files: Record<string, string> = {
      ...sqlFiles,
      'package.json': JSON.stringify(
        { name: '@fixture/ch', version: '1.0.0', type: 'module' },
        null,
        2,
      ),
      'src/web-event.ts': MODEL_TS,
      'openapi.json': RESPONSE_CONTRACT,
      'tsconfig.json': TSCONFIG,
    };
    for (const rel of Object.keys(files)) {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, files[rel] as string, 'utf8');
    }

    const run = { repo: REPO, runId: RUN_EXTRACT };
    const code = extractCodeTs({ ...run, repoRoot: root, deterministic: true });
    const contracts = extractContracts({ ...run, repoRoot: root });
    const data = await extractData({ ...run, root, deterministic: true });
    for (const result of [code.result, contracts.result, data.result]) {
      assert.equal(result.status, 'PASS', `${result.extractor}: ${result.diagnostics.join('; ')}`);
    }

    const store = new SqliteStore({ path: join(storeDir, 'graph.db'), ontologyVersion: '1.0.0' });
    try {
      await store.beginRun({
        runId: RUN_EXTRACT,
        repo: REPO,
        commit: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        ontologyVersion: '1.0.0',
      });
      await store.upsertNodes(RUN_EXTRACT, [...code.nodes, ...contracts.nodes, ...data.nodes]);
      await store.upsertEdges(RUN_EXTRACT, CODE_TS_SCOPE, code.edges);
      await store.upsertEdges(RUN_EXTRACT, CONTRACTS_SCOPE, contracts.edges);
      await store.upsertEdges(RUN_EXTRACT, DATA_SCOPE, data.edges);
      await store.finalizeRun(RUN_EXTRACT, [code.result, contracts.result, data.result]);

      const inferred = inferJoins(store, { runId: RUN_JOIN });
      assert.equal(inferred.status, 'PASS');
      await store.beginRun({
        runId: RUN_JOIN,
        repo: REPO,
        commit: null,
        startedAt: '2026-01-01T00:00:01.000Z',
        ontologyVersion: '1.0.0',
      });
      await store.upsertEdges(RUN_JOIN, INFER_JOIN_SCOPE, inferred.edges);
      await store.finalizeRun(RUN_JOIN, [toExtractorResult(inferred, 0)]);

      const claims = (found: ReadonlyArray<{ readonly claim: string }>): string[] =>
        found.map((f) => f.claim).sort();
      return { x1: claims(x1Nullability.detect(store)), x2: claims(x2Type.detect(store)) };
    } finally {
      await store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
}

test('ClickHouse: a plain UUID column is NOT NULL, so X1 stays silent for the response property joined to it', async () => {
  const found = await detect({ 'db/clickhouse/schema.sql': clickhouseTable('UUID') });
  assert.deepEqual(found.x1, [
    'the database permits NULL in referrer but the contract declares referrer non-nullable',
  ]);
});

test('ClickHouse: Nullable(UUID) permits NULL, so X1 fires for its non-nullable response property as well', async () => {
  const found = await detect({ 'db/clickhouse/schema.sql': clickhouseTable('Nullable(UUID)') });
  assert.deepEqual(found.x1, [
    'the database permits NULL in referrer but the contract declares referrer non-nullable',
    'the database permits NULL in session_id but the contract declares sessionId non-nullable',
  ]);
});

test('Postgres control: the same table with a nullable uuid column fires X1 against the stated response', async () => {
  const found = await detect({ 'db/schema.sql': POSTGRES_TABLE });
  assert.deepEqual(found.x1, [
    'the database permits NULL in hits but the contract declares hits non-nullable',
    'the database permits NULL in referrer but the contract declares referrer non-nullable',
    'the database permits NULL in session_id but the contract declares sessionId non-nullable',
  ]);
});

test('ClickHouse types compare by their underlying type; aggregate-state types never mismatch', async () => {
  const found = await detect({ 'db/clickhouse/schema.sql': clickhouseTable('UUID') });
  // `visits UInt32` is an integer column behind a string response property: a supported
  // disagreement. `hits SimpleAggregateFunction(sum, UInt64)` has no scalar
  // type to disagree with, so it is skipped rather than reported.
  assert.deepEqual(found.x2, ['visits stores integer but the contract declares visits as string']);
});
