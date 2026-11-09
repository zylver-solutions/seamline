import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { SeamlineNode } from '@seamline/ontology';
import { extractData } from './extractor.ts';

const CONFIG = 'project_id = "fixture"\n[db.migrations]\nenabled = true\nschema_paths = []\n';
// A valid table keeps metadata refusal tests sensitive to grammar failures.
const KEPT_SQL = 'CREATE TABLE public.kept (id integer);';
async function run(t: TestContext, sql: Readonly<Record<string, string | Uint8Array>>, dialect = 'postgres', epoch = 'epoch') {
  const root = await mkdtemp(path.join(tmpdir(), 'seamline-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'supabase/migrations'), { recursive: true });
  await writeFile(path.join(root, 'supabase/config.toml'), CONFIG);
  for (const [name, text] of Object.entries(sql)) await writeFile(path.join(root, 'supabase/migrations', name), text);
  return extractData({ root, repo: 'replay', runId: epoch, dialect, deterministic: true });
}
function migration(nodes: readonly SeamlineNode[], name: string): SeamlineNode {
  const found = nodes.find((node) => node.kind === 'Migration' && node.name === name);
  assert.ok(found !== undefined, name); return found;
}
function rows(node: SeamlineNode, prop: string): unknown[][] {
  const text = node.props[prop]; assert.equal(typeof text, 'string');
  const result: unknown = JSON.parse(text as string); assert.ok(Array.isArray(result));
  return result as unknown[][];
}

test('a reference before local creation carries its point-state and creation witness', async (t) => {
  const out = await run(t, {
    '001_ref.sql': 'ALTER TABLE public.accounts ADD COLUMN tag text;',
    '002_create.sql': 'CREATE TABLE public.accounts (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  const ref = migration(out.nodes, '001_ref');
  assert.equal(ref.props['replayVersion'], 1);
  assert.equal(ref.props['replayEpoch'], 'epoch');
  assert.equal(ref.props['replayInventoryComplete'], true);
  assert.deepEqual(rows(ref, 'unresolvedRefs'), [['public', 'accounts', null, 0, 1, '002_create', 0, 1]]);
  const creation = migration(out.nodes, '002_create');
  assert.ok(rows(creation, 'replayDeclarations').some((r) => r[0] === 'public' && r[1] === 'accounts' && r[2] === null));
});

test('a correctly ordered ALTER has examined valid references and explicit empty conflicts', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '002_alter.sql': 'ALTER TABLE public.accounts ADD COLUMN tag text;',
  });
  const ref = migration(out.nodes, '002_alter');
  assert.deepEqual(rows(ref, 'unresolvedRefs'), []);
  assert.deepEqual(rows(ref, 'validRefs'), [['public', 'accounts', null, 0, 1]]);
  assert.equal(ref.props['unknownRefCount'], 0);
  assert.equal(ref.props['externalRefCount'], 0);
});

test('inline self-references and composite foreign keys use point-local column state', async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (a integer, b integer, FOREIGN KEY (a,b) REFERENCES public.parent(a,b));',
    '002_parent.sql': 'CREATE TABLE public.parent (a integer, b integer, PRIMARY KEY(a,b));',
    '003_self.sql': 'CREATE TABLE public.self_ref (id integer PRIMARY KEY, parent integer REFERENCES public.self_ref(id));',
  });
  assert.equal(migration(out.nodes, '001_child').props['unresolvedRefCount'], 3);
  assert.equal(migration(out.nodes, '002_parent').props['unresolvedRefCount'], 0);
  assert.equal(migration(out.nodes, '003_self').props['unresolvedRefCount'], 0);
  assert.equal(migration(out.nodes, '003_self').props['unknownRefCount'], 0);
});

test('never-created external objects are withheld rather than orphan findings', async (t) => {
  const out = await run(t, { '001_child.sql': 'CREATE TABLE public.child (id integer REFERENCES auth.users(id));' });
  const ref = migration(out.nodes, '001_child');
  assert.deepEqual(rows(ref, 'unresolvedRefs'), []);
  assert.equal(ref.props['externalRefCount'], 2);
  assert.equal(ref.props['unknownRefCount'], 0);
});

test('an external table guard leaves both feasible reference branches examined', async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (id integer, parent_id integer);',
    '002_guard.sql': "DO $$ BEGIN IF to_regclass('auth.users') IS NOT NULL THEN ALTER TABLE public.child ADD FOREIGN KEY (parent_id) REFERENCES public.parent(id); END IF; END $$;",
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  const ref = migration(out.nodes, '002_guard');
  assert.equal(ref.props['replayInventoryComplete'], true);
  assert.equal(ref.props['skippedRefCount'], 0);
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.deepEqual(rows(ref, 'unknownRefs'), [
    ['public', 'parent', 'id', 2, 1],
    ['public', 'parent', null, 2, 1],
  ]);
  assert.equal(ref.props['validRefCount'], 2);
});

test('to_regclass of a declared sequence cannot be disproved by an empty table catalog', async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (id integer, parent_id integer); CREATE SEQUENCE public.gate START 1;',
    '002_guard.sql': "DO $$ BEGIN IF to_regclass('public.gate') IS NOT NULL THEN ALTER TABLE public.child ADD FOREIGN KEY (parent_id) REFERENCES public.parent(id); END IF; END $$;",
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  const ref = migration(out.nodes, '002_guard');
  assert.equal(ref.props['skippedRefCount'], 0);
  // Relation-kind tracking may prove the guard true; without that evidence
  // both branches remain feasible. Neither interpretation is a clean zero.
  assert.equal(Number(ref.props['unknownRefCount']) + Number(ref.props['unresolvedRefCount']), 2);
});

for (const separator of [' ', '\n']) test(`procedural reference sites retain independent evidence with separator ${JSON.stringify(separator)}`, async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (id integer, parent_id integer);',
    '002_body.sql': `DO $$ BEGIN ALTER TABLE public.child ADD FOREIGN KEY (parent_id) REFERENCES public.parent(id);${separator}IF to_regclass('public.parent') IS NOT NULL THEN ALTER TABLE public.child ADD FOREIGN KEY (parent_id) REFERENCES public.parent(id); END IF; END $$;`,
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  const ref = migration(out.nodes, '002_body');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['unresolvedRefCount'], 2);
  assert.equal(ref.props['skippedRefCount'], 4);
  const missingSteps = new Set(rows(ref, 'unresolvedRefs').map((row) => row[3]));
  const skippedSteps = new Set(rows(ref, 'skippedRefs').map((row) => row[3]));
  assert.equal(missingSteps.size, 1);
  assert.equal(skippedSteps.size, 1);
  assert.notDeepEqual(missingSteps, skippedSteps);
});

test('a skipped ADD action cannot erase another action on the same source line', async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (id integer);',
    '002_add.sql': 'ALTER TABLE public.child ADD a integer REFERENCES public.parent(id), ADD COLUMN IF NOT EXISTS id integer REFERENCES public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  const ref = migration(out.nodes, '002_add');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['unresolvedRefCount'], 2);
  assert.equal(ref.props['skippedRefCount'], 3);
  assert.equal(ref.props['unknownRefCount'], 0);
  const missing = rows(ref, 'unresolvedRefs').map((row) => row[3]);
  const skipped = rows(ref, 'skippedRefs').map((row) => row[3]);
  assert.equal(missing.every((step) => !skipped.includes(step)), true);
});

for (const relation of ['CREATE INDEX marker ON public.child(id);', 'CREATE SEQUENCE public.marker START 1;']) {
  for (const exists of [true, false]) test(`a known relation overrides retired table state in ${exists ? 'positive' : 'negative'} guards: ${relation}`, async (t) => {
    const out = await run(t, {
      '001_child.sql': 'CREATE TABLE public.child (id integer); CREATE TABLE public.marker (id integer); DROP TABLE public.marker;',
      '002_relation.sql': relation,
      '003_guard.sql': `DO $$ BEGIN IF to_regclass('public.marker') IS ${exists ? 'NOT ' : ''}NULL THEN ALTER TABLE public.child ADD FOREIGN KEY(id) REFERENCES public.parent(id); END IF; END $$;`,
      '004_parent.sql': 'CREATE TABLE public.parent (id integer);',
    });
    const ref = migration(out.nodes, '003_guard');
    assert.equal(out.result.status, 'PASS');
    assert.equal(ref.props['unknownRefCount'], 0);
    assert.equal(ref.props['unresolvedRefCount'], exists ? 2 : 0);
    assert.equal(ref.props['skippedRefCount'], exists ? 0 : 4);
  });
}

test('invalidated index-existence evidence cannot become known relation absence', async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (id integer); CREATE TABLE public.marker (id integer); DROP TABLE public.marker;',
    '002_index.sql': 'CREATE INDEX marker ON public.child(id);',
    '003_mutate.sql': 'ALTER TABLE public.child ADD COLUMN tag integer;',
    '004_guard.sql': "DO $$ BEGIN IF to_regclass('public.marker') IS NULL THEN ALTER TABLE public.child ADD FOREIGN KEY(id) REFERENCES public.parent(id); END IF; END $$;",
    '005_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  const ref = migration(out.nodes, '004_guard');
  assert.equal(ref.props['skippedRefCount'], 0);
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 2);
});

test('ALTER SET DEFAULT refuses local column references just as CREATE does', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '002_default.sql': 'ALTER TABLE public.accounts ALTER COLUMN id SET DEFAULT future;',
    '003_add.sql': 'ALTER TABLE public.accounts ADD COLUMN future integer;',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_default').props['replayInventoryComplete'], false);
});

