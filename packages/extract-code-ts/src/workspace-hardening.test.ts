/**
 * What a workspace run refuses to guess, and what it says when it did not read
 * everything: a config that does not parse is not read, a workspace too big for
 * the memory budget is read partially and says so, an absolute path never
 * reaches a diagnostic, a file is read under the options of the package it
 * lives in, and a glob the matcher cannot evaluate is reported as incomplete.
 *
 * Every assertion is an outcome (a status, which symbols exist, which packages
 * the `Repo` node names, how long a match takes), never that a function exists.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { SqliteStore, compileSelector, matchesReads } from '@seamline/core';
import type { SeamlineNode } from '@seamline/ontology';
import { extractCodeTs } from './extract.ts';
import type { ExtractCodeTsOptions, ExtractCodeTsOutput } from './extract.ts';
import { manifest } from './manifest.ts';
import { MEMORY_MODEL, estimateProgramMib, planPrograms } from './memory.ts';
import { OUTSIDE_REPOSITORY, redactPaths } from './paths.ts';
import { canonicalJson } from './serialize.ts';
import { matchWorkspaceDirs, shownPattern } from './workspace.ts';

/**
 * A data-model index that declares no table. A run with no index at all reports `ormIndexAbsent` on
 * the `Repo` node, and these tests are about workspace reading, so they hand over an index that binds
 * nothing (see `extract.test.ts`).
 */
const NO_TABLES_INDEX = JSON.stringify({
  version: 1,
  dataSources: [{ name: 'default', dialect: 'postgres', defaultSchema: 'public' }],
  tables: [],
  prismaDelegates: {},
  drizzleExports: {},
});

type Files = Readonly<Record<string, string>>;

const STRICT = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    noEmit: true,
  },
  include: ['src'],
});

const SRC = (name: string): string => `export class ${name} {\n  email: string | null = null;\n}\n`;

const PNPM = "packages:\n  - 'packages/*'\n";

/** `names` as workspace packages `packages/<name>`, each strict, each with one class `<Name>` in `src/<name>.ts`. */
function packagesOf(...names: string[]): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'root' }),
    'pnpm-workspace.yaml': PNPM,
  };
  for (const name of names) {
    files[`packages/${name}/package.json`] = JSON.stringify({ name: `@fx/${name}` });
    files[`packages/${name}/tsconfig.json`] = STRICT;
    files[`packages/${name}/src/${name}.ts`] = SRC(name[0]?.toUpperCase() + name.slice(1));
  }
  return files;
}

const created: string[] = [];

/** Writes `files` under a fresh directory inside a fresh parent, so `../..` stays in a directory the test owns. */
function materializeIn(
  files: Files,
  label: string,
): { readonly root: string; readonly parent: string } {
  const parent = fs.mkdtempSync(nodePath.join(os.tmpdir(), `seamline-${label}-`));
  created.push(parent);
  const root = nodePath.join(parent, 'repo');
  for (const rel of Object.keys(files).sort()) {
    const abs = nodePath.join(root, rel);
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel] ?? '', 'utf8');
  }
  return { root, parent };
}

function run(
  files: Files,
  label: string,
  overrides: Partial<ExtractCodeTsOptions> = {},
): ExtractCodeTsOutput {
  const { root } = materializeIn(files, label);
  return extractCodeTs({
    repoRoot: root,
    repo: 'fx',
    runId: 'run-1',
    deterministic: true, dataModelIndex: NO_TABLES_INDEX,
    ...overrides,
  });
}

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** What every run with a data-model index writes on the `Repo` node, whatever it read (see `describeRepo`). */
const WRITE_FACTS = { unknownWriterTables: '', untracedWriteCalls: 0, writeHooks: 0, runtimeDdl: 0 } as const;

const symbols = (o: ExtractCodeTsOutput): string[] =>
  o.nodes.filter((n) => n.kind === 'Symbol').map((n) => String(n.id));

const repoProps = (o: ExtractCodeTsOutput): SeamlineNode['props'] | undefined =>
  o.nodes.find((n) => n.kind === 'Repo')?.props;

const unreadNames = (o: ExtractCodeTsOutput): string[] => {
  const raw = repoProps(o)?.['unreadCodePackages'];
  return typeof raw === 'string' ? (JSON.parse(raw) as string[]) : [];
};

const nullableOf = (o: ExtractCodeTsOutput, field: string): unknown =>
  o.nodes.find((n) => String(n.id).startsWith(`fx:CodeField:${field}`))?.props['nullable'];

/* ------------------------------------------------- 1. a config that cannot be trusted */

const BROKEN_CONFIGS: ReadonlyArray<readonly [string, string, RegExp]> = [
  ['truncated', '{ "compilerOptions": ', /packages\/g\/tsconfig\.json:1: /],
  [
    'a missing comma',
    '{ "compilerOptions": { "strict": true } "include": ["src"] }',
    /',' expected/,
  ],
  ['an unclosed brace', '{ "compilerOptions": { "strict": true }, "include": ["src"]', /expected/],
  [
    'trailing garbage',
    '{ "compilerOptions": { "strict": true }, "include": ["src"] } nonsense',
    /expected|end of file/i,
  ],
  [
    'an option given the wrong type',
    '{ "compilerOptions": { "strict": "yes" }, "include": ["src"] }',
    /requires a value of type boolean/,
  ],
  [
    'an option value outside its choices',
    '{ "compilerOptions": { "target": "es99" }, "include": ["src"] }',
    /target/i,
  ],
  [
    'an unknown option',
    '{ "compilerOptions": { "strict": true, "noSuchOptionAnywhere": true }, "include": ["src"] }',
    /Unknown compiler option 'noSuchOptionAnywhere'/,
  ],
  [
    'a files entry that is not there',
    '{ "compilerOptions": { "strict": true }, "files": ["src/nope.ts", "src/g.ts"] }',
    /'files' entry is not there: packages\/g\/src\/nope\.ts/,
  ],
  [
    'a files entry outside the repository',
    '{ "compilerOptions": { "strict": true }, "files": ["../../../elsewhere.ts", "src/g.ts"] }',
    /'files' entry is outside the repository/,
  ],
];

for (const [label, config, reason] of BROKEN_CONFIGS) {
  test(`a package whose tsconfig has ${label} is not read, and is named`, () => {
    const out = run({ ...packagesOf('a', 'g'), 'packages/g/tsconfig.json': config }, 'broken');
    assert.equal(out.result.status, 'PASS');
    assert.ok(symbols(out).includes('fx:Symbol:@fx/a#A'), 'the valid package is still read');
    assert.equal(
      symbols(out).some((s) => s.includes('@fx/g')),
      false,
      'facts read from an error-recovered config would be wrong, not absent',
    );
    assert.deepEqual(unreadNames(out), ['packages/g']);
    assert.equal(repoProps(out)?.['unreadCodePackageCount'], 1);
    const line = out.result.diagnostics.find((d) =>
      d.startsWith('workspace package not read: packages/g:'),
    );
    assert.ok(line !== undefined, out.result.diagnostics.join('\n'));
    assert.match(line, reason);
  });
}

test('comments and trailing commas in a tsconfig are not errors: the package is read', () => {
  const out = run(
    {
      ...packagesOf('a', 'g'),
      'packages/g/tsconfig.json':
        '{\n  // the usual\n  "compilerOptions": { "strict": true, },\n  "include": ["src"],\n}\n',
    },
    'jsonc',
  );
  assert.deepEqual(repoProps(out), WRITE_FACTS);
  assert.ok(symbols(out).includes('fx:Symbol:@fx/g#G'));
});

test('a syntax error in an extended base is still not read', () => {
  const out = run(
    {
      ...packagesOf('a', 'g'),
      'packages/g/base.json': '{ "compilerOptions": { "strict": true } ',
      'packages/g/tsconfig.json': JSON.stringify({ extends: './base.json', include: ['src'] }),
    },
    'broken-base',
  );
  assert.deepEqual(unreadNames(out), ['packages/g']);
});

/* --------------------------------------------------------- 2. the memory budget */

const FOUR = packagesOf('alpha', 'beta', 'delta', 'gamma');

