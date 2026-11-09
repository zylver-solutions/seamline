#!/usr/bin/env node
/**
 * Outside-install check for `seamline conformance`.
 *
 * The conformance suite is meant to be run by someone who has installed Seamline from the registry
 * and has written an extractor of their own, not by a contributor with this repository checked out.
 * This script shows exactly that, end to end, with nothing from the repository on the path:
 *
 *   1. packs every publishable workspace package into a temporary directory (`pnpm pack`, the tool
 *      the release publishes with);
 *   2. creates a fresh directory outside the repository, with a standalone extractor written in it
 *      (`my-extractor.mjs`, Node built-ins only) and a misbehaving one (`bad-extractor.mjs`);
 *   3. installs the tarballs into that directory;
 *   4. runs `npx seamline conformance ./my-extractor.mjs` and `... ./bad-extractor.mjs`, and checks
 *      that the first passes every property and the second fails the one it breaks.
 *
 * Step 3 is `npm install <tarballs>` by default, which needs the registry for the third-party
 * dependencies (ts-morph, yaml). With `--offline-deps` it unpacks the same tarballs into
 * `node_modules` itself and takes the third-party dependencies, at the versions the lockfile pins,
 * from this checkout's install, so it can run with no network (`pnpm verify`). The tarballs, the
 * `seamline` bin, the fresh directory and the commands in steps 2 and 4 are the same either way.
 *
 * Usage:
 *   node scripts/outside-install.mjs                  real `npm install`; prints every command and its output
 *   node scripts/outside-install.mjs --offline-deps   no network
 *   node scripts/outside-install.mjs --keep           leave the temporary directory in place
 *
 * Exit 0 when the good extractor passed and the bad one failed as expected; 1 otherwise. A step that
 * could not run is a failure, never a skip. Run `pnpm build` first: the tarballs are built from `dist/`.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTERNAL_PACKAGES,
  REPO_ROOT,
  packPackage,
  readTarball,
  workspaceDirs,
} from './pack-check.mjs';

export const GOOD_EXTRACTOR = `// A standalone Seamline extractor: counts TODO markers in Markdown files.
// Node built-ins only. It reads the files its manifest declares, never follows a symlink, makes no
// network attempt, and says UNAVAILABLE (not PASS) when a file it set out to read cannot be read.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST = {
  name: 'todo-notes',
  version: '0.1.0',
  reads: ['**/*.md'],
  net: false,
  env: [],
  memMb: 128,
  timeoutS: 30,
  provenanceCeiling: 'EXTRACTED',
  produces: [{ scope: 'todo-notes', kinds: ['File'] }],
};

function markdownFiles(root, dir = '') {
  const found = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : dir + '/' + entry.name;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) found.push(...markdownFiles(root, rel));
    else if (entry.isFile() && rel.endsWith('.md')) found.push(rel);
  }
  return found.sort();
}

