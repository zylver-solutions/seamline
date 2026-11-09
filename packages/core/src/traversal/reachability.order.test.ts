import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EdgeKind, GraphView, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { makeEdge, makeNode } from '../store/testing.ts';
import { bfs, neighbours } from './reachability.ts';

// ---------------------------------------------------------------------------
// Order is a code-unit order, never a locale order (invariant 4).
//
// 'B' (0x42) < '_' (0x5F) < 'a' (0x61) < 'z' (0x7A) < U+00E4 (0xE4, a with diaeresis) by code unit.
// An en-US collation puts U+00E4 right after 'a' (`_ a U+00E4 B z`); a Swedish one puts it
// last (`_ a B z U+00E4`).
// ---------------------------------------------------------------------------

function memoryView(nodes: readonly SeamlineNode[], edges: readonly SeamlineEdge[]): GraphView {
  const byId = new Map<string, SeamlineNode>(nodes.map((n) => [n.id, n]));
  return {
    nodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    node: (id) => byId.get(id),
    edgesFrom: (id, kind) =>
      edges.filter((e) => e.src === id && (kind === undefined || e.kind === kind)),
    edgesTo: (id, kind) =>
      edges.filter((e) => e.dst === id && (kind === undefined || e.kind === kind)),
    scopeStatus: () => 'PASS',
  };
}

const FAN_OUT_NAMES = ['a', '\u00e4', 'B', 'z', '_x'] as const;
const FAN_OUT_IN_CODE_UNIT_ORDER = ['B', '_x', 'a', 'z', '\u00e4'] as const;

const idOf = (name: string): string => makeNode({ name, kind: 'Symbol' }).id;

function fanOut(): { readonly hub: SeamlineNode; readonly view: GraphView } {
  const hub = makeNode({ name: 'hub', kind: 'Symbol' });
  const leaves = FAN_OUT_NAMES.map((name) => makeNode({ name, kind: 'Symbol' }));
  const view = memoryView(
    [hub, ...leaves],
    leaves.map((leaf) => makeEdge({ src: hub.id, dst: leaf.id, kind: 'CALLS' })),
  );
  return { hub, view };
}

test('neighbours orders same-kind neighbours by code unit on the node id', () => {
  const { hub, view } = fanOut();
  const out = neighbours(view, hub.id, ['CALLS'], 'out');
  assert.deepEqual(
    out.map((n) => n.node.id),
    FAN_OUT_IN_CODE_UNIT_ORDER.map(idOf),
  );
});

test('neighbours orders by edge kind before node id', () => {
  const hub = makeNode({ name: 'hub', kind: 'Symbol' });
  const early = makeNode({ name: 'z', kind: 'Symbol' });
  const late = makeNode({ name: 'B', kind: 'Symbol' });
  const view = memoryView(
    [hub, early, late],
    [
      makeEdge({ src: hub.id, dst: late.id, kind: 'IMPORTS' }),
      makeEdge({ src: hub.id, dst: early.id, kind: 'CALLS' }),
    ],
  );
  const out = neighbours(view, hub.id, ['CALLS', 'IMPORTS'], 'out');
  assert.deepEqual(
    out.map((n) => `${n.edge.kind} ${n.node.id}`),
    [`CALLS ${early.id}`, `IMPORTS ${late.id}`],
  );
});

test('bfs keeps the code-unit-first nodes when the node cap bites', () => {
  const { hub, view } = fanOut();
  const capped = bfs(view, [hub.id], ['CALLS'] as readonly EdgeKind[], {
    maxDepth: 2,
    maxNodes: 3,
  });
  // The cap keeps the first three neighbours in traversal order, so the order decides WHICH nodes survive.
  assert.deepEqual(
    capped.reached.map((r) => r.node.id),
    ['B', '_x', 'a'].map(idOf),
  );
  assert.equal(capped.state.truncated, true);
});

test('bfs lists the edges it returns by dst, then by src, in code-unit order', () => {
  const { hub, view } = fanOut();
  const full = bfs(view, [hub.id], ['CALLS'] as readonly EdgeKind[], { maxDepth: 2, maxNodes: 10 });
  assert.deepEqual(
    full.edges.map((e) => e.dst),
    FAN_OUT_IN_CODE_UNIT_ORDER.map(idOf),
  );

  const hubs = ['a', 'B', '_x'].map((name) => makeNode({ name, kind: 'Symbol' }));
  const target = makeNode({ name: 'target', kind: 'Symbol' });
  const converging = memoryView(
    [...hubs, target],
    hubs.map((h) => makeEdge({ src: h.id, dst: target.id, kind: 'CALLS' })),
  );
  const result = bfs(
    converging,
    hubs.map((h) => h.id),
    ['CALLS'] as readonly EdgeKind[],
    { maxDepth: 1, maxNodes: 10 },
  );
  assert.deepEqual(
    result.edges.map((e) => e.src),
    ['B', '_x', 'a'].map(idOf),
  );
});
