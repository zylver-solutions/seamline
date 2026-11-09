/**
 * The boundary of the rename guarantee, held against the real extractors.
 *
 * Identity is path-free for every kind except `File` (ADR-0016). A `git mv`
 * therefore changes no id but the moved `File`'s unless it changes an input
 * that a non-`File` id is built from; ADR-0016 item 4 lists those inputs, and
 * is the one place that does. The rule is over inputs, so the moves below are
 * illustrations of it and not a complete list of moves: each test moves or
 * renames files in a fixture repository, re-runs `extract-code-ts`,
 * `extract-data` and `extract-contracts`, and asserts the exact set of
 * non-`File` node ids and edge keys that changed, lost and gained. The
 * package-entry test pins an edge that reads a path while no id changes
 * (ADR-0016 item 4, "Edges"). The Drizzle test of two modules that export one
 * name pins that the FK_TO target follows the import binding (Drizzle foreign-key binding order).
 *
 * If one of these tests fails, either an id became path-dependent through an
 * input the ADR does not list (a defect: restore the invariant) or a listed
 * input stopped being path-dependent (update ADR-0016 item 4 in the same
 * change). Do not loosen an assertion to make it pass.
 */

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { extractCodeTs } from '@seamline/extract-code-ts';
import { extractContracts } from '@seamline/extract-contracts';
import { extractData } from '@seamline/extract-data';

const REPO = 'boundary';
const RUN = 'run-1';

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: '@fx/app', version: '1.0.0' }),
  'pkgb/package.json': JSON.stringify({ name: '@fx/b', version: '1.0.0' }),
  // Two classes under the same manifest: one inside `pkgb/src`, one outside it.
  'pkgb/src/keep.ts': 'export class Keep { v!: string; }\n',
  'pkgb/lib/other.ts': 'export class Other { w!: string; }\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: 'esnext',
      target: 'es2022',
      moduleResolution: 'bundler',
    },
  }),
  'src/user.ts':
    'export class User { id!: string; greet(n: number): string { return String(n); } }\n',
  'src/routes.ts': [
    "import express from 'express';",
    'const app = express();',
    "app.get('/users/:id', (req: any, res: any) => { res.send('x'); });",
    '',
  ].join('\n'),
  'db/schema.sql': 'CREATE TABLE accounts (id serial PRIMARY KEY, email text NOT NULL);\n',
  'db/migrations/1_init.sql': 'CREATE TABLE users (id int PRIMARY KEY, email text);\n',
  'db/migrations/2_add_phone.sql': 'ALTER TABLE users ADD COLUMN phone text;\n',
  'prisma/migrations/20240101_init/migration.sql': 'CREATE TABLE notes (id int PRIMARY KEY);\n',
  // A titled contract: its name is `info.title`, so its file name is not part of any id.
  'api/titled.yaml': [
    'openapi: 3.0.3',
    'info:',
    '  title: Titled API',
    '  version: 1.0.0',
    'paths:',
    '  /pong:',
    '    get:',
    '      operationId: pong',
    '      responses:',
    "        '200':",
    '          description: ok',
    '          content:',
    '            application/json:',
    '              schema:',
    '                type: object',
    '                properties:',
    '                  n: { type: integer }',
    '',
  ].join('\n'),
  // An untitled contract: no `info.title`, so the file stem is its name.
  'api/openapi.yaml': [
    'openapi: 3.0.3',
    'info:',
    '  version: 1.0.0',
    'paths:',
    '  /ping:',
    '    get:',
    '      operationId: ping',
    '      responses:',
    "        '200':",
    '          description: ok',
    '          content:',
    '            application/json:',
    '              schema:',
    '                type: object',
    '                properties:',
    '                  ok: { type: boolean }',
    '',
  ].join('\n'),
  // An untitled JSON Schema (no `$id`, no `title`) and a titled one.
  'schemas/plain.schema.json': JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { a: { type: 'string' } },
  }),
  'schemas/titled.schema.json': JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Titled',
    type: 'object',
    properties: { b: { type: 'string' } },
  }),
};

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function fixture(extra: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'seamline-rename-boundary-'));
  temps.push(root);
  for (const [rel, text] of Object.entries({ ...FILES, ...extra })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
  return root;
}

/** `git mv` without git: the extractors read the tree, so a rename on disk is the same input. */
function move(root: string, from: string, to: string): void {
  mkdirSync(dirname(join(root, to)), { recursive: true });
  renameSync(join(root, from), join(root, to));
}

interface Snapshot {
  readonly ids: ReadonlySet<string>;
  readonly edgeKeys: ReadonlySet<string>;
}

const kindOf = (id: string): string => id.split(':')[1] ?? '';

