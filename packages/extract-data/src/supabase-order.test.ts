import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { extractData, type ExtractDataOutput } from './extractor.ts';

const CREATE = '20240101120000_create_events';
const TIGHTEN = '202401020001_tighten_value';

// Authored independently: the regression is mixed-width version ordering,
// not a copy of the consumer's schema or migration text.
async function fixture(t: TestContext): Promise<ExtractDataOutput> {
  const root = await mkdtemp(path.join(tmpdir(), 'seamline-supabase-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const migrations = path.join(root, 'supabase', 'migrations');
  await mkdir(migrations, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(root, 'supabase', 'config.toml'),
      'project_id = "ordering-fixture"\n[db.migrations]\nenabled = true\nschema_paths = []\n',
    ),
    writeFile(
      path.join(migrations, `${CREATE}.sql`),
      'CREATE TABLE public.events (id integer PRIMARY KEY, value text);\n',
    ),
    writeFile(
      path.join(migrations, `${TIGHTEN}.sql`),
      'ALTER TABLE public.events ALTER COLUMN value TYPE varchar(9);\n',
    ),
  ]);
  return extractData({ root, repo: 'order', runId: 'ordering', deterministic: true });
}

test('a supported Supabase group orders mixed-width versions by filename', async (t) => {
  const out = await fixture(t);
  assert.equal(out.result.status, 'PASS');
  const migrations = out.nodes.filter((node) => node.kind === 'Migration');
  assert.equal(migrations.length, 2);
  for (const migration of migrations) assert.equal(typeof migration.props['ordinal'], 'number');
  migrations.sort((a, b) => (a.props['ordinal'] as number) - (b.props['ordinal'] as number));
  assert.deepEqual(migrations.map((node) => node.id), [
    `order:Migration:${CREATE}`,
    `order:Migration:${TIGHTEN}`,
  ]);
});

test('the final schema uses the same Supabase order as the migration ordinals', async (t) => {
  const out = await fixture(t);
  assert.equal(out.result.status, 'PASS');
  const value = out.nodes.find((node) => node.id === 'order:Column:public.events.value');
  assert.ok(value !== undefined);
  assert.equal(value.props['type'], 'character varying(9)');
  assert.equal(value.props['maxLength'], 9);
});
