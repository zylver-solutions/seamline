/**
 * A scope an extractor could not refresh must stop reading PASS (v3 section
 * 2.2, THREATMODEL.md C4).
 *
 * `SqliteStore` answers `scopeStatus` from the latest run that *declared* the
 * scope. A result that declares no scope declares nothing, so an extractor that
 * passed on Monday and crashed on Tuesday would leave Monday's PASS standing,
 * and every detector over that scope would go on answering "clean" about a
 * graph nobody had refreshed. These tests run `seamline extract` twice over a
 * real store. The first run passes. The second run is the one that goes wrong,
 * in each of the ways the command itself can see it go wrong, and the scope
 * must read non-PASS afterwards and the detectors over it must say UNKNOWN.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AuthoritativeScope, ExtractorStatus } from '@seamline/ontology';
import { runDetectors } from '@seamline/contradictions';
import { SqliteStore } from '@seamline/core';
import { MANIFEST as DATA_MANIFEST } from '@seamline/extract-data';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo } from '../io.ts';
import type { CliDeps, ExtractorPort } from '../ports.ts';
import { runCli } from '../run.ts';
import { makeNode, makeResult } from '../testing.ts';
import { sqliteStorePort } from '../wiring.ts';
import type { ExtractReport } from './extract.ts';

const DATA: AuthoritativeScope = { scope: 'data', kinds: ['Table', 'DataSource', 'Migration'] };
const CODE: AuthoritativeScope = { scope: 'code.ts', kinds: ['File'] };

function extractor(
  name: string,
  scope: AuthoritativeScope,
  behaviour: 'pass' | 'throw' | 'pass-with-node-the-store-rejects' | ExtractorStatus,
): ExtractorPort {
  return {
    name,
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    produces: [scope],
    extract: (ctx) => {
      if (behaviour === 'throw') return Promise.reject(new Error('the extractor fell over'));
      const rejected = behaviour === 'pass-with-node-the-store-rejects';
      const status: ExtractorStatus = behaviour === 'pass' || rejected ? 'PASS' : behaviour;
      const node = makeNode({
        // A kind outside the ontology: the store refuses to persist it, after the extractor reported PASS.
        kind: rejected ? ('Bogus' as never) : (scope.kinds[0] ?? 'File'),
        canonicalName: `${name}/thing`,
        path: `${name}/thing`,
      });
      return Promise.resolve({
        // A passing result names its scope. A failure report says nothing about which scope it speaks for,
        // which is what a crash report looks like and what let the earlier PASS stand.
        result:
          status === 'PASS'
            ? { ...makeResult(name, status, [scope.scope]), authoritative: [scope] }
            : makeResult(name, status, [], ['it could not do its job']),
        nodes: status === 'PASS' ? [node, ...(scope.scope === 'data' ? [{
          ...makeNode({
            kind: 'DataSource', canonicalName: 'default',
            props: {
              dataSource: 'default', replayVersion: 1, replayEpoch: ctx.runId,
              replaySnapshotHash: 'a'.repeat(64), replayMembershipComplete: true,
              replayInventoryComplete: true, replayGroups: '[]', replayGroupCount: 0,
            },
          }),
          firstSeenRun: ctx.runId, lastSeenRun: ctx.runId,
        }] : [])] : [],
        edges: [],
      });
    },
  };
}

async function repo(): Promise<{ dir: string; out: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-degraded-'));
  const config = {
    ...defaultConfig('demo'),
    extractors: [
      { name: 'extract-code-ts', enabled: true, options: {} },
      { name: 'extract-data', enabled: true, options: {} },
    ],
  };
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(config), 'utf8');
  return { dir, out: path.join(dir, 'out') };
}

async function extract(
  where: { dir: string; out: string },
  runId: string,
  extractors: readonly ExtractorPort[],
): Promise<ExtractReport> {
  const io = bufferIo({ cwd: where.dir, isTty: false, env: {} });
  const deps: CliDeps = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => runId },
    store: sqliteStorePort(),
    extractors,
  };
  await runCli(deps, ['extract', '--out', where.out, '--json']);
  return JSON.parse(io.stdout()) as ExtractReport;
}

/** What a reader of the store sees now: the scope's status, and what a detector over it says. */
async function afterwards(where: { out: string }): Promise<{
  data: ExtractorStatus;
  code: ExtractorStatus;
  orphanedMigration: string | undefined;
}> {
  const store = new SqliteStore({ path: path.join(where.out, 'graph.db') });
  try {
    return {
      data: store.scopeStatus('data'),
      code: store.scopeStatus('code.ts'),
      orphanedMigration: runDetectors(store).detectors.find(
        (d) => d.code === 'X8_ORPHANED_MIGRATION',
      )?.outcome,
    };
  } finally {
    await store.close();
  }
}

async function firstRunPasses(where: { dir: string; out: string }): Promise<void> {
  const report = await extract(where, 'run-1', [
    extractor('extract-code-ts', CODE, 'pass'),
    extractor('extract-data', DATA, 'pass'),
  ]);
  assert.deepEqual(
    report.results.map((r) => r.status),
    ['PASS', 'PASS'],
  );
  assert.deepEqual(
    await afterwards(where),
    { data: 'PASS', code: 'PASS', orphanedMigration: 'clean' },
    'precondition: both scopes PASS and the detector runs',
  );
}

