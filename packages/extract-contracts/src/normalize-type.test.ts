import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeJsonType, readTypeField, unifyCategories } from './normalize-type.ts';
import { TYPE_CATEGORIES, type TypeCategory } from './types.ts';

test('the documented scheme maps each JSON type to its cross-domain category', () => {
  const cases: ReadonlyArray<readonly [string | null, string | null, boolean, TypeCategory]> = [
    ['string', null, false, 'text'],
    ['string', 'uuid', false, 'uuid'],
    ['string', 'guid', false, 'uuid'],
    ['string', 'date-time', false, 'timestamp'],
    ['string', 'date', false, 'timestamp'],
    ['string', 'time', false, 'timestamp'],
    ['string', 'email', false, 'text'],
    ['string', 'binary', false, 'text'],
    ['integer', null, false, 'integer'],
    ['integer', 'int64', false, 'integer'],
    ['number', null, false, 'numeric'],
    ['number', 'double', false, 'numeric'],
    ['number', 'int32', false, 'integer'],
    ['boolean', null, false, 'boolean'],
    ['object', null, false, 'json'],
    ['null', null, false, 'unknown'],
    [null, null, false, 'unknown'],
    ['widget', null, false, 'unknown'],
  ];
  for (const [type, format, hasEnum, expected] of cases) {
    assert.equal(
      categorizeJsonType(type, format, hasEnum),
      expected,
      `type=${String(type)} format=${String(format)}`,
    );
  }
});

test('an enum outranks its base type, because X3 and X7 compare member sets', () => {
  assert.equal(categorizeJsonType('string', null, true), 'enum');
  assert.equal(categorizeJsonType('integer', null, true), 'enum');
  assert.equal(categorizeJsonType(null, null, true), 'enum');
});

test('every category the scheme can produce is a declared TypeCategory', () => {
  const produced = new Set<string>();
  for (const type of ['string', 'integer', 'number', 'boolean', 'object', 'array', 'null', null]) {
    for (const format of [null, 'uuid', 'date-time', 'int64', 'double', 'email']) {
      produced.add(categorizeJsonType(type, format, false));
    }
  }
  for (const c of produced) {
    assert.ok((TYPE_CATEGORIES as readonly string[]).includes(c), `${c} is not a TypeCategory`);
  }
});

test('disagreeing branches unify to unknown rather than to a guess', () => {
  assert.equal(unifyCategories(['text', 'text']), 'text');
  assert.equal(unifyCategories(['text', 'integer']), 'unknown');
  assert.equal(unifyCategories(['unknown', 'timestamp']), 'timestamp');
  assert.equal(unifyCategories(['unknown', 'unknown']), 'unknown');
  assert.equal(unifyCategories([]), 'unknown');
});

test('a "null" member of a type array is nullability, not a type', () => {
  const arrayType = readTypeField({ type: ['string', 'null'] });
  assert.equal(arrayType.type, 'string');
  assert.equal(arrayType.typeIsNullable, true);
  assert.equal(arrayType.rawType, 'null|string');

  const plain = readTypeField({ type: 'string' });
  assert.equal(plain.type, 'string');
  assert.equal(plain.typeIsNullable, false);

  const ambiguous = readTypeField({ type: ['string', 'integer'] });
  assert.equal(ambiguous.type, null, 'two real types are not one type');
  assert.equal(ambiguous.rawType, 'integer|string', 'raw type is sorted, so it is stable');

  const shapeOnly = readTypeField({ properties: { a: { type: 'string' } } });
  assert.equal(shapeOnly.type, 'object', 'a declared shape is an object even with no type keyword');
});