/** Every non-`File` node id and every edge key between non-`File` nodes. */
async function snapshot(root: string): Promise<Snapshot> {
  const code = extractCodeTs({ repoRoot: root, repo: REPO, runId: RUN, deterministic: true });
  const data = await extractData({ root, repo: REPO, runId: RUN, deterministic: true });
  const contracts = extractContracts({ repoRoot: root, repo: REPO, runId: RUN });
  for (const [name, result] of [
    ['extract-code-ts', code.result],
    ['extract-data', data.result],
    ['extract-contracts', contracts.result],
  ] as const) {
    assert.equal(
      result.status,
      'PASS',
      `${name} must PASS on the fixture so absence means absence`,
    );
  }
  const nodes: readonly SeamlineNode[] = [...code.nodes, ...data.nodes, ...contracts.nodes];
  const edges: readonly SeamlineEdge[] = [...code.edges, ...data.edges, ...contracts.edges];
  return {
    ids: new Set(nodes.map((n) => String(n.id)).filter((id) => kindOf(id) !== 'File')),
    edgeKeys: new Set(
      edges
        .filter((e) => kindOf(String(e.src)) !== 'File' && kindOf(String(e.dst)) !== 'File')
        .map((e) => `${e.kind} ${String(e.src)} -> ${String(e.dst)}`),
    ),
  };
}

interface Delta {
  readonly idsLost: readonly string[];
  readonly idsGained: readonly string[];
  readonly edgeKeysLost: readonly string[];
  readonly edgeKeysGained: readonly string[];
}

const only = (a: ReadonlySet<string>, b: ReadonlySet<string>): string[] =>
  [...a].filter((x) => !b.has(x)).sort();

function delta(before: Snapshot, after: Snapshot): Delta {
  return {
    idsLost: only(before.ids, after.ids),
    idsGained: only(after.ids, before.ids),
    edgeKeysLost: only(before.edgeKeys, after.edgeKeys),
    edgeKeysGained: only(after.edgeKeys, before.edgeKeys),
  };
}

interface Moved {
  readonly before: Snapshot;
  readonly after: Snapshot;
  readonly delta: Delta;
}

async function applyMoves(
  moves: ReadonlyArray<readonly [string, string]>,
  extra: Readonly<Record<string, string>> = {},
  rewrites: Readonly<Record<string, string>> = {},
): Promise<Moved> {
  const root = fixture(extra);
  const before = await snapshot(root);
  for (const [from, to] of moves) move(root, from, to);
  // A real rename also edits the files that name the moved one (an import, say).
  for (const [rel, text] of Object.entries(rewrites)) writeFileSync(join(root, rel), text, 'utf8');
  const after = await snapshot(root);
  return { before, after, delta: delta(before, after) };
}

/** The endpoints of an edge key (`KIND src -> dst`); ids contain spaces but never ` -> `. */
function endpoints(key: string): readonly [string, string] {
  const [left = '', dst = ''] = key.split(' -> ');
  return [left.slice(left.indexOf(' ') + 1), dst];
}

/**
 * When ids change, the edge keys that change are exactly the ones that name them: every key
 * before the move that has a lost id as an endpoint is gone, every key after it that has a
 * gained id as an endpoint is new, and no other key moves.
 */
function assertEdgesFollowIds(moved: Moved, label: string): void {
  const lost = new Set(moved.delta.idsLost);
  const gained = new Set(moved.delta.idsGained);
  const naming = (keys: ReadonlySet<string>, ids: ReadonlySet<string>): string[] =>
    [...keys].filter((k) => endpoints(k).some((id) => ids.has(id))).sort();
  assert.deepEqual(moved.delta.edgeKeysLost, naming(moved.before.edgeKeys, lost), `${label}: lost`);
  assert.deepEqual(
    moved.delta.edgeKeysGained,
    naming(moved.after.edgeKeys, gained),
    `${label}: gained`,
  );
}

/** Both sides of the edge delta are non-empty and made only of edges of the given kinds. */
function assertKinds(moved: Moved, kinds: readonly string[]): void {
  for (const side of [moved.delta.edgeKeysLost, moved.delta.edgeKeysGained]) {
    assert.ok(side.length > 0);
    assert.ok(side.every((k) => kinds.includes(k.split(' ')[0] ?? '')));
  }
}

const NONE: Delta = { idsLost: [], idsGained: [], edgeKeysLost: [], edgeKeysGained: [] };

