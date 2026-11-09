#!/usr/bin/env node
/**
 * Seamline license allow-list gate.
 *
 * Walks the *installed* dependency tree (not the lockfile, not the manifests:
 * what is actually on disk), resolves each package's SPDX expression, and fails
 * on anything outside the allow-list in design v3 §10.
 *
 * A missing, empty, `UNLICENSED`, or `SEE LICENSE IN ...` license field is a
 * FAILURE, not a pass. Absent an explicit grant, the default under copyright is
 * "all rights reserved", which is the opposite of permissive. This is the whole
 * reason the gate exists: v2's licence diligence was real but its transitive
 * check was not done (council review §6, L4).
 *
 * Plain Node, zero dependencies, by design: a supply-chain gate that itself
 * pulls in supply chain is not a gate (v3 §2.7, §10).
 *
 * Usage:
 *   node scripts/license-gate.mjs                          human-readable report; exit 1 on violation
 *   node scripts/license-gate.mjs --json                   machine-readable report
 *   node scripts/license-gate.mjs --notices                also list NOTICE-propagation obligations
 *   node scripts/license-gate.mjs --write-third-party-notices
 *       regenerate THIRD-PARTY-NOTICES.txt (design v3 §10.2) from the installed
 *       tree. Refuses to write if the gate itself fails: an unresolved licence
 *       is not something to notice-and-move-on from.
 */

import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The allow-list. Canonical SPDX identifiers only.
 * Source of truth: docs/design/v3.md §10, docs/toolchain.md.
 * Adding an entry here is a licensing decision, not a build fix.
 */
const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC0-1.0',
  'Unlicense',
  '0BSD',
  'Zlib',
  'PostgreSQL',
  'MPL-2.0', // unmodified dependency only, with notice, see NOTICE_REQUIRED

  // Added 2026-08-29 after verification against primary sources, not assumption.
  //
  // BlueOak-1.0.0: OSI-approved 2024-01-19, published by the Blue Oak Council.
  // Permissive and non-copyleft -- no source-disclosure, reciprocal, or
  // network-use clause, no commercial or redistribution restriction. Express
  // patent grant with NO patent-termination clause, so no Apache-2.0 conflict.
  // The Council's own list rates it "Model" tier, above the Silver tier holding
  // Apache-2.0/MIT/ISC/BSD-2/PostgreSQL. Reaches us through minimatch, which is
  // on the RUNTIME path via @ts-morph/common -- so the notice obligation is live
  // for any bundled artifact, not merely a dev-tree concern.
  // Obligation: pass along the licence text or the URL
  // https://blueoakcouncil.org/license/1.0.0. Note the scope is "any part",
  // broader than MIT's "substantial portions": no de-minimis snippet exemption.
  'BlueOak-1.0.0',

  // Python-2.0: OSI-approved, permissive, GPL-compatible, no copyleft. Reaches
  // us dev-only through argparse <- js-yaml <- @eslint/eslintrc.
  'Python-2.0',
]);

/** Licenses whose terms impose a downstream notice obligation we discharge in NOTICE. */
const NOTICE_REQUIRED = new Set(['Apache-2.0', 'MPL-2.0', 'BlueOak-1.0.0']);

/** Canonical licence text URL, where the SPDX id alone is not the obvious link. */
const LICENSE_URLS = new Map([['BlueOak-1.0.0', 'https://blueoakcouncil.org/license/1.0.0']]);
function licenseUrl(id) {
  return LICENSE_URLS.get(id) ?? `https://spdx.org/licenses/${id}.html`;
}

/**
 * Legacy spellings that map unambiguously onto a canonical identifier.
 * Deliberately short. Anything neither canonical nor listed here FAILS: a bare
 * "BSD" does not resolve to a specific licence and must be reviewed by a human,
 * not guessed at by this script.
 */
const ALIASES = new Map(
  Object.entries({
    'apache 2.0': 'Apache-2.0',
    'apache-2': 'Apache-2.0',
    apache2: 'Apache-2.0',
    'apache license 2.0': 'Apache-2.0',
    cc0: 'CC0-1.0',
    'the mit license': 'MIT',
    'mit license': 'MIT',
    'zlib license': 'Zlib',
  }),
);

