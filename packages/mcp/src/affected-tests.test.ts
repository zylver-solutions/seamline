import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EDGE_SIGNATURES,
  type EdgeKind,
  type NodeId,
  type NodeKind,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import {
  CONTAINS_PAIRS,
  DEPENDENT_EDGE_KINDS,
  findAffectedTests,
  JOIN_EDGE_KINDS,
} from './affected-tests.ts';
import { makeEdge, makeNode, memoryView } from './testing.ts';

const fact = (kind: EdgeKind, src: SeamlineNode, dst: SeamlineNode): SeamlineEdge =>
  makeEdge({ kind, src: src.id, dst: dst.id, provenance: 'EXTRACTED', confidence: 1 });

const node = (kind: NodeKind, canonicalName: string): SeamlineNode =>
  makeNode({ kind, canonicalName });

const OPTS = { maxDepth: 4, maxNodes: 1000 } as const;

/** The walked edge kinds, written out here on purpose: the tests below pin the implementation to them. */
const DEPENDENT: readonly EdgeKind[] = [
  'CALLS',
  'EXTENDS',
  'IMPLEMENTS',
  'USES_TYPE',
  'IMPORTS',
  'QUERIES',
  'HANDLES_ROUTE',
  'DECORATED_WITH',
];
const JOIN: readonly EdgeKind[] = [
  'MAPS_TO_FIELD',
  'BACKED_BY',
  'EXPOSED_AS',
  'VALIDATED_BY',
  'PERSISTED_IN',
  'STORED_IN',
  'FK_TO',
  'IMPLEMENTED_BY',
];
const PAIRS: ReadonlyArray<readonly [NodeKind, NodeKind]> = [
  ['File', 'Symbol'],
  ['Symbol', 'CodeField'],
  ['Symbol', 'Parameter'],
  ['Table', 'Column'],
  ['Contract', 'Operation'],
  ['Contract', 'SchemaProperty'],
  ['Entity', 'DomainProperty'],
];

const reached = (
  nodes: readonly SeamlineNode[],
  edges: readonly SeamlineEdge[],
  root: SeamlineNode,
  maxDepth = 6,
): ReadonlySet<string> =>
  new Set(
    findAffectedTests(memoryView(nodes, edges), [root.id], { maxDepth, maxNodes: 1000 }).reached,
  );

// ---------------------------------------------------------------------------
// The walked edge set, entry by entry
// ---------------------------------------------------------------------------

test('the walked edge kinds and CONTAINS pairs are exactly the documented ones', () => {
  assert.deepEqual([...DEPENDENT_EDGE_KINDS].sort(), [...DEPENDENT].sort());
  assert.deepEqual([...JOIN_EDGE_KINDS].sort(), [...JOIN].sort());
  assert.deepEqual(
    CONTAINS_PAIRS.map((p) => p.join('/')).sort(),
    PAIRS.map((p) => p.join('/')).sort(),
  );
});

for (const kind of DEPENDENT) {
  for (const [srcKind, dstKind] of EDGE_SIGNATURES[kind]) {
    test(`${kind} (${srcKind} to ${dstKind}): a change to the destination reaches the source, and not the reverse`, () => {
      const src = node(srcKind, 'dependent');
      const dst = node(dstKind, 'dependency');
      const edges = [fact(kind, src, dst)];
      assert.ok(reached([src, dst], edges, dst).has(src.id), 'dependents are reached');
      assert.ok(!reached([src, dst], edges, src).has(dst.id), 'dependencies are not');
    });
  }
}

for (const kind of JOIN) {
  for (const [aKind, bKind] of EDGE_SIGNATURES[kind]) {
    test(`${kind} (${aKind} to ${bKind}): a join is walked both ways`, () => {
      const a = node(aKind, 'left');
      const b = node(bKind, 'right');
      const edges = [fact(kind, a, b)];
      assert.ok(reached([a, b], edges, a).has(b.id), 'forwards');
      assert.ok(reached([a, b], edges, b).has(a.id), 'backwards');
    });
  }
}

for (const [parentKind, childKind] of PAIRS) {
  test(`CONTAINS (${parentKind} to ${childKind}): crossed down from the parent and up from the member`, () => {
    const parent = node(parentKind, 'parent');
    const child = node(childKind, 'member');
    const edges = [fact('CONTAINS', parent, child)];
    assert.ok(reached([parent, child], edges, parent).has(child.id), 'down');
    assert.ok(reached([parent, child], edges, child).has(parent.id), 'up');
  });
}

