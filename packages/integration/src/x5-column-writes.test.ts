/**
 * Real-extraction acceptance for X5 (unexposed required column), design
 * `docs/design/real-world-inputs.md` 5.1, 5.2 and 8.1.
 *
 * Each test runs the real `extractData` and `extractCodeTs` over a repository written to a
 * temporary directory, persists the output into a real `SqliteStore` the way `seamline extract`
 * does, and runs the real X5 over that graph. Nothing is hand-fed to the detector.
 *
 * The 8.1 instance is a hermetic fixture of the same shape, written from scratch: a Prisma
 * model with a client-side `@updatedAt`, and raw `INSERT` statements written as tagged
 * templates on a `neon(...)` client whose substitutions are all in `VALUES`. The saintandstory
 * repository itself is never copied; the evaluation corpus fetches it at run time.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { CODE_TS_SCOPE, extractCodeTs } from '@seamline/extract-code-ts';
import { DATA_SCOPE, buildDataModelIndex, extractData } from '@seamline/extract-data';
import { runDetectors, x5UnwrittenColumn } from '@seamline/contradictions';
import { SqliteStore, profileView, TEAM_PROFILE } from '@seamline/core';

const REPO = 'x5fixture';
const RUN = 'run-1';

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
    include: ['**/*.ts'],
    exclude: ['node_modules'],
  },
  null,
  2,
);

const dirs: string[] = [];

after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

interface Outcome {
  readonly outcome: string;
  readonly reason: string;
  readonly findings: ReadonlyArray<{ claim: string; confidence: number; left: string }>;
  readonly notes: ReadonlyArray<string>;
  readonly statuses: { readonly data: string; readonly code: string };
  readonly queries: ReadonlyArray<{ table: string; props: Readonly<Record<string, unknown>> }>;
  readonly runtimeDdl: unknown;
  readonly codeFiles: readonly string[];
}

/** Writes `files`, runs both extractors as the CLI does, persists, and runs X5 over the store. */
async function x5Over(files: Readonly<Record<string, string>>, hideRuntimeDdl = false): Promise<Outcome> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'seamline-x5-repo-'));
  const dbDir = await mkdtemp(join(tmpdir(), 'seamline-x5-db-'));
  dirs.push(repoRoot, dbDir);
  for (const [rel, text] of Object.entries({ 'tsconfig.json': TSCONFIG, ...files })) {
    const abs = join(repoRoot, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, text, 'utf8');
  }

  const data = await extractData({ root: repoRoot, repo: REPO, runId: RUN, deterministic: true });
  // As `seamline extract` runs them: the code run is handed the index the data run published.
  const code = extractCodeTs({
    repoRoot,
    repo: REPO,
    runId: RUN,
    deterministic: true,
    dataModelIndex: buildDataModelIndex(data.nodes),
  });

  const store = new SqliteStore({ path: join(dbDir, 'graph.db'), ontologyVersion: '1.0.0' });
  try {
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

    const view = hideRuntimeDdl ? profileView(store, {
      ...TEAM_PROFILE,
      allowProps: {
        ...TEAM_PROFILE.allowProps,
        Repo: ['untracedWriteCalls', 'writeHooks', 'unknownWriterTables'],
      },
    }) : store;
    const report = runDetectors(view, [x5UnwrittenColumn]).detectors[0];
    assert.ok(report !== undefined);
    const tables = new Map(store.nodesByKind('Table').map((t) => [String(t.id), t.name]));
    return {
      outcome: report.outcome,
      reason: report.result.known ? '' : report.result.reason,
      findings: report.findings.map((f) => ({
        claim: f.claim,
        confidence: f.confidence,
        left: f.left,
      })),
      notes: report.notes,
      statuses: { data: data.result.status, code: code.result.status },
      queries: [...data.edges, ...code.edges]
        .filter((e) => e.kind === 'QUERIES')
        .map((e) => ({ table: tables.get(String(e.dst)) ?? String(e.dst), props: e.props })),
      runtimeDdl: code.nodes.find((n) => n.kind === 'Repo')?.props['runtimeDdl'],
      codeFiles: code.nodes.filter((n) => n.kind === 'File').map((n) => n.path ?? ''),
    };
  } finally {
    await store.close();
  }
}

