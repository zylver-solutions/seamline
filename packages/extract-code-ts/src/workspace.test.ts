/**
 * A repository with no root `tsconfig.json` and a tsconfig per workspace
 * package: what is read, what is claimed, and what is not.
 *
 * Every assertion is an outcome (a status, a symbol id, whether a selector
 * covers a path, which facts survive a second run), never that a function
 * exists.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { SqliteStore, compileSelector } from '@seamline/core';
import type { SeamlineNode } from '@seamline/ontology';
import { extractCodeTs } from './extract.ts';
import type { ExtractCodeTsOutput } from './extract.ts';
import { canonicalJson } from './serialize.ts';
import { cleanup, materialize } from './__fixtures__/projects.ts';
import { parsePnpmWorkspacePackages } from './workspace.ts';

/**
 * A data-model index that declares no table. A run with no index at all reports `ormIndexAbsent` on
 * the `Repo` node, and these tests are about workspace reading, so they hand over an index that binds
 * nothing (see `extract.test.ts`).
 */
const NO_TABLES_INDEX = JSON.stringify({
  version: 1,
  dataSources: [{ name: 'default', dialect: 'postgres', defaultSchema: 'public' }],
  tables: [],
  prismaDelegates: {},
  drizzleExports: {},
});

type Files = Readonly<Record<string, string>>;

const PACKAGE_CONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    noEmit: true,
  },
  include: ['src'],
});

const ALPHA_USER = 'export class User {\n  email: string | null = null;\n  id = 1;\n}\n';
const BETA_ORDER = 'export class Order {\n  total = 0;\n}\n';

/** What every run with a data-model index writes on the `Repo` node, whatever it read (see `describeRepo`). */
const WRITE_FACTS = { unknownWriterTables: '', untracedWriteCalls: 0, writeHooks: 0, runtimeDdl: 0 } as const;

const PNPM = "packages:\n  - 'packages/*'\n";

/** Two packages, each with its own tsconfig, and nothing at the root. */
function monorepo(extra: Files = {}, workspace: Files = { 'pnpm-workspace.yaml': PNPM }): Files {
  return {
    'package.json': JSON.stringify({ name: 'root', private: true }),
    ...workspace,
    'packages/alpha/package.json': JSON.stringify({ name: '@fx/alpha' }),
    'packages/alpha/tsconfig.json': PACKAGE_CONFIG,
    'packages/alpha/src/user.ts': ALPHA_USER,
    'packages/beta/package.json': JSON.stringify({ name: '@fx/beta' }),
    'packages/beta/tsconfig.json': PACKAGE_CONFIG,
    'packages/beta/src/order.ts': BETA_ORDER,
    ...extra,
  };
}

const roots: string[] = [];

function run(
  files: Files,
  label: string,
  overrides: Partial<Parameters<typeof extractCodeTs>[0]> = {},
): ExtractCodeTsOutput {
  const root = materialize(files, label);
  roots.push(root);
  return extractCodeTs({
    repoRoot: root,
    repo: 'fx',
    runId: 'run-1',
    deterministic: true, dataModelIndex: NO_TABLES_INDEX,
    ...overrides,
  });
}

after(() => {
  for (const root of roots) cleanup(root);
});

const ids = (output: ExtractCodeTsOutput, kind: SeamlineNode['kind']): string[] =>
  output.nodes.filter((n) => n.kind === kind).map((n) => String(n.id));

function selectorOf(output: ExtractCodeTsOutput): ReturnType<typeof compileSelector> {
  const selector = output.result.authoritative[0]?.selector;
  assert.ok(selector !== undefined, 'a PASS workspace run narrows its selector');
  return compileSelector(selector);
}

/* ------------------------------------------------------------- the main path */

const clean = run(monorepo(), 'ws-clean');

test('no root tsconfig, a tsconfig per workspace package: PASS with symbols from both packages', () => {
  assert.equal(clean.result.status, 'PASS');
  const symbols = ids(clean, 'Symbol');
  assert.ok(symbols.includes('fx:Symbol:@fx/alpha#User'), symbols.join(' '));
  assert.ok(symbols.includes('fx:Symbol:@fx/beta#Order'), symbols.join(' '));
  assert.deepEqual(ids(clean, 'Module'), ['fx:Module:@fx/alpha', 'fx:Module:@fx/beta']);
});