test('a move or rename inside a package with no entry file changes no non-File id and no edge key between non-File nodes', async () => {
  const unchanged: ReadonlyArray<readonly [string, string]> = [
    ['src/user.ts', 'src/account.ts'],
    ['src/user.ts', 'src/models/user.ts'],
    ['src/routes.ts', 'src/http/routes.ts'],
    ['db/schema.sql', 'db/tables.sql'],
    ['api/titled.yaml', 'api/renamed.yaml'],
    ['schemas/titled.schema.json', 'schemas/other.schema.json'],
    // Directories above a contract or a schema are not part of any name.
    ['api', 'contracts'],
    ['db', 'database'],
    // A migrations directory renamed to another name that still marks migrations.
    ['db/migrations', 'db/migrate'],
    // A whole package directory: the package name comes from package.json, not from the path.
    ['pkgb', 'pkgc'],
  ];
  for (const [from, to] of unchanged) {
    const moved = await applyMoves([[from, to]]);
    assert.deepEqual(moved.delta, NONE, `${from} -> ${to}`);
  }
});

test('moving a file to another package changes the package part of its symbol, field and parameter ids', async () => {
  const moved = await applyMoves([['src/user.ts', 'pkgb/src/user.ts']]);
  assert.deepEqual(moved.delta.idsLost, [
    `${REPO}:CodeField:@fx/app#User.id`,
    `${REPO}:Parameter:@fx/app#User.greet(0)n`,
    `${REPO}:Symbol:@fx/app#User`,
    `${REPO}:Symbol:@fx/app#User.greet`,
  ]);
  assert.deepEqual(moved.delta.idsGained, [
    `${REPO}:CodeField:@fx/b#User.id`,
    `${REPO}:Parameter:@fx/b#User.greet(0)n`,
    `${REPO}:Symbol:@fx/b#User`,
    `${REPO}:Symbol:@fx/b#User.greet`,
  ]);
  // Only the CONTAINS edges that name those ids move with them, on both sides.
  assertEdgesFollowIds(moved, 'cross-package move');
  assertKinds(moved, ['CONTAINS']);
});

test('a cross-package move leaves a RouteHandler id alone and changes the synthesized handler Symbol', async () => {
  const moved = await applyMoves([['src/routes.ts', 'pkgb/src/routes.ts']]);
  const handler = `${REPO}:RouteHandler:GET /users/:id`;
  assert.ok(moved.before.ids.has(handler), 'the fixture registers the route');
  assert.ok(!moved.delta.idsLost.includes(handler) && !moved.delta.idsGained.includes(handler));
  assert.ok(moved.delta.idsLost.length > 0);
  assert.ok(
    [...moved.delta.idsLost, ...moved.delta.idsGained].every((id) => kindOf(id) === 'Symbol'),
    'only Symbol ids change, among them the synthesized top-level handler',
  );
  assert.ok(moved.delta.idsLost.includes(`${REPO}:Symbol:@fx/app#app.GET /users/:id`));
  assert.ok(moved.delta.idsGained.includes(`${REPO}:Symbol:@fx/b#app.GET /users/:id`));
  // HANDLES_ROUTE runs from that Symbol to the RouteHandler, so its key follows the Symbol.
  assertEdgesFollowIds(moved, 'cross-package route move');
  assertKinds(moved, ['HANDLES_ROUTE']);
  assert.deepEqual(moved.delta.edgeKeysLost, [
    `HANDLES_ROUTE ${REPO}:Symbol:@fx/app#app.GET /users/:id -> ${handler}`,
  ]);
  assert.deepEqual(moved.delta.edgeKeysGained, [
    `HANDLES_ROUTE ${REPO}:Symbol:@fx/b#app.GET /users/:id -> ${handler}`,
  ]);
});

test('a SQL file moved to another package keeps every table, column and migration id', async () => {
  for (const file of ['db/schema.sql', 'db/migrations/1_init.sql']) {
    const moved = await applyMoves([[file, `pkgb/${file}`]]);
    assert.deepEqual(moved.delta, NONE, file);
  }
});

test('renaming an untitled contract file changes the Contract and SchemaProperty ids, not the Operation id', async () => {
  const moved = await applyMoves([['api/openapi.yaml', 'api/account.yaml']]);
  const property =
    '#/paths/~1ping/get/responses/200/content/application~1json/schema/properties/ok';
  assert.deepEqual(moved.delta.idsLost, [
    `${REPO}:Contract:openapi`,
    `${REPO}:SchemaProperty:openapi${property}`,
  ]);
  assert.deepEqual(moved.delta.idsGained, [
    `${REPO}:Contract:account`,
    `${REPO}:SchemaProperty:account${property}`,
  ]);
  assert.ok(moved.before.ids.has(`${REPO}:Operation:GET /ping`));
  // The CONTAINS keys that name the Contract and the SchemaProperty change on both sides, nothing else does.
  assertEdgesFollowIds(moved, 'untitled contract renamed');
  assertKinds(moved, ['CONTAINS']);
  // The Operation and the RouteHandler it implements keep their ids, so IMPLEMENTED_BY is untouched.
  assert.ok(!moved.delta.edgeKeysLost.some((k) => k.startsWith('IMPLEMENTED_BY ')));
  assert.ok(!moved.delta.edgeKeysGained.some((k) => k.startsWith('IMPLEMENTED_BY ')));
});

