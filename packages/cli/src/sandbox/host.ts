/**
 * The sandbox host: runs one extractor in a confined child process and turns
 * whatever happens into an `ExtractorOutput`.
 *
 * THREATMODEL.md control C4 says each extractor ships a capability manifest and
 * "the host enforces it". This is the host. For one run it:
 *
 *  - validates the manifest against the host limits (`validateManifest`);
 *  - starts a Node child built from `sandboxSpawnOptions`: the environment
 *    scrubbed to an allow-list and then a credential deny pass, a synthetic
 *    HOME, `--max-old-space-size` from the manifest, cwd at the repo root;
 *  - confines the child with the Node permission model (read access to the repo
 *    when the manifest declares any `reads`, and to the extractor's own code;
 *    no writes, no workers, no addons, no child processes unless granted).
 *    The repo, and every directory granted, is granted by its real path, and
 *    the repo is the child's working directory and the root its extractor is
 *    given by that path too: the permission model compares path strings and a
 *    child's working directory is always a real path, so a repo reached through
 *    a link (a checkout under macOS `/tmp` or `/var`) is granted and named as
 *    the directory it is, and behaves as the same repo at its real path does;
 *  - resolves every program the extractor may start to a real path itself, outside the
 *    repository, and hands the child that path: the child cannot judge where a name leads;
 *  - lets the in-child guard (`guard.ts`) apply the declared globs, symlink
 *    containment and the network ban, and record what it refused;
 *  - kills the child at `timeoutS`, and, on Linux, when its resident memory
 *    passes the cap (the V8 heap cap does not cover buffers);
 *  - treats the child's answer as untrusted: it must parse, have the right
 *    shape, stay inside the manifest's provenance ceiling and declared scopes,
 *    and carry no fatal guard denial.
 *
 * Every way this can go wrong yields FAIL or UNAVAILABLE with a diagnostic, and
 * an empty node and edge set. It never yields PASS and never falls back to
 * running the extractor in this process. FAIL means the extractor ran and was
 * stopped, or its output was refused. UNAVAILABLE means a sandbox could not be
 * set up, so nothing ran.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { NODE_KINDS } from '@seamline/ontology';
import type {
  AuthoritativeScope,
  ExtractorManifest,
  ExtractorResult,
  ExtractorStatus,
} from '@seamline/ontology';
import {
  SandboxViolation,
  resolveHostLimits,
  sandboxSpawnOptions,
  sealExtractorOutput,
  assertAuthoritySelectors,
  validateManifest,
  type HostLimits,
  type SandboxViolationCode,
} from '@seamline/core';
import type { ExtractContext, ExtractorOutput, ExtractorPort } from '../ports.ts';
import { decodeExtractorOutput } from './output-codec.ts';
import { permissionArgs, realPathOrSame, resolveCodeRoots, resolveExecGrants } from './policy.ts';
import {
  PROTOCOL_VERSION,
  CHILD_PHASES,
  type ChildPhase,
  isResponse,
  type GraphSnapshot,
  type ProgramContext,
  type RecordedDenial,
  type SandboxRequest,
  type SandboxResponse,
} from './protocol.ts';
import { snapshotGraph } from './snapshot.ts';

/**
 * Largest response the host will buffer from a child. The host holds the received chunks, their
 * concatenation and the decoded string at once, so its peak is a few times this figure; this
 * repository's own graph is a few MiB. A graph near the cap is already a failure.
 */
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
/** How much of a child's stderr the host keeps, for a crash diagnostic. */
const STDERR_TAIL_BYTES = 8 * 1024;
/**
 * Resident memory a child may use beyond the manifest's `memMb` before the host
 * kills it. `--max-old-space-size` bounds the JavaScript heap; the runtime,
 * compiled code, and buffers live outside it.
 */
export const RSS_HEADROOM_MB = 256;
const DEFAULT_RSS_POLL_MS = 100;
const MAX_DIAGNOSTIC_CHARS = 400;
const MAX_DENIALS_LISTED = 5;

