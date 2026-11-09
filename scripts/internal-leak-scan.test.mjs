#!/usr/bin/env node
/**
 * Regression tests for rules `L10` and `L3` in `internal-leak-scan.mjs`.
 *
 * This scanner had zero test coverage before this file. That gap is exactly
 * what let the `L10` false negative ship undetected: the rule was supposed to
 * catch every leftover of the project's old working name ("Atlas") but its
 * regex only matched the hyphenated form (`zylver-atlas`), missing the
 * slash-separated npm-scope form (`@zylver/atlas`) -- a real occurrence in
 * `docs/audit/2026-08-29-license-verification.md` that a "zero L10 findings"
 * checklist claim (`docs/PUBLIC-RELEASE-CHECKLIST.md` item B7) missed.
 *
 * `L3` caps the ADR identifiers this repository may mention. Its ceiling is
 * raised by hand in the commit that adds an ADR, so a test pins where the
 * ceiling sits now: the ids this repository owns pass, the first id above it
 * is flagged.
 *
 * These tests cover `L10` and `L3` only. They do not attempt to cover the other
 * rules in `PATTERNS`; that is a larger effort tracked separately.
 *
 * Approach: run the real script as a subprocess against small fixture files
 * in a temp directory, using `--all` (working-tree scan, not `git ls-files`)
 * so the fixtures do not need to be committed to be scanned. This repo has no
 * existing precedent for testing a standalone `scripts/*.mjs` gate, so this
 * favors the least invasive option: exercising the shipped CLI exactly as a
 * caller would, rather than exporting internals from the production script
 * for testability.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'internal-leak-scan.mjs');

/**
 * Runs the scanner against a single-line fixture file and reports whether
 * the rule named by `ruleId` fired on it.
 *
 * The script derives its scan root from its own file location
 * (`resolve(dirname(fileURLToPath(import.meta.url)), '..')`), not from the
 * process's working directory, so a fixture cannot simply be dropped next to
 * the real script and scanned with `--all` -- that would rescan this actual
 * repository. Instead each case gets its own throwaway "repo": a temp
 * directory with a `scripts/` copy of the real script and a single fixture
 * file at its root, scanned with `--all` (working-tree walk, not
 * `git ls-files`, so the fixture need not be committed or even inside a git
 * repo).
 */
function scanLineForRule(ruleId, line) {
  const repoDir = mkdtempSync(join(tmpdir(), 'leak-scan-'));
  try {
    mkdirSync(join(repoDir, 'scripts'));
    copyFileSync(SCRIPT, join(repoDir, 'scripts', 'internal-leak-scan.mjs'));
    writeFileSync(join(repoDir, 'fixture.md'), line + '\n', 'utf8');
    const result = spawnSync(process.execPath, [join(repoDir, 'scripts', 'internal-leak-scan.mjs'), '--all', '--json'], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, null, `scanner did not exit cleanly: ${result.stderr}`);
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`scanner did not emit valid JSON.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    }
    return parsed.findings.some((f) => f.id === ruleId && f.file === 'fixture.md');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

const scanLineForL10 = (line) => scanLineForRule('L10', line);
const scanLineForL3 = (line) => scanLineForRule('L3', line);

test('L10 matches the npm-scope form @zylver/atlas (the previously missed case)', () => {
  assert.equal(scanLineForL10('See the `@zylver/atlas` package for prior art.'), true);
});

test('L10 still matches the hyphenated form zylver-atlas (the original caught case)', () => {
  assert.equal(scanLineForL10('The old repo was called zylver-atlas.'), true);
});

test('L10 still matches the atlas-out/ directory leftover', () => {
  assert.equal(scanLineForL10('Do not commit the atlas-out/ directory.'), true);
});

test('L10 is case-insensitive on the fixed pattern', () => {
  assert.equal(scanLineForL10('Package: @Zylver/Atlas'), true);
  assert.equal(scanLineForL10('ZYLVER-ATLAS was the old name.'), true);
});

test('L10 does not match unrelated organization or repo references (not over-broad)', () => {
  assert.equal(scanLineForL10('Copyright Zylver Solutions LLC. All rights reserved.'), false);
  assert.equal(scanLineForL10('See https://github.com/zylver-solutions/seamline for source.'), false);
});

/**
 * ADR ids are built from parts so this file does not itself contain an id
 * above the ceiling, which the repository-wide scan would flag.
 */
const adr = (n) => 'ADR-00' + String(n).padStart(2, '0');

test('L3 passes every ADR id this repository owns (ADR-0013 through ADR-0018 included)', () => {
  for (const n of [1, 5, 12, 13, 14, 15, 16, 17, 18]) {
    assert.equal(scanLineForL3(`See ${adr(n)} for the decision.`), false, `${adr(n)} must pass`);
  }
});

test('L3 flags the first id above the ceiling and later ones (another repository records)', () => {
  for (const n of [19, 20, 99]) {
    assert.equal(scanLineForL3(`See ${adr(n)} for the decision.`), true, `${adr(n)} must be flagged`);
  }
});

const scanLineForL1 = (line) => scanLineForRule('L1', line);
const scanLineForL7 = (line) => scanLineForRule('L7', line);

test('L1 flags any zylver-<name> repository name, listed or not, and not the public organization', () => {
  assert.equal(scanLineForL1('Cited from zylver-widgetfactory, an internal repository.'), true);
  assert.equal(scanLineForL1('See https://github.com/zylver-solutions/seamline for source.'), false);
});

test('L7 flags any subdomain of the company domain, and not the public site', () => {
  assert.equal(scanLineForL7('Served from tools.zylver.com.'), true);
  assert.equal(scanLineForL7('Served from deep.sub.zylver.com.'), true);
  assert.equal(scanLineForL7('Maintained by Zylver Solutions (https://zylver.com/).'), false);
});

test('L13 flags a rack-server host name by shape, and not a git status code', () => {
  assert.equal(scanLineForRule('L13', 'Runs on the r' + '710 box.'), true);
  assert.equal(scanLineForRule('L13', 'The status is R100 for a pure rename.'), false);
});

test('L13 flags a .zylver/ configuration path and the in-house planning document names', () => {
  assert.equal(scanLineForRule('L13', 'Read ~/.zylver/config for settings.'), true);
  assert.equal(scanLineForRule('L13', 'See seamline-internal notes.'), true);
  assert.equal(scanLineForRule('L13', 'See seamline-release-checklist.'), true);
  assert.equal(scanLineForRule('L13', 'Run seamline extract in your repository.'), false);
});