/** A budget that lets `count` of the tiny packages of `FOUR` fit and no more. */
const budgetFor = (count: number): number =>
  MEMORY_MODEL.baseMib + (count + 0.5) * MEMORY_MODEL.perProgramMib;

/** A gauge that reports the next value of `values` on each call, and the last one after that. */
function gauge(...values: number[]): () => number {
  let call = 0;
  return () => values[Math.min(call++, values.length - 1)] as number;
}

/** The whole output, as the determinism gate compares it. */
const bytesOf = (o: ExtractCodeTsOutput): string =>
  canonicalJson({ r: o.result, n: o.nodes, e: o.edges });

/** Source of about `mib` MiB that is cheap to write and is never parsed when its package is not built. */
const padding = (mib: number): string =>
  `${'// padding\n'.repeat(Math.ceil((mib * 1024 * 1024) / 11))}export class Padding {}\n`;

const DELTA_AND_GAMMA = ['packages/delta', 'packages/gamma'];

test('when the estimate outgrows the budget the tsconfigs that do not fit what is left are unread, in sorted order, and the run is still PASS', () => {
  const out = run(FOUR, 'budget-a', { memoryBudget: { mb: budgetFor(2), usedMb: () => 0 } });
  assert.equal(out.result.status, 'PASS');
  assert.ok(symbols(out).includes('fx:Symbol:@fx/alpha#Alpha'));
  assert.ok(symbols(out).includes('fx:Symbol:@fx/beta#Beta'));
  for (const name of ['delta', 'gamma'])
    assert.equal(
      symbols(out).some((s) => s.includes(`@fx/${name}`)),
      false,
      `${name} did not fit`,
    );
  assert.deepEqual(unreadNames(out), DELTA_AND_GAMMA);
  assert.equal(repoProps(out)?.['unreadCodePackageCount'], 2);
  const lines = out.result.diagnostics.filter((d) => d.startsWith('workspace package not read:'));
  assert.deepEqual(lines, [
    'workspace package not read: packages/delta: packages/delta/tsconfig.json: memory budget',
    'workspace package not read: packages/gamma: packages/gamma/tsconfig.json: memory budget',
  ]);
  assert.ok(
    out.result.diagnostics.some((d) =>
      /^memory estimate: \d+ MiB of resident memory for 4 tsconfig\(s\), from the size of their files, against a budget of \d+(\.\d+)? MiB$/.test(
        d,
      ),
    ),
    'the estimate and the budget are written down, and are a function of the files',
  );
  assert.ok(
    out.result.diagnostics.some(
      (d) =>
        d.startsWith(
          'memory budget reached: 2 tsconfig(s) in 2 workspace package(s) were not read',
        ) && d.includes('read partially'),
    ),
    'the output says the workspace was read partially',
  );
  const selector = compileSelector(out.result.authoritative[0]?.selector as string);
  assert.equal(selector.matches('packages/alpha/src/alpha.ts'), true);
  assert.equal(
    selector.matches('packages/delta/src/delta.ts'),
    false,
    'an unread package is not vouched for',
  );
});

test('what is read follows the size of the files, not the number of packages: a large package is unread and the small ones after it are still read', () => {
  const small = run(FOUR, 'budget-size-a', { memoryBudget: { mb: budgetFor(4), usedMb: () => 0 } });
  assert.deepEqual(repoProps(small), WRITE_FACTS, 'four tiny packages fit a budget for four');

  // The same four packages, one of them holding 2 MiB of source: about 240 MiB more.
  const heavy = run({ ...FOUR, 'packages/delta/src/padding.ts': padding(2) }, 'budget-size-b', {
    memoryBudget: { mb: budgetFor(4), usedMb: () => 0 },
  });
  assert.equal(heavy.result.status, 'PASS');
  assert.deepEqual(
    unreadNames(heavy),
    ['packages/delta'],
    'delta no longer fits and is unread; gamma, which is tiny and sorts after it, is still read',
  );
  assert.ok(symbols(heavy).includes('fx:Symbol:@fx/beta#Beta'));
  assert.ok(
    symbols(heavy).includes('fx:Symbol:@fx/gamma#Gamma'),
    'first fit reads what comes after the one that did not fit',
  );
  assert.equal(
    symbols(heavy).some((s) => s.includes('@fx/delta')),
    false,
  );
  const selector = compileSelector(heavy.result.authoritative[0]?.selector as string);
  assert.equal(selector.matches('packages/gamma/src/gamma.ts'), true);
  assert.equal(
    selector.matches('packages/delta/src/delta.ts'),
    false,
    'the unread package is not vouched for',
  );
});

test('first fit takes the same packages whatever the process reports, and the large one stays unread on every run', () => {
  const files = { ...FOUR, 'packages/beta/src/padding.ts': padding(2) };
  const runs = [0, 700, manifest.memMb - 1].map((reading, i) =>
    run(files, `budget-ff-${i}`, { memoryBudget: { mb: budgetFor(4), usedMb: () => reading } }),
  );
  for (const out of runs) {
    assert.deepEqual(unreadNames(out), ['packages/beta']);
    assert.equal(bytesOf(out), bytesOf(runs[0] as ExtractCodeTsOutput));
  }
  const read = symbols(runs[0] as ExtractCodeTsOutput);
  for (const name of ['alpha', 'delta', 'gamma'])
    assert.ok(
      read.some((s) => s.includes(`@fx/${name}`)),
      `${name} fits and is read`,
    );
});

test('the same input gives the same bytes whatever the process reports: the resident memory reading decides nothing under the ceiling', () => {
  const budget = budgetFor(2);
  const gauges: Array<[string, () => number]> = [
    ['zero', () => 0],
    ['a large process', () => manifest.memMb - 1],
    ['a reading that climbs', gauge(100, 400, 900, 1300, 1700, 1900, 2000)],
    ['a reading that jitters', gauge(1500, 1000, 1990, 200, 1800, 50)],
  ];
  const outputs = gauges.map(([, usedMb], i) =>
    run(FOUR, `budget-gauge-${i}`, { memoryBudget: { mb: budget, usedMb } }),
  );
  const expected = bytesOf(outputs[0] as ExtractCodeTsOutput);
  outputs.forEach((out, i) => {
    const label = String(gauges[i]?.[0]);
    assert.equal(out.result.status, 'PASS', label);
    assert.deepEqual(unreadNames(out), DELTA_AND_GAMMA, label);
    assert.equal(bytesOf(out), expected, `${label} changed the output`);
  });
  // The default gauge, the real process RSS, is one more reading and changes nothing either.
  const real = run(FOUR, 'budget-gauge-real', { memoryBudget: { mb: budget } });
  assert.equal(bytesOf(real), expected);
  // And it holds with the default budget, where everything fits.
  const whole = bytesOf(run(FOUR, 'budget-gauge-w1', { memoryBudget: { usedMb: () => 0 } }));
  assert.equal(
    whole,
    bytesOf(run(FOUR, 'budget-gauge-w2', { memoryBudget: { usedMb: () => 2000 } })),
  );
  assert.equal(whole, bytesOf(run(FOUR, 'budget-gauge-w3')));
});

test('the cut names the same packages unread on every run, from different directories', () => {
  const runs = [1, 2, 3, 4].map((i) =>
    run(FOUR, `budget-same-${i}`, { memoryBudget: { mb: budgetFor(1), usedMb: () => i * 400 } }),
  );
  for (const out of runs) {
    assert.deepEqual(unreadNames(out), ['packages/beta', 'packages/delta', 'packages/gamma']);
    assert.equal(bytesOf(out), bytesOf(runs[0] as ExtractCodeTsOutput));
  }
});

