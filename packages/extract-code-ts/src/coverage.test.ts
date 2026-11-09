/**
 * The selector is judged by what a glob engine makes of it, not by its text:
 * `path.matchesGlob` is the oracle wherever its rules agree with the store's
 * selector syntax (brace list, `**` as a whole segment, `*` inside one).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodePath from 'node:path';
import { posix } from 'node:path';
import {
  CLAIMS_NOTHING_SELECTOR, MAX_LISTED_UNCOVERED, authoritativeSelector, coverageDiagnostics,
} from './coverage.ts';
import type { LoadedProject } from './coverage.ts';

const ROOT = nodePath.resolve('/fixture-root');
const TS = ['.cts', '.mts', '.ts', '.tsx'];

function project(dirs: ReadonlyArray<readonly [string, boolean]>, files: readonly string[] = []): LoadedProject {
  return {
    directories: dirs.map(([rel, recursive]) => ({ path: nodePath.join(ROOT, rel), recursive })),
    files: files.map((rel) => nodePath.join(ROOT, rel)),
    extensions: TS,
    outputDirs: [],
  };
}

function assertClaims(selector: string, claimed: readonly string[], unclaimed: readonly string[]): void {
  for (const path of claimed) assert.equal(posix.matchesGlob(path, selector), true, `${path} must be claimed`);
  for (const path of unclaimed) assert.equal(posix.matchesGlob(path, selector), false, `${path} must not be claimed`);
}

test('an included directory is claimed whole, so a file deleted from it stays inside the selector', () => {
  const selector = authoritativeSelector(ROOT, [project([['src', true]])], new Set(['src/a.ts', 'src/b.ts']), []);
  assert.equal(selector, '{src/**/*.cts,src/**/*.mts,src/**/*.ts,src/**/*.tsx}');
  assertClaims(
    selector,
    ['src/a.ts', 'src/b.ts', 'src/deleted.ts', 'src/deep/deleted.tsx'],
    ['tools/x.ts', 'src/a.js', 'srcx/a.ts'],
  );
});

test('a root-level include claims root files, and a non-recursive one stops at its directory', () => {
  const selector = authoritativeSelector(ROOT, [project([['', false], ['lib', true]])], new Set(['root.ts']), []);
  assertClaims(selector, ['root.ts', 'gone.ts', 'lib/x/y.ts'], ['src/a.ts', 'README.md']);
});

test('a directory holding an existing file the run did not read is not claimed whole', () => {
  // The project's own `exclude` dropped src/skip.ts: it exists, so it is unread, not deleted.
  const selector = authoritativeSelector(
    ROOT,
    [project([['src', true]])],
    new Set(['src/a.ts', 'src/b.tsx']),
    ['src/skip.ts'],
  );
  assert.equal(selector, '{src/**/*.cts,src/**/*.mts,src/**/*.tsx,src/a.ts}');
  assertClaims(selector, ['src/a.ts', 'src/b.tsx', 'src/c.tsx'], ['src/skip.ts', 'src/deleted.ts']);
});

test('files entries and files reached only through imports are named literally, brackets included', () => {
  const selector = authoritativeSelector(
    ROOT,
    [project([['src', true]], ['tools/listed.ts'])],
    new Set(['src/a.ts', 'shared/[id]/model.ts']),
    [],
  );
  // `[` and `]` are literal in the selector syntax; a `files` entry stays claimed after it is deleted.
  assert.equal(
    selector,
    '{shared/[id]/model.ts,src/**/*.cts,src/**/*.mts,src/**/*.ts,src/**/*.tsx,tools/listed.ts}',
  );
  assertClaims(selector, ['tools/listed.ts', 'src/a.ts'], ['tools/other.ts', 'shared/x/model.ts']);
});

test('without the coverage walk only named paths are claimed', () => {
  const selector = authoritativeSelector(ROOT, [project([['src', true]])], new Set(['src/a.ts', 'src/b.ts']), null);
  assert.equal(selector, '{src/a.ts,src/b.ts}');
});

test('a path the selector syntax cannot write is left out, never escaped into a different claim', () => {
  const projects = [project([['odd,dir', true]])];
  assert.equal(authoritativeSelector(ROOT, projects, new Set(['odd,dir/a.ts', 'src/a.ts']), []), 'src/a.ts');
  assert.equal(authoritativeSelector(ROOT, projects, new Set(['odd,dir/a.ts']), []), CLAIMS_NOTHING_SELECTOR);
  assert.equal(authoritativeSelector(ROOT, [], new Set(['src/{x}.ts', ' lead.ts']), []), CLAIMS_NOTHING_SELECTOR);
});

test('a path that begins with `!` is left out (it would read as an exclusion), one with `!` later is named', () => {
  const projects = [project([['!bang', true]])];
  assert.equal(authoritativeSelector(ROOT, [], new Set(['!a.ts']), []), CLAIMS_NOTHING_SELECTOR);
  assert.equal(authoritativeSelector(ROOT, [], new Set(['!a.ts', 'src/b.ts']), []), 'src/b.ts');
  assert.equal(authoritativeSelector(ROOT, [], new Set(['src/!c.ts']), []), 'src/!c.ts');
  assert.equal(authoritativeSelector(ROOT, projects, new Set(['!bang/a.ts']), []), CLAIMS_NOTHING_SELECTOR);
});

test('coverage names every unread candidate after a summary carrying the ratio', () => {
  const lines = coverageDiagnostics(['src/a.ts', 'src/b.ts', 'tools/x.ts'], new Set(['src/a.ts', 'src/b.ts']));
  assert.match(lines[0] ?? '', /^tsconfig coverage: 2\/3 /);
  assert.deepEqual(lines.slice(1), ['not in any loaded tsconfig project: tools/x.ts']);
  assert.deepEqual(coverageDiagnostics(['src/a.ts'], new Set(['src/a.ts'])), [], 'a covered run reports nothing');
});

test('a long uncovered list is capped, and the summary still carries the full count', () => {
  const candidates = Array.from({ length: MAX_LISTED_UNCOVERED + 7 }, (_, i) => `loose/${String(i).padStart(3, '0')}.js`);
  const lines = coverageDiagnostics(candidates, new Set());
  assert.match(lines[0] ?? '', new RegExp(`^tsconfig coverage: 0/${MAX_LISTED_UNCOVERED + 7} `));
  assert.equal(lines.length, 1 + MAX_LISTED_UNCOVERED + 1);
  assert.equal(lines.at(-1), '... 7 more not listed');
});
