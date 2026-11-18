import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { extractData } from './extractor.ts';
import { PG17_NATIVE_MODEL, CORE_REPLAY_MODEL } from './migration-replay-native.ts';
import { tokenizeSql, splitStatements } from '@seamline/core/sql';
import { parseReplayDdl } from './migration-replay-sql.ts';

const config = (major = '17') => `project_id = "native-fixture"\n${major === '' ? '' : `[db]\nmajor_version = ${major}\n`}[db.migrations]\nenabled = true\nschema_paths = []\n`;
async function run(t: TestContext, sql: readonly string[], major = '17', other?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'seamline-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'supabase/migrations');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(root, 'supabase/config.toml'), config(major));
  for (const [i, text] of sql.entries()) await writeFile(path.join(dir, `${String(i + 1).padStart(3, '0')}_step.sql`), text);
  if (other !== undefined) {
    await mkdir(path.join(root, 'other/supabase/migrations'), { recursive: true });
    await writeFile(path.join(root, 'other/supabase/config.toml'), config());
    await writeFile(path.join(root, 'other/supabase/migrations/100_other.sql'), other);
  }
  const out = await extractData({ root, repo: 'native', runId: 'run', deterministic: true });
  const migration = (i: number) => {
    const found = out.nodes.find(n => n.kind === 'Migration' && n.name === `${String(i).padStart(3, '0')}_step`);
    assert.ok(found); return found;
  };
  const source = out.nodes.find(n => n.kind === 'DataSource'); assert.ok(source);
  return { ...out, migration, source };
}
const EARLY = 'CREATE TABLE public.child(id integer REFERENCES public.parent(id));';
const LATE = 'CREATE TABLE public.parent(id integer);';
const statements = (extension: string) => [extension, EARLY, LATE];
for (const [name, version] of [['pgcrypto', '1.3'], ['uuid-ossp', '1.1'], ['citext', '1.6'], ['pg_trgm', '1.6'], ['btree_gist', '1.7']] as const) {
  test(`the exact stock default ${name} preserves an independent early-FK witness`, async t => {
    const out = await run(t, statements(`CREATE EXTENSION IF NOT EXISTS "${name}" WITH SCHEMA extensions VERSION '${version}';`));
    assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
    assert.equal(out.migration(1).props['replayDeclarationCount'], 0);
    assert.equal(out.migration(1).props['replayReferenceCount'], 0);
    assert.equal(out.migration(2).props['unresolvedRefCount'], 2);
    assert.equal(out.migration(2).props['replayVersion'], 2);
    assert.equal(out.migration(2).props['replayModelId'], PG17_NATIVE_MODEL.id);
    assert.equal(out.migration(2).props['replayModelHash'], PG17_NATIVE_MODEL.hash);
    assert.equal(out.source.props['replayNativeModels'], JSON.stringify([['supabase/migrations', out.migration(2).props['replayConfigHash'], 17, PG17_NATIVE_MODEL.id, PG17_NATIVE_MODEL.hash]]));
  });
}
for (const major of ['', '15', '18', '"17"', 'true']) test(`PG17 is not selected from ${JSON.stringify(major)}`, async t => {
  const out = await run(t, statements('CREATE EXTENSION pgcrypto;'), major);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(2).props['replayInventoryComplete'], false);
  assert.notEqual(out.migration(2).props['replayModelId'], PG17_NATIVE_MODEL.id);
  const core = await run(t, [EARLY, LATE], major);
  assert.equal(core.result.status, 'PASS');
  assert.equal(core.migration(1).props['replayModelId'], CORE_REPLAY_MODEL.id);
});
for (const text of [
  'CREATE EXTENSION "Pgcrypto";', "CREATE EXTENSION pgcrypto VERSION '1.2';",
  'CREATE EXTENSION custom;', 'CREATE EXTENSION citext CASCADE;',
  'CREATE EXTENSION citext WITH;', 'CREATE EXTENSION citext SCHEMA public SCHEMA elsewhere;',
  'CREATE EXTENSION citext VERSION 1.6;', 'CREATE EXTENSION citext; ALTER EXTENSION citext UPDATE;',
  'CREATE EXTENSION citext; ALTER EXTENSION citext ADD TABLE public.parent;',
  'CREATE EXTENSION citext; DROP EXTENSION citext;',
]) test(`unproved extension grammar/member provenance still withholds: ${text}`, async t => {
  const out = await run(t, statements(text));
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(2).props['replayInventoryComplete'], false);
});
test('IF NOT EXISTS skips its second schema and known relocation preserves both negative footprints', async t => {
  const out = await run(t, ['CREATE EXTENSION IF NOT EXISTS citext SCHEMA first; CREATE EXTENSION IF NOT EXISTS citext SCHEMA skipped; ALTER EXTENSION citext SET SCHEMA moved;', 'CREATE TABLE skipped.citext(id integer);', EARLY, LATE]);
  assert.equal(out.result.status, 'PASS');
  assert.equal(out.migration(2).props['replayDeclarationCount'], 2);
  assert.equal(out.migration(3).props['unresolvedRefCount'], 2);
  for (const schema of ['first', 'moved']) {
    const collision = await run(t, ['CREATE EXTENSION citext SCHEMA first; ALTER EXTENSION citext SET SCHEMA moved;', `CREATE TABLE ${schema}.citext(id integer);`, EARLY, LATE]);
    assert.equal(collision.result.status, 'UNAVAILABLE');
    assert.equal(collision.migration(2).props['replayDeclarationCount'], 0);
  }
});
for (const name of ['citext', '_citext', '_citext_42']) test(`base/generated type collision cannot establish table ${name}`, async t => {
  const out = await run(t, ['CREATE EXTENSION citext SCHEMA public;', `CREATE TABLE public.${name}(id integer);`, EARLY, LATE]);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(2).props['replayDeclarationCount'], 0);
});
test('unknown placement remains negative in every schema, without guessing public', async t => {
  const out = await run(t, ['CREATE EXTENSION citext;', 'CREATE TABLE other.citext(id integer);', EARLY, LATE]);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(2).props['replayDeclarationCount'], 0);
});
for (const text of ['ALTER EXTENSION citext SET SCHEMA public;', 'CREATE EXTENSION citext; CREATE EXTENSION citext;', 'DO $$ BEGIN EXECUTE unknown_source; END $$; CREATE EXTENSION IF NOT EXISTS citext;']) test(`unknown extension history cannot be reset: ${text}`, async t => {
  const out = await run(t, statements(text), '17', 'CREATE EXTENSION citext;');
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(2).props['replayInventoryComplete'], false);
});
test('type exports donate neither to_regclass truth nor references', async t => {
  const out = await run(t, ['CREATE EXTENSION citext SCHEMA public; CREATE TABLE public.child(id integer);', "DO $$ BEGIN IF to_regclass('public.citext') IS NOT NULL THEN ALTER TABLE public.child ADD FOREIGN KEY(id) REFERENCES public.parent(id); END IF; END $$;", LATE]);
  assert.equal(out.migration(2).props['skippedRefCount'], 0);
  assert.equal(out.migration(2).props['unresolvedRefCount'], 0);
  assert.equal(out.migration(2).props['unknownRefCount'], 2);
});
for (const change of ['CREATE TYPE public.shadow AS ENUM (\'x\'); CREATE TABLE public.shadow(id integer);', 'CREATE EXTENSION citext SCHEMA moved; CREATE TABLE public.citext(id integer); ALTER TABLE public.citext SET SCHEMA moved;']) test(`declared type and namespace collision remain conservative: ${change}`, async t => {
  const out = await run(t, statements(change)); assert.equal(out.result.status, 'UNAVAILABLE');
});
const VALUES = "ARRAY['alpha','beta']::text[]";
const CHECKS = `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fixture') THEN ALTER TABLE public.form ADD CHECK(jsonb_typeof(payload)='object'); ALTER TABLE public.form ADD CHECK(section = ANY(${VALUES})); ALTER TABLE public.form ADD CHECK(sections <@ ${VALUES}); END IF; END $$;`;
test('complete typed native checks under an unknown catalog guard preserve live reference state', async t => {
  const out = await run(t, ['CREATE TABLE public.form(payload jsonb, section text, sections text[]);', CHECKS, EARLY, LATE]);
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(out.migration(2).props['replayInventoryComplete'], true);
  assert.equal(out.migration(3).props['unresolvedRefCount'], 2);
});
for (const before of [
  'CREATE TABLE public.form(payload text, section text, sections text[]);',
  "CREATE TYPE public.jsonb AS ENUM ('x'); CREATE TABLE public.form(payload jsonb, section text, sections text[]);",
  "CREATE TABLE public.form(payload jsonb, section text, sections text[]); CREATE FUNCTION public.jsonb_typeof(v jsonb) RETURNS text LANGUAGE sql AS $$ SELECT 'object'; $$;",
  'CREATE TABLE public.form(payload jsonb, section text, sections text[]); ALTER TABLE public.form ALTER COLUMN payload TYPE text;',
  'CREATE TABLE public.form(payload jsonb, section text, sections text[]); CREATE VIEW pg_catalog.pg_constraint AS SELECT 1 AS oid;',
]) test(`native check authority is not supplied by syntax after type/native poison: ${before}`, async t => {
  const statement = splitStatements(tokenizeSql(CHECKS))[0]; assert.ok(statement);
  const parsed = parseReplayDdl(statement.toks, 'public'); assert.equal(parsed.kind, 'guard');
  assert.ok(parsed.kind === 'guard'); const branch = parsed.body[0]; assert.ok(branch?.kind === 'guard');
  const effect = branch.body[0]; assert.ok(effect?.kind === 'alter');
  assert.equal(effect.actions[0]?.validation?.kind, 'jsonb', 'the actual parser reaches the validation effect before the bad type/native state refuses it');
  const out = await run(t, [before, CHECKS, EARLY, LATE]);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(3).props['replayInventoryComplete'], false);
});
const QUERY = "DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.items i LEFT JOIN public.owners o ON o.id=i.owner_id WHERE o.id IS NULL) THEN RAISE EXCEPTION 'invalid fixture rows'; END IF; END $$;";
test('ordinary LEFT JOIN/RAISE contributes possible abort, never guessed rows or dead suffix success', async t => {
  const out = await run(t, ['CREATE TABLE public.items(owner_id uuid); CREATE TABLE public.owners(id uuid);', QUERY, EARLY, LATE]);
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(out.migration(2).props['replayAbortPossible'], true);
  assert.equal(out.migration(3).props['replayContinuation'], 'live');
  assert.equal(out.migration(3).props['unresolvedRefCount'], 2);
});
for (const before of ['CREATE TABLE public.items(owner_id uuid); CREATE VIEW public.owners AS SELECT 1 AS id;', 'CREATE TABLE public.items(owner_id custom); CREATE TABLE public.owners(id custom);', 'CREATE TABLE public.items(owner_id "toString"); CREATE TABLE public.owners(id "toString");']) test(`unknown view/type read cannot enter a live validation proof: ${before}`, async t => {
  const out = await run(t, [before, QUERY, EARLY, LATE]); assert.equal(out.result.status, 'UNAVAILABLE');
});
for (const bad of ["DO $$ BEGIN RAISE EXCEPTION 'stop'; END $$;", "DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.items i LEFT JOIN public.owners o ON o.id=i.owner_id WHERE o.id IS NULL) THEN RAISE EXCEPTION 'stop' USING ERRCODE='P0001'; END IF; END $$;", "DO $$ BEGIN RAISE NOTICE 'not supported'; END $$;"]) test(`terminal or unsupported control never supplies examined suffix: ${bad}`, async t => {
  const out = await run(t, ['CREATE TABLE public.items(owner_id uuid); CREATE TABLE public.owners(id uuid);', bad, EARLY, LATE]);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(3).props['replayInventoryComplete'], false);
  assert.equal(out.migration(3).props['validRefCount'], 0);
});

