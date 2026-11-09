import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capDepth, capList, mergeTruncation, NOT_TRUNCATED, truncation } from './bounds.ts';

test('capList passes a short list through untouched', () => {
  const r = capList([1, 2, 3], 10);
  assert.deepEqual(r.items, [1, 2, 3]);
  assert.equal(r.state.truncated, false);
});

test('capList truncates and reports both the cap and the true total', () => {
  const r = capList([1, 2, 3, 4, 5], 2);
  assert.deepEqual(r.items, [1, 2]);
  assert.equal(r.state.truncated, true);
  if (r.state.truncated) {
    assert.equal(r.state.returned, 2);
    assert.equal(r.state.total, 5);
    assert.deepEqual(r.state.reasons, ['result-cap']);
    assert.match(r.state.message, /TRUNCATED/);
    assert.match(r.state.message, /do not treat this as the full result set/);
  }
});

test('mergeTruncation unions the reasons from two caps', () => {
  const merged = mergeTruncation(truncation(['depth-cap'], 3, null), truncation(['size-cap'], 2, 9));
  assert.equal(merged.truncated, true);
  if (merged.truncated) {
    assert.deepEqual(merged.reasons, ['depth-cap', 'size-cap']);
  }
});

test('mergeTruncation with an untruncated side returns the other side', () => {
  const t = truncation(['result-cap'], 1, 2);
  assert.equal(mergeTruncation(NOT_TRUNCATED, t), t);
  assert.equal(mergeTruncation(t, NOT_TRUNCATED), t);
  assert.equal(mergeTruncation(NOT_TRUNCATED, NOT_TRUNCATED).truncated, false);
});

test('capDepth clamps a caller above the ceiling and reports the clamp', () => {
  const r = capDepth(99, 4);
  assert.equal(r.depth, 4);
  assert.equal(r.clamped, true);
});

test('capDepth honours a caller asking for less', () => {
  const r = capDepth(1, 4);
  assert.equal(r.depth, 1);
  assert.equal(r.clamped, false);
});

test('capDepth with no request falls back to the ceiling', () => {
  const r = capDepth(undefined, 4);
  assert.equal(r.depth, 4);
  assert.equal(r.clamped, false);
});

test('a token budget is a truncation reason of its own, merged and named like any other cap', () => {
  const t = truncation(['token-budget'], 4, 9);
  assert.equal(t.message.includes('Caps hit: token-budget'), true);
  const merged = mergeTruncation(truncation(['result-cap'], 10, 40), t);
  assert.equal(merged.truncated, true);
  if (merged.truncated) {
    assert.deepEqual(merged.reasons, ['result-cap', 'token-budget']);
  }
});
