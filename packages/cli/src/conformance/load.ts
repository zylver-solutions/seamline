/**
 * Loading a third-party extractor module for the conformance suite.
 *
 * The contract is the one the bundled extractors use (`src/extractors/*.ts`): an ES module that
 * exports `run(ctx, graph?)`, which returns an `ExtractorOutput`, and `MANIFEST` (or `manifest`),
 * its `ExtractorManifest`. The module is never imported in this process. Its manifest is read by a
 * confined child (`describe-child.ts`), and the extractor itself is then run by the sandbox host.
 *
 * Which directories the extractor's own code is read from is decided here, because the host cannot
 * guess: the module's own directory, the nearest `package.json` as a file, and the install
 * directory of every package that file lists, with what those depend on (`moduleCodeRoots`). That
 * is the extractor's program, readable without a glob. The repository it is run against is a
 * separate, disjoint directory and gets no such grant.
 *
 * Everything chosen here comes from files the code under test ships, so it is chosen narrowly: see
 * `moduleCodeRoots`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVENANCE } from '@seamline/ontology';
import type { ExtractorManifest } from '@seamline/ontology';
import {
  BUILD_ROOT,
  RUNS_FROM_SOURCE,
  readRssBytes,
  type SandboxProgram,
} from '../sandbox/host.ts';
import { closureRoots, permissionArgs, resolveCodeRoots } from '../sandbox/policy.ts';
import type { DescribeRequest, DescribeResponse } from './describe-child.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = RUNS_FROM_SOURCE ? '.ts' : '.js';
/** The sandbox program the suite runs in place of the extractor under test. */
export const WRAPPER_MODULE = join(HERE, `wrapper${EXT}`);
const DESCRIBE_ENTRY = join(HERE, `describe-child${EXT}`);
const DESCRIBE_TIMEOUT_MS = 30_000;
/**
 * The most resident memory the manifest-reading child may hold. The manifest is not known yet, so
 * there is no declared ceiling to apply; this is the host's rule (RSS sampled from outside) with a
 * fixed limit, because the JavaScript heap cap does not bound buffers or anything outside the heap.
 */
const DESCRIBE_RSS_CAP_MB = 512;
const DESCRIBE_POLL_MS = 100;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type Loaded =
  | { readonly ok: true; readonly program: SandboxProgram }
  | { readonly ok: false; readonly message: string };

function packageDirOf(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      // A package.json at the filesystem root or in a home directory is not this extractor's.
      return dir === parse(dir).root || dir === homedir() ? start : dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function dependencyNames(packageDir: string): string[] {
  try {
    const json = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const names = new Set<string>();
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const group = json[field];
      if (typeof group === 'object' && group !== null) {
        for (const name of Object.keys(group)) names.add(name);
      }
    }
    return [...names].sort();
  } catch {
    return [];
  }
}

/**
 * The paths a third-party extractor module's own code is read from, and nothing around them:
 *
 *  - the module's own directory, which holds the files it imports (`./lib.js`, `./sub/x.js`);
 *  - the nearest `package.json` above it, as one file: Node reads it to decide how to load the
 *    module, and the dependency list is taken from it;
 *  - the install directory of each dependency that file lists (and what those depend on), found
 *    only under a `node_modules`, only by an npm package name, and only if it really is inside it.
 *
 * The package's own directory is not granted. A module in `proj/tools/` gets `proj/tools/`, not
 * `proj/` with its `.env` and its history, and a module that imports a file from outside its own
 * directory fails the `manifest` property with the refused path named. Put the module in a
 * directory of its own, or bundle what it imports.
 */
export function moduleCodeRoots(modulePath: string): string[] {
  const dir = dirname(modulePath);
  const packageDir = packageDirOf(dir);
  const roots = new Set<string>([dir]);
  const manifestFile = join(packageDir, 'package.json');
  if (existsSync(manifestFile)) roots.add(manifestFile);
  for (const root of closureRoots(packageDir, dependencyNames(packageDir), [], false, true).roots) {
    roots.add(root);
  }
  return [...roots].sort();
}

