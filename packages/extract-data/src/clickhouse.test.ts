import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import type { SeamlineNode } from '@seamline/ontology';
import {
  hasClickHouseTypeEvidence,
  isClickHouseEngine,
  normalizeClickHouseType,
} from './clickhouse.ts';
import { canonicalSif } from './emit.ts';
import { extractData } from './extractor.ts';
import { SchemaModel, type ColumnFact } from './model.ts';
import { applySqlFile } from './sql-ddl.ts';

function parse(sql: string, options: { clickhouse?: boolean } = {}): SchemaModel {
  const model = new SchemaModel('default', 'public', false);
  applySqlFile(model, sql, 'db/test.sql', 'sql', options);
  return model;
}

function col(model: SchemaModel, qualified: string): ColumnFact {
  const [schema, table, column] = qualified.split('.');
  const found = model.table(schema as string, table as string)?.columns.get(column as string);
  assert.ok(found !== undefined, `column ${qualified} was not extracted`);
  return found;
}

function tableDialect(model: SchemaModel, schema: string, table: string): string | null {
  const t = model.table(schema, table);
  assert.ok(t !== undefined, `table ${schema}.${table} was not extracted`);
  return t.dialect;
}

/* ------------------------------------------------------------------ *
 * Type normalization
 * ------------------------------------------------------------------ */

interface TypeCase {
  readonly raw: string;
  readonly nullable: boolean;
  readonly type: string;
  readonly category: string;
  readonly isArray?: boolean;
}

const TYPE_CASES: readonly TypeCase[] = [
  // Nullability comes only from Nullable(...), bare or under LowCardinality.
  { raw: 'String', nullable: false, type: 'text', category: 'text' },
  { raw: 'Nullable(String)', nullable: true, type: 'text', category: 'text' },
  { raw: 'LowCardinality(String)', nullable: false, type: 'text', category: 'text' },
  { raw: 'LowCardinality(Nullable(String))', nullable: true, type: 'text', category: 'text' },
  { raw: 'UUID', nullable: false, type: 'uuid', category: 'uuid' },
  { raw: 'Nullable(UUID)', nullable: true, type: 'uuid', category: 'uuid' },
  // Dates and times.
  {
    raw: 'DateTime64(3)',
    nullable: false,
    type: 'timestamp without time zone',
    category: 'timestamp',
  },
  {
    raw: "DateTime64(6, 'UTC')",
    nullable: false,
    type: 'timestamp with time zone',
    category: 'timestamp',
  },
  {
    raw: "DateTime('UTC')",
    nullable: false,
    type: 'timestamp with time zone',
    category: 'timestamp',
  },
  {
    raw: "Datetime('UTC')",
    nullable: false,
    type: 'timestamp with time zone',
    category: 'timestamp',
  },
  { raw: 'DateTime', nullable: false, type: 'timestamp without time zone', category: 'timestamp' },
  {
    raw: "Nullable(DateTime('UTC'))",
    nullable: true,
    type: 'timestamp with time zone',
    category: 'timestamp',
  },
  { raw: 'Date32', nullable: false, type: 'date', category: 'timestamp' },
  // Numbers.
  { raw: 'UInt8', nullable: false, type: 'smallint', category: 'integer' },
  { raw: 'UInt32', nullable: false, type: 'integer', category: 'integer' },
  { raw: 'Int64', nullable: false, type: 'bigint', category: 'integer' },
  { raw: 'Nullable(Int32)', nullable: true, type: 'integer', category: 'integer' },
  { raw: 'Float32', nullable: false, type: 'real', category: 'numeric' },
  { raw: 'Float64', nullable: false, type: 'double precision', category: 'numeric' },
  { raw: 'Decimal(10, 1)', nullable: false, type: 'numeric(10,1)', category: 'numeric' },
  { raw: 'Decimal64(4)', nullable: false, type: 'numeric(18,4)', category: 'numeric' },
  { raw: 'Nullable(Decimal(22, 4))', nullable: true, type: 'numeric(22,4)', category: 'numeric' },
  { raw: 'Bool', nullable: false, type: 'boolean', category: 'boolean' },
  // Containers: Array(Nullable(T)) is not itself nullable.
  { raw: 'Array(String)', nullable: false, type: 'text[]', category: 'text', isArray: true },
  {
    raw: 'Array(Nullable(String))',
    nullable: false,
    type: 'text[]',
    category: 'text',
    isArray: true,
  },
  {
    raw: 'Array(Array(UInt8))',
    nullable: false,
    type: 'smallint[]',
    category: 'integer',
    isArray: true,
  },
  { raw: "Enum8('a' = 1, 'b, (c)' = 2)", nullable: false, type: 'enum', category: 'enum' },
  { raw: 'FixedString(16)', nullable: false, type: 'character(16)', category: 'text' },
  { raw: 'JSON', nullable: false, type: 'json', category: 'json' },
  // Types no comparison may treat as a scalar: the category abstains.
  {
    raw: 'AggregateFunction(groupArray, String)',
    nullable: false,
    type: 'aggregatefunction',
    category: 'other',
  },
  {
    raw: "AggregateFunction(argMin, String, DateTime('UTC'))",
    nullable: false,
    type: 'aggregatefunction',
    category: 'other',
  },
  {
    raw: 'SimpleAggregateFunction(sum, UInt64)',
    nullable: false,
    type: 'simpleaggregatefunction',
    category: 'other',
  },
  {
    raw: 'SimpleAggregateFunction(groupArrayArray, Array(String))',
    nullable: false,
    type: 'simpleaggregatefunction',
    category: 'other',
  },
  { raw: 'Map(String, UInt64)', nullable: false, type: 'map', category: 'other' },
  { raw: 'Tuple(String, UInt8)', nullable: false, type: 'tuple', category: 'other' },
  { raw: 'IPv4', nullable: false, type: 'inet', category: 'other' },
  { raw: 'SomeFutureType(1)', nullable: false, type: 'somefuturetype', category: 'other' },
];

