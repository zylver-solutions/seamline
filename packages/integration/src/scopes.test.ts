/**
 * Cross-package regression coverage for scope-name agreement.
 *
 * `packages/contradictions/src/scopes.ts` hand-duplicates five scope-name
 * string constants rather than importing them, specifically so
 * `@seamline/contradictions` can keep depending on `@seamline/ontology` alone.
 * Nothing before this package could import both sides at once to check they
 * still agree -- a renamed scope in a producing package would silently make
 * every detector that needs it report UNAVAILABLE forever, with no failing
 * test anywhere in the tree.
 *
 * This suite imports every producer's own scope constant and manifest
 * alongside `@seamline/contradictions`'s copies and asserts they still agree,
 * pairwise, as a set, and against what each manifest actually declares as its
 * authoritative `produces` scope (not just the bare exported string, so a
 * constant that drifted from its own manifest would also be caught).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODE_TS_AUTHORITATIVE,
  CODE_TS_SCOPE,
  manifest as codeTsManifest,
} from '@seamline/extract-code-ts';
import { DATA_SCOPE, MANIFEST as dataManifest } from '@seamline/extract-data';
import { CONTRACTS_SCOPE, MANIFEST as contractsManifest } from '@seamline/extract-contracts';
import { CHANGE_MANIFEST, CHANGE_SCOPE } from '@seamline/extract-change';
import { INFER_JOIN_MANIFEST, INFER_JOIN_SCOPE, REQUIRED_SCOPES } from '@seamline/infer-join';

import {
  SCOPE_CHANGE,
  SCOPE_CODE,
  SCOPE_CONTRACTS,
  SCOPE_DATA,
  SCOPE_JOIN,
  SCOPES,
} from '@seamline/contradictions';

test('each contradictions scope constant matches its producer package exactly', () => {
  assert.equal(SCOPE_CODE, CODE_TS_SCOPE, 'SCOPE_CODE vs extract-code-ts CODE_TS_SCOPE');
  assert.equal(SCOPE_DATA, DATA_SCOPE, 'SCOPE_DATA vs extract-data DATA_SCOPE');
  assert.equal(SCOPE_CONTRACTS, CONTRACTS_SCOPE, 'SCOPE_CONTRACTS vs extract-contracts CONTRACTS_SCOPE');
  assert.equal(SCOPE_CHANGE, CHANGE_SCOPE, 'SCOPE_CHANGE vs extract-change CHANGE_SCOPE');
  assert.equal(SCOPE_JOIN, INFER_JOIN_SCOPE, 'SCOPE_JOIN vs infer-join INFER_JOIN_SCOPE');
});

test('the full scope sets are identical between the producers and contradictions', () => {
  // Deliberately built independently of the pairwise test above, so an added
  // scope forgotten on one side (not just a renamed one) fails loudly too.
  const producerScopes = [CODE_TS_SCOPE, DATA_SCOPE, CONTRACTS_SCOPE, CHANGE_SCOPE, INFER_JOIN_SCOPE];
  assert.deepEqual([...SCOPES].sort(), [...producerScopes].sort());
  assert.equal(SCOPES.length, producerScopes.length, 'no scope may be silently dropped from either side');
  assert.equal(new Set(SCOPES).size, SCOPES.length, 'contradictions must not declare a scope twice');
});

test('each producer manifest actually declares its own scope constant as authoritative', () => {
  // This is the check that would have caught the class of bug where the
  // exported constant and the manifest's real `produces` entry drift apart --
  // a bare string-equality check against the constant alone would not.
  assert.ok(
    CODE_TS_AUTHORITATIVE.some((s) => s.scope === CODE_TS_SCOPE),
    'CODE_TS_AUTHORITATIVE must declare CODE_TS_SCOPE',
  );
  assert.ok(
    codeTsManifest.produces.some((s) => s.scope === CODE_TS_SCOPE),
    'extract-code-ts manifest.produces must declare CODE_TS_SCOPE',
  );
  assert.ok(
    dataManifest.produces.some((s) => s.scope === DATA_SCOPE),
    'extract-data MANIFEST.produces must declare DATA_SCOPE',
  );
  assert.ok(
    contractsManifest.produces.some((s) => s.scope === CONTRACTS_SCOPE),
    'extract-contracts MANIFEST.produces must declare CONTRACTS_SCOPE',
  );
  assert.ok(
    CHANGE_MANIFEST.produces.some((s) => s.scope === CHANGE_SCOPE),
    'extract-change CHANGE_MANIFEST.produces must declare CHANGE_SCOPE',
  );
  assert.ok(
    INFER_JOIN_MANIFEST.produces.some((s) => s.scope === INFER_JOIN_SCOPE),
    'infer-join INFER_JOIN_MANIFEST.produces must declare INFER_JOIN_SCOPE',
  );
});

test('infer-join REQUIRED_SCOPES names real producer scope strings, not extractor package names', () => {
  // A distinct bug class from the producer/contradictions drift above:
  // REQUIRED_SCOPES is infer-join's own list of scopes it *reads*, and a prior
  // bug on this branch listed extractor package names ('extract-code-ts')
  // instead of the scope strings ('code.ts') those packages actually declare.
  // Cross-checking against the real producer constants (not hand-typed
  // literals) is what makes a repeat of that renaming drift a test failure.
  const expected = [CODE_TS_SCOPE, CONTRACTS_SCOPE, DATA_SCOPE].sort();
  assert.deepEqual([...REQUIRED_SCOPES].sort(), expected);
});
