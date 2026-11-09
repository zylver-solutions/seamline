/**
 * Conformance: the SQLite sweep and the in-memory merge bury the same facts.
 *
 * Two implementations of one rule have to agree. `SqliteStore.finalizeRun`
 * tombstones in SQL; `merge/tombstone.ts` does it over `MergeState`. They share
 * the selector (`scope-selector.ts`), but until the edge rule was shared too
 * they disagreed in two places: the store ignored a claim's selector when it
 * swept edges, and the merge matched a path-less node by its name where the
 * store never matched it at all. Each side was tested alone, so neither suite
 * could see the other drift.
 *
 * Every test here runs ONE scenario through both and compares the full set of
 * tombstones, nodes and edges. The property test draws random graphs and random
 * narrowed claims and compares both against an oracle written from the rule's
 * statement, not from either implementation:
 *
 *   - nothing outside the claim is ever buried, and
 *   - everything inside the claim that the run did not re-observe is.
 *
 * A run id can repeat (deterministic run ids are derived from inputs), and the
 * earlier attempt's rows then already carry it. `restart: true` runs the second
 * run as a new attempt at the first's id (`SqliteStore.restartRun`,
 * `applyRestartedRun`): what it does not re-observe inside its claims is buried
 * exactly as if the id were new.
 *
 * The rule (`scope-selector.ts`, "What a claim covers"): a node is claimed when its kind is
 * named and, if there is a selector, its path matches; a path-less node never
 * matches one. An edge is claimed when it is stored under the claim's scope
 * and, if the claim has a selector and names node kinds, the file that anchors
 * it (`srcFile`, else `dstFile`) matches; an edge with no file never matches one.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';
import { edgeKey } from '@seamline/ontology';
import type {
  AuthoritativeScope,
  EdgeKind,
  NodeId,
  NodeKind,
  SeamlineEdge,
  SeamlineNode,
} from '@seamline/ontology';

import { mergeBatches, type MergeBatch } from '../merge/state.ts';
import { applyRestartedRun, applyRun } from '../merge/tombstone.ts';
import { compileSelector } from './scope-selector.ts';
import { SqliteStore } from './sqlite-store.ts';
import {
  extractorResult,
  fileNode,
  fixedClock,
  importsEdge,
  makeEdge,
  makeNode,
  runRecord,
  scope,
} from './testing.ts';

const SCOPE = 'code';

let dir: string;
let dbCount = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seamline-sweep-agreement-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Scenario {
  /** Run 1: no selector, so nothing is buried; it only populates. */
  readonly first: {
    readonly nodes: readonly SeamlineNode[];
    readonly edges: readonly SeamlineEdge[];
  };
  /**
   * Run 2: what it re-observes, and what it is the authority for. With `restart`
   * it is a second attempt at run 1's id, not a run of its own.
   */
  readonly second: {
    readonly restart?: boolean;
    readonly nodes: readonly SeamlineNode[];
    readonly edges: readonly SeamlineEdge[];
    readonly claims: readonly AuthoritativeScope[];
  };
}

const edgeId = (e: Pick<SeamlineEdge, 'src' | 'dst' | 'kind'>): string => edgeKey(SCOPE, e);

/** The buried facts, as sorted strings, from the on-disk rows of a real store. */
async function throughStore(scenario: Scenario): Promise<string[]> {
  dbCount += 1;
  const path = join(dir, `graph-${String(dbCount)}.db`);
  const s = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock() });
  try {
    await s.beginRun(runRecord('r1'));
    await s.upsertNodes('r1', scenario.first.nodes);
    await s.upsertEdges('r1', SCOPE, scenario.first.edges);
    await s.finalizeRun('r1', [
      extractorResult('x0', 'PASS', [scope(SCOPE, ['File', 'Symbol', 'Module'])]),
    ]);

    const second = scenario.second.restart === true ? 'r1' : 'r2';
    if (scenario.second.restart === true) await s.restartRun(runRecord(second));
    else await s.beginRun(runRecord(second));
    await s.upsertNodes(second, scenario.second.nodes);
    await s.upsertEdges(second, SCOPE, scenario.second.edges);
    await s.finalizeRun(
      second,
      scenario.second.claims.map((claim, i) => extractorResult(`x${String(i)}`, 'PASS', [claim])),
    );
  } finally {
    await s.close();
  }
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const nodes = raw.prepare('SELECT id FROM nodes WHERE deleted_at IS NOT NULL').all() as Array<{
      id: string;
    }>;
    const edges = raw
      .prepare('SELECT scope, src_id, dst_id, kind FROM edges WHERE deleted_at IS NOT NULL')
      .all() as Array<{ scope: string; src_id: string; dst_id: string; kind: string }>;
    return [
      ...nodes.map((n) => `node ${n.id}`),
      ...edges.map(
        (e) =>
          `edge ${edgeKey(e.scope, { src: e.src_id as NodeId, dst: e.dst_id as NodeId, kind: e.kind as EdgeKind })}`,
      ),
    ].sort();
  } finally {
    raw.close();
    rmSync(path, { force: true });
  }
}