for (const [parentKind, childKind] of EDGE_SIGNATURES.CONTAINS) {
  if (PAIRS.some(([p, c]) => p === parentKind && c === childKind)) continue;
  test(`CONTAINS (${parentKind} to ${childKind}) groups a whole repository, package or database and is not crossed`, () => {
    const parent = node(parentKind, 'parent');
    const child = node(childKind, 'member');
    const edges = [fact('CONTAINS', parent, child)];
    assert.equal(reached([parent, child], edges, parent).size, 0);
    assert.equal(reached([parent, child], edges, child).size, 0);
  });
}

test('what a step may be followed by: up then dependent, up then join, join then down, down then down', () => {
  // Up, then a dependent of the container.
  const x = node('CodeField', 'K.x');
  const k = node('Symbol', 'K');
  const z = node('Symbol', 'Z');
  const v = node('Column', 'public.t.v');
  assert.ok(
    reached([x, k, z], [fact('CONTAINS', k, x), fact('CALLS', z, k)], x).has(z.id),
    'up then dependent',
  );
  // Up, then a join of the container.
  assert.ok(
    reached([x, k, v], [fact('CONTAINS', k, x), fact('VALIDATED_BY', v, k)], x).has(v.id),
    'up then join',
  );
  // A join, then down into the container reached.
  const entity = node('Entity', 'Order');
  const table = node('Table', 'public.orders');
  const column = node('Column', 'public.orders.total');
  assert.ok(
    reached(
      [entity, table, column],
      [fact('PERSISTED_IN', entity, table), fact('CONTAINS', table, column)],
      entity,
    ).has(column.id),
    'join then down',
  );
  // Down, then down again: file to symbol to field.
  const file = node('File', 'src/f.ts');
  assert.ok(
    reached([file, k, x], [fact('CONTAINS', file, k), fact('CONTAINS', k, x)], file).has(x.id),
    'down then down',
  );
  // But never down after up: a sibling is not reached through the container.
  const a = node('Symbol', 'A');
  const b = node('Symbol', 'B');
  const siblings = reached([file, a, b], [fact('CONTAINS', file, a), fact('CONTAINS', file, b)], a);
  assert.ok(siblings.has(file.id) && !siblings.has(b.id), 'no down after up');
});

test('a second step up may follow a step up: a field reaches the importers of its file', () => {
  // CodeField X in Symbol K in File F; File G imports F; Symbol Q in G; T tests Q.
  const x = node('CodeField', 'K.x');
  const k = node('Symbol', 'K');
  const f = node('File', 'src/f.ts');
  const g = node('File', 'src/g.ts');
  const q = node('Symbol', 'Q');
  const t = node('TestCase', 'tests/q.test.ts::q');
  const walk = findAffectedTests(
    memoryView(
      [x, k, f, g, q, t],
      [
        fact('CONTAINS', k, x),
        fact('CONTAINS', f, k),
        fact('IMPORTS', g, f),
        fact('CONTAINS', g, q),
        fact('TESTS', t, q),
      ],
    ),
    [x.id],
    { maxDepth: 6, maxNodes: 100 },
  );
  assert.deepEqual(
    walk.tests.map((w) => [w.test.id, w.distance, w.edges.map((e) => e.kind)]),
    [[t.id, 5, ['CONTAINS', 'CONTAINS', 'IMPORTS', 'CONTAINS', 'TESTS']]],
  );
});

// ---------------------------------------------------------------------------
// Two ways to one node
// ---------------------------------------------------------------------------

/**
 * The calling file imports the callee's file, which is the common shape:
 *
 *   F (file) IMPORTS FR (file); R in FR; S and B in F; T TESTS B.
 *
 * Without a call, B is reached through the import: a change to R reaches the
 * importer F, and F's members. With `S CALLS R` there is a second, shorter way to
 * F (up from S), and that way cannot descend again. It must not shadow the import.
 */
function importShape() {
  const FR = node('File', 'src/fr.ts');
  const R = node('Symbol', 'R');
  const F = node('File', 'src/f.ts');
  const S = node('Symbol', 'S');
  const B = node('Symbol', 'B');
  const T = node('TestCase', 'tests/b.test.ts::b');
  const base = [
    fact('CONTAINS', FR, R),
    fact('CONTAINS', F, S),
    fact('CONTAINS', F, B),
    fact('IMPORTS', F, FR),
    fact('TESTS', T, B),
  ];
  return { FR, R, F, S, B, T, base, nodes: [FR, R, F, S, B, T] };
}

