/**
 * Table-id alignment and the failure behaviour of the data-model index,
 * through the whole extractor.
 *
 * `data-model.test.ts` covers the binding rules on their own. These tests check
 * what leaves the extractor: the `QUERIES` edge's destination, the `Repo` node's
 * facts, the status of the run, and that the index is an input of the run in the
 * way the design requires (same bytes in, same SIF out).
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { extractCodeTs } from './extract.ts';
import type { ExtractCodeTsOutput } from './extract.ts';
import { canonicalJson, toCanonicalSif } from './serialize.ts';
import { cleanup, materialize } from './__fixtures__/projects.ts';
import type { FileMap } from './__fixtures__/projects.ts';

const PACKAGE_JSON = JSON.stringify({ name: '@fixture/app', version: '1.0.0', type: 'module' });
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

function project(source: string): FileMap {
  return { 'package.json': PACKAGE_JSON, 'tsconfig.json': TSCONFIG, 'src/queries.ts': source };
}

interface Declared {
  readonly schema: string;
  readonly name: string;
}

/** The index document, in the documented format, for repo `fixture`. */
function indexOf(dialect: string, tables: readonly Declared[], defaultSchema = 'public'): string {
  return canonicalJson({
    version: 1,
    dataSources: [{ name: 'default', dialect, defaultSchema }],
    tables: tables.map((t) => ({
      id: `fixture:Table:${t.schema}.${t.name}`,
      dataSource: 'default',
      schema: t.schema,
      name: t.name,
    })),
    prismaDelegates: {},
    drizzleExports: {},
  });
}

const roots: string[] = [];

function run(source: string, label: string, dataModelIndex?: string): ExtractCodeTsOutput {
  const root = materialize(project(source), label);
  roots.push(root);
  return extractCodeTs({
    repoRoot: root,
    repo: 'fixture',
    runId: 'run-1',
    deterministic: true,
    ...(dataModelIndex === undefined ? {} : { dataModelIndex }),
  });
}

after(() => {
  for (const root of roots) cleanup(root);
});

function repoNode(output: ExtractCodeTsOutput): SeamlineNode {
  const found = output.nodes.find((n) => n.kind === 'Repo');
  assert.ok(found !== undefined, 'no Repo node');
  return found;
}

/** `caller -> table` for every QUERIES edge, by the caller's function name. */
function queries(output: ExtractCodeTsOutput): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of output.edges.filter((x: SeamlineEdge) => x.kind === 'QUERIES')) {
    const caller = String(e.src).replace('fixture:Symbol:@fixture/app#', '');
    (out[caller] ??= []).push(String(e.dst).replace('fixture:Table:', ''));
  }
  for (const key of Object.keys(out)) (out[key] as string[]).sort();
  return out;
}

/* --------------------------------------------------------------- the rules */

const STATEMENTS = `
export function quotedMixedCase(): string {
  return 'SELECT id FROM "Invitation" WHERE id = $1';
}
export function unquotedMixedCase(): string {
  return 'SELECT id FROM Invitation WHERE id = $1';
}
export function foldedToLower(): string {
  return 'SELECT id FROM Users WHERE id = $1';
}
export function qualifiedAuth(): string {
  return 'SELECT id FROM auth.users WHERE id = $1';
}
export function qualifiedElsewhere(): string {
  return 'SELECT id FROM app.users WHERE id = $1';
}
export function matchesNothing(): string {
  return 'DELETE FROM widgets WHERE id = $1';
}
`;

