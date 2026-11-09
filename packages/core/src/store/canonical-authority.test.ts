import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import fc from 'fast-check';
import { edgeKey, nodeId, parseNodeId, type AuthoritativeScope, type SeamlineNode } from '@seamline/ontology';
import { EMPTY_STATE, type MergeBatch } from '../merge/state.ts';
import { applyRestartedRun, applyRun } from '../merge/tombstone.ts';
import { encodeCanonicalSelector } from './canonical-selector.ts';
import { claimCoversEdge, claimCoversNode } from './scope-selector.ts';
import { currentObservationOf } from './current-observation.ts';
import { canonicalIdKindFromBytes } from './canonical-authority.ts';
import { SqliteStore } from './sqlite-store.ts';
import { extractorResult, makeEdge, makeNode, runRecord, scope } from './testing.ts';

const source = 'src/a,*?!.ts';
const canonicalClaim = (kind: 'Contract' | 'SchemaProperty', root: string): AuthoritativeScope => scope('contracts', [kind],
  encodeCanonicalSelector({ path: source, rules: kind === 'Contract' ? [['exact', root]] : [['prefix', `${root}#/`]] }));

const batch = (runId: string, nodes: readonly SeamlineNode[], authoritative: readonly AuthoritativeScope[]): MergeBatch => ({
  runId, repo: 'app', extractor: 'contracts', extractorPriority: 10, status: 'PASS', scope: 'contracts',
  authoritative, nodes, edges: [],
});

test('SQLite identity byte decoding preserves BOMs and refuses malformed UTF-8 and NUL ids', () => {
  const bytes = (value: string): Uint8Array => Buffer.from(value, 'utf8');
  assert.equal(canonicalIdKindFromBytes(bytes('app:Contract:A'), bytes('app')), 'Contract');
  assert.equal(canonicalIdKindFromBytes(bytes('app:Contract:A\u0000tail'), bytes('app')), null);
  assert.equal(canonicalIdKindFromBytes(bytes('app:Contract:A'), bytes('app\u0000tail')), null);
  assert.equal(canonicalIdKindFromBytes(bytes('\ufeffapp:Contract:A'), bytes('app')), null, 'BOM must remain a literal repository character');
  assert.equal(canonicalIdKindFromBytes(bytes('\ufeffapp:Contract:A'), bytes('\ufeffapp')), 'Contract');
  assert.equal(canonicalIdKindFromBytes(new Uint8Array([0xff]), bytes('app')), null);
  assert.equal(canonicalIdKindFromBytes('app:Contract:A', 'app'), null, 'TEXT callbacks cannot bypass the byte bridge');
});

