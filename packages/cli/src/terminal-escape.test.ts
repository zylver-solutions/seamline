/**
 * Terminal escaping: text that a repository controls must not reach the terminal raw.
 *
 * Each test drives a real command through `runCli` with hostile text in the one
 * field that renderer prints, then asserts on the bytes written. `--json` is
 * asserted to carry the same text unchanged: JSON encoding is not this concern,
 * and its bytes are pinned elsewhere.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Contradiction, GraphView } from '@seamline/ontology';
import { makeStyle } from './colour.ts';
import { CONFIG_FILENAME, defaultConfig, serializeConfig, type SeamlineConfig } from './config.ts';
import { renderConformance } from './commands/conformance.ts';
import { bufferIo, CliError, EXIT_OK, EXIT_RUNTIME } from './io.ts';
import { emitText, emitTextErr } from './render.ts';
import type { AlignPort, CliDeps, DetectionReport, DetectorRunnerPort, ExtractorPort } from './ports.ts';
import { runCli } from './run.ts';
import { fakeGitPort, makeEdge, makeNode, makeResult, makeRun, memoryGraph, memoryStorePort, UNSAFE_OUTPUT, type MemoryGraph } from './testing.ts';

/** ESC, CSI, OSC with BEL, one-byte CSI, DEL, bidi override, zero-width, U+2028, LF and CR in one name. */
const HOSTILE =
  'x\u001b[31mRED\u001b]0;pwned\u0007\u009b2J\u007f\u202Eevil\u200BZW\u2028SEP\nCRITICAL  X1_FORGED  forged\rend';

/** `HOSTILE` without line breaks, for text that is allowed to span lines (a hint). */
const HOSTILE_ONE_LINE = HOSTILE.replace(/[\r\n]/g, ' ');

/** Pieces of `HOSTILE` that must still be readable once it is escaped. */
const STILL_SHOWN = ['RED', 'pwned', 'evil', 'ZW', 'SEP', 'X1_FORGED', 'end'];

function assertTerminalSafe(out: string, label: string): void {
  assert.doesNotMatch(out, UNSAFE_OUTPUT, `${label}: a control, bidi or invisible character reached the output`);
  for (const piece of STILL_SHOWN) assert.ok(out.includes(piece), `${label}: lost "${piece}" from the name`);
  const forged = out.split('\n').filter((l) => l.trimStart().startsWith('CRITICAL  X1_FORGED'));
  assert.deepEqual(forged, [], `${label}: a name forged a line of its own`);
}

async function repoWith(config: SeamlineConfig = defaultConfig('demo')): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-escape-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(config), 'utf8');
  return dir;
}

function baseDeps(
  cwd: string,
  extra: Partial<Omit<CliDeps, 'io'>> = {},
  env: Record<string, string> = {},
): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env });
  return { io, clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' }, ...extra };
}

const left = makeNode({ kind: 'Column', canonicalName: 'users.email' });
const right = makeNode({ kind: 'SchemaProperty', canonicalName: 'UserDto#/email' });

const hostLeft = makeNode({ kind: 'Column', canonicalName: `users.${HOSTILE}` });
const hostRight = makeNode({ kind: 'SchemaProperty', canonicalName: `UserDto#/${HOSTILE}` });

function hostileContradiction(): Contradiction {
  return {
    code: 'X1_NULLABILITY',
    severity: 'medium',
    left: hostLeft.id,
    right: hostRight.id,
    claim: `claim ${HOSTILE}`,
    leftFact: `left fact ${HOSTILE}`,
    rightFact: `right fact ${HOSTILE}`,
    viaPath: ['EXPOSED_AS'],
    confidence: 0.9,
  };
}

/** A Repo node that names one unread workspace package: the repro in the issue. */
function unreadPackageGraph(name: string): MemoryGraph {
  const repo = makeNode({
    kind: 'Repo',
    canonicalName: 'demo',
    props: { unreadCodePackageCount: 1, unreadCodePackages: JSON.stringify([`packages/${name}`]) },
  });
  return memoryGraph({
    nodes: [repo, left, right],
    runs: [makeRun('run-1', [makeResult('extract-code-ts', 'PASS', ['code.ts'])])],
  });
}

function detectorsOf(report: DetectionReport): DetectorRunnerPort {
  return { run: (_view: GraphView) => Promise.resolve(report) };
}

