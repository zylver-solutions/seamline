import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { extractData } from './extractor.ts';

async function replay(t: TestContext, before: string, write: string, after = '', options: { reference?: string; otherGroup?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'seamline-external-rows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'supabase/migrations');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(root, 'supabase/config.toml'), 'project_id = "fixture"\n[db.migrations]\nenabled = true\nschema_paths = []\n');
  for (const [name, text] of Object.entries({
    '001_before.sql': before,
    '002_write.sql': write,
    '003_ref.sql': options.reference ?? 'CREATE TABLE public.child (id integer REFERENCES public.parent(id));',
    '004_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
    '005_after.sql': after,
  })) await writeFile(path.join(directory, name), text);
  if (options.otherGroup !== undefined) {
    const other = path.join(root, 'other/supabase');
    await mkdir(path.join(other, 'migrations'), { recursive: true });
    await writeFile(path.join(other, 'config.toml'), 'project_id = "other"\n[db.migrations]\nenabled = true\nschema_paths = []\n');
    await writeFile(path.join(other, 'migrations/100_other.sql'), options.otherGroup);
  }
  const out = await extractData({ root, repo: 'external-rows', runId: 'run', dialect: 'postgres', deterministic: true });
  const migration = (name: string) => {
    const found = out.nodes.find((node) => node.kind === 'Migration' && node.name === name);
    assert.ok(found, name); return found;
  };
  return { ...out, migration };
}

for (const write of [
  "INSERT INTO extension.objects(id, label) VALUES (1, 'fixture') ON CONFLICT(id) DO UPDATE SET label = excluded.label;",
  'UPDATE extension.objects SET id = 1;',
  'DELETE FROM extension.objects WHERE id = 1;',
  'WITH removed AS (DELETE FROM extension.objects RETURNING id) INSERT INTO extension.archive(id) SELECT id FROM removed;',
  'UPDATE public.external_object SET id = 1;',
  'UPDATE "Case.Schema"."Case.Table" SET id = 1;',
]) test(`source-external row effects preserve declared point-state without existence credit: ${write}`, async (t) => {
  const out = await replay(t, '', write);
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  const body = out.migration('002_write').props;
  assert.equal(body['replayInventoryComplete'], true);
  assert.equal(body['replayDeclarationCount'], 0);
  assert.equal(body['replayReferenceCount'], 0);
  assert.deepEqual(JSON.parse(out.migration('003_ref').props['unresolvedRefs'] as string), [
    ['public', 'parent', 'id', 0, 1, '004_parent', 0, 1],
    ['public', 'parent', null, 0, 1, '004_parent', 0, 1],
  ]);
});

test('an external row effect leaves a later examined foreign key valid after its declaration', async (t) => {
  const out = await replay(t, 'CREATE TABLE public.parent (id integer);', 'INSERT INTO extension.objects(id) VALUES(1);');
  assert.equal(out.result.status, 'PASS');
  const ref = out.migration('003_ref').props;
  assert.equal(ref['unresolvedRefCount'], 0);
  assert.equal(ref['unknownRefCount'], 0);
  assert.equal(ref['validRefCount'], 3);
});

for (const [before, write, after] of [
  ['', 'INSERT INTO public.parent(id) VALUES(1);', ''],
  ['CREATE TABLE extension.objects(id integer); DROP TABLE extension.objects;', 'UPDATE extension.objects SET id = 1;', ''],
  ['', 'UPDATE extension.objects SET id = 1;', 'ALTER TABLE extension.external RENAME TO objects;'],
  ['', 'UPDATE extension.objects SET id = 1;', 'ALTER TABLE elsewhere.objects SET SCHEMA extension;'],
  ['', 'UPDATE extension.middle SET id = 1;', 'ALTER TABLE extension.external RENAME TO middle; ALTER TABLE extension.middle SET SCHEMA elsewhere;'],
  ['', 'UPDATE extension.objects SET id = 1;', 'CREATE TABLE IF NOT EXISTS extension.objects(id integer);'],
  ['CREATE TABLE public.owner(id integer);', 'UPDATE public.future_index SET id = 1;', 'CREATE INDEX future_index ON public.owner(id);'],
  ['', 'UPDATE public.future_id_seq SET id = 1;', 'CREATE TABLE public.future(id serial);'],
  ['', 'UPDATE public.future_key SET id = 1;', 'CREATE TABLE public.future(id integer CONSTRAINT future_key UNIQUE);'],
  ['CREATE TABLE public.owner(id integer);', 'UPDATE extension.future_id_seq SET id = 1;', 'ALTER TABLE public.owner SET SCHEMA extension; CREATE TABLE public.future(id serial);'],
  ['CREATE TABLE public.owner(id integer);', 'UPDATE extension.future_index SET id = 1;', 'CREATE INDEX future_index ON public.owner(id); ALTER TABLE public.owner SET SCHEMA extension;'],
  ['CREATE TABLE public.owner(id integer);', 'UPDATE final.future_index SET id = 1;', 'ALTER TABLE middle.owner SET SCHEMA final; CREATE INDEX future_index ON public.owner(id); ALTER TABLE public.owner SET SCHEMA middle;'],
  ['CREATE TABLE public.owner(id integer);', 'UPDATE final.future_id_seq SET id = 1;', 'ALTER TABLE middle.owner SET SCHEMA final; ALTER TABLE public.owner SET SCHEMA middle; CREATE TABLE public.future(id serial);'],
  ['', 'UPDATE extension.objects SET id = 1;', "DO $$ BEGIN IF to_regclass('extension.objects') IS NOT NULL THEN ALTER TABLE extension.objects ADD CONSTRAINT guarded CHECK (id > 0); END IF; END $$;"],
  ["DO $$ BEGIN IF to_regclass('public.external') IS NULL THEN CREATE TABLE extension.objects(id integer); END IF; END $$;", 'UPDATE extension.objects SET id = 1;', ''],
  ['CREATE VIEW extension.objects AS SELECT oid AS id FROM pg_catalog.pg_class;', 'UPDATE extension.objects SET id = 1;', ''],
  ['CREATE VIEW extension.proxy AS SELECT oid AS id FROM pg_catalog.pg_class; ALTER TABLE extension.proxy RENAME TO objects;', 'UPDATE extension.objects SET id = 1;', ''],
  ['CREATE VIEW elsewhere.objects AS SELECT oid AS id FROM pg_catalog.pg_class; ALTER TABLE elsewhere.objects SET SCHEMA extension;', 'UPDATE extension.objects SET id = 1;', ''],
  ['CREATE VIEW extension.first AS SELECT oid AS id FROM pg_catalog.pg_class; CREATE VIEW extension.objects AS SELECT id FROM extension.first;', 'UPDATE extension.objects SET id = 1;', ''],
  ['CREATE TABLE extension.objects(id integer); CREATE RULE redirect AS ON UPDATE TO extension.objects DO ALSO DELETE FROM pg_catalog.pg_class;', 'UPDATE extension.objects SET id = 1;', ''],
  ['DO $$ BEGIN EXECUTE arbitrary_sql(); END $$;', 'UPDATE extension.objects SET id = 1;', ''],
  ['', "UPDATE pg_catalog.pg_class SET relname = 'parent';", ''],
  ['', "UPDATE pg_class SET relname = 'parent';", ''],
  ['', 'WITH changed AS (DELETE FROM pg_catalog.pg_class RETURNING oid) INSERT INTO extension.objects(id) SELECT oid FROM changed;', ''],
  ['', 'UPDATE extension.objects SET id = 1 EXECUTE arbitrary_sql;', ''],
] as const) test(`unproved external-row exposure still withholds: ${before} | ${write} | ${after}`, async (t) => {
  const out = await replay(t, before, write, after);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration('003_ref').props['replayInventoryComplete'], false);
  assert.equal(out.migration('003_ref').props['unresolvedRefCount'], 0);
});

