/**
 * The freeze watches the code that decides what a finding is. This test works out what that
 * code is, from the imports, and fails when the watch list stops covering it.
 *
 * Starting points: every production source of the detectors, `infer-join` and the extractors;
 * the CLI's entry (`index.ts`, the file the harness runs) with the `extract` and `check` commands
 * and the wiring that builds them; and the harness files that build the CLI and run it on a
 * repository. From each, every module that is LOADED is followed (see `test-trace.ts`): every
 * import that is not `import type`, every `export * from` and `export { } from`, and a literal
 * `import()` or `require()`. A module counts when it is loaded, not when one of its exports is
 * called, because its top level runs either way. Only types are not followed.
 *
 * Every file reached must be covered by `FREEZE_WATCHED_PATHS`, or be listed in
 * `FREEZE_UNWATCHED_ON_PATH` with its reason. So a detector that starts to import something from
 * `core/src/semantic` fails here until the freeze is told about it, and so does a harness file
 * that starts to import a scorer.
 *
 * The trace also fails, rather than guess, on what it cannot follow: an `import()` or
 * `require()` whose target is not a literal, a relative or `@seamline/*` specifier that does not
 * resolve to a source file (resolved through each `package.json` `exports` to `src`, never
 * through `dist`), and a `createRequire` that is not listed here with its reason.
 *
 * What it cannot see is a file read at run time, so a last test requires every tracked file under
 * `packages/*` outside `src` to be a manifest, a compiler configuration or a document, and every
 * data file inside `src` to be watched. What no test can cover is listed in `eval/README.md`
 * ("What a freeze cannot see").
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OWN_CLI } from './build.ts';
import {
  FREEZE_UNWATCHED_ON_PATH,
  FREEZE_WATCHED_PATHS,
  isWatched,
  matchesPathspec,
} from './freeze.ts';
import { runGit } from './git.ts';
import { traceValueImports, type Trace } from './test-trace.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const STARTS = (all: readonly string[]): string[] => [
  ...all.filter((f) => /^packages\/(contradictions|infer-join|extract-[^/]+)\/src\//.test(f)),
  'packages/cli/src/index.ts',
  ...['commands/extract.ts', 'commands/check.ts', 'wiring.ts'].map((f) => `packages/cli/src/${f}`),
  'packages/eval/src/analyse.ts',
  'packages/eval/src/build.ts',
  'packages/eval/src/corpus.ts',
];

/**
 * Each use of `createRequire` in a traced file, with why the freeze is still sound. A new one
 * fails the test until it is listed. The trace follows the `require` it makes, so only a literal
 * target is accepted; this list says why a bare package name needs no further watch.
 */
const CREATE_REQUIRE_REASONS: Readonly<Record<string, string>> = {
  'packages/extract-contracts/src/zod.ts':
    "loads `typescript`, the optional peer dependency, by the literal name 'typescript'. Which " +
    'version loads is decided by the lockfile and the manifests, which the freeze watches. It is ' +
    'a bare package name, so no repository file is loaded this way.',
};