test('renaming an untitled JSON Schema file changes its Contract and SchemaProperty ids', async () => {
  const moved = await applyMoves([['schemas/plain.schema.json', 'schemas/flat.schema.json']]);
  // The stem keeps `.schema`: only the final `.json` is stripped.
  assert.deepEqual(moved.delta.idsLost, [
    `${REPO}:Contract:plain.schema`,
    `${REPO}:SchemaProperty:plain.schema#/properties/a`,
  ]);
  assert.deepEqual(moved.delta.idsGained, [
    `${REPO}:Contract:flat.schema`,
    `${REPO}:SchemaProperty:flat.schema#/properties/a`,
  ]);
  assertEdgesFollowIds(moved, 'untitled JSON Schema renamed');
  assertKinds(moved, ['CONTAINS']);
});

test('renaming a migration file that keeps its place in the order changes the Migration id and the MIGRATED_BY keys, and no table or column id', async () => {
  const moved = await applyMoves([['db/migrations/1_init.sql', 'db/migrations/1_initial.sql']]);
  assert.deepEqual(moved.delta.idsLost, [`${REPO}:Migration:1_init`]);
  assert.deepEqual(moved.delta.idsGained, [`${REPO}:Migration:1_initial`]);
  assertEdgesFollowIds(moved, 'migration renamed');
  assertKinds(moved, ['MIGRATED_BY']);
  // Every lost key ends at the old id, and the gained keys are the same edges ending at the new id.
  assert.ok(moved.delta.edgeKeysLost.every((k) => k.endsWith(`-> ${REPO}:Migration:1_init`)));
  assert.deepEqual(
    moved.delta.edgeKeysGained,
    moved.delta.edgeKeysLost
      .map((k) => k.replace(`-> ${REPO}:Migration:1_init`, `-> ${REPO}:Migration:1_initial`))
      .sort(),
  );
});

test('a Prisma migration takes its id from the directory name, and from the file name if that is not migration.sql', async () => {
  const dir = await applyMoves([
    ['prisma/migrations/20240101_init', 'prisma/migrations/20240101_start'],
  ]);
  assert.deepEqual(dir.delta.idsLost, [`${REPO}:Migration:20240101_init`]);
  assert.deepEqual(dir.delta.idsGained, [`${REPO}:Migration:20240101_start`]);

  const file = await applyMoves([
    [
      'prisma/migrations/20240101_init/migration.sql',
      'prisma/migrations/20240101_init/renamed.sql',
    ],
  ]);
  assert.deepEqual(file.delta.idsLost, [`${REPO}:Migration:20240101_init`]);
  assert.deepEqual(file.delta.idsGained, [`${REPO}:Migration:renamed`]);
});

test('a SQL file that leaves a migrations directory stops being a Migration but keeps its tables', async () => {
  const moved = await applyMoves([['db/migrations/1_init.sql', 'db/1_init.sql']]);
  assert.deepEqual(moved.delta.idsLost, [`${REPO}:Migration:1_init`]);
  assert.deepEqual(moved.delta.idsGained, []);
  assert.ok(
    [...moved.before.ids].some((id) => /^boundary:Table:.*\.users$/u.test(id)),
    'the fixture creates the users table in that file',
  );
});

test('migrations that share a version are each qualified by their directory, so renaming one directory changes only that id', async () => {
  const root = fixture({
    'svc/migrations/1_init.sql': 'CREATE TABLE svc_things (id int PRIMARY KEY);\n',
  });
  const before = await snapshot(root);
  const migrations = (s: Snapshot): string[] =>
    [...s.ids].filter((id) => kindOf(id) === 'Migration').sort();
  // Both holders of version `1_init` are qualified; neither keeps the bare version.
  assert.deepEqual(migrations(before), [
    `${REPO}:Migration:1_init~db~migrations`,
    `${REPO}:Migration:1_init~svc~migrations`,
    `${REPO}:Migration:20240101_init`,
    `${REPO}:Migration:2_add_phone`,
  ]);
  const svcKey = [...before.edgeKeys].find(
    (k) => k.includes('svc_things') && k.endsWith(`-> ${REPO}:Migration:1_init~svc~migrations`),
  );
  assert.ok(svcKey !== undefined);

  // Renaming `db` to `zz` changes the id of the `db` file's migration and no other, whatever
  // the new directory sorts as: the qualifier is the directory, not a position in an order.
  move(root, 'db', 'zz');
  const afterRename = await snapshot(root);
  const changed = delta(before, afterRename);
  assert.deepEqual(changed.idsLost, [`${REPO}:Migration:1_init~db~migrations`]);
  assert.deepEqual(changed.idsGained, [`${REPO}:Migration:1_init~zz~migrations`]);
  assert.ok(changed.edgeKeysLost.length > 0);
  assert.ok(
    changed.edgeKeysLost.every((k) => k.endsWith(`-> ${REPO}:Migration:1_init~db~migrations`)),
  );
  assert.ok(
    changed.edgeKeysGained.every((k) => k.endsWith(`-> ${REPO}:Migration:1_init~zz~migrations`)),
  );
  assert.ok(afterRename.edgeKeys.has(svcKey), 'the svc migration keeps its edge');
});