test("an extractor that throws on the second run leaves its scope FAIL and the detectors over it UNKNOWN, not run 1's PASS", async () => {
  const where = await repo();
  await firstRunPasses(where);

  const report = await extract(where, 'run-2', [
    extractor('extract-code-ts', CODE, 'pass'),
    extractor('extract-data', DATA, 'throw'),
  ]);

  const failed = report.results.find((r) => r.extractor === 'extract-data');
  assert.equal(failed?.status, 'FAIL');
  assert.match(failed?.diagnostics[0] ?? '', /fell over/);
  assert.deepEqual(
    failed?.authoritative,
    [DATA],
    'the failure names the scope it was responsible for',
  );
  assert.deepEqual(report.degradedScopes, ['data']);
  // The scope that did refresh is untouched: only the scope that failed is degraded.
  assert.deepEqual(await afterwards(where), {
    data: 'FAIL',
    code: 'PASS',
    orphanedMigration: 'unknown',
  });
});

test('an extractor that reports FAIL without naming a scope still takes its scope off PASS', async () => {
  const where = await repo();
  await firstRunPasses(where);

  const report = await extract(where, 'run-2', [
    extractor('extract-code-ts', CODE, 'pass'),
    extractor('extract-data', DATA, 'FAIL'),
  ]);

  assert.deepEqual(report.results.find((r) => r.extractor === 'extract-data')?.authoritative, [
    DATA,
  ]);
  assert.deepEqual(await afterwards(where), {
    data: 'FAIL',
    code: 'PASS',
    orphanedMigration: 'unknown',
  });
});

test('a configured first-party extractor that is not wired in takes its scope to UNAVAILABLE', async () => {
  const where = await repo();
  await firstRunPasses(where);

  const report = await extract(where, 'run-2', [extractor('extract-code-ts', CODE, 'pass')]);

  const missing = report.results.find((r) => r.extractor === 'extract-data');
  assert.equal(missing?.status, 'UNAVAILABLE');
  assert.match(missing?.diagnostics[0] ?? '', /no implementation registered/);
  assert.deepEqual(
    missing?.authoritative,
    DATA_MANIFEST.produces.map(({ scope, kinds }) => ({ scope, kinds })),
    'unavailable coverage retains the manifest scopes and kinds without an absence selector',
  );
  assert.deepEqual(await afterwards(where), {
    data: 'UNAVAILABLE',
    code: 'PASS',
    orphanedMigration: 'unknown',
  });
});

test("an extractor that returns PASS and then has its output refused by the store ends as one FAIL result, and run 1's PASS does not stand", async () => {
  const where = await repo();
  await firstRunPasses(where);

  const io = bufferIo({ cwd: where.dir, isTty: false, env: {} });
  const deps: CliDeps = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-2' },
    store: sqliteStorePort(),
    extractors: [
      extractor('extract-code-ts', CODE, 'pass'),
      extractor('extract-data', DATA, 'pass-with-node-the-store-rejects'),
    ],
  };
  const exit = await runCli(deps, ['extract', '--out', where.out, '--json']);
  // Two results for one extractor made `finalizeRun` throw (UNIQUE on run and extractor), the
  // transaction rolled back, the command exited 3, and run 1 stood for every scope.
  assert.equal(exit, 1, `the command must report the failure, not crash: ${io.stderr()}`);
  const report = JSON.parse(io.stdout()) as ExtractReport;
  assert.deepEqual(
    report.results.map((r) => [r.extractor, r.status]),
    [
      ['extract-code-ts', 'PASS'],
      ['extract-data', 'FAIL'],
    ],
  );
  assert.deepEqual(report.results.find((r) => r.extractor === 'extract-data')?.authoritative, [
    DATA,
  ]);
  assert.deepEqual(report.degradedScopes, ['data']);
  assert.deepEqual(await afterwards(where), {
    data: 'FAIL',
    code: 'PASS',
    orphanedMigration: 'unknown',
  });
});

test('a port that does not say what it produces still takes its bundled scopes off PASS when it throws', async () => {
  const where = await repo();
  await firstRunPasses(where);

  // An embedder's port for `extract-data` that omits `produces`: the fallback is the bundled manifest.
  const silent: ExtractorPort = {
    name: 'extract-data',
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () => Promise.reject(new Error('the extractor fell over')),
  };
  const report = await extract(where, 'run-2', [
    extractor('extract-code-ts', CODE, 'pass'),
    silent,
  ]);

  const result = report.results.find((r) => r.extractor === 'extract-data');
  assert.equal(result?.status, 'FAIL');
  assert.deepEqual(result?.authoritative,
    DATA_MANIFEST.produces.map(({ scope, kinds }) => ({ scope, kinds })));
  assert.deepEqual(await afterwards(where), {
    data: 'FAIL',
    code: 'PASS',
    orphanedMigration: 'unknown',
  });
});
