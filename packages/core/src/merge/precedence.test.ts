import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PROVENANCE, PROVENANCE_RANK, type NodeId, type Provenance, type SeamlineNode } from '@seamline/ontology';

import { compareFacts, factBody, pickWinner, type Fact, type FactSource } from './precedence.ts';

const ID = 'seamline:Symbol:pkg::A' as NodeId;

function node(over: Partial<SeamlineNode> = {}): SeamlineNode {
  return {
    id: ID,
    kind: 'Symbol',
    name: 'pkg::A',
    sensitivity: 'internal',
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: 'r01',
    lastSeenRun: 'r01',
    deletedAt: null,
    ...over,
  };
}

function source(over: Partial<FactSource> = {}): FactSource {
  return { extractor: 'extract-code-ts', extractorPriority: 10, runId: 'r01', ...over };
}

function fact(value: SeamlineNode, src: FactSource): Fact<SeamlineNode> {
  return { value, source: src };
}

describe('the precedence order is the one the contract declares', () => {
  test('provenance dominates every other signal', () => {
    for (const high of PROVENANCE) {
      for (const low of PROVENANCE) {
        if (PROVENANCE_RANK[high] <= PROVENANCE_RANK[low]) continue;
        // The low-provenance fact is given every other advantage and still loses.
        const a = fact(node({ provenance: high }), source({ extractorPriority: 0, runId: 'r00' }));
        const b = fact(node({ provenance: low }), source({ extractorPriority: 99, runId: 'r99' }));
        assert.equal(pickWinner(a, b), a, `${high} must outrank ${low}`);
        assert.equal(pickWinner(b, a), a, `${high} must outrank ${low} in either argument order`);
      }
    }
  });

  test('within one provenance, higher extractorPriority wins, then the later run', () => {
    const lowPriority = fact(node(), source({ extractorPriority: 1, runId: 'r99' }));
    const highPriority = fact(node(), source({ extractorPriority: 2, runId: 'r00' }));
    assert.equal(pickWinner(lowPriority, highPriority), highPriority);

    const early = fact(node(), source({ runId: 'r01' }));
    const late = fact(node(), source({ runId: 'r02' }));
    assert.equal(pickWinner(early, late), late);
    assert.equal(pickWinner(late, early), late);
  });

  test('two facts differing only in body still have a deterministic winner', () => {
    const a = fact(node({ confidence: 0.5 }), source());
    const b = fact(node({ confidence: 0.9 }), source());
    assert.notEqual(compareFacts(a.value, a.source, b.value, b.source), 0);
    assert.equal(pickWinner(a, b), pickWinner(b, a));
  });

  test('the order is antisymmetric, and zero only for genuinely identical facts', () => {
    const provenances: Provenance[] = [...PROVENANCE];
    const facts: Array<Fact<SeamlineNode>> = [];
    for (const p of provenances) {
      for (const priority of [1, 2]) {
        for (const runId of ['r01', 'r02']) {
          for (const confidence of [0.5, 1]) {
            for (const extractor of ['alpha', 'beta']) {
              facts.push(fact(node({ provenance: p, confidence }), source({ extractor, extractorPriority: priority, runId })));
            }
          }
        }
      }
    }
    assert.equal(facts.length, 64);
    for (const a of facts) {
      for (const b of facts) {
        const ab = compareFacts(a.value, a.source, b.value, b.source);
        const ba = compareFacts(b.value, b.source, a.value, a.source);
        assert.equal(Math.sign(ab) + Math.sign(ba), 0, 'compareFacts must be antisymmetric');
        if (ab === 0) {
          assert.equal(factBody(a.value), factBody(b.value));
          assert.deepEqual(a.source, b.source);
        }
      }
    }
  });

  test('the winner of a set is independent of fold order', () => {
    const facts = [
      fact(node({ provenance: 'INFERRED' }), source({ extractor: 'infer-join', extractorPriority: 5, runId: 'r09' })),
      fact(node({ provenance: 'EXTRACTED', confidence: 0.7 }), source({ extractor: 'a', extractorPriority: 1, runId: 'r01' })),
      fact(node({ provenance: 'EXTRACTED', confidence: 0.9 }), source({ extractor: 'b', extractorPriority: 1, runId: 'r01' })),
      fact(node({ provenance: 'DECLARED' }), source({ extractor: 'c', extractorPriority: 99, runId: 'r99' })),
      fact(node({ provenance: 'LLM_SUGGESTED' }), source({ extractor: 'd', extractorPriority: 99, runId: 'r99' })),
    ];
    const reduce = (list: Array<Fact<SeamlineNode>>): Fact<SeamlineNode> =>
      list.reduce((acc, f) => pickWinner(acc, f));
    const expected = reduce(facts);
    for (let i = 0; i < facts.length; i += 1) {
      const rotated = [...facts.slice(i), ...facts.slice(0, i)];
      assert.deepEqual(reduce(rotated), expected);
      assert.deepEqual(reduce([...rotated].reverse()), expected);
    }
    assert.equal(expected.value.provenance, 'EXTRACTED');
  });
});

describe('factBody', () => {
  test('ignores lifecycle fields, so a sighting never changes who wins', () => {
    const a = node({ firstSeenRun: 'r01', lastSeenRun: 'r01', deletedAt: null });
    const b = node({ firstSeenRun: 'r00', lastSeenRun: 'r99', deletedAt: 'r50' });
    assert.equal(factBody(a), factBody(b));
    assert.equal(compareFacts(a, source(), b, source()), 0);
  });

  test('serializes keys in a fixed order regardless of construction order', () => {
    const a: SeamlineNode = { ...node(), props: { b: 1, a: 2 } };
    const b: SeamlineNode = { ...node(), props: { a: 2, b: 1 } };
    assert.equal(factBody(a), factBody(b));
  });
});