test('a locally proved IF NOT EXISTS skips an older requested body rather than installing it', async t => {
  const out = await run(t, ["CREATE EXTENSION citext SCHEMA first; CREATE EXTENSION IF NOT EXISTS citext SCHEMA skipped VERSION '1.4';", 'CREATE TABLE skipped.citext(id integer);', EARLY, LATE]);
  assert.equal(out.result.status, 'PASS');
  assert.equal(out.migration(2).props['replayDeclarationCount'], 2);
  assert.equal(out.migration(3).props['unresolvedRefCount'], 2);
});
test('a Source custom member before stock installation invalidates the instance footprint', async t => {
  const out = await run(t, ["CREATE TYPE public.citext AS ENUM ('custom'); CREATE EXTENSION citext SCHEMA public;", EARLY, LATE]);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(2).props['replayInventoryComplete'], false);
});
for (const poison of [
  "CREATE FUNCTION public.uuid_eq(a uuid,b uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true; $$;",
  'CREATE VIEW pg_catalog.pg_operator AS SELECT 1 AS oid;',
  'CREATE VIEW pg_catalog.pg_attribute AS SELECT 1 AS oid;',
]) test(`ordinary typed reads preserve native/catalog poison: ${poison}`, async t => {
  const out = await run(t, ['CREATE TABLE public.items(owner_id uuid); CREATE TABLE public.owners(id uuid); ' + poison, QUERY, EARLY, LATE]);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(3).props['replayInventoryComplete'], false);
});