/* ---------------------------------------------------------------- users */

/** Authored fixture: the helper supplies a database default absent from the Prisma declaration. */
function runtimeSchema(ddl: string): Readonly<Record<string, string>> {
  return {
    'schema.prisma': 'model Account {\n id Int @id\n updatedAt DateTime @updatedAt @map("updated_at")\n @@map("accounts")\n}\n',
    'runtime.ts': `declare const db: { query(sql: string): Promise<void> };
export async function ensureSchema(): Promise<void> { await db.query(${JSON.stringify(ddl)}); }
export async function addAccount(): Promise<void> { await ensureSchema(); await db.query("INSERT INTO accounts (id) VALUES (1)"); }
`,
  };
}

test('embedded runtime schema DDL makes default absence UNKNOWN instead of a false client-only finding', async () => {
  for (const ddl of [
    'CREATE TABLE IF NOT EXISTS accounts (id integer PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    'ALTER TABLE accounts ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP',
    'SELECT 1; DROP TABLE accounts',
  ]) {
    const out = await x5Over(runtimeSchema(ddl));
    assert.deepEqual(out.statuses, { data: 'PASS', code: 'PASS' });
    assert.equal(out.outcome, 'unknown');
    assert.deepEqual(out.findings, []);
    assert.equal(out.runtimeDdl, 1);
    assert.match(out.reason, /runtimeDdl is 1/u);
  }
});

test('split runtime DDL supplies a SQLite default on two executions and withholds X5 reproducibly', async () => {
  const head = 'CR';
  const tail = 'EATE TABLE IF NOT EXISTS accounts (id integer PRIMARY KEY, updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP)';
  const database = new DatabaseSync(':memory:');
  try {
    for (const id of [1, 2]) {
      database.exec(head + tail);
      database.exec(`INSERT INTO accounts (id) VALUES (${id})`);
    }
    const rows = database.prepare('SELECT updated_at FROM accounts ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => typeof row['updated_at'] === 'string' && row['updated_at'].length > 0));
  } finally {
    database.close();
  }
  const files = runtimeSchema(head + tail);
  const split = {
    ...files,
    'runtime.ts': files['runtime.ts']!.replace(JSON.stringify(head + tail), `${JSON.stringify(head)} + ${JSON.stringify(tail)}`),
  };
  for (let pass = 0; pass < 2; pass += 1) {
    const out = await x5Over(split);
    assert.deepEqual(out.statuses, { data: 'PASS', code: 'PASS' });
    assert.equal(out.runtimeDdl, 1);
    assert.equal(out.outcome, 'unknown');
    assert.deepEqual(out.findings, []);
    assert.match(out.reason, /runtimeDdl is 1/u);
  }
});

test('joined ordinary words and joined SQL string contents leave the omission control active', async () => {
  const files = runtimeSchema('SELECT 1');
  const out = await x5Over({
    ...files,
    'runtime.ts': files['runtime.ts']!.replace('"SELECT 1"', '"SELECT \'CR" + "EATE TABLE accounts\'"') + '\nconst label = "CRE" + "ATIVE"; void ("AL" + "TERNATIVE");\n',
  });
  assert.deepEqual(out.statuses, { data: 'PASS', code: 'PASS' });
  assert.equal(out.runtimeDdl, 0);
  assert.equal(out.outcome, 'fired');
  assert.equal(out.findings.length, 1);
});

test('constant template and asserted DDL supply the SQLite default and leave X5 UNKNOWN', async () => {
  const tail = 'EATE TABLE IF NOT EXISTS accounts (id integer PRIMARY KEY, updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP)';
  const database = new DatabaseSync(':memory:');
  try {
    for (const id of [1, 2]) {
      database.exec(`C${`R${tail}`}`);
      database.exec(`INSERT INTO accounts (id) VALUES (${id})`);
    }
    const rows = database.prepare('SELECT updated_at FROM accounts ORDER BY id').all();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => typeof row['updated_at'] === 'string' && row['updated_at'].length > 0));
  } finally {
    database.close();
  }
  const ddl = 'CR' + tail;
  const expressions = [
    '`CR${' + JSON.stringify(tail) + '}`',
    '`C${`R${' + JSON.stringify(tail) + '}`}`',
    '(<string>"CR") + ' + JSON.stringify(tail),
    'prefix + "CR" + ' + JSON.stringify(tail),
  ];
  for (const expression of expressions) {
    const files = runtimeSchema(ddl);
    const out = await x5Over({
      ...files,
      'runtime.ts': 'const prefix = "";\n' + files['runtime.ts']!.replace(JSON.stringify(ddl), expression),
    });
    assert.deepEqual(out.statuses, { data: 'PASS', code: 'PASS' });
    assert.equal(out.runtimeDdl, 1, expression);
    assert.equal(out.outcome, 'unknown', expression);
    assert.deepEqual(out.findings, []);
  }
});

