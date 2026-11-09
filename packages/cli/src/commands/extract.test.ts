import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AuthoritativeScope, ExtractorStatus, SeamlineNode } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig, type SeamlineConfig } from '../config.ts';
import { bufferIo, EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME } from '../io.ts';
import type { CliDeps, ExtractorPort } from '../ports.ts';
import { runCli } from '../run.ts';
import { fileSnapshots, parseSif } from '../sif.ts';
import { compileCanonicalSelector, currentObservationOf, encodeCanonicalSelector, isCanonicalSelectorText, SqliteStore } from '@seamline/core';
import { nodeId } from '@seamline/ontology';
import { makeEdge, makeNode, makeResult, memoryGraph, memoryStorePort, type MemoryGraph } from '../testing.ts';
import { inferJoinExtractorPort, sqliteStorePort } from '../wiring.ts';
import type { ExtractReport } from './extract.ts';
import { REQUIRED_SCOPES } from '@seamline/infer-join';
import { secretCanary } from '@seamline/security/corpus';

async function repoWith(config: SeamlineConfig): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-extract-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(config), 'utf8');
  return dir;
}

function fakeExtractor(name: string, status: ExtractorStatus, scopes: readonly string[]): ExtractorPort {
  const node = makeNode({ kind: 'File', canonicalName: `src/${name}.ts`, path: `src/${name}.ts` });
  return {
    name,
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () =>
      Promise.resolve({
        result: makeResult(name, status, scopes, status === 'PASS' ? [] : [`${name} could not run`]),
        nodes: status === 'PASS' ? [node] : [],
        edges:
          status === 'PASS'
            ? [{ scope: scopes[0] ?? 'default', edges: [makeEdge({ kind: 'CONTAINS', src: node.id, dst: node.id })] }]
            : [],
      }),
  };
}

function deps(
  cwd: string,
  extractors: readonly ExtractorPort[],
  graph: MemoryGraph = memoryGraph(),
): CliDeps & { io: ReturnType<typeof bufferIo>; graph: MemoryGraph } {
  const io = bufferIo({ cwd, isTty: false, env: {} });
  return {
    io,
    graph,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(graph),
    extractors,
  };
}

const twoExtractorConfig: SeamlineConfig = {
  ...defaultConfig('demo'),
  extractors: [
    { name: 'extract-code-ts', enabled: true, options: {} },
    { name: 'extract-data', enabled: true, options: {} },
  ],
};

test('extract prints one status line per extractor, including UNAVAILABLE', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const d = deps(dir, [
    fakeExtractor('extract-code-ts', 'PASS', ['code']),
    fakeExtractor('extract-data', 'UNAVAILABLE', ['data']),
  ]);

  const code = await runCli(d, ['extract']);
  assert.equal(code, EXIT_OK, 'UNAVAILABLE alone does not fail the run');
  const out = d.io.stdout();
  assert.match(out, /PASS\s+extract-code-ts/);
  assert.match(out, /UNAVAILABLE\s+extract-data/);
  assert.match(out, /extract-data could not run/, 'the diagnostic is shown, not swallowed');
});

test('a UNAVAILABLE extractor makes its scope visibly degraded', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const d = deps(dir, [
    fakeExtractor('extract-code-ts', 'PASS', ['code']),
    fakeExtractor('extract-data', 'UNAVAILABLE', ['data']),
  ]);
  await runCli(d, ['extract', '--json']);
  const report = JSON.parse(d.io.stdout()) as ExtractReport;
  assert.deepEqual(report.degradedScopes, ['data']);
  assert.equal(report.results.find((r) => r.extractor === 'extract-data')?.status, 'UNAVAILABLE');
});

test('a configured extractor with no implementation is UNAVAILABLE, not silence', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const d = deps(dir, [fakeExtractor('extract-code-ts', 'PASS', ['code'])]);
  const code = await runCli(d, ['extract', '--json']);
  assert.equal(code, EXIT_OK);
  const report = JSON.parse(d.io.stdout()) as ExtractReport;
  assert.equal(report.results.length, 2, 'both configured extractors are reported');
  const missing = report.results.find((r) => r.extractor === 'extract-data');
  assert.equal(missing?.status, 'UNAVAILABLE');
  assert.match(missing?.diagnostics[0] ?? '', /no implementation registered/);
});

test('a FAILing extractor exits non-zero', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const d = deps(dir, [
    fakeExtractor('extract-code-ts', 'PASS', ['code']),
    fakeExtractor('extract-data', 'FAIL', ['data']),
  ]);
  const code = await runCli(d, ['extract']);
  assert.equal(code, EXIT_FINDINGS);
  assert.match(d.io.stderr(), /FAILED/);
});

