// SPDX-License-Identifier: Apache-2.0
/** Original fixtures for the accepted closed query-copy certificate. */
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { DEFAULT_LIMITS } from './types.ts';
import { WriteSource } from './write-source.ts';
import { permitsQueryDataCopy } from './write-query-copy-proof.ts';
import { isCanonicalSelectorText } from '@seamline/core';
import { extractContracts } from './extract.ts';
import { makeWriteFixture, WRITE_FILES, writeFixtureIndex } from './write-test-support.ts';

const integrity = 'sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg==';
const metadata = {
  'package.json': JSON.stringify({ name: '@sample/forms', dependencies: { next: '16.2.6', zod: '4.3.6' } }),
  'pnpm-lock.yaml': `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      next: {specifier: 16.2.6, version: 16.2.6}
      zod: {specifier: 4.3.6, version: 4.3.6}
packages:
  next@16.2.6:
    resolution: {integrity: sha512-qOVgKJg1+At15NpeUP+eJgCHvTCgXsogweq87Ri/Ix7PkqQHg4sdaXmSFqKlgaIXE4kW0g25LE68W87UANlHtw==}
  zod@4.3.6:
    resolution: {integrity: ${integrity}}
`,
};
const original = WRITE_FILES['src/parser.ts'] as string;
const parser = original.replace('let query = {};', 'let query = Object.fromEntries(new URL(input.url).searchParams);')
  .replace('else if (queryMethod) { query = parsed.data; }', String.raw`else if (queryMethod) {
    query = parsed.data;
    for (const entryKey of Object.keys(originalQuery)) {
      if (/\d+$/.test(entryKey) && !(entryKey in query)) {
        query[entryKey] = originalQuery[entryKey];
      }
    }
  }`);
const getRoute = `import {z} from 'zod';
import {decode} from '../../parser';
export async function GET(request: Request) {
 const schema = z.object({title: z.string().optional(), caption: z.string().optional()});
 return await decode(request, schema);
}`;

function run(extra: Record<string, string> = {}) {
  const fixture = makeWriteFixture({ ...metadata, 'src/parser.ts': parser, 'src/app/read/route.ts': getRoute, ...extra });
  try {
    return extractContracts({ repoRoot: fixture.root, repo: 'write-demo', runId: 'run-query-copy',
      dataModelIndex: writeFixtureIndex('write-demo') });
  } finally { fixture.dispose(); }
}

for (const [label, source] of [['decimal suffix', parser],
  ['explicit decimal class', parser.replace('/\\d+$/', '/[0-9]+$/')]] as const)
  test(`a closed ${label} copy preserves a proved non-GET write and its authority`, () => {
    const output = run({ 'src/parser.ts': source });
    assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
    const strings = output.nodes.filter(node => node.kind === 'SchemaProperty' && ['title', 'caption'].includes(node.name));
    assert.equal(strings.length, 2, output.result.diagnostics.join('\n'));
    assert.ok(strings.every(node => node.props['writeBindingComplete'] === true && node.props['lengthUpperState'] === 'unbounded'));
    assert.ok(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')));
  });

const refusals: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['shared query', { 'src/parser.ts': parser.replace('Object.fromEntries(new URL(input.url).searchParams)', 'sharedQuery') }],
  ['proxy query', { 'src/parser.ts': parser.replace('Object.fromEntries(new URL(input.url).searchParams)', 'new Proxy({}, traps)') }],
  ['mutable saved alias', { 'src/parser.ts': parser.replace('const originalQuery', 'let originalQuery') }],
  ['stateful regex', { 'src/parser.ts': parser.replace('/\\d+$/', '/\\d+$/g') }],
  ['unreviewed digit syntax', { 'src/parser.ts': parser.replace('/\\d+$/', '/.+$/') }],
  ['changed source key', { 'src/parser.ts': parser.replace('originalQuery[entryKey]', "originalQuery['constructor']") }],
  ['removed absence guard', { 'src/parser.ts': parser.replace(' && !(entryKey in query)', '') }],
  ['extra loop effect', { 'src/parser.ts': parser.replace('query[entryKey] = originalQuery[entryKey];', 'query[entryKey] = originalQuery[entryKey]; unknown(query);') }],
  ['await loop', { 'src/parser.ts': parser.replace('for (const entryKey', 'for await (const entryKey') }],
  ['shadowed intrinsic', { 'src/parser.ts': parser.replace('let query =', 'const URL = customURL; let query =') }],
  ['unsupported artifact', { 'pnpm-lock.yaml': metadata['pnpm-lock.yaml'].replace(integrity, 'sha512-unreviewed') }],
  ['custom GET transform', { 'src/app/read/route.ts': getRoute.replace('caption: z.string().optional()});', 'caption: z.string().optional()}).transform(custom);') }],
  ['escaped parser alias', { 'src/escaped.ts': "import {decode} from './parser'; export const indirect = decode;" }],
  ['unresolved parser re-export', { 'src/forwarded.ts': "export {decode as otherParser} from './parser';" }],
  ['other computed extraction in parser', { 'src/parser.ts': parser.replace('let error;', 'let error; const capability = unrelated[unknownKey];') }],
  ['other computed extraction in source world', { 'src/other.ts': 'export const capability = unrelated[unknownKey];' }],
  ['global validator hook', { 'src/hooks.ts': "import {z} from 'zod'; z.config({customError: custom});" }],
];
for (const [label, extra] of refusals) test(`query-copy proof withholds facts for ${label}`, () => {
  const output = run(extra);
  assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), [],
    'an incomplete copy certificate cannot produce complete validated-write facts');
  assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
  assert.ok(output.result.diagnostics.some(diagnostic => diagnostic.includes('WRITE_')));
});

