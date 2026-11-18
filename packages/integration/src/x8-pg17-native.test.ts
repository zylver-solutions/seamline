/** Actual extraction -> normal SQLite graph -> production X8, all controls independently authored. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { SqliteStore } from '@seamline/core';
import { extractData, DATA_SCOPE } from '@seamline/extract-data';
import { runDetectors } from '@seamline/contradictions';
import { nodeId } from '@seamline/ontology';

// Each resource is registered immediately; close is consumed once and every removal is independent.
test('PG17 proof-v2 reaches SQLite positive, examined fix, same-run unknown and restored positive', async t => {
  let root: string | undefined, data: string | undefined, owner: SqliteStore | undefined;
  // Register one independent cleanup owner before the first allocation.
  t.after(async () => {
    const errors: unknown[] = [];
    const closing = owner; owner = undefined;
    if (closing !== undefined) try { await closing.close(); } catch (error) { errors.push(error); }
    const first = root; root = undefined;
    if (first !== undefined) try { await rm(first, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    const second = data; data = undefined;
    if (second !== undefined) try { await rm(second, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'independent native fixture cleanup failed');
  });
  root = await mkdtemp(join(tmpdir(), 'seamline-stock-native-'));
  data = await mkdtemp(join(tmpdir(), 'seamline-stock-native-store-'));
  const store = new SqliteStore({ path: join(data, 'graph.db'), ontologyVersion: '1.0.0' }); owner = store;
  const fixtureRoot = root;
  const dir = join(fixtureRoot, 'supabase/migrations'); await mkdir(dir, { recursive: true });
  const cfg = (major: number) => `project_id="fixture"\n[db]\nmajor_version=${major}\n[db.migrations]\nenabled=true\nschema_paths=[]\n`;
  await writeFile(join(fixtureRoot, 'supabase/config.toml'), cfg(17));
  const native = 'CREATE EXTENSION citext WITH SCHEMA extensions; ALTER EXTENSION citext SET SCHEMA moved;';
  await writeFile(join(dir, '001_native.sql'), native);
  await writeFile(join(dir, '002_child.sql'), 'CREATE TABLE public.child(id integer REFERENCES public.parent(id));');
  await writeFile(join(dir, '003_parent.sql'), 'CREATE TABLE public.parent(id integer);');
  const extract = async (runId: string, retry = false) => {
    const out = await extractData({ root: fixtureRoot, repo: 'native-life', runId, deterministic: true });
    const run = { runId, repo: 'native-life', commit: null, startedAt: '2026-01-01T00:00:00.000Z', ontologyVersion: '1.0.0' };
    if (retry) await store.restartRun(run); else await store.beginRun(run);
    await store.upsertNodes(runId, out.nodes); await store.upsertEdges(runId, DATA_SCOPE, out.edges); await store.finalizeRun(runId, [out.result]); return out;
  };
  const answer = () => { const found = runDetectors(store).detectors.find(x => x.code === 'X8_ORPHANED_MIGRATION'); assert.ok(found); return found; };
  assert.equal((await extract('early')).result.status, 'PASS'); assert.equal(answer().outcome, 'fired');
  assert.equal(answer().findings.length, 1); assert.match(answer().findings[0]?.claim ?? '', /stock|Source-local|native model/);
  await writeFile(join(dir, '002_child.sql'), 'CREATE TABLE public.parent(id integer);');
  await writeFile(join(dir, '003_parent.sql'), 'CREATE TABLE public.child(id integer REFERENCES public.parent(id));');
  assert.equal((await extract('fixed')).result.status, 'PASS'); assert.equal(answer().outcome, 'clean');
  const fixed = store.node(nodeId('native-life', 'Migration', '003_parent')); assert.ok(fixed);
  assert.equal(fixed.props['validRefCount'], 3); assert.equal(fixed.props['unknownRefCount'], 0);
  assert.equal(fixed.sensitivity, 'confidential');
  await writeFile(join(fixtureRoot, 'supabase/config.toml'), cfg(18));
  assert.equal((await extract('fixed', true)).result.status, 'UNAVAILABLE'); assert.equal(answer().outcome, 'unknown');
  await writeFile(join(fixtureRoot, 'supabase/config.toml'), cfg(17));
  await writeFile(join(dir, '002_child.sql'), 'CREATE TABLE public.child(id integer REFERENCES public.parent(id));');
  await writeFile(join(dir, '003_parent.sql'), 'CREATE TABLE public.parent(id integer);');
  assert.equal((await extract('restored')).result.status, 'PASS'); assert.equal(answer().outcome, 'fired');
});