test('every source the detectors, extractors, the CLI entry, the extract and check commands and the harness run definition load is watched by the freeze or listed with a reason', () => {
  const { reached, dynamic, unresolved } = traceValueImports({ root: ROOT, starts: STARTS });
  assert.ok(reached.size > 150, `the trace reached only ${reached.size} files`);
  assert.ok(
    reached.has('packages/core/src/store/sqlite-store.ts') &&
      reached.has('packages/cli/src/scopes.ts') &&
      reached.has('packages/eval/src/pipeline.ts'),
    'the trace follows imports through the package barrels and into the harness',
  );
  assert.ok(
    reached.has('packages/core/src/index.ts'),
    'the barrel a name is imported through is reached, not only the file that declares it',
  );
  assert.ok(
    reached.has('packages/core/src/traversal/bounds.ts') &&
      reached.has('packages/cli/src/commands/why.ts') &&
      reached.has('packages/mcp/src/server.ts'),
    'a module that is loaded but none of whose exports is called is reached: the dispatcher names ' +
      'every command, the root barrel re-exports traversal, and the mcp command imports the server',
  );

  assert.deepEqual(
    dynamic,
    [],
    'a dynamic import() or require() with a target that is not a literal cannot be traced',
  );
  assert.deepEqual(
    unresolved,
    [],
    'a relative or @seamline/* specifier that does not resolve to a source file cannot be traced',
  );

  const unaccounted = [...reached]
    .filter((f) => !isWatched(f) && !(f in FREEZE_UNWATCHED_ON_PATH))
    .sort();
  assert.deepEqual(
    unaccounted,
    [],
    'loaded by the traced path, but neither in FREEZE_WATCHED_PATHS nor in FREEZE_UNWATCHED_ON_PATH',
  );

  // The list of exceptions stays true: each is on the path (else it needs no entry) and not watched.
  for (const file of Object.keys(FREEZE_UNWATCHED_ON_PATH)) {
    assert.ok(reached.has(file), `${file} is listed as unwatched but is not on the path`);
    assert.ok(!isWatched(file), `${file} is both watched and listed as unwatched`);
  }

  // What the freeze deliberately leaves out of core is not loaded.
  assert.deepEqual(
    [...reached].filter((f) => /^packages\/core\/src\/semantic\//.test(f)),
    [],
  );
  // Nor is any scorer: the report and the metrics only read what the run produced.
  assert.deepEqual(
    [...reached].filter((f) =>
      /^packages\/eval\/src\/(report|metrics|labels|evaluate|freeze)\.ts$/.test(f),
    ),
    [],
  );
});

test('every createRequire in a traced file is listed with its reason, and every listed one is used', () => {
  const { createRequire } = traceValueImports({ root: ROOT, starts: STARTS });
  const files = [...new Set(createRequire.map((use) => use.slice(0, use.lastIndexOf(':'))))].sort();
  assert.deepEqual(
    files,
    Object.keys(CREATE_REQUIRE_REASONS).sort(),
    'createRequire loads what the static imports do not show: list the file with a reason',
  );
});

test('the loaded-module rule counts a type-only specifier as erased only because the repository compiles with verbatimModuleSyntax', async () => {
  const base = JSON.parse(await readFile(path.join(ROOT, 'tsconfig.base.json'), 'utf8')) as {
    compilerOptions?: Record<string, unknown>;
  };
  assert.equal(
    base.compilerOptions?.['verbatimModuleSyntax'],
    true,
    'without it `import { type T } from` is elided, and the trace would over-report; with another setting the rule must be re-derived',
  );
});

test('the files the harness runs and dispatches through are watched', () => {
  // The harness runs `dist/index.js`; its source is the entry, and the entry dispatches through
  // `run.ts`. Name them, so a change to the trace's starting points cannot drop them silently.
  const entry = OWN_CLI.slice(0, -2).concat('src', 'index.ts').join('/');
  assert.equal(entry, 'packages/cli/src/index.ts');
  // The sandbox host and the extractor programs decide which extractor code runs and how, so they
  // decide which facts exist: they are watched, not excused.
  const decide = [
    'packages/cli/src/sandbox/host.ts',
    'packages/cli/src/sandbox/child.ts',
    'packages/cli/src/extractors/data.ts',
  ];
  for (const file of [entry, 'packages/cli/src/run.ts', 'packages/core/src/index.ts', ...decide]) {
    assert.ok(isWatched(file), `${file} is not watched`);
  }
});

/** Tracked files, and untracked ones that are not ignored (a file added in this change counts). */
const LISTING = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];

test('every watched path covers a file in the repository, and agrees with the pathspecs git is given', async () => {
  const tracked = (await runGit(LISTING, ROOT)).split('\0').filter((f) => f !== '');
  for (const spec of FREEZE_WATCHED_PATHS) {
    assert.ok(
      tracked.some((f) => matchesPathspec(spec, f)),
      `${spec} covers no tracked file`,
    );
  }
  const byGit = new Set(
    (await runGit([...LISTING, '--', ...FREEZE_WATCHED_PATHS], ROOT))
      .split('\0')
      .filter((f) => f !== ''),
  );
  const byHarness = new Set(tracked.filter((f) => isWatched(f)));
  assert.deepEqual(
    [...byHarness].filter((f) => !byGit.has(f)).sort(),
    [],
    'watched by isWatched but not by git',
  );
  assert.deepEqual(
    [...byGit].filter((f) => !byHarness.has(f)).sort(),
    [],
    'watched by git but not by isWatched',
  );
});

/**
 * What may sit in a package directory outside `src`: nothing a module can read at run time, except
 * the public corpora of `@seamline/security`, which are JSON test data that only its tests load.
 */
const OUTSIDE_SRC =
  /^packages\/(?:[^/]+\/(?:package\.json|tsconfig[^/]*\.json|README[^/]*|NOTICE[^/]*|LICENSE[^/]*|CHANGELOG[^/]*)|security\/corpus\/[^/]+\.json)$/;

