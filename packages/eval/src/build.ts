/**
 * The build the harness measures.
 *
 * `pnpm eval` runs `packages/cli/dist/index.js`, which is compiled output and gitignored. A digest
 * of the sources says nothing about what that file does if it was built from other sources, so a
 * run must not start from a `dist/` it did not just make. `buildProduct` runs the repository's own
 * build with `--force` before anything is measured, and `cliIdentity` names the build that then
 * runs: the path, and a digest of the compiled files. Both go into the report, and a stored
 * baseline carries the digest, so a baseline made by another build is not mistaken for this one.
 *
 * `--force` matters. Without it `tsc --build` decides that a project is up to date from the
 * modification times of its inputs and outputs, so a tree restored with its times preserved (tar,
 * `rsync -a`, `cp -p`) after an edit that was built keeps the old output, while the digest of the
 * sources says it is the frozen product. A forced build recompiles every project, which costs
 * about as much as the cold build (tens of seconds) once per run.
 *
 * Nothing here reads a fetched repository.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from './errors.ts';

/** The CLI entry point of this repository's own build, relative to the repository root. */
export const OWN_CLI: readonly string[] = ['packages', 'cli', 'dist', 'index.js'];

/** Absolute path of this repository's own built CLI. */
export function ownCliPath(root: string): string {
  return path.join(root, ...OWN_CLI);
}

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 4000;

/**
 * Runs `tsc --build --force` at `root`: every project is recompiled, whatever the file times say.
 * It throws a `ConfigError`, naming the compiler output, when the build fails or TypeScript is not
 * installed: the harness measures code that builds, never an older `dist/` left behind by an
 * earlier build.
 */
export async function buildProduct(root: string): Promise<void> {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    throw new ConfigError(
      `cannot build: ${tsc} does not exist. Run \`pnpm install\` first; the evaluation builds the ` +
        'repository before it measures it.',
    );
  }
  const result = await new Promise<{ code: number | null; output: string; error: string | null }>(
    (resolve) => {
      let output = '';
      const child = spawn(process.execPath, [tsc, '--build', '--force'], {
        cwd: root,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const keep = (chunk: Buffer): void => {
        output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS);
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => child.kill('SIGKILL'), BUILD_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: null, output, error: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output, error: null });
      });
    },
  );
  if (result.code !== 0) {
    throw new ConfigError(
      `the build failed (tsc --build --force ${result.error ?? `exited ${String(result.code)}`}), so there is ` +
        `no current build to measure:\n${result.output.trim()}`,
    );
  }
}

/** Compiled files that cannot run in a CLI invocation: tests and their fixtures. */
function isCompiledTestFile(rel: string): boolean {
  return /\.test\.(c|m)?js$/.test(rel) || `/${rel}`.includes('/__fixtures__/');
}

async function compiledFiles(dir: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new ConfigError(
        `${path.join(dir, entry.name)} is a symbolic link; a build under test is made of regular files.`,
      );
    }
    if (entry.isDirectory()) out.push(...(await compiledFiles(path.join(dir, entry.name), child)));
    else if (/\.(c|m)?js$/.test(entry.name) && !isCompiledTestFile(child)) out.push(child);
  }
  return out;
}

/**
 * A digest of the compiled JavaScript of every package under `<root>/packages` except the harness
 * itself (tests and fixtures excepted): the files a CLI invocation can load. Package, relative
 * path and content go in, in code-unit order. A package with no `dist/` contributes nothing.
 */
export async function distDigest(root: string): Promise<string> {
  const digest = createHash('sha256');
  const packages = (await readdir(path.join(root, 'packages'), { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== 'eval')
    .map((e) => e.name)
    .sort();
  for (const pkg of packages) {
    const dist = path.join(root, 'packages', pkg, 'dist');
    if (!existsSync(dist)) continue;
    for (const rel of (await compiledFiles(dist, '')).sort()) {
      const content = await readFile(path.join(dist, ...rel.split('/')));
      digest.update(`${pkg}/${rel}\0${createHash('sha256').update(content).digest('hex')}\n`);
    }
  }
  return digest.digest('hex');
}

/** The CLI a run used, as the report and a stored baseline record it. */
export interface CliIdentity {
  /** `packages/cli/dist/index.js` for this repository's own build, else the absolute path given. */
  readonly path: string;
  /** Is it this repository's own built CLI? */
  readonly ownBuild: boolean;
  /**
   * For the own build, `distDigest` of every package's compiled output. For another CLI, a digest
   * of that one file: what else it loads is not known.
   */
  readonly distDigest: string;
}

/**
 * Names the CLI at `cli`. It throws a `ConfigError` when `cli` is not a file, which after
 * `buildProduct` can only be a `--cli` that points nowhere or at a directory.
 */
export async function cliIdentity(root: string, cli: string): Promise<CliIdentity> {
  const resolved = path.resolve(cli);
  if (!existsSync(resolved)) {
    throw new ConfigError(
      `the CLI ${resolved} does not exist. Without --cli the harness builds and runs ` +
        `${OWN_CLI.join('/')}.`,
    );
  }
  if (!(await stat(resolved)).isFile()) {
    throw new ConfigError(
      `the CLI ${resolved} is not a file; --cli takes the built entry point (a file such as ` +
        `${OWN_CLI.join('/')}), not a directory.`,
    );
  }
  if (resolved === ownCliPath(root)) {
    return { path: OWN_CLI.join('/'), ownBuild: true, distDigest: await distDigest(root) };
  }
  const file = await readFile(resolved);
  return {
    path: resolved,
    ownBuild: false,
    distDigest: createHash('sha256').update(file).digest('hex'),
  };
}
