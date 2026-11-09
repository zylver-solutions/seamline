// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { claimCoversNode, isCanonicalSelectorText, SqliteStore } from '@seamline/core';
import type { SeamlineNode } from '@seamline/ontology';
import { extractContracts } from './extract.ts';
import { makeWriteFixture, WRITE_FILES, WRITE_ROUTE, writeFixtureIndex } from './write-test-support.ts';

function run(root: string, dataModelIndex: string | undefined = writeFixtureIndex('write-demo')) {
  return extractContracts({ repoRoot: root, repo: 'write-demo', runId: 'run-proof',
    ...(dataModelIndex === undefined ? {} : { dataModelIndex }) });
}

for (const [stage, extra] of [
  ['persistence', { 'src/write.ts': WRITE_FILES['src/write.ts']!.replace('where: {id}',
    "where: {id: (arguments[1].title = '', arguments[1].caption = '', id)}") }],
  ['parser', { 'src/parser.ts': WRITE_FILES['src/parser.ts']!.replace('let query = {};',
    "let query = (arguments[1].safeParse = () => ({success: true, data: {title: '', caption: '', kind: 'note'}}), {});") }],
  ['handler', { 'src/app/items/route.ts': WRITE_ROUTE.replace('const schema =',
    "const ignored = (arguments[0].clone = () => ({json: async () => ({title: '', caption: '', kind: 'note'})})); const schema =") }],
] as const) test(`implicit argument aliases cannot certify unchanged ${stage}`, () => {
  const fixture = makeWriteFixture(extra);
  try {
    const output = run(fixture.root);
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), [],
      'hidden mutation cannot become a complete validated-write fact');
    assert.match(output.result.diagnostics.join('\n'), /WRITE_IMPLICIT_ARGUMENTS_ALIAS/);
  } finally { fixture.dispose(); }
});

for (const reference of ['./fake-zod', '../fake-zod', 'sample/fake-zod', 'catalog:', 'catalog:validators',
  'patch:zod@4.3.6', 'portal:./fake-zod', 'fake-zod.tgz', 'fake-zod.tar.gz', 'fake-zod.tar']) test(`non-registry dependency source cannot supply validator semantics: ${reference}`, () => {
  const fixture = makeWriteFixture({
    'package.json': JSON.stringify({ name: '@sample/forms', dependencies: { next: '16.2.6', zod: reference } }),
    'pnpm-workspace.yaml': 'packages:\n  - fake-zod\ncatalog:\n  zod: file:./fake-zod\ncatalogs:\n  validators:\n    zod: file:./fake-zod\n',
    'fake-zod/package.json': '{"name":"@sample/validator","version":"1.0.0","type":"module","exports":"./index.ts"}',
    // Original replacement semantics: parsing returns bounded constants. The
    // extractor must not borrow unbounded semantics from the import spelling.
    'fake-zod/index.ts': `export const z = {string: () => ({optional() {return {};}}), enum: () => ({}),
      object: () => ({safeParse: () => ({success: true, data: {title: '', caption: '', kind: 'note'}})})};`,
  });
  try {
    const output = run(fixture.root);
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
    assert.match(output.result.diagnostics.join('\n'), /WRITE_LIBRARY_SOURCE_ALIAS/);
  } finally { fixture.dispose(); }
});

for (const reference of ['4.3.6', '^4.3.6', '~4.3.6', '>=4.3.0 <5', 'latest', 'next'])
  test(`ordinary registry validator declaration preserves write facts: ${reference}`, () => {
    const fixture = makeWriteFixture({
      'package.json': JSON.stringify({ name: '@sample/forms', dependencies: { next: '16.2.6', zod: reference } }),
      'pnpm-lock.yaml': (WRITE_FILES['pnpm-lock.yaml'] as string).replace('specifier: 4.3.6', `specifier: ${JSON.stringify(reference)}`),
    });
    try {
      const output = run(fixture.root);
      assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
      const contract = output.nodes.filter(node => node.kind === 'Contract');
      assert.equal(contract.length, 1, output.result.diagnostics.join('\n'));
      const strings = output.nodes.filter(node => node.kind === 'SchemaProperty' && ['title', 'caption'].includes(node.name));
      assert.equal(strings.length, 2);
      assert.ok(strings.every(node => node.props['writeBindingComplete'] === true));
      assert.equal(output.result.diagnostics.some(diagnostic => diagnostic.includes('WRITE_LIBRARY_SOURCE_ALIAS')), false);
    } finally { fixture.dispose(); }
  });

