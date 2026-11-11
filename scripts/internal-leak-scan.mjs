#!/usr/bin/env node
/**
 * Pre-publication leak scan.
 *
 * This is the first public repository this organization has released, so
 * there was no in-house precedent for what "internal material" looks like once
 * it is on the open internet. This script makes the answer mechanical instead
 * of a judgment call made by a tired person at 6pm.
 *
 * It scans the files git would actually publish (`git ls-files`, not the
 * working tree) for two classes of problem:
 *
 *   1. Whole files and directories that must not ship at all.
 *   2. Internal identifiers embedded inside files that otherwise should ship.
 *
 * Class 2 is the one that bites. The adversarial review of the previous design
 * found a real production environment name, a real database/schema/table/column,
 * and a real source path plus class name sitting in a document that was about
 * to be published. Those exact strings are pinned below.
 *
 * Exit 0 means nothing BLOCKING was found. Anything else means do not publish yet.
 *
 * Findings carry one of two severities, because two different questions are
 * being asked here and they do not deserve the same answer:
 *
 *   block  Internal material that must never reach the open internet, plus any
 *          unresolved placeholder nobody has accounted for. Fails every run.
 *   warn   A release-readiness item that is already tracked on the checklist and
 *          deliberately marked as open. Reported on every run, but does not fail
 *          one.
 *
 * The `warn` severity exists because of where this gate runs. It is a step
 * inside `verify` on every pull request, over the whole tree rather than the
 * diff, so a blocking finding here is inherited by every later pull request --
 * dependabot's included -- until someone closes the underlying item. That is
 * how an honest gate becomes a gate people switch off, and it had already
 * blocked an unrelated dependency PR once. A tracked, marked, deliberately-open
 * item should be visible on every run without holding unrelated work hostage.
 *
 * `--publish` escalates warnings back to blocking. That is the run which
 * actually answers "can this repository be published", and it is the run where
 * an unconfirmed security contact must still be fatal.
 *
 * Usage:
 *   node scripts/internal-leak-scan.mjs            report; exit non-zero on a BLOCKING finding
 *   node scripts/internal-leak-scan.mjs --publish  publication gate: warnings block too
 *   node scripts/internal-leak-scan.mjs --json     machine-readable
 *   node scripts/internal-leak-scan.mjs --all      scan the working tree, not just tracked files
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const scanAll = args.has('--all');
/** The publication gate. PUBLISH=1 is the same switch for callers that cannot pass a flag. */
const publishMode = args.has('--publish') || process.env['PUBLISH'] === '1';

/**
 * Files allowed to mention the patterns below, because describing the problem
 * requires naming it. Each entry needs the same justification the original
 * two had: this script itself, and the checklist that records what leaked
 * and how it was fixed. Two more earned the same exemption on 2026-09-08:
 * this script's own test file needs literal positive-match fixtures to prove
 * a pattern actually fires (the gap that let L10 miss "@zylver/atlas" for
 * weeks was exactly the absence of such a test), and the design doc that
 * tracks confirmed leak instances by name for the same reason the checklist
 * does. Not a rubber stamp: a new entry here is a new place a real leak can
 * hide undetected, so justify it in the commit that adds it, the way this
 * comment does.
 */
const SELF_REFERENTIAL = new Set([
  'scripts/internal-leak-scan.mjs',
  'scripts/internal-leak-scan.test.mjs',
  'docs/PUBLIC-RELEASE-CHECKLIST.md',
  'docs/design/aspirational-state.md',
]);

/** Paths that must not exist in a published tree at all. */
const FORBIDDEN_PATHS = [
  { prefix: 'docs/internal/', why: 'in-house ecosystem recon and prior-art analysis' },
  { prefix: 'docs/handoff/', why: 'internal session handoff notes' },
  { prefix: 'docs/audit/council/', why: 'raw per-lens council transcripts; they cite internal repo paths' },
  { prefix: '.beads/', why: 'in-house issue tracker configuration and git hooks' },
  { prefix: '.dolt/', why: 'in-house issue tracker database' },
  { prefix: '.sops.yaml', why: 'internal secret-management configuration' },
  { prefix: '.env', why: 'environment file' },
  { prefix: 'seamline-out/', why: 'a graph snapshot must never be committed' },
];

/**
 * Internal identifiers. Each entry names what it is and why it must not ship,
 * because a bare regex list rots into "someone will know what this was for".
 */