/** The same, from the in-memory merge. */
function throughMerge(scenario: Scenario): string[] {
  const batch = (
    runId: string,
    extractor: string,
    authoritative: readonly AuthoritativeScope[],
    nodes: readonly SeamlineNode[],
    edges: readonly SeamlineEdge[],
  ): MergeBatch => ({
    runId,
    extractor,
    extractorPriority: 1,
    status: 'PASS',
    scope: SCOPE,
    authoritative,
    nodes,
    edges,
  });
  const prior = mergeBatches([
    batch(
      'r1',
      'x0',
      [scope(SCOPE, ['File', 'Symbol', 'Module'])],
      scenario.first.nodes,
      scenario.first.edges,
    ),
  ]);
  const { claims, nodes, edges, restart } = scenario.second;
  const runId = restart === true ? 'r1' : 'r2';
  const batches = claims.map((claim, i) =>
    batch(runId, `x${String(i)}`, [claim], i === 0 ? nodes : [], i === 0 ? edges : []),
  );
  const result =
    restart === true ? applyRestartedRun(prior, runId, batches) : applyRun(prior, batches);
  return [
    ...[...result.state.nodes.values()]
      .filter((m) => m.node.deletedAt !== null)
      .map((m) => `node ${m.node.id}`),
    ...[...result.state.edges.entries()]
      .filter(([, m]) => m.edge.deletedAt !== null)
      .map(([key]) => `edge ${key}`),
  ].sort();
}

/** The rule, stated from scratch: what a correct sweep buries. */
function oracle(scenario: Scenario): string[] {
  const nodeSeen = new Set(scenario.second.nodes.map((n) => n.id));
  const edgeSeen = new Set(scenario.second.edges.map(edgeId));
  const claims = scenario.second.claims.map((claim) => ({
    claim,
    selector: claim.selector === undefined ? undefined : compileSelector(claim.selector),
  }));

  const buried: string[] = [];
  for (const node of scenario.first.nodes) {
    if (nodeSeen.has(node.id)) continue;
    const claimed = claims.some(
      ({ claim, selector }) =>
        claim.kinds.includes(node.kind) &&
        (selector === undefined || (node.path !== undefined && selector.matches(node.path))),
    );
    if (claimed) buried.push(`node ${node.id}`);
  }
  for (const edge of scenario.first.edges) {
    if (edgeSeen.has(edgeId(edge))) continue;
    const anchor = edge.srcFile ?? edge.dstFile;
    const claimed = claims.some(
      ({ claim, selector }) =>
        claim.scope === SCOPE &&
        (selector === undefined ||
          claim.kinds.length === 0 ||
          (anchor !== undefined && selector.matches(anchor))),
    );
    if (claimed) buried.push(`edge ${edgeId(edge)}`);
  }
  return buried.sort();
}

async function assertAgreement(scenario: Scenario, why: string): Promise<string[]> {
  const expected = oracle(scenario);
  assert.deepEqual(
    await throughStore(scenario),
    expected,
    `${why}: the SQLite sweep buried the wrong set`,
  );
  assert.deepEqual(
    throughMerge(scenario),
    expected,
    `${why}: the in-memory merge buried the wrong set`,
  );
  return expected;
}