test('opaque output uses withhold the contract and preserve uncertainty about another matching declaration', () => {
  const aliased = WRITE_ROUTE.replace('../../parser', '@/parser').replace('../../write', '@/write');
  const second = aliased.replace("import {persist} from '@/write';", "import {saveOther as persist} from '@/other-write';");
  const otherWrite = WRITE_FILES['src/write.ts']!.replace('function persist', 'function saveOther');
  assert.notEqual(second, aliased);
  for (const source of [
    aliased.replace('const kind = body.kind', 'const kind = normalize(body.kind)'),
    aliased.replace('const kind =', "await writers.saveOther('other', {caption: body.caption}); const kind ="),
  ]) {
    const alone = makeWriteFixture({ 'src/app/items/route.ts': source });
    try {
      const output = run(alone.root);
      assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
      assert.match(output.result.diagnostics.join('\n'), /WRITE_STORAGE_IDENTITY_INCOMPLETE/);
    } finally { alone.dispose(); }
    const both = makeWriteFixture({ 'src/app/items/route.ts': source,
      'src/app/other/route.ts': second, 'src/other-write.ts': otherWrite });
    try {
      const output = run(both.root);
      assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
      assert.match(output.result.diagnostics.join('\n'), /WRITE_IDENTITY_INVENTORY_COLLISION/);
    } finally { both.dispose(); }
  }
  const control = makeWriteFixture({ 'src/app/items/route.ts': aliased,
    'src/app/other/route.ts': second, 'src/other-write.ts': otherWrite });
  try {
    assert.equal(run(control.root).nodes.filter(node => node.kind === 'Contract').length, 2,
      'two completely proved distinct wrappers remain disjoint');
  } finally { control.dispose(); }
});

test('unrelated second arguments do not remove a proved binding from canonical authority', () => {
  const source = WRITE_ROUTE.replace('const {title, caption} = body;',
    'const board = await getBoard(); const permitted = await permission(user, board); const {title, caption} = body;');
  const fixture = makeWriteFixture({'src/app/items/route.ts': source});
  try {
    const output = run(fixture.root);
    assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
    const property = output.nodes.find(node => node.kind === 'SchemaProperty' && node.name === 'title');
    assert.ok(property !== undefined && property.path !== undefined);
    assert.equal(property.props['writeBindingComplete'], true);
    const legacy = output.result.authoritative.filter(claim => !isCanonicalSelectorText(claim.selector ?? ''));
    const canonical = output.result.authoritative.filter(claim => isCanonicalSelectorText(claim.selector ?? ''));
    assert.equal(legacy.some(claim => claimCoversNode(claim, property, { repo: 'write-demo' })), false,
      'the write handler never receives filename-wide deletion authority');
    assert.equal(canonical.some(claim => claimCoversNode(claim, property, { repo: 'write-demo' })), true,
      'its complete known binding has literal canonical authority');
  } finally { fixture.dispose(); }
});

test('public extraction emits source-proved length, model and write witnesses', () => {
  const fixture = makeWriteFixture();
  try {
    const output = run(fixture.root);
    assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
    const properties = output.nodes.filter(node => node.kind === 'SchemaProperty');
    const title = properties.find(node => node.name === 'title');
    assert.ok(title !== undefined);
    assert.equal(title.props['lengthUpperState'], 'unbounded');
    assert.equal(title.props['writeBindingComplete'], true);
    assert.equal(title.props['direction'], 'request');
    assert.equal(title.props['storageTable'], 'write-demo:Table:default.public.entries');
    assert.equal(title.props['container'], 'entries');
    const witness = JSON.parse(String(title.props['bindingWitness'])) as Record<string, unknown>;
    assert.equal(witness['method'], 'POST');
    assert.equal(witness['sourceBoundary'], 'inspected-repository-source');
    assert.equal(JSON.stringify(output.nodes).includes(fixture.root), false);
    assert.equal(properties.find(node => node.name === 'kind')?.props['writeBindingComplete'], false);
    const again = run(fixture.root);
    assert.deepEqual(again.nodes, output.nodes);
    assert.deepEqual(again.edges, output.edges);
    writeFileSync(join(fixture.root, 'src/app/items/route.ts'), WRITE_ROUTE.replace('title: z.string().optional()', 'title: z.string().max(120).optional()'));
    const fixed = run(fixture.root).nodes.find(node => node.id === title.id);
    assert.ok(fixed !== undefined);
    assert.equal(fixed.props['lengthUpperState'], 'bounded');
    assert.equal(fixed.props['maxLength'], 120);
  } finally { fixture.dispose(); }
});

