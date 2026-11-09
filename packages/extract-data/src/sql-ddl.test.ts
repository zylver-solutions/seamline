import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { SeamlineNode } from '@seamline/ontology';
import { extractData } from './extractor.ts';
import { applySqlFile } from './sql-ddl.ts';
import { SchemaModel } from './model.ts';

const SQL_BASIC = fileURLToPath(new URL('./__fixtures__/sql-basic/', import.meta.url));

async function sqlBasicNodes(): Promise<readonly SeamlineNode[]> {
  const out = await extractData({ root: SQL_BASIC, repo: 'demo', runId: 'r1', deterministic: true });
  assert.equal(out.result.status, 'PASS');
  return out.nodes;
}

function column(nodes: readonly SeamlineNode[], qualified: string): SeamlineNode {
  const found = nodes.find((n) => n.kind === 'Column' && n.id === `demo:Column:${qualified}`);
  assert.ok(found !== undefined, `column ${qualified} was not extracted`);
  return found;
}

function parse(sql: string): SchemaModel {
  const model = new SchemaModel('default', 'public', false);
  applySqlFile(model, sql, 'db/test.sql', 'sql');
  return model;
}

test('CREATE TABLE yields correct nullability for NOT NULL, PK and plain columns', async () => {
  const nodes = await sqlBasicNodes();

  // Explicit NOT NULL.
  assert.equal(column(nodes, 'app.users.email').props['nullable'], false);
  // PRIMARY KEY implies NOT NULL even though the DDL never says so.
  assert.equal(column(nodes, 'app.users.id').props['nullable'], false);
  assert.equal(column(nodes, 'app.users.id').props['isPrimaryKey'], true);
  // Neither: nullable by SQL's default, which is what X1 compares against.
  assert.equal(column(nodes, 'app.users.age').props['nullable'], true);
  assert.equal(column(nodes, 'app.users.profile').props['nullable'], true);
});

test('defaults are captured with their expression, and absence of one is recorded', async () => {
  const nodes = await sqlBasicNodes();

  assert.equal(column(nodes, 'app.users.is_active').props['hasDefault'], true);
  assert.equal(column(nodes, 'app.users.is_active').props['defaultExpr'], 'true');
  assert.equal(column(nodes, 'app.users.created_at').props['defaultExpr'], 'now()');
  assert.equal(column(nodes, 'app.organizations.id').props['defaultExpr'], 'gen_random_uuid()');
  // `bigserial` carries a sequence default the DDL does not spell out.
  assert.equal(column(nodes, 'app.users.id').props['hasDefault'], true);

  assert.equal(column(nodes, 'app.users.email').props['hasDefault'], false);
  assert.equal(column(nodes, 'app.users.email').props['defaultExpr'], null);
});

test('uniqueness comes from column, table and index level declarations', async () => {
  const nodes = await sqlBasicNodes();

  // Column-level UNIQUE.
  assert.equal(column(nodes, 'app.organizations.slug').props['isUnique'], true);
  // Table-level `CONSTRAINT ... UNIQUE (email)`.
  assert.equal(column(nodes, 'app.users.email').props['isUnique'], true);
  // Nothing declared it unique.
  assert.equal(column(nodes, 'app.users.phone_number').props['isUnique'], false);
});

test('types are normalized and length, precision and scale survive', async () => {
  const nodes = await sqlBasicNodes();

  const email = column(nodes, 'app.users.email');
  assert.equal(email.props['type'], 'character varying(255)');
  assert.equal(email.props['typeCategory'], 'text');
  assert.equal(email.props['maxLength'], 255);

  const balance = column(nodes, 'app.users.balance');
  assert.equal(balance.props['type'], 'numeric(12,2)');
  assert.equal(balance.props['numericPrecision'], 12);
  assert.equal(balance.props['numericScale'], 2);

  const role = column(nodes, 'app.users.role');
  assert.equal(role.props['typeCategory'], 'enum');

  const tags = column(nodes, 'app.users.tags');
  assert.equal(tags.props['isArray'], true);
  assert.equal(tags.props['typeCategory'], 'text');
});