for (const c of TYPE_CASES) {
  test(`ClickHouse type ${c.raw} normalizes to ${c.type} (${c.category}), nullable=${String(c.nullable)}`, () => {
    const n = normalizeClickHouseType(c.raw);
    assert.equal(n.nullable, c.nullable);
    assert.equal(n.type, c.type);
    assert.equal(n.category, c.category);
    assert.equal(n.isArray, c.isArray ?? false);
  });
}

test('ClickHouse type parameters survive: FixedString length and Decimal precision and scale', () => {
  assert.equal(normalizeClickHouseType('FixedString(16)').maxLength, 16);
  const d = normalizeClickHouseType('Nullable(Decimal(22, 4))');
  assert.equal(d.numericPrecision, 22);
  assert.equal(d.numericScale, 4);
  assert.equal(normalizeClickHouseType('Decimal32(2)').numericPrecision, 9);
  assert.equal(
    normalizeClickHouseType('LowCardinality(Nullable(String))').declaredType,
    'lowcardinality(nullable(string))',
  );
});

test('an unbalanced or unparseable type abstains rather than guessing', () => {
  assert.equal(normalizeClickHouseType('Nullable(String').category, 'other');
  assert.equal(normalizeClickHouseType('').category, 'other');
});

/* ------------------------------------------------------------------ *
 * Dialect evidence
 * ------------------------------------------------------------------ */

test('ClickHouse engines are recognised by exact spelling, MySQL storage engines are not', () => {
  for (const e of [
    'MergeTree',
    'ReplacingMergeTree',
    'ReplicatedAggregatingMergeTree',
    'Memory',
    'Distributed',
    'TinyLog',
  ]) {
    assert.equal(isClickHouseEngine(e), true, e);
  }
  for (const e of ['InnoDB', 'MyISAM', 'MEMORY', 'memory', 'mergetree']) {
    assert.equal(isClickHouseEngine(e), false, e);
  }
});

