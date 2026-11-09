/**
 * `pnpm eval`: the evaluation harness.
 *
 * Exit codes:
 *   0  the evaluation ran and nothing needs attention
 *   1  the evaluation ran but cannot be trusted as it stands: a finding has no
 *      label, a mutant is invalid or errored, or a repository was not analysed
 *   2  a usage or configuration problem, or a checkout that is not the pinned
 *      commit (nothing was measured)
 *   3  an unexpected failure in the harness itself
 */

import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildProduct } from './build.ts';
import { loadCorpus, readJsonFile } from './corpus.ts';
import {
  ConfigError,
  DirtyCheckoutError,
  PinMismatchError,
  UnguardedCheckoutError,
} from './errors.ts';
import {
  ensureCorpus,
  evaluate,
  fetchCorpus,
  measureNow,
  type EvaluateOptions,
} from './evaluate.ts';
import { checkoutDir } from './fetch.ts';
import { GitError } from './git.ts';
import { codeIdentity, NO_FREEZE, readFreeze, scorerIdentity } from './freeze.ts';
import { buildLabelSheet } from './label-sheet.ts';
import { checkMutants, parseMutants } from './mutants.ts';
import { renderMarkdown } from './report.ts';

const HELP = `pnpm eval: measure the detector catalog on pinned public repositories.

USAGE
  pnpm eval [run] [options]     build this repository (tsc --build --force), fetch what is missing,
                                analyse, run mutants, write the report
  pnpm eval fetch [options]     clone or repair the pinned checkouts, then verify them
  pnpm eval check-mutants       apply every mutant's edits in memory to the pinned checkouts and
                                report the ones that no longer apply exactly once (no extraction)
  pnpm eval label-sheet <repo>  print the blind label sheet for one repository: finding id,
                                code, and the two subject locations, nothing else. Needs a
                                stored baseline from a previous run. For a sealed repository
                                it is refused until eval/FREEZE exists, and again once the
                                partition is burned (a watched path changed since).
                                It then builds this repository and shows only a baseline that
                                the current sources and build made.

OPTIONS
  --allow-unlabelled     Report findings that have no label instead of failing. They are
                         excluded from precision.
  --repo <name>          Only this corpus repository. Repeatable.
  --no-mutants           Do not run mutants.
  --mutant <id>          Only this mutant. Repeatable.
  --timeout <minutes>    Limit for each CLI invocation. Default 30.
  --heap <megabytes>     Node heap limit for the CLI. Default 6144.
  --cli <path>           Built CLI entry point, for dev repositories only. Default
                         packages/cli/dist/index.js (this repository's build), or
                         $SEAMLINE_CLI. A sealed repository is refused any other CLI.
  --cache <dir>          Checkout cache. Default .eval-cache.
  --out <dir>            Report and artefact directory. Default eval-out.
  --mirrors <dir>        Borrow objects from <dir>/<name> when it exists while cloning
                         from the URL (development speed-up; the pin is verified
                         the same way). Or $SEAMLINE_EVAL_MIRRORS.
  --keep-scratch         Keep scratch trees for inspection.
  --reuse-baseline       Reuse a stored baseline for a dev repository at the same pin,
                         made by the same detector and extractor sources and the same
                         build of the CLI (development aid for iterating on mutants).
                         A sealed repository is always analysed afresh, and so is any
                         repository when --cli names a CLI that is not this repository's build.
  -h, --help             Show this help.

The harness never runs anything from a fetched repository: no install, no
scripts, no build. It does build this repository first, so that it measures
the sources as they are. Nothing from the corpus is committed.
`;

