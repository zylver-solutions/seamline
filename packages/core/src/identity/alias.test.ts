import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isValidEdge, type NodeId, type SeamlineEdge } from '@seamline/ontology';

import {
  AliasTable,
  MAX_ALIAS_CHAIN,
  materializeAliases,
  preferAlias,
  rewriteEdges,
  type AliasRow,
} from './alias.ts';
import { fileName, makeNodeId, symbolName } from './canonical.ts';

const REPO = 'seamline';

function fileId(path: string): NodeId {
  return makeNodeId(REPO, 'File', fileName(path));
}

function symbolId(qualified: string[]): NodeId {
  return makeNodeId(REPO, 'Symbol', symbolName({ module: '@seamline/core', qualifiedName: qualified }));
}

function row(from: NodeId, to: NodeId, over: Partial<AliasRow> = {}): AliasRow {
  return { from, to, runId: 'r01', confidence: 0.9, reason: 'git-rename', ...over };
}

describe('AliasTable.resolve', () => {
  test('follows a multi-hop chain to the current id', () => {
    const t = AliasTable.from([
      row(fileId('a.ts'), fileId('b.ts')),
      row(fileId('b.ts'), fileId('c.ts')),
      row(fileId('c.ts'), fileId('d.ts')),
    ]);
    const r = t.resolve(fileId('a.ts'));
    assert.equal(r.id, fileId('d.ts'));
    assert.equal(r.hops, 3);
    assert.equal(r.terminatedBy, 'terminal');
    assert.deepEqual(r.chain, [fileId('a.ts'), fileId('b.ts'), fileId('c.ts'), fileId('d.ts')]);
  });

  test('an unknown id resolves to itself in zero hops', () => {
    const t = new AliasTable();
    const id = fileId('never/renamed.ts');
    assert.equal(t.resolveId(id), id);
    assert.equal(t.resolve(id).hops, 0);
  });

  test('a rename loop terminates and picks a deterministic representative', () => {
    const t = AliasTable.from([
      row(fileId('a.ts'), fileId('b.ts')),
      row(fileId('b.ts'), fileId('c.ts')),
      row(fileId('c.ts'), fileId('a.ts')),
    ]);
    for (const start of ['a.ts', 'b.ts', 'c.ts']) {
      const r = t.resolve(fileId(start));
      assert.equal(r.terminatedBy, 'cycle');
      // Every entry point into the loop lands on the same member.
      assert.equal(r.id, fileId('a.ts'));
      assert.ok(r.hops <= 3);
    }
  });

  test('a two-node ping-pong rename terminates', () => {
    const t = AliasTable.from([row(fileId('a.ts'), fileId('b.ts')), row(fileId('b.ts'), fileId('a.ts'))]);
    const r = t.resolve(fileId('b.ts'));
    assert.equal(r.terminatedBy, 'cycle');
    assert.equal(r.id, fileId('a.ts'));
  });

  test('a chain longer than MAX_ALIAS_CHAIN stops at the bound', () => {
    const t = new AliasTable();
    const total = MAX_ALIAS_CHAIN + 10;
    for (let i = 0; i < total; i += 1) {
      t.add(row(fileId(`f${String(i)}.ts`), fileId(`f${String(i + 1)}.ts`)));
    }
    const r = t.resolve(fileId('f0.ts'));
    assert.equal(r.terminatedBy, 'depth');
    assert.equal(r.hops, MAX_ALIAS_CHAIN);
    assert.equal(r.id, fileId(`f${String(MAX_ALIAS_CHAIN)}.ts`));
  });
});