// ---------------------------------------------------------------------------
// A shared pool: files, symbols, a path-less symbol whose NAME looks like a path
// ---------------------------------------------------------------------------

const fileA = fileNode('src/a.ts');
const fileB = fileNode('src/b.ts');
const fileC = fileNode('lib/c.ts');
const readme = fileNode('README.md');
const symA = makeNode({ name: 'src/a.ts#A', kind: 'Symbol', path: 'src/a.ts' });
const symB = makeNode({ name: 'src/b.ts#B', kind: 'Symbol', path: 'src/b.ts' });
const symC = makeNode({ name: 'lib/c.ts#C', kind: 'Symbol', path: 'lib/c.ts' });
// No path, but its name is a path the selector `src/a.ts` matches. The merge
// once matched path-less nodes by name; the store never did.
const ghost = makeNode({ name: 'src/a.ts', kind: 'Symbol' });
const root = makeNode({ name: 'root', kind: 'Module' });
const other = makeNode({ name: 'other', kind: 'Module' });

const NODE_POOL: readonly SeamlineNode[] = [
  fileA,
  fileB,
  fileC,
  readme,
  symA,
  symB,
  symC,
  ghost,
  root,
  other,
];

const contains = (src: SeamlineNode, dst: SeamlineNode): SeamlineEdge =>
  makeEdge({
    src: src.id,
    dst: dst.id,
    kind: 'CONTAINS',
    ...(src.path === undefined ? {} : { srcFile: src.path }),
    ...(dst.path === undefined ? {} : { dstFile: dst.path }),
  });

const calls = (src: SeamlineNode, dst: SeamlineNode): SeamlineEdge =>
  makeEdge({
    src: src.id,
    dst: dst.id,
    kind: 'CALLS',
    ...(src.path === undefined ? {} : { srcFile: src.path }),
    ...(dst.path === undefined ? {} : { dstFile: dst.path }),
  });

const EDGE_POOL: readonly SeamlineEdge[] = [
  importsEdge(fileA, fileB),
  importsEdge(fileB, fileA),
  importsEdge(fileB, fileC),
  importsEdge(fileC, fileA),
  contains(fileA, symA),
  contains(fileB, symB),
  contains(fileC, symC),
  calls(symA, symB),
  calls(symB, symC),
  calls(symC, ghost),
  calls(ghost, symA),
  // Only the destination names a file.
  contains(root, fileA),
  contains(root, readme),
  // No file at all.
  makeEdge({ src: root.id, dst: other.id, kind: 'IMPORTS' }),
];

// ---------------------------------------------------------------------------
// Named scenarios
// ---------------------------------------------------------------------------