export async function run(ctx) {
  const nodes = [];
  const unread = [];
  for (const path of markdownFiles(ctx.repoRoot)) {
    try {
      const text = readFileSync(join(ctx.repoRoot, path), 'utf8');
      nodes.push({
        id: ctx.repo + ':File:' + path,
        kind: 'File',
        name: path,
        path,
        sensitivity: 'internal',
        provenance: 'EXTRACTED',
        confidence: 1,
        props: { todos: (text.match(/TODO/g) ?? []).length },
        firstSeenRun: ctx.runId,
        lastSeenRun: ctx.runId,
        deletedAt: null,
      });
    } catch (e) {
      unread.push(path + ': ' + (e.code ?? e.message));
    }
  }
  const status = unread.length > 0 ? 'UNAVAILABLE' : 'PASS';
  return {
    result: {
      extractor: MANIFEST.name,
      version: MANIFEST.version,
      status,
      authoritative: status === 'PASS' ? MANIFEST.produces : [],
      nodeCount: status === 'PASS' ? nodes.length : 0,
      edgeCount: 0,
      durationMs: 0,
      diagnostics: unread.length > 0 ? ['could not read ' + unread.length + ' file(s): ' + unread[0]] : [],
    },
    nodes: status === 'PASS' ? nodes : [],
    edges: [{ scope: 'todo-notes', edges: [] }],
  };
}
`;

/** The same extractor with one change: it phones home, swallows the error, and reports PASS. */
export const BAD_EXTRACTOR = GOOD_EXTRACTOR.replace("name: 'todo-notes'", "name: 'todo-notes-bad'")
  .replace(
    "import { join } from 'node:path';",
    "import { join } from 'node:path';\nimport net from 'node:net';",
  )
  .replace(
    'export async function run(ctx) {\n',
    "export async function run(ctx) {\n  try {\n    net.connect(443, 'example.com');\n  } catch {\n    // swallowed\n  }\n",
  );

// ---------------------------------------------------------------------------
// Third-party dependencies, taken from this checkout's pnpm install (offline mode only)
// ---------------------------------------------------------------------------

/**
 * Node's own lookup for a bare specifier: `<dir>/node_modules/<name>` from `from` up to the
 * filesystem root. It finds a package in the pnpm virtual store as well as in a parent checkout's
 * install (a git worktree sits below the checkout it was made from).
 */
export function lookup(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * `name -> real directory` for every third-party package the given packages depend on, directly or
 * not, following the layout pnpm installs (a package's dependencies are siblings in the
 * `node_modules` directory its real path sits in). Optional and peer dependencies are included when
 * they are installed. A required dependency that is not installed throws.
 */
export function thirdPartyClosure(packageDirs) {
  const found = new Map();
  const queue = [];
  const depsOf = (manifest) => ({
    required: Object.keys(manifest.dependencies ?? {}),
    optional: [
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ],
  });
  for (const dir of packageDirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const { required, optional } = depsOf(manifest);
    for (const name of required)
      if (!name.startsWith('@seamline/')) queue.push({ name, from: dir, required: true });
    for (const name of optional)
      if (!name.startsWith('@seamline/')) queue.push({ name, from: dir, required: false });
  }
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (found.has(next.name)) continue;
    const hit = lookup(next.from, next.name);
    if (hit === undefined) {
      if (next.required)
        throw new Error(`${next.name} is a dependency of ${next.from} and is not installed`);
      continue;
    }
    const real = realpathSync(hit);
    found.set(next.name, real);
    const { required, optional } = depsOf(
      JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')),
    );
    for (const name of required) queue.push({ name, from: real, required: true });
    for (const name of optional) queue.push({ name, from: real, required: false });
  }
  return found;
}

/** Unpacks the tarballs into `<consumer>/node_modules/<name>` and links the `seamline` bin. */
function materialize(consumer, packed) {
  const modules = join(consumer, 'node_modules');
  for (const { name, tarball, dir } of packed) {
    const target = join(modules, ...name.split('/'));
    mkdirSync(target, { recursive: true });
    for (const [path, entry] of readTarball(readFileSync(tarball))) {
      const out = join(target, path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, entry.content);
      if (entry.mode & 0o111) chmodSync(out, 0o755);
    }
    void dir;
  }
  for (const [name, real] of thirdPartyClosure(packed.map((p) => p.dir))) {
    const target = join(modules, ...name.split('/'));
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    cpSync(real, target, { recursive: true, dereference: true });
  }
  const bin = join(modules, '.bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(join('..', '@seamline', 'cli', 'dist', 'bin.js'), join(bin, 'seamline'));
  chmodSync(join(modules, '@seamline', 'cli', 'dist', 'bin.js'), 0o755);
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function cleanEnv() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TERM']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, NO_COLOR: '1', npm_config_update_notifier: 'false' };
}

function exec(command, args, options) {
  const r = spawnSync(command, args, {
    ...options,
    env: cleanEnv(),
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command: `${command} ${args.join(' ')}`,
    status: r.error !== undefined ? -1 : (r.status ?? -1),
    stdout: r.stdout ?? '',
    stderr: `${r.stderr ?? ''}${r.error === undefined ? '' : String(r.error)}`,
  };
}

/** Pure: what the two conformance runs must look like for the check to hold. Returns the failures. */
export function judge({ good, bad }) {
  const failures = [];
  if (good.status !== 0) failures.push(`the well-behaved extractor exited ${good.status}, not 0`);
  if (
    !/^conformance: PASS \(8 PASS, 0 FAIL, 0 UNAVAILABLE, 0 NOT_APPLICABLE\)$/m.test(good.stdout)
  ) {
    failures.push('the well-behaved extractor did not report 8 PASS');
  }
  if (bad.status !== 1) failures.push(`the misbehaving extractor exited ${bad.status}, not 1`);
  if (!/^FAIL +no-network /m.test(bad.stdout))
    failures.push('the misbehaving extractor did not FAIL no-network');
  if (!/\[network\] todo-notes-bad/.test(bad.stdout))
    failures.push('no [network] evidence for the misbehaving extractor');
  return failures;
}

/**
 * Runs the whole check. `log(step)` is called with each command as it finishes, so a caller can print
 * the transcript. Returns `{ ok, failures, consumer, steps }`.
 */
export function outsideInstall({ offlineDeps = false, keep = false, log = () => {} } = {}) {
  const steps = [];
  const record = (step) => {
    steps.push(step);
    log(step);
    return step;
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seamline-outside-')));
  const tarballs = join(root, 'tarballs');
  const consumer = join(root, 'consumer');
  mkdirSync(tarballs);
  mkdirSync(consumer);
  const failures = [];
  try {
    if (!existsSync(join(REPO_ROOT, 'packages', 'cli', 'dist', 'bin.js'))) {
      throw new Error('packages/cli/dist/bin.js is missing: run `pnpm build` first');
    }
    const packed = [];
    for (const dir of workspaceDirs(REPO_ROOT)) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest.private === true || INTERNAL_PACKAGES.includes(manifest.name)) continue;
      const tarball = packPackage(dir, tarballs);
      packed.push({ name: manifest.name, tarball, dir });
    }
    record({
      command: `pnpm pack (x${packed.length}) --pack-destination ${tarballs}`,
      status: 0,
      stdout: packed.map((p) => p.tarball.slice(tarballs.length + 1)).join('\n'),
      stderr: '',
    });

    writeFileSync(
      join(consumer, 'package.json'),
      `${JSON.stringify({ name: 'my-extractor-workspace', private: true, type: 'module' }, null, 2)}\n`,
    );
    writeFileSync(join(consumer, 'my-extractor.mjs'), GOOD_EXTRACTOR);
    writeFileSync(join(consumer, 'bad-extractor.mjs'), BAD_EXTRACTOR);

    if (offlineDeps) {
      materialize(consumer, packed);
      record({
        command:
          '(offline) unpack the tarballs into node_modules, third-party dependencies from the lockfile-pinned install',
        status: 0,
        stdout: packed.map((p) => p.name).join('\n'),
        stderr: '',
      });
    } else {
      const install = record(
        exec(
          'npm',
          [
            'install',
            '--no-audit',
            '--no-fund',
            '--ignore-scripts',
            ...packed.map((p) => p.tarball),
          ],
          { cwd: consumer },
        ),
      );
      if (install.status !== 0) failures.push(`npm install exited ${install.status}`);
    }

    if (failures.length === 0) {
      const run = (file) =>
        record(exec('npx', ['--no-install', 'seamline', 'conformance', file], { cwd: consumer }));
      const good = run('./my-extractor.mjs');
      const bad = run('./bad-extractor.mjs');
      failures.push(...judge({ good, bad }));
      if (REPO_ROOT.length > 1 && `${good.stdout}${bad.stdout}`.includes(REPO_ROOT)) {
        failures.push(
          'the output names a path inside the repository: it was not run from the install',
        );
      }
    }
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
  return { ok: failures.length === 0, failures, consumer, root, steps };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const result = outsideInstall({
    offlineDeps: args.includes('--offline-deps'),
    keep: args.includes('--keep'),
    log: (step) => {
      process.stdout.write(
        `$ ${step.command}\n${step.stdout}${step.stderr === '' ? '' : `${step.stderr}\n`}[exit ${step.status}]\n\n`,
      );
    },
  });
  if (!result.ok) {
    process.stdout.write(
      `outside-install: FAILED\n${result.failures.map((f) => `  - ${f}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('outside-install: ok\n');
  }
}
