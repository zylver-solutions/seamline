/**
 * Selecting the store a command reads (`--store`), end to end.
 *
 * The scenario is the one that cannot be expressed with `--out` alone: two
 * stores on disk, one at the config's `outDir` and one elsewhere, and a reading
 * command that has to be pointed at the second. Every test runs the real
 * `StorePort` (SQLite on disk) and the real snapshot port, with a fixture
 * extractor whose output names the store it was written into. That makes every
 * assertion about content that exists in exactly one of the two stores, so a
 * command that read the wrong store cannot pass by accident.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Contradiction } from '@seamline/ontology';
import { COMMAND_HELP, COMMANDS, HELP_TEXT, type Command } from '../args.ts';
import { parseExportProfile } from '@seamline/core';
import { CONFIG_FILENAME, defaultConfig, serializeConfig, type ExportProfile } from '../config.ts';
import { bufferIo, EXIT_OK, EXIT_USAGE } from '../io.ts';
import type { CliDeps, DetectorRunnerPort, ExtractorPort } from '../ports.ts';
import { runCli } from '../run.ts';
import { fileSnapshots } from '../sif.ts';
import { fakeGitPort, makeNode, makeResult } from '../testing.ts';
import { sqliteStorePort } from '../wiring.ts';
import type { BlastRadiusReport } from './blast-radius.ts';
import type { CheckReport } from './check.ts';
import type { DiffReport } from './diff.ts';
import type { WhyReport } from './why.ts';

const ALPHA = 'alpha';
const OMEGA = 'omega';

const columnId = (label: string): string => `demo:Column:public.${label}.id`;
const fileId = (label: string): string => `demo:File:src/${label}.ts`;

/** Everything a profile may name, so an export shows the whole fixture. */
const sliceProfile: ExportProfile = parseExportProfile({
  version: 1,
  name: 'slice',
  description: 'fixture',
  allow: [
    ['Column', 'confidential'],
    ['File', 'internal'],
  ],
  allowEdges: [],
  allowProps: {},
  allowEdgeProps: {},
  allowFields: ['id', 'kind', 'name', 'path'],
  allowProvenance: ['EXTRACTED'],
  includeUntrusted: false,
});

/** One File and one Column, both named after `label`, so a store's content says which run wrote it. */
function labelledExtractor(label: string): ExtractorPort {
  return {
    name: 'fixture',
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () =>
      Promise.resolve({
        result: makeResult('fixture', 'PASS', ['code']),
        nodes: [
          makeNode({ kind: 'File', canonicalName: `src/${label}.ts`, path: `src/${label}.ts` }),
          makeNode({
            kind: 'Column',
            canonicalName: `public.${label}.id`,
            path: `db/${label}.sql`,
          }),
        ],
        edges: [],
      }),
  };
}

/** Raises one finding per File in whatever store it is handed, so the finding names the store. */
const perFileDetector: DetectorRunnerPort = {
  run: (view) =>
    Promise.resolve({
      contradictions: view.nodesByKind('File').map((f): Contradiction => ({
        code: 'X1_NULLABILITY',
        severity: 'medium',
        left: f.id,
        right: f.id,
        claim: `finding about ${f.id}`,
        leftFact: 'left',
        rightFact: 'right',
        viaPath: [],
        confidence: 1,
      })),
      unknown: [],
    }),
};

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Invocation {
  /** What the fixture extractor writes, and the run id it is recorded under. */
  readonly label?: string;
  /** The process working directory; defaults to the repository root. */
  readonly cwd?: string;
  /** JSON-RPC frames for `seamline mcp`. */
  readonly frames?: readonly unknown[];
}

