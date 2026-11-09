/**
 * Cross-package regression coverage for the store x merge lifecycle contract.
 *
 * `packages/core/src/store/sqlite-store.ts` and `packages/core/src/merge/lifecycle.ts`
 * each independently agree that `deleted_at` holds the RUN ID that buried a
 * fact, never a wall-clock timestamp -- but nothing exercises the two modules
 * TOGETHER. Each module's own suite (`sqlite-store.test.ts`,
 * `lifecycle.test.ts`) only ever feeds itself hand-built fixtures, so a
 * regression where the store starts writing a wall-clock timestamp into
 * `deleted_at` instead of a run id would compile clean (both are
 * `string | null`) and pass both suites in isolation.
 *
 * This test closes that gap by never hand-constructing the tombstoned
 * lifecycle it asserts against. It reads `deleted_at`/`first_seen_run`/
 * `last_seen_run` straight off the on-disk row a real `SqliteStore.finalizeRun`
 * wrote, and cross-checks that raw state against what `merge/lifecycle`'s own
 * `tombstone`/`observedIn` functions independently derive for the same run
 * sequence. If the store ever wrote a timestamp where a run id belongs, this
 * `assert.deepEqual` fails immediately -- the two derivations diverge -- and
 * `isDeleted` would additionally report the wrong liveness verdict, because
 * `compareRuns` sorts an ISO-8601 string (leading digit) before any `rNN` run
 * id (leading letter), which makes a live-looking tombstone read as dead or a
 * dead one read as alive depending on which side of the comparison it lands
 * on.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { nodeId } from '@seamline/ontology';
import type { ExtractorResult, NodeId, SeamlineNode } from '@seamline/ontology';
import { SqliteStore, isDeleted, observedIn, tombstone } from '@seamline/core';
import type { Lifecycle } from '@seamline/core';

const REPO = 'app';
const SCOPE = 'code.ts';
const PATH = 'src/a.ts';

function fixedClock(value: string): () => string {
  return () => value;
}

function fileNode(path: string): SeamlineNode {
  return {
    id: nodeId(REPO, 'File', path),
    kind: 'File',
    name: path,
    path,
    sensitivity: 'internal',
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: '',
    lastSeenRun: '',
    deletedAt: null,
  };
}

function passResult(): ExtractorResult {
  return {
    extractor: 'lifecycle-store-test',
    version: '0.0.1',
    status: 'PASS',
    authoritative: [{ scope: SCOPE, kinds: ['File'] }],
    nodeCount: 0,
    edgeCount: 0,
    durationMs: 0,
    diagnostics: [],
  };
}

interface RawLifecycleRow {
  readonly deleted_at: string | null;
  readonly first_seen_run: string;
  readonly last_seen_run: string;
}

/** Reads the exact persisted row, bypassing the store's own tombstone-hiding read path. */
function readRawLifecycle(path: string, id: NodeId): RawLifecycleRow {
  const raw = new DatabaseSync(path);
  try {
    const row = raw
      .prepare('SELECT deleted_at, first_seen_run, last_seen_run FROM nodes WHERE id = :id')
      .get({ id }) as RawLifecycleRow | undefined;
    assert.ok(row !== undefined, `expected a persisted row for ${id}`);
    return row;
  } finally {
    raw.close();
  }
}

function toLifecycle(row: RawLifecycleRow): Lifecycle {
  return { firstSeenRun: row.first_seen_run, lastSeenRun: row.last_seen_run, deletedAt: row.deleted_at };
}

test('store tombstone write agrees with merge/lifecycle.tombstone on the same run sequence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'seamline-integration-lifecycle-'));
  const path = join(dir, 'graph.db');
  try {
    const id = nodeId(REPO, 'File', PATH);

    // Run r1 sees the file. Run r2 is PASS/authoritative over the same scope
    // but does not re-observe it: finalizeRun's sweep must tombstone it.
    const s1 = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock('2026-01-01T00:00:01.000Z') });
    await s1.beginRun({ runId: 'r1', repo: REPO, commit: null, startedAt: '2026-01-01T00:00:00.000Z', ontologyVersion: '1.0.0' });
    await s1.upsertNodes('r1', [fileNode(PATH)]);
    await s1.finalizeRun('r1', [passResult()]);

    await s1.beginRun({ runId: 'r2', repo: REPO, commit: null, startedAt: '2026-01-02T00:00:00.000Z', ontologyVersion: '1.0.0' });
    await s1.finalizeRun('r2', [passResult()]);
    await s1.close();

    // The public read path hides tombstoned nodes -- that is the point of a
    // tombstone -- so cross-check the RAW row, not a fixture.
    const buriedRaw = readRawLifecycle(path, id);
    const buried = toLifecycle(buriedRaw);

    // merge/lifecycle's own, store-independent derivation for "seen only in
    // r1, buried in r2".
    const expectedBuried = tombstone({ firstSeenRun: 'r1', lastSeenRun: 'r1', deletedAt: null }, 'r2');

    // The genuine trap: if the store wrote `finishedAt` (a wall-clock ISO
    // string) instead of `runId` into deleted_at, this fails here -- the raw
    // row and merge's derivation diverge -- rather than merely differing from
    // a hand-built expectation.
    assert.deepEqual(buried, expectedBuried, 'the store persisted exactly what merge/lifecycle.tombstone predicts');
    assert.equal(buried.deletedAt, 'r2');
    assert.doesNotMatch(buried.deletedAt ?? '', /^\d{4}-\d{2}-\d{2}T/, 'deletedAt must be a run id, not a timestamp');
    assert.ok(isDeleted(buried), 'a node buried after its last sighting must read as dead');

    // The store's own public read path must agree with the raw+derived verdict.
    const s2 = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock('2026-01-03T00:00:00.000Z') });
    assert.equal(s2.node(id), undefined, 'a dead node is hidden from the public read path');

    // Resurrection: run r3 re-observes the same fact.
    await s2.beginRun({ runId: 'r3', repo: REPO, commit: null, startedAt: '2026-01-03T00:00:00.000Z', ontologyVersion: '1.0.0' });
    await s2.upsertNodes('r3', [fileNode(PATH)]);
    await s2.finalizeRun('r3', [passResult()]);
    await s2.close();

    const revivedRaw = readRawLifecycle(path, id);
    const revived = toLifecycle(revivedRaw);

    // merge/lifecycle's own derivation of "a tombstoned fact re-observed in r3",
    // fed from the ACTUAL buried state read off disk above -- not a fixture.
    const expectedRevived = observedIn(buried, 'r3');

    assert.deepEqual(revived, expectedRevived, 'the store persisted exactly what merge/lifecycle.observedIn predicts');
    assert.equal(revived.deletedAt, null, 'resurrection clears the tombstone');
    assert.equal(revived.firstSeenRun, 'r1', 'resurrection preserves the original first sighting');
    assert.equal(revived.lastSeenRun, 'r3');
    assert.equal(isDeleted(revived), false);

    const s3 = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock('2026-01-04T00:00:00.000Z') });
    assert.ok(s3.node(id) !== undefined, 'a resurrected node is visible again on the public read path');
    await s3.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
