/**
 * The facts on the `Repo` node that say what the extractor could not see
 * (`docs/design/real-world-inputs.md`, section 5.2): `untracedWriteCalls`,
 * `writeHooks` and `unknownWriterTables`.
 *
 * Every case asserts the number or the list that leaves the extractor, on a project
 * written for the case. A pair per rule: the shape that is counted and the variant that
 * is not. The clean cases of section 7 are one table at the end.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SeamlineNode } from '@seamline/ontology';
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

interface Declared {
  readonly schema?: string;
  readonly name: string;
}

interface IndexSpec {
  readonly tables: readonly Declared[];
  /** Prisma delegate to the physical table it is bound to. */
  readonly delegates?: Readonly<Record<string, { readonly model: string; readonly table: string }>>;
  /** Drizzle export to the physical table. */
  readonly exports?: Readonly<Record<string, string>>;
}

function indexOf(spec: IndexSpec): string {
  const id = (name: string): string => {
    const t = spec.tables.find((x) => x.name === name);
    return `fixture:Table:${t?.schema ?? 'public'}.${name}`;
  };
  return canonicalJson({
    version: 1,
    dataSources: [{ name: 'default', dialect: 'postgres', defaultSchema: 'public' }],
    tables: spec.tables.map((t) => ({
      id: `fixture:Table:${t.schema ?? 'public'}.${t.name}`,
      dataSource: 'default',
      schema: t.schema ?? 'public',
      name: t.name,
    })),
    prismaDelegates: Object.fromEntries(
      Object.entries(spec.delegates ?? {}).map(([k, v]) => [
        k,
        { model: v.model, table: id(v.table) },
      ]),
    ),
    drizzleExports: Object.fromEntries(
      Object.entries(spec.exports ?? {}).map(([k, v]) => [k, id(v)]),
    ),
  });
}

const roots: string[] = [];

function project(files: FileMap): FileMap {
  return { 'package.json': PACKAGE_JSON, 'tsconfig.json': TSCONFIG, ...files };
}

