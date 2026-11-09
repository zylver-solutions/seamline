// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { nodeId } from '@seamline/ontology';
import { secretCanary } from '@seamline/security/corpus';
import { decodeWriteContractName, writeContractName, type WriteContractKey } from './write-identity.ts';

test('reversible identity cannot hide credentials in any declared input', () => {
  const canary = secretCanary('aws-access-key-id/documented-example').secret;
  const encodedCanary = Buffer.from(canary).toString('hex');
  const keys: WriteContractKey[] = [
    [canary, ['POST', 'schema'], ['p', ['save']], 'Entry'],
    ['p', ['POST', canary], ['p', ['save']], 'Entry'],
    ['p', ['POST', 'schema'], [canary, ['save']], 'Entry'],
    ['p', ['POST', 'schema'], ['p', [canary]], 'Entry'],
    ['p', ['POST', 'schema'], ['p', ['save']], canary],
  ];
  for (const key of keys) {
    assert.throws(() => writeContractName(key), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(canary), false);
      assert.equal(error.message.includes(encodedCanary), false);
      return true;
    });
    const raw = 'validated-write:' + Buffer.from(JSON.stringify(key)).toString('hex');
    assert.equal(decodeWriteContractName(raw), undefined);
  }
});

test('declared write identity round-trips scoped names and punctuation through canonical validators', () => {
  const key: WriteContractKey = ['@sample/forms', ['POST', 'schéma'], ['@sample/db', ['save', 'a#b/c\\d']], 'Entry'];
  const encoded = writeContractName(key);
  assert.deepEqual(decodeWriteContractName(encoded), key);
  assert.match(encoded, /^validated-write:[0-9a-f]+$/);
  assert.equal(nodeId('sample', 'Contract', encoded), `sample:Contract:${encoded}`);
  assert.equal(nodeId('sample', 'SchemaProperty', `${encoded}#/properties/title`),
    `sample:SchemaProperty:${encoded}#/properties/title`);
  assert.notEqual(encoded, writeContractName(['@sample/forms', ['POST.schéma'], key[2], 'Entry']));
});

test('write identities are injective for the declared tuple and reject alternate encodings', () => {
  const word = fc.string({ minLength: 1, maxLength: 32 });
  const keys = fc.tuple(word, fc.array(word, { minLength: 1, maxLength: 4 }),
    fc.tuple(word, fc.array(word, { minLength: 1, maxLength: 4 })), word);
  fc.assert(fc.property(keys, keys, (a, b) => {
    assert.deepEqual(decodeWriteContractName(writeContractName(a)), a);
    assert.equal(writeContractName(a) === writeContractName(b), JSON.stringify(a) === JSON.stringify(b));
  }), { numRuns: 300 });
  for (const invalid of ['validated-write:', 'validated-write:ff', 'validated-write:5B5D',
    'validated-write:5b5d', 'validated-write:0', 'other:00']) {
    assert.equal(decodeWriteContractName(invalid), undefined, invalid);
  }
  const padded = Buffer.from(JSON.stringify(['p', ['f', 's'], ['p', ['save']], 'Item'], null, 1)).toString('hex');
  assert.equal(decodeWriteContractName(`validated-write:${padded}`), undefined);
});
