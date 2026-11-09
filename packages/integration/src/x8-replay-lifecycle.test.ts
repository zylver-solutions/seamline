/** Historical X8 proofs through real extraction and SQLite lifecycle operations. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { SqliteStore, applyProfile, parseExportProfile } from '@seamline/core';
import { runDetectors } from '@seamline/contradictions';
import { DATA_SCOPE, extractData } from '@seamline/extract-data';
import { nodeId } from '@seamline/ontology';

const CONFIG = 'project_id = "fixture"\n[db.migrations]\nenabled = true\nschema_paths = []\n';
const EARLY = 'ALTER TABLE public.accounts ADD COLUMN tag integer;';
const CREATE = 'CREATE TABLE public.accounts (id integer);';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'seamline-x8-life-'));
  const storeDir = await mkdtemp(join(tmpdir(), 'seamline-x8-store-'));
  const store = new SqliteStore({ path: join(storeDir, 'graph.db'), ontologyVersion: '1.0.0' });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); await rm(storeDir, { recursive: true, force: true }); });
  const directory = join(root, 'supabase/migrations');
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, 'supabase/config.toml'), CONFIG);
  const write = async (name: string, sql: string) => writeFile(join(directory, name), sql);
  const extract = async (runId: string, retry = false) => {
    const out = await extractData({ root, repo: 'replay-life', runId, deterministic: true });
    const run = { runId, repo: 'replay-life', commit: null, startedAt: '2026-01-01T00:00:00.000Z', ontologyVersion: '1.0.0' };
    if (retry) await store.restartRun(run); else await store.beginRun(run);
    await store.upsertNodes(runId, out.nodes);
    await store.upsertEdges(runId, DATA_SCOPE, out.edges);
    await store.finalizeRun(runId, [out.result]);
    return out;
  };
  const answer = () => {
    const result = runDetectors(store).detectors.find((entry) => entry.code === 'X8_ORPHANED_MIGRATION');
    assert.ok(result); return result;
  };
  await write('001_ref.sql', EARLY);
  await write('002_create.sql', CREATE);
  return { root, directory, store, write, extract, answer };
}

test('a historical positive becomes an examined fix and restores after deletion', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.extract('positive')).result.status, 'PASS');
  assert.equal(f.answer().outcome, 'fired');
  assert.equal(f.answer().findings.length, 1);
  const reference = nodeId('replay-life', 'Migration', '001_ref');
  const creation = nodeId('replay-life', 'Migration', '002_create');
  assert.equal(f.answer().findings[0]?.left, reference);
  assert.equal(f.answer().findings[0]?.right, creation);
  await f.write('001_ref.sql', CREATE);
  await f.write('002_create.sql', EARLY);
  assert.equal((await f.extract('fixed')).result.status, 'PASS');
  assert.equal(f.answer().outcome, 'clean');
  assert.equal(f.store.node(creation)?.props['validRefCount'], 1);
  await rm(join(f.directory, '002_create.sql'));
  await f.extract('deleted');
  assert.equal(f.store.node(creation), undefined, 'a PASS sweep must retire the removed migration');
  assert.equal(f.answer().outcome, 'clean');
  await f.write('001_ref.sql', EARLY);
  await f.write('002_create.sql', CREATE);
  await f.extract('restored');
  assert.equal(f.store.node(creation)?.deletedAt, null);
  assert.equal(f.answer().outcome, 'fired');
});

test('unsupported input withholds findings and preserves prior authoritative facts', async (t) => {
  const f = await fixture(t);
  await f.extract('positive');
  const id = nodeId('replay-life', 'Migration', '002_create');
  await f.write('001_ref.sql', 'DO $$ BEGIN EXECUTE unknown_source; END $$;');
  await rm(join(f.directory, '002_create.sql'));
  assert.equal((await f.extract('unsupported')).result.status, 'UNAVAILABLE');
  assert.equal(f.store.scopeStatus(DATA_SCOPE), 'UNAVAILABLE');
  assert.ok(f.store.node(id), 'an unavailable run cannot sweep the previous creation witness');
  assert.equal(f.answer().outcome, 'unknown');
  assert.equal(f.answer().findings.length, 0);
  await f.write('001_ref.sql', EARLY);
  await f.write('002_create.sql', CREATE);
  await f.extract('restored');
  assert.equal(f.answer().outcome, 'fired');
});

test('a same-run retry cannot mix a stale witness with the current inventory', async (t) => {
  const f = await fixture(t);
  await f.extract('repeat');
  assert.equal(f.answer().outcome, 'fired');
  await rm(join(f.directory, '002_create.sql'));
  await f.extract('repeat', true);
  assert.equal(f.store.node(nodeId('replay-life', 'Migration', '002_create')), undefined);
  assert.equal(f.answer().outcome, 'clean');
  assert.equal(f.store.node(nodeId('replay-life', 'Migration', '001_ref'))?.props['externalRefCount'], 1);
  await f.write('002_create.sql', CREATE);
  await f.extract('repeat', true);
  assert.equal(f.answer().outcome, 'fired');
});

test('project recognition changes recompute authority without changing natural migration names', async (t) => {
  const f = await fixture(t);
  await f.extract('original');
  assert.equal(f.answer().outcome, 'fired');
  const old = f.store.node(nodeId('replay-life', 'Migration', '001_ref'));
  assert.ok(old);
  await rename(join(f.root, 'supabase'), join(f.root, 'renamed'));
  const out = await f.extract('moved');
  assert.equal(out.result.status, 'PASS', 'generic migrations retain their legacy extraction status');
  assert.equal(f.answer().outcome, 'unknown', 'generic ordering cannot certify the historical negative');
  const moved = f.store.node(old.id);
  assert.ok(moved);
  assert.equal(moved.props['replayOrderPolicy'], 'unknown');
  assert.notEqual(moved.props['replaySnapshotHash'], old.props['replaySnapshotHash']);
});

test('repeated extraction emits byte-identical node and edge bodies', async (t) => {
  const f = await fixture(t);
  const args = { root: f.root, repo: 'replay-life', runId: 'bytes', deterministic: true };
  const a = await extractData(args), b = await extractData(args);
  assert.equal(a.result.status, 'PASS');
  assert.equal(b.result.status, 'PASS');
  assert.equal(JSON.stringify(a.nodes), JSON.stringify(b.nodes));
  assert.equal(JSON.stringify(a.edges), JSON.stringify(b.edges));
});

test('different replay groups cannot lend a creation witness to each other', async (t) => {
  const f = await fixture(t);
  await rm(join(f.directory, '002_create.sql'));
  const other = join(f.root, 'other/supabase');
  await mkdir(join(other, 'migrations'), { recursive: true });
  await writeFile(join(other, 'config.toml'), CONFIG);
  await writeFile(join(other, 'migrations/002_create.sql'), CREATE);
  assert.equal((await f.extract('disjoint')).result.status, 'PASS');
  assert.equal(f.answer().outcome, 'clean');
  assert.equal(f.store.node(nodeId('replay-life', 'Migration', '001_ref'))?.props['externalRefCount'], 1);
  await f.write('002_create.sql', CREATE);
  assert.equal((await f.extract('local-witness')).result.status, 'PASS');
  const answer = f.answer();
  assert.equal(answer.outcome, 'fired');
  assert.equal(answer.findings.length, 1);
  const witness = f.store.node(answer.findings[0]!.right);
  assert.ok(witness);
  assert.equal(witness.props['replayGroup'], 'supabase/migrations');
  assert.equal(f.store.node(nodeId('replay-life', 'Migration', '002_create')), undefined, 'identity collision qualification retires the old bare identity');
});

test('an interrupted store write cannot combine a current reference with an old snapshot witness', async (t) => {
  const f = await fixture(t);
  await f.extract('before');
  assert.equal(f.answer().outcome, 'fired');
  await f.write('002_create.sql', 'CREATE TABLE public.accounts (id integer, changed integer);');
  const out = await extractData({ root: f.root, repo: 'replay-life', runId: 'partial', deterministic: true });
  assert.equal(out.result.status, 'PASS');
  await f.store.beginRun({ runId: 'partial', repo: 'replay-life', commit: null, startedAt: '2026-01-02T00:00:00.000Z', ontologyVersion: '1.0.0' });
  await f.store.upsertNodes('partial', out.nodes.filter((node) => node.kind === 'DataSource' || (node.kind === 'Migration' && node.name === '001_ref')));
  assert.equal(f.store.scopeStatus(DATA_SCOPE), 'PASS', 'the old finished scope is still PASS, so the certificate must stop this mixture');
  assert.equal(f.answer().outcome, 'unknown');
  assert.equal(f.answer().findings.length, 0);
  await f.store.upsertNodes('partial', out.nodes);
  await f.store.upsertEdges('partial', DATA_SCOPE, out.edges);
  await f.store.finalizeRun('partial', [out.result]);
  assert.equal(f.answer().outcome, 'fired');
});

test('replay schema identifiers cannot travel through an internal-only history profile', async (t) => {
  const f = await fixture(t);
  const out = await f.extract('classified');
  assert.equal(out.result.status, 'PASS');
  assert.equal(out.nodes.filter((node) => node.kind === 'Migration').length, 2);
  assert.ok(out.nodes.filter((node) => node.kind === 'Migration').every((node) => node.sensitivity === 'confidential'));
  const fields = {
    version: 1, name: 'history-only', description: 'fixture',
    allowEdges: [], allowProps: { Migration: '*' }, allowEdgeProps: {},
    allowFields: ['id', 'kind', 'props', 'untrusted'], allowProvenance: ['EXTRACTED'], includeUntrusted: true,
  };
  const internal = parseExportProfile({ ...fields, allow: [['Migration', 'internal']] });
  const denied = applyProfile(out.nodes, out.edges, internal);
  assert.equal(denied.nodes.length, 0);
  assert.equal(denied.edges.length, 0);
  assert.ok(!JSON.stringify(denied.nodes).includes('accounts'));
  const confidential = parseExportProfile({ ...fields, allow: [['Migration', 'confidential']] });
  const released = applyProfile(out.nodes, out.edges, confidential);
  assert.equal(released.nodes.length, 2, 'the positive control explicitly admits the data-bearing history facts');
  assert.ok(JSON.stringify(released.nodes).includes('accounts'));
});

test('an input-only stamp cannot validate an older analysis under the same epoch', async (t) => {
  const f = await fixture(t);
  await f.write('001_ref.sql', CREATE);
  await f.write('002_create.sql', EARLY);
  await f.extract('previous');
  assert.equal(f.answer().outcome, 'clean');
  const runId = 'same-epoch';
  const out = await extractData({ root: f.root, repo: 'replay-life', runId, deterministic: true });
  assert.equal(out.result.status, 'PASS');
  const source = out.nodes.find((node) => node.kind === 'DataSource');
  const reference = out.nodes.find((node) => node.kind === 'Migration' && node.name === '002_create');
  assert.ok(source && reference);
  const groups: unknown = JSON.parse(String(source.props['replayGroups']));
  // An input-only digest cannot distinguish different interpretations of the
  // same bytes. Simulate a stale positive from an older reference-state analysis.
  const inputOnlyStamp = createHash('sha256').update(JSON.stringify([
    1, source.props['defaultSchema'], source.props['dialect'], [], groups, false,
  ])).digest('hex');
  const stale = {
    ...reference,
    props: {
      ...reference.props, replaySnapshotHash: inputOnlyStamp,
      validRefs: '[]', validRefCount: 0,
      unresolvedRefs: JSON.stringify([['public', 'accounts', null, 0, 1, '001_ref', 0, 1]]),
      unresolvedRefCount: 1,
    },
  };
  await f.store.beginRun({ runId, repo: 'replay-life', commit: null, startedAt: '2026-01-02T00:00:00.000Z', ontologyVersion: '1.0.0' });
  await f.store.upsertNodes(runId, out.nodes.map((node) => node.id === reference.id ? stale : node));
  assert.equal(f.store.scopeStatus(DATA_SCOPE), 'PASS');
  assert.equal(f.answer().outcome, 'unknown');
  assert.equal(f.answer().findings.length, 0);
  await f.store.upsertNodes(runId, [reference]);
  await f.store.upsertEdges(runId, DATA_SCOPE, out.edges);
  await f.store.finalizeRun(runId, [out.result]);
  assert.equal(f.answer().outcome, 'clean');
});
