import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteStore, compileSelector } from '@seamline/core';
import { extractContracts, CONTRACTS_SCOPE } from '@seamline/extract-contracts';

const canary = 'DIAGNOSTIC_CANARY_' + 'q'.repeat(32);
for (const name of ['data.yaml', 'openapi.yaml']) {
  for (const [kind, broken] of Object.entries({
    syntax: 'paths: [\n',
    stream: 'paths: {}\n---\npaths: [\n',
    private: `token: \"${canary}`,
  })) {
    test(`YAML ${kind} errors preserve earlier operations from ${name}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'seamline-yaml-source-'));
      const db = mkdtempSync(join(tmpdir(), 'seamline-yaml-store-'));
      const store = new SqliteStore({ path: join(db, 'graph.db'), ontologyVersion: '1.0.0' });
      const document = 'openapi: 3.0.3\ninfo: {title: API, version: "1"}\n';
      const persist = async (runId: string) => {
        const out = extractContracts({ repoRoot: root, repo: 'yaml', runId });
        await store.beginRun({
          runId,
          repo: 'yaml',
          commit: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          ontologyVersion: '1.0.0',
        });
        await store.upsertNodes(runId, out.nodes);
        await store.upsertEdges(runId, CONTRACTS_SCOPE, out.edges);
        await store.finalizeRun(runId, [out.result]);
        return out;
      };
      try {
        writeFileSync(
          join(root, 'keep.schema.json'),
          JSON.stringify({
            title: 'Keep',
            type: 'object',
            properties: { id: { type: 'string' } },
          }),
        );
        writeFileSync(
          join(root, name),
          document +
            'paths:\n  /users:\n    get:\n      operationId: users\n      responses: {"200": {description: ok}}\n',
        );
        const first = await persist('r1');
        assert.equal(first.result.status, 'PASS');
        const operations = store.nodesByKind('Operation');
        assert.equal(operations.length, 1);
        const operation = operations[0]!;
        const edges = store.edgesFrom(operation.id);
        assert.ok(edges.length > 0);
        writeFileSync(join(root, name), document + broken);
        const second = await persist('r2');
        assert.equal(second.result.status, name === 'data.yaml' ? 'PASS' : 'FAIL');
        assert.equal(store.node(operation.id)?.lastSeenRun, 'r1');
        assert.equal(store.node(operation.id)?.deletedAt, null);
        assert.deepEqual(store.edgesFrom(operation.id), edges);
        assert.ok(
          second.result.diagnostics.some((d) =>
            d.startsWith('CONTRACTS_PARTIAL_COVERAGE: 1 file(s)'),
          ),
        );
        assert.ok(
          second.nodes.some(
            (n) => n.kind === 'Contract' && n.props['unreadStructuredDocuments'] === 1,
          ),
        );
        assert.equal(JSON.stringify(second.result.diagnostics).includes(canary), false);
        const persisted = await store.getRun('r2');
        assert.ok(persisted);
        assert.equal(JSON.stringify(persisted.results).includes(canary), false);
        const selector = second.result.authoritative[0]?.selector;
        assert.equal(compileSelector(selector as string).matches(name), false);
      } finally {
        await store.close();
        rmSync(root, { recursive: true, force: true });
        rmSync(db, { recursive: true, force: true });
      }
    });
  }
}
