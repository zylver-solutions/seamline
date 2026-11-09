import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toJsonSchema, validateParams, type ParamSchema } from './validate.ts';

const schema: ParamSchema = {
  symbol: { kind: 'string', required: true, description: 'a symbol', maxLength: 20 },
  depth: { kind: 'integer', required: false, description: 'hops', min: 1, max: 4, fallback: 2 },
  verbose: { kind: 'boolean', required: false, description: 'noisy', fallback: false },
  codes: { kind: 'stringArray', required: false, description: 'codes', maxItems: 2, maxLength: 8, choices: ['X1', 'X2'] },
  mode: { kind: 'string', required: false, description: 'mode', maxLength: 8, choices: ['fast', 'full'] },
};

test('a valid call passes and applies declared fallbacks', () => {
  const r = validateParams(schema, { symbol: 'User' });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { symbol: 'User', depth: 2, verbose: false });
});

test('a missing required parameter is rejected by name', () => {
  const r = validateParams(schema, { depth: 2 });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.errors.join('\n') : '', /missing required parameter `symbol`/);
});

test('a wrong type is rejected and names the type it got', () => {
  const r = validateParams(schema, { symbol: 42 });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.errors.join('\n') : '', /`symbol` must be a string, got number/);
});

test('an unknown parameter is rejected rather than silently ignored', () => {
  const r = validateParams(schema, { symbol: 'User', cypher: 'MATCH (n) RETURN n' });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.errors.join('\n') : '', /unknown parameter `cypher`/);
});

test('an out-of-range integer is rejected', () => {
  for (const depth of [0, -1, 99]) {
    const r = validateParams(schema, { symbol: 'User', depth });
    assert.equal(r.ok, false, `rejected depth=${depth}`);
  }
});

test('a non-integer number is rejected', () => {
  const r = validateParams(schema, { symbol: 'User', depth: 2.5 });
  assert.equal(r.ok, false);
});

test('an over-long string is rejected rather than truncated', () => {
  const r = validateParams(schema, { symbol: 'x'.repeat(21) });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.errors.join('\n') : '', /exceeds the 20-character limit/);
});

test('an empty string is rejected', () => {
  assert.equal(validateParams(schema, { symbol: '' }).ok, false);
});

test('a value outside the declared choices is rejected', () => {
  const r = validateParams(schema, { symbol: 'User', mode: 'raw' });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.errors.join('\n') : '', /must be one of: fast, full/);
});

test('array parameters enforce item type, count, and choices', () => {
  assert.equal(validateParams(schema, { symbol: 'a', codes: 'X1' }).ok, false, 'a bare string is not an array');
  assert.equal(validateParams(schema, { symbol: 'a', codes: [] }).ok, false, 'an empty array is rejected');
  assert.equal(validateParams(schema, { symbol: 'a', codes: ['X1', 'X2', 'X1'] }).ok, false, 'over maxItems');
  assert.equal(validateParams(schema, { symbol: 'a', codes: ['X9'] }).ok, false, 'not a declared choice');
  assert.equal(validateParams(schema, { symbol: 'a', codes: [1] }).ok, false, 'non-string item');
  assert.equal(validateParams(schema, { symbol: 'a', codes: ['X1'] }).ok, true);
});

test('a non-object arguments payload is rejected', () => {
  for (const bad of ['string', 42, [1, 2], true]) {
    const r = validateParams(schema, bad);
    assert.equal(r.ok, false, `rejected: ${JSON.stringify(bad)}`);
  }
});

test('omitted arguments are allowed when nothing is required', () => {
  const optional: ParamSchema = { limit: { kind: 'integer', required: false, description: '', min: 1, max: 5, fallback: 3 } };
  const r = validateParams(optional, undefined);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { limit: 3 });
});

test('null for a required parameter is missing, not a value', () => {
  const r = validateParams(schema, { symbol: null });
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.errors.join('\n') : '', /missing required parameter/);
});

test('the advertised JSON Schema is derived from the same declaration it enforces', () => {
  const json = toJsonSchema(schema) as {
    type: string;
    required: string[];
    additionalProperties: boolean;
    properties: Record<string, Record<string, unknown>>;
  };
  assert.equal(json.type, 'object');
  assert.deepEqual(json.required, ['symbol']);
  assert.equal(json.additionalProperties, false, 'the schema advertises the same allow-list it enforces');
  assert.equal(json.properties['symbol']?.['maxLength'], 20);
  assert.equal(json.properties['depth']?.['minimum'], 1);
  assert.equal(json.properties['depth']?.['maximum'], 4);
  assert.deepEqual(json.properties['mode']?.['enum'], ['fast', 'full']);
  assert.equal(json.properties['codes']?.['maxItems'], 2);
});
