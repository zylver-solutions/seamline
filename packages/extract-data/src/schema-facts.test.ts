/**
 * `insertTrigger`, `declarations` and `dynamicDdl`: what the schema sources say
 * about writers the column list of an insert cannot see (design
 * `real-world-inputs.md` sections 5.1 items 6 and 8, and 5.2).
 *
 * The tri-state is the point. Each prop is written as a count or a boolean when
 * every file that could contradict it was read, and left off when one was not,
 * so a consumer can tell "none" from "unknown".
 */

import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { canonicalSif } from './emit.ts';
import { extractData, type ExtractDataOptions, type ExtractDataOutput } from './extractor.ts';

type Files = Readonly<Record<string, string>>;

async function extractFiles(
  files: Files,
  extra: Partial<ExtractDataOptions> = {},
): Promise<ExtractDataOutput> {
  const dir = await mkdtemp(join(tmpdir(), 'seamline-schema-facts-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text, 'utf8');
    }
    return await extractData({
      root: dir,
      repo: 'demo',
      runId: 'r1',
      deterministic: true,
      ...extra,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One prop of every Table, keyed `schema.table`, `undefined` where the prop is absent. */
function tableProp(out: ExtractDataOutput, prop: string): Record<string, unknown> {
  return Object.fromEntries(
    out.nodes
      .filter((n) => n.kind === 'Table')
      .map((n) => [`${String(n.props['schema'])}.${String(n.props['table'])}`, n.props[prop]]),
  );
}

function dataSourceProp(out: ExtractDataOutput, prop: string): unknown {
  const ds = out.nodes.find((n) => n.kind === 'DataSource');
  assert.ok(ds !== undefined, 'no DataSource node');
  return ds.props[prop];
}

const TABLES = `
  CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL);
  CREATE TABLE audit (id int PRIMARY KEY);
`;

/** The statement nesting deeper than the lexer's recursion can follow, so the file fails to parse. */
const UNPARSEABLE = `CREATE TABLE broken (${'('.repeat(300_000)}`;

// --------------------------------------------------------------------------
// insertTrigger
// --------------------------------------------------------------------------

/** The per-path `schema source not read` diagnostics of a run, apart from the aggregate notes about unread candidates. */
function sourcesNotRead(out: { result: { diagnostics: readonly string[] } }): string[] {
  return out.result.diagnostics.filter((d) => d.startsWith('schema source not read'));
}

test('insertTrigger is true only for a table with a BEFORE INSERT trigger, false for every other table', async () => {
  const out = await extractFiles({
    'db/schema.sql': `${TABLES}
      CREATE FUNCTION set_email() RETURNS trigger AS $$ BEGIN NEW.email := 'x'; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER users_defaults BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION set_email();
    `,
  });
  assert.deepEqual(tableProp(out, 'insertTrigger'), {
    'public.audit': false,
    'public.users': true,
  });
});

test('insertTrigger reads the event list: INSERT among several events counts, AFTER, INSTEAD OF and UPDATE-only do not', async () => {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ['CREATE TRIGGER t BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION f();', true],
    ['CREATE TRIGGER t BEFORE UPDATE OR INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();', true],
    [
      'CREATE TRIGGER t BEFORE UPDATE OF email OR INSERT OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION f();',
      true,
    ],
    ['CREATE CONSTRAINT TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();', true],
    ['CREATE OR REPLACE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();', true],
    ['CREATE TRIGGER IF NOT EXISTS t BEFORE INSERT ON users BEGIN SELECT 1; END;', true],
    ['CREATE TRIGGER t BEFORE INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION f();', true],
    ['CREATE TRIGGER t BEFORE INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION f();', true],
    ["CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW SET NEW.email = 'x';", true],
    ['CREATE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();', false],
    ['CREATE TRIGGER t BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION f();', false],
    ['CREATE TRIGGER t BEFORE UPDATE OF email ON users FOR EACH ROW EXECUTE FUNCTION f();', false],
    ['CREATE TRIGGER t BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION f();', false],
    ['CREATE TRIGGER t INSTEAD OF INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();', false],
    // A BEFORE INSERT trigger on another schema's table of the same name is not this table's.
    ['CREATE TRIGGER t BEFORE INSERT ON other.users FOR EACH ROW EXECUTE FUNCTION f();', false],
    // An event trigger fires on DDL, never on an insert into a table.
    ['CREATE EVENT TRIGGER guard ON ddl_command_start EXECUTE FUNCTION f();', false],
    // `RETURNS trigger` is a function, not a trigger.
    ['CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;', false],
  ];
  for (const [sql, expected] of cases) {
    const out = await extractFiles({ 'db/schema.sql': `${TABLES}\n${sql}` });
    assert.equal(tableProp(out, 'insertTrigger')['public.users'], expected, sql);
    assert.equal(tableProp(out, 'insertTrigger')['public.audit'], false, sql);
  }
});

test('SQLite TEMP and TEMPORARY triggers retain timing, events and drop semantics', async () => {
  for (const modifier of ['TEMP', 'TEMPORARY']) {
    for (const [event, expected] of [
      ['BEFORE INSERT', true],
      ['AFTER INSERT', false],
      ['BEFORE UPDATE', false],
    ] as const) {
      const trigger = `CREATE ${modifier} TRIGGER t ${event} ON users BEGIN SELECT 1; END;`;
      const out = await extractFiles(
        { 'db/schema.sql': `${TABLES}\n${trigger}` },
        { dialect: 'sqlite' },
      );
      assert.equal(out.result.status, 'PASS');
      assert.deepEqual(
        tableProp(out, 'insertTrigger'),
        { 'public.audit': false, 'public.users': expected },
        trigger,
      );
      const dropped = await extractFiles(
        { 'db/schema.sql': `${TABLES}\n${trigger}\nDROP TRIGGER t;` },
        { dialect: 'sqlite' },
      );
      assert.deepEqual(tableProp(dropped, 'insertTrigger'), {
        'public.audit': false,
        'public.users': false,
      });
    }
  }
});

test('MySQL DEFINER account words do not become CREATE object kinds', async () => {
  for (const account of [
    'app@localhost',
    'user@localhost',
    'role@localhost',
    'table@localhost',
    'trigger@role',
    "'user'@'localhost'",
    '`user`@`localhost`',
    '`us``er`@`local``host`',
    'CURRENT_USER',
    'CURRENT_USER()',
  ]) {
    const trigger = `CREATE DEFINER = ${account} TRIGGER t BEFORE INSERT ON users FOR EACH ROW SET NEW.email = 'x';`;
    const out = await extractFiles({ 'db/schema.sql': `${TABLES}\n${trigger}` });
    assert.deepEqual(
      tableProp(out, 'insertTrigger'),
      { 'public.audit': false, 'public.users': true },
      account,
    );
  }
  for (const other of [
    "CREATE DEFINER = user@localhost PROCEDURE p() BEGIN SELECT trigger FROM users; END;",
    "CREATE DEFINER = role@localhost VIEW trigger AS SELECT id FROM users;",
    "CREATE USER trigger IDENTIFIED BY 'x';",
    "CREATE TEMP TABLE trigger (id int);",
  ]) {
    const out = await extractFiles({ 'db/schema.sql': `${TABLES}\n${other}` });
    assert.equal(tableProp(out, 'insertTrigger')['public.users'], false, other);
    assert.equal(tableProp(out, 'insertTrigger')['public.audit'], false, other);
  }
});

test('SQLite IF NOT EXISTS preserves the original trigger in one file and ordered migrations', async () => {
  const tables = 'CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL);';
  for (const [first, later] of [['BEFORE', 'AFTER'], ['AFTER', 'BEFORE']] as const) {
    const create = `CREATE TRIGGER t ${first} INSERT ON users BEGIN SELECT 1; END;`;
    const noReplace = `CREATE TRIGGER IF NOT EXISTS t ${later} INSERT ON users BEGIN SELECT 1; END;`;
    const db = new DatabaseSync(':memory:');
    let retainedSql: string;
    try {
      db.exec(`${tables}\n${create}\n${noReplace}`);
      retainedSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 't'").get()?.['sql']);
      assert.equal(retainedSql.includes(`${first} INSERT`), true);
      assert.equal(retainedSql.includes(`${later} INSERT`), false);
    } finally {
      db.close();
    }
    const expected = retainedSql.includes('BEFORE INSERT');
    const layouts: readonly Files[] = [
      { 'db/schema.sql': `${tables}\n${create}\n${noReplace}` },
      { 'db/migrations/001.sql': `${tables}\n${create}`, 'db/migrations/002.sql': noReplace },
    ];
    for (const files of layouts) {
      const out = await extractFiles(files, { dialect: 'sqlite' });
      assert.equal(out.result.status, 'PASS');
      assert.equal(tableProp(out, 'insertTrigger')['public.users'], expected);
    }
    const recreated = await extractFiles(
      { 'db/schema.sql': `${tables}\n${create}\nDROP TRIGGER t;\n${noReplace}` },
      { dialect: 'sqlite' },
    );
    assert.equal(tableProp(recreated, 'insertTrigger')['public.users'], later === 'BEFORE');
  }
});

test('SQLite IF NOT EXISTS distinguishes temporary and permanent trigger namespaces', async () => {
  const tables = 'CREATE TABLE users (id int);';
  const permanent = 'CREATE TRIGGER t AFTER INSERT ON users BEGIN SELECT 1; END;';
  const temporary = 'CREATE TEMP TRIGGER IF NOT EXISTS t BEFORE INSERT ON users BEGIN SELECT 1; END;';
  for (const drop of ['', 'DROP TRIGGER t;', 'DROP TRIGGER main.t;']) {
    const db = new DatabaseSync(':memory:');
    let expected: boolean;
    try {
      db.exec(`${tables}\n${permanent}\n${temporary}\n${drop}`);
      const native = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' UNION ALL SELECT sql FROM sqlite_temp_master WHERE type='trigger'").all();
      expected = native.some((row) => String(row['sql']).includes('BEFORE INSERT'));
    } finally {
      db.close();
    }
    // The model's configured main schema is `main`, matching SQLite's explicit DROP name.
    const out = await extractFiles(
      { 'db/schema.sql': `${tables}\n${permanent}\n${temporary}\n${drop}` },
      { dialect: 'sqlite', defaultSchema: 'main' },
    );
    assert.equal(tableProp(out, 'insertTrigger')['main.users'], expected, drop);
  }
});

test('insertTrigger follows the table through replace, drop, rename and re-creation within a file', async () => {
  const createTrigger =
    'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();';
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    [
      'OR REPLACE with an AFTER trigger removes the BEFORE INSERT one',
      `${createTrigger}\nCREATE OR REPLACE TRIGGER t AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();`,
      false,
    ],
    [
      'DROP TRIGGER ... ON removes it',
      `${createTrigger}\nDROP TRIGGER IF EXISTS t ON users;`,
      false,
    ],
    [
      'drop then create (an idempotent migration) leaves it',
      `DROP TRIGGER IF EXISTS t ON users;\n${createTrigger}`,
      true,
    ],
    [
      'dropping a different trigger leaves it',
      `${createTrigger}\nDROP TRIGGER other ON users;`,
      true,
    ],
    ['a renamed table keeps it', `${createTrigger}\nALTER TABLE users RENAME TO members;`, true],
    [
      'a dropped and re-created table starts clean',
      `${createTrigger}\nDROP TABLE users;\nCREATE TABLE users (id int);`,
      false,
    ],
  ];
  for (const [label, tail, expected] of cases) {
    const out = await extractFiles({ 'db/schema.sql': `${TABLES}\n${tail}` });
    const triggers = tableProp(out, 'insertTrigger');
    const table = label.startsWith('a renamed') ? 'public.members' : 'public.users';
    assert.equal(triggers[table], expected, label);
  }

  // The trigger file is applied before the migration that creates the table; the answer does not depend on it.
  // (The order of two standalone files is a different matter: see the test after this one.)
  const split = await extractFiles({
    'db/triggers.sql': createTrigger,
    'db/migrations/001_users.sql': 'CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL);',
  });
  assert.deepEqual(tableProp(split, 'insertTrigger'), { 'public.users': true });
});

const TRIGGER_T1 = 'CREATE TRIGGER t1 BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();';
const TABLE_A = 'CREATE TABLE a (id int PRIMARY KEY, v text NOT NULL);';

test('insertTrigger across standalone SQL files is a union, so a file name cannot change it', async () => {
  // Each arrangement is a trigger in one file and a removal in another. Standalone files are read in
  // path order, which says nothing about the order they are deployed in, so the removal never reaches
  // the other file's trigger. The two name orders must give the same answer, and it is `true`.
  const arrangements: ReadonlyArray<readonly [string, string, string, string]> = [
    ['DROP TABLE then CREATE TABLE', TRIGGER_T1, `DROP TABLE IF EXISTS a;\n${TABLE_A}`, 'a'],
    ['DROP TRIGGER ... ON', TRIGGER_T1, `${TABLE_A}\nDROP TRIGGER t1 ON a;`, 'a'],
    [
      'DROP TRIGGER IF EXISTS ... ON',
      TRIGGER_T1,
      `${TABLE_A}\nDROP TRIGGER IF EXISTS t1 ON a;`,
      'a',
    ],
    [
      'OR REPLACE with an AFTER trigger',
      TRIGGER_T1,
      `${TABLE_A}\nCREATE OR REPLACE TRIGGER t1 AFTER INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();`,
      'a',
    ],
    [
      'a rename of the trigger table',
      'CREATE TRIGGER t1 BEFORE INSERT ON old FOR EACH ROW EXECUTE FUNCTION f();',
      'CREATE TABLE old (id int PRIMARY KEY, v text NOT NULL);\nALTER TABLE old RENAME TO a;',
      'a',
    ],
  ];
  for (const [label, trigger, other, table] of arrangements) {
    const results: unknown[] = [];
    for (const [triggerFile, otherFile] of [
      ['db/a_triggers.sql', 'db/z_schema.sql'],
      ['db/z_triggers.sql', 'db/a_schema.sql'],
    ] as const) {
      const out = await extractFiles({ [triggerFile]: trigger, [otherFile]: other });
      results.push(tableProp(out, 'insertTrigger'));
      assert.equal(
        tableProp(out, 'insertTrigger')[`public.${table}`],
        true,
        `${label}: ${triggerFile}`,
      );
    }
    assert.deepEqual(results[0], results[1], label);
  }
});

test('insertTrigger: a removal in the same file as the trigger still removes it, wherever the file sorts', async () => {
  const sameFile = `${TABLE_A}\n${TRIGGER_T1}\nDROP TRIGGER t1 ON a;`;
  for (const path of ['db/a.sql', 'db/z.sql']) {
    const out = await extractFiles({
      [path]: sameFile,
      'db/m_other.sql': 'CREATE TABLE b (id int);',
    });
    assert.deepEqual(
      tableProp(out, 'insertTrigger'),
      { 'public.a': false, 'public.b': false },
      path,
    );
  }
});

test('insertTrigger replays migrations in order: a removal reaches an earlier migration, never a later one', async () => {
  const migrations: ReadonlyArray<readonly [string, Files, boolean]> = [
    [
      'created in 001, dropped in 002',
      {
        'db/migrations/001.sql': `${TABLE_A}\n${TRIGGER_T1}`,
        'db/migrations/002.sql': 'DROP TRIGGER t1 ON a;',
      },
      false,
    ],
    [
      'dropped in 001 (nothing to drop yet), created in 002',
      {
        'db/migrations/001.sql': `${TABLE_A}\nDROP TRIGGER IF EXISTS t1 ON a;`,
        'db/migrations/002.sql': TRIGGER_T1,
      },
      true,
    ],
    [
      'the order is numeric: 2 comes before 10',
      {
        'db/migrations/2_create.sql': `${TABLE_A}\n${TRIGGER_T1}`,
        'db/migrations/10_drop.sql': 'DROP TRIGGER t1 ON a;',
      },
      false,
    ],
    [
      'the table is dropped and re-created in a later migration',
      {
        'db/migrations/001.sql': `${TABLE_A}\n${TRIGGER_T1}`,
        'db/migrations/002.sql': `DROP TABLE a;\n${TABLE_A}`,
      },
      false,
    ],
    [
      'replaced by an AFTER trigger in a later migration',
      {
        'db/migrations/001.sql': `${TABLE_A}\n${TRIGGER_T1}`,
        'db/migrations/002.sql':
          'CREATE OR REPLACE TRIGGER t1 AFTER INSERT ON a FOR EACH ROW EXECUTE FUNCTION f();',
      },
      false,
    ],
    [
      'the table is renamed by a later migration',
      {
        'db/migrations/001.sql': `${TABLE_A}\n${TRIGGER_T1}`,
        'db/migrations/002.sql': 'ALTER TABLE a RENAME TO a2;',
      },
      true,
    ],
    [
      'a standalone file creates the trigger and a migration drops the table',
      {
        'db/triggers.sql': TRIGGER_T1,
        'db/migrations/001.sql': `DROP TABLE IF EXISTS a;\n${TABLE_A}`,
      },
      true,
    ],
    [
      'a standalone file creates the trigger and a migration drops it',
      {
        'db/triggers.sql': TRIGGER_T1,
        'db/migrations/001.sql': `${TABLE_A}\nDROP TRIGGER t1 ON a;`,
      },
      true,
    ],
  ];
  for (const [label, files, expected] of migrations) {
    const out = await extractFiles(files);
    const triggers = tableProp(out, 'insertTrigger');
    const table = label.includes('renamed') ? 'public.a2' : 'public.a';
    assert.equal(triggers[table], expected, label);
  }

  // A standalone trigger on a table that a migration renames moves with it.
  const renamed = await extractFiles({
    'db/triggers.sql': 'CREATE TRIGGER t1 BEFORE INSERT ON old FOR EACH ROW EXECUTE FUNCTION f();',
    'db/migrations/001.sql': 'CREATE TABLE old (id int);\nALTER TABLE old RENAME TO fresh;',
  });
  assert.deepEqual(tableProp(renamed, 'insertTrigger'), { 'public.fresh': true });
});

test('DROP TRIGGER without ON resolves the trigger by its name and schema', async () => {
  const trigger = 'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW SET NEW.email = 1;';
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ['DROP TRIGGER t', 'DROP TRIGGER t;', false],
    ['DROP TRIGGER IF EXISTS t', 'DROP TRIGGER IF EXISTS t;', false],
    ['DROP TRIGGER public.t', 'DROP TRIGGER public.t;', false],
    ['a trigger of the same name in another schema', 'DROP TRIGGER other.t;', true],
    ['a different trigger name', 'DROP TRIGGER nothing;', true],
  ];
  for (const [label, drop, expected] of cases) {
    const out = await extractFiles({ 'db/schema.sql': `${TABLES}\n${trigger}\n${drop}` });
    assert.equal(tableProp(out, 'insertTrigger')['public.users'], expected, label);
    assert.equal(tableProp(out, 'insertTrigger')['public.audit'], false, label);
  }
});

test('an unattributed CREATE TRIGGER keeps a trigger already seen and withholds only the other tables', async () => {
  const seen = 'CREATE TRIGGER t1 BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();';
  const out = await extractFiles({
    'db/schema.sql': `${TABLES}\n${seen}\nCREATE TRIGGER t2 BEFORE INSERT ON;`,
  });
  assert.deepEqual(tableProp(out, 'insertTrigger'), {
    'public.audit': undefined,
    'public.users': true,
  });

  // A statement that hides what it holds (a DELIMITER block) might have dropped the trigger as well.
  const hidden = await extractFiles({
    'db/schema.sql': `${TABLES}\n${seen}\nDELIMITER $$\nCREATE TRIGGER t3 BEFORE INSERT ON audit FOR EACH ROW BEGIN SET NEW.id = 1; END$$\nDELIMITER ;`,
  });
  assert.deepEqual(tableProp(hidden, 'insertTrigger'), {
    'public.audit': undefined,
    'public.users': undefined,
  });

  // So does a SQL file that was not read: it may hold the DROP TRIGGER.
  const unread = await extractFiles({
    'db/schema.sql': `${TABLES}\n${seen}`,
    'db/other.sql': UNPARSEABLE,
  });
  assert.deepEqual(tableProp(unread, 'insertTrigger'), {
    'public.audit': undefined,
    'public.users': undefined,
  });
});

test('a trigger statement that cannot be attributed makes insertTrigger unknown for every table, never false', async () => {
  const unattributable: ReadonlyArray<readonly [string, string]> = [
    [
      'a backtick-quoted MySQL trigger name',
      'CREATE TRIGGER `users_bi` BEFORE INSERT ON users FOR EACH ROW SET NEW.email = 1;',
    ],
    ['no table after ON', 'CREATE TRIGGER t BEFORE INSERT ON;'],
    ['a timing this reader does not know', 'CREATE TRIGGER t ON users FOR INSERT AS SELECT 1;'],
    [
      'a mysqldump version comment',
      "/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER t BEFORE INSERT ON users FOR EACH ROW SET NEW.email = 'x' */;;",
    ],
    [
      'a DELIMITER block',
      "DELIMITER $$\nCREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW BEGIN SET NEW.email = 'x'; END$$\nDELIMITER ;",
    ],
  ];
  for (const [label, sql] of unattributable) {
    const out = await extractFiles({ 'db/schema.sql': `${TABLES}\n${sql}` });
    assert.deepEqual(
      tableProp(out, 'insertTrigger'),
      { 'public.audit': undefined, 'public.users': undefined },
      label,
    );
  }
  // An AFTER trigger cannot set a column, so an unreadable table after it costs nothing.
  const after = await extractFiles({
    'db/schema.sql': `${TABLES}\nCREATE TRIGGER t AFTER INSERT ON;`,
  });
  assert.deepEqual(tableProp(after, 'insertTrigger'), {
    'public.audit': false,
    'public.users': false,
  });
});

test('a word "trigger" in a comment or a string, with nothing hiding a statement, is not an unknown', async () => {
  const out = await extractFiles({
    'db/schema.sql': `${TABLES}\n-- a trigger would go here\nCOMMENT ON TABLE users IS 'no trigger yet';`,
  });
  assert.deepEqual(tableProp(out, 'insertTrigger'), {
    'public.audit': false,
    'public.users': false,
  });
});

test('a SQL source that failed to parse or was not read leaves insertTrigger unknown, not false', async () => {
  const control = await extractFiles({ 'db/schema.sql': TABLES });
  assert.deepEqual(tableProp(control, 'insertTrigger'), {
    'public.audit': false,
    'public.users': false,
  });

  for (const bad of ['db/migrations/0002_bad.sql', 'db/other.sql']) {
    const failed = await extractFiles({ 'db/schema.sql': TABLES, [bad]: UNPARSEABLE });
    assert.equal(failed.result.status, 'FAIL', bad);
    assert.deepEqual(
      tableProp(failed, 'insertTrigger'),
      { 'public.audit': undefined, 'public.users': undefined },
      bad,
    );
  }

  const skipped = await extractFiles(
    {
      'db/schema.sql': TABLES,
      'db/dump.sql': `-- ${'x'.repeat(3_000)}\nCREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();`,
    },
    { maxFileBytes: 2_000 },
  );
  assert.deepEqual(tableProp(skipped, 'insertTrigger'), {
    'public.audit': undefined,
    'public.users': undefined,
  });

  // Prisma and Drizzle files cannot hold a trigger, so one failing says nothing about triggers.
  const prismaSkipped = await extractFiles(
    {
      'db/schema.sql': TABLES,
      'prisma/schema.prisma': `// ${'x'.repeat(3_000)}\nmodel A { id Int @id }`,
    },
    { maxFileBytes: 2_000 },
  );
  assert.deepEqual(tableProp(prismaSkipped, 'insertTrigger'), {
    'public.audit': false,
    'public.users': false,
  });
});

test('a repository with no SQL file at all reports insertTrigger false: none was seen in what was read', async () => {
  const out = await extractFiles({
    'prisma/schema.prisma': 'model Plain {\n  id Int @id\n\n  @@map("plain")\n}\n',
  });
  assert.deepEqual(tableProp(out, 'insertTrigger'), { 'public.plain': false });
});

// --------------------------------------------------------------------------
// declarations
// --------------------------------------------------------------------------

const NOTES_A = 'model NoteA {\n  id Int @id\n  title String\n\n  @@map("notes")\n}\n';
const NOTES_B = 'model NoteB {\n  id Int @id\n  body String\n\n  @@map("notes")\n}\n';

test('declarations counts distinct non-migration files, and a migration is never one', async () => {
  const cases: ReadonlyArray<readonly [string, Files, number]> = [
    ['one Prisma file', { 'prisma/schema.prisma': NOTES_A }, 1],
    [
      'one Prisma file and the migration that creates it',
      {
        'prisma/schema.prisma': NOTES_A,
        'prisma/migrations/0001_init/migration.sql': 'CREATE TABLE notes (id int, title text);',
      },
      1,
    ],
    [
      'a table only a migration creates and alters',
      {
        'db/migrations/0001_notes.sql': 'CREATE TABLE notes (id int);',
        'db/migrations/0002_notes.sql': 'ALTER TABLE notes ADD COLUMN title text;',
      },
      0,
    ],
    [
      'two Prisma files mapping to one table',
      { 'a/schema.prisma': NOTES_A, 'b/schema.prisma': NOTES_B },
      2,
    ],
    [
      'Prisma plus a SQL file',
      { 'prisma/schema.prisma': NOTES_A, 'db/schema.sql': 'CREATE TABLE notes (id int);' },
      2,
    ],
    [
      'Prisma plus Drizzle',
      {
        'prisma/schema.prisma': NOTES_A,
        'src/schema.ts':
          "export const notes = pgTable('notes', { id: integer('id').primaryKey() });",
      },
      2,
    ],
    [
      'one file declaring the table twice',
      {
        'db/schema.sql':
          'CREATE TABLE notes (id int);\nDROP TABLE notes;\nCREATE TABLE notes (id int, title text);',
      },
      1,
    ],
    [
      'an ALTER in a plain SQL file is not a declaration',
      {
        'prisma/schema.prisma': NOTES_A,
        'db/alter.sql': 'ALTER TABLE notes ADD COLUMN extra text;',
      },
      1,
    ],
    [
      'a SQL file and a migration',
      {
        'db/schema.sql': 'CREATE TABLE notes (id int);',
        'db/migrations/0001_notes.sql': 'CREATE TABLE IF NOT EXISTS notes (id int);',
      },
      1,
    ],
  ];
  for (const [label, files, expected] of cases) {
    const out = await extractFiles(files);
    assert.equal(tableProp(out, 'declarations')['public.notes'], expected, label);
  }
});

test('two schema.prisma files mapping to one table merge their columns and report two declarations', async () => {
  const out = await extractFiles({ 'a/schema.prisma': NOTES_A, 'b/schema.prisma': NOTES_B });
  const columns = out.nodes
    .filter((n) => n.kind === 'Column' && n.props['table'] === 'notes')
    .map((n) => n.props['column'])
    .sort();
  assert.deepEqual(columns, ['body', 'id', 'title']);
  assert.deepEqual(tableProp(out, 'declarations'), { 'public.notes': 2 });
});

test('declarations is unknown, not 1, when a non-migration source was not read', async () => {
  const files = { 'prisma/schema.prisma': NOTES_A };
  assert.deepEqual(tableProp(await extractFiles(files), 'declarations'), { 'public.notes': 1 });

  for (const bad of ['db/other.sql']) {
    const failed = await extractFiles({ ...files, [bad]: UNPARSEABLE });
    assert.deepEqual(tableProp(failed, 'declarations'), { 'public.notes': undefined }, bad);
  }
  const skipped = await extractFiles(
    { ...files, 'prisma/second.prisma': `// ${'x'.repeat(3_000)}\n${NOTES_B}` },
    { maxFileBytes: 2_000 },
  );
  assert.deepEqual(tableProp(skipped, 'declarations'), { 'public.notes': undefined });

  // A migration that failed to parse declares nothing, so the count of files that do is unaffected.
  const migrationFailed = await extractFiles({
    ...files,
    'db/migrations/0002_bad.sql': UNPARSEABLE,
  });
  assert.deepEqual(tableProp(migrationFailed, 'declarations'), { 'public.notes': 1 });
});

// --------------------------------------------------------------------------
// dynamicDdl
// --------------------------------------------------------------------------

test('dynamicDdl counts DO blocks and EXECUTE statements in migrations', async () => {
  const base = { 'db/schema.sql': TABLES };
  const cases: ReadonlyArray<readonly [string, Files, number]> = [
    ['no migration at all', base, 0],
    [
      'plain DDL migrations',
      { ...base, 'db/migrations/001.sql': 'ALTER TABLE users ADD COLUMN age int;' },
      0,
    ],
    [
      'one DO block',
      {
        ...base,
        'db/migrations/001.sql':
          "DO $$ BEGIN EXECUTE 'ALTER TABLE users ALTER COLUMN email SET DEFAULT ''x'''; END $$;",
      },
      1,
    ],
    [
      'DO with a language clause',
      {
        ...base,
        'db/migrations/001.sql': 'DO LANGUAGE plpgsql $$ BEGIN NULL; END $$;',
      },
      1,
    ],
    [
      'two DO blocks in two migrations',
      {
        ...base,
        'db/migrations/001.sql': 'DO $$ BEGIN NULL; END $$;',
        'db/migrations/002.sql': 'DO $$ BEGIN NULL; END $$;',
      },
      2,
    ],
    [
      'a prepared statement',
      {
        ...base,
        'db/migrations/001.sql':
          "SET @q = 'ALTER TABLE users ADD COLUMN x int';\nPREPARE s FROM @q;\nEXECUTE s;",
      },
      1,
    ],
    [
      'EXECUTE inside a function body is not a statement of the migration',
      {
        ...base,
        'db/migrations/001.sql':
          "CREATE FUNCTION f() RETURNS void AS $$ BEGIN EXECUTE 'SELECT 1'; END $$ LANGUAGE plpgsql;",
      },
      0,
    ],
    [
      'a data load in a DO block outside the migrations is not counted',
      { ...base, 'db/seed.sql': "DO $$ BEGIN INSERT INTO users VALUES (1, 'a'); END $$;" },
      0,
    ],
    [
      'a column named created_at is not CREATE',
      { ...base, 'db/seed.sql': 'DO $$ BEGIN UPDATE users SET created_at = now(); END $$;' },
      0,
    ],
    [
      'a DO block in a schema snapshot that alters a default',
      {
        'db/schema.sql': `${TABLES}
DO $$ BEGIN EXECUTE 'ALTER TABLE users ALTER COLUMN email SET DEFAULT ''x'''; END $$;`,
      },
      1,
    ],
    [
      'a DO block in a plain file that creates a trigger, in lower case',
      {
        ...base,
        'db/setup.sql':
          "do $$ begin execute 'create trigger t before insert on users ...'; end $$;",
      },
      1,
    ],
    [
      'a DO block in a plain file that drops',
      { ...base, 'db/setup.sql': "DO $$ BEGIN EXECUTE 'DROP TABLE old'; END $$;" },
      1,
    ],
    [
      'a T-SQL EXEC of a DDL string outside the migrations',
      { ...base, 'db/setup.sql': "EXEC ('ALTER TABLE users ADD age int');" },
      1,
    ],
    [
      'one in a plain file and one in a migration',
      {
        ...base,
        'db/setup.sql': "DO $$ BEGIN EXECUTE 'ALTER TABLE users ADD x int'; END $$;",
        'db/migrations/001.sql': 'DO $$ BEGIN NULL; END $$;',
      },
      2,
    ],
    [
      'CREATE DOMAIN is not a DO block',
      { ...base, 'db/migrations/001.sql': 'CREATE DOMAIN positive AS int CHECK (VALUE > 0);' },
      0,
    ],
  ];
  for (const [label, files, expected] of cases) {
    const out = await extractFiles(files);
    assert.equal(dataSourceProp(out, 'dynamicDdl'), expected, label);
  }
});

test('dynamicDdl is unknown, not 0, when a migration failed to parse or was not read', async () => {
  const good = {
    'db/schema.sql': TABLES,
    'db/migrations/001.sql': 'ALTER TABLE users ADD COLUMN age int;',
  };
  assert.equal(dataSourceProp(await extractFiles(good), 'dynamicDdl'), 0);

  const failed = await extractFiles({ ...good, 'db/migrations/002_bad.sql': UNPARSEABLE });
  assert.equal(failed.result.status, 'FAIL');
  assert.equal(dataSourceProp(failed, 'dynamicDdl'), undefined);

  const skipped = await extractFiles(
    { ...good, 'db/migrations/003_big.sql': `-- ${'x'.repeat(3_000)}\nDO $$ BEGIN NULL; END $$;` },
    { maxFileBytes: 2_000 },
  );
  assert.equal(dataSourceProp(skipped, 'dynamicDdl'), undefined);

  // A plain SQL file that failed may hold a DO block that names DDL, so it withholds the count too.
  const plainFailed = await extractFiles({ ...good, 'db/other.sql': UNPARSEABLE });
  assert.equal(plainFailed.result.status, 'FAIL');
  assert.equal(dataSourceProp(plainFailed, 'dynamicDdl'), undefined);
});

// --------------------------------------------------------------------------
// Files discovery could not follow or list
// --------------------------------------------------------------------------

/** A prop of every Column of one table, keyed by column name. */
function columnProp(out: ExtractDataOutput, table: string, prop: string): Record<string, unknown> {
  return Object.fromEntries(
    out.nodes
      .filter((n) => n.kind === 'Column' && n.props['table'] === table)
      .map((n) => [n.props['column'], n.props[prop]]),
  );
}

test('a symlinked .sql file is reported, and withholds every fact it could contradict', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'seamline-linked-'));
  const repo = await mkdtemp(join(tmpdir(), 'seamline-linking-'));
  try {
    await writeFile(
      join(outside, 'triggers.sql'),
      'CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();',
      'utf8',
    );
    await mkdir(join(repo, 'db'), { recursive: true });
    await writeFile(join(repo, 'db', 'schema.sql'), TABLES, 'utf8');
    try {
      await symlink(join(outside, 'triggers.sql'), join(repo, 'db', 'triggers.sql'));
    } catch (err) {
      t.skip(`cannot create a symbolic link here: ${String(err)}`);
      return;
    }
    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.equal(out.result.status, 'PASS');
    assert.ok(out.result.diagnostics.includes('schema source not read (symlink): db/triggers.sql'));
    // Nothing the linked file might hold is reported as zero, none or false.
    assert.deepEqual(tableProp(out, 'insertTrigger'), {
      'public.audit': undefined,
      'public.users': undefined,
    });
    assert.deepEqual(tableProp(out, 'declarations'), {
      'public.audit': undefined,
      'public.users': undefined,
    });
    assert.equal(dataSourceProp(out, 'dynamicDdl'), undefined);
    assert.deepEqual(columnProp(out, 'users', 'defaultSite'), { email: undefined, id: undefined });
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test('a directory discovery could not list is reported, and withholds the same facts', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'seamline-locked-'));
  const locked = join(repo, 'db', 'locked');
  try {
    await mkdir(locked, { recursive: true });
    await writeFile(join(repo, 'db', 'schema.sql'), TABLES, 'utf8');
    await writeFile(
      join(locked, 'triggers.sql'),
      'CREATE TRIGGER t BEFORE INSERT ON users ...;',
      'utf8',
    );
    await chmod(locked, 0o000);
    try {
      await readdir(locked);
      t.skip('this process can list a directory with mode 000 (running as root), so none fails');
      return;
    } catch {
      // The directory really is unreadable here.
    }
    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.equal(out.result.status, 'PASS');
    assert.ok(
      out.result.diagnostics.includes('schema source not read (unreadable-directory): db/locked'),
    );
    assert.deepEqual(tableProp(out, 'insertTrigger'), {
      'public.audit': undefined,
      'public.users': undefined,
    });
    assert.deepEqual(tableProp(out, 'declarations'), {
      'public.audit': undefined,
      'public.users': undefined,
    });
    assert.equal(dataSourceProp(out, 'dynamicDdl'), undefined);
    assert.deepEqual(columnProp(out, 'users', 'defaultSite'), { email: undefined, id: undefined });
  } finally {
    await chmod(locked, 0o755).catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
  }
});