for (const exists of [true, false]) test(`skipped sequence creation cannot survive its existing table: ${exists}`, async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (id integer); CREATE TABLE public.marker (id integer);',
    '002_sequence.sql': 'CREATE SEQUENCE IF NOT EXISTS public.marker;',
    '003_drop.sql': 'DROP TABLE public.marker;',
    '004_guard.sql': `DO $$ BEGIN IF to_regclass('public.marker') IS ${exists ? 'NOT ' : ''}NULL THEN ALTER TABLE public.child ADD FOREIGN KEY(id) REFERENCES public.parent(id); END IF; END $$;`,
    '005_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  const ref = migration(out.nodes, '004_guard');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['unresolvedRefCount'], exists ? 0 : 2);
  assert.equal(ref.props['skippedRefCount'], exists ? 4 : 0);
  assert.equal(ref.props['unknownRefCount'], 0);
});

for (const [definition, name] of [
  ['id integer PRIMARY KEY', 'child_pkey'],
  ['id integer UNIQUE', 'child_id_key'],
  ['id serial', 'child_id_seq'],
  ['id integer, PRIMARY KEY(id)', 'child_pkey'],
  ['id integer, UNIQUE(id)', 'child_id_key'],
  ['id integer CONSTRAINT named_marker PRIMARY KEY', 'named_marker'],
] as const) test(`implicit relations cannot prove an absence guard: ${definition}`, async (t) => {
  const out = await run(t, {
    '001_marker.sql': `CREATE TABLE public.${name} (dummy integer); DROP TABLE public.${name};`,
    '002_child.sql': `CREATE TABLE public.child (${definition});`,
    '003_guard.sql': `DO $$ BEGIN IF to_regclass('public.${name}') IS NULL THEN ALTER TABLE public.child ADD FOREIGN KEY(id) REFERENCES public.parent(id); END IF; END $$;`,
    '004_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  const ref = migration(out.nodes, '003_guard');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['replayInventoryComplete'], true);
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['skippedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 2);
});

test('implicit relation uncertainty stays within its qualified schema', async (t) => {
  const out = await run(t, {
    '001_marker.sql': 'CREATE TABLE archive.child_pkey (dummy integer); DROP TABLE archive.child_pkey;',
    '002_child.sql': 'CREATE TABLE public.child (id integer PRIMARY KEY);',
    '003_guard.sql': "DO $$ BEGIN IF to_regclass('archive.child_pkey') IS NULL THEN ALTER TABLE public.child ADD FOREIGN KEY(id) REFERENCES public.parent(id); END IF; END $$;",
    '004_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  const ref = migration(out.nodes, '003_guard');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['unresolvedRefCount'], 2);
  assert.equal(ref.props['unknownRefCount'], 0);
});

for (const statement of [
  'CREATE TABLE IF NOT EXISTS public.child (id integer PRIMARY KEY);',
  'ALTER TABLE public.child ADD COLUMN IF NOT EXISTS id serial;',
]) test(`a skipped declaration cannot donate implicit relation effects: ${statement}`, async (t) => {
  const name = statement.startsWith('CREATE') ? 'child_pkey' : 'child_id_seq';
  const out = await run(t, {
    '001_marker.sql': `CREATE TABLE public.${name} (dummy integer); DROP TABLE public.${name}; CREATE TABLE public.child (id integer);`,
    '002_skip.sql': statement,
    '003_guard.sql': `DO $$ BEGIN IF to_regclass('public.${name}') IS NOT NULL THEN ALTER TABLE public.child ADD FOREIGN KEY(id) REFERENCES public.parent(id); END IF; END $$;`,
    '004_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  const ref = migration(out.nodes, '003_guard');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 0);
  assert.equal(ref.props['skippedRefCount'], 4);
});

test('moving a table cannot discard implicit relation uncertainty in the destination schema', async (t) => {
  const out = await run(t, {
    '001_marker.sql': 'CREATE TABLE archive.child_id_seq (dummy integer); DROP TABLE archive.child_id_seq;',
    '002_child.sql': 'CREATE TABLE public.child (id serial); ALTER TABLE public.child SET SCHEMA archive;',
    '003_guard.sql': "DO $$ BEGIN IF to_regclass('archive.child_id_seq') IS NULL THEN ALTER TABLE archive.child ADD FOREIGN KEY(id) REFERENCES public.parent(id); END IF; END $$;",
    '004_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  const ref = migration(out.nodes, '003_guard');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 2);
});

test('an existing conditional index does not require the skipped body columns', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer); CREATE INDEX idx ON public.accounts(id);',
    '002_skip.sql': 'CREATE INDEX IF NOT EXISTS idx ON public.accounts(future);',
    '003_add.sql': 'ALTER TABLE public.accounts ADD COLUMN future integer;',
  });
  const ref = migration(out.nodes, '002_skip');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 0);
  assert.equal(ref.props['skippedRefCount'], 2);
});

test('an unproved conditional index body remains unknown rather than a passing negative', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '002_index.sql': 'CREATE INDEX IF NOT EXISTS idx ON public.accounts(future);',
    '003_add.sql': 'ALTER TABLE public.accounts ADD COLUMN future integer;',
  });
  const ref = migration(out.nodes, '002_index');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['replayInventoryComplete'], true);
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['skippedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 2);
});

test('a dropped table lifetime cannot leave an earlier index existence proof usable', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer); CREATE INDEX idx ON public.accounts(id);',
    '002_replace.sql': 'DROP TABLE public.accounts; CREATE TABLE public.accounts (id integer);',
    '003_index.sql': 'CREATE INDEX IF NOT EXISTS idx ON public.accounts(future);',
    '004_add.sql': 'ALTER TABLE public.accounts ADD COLUMN future integer;',
  });
  const ref = migration(out.nodes, '003_index');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['skippedRefCount'], 0);
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 2);
});

test('index existence evidence does not cross schema namespaces', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer); CREATE TABLE archive.accounts (id integer); CREATE INDEX idx ON public.accounts(id);',
    '002_index.sql': 'CREATE INDEX IF NOT EXISTS idx ON archive.accounts(future);',
    '003_add.sql': 'ALTER TABLE archive.accounts ADD COLUMN future integer;',
  });
  const ref = migration(out.nodes, '002_index');
  assert.equal(ref.props['skippedRefCount'], 0);
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 2);
});

for (const attribute of ['CHECK (future > 0)', 'GENERATED ALWAYS AS (future + 1) STORED']) test(`column ${attribute} dependencies are part of reference inventory`, async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '002_attribute.sql': `ALTER TABLE public.accounts ADD COLUMN computed integer ${attribute};`,
    '003_add.sql': 'ALTER TABLE public.accounts ADD COLUMN future integer;',
  });
  const ref = migration(out.nodes, '002_attribute');
  assert.equal(out.result.status, 'PASS');
  assert.equal(ref.props['replayInventoryComplete'], true);
  assert.deepEqual(rows(ref, 'unresolvedRefs'), [['public', 'accounts', 'future', 0, 1, '003_add', 0, 1]]);
});

test('a table CHECK constraint validates its local expression columns', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '002_check.sql': 'ALTER TABLE public.accounts ADD CONSTRAINT positive CHECK (future > 0);',
    '003_add.sql': 'ALTER TABLE public.accounts ADD COLUMN future integer;',
  });
  const ref = migration(out.nodes, '002_check');
  assert.equal(out.result.status, 'PASS');
  assert.deepEqual(rows(ref, 'unresolvedRefs'), [['public', 'accounts', 'future', 0, 1, '003_add', 0, 1]]);
});

for (const conditional of ['', 'IF EXISTS ']) {
  for (const [action, schema] of [['RENAME TO parent', 'public'], ['SET SCHEMA archive', 'archive']] as const) {
    test(`an external source ${conditional}${action} cannot manufacture known destination absence`, async (t) => {
      const destination = action.startsWith('RENAME') ? 'parent' : 'external';
      const out = await run(t, {
        '001_move.sql': `ALTER TABLE ${conditional}public.external ${action};`,
        '002_index.sql': `CREATE INDEX idx ON ${schema}.${destination}(id);`,
        '003_create.sql': `CREATE TABLE ${schema}.${destination} (id integer);`,
      });
      const ref = migration(out.nodes, '002_index');
      assert.equal(ref.props['unresolvedRefCount'], 0);
      assert.equal(ref.props['unknownRefCount'], 2);
      assert.equal(migration(out.nodes, '001_move').props['skippedRefCount'], 0);
      assert.equal(out.result.status, 'UNAVAILABLE');
      assert.equal(ref.props['replayInventoryComplete'], false);
    });
  }
}

test('a later drop does not retroactively orphan an earlier index', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer); CREATE TABLE public.keep (id integer);',
    '002_index.sql': 'CREATE INDEX accounts_idx ON public.accounts(id);',
    '003_drop.sql': 'DROP TABLE public.accounts;',
  });
  assert.equal(out.result.status, 'PASS');
  const ref = migration(out.nodes, '002_index');
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['validRefCount'], 2);
});

test('drop and recreation do not leak columns across object lifetimes', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (old integer);',
    '002_drop.sql': 'DROP TABLE public.accounts;',
    '003_create.sql': 'CREATE TABLE public.accounts (current integer);',
    '004_index.sql': 'CREATE INDEX accounts_idx ON public.accounts(old);',
    '005_add.sql': 'ALTER TABLE public.accounts ADD COLUMN old integer;',
  });
  const ref = migration(out.nodes, '004_index');
  assert.equal(ref.props['unresolvedRefCount'], 1);
  assert.equal(rows(ref, 'unresolvedRefs')[0]?.[2], 'old');
  assert.equal(rows(ref, 'unresolvedRefs')[0]?.[5], '005_add');
});