test('unselected structured roots cannot conceal a duplicate key or overlapping legacy family', () => {
  for (const suffix of ['', '#/B']) for (const path of ['legacy.json', 'build/legacy.json', 'dist/legacy.json']) {
    const fixture = makeWriteFixture();
    try {
      const contract = run(fixture.root).nodes.find(node => node.kind === 'Contract');
      assert.ok(contract !== undefined);
      // The identity, rather than the display name, supplies the exact root.
      const name = contract.id.slice('write-demo:Contract:'.length);
      mkdirSync(dirname(join(fixture.root, path)), { recursive: true });
      writeFileSync(join(fixture.root, path), JSON.stringify({ openapi: '3.0.0',
        info: { title: name + suffix, version: '1' }, paths: {},
        components: { schemas: { Legacy: { type: 'object', properties: { retained: { type: 'string' } } } } },
      }));
      for (const files of [undefined, ['src/app/items/route.ts']]) {
        const output = extractContracts({ repoRoot: fixture.root, repo: 'write-demo', runId: 'run-proof',
          dataModelIndex: writeFixtureIndex('write-demo'), ...(files === undefined ? {} : { files }) });
        assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
        assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
        assert.match(output.result.diagnostics.join('\n'), /COLLISION/);
      }
    } finally { fixture.dispose(); }
  }
});