test('statements bind to the table they mean, by dialect, quoting and schema', () => {
  const output = run(
    STATEMENTS,
    'bind',
    indexOf('postgres', [
      { schema: 'public', name: 'Invitation' },
      { schema: 'public', name: 'users' },
      { schema: 'auth', name: 'users' },
    ]),
  );
  assert.equal(output.result.status, 'PASS');
  assert.deepEqual(queries(output), {
    // Quoted, so exact: the Prisma model table `"Invitation"`.
    quotedMixedCase: ['public.Invitation'],
    // Unquoted folds to `invitation`, which no table is: the name-only answer, unchanged.
    unquotedMixedCase: ['public.invitation'],
    foldedToLower: ['public.users'],
    qualifiedAuth: ['auth.users'],
    // `app` declares nothing: it must not fall through to `public.users`.
    qualifiedElsewhere: ['app.users'],
    // No table has this name: the edge keeps pointing at an external Table node.
    matchesNothing: ['public.widgets'],
  });
  for (const e of output.edges.filter((x) => x.kind === 'QUERIES')) {
    assert.ok(e.confidence < 1, 'a name-only binding is never asserted at full confidence');
    assert.equal(e.props['binding'], 'unqualified-name');
  }
  assert.equal(repoNode(output).props['ormIndexAbsent'], undefined);
  assert.equal(
    repoNode(output).props['unknownWriterTables'],
    '',
    'nothing here is ambiguous: the list is measured and empty, not missing',
  );
});

test('an unqualified name that auth.users and app.users share gets no edge and is listed', () => {
  const output = run(
    `
export function ambiguousWrite(): string {
  return 'INSERT INTO users (id) VALUES (1)';
}
export function ambiguousRead(): string {
  return 'SELECT id FROM users';
}
export function qualified(): string {
  return 'UPDATE app.users SET id = 2';
}
export function other(): string {
  return 'SELECT id FROM orders';
}
`,
    'ambiguous',
    indexOf('postgres', [
      { schema: 'auth', name: 'users' },
      { schema: 'app', name: 'users' },
      { schema: 'public', name: 'orders' },
    ]),
  );
  assert.equal(output.result.status, 'PASS');
  assert.deepEqual(queries(output), { qualified: ['app.users'], other: ['public.orders'] });
  assert.equal(repoNode(output).props['unknownWriterTables'], 'users');
});

/** The reviewer's `align` fixture: the tables the DDL declares, and a statement for each rule. */
const ALIGN_TABLES: readonly Declared[] = [
  { schema: 'public', name: 'users' },
  { schema: 'auth', name: 'users' },
  { schema: 'app', name: 'accounts' },
  { schema: 'auth', name: 'accounts' },
  { schema: 'only_other', name: 'widgets' },
  { schema: 'public', name: 'Invitation' },
  { schema: 'public', name: 'events' },
];

const ALIGN_SOURCE = `
export function aUnqualifiedDefault(): string { return 'SELECT id FROM users'; }
export function bQualifiedAuth(): string { return 'SELECT id FROM auth.users'; }
export function cAmbiguous(): string { return 'SELECT id FROM accounts'; }
export function dOneNonDefault(): string { return 'INSERT INTO widgets (id, name) VALUES (1, $1)'; }
export function eQuotedMixed(): string { return 'SELECT id FROM "Invitation"'; }
export function fUnquotedMixed(): string { return 'SELECT id FROM Invitation'; }
export function gNoMatch(): string { return 'SELECT id FROM nothing_here'; }
export function hQualifiedMissing(): string { return 'SELECT id FROM app.users'; }
export function iAmbiguousInsert(): string { return 'INSERT INTO accounts (id) VALUES (1)'; }
export function jUpperUnquoted(): string { return 'SELECT id FROM USERS'; }
export function kQualifiedUpperSchema(): string { return 'SELECT id FROM AUTH.USERS'; }
`;

test('a name only one non-default schema declares keeps the name-only edge and joins unknownWriterTables', () => {
  const output = run(ALIGN_SOURCE, 'align', indexOf('postgres', ALIGN_TABLES));
  assert.equal(output.result.status, 'PASS');
  assert.deepEqual(queries(output), {
    aUnqualifiedDefault: ['public.users'],
    bQualifiedAuth: ['auth.users'],
    // `only_other.widgets` is the only `widgets` and `public` has none: the edge is the name-only
    // one, byte for byte what it was before the index, and the real table is not trusted as unwritten.
    dOneNonDefault: ['public.widgets'],
    eQuotedMixed: ['public.Invitation'],
    fUnquotedMixed: ['public.invitation'],
    gNoMatch: ['public.nothing_here'],
    hQualifiedMissing: ['app.users'],
    jUpperUnquoted: ['public.users'],
    kQualifiedUpperSchema: ['auth.users'],
  });
  // The ambiguous `accounts` (cAmbiguous, iAmbiguousInsert) and the one-schema `widgets` are listed
  // by their physical names; nothing else is: `nothing_here` and `app.users` declare no table.
  assert.equal(repoNode(output).props['unknownWriterTables'], 'accounts,widgets');
});