test('resident memory past the ceiling ends the run as UNAVAILABLE with nothing extracted, never as a different PASS', () => {
  const baseline = run(FOUR, 'ceiling-ok', { memoryBudget: { usedMb: () => 0 } });
  assert.equal(baseline.result.status, 'PASS');
  // The reading crosses the ceiling at the start, between programs, and while the passes run.
  for (const crossesAfter of [0, 1, 3, 9, 20]) {
    const out = run(FOUR, `ceiling-${crossesAfter}`, {
      memoryBudget: {
        usedMb: gauge(...Array.from({ length: crossesAfter }, () => 100), manifest.memMb + 1),
      },
    });
    assert.equal(out.result.status, 'UNAVAILABLE', `crossing after ${crossesAfter} readings`);
    assert.equal(out.nodes.length, 0);
    assert.equal(out.edges.length, 0);
    assert.ok(
      out.result.diagnostics.some((d) => d.includes(`passed the ${manifest.memMb} MiB ceiling`)),
      out.result.diagnostics.join('\n'),
    );
    assert.equal(
      out.result.diagnostics.join('\n').includes(String(manifest.memMb + 1)),
      false,
      'the reading itself, which differs between runs, is not written down',
    );
  }
  // A ceiling the caller sets is honoured in place of the manifest's.
  const low = run(FOUR, 'ceiling-low', { memoryBudget: { ceilingMb: 50, usedMb: () => 51 } });
  assert.equal(low.result.status, 'UNAVAILABLE');
  const exact = run(FOUR, 'ceiling-exact', { memoryBudget: { ceilingMb: 50, usedMb: () => 50 } });
  assert.equal(exact.result.status, 'PASS', 'at the ceiling is not past it');
});

