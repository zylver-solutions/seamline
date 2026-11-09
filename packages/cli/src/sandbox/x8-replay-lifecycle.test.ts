/** Historical evidence through production CLI sandbox transport and SQLite. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteStore } from '@seamline/core';
import { runDetectors } from '@seamline/contradictions';
import { nodeId } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import type { ExtractReport } from '../commands/extract.ts';
import { bufferIo } from '../io.ts';
import { runCli } from '../run.ts';
import { buildCliDeps } from '../wiring.ts';

const CONFIG = 'project_id = "fixture"\n[db.migrations]\nenabled = true\nschema_paths = []\n';
const EARLY = 'ALTER TABLE public.accounts ADD COLUMN tag integer;';
const CREATE = 'CREATE TABLE public.accounts (id integer);';

test('sandboxed X8 certificates survive CLI storage, examined fixes and unavailable retries', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'seamline-x8-boxed-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'repo');
  const directory = join(repo, 'supabase/migrations');
  const out = join(scratch, 'out');
  await mkdir(directory, { recursive: true });
  await writeFile(join(repo, 'supabase/config.toml'), CONFIG);
  const write = (name: string, sql: string) => writeFile(join(directory, name), sql);
  const extract = async (options: Readonly<Record<string, unknown>> = {}) => {
    await writeFile(join(repo, CONFIG_FILENAME), serializeConfig({
      ...defaultConfig('boxed-replay'),
      extractors: [{ name: 'extract-data', enabled: true, options }],
    }));
    const io = bufferIo({ cwd: repo, env: { PATH: process.env['PATH'] ?? '', SEAMLINE_DETERMINISTIC: '1' } });
    const deps = buildCliDeps(io);
    assert.equal(deps.extractors?.find((port) => port.name === 'extract-data')?.confinement, 'process-sandbox');
    const exit = await runCli(deps, ['extract', '--repo', repo, '--out', out, '--json']);
    return { exit, report: JSON.parse(io.stdout()) as ExtractReport, stderr: io.stderr() };
  };
  const inspect = async () => {
    const store = new SqliteStore({ path: join(out, 'graph.db') });
    try {
      const answer = runDetectors(store).detectors.find((detector) => detector.code === 'X8_ORPHANED_MIGRATION');
      assert.ok(answer);
      return {
        answer, status: store.scopeStatus('data'),
        reference: store.node(nodeId('boxed-replay', 'Migration', '001_ref')),
        creation: store.node(nodeId('boxed-replay', 'Migration', '002_create')),
        source: store.node(nodeId('boxed-replay', 'DataSource', 'default')),
      };
    } finally { await store.close(); }
  };

  await write('001_ref.sql', EARLY);
  await write('002_create.sql', CREATE);
  const positive = await extract();
  assert.equal(positive.exit, 0, positive.stderr);
  assert.equal(positive.report.results[0]?.status, 'PASS');
  const before = await inspect();
  assert.equal(before.status, 'PASS');
  assert.equal(before.answer.outcome, 'fired');
  assert.equal(before.answer.findings.length, 1);
  assert.equal(before.answer.findings[0]?.left, nodeId('boxed-replay', 'Migration', '001_ref'));
  assert.equal(before.answer.findings[0]?.right, nodeId('boxed-replay', 'Migration', '002_create'));
  assert.equal(before.reference?.props['unresolvedRefCount'], 1);
  assert.ok(before.source);
  assert.equal(before.reference?.props['replaySnapshotHash'], before.source.props['replaySnapshotHash']);

  await write('001_ref.sql', CREATE);
  await write('002_create.sql', EARLY);
  assert.equal((await extract()).exit, 0);
  const fixed = await inspect();
  assert.equal(fixed.status, 'PASS');
  assert.equal(fixed.answer.outcome, 'clean');
  assert.equal(fixed.creation?.props['validRefCount'], 1);
  assert.equal(fixed.creation?.props['unknownRefCount'], 0);
  assert.deepEqual(JSON.parse(String(fixed.creation?.props['validRefs'])), [['public', 'accounts', null, 0, 1]]);

  await write('001_ref.sql', EARLY);
  await write('002_create.sql', CREATE);
  assert.equal((await extract()).exit, 0);
  assert.equal((await inspect()).answer.outcome, 'fired');
  await rm(join(directory, '002_create.sql'));
  await write('001_ref.sql', 'DO $$ BEGIN EXECUTE unknown_source; END $$;');
  const unavailable = await extract();
  // `extract` reserves nonzero for FAIL; UNAVAILABLE is carried by the
  // explicit scope status and degradedScopes in either rendering mode.
  assert.equal(unavailable.exit, 0);
  assert.equal(unavailable.report.results[0]?.status, 'UNAVAILABLE');
  assert.deepEqual(unavailable.report.degradedScopes, ['data']);
  const withheld = await inspect();
  assert.equal(withheld.status, 'UNAVAILABLE');
  assert.equal(withheld.answer.outcome, 'unknown');
  assert.equal(withheld.answer.findings.length, 0);
  assert.ok(withheld.creation, 'an unavailable sandbox result cannot sweep its previous creation witness');
  assert.equal(withheld.creation.deletedAt, null);
  assert.ok(withheld.source);

  await write('001_ref.sql', EARLY);
  await write('002_create.sql', CREATE);
  assert.equal((await extract()).exit, 0);
  assert.equal((await inspect()).answer.outcome, 'fired');
  const limited = await extract({ maxFileBytes: 16 });
  assert.equal(limited.exit, 0);
  assert.equal(limited.report.results[0]?.status, 'UNAVAILABLE');
  assert.deepEqual(limited.report.degradedScopes, ['data']);
  const protectedFacts = await inspect();
  assert.equal(protectedFacts.status, 'UNAVAILABLE');
  assert.equal(protectedFacts.answer.outcome, 'unknown');
  assert.equal(protectedFacts.answer.findings.length, 0);
  assert.ok(protectedFacts.reference);
  assert.ok(protectedFacts.creation);
  assert.ok(protectedFacts.source);
  assert.equal(protectedFacts.creation.deletedAt, null);
  assert.equal(protectedFacts.source.deletedAt, null);

  assert.equal((await extract()).exit, 0);
  assert.equal((await inspect()).answer.outcome, 'fired');
});
