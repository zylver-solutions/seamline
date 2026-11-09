/**
 * `pnpm eval` through its real entry point, as a subprocess.
 *
 * The unit tests of `buildLabelSheet` pass a `FreezeState` in directly, so they cannot see
 * what the command does with `eval/FREEZE` before it gets that far. These run `bin.ts` itself.
 * The entry point derives the repository root from its own location, so the test copies the
 * harness sources into a throwaway repository and runs the copy: that is how `eval/FREEZE`
 * and `eval/corpus.json` can be controlled without touching the real working tree. The
 * repository is a small monorepo that builds with the real compiler, because a sealed label
 * sheet builds it and names what it built.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildProduct, cliIdentity, ownCliPath } from './build.ts';
import { codeIdentity } from './freeze.ts';
import { finding, commitFiles, makeTempDir, removeDir, writeMiniMonorepo } from './testing.ts';

const SRC = import.meta.dirname;
const PACKAGE_NODE_MODULES = path.resolve(SRC, '..', 'node_modules');

const DEV_SHA = 'd'.repeat(40);
const SEALED_SHA = 'e'.repeat(40);

const CORPUS = [
  ['devrepo', 'dev', DEV_SHA],
  ['sealedrepo', 'sealed', SEALED_SHA],
].map(([name, partition, sha]) => ({
  name,
  url: `https://example.invalid/${name}`,
  sha,
  license: 'MIT',
  partition,
  stacks: ['prisma'],
  why: 'fixture',
}));

const DEV_FINDING = finding(
  'devrepo',
  'X1_NULLABILITY',
  'devrepo:Column:public.t.a',
  'devrepo:SchemaProperty:T.a',
);
const SEALED_FINDING = finding(
  'sealedrepo',
  'X2_TYPE',
  'sealedrepo:Column:public.t.b',
  'sealedrepo:SchemaProperty:T.b',
);

interface Tree {
  readonly root: string;
  readonly bin: string;
  readonly out: string;
  readonly commit: string;
}

/** What a stored baseline says made it: nothing (a dev repository), this build, or older code. */
type Made = 'nothing' | 'this-build' | 'older-code';

/**
 * A throwaway monorepo with a copy of the harness, a two-repository corpus, and a stored baseline
 * (one finding) for each repository. `eval/FREEZE` holds `freeze`, or is absent for null, and
 * names the commit that holds the harness copy. A sealed sheet is built for the sources and the
 * build of this tree, so `made` says what the stored baselines record.
 */
async function tree(
  freeze: ((commit: string) => string) | null,
  made: Made = 'nothing',
): Promise<Tree> {
  const root = await makeTempDir();
  const files: Record<string, string> = {
    'package.json': '{"type":"module"}\n',
    'eval/corpus.json': `${JSON.stringify(CORPUS)}\n`,
  };
  for (const name of await readdir(SRC)) {
    if (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'testing.ts') {
      files[`packages/eval/src/${name}`] = await readFile(path.join(SRC, name), 'utf8');
    }
  }
  await writeMiniMonorepo(root, 'before');
  const commit = await commitFiles(root, files, 'tree');
  await symlink(PACKAGE_NODE_MODULES, path.join(root, 'packages', 'eval', 'node_modules'), 'dir');

  let identity: Record<string, unknown> = {};
  if (made !== 'nothing') {
    await buildProduct(root);
    identity = {
      codeId: made === 'this-build' ? await codeIdentity(root) : 'older-code',
      cli: await cliIdentity(root, ownCliPath(root)),
    };
  }
  const out = path.join(root, 'out');
  for (const [name, sha, f] of [
    ['devrepo', DEV_SHA, DEV_FINDING],
    ['sealedrepo', SEALED_SHA, SEALED_FINDING],
  ] as const) {
    await mkdir(path.join(out, name), { recursive: true });
    await writeFile(
      path.join(out, name, 'baseline.json'),
      JSON.stringify({ sha, ...identity, pipeline: { outcome: 'complete', findings: [f] } }),
      'utf8',
    );
  }
  if (freeze !== null) await writeFile(path.join(root, 'eval', 'FREEZE'), freeze(commit), 'utf8');
  return { root, bin: path.join(root, 'packages', 'eval', 'src', 'bin.ts'), out, commit };
}

interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(t: Tree, ...args: string[]): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        t.bin,
        ...args,
        '--out',
        t.out,
      ],
      {
        cwd: t.root,
        env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? t.root },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('a dev repository has a label sheet whether eval/FREEZE is absent, malformed, or names a missing commit', async () => {
  const cases: ReadonlyArray<[string, ((commit: string) => string) | null]> = [
    ['absent', null],
    ['garbage', () => 'garbage\n'],
    ['a commit this repository does not have', () => `${'b'.repeat(40)}\n`],
  ];
  for (const [name, freeze] of cases) {
    const t = await tree(freeze);
    try {
      // A dev sheet builds nothing: it works where the compiler is not installed.
      await rm(path.join(t.root, 'node_modules', 'typescript'));
      const r = await run(t, 'label-sheet', 'devrepo');
      assert.equal(r.code, 0, `FREEZE ${name}: ${r.stderr}`);
      assert.ok(r.stdout.includes(DEV_FINDING.id), `FREEZE ${name}: the sheet lists the finding`);
      assert.equal(r.stderr, '', `FREEZE ${name}`);
    } finally {
      await removeDir(t.root);
    }
  }
});

test('a sealed repository has no label sheet without eval/FREEZE, and a malformed one is an error', async () => {
  const absent = await tree(null);
  try {
    const r = await run(absent, 'label-sheet', 'sealedrepo');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /sealed partition/);
    assert.match(r.stderr, /eval\/FREEZE does not exist/);
    assert.ok(!r.stdout.includes(SEALED_FINDING.id), 'no sealed finding was printed');
  } finally {
    await removeDir(absent.root);
  }
  const garbage = await tree(() => 'garbage\n');
  try {
    const r = await run(garbage, 'label-sheet', 'sealedrepo');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /eval\/FREEZE must hold exactly one full 40-character/);
    assert.equal(r.stdout, '');
  } finally {
    await removeDir(garbage.root);
  }
});

test('a sealed repository has a label sheet only while the partition is frozen', async () => {
  const frozen = await tree((commit) => `${commit}\n`, 'this-build');
  try {
    const r = await run(frozen, 'label-sheet', 'sealedrepo');
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(SEALED_FINDING.id));
    await writeFile(
      path.join(frozen.root, 'packages', 'contradictions', 'src', 'index.ts'),
      'export const MESSAGE = "changed";\n',
      'utf8',
    );
    const burned = await run(frozen, 'label-sheet', 'sealedrepo');
    assert.equal(burned.code, 2);
    assert.match(burned.stderr, /burned/);
    assert.ok(!burned.stdout.includes(SEALED_FINDING.id));
  } finally {
    await removeDir(frozen.root);
  }
});

test('a sealed label sheet is built from a baseline that the current sources and build made', async () => {
  const stale = await tree((commit) => `${commit}\n`, 'older-code');
  try {
    const r = await run(stale, 'label-sheet', 'sealedrepo');
    assert.equal(r.code, 2);
    assert.match(
      r.stderr,
      /cannot be used for this sheet: it was made by other detector or extractor sources/,
    );
    assert.ok(!r.stdout.includes(SEALED_FINDING.id), 'the stale baseline was not shown');
    assert.ok(!r.stderr.includes(SEALED_FINDING.id));
  } finally {
    await removeDir(stale.root);
  }
});

test('a sealed label sheet rebuilds first: the compiler runs, and a tree that cannot build gets no sheet', async () => {
  const frozen = await tree((commit) => `${commit}\n`, 'this-build');
  try {
    await rm(path.join(frozen.root, 'node_modules', 'typescript'));
    const r = await run(frozen, 'label-sheet', 'sealedrepo');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Run `pnpm install` first/);
    assert.ok(!r.stdout.includes(SEALED_FINDING.id));
  } finally {
    await removeDir(frozen.root);
  }
});

test('--cli with a directory is a configuration error (exit 2), not a harness failure (exit 3)', async () => {
  const t = await tree(null);
  try {
    await writeFile(path.join(t.root, 'eval', 'labels.json'), '{}\n', 'utf8');
    await writeFile(path.join(t.root, 'eval', 'mutants.json'), '[]\n', 'utf8');
    const r = await run(t, '--repo', 'devrepo', '--no-mutants', '--cli', path.join(t.root, 'eval'));
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /is not a file/);
    assert.doesNotMatch(r.stderr, /unexpected failure|EISDIR/);
  } finally {
    await removeDir(t.root);
  }
});

test("a sealed label sheet is refused a CLI that is not this repository's own build", async () => {
  const frozen = await tree((commit) => `${commit}\n`, 'this-build');
  try {
    const other = path.join(frozen.root, 'other-cli.mjs');
    await writeFile(other, 'process.exit(0);\n', 'utf8');
    const r = await run(frozen, 'label-sheet', 'sealedrepo', '--cli', other);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /measured only with this repository's own built CLI/);
    assert.ok(!r.stdout.includes(SEALED_FINDING.id));
  } finally {
    await removeDir(frozen.root);
  }
});
