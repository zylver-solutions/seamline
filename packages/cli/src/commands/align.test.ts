import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ExtractorResult, GraphView, NodeId, Provenance, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { alignPort, factsFromSif, factsFromStore, graphParts } from '../align-port.ts';
import { parseExportProfile, writeSif } from '@seamline/core';
import { buildScopeTable } from '@seamline/align';
import { CONFIG_FILENAME, defaultConfig, serializeConfig, type ExportProfile } from '../config.ts';
import { bufferIo, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from '../io.ts';
import type { AlignPort, CliDeps, DetectionReport } from '../ports.ts';
import { runCli } from '../run.ts';
import { serializeSif } from '../sif.ts';
import { makeResult, makeRun, memoryGraph, memoryStorePort } from '../testing.ts';

const CANARY = `ghp_${'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5'}`;

test('alignment preserves an omitted UNAVAILABLE result from the primary SIF run', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-sif-primary-'));
  const authority = [{ scope: 'code.ts', kinds: ['File'] as const, selector: 'src/**' }];
  const good = { ...makeResult('good', 'PASS', ['code.ts']), authoritative: authority };
  const blind = { ...makeResult('blind', 'UNAVAILABLE', ['code.ts']), authoritative: authority };
  const run = makeRun('run-primary', [good, blind]);
  const file = path.join(dir, 'facts.sif');
  await writeFile(file, writeSif([{ t: 'run', run }, { t: 'status', result: good }]), 'utf8');
  const facts = await factsFromSif(file);
  assert.deepEqual(facts.runs[0]?.results, [good, blind]);
  assert.equal(buildScopeTable(facts.runs).get('code.ts')?.status, 'UNAVAILABLE');
});

test('alignment grants no authority to missing, unfinished or blank completion metadata', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-sif-completion-'));
  const result = { ...makeResult('code', 'PASS', ['code.ts']), authoritative: [{ scope: 'code.ts', kinds: ['File'] as const }] };
  const completed = makeRun('run-completion', [result]);
  const file = path.join(dir, 'facts.sif');
  await writeFile(file, writeSif([{ t: 'run', run: completed }]), 'utf8');
  assert.equal(buildScopeTable((await factsFromSif(file)).runs).get('code.ts')?.status, 'PASS', 'completed primary metadata is a positive control');
  for (const finishedAt of [null, '', '   ']) {
    await writeFile(file, writeSif([{ t: 'run', run: { ...completed, finishedAt } }, { t: 'status', result }]), 'utf8');
    const facts = await factsFromSif(file);
    assert.deepEqual(facts.runs[0]?.results, []);
    assert.equal(buildScopeTable(facts.runs).size, 0, 'no scope can PASS without completion');
  }
  await writeFile(file, JSON.stringify({ t: 'sif', version: '1.0.0', runId: 'legacy' }) + '\n' + JSON.stringify({ t: 'status', result }) + '\n', 'utf8');
  assert.equal(buildScopeTable((await factsFromSif(file)).runs).size, 0, 'legacy diff readability cannot invent completed authority');
  const graph = memoryGraph({ runs: [{ ...completed, runId: 'run-newest', finishedAt: null, results: [] }, completed] });
  const workspace = await memoryStorePort(graph).open({ repoRoot: dir, outDir: dir, repo: 'demo', create: false });
  assert.equal(buildScopeTable((await factsFromStore(workspace)).runs).size, 0, 'an unfinished store run cannot certify raw upserts using older PASS metadata');
  await workspace.store.close();
  const finishedWorkspace = await memoryStorePort(memoryGraph({ runs: [completed] })).open({ repoRoot: dir, outDir: dir, repo: 'demo', create: false });
  assert.equal(buildScopeTable((await factsFromStore(finishedWorkspace)).runs).get('code.ts')?.status, 'PASS', 'completed store metadata remains a positive control');
  await finishedWorkspace.store.close();
});
const DECLARED = {
  version: 1,
  description: 'alignment packets',
  allow: [
    ['File', 'internal'],
    ['Symbol', 'internal'],
  ],
  allowEdges: [],
  allowProps: {},
  allowEdgeProps: {},
  allowFields: ['id'],
  allowProvenance: ['EXTRACTED'],
  includeUntrusted: false,
};
const profile = (name: string, over: Record<string, unknown>): ExportProfile =>
  parseExportProfile({ ...DECLARED, name, ...over });