test('check: the unread-package line from the issue repro escapes the name (colour off)', async () => {
  const dir = await repoWith();
  const d = baseDeps(dir, {
    store: memoryStorePort(unreadPackageGraph(HOSTILE)),
    detectors: detectorsOf({ contradictions: [], unknown: [] }),
  });
  await runCli(d, ['check']);
  const line = d.io.stdout().split('\n').find((l) => l.includes('were not read'));
  assert.ok(line !== undefined, d.io.stdout());
  assert.match(line, /1 workspace package\(s\) were not read \(packages\/x\\x1b\[31mRED\\x1b\]0;pwned\\x07/);
  assertTerminalSafe(d.io.stdout(), 'check unread packages');
});

test('check: every finding field is escaped', async () => {
  const dir = await repoWith();
  const d = baseDeps(dir, {
    store: memoryStorePort(memoryGraph({ nodes: [hostLeft, hostRight] })),
    detectors: detectorsOf({
      contradictions: [hostileContradiction()],
      unknown: [
        { code: 'X2_TYPE', severity: 'high', reason: `reason ${HOSTILE}`, scopes: [`scope-${HOSTILE}`], scopeStatus: {} },
      ],
      notes: [{ code: 'X3_CONSTRAINT', notes: [`note ${HOSTILE}`] }],
    } as DetectionReport),
  });
  await runCli(d, ['check']);
  assertTerminalSafe(d.io.stdout(), 'check findings');
});

test('check: a degraded scope, its extractor and its diagnostics are escaped', async () => {
  const dir = await repoWith();
  const scope = `data-${HOSTILE}`;
  const graph = memoryGraph({
    nodes: [left, right],
    scopeStatus: { [scope]: 'FAIL' },
    runs: [makeRun('run-1', [makeResult(`extract-${HOSTILE}`, 'FAIL', [scope], [`diag ${HOSTILE}`])])],
  });
  const d = baseDeps(dir, { store: memoryStorePort(graph), detectors: detectorsOf({ contradictions: [], unknown: [] }) });
  await runCli(d, ['check']);
  assertTerminalSafe(d.io.stdout(), 'check scope diagnostics');
});

/** A PASS scope that read only part of its files: `describeNarrowedClaim` prints its scope and extractor. */
function narrowedResult(scope: string, extractor: string): ReturnType<typeof makeResult> {
  const base = makeResult(extractor, 'PASS', [scope], ['X_PARTIAL_COVERAGE: 2 file(s) were not read to the end']);
  return { ...base, authoritative: [{ scope, kinds: [], selector: 'src/**' }] } as unknown as ReturnType<typeof makeResult>;
}

function narrowedRun(scope: string, extractor: string): ReturnType<typeof makeRun> {
  return makeRun('run-1', [narrowedResult(scope, extractor)]);
}

test('check: a partial-coverage claim names its scope and extractor escaped', async () => {
  const dir = await repoWith();
  const scope = `code-${HOSTILE}`;
  const graph = memoryGraph({ nodes: [left, right], runs: [narrowedRun(scope, `extract-${HOSTILE}`)] });
  const d = baseDeps(dir, { store: memoryStorePort(graph), detectors: detectorsOf({ contradictions: [], unknown: [] }) });
  await runCli(d, ['check']);
  assert.match(d.io.stdout(), /PARTIAL COVERAGE/);
  assertTerminalSafe(d.io.stdout(), 'check partial coverage');
});

test('check with colour on: our own SGR codes survive and a name adds no escape byte', async () => {
  const dir = await repoWith();
  const run = async (name: string): Promise<string> => {
    const d = baseDeps(
      dir,
      { store: memoryStorePort(unreadPackageGraph(name)), detectors: detectorsOf({ contradictions: [], unknown: [] }) },
      { FORCE_COLOR: '1' },
    );
    await runCli(d, ['check']);
    return d.io.stdout();
  };
  const plain = await run('plain');
  const hostile = await run(`${HOSTILE}\u001b[0m\u001b[31m`);
  const esc = (s: string): number => s.split('\u001b').length - 1;
  assert.ok(esc(plain) > 0, 'colour is on in the control run');
  assert.equal(esc(hostile), esc(plain), 'the name added no raw ESC byte');
});

test('check --json carries the unread-package text unchanged, byte for byte', async () => {
  const dir = await repoWith();
  const d = baseDeps(dir, {
    store: memoryStorePort(unreadPackageGraph(HOSTILE)),
    detectors: detectorsOf({ contradictions: [hostileContradiction()], unknown: [] }),
  });
  await runCli(d, ['check', '--json']);
  const out = d.io.stdout();
  const report = JSON.parse(out) as {
    contradictions: Contradiction[];
    degradedScopes: { diagnostics: string[] }[];
  };
  assert.equal(report.contradictions[0]?.claim, `claim ${HOSTILE}`);
  assert.ok(report.degradedScopes[0]?.diagnostics[0]?.includes(HOSTILE));
  assert.ok(out.includes('\u007f') && out.includes('\u202E') && out.includes('\u2028'), 'DEL, bidi and U+2028 are left as JSON.stringify writes them');
  assert.equal(out, `${JSON.stringify(report, null, 2)}\n`);
});

test('blast-radius: root names, paths, unmatched paths and missing ids are escaped', async () => {
  const dir = await repoWith();
  const hostileFile = makeNode({ kind: 'File', canonicalName: 'src/a.ts', name: HOSTILE, path: `src/${HOSTILE}.ts` });
  const reached = makeNode({ kind: 'File', canonicalName: 'src/b.ts', name: `b ${HOSTILE}`, path: `src/b-${HOSTILE}.ts` });
  const graph = memoryGraph({
    nodes: [hostileFile, reached],
    edges: [makeEdge({ kind: 'IMPORTS', src: hostileFile.id, dst: reached.id, provenance: 'EXTRACTED', confidence: 1 })],
    scopeStatus: { [`code-${HOSTILE}`]: 'FAIL' },
    runs: [makeRun('run-1', [makeResult(`extract-${HOSTILE}`, 'FAIL', [`code-${HOSTILE}`])])],
  });
  const withPath = baseDeps(dir, {
    store: memoryStorePort(graph),
    git: fakeGitPort([`src/${HOSTILE}.ts`, `nowhere/${HOSTILE}.ts`]),
  });
  await runCli(withPath, ['blast-radius']);
  assertTerminalSafe(withPath.io.stdout(), 'blast-radius diff mode');

  const ids = baseDeps(dir, { store: memoryStorePort(graph) });
  await runCli(ids, ['blast-radius', '--ids', `${hostileFile.id},demo:File:${HOSTILE}`]);
  assertTerminalSafe(ids.io.stdout(), 'blast-radius ids mode');
});

test('why: target, container, lineage hops and finding text are escaped', async () => {
  const dir = await repoWith();
  const table = makeNode({ kind: 'Table', canonicalName: `public.${HOSTILE}`, name: HOSTILE });
  const column = makeNode({ kind: 'Column', canonicalName: `public.${HOSTILE}.email`, name: HOSTILE, path: `db/${HOSTILE}.sql` });
  const field = makeNode({ kind: 'CodeField', canonicalName: `User.${HOSTILE}`, name: HOSTILE, path: `src/${HOSTILE}.ts` });
  const graph = memoryGraph({
    nodes: [table, column, field],
    edges: [
      makeEdge({ kind: 'CONTAINS', src: table.id, dst: column.id, provenance: 'EXTRACTED', confidence: 1 }),
      makeEdge({
        kind: 'MAPS_TO_FIELD',
        src: column.id,
        dst: field.id,
        provenance: 'INFERRED',
        confidence: 0.9,
        sourceRef: `ref ${HOSTILE}`,
      }),
    ],
    runs: [
      makeRun('run-1', [
        makeResult(`extract-${HOSTILE}`, 'FAIL', [`down-${HOSTILE}`]),
        narrowedResult(`part-${HOSTILE}`, `partial-${HOSTILE}`),
      ]),
    ],
    scopeStatus: { [`down-${HOSTILE}`]: 'FAIL' },
  });
  const d = baseDeps(dir, {
    store: memoryStorePort(graph),
    detectors: detectorsOf({
      contradictions: [{ ...hostileContradiction(), left: column.id, right: field.id }],
      unknown: [{ code: 'X2_TYPE', severity: 'high', reason: `reason ${HOSTILE}`, scopes: [], scopeStatus: {} }],
    }),
  });
  await runCli(d, ['why', column.id]);
  assert.match(d.io.stdout(), /PARTIAL/);
  assertTerminalSafe(d.io.stdout(), 'why');
});

test('why: the ambiguous-target list is escaped on stderr', async () => {
  const dir = await repoWith();
  const a = makeNode({ kind: 'Column', canonicalName: `x.${HOSTILE}` });
  const b = makeNode({ kind: 'CodeField', canonicalName: `x.${HOSTILE}` });
  const d = baseDeps(dir, { store: memoryStorePort(memoryGraph({ nodes: [a, b] })) });
  await runCli(d, ['why', `x.${HOSTILE}`]);
  assert.match(d.io.stderr(), /matches 2 nodes/);
  assertTerminalSafe(d.io.stderr(), 'why ambiguous');
});

test('diff: refs, ids and changed values are escaped', async () => {
  const dir = await repoWith();
  const kept = makeNode({ kind: 'Column', canonicalName: `kept.${HOSTILE}` });
  const gone = makeNode({ kind: 'Column', canonicalName: `gone.${HOSTILE}` });
  const fresh = makeNode({ kind: 'Column', canonicalName: `fresh.${HOSTILE}` });
  const edge = (src: typeof kept, dst: typeof kept, confidence: number) =>
    makeEdge({ kind: 'MAPS_TO_FIELD', src: src.id, dst: dst.id, confidence });
  const snapA = {
    runId: 'a',
    run: makeRun('a', []),
    nodes: [kept, gone],
    edges: [edge(kept, gone, 0.9), edge(gone, kept, 0.9), edge(kept, kept, 0.9)],
    results: [],
  };
  const snapB = {
    runId: 'b',
    run: makeRun('b', []),
    nodes: [{ ...kept, path: HOSTILE }, fresh],
    edges: [edge(kept, fresh, 0.9), edge(kept, kept, 0.5)],
    results: [],
  };
  const d = baseDeps(dir, {
    snapshots: { read: (_o, ref) => Promise.resolve(ref.startsWith('from') ? snapA : snapB), write: () => Promise.resolve() },
  });
  await runCli(d, ['diff', `from-${HOSTILE}`, `to-${HOSTILE}`]);
  const out = d.io.stdout();
  assert.match(out, /NODES\s+\+1 -1 ~1/);
  assert.match(out, /EDGES\s+\+1 -2 ~1/);
  assertTerminalSafe(out, 'diff');

  const same = baseDeps(dir, {
    snapshots: { read: () => Promise.resolve(snapA), write: () => Promise.resolve() },
  });
  await runCli(same, ['diff', `from-${HOSTILE}`, `to-${HOSTILE}`]);
  assert.match(same.io.stdout(), /identical/);
  assertTerminalSafe(same.io.stdout(), 'diff identical');
});

test('conformance: the extractor name, property titles and evidence are escaped', () => {
  const text = renderConformance(
    {
      verdict: 'FAIL',
      extractor: { name: HOSTILE, version: '1.0.0' },
      properties: [
        { id: `P-${HOSTILE}`, title: 'TITLE-A', verdict: 'FAIL', evidence: [`evidence ${HOSTILE}`] },
        { id: 'P-short', title: 'TITLE-B', verdict: 'PASS', evidence: [] },
      ],
    } as unknown as Parameters<typeof renderConformance>[0],
    makeStyle(false),
  );
  assertTerminalSafe(text, 'conformance');
  const column = (title: string): number => (text.split('\n').find((l) => l.includes(title)) ?? '').indexOf(title);
  assert.equal(column('TITLE-A'), column('TITLE-B'), 'the escaped id, not the raw one, sets the column width');
  const titled = renderConformance(
    {
      verdict: 'PASS',
      extractor: null,
      properties: [{ id: 'P', title: `title ${HOSTILE}`, verdict: 'PASS', evidence: [] }],
    } as unknown as Parameters<typeof renderConformance>[0],
    makeStyle(false),
  );
  assertTerminalSafe(titled, 'conformance title');
});

test('extract: extractor names and diagnostics are escaped in the status table', async () => {
  const name = `extract-${HOSTILE}`;
  const dir = await repoWith({ ...defaultConfig('demo'), extractors: [{ name, enabled: true, options: {} }] });
  const extractor: ExtractorPort = {
    name,
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () =>
      Promise.resolve({
        result: makeResult(name, 'UNAVAILABLE', [`data-${HOSTILE}`], [`diag ${HOSTILE}`]),
        nodes: [],
        edges: [],
      }),
  };
  const d = baseDeps(dir, { store: memoryStorePort(memoryGraph()), extractors: [extractor] });
  await runCli(d, ['extract']);
  assertTerminalSafe(d.io.stdout(), 'extract');
});

test('extract: the run id, repo name and the diagnostics of a PASS are escaped', async () => {
  const name = 'extract-ok';
  const dir = await repoWith({ ...defaultConfig(`repo-${HOSTILE}`), extractors: [{ name, enabled: true, options: {} }] });
  const extractor: ExtractorPort = {
    name,
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () =>
      Promise.resolve({ result: makeResult(name, 'PASS', ['code'], [`note ${HOSTILE}`]), nodes: [], edges: [] }),
  };
  const d = baseDeps(dir, { store: memoryStorePort(memoryGraph()), extractors: [extractor] });
  d.clock.runId = () => `run-${HOSTILE}`;
  await runCli(d, ['extract']);
  assertTerminalSafe(d.io.stdout(), 'extract run header');
});

test('extract: the status table is aligned on the escaped extractor name, not the raw one', async () => {
  const names = [`extract-${HOSTILE}`, 'extract-b'];
  const dir = await repoWith({
    ...defaultConfig('demo'),
    extractors: names.map((name) => ({ name, enabled: true, options: {} })),
  });
  const extractors = names.map(
    (name): ExtractorPort => ({
      name,
      version: '0.0.1',
      provenanceCeiling: 'EXTRACTED',
      extract: () => Promise.resolve({ result: makeResult(name, 'PASS', [name]), nodes: [], edges: [] }),
    }),
  );
  const d = baseDeps(dir, { store: memoryStorePort(memoryGraph()), extractors });
  await runCli(d, ['extract']);
  const columns = d.io.stdout().split('\n').filter((l) => l.startsWith('PASS')).map((l) => l.indexOf(' nodes'));
  assert.equal(columns.length, 2);
  assert.equal(columns[0], columns[1], d.io.stdout());
});

test('extract: the "no extractor selected" error lists configured names escaped', async () => {
  const dir = await repoWith({ ...defaultConfig('demo'), extractors: [{ name: `e-${HOSTILE}`, enabled: true, options: {} }] });
  const d = baseDeps(dir, { store: memoryStorePort(memoryGraph()), extractors: [] });
  await runCli(d, ['extract', '--only', 'nothing']);
  assertTerminalSafe(d.io.stderr(), 'extract none selected');
});

test('export --list-profiles: a profile description is escaped', async () => {
  const bidi = '\u202Eevil\u200BZW\u2028SEP';
  const profile = (await import('@seamline/core')).parseExportProfile({
    version: 1,
    name: 'p',
    description: `desc ${bidi}`,
    allow: [['File', 'internal']],
    allowEdges: [],
    allowProps: { File: [`prop ${HOSTILE}`] },
    allowEdgeProps: {},
    allowFields: ['id', 'props'],
    allowProvenance: ['EXTRACTED'],
    includeUntrusted: false,
  });
  const dir = await repoWith({ ...defaultConfig('demo'), exportProfiles: { p: profile } });
  const d = baseDeps(dir, { store: memoryStorePort(memoryGraph()) });
  const code = await runCli(d, ['export', '--list-profiles']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  assert.match(d.io.stdout(), /desc \\u202eevil\\u200bZW\\u2028SEP/);
  assertTerminalSafe(d.io.stdout(), 'export --list-profiles');
});

test('export --out: the written path in the confirmation is escaped', async () => {
  const dir = await repoWith();
  const d = baseDeps(dir, { store: memoryStorePort(memoryGraph()) });
  const code = await runCli(d, ['export', '--profile', 'structure', '--out', `out-${HOSTILE}.json`]);
  assert.equal(code, EXIT_OK, d.io.stderr());
  assert.match(d.io.stdout(), /^wrote .*out-x\\x1b\[31mRED/);
  assertTerminalSafe(d.io.stdout(), 'export --out');
});

test('errors: a message built from an argument and a multi-line hint are escaped', async () => {
  const dir = await repoWith();
  const d = baseDeps(dir);
  await runCli(d, ['diff', HOSTILE]);
  assert.doesNotMatch(d.io.stderr(), UNSAFE_OUTPUT);

  const unknown = baseDeps(dir);
  await runCli(unknown, [HOSTILE]);
  assertTerminalSafe(unknown.io.stderr(), 'unknown command');

  const flag = baseDeps(dir);
  await runCli(flag, ['check', '--severity', HOSTILE]);
  assert.doesNotMatch(flag.io.stderr(), UNSAFE_OUTPUT);

  const baseline = baseDeps(dir, { align: { run: () => Promise.resolve() }, store: memoryStorePort(memoryGraph()) });
  await runCli(baseline, ['align', '--baseline', `missing-${HOSTILE}`]);
  assertTerminalSafe(baseline.io.stderr(), 'align baseline error');
});

test('errors with --json keep the message exactly as JSON encodes it', async () => {
  const dir = await repoWith();
  const align: AlignPort = { run: () => Promise.resolve() };
  const d = baseDeps(dir, { align, store: memoryStorePort(memoryGraph()) });
  await runCli(d, ['align', '--json', '--baseline', `missing-${HOSTILE}`]);
  const body = JSON.parse(d.io.stderr()) as { error: string };
  assert.ok(body.error.includes(HOSTILE));
});

test('align: the human summary reaches stdout escaped; --json and a packet on stdout are not touched', async () => {
  const dir = await repoWith({ ...defaultConfig('demo') });
  const raw = 'finding x\u001b]0;pwned\u0007\u009b2J\u202eevil\n';
  const align: AlignPort = {
    run: (_req, sink) => {
      sink.stdout(raw);
      return Promise.resolve();
    },
  };
  const text = baseDeps(dir, { align, store: memoryStorePort(memoryGraph()) });
  await runCli(text, ['align']);
  assert.equal(text.io.stdout(), 'finding x\\x1b]0;pwned\\x07\\x9b2J\\u202eevil\n');

  const json = baseDeps(dir, { align, store: memoryStorePort(memoryGraph()) });
  await runCli(json, ['align', '--json']);
  assert.equal(json.io.stdout(), raw, '--json output is passed through byte for byte');
});

test('errors: a hint, a non-CLI error and a debug stack are escaped', async () => {
  const dir = await repoWith();
  const hint = baseDeps(dir, {
    store: { open: () => Promise.reject(new CliError('failed', EXIT_RUNTIME, `try ${HOSTILE_ONE_LINE}`)) },
    detectors: detectorsOf({ contradictions: [], unknown: [] }),
  });
  await runCli(hint, ['check']);
  assert.doesNotMatch(hint.io.stderr(), UNSAFE_OUTPUT);
  assert.match(hint.io.stderr(), /try x\\x1b\[31mRED/);

  const failure = new Error(`boom ${HOSTILE}`);
  const plain = baseDeps(dir, {
    store: { open: () => Promise.reject(failure) },
    detectors: detectorsOf({ contradictions: [], unknown: [] }),
  });
  await runCli(plain, ['check']);
  assertTerminalSafe(plain.io.stderr(), 'non-CLI error');

  const debug = baseDeps(
    dir,
    { store: { open: () => Promise.reject(failure) }, detectors: detectorsOf({ contradictions: [], unknown: [] }) },
    { SEAMLINE_DEBUG: '1' },
  );
  await runCli(debug, ['check']);
  assert.match(debug.io.stderr(), /at /, 'the stack is shown');
  assert.doesNotMatch(debug.io.stderr(), UNSAFE_OUTPUT);
});

test('mcp: an internal-error log line on stderr is escaped', async () => {
  const dir = await repoWith();
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'contradictions', arguments: {} } },
  ];
  const d = baseDeps(dir, {
    store: memoryStorePort(memoryGraph()),
    detectors: { run: () => Promise.reject(new Error(`cannot read ${HOSTILE}`)) },
    input: () =>
      (async function* () {
        for (const f of frames) yield `${JSON.stringify(f)}\n`;
      })(),
  });
  await runCli(d, ['mcp', '--profile', 'public']);
  assert.match(d.io.stderr(), /cannot read/);
  assertTerminalSafe(d.io.stderr(), 'mcp log');
});

test('emitText and emitTextErr escape what a renderer forgot, and keep only our own colour codes', () => {
  const raw = 'a\u001b]0;t\u0007b \u001b[31mc\u001b[0m \u009b2J';
  for (const [enabled, expected] of [
    [false, 'a\\x1b]0;t\\x07b \\x1b[31mc\\x1b[0m \\x9b2J'],
    [true, 'a\\x1b]0;t\\x07b \u001b[31mc\u001b[0m \\x9b2J'],
  ] as const) {
    const io = bufferIo({ isTty: false, env: {} });
    emitText(io, makeStyle(enabled), raw);
    emitTextErr(io, makeStyle(enabled), raw);
    assert.equal(io.stdout(), expected, `stdout, colour ${enabled}`);
    assert.equal(io.stderr(), expected, `stderr, colour ${enabled}`);
  }
});