test('DDL words inside SQL strings and comments do not suppress a genuine default-absence finding', async () => {
  const out = await x5Over(runtimeSchema("SELECT 'CREATE TABLE accounts', 'DROP TABLE accounts' /* ALTER TABLE accounts */ -- RENAME TABLE accounts\n"));
  assert.equal(out.runtimeDdl, 0);
  assert.equal(out.outcome, 'fired');
  assert.equal(out.findings.length, 1);
  assert.match(out.findings[0]?.claim ?? '', /accounts.updated_at.*client-side default/u);
});

test('a profile withholding runtime DDL measurement leaves X5 UNKNOWN', async () => {
  const out = await x5Over(runtimeSchema('SELECT 1'), true);
  assert.equal(out.runtimeDdl, 0);
  assert.equal(out.outcome, 'unknown');
  assert.deepEqual(out.findings, []);
  assert.match(out.reason, /runtimeDdl is absent|no Repo node records runtimeDdl/u);
});

for (const file of ['scripts/setup.js', 'scripts/setup.ts']) {
  test(`runtime DDL outside the loaded project in ${file} cannot establish default absence`, async () => {
    const ddl = 'ALTER TABLE accounts ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP';
    for (const expression of [JSON.stringify(ddl), '"AL" + ' + JSON.stringify(ddl.slice(2))]) {
      const out = await x5Over({
        ...runtimeSchema('SELECT 1'),
        'tsconfig.json': JSON.stringify({ ...JSON.parse(TSCONFIG), include: ['runtime.ts'] }),
        [file]: `db.query(${expression});\n`,
      });
      assert.deepEqual(out.statuses, { data: 'PASS', code: 'PASS' });
      assert.equal(out.codeFiles.includes(file), false, 'the setup file is outside graph extraction');
      assert.equal(out.queries.length, 1, 'the loaded insert remains traced');
      assert.equal(out.runtimeDdl, 1);
      assert.equal(out.outcome, 'unknown');
      assert.deepEqual(out.findings, []);
      assert.match(out.reason, /runtimeDdl is 1/u);
    }
  });
}

test('an unread source with only quoted DDL words keeps the omission control active', async () => {
  const file = 'scripts/setup.js';
  const out = await x5Over({
    ...runtimeSchema('SELECT 1'),
    [file]: `db.query("SELECT 'CREATE TABLE accounts' /* ALTER TABLE accounts */");\n`,
  });
  assert.deepEqual(out.statuses, { data: 'PASS', code: 'PASS' });
  assert.equal(out.codeFiles.includes(file), false);
  assert.equal(out.runtimeDdl, 0);
  assert.equal(out.outcome, 'fired');
  assert.equal(out.findings.length, 1);
});

