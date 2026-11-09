/**
 * The evaluation: verify the pins, analyse each repository, run the mutants,
 * join findings to labels, and write the report.
 *
 * Nothing here changes what the CLI does. It copies a pinned tree to scratch,
 * runs the built binary on the copy, and reads what the binary prints.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  analyseBaseline,
  ensureCorpus,
  sealedProblem,
  type AnalyseOptions,
  type Measured,
} from './analyse.ts';
import { cliIdentity } from './build.ts';
import { loadCorpus, readJsonFile } from './corpus.ts';
import { ConfigError } from './errors.ts';
import { checkoutDir, fetchRepo } from './fetch.ts';
import { NO_GIT, readFreeze, sealedEntriesDigest } from './freeze.ts';
import { matchLabels, parseLabels } from './labels.ts';
import { parseReviewMetadata } from './review.ts';
import { applyEdits, judgeMutant, MutantEditError, parseMutants } from './mutants.ts';
import { runPipeline } from './pipeline.ts';
import {
  buildReport,
  renderMarkdown,
  serializeReport,
  type MutantRun,
  type RepoRun,
  type Report,
} from './report.ts';
import type { CorpusEntry, Mutant } from './types.ts';
import { prepareWorkTree } from './workdir.ts';

export { ensureCorpus } from './analyse.ts';

export interface EvaluateOptions extends AnalyseOptions {
  readonly corpusFile: string;
  readonly labelsFile: string;
  readonly mutantsFile: string;
  /** Corpus names to analyse. Empty means all. */
  readonly only: readonly string[];
  /** Mutant ids to run. Empty means all of the selected repositories' mutants. */
  readonly mutantIds: readonly string[];
  readonly runMutants: boolean;
  readonly allowUnlabelled: boolean;
  /**
   * Builds the repository (`tsc --build --force`) so that `dist/` is made from the sources being measured.
   * It runs before anything is measured, and a run does not start without it: a `dist/` left by an
   * earlier build would be measured under the identity of the current sources. It throws when the
   * build fails.
   */
  readonly build: () => Promise<void>;
  /**
   * The digest of the sources that decide what a finding is (`codeIdentity`). It is stored with
   * every baseline, and a baseline is reused only when it equals the current one. Called after
   * `build`.
   */
  readonly codeIdentity: () => Promise<string>;
  /** The digest of the harness code the freeze does not watch (`scorerIdentity`), recorded in the report. */
  readonly scorerIdentity: () => Promise<string>;
  /** Where scratch trees go. Defaults to the OS temporary directory. */
  readonly scratchRoot?: string | undefined;
  /** `eval/FREEZE`, and the repository whose detector and extractor sources it freezes. */
  readonly freezeFile: string;
  readonly root: string;
}

export interface EvaluateResult {
  readonly report: Report;
  readonly exitCode: number;
  /** Reasons the run exited non-zero, one per line, for the caller to print. */
  readonly problems: readonly string[];
}

function selectRepos(corpus: readonly CorpusEntry[], only: readonly string[]): CorpusEntry[] {
  if (only.length === 0) return corpus.slice();
  const known = new Set(corpus.map((c) => c.name));
  const unknown = only.filter((n) => !known.has(n));
  if (unknown.length > 0) {
    throw new ConfigError(
      `unknown repository ${unknown.join(', ')}; the corpus has: ${[...known].join(', ')}`,
    );
  }
  return corpus.filter((c) => only.includes(c.name));
}

/** `pnpm eval fetch`: clone or repair every selected checkout, then verify it. */
export async function fetchCorpus(
  entries: readonly CorpusEntry[],
  opts: Pick<EvaluateOptions, 'cacheDir' | 'mirrorDir' | 'log'>,
): Promise<void> {
  for (const entry of entries) {
    const result = await fetchRepo(entry, {
      cacheDir: opts.cacheDir,
      mirrorDir: opts.mirrorDir,
      log: opts.log,
    });
    opts.log(`${entry.name}: ${result.action}, at ${entry.sha}`);
  }
}

