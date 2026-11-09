import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { currentObservationOf, isCompletedRun, SqliteStore } from '@seamline/core';
import type { ExtractorResult } from '@seamline/ontology';
import type { CheckReport } from '../commands/check.ts';
import type { ExtractReport } from '../commands/extract.ts';
import { defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo } from '../io.ts';
import { runCli } from '../run.ts';
import { parseSif } from '../sif.ts';
import { buildCliDeps } from '../wiring.ts';

const REPO = 'empty-schema-cli';
const cases = [
  { name: 'empty-response', schema: {}, required: true, response: true, nullable: true, confidence: 0.8225, x1: 'silent', exit: 0 },
  { name: 'string-response', schema: { type: 'string' }, required: true, response: true, nullable: false, confidence: 0.89, x1: 'fired', exit: 1 },
  { name: 'nullable-required-response', schema: { type: ['string', 'null'] }, required: true, response: true, nullable: true, confidence: 0.89, x1: 'silent', exit: 0 },
  { name: 'nullable-optional-response', schema: { type: ['string', 'null'] }, required: false, response: true, nullable: true, confidence: 0.89, x1: 'silent', exit: 0 },
  { name: 'empty-request-only', schema: {}, required: true, response: false, nullable: true, confidence: 0.8225, x1: 'unknown', exit: 0 },
  { name: 'opaque-empty-response', schema: {}, required: true, response: true, nullable: undefined,
    confidence: 0.8225, x1: 'unknown', exit: 0, dialect: 'https://example.invalid/dialect' },
  { name: 'true-required-response', schema: true, required: true, response: true, nullable: true, confidence: 0.8225, x1: 'silent', exit: 0 },
  { name: 'true-optional-response', schema: true, required: false, response: true, nullable: true, confidence: 0.8225, x1: 'silent', exit: 0 },
  { name: 'true-request-only', schema: true, required: true, response: false, nullable: true, confidence: 0.8225, x1: 'unknown', exit: 0 },
  { name: 'opaque-true-response', schema: true, required: true, response: true, nullable: undefined,
    confidence: 0.8225, x1: 'unknown', exit: 0, dialect: 'https://example.invalid/dialect' },
  { name: 'opaque-ancestor-true-response', schema: true, required: true, response: true, nullable: undefined,
    confidence: 0.8225, x1: 'unknown', exit: 0, opaqueAncestor: true },
] as const;

// Kinds are membership metadata, canonically sorted by persistence. Other arrays and all fields remain exact.
function comparableResults(rows: readonly ExtractorResult[]) {
  return rows.map(row => ({ ...row, authoritative: row.authoritative.map(claim => ({
    ...claim, kinds: [...claim.kinds].sort(),
  })) })).sort((a, b) => a.extractor.localeCompare(b.extractor));
}
async function command(root: string, out: string, verb: 'extract' | 'check') {
  const io = bufferIo({ cwd: root, env: { PATH: process.env['PATH'] ?? '', SEAMLINE_DETERMINISTIC: '1' } });
  const deps = buildCliDeps(io);
  assert.deepEqual(deps.extractors?.map(e => [e.name, e.confinement]), [
    ['extract-code-ts', 'process-sandbox'], ['extract-data', 'process-sandbox'],
    ['extract-contracts', 'process-sandbox'], ['extract-change', 'process-sandbox'],
    ['infer-join', 'process-sandbox'],
  ]);
  const exit = await runCli(deps, [verb, '--repo', root, '--out', out, '--json']);
  return { exit, stdout: io.stdout(), stderr: io.stderr() };
}

