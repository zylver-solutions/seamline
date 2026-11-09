#!/usr/bin/env node
/**
 * Tests for scripts/outside-install.mjs.
 *
 * The end-to-end test is the point: the tarballs `pnpm pack` makes are unpacked into a fresh
 * directory outside the repository, and `npx seamline conformance` is run there on a standalone
 * extractor that passes and on one that does not. The rest pins the pieces so a failure says which
 * piece broke: the verdict the script holds the two runs to, and the dependency lookup that stands in
 * for `npm install` when there is no network.
 *
 * Needs built output (`pnpm build`): a missing `dist/` is a failure here, not a skip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { REPO_ROOT } from './pack-check.mjs';
import {
  BAD_EXTRACTOR,
  GOOD_EXTRACTOR,
  judge,
  lookup,
  outsideInstall,
  thirdPartyClosure,
} from './outside-install.mjs';

const PASSING = ['conformance: PASS (8 PASS, 0 FAIL, 0 UNAVAILABLE, 0 NOT_APPLICABLE)'].join('\n');
const FAILING = [
  'FAIL          no-network            makes no network, DNS, fetch or child-process attempt',
  '                - clean fixture: [network] todo-notes-bad: net.connect is refused',
].join('\n');

test('judge accepts a passing good run next to a failing bad one', () => {
  assert.deepEqual(
    judge({ good: { status: 0, stdout: PASSING }, bad: { status: 1, stdout: FAILING } }),
    [],
  );
});

test('judge names each way the two runs can be wrong', () => {
  const ok = { good: { status: 0, stdout: PASSING }, bad: { status: 1, stdout: FAILING } };
  const cases = [
    [{ ...ok, good: { ...ok.good, status: 1 } }, /well-behaved extractor exited 1/],
    [{ ...ok, good: { ...ok.good, stdout: 'conformance: UNAVAILABLE' } }, /did not report 8 PASS/],
    [{ ...ok, bad: { ...ok.bad, status: 0 } }, /misbehaving extractor exited 0/],
    [{ ...ok, bad: { ...ok.bad, status: 3 } }, /misbehaving extractor exited 3/],
    [{ ...ok, bad: { ...ok.bad, stdout: 'FAIL          manifest' } }, /did not FAIL no-network/],
    [
      { ...ok, bad: { ...ok.bad, stdout: FAILING.replace('[network]', '[x]') } },
      /no \[network\] evidence/,
    ],
  ];
  for (const [input, expected] of cases) {
    const failures = judge(input);
    assert.ok(
      failures.some((f) => expected.test(f)),
      `${expected}: ${failures.join(' | ')}`,
    );
  }
});

test('the misbehaving extractor is the good one plus a swallowed network attempt, and nothing else', () => {
  assert.doesNotMatch(GOOD_EXTRACTOR, /node:net|net\.connect/);
  assert.match(BAD_EXTRACTOR, /import net from 'node:net'/);
  assert.match(BAD_EXTRACTOR, /net\.connect\(443, 'example\.com'\)/);
  assert.match(BAD_EXTRACTOR, /name: 'todo-notes-bad'/);
  const strip = (s) =>
    s
      .replace("name: 'todo-notes-bad'", "name: 'todo-notes'")
      .replace("\nimport net from 'node:net';", '')
      .replace(
        "  try {\n    net.connect(443, 'example.com');\n  } catch {\n    // swallowed\n  }\n",
        '',
      );
  assert.equal(strip(BAD_EXTRACTOR), GOOD_EXTRACTOR);
});

test('thirdPartyClosure follows the dependencies of dependencies, as pnpm lays them out', () => {
  const root = mkdtempSync(join(tmpdir(), 'seamline-closure-'));
  try {
    const pkg = (dir, manifest) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    };
    const store = join(root, 'node_modules', '.pnpm');
    // app -> a -> b, with b only reachable as a sibling of a in the store; opt is optional and absent.
    pkg(join(root, 'app'), {
      name: 'app',
      dependencies: { a: '1', '@seamline/core': '1' },
      optionalDependencies: { opt: '1' },
    });
    pkg(join(store, 'a@1', 'node_modules', 'a'), { name: 'a', dependencies: { b: '1' } });
    pkg(join(store, 'b@1', 'node_modules', 'b'), { name: 'b' });
    mkdirSync(join(store, 'a@1', 'node_modules'), { recursive: true });
    symlinkSync(join(store, 'b@1', 'node_modules', 'b'), join(store, 'a@1', 'node_modules', 'b'));
    mkdirSync(join(root, 'app', 'node_modules'), { recursive: true });
    symlinkSync(join(store, 'a@1', 'node_modules', 'a'), join(root, 'app', 'node_modules', 'a'));

    const found = thirdPartyClosure([join(root, 'app')]);
    assert.deepEqual(
      [...found.keys()].sort(),
      ['a', 'b'],
      'workspace packages and absent optional dependencies are not third-party packages to copy',
    );
    assert.equal(lookup(join(root, 'app'), 'a'), join(root, 'app', 'node_modules', 'a'));
    assert.equal(lookup(join(root, 'app'), 'nope'), undefined);

    // A required dependency that is not installed is an error, not a quiet gap in the install.
    pkg(join(root, 'broken'), { name: 'broken', dependencies: { missing: '1' } });
    assert.throws(
      () => thirdPartyClosure([join(root, 'broken')]),
      /missing is a dependency of .* and is not installed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'packed tarballs, installed outside the repository, run `npx seamline conformance` on a standalone extractor',
  { timeout: 280_000 },
  () => {
    const seen = [];
    const result = outsideInstall({
      offlineDeps: true,
      keep: true,
      log: (step) => seen.push(step),
    });
    try {
      assert.deepEqual(result.failures, []);
      assert.equal(result.ok, true);
      // Fresh and outside: nothing of the repository is on the way to the install.
      assert.ok(relative(REPO_ROOT, result.consumer).startsWith('..'), result.consumer);
      // The install is the tarball, not the source tree.
      const installed = join(result.consumer, 'node_modules', '@seamline', 'cli');
      assert.ok(existsSync(join(installed, 'dist', 'bin.js')));
      assert.ok(!existsSync(join(installed, 'src')), 'the tarball ships dist/, not src/');
      assert.ok(existsSync(join(installed, 'dist', 'conformance', 'wrapper.js')));
      assert.ok(existsSync(join(installed, 'dist', 'conformance', 'describe-child.js')));
      // Both runs happened, through the `seamline` bin npx found in the install.
      const runs = seen.filter((s) =>
        s.command.startsWith('npx --no-install seamline conformance'),
      );
      assert.deepEqual(
        runs.map((s) => [s.command.split(' ').at(-1), s.status]),
        [
          ['./my-extractor.mjs', 0],
          ['./bad-extractor.mjs', 1],
        ],
      );
      assert.match(runs[0].stdout, /^PASS +reads-confined /m);
      assert.match(runs[1].stdout, /^FAIL +no-network /m);
    } finally {
      rmSync(result.root, { recursive: true, force: true });
    }
  },
);