async function runOneMutant(
  mutant: Mutant,
  base: RepoRun | undefined,
  opts: EvaluateOptions,
  scratch: string,
): Promise<MutantRun> {
  const started = Date.now();
  const done = (partial: Omit<MutantRun, 'mutant' | 'wallMs'>): MutantRun => ({
    mutant,
    wallMs: Date.now() - started,
    ...partial,
  });

  if (base === undefined || base.pipeline.outcome !== 'complete') {
    return done({
      status: 'skipped',
      detail: `the unmodified ${mutant.repo} run is unavailable, so there is nothing to compare against`,
      verdict: null,
    });
  }

  const entry = base.entry;
  const mutantScratch = path.join(scratch, `mutant-${mutant.id}`);
  const workDir = path.join(mutantScratch, 'repo');
  const logDir = path.join(opts.outDir, 'mutants', mutant.id);
  await rm(logDir, { recursive: true, force: true });
  await mkdir(logDir, { recursive: true });
  try {
    await prepareWorkTree(checkoutDir(opts.cacheDir, entry.name), workDir, entry.name);
    try {
      await applyEdits(workDir, mutant.edits);
    } catch (e) {
      if (e instanceof MutantEditError) {
        return done({ status: 'invalid', detail: e.message, verdict: null });
      }
      throw e;
    }
    opts.log(`mutant ${mutant.id}: extracting and checking`);
    const pipeline = await runPipeline({
      cli: opts.cli,
      workDir,
      storeDir: path.join(mutantScratch, 'store'),
      logDir,
      repoName: entry.name,
      timeoutMs: opts.timeoutMs,
      heapMb: opts.heapMb,
    });
    if (pipeline.outcome !== 'complete') {
      return done({
        status: 'error',
        detail: `the mutated run did not complete (${pipeline.outcome}: ${pipeline.detail ?? ''})`,
        verdict: null,
      });
    }
    const verdict = judgeMutant(base.pipeline.findings, pipeline.findings, mutant.expect);
    if (verdict.detected) return done({ status: 'detected', detail: null, verdict });
    const state = pipeline.detectors[mutant.detector].state;
    return state === 'unknown'
      ? done({
          status: 'unknown',
          detail: `${mutant.detector} was UNKNOWN on the mutated run: ${pipeline.detectors[mutant.detector].reason ?? ''}`,
          verdict,
        })
      : done({ status: 'missed', detail: null, verdict });
  } finally {
    if (!opts.keepScratch) await rm(mutantScratch, { recursive: true, force: true });
  }
}

/**
 * Builds the repository, then names what was built: the sources (`codeIdentity`) and the CLI that
 * will run (`cliIdentity`). The order is the point: the digest of the compiled output is taken
 * after the build, so it describes the build the sources produced.
 */
export async function measureNow(
  opts: Pick<EvaluateOptions, 'build' | 'root' | 'cli' | 'codeIdentity'>,
): Promise<Measured> {
  await opts.build();
  const cli = await cliIdentity(opts.root, opts.cli);
  const codeId = await opts.codeIdentity();
  return { codeId, identified: codeId !== NO_GIT, cli };
}

