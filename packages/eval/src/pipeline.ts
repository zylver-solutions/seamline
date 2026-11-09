/**
 * One analysis of one working tree: `seamline extract`, then `seamline check`.
 *
 * Both run as subprocesses of the built CLI with `SEAMLINE_DETERMINISTIC=1`,
 * so the harness measures the same binary a user runs and a crash in an
 * extractor cannot take the harness down with it. Each invocation has a
 * timeout. A repository that crashes, times out, or prints something the
 * harness cannot parse yields every detector as UNKNOWN: never an empty list
 * that could be mistaken for "no contradictions".
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { allUnknown, detectorOutcomes, parseCheckOutput } from './findings.ts';
import { countSifFile, type SifCounts } from './sif.ts';
import type { ExtractorSummary, PipelineOutcome, PipelineResult } from './types.ts';

export interface PipelineOptions {
  /** Path to the built CLI entry point (`packages/cli/dist/index.js`). */
  readonly cli: string;
  /** Prepared working tree, with `seamline.config.json` already written. */
  readonly workDir: string;
  /** Where the graph store and run snapshot go (`--store`). */
  readonly storeDir: string;
  /** Where raw CLI stdout and stderr are kept. */
  readonly logDir: string;
  /** The `repo` segment of every node id; also the corpus name. */
  readonly repoName: string;
  /** Applied to each CLI invocation separately. */
  readonly timeoutMs: number;
  /** `--max-old-space-size` for the CLI process. */
  readonly heapMb: number;
  /** Node executable. Defaults to the one running the harness. */
  readonly node?: string;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  readonly wallMs: number;
}

const PASSTHROUGH_ENV = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'];

/** The CLI's environment: the determinism switches, and nothing inherited beyond the basics. */
export function cliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const v = source[key];
    if (v !== undefined) env[key] = v;
  }
  return {
    ...env,
    SEAMLINE_DETERMINISTIC: '1',
    TZ: 'UTC',
    LC_ALL: 'C',
    SOURCE_DATE_EPOCH: '0',
    NO_COLOR: '1',
  };
}

/**
 * Runs a command with stdout and stderr redirected to files, killing it when
 * it exceeds `timeoutMs`. Output goes to files, not memory: an extraction's
 * `--json` report can be large.
 */
