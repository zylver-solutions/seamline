/**
 * `unknownWriterTables`: the one list prop where "empty" and "not measured" are different facts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listProp, strProp, unknownWriterTables } from './props.ts';

describe('unknownWriterTables', () => {
  it('an empty string is a measured, empty list; an absent prop is not measured', () => {
    assert.deepEqual(unknownWriterTables({ unknownWriterTables: '' }), []);
    assert.equal(unknownWriterTables({}), undefined);
  });

  it('a non-string value is not measured, whatever it holds', () => {
    assert.equal(unknownWriterTables({ unknownWriterTables: 0 }), undefined);
    assert.equal(unknownWriterTables({ unknownWriterTables: null }), undefined);
    assert.equal(unknownWriterTables({ unknownWriterTables: false }), undefined);
  });

  it('a list comes back sorted and trimmed', () => {
    assert.deepEqual(unknownWriterTables({ unknownWriterTables: 'User, Account,Session' }), [
      'Account',
      'Session',
      'User',
    ]);
  });

  it('listProp and strProp cannot tell the two apart, which is why this accessor exists', () => {
    assert.equal(listProp({ unknownWriterTables: '' }, 'unknownWriterTables'), undefined);
    assert.equal(listProp({}, 'unknownWriterTables'), undefined);
    assert.equal(strProp({ unknownWriterTables: '' }, 'unknownWriterTables'), undefined);
    assert.notDeepEqual(unknownWriterTables({ unknownWriterTables: '' }), unknownWriterTables({}));
  });
});
