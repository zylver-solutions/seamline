import assert from 'node:assert/strict';
import test from 'node:test';
import { graph, type NodeSpec } from '../graph-memory.ts';
import { replayFixtureNodes, stampReplayFixtureNodes } from '../__fixtures__/replay.ts';
import { x8OrphanedMigration } from './x8-orphaned-migration.ts';

function denied(nodes: readonly NodeSpec[]): void {
  const g = graph({ nodes });
  assert.equal(x8OrphanedMigration.detect(g).length, 0);
  assert.ok(x8OrphanedMigration.unknownReason(g));
}
test('proof-v2 positive reaches the ordinary detector before model mutation controls', () => {
  const g = graph({ nodes: replayFixtureNodes() });
  assert.equal(x8OrphanedMigration.detect(g).length, 1);
});
for (const name of ['default', '001_ref', '002_create']) for (const patch of [
  { replayVersion: 1 }, { replayModelHash: 'f'.repeat(64) }, { replayModelId: 'unapproved-native-model' },
  { replayConfigHash: 'f'.repeat(64) }, { replaySelector: 18 }, { replaySnapshotHash: 'f'.repeat(64) },
]) test(`proof-v2 model/config/version/epoch joins fail closed at ${name}: ${JSON.stringify(patch)}`, () => {
  denied(replayFixtureNodes().map(node => node.name === name ? { ...node, props: { ...node.props, ...patch } } : node));
});
test('model hash shape alone is not a known native model', () => {
  denied(replayFixtureNodes().map(node => ({ ...node, props: { ...node.props, replayModelId: 'postgresql-17.12-stock-source-local-v1', replayModelHash: '0'.repeat(64) } })));
});
test('changing a whole migration proof body under the same input and snapshot is rejected', () => {
  denied(replayFixtureNodes().map(node => node.name === '001_ref' ? { ...node, props: { ...node.props, replayAbortPossible: true } } : node));
});

test('reframed unknown native models and terminal proofs still fail independent semantic admission', () => {
  for (const patch of [{ replayModelId: 'other', replayModelHash: 'f'.repeat(64) }, { replayContinuation: 'terminal' }, { replayNativeState: '["wrong"]' }]) {
    denied(stampReplayFixtureNodes(replayFixtureNodes().map(node => node.name === '001_ref' ? { ...node, props: { ...node.props, ...patch } } : node)));
  }
});

test('the root profile cannot contradict its committed snapshot basis', () => {
  for (const patch of [{ defaultSchema: 'other' }, { dialect: 'mysql' }]) denied(replayFixtureNodes().map(node => node.kind === 'DataSource' ? { ...node, props: { ...node.props, ...patch } } : node));
});