test('a CHECK constraint is attributed to the single column it names', async () => {
  const nodes = await sqlBasicNodes();
  assert.equal(column(nodes, 'app.users.age').props['checkConstraint'], '(age >= 0)');
  assert.equal(column(nodes, 'app.users.age').props['checkCount'], 1);
  assert.equal(column(nodes, 'app.users.email').props['checkConstraint'], null);
});

test('a FOREIGN KEY becomes an FK_TO edge between the two column nodes', async () => {
  const out = await extractData({ root: SQL_BASIC, repo: 'demo', runId: 'r1', deterministic: true });
  const fks = out.edges.filter((e) => e.kind === 'FK_TO');
  assert.equal(fks.length, 1);
  const fk = fks[0];
  assert.ok(fk !== undefined);
  assert.equal(fk.src, 'demo:Column:app.users.org_id');
  assert.equal(fk.dst, 'demo:Column:app.organizations.id');
  assert.equal(fk.props['onDelete'], 'CASCADE');
  assert.equal(fk.provenance, 'EXTRACTED');
});

test('COMMENT ON COLUMN attaches to the column and can drive PII inference', async () => {
  const nodes = await sqlBasicNodes();
  const phone = column(nodes, 'app.users.phone_number');
  assert.equal(phone.props['comment'], 'Primary contact phone number');
  assert.equal(phone.props['pii'], 'phone');
  assert.equal(phone.props['piiProvenance'], 'INFERRED');
});

test('a table-level composite PRIMARY KEY marks every member NOT NULL but none unique', () => {
  const model = parse(`
    CREATE TABLE memberships (
      user_id bigint,
      org_id  bigint,
      PRIMARY KEY (user_id, org_id)
    );
  `);
  const t = model.table('public', 'memberships');
  assert.ok(t !== undefined);
  for (const name of ['user_id', 'org_id']) {
    const c = t.columns.get(name);
    assert.ok(c !== undefined, name);
    assert.equal(c.isPrimaryKey, true, name);
    assert.equal(c.nullable, false, name);
    assert.equal(c.isUnique, false, `${name} is not individually unique in a composite key`);
  }
});

test('GENERATED ... AS IDENTITY is NOT NULL and defaulted', () => {
  const model = parse('CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY, note text);');
  const id = model.table('public', 't')?.columns.get('id');
  assert.ok(id !== undefined);
  assert.equal(id.nullable, false);
  assert.equal(id.hasDefault, true);
});

test('a partial unique index does not make the column unique', () => {
  const model = parse(`
    CREATE TABLE t (id int, email text);
    CREATE UNIQUE INDEX t_email_idx ON t (email) WHERE id > 0;
  `);
  assert.equal(model.table('public', 't')?.columns.get('email')?.isUnique, false);
});

test('unrecognized statements are skipped rather than failing the file', () => {
  const model = parse(`
    GRANT SELECT ON t TO readonly;
    CREATE FUNCTION noise() RETURNS void AS $$ BEGIN; RAISE NOTICE 'x'; END; $$ LANGUAGE plpgsql;
    CREATE TABLE kept (id int PRIMARY KEY);
    INSERT INTO kept VALUES (1);
  `);
  assert.equal(model.tableCount(), 1);
  assert.equal(model.table('public', 'kept')?.columns.size, 1);
});

test('quoted identifiers keep their case, unquoted ones fold', () => {
  const model = parse('CREATE TABLE "MixedCase" ("Id" int PRIMARY KEY, Plain int);');
  const t = model.table('public', 'MixedCase');
  assert.ok(t !== undefined);
  assert.ok(t.columns.has('Id'));
  assert.ok(t.columns.has('plain'));
});