test('an extractor that throws is recorded as FAIL rather than aborting the run', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const exploding: ExtractorPort = {
    name: 'extract-data',
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () => Promise.reject(new Error('boom')),
  };
  const d = deps(dir, [fakeExtractor('extract-code-ts', 'PASS', ['code']), exploding]);
  await runCli(d, ['extract', '--json']);
  const report = JSON.parse(d.io.stdout()) as ExtractReport;
  assert.equal(report.results.length, 2);
  assert.equal(report.results.find((r) => r.extractor === 'extract-data')?.status, 'FAIL');
  assert.equal(report.results.find((r) => r.extractor === 'extract-code-ts')?.status, 'PASS');
});

test('extract persists what it extracted and finalizes the run', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const graph = memoryGraph();
  const d = deps(dir, [fakeExtractor('extract-code-ts', 'PASS', ['code'])], graph);
  await runCli(d, ['extract']);

  assert.equal(graph.writes.nodes.length, 1, 'the node reached the store');
  assert.equal(graph.writes.edges[0]?.scope, 'code', 'edges were written under their scope');
  assert.equal(graph.writes.finalized.length, 1, 'the run was finalized');
  assert.equal(graph.writes.finalized[0]?.runId, 'run-test');
  assert.equal(graph.closed(), 1, 'the store was closed exactly once');
});

test('extract writes the SIF snapshot under --out, not the process cwd default', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const customOut = await mkdtemp(path.join(tmpdir(), 'seamline-extract-out-'));
  const d = deps(dir, [fakeExtractor('extract-code-ts', 'PASS', ['code'])]);
  const withSnapshots: CliDeps = { ...d, snapshots: fileSnapshots() };

  const code = await runCli(withSnapshots, ['extract', '--out', customOut]);
  assert.equal(code, EXIT_OK, d.io.stderr());

  const snapshotPath = path.join(customOut, 'runs', 'run-test.sif');
  const snapshot = await readFile(snapshotPath, 'utf8');
  assert.match(snapshot, /"runId":"run-test"/, 'the snapshot lands under --out, not under the cwd-relative default');
  const header = JSON.parse(snapshot.split('\n')[1] ?? '{}') as { t?: string; run?: unknown };
  assert.equal(header.t, 'run');
  assert.deepEqual(header.run, await d.graph.runs.get('run-test'), 'the snapshot carries the actual persisted run, including its completion metadata');

  const wrongPath = path.join(dir, 'seamline-out', 'runs', 'run-test.sif');
  await assert.rejects(
    readFile(wrongPath, 'utf8'),
    'nothing is written to the cwd-relative default once --out is given',
  );
});

test('snapshot completion metadata uses the injected extraction clock and the persisted run', async () => {
  const dir = await repoWith({ ...defaultConfig('demo'), extractors: [{ name: 'empty', enabled: true, options: {} }] });
  const output = await mkdtemp(path.join(tmpdir(), 'seamline-run-clock-'));
  const empty: ExtractorPort = { name: 'empty', version: '0.0.1', provenanceCeiling: 'EXTRACTED', extract: async () => ({
    result: makeResult('empty', 'PASS', []), nodes: [], edges: [],
  }) };
  const d = deps(dir, [empty]);
  const fixed = '1981-03-04T05:06:07.008Z';
  assert.equal(await runCli({ ...d, clock: { now: () => fixed, runId: () => 'run-clock' }, store: sqliteStorePort(), snapshots: fileSnapshots() }, ['extract', '--out', output]), EXIT_OK, d.io.stderr());
  const snapshot = parseSif(await readFile(path.join(output, 'runs', 'run-clock.sif'), 'utf8'), 'clock regression');
  assert.equal(snapshot.run?.startedAt, fixed);
  assert.equal(snapshot.run?.finishedAt, fixed);
  const raw = new SqliteStore({ path: path.join(output, 'graph.db') });
  try { assert.deepEqual(snapshot.run, await raw.getRun('run-clock')); }
  finally { await raw.close(); }
});

test('a missing finalized run record refuses the snapshot instead of inventing metadata', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const output = await mkdtemp(path.join(tmpdir(), 'seamline-missing-run-'));
  const d = deps(dir, [fakeExtractor('extract-code-ts', 'PASS', ['code'])]);
  const original = d.store;
  assert.ok(original);
  const store = { open: async (options: Parameters<typeof original.open>[0]) => {
    const workspace = await original.open(options);
    return { ...workspace, runs: { ...workspace.runs, get: async () => undefined } };
  } };
  assert.equal(await runCli({ ...d, store, snapshots: fileSnapshots() }, ['extract', '--out', output]), EXIT_RUNTIME);
  assert.match(d.io.stderr(), /finalized run metadata is unavailable/);
  await assert.rejects(readFile(path.join(output, 'runs', 'run-test.sif'), 'utf8'));
});