test('IF NOT EXISTS cannot donate columns from a skipped declaration', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '002_skipped.sql': 'CREATE TABLE IF NOT EXISTS public.accounts (id integer, skipped integer);',
    '003_index.sql': 'CREATE INDEX accounts_idx ON public.accounts(skipped);',
    '004_add.sql': 'ALTER TABLE public.accounts ADD COLUMN skipped integer;',
  });
  assert.equal(migration(out.nodes, '002_skipped').props['replayDeclarationCount'], 0);
  const ref = migration(out.nodes, '003_index');
  assert.equal(ref.props['unresolvedRefCount'], 1);
  assert.equal(rows(ref, 'unresolvedRefs')[0]?.[2], 'skipped');
});

test('IF EXISTS does not require a missing optional table or column', async (t) => {
  const out = await run(t, {
    '001_optional.sql': 'ALTER TABLE IF EXISTS public.accounts ADD COLUMN tag integer;',
    '002_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '003_optional.sql': 'ALTER TABLE public.accounts DROP COLUMN IF EXISTS tag;',
    '004_add.sql': 'ALTER TABLE public.accounts ADD COLUMN tag integer;',
  });
  assert.equal(migration(out.nodes, '001_optional').props['unresolvedRefCount'], 0);
  assert.equal(migration(out.nodes, '003_optional').props['unresolvedRefCount'], 0);
});

test('unknown procedural effects cannot manufacture an absence proof', async (t) => {
  const out = await run(t, {
    '001_opaque.sql': 'DO $$ BEGIN CREATE TABLE public.accounts(id integer); END $$;',
    '002_index.sql': 'CREATE INDEX accounts_idx ON public.accounts(id);',
    '003_create.sql': 'CREATE TABLE public.accounts (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '001_opaque').props['replayUnknownStepCount'], 1);
  const ref = migration(out.nodes, '002_index');
  assert.equal(ref.props['replayInventoryComplete'], false);
  const source = out.nodes.find((node) => node.kind === 'DataSource');
  assert.ok(source);
  const groups = rows(source, 'replayGroups');
  assert.equal(groups[0]?.[3], false);
  assert.equal(groups[0]?.[5], 'unsupported or uncertain membership step');
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 2);
});

test('renamed tables and columns are available under their new exact names', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (old integer);',
    '002_column.sql': 'ALTER TABLE public.accounts RENAME COLUMN old TO current;',
    '003_table.sql': 'ALTER TABLE public.accounts RENAME TO renamed;',
    '004_index.sql': 'CREATE INDEX accounts_idx ON public.renamed(current);',
  });
  const ref = migration(out.nodes, '004_index');
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 0);
  assert.equal(ref.props['validRefCount'], 2);
});

test('quoted names preserve case and are not suffix-matched', async (t) => {
  const out = await run(t, {
    '001_index.sql': 'CREATE INDEX idx ON public."Mixed Table"("Value");',
    '002_create.sql': 'CREATE TABLE public."Mixed Table" ("Value" integer);',
  });
  const ref = migration(out.nodes, '001_index');
  assert.equal(ref.props['unresolvedRefCount'], 2);
  assert.ok(rows(ref, 'unresolvedRefs').some((r) => r[1] === 'Mixed Table' && r[2] === 'Value'));
});

test('unsupported dialects never emit an empty successful replay certificate', async (t) => {
  const out = await run(t, { '001_create.sql': 'CREATE TABLE public.accounts (id integer);' }, 'sqlite');
  const ref = migration(out.nodes, '001_create');
  assert.equal(ref.props['replayInventoryComplete'], false);
  assert.equal(ref.props['replayOrderPolicy'], 'supabase-filename-v1');
  assert.deepEqual(rows(ref, 'unresolvedRefs'), []);
});


test('incomplete source syntax withholds the whole group certificate', async (t) => {
  const out = await run(t, {
    '001_bad.sql': 'CREATE TABLE public.bad (id integer',
    '002_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '003_index.sql': 'CREATE INDEX idx ON public.accounts(id);',
  });
  const ref = migration(out.nodes, '003_index');
  assert.equal(ref.props['replayInventoryComplete'], false);
  assert.equal(ref.props['validRefCount'], 0);
  assert.equal(ref.props['unresolvedRefCount'], 0);
});

for (const malformed of [
  'CREATE TABLE public.accounts (id integer); /* unfinished comment',
  'CREATE TABLE public.accounts (id integer));',
  'CREATE TABLE public.accounts (id integer]);',
]) test(`tolerated lexer text cannot certify a replay: ${malformed}`, async (t) => {
  const out = await run(t, { '001_bad.sql': malformed });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '001_bad').props['replayInventoryComplete'], false);
});

test('complete nested comments and quoted delimiter text retain valid coverage', async (t) => {
  const out = await run(t, { '001_create.sql': '/* outer /* inner */ end */ CREATE TABLE public."Odd ) Name" ("--" integer); -- final comment' });
  assert.equal(out.result.status, 'PASS');
  assert.equal(migration(out.nodes, '001_create').props['replayDeclarationCount'], 2);
});

test('a rename collision cannot turn the original table into known absence', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.first (id integer); CREATE TABLE public.second (id integer);',
    '002_collision.sql': 'ALTER TABLE public.first RENAME TO second;',
    '003_index.sql': 'CREATE INDEX idx ON public.first(id);',
  });
  const ref = migration(out.nodes, '003_index');
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 2);
});


test('the replay input stamp binds unchanged members to the whole group snapshot', async (t) => {
  const first = await run(t, {
    '001_ref.sql': 'ALTER TABLE public.accounts ADD COLUMN tag text;',
    '002_create.sql': 'CREATE TABLE public.accounts (id integer);',
  });
  const changed = await run(t, {
    '001_ref.sql': 'ALTER TABLE public.accounts ADD COLUMN tag text;',
    '002_create.sql': 'CREATE TABLE public.accounts (id integer, other integer);',
  });
  const before = migration(first.nodes, '001_ref');
  const after = migration(changed.nodes, '001_ref');
  assert.equal(before.lastSeenRun, after.lastSeenRun);
  assert.match(String(before.props['replayInputHash']), /^[0-9a-f]{64}$/);
  assert.notEqual(before.props['replayInputHash'], after.props['replayInputHash']);
  assert.equal(after.props['replayInputHash'], migration(changed.nodes, '002_create').props['replayInputHash']);
  assert.notEqual(before.props['replaySnapshotHash'], after.props['replaySnapshotHash']);
  const source = changed.nodes.find((node) => node.kind === 'DataSource');
  assert.ok(source !== undefined);
  assert.equal(source.props['replaySnapshotHash'], after.props['replaySnapshotHash']);
});

for (const type of ['character varying(9)', 'double precision', 'timestamp(3) with time zone', 'text[]']) {
  test(`DDL type ${type} and checked default/check attributes preserve membership`, async (t) => {
    const out = await run(t, {
      '001_child.sql': `CREATE TABLE public.child (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, value ${type}, parent_id integer REFERENCES public.parent(id), state text DEFAULT 'open' CHECK (state IN ('open', 'closed')), flags text[] DEFAULT ARRAY['a', 'b']::text[]);`,
      '002_parent.sql': 'CREATE TABLE public.parent (id integer);',
    });
    assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
    assert.equal(migration(out.nodes, '001_child').props['unresolvedRefCount'], 2);
    assert.equal(migration(out.nodes, '001_child').props['replayUnknownStepCount'], 0);
  });
}

for (const tail of [
  'DEFAULT (SELECT run_ddl())',
  "DEFAULT 1 EXECUTE 'CREATE TABLE x(id int)'",
  'CHECK (value > 0; CREATE TABLE injected(id int))',
  'CHECK (value >)',
]) test(`an unsupported or malformed expression cannot donate membership: ${tail}`, async (t) => {
  const out = await run(t, {
    '001_bad.sql': `CREATE TABLE public.bad (value integer ${tail});`,
    '002_ref.sql': 'CREATE INDEX idx ON public.accounts(id);',
    '003_create.sql': 'CREATE TABLE public.accounts (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 0);
});

const CONSTRAINT_GUARD = "NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'child_parent_fk' AND conrelid = 'public.child'::regclass)";
const ADD_FOREIGN = 'ALTER TABLE public.child ADD CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES public.parent(id);';

test('literal table guards and a checked catalog guard examine the restored foreign key', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.child (id integer, parent_id integer); CREATE TABLE public.parent (id integer);',
    '002_restore.sql': `DO $$\nBEGIN\nIF to_regclass('public.child') IS NOT NULL AND to_regclass('public.parent') IS NOT NULL AND ${CONSTRAINT_GUARD} THEN\n${ADD_FOREIGN}\nEND IF;\nEND $$;`,
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  const ref = migration(out.nodes, '002_restore');
  assert.equal(ref.props['replayUnknownStepCount'], 0);
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 0);
  assert.equal(ref.props['validRefCount'], 4);
  assert.ok(rows(ref, 'validRefs').some((r) => r[1] === 'parent' && r[2] === 'id' && r[4] === 4));
});

test('a false literal table guard skips its references without donating declarations', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.child (id integer, parent_id integer);',
    '002_guard.sql': `DO $$ BEGIN IF to_regclass('public.parent') IS NOT NULL THEN ${ADD_FOREIGN} END IF; END $$;`,
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  const ref = migration(out.nodes, '002_guard');
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['skippedRefCount'], 4);
  assert.equal(ref.props['replayDeclarationCount'], 0);
});

