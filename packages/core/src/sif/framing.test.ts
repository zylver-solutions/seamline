import assert from 'node:assert/strict';
import test from 'node:test';
import { SIF_VERSION, type SifLine } from '@seamline/ontology';
import { secretCanary } from '@seamline/security/corpus';
import { encodeCanonicalSelector } from '../store/canonical-selector.ts';
import { makeEdge, makeNode, makeResult, makeRun } from './test-fixtures.ts';
import { SIF_FRAME } from './framing.ts';
import { parseSifLine, readSif, readSifLines, readSifStream } from './reader.ts';
import { streamSif, writeSif, writeSifTo } from './writer.ts';

const auth = {
  scope: 'contracts', kinds: ['Contract'] as const,
  selector: encodeCanonicalSelector({ path: 'src/a.ts', rules: [['exact', 'A']] }),
};
const status: SifLine = { t: 'status', result: makeResult({ authoritative: [auth] }) };

test('failed or unavailable metadata cannot export or import reversible credentials through canonical envelopes', () => {
  const canary = secretCanary('aws-access-key-id/documented-example').secret;
  for (const input of [{ path: `src/${canary}.ts`, rules: [['exact', 'A']] },
    { path: 'src/a.ts', rules: [['exact', canary]] }]) {
    const selector = '/@canonical/v1/' + Buffer.from(JSON.stringify(input)).toString('hex');
    for (const state of ['PASS', 'FAIL', 'UNAVAILABLE'] as const) {
      const result = makeResult({ status: state, authoritative: [{ ...auth, selector }] });
      const records: SifLine[] = [{ t: 'run', run: makeRun({ results: [result] }) }, { t: 'status', result }];
      assert.throws(() => writeSif(records), /credential-shaped/);
      const text = SIF_FRAME + '\n' + records.map(record => JSON.stringify(record)).join('\n') + '\n';
      const exposed: SifLine[] = [];
      assert.throws(() => { for (const record of readSifLines(text)) exposed.push(record); }, /credential-shaped/);
      assert.deepEqual(exposed, []);
    }
  }
});

test('typed HTTP paths and immutable Git source dates round-trip with strict identity context', () => {
  const sha = 'a'.repeat(40);
  const date = '2020-02-03T04:05:06Z';
  const route = makeNode('RouteHandler', 'GET /users/:id', { path: 'src/routes.ts', props: { method: 'GET', routePath: '/users/:id' } });
  const operation = makeNode('Operation', 'POST /users', { path: 'api.yaml', props: { method: 'POST', path: '/users' } });
  const commit = makeNode('Commit', sha, { sourceRef: sha, props: { sha, authorDate: date, committerDate: date } });
  const rename = makeEdge('RENAMED_FROM', makeNode('File', 'new.ts'), makeNode('File', 'old.ts'), {
    sourceRef: sha, srcFile: 'new.ts', dstFile: 'old.ts', props: { commit: sha, authorDate: date, fromPath: 'old.ts', toPath: 'new.ts' },
  });
  const records: SifLine[] = [route, operation, commit].map(node => ({ t: 'node', node }));
  records.push({ t: 'edge', edge: rename });
  const text = writeSif(records);
  assert.equal(writeSif(readSif(text)), text);
  assert.deepEqual(readSif(text).find(record => record.t === 'node' && record.node.kind === 'Commit'), { t: 'node', node: commit });
  const rejectNode = (node: typeof route): void => {
    assert.throws(() => writeSif([{ t: 'node', node }]));
    assert.throws(() => readSif(SIF_FRAME + '\n' + JSON.stringify({ t: 'node', node }) + '\n'));
  };
  for (const props of [{ method: 'get', routePath: '/users/:id' }, { method: 'POST', routePath: '/users/:id' },
    { method: 'GET', routePath: 'users/:id' }, { method: 'GET', routePath: '/users/\\id' },
    { method: 'GET', routePath: '/users/\n' }, { method: 'GET', routePath: '/users/\ud800' },
    { method: 'GET', routePath: 1 }]) rejectNode({ ...route, props });
  for (const routePath of ['users/:id', '/users/\\id', '/users/\n', '/users/\ud800'])
    rejectNode(makeNode('RouteHandler', `GET ${routePath}`, { props: { method: 'GET', routePath } }));
  rejectNode({ ...route, kind: 'Symbol' });
  rejectNode({ ...route, path: '/private/routes.ts' });
  rejectNode({ ...operation, props: { method: 'GET', path: '/users' } });
  for (const value of ['2020-02-03', '2020-02-03T04:05:06.000Z', '2020-02-03T05:05:06+01:00', '2020-02-30T04:05:06Z', 'invalid', 1])
    rejectNode({ ...commit, props: { sha, authorDate: value } });
  rejectNode({ ...commit, sourceRef: 'b'.repeat(40) });
  rejectNode({ ...commit, props: { sha: 'b'.repeat(40), authorDate: date } });
  rejectNode({ ...commit, kind: 'Changeset' });
  for (const key of ['createdAt', 'seenAt', 'generatedAt']) rejectNode({ ...commit, props: { ...commit.props, [key]: date } });
  for (const edge of [
    { ...rename, sourceRef: 'b'.repeat(40) }, { ...rename, dst: makeNode('File', 'old.ts', { id: 'foreign:File:old.ts' }).id },
    { ...rename, props: { ...rename.props, commit: 'not-a-hash' } },
    { ...rename, props: { ...rename.props, fromPath: '/private/old.ts' } },
    { ...rename, props: { ...rename.props, generatedAt: date } },
  ]) {
    assert.throws(() => writeSif([{ t: 'edge', edge }]));
    assert.throws(() => readSif(SIF_FRAME + '\n' + JSON.stringify({ t: 'edge', edge }) + '\n'));
  }
});

