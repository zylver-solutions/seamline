import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compareTypes, normalizeType } from './typecat.ts';

describe('normalizeType', () => {
  it('normalizes SQL spellings', () => {
    assert.equal(normalizeType('int4'), 'integer');
    assert.equal(normalizeType('bigserial'), 'integer');
    assert.equal(normalizeType('varchar(255)'), 'text');
    assert.equal(normalizeType('character varying(64)'), 'text');
    assert.equal(normalizeType('numeric(10,2)'), 'numeric');
    assert.equal(normalizeType('timestamp with time zone'), 'timestamp');
    assert.equal(normalizeType('timestamptz'), 'timestamp');
    assert.equal(normalizeType('jsonb'), 'json');
    assert.equal(normalizeType('uuid'), 'uuid');
    assert.equal(normalizeType('boolean'), 'boolean');
  });

  it('normalizes TypeScript spellings', () => {
    assert.equal(normalizeType('string'), 'text');
    assert.equal(normalizeType('number'), 'numeric');
    assert.equal(normalizeType('bigint'), 'integer');
    assert.equal(normalizeType('Date'), 'timestamp');
    assert.equal(normalizeType('Record<string, unknown>'), 'json');
    assert.equal(normalizeType('string[]'), 'json');
  });

  it('strips nullable union members and keeps the payload type', () => {
    assert.equal(normalizeType('string | null'), 'text');
    assert.equal(normalizeType('Date | undefined'), 'timestamp');
  });

  it('reads a union of string literals as an enum', () => {
    assert.equal(normalizeType("'draft' | 'published'"), 'enum');
  });

  it('lets a JSON Schema format override the base type', () => {
    assert.equal(normalizeType('string', 'date-time'), 'timestamp');
    assert.equal(normalizeType('string', 'uuid'), 'uuid');
    assert.equal(normalizeType('integer', 'int64'), 'integer');
    assert.equal(normalizeType('string', 'email'), 'text');
  });

  it('accepts an already-normalized category', () => {
    assert.equal(normalizeType('timestamp'), 'timestamp');
  });

  it('returns unknown rather than guessing', () => {
    assert.equal(normalizeType(undefined), 'unknown');
    assert.equal(normalizeType(''), 'unknown');
    assert.equal(normalizeType('SomeCustomAlias'), 'unknown');
    assert.equal(normalizeType('string | number'), 'unknown');
  });
});

describe('compareTypes', () => {
  it('reports equality', () => {
    assert.equal(compareTypes('timestamp', 'timestamp'), 'equal');
  });

  it('reports known cross-representation encodings as compatible', () => {
    assert.equal(compareTypes('text', 'uuid'), 'compatible');
    assert.equal(compareTypes('integer', 'numeric'), 'compatible');
    assert.equal(compareTypes('text', 'timestamp'), 'compatible');
    assert.equal(compareTypes('boolean', 'integer'), 'compatible');
    assert.equal(compareTypes('enum', 'text'), 'compatible');
  });

  it('is symmetric', () => {
    assert.equal(compareTypes('uuid', 'text'), compareTypes('text', 'uuid'));
    assert.equal(compareTypes('boolean', 'timestamp'), compareTypes('timestamp', 'boolean'));
  });

  it('reports a genuine disagreement as a conflict', () => {
    assert.equal(compareTypes('boolean', 'timestamp'), 'conflict');
    assert.equal(compareTypes('json', 'uuid'), 'conflict');
  });

  it('never manufactures a conflict from an unread type', () => {
    assert.equal(compareTypes('unknown', 'boolean'), 'unknown');
    assert.equal(compareTypes('timestamp', 'unknown'), 'unknown');
  });
});
