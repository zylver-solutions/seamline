// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';
import { writeStringLength } from './write-length.ts';

function length(source: string, budget = 64) {
  const file = ts.createSourceFile('input.ts', `const value = ${source};`, ts.ScriptTarget.Latest, true);
  const statement = file.statements[0];
  assert.ok(statement !== undefined && ts.isVariableStatement(statement));
  const expression = statement.declarationList.declarations[0]?.initializer;
  assert.ok(expression !== undefined);
  return writeStringLength(ts, expression, new Set(['z']), budget);
}

test('length grammar positively proves unbounded and one literal upper bound', () => {
  for (const expression of ['z.string()', 'z.string().optional()',
    '(z.string().nullable()).nullish()', 'z.string().optional().nullable()']) {
    assert.deepEqual(length(expression), { state: 'unbounded' }, expression);
  }
  for (const [expression, maxLength] of [['z.string().max(200).optional()', 200],
    ['z.string().nullable().length(0)', 0], ['z.string().max(1e3)', 1000]] as const) {
    assert.deepEqual(length(expression), { state: 'bounded', maxLength }, expression);
  }
});

test('unsupported, dynamic, repeated or invalid operations never become unbounded', () => {
  for (const expression of ['z.string().max(limit)', 'z.string().max(-1)', 'z.string().max(1.5)',
    'z.string().max(9007199254740992)', 'z.string().max(1).max(2)', 'z.string().length(1).max(2)',
    'z.string().min(1)', 'z.string().regex(/x/)', 'z.string().default("")',
    'z.string().catch("")', 'z.string().transform(f)', 'z.string().refine(f)',
    'z.string().pipe(other)', 'z.coerce.string()', 'other.string()', 'alias',
    'z.enum(["a"])', 'z.string({error: f})', 'z.string().optional(f)',
    'z.string().max(1, f)', 'z["string"]()', 'z.string?.()', 'z.string<string>()']) {
    assert.deepEqual(length(expression), { state: 'unknown' }, expression);
  }
  assert.deepEqual(length('z.string().optional()', 1), { state: 'unknown' });
});