test('the one-schema edge is the edge the same statement gets when no table matches', () => {
  const sql = `export function add(): string { return 'INSERT INTO widgets (id, name) VALUES (1, $1)'; }`;
  const elsewhere = run(
    sql,
    'elsewhere',
    indexOf('postgres', [{ schema: 'only_other', name: 'widgets' }]),
  );
  const nowhere = run(sql, 'nowhere', indexOf('postgres', [{ schema: 'public', name: 'orders' }]));
  assert.deepEqual(
    elsewhere.edges.filter((e) => e.kind === 'QUERIES'),
    nowhere.edges.filter((e) => e.kind === 'QUERIES'),
    'the edge bytes are the name-only edge',
  );
  assert.equal(repoNode(elsewhere).props['unknownWriterTables'], 'widgets');
  assert.equal(repoNode(nowhere).props['unknownWriterTables'], '');
});

test('naming the schema the tables live in as the default binds them', () => {
  const output = run(
    ALIGN_SOURCE.split('\n')
      .filter((l) => l.includes('dOneNonDefault'))
      .join('\n'),
    'default-schema',
    indexOf('postgres', [{ schema: 'only_other', name: 'widgets' }], 'only_other'),
  );
  assert.deepEqual(queries(output), { dOneNonDefault: ['only_other.widgets'] });
  assert.equal(repoNode(output).props['unknownWriterTables'], '');
});

test('the ambiguous tables are listed by their real names, sorted, once', () => {
  const output = run(
    `
export function a(): string { return 'INSERT INTO items (id) VALUES (1)'; }
export function b(): string { return 'UPDATE items SET id = 2'; }
export function c(): string { return 'DELETE FROM files'; }
`,
    'ambiguous-names',
    indexOf('sqlite', [
      { schema: 'public', name: 'Items' },
      { schema: 'public', name: 'items' },
      { schema: 'public', name: 'files' },
    ]),
  );
  assert.deepEqual(queries(output), { c: ['public.files'] });
  assert.equal(repoNode(output).props['unknownWriterTables'], 'Items,items');
});

test('the index changes the edge destination and nothing else about a QUERIES edge', () => {
  const sql = `export function find(): string { return 'SELECT id FROM "Invitation"'; }`;
  const without = run(sql, 'plain-without');
  const withIndex = run(
    sql,
    'plain-with',
    indexOf('postgres', [{ schema: 'public', name: 'Invitation' }]),
  );
  const a = without.edges.find((e) => e.kind === 'QUERIES');
  const b = withIndex.edges.find((e) => e.kind === 'QUERIES');
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(a.dst, 'fixture:Table:public.invitation');
  assert.equal(b.dst, 'fixture:Table:public.Invitation');
  assert.deepEqual(
    { ...a, dst: b.dst },
    b,
    'operation, table, schema, binding, confidence and sourceRef are unchanged',
  );
});

/* ------------------------------------------------------ failure behaviour */

const PRISMA_WRITE = `
import type { PrismaClient } from '@prisma/client';

export async function invite(prisma: PrismaClient): Promise<void> {
  await prisma.invitation.create({ data: { email: 'a@example.com' } });
}
`;

test('without an index the Repo node says so, and a run with neither raw SQL nor an ORM-shaped call stays PASS', () => {
  const output = run(
    `
import type { PrismaClient } from '@prisma/client';

declare const prisma: PrismaClient;

export function listUsers(email: string): unknown {
  // A read through the client is not a write, and no statement here is SQL.
  return prisma.user.findMany({ where: { email } });
}
`,
    'absent-plain',
  );
  assert.equal(output.result.status, 'PASS');
  assert.equal(repoNode(output).props['ormIndexAbsent'], true);
  assert.deepEqual(queries(output), {}, 'no statement was read');
});