test('a file reached both by stepping up and by an import can still be descended: the import is not shadowed', () => {
  const { R, S, T, base, nodes } = importShape();

  const without = findAffectedTests(memoryView(nodes, base), [R.id], OPTS);
  assert.deepEqual(
    without.tests.map((t) => [t.test.id, t.distance]),
    [[T.id, 4]],
  );

  const withCall = findAffectedTests(
    memoryView(nodes, [...base, fact('CALLS', S, R)]),
    [R.id],
    OPTS,
  );
  assert.deepEqual(
    withCall.tests.map((t) => [t.test.id, t.distance]),
    [[T.id, 4]],
    'adding a direct dependency must not remove the test the import reaches',
  );
});

test('a second visit to a node does not count against the node cap', () => {
  // R in FR. S CALLS R, S in F: F is reached by a step up (cannot descend) at depth 2.
  // F IMPORTS G2 IMPORTS G1 IMPORTS FR: F is reached again, free, at depth 4, after every
  // other node was seen. Five distinct nodes besides the root: FR, S, F, G1, G2.
  const FR = node('File', 'src/fr.ts');
  const R = node('Symbol', 'R');
  const F = node('File', 'src/f.ts');
  const S = node('Symbol', 'S');
  const G1 = node('File', 'src/g1.ts');
  const G2 = node('File', 'src/g2.ts');
  const T = node('TestCase', 'tests/s.test.ts::s');
  const view = memoryView(
    [FR, R, F, S, G1, G2, T],
    [
      fact('CONTAINS', FR, R),
      fact('CONTAINS', F, S),
      fact('CALLS', S, R),
      fact('IMPORTS', G1, FR),
      fact('IMPORTS', G2, G1),
      fact('IMPORTS', F, G2),
      fact('TESTS', T, S),
    ],
  );

  const tight = findAffectedTests(view, [R.id], { maxDepth: 6, maxNodes: 4 });
  assert.equal(tight.state.truncated, true, 'four nodes are too few for five');
  assert.deepEqual(tight.state.truncated && tight.state.reasons, ['result-cap']);

  for (const maxNodes of [5, 6]) {
    const exact = findAffectedTests(view, [R.id], { maxDepth: 6, maxNodes });
    assert.equal(exact.state.truncated, false, `maxNodes ${maxNodes}: five distinct nodes fit`);
    assert.deepEqual(
      exact.tests.map((w) => [w.test.id, w.distance]),
      [[T.id, 2]],
    );
    assert.equal(exact.reached.length, 5);
  }
});