async function cli(repo: string, argv: readonly string[], inv: Invocation = {}): Promise<Result> {
  const label = inv.label ?? ALPHA;
  const io = bufferIo({ cwd: inv.cwd ?? repo, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const lines = (inv.frames ?? []).map((f) => `${JSON.stringify(f)}\n`);
  const deps: CliDeps = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => `run-${label}` },
    store: sqliteStorePort(),
    extractors: [labelledExtractor(label)],
    detectors: perFileDetector,
    snapshots: fileSnapshots(),
    git: fakeGitPort([]),
    // `align` reads the store it was pointed at; the fake proves which store that was.
    align: {
      run: (request, sink) => {
        sink.stdout(request.facts.kind === 'store' ? `${request.facts.workspace.store.nodesByKind('Column').length} columns\n` : 'sif\n');
        return Promise.resolve();
      },
    },
    input: () =>
      (async function* () {
        for (const line of lines) yield line;
      })(),
  };
  const code = await runCli(deps, argv);
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

/**
 * A repository holding two stores: `storeA` (written with `extract --out`, the
 * spelling that exists today) with ALPHA content, and the config's default
 * `seamline-out` with OMEGA content.
 */
async function twoStores(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'seamline-store-'));
  const config = {
    ...defaultConfig('demo'),
    extractors: [{ name: 'fixture', enabled: true, options: {} }],
    exportProfiles: { slice: sliceProfile },
  };
  await writeFile(path.join(repo, CONFIG_FILENAME), serializeConfig(config), 'utf8');

  const a = await cli(repo, ['extract', '--out', 'storeA'], { label: ALPHA });
  assert.equal(a.code, EXIT_OK, a.stderr);
  const b = await cli(repo, ['extract'], { label: OMEGA });
  assert.equal(b.code, EXIT_OK, b.stderr);
  return repo;
}

async function exportedIds(repo: string, rel: string): Promise<string[]> {
  const doc = JSON.parse(await readFile(path.join(repo, rel), 'utf8')) as {
    nodes: Array<{ id: string }>;
  };
  return doc.nodes.map((n) => n.id).sort();
}

// ---------------------------------------------------------------------------
// The issue's repro
// ---------------------------------------------------------------------------

test('export --store reads the named store, not the config outDir, and --out stays the destination file', async () => {
  const repo = await twoStores();

  const r = await cli(repo, [
    'export',
    '--store',
    'storeA',
    '--profile',
    'slice',
    '--out',
    'slice.json',
  ]);
  assert.equal(r.code, EXIT_OK, r.stderr);

  assert.deepEqual(
    await exportedIds(repo, 'slice.json'),
    [columnId(ALPHA), fileId(ALPHA)],
    'the slice holds what exists only in storeA',
  );
  assert.ok(
    !existsSync(path.join(repo, 'storeA', 'slice.json')),
    '--out is a file, never the store directory',
  );
});

test('export without --store still reads the config outDir (behaviour unchanged)', async () => {
  const repo = await twoStores();

  const r = await cli(repo, ['export', '--profile', 'slice', '--out', 'default.json']);
  assert.equal(r.code, EXIT_OK, r.stderr);
  assert.deepEqual(await exportedIds(repo, 'default.json'), [columnId(OMEGA), fileId(OMEGA)]);
});

test('export --out alone is still only the destination: it never selects the store', async () => {
  const repo = await twoStores();

  // `storeA` is a valid store directory, but as an export destination it is just a path.
  const r = await cli(repo, ['export', '--profile', 'slice', '--out', 'storeA/exported.json']);
  assert.equal(r.code, EXIT_OK, r.stderr);
  assert.deepEqual(await exportedIds(repo, 'storeA/exported.json'), [
    columnId(OMEGA),
    fileId(OMEGA),
  ]);
});

test("export --store without --out prints the selected store's slice on stdout", async () => {
  const repo = await twoStores();

  const r = await cli(repo, ['export', '--store=storeA', '--profile', 'slice']);
  assert.equal(r.code, EXIT_OK, r.stderr);
  const doc = JSON.parse(r.stdout) as { nodes: Array<{ id: string }> };
  assert.deepEqual(doc.nodes.map((n) => n.id).sort(), [columnId(ALPHA), fileId(ALPHA)]);
});

test('--store accepts an absolute path and a path before the command', async () => {
  const repo = await twoStores();

  const r = await cli(repo, ['--store', path.join(repo, 'storeA'), 'export', '--profile', 'slice']);
  assert.equal(r.code, EXIT_OK, r.stderr);
  const doc = JSON.parse(r.stdout) as { nodes: Array<{ id: string }> };
  assert.deepEqual(doc.nodes.map((n) => n.id).sort(), [columnId(ALPHA), fileId(ALPHA)]);
});