test('without an index, a raw-SQL table reference makes the run UNAVAILABLE, with its output still emitted', () => {
  const output = run(
    `
export function other(): number { return 1; }
export function find(): string {
  return 'SELECT id FROM users';
}
export function later(): string {
  return 'SELECT id FROM "Invitation"';
}
`,
    'absent-sql',
  );
  assert.equal(output.result.status, 'UNAVAILABLE');
  assert.ok(output.nodes.length > 0 && output.result.nodeCount === output.nodes.length);
  assert.deepEqual(
    queries(output),
    { find: ['public.users'], later: ['public.invitation'] },
    'the name-only edges are still returned; the status is what keeps them from sweeping the bound ones',
  );
  const first = output.result.diagnostics[0] ?? '';
  assert.ok(first.includes('raw-SQL table reference at src/queries.ts:4'), first);
  assert.ok(first.includes('UNAVAILABLE'), first);
  assert.equal(repoNode(output).props['ormIndexAbsent'], true);
  assert.equal(
    output.result.authoritative.length,
    1,
    'the scope is still declared, as for any UNAVAILABLE run that read files',
  );
});

test('the raw-SQL reference named is the first by file and line, whatever order the files are walked in', () => {
  const root = materialize(
    {
      'package.json': PACKAGE_JSON,
      'tsconfig.json': TSCONFIG,
      'src/zeta.ts': `export function z(): string {\n  return 'SELECT id FROM users';\n}\n`,
      'src/alpha.ts': `export const pad = 1;\nexport function a(): string {\n  return 'DELETE FROM sessions';\n}\nexport function b(): string {\n  return 'SELECT id FROM users';\n}\n`,
    },
    'absent-first',
  );
  roots.push(root);
  const output = extractCodeTs({
    repoRoot: root,
    repo: 'fixture',
    runId: 'run-1',
    deterministic: true,
  });
  assert.equal(output.result.status, 'UNAVAILABLE');
  assert.ok(
    (output.result.diagnostics[0] ?? '').includes('src/alpha.ts:3'),
    output.result.diagnostics[0] ?? '',
  );
});

test('a template literal and a statement outside any function count as raw-SQL references', () => {
  const template = run(
    'export function find(): string {\n  return `SELECT id FROM users WHERE id = $1`;\n}\n',
    'absent-template',
  );
  assert.equal(template.result.status, 'UNAVAILABLE');
  assert.ok((template.result.diagnostics[0] ?? '').includes('src/queries.ts:2'));

  // No enclosing symbol, so no edge in either case. The rule is lexical, like the ORM-shaped one,
  // and does not depend on how a declaration resolved: this is UNAVAILABLE too.
  const loose = run(
    "'use strict';\ndeclare function query(sql: string): void;\nquery('SELECT id FROM users');\n",
    'absent-loose',
  );
  assert.equal(loose.result.status, 'UNAVAILABLE');
  assert.deepEqual(queries(loose), {});
});

test('a string that merely mentions a table is not a raw-SQL reference', () => {
  const output = run(
    "export const a = 'we select the users from the list';\nexport const b = 'from users to admins';\nexport const c = 'SELECT 1';\n",
    'absent-notsql',
  );
  assert.equal(output.result.status, 'PASS');
});

/** What `buildDataModelIndex` returns for a repository with no schema source: no tables, no data source. */
const EMPTY_INDEX = canonicalJson({
  version: 1,
  dataSources: [],
  tables: [],
  prismaDelegates: {},
  drizzleExports: {},
});

const UI_PROSE = `
export const label = 'Select files from your computer';
`;

test('UI prose that the SQL classifier reads is a raw-SQL reference: UNAVAILABLE without an index, PASS with an empty one', () => {
  // `looksLikeSql` accepts it (sql.test.ts pins that), so without an index the run is UNAVAILABLE
  // although nothing in the repository is SQL. That is the safe side of a loose classifier.
  const absent = run(UI_PROSE, 'prose-absent');
  assert.equal(absent.result.status, 'UNAVAILABLE');
  assert.ok(
    (absent.result.diagnostics[0] ?? '').includes('raw-SQL table reference at src/queries.ts:2'),
  );

  // An index with no tables is an index: this repository declares none, so nothing a name could
  // bind to is missing and the name keeps the answer `defaultTableId` gives.
  const empty = run(UI_PROSE, 'prose-empty', EMPTY_INDEX);
  assert.equal(empty.result.status, 'PASS');
  assert.equal(repoNode(empty).props['ormIndexAbsent'], undefined, 'the index was not absent');
  assert.equal(
    canonicalJson(empty.edges),
    canonicalJson(absent.edges),
    'the edges are the same bytes with the empty index and with no index',
  );
});

