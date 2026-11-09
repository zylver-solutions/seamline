/**
 * A run that could not read a schema candidate does not bury what that candidate declared.
 *
 * Invariant 2: tombstoning is confined to the run's authoritative scope. `extract-data`
 * reports PASS whenever it read at least one source, so a candidate it skipped (a
 * symbolic link, a file over the size limit, a file it could not open, an extension it
 * does not parse, a file moved under an output directory; `Discovery.unread`) used to be
 * inside the claim, and the tables it declared were tombstoned although this run never
 * saw the file. The selector now excludes every unread path, so those tables are outside
 * the claim; a file that is genuinely gone is still inside it.
 *
 * Real extractor, real store, two runs, `deleted_at` read straight off the rows.
 *
 * The permission variant needs a user the mode bits bind, so it skips as root. Run this
 * file as an unprivileged user to exercise it:
 * `setpriv --reuid 65534 --regid 65534 --clear-groups node --experimental-strip-types --test <this file>`.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { nodeId } from '@seamline/ontology';
import type { NodeId, NodeKind } from '@seamline/ontology';
import { SqliteStore } from '@seamline/core';
import { DATA_SCOPE, extractData, type ExtractDataOptions } from '@seamline/extract-data';

const REPO = 'unreadscope';
const A_SQL = 'CREATE TABLE a (id bigint PRIMARY KEY, name text);\n';
const B_SQL = 'CREATE TABLE b (id bigint PRIMARY KEY, label text);\n';

const runsAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function id(kind: NodeKind, canonicalName: string): NodeId {
  return nodeId(REPO, kind, canonicalName);
}

interface Fixture {
  readonly root: string;
  /** A directory beside the repository: a link target there is not read by the run. */
  readonly outside: string;
  extract(runId: string, opts?: Partial<ExtractDataOptions>): Promise<readonly string[]>;
  deletedAt(ids: ReadonlyArray<NodeId>): Record<string, string | null>;
}

async function write(root: string, rel: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await writeFile(join(root, rel), text, 'utf8');
}

async function withFixture(
  files: Readonly<Record<string, string>>,
  body: (fx: Fixture) => Promise<void>,
): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), 'seamline-unread-scope-'));
  const root = join(parent, 'repo');
  const storePath = join(parent, 'graph.db');
  try {
    const outside = join(parent, 'external');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    for (const [rel, text] of Object.entries(files)) await write(root, rel, text);
    const fx: Fixture = {
      root,
      outside,
      async extract(runId, opts = {}) {
        const data = await extractData({
          root,
          repo: REPO,
          runId,
          deterministic: true,
          ...opts,
        });
        assert.equal(data.result.status, 'PASS', `${runId}: ${data.result.diagnostics.join('; ')}`);
        const store = new SqliteStore({ path: storePath, ontologyVersion: '1.0.0' });
        try {
          await store.beginRun({
            runId,
            repo: REPO,
            commit: null,
            startedAt: '2026-01-01T00:00:00.000Z',
            ontologyVersion: '1.0.0',
          });
          await store.upsertNodes(runId, data.nodes);
          await store.upsertEdges(runId, DATA_SCOPE, data.edges);
          await store.finalizeRun(runId, [data.result]);
        } finally {
          await store.close();
        }
        return data.result.diagnostics;
      },
      deletedAt(ids) {
        const raw = new DatabaseSync(storePath, { readOnly: true });
        try {
          const stmt = raw.prepare('SELECT deleted_at FROM nodes WHERE id = :id');
          const out: Record<string, string | null> = {};
          for (const nid of ids) {
            const row = stmt.get({ id: nid }) as { deleted_at: string | null } | undefined;
            assert.ok(row !== undefined, `expected a persisted row for ${nid}`);
            out[nid] = row.deleted_at;
          }
          return out;
        } finally {
          raw.close();
        }
      },
    };
    await body(fx);
  } finally {
    await chmod(join(root, 'db', 'b.sql'), 0o644).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  }
}

function all(ids: ReadonlyArray<NodeId>, value: string | null): Record<string, string | null> {
  return Object.fromEntries(ids.map((nid) => [nid, value]));
}