test('an UNAVAILABLE run from the ceiling sweeps nothing: the facts of the run before stay live', async () => {
  const first = run(FOUR, 'ceiling-store-1', { runId: 'run-1', memoryBudget: { usedMb: () => 0 } });
  const second = run(FOUR, 'ceiling-store-2', {
    runId: 'run-2',
    memoryBudget: { usedMb: () => manifest.memMb + 1 },
  });
  assert.equal(first.result.status, 'PASS');
  assert.equal(second.result.status, 'UNAVAILABLE');
  const store = new SqliteStore({
    ontologyVersion: '1.0.0',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  for (const [runId, out] of [
    ['run-1', first],
    ['run-2', second],
  ] as const) {
    await store.beginRun({
      runId,
      repo: 'fx',
      commit: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      ontologyVersion: '1.0.0',
    });
    await store.upsertNodes(runId, out.nodes);
    await store.upsertEdges(runId, 'code.ts', out.edges);
    await store.finalizeRun(runId, [out.result]);
  }
  const live = store
    .nodesByKind('Symbol')
    .map((n) => String(n.id))
    .sort();
  assert.deepEqual(live, symbols(first).sort(), 'every symbol of the first run is still live');
  assert.equal(
    store.scopeStatus('code.ts'),
    'UNAVAILABLE',
    'and the scope says it was not read this time',
  );
});

test('a budget that cannot hold even the first program reads nothing: UNAVAILABLE, never an empty PASS', () => {
  const out = run(FOUR, 'budget-e', {
    memoryBudget: { mb: MEMORY_MODEL.baseMib, usedMb: () => 0 },
  });
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.nodes.length, 0);
  assert.ok(
    out.result.diagnostics.some((d) => d.endsWith('packages/alpha/tsconfig.json: memory budget')),
  );
});

test('the default budget is the manifest memMb: a package whose files alone estimate past it is not built', () => {
  const sourceMib =
    Math.ceil((manifest.memMb - MEMORY_MODEL.baseMib) / MEMORY_MODEL.perSourceMib) + 1;
  const files = { ...packagesOf('a', 'z'), 'packages/z/src/padding.ts': padding(sourceMib) };
  const out = run(files, 'budget-default', { memoryBudget: { usedMb: () => 0 } });
  assert.equal(out.result.status, 'PASS');
  assert.ok(symbols(out).includes('fx:Symbol:@fx/a#A'));
  assert.deepEqual(unreadNames(out), ['packages/z']);
  const named = run(files, 'budget-default-2', {
    memoryBudget: { mb: manifest.memMb, usedMb: () => 0 },
  });
  assert.equal(bytesOf(named), bytesOf(out));
});

/**
 * What the model was calibrated on: programs, MiB of source in their own file
 * lists, and the peak resident memory of the whole extraction run, in-process
 * (`process.resourceUsage().maxRSS`). See `MEMORY_MODEL`.
 */
const MEASURED: ReadonlyArray<{
  readonly repo: string;
  readonly programs: number;
  readonly sourceMib: number;
  readonly peakMib: number;
  readonly readWhole: boolean;
}> = [
  { repo: 'dokploy', programs: 4, sourceMib: 6.16, peakMib: 1465, readWhole: true },
  { repo: 'karakeep', programs: 21, sourceMib: 4.22, peakMib: 1782, readWhole: true },
  {
    repo: 'this repository, installed',
    programs: 11,
    sourceMib: 2.76,
    peakMib: 1347,
    readWhole: true,
  },
  { repo: 'rallly', programs: 5, sourceMib: 0.06, peakMib: 295, readWhole: true },
  { repo: 'frapp', programs: 14, sourceMib: 15.78, peakMib: 2441, readWhole: false },
];

for (const m of MEASURED) {
  test(`the model estimates ${m.repo} at or above its measured peak, and ${m.readWhole ? 'within' : 'beyond'} the budget`, () => {
    const each = estimateProgramMib((m.sourceMib / m.programs) * 1024 * 1024);
    const plan = planPrograms(
      Array.from({ length: m.programs }, () => each),
      manifest.memMb,
    );
    assert.ok(
      plan.totalMib >= m.peakMib,
      `estimated ${plan.totalMib} MiB for a measured peak of ${m.peakMib} MiB`,
    );
    const fitting = plan.fits.filter(Boolean).length;
    assert.equal(fitting === m.programs, m.readWhole, `${fitting} of ${m.programs} fit`);
    if (!m.readWhole)
      assert.ok(m.peakMib > manifest.memMb, 'and its measured peak is past the manifest memory');
  });
}

/* ----------------------------------------------------- the manifest declares what is read */

test('every file the workspace path opens inside the repository is one the manifest declares', () => {
  const files: Record<string, string> = {
    ...packagesOf('alpha', 'beta'),
    'tooling/typescript/package.json': JSON.stringify({ name: '@fx/tsconfig' }),
    'tooling/typescript/node.json': JSON.stringify({ compilerOptions: { strict: true } }),
    'packages/alpha/tsconfig.json': JSON.stringify({
      extends: '@fx/tsconfig/node.json',
      include: ['src'],
    }),
    'packages/beta/tsconfig.base.json': JSON.stringify({ compilerOptions: { strict: true } }),
    'packages/beta/tsconfig.json': JSON.stringify({
      extends: './tsconfig.base.json',
      include: ['src'],
    }),
    'package.json': JSON.stringify({ name: 'root', workspaces: ['tooling/*'] }),
    'packages/gamma/package.yaml': 'name: "@fx/gamma"\n',
    'packages/gamma/tsconfig.json': STRICT,
    'packages/gamma/src/gamma.ts': SRC('Gamma'),
    'packages/delta/package.json5': "{ name: '@fx/delta' }\n",
    'packages/delta/tsconfig.json': STRICT,
    'packages/delta/src/delta.ts': SRC('Delta'),
  };
  const { root } = materializeIn(files, 'reads');
  const nodeFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const opened = new Set<string>();
  const readFileSync = nodeFs.readFileSync;
  const existsSync = nodeFs.existsSync;
  const note = (p: unknown): void => {
    if (typeof p === 'string' && p.startsWith(`${root}${nodePath.sep}`))
      opened.add(nodePath.relative(root, p).split(nodePath.sep).join('/'));
  };
  (nodeFs as { readFileSync: unknown }).readFileSync = (...args: unknown[]): unknown => {
    note(args[0]);
    return (readFileSync as (...a: unknown[]) => unknown)(...args);
  };
  (nodeFs as { existsSync: unknown }).existsSync = (p: unknown): boolean => {
    const found = existsSync(p as string);
    if (found && typeof p === 'string' && nodeFs.statSync(p).isFile()) note(p);
    return found;
  };
  syncBuiltinESMExports();
  let out: ExtractCodeTsOutput;
  try {
    out = extractCodeTs({ repoRoot: root, repo: 'fx', runId: 'run-1', deterministic: true, dataModelIndex: NO_TABLES_INDEX });
  } finally {
    (nodeFs as { readFileSync: unknown }).readFileSync = readFileSync;
    (nodeFs as { existsSync: unknown }).existsSync = existsSync;
    syncBuiltinESMExports();
  }
  assert.equal(out.result.status, 'PASS');
  for (const must of [
    'pnpm-workspace.yaml',
    'package.json',
    'packages/alpha/package.json',
    'packages/alpha/tsconfig.json',
    'tooling/typescript/node.json',
    'packages/beta/tsconfig.base.json',
    'packages/alpha/src/alpha.ts',
  ])
    assert.ok(opened.has(must), `the run opens ${must}: ${[...opened].join(' ')}`);
  assert.deepEqual(
    [...opened].filter((rel) => /package\.(yaml|json5)$/.test(rel)),
    [],
    'the content of a package.yaml or package.json5 is never opened',
  );
  const undeclared = [...opened].filter((rel) => !matchesReads(manifest, rel));
  assert.deepEqual(undeclared, [], 'a file opened without being declared in manifest.reads');
});

/* ------------------------------------------------ package manifests: json, json5, yaml */

/** A workspace of `packages/*` where each manifest file name is one that pnpm accepts. */
const MIXED_MANIFESTS: Files = {
  'package.json': JSON.stringify({ name: 'root' }),
  'pnpm-workspace.yaml': PNPM,
  'packages/a/package.json': JSON.stringify({ name: '@fx/a' }),
  'packages/a/tsconfig.json': STRICT,
  'packages/a/src/a.ts': SRC('A'),
  'packages/b/package.yaml': 'name: "@fx/b"\n',
  'packages/b/tsconfig.json': STRICT,
  'packages/b/src/b.ts': SRC('B'),
  'packages/c/package.json5': "{ name: '@fx/c' }\n",
  'packages/c/tsconfig.json': STRICT,
  'packages/c/src/c.ts': SRC('C'),
};

test('a package whose manifest is package.yaml or package.json5 is named unread, not silently absent', () => {
  const out = run(MIXED_MANIFESTS, 'manifests-mixed');
  assert.equal(out.result.status, 'PASS');
  assert.deepEqual(
    symbols(out).filter((s) => s.startsWith('fx:Symbol:')),
    ['fx:Symbol:@fx/a#A'],
    'only the package.json package is read: the others have no name its ids could be built from',
  );
  assert.deepEqual(unreadNames(out), ['packages/b', 'packages/c']);
  assert.equal(repoProps(out)?.['unreadCodePackageCount'], 2);
  const lines = out.result.diagnostics.filter((d) => d.startsWith('workspace package not read:'));
  assert.deepEqual(lines, [
    'workspace package not read: packages/b: packages/b/tsconfig.json: its manifest is package.yaml, which is not read (no parser for it), so the package name its ids are built from is not known',
    'workspace package not read: packages/c: packages/c/tsconfig.json: its manifest is package.json5, which is not read (no parser for it), so the package name its ids are built from is not known',
  ]);
  assert.ok(
    out.result.diagnostics.includes('3 workspace package(s) from pnpm-workspace.yaml'),
    'all three are workspace packages',
  );
  const selector = compileSelector(out.result.authoritative[0]?.selector as string);
  assert.equal(selector.matches('packages/a/src/a.ts'), true);
  assert.equal(
    selector.matches('packages/b/src/b.ts'),
    false,
    'an unread package is not vouched for',
  );
});

test('with only package.yaml packages there is nothing to read: UNAVAILABLE, never an empty PASS', () => {
  const files: Record<string, string> = { ...MIXED_MANIFESTS };
  delete files['packages/a/package.json'];
  files['packages/a/package.yaml'] = 'name: "@fx/a"\n';
  const out = run(files, 'manifests-only-yaml');
  assert.equal(out.result.status, 'UNAVAILABLE');
  assert.equal(out.nodes.length, 0);
});

test('a directory with both package.json and package.yaml is a package.json package, as pnpm reads it', () => {
  const out = run(
    { ...MIXED_MANIFESTS, 'packages/b/package.json': JSON.stringify({ name: '@fx/b' }) },
    'manifests-both',
  );
  assert.equal(out.result.status, 'PASS');
  assert.ok(symbols(out).includes('fx:Symbol:@fx/b#B'));
  assert.deepEqual(unreadNames(out), ['packages/c']);
});

test('a package.yaml package with source and no tsconfig is unread; one with nothing to read is not named', () => {
  const out = run(
    {
      ...MIXED_MANIFESTS,
      'packages/d/package.yaml': 'name: "@fx/d"\n',
      'packages/d/src/d.ts': SRC('D'),
      'packages/e/package.yaml': 'name: "@fx/e"\n',
      'packages/e/README.md': 'no code here\n',
    },
    'manifests-notsconfig',
  );
  assert.deepEqual(unreadNames(out), ['packages/b', 'packages/c', 'packages/d']);
  assert.ok(
    out.result.diagnostics.includes('workspace package not read: packages/d: no tsconfig.json'),
  );
});

/* ----------------------------------------------------------- 3. no absolute path */

test('redactPaths maps a path inside the repository to a relative one and any other to a fixed token', () => {
  const root = nodePath.resolve('/work/repo');
  assert.equal(
    redactPaths(root, "Cannot read file '/work/repo/packages/a/tsconfig.json'."),
    "Cannot read file 'packages/a/tsconfig.json'.",
  );
  assert.equal(
    redactPaths(root, "File '/etc/outside.json' not found."),
    `File '${OUTSIDE_REPOSITORY}' not found.`,
  );
  assert.equal(
    redactPaths(root, 'Circularity: /work/repo/a.json -> /work/repo/b.json -> /work/repo/a.json'),
    'Circularity: a.json -> b.json -> a.json',
  );
  assert.equal(redactPaths(root, 'failed under /work/repo.'), 'failed under ..');
  assert.equal(redactPaths(root, 'sibling /work/repo-two/x.ts'), `sibling ${OUTSIDE_REPOSITORY}`);
  assert.equal(
    redactPaths(root, "File './rel/x.json' not found."),
    "File './rel/x.json' not found.",
  );
  assert.equal(redactPaths(root, "Unexpected token '/'"), "Unexpected token '/'");
  assert.equal(redactPaths(root, 'C:\\Users\\x\\a.json is bad'), `${OUTSIDE_REPOSITORY} is bad`);
});

test('a root with whitespace is replaced as a whole: no fragment of the checkout path is left, and a path inside is not reported as outside', () => {
  const root = '/tmp/John Smith/my repo';
  assert.equal(
    redactPaths(root, "Cannot read file '/tmp/John Smith/my repo/x/y.json'."),
    "Cannot read file 'x/y.json'.",
  );
  assert.equal(
    redactPaths(
      root,
      'Circularity detected: /tmp/John Smith/my repo/packages/c/tsconfig.json -> /tmp/John Smith/my repo/packages/c/b.json -> /tmp/John Smith/my repo/packages/c/tsconfig.json',
    ),
    'Circularity detected: packages/c/tsconfig.json -> packages/c/b.json -> packages/c/tsconfig.json',
  );
  assert.equal(redactPaths(root, 'failed under /tmp/John Smith/my repo.'), 'failed under ..');
  assert.equal(redactPaths(root, "Cannot read '/tmp/John Smith/my repo'"), "Cannot read '.'");
  // The root is one whole name: a sibling that starts with the same text, and the same text inside a longer path, are other paths.
  assert.equal(
    redactPaths(root, "File '/tmp/John Smith/my repo2/x.json' not found."),
    `File '${OUTSIDE_REPOSITORY}' not found.`,
  );
  assert.equal(
    redactPaths(root, "File '/mnt/tmp/John Smith/my repo/x.json' not found."),
    `File '${OUTSIDE_REPOSITORY}' not found.`,
  );
  // A path outside the repository that holds whitespace is taken whole when it is quoted, so none of it is left.
  assert.equal(
    redactPaths(root, "Cannot read file '/home/Jane Doe/shared base.json'."),
    `Cannot read file '${OUTSIDE_REPOSITORY}'.`,
  );
  // A name with whitespace inside the repository is a repo-relative name with whitespace.
  assert.equal(
    redactPaths(root, "Cannot read file '/tmp/John Smith/my repo/packages/my pkg/x.json'."),
    "Cannot read file 'packages/my pkg/x.json'.",
  );
  // A path that climbs out of the root is outside it.
  assert.equal(
    redactPaths(root, "Cannot read file '/tmp/John Smith/my repo/../outside.json'."),
    `Cannot read file '${OUTSIDE_REPOSITORY}'.`,
  );
});

test('a sibling whose name is the root and more is another path when it is quoted; unquoted, the path ends at whitespace', () => {
  // (a) `/work/repo two` is not the repository. A quoted path is one token, so it is outside whole.
  const root = '/work/repo';
  assert.equal(
    redactPaths(root, "Cannot read '/work/repo two/x.json'."),
    `Cannot read '${OUTSIDE_REPOSITORY}'.`,
  );
  assert.equal(
    redactPaths(root, 'Cannot read "/work/repo two/x.json"'),
    `Cannot read "${OUTSIDE_REPOSITORY}"`,
  );
  // The same for a root that holds whitespace itself, where the root is also found by exact string.
  const spaced = '/tmp/John Smith/my repo';
  assert.equal(
    redactPaths(spaced, "File '/tmp/John Smith/my repo two/x.json' not found."),
    `File '${OUTSIDE_REPOSITORY}' not found.`,
  );
  // The root itself, quoted or followed by a separator, quote, bracket or punctuation, is still the root.
  assert.equal(redactPaths(root, "Cannot read '/work/repo'"), "Cannot read '.'");
  assert.equal(redactPaths(root, 'See (/work/repo/a.ts).'), 'See (a.ts).');
  // Unquoted, a path ends at whitespace (documented): the sibling reads as the root followed by words.
  // TypeScript quotes the paths it reports, so this is the residual, and it is pinned as it is.
  assert.equal(
    redactPaths(root, 'Cannot read /work/repo two/x.json.'),
    'Cannot read . two/x.json.',
  );
  // A bare mention of a root that holds whitespace is still the whole root, not a fragment of it.
  assert.equal(
    redactPaths(spaced, 'failed in /tmp/John Smith/my repo during load'),
    'failed in . during load',
  );
});

test('an unquoted path outside the repository ends at whitespace: a fragment after the space is what the rule leaves, and it is pinned', () => {
  // (b) The documented rule: only a quoted path is taken whole. TypeScript quotes the paths it reports in
  // nearly every message; an unquoted one that holds a space is the residual. The words after the space can
  // include a part of a home directory the checkout shares (`Smith`), so this is pinned, not endorsed.
  assert.equal(
    redactPaths('/work/repo', 'Cannot read file /home/Jane Doe/outside.json.'),
    `Cannot read file ${OUTSIDE_REPOSITORY} Doe/outside.json.`,
  );
  assert.equal(
    redactPaths(
      'C:\\Users\\John Smith\\repo',
      'Cannot read C:\\Users\\John Smith\\repo-two\\x.json',
    ),
    `Cannot read ${OUTSIDE_REPOSITORY} Smith\\repo-two\\x.json`,
  );
  // Quoted, the same paths are taken whole.
  assert.equal(
    redactPaths('/work/repo', "Cannot read file '/home/Jane Doe/outside.json'."),
    `Cannot read file '${OUTSIDE_REPOSITORY}'.`,
  );
  assert.equal(
    redactPaths(
      'C:\\Users\\John Smith\\repo',
      "Cannot read 'C:\\Users\\John Smith\\repo-two\\x.json'",
    ),
    `Cannot read '${OUTSIDE_REPOSITORY}'`,
  );
});

test('a Windows-style root is replaced in its native and its POSIX spelling, whatever the host', () => {
  const root = 'C:\\Users\\John Smith\\repo';
  assert.equal(
    redactPaths(root, "Cannot read file 'C:\\Users\\John Smith\\repo\\packages\\a\\x.json'."),
    "Cannot read file 'packages/a/x.json'.",
  );
  // TypeScript reports Windows paths with forward slashes, and may lower-case the drive.
  assert.equal(
    redactPaths(root, "Cannot read file 'C:/Users/John Smith/repo/packages/a/x.json'."),
    "Cannot read file 'packages/a/x.json'.",
  );
  assert.equal(
    redactPaths(root, "Cannot read file 'c:/users/john smith/repo/packages/a/x.json'."),
    "Cannot read file 'packages/a/x.json'.",
  );
  assert.equal(
    redactPaths(
      root,
      'Circularity: C:/Users/John Smith/repo/a.json -> C:/Users/John Smith/repo/b.json',
    ),
    'Circularity: a.json -> b.json',
  );
  assert.equal(
    redactPaths(root, "Cannot read file 'C:\\Users\\John Smith\\other\\x.json'."),
    `Cannot read file '${OUTSIDE_REPOSITORY}'.`,
  );
  assert.equal(
    redactPaths(root, "Cannot read file 'C:\\Users\\John Smith\\repo2\\x.json'."),
    `Cannot read file '${OUTSIDE_REPOSITORY}'.`,
  );
});

test('the real root of a symlinked checkout is replaced too', () => {
  const real = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'seamline-real-'));
  created.push(real);
  const link = nodePath.join(real, 'link to repo');
  fs.mkdirSync(nodePath.join(real, 'actual repo'));
  fs.symlinkSync(nodePath.join(real, 'actual repo'), link, 'dir');
  // The tool was pointed at the link; a message names the file by the resolved path.
  const resolved = fs.realpathSync(link);
  assert.equal(
    redactPaths(link, `Cannot read file '${resolved}/packages/a/x.json'.`),
    "Cannot read file 'packages/a/x.json'.",
  );
  assert.equal(
    redactPaths(link, `Cannot read file '${link}/packages/a/x.json'.`),
    "Cannot read file 'packages/a/x.json'.",
  );
});