test('the selector covers exactly the packages that were read', () => {
  const selector = selectorOf(clean);
  assert.equal(selector.matches('packages/alpha/src/user.ts'), true);
  assert.equal(
    selector.matches('packages/alpha/src/deleted-since.ts'),
    true,
    'a deleted file stays inside the claim',
  );
  assert.equal(selector.matches('packages/beta/src/order.ts'), true);
  assert.equal(selector.matches('packages/gamma/src/anything.ts'), false);
  assert.equal(selector.matches('scripts/seed.ts'), false);
});

test('a fully read workspace marks nothing as unread and says where the packages came from', () => {
  const repo = clean.nodes.find((n) => n.kind === 'Repo');
  assert.deepEqual(repo?.props, WRITE_FACTS);
  assert.ok(
    clean.result.diagnostics.some((d) =>
      d.includes('2 workspace package(s) from pnpm-workspace.yaml'),
    ),
  );
});

test('an extends into a workspace package resolves without node_modules, so strict reaches the checker', () => {
  const out = run(
    monorepo({
      'packages/tsconfig/package.json': JSON.stringify({ name: '@fx/tsconfig' }),
      'packages/tsconfig/base.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'packages/alpha/tsconfig.json': JSON.stringify({
        extends: '@fx/tsconfig/base.json',
        include: ['src'],
      }),
    }),
    'ws-extends',
  );
  assert.equal(out.result.status, 'PASS');
  assert.deepEqual(out.nodes.find((n) => n.kind === 'Repo')?.props, WRITE_FACTS);
  const email = out.nodes.find((n) => String(n.id).startsWith('fx:CodeField:@fx/alpha#User.email'));
  assert.equal(
    email?.props['nullable'],
    true,
    'under strict, `string | null` is nullable; without it the type collapses to string',
  );
});

test('a path alias in one package resolves into another, and the edge lands on the other package symbol', () => {
  const out = run(
    monorepo({
      'packages/alpha/tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          paths: { '@fx/beta': ['../beta/src/order.ts'] },
        },
        include: ['src'],
      }),
      'packages/alpha/src/report.ts':
        "import { Order } from '@fx/beta';\nexport class Report {\n  order: Order = new Order();\n}\n",
    }),
    'ws-alias',
  );
  assert.equal(out.result.status, 'PASS');
  const hit = out.edges.some(
    (e) =>
      String(e.src).startsWith('fx:Symbol:@fx/alpha#Report') &&
      String(e.dst) === 'fx:Symbol:@fx/beta#Order',
  );
  assert.ok(
    hit,
    'Report in alpha uses Order declared by beta; the declaration is the one beta owns',
  );
  assert.equal(ids(out, 'Symbol').filter((i) => i === 'fx:Symbol:@fx/beta#Order').length, 1);
});

/* --------------------------------------------------------- unreadable packages */

const broken = run(
  monorepo({
    'packages/gamma/package.json': JSON.stringify({ name: '@fx/gamma' }),
    'packages/gamma/tsconfig.json': JSON.stringify({
      extends: './not-there.json',
      include: ['src'],
    }),
    'packages/gamma/src/secret.ts': 'export class Secret {\n  value = "";\n}\n',
  }),
  'ws-broken',
);

test('a package whose tsconfig cannot be read is named, left out of the selector, and the rest still PASS', () => {
  assert.equal(broken.result.status, 'PASS');
  const symbols = ids(broken, 'Symbol');
  assert.ok(
    symbols.includes('fx:Symbol:@fx/alpha#User') && symbols.includes('fx:Symbol:@fx/beta#Order'),
  );
  assert.equal(
    symbols.some((s) => s.includes('@fx/gamma')),
    false,
    'unread code is not guessed at',
  );
  assert.ok(
    broken.result.diagnostics.some((d) =>
      d.startsWith('workspace package not read: packages/gamma:'),
    ),
    broken.result.diagnostics.join('\n'),
  );
  const selector = selectorOf(broken);
  assert.equal(
    selector.matches('packages/gamma/src/secret.ts'),
    false,
    'an unread package is not vouched for',
  );
  assert.equal(selector.matches('packages/alpha/src/user.ts'), true);
});

test('the Repo node names the unread packages, which is what makes absence-based detectors report UNKNOWN', () => {
  const repo = broken.nodes.find((n) => n.kind === 'Repo');
  assert.deepEqual(repo?.props, {
    ...WRITE_FACTS,
    unreadCodePackageCount: 1,
    unreadCodePackages: '["packages/gamma"]',
  });
});