const TABLE_A = [
  id('Table', 'public.a'),
  id('Column', 'public.a.id'),
  id('Column', 'public.a.name'),
];
const TABLE_B = [
  id('Table', 'public.b'),
  id('Column', 'public.b.id'),
  id('Column', 'public.b.label'),
];

/**
 * An unread candidate is visible in the run's diagnostics, either named with its reason (a file too
 * large or unreadable, a symbolic link, a directory that could not be listed) or in the list of
 * candidates that were not read (a form no reader parses, a file under an output directory).
 */
function reportsUnread(d: string): boolean {
  return d.startsWith('schema candidates were not read') || d.startsWith('schema source not read');
}

/**
 * Run 1 reads both files; `hide` makes b.sql unread; run 2 changes a.sql so that `public.a`
 * is genuinely gone (it now declares `a2`), which is what shows run 2 still sweeps.
 */
async function assertBStaysLive(
  hide: (root: string, outside: string) => Promise<void>,
  opts: Partial<ExtractDataOptions> = {},
): Promise<void> {
  await withFixture({ 'db/a.sql': A_SQL, 'db/b.sql': B_SQL }, async (fx) => {
    await fx.extract('run-1', opts);
    assert.deepEqual(fx.deletedAt([...TABLE_A, ...TABLE_B]), all([...TABLE_A, ...TABLE_B], null));
    await hide(fx.root, fx.outside);
    await write(fx.root, 'db/a.sql', 'CREATE TABLE a2 (id bigint PRIMARY KEY);\n');
    const diagnostics = await fx.extract('run-2', opts);
    assert.ok(
      diagnostics.some(reportsUnread),
      JSON.stringify(diagnostics),
    );
    assert.deepEqual(fx.deletedAt(TABLE_B), all(TABLE_B, null), 'what b.sql declared stays live');
    assert.deepEqual(fx.deletedAt(TABLE_A), all(TABLE_A, 'run-2'), 'a read file still sweeps');
    assert.deepEqual(
      fx.deletedAt([id('Table', 'public.a2')]),
      all([id('Table', 'public.a2')], null),
    );
  });
}

test('b.sql replaced by a symbolic link: public.b stays live, public.a behaves as before', async () => {
  await assertBStaysLive(async (root, outside) => {
    await write(outside, 'real.sql', B_SQL);
    await rm(join(root, 'db', 'b.sql'));
    await symlink(join(outside, 'real.sql'), join(root, 'db', 'b.sql'));
  });
});

test('b.sql over the size limit: public.b stays live', async () => {
  await assertBStaysLive(
    async (root) => {
      await write(root, 'db/b.sql', `${B_SQL}-- ${'x'.repeat(400)}\n`);
    },
    { maxFileBytes: 300 },
  );
});

test('b.sql renamed to an extension the reader does not parse: public.b stays live', async () => {
  await assertBStaysLive(async (root) => {
    await rename(join(root, 'db', 'b.sql'), join(root, 'db', 'b.ddl'));
  });
});

test('b.sql moved into an output directory: public.b stays live', async () => {
  await assertBStaysLive(async (root) => {
    await mkdir(join(root, 'vendor'), { recursive: true });
    await rename(join(root, 'db', 'b.sql'), join(root, 'vendor', 'b.sql'));
  });
});

test(
  'b.sql the run may not open (mode 0, as an unprivileged user): public.b stays live',
  {
    skip: runsAsRoot
      ? 'a mode bit does not stop root; run as uid 65534 (see the file header)'
      : false,
  },
  async () => {
    await assertBStaysLive(async (root) => {
      await chmod(join(root, 'db', 'b.sql'), 0o000);
    });
  },
);