test('type spellings that exist only in ClickHouse count as evidence; shared ones do not', () => {
  for (const t of [
    'Nullable(String)',
    'LowCardinality(String)',
    'AggregateFunction(max, DateTime)',
    'SimpleAggregateFunction(sum, UInt64)',
    'DateTime64(3)',
    "DateTime('UTC')",
    'UInt32',
    'Float64',
    'Array(String)',
    'Array(Nullable(UUID))',
    "Enum8('x' = 1)",
    'Decimal64(4)',
  ]) {
    assert.equal(hasClickHouseTypeEvidence(t), true, t);
  }
  for (const t of [
    'UUID',
    'String',
    'uuid',
    'text',
    'int8',
    'int',
    'bigint',
    'timestamp',
    'DATETIME',
    'DATETIME(6)',
    'numeric(10,2)',
    'uuid[]',
    'text[]',
    'ARRAY',
    "enum('Nullable(x)')",
  ]) {
    assert.equal(hasClickHouseTypeEvidence(t), false, t);
  }
});

/* ------------------------------------------------------------------ *
 * CREATE TABLE: ClickHouse rules apply only with ClickHouse evidence
 * ------------------------------------------------------------------ */

test('a ClickHouse column without Nullable is NOT NULL (regression: the standard-SQL default made it nullable)', () => {
  const m = parse(`
CREATE TABLE umami.website_event
(
    website_id UUID,
    session_id UUID,
    event_id UUID,
    hostname LowCardinality(String),
    city String,
    lcp Nullable(Decimal(10, 1)),
    job_id Nullable(UUID),
    created_at DateTime('UTC')
)
ENGINE = MergeTree
    ORDER BY (website_id, session_id, created_at);
`);
  assert.equal(tableDialect(m, 'umami', 'website_event'), 'clickhouse');
  for (const c of ['website_id', 'session_id', 'event_id', 'hostname', 'city', 'created_at']) {
    assert.equal(col(m, `umami.website_event.${c}`).nullable, false, `${c} is NOT NULL`);
  }
  assert.equal(col(m, 'umami.website_event.lcp').nullable, true);
  assert.equal(col(m, 'umami.website_event.job_id').nullable, true);
  assert.equal(col(m, 'umami.website_event.session_id').dialect, 'clickhouse');
  assert.equal(col(m, 'umami.website_event.session_id').type, 'uuid');
});

test('the same DDL with no ClickHouse evidence keeps the standard-SQL default', () => {
  const m = parse(`
CREATE TABLE app.events
(
    session_id UUID,
    city String
);
`);
  assert.equal(tableDialect(m, 'app', 'events'), null);
  assert.equal(col(m, 'app.events.session_id').nullable, true);
  assert.equal(col(m, 'app.events.session_id').dialect, null);
  assert.equal(col(m, 'app.events.city').nullable, true);
});

test('each kind of evidence on its own makes a statement ClickHouse', () => {
  const byEngine = parse(`CREATE TABLE t (a UUID) ENGINE = Memory;`);
  assert.equal(col(byEngine, 'public.t.a').nullable, false);

  const byCluster = parse(`CREATE TABLE t ON CLUSTER main (a UUID) ENGINE = SomeFutureEngine;`);
  assert.equal(tableDialect(byCluster, 'public', 't'), 'clickhouse');
  assert.equal(col(byCluster, 'public.t.a').nullable, false);

  const byType = parse(`CREATE TABLE t (a UUID, n UInt32);`);
  assert.equal(tableDialect(byType, 'public', 't'), 'clickhouse');
  assert.equal(col(byType, 'public.t.a').nullable, false);

  const byArray = parse(`CREATE TABLE t (a UUID, tags Array(String));`);
  assert.equal(col(byArray, 'public.t.a').nullable, false);

  const byDateTimeZone = parse(`CREATE TABLE t (a UUID, at DateTime('UTC'));`);
  assert.equal(col(byDateTimeZone, 'public.t.a').nullable, false);
});

