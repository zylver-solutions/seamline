/**
 * The `contracts` claim selector, against the store that evaluates it.
 *
 * `claimSelector` writes a selector from arbitrary repository paths, and the
 * store rejects the whole run when a selector does not compile, so the writer
 * has to hold two properties for any input: whatever it returns compiles with
 * the store's own `compileSelector`, and it never covers a file the run could
 * not vouch for (covering one would let the run bury what an earlier run read
 * from it). Paths here include the characters selector syntax treats
 * specially, whitespace, dots, empty segments and non-ASCII names.
 *
 * Deterministic: a fixed seed, and no clock.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { compileSelector } from '@seamline/core';
import { claimSelector } from '@seamline/extract-contracts';

const SEED = 20260829;
const RUNS = 2000;

// Include directories skipped by discovery: an explicit file list can name them.
const SPECIAL = [
  'a',
  'ab',
  'src',
  'lib',
  'node_modules',
  'x y',
  'we,ird',
  'br{ace}',
  'br}ace',
  'wild*',
  'q?',
  'back\\slash',
  '[set]',
  'dot.dir',
  '.hidden',
  '.',
  '..',
  '',
  'trail ',
  ' lead',
  'tab\tname',
  'été',
  '日本',
  'a'.repeat(40),
];

const segment = fc.oneof(
  fc.constantFrom(...SPECIAL),
  fc.string({ minLength: 1, maxLength: 6 }),
);
const extension = fc.constantFrom('.ts', '.tsx', '.json', '.yaml', '.yml', '.d.ts', '.md');

const path = fc
  .tuple(fc.array(segment, { minLength: 0, maxLength: 4 }), segment, extension)
  .map(([dirs, base, ext]) => [...dirs, `${base}${ext}`].join('/'));

const scenario = fc.uniqueArray(path, { minLength: 1, maxLength: 14 }).chain((candidates) =>
  fc.record({
    candidates: fc.constant(candidates),
    unvouched: fc.subarray(candidates),
    // Paths the run was told about but that are not in the walked set.
    extra: fc.uniqueArray(path, { maxLength: 2 }),
  }),
);

const PLAIN = /^[a-z0-9]+$/;
const plainFile = (rel: string): boolean => {
  const segments = rel.split('/');
  const last = segments.pop() as string;
  return segments.every((s) => PLAIN.test(s)) && /^[a-z0-9]+\.(ts|tsx|json|yaml|yml)$/.test(last);
};

test('any selector the writer returns compiles in the store, and never covers an unvouched file', () => {
  fc.assert(
    fc.property(scenario, ({ candidates, unvouched, extra }) => {
      const all = new Set([...unvouched, ...extra]);
      const selector = claimSelector(candidates, all);
      if (all.size === 0) {
        assert.equal(selector, undefined);
        return;
      }
      assert.ok(selector !== undefined, 'a narrowed claim always has a selector');
      const compiled = compileSelector(selector);
      for (const rel of all)
        assert.equal(
          compiled.matches(rel),
          false,
          `${JSON.stringify(rel)} is covered by ${selector}`,
        );
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

test('a vouched file with plain names is claimed, and the selector does not depend on input order', () => {
  fc.assert(
    fc.property(scenario, ({ candidates, unvouched }) => {
      const dirty = new Set(unvouched);
      const selector = claimSelector(candidates, dirty);
      const reversed = claimSelector([...candidates].reverse(), new Set([...dirty].reverse()));
      assert.equal(reversed, selector, 'byte-reproducible whatever the discovery order');
      if (selector === undefined) return;
      const compiled = compileSelector(selector);
      for (const rel of candidates)
        if (!dirty.has(rel) && plainFile(rel))
          assert.equal(compiled.matches(rel), true, `${rel} should be claimed by ${selector}`);
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

test('a run that vouches for nothing claims nothing', () => {
  fc.assert(
    fc.property(fc.uniqueArray(path, { minLength: 1, maxLength: 8 }), (candidates) => {
      const selector = claimSelector(candidates, new Set(candidates));
      assert.ok(selector !== undefined);
      const compiled = compileSelector(selector);
      for (const rel of candidates) assert.equal(compiled.matches(rel), false, rel);
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

test('an empty claim excludes explicit node_modules inputs and unrelated paths', () => {
  const file = 'node_modules/schema.ts';
  const selector = claimSelector([file], new Set([file]));
  assert.ok(selector !== undefined);
  const compiled = compileSelector(selector);
  for (const rel of [file, 'node_modules/old.ts', 'src/schema.ts', 'schema.ts'])
    assert.equal(compiled.matches(rel), false, rel);
});