test('an unknown constraint condition cannot certify a missing target as an unconditional contradiction', async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (id integer, parent_id integer);',
    '002_guard.sql': `DO $$ BEGIN IF ${CONSTRAINT_GUARD} THEN ${ADD_FOREIGN} END IF; END $$;`,
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  assert.equal(migration(out.nodes, '002_guard').props['unresolvedRefCount'], 0);
  assert.equal(migration(out.nodes, '002_guard').props['unknownRefCount'], 2);
});

test('checked guarded enum and function attributes leave declared table membership intact', async (t) => {
  const out = await run(t, {
    '001_meta.sql': `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fixture_kind') THEN CREATE TYPE public.fixture_kind AS ENUM ('one', 'two'); END IF; IF to_regprocedure('public.fixture()') IS NOT NULL THEN ALTER FUNCTION public.fixture() SET search_path = public, auth; END IF; END $$;`,
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

for (const body of [
  `IF ${CONSTRAINT_GUARD} THEN ${ADD_FOREIGN} EXECUTE unknown_source; END IF;`,
  `IF NOT EXISTS (SELECT run_ddl() FROM pg_constraint) THEN ${ADD_FOREIGN} END IF;`,
  `IF ${CONSTRAINT_GUARD} THEN ${ADD_FOREIGN} ELSE CREATE TABLE public.parent(id integer); END IF;`,
  `IF ${CONSTRAINT_GUARD} THEN ${ADD_FOREIGN} END IF; EXCEPTION WHEN OTHERS THEN NULL;`,
]) test(`a procedural tail or unknown call cannot supply a successful proof: ${body}`, async (t) => {
  const out = await run(t, {
    '001_opaque.sql': `DO $$ BEGIN ${body} END $$;`,
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 0);
});

function rlsLoop(body = "IF to_regclass(format('public.%I', item)) IS NOT NULL THEN EXECUTE format('alter table public.%I enable row level security', item); END IF;") {
  return `DO $$ DECLARE item text; BEGIN FOREACH item IN ARRAY ARRAY['accounts', 'parent'] LOOP ${body} END LOOP; END $$;`;
}

const SHADOW_FORMAT = "CREATE FUNCTION public.format(template text, value text) RETURNS text LANGUAGE sql AS $$ SELECT 'CREATE TABLE IF NOT EXISTS public.parent(id integer)' $$;";

test('a declared FORMAT overload prevents native template effect assumptions', async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_overload.sql': SHADOW_FORMAT,
    '002_loop.sql': rlsLoop("EXECUTE format('alter table public.%I enable row level security', item);"),
    '003_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '004_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_loop').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '003_ref').props['unresolvedRefCount'], 0);
});

for (const statement of [
  'DROP FUNCTION IF EXISTS pg_catalog.format(text, variadic any) RESTRICT;',
  'DROP FUNCTION IF EXISTS public.unused(), pg_catalog.format(text, text) RESTRICT;',
  'ALTER FUNCTION pg_catalog.format(text, text) SET search_path = public;',
  'CREATE AGGREGATE public.format(text, text) (sfunc = public.combine, stype = text);',
]) test(`a declared native-name routine change prevents native call assumptions: ${statement}`, async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_routine.sql': statement,
    '002_loop.sql': rlsLoop("EXECUTE format('alter table public.%I enable row level security', item);"),
    '003_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '004_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_loop').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '003_ref').props['unresolvedRefCount'], 0);
});

test('an unused routine declaration supplies no table facts or call-effect evidence', async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_overload.sql': SHADOW_FORMAT,
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  assert.equal(migration(out.nodes, '001_overload').props['replayDeclarationCount'], 0);
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

test('finite literal RLS loops preserve guarded table absence for the later reference', async (t) => {
  const out = await run(t, {
    '001_loop.sql': rlsLoop(),
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '001_loop').props['skippedRefCount'], 1);
  assert.equal(migration(out.nodes, '001_loop').props['unknownRefCount'], 1);
  assert.equal(rows(migration(out.nodes, '001_loop'), 'skippedRefs')[0]?.[1], 'parent');
  assert.equal(rows(migration(out.nodes, '001_loop'), 'unknownRefs')[0]?.[1], 'accounts');
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

for (const body of [
  "EXECUTE format('create table public.%I (id int)', item);",
  "EXECUTE format('alter table public.%I enable row level security', item); EXECUTE unknown_source;",
  "IF to_regclass(format('public.%I', item)) IS NOT NULL THEN EXECUTE format('alter table public.%I enable row level security', other); END IF;",
]) test(`finite loop parser rejects dynamic membership or extra effects: ${body}`, async (t) => {
  const out = await run(t, {
    '001_loop.sql': rlsLoop(body),
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 0);
});

test('homogeneous ADD lists declare their complete new column set before self references', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '002_add.sql': 'ALTER TABLE public.accounts ADD COLUMN parent integer REFERENCES public.accounts(other), ADD COLUMN other integer;',
  });
  assert.equal(out.result.status, 'PASS');
  const ref = migration(out.nodes, '002_add');
  assert.deepEqual(rows(ref, 'validRefs'), [
    ['public', 'accounts', 'other', 0, 1],
    ['public', 'accounts', 'parent', 0, 1],
    ['public', 'accounts', null, 0, 1],
  ]);
  assert.equal(ref.props['unknownRefCount'], 0);
  assert.equal(ref.props['unresolvedRefCount'], 0);
});

test('a stored function definition cannot populate the declared table catalog', async (t) => {
  const out = await run(t, {
    '001_definition.sql': "CREATE OR REPLACE FUNCTION public.prepare(p_id uuid DEFAULT NULL) RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$ BEGIN CREATE TABLE public.accounts (id int); RETURN new; END; $$; GRANT EXECUTE ON FUNCTION public.prepare(uuid) TO authenticated; REVOKE ALL ON FUNCTION public.prepare(uuid) FROM public;",
    '002_ref.sql': 'CREATE INDEX idx ON public.accounts(id);',
    '003_create.sql': 'CREATE TABLE public.accounts (id integer);',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '001_definition').props['replayDeclarationCount'], 0);
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

for (const definition of [
  "CREATE FUNCTION public.bad() RETURNS void LANGUAGE c AS 'library', 'symbol';",
  "CREATE FUNCTION public.bad() RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END $$ EXECUTE unknown_source;",
  'GRANT SELECT ON public.accounts TO authenticated EXECUTE unknown_source;',
  'REVOKE ALL ON public.accounts FROM public CASCADE;',
]) test(`an unsupported definition or privilege tail fails closed: ${definition}`, async (t) => {
  const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_opaque.sql': definition });
  assert.equal(out.result.status, 'UNAVAILABLE');
});

function dropCheckedConstraint(template = 'alter table public.entries drop constraint %I') {
  return `DO $$ DECLARE selected_name text; BEGIN
    SELECT c.conname INTO selected_name FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'public' AND r.relname = 'entries' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%status%';
    IF selected_name IS NOT NULL THEN EXECUTE format('${template}', selected_name); END IF;
  END $$;`;
}

test('a catalog-derived constraint identifier occupies only the checked format slot', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.entries (id integer);',
    '002_constraint.sql': dropCheckedConstraint(),
    '003_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '004_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '002_constraint').props['validRefCount'], 1);
  assert.equal(migration(out.nodes, '003_ref').props['unresolvedRefCount'], 2);
});

for (const template of [
  'alter table public.other drop constraint %I',
  'alter table public.entries drop constraint %s',
  'alter table public.entries drop constraint %I; create table public.parent(id int)',
]) test(`catalog-derived format templates reject extra or misbound effects: ${template}`, async (t) => {
  const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_opaque.sql': dropCheckedConstraint(template) });
  assert.equal(out.result.status, 'UNAVAILABLE');
});

test('index expressions, direction and predicates validate every referenced local column', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer, email text, active boolean);',
    '002_index.sql': 'CREATE INDEX idx ON public.accounts USING btree (lower(email), id DESC NULLS LAST) WHERE active AND missing IS NOT NULL;',
    '003_add.sql': 'ALTER TABLE public.accounts ADD COLUMN missing integer;',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  const ref = migration(out.nodes, '002_index');
  assert.equal(ref.props['validRefCount'], 4);
  assert.deepEqual(rows(ref, 'unresolvedRefs'), [['public', 'accounts', 'missing', 0, 1, '003_add', 0, 1]]);
});

for (const expression of ['other.id', 'lower(email) EXECUTE unknown_source', 'id DESC NULLS MIDDLE', '(SELECT id FROM other)']) {
  test(`unsupported index syntax cannot certify columns: ${expression}`, async (t) => {
    const out = await run(t, {
      '001_index.sql': `CREATE INDEX idx ON public.accounts (${expression});`,
      '002_create.sql': 'CREATE TABLE public.accounts (id integer, email text);',
    });
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(migration(out.nodes, '001_index').props['unresolvedRefCount'], 0);
  });
}

test('generated attributes and NOT VALID foreign keys retain examined local references', async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (value integer, derived integer GENERATED ALWAYS AS (value + 1) STORED); ALTER TABLE public.child ADD CONSTRAINT fixture_fk FOREIGN KEY(value) REFERENCES public.parent(id) NOT VALID;',
    '002_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  assert.equal(migration(out.nodes, '001_child').props['unresolvedRefCount'], 2);
});