describe('AliasTable.add', () => {
  test('refuses a self-alias, an out-of-range confidence, and a cross-kind or cross-repo mapping', () => {
    const t = new AliasTable();
    assert.throws(() => t.add(row(fileId('a.ts'), fileId('a.ts'))), /must differ/);
    assert.throws(() => t.add(row(fileId('a.ts'), fileId('b.ts'), { confidence: 1.5 })), /within \[0, 1\]/);
    assert.throws(
      () => t.add(row(fileId('a.ts'), symbolId(['A']))),
      /same kind/,
    );
    assert.throws(
      () => t.add(row(fileId('a.ts'), makeNodeId('other', 'File', 'b.ts'))),
      /within one repo/,
    );
  });

  test('refuses a kind ALIAS_OF has no declared range for', () => {
    const t = new AliasTable();
    assert.equal(isValidEdge('ALIAS_OF', 'Alias', 'Table'), false);
    assert.throws(
      () => t.add(row(makeNodeId(REPO, 'Table', 'public.a'), makeNodeId(REPO, 'Table', 'public.b'))),
      /no declared range for Table/,
    );
  });

  test('a conflicting mapping resolves the same way regardless of insertion order', () => {
    const a = row(fileId('a.ts'), fileId('b.ts'), { confidence: 0.6 });
    const b = row(fileId('a.ts'), fileId('c.ts'), { confidence: 0.95 });
    const forward = AliasTable.from([a, b]);
    const backward = AliasTable.from([b, a]);
    assert.equal(forward.resolveId(fileId('a.ts')), fileId('c.ts'));
    assert.deepEqual(forward.rows(), backward.rows());
    assert.equal(preferAlias(a, b), b);
    assert.equal(preferAlias(b, a), b);
  });
});

describe('materializeAliases', () => {
  test('emits contract-valid Alias nodes and ALIAS_OF edges pointing at the current id', () => {
    const t = AliasTable.from([
      row(fileId('old/a.ts'), fileId('mid/a.ts')),
      row(fileId('mid/a.ts'), fileId('new/a.ts')),
    ]);
    const { nodes, edges } = materializeAliases(t, 'r02');
    assert.equal(nodes.length, 2);
    assert.equal(edges.length, 2);
    for (const n of nodes) {
      assert.equal(n.kind, 'Alias');
      assert.equal(n.deletedAt, null);
      assert.equal(n.provenance, 'EXTRACTED');
      assert.equal(n.lastSeenRun, 'r02');
    }
    for (const e of edges) {
      assert.equal(e.kind, 'ALIAS_OF');
      assert.ok(isValidEdge('ALIAS_OF', 'Alias', 'File'));
      // Both hops of the chain point at the *fully resolved* current id.
      assert.equal(e.dst, fileId('new/a.ts'));
    }
    assert.equal(nodes[0]?.id, makeNodeId(REPO, 'Alias', 'File::mid/a.ts'));
  });

  test('a declared alias carries DECLARED provenance, not EXTRACTED', () => {
    const t = AliasTable.from([row(fileId('a.ts'), fileId('b.ts'), { reason: 'declared', confidence: 1 })]);
    const { nodes, edges } = materializeAliases(t, 'r01');
    assert.equal(nodes[0]?.provenance, 'DECLARED');
    assert.equal(edges[0]?.provenance, 'DECLARED');
  });
});

describe('rewriteEdges', () => {
  test('maps retired endpoints onto current ids and leaves unaffected edges untouched', () => {
    const t = AliasTable.from([row(fileId('src/a.ts'), fileId('lib/a.ts'))]);
    const stale: SeamlineEdge = {
      kind: 'CONTAINS',
      src: fileId('src/a.ts'),
      dst: symbolId(['A']),
      provenance: 'EXTRACTED',
      confidence: 1,
      props: {},
      firstSeenRun: 'r01',
      lastSeenRun: 'r01',
      deletedAt: null,
    };
    const untouched: SeamlineEdge = { ...stale, src: fileId('src/b.ts') };
    const [rewritten, same] = rewriteEdges(t, [stale, untouched]);
    assert.equal(rewritten?.src, fileId('lib/a.ts'));
    assert.equal(rewritten?.dst, stale.dst);
    // No alias applies, so the edge object itself is returned by reference.
    assert.equal(same, untouched);
  });
});