const PROFILE = profile('align-ok', { packets: ['alignment'] });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );

const DRIFT_DOCS = {
  'README.md': 'Output is JSON, CSV, and Mermaid from the CLI.\n',
  'docs/toolchain.md': '- **Node >= 20.1** is required.\n',
};
const FIXED_DOCS = {
  'README.md': 'CSV and Mermaid output are not implemented.\n',
  'docs/toolchain.md': '- **Node >= 20.3** is required.\n',
};

/** A git repository with a CLI package, the given docs, a config with profiles, and a SIF snapshot. */
async function repo(
  docs: Record<string, string> = DRIFT_DOCS,
  extra: Record<string, string> = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-align-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 't', private: true, engines: { node: '>=20.3.0' } }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'packages/cli/package.json': JSON.stringify({ name: '@t/cli', bin: { t: './dist/bin.js' } }),
    'packages/cli/src/bin.ts': "export const OPTIONS = { json: { type: 'boolean' } };\n",
    [CONFIG_FILENAME]: serializeConfig({
      ...defaultConfig('t'),
      exportProfiles: {
        'align-ok': PROFILE,
        'no-packets': profile('no-packets', {}),
        'too-low': profile('too-low', { packets: ['alignment'], allow: [['File', 'public']] }),
        'no-symbol': profile('no-symbol', {
          packets: ['alignment'],
          allow: [['File', 'internal']],
        }),
        'wrong-kind': profile('wrong-kind', {
          packets: ['alignment'],
          allow: [['Module', 'internal']],
        }),
      },
    }),
    ...docs,
    ...extra,
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text, 'utf8');
  }
  const snapshotResults: readonly ExtractorResult[] = [
    {
      ...makeResult('extract-code-ts', 'PASS', ['code.ts']),
      authoritative: [{ scope: 'code.ts', kinds: ['File', 'Symbol'] }],
    },
    {
      ...makeResult('extract-data', 'PASS', ['data']),
      authoritative: [{ scope: 'data', kinds: ['Column'] }],
    },
  ];
  await writeFile(
    path.join(dir, 'snapshot.sif'),
    serializeSif({
      runId: 'run-snapshot',
      run: makeRun('run-snapshot', snapshotResults),
      nodes: [],
      edges: [],
      results: snapshotResults,
    }),
    'utf8',
  );
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'one');
  return dir;
}

function deps(
  cwd: string,
  over: Omit<Partial<CliDeps>, 'io'> = {},
): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env: {} });
  return {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(
      memoryGraph({
        runs: [makeRun('run-store', [makeResult('extract-code-ts', 'PASS', ['code.ts'])])],
      }),
    ),
    align: alignPort(),
    ...over,
  };
}

async function align(
  dir: string,
  argv: string[],
  over: Omit<Partial<CliDeps>, 'io'> = {},
): Promise<{ code: number; out: string; err: string }> {
  const d = deps(dir, over);
  const code = await runCli(d, ['align', '--facts', 'snapshot.sif', ...argv]);
  return { code, out: d.io.stdout(), err: d.io.stderr() };
}

test('align exits 0 on a repository with every kind of drift, and prints the summary', async () => {
  const dir = await repo();
  const r = await align(dir, []);
  assert.equal(r.code, EXIT_OK, r.err);
  assert.match(r.out, /Observed drift\s+1/);
  assert.match(r.out, /Unexplained gap\s+2/);
  assert.match(r.out, /pairing asserted/);
  assert.match(
    r.out,
    /Pass --profile <name> with a profile that allows packets: \["alignment"\] to emit the finding packet\./,
    'with no packet written, the summary says how to get one',
  );
});

