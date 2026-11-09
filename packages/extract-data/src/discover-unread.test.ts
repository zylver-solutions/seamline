/**
 * What discovery knows exists and does not read.
 *
 * `noSchemaSource` may be true only when discovery could have seen every schema
 * the repository has. These tests pin each way a schema can be present and still
 * invisible to the readers: a symbolic link, an extension the SQL reader does not
 * parse, a Drizzle constructor the Drizzle reader does not parse, a Prisma schema
 * a package pointer names but discovery did not open, and a file under a
 * directory the walk skips. Each is recorded in `Discovery.unread`, which keeps
 * the data scope UNAVAILABLE and the data-model index absent downstream, instead
 * of reading the silence as "discovery found none".
 *
 * The permission test at the end skips when run as root (a mode bit does not stop
 * root). Run this file as an unprivileged user to exercise it, for example
 * `setpriv --reuid 65534 --regid 65534 --clear-groups node --test <this file>`.
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { SqliteStore } from '@seamline/core';

import { discoverSources } from './discover.ts';
import { extractData, type ExtractDataOptions, type ExtractDataOutput } from './extractor.ts';

const PRISMA = 'model User {\n  id Int @id\n}\n';
const DDL = 'CREATE TABLE users (id int);\n';

const runsAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

interface Repo {
  readonly root: string;
  /** A directory beside the repository, for link targets that lie outside it. */
  readonly outside: string;
}

async function withRepo(
  files: Readonly<Record<string, string>>,
  body: (repo: Repo) => Promise<void>,
): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'seamline-unread-'));
  const root = join(parent, 'repo');
  const outside = join(parent, 'external');
  try {
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text, 'utf8');
    }
    await body({ root, outside });
  } finally {
    // A directory the test made unreadable must be openable again to be removed.
    await chmod(join(root, 'locked'), 0o755).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}

function run(root: string, extra: Partial<ExtractDataOptions> = {}): Promise<ExtractDataOutput> {
  return extractData({ root, repo: 'demo', runId: 'run-1', deterministic: true, ...extra });
}

/** A repository whose only schema is the one `hide` makes invisible: UNAVAILABLE, not "found none". */
async function assertUnseen(
  repo: Repo,
  expectedUnread: readonly string[],
  label: string,
): Promise<void> {
  const found = await discoverSources({ root: repo.root });
  assert.deepEqual(found.files, [], label);
  assert.deepEqual(found.unread, expectedUnread, label);
  const out = await run(repo.root);
  assert.equal(out.result.status, 'UNAVAILABLE', label);
  assert.equal(
    out.noSchemaSource,
    false,
    `${label}: the schema is there, discovery just did not read it`,
  );
  assert.ok(
    out.result.diagnostics.some((d) => d.startsWith('no schema source could be read')),
    `${label}: ${JSON.stringify(out.result.diagnostics)}`,
  );
  assert.ok(!out.result.diagnostics.some((d) => d.startsWith('no schema source found')), label);
}

/* ------------------------------------------------------------------ (a) symbolic links */

test('a symbolic link to a schema file is a source discovery did not read', async () => {
  await withRepo({}, async (repo) => {
    await writeFile(join(repo.outside, 'schema.sql'), DDL, 'utf8');
    await mkdir(join(repo.root, 'db'));
    await symlink(join(repo.outside, 'schema.sql'), join(repo.root, 'db', 'schema.sql'));
    await assertUnseen(repo, ['db/schema.sql'], 'file link');
  });
});

test('a symbolic link to a directory is a place a schema source may be', async () => {
  await withRepo({ 'src/app.ts': 'export {};\n' }, async (repo) => {
    await mkdir(join(repo.outside, 'prisma'));
    await writeFile(join(repo.outside, 'prisma', 'schema.prisma'), PRISMA, 'utf8');
    await symlink(join(repo.outside, 'prisma'), join(repo.root, 'prisma'));
    await assertUnseen(repo, ['prisma'], 'directory link outside the root');
  });
});

test('a symbolic link to a directory inside a skipped directory is not followed and is unread', async () => {
  await withRepo({ 'vendor/shared/schema.sql': DDL }, async (repo) => {
    await symlink(join(repo.root, 'vendor', 'shared'), join(repo.root, 'shared'));
    const found = await discoverSources({ root: repo.root });
    // The vendored copy is itself a candidate under a skipped output directory, and the link is another.
    assert.deepEqual(found.unread, ['shared', 'vendor/shared/schema.sql']);
  });
});

