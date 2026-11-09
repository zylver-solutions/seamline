import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { isCompletedRun, SqliteStore } from '@seamline/core';
import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import type { CheckReport } from '../commands/check.ts';
import type { ExtractReport } from '../commands/extract.ts';
import { defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo } from '../io.ts';
import { runCli } from '../run.ts';
import { parseSif } from '../sif.ts';
import { buildCliDeps } from '../wiring.ts';

// These sources are authored controls of the existing grammar, not corpus data.
async function fixture(run: (root: string, out: string) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'seamline-precision-cli-'));
  const root = join(scratch, 'repo');
  const out = join(scratch, 'store');
  mkdirSync(root);
  const defaults = defaultConfig('precision-cli');
  writeFileSync(join(root, 'seamline.config.json'), serializeConfig({
    ...defaults,
    extractors: defaults.extractors.filter(e => e.name !== 'extract-change'),
  }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ESNext', module: 'NodeNext', moduleResolution: 'NodeNext' },
    include: ['model.ts'],
  }));
  writeFileSync(join(root, 'model.ts'), 'export interface Order { value: string | null; flag: unknown }\n');
  try { await run(root, out); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

async function command(root: string, out: string, args: readonly string[]) {
  const io = bufferIo({ cwd: root, env: { PATH: process.env['PATH'] ?? '', SEAMLINE_DETERMINISTIC: '1' } });
  const deps = buildCliDeps(io);
  assert.deepEqual(deps.extractors?.map(e => [e.name, e.confinement]), [
    ['extract-code-ts', 'process-sandbox'], ['extract-data', 'process-sandbox'],
    ['extract-contracts', 'process-sandbox'], ['extract-change', 'process-sandbox'],
    ['infer-join', 'process-sandbox'],
  ]);
  const exit = await runCli(deps, [...args, '--repo', root, '--out', out, '--json']);
  return { exit, stdout: io.stdout(), stderr: io.stderr() };
}

async function extract(root: string, out: string) {
  const raw = await command(root, out, ['extract']);
  assert.equal(raw.exit, 0, raw.stderr);
  const report = JSON.parse(raw.stdout) as ExtractReport;
  assert.deepEqual(report.results.map(r => [r.extractor, r.status]), [
    ['extract-code-ts', 'PASS'], ['extract-data', 'PASS'],
    ['extract-contracts', 'PASS'], ['infer-join', 'PASS'],
  ]);
  const bytes = readFileSync(join(out, 'runs', `${report.runId}.sif`), 'utf8');
  const snapshot = parseSif(bytes, 'precision-cli.sif');
  assert.ok(snapshot.run, 'serialized output must retain actual completed run authority');
  assert.ok(isCompletedRun(snapshot.run));
  assert.notEqual(snapshot.run.finishedAt, null);
  assert.deepEqual(snapshot.run.results, snapshot.results);
  assert.equal(snapshot.run.runId, report.runId);
  return { snapshot, bytes };
}

async function check(root: string, out: string) {
  const raw = await command(root, out, ['check']);
  const report = JSON.parse(raw.stdout) as CheckReport;
  assert.equal(raw.exit, report.exitCode);
  assert.ok(raw.exit === 0 || raw.exit === 1, raw.stderr);
  return report;
}

function propertySchema(nullable: boolean, valueType = 'string', flagType?: string) {
  return { type: 'object', properties: { Order: {
    type: 'object', required: ['value'], properties: {
      value: { type: valueType, nullable },
      ...(flagType === undefined ? {} : { flag: { type: flagType } }),
    },
  } } };
}

function openApi(root: string, nullable: boolean, valueType = 'string', flagType?: string, requestOnly = false, includeRequest = true) {
  const content = (response: boolean) => ({ 'application/json': { schema: propertySchema(response ? nullable : false, valueType, flagType) } });
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({
    openapi: '3.0.3', info: { title: 'Orders', version: '1' }, paths: { '/orders': { post: {
      ...(includeRequest ? { requestBody: { content: content(false) } } : {}),
      responses: { '200': { description: 'Order', ...(requestOnly ? {} : { content: content(true) }) } },
    } } },
  }));
}

function fact(node: SeamlineNode): void {
  assert.equal(node.deletedAt, null);
  assert.equal(node.provenance, 'EXTRACTED');
}