test('framed canonical authority round-trips without changing the JSON record union', async () => {
  assert.equal(SIF_VERSION, '2.0.0');
  assert.equal(SIF_FRAME, 'seamline-sif/2.0.0');
  const records: SifLine[] = [
    { t: 'run', run: makeRun({ results: [status.result] }) }, status,
    { t: 'node', node: makeNode('Contract', 'A', { path: 'src/a.ts', name: 'unrelated display' }) },
  ];
  const text = writeSif(records);
  assert.ok(text.startsWith('seamline-sif/2.0.0\n{'));
  assert.equal(writeSif(readSif(text)), text);
  for (const size of [1, 2, 7, 32]) {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      const bytes = Buffer.from(text);
      for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
    }
    assert.deepEqual(await readSifStream(chunks()), readSif(text));
  }
  assert.throws(() => parseSifLine(JSON.stringify(status), 1), /requires version-2 SIF framing/);
  assert.deepEqual(parseSifLine(JSON.stringify(status), 2, true, { framedVersion: '2.0.0' }), status);
});

test('headerless streams accept old path claims and refuse canonical claims even on failed results', () => {
  const legacy: SifLine = { t: 'status', result: makeResult({ authoritative: [{ scope: 'contracts', kinds: ['Contract'], selector: 'src/**' }] }) };
  assert.deepEqual(readSif(JSON.stringify(legacy) + '\n'), [legacy]);
  for (const state of ['PASS', 'FAIL', 'UNAVAILABLE'] as const) {
    const unframed = JSON.stringify({ ...status, result: { ...status.result, status: state } }) + '\n';
    assert.throws(() => readSif(unframed), /requires version-2 SIF framing/);
  }
});

test('unknown, duplicate, late, CRLF and unterminated framing fail before exposing records', async () => {
  const valid = JSON.stringify(status) + '\n';
  for (const text of [
    'seamline-sif/1.0.0\n' + valid, 'seamline-sif/3.0.0\n' + valid,
    SIF_FRAME, SIF_FRAME + '\r\n' + valid, '\n' + SIF_FRAME + '\n' + valid,
    SIF_FRAME + '\n' + valid + SIF_FRAME + '\n',
    JSON.stringify({ t: 'node', node: makeNode('File', 'a.ts') }) + '\n' + SIF_FRAME + '\n',
  ]) {
    const exposed: SifLine[] = [];
    assert.throws(() => { for (const record of readSifLines(text)) exposed.push(record); });
    assert.deepEqual(exposed, [], 'no import record can be applied before complete framing validation');
    async function* chunks(): AsyncGenerator<string> { yield text.slice(0, 5); yield text.slice(5); }
    await assert.rejects(readSifStream(chunks()));
  }
});