test('a symbolic link named like a schema file is unread even when it points at nothing', async () => {
  await withRepo({}, async (repo) => {
    await symlink(join(repo.outside, 'missing.prisma'), join(repo.root, 'schema.prisma'));
    await assertUnseen(repo, ['schema.prisma'], 'dangling link with a schema name');
  });
});

test('an internal TypeScript schema link is unread when its target is not read as TypeScript', async () => {
  for (const target of ['schema.source', 'schema.txt', 'schema.d.ts']) {
    for (const otherSql of [false, true]) {
      await withRepo(
        {
          [target]: "export const users = pgTable('users', { email: text('email') });\n",
          ...(otherSql ? { 'db/schema.sql': 'CREATE TABLE users (email text NOT NULL);' } : {}),
        },
        async (repo) => {
          await symlink(join(repo.root, target), join(repo.root, 'schema.ts'));
          const found = await discoverSources({ root: repo.root });
          assert.deepEqual(found.unread, ['schema.ts'], target);
          const out = await run(repo.root);
          assert.equal(out.noSchemaSource, false, target);
          assert.equal(out.result.status, otherSql ? 'PASS' : 'UNAVAILABLE', target);
          if (otherSql) {
            const table = out.nodes.find((n) => n.kind === 'Table');
            const column = out.nodes.find((n) => n.kind === 'Column');
            assert.ok(table !== undefined && column !== undefined);
            assert.equal(Object.hasOwn(table.props, 'declarations'), false, target);
            assert.equal(Object.hasOwn(column.props, 'defaultSite'), false, target);
            assert.ok(out.result.diagnostics.some((d) => d.includes('schema.ts')), target);
          }
        },
      );
    }
  }
});

test('an internal TypeScript link is protected even when its target is read by the same reader', async () => {
  await withRepo(
    { 'schema.js': "export const users = pgTable('users', { email: text('email') });\n" },
    async (repo) => {
      await symlink(join(repo.root, 'schema.js'), join(repo.root, 'schema.ts'));
      const found = await discoverSources({ root: repo.root });
      assert.deepEqual(found.unread, ['schema.ts']);
      assert.deepEqual(found.files.map((file) => file.path), ['schema.js']);
      assert.equal((await run(repo.root)).result.status, 'PASS');
    },
  );
});

test('a schema alias preserves its previous facts when its target is ignored, capped or unreadable', async (t) => {
  for (const mode of ['ignored', 'capped', 'unreadable']) {
    if (mode === 'unreadable' && runsAsRoot) {
      t.diagnostic('unreadable-target case requires an unprivileged process');
      continue;
    }
    await withRepo(
      {
        'anchor.sql': 'CREATE TABLE audit (id int);',
        'schema.ts': "export const users = pgTable('users', { email: text('email') });\n",
      },
      async (repo) => {
        const store = new SqliteStore({ ontologyVersion: '1.0.0' });
        const target = mode === 'ignored' ? 'target.source' : 'target.js';
        try {
          const first = await run(repo.root, { runId: 'r1', maxFileBytes: 1_000 });
          const previous = first.nodes.find((n) => n.kind === 'Column' && n.props['table'] === 'users');
          assert.ok(previous !== undefined);
          await rename(join(repo.root, 'schema.ts'), join(repo.root, target));
          if (mode === 'capped') await writeFile(join(repo.root, target), `// ${'x'.repeat(5_000)}\n`, { flag: 'a' });
          if (mode === 'unreadable') await chmod(join(repo.root, target), 0o000);
          await symlink(join(repo.root, target), join(repo.root, 'schema.ts'));
          const second = await run(repo.root, { runId: 'r2', maxFileBytes: 1_000 });
          assert.equal(second.result.status, 'PASS', mode);
          assert.equal(second.nodes.some((n) => n.id === previous.id), false, mode);
          for (const [runId, out] of [['r1', first], ['r2', second]] as const) {
            await store.beginRun({
              runId, repo: 'demo', commit: null,
              startedAt: '2026-01-01T00:00:00.000Z', ontologyVersion: '1.0.0',
            });
            await store.upsertNodes(runId, out.nodes);
            await store.upsertEdges(runId, 'data.sql', out.edges);
            await store.finalizeRun(runId, [out.result]);
          }
          const kept = store.node(previous.id);
          assert.ok(kept !== undefined, `${mode}: an unread alias cannot authorize deleting its previous column`);
          assert.equal(kept.deletedAt, null, mode);
          assert.equal(kept.lastSeenRun, 'r1', mode);
        } finally {
          if (mode === 'unreadable') await chmod(join(repo.root, target), 0o644);
          await store.close();
        }
      },
    );
  }
});