const withUrlAlias = parser.replace('let query = Object.fromEntries(new URL(input.url).searchParams);',
  'const url = new URL(input.url); let query = Object.fromEntries(url.searchParams);')
  .replace('return {body, error};', 'return {url, query, body, error};');

test('an immutable local URL and returned data records retain the same copy certificate', () => {
  const output = run({ 'src/parser.ts': withUrlAlias });
  assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
  const fields = output.nodes.filter(node => node.kind === 'SchemaProperty' && ['title', 'caption'].includes(node.name));
  assert.equal(fields.length, 2);
  assert.ok(fields.every(field => field.props['writeBindingComplete'] === true));
  assert.ok(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')));
});

const extraRefusals: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['inline type import runtime load', { 'src/hooks.ts': "import {type Hidden} from 'unreviewed-effects';" }],
  ['inline type export runtime load', { 'src/hooks.ts': "export {type Hidden} from 'unreviewed-effects';" }],
  ['empty validator re-export runtime load', { 'src/hooks.ts': "export {} from 'zod';" }],
  ['empty validator subpath re-export runtime load', { 'src/hooks.ts': "export {} from 'zod/v4/core';" }],
  ['imported intrinsic capability', {
    'package.json': JSON.stringify({ name: '@sample/forms', dependencies: {
      next: '16.2.6', zod: '4.3.6', 'get-intrinsic': '1.3.0',
    } }),
    'src/parser.ts': "import './hooks';\n" + parser,
    'src/hooks.ts': "import getIntrinsic from 'get-intrinsic'; const ordinary = getIntrinsic('%Object%'); ordinary.fromEntries = () => ({extra1: () => {}});",
  }],
  ['external side-effect import', { 'src/hooks.ts': "import 'unreviewed-effects';" }],
  ['external runtime re-export', { 'src/hooks.ts': "export {configure} from 'unreviewed-effects';" }],
  ['external CommonJS capability', { 'src/hooks.ts': "const getIntrinsic = require('get-intrinsic'); const ordinary = getIntrinsic('%Object%'); ordinary.fromEntries = () => ({extra1: () => {}});" }],
  ['external dynamic capability', { 'src/hooks.ts': "const imported = await import('get-intrinsic'); const ordinary = imported.default('%Object%'); ordinary.fromEntries = () => ({extra1: () => {}});" }],
  ['validator private metadata', { 'src/hooks.ts':
    "import {z} from 'zod'; const seed = z.object({}); consume(seed._zod);" }],
  ['destructured validator private metadata', { 'src/hooks.ts':
    "import {z} from 'zod'; const seed = z.object({}); const {_zod: details} = seed; consume(details);" }],
  ['reflected validator private metadata', { 'src/hooks.ts':
    "import {z} from 'zod'; const seed = z.object({}); const details = Object.getOwnPropertyDescriptor(seed, '_zod').value; consume(details);" }],
  ['shared validator prototype customization', {
    'src/parser.ts': "import './hooks';\n" + parser,
    'src/hooks.ts': `import {z} from 'zod';
      function configure() {
        const seed = z.object({});
        const maker = seed._zod.constr;
        const parent = Object.getOwnPropertyDescriptor(maker, 'prototype').value;
        Object.defineProperty(parent, 'safeParse', {
          get: () => input => { input.extra1 = callable; return {success: true, data: {}}; },
          set: () => {}, enumerable: true,
        });
        function callable() {}
      }
      configure();` }],
  ['CommonJS parser invocation', { 'src/parser.ts': parser + '\nmodule.exports.decode(opaqueRequest, opaqueValidator);' }],
  ['CommonJS exports parser invocation', { 'src/parser.ts': parser + '\nexports.decode(opaqueRequest, opaqueValidator);' }],
  ['escaped CommonJS parser namespace', { 'src/parser.ts': parser + '\nconst namespace = module.exports; consume(namespace);' }],
  ['using loop binding', { 'src/parser.ts': parser.replace('for (const entryKey', 'for (using entryKey') }],
  ['changed short circuit', { 'src/parser.ts': parser.replace(' && !(entryKey in query)', ' || !(entryKey in query)') }],
  ['changed membership receiver', { 'src/parser.ts': parser.replace('entryKey in query', 'entryKey in originalQuery') }],
  ['changed copy operator', { 'src/parser.ts': parser.replace('query[entryKey] =', 'query[entryKey] +=') }],
  ['mismatched source key', { 'src/parser.ts': parser.replace('originalQuery[entryKey]', 'originalQuery[otherKey]') }],
  ['constructor extracted by assignment destructuring', { 'src/rewritten.ts':
    'let ordinary; ({constructor: ordinary} = {}); ordinary.fromEntries = () => ({extra1: callable}); function callable() {}' }],
  ['constructor extracted by computed assignment destructuring', { 'src/rewritten.ts':
    "let ordinary; ({['constructor']: ordinary} = {}); ordinary.fromEntries = () => ({extra1: callable}); function callable() {}" }],
  ['dynamic validator core subpath', { 'src/hooks.ts':
    "const core = require('zod/v4/core'); core.$ZodObject.init = replacement;" }],
  ['async validator core subpath', { 'src/hooks.ts':
    "const core = await import('zod/v4/core'); core.$ZodObject.init = replacement;" }],
  ['var loop binding', { 'src/parser.ts': parser.replace('for (const entryKey', 'for (var entryKey') }],
  ['escaped input alias', { 'src/parser.ts': parser.replace('let error;', 'let error; const alias = query; expose(alias);') }],
  ['getter added to original record', { 'src/parser.ts': parser.replace('let error;',
    "let error; const changed = Object.defineProperty(query, 'extra1', {get: () => capability});") }],
  ['mutation through saved alias', { 'src/parser.ts': parser.replace('const parsed =',
    "const changed = (originalQuery.extra1 = capability); const parsed =") }],
  ['mutable URL alias', { 'src/parser.ts': withUrlAlias.replace('const url =', 'let url =') }],
  ['escaped URL alias', { 'src/parser.ts': withUrlAlias.replace('let query =', 'const leaked = expose(url); let query =') }],
  ['substituted URL search-parameter iterator', { 'src/parser.ts': withUrlAlias.replace('let query =',
    "const changed = Object.defineProperty(url, 'searchParams', {value: customIterator}); let query =") }],
  ['callable GET field transform', { 'src/app/read/route.ts': getRoute.replace('title: z.string().optional()',
    'title: z.string().transform(() => capability)') }],
  ['modified GET schema method', { 'src/app/read/route.ts': getRoute.replace('return await decode',
    'schema.safeParse = custom; return await decode') }],
  ['GET schema alias escape', { 'src/app/read/route.ts': getRoute.replace('return await decode',
    'const alias = schema; consume(alias); return await decode') }],
  ['namespace parser caller', { 'src/hidden.ts': "import * as request from './parser'; export async function invoke(input: Request, validator: any) { return request.decode(input, validator); }" }],
  ['parser function call alias', { 'src/hidden.ts': "import {decode} from './parser'; export async function invoke(input: Request, validator: any) { return decode.call(undefined, input, validator); }" }],
  ['dynamic parser module caller', { 'src/hidden.ts': "export async function invoke(input: Request, validator: any) { const request = await import('./parser'); return request.decode(input, validator); }" }],
  ['parser module URL suffix', { 'src/hidden.ts': "import {decode} from './parser.ts?hidden'; export async function invoke(input: Request, validator: any) { return decode(input, validator); }" }],
  ['encoded parser module path', { 'src/hidden.ts': "import {decode} from './%70arser.ts'; export async function invoke(input: Request, validator: any) { return decode(input, validator); }" }],
  ['unproved incoming GET invocation', { 'src/hidden.ts': "import {GET} from './app/read/route'; export const invoke = GET;" }],
  ['rewritten URL intrinsic', { 'src/rewritten.ts': 'globalThis.URL = alternateURL;' }],
  ['rewritten record intrinsic', { 'src/rewritten.ts': 'Object.fromEntries = replacement;' }],
  ['rewritten regular-expression method', { 'src/rewritten.ts': 'RegExp.prototype.test = replacement;' }],
];
for (const [label, extra] of extraRefusals) test(`complete query-copy evidence withholds facts for ${label}`, () => {
  const output = run(extra);
  assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
  assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
  assert.ok(output.result.diagnostics.some(diagnostic => diagnostic.includes('WRITE_')));
});

