import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { SeamlineNode } from '@seamline/ontology';
import { extractData, type ExtractDataOutput } from './extractor.ts';
import { applyDrizzleFile, createDrizzleRegistry, resolveDrizzleRefs } from './drizzle.ts';
import { applyPrismaFile } from './prisma.ts';
import { SchemaModel } from './model.ts';

const DRIZZLE = fileURLToPath(new URL('./__fixtures__/drizzle-parity/', import.meta.url));
const PRISMA = fileURLToPath(new URL('./__fixtures__/prisma-parity/', import.meta.url));

function run(root: string): Promise<ExtractDataOutput> {
  return extractData({ root, repo: 'demo', runId: 'r1', deterministic: true });
}

/**
 * Everything about a column except which file format it came from. `path`,
 * `sourceRef` and `sourceKinds` are the only fields allowed to differ.
 */
function comparable(nodes: readonly SeamlineNode[]): unknown[] {
  return nodes
    .filter((n) => n.kind === 'Column')
    .map((n) => {
      const rest: Record<string, unknown> = { ...n.props };
      delete rest['sourceKinds'];
      return { id: n.id, name: n.name, sensitivity: n.sensitivity, provenance: n.provenance, props: rest };
    });
}

test('Drizzle and Prisma sources produce equivalent columns for an equivalent schema', async () => {
  const drizzle = await run(DRIZZLE);
  const prisma = await run(PRISMA);

  assert.equal(drizzle.result.status, 'PASS');
  assert.equal(prisma.result.status, 'PASS');

  const a = comparable(drizzle.nodes);
  const b = comparable(prisma.nodes);
  assert.equal(a.length, 11, 'the fixture must actually contain columns');
  assert.deepEqual(a, b);
});

test('Drizzle and Prisma agree on table identity and on the FK_TO edge', async () => {
  const drizzle = await run(DRIZZLE);
  const prisma = await run(PRISMA);

  const tables = (o: ExtractDataOutput): string[] =>
    o.nodes.filter((n) => n.kind === 'Table').map((n) => n.id).sort();
  assert.deepEqual(tables(drizzle), ['demo:Table:public.members', 'demo:Table:public.orgs']);
  assert.deepEqual(tables(drizzle), tables(prisma));

  const fk = (o: ExtractDataOutput): string[] =>
    o.edges.filter((e) => e.kind === 'FK_TO').map((e) => `${e.src} -> ${e.dst}`).sort();
  assert.deepEqual(fk(drizzle), ['demo:Column:public.members.org_id -> demo:Column:public.orgs.id']);
  assert.deepEqual(fk(drizzle), fk(prisma));
});

test('a relation field is not a column, but the scalar it names is', async () => {
  const prisma = await run(PRISMA);
  const memberColumns = prisma.nodes
    .filter((n) => n.kind === 'Column' && n.props['table'] === 'members')
    .map((n) => n.props['column'])
    .sort();
  // `org Org @relation(...)` must not become a column; `orgId` must.
  assert.ok(!memberColumns.includes('org'));
  assert.ok(memberColumns.includes('org_id'));
});

test('the Drizzle reader handles TypeScript-only syntax in a schema module', () => {
  const model = new SchemaModel('default', 'public', false);
  const reg = createDrizzleRegistry();
  const source = `
    import { pgEnum, pgSchema, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
    import type { Profile } from './types.ts';

    export const roleEnum = pgEnum('role', ['admin', 'member']);
    export const app = pgSchema('app');

    export const people = app.table('people', {
      id: uuid('id').primaryKey().defaultRandom(),
      role: roleEnum('role').notNull(),
      profile: jsonb('profile').$type<Profile>().notNull(),
      bio: text('bio'),
      seenAt: timestamp('seen_at', { withTimezone: true }),
    });
  `;
  const tables = applyDrizzleFile(model, reg, source, 'src/schema.ts');
  resolveDrizzleRefs(model, reg);

  assert.equal(tables, 1);
  const t = model.table('app', 'people');
  assert.ok(t !== undefined, 'pgSchema(...).table must resolve into the named schema');
  assert.equal(t.columns.get('id')?.isPrimaryKey, true);
  assert.equal(t.columns.get('id')?.hasDefault, true);
  assert.equal(t.columns.get('role')?.category, 'enum');
  // `.$type<Profile>()` must not swallow the `.notNull()` that follows it.
  assert.equal(t.columns.get('profile')?.nullable, false);
  assert.equal(t.columns.get('profile')?.category, 'json');
  assert.equal(t.columns.get('bio')?.nullable, true);
  assert.equal(t.columns.get('seen_at')?.type, 'timestamp with time zone');
});

test('a Drizzle column name defaults to the snake_case of its object key', () => {
  const model = new SchemaModel('default', 'public', false);
  const reg = createDrizzleRegistry();
  applyDrizzleFile(
    model,
    reg,
    `export const t = pgTable('t', { createdAt: timestamp(), userId: uuid().notNull() });`,
    'src/schema.ts',
  );
  const t = model.table('public', 't');
  assert.ok(t !== undefined);
  assert.deepEqual([...t.columns.keys()].sort(), ['created_at', 'user_id']);
});

test('a Drizzle composite primary key marks every member and none unique', () => {
  const model = new SchemaModel('default', 'public', false);
  const reg = createDrizzleRegistry();
  applyDrizzleFile(
    model,
    reg,
    `export const memberships = pgTable('memberships', {
       userId: uuid('user_id'),
       orgId: uuid('org_id'),
     }, (t) => ({ pk: primaryKey({ columns: [t.userId, t.orgId] }) }));`,
    'src/schema.ts',
  );
  const t = model.table('public', 'memberships');
  assert.ok(t !== undefined);
  for (const name of ['user_id', 'org_id']) {
    assert.equal(t.columns.get(name)?.isPrimaryKey, true, name);
    assert.equal(t.columns.get(name)?.nullable, false, name);
    assert.equal(t.columns.get(name)?.isUnique, false, name);
  }
});

test('a Prisma composite key and block-level unique reach the physical columns', () => {
  const model = new SchemaModel('default', 'public', false);
  applyPrismaFile(
    model,
    `model Membership {
       userId String @map("user_id") @db.Uuid
       orgId  String @map("org_id") @db.Uuid
       slug   String @db.VarChar(32)

       @@id([userId, orgId])
       @@unique([slug])
       @@map("memberships")
     }`,
    'prisma/schema.prisma',
  );
  const t = model.table('public', 'memberships');
  assert.ok(t !== undefined);
  assert.equal(t.columns.get('user_id')?.isPrimaryKey, true);
  assert.equal(t.columns.get('org_id')?.nullable, false);
  assert.equal(t.columns.get('slug')?.isUnique, true);
});

test('a Prisma enum is categorized as enum in the same vocabulary as SQL', () => {
  const model = new SchemaModel('default', 'public', false);
  applyPrismaFile(
    model,
    `enum Role { ADMIN MEMBER }

     model User {
       id   String @id @db.Uuid
       role Role
     }`,
    'prisma/schema.prisma',
  );
  assert.equal(model.table('public', 'User')?.columns.get('role')?.category, 'enum');
});