test('ordinary disconnected join footprints validate every declared relation kind', async t => {
  const query = "DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.items i LEFT JOIN public.owners o ON o.id=o.id WHERE o.id IS NULL) THEN RAISE EXCEPTION 'rows'; END IF; END $$;";
  const positive = await run(t, ['CREATE TABLE public.items(id uuid); CREATE TABLE public.owners(id uuid);', query, EARLY, LATE]);
  assert.equal(positive.result.status, 'PASS');
  assert.equal(positive.migration(3).props['unresolvedRefCount'], 2);
  const view = await run(t, ['CREATE VIEW public.items AS SELECT 1 AS id; CREATE TABLE public.owners(id uuid);', query, EARLY, LATE]);
  assert.equal(view.result.status, 'UNAVAILABLE');
});

for (const name of ['citext', '_citext', '_citext_42']) test(`a view cannot donate composite-type presence over native ${name}`, async t => {
  const out = await run(t, [
    'CREATE EXTENSION citext SCHEMA public; CREATE TABLE public.child(id integer);',
    `CREATE VIEW public.${name} AS SELECT 1 AS id;`,
    `DO $$ BEGIN IF to_regclass('public.${name}') IS NOT NULL THEN ALTER TABLE public.child ADD FOREIGN KEY(id) REFERENCES public.parent(id); END IF; END $$;`,
    LATE,
  ]);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(2).props['replayDeclarationCount'], 0);
  assert.equal(out.migration(3).props['unresolvedRefCount'], 0);
  assert.equal(out.migration(3).props['validRefCount'], 2, 'the earlier child table/id stay valid independently of the view');
  assert.equal(out.migration(3).props['unknownRefCount'], 2, 'the guarded parent table/id have no donated live branch');
});