test('a relative --store resolves against --repo, not the process working directory', async () => {
  const repo = await twoStores();
  const elsewhere = await mkdtemp(path.join(tmpdir(), 'seamline-store-cwd-'));

  const r = await cli(repo, ['export', '--repo', repo, '--store', 'storeA', '--profile', 'slice'], {
    cwd: elsewhere,
  });
  assert.equal(r.code, EXIT_OK, r.stderr);
  const doc = JSON.parse(r.stdout) as { nodes: Array<{ id: string }> };
  assert.deepEqual(doc.nodes.map((n) => n.id).sort(), [columnId(ALPHA), fileId(ALPHA)]);
});

// ---------------------------------------------------------------------------
// The other reading commands
// ---------------------------------------------------------------------------

test('why --store reads the named store', async () => {
  const repo = await twoStores();

  const hit = await cli(repo, ['why', '--store', 'storeA', columnId(ALPHA), '--json']);
  assert.equal(hit.code, EXIT_OK, hit.stderr);
  assert.equal((JSON.parse(hit.stdout) as WhyReport).target.id, columnId(ALPHA));

  const miss = await cli(repo, ['why', '--store', 'storeA', columnId(OMEGA), '--json']);
  assert.equal(miss.code, EXIT_USAGE, "the default store's column is not in storeA");
  assert.match(miss.stderr, /no column, field, or schema property matches/);

  const unchanged = await cli(repo, ['why', columnId(OMEGA), '--json']);
  assert.equal(unchanged.code, EXIT_OK, unchanged.stderr);
  assert.equal((JSON.parse(unchanged.stdout) as WhyReport).target.id, columnId(OMEGA));
});

test('check --store runs the detectors over the named store', async () => {
  const repo = await twoStores();

  const r = await cli(repo, ['check', '--store', 'storeA', '--json']);
  assert.equal(r.code, EXIT_OK, r.stderr);
  const report = JSON.parse(r.stdout) as CheckReport;
  assert.deepEqual(
    report.contradictions.map((c) => c.left),
    [fileId(ALPHA)],
  );

  const unchanged = await cli(repo, ['check', '--json']);
  assert.deepEqual(
    (JSON.parse(unchanged.stdout) as CheckReport).contradictions.map((c) => c.left),
    [fileId(OMEGA)],
  );
});

test('blast-radius --store resolves --ids in the named store', async () => {
  const repo = await twoStores();

  const r = await cli(repo, [
    'blast-radius',
    '--store',
    'storeA',
    '--ids',
    `${columnId(ALPHA)},${columnId(OMEGA)}`,
    '--json',
  ]);
  assert.equal(r.code, EXIT_OK, r.stderr);
  const report = JSON.parse(r.stdout) as BlastRadiusReport;
  assert.deepEqual(
    report.roots.map((n) => n.id),
    [columnId(ALPHA)],
  );
  assert.deepEqual(report.missingIds, [columnId(OMEGA)]);
});

test('diff --store reads snapshots from the named store', async () => {
  const repo = await twoStores();

  const r = await cli(repo, ['diff', '--store', 'storeA', 'run-alpha', 'run-alpha', '--json']);
  assert.equal(r.code, EXIT_OK, r.stderr);
  assert.equal((JSON.parse(r.stdout) as DiffReport).identical, true);

  // run-omega was recorded in the default store, so it is not a snapshot of storeA.
  const miss = await cli(repo, ['diff', '--store', 'storeA', 'run-omega', 'run-omega', '--json']);
  assert.equal(miss.code, EXIT_USAGE);
  assert.match(miss.stderr, /cannot read snapshot/);
});

const EXPLAIN = (id: string): unknown[] => [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'explain', arguments: { id } } },
];

async function explainFound(repo: string, argv: readonly string[], id: string): Promise<boolean> {
  const r = await cli(repo, argv, { frames: EXPLAIN(id) });
  assert.equal(r.code, EXIT_OK, r.stderr);
  const reply = r.stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map(
      (l) =>
        JSON.parse(l) as {
          id?: number;
          result?: { structuredContent: { result: { found: boolean } } };
        },
    )
    .find((m) => m.id === 2);
  assert.ok(reply?.result !== undefined, `no tools/call reply in: ${r.stdout}`);
  return reply.result.structuredContent.result.found;
}

test('mcp --store serves the named store', async () => {
  const repo = await twoStores();

  assert.equal(
    await explainFound(repo, ['mcp', '--store', 'storeA', '--profile', 'team'], columnId(ALPHA)),
    true,
  );
  assert.equal(
    await explainFound(repo, ['mcp', '--store', 'storeA', '--profile', 'team'], columnId(OMEGA)),
    false,
  );
  assert.equal(
    await explainFound(repo, ['mcp', '--profile', 'team'], columnId(OMEGA)),
    true,
    'default store unchanged',
  );
});

