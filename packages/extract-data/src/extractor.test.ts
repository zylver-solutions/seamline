import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { EDGE_SIGNATURES, isValidEdge, type NodeKind, parseNodeId } from '@seamline/ontology';
import { canonicalSif } from './emit.ts';
import { extractData, MANIFEST, DATA_SCOPE, type ExtractDataOutput } from './extractor.ts';

const SQL_BASIC = fileURLToPath(new URL('./__fixtures__/sql-basic/', import.meta.url));
const NO_SCHEMA = fileURLToPath(new URL('./__fixtures__/no-schema/', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('./__fixtures__/sql-migrations/', import.meta.url));
const DRIZZLE = fileURLToPath(new URL('./__fixtures__/drizzle-parity/', import.meta.url));
const PRISMA = fileURLToPath(new URL('./__fixtures__/prisma-parity/', import.meta.url));

const ALL_FIXTURES = [SQL_BASIC, MIGRATIONS, DRIZZLE, PRISMA];

function run(root: string, runId = 'run-1'): Promise<ExtractDataOutput> {
  return extractData({ root, repo: 'demo', runId, deterministic: true });
}

test('a SQL nesting limit fails the data scope even when another schema source is readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seamline-ddl-nesting-'));
  try {
    await writeFile(join(root, 'a.sql'), 'CREATE TABLE readable (id int);');
    const nested = '('.repeat(256) + '1' + ')'.repeat(256);
    await writeFile(join(root, 'b.sql'), `CREATE TABLE unread (id int DEFAULT ${nested});`);
    const out = await run(root);
    assert.equal(out.result.status, 'FAIL');
    assert.ok(out.nodes.some((n) => n.kind === 'Table' && n.name === 'readable'));
    assert.ok(!out.nodes.some((n) => n.kind === 'Table' && n.name === 'unread'));
    assert.ok(out.result.diagnostics.some((d) => d.includes('SQL nesting limit exceeded (256)')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the manifest declares an EXTRACTED ceiling and no network', () => {
  assert.equal(MANIFEST.provenanceCeiling, 'EXTRACTED');
  assert.equal(MANIFEST.net, false);
  assert.equal(MANIFEST.name, 'extract-data');
  assert.deepEqual(
    MANIFEST.produces.map((p) => p.scope),
    [DATA_SCOPE],
  );
  assert.deepEqual([...(MANIFEST.produces[0]?.kinds ?? [])].sort(), [
    'Column',
    'DataSource',
    'Migration',
    'Schema',
    'Table',
  ]);
});

test('a repository with no schema source reports UNAVAILABLE, not an empty PASS', async () => {
  const out = await run(NO_SCHEMA);
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.result.nodeCount, 0);
  assert.equal(out.result.edgeCount, 0);
  assert.ok(
    out.result.diagnostics.some((d) => d.includes('no schema source found')),
    'the reason must be reportable, not silent',
  );
});

