/**
 * Real data/code column facts, with an explicitly authored verification control.
 * No extractor produces TestCase/TESTS today. This hybrid regression does not
 * claim verification extraction, unmodified corpus firing, or M2 qualification.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SqliteStore } from '@seamline/core';
import { runDetectors, x10UntestedPiiWrite } from '@seamline/contradictions';
import { CODE_TS_SCOPE, extractCodeTs } from '@seamline/extract-code-ts';
import { CONTRACTS_SCOPE, extractContracts } from '@seamline/extract-contracts';
import { DATA_SCOPE, buildDataModelIndex, extractData } from '@seamline/extract-data';
import { INFER_JOIN_SCOPE, inferJoins, toExtractorResult } from '@seamline/infer-join';
import { nodeId } from '@seamline/ontology';

async function measure(statement: string, verification: 'unrelated' | 'writer' | 'none' = 'unrelated', schema = 'CREATE TABLE contacts (id integer PRIMARY KEY, display_name text, email text);\n') {
  const root = await mkdtemp(join(tmpdir(), 'seamline-x10-columns-'));
  const store = new SqliteStore({ path: join(root, 'graph.db'), ontologyVersion: '1.0.0' });
  const repo = 'x10columns';
  const runId = 'extract';
  try {
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true }, include: ['*.ts'] }));
    await writeFile(join(root, 'schema.sql'), schema);
    await writeFile(join(root, 'repository.ts'), `declare const db: { query(text: string): void };\nexport function writeContact(): void { ${statement} }\nexport function readControl(): void {}\n`);
    await writeFile(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Contacts', version: '1' }, paths: { '/contacts': { get: { responses: { '200': { description: 'Contact', content: { 'application/json': { schema: { type: 'object', properties: { display_name: { type: 'string' } } } } } } } } } } }));
    const data = await extractData({ root, repo, runId, deterministic: true });
    const code = extractCodeTs({ repoRoot: root, repo, runId, deterministic: true, dataModelIndex: buildDataModelIndex(data.nodes) });
    const contracts = extractContracts({ repoRoot: root, repo, runId });
    for (const result of [data.result, code.result, contracts.result]) assert.equal(result.status, 'PASS', result.diagnostics.join('\n'));
    const begin = (id: string) => store.beginRun({ runId: id, repo, commit: null, startedAt: '2026-01-01T00:00:00.000Z', ontologyVersion: '1.0.0' });
    await begin(runId);
    await store.upsertNodes(runId, [...data.nodes, ...code.nodes, ...contracts.nodes]);
    for (const [scope, edges] of [[DATA_SCOPE, data.edges], [CODE_TS_SCOPE, code.edges], [CONTRACTS_SCOPE, contracts.edges]] as const) await store.upsertEdges(runId, scope, edges);
    // The verification half is authored input, not an extraction result or a
    // manufactured PASS status. Every required scope comes from the real run.
    if (verification !== 'none') {
      const target = code.nodes.find(node => node.kind === 'Symbol' && node.name === (verification === 'writer' ? 'writeContact' : 'readControl'));
      assert.ok(target);
      const id = nodeId(repo, 'TestCase', 'declared-control');
      await store.upsertNodes(runId, [{ id, kind: 'TestCase', name: 'declared control', provenance: 'DECLARED', confidence: 1, sensitivity: 'internal', props: {}, firstSeenRun: runId, lastSeenRun: runId, deletedAt: null }]);
      await store.upsertEdges(runId, 'fixture-verification', [{ kind: 'TESTS', src: id, dst: target.id, provenance: 'DECLARED', confidence: 1, props: {}, firstSeenRun: runId, lastSeenRun: runId, deletedAt: null }]);
    }
    await store.finalizeRun(runId, [data.result, code.result, contracts.result]);
    const inferred = inferJoins(store, { runId: 'join' });
    assert.equal(inferred.status, 'PASS');
    await begin('join');
    await store.upsertEdges('join', INFER_JOIN_SCOPE, inferred.edges);
    await store.finalizeRun('join', [toExtractorResult(inferred, 0)]);
    const result = runDetectors(store, [x10UntestedPiiWrite]).detectors[0];
    assert.ok(result);
    const queries = code.edges.filter(edge => edge.kind === 'QUERIES');
    assert.equal(queries.length, 1, 'the real extractor must emit the write edge');
    assert.equal(queries[0]?.props['columns'], undefined, 'the producer does not emit the legacy field');
    assert.equal(code.nodes.some(node => node.kind === 'TestCase' || node.kind === 'CoverageRecord'), false);
    assert.equal(code.edges.some(edge => edge.kind === 'TESTS' || edge.kind === 'COVERS'), false);
    return { result, props: queries[0]!.props };
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('X10 real INSERT of display_name does not claim the sibling email was written', async () => {
  const { result, props } = await measure('db.query("INSERT INTO contacts (display_name) VALUES (\'sample\')");');
  assert.equal(props['insertColumns'], 'display_name');
  assert.equal(props['insertComplete'], true);
  assert.equal(result.outcome, 'clean');
  assert.deepEqual(result.findings, []);
});

test('X10 real UPDATE of display_name does not claim the sibling email was written', async () => {
  const { result, props } = await measure('db.query("UPDATE contacts SET display_name = \'sample\'");');
  assert.equal(props['updateColumns'], 'display_name');
  assert.equal(props['updateComplete'], true);
  assert.equal(result.outcome, 'clean');
  assert.deepEqual(result.findings, []);
});

test('X10 retains a real explicit email write and suppresses it when that writer is verified', async () => {
  const statement = 'db.query("INSERT INTO contacts (email) VALUES (\'sample\')");';
  const positive = await measure(statement);
  assert.equal(positive.props['insertColumns'], 'email');
  assert.equal(positive.result.outcome, 'fired');
  assert.equal(positive.result.findings.length, 1);
  assert.equal(positive.result.findings[0]?.right, 'x10columns:Column:public.contacts.email');
  assert.equal((await measure(statement, 'writer')).result.outcome, 'clean');
});

test('X10 real incomplete write columns remain UNKNOWN when verification facts exist', async () => {
  const { result, props } = await measure('db.query("INSERT INTO contacts VALUES (1, \'sample\', \'sample\')");');
  assert.equal(props['insertComplete'], false);
  assert.equal(result.outcome, 'unknown');
  assert.deepEqual(result.findings, []);
  assert.equal(result.result.known, false);
  if (!result.result.known) assert.match(result.result.reason, /^WRITE_COLUMNS_UNOBSERVED:/u);
});

test('X10 preserves its documented clean result and note without authored verification facts', async () => {
  const { result } = await measure('db.query("INSERT INTO contacts (email) VALUES (\'sample\')");', 'none');
  assert.equal(result.outcome, 'clean');
  assert.deepEqual(result.findings, []);
  assert.match(result.notes[0] ?? '', /no TestCase or CoverageRecord facts/u);
});

test('X10 real quoted Email write does not also report the distinct email column', async () => {
  const statement = `db.query(${JSON.stringify('INSERT INTO contacts ("Email") VALUES (?)')});`;
  const { result, props } = await measure(statement, 'unrelated', 'CREATE TABLE contacts (id integer PRIMARY KEY, "Email" text, email text);\n');
  assert.equal(props['insertColumns'], 'Email');
  assert.equal(result.outcome, 'fired');
  assert.deepEqual(result.findings.map(finding => finding.right), ['x10columns:Column:public.contacts.Email']);
});