test('unselected structured families and every owned edge survive a real producer rerun', async () => {
  for (const suffix of ['', '#/B', '-unrelated']) for (const directory of ['dist', 'build']) {
    const fixture = makeWriteFixture();
    const store = new SqliteStore({ ontologyVersion: '1.0.0' });
    try {
      const original = run(fixture.root).nodes.find(node => node.kind === 'Contract');
      assert.ok(original !== undefined);
      const name = original.id.slice('write-demo:Contract:'.length);
      const legacyPath = `src/${directory}/legacy.json`;
      mkdirSync(dirname(join(fixture.root, legacyPath)), { recursive: true });
      writeFileSync(join(fixture.root, legacyPath), JSON.stringify({ openapi: '3.0.0',
        info: { title: name + suffix, version: '1' }, paths: {},
        components: { schemas: { Legacy: { type: 'object', properties: { retained: { type: 'string' } } } } },
      }));
      writeFileSync(join(fixture.root, 'src/app/items/route.ts'), 'export {};');
      mkdirSync(join(fixture.root, 'app/items'), { recursive: true });
      const routePath = join(fixture.root, 'app/items/route.ts');
      writeFileSync(routePath, 'export {};');
      writeFileSync(join(fixture.root, 'src/other.ts'), "import {z} from 'zod'; export const Other = z.object({ok: z.boolean()});");
      const observed = extractContracts({ repoRoot: fixture.root, repo: 'write-demo', runId: 'retained-before',
        dataModelIndex: writeFixtureIndex('write-demo'), files: [legacyPath] });
      assert.equal(observed.result.status, 'PASS', observed.result.diagnostics.join('\n'));
      const retained = observed.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty');
      assert.ok(retained.some(node => node.kind === 'Contract') && retained.some(node => node.kind === 'SchemaProperty'));
      assert.ok(observed.edges.length > 0);
      const persist = async (id: string, output: typeof observed): Promise<void> => {
        await store.beginRun({ runId: id, repo: 'write-demo', commit: null,
          startedAt: '1970-01-01T00:00:00.000Z', ontologyVersion: '1.0.0' });
        await store.upsertNodes(id, output.nodes);
        await store.upsertEdges(id, 'contracts', output.edges);
        await store.finalizeRun(id, [output.result]);
      };
      await persist('retained-before', observed);
      writeFileSync(routePath, WRITE_ROUTE.replace('../../parser', '@/parser').replace('../../write', '@/write'));
      const retry = extractContracts({ repoRoot: fixture.root, repo: 'write-demo', runId: 'retained-after',
        dataModelIndex: writeFixtureIndex('write-demo') });
      assert.equal(retry.result.status, 'PASS', retry.result.diagnostics.join('\n'));
      assert.ok(retry.nodes.some(node => node.kind === 'Contract' && node.name === 'Other'), 'an unrelated contract keeps PASS');
      if (suffix === '-unrelated') {
        const known = retry.nodes.find(node => node.id === original.id);
        assert.ok(known !== undefined, 'a disjoint skipped source cannot suppress the completely proved write');
        const knownProperties = retry.nodes.filter(node => node.kind === 'SchemaProperty' && node.props['contract'] === original.name);
        assert.equal(knownProperties.length, 3);
        for (const node of [known, ...knownProperties]) assert.equal(retry.result.authoritative.some(claim =>
          claimCoversNode(claim, node, { repo: 'write-demo' })), true, 'the disjoint write retains actual canonical authority');
      }
      assert.equal(retry.nodes.some(node => retained.some(old => node.id === old.id)), false);
      for (const node of retained) assert.equal(retry.result.authoritative.some(claim =>
        claimCoversNode(claim, node, { repo: 'write-demo' })), false,
      'a names-only skipped source must be excluded from both canonical and legacy path authority');
      await persist('retained-after', retry);
      for (const node of retained) {
        const live: SeamlineNode | undefined = store.node(node.id);
        assert.ok(live !== undefined, 'the real producer claim cannot bury a retained colliding family');
        assert.equal(live.deletedAt, null);
        assert.equal(live.lastSeenRun, 'retained-before');
      }
      for (const edge of observed.edges) assert.ok(store.edgesFrom(edge.src, edge.kind).some(live => live.dst === edge.dst),
        'every retained owned edge remains readable after actual finalization');
    } finally { await store.close(); fixture.dispose(); }
  }
});

test('an earlier guarded parser does not authorize a second sequential parse', () => {
  const dual = WRITE_ROUTE.replace('const schema =', `const goodSchema = z.object({title: z.string().optional()});
    const {body: goodBody, error: goodError} = await decode(request, goodSchema);
    if (goodError) { return goodError(); }
    const schema =`).replace("const saved = await persist('id', {title, caption, kind});",
      "await persist('good', {title: goodBody.title}); const saved = await persist('id', {title, caption, kind});");
  const fixture = makeWriteFixture({ 'src/app/items/route.ts': dual });
  try {
    const output = run(fixture.root);
    assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
    assert.equal(output.nodes.filter(node => node.kind === 'Contract').length, 1);
    assert.deepEqual(output.nodes.filter(node => node.kind === 'SchemaProperty').map(node => node.name), ['title']);
    assert.match(output.result.diagnostics.join('\n'), /WRITE_PARSE_PREFIX_UNKNOWN/);
  } finally { fixture.dispose(); }
});

test('a withheld write root still protects a readable overlapping legacy family', () => {
  const fixture = makeWriteFixture();
  try {
    const complete = run(fixture.root).nodes.find(node => node.kind === 'Contract');
    assert.ok(complete !== undefined);
    const name = complete.id.slice('write-demo:Contract:'.length);
    writeFileSync(join(fixture.root, 'legacy.json'), JSON.stringify({ openapi: '3.0.0',
      info: { title: name + '#/B', version: '1' }, paths: {},
      components: { schemas: { Legacy: { type: 'object', properties: { retained: { type: 'string' } } } } },
    }));
    writeFileSync(join(fixture.root, 'src/other.ts'), "import {z} from 'zod'; export const Other = z.object({ok: z.boolean()});");
    writeFileSync(join(fixture.root, 'src/app/items/route.ts'), WRITE_ROUTE.replace('const kind = body.kind', 'const kind = normalize(body.kind)'));
    const output = run(fixture.root);
    assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract').map(node => node.name), ['Other']);
    assert.match(output.result.diagnostics.join('\n'), /WRITE_STORAGE_IDENTITY_INCOMPLETE/);
    assert.match(output.result.diagnostics.join('\n'), /CONTRACT_CANONICAL_FAMILY_COLLISION/);
    assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
  } finally { fixture.dispose(); }
});