test('the answer does not depend on the order edges or nodes are enumerated in', () => {
  const { R, S, base, nodes } = importShape();
  const edges = [...base, fact('CALLS', S, R)];
  const expected = JSON.stringify(
    findAffectedTests(memoryView(nodes, edges), [R.id], OPTS).tests.map((t) => [
      t.test.id,
      t.distance,
      t.nodes,
    ]),
  );
  for (const rotation of [1, 2, 3, 4, 5]) {
    const rotated = [...edges.slice(rotation), ...edges.slice(0, rotation)];
    const reversed = [...rotated].reverse();
    for (const order of [rotated, reversed]) {
      const got = JSON.stringify(
        findAffectedTests(memoryView([...nodes].reverse(), order), [R.id], OPTS).tests.map((t) => [
          t.test.id,
          t.distance,
          t.nodes,
        ]),
      );
      assert.equal(got, expected, `rotation ${rotation}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Differential and property tests over random graphs
// ---------------------------------------------------------------------------

/** mulberry32: a small generator with good bits, so a failure replays from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many nodes of each kind a random graph has. Containment is nested (file, symbol, field). */
const POPULATION: ReadonlyArray<readonly [NodeKind, number]> = [
  ['File', 3],
  ['Symbol', 6],
  ['CodeField', 2],
  ['Parameter', 2],
  ['Table', 1],
  ['Column', 2],
  ['Contract', 1],
  ['Operation', 2],
  ['SchemaProperty', 1],
  ['Entity', 1],
  ['DomainProperty', 1],
  ['RouteHandler', 1],
  ['Module', 1],
  ['TestCase', 4],
];

const isPair = (parent: NodeKind, child: NodeKind): boolean =>
  PAIRS.some(([p, c]) => p === parent && c === child);

/** Mostly code: files, symbols and their members, so shapes like "importer of the container's file" recur. */
const CODE_POPULATION: ReadonlyArray<readonly [NodeKind, number]> = [
  ['File', 4],
  ['Symbol', 6],
  ['CodeField', 3],
  ['Parameter', 1],
  ['Table', 1],
  ['Column', 2],
  ['TestCase', 4],
];

interface RandomGraph {
  readonly nodes: SeamlineNode[];
  readonly edges: SeamlineEdge[];
}

/**
 * Endpoints for a random edge of `kind`: mostly a pair of kinds its signature declares,
 * so that realistic shapes (a file's symbol calling a symbol in a file the first file
 * imports) recur, and sometimes arbitrary nodes, because the walk's rules are about
 * edge kinds, not node kinds.
 */
function endpoints(
  kind: EdgeKind,
  nodes: readonly SeamlineNode[],
  rand: () => number,
): readonly [SeamlineNode, SeamlineNode] {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  if (rand() >= 0.3) {
    const [srcKind, dstKind] = pick(EDGE_SIGNATURES[kind]);
    const from = nodes.filter((n) => n.kind === srcKind);
    const to = nodes.filter((n) => n.kind === dstKind);
    if (from.length > 0 && to.length > 0) return [pick(from), pick(to)];
  }
  return [pick(nodes), pick(nodes)];
}

/**
 * A random graph: every kind, random provenance, tombstones, cycles, containment
 * between allowed pairs (several parents allowed) and a few disallowed ones, random
 * dependency and join edges (see `endpoints`), and one or two `TESTS` edges per test.
 */
function randomGraph(
  rand: () => number,
  density: number,
  population: ReadonlyArray<readonly [NodeKind, number]> = POPULATION,
): RandomGraph {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const provenance = (weights: readonly [number, number, number]): SeamlineNode['provenance'] => {
    const r = rand();
    return r < weights[0]
      ? 'EXTRACTED'
      : r < weights[1]
        ? 'DECLARED'
        : r < weights[2]
          ? 'INFERRED'
          : 'LLM_SUGGESTED';
  };

  const nodes: SeamlineNode[] = [];
  for (const [kind, count] of population) {
    for (let i = 0; i < count; i += 1) {
      nodes.push(
        makeNode({
          kind,
          canonicalName: `${kind.toLowerCase()}${i}`,
          provenance: provenance([0.9, 0.94, 0.97]),
          deletedAt: rand() < 0.03 ? '2026-01-01' : null,
        }),
      );
    }
  }

  const edges: SeamlineEdge[] = [];
  const seen = new Set<string>();
  const add = (kind: EdgeKind, src: SeamlineNode, dst: SeamlineNode): void => {
    const key = `${kind} ${src.id} ${dst.id}`;
    if (seen.has(key) || src === dst) return;
    seen.add(key);
    edges.push(
      makeEdge({
        kind,
        src: src.id,
        dst: dst.id,
        provenance: provenance([0.88, 0.93, 0.97]),
        deletedAt: rand() < 0.03 ? '2026-01-01' : null,
      }),
    );
  };

  for (const a of nodes) {
    for (const b of nodes) {
      if (isPair(a.kind, b.kind) ? rand() < 0.35 : rand() < 0.01) add('CONTAINS', a, b);
    }
  }
  const count = Math.floor(density * nodes.length);
  for (let i = 0; i < count; i += 1) {
    const kind = pick(DEPENDENT);
    add(kind, ...endpoints(kind, nodes, rand));
  }
  for (let i = 0; i < count / 2; i += 1) {
    const kind = pick(JOIN);
    add(kind, ...endpoints(kind, nodes, rand));
  }
  const tested = nodes.filter((n) => n.kind !== 'TestCase');
  for (const spec of nodes.filter((n) => n.kind === 'TestCase')) {
    for (let i = 0, n = 1 + Math.floor(rand() * 2); i < n; i += 1) add('TESTS', spec, pick(tested));
  }
  return { nodes, edges };
}

/**
 * An independent re-implementation of what the walk is specified to do: an exact
 * breadth-first search over (node, arrived-by-a-step-up) states with no dominance
 * pruning and no caps, working from the raw edge list. Returns each test's shortest
 * distance within `maxDepth`, how many distinct nodes lie within it, and whether any
 * state lies beyond it that the states within it do not cover.
 */
function oracle(graph: RandomGraph, roots: readonly string[], maxDepth: number) {
  const isFact = (p: string): boolean => p === 'EXTRACTED' || p === 'DECLARED';
  const live = new Map(graph.nodes.filter((n) => n.deletedAt === null).map((n) => [n.id, n]));
  const okNode = (id: string): boolean => {
    const n = live.get(id as SeamlineNode['id']);
    return n !== undefined && isFact(n.provenance);
  };
  const okEdge = (e: SeamlineEdge): boolean =>
    e.deletedAt === null && isFact(e.provenance) && okNode(e.src) && okNode(e.dst);
  const kindOf = (id: string): NodeKind =>
    (live.get(id as SeamlineNode['id']) as SeamlineNode).kind;

  const steps = (id: string, up: boolean): Array<[string, boolean]> => {
    const out: Array<[string, boolean]> = [];
    for (const e of graph.edges) {
      if (!okEdge(e)) continue;
      if (DEPENDENT.includes(e.kind) && e.dst === id) out.push([e.src, false]);
      if (JOIN.includes(e.kind) && e.src === id) out.push([e.dst, false]);
      if (JOIN.includes(e.kind) && e.dst === id) out.push([e.src, false]);
      if (e.kind === 'CONTAINS') {
        if (e.dst === id && isPair(kindOf(e.src), kindOf(id))) out.push([e.src, true]);
        if (!up && e.src === id && isPair(kindOf(id), kindOf(e.dst))) out.push([e.dst, false]);
      }
    }
    return out;
  };

  const dist = new Map<string, number>();
  const key = (id: string, up: boolean): string => `${up ? 'U' : 'F'} ${id}`;
  let frontier: Array<[string, boolean]> = [];
  for (const r of roots) {
    dist.set(key(r, false), 0);
    frontier.push([r, false]);
  }
  for (let d = 1; frontier.length > 0; d += 1) {
    const next: Array<[string, boolean]> = [];
    for (const [id, up] of frontier) {
      for (const [to, toUp] of steps(id, up)) {
        if (dist.has(key(to, toUp))) continue;
        dist.set(key(to, toUp), d);
        next.push([to, toUp]);
      }
    }
    frontier = next;
  }

  const testDist = new Map<string, number>();
  for (const [k, d] of dist) {
    if (d > maxDepth) continue;
    const id = k.slice(2);
    for (const e of graph.edges) {
      if (e.kind !== 'TESTS' || e.dst !== id || !okEdge(e) || kindOf(e.src) !== 'TestCase')
        continue;
      const current = testDist.get(e.src);
      if (current === undefined || d + 1 < current) testDist.set(e.src, d + 1);
    }
  }

  const within = new Set<string>();
  const coveredFree = new Set<string>();
  const coveredStay = new Set<string>();
  for (const [k, d] of dist) {
    if (d > maxDepth) continue;
    const id = k.slice(2);
    if (!roots.includes(id)) within.add(id);
    (k.startsWith('F') ? coveredFree : coveredStay).add(id);
  }
  let beyond = false;
  for (const [k, d] of dist) {
    if (d <= maxDepth) continue;
    const id = k.slice(2);
    const covered = k.startsWith('F')
      ? coveredFree.has(id)
      : coveredFree.has(id) || coveredStay.has(id);
    if (!covered) beyond = true;
  }
  return { testDist, nodesWithin: within.size, beyond };
}

test('differential: the walk equals an independent state-space search on random graphs', () => {
  let withTests = 0;
  let beyondCases = 0;
  let capCases = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const rand = mulberry32(seed * 7919);
    const graph = randomGraph(rand, [0.3, 0.6, 1.0, 1.6][seed % 4] as number);
    const candidates = graph.nodes.filter(
      (n) =>
        n.deletedAt === null &&
        (n.provenance === 'EXTRACTED' || n.provenance === 'DECLARED') &&
        n.kind !== 'TestCase',
    );
    const roots: NodeId[] = [
      ...new Set(
        Array.from(
          { length: 1 + Math.floor(rand() * 2) },
          () => (candidates[Math.floor(rand() * candidates.length)] as SeamlineNode).id,
        ),
      ),
    ];
    const maxDepth = 1 + Math.floor(rand() * 5);
    const want = oracle(graph, roots, maxDepth);
    const where = `seed ${seed}, roots ${roots.join(' ')}, depth ${maxDepth}`;

    // Input order must not matter either.
    const shuffled = <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    };
    const view = memoryView(shuffled(graph.nodes), shuffled(graph.edges));
    const got = findAffectedTests(view, shuffled(roots), { maxDepth, maxNodes: 100000 });

    assert.deepEqual(
      [...got.tests.map((t) => [t.test.id, t.distance] as const)].sort(),
      [...want.testDist].sort(),
      `tests: ${where}`,
    );
    const stoppedByDepth = got.state.truncated && got.state.reasons.includes('depth-cap');
    assert.equal(stoppedByDepth, want.beyond, `depth cap: ${where}`);
    if (want.testDist.size > 0) withTests += 1;
    if (want.beyond) beyondCases += 1;

    // The node cap bites exactly when more distinct nodes lie within reach than it allows.
    for (const cap of [1, 2, 3, 5, 8, 13]) {
      const capped = findAffectedTests(view, roots, { maxDepth, maxNodes: cap });
      const hit = capped.state.truncated && capped.state.reasons.includes('result-cap');
      assert.equal(
        hit,
        want.nodesWithin > cap,
        `node cap ${cap} (${want.nodesWithin} within): ${where}`,
      );
      if (hit) capCases += 1;
      for (const t of capped.tests) {
        assert.ok(want.testDist.has(t.test.id), `a capped walk invented ${t.test.id}: ${where}`);
      }
    }
  }
  // The generator reaches the cases the assertions are about.
  assert.ok(withTests > 100, `graphs with tests: ${withTests}`);
  assert.ok(beyondCases > 50, `graphs with more beyond the depth cap: ${beyondCases}`);
  assert.ok(capCases > 100, `walks that hit the node cap: ${capCases}`);
});

test('property: adding an edge never removes a test and never moves one further away', () => {
  let comparisons = 0;
  let gained = 0;
  const kinds: readonly EdgeKind[] = [...DEPENDENT, ...JOIN, 'CONTAINS'];
  for (const [label, population] of [
    ['mixed kinds', POPULATION],
    ['mostly code', CODE_POPULATION],
  ] as const) {
    for (let seed = 1; seed <= 250; seed += 1) {
      const rand = mulberry32(seed * 104729);
      const graph = randomGraph(rand, [0.3, 0.6, 1.0, 1.6][seed % 4] as number, population);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
      const maxDepth = 1 + Math.floor(rand() * 5);
      const roots = [
        pick(
          graph.nodes.filter(
            (n) =>
              n.deletedAt === null &&
              (n.provenance === 'EXTRACTED' || n.provenance === 'DECLARED') &&
              n.kind !== 'TestCase',
          ),
        ).id,
      ];

      const walk = (edges: readonly SeamlineEdge[]) =>
        new Map(
          findAffectedTests(memoryView(graph.nodes, edges), roots, {
            maxDepth,
            maxNodes: 100000,
          }).tests.map((t) => [t.test.id as string, t.distance] as const),
        );
      // Grow the graph one edge at a time: each step must keep every test the step before found.
      let edges: readonly SeamlineEdge[] = graph.edges;
      let before = walk(edges);
      for (let k = 0; k < 12; k += 1) {
        // Any edge: a dependency, a join, or one more containment, which may nest or give a second parent.
        const kind = pick(kinds);
        const [src, dst] = endpoints(kind, graph.nodes, rand);
        if (src === dst) continue;
        edges = [...edges, fact(kind, src, dst)];
        const after = walk(edges);
        const where = `${label}, seed ${seed}: adding ${kind} ${src.id} -> ${dst.id} for ${roots[0]} at depth ${maxDepth}`;
        for (const [testId, distance] of before) {
          const now = after.get(testId);
          assert.ok(now !== undefined, `${where} removed ${testId}`);
          assert.ok(now <= distance, `${where} moved ${testId} from ${distance} to ${now}`);
          comparisons += 1;
        }
        if (after.size > before.size) gained += 1;
        before = after;
      }
    }
  }
  assert.ok(comparisons > 1000, `the property was exercised (${comparisons} comparisons)`);
  assert.ok(gained > 100, `and added edges do reach new tests (${gained})`);
});
