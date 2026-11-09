import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from './errors.ts';
import { matchLabels, parseLabels } from './labels.ts';
import { finding } from './testing.ts';

const GOOD = {
  verdict: 'tp',
  rationale: 'The column is NOT NULL with no default and the request schema marks it optional.',
  evidence: ['prisma/schema.prisma:352', 'src/lib/schema.ts:300-302'],
  reviewer: 'reviewer-a',
  blind: true,
};

test('parseLabels accepts a complete label', () => {
  const labels = parseLabels({ '0123456789abcdef': GOOD });
  assert.equal(labels.get('0123456789abcdef')?.verdict, 'tp');
  assert.deepEqual(labels.get('0123456789abcdef')?.evidence, [
    'prisma/schema.prisma:352',
    'src/lib/schema.ts:300-302',
  ]);
});

test('parseLabels accepts evidence paths with brackets and parentheses', () => {
  const labels = parseLabels({
    '0123456789abcdef': {
      ...GOOD,
      evidence: ['apps/web/src/app/api/v1/[...route]/route.ts:12', 'src/(auth)/page.tsx:3'],
    },
  });
  assert.equal(labels.size, 1);
});

test('parseLabels names every problem rather than stopping at the first', () => {
  assert.throws(
    () =>
      parseLabels({
        nothex: GOOD,
        '0123456789abcdef': { ...GOOD, verdict: 'maybe' },
        '1123456789abcdef': { ...GOOD, rationale: ' ' },
        '2123456789abcdef': { ...GOOD, evidence: [] },
        '3123456789abcdef': { ...GOOD, evidence: ['no line number'] },
        '4123456789abcdef': { ...GOOD, reviewer: '' },
        '5123456789abcdef': { ...GOOD, blind: 'yes' },
        '6123456789abcdef': { ...GOOD, cluster: 'Not A Cluster' },
      }),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      for (const needle of [
        'nothex',
        '"verdict"',
        '"rationale"',
        '"evidence"',
        '"reviewer"',
        '"blind"',
        '"cluster"',
      ]) {
        assert.ok(e.message.includes(needle), `missing ${needle} in: ${e.message}`);
      }
      assert.equal(e.message.match(/"evidence"/g)?.length, 2);
      return true;
    },
  );
});

test('parseLabels refuses a labels file that is not an object', () => {
  assert.throws(() => parseLabels([]), ConfigError);
  assert.throws(() => parseLabels('x'), ConfigError);
});

test('a finding with no label is listed as unlabelled and is not counted as labelled', () => {
  const a = finding('r', 'X1_NULLABILITY', 'r:Column:a', 'r:SchemaProperty:a');
  const b = finding('r', 'X2_TYPE', 'r:Column:b', 'r:SchemaProperty:b');
  const labels = parseLabels({ [a.id]: GOOD });
  const match = matchLabels([a, b], labels, true);
  assert.deepEqual(
    match.unlabelled.map((f) => f.id),
    [b.id],
  );
  assert.deepEqual(
    match.labelled.map((l) => l.finding.id),
    [a.id],
  );
});

test('a label whose finding no longer appears is reported as stale', () => {
  const a = finding('r', 'X1_NULLABILITY', 'r:Column:a', 'r:SchemaProperty:a');
  const labels = parseLabels({
    [a.id]: GOOD,
    ffffffffffffffff: GOOD,
    '00000000000000aa': { ...GOOD, verdict: 'fp' },
  });
  const match = matchLabels([a], labels, true);
  assert.deepEqual(match.stale, ['00000000000000aa', 'ffffffffffffffff']);
  assert.equal(match.staleChecked, true);
});

test('staleness is not judged on a partial or incomplete run', () => {
  const labels = parseLabels({ ffffffffffffffff: GOOD });
  const match = matchLabels([], labels, false);
  assert.deepEqual(match.stale, []);
  assert.equal(match.staleChecked, false);
});

const FIXED = { ...GOOD, evidence: ['a.ts:1'] };

test('unclear is a valid verdict; cluster and blind are carried through', () => {
  const labels = parseLabels({
    '0123456789abcdef': {
      ...FIXED,
      verdict: 'unclear',
      cluster: 'board-description',
      blind: false,
    },
  });
  const label = labels.get('0123456789abcdef');
  assert.equal(label?.verdict, 'unclear');
  assert.equal(label?.cluster, 'board-description');
  assert.equal(label?.blind, false);
});

test('a label without "blind" is refused: whether the reviewer saw the claim must be recorded', () => {
  const { blind: _blind, ...withoutBlind } = FIXED;
  assert.throws(() => parseLabels({ '0123456789abcdef': withoutBlind }), /"blind"/);
});

test('findings in one repository that share a cluster must share a verdict', () => {
  const a = finding('r', 'X1_NULLABILITY', 'r:Column:a', 'r:SchemaProperty:a');
  const b = finding('r', 'X1_NULLABILITY', 'r:Column:b', 'r:SchemaProperty:b');
  const agree = parseLabels({
    [a.id]: { ...FIXED, cluster: 'same' },
    [b.id]: { ...FIXED, cluster: 'same' },
  });
  assert.equal(matchLabels([a, b], agree, true).labelled.length, 2);
  const split = parseLabels({
    [a.id]: { ...FIXED, cluster: 'same' },
    [b.id]: { ...FIXED, verdict: 'fp', cluster: 'same' },
  });
  assert.throws(() => matchLabels([a, b], split, true), /one verdict/);
});

test('the same cluster name in two repositories is two clusters, so their verdicts may differ', () => {
  const a = finding('r', 'X1_NULLABILITY', 'r:Column:a', 'r:SchemaProperty:a');
  const b = finding('s', 'X1_NULLABILITY', 's:Column:a', 's:SchemaProperty:a');
  const labels = parseLabels({
    [a.id]: { ...FIXED, cluster: 'same' },
    [b.id]: { ...FIXED, verdict: 'fp', cluster: 'same' },
  });
  assert.equal(matchLabels([a, b], labels, true).labelled.length, 2);
});
