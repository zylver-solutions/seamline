import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  edgeKey,
  type AuthoritativeScope,
  type NodeId,
  type NodeKind,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';

import {
  EMPTY_STATE,
  liveNodes,
  mergeBatches,
  sourceOf,
  type MergeBatch,
  type MergeState,
} from './state.ts';
import { SelectorError } from '../store/scope-selector.ts';
import {
  applyRestartedRun,
  applyRun,
  claimsOf,
  globMatch,
  scopeCoversEdge,
  scopeCoversNode,
} from './tombstone.ts';

const CODE_SCOPE: AuthoritativeScope = { scope: 'code', kinds: ['Symbol', 'File'] };
const DATA_SCOPE: AuthoritativeScope = { scope: 'data', kinds: ['Column', 'Table'] };

function node(kind: NodeKind, name: string, over: Partial<SeamlineNode> = {}): SeamlineNode {
  return {
    id: `seamline:${kind}:${name}` as NodeId,
    kind,
    name,
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

function edge(src: SeamlineNode, dst: SeamlineNode): SeamlineEdge {
  return {
    kind: 'CONTAINS',
    src: src.id,
    dst: dst.id,
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: 'r01',
    lastSeenRun: 'r01',
    deletedAt: null,
  };
}

function batch(over: Partial<MergeBatch> = {}): MergeBatch {
  return {
    runId: 'r01',
    extractor: 'extract-code-ts',
    extractorPriority: 10,
    status: 'PASS',
    scope: 'code',
    authoritative: [CODE_SCOPE],
    nodes: [],
    edges: [],
    ...over,
  };
}

const fileA = node('File', 'src/a.ts', { path: 'src/a.ts' });
const symA = node('Symbol', 'pkg::A', { path: 'src/a.ts' });
const symB = node('Symbol', 'pkg::B', { path: 'src/b.ts' });
const colEmail = node('Column', 'public.users.email');

function priorState(): MergeState {
  return mergeBatches([
    batch({ nodes: [fileA, symA, symB], edges: [edge(fileA, symA)] }),
    batch({
      extractor: 'extract-data',
      scope: 'data',
      authoritative: [DATA_SCOPE],
      nodes: [colEmail],
    }),
  ]);
}

describe('a non-PASS extractor tombstones nothing', () => {
  for (const status of ['FAIL', 'UNAVAILABLE'] as const) {
    test(`status ${status} contributes no facts and claims no authority`, () => {
      const prior = priorState();
      const crashed = batch({ runId: 'r02', status, nodes: [], edges: [] });
      assert.deepEqual(claimsOf([crashed]), []);

      const result = applyRun(prior, [crashed]);
      assert.deepEqual(result.nodes, [], 'no node may be tombstoned by a crashed extractor');
      assert.deepEqual(result.edges, []);
      assert.equal(liveNodes(result.state).length, liveNodes(prior).length);
      for (const [id, before] of prior.nodes) {
        assert.equal(result.state.nodes.get(id), before, `${id} must be untouched`);
      }
      assert.equal(result.skipped.length, 1);
      assert.match(result.skipped[0]?.reason ?? '', new RegExp(status));
    });
  }

  test('a crashed extractor does not even contribute the facts it managed to emit', () => {
    const partial = node('Symbol', 'pkg::HalfWritten');
    const result = applyRun(EMPTY_STATE, [batch({ status: 'FAIL', nodes: [partial] })]);
    assert.equal(result.state.nodes.size, 0);
    assert.equal(result.state.scopes.get('code')?.status, 'FAIL');
  });

  test('a PASS run alongside a crashed one still buries only what it is authoritative for', () => {
    const prior = priorState();
    const result = applyRun(prior, [
      batch({ runId: 'r02', nodes: [fileA, symA], edges: [edge(fileA, symA)] }),
      batch({
        runId: 'r02',
        extractor: 'extract-data',
        scope: 'data',
        authoritative: [DATA_SCOPE],
        status: 'FAIL',
      }),
    ]);
    assert.deepEqual(result.nodes, [symB.id], 'only the vanished Symbol is buried');
    assert.equal(result.state.nodes.get(colEmail.id)?.node.deletedAt, null);
  });
});

describe('tombstoning is confined to the declared authoritative scope', () => {
  test('a code extractor never buries a database column', () => {
    const prior = priorState();
    const result = applyRun(prior, [
      batch({ runId: 'r02', nodes: [fileA, symA], edges: [edge(fileA, symA)] }),
    ]);
    assert.deepEqual(result.nodes, [symB.id]);
    // Out of scope, so untouched down to object identity.
    assert.equal(result.state.nodes.get(colEmail.id), prior.nodes.get(colEmail.id));
  });

  test('a selector narrows the scope within a kind', () => {
    const scoped: AuthoritativeScope = { scope: 'code', kinds: ['Symbol'], selector: 'src/a*' };
    const prior = priorState();
    const result = applyRun(prior, [
      batch({ runId: 'r02', authoritative: [scoped], nodes: [], edges: [] }),
    ]);
    assert.deepEqual(result.nodes, [symA.id], 'only the selected path is in scope');
    assert.equal(result.state.nodes.get(symB.id), prior.nodes.get(symB.id));
    assert.equal(scopeCoversNode(scoped, symA), true);
    assert.equal(scopeCoversNode(scoped, symB), false);
    assert.equal(scopeCoversNode(scoped, fileA), false, 'kind must match too');
  });

  test('a selector means here what it means to the store: braces, and a leading **/ at the root', () => {
    const scoped: AuthoritativeScope = {
      scope: 'code',
      kinds: ['File'],
      selector: '**/*.{ts,tsx}',
    };
    assert.equal(scopeCoversNode(scoped, fileA), true);
    assert.equal(
      scopeCoversNode(scoped, node('File', 'a.ts', { path: 'a.ts' })),
      true,
      'root level',
    );
    assert.equal(scopeCoversNode(scoped, node('File', 'README.md', { path: 'README.md' })), false);
    assert.throws(
      () => scopeCoversNode({ ...scoped, selector: 'prose, not a path' }, fileA),
      SelectorError,
    );
  });

  test('a node with no path is never claimed by a selector, even when its name would match', () => {
    const scoped: AuthoritativeScope = { scope: 'code', kinds: ['Symbol'], selector: 'src/*.ts' };
    const nameless = node('Symbol', 'src/ghost.ts');
    assert.equal(scopeCoversNode(scoped, nameless), false);
    assert.equal(
      scopeCoversNode({ scope: 'code', kinds: ['Symbol'] }, nameless),
      true,
      'no selector: kind alone',
    );

    const prior = mergeBatches([
      batch({ authoritative: [scoped], nodes: [nameless, symA], edges: [] }),
    ]);
    const result = applyRun(prior, [
      batch({ runId: 'r02', authoritative: [scoped], nodes: [], edges: [] }),
    ]);
    assert.deepEqual(result.nodes, [symA.id], 'only the node with a matching path is buried');
    assert.equal(result.state.nodes.get(nameless.id), prior.nodes.get(nameless.id));
  });

  test('a selector narrows edges as it narrows nodes: the edges of a file the run did not read are untouched', () => {
    const scoped: AuthoritativeScope = {
      scope: 'code',
      kinds: ['Symbol', 'File'],
      selector: 'src/a.ts',
    };
    const fileB = node('File', 'src/b.ts', { path: 'src/b.ts' });
    const inA: SeamlineEdge = { ...edge(fileA, symA), srcFile: 'src/a.ts', dstFile: 'src/a.ts' };
    const inB: SeamlineEdge = { ...edge(fileB, symB), srcFile: 'src/b.ts', dstFile: 'src/b.ts' };
    const prior = mergeBatches([batch({ nodes: [fileA, fileB, symA, symB], edges: [inA, inB] })]);

    const result = applyRun(prior, [
      batch({ runId: 'r02', authoritative: [scoped], nodes: [fileA, symA], edges: [] }),
    ]);
    assert.deepEqual(result.nodes, [], 'b.ts nodes are outside the claim');
    assert.deepEqual(
      result.edges,
      [edgeKey('code', inA)],
      'only the edge of the claimed file is buried',
    );
    assert.equal(
      result.state.edges.get(edgeKey('code', inB)),
      prior.edges.get(edgeKey('code', inB)),
      'the excluded file edge is untouched down to object identity',
    );
  });

  test('an edge is placed by its source file, else its destination file, else by no file at all', () => {
    const scoped: AuthoritativeScope = { scope: 'code', kinds: ['File'], selector: 'src/a.ts' };
    const base = edge(fileA, symA);
    assert.equal(
      scopeCoversEdge(scoped, 'code', { ...base, srcFile: 'src/a.ts', dstFile: 'src/b.ts' }),
      true,
    );
    assert.equal(
      scopeCoversEdge(scoped, 'code', { ...base, srcFile: 'src/b.ts', dstFile: 'src/a.ts' }),
      false,
    );
    assert.equal(
      scopeCoversEdge(scoped, 'code', { ...base, dstFile: 'src/a.ts' }),
      true,
      'destination stands in',
    );
    assert.equal(scopeCoversEdge(scoped, 'code', base), false, 'no file: outside every selector');
    assert.equal(
      scopeCoversEdge(scoped, 'data', { ...base, srcFile: 'src/a.ts' }),
      false,
      'another scope',
    );
    assert.equal(
      scopeCoversEdge({ scope: 'code', kinds: ['File'] }, 'code', base),
      true,
      'no selector: scope alone',
    );
  });

  test('a selector over no node kinds is a label, so its claim covers the whole edge scope', () => {
    const label: AuthoritativeScope = {
      scope: 'joins',
      kinds: [],
      selector: 'MAPS_TO_FIELD|BACKED_BY',
    };
    const prior = mergeBatches([
      batch({ scope: 'joins', authoritative: [label], nodes: [], edges: [edge(fileA, symA)] }),
    ]);
    const key = edgeKey('joins', edge(fileA, symA));
    // `mergeBatches` keys an edge by its batch scope; the claim is of that scope.
    assert.ok(prior.edges.has(key));
    const result = applyRun(prior, [
      batch({ runId: 'r02', scope: 'joins', authoritative: [label] }),
    ]);
    assert.deepEqual(result.edges, [key]);
  });

  test('an edge is buried by the scope it is stored under, not by its endpoints', () => {
    const prior = priorState();
    const result = applyRun(prior, [batch({ runId: 'r02', nodes: [fileA, symA], edges: [] })]);
    const key = edgeKey('code', edge(fileA, symA));
    assert.deepEqual(result.edges, [key]);
    assert.equal(result.state.edges.get(key)?.edge.deletedAt, 'r02');
  });
});

describe('nothing is ever hard-deleted', () => {
  test('a vanished node is retained with deletedAt set, and stops being returned', () => {
    const prior = priorState();
    const result = applyRun(prior, [
      batch({ runId: 'r02', nodes: [fileA, symA], edges: [edge(fileA, symA)] }),
    ]);
    const buried = result.state.nodes.get(symB.id);
    assert.ok(buried !== undefined, 'the row is retained, not removed');
    assert.equal(buried.node.deletedAt, 'r02');
    assert.equal(buried.node.firstSeenRun, 'r01', 'history is preserved');
    assert.ok(!liveNodes(result.state).some((n) => n.id === symB.id));
  });

  test('a resurrected node clears deletedAt and keeps its original firstSeenRun', () => {
    const prior = priorState();
    const afterDeath = applyRun(prior, [
      batch({ runId: 'r02', nodes: [fileA, symA], edges: [edge(fileA, symA)] }),
    ]);
    assert.equal(afterDeath.state.nodes.get(symB.id)?.node.deletedAt, 'r02');

    const afterReturn = applyRun(afterDeath.state, [
      batch({ runId: 'r03', nodes: [fileA, symA, symB], edges: [edge(fileA, symA)] }),
    ]);
    const resurrected = afterReturn.state.nodes.get(symB.id);
    assert.equal(resurrected?.node.deletedAt, null, 'deletedAt must be cleared on re-insert');
    assert.equal(resurrected?.node.firstSeenRun, 'r01');
    assert.equal(resurrected?.node.lastSeenRun, 'r03');
    assert.ok(liveNodes(afterReturn.state).some((n) => n.id === symB.id));
  });
});

describe('scope status', () => {
  test('a later run replaces an earlier status, and within a run the worse one wins', () => {
    const first = applyRun(EMPTY_STATE, [batch({ runId: 'r01', status: 'PASS' })]);
    assert.equal(first.state.scopes.get('code')?.status, 'PASS');

    const second = applyRun(first.state, [
      batch({ runId: 'r02', status: 'PASS' }),
      batch({ runId: 'r02', extractor: 'other', status: 'UNAVAILABLE' }),
    ]);
    assert.equal(second.state.scopes.get('code')?.status, 'UNAVAILABLE');

    const third = applyRun(second.state, [batch({ runId: 'r03', status: 'PASS' })]);
    assert.equal(third.state.scopes.get('code')?.status, 'PASS');
  });
});

describe('globMatch', () => {
  test('* stays inside a segment and ** crosses separators', () => {
    assert.equal(globMatch('src/*', 'src/a.ts'), true);
    assert.equal(globMatch('src/*', 'src/nested/a.ts'), false);
    assert.equal(globMatch('src/**', 'src/nested/a.ts'), true);
    assert.equal(globMatch('src/?.ts', 'src/a.ts'), true);
    assert.equal(globMatch('src/?.ts', 'src/ab.ts'), false);
    assert.equal(globMatch('a.b', 'axb'), false, 'a literal dot must not act as a wildcard');
  });
});

describe('applyRestartedRun: a second attempt at a run id the state already holds', () => {
  const stamp = (state: MergeState, n: SeamlineNode): string | null =>
    state.nodes.get(n.id)?.node.lastSeenRun ?? null;

  test('buries what the attempt does not re-emit, though the earlier attempt stamped it with the same run id', () => {
    const prior = priorState();
    // applyRun alone cannot tell the earlier attempt's sighting of symB from this one's.
    assert.deepEqual(
      applyRun(prior, [batch({ nodes: [fileA, symA] })]).nodes,
      [],
      'applyRun, for a new run id, would not bury symB under the same id',
    );

    const result = applyRestartedRun(prior, 'r01', [batch({ nodes: [fileA, symA] })]);
    assert.deepEqual(result.nodes, [symB.id]);
    assert.notEqual(result.state.nodes.get(symB.id)?.node.deletedAt, null);
    assert.deepEqual(
      [fileA, symA].map((n) => stamp(result.state, n)),
      ['r01', 'r01'],
    );
  });

  test('an entry outside every PASS claim keeps the stamp it had, and one that was never seen is not stamped as seen', () => {
    // A live entry whose last sighting is empty ("never seen", lifecycle.ts) exists
    // in a state someone built by hand. A restart did not set it aside, so it is
    // not the restart's to settle.
    const ghost = node('Column', 'public.users.ghost', { firstSeenRun: '', lastSeenRun: '' });
    const base = priorState();
    const prior: MergeState = {
      nodes: new Map([...base.nodes, [ghost.id, { node: ghost, source: sourceOf(batch()) }]]),
      edges: base.edges,
      scopes: base.scopes,
    };

    // The attempt claims only the code scope; colEmail and ghost are in the data scope.
    const result = applyRestartedRun(prior, 'r01', [batch({ nodes: [fileA, symA, symB] })]);
    assert.deepEqual(result.nodes, []);
    assert.equal(stamp(result.state, colEmail), 'r01', 'set aside, never claimed: stamp back');
    assert.equal(stamp(result.state, ghost), '', 'never set aside: left as it was');
    assert.equal(result.state.nodes.get(ghost.id)?.node.deletedAt, null);
  });

  test('a FAIL attempt buries nothing and leaves every stamp as it was', () => {
    const prior = priorState();
    const result = applyRestartedRun(prior, 'r01', [
      batch({ status: 'FAIL', nodes: [fileA] }),
      batch({
        extractor: 'extract-data',
        scope: 'data',
        authoritative: [DATA_SCOPE],
        status: 'UNAVAILABLE',
      }),
    ]);
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(
      [fileA, symA, symB, colEmail].map((n) => stamp(result.state, n)),
      ['r01', 'r01', 'r01', 'r01'],
    );
  });
});