export interface SandboxProgram {
  /** The capability manifest this program runs under. */
  readonly manifest: ExtractorManifest;
  /** Absolute path of the module that exports `run(ctx, graph?)`. */
  readonly module: string;
  /** Packages the module loads, resolved from the CLI's install; their whole dependency closure becomes readable code. */
  readonly packages: ReadonlyArray<string>;
  /**
   * Binary base names the program may start. Granted by the host, not by the manifest. The host
   * resolves each to a real path on the child's `PATH`, outside the repository, and does not start
   * the extractor when it cannot (`resolveExecGrants`).
   */
  readonly exec?: ReadonlyArray<string>;
  /** Further directories the program's code is read from (test programs outside the CLI's build). */
  readonly codeRoots?: ReadonlyArray<string>;
  /** When set, the program reads the run's graph: the scopes whose status it asks for. */
  readonly graphScopes?: ReadonlyArray<string>;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface SandboxHostOptions {
  /** The environment the extractor's is derived from. The process's own, in a release build. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Overrides for the host limits a manifest is validated against. */
  readonly limits?: Partial<HostLimits>;
  /** Starts the child. `child_process.spawn`; replaceable so a test can see exactly what was started. */
  readonly spawn?: SpawnFn;
  /** The Node binary to run the child with. This process's own. */
  readonly nodeBinary?: string;
  /** How often to sample a child's resident memory. */
  readonly rssPollMs?: number;
  /** Largest response to buffer from a child. `MAX_RESPONSE_BYTES`; smaller only to test the cap. */
  readonly maxResponseBytes?: number;
  /** Whether this Node can confine a child. `hasPermissionModel`; replaceable to stand in for an older Node. */
  readonly permissionModel?: () => boolean;
  /** Where each child's synthetic HOME is made, and removed again. The system temporary directory; elsewhere only so a test can watch a directory nothing else writes to. */
  readonly scratchRoot?: string;
}

export interface SandboxHost {
  run(program: SandboxProgram, ctx: ExtractContext): Promise<ExtractorOutput>;
}

// ---------------------------------------------------------------------------
// Where the child's own files are
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
/** `.ts` when running from a checkout (the tests), `.js` when running from a build. */
const SOURCE_EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
export const CHILD_ENTRY = join(HERE, `child${SOURCE_EXT}`);
/** The directory the CLI's modules sit in: `dist`, or `src` in a checkout. */
export const BUILD_ROOT = dirname(HERE);
export const RUNS_FROM_SOURCE = SOURCE_EXT === '.ts';
/** What the child's own entry and guard import, whatever program it then runs. */
const CHILD_PACKAGES: ReadonlyArray<string> = ['@seamline/core', '@seamline/ontology'];

// ---------------------------------------------------------------------------
// Results the host itself produces
// ---------------------------------------------------------------------------

/**
 * One line, bounded, with this machine's paths removed: it ends up in the store and the snapshot.
 * `repoRoot` is every spelling of the repository root a line may carry (as named, and as the child
 * saw it), longest first so that one spelling is never cut out of the middle of another.
 */
export function tidy(text: string, repoRoot: string | ReadonlyArray<string>): string {
  let out = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const roots = (typeof repoRoot === 'string' ? [repoRoot] : [...repoRoot]).sort(
    (a, b) => b.length - a.length,
  );
  for (const [from, to] of [
    ...roots.map((root) => [root, '<repo>'] as const),
    [homedir(), '~'] as const,
  ]) {
    if (from.length > 1) out = out.split(from).join(to);
  }
  return out.length > MAX_DIAGNOSTIC_CHARS ? `${out.slice(0, MAX_DIAGNOSTIC_CHARS)}...` : out;
}

function degraded(
  manifest: ExtractorManifest,
  status: Exclude<ExtractorStatus, 'PASS'>,
  diagnostics: ReadonlyArray<string>,
  durationMs: number,
): ExtractorOutput {
  const authoritative: AuthoritativeScope[] = manifest.produces.map((p) => ({ ...p }));
  const result: ExtractorResult = {
    extractor: manifest.name,
    version: manifest.version,
    status,
    authoritative,
    nodeCount: 0,
    edgeCount: 0,
    durationMs,
    diagnostics: [...diagnostics],
  };
  return { result, nodes: [], edges: [] };
}

/**
 * What the host concluded about one run, kept beside the `ExtractorOutput` it returned.
 *
 * The output carries a status and diagnostics, which are text. A caller that must tell "stopped for
 * a sandbox violation" from "failed for its own reasons" (the conformance suite) should not parse
 * that text, so the codes the host judged the run on are recorded here, keyed by the very object
 * `run` returned. A copy of the output is a different object and carries no observation.
 */
export interface SandboxObservation {
  /** False when the host never started the extractor: a sandbox could not be set up or started. */
  readonly ran: boolean;
  /**
   * The violation codes the run was judged on, in the order found, without repeats. Empty when the
   * extractor ran to completion, whatever status it then reported, and when it failed with an error
   * of its own that is not a violation.
   */
  readonly violations: ReadonlyArray<SandboxViolationCode>;
  /**
   * True when the run failed closed on looks alone: every refusal that ended it was a probe of a
   * repo path that leads out of the repo (stat, readdir, realpath), and the extractor asked for
   * no content, no socket and no process it may not have. False when there was no violation, and
   * when any refusal was a content read, a write, a socket or a process.
   */
  readonly probeOnly: boolean;
}

const OBSERVATIONS = new WeakMap<ExtractorOutput, SandboxObservation>();

/** The host's observation of the run that produced `output`, or undefined for any other object. */
export function observationOf(output: ExtractorOutput): SandboxObservation | undefined {
  return OBSERVATIONS.get(output);
}

function observe(output: ExtractorOutput, observation: SandboxObservation): ExtractorOutput {
  OBSERVATIONS.set(output, observation);
  return output;
}

function violationLine(
  manifest: ExtractorManifest,
  code: SandboxViolationCode,
  message: string,
): string {
  return new SandboxViolation(code, manifest.name, message).message;
}

function denialLines(
  manifest: ExtractorManifest,
  denials: ReadonlyArray<RecordedDenial>,
  fatal: boolean,
  truncated = false,
): string[] {
  const key = (d: RecordedDenial): string => `${d.code} ${d.message}`;
  // What the extractor asked to have (a read, a socket, a process) is listed before a look at a
  // path, so a long run of looks cannot push it out of the few lines shown. `access` arrives from
  // the child: anything but `probe` is read as content.
  const rank = (d: RecordedDenial): number => (d.access === 'probe' ? 1 : 0);
  const picked = denials
    .filter((d) => d.fatal === fatal)
    .sort((a, b) => rank(a) - rank(b) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const lines = picked.slice(0, MAX_DENIALS_LISTED).map((d) => {
    const base = violationLine(manifest, d.code, d.message);
    return d.count > 1 ? `${base} (x${d.count})` : base;
  });
  if (picked.length > MAX_DENIALS_LISTED)
    lines.push(`... and ${picked.length - MAX_DENIALS_LISTED} more`);
  if (truncated) lines.push('... and further refusals were not recorded (the guard log was full)');
  return lines;
}

/** Resident set size of `pid` in bytes, from /proc. Linux only; undefined elsewhere. */
export function readRssBytes(pid: number): number | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match === null ? undefined : Number(match[1]) * 1024;
  } catch {
    return undefined;
  }
}

