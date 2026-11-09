/**
 * Analysing one corpus repository: prove the checkout is the pinned tree, copy it, run the CLI on
 * the copy, and keep (or, for a development repository, reuse) the baseline.
 *
 * This is where the findings of a sealed repository come from, so the rules that keep them honest
 * live here, in a file the freeze watches: a sealed repository is never served from a stored
 * baseline, and a stored baseline is reused only when the sources and the build that made it are
 * the ones being measured now.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OWN_CLI, type CliIdentity } from './build.ts';
import { checkoutDir, fetchRepo, isCloned, verifyPinned } from './fetch.ts';
import { runPipeline } from './pipeline.ts';
import type { CorpusEntry, PipelineResult } from './types.ts';
import { prepareWorkTree } from './workdir.ts';

export interface AnalyseOptions {
  readonly cacheDir: string;
  readonly outDir: string;
  /** Built CLI entry point. */
  readonly cli: string;
  readonly mirrorDir?: string | undefined;
  readonly timeoutMs: number;
  readonly heapMb: number;
  /** Keep scratch trees for inspection instead of deleting them. */
  readonly keepScratch: boolean;
  /**
   * Reuse a previous run's baseline for a dev repository at the same pin, made by the same
   * detector and extractor sources and the same build of the CLI (development aid), and only when
   * that CLI is this repository's own build. A sealed repository is never reused: its findings
   * feed the headline, so they must come from the code that is being measured.
   */
  readonly reuseBaseline: boolean;
  readonly log: (line: string) => void;
}

/** What is being measured: the sources, and the build of the CLI that runs. */
export interface Measured {
  /** `codeIdentity()` of the working tree. */
  readonly codeId: string;
  /** False when `codeId` names no sources (outside a git checkout): it identifies nothing. */
  readonly identified: boolean;
  readonly cli: CliIdentity;
}

/**
 * Why a sealed repository may not be measured with `current`, or null when it may. Its findings
 * feed the headline, so they come from this repository's own build of sources that can be named:
 * never from a CLI picked on the command line, and never where the sources cannot be identified
 * and the freeze cannot be checked.
 */
export function sealedProblem(current: Measured): string | null {
  if (!current.cli.ownBuild) {
    return (
      `a sealed repository is measured only with this repository's own built CLI ` +
      `(${OWN_CLI.join('/')}), not ${current.cli.path}. --cli and SEAMLINE_CLI are for the dev ` +
      'partition (select it with --repo).'
    );
  }
  if (!current.identified) {
    return (
      'a sealed repository is not measured outside a git checkout: the sources that made its ' +
      'findings could not be named, and the freeze could not be checked.'
    );
  }
  return null;
}

/** Clones what is missing, then proves every selected checkout is the pinned tree. */
export async function ensureCorpus(
  entries: readonly CorpusEntry[],
  opts: Pick<AnalyseOptions, 'cacheDir' | 'mirrorDir' | 'log'>,
): Promise<void> {
  for (const entry of entries) {
    const dir = checkoutDir(opts.cacheDir, entry.name);
    if (!(await isCloned(dir))) {
      await fetchRepo(entry, { cacheDir: opts.cacheDir, mirrorDir: opts.mirrorDir, log: opts.log });
    }
    await verifyPinned(entry, dir);
  }
}

