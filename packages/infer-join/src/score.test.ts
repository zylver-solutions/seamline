import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, TYPE_SIGNAL, calibrate, normalizeWeights, scorePair } from './score.ts';
import type { Facet } from './facets.ts';
import type { TypeCategory } from './typecat.ts';
import { canonicalKey, containerCoreKey, literalKey } from './naming.ts';
import { makeNode } from './test-graph.ts';

function facet(container: string, name: string, typeCategory: TypeCategory): Facet {
  const node = makeNode({ kind: 'Column', canonicalName: `main.public.${container}.${name}`, name });
  return {
    id: node.id,
    kind: node.kind,
    node,
    name,
    container,
    containerId: undefined,
    typeCategory,
    rawType: undefined,
    file: undefined,
    nameKeys: [literalKey(name), canonicalKey(name)],
    containerKeys: [literalKey(container), canonicalKey(container), containerCoreKey(container)],
  };
}

describe('normalizeWeights', () => {
  it('rescales any positive ratios to sum to one', () => {
    const scaled = normalizeWeights({ name: 45, container: 30, type: 15, structure: 10 });
    assert.equal(scaled.name + scaled.container + scaled.type + scaled.structure, 1);
    assert.ok(Math.abs(scaled.name - DEFAULT_WEIGHTS.name) < 1e-12);
  });

  it('rejects a degenerate weight vector', () => {
    assert.throws(() => normalizeWeights({ name: 0, container: 0, type: 0, structure: 0 }), RangeError);
  });
});

describe('calibrate', () => {
  it('passes through the three documented anchor points', () => {
    assert.equal(calibrate(DEFAULT_THRESHOLDS.minScore), 0.5);
    assert.equal(calibrate(0.8), 0.8);
    assert.equal(calibrate(1), DEFAULT_THRESHOLDS.maxConfidence);
  });

  it('never reaches certainty, because an inferred edge is never a fact', () => {
    assert.ok(calibrate(1) < 1);
  });

  it('is monotonically non-decreasing', () => {
    let previous = -1;
    for (let raw = 0; raw <= 1.0001; raw += 0.01) {
      const value = calibrate(raw);
      assert.ok(value >= previous - 1e-12, `raw ${raw}`);
      previous = value;
    }
  });
});

describe('scorePair', () => {
  it('gives a clean name, container and type match a high confidence', () => {
    const score = scorePair(facet('posts', 'scheduled_at', 'timestamp'), facet('Post', 'scheduledAt', 'timestamp'), 0);
    assert.equal(score.name.score, 1);
    assert.equal(score.container, 1);
    assert.equal(score.typeAgreement, 'equal');
    assert.ok(score.admissible);
    assert.ok(score.confidence > 0.85, `confidence ${score.confidence}`);
  });

  it('scores the same field name on an unrelated container far lower and inadmissibly', () => {
    const related = scorePair(facet('posts', 'scheduled_at', 'timestamp'), facet('Post', 'scheduledAt', 'timestamp'), 0);
    const unrelated = scorePair(facet('posts', 'scheduled_at', 'timestamp'), facet('Invoice', 'scheduledAt', 'timestamp'), 0);
    assert.ok(unrelated.container < 0.3, `container ${unrelated.container}`);
    assert.ok(unrelated.confidence < related.confidence - 0.2);
    assert.equal(unrelated.admissible, false);
  });

  it('does not let a type conflict veto a confident name and container match', () => {
    const conflicting = scorePair(facet('posts', 'published_at', 'timestamp'), facet('Post', 'publishedAt', 'boolean'), 0);
    assert.equal(conflicting.typeAgreement, 'conflict');
    assert.equal(conflicting.typeSignal, 0);
    assert.ok(conflicting.admissible, 'a type conflict must still produce an edge for X2 to find');
    assert.ok(conflicting.confidence > 0.5);
  });

  it('ranks type agreement above unknown above conflict, all else equal', () => {
    const agree = scorePair(facet('posts', 'published_at', 'timestamp'), facet('Post', 'publishedAt', 'timestamp'), 0);
    const unread = scorePair(facet('posts', 'published_at', 'timestamp'), facet('Post', 'publishedAt', 'unknown'), 0);
    const conflict = scorePair(facet('posts', 'published_at', 'timestamp'), facet('Post', 'publishedAt', 'boolean'), 0);
    assert.ok(agree.confidence > unread.confidence);
    assert.ok(unread.confidence > conflict.confidence);
    assert.equal(TYPE_SIGNAL.conflict, 0);
  });

  it('lets structural corroboration lift a pair without carrying it', () => {
    const bare = scorePair(facet('posts', 'scheduled_at', 'timestamp'), facet('Post', 'scheduledAt', 'timestamp'), 0);
    const corroborated = scorePair(facet('posts', 'scheduled_at', 'timestamp'), facet('Post', 'scheduledAt', 'timestamp'), 1);
    assert.ok(corroborated.confidence > bare.confidence);

    // Maximal corroboration cannot rescue a pair that fails the name gate.
    const noName = scorePair(facet('posts', 'title', 'text'), facet('Post', 'body', 'text'), 1);
    assert.equal(noName.admissible, false);
  });

  it('reports a confidence even for a pair it rejects, so the rejection is inspectable', () => {
    const rejected = scorePair(facet('posts', 'title', 'text'), facet('Invoice', 'title', 'text'), 0);
    assert.equal(rejected.admissible, false);
    assert.ok(rejected.confidence > 0);
  });

  it('joins posts.post_id to Post.id through the affix rule', () => {
    const score = scorePair(facet('posts', 'post_id', 'uuid'), facet('Post', 'id', 'text'), 0);
    assert.equal(score.name.variant, 'affix');
    assert.equal(score.typeAgreement, 'compatible');
    assert.ok(score.admissible);
  });
});


it('zero configured thresholds and maximal structure cannot replace container identity', () => {
  const thresholds = { ...DEFAULT_THRESHOLDS, minContainer: 0, minName: 0, minScore: 0 };
  for (const [left, right] of [['posts', 'PostRow'], ['users', 'UserProfile'], ['', ''], ['---', '___']]) {
    const score = scorePair(facet(left!, 'id', 'uuid'), facet(right!, 'id', 'uuid'), 1, DEFAULT_WEIGHTS, thresholds);
    assert.equal(score.admissible, false, `${left} vs ${right}`);
  }
  assert.equal(scorePair(facet('posts', 'post_id', 'uuid'), facet('Post', 'id', 'text'), 1, DEFAULT_WEIGHTS, thresholds).admissible, true);
});