function run(files: FileMap, label: string, index?: string): ExtractCodeTsOutput {
  const root = materialize(project(files), label);
  roots.push(root);
  return extractCodeTs({
    repoRoot: root,
    repo: 'fixture',
    runId: 'run-1',
    deterministic: true,
    ...(index === undefined ? {} : { dataModelIndex: index }),
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

/** The count a single source file gives, with an index that declares `tables` and nothing else. */
function countOf(source: string, label: string, spec: IndexSpec = { tables: [] }): number {
  const output = run({ 'src/q.ts': source }, label, indexOf(spec));
  assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
  const n = repoNode(output).props['untracedWriteCalls'];
  assert.equal(typeof n, 'number');
  return n as number;
}

function queriesOf(output: ExtractCodeTsOutput): string[] {
  return output.edges
    .filter((e) => e.kind === 'QUERIES')
    .map((e) => String(e.dst).replace('fixture:Table:', ''))
    .sort();
}

/* ------------------------------------------------------------ always present */

test('the Repo node carries the counts on every run, zero included, and the list as measured', () => {
  const output = run({ 'src/q.ts': 'export const x = 1;\n' }, 'empty', indexOf({ tables: [] }));
  assert.equal(output.result.status, 'PASS');
  const props = repoNode(output).props;
  assert.equal(props['untracedWriteCalls'], 0);
  assert.equal(props['writeHooks'], 0);
  assert.equal(props['runtimeDdl'], 0);
  assert.equal(props['unknownWriterTables'], '', 'measured, and nothing to list');
  assert.equal(props['ormIndexAbsent'], undefined);
});

test('without an index the counts are still measured and the list is not offered', () => {
  const output = run({ 'src/q.ts': 'export const x = 1;\n' }, 'no-index');
  assert.equal(output.result.status, 'PASS');
  const props = repoNode(output).props;
  assert.equal(props['untracedWriteCalls'], 0);
  assert.equal(props['writeHooks'], 0);
  assert.equal(props['runtimeDdl'], 0);
  assert.equal(props['ormIndexAbsent'], true);
  assert.equal(
    'unknownWriterTables' in props,
    false,
    'there are no names to look for: not measured, not empty',
  );
});

test('a run that did not extract emits no Repo node, so no prop can be read as zero', () => {
  const root = materialize({ 'src/q.ts': 'export const x = 1;\n' }, 'no-tsconfig');
  roots.push(root);
  const output = extractCodeTs({
    repoRoot: root,
    repo: 'fixture',
    runId: 'run-1',
    deterministic: true,
  });
  assert.equal(output.result.status, 'UNAVAILABLE');
  assert.deepEqual(output.nodes, []);
});

/* ------------------------------------------------------------ rule (1) */

test('runtime DDL measures module-level literal sites, every statement and partial schema verbs', () => {
  const statements = [
    'CREATE TABLE accounts (id int)',
    'ALTER TABLE accounts ALTER COLUMN id SET DEFAULT 1',
    'SELECT 1; DROP TABLE accounts',
    'BEGIN; RENAME TABLE accounts TO archived_accounts',
    "COMMENT ON TABLE accounts IS 'note'",
    'DO $$ BEGIN END $$',
    'EXEC proc()',
    'EXECUTE query',
    'CREATE ',
  ];
  const source = `export const setup = ${JSON.stringify(statements)};`;
  const output = run({ 'src/setup.ts': source }, 'runtime-ddl', indexOf({ tables: [] }));
  assert.equal(output.result.status, 'PASS');
  assert.equal(repoNode(output).props['runtimeDdl'], statements.length);
  const clean = run({ 'src/setup.ts': `export const labels = ${JSON.stringify([
    "SELECT 'CREATE TABLE accounts', $$ALTER TABLE accounts$$; -- DROP TABLE accounts",
    '/* CREATE TABLE accounts */ SELECT 1',
    'SELECT "DROP" FROM accounts',
  ])};` }, 'runtime-ddl-clean', indexOf({ tables: [] }));
  assert.equal(repoNode(clean).props['runtimeDdl'], 0);
});

test('runtime DDL joins outermost string concatenations once, including module expressions', () => {
  const source = `
declare const db: { query(s: string): void };
declare const prefix: string;
db.query("CR" + "EATE TABLE accounts (id int)");
const setup = (("AL" + "TER TABLE accounts ADD label text") as string);
void (\`DR\` + \`OP TABLE accounts\`);
const whole = "CREATE TABLE other (id int)" + "; SELECT 1";
const label = "CRE" + "ATIVE";
void ("AL" + "TERNATIVE");
const read = "SELECT 'CR" + "EATE TABLE accounts' /* DROP TABLE other */";
const unknown = prefix + "CREATE TABLE potential (id int)";
`;
  const first = run({ 'src/setup.ts': source }, 'runtime-ddl-joined-a', indexOf({ tables: [] }));
  const second = run({ 'src/setup.ts': source }, 'runtime-ddl-joined-b', indexOf({ tables: [] }));
  assert.equal(first.result.status, 'PASS');
  assert.equal(second.result.status, 'PASS');
  assert.equal(repoNode(first).props['runtimeDdl'], 5);
  assert.equal(repoNode(second).props['runtimeDdl'], 5);
});

test('runtime DDL reconstructs nested constant templates, assertions and known segments beside unknowns', () => {
  const expressions = [
    '`CR${"EATE TABLE accounts (id int)"}`',
    '`C${`R${"EATE TABLE accounts (id int)"}`}`',
    '(<string>"CR") + "EATE TABLE accounts (id int)"',
    'prefix + "CR" + "EATE TABLE accounts (id int)"',
    '`' + '${prefix}CR${"EATE TABLE accounts (id int)"}' + '`',
    '(`' + '${("CR" as const)}${(<string>"EATE TABLE accounts (id int)")}' + '` satisfies string)!',
    '"CR" + suffix + "EATE TABLE accounts (id int); DROP TABLE accounts"',
  ];
  const source = 'declare const prefix: string; declare const suffix: string;\n'
    + expressions.map((e, i) => `const statement${i} = ${e};`).join('\n');
  for (const pass of ['cold', 'warm']) {
    const out = run({ 'src/setup.ts': source }, `runtime-ddl-composed-${pass}`, indexOf({ tables: [] }));
    assert.equal(out.result.status, 'PASS');
    assert.equal(repoNode(out).props['runtimeDdl'], expressions.length);
  }
  const clean = run({ 'src/setup.ts': [
    'const quoted = `SELECT \'${"CR" + "EATE TABLE accounts"}\'`;',
    'const comment = `SELECT 1 /* ${`DR${"OP TABLE accounts"}`} */`;',
    'const ordinary = `CRE${"ATIVE"}`;',
    'const asserted = (<string>"AL") + "TERNATIVE";',
  ].join('\n') }, 'runtime-ddl-composed-controls', indexOf({ tables: [] }));
  assert.equal(repoNode(clean).props['runtimeDdl'], 0);
});

test('rule (1): a statement run from a value the extractor cannot read is counted', () => {
  assert.equal(
    countOf(
      `
declare const prisma: { $executeRawUnsafe(q: string, ...p: unknown[]): unknown };
export function a(query: string): unknown { return prisma.$executeRawUnsafe(query, 1); }
`,
      'r1-name',
    ),
    1,
  );
  assert.equal(
    countOf(
      `
declare const db: { $queryRawUnsafe(q: string): unknown };
declare function build(): string;
export function a(): unknown { return db.$queryRawUnsafe(build()); }
`,
      'r1-call',
    ),
    1,
  );
  assert.equal(
    countOf(
      `
declare const sql: { unsafe(q: string): unknown; raw(q: string): unknown };
export function a(query: string): unknown { return sql.unsafe(query); }
export function b(name: string): unknown { return sql.raw(name); }
`,
      'r1-unsafe-raw',
    ),
    2,
  );
});

test('rule (1): a literal, a read, a session command and a statement the classifier attributes are not counted', () => {
  assert.equal(
    countOf(
      `
declare const prisma: { $executeRawUnsafe(q: string, ...p: unknown[]): unknown; $queryRawUnsafe(q: string): unknown };
declare const sql: { unsafe(q: string): unknown; raw(q: string): unknown };
export function literal(): unknown { return prisma.$executeRawUnsafe('INSERT INTO t (a) VALUES (1)'); }
export function readTemplate(table: string): unknown { return prisma.$queryRawUnsafe(\`SELECT * FROM "\${table}" WHERE id = 1\`); }
export function readConcat(table: string): unknown { return prisma.$queryRawUnsafe('SELECT * FROM ' + table); }
export function traced(x: number): unknown { return prisma.$executeRawUnsafe(\`INSERT INTO users (a) VALUES (\${x})\`); }
export function tracedConcat(x: number): unknown { return prisma.$executeRawUnsafe('UPDATE users SET a = ' + x); }
export function searchPath(schema: string): unknown { return prisma.$executeRawUnsafe(\`SET search_path TO "\${schema}";\`); }
export function unsafeLiteral(): unknown { return sql.unsafe('SELECT 1'); }
export function rawLiteral(): unknown { return sql.raw('now()'); }
export function otherReceiver(x: { raw(q: string): unknown }, name: string): unknown { return x.raw(name); }
`,
      'r1-clean',
    ),
    0,
  );
});

test('rule (1): a call with a spliced table is one place, not two', () => {
  const output = run(
    {
      'src/q.ts': `
declare const prisma: { $executeRawUnsafe(q: string): unknown };
export function a(t: string): unknown {
  return prisma.$executeRawUnsafe(\`INSERT INTO \${t} (a) VALUES (1)\`);
}
`,
    },
    'r1-once',
    indexOf({ tables: [] }),
  );
  assert.equal(repoNode(output).props['untracedWriteCalls'], 1);
  assert.ok(
    output.result.diagnostics.includes('untraced write at src/q.ts:4 (unsafe-raw-call, insert)'),
    output.result.diagnostics.join('\n'),
  );
});

test('rule (1): a read or session prefix cannot hide a dynamic later statement', () => {
  const prelude = 'declare const sql: { unsafe(q: string): { simple(): unknown } };\n';
  for (const prefix of ['SELECT id FROM users;', 'BEGIN;', "SELECT ';' FROM users;"]) {
    assert.equal(
      countOf(
        `${prelude}export function f(statement: string): unknown { return sql.unsafe(\`${prefix} \${statement}\`).simple(); }`,
        'unsafe-script',
      ),
      1,
      prefix,
    );
  }
  for (const script of [
    'SELECT id FROM users; SELECT \${value}',
    'BEGIN; SET search_path TO "\${value}"; COMMIT;',
    "SELECT ';' FROM users WHERE id = \${value}",
  ]) {
    assert.equal(
      countOf(
        `${prelude}export function f(value: string): unknown { return sql.unsafe(\`${script}\`).simple(); }`,
        'unsafe-read-session-script',
      ),
      0,
      script,
    );
  }
});

/* ------------------------------------------------------------ rule (2) */

/** Each shape of design table 4.2: the statement that is attributed, and the one that is not. */
const SHAPES: ReadonlyArray<{
  readonly shape: string;
  readonly attributed: string;
  readonly unattributed: string;
}> = [
  {
    shape: 'INSERT',
    attributed: 'INSERT INTO t (a, b) VALUES (1, 2)',
    unattributed: 'INSERT INTO ${t} (a, b) VALUES (1, 2)',
  },
  {
    shape: 'INSERT IGNORE',
    attributed: 'INSERT IGNORE INTO t (a) VALUES (1)',
    unattributed: 'INSERT IGNORE INTO ${t} (a) VALUES (1)',
  },
  {
    shape: 'INSERT OR REPLACE',
    attributed: 'INSERT OR REPLACE INTO t (a) VALUES (1)',
    unattributed: 'INSERT OR REPLACE INTO ${t} (a) VALUES (1)',
  },
  {
    shape: 'REPLACE',
    attributed: 'REPLACE INTO t (a) VALUES (1)',
    unattributed: 'REPLACE INTO ${t} (a) VALUES (1)',
  },
  {
    shape: 'upsert',
    attributed: 'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2',
    unattributed: 'INSERT INTO ${t} (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2',
  },
  {
    shape: 'MERGE',
    attributed: 'MERGE INTO t USING s ON t.a = s.a WHEN MATCHED THEN UPDATE SET b = 1',
    unattributed: 'MERGE INTO ${t} USING s ON t.a = s.a WHEN MATCHED THEN UPDATE SET b = 1',
  },
  { shape: 'COPY', attributed: 'COPY t (a) FROM STDIN', unattributed: 'COPY ${t} (a) FROM STDIN' },
  {
    shape: 'UPDATE',
    attributed: 'UPDATE t SET a = 1 WHERE b = 2',
    unattributed: 'UPDATE ${t} SET a = 1 WHERE b = 2',
  },
  {
    shape: 'DELETE',
    attributed: 'DELETE FROM t WHERE a = 1',
    unattributed: 'DELETE FROM ${t} WHERE a = 1',
  },
  { shape: 'TRUNCATE', attributed: 'TRUNCATE TABLE t', unattributed: 'TRUNCATE TABLE ${t}' },
  {
    shape: 'comment-led',
    attributed: '-- note\nINSERT INTO t (a) VALUES (1)',
    unattributed: '-- note\nINSERT INTO ${t} (a) VALUES (1)',
  },
];

for (const { shape, attributed, unattributed } of SHAPES) {
  test(`rule (2), ${shape}: the attributed statement has its edge and counts nothing; a spliced table is counted and has none`, () => {
    for (const tagged of [false, true]) {
      const wrap = (text: string): string => (tagged ? `sql\`${text}\`` : `\`${text}\``);
      const decl = 'declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown;\n';
      const good = run(
        {
          'src/q.ts': `${decl}export function f(): unknown { return ${wrap(attributed.replace('${t}', 't'))}; }\n`,
        },
        `r2-${shape}-${tagged}-good`,
        indexOf({ tables: [{ name: 't' }] }),
      );
      assert.deepEqual(queriesOf(good).includes('public.t'), true, `${shape}: edge to t`);
      assert.equal(
        repoNode(good).props['untracedWriteCalls'],
        0,
        `${shape}: attributed counts nothing`,
      );

      const bad = run(
        {
          'src/q.ts': `${decl}export function f(t: string): unknown { return ${wrap(unattributed)}; }\n`,
        },
        `r2-${shape}-${tagged}-bad`,
        indexOf({ tables: [{ name: 't' }] }),
      );
      assert.equal(
        repoNode(bad).props['untracedWriteCalls'],
        1,
        `${shape}: a spliced table is counted`,
      );
      assert.equal(queriesOf(bad).includes('public.t'), false, `${shape}: and no edge`);
    }
  });
}

test('rule (2): CALL and EXEC run a procedure whose tables are unknown', () => {
  const calls = [
    'CALL archive_old(1)',
    'EXEC archive_old @days = 1',
    'EXECUTE archive_old(1)',
    'CALL ${proc}(1)',
  ];
  for (const [i, text] of calls.entries()) {
    assert.equal(
      countOf(`export function f(proc: string): string { return \`${text}\`; }\n`, `r2-proc-${i}`),
      1,
      text,
    );
  }
  assert.equal(
    countOf(`export function f(): string { return 'CALL archive_old(1)'; }\n`, 'r2-proc-literal'),
    1,
  );
});

test('rule (2): a literal with two spliced statements is one place', () => {
  assert.equal(
    countOf(
      'export function f(a: string, b: string): string { return `INSERT INTO ${a} (x) VALUES (1); DELETE FROM ${b}`; }\n',
      'r2-two',
    ),
    1,
  );
});

/* ------------------------------------------------------------ rule (2b) */

test('rule (2b): a write phrase that a concatenation completes is counted; prose and a bare UPDATE are not', () => {
  assert.equal(
    countOf(
      `export function f(table: string): string { return "INSERT INTO " + table + " (a) VALUES (?)"; }\n`,
      'r2b-insert',
    ),
    1,
  );
  assert.equal(
    countOf(
      `export function f(table: string): string { return 'DELETE FROM ' + table; }\n`,
      'r2b-delete',
    ),
    1,
  );
  assert.equal(
    countOf(
      `export function f(table: string): string { return 'TRUNCATE TABLE ' + table; }\n`,
      'r2b-truncate',
    ),
    1,
  );
  assert.equal(
    countOf(
      `export function f(table: string): string { return 'INSERT OR REPLACE INTO ' + table + ' (a) VALUES (1)'; }\n`,
      'r2b-or',
    ),
    1,
  );
  // The documented gap: a bare UPDATE operand is prose in `"Update " + name`.
  assert.equal(
    countOf(
      `export function f(table: string): string { return "UPDATE " + table + " SET a = ?"; }\n`,
      'r2b-update',
    ),
    0,
  );
  assert.equal(
    countOf(`export function f(name: string): string { return "Update " + name; }\n`, 'r2b-prose'),
    0,
  );
  // Not an operand of `+`: the phrase alone is just text.
  assert.equal(countOf(`export const f = 'INSERT INTO ';\n`, 'r2b-alone'), 0);
});

/* ------------------------------------------------------------ rule (3) */

const RAW_DECLS = `
declare const Prisma: { raw(s: string): unknown; sql(s: TemplateStringsArray, ...v: unknown[]): unknown };
declare const prisma: { $queryRaw(s: TemplateStringsArray, ...v: unknown[]): unknown; $executeRaw(s: TemplateStringsArray, ...v: unknown[]): unknown };
declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown;
declare const html: (s: TemplateStringsArray, ...v: unknown[]) => unknown;
`;

test('rule (3): a Prisma fragment spliced into the verb or table position is counted', () => {
  const counted = [
    // The verb.
    'prisma.$queryRaw`${Prisma.raw(verb)} FROM t WHERE a = ${a}`',
    'prisma.$executeRaw`${Prisma.sql`DELETE`} FROM t`',
    // The table of a statement that is not a read.
    'sql`WITH x AS (SELECT 1) INSERT INTO ${Prisma.raw(table)} SELECT * FROM x`',
  ];
  for (const [i, expr] of counted.entries()) {
    assert.equal(
      countOf(
        `${RAW_DECLS}export function f(verb: string, table: string, a: number): unknown { return ${expr}; }\n`,
        `r3-${i}`,
      ),
      1,
      expr,
    );
  }
});

test('rule (3): a fragment in a value position, a read, an untagged template and another tag are not', () => {
  const clean = [
    'sql`SELECT * FROM ${Prisma.raw(table)}`',
    'prisma.$queryRaw`SELECT a FROM t WHERE x ${Prisma.sql`AND y = 1`}`',
    'prisma.$queryRaw`${verb} FROM t`',
    'html`${Prisma.raw(verb)} FROM t`',
    'prisma.$queryRaw`SELECT a FROM t WHERE b = ${a}`',
  ];
  for (const [i, expr] of clean.entries()) {
    assert.equal(
      countOf(
        `${RAW_DECLS}export function f(verb: string, table: string, a: number): unknown { return ${expr}; }\n`,
        `r3-clean-${i}`,
      ),
      0,
      expr,
    );
  }
});

test('rule (3): tagged batches count a fragment in a later verb position after a read or session', () => {
  for (const prefix of ['SELECT 1;', 'BEGIN;']) {
    assert.equal(countOf(
      RAW_DECLS + `export function f(verb: string): unknown { return sql\`${prefix} \${Prisma.raw(verb)} FROM t\`; }`,
      'r3-batch-fragment',
    ), 1, prefix);
  }
  for (const statement of [
    'SELECT 1; SELECT * FROM \${Prisma.raw(verb)}',
    'BEGIN; SET search_path TO "\${Prisma.raw(verb)}"; COMMIT;',
  ]) {
    assert.equal(countOf(
      RAW_DECLS + `export function f(verb: string): unknown { return sql\`${statement}\`; }`,
      'r3-batch-read-session',
    ), 0, statement);
  }
});

/* ------------------------------------------------------------ rule (4) */

test('rule (4): a computed delegate with a write operation is counted', () => {
  assert.equal(
    countOf(
      `
declare const prisma: Record<string, { create(a: unknown): unknown; deleteMany(): unknown }>;
export function a(model: string): unknown { return prisma[model].create({ data: {} }); }
export function b(model: string): unknown { return prisma[model.toLowerCase()].deleteMany(); }
`,
      'r4-computed',
    ),
    2,
  );
});

test('rule (4): a delegate that is written out, an index, and a read are not counted', () => {
  assert.equal(
    countOf(
      `
declare const prisma: Record<string, { create(a: unknown): unknown; findMany(): unknown }>;
declare const rows: Array<{ create(): unknown }>;
export function a(model: string): unknown { return prisma[model].findMany(); }
export function b(): unknown { return prisma['widget'].create({ data: {} }); }
export function c(): unknown { return rows[0].create(); }
`,
      'r4-clean',
    ),
    0,
  );
});

/* ------------------------------------------------------------ rule (5) */

const DRIZZLE_DECLS = `
import { sql } from 'drizzle-orm';
declare const db: { insert(t: unknown): unknown; update(t: unknown): unknown; delete(t: unknown): unknown };
declare const users: unknown;
declare const schema: { users: unknown; other: unknown };
declare const param: unknown;
void sql;
`;

test('rule (5): insert, update and delete in a file that imports a query builder are counted, unless they name a table export', () => {
  const index = { tables: [{ name: 'users' }], exports: { users: 'users' } };
  const counted = [
    'db.insert(param)',
    'db.update(schema.other)',
    'db.delete(null)',
    'db.insert({ a: 1 })',
  ];
  for (const [i, expr] of counted.entries()) {
    assert.equal(
      countOf(
        `${DRIZZLE_DECLS}export function f(): unknown { return ${expr}; }\n`,
        `r5-${i}`,
        index,
      ),
      1,
      expr,
    );
  }
  for (const [i, expr] of [
    'db.insert(users)',
    'db.update(users)',
    'db.delete(schema.users)',
  ].entries()) {
    assert.equal(
      countOf(
        `${DRIZZLE_DECLS}export function f(): unknown { return ${expr}; }\n`,
        `r5-export-${i}`,
        index,
      ),
      0,
      expr,
    );
  }
});

test('rule (5): the same call in a file that imports none of the listed modules is ordinary code', () => {
  const body = `
declare const db: { insert(t: unknown): unknown; update(t: unknown): unknown; delete(t: unknown): unknown };
declare const param: unknown;
export function f(): unknown { return [db.insert(param), db.update(param), db.delete(param)]; }
`;
  assert.equal(countOf(body, 'r5-none'), 0);
  for (const [i, mod] of [
    'drizzle-orm/pg-core',
    '@supabase/supabase-js',
    'knex',
    'kysely',
    'typeorm',
    'sequelize',
    '@mikro-orm/core',
  ].entries()) {
    assert.equal(countOf(`import '${mod}';\n${body}`, `r5-import-${i}`), 3, mod);
  }
  assert.equal(countOf(`const k = require('knex');\nvoid k;\n${body}`, 'r5-require'), 3);
  // A module that merely starts with a listed name is not it.
  assert.equal(countOf(`import 'knexfile';\n${body}`, 'r5-prefix'), 0);
});

/* ------------------------------------------------------------ write hooks */

test('writeHooks counts $use and the $extends calls that may inject fields into a write', () => {
  const decls = `
declare const prisma: { $use(fn: unknown): unknown; $extends(x: unknown): unknown };
declare const ext: unknown;
declare const rest: object;
`;
  const counted = [
    'prisma.$use(async (p: unknown, next: (p: unknown) => unknown) => next(p))',
    'prisma.$extends({ query: { $allModels: {} } })',
    "prisma.$extends({ 'query': {} })",
    'prisma.$extends(ext)',
    'prisma.$extends({ ...rest })',
    'prisma.$extends({ [`que${"ry"}`]: {} })',
    'prisma.$extends()',
  ];
  for (const [i, expr] of counted.entries()) {
    const output = run(
      { 'src/q.ts': `${decls}export function f(): unknown { return ${expr}; }\n` },
      `hook-${i}`,
      indexOf({ tables: [] }),
    );
    assert.equal(repoNode(output).props['writeHooks'], 1, expr);
    assert.equal(
      repoNode(output).props['untracedWriteCalls'],
      0,
      'a hook is not an untraced write',
    );
  }
  const clean = [
    'prisma.$extends({ result: { user: {} } })',
    'prisma.$extends({ model: { user: {} }, client: {}, name: "x" })',
    'prisma.$extends({})',
  ];
  for (const [i, expr] of clean.entries()) {
    const output = run(
      { 'src/q.ts': `${decls}export function f(): unknown { return ${expr}; }\n` },
      `hook-clean-${i}`,
      indexOf({ tables: [] }),
    );
    assert.equal(repoNode(output).props['writeHooks'], 0, expr);
  }
});

/* ------------------------------------------------------------ unknownWriterTables (a) */

const ORM_INDEX: IndexSpec = {
  tables: [{ name: 'b2b_leads' }, { name: 'users' }, { name: 'orders' }],
  delegates: {
    b2bLead: { model: 'B2bLead', table: 'b2b_leads' },
    user: { model: 'User', table: 'users' },
  },
  exports: { orders: 'orders' },
};

test('unknownWriterTables (a): an ORM-shaped write names its table by the delegate or the export, with no receiver rule', () => {
  const output = run(
    {
      'src/q.ts': `
declare const prisma: any;
declare const db: any;
declare const orders: unknown;
export function a(): unknown { return prisma.b2bLead.create({ data: {} }); }
export function b(): unknown { return db.insert(orders).values({}); }
`,
    },
    'a-orm',
    indexOf(ORM_INDEX),
  );
  assert.equal(repoNode(output).props['unknownWriterTables'], 'b2b_leads,orders');
  assert.equal(repoNode(output).props['untracedWriteCalls'], 0);
});

test('unknownWriterTables (a): a read, an unknown delegate and a name collision', () => {
  const output = run(
    {
      'src/q.ts': `
declare const prisma: any;
declare const cache: any;
export function read(): unknown { return prisma.b2bLead.findMany(); }
export function other(): unknown { return prisma.widget.create({ data: {} }); }
export function collision(): unknown { return cache.user.create({ id: 1 }); }
`,
    },
    'a-clean',
    indexOf(ORM_INDEX),
  );
  // `cache.user.create` is not Prisma, and the name is enough: it can only withhold `users`.
  assert.equal(repoNode(output).props['unknownWriterTables'], 'users');
});

test('unknownWriterTables (a): a write through an element access names the delegate when it is written out', () => {
  const output = run(
    {
      'src/q.ts':
        "declare const prisma: any;\nexport function a(): unknown { return prisma['b2bLead'].upsert({}); }\n",
    },
    'a-element',
    indexOf(ORM_INDEX),
  );
  assert.equal(repoNode(output).props['unknownWriterTables'], 'b2b_leads');
});

/* ------------------------------------------------------------ the verb of each site */

test('each untraced site names the verb it writes with, so an insert-class gate can read the diagnostics', () => {
  const output = run(
    {
      'src/q.ts': `
import 'knex';
declare const prisma: any;
declare const db: any;
declare const param: unknown;
declare const q: string;
declare const t: string;
declare const key: string;
export function a(): unknown[] {
  return [
    prisma.$executeRawUnsafe(\`INSERT INTO \${t} (a) VALUES (1)\`),
    prisma.$executeRawUnsafe(\`UPDATE \${t} SET a = 1\`),
    prisma.$executeRawUnsafe(\`DELETE FROM \${t}\`),
    prisma.$executeRawUnsafe(q),
    prisma[key].createMany({}),
    prisma[key].update({}),
    prisma[key].deleteMany({}),
    prisma[key].upsert({}),
    db.insert(param),
    db.update(param),
    db.delete(param),
    'INSERT INTO ' + t,
    'DELETE FROM ' + t,
  ];
}
export const spliced = prisma.$executeRaw\`INSERT INTO \${Prisma.raw(t)} (a) VALUES (1)\`;
export const verbless = prisma.$executeRaw\`\${Prisma.raw(q)} \${t}\`;
export const unattributed = \`UPDATE \${t} SET a = 1\`;
`,
    },
    'verbs',
    indexOf({ tables: [] }),
  );
  assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
  const lines = output.result.diagnostics.filter((d) => d.startsWith('untraced write at '));
  assert.deepEqual(
    lines.map((l) => l.replace(/^untraced write at src\/q\.ts:\d+ /, '')),
    [
      '(unsafe-raw-call, insert)',
      '(unsafe-raw-call, update)',
      '(unsafe-raw-call, delete)',
      '(unsafe-raw-call, unknown)',
      '(computed-delegate, insert)',
      '(computed-delegate, update)',
      '(computed-delegate, delete)',
      '(computed-delegate, insert)',
      '(query-builder-call, insert)',
      '(query-builder-call, update)',
      '(query-builder-call, delete)',
      '(concatenated-statement, insert)',
      '(concatenated-statement, delete)',
      '(spliced-fragment, insert)',
      '(spliced-fragment, unknown)',
      '(unattributed-statement, update)',
    ],
  );
  // The verb is recorded beside the count and does not change it.
  assert.equal(repoNode(output).props['untracedWriteCalls'], 16);
});

/* ------------------------------------------------------------ unknownWriterTables (b) */

test('unknownWriterTables (b): an unread file with a write marker withholds the tables it names, by model, delegate, export or table', () => {
  const output = run(
    {
      'src/q.ts': 'export const x = 1;\n',
      // Outside the project (`include: ["src"]`): never parsed, never an edge.
      'scripts/seed.ts':
        'prisma.b2bLead.create({ data: {} });\nawait db.insert(orders).values({});\n',
      'tools/raw.js': "await client.query('INSERT INTO Users (id) VALUES (1)');\n",
      'tools/model.js': 'prisma.$executeRaw`INSERT INTO x`; const m = B2bLead;\n',
    },
    'b-unread',
    indexOf(ORM_INDEX),
  );
  assert.equal(output.result.status, 'PASS');
  assert.equal(repoNode(output).props['unknownWriterTables'], 'b2b_leads,orders,users');
  assert.ok(
    output.result.diagnostics.includes('unknown writer of orders: scripts/seed.ts (unread file)'),
    output.result.diagnostics.join('\n'),
  );
  assert.ok(
    output.result.diagnostics.includes('unknown writer of users: tools/raw.js (unread file)'),
  );
});

test('unknownWriterTables (b): no marker, a skipped directory, a minified bundle and a part of a word withhold nothing', () => {
  const output = run(
    {
      'src/q.ts': 'export const x = 1;\n',
      // A table name, and no write marker.
      'scripts/read.ts':
        'const rows = await db.select().from(orders); console.log(users, b2bLead);\n',
      // A marker and the names, in places the scan skips.
      'dist/seed.js': 'prisma.user.create({}); db.insert(orders);\n',
      'vendor/lib.js': 'INSERT INTO users;\n',
      'public/app.min.js': 'prisma.user.create({});\n',
      // A marker, and only a word that contains a table name.
      'scripts/words.ts':
        'db.insert(my_orders_archive); const usersList = 1; const subusers = 2;\n',
    },
    'b-clean',
    indexOf(ORM_INDEX),
  );
  assert.equal(repoNode(output).props['unknownWriterTables'], '');
});

test('unknownWriterTables (b): a table name that is not one word is found as a whole', () => {
  const output = run(
    {
      'src/q.ts': 'export const x = 1;\n',
      'scripts/a.ts': 'await client.query(\'INSERT INTO "Order Items" (id) VALUES (1)\');\n',
    },
    'b-odd',
    indexOf({ tables: [{ name: 'Order Items' }, { name: 'Orders' }, { name: 'Order Item' }] }),
  );
  assert.equal(repoNode(output).props['unknownWriterTables'], 'Order Items');
});

test('unknownWriterTables (c) and (a)/(b) merge into one sorted list, each table once', () => {
  const output = run(
    {
      'src/q.ts': `
declare const prisma: any;
export function amb(): string { return 'INSERT INTO accounts (id) VALUES (1)'; }
export function orm(): unknown { return prisma.user.create({}); }
`,
      'scripts/seed.ts':
        'prisma.user.create({}); // users and orders, INSERT\nconst o = "orders";\n',
    },
    'merge',
    indexOf({
      tables: [
        { schema: 'auth', name: 'accounts' },
        { schema: 'app', name: 'accounts' },
        { name: 'users' },
        { name: 'orders' },
      ],
      delegates: { user: { model: 'User', table: 'users' } },
    }),
  );
  assert.equal(repoNode(output).props['unknownWriterTables'], 'accounts,orders,users');
});

/* ------------------------------------------------------------ clean cases (section 7) */

test('the clean cases of section 7 count nothing', () => {
  const output = run(
    {
      'src/q.ts': `
import { createHash } from 'node:crypto';
declare const searchParams: URLSearchParams;
declare const phone: string;
declare const n: number;
export function hash(str: string): string { return createHash('sha256').update(str).digest('hex'); }
export function params(): void { searchParams.delete('q'); }
export const labels = [
  'DELETE', 'Call or email us', 'Call us', 'Call now', 'Call back',
  'Update assumption', 'Copy reference',
  \`Call \${phone}\`, \`Update \${n} items\`,
];
`,
    },
    'clean',
    indexOf({ tables: [] }),
  );
  assert.equal(output.result.status, 'PASS');
  assert.equal(repoNode(output).props['untracedWriteCalls'], 0);
  assert.equal(repoNode(output).props['unknownWriterTables'], '');
  assert.deepEqual(queriesOf(output), []);
});

test('"Delete from cart" has its edge to an external table and counts nothing', () => {
  const output = run(
    { 'src/q.ts': "export function label(): string { return 'Delete from cart'; }\n" },
    'cart',
    indexOf({ tables: [] }),
  );
  assert.deepEqual(queriesOf(output), ['public.cart']);
  assert.equal(repoNode(output).props['untracedWriteCalls'], 0);
});

test('the same .update(...) call counts only in a file that imports a listed query builder', () => {
  const body =
    'declare const h: { update(x: string): unknown };\nexport function f(str: string): unknown { return h.update(str); }\n';
  assert.equal(countOf(body, 'update-plain'), 0);
  assert.equal(countOf(`import 'drizzle-orm';\n${body}`, 'update-builder'), 1);
});

/* ------------------------------------------------------------ determinism */

const MIXED_FILES: FileMap = {
  'src/a.ts': `
declare const prisma: any;
declare const sql: (s: TemplateStringsArray, ...v: unknown[]) => unknown;
export function one(q: string, m: string, t: string): unknown {
  prisma.$executeRawUnsafe(q);
  prisma[m].create({});
  prisma.user.create({});
  prisma.$use(() => 1);
  return sql\`INSERT INTO \${t} (a) VALUES (1)\`;
}
`,
  'src/b.ts': `
declare const c: { query(q: string): unknown };
export function two(t: string): unknown { return c.query('DELETE FROM ' + t); }
export const schemaSetup = 'CREATE TABLE accounts (id int)';
`,
  'scripts/seed.ts': 'prisma.b2bLead.create({});\n',
};

test('the facts are byte-identical across roots and file order, and carry no path of the machine', () => {
  const a = run(MIXED_FILES, 'det-a', indexOf(ORM_INDEX));
  const reversed = Object.fromEntries(Object.entries(MIXED_FILES).reverse());
  const b = run(reversed, 'det-b', indexOf(ORM_INDEX));
  assert.equal(toCanonicalSif(a), toCanonicalSif(b));
  assert.deepEqual(a.result.diagnostics, b.result.diagnostics);
  const props = repoNode(a).props;
  assert.equal(
    props['untracedWriteCalls'],
    4,
    'unsafe call, computed delegate, spliced table, concatenated phrase',
  );
  assert.equal(props['writeHooks'], 1);
  assert.equal(props['runtimeDdl'], 1);
  assert.equal(props['unknownWriterTables'], 'b2b_leads,users');
  for (const root of roots) assert.equal(JSON.stringify(a).includes(root), false);
});