test('an ENGINE that names a MySQL storage engine rules ClickHouse out', () => {
  const m = parse(`CREATE TABLE t (a UUID, b UInt32) ENGINE=InnoDB DEFAULT CHARSET=utf8;`);
  assert.equal(tableDialect(m, 'public', 't'), null);
  assert.equal(col(m, 'public.t.a').nullable, true);
  const upper = parse(`CREATE TABLE t (a int) ENGINE=MEMORY;`);
  assert.equal(col(upper, 'public.t.a').nullable, true);
});

test('Postgres, MySQL and SQLite DDL is read exactly as before', () => {
  const m = parse(`
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  org_id uuid,
  email text NOT NULL,
  big int8,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT,
  at DATETIME
);
CREATE TABLE orders (
  id bigint unsigned NOT NULL,
  note varchar(40)
) ENGINE=InnoDB;
`);
  assert.equal(col(m, 'public.users.id').nullable, false);
  assert.equal(col(m, 'public.users.org_id').nullable, true);
  assert.equal(col(m, 'public.users.email').nullable, false);
  assert.equal(col(m, 'public.users.big').nullable, true);
  assert.equal(col(m, 'public.users.created_at').hasDefault, true);
  assert.equal(col(m, 'public.audit_log.actor').nullable, true);
  assert.equal(col(m, 'public.orders.note').nullable, true);
  for (const t of ['users', 'audit_log', 'orders'])
    assert.equal(tableDialect(m, 'public', t), null);
  for (const c of ['users.org_id', 'audit_log.actor', 'orders.note']) {
    assert.equal(col(m, `public.${c}`).dialect, null);
  }
});

test('INDEX and PROJECTION entries in a ClickHouse column list are not columns', () => {
  const m = parse(`
CREATE TABLE t
(
    session_id UUID,
    distinct_id String,
    INDEX idx_session_id session_id TYPE bloom_filter GRANULARITY 1,
    PROJECTION p_by_id (SELECT * ORDER BY distinct_id)
)
ENGINE = ReplacingMergeTree ORDER BY (session_id);
`);
  assert.deepEqual([...(m.table('public', 't')?.columns.keys() ?? [])].sort(), [
    'distinct_id',
    'session_id',
  ]);
});

test('a column named index in a ClickHouse table is still a column', () => {
  const m = parse(`CREATE TABLE t (index UInt32, other String) ENGINE = MergeTree ORDER BY index;`);
  assert.equal(col(m, 'public.t.index').nullable, false);
});

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

test('DEFAULT, MATERIALIZED, ALIAS and EPHEMERAL columns are defaulted and not required on insert', () => {
  const m = parse(`
CREATE TABLE t
(
    id UUID,
    plain String,
    nullable_plain Nullable(String),
    d DateTime64(6) DEFAULT now64(6),
    m UInt32 MATERIALIZED length(plain),
    a String ALIAS concat(plain, '!'),
    e String EPHEMERAL,
    n Nullable(String) DEFAULT NULL,
    c String CODEC(ZSTD(3)) COMMENT 'payload',
    z UInt8 DEFAULT 1 COMMENT 'flag'
)
ENGINE = MergeTree ORDER BY id;
`);
  // No default of its own: an omitted value is stored as the type's default.
  assert.equal(col(m, 'public.t.plain').hasDefault, true);
  assert.equal(col(m, 'public.t.plain').defaultExpr, 'type default');
  // A nullable column with no default stays "no default", as everywhere else.
  assert.equal(col(m, 'public.t.nullable_plain').hasDefault, false);
  assert.equal(col(m, 'public.t.nullable_plain').defaultExpr, null);

  assert.equal(col(m, 'public.t.d').hasDefault, true);
  assert.equal(col(m, 'public.t.d').defaultExpr, 'now64(6)');
  assert.equal(col(m, 'public.t.m').defaultExpr, 'length(plain)');
  assert.equal(col(m, 'public.t.a').defaultExpr, "concat(plain, '!')");
  assert.equal(col(m, 'public.t.e').hasDefault, true);
  assert.equal(col(m, 'public.t.n').defaultExpr, 'NULL');
  assert.equal(col(m, 'public.t.n').nullable, true);
  assert.equal(col(m, 'public.t.c').comment, 'payload');
  assert.equal(col(m, 'public.t.c').defaultExpr, 'type default');
  assert.equal(col(m, 'public.t.z').defaultExpr, '1');
  assert.equal(col(m, 'public.t.z').comment, 'flag');
});