test('a table created in a.sql and altered in an unread b.sql stays live, with what b.sql added', async () => {
  const files = {
    'db/a.sql': 'CREATE TABLE shared (id bigint PRIMARY KEY);\n',
    'db/b.sql': 'ALTER TABLE shared ADD COLUMN extra text;\n',
  };
  const table = id('Table', 'public.shared');
  const created = id('Column', 'public.shared.id');
  const added = id('Column', 'public.shared.extra');
  await withFixture(files, async (fx) => {
    await fx.extract('run-1');
    assert.deepEqual(fx.deletedAt([table, created, added]), all([table, created, added], null));
    await write(fx.outside, 'real.sql', files['db/b.sql']);
    await rm(join(fx.root, 'db', 'b.sql'));
    await symlink(join(fx.outside, 'real.sql'), join(fx.root, 'db', 'b.sql'));
    await fx.extract('run-2');
    // The table and its first column are re-observed from a.sql. The column b.sql added is
    // owned by b.sql (the file of the statement that declared it), which is unread: outside
    // the claim, so protected rather than reported as removed.
    assert.deepEqual(fx.deletedAt([table, created, added]), all([table, created, added], null));
  });
});

test('a table created in an unread a.sql and altered in b.sql stays live', async () => {
  const files = {
    'db/a.sql': 'CREATE TABLE shared (id bigint PRIMARY KEY);\n',
    'db/b.sql':
      'CREATE TABLE other (id bigint PRIMARY KEY);\nALTER TABLE shared ADD COLUMN extra text;\n',
  };
  const ids = [
    id('Table', 'public.shared'),
    id('Column', 'public.shared.id'),
    id('Column', 'public.shared.extra'),
  ];
  await withFixture(files, async (fx) => {
    await fx.extract('run-1');
    await write(fx.outside, 'real.sql', files['db/a.sql']);
    await rm(join(fx.root, 'db', 'a.sql'));
    await symlink(join(fx.outside, 'real.sql'), join(fx.root, 'db', 'a.sql'));
    await fx.extract('run-2');
    assert.deepEqual(fx.deletedAt(ids), all(ids, null));
  });
});

test('a genuinely deleted b.sql still tombstones its tables, and a.sql stays live', async () => {
  await withFixture({ 'db/a.sql': A_SQL, 'db/b.sql': B_SQL }, async (fx) => {
    await fx.extract('run-1');
    await rm(join(fx.root, 'db', 'b.sql'));
    const diagnostics = await fx.extract('run-2');
    assert.ok(!diagnostics.some((d) => d.startsWith('schema candidates were not read')));
    assert.deepEqual(fx.deletedAt(TABLE_B), all(TABLE_B, 'run-2'));
    assert.deepEqual(fx.deletedAt(TABLE_A), all(TABLE_A, null));
  });
});

test('the selector is byte-reproducible: sorted, and the same unread set is the same text', async () => {
  const selectors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await withFixture(
      { 'db/a.sql': A_SQL, 'z.ddl': 'x', 'a.ddl': 'y', 'weird, name!.ddl': 'z' },
      async (fx) => {
        const out = await extractData({
          root: fx.root,
          repo: REPO,
          runId: 'r',
          deterministic: true,
        });
        selectors.push(out.result.authoritative.map((s) => s.selector ?? '').join('|'));
      },
    );
  }
  assert.equal(selectors[0], selectors[1]);
  const exclusions = (selectors[0] as string).split(',').filter((x) => x.startsWith('!'));
  assert.deepEqual(exclusions, [...exclusions].sort());
  assert.ok(exclusions.includes('!a.ddl') && exclusions.includes('!z.ddl/**'), selectors[0] ?? '');
  assert.ok(exclusions.includes('!**/a.sql'), selectors[0] ?? '');
  // A name the selector syntax cannot write is excluded by a pattern that over-matches it.
  assert.ok(exclusions.includes('!weird? name!.ddl'), selectors[0] ?? '');
  assert.ok(exclusions.includes('!**/* name!.sql'), selectors[0] ?? '');
});

/**
 * An unread path that holds a character a selector pattern cannot write used to make the
 * claim uncompilable (`<name>/**` with a wildcard before `**`), so `finalizeRun` threw and the
 * whole run was lost. Each case: run 1 reads the odd file and `app/a.sql`; before run 2 the odd
 * file becomes a symbolic link (unread) and `app/a.sql` loses its table. Run 2 must complete,
 * the odd file's tables stay live, and `app/a.sql` still sweeps unless the unread path has no
 * nameable ancestor (then the claim is empty: nothing is swept, the safe direction) or its
 * stem ends in an unwritable character (`a{b}.sql`, `star*.sql`: the same-stem protection is then
 * every file of that extension, `**` + `/*.sql`). `!top.sql` and `db/!lead.sql` are written exactly.
 */
