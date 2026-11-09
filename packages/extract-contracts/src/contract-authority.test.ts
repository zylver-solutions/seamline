// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileCanonicalSelector, MAX_CANONICAL_SELECTOR_BYTES, MAX_CANONICAL_SELECTOR_RULES } from '@seamline/core';
import { canonicalContractAuthority } from './contract-authority.ts';

test('known names receive separate exact Contract and literal-prefix SchemaProperty claims', () => {
  const candidate = { name: 'A', file: 'src/a.ts' };
  const result = canonicalContractAuthority([candidate], [candidate, { name: 'AB', file: 'src/a.ts' }], true);
  assert.deepEqual([...result.withheld], []);
  assert.deepEqual(result.claims.map(claim => claim.kinds), [['Contract'], ['SchemaProperty']]);
  const contract = compileCanonicalSelector(result.claims[0]!.selector!);
  const properties = compileCanonicalSelector(result.claims[1]!.selector!);
  assert.equal(contract.path, 'src/a.ts');
  assert.equal(contract.matchesName('A'), true);
  assert.equal(contract.matchesName('AB'), false);
  assert.equal(contract.matchesName('A#/properties/title'), false);
  assert.equal(properties.matchesName('A#/properties/title'), true);
  assert.equal(properties.matchesName('AB#/properties/title'), false);
  assert.equal(properties.matchesName('A'), false);
});

test('unknown roots, duplicate identities and overlapping legacy families cannot receive canonical authority', () => {
  const a = { name: 'A', file: 'src/a.ts' };
  const unrelated = { name: 'AB', file: 'src/a.ts' };
  const family = [{ name: 'A#/B', file: 'legacy.json' }, { name: 'A#/B#/C', file: 'nested.json' }];
  const overlap = canonicalContractAuthority([a, unrelated], [...family, a, unrelated], true);
  assert.deepEqual([...overlap.withheld].sort(), ['A', 'A#/B', 'A#/B#/C']);
  assert.equal(overlap.claims.length, 2, 'the disjoint AB family remains eligible');
  assert.equal(compileCanonicalSelector(overlap.claims[0]!.selector!).matchesName('AB'), true);
  const duplicate = canonicalContractAuthority([a], [a, { ...a, file: 'src/other.ts' }], true);
  assert.equal(duplicate.claims.length, 0);
  assert.equal(duplicate.withheld.has('A'), true);
  const unknown = canonicalContractAuthority([a], [a], false);
  assert.equal(unknown.claims.length, 0);
  assert.equal(unknown.withheld.has('A'), true);
});

test('producer budgets refuse before a filename or partial canonical fallback can be returned', () => {
  const tooMany = Array.from({ length: Math.floor(MAX_CANONICAL_SELECTOR_RULES / 2) + 1 }, (_, i) =>
    ({ name: `A${i}`, file: 'src/a.ts' }));
  assert.throws(() => canonicalContractAuthority(tooMany, [], true), /canonical producer rule budget/);
  assert.throws(() => canonicalContractAuthority([{ name: 'x'.repeat(MAX_CANONICAL_SELECTOR_BYTES), file: 'src/a.ts' }], [], true),
    /canonical byte budget/);
});

test('a withheld write name protects its family without becoming an authority candidate', () => {
  const reserved = { name: 'A', file: 'src/opaque.ts' };
  const nested = { name: 'A#/B', file: 'legacy.json' };
  const unrelated = { name: 'C', file: 'src/known.ts' };
  const coverage = canonicalContractAuthority([unrelated], [reserved, nested, unrelated], true, [reserved, unrelated]);
  assert.deepEqual([...coverage.withheld].sort(), ['A', 'A#/B']);
  assert.equal(coverage.claims.length, 2);
  for (const claim of coverage.claims) {
    const selector = compileCanonicalSelector(claim.selector!);
    assert.equal(selector.path, unrelated.file);
    assert.equal(selector.matchesName('A'), false);
    assert.equal(selector.matchesName('A#/B#/properties/retained'), false);
  }
  assert.equal(compileCanonicalSelector(coverage.claims[0]!.selector!).matchesName('C'), true);
});
