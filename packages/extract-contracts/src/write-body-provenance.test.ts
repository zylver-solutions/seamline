// SPDX-License-Identifier: Apache-2.0
/** Ordinary body proofs need the same source and validator provenance as copy proofs. */
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isCanonicalSelectorText } from '@seamline/core';
import { extractContracts } from './extract.ts';
import { makeWriteFixture, WRITE_FILES, WRITE_ROUTE, writeFixtureIndex } from './write-test-support.ts';

const integrity = 'sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg==';
const manifest = { name: '@sample/forms', dependencies: { next: '16.2.6', zod: '4.3.6' } };
const lock = `lockfileVersion: '9.0'
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
`;

function run(extra: Record<string, string> = {}, withoutTsconfig = false) {
  const fixture = makeWriteFixture({ 'package.json': JSON.stringify(manifest), 'pnpm-lock.yaml': lock, ...extra });
  try {
    if (withoutTsconfig) unlinkSync(join(fixture.root, 'tsconfig.json'));
    return extractContracts({ repoRoot: fixture.root, repo: 'body-demo', runId: 'run-body-proof',
      dataModelIndex: writeFixtureIndex('body-demo') });
  } finally { fixture.dispose(); }
}

test('an ordinary guarded write with genuine independent validator metadata retains facts and authority', () => {
  const output = run();
  assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
  const fields = output.nodes.filter(node => node.kind === 'SchemaProperty' && ['title', 'caption'].includes(node.name));
  assert.equal(fields.length, 2, output.result.diagnostics.join('\n'));
  assert.ok(fields.every(field => field.props['writeBindingComplete'] === true && field.props['lengthUpperState'] === 'unbounded'));
  assert.ok(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')));
});

const replacement = `function stringValue() { return {optional: () => stringValue(), max: () => stringValue()}; }
  export const z = {string: stringValue, enum: values => stringValue(), object: shape => ({safeParse: input => ({success: true, data: {title: '', caption: '', kind: 'note'}})})};`;
const refusals: ReadonlyArray<readonly [string, Record<string, string>, boolean?]> = [
  ['replacement validator tarball', { 'pnpm-lock.yaml': lock.replace(`integrity: ${integrity}`, `integrity: ${integrity}, tarball: https://registry.invalid/replacement.tgz`) }],
  ['replacement validator directory', { 'pnpm-lock.yaml': lock.replace(`integrity: ${integrity}`, 'directory: ./replacement') }],
  ['different validator integrity', { 'pnpm-lock.yaml': lock.replace(integrity, 'sha512-unreviewed') }],
  ['missing validator package record', { 'pnpm-lock.yaml': lock.replace(`  zod@4.3.6:\n    resolution: {integrity: ${integrity}}\n`, '') }],
  ['missing validator declaration', { 'package.json': JSON.stringify({ name: '@sample/forms', dependencies: { next: '16.2.6' } }) }],
  ...['zod', 'zod/v4'].map(source => [`shared validator prototype through ${source}`, {
    'src/parser.ts': "import './hooks';\n" + WRITE_FILES['src/parser.ts'],
    'src/hooks.ts': `import {z} from '${source}';
      function configure() {
        const seed = z.object({});
        const maker = seed._zod.constr;
        const parent = Object.getOwnPropertyDescriptor(maker, 'prototype').value;
        Object.defineProperty(parent, 'safeParse', {
          get: () => input => ({success: true, data: {title: '', caption: '', kind: 'note'}}),
          set: () => {}, enumerable: true,
        });
      }
      configure();`,
  }] as const),
  ['legacy prototype reflection', {
    'src/parser.ts': "import './hooks';\n" + WRITE_FILES['src/parser.ts'],
    'src/hooks.ts': `import {z} from 'zod';
      const seed = z.object({});
      const parent = seed.__lookupGetter__('__proto__').call(seed);
      Object.defineProperty(parent, 'safeParse', {
        get: () => input => ({success: true, data: {title: '', caption: '', kind: 'note'}}),
        set: () => {}, enumerable: true,
      });`,
  }],
  ['unqualified legacy reflection capability', {
    'src/parser.ts': "import './hooks';\n" + WRITE_FILES['src/parser.ts'],
    'src/hooks.ts': `import {z} from 'zod';
      const seed = z.object({});
      const parent = __lookupGetter__.call(seed, '__proto__').call(seed);
      Object.defineProperty(parent, 'safeParse', {
        get: () => input => ({success: true, data: {title: '', caption: '', kind: 'note'}}),
        set: () => {}, enumerable: true,
      });`,
  }],
  ['shared validator intrinsic replacement', {
    'src/parser.ts': "import './hooks';\n" + WRITE_FILES['src/parser.ts'],
    'src/hooks.ts': 'Object.keys = () => [];',
  }],
  ['shared validator intrinsic through the global namespace', {
    'src/parser.ts': "import './hooks';\n" + WRITE_FILES['src/parser.ts'],
    'src/hooks.ts': 'globalThis.Array.isArray = () => true;',
  }],
  ['shared validator intrinsic namespace escape', {
    'src/parser.ts': "import './hooks';\n" + WRITE_FILES['src/parser.ts'],
    'src/hooks.ts': 'const replacement = Array; Object.assign(replacement, {isArray: () => true});',
  }],
  ['unreviewed external execution capability', {
    'package.json': JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, 'get-intrinsic': '1.3.0' } }),
    'src/app/items/route.ts': WRITE_ROUTE
      .replace('title: z.string().optional()', 'title: z.string().max(120).optional()')
      .replace('caption: z.string().optional()', 'caption: z.string().max(500).optional()')
      .replace("kind: z.enum(['note'])", "kind: z.enum(['note']).optional()"),
    'src/manual.ts': `import getIntrinsic from 'get-intrinsic';
      const compile = getIntrinsic('%Function%');
      compile("return import('./app/items/route.ts').then(module => { const request = new Request('https://example.test/', {method:'POST', body:JSON.stringify({title:'x'.repeat(1000),caption:'y'.repeat(600),kind:'note'})}); Object.defineProperty(request,'method',{value:'GET'}); return module.POST(request); })")();`,
  }],
  ['custom framework TypeScript resolver', {
    'next.config.ts': "export default {typescript: {tsconfigPath: 'tsconfig.app.json'}};",
    'tsconfig.app.json': '{"compilerOptions":{"paths":{"zod":["./src/replacement.ts"]}}}',
    'src/replacement.ts': replacement,
  }],
  ['fallback JavaScript validator alias', {
    'jsconfig.json': '{"compilerOptions":{"paths":{"zod":["./src/replacement.ts"]}}}',
    'src/replacement.ts': replacement,
  }, true],
  ['conflicting TypeScript and JavaScript resolver maps', {
    'jsconfig.json': '{"compilerOptions":{"paths":{"zod":["./src/replacement.ts"]}}}',
    'src/replacement.ts': replacement,
  }],
];