// ---------------------------------------------------------------------------
// The governing package is an input, and so is the `package.json` that names it.
// ---------------------------------------------------------------------------

const APP = `${REPO}:Module:@fx/app`;
const keepAndOther = (pkg: string): string[] => [
  `${REPO}:CodeField:${pkg}#Keep.v`,
  `${REPO}:CodeField:${pkg}#Other.w`,
  `${REPO}:Symbol:${pkg}#Keep`,
  `${REPO}:Symbol:${pkg}#Other`,
];

test('renaming a package.json re-parents every file below it that no nearer manifest governs, though no source file moved', async () => {
  const moved = await applyMoves([['pkgb/package.json', 'pkgb/package.old.json']]);
  // `pkgb/` now falls under the root manifest: its classes change package and `@fx/b` has no files.
  assert.deepEqual(moved.delta.idsLost, [`${REPO}:Module:@fx/b`, ...keepAndOther('@fx/b')].sort());
  assert.deepEqual(moved.delta.idsGained, keepAndOther('@fx/app'));
  assert.ok(
    moved.before.ids.has(APP) && moved.after.ids.has(APP),
    'the root package keeps its Module',
  );
  assertEdgesFollowIds(moved, 'pkgb/package.json renamed');
  assert.ok(moved.delta.edgeKeysLost.length > 0);
});

test('moving a package.json down a directory re-parents only the files that are now outside it', async () => {
  const moved = await applyMoves([['pkgb/package.json', 'pkgb/src/package.json']]);
  // `pkgb/lib/other.ts` is outside `pkgb/src`; `pkgb/src/keep.ts` is still governed by `@fx/b`.
  assert.deepEqual(moved.delta.idsLost, [
    `${REPO}:CodeField:@fx/b#Other.w`,
    `${REPO}:Symbol:@fx/b#Other`,
  ]);
  assert.deepEqual(moved.delta.idsGained, [
    `${REPO}:CodeField:@fx/app#Other.w`,
    `${REPO}:Symbol:@fx/app#Other`,
  ]);
  assert.ok(
    moved.after.ids.has(`${REPO}:Module:@fx/b`),
    'the package still has a file, so it keeps its Module',
  );
  assertEdgesFollowIds(moved, 'pkgb/package.json moved to pkgb/src');
  assert.ok(moved.delta.edgeKeysLost.length > 0);
});

test('removing the root package.json sends every file it governed to <root>', async () => {
  const moved = await applyMoves([['package.json', 'package.json.bak']]);
  const governed = [
    ['CodeField', 'User.id'],
    ['Parameter', 'User.greet(0)n'],
    ['Symbol', 'User'],
    ['Symbol', 'User.greet'],
    ['Symbol', 'app'],
    ['Symbol', 'app.GET /users/:id'],
  ] as const;
  const ids = (pkg: string): string[] =>
    [
      `${REPO}:Module:${pkg}`,
      ...governed.map(([kind, name]) => `${REPO}:${kind}:${pkg}#${name}`),
    ].sort();
  assert.deepEqual(moved.delta.idsLost, ids('@fx/app'));
  assert.deepEqual(moved.delta.idsGained, ids('<root>'));
  // `@fx/b` has its own manifest and is untouched.
  assert.ok(moved.after.ids.has(`${REPO}:Symbol:@fx/b#Keep`));
  assertEdgesFollowIds(moved, 'root package.json removed');
});

// ---------------------------------------------------------------------------
// Same-version migrations: every member is qualified by its directory.
// ---------------------------------------------------------------------------

const SAME_VERSION: Readonly<Record<string, string>> = {
  'a/migrations/0001_init.sql': 'CREATE TABLE a_t (id int PRIMARY KEY);\n',
  'b/migrations/0001_init.sql': 'CREATE TABLE b_t (id int PRIMARY KEY);\n',
};
/** The MIGRATED_BY keys of one table and its `id` column, to the given Migration canonical name. */
const migratedBy = (table: string, migration: string): string[] =>
  [
    `MIGRATED_BY ${REPO}:Column:public.${table}.id -> ${REPO}:Migration:${migration}`,
    `MIGRATED_BY ${REPO}:Table:public.${table} -> ${REPO}:Migration:${migration}`,
  ].sort();