const ODD_NAMES: ReadonlyArray<{ path: string; sweepsApp: boolean }> = [
  { path: '!top.sql', sweepsApp: true },
  { path: 'we,ird.sql', sweepsApp: false },
  { path: 'dir,x/b.sql', sweepsApp: false },
  { path: 'a{b}.sql', sweepsApp: false },
  { path: 'star*.sql', sweepsApp: false },
  { path: 'db/we,ird.sql', sweepsApp: true },
  { path: 'db/a{b}.sql', sweepsApp: false },
  { path: 'db/star*.sql', sweepsApp: false },
  { path: 'db/!lead.sql', sweepsApp: true },
  { path: 'db/ends?', sweepsApp: false },
];

for (const { path, sweepsApp } of ODD_NAMES) {
  test(`unread ${JSON.stringify(path)} does not lose the run, and its tables stay live`, async () => {
    // `ends?` is not a candidate name; give it the extension the reader looks for.
    const odd = path.endsWith('?') ? `${path}.sql` : path;
    await withFixture({ 'app/a.sql': A_SQL, [odd]: B_SQL }, async (fx) => {
      await fx.extract('run-1');
      assert.deepEqual(fx.deletedAt([...TABLE_A, ...TABLE_B]), all([...TABLE_A, ...TABLE_B], null));
      await write(fx.outside, 'real.sql', B_SQL);
      await rm(join(fx.root, odd));
      await symlink(join(fx.outside, 'real.sql'), join(fx.root, odd));
      await write(fx.root, 'app/a.sql', 'CREATE TABLE a2 (id bigint PRIMARY KEY);\n');
      const diagnostics = await fx.extract('run-2');
      assert.ok(diagnostics.some(reportsUnread));
      assert.deepEqual(fx.deletedAt(TABLE_B), all(TABLE_B, null), 'what the unread file declared');
      assert.deepEqual(
        fx.deletedAt(TABLE_A),
        all(TABLE_A, sweepsApp ? 'run-2' : null),
        sweepsApp ? 'a read file elsewhere still sweeps' : 'no nameable ancestor: nothing swept',
      );
    });
  });
}

test('the diagnostic names the stems whose files are protected from sweeping', async () => {
  await withFixture({ 'db/a.sql': A_SQL, 'db/b.sql': B_SQL }, async (fx) => {
    await fx.extract('run-1');
    await write(fx.outside, 'real.sql', B_SQL);
    await rm(join(fx.root, 'db', 'b.sql'));
    await symlink(join(fx.outside, 'real.sql'), join(fx.root, 'db', 'b.sql'));
    const diagnostics = await fx.extract('run-2');
    assert.ok(
      diagnostics.includes(
        'files sharing a stem with an unread candidate (b) are protected from sweeping, so a ' +
          'deletion of one is not recorded until a run that reads every candidate',
      ),
      JSON.stringify(diagnostics),
    );
  });
});

test('with too many unread paths the run claims nothing for data, completes, and says so', async () => {
  await withFixture({ 'db/a.sql': A_SQL, 'db/b.sql': B_SQL }, async (fx) => {
    await fx.extract('run-1');
    await write(fx.outside, 'real.sql', B_SQL);
    for (let i = 0; i < 120; i += 1) {
      await symlink(join(fx.outside, 'real.sql'), join(fx.root, 'db', `link${i}.sql`));
    }
    await rm(join(fx.root, 'db', 'a.sql'));
    const diagnostics = await fx.extract('run-2');
    assert.ok(
      diagnostics.some((d) => d.startsWith('the data scope claims nothing in this run')),
      JSON.stringify(diagnostics),
    );
    assert.deepEqual(
      fx.deletedAt(TABLE_A),
      all(TABLE_A, null),
      'nothing swept, even a deleted file',
    );
    assert.deepEqual(fx.deletedAt(TABLE_B), all(TABLE_B, null));
  });
});