test('sources that parse but declare no table also report UNAVAILABLE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seamline-extract-data-'));
  try {
    await writeFile(join(dir, 'seed.sql'), "INSERT INTO nothing VALUES (1);\nGRANT SELECT ON x TO y;\n", 'utf8');
    const out = await run(dir);
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(out.result.nodeCount, 0);
    assert.ok(out.result.diagnostics.some((d) => d.includes('declared no tables')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('diagnostics never embed the maintainer-machine absolute root path, even under malformed input', async () => {
  // seamline-7tu: extractor.ts:124 (discover() failure) and :153 (parse
  // failure) both report `String(err)`, the same shape as the confirmed H13
  // leak fixed in extract-contracts. Unlike that leak, discover() catches
  // every fs error internally (readdir/stat/readFile) rather than
  // propagating it, and applyFile's parsers only ever see `file.path`
  // (repo-relative) and `file.text` -- never `file.absolute` -- so there is
  // no code path through which the absolute root could reach a diagnostic.
  // This is a structural guard against that changing silently: `dir` below
  // is itself an absolute path (mkdtemp under os.tmpdir()), so any future
  // change that threads it into a parser or lets discover() propagate a raw
  // fs error will fail this test immediately.
  const dir = await mkdtemp(join(tmpdir(), 'seamline-extract-data-'));
  try {
    await mkdir(join(dir, 'schema'), { recursive: true });
    await mkdir(join(dir, 'migrations'), { recursive: true });
    await mkdir(join(dir, 'prisma'), { recursive: true });
    await writeFile(join(dir, 'schema', 'schema.ts'), `import { pgTable } from 'drizzle-orm/pg-core';\nexport const x = pgTable(${'{'.repeat(200)}`, 'utf8');
    await writeFile(join(dir, 'migrations', '0001_bad.sql'), 'CREATE TABLE ((( not valid sql ][;;;', 'utf8');
    await writeFile(join(dir, 'migrations', '0001_dup.sql'), 'CREATE TABLE also_not_valid (', 'utf8');
    await writeFile(join(dir, 'prisma', 'schema.prisma'), 'model \x00\x01Broken {{{{ not valid', 'utf8');

    const out = await run(dir);
    const serialized = JSON.stringify(out.result.diagnostics) + canonicalSif(out.nodes, out.edges);
    assert.ok(!serialized.includes(dir), `diagnostics or SIF output embedded the absolute root ${dir}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every fixture that finds schema reports PASS with a non-zero node count', async () => {
  for (const root of ALL_FIXTURES) {
    const out = await run(root);
    assert.equal(out.result.status, 'PASS', root);
    assert.ok(out.result.nodeCount > 0, root);
    assert.equal(out.result.nodeCount, out.nodes.length);
    assert.equal(out.result.edgeCount, out.edges.length);
  }
});

test('two runs over the same tree are byte-identical', async () => {
  for (const root of ALL_FIXTURES) {
    const first = await run(root);
    const second = await run(root);
    assert.equal(canonicalSif(second.nodes, second.edges), canonicalSif(first.nodes, first.edges), root);
    assert.deepEqual(second.result, first.result, root);
  }
});

test('every emitted edge satisfies its declared domain and range', async () => {
  let checked = 0;
  for (const root of ALL_FIXTURES) {
    const out = await run(root);
    const kindById = new Map<string, NodeKind>(out.nodes.map((n) => [n.id as string, n.kind]));
    for (const edge of out.edges) {
      const src = kindById.get(edge.src as string);
      const dst = kindById.get(edge.dst as string);
      assert.ok(src !== undefined, `dangling edge source ${edge.src}`);
      assert.ok(dst !== undefined, `dangling edge target ${edge.dst}`);
      assert.ok(isValidEdge(edge.kind, src, dst), `${edge.kind} ${src} -> ${dst} is outside its signature`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, 'the assertion must actually have run over edges');
});

test('only the three declared edge kinds are emitted', async () => {
  const kinds = new Set<string>();
  for (const root of ALL_FIXTURES) {
    for (const e of (await run(root)).edges) kinds.add(e.kind);
  }
  assert.deepEqual([...kinds].sort(), ['CONTAINS', 'FK_TO', 'MIGRATED_BY']);
  for (const kind of kinds) {
    assert.ok(Object.hasOwn(EDGE_SIGNATURES, kind));
  }
});

test('identity is path-free and output carries only repo-relative POSIX paths', async () => {
  for (const root of ALL_FIXTURES) {
    const out = await run(root);
    for (const n of out.nodes) {
      const parsed = parseNodeId(n.id);
      assert.equal(parsed.repo, 'demo');
      assert.ok(!parsed.canonicalName.includes('/'), `${n.id} embeds a path segment`);
      assert.ok(!parsed.canonicalName.includes('\\'), `${n.id} embeds a Windows path segment`);
      for (const ext of ['.sql', '.prisma', '.ts', '.js']) {
        assert.ok(!parsed.canonicalName.endsWith(ext), `${n.id} embeds a file name`);
      }
      if (n.path !== undefined) {
        assert.ok(!n.path.startsWith('/'), `${n.path} is absolute`);
        assert.ok(!n.path.includes('\\'), `${n.path} is not POSIX`);
        assert.ok(!n.path.includes(root), `${n.path} leaks the absolute root`);
      }
    }
    for (const e of out.edges) {
      for (const f of [e.srcFile, e.dstFile]) {
        if (f === undefined) continue;
        assert.ok(!f.startsWith('/') && !f.includes('\\'), f);
      }
    }
  }
});

test('node ids survive a rename of the file that declares them', async () => {
  const original = await run(SQL_BASIC);
  const dir = await mkdtemp(join(tmpdir(), 'seamline-extract-data-'));
  try {
    // The §2.1 conformance gate, in miniature: same content, different path.
    await mkdir(join(dir, 'sql', 'nested'), { recursive: true });
    const source = await readFile(join(SQL_BASIC, 'db', 'schema.sql'), 'utf8');
    await writeFile(join(dir, 'sql', 'nested', 'main-schema.sql'), source, 'utf8');
    const moved = await run(dir);

    assert.deepEqual(
      moved.nodes.map((n) => n.id),
      original.nodes.map((n) => n.id),
    );
    assert.deepEqual(
      moved.edges.map((e) => `${e.kind} ${e.src} ${e.dst}`),
      original.edges.map((e) => `${e.kind} ${e.src} ${e.dst}`),
    );
    // The path is a property, and it did move.
    assert.notEqual(moved.nodes[1]?.path, original.nodes[1]?.path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every node is EXTRACTED with full confidence and a defaulted sensitivity', async () => {
  const out = await run(SQL_BASIC);
  for (const n of out.nodes) {
    assert.equal(n.provenance, 'EXTRACTED');
    assert.equal(n.confidence, 1);
    assert.equal(n.deletedAt, null);
    assert.equal(n.firstSeenRun, 'run-1');
    assert.equal(n.lastSeenRun, 'run-1');
    if (n.kind === 'Column' || n.kind === 'Table' || n.kind === 'Schema' || n.kind === 'DataSource') {
      assert.equal(n.sensitivity, 'confidential');
    }
  }
  for (const e of out.edges) {
    assert.equal(e.provenance, 'EXTRACTED');
    assert.equal(e.deletedAt, null);
  }
});

test('a PII label is inference carried on an extracted node, never asserted as fact', async () => {
  const out = await run(SQL_BASIC);
  const email = out.nodes.find((n) => n.id === 'demo:Column:app.users.email');
  assert.ok(email !== undefined);
  assert.equal(email.provenance, 'EXTRACTED');
  assert.equal(email.props['pii'], 'email');
  assert.equal(email.props['piiProvenance'], 'INFERRED');
  assert.ok((email.props['piiConfidence'] as number) < 1);

  const nonPii = out.nodes.find((n) => n.id === 'demo:Column:app.users.is_active');
  assert.equal(nonPii?.props['pii'], 'none');
  assert.equal(nonPii?.props['piiConfidence'], 0);
});

test('no wall-clock value appears in any node or edge body', async () => {
  const out = await run(MIGRATIONS);
  const serialized = canonicalSif(out.nodes, out.edges);
  assert.ok(!/"(createdAt|updatedAt|extractedAt|timestamp)":/u.test(serialized));
  // A run id is the only time-like handle, and it comes from the caller.
  assert.ok(serialized.includes('"firstSeenRun":"run-1"'));
});

test('a differing runId changes only the run stamps, not identity', async () => {
  const a = await run(SQL_BASIC, 'run-a');
  const b = await run(SQL_BASIC, 'run-b');
  assert.deepEqual(
    b.nodes.map((n) => n.id),
    a.nodes.map((n) => n.id),
  );
  assert.equal(canonicalSif(a.nodes, a.edges).replaceAll('run-a', 'X'), canonicalSif(b.nodes, b.edges).replaceAll('run-b', 'X'));
});

test('a repo name containing a colon is rejected rather than silently corrupting ids', async () => {
  await assert.rejects(() => extractData({ root: SQL_BASIC, repo: 'bad:name', runId: 'r', deterministic: true }));
});

test('with no datasource configured, Schema/Table/Column ids stay 3-part', async () => {
  const out = await run(SQL_BASIC);
  const ids = out.nodes.map((n) => parseNodeId(n.id).canonicalName);
  assert.ok(ids.includes('app'), ids.join(','));
  assert.ok(ids.includes('app.users'), ids.join(','));
  assert.ok(ids.includes('app.users.email'), ids.join(','));
});

test('a configured datasource qualifies Schema/Table/Column identity (v3 §2.1), so two datasources sharing a schema name do not collide', async () => {
  const out = await extractData({
    root: SQL_BASIC,
    repo: 'demo',
    runId: 'run-1',
    deterministic: true,
    dataSource: 'primary',
  });
  const ids = out.nodes.map((n) => parseNodeId(n.id).canonicalName);
  assert.ok(ids.includes('primary.app'), ids.join(','));
  assert.ok(ids.includes('primary.app.users'), ids.join(','));
  assert.ok(ids.includes('primary.app.users.email'), ids.join(','));
  // Not both: the unqualified form must not also be present.
  assert.ok(!ids.includes('app.users.email'), ids.join(','));
});
