import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { nodeId, type ExtractorResult, type NodeId, type SeamlineEdge } from '@seamline/ontology';
import { compareCodeUnits, encodeCanonicalSelector, readSif, SIF_FRAME, writeSif } from '@seamline/core';
import { redactionRef } from '@seamline/security';
import { secretCanary } from '@seamline/security/corpus';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from './config.ts';
import { bufferIo, EXIT_RUNTIME, EXIT_USAGE } from './io.ts';
import { alignPort } from './align-port.ts';
import type { Snapshot } from './ports.ts';
import { fileSnapshots, parseSif, serializeSif } from './sif.ts';
import { runCli } from './run.ts';
import { makeEdge, makeNode, makeResult, makeRun } from './testing.ts';

// ---------------------------------------------------------------------------
// The SIF serializer's order is a code-unit order, never a locale order
// (invariant 4: extraction is byte-reproducible). The determinism and dogfood
// gates compare these bytes, so a locale-dependent order here would make them
// disagree between machines.
//
// 'B' (0x42) < '_' (0x5F) < 'a' (0x61) < 'z' (0x7A) < U+00E4 (0xE4, a with diaeresis) by code unit.
// An en-US collation puts U+00E4 right after 'a' (`_ a U+00E4 B z`); a Swedish one puts it
// last (`_ a B z U+00E4`).
// ---------------------------------------------------------------------------

const NAMES_IN_CODE_UNIT_ORDER = ['B', '_x', 'a', 'z', '\u00e4'] as const;
const SHUFFLED = ['a', '\u00e4', 'B', 'z', '_x'] as const;

