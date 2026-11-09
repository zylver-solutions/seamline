import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSqlType } from './normalize-type.ts';

test('representative SQL types map to the right canonical spelling and category', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['int4', 'integer', 'integer'],
    ['integer', 'integer', 'integer'],
    ['bigint', 'bigint', 'integer'],
    ['smallserial', 'smallint', 'integer'],
    ['bigserial', 'bigint', 'integer'],
    ['varchar(255)', 'character varying(255)', 'text'],
    ['CHARACTER VARYING(255)', 'character varying(255)', 'text'],
    ['text', 'text', 'text'],
    ['citext', 'citext', 'text'],
    ['bool', 'boolean', 'boolean'],
    ['timestamptz', 'timestamp with time zone', 'timestamp'],
    ['timestamp(3) with time zone', 'timestamp(3) with time zone', 'timestamp'],
    ['timestamp without time zone', 'timestamp without time zone', 'timestamp'],
    ['date', 'date', 'timestamp'],
    ['numeric(12,2)', 'numeric(12,2)', 'numeric'],
    ['decimal(10,4)', 'numeric(10,4)', 'numeric'],
    ['float8', 'double precision', 'numeric'],
    ['double precision', 'double precision', 'numeric'],
    ['jsonb', 'jsonb', 'json'],
    ['json', 'json', 'json'],
    ['uuid', 'uuid', 'uuid'],
    // Not modelled: abstaining beats guessing, because a wrong category
    // manufactures an X2 type contradiction.
    ['bytea', 'bytea', 'other'],
    ['inet', 'inet', 'other'],
    ['interval', 'interval', 'other'],
  ];
  for (const [input, expectedType, expectedCategory] of cases) {
    const n = normalizeSqlType(input);
    assert.equal(n.type, expectedType, `type for ${input}`);
    assert.equal(n.category, expectedCategory, `category for ${input}`);
  }
});

test('length, precision and scale are read off the declared type', () => {
  const varchar = normalizeSqlType('varchar(64)');
  assert.equal(varchar.maxLength, 64);
  assert.equal(varchar.numericPrecision, null);

  const numeric = normalizeSqlType('numeric(12,2)');
  assert.equal(numeric.numericPrecision, 12);
  assert.equal(numeric.numericScale, 2);
  assert.equal(numeric.maxLength, null);

  const plain = normalizeSqlType('text');
  assert.equal(plain.maxLength, null);
});

test('array types keep the element category and are flagged', () => {
  const a = normalizeSqlType('text[]');
  assert.equal(a.isArray, true);
  assert.equal(a.category, 'text');
  assert.equal(a.type, 'text[]');

  const b = normalizeSqlType('integer ARRAY');
  assert.equal(b.isArray, true);
  assert.equal(b.category, 'integer');

  const scalar = normalizeSqlType('text');
  assert.equal(scalar.isArray, false);
});

test('serial types carry an implicit default but a plain integer does not', () => {
  assert.equal(normalizeSqlType('serial').implicitDefault, true);
  assert.equal(normalizeSqlType('bigserial').implicitDefault, true);
  assert.equal(normalizeSqlType('integer').implicitDefault, false);
});

test('a registered enum type is categorized as enum, an unknown one is not', () => {
  const enums = new Set(['user_role']);
  assert.equal(normalizeSqlType('user_role', enums).category, 'enum');
  assert.equal(normalizeSqlType('public.user_role', enums).category, 'enum');
  assert.equal(normalizeSqlType('some_domain', enums).category, 'other');
});

test('declaredType preserves the source spelling that `type` normalizes away', () => {
  const n = normalizeSqlType('VARCHAR(255)');
  assert.equal(n.declaredType, 'varchar(255)');
  assert.equal(n.type, 'character varying(255)');
  assert.notEqual(n.declaredType, n.type);
});