/** Directories that never contain an installed dependency. */
const SKIP_DIRS = new Set(['.git', '.bin', '.vite', '.cache', '.store', 'dist', 'coverage', '.github', 'docs']);

/** drvfs and other network-ish mounts make each syscall expensive; overlap them. */
const CONCURRENCY = 48;

// ---------------------------------------------------------------------------
// SPDX expression evaluation
// ---------------------------------------------------------------------------

/** Tokenise an SPDX expression into identifiers and the operators `(`, `)`, AND, OR, WITH. */
function tokenize(expr) {
  const out = [];
  const re = /\(|\)|[A-Za-z0-9.+-]+/g;
  let m;
  while ((m = re.exec(expr)) !== null) out.push(m[0]);
  return out;
}

function canonicalise(id) {
  const trimmed = id.trim().replace(/\+$/, '');
  for (const allowed of ALLOWED) {
    if (allowed.toLowerCase() === trimmed.toLowerCase()) return allowed;
  }
  return ALIASES.get(trimmed.toLowerCase()) ?? trimmed;
}

/**
 * Evaluate an SPDX expression against the allow-list.
 *
 * OR is satisfied by any allowed disjunct; AND requires every conjunct.
 * `WITH <exception>` is never auto-allowed: an exception changes the terms and
 * needs a recorded human decision.
 *
 * @returns {{allowed: boolean, ids: string[], reason?: string}}
 */
function evaluate(expr) {
  // A multi-word legacy spelling ("Apache 2.0") is not a valid SPDX expression
  // and would tokenise into two atoms, so resolve the whole string first.
  const whole = ALIASES.get(expr.trim().toLowerCase());
  if (whole !== undefined) {
    return { allowed: ALLOWED.has(whole), ids: [whole], reason: ALLOWED.has(whole) ? undefined : `"${whole}" is not on the allow-list` };
  }
  const tokens = tokenize(expr);
  if (tokens.length === 0) return { allowed: false, ids: [], reason: 'empty expression' };

  let i = 0;
  const ids = [];
  let failure = null;

  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function parseAtom() {
    const t = next();
    if (t === '(') {
      const v = parseOr();
      if (peek() === ')') next();
      else failure ??= 'unbalanced parentheses';
      return v;
    }
    if (t === undefined || t === ')') {
      failure ??= 'malformed expression';
      return false;
    }
    const id = canonicalise(t);
    ids.push(id);
    let ok = ALLOWED.has(id);
    if (!ok && failure === null) failure = `"${id}" is not on the allow-list`;
    if (peek() && peek().toUpperCase() === 'WITH') {
      next();
      const exception = next() ?? '<missing>';
      ids[ids.length - 1] = `${id} WITH ${exception}`;
      failure = `licence exception "${exception}" requires a recorded human decision`;
      ok = false;
    }
    return ok;
  }

  function parseAnd() {
    let v = parseAtom();
    while (peek() && peek().toUpperCase() === 'AND') {
      next();
      const r = parseAtom();
      v = v && r;
    }
    return v;
  }

  function parseOr() {
    let v = parseAnd();
    while (peek() && peek().toUpperCase() === 'OR') {
      next();
      const r = parseAnd();
      if (v || r) failure = null; // a satisfiable disjunct clears an earlier note
      v = v || r;
    }
    return v;
  }

  const allowed = parseOr();
  if (i < tokens.length) return { allowed: false, ids, reason: 'trailing tokens in expression' };
  return { allowed, ids, reason: allowed ? undefined : (failure ?? 'not on the allow-list') };
}

