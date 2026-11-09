import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { NodeId } from '@seamline/ontology';
import type { Candidate } from './ambiguity.ts';
import { resolveCandidates } from './ambiguity.ts';
import { DEFAULT_THRESHOLDS } from './score.ts';
import type { PairScore } from './score.ts';

function score(confidence: number): PairScore {
  return {
    name: { score: 1, variant: 'convention' },
    container: 1,
    typeAgreement: 'equal',
    typeSignal: 1,
    structure: 0,
    raw: confidence,
    confidence,
    admissible: true,
  };
}

const id = (value: string): NodeId => value as NodeId;

function candidate(src: string, dst: string, confidence: number): Candidate {
  return { src: id(src), dst: id(dst), score: score(confidence) };
}

describe('resolveCandidates, exclusive relations', () => {
  it('emits one full-confidence edge when the winner is clear of the margin', () => {
    const { decisions, ambiguities } = resolveCandidates([
      candidate('c1', 'f1', 0.9),
      candidate('c1', 'f2', 0.6),
    ]);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.dst, 'f1');
    assert.equal(decisions[0]?.resolution, 'decisive');
    assert.equal(decisions[0]?.confidence, 0.9);
    assert.equal(ambiguities.length, 0);
  });

  it('splits the probability mass across a two-way tie instead of silently picking one', () => {
    const { decisions, ambiguities } = resolveCandidates([
      candidate('c1', 'f1', 0.9),
      candidate('c1', 'f2', 0.88),
    ]);
    assert.equal(decisions.length, 2);
    for (const decision of decisions) {
      assert.equal(decision.resolution, 'ambiguous');
      assert.ok(decision.confidence <= DEFAULT_THRESHOLDS.ambiguousCeiling);
      assert.deepEqual(decision.group, ['f1', 'f2']);
    }
    assert.equal(decisions[0]?.confidence, 0.45);
    assert.equal(decisions[1]?.confidence, 0.44);
    assert.equal(ambiguities.length, 1);
    assert.equal(ambiguities[0]?.reason, 'tie');
    assert.equal(ambiguities[0]?.dropped, false);
  });

  it('divides across a three-way tie, so each edge falls well below the ceiling', () => {
    const { decisions } = resolveCandidates([
      candidate('c1', 'f1', 0.9),
      candidate('c1', 'f2', 0.9),
      candidate('c1', 'f3', 0.9),
    ]);
    assert.equal(decisions.length, 3);
    for (const decision of decisions) assert.equal(decision.confidence, 0.3);
  });

  it('emits nothing past the fanout cap and records the top candidates instead', () => {
    const { decisions, ambiguities } = resolveCandidates([
      candidate('c1', 'f1', 0.9),
      candidate('c1', 'f2', 0.9),
      candidate('c1', 'f3', 0.9),
      candidate('c1', 'f4', 0.9),
    ]);
    assert.equal(decisions.length, 0);
    assert.equal(ambiguities.length, 1);
    assert.equal(ambiguities[0]?.reason, 'fanout');
    assert.equal(ambiguities[0]?.dropped, true);
    assert.equal(ambiguities[0]?.subject, 'c1');
    assert.equal(ambiguities[0]?.candidates.length, DEFAULT_THRESHOLDS.maxAmbiguousFanout);
  });

  it('divides confidence between two sources contending for one target', () => {
    const { decisions, ambiguities } = resolveCandidates([
      candidate('c1', 'f1', 0.9),
      candidate('c2', 'f1', 0.88),
    ]);
    assert.equal(decisions.length, 2);
    for (const decision of decisions) {
      assert.equal(decision.contended, true);
      assert.equal(decision.claimants, 2);
      assert.equal(decision.resolution, 'decisive');
    }
    assert.equal(decisions[0]?.confidence, 0.45);
    assert.equal(decisions[1]?.confidence, 0.44);
    assert.equal(ambiguities.filter((a) => a.reason === 'contention').length, 1);
  });

  it('leaves a clear winner alone when the other claimant is outside the margin', () => {
    const { decisions } = resolveCandidates([
      candidate('c1', 'f1', 0.9),
      candidate('c2', 'f1', 0.6),
    ]);
    const winner = decisions.find((d) => d.src === 'c1');
    const loser = decisions.find((d) => d.src === 'c2');
    assert.equal(winner?.confidence, 0.9);
    assert.equal(winner?.contended, false);
    assert.equal(loser?.confidence, 0.6);
  });

  it('is independent of input order', () => {
    const input = [
      candidate('c2', 'f1', 0.88),
      candidate('c1', 'f1', 0.9),
      candidate('c1', 'f2', 0.7),
    ];
    const forward = resolveCandidates(input);
    const reversed = resolveCandidates(input.slice().reverse());
    assert.deepEqual(forward.decisions, reversed.decisions);
    assert.deepEqual(forward.ambiguities, reversed.ambiguities);
  });

  it('respects an overridden margin', () => {
    const wide = resolveCandidates(
      [candidate('c1', 'f1', 0.9), candidate('c1', 'f2', 0.6)],
      { ...DEFAULT_THRESHOLDS, ambiguityMargin: 0.5 },
    );
    assert.equal(wide.decisions.length, 2);
    assert.equal(wide.decisions[0]?.resolution, 'ambiguous');
  });
});

describe('resolveCandidates, non-exclusive relations', () => {
  it('keeps every candidate at full confidence, because one validator validates many fields', () => {
    const { decisions, ambiguities } = resolveCandidates(
      [candidate('f1', 'v1', 0.9), candidate('f1', 'v2', 0.88)],
      DEFAULT_THRESHOLDS,
      { exclusive: false },
    );
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0]?.confidence, 0.9);
    assert.equal(decisions[1]?.confidence, 0.88);
    assert.equal(ambiguities.length, 0);
  });

  it('does not divide confidence between sources sharing one validator', () => {
    const { decisions } = resolveCandidates(
      [candidate('f1', 'v1', 0.9), candidate('f2', 'v1', 0.9)],
      DEFAULT_THRESHOLDS,
      { exclusive: false },
    );
    assert.equal(decisions.length, 2);
    for (const decision of decisions) {
      assert.equal(decision.contended, false);
      assert.equal(decision.confidence, 0.9);
    }
  });

  it('still enforces the fanout cap', () => {
    const { decisions, ambiguities } = resolveCandidates(
      [
        candidate('f1', 'v1', 0.9), candidate('f1', 'v2', 0.85),
        candidate('f1', 'v3', 0.8), candidate('f1', 'v4', 0.75),
      ],
      DEFAULT_THRESHOLDS,
      { exclusive: false },
    );
    assert.equal(decisions.length, 0);
    assert.equal(ambiguities[0]?.reason, 'fanout');
    assert.equal(ambiguities[0]?.dropped, true);
  });
});
