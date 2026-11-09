#!/usr/bin/env node
/**
 * Seamline dogfood gate. Design v3 §7 ("Dogfood" row), ADR-0009 §4 (gate 4).
 *
 * `seamline extract`, `why` and `check` run on Seamline's own repository, and
 * what they report about it is diffed against a committed, reviewed baseline.
 * This is the credibility test named in v3 §7: an OSS project selling
 * verification that does not pass its own gate is not shippable. It is
 * deliberately not the same thing as the determinism gate
 * (scripts/determinism-gate.mjs), which only checks that two runs agree with
 * each other, and which still proves the full self-extraction is
 * byte-reproducible. This gate checks that today's run agrees with the last
 * *reviewed* run, so an unreviewed change in what Seamline finds about itself
 * fails the build instead of silently landing on main.
 *
 * The baseline (docs/dogfood/baseline/) holds the reviewed regression surface,
 * and deliberately not Seamline's own source symbols, so an ordinary code
 * change does not move it:
 *
 *   why-orders-customer-email.json  `seamline why orders.customer_email`, the
 *                                   flagship chain from v3 §1 on the bundled
 *                                   examples/harbor-books app
 *   code-ts-coverage.json           the tracked TS/JS files the tsconfig project
 *                                   graph did not read (`unread`), compared
 *                                   exactly. Read counts and ratio are printed,
 *                                   never compared: adding a normally-read file
 *                                   is not a regression.
 *   findings.json                   what `seamline check` reports: every
 *                                   contradiction, every UNKNOWN, each
 *                                   extractor's PASS/FAIL/UNAVAILABLE status
 *   examples.sif                    the part of the self-extraction that comes
 *                                   from examples/, byte for byte, in canonical
 *                                   order
 *
 * The one thing not compared byte for byte is the run id's value, in
 * examples.sif and in the `why` output. Under SEAMLINE_DETERMINISTIC it is a
 * digest of this whole repository, so it changes with nearly every commit; it
 * is replaced by a placeholder on both sides (see RUN_ID_PLACEHOLDER in
 * scripts/dogfood-lib.mjs). The id is checked on the fresh output instead: the
 * run file is named for a deterministic run id, and no other run id appears.
 *
 * The pure parts (subset filter, canonicalization, comparison, diff reporting)
 * live in scripts/dogfood-lib.mjs and are tested in
 * scripts/dogfood-gate.test.mjs.
 *
 * IT DOES NOT PASS WHEN IT CANNOT CHECK. A missing CLI, a missing baseline
 * file, a failed extraction, a crashed `check` (exit 1 means "contradictions
 * found" and is expected; anything else is a crash) or an unreadable result all
 * exit non-zero rather than passing vacuously. Same rule as
 * scripts/determinism-gate.mjs.
 *
 * It never moves, hides or deletes a tracked file (the baseline included), so a
 * killed run leaves the working tree as it found it, and every temp path comes
 * from mkdtemp, so concurrent runs on one machine do not touch each other.
 *
 * Usage:
 *   node scripts/dogfood-gate.mjs            compare against the committed baseline
 *   node scripts/dogfood-gate.mjs --update   regenerate the baseline and exit 0
 *   node scripts/dogfood-gate.mjs --keep     keep the temp workdir for inspection
 *
 * `--update` is for an intended, reviewed change only. See "Dogfood baseline
 * changes" in CONTRIBUTING.md. It reads `git ls-files`, so stage new files first.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_FILES,
  baselineSelfReferences,
  canonicalJson,
  canonicalizeFindings,
  compareBaselines,
  foreignRunIds,
  formatProblems,
  isTrackedCodeFile,
  measureCodeCoverage,
  parseCheckRun,
  renderBaselineFiles,
  runIdOfRunFile,
  selectExamplesSif,
} from './dogfood-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_DIR = join(REPO_ROOT, 'docs', 'dogfood', 'baseline');
const BASELINE_LABEL = relative(REPO_ROOT, BASELINE_DIR).split('\\').join('/');
const WHY_TARGET = 'orders.customer_email';

const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const KEEP = argv.includes('--keep');

let workdir = null;

function cleanup() {
  if (workdir === null) return;
  if (KEEP) {
    process.stderr.write(`(workdir kept at ${workdir})\n`);
    return;
  }
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function fail(headline, detail) {
  cleanup();
  process.stderr.write(`dogfood-gate FAILED: ${headline}\n`);
  if (detail) process.stderr.write(detail.replace(/^/gm, '  ') + '\n');
  process.exit(1);
}

function outputOf(result) {
  return (result.error?.message ?? result.stderr ?? result.stdout ?? '').trim().slice(0, 2000);
}

// ---------------------------------------------------------------------------
// Locate the CLI, or fail loudly. Same probe as scripts/determinism-gate.mjs.
// ---------------------------------------------------------------------------

const CLI_CANDIDATES = [
  process.env.SEAMLINE_CLI,
  join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js'),
  join(REPO_ROOT, 'packages', 'cli', 'bin', 'seamline.mjs'),
  join(REPO_ROOT, 'node_modules', '.bin', 'seamline'),
].filter(Boolean);

const cli = CLI_CANDIDATES.find((p) => existsSync(p));

if (!cli) {
  fail(
    'the extraction CLI could not be found',
    [
      'Looked for:',
      ...CLI_CANDIDATES.map((p) => `  - ${relative(REPO_ROOT, p) || p}`),
      '',
      'Build the CLI first:  ./node_modules/.bin/tsc --build',
      'or point SEAMLINE_CLI at an executable entry point.',
    ].join('\n'),
  );
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    timeout: opts.timeout ?? 15 * 60 * 1000,
    env: {
      ...process.env,
      SEAMLINE_DETERMINISTIC: '1',
      TZ: 'UTC',
      LC_ALL: 'C',
      SOURCE_DATE_EPOCH: '0',
      NO_COLOR: '1',
    },
  });
}

// ---------------------------------------------------------------------------
// The baseline must exist before we spend time extracting.
// ---------------------------------------------------------------------------

if (!UPDATE) {
  const missing = Object.values(BASELINE_FILES).filter(
    (name) => !existsSync(join(BASELINE_DIR, name)),
  );
  if (missing.length > 0) {
    fail(
      'no committed baseline found',
      [
        ...missing.map((name) => `expected ${BASELINE_LABEL}/${name}`),
        '',
        'This gate deliberately fails rather than bootstrapping itself silently.',
        'Generate and review a baseline with:',
        '',
        '  node scripts/dogfood-gate.mjs --update',
        `  git diff -- ${BASELINE_LABEL}`,
        `  git add ${BASELINE_LABEL} && git commit`,
      ].join('\n'),
    );
  }
}

// ---------------------------------------------------------------------------
// Extract Seamline itself into a fresh store, then ask it about itself.
// ---------------------------------------------------------------------------

workdir = mkdtempSync(join(tmpdir(), 'seamline-dogfood-'));
const outDir = join(workdir, 'seamline-out');

// The committed baseline lives inside the repo it is a baseline OF
// (docs/dogfood/baseline), and this gate never moves, hides or deletes it, or
// any other tracked file: a run that is killed mid-extraction must not leave
// the working tree changed. (An earlier version of this gate moved the
// directory out of the tree for the extraction. It had to, because that
// baseline embedded a full copy of the self-extraction and a copy of the
// extraction is not an input the extraction may read. The baseline is now four
// small files that no extractor reads: the extraction is byte-identical with
// the directory present or absent.) The invariant is checked rather than
// assumed: if an extractor ever starts reading the baseline, regenerating it
// would change its own input and never settle, so the gate fails below and says
// to exclude the directory from that extractor.
//
// Every temp path here comes from mkdtempSync and only that directory is ever
// removed, so concurrent runs on one machine cannot touch each other's files.

// extract-change is excluded from the dogfood run because its output is a
// function of the whole git log up to HEAD, so it grows by one
// Commit/Changeset/TOUCHES cluster on every commit this repository ever makes,
// including commits that touch nothing this gate can meaningfully review (a
// docs typo, a dependency bump). That is expected motion, not an unreviewed
// regression. extract-change has its own deterministic unit and property tests
// against fixture repos (packages/extract-change/src/*.test.ts); this
// exclusion only removes it from the one comparison that cannot tolerate its
// by-design growth.
const NON_HISTORY_EXTRACTORS = [
  'extract-code-ts',
  'extract-data',
  'extract-contracts',
  'infer-join',
];

const extractResult = runCli([
  'extract',
  '--repo',
  REPO_ROOT,
  '--out',
  outDir,
  ...NON_HISTORY_EXTRACTORS.flatMap((name) => ['--only', name]),
]);
if (extractResult.error || extractResult.status !== 0) {
  fail('`seamline extract` on this repository failed', outputOf(extractResult));
}

const runsDir = join(outDir, 'runs');
if (!existsSync(runsDir)) {
  fail(
    'extraction produced no run output',
    `expected a run file under ${relative(REPO_ROOT, runsDir)}`,
  );
}

// The store starts empty, so the extraction is the only run and there is exactly
// one file here. Its name is the run's id, which under SEAMLINE_DETERMINISTIC is
// derived from the run's inputs (ADR-0009 section 3a).
const sifFiles = readdirSync(runsDir).filter((f) => f.endsWith('.sif'));
if (sifFiles.length !== 1) {
  fail(
    `expected exactly one deterministic run file, found ${sifFiles.length}`,
    sifFiles.join('\n') || '(none)',
  );
}

const runId = runIdOfRunFile(sifFiles[0]);
if (runId === null) {
  fail(
    'the run file is not named for a deterministic run id',
    `found ${sifFiles[0]}, expected run-det-<16 hex digits>.sif`,
  );
}

const extractSif = readFileSync(join(runsDir, sifFiles[0]), 'utf8');

const selfReferences = baselineSelfReferences(extractSif, BASELINE_LABEL);
if (selfReferences.length > 0) {
  fail(
    `the self-extraction reads files inside ${BASELINE_LABEL}`,
    [
      ...selfReferences,
      '',
      'An extractor now treats the committed baseline as source, so regenerating the baseline',
      'would change its own input and never settle. Exclude that directory from the extractor.',
    ].join('\n'),
  );
}

const whyResult = runCli(['why', WHY_TARGET, '--repo', REPO_ROOT, '--out', outDir, '--json']);
if (whyResult.error || whyResult.status !== 0) {
  fail(
    `\`seamline why ${WHY_TARGET}\` failed`,
    outputOf(whyResult) +
      '\n\nIf examples/harbor-books changed shape, WHY_TARGET in this script may need updating.',
  );
}
let whyJson;
try {
  // Re-serialize with sorted keys and a trailing newline so the baseline diffs
  // on content, not on incidental JSON.stringify key order from the CLI.
  whyJson = canonicalJson(JSON.parse(whyResult.stdout));
} catch (e) {
  fail(`\`seamline why ${WHY_TARGET} --json\` did not print JSON`, e.message);
}

// The baseline is compared modulo the run id's value, so a run id that is not
// the one just extracted would be hidden by that normalisation. Look for it here.
for (const [label, text] of [
  ['the run snapshot', extractSif],
  [`\`seamline why ${WHY_TARGET}\``, whyJson],
]) {
  const foreign = foreignRunIds(text, runId);
  if (foreign.length > 0) {
    fail(
      `${label} mentions a run other than the one just extracted (${runId})`,
      foreign.join('\n'),
    );
  }
}

// `check` exits 1 when it finds a critical or high contradiction. Findings on
// this repository are expected and are what findings.json records; only a
// crash (any other exit status, or output that is not a check report) fails.
const checkResult = runCli(['check', '--repo', REPO_ROOT, '--out', outDir, '--json']);
if (checkResult.error) {
  fail('`seamline check` could not run', outputOf(checkResult));
}
let checkReport;
try {
  checkReport = parseCheckRun(checkResult.status, checkResult.stdout);
} catch (e) {
  fail('`seamline check` on this repository failed', `${e.message}\n${outputOf(checkResult)}`);
}

// ---------------------------------------------------------------------------
// Build the current record
// ---------------------------------------------------------------------------

// code.ts reads the tsconfig project graph, not every source file, so a PASS
// says nothing about files outside that graph. Coverage is measured against
// `git ls-files` (the published tree), not the extractor's own count.
const listed = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
if (listed.error || listed.status !== 0) {
  fail(
    '`git ls-files` failed, so code.ts coverage cannot be measured',
    listed.stderr?.trim() ?? '',
  );
}
const trackedCode = listed.stdout
  .split('\0')
  .filter((p) => isTrackedCodeFile(p) && existsSync(join(REPO_ROOT, p)));

let current;
try {
  const coverage = measureCodeCoverage(trackedCode, extractSif);
  const examples = selectExamplesSif(extractSif);
  current = {
    coverage,
    examples: examples.text,
    examplesCounts: { nodes: examples.nodes, edges: examples.edges },
    findings: canonicalizeFindings(checkReport, extractSif),
    why: whyJson,
  };
} catch (e) {
  fail('the self-extraction could not be reduced to a baseline record', e.message);
}

if (current.coverage.unreported.length > 0) {
  fail(
    `extract-code-ts did not read ${current.coverage.unreported.length} tracked file(s) and did not report them`,
    current.coverage.unreported.join('\n'),
  );
}
if (current.examplesCounts.nodes === 0) {
  fail(
    'the self-extraction contains no nodes from examples/',
    'examples.sif would be empty. If the bundled examples moved, update EXAMPLES_PREFIX in scripts/dogfood-lib.mjs.',
  );
}

// ---------------------------------------------------------------------------
// Write, or compare against, the committed baseline
// ---------------------------------------------------------------------------

const summary = [
  `check: ${current.findings.contradictions.length} contradiction(s), ` +
    `${current.findings.unknownDetectors.length} UNKNOWN detector(s), ` +
    `${current.findings.extractors.length} extractor scope status(es)`,
  `examples/: ${current.examplesCounts.nodes} node(s), ${current.examplesCounts.edges} edge(s), ` +
    `${Buffer.byteLength(current.examples)} bytes`,
  `code.ts coverage: ${current.coverage.read}/${current.coverage.tracked} tracked TypeScript/JavaScript ` +
    `files read (ratio ${current.coverage.ratio}), ${current.coverage.unread.length} unread`,
].join('\n');

if (UPDATE) {
  mkdirSync(BASELINE_DIR, { recursive: true });
  for (const [name, text] of Object.entries(renderBaselineFiles(current))) {
    writeFileSync(join(BASELINE_DIR, name), text);
  }
  cleanup();
  process.stdout.write(
    `dogfood-gate: baseline written to ${BASELINE_LABEL}\n${summary}\n` +
      `Review the diff with \`git diff -- ${BASELINE_LABEL}\` before committing. A baseline change ` +
      'lands in its own pull request, with the reason (CONTRIBUTING.md).\n',
  );
  process.exit(0);
}

const baseline = Object.fromEntries(
  Object.entries(BASELINE_FILES).map(([key, name]) => [
    key,
    readFileSync(join(BASELINE_DIR, name), 'utf8'),
  ]),
);

const problems = compareBaselines(baseline, current);

if (problems.length > 0) {
  fail(
    `Seamline's self-extraction differs from the reviewed baseline (${problems.length} file(s))`,
    `${formatProblems(problems, BASELINE_LABEL)}\n\n` +
      'If this is a regression, fix the code. If the change is intended, the baseline update lands in\n' +
      'its own pull request with the reason, stacked on the behaviour change and reviewed on its own:\n\n' +
      '  node scripts/dogfood-gate.mjs --update\n' +
      `  git diff -- ${BASELINE_LABEL}\n\n` +
      'Never run --update just to clear a red build (CONTRIBUTING.md, "Dogfood baseline changes").',
  );
}

cleanup();
process.stdout.write(
  `dogfood-gate PASSED: what Seamline finds about itself matches the reviewed baseline ` +
    `(\`why ${WHY_TARGET}\`, \`check\`, examples/, code.ts coverage)\n${summary}\n`,
);