const mineOf = (s: Snapshot, table: string): string[] =>
  [...s.edgeKeys].filter((k) => k.startsWith('MIGRATED_BY') && k.includes(`.${table}`)).sort();

test('moving a same-version migration to another directory changes only that file id, whatever the directory sorts as', async () => {
  const moved = await applyMoves(
    [['b/migrations/0001_init.sql', '0/migrations/0001_init.sql']],
    SAME_VERSION,
  );
  assert.deepEqual(mineOf(moved.before, 'a_t'), migratedBy('a_t', '0001_init~a~migrations'));
  assert.deepEqual(mineOf(moved.before, 'b_t'), migratedBy('b_t', '0001_init~b~migrations'));
  // `0/migrations` now sorts before `a/migrations`; nothing swaps, and `a` is untouched.
  assert.deepEqual(moved.delta.idsLost, [`${REPO}:Migration:0001_init~b~migrations`]);
  assert.deepEqual(moved.delta.idsGained, [`${REPO}:Migration:0001_init~0~migrations`]);
  assert.deepEqual(moved.delta.edgeKeysLost, migratedBy('b_t', '0001_init~b~migrations'));
  assert.deepEqual(moved.delta.edgeKeysGained, migratedBy('b_t', '0001_init~0~migrations'));
  assert.deepEqual(mineOf(moved.after, 'a_t'), migratedBy('a_t', '0001_init~a~migrations'));
});

test('renaming one of two same-version migrations changes the id of the one that was not touched', async () => {
  const moved = await applyMoves(
    [['a/migrations/0001_init.sql', 'a/migrations/0001_a.sql']],
    SAME_VERSION,
  );
  // The renamed file takes its new version. The `b` file was qualified only because `a` shared its
  // version; it is now alone, so it holds the bare version and its id changes though its file did not.
  assert.deepEqual(moved.delta.idsLost, [
    `${REPO}:Migration:0001_init~a~migrations`,
    `${REPO}:Migration:0001_init~b~migrations`,
  ]);
  assert.deepEqual(moved.delta.idsGained, [
    `${REPO}:Migration:0001_a`,
    `${REPO}:Migration:0001_init`,
  ]);
  assert.deepEqual(
    moved.delta.edgeKeysLost,
    [
      ...migratedBy('a_t', '0001_init~a~migrations'),
      ...migratedBy('b_t', '0001_init~b~migrations'),
    ].sort(),
  );
  assert.deepEqual(
    moved.delta.edgeKeysGained,
    [...migratedBy('a_t', '0001_a'), ...migratedBy('b_t', '0001_init')].sort(),
  );
});

test('three same-version migrations are all qualified, and renaming one directory changes only that id', async () => {
  const three = {
    ...SAME_VERSION,
    'c/migrations/0001_init.sql': 'CREATE TABLE c_t (id int PRIMARY KEY);\n',
  };
  const moved = await applyMoves([['c/migrations', 'd/migrations']], three);
  for (const [table, dir] of [
    ['a_t', 'a'],
    ['b_t', 'b'],
    ['c_t', 'c'],
  ] as const) {
    assert.deepEqual(mineOf(moved.before, table), migratedBy(table, `0001_init~${dir}~migrations`));
  }
  assert.deepEqual(moved.delta.idsLost, [`${REPO}:Migration:0001_init~c~migrations`]);
  assert.deepEqual(moved.delta.idsGained, [`${REPO}:Migration:0001_init~d~migrations`]);
  assert.deepEqual(moved.delta.edgeKeysLost, migratedBy('c_t', '0001_init~c~migrations'));
  assert.deepEqual(moved.delta.edgeKeysGained, migratedBy('c_t', '0001_init~d~migrations'));
});

// ---------------------------------------------------------------------------
// The order in which SQL sources are applied is read from their paths.
// ---------------------------------------------------------------------------

test('renaming a migration so it sorts before the one that creates its table changes a column id, not only the Migration id', async () => {
  const extra = {
    'db/migrations/3_rename_email.sql': 'ALTER TABLE users RENAME COLUMN email TO mail;\n',
  };
  const moved = await applyMoves(
    [['db/migrations/3_rename_email.sql', 'db/migrations/0_rename_email.sql']],
    extra,
  );
  // Applied first, the rename finds no table and does nothing; the later CREATE leaves `email`.
  assert.ok(moved.before.ids.has(`${REPO}:Column:public.users.mail`));
  assert.deepEqual(moved.delta.idsLost, [
    `${REPO}:Column:public.users.mail`,
    `${REPO}:Migration:3_rename_email`,
  ]);
  assert.deepEqual(moved.delta.idsGained, [
    `${REPO}:Column:public.users.email`,
    `${REPO}:Migration:0_rename_email`,
  ]);
  assertEdgesFollowIds(moved, 'migration reordered');
});

