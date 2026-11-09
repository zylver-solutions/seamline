// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { DEFAULT_LIMITS } from './types.ts';
import { summarizeWriteParser } from './write-parser.ts';
import { WriteSource } from './write-source.ts';

// Original generic fixture. It is parsed only; no source module is evaluated.
const reader = `async function readBody(incoming: Request) {
  try { return await incoming.clone().json(); }
  catch { return undefined; }
}`;
const parser = `${reader}
export async function decodeInput(incoming: Request, validator: any) {
  let queryValues = {};
  let payload = await readBody(incoming);
  let problem;
  if (validator) {
    const useQuery = incoming.method === 'GET';
    const oldQuery = queryValues;
    const parsed = validator.safeParse(useQuery ? queryValues : payload);
    if (!parsed.success) { problem = () => rejectInput(parsed.error); }
    else if (useQuery) { queryValues = parsed.data; }
    else { payload = parsed.data; }
  }
  return {payload, problem};
}`;

function summary(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'write-parser-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"@sample/forms"}');
    writeFileSync(join(root, 'parser.ts'), source);
    const project = new WriteSource(ts, root, DEFAULT_LIMITS);
    const declaration = project.exported(project.parse('parser.ts'), 'decodeInput');
    return summarizeWriteParser(project, declaration);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a source-proved non-GET parser preserves successful data and a truthy failure guard', () => {
  assert.deepEqual(summary(parser), {
    bodyKey: 'payload', errorKey: 'problem', functionName: 'decodeInput', file: 'parser.ts',
  });
});

test('a disjoint GET branch does not waive source-world unknown capability extraction', () => {
  const dynamic = parser.replace('queryValues = parsed.data;',
    'queryValues = parsed.data; for (const key of Object.keys(oldQuery)) { queryValues[key] = oldQuery[key]; }');
  assert.throws(() => summary(dynamic), /WRITE_COMPUTED_PROPERTY_UNKNOWN/);
});

test('successful parse, raw request source, error truthiness and immutable forwarding are independent controls', () => {
  const mutations = [
    parser.replace('.safeParse(', '.parse('),
    parser.replace('payload = await readBody', 'payload = readBody'),
    parser.replace('validator: any)', '...validator: any[])'),
    parser.replace('readBody(incoming: Request)', 'readBody(...incoming: Request[])'),
    parser.replace('readBody(incoming: Request)', 'readBody(incoming: Request = replacement)'),
    parser.replace('async function decodeInput', 'async function* decodeInput'),
    parser.replace('async function readBody', 'function readBody'),
    parser.replace("incoming.method === 'GET'", 'true'),
    parser.replace('problem = () => rejectInput(parsed.error)', 'problem = undefined'),
    parser.replace('payload = parsed.data', 'payload = parsed.data.trim()'),
    parser.replace('incoming.clone().json()', 'other.clone().json()'),
    parser.replace('return {payload, problem}', 'return {payload: raw, problem}'),
    parser.replace('return {payload, problem}', 'consume(payload); return {payload, problem}'),
    parser.replace('let queryValues = {};', 'let queryValues = {}; const ignored = eval("payload = raw");'),
    parser + '\ndecodeInput = replacement;',
    parser + '\nreadBody = replacement;',
  ];
  for (const source of mutations) assert.throws(() => summary(source), /WRITE_/, source);
});

test('authentication may only add a callable error after the successful parse branch', () => {
  const authenticated = parser.replace('validator: any)', 'validator: any, preferences?: any)')
    .replace('let problem;', 'let problem; let user = null;')
    .replace('return {payload, problem};', `if (!preferences?.skipAuth && !problem) {
      user = await authorize(incoming);
      if (!user) { problem = () => rejectAuth(); }
    }
    return {payload, problem};`);
  assert.equal(summary(authenticated).bodyKey, 'payload');
  for (const source of [
    authenticated.replace('&& !problem', '|| !problem'),
    authenticated.replace('problem = () => rejectAuth()', 'problem = undefined'),
    authenticated.replace('authorize(incoming)', 'authorize(payload)'),
    authenticated.replace('if (!user)', 'if (user)'),
  ]) assert.throws(() => summary(source), /WRITE_/);
});
