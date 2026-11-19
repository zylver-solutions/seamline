#!/usr/bin/env node
/**
 * Tests for the THIRD-PARTY-NOTICES.txt comparison in `license-gate.mjs`.
 *
 * The gate derives its root from its own location, so each case builds a
 * throwaway repository (a `scripts/` copy of the real script, a `node_modules`
 * of fixture packages, and optionally a notices file and a lockfile) and runs
 * the shipped CLI in it as a caller would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'license-gate.mjs');
const NOTICES = 'THIRD-PARTY-NOTICES.txt';
const REGENERATE = 'node scripts/license-gate.mjs --write-third-party-notices';

const TREE = [
  { name: 'alpha', version: '1.0.0', license: 'MIT' },
  { name: '@scope/beta', version: '2.3.4', license: 'Apache-2.0' },
  { name: 'Zeta', version: '0.1.0', license: 'ISC' },
];

function install(root, { name, version, license }) {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, license }));
}

/** Runs `body(root, gate)` in a fixture repository holding `packages`. */
function withRepo(packages, body) {
  const root = mkdtempSync(join(tmpdir(), 'license-gate-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(SCRIPT, join(root, 'scripts', 'license-gate.mjs'));
    for (const pkg of packages) install(root, pkg);
    const gate = (...args) =>
      spawnSync(process.execPath, [join(root, 'scripts', 'license-gate.mjs'), ...args], {
        encoding: 'utf8',
      });
    return body(root, gate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A repository whose notices file was just generated from `packages`. */
function withCurrentRepo(packages, body) {
  return withRepo(packages, (root, gate) => {
    const written = gate('--write-third-party-notices');
    assert.equal(written.status, 0, written.stderr);
    return body(root, gate, join(root, NOTICES));
  });
}

test('a notices file generated from the installed tree passes', () => {
  withCurrentRepo(TREE, (_root, gate) => {
    const run = gate();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /THIRD-PARTY-NOTICES\.txt matches the installed tree \(3 packages\)/);
  });
});

test('the generated file is sorted by code unit and carries no run-specific content', () => {
  withCurrentRepo(TREE, (_root, gate, file) => {
    const first = readFileSync(file, 'utf8');
    const names = first.split('\n').filter((line) => /^\S+@\d/.test(line));
    assert.deepEqual(names, ['@scope/beta@2.3.4', 'Zeta@0.1.0', 'alpha@1.0.0']);
    assert.equal(gate('--write-third-party-notices').status, 0);
    assert.equal(readFileSync(file, 'utf8'), first);
  });
});

test('a package installed after the file was generated fails and names the regeneration command', () => {
  withCurrentRepo(TREE, (root, gate) => {
    install(root, { name: 'gamma', version: '4.0.0', license: 'BSD-3-Clause' });
    const run = gate();
    assert.equal(run.status, 1);
    assert.match(
      run.stderr,
      /THIRD-PARTY-NOTICES\.txt does not match the installed dependency tree/,
    );
    assert.match(run.stderr, /installed, not listed: gamma@4\.0\.0 \(BSD-3-Clause\)/);
    assert.ok(run.stderr.includes(REGENERATE), run.stderr);
    assert.doesNotMatch(run.stdout, /license-gate PASSED/);
  });
});

test('a package removed after the file was generated fails', () => {
  withCurrentRepo(TREE, (root, gate) => {
    rmSync(join(root, 'node_modules', 'alpha'), { recursive: true });
    const run = gate();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /listed, not installed: alpha@1\.0\.0/);
  });
});

test('an upgraded package fails as one stale and one missing entry', () => {
  withCurrentRepo(TREE, (root, gate) => {
    install(root, { name: 'alpha', version: '1.0.1', license: 'MIT' });
    const run = gate();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /installed, not listed: alpha@1\.0\.1/);
    assert.match(run.stderr, /listed, not installed: alpha@1\.0\.0/);
  });
});

test('a changed licence fails', () => {
  withCurrentRepo(TREE, (root, gate) => {
    install(root, { name: 'alpha', version: '1.0.0', license: 'ISC' });
    const run = gate();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /licence differs: alpha@1\.0\.0 is listed as MIT, installed as ISC/);
  });
});

test('a missing notices file fails', () => {
  withRepo(TREE, (_root, gate) => {
    const run = gate();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /THIRD-PARTY-NOTICES\.txt does not exist/);
    assert.ok(run.stderr.includes(REGENERATE), run.stderr);
  });
});

test('a count line that disagrees with the listed entries fails', () => {
  withCurrentRepo(TREE, (_root, gate, file) => {
    writeFileSync(file, readFileSync(file, 'utf8').replace('3 packages.', '209 packages.'));
    const run = gate();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /the count line says 209 packages, the file lists 3/);
  });
});

test('entry order and line endings do not affect the comparison', () => {
  withCurrentRepo(TREE, (_root, gate, file) => {
    const [head, ...blocks] = readFileSync(file, 'utf8').trimEnd().split('\n\n');
    const entries = blocks.filter((block) => block.includes('  License: '));
    const preamble = [head, ...blocks.filter((block) => !block.includes('  License: '))];
    const reordered = [...preamble, ...entries.reverse()].join('\n\n') + '\n';
    writeFileSync(file, reordered.replaceAll('\n', '\r\n'));
    const run = gate();
    assert.equal(run.status, 0, run.stderr);
  });
});