test('align --json without a profile prints only the summary object', async () => {
  const dir = await repo();
  const r = await align(dir, ['--json']);
  assert.equal(r.code, EXIT_OK);
  const summary = JSON.parse(r.out) as {
    schema: string;
    classes: Record<string, number>;
    findings: Record<string, unknown>[];
  };
  assert.equal(summary.schema, 'seamline.alignment-summary');
  assert.equal(summary.classes['Observed drift'], 1);
  assert.deepEqual(Object.keys(summary.findings[0] ?? {}), [
    'claimKind',
    'class',
    'id',
    'member',
    'reason',
  ]);
  assert.ok(!r.out.includes('docs/toolchain.md') && !r.out.includes('excerpt'));
});

test('a profile that opts in emits the packet to stdout', async () => {
  const dir = await repo();
  const stdout = await align(dir, ['--profile', 'align-ok']);
  assert.equal(stdout.code, EXIT_OK, stdout.err);
  const packet = JSON.parse(stdout.out) as {
    schema: string;
    schemaVersion: number;
    findings: { id: string; class: string }[];
    run: { pairing: string; facts: { source: string }; commit: unknown };
  };
  assert.equal(packet.schema, 'seamline.alignment-packet');
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.run.pairing, 'asserted');
  assert.equal(packet.run.facts.source, 'sif');
  assert.equal(packet.run.commit, null);
  assert.ok(
    packet.findings.some(
      (f) => f.id === 't:align:RUNTIME_FLOOR:runtime:node' && f.class === 'Observed drift',
    ),
  );
});

test('--packet writes the packet where it is told; stdout carries the summary', async () => {
  const dir = await repo();
  await mkdir(path.join(dir, 'out'));
  const r = await align(dir, ['--profile', 'align-ok', '--packet', 'out/packet.json']);
  assert.equal(r.code, EXIT_OK, r.err);
  assert.match(r.out, /Observed drift/);
  assert.doesNotMatch(
    r.out,
    /to emit the finding packet/,
    'a run that wrote the packet does not tell the reader to emit it',
  );
  const written = await readFile(path.join(dir, 'out', 'packet.json'), 'utf8');
  assert.ok(written.endsWith('}\n'));
  assert.equal((JSON.parse(written) as { schema: string }).schema, 'seamline.alignment-packet');
});

test('refusals are usage errors and write nothing: --packet without --profile, a profile without packets, a profile below the packet sensitivity, an unknown profile', async () => {
  const dir = await repo();
  const before = readdirSync(dir).sort();
  const cases: [string[], RegExp][] = [
    [['--packet', 'p.json'], /--packet needs --profile/],
    [['--profile', 'no-packets'], /does not allow the alignment packet/],
    [['--profile', 'no-packets', '--packet', 'p.json'], /does not allow the alignment packet/],
    [['--profile', 'too-low', '--packet', 'p.json'], /does not admit \(File, internal\)/],
    [['--profile', 'no-symbol', '--packet', 'p.json'], /does not admit \(Symbol, internal\)/],
    [['--profile', 'wrong-kind', '--packet', 'p.json'], /does not admit \(File, internal\)/],
    [['--profile', 'nope'], /no export profile named `nope`/],
    [['--at', 'main', '--worktree'], /alternatives/],
    [['--at', 'no-such-revision'], /unknown revision/],
  ];
  for (const [argv, pattern] of cases) {
    const r = await align(dir, argv);
    assert.equal(r.code, EXIT_USAGE, argv.join(' '));
    assert.match(r.err, pattern, argv.join(' '));
    assert.equal(r.out, '', `${argv.join(' ')} wrote to stdout`);
  }
  assert.deepEqual(readdirSync(dir).sort(), before, 'nothing was written');
  assert.ok(!existsSync(path.join(dir, 'p.json')));
});

