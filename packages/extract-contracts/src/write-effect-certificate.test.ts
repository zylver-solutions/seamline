// SPDX-License-Identifier: Apache-2.0
/** Real artifact admission must change complete facts, not just an import result. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCanonicalSelectorText } from '@seamline/core';
import { extractContracts } from './extract.ts';
import { makeWriteFixture, WRITE_FILES, writeFixtureIndex } from './write-test-support.ts';

// Independently specified published metadata, not copied from the production catalog.
const integrity = 'sha512-quJQXlTSUGL2LH9SUXo8VwsY4soanhgo6LNSm84E1LBcE8s3O0wpdiRzyR9z/ZZJMlMWv37qOOb9pdJlMUEKFQ==';
const manifest = { name: '@sample/forms', dependencies: { next: '16.2.6', zod: '4.3.6', 'ansi-regex': '5.0.1' } };
const lock = (WRITE_FILES['pnpm-lock.yaml'] as string)
  .replace('    dependencies:\n', '    dependencies:\n      ansi-regex: {specifier: 5.0.1, version: 5.0.1}\n') +
  `  ansi-regex@5.0.1:\n    resolution: {integrity: ${integrity}}\nsnapshots:\n  ansi-regex@5.0.1: {}\n`;
function run(source?: string, extra: Record<string, string> = {}, file = 'src/ansi.ts') {
  const fixture = makeWriteFixture({ 'package.json': JSON.stringify(manifest), 'pnpm-lock.yaml': lock,
    ...(source === undefined ? {} : { [file]: source }), ...extra });
  try { return extractContracts({ repoRoot: fixture.root, repo: 'effect-demo', runId: 'run-effect',
    dataModelIndex: writeFixtureIndex('effect-demo') }); }
  finally { fixture.dispose(); }
}
function complete(output: ReturnType<typeof run>) {
  assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
  const fields = output.nodes.filter(node => node.kind === 'SchemaProperty' && ['title', 'caption'].includes(node.name));
  assert.deepEqual(fields.map(field => field.name).sort(), ['caption', 'title']);
  assert.ok(fields.every(field => field.provenance === 'EXTRACTED' && field.props['writeBindingComplete'] === true &&
    field.props['lengthUpperState'] === 'unbounded' && field.props['storageModel'] === 'Entry'));
  assert.ok(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')));
  return fields;
}
function withheld(output: ReturnType<typeof run>) {
  assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), [],
    'an unproved effect certificate cannot mint a complete write contract or field');
  assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
  assert.ok(output.result.diagnostics.some(diagnostic => diagnostic.includes('WRITE_')));
}

test('ordinary binding positive control remains complete without the extra runtime import', () => { complete(run()); });
for (const [name, source, file] of [
  ['initialization-only import', "import 'ansi-regex';", 'src/ansi.ts'],
  ['default zero-argument factory', "import make from 'ansi-regex'; const result = make(); export const text = result.source;", 'src/ansi.ts'],
  ['namespace default factory', "import * as ansi from 'ansi-regex'; const result = ansi.default();", 'src/ansi.ts'],
  ['named default factory', "import {default as make} from 'ansi-regex'; const result = make();", 'src/ansi.ts'],
  ['CommonJS zero-argument factory', "const make = require('ansi-regex'); const result = make();", 'src/ansi.cjs'],
  ['inline type import runtime initialization', "import {type default as Factory} from 'ansi-regex'; type Shape = typeof Factory;", 'src/ansi.ts'],
  ['inline type export runtime initialization', "export {type default as Factory} from 'ansi-regex';", 'src/ansi.ts'],
] as const) test(`closed artifact permits ${name} without changing facts or identity`, () => {
  const fields = complete(run(source, {}, file));
  assert.deepEqual(fields.map(field => field.id).sort(), complete(run()).map(field => field.id).sort());
});

test('a fully erased type import needs no runtime certificate', () => {
  complete(run("import type Factory from 'ansi-regex'; type Shape = typeof Factory;", {
    'package.json': JSON.stringify({ name: '@sample/forms', dependencies: { next: '16.2.6', zod: '4.3.6' } }),
  }));
});

const factory = "import make from 'ansi-regex'; const result = make();";
const refusals: ReadonlyArray<readonly [string, string, Record<string, string>]> = [
  ['wrong artifact integrity', factory, { 'pnpm-lock.yaml': lock.replace(integrity, 'sha512-unreviewed') }],
  ['archive replacement', factory, { 'pnpm-lock.yaml': lock.replace(`integrity: ${integrity}`, `integrity: ${integrity}, tarball: https://registry.invalid/other.tgz`) }],
  ['missing snapshot', factory, { 'pnpm-lock.yaml': lock.replace('snapshots:\n  ansi-regex@5.0.1: {}\n', '') }],
  ['injected dependency', factory, { 'pnpm-lock.yaml': lock.replace('  ansi-regex@5.0.1: {}', '  ansi-regex@5.0.1:\n    dependencies: {unreviewed: 1.0.0}') }],
  ['unreviewed peer context', factory, { 'pnpm-lock.yaml': lock.replace('version: 5.0.1}', 'version: 5.0.1(other@1.0.0)}') }],
  ['injected peer metadata', factory, { 'pnpm-lock.yaml': lock.replace('  ansi-regex@5.0.1:\n    resolution:', '  ansi-regex@5.0.1:\n    peerDependencies: {other: 1.0.0}\n    resolution:') }],
  ['wrong lock schema', factory, { 'pnpm-lock.yaml': lock.replace('lockfileVersion: "9.0"', 'lockfileVersion: "6.0"') }],
  ['source alias', factory, { 'tsconfig.json': '{"compilerOptions":{"paths":{"ansi-regex":["./src/replacement.ts"]}}}',
    'src/replacement.ts': 'export default function replacement() { return {}; }' }],
  ['unreviewed compiler configuration', factory, { '.babelrc.json': '{"plugins":["unreviewed"]}' }],
  ['Babel JSON project configuration', factory, { 'babel.config.json': '{"plugins":["unreviewed"]}' }],
  ['Babel TypeScript project configuration', factory, { 'babel.config.cts': 'export default {};' }],
  ['TypeScript compiler plugin', factory, { 'tsconfig.json': '{"compilerOptions":{"plugins":[{"name":"unreviewed"}]}}' }],
  ['cached inherited compiler configuration', factory, { 'tools/tsconfig.json': '{"extends":"./base.json"}',
    'tools/base.json': '{"compilerOptions":{"paths":{"ansi-regex":["./replacement.ts"]}}}',
    'tools/package.json': JSON.stringify({ name:'sample-tools', dependencies:{'ansi-regex':'5.0.1'} }),
    'tools/replacement.ts': 'export default function replacement() {return {};}' }],
  ['explicit loader script', factory, { 'package.json': JSON.stringify({ ...manifest, scripts: {start:'node --loader loader-package server.js'} }) }],
  ['explicit preload environment', factory, { 'package.json': JSON.stringify({ ...manifest, scripts: {start:'NODE_OPTIONS="--require /outside/custom-loader.cjs" next start'} }) }],
  ['unsupported subpath', "import 'ansi-regex/index.js';", {}],
  ['factory arguments', "import make from 'ansi-regex'; make({onlyFirst:true});", {}],
  ['factory callback-bearing options', "import make from 'ansi-regex'; make({get onlyFirst(){throw new Error('opaque')}});", {}],
  ['callable alias escape', "import make from 'ansi-regex'; const alias = make; alias();", {}],
  ['callable export escape', "import make from 'ansi-regex'; export {make};", {}],
  ['namespace escape', "import * as ansi from 'ansi-regex'; export const value = ansi;", {}],
  ['runtime re-export', "export {default as make} from 'ansi-regex';", {}],
  ['opaque dynamic namespace', "const value = import('ansi-regex');", {}],
  ['exported CommonJS callable', "export const make = require('ansi-regex');", {}],
  ['cross-file CommonJS callable escape', "export const make = require('ansi-regex');", {
    'src/caller.ts': "import {make} from './ansi'; make({get onlyFirst(){throw new Error('opaque')}});" }],
  ['CommonJS callable escape', "const make = require('ansi-regex'); export const value = make;", {}],
  ['unproved CommonJS loader binding', "const require = source => () => {}; const make = require('ansi-regex'); make();", {}],
];
for (const [name, source, extra] of refusals) {
  test(`closed artifact withholds ${name}`, () => withheld(run(source, extra)));
}

test('repository-authored certificate data cannot authorize a different package', () => {
  const forged = JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, unreviewed: '1.0.0' },
    seamlineEffectCertificates: [{ packageName: 'unreviewed', initialization: 'closed-reviewed', verified: true }] });
  withheld(run("import 'unreviewed';", { 'package.json': forged }));
});