test('a syntactically incomplete unread source cannot certify zero runtime DDL', async () => {
  const file = 'scripts/setup.js';
  const out = await x5Over({
    ...runtimeSchema('SELECT 1'),
    [file]: 'db.query("ALTER TABLE accounts',
  });
  assert.deepEqual(out.statuses, { data: 'PASS', code: 'PASS' });
  assert.equal(out.codeFiles.includes(file), false);
  assert.equal(out.runtimeDdl, undefined);
  assert.equal(out.outcome, 'unknown');
  assert.deepEqual(out.findings, []);
  assert.match(out.reason, /runtimeDdl is absent|no Repo node records runtimeDdl/u);
});

test('X5 fires on a real violation: an insert whose column list omits a NOT NULL column with no default', async () => {
  const out = await x5Over({
    'db/schema.sql':
      'CREATE TABLE users (\n  id bigserial PRIMARY KEY,\n  email text NOT NULL\n);\n',
    'src/repository.ts': [
      'export function createUser(): void {',
      '  db.query("INSERT INTO users (id) VALUES (1)");',
      '}',
      '',
      'declare const db: { query(sql: string): void };',
      '',
    ].join('\n'),
  });
  assert.deepEqual(out.statuses, { data: 'PASS', code: 'PASS' });
  // The edge the detector reads carries the column facts row C added.
  assert.equal(out.queries.length, 1);
  assert.equal(out.queries[0]?.props['insertColumns'], 'id');
  assert.equal(out.queries[0]?.props['insertComplete'], true);
  assert.equal(out.outcome, 'fired', out.reason);
  assert.equal(out.findings.length, 1);
  assert.match(out.findings[0]?.claim ?? '', /^users\.email is NOT NULL and has no default/u);
});

test('X5 is silent on the same repository once the insert names the column', async () => {
  const out = await x5Over({
    'db/schema.sql':
      'CREATE TABLE users (\n  id bigserial PRIMARY KEY,\n  email text NOT NULL\n);\n',
    'src/repository.ts': [
      'export function createUser(): void {',
      '  db.query("INSERT INTO users (id, email) VALUES (1, \'a@b.c\')");',
      '}',
      '',
      'declare const db: { query(sql: string): void };',
      '',
    ].join('\n'),
  });
  assert.equal(out.outcome, 'clean');
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.notes, []);
});

/* ------------------------------------------------- the 8.1 instance shape */

const PRISMA_SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model B2bLead {
  id           Int      @id @default(autoincrement())
  businessName String   @map("business_name")
  city         String?
  source       String
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  @@map("b2b_leads")
}

model B2bStandingOrder {
  id              Int      @id @default(autoincrement())
  leadId          Int      @map("lead_id")
  quantity        Int
  nextScheduledAt DateTime @map("next_scheduled_at")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@map("b2b_standing_orders")
}

model Job {
  id    Int    @id @default(autoincrement())
  title String

  @@map("jobs")
}
`;

const NEON = `import { neon } from "@neondatabase/serverless";\nconst sql = neon(process.env.DATABASE_URL ?? "");\n`;

/** A tagged template whose substitutions are all in VALUES; the template opens on the line above the statement. */
function insertRoute(fn: string, statement: string): string {
  return `${NEON}
export async function ${fn}(name: string, city: string, qty: number): Promise<void> {
  await sql\`
    ${statement}\`;
  void [name, city, qty];
}
`;
}

const DISCOVER_PARENT =
  "INSERT INTO b2b_leads (business_name, city, source) VALUES (${name}, ${city}, 'discover')";
const DISCOVER_FIX =
  "INSERT INTO b2b_leads (business_name, city, source, created_at, updated_at) VALUES (${name}, ${city}, 'discover', NOW(), NOW())";