test('renaming a plain SQL file changes a column id when it changes which file is applied first', async () => {
  const extra = { 'db/tweaks.sql': 'ALTER TABLE accounts RENAME COLUMN email TO mail;\n' };
  // `db/tweaks.sql` sorts after `db/schema.sql`, so the rename applies; as `db/alter.sql` it does not.
  const moved = await applyMoves([['db/tweaks.sql', 'db/alter.sql']], extra);
  assert.deepEqual(moved.delta.idsLost, [`${REPO}:Column:public.accounts.mail`]);
  assert.deepEqual(moved.delta.idsGained, [`${REPO}:Column:public.accounts.email`]);
  assertEdgesFollowIds(moved, 'plain SQL reordered');
  // A rename that keeps the order changes nothing.
  const same = await applyMoves([['db/tweaks.sql', 'db/zz-tweaks.sql']], extra);
  assert.deepEqual(same.delta, NONE);
});

test('renaming a directory above two migrations directories changes a column id and no Migration id', async () => {
  const extra = {
    'm1/migrations/10_make_things.sql': 'CREATE TABLE things (id int PRIMARY KEY, label text);\n',
    'm2/migrations/11_rename_label.sql': 'ALTER TABLE things RENAME COLUMN label TO name;\n',
  };
  // Migrations are applied by directory first, then by version: `m1` before `m2`, then the reverse.
  const moved = await applyMoves([['m1', 'm3']], extra);
  assert.deepEqual(moved.delta.idsLost, [`${REPO}:Column:public.things.name`]);
  assert.deepEqual(moved.delta.idsGained, [`${REPO}:Column:public.things.label`]);
  assertEdgesFollowIds(moved, 'migrations directory renamed');
});

// ---------------------------------------------------------------------------
// ORM schema sources are declarative, so their file names and folders are not inputs.
// ---------------------------------------------------------------------------

const PRISMA_ORG = [
  'datasource db {',
  '  provider = "postgresql"',
  '  url      = env("DATABASE_URL")',
  '}',
  '',
  'model Org {',
  '  id      String   @id',
  '  members Member[]',
  '}',
  '',
].join('\n');
const PRISMA_MEMBER = [
  'model Member {',
  '  id    String @id',
  '  orgId String',
  '  org   Org    @relation(fields: [orgId], references: [id])',
  '}',
  '',
].join('\n');

test('moving or renaming Prisma schema files changes no id, including the file that a relation points at', async () => {
  const folder = {
    'prisma/schema/org.prisma': PRISMA_ORG,
    'prisma/schema/member.prisma': PRISMA_MEMBER,
  };
  const guard = await applyMoves([], folder);
  for (const id of ['Table:public.Org', 'Table:public.Member', 'Column:public.Member.orgId']) {
    assert.ok(guard.before.ids.has(`${REPO}:${id}`), `the fixture declares ${id}`);
  }
  // The referenced file is renamed so that it is read after the file that refers to it.
  for (const [from, to] of [
    ['prisma/schema/org.prisma', 'prisma/schema/zorg.prisma'],
    ['prisma/schema/member.prisma', 'prisma/schema/a-member.prisma'],
    ['prisma/schema', 'prisma/models'],
  ] as const) {
    assert.deepEqual((await applyMoves([[from, to]], folder)).delta, NONE, `${from} -> ${to}`);
  }

  // One schema file moves into the multi-file folder layout.
  const single = { 'prisma/schema.prisma': PRISMA_ORG + PRISMA_MEMBER };
  const into = await applyMoves([['prisma/schema.prisma', 'prisma/schema/schema.prisma']], single);
  assert.ok(into.before.ids.has(`${REPO}:Table:public.Org`));
  assert.deepEqual(into.delta, NONE);
});

const DRIZZLE_ORGS = [
  "import { pgTable, uuid } from 'drizzle-orm/pg-core';",
  "export const orgs = pgTable('orgs', { id: uuid('id').primaryKey() });",
  '',
].join('\n');
const drizzleMembers = (orgsModule: string): string =>
  [
    "import { pgTable, uuid } from 'drizzle-orm/pg-core';",
    `import { orgs } from '${orgsModule}';`,
    "export const members = pgTable('members', {",
    "  id: uuid('id').primaryKey(),",
    "  orgId: uuid('org_id').references(() => orgs.id),",
    '});',
    '',
  ].join('\n');