test('an unselected structured-source symlink cannot make the name inventory complete', (t) => {
  const fixture = makeWriteFixture();
  try {
    const contract = run(fixture.root).nodes.find(node => node.kind === 'Contract');
    assert.ok(contract !== undefined);
    const name = contract.id.slice('write-demo:Contract:'.length);
    writeFileSync(join(fixture.root, 'opaque.data'), JSON.stringify({ openapi: '3.0.0', info: { title: name, version: '1' }, paths: {} }));
    mkdirSync(join(fixture.root, 'dist'));
    try { symlinkSync(join(fixture.root, 'opaque.data'), join(fixture.root, 'dist/legacy.json')); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('creating a source symlink is not permitted');
        return;
      }
      throw error;
    }
    const output = run(fixture.root);
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
    assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
    assert.equal(output.result.status, 'UNAVAILABLE');
    // Framework entry closure now detects the incomplete inventory before client-cache proof.
    assert.match(output.result.diagnostics.join('\n'), /WRITE_SOURCE_INVENTORY_INCOMPLETE/);
  } finally { fixture.dispose(); }
});

test('an unread unselected structured name inventory withholds local write identities', () => {
  const fixture = makeWriteFixture({ 'unknown.json': '{"openapi":' });
  try {
    const output = extractContracts({ repoRoot: fixture.root, repo: 'write-demo', runId: 'run-proof',
      dataModelIndex: writeFixtureIndex('write-demo'), files: ['src/app/items/route.ts'] });
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
    assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
    assert.match(output.result.diagnostics.join('\n'), /CONTRACT_NAME_INVENTORY_UNAVAILABLE/);
  } finally { fixture.dispose(); }
});

test('canonical producer exhaustion returns FAIL without filename or partial canonical authority', () => {
  const fixture = makeWriteFixture();
  try {
    const metadata = JSON.parse(readFileSync(join(fixture.root, 'package.json'), 'utf8')) as Record<string, unknown>;
    metadata['name'] = '@sample/' + 'a'.repeat(18_000);
    writeFileSync(join(fixture.root, 'package.json'), JSON.stringify(metadata));
    const output = run(fixture.root);
    assert.equal(output.result.status, 'FAIL');
    assert.match(output.result.diagnostics.join('\n'), /CONTRACT_AUTHORITY_UNAVAILABLE/);
    assert.ok(output.result.authoritative.length > 0, 'failed scope coverage still suppresses stale PASS');
    assert.ok(output.result.authoritative.every(claim => claim.selector === undefined));
  } finally { fixture.dispose(); }
});

test('an eligible file move preserves contract/property ids while source locations move', () => {
  const aliased = WRITE_ROUTE.replace('../../parser', '@/parser').replace('../../write', '@/write');
  const fixture = makeWriteFixture({ 'src/app/items/route.ts': aliased });
  try {
    const before = run(fixture.root).nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty');
    assert.ok(before.length > 0);
    const target = join(fixture.root, 'src/app/admin/items/route.ts');
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(fixture.root, 'src/app/items/route.ts'), target);
    const after = run(fixture.root).nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty');
    assert.deepEqual(after.map(node => node.id), before.map(node => node.id));
    assert.ok(after.every(node => node.path === 'src/app/admin/items/route.ts'));
  } finally { fixture.dispose(); }
});

test('colliding declarations are all withheld, never combined or selected by path', () => {
  const aliased = WRITE_ROUTE.replace('../../parser', '@/parser').replace('../../write', '@/write');
  const fixture = makeWriteFixture({ 'src/app/items/route.ts': aliased, 'src/app/other/route.ts': aliased });
  try {
    const output = run(fixture.root);
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
    assert.match(output.result.diagnostics.join('\n'), /COLLISION/);
    assert.equal(output.result.status, 'UNAVAILABLE');
  } finally { fixture.dispose(); }
});