test('a symlink to a file that is not a schema source is not reported', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'seamline-linked-'));
  const repo = await mkdtemp(join(tmpdir(), 'seamline-linking-'));
  try {
    await writeFile(join(outside, 'notes.txt'), 'not sql', 'utf8');
    await mkdir(join(repo, 'db'), { recursive: true });
    await writeFile(join(repo, 'db', 'schema.sql'), TABLES, 'utf8');
    try {
      await symlink(join(outside, 'notes.txt'), join(repo, 'db', 'notes.txt'));
    } catch (err) {
      t.skip(`cannot create a symbolic link here: ${String(err)}`);
      return;
    }
    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.deepEqual(out.result.diagnostics, []);
    assert.deepEqual(tableProp(out, 'insertTrigger'), {
      'public.audit': false,
      'public.users': false,
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Symbolic links to directories, and TypeScript modules discovery could not read
// --------------------------------------------------------------------------

/** A repository and a directory outside it, both removed afterwards; `link` is false where links cannot be made. */
async function withLinkedRepo(
  t: { skip: (reason: string) => void },
  body: (dirs: {
    repo: string;
    outside: string;
    link: (target: string, at: string) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const outside = await mkdtemp(join(tmpdir(), 'seamline-linked-'));
  const repo = await mkdtemp(join(tmpdir(), 'seamline-linking-'));
  try {
    try {
      await symlink(outside, join(outside, 'probe'));
    } catch (err) {
      t.skip(`cannot create a symbolic link here: ${String(err)}`);
      return;
    }
    await body({
      repo,
      outside,
      link: async (target, at) => {
        await mkdir(dirname(join(repo, at)), { recursive: true });
        await symlink(target, join(repo, at));
      },
    });
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
}

const NOTHING_KNOWN = { 'public.audit': undefined, 'public.users': undefined };

test('a symlinked directory that leaves the repository is reported, and withholds every fact it could contradict', async (t) => {
  await withLinkedRepo(t, async ({ repo, outside, link }) => {
    // What is behind the link would drop a trigger, add a default and run dynamic DDL, if it were read.
    await writeFile(
      join(outside, '001_init.sql'),
      "DROP TABLE users; CREATE TABLE users (id int PRIMARY KEY, email text NOT NULL DEFAULT 'x');\nDO $$ BEGIN NULL; END $$;",
      'utf8',
    );
    await mkdir(join(repo, 'db'), { recursive: true });
    await writeFile(join(repo, 'db', 'schema.sql'), TABLES, 'utf8');
    await link(outside, 'db/migrations');

    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.equal(out.result.status, 'PASS');
    assert.deepEqual(sourcesNotRead(out), ['schema source not read (symlink): db/migrations']);
    assert.deepEqual(tableProp(out, 'insertTrigger'), NOTHING_KNOWN);
    assert.deepEqual(tableProp(out, 'declarations'), NOTHING_KNOWN);
    assert.equal(dataSourceProp(out, 'dynamicDdl'), undefined);
    assert.deepEqual(columnProp(out, 'users', 'defaultSite'), { email: undefined, id: undefined });
  });
});

test('a symlinked directory that is the only schema source is UNAVAILABLE, never an empty PASS', async (t) => {
  await withLinkedRepo(t, async ({ repo, outside, link }) => {
    await writeFile(join(outside, '001_init.sql'), TABLES, 'utf8');
    await link(outside, 'db/migrations');
    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(out.nodes.length, 0);
    assert.ok(out.result.diagnostics.includes('schema source not read (symlink): db/migrations'));
  });
});

test('a symlinked directory read at its own path inside the repository is not reported, and is read once', async (t) => {
  await withLinkedRepo(t, async ({ repo, link }) => {
    await mkdir(join(repo, 'db', 'v1'), { recursive: true });
    await writeFile(join(repo, 'db', 'v1', 'schema.sql'), TABLES, 'utf8');
    await link(join(repo, 'db', 'v1'), 'db/current');
    await link(join(repo, 'db'), 'db/v1/up');
    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.equal(out.result.status, 'PASS');
    assert.deepEqual(out.result.diagnostics, []);
    assert.deepEqual(tableProp(out, 'declarations'), { 'public.audit': 1, 'public.users': 1 });
    assert.deepEqual(tableProp(out, 'insertTrigger'), {
      'public.audit': false,
      'public.users': false,
    });
    assert.equal(dataSourceProp(out, 'dynamicDdl'), 0);
  });
});

test('a symlinked directory whose target the walk skips is reported; skipDirs names it away', async (t) => {
  await withLinkedRepo(t, async ({ repo, link }) => {
    // `coverage` is skipped by default and, unlike `build`, is not listed for schema files.
    await mkdir(join(repo, 'coverage', 'sql'), { recursive: true });
    await writeFile(
      join(repo, 'coverage', 'sql', 'extra.sql'),
      'CREATE TRIGGER t BEFORE INSERT ON users ...;',
      'utf8',
    );
    await mkdir(join(repo, 'db'), { recursive: true });
    await writeFile(join(repo, 'db', 'schema.sql'), TABLES, 'utf8');
    await link(join(repo, 'coverage', 'sql'), 'db/generated');

    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.deepEqual(sourcesNotRead(out), ['schema source not read (symlink): db/generated']);
    assert.deepEqual(tableProp(out, 'insertTrigger'), NOTHING_KNOWN);

    // The way to say "this is not a schema source" is the one for a directory.
    const skipped = await extractData({
      root: repo,
      repo: 'demo',
      runId: 'r1',
      deterministic: true,
      skipDirs: ['generated'],
    });
    assert.deepEqual(skipped.result.diagnostics, []);
    assert.deepEqual(tableProp(skipped, 'insertTrigger'), {
      'public.audit': false,
      'public.users': false,
    });
  });
});

test('a link that points nowhere hides nothing, whatever its name; one that cannot be resolved might', async (t) => {
  await withLinkedRepo(t, async ({ repo, link }) => {
    await mkdir(join(repo, 'db'), { recursive: true });
    await writeFile(join(repo, 'db', 'schema.sql'), TABLES, 'utf8');
    await link(join(repo, 'missing'), 'db/migrations');
    await link(join(repo, 'missing'), '.env');
    await link(join(repo, 'missing'), 'public/logo.png');

    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.deepEqual(out.result.diagnostics, []);
    assert.deepEqual(tableProp(out, 'insertTrigger'), {
      'public.audit': false,
      'public.users': false,
    });

    // A link to itself fails to resolve with ELOOP, not ENOENT: whether it is a directory is not known.
    await link(join(repo, 'db', 'loop'), 'db/loop');
    const looped = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.deepEqual(sourcesNotRead(looped), ['schema source not read (symlink): db/loop']);
    assert.deepEqual(tableProp(looped, 'insertTrigger'), NOTHING_KNOWN);
  });
});

test('a symlinked TypeScript module that leaves the repository withholds what a Drizzle table in it could contradict', async (t) => {
  await withLinkedRepo(t, async ({ repo, outside, link }) => {
    await writeFile(
      join(outside, 'schema.ts'),
      "import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const users = pgTable('users', { email: text('email') });\n",
      'utf8',
    );
    await mkdir(join(repo, 'db'), { recursive: true });
    await writeFile(join(repo, 'db', 'schema.sql'), TABLES, 'utf8');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'local.ts'), 'export const a = 1;\n', 'utf8');
    await link(join(outside, 'schema.ts'), 'src/schema.ts');
    await link(join(repo, 'src', 'local.ts'), 'src/alias.ts');

    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.deepEqual(sourcesNotRead(out), [
      'schema source not read (symlink): src/alias.ts',
      'schema source not read (symlink): src/schema.ts',
    ]);
    assert.deepEqual(tableProp(out, 'declarations'), NOTHING_KNOWN);
    assert.deepEqual(columnProp(out, 'users', 'defaultSite'), { email: undefined, id: undefined });
    // A Drizzle module says nothing about triggers or dynamic DDL.
    assert.deepEqual(tableProp(out, 'insertTrigger'), {
      'public.audit': false,
      'public.users': false,
    });
    assert.equal(dataSourceProp(out, 'dynamicDdl'), 0);
  });
});

const DRIZZLE_HEAD = "import { pgTable, text } from 'drizzle-orm/pg-core';\n";
const DRIZZLE_USERS = `${DRIZZLE_HEAD}export const users = pgTable('users', { email: text('email').notNull() });\n`;

test('a Drizzle schema module that is too large to read is reported, and withholds the same facts', async () => {
  const out = await extractFiles(
    {
      'db/schema.sql': TABLES,
      'src/db/schema.ts': `${DRIZZLE_USERS}// ${'x'.repeat(5_000)}\n`,
    },
    { maxFileBytes: 1_000 },
  );
  assert.equal(out.result.status, 'PASS');
  assert.deepEqual(sourcesNotRead(out), [
    'schema source not read (too-large): src/db/schema.ts',
  ]);
  // `users` is declared by the SQL file, and by a Drizzle table nobody read: not 1.
  assert.deepEqual(tableProp(out, 'declarations'), NOTHING_KNOWN);
  assert.deepEqual(columnProp(out, 'users', 'defaultSite'), { email: undefined, id: undefined });
  // The same repository with the module readable has the second declaration.
  const read = await extractFiles({
    'db/schema.sql': TABLES,
    'src/db/schema.ts': `${DRIZZLE_USERS}// ${'x'.repeat(5_000)}\n`,
  });
  assert.deepEqual(tableProp(read, 'declarations'), { 'public.audit': 1, 'public.users': 2 });
});

test('every oversized TypeScript or JavaScript file is unread because its full schema content is unknown', async () => {
  const pad = `// ${'x'.repeat(5_000)}\n`;
  const out = await extractFiles(
    {
      'db/schema.sql': TABLES,
      'src/bundle.js': `${pad}module.exports = {};\n`,
      'src/types.ts': `export interface Row { id: number }\n${pad}`,
      'src/calls.ts': `export const users = pgTable('users', {});\n${pad}`,
    },
    { maxFileBytes: 1_000 },
  );
  assert.deepEqual(sourcesNotRead(out), [
    'schema source not read (too-large): src/bundle.js',
    'schema source not read (too-large): src/calls.ts',
    'schema source not read (too-large): src/types.ts',
  ]);
  assert.deepEqual(tableProp(out, 'declarations'), NOTHING_KNOWN);
  assert.deepEqual(columnProp(out, 'users', 'defaultSite'), { email: undefined, id: undefined });

  // Even a long non-schema preamble cannot prove that no table follows it.
  const late = await extractFiles(
    { 'db/schema.sql': TABLES, 'src/db/schema.ts': `// ${'x'.repeat(20_000)}\n${DRIZZLE_USERS}` },
    { maxFileBytes: 1_000 },
  );
  assert.deepEqual(sourcesNotRead(late), [
    'schema source not read (too-large): src/db/schema.ts',
  ]);
  assert.deepEqual(tableProp(late, 'declarations'), NOTHING_KNOWN);
  assert.deepEqual(columnProp(late, 'users', 'defaultSite'), { email: undefined, id: undefined });
});

test('a TypeScript file that cannot be read at all is treated as a possible Drizzle schema', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'seamline-locked-ts-'));
  const locked = join(repo, 'src', 'db', 'schema.ts');
  try {
    await mkdir(dirname(locked), { recursive: true });
    await writeFile(join(repo, 'db.sql'), TABLES, 'utf8');
    await writeFile(locked, DRIZZLE_USERS, 'utf8');
    await chmod(locked, 0o000);
    try {
      await readFile(locked);
      t.skip('this process can read a file with mode 000 (running as root), so none fails');
      return;
    } catch {
      // The file really is unreadable here.
    }
    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.equal(out.result.status, 'PASS');
    assert.deepEqual(sourcesNotRead(out), [
      'schema source not read (unreadable): src/db/schema.ts',
    ]);
    assert.deepEqual(tableProp(out, 'declarations'), NOTHING_KNOWN);
  } finally {
    await chmod(locked, 0o644).catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Determinism
// --------------------------------------------------------------------------

test('the new table and data source facts are byte-identical across runs', async () => {
  const files: Files = {
    'prisma/schema.prisma': NOTES_A,
    'db/schema.sql': `${TABLES}\nCREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f();`,
    'db/migrations/001.sql': 'DO $$ BEGIN NULL; END $$;',
  };
  const first = await extractFiles(files);
  const second = await extractFiles(files);
  assert.equal(canonicalSif(second.nodes, second.edges), canonicalSif(first.nodes, first.edges));
  const sif = canonicalSif(first.nodes, first.edges);
  assert.ok(sif.includes('"insertTrigger":true'));
  assert.ok(sif.includes('"declarations":2') || sif.includes('"declarations":1'));
  assert.ok(sif.includes('"dynamicDdl":1'));
});

test('a schema file in a form no reader parses is reported once, and withholds every fact it could contradict', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'seamline-unparsed-'));
  try {
    await mkdir(join(repo, 'db'), { recursive: true });
    await writeFile(join(repo, 'db', 'schema.sql'), TABLES, 'utf8');
    await writeFile(join(repo, 'db', 'extra.ddl'), 'CREATE TABLE audit (id int);', 'utf8');
    const out = await extractData({ root: repo, repo: 'demo', runId: 'r1', deterministic: true });
    assert.equal(out.result.status, 'PASS');
    const lines = out.result.diagnostics.filter((d) => d.startsWith('schema candidates were not read'));
    assert.deepEqual(lines, [
      'schema candidates were not read, so tables they declare are not in this run (1): db/extra.ddl',
    ]);
    assert.ok(!out.result.diagnostics.some((d) => d.startsWith('schema source not read')));
    assert.deepEqual(tableProp(out, 'insertTrigger'), NOTHING_KNOWN);
    assert.deepEqual(tableProp(out, 'declarations'), NOTHING_KNOWN);
    assert.deepEqual(columnProp(out, 'users', 'defaultSite'), { email: undefined, id: undefined });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