test('the same workspace from two checkouts whose paths hold spaces gives the same diagnostics, with no fragment of either path', () => {
  const files: Files = {
    ...packagesOf('ok'),
    'packages/circ/package.json': JSON.stringify({ name: '@fx/circ' }),
    'packages/circ/tsconfig.json': JSON.stringify({ extends: './b.json', include: ['src'] }),
    'packages/circ/b.json': JSON.stringify({ extends: './tsconfig.json' }),
    'packages/circ/src/c.ts': SRC('Circ'),
    'packages/out/package.json': JSON.stringify({ name: '@fx/out' }),
    'packages/out/tsconfig.json': JSON.stringify({
      extends: '../../../outside.json',
      include: ['src'],
    }),
    'packages/out/src/o.ts': SRC('Out'),
    'packages/gone/package.json': JSON.stringify({ name: '@fx/gone' }),
    'packages/gone/tsconfig.json': JSON.stringify({ extends: './missing.json', include: ['src'] }),
    'packages/gone/src/g.ts': SRC('Gone'),
  };
  const outputs = [
    ['sp ace A', 'my repo'],
    ['other dir B', 'my repo'],
    ['sp ace A', 'second repo'],
  ].map(([parentName, rootName], i) => {
    const parent = fs.mkdtempSync(nodePath.join(os.tmpdir(), `seamline-spaces-${i}-`));
    created.push(parent);
    const root = nodePath.join(parent, parentName as string, rootName as string);
    for (const rel of Object.keys(files).sort()) {
      const abs = nodePath.join(root, rel);
      fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, files[rel] ?? '', 'utf8');
    }
    const out = extractCodeTs({ repoRoot: root, repo: 'fx', runId: 'run-1', deterministic: true, dataModelIndex: NO_TABLES_INDEX });
    return { out, parent, parentName: parentName as string, rootName: rootName as string };
  });
  const text = (o: ExtractCodeTsOutput): string =>
    canonicalJson({ r: o.result, n: o.nodes, e: o.edges });
  for (const { out, parent, parentName, rootName } of outputs) {
    assert.deepEqual(unreadNames(out), ['packages/circ', 'packages/gone', 'packages/out']);
    const all = text(out);
    for (const fragment of [
      parent,
      parentName,
      `${parentName}/${rootName}`,
      'ace A',
      'dir B',
      'my repo',
      'second repo',
    ])
      assert.equal(all.includes(fragment), false, `"${fragment}" is in the output`);
    const circular = out.result.diagnostics.find((d) => d.includes('Circularity'));
    assert.ok(circular?.includes('packages/circ/b.json'), String(circular));
    assert.equal(
      circular?.includes(OUTSIDE_REPOSITORY),
      false,
      'a path inside the repository is not outside it',
    );
  }
  // The roots differ in name only, so everything else is the same.
  const [first, second, third] = outputs.map((o) => text(o.out));
  assert.equal(first, second);
  assert.equal(first, third);
});