test('aggregate metadata budget is checked before decoding any oversized malformed selector', async () => {
  const large = encodeCanonicalSelector({ path: 'a.ts', rules: [['exact', 'x'.repeat(20_000)]] });
  const malformed = '/@canonical/v1/' + 'f'.repeat(40_000);
  const records: SifLine[] = [large, malformed].map(selector => ({
    t: 'status', result: makeResult({ authoritative: [{ ...auth, selector }] }),
  }));
  const text = SIF_FRAME + '\n' + records.map(record => JSON.stringify(record)).join('\n') + '\n';
  assert.throws(() => readSif(text), /aggregate canonical byte budget/);
  assert.throws(() => readSif(SIF_FRAME + '\n' + [...records].reverse().map(record => JSON.stringify(record)).join('\n') + '\n'), /aggregate canonical byte budget/,
    'malformed-first order kills decoding before complete encoded-byte preflight');
  const exposed: SifLine[] = [];
  assert.throws(() => { for (const record of readSifLines(text)) exposed.push(record); }, /aggregate canonical byte budget/);
  assert.deepEqual(exposed, []);
  const sink: string[] = [];
  await assert.rejects(writeSifTo({ write: chunk => sink.push(chunk) }, records), /aggregate canonical byte budget/);
  assert.deepEqual(sink, [], 'even framing cannot escape from a rejected write');
  const chunks: string[] = [];
  await assert.rejects(async () => { for await (const chunk of streamSif(records)) chunks.push(chunk); }, /aggregate canonical byte budget/);
  assert.deepEqual(chunks, []);
  const malformedRun: SifLine = { t: 'run', run: makeRun({ results: [makeResult({ authoritative: [{ ...auth, selector: '/@canonical/v1/f' }] })] }) };
  assert.throws(() => readSif(SIF_FRAME + '\n' + [malformedRun, ...records].map(record => JSON.stringify(record)).join('\n') + '\n'), /aggregate canonical byte budget/,
    'preflight every metadata representation before decoding the first run selector');
});

test('version-2 run and status metadata cannot disagree or replace an unavailable result with PASS', () => {
  const run: SifLine = { t: 'run', run: makeRun({ results: [status.result] }) };
  const text = (records: readonly SifLine[]): string => SIF_FRAME + '\n' + records.map(record => JSON.stringify(record)).join('\n') + '\n';
  assert.deepEqual(readSif(text([run, status])), [run, status]);
  for (const state of ['FAIL', 'UNAVAILABLE'] as const) {
    const conflicting: SifLine = { t: 'status', result: { ...status.result, status: state } };
    assert.throws(() => readSif(text([run, conflicting])), /metadata disagree/);
    const legacyResult = { ...status.result, authoritative: [{ scope: 'contracts', kinds: ['Contract'] as const, selector: 'src/**' }] };
    const legacyRecords: SifLine[] = [{ t: 'run', run: makeRun({ results: [legacyResult] }) },
      { t: 'status', result: { ...legacyResult, status: state } }];
    assert.throws(() => readSif(legacyRecords.map(record => JSON.stringify(record)).join('\n') + '\n'), /metadata disagree/,
      'headerless metadata cannot silently discard a conflicting non-PASS result during upgrade');
    assert.throws(() => writeSif([run, conflicting]), /metadata disagree/);
  }
  assert.throws(() => readSif(text([run, run])), /multiple run records/);
  assert.throws(() => readSif(text([status, status])), /duplicate SIF extractor/);
  assert.throws(() => readSif(text([run, { t: 'status', result: { ...status.result, extractor: 'other' } }])), /metadata disagree/);
});

test('an identical run/status representation preserves the full per-run rule budget', () => {
  const selector = encodeCanonicalSelector({ path: 'a.ts', rules: Array.from({ length: 2_048 }, (_, index) => ['exact', index.toString(36)] as const) });
  const result = makeResult({ authoritative: [{ ...auth, selector }] });
  const records: SifLine[] = [{ t: 'run', run: makeRun({ results: [result] }) }, { t: 'status', result }];
  assert.deepEqual(readSif(writeSif(records)), records);
});
