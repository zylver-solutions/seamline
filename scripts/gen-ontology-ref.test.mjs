// SPDX-License-Identifier: Apache-2.0
//
// Tests for scripts/gen-ontology-ref.mjs. They run the script as a process,
// because the contract is its exit code and its output file, and assert
// outcomes: a fresh file passes `--check`, a stale or missing one fails it,
// the rendering is deterministic, and it covers every kind the contract names.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCRIPT = join(HERE, 'gen-ontology-ref.mjs');

function run(...args) {
  const flags = ['--disable-warning=ExperimentalWarning', '--experimental-strip-types'];
  const result = spawnSync(process.execPath, [...flags, SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let dir;
let fresh;
let freshPath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'seamline-ontology-ref-'));
  freshPath = join(dir, 'ontology.md');
  const written = run('--out', freshPath);
  assert.equal(written.status, 0, `generation failed: ${written.stderr}`);
  fresh = readFileSync(freshPath, 'utf8');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('gen-ontology-ref --check', () => {
  it('passes on a file it just generated', () => {
    const result = run('--check', '--out', freshPath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /up to date/);
  });

  it('fails on a stale file, names the first differing line, and leaves the file alone', () => {
    const stalePath = join(dir, 'stale.md');
    const stale = fresh.replace('## Edge kinds', '## Edge kinds (edited by hand)');
    assert.notEqual(stale, fresh, 'the edit must change the file for this test to mean anything');
    writeFileSync(stalePath, stale);

    const result = run('--check', '--out', stalePath);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is stale/);
    assert.match(result.stderr, /Edge kinds \(edited by hand\)/);
    assert.equal(readFileSync(stalePath, 'utf8'), stale, '--check must not rewrite the file');
  });

  it('fails when a trailing byte is the only difference', () => {
    const path = join(dir, 'trailing.md');
    writeFileSync(path, `${fresh}\n`);
    assert.equal(run('--check', '--out', path).status, 1);
  });

  it('fails on a missing file instead of treating it as fresh', () => {
    const result = run('--check', '--out', join(dir, 'does-not-exist.md'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is missing/);
  });

  it('passes again once the stale file is regenerated', () => {
    const path = join(dir, 'regenerated.md');
    writeFileSync(path, 'not the reference\n');
    assert.equal(run('--check', '--out', path).status, 1);
    assert.equal(run('--out', path).status, 0);
    assert.equal(run('--check', '--out', path).status, 0);
    assert.equal(readFileSync(path, 'utf8'), fresh);
  });
});

describe('the committed reference', () => {
  it('is up to date with ontology/seamline.yaml and the manifests', () => {
    const result = run('--check');
    assert.equal(result.status, 0, result.stderr);
  });
});

describe('the rendering', () => {
  it('is byte-identical across two generations', () => {
    const again = join(dir, 'again.md');
    assert.equal(run('--out', again).status, 0);
    assert.equal(readFileSync(again, 'utf8'), fresh);
  });

  it('carries no timestamp and no em dash', () => {
    assert.ok(!fresh.includes(String.fromCharCode(0x2014)), 'no U+2014 in generated text');
    assert.doesNotMatch(fresh, /\d{4}-\d{2}-\d{2}T\d{2}:/);
    assert.ok(fresh.endsWith('\n') && !fresh.endsWith('\n\n'), 'exactly one trailing newline');
  });

  it('documents every node kind, edge kind and contradiction code in the contract', async () => {
    const contract = await import(join(ROOT, 'packages', 'ontology', 'src', 'contract.ts'));
    for (const kind of contract.NODE_KINDS) {
      assert.match(fresh, new RegExp(`^\\| \`${kind}\` \\|`, 'm'), `node kind ${kind} has no row`);
    }
    for (const kind of contract.EDGE_KINDS) {
      assert.match(fresh, new RegExp(`^\\| \`${kind}\` \\|`, 'm'), `edge kind ${kind} has no row`);
    }
    for (const code of contract.CONTRADICTION_CODES) {
      assert.ok(fresh.includes(`\`${code}\``), `contradiction code ${code} is not listed`);
    }
  });

  it('renders each edge row with exactly the contract signatures', async () => {
    const contract = await import(join(ROOT, 'packages', 'ontology', 'src', 'contract.ts'));
    for (const [kind, pairs] of Object.entries(contract.EDGE_SIGNATURES)) {
      const row = fresh.split('\n').find((line) => line.startsWith(`| \`${kind}\` |`));
      assert.ok(row !== undefined, `no row for ${kind}`);
      const rendered = [...row.matchAll(/`([A-Za-z]+)` to `([A-Za-z]+)`/g)]
        .map((m) => `${m[1]} -> ${m[2]}`)
        .sort();
      const expected = pairs.map((p) => `${p[0]} -> ${p[1]}`).sort();
      assert.deepEqual(rendered, expected, `${kind} signatures differ from the contract`);
    }
  });

  it('names an extractor as producer only where a manifest claims the kind', () => {
    const row = (kind) => fresh.split('\n').find((line) => line.startsWith(`| \`${kind}\` |`));
    assert.match(row('Column'), /`extract-data`/);
    assert.match(row('Operation'), /`extract-contracts`/);
    assert.match(row('Commit'), /`extract-change`/);
    assert.match(row('BACKED_BY'), /`infer-join`/);
    assert.doesNotMatch(row('TestCase'), /`extract-/, 'no shipped extractor claims TestCase');
    assert.match(row('TestCase'), /none declared/);
    assert.match(
      row('CALLS'),
      /none declared/,
      'extract-code-ts does not declare its edges in a manifest',
    );
  });
});