test('checked trigger and privilege declarations do not donate or retire table columns', async (t) => {
  const out = await run(t, {
    '001_metadata.sql': 'CREATE TRIGGER fixture_hook AFTER INSERT OR UPDATE OF id ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.fixture_hook(); DROP TRIGGER IF EXISTS old_hook ON public.accounts; DROP POLICY IF EXISTS fixture_policy ON public.accounts; CREATE SEQUENCE IF NOT EXISTS public.fixture_sequence START WITH 1 INCREMENT BY 1; ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM public; DROP FUNCTION IF EXISTS public.old_hook(uuid) RESTRICT;',
    '002_ref.sql': 'CREATE INDEX idx ON public.accounts(id);',
    '003_create.sql': 'CREATE TABLE public.accounts (id integer);',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '001_metadata').props['replayDeclarationCount'], 0);
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

for (const sql of [
  'CREATE EVENT TRIGGER ddl_hook ON ddl_command_start EXECUTE FUNCTION public.fixture_hook();',
  'CREATE TRIGGER fixture_hook AFTER INSERT ON public.accounts EXECUTE FUNCTION public.fixture_hook() DROP TABLE public.accounts;',
  'DROP FUNCTION public.fixture_hook() CASCADE;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated EXECUTE unknown_source;',
  'CREATE TABLE public.accounts (value integer GENERATED ALWAYS AS (1) STORED EXECUTE unknown_source);',
]) test(`metadata or generated tails cannot hide unknown membership effects: ${sql}`, async (t) => {
  const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_opaque.sql': sql });
  assert.equal(out.result.status, 'UNAVAILABLE');
});

test('a declared view supplies its checked relation and projection columns', async (t) => {
  const out = await run(t, {
    '000_source.sql': 'CREATE TABLE public.source (id integer, label text);',
    '001_view.sql': 'CREATE OR REPLACE VIEW public.visible WITH (security_invoker = true) AS SELECT s.id, s.label AS display FROM public.source s;',
    '002_ref.sql': 'ALTER TABLE public.visible ALTER COLUMN display SET DEFAULT \'fixture\';',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.deepEqual(rows(migration(out.nodes, '001_view'), 'replayDeclarations'), [
    ['public', 'visible', 'display', 0, 1], ['public', 'visible', 'id', 0, 1], ['public', 'visible', null, 0, 1],
  ]);
  const ref = migration(out.nodes, '002_ref');
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 0);
  assert.equal(ref.props['validRefCount'], 2);
});

test('a fully named view projection can witness an earlier local reference', async (t) => {
  const out = await run(t, {
    '000_source.sql': 'CREATE TABLE public.source (id integer);',
    '001_ref.sql': 'CREATE INDEX idx ON public.visible(id);',
    '002_view.sql': 'CREATE VIEW public.visible(id) AS SELECT s.id FROM public.source s;',
  });
  assert.equal(out.result.status, 'PASS');
  const ref = migration(out.nodes, '001_ref');
  assert.equal(ref.props['unresolvedRefCount'], 2);
  assert.ok(rows(ref, 'unresolvedRefs').every((row) => row[5] === '002_view'));
});

test('lateral view queries keep explicit projection names without querying a database', async (t) => {
  const out = await run(t, {
    '000_source.sql': 'CREATE TABLE public.source (id integer, value integer);',
    '001_view.sql': 'CREATE VIEW public.visible AS SELECT s.id, recent.value FROM public.source s LEFT JOIN LATERAL (SELECT v.value FROM public.source v WHERE v.id = s.id ORDER BY v.id DESC LIMIT 1) recent ON true;',
    '002_ref.sql': 'ALTER TABLE public.visible ALTER COLUMN value SET DEFAULT 1;',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '001_view').props['replayDeclarationCount'], 3);
  assert.equal(migration(out.nodes, '002_ref').props['validRefCount'], 2);
  assert.equal(migration(out.nodes, '002_ref').props['unknownRefCount'], 0);
});

test('an unknown view projection has a named footprint and cannot certify missing columns', async (t) => {
  const out = await run(t, {
    '0000_before.sql': 'ALTER TABLE public.visible ADD COLUMN tag integer;',
    '000_source.sql': 'CREATE TABLE public.source (id integer);',
    '001_view.sql': 'CREATE VIEW public.visible AS SELECT * FROM public.source;',
    '002_ref.sql': 'ALTER TABLE public.visible ALTER COLUMN id SET DEFAULT 1;',
    '003_other.sql': 'CREATE INDEX idx ON public.parent(id);',
    '004_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '001_view').props['replayDeclarationCount'], 0);
  assert.equal(migration(out.nodes, '0000_before').props['externalRefCount'], 0);
  assert.equal(migration(out.nodes, '0000_before').props['unknownRefCount'], 1);
  const ref = migration(out.nodes, '002_ref');
  assert.equal(ref.props['unresolvedRefCount'], 0);
  assert.equal(ref.props['unknownRefCount'], 2);
  assert.equal(migration(out.nodes, '003_other').props['unresolvedRefCount'], 2);
});

test('DROP TABLE cannot erase a possibly created view and certify absence', async (t) => {
  const out = await run(t, {
    '000_source.sql': 'CREATE TABLE public.source (id integer);',
    '001_view.sql': 'CREATE VIEW public.visible AS SELECT * FROM public.source;',
    '002_drop.sql': 'DROP TABLE public.visible;',
    '003_ref.sql': 'CREATE INDEX idx ON public.visible(id);',
    '004_view.sql': 'CREATE VIEW public.visible AS SELECT id FROM public.source;',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '003_ref').props['unresolvedRefCount'], 0);
  assert.equal(migration(out.nodes, '003_ref').props['replayInventoryComplete'], false);
});

test('view replacement cannot donate columns to an existing table', async (t) => {
  const out = await run(t, {
    '000_source.sql': 'CREATE TABLE public.source (id integer, future integer); CREATE TABLE public.kept (id integer);',
    '001_view.sql': 'CREATE OR REPLACE VIEW public.kept AS SELECT id, future FROM public.source;',
    '002_ref.sql': 'ALTER TABLE public.kept ALTER COLUMN future SET DEFAULT 1;',
    '003_add.sql': 'ALTER TABLE public.kept ADD COLUMN future integer;',
  });
  assert.equal(out.result.status, 'PASS');
  assert.equal(migration(out.nodes, '001_view').props['replayDeclarationCount'], 0);
  assert.deepEqual(rows(migration(out.nodes, '002_ref'), 'unresolvedRefs'), [['public', 'kept', 'future', 0, 1, '003_add', 0, 1]]);
});

for (const query of ['SELECT id INTO public.other FROM public.source', 'SELECT * AS named FROM public.source', 'SELECT id FROM LATERAL public.source', 'WITH hidden AS (DELETE FROM public.source RETURNING id) SELECT id FROM hidden']) {
  test(`unsupported view query syntax cannot become a membership no-op: ${query}`, async (t) => {
    const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_view.sql': `CREATE VIEW public.visible AS ${query};` });
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(migration(out.nodes, '001_view').props['replayInventoryComplete'], false);
  });
}

test('stored access predicates are checked without becoming table creation evidence', async (t) => {
  const out = await run(t, {
    '001_policy.sql': 'CREATE POLICY fixture_policy ON public.accounts AS RESTRICTIVE FOR UPDATE TO authenticated USING (auth.uid() = owner_id) WITH CHECK (active AND status IN (\'open\', \'closed\'));',
    '002_ref.sql': 'CREATE INDEX idx ON public.accounts(id);',
    '003_create.sql': 'CREATE TABLE public.accounts (id integer, owner_id uuid, active boolean, status text);',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '001_policy').props['replayDeclarationCount'], 0);
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

test('long stored policy labels contribute no identifier or membership evidence', async (t) => {
  const name = 'fixture policy label '.repeat(5);
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_policy.sql': `CREATE POLICY "${name}" ON public.kept USING (id > 0); DROP POLICY "${name}" ON public.kept;`,
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  assert.equal(migration(out.nodes, '001_policy').props['replayDeclarationCount'], 0);
  assert.equal(migration(out.nodes, '001_policy').props['replayReferenceCount'], 0);
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

for (const predicate of [
  'owner_id = (SELECT auth.uid())',
  'EXISTS (SELECT 1 FROM public.members m JOIN public.users u ON u.id = m.user_id WHERE m.family_id = accounts.id AND u.auth_id = auth.uid())',
  'owner_id IN (SELECT user_id FROM public.members WHERE active) AND NOT EXISTS (SELECT 1 FROM public.blocked b WHERE b.id = owner_id)',
  'EXISTS (WITH visible AS (SELECT id FROM public.members WHERE active) SELECT v.id FROM visible v LEFT JOIN public.users u USING (id) WHERE u.id IS NOT NULL)',
  "EXISTS (SELECT DISTINCT ON (id) id FROM public.members ORDER BY id DESC NULLS LAST LIMIT 1 OFFSET 0)",
  '(fixture.foldername(name))[1] = (SELECT auth.uid())::text',
]) test(`closed stored policy queries preserve later reference evidence: ${predicate}`, async (t) => {
  const out = await run(t, {
    '001_policy.sql': `CREATE POLICY fixture_policy ON public.accounts USING (${predicate});`,
    '002_ref.sql': 'CREATE INDEX idx ON public.accounts(id);',
    '003_create.sql': 'CREATE TABLE public.accounts (id integer);',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '001_policy').props['replayInventoryComplete'], true);
  assert.equal(migration(out.nodes, '001_policy').props['replayDeclarationCount'], 0);
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

for (const predicate of [
  'EXISTS (SELECT 1 INTO public.parent)',
  'EXISTS (WITH hidden AS (SELECT 1 INTO public.parent) SELECT 1 FROM hidden)',
  'EXISTS (WITH hidden AS (DELETE FROM public.parent RETURNING id) SELECT 1 FROM hidden)',
  'EXISTS (SELECT 1 FROM public.members JOIN public.users)',
  'EXISTS (SELECT 1 EXECUTE)',
  'EXISTS (SELECT id FROM public.members WHERE)',
  'EXISTS (SELECT 1; CREATE TABLE public.parent(id integer))',
  '(fixture.foldername(name))[] = owner_id',
  '(fixture.foldername(name))[1,2] = owner_id',
]) test(`unsupported stored query syntax withholds the complete inventory: ${predicate}`, async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_policy.sql': `CREATE POLICY fixture_policy ON public.kept USING (${predicate});`,
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '001_policy').props['replayInventoryComplete'], false);
});

test('stored-policy query support does not admit subqueries in CHECK or DEFAULT expressions', async (t) => {
  for (const declaration of [
    'CREATE TABLE public.bad (id integer DEFAULT (SELECT 1));',
    'CREATE TABLE public.bad (id integer CHECK (id IN (SELECT id FROM public.kept)));',
  ]) {
    const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_bad.sql': declaration });
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(migration(out.nodes, '001_bad').props['replayInventoryComplete'], false);
  }
});

for (const sql of [
  'INSERT INTO public.kept(id) VALUES (1), (2) ON CONFLICT(id) DO UPDATE SET id = excluded.id;',
  'WITH seed AS (SELECT 1 AS id) INSERT INTO public.kept(id) SELECT s.id FROM seed s ON CONFLICT(id) DO NOTHING;',
  'INSERT INTO public.kept(id) SELECT v.id FROM (VALUES (1),(2)) AS v(id) RETURNING id;',
  'UPDATE public.kept k SET id = coalesce(k.id, s.id) FROM public.source s LEFT JOIN public.flags f ON f.id = s.id WHERE k.id IS NULL;',
  'WITH grouped AS (SELECT owner_id, min(id) AS id FROM public.source GROUP BY owner_id HAVING count(DISTINCT id) = 1) UPDATE public.kept k SET id = g.id FROM grouped g WHERE k.id = g.owner_id;',
  'WITH grouped AS (SELECT owner_id, (array_agg(id ORDER BY created_at NULLS LAST, id::text))[1] AS id FROM public.source GROUP BY owner_id HAVING count(*) = 1) UPDATE public.kept k SET id = g.id FROM grouped g WHERE k.id = g.owner_id;',
  'WITH removed AS (DELETE FROM public.kept WHERE id IN (SELECT id FROM public.source) RETURNING id) INSERT INTO public.kept(id) SELECT id FROM removed;',
  'DELETE FROM public.kept k USING public.source s WHERE s.id = k.id RETURNING k.id;',
]) test(`closed row writes cannot populate the table membership catalog: ${sql}`, async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_rows.sql': sql,
    '002_ref.sql': 'CREATE INDEX idx ON public.accounts(id);',
    '003_create.sql': 'CREATE TABLE public.accounts (id integer);',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '001_rows').props['replayDeclarationCount'], 0);
  assert.equal(migration(out.nodes, '001_rows').props['replayInventoryComplete'], true);
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

for (const sql of [
  'INSERT INTO public.kept(id) SELECT id INTO public.parent FROM public.source;',
  'WITH hidden AS (SELECT 1 INTO public.parent) UPDATE public.kept SET id = 1;',
  'WITH hidden AS (CREATE TABLE public.parent(id integer)) UPDATE public.kept SET id = 1;',
  'INSERT INTO public.kept(id) VALUES(1) ON CONFLICT DO UPDATE SET id = 2;',
  'UPDATE public.kept SET id = WHERE;',
  'UPDATE public.kept SET id = 1 WHERE AND;',
  'UPDATE public.kept SET id = 1 EXECUTE unknown_source;',
  'INSERT INTO public.kept(id) VALUES(1), (1,2);',
  'DO $$ BEGIN INSERT INTO public.kept(id) SELECT arbitrary_call(); END $$;',
  'DO $$ BEGIN UPDATE public.kept SET id = arbitrary_call(); END $$;',
  'DO $$ BEGIN WITH hidden AS (SELECT arbitrary_call()) INSERT INTO public.kept(id) SELECT 1 FROM hidden; END $$;',
  'DO $$ BEGIN DELETE FROM public.kept WHERE arbitrary_call(); END $$;',
  'WITH changed AS (DROP TABLE public.parent) INSERT INTO public.kept(id) SELECT 1;',
  'WITH changed AS (DELETE FROM public.kept WHERE) INSERT INTO public.kept(id) SELECT 1;',
  'WITH changed AS (DELETE FROM public.kept RETURNING id; CREATE TABLE public.parent(id integer)) INSERT INTO public.kept(id) SELECT id FROM changed;',
]) test(`unconsumed or unsupported row-write syntax withholds replay: ${sql}`, async (t) => {
  const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_rows.sql': sql });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '001_rows').props['replayInventoryComplete'], false);
});

for (const options of ['START 0', 'INCREMENT 0', 'START 1.5', 'START 9223372036854775808']) test(`unsupported sequence bounds cannot establish relation existence: ${options}`, async (t) => {
  const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_sequence.sql': `CREATE SEQUENCE public.marker ${options};` });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '001_sequence').props['replayInventoryComplete'], false);
});

for (const predicate of ['active EXECUTE unknown_source', 'active; CREATE TABLE public.parent(id int)', 'owner_id =']) {
  test(`an unconsumed policy predicate withholds membership: ${predicate}`, async (t) => {
    const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_opaque.sql': `CREATE POLICY fixture ON public.accounts USING (${predicate});` });
    assert.equal(out.result.status, 'UNAVAILABLE');
  });
}

test('regex CHECK predicates and index operator classes are parsed without evaluating them', async (t) => {
  const out = await run(t, {
    '001_create.sql': "CREATE TABLE public.entries (id integer, label text CHECK (label ~ '^[a-z]+$'));",
    '002_index.sql': 'CREATE INDEX idx ON public.entries USING gin (label fixture_ops);',
  });
  assert.equal(out.result.status, 'PASS');
  assert.deepEqual(rows(migration(out.nodes, '002_index'), 'validRefs'), [
    ['public', 'entries', 'label', 0, 1], ['public', 'entries', null, 0, 1],
  ]);
});

for (const expression of ["label ~ '^[a-z]+$'", "label ~* '^[a-z]+$'", "label !~ '^[a-z]+$'", "label !~* '^[a-z]+$'"]) {
  test(`a checked regex operator preserves a later foreign-key witness: ${expression}`, async (t) => {
    const out = await run(t, {
      '001_child.sql': `CREATE TABLE public.child (label text CHECK (${expression}), id integer REFERENCES public.parent(id));`,
      '002_parent.sql': 'CREATE TABLE public.parent (id integer);',
    });
    assert.equal(out.result.status, 'PASS');
    assert.equal(migration(out.nodes, '001_child').props['unresolvedRefCount'], 2);
  });
}

function functionPrivilegeLoop(type = 'regprocedure', template = 'revoke execute on function %s from public', selected = 'p.oid::regprocedure') {
  return `DO $$ DECLARE target ${type}; BEGIN FOR target IN
    SELECT ${selected} FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef LOOP
      EXECUTE format('${template}', target);
    END LOOP; END $$;`;
}

function tablePrivilegeLoop(type = 'record', template = 'revoke all privileges on table %I.%I from anon, authenticated') {
  return `DO $$ DECLARE target ${type}; BEGIN FOR target IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relrowsecurity
      AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = n.nspname AND p.tablename = c.relname)
    LOOP EXECUTE format('${template}', target.schema_name, target.table_name);
    END LOOP; END $$;`;
}

test('typed table-privilege loops close their catalog and identifier-format footprint', async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_privileges.sql': tablePrivilegeLoop(),
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '001_privileges').props['replayUnknownStepCount'], 0);
  assert.equal(migration(out.nodes, '001_privileges').props['replayDeclarationCount'], 0);
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

for (const sql of [
  tablePrivilegeLoop('text'),
  tablePrivilegeLoop('record', 'revoke all privileges on table %I.%s from anon, authenticated'),
  tablePrivilegeLoop('record', 'revoke all privileges on table %i.%i from anon, authenticated'),
  tablePrivilegeLoop('record', 'revoke all privileges on table %I.%I from anon, authenticated; drop table public.parent'),
  tablePrivilegeLoop().replace('target.schema_name, target.table_name', 'target.table_name, target.schema_name'),
  tablePrivilegeLoop().replace('END LOOP;', 'EXECUTE arbitrary_source; END LOOP;'),
  tablePrivilegeLoop().replace('n.nspname AS schema_name', 'arbitrary_call() AS schema_name'),
]) test(`table-privilege loops reject open or misbound effects: ${sql.slice(0, 90)}`, async (t) => {
  const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_opaque.sql': sql });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '001_opaque').props['replayInventoryComplete'], false);
});

for (const statement of [
  "UPDATE pg_catalog.pg_class SET relname = 'parent' WHERE oid = 'public.existing'::regclass;",
  "UPDATE pg_class SET relname = 'parent' WHERE oid = 'public.existing'::regclass;",
  "INSERT INTO pg_catalog.pg_attribute (attname) VALUES ('id');",
  "DELETE FROM pg_catalog.pg_attribute WHERE attname = 'id';",
  "WITH changed AS (UPDATE pg_catalog.pg_class SET relname = 'parent' RETURNING oid) SELECT oid FROM changed;",
  "WITH changed AS (DELETE FROM pg_attribute WHERE attname = 'id' RETURNING attrelid) SELECT attrelid FROM changed;",
  "UPDATE information_schema.columns SET column_name = 'id';",
]) test(`catalog row writes cannot certify membership-neutral effects: ${statement}`, async (t) => {
  const out = await run(t, {
    '001_existing.sql': 'CREATE TABLE public.existing (id integer);',
    '002_catalog.sql': statement,
    '003_ref.sql': 'CREATE TABLE public.child (id integer REFERENCES public.parent(id));',
    '004_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_catalog').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '003_ref').props['unresolvedRefCount'], 0);
});

for (const statement of [
  "UPDATE public.catalog_proxy SET relname = 'parent' WHERE oid = 'public.existing'::regclass;",
  "WITH changed AS (UPDATE public.catalog_proxy SET relname = 'parent' RETURNING oid) SELECT oid FROM changed;",
  "INSERT INTO public.catalog_proxy (relname) VALUES ('parent');",
  "DELETE FROM public.catalog_proxy WHERE relname = 'existing';",
]) test(`writes through a declared view cannot certify a row-only effect footprint: ${statement}`, async (t) => {
  const out = await run(t, {
    '001_existing.sql': 'CREATE TABLE public.existing (id integer);',
    '002_view.sql': 'CREATE VIEW public.catalog_proxy AS SELECT oid, relname FROM pg_catalog.pg_class;',
    '003_write.sql': statement,
    '004_ref.sql': 'CREATE TABLE public.child (id integer REFERENCES public.parent(id));',
    '005_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '003_write').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '004_ref').props['unresolvedRefCount'], 0);
});

for (const [move, target] of [
  ['ALTER TABLE public.catalog_proxy RENAME TO renamed_proxy;', 'public.renamed_proxy'],
  ['ALTER TABLE public.catalog_proxy SET SCHEMA archive;', 'archive.catalog_proxy'],
] as const) test(`renamed view writes retain their unproved rewrite footprint: ${move}`, async (t) => {
  const out = await run(t, {
    '001_existing.sql': 'CREATE TABLE public.existing (id integer); CREATE SCHEMA archive;',
    '002_view.sql': 'CREATE VIEW public.catalog_proxy AS SELECT oid, relname FROM pg_catalog.pg_class;',
    '003_move.sql': move,
    '004_write.sql': `WITH changed AS (UPDATE ${target} SET relname = 'parent' RETURNING oid) SELECT oid FROM changed;`,
    '005_ref.sql': 'CREATE TABLE public.child (id integer REFERENCES public.parent(id));',
    '006_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '004_write').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '005_ref').props['unresolvedRefCount'], 0);
});

test('an external row-write target cannot establish a physical-table effect exemption', async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_external.sql': 'UPDATE public.external_proxy SET id = 1;',
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 0);
});

test('catalog writes remain unsupported after a conditional declaration establishes a target name', async (t) => {
  const out = await run(t, {
    '001_existing.sql': 'CREATE TABLE public.existing (id integer); CREATE TABLE IF NOT EXISTS pg_catalog.pg_class (oid oid, relname text);',
    '002_catalog.sql': "UPDATE pg_catalog.pg_class SET relname = 'parent' WHERE oid = 'public.existing'::regclass;",
    '003_ref.sql': 'CREATE TABLE public.child (id integer REFERENCES public.parent(id));',
    '004_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_catalog').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '003_ref').props['unresolvedRefCount'], 0);
});

test('an explicitly qualified project table with a catalog-like name retains ordinary row semantics', async (t) => {
  const out = await run(t, {
    '001_rows.sql': "CREATE TABLE public.pg_fixture(id integer); UPDATE public.pg_fixture SET id = 1;",
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

for (const expression of ['public.ensure_parent()', '(public.ensure_parent())', 'id > 0 AND public.ensure_parent()', 'id IN (public.ensure_parent())', 'CAST(public.ensure_parent() AS boolean)']) test(`procedural CHECK validation cannot hide an unproved call: ${expression}`, async (t) => {
  const out = await run(t, {
    '001_existing.sql': 'CREATE TABLE public.existing (id integer); INSERT INTO public.existing(id) VALUES (1);',
    '002_function.sql': "CREATE FUNCTION public.ensure_parent() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN CREATE TABLE IF NOT EXISTS public.parent(id integer); RETURN true; END $$;",
    '003_check.sql': `DO $$ BEGIN IF to_regclass('public.existing') IS NOT NULL THEN ALTER TABLE public.existing ADD CONSTRAINT checked CHECK (${expression}); END IF; END $$;`,
    '004_ref.sql': 'CREATE TABLE public.child (id integer REFERENCES public.parent(id));',
    '005_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '003_check').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '004_ref').props['unresolvedRefCount'], 0);
});

for (const statement of [
  'CREATE TABLE public.Ä(id integer);',
  'CREATE TABLE public.child(Ä integer REFERENCES public.parent(id));',
  'CREATE TABLE public.child(id integer, FOREIGN KEY (Ä) REFERENCES public.parent(id));',
  'CREATE VIEW public.projected AS SELECT Ä FROM public.existing;',
  "DO $$ BEGIN IF to_regclass('public.Ä') IS NOT NULL THEN ALTER TABLE public.kept ENABLE ROW LEVEL SECURITY; END IF; END $$;",
]) test(`unquoted Unicode cannot borrow JavaScript identifier folding: ${statement}`, async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_unicode.sql': statement,
    '002_ref.sql': 'ALTER TABLE public."Ä" ADD COLUMN tag integer;',
    '003_parent.sql': 'CREATE TABLE IF NOT EXISTS public."Ä" (id integer); CREATE TABLE public.parent(id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '001_unicode').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 0);
});

test('quoted UTF-8 identifiers retain exact case within the byte bound', async (t) => {
  const out = await run(t, {
    '001_upper.sql': 'CREATE TABLE public."Ä" (id integer);',
    '002_valid.sql': 'ALTER TABLE public."Ä" ADD COLUMN tag integer;',
    '003_lower.sql': 'ALTER TABLE public."ä" ADD COLUMN tag integer;',
    '004_create.sql': 'CREATE TABLE public."ä" (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  assert.equal(migration(out.nodes, '002_valid').props['unresolvedRefCount'], 0);
  assert.equal(migration(out.nodes, '003_lower').props['unresolvedRefCount'], 1);
});

for (const [call, expected] of [
  ['public.pg_get_constraintdef(1)', 'UNAVAILABLE'],
  ['"public"."pg_get_constraintdef"(1)', 'UNAVAILABLE'],
  ['pg_get_constraintdef(1)', 'PASS'],
  ['pg_catalog.pg_get_constraintdef(1)', 'PASS'],
] as const) test(`catalog helper qualification is checked without an independently unsupported body: ${call}`, async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_guard.sql': `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_type WHERE ${call} IS NOT NULL) THEN ALTER TABLE public.kept ADD CONSTRAINT positive CHECK (id > 0); END IF; END $$;`,
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, expected, out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '001_guard').props['replayInventoryComplete'], expected === 'PASS');
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], expected === 'PASS' ? 2 : 0);
});

for (const action of ['VALIDATE CONSTRAINT checked', 'ALTER COLUMN id TYPE integer', 'ALTER COLUMN id SET DEFAULT public.ensure_parent()']) test(`procedural validation and coercion cannot borrow an unproved stored effect: ${action}`, async (t) => {
  const out = await run(t, {
    '001_existing.sql': 'CREATE TABLE public.existing (id integer); INSERT INTO public.existing(id) VALUES (1);',
    '002_function.sql': "CREATE FUNCTION public.ensure_parent() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN CREATE TABLE IF NOT EXISTS public.parent(id integer); RETURN true; END $$;",
    '003_constraint.sql': 'ALTER TABLE public.existing ADD CONSTRAINT checked CHECK (public.ensure_parent()) NOT VALID;',
    '004_validate.sql': `DO $$ BEGIN IF to_regclass('public.existing') IS NOT NULL THEN ALTER TABLE public.existing ${action}; END IF; END $$;`,
    '005_ref.sql': 'CREATE TABLE public.child (id integer REFERENCES public.parent(id));',
    '006_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '004_validate').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '005_ref').props['unresolvedRefCount'], 0);
});

for (const helper of ['to_regclaſſ', 'to_regclaſs']) test(`procedural keyword matching cannot turn a distinct UTF-8 callee into a native guard: ${helper}`, async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_function.sql': `CREATE FUNCTION public."${helper}"(name text) RETURNS regclass LANGUAGE plpgsql AS $$ BEGIN CREATE TABLE IF NOT EXISTS public.parent(id integer); RETURN 'public.parent'::regclass; END $$;`,
    '002_guard.sql': `DO $$ BEGIN IF ${helper}('public.parent') IS NOT NULL THEN ALTER TABLE public.kept ADD CONSTRAINT positive CHECK (id > 0); END IF; END $$;`,
    '003_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '004_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_guard').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '003_ref').props['unresolvedRefCount'], 0);
});

test('an unconditional exception cannot certify a subsequent unreachable reference', async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (id integer);',
    '002_stop.sql': "DO $$ BEGIN RAISE EXCEPTION 'stop'; ALTER TABLE public.child ADD CONSTRAINT fk FOREIGN KEY(id) REFERENCES public.parent(id); END $$;",
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_stop').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '002_stop').props['unresolvedRefCount'], 0);
});

test('a project view read cannot hide an unproved procedural call effect', async (t) => {
  const out = await run(t, {
    '000_child.sql': 'CREATE TABLE public.child (id integer);',
    '001_function.sql': "CREATE FUNCTION public.ensure_parent() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN CREATE TABLE IF NOT EXISTS public.parent(id integer); RETURN false; END $$;",
    '002_view.sql': 'CREATE VIEW public.gate AS SELECT public.ensure_parent() AS ready;',
    '003_guard.sql': 'DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.gate WHERE ready) THEN ALTER TABLE public.child ADD CONSTRAINT positive CHECK (id > 0); END IF; END $$;',
    '004_ref.sql': 'ALTER TABLE public.child ADD CONSTRAINT fk FOREIGN KEY(id) REFERENCES public.parent(id);',
    '005_parent.sql': 'CREATE TABLE IF NOT EXISTS public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '003_guard').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '004_ref').props['unresolvedRefCount'], 0);
});

for (const relation of ['public.pg_type', 'pg_catalog.pg_type']) test(`catalog guard reads require an unchanged native relation: ${relation}`, async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_view.sql': `CREATE OR REPLACE VIEW ${relation} AS SELECT public.ensure_parent() AS typname;`,
    '002_guard.sql': `DO $$ BEGIN IF EXISTS (SELECT 1 FROM ${relation} WHERE typname = 'fixture') THEN ALTER TABLE public.kept ADD CONSTRAINT positive CHECK (id > 0); END IF; END $$;`,
    '003_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '004_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '002_guard').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '003_ref').props['unresolvedRefCount'], 0);
});

test('row assertions with unproved read and exception effects withhold replay', async (t) => {
  const out = await run(t, {
    '000_kept.sql': KEPT_SQL,
    '001_assert.sql': "DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.child c LEFT JOIN public.parent p ON p.id = c.id WHERE p.id IS NULL) THEN RAISE EXCEPTION 'fixture assertion failed'; END IF; END $$;",
    '002_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '001_assert').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 0);
});

for (const body of [
  "IF EXISTS (SELECT arbitrary_call()) THEN RAISE EXCEPTION 'fixture'; END IF;",
  "IF EXISTS (SELECT 1 WHERE public.exists()) THEN RAISE EXCEPTION 'fixture'; END IF;",
  "IF EXISTS (SELECT 1 FROM pg_type WHERE public.pg_get_constraintdef(1)) THEN RAISE EXCEPTION 'fixture'; END IF;",
  "IF EXISTS (SELECT 1 INTO public.parent) THEN RAISE EXCEPTION 'fixture'; END IF;",
  "RAISE EXCEPTION format('fixture');",
  "RAISE EXCEPTION 'fixture %', arbitrary_call();",
  "RAISE EXCEPTION 'fixture'; EXECUTE arbitrary_source;",
  "RAISE EXCEPTION 'fixture'; EXCEPTION WHEN OTHERS THEN NULL;",
]) test(`assertion procedures cannot hide unknown calls or mutation syntax: ${body}`, async (t) => {
  const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_opaque.sql': `DO $$ BEGIN ${body} END $$;` });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '001_opaque').props['replayInventoryComplete'], false);
});

test('typed catalog function-privilege loops have no declared table membership effects', async (t) => {
  const out = await run(t, {
    '001_privileges.sql': functionPrivilegeLoop(),
    '002_ref.sql': 'CREATE INDEX idx ON public.accounts(id);',
    '003_create.sql': 'CREATE TABLE public.accounts (id integer);',
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('\n'));
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 2);
});

for (const sql of [
  functionPrivilegeLoop('text'),
  functionPrivilegeLoop('regprocedure', 'revoke execute on function %s from public', 'p.proname'),
  functionPrivilegeLoop('regprocedure', 'create table %s (id integer)'),
  functionPrivilegeLoop('regprocedure', 'revoke execute on function %s from public; drop table public.accounts'),
]) test(`function-privilege loops reject untyped or unbound SQL effects: ${sql}`, async (t) => {
  const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_opaque.sql': sql });
  assert.equal(out.result.status, 'UNAVAILABLE');
});

test('invalid UTF-8 cannot be replaced into an apparently complete migration', async (t) => {
  const malformed = Buffer.concat([
    Buffer.from("CREATE TABLE public.placeholder (label text DEFAULT '"),
    Buffer.from([0xff]),
    Buffer.from("');"),
  ]);
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '002_bad.sql': malformed,
    '003_ref.sql': 'CREATE INDEX idx ON public.parent(id);',
    '004_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '003_ref').props['replayInventoryComplete'], false);
  assert.equal(migration(out.nodes, '003_ref').props['unresolvedRefCount'], 0);
});

test('a literal replacement character in valid UTF-8 remains an exact quoted identifier', async (t) => {
  const out = await run(t, {
    '001_child.sql': 'CREATE TABLE public.child (id integer REFERENCES public."Parent�"(id));',
    '002_parent.sql': 'CREATE TABLE public."Parent�" (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  const ref = migration(out.nodes, '001_child');
  assert.equal(ref.props['unresolvedRefCount'], 2);
  assert.ok(rows(ref, 'unresolvedRefs').every((row) => row[1] === 'Parent�'));
});

for (const long of ['a'.repeat(64), 'é'.repeat(32)]) {
  test(`unsupported identifier byte lengths cannot create a truncation contradiction: ${Buffer.byteLength(long)}`, async (t) => {
    const short = long.startsWith('a') ? long.slice(0, 63) : 'é'.repeat(31);
    const out = await run(t, {
      '001_long.sql': `CREATE TABLE public."${long}" (id integer);`,
      '002_ref.sql': `ALTER TABLE public."${short}" ADD COLUMN tag integer;`,
      '003_short.sql': `CREATE TABLE IF NOT EXISTS public."${short}" (id integer);`,
    });
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(migration(out.nodes, '002_ref').props['replayInventoryComplete'], false);
    assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 0);
  });
}

for (const sql of [
  `CREATE TABLE "${'s'.repeat(64)}".kept (id integer);`,
  `CREATE TABLE public.kept ("${'c'.repeat(64)}" integer);`,
  `CREATE TABLE public.kept (id integer CONSTRAINT "${'k'.repeat(64)}" PRIMARY KEY);`,
  `DO $$ DECLARE item text; BEGIN FOREACH item IN ARRAY ARRAY['${'t'.repeat(64)}'] LOOP EXECUTE format('alter table public.%I enable row level security', item); END LOOP; END $$;`,
]) test(`all identifier-producing syntax observes the supported byte bound: ${sql.slice(0, 90)}`, async (t) => {
  const out = await run(t, { '000_kept.sql': 'CREATE TABLE public.other (id integer);', '001_long.sql': sql });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(migration(out.nodes, '001_long').props['replayInventoryComplete'], false);
});

test('valid 63-byte multibyte identifiers retain exact reference evidence', async (t) => {
  const name = `${'é'.repeat(31)}a`;
  assert.equal(Buffer.byteLength(name), 63);
  const out = await run(t, {
    '001_create.sql': `CREATE TABLE public."${name}" (id integer);`,
    '002_ref.sql': `ALTER TABLE public."${name}" ADD COLUMN tag integer;`,
  });
  assert.equal(out.result.status, 'PASS');
  assert.equal(migration(out.nodes, '002_ref').props['unresolvedRefCount'], 0);
  assert.deepEqual(rows(migration(out.nodes, '002_ref'), 'validRefs'), [['public', name, null, 0, 1]]);
});

test('certificate content stamps are independent of the run epoch', async (t) => {
  const sql = {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '002_ref.sql': 'ALTER TABLE public.accounts ADD COLUMN tag integer;',
  };
  const a = await run(t, sql, 'postgres', 'before');
  const b = await run(t, sql, 'postgres', 'after');
  assert.equal(a.result.status, 'PASS');
  assert.equal(b.result.status, 'PASS');
  const left = migration(a.nodes, '002_ref'), right = migration(b.nodes, '002_ref');
  assert.notEqual(left.props['replayEpoch'], right.props['replayEpoch']);
  assert.equal(left.props['replaySnapshotHash'], right.props['replaySnapshotHash']);
});

test('uncertain ALTER actions retain distinct bounded logical positions', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (first integer, second integer);',
    '002_collision.sql': 'ALTER TABLE public.accounts ADD COLUMN first integer, ADD COLUMN second integer;',
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  const node = migration(out.nodes, '002_collision');
  assert.equal(node.props['replayStepCount'], 2);
  assert.equal(node.props['replayUnknownStepCount'], 2);
  assert.equal(node.props['replayUnknownSteps'], '[0,1]');
  assert.equal(node.props['replayInventoryComplete'], false);
});

test('unquoted schema names in constant loop templates fold independently of format directives', async (t) => {
  const out = await run(t, {
    '001_create.sql': 'CREATE TABLE public.accounts (id integer);',
    '002_loop.sql': rlsLoop("EXECUTE format('ALTER TABLE PUBLIC.%I ENABLE ROW LEVEL SECURITY', item);"),
    '003_parent.sql': 'CREATE TABLE public.parent (id integer);',
  });
  assert.equal(out.result.status, 'PASS');
  const loop = migration(out.nodes, '002_loop');
  assert.equal(loop.props['validRefCount'], 1);
  assert.equal(loop.props['unresolvedRefCount'], 1);
  assert.equal(loop.props['externalRefCount'], 0);
  assert.equal(rows(loop, 'unresolvedRefs')[0]?.[0], 'public');
});

for (const sql of [
  rlsLoop("EXECUTE format('alter table public.%i enable row level security', item);"),
  dropCheckedConstraint('alter table public.entries drop constraint %i'),
  functionPrivilegeLoop('regprocedure', 'revoke execute on function %S from public'),
]) test(`format directive case is never treated as SQL keyword case: ${sql}`, async (t) => {
  const out = await run(t, { '000_kept.sql': KEPT_SQL, '001_opaque.sql': sql });
  assert.equal(out.result.status, 'UNAVAILABLE');
});