test('an explicit NULL modifier makes a ClickHouse column nullable', () => {
  const m = parse(`CREATE TABLE t (a String NULL, b String NOT NULL, c String) ENGINE = Memory;`);
  assert.equal(col(m, 'public.t.a').nullable, true);
  assert.equal(col(m, 'public.t.b').nullable, false);
  assert.equal(col(m, 'public.t.c').nullable, false);
});

test('a ClickHouse column that declares no type is not extracted rather than guessed', () => {
  const model = new SchemaModel('default', 'public', false);
  applySqlFile(
    model,
    `CREATE TABLE t (id UUID, doubled ALIAS id, name String) ENGINE = Memory;`,
    'db/t.sql',
    'sql',
  );
  assert.deepEqual([...(model.table('public', 't')?.columns.keys() ?? [])].sort(), ['id', 'name']);
  assert.ok(model.diagnostics.some((d) => d.includes('public.t.doubled declares no type')));
});

/* ------------------------------------------------------------------ *
 * ALTER TABLE
 * ------------------------------------------------------------------ */

test('ALTER TABLE on a table known to be ClickHouse is read as ClickHouse', () => {
  const m = parse(`
CREATE TABLE umami.website_event (website_id UUID, tag Nullable(String)) ENGINE = MergeTree ORDER BY website_id;
ALTER TABLE umami.website_event ADD COLUMN distinct_id String AFTER tag;
ALTER TABLE umami.website_event ADD COLUMN perf Nullable(Decimal(10, 1)) AFTER distinct_id;
ALTER TABLE umami.website_event ADD COLUMN visits UInt64 DEFAULT 0 AFTER perf;
`);
  assert.equal(col(m, 'umami.website_event.distinct_id').nullable, false);
  assert.equal(col(m, 'umami.website_event.distinct_id').hasDefault, true);
  assert.equal(col(m, 'umami.website_event.perf').nullable, true);
  assert.equal(col(m, 'umami.website_event.visits').defaultExpr, '0');
});

test('ALTER TABLE on a table with no ClickHouse evidence keeps the standard-SQL default', () => {
  const m = parse(`
ALTER TABLE "event_data" ADD COLUMN "job_id" UUID AFTER "created_at";
ALTER TABLE app.users ADD COLUMN nick text;
`);
  assert.equal(col(m, 'public.event_data.job_id').nullable, true);
  assert.equal(col(m, 'public.event_data.job_id').dialect, null);
  assert.equal(col(m, 'app.users.nick').nullable, true);
});

test('a ClickHouse-only column type in an ALTER establishes the table as ClickHouse for later statements', () => {
  const m = parse(`
ALTER TABLE web.hits ADD COLUMN ua LowCardinality(String);
ALTER TABLE web.hits ADD COLUMN path String;
`);
  assert.equal(tableDialect(m, 'web', 'hits'), 'clickhouse');
  assert.equal(col(m, 'web.hits.ua').nullable, false);
  assert.equal(col(m, 'web.hits.path').nullable, false);
});

test('ALTER TABLE ... ON CLUSTER is parsed, and reads as ClickHouse', () => {
  const m = parse(
    `ALTER TABLE web.hits ON CLUSTER main ADD COLUMN path String, ADD COLUMN ref Nullable(String);`,
  );
  assert.equal(col(m, 'web.hits.path').nullable, false);
  assert.equal(col(m, 'web.hits.ref').nullable, true);
});

