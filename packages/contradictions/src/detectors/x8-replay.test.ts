import assert from 'node:assert/strict';
import type { GraphView, NodeKind } from '@seamline/ontology';
import { readReplayEvidence } from './x8-replay-proof.ts';
import test from 'node:test';
import { graph, type NodeSpec } from '../graph-memory.ts';
import { replayFixtureNodes } from '../__fixtures__/replay.ts';
import { x8OrphanedMigration } from './x8-orphaned-migration.ts';

function withProps(name: string, patch: Readonly<Record<string, string | number | boolean | null>>): NodeSpec[] {
  return replayFixtureNodes().map((node) => node.name === name ? { ...node, props: { ...node.props, ...patch } } : node);
}
function withheld(nodes: readonly NodeSpec[]): void {
  const g = graph({ nodes });
  assert.equal(x8OrphanedMigration.detect(g).length, 0);
  assert.ok(x8OrphanedMigration.unknownReason(g) !== undefined);
}

test('only current replay evidence produces the historical finding', () => {
  const g = graph({ nodes: replayFixtureNodes() });
  const findings = x8OrphanedMigration.detect(g);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.left, 'repo:Migration:001_ref');
  assert.equal(findings[0]?.right, 'repo:Migration:002_create');
  assert.match(findings[0]?.claim ?? '', /declared migration replay/);
  const guarded = graph({ nodes: replayFixtureNodes(true) });
  assert.equal(x8OrphanedMigration.detect(guarded).length, 0);
  assert.equal(x8OrphanedMigration.unknownReason(guarded), undefined);
});

test('missing versions, counts, snapshots and unknown inventory fail closed', () => {
  for (const patch of [
    { replayVersion: 2 },
    { replayReferenceCount: 0 },
    { unresolvedRefCount: 0 },
    { replayInputHash: 'd'.repeat(64) },
    { replaySnapshotHash: 'd'.repeat(64) },
    { replayEpoch: 'old-run' },
    { replayInventoryComplete: false },
    { replayStepCount: 0 },
    { replayOrdinal: 1 },
    { unresolvedRefs: 'not-json' },
  ]) withheld(withProps('001_ref', patch));
  withheld(withProps('default', { replayMembershipComplete: false }));
  withheld(withProps('default', { replayGroupCount: 0 }));
});

test('a creation witness must be live, factual, current and agree on the exact target', () => {
  for (const patch of [
    { replayInputHash: 'd'.repeat(64) },
    { replaySnapshotHash: 'd'.repeat(64) },
    { replayEpoch: 'old-run' },
    { replayDeclarations: JSON.stringify([['other', 'users', 'id', 0, 1], ['other', 'users', null, 0, 1]]) },
  ]) withheld(withProps('002_create', patch));
  for (const provenance of ['INFERRED', 'LLM_SUGGESTED'] as const) {
    withheld(replayFixtureNodes().map((node) => node.name === '002_create' ? { ...node, provenance } : node));
  }
  withheld(replayFixtureNodes().map((node) => node.name === '002_create' ? { ...node, deletedAt: 'retired' } : node));
});

test('indexed witnesses still require the exact target, statement and line', () => {
  for (const row of [
    ['public', 'users', null, 0, 1, '002_create', 0, 2],
    ['public', 'users', null, 0, 1, '002_create', 1, 1],
    ['public', 'users', 'missing', 0, 1, '002_create', 0, 1],
  ]) withheld(withProps('001_ref', { unresolvedRefs: JSON.stringify([row]) }));
});

test('a valid reference cannot borrow a declaration from a later migration', () => {
  withheld(withProps('001_ref', {
    unresolvedRefs: '[]', unresolvedRefCount: 0,
    validRefs: JSON.stringify([['public', 'users', null, 0, 1]]), validRefCount: 1,
  }));
});

test('legacy target props and tombstoned edges cannot bypass replay proof', () => {
  const legacy = graph({ nodes: [{ kind: 'Migration', name: 'old', props: { targetTable: 'missing' } }] });
  assert.equal(x8OrphanedMigration.detect(legacy).length, 0);
  assert.ok(x8OrphanedMigration.unknownReason(legacy) !== undefined);
  const nodes = replayFixtureNodes(true).map((node) => node.name === '001_ref' ? { ...node, props: { ...node.props, targetTable: 'missing', targetColumn: 'missing' } } : node);
  const g = graph({
    nodes: [...nodes, { kind: 'Table', name: 'retired', canonical: 'public.retired', deletedAt: 'retired' }],
    edges: [{ kind: 'MIGRATED_BY', src: 'public.retired', dst: '001_ref' }],
  });
  assert.equal(x8OrphanedMigration.detect(g).length, 0);
  assert.equal(x8OrphanedMigration.unknownReason(g), undefined);
});

test('required data scope failure blocks even well-formed replay evidence', () => {
  for (const status of ['FAIL', 'UNAVAILABLE'] as const) {
    const g = graph({ nodes: replayFixtureNodes(), scopes: { data: status } });
    assert.equal(x8OrphanedMigration.detect(g).length, 0);
  }
});

test('a forged code-symbol canonical name cannot become a Migration fact witness', () => {
  const nodes = replayFixtureNodes().map((node): NodeSpec => {
    if (node.name === '001_ref') return { ...node, name: '001_ref#symbol' };
    if (node.name === 'default') return {
      ...node,
      props: {
        ...node.props,
        replayGroups: JSON.stringify([['supabase/migrations', 'supabase-filename-v1', 'a'.repeat(64), true, ['001_ref#symbol', '002_create'], '', 'b'.repeat(64)]]),
      },
    };
    return node;
  });
  withheld(nodes);
});

test('independent data-source inventories do not multiply migration identity work', () => {
  const views = Array.from({ length: 128 }, (_, index) => graph({ repo: `repo-${index}`, nodes: replayFixtureNodes() }));
  const nodes = views.flatMap((view) => [...view.nodesByKind('DataSource'), ...view.nodesByKind('Migration')]);
  let identityReads = 0;
  for (const node of nodes) {
    const id = node.id;
    Object.defineProperty(node, 'id', { get: () => { identityReads += 1; return id; } });
  }
  const base = graph({ nodes: [] });
  const mixed: GraphView = {
    nodesByKind: (kind: NodeKind) => nodes.filter((node) => node.kind === kind),
    node: base.node.bind(base), edgesFrom: base.edgesFrom.bind(base), edgesTo: base.edgesTo.bind(base),
    scopeStatus: base.scopeStatus.bind(base),
  };
  const result = readReplayEvidence(mixed);
  assert.equal(result.findings.length, views.length);
  assert.deepEqual(result.withheld, []);
  assert.ok(identityReads <= 40 * nodes.length, `identity reads ${identityReads} exceed the bounded independent-inventory work allowance`);
});