export async function evaluate(opts: EvaluateOptions): Promise<EvaluateResult> {
  const started = Date.now();
  const startedAt = new Date().toISOString();

  const corpus = await loadCorpus(opts.corpusFile);
  const rawLabels: unknown = await readJsonFile(opts.labelsFile);
  const labels = parseLabels(rawLabels);
  const reviewMetadata = parseReviewMetadata((rawLabels as Record<string, unknown>)['_review']);
  const allMutants = parseMutants(await readJsonFile(opts.mutantsFile), corpus);
  const entries = selectRepos(corpus, opts.only);
  const freeze = await readFreeze(opts.freezeFile, opts.root);

  const knownMutantIds = new Set(allMutants.map((m) => m.id));
  const unknownIds = opts.mutantIds.filter((id) => !knownMutantIds.has(id));
  if (unknownIds.length > 0) throw new ConfigError(`unknown mutant ${unknownIds.join(', ')}`);

  // Measure the sources as they stand. Nothing below runs on a `dist/` this call did not just make.
  const measured = await measureNow(opts);
  const { codeId, cli } = measured;
  const scorerDigest = await opts.scorerIdentity();
  if (entries.some((e) => e.partition === 'sealed')) {
    const problem = sealedProblem(measured);
    if (problem !== null) throw new ConfigError(problem);
  }

  // Refuse before measuring anything if a checkout is not the pinned tree.
  await ensureCorpus(entries, opts);

  const scratch = path.join(
    opts.scratchRoot ?? tmpdir(),
    `seamline-eval-${process.pid}-${Date.now().toString(36)}`,
  );
  await mkdir(scratch, { recursive: true });
  await mkdir(opts.outDir, { recursive: true });

  const repos: RepoRun[] = [];
  const reused: string[] = [];
  const mutantRuns: MutantRun[] = [];
  try {
    for (const entry of entries) {
      const { pipeline, reused: wasReused } = await analyseBaseline(entry, opts, scratch, measured);
      repos.push({ entry, pipeline });
      if (wasReused) reused.push(entry.name);
    }

    if (opts.runMutants) {
      const selected = allMutants
        .filter((m) => entries.some((e) => e.name === m.repo))
        .filter((m) => opts.mutantIds.length === 0 || opts.mutantIds.includes(m.id));
      const byName = new Map(repos.map((r) => [r.entry.name, r]));
      for (const mutant of selected) {
        const run = await runOneMutant(mutant, byName.get(mutant.repo), opts, scratch);
        opts.log(
          `mutant ${mutant.id}: ${run.status}${run.detail === null ? '' : ` (${run.detail})`}`,
        );
        mutantRuns.push(run);
      }
    }
  } finally {
    if (!opts.keepScratch) await rm(scratch, { recursive: true, force: true });
  }

  const partial =
    opts.only.length > 0 ||
    opts.mutantIds.length > 0 ||
    !opts.runMutants ||
    entries.length < corpus.length;
  const complete = repos.every((r) => r.pipeline.outcome === 'complete');
  const sealedRepos = new Set(
    repos.filter((r) => r.entry.partition === 'sealed').map((r) => r.entry.name),
  );
  const match = matchLabels(
    repos.flatMap((r) => r.pipeline.findings),
    labels,
    !partial && complete,
    sealedRepos,
  );
  if (freeze.state === 'none' && match.labelled.some((l) => sealedRepos.has(l.finding.repo))) {
    // Not an exit code to shrug at: a sealed label before the freeze means the sealed
    // partition has been read while detectors were still being changed.
    throw new ConfigError(
      `${path.basename(opts.labelsFile)} labels a finding in the sealed partition, but ` +
        `${path.basename(opts.freezeFile)} does not exist. Sealed labels are committed only after the ` +
        'detector and extractor change set is frozen; record the freeze commit in eval/FREEZE first.',
    );
  }

  const report = buildReport({
    reviewMetadata,
    repos,
    mutants: mutantRuns,
    match,
    partial,
    freeze,
    provenance: { codeId, scorerDigest, sealedCorpusDigest: sealedEntriesDigest(corpus), cli },
    run: {
      startedAt,
      node: process.version,
      totalWallMs: Date.now() - started,
      reusedBaselines: reused.sort(),
    },
  });

  await writeFile(path.join(opts.outDir, 'report.json'), serializeReport(report), 'utf8');
  await writeFile(path.join(opts.outDir, 'report.md'), renderMarkdown(report), 'utf8');

  const problems: string[] = [];
  if (report.headline.reviewIncomplete) {
    problems.push('sealed label review evidence is incomplete: independent primary identities and the required double-review sample must be recorded; allow-unlabelled does not waive this.');
  }
  for (const r of repos) {
    if (r.pipeline.outcome !== 'complete') {
      // The cause can name the repository's own files; for a sealed one say only what happened.
      const cause = sealedRepos.has(r.entry.name) ? r.pipeline.outcome : (r.pipeline.detail ?? '');
      problems.push(
        `${r.entry.name}: analysis ${r.pipeline.outcome} (${cause}); its detectors are UNKNOWN, not clean.`,
      );
    }
  }
  if (freeze.state === 'burned') {
    problems.push(
      `the sealed partition is burned: ${freeze.changed.length} frozen path(s) changed since ` +
        `the freeze at ${freeze.sha?.slice(0, 12) ?? '?'} (${freeze.changed.slice(0, 5).join(', ')}` +
        `${freeze.changed.length > 5 ? ', ...' : ''}). Replace the sealed repositories and record a new freeze.`,
    );
  }
  if (match.unlabelled.length > 0 && !opts.allowUnlabelled) {
    const open = match.unlabelled.filter((f) => !sealedRepos.has(f.repo));
    const held = match.unlabelled.filter((f) => sealedRepos.has(f.repo));
    const heldRepos = [...new Set(held.map((f) => f.repo))].sort();
    problems.push(
      `${match.unlabelled.length} finding(s) have no label in ${path.basename(opts.labelsFile)}; ` +
        'review them, or pass --allow-unlabelled to report them without counting them:',
      ...open.map((f) => `  ${f.id}  ${f.code}  ${f.repo}  ${f.left}  ->  ${f.right}`),
      ...(held.length === 0
        ? []
        : [
            `  ${held.length} more in the sealed partition (${heldRepos.join(', ')}); ` +
              'their subjects are withheld here. Reviewers: `pnpm eval label-sheet <repo>`.',
          ]),
    );
  }
  for (const m of mutantRuns) {
    if (m.status === 'invalid' || m.status === 'error') {
      problems.push(`mutant ${m.mutant.id}: ${m.status}: ${m.detail ?? ''}`);
    }
  }

  return { report, exitCode: problems.length > 0 ? 1 : 0, problems };
}