test('SQLite canonical sweeps reject complete NUL-containing identities on the Node floor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seamline-canonical-nul-'));
  const path = join(dir, 'graph.sqlite');
  const store = new SqliteStore({ path });
  const raw = new DatabaseSync(path);
  try {
    const root = makeNode({ kind: 'Contract', name: 'A', path: source });
    const valid = makeNode({ kind: 'SchemaProperty', name: 'A#/valid', path: source });
    const invalid = makeNode({ kind: 'SchemaProperty', name: 'A#/invalid\u0000tail', path: source });
    const badDestination = makeEdge({ kind: 'CONTAINS', src: root.id, dst: invalid.id });
    const badSource = makeEdge({ kind: 'CONTAINS', src: nodeId('app', 'Contract', 'A\u0000tail'), dst: valid.id });
    await store.beginRun(runRecord('r1'));
    await store.upsertNodes('r1', [root, valid, invalid]);
    await store.upsertEdges('r1', 'contracts', [badDestination, badSource]);
    await store.finalizeRun('r1', []);
    await store.beginRun(runRecord('r2'));
    await store.finalizeRun('r2', [extractorResult('contracts', 'PASS', [canonicalClaim('SchemaProperty', 'A')])]);
    assert.equal(raw.prepare('SELECT deleted_at FROM nodes WHERE id = :id').get({ id: valid.id })?.['deleted_at'], 'r2');
    assert.equal(raw.prepare('SELECT deleted_at FROM nodes WHERE id = :id').get({ id: invalid.id })?.['deleted_at'], null);
    assert.deepEqual(raw.prepare('SELECT deleted_at FROM edges').all().map(row => row['deleted_at']), [null, null]);
  } finally { raw.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('canonical node claims use the id, literal path, repository and kind, with no context fallback', () => {
  const auth = canonicalClaim('Contract', 'A');
  const good = { ...makeNode({ kind: 'Contract', name: 'A', path: source }), name: 'unrelated display' };
  assert.equal(claimCoversNode(auth, good, { repo: 'app' }), true);
  assert.equal(claimCoversNode(auth, good), false);
  for (const bad of [
    { ...good, id: nodeId('foreign', 'Contract', 'A') },
    { ...good, id: nodeId('app', 'SchemaProperty', 'A') },
    { ...good, id: nodeId('app', 'Contract', 'AB') },
    { ...good, id: nodeId('app', 'Contract', `${source}`) },
    { ...good, id: nodeId('app', 'Contract', 'A#/child') },
    { ...good, path: 'src/other.ts' }, { ...good, path: undefined },
    { ...good, id: undefined }, { ...good, id: 'malformed' },
    { ...good, id: 'app:Contract:' }, { ...good, id: 'app:Contract:A\ud800' },
  ]) assert.equal(claimCoversNode(auth, bad, { repo: 'app' }), false);
  const mutable = { ...auth };
  assert.equal(claimCoversNode(mutable, good, { repo: 'app' }), true);
  mutable.selector = canonicalClaim('Contract', 'B').selector as string;
  assert.equal(claimCoversNode(mutable, good, { repo: 'app' }), false, 'cached compilation cannot outlive changed metadata');
});

test('canonical edges require their scope and both repos, then their selected stored anchor', () => {
  const root = makeNode({ kind: 'Contract', name: 'A', path: source });
  const field = makeNode({ kind: 'SchemaProperty', name: 'A#/x', path: source });
  const auth = canonicalClaim('SchemaProperty', 'A');
  const edge = makeEdge({ kind: 'CONTAINS', src: root.id, dst: field.id, srcFile: 'wrong.ts' });
  const context = { repo: 'app', node: (id: string) => id === field.id ? { ...field, deletedAt: 'older' } : root };
  assert.equal(claimCoversEdge(auth, 'contracts', edge, context), true, 'destination anchors when source kind is not claimed; retired node records still count');
  assert.equal(claimCoversEdge(auth, 'other', edge, context), false);
  assert.equal(claimCoversEdge(auth, 'contracts', edge), false);
  assert.equal(claimCoversEdge(auth, 'contracts', edge, { repo: 'app', node: () => undefined }), false);
  assert.equal(claimCoversEdge(auth, 'contracts', edge, { repo: 'app', node: () => ({ ...field, kind: 'Contract' }) }), false);
  assert.equal(claimCoversEdge(auth, 'contracts', { ...edge, src: nodeId('foreign', 'Contract', 'A') }, context), false);
  const sourceClaimed = { ...auth, kinds: ['Contract', 'SchemaProperty'] as const };
  assert.equal(claimCoversEdge(sourceClaimed, 'contracts', edge, { repo: 'app', node: id => id === field.id ? field : undefined }), false,
    'a missing claimed source cannot fall through to the destination');
});

test('actual SQLite and memory sweeps preserve opaque and foreign facts on a same-id retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seamline-canonical-authority-'));
  const path = join(dir, 'graph.sqlite');
  const store = new SqliteStore({ path });
  try {
    const a = makeNode({ kind: 'Contract', name: 'A', path: source });
    const oldA = makeNode({ kind: 'SchemaProperty', name: 'A#/gone', path: source });
    const b = makeNode({ kind: 'Contract', name: 'B', path: source });
    const oldB = makeNode({ kind: 'SchemaProperty', name: 'B#/kept', path: source });
    const foreign = makeNode({ kind: 'SchemaProperty', name: 'A#/foreign', path: source, repo: 'other' });
    const nodes = [a, oldA, b, oldB, foreign];
    const aEdge = makeEdge({ kind: 'CONTAINS', src: a.id, dst: oldA.id });
    const bEdge = makeEdge({ kind: 'CONTAINS', src: b.id, dst: oldB.id });
    const foreignEdge = makeEdge({ kind: 'CONTAINS', src: a.id, dst: foreign.id });
    const initial = { ...batch('r1', nodes, []), edges: [aEdge, bEdge, foreignEdge] };
    const prior = applyRun(EMPTY_STATE, [initial]).state;
    await store.beginRun(runRecord('r1'));
    await store.upsertNodes('r1', nodes);
    await store.upsertEdges('r1', 'contracts', initial.edges);
    await store.upsertEdges('r1', 'foreign-scope', [aEdge]);
    await store.finalizeRun('r1', [extractorResult('contracts', 'PASS', [scope('contracts', ['Contract', 'SchemaProperty'])])]);
    await store.restartRun(runRecord('r1'));
    await store.upsertNodes('r1', [a]);
    const claims = [canonicalClaim('Contract', 'A'), canonicalClaim('SchemaProperty', 'A')];
    await store.finalizeRun('r1', [extractorResult('contracts', 'PASS', claims)]);
    const memory = applyRestartedRun(prior, 'r1', [batch('r1', [a], claims)]);
    assert.deepEqual(memory.nodes, [oldA.id]);
    assert.equal(memory.edges.length, 1);
    assert.equal(memory.state.nodes.get(b.id)?.node.deletedAt, null);
    const current = currentObservationOf(await store.getRun('r1'));
    assert.ok(store.node(a.id));
    assert.ok(store.node(b.id));
    assert.equal(current('contracts', store.node(a.id)), true);
    assert.equal(current('contracts', store.node(b.id)), false, 'same-id retained stamp alone never certifies opaque B');
    assert.equal(store.node(oldA.id), undefined);
    assert.ok(store.node(oldB.id));
    const raw = new DatabaseSync(path);
    try {
      assert.deepEqual(raw.prepare('SELECT id FROM nodes WHERE deleted_at IS NOT NULL ORDER BY id').all().map(row => row['id']), [oldA.id]);
      assert.deepEqual(raw.prepare('SELECT scope, src_id, dst_id FROM edges WHERE deleted_at IS NOT NULL').all().map(row => ({ ...row })),
        [{ scope: 'contracts', src_id: a.id, dst_id: oldA.id }]);
    } finally { raw.close(); }
    await store.close();
    const reopened = new SqliteStore({ path });
    try {
      assert.deepEqual((await reopened.getRun('r1'))?.results[0]?.authoritative, claims);
      assert.equal(currentObservationOf(await reopened.getRun('r1'))('contracts', reopened.node(b.id)), false);
      await reopened.beginRun(runRecord('r2'));
      await reopened.finalizeRun('r2', [extractorResult('contracts', 'PASS', [scope('contracts', ['Contract', 'SchemaProperty'], 'src/**')])]);
      assert.equal(reopened.node(b.id), undefined, 'an ordinary complete path claim still forgets the missing file');
      assert.ok(reopened.node(foreign.id), 'foreign-repository nodes remain untouched');
    } finally { await reopened.close(); }
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('literal exact and prefix SQL sweeps agree with an independent oracle and memory on generated Unicode names', async () => {
  const token = fc.array(fc.constantFrom('a', 'b', '#', '/', ':', ',', '*', '?', '[', ']', 'é', 'e\u0301', '🔒'), { minLength: 1, maxLength: 8 }).map(parts => parts.join(''));
  await fc.assert(fc.asyncProperty(token, fc.boolean(), async (root, prefix) => {
    const dir = mkdtempSync(join(tmpdir(), 'seamline-canonical-generated-'));
    const path = join(dir, 'graph.sqlite');
    const store = new SqliteStore({ path });
    try {
      const names = [...new Set([root, `${root}#/field`, `${root}x#/field`, `${root}#`, 'unrelated'])];
      const nodes = names.map(name => ({ ...makeNode({ kind: 'SchemaProperty', name, path: source }), name: 'irrelevant display' }));
      nodes.push(makeNode({ kind: 'SchemaProperty', name: root, path: source, repo: 'foreign' }));
      nodes.push(makeNode({ kind: 'SchemaProperty', name: `${root}#/wrong-path`, path: 'other.ts' }));
      nodes.push({ ...makeNode({ kind: 'Contract', name: root, path: source }), id: nodeId('app', 'Contract', `${root}#/wrong-kind`) });
      nodes.push({ ...makeNode({ kind: 'SchemaProperty', name: `${root}#/id-kind-wrong`, path: source }), id: nodeId('app', 'Contract', `${root}#/id-kind-wrong`) });
      nodes.push({ ...makeNode({ kind: 'Contract', name: `${root}#/stored-kind-wrong`, path: source }), id: nodeId('app', 'SchemaProperty', `${root}#/stored-kind-wrong`) });
      nodes.push({ ...makeNode({ kind: 'SchemaProperty', name: `${root}#/equal-length-kind`, path: source }), id: nodeId('app', 'DomainProperty', `${root}#/equal-length-kind`) });
      nodes.push(makeNode({ kind: 'SchemaProperty', name: `${root}#/bad\u0000`, path: source }));
      const parent = makeNode({ kind: 'Contract', name: `${root}-parent`, path: source });
      const edges = nodes.filter(node => node.id.includes(':SchemaProperty:')).map(node => makeEdge({ kind: 'CONTAINS', src: parent.id, dst: node.id }));
      nodes.push(parent);
      const literal = prefix ? `${root}#/` : root;
      const auth = scope('contracts', ['SchemaProperty'], encodeCanonicalSelector({ path: source, rules: [[prefix ? 'prefix' : 'exact', literal]] }));
      const expected = names.filter(name => prefix ? name.startsWith(literal) : name === literal).map(name => nodeId('app', 'SchemaProperty', name)).sort();
      assert.ok(expected[0]);
      edges.push(makeEdge({ kind: 'CONTAINS', src: nodeId('foreign', 'Contract', `${root}-parent`), dst: expected[0] }));
      edges.push(makeEdge({ kind: 'CONTAINS', src: nodeId('app', 'Contract', `${root}-bad\u0000`), dst: expected[0] }));
      await store.beginRun(runRecord('r1'));
      // The public writer correctly refuses inconsistent ids. Seed valid facts,
      // then deliberately corrupt persisted kind metadata to test the sweep's
      // independent defense, with the same malformed facts in the memory oracle.
      await store.upsertNodes('r1', nodes.map(node => ({ ...node, kind: parseNodeId(node.id).kind })));
      const fixture = new DatabaseSync(path);
      try {
        for (const node of nodes) if (node.kind !== parseNodeId(node.id).kind)
          fixture.prepare('UPDATE nodes SET kind = :kind WHERE id = :id').run({ kind: node.kind, id: node.id });
      } finally { fixture.close(); }
      await store.upsertEdges('r1', 'contracts', edges);
      const ownedEdge = edges.find(edge => edge.dst === expected[0]);
      assert.ok(ownedEdge);
      await store.upsertEdges('r1', 'foreign-scope', [ownedEdge]);
      await store.finalizeRun('r1', []);
      await store.beginRun(runRecord('r2'));
      await store.finalizeRun('r2', [extractorResult('contracts', 'PASS', [auth])]);
      const prior = applyRun(EMPTY_STATE, [
        { ...batch('r1', nodes, []), edges },
        { ...batch('r1', [], []), scope: 'foreign-scope', edges: [ownedEdge] },
      ]).state;
      const memory = applyRun(prior, [batch('r2', [], [auth])]);
      assert.deepEqual(memory.nodes, expected);
      assert.deepEqual(memory.edges, expected.map(dst => edgeKey('contracts', { kind: 'CONTAINS', src: parent.id, dst })).sort());
      const raw = new DatabaseSync(path);
      try {
        assert.deepEqual(raw.prepare('SELECT id FROM nodes WHERE deleted_at IS NOT NULL ORDER BY id').all().map(row => row['id']), expected);
        assert.deepEqual(raw.prepare('SELECT dst_id FROM edges WHERE deleted_at IS NOT NULL ORDER BY dst_id').all().map(row => row['dst_id']), expected);
        assert.equal(raw.prepare("SELECT deleted_at FROM edges WHERE scope = 'foreign-scope'").get()?.['deleted_at'], null);
      } finally { raw.close(); }
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  }), { numRuns: 100, seed: 180018 });
});

test('SQLite canonical edge deletion accepts retired anchors and never falls through a missing claimed source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seamline-canonical-anchor-'));
  const path = join(dir, 'graph.sqlite');
  const store = new SqliteStore({ path });
  const raw = new DatabaseSync(path);
  try {
    const root = makeNode({ kind: 'Contract', name: 'A', path: source });
    const retired = makeNode({ kind: 'SchemaProperty', name: 'A#/retired', path: source });
    const field = makeNode({ kind: 'SchemaProperty', name: 'A#/field', path: source });
    const oldEdge = makeEdge({ kind: 'CONTAINS', src: root.id, dst: retired.id });
    const missingSourceEdge = makeEdge({ kind: 'CONTAINS', src: nodeId('app', 'Contract', 'missing'), dst: field.id });
    await store.beginRun(runRecord('r1'));
    await store.upsertNodes('r1', [root, retired, field]);
    await store.upsertEdges('r1', 'contracts', [oldEdge]);
    await store.finalizeRun('r1', []);
    raw.prepare('UPDATE nodes SET deleted_at = :run WHERE id = :id').run({ run: 'r1', id: retired.id });
    await store.beginRun(runRecord('r2'));
    await store.upsertEdges('r2', 'contracts', [missingSourceEdge]);
    await store.finalizeRun('r2', [extractorResult('contracts', 'PASS', [canonicalClaim('SchemaProperty', 'A')])]);
    assert.equal(raw.prepare('SELECT deleted_at FROM edges WHERE dst_id = :id').get({ id: retired.id })?.['deleted_at'], 'r2');
    await store.beginRun(runRecord('r3'));
    const bothKinds = scope('contracts', ['Contract', 'SchemaProperty'], encodeCanonicalSelector({ path: source, rules: [['exact', 'A'], ['prefix', 'A#/']] }));
    await store.finalizeRun('r3', [extractorResult('contracts', 'PASS', [bothKinds])]);
    assert.equal(raw.prepare('SELECT deleted_at FROM edges WHERE src_id = :id').get({ id: missingSourceEdge.src })?.['deleted_at'], null,
      'a missing source whose kind is claimed prevents destination fallback, even with a retained matching destination record');
  } finally { raw.close(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('currentness refuses missing, unfinished, failed, malformed and over-budget authority', () => {
  const auth = canonicalClaim('Contract', 'A');
  const node = { ...makeNode({ kind: 'Contract', name: 'A', path: source }), lastSeenRun: 'r1' };
  const run = { ...runRecord('r1'), finishedAt: 'done', results: [extractorResult('contracts', 'PASS', [auth])] };
  assert.equal(currentObservationOf(run)('contracts', node), true);
  assert.equal(currentObservationOf(undefined)('contracts', node), false);
  assert.equal(currentObservationOf({ ...run, finishedAt: null })('contracts', node), false);
  assert.equal(currentObservationOf({ ...run, finishedAt: '' })('contracts', node), false);
  assert.equal(currentObservationOf({ ...run, finishedAt: '   ' })('contracts', node), false);
  assert.equal(currentObservationOf({ ...run, results: [] })('contracts', node), false);
  assert.equal(currentObservationOf(run)('contracts', { ...node, deletedAt: 'r2' }), false);
  assert.equal(currentObservationOf(run)('contracts', { ...node, lastSeenRun: 'r0' }), false);
  for (const status of ['FAIL', 'UNAVAILABLE'] as const) {
    assert.equal(currentObservationOf({ ...run, results: [...run.results, extractorResult('other', status, [auth])] })('contracts', node), false);
  }
  for (const invalid of [{ ...auth, selector: '/@canonical/v2/00' }, { ...auth, kinds: [] },
    { ...auth, selector: '/@canonical/v1/' + 'f'.repeat(65_536) }]) {
    assert.equal(currentObservationOf({ ...run, results: [extractorResult('contracts', 'PASS', [invalid])] })('contracts', node), false);
  }
  const missingRepo = { ...batch('r1', [], [auth]) };
  delete missingRepo.repo;
  assert.throws(() => applyRun(EMPTY_STATE, [missingRepo]), /active run repository/);
});