for (const name of ['concealed', 'concealed.png']) test(`a ${name} symlink cannot conceal an unproved parser caller`, () => {
  const fixture = makeWriteFixture({ ...metadata, 'src/parser.ts': parser, 'src/app/read/route.ts': getRoute,
    'src/hidden-caller.ts': `import {decode} from './${name}'; export function invoke(input: Request, schema: unknown) { return decode(input, schema); }`,
  });
  try {
    symlinkSync('parser.ts', join(fixture.root, 'src', name));
    const output = extractContracts({ repoRoot: fixture.root, repo: 'write-demo', runId: 'run-query-copy',
      dataModelIndex: writeFixtureIndex('write-demo') });
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
    assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
    assert.ok(output.result.diagnostics.some(diagnostic => diagnostic.includes('WRITE_')));
  } finally { fixture.dispose(); }
});

test('erased external type imports and exports do not add runtime capabilities', () => {
  const output = run({ 'src/types.ts': "import type Hidden from 'unreviewed-effects'; export type {Other} from 'unreviewed-effects';" });
  assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
  assert.equal(output.nodes.filter(node => node.kind === 'SchemaProperty' && ['title', 'caption'].includes(node.name)).length, 2);
  assert.ok(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')));
});


test('a cached certificate preserves sticky proposal budgets and is rederived for a fresh proposal', () => {
  const fixture = makeWriteFixture({ ...metadata, 'src/parser.ts': parser, 'src/app/read/route.ts': getRoute });
  try {
    const shared = new WriteSource(ts, fixture.root, DEFAULT_LIMITS);
    const file = shared.parse('src/parser.ts');
    const data: ts.ElementAccessExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) &&
          ['query', 'originalQuery'].includes(node.expression.text)) data.push(node);
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.equal(data.length, 2);
    for (const node of data) assert.equal(permitsQueryDataCopy(shared, node), true);
    assert.throws(() => shared.chargeSyntax('explicit-exhaustion', 10001), /WRITE_SYNTAX_CAP/);
    for (const node of data) assert.throws(() => permitsQueryDataCopy(shared, node), /WRITE_SYNTAX_CAP/);
    const fresh = new WriteSource(ts, fixture.root, DEFAULT_LIMITS, undefined, shared);
    for (const node of data) assert.equal(permitsQueryDataCopy(fresh, node), true);
    assert.throws(() => fresh.chargeSyntax('fresh-exhaustion', 10001), /WRITE_SYNTAX_CAP/);
    for (const node of data) assert.throws(() => permitsQueryDataCopy(fresh, node), /WRITE_SYNTAX_CAP/);
  } finally { fixture.dispose(); }
});


test('a cached certificate records its work in an enclosing reusable proof trace', () => {
  const fixture = makeWriteFixture({ ...metadata, 'src/parser.ts': parser, 'src/app/read/route.ts': getRoute });
  try {
    const shared = new WriteSource(ts, fixture.root, DEFAULT_LIMITS);
    const file = shared.parse('src/parser.ts');
    let data: ts.ElementAccessExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'query') data = node;
      ts.forEachChild(node, visit);
    };
    visit(file);
    assert.ok(data !== undefined);
    const selected = data;
    assert.equal(permitsQueryDataCopy(shared, selected), true);
    assert.equal(shared.memoize('outer-query-copy-world', () => permitsQueryDataCopy(shared, selected)), true);
    const fresh = new WriteSource(ts, fixture.root, DEFAULT_LIMITS, undefined, shared);
    fresh.chargeSyntax('other-binding-work', 9999);
    assert.throws(() => fresh.memoize('outer-query-copy-world', () => assert.fail('must reuse the trace')), /WRITE_SYNTAX_CAP/);
    assert.throws(() => permitsQueryDataCopy(fresh, selected), /WRITE_SYNTAX_CAP/);
  } finally { fixture.dispose(); }
});