test('--only restricts the run to the named extractor', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const d = deps(dir, [
    fakeExtractor('extract-code-ts', 'PASS', ['code']),
    fakeExtractor('extract-data', 'PASS', ['data']),
  ]);
  await runCli(d, ['extract', '--only', 'extract-data', '--json']);
  const report = JSON.parse(d.io.stdout()) as ExtractReport;
  assert.deepEqual(report.results.map((r) => r.extractor), ['extract-data']);
});

test('extract --json emits valid, colour-free JSON', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const d = deps(dir, [fakeExtractor('extract-code-ts', 'PASS', ['code'])]);
  await runCli(d, ['extract', '--json']);
  const out = d.io.stdout();
  assert.doesNotMatch(out, /\u001b\[/);
  const report = JSON.parse(out) as ExtractReport;
  assert.equal(report.runId, 'run-test');
  assert.equal(report.startedAt, '1970-01-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Node precedence across extractors (v3 §2.4). `extract.precedence.test.ts`
// covers the real extractors; these pin the rules with fakes.
// ---------------------------------------------------------------------------

// Lifecycle set to this run's id, so the merge's sighting bookkeeping leaves it unchanged.
const SHARED = {
  ...makeNode({
    kind: 'File',
    canonicalName: 'src/a.ts',
    name: 'src/a.ts',
    path: 'src/a.ts',
    props: { extension: '.ts' },
  }),
  firstSeenRun: 'run-test',
  lastSeenRun: 'run-test',
};

function emitting(
  name: string,
  status: ExtractorStatus,
  nodes: readonly SeamlineNode[],
): ExtractorPort {
  return {
    name,
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () => Promise.resolve({ result: makeResult(name, status, [name]), nodes, edges: [] }),
  };
}

async function storedAfter(order: readonly ExtractorPort[]): Promise<MemoryGraph> {
  const dir = await repoWith({
    ...defaultConfig('demo'),
    extractors: order.map((e) => ({ name: e.name, enabled: true, options: {} })),
  });
  const graph = memoryGraph();
  await runCli(deps(dir, order, graph), ['extract']);
  return graph;
}

test('a node id two extractors emit keeps the higher-priority body in either order, including against an unlisted extractor', async () => {
  const endpoint = { ...SHARED, name: 'a.ts', props: {} };
  for (const other of ['extract-change', 'extract-contracts', 'contrib-extractor']) {
    const code = emitting('extract-code-ts', 'PASS', [SHARED]);
    const rival = emitting(other, 'PASS', [endpoint]);
    for (const order of [[code, rival], [rival, code]]) {
      const graph = await storedAfter(order);
      assert.deepEqual(graph.store.node(SHARED.id), SHARED, order.map((e) => e.name).join(' then '));
    }
  }
});

test('an extractor that did not PASS never displaces a passing extractor\'s node, but its other nodes are still stored', async () => {
  const partial = { ...SHARED, name: 'a.ts', props: {} };
  const onlyFailed = makeNode({ kind: 'Contract', canonicalName: 'openapi.yaml', path: 'openapi.yaml' });
  const code = emitting('extract-code-ts', 'PASS', [SHARED]);
  const failed = emitting('extract-contracts', 'FAIL', [partial, onlyFailed]);
  for (const order of [[code, failed], [failed, code]]) {
    const graph = await storedAfter(order);
    const label = order.map((e) => e.name).join(' then ');
    assert.deepEqual(graph.store.node(SHARED.id), SHARED, label);
    assert.deepEqual(graph.store.node(onlyFailed.id), onlyFailed, label);
  }
});

/**
 * A graph with one column and two equally good field candidates for it
 * (`title` and `titles`), declared PASS for every scope `infer-join` needs, so
 * the real `infer-join` runs and records a two-way tie.
 */
function tiedJoinExtractor(): ExtractorPort {
  const path = 'src/post.ts';
  const table = makeNode({ kind: 'Table', canonicalName: 'public.posts' });
  const column = makeNode({ kind: 'Column', canonicalName: 'public.posts.title', props: { type: 'text' } });
  const model = makeNode({ kind: 'Symbol', canonicalName: 'src/post.ts#Post', path, props: { symbolKind: 'class' } });
  const fields = ['title', 'titles'].map((name) =>
    makeNode({ kind: 'CodeField', canonicalName: `src/post.ts#Post.${name}`, path, props: { type: 'string' } }));
  const contains = [[table, column] as const, ...fields.map((f) => [model, f] as const)].map(([src, dst]) =>
    makeEdge({ kind: 'CONTAINS', src: src.id, dst: dst.id, provenance: 'EXTRACTED', confidence: 1 }));
  return {
    name: 'graph-fixture',
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () =>
      Promise.resolve({
        result: makeResult('graph-fixture', 'PASS', REQUIRED_SCOPES),
        nodes: [table, column, model, ...fields],
        edges: [{ scope: 'code.ts', edges: contains }],
      }),
  };
}

test('extract --json keeps infer-join ambiguity records instead of dropping them', async () => {
  const config: SeamlineConfig = {
    ...defaultConfig('demo'),
    extractors: [
      { name: 'graph-fixture', enabled: true, options: {} },
      { name: 'infer-join', enabled: true, options: {} },
    ],
  };
  const dir = await repoWith(config);
  const d = deps(dir, [tiedJoinExtractor(), inferJoinExtractorPort()]);
  const code = await runCli(d, ['extract', '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const report = JSON.parse(d.io.stdout()) as ExtractReport;

  assert.equal(report.results.find((r) => r.extractor === 'infer-join')?.status, 'PASS');
  const tie = report.ambiguities.find((a) => a.reason === 'tie' && a.edgeKind === 'MAPS_TO_FIELD');
  assert.ok(tie !== undefined, JSON.stringify(report.ambiguities));
  assert.equal(tie.subject, nodeId('demo', 'Column', 'public.posts.title'));
  assert.equal(tie.dropped, false);
  const candidates = ['title', 'titles'].map((name) => nodeId('demo', 'CodeField', `src/post.ts#Post.${name}`));
  assert.deepEqual(tie.candidates.map((c) => c.id).slice().sort(), candidates);
});

test('extract --json reports no ambiguity records when infer-join did not run', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const d = deps(dir, [fakeExtractor('extract-code-ts', 'PASS', ['code'])]);
  await runCli(d, ['extract', '--json']);
  const report = JSON.parse(d.io.stdout()) as ExtractReport;
  assert.deepEqual(report.ambiguities, []);
});

test('with no store wired, extract fails with an actionable message rather than crashing', async () => {
  const dir = await repoWith(twoExtractorConfig);
  const io = bufferIo({ cwd: dir, isTty: false, env: {} });
  const code = await runCli(
    { io, clock: { now: () => 'now', runId: () => 'r' } },
    ['extract'],
  );
  assert.equal(code, 3);
  assert.match(io.stderr(), /needs a store implementation/);
});

// ---------------------------------------------------------------------------
// ADR-0011: a canary secret must not survive `seamline extract`
// end to end, through the *real* store and the *real* SIF snapshot -- not
// `memoryStorePort`'s fake, which has no redaction wired in at all and would
// pass this test for the wrong reason. Only `deps.store` is real here; the
// extractor is still a fake reading a real fixture file, matching how every
// other test in this file works -- the thing under test is the store/snapshot
// write path, not any particular extractor's parser.
// ---------------------------------------------------------------------------

const CANARY = secretCanary('aws-access-key-id/documented-example').secret; // AWS's own documentation example key id.

test('full run metadata cannot export a credential-shaped repository identity in a SIF snapshot', async () => {
  const dir = await repoWith({ ...defaultConfig(CANARY), extractors: [{ name: 'empty', enabled: true, options: {} }] });
  const output = await mkdtemp(path.join(tmpdir(), 'seamline-run-metadata-out-'));
  const empty: ExtractorPort = { name: 'empty', version: '0.0.1', provenanceCeiling: 'EXTRACTED', extract: async () => ({
    result: makeResult('empty', 'PASS', []), nodes: [], edges: [],
  }) };
  const d = deps(dir, [empty]);
  assert.equal(await runCli({ ...d, store: sqliteStorePort(), snapshots: fileSnapshots() }, ['extract', '--out', output]), EXIT_RUNTIME);
  assert.ok(!d.io.stderr().includes(CANARY), 'the refusal message does not repeat the credential');
  await assert.rejects(readFile(path.join(output, 'runs', 'run-test.sif'), 'utf8'), 'no snapshot is written with the unsafe run identity');
});

function fixtureReadingExtractor(name: string, fixtureRelPath: string): ExtractorPort {
  return {
    name,
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    async extract(ctx) {
      const text = await readFile(path.join(ctx.repoRoot, fixtureRelPath), 'utf8');
      const node = makeNode({
        kind: 'File',
        canonicalName: fixtureRelPath,
        path: fixtureRelPath,
        props: { firstLine: text.split('\n')[0] ?? '' },
      });
      return {
        result: makeResult(name, 'PASS', ['code'], []),
        nodes: [node],
        edges: [],
      };
    },
  };
}

test('a canary secret planted in a source fixture is absent from both the real store and the real SIF snapshot after `seamline extract`', async () => {
  const config: SeamlineConfig = {
    ...defaultConfig('demo'),
    extractors: [{ name: 'fixture-reader', enabled: true, options: {} }],
  };
  const dir = await repoWith(config);
  await writeFile(path.join(dir, 'config.ts'), `export const databaseUrl = 'postgres://x:${CANARY}@host/db';\n`, 'utf8');

  const io = bufferIo({ cwd: dir, isTty: false, env: {} });
  const d: CliDeps = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-canary' },
    store: sqliteStorePort(),
    extractors: [fixtureReadingExtractor('fixture-reader', 'config.ts')],
    snapshots: fileSnapshots(),
  };

  const code = await runCli(d, ['extract']);
  assert.equal(code, EXIT_OK, io.stderr());

  const outDir = path.join(dir, 'seamline-out');

  const raw = new SqliteStore({ path: path.join(outDir, 'graph.db') });
  try {
    const stored = raw.node(nodeId('demo', 'File', 'config.ts'));
    assert.ok(stored, 'the node was written');
    const line = String(stored.props['firstLine']);
    assert.ok(!line.includes(CANARY), `the on-disk store still contains the raw secret: ${line}`);
    assert.match(line, /«redacted:sha256:[0-9a-f]{8}»/, 'a redaction reference replaced it, not a silent drop');
  } finally {
    await raw.close();
  }

  const snapshot = await readFile(path.join(outDir, 'runs', 'run-canary.sif'), 'utf8');
  assert.ok(!snapshot.includes(CANARY), 'the SIF snapshot still contains the raw secret');
});

// ---------------------------------------------------------------------------
// Identity and locator fields are never rewritten (ADR-0013). A credential in
// one of them is refused, and the refusal must surface as that extractor's
// FAIL, not as a crash and not as a PASS with a missing node.
// ---------------------------------------------------------------------------

function nodeEmittingExtractor(name: string, scope: string, node: SeamlineNode): ExtractorPort {
  return {
    name,
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () =>
      Promise.resolve({
        result: makeResult(name, 'PASS', [scope], []),
        nodes: [node],
        edges: [],
      }),
  };
}

async function runWithRealStore(
  extractors: readonly ExtractorPort[],
  args: readonly string[],
  again?: { readonly dir: string; readonly runId: string },
): Promise<{ code: number; dir: string; io: ReturnType<typeof bufferIo> }> {
  const config: SeamlineConfig = {
    ...defaultConfig('demo'),
    extractors: extractors.map((e) => ({ name: e.name, enabled: true, options: {} })),
  };
  const dir = again?.dir ?? (await repoWith(config));
  const io = bufferIo({ cwd: dir, isTty: false, env: {} });
  const d: CliDeps = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => again?.runId ?? 'run-identity' },
    store: sqliteStorePort(),
    extractors,
    snapshots: fileSnapshots(),
  };
  const code = await runCli(d, ['extract', ...args]);
  return { code, dir, io };
}

test('refused canonical authority records failed coverage without persisting reversible credentials or sweeping prior facts', async () => {
  let index = 0;
  for (const location of ['path', 'rule', 'malformed'] as const) for (const status of ['PASS', 'FAIL', 'UNAVAILABLE'] as const) {
    let refuse = false;
    const source = 'src/prior.ts';
    const body = { path: location === 'path' ? `src/${CANARY}.ts` : source,
      rules: [['exact', location === 'path' ? 'A' : CANARY]] };
    // Model a child or external caller constructing its wire envelope directly.
    const selector = `/@canonical/${location === 'malformed' ? 'v2' : 'v1'}/` + Buffer.from(JSON.stringify(body)).toString('hex');
    const unsafe: AuthoritativeScope = { scope: 'contracts', kinds: ['Contract'], selector };
    const prior = makeNode({ kind: 'Contract', canonicalName: 'A', path: source });
    const oldClaim: AuthoritativeScope = { scope: 'contracts', kinds: ['Contract'], selector: source };
    const denied: ExtractorPort = {
      name: 'authority-refusal', version: '0.0.1', provenanceCeiling: 'EXTRACTED',
      get produces() { return refuse ? (location === 'malformed' ? [] : [unsafe, { ...unsafe, scope: 'fallback' }]) : [oldClaim]; },
      async extract() {
        const actualStatus = refuse ? status : 'PASS';
        return { result: { ...makeResult('authority-refusal', actualStatus, []),
          authoritative: refuse ? (status === 'PASS' || location === 'malformed' ? [unsafe] : []) : [oldClaim],
        }, nodes: [prior], edges: [] };
      },
    };
    const control = makeNode({ kind: 'Contract', canonicalName: 'Control', path: 'src/control.ts' });
    const safeClaim: AuthoritativeScope = { scope: 'safe-authority', kinds: ['Contract'],
      selector: encodeCanonicalSelector({ path: 'src/control.ts', rules: [['exact', 'Control']] }),
    };
    const safe: ExtractorPort = { name: 'safe-authority', version: '0.0.1', provenanceCeiling: 'EXTRACTED', produces: [safeClaim],
      extract: async () => ({ result: { ...makeResult('safe-authority', 'PASS', []), authoritative: [safeClaim] }, nodes: [control], edges: [] }),
    };
    const first = await runWithRealStore([denied, safe], ['--json']);
    assert.equal(first.code, EXIT_OK, first.io.stderr());
    refuse = true;
    const runId = `run-authority-refusal-${index++}`;
    const second = await runWithRealStore([denied, safe], ['--json'], { dir: first.dir, runId });
    assert.equal(second.code, EXIT_FINDINGS, 'a refused authority must finalize as FAIL instead of leaving an older PASS');
    const report = JSON.parse(second.io.stdout()) as ExtractReport;
    assert.equal(report.results.find(result => result.extractor === denied.name)?.status, 'FAIL');
    assert.equal(report.results.find(result => result.extractor === safe.name)?.status, 'PASS');
    const outDir = path.join(second.dir, 'seamline-out');
    const dbFile = path.join(outDir, 'graph.db');
    const raw = new SqliteStore({ path: dbFile });
    try {
      assert.equal(raw.scopeStatus('contracts'), 'FAIL');
      assert.equal(raw.scopeStatus('fallback'), location === 'malformed' ? 'UNAVAILABLE' : 'FAIL',
        'declared fallback coverage is preserved without its selector; undeclared coverage is never invented');
      assert.equal(raw.scopeStatus('safe-authority'), 'PASS');
      assert.equal(raw.node(prior.id)?.deletedAt, null);
      assert.equal(raw.node(prior.id)?.lastSeenRun, 'run-identity', 'preflight occurs before fact writes');
      const run = await raw.getRun(runId);
      assert.ok(run);
      const failed = run.results.find(result => result.extractor === denied.name);
      const expectedCoverage = [{ scope: 'contracts', kinds: ['Contract'] },
        ...(location === 'malformed' ? [] : [{ scope: 'fallback', kinds: ['Contract'] }])];
      assert.deepEqual(failed?.authoritative, expectedCoverage);
      assert.equal(currentObservationOf(run)('contracts', raw.node(prior.id)), false);
      assert.equal(currentObservationOf(run)('safe-authority', raw.node(control.id)), true, 'safe canonical authority still works');
    } finally { await raw.close(); }
    const text = await readFile(path.join(outDir, 'runs', `${runId}.sif`), 'utf8');
    const snapshot = parseSif(text, 'authority refusal');
    for (const result of snapshot.results) for (const claim of result.authoritative) {
      if (claim.selector !== undefined && isCanonicalSelectorText(claim.selector)) {
        const decoded = compileCanonicalSelector(claim.selector);
        assert.equal(decoded.path.includes(CANARY), false);
        assert.ok(decoded.rules.every(rule => !rule[1].includes(CANARY)));
      }
    }
    const encodedCanary = Buffer.from(CANARY).toString('hex');
    for (const artifact of [Buffer.from(text), await readFile(dbFile), Buffer.from(second.io.stdout() + second.io.stderr())]) {
      assert.equal(artifact.includes(CANARY), false, 'no raw credential is persisted or reported');
      assert.equal(artifact.includes(encodedCanary), false, 'no recoverable authority envelope is persisted or reported');
    }
  }
});

test('a credential in a node id fails that extractor, is stored nowhere, and does not break the run', async () => {
  const dirty = makeNode({
    kind: 'File',
    canonicalName: `config/${CANARY}.json`,
    path: `config/${CANARY}.json`,
  });
  const clean = nodeEmittingExtractor(
    'extract-data',
    'data',
    makeNode({ kind: 'File', canonicalName: 'src/clean.ts', path: 'src/clean.ts' }),
  );
  const { code, dir, io } = await runWithRealStore(
    [nodeEmittingExtractor('extract-code-ts', 'code.ts', dirty), clean],
    ['--json'],
  );

  assert.equal(code, EXIT_FINDINGS, `a refused extractor is a FAIL: ${io.stderr()}`);
  const report = JSON.parse(io.stdout()) as ExtractReport;
  const refused = report.results.filter((r) => r.extractor === 'extract-code-ts');
  assert.equal(
    refused.length,
    1,
    'exactly one result per extractor: extractor_results is keyed by (run, extractor)',
  );
  assert.equal(refused[0]?.status, 'FAIL');
  assert.match(
    refused[0]?.diagnostics[0] ?? '',
    /rule "aws-access-key-id" matched credential-shaped text in id\.canonicalName/,
  );
  assert.ok(!JSON.stringify(report).includes(CANARY), 'the report does not quote the credential');
  assert.equal(
    report.results.find((r) => r.extractor === 'extract-data')?.status,
    'PASS',
    'the other extractor is unaffected',
  );
  assert.deepEqual(
    report.degradedScopes,
    ['code.ts'],
    'the refused extractor scope reads as degraded, not absent',
  );

  const outDir = path.join(dir, 'seamline-out');
  const raw = new SqliteStore({ path: path.join(outDir, 'graph.db') });
  try {
    assert.equal(
      raw.scopeStatus('code.ts'),
      'FAIL',
      'queries over the scope answer UNKNOWN, never a negative finding',
    );
    assert.equal(raw.scopeStatus('data'), 'PASS');
    assert.deepEqual(
      raw.nodesByKind('File').map((n) => String(n.id)),
      ['demo:File:src/clean.ts'],
      'the refused node is not stored, under its own id or a rewritten one',
    );
  } finally {
    await raw.close();
  }
  assert.ok(
    !(await readFile(path.join(outDir, 'graph.db'))).includes(CANARY),
    'the database file holds no credential',
  );
  const sif = await readFile(path.join(outDir, 'runs', 'run-identity.sif'), 'utf8');
  assert.ok(!sif.includes(CANARY), 'the SIF snapshot holds no credential');
});

test('the report names the rule behind every replacement, and never the replaced text', async () => {
  const node = makeNode({
    kind: 'File',
    canonicalName: 'src/config.ts',
    path: 'src/config.ts',
    props: { databaseUrl: `postgres://x:${CANARY}@host/db`, note: 'ok' },
  });
  const { code, io } = await runWithRealStore(
    [nodeEmittingExtractor('extract-code-ts', 'code.ts', node)],
    ['--json'],
  );
  assert.equal(code, EXIT_OK, io.stderr());
  const report = JSON.parse(io.stdout()) as ExtractReport;
  assert.equal(report.redactions.total, 1);
  assert.deepEqual(report.redactions.byRule, [{ rule: 'aws-access-key-id', count: 1 }]);
  const [finding] = report.redactions.findings;
  assert.equal(finding?.rule, 'aws-access-key-id');
  assert.equal(finding?.target, 'demo:File:src/config.ts');
  assert.equal(finding?.field, 'props.databaseUrl');
  assert.equal(finding?.length, CANARY.length);
  assert.match(finding?.ref ?? '', /^«redacted:sha256:[0-9a-f]{8}»$/);
  assert.ok(!io.stdout().includes(CANARY));

  const { io: text } = await runWithRealStore(
    [nodeEmittingExtractor('extract-code-ts', 'code.ts', node)],
    [],
  );
  assert.match(text.stdout(), /redacted 1 value\(s\) before storage: aws-access-key-id x1/);
  assert.ok(!text.stdout().includes(CANARY));
});

test('a run with nothing to redact reports none', async () => {
  const node = makeNode({ kind: 'File', canonicalName: 'src/ok.ts', path: 'src/ok.ts' });
  const { io } = await runWithRealStore(
    [nodeEmittingExtractor('extract-code-ts', 'code.ts', node)],
    ['--json'],
  );
  const report = JSON.parse(io.stdout()) as ExtractReport;
  assert.deepEqual(report.redactions, { total: 0, byRule: [], findings: [] });
  const { io: text } = await runWithRealStore(
    [nodeEmittingExtractor('extract-code-ts', 'code.ts', node)],
    [],
  );
  assert.doesNotMatch(text.stdout(), /redacted \d+ value/);
});

test('an extractor whose write the store rejects leaves one FAIL result, not a crashed run', async () => {
  // `CONTAINS` from a File to itself is not a valid edge, so the store throws
  // after the extractor has produced its PASS result. `extractor_results` is
  // keyed by (run, extractor), so recording a PASS and then a FAIL for the same
  // extractor used to abort `finalizeRun` with a UNIQUE constraint error.
  const node = makeNode({ kind: 'File', canonicalName: 'src/a.ts', path: 'src/a.ts' });
  const invalid: ExtractorPort = {
    name: 'extract-data',
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () =>
      Promise.resolve({
        result: makeResult('extract-data', 'PASS', ['data'], []),
        nodes: [node],
        edges: [
          { scope: 'data', edges: [makeEdge({ kind: 'CONTAINS', src: node.id, dst: node.id })] },
        ],
      }),
  };
  const { code, io } = await runWithRealStore([invalid], ['--json']);
  assert.equal(code, EXIT_FINDINGS, io.stderr());
  const report = JSON.parse(io.stdout()) as ExtractReport;
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]?.status, 'FAIL');
});

