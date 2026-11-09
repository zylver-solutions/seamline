import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findingClusters } from './clustering.ts';
import { matchLabels, parseLabels } from './labels.ts';
import { clusteredTally } from './metrics.ts';
import { finding } from './testing.ts';

const label = { verdict: 'tp', rationale: 'source facts disagree', evidence: ['schema.sql:1', 'contract.json:1'], reviewer: 'reviewer', blind: true };
const a = finding('r', 'X1_NULLABILITY', 'left:a', 'right:a');
const bridge = finding('r', 'X1_NULLABILITY', 'left:a', 'right:b');
const b = finding('r', 'X1_NULLABILITY', 'left:b', 'right:b');

test('default components follow transitive same-left and same-right links, including unlabelled bridges', () => {
  const labels = parseLabels({ [a.id]: label, [b.id]: label });
  const clusters = findingClusters([a, bridge, b], labels);
  assert.equal(new Set(clusters.values()).size, 1);
  assert.equal(matchLabels([a, bridge, b], labels, true).unlabelled.length, 1);
  const tally = clusteredTally([a, bridge, b].map((f) => ({ repo: f.repo, code: f.code, cluster: clusters.get(f.id), verdict: labels.get(f.id)?.verdict ?? null })));
  assert.deepEqual(tally, { tp: 0, fp: 0, unclear: 0, unlabelled: 1 }, 'a partially labelled component cannot supply a selected TP');
  assert.deepEqual([...findingClusters([b, bridge, a], labels)], [...clusters], 'input order cannot change component ids');
});

test('repository, detector and endpoint side are independent boundaries', () => {
  const otherRepo = finding('s', a.code, a.left, a.right);
  const otherCode = finding('r', 'X2_TYPE', a.left, a.right);
  const swapped = finding('r', a.code, a.right, a.left);
  assert.equal(new Set(findingClusters([a, otherRepo, otherCode, swapped], new Map()).values()).size, 4);
});

test('an explicit cluster override can split a default component and join separate roots', () => {
  const labels = parseLabels({ [a.id]: { ...label, cluster: 'different-root' } });
  assert.equal(new Set(findingClusters([a, bridge, b], labels).values()).size, 2);
  const separate = finding('r', a.code, 'left:c', 'right:c');
  const joined = parseLabels({ [a.id]: { ...label, cluster: 'one-root' }, [separate.id]: { ...label, cluster: 'one-root' } });
  assert.equal(new Set(findingClusters([a, separate], joined).values()).size, 1);
});

test('explicit names are scoped to detector as well as repository in counting and consistency', () => {
  const other = finding('r', 'X2_TYPE', a.left, a.right);
  const labels = parseLabels({ [a.id]: { ...label, cluster: 'same' }, [other.id]: { ...label, verdict: 'fp', cluster: 'same' } });
  const matched = matchLabels([a, other], labels, true);
  assert.equal(matched.labelled.length, 2);
  assert.deepEqual(clusteredTally(matched.labelled.map(({ finding: f, label: l }) => ({ repo: f.repo, code: f.code, cluster: matched.clusters.get(f.id), verdict: l.verdict }))), { tp: 1, fp: 1, unclear: 0, unlabelled: 0 });
});

test('mixed verdicts in a default component are rejected and sealed evidence stays withheld', () => {
  const labels = parseLabels({ [a.id]: label, [b.id]: { ...label, verdict: 'fp' } });
  assert.throws(() => matchLabels([a, bridge, b], labels, true), /one verdict/);
  assert.throws(() => matchLabels([a, bridge, b], labels, true, new Set(['r'])), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(`${a.id}|${b.id}|auto:`));
    assert.match(error.message, /names withheld/);
    return true;
  });
});

test('a late bridge joins existing component roots without disconnecting an earlier member', () => {
  const rows = [finding('r', 'X1_NULLABILITY', 'left:0', 'right:0'), finding('r', 'X1_NULLABILITY', 'left:0', 'right:1'), finding('r', 'X1_NULLABILITY', 'left:1', 'right:1')];
  assert.equal(rows.map((f) => f.id).sort().at(-1), rows[1]!.id, 'the bridge is visited after both endpoint components');
  const clusters = findingClusters(rows, new Map());
  const expected = `auto:${rows.map((f) => f.id).sort()[0]!}`;
  assert.deepEqual([...clusters.values()], [expected, expected, expected]);
});

test('an explicit override on the bridge splits both automatic neighbours', () => {
  const labels = parseLabels({ [bridge.id]: { ...label, cluster: 'different-root' } });
  const clusters = findingClusters([a, bridge, b], labels);
  assert.equal(new Set(clusters.values()).size, 3);
  assert.equal(clusters.get(bridge.id), 'different-root');
  assert.notEqual(clusters.get(a.id), clusters.get(b.id));
});
