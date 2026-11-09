// SPDX-License-Identifier: Apache-2.0
/** Original framework-entry adversarial fixtures; no upstream code is executed. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { claimCoversNode, isCanonicalSelectorText, SqliteStore } from '@seamline/core';
import { extractContracts } from './extract.ts';
import { makeWriteFixture, WRITE_ROUTE, writeFixtureIndex } from './write-test-support.ts';

const boundedRoute = WRITE_ROUTE
  .replace('title: z.string().optional()', 'title: z.string().max(120).optional()')
  .replace('caption: z.string().optional()', 'caption: z.string().max(500).optional()')
  .replace("kind: z.enum(['note'])", "kind: z.enum(['note']).optional()");

function extract(extra: Record<string, string> = {}) {
  const fixture = makeWriteFixture({ 'src/app/items/route.ts': boundedRoute, ...extra });
  try {
    return extractContracts({ repoRoot: fixture.root, repo: 'entry-demo', runId: 'entry-proof',
      dataModelIndex: writeFixtureIndex('entry-demo') });
  } finally { fixture.dispose(); }
}

test('a framework-only write retains complete bounded field facts', () => {
  const output = extract();
  assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
  const fields = output.nodes.filter(node => node.kind === 'SchemaProperty' && ['title', 'caption'].includes(node.name));
  assert.equal(fields.length, 2);
  assert.ok(fields.every(field => field.props['writeBindingComplete'] === true));
  assert.deepEqual(fields.map(field => [field.name, field.props['maxLength']]).sort(), [['caption', 500], ['title', 120]]);
});

test('an ordinary Request can expose a GET method while its clone retains the JSON body', async () => {
  const body = { title: 'x'.repeat(1000), caption: 'y'.repeat(600), kind: 'note' };
  const request = new Request('https://example.test/', { method: 'POST', body: JSON.stringify(body) });
  Object.defineProperty(request, 'method', { value: 'GET' });
  assert.equal(request.method, 'GET');
  assert.deepEqual(await request.clone().json(), body);
  // A successful optional-field query validation does not validate this raw body.
  assert.ok(body.title.length > 120 && body.caption.length > 500);
});

test('an imported handler with an unproved invocation cannot certify the non-GET body branch', () => {
  const output = extract({ 'src/manual.ts': `import { POST } from './app/items/route';
export async function invoke() {
 const request = new Request('https://example.test/', {method: 'POST', body: JSON.stringify({title: 'x'.repeat(1000), caption: 'y'.repeat(600), kind: 'note'})});
 Object.defineProperty(request, 'method', {value: 'GET'});
 return POST(request);
}` });
  assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), [],
    'a possible GET invocation can validate query data while persisting the unvalidated body');
  assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
  assert.match(output.result.diagnostics.join('\n'), /WRITE_NEXT_METHOD_INVOCATION_UNKNOWN/);
});

for (const [name, extra] of [
  ['inline type import runtime load', { 'src/manual.ts': "import {type POST} from './app/items/route'; export type Handler = typeof POST;" }],
  ['inline type export runtime load', { 'src/manual.ts': "export {type POST} from './app/items/route';" }],
  ['URL query import', { 'src/manual.ts': "import {POST} from './app/items/route.ts?manual'; export const invoke = POST;" }],
  ['URL fragment import', { 'src/manual.ts': "import {POST} from './app/items/route.ts#manual'; export const invoke = POST;" }],
  ['encoded pathname import', { 'src/manual.ts': "import {POST} from './app/items/%72oute.ts'; export const invoke = POST;" }],
  ['finite native require alias', { 'src/manual.cjs': "const key = 'require'; module[key]('./app/items/route').POST(input);" }],
  ['finite native require expression', { 'src/manual.cjs': "module['re' + 'quire']('./app/items/route').POST(input);" }],
  ['local direct call', { 'src/app/items/route.ts': boundedRoute + '\nexport function invoke(input: Request) { return POST(input); }' }],
  ['local value escape', { 'src/app/items/route.ts': boundedRoute + '\nexport const invoke = POST;' }],
  ['namespace import', { 'src/manual.ts': "import * as route from './app/items/route'; export const invoke = route.POST;" }],
  ['re-export', { 'src/manual.ts': "export {POST as invoke} from './app/items/route';" }],
  ['dynamic import', { 'src/manual.ts': "export async function invoke(request: Request) { const route = await import('./app/items/route'); return route.POST(request); }" }],
  ['CommonJS import', { 'src/manual.cjs': "const route = require('./app/items/route'); module.exports = route.POST;" }],
  ['CommonJS self namespace', { 'src/app/items/route.ts': boundedRoute + '\nexport function invoke(input: Request) { return module.exports.POST(input); }' }],
  ['mutable module choice', { 'src/manual.ts': "export async function invoke(path: string, request: Request) { const route = await import(path); return route.POST(request); }" }],
] as const) test(`unproved ${name} withholds write authority`, () => {
  const output = extract(extra);
  assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
  assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
  assert.match(output.result.diagnostics.join('\n'), /WRITE_NEXT_METHOD_INVOCATION_UNKNOWN/);
});

for (const source of [
  "import type {POST} from './app/items/route'; export type Handler = typeof POST;",
  "export type {POST} from './app/items/route';",
  "import {persist} from './write'; export const save = persist;",
]) test(`erased or disjoint references preserve bounded write facts: ${source}`, () => {
  const output = extract({ 'src/manual.ts': source });
  assert.equal(output.nodes.filter(node => node.kind === 'Contract').length, 1, output.result.diagnostics.join('\n'));
  assert.equal(output.nodes.filter(node => node.kind === 'SchemaProperty' && node.props['writeBindingComplete'] === true).length, 2);
});

test('unproved invocation retains old nodes and owned edges through actual finalization', async () => {
  const fixture = makeWriteFixture({ 'src/app/items/route.ts': boundedRoute });
  const store = new SqliteStore({ ontologyVersion: '1.0.0' });
  const run = (id: string) => extractContracts({ repoRoot: fixture.root, repo: 'entry-demo', runId: id,
    dataModelIndex: writeFixtureIndex('entry-demo') });
  const persist = async (id: string, output: ReturnType<typeof run>) => {
    await store.beginRun({ runId: id, repo: 'entry-demo', commit: null,
      startedAt: '1970-01-01T00:00:00.000Z', ontologyVersion: '1.0.0' });
    await store.upsertNodes(id, output.nodes);
    await store.upsertEdges(id, 'contracts', output.edges);
    await store.finalizeRun(id, [output.result]);
  };
  try {
    const before = run('entry-before');
    const retained = before.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty');
    assert.equal(retained.length, 4);
    assert.ok(before.edges.length > 0);
    await persist('entry-before', before);
    writeFileSync(join(fixture.root, 'src/app/items/route.ts'), boundedRoute +
      '\nexport function invoke(request: Request) { return POST(request); }');
    const after = run('entry-after');
    for (const node of retained) assert.equal(after.result.authoritative.some(claim =>
      claimCoversNode(claim, node, { repo: 'entry-demo' })), false);
    await persist('entry-after', after);
    for (const node of retained) {
      const live = store.node(node.id);
      assert.ok(live !== undefined);
      assert.equal(live.deletedAt, null);
      assert.equal(live.lastSeenRun, 'entry-before');
    }
    for (const edge of before.edges) assert.ok(store.edgesFrom(edge.src, edge.kind).some(live => live.dst === edge.dst));
    writeFileSync(join(fixture.root, 'src/app/items/route.ts'), boundedRoute);
    const recovered = run('entry-recovered');
    assert.deepEqual(recovered.nodes.map(node => node.id), before.nodes.map(node => node.id));
    await persist('entry-recovered', recovered);
    for (const node of retained) assert.equal(store.node(node.id)?.lastSeenRun, 'entry-recovered');
  } finally { await store.close(); fixture.dispose(); }
});

for (const [name, spell] of [
  ['leading space', (url: string) => ' ' + url],
  ['leading newline', (url: string) => '\n' + url],
  ['embedded scheme tab', (url: string) => url.replace('file:', 'fi\tle:')],
] as const) test(`URL-normalized ${name} cannot conceal a handler import`, () => {
  const fixture = makeWriteFixture({ 'src/app/items/route.ts': boundedRoute });
  try {
    const url = spell(pathToFileURL(join(fixture.root, 'src/app/items/route.ts')).href);
    writeFileSync(join(fixture.root, 'src/manual.ts'), `import {POST} from ${JSON.stringify(url)}; export const invoke = POST;`);
    const output = extractContracts({ repoRoot: fixture.root, repo: 'entry-demo', runId: 'entry-url-proof',
      dataModelIndex: writeFixtureIndex('entry-demo') });
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
    assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
    assert.match(output.result.diagnostics.join('\n'), /WRITE_NEXT_METHOD_INVOCATION_UNKNOWN/);
  } finally { fixture.dispose(); }
});

test('an unreviewed import-equals namespace cannot supply a native loader', () => {
  const fixture = makeWriteFixture({ 'src/app/items/route.ts': boundedRoute });
  try {
    const handler = join(fixture.root, 'src/app/items/route.ts');
    writeFileSync(join(fixture.root, 'src/manual.cts'), `import native = require('node:module');
export function invoke(input: Request) { return native._load(${JSON.stringify(handler)}, undefined).POST(input); }`);
    const output = extractContracts({ repoRoot: fixture.root, repo: 'entry-demo', runId: 'entry-native-proof',
      dataModelIndex: writeFixtureIndex('entry-demo') });
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
    assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
    assert.match(output.result.diagnostics.join('\n'), /WRITE_NEXT_METHOD_INVOCATION_UNKNOWN/);
  } finally { fixture.dispose(); }
});

test('an explicitly type-only import-equals namespace remains erased', () => {
  const output = extract({ 'src/manual.cts': "import type Native = require('node:module'); export type Namespace = Native;" });
  assert.equal(output.nodes.filter(node => node.kind === 'Contract').length, 1, output.result.diagnostics.join('\n'));
  assert.equal(output.nodes.filter(node => node.kind === 'SchemaProperty' && node.props['writeBindingComplete'] === true).length, 2);
});

for (const mode of ['worker', 'subprocess'] as const) test(`source-authored ${mode} code cannot conceal handler invocation`, () => {
  const fixture = makeWriteFixture({ 'src/app/items/route.ts': boundedRoute });
  try {
    const handler = join(fixture.root, 'src/app/items/route.ts');
    const code = `const {POST} = require(${JSON.stringify(handler)}); POST({method:'GET', clone:()=>({json:async()=>({title:'x'.repeat(1000), caption:'y'.repeat(600), kind:'note'})})});`;
    const source = mode === 'worker'
      ? `import {Worker} from 'node:worker_threads'; new Worker(${JSON.stringify(code)}, {eval:true});`
      : `import {execFileSync} from 'node:child_process'; execFileSync('node', ['-e', ${JSON.stringify(code)}]);`;
    writeFileSync(join(fixture.root, 'src/manual.ts'), source);
    // The producer parses these strings; this test starts no worker or subprocess.
    const output = extractContracts({ repoRoot: fixture.root, repo: 'entry-demo', runId: 'entry-execution-proof',
      dataModelIndex: writeFixtureIndex('entry-demo') });
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
    assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
    assert.match(output.result.diagnostics.join('\n'), /WRITE_NEXT_METHOD_INVOCATION_UNKNOWN/);
  } finally { fixture.dispose(); }
});

for (const mode of ['filesystem emission', 'global execve'] as const) test(`source-authored ${mode} cannot conceal handler invocation`, () => {
  const fixture = makeWriteFixture({ 'src/app/items/route.ts': boundedRoute });
  try {
    const handler = join(fixture.root, 'src/app/items/route.ts');
    const code = `const {POST} = require(${JSON.stringify(handler)}); POST({method:'GET', clone:()=>({json:async()=>({title:'x'.repeat(1000), caption:'y'.repeat(600), kind:'note'})})});`;
    const source = mode === 'filesystem emission'
      ? `import {writeFileSync} from 'node:fs'; writeFileSync('./src/generated.cjs', ${JSON.stringify(code)}); import('./generated.cjs');`
      : `process.execve(process.execPath, ['node', '-e', ${JSON.stringify(code)}], process.env);`;
    writeFileSync(join(fixture.root, 'src/manual.ts'), source);
    // Extraction only: generated code, execve and filesystem calls are never run.
    const output = extractContracts({ repoRoot: fixture.root, repo: 'entry-demo', runId: 'entry-native-effect-proof',
      dataModelIndex: writeFixtureIndex('entry-demo') });
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
    assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
    assert.match(output.result.diagnostics.join('\n'), /WRITE_NEXT_METHOD_INVOCATION_UNKNOWN/);
  } finally { fixture.dispose(); }
});

for (const mode of ['native subpath import', 'namespace property escape'] as const)
  test(`a mutable path ${mode} cannot redirect a metadata-only loader`, () => {
    const fixture = makeWriteFixture({ 'src/app/items/route.ts': boundedRoute });
    try {
      const handler = JSON.stringify(join(fixture.root, 'src/app/items/route.ts'));
      const prefix = mode === 'native subpath import'
        ? "import posix from 'node:path/posix'; import win32 from 'node:path/win32';"
        : 'const posix = path.posix; const win32 = path.win32;';
      writeFileSync(join(fixture.root, 'src/manual.ts'), `import path from 'node:path';
import {createRequire} from 'node:module'; ${prefix}
posix.resolve = () => ${handler}; win32.resolve = () => ${handler};
const load = createRequire(import.meta.url); const route = load(path.resolve(process.cwd(), 'package.json'));
route.POST({method:'GET', clone:()=>({json:async()=>({title:'x'.repeat(1000), caption:'y'.repeat(600), kind:'note'})})});`);
      // Extraction only: no builtin namespace is mutated by this test.
      const output = extractContracts({ repoRoot: fixture.root, repo: 'entry-demo', runId: 'entry-path-proof',
        dataModelIndex: writeFixtureIndex('entry-demo') });
      assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
      assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
      assert.match(output.result.diagnostics.join('\n'), /WRITE_NEXT_METHOD_INVOCATION_UNKNOWN|WRITE_NATIVE_PATH_ESCAPES/);
    } finally { fixture.dispose(); }
  });
