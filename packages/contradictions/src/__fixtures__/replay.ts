import type { NodeSpec } from '../graph-memory.ts';

const GROUP = 'supabase/migrations';
const CONFIG = 'a'.repeat(64);
const INPUT = 'b'.repeat(64);
const SNAPSHOT = 'c'.repeat(64);
const common = {
  dataSource: 'default', replayVersion: 1, replayEpoch: 'run-fixture', replayGroup: GROUP,
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
  return [
    {
      kind: 'DataSource', name: 'default',
      props: {
        dataSource: 'default', replayVersion: 1, replayEpoch: 'run-fixture', replaySnapshotHash: SNAPSHOT,
        replayInventoryComplete: true, replayMembershipComplete: true, replayGroupCount: 1,
        replayGroups: JSON.stringify([[GROUP, 'supabase-filename-v1', CONFIG, true, ['001_ref', '002_create'], '', INPUT]]),
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
  ];
}

/** A positively examined empty inventory, rather than missing replay evidence. */
export function emptyReplayFixtureNodes(name = 'default'): NodeSpec[] {
  return [{
    kind: 'DataSource', name,
    props: {
      dataSource: name, dynamicDdl: 0, replayVersion: 1, replayEpoch: 'run-fixture', replaySnapshotHash: SNAPSHOT,
      replayInventoryComplete: true, replayMembershipComplete: true, replayGroupCount: 0, replayGroups: '[]',
    },
  }];
}
