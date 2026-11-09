import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AggregationModel } from './confidence.ts';
import { AGGREGATION_MODELS, aggregateConfidence, pathConfidence, roundTo } from './confidence.ts';

describe('aggregateConfidence', () => {
  it('multiplies independent hops: three 0.8 hops are 0.512, not 0.8', () => {
    assert.equal(aggregateConfidence([0.8]), 0.8);
    assert.equal(aggregateConfidence([0.8, 0.8]), 0.64);
    assert.equal(aggregateConfidence([0.8, 0.8, 0.8]), 0.512);
  });

  it('treats a zero-hop path as certain', () => {
    assert.equal(aggregateConfidence([]), 1);
  });

  it('does not decay a chain of facts', () => {
    assert.equal(aggregateConfidence([1, 1, 1, 1]), 1);
  });

  it('collapses to zero as soon as one hop is worthless', () => {
    assert.equal(aggregateConfidence([0.9, 0, 0.9]), 0);
    assert.equal(aggregateConfidence([0.9, 0, 0.9], { model: 'correlated', correlation: 0.5 }), 0);
  });

  it('min is the weakest link and bounds the product from above', () => {
    const hops = [0.9, 0.7, 0.85];
    const product = aggregateConfidence(hops);
    const min = aggregateConfidence(hops, { model: 'min' });
    assert.equal(min, 0.7);
    assert.ok(product < min);
  });

  it('correlated interpolates between product and min', () => {
    const hops = [0.9, 0.7, 0.85];
    const product = aggregateConfidence(hops);
    const min = aggregateConfidence(hops, { model: 'min' });
    const half = aggregateConfidence(hops, { model: 'correlated', correlation: 0.5 });
    assert.ok(half > product && half < min);
    assert.equal(aggregateConfidence(hops, { model: 'correlated', correlation: 0 }), product);
    assert.equal(aggregateConfidence(hops, { model: 'correlated', correlation: 1 }), min);
  });

  it('is monotonically non-increasing in path length, exhaustively over a grid', () => {
    // Every model, every prefix of every sequence drawn from a fixed grid.
    // Deterministic and total over the interesting space, so it is a real
    // property check rather than a spot check.
    const grid = [0, 0.05, 0.25, 0.5, 0.75, 0.9, 1];
    const models: ReadonlyArray<AggregationModel> = AGGREGATION_MODELS;
    let checks = 0;
    for (const model of models) {
      for (const a of grid) {
        for (const b of grid) {
          for (const c of grid) {
            const options = { model, correlation: 0.4 };
            const one = aggregateConfidence([a], options);
            const two = aggregateConfidence([a, b], options);
            const three = aggregateConfidence([a, b, c], options);
            assert.ok(two <= one + 1e-9, `${model} ${a},${b}`);
            assert.ok(three <= two + 1e-9, `${model} ${a},${b},${c}`);
            assert.ok(three >= 0 && one <= 1);
            checks += 1;
          }
        }
      }
    }
    assert.equal(checks, grid.length ** 3 * models.length);
  });

  it('rejects an out-of-range confidence instead of propagating nonsense', () => {
    assert.throws(() => aggregateConfidence([1.2]), RangeError);
    assert.throws(() => aggregateConfidence([-0.1]), RangeError);
    assert.throws(() => aggregateConfidence([Number.NaN]), RangeError);
    assert.throws(() => aggregateConfidence([0.5], { model: 'correlated', correlation: 2 }), RangeError);
  });

  it('is order-independent', () => {
    assert.equal(aggregateConfidence([0.9, 0.5, 0.7]), aggregateConfidence([0.5, 0.7, 0.9]));
  });
});

describe('pathConfidence', () => {
  it('reads confidence off hop-shaped objects', () => {
    assert.equal(pathConfidence([{ confidence: 0.5 }, { confidence: 0.5 }]), 0.25);
  });
});

describe('roundTo', () => {
  it('produces fixed-precision output for byte-identical serialization', () => {
    assert.equal(roundTo(0.5120000000000001, 6), 0.512);
    assert.equal(roundTo(1 / 3, 4), 0.3333);
  });
});