// ---------------------------------------------------------------------------
// extract: --store is an alias for the directory it writes
// ---------------------------------------------------------------------------

test('extract --store writes the named store, exactly as extract --out does', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'seamline-store-extract-'));
  const config = {
    ...defaultConfig('demo'),
    extractors: [{ name: 'fixture', enabled: true, options: {} }],
  };
  await writeFile(path.join(repo, CONFIG_FILENAME), serializeConfig(config), 'utf8');

  const viaStore = await cli(repo, ['extract', '--store', 'viaStore'], { label: ALPHA });
  assert.equal(viaStore.code, EXIT_OK, viaStore.stderr);
  const viaOut = await cli(repo, ['extract', '--out', 'viaOut'], { label: ALPHA });
  assert.equal(viaOut.code, EXIT_OK, viaOut.stderr);

  for (const dir of ['viaStore', 'viaOut']) {
    assert.ok(existsSync(path.join(repo, dir, 'graph.db')), `${dir}/graph.db`);
    assert.ok(
      existsSync(path.join(repo, dir, 'runs', 'run-alpha.sif')),
      `${dir}/runs/run-alpha.sif`,
    );
  }
  assert.ok(!existsSync(path.join(repo, 'seamline-out')), 'the config outDir was not touched');
});

// ---------------------------------------------------------------------------
// --store together with --out where --out also names the store
// ---------------------------------------------------------------------------

test('--store and --out naming different stores is a usage error, and nothing is read or written', async () => {
  const repo = await twoStores();

  for (const argv of [
    ['check', '--store', 'storeA', '--out', 'seamline-out'],
    ['why', '--store', 'storeA', '--out', 'seamline-out', columnId(ALPHA)],
    ['blast-radius', '--store', 'storeA', '--out', 'seamline-out', '--ids', columnId(ALPHA)],
    ['diff', '--store', 'storeA', '--out', 'seamline-out', 'run-alpha', 'run-alpha'],
    ['mcp', '--store', 'storeA', '--out', 'seamline-out', '--profile', 'team'],
  ]) {
    const r = await cli(repo, argv);
    assert.equal(r.code, EXIT_USAGE, argv.join(' '));
    assert.equal(r.stdout, '', `no result is printed for: ${argv.join(' ')}`);
    assert.match(r.stderr, /both select the store directory/);
  }
});

test('extract with --store and --out naming different directories writes neither', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'seamline-store-conflict-'));
  const config = {
    ...defaultConfig('demo'),
    extractors: [{ name: 'fixture', enabled: true, options: {} }],
  };
  await writeFile(path.join(repo, CONFIG_FILENAME), serializeConfig(config), 'utf8');

  const r = await cli(repo, ['extract', '--store', 'one', '--out', 'two']);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /both select the store directory/);
  assert.ok(!existsSync(path.join(repo, 'one')) && !existsSync(path.join(repo, 'two')));
});

test('--store and --out that resolve to the same directory are accepted', async () => {
  const repo = await twoStores();

  for (const [store, out] of [
    ['storeA', 'storeA'],
    ['./storeA', 'storeA/'],
    [path.join(repo, 'storeA'), 'storeA'],
  ] as const) {
    const r = await cli(repo, ['check', '--store', store, '--out', out, '--json']);
    assert.equal(r.code, EXIT_OK, `${store} ${out}: ${r.stderr}`);
    assert.deepEqual(
      (JSON.parse(r.stdout) as CheckReport).contradictions.map((c) => c.left),
      [fileId(ALPHA)],
    );
  }
});

test('a reading command still takes the store from --out when --store is absent', async () => {
  const repo = await twoStores();

  const r = await cli(repo, ['check', '--out', 'storeA', '--json']);
  assert.equal(r.code, EXIT_OK, r.stderr);
  assert.deepEqual(
    (JSON.parse(r.stdout) as CheckReport).contradictions.map((c) => c.left),
    [fileId(ALPHA)],
  );
});

// ---------------------------------------------------------------------------
// UNAVAILABLE is never PASS: no store means an error, never an empty result
// ---------------------------------------------------------------------------