for (const [name, extra, withoutTsconfig] of refusals) test(`ordinary write proof refuses ${name}`, () => {
  const output = run(extra, withoutTsconfig);
  assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), [],
    'unproved validator or source effects cannot mint complete body-binding facts');
  assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
  assert.ok(output.result.diagnostics.some(diagnostic => diagnostic.includes('WRITE_')));
});

test('an ordinary write resolves inspected JavaScript-config aliases when no TypeScript config exists', () => {
  const output = run({
    'jsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
    'src/app/items/route.ts': WRITE_ROUTE.replace('../../parser', '@/parser').replace('../../write', '@/write'),
  }, true);
  assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
  assert.equal(output.nodes.filter(node => node.kind === 'SchemaProperty' && ['title', 'caption'].includes(node.name)).length, 2);
  assert.ok(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')));
});


test('ordinary write proof permits readonly intrinsic calls and locally shadowed names', () => {
  const output = run({
    'src/hooks.ts': `const keys = Object.keys({value: 1});
      const encoded = JSON.stringify(keys); const size = Array.isArray(keys);
      const limit = Number.MAX_SAFE_INTEGER;
      function local(Array) { return Array; }`,
    'src/parser.ts': "import './hooks';\n" + WRITE_FILES['src/parser.ts'],
  });
  assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
  assert.equal(output.nodes.filter(node => node.kind === 'SchemaProperty' && ['title', 'caption'].includes(node.name)).length, 2);
  assert.ok(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')));
});