test('a symbolic link to a file that is not a schema kind hides nothing', async () => {
  await withRepo({ 'docs/guide.md': '# guide\n' }, async (repo) => {
    await symlink(join(repo.root, 'docs', 'guide.md'), join(repo.root, 'README.md'));
    await symlink(join(repo.outside, 'gone'), join(repo.root, 'current'));
    const out = await run(repo.root);
    assert.equal(out.noSchemaSource, true);
    assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
  });
});

test('a symbolic link that cannot be resolved for a reason other than a missing target is unread', async () => {
  await withRepo({}, async (repo) => {
    // A link to itself: stat fails with ELOOP, so whether it is a directory is not known.
    await symlink(join(repo.root, 'loop'), join(repo.root, 'loop'));
    assert.deepEqual((await discoverSources({ root: repo.root })).unread, ['loop']);
  });
});

test('a symbolic link named like a skipped directory is skipped like it', async () => {
  await withRepo({}, async (repo) => {
    await mkdir(join(repo.outside, 'pkgs'));
    await symlink(join(repo.outside, 'pkgs'), join(repo.root, 'node_modules'));
    assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
  });
});

/* ------------------------------------------- (b) SQL schema extensions the SQL reader does not parse */

test('a SQL-family schema file whose extension the SQL reader does not parse is unread', async () => {
  for (const ext of [
    '.ddl',
    '.psql',
    '.pgsql',
    '.mysql',
    '.tsql',
    '.plsql',
    '.cql',
    '.hql',
    '.dbml',
  ]) {
    const rel = `db/schema${ext}`;
    await withRepo({ [rel]: DDL }, async (repo) => {
      await assertUnseen(repo, [rel], ext);
    });
  }
});

test('the extension is compared without regard to case', async () => {
  await withRepo({ 'db/SCHEMA.DDL': DDL }, async (repo) => {
    await assertUnseen(repo, ['db/SCHEMA.DDL'], 'upper case');
  });
});

test('a database file is not a schema declaration and is not a candidate', async () => {
  // Binary database files hold a schema, but reading one is introspection, which this extractor
  // does not do (design v3, section 6); a repository whose only "schema" is one has no source here.
  await withRepo(
    { 'data/dev.db': 'x', 'data/app.sqlite': 'x', 'data/app.sqlite3': 'x' },
    async (repo) => {
      assert.equal((await run(repo.root)).noSchemaSource, true);
    },
  );
});

/* ------------------------------------- (c) Drizzle constructors the Drizzle reader does not parse */

