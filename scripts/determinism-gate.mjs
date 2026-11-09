#!/usr/bin/env node
/**
 * Seamline determinism gate. Design v3 §2.3.
 *
 * Extraction must be byte-reproducible. Golden-file testing, `seamline diff`,
 * and any merge driver are all worthless without it, and v2 shipped
 * `created_at`/`updated_at` on every node, which alone makes byte-identical
 * output impossible.
 *
 * The gate runs extraction twice into the *same* output path (deliberately:
 * two different temp paths would hide exactly the absolute-path leakage §2.3
 * forbids), snapshots each run, and fails on the first byte that differs.
 *
 * The run id is part of what is compared: it names the snapshot file and is
 * stamped on every node. Under SEAMLINE_DETERMINISTIC it is derived from the
 * run's inputs (ADR-0009 section 3a), so both runs, which read the same tree,
 * must arrive at the same id; a derivation that leaked anything else (a path, a
 * time, a counter) shows up here as a differing file name and differing bytes.
 *
 * IT DOES NOT PASS WHEN IT CANNOT CHECK. If the CLI is not wired up yet, this
 * exits non-zero with "not yet wired". A gate that goes green because it found
 * nothing to inspect is worse than no gate: it converts an unverified claim
 * into a green check mark.
 *
 * Usage:
 *   node scripts/determinism-gate.mjs                  extract this repo (dogfood)
 *   node scripts/determinism-gate.mjs --target <dir>   extract another repo
 *   node scripts/determinism-gate.mjs --keep           keep the temp workdir for inspection
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const TARGET = resolve(flag('--target') ?? REPO_ROOT);
const KEEP = argv.includes('--keep');

/** Exit 1 with a message that says which gate failed and why. Never exit 0 on doubt. */
function fail(headline, detail) {
  process.stderr.write(`determinism-gate FAILED: ${headline}\n`);
  if (detail) process.stderr.write(detail.replace(/^/gm, '  ') + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Locate the CLI, or fail loudly
// ---------------------------------------------------------------------------

const CLI_CANDIDATES = [
  process.env.SEAMLINE_CLI,
  join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js'),
  join(REPO_ROOT, 'packages', 'cli', 'bin', 'seamline.mjs'),
  join(REPO_ROOT, 'node_modules', '.bin', 'seamline'),
].filter(Boolean);

const cli = CLI_CANDIDATES.find((p) => existsSync(p));

const NOT_WIRED = [
  'the Seamline CLI is not wired up yet, so determinism cannot be checked.',
  '',
  'Looked for:',
  ...CLI_CANDIDATES.map((p) => `  - ${relative(REPO_ROOT, p) || p}`),
  '',
  'This gate deliberately fails rather than passing vacuously (v3 §2.3, §2.2:',
  'UNAVAILABLE is never PASS). Build the CLI first:',
  '',
  '  ./node_modules/.bin/tsc --build',
  '',
  'or point SEAMLINE_CLI at an executable entry point.',
].join('\n');

if (!cli) fail('the extraction CLI could not be found', NOT_WIRED);

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd ?? TARGET,
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

// Probe: an entry point that exists but cannot run `extract` is still "not wired".
const probe = runCli(['extract', '--help'], { timeout: 60_000, cwd: REPO_ROOT });
const probeOutput = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
// A stub entry point that exits 0 and prints nothing is not a working CLI. Requiring
// the word "extract" back means an empty module cannot satisfy this probe.
const probeLooksWired = probe.status === 0 && /extract/i.test(probeOutput);
if (probe.error || !probeLooksWired) {
  fail(
    '`seamline extract --help` did not produce a usable response, so extraction is not runnable',
    [
      NOT_WIRED,
      '',
      `exit status: ${probe.status ?? 'signal ' + probe.signal}`,
      probe.error ? `error: ${probe.error.message}` : '',
      probeOutput.trim() === ''
        ? 'the entry point produced no output at all, it is a stub, not a CLI'
        : probeOutput.trim().slice(0, 800),
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Two runs, same output path
// ---------------------------------------------------------------------------

const workdir = mkdtempSync(join(tmpdir(), 'seamline-determinism-'));
const outDir = join(workdir, 'seamline-out');
const snapshots = [join(workdir, 'run-a'), join(workdir, 'run-b')];

function cleanup() {
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

function extractOnce(index) {
  rmSync(outDir, { recursive: true, force: true });
  const r = runCli(['extract', '--out', outDir]);
  if (r.error) {
    cleanup();
    fail(`run ${index + 1} of \`seamline extract\` could not be started`, r.error.message);
  }
  if (r.status !== 0) {
    cleanup();
    fail(
      `run ${index + 1} of \`seamline extract\` exited ${r.status ?? 'on signal ' + r.signal}`,
      (r.stderr || r.stdout || '').trim().slice(0, 2000),
    );
  }
  if (!existsSync(outDir)) {
    cleanup();
    fail(`run ${index + 1} produced no output at ${outDir}`, 'Nothing to compare is not a pass.');
  }
  cpSync(outDir, snapshots[index], { recursive: true });
}

extractOnce(0);
extractOnce(1);

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

function walkFiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const filesA = walkFiles(snapshots[0]);
const filesB = walkFiles(snapshots[1]);

if (filesA.length === 0) {
  cleanup();
  fail('extraction produced zero output files', 'An empty output tree cannot demonstrate determinism.');
}

const setB = new Set(filesB);
const onlyA = filesA.filter((f) => !setB.has(f));
const setA = new Set(filesA);
const onlyB = filesB.filter((f) => !setA.has(f));

const problems = [];
for (const f of onlyA) problems.push(`only in run 1: ${f}`);
for (const f of onlyB) problems.push(`only in run 2: ${f}`);

/** First differing byte offset, plus a short window of context on each side. */
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const from = Math.max(0, i - 40);
  return {
    offset: i,
    a: JSON.stringify(a.subarray(from, i + 40).toString('utf8')),
    b: JSON.stringify(b.subarray(from, i + 40).toString('utf8')),
  };
}

let compared = 0;
for (const f of filesA) {
  if (!setB.has(f)) continue;
  const a = readFileSync(join(snapshots[0], f));
  const b = readFileSync(join(snapshots[1], f));
  compared++;
  if (a.equals(b)) continue;
  const d = firstDifference(a, b);
  problems.push(
    `${f}: ${a.length} vs ${b.length} bytes; first difference at byte ${d.offset}\n` +
      `    run 1: ${d.a}\n` +
      `    run 2: ${d.b}\n` +
      `    sha256 ${createHash('sha256').update(a).digest('hex').slice(0, 16)} vs ` +
      `${createHash('sha256').update(b).digest('hex').slice(0, 16)}`,
  );
}

if (problems.length > 0) {
  cleanup();
  fail(
    `extraction is not byte-reproducible (${problems.length} difference(s) across ${compared} files)`,
    problems.join('\n') +
      '\n\nUsual causes, in order of frequency (v3 §2.3):\n' +
      '  - a wall-clock timestamp on a node or edge body (time belongs to the Run)\n' +
      '  - an absolute path where a repo-relative POSIX path is required\n' +
      '  - unsorted object keys, or an array not sorted by stable id\n' +
      '  - iteration over a Set/Map whose order follows filesystem traversal order\n' +
      '  - Math.random(), or an unseeded algorithm',
  );
}

// Computed before cleanup(): it deletes `workdir`, which is where `snapshots[0]`
// lives, and a stat after that point fails every single time the gate actually
// reaches this line (ENOENT) rather than only when `--keep` is not passed.
const totalBytes = filesA.reduce((n, f) => n + statSync(join(snapshots[0], f)).size, 0);
cleanup();
process.stdout.write(
  `determinism-gate PASSED: ${compared} output file(s) byte-identical across two runs\n` +
    `  target: ${relative(REPO_ROOT, TARGET) || '.'}${sep === '\\' ? '' : ''}\n` +
    `  total:  ${totalBytes} bytes\n`,
);