/** True when this Node can confine a child with the permission model. */
export function hasPermissionModel(): boolean {
  return process.allowedNodeEnvironmentFlags.has('--permission');
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

interface ChildOutcome {
  readonly spawnError?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly memoryKilled: boolean;
  readonly oversize: boolean;
  readonly response: Buffer;
  readonly stderrTail: string;
}

export function createSandboxHost(options: SandboxHostOptions): SandboxHost {
  const limits = resolveHostLimits(options.limits);
  const spawnFn: SpawnFn = options.spawn ?? nodeSpawn;
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const pollMs = options.rssPollMs ?? DEFAULT_RSS_POLL_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const canConfine = options.permissionModel ?? hasPermissionModel;

  async function run(program: SandboxProgram, ctx: ExtractContext): Promise<ExtractorOutput> {
    const manifest = program.manifest;
    const started = Date.now();
    const elapsed = (): number => (ctx.deterministic ? 0 : Date.now() - started);
    // The repository as the child will know it (see the header), and both spellings for scrubbing.
    const repoRoot = realPathOrSame(ctx.repoRoot);
    const spellings = [ctx.repoRoot, repoRoot];
    const unavailable = (why: string): ExtractorOutput =>
      observe(
        degraded(
          manifest,
          'UNAVAILABLE',
          [
            tidy(
              `${manifest.name} was not run, because it could not be sandboxed: ${why}`,
              spellings,
            ),
          ],
          elapsed(),
        ),
        { ran: false, violations: [], probeOnly: false },
      );

    try {
      validateManifest(manifest, limits);
    } catch (e) {
      return unavailable(e instanceof Error ? e.message : String(e));
    }
    if (!canConfine()) {
      return unavailable(
        `this Node.js (${process.version}) has no permission model (--permission); Seamline needs Node 22.13 or later to confine an extractor, and will not run one unconfined`,
      );
    }

    const grantedNames = program.exec ?? [];
    let flags: string[];
    let codeRoots: string[];
    try {
      codeRoots = [
        ...resolveCodeRoots(BUILD_ROOT, [...CHILD_PACKAGES, ...program.packages]).roots,
        ...(program.codeRoots ?? []).map(realPathOrSame),
      ];
      const readable = manifest.reads.length > 0 ? [repoRoot, ...codeRoots] : codeRoots;
      flags = permissionArgs(readable, grantedNames.length > 0);
    } catch (e) {
      return unavailable(e instanceof Error ? e.message : String(e));
    }

    let scratchHome: string;
    try {
      scratchHome = mkdtempSync(join(options.scratchRoot ?? tmpdir(), 'seamline-sandbox-'));
    } catch (e) {
      return unavailable(`no scratch directory for the synthetic HOME (${(e as Error).message})`);
    }

    try {
      const spawnOptions = sandboxSpawnOptions(manifest, repoRoot, scratchHome, options.env);
      // Found here, where nothing restricts a look at the file system, on the PATH the child will
      // have (without the entries the repository controls), and refused if it is the repository's.
      const grantedExec = resolveExecGrants(grantedNames, spawnOptions.env['PATH'], spellings);
      const { view, ...programCtx } = ctx;
      let graph: GraphSnapshot | undefined;
      if (program.graphScopes !== undefined) {
        if (view === undefined)
          return unavailable("the program reads the run's graph and none was supplied");
        graph = snapshotGraph(view, program.graphScopes);
      }
      const request: SandboxRequest = {
        v: PROTOCOL_VERSION,
        program: program.module,
        manifest,
        repoRoot,
        ...(resolve(ctx.repoRoot) === repoRoot ? {} : { repoRootAs: resolve(ctx.repoRoot) }),
        codeRoots,
        grants: { exec: grantedNames, execPaths: grantedExec },
        ctx: { ...programCtx, repoRoot } as ProgramContext,
        ...(graph === undefined ? {} : { graph }),
      };
      const argv = [
        ...flags,
        // process.exit() can deadlock while joining a V8 worker that waits for
        // foreground GC (nodejs/node#66171). Keep forced termination, with no
        // V8 background jobs to strand during shutdown. Budgets are unchanged.
        '--single-threaded',
        ...spawnOptions.execArgv,
        '--disable-warning=ExperimentalWarning',
        ...(RUNS_FROM_SOURCE ? ['--experimental-strip-types'] : []),
        CHILD_ENTRY,
      ];
      const outcome = await runChild(argv, spawnOptions, manifest, JSON.stringify(request));
      return judge(program, spellings, outcome, elapsed(), maxResponseBytes);
    } catch (e) {
      return unavailable(e instanceof Error ? e.message : String(e));
    } finally {
      rmSync(scratchHome, { recursive: true, force: true });
    }
  }

  function runChild(
    argv: string[],
    spawnOptions: ReturnType<typeof sandboxSpawnOptions>,
    manifest: ExtractorManifest,
    requestJson: string,
  ): Promise<ChildOutcome> {
    return new Promise<ChildOutcome>((resolveOutcome) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderrTail = '';
      let phaseTail = '';
      let timedOut = false;
      let memoryKilled = false;
      let oversize = false;
      let settled = false;
      let requestFinished = false;
      let reportedPhase: ChildPhase | 'unobserved' = 'unobserved';
      let resourceObservation = 'state=unknown cpuTicks=unknown rssBytes=unknown';
      const timers: {
        deadline?: ReturnType<typeof setTimeout>;
        watchdog?: ReturnType<typeof setInterval>;
      } = {};

      const finish = (how: {
        spawnError?: string;
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      }): void => {
        if (settled) return;
        settled = true;
        if (timers.deadline !== undefined) clearTimeout(timers.deadline);
        if (timers.watchdog !== undefined) clearInterval(timers.watchdog);
        if (timedOut) {
          // Host stderr only: neither raw child stderr nor runtime counters enter
          // the graph, the response protocol, or the canonical run snapshot.
          try {
            process.stderr.write(
              `sandbox-timeout-observation: reportedPhase=${reportedPhase} stdinFinished=${requestFinished} responseBytes=${bytes} ${resourceObservation}\n`,
            );
          } catch { /* best effort; the existing timeout still fails closed */ }
        }
        resolveOutcome({
          ...how,
          timedOut,
          memoryKilled,
          oversize,
          response: Buffer.concat(chunks),
          stderrTail,
        });
      };

      let child: ChildProcess;
      try {
        child = spawnFn(nodeBinary, argv, {
          cwd: spawnOptions.cwd,
          env: { ...spawnOptions.env },
          stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        finish({ spawnError: (e as Error).message, exitCode: null, signal: null });
        return;
      }

      const kill = (): void => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      };

      timers.deadline = setTimeout(() => {
        timedOut = true;
        const pid = child.pid;
        if (process.platform === 'linux' && pid !== undefined && child.exitCode === null && child.signalCode === null) {
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
            const state = /^[RSDZTWtXxIKP]$/.test(fields[0] ?? '') ? fields[0] : 'unknown';
            const cpu = /^\d+$/.test(fields[11] ?? '') && /^\d+$/.test(fields[12] ?? '')
              ? Number(fields[11]) + Number(fields[12]) : Number.NaN;
            const ticks = Number.isSafeInteger(cpu) && cpu >= 0 ? String(cpu) : 'unknown';
            const rss = readRssBytes(pid);
            resourceObservation = `state=${state} cpuTicks=${ticks} rssBytes=${rss ?? 'unknown'}`;
          } catch { /* process already gone, or proc unavailable */ }
        }
        kill();
      }, spawnOptions.timeoutMs);

      const capBytes = (manifest.memMb + RSS_HEADROOM_MB) * 1024 * 1024;
      const pid = child.pid;
      if (pid !== undefined) {
        timers.watchdog = setInterval(() => {
          const rss = readRssBytes(pid);
          if (rss !== undefined && rss > capBytes) {
            memoryKilled = true;
            kill();
          }
        }, pollMs);
      }

      (child.stdio[3] as Readable | null | undefined)?.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) {
          oversize = true;
          kill();
          return;
        }
        chunks.push(chunk);
      });
      child.stdout?.resume();
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });
      (child.stdio[4] as Readable | null | undefined)?.on('data', (chunk: Buffer) => {
        // Separate from result fd3 and crash stderr; bounded even for a hostile
        // extractor, and enough overlap to recognize a marker split by a read.
        phaseTail = (phaseTail + chunk.toString('utf8')).slice(-128);
        for (const match of phaseTail.matchAll(/\[seamline-child-phase:([a-z-]+)\]/g)) {
          const value = match[1];
          if (CHILD_PHASES.includes(value as ChildPhase)) reportedPhase = value as ChildPhase;
        }
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.once('finish', () => { requestFinished = true; });
      child.on('error', (e) => finish({ spawnError: e.message, exitCode: null, signal: null }));
      child.on('close', (exitCode, signal) => finish({ exitCode, signal }));
      child.stdin?.end(requestJson);
    });
  }

  return { run };
}