function repoRoot(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      'allow-unlabelled': { type: 'boolean', default: false },
      repo: { type: 'string', multiple: true },
      'no-mutants': { type: 'boolean', default: false },
      mutant: { type: 'string', multiple: true },
      timeout: { type: 'string' },
      heap: { type: 'string' },
      cli: { type: 'string' },
      cache: { type: 'string' },
      out: { type: 'string' },
      mirrors: { type: 'string' },
      'keep-scratch': { type: 'boolean', default: false },
      'reuse-baseline': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const v = parsed.values;
  if (v.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const command = parsed.positionals[0] ?? 'run';
  const sheet = command === 'label-sheet';
  if (
    (command !== 'run' && command !== 'fetch' && command !== 'check-mutants' && !sheet) ||
    parsed.positionals.length > (sheet ? 2 : 1)
  ) {
    throw new ConfigError(
      `unknown command "${parsed.positionals.join(' ')}". Use run, fetch, check-mutants, or label-sheet <repo>.`,
    );
  }

  const root = repoRoot();
  const minutes = positive(v.timeout, 30, '--timeout');
  const heapMb = positive(v.heap, 6144, '--heap');
  const cli = path.resolve(
    v.cli ?? process.env['SEAMLINE_CLI'] ?? path.join(root, 'packages', 'cli', 'dist', 'index.js'),
  );
  const mirrors = v.mirrors ?? process.env['SEAMLINE_EVAL_MIRRORS'];
  const opts: EvaluateOptions = {
    corpusFile: path.join(root, 'eval', 'corpus.json'),
    labelsFile: path.join(root, 'eval', 'labels.json'),
    mutantsFile: path.join(root, 'eval', 'mutants.json'),
    freezeFile: path.join(root, 'eval', 'FREEZE'),
    root,
    cacheDir: path.resolve(v.cache ?? path.join(root, '.eval-cache')),
    outDir: path.resolve(v.out ?? path.join(root, 'eval-out')),
    cli,
    mirrorDir: mirrors === undefined || mirrors === '' ? undefined : path.resolve(mirrors),
    only: v.repo ?? [],
    mutantIds: v.mutant ?? [],
    runMutants: !v['no-mutants'],
    allowUnlabelled: v['allow-unlabelled'],
    timeoutMs: minutes * 60 * 1000,
    heapMb,
    keepScratch: v['keep-scratch'],
    reuseBaseline: v['reuse-baseline'],
    build: () => buildProduct(root),
    codeIdentity: () => codeIdentity(root),
    scorerIdentity: () => scorerIdentity(root),
    log: (line) => process.stderr.write(`${line}\n`),
  };

  if (command === 'fetch') {
    const corpus = await loadCorpus(opts.corpusFile);
    const selected =
      opts.only.length === 0 ? corpus : corpus.filter((c) => opts.only.includes(c.name));
    if (selected.length === 0) throw new ConfigError('no corpus repository matches --repo.');
    await fetchCorpus(selected, opts);
    return 0;
  }

  if (command === 'check-mutants') {
    const corpus = await loadCorpus(opts.corpusFile);
    const mutants = parseMutants(await readJsonFile(opts.mutantsFile), corpus);
    await ensureCorpus(
      corpus.filter((c) => mutants.some((m) => m.repo === c.name)),
      opts,
    );
    const checks = await checkMutants(mutants, (repo) => checkoutDir(opts.cacheDir, repo));
    for (const c of checks)
      process.stdout.write(
        `${c.problem === null ? 'ok  ' : 'FAIL'} ${c.id}${c.problem === null ? '' : `: ${c.problem}`}\n`,
      );
    return checks.every((c) => c.problem === null) ? 0 : 1;
  }

  if (sheet) {
    const name = parsed.positionals[1];
    if (name === undefined) throw new ConfigError('label-sheet needs a repository name.');
    const entry = (await loadCorpus(opts.corpusFile)).find((c) => c.name === name);
    if (entry === undefined) throw new ConfigError(`unknown repository ${name}.`);
    // Only a sealed sheet depends on the freeze, and on what is being measured. A dev sheet must
    // work with eval/FREEZE absent, malformed, or naming a commit this clone does not have, so it
    // is not even read, and nothing is built.
    const sealed = entry.partition === 'sealed';
    const freeze = sealed ? await readFreeze(opts.freezeFile, opts.root) : NO_FREEZE;
    // The build runs only when the sheet can open: a refused sheet changes nothing on disk.
    const current = sealed && freeze.state === 'frozen' ? await measureNow(opts) : null;
    process.stdout.write(
      await buildLabelSheet(entry, path.join(opts.outDir, entry.name), freeze, current),
    );
    return 0;
  }

  const result = await evaluate(opts);
  process.stdout.write(renderMarkdown(result.report, { appendix: false, runMeta: true }));
  process.stderr.write(
    `\nFull report: ${path.join(opts.outDir, 'report.md')} and ${path.join(opts.outDir, 'report.json')}\n`,
  );
  for (const line of result.problems) process.stderr.write(`${line}\n`);
  return result.exitCode;
}

function positive(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${flag} must be a positive number.`);
  return n;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (
    e instanceof ConfigError ||
    e instanceof PinMismatchError ||
    e instanceof DirtyCheckoutError ||
    e instanceof UnguardedCheckoutError
  ) {
    process.stderr.write(`eval: ${e.message}\n`);
    process.exitCode = 2;
  } else if (e instanceof GitError) {
    process.stderr.write(`eval: ${e.message}\n`);
    process.exitCode = 2;
  } else if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) {
    process.stderr.write(`eval: ${e.message}\nRun with --help for the option list.\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(
      `eval: unexpected failure: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exitCode = 3;
  }
}