test('an unreadable facts file is a runtime error (3); a baseline that does not verify is a usage error (2)', async () => {
  const dir = await repo();
  const d = deps(dir);
  assert.equal(await runCli(d, ['align', '--facts', 'missing.sif']), EXIT_RUNTIME);
  assert.match(d.io.stderr(), /cannot read the facts file/);
  await writeFile(path.join(dir, 'broken.sif'), 'not jsonl\n', 'utf8');
  const e = deps(dir);
  assert.equal(await runCli(e, ['align', '--facts', 'broken.sif']), EXIT_RUNTIME);

  await mkdir(path.join(dir, 'b'), { recursive: true });
  const good = await align(dir, ['--profile', 'align-ok', '--packet', 'b/base.json']);
  assert.equal(good.code, EXIT_OK, good.err);
  const text = await readFile(path.join(dir, 'b', 'base.json'), 'utf8');
  await writeFile(
    path.join(dir, 'b', 'tampered.json'),
    text.replace('"Unexplained gap"', '"Planned gap"'),
    'utf8',
  );
  const tampered = await align(dir, ['--baseline', 'b/tampered.json']);
  assert.equal(tampered.code, EXIT_USAGE);
  assert.match(tampered.err, /digest does not verify/);
  const missing = await align(dir, ['--baseline', 'b/none.json']);
  assert.equal(missing.code, EXIT_USAGE);
});

test('a credential in a document path refuses the packet: exit 3, the credential is never printed, nothing is written', async () => {
  const dir = await repo(DRIFT_DOCS, { [`docs/${CANARY}.md`]: 'text\n' });
  const r = await align(dir, ['--profile', 'align-ok', '--packet', 'p.json']);
  assert.equal(r.code, EXIT_RUNTIME);
  assert.ok(!r.err.includes(CANARY) && !r.out.includes(CANARY));
  assert.match(r.err, /inputs\.docs\[\]\.path/);
  assert.ok(!existsSync(path.join(dir, 'p.json')));
  assert.equal(r.out, '');
});

test('--baseline reports Resolved records once the documents are corrected, byte-reproducibly', async () => {
  const dir = await repo();
  await mkdir(path.join(dir, 'b'));
  const first = await align(dir, ['--profile', 'align-ok', '--packet', 'b/base.json']);
  assert.equal(first.code, EXIT_OK, first.err);
  const again = await align(dir, ['--profile', 'align-ok', '--packet', 'b/again.json']);
  assert.equal(again.code, EXIT_OK);
  assert.equal(
    await readFile(path.join(dir, 'b', 'again.json'), 'utf8'),
    await readFile(path.join(dir, 'b', 'base.json'), 'utf8'),
    'two runs on the same inputs are byte-identical',
  );

  for (const [file, text] of Object.entries(FIXED_DOCS))
    await writeFile(path.join(dir, file), text, 'utf8');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fix docs');
  const head = await align(dir, ['--profile', 'align-ok', '--baseline', 'b/base.json']);
  assert.equal(head.code, EXIT_OK, head.err);
  const packet = JSON.parse(head.out) as {
    baseline: { digest: string };
    findings: { id: string; class: string; resolved: { by: string } | null }[];
  };
  const resolved = Object.fromEntries(
    packet.findings
      .filter((f) => f.class === 'Resolved')
      .map((f) => [f.id.slice('t:align:'.length), f.resolved?.by]),
  );
  assert.deepEqual(resolved, {
    'OUTPUT_FORMAT_SET:cli:output-format:csv': 'claim-corrected',
    'OUTPUT_FORMAT_SET:cli:output-format:mermaid': 'claim-corrected',
    'RUNTIME_FLOOR:runtime:node': 'claim-corrected',
  });
  assert.match(packet.baseline.digest, /^sha256:/);

  // --at evaluates the earlier commit, whatever the working tree holds.
  const old = await align(dir, ['--at', 'HEAD~1', '--profile', 'align-ok']);
  assert.equal(
    (JSON.parse(old.out) as { findings: { class: string }[] }).findings.filter(
      (f) => f.class === 'Unexplained gap',
    ).length,
    2,
  );
});