test('no file a module could read at run time sits in a package outside src, or unwatched inside it', async () => {
  const files = (await runGit([...LISTING, '--', 'packages'], ROOT))
    .split('\0')
    .filter((f) => f !== '');
  const isSource = (f: string): boolean => /^packages\/[^/]+\/src\//.test(f);
  assert.deepEqual(
    files.filter((f) => !isSource(f) && !OUTSIDE_SRC.test(f)),
    [],
    'a data file outside src is read by the trace of no import and watched by no list: put it ' +
      'under src (and the freeze watches the directory) or add it to FREEZE_WATCHED_PATHS',
  );
  assert.deepEqual(
    files.filter(
      (f) =>
        isSource(f) &&
        !f.endsWith('.ts') &&
        !f.includes('/__fixtures__/') &&
        !/\.test\.(ts|mjs)$/.test(f) &&
        !isWatched(f),
    ),
    [],
    'a data file or script under src that is not watched',
  );
});

async function fixtureProject(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'seamline-trace-'));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  }
  return root;
}

async function traced(
  files: Readonly<Record<string, string>>,
  start = 'packages/b/src/start.ts',
): Promise<Trace> {
  const root = await fixtureProject(files);
  try {
    return traceValueImports({ root, starts: () => [start] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const FIXTURE = {
  'packages/a/src/index.ts':
    "export { used } from './used.ts';\nexport { other } from './other.ts';\n",
  'packages/a/src/used.ts': 'export const used = 1;\n',
  'packages/a/src/other.ts': 'export const other = 2;\n',
  'packages/a/src/types.ts': 'export interface T { x: number }\n',
  'packages/a/src/later.ts': 'export const later = 3;\n',
  'packages/b/src/start.ts':
    "import { used } from '@seamline/a';\nimport type { T } from '../../a/src/types.ts';\nexport const s: T = { x: used };\n",
};

test('the trace counts a module as reached when it is loaded: a barrel brings in everything it re-exports, used or not; only a type-only import is skipped', async () => {
  const t = await traced(FIXTURE);
  assert.deepEqual(
    [...t.reached].sort(),
    [
      'packages/a/src/index.ts',
      'packages/a/src/other.ts',
      'packages/a/src/used.ts',
      'packages/b/src/start.ts',
    ],
    '`other.ts` is loaded by the barrel although nothing imports `other`; `types.ts` is a type-only import',
  );
  assert.deepEqual(t.dynamic, []);
  assert.deepEqual(t.unresolved, []);
});

test('the trace follows a side-effect import, an export star, a named re-export and an import that only names types', async () => {
  const t = await traced({
    ...FIXTURE,
    'packages/a/src/effect.ts': 'globalThis.effect = 1;\nexport {};\n',
    'packages/a/src/star.ts': 'export const star = 1;\n',
    'packages/a/src/named.ts': 'export const named = 1;\n',
    'packages/a/src/inline.ts': 'export interface Shape { x: number }\nexport const inline = 1;\n',
    'packages/a/src/ns.ts': 'export const ns = 1;\n',
    'packages/b/src/start.ts': [
      "import '../../a/src/effect.ts';",
      "export * from '../../a/src/star.ts';",
      "export { named } from '../../a/src/named.ts';",
      "export * as space from '../../a/src/ns.ts';",
      "import { type Shape } from '../../a/src/inline.ts';",
      'export type Alias = Shape;',
      '',
    ].join('\n'),
  });
  assert.deepEqual(
    [...t.reached].sort(),
    [
      'packages/a/src/effect.ts',
      'packages/a/src/inline.ts',
      'packages/a/src/named.ts',
      'packages/a/src/ns.ts',
      'packages/a/src/star.ts',
      'packages/b/src/start.ts',
    ],
    '`import { type Shape }` still loads the module under verbatimModuleSyntax',
  );
});

test('the trace skips import type, export type and export type *', async () => {
  const t = await traced({
    ...FIXTURE,
    'packages/b/src/start.ts': [
      "import type { T } from '../../a/src/types.ts';",
      "import type * as All from '../../a/src/used.ts';",
      "export type { T as U } from '../../a/src/types.ts';",
      "export type * from '../../a/src/other.ts';",
      'export type V = T | typeof All;',
      '',
    ].join('\n'),
  });
  assert.deepEqual([...t.reached], ['packages/b/src/start.ts']);
  assert.deepEqual(t.unresolved, []);
});

test('the trace follows a relative literal import() to its target', async () => {
  const t = await traced({
    ...FIXTURE,
    'packages/b/src/start.ts':
      "export const load = async () => (await import('../../a/src/later.ts')).later;\n",
  });
  assert.deepEqual(
    [...t.reached].sort(),
    ['packages/a/src/later.ts', 'packages/b/src/start.ts'],
    'a dynamic import with a literal target is a dependency',
  );
  assert.deepEqual(t.dynamic, []);
});

test('the trace reports an import() or require() whose target is not a literal, with its line', async () => {
  const t = await traced({
    ...FIXTURE,
    'packages/b/src/start.ts': [
      'declare const require: (id: string) => unknown;',
      'export const load = (name: string) => import(name);',
      "const fixed = require('../../a/src/later.ts');",
      'export const pick = (name: string) => require(`./${name}.ts`);',
      'void fixed;',
      '',
    ].join('\n'),
  });
  assert.deepEqual(t.dynamic, ['packages/b/src/start.ts:2', 'packages/b/src/start.ts:4']);
  assert.ok(t.reached.has('packages/a/src/later.ts'), 'the literal require() is still followed');
});

test('the trace reports a relative or @seamline specifier that resolves to no source file, with file, line and specifier', async () => {
  const t = await traced({
    ...FIXTURE,
    'packages/b/src/start.ts': [
      "import { used } from '@seamline/a';",
      "import { gone } from './gone.ts';",
      "import { sneak } from '@seamline/a/sneaky';",
      "import { inner } from '#inner';",
      "import { lodash } from 'some-package';",
      "import { readFileSync } from 'node:fs';",
      'export const s = [used, gone, sneak, inner, lodash, readFileSync];',
      '',
    ].join('\n'),
  });
  assert.deepEqual(t.unresolved, [
    'packages/b/src/start.ts:2 ./gone.ts',
    'packages/b/src/start.ts:3 @seamline/a/sneaky',
    'packages/b/src/start.ts:4 #inner',
  ]);
});

test('an @seamline/<pkg>/<subpath> import resolves through the package.json exports to the source file, with no dist/ built', async () => {
  const files = {
    ...FIXTURE,
    'packages/a/package.json': JSON.stringify({
      name: '@seamline/a',
      exports: {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './sneaky': { types: './dist/deep/sneaky.d.ts', default: './dist/deep/sneaky.js' },
        './listed-but-absent': { default: './dist/absent.js' },
      },
    }),
    'packages/a/src/deep/sneaky.ts': 'export const sneak = 1;\n',
    'packages/b/src/start.ts':
      "import { sneak } from '@seamline/a/sneaky';\nexport const s = sneak;\n",
  };
  const t = await traced(files);
  assert.deepEqual(t.unresolved, []);
  assert.deepEqual(
    [...t.reached].sort(),
    ['packages/a/src/deep/sneaky.ts', 'packages/b/src/start.ts'],
    'the subpath resolved to its source, not to dist/ (which does not exist here)',
  );

  const absent = await traced({
    ...files,
    'packages/b/src/start.ts':
      "import { x } from '@seamline/a/listed-but-absent';\nexport const s = x;\n",
  });
  assert.deepEqual(
    absent.unresolved,
    ['packages/b/src/start.ts:1 @seamline/a/listed-but-absent'],
    'an exports entry whose source file is absent does not resolve',
  );
});

test('the trace reports every createRequire, under any name, and follows the require it makes', async () => {
  const aliased = await traced({
    ...FIXTURE,
    'packages/b/src/start.ts': [
      "import { createRequire as make } from 'node:module';",
      'const load = make(import.meta.url);',
      "export const later = load('../../a/src/later.ts');",
      '',
    ].join('\n'),
  });
  assert.deepEqual(aliased.createRequire, ['packages/b/src/start.ts:2']);
  assert.ok(aliased.reached.has('packages/a/src/later.ts'), 'the require it made is followed');
  assert.deepEqual(aliased.dynamic, []);

  const namespaced = await traced({
    ...FIXTURE,
    'packages/b/src/start.ts': [
      "import * as nodeModule from 'node:module';",
      'const req = nodeModule.createRequire(import.meta.url);',
      'export const pick = (name: string) => req(name);',
      '',
    ].join('\n'),
  });
  assert.deepEqual(namespaced.createRequire, ['packages/b/src/start.ts:2']);
  assert.deepEqual(
    namespaced.dynamic,
    ['packages/b/src/start.ts:3'],
    'a require made by createRequire with a target that is not a literal is dynamic',
  );

  const bare = await traced({
    ...FIXTURE,
    'packages/b/src/start.ts': [
      "import { createRequire } from 'node:module';",
      "export const ts = createRequire(import.meta.url)('typescript');",
      '',
    ].join('\n'),
  });
  assert.deepEqual(bare.createRequire, ['packages/b/src/start.ts:2']);
  assert.deepEqual(bare.dynamic, []);
  assert.deepEqual(bare.unresolved, [], 'a bare package name is not a repository file');
});