const UNPARSED_DRIZZLE: Readonly<Record<string, string>> = {
  sqliteTable:
    "import { sqliteTable, text } from 'drizzle-orm/sqlite-core';\nexport const users = sqliteTable('users', { id: text('id').primaryKey() });\n",
  mysqlTable:
    "import { mysqlTable, varchar } from 'drizzle-orm/mysql-core';\nexport const users = mysqlTable('users', { id: varchar('id', { length: 36 }) });\n",
  singlestoreTable:
    "import { singlestoreTable, text } from 'drizzle-orm/singlestore-core';\nexport const users = singlestoreTable('users', { id: text('id') });\n",
  pgTableCreator:
    "import { pgTableCreator, text } from 'drizzle-orm/pg-core';\nexport const createTable = pgTableCreator((name) => `app_${name}`);\nexport const posts = createTable('post', { id: text('id') });\n",
  sqliteTableCreator:
    "import { sqliteTableCreator, text } from 'drizzle-orm/sqlite-core';\nexport const createTable = sqliteTableCreator((name) => `app_${name}`);\nexport const posts = createTable('post', { id: text('id') });\n",
  mysqlTableCreator:
    "import { mysqlTableCreator, text } from 'drizzle-orm/mysql-core';\nexport const createTable = mysqlTableCreator((name) => `app_${name}`);\nexport const posts = createTable('post', { id: text('id') });\n",
  singlestoreTableCreator:
    "import { singlestoreTableCreator, text } from 'drizzle-orm/singlestore-core';\nexport const createTable = singlestoreTableCreator((name) => `app_${name}`);\nexport const posts = createTable('post', { id: text('id') });\n",
  mysqlSchema:
    "import { mysqlSchema, text } from 'drizzle-orm/mysql-core';\nexport const app = mysqlSchema('app');\nexport const users = app.table('users', { id: text('id') });\n",
  'aliased pgTable':
    "import { pgTable as table, text } from 'drizzle-orm/pg-core';\nexport const users = table('users', { id: text('id') });\n",
  'aliased sqliteTable':
    "import { sqliteTable as table, text } from 'drizzle-orm/sqlite-core';\nexport const users = table('users', { id: text('id') });\n",
  'aliased mysqlTable':
    "import { mysqlTable as table, text } from 'drizzle-orm/mysql-core';\nexport const users = table('users', { id: text('id') });\n",
  'aliased pgSchema':
    "import { pgSchema as schema, text } from 'drizzle-orm/pg-core';\nexport const app = schema('app');\nexport const users = app.table('users', { id: text('id') });\n",
  're-exported under another name': "export { pgTable as table } from 'drizzle-orm/pg-core';\n",
  'renamed by destructuring':
    "const { pgTable: table } = require('drizzle-orm/pg-core');\nexports.users = table('users', {});\n",
};

test('a module that calls a Drizzle constructor the Drizzle reader does not parse is unread', async () => {
  for (const [label, text] of Object.entries(UNPARSED_DRIZZLE)) {
    const rel = label.includes('destructuring') ? 'src/schema.cjs' : 'src/schema.ts';
    await withRepo({ [rel]: text }, async (repo) => {
      await assertUnseen(repo, [rel], label);
    });
  }
});

test('a module that mentions such a constructor only in a comment or a string is not a candidate', async () => {
  await withRepo(
    {
      'src/notes.ts':
        "// we used to call sqliteTable('users', {}) here\nexport const hint = \"mysqlTable('x') is not used\";\n/* import { pgTable as table } from 'drizzle-orm/pg-core' */\n",
    },
    async (repo) => {
      assert.equal((await run(repo.root)).noSchemaSource, true);
      assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
    },
  );
});

test('an alias of something that is not a Drizzle module is not a candidate', async () => {
  await withRepo(
    {
      'src/a.ts':
        "import { pgTable as table } from 'some-other-orm';\nexport const t = table('x');\n",
      'src/b.ts': "import { eq as equals } from 'drizzle-orm';\nexport const e = equals;\n",
    },
    async (repo) => {
      assert.equal((await run(repo.root)).noSchemaSource, true);
    },
  );
});

test('an unparsed Drizzle declaration is unread regardless of test basename or directory', async () => {
  const text = "export const local = sqliteTable('local', {});\n";
  await withRepo(
    {
      'src/schema.ts': text,
      'src/schema.test.ts': text,
      'src/schema.spec.js': text,
      'src/__tests__/schema.ts': text,
      'src/__fixtures__/db/schema.ts': text,
    },
    async (repo) => {
      const found = await discoverSources({ root: repo.root });
      assert.deepEqual(found.unread, [
        'src/__fixtures__/db/schema.ts',
        'src/__tests__/schema.ts',
        'src/schema.spec.js',
        'src/schema.test.ts',
        'src/schema.ts',
      ]);
      const out = await run(repo.root);
      assert.equal(out.result.status, 'UNAVAILABLE');
      assert.equal(out.noSchemaSource, false);
    },
  );
});

test('a test basename cannot make an unparsed declaration look like no schema', async () => {
  for (const rel of ['src/schema.test.ts', 'src/schema.spec.js']) {
    await withRepo({ [rel]: UNPARSED_DRIZZLE['sqliteTable'] as string }, async (repo) => {
      await assertUnseen(repo, [rel], rel);
    });
  }
});

