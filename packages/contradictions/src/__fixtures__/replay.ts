import type { NodeSpec } from '../graph-memory.ts';
import { createHash } from 'node:crypto';
import { CORE_MODEL, MODEL_REGISTRY_HASH, REPLAY_BODY_FIELDS } from '../detectors/x8-replay-models.ts';

const GROUP = 'supabase/migrations';
const CONFIG = 'a'.repeat(64);
const INPUT = 'b'.repeat(64);
const SNAPSHOT = 'c'.repeat(64);
const common = {
  dataSource: 'default', replayVersion: 2, replayGroup: GROUP,
  replayModelId: CORE_MODEL[0], replayModelHash: CORE_MODEL[1], replaySelector: null,
  replayNativeState: JSON.stringify([CORE_MODEL[0], CORE_MODEL[1], false, [], []]),
  replayAbortPossible: false, replayContinuation: 'live',
  replayInputHash: INPUT, replaySnapshotHash: SNAPSHOT,
  replayInventoryComplete: true, replayOrderPolicy: 'supabase-filename-v1', replayConfigHash: CONFIG,
  replayStepCount: 1, replayUnknownStepCount: 0, replayUnknownSteps: '[]',
  replayDeclarations: '[]', replayDeclarationCount: 0,
  unresolvedRefs: '[]', unresolvedRefCount: 0,
  externalRefs: '[]', externalRefCount: 0,
  unknownRefs: '[]', unknownRefCount: 0,
  validRefs: '[]', validRefCount: 0,
  skippedRefs: '[]', skippedRefCount: 0, replayReferenceCount: 0,
} as const;

/** An unconditional requirement versus the same requirement guarded by IF EXISTS. */
export function replayFixtureNodes(guarded = false): NodeSpec[] {
  return stampReplayFixtureNodes([
    {
      kind: 'DataSource', name: 'default',
      props: {
        dataSource: 'default', replayVersion: 2, replaySnapshotHash: SNAPSHOT,
        replayInventoryComplete: true, replayMembershipComplete: true, replayGroupCount: 1,
        replayGroups: JSON.stringify([[GROUP, 'supabase-filename-v1', CONFIG, true, ['001_ref', '002_create'], '', INPUT, CORE_MODEL[0], CORE_MODEL[1], null]]),
      },
    },
    {
      kind: 'Migration', name: '001_ref', sourceRef: 'supabase/migrations/001_ref.sql:1',
      props: {
        ...common,
        replayOrdinal: 0,
        unresolvedRefs: guarded ? '[]' : JSON.stringify([['public', 'users', null, 0, 1, '002_create', 0, 1]]),
        unresolvedRefCount: guarded ? 0 : 1,
        skippedRefs: guarded ? JSON.stringify([['public', 'users', null, 0, 1]]) : '[]',
        skippedRefCount: guarded ? 1 : 0, replayReferenceCount: 1,
      },
    },
    {
      kind: 'Migration', name: '002_create', sourceRef: 'supabase/migrations/002_create.sql:1',
      props: {
        ...common,
        replayOrdinal: 1,
        replayDeclarations: JSON.stringify([['public', 'users', 'id', 0, 1], ['public', 'users', null, 0, 1]]),
        replayDeclarationCount: 2,
      },
    },
  ]);
}

/** A positively examined empty inventory, rather than missing replay evidence. */
export function emptyReplayFixtureNodes(name = 'default'): NodeSpec[] {
  return stampReplayFixtureNodes([{
    kind: 'DataSource', name,
    props: {
      dataSource: name, dynamicDdl: 0, replayVersion: 2, replaySnapshotHash: SNAPSHOT,
      replayInventoryComplete: true, replayMembershipComplete: true, replayGroupCount: 0, replayGroups: '[]',
    },
  }]);
}

/** Test-only independent reframing, so semantic negatives can pass the hash seam.
 * No producer transition/parser is imported. It intentionally does not repair model/row mutations. */
export function stampReplayFixtureNodes(nodes: readonly NodeSpec[]): NodeSpec[] {
  const root = nodes.find(n => n.kind === 'DataSource');
  if (root === undefined) throw new Error('fixture root missing');
  const groups: unknown = JSON.parse(String(root.props?.['replayGroups']));
  if (!Array.isArray(groups)) throw new Error('fixture groups missing');
  const basis = JSON.stringify([2, 'public', 'postgres', [], groups, false]);
  const digest = createHash('sha256').update(basis).update('\n');
  for (const node of nodes.filter(n => n.kind === 'Migration').sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    digest.update(JSON.stringify([node.name, REPLAY_BODY_FIELDS.map(k => [k, node.props?.[k]])])).update('\n');
  }
  const snapshot = digest.digest('hex');
  return nodes.map(node => ({ ...node, props: {
    ...node.props, replaySnapshotHash: snapshot,
    ...(node.kind === 'DataSource' ? {
      defaultSchema: 'public', dialect: 'postgres',
      replayModelId: 'x8-group-models-v2', replayModelHash: MODEL_REGISTRY_HASH, replaySelector: 0,
      replaySnapshotBasis: basis,
      replayNativeModels: JSON.stringify(groups.map(g => {
        if (!Array.isArray(g)) throw new Error('fixture group invalid');
        return [g[0], g[2], g[9], g[7], g[8]];
      })),
    } : {}),
  } }));
}