/** Extract a licence expression from a manifest, handling npm's legacy shapes. */
function licenseExpression(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim() !== '') return pkg.license.trim();
  if (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string') {
    return pkg.license.type.trim();
  }
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const types = pkg.licenses
      .map((l) => (typeof l === 'string' ? l : l && l.type))
      .filter((t) => typeof t === 'string' && t.trim() !== '');
    if (types.length > 0) return `(${types.join(' OR ')})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Installed-tree discovery
// ---------------------------------------------------------------------------

/** Bounded-concurrency map. Preserves input order; never rejects on a single failure. */
async function mapPool(items, fn, concurrency = CONCURRENCY) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

async function safeReaddir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * List the package directories directly inside one `node_modules`, expanding
 * `@scope/` a level and reporting any pnpm virtual store found alongside them.
 * @returns {Promise<{packages: string[], stores: string[]}>}
 */
async function listNodeModules(nmPath) {
  const entries = await safeReaddir(nmPath);
  const packages = [];
  const stores = [];
  const scopes = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const full = join(nmPath, e.name);
    if (e.name === '.pnpm') {
      for (const s of await safeReaddir(full)) {
        if (s.isDirectory()) stores.push(join(full, s.name, 'node_modules'));
      }
      continue;
    }
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    if (e.name.startsWith('@')) scopes.push(full);
    else packages.push(full);
  }
  const scoped = await mapPool(scopes, async (scopeDir) =>
    (await safeReaddir(scopeDir))
      .filter((s) => s.isDirectory() || s.isSymbolicLink())
      .map((s) => join(scopeDir, s.name)),
  );
  for (const list of scoped) if (list) packages.push(...list);
  return { packages, stores };
}

/** Breadth-first sweep of every `node_modules` reachable from the repo root. */
async function discoverPackageDirs() {
  const workspacePrefix = join(REPO_ROOT, 'packages') + sep;
  const rootEntries = await safeReaddir(REPO_ROOT);
  const frontier = [join(REPO_ROOT, 'node_modules')];
  for (const e of rootEntries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name) || e.name === 'node_modules') continue;
    for (const sub of await safeReaddir(join(REPO_ROOT, e.name))) {
      if (sub.isDirectory()) frontier.push(join(REPO_ROOT, e.name, sub.name, 'node_modules'));
    }
  }

  const scannedNodeModules = new Set();
  const byRealPath = new Map();

  let level = frontier;
  while (level.length > 0) {
    const todo = level.filter((p) => !scannedNodeModules.has(p));
    for (const p of todo) scannedNodeModules.add(p);
    if (todo.length === 0) break;

    const listings = await mapPool(todo, listNodeModules);
    const candidates = [];
    const nextStores = [];
    for (const l of listings) {
      if (!l) continue;
      candidates.push(...l.packages);
      nextStores.push(...l.stores);
    }

    const reals = await mapPool(candidates, (p) => realpath(p));
    const fresh = [];
    for (let i = 0; i < candidates.length; i++) {
      const real = reals[i];
      if (real === undefined || byRealPath.has(real)) continue;
      // First-party workspace packages are ours (Apache-2.0); not audited here.
      if (real === REPO_ROOT || real.startsWith(workspacePrefix)) continue;
      byRealPath.set(real, real);
      fresh.push(real);
    }

    level = [...nextStores, ...fresh.map((d) => join(d, 'node_modules'))];
  }

  return [...byRealPath.keys()];
}

async function readManifest(dir) {
  const raw = await readFile(join(dir, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw);
  if (!pkg || typeof pkg.name !== 'string') return null;
  return {
    name: pkg.name,
    version: typeof pkg.version === 'string' ? pkg.version : '',
    dir,
    expression: licenseExpression(pkg),
  };
}

async function shipsNoticeFile(dir) {
  return (await safeReaddir(dir)).some((f) => /^NOTICE(\.|$)/i.test(f.name));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const withNotices = args.has('--notices');
const writeThirdPartyNotices = args.has('--write-third-party-notices');

const dirs = await discoverPackageDirs();
const manifests = (await mapPool(dirs, readManifest)).filter((m) => m != null);

if (manifests.length === 0) {
  process.stderr.write(
    'license-gate: no installed packages found. Run `pnpm install` first.\n' +
      'A gate that inspected nothing does not pass, it fails.\n',
  );
  process.exit(1);
}

const violations = [];
const byLicense = new Map();
const noticeCandidates = [];
const resolved = [];

for (const p of manifests) {
  if (p.expression === null) {
    violations.push({ ...p, license: null, reason: 'no license field (not permissive by default)' });
    continue;
  }
  const raw = p.expression;
  if (/^UNLICENSED$/i.test(raw)) {
    violations.push({ ...p, license: raw, reason: 'declared UNLICENSED' });
    continue;
  }
  if (/^SEE LICEN[CS]E IN /i.test(raw)) {
    violations.push({ ...p, license: raw, reason: 'custom licence file, requires human review' });
    continue;
  }
  const verdict = evaluate(raw);
  const key = verdict.ids.length === 1 ? verdict.ids[0] : raw;
  byLicense.set(key, (byLicense.get(key) ?? 0) + 1);
  if (!verdict.allowed) {
    violations.push({ ...p, license: raw, reason: verdict.reason });
    continue;
  }
  resolved.push({ name: p.name, version: p.version, license: key });
  const noticeId = verdict.ids.find((id) => NOTICE_REQUIRED.has(id));
  if (noticeId) noticeCandidates.push({ name: p.name, version: p.version, license: noticeId, dir: p.dir });
}

const noticeObligations = withNotices
  ? (await mapPool(noticeCandidates, async (c) => ({ ...c, hasNoticeFile: await shipsNoticeFile(c.dir) }))).filter(Boolean)
  : noticeCandidates;

if (writeThirdPartyNotices) {
  if (violations.length > 0) {
    process.stderr.write(
      `license-gate: refusing to write THIRD-PARTY-NOTICES.txt: ${violations.length} unresolved licence violation(s).\n` +
        'Fix the violations first; do not notice past a failure.\n',
    );
    process.exit(1);
  }
  const rows = [...resolved].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  const lines = [
    'Seamline — Third-Party Notices',
    '',
    "Every dependency installed in this project's tree at the time this file was",
    'generated, with its version and SPDX licence identifier. Regenerate with:',
    '',
    '    node scripts/license-gate.mjs --write-third-party-notices',
    '',
    `${rows.length} packages.`,
    '',
    '-'.repeat(80),
    '',
  ];
  for (const r of rows) {
    lines.push(`${r.name}@${r.version}`);
    lines.push(`  License: ${r.license}`);
    lines.push(`  ${licenseUrl(r.license)}`);
    lines.push('');
  }
  const outPath = join(REPO_ROOT, 'THIRD-PARTY-NOTICES.txt');
  await writeFile(outPath, lines.join('\n').trimEnd() + '\n', 'utf8');
  process.stdout.write(`license-gate: wrote ${outPath} (${rows.length} packages)\n`);
  process.exit(0);
}

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        scanned: manifests.length,
        allowList: [...ALLOWED].sort(),
        byLicense: Object.fromEntries([...byLicense].sort((a, b) => b[1] - a[1])),
        noticeObligations: noticeObligations.map(({ dir: _dir, ...rest }) => rest),
        violations: violations.map((v) => ({ name: v.name, version: v.version, license: v.license, reason: v.reason })),
        pass: violations.length === 0,
      },
      null,
      2,
    ) + '\n',
  );
} else {
  process.stdout.write(`license-gate: scanned ${manifests.length} installed packages\n\n`);
  const rows = [...byLicense].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const width = Math.max(...rows.map(([l]) => l.length), 8);
  for (const [lic, n] of rows) process.stdout.write(`  ${lic.padEnd(width)}  ${String(n).padStart(4)}\n`);

  if (withNotices) {
    process.stdout.write(`\nNOTICE-propagation obligations (${noticeObligations.length}):\n`);
    for (const o of [...noticeObligations].sort((a, b) => a.name.localeCompare(b.name))) {
      const flag = o.hasNoticeFile ? '  [ships a NOTICE file, propagate it verbatim]' : '';
      process.stdout.write(`  ${o.name}@${o.version}  ${o.license}${flag}\n`);
    }
  }

  if (violations.length > 0) {
    process.stdout.write(`\n${violations.length} violation(s):\n`);
    for (const v of [...violations].sort((a, b) => a.name.localeCompare(b.name))) {
      process.stdout.write(`  FAIL  ${v.name}@${v.version}  license=${v.license ?? '<none>'}\n`);
      process.stdout.write(`        reason: ${v.reason}\n`);
      process.stdout.write(`        ${v.dir}\n`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `\nlicense-gate FAILED: ${violations.length} package(s) outside the allow-list.\n` +
      'Drop the dependency, or record a licence decision and amend both the allow-list in\n' +
      'this file and docs/design/v3.md §10. Do not silence the gate.\n',
  );
  process.exit(1);
}

if (!asJson) process.stdout.write('\nlicense-gate PASSED\n');