const READING_COMMANDS: ReadonlyArray<readonly string[]> = [
  ['export', '--profile', 'slice'],
  ['why', columnId(ALPHA)],
  ['check'],
  ['blast-radius', '--ids', columnId(ALPHA)],
  ['diff', 'run-alpha', 'run-alpha'],
  ['mcp', '--profile', 'team'],
];

test('a --store that does not exist is an error for every reading command, and is not created', async () => {
  const repo = await twoStores();

  for (const argv of READING_COMMANDS) {
    const full = [...argv, '--store', 'no-such-store', '--json'];
    const r = await cli(repo, full, { frames: EXPLAIN(columnId(ALPHA)) });
    assert.equal(r.code, EXIT_USAGE, full.join(' '));
    assert.equal(r.stdout, '', `an empty result must not be printed for: ${full.join(' ')}`);
    assert.match(r.stderr, /no-such-store/, 'the error names the store it looked in');
  }
  assert.ok(!existsSync(path.join(repo, 'no-such-store')), 'reading never creates a store');
});

test('an existing directory with no store in it is an error, not an empty graph', async () => {
  const repo = await twoStores();
  await mkdir(path.join(repo, 'hollow'));

  for (const argv of READING_COMMANDS) {
    const full = [...argv, '--store', 'hollow', '--json'];
    const r = await cli(repo, full, { frames: EXPLAIN(columnId(ALPHA)) });
    assert.equal(r.code, EXIT_USAGE, full.join(' '));
    assert.equal(r.stdout, '', `an empty result must not be printed for: ${full.join(' ')}`);
    assert.match(r.stderr, /hollow/);
  }
  assert.ok(!existsSync(path.join(repo, 'hollow', 'graph.db')), 'reading never creates a store');
});

test('a missing store directory without --store fails the same way it always did', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'seamline-store-none-'));
  const config = { ...defaultConfig('demo'), exportProfiles: { slice: sliceProfile } };
  await writeFile(path.join(repo, CONFIG_FILENAME), serializeConfig(config), 'utf8');

  const r = await cli(repo, ['export', '--profile', 'slice']);
  assert.equal(r.code, EXIT_USAGE);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /no graph store found/);
  assert.match(r.stderr, /seamline extract/);
});

test('an empty --store value is a usage error, not the repository root', async () => {
  const repo = await twoStores();

  const r = await cli(repo, ['export', '--store=', '--profile', 'slice']);
  assert.equal(r.code, EXIT_USAGE);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /--store needs a directory/);
});

test('init does not take --store, so it cannot be silently ignored there', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'seamline-store-init-'));

  const r = await cli(repo, ['init', '--store', 'somewhere']);
  assert.equal(r.code, EXIT_USAGE);
  assert.match(r.stderr, /--store/);
  assert.ok(!existsSync(path.join(repo, CONFIG_FILENAME)), 'nothing was scaffolded');
});

// ---------------------------------------------------------------------------
// The flag is the same everywhere it is meant to be
// ---------------------------------------------------------------------------

test('every command that touches a store accepts --store and documents it in its help; init and conformance do neither', async () => {
  const repo = await twoStores();
  // `conformance` reads no store: it runs an extractor over fixtures it generates itself.
  const storeless: ReadonlySet<Command> = new Set<Command>(['init', 'conformance']);
  const usable: Record<Exclude<Command, 'init' | 'conformance'>, readonly string[]> = {
    extract: ['extract', '--store', 'fresh'],
    why: ['why', columnId(ALPHA), '--store', 'storeA'],
    check: ['check', '--store', 'storeA'],
    export: ['export', '--profile', 'slice', '--store', 'storeA'],
    diff: ['diff', 'run-alpha', 'run-alpha', '--store', 'storeA'],
    'blast-radius': ['blast-radius', '--ids', columnId(ALPHA), '--store', 'storeA'],
    mcp: ['mcp', '--profile', 'team', '--store', 'storeA'],
    align: ['align', '--store', 'storeA'],
  };

  for (const command of COMMANDS) {
    assert.equal(
      /--store <dir>/.test(COMMAND_HELP[command]),
      !storeless.has(command),
      `--help of ${command}`,
    );
    if (command === 'init' || command === 'conformance') continue;
    const r = await cli(repo, usable[command]);
    assert.equal(r.code, EXIT_OK, `${command}: ${r.stderr}`);
  }
  assert.match(HELP_TEXT, /--store <dir>/);
});