test('an extends that points outside the repository is not read, names no absolute path, and does not depend on the checkout', () => {
  const build = (
    label: string,
    outside: string,
  ): { out: ExtractCodeTsOutput; root: string; parent: string } => {
    const { root, parent } = materializeIn(
      {
        ...packagesOf('a', 'g'),
        'packages/g/tsconfig.json': JSON.stringify({
          extends: '../../../outside.json',
          include: ['src'],
        }),
      },
      label,
    );
    // Beside the repository, where `../../..` from packages/g lands: what is there must not matter.
    fs.writeFileSync(nodePath.join(parent, 'outside.json'), outside);
    return {
      out: extractCodeTs({ repoRoot: root, repo: 'fx', runId: 'run-1', deterministic: true, dataModelIndex: NO_TABLES_INDEX }),
      root,
      parent,
    };
  };
  const one = build('outside-1', '{ "compilerOptions": { "strict": true } }');
  const two = build('outside-2', '{ "compilerOptions": { "strict": false } }');
  assert.deepEqual(unreadNames(one.out), ['packages/g']);
  for (const { out, root, parent } of [one, two]) {
    const text = canonicalJson({ r: out.result, n: out.nodes, e: out.edges });
    assert.equal(text.includes(root), false, 'the checkout path is not in the output');
    assert.equal(text.includes(parent), false, 'the parent directory is not in the output');
    assert.equal(text.includes(os.tmpdir()), false);
  }
  assert.equal(
    canonicalJson({ r: one.out.result, n: one.out.nodes, e: one.out.edges }),
    canonicalJson({ r: two.out.result, n: two.out.nodes, e: two.out.edges }),
    'the output is the same whatever the file outside the repository holds',
  );
});

test('an absolute extends outside the repository is reported with a fixed token, one inside with its relative path', () => {
  const outside = run(
    {
      ...packagesOf('a', 'g'),
      'packages/g/tsconfig.json': JSON.stringify({ extends: '/definitely/not/here.json' }),
    },
    'abs-outside',
  );
  const line = outside.result.diagnostics.find((d) =>
    d.startsWith('workspace package not read: packages/g:'),
  );
  assert.ok(line?.includes(OUTSIDE_REPOSITORY), String(line));
  assert.equal(line?.includes('/definitely'), false, String(line));

  const { root } = materializeIn(packagesOf('a', 'g'), 'abs-inside');
  fs.writeFileSync(
    nodePath.join(root, 'packages/g/tsconfig.json'),
    JSON.stringify({ extends: nodePath.join(root, 'packages/g/missing.json') }),
  );
  const inside = extractCodeTs({ repoRoot: root, repo: 'fx', runId: 'run-1', deterministic: true, dataModelIndex: NO_TABLES_INDEX });
  const where = inside.result.diagnostics.find((d) =>
    d.startsWith('workspace package not read: packages/g:'),
  );
  assert.ok(where?.includes("'packages/g/missing.json'"), String(where));
  assert.equal(where?.includes(root), false);
});

test('circular extends is reported with repository-relative paths', () => {
  const out = run(
    {
      ...packagesOf('a', 'g'),
      'packages/g/one.json': JSON.stringify({ extends: './two.json' }),
      'packages/g/two.json': JSON.stringify({ extends: './one.json' }),
      'packages/g/tsconfig.json': JSON.stringify({ extends: './one.json', include: ['src'] }),
    },
    'circular',
  );
  const line = out.result.diagnostics.find((d) =>
    d.startsWith('workspace package not read: packages/g:'),
  );
  assert.ok(
    line !== undefined && /Circularity/.test(line) && line.includes('packages/g/one.json'),
    String(line),
  );
  assert.equal(line.includes(os.tmpdir()), false, line);
});

/* ------------------------------------------------------------ 4. strictness */

const LAX_BASE = '@lax/base';

function withBase(extra: Files): Files {
  return { ...packagesOf('a', 'g'), ...extra };
}

test('strict: false with an uninstalled base is not read: the base could turn strictNullChecks on', () => {
  const out = run(
    withBase({
      'packages/g/tsconfig.json': JSON.stringify({
        extends: LAX_BASE,
        compilerOptions: { strict: false },
        include: ['src'],
      }),
    }),
    'strict-false',
  );
  assert.deepEqual(unreadNames(out), ['packages/g']);
});

test('an explicit strictNullChecks in the config itself settles it, whatever an uninstalled base says', () => {
  for (const [value, label] of [
    [true, 'on'],
    [false, 'off'],
  ] as const) {
    const out = run(
      withBase({
        'packages/g/tsconfig.json': JSON.stringify({
          extends: LAX_BASE,
          compilerOptions: { strict: !value, strictNullChecks: value },
          include: ['src'],
        }),
      }),
      `snc-${label}`,
    );
    assert.deepEqual(repoProps(out), WRITE_FACTS, `strictNullChecks ${label} is read`);
    assert.equal(nullableOf(out, '@fx/g#G.email'), value);
  }
});

test('a later entry of an extends array wins: an uninstalled base after a strict one makes it unknown, before it does not', () => {
  const strictBase = JSON.stringify({ compilerOptions: { strict: true } });
  const after = run(
    withBase({
      'packages/g/strict.json': strictBase,
      'packages/g/tsconfig.json': JSON.stringify({
        extends: ['./strict.json', LAX_BASE],
        include: ['src'],
      }),
    }),
    'order-after',
  );
  assert.deepEqual(
    unreadNames(after),
    ['packages/g'],
    'the missing base could set strict: false over it',
  );

  const before = run(
    withBase({
      'packages/g/strict.json': strictBase,
      'packages/g/tsconfig.json': JSON.stringify({
        extends: [LAX_BASE, './strict.json'],
        include: ['src'],
      }),
    }),
    'order-before',
  );
  assert.deepEqual(repoProps(before), WRITE_FACTS);
  assert.equal(nullableOf(before, '@fx/g#G.email'), true, 'the strict base has the last word');
});

test('strict: true in the config itself is read with an uninstalled base, and the run says which base is missing', () => {
  const out = run(
    withBase({
      'packages/g/tsconfig.json': JSON.stringify({
        extends: LAX_BASE,
        compilerOptions: { strict: true },
        include: ['src'],
      }),
    }),
    'strict-true',
  );
  assert.deepEqual(repoProps(out), WRITE_FACTS);
  assert.ok(out.result.diagnostics.some((d) => d.includes(`"${LAX_BASE}" is not installed`)));
});

/* ------------------------------------------------------------ 5. file ownership */

test('a file included by a sibling package is read under the options of the package it lives in', () => {
  const out = run(
    {
      'package.json': JSON.stringify({ name: 'root' }),
      'pnpm-workspace.yaml': PNPM,
      'packages/a/package.json': JSON.stringify({ name: '@fx/a' }),
      'packages/a/tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: false,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['src', '../shared/src'],
      }),
      'packages/a/src/a.ts': 'export class A {\n  n = 1;\n}\n',
      'packages/shared/package.json': JSON.stringify({ name: '@fx/shared' }),
      'packages/shared/tsconfig.json': STRICT,
      'packages/shared/src/shared.ts': SRC('Shared'),
    },
    'owner-sibling',
  );
  assert.equal(symbols(out).filter((s) => s === 'fx:Symbol:@fx/shared#Shared').length, 1);
  assert.equal(
    nullableOf(out, '@fx/shared#Shared.email'),
    true,
    'shared is strict; a is not, and a sorts first',
  );
});