test('missing current data mapping withholds the local contract and its deletion authority', () => {
  const fixture = makeWriteFixture({ 'legacy.ts': "import {z} from 'zod'; export const Legacy = z.object({ok: z.boolean()});" });
  try {
    const output = extractContracts({ repoRoot: fixture.root, repo: 'write-demo', runId: 'run-proof' });
    assert.equal(output.result.status, 'PASS');
    assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract').map(node => node.name), ['Legacy']);
    assert.match(output.result.diagnostics.join('\n'), /WRITE_DATA_INDEX_UNAVAILABLE/);
    assert.ok(output.result.authoritative[0]?.selector !== undefined);
    assert.equal(output.result.authoritative[0]?.selector?.includes('src/app/items/route.ts'), false);
  } finally { fixture.dispose(); }
});


test('unsupported but identifiable duplicates retain their declared write-key reservations', () => {
  const aliased = WRITE_ROUTE.replace('../../parser', '@/parser').replace('../../write', '@/write');
  for (const unknown of [
    aliased.replace("kind: z.enum(['note'])});", "kind: z.enum(['note'])}).refine(check);"),
    aliased.replace('const schema =', 'let schema ='),
    aliased.replace('const {body, error}', 'consume(schema); const {body, error}'),
    aliased.replace('decode(request, schema)', 'decode(request, schema, options)'),
    aliased.replace('if (error) { return error(); }', ''),
    aliased.replace('const {body, error}', 'const {body}').replace('if (error) { return error(); }', ''),
    ...['decode((request), schema)', 'decode(request, (schema))', 'decode(request, schema as Unknown)',
      'decode(request, schema!)', 'decode(request, forward(schema))', 'decode(forward(request), schema)',
      'parsing.decode(request, schema)',
    ].map(call => aliased.replace('decode(request, schema)', call)),
    aliased.replace('const {body, error} = await decode(request, schema);',
      'const alias = request; const {body, error} = await decode(alias, schema);'),
    aliased.replace('const {body, error} = await decode(request, schema);',
      'const alias = schema; const {body, error} = await decode(request, forward(alias));'),
    aliased.replace('await decode(request, schema)', 'decode(request, schema)'),
    aliased.replace('const {body, error}', 'let {body, error}'),
    aliased.replace('export async function POST', 'export function POST'),
    ...['POST({request}: {request: Request})', 'POST(request: Request = makeRequest())',
      'POST(...request: Request[])', 'POST()', 'POST(context: Context, request: Request)',
    ].map(signature => aliased.replace('POST(request: Request)', signature)),
    aliased.replace("z.object({title: z.string().optional(), caption: z.string().optional(), kind: z.enum(['note'])})", 'buildSchema()'),
  ]) {
    assert.notEqual(unknown, aliased);
    const fixture = makeWriteFixture({ 'src/app/items/route.ts': aliased, 'src/app/other/route.ts': unknown });
    try {
      const output = run(fixture.root);
      assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
      assert.match(output.result.diagnostics.join('\n'), /COLLISION/);
      assert.equal(output.result.status, 'UNAVAILABLE');
    } finally { fixture.dispose(); }
  }
});

test('opaque parser semantics cannot select a winner among identifiable duplicate keys', () => {
  const aliased = WRITE_ROUTE.replace('../../parser', '@/parser').replace('../../write', '@/write');
  for (const extra of [
    {'src/opaque.ts': 'export async function decode(request, schema) { return parseOpaque(request, schema); }'},
    {},
  ]) {
    const fixture = makeWriteFixture({...extra,
      'src/app/items/route.ts': aliased,
      'src/app/other/route.ts': aliased.replace('@/parser', '@/opaque'),
    });
    try {
      const output = run(fixture.root);
      assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
      assert.match(output.result.diagnostics.join('\n'), /COLLISION/);
      assert.equal(output.result.status, 'UNAVAILABLE');
    } finally { fixture.dispose(); }
  }
});