test('MODIFY COLUMN restates nullability and keeps an explicit default', () => {
  const m = parse(`
CREATE TABLE t (id UUID, a String, b Nullable(String), c UInt8 DEFAULT 5) ENGINE = MergeTree ORDER BY id;
ALTER TABLE t MODIFY COLUMN a Nullable(String);
ALTER TABLE t MODIFY COLUMN b String;
ALTER TABLE t MODIFY COLUMN c UInt16;
`);
  assert.equal(col(m, 'public.t.a').nullable, true);
  assert.equal(col(m, 'public.t.a').hasDefault, false);
  assert.equal(col(m, 'public.t.b').nullable, false);
  assert.equal(col(m, 'public.t.b').hasDefault, true);
  assert.equal(col(m, 'public.t.c').type, 'smallint');
  assert.equal(col(m, 'public.t.c').defaultExpr, '5');
});

test('ADD PROJECTION and ADD INDEX create no column, but still record the migration that altered the table', () => {
  const model = new SchemaModel('default', 'public', false);
  applySqlFile(
    model,
    `CREATE TABLE t (id UUID, url String) ENGINE = MergeTree ORDER BY id;`,
    'db/schema.sql',
    'sql',
  );
  model.currentMigration = '14_add_projections';
  applySqlFile(
    model,
    `
ALTER TABLE t ADD PROJECTION p (SELECT * ORDER BY url);
ALTER TABLE t ADD INDEX idx url TYPE bloom_filter GRANULARITY 1;
ALTER TABLE t MATERIALIZE PROJECTION p;
`,
    'db/migrations/14_add_projections.sql',
    'sql-migration',
  );
  const t = model.table('public', 't');
  assert.deepEqual([...(t?.columns.keys() ?? [])].sort(), ['id', 'url']);
  assert.deepEqual(t?.migrations, ['14_add_projections']);
});

test('a later CREATE TABLE without evidence stops the table being treated as ClickHouse', () => {
  const m = parse(`
CREATE TABLE t (a UUID) ENGINE = MergeTree ORDER BY a;
CREATE TABLE t (a uuid, b text);
ALTER TABLE t ADD COLUMN c text;
`);
  assert.equal(tableDialect(m, 'public', 't'), null);
  assert.equal(col(m, 'public.t.a').nullable, true);
  assert.equal(col(m, 'public.t.c').nullable, true);
});

/* ------------------------------------------------------------------ *
 * Whole-extractor behaviour
 * ------------------------------------------------------------------ */

const CLICKHOUSE_SCHEMA = `CREATE TABLE umami.website_event
(
    session_id UUID,
    referrer Nullable(String),
    hits SimpleAggregateFunction(sum, UInt64),
    created_at DateTime64(3)
)
ENGINE = MergeTree
    ORDER BY (session_id, created_at);
`;

const POSTGRES_SCHEMA = `CREATE TABLE public.sessions (
    id uuid PRIMARY KEY,
    org_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);
`;

async function writeTree(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const rel of Object.keys(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, files[rel] as string, 'utf8');
  }
}

function props(nodes: readonly SeamlineNode[], id: string): SeamlineNode['props'] {
  const n = nodes.find((x) => x.id === id);
  assert.ok(n !== undefined, `${id} was not emitted`);
  return n.props;
}

