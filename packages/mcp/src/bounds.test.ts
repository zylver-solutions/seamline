import assert from 'node:assert/strict';
import { test } from 'node:test';
import { byteLength, capDepth, capList, capString, fitToByteBudget, mergeTruncation, NOT_TRUNCATED, truncation } from './bounds.ts';
import { DEFAULT_BOUNDS, resolveBounds } from './ports.ts';

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

test('capString marks what it cut instead of silently shortening', () => {
  const r = capString('x'.repeat(100), 10);
  assert.equal(r.truncated, true);
  assert.match(r.value, /\[TRUNCATED 90 more characters\]/);
  assert.ok(r.value.startsWith('x'.repeat(10)));
});

test('capString leaves a short string alone', () => {
  const r = capString('short', 10);
  assert.equal(r.truncated, false);
  assert.equal(r.value, 'short');
});

test('fitToByteBudget returns everything when it fits', () => {
  const items = [1, 2, 3];
  const r = fitToByteBudget(items, (kept) => ({ kept }), 10_000);
  assert.deepEqual(r.items, items);
  assert.equal(r.state.truncated, false);
});

test('a response over the byte cap is truncated with an explicit marker, not silently', () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ id: `node-${i}`, blob: 'y'.repeat(200) }));
  const budget = 4096;
  const r = fitToByteBudget(items, (kept) => ({ results: kept }), budget);

  assert.ok(r.items.length < items.length, 'items were dropped');
  assert.ok(r.bytes <= budget, `the fitted body is within budget: ${r.bytes} <= ${budget}`);
  assert.equal(r.state.truncated, true, 'and the response says so');
  if (r.state.truncated) {
    assert.ok(r.state.reasons.includes('size-cap'));
    assert.equal(r.state.total, items.length, 'the true total is disclosed');
    assert.match(r.state.message, /TRUNCATED/);
  }
});

test('fitToByteBudget keeps the largest prefix that fits, not an arbitrary one', () => {
  const items = Array.from({ length: 50 }, (_, i) => i);
  const budget = 60;
  const r = fitToByteBudget(items, (kept) => ({ results: kept }), budget);
  assert.ok(r.bytes <= budget);
  const oneMore = byteLength({ results: items.slice(0, r.items.length + 1) });
  assert.ok(oneMore > budget, 'adding one more item would exceed the budget');
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
  const r = capDepth(99, DEFAULT_BOUNDS);
  assert.equal(r.depth, DEFAULT_BOUNDS.maxDepth);
  assert.equal(r.clamped, true);
});

test('capDepth honours a caller asking for less', () => {
  const r = capDepth(1, DEFAULT_BOUNDS);
  assert.equal(r.depth, 1);
  assert.equal(r.clamped, false);
});

test('a bounds override can only lower a cap, never raise it', () => {
  const raised = resolveBounds({ maxResults: 100_000, maxBytes: 10_000_000, maxDepth: 50 });
  assert.equal(raised.maxResults, DEFAULT_BOUNDS.maxResults);
  assert.equal(raised.maxBytes, DEFAULT_BOUNDS.maxBytes);
  assert.equal(raised.maxDepth, DEFAULT_BOUNDS.maxDepth);

  const lowered = resolveBounds({ maxResults: 5 });
  assert.equal(lowered.maxResults, 5);
});

test('a nonsensical bounds override falls back to the ceiling rather than disabling the cap', () => {
  const b = resolveBounds({ maxResults: 0, maxBytes: -1, maxDepth: Number.NaN });
  assert.equal(b.maxResults, DEFAULT_BOUNDS.maxResults);
  assert.equal(b.maxBytes, DEFAULT_BOUNDS.maxBytes);
  assert.equal(b.maxDepth, DEFAULT_BOUNDS.maxDepth);
});
