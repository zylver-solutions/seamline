/**
 * Real-extraction proof: a workspace package that `extract-code-ts` could not
 * read turns the detectors that reason from the absence of a code fact into
 * UNKNOWN.
 *
 * The two sides meet only through the `Repo` node's props
 * (`unreadCodePackageCount`, `unreadCodePackages`): `extract-code-ts` writes
 * them and `@seamline/contradictions` reads them by name. Each package's own
 * suite covers its side with a hand-built graph, so a rename on one side would
 * pass both. This test runs the real `extractData` and the real `extractCodeTs`
 * over a workspace with no root tsconfig, persists the output the way
 * `seamline extract` does, and runs the real detector runner against the store.
 * The only difference between the two runs is a package whose tsconfig cannot be
 * read, or a package whose manifest is `package.yaml`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import { CODE_TS_SCOPE, extractCodeTs } from '@seamline/extract-code-ts';
import { DATA_SCOPE, buildDataModelIndex, extractData } from '@seamline/extract-data';
import { runDetectors, x5UnwrittenColumn } from '@seamline/contradictions';
import { SqliteStore } from '@seamline/core';

const REPO = 'wsfixture';

const SCHEMA_SQL = `CREATE TABLE users (
    id     bigserial PRIMARY KEY,
    email  text NOT NULL
);
`;

const PACKAGE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    noEmit: true,
  },
  include: ['src'],
});

const WORKSPACE: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'root' }),
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
  'db/schema.sql': SCHEMA_SQL,
  'packages/api/package.json': JSON.stringify({ name: '@ws/api' }),
  'packages/api/tsconfig.json': PACKAGE_TSCONFIG,
  'packages/api/src/repository.ts':
    'export function createUser(): void {\n  db.query("INSERT INTO users (id) VALUES (1)");\n}\n\ndeclare const db: { query(sql: string): void };\n',
  'packages/jobs/package.json': JSON.stringify({ name: '@ws/jobs' }),
  'packages/jobs/tsconfig.json': PACKAGE_TSCONFIG,
  'packages/jobs/src/job.ts': 'export const job = 1;\n',
};

/**
 * The workspace with `packages/jobs` left readable, with its tsconfig cut off in
 * the middle, or with a manifest that is `package.yaml` (a name this extractor
 * cannot read, so the package cannot be read either).
 */
async function materialize(
  jobsTsconfig: string,
  jobsManifest: 'package.json' | 'package.yaml' = 'package.json',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'seamline-ws-unknown-'));
  created.push(root);
  const files: Record<string, string> = {
    ...WORKSPACE,
    'packages/jobs/tsconfig.json': jobsTsconfig,
  };
  if (jobsManifest === 'package.yaml') {
    delete files['packages/jobs/package.json'];
    files['packages/jobs/package.yaml'] = 'name: "@ws/jobs"\n';
  }
  for (const rel of Object.keys(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, files[rel] ?? '', 'utf8');
  }
  return root;
}

const created: string[] = [];

after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

/** Extracts `root` with the real extractors and returns what X5 says about the stored graph. */
async function x5Over(root: string): Promise<ReturnType<typeof runDetectors>['detectors'][number]> {
  const runId = 'run-1';
  const data = await extractData({ root, repo: REPO, runId, deterministic: true });
  const code = extractCodeTs({
    repoRoot: root,
    repo: REPO,
    runId,
    deterministic: true,
    dataModelIndex: buildDataModelIndex(data.nodes),
  });
  assert.equal(data.result.status, 'PASS');
  assert.equal(code.result.status, 'PASS', code.result.diagnostics.join('\n'));
  const store = new SqliteStore({ ontologyVersion: '1.0.0' });
  try {
    await store.beginRun({
      runId,
      repo: REPO,
      commit: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      ontologyVersion: '1.0.0',
    });
    await store.upsertNodes(runId, [...data.nodes, ...code.nodes]);
    await store.upsertEdges(runId, DATA_SCOPE, data.edges);
    await store.upsertEdges(runId, CODE_TS_SCOPE, code.edges);
    await store.finalizeRun(runId, [data.result, code.result]);
    const report = runDetectors(store, [x5UnwrittenColumn]);
    const x5 = report.detectors.find((d) => d.code === 'X5_UNWRITTEN_COLUMN');
    assert.ok(x5);
    return x5;
  } finally {
    await store.close();
  }
}

let readable: string;
let unreadable: string;
let yamlManifest: string;

before(async () => {
  readable = await materialize(PACKAGE_TSCONFIG);
  unreadable = await materialize('{ "compilerOptions": ');
  yamlManifest = await materialize(PACKAGE_TSCONFIG, 'package.yaml');
});

test('a workspace read whole: X5 reports the omitted required email, and no package is named unread', async () => {
  const x5 = await x5Over(readable);
  assert.equal(x5.outcome, 'fired');
  assert.equal(x5.findings.length, 1);
  assert.match(x5.findings[0]!.claim, /users\.email is NOT NULL.*none of the 1 traced insert path/u);
  assert.match(x5.findings[0]!.rightFact, /columns \[id\]/u);
  assert.equal(x5.result.known, true);
  assert.equal(x5.unreadCodePackages, undefined, 'nothing is reported unread');
});

test('the same workspace with one package whose tsconfig cannot be read: X5 is UNKNOWN, names the package and reports the count', async () => {
  const x5 = await x5Over(unreadable);
  assert.equal(x5.outcome, 'unknown');
  assert.equal(x5.findings.length, 0);
  assert.equal(x5.result.known, false);
  assert.equal(x5.unreadCodePackages, 1);
  if (!x5.result.known) {
    assert.match(x5.result.reason, /did not read 1 workspace package\(s\) \(packages\/jobs\)/);
  }
  // The scope itself still PASSes: this is why the verdict has to come from the Repo node.
  assert.deepEqual(x5.blockedScopes, []);
});

test('the same workspace with one package whose manifest is package.yaml: it is not silently absent, X5 is UNKNOWN and names the package', async () => {
  const x5 = await x5Over(yamlManifest);
  assert.equal(x5.outcome, 'unknown');
  assert.equal(x5.findings.length, 0);
  assert.equal(x5.unreadCodePackages, 1);
  if (!x5.result.known) {
    assert.match(x5.result.reason, /did not read 1 workspace package\(s\) \(packages\/jobs\)/);
  }
  assert.deepEqual(x5.blockedScopes, []);
});