test('of two configs above a file, the one whose directory is nearest decides its options, however they sort', () => {
  const lax = JSON.stringify({
    compilerOptions: {
      strict: false,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
    include: ['src'],
  });
  const files = {
    'package.json': JSON.stringify({ name: 'root' }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/**'\n",
    'packages/a/package.json': JSON.stringify({ name: '@fx/a' }),
    // Includes everything below it, the nested package's files too.
    'packages/a/tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
      },
      include: ['.'],
    }),
    'packages/a/src/a.ts': SRC('A'),
    // `ui` sorts after `tsconfig.json`, so config order alone would give the file to the outer package.
    'packages/a/ui/package.json': JSON.stringify({ name: '@fx/ui' }),
    'packages/a/ui/tsconfig.json': lax,
    'packages/a/ui/src/thing.ts': 'export class UiThing {\n  v: string | null = null;\n}\n',
  };
  const out = run(files, 'owner-nested');
  assert.equal(out.result.status, 'PASS');
  assert.equal(symbols(out).filter((s) => s === 'fx:Symbol:@fx/ui#UiThing').length, 1);
  assert.equal(
    nullableOf(out, '@fx/ui#UiThing.v'),
    false,
    'the nested package is not strict, and its files are read under its own options',
  );
  assert.equal(nullableOf(out, '@fx/a#A.email'), true, 'the outer package keeps its own');
});

test('a config in a subdirectory that reaches up into the package does not decide that package files options', () => {
  const out = run(
    {
      'package.json': JSON.stringify({ name: 'root' }),
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      'apps/web/package.json': JSON.stringify({ name: '@fx/web' }),
      'apps/web/tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.app.json' }, { path: './e2e' }],
      }),
      'apps/web/tsconfig.app.json': STRICT,
      'apps/web/e2e/tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: false,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        include: ['../src', '.'],
      }),
      'apps/web/e2e/check.ts': 'export const ok = true;\n',
      'apps/web/src/page.ts': SRC('Page'),
    },
    'owner-e2e',
  );
  assert.equal(out.result.status, 'PASS');
  assert.equal(
    nullableOf(out, '@fx/web#Page.email'),
    true,
    'src belongs to the config that sits above it',
  );
});

/* ---------------------------------------------------------------- 6. glob matcher */

test('a pattern of many consecutive ** finishes at once, and matches what one ** matches', () => {
  const deep = Array.from({ length: 30 }, (_, i) => `s${i}`).join('/');
  const started = performance.now();
  const hit = matchWorkspaceDirs([`${'**/'.repeat(12)}zzz`], [deep, `${deep}/zzz`], []);
  const alternating = matchWorkspaceDirs(
    [`${'a/**/'.repeat(10)}z`],
    [Array.from({ length: 40 }, () => 'a').join('/')],
    [],
  );
  const elapsed = performance.now() - started;
  assert.deepEqual(hit.dirs, [`${deep}/zzz`]);
  assert.deepEqual(alternating.dirs, []);
  assert.ok(elapsed < 500, `matching took ${Math.round(elapsed)} ms`);

  const dirs = ['packages/a', 'packages/a/b', 'packages'];
  assert.deepEqual(
    matchWorkspaceDirs(['packages/**/**'], dirs, []).dirs,
    matchWorkspaceDirs(['packages/**'], dirs, []).dirs,
  );
});

test('a wildcard-heavy segment cannot be made to backtrack', () => {
  const started = performance.now();
  const r = matchWorkspaceDirs(['*a*a*a*a*a*a*a*a*a*a*a*a*b'], ['a'.repeat(200)], []);
  assert.deepEqual(r.dirs, []);
  assert.ok(performance.now() - started < 500);
});

test('syntax the matcher does not implement is reported and counts as an incomplete workspace', () => {
  const dirs = ['packages/a', 'packages/b', 'libs/a'];
  const unsupported = [
    'packages/[ab]',
    'packages/@(a|b)',
    'packages/{a,{b,c}}',
    'packages/{a/b,c}',
    'packages/a\\b',
    `${'x'.repeat(300)}`,
    Array.from({ length: 30 }, (_, i) => `d${i}`).join('/'),
  ];
  for (const pattern of unsupported) {
    const diagnostics: string[] = [];
    const r = matchWorkspaceDirs([pattern, 'libs/*'], dirs, diagnostics);
    assert.deepEqual(
      r.dirs,
      ['libs/a'],
      `the supported pattern still matches (${pattern.slice(0, 30)})`,
    );
    assert.deepEqual(r.incompletePatterns, [shownPattern(pattern)], pattern.slice(0, 30));
    assert.ok(
      diagnostics.some((d) => d.startsWith('workspace pattern not supported')),
      diagnostics.join('|'),
    );
  }
});

test('an unsupported negation is reported but does not make the workspace incomplete', () => {
  const diagnostics: string[] = [];
  const r = matchWorkspaceDirs(['packages/*', '!packages/[ab]'], ['packages/a'], diagnostics);
  assert.deepEqual(r.dirs, ['packages/a']);
  assert.deepEqual(r.incompletePatterns, []);
  assert.ok(diagnostics.some((d) => d.includes('a package it excludes may be read')));
});

test('the supported glob syntax keeps matching', () => {
  const dirs = [
    'apps/web',
    'apps/web/e2e',
    'packages/a',
    'packages/b',
    'packages/ab',
    'tools/x/y',
    'x1',
    'xy',
  ];
  const m = (...patterns: string[]): readonly string[] =>
    matchWorkspaceDirs(patterns, dirs, []).dirs;
  assert.deepEqual(m('apps/*'), ['apps/web']);
  assert.deepEqual(m('apps/**'), ['apps/web', 'apps/web/e2e']);
  assert.deepEqual(m('**/e2e'), ['apps/web/e2e']);
  assert.deepEqual(m('packages/?'), ['packages/a', 'packages/b']);
  assert.deepEqual(m('packages/{a,b}'), ['packages/a', 'packages/b']);
  assert.deepEqual(m('packages/*', '!packages/b'), ['packages/a', 'packages/ab']);
  assert.deepEqual(m('./packages/a/'), ['packages/a']);
  assert.deepEqual(m('packages/a/package.json'), ['packages/a']);
  assert.deepEqual(m('x?'), ['x1', 'xy']);
  assert.deepEqual(m('../x', '/abs'), []);
});

/**
 * What the package managers match, written out: each row is the directories
 * `picomatch` (the matcher pnpm uses) selects when it is given
 * `<pattern>/package.json` and each directory's `package.json`. The table is
 * data, so the test needs no dependency; a negation row is the directories left
 * after the positive pattern `**` and the negation.
 */
const MATCH_DIRS = [
  'packages',
  'packages/a',
  'packages/a/b',
  'packages/ab',
  'packages/@scope/pkg',
  'apps/web',
  'apps/web/e2e',
  'tools/x/test',
  'tools/x/test/y',
  'docs',
  'a/test',
  'a/test/b',
  'test',
  'libs/core',
];

const UNDER_PACKAGES = ['packages/a', 'packages/a/b', 'packages/ab', 'packages/@scope/pkg'];
const NOT_UNDER_TEST = [
  'packages',
  'packages/a',
  'packages/a/b',
  'packages/ab',
  'packages/@scope/pkg',
  'apps/web',
  'apps/web/e2e',
];

const PICOMATCH_ROWS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['packages/*', ['packages/a', 'packages/ab']],
  ['packages/**', ['packages', ...UNDER_PACKAGES]],
  ['packages/*/*', ['packages/a/b', 'packages/@scope/pkg']],
  ['packages/*/**', UNDER_PACKAGES],
  ['packages/**/', ['packages', ...UNDER_PACKAGES]],
  ['packages/**/**', ['packages', ...UNDER_PACKAGES]],
  ['packages/**/b', ['packages/a/b']],
  ['apps/**', ['apps/web', 'apps/web/e2e']],
  ['apps/*/**', ['apps/web', 'apps/web/e2e']],
  ['apps/**/e2e', ['apps/web/e2e']],
  ['**', MATCH_DIRS],
  ['*', ['packages', 'docs', 'test']],
  ['**/*', MATCH_DIRS],
  ['docs', ['docs']],
  ['./docs', ['docs']],
  ['docs/', ['docs']],
  ['packages/a?', ['packages/ab']],
  ['packages/{a,ab}', ['packages/a', 'packages/ab']],
  ['{apps,tools}/*', ['apps/web']],
  ['**/test', ['tools/x/test', 'a/test', 'test']],
  ['**/test/**', ['tools/x/test', 'tools/x/test/y', 'a/test', 'a/test/b', 'test']],
  ['a/**', ['a/test', 'a/test/b']],
  ['a/**/b', ['a/test/b']],
  ['tools/*/test/**', ['tools/x/test', 'tools/x/test/y']],
  ['libs/**', ['libs/core']],
  ['packages/@*/*', ['packages/@scope/pkg']],
];

const PICOMATCH_NEGATIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['!**/test/**', [...NOT_UNDER_TEST, 'docs', 'libs/core']],
  ['!**/test', [...NOT_UNDER_TEST, 'tools/x/test/y', 'docs', 'a/test/b', 'libs/core']],
  [
    '!packages/**',
    [
      'apps/web',
      'apps/web/e2e',
      'tools/x/test',
      'tools/x/test/y',
      'docs',
      'a/test',
      'a/test/b',
      'test',
      'libs/core',
    ],
  ],
  [
    '!packages/*',
    [
      'packages',
      'packages/a/b',
      'packages/@scope/pkg',
      'apps/web',
      'apps/web/e2e',
      'tools/x/test',
      'tools/x/test/y',
      'docs',
      'a/test',
      'a/test/b',
      'test',
      'libs/core',
    ],
  ],
  ['!a/**', [...NOT_UNDER_TEST, 'tools/x/test', 'tools/x/test/y', 'docs', 'test', 'libs/core']],
  ['!tools/*/test/**', [...NOT_UNDER_TEST, 'docs', 'a/test', 'a/test/b', 'test', 'libs/core']],
];

for (const [pattern, expected] of PICOMATCH_ROWS) {
  test(`workspace pattern ${JSON.stringify(pattern)} selects what the package managers select`, () => {
    assert.deepEqual(matchWorkspaceDirs([pattern], MATCH_DIRS, []).dirs, expected);
  });
}

for (const [negation, expected] of PICOMATCH_NEGATIONS) {
  test(`workspace negation ${JSON.stringify(negation)} leaves out what the package managers leave out`, () => {
    assert.deepEqual(matchWorkspaceDirs(['**', negation], MATCH_DIRS, []).dirs, expected);
  });
}

test('a trailing ** matches the directory in front of it: a package at the prefix is discovered, not silently missed', () => {
  const out = run(
    {
      'package.json': JSON.stringify({ name: 'root' }),
      'pnpm-workspace.yaml': "packages:\n  - 'packages/**'\n  - '!**/fixtures/**'\n",
      'packages/package.json': JSON.stringify({ name: '@fx/top' }),
      'packages/tsconfig.json': STRICT,
      'packages/src/top.ts': SRC('Top'),
      'packages/a/package.json': JSON.stringify({ name: '@fx/a' }),
      'packages/a/tsconfig.json': STRICT,
      'packages/a/src/a.ts': SRC('A'),
      'packages/fixtures/package.json': JSON.stringify({ name: '@fx/fixtures' }),
      'packages/fixtures/tsconfig.json': STRICT,
      'packages/fixtures/src/fixtures.ts': SRC('Fixtures'),
    },
    'trailing-star',
  );
  assert.equal(out.result.status, 'PASS');
  assert.ok(symbols(out).includes('fx:Symbol:@fx/top#Top'), 'the package at the prefix is read');
  assert.ok(symbols(out).includes('fx:Symbol:@fx/a#A'));
  assert.equal(
    symbols(out).some((s) => s.includes('@fx/fixtures')),
    false,
    'a package the negation excludes, at the excluded directory itself, is not read',
  );
});

test('a pattern is quoted in output by its first characters and a count, whatever its length', () => {
  const huge = `[${'x'.repeat(2_000_000)}`;
  const out = run(
    {
      ...packagesOf('a'),
      'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*', huge] }),
      'pnpm-workspace.yaml': PNPM,
    },
    'big-pattern',
  );
  assert.equal(out.result.status, 'PASS');
  const shown = `[${'x'.repeat(79)}... (${huge.length - 80} more characters)`;
  assert.deepEqual(unreadNames(out), [`pattern:${shown}`]);
  assert.equal(repoProps(out)?.['unreadCodePackageCount'], 1);
  assert.ok(out.result.diagnostics.some((d) => d.includes(shown)));
  assert.ok(
    canonicalJson({ r: out.result, n: out.nodes, e: out.edges }).length < 100_000,
    'a 2 MB pattern does not make a 2 MB output',
  );
  // Two long patterns that share their first characters are still two unread entries.
  const twin = run(
    {
      ...packagesOf('a'),
      'package.json': JSON.stringify({
        name: 'root',
        workspaces: ['packages/*', `[${'y'.repeat(200)}1`, `[${'y'.repeat(200)}2`],
      }),
      'pnpm-workspace.yaml': PNPM,
    },
    'twin-pattern',
  );
  assert.equal(repoProps(twin)?.['unreadCodePackageCount'], 2);
  // Short patterns are written as they are.
  assert.equal(shownPattern('libs/[ab]'), 'libs/[ab]');
  assert.equal(shownPattern('x'.repeat(80)), 'x'.repeat(80));
});

