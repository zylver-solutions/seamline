import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { discoverSources } from './discover.ts';
import { extractData } from './extractor.ts';

const CONFIG = 'project_id = "fixture"\n[db.migrations]\nenabled = true\nschema_paths = []\n';
const CREATE = 'CREATE TABLE public.events (id integer PRIMARY KEY, value text);\n';
const ALTER = 'ALTER TABLE public.events ALTER COLUMN value TYPE varchar(9);\n';

async function tree(t: TestContext, files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'seamline-migration-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({ 'supabase/config.toml': CONFIG, ...files })) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return root;
}

async function order(root: string) {
  const found = await discoverSources({ root });
  assert.equal(found.migrationOrders.length, 1);
  const result = found.migrationOrders[0];
  assert.ok(result !== undefined);
  return result;
}

test('only files accepted by the supported reader contribute migrations or schema', async (t) => {
  const root = await tree(t, {
    'supabase/migrations/20240101000000_create.sql': CREATE,
    'supabase/migrations/notes.sql': 'CREATE TABLE public.not_a_migration (id integer);',
    'supabase/migrations/20240102000000_upper.SQL': 'CREATE TABLE public.wrong_case (id integer);',
  });
  assert.equal((await order(root)).state, 'known');
  const out = await extractData({ root, repo: 'order', runId: 'r', deterministic: true });
  assert.equal(out.result.status, 'PASS');
  assert.deepEqual(out.nodes.filter((n) => n.kind === 'Table').map((n) => n.id), ['order:Table:public.events']);
  assert.deepEqual(out.nodes.filter((n) => n.kind === 'Migration').map((n) => n.name), ['20240101000000_create']);
});

test('legacy init exclusion uses the first directory entry, not the first SQL file', async (t) => {
  const root = await tree(t, {
    'supabase/migrations/20200101000000_init.sql': 'CREATE TABLE public.legacy (id integer);',
    'supabase/migrations/20240101000000_create.sql': CREATE,
  });
  const run = () => extractData({ root, repo: 'order', runId: 'r', deterministic: true });
  assert.equal((await run()).nodes.some((n) => n.id === 'order:Table:public.legacy'), false);
  await writeFile(path.join(root, 'supabase/migrations/.keep'), '');
  assert.equal((await run()).nodes.some((n) => n.id === 'order:Table:public.legacy'), true);
});

for (const name of ['00020211208000000_init.sql', '20211208000000_init.sql_backup.sql']) {
  test(`legacy init matching retains the supported reader's substring rule: ${name}`, async (t) => {
    const root = await tree(t, {
      [`supabase/migrations/${name}`]: 'CREATE TABLE public.legacy (id integer);',
      'supabase/migrations/20240101000000_create.sql': CREATE,
    });
    const run = () => extractData({ root, repo: 'order', runId: 'r', deterministic: true });
    const skipped = await run();
    assert.equal(skipped.result.status, 'PASS');
    assert.equal(skipped.nodes.some((n) => n.id === 'order:Table:public.legacy'), false);
    assert.equal(skipped.nodes.filter((n) => n.kind === 'Migration').length, 1);
    await writeFile(path.join(root, 'supabase/migrations/.keep'), '');
    assert.equal((await run()).nodes.some((n) => n.id === 'order:Table:public.legacy'), true);
  });
}

test('duplicate version strings and nested layouts withhold ordering proof', async (t) => {
  const duplicate = await tree(t, {
    'supabase/migrations/20240101_a.sql': CREATE,
    'supabase/migrations/20240101_b.sql': ALTER,
  });
  assert.equal((await order(duplicate)).state, 'unknown');
  const nested = await tree(t, { 'supabase/migrations/nested/20240101_a.sql': CREATE });
  assert.equal((await order(nested)).state, 'unknown');
});

test('large and zero-prefixed versions retain exact string order and identity', async (t) => {
  const root = await tree(t, {
    'supabase/migrations/1000000000000000000000000000000_create.sql': CREATE,
    'supabase/migrations/999999999999999999999999999999_alter.sql': ALTER,
  });
  const out = await extractData({ root, repo: 'order', runId: 'r', deterministic: true });
  assert.equal(out.nodes.find((n) => n.id === 'order:Column:public.events.value')?.props['type'], 'character varying(9)');
  const zeros = await tree(t, {
    'supabase/migrations/001_create.sql': CREATE,
    'supabase/migrations/01_alter.sql': ALTER,
  });
  const zeroOut = await extractData({ root: zeros, repo: 'order', runId: 'r', deterministic: true });
  const migrations = zeroOut.nodes.filter((n) => n.kind === 'Migration').sort((a, b) => (a.props['ordinal'] as number) - (b.props['ordinal'] as number));
  assert.deepEqual(migrations.map((n) => n.id), ['order:Migration:001_create', 'order:Migration:01_alter']);
  assert.equal(zeroOut.nodes.find((n) => n.id === 'order:Column:public.events.value')?.props['type'], 'character varying(9)');
});

test('configuration deletion or replacement cannot reuse earlier ordering authority', async (t) => {
  const root = await tree(t, { 'supabase/migrations/20240101_a.sql': CREATE });
  assert.equal((await order(root)).state, 'known');
  const config = path.join(root, 'supabase/config.toml');
  await rm(config);
  assert.equal((await order(root)).state, 'unknown');
  await writeFile(config, CONFIG.replace('true', 'false'));
  assert.equal((await order(root)).state, 'unknown');
  await writeFile(config, CONFIG);
  assert.equal((await order(root)).state, 'known');
});

test('a configuration symlink never supplies ordering authority', async (t) => {
  const root = await tree(t, { 'supabase/migrations/20240101_a.sql': CREATE });
  await writeFile(path.join(root, 'other.toml'), CONFIG);
  await rm(path.join(root, 'supabase/config.toml'));
  try { await symlink('../other.toml', path.join(root, 'supabase/config.toml')); }
  catch (error) {
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('file symlinks need permission on this Windows host'); return; }
    throw error;
  }
  assert.equal((await order(root)).state, 'unknown');
});

test('configuration cannot override a generic migration directory convention', async (t) => {
  const root = await tree(t, {
    'db/config.toml': CONFIG,
    'db/migrations/2_create.sql': CREATE,
    'db/migrations/10_alter.sql': ALTER,
  });
  const policy = await order(root);
  assert.equal(policy.state, 'unknown');
  if (policy.state === 'unknown') assert.equal(policy.candidate, false);
  const out = await extractData({ root, repo: 'order', runId: 'r', deterministic: true });
  assert.equal(out.nodes.find((n) => n.id === 'order:Column:public.events.value')?.props['type'], 'character varying(9)');
});

test('the caller source limit also bounds configuration authority', async (t) => {
  const root = await tree(t, { 'supabase/migrations/20240101_a.sql': 'CREATE TABLE e(id int);' });
  const found = await discoverSources({ root, maxFileBytes: 32 });
  assert.equal(found.migrationOrders.length, 1);
  assert.equal(found.migrationOrders[0]?.state, 'unknown');
});