test('a test module quoting Drizzle declarations in strings or comments hides no schema', async () => {
  const text = `
    // import { sqliteTable } from 'drizzle-orm/sqlite-core';
    /* const users = mysqlTable('users', {}); */
    export const sample = "const users = sqliteTable('users', {});";
    export const fixture = \`import { pgTable as table } from 'drizzle-orm/pg-core';\`;
  `;
  for (const rel of ['src/schema.test.ts', 'src/schema.spec.js']) {
    await withRepo({ [rel]: text }, async (repo) => {
      assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
      assert.equal((await run(repo.root)).noSchemaSource, true);
    });
  }
});

test('string-valued constructor labels are fixture data, while a declaration beside them stays unread', async () => {
  const labels = `
    export const fixtures = {
      sqliteTable: "import { sqliteTable } from 'drizzle-orm/sqlite-core';",
      mysqlTable: "const local = mysqlTable('local', {});",
      pgTable: "import { pgTable as table } from 'drizzle-orm/pg-core';",
    };
  `;
  for (const rel of ['src/schema.ts', 'src/schema.test.ts', 'src/schema.spec.js']) {
    await withRepo({ [rel]: labels }, async (repo) => {
      assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
      assert.equal((await run(repo.root)).noSchemaSource, true);
    });
    await withRepo(
      { [rel]: labels + "export const local = sqliteTable('local', {});\n" },
      async (repo) => {
        await assertUnseen(repo, [rel], rel);
      },
    );
  }
});

test('a pgTable module under a fixtures directory is still discovered as a parsed Drizzle file', async () => {
  await withRepo(
    { 'src/__fixtures__/schema.ts': "export const u = pgTable('u', { id: serial('id') });\n" },
    async (repo) => {
      const found = await discoverSources({ root: repo.root });
      assert.deepEqual(
        found.files.map((f) => [f.path, f.kind]),
        [['src/__fixtures__/schema.ts', 'drizzle']],
      );
    },
  );
});

test('a *.test.ts too large to read that looks like Drizzle is still reported unread', async () => {
  const head = "import { pgTable } from 'drizzle-orm/pg-core';\n";
  await withRepo({ 'src/schema.test.ts': head + '// '.padEnd(200, 'x') + '\n' }, async (repo) => {
    const found = await discoverSources({ root: repo.root, maxFileBytes: 100 });
    assert.deepEqual(found.unread, ['src/schema.test.ts']);
  });
});

test('an oversized unsupported Drizzle schema never becomes no schema, even after a long preamble', async () => {
  for (const name of ['sqliteTable', 'mysqlTable', 'singlestoreTable', 'pgTableCreator']) {
    for (const preamble of ['', `/* ${'x'.repeat(20_000)} */\n`]) {
      const rel = 'src/schema.ts';
      const text = preamble + (UNPARSED_DRIZZLE[name] as string) + `\n// ${'x'.repeat(2_000)}`;
      await withRepo({ [rel]: text }, async (repo) => {
        const found = await discoverSources({ root: repo.root, maxFileBytes: 1_000 });
        assert.deepEqual(found.files, [], name);
        assert.deepEqual(found.unread, [rel], name);
        const out = await run(repo.root, { maxFileBytes: 1_000 });
        assert.equal(out.result.status, 'UNAVAILABLE', name);
        assert.equal(out.noSchemaSource, false, name);
      });
    }
  }
});

test('a module of parsed Drizzle tables is read, not unread', async () => {
  await withRepo(
    {
      'src/schema.ts':
        "export const users = pgTable('users', { id: serial('id').primaryKey() });\n",
    },
    async (repo) => {
      const found = await discoverSources({ root: repo.root });
      assert.deepEqual(
        found.files.map((f) => f.path),
        ['src/schema.ts'],
      );
      assert.deepEqual(found.unread, []);
      assert.equal((await run(repo.root)).result.status, 'PASS');
    },
  );
});

test('a module that holds parsed tables and an unparsed one is read and also listed as unread', async () => {
  await withRepo(
    {
      'src/schema.ts':
        "export const users = pgTable('users', { id: serial('id').primaryKey() });\nexport const local = sqliteTable('local', {});\n",
    },
    async (repo) => {
      const found = await discoverSources({ root: repo.root });
      assert.deepEqual(
        found.files.map((f) => f.path),
        ['src/schema.ts'],
      );
      assert.deepEqual(found.unread, ['src/schema.ts']);
      const out = await run(repo.root);
      assert.equal(out.result.status, 'PASS', 'the table it does parse is still a PASS');
      assert.equal(out.noSchemaSource, false);
    },
  );
});