test('an uninstalled package base is tolerated only when the config itself fixes strictness', () => {
  const withStrict = run(
    monorepo({
      'packages/alpha/tsconfig.json': JSON.stringify({
        extends: 'some-preset/tsconfig.json',
        compilerOptions: { strict: true },
        include: ['src'],
      }),
    }),
    'ws-base-strict',
  );
  assert.equal(withStrict.result.status, 'PASS');
  assert.deepEqual(withStrict.nodes.find((n) => n.kind === 'Repo')?.props, WRITE_FACTS, 'alpha is read');
  assert.ok(ids(withStrict, 'Symbol').includes('fx:Symbol:@fx/alpha#User'));
  assert.ok(
    withStrict.result.diagnostics.some((d) =>
      d.includes('"some-preset/tsconfig.json" is not installed'),
    ),
  );

  const without = run(
    monorepo({
      'packages/alpha/tsconfig.json': JSON.stringify({
        extends: 'some-preset/tsconfig.json',
        include: ['src'],
      }),
    }),
    'ws-base-unknown',
  );
  assert.equal(without.result.status, 'PASS');
  assert.equal(
    ids(without, 'Symbol').some((s) => s.includes('@fx/alpha')),
    false,
    'nullability would be guessed',
  );
  assert.deepEqual(without.nodes.find((n) => n.kind === 'Repo')?.props, {
    ...WRITE_FACTS,
    unreadCodePackageCount: 1,
    unreadCodePackages: '["packages/alpha"]',
  });
  assert.ok(
    without.result.diagnostics.some((d) => d.includes('nothing readable settles null checking')),
  );
});

test('a workspace package with code and no tsconfig is unread, not "no code there"', () => {
  const out = run(
    monorepo({
      'packages/plain/package.json': JSON.stringify({ name: '@fx/plain' }),
      'packages/plain/index.ts': 'export const x = 1;\n',
    }),
    'ws-plain',
  );
  assert.equal(out.result.status, 'PASS');
  assert.deepEqual(out.nodes.find((n) => n.kind === 'Repo')?.props, {
    ...WRITE_FACTS,
    unreadCodePackageCount: 1,
    unreadCodePackages: '["packages/plain"]',
  });
});

/* ---------------------------------------------------- other workspace spellings */

test('npm and yarn `workspaces`, as an array and as { packages }, find the same packages', () => {
  const arrayForm = run(
    {
      ...monorepo({}, {}),
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    },
    'ws-npm-array',
  );
  const objectForm = run(
    {
      ...monorepo({}, {}),
      'package.json': JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
    },
    'ws-npm-object',
  );
  for (const out of [arrayForm, objectForm]) {
    assert.equal(out.result.status, 'PASS');
    assert.deepEqual(ids(out, 'Module'), ['fx:Module:@fx/alpha', 'fx:Module:@fx/beta']);
    assert.ok(out.result.diagnostics.some((d) => d.includes('package.json workspaces')));
  }
});

test('negated workspace globs leave a package out', () => {
  const out = run(
    monorepo({}, { 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/beta'\n" }),
    'ws-negated',
  );
  assert.deepEqual(ids(out, 'Module'), ['fx:Module:@fx/alpha']);
  assert.equal(selectorOf(out).matches('packages/beta/src/order.ts'), false);
});

test('the pnpm packages list reads block and flow sequences, quotes and comments', () => {
  assert.deepEqual(
    parsePnpmWorkspacePackages('packages:\n  - apps/*  # apps\n  - "packages/*"\n\nother: 1\n'),
    ['apps/*', 'packages/*'],
  );
  assert.deepEqual(parsePnpmWorkspacePackages('packages: [\'a/*\', "b/*"]\n'), ['a/*', 'b/*']);
  assert.deepEqual(parsePnpmWorkspacePackages('packages:\n- a/*\n- b/*\n'), ['a/*', 'b/*']);
  assert.equal(parsePnpmWorkspacePackages('catalog:\n  x: 1\n'), null);
});

/* ------------------------------------------------------------ UNAVAILABLE as before */

test('no workspace config and no root tsconfig stays UNAVAILABLE with the same single reason', () => {
  const out = run(
    {
      'package.json': JSON.stringify({ name: 'solo' }),
      'packages/alpha/package.json': JSON.stringify({ name: '@fx/alpha' }),
      'packages/alpha/tsconfig.json': PACKAGE_CONFIG,
      'packages/alpha/src/user.ts': ALPHA_USER,
    },
    'ws-none',
  );
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.nodes.length, 0);
  assert.deepEqual(out.result.diagnostics, ['no tsconfig.json at tsconfig.json']);
});

test('a workspace whose packages have no readable tsconfig is UNAVAILABLE, not an empty PASS', () => {
  const out = run(
    {
      'package.json': JSON.stringify({ name: 'root' }),
      'pnpm-workspace.yaml': PNPM,
      'packages/alpha/package.json': JSON.stringify({ name: '@fx/alpha' }),
      'packages/alpha/src/user.ts': ALPHA_USER,
    },
    'ws-no-configs',
  );
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.nodes.length, 0);
  assert.equal(out.result.diagnostics[0], 'no tsconfig.json at tsconfig.json');
});