const PATTERNS = [
  {
    id: 'L1',
    // Any `zylver-<name>` other than the public organization name is an internal
    // repository or service name. Matching the shape, not a list of names, keeps
    // this public file from naming them.
    re: /\bzylver-(?!solutions\b)[a-z][a-z0-9-]*|cf-pages-argo/g,
    what: 'internal repository name',
  },
  {
    id: 'L2',
    re: /(\/mnt\/[a-z]\/zylver-solutions|\/home\/(?!example\/)[a-z][a-z0-9_-]*\/|[A-Z]:\\Users\\(?!dev\b)[A-Za-z0-9_.-]+)/g,
    what: 'absolute path from a maintainer machine',
  },
  {
    id: 'L3',
    // This repository owns ADR-0001 through ADR-0018. Anything above that
    // belongs to another repository's decision record and is not public.
    // Bump this ceiling deliberately, in the same commit that adds the new
    // ADR, when this repo's own count grows -- do not widen it speculatively.
    re: /ADR-00(?:19|[2-9][0-9])/g,
    what: 'ADR identifier from another (internal) repository',
  },
  { id: 'L4', re: /\bzylver_[a-z][a-z0-9_]*|public\.posts\.scheduled_at/g, what: 'real internal database, schema, table, or column' },
  { id: 'L5', re: /prod-us-east/g, what: 'real production environment name' },
  { id: 'L6', re: /PublishingEngine|src\/publish\/engine\.ts/g, what: 'real internal source path or class name' },
  // Any subdomain of the company domain; the bare domain is the public site.
  { id: 'L7', re: /\b(?:[a-z0-9-]+\.)+zylver\.com\b/g, what: 'internal hostname' },
  { id: 'L8', re: /\bcompany_id\b|app\.current_(?:company|org)_id/g, what: 'internal tenancy column or session variable' },
  { id: 'L9', re: /concept-graph|concept_graph/g, what: 'in-house prior-art package that is not public' },
  { id: 'L10', re: /atlas-out\/|zylver[\/-]atlas/gi, what: 'leftover from the rejected working name' },
  {
    id: 'L13',
    // Shapes, not names: a lowercase `r` plus three digits (a rack-server host name), a `.zylver/`
    // configuration directory, and the in-house planning documents named `seamline-internal*` or
    // `seamline-release-*`. Case-sensitive on purpose, so git status codes such as `R100` do not match.
    re: /\br[0-9]{3}\b|\.zylver\/|\bseamline-(?:internal|release-[a-z]+)/g,
    what: 'internal host name, home-directory configuration path or internal planning document',
  },
  {
    id: 'L11',
    re: /\bTODO\b/g,
    what: 'unresolved placeholder',
    onlyIn: /^(CODE_OF_CONDUCT\.md|SECURITY\.md|README\.md|\.github\/CODEOWNERS)$/,
  },
  // A contact that is filled in but not yet confirmed to reach anyone. Distinct
  // from L11 on purpose: a bare TODO is a placeholder nobody has accounted for
  // and keeps failing the build, whereas this marker means "accounted for, open,
  // and tracked as C1/C2 on the checklist". Only the second is downgraded, and
  // only until those items close -- `--publish` still treats it as fatal, because
  // shipping a security contact that may reach nobody is the exact outcome
  // SECURITY.md exists to prevent.
  {
    id: 'L12',
    re: /\bUNCONFIRMED-CONTACT\b/g,
    what: 'contact filled in but not confirmed to reach anyone (checklist C1/C2)',
    onlyIn: /^(CODE_OF_CONDUCT\.md|SECURITY\.md)$/,
    severity: 'warn',
  },
];

const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|db|lock)$/i;

function listTrackedFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);
}

function walkAll(dir = REPO_ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walkAll(full, out);
    else if (e.isFile()) out.push(relative(REPO_ROOT, full).split('\\').join('/'));
  }
  return out;
}

const tracked = scanAll ? walkAll() : listTrackedFiles();
if (tracked === null) {
  process.stderr.write(
    'internal-leak-scan: `git ls-files` failed, so the published file set is unknown.\n' +
      'Re-run inside the repository, or pass --all to scan the working tree.\n',
  );
  process.exit(1);
}

const findings = [];

for (const f of FORBIDDEN_PATHS) {
  const hits = tracked.filter((p) => p === f.prefix || p.startsWith(f.prefix));
  for (const p of hits)
    findings.push({ kind: 'forbidden-path', file: p, id: 'P0', what: f.why, line: 0, text: '', severity: 'block' });
}

