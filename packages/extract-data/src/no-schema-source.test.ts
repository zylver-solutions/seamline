/**
 * "Found no schema source" against "could not read one".
 *
 * Both are UNAVAILABLE. Only the first lets a caller treat the data-model
 * index as empty (discovery found none, and knew of nothing it did not read; a
 * statement about discovery, not about the repository), and `noSchemaSource` is how a caller tells
 * them apart without reading a diagnostic. A caller that treats the second like
 * the first would read a table it could not see as a table that does not exist.
 *
 * The three permission tests at the end (an unopenable file, an unlistable
 * directory, a directory that lists but cannot be searched) skip when run as
 * root, because a mode bit does not stop root: a run as root leaves the branches
 * they guard (the `readdir`, `stat` and `readFile` failures of discovery) with
 * little or no coverage. Run this file as an unprivileged user to
 * exercise them, for example
 * `setpriv --reuid 65534 --regid 65534 --clear-groups node --test <this file>`
 * (with a TMPDIR that user can write). `discover-unread.test.ts` has one more.
 */

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { discoverSources } from './discover.ts';
import { extractData, type ExtractDataOptions, type ExtractDataOutput } from './extractor.ts';

const PRISMA = 'model User {\n  id Int @id\n}\n';

async function withRepo(
  files: Readonly<Record<string, string>>,
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'seamline-no-schema-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(root, rel, '..'), { recursive: true });
      await writeFile(join(root, rel), text, 'utf8');
    }
    await body(root);
  } finally {
    // A directory the test made unreadable must be openable again to be removed.
    await chmod(join(root, 'locked'), 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

function run(root: string, extra: Partial<ExtractDataOptions> = {}): Promise<ExtractDataOutput> {
  return extractData({ root, repo: 'demo', runId: 'run-1', deterministic: true, ...extra });
}

// A permission bit does not stop root, so the permission tests only mean something otherwise.
const runsAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('a repository with no schema source at all says so, as a flag', async () => {
  await withRepo(
    { 'src/app.ts': "export const greeting = 'hello';\n", 'README.md': '# demo\n' },
    async (root) => {
      const out = await run(root);
      assert.equal(out.result.status, 'UNAVAILABLE');
      assert.equal(out.noSchemaSource, true);
      assert.ok(out.result.diagnostics.some((d) => d.startsWith('no schema source found')));
      assert.equal(out.nodes.length, 0, 'no tables, and no lone DataSource node either');
    },
  );
});

test('a repository that does not exist is not a repository with no schema source', async () => {
  const out = await run(join(tmpdir(), 'seamline-no-schema-does-not-exist'));
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.noSchemaSource, false, 'the root could not be listed, so nothing was looked at');
});

test('a schema file over the size limit is a source that could not be read', async () => {
  await withRepo({ 'prisma/schema.prisma': PRISMA }, async (root) => {
    const out = await run(root, { maxFileBytes: 8 });
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(out.noSchemaSource, false);
    assert.ok(
      out.result.diagnostics.some(
        (d) => d.startsWith('no schema source could be read') && d.includes('prisma/schema.prisma'),
      ),
      JSON.stringify(out.result.diagnostics),
    );
    assert.ok(
      !out.result.diagnostics.some((d) => d.startsWith('no schema source found')),
      'it must not claim there was none',
    );
  });
});

test('every kind of candidate that is skipped counts: .sql, .prisma, and a TypeScript module', async () => {
  for (const [rel, text] of [
    ['db/schema.sql', 'CREATE TABLE users (id int);\n'],
    ['prisma/schema.prisma', PRISMA],
    ['src/schema.ts', "export const users = pgTable('users', {});\n"],
    ['src/schema.mjs', "export const users = pgTable('users', {});\n"],
  ] as const) {
    await withRepo({ [rel]: text }, async (root) => {
      const out = await run(root, { maxFileBytes: 8 });
      assert.equal(out.noSchemaSource, false, rel);
      assert.equal(out.result.status, 'UNAVAILABLE', rel);
    });
  }
});

test('a TypeScript module that is read and holds no Drizzle table is not a schema source', async () => {
  await withRepo({ 'src/app.ts': "export const sql = 'select 1';\n" }, async (root) => {
    const out = await run(root);
    assert.equal(out.noSchemaSource, true);
  });
});

test('files that are not a schema kind are never candidates, however large', async () => {
  await withRepo(
    { 'assets/data.json': 'x'.repeat(100), 'docs/notes.md': 'y'.repeat(100) },
    async (root) => {
      const out = await run(root, { maxFileBytes: 8 });
      assert.equal(out.noSchemaSource, true);
    },
  );
});

test('sources that were read but declare no tables are not "no schema source"', async () => {
  await withRepo({ 'seed.sql': 'INSERT INTO nothing VALUES (1);\n' }, async (root) => {
    const out = await run(root);
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(
      out.noSchemaSource,
      false,
      'a source was read; what it declares is another matter',
    );
  });
});

test('a PASS is not "no schema source"', async () => {
  await withRepo({ 'prisma/schema.prisma': PRISMA }, async (root) => {
    const out = await run(root);
    assert.equal(out.result.status, 'PASS');
    assert.equal(out.noSchemaSource, false);
  });
});

test('a skipped directory (node_modules) is not an unread one', async () => {
  await withRepo(
    { 'node_modules/pkg/schema.prisma': PRISMA, 'src/app.ts': 'export {};\n' },
    async (root) => {
      // The prisma file would be over the limit, but nothing under node_modules is looked at.
      const out = await run(root, { maxFileBytes: 20 });
      assert.equal(out.noSchemaSource, true);
    },
  );
});

test('discovery lists what it could not read, sorted and repo-relative', async () => {
  await withRepo(
    {
      'z/last.sql': 'CREATE TABLE a (id int);\n',
      'a/first.prisma': PRISMA,
      'a/small.sql': 'x\n',
    },
    async (root) => {
      const { files, unread } = await discoverSources({ root, maxFileBytes: 10 });
      assert.deepEqual(
        files.map((f) => f.path),
        ['a/small.sql'],
      );
      assert.deepEqual(unread, ['a/first.prisma', 'z/last.sql']);
    },
  );
});

test(
  'a schema file that cannot be opened is a source that could not be read',
  { skip: runsAsRoot ? 'a permission bit does not stop root' : false },
  async () => {
    await withRepo({ 'db/schema.sql': 'CREATE TABLE users (id int);\n' }, async (root) => {
      await chmod(join(root, 'db', 'schema.sql'), 0o000);
      const out = await run(root);
      assert.equal(out.result.status, 'UNAVAILABLE');
      assert.equal(out.noSchemaSource, false);
    });
  },
);

test(
  'a directory that lists but cannot be searched leaves its schema file unreadable, not absent',
  { skip: runsAsRoot ? 'a permission bit does not stop root' : false },
  async () => {
    await withRepo({ 'locked/schema.sql': 'CREATE TABLE users (id int);\n' }, async (root) => {
      // Mode 0444: readdir lists the entry, and stat of it fails (no search permission), which is
      // the branch of discovery that is neither the readdir failure nor the readFile one.
      await chmod(join(root, 'locked'), 0o444);
      const { files, unread } = await discoverSources({ root });
      assert.deepEqual(files, []);
      assert.deepEqual(unread, ['locked/schema.sql']);
      const out = await run(root);
      assert.equal(out.result.status, 'UNAVAILABLE');
      assert.equal(out.noSchemaSource, false);
    });
  },
);

test(
  'a directory that cannot be listed is a place a schema source may be',
  { skip: runsAsRoot ? 'a permission bit does not stop root' : false },
  async () => {
    await withRepo(
      { 'locked/schema.sql': 'CREATE TABLE users (id int);\n', 'src/app.ts': 'export {};\n' },
      async (root) => {
        await chmod(join(root, 'locked'), 0o000);
        const out = await run(root);
        assert.equal(out.result.status, 'UNAVAILABLE');
        assert.equal(out.noSchemaSource, false);
        assert.ok(out.result.diagnostics.some((d) => d.includes('locked')));
      },
    );
  },
);
