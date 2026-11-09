import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nodeId, parseNodeId, outranks, isFact, isValidEdge, assertWithinCeiling, NODE_KINDS, EDGE_KINDS, EDGE_SIGNATURES, DEFAULT_SENSITIVITY } from './contract.ts';
import type { ExtractorManifest } from './contract.ts';

describe('identity', () => {
  test('round-trips a node id', () => {
    const id = nodeId('seamline', 'Column', 'catalog.books.published_at');
    assert.deepEqual(parseNodeId(id), { repo: 'seamline', kind: 'Column', canonicalName: 'catalog.books.published_at' });
  });
  test('a canonical name may contain colons', () => {
    const id = nodeId('r', 'Symbol', 'pkg/mod.ts::Cls::method');
    assert.equal(parseNodeId(id).canonicalName, 'pkg/mod.ts::Cls::method');
  });
  test('rejects a repo containing a separator', () => {
    assert.throws(() => nodeId('a:b', 'File', 'x'), /must not contain/);
  });
});

describe('provenance precedence is total and strict', () => {
  test('orders correctly', () => {
    assert.equal(outranks('EXTRACTED', 'DECLARED'), true);
    assert.equal(outranks('DECLARED', 'INFERRED'), true);
    assert.equal(outranks('INFERRED', 'LLM_SUGGESTED'), true);
  });
  test('is irreflexive, so merge cannot flip-flop on equal provenance', () => {
    for (const p of ['EXTRACTED', 'DECLARED', 'INFERRED', 'LLM_SUGGESTED'] as const) {
      assert.equal(outranks(p, p), false);
    }
  });
  test('only EXTRACTED and DECLARED count as fact', () => {
    assert.equal(isFact('EXTRACTED'), true);
    assert.equal(isFact('DECLARED'), true);
    assert.equal(isFact('INFERRED'), false);
    assert.equal(isFact('LLM_SUGGESTED'), false);
  });
});

describe('edge signatures', () => {
  test('every edge kind declares at least one signature', () => {
    for (const k of EDGE_KINDS) {
      assert.ok(EDGE_SIGNATURES[k].length > 0, `${k} has no declared domain/range`);
    }
  });
  test('every signature endpoint is a real node kind', () => {
    for (const k of EDGE_KINDS) {
      for (const [s, d] of EDGE_SIGNATURES[k]) {
        assert.ok(NODE_KINDS.includes(s), `${k} source ${s} is not a node kind`);
        assert.ok(NODE_KINDS.includes(d), `${k} target ${d} is not a node kind`);
      }
    }
  });
  test('validates in-signature and rejects out-of-signature', () => {
    assert.equal(isValidEdge('MAPS_TO_FIELD', 'Column', 'CodeField'), true);
    assert.equal(isValidEdge('MAPS_TO_FIELD', 'Table', 'CodeField'), false);
  });
  test('the D3->D4 join v2 was missing exists', () => {
    assert.equal(isValidEdge('CONTAINS', 'Module', 'File'), true);
  });
});

describe('sensitivity defaults', () => {
  test('every node kind has one', () => {
    for (const k of NODE_KINDS) assert.ok(DEFAULT_SENSITIVITY[k], `${k} has no default sensitivity`);
  });
  test('people and data default above internal', () => {
    assert.equal(DEFAULT_SENSITIVITY.Owner, 'restricted');
    assert.equal(DEFAULT_SENSITIVITY.Column, 'confidential');
  });
});

describe('extractor provenance ceiling is enforced', () => {
  const inferJoin: ExtractorManifest = {
    name: 'infer-join', version: '0.0.1', reads: [], net: false, env: [],
    memMb: 512, timeoutS: 60, provenanceCeiling: 'INFERRED', produces: [],
  };
  test('infer-join cannot claim EXTRACTED', () => {
    assert.throws(() => assertWithinCeiling(inferJoin, 'EXTRACTED'), /above its declared ceiling/);
  });
  test('infer-join may claim at or below its ceiling', () => {
    assert.doesNotThrow(() => assertWithinCeiling(inferJoin, 'INFERRED'));
    assert.doesNotThrow(() => assertWithinCeiling(inferJoin, 'LLM_SUGGESTED'));
  });
});
