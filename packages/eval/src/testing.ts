/**
 * Helpers for the harness's own tests. No network and no real corpus: a tiny
 * local git repository stands in for a pinned checkout, and a few lines of
 * JavaScript stand in for the `seamline` CLI.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGit } from './git.ts';
import type { Finding } from './types.ts';
import { findingId } from './findings.ts';

export async function makeTempDir(prefix = 'seamline-eval-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

const IDENTITY = [
  '-c',
  'user.name=Eval Test',
  '-c',
  'user.email=eval-test@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/** Creates a repository at `dir` with one commit holding `files`. Returns the commit id. */
export async function commitFiles(
  dir: string,
  files: Readonly<Record<string, string>>,
  message: string,
  init = false,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  if (init) await runGit(['init', '-q'], dir);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  await runGit(['add', '-A'], dir);
  await runGit([...IDENTITY, 'commit', '-q', '--allow-empty', '-m', message], dir);
  return (await runGit(['rev-parse', 'HEAD'], dir)).trim();
}

/**
 * A stand-in for `dist/index.js`. It reads `fake.json` from the tree it is
 * pointed at and prints what a real run would: an extract report and a check
 * report. `fake.json` fields:
 *
 *   crash        exit 3 with a message on stderr
 *   sleepMs      sleep before answering (to exercise the timeout)
 *   results      the extractor results to report
 *   degraded     degraded scope names
 *   contradictions, unknown   the check report
 *   nodes, edges maps of kind to count, written to the run snapshot
 *
 * Every invocation appends its command to \`invocations.log\` beside the script, so a test can
 * tell a run that reached the CLI from one that did not.
 */
export const FAKE_CLI_SOURCE = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const [command, ...rest] = process.argv.slice(2);
appendFileSync(new URL('./invocations.log', import.meta.url), command + '\\n');
const arg = (name) => rest[rest.indexOf(name) + 1];
const repo = arg('--repo');
const out = arg('--store');
const spec = JSON.parse(readFileSync(repo + '/fake.json', 'utf8'));
if (spec.crash) { process.stderr.write('simulated crash\\n'); process.exit(3); }
if (spec.sleepMs) await new Promise((resolve) => setTimeout(resolve, spec.sleepMs));
if (command === 'extract') {
  mkdirSync(out + '/runs', { recursive: true });
  const lines = ['{"t":"sif"}'];
  for (const [kind, n] of Object.entries(spec.nodes ?? {})) {
    for (let i = 0; i < n; i += 1) lines.push(JSON.stringify({ t: 'node', node: { kind, id: kind + i } }));
  }
  for (const [kind, n] of Object.entries(spec.edges ?? {})) {
    for (let i = 0; i < n; i += 1) lines.push(JSON.stringify({ t: 'edge', edge: { kind } }));
  }
  writeFileSync(out + '/runs/run-fixture-0001.sif', lines.join('\\n') + '\\n');
  process.stdout.write(JSON.stringify({
    runId: 'run-fixture-0001',
    results: spec.results ?? [],
    degradedScopes: spec.degraded ?? [],
  }));
  process.exit((spec.results ?? []).some((r) => r.status === 'FAIL') ? 1 : 0);
} else if (command === 'check') {
  process.stdout.write(JSON.stringify({
    outcome: 'findings',
    contradictions: spec.contradictions ?? [],
    unknownDetectors: spec.unknown ?? [],
    degradedScopes: (spec.degraded ?? []).map((scope) => ({ scope })),
  }));
  process.exit(0);
} else {
  process.stderr.write('unknown command ' + command + '\\n');
  process.exit(2);
}
`;

/** Writes the fake CLI to `dir/<name>` (default `fake-cli.mjs`) and returns its path. */
export async function writeFakeCli(dir: string, name = 'fake-cli.mjs'): Promise<string> {
  const file = path.join(dir, ...name.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, FAKE_CLI_SOURCE, 'utf8');
  return file;
}

/**
 * Writes the fake CLI where this repository's own build would be (`packages/cli/dist/index.js`
 * under `root`), which is the only CLI a sealed repository is measured with. The file has no
 * `package.json` above it, so Node detects its ES module syntax.
 */
export function writeOwnFakeCli(root: string): Promise<string> {
  return writeFakeCli(root, 'packages/cli/dist/index.js');
}

/** The commands a fake CLI has been invoked with, in order. */
export async function invocations(cli: string): Promise<string[]> {
  try {
    const text = await readFile(path.join(path.dirname(cli), 'invocations.log'), 'utf8');
    return text.split('\n').filter((l) => l !== '');
  } catch {
    return [];
  }
}

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** Where the compiled CLI of a mini monorepo lands, relative to its root. */
export const MINI_CLI = 'packages/cli/dist/index.js';

/** The source of the mini monorepo's one "detector": its output is the CLI's only finding. */
export function miniDetectorSource(message: string): string {
  return `export const MESSAGE = '${message}';\n`;
}

const MINI_CLI_SOURCE = `import { mkdirSync, writeFileSync } from 'node:fs';
import { MESSAGE } from '@seamline/contradictions';