test('with an empty index every name keeps the name-only edge and the run is PASS', () => {
  const source = `
export function find(): string { return 'SELECT id FROM users'; }
export function quoted(): string { return 'SELECT id FROM "Invitation"'; }
export function qualified(): string { return 'DELETE FROM auth.sessions WHERE id = $1'; }
`;
  const empty = run(source, 'empty-index', EMPTY_INDEX);
  assert.equal(empty.result.status, 'PASS');
  assert.deepEqual(queries(empty), {
    find: ['public.users'],
    qualified: ['auth.sessions'],
    quoted: ['public.invitation'],
  });
  assert.equal(
    repoNode(empty).props['unknownWriterTables'],
    '',
    'nothing is ambiguous when nothing is declared: measured, and empty',
  );
  // These are the edges an index-less run builds (and reports UNAVAILABLE for).
  assert.equal(canonicalJson(empty.edges), canonicalJson(run(source, 'empty-index-absent').edges));
});

test('with an empty index an ORM-shaped write is not UNAVAILABLE: no table is declared for it to bind to', () => {
  const output = run(PRISMA_WRITE, 'empty-orm', EMPTY_INDEX);
  assert.equal(output.result.status, 'PASS');
  assert.deepEqual(queries(output), {}, 'there is no ORM edge before F1');
});

test('with an index, the same raw SQL is a PASS and binds', () => {
  const output = run(
    `export function find(): string { return 'SELECT id FROM users'; }`,
    'present-sql',
    indexOf('postgres', [{ schema: 'public', name: 'users' }]),
  );
  assert.equal(output.result.status, 'PASS');
  assert.deepEqual(queries(output), { find: ['public.users'] });
  assert.equal(repoNode(output).props['ormIndexAbsent'], undefined);
});

test('a malformed index with raw SQL is refused, reported, and UNAVAILABLE', () => {
  const output = run(
    `export function find(): string { return 'SELECT id FROM users'; }`,
    'bad-sql',
    '{"version":1',
  );
  assert.equal(output.result.status, 'UNAVAILABLE');
  assert.ok(
    output.result.diagnostics.some((d) => d.startsWith('data-model index refused (not JSON')),
  );
  assert.ok(output.result.diagnostics.some((d) => d.includes('raw-SQL table reference')));
});

test('without an index, an ORM-shaped write makes the run UNAVAILABLE, with its output still emitted', () => {
  const output = run(PRISMA_WRITE, 'absent-orm');
  assert.equal(output.result.status, 'UNAVAILABLE');
  assert.ok(
    output.nodes.length > 0 && output.result.nodeCount === output.nodes.length,
    'the facts are still returned',
  );
  assert.ok(output.nodes.some((n) => n.kind === 'Symbol' && n.name === 'invite'));
  const first = output.result.diagnostics[0] ?? '';
  assert.ok(first.includes('src/queries.ts:5'), `the first diagnostic names the call: ${first}`);
  assert.ok(first.includes('UNAVAILABLE'));
  assert.equal(repoNode(output).props['ormIndexAbsent'], true);
});

test('with an index the same ORM-shaped write is not UNAVAILABLE', () => {
  const output = run(
    PRISMA_WRITE,
    'present-orm',
    indexOf('postgres', [{ schema: 'public', name: 'Invitation' }]),
  );
  assert.equal(output.result.status, 'PASS');
  assert.equal(repoNode(output).props['ormIndexAbsent'], undefined);
});

test('a Drizzle insert chained into values counts as an ORM-shaped write', () => {
  const output = run(
    `
import { pgTable, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', { id: text('id') });
declare const db: { insert(t: unknown): { values(v: unknown): Promise<void> } };
export async function add(): Promise<void> {
  await db.insert(users).values({ id: 'a' });
}
`,
    'absent-drizzle',
  );
  assert.equal(output.result.status, 'UNAVAILABLE');
  assert.ok((output.result.diagnostics[0] ?? '').includes('src/queries.ts:6'));
});

