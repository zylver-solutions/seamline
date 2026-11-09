// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { encodeCanonicalSelector, SqliteStore } from '@seamline/core';
import type { ExtractorResult } from '@seamline/ontology';
import { currentObservationOf } from './current-observation.ts';
import { makeNode, makeResult, makeRun } from './testing.ts';
import { parseSif, serializeSif } from './sif.ts';

const property = makeNode({
  kind: 'SchemaProperty', canonicalName: 'Write#/properties/title', path: 'src/input.ts',
  props: { writeBindingComplete: true, lengthUpperState: 'unbounded' },
});

function result(selector: string, status: ExtractorResult['status'] = 'PASS'): ExtractorResult {
  return { ...makeResult('extract-contracts', status, ['contracts']),
    authoritative: [{ scope: 'contracts', kinds: ['Contract', 'SchemaProperty'], selector }] };
}

test('current authority refuses retained facts, including a repeated deterministic run id', async () => {
  const store = new SqliteStore({ ontologyVersion: '1.0.0' });
  try {
    const run = makeRun('run-det-ffffffffffffffff', []);
    await store.beginRun(run);
    await store.upsertNodes(run.runId, [property]);
    await store.finalizeRun(run.runId, [result('**/*.ts')]);
    const observed = store.node(property.id);
    assert.ok(observed !== undefined);
    assert.equal(currentObservationOf(await store.getRun(run.runId))('contracts', observed), true);

    // The same id may be retried with a dependency unread. Outside its new
    // authority the row stays live and even retains that same run stamp.
    await store.restartRun(run);
    await store.finalizeRun(run.runId, [result('**/*.ts,!src/input.ts')]);
    const retained = store.node(property.id);
    assert.ok(retained !== undefined);
    assert.equal(retained.deletedAt, null);
    assert.equal(retained.lastSeenRun, run.runId);
    assert.equal(retained.props['writeBindingComplete'], true);
    assert.equal(currentObservationOf(await store.getRun(run.runId))('contracts', retained), false);

    await store.restartRun(run);
    await store.upsertNodes(run.runId, [property]);
    await store.finalizeRun(run.runId, [result('**/*.ts')]);
    const recovered = store.node(property.id);
    assert.ok(recovered !== undefined);
    assert.equal(currentObservationOf(await store.getRun(run.runId))('contracts', recovered), true);
  } finally {
    await store.close();
  }
});

test('missing, unfinished, failed, malformed and unrelated authority never certifies a fact', () => {
  const good = makeRun('run-1', [result('**/*.ts')]);
  for (const run of [undefined, { ...good, finishedAt: null },
    { ...good, finishedAt: '' }, { ...good, finishedAt: ' \t' },
    makeRun('run-1', [result('**/*.ts', 'UNAVAILABLE')]),
    makeRun('run-1', [result('**/*.ts', 'FAIL')]),
    makeRun('run-1', [result('')]), makeRun('run-2', good.results),
    makeRun('run-1', good.results, 'different'), makeRun('run-1', [])]) {
    assert.equal(currentObservationOf(run)('contracts', property), false);
  }
  const observes = currentObservationOf(good);
  assert.equal(observes('contracts'), true);
  assert.equal(observes('infer-join'), false);
  const joined = makeRun('run-1', [...good.results, makeResult('infer-join', 'PASS', ['infer-join'])]);
  assert.equal(currentObservationOf(joined)('infer-join'), true, 'an edge-only scope can be current without owning a node');
  assert.equal(observes('data', property), false);
  assert.equal(observes('contracts', { ...property, deletedAt: 'run-2' }), false);
  assert.equal(observes('contracts', { ...property, kind: 'Column' }), false);
  const { path: _path, ...pathless } = property;
  assert.equal(observes('contracts', pathless), false);
  const conflict = makeRun('run-1', [result('**/*.ts'), result('**/*.ts', 'FAIL')]);
  assert.equal(currentObservationOf(conflict)('contracts', property), false);
});

test('CLI currentness distinguishes known canonical authority from a retained neighbour through SQLite and SIF', async () => {
  const source = 'src/input.ts';
  const known = makeNode({ kind: 'Contract', canonicalName: 'Write', path: source });
  const removed = makeNode({ kind: 'SchemaProperty', canonicalName: 'Write#/properties/title', path: source });
  // A display name cannot impersonate the canonical identity parsed from id.
  const opaque = makeNode({ kind: 'Contract', canonicalName: 'Other', name: 'Write', path: source });
  const retained = makeNode({ kind: 'SchemaProperty', canonicalName: 'Other#/properties/title', path: source });
  const directory = mkdtempSync(join(tmpdir(), 'seamline-currentness-'));
  const database = join(directory, 'graph.db');
  const store = new SqliteStore({ path: database, ontologyVersion: '1.0.0' });
  const persisted = new DatabaseSync(database);
  const run = makeRun('run-det-ffffffffffffffff', []);
  try {
    await store.beginRun(run);
    await store.upsertNodes(run.runId, [known, removed, opaque, retained]);
    await store.finalizeRun(run.runId, [result(source)]);
    await store.restartRun(run);
    await store.upsertNodes(run.runId, [known]);
    const narrowed: ExtractorResult = { ...makeResult('extract-contracts', 'PASS', []), authoritative: [
      { scope: 'contracts', kinds: ['Contract'], selector: encodeCanonicalSelector({ path: source, rules: [['exact', 'Write']] }) },
      { scope: 'contracts', kinds: ['SchemaProperty'], selector: encodeCanonicalSelector({ path: source, rules: [['prefix', 'Write#/']] }) },
    ] };
    await store.finalizeRun(run.runId, [narrowed]);
    const completed = await store.getRun(run.runId);
    assert.ok(completed !== undefined);
    const knownNow = store.node(known.id);
    const opaqueNow = store.node(opaque.id);
    const retainedNow = store.node(retained.id);
    assert.ok(knownNow !== undefined && opaqueNow !== undefined && retainedNow !== undefined);
    assert.equal(persisted.prepare('SELECT deleted_at FROM nodes WHERE id = ?').get(removed.id)?.['deleted_at'],
      run.runId, 'known property removal leaves a stored tombstone');
    assert.equal(store.node(removed.id), undefined, 'the public graph hides the tombstoned property');
    assert.equal(opaqueNow.deletedAt, null);
    assert.equal(retainedNow.deletedAt, null);
    assert.equal(retainedNow.lastSeenRun, run.runId, 'the same-id retry alone cannot certify this retained fact');
    const nodes = [...store.nodesByKind('Contract'), ...store.nodesByKind('SchemaProperty')];
    const snapshot = parseSif(serializeSif({ runId: run.runId, run: completed, results: completed.results, nodes, edges: [] }), 'canonical CLI observation');
    for (const observation of [currentObservationOf(completed), currentObservationOf(snapshot.run)]) {
      assert.equal(observation('contracts'), true);
      assert.equal(observation('contracts', knownNow), true, 'the complete known identity is current');
      assert.equal(observation('contracts', opaqueNow), false, 'same path and display name do not confer authority');
      assert.equal(observation('contracts', retainedNow), false, 'unknown neighbour stays live without currentness');
    }
    assert.ok(snapshot.nodes.some(node => node.id === retained.id));
    assert.equal(snapshot.nodes.some(node => node.id === removed.id), false);
  } finally {
    persisted.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