test('--worktree evaluates the working tree and records it', async () => {
  const dir = await repo();
  await writeFile(path.join(dir, 'docs/toolchain.md'), '- **Node >= 20.3** is required.\n', 'utf8');
  const r = await align(dir, ['--worktree', '--profile', 'align-ok']);
  assert.equal(r.code, EXIT_OK, r.err);
  const packet = JSON.parse(r.out) as {
    subject: { commit: unknown; worktree: boolean };
    findings: { id: string }[];
  };
  assert.deepEqual(packet.subject, { commit: null, worktree: true });
  assert.ok(!packet.findings.some((f) => f.id.endsWith('runtime:node')));
});

test('without --facts the store is the facts source, and its absence is reported, not hidden', async () => {
  const dir = await repo();
  const seen: string[] = [];
  const port: AlignPort = {
    run: (request, sink) => {
      seen.push(request.facts.kind);
      sink.stdout('ok\n');
      return Promise.resolve();
    },
  };
  const d = deps(dir, { align: port });
  assert.equal(await runCli(d, ['align']), EXIT_OK);
  assert.deepEqual(seen, ['store']);
  const noStore = deps(dir, { align: port });
  const withoutStore: CliDeps = { io: noStore.io, clock: noStore.clock, align: port };
  assert.equal(await runCli(withoutStore, ['align']), EXIT_RUNTIME);
  assert.match(noStore.io.stderr(), /needs a store/);
});

test('an unwired alignment port is an actionable runtime error', async () => {
  const dir = await repo();
  const d = deps(dir);
  const bare: CliDeps = { io: d.io, clock: d.clock, store: d.store as never };
  assert.equal(await runCli(bare, ['align', '--facts', 'snapshot.sif']), EXIT_RUNTIME);
  assert.match(d.io.stderr(), /alignment report/);
});