async function comparison(out: string, nodes: readonly SeamlineNode[], edges: readonly SeamlineEdge[], name: string, response: boolean, currentRun: string, firstStoredRun?: string) {
  const columns = nodes.filter(n => n.kind === 'Column' && n.name === name);
  const properties = nodes.filter(n => n.kind === 'SchemaProperty' && n.name === name &&
    (response ? /^\/paths\/[^/]+\/[^/]+\/responses\//.test(String(n.props['jsonPointer'])) : true));
  assert.equal(columns.length, 1);
  assert.equal(properties.length, 1);
  const column = columns[0]!;
  const property = properties[0]!;
  fact(column); fact(property);
  const mappings = edges.filter(e => e.deletedAt === null &&
    ((e.kind === 'EXPOSED_AS' && e.src === column.id && e.dst === property.id) ||
     (e.kind === 'BACKED_BY' && e.src === property.id && e.dst === column.id)));
  assert.ok(mappings.length > 0, 'a negative outcome must not pass because its join disappeared');
  for (const edge of mappings) {
    assert.equal(edge.provenance, 'INFERRED');
    assert.ok(edge.confidence > 0 && edge.confidence <= 1);
  }
  const store = new SqliteStore({ path: join(out, 'graph.db') });
  try {
    for (const node of [column, property]) {
      assert.equal(node.firstSeenRun, currentRun, 'snapshot records the current observation');
      assert.equal(node.lastSeenRun, currentRun);
      assert.deepEqual(store.node(node.id), { ...node, firstSeenRun: firstStoredRun ?? currentRun });
    }
    for (const scope of ['code.ts', 'data', 'contracts', 'infer-join']) assert.equal(store.scopeStatus(scope), 'PASS');
    for (const edge of mappings) {
      const stored = store.edgesFrom(edge.src, edge.kind).filter(e => e.dst === edge.dst);
      assert.equal(stored.length, 1);
      assert.equal(edge.firstSeenRun, currentRun, 'snapshot records the current observation');
      assert.equal(edge.lastSeenRun, currentRun);
      assert.deepEqual(stored[0], { ...edge, firstSeenRun: firstStoredRun ?? currentRun });
    }
  } finally { await store.close(); }
  return { column, property, mappings };
}

test('CLI X1 uses a live nullable column and explicit response, then observes its repair', async () => {
  await fixture(async (root, out) => {
    writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE orders (value text);\n');
    let ids: readonly string[] | undefined;
    let firstStoredRun: string | undefined;
    for (const nullable of [false, true]) {
      openApi(root, nullable);
      const { snapshot } = await extract(root, out);
      firstStoredRun ??= snapshot.runId;
      if (nullable) assert.notEqual(snapshot.runId, firstStoredRun, 'the repair is a new observation');
      const pair = await comparison(out, snapshot.nodes, snapshot.edges, 'value', true, snapshot.runId, firstStoredRun);
      assert.equal(pair.column.props['nullable'], true);
      assert.equal(pair.property.props['nullable'], nullable);
      const nextIds = [pair.column.id, pair.property.id];
      if (ids !== undefined) assert.deepEqual(nextIds, ids);
      ids = nextIds;
      const report = await check(root, out);
      assert.ok(!report.unknownDetectors.some(d => d.code === 'X1_NULLABILITY'));
      const findings = report.contradictions.filter(f => f.code === 'X1_NULLABILITY');
      assert.equal(findings.length, nullable ? 0 : 1);
      if (!nullable) {
        assert.equal(findings[0]?.left, pair.column.id);
        assert.equal(findings[0]?.right, pair.property.id);
        assert.ok(pair.mappings.some(e => e.confidence === findings[0]?.confidence));
      }
      const requests = snapshot.nodes.filter(n => n.kind === 'SchemaProperty' && n.name === 'value' &&
        /^\/paths\/[^/]+\/[^/]+\/requestBody\//.test(String(n.props['jsonPointer'])));
      assert.equal(requests.length, 1);
      fact(requests[0]!);
      assert.equal(requests[0]?.props['nullable'], false);
      assert.ok(snapshot.edges.some(e => e.deletedAt === null && e.provenance === 'INFERRED' &&
        ((e.kind === 'EXPOSED_AS' && e.src === pair.column.id && e.dst === requests[0]?.id) ||
         (e.kind === 'BACKED_BY' && e.src === requests[0]?.id && e.dst === pair.column.id))));
      assert.ok(!findings.some(f => f.right === requests[0]?.id));
    }
    const first = await extract(root, join(out, 'repeat-a'));
    const second = await extract(root, join(out, 'repeat-b'));
    assert.equal(first.bytes, second.bytes);
  });
});

test('CLI X1 with a mapped stricter request remains UNKNOWN without response authority', async () => {
  await fixture(async (root, out) => {
    writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE orders (value text);\n');
    openApi(root, false, 'string', undefined, true);
    const { snapshot } = await extract(root, out);
    const pair = await comparison(out, snapshot.nodes, snapshot.edges, 'value', false, snapshot.runId);
    assert.match(String(pair.property.props['jsonPointer']), /^\/paths\/[^/]+\/[^/]+\/requestBody\//);
    assert.equal(pair.column.props['nullable'], true);
    assert.equal(pair.property.props['nullable'], false);
    const report = await check(root, out);
    assert.deepEqual(report.contradictions.filter(f => f.code === 'X1_NULLABILITY'), []);
    assert.match(report.unknownDetectors.find(d => d.code === 'X1_NULLABILITY')?.reason ?? '', /^VALUE_ROLE_UNOBSERVED:/);
  });
});

test('CLI X1 with a mapped standalone schema retains unknown response direction', async () => {
  await fixture(async (root, out) => {
    writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE orders (value text);\n');
    writeFileSync(join(root, 'schema.json'), JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema', ...propertySchema(false),
    }));
    const { snapshot } = await extract(root, out);
    const pair = await comparison(out, snapshot.nodes, snapshot.edges, 'value', false, snapshot.runId);
    assert.match(String(pair.property.props['jsonPointer']), /^\/properties\//);
    assert.equal(pair.property.props['direction'], undefined);
    assert.equal(pair.column.props['nullable'], true);
    assert.equal(pair.property.props['nullable'], false);
    const report = await check(root, out);
    assert.deepEqual(report.contradictions.filter(f => f.code === 'X1_NULLABILITY'), []);
    assert.match(report.unknownDetectors.find(d => d.code === 'X1_NULLABILITY')?.reason ?? '', /^VALUE_ROLE_UNOBSERVED:/);
  });
});

test('CLI X1 never reuses a previous PASS when current contract extraction fails', async () => {
  await fixture(async (root, out) => {
    writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE orders (value text);\n');
    openApi(root, false);
    const { snapshot } = await extract(root, out);
    await comparison(out, snapshot.nodes, snapshot.edges, 'value', true, snapshot.runId);
    assert.equal((await check(root, out)).contradictions.filter(f => f.code === 'X1_NULLABILITY').length, 1);
    writeFileSync(join(root, 'openapi.json'), '{"openapi":');
    const raw = await command(root, out, ['extract']);
    const failed = JSON.parse(raw.stdout) as ExtractReport;
    assert.notEqual(raw.exit, 0);
    assert.equal(failed.results.find(r => r.extractor === 'extract-contracts')?.status, 'FAIL');
    const report = await check(root, out);
    assert.deepEqual(report.contradictions.filter(f => f.code === 'X1_NULLABILITY'), []);
    const unknown = report.unknownDetectors.find(d => d.code === 'X1_NULLABILITY');
    assert.ok(unknown);
    assert.ok(unknown.scopes.includes('contracts'));
    assert.equal(unknown.scopeStatus['contracts'], 'FAIL');
  });
});

for (const [columnType, valueType, expected] of [
  ['integer', 'boolean', 'fired'], ['integer', 'number', 'quiet'],
  ['text', 'object', 'unknown'], ['jsonb', 'string', 'unknown'],
] as const) {
  test(`CLI X2 ${columnType}/${valueType} preserves endpoint and join authority`, async () => {
    await fixture(async (root, out) => {
      writeFileSync(join(root, 'schema.sql'), `CREATE TABLE orders (value ${columnType});\n`);
      openApi(root, true, valueType, undefined, false, false);
      const { snapshot } = await extract(root, out);
      const pair = await comparison(out, snapshot.nodes, snapshot.edges, 'value', true, snapshot.runId);
      assert.equal(pair.column.props['type'], columnType);
      assert.equal(pair.property.props['type'], valueType);
      const report = await check(root, out);
      const findings = report.contradictions.filter(f => f.code === 'X2_TYPE');
      const unknown = report.unknownDetectors.find(d => d.code === 'X2_TYPE');
      assert.equal(findings.length, expected === 'fired' ? 1 : 0);
      if (expected === 'unknown') assert.match(unknown?.reason ?? '', /^REPRESENTATION_UNOBSERVED:/);
      else assert.equal(unknown, undefined);
      if (expected === 'fired') {
        assert.equal(findings[0]?.left, pair.column.id);
        assert.equal(findings[0]?.right, pair.property.id);
        assert.ok(pair.mappings.some(e => e.confidence === findings[0]?.confidence));
      }
    });
  });
}

test('CLI X2 mixed graph retains incompatibility while disclosing an ambiguous representation', async () => {
  await fixture(async (root, out) => {
    writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE orders (value text, flag integer);\n');
    openApi(root, true, 'object', 'boolean', false, false);
    const { snapshot } = await extract(root, out);
    const ambiguous = await comparison(out, snapshot.nodes, snapshot.edges, 'value', true, snapshot.runId);
    const incompatible = await comparison(out, snapshot.nodes, snapshot.edges, 'flag', true, snapshot.runId);
    assert.equal(ambiguous.column.props['type'], 'text');
    assert.equal(ambiguous.property.props['type'], 'object');
    assert.equal(incompatible.column.props['type'], 'integer');
    assert.equal(incompatible.property.props['type'], 'boolean');
    const report = await check(root, out);
    const findings = report.contradictions.filter(f => f.code === 'X2_TYPE');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.left, incompatible.column.id);
    assert.equal(findings[0]?.right, incompatible.property.id);
    assert.ok(incompatible.mappings.some(e => e.confidence === findings[0]?.confidence && findings[0]?.viaPath.includes(e.kind)));
    assert.ok(!report.unknownDetectors.some(d => d.code === 'X2_TYPE'));
    assert.ok(report.detectorNotes.find(d => d.code === 'X2_TYPE')?.notes.some(note => /representation/i.test(note)));
  });
});