describe('the sweep through both implementations', () => {
  test('a run narrowed to one file buries only that file: nodes and edges alike', async () => {
    const buried = await assertAgreement(
      {
        first: {
          nodes: [fileA, fileB, symA, symB],
          edges: [
            contains(fileA, symA),
            contains(fileB, symB),
            importsEdge(fileA, fileB),
            importsEdge(fileB, fileA),
          ],
        },
        second: {
          nodes: [fileA, symA],
          edges: [contains(fileA, symA)],
          claims: [scope(SCOPE, ['File', 'Symbol'], 'src/a.ts')],
        },
      },
      'narrowed to src/a.ts',
    );
    // Only a.ts's vanished import. Nothing of b.ts, node or edge.
    assert.deepEqual(buried, [`edge ${edgeId(importsEdge(fileA, fileB))}`]);
  });

  test('a path-less node is not claimed by a selector, in either implementation, even if its name matches', async () => {
    const buried = await assertAgreement(
      {
        first: { nodes: [ghost, fileA], edges: [] },
        second: { nodes: [], edges: [], claims: [scope(SCOPE, ['File', 'Symbol'], 'src/a.ts')] },
      },
      'ghost',
    );
    assert.deepEqual(buried, [`node ${fileA.id}`]);
  });

  test('without a selector a path-less node is claimed by its kind alone', async () => {
    const buried = await assertAgreement(
      {
        first: { nodes: [ghost, fileA], edges: [] },
        second: { nodes: [], edges: [], claims: [scope(SCOPE, ['Symbol'])] },
      },
      'no selector',
    );
    assert.deepEqual(buried, [`node ${ghost.id}`]);
  });

  test('an edge is anchored by its source file, then its destination file, and an edge with neither is never claimed by a selector', async () => {
    const fromA = importsEdge(fileA, fileB);
    const intoA = contains(root, fileA);
    const intoReadme = contains(root, readme);
    const nowhere = makeEdge({ src: root.id, dst: other.id, kind: 'IMPORTS' });
    const buried = await assertAgreement(
      {
        first: { nodes: [], edges: [fromA, intoA, intoReadme, nowhere] },
        second: { nodes: [], edges: [], claims: [scope(SCOPE, ['File', 'Module'], '**/*.ts')] },
      },
      'anchors',
    );
    assert.deepEqual(buried, [`edge ${edgeId(fromA)}`, `edge ${edgeId(intoA)}`].sort());
  });

  test('a claim naming no node kinds claims the whole edge scope, its selector being a label', async () => {
    const fromA = importsEdge(fileA, fileB);
    const nowhere = makeEdge({ src: root.id, dst: other.id, kind: 'IMPORTS' });
    const buried = await assertAgreement(
      {
        first: { nodes: [fileA], edges: [fromA, nowhere] },
        second: { nodes: [], edges: [], claims: [scope(SCOPE, [], 'MAPS_TO_FIELD|BACKED_BY')] },
      },
      'label',
    );
    assert.deepEqual(buried, [`edge ${edgeId(fromA)}`, `edge ${edgeId(nowhere)}`].sort());
  });

  test('two claims over one scope bury the union of their selections', async () => {
    const buried = await assertAgreement(
      {
        first: {
          nodes: [fileA, fileB, fileC],
          edges: [importsEdge(fileA, fileB), importsEdge(fileB, fileC), importsEdge(fileC, fileA)],
        },
        second: {
          nodes: [],
          edges: [],
          claims: [scope(SCOPE, ['File'], 'src/a.ts'), scope(SCOPE, ['File'], 'lib/**')],
        },
      },
      'union',
    );
    assert.deepEqual(
      buried,
      [
        `edge ${edgeId(importsEdge(fileA, fileB))}`,
        `edge ${edgeId(importsEdge(fileC, fileA))}`,
        `node ${fileA.id}`,
        `node ${fileC.id}`,
      ].sort(),
    );
  });
});

