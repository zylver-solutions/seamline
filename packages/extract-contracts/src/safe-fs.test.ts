import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isRemoteReference,
  readCapped,
  resolveInsideRoot,
  toRepoRelativePosix,
  walkRepo,
  REFUSAL_ESCAPE,
  REFUSAL_REMOTE,
  REFUSAL_TOO_LARGE,
} from './safe-fs.ts';

test('every URI scheme is treated as remote, not only http(s)', () => {
  for (const remote of [
    'https://example.com/a.json',
    'http://example.com/a.json',
    'file:///etc/passwd',
    'ftp://example.com/a.yaml',
    'data:application/json,{}',
    '//example.com/a.json',
    'C:/Windows/win.ini',
  ]) {
    assert.equal(isRemoteReference(remote), true, remote);
  }
  for (const local of ['./a.yaml', '../b/c.json', 'schemas/x.yaml', '#/components/schemas/Pet', '']) {
    assert.equal(isRemoteReference(local), false, local);
  }
});

test('a path escaping the repo root is refused, symlinks included', () => {
  const base = mkdtempSync(join(tmpdir(), 'seamline-fs-'));
  try {
    const root = join(base, 'repo');
    mkdirSync(join(root, 'api'), { recursive: true });
    writeFileSync(join(base, 'secret.yaml'), 'a: 1\n', 'utf8');
    writeFileSync(join(root, 'api', 'ok.yaml'), 'b: 2\n', 'utf8');
    const from = join(root, 'api', 'doc.yaml');
    writeFileSync(from, 'c: 3\n', 'utf8');

    const escaped = resolveInsideRoot(root, from, '../../secret.yaml');
    assert.equal(escaped.ok, false);
    assert.equal(escaped.ok === false && escaped.refusal, REFUSAL_ESCAPE);

    const inside = resolveInsideRoot(root, from, './ok.yaml');
    assert.equal(inside.ok, true);
    assert.equal(inside.ok === true && inside.relPosix, 'api/ok.yaml');

    const remote = resolveInsideRoot(root, from, 'https://example.com/x.yaml');
    assert.equal(remote.ok, false);
    assert.equal(remote.ok === false && remote.refusal, REFUSAL_REMOTE);

    let symlinked = false;
    try {
      symlinkSync(join(base, 'secret.yaml'), join(root, 'api', 'link.yaml'));
      symlinked = true;
    } catch {
      // Symlink creation is not permitted on every filesystem; the lexical
      // check above still covers the escape.
    }
    if (symlinked) {
      const viaLink = resolveInsideRoot(root, from, './link.yaml');
      assert.equal(viaLink.ok, false, 'a symlink out of the tree must not be followed');
      assert.equal(viaLink.ok === false && viaLink.refusal, REFUSAL_ESCAPE);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an oversized file is refused rather than read', () => {
  const base = mkdtempSync(join(tmpdir(), 'seamline-fs-'));
  try {
    const big = join(base, 'big.yaml');
    writeFileSync(big, 'x'.repeat(4096), 'utf8');
    const refused = readCapped(big, 1024);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.refusal, REFUSAL_TOO_LARGE);
    const allowed = readCapped(big, 8192);
    assert.equal(allowed.ok, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('discovery returns sorted repo-relative POSIX paths and skips vendored trees', () => {
  const base = mkdtempSync(join(tmpdir(), 'seamline-walk-'));
  try {
    mkdirSync(join(base, 'b', 'deep'), { recursive: true });
    mkdirSync(join(base, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(base, 'dist'), { recursive: true });
    writeFileSync(join(base, 'z.yaml'), '1\n', 'utf8');
    writeFileSync(join(base, 'a.yaml'), '1\n', 'utf8');
    writeFileSync(join(base, 'b', 'deep', 'c.json'), '{}\n', 'utf8');
    writeFileSync(join(base, 'node_modules', 'pkg', 'openapi.yaml'), '1\n', 'utf8');
    writeFileSync(join(base, 'dist', 'openapi.yaml'), '1\n', 'utf8');

    const found = walkRepo(base, 1000);
    assert.deepEqual(found, ['a.yaml', 'b/deep/c.json', 'z.yaml']);
    assert.ok(found.every((f) => !f.includes('\\')), 'paths are POSIX');

    const capped = walkRepo(base, 2);
    assert.equal(capped.length, 2, 'the file cap is enforced');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('discovery does not walk the evaluation harness cache or output directories', () => {
  // `pnpm eval fetch` clones third-party repositories into `.eval-cache/` and a run writes
  // `eval-out/`, both inside the repository root. They are other projects' contracts and
  // run artefacts, not this repository's, and reading them would fail the dogfood gates
  // (a contract declared in two projects is a name collision) on any machine that has
  // run the evaluation.
  const base = mkdtempSync(join(tmpdir(), 'seamline-walk-eval-'));
  try {
    mkdirSync(join(base, '.eval-cache', 'umami', 'src'), { recursive: true });
    mkdirSync(join(base, 'eval-out', 'umami'), { recursive: true });
    mkdirSync(join(base, 'src'), { recursive: true });
    writeFileSync(join(base, '.eval-cache', 'umami', 'src', 'schema.ts'), 'x\n', 'utf8');
    writeFileSync(join(base, '.eval-cache', 'openapi.json'), '{}\n', 'utf8');
    writeFileSync(join(base, 'eval-out', 'umami', 'report.json'), '{}\n', 'utf8');
    writeFileSync(join(base, 'src', 'schema.ts'), 'x\n', 'utf8');

    assert.deepEqual(walkRepo(base, 1000), ['src/schema.ts']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('repo-relative conversion never emits a backslash', () => {
  const rel = toRepoRelativePosix('/a/b', '/a/b/c/d.yaml');
  assert.equal(rel, 'c/d.yaml');
});
