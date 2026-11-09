import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRADICTION_CODES, type ContradictionCode } from '@seamline/ontology';
import { DETECTOR_ROLES, fitsKind, referencedKindsIn, roleProblem } from './roles.ts';

test('a match is accepted on the side its node sits on and refused on the other, for each detector', () => {
  const column = 'public.user.email';
  const property = 'evalPhantomField';
  const symbol = 'src/db/write.ts#writeEmail';
  // [detector, side, match, accepted]
  const cases: ReadonlyArray<readonly [ContradictionCode, 'left' | 'right', string, boolean]> = [
    ['X1_NULLABILITY', 'left', column, true],
    ['X1_NULLABILITY', 'right', column, false],
    ['X1_NULLABILITY', 'right', property, true],
    ['X2_TYPE', 'left', column, true],
    ['X2_TYPE', 'right', property, true],
    ['X3_CONSTRAINT', 'left', column, true],
    ['X3_CONSTRAINT', 'right', column, false],
    ['X3_CONSTRAINT', 'right', symbol, true],
    ['X3_CONSTRAINT', 'left', symbol, false],
    ['X4_UNBACKED_PROPERTY', 'left', property, true],
    ['X4_UNBACKED_PROPERTY', 'right', property, false],
    ['X4_UNBACKED_PROPERTY', 'right', column, true],
    ['X5_UNWRITTEN_COLUMN', 'left', column, true],
    ['X5_UNWRITTEN_COLUMN', 'right', symbol, true],
    ['X5_UNWRITTEN_COLUMN', 'right', column, false],
    ['X6_PII_UNAUTHENTICATED', 'right', column, true],
    ['X6_PII_UNAUTHENTICATED', 'right', symbol, false],
    ['X7_VALIDATOR_DIVERGENCE', 'left', column, true],
    ['X7_VALIDATOR_DIVERGENCE', 'right', column, false],
    ['X7_VALIDATOR_DIVERGENCE', 'right', 'SchemaProperty:writeInput#/properties/title', true],
    ['X7_VALIDATOR_DIVERGENCE', 'right', 'Symbol:module#validator', false],
    ['X8_ORPHANED_MIGRATION', 'right', 'eval_ghost_table', true],
    ['X8_ORPHANED_MIGRATION', 'right', symbol, false],
    ['X8_ORPHANED_MIGRATION', 'right', 'Migration:002_create', true],
    ['X8_ORPHANED_MIGRATION', 'right', 'Table:public.accounts', false],
    ['X10_UNTESTED_PII_WRITE', 'right', column, true],
    ['X10_UNTESTED_PII_WRITE', 'left', column, false],
    ['X10_UNTESTED_PII_WRITE', 'left', symbol, true],
    // X9 reports an Operation and a RouteHandler in either order (an operation nobody serves
    // puts the operation on the left; a route nobody declares puts the handler there), and no
    // shape tells the two apart, so no match can be on the wrong side. What a match can get
    // wrong is the kind: X9 never reports a column.
    ['X9_CONTRACT_DRIFT', 'left', 'GET /user.all', true],
    ['X9_CONTRACT_DRIFT', 'right', 'GET /user.all', true],
    ['X9_CONTRACT_DRIFT', 'left', 'Operation:GET /user.all', true],
    ['X9_CONTRACT_DRIFT', 'right', 'RouteHandler:GET /user.all', true],
    ['X9_CONTRACT_DRIFT', 'left', `Column:${column}`, false],
    ['X9_CONTRACT_DRIFT', 'right', `Column:${column}`, false],
  ];
  for (const [code, side, match, accepted] of cases) {
    assert.equal(roleProblem(code, side, match) === null, accepted, `${code} ${side} ${match}`);
  }
  // Every detector has something on each side, so a match for it can be judged at all.
  for (const code of CONTRADICTION_CODES) {
    assert.ok(DETECTOR_ROLES[code].left.length > 0 && DETECTOR_ROLES[code].right.length > 0, code);
  }
});

test('referencedKindsIn reads the kinds a detector source follows, and nothing else', () => {
  const source = [
    "for (const column of factNodes(g, 'Column')) {",
    "  for (const j of followAny(g, column.id, COLUMN_TO_VALIDATOR, 'Symbol')) {",
    "    if (j.node.kind !== 'CodeField') continue;",
    "    const label = 'Contract'; // not a kind-bearing line",
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(referencedKindsIn(source), ['CodeField', 'Column', 'Symbol']);
});

test('a column id is dotted; a property or a symbol is not', () => {
  assert.ok(fitsKind('public.board.name', 'Column'));
  assert.ok(fitsKind('user.email', 'Column'));
  assert.ok(!fitsKind('evalPhantomField', 'Column'), 'a bare name is not a column id');
  assert.ok(fitsKind('evalPhantomField', 'SchemaProperty'));
  assert.ok(fitsKind('@pkg/db#evalWriteUserEmail', 'Symbol'));
  assert.ok(!fitsKind('user.email', 'Symbol'), 'a dotted column is not a symbol');
});

test('the two sides the first mutants got wrong are named as wrong-side matches', () => {
  assert.match(
    roleProblem('X4_UNBACKED_PROPERTY', 'right', 'evalPhantomField') ?? '',
    /fits the left side, so the match is on the wrong side/,
  );
  assert.match(
    roleProblem('X10_UNTESTED_PII_WRITE', 'left', 'user.email') ?? '',
    /fits the right side, so the match is on the wrong side/,
  );
  assert.equal(roleProblem('X4_UNBACKED_PROPERTY', 'left', 'evalPhantomField'), null);
  assert.equal(roleProblem('X10_UNTESTED_PII_WRITE', 'right', 'user.email'), null);
});

test('a match that spells its node kind must spell the kind the detector reports on that side', () => {
  assert.equal(roleProblem('X1_NULLABILITY', 'left', 'Column:public.board.name'), null);
  assert.equal(roleProblem('X1_NULLABILITY', 'left', 'umami:Column:public.board.name'), null);
  assert.match(
    roleProblem('X1_NULLABILITY', 'left', 'SchemaProperty:name') ?? '',
    /does not look like Column/,
  );
  assert.equal(roleProblem('X10_UNTESTED_PII_WRITE', 'right', 'Column:public.user.email'), null);
  assert.ok(roleProblem('X10_UNTESTED_PII_WRITE', 'left', 'Column:public.user.email') !== null);
});
