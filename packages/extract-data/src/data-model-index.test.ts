/**
 * `ormModel` on `Table` nodes and the data-model index built from them.
 *
 * Every test runs the real extractor over a small tree and asserts what comes
 * out: the prop on the node, the bytes of the index. The reader of the index
 * (`@seamline/extract-code-ts`) is exercised against these bytes in the
 * integration package.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

import type { SeamlineNode } from '@seamline/ontology';
import { buildDataModelIndex, prismaDelegateName } from './data-model-index.ts';
import { extractData, type ExtractDataOptions, type ExtractDataOutput } from './extractor.ts';

const roots: string[] = [];

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'seamline-data-model-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text, 'utf8');
  }
  return root;
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function extract(
  files: Readonly<Record<string, string>>,
  extra: Partial<ExtractDataOptions> = {},
): Promise<ExtractDataOutput> {
  const root = await tree(files);
  const out = await extractData({ root, repo: 'demo', runId: 'r1', deterministic: true, ...extra });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('; '));
  return out;
}

function tableNode(out: ExtractDataOutput, id: string): SeamlineNode {
  const found = out.nodes.find((n) => n.kind === 'Table' && n.id === id);
  assert.ok(found !== undefined, `no table ${id}`);
  return found;
}

interface Index {
  readonly version: number;
  readonly dataSources: ReadonlyArray<{ name: string; dialect: string; defaultSchema: string }>;
  readonly tables: ReadonlyArray<{
    id: string;
    dataSource: string;
    dialect?: string;
    schema: string;
    name: string;
  }>;
  readonly prismaDelegates: Readonly<Record<string, { model: string; table: string }>>;
  readonly drizzleExports: Readonly<Record<string, string>>;
}

function indexOf(out: ExtractDataOutput): Index {
  return JSON.parse(buildDataModelIndex(out.nodes)) as Index;
}

const PRISMA_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Invitation {
  id    String @id
  email String
}

model B2bLead {
  id           String @id
  businessName String @map("business_name")

  @@map("b2b_leads")
}

model Account {
  id String @id

  @@map("accounts")
  @@schema("auth")
}
`;

const DRIZZLE_SCHEMA = `
import { pgTable, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users', { id: text('id').primaryKey() });
export const auditLog = pgTable('audit_log', { id: text('id').primaryKey() });
`;

/* ------------------------------------------------------------------ ormModel */

test('a Prisma table records its model name, mapped or not', async () => {
  const out = await extract({ 'prisma/schema.prisma': PRISMA_SCHEMA });
  assert.equal(tableNode(out, 'demo:Table:public.Invitation').props['ormModel'], 'Invitation');
  assert.equal(tableNode(out, 'demo:Table:public.b2b_leads').props['ormModel'], 'B2bLead');
  assert.equal(tableNode(out, 'demo:Table:auth.accounts').props['ormModel'], 'Account');
});

test('a Drizzle table records its binding, which is not its table name', async () => {
  const out = await extract({ 'src/schema.ts': DRIZZLE_SCHEMA });
  assert.equal(tableNode(out, 'demo:Table:public.users').props['ormModel'], 'users');
  assert.equal(tableNode(out, 'demo:Table:public.audit_log').props['ormModel'], 'auditLog');
});

test('a table only SQL declares has no ormModel, so its node carries only the SQL-derived props', async () => {
  const out = await extract({ 'db/schema.sql': 'CREATE TABLE orders (id bigint PRIMARY KEY);\n' });
  const props = tableNode(out, 'demo:Table:public.orders').props;
  assert.equal('ormModel' in props, false);
  assert.deepEqual(Object.keys(props).sort(), [
    'checkConstraint',
    'columnCount',
    'comment',
    'dataSource',
    'declarations',
    'dialect',
    'insertTrigger',
    'schema',
    'sourceKinds',
    'table',
  ]);
});

test('a Prisma model that a migration also creates keeps its model name', async () => {
  const out = await extract({
    'prisma/schema.prisma': PRISMA_SCHEMA,
    'db/migrations/0001_init.sql': 'CREATE TABLE "Invitation" (id text PRIMARY KEY, email text);\n',
  });
  const props = tableNode(out, 'demo:Table:public.Invitation').props;
  assert.equal(props['ormModel'], 'Invitation');
  assert.equal(props['sourceKinds'], 'prisma,sql-migration');
});

test('a table that Prisma and Drizzle both declare gets no ormModel, and the output says so', async () => {
  const out = await extract({
    'prisma/schema.prisma': 'model User {\n  id String @id\n  @@map("users")\n}\n',
    'src/schema.ts': DRIZZLE_SCHEMA,
  });
  const props = tableNode(out, 'demo:Table:public.users').props;
  assert.equal(
    'ormModel' in props,
    false,
    'one prop cannot say whether it is a model or a binding',
  );
  assert.ok(
    out.result.diagnostics.some((d) => d.startsWith('ormModel not recorded for public.users')),
    out.result.diagnostics.join('; '),
  );
  // The tables each source declares alone are unaffected.
  assert.equal(tableNode(out, 'demo:Table:public.audit_log').props['ormModel'], 'auditLog');
});