/** The first thing wrong with a manifest that came off the wire, or undefined. `validateManifest` then judges the values. */
export function manifestShapeProblem(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return 'the manifest is not an object';
  }
  const m = manifest as Record<string, unknown>;
  for (const key of ['name', 'version']) {
    if (typeof m[key] !== 'string') return `${key} is not a string`;
  }
  for (const key of ['reads', 'env']) {
    const v = m[key];
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      return `${key} is not an array of strings`;
    }
  }
  if (typeof m['net'] !== 'boolean') return 'net is not a boolean';
  for (const key of ['memMb', 'timeoutS']) {
    if (typeof m[key] !== 'number') return `${key} is not a number`;
  }
  if (!(PROVENANCE as ReadonlyArray<unknown>).includes(m['provenanceCeiling'])) {
    return `provenanceCeiling is not one of ${PROVENANCE.join(', ')}`;
  }
  const produces = m['produces'];
  if (!Array.isArray(produces)) return 'produces is not an array';
  for (const p of produces as unknown[]) {
    const scope = p as Record<string, unknown> | null;
    if (
      typeof scope !== 'object' ||
      scope === null ||
      typeof scope['scope'] !== 'string' ||
      !Array.isArray(scope['kinds'])
    ) {
      return 'produces holds an entry that is not { scope, kinds }';
    }
  }
  return undefined;
}

function describeModule(
  request: DescribeRequest,
  childRoots: ReadonlyArray<string>,
): Promise<DescribeResponse> {
  return new Promise<DescribeResponse>((settle) => {
    const argv = [
      ...permissionArgs([...childRoots, ...request.codeRoots], false),
      '--max-old-space-size=256',
      '--disable-warning=ExperimentalWarning',
      ...(RUNS_FROM_SOURCE ? ['--experimental-strip-types'] : []),
      DESCRIBE_ENTRY,
    ];
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let timedOut = false;
    let overMemory = false;
    let done = false;
    const finish = (response: DescribeResponse): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      settle(response);
    };
    const child = spawn(process.execPath, argv, {
      cwd: request.scratch,
      env: { HOME: request.scratch },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, DESCRIBE_TIMEOUT_MS);
    const watchdog = setInterval(() => {
      const rss = child.pid === undefined ? undefined : readRssBytes(child.pid);
      if (rss !== undefined && rss > DESCRIBE_RSS_CAP_MB * 1024 * 1024) {
        overMemory = true;
        child.kill('SIGKILL');
      }
    }, DESCRIBE_POLL_MS);
    (child.stdio[3] as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_RESPONSE_BYTES) chunks.push(chunk);
    });
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', (e) =>
      finish({ ok: false, message: `could not start a child: ${e.message}` }),
    );
    child.on('close', (code, signal) => {
      if (overMemory) {
        finish({
          ok: false,
          message: `importing the module held more than ${DESCRIBE_RSS_CAP_MB} MiB and the child was killed`,
        });
        return;
      }
      if (timedOut) {
        finish({
          ok: false,
          message: `importing the module did not finish in ${DESCRIBE_TIMEOUT_MS / 1000}s and the child was killed`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DescribeResponse;
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.ok === 'boolean') {
          finish(parsed);
          return;
        }
      } catch {
        // fall through to the crash report
      }
      const how = signal !== null ? `was killed by ${signal}` : `exited with code ${String(code)}`;
      const tail =
        stderr.trim() === '' ? '' : `: ${stderr.trim().split('\n').slice(-3).join(' / ')}`;
      finish({ ok: false, message: `the child that imports the module ${how}${tail}` });
    });
    child.stdin?.end(JSON.stringify(request));
  });
}

/**
 * Reads `modulePath`'s manifest in a confined child and builds the sandbox program for it. A
 * module that cannot be found, imported or described is a `{ ok: false }` with the reason, not an
 * exception: the suite reports it as a failed `manifest` property.
 */
export async function loadExtractorProgram(modulePath: string, cwd: string): Promise<Loaded> {
  const asked = resolve(cwd, modulePath);
  let real: string;
  try {
    real = realpathSync(asked);
    if (!statSync(real).isFile()) return { ok: false, message: `${asked} is not a file` };
  } catch {
    return { ok: false, message: `no extractor module at ${asked}` };
  }
  let codeRoots: string[];
  let childRoots: ReadonlyArray<string>;
  try {
    codeRoots = moduleCodeRoots(real);
    childRoots = resolveCodeRoots(BUILD_ROOT, ['@seamline/core', '@seamline/ontology']).roots;
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const scratch = mkdtempSync(join(tmpdir(), 'seamline-describe-'));
  try {
    const response = await describeModule({ module: real, scratch, codeRoots }, childRoots);
    if (!response.ok) return { ok: false, message: response.message };
    if (!response.hasRun) return { ok: false, message: 'the module exports no run()' };
    const problem = manifestShapeProblem(response.manifest);
    if (problem !== undefined)
      return { ok: false, message: `the manifest is malformed: ${problem}` };
    return {
      ok: true,
      program: {
        manifest: response.manifest as ExtractorManifest,
        module: real,
        packages: [],
        codeRoots,
      },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
