import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTypeText, splitTopLevelUnion, stripImportQualifiers } from './typetext.ts';

test('splitTopLevelUnion ignores separators nested in generics, arrays, and strings', () => {
  assert.deepEqual(splitTopLevelUnion('string | null'), ['string', 'null']);
  assert.deepEqual(splitTopLevelUnion('Map<string | number, boolean>'), ['Map<string | number, boolean>']);
  assert.deepEqual(splitTopLevelUnion('("a" | "b")[] | null'), ['("a" | "b")[]', 'null']);
  assert.deepEqual(splitTopLevelUnion('"a|b" | "c"'), ['"a|b"', '"c"']);
});

test('stripImportQualifiers removes the absolute paths the checker prints', () => {
  assert.equal(
    stripImportQualifiers('import("/mnt/d/repo/src/models/user").User[]'),
    'User[]',
  );
  assert.equal(stripImportQualifiers("import('/x/y').A | import('/x/z').B"), 'A | B');
});

test('a union is sorted, so member order in source does not change the output', () => {
  assert.equal(normalizeTypeText('string | null').rawType, normalizeTypeText('null | string').rawType);
  assert.equal(normalizeTypeText('null | string').rawType, 'null | string');
});

test('optionality and nullability are separated from the base type', () => {
  const optionalNullable = normalizeTypeText('string | null | undefined', 'nickname');
  assert.equal(optionalNullable.baseType, 'string');
  assert.equal(optionalNullable.nullable, true);
  assert.equal(optionalNullable.hasUndefined, true);

  const plain = normalizeTypeText('string', 'nickname');
  assert.equal(plain.nullable, false);
  assert.equal(plain.hasUndefined, false);
  assert.equal(plain.baseType, 'string');
});

test('normalized categories are the coarse join keys infer-join matches on', () => {
  assert.equal(normalizeTypeText('string', 'email').normalized, 'string');
  assert.equal(normalizeTypeText('string', 'userUuid').normalized, 'uuid');
  assert.equal(normalizeTypeText('number', 'count').normalized, 'number');
  assert.equal(normalizeTypeText('boolean', 'flag').normalized, 'boolean');
  assert.equal(normalizeTypeText('Date | null', 'deletedAt').normalized, 'date');
  assert.equal(normalizeTypeText('string[]', 'tags').normalized, 'array');
  assert.equal(normalizeTypeText('Profile | undefined', 'profile').normalized, 'object');
  assert.equal(normalizeTypeText('Buffer', 'blob').normalized, 'buffer');
});

test('a literal union is an enum, and its values are unquoted for cross-domain comparison', () => {
  const info = normalizeTypeText("'banned' | 'active'", 'status');
  assert.equal(info.normalized, 'enum');
  assert.deepEqual(info.enumValues, ['active', 'banned']);
});

test('null and undefined are removed from the joinable base type, not from the raw type', () => {
  const info = normalizeTypeText('Date | null', 'deletedAt');
  assert.equal(info.baseType, 'Date');
  assert.equal(info.rawType, 'Date | null');
});