test('a Postgres file in the same repository is unaffected by a ClickHouse file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seamline-ch-mixed-'));
  try {
    await writeTree(root, {
      'db/clickhouse/schema.sql': CLICKHOUSE_SCHEMA,
      'db/postgres/schema.sql': POSTGRES_SCHEMA,
    });
    const out = await extractData({ root, repo: 'demo', runId: 'r1', deterministic: true });
    assert.equal(out.result.status, 'PASS');

    const orgId = props(out.nodes, 'demo:Column:public.sessions.org_id');
    assert.equal(orgId['nullable'], true);
    assert.equal(orgId['dialect'], 'postgres');
    assert.equal(props(out.nodes, 'demo:Column:public.sessions.id')['nullable'], false);
    assert.equal(props(out.nodes, 'demo:Table:public.sessions')['dialect'], 'postgres');

    const sessionId = props(out.nodes, 'demo:Column:umami.website_event.session_id');
    assert.equal(sessionId['nullable'], false);
    assert.equal(sessionId['dialect'], 'clickhouse');
    assert.equal(sessionId['typeCategory'], 'uuid');
    assert.equal(props(out.nodes, 'demo:Table:umami.website_event')['dialect'], 'clickhouse');
    assert.equal(props(out.nodes, 'demo:Column:umami.website_event.referrer')['nullable'], true);
    // Opaque and aggregate types abstain from type comparison.
    assert.equal(props(out.nodes, 'demo:Column:umami.website_event.hits')['typeCategory'], 'other');
    assert.equal(
      props(out.nodes, 'demo:Column:umami.website_event.hits')['type'],
      'simpleaggregatefunction',
    );
    assert.equal(
      props(out.nodes, 'demo:Column:umami.website_event.created_at')['typeCategory'],
      'timestamp',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the configured clickhouse dialect reads every statement under ClickHouse rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seamline-ch-configured-'));
  try {
    await writeTree(root, {
      'db/schema.sql': `CREATE TABLE events (session_id UUID, note String);\n`,
    });
    const plain = await extractData({ root, repo: 'demo', runId: 'r1', deterministic: true });
    assert.equal(props(plain.nodes, 'demo:Column:public.events.session_id')['nullable'], true);

    const configured = await extractData({
      root,
      repo: 'demo',
      runId: 'r1',
      deterministic: true,
      dialect: 'ClickHouse',
    });
    const p = props(configured.nodes, 'demo:Column:public.events.session_id');
    assert.equal(p['nullable'], false);
    assert.equal(p['dialect'], 'clickhouse');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ClickHouse extraction is byte-reproducible and independent of where the file lives', async () => {
  const a = await mkdtemp(join(tmpdir(), 'seamline-ch-det-a-'));
  const b = await mkdtemp(join(tmpdir(), 'seamline-ch-det-b-'));
  try {
    const migration = `ALTER TABLE umami.website_event ADD COLUMN distinct_id String AFTER referrer;\n`;
    await writeTree(a, {
      'db/clickhouse/schema.sql': CLICKHOUSE_SCHEMA,
      'db/clickhouse/migrations/01_add_distinct_id.sql': migration,
      'db/postgres/schema.sql': POSTGRES_SCHEMA,
    });
    await writeTree(b, {
      'storage/ch/schema.sql': CLICKHOUSE_SCHEMA,
      'storage/ch/migrations/01_add_distinct_id.sql': migration,
      'storage/pg/schema.sql': POSTGRES_SCHEMA,
    });
    const first = await extractData({ root: a, repo: 'demo', runId: 'r1', deterministic: true });
    const second = await extractData({ root: a, repo: 'demo', runId: 'r1', deterministic: true });
    assert.equal(canonicalSif(first.nodes, first.edges), canonicalSif(second.nodes, second.edges));

    const moved = await extractData({ root: b, repo: 'demo', runId: 'r1', deterministic: true });
    assert.deepEqual(
      moved.nodes.map((n) => n.id),
      first.nodes.map((n) => n.id),
      'moving the files changes no id',
    );
    const facts = (nodes: readonly SeamlineNode[]): unknown[] =>
      nodes
        .filter((n) => n.kind === 'Column')
        .map((n) => [n.id, n.props['nullable'], n.props['dialect'], n.props['type']]);
    assert.deepEqual(facts(moved.nodes), facts(first.nodes));
    assert.equal(
      props(first.nodes, 'demo:Column:umami.website_event.distinct_id')['nullable'],
      false,
    );
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});