/* ------------------------------------------------------- (d) Prisma schema pointers */

const pkg = (prisma: unknown): string => JSON.stringify({ name: 'demo', prisma });

test('a package.json pointer to a Prisma schema discovery did not open makes it unread', async () => {
  await withRepo(
    { 'package.json': pkg({ schema: 'db/app.schema' }), 'db/app.schema': PRISMA },
    async (repo) => {
      await assertUnseen(repo, ['db/app.schema'], 'a name that is not .prisma');
    },
  );
});

test('a pointer to a file that does not exist is unread', async () => {
  await withRepo({ 'package.json': pkg({ schema: './db/generated.prisma' }) }, async (repo) => {
    await assertUnseen(repo, ['db/generated.prisma'], 'a missing file');
  });
});

test('a pointer into a directory the walk skips is unread, node_modules included', async () => {
  await withRepo(
    { 'package.json': pkg({ schema: 'node_modules/@acme/db/schema.prisma' }) },
    async (repo) => {
      await assertUnseen(
        repo,
        ['node_modules/@acme/db/schema.prisma'],
        'a pointer into node_modules',
      );
    },
  );
});

test('a pointer outside the repository is recorded as the file that holds it', async () => {
  await withRepo({ 'package.json': pkg({ schema: '../shared/schema.prisma' }) }, async (repo) => {
    await assertUnseen(repo, ['package.json'], 'a relative pointer that leaves the root');
  });
  await withRepo({ 'package.json': pkg({ schema: '/srv/shared/schema.prisma' }) }, async (repo) => {
    await assertUnseen(repo, ['package.json'], 'an absolute pointer outside the root');
  });
});

test('a pointer to a Prisma schema that was read is not unread', async () => {
  await withRepo(
    {
      'package.json': pkg({ schema: 'prisma/schema.prisma', seed: 'node seed.js' }),
      'prisma/schema.prisma': PRISMA,
      'packages/db/package.json': pkg({ schema: 'models/main.prisma' }),
      'packages/db/models/main.prisma': 'model Other {\n  id Int @id\n}\n',
    },
    async (repo) => {
      const found = await discoverSources({ root: repo.root });
      assert.deepEqual(found.unread, []);
      assert.equal(found.files.length, 2);
      const out = await run(repo.root);
      assert.equal(out.result.status, 'PASS');
      assert.deepEqual(out.result.diagnostics, []);
    },
  );
});

test('a pointer to a directory is satisfied by a Prisma file read under it, and not by an empty one', async () => {
  await withRepo(
    { 'package.json': pkg({ schema: 'db/prisma' }), 'db/prisma/user.prisma': PRISMA },
    async (repo) => {
      assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
    },
  );
  await withRepo(
    { 'package.json': pkg({ schema: 'db/prisma' }), 'db/prisma/README.md': 'no schema here\n' },
    async (repo) => {
      await assertUnseen(repo, ['db/prisma'], 'a directory with no .prisma file in it');
    },
  );
});

test('a package.json that holds no Prisma schema pointer is not a candidate', async () => {
  await withRepo(
    {
      'package.json': JSON.stringify({ name: 'demo', prisma: { seed: 'node seed.js' } }),
      'packages/a/package.json': JSON.stringify({ name: 'a', dependencies: { prisma: '^6.0.0' } }),
      'packages/b/package.json': '{ not json, mentions "prisma" and "schema" }',
      'packages/c/package.json': JSON.stringify({ name: 'c', prisma: { schema: 42 } }),
    },
    async (repo) => {
      assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
      assert.equal((await run(repo.root)).noSchemaSource, true);
    },
  );
});

test('a prisma.config.ts schema literal is a pointer, resolved from the file that holds it', async () => {
  await withRepo(
    {
      'prisma.config.ts':
        "import { defineConfig } from 'prisma/config';\nexport default defineConfig({ schema: 'db/app.schema' });\n",
      'db/app.schema': PRISMA,
    },
    async (repo) => {
      await assertUnseen(repo, ['db/app.schema'], 'a literal');
    },
  );
  await withRepo(
    {
      'packages/api/prisma.config.mjs': "export default { schema: './models' };\n",
      'packages/api/models/user.prisma': PRISMA,
    },
    async (repo) => {
      assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
    },
  );
});