test('--json reports the comparison and fails with it', () => {
  withCurrentRepo(TREE, (root, gate) => {
    const current = gate('--json');
    assert.equal(current.status, 0, current.stderr);
    assert.deepEqual(JSON.parse(current.stdout).thirdPartyNotices, {
      current: true,
      problems: [],
      compared: 3,
      ignored: [],
      lockfile: null,
    });

    install(root, { name: 'gamma', version: '4.0.0', license: 'MIT' });
    const stale = gate('--json');
    assert.equal(stale.status, 1);
    const report = JSON.parse(stale.stdout);
    assert.equal(report.pass, false);
    assert.deepEqual(report.thirdPartyNotices.problems, [
      'installed, not listed: gamma@4.0.0 (MIT)',
    ]);
  });
});

test('a package whose manifest has no version is written and read back as one entry', () => {
  withRepo(TREE, (root, gate) => {
    const dir = join(root, 'node_modules', 'unversioned');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'unversioned', license: 'MIT' }),
    );
    assert.equal(gate('--write-third-party-notices').status, 0);
    assert.match(readFileSync(join(root, NOTICES), 'utf8'), /^unversioned@$/m);
    const run = gate();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /matches the installed tree \(4 packages\)/);
  });
});

// The installed tree legitimately differs between machines for two kinds of
// package: one the lockfile restricts by os, cpu or libc, and one it marks
// optional that failed to install. The file is generated on one machine and
// checked on all of them.
const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      alpha:
        specifier: ^1.0.0
        version: 1.0.0

packages:

  '@scope/beta@2.3.4':
    resolution: {integrity: sha512-x}

  Zeta@0.1.0:
    resolution: {integrity: sha512-x}

  alpha@1.0.0:
    resolution: {integrity: sha512-x}
    peerDependenciesMeta:
      zeta:
        optional: true

  darwin-only@1.0.0:
    resolution: {integrity: sha512-x}
    os: [darwin]

  maybe@2.0.0:
    resolution: {integrity: sha512-x}

snapshots:

  '@scope/beta@2.3.4': {}

  Zeta@0.1.0: {}

  alpha@1.0.0(zeta@0.1.0):
    optionalDependencies:
      maybe: 2.0.0

  darwin-only@1.0.0: {}

  maybe@2.0.0:
    optional: true
`;

const DARWIN_ONLY = { name: 'darwin-only', version: '1.0.0', license: 'MIT' };
const MAYBE = { name: 'maybe', version: '2.0.0', license: 'MIT' };
const lock = (root) => writeFileSync(join(root, 'pnpm-lock.yaml'), LOCKFILE);

test('a platform-restricted package listed in the file but not installed here passes', () => {
  withCurrentRepo([...TREE, DARWIN_ONLY], (root, gate) => {
    lock(root);
    rmSync(join(root, 'node_modules', 'darwin-only'), { recursive: true });
    const run = gate();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\(3 packages, 1 machine-dependent package\(s\) not compared\)/);
  });
});

test('a platform-restricted package installed here but not listed in the file passes', () => {
  withCurrentRepo(TREE, (root, gate) => {
    lock(root);
    install(root, DARWIN_ONLY);
    const run = gate();
    assert.equal(run.status, 0, run.stderr);
  });
});

test('an optional package that is listed and not installed here passes', () => {
  withCurrentRepo([...TREE, MAYBE], (root, gate) => {
    lock(root);
    rmSync(join(root, 'node_modules', 'maybe'), { recursive: true });
    const run = gate('--json');
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).thirdPartyNotices, {
      current: true,
      problems: [],
      compared: 3,
      ignored: ['maybe@2.0.0'],
      lockfile: { packages: 5, snapshots: 5 },
    });
  });
});

test('an optional package that is installed and listed with a stale licence fails', () => {
  withCurrentRepo([...TREE, MAYBE], (root, gate) => {
    lock(root);
    install(root, { ...MAYBE, license: 'ISC' });
    const run = gate();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /licence differs: maybe@2\.0\.0 is listed as MIT, installed as ISC/);
  });
});

test('an optional package that is installed and not listed fails', () => {
  withCurrentRepo(TREE, (root, gate) => {
    lock(root);
    install(root, MAYBE);
    const run = gate();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /installed, not listed: maybe@2\.0\.0/);
  });
});

test('without the lockfile entry a platform difference fails', () => {
  withCurrentRepo(TREE, (root, gate) => {
    install(root, DARWIN_ONLY);
    const run = gate();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /installed, not listed: darwin-only@1\.0\.0/);
  });
});

test('an optional peer marker does not exclude a package', () => {
  withCurrentRepo(TREE, (root, gate) => {
    lock(root);
    rmSync(join(root, 'node_modules', 'alpha'), { recursive: true });
    const run = gate();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /listed, not installed: alpha@1\.0\.0/);
  });
});

// The lockfile reader is a line parser, so it is run on the real file: with
// nothing excluded, the entries it finds in `packages:` and in `snapshots:`
// are the packages the gate compares. Needs `pnpm install`, as the gate does.
test("the repository's pnpm-lock.yaml is read entry for entry", () => {
  const run = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(run.stdout).thirdPartyNotices;
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.ignored, []);
  assert.ok(report.compared > 0);
  assert.deepEqual(report.lockfile, { packages: report.compared, snapshots: report.compared });
});