for (const item of cases) {
  test(`production CLI preserves source nullability and authority for ${item.name}`, async t => {
    const scratch = mkdtempSync(join(tmpdir(), 'seamline-empty-schema-cli-'));
    const root = join(scratch, 'repo'); const out = join(scratch, 'store');
    mkdirSync(root);
    const config = defaultConfig(REPO);
    writeFileSync(join(root, 'seamline.config.json'), serializeConfig({ ...config,
      extractors: config.extractors.filter(e => e.name !== 'extract-change') }));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ESNext', module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['model.ts'] }));
    writeFileSync(join(root, 'model.ts'), 'export const alive = 1;\n');
    writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE orders (value text);\n');
    const schema = { type: 'object', properties: { Order: { type: 'object',
      ...('opaqueAncestor' in item ? { additionalProperties: false } : {}),
      required: item.required ? ['value'] : [], properties: { value: item.schema } } } };
    const content = { 'application/json': { schema } };
    const operation = item.response ? { responses: { '200': { description: 'Order', content } } }
      : { requestBody: { content }, responses: { '200': { description: 'No response shape declared' } } };
    writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.1.0',
      ...('dialect' in item ? { jsonSchemaDialect: item.dialect } : {}),
      info: { title: 'Orders', version: '1' }, paths: { '/orders': { post: operation } } }));
    try {
      const rawExtract = await command(root, out, 'extract');
      t.diagnostic(JSON.stringify({ case: item.name, stage: 'extract', ...rawExtract }));
      assert.equal(rawExtract.exit, 0, rawExtract.stderr);
      const extracted = JSON.parse(rawExtract.stdout) as ExtractReport;
      assert.deepEqual(extracted.results.map(r => [r.extractor, r.status]), [
        ['extract-code-ts', 'PASS'], ['extract-data', 'PASS'], ['extract-contracts', 'PASS'], ['infer-join', 'PASS'],
      ]);
      const bytes = readFileSync(join(out, 'runs', `${extracted.runId}.sif`));
      const snapshot = parseSif(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'empty-schema-cli.sif');
      t.diagnostic(JSON.stringify({ case: item.name, stage: 'snapshot',
        sha256: createHash('sha256').update(bytes).digest('hex'), snapshot }));
      const run = snapshot.run;
      assert.ok(isCompletedRun(run)); assert.equal(run.runId, extracted.runId);
      assert.equal(run.repo, REPO); assert.equal(snapshot.runId, run.runId);
      assert.deepEqual(run.results, snapshot.results);
      assert.deepEqual(comparableResults(snapshot.results), comparableResults(extracted.results));
      assert.equal(new Set(snapshot.nodes.map(n => n.id)).size, snapshot.nodes.length);
      assert.equal(new Set(snapshot.edges.map(e => JSON.stringify([e.src, e.dst, e.kind]))).size, snapshot.edges.length);
      const columns = snapshot.nodes.filter(n => n.kind === 'Column' && n.name === 'value');
      const properties = snapshot.nodes.filter(n => n.kind === 'SchemaProperty' && n.name === 'value');
      assert.equal(columns.length, 1); assert.equal(properties.length, 1);
      const column = columns[0]!; const property = properties[0]!;
      assert.equal(column.id, `${REPO}:Column:public.orders.value`);
      assert.equal(column.path, 'schema.sql'); assert.equal(column.sourceRef, 'schema.sql:1');
      assert.equal(column.props['nullable'], true);
      assert.equal(column.props['schema'], 'public'); assert.equal(column.props['table'], 'orders');
      const pointer = '/paths/~1orders/post/' + (item.response ? 'responses/200/' : 'requestBody/') +
        'content/application~1json/schema/properties/Order/properties/value';
      assert.equal(property.id, `${REPO}:SchemaProperty:Orders#${pointer}`);
      assert.equal(property.path, 'openapi.json'); assert.equal(property.sourceRef, `openapi.json#${pointer}`);
      assert.equal(property.props['jsonPointer'], pointer);
      assert.equal(property.props['direction'], undefined);
      assert.equal(property.props['required'], item.required);
      assert.ok(property.props['nullable'] === true || property.props['nullable'] === false || property.props['nullable'] === undefined);
      assert.equal(property.props['type'], item.name === 'string-response' ? 'string'
        : item.name.startsWith('nullable') ? 'null|string' : undefined);
      assert.equal(snapshot.nodes.some(n => n.kind === 'CodeField' && n.name === 'value'), false);
      for (const node of [column, property]) {
        assert.equal(node.provenance, 'EXTRACTED'); assert.equal(node.deletedAt, null);
        assert.equal(node.firstSeenRun, run.runId); assert.equal(node.lastSeenRun, run.runId);
      }
      const mappings = snapshot.edges.filter(e =>
        (e.kind === 'EXPOSED_AS' && e.src === column.id && e.dst === property.id) ||
        (e.kind === 'BACKED_BY' && e.src === property.id && e.dst === column.id));
      assert.equal(mappings.length, 2);
      assert.deepEqual(mappings.map(e => e.kind).sort(), ['BACKED_BY', 'EXPOSED_AS']);
      for (const edge of mappings) {
        assert.equal(edge.deletedAt, null); assert.equal(edge.provenance, 'INFERRED');
        assert.equal(edge.confidence, item.confidence);
        assert.equal(edge.props['ambiguous'], false); assert.equal(edge.props['candidateCount'], 1);
        assert.equal(edge.firstSeenRun, run.runId); assert.equal(edge.lastSeenRun, run.runId);
      }
      const database = join(out, 'graph.db');
      const store = new SqliteStore({ path: database });
      try {
        const persisted = await store.getRun(run.runId);
        assert.ok(isCompletedRun(persisted)); assert.deepEqual(persisted, run);
        assert.deepEqual(await store.listRuns(2), [run]);
        const current = currentObservationOf(persisted);
        assert.equal(current('data', column), true); assert.equal(current('contracts', property), true);
        for (const scope of ['code.ts', 'data', 'contracts', 'infer-join']) assert.equal(store.scopeStatus(scope), 'PASS');
        for (const node of snapshot.nodes) {
          assert.equal(node.firstSeenRun, run.runId); assert.equal(node.lastSeenRun, run.runId);
          assert.deepEqual(store.node(node.id), node);
        }
        for (const edge of snapshot.edges) {
          assert.equal(edge.firstSeenRun, run.runId); assert.equal(edge.lastSeenRun, run.runId);
          const rows = store.edgesFrom(edge.src, edge.kind).filter(e => e.dst === edge.dst);
          assert.equal(rows.length, 1); assert.deepEqual(rows[0], edge);
        }
        // Private test forensics closes the inventory; no raw query is added to the product.
        const raw = new DatabaseSync(database, { readOnly: true });
        try {
          assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number }).n, snapshot.nodes.length);
          assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM edges').get() as { n: number }).n, snapshot.edges.length);
        } finally { raw.close(); }
      } finally { await store.close(); }

      // Retain every raw report before semantic expectations, including on the intentional red parent.
      const rawCheck = await command(root, out, 'check');
      t.diagnostic(JSON.stringify({ case: item.name, stage: 'check', ...rawCheck }));
      const checked = JSON.parse(rawCheck.stdout) as CheckReport;
      assert.equal(rawCheck.exit, checked.exitCode);
      const findings = checked.contradictions.filter(f => f.code === 'X1_NULLABILITY');
      const unknown = checked.unknownDetectors.find(d => d.code === 'X1_NULLABILITY');
      if (item.response) {
        assert.equal(checked.contradictions.filter(f => f.code === 'X4_UNBACKED_PROPERTY').length, 1,
          'X1 silence does not dismiss the existing low container finding');
      }
      assert.ok(checked.unknownDetectors.some(d => d.code === 'X7_VALIDATOR_DIVERGENCE'));
      assert.equal(checked.unknownDetectors.some(d => d.code === 'X2_TYPE'), item.name !== 'string-response');
      assert.ok(checked.detectorNotes.some(d => d.code === 'X6_PII_UNAUTHENTICATED'));
      for (const finding of findings) {
        assert.equal(finding.left, column.id); assert.equal(finding.right, property.id);
        assert.equal(finding.confidence, item.confidence); assert.equal(finding.severity, 'high');
        assert.deepEqual(finding.viaPath, ['EXPOSED_AS']);
      }
      assert.equal(property.props['nullable'], item.nullable, `${item.name}: expected source nullable facet ${String(item.nullable)}`);
      if (item.x1 === 'unknown') {
        assert.equal(findings.length, 0); assert.ok(unknown);
        assert.match(unknown.reason, /^VALUE_ROLE_UNOBSERVED:/);
      } else {
        assert.equal(unknown, undefined); assert.equal(findings.length, item.x1 === 'fired' ? 1 : 0);
      }
      assert.equal(rawCheck.exit, item.exit);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}