test("a refusal in a later run does not leave the earlier run's PASS standing for that scope", async () => {
  const clean = makeNode({ kind: 'File', canonicalName: 'src/a.ts', path: 'src/a.ts' });
  const first = await runWithRealStore(
    [nodeEmittingExtractor('extract-code-ts', 'code.ts', clean)],
    [],
  );
  assert.equal(first.code, EXIT_OK, first.io.stderr());

  const dirty = makeNode({
    kind: 'File',
    canonicalName: `src/${CANARY}.ts`,
    path: `src/${CANARY}.ts`,
  });
  const second = await runWithRealStore(
    [nodeEmittingExtractor('extract-code-ts', 'code.ts', dirty)],
    [],
    { dir: first.dir, runId: 'run-identity-2' },
  );
  assert.equal(second.code, EXIT_FINDINGS, second.io.stderr());

  const raw = new SqliteStore({ path: path.join(first.dir, 'seamline-out', 'graph.db') });
  try {
    assert.equal(
      raw.scopeStatus('code.ts'),
      'FAIL',
      'the newest run declared the scope FAIL; the older PASS must not answer for it',
    );
  } finally {
    await raw.close();
  }
});

// ---------------------------------------------------------------------------
// `infer-join` is an ordinary registered extractor on this path, so what it
// emits meets the redactor like everything else does. The inline special case
// that used to redact its edges separately is gone; this keeps its edges from
// reaching the store or the snapshot unredacted.
// ---------------------------------------------------------------------------