test('calls that only look like writes do not make a run UNAVAILABLE', () => {
  // The repository uses an ORM package, so the gate is open; none of these is a client write.
  const output = run(
    `
import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

declare const prisma: PrismaClient;
void prisma;

export class Cache {
  private readonly entries = new Map<string, string>();
  private readonly seen = new Set<string>();
  evict(key: string): void {
    this.entries.delete(key);
    this.seen.delete(key);
  }
  digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
export function params(search: URLSearchParams): void {
  search.delete('q');
}
`,
    'absent-lookalikes',
  );
  assert.equal(output.result.status, 'PASS');
  assert.equal(repoNode(output).props['ormIndexAbsent'], true);
});

test('a repository with no ORM package is not made UNAVAILABLE by a shape that resembles a write', () => {
  const output = run(
    `
export class Registry {
  private readonly byId = new Map<string, { n: number }>();
  forget(id: string): void {
    this.byId.delete(id);
  }
  rebuild(): void {
    Object.create({ create: () => 0 }).create({ data: 1 });
  }
}
export const local = { store: { create(_v: { data: number }): void {} } };
local.store.create({ data: 1 });
`,
    'absent-no-orm',
  );
  assert.equal(output.result.status, 'PASS');
});

test('a malformed index is refused, reported, and treated as absent', () => {
  const output = run(PRISMA_WRITE, 'malformed', '{"version":1');
  assert.equal(output.result.status, 'UNAVAILABLE');
  assert.ok(
    output.result.diagnostics.some((d) => d.startsWith('data-model index refused (not JSON')),
  );
  assert.equal(repoNode(output).props['ormIndexAbsent'], true);

  const wrongRepo = run(
    PRISMA_WRITE,
    'wrong-repo',
    indexOf('postgres', [{ schema: 'public', name: 'Invitation' }]).replaceAll(
      'fixture:',
      'elsewhere:',
    ),
  );
  assert.equal(wrongRepo.result.status, 'UNAVAILABLE');
  assert.ok(wrongRepo.result.diagnostics.some((d) => d.includes('another repository')));
});

/* ------------------------------------------------------------- determinism */

test('the same index bytes and the same tree give the same SIF bytes, wherever the tree lives', () => {
  const text = indexOf('postgres', [
    { schema: 'public', name: 'Invitation' },
    { schema: 'public', name: 'users' },
    { schema: 'auth', name: 'users' },
  ]);
  const first = run(STATEMENTS, 'det-1', text);
  const second = run(STATEMENTS, 'det-2', text);
  assert.equal(toCanonicalSif(first), toCanonicalSif(second));
  assert.ok(
    toCanonicalSif(first).includes('fixture:Table:public.Invitation'),
    'the index was used, not ignored',
  );
});

test('the order the index lists its tables in does not change the output', () => {
  const tables: Declared[] = [
    { schema: 'auth', name: 'users' },
    { schema: 'app', name: 'users' },
    { schema: 'public', name: 'Invitation' },
  ];
  const source = `
export function ambiguous(): string { return 'INSERT INTO users (id) VALUES (1)'; }
export function exact(): string { return 'SELECT id FROM "Invitation"'; }
`;
  const forward = run(source, 'order-1', indexOf('postgres', tables));
  const backward = run(source, 'order-2', indexOf('postgres', [...tables].reverse()));
  assert.equal(toCanonicalSif(forward), toCanonicalSif(backward));
});

test('a different index is a different input: the SIF follows it', () => {
  const source = `export function find(): string { return 'SELECT id FROM "Invitation"'; }`;
  const withTable = run(
    source,
    'input-1',
    indexOf('postgres', [{ schema: 'public', name: 'Invitation' }]),
  );
  const withoutTable = run(
    source,
    'input-2',
    indexOf('postgres', [{ schema: 'public', name: 'other' }]),
  );
  assert.notEqual(toCanonicalSif(withTable), toCanonicalSif(withoutTable));
});