test('two Prisma models mapped to one table leave it without an ormModel', async () => {
  const out = await extract({
    'prisma/schema.prisma':
      'model A {\n  id String @id\n  @@map("shared")\n}\nmodel B {\n  id String @id\n  @@map("shared")\n}\n',
  });
  assert.equal('ormModel' in tableNode(out, 'demo:Table:public.shared').props, false);
});

test('the DataSource node carries the default schema an unqualified name resolves in', async () => {
  const out = await extract(
    { 'prisma/schema.prisma': PRISMA_SCHEMA },
    { defaultSchema: 'app', dialect: 'sqlite' },
  );
  const ds = out.nodes.find((n) => n.kind === 'DataSource');
  assert.ok(ds !== undefined);
  assert.equal(ds.props['defaultSchema'], 'app');
  assert.equal(ds.props['dialect'], 'sqlite');
});

/* --------------------------------------------------------------------- index */

test('the index maps each Prisma delegate to its model and table, and each Drizzle binding to its table', async () => {
  const out = await extract({
    'prisma/schema.prisma': PRISMA_SCHEMA,
    'src/schema.ts': DRIZZLE_SCHEMA,
  });
  const index = indexOf(out);
  assert.equal(index.version, 1);
  assert.deepEqual(index.prismaDelegates, {
    invitation: { model: 'Invitation', table: 'demo:Table:public.Invitation' },
    b2bLead: { model: 'B2bLead', table: 'demo:Table:public.b2b_leads' },
    account: { model: 'Account', table: 'demo:Table:auth.accounts' },
  });
  assert.deepEqual(index.drizzleExports, {
    users: 'demo:Table:public.users',
    auditLog: 'demo:Table:public.audit_log',
  });
});

test("table identity is (schema, name) as declared, with the data source's dialect and default schema", async () => {
  const out = await extract({
    'prisma/schema.prisma': PRISMA_SCHEMA,
    'db/schema.sql': 'CREATE TABLE orders (id bigint);\n',
  });
  const index = indexOf(out);
  assert.deepEqual(index.dataSources, [
    { name: 'default', dialect: 'postgres', defaultSchema: 'public' },
  ]);
  assert.deepEqual(
    index.tables.map((t) => `${t.schema}.${t.name}`),
    ['auth.accounts', 'public.Invitation', 'public.b2b_leads', 'public.orders'],
    'a model without @@map is the mixed-case table "Invitation", and tables are in id order',
  );
  assert.ok(index.tables.every((t) => t.dataSource === 'default'));
  // A table with no ORM declaration is in the index but is reachable from no delegate.
  assert.ok(!Object.values(index.prismaDelegates).some((d) => d.table.endsWith('.orders')));
});

test('a configured data source, dialect and default schema reach the index', async () => {
  const out = await extract(
    { 'prisma/schema.prisma': 'model Item {\n  id String @id\n}\n' },
    { dataSource: 'orders-db', dialect: 'mysql', defaultSchema: 'shop' },
  );
  const index = indexOf(out);
  assert.deepEqual(index.dataSources, [
    { name: 'orders-db', dialect: 'mysql', defaultSchema: 'shop' },
  ]);
  assert.equal(index.tables.length, 1);
  assert.equal(index.tables[0]?.dataSource, 'orders-db');
  assert.equal(index.tables[0]?.schema, 'shop');
  assert.equal(
    index.tables[0]?.id,
    out.nodes.find((n) => n.kind === 'Table')?.id,
    "the id is the Table node's, not re-derived",
  );
});

test('the same extraction in any node order, in two directories, gives the same bytes', async () => {
  const files = { 'prisma/schema.prisma': PRISMA_SCHEMA, 'src/schema.ts': DRIZZLE_SCHEMA };
  const a = await extract(files);
  const b = await extract(files, { runId: 'another-run' });
  const text = buildDataModelIndex(a.nodes);
  assert.equal(buildDataModelIndex(b.nodes), text, 'the run id is not an input');
  assert.equal(buildDataModelIndex([...a.nodes].reverse()), text, 'node order is not an input');
  assert.ok(!text.includes('\n') && !text.includes(' "'), 'canonical: compact, one line');
  assert.ok(
    text.indexOf('"dataSources"') < text.indexOf('"tables"') &&
      text.indexOf('"tables"') < text.indexOf('"version"'),
    'keys sorted',
  );
});