/** Decide what a finished child's output means, and record the violation codes it was judged on. */
function judge(
  program: SandboxProgram,
  repoRoot: string | ReadonlyArray<string>,
  outcome: ChildOutcome,
  durationMs: number,
  maxResponseBytes: number,
): ExtractorOutput {
  const seen: Seen = { violations: [], content: false };
  const output = judgeOutcome(program, repoRoot, outcome, durationMs, maxResponseBytes, seen);
  return observe(output, {
    ran: outcome.spawnError === undefined,
    violations: seen.violations,
    probeOnly: seen.violations.length > 0 && !seen.content,
  });
}

interface Seen {
  readonly violations: SandboxViolationCode[];
  /** Set when anything but a probe of a path leading out of the repo was among the violations. */
  content: boolean;
}

/** Order is the point: nothing passes unless everything does. Each violation code it judges on goes into `seen`. */
function judgeOutcome(
  program: SandboxProgram,
  repoRoot: string | ReadonlyArray<string>,
  outcome: ChildOutcome,
  durationMs: number,
  maxResponseBytes: number,
  seen: Seen,
): ExtractorOutput {
  const manifest = program.manifest;
  const note = (code: SandboxViolationCode, probe = false): void => {
    if (!seen.violations.includes(code)) seen.violations.push(code);
    if (!probe) seen.content = true;
  };
  const fail = (
    code: SandboxViolationCode,
    message: string,
    more: ReadonlyArray<string> = [],
  ): ExtractorOutput => {
    note(code);
    return degraded(
      manifest,
      'FAIL',
      [violationLine(manifest, code, message), ...more].map((line) => tidy(line, repoRoot)),
      durationMs,
    );
  };

  if (outcome.spawnError !== undefined) {
    return degraded(
      manifest,
      'UNAVAILABLE',
      [
        tidy(
          `${manifest.name} was not run, because its sandbox could not be started: ${outcome.spawnError}`,
          repoRoot,
        ),
      ],
      durationMs,
    );
  }
  if (outcome.timedOut) {
    return fail(
      'timeout',
      `exceeded its declared wallclock budget of ${manifest.timeoutS}s and was killed`,
    );
  }
  if (outcome.memoryKilled) {
    return fail(
      'memory',
      `exceeded its declared memory budget of ${manifest.memMb} MiB (plus ${RSS_HEADROOM_MB} MiB for the runtime) and was killed`,
    );
  }
  if (outcome.oversize) {
    return fail('protocol', `sent a result larger than ${maxResponseBytes / (1024 * 1024)} MiB`);
  }

  let response: SandboxResponse | undefined;
  if (outcome.response.length > 0) {
    try {
      const parsed: unknown = JSON.parse(outcome.response.toString('utf8'));
      if (isResponse(parsed)) response = parsed;
    } catch {
      response = undefined;
    }
  }

  if (response === undefined) {
    const how =
      outcome.signal !== null
        ? `was killed by ${outcome.signal}`
        : `exited with code ${String(outcome.exitCode)}`;
    if (/heap out of memory|Reached heap limit|Allocation failed/i.test(outcome.stderrTail)) {
      return fail(
        'memory',
        `ran out of memory under its declared limit of ${manifest.memMb} MiB (the JavaScript heap cap) and ${how}`,
      );
    }
    const tail = outcome.stderrTail.trim() === '' ? [] : [`stderr: ${outcome.stderrTail}`];
    return fail('crash', `${how} without delivering a result`, tail);
  }

  // A refusal the guard recorded as fatal outranks everything the extractor then said or did.
  const fatal = denialLines(manifest, response.denials, true, response.denialsTruncated === true);
  if (fatal.length > 0) {
    for (const denial of response.denials) {
      if (denial.fatal) note(denial.code, denial.access === 'probe');
    }
    // A log that dropped a fatal refusal cannot show that only looks ended the run.
    if (response.denialsTruncated === true) seen.content = true;
    return degraded(
      manifest,
      'FAIL',
      [
        ...fatal,
        'its result was discarded: a sandbox violation outranks whatever the extractor reported afterwards',
      ].map((l) => tidy(l, repoRoot)),
      durationMs,
    );
  }

  const probes = denialLines(manifest, response.denials, false);
  if (!response.ok) {
    const f = response.failure;
    if (f.kind === 'violation') return fail(f.code, f.message, probes);
    if (f.kind === 'protocol') return fail('protocol', `sent a malformed result: ${f.message}`, probes);
    return degraded(
      manifest,
      'FAIL',
      [f.message, ...probes].map((l) => tidy(l, repoRoot)),
      durationMs,
    );
  }

  let output: ExtractorOutput;
  try { output = decodeExtractorOutput(response.output); }
  catch (error) { return fail('protocol', `sent a malformed framed result: ${(error as Error).message}`); }

  if (output.result.extractor !== manifest.name) {
    return fail(
      'protocol',
      `reported itself as ${JSON.stringify(output.result.extractor)}, not ${manifest.name}`,
    );
  }

  try {
    sealExtractorOutput(
      manifest,
      output.nodes,
      output.edges.flatMap((group) => group.edges),
    );
  } catch (e) {
    return fail('provenance-ceiling', (e as Error).message);
  }

  const scopeProblem = scopeProblemOf(manifest, output);
  if (scopeProblem !== undefined) return fail('scope-undeclared', scopeProblem);

  if (output.result.status === 'PASS' || probes.length === 0) return output;
  // A run that did not pass keeps the probes that were refused, which is where a missing parent
  // directory's node_modules shows up. A passing run is left byte-for-byte as the extractor wrote it.
  return {
    ...output,
    result: {
      ...output.result,
      diagnostics: [...output.result.diagnostics, ...probes.map((l) => tidy(l, repoRoot))],
    },
  };
}