export function runProcess(
  cmd: string,
  args: readonly string[],
  opts: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly stdoutFile: string;
    readonly stderrFile: string;
    readonly cwd?: string;
  },
): Promise<ProcessResult> {
  const outFd = openSync(opts.stdoutFile, 'w');
  const errFd = openSync(opts.stderrFile, 'w');
  return new Promise<ProcessResult>((resolve) => {
    const started = Date.now();
    let timedOut = false;
    let done = false;
    const child = spawn(cmd, [...args], {
      env: opts.env,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnError: string | null,
    ): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      closeSync(outFd);
      closeSync(errFd);
      resolve({ exitCode, signal, timedOut, spawnError, wallMs: Date.now() - started });
    };
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

async function tail(file: string, chars: number): Promise<string> {
  try {
    const text = await readFile(file, 'utf8');
    return text.length > chars ? `...${text.slice(-chars)}` : text;
  } catch {
    return '';
  }
}

function failure(
  outcome: PipelineOutcome,
  detail: string,
  partial: Partial<PipelineResult> = {},
): PipelineResult {
  return {
    outcome,
    detail,
    extractors: [],
    degradedScopes: [],
    nodeCounts: {},
    edgeCounts: {},
    findings: [],
    detectors: allUnknown(detail),
    extractMs: 0,
    checkMs: 0,
    ...partial,
  };
}

const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_CHARS = 300;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reads the extractor table out of `seamline extract --json`. */
export function parseExtractReport(raw: unknown): {
  readonly runId: string;
  readonly extractors: readonly ExtractorSummary[];
  readonly degradedScopes: readonly string[];
} {
  if (!isRecord(raw) || !Array.isArray(raw['results']) || typeof raw['runId'] !== 'string') {
    throw new Error('extract output has no "runId" and "results".');
  }
  const extractors: ExtractorSummary[] = [];
  for (const r of raw['results']) {
    if (!isRecord(r) || typeof r['extractor'] !== 'string' || typeof r['status'] !== 'string') {
      throw new Error('extract output has a malformed extractor result.');
    }
    const scopes = Array.isArray(r['authoritative'])
      ? r['authoritative']
          .map((a) => (isRecord(a) && typeof a['scope'] === 'string' ? a['scope'] : ''))
          .filter((s) => s !== '')
      : [];
    const diagnostics = Array.isArray(r['diagnostics'])
      ? r['diagnostics']
          .filter((d): d is string => typeof d === 'string')
          .slice(0, MAX_DIAGNOSTICS)
          .map((d) =>
            d.length > MAX_DIAGNOSTIC_CHARS ? `${d.slice(0, MAX_DIAGNOSTIC_CHARS)}...` : d,
          )
      : [];
    extractors.push({
      name: r['extractor'],
      version: typeof r['version'] === 'string' ? r['version'] : '',
      status: r['status'],
      nodes: typeof r['nodeCount'] === 'number' ? r['nodeCount'] : 0,
      edges: typeof r['edgeCount'] === 'number' ? r['edgeCount'] : 0,
      scopes: [...new Set(scopes)].sort(),
      diagnostics,
    });
  }
  extractors.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const degraded = Array.isArray(raw['degradedScopes'])
    ? raw['degradedScopes'].filter((s): s is string => typeof s === 'string')
    : [];
  return { runId: raw['runId'], extractors, degradedScopes: degraded };
}

async function snapshotCounts(storeDir: string, runId: string): Promise<SifCounts | null> {
  const runs = path.join(storeDir, 'runs');
  const named = path.join(runs, `${runId}.sif`);
  try {
    return await countSifFile(named);
  } catch {
    // Fall back to the only snapshot in the directory, if there is exactly one.
    try {
      const files = (await readdir(runs)).filter((f) => f.endsWith('.sif'));
      const only = files.length === 1 ? files[0] : undefined;
      return only === undefined ? null : await countSifFile(path.join(runs, only));
    } catch {
      return null;
    }
  }
}

/** Runs extract and check on a prepared tree. Never throws for a repository-level failure. */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const node = opts.node ?? process.execPath;
  const env = cliEnv();
  await mkdir(opts.storeDir, { recursive: true });
  await mkdir(opts.logDir, { recursive: true });
  const heap = `--max-old-space-size=${opts.heapMb}`;
  const common = ['--repo', opts.workDir, '--store', opts.storeDir, '--json'];

  const extractOut = path.join(opts.logDir, 'extract.stdout.json');
  const extractErr = path.join(opts.logDir, 'extract.stderr.txt');
  const ex = await runProcess(node, [heap, opts.cli, 'extract', ...common], {
    env,
    timeoutMs: opts.timeoutMs,
    stdoutFile: extractOut,
    stderrFile: extractErr,
  });
  if (ex.timedOut) {
    return failure(
      'timeout',
      `extract exceeded the ${Math.round(opts.timeoutMs / 1000)}s timeout`,
      { extractMs: ex.wallMs },
    );
  }
  if (ex.spawnError !== null || (ex.exitCode !== 0 && ex.exitCode !== 1)) {
    const why = ex.spawnError ?? `exit ${ex.exitCode ?? ex.signal}: ${await tail(extractErr, 400)}`;
    return failure('crashed', `extract failed (${why.trim()})`, {
      extractMs: ex.wallMs,
    });
  }

  let report: ReturnType<typeof parseExtractReport>;
  try {
    report = parseExtractReport(JSON.parse(await readFile(extractOut, 'utf8')) as unknown);
  } catch (e) {
    return failure('crashed', `extract output unreadable (${(e as Error).message})`, {
      extractMs: ex.wallMs,
    });
  }
  const counts = await snapshotCounts(opts.storeDir, report.runId);

  const checkOut = path.join(opts.logDir, 'check.stdout.json');
  const checkErr = path.join(opts.logDir, 'check.stderr.txt');
  const ck = await runProcess(node, [heap, opts.cli, 'check', ...common], {
    env,
    timeoutMs: opts.timeoutMs,
    stdoutFile: checkOut,
    stderrFile: checkErr,
  });
  const base: Partial<PipelineResult> = {
    extractors: report.extractors,
    degradedScopes: report.degradedScopes,
    nodeCounts: counts?.nodes ?? {},
    edgeCounts: counts?.edges ?? {},
    extractMs: ex.wallMs,
    checkMs: ck.wallMs,
  };
  if (ck.timedOut) {
    return failure(
      'timeout',
      `check exceeded the ${Math.round(opts.timeoutMs / 1000)}s timeout`,
      base,
    );
  }
  if (ck.spawnError !== null || (ck.exitCode !== 0 && ck.exitCode !== 1)) {
    const why = ck.spawnError ?? `exit ${ck.exitCode ?? ck.signal}: ${await tail(checkErr, 400)}`;
    return failure('crashed', `check failed (${why.trim()})`, base);
  }

  try {
    const parsed = parseCheckOutput(
      opts.repoName,
      JSON.parse(await readFile(checkOut, 'utf8')) as unknown,
    );
    const degraded = [...new Set([...report.degradedScopes, ...parsed.degradedScopes])].sort();
    return {
      outcome: 'complete',
      detail: null,
      extractors: report.extractors,
      degradedScopes: degraded,
      nodeCounts: counts?.nodes ?? {},
      edgeCounts: counts?.edges ?? {},
      findings: parsed.findings,
      detectors: detectorOutcomes(parsed.findings, parsed.unknown),
      extractMs: ex.wallMs,
      checkMs: ck.wallMs,
    };
  } catch (e) {
    return failure('crashed', `check output unreadable (${(e as Error).message})`, base);
  }
}