test('a table read by another dialect carries it, and the others stay without one', async () => {
  const out = await extract({
    'db/events.sql': 'CREATE TABLE events (id UUID, at DateTime) ENGINE = MergeTree ORDER BY id;\n',
    'db/schema.sql': 'CREATE TABLE orders (id bigint PRIMARY KEY);\n',
  });
  const index = indexOf(out);
  assert.deepEqual(index.dataSources, [
    { name: 'default', dialect: 'postgres', defaultSchema: 'public' },
  ]);
  const dialects = Object.fromEntries(index.tables.map((t) => [t.name, t.dialect ?? null]));
  assert.deepEqual(dialects, { events: 'clickhouse', orders: null });
});

test('a delegate or binding two tables claim identifies none of them', async () => {
  const out = await extract({
    'src/a.ts':
      "import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const items = pgTable('items_a', { id: text('id') });\n",
    'src/b.ts':
      "import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const items = pgTable('items_b', { id: text('id') });\nexport const unique = pgTable('unique_t', { id: text('id') });\n",
  });
  const index = indexOf(out);
  assert.equal(index.tables.length, 3);
  assert.deepEqual(index.drizzleExports, { unique: 'demo:Table:public.unique_t' });
});

test('no nodes, or only tombstoned ones, give a valid, empty index', async () => {
  const empty = {
    dataSources: [],
    drizzleExports: {},
    prismaDelegates: {},
    tables: [],
    version: 1,
  };
  assert.deepEqual(JSON.parse(buildDataModelIndex([])), empty);
  const out = await extract({ 'prisma/schema.prisma': PRISMA_SCHEMA });
  const buried = out.nodes.map((n) => ({ ...n, deletedAt: 'r2' }));
  assert.deepEqual(JSON.parse(buildDataModelIndex(buried)), empty);
});

test('Prisma lower-cases only the first character of a model name for its delegate', () => {
  assert.equal(prismaDelegateName('Invitation'), 'invitation');
  assert.equal(prismaDelegateName('B2bLead'), 'b2bLead');
  assert.equal(prismaDelegateName('URLShortener'), 'uRLShortener');
  assert.equal(prismaDelegateName('x'), 'x');
});

/* ------------------------------------------------- Drizzle behind a namespace */

const DRIZZLE_NAMESPACE_SCHEMA = `
import * as pg from 'drizzle-orm/pg-core';

export const role = pg.pgEnum('role', ['admin', 'member']);

export const user = pg.pgTable('user', {
  id: pg.text('id').primaryKey(),
  role: role('role').notNull(),
});

export const session = pg.pgTable('session', {
  id: pg.text('id').primaryKey(),
  userId: pg.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
});

export const appSchema = pg.pgSchema('app');

export const widget = appSchema.table('widget', {
  id: pg.text('id').primaryKey(),
  ownerId: pg.text('owner_id').references(() => user.id),
});
`;

test('a Drizzle table bound behind a namespace import gets its binding name, as the bare import does', async () => {
  const out = await extract({ 'src/schema.ts': DRIZZLE_NAMESPACE_SCHEMA });
  assert.equal(tableNode(out, 'demo:Table:public.user').props['ormModel'], 'user');
  assert.equal(tableNode(out, 'demo:Table:public.session').props['ormModel'], 'session');
  assert.equal(tableNode(out, 'demo:Table:app.widget').props['ormModel'], 'widget');
  assert.deepEqual(indexOf(out).drizzleExports, {
    session: 'demo:Table:public.session',
    user: 'demo:Table:public.user',
    widget: 'demo:Table:app.widget',
  });
});

test('a column builder behind a namespace import is still not read, so a foreign key to it stays unresolved', async () => {
  // Limit, pinned so that it is a decision: only the binding of the table is read behind a
  // namespace (`pg.pgTable`), not its column builders (`pg.text('id')`). The table is known by
  // its binding now, so the reference fails for the column it names instead of the table.
  const out = await extract({
    'src/schema.ts': `
import { pgTable, text } from 'drizzle-orm/pg-core';
import * as pg from 'drizzle-orm/pg-core';

export const user = pg.pgTable('user', { id: pg.text('id').primaryKey() });
export const session = pgTable('session', {
  userId: text('user_id').references(() => user.id),
});
`,
  });
  assert.deepEqual(
    out.edges.filter((e) => e.kind === 'FK_TO'),
    [],
  );
  assert.deepEqual(
    out.result.diagnostics.filter((d) => d.includes('unresolved reference')),
    ['drizzle: unresolved reference column user.id'],
  );
});

test('an enum and a schema bound behind a namespace import are the ones the columns and tables refer to', async () => {
  const out = await extract({ 'src/schema.ts': DRIZZLE_NAMESPACE_SCHEMA });
  const roleColumn = out.nodes.find((n) => n.id === 'demo:Column:public.user.role');
  assert.ok(roleColumn !== undefined);
  assert.equal(roleColumn.props['type'], 'role', 'the column has the enum type');
  assert.ok(
    out.nodes.some((n) => n.id === 'demo:Table:app.widget'),
    'appSchema.table lands in the app schema',
  );
});