const [command, ...rest] = process.argv.slice(2);
const arg = (name: string): string => rest[rest.indexOf(name) + 1] ?? '';

if (command === 'extract') {
  const runs = \`\${arg('--store')}/runs\`;
  mkdirSync(runs, { recursive: true });
  writeFileSync(\`\${runs}/run-1.sif\`, '{"t":"sif"}\\n');
  process.stdout.write(JSON.stringify({ runId: 'run-1', results: [] }));
} else {
  const finding = {
    code: 'X1_NULLABILITY',
    severity: 'high',
    left: \`tiny:Column:\${MESSAGE}\`,
    right: 'tiny:SchemaProperty:a',
    claim: 'claim',
    leftFact: 'left',
    rightFact: 'right',
    viaPath: [],
    confidence: 0.9,
  };
  process.stdout.write(JSON.stringify({ contradictions: [finding], unknownDetectors: [] }));
}
`;

/**
 * A two-package monorepo that builds with the real TypeScript compiler: `contradictions` exports
 * a string, and the `cli` prints it as its one finding. It is a git repository with one commit,
 * so the digests `freeze.ts` takes work on it, and `dist/` is ignored as in the real one. The
 * compiler and its type declarations are borrowed from this repository's `node_modules`.
 */
export async function writeMiniMonorepo(dir: string, message: string): Promise<void> {
  const base = await readFile(path.join(REPOSITORY_ROOT, 'tsconfig.base.json'), 'utf8');
  const project = (references: readonly string[]): string =>
    `${JSON.stringify({
      extends: '../../tsconfig.base.json',
      compilerOptions: { rootDir: './src', outDir: './dist' },
      include: ['src/**/*'],
      references: references.map((p) => ({ path: p })),
    })}\n`;
  const manifest = (name: string, extra: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ name, version: '0.0.0', type: 'module', main: './dist/index.js', types: './dist/index.d.ts', ...extra })}\n`;
  await commitFiles(
    dir,
    {
      '.gitignore': 'dist/\nnode_modules/\n*.tsbuildinfo\n',
      'tsconfig.base.json': base,
      'tsconfig.json': `${JSON.stringify({ files: [], references: [{ path: './packages/contradictions' }, { path: './packages/cli' }] })}\n`,
      'packages/contradictions/package.json': manifest('@seamline/contradictions'),
      'packages/contradictions/tsconfig.json': project([]),
      'packages/contradictions/src/index.ts': miniDetectorSource(message),
      'packages/cli/package.json': manifest('@seamline/cli', {
        dependencies: { '@seamline/contradictions': 'workspace:*' },
      }),
      'packages/cli/tsconfig.json': project(['../contradictions']),
      'packages/cli/src/index.ts': MINI_CLI_SOURCE,
    },
    'mini monorepo',
    true,
  );
  const modules = path.join(dir, 'node_modules');
  await mkdir(path.join(modules, '@seamline'), { recursive: true });
  for (const name of ['typescript', '@types']) {
    await symlink(
      await realpath(path.join(REPOSITORY_ROOT, 'node_modules', name)),
      path.join(modules, name),
      'dir',
    );
  }
  await symlink(
    path.join(dir, 'packages', 'contradictions'),
    path.join(modules, '@seamline', 'contradictions'),
    'dir',
  );
}

/** A contradiction in the shape `seamline check --json` prints. */
export function contradiction(
  code: string,
  left: string,
  right: string,
  confidence = 0.9,
): Record<string, unknown> {
  return {
    code,
    severity: 'high',
    left,
    right,
    claim: `${left} disagrees with ${right}`,
    leftFact: `${left} states one thing`,
    rightFact: `${right} states another`,
    viaPath: ['EXPOSED_AS'],
    confidence,
  };
}

/** A parsed finding, for tests that build reports directly. */
export function finding(
  repo: string,
  code: Finding['code'],
  left: string,
  right: string,
  confidence = 0.9,
): Finding {
  return {
    id: findingId(repo, code, left, right),
    repo,
    code,
    severity: 'high',
    left,
    right,
    claim: `${left} disagrees with ${right}`,
    leftFact: 'left fact',
    rightFact: 'right fact',
    viaPath: [],
    confidence,
    occurrences: 1,
  };
}