test('a tsconfig path the caller named is not routed around, whatever the workspace says', () => {
  const out = run(monorepo(), 'ws-explicit', {
    tsConfigFilePath: nodePath.join(os.tmpdir(), 'seamline-no-such-tsconfig.json'),
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
});

test('a root tsconfig keeps the root path: the workspace config is not consulted', () => {
  const out = run(
    monorepo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { strict: true },
        include: ['packages/alpha/src'],
      }),
    }),
    'ws-root-wins',
  );
  assert.equal(out.result.status, 'PASS');
  assert.equal(
    out.result.diagnostics.some((d) => d.includes('workspace')),
    false,
  );
  // The root path also loads the other tsconfig.json files it finds; that is today's behavior, unchanged.
  assert.ok(ids(out, 'Module').includes('fx:Module:@fx/alpha'));
});

/* ---------------------------------------------------------------- reproducible */

function materializeReversed(files: Files, label: string): string {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `seamline-${label}-`));
  for (const rel of Object.keys(files).sort().reverse()) {
    const abs = nodePath.join(root, rel);
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel] ?? '', 'utf8');
  }
  return root;
}

test('two runs are byte-identical, from different directories created in different orders', () => {
  const files = monorepo({
    'packages/gamma/package.json': JSON.stringify({ name: '@fx/gamma' }),
    'packages/gamma/tsconfig.json': JSON.stringify({ extends: './not-there.json' }),
  });
  const a = run(files, 'ws-det-a');
  const rootB = materializeReversed(files, 'ws-det-b');
  roots.push(rootB);
  const b = extractCodeTs({ repoRoot: rootB, repo: 'fx', runId: 'run-1', deterministic: true, dataModelIndex: NO_TABLES_INDEX });
  assert.equal(a.result.status, 'PASS');
  assert.equal(
    canonicalJson({ r: a.result, n: a.nodes, e: a.edges }),
    canonicalJson({ r: b.result, n: b.nodes, e: b.edges }),
  );
  assert.ok(
    !canonicalJson(a.result).includes(os.tmpdir()),
    'no absolute path reaches a diagnostic',
  );
});

test('moving a file inside a package changes no symbol id', () => {
  const before = run(monorepo(), 'ws-mv-before');
  const moved = monorepo();
  const { 'packages/alpha/src/user.ts': user, ...rest } = moved as Record<string, string>;
  const after = run(
    { ...rest, 'packages/alpha/src/models/user.ts': user as string },
    'ws-mv-after',
  );
  assert.equal(after.result.status, 'PASS');
  const stable = (o: ExtractCodeTsOutput): string[] =>
    [...ids(o, 'Symbol'), ...ids(o, 'CodeField'), ...ids(o, 'Module')].sort();
  assert.deepEqual(stable(after), stable(before));
  assert.ok(ids(after, 'File').includes('fx:File:packages/alpha/src/models/user.ts'));
});

/* ------------------------------------------------------ data-model index, workspace read */

test('a workspace read without a data-model index is UNAVAILABLE when it reads raw SQL; with one it is PASS', () => {
  const sql = { 'packages/alpha/src/q.ts': "export function q(): string {\n  return 'SELECT id FROM users';\n}\n" };
  const root = materialize(monorepo(sql), 'ws-sql-no-index');
  roots.push(root);
  const withoutIndex = extractCodeTs({ repoRoot: root, repo: 'fx', runId: 'run-1', deterministic: true });
  assert.equal(withoutIndex.result.status, 'UNAVAILABLE');
  assert.equal(withoutIndex.nodes.find((n) => n.kind === 'Repo')?.props['ormIndexAbsent'], true);
  const withIndex = run(monorepo(sql), 'ws-sql-index');
  assert.equal(withIndex.result.status, 'PASS');
  assert.equal(withIndex.nodes.find((n) => n.kind === 'Repo')?.props['ormIndexAbsent'], undefined);
});

