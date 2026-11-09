/** Real TypeScript extraction enters the extensible registry, retaining evidence. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractCodeTs } from '@seamline/extract-code-ts';
import {
  CompiledRegistry,
  SemanticEngine,
  legacyCodeProfile,
  prepareLegacyImport,
  legacyScopeStatus,
} from '@seamline/core/semantic';

test('real TypeScript facts compose with the generic code profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'seamline-semantic-bridge-'));
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'semantic-fixture', type: 'module' }),
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] }),
    );
    writeFileSync(
      join(root, 'index.ts'),
      'export function target(): number { return 1; }\nexport function caller(): number { return target(); }\n',
    );
    const output = extractCodeTs({
      repoRoot: root,
      repo: 'fixture',
      runId: 'r1',
      deterministic: true,
    });
    assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
    const registry = new CompiledRegistry([legacyCodeProfile]);
    const args = prepareLegacyImport(output.nodes, output.edges, {
      runId: 'r1',
      repo: 'fixture',
      commit: null,
      ontologyVersion: '1.0.0',
      startedAt: '2026-01-01',
      finishedAt: '2026-01-01',
      results: [output.result],
    });
    const db = join(root, 'semantic.db');
    const access = { tenant: 'fixture', actor: 'importer', authorize: () => true };
    const engine = new SemanticEngine(db, registry, access);
    engine.createUniverse('software');
    engine.createWorld('software', 'project', [
      { id: 'revision', unit: 'commit', ticksPerUnit: { numerator: 1, denominator: 1 } },
    ]);
    const scope = { world: 'project', branch: 'main' };
    engine.submit({
      scope,
      expectedRevision: 0,
      commandId: 'import-r1',
      command: 'code.import',
      args,
      timeline: 'revision',
      validAt: 1,
    });
    engine.close();
    const reopened = new SemanticEngine(db, registry, access);
    try {
      const snapshot = reopened.snapshot(scope, {
        unfiltered: true,
        timeline: 'revision',
        validAt: 1,
      }).snapshot;
      const original = output.edges.find((edge) => edge.kind === 'CALLS');
      assert.ok(original, 'the real extractor found the actual invocation');
      const call = snapshot.relations.find((edge) => edge.type === 'code.CALLS');
      assert.equal(call?.from, original.src);
      assert.equal(call?.to, original.dst);
      assert.equal(call?.properties['provenance'], original.provenance);
      assert.equal(legacyScopeStatus(snapshot, 'code.ts'), 'PASS');
      const traversal = reopened.query(scope, {
        unfiltered: true,
        timeline: 'revision',
        validAt: 1,
        from: [original.src],
        via: ['code.CALLS'],
        maxDepth: 1,
        limit: 10,
      });
      assert.ok(traversal.entities.some((entity) => entity.id === original.dst));
      const unavailable = prepareLegacyImport(output.nodes, output.edges, {
        runId: 'r2',
        repo: 'fixture',
        commit: null,
        ontologyVersion: '1.0.0',
        startedAt: '2026-01-02',
        finishedAt: '2026-01-02',
        results: [{ ...output.result, status: 'UNAVAILABLE' }],
      });
      reopened.submit({
        scope,
        expectedRevision: 1,
        commandId: 'import-r2',
        command: 'code.import',
        args: unavailable,
        timeline: 'revision',
        validAt: 2,
      });
      const later = reopened.snapshot(scope, {
        unfiltered: true,
        timeline: 'revision',
        validAt: 2,
      }).snapshot;
      assert.equal(legacyScopeStatus(later, 'code.ts'), 'UNAVAILABLE');
      assert.ok(later.entities.some((entity) => entity.id === original.src));
      assert.equal(
        legacyScopeStatus(
          reopened.snapshot(scope, { unfiltered: true, timeline: 'revision', validAt: 1 }).snapshot,
          'code.ts',
        ),
        'PASS',
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