test('the edges infer-join emits are redacted before the store and the snapshot see them', async () => {
  const real = inferJoinExtractorPort();
  let tainted = 0;
  const withSecretOnEveryEdge: ExtractorPort = {
    ...real,
    extract: async (ctx) => {
      const out = await real.extract(ctx);
      return {
        ...out,
        edges: out.edges.map((group) => ({
          ...group,
          edges: group.edges.map((e) => {
            tainted += 1;
            return { ...e, props: { ...e.props, note: `leaked ${CANARY}` } };
          }),
        })),
      };
    },
  };
  const { code, dir, io } = await runWithRealStore([tiedJoinExtractor(), withSecretOnEveryEdge], ['--json']);

  assert.equal(code, EXIT_OK, io.stderr());
  const report = JSON.parse(io.stdout()) as ExtractReport;
  const joined = report.results.find((r) => r.extractor === 'infer-join');
  assert.equal(joined?.status, 'PASS');
  assert.ok(tainted > 0, 'precondition: infer-join emitted edges, so the check below is not vacuous');
  assert.ok(report.redactions.total >= tainted, JSON.stringify(report.redactions.byRule));
  assert.ok(!JSON.stringify(report).includes(CANARY), 'the report does not quote the credential');

  const outDir = path.join(dir, 'seamline-out');
  assert.ok(!(await readFile(path.join(outDir, 'graph.db'))).includes(CANARY), 'the database holds no credential');
  for (const file of await readdir(path.join(outDir, 'runs'))) {
    assert.ok(!(await readFile(path.join(outDir, 'runs', file), 'utf8')).includes(CANARY), `${file} holds no credential`);
  }
});