for (const rel of tracked) {
  if (SELF_REFERENTIAL.has(rel) || SKIP_EXT.test(rel)) continue;
  let size;
  try {
    size = statSync(join(REPO_ROOT, rel)).size;
  } catch {
    continue;
  }
  if (size > 2_000_000) continue;
  let text;
  try {
    text = readFileSync(join(REPO_ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;

  const lines = text.split('\n');
  for (const pat of PATTERNS) {
    if (pat.onlyIn && !pat.onlyIn.test(rel)) continue;
    for (let i = 0; i < lines.length; i++) {
      pat.re.lastIndex = 0;
      const m = pat.re.exec(lines[i]);
      if (!m) continue;
      findings.push({
        kind: 'identifier',
        file: rel,
        id: pat.id,
        what: pat.what,
        line: i + 1,
        text: lines[i].trim().slice(0, 140),
        match: m[0],
        severity: pat.severity ?? 'block',
      });
    }
  }
}

// In publish mode every finding blocks; otherwise `warn` findings are reported
// without failing the run. Split once, here, so the report and the exit code can
// never disagree about which findings counted.
const warnings = findings.filter((f) => f.severity === 'warn');
const blocking = publishMode ? findings : findings.filter((f) => f.severity !== 'warn');

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        scanned: tracked.length,
        publishMode,
        findings,
        blocking: blocking.length,
        warnings: warnings.length,
        pass: blocking.length === 0,
      },
      null,
      2,
    ) + '\n',
  );
} else {
  process.stdout.write(
    `internal-leak-scan: ${tracked.length} ${scanAll ? 'working-tree' : 'tracked'} files` +
      `${publishMode ? ' (publish mode: warnings block)' : ''}\n\n`,
  );
  const paths = blocking.filter((f) => f.kind === 'forbidden-path');
  if (paths.length > 0) {
    process.stdout.write(`Files that must not ship (${paths.length}):\n`);
    const byWhy = new Map();
    for (const f of paths) byWhy.set(f.what, [...(byWhy.get(f.what) ?? []), f.file]);
    for (const [why, files] of byWhy) {
      process.stdout.write(`  ${why}\n`);
      for (const p of files.slice(0, 8)) process.stdout.write(`    ${p}\n`);
      if (files.length > 8) process.stdout.write(`    ... and ${files.length - 8} more\n`);
    }
    process.stdout.write('\n');
  }
  const ids = blocking.filter((f) => f.kind === 'identifier');
  if (ids.length > 0) {
    process.stdout.write(`Internal identifiers inside shipping files (${ids.length}):\n`);
    const byFile = new Map();
    for (const f of ids) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
    for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
      process.stdout.write(`  ${file}  (${list.length})\n`);
      for (const f of list.slice(0, 4)) {
        process.stdout.write(`    ${String(f.line).padStart(5)}  ${f.id} ${f.what}: ${JSON.stringify(f.match)}\n`);
      }
      if (list.length > 4) process.stdout.write(`          ... and ${list.length - 4} more in this file\n`);
    }
  }
}

// Warnings are printed even on a passing run: the whole point of downgrading
// them is that they stay VISIBLE without being fatal. A silent warning is just
// a removed check.
if (!asJson && !publishMode && warnings.length > 0) {
  process.stdout.write(`\nOpen release-readiness items (${warnings.length}, not blocking this run):\n`);
  for (const f of warnings) {
    process.stdout.write(`  ${f.file}:${f.line}  ${f.id} ${f.what}\n`);
  }
  process.stdout.write(
    '\nThese do not fail `verify`, so unrelated pull requests are not held up by them.\n' +
      'They DO fail `node scripts/internal-leak-scan.mjs --publish`, which is the run\n' +
      'that decides whether this repository can be made public. Close them via\n' +
      'docs/PUBLIC-RELEASE-CHECKLIST.md (C1/C2) and delete the marker; do not delete\n' +
      'the marker on its own.\n',
  );
}

if (blocking.length > 0) {
  process.stderr.write(
    `\ninternal-leak-scan FAILED: ${blocking.length} finding(s). This repository is not ready to be public.\n` +
      'Work through docs/PUBLIC-RELEASE-CHECKLIST.md. Do not narrow the patterns to get a green run.\n',
  );
  process.exit(1);
}

if (!asJson) {
  process.stdout.write(
    warnings.length > 0
      ? `\ninternal-leak-scan PASSED: no blocking findings (${warnings.length} open item(s) above).\n`
      : 'internal-leak-scan PASSED: no internal material found.\n',
  );
}