test('a workspace read emits the raw-SQL write columns and the write-guard facts the single-program read does', () => {
  const out = run(
    monorepo({
      'packages/alpha/src/q.ts':
        "export function add(): string {\n  return 'INSERT INTO users (id, email) VALUES ($1, $2)';\n}\n",
    }),
    'ws-sql-columns',
  );
  assert.equal(out.result.status, 'PASS');
  const write = out.edges.find((e) => e.kind === 'QUERIES' && e.props['operation'] === 'insert');
  assert.equal(write?.props['insertColumns'], 'email,id');
  assert.equal(write?.props['insertComplete'], true);
  assert.deepEqual(out.nodes.find((n) => n.kind === 'Repo')?.props, WRITE_FACTS);
});

/* ------------------------------------------------------- two runs, one store */

test('a SQL tokenizer resource limit in a workspace keeps its code scope unavailable', () => {
  const deep = `INSERT INTO users (id) VALUES ${'('.repeat(10_000)}1${')'.repeat(10_000)}`;
  const out = run(monorepo({
    'packages/alpha/src/q.ts': `export function add(): string { return ${JSON.stringify(deep)}; }`,
  }), 'ws-sql-resource-limit');
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.nodes.find((n) => n.kind === 'Repo')?.props['untracedWriteCalls'], 1);
  assert.ok(out.result.diagnostics.some((d) => d.includes('SQL tokenizer resource limit at packages/alpha/src/q.ts:1')));
});

test('a package unreadable in run 2 keeps its run-1 facts live; a file deleted from a read package is tombstoned', async () => {
  const gamma = {
    'packages/gamma/package.json': JSON.stringify({ name: '@fx/gamma' }),
    'packages/gamma/tsconfig.json': PACKAGE_CONFIG,
    'packages/gamma/src/secret.ts': 'export class Secret {\n  value = "";\n}\n',
    'packages/alpha/src/extra.ts': 'export class Extra {\n  n = 1;\n}\n',
  };
  const run1 = run(monorepo(gamma), 'ws-store-1');
  assert.equal(run1.result.status, 'PASS');
  assert.deepEqual(run1.nodes.find((n) => n.kind === 'Repo')?.props, WRITE_FACTS);

  // Run 2: gamma's tsconfig is now broken, and alpha lost a file.
  const second = monorepo({
    ...gamma,
    'packages/gamma/tsconfig.json': JSON.stringify({ extends: './gone.json' }),
  });
  delete (second as Record<string, string>)['packages/alpha/src/extra.ts'];
  const run2 = run(second, 'ws-store-2', { runId: 'run-2' });
  assert.equal(run2.result.status, 'PASS');
  assert.equal(
    ids(run2, 'Symbol').some((s) => s.includes('@fx/gamma')),
    false,
  );

  const store = new SqliteStore({
    ontologyVersion: '1.0.0',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  for (const [runId, out] of [
    ['run-1', run1],
    ['run-2', run2],
  ] as const) {
    await store.beginRun({
      runId,
      repo: 'fx',
      commit: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      ontologyVersion: '1.0.0',
    });
    await store.upsertNodes(runId, out.nodes);
    await store.upsertEdges(runId, 'code.ts', out.edges);
    await store.finalizeRun(runId, [out.result]);
  }
  const live = store.nodesByKind('Symbol').map((n) => String(n.id));
  assert.ok(live.includes('fx:Symbol:@fx/gamma#Secret'), 'the unread package is not forgotten');
  assert.ok(live.includes('fx:Symbol:@fx/alpha#User'));
  assert.equal(
    live.includes('fx:Symbol:@fx/alpha#Extra'),
    false,
    'a deletion inside a read package is still swept',
  );
  const gammaFile = store
    .nodesByKind('File')
    .find((n) => String(n.id) === 'fx:File:packages/gamma/src/secret.ts');
  assert.equal(gammaFile?.deletedAt, null);
  assert.equal(store.scopeStatus('code.ts'), 'PASS');
  const repoNode = store.nodesByKind('Repo').find((n) => String(n.id) === 'fx:Repo:fx');
  assert.equal(
    repoNode?.props['unreadCodePackages'],
    '["packages/gamma"]',
    'the live Repo node reports what run 2 did not read',
  );
});