function saintShape(discover: string): Record<string, string> {
  return {
    'prisma/schema.prisma': PRISMA_SCHEMA,
    'app/api/b2b/discover/route.ts': insertRoute('discoverLeads', discover),
    'app/api/b2b/inbound/route.ts': insertRoute(
      'inboundLead',
      "INSERT INTO b2b_leads (business_name, source) VALUES (${name}, 'inbound')",
    ),
    'app/api/b2b/leads/route.ts': insertRoute(
      'createLead',
      "INSERT INTO b2b_leads (business_name, city, source) VALUES (${name}, ${city}, 'manual')",
    ),
    'app/api/b2b/standing-orders/route.ts': insertRoute(
      'createStandingOrder',
      'INSERT INTO b2b_standing_orders (lead_id, quantity, next_scheduled_at) VALUES (${qty}, ${qty}, ${city})',
    ),
    // Statements that are not inserts, and ORM writes to an unrelated model, as in the instance.
    'app/api/b2b/stats/route.ts': `${NEON}
export async function touch(id: number): Promise<unknown> {
  await sql\`UPDATE b2b_leads SET city = 'x' WHERE id = \${id}\`;
  return sql\`SELECT id FROM b2b_leads WHERE id = \${id}\`;
}
`,
    'lib/jobs.ts': `import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
export async function addJob(title: string): Promise<unknown> {
  return prisma.job.create({ data: { title } });
}
`,
    // Outside every tsconfig project, so unread: it names a model that is not one of the two tables.
    'scripts/seed.js':
      'const { PrismaClient } = require("@prisma/client");\nconst p = new PrismaClient();\np.job.create({ data: { title: "x" } });\n',
  };
}

const UPDATED_AT =
  /^(b2b_leads|b2b_standing_orders)\.updated_at is NOT NULL and has only a client-side default, which a raw insert does not receive/u;

test('8.1 parent shape: X5 reports b2b_leads.updated_at and b2b_standing_orders.updated_at at confidence 0.7', async () => {
  const out = await x5Over(saintShape(DISCOVER_PARENT));
  assert.deepEqual(out.statuses, { data: 'PASS', code: 'PASS' });
  // Four raw inserts, each an interpolated template bound to a table by its literal name.
  const inserts = out.queries.filter((q) => q.props['insertComplete'] !== undefined);
  assert.deepEqual(
    inserts.map((q) => [q.table, q.props['interpolated'], q.props['insertComplete']]).sort(),
    [
      ['b2b_leads', true, true],
      ['b2b_leads', true, true],
      ['b2b_leads', true, true],
      ['b2b_standing_orders', true, true],
    ],
  );
  assert.equal(out.outcome, 'fired', out.reason);
  assert.deepEqual(out.findings.map((f) => [f.claim.split(' ')[0], f.confidence]).sort(), [
    ['b2b_leads.updated_at', 0.7],
    ['b2b_standing_orders.updated_at', 0.7],
  ]);
  for (const f of out.findings) assert.match(f.claim, UPDATED_AT);
});

test('8.1 fix shape: the discover insert names updated_at, so only b2b_standing_orders.updated_at remains', async () => {
  const out = await x5Over(saintShape(DISCOVER_FIX));
  assert.equal(out.outcome, 'fired', out.reason);
  assert.deepEqual(
    out.findings.map((f) => [f.claim.split(' ')[0], f.confidence]),
    [['b2b_standing_orders.updated_at', 0.7]],
  );
});

test('created_at is not reported: a Prisma @default(now()) is a database default that a raw insert receives', async () => {
  const out = await x5Over(saintShape(DISCOVER_PARENT));
  assert.ok(out.findings.every((f) => !f.claim.includes('created_at')));
});

/* ---------------------------------------------------------------- guards */