test('a redaction refusal keeps the scopes the port declares even when the result named none, and no earlier PASS stands', async () => {
  const dirty = makeNode({ kind: 'File', canonicalName: `src/${CANARY}.ts`, path: `src/${CANARY}.ts` });
  const clean = makeNode({ kind: 'File', canonicalName: 'src/a.ts', path: 'src/a.ts' });
  const scope = { scope: 'code.ts', kinds: ['File' as const] };
  const port = (node: SeamlineNode): ExtractorPort => ({
    name: 'extract-code-ts',
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    produces: [scope],
    // A PASS that names no scope: with nothing declared on the result, the refusal would leave run 1's PASS standing.
    extract: () => Promise.resolve({ result: makeResult('extract-code-ts', 'PASS', [], []), nodes: [node], edges: [] }),
  });

  const first = await runWithRealStore([port(clean)], ['--json']);
  assert.equal(first.code, EXIT_OK, first.io.stderr());
  const second = await runWithRealStore([port(dirty)], ['--json'], { dir: first.dir, runId: 'run-identity-2' });
  assert.equal(second.code, EXIT_FINDINGS, second.io.stderr());

  const report = JSON.parse(second.io.stdout()) as ExtractReport;
  const result = report.results.filter((r) => r.extractor === 'extract-code-ts');
  assert.equal(result.length, 1);
  assert.equal(result[0]?.status, 'FAIL');
  assert.match(result[0]?.diagnostics[0] ?? '', /rule "aws-access-key-id" matched credential-shaped text/);
  assert.deepEqual(result[0]?.authoritative, [scope]);
  assert.deepEqual(report.degradedScopes, ['code.ts']);
  const raw = new SqliteStore({ path: path.join(first.dir, 'seamline-out', 'graph.db') });
  try {
    assert.equal(raw.scopeStatus('code.ts'), 'FAIL');
  } finally {
    await raw.close();
  }
});