test('align reads the store through the real adapter: runs newest first, File nodes and IMPORTS edges', async () => {
  const dir = await repo();
  const graph = memoryGraph({
    runs: [
      makeRun('run-store', [
        {
          ...makeResult('extract-code-ts', 'PASS', ['code.ts']),
          authoritative: [{ scope: 'code.ts', kinds: ['File', 'Symbol'] }],
        },
      ]),
    ],
  });
  const d = deps(dir, { store: memoryStorePort(graph) });
  const code = await runCli(d, ['align', '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  assert.equal(
    (JSON.parse(d.io.stdout()) as { schema: string }).schema,
    'seamline.alignment-summary',
  );
});

test('only facts reach the probes: INFERRED and LLM_SUGGESTED File, Symbol and IMPORTS records are dropped', () => {
  const node = (
    id: string,
    kind: 'File' | 'Symbol',
    p: string,
    provenance: Provenance,
  ): SeamlineNode => ({
    id: id as NodeId,
    kind,
    name: p,
    path: p,
    sensitivity: 'internal',
    provenance,
    confidence: 1,
    props: {},
    firstSeenRun: 'r',
    lastSeenRun: 'r',
    deletedAt: null,
  });
  const edge = (src: string, dst: string, provenance: Provenance): SeamlineEdge => ({
    kind: 'IMPORTS',
    src: src as NodeId,
    dst: dst as NodeId,
    provenance,
    confidence: 1,
    props: {},
    firstSeenRun: 'r',
    lastSeenRun: 'r',
    deletedAt: null,
  });
  const nodes = [
    node('t:File:a', 'File', 'src/a.ts', 'EXTRACTED'),
    node('t:File:b', 'File', 'src/b.ts', 'DECLARED'),
    node('t:File:inf', 'File', 'src/inferred.ts', 'INFERRED'),
    node('t:File:llm', 'File', 'src/llm.ts', 'LLM_SUGGESTED'),
    node('t:Symbol:s', 'Symbol', 'src/a.ts', 'EXTRACTED'),
    node('t:Symbol:inf', 'Symbol', 'src/ghost.ts', 'INFERRED'),
    node('t:Symbol:llm', 'Symbol', 'src/ghost2.ts', 'LLM_SUGGESTED'),
  ];
  const edges = [
    edge('t:File:a', 't:File:b', 'EXTRACTED'),
    edge('t:File:b', 't:File:a', 'INFERRED'),
    edge('t:File:a', 't:File:b', 'LLM_SUGGESTED'),
  ];
  const parts = graphParts(nodes, edges);
  assert.deepEqual(parts.files, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(parts.symbolPaths, ['src/a.ts']);
  assert.deepEqual(parts.imports, [{ src: 'src/a.ts', dst: 'src/b.ts', reExport: false }]);
});

// ---------------------------------------------------------------------------
// Drift never gates (ADR-0014 section 3)
// ---------------------------------------------------------------------------

const REPORT: DetectionReport = { contradictions: [], unknown: [] };

async function checkOn(
  dir: string,
): Promise<{ code: number; out: string; err: string; json: string }> {
  const d = deps(dir, { detectors: { run: (_view: GraphView) => Promise.resolve(REPORT) } });
  const code = await runCli(d, ['check']);
  const j = deps(dir, { detectors: { run: (_view: GraphView) => Promise.resolve(REPORT) } });
  await runCli(j, ['check', '--json']);
  return { code, out: d.io.stdout(), err: d.io.stderr(), json: j.io.stdout() };
}

test('seamline check output and exit code are byte-identical with and without drift in the documents', async () => {
  const drifting = await repo(DRIFT_DOCS);
  const clean = await repo(FIXED_DOCS);
  const withDrift = await checkOn(drifting);
  const without = await checkOn(clean);
  assert.deepEqual(withDrift, without);
  assert.equal(withDrift.code, EXIT_OK);
  assert.match(withDrift.out, /CLEAN|UNKNOWN/);
  // and align on the drifting repository has found the drift while exiting 0
  const found = await align(drifting, ['--json']);
  assert.equal(found.code, EXIT_OK);
  assert.ok(
    (JSON.parse(found.out) as { classes: Record<string, number> }).classes['Observed drift']! >= 1,
  );
});

test('no flag, environment variable or configuration key makes drift fail', async () => {
  const dir = await repo();
  for (const argv of [['--strict'], ['--fail-on-drift'], ['--exit-code']]) {
    const r = await align(dir, argv);
    assert.equal(r.code, EXIT_USAGE, argv.join(' '));
  }
  const io = bufferIo({
    cwd: dir,
    isTty: false,
    env: {
      SEAMLINE_STRICT: '1',
      SEAMLINE_FAIL_ON_DRIFT: '1',
      CI: 'true',
      SEAMLINE_ALIGN_STRICT: '1',
    },
  });
  const d: CliDeps = { ...deps(dir), io };
  assert.equal(await runCli(d, ['align', '--facts', 'snapshot.sif']), EXIT_OK);
  const here = fileURLToPath(new URL('.', import.meta.url));
  const source = readFileSync(path.join(here, 'align.ts'), 'utf8');
  assert.deepEqual(
    [...source.matchAll(/return (EXIT_\w+)/g)].map((m) => m[1]),
    ['EXIT_OK'],
    'the command returns one exit code',
  );
});

test('only the align command and its adapter import @seamline/align: no pipeline stage does', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  const importers = (readdirSync(src, { recursive: true }) as string[])
    .map(String)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => /from '@seamline\/align'/.test(readFileSync(path.join(src, f), 'utf8')))
    .sort();
  assert.deepEqual(importers, ['align-port.ts', path.join('commands', 'align.ts')]);
});