test('a native type in a different schema does not reject an unrelated view', async t => {
  const out = await run(t, ['CREATE EXTENSION citext SCHEMA extensions;', 'CREATE VIEW public.citext AS SELECT 1 AS id;', EARLY, LATE]);
  assert.equal(out.result.status, 'PASS');
  assert.equal(out.migration(2).props['replayDeclarationCount'], 2);
  assert.equal(out.migration(3).props['unresolvedRefCount'], 2);
});

const READ_BASE = 'CREATE TABLE public.items(owner_id uuid); CREATE TABLE public.owners(id uuid); CREATE TABLE public.pg_operator(id integer);';
for (const [label, sql] of [
  ['earlier schema destination', [READ_BASE, 'ALTER TABLE public.pg_operator SET SCHEMA pg_catalog;', QUERY]],
  ['later schema destination', [READ_BASE, QUERY, 'ALTER TABLE public.pg_operator SET SCHEMA pg_catalog;']],
  ['rename then schema destination', [READ_BASE.replace('public.pg_operator(id', 'public.spare(id'), 'ALTER TABLE public.spare RENAME TO pg_operator; ALTER TABLE public.pg_operator SET SCHEMA pg_catalog;', QUERY]],
  ['guarded schema destination', [READ_BASE, "DO $$ BEGIN IF to_regclass('public.external') IS NULL THEN ALTER TABLE public.pg_operator SET SCHEMA pg_catalog; END IF; END $$;", QUERY]],
] as const) test(`catalog authority includes whole-group ${label}`, async t => {
  const out = await run(t, [...sql, EARLY, LATE]);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.migration(sql.indexOf(QUERY) + 1).props['replayInventoryComplete'], false);
});

test('an unmoved public catalog-like name does not poison native catalog authority', async t => {
  const out = await run(t, [READ_BASE, QUERY, EARLY, LATE]);
  assert.equal(out.result.status, 'PASS');
  assert.equal(out.migration(3).props['unresolvedRefCount'], 2);
});

for (const [catalog, column] of [['pg_constraint', 'conname'], ['pg_policies', 'policyname']] as const) {
  for (const placement of ['before', 'after']) test(`catalog-call dependency ${catalog} includes its ${placement} schema destination`, async t => {
    const base = `CREATE TABLE public.form(payload jsonb); CREATE TABLE public.${catalog}(${column} text);`;
    const moved = `ALTER TABLE public.${catalog} SET SCHEMA pg_catalog;`;
    const check = `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM ${catalog} WHERE ${column}='fixture') THEN ALTER TABLE public.form ADD CHECK(jsonb_typeof(payload)='object'); END IF; END $$;`;
    const middle = placement === 'before' ? [moved, check] : [check, moved];
    const out = await run(t, [base, ...middle, EARLY, LATE]);
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(out.migration(middle.indexOf(check) + 2).props['replayInventoryComplete'], false);
  });
}