test('a prisma.config.ts path.join of literals is resolved; one that is not a literal is unread when nothing was read', async () => {
  await withRepo(
    {
      'prisma.config.ts':
        "import path from 'node:path';\nexport default { schema: path.join('db', 'app.schema') };\n",
    },
    async (repo) => {
      await assertUnseen(repo, ['db/app.schema'], 'path.join of literals');
    },
  );
  await withRepo(
    { 'prisma.config.ts': 'export default { schema: process.env.PRISMA_SCHEMA };\n' },
    async (repo) => {
      await assertUnseen(repo, ['prisma.config.ts'], 'a pointer that is not a literal');
    },
  );
  // Something was read, so the file is not what keeps the repository from being known.
  await withRepo(
    {
      'prisma.config.ts': 'export default { schema: process.env.PRISMA_SCHEMA };\n',
      'prisma/schema.prisma': PRISMA,
    },
    async (repo) => {
      assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
    },
  );
});

/* ------------------------------------------------ (e) schema files under skipped directories */

test('a .sql or .prisma file under an output or vendor directory is unread, at any depth', async () => {
  for (const dir of [
    'vendor',
    'build',
    'dist',
    'out',
    'target',
    '.next',
    '.nuxt',
    '.output',
    '.svelte-kit',
  ]) {
    await withRepo(
      { [`${dir}/db/schema.sql`]: DDL, [`apps/web/${dir}/schema.prisma`]: PRISMA },
      async (repo) => {
        const found = await discoverSources({ root: repo.root });
        assert.deepEqual(found.files, [], dir);
        assert.deepEqual(
          found.unread,
          [`${dir}/db/schema.sql`, `apps/web/${dir}/schema.prisma`].sort(),
          dir,
        );
        assert.equal((await run(repo.root)).noSchemaSource, false, dir);
      },
    );
  }
});

test('a schema file moved into vendor/ is unseen, not absent', async () => {
  await withRepo({ 'db/schema.sql': DDL }, async (repo) => {
    assert.equal((await run(repo.root)).result.status, 'PASS');
    await mkdir(join(repo.root, 'vendor', 'db'), { recursive: true });
    await rename(
      join(repo.root, 'db', 'schema.sql'),
      join(repo.root, 'vendor', 'db', 'schema.sql'),
    );
    await assertUnseen(repo, ['vendor/db/schema.sql'], 'moved into vendor');
  });
});

test('dependency and tool directories are never walked, so nothing in them is unread', async () => {
  const files: Record<string, string> = {};
  for (const dir of [
    'node_modules',
    '.git',
    '.pnpm-store',
    '.yarn',
    '.venv',
    'venv',
    '__pycache__',
    '.cache',
    '.turbo',
    'coverage',
  ]) {
    files[`${dir}/pkg/schema.sql`] = DDL;
    files[`${dir}/pkg/schema.prisma`] = PRISMA;
  }
  await withRepo(files, async (repo) => {
    assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
    assert.equal((await run(repo.root)).noSchemaSource, true);
  });
});

test('a dependency directory inside an output directory is not walked either', async () => {
  await withRepo(
    { 'dist/node_modules/pkg/schema.sql': DDL, 'dist/app.js': 'x\n' },
    async (repo) => {
      assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
    },
  );
});

test('only schema-kind files in an output directory count', async () => {
  await withRepo(
    {
      'dist/app.js': "export const users = pgTable('users', {});\n",
      'dist/data.json': '{}\n',
      'build/notes.md': '# notes\n',
      'out/page.html': '<p>sql</p>\n',
    },
    async (repo) => {
      assert.deepEqual((await discoverSources({ root: repo.root })).unread, []);
      assert.equal((await run(repo.root)).noSchemaSource, true);
    },
  );
});

test('a directory the user names in skipDirs is their choice and is not walked', async () => {
  await withRepo({ 'db/schema.sql': DDL, 'legacy/old.prisma': PRISMA }, async (repo) => {
    const out = await run(repo.root, { skipDirs: ['db', 'legacy'] });
    assert.equal(out.noSchemaSource, true, 'told not to look there');
    assert.deepEqual(
      (await discoverSources({ root: repo.root, skipDirs: ['db', 'legacy'] })).unread,
      [],
    );
  });
});

