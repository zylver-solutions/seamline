import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { makeNodeId } from '@seamline/core';
import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { extractData, type ExtractDataOutput } from './extractor.ts';
import { assignMigrationNames, type MigrationSource } from './migration-ids.ts';

const PREFIX = 'demo:Migration:';

/** One `CREATE TABLE` per file, named after the file's slot, so each migration is traceable by its table. */
interface Spec {
  readonly path: string;
  readonly table: string;
}

async function extractFrom(specs: readonly Spec[]): Promise<ExtractDataOutput> {
  const dir = await mkdtemp(join(tmpdir(), 'seamline-migration-ids-'));
  try {
    for (const s of specs) {
      await mkdir(dirname(join(dir, s.path)), { recursive: true });
      await writeFile(join(dir, s.path), `CREATE TABLE ${s.table} (id integer);\n`, 'utf8');
    }
    return await extractData({ root: dir, repo: 'demo', runId: 'r1', deterministic: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function migrations(out: ExtractDataOutput): SeamlineNode[] {
  return out.nodes.filter((n) => n.kind === 'Migration');
}

/** `{ path: id }` for every Migration node. */
function idByPath(out: ExtractDataOutput): Record<string, string> {
  const map: Record<string, string> = {};
  for (const n of migrations(out)) map[n.path as string] = n.id;
  return map;
}

/** The Migration node a table's MIGRATED_BY edge ends at. */
function migrationOfTable(out: ExtractDataOutput, table: string): SeamlineNode {
  const edges: SeamlineEdge[] = out.edges.filter(
    (e) => e.kind === 'MIGRATED_BY' && e.src === `demo:Table:public.${table}`,
  );
  assert.equal(edges.length, 1, `${table} should be created by exactly one migration`);
  const dst = out.nodes.find((n) => n.id === (edges[0] as SeamlineEdge).dst);
  assert.ok(dst !== undefined, `${table}'s MIGRATED_BY edge must end at an emitted node`);
  return dst;
}

/** Every emitted Migration id is one the repository's own validator accepts unchanged. */
function assertValidatorAccepts(out: ExtractDataOutput): void {
  for (const n of migrations(out)) {
    assert.equal(makeNodeId('demo', 'Migration', n.id.slice(PREFIX.length)), n.id);
  }
}

const GROUPS = ['a', 'b', 'c', 'd'] as const;

function sameVersion(groups: readonly string[]): Spec[] {
  return groups.map((g) => ({ path: `${g}/migrations/0001_init.sql`, table: `t_${g}` }));
}

for (const count of [2, 3, 4]) {
  test(`${count} migrations that share a version in different directories get ${count} distinct ids`, async () => {
    const groups = GROUPS.slice(0, count);
    const out = await extractFrom(sameVersion(groups));
    const nodes = migrations(out);
    assert.equal(nodes.length, count);
    assert.equal(
      new Set(nodes.map((n) => n.id)).size,
      count,
      `ids: ${nodes.map((n) => n.id).join(', ')}`,
    );
    for (const g of groups) {
      assert.equal(
        idByPath(out)[`${g}/migrations/0001_init.sql`],
        `${PREFIX}0001_init~${g}~migrations`,
      );
    }
    assertValidatorAccepts(out);
    // The bare id is not handed to whichever file happened to sort first.
    assert.equal(
      nodes.some((n) => n.id === `${PREFIX}0001_init`),
      false,
    );
  });
}

test('each MIGRATED_BY edge ends at the migration file that created the table', async () => {
  const out = await extractFrom(sameVersion(['a', 'b', 'c', 'd']));
  for (const g of ['a', 'b', 'c', 'd']) {
    const dst = migrationOfTable(out, `t_${g}`);
    assert.equal(dst.path, `${g}/migrations/0001_init.sql`);
    assert.equal(dst.id, `${PREFIX}0001_init~${g}~migrations`);
    const edge = out.edges.find((e) => e.kind === 'MIGRATED_BY' && e.dst === dst.id);
    assert.equal(edge?.props?.['version'], '0001_init');
  }
});

test('ids do not depend on the order files were created or listed in', async () => {
  const forward = sameVersion(['a', 'b', 'c', 'd']);
  const reversed = [...forward].reverse();
  const shuffled = [forward[2], forward[0], forward[3], forward[1]] as Spec[];
  const base = await extractFrom(forward);
  for (const order of [reversed, shuffled]) {
    const other = await extractFrom(order);
    assert.deepEqual(idByPath(other), idByPath(base));
    assert.equal(JSON.stringify(other.nodes), JSON.stringify(base.nodes));
    assert.equal(JSON.stringify(other.edges), JSON.stringify(base.edges));
  }
});

test('assignMigrationNames is a function of the set, not of the order it is given', () => {
  const sources: MigrationSource[] = [
    { path: 'a/migrations/0001_init.sql', version: '0001_init', group: 'a/migrations' },
    { path: 'b/migrations/0001_init.sql', version: '0001_init', group: 'b/migrations' },
    { path: 'c/migrations/0001_init.sql', version: '0001_init', group: 'c/migrations' },
    { path: 'a/migrations/0002_next.sql', version: '0002_next', group: 'a/migrations' },
  ];
  const expected = [...assignMigrationNames(sources).names].sort();
  const permutations = [
    [...sources].reverse(),
    [sources[2], sources[3], sources[0], sources[1]] as MigrationSource[],
  ];
  for (const p of permutations)
    assert.deepEqual([...assignMigrationNames(p).names].sort(), expected);
});

test('a version held by one file keeps its bare id, with or without collisions elsewhere', async () => {
  const single = await extractFrom([{ path: 'db/migrations/0001_init.sql', table: 'users' }]);
  assert.deepEqual(
    migrations(single).map((n) => n.id),
    [`${PREFIX}0001_init`],
  );
  assert.equal(
    single.result.diagnostics.some((d) => d.includes('collision')),
    false,
  );

  const mixed = await extractFrom([
    ...sameVersion(['a', 'b']),
    { path: 'a/migrations/0002_next.sql', table: 'later' },
  ]);
  assert.equal(idByPath(mixed)['a/migrations/0002_next.sql'], `${PREFIX}0002_next`);
  assert.ok(
    mixed.result.diagnostics.some((d) =>
      d.startsWith('migration version collision: 0001_init is declared by 2 files'),
    ),
  );
});

test('a Prisma directory and a flat file with one version in one directory are still told apart', async () => {
  const out = await extractFrom([
    { path: 'prisma/migrations/20240101_init/migration.sql', table: 'prisma_t' },
    { path: 'prisma/migrations/20240101_init.sql', table: 'flat_t' },
  ]);
  assert.equal(new Set(migrations(out).map((n) => n.id)).size, 2);
  assert.equal(
    migrationOfTable(out, 'prisma_t').path,
    'prisma/migrations/20240101_init/migration.sql',
  );
  assert.equal(migrationOfTable(out, 'flat_t').path, 'prisma/migrations/20240101_init.sql');
  assertValidatorAccepts(out);
});

test('a version outside the id alphabet gets a valid name, and two such versions stay distinct', async () => {
  const out = await extractFrom([
    { path: 'db/migrations/001 init.sql', table: 'spaced' },
    { path: 'db/migrations/001_init.sql', table: 'underscored' },
    { path: 'db/migrations/002 (copy).sql', table: 'copy_t' },
  ]);
  assert.equal(migrations(out).length, 3);
  assert.equal(new Set(migrations(out).map((n) => n.id)).size, 3);
  assertValidatorAccepts(out);
  assert.equal(migrationOfTable(out, 'copy_t').id, `${PREFIX}002__copy_`);
  assert.equal(migrationOfTable(out, 'spaced').props['version'], '001 init');
});

function src(path: string, version: string, group: string): MigrationSource {
  return { path, version, group };
}

test('tier 3 qualifies a same-directory tie by the file path, not the directory', () => {
  const out = assignMigrationNames([
    src('db/migrations/0001_init.sql', '0001_init', 'db/migrations'),
    src('db/migrations/0001_init/migration.sql', '0001_init', 'db/migrations'),
  ]);
  assert.deepEqual([...out.names].sort(), [
    ['db/migrations/0001_init.sql', '0001_init~db~migrations~0001_init.sql'],
    ['db/migrations/0001_init/migration.sql', '0001_init~db~migrations~0001_init~migration.sql'],
  ]);
});

test('tier 4 gives indistinguishable files ~1 and ~2 in sorted path order, and the index can swap on a rename', () => {
  const names = (first: string): Map<string, string> => {
    const out = assignMigrationNames([
      src(`${first}/migrations/0001_init.sql`, '0001_init', `${first}/migrations`),
      src('a_b/migrations/0001_init.sql', '0001_init', 'a_b/migrations'),
    ]);
    return new Map(out.names);
  };
  const before = names('a b');
  assert.equal(
    before.get('a b/migrations/0001_init.sql'),
    '0001_init~a_b~migrations~0001_init.sql~1',
  );
  assert.equal(
    before.get('a_b/migrations/0001_init.sql'),
    '0001_init~a_b~migrations~0001_init.sql~2',
  );
  // `a~b` sorts after `a_b`, so the two ids stay and move to the other file.
  const after = names('a~b');
  assert.equal(
    after.get('a_b/migrations/0001_init.sql'),
    '0001_init~a_b~migrations~0001_init.sql~1',
  );
  assert.equal(
    after.get('a~b/migrations/0001_init.sql'),
    '0001_init~a_b~migrations~0001_init.sql~2',
  );
});

test('a version outside the id alphabet is sanitised and reported with exact diagnostics', () => {
  const single = assignMigrationNames([
    src('db/migrations/002 (copy).sql', '002 (copy)', 'db/migrations'),
  ]);
  assert.deepEqual([...single.names], [['db/migrations/002 (copy).sql', '002__copy_']]);
  assert.deepEqual(single.diagnostics, [
    'migration version "002 (copy)" is not a valid canonical name, identified as 002__copy_',
  ]);

  const pair = assignMigrationNames([
    src('db/migrations/002 (copy).sql', '002 (copy)', 'db/migrations'),
    src('db/migrations/002_(copy).sql', '002_(copy)', 'db/migrations'),
  ]);
  assert.deepEqual(pair.diagnostics, [
    'migration version "002 (copy)" is not a valid canonical name, identified as 002__copy_',
    'migration version "002_(copy)" is not a valid canonical name, identified as 002__copy_',
    'migration version collision: 002__copy_ is declared by 2 files, qualified as 002__copy_~db~migrations~002__copy_.sql~1, 002__copy_~db~migrations~002__copy_.sql~2',
  ]);
});