test('a workspace with an unsupported pattern reads the rest and names the pattern as unread', () => {
  const out = run(
    { ...packagesOf('a'), 'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'libs/[ab]'\n" },
    'pattern',
  );
  assert.equal(out.result.status, 'PASS');
  assert.ok(symbols(out).includes('fx:Symbol:@fx/a#A'));
  assert.deepEqual(unreadNames(out), ['pattern:libs/[ab]']);
  assert.equal(repoProps(out)?.['unreadCodePackageCount'], 1);
  assert.ok(out.result.diagnostics.some((d) => d.startsWith('workspace pattern not supported')));
});

/* ----------------------------------------------- 11. names that look like separators */

test('a package directory with a comma in its name is one name, not two', () => {
  const dir = 'packages/a,b';
  const files = {
    ...packagesOf('a'),
    [`${dir}/package.json`]: JSON.stringify({ name: '@fx/comma' }),
    [`${dir}/tsconfig.json`]: '{ "compilerOptions": ',
  };
  const out = run(files, 'comma');
  assert.deepEqual(unreadNames(out), [dir]);
  assert.equal(repoProps(out)?.['unreadCodePackageCount'], 1);
});

/* --------------------------------------------- 7. root mode names what it did not load */

const ROOT_MODE = {
  'package.json': JSON.stringify({ name: 'root' }),
  'good/tsconfig.json': STRICT,
  'good/src/good.ts': SRC('Good'),
};

test('a referenced project that cannot be loaded is named on the Repo node', () => {
  const out = run(
    {
      ...ROOT_MODE,
      'tsconfig.json': JSON.stringify({
        files: [],
        references: [{ path: './good' }, { path: './bad' }],
      }),
      'bad/tsconfig.json': '{ "compilerOptions": ',
      'bad/src/bad.ts': SRC('Bad'),
    },
    'root-ref',
  );
  assert.equal(out.result.status, 'PASS');
  assert.ok(
    out.result.diagnostics.some((d) => d.startsWith('referenced project could not be loaded')),
  );
  assert.deepEqual(unreadNames(out), ['bad']);
  assert.equal(repoProps(out)?.['unreadCodePackageCount'], 1);
  assert.equal(
    out.result.diagnostics.join('\n').includes(os.tmpdir()),
    false,
    'no absolute path in a root-mode diagnostic either',
  );
});

test('a discovered project that cannot be loaded is named on the Repo node', () => {
  const out = run(
    {
      ...ROOT_MODE,
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true }, include: ['good/src'] }),
      'tools/tsconfig.json': '{ "compilerOptions": ',
      'tools/run.ts': 'export const run = 1;\n',
    },
    'root-discovered',
  );
  assert.equal(out.result.status, 'PASS');
  assert.deepEqual(unreadNames(out), ['tools']);
});

test('a root run whose projects all load marks nothing as unread', () => {
  const out = run(
    {
      ...ROOT_MODE,
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './good' }] }),
    },
    'root-clean',
  );
  assert.deepEqual(repoProps(out), WRITE_FACTS);
});