test('naming an output directory in skipDirs opts it out of being walked', async () => {
  await withRepo({ 'vendor/third-party/schema.sql': DDL, 'dist/schema.sql': DDL }, async (repo) => {
    const found = await discoverSources({ root: repo.root, skipDirs: ['vendor'] });
    assert.deepEqual(found.unread, ['dist/schema.sql'], 'vendor was named, dist was not');
  });
});

/* ------------------------------------------------------------ (f) the unread list is visible */

test('a PASS that skipped a schema candidate says so, and the status is unchanged', async () => {
  await withRepo(
    {
      'prisma/schema.prisma': PRISMA,
      'vendor/db/old.sql': DDL,
      'db/schema.ddl': DDL,
    },
    async (repo) => {
      const out = await run(repo.root);
      assert.equal(out.result.status, 'PASS');
      assert.equal(out.noSchemaSource, false);
      const lines = out.result.diagnostics.filter((d) =>
        d.startsWith('schema candidates were not read'),
      );
      assert.equal(lines.length, 1, JSON.stringify(out.result.diagnostics));
      const line = lines[0] ?? '';
      assert.ok(line.includes('(2)'), line);
      assert.ok(line.includes('db/schema.ddl, vendor/db/old.sql'), line);
      assert.ok(
        out.nodes.some((n) => n.id === 'demo:Table:public.User'),
        'the table that was read is still emitted',
      );
    },
  );
});

test('the unread diagnostic lists five paths and counts the rest', async () => {
  const files: Record<string, string> = { 'prisma/schema.prisma': PRISMA };
  for (const n of [1, 2, 3, 4, 5, 6, 7]) files[`vendor/m${n}.sql`] = DDL;
  await withRepo(files, async (repo) => {
    const out = await run(repo.root);
    const line =
      out.result.diagnostics.find((d) => d.startsWith('schema candidates were not read')) ?? '';
    assert.ok(line.includes('(7)'), line);
    assert.ok(
      line.endsWith(
        'vendor/m1.sql, vendor/m2.sql, vendor/m3.sql, vendor/m4.sql, vendor/m5.sql, ...',
      ),
      line,
    );
  });
});

test('a sources-read-but-no-tables run also lists what it did not read', async () => {
  await withRepo(
    { 'seed.sql': 'INSERT INTO nothing VALUES (1);\n', 'db/schema.ddl': DDL },
    async (repo) => {
      const out = await run(repo.root);
      assert.equal(out.result.status, 'UNAVAILABLE');
      assert.equal(out.noSchemaSource, false);
      assert.ok(
        out.result.diagnostics.some((d) => d.startsWith('schema candidates were not read')),
      );
    },
  );
});

/* ------------------------------------------------------------------ (g) the wording */

test('"found none" names what this extractor reads and what it does not', async () => {
  await withRepo({ 'src/app.ts': 'export {};\n' }, async (repo) => {
    const out = await run(repo.root);
    assert.equal(out.noSchemaSource, true);
    const line = out.result.diagnostics.find((d) => d.startsWith('no schema source found')) ?? '';
    assert.ok(line.includes('none this extractor reads'), line);
    assert.ok(!/declares no tables/u.test(line), 'it is not a statement about the repository');
    for (const form of ['.sql', '.prisma', 'pgTable', 'other ORMs', 'database files', 'skipDirs']) {
      assert.ok(line.includes(form), `${form}: ${line}`);
    }
  });
});

/* ------------------------------------------------------------- a directory that cannot be listed */

test(
  'an output directory that cannot be listed is a place a schema source may be',
  { skip: runsAsRoot ? 'a permission bit does not stop root' : false },
  async () => {
    await withRepo({ 'vendor/db/schema.sql': DDL, 'src/app.ts': 'export {};\n' }, async (repo) => {
      await chmod(join(repo.root, 'vendor', 'db'), 0o000);
      try {
        const found = await discoverSources({ root: repo.root });
        assert.deepEqual(found.unread, ['vendor/db']);
        assert.equal((await run(repo.root)).noSchemaSource, false);
      } finally {
        await chmod(join(repo.root, 'vendor', 'db'), 0o755);
      }
    });
  },
);
