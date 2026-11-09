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

test('source response nullability, not stricter request validation, drives X1', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seamline-response-'));
  const dir = mkdtempSync(join(tmpdir(), 'seamline-response-store-'));
  const store = new SqliteStore({ path: join(dir, 'graph.db'), ontologyVersion: '1.0.0' });
  try {
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ESNext', module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['*.ts'] }));
    writeFileSync(join(root, 'model.ts'), 'export interface OrderRow { shippedAt: string | null }\n');
    writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE orders (shipped_at text);\n');
    for (const [index, responseNullable] of [false, true].entries()) {
      const schema = (nullable: boolean) => ({ type: 'object', properties: { Order: { type: 'object', required: ['shippedAt'], properties: { shippedAt: { type: 'string', nullable } } } } });
      const content = (nullable: boolean) => ({ 'application/json': { schema: schema(nullable) } });
      writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Orders', version: '1' }, paths: { '/orders': { post: { requestBody: { content: content(false) }, responses: { '200': { description: 'Order', content: content(responseNullable) } } } } } }));
      const args = { repo: 'response', runId: `extract-${index}` };
      const data = await extractData({ ...args, root, deterministic: true });
      const code = extractCodeTs({ ...args, repoRoot: root, deterministic: true });
      const contracts = extractContracts({ ...args, repoRoot: root });
      const begin = (runId: string) => store.beginRun({ runId, repo: 'response', commit: null, startedAt: '2026-01-01T00:00:00.000Z', ontologyVersion: '1.0.0' });
      for (const r of [data.result, code.result, contracts.result]) assert.equal(r.status, 'PASS', r.diagnostics.join('\n'));
      await begin(args.runId);
      await store.upsertNodes(args.runId, [...data.nodes, ...code.nodes, ...contracts.nodes]);
      for (const [scope, edges] of [[DATA_SCOPE, data.edges], [CODE_TS_SCOPE, code.edges], [CONTRACTS_SCOPE, contracts.edges]] as const) await store.upsertEdges(args.runId, scope, edges);
      await store.finalizeRun(args.runId, [data.result, code.result, contracts.result]);
      const runId = `join-${index}`;
      const inferred = inferJoins(store, { runId });
      assert.equal(inferred.status, 'PASS');
      await begin(runId);
      await store.upsertEdges(runId, INFER_JOIN_SCOPE, inferred.edges);
      await store.finalizeRun(runId, [toExtractorResult(inferred, 0)]);
      const properties = contracts.nodes.filter((n) => n.kind === 'SchemaProperty' && n.name === 'shippedAt');
      assert.equal(properties.length, 2);
      for (const p of properties) assert.ok(inferred.edges.some((e) => e.src === p.id || e.dst === p.id), `unjoined ${p.id}`);
      const report = runDetectors(store);
      const found = report.findings.filter((f) => f.code === 'X1_NULLABILITY');
      assert.equal(found.length, responseNullable ? 0 : 1);
      if (!responseNullable) assert.match(found[0]!.right, /responses/);
      assert.equal(report.detectors.find((d) => d.code === 'X1_NULLABILITY')?.outcome, responseNullable ? 'clean' : 'fired');
    }
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