const WITH_ORM_WRITER: Record<string, string> = {
  ...saintShape(DISCOVER_PARENT),
  'lib/leads.ts': `import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
export async function addLead(businessName: string): Promise<unknown> {
  return prisma.b2bLead.create({ data: { businessName, source: "orm" } });
}
`,
};

test('guard: an ORM write over a @@map table withholds it, with a note, and the other table still reports', async () => {
  const out = await x5Over(WITH_ORM_WRITER);
  assert.equal(out.outcome, 'fired', out.reason);
  assert.deepEqual(
    out.findings.map((f) => f.claim.split(' ')[0]),
    ['b2b_standing_orders.updated_at'],
  );
  assert.deepEqual(out.notes, [
    'table b2b_leads was not evaluated: a writer the extractor could not turn into an edge may reach it (unknownWriterTables)',
  ]);
});

test('guard: an unread JavaScript file writing the @@map table by its delegate withholds it', async () => {
  const out = await x5Over({
    ...saintShape(DISCOVER_PARENT),
    'scripts/import.js':
      'const { PrismaClient } = require("@prisma/client");\nnew PrismaClient().b2bLead.create({ data: {} });\n',
  });
  assert.deepEqual(
    out.findings.map((f) => f.claim.split(' ')[0]),
    ['b2b_standing_orders.updated_at'],
  );
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0] ?? '', /^table b2b_leads was not evaluated/u);
});

test('guard: a write call nobody can attribute makes X5 UNKNOWN for the repository, not clean', async () => {
  const out = await x5Over({
    ...saintShape(DISCOVER_PARENT),
    'lib/dynamic.ts': `import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
export async function run(statement: string): Promise<unknown> {
  return prisma.$executeRawUnsafe(statement);
}
`,
  });
  assert.equal(out.outcome, 'unknown');
  assert.match(out.reason, /untracedWriteCalls is 1/u);
  assert.deepEqual(out.findings, []);
});

test('guard: a BEFORE INSERT trigger withholds the table it is on', async () => {
  const out = await x5Over({
    ...saintShape(DISCOVER_PARENT),
    'db/triggers.sql': `CREATE FUNCTION touch() RETURNS trigger AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER b2b_leads_touch BEFORE INSERT ON b2b_leads FOR EACH ROW EXECUTE FUNCTION touch();
`,
  });
  assert.deepEqual(
    out.findings.map((f) => f.claim.split(' ')[0]),
    ['b2b_standing_orders.updated_at'],
  );
  assert.deepEqual(out.notes, [
    'table b2b_leads was not evaluated: a BEFORE INSERT trigger on it may supply the column',
  ]);
});

test('guard: a table two source files declare is withheld, however the second one is written', async () => {
  const out = await x5Over({
    'prisma/schema.prisma': `datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n\nmodel Note {\n  id Int @id @default(autoincrement())\n  body String\n\n  @@map("notes")\n}\n`,
    'prisma/other.prisma': `model Memo {\n  id Int @id @default(autoincrement())\n  title String\n\n  @@map("notes")\n}\n`,
    'src/notes.ts': `declare const db: { query(sql: string): void };
export function addNote(): void {
  db.query("INSERT INTO notes (title) VALUES ('x')");
}
`,
  });
  assert.equal(out.outcome, 'clean');
  assert.deepEqual(out.findings, []);
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0] ?? '', /^table notes was not evaluated: 2 source files declare it/u);
});

test('guard: dynamic DDL in a migration makes X5 UNKNOWN', async () => {
  const out = await x5Over({
    ...saintShape(DISCOVER_PARENT),
    'db/migrations/0001_init.sql':
      "DO $$ BEGIN EXECUTE 'ALTER TABLE b2b_leads ALTER COLUMN updated_at SET DEFAULT now()'; END $$;\n",
  });
  assert.equal(out.outcome, 'unknown');
  assert.match(out.reason, /dynamicDdl is 1/u);
});
