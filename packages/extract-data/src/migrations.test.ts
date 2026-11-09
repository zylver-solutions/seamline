import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { SeamlineNode } from '@seamline/ontology';
import { extractData, type ExtractDataOutput } from './extractor.ts';
import { migrationIdentity, versionOrdinalKey } from './discover.ts';

const MIGRATIONS = fileURLToPath(new URL('./__fixtures__/sql-migrations/', import.meta.url));

function run(): Promise<ExtractDataOutput> {
  return extractData({ root: MIGRATIONS, repo: 'demo', runId: 'r1', deterministic: true });
}

function node(out: ExtractDataOutput, id: string): SeamlineNode {
  const found = out.nodes.find((n) => n.id === id);
  assert.ok(found !== undefined, `${id} was not emitted`);
  return found;
}

test('migrations are ordered numerically, not lexically', () => {
  assert.ok(versionOrdinalKey('2_add_phone') < versionOrdinalKey('10_tighten'));
  assert.equal(versionOrdinalKey('0001_init'), 1);
  assert.equal(versionOrdinalKey('V3__flyway'), 3);
  // A version with no numeric prefix sorts last rather than throwing.
  assert.equal(versionOrdinalKey('baseline'), Number.MAX_SAFE_INTEGER);
});

test('a migration version is derived path-free from its file or directory', () => {
  assert.deepEqual(migrationIdentity('db/migrations/0001_init.sql'), {
    version: '0001_init',
    group: 'db/migrations',
  });
  // Prisma puts the version on the directory.
  assert.deepEqual(migrationIdentity('prisma/migrations/20240101120000_init/migration.sql'), {
    version: '20240101120000_init',
    group: 'prisma/migrations',
  });
  // A plain schema file is not a migration.
  assert.equal(migrationIdentity('db/schema.sql'), null);
});

test('Migration nodes carry their applied order', async () => {
  const out = await run();
  const migrations = out.nodes.filter((n) => n.kind === 'Migration');
  assert.equal(migrations.length, 3);
  const byOrdinal = [...migrations].sort((a, b) => (a.props['ordinal'] as number) - (b.props['ordinal'] as number));
  assert.deepEqual(
    byOrdinal.map((m) => m.props['version']),
    ['1_init', '2_add_phone', '10_tighten'],
  );
  assert.deepEqual(
    byOrdinal.map((m) => m.props['ordinal']),
    [0, 1, 2],
  );
  assert.equal(node(out, 'demo:Migration:10_tighten').props['statementCount'], 4);
});

test('ALTER TABLE ADD COLUMN applied in migration order yields the final state', async () => {
  const out = await run();

  // Added in `2_add_phone` as `text`, then re-typed and tightened in
  // `10_tighten`. Lexical ordering would run 10 before 2 and leave `text`.
  const phone = node(out, 'demo:Column:public.accounts.phone');
  assert.equal(phone.props['type'], 'character varying(32)');
  assert.equal(phone.props['maxLength'], 32);
  assert.equal(phone.props['nullable'], false);

  // Added in `2_add_phone`, never altered.
  const ip = node(out, 'demo:Column:public.accounts.signup_ip');
  assert.equal(ip.props['type'], 'inet');
  assert.equal(ip.props['nullable'], true);

  // Created in `1_init`, made UNIQUE in `10_tighten`.
  const email = node(out, 'demo:Column:public.accounts.email');
  assert.equal(email.props['isUnique'], true);
  assert.equal(email.props['nullable'], false);

  // Dropped in `10_tighten`: it is not part of the final state.
  assert.equal(
    out.nodes.some((n) => n.id === 'demo:Column:public.accounts.nickname'),
    false,
  );

  const columns = out.nodes.filter((n) => n.kind === 'Column').map((n) => n.props['column']);
  assert.deepEqual([...columns].sort(), ['email', 'id', 'phone', 'signup_ip']);
});

test('MIGRATED_BY records every migration that touched a table or column', async () => {
  const out = await run();
  const edgesFrom = (src: string): string[] =>
    out.edges
      .filter((e) => e.kind === 'MIGRATED_BY' && e.src === src)
      .map((e) => e.dst)
      .sort();

  assert.deepEqual(edgesFrom('demo:Table:public.accounts'), [
    'demo:Migration:10_tighten',
    'demo:Migration:1_init',
    'demo:Migration:2_add_phone',
  ]);
  // `phone` was introduced by one migration and altered by another.
  assert.deepEqual(edgesFrom('demo:Column:public.accounts.phone'), [
    'demo:Migration:10_tighten',
    'demo:Migration:2_add_phone',
  ]);
  // `signup_ip` was only ever touched by the migration that added it.
  assert.deepEqual(edgesFrom('demo:Column:public.accounts.signup_ip'), ['demo:Migration:2_add_phone']);
});

test('a Migration node is identified by version, never by path', async () => {
  const out = await run();
  const m = node(out, 'demo:Migration:1_init');
  assert.equal(m.path, 'db/migrations/1_init.sql');
  assert.ok(!m.id.includes('/'), 'a path must never appear in an id');
  assert.ok(!m.id.includes('.sql'));
});