/**
 * The scopes a result and its edges name must be ones the manifest produces,
 * and an authoritative claim may not widen the node kinds the manifest declares.
 * A scope claim is what lets a PASS tombstone, so a result is not allowed to
 * claim another extractor's.
 */
function scopeProblemOf(manifest: ExtractorManifest, output: ExtractorOutput): string | undefined {
  try { assertAuthoritySelectors(output.result.authoritative); }
  catch (error) { return `claimed authority with a selector that is not valid (${(error as Error).message})`; }
  const declared = new Map(manifest.produces.map((p) => [p.scope, new Set<string>(p.kinds)]));
  for (const claim of output.result.authoritative) {
    const kinds = declared.get(claim.scope);
    if (kinds === undefined) {
      return `claimed authority over scope ${JSON.stringify(claim.scope)}, which its manifest does not produce`;
    }
    for (const kind of claim.kinds) {
      if (!kinds.has(kind)) {
        return `claimed authority over ${kind} nodes in scope ${JSON.stringify(claim.scope)}, which its manifest does not declare`;
      }
    }
    // The selector is what bounds the tombstoning of a PASS. It is checked to be a selector the
    // store can compile; it is not checked to be narrower than the manifest's own.
  }
  for (const group of output.edges) {
    if (!declared.has(group.scope)) {
      return `wrote edges into scope ${JSON.stringify(group.scope)}, which its manifest does not produce`;
    }
  }
  // The store refuses a node of a kind the ontology does not have, but only after the extractor
  // reported PASS; such a node is turned away here, at the host, as a FAIL. A node of a real kind
  // outside the manifest's own is allowed: `extract-change` contributes the File nodes its edges
  // end on. It claims no authority over them, so nothing about them can be swept.
  for (const node of output.nodes) {
    if (!(NODE_KINDS as ReadonlyArray<string>).includes(node.kind)) {
      return `emitted a node of kind ${JSON.stringify(node.kind)}, which is not a kind in the ontology`;
    }
  }
  return undefined;
}

/** An `ExtractorPort` that runs `program` in the sandbox. */
export function sandboxedPort(host: SandboxHost, program: SandboxProgram): ExtractorPort {
  return {
    name: program.manifest.name,
    version: program.manifest.version,
    provenanceCeiling: program.manifest.provenanceCeiling,
    produces: program.manifest.produces,
    confinement: 'process-sandbox',
    extract: (ctx) => host.run(program, ctx),
  };
}