test('stored invocation bodies remain outside the declared-DDL claim for both kinds of row target', async (t) => {
  const out = await replay(t,
    'CREATE TABLE public.local (id integer); CREATE FUNCTION public.side_effect() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN CREATE TABLE public.parent(id integer); RETURN 1; END $$;',
    'INSERT INTO public.local(id) VALUES(public.side_effect()); INSERT INTO extension.objects(id) VALUES(public.side_effect());');
  assert.equal(out.result.status, 'PASS');
  assert.equal(out.migration('001_before').props['replayDeclarationCount'], 2);
  assert.equal(out.migration('002_write').props['replayDeclarationCount'], 0);
  assert.equal(out.migration('003_ref').props['unresolvedRefCount'], 2);
});

test('an external row target stays external to later references and another group lends no existence', async (t) => {
  const out = await replay(t, '', 'UPDATE extension.objects SET id = 1;', '', {
    reference: 'CREATE TABLE public.child(id integer REFERENCES extension.objects(id));',
    otherGroup: 'CREATE TABLE extension.objects(id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  const ref = out.migration('003_ref').props;
  assert.equal(ref['externalRefCount'], 2);
  assert.equal(ref['unknownRefCount'], 0);
  assert.equal(ref['unresolvedRefCount'], 0);
  assert.equal(ref['validRefCount'], 1);
});

test('a row write does not establish a later native existence guard on that target', async (t) => {
  const out = await replay(t, 'CREATE TABLE public.child(id integer);', 'UPDATE extension.objects SET id = 1;', '', {
    reference: "DO $$ BEGIN IF to_regclass('extension.objects') IS NOT NULL THEN ALTER TABLE public.child ADD CONSTRAINT fk FOREIGN KEY(id) REFERENCES public.parent(id); END IF; END $$;",
  });
  assert.equal(out.result.status, 'PASS');
  const ref = out.migration('003_ref').props;
  assert.equal(ref['unknownRefCount'], 2);
  assert.equal(ref['unresolvedRefCount'], 0);
  assert.equal(ref['skippedRefCount'], 0);
});

for (const target of ['other.objects', 'extension."Objects"']) test(`external exclusion preserves exact schema and identifier case: ${target}`, async (t) => {
  const out = await replay(t, 'CREATE VIEW extension.objects AS SELECT oid AS id FROM pg_catalog.pg_class;', `UPDATE ${target} SET id = 1;`);
  assert.equal(out.result.status, 'PASS');
  assert.equal(out.migration('002_write').props['replayDeclarationCount'], 0);
  assert.equal(out.migration('003_ref').props['unresolvedRefCount'], 2);
});

test('a known table remains an admitted row target after rename and schema move', async (t) => {
  const out = await replay(t, 'CREATE TABLE public.original(id integer); ALTER TABLE public.original RENAME TO objects; ALTER TABLE public.objects SET SCHEMA extension;', 'UPDATE extension.objects SET id = 1;');
  assert.equal(out.result.status, 'PASS');
  assert.equal(out.migration('003_ref').props['unresolvedRefCount'], 2);
});

test('unsupported source after an admitted write still invalidates the complete certificate', async (t) => {
  const out = await replay(t, '', 'UPDATE extension.objects SET id = 1;', 'DO $$ BEGIN EXECUTE arbitrary_sql(); END $$;');
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration('002_write').props['replayUnknownStepCount'], 0);
  assert.equal(out.migration('002_write').props['replayInventoryComplete'], false);
});