describe('the sweep when the second run repeats the first run id', () => {
  test('what the second attempt does not re-observe is buried, nodes and edges alike', async () => {
    const buried = await assertAgreement(
      {
        first: {
          nodes: [fileA, fileB, symA],
          edges: [contains(fileA, symA), importsEdge(fileA, fileB)],
        },
        second: {
          restart: true,
          nodes: [fileA, symA],
          edges: [contains(fileA, symA)],
          claims: [scope(SCOPE, ['File', 'Symbol'])],
        },
      },
      'restart',
    );
    assert.deepEqual(
      buried,
      [`edge ${edgeId(importsEdge(fileA, fileB))}`, `node ${fileB.id}`].sort(),
    );
  });

  test('a restart narrowed to one file buries only that file', async () => {
    const buried = await assertAgreement(
      {
        first: {
          nodes: [fileA, fileB, symA, symB],
          edges: [
            contains(fileA, symA),
            contains(fileB, symB),
            importsEdge(fileA, fileB),
            importsEdge(fileB, fileA),
          ],
        },
        second: {
          restart: true,
          nodes: [fileA, symA],
          edges: [contains(fileA, symA)],
          claims: [scope(SCOPE, ['File', 'Symbol'], 'src/a.ts')],
        },
      },
      'restart narrowed to src/a.ts',
    );
    assert.deepEqual(buried, [`edge ${edgeId(importsEdge(fileA, fileB))}`]);
  });

  test('a restart that is not PASS buries nothing and leaves every stamp as the first attempt set it', async () => {
    const first = {
      nodes: [fileA, fileB],
      edges: [importsEdge(fileA, fileB)],
    };
    // Through the store.
    dbCount += 1;
    const path = join(dir, `graph-${String(dbCount)}.db`);
    const s = new SqliteStore({ path, ontologyVersion: '1.0.0', now: fixedClock() });
    try {
      await s.beginRun(runRecord('r1'));
      await s.upsertNodes('r1', first.nodes);
      await s.upsertEdges('r1', SCOPE, first.edges);
      await s.finalizeRun('r1', [
        extractorResult('x0', 'PASS', [scope(SCOPE, ['File', 'Symbol', 'Module'])]),
      ]);
      await s.restartRun(runRecord('r1'));
      await s.upsertNodes('r1', [fileA]);
      await s.finalizeRun('r1', [
        extractorResult('x0', 'FAIL', [scope(SCOPE, ['File', 'Symbol', 'Module'])]),
      ]);
      assert.deepEqual(
        [fileA, fileB].map((n) => s.node(n.id)?.lastSeenRun),
        ['r1', 'r1'],
        'store: both live, stamped r1',
      );
      assert.equal(s.edgesFrom(fileA.id).length, 1, 'store: the import is live');
    } finally {
      await s.close();
      rmSync(path, { force: true });
    }
    // Through the merge.
    const batch = (
      status: 'PASS' | 'FAIL',
      nodes: readonly SeamlineNode[],
      edges: readonly SeamlineEdge[],
    ): MergeBatch => ({
      runId: 'r1',
      extractor: 'x0',
      extractorPriority: 1,
      status,
      scope: SCOPE,
      authoritative: [scope(SCOPE, ['File', 'Symbol', 'Module'])],
      nodes,
      edges,
    });
    const prior = mergeBatches([batch('PASS', first.nodes, first.edges)]);
    const result = applyRestartedRun(prior, 'r1', [batch('FAIL', [fileA], [])]);
    assert.deepEqual(result.nodes, [], 'merge: nothing buried');
    assert.deepEqual(result.edges, []);
    assert.deepEqual(
      [fileA, fileB].map((n) => result.state.nodes.get(n.id)?.node.lastSeenRun),
      ['r1', 'r1'],
      'merge: both live, stamped r1',
    );
  });

  test('a batch of another run is not an attempt at this one', () => {
    const batch: MergeBatch = {
      runId: 'r2',
      extractor: 'x0',
      extractorPriority: 1,
      status: 'PASS',
      scope: SCOPE,
      authoritative: [],
      nodes: [],
      edges: [],
    };
    assert.throws(
      () => applyRestartedRun(mergeBatches([]), 'r1', [batch]),
      /cannot be applied as an attempt at r1/,
    );
  });
});

// ---------------------------------------------------------------------------
// Property: random graphs, random narrowed claims
// ---------------------------------------------------------------------------

const SELECTORS: ReadonlyArray<string | undefined> = [
  undefined,
  'src/a.ts',
  'src/*',
  'src/**',
  '**/*.ts',
  '**/*.{ts,md}',
  '{src/a.ts,lib/c.ts}',
  'lib/**',
  'README.md',
  '**',
  // A label: it compiles, and matches no path.
  'HEAD max=3',
];

const arbKinds = fc.subarray<NodeKind>(['File', 'Symbol', 'Module']);

const arbClaim: fc.Arbitrary<AuthoritativeScope> = fc
  .record({ kinds: arbKinds, selector: fc.constantFrom(...SELECTORS) })
  .map(({ kinds, selector }) => scope(SCOPE, kinds, selector));

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  first: fc.record({ nodes: fc.subarray([...NODE_POOL]), edges: fc.subarray([...EDGE_POOL]) }),
  second: fc.record({
    restart: fc.boolean(),
    nodes: fc.subarray([...NODE_POOL]),
    edges: fc.subarray([...EDGE_POOL]),
    claims: fc.array(arbClaim, { minLength: 1, maxLength: 2 }),
  }),
});

describe('the sweep, over random graphs and random narrowed claims', () => {
  test('nothing outside the claim is buried and everything unseen inside it is, in both implementations', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const expected = oracle(scenario);
        assert.deepEqual(await throughStore(scenario), expected, 'SQLite sweep');
        assert.deepEqual(throughMerge(scenario), expected, 'in-memory merge');
      }),
      { numRuns: 150 },
    );
  });
});