test('renaming either Drizzle schema file changes no id, including the one that a reference points at', async () => {
  const files = {
    'src/db/orgs.ts': DRIZZLE_ORGS,
    'src/db/members.ts': drizzleMembers('./orgs'),
  };
  const guard = await applyMoves([], files);
  assert.ok(
    guard.before.ids.has(`${REPO}:Table:public.members`),
    'the fixture declares the tables',
  );
  assert.ok(
    [...guard.before.edgeKeys].some((k) => k.startsWith('FK_TO ') && k.includes('members.org_id')),
    'the reference across the two files is extracted',
  );
  // The referenced file is renamed, and the import that names it is edited as a real rename would.
  const referenced = await applyMoves([['src/db/orgs.ts', 'src/db/tenants.ts']], files, {
    'src/db/members.ts': drizzleMembers('./tenants'),
  });
  assert.deepEqual(referenced.delta, NONE);
  // The referring file is renamed and nothing that names it needs editing.
  const referring = await applyMoves([['src/db/members.ts', 'src/db/a-members.ts']], files);
  assert.deepEqual(referring.delta, NONE);
});

// ---------------------------------------------------------------------------
// Edges. The package-entry test pins an edge that reads a path while no id
// changes (ADR-0016 item 4, "Edges"). The Drizzle test pins that an FK_TO
// follows the import binding, so a rename that changes read order moves nothing.
// ---------------------------------------------------------------------------

const BARREL = { 'src/index.ts': "export { User } from './user.ts';\n" };
const MODULE_EXPORTS_USER = `EXPORTS ${APP} -> ${REPO}:Symbol:@fx/app#User`;

test('renaming or moving the package entry file drops the Module EXPORTS edges and changes no id', async () => {
  const guard = await applyMoves([], BARREL);
  assert.ok(
    guard.before.edgeKeys.has(MODULE_EXPORTS_USER),
    'src/index.ts is the package entry, so the Module exports User',
  );
  for (const moves of [
    [['src/index.ts', 'src/main.ts']],
    [['src/index.ts', 'src/lib/index.ts']],
    // The directory rename leaves the entry file at lib/index.ts, which is not a candidate.
    [['src', 'lib']],
  ] as const) {
    const moved = await applyMoves(moves, BARREL);
    const label = moves.map(([from, to]) => `${from} -> ${to}`).join(', ');
    assert.deepEqual(moved.delta.idsLost, [], label);
    assert.deepEqual(moved.delta.idsGained, [], label);
    assert.deepEqual(moved.delta.edgeKeysLost, [MODULE_EXPORTS_USER], label);
    assert.deepEqual(moved.delta.edgeKeysGained, [], label);
  }
  // A move to another name that is still an entry candidate keeps the edge (the import is edited).
  const kept = await applyMoves([['src/index.ts', 'index.ts']], BARREL, {
    'index.ts': "export { User } from './src/user.ts';\n",
  });
  assert.deepEqual(kept.delta, NONE);
});

const drizzleUsers = (table: string): string =>
  [
    "import { pgTable, uuid } from 'drizzle-orm/pg-core';",
    `export const users = pgTable('${table}', { id: uuid('id').primaryKey() });`,
    '',
  ].join('\n');
const DRIZZLE_POSTS = [
  "import { pgTable, uuid } from 'drizzle-orm/pg-core';",
  "import { users } from './schema';",
  "export const posts = pgTable('posts', {",
  "  id: uuid('id').primaryKey(),",
  "  uid: uuid('uid').references(() => users.id),",
  '});',
  '',
].join('\n');

test('two Drizzle modules exporting one name for different tables: the FK_TO target follows the import, with no id change (Drizzle foreign-key binding order)', async () => {
  const files = {
    'src/dba/schema.ts': drizzleUsers('users'),
    'src/dbb/schema.ts': drizzleUsers('legacy_users'),
    'src/dba/posts.ts': DRIZZLE_POSTS,
  };
  const fk = (table: string): string =>
    `FK_TO ${REPO}:Column:public.posts.uid -> ${REPO}:Column:public.${table}.id`;
  const guard = await applyMoves([], files);
  // posts.ts imports `users` from ./schema, which is the dba module.
  assert.ok(guard.before.edgeKeys.has(fk('users')));
  assert.ok(!guard.before.edgeKeys.has(fk('legacy_users')));

  // Renaming the other module so that it is read first does not move the target.
  const moved = await applyMoves([['src/dbb', 'src/0db']], files);
  assert.deepEqual(moved.delta, NONE);

  // If both modules bind the same table, read order does not matter and nothing changes.
  const same = { ...files, 'src/dbb/schema.ts': drizzleUsers('users') };
  assert.deepEqual((await applyMoves([['src/dbb', 'src/0db']], same)).delta, NONE);
});