/** What `baseline.json` holds. */
export interface StoredBaseline {
  readonly sha: string;
  /** `codeIdentity()` of the run that made this baseline. Absent in a baseline from an older harness. */
  readonly codeId?: string;
  /** The CLI build that made it. Absent in a baseline from an older harness. */
  readonly cli?: CliIdentity;
  readonly pipeline: PipelineResult;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Why a stored baseline was not made by what is being measured, or null when it was. A baseline
 * that recorded nothing about its sources or its build is never accepted, and nothing is accepted
 * for a CLI that is not this repository's own build: what such a CLI loads is not known.
 */
export function baselineMismatch(
  stored: { readonly codeId?: unknown; readonly cli?: unknown },
  current: Measured,
): string | null {
  if (!current.identified) {
    return 'the sources cannot be identified outside a git checkout';
  }
  if (!current.cli.ownBuild) {
    // For a CLI that is not this repository's build, the digest covers the entry file alone and
    // `codeId` describes this repository's sources, not that CLI's: two builds of another
    // checkout with the same entry bytes would otherwise reuse each other's baseline.
    return (
      `the CLI is ${current.cli.path}, not this repository's own build, so what it loads is not ` +
      'known and a baseline is never reused for it'
    );
  }
  if (stored.codeId !== current.codeId) {
    return 'it was made by other detector or extractor sources, or by a harness that did not record them';
  }
  const cli = stored.cli;
  if (
    !isRecord(cli) ||
    cli['path'] !== current.cli.path ||
    cli['ownBuild'] !== current.cli.ownBuild ||
    cli['distDigest'] !== current.cli.distDigest
  ) {
    return 'it was made by another build of the CLI, or by a harness that did not record the build';
  }
  return null;
}

/** The stored baseline when it may be reused, or the reason it may not. */
async function readReusableBaseline(
  file: string,
  entry: CorpusEntry,
  current: Measured,
): Promise<{ readonly pipeline: PipelineResult } | { readonly why: string }> {
  let stored: StoredBaseline;
  try {
    stored = JSON.parse(await readFile(file, 'utf8')) as StoredBaseline;
  } catch {
    return { why: 'none is stored' };
  }
  if (stored.sha !== entry.sha) return { why: 'it is for another commit' };
  if (stored.pipeline?.outcome !== 'complete') return { why: 'it did not complete' };
  const mismatch = baselineMismatch(stored, current);
  if (mismatch !== null) return { why: mismatch };
  return { pipeline: stored.pipeline };
}

export async function analyseBaseline(
  entry: CorpusEntry,
  opts: AnalyseOptions,
  scratch: string,
  current: Measured,
): Promise<{ readonly pipeline: PipelineResult; readonly reused: boolean }> {
  const repoOut = path.join(opts.outDir, entry.name);
  const baselineFile = path.join(repoOut, 'baseline.json');
  if (opts.reuseBaseline) {
    if (entry.partition === 'sealed') {
      opts.log(`${entry.name}: sealed, so analysed afresh (--reuse-baseline does not apply)`);
    } else {
      const stored = await readReusableBaseline(baselineFile, entry, current);
      if ('pipeline' in stored) {
        opts.log(`${entry.name}: reusing the stored baseline`);
        return { pipeline: stored.pipeline, reused: true };
      }
      opts.log(`${entry.name}: not reusing the stored baseline, ${stored.why}`);
    }
  }

  await rm(repoOut, { recursive: true, force: true });
  await mkdir(repoOut, { recursive: true });
  const workDir = path.join(scratch, entry.name, 'repo');
  opts.log(`${entry.name}: copying the pinned tree`);
  await prepareWorkTree(checkoutDir(opts.cacheDir, entry.name), workDir, entry.name);
  opts.log(`${entry.name}: extracting and checking`);
  const pipeline = await runPipeline({
    cli: opts.cli,
    workDir,
    storeDir: path.join(repoOut, 'store'),
    logDir: repoOut,
    repoName: entry.name,
    timeoutMs: opts.timeoutMs,
    heapMb: opts.heapMb,
  });
  if (!opts.keepScratch) await rm(path.join(scratch, entry.name), { recursive: true, force: true });
  const stored: StoredBaseline = {
    sha: entry.sha,
    codeId: current.codeId,
    cli: current.cli,
    pipeline,
  };
  await writeFile(baselineFile, `${JSON.stringify(stored)}\n`, 'utf8');
  opts.log(
    `${entry.name}: ${pipeline.outcome}, ${pipeline.findings.length} finding(s), ` +
      `${(pipeline.extractMs / 1000).toFixed(1)}s extract, ${(pipeline.checkMs / 1000).toFixed(1)}s check`,
  );
  return { pipeline, reused: false };
}
