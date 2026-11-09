import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isDeleted, mergeLifecycle, observedIn, settle, tombstone, type Lifecycle } from './lifecycle.ts';

function life(first: string, last: string, deletedAt: string | null = null): Lifecycle {
  return { firstSeenRun: first, lastSeenRun: last, deletedAt };
}

describe('deletedAt is a run id, not a timestamp', () => {
  test('a tombstone records the run that buried the fact', () => {
    const buried = tombstone(life('r01', 'r03'), 'r04');
    assert.equal(buried.deletedAt, 'r04');
    assert.equal(buried.lastSeenRun, 'r03');
    assert.ok(isDeleted(buried));
  });

  test('nothing in a settled lifecycle is a wall-clock value (v3 §2.3)', () => {
    const buried = tombstone(life('r01', 'r03'), 'r04');
    for (const value of [buried.firstSeenRun, buried.lastSeenRun, buried.deletedAt]) {
      assert.ok(value === null || /^r\d+$/.test(value), `${String(value)} must be a run id`);
    }
  });
});

describe('deletedAt clears on re-insert', () => {
  test('a tombstoned fact seen again in a later run is resurrected, not shadowed', () => {
    const buried = tombstone(life('r01', 'r03'), 'r04');
    assert.ok(isDeleted(buried));
    const resurrected = observedIn(buried, 'r05');
    assert.equal(resurrected.deletedAt, null, 'deletedAt must be cleared on re-insert');
    assert.equal(resurrected.lastSeenRun, 'r05');
    assert.equal(resurrected.firstSeenRun, 'r01', 'first sighting is preserved across a burial');
    assert.equal(isDeleted(resurrected), false);
  });

  test('resurrection survives a subsequent merge with the stale tombstoned copy', () => {
    const buried = tombstone(life('r01', 'r03'), 'r04');
    const resurrected = observedIn(buried, 'r05');
    assert.equal(mergeLifecycle(resurrected, buried).deletedAt, null);
    assert.equal(mergeLifecycle(buried, resurrected).deletedAt, null);
  });

  test('a burial that postdates the last sighting is not cleared', () => {
    const merged = mergeLifecycle(life('r01', 'r03', 'r09'), life('r02', 'r04'));
    assert.equal(merged.deletedAt, 'r09');
    assert.ok(isDeleted(merged));
  });

  test('burying something already buried keeps the original death run', () => {
    const buried = tombstone(life('r01', 'r02'), 'r03');
    assert.equal(tombstone(buried, 'r07').deletedAt, 'r03');
  });

  test('a fact cannot be buried by a run that saw it', () => {
    assert.equal(tombstone(life('r01', 'r05'), 'r05').deletedAt, null);
    assert.equal(tombstone(life('r01', 'r05'), 'r04').deletedAt, null);
  });
});

describe('mergeLifecycle is a lattice fold', () => {
  const samples: Lifecycle[] = [
    life('r01', 'r01'),
    life('r01', 'r05'),
    life('r02', 'r03', 'r04'),
    life('r00', 'r09', 'r02'),
    life('r03', 'r03', 'r08'),
    life('r04', 'r07'),
  ];

  test('commutative, associative, and idempotent over every sample triple', () => {
    for (const a of samples) {
      assert.deepEqual(mergeLifecycle(a, a), settle(a.firstSeenRun, a.lastSeenRun, a.deletedAt));
      for (const b of samples) {
        assert.deepEqual(mergeLifecycle(a, b), mergeLifecycle(b, a));
        for (const c of samples) {
          assert.deepEqual(
            mergeLifecycle(mergeLifecycle(a, b), c),
            mergeLifecycle(a, mergeLifecycle(b, c)),
          );
        }
      }
    }
  });

  test('firstSeenRun is the minimum and lastSeenRun the maximum', () => {
    const merged = mergeLifecycle(life('r05', 'r06'), life('r02', 'r09'));
    assert.equal(merged.firstSeenRun, 'r02');
    assert.equal(merged.lastSeenRun, 'r09');
  });
});
