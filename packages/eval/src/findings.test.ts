import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allUnknown,
  dedupeFindings,
  detectorOutcomes,
  findingId,
  parseCheckOutput,
} from './findings.ts';
import { contradiction, finding } from './testing.ts';

test('a finding id is the first 16 hex characters of sha256(repo|code|left|right)', () => {
  // Pinned literals: any change to the field order, the separator, or the
  // length changes every id in labels.json, so it must fail here first.
  assert.equal(
    findingId(
      'umami',
      'X1_NULLABILITY',
      'umami:Column:public.board.description',
      'umami:SchemaProperty:boards.post.description',
    ),
    '9dda03137f861e64',
  );
  assert.equal(
    findingId(
      'example',
      'X9_CONTRACT_DRIFT',
      'example:RouteHandler:GET /widgets',
      'example:Operation:listWidgets',
    ),
    '6a200c0d7b8aa2a0',
  );
});

test('the id changes when any one of repo, code, left, or right changes', () => {
  const base = findingId('r', 'X1_NULLABILITY', 'r:Column:a', 'r:SchemaProperty:b');
  assert.notEqual(base, findingId('s', 'X1_NULLABILITY', 'r:Column:a', 'r:SchemaProperty:b'));
  assert.notEqual(base, findingId('r', 'X2_TYPE', 'r:Column:a', 'r:SchemaProperty:b'));
  assert.notEqual(base, findingId('r', 'X1_NULLABILITY', 'r:Column:c', 'r:SchemaProperty:b'));
  assert.notEqual(base, findingId('r', 'X1_NULLABILITY', 'r:Column:a', 'r:SchemaProperty:c'));
});

test('the id does not depend on the claim text, the confidence, or the severity', () => {
  const raw = contradiction('X2_TYPE', 'r:Column:a', 'r:SchemaProperty:b', 0.4);
  const reworded = {
    ...contradiction('X2_TYPE', 'r:Column:a', 'r:SchemaProperty:b', 0.95),
    claim: 'x',
    severity: 'low',
  };
  const a = parseCheckOutput('r', { contradictions: [raw] }).findings[0];
  const b = parseCheckOutput('r', { contradictions: [reworded] }).findings[0];
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(a.id, b.id);
});

test('parseCheckOutput collapses duplicate pairs into one finding and keeps the raw count', () => {
  const first = contradiction('X3_CONSTRAINT', 'r:Column:a', 'r:Symbol:v', 0.5);
  const second = {
    ...contradiction('X3_CONSTRAINT', 'r:Column:a', 'r:Symbol:v', 0.8),
    claim: 'other dimension',
  };
  const parsed = parseCheckOutput('r', { contradictions: [first, second] });
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.occurrences, 2);
  assert.equal(parsed.findings[0]?.confidence, 0.8);
});

test('deduplication does not depend on input order', () => {
  const items = [
    { ...finding('r', 'X3_CONSTRAINT', 'r:Column:a', 'r:Symbol:v', 0.5), claim: 'b' },
    { ...finding('r', 'X3_CONSTRAINT', 'r:Column:a', 'r:Symbol:v', 0.8), claim: 'a' },
    finding('r', 'X1_NULLABILITY', 'r:Column:z', 'r:SchemaProperty:y'),
  ];
  assert.deepEqual(dedupeFindings(items), dedupeFindings(items.slice().reverse()));
});

test('parseCheckOutput reports the detectors the CLI says could not run', () => {
  const parsed = parseCheckOutput('r', {
    contradictions: [],
    unknownDetectors: [{ code: 'X1_NULLABILITY', reason: 'scope contracts is FAIL' }],
    degradedScopes: [{ scope: 'contracts' }, { scope: 'infer-join' }],
  });
  assert.equal(parsed.unknown.get('X1_NULLABILITY'), 'scope contracts is FAIL');
  assert.deepEqual(parsed.degradedScopes, ['contracts', 'infer-join']);
});

test('parseCheckOutput refuses output it does not understand instead of guessing', () => {
  assert.throws(() => parseCheckOutput('r', {}), /contradictions/);
  assert.throws(
    () => parseCheckOutput('r', { contradictions: [contradiction('X99_MADE_UP', 'a', 'b')] }),
    /unknown contradiction code/,
  );
  assert.throws(
    () =>
      parseCheckOutput('r', { contradictions: [contradiction('X1_NULLABILITY', 'a', 'b', 1.5)] }),
    /confidence/,
  );
});

test('an UNKNOWN detector is never reported as clean, and a quiet one is', () => {
  const outcomes = detectorOutcomes(
    [finding('r', 'X2_TYPE', 'r:Column:a', 'r:SchemaProperty:b')],
    new Map([['X1_NULLABILITY' as const, 'scope contracts is FAIL']]),
  );
  assert.equal(outcomes.X1_NULLABILITY.state, 'unknown');
  assert.equal(outcomes.X2_TYPE.state, 'fired');
  assert.equal(outcomes.X2_TYPE.findings, 1);
  assert.equal(outcomes.X5_UNWRITTEN_COLUMN.state, 'clean');
});

test('a repository the harness could not analyse has every detector UNKNOWN', () => {
  const outcomes = allUnknown('extract timed out');
  assert.equal(Object.keys(outcomes).length, 10);
  for (const outcome of Object.values(outcomes)) {
    assert.equal(outcome.state, 'unknown');
    assert.equal(outcome.reason, 'extract timed out');
  }
});
