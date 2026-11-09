import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { edgeKey, type NodeId, type SeamlineEdge, type SeamlineNode } from '@seamline/ontology';

import { canonicalJson, compareStrings } from './serialize.ts';
import {
  EMPTY_STATE,
  canonicalizeState,
  liveEdges,
  mergeBatches,
  mergeScopeStatus,
  mergeStates,
  stateFromBatch,
  type MergeBatch,
} from './state.ts';

const SYM = 'seamline:Symbol:pkg::A' as NodeId;
const FILE = 'seamline:File:src/a.ts' as NodeId;

function node(over: Partial<SeamlineNode> = {}): SeamlineNode {
  return {
    id: SYM,
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

function batch(over: Partial<MergeBatch> = {}): MergeBatch {
  return {
    runId: 'r01',
    extractor: 'extract-code-ts',
    extractorPriority: 10,
    status: 'PASS',
    scope: 'code',
    authoritative: [{ scope: 'code', kinds: ['Symbol'] }],
    nodes: [],
    edges: [],
    ...over,
  };
}

describe('canonicalJson', () => {
  test('sorts keys, omits undefined, and normalizes negative zero', () => {
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
    assert.equal(canonicalJson({ n: -0 }), '{"n":0}');
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
    assert.equal(canonicalJson({ nested: { z: 1, a: { y: 2, b: 3 } } }), '{"nested":{"a":{"b":3,"y":2},"z":1}}');
  });

  test('refuses a non-finite number rather than emitting null', () => {
    assert.throws(() => canonicalJson({ n: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalJson({ n: Number.POSITIVE_INFINITY }), /non-finite/);
  });

  test('compareStrings is code-unit ordering, never locale-aware', () => {
    assert.equal(compareStrings('Z', 'a') < 0, true);
    assert.equal(compareStrings('a', 'a'), 0);
  });
});

describe('the winner takes its body whole', () => {
  test('props are not spliced together across provenance levels', () => {
    const extracted = node({ provenance: 'EXTRACTED', props: { type: 'string' } });
    const inferred = node({ provenance: 'INFERRED', props: { type: 'number', guess: true } });
    const merged = mergeBatches([
      batch({ nodes: [inferred], extractor: 'infer-join', extractorPriority: 1 }),
      batch({ nodes: [extracted] }),
    ]);
    const winner = merged.nodes.get(SYM);
    assert.deepEqual(winner?.node.props, { type: 'string' });
    assert.equal(winner?.source.extractor, 'extract-code-ts');
    assert.equal('guess' in (winner?.node.props ?? {}), false, 'no composite fact may be synthesized');
  });

  test('the losing fact still advances the lifecycle', () => {
    const early = node({ provenance: 'EXTRACTED', firstSeenRun: 'r01', lastSeenRun: 'r01' });
    const lateInferred = node({ provenance: 'INFERRED', firstSeenRun: 'r05', lastSeenRun: 'r05' });
    const merged = mergeStates(
      stateFromBatch(batch({ runId: 'r01', nodes: [early] })),
      stateFromBatch(batch({ runId: 'r05', extractor: 'infer-join', nodes: [lateInferred] })),
    );
    const winner = merged.nodes.get(SYM);
    assert.equal(winner?.node.provenance, 'EXTRACTED');
    assert.equal(winner?.node.firstSeenRun, 'r01');
    assert.equal(winner?.node.lastSeenRun, 'r05');
  });
});

describe('edges are keyed by (scope, src, dst, kind)', () => {
  test('the same edge in two scopes is two rows, not one conflict', () => {
    const e: SeamlineEdge = {
      kind: 'CONTAINS',
      src: FILE,
      dst: SYM,
      provenance: 'EXTRACTED',
      confidence: 1,
      props: {},
      firstSeenRun: 'r01',
      lastSeenRun: 'r01',
      deletedAt: null,
    };
    const merged = mergeBatches([
      batch({ scope: 'code', edges: [e] }),
      batch({ scope: 'contracts', extractor: 'extract-contracts', edges: [e] }),
    ]);
    assert.equal(merged.edges.size, 2);
    assert.ok(merged.edges.has(edgeKey('code', e)));
    assert.ok(merged.edges.has(edgeKey('contracts', e)));
    assert.equal(liveEdges(merged).length, 2);
  });
});

describe('mergeScopeStatus', () => {
  test('a later run replaces an earlier verdict in either argument order', () => {
    const oldPass = { scope: 'code', status: 'PASS' as const, runId: 'r01' };
    const newFail = { scope: 'code', status: 'FAIL' as const, runId: 'r02' };
    assert.deepEqual(mergeScopeStatus(oldPass, newFail), newFail);
    assert.deepEqual(mergeScopeStatus(newFail, oldPass), newFail);
  });

  test('within one run the worse verdict wins, so UNAVAILABLE is never PASS', () => {
    const pass = { scope: 'code', status: 'PASS' as const, runId: 'r02' };
    const unavailable = { scope: 'code', status: 'UNAVAILABLE' as const, runId: 'r02' };
    assert.deepEqual(mergeScopeStatus(pass, unavailable), unavailable);
    assert.deepEqual(mergeScopeStatus(unavailable, pass), unavailable);
  });
});

describe('canonicalizeState', () => {
  test('is stable under insertion order and distinguishes different states', () => {
    const a = node({ id: SYM });
    const b = node({ id: FILE, kind: 'File', name: 'src/a.ts' });
    const forward = mergeBatches([batch({ nodes: [a] }), batch({ nodes: [b] })]);
    const backward = mergeBatches([batch({ nodes: [b] }), batch({ nodes: [a] })]);
    assert.equal(canonicalizeState(forward), canonicalizeState(backward));
    assert.notEqual(canonicalizeState(forward), canonicalizeState(EMPTY_STATE));
  });

  test('rejects a batch with no runId or no scope rather than merging it silently', () => {
    assert.throws(() => stateFromBatch(batch({ runId: '' })), /runId must not be empty/);
    assert.throws(() => stateFromBatch(batch({ scope: '' })), /scope must not be empty/);
  });
});
