import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SqliteStore } from '@seamline/core';
import { runDetectors } from '@seamline/contradictions';
import { extractCodeTs, CODE_TS_SCOPE } from '@seamline/extract-code-ts';
import { extractContracts, CONTRACTS_SCOPE } from '@seamline/extract-contracts';
import { extractData, DATA_SCOPE } from '@seamline/extract-data';
import { inferJoins, INFER_JOIN_SCOPE, toExtractorResult } from '@seamline/infer-join';

for (const [columnType, propertyType, expected] of [
  ['text', 'object', 'unknown'],
  ['text', 'array', 'unknown'],
  ['jsonb', 'string', 'unknown'],
  ['integer', 'boolean', 'fired'],
  ['integer', 'string', 'fired'],
  ['integer', 'number', 'clean'],
] as const) {
  test(`source ${columnType}/${propertyType} preserves facts and joins while X2 is ${expected}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'seamline-representation-'));
    const dir = mkdtempSync(join(tmpdir(), 'seamline-representation-store-'));
    const store = new SqliteStore({ path: join(dir, 'graph.db'), ontologyVersion: '1.0.0' });
    try {
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['*.ts'] }));
      writeFileSync(join(root, 'model.ts'), 'export interface Order { payload: unknown }\n');
      writeFileSync(join(root, 'schema.sql'), `CREATE TABLE orders (payload ${columnType});\n`);
      const payload = propertyType === 'array' ? { type: propertyType, items: { type: 'string' } } : { type: propertyType };
      const schema = { type: 'object', properties: { Order: { type: 'object', properties: { payload } } } };
      writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Orders', version: '1' }, paths: { '/orders': { get: { responses: { '200': { description: 'Order', content: { 'application/json': { schema } } } } } } } }));
      const runId = 'extract';
      const args = { repo: 'representation', runId };
      const data = await extractData({ ...args, root, deterministic: true });
      const code = extractCodeTs({ ...args, repoRoot: root, deterministic: true });
      const contracts = extractContracts({ ...args, repoRoot: root });
      const begin = (id: string) => store.beginRun({ runId: id, repo: args.repo, commit: null, startedAt: '2026-01-01T00:00:00.000Z', ontologyVersion: '1.0.0' });
      for (const r of [data.result, code.result, contracts.result]) assert.equal(r.status, 'PASS', r.diagnostics.join('\n'));
      await begin(runId);
      await store.upsertNodes(runId, [...data.nodes, ...code.nodes, ...contracts.nodes]);
      for (const [scope, edges] of [[DATA_SCOPE, data.edges], [CODE_TS_SCOPE, code.edges], [CONTRACTS_SCOPE, contracts.edges]] as const) await store.upsertEdges(runId, scope, edges);
      await store.finalizeRun(runId, [data.result, code.result, contracts.result]);
      const inferred = inferJoins(store, { runId: 'join' });
      assert.equal(inferred.status, 'PASS');
      await begin('join');
      await store.upsertEdges('join', INFER_JOIN_SCOPE, inferred.edges);
      await store.finalizeRun('join', [toExtractorResult(inferred, 0)]);

      const columns = data.nodes.filter((n) => n.kind === 'Column' && n.name === 'payload');
      const properties = contracts.nodes.filter((n) => n.kind === 'SchemaProperty' && n.name === 'payload');
      assert.equal(columns.length, 1);
      assert.equal(properties.length, 1);
      const column = columns[0]!;
      const property = properties[0]!;
      assert.equal(column.props['type'], columnType);
      assert.equal(property.props['type'], propertyType === 'array' ? 'array<string>' : propertyType);
      assert.equal(column.provenance, 'EXTRACTED');
      assert.equal(property.provenance, 'EXTRACTED');
      assert.deepEqual(store.node(column.id)?.props, column.props);
      assert.deepEqual(store.node(property.id)?.props, property.props);
      const mapping = inferred.edges.find((e) => (e.kind === 'EXPOSED_AS' && e.src === column.id && e.dst === property.id) || (e.kind === 'BACKED_BY' && e.src === property.id && e.dst === column.id));
      assert.ok(mapping, `missing direct column/property mapping for ${columnType}/${propertyType}`);
      assert.equal(mapping.provenance, 'INFERRED');
      assert.ok(mapping.confidence > 0);
      const result = runDetectors(store).detectors.find((d) => d.code === 'X2_TYPE');
      assert.ok(result);
      assert.equal(result.outcome, expected);
      if (expected === 'unknown') {
        assert.equal(result.result.known, false);
        if (!result.result.known) assert.match(result.result.reason, propertyType === 'array' ? /^VALUE_ROLE_UNOBSERVED:/ : /^REPRESENTATION_UNOBSERVED:/);
        assert.deepEqual(result.findings, []);
      } else {
        assert.equal(result.result.known, true);
        assert.equal(result.findings.length, expected === 'fired' ? 1 : 0);
        if (expected === 'fired') {
          assert.equal(result.findings[0]!.left, column.id);
          assert.equal(result.findings[0]!.right, property.id);
          assert.equal(result.findings[0]!.confidence, mapping.confidence);
        }
      }
    } finally {
      await store.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