test('plain and JSON CLI errors redact rejected SIF values and source filenames', async () => {
  const canary = secretCanary('aws-access-key-id/documented-example').secret;
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-sif-errors-'));
  try {
    await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')));
    for (const field of ['kind', 'id', 'missing'] as const) {
      const file = path.join(dir, `${field}-${canary}.sif`);
      const invalid = { ...makeNode({ kind: 'File', canonicalName: 'a.ts' }), [field]: canary };
      if (field !== 'missing') await writeFile(file, SIF_FRAME + '\n' + JSON.stringify({ t: 'node', node: invalid }) + '\n');
      for (const json of [false, true]) {
        for (const command of ['diff', 'align'] as const) {
          const io = bufferIo({ cwd: dir, env: {}, isTty: false });
          const code = await runCli({ io, snapshots: fileSnapshots(), align: alignPort(), clock: { now: () => 'now', runId: () => 'run' } },
            [...(command === 'diff' ? ['diff', file, file] : ['align', '--facts', file]), ...(json ? ['--json'] : [])]);
          const expectedCode = command === 'diff' ? EXIT_USAGE : EXIT_RUNTIME;
          assert.equal(code, expectedCode);
          assert.equal(io.stdout(), '');
          assert.equal(io.stderr().includes(canary), false, 'untrusted input must not be reflected');
          assert.ok(io.stderr().includes(redactionRef(canary)), 'a deterministic redaction reference replaces the source label');
          if (json) assert.equal((JSON.parse(io.stderr()) as { exitCode: number }).exitCode, expectedCode);
        }
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('SIF diagnostic details retain entropy redaction when the filename is ordinary', async () => {
  const canary = secretCanary('high-entropy-string/random-url-safe').secret;
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-sif-entropy-'));
  try {
    await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')));
    const file = path.join(dir, 'invalid.sif');
    await writeFile(file, SIF_FRAME + '\n' + JSON.stringify({ t: 'node', node: { ...makeNode({ kind: 'File', canonicalName: 'a.ts' }), kind: canary } }) + '\n');
    for (const command of ['diff', 'align'] as const) for (const json of [false, true]) {
      const io = bufferIo({ cwd: dir, env: {}, isTty: false });
      const code = await runCli({ io, snapshots: fileSnapshots(), align: alignPort(), clock: { now: () => 'now', runId: () => 'run' } },
        [...(command === 'diff' ? ['diff', file, file] : ['align', '--facts', file]), ...(json ? ['--json'] : [])]);
      assert.equal(code, command === 'diff' ? EXIT_USAGE : EXIT_RUNTIME);
      assert.equal(io.stdout(), '');
      assert.equal(io.stderr().includes(canary), false, 'free-text diagnostic details retain entropy scanning');
      assert.ok(io.stderr().includes(redactionRef(canary)));
      assert.match(io.stderr(), /invalid\.sif/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI framing preserves canonical claims and rejects unsupported authority before returning a snapshot', () => {
  const result = { ...makeResult('contracts', 'PASS', ['contracts']), authoritative: [{
    scope: 'contracts', kinds: ['Contract'] as const,
    selector: encodeCanonicalSelector({ path: 'src/a.ts', rules: [['exact', 'A']] }),
  }] };
  const actualRun = makeRun('r1', [result]);
  const snapshot: Snapshot = { runId: 'r1', run: actualRun, nodes: [], edges: [], results: [result] };
  const text = serializeSif(snapshot);
  assert.ok(text.startsWith(SIF_FRAME + '\n'));
  assert.deepEqual(parseSif(text, 'canonical'), snapshot);
  assert.deepEqual(readSif(text).find(record => record.t === 'run')?.run, snapshot.run,
    'the strict core reader consumes the actual CLI run record');
  assert.deepEqual(parseSif(writeSif([{ t: 'run', run: actualRun }, { t: 'status', result }]), 'core'), snapshot,
    'the CLI consumes the same core record union and preserves full run metadata');
  assert.deepEqual(parseSif(writeSif([{ t: 'run', run: actualRun }]), 'run-only').results, actualRun.results,
    'run-only documents do not lose their authority when status lines are omitted');
  assert.throws(() => serializeSif({ ...snapshot, runId: 'different' }), /run id disagrees/);
  assert.throws(() => serializeSif({ ...snapshot, results: [] }), /results disagree/);
  assert.throws(() => parseSif(text.slice(SIF_FRAME.length + 1), 'unframed'), /framing/);
  assert.throws(() => parseSif(text + SIF_FRAME + '\n', 'duplicate'), /duplicate or late/);
  assert.throws(() => parseSif(text.replace(SIF_FRAME, 'seamline-sif/9.0.0'), 'future'), /unsupported/);
  const pathResult = { ...result, authoritative: [{ scope: 'contracts', kinds: ['Contract'] as const, selector: 'src/**' }] };
  assert.deepEqual(parseSif(JSON.stringify({ t: 'status', result: pathResult }) + '\n', 'legacy').results, [pathResult]);
  const legacy = parseSif(JSON.stringify({ t: 'sif', version: '1.0.0', runId: 'legacy' }) + '\n' + JSON.stringify({ t: 'status', result: pathResult }) + '\n', 'legacy');
  assert.equal(legacy.runId, 'legacy');
  assert.equal(legacy.run, undefined);
  assert.throws(() => serializeSif(legacy), /requires actual run metadata/);
  assert.throws(() => parseSif(SIF_FRAME + '\n' + JSON.stringify({ t: 'sif', version: '2.0.0', runId: 'r1' }) + '\n', 'invalid-v2'), /legacy SIF metadata/);
});

test('CLI checks aggregate encoded claim bytes before malformed bodies can be decoded', () => {
  const selectors = [encodeCanonicalSelector({ path: 'a.ts', rules: [['exact', 'x'.repeat(20_000)]] }), '/@canonical/v1/' + 'f'.repeat(40_000)];
  const results = selectors.map((selector, index) => ({ ...makeResult(`contracts-${index}`, 'PASS', ['contracts']), authoritative: [{ scope: 'contracts', kinds: ['Contract'] as const, selector }] }));
  const text = SIF_FRAME + '\n' + results.map(result => JSON.stringify({ t: 'status', result })).join('\n') + '\n';
  assert.throws(() => parseSif(text, 'oversized'), /aggregate canonical byte budget/);
  assert.throws(() => parseSif(SIF_FRAME + '\n' + [...results].reverse().map(result => JSON.stringify({ t: 'status', result })).join('\n') + '\n', 'malformed-first'), /aggregate canonical byte budget/);
  assert.throws(() => serializeSif({ runId: 'r1', run: makeRun('r1', results), nodes: [], edges: [], results }), /aggregate canonical byte budget/);
});

test('the complete run remains primary when only some agreeing statuses are present', () => {
  const good = { ...makeResult('good', 'PASS', ['code.ts']), authoritative: [{ scope: 'code.ts', kinds: ['File'] as const, selector: 'src/**' }] };
  const blind = { ...makeResult('blind', 'UNAVAILABLE', ['code.ts']), authoritative: good.authoritative };
  const run = makeRun('run-partial-status', [good, blind]);
  const text = writeSif([{ t: 'run', run }, { t: 'status', result: good }]);
  const parsed = parseSif(text, 'partial-status');
  assert.deepEqual(parsed.results, [good, blind]);
  assert.deepEqual(parseSif(serializeSif(parsed), 'rewritten').results, [good, blind]);
  const conflicting = [{ t: 'run', run: makeRun('run-conflict', [good]) }, { t: 'status', result: { ...good, status: 'FAIL' } }];
  assert.throws(() => parseSif(conflicting.map(record => JSON.stringify(record)).join('\n') + '\n', 'legacy-conflict'), /metadata disagree/);
  const unfinished = parseSif(writeSif([{ t: 'run', run: { ...run, finishedAt: null } }]), 'unfinished');
  assert.throws(() => serializeSif(unfinished), /requires completed run metadata/);
});

function nodeIdOf(name: string): NodeId {
  return nodeId('demo', 'Symbol', name);
}

function snapshotOf(names: readonly string[]): Snapshot {
  const nodes = names.map((canonicalName) => makeNode({ kind: 'Symbol', canonicalName }));
  const edges: SeamlineEdge[] = [];
  // Same kind, same dst: only `src` decides the order.
  for (const name of names) {
    edges.push(makeEdge({ kind: 'CALLS', src: nodeIdOf(name), dst: nodeIdOf('dst') }));
  }
  // Same src, same kind: only `dst` decides the order.
  for (const name of names) {
    edges.push(makeEdge({ kind: 'CALLS', src: nodeIdOf('src'), dst: nodeIdOf(name) }));
  }
  const results: ExtractorResult[] = names.map((name) =>
    makeResult(`extract-${name}`, 'PASS', [`scope-${name}`]),
  );
  const persistedResults = [...results].sort((a, b) => compareCodeUnits(a.extractor, b.extractor));
  return { runId: 'run-1', run: makeRun('run-1', persistedResults), nodes, edges, results };
}

function linesOf(sif: string): string[] {
  assert.ok(sif.endsWith('\n'), 'SIF ends with a newline');
  return sif.slice(0, -1).split('\n');
}

test('serializeSif orders nodes by code unit on the id', () => {
  const lines = linesOf(serializeSif(snapshotOf(SHUFFLED)));
  const nodeLines = lines.filter((l) => l.startsWith('{"node":'));
  assert.deepEqual(
    nodeLines.map((l) => (JSON.parse(l) as { node: { id: string } }).node.id),
    NAMES_IN_CODE_UNIT_ORDER.map(nodeIdOf),
  );
});

test('serializeSif orders status lines by code unit on the extractor name', () => {
  const lines = linesOf(serializeSif(snapshotOf(SHUFFLED)));
  const statusLines = lines.filter((l) => l.startsWith('{"result":'));
  assert.deepEqual(
    statusLines.map((l) => (JSON.parse(l) as { result: { extractor: string } }).result.extractor),
    NAMES_IN_CODE_UNIT_ORDER.map((n) => `extract-${n}`),
  );
});

test('serializeSif orders edges by code unit on src, then dst, then kind', () => {
  const lines = linesOf(serializeSif(snapshotOf(SHUFFLED)));
  const edges = lines
    .filter((l) => l.startsWith('{"edge":'))
    .map((l) => (JSON.parse(l) as { edge: { src: string; dst: string; kind: string } }).edge);

  // Sources in code-unit order are B, _x, a, src, z, U+00E4. The CALLS edges
  // (src = each name, dst = `dst`) and the CALLS edges (src = `src`, dst =
  // each name) interleave by src first; the latter then share a src, so
  // their dst alone decides their order.
  const p = 'demo:Symbol:';
  assert.deepEqual(
    edges.map((e) => `${e.kind} ${e.src} -> ${e.dst}`),
    [
      `CALLS ${p}B -> ${p}dst`,
      `CALLS ${p}_x -> ${p}dst`,
      `CALLS ${p}a -> ${p}dst`,
      `CALLS ${p}src -> ${p}B`,
      `CALLS ${p}src -> ${p}_x`,
      `CALLS ${p}src -> ${p}a`,
      `CALLS ${p}src -> ${p}z`,
      `CALLS ${p}src -> ${p}\u00e4`,
      `CALLS ${p}z -> ${p}dst`,
      `CALLS ${p}\u00e4 -> ${p}dst`,
    ],
  );
});

test('serializeSif output does not depend on the order the snapshot was assembled in', () => {
  const forward = serializeSif(snapshotOf(NAMES_IN_CODE_UNIT_ORDER));
  const shuffled = serializeSif(snapshotOf(SHUFFLED));
  assert.equal(shuffled, forward);
});

test('the serialized order survives a parse and re-serialize', () => {
  const text = serializeSif(snapshotOf(SHUFFLED));
  assert.equal(serializeSif(parseSif(text, 'roundtrip')), text);
});

// ---------------------------------------------------------------------------
// Same bytes under two different process locales.
//
// The child process is the only way to vary the ICU default locale: it is fixed
// when the process starts. The probe first proves that the two locales really
// do collate differently on this runtime; if they do not (an ICU build without
// the Swedish tailoring), the byte comparison would be vacuous, so the test is
// skipped instead of passing for no reason.
// ---------------------------------------------------------------------------

const LOCALES = ['en_US.UTF-8', 'sv_SE.UTF-8'] as const;

function runUnderLocale(locale: string, script: string, input: string): string {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '--eval', script],
    { env: { LC_ALL: locale, LANG: locale }, input, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `child under ${locale} failed: ${result.stderr}`);
  return result.stdout;
}

const COLLATION_PROBE = `
const names = ['a', '\\u00e4', 'z'];
process.stdout.write(names.sort((x, y) => x.localeCompare(y)).join(','));
`;

const SERIALIZE = `
import { serializeSif } from ${JSON.stringify(pathToFileURL(new URL('./sif.ts', import.meta.url).pathname).href)};
let text = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;
process.stdout.write(serializeSif(JSON.parse(text)));
`;

test('serializeSif emits identical bytes under different process locales', (t) => {
  const [en, sv] = LOCALES;
  const enOrder = runUnderLocale(en, COLLATION_PROBE, '');
  const svOrder = runUnderLocale(sv, COLLATION_PROBE, '');
  if (enOrder === svOrder) {
    t.skip(
      `this runtime collates identically under ${en} and ${sv}; the comparison would prove nothing`,
    );
    return;
  }

  const input = JSON.stringify(snapshotOf(SHUFFLED));
  const underEn = runUnderLocale(en, SERIALIZE, input);
  const underSv = runUnderLocale(sv, SERIALIZE, input);
  assert.equal(underSv, underEn, 'the serializer output must not depend on the locale');
  assert.equal(underEn, serializeSif(snapshotOf(SHUFFLED)), 'and matches the in-process bytes');
});
