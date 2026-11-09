/**
 * Property-based proof of the merge laws (v3 §7).
 *
 * v3 requires merge to be *proven* associative, commutative and idempotent over
 * randomized orderings, not spot-checked. The arbitraries below deliberately
 * draw ids from a small pool so that collisions — the only case where conflict
 * resolution actually runs — are the common case rather than a rarity.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import fc from 'fast-check';
import {
  PROVENANCE,
  type AuthoritativeScope,
  type NodeId,
  type NodeKind,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';

import {
  EMPTY_STATE,
  canonicalizeState,
  mergeBatches,
  mergeStates,
  type MergeBatch,
  type MergeState,
} from './state.ts';
import { applyRun, claimsOf } from './tombstone.ts';

const RUNS = 300;

const CODE_SCOPE: AuthoritativeScope = { scope: 'code', kinds: ['Symbol', 'File'] };
const DATA_SCOPE: AuthoritativeScope = { scope: 'data', kinds: ['Column'] };

const CODE_IDS = [
  ['Symbol', 'seamline:Symbol:pkg::A'],
  ['Symbol', 'seamline:Symbol:pkg::B'],
  ['Symbol', 'seamline:Symbol:pkg::C'],
  ['File', 'seamline:File:src/a.ts'],
  ['File', 'seamline:File:src/b.ts'],
] as const;

const DATA_IDS = [
  ['Column', 'seamline:Column:public.users.email'],
  ['Column', 'seamline:Column:public.users.id'],
] as const;

const arbRun = fc.constantFrom('r01', 'r02', 'r03', 'r04');
const arbProvenance = fc.constantFrom(...PROVENANCE);
const arbConfidence = fc.constantFrom(0.25, 0.5, 0.75, 1);
const arbProps = fc.dictionary(fc.constantFrom('a', 'b'), fc.constantFrom(1, 2, 'x', true), { maxKeys: 2 });

function arbNodeFrom(pool: ReadonlyArray<readonly [NodeKind, string]>): fc.Arbitrary<SeamlineNode> {
  return fc
    .record({
      entry: fc.constantFrom(...pool),
      provenance: arbProvenance,
      confidence: arbConfidence,
      props: arbProps,
      path: fc.option(fc.constantFrom('src/a.ts', 'src/b.ts'), { nil: undefined }),
      first: arbRun,
      last: arbRun,
      deletedAt: fc.option(arbRun, { nil: null }),
    })
    .map((r) => {
      const [kind, id] = r.entry;
      const base: SeamlineNode = {
        id: id as NodeId,
        kind,
        name: id.slice(id.indexOf(':', id.indexOf(':') + 1) + 1),
        sensitivity: 'internal',
        provenance: r.provenance,
        confidence: r.confidence,
        props: r.props,
        firstSeenRun: r.first,
        lastSeenRun: r.last,
        deletedAt: r.deletedAt,
      };
      return r.path === undefined ? base : { ...base, path: r.path };
    });
}

const arbCodeEdge: fc.Arbitrary<SeamlineEdge> = fc
  .record({
    src: fc.constantFrom(...CODE_IDS.filter(([k]) => k === 'File').map(([, id]) => id)),
    dst: fc.constantFrom(...CODE_IDS.filter(([k]) => k === 'Symbol').map(([, id]) => id)),
    provenance: arbProvenance,
    confidence: arbConfidence,
    props: arbProps,
    first: arbRun,
    last: arbRun,
    deletedAt: fc.option(arbRun, { nil: null }),
  })
  .map((r) => ({
    kind: 'CONTAINS' as const,
    src: r.src as NodeId,
    dst: r.dst as NodeId,
    provenance: r.provenance,
    confidence: r.confidence,
    props: r.props,
    firstSeenRun: r.first,
    lastSeenRun: r.last,
    deletedAt: r.deletedAt,
  }));

function arbBatch(options: { readonly codeOnly?: boolean; readonly allPass?: boolean } = {}): fc.Arbitrary<MergeBatch> {
  return fc
    .record({
      runId: arbRun,
      extractor: fc.constantFrom('extract-code-ts', 'extract-data', 'infer-join'),
      extractorPriority: fc.constantFrom(1, 5, 10),
      status: options.allPass === true
        ? fc.constant('PASS' as const)
        : fc.constantFrom('PASS' as const, 'PASS' as const, 'PASS' as const, 'FAIL' as const, 'UNAVAILABLE' as const),
      data: fc.boolean(),
      codeNodes: fc.array(arbNodeFrom(CODE_IDS), { maxLength: 4 }),
      dataNodes: fc.array(arbNodeFrom(DATA_IDS), { maxLength: 3 }),
      edges: fc.array(arbCodeEdge, { maxLength: 3 }),
    })
    .map((r) => {
      const isData = options.codeOnly === true ? false : r.data;
      return {
        runId: r.runId,
        extractor: r.extractor,
        extractorPriority: r.extractorPriority,
        status: r.status,
        scope: isData ? 'data' : 'code',
        authoritative: [isData ? DATA_SCOPE : CODE_SCOPE],
        nodes: isData ? r.dataNodes : r.codeNodes,
        edges: isData ? [] : r.edges,
      };
    });
}

const arbState: fc.Arbitrary<MergeState> = fc
  .array(arbBatch(), { maxLength: 5 })
  .map((batches) => mergeBatches(batches));

describe('merge is a commutative idempotent monoid', () => {
  test('associative: merge(merge(a, b), c) === merge(a, merge(b, c))', () => {
    fc.assert(
      fc.property(arbState, arbState, arbState, (a, b, c) => {
        assert.equal(
          canonicalizeState(mergeStates(mergeStates(a, b), c)),
          canonicalizeState(mergeStates(a, mergeStates(b, c))),
        );
      }),
      { numRuns: RUNS },
    );
  });

  test('commutative: merge(a, b) === merge(b, a)', () => {
    fc.assert(
      fc.property(arbState, arbState, (a, b) => {
        assert.equal(canonicalizeState(mergeStates(a, b)), canonicalizeState(mergeStates(b, a)));
      }),
      { numRuns: RUNS },
    );
  });

  test('idempotent: merge(a, a) === a', () => {
    fc.assert(
      fc.property(arbState, (a) => {
        assert.equal(canonicalizeState(mergeStates(a, a)), canonicalizeState(a));
      }),
      { numRuns: RUNS },
    );
  });

  test('the empty state is a two-sided identity', () => {
    fc.assert(
      fc.property(arbState, (a) => {
        assert.equal(canonicalizeState(mergeStates(a, EMPTY_STATE)), canonicalizeState(a));
        assert.equal(canonicalizeState(mergeStates(EMPTY_STATE, a)), canonicalizeState(a));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('the result does not depend on input order', () => {
  test('folding a run’s batches in any permutation yields the same state', () => {
    fc.assert(
      fc.property(fc.array(arbBatch(), { minLength: 2, maxLength: 5 }), (batches) => {
        const expected = canonicalizeState(mergeBatches(batches));
        const permutations = [
          [...batches].reverse(),
          [...batches].sort((x, y) => x.extractor.localeCompare(y.extractor)),
          [...batches.slice(1), batches[0]!],
        ];
        for (const p of permutations) {
          assert.equal(canonicalizeState(mergeBatches(p)), expected);
        }
      }),
      { numRuns: RUNS },
    );
  });

  test('grouping batches into two halves in any way yields the same state', () => {
    fc.assert(
      fc.property(
        fc.array(arbBatch(), { minLength: 2, maxLength: 5 }),
        fc.nat(),
        (batches, cut) => {
          const at = cut % (batches.length + 1);
          const left = mergeBatches(batches.slice(0, at));
          const right = mergeBatches(batches.slice(at));
          assert.equal(
            canonicalizeState(mergeStates(left, right)),
            canonicalizeState(mergeBatches(batches)),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });
});

describe('tombstoning is scope-confined', () => {
  test('nodes outside the authoritative scope are bit-identical before and after', () => {
    // Counted so the property cannot pass vacuously: a run that never sees an
    // out-of-scope node proves nothing about scope confinement.
    let outOfScopeChecked = 0;
    let buried = 0;
    fc.assert(
      fc.property(arbState, fc.array(arbBatch({ codeOnly: true }), { maxLength: 4 }), (prior, batches) => {
        const result = applyRun(prior, batches);
        buried += result.nodes.length;
        const claimedKinds = new Set(claimsOf(batches).flatMap((c) => [...c.scope.kinds]));
        for (const [id, before] of prior.nodes) {
          if (claimedKinds.has(before.node.kind)) continue;
          outOfScopeChecked += 1;
          assert.equal(
            result.state.nodes.get(id),
            before,
            `${id} is outside every claimed scope and must be untouched`,
          );
        }
      }),
      { numRuns: RUNS },
    );
    assert.ok(outOfScopeChecked > 0, 'the property never saw an out-of-scope node');
    assert.ok(buried > 0, 'the property never exercised the tombstoning path at all');
  });

  test('no run ever hard-deletes: every prior id is still present afterwards', () => {
    fc.assert(
      fc.property(arbState, fc.array(arbBatch(), { maxLength: 4 }), (prior, batches) => {
        const result = applyRun(prior, batches);
        for (const id of prior.nodes.keys()) {
          assert.ok(result.state.nodes.has(id), `${id} must be tombstoned, never removed`);
        }
        for (const key of prior.edges.keys()) {
          assert.ok(result.state.edges.has(key));
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('a non-PASS extractor changes no fact', () => {
  test('a run of only failed extractors leaves every node and edge exactly as it was', () => {
    let checkedNodes = 0;
    const arbFailed = arbBatch().map((b) => ({
      ...b,
      status: b.status === 'PASS' ? ('FAIL' as const) : b.status,
    }));
    fc.assert(
      fc.property(arbState, fc.array(arbFailed, { minLength: 1, maxLength: 4 }), (prior, batches) => {
        const result = applyRun(prior, batches);
        assert.deepEqual(result.nodes, []);
        assert.deepEqual(result.edges, []);
        assert.equal(result.state.nodes.size, prior.nodes.size);
        checkedNodes += prior.nodes.size;
        for (const [id, before] of prior.nodes) assert.equal(result.state.nodes.get(id), before);
        for (const [key, before] of prior.edges) assert.equal(result.state.edges.get(key), before);
      }),
      { numRuns: RUNS },
    );
    assert.ok(checkedNodes > 0, 'the property never saw a prior node to leave alone');
  });
});

describe('a tombstoned fact that reappears is resurrected', () => {
  test('deletedAt clears whenever a later PASS run re-emits the node', () => {
    fc.assert(
      fc.property(arbNodeFrom(CODE_IDS), (raw) => {
        const seed: SeamlineNode = { ...raw, firstSeenRun: 'r01', lastSeenRun: 'r01', deletedAt: null };
        const base: MergeBatch = {
          runId: 'r01',
          extractor: 'extract-code-ts',
          extractorPriority: 10,
          status: 'PASS',
          scope: 'code',
          authoritative: [CODE_SCOPE],
          nodes: [seed],
          edges: [],
        };
        const born = mergeBatches([base]);
        const buried = applyRun(born, [{ ...base, runId: 'r02', nodes: [] }]);
        assert.equal(buried.state.nodes.get(seed.id)?.node.deletedAt, 'r02');

        const back = applyRun(buried.state, [{ ...base, runId: 'r03', nodes: [seed] }]);
        const node = back.state.nodes.get(seed.id)?.node;
        assert.equal(node?.deletedAt, null, 'deletedAt must clear on re-insert');
        assert.equal(node?.firstSeenRun, 'r01');
        assert.equal(node?.lastSeenRun, 'r03');
      }),
      { numRuns: RUNS },
    );
  });
});
