/**
 * The claim for a run that did not read every candidate must always compile: the store
 * refuses a selector it cannot evaluate, and `finalizeRun` then throws and loses the run.
 * A name holding a character a pattern cannot write used to produce `<name>/**` with a
 * wildcard before `**`, which `compilePattern` rejects.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileSelector } from '@seamline/core';

import { MAX_EXCLUSIONS, authoritativeSelectorFor, dataClaimFor } from './extractor.ts';

const ADVERSARIAL: ReadonlyArray<string> = [
  '!top.sql',
  'we,ird.sql',
  'dir,x/b.sql',
  'a{b}.sql',
  'star*.sql',
  'q?.sql',
  'ends-in-question?',
  'back\\slash.sql',
  'tab\there.sql',
  ' lead.sql',
  'trail.sql ',
  'db/!bang.sql',
  'db/we,ird.sql',
  'db/sub,dir/deep/c.prisma',
  'dir with space/x.sql',
  'db/name?',
  'a//b.sql',
  './x.sql',
  'db/../x.sql',
  '.',
  '',
  'db',
  'db/b.sql',
];

test('the claim compiles for every adversarial unread path, alone and together', () => {
  for (const path of ADVERSARIAL) {
    const selector = authoritativeSelectorFor([path]);
    assert.doesNotThrow(() => compileSelector(selector), JSON.stringify(path));
  }
  assert.doesNotThrow(() => compileSelector(authoritativeSelectorFor(ADVERSARIAL)));
});

test('a writable path is excluded exactly: as itself and as a directory', () => {
  const compiled = compileSelector(authoritativeSelectorFor(['db/b.sql']));
  assert.equal(compiled.matches('db/b.sql'), false);
  assert.equal(compiled.matches('db/b.sql/x.sql'), false);
  assert.equal(compiled.matches('db/a.sql'), true);
  assert.equal(compiled.matches('db/b.ts'), false, 'same stem, an extension the extractor reads');
});

test('a leading `!` is written exactly, as an exclusion of the literal path', () => {
  const compiled = compileSelector(authoritativeSelectorFor(['!top.sql']));
  assert.equal(compiled.matches('!top.sql'), false);
  assert.equal(compiled.matches('db/a.sql'), true);
  assert.equal(compiled.matches('top.sql'), true, 'a different file');
  assert.equal(compiled.matches('vendor/!top.ts'), false, 'same stem, another extension');
});

test('an unwritable name is withheld as itself and, for a directory, as everything under its nameable ancestor', () => {
  // The unwritable segment is in a nested directory: its writable ancestor is withheld whole.
  const nested = compileSelector(authoritativeSelectorFor(['db/sub,dir/deep/c.prisma']));
  assert.equal(nested.matches('db/sub,dir/deep/c.prisma'), false);
  assert.equal(nested.matches('db/sub,dir/deep/x.sql'), false, 'under the unread directory');
  assert.equal(nested.matches('db/other.sql'), false, 'under the nameable ancestor db/');
  assert.equal(nested.matches('app/other.sql'), true, 'outside the ancestor is still swept');

  const file = compileSelector(authoritativeSelectorFor(['db/we,ird.sql']));
  assert.equal(file.matches('db/we,ird.sql'), false);
  assert.equal(file.matches('db/a.sql'), false);
  assert.equal(file.matches('app/a.sql'), true);

  // No nameable ancestor at all: nothing is swept.
  const top = compileSelector(authoritativeSelectorFor(['we,ird.sql']));
  for (const path of ['a.sql', 'db/a.sql', 'we,ird.sql']) assert.equal(top.matches(path), false);
  const root = compileSelector(authoritativeSelectorFor(['.']));
  assert.equal(root.matches('db/a.sql'), false);
});

test('past the exclusion bound the claim is nothing, and says so', () => {
  const few = Array.from({ length: 20 }, (_, i) => `db/f${i}.sql`);
  assert.equal(dataClaimFor(few).note, undefined);
  assert.equal(compileSelector(dataClaimFor(few).selector).matches('db/other.sql'), true);

  const many = Array.from(
    { length: Math.ceil(MAX_EXCLUSIONS / 10) + 10 },
    (_, i) => `db/f${i}.sql`,
  );
  const claim = dataClaimFor(many);
  assert.match(claim.note ?? '', /claims nothing/);
  assert.match(claim.note ?? '', new RegExp(`more than ${MAX_EXCLUSIONS}`));
  const compiled = compileSelector(claim.selector);
  for (const path of ['db/other.sql', 'x/y.prisma', 'a.ts']) {
    assert.equal(compiled.matches(path), false);
  }
  assert.equal(compiled.clauses.filter((c) => c.negated).length, 1);
});

test('stem patterns are not repeated for paths that share a stem', () => {
  const selector = authoritativeSelectorFor(['a/b.sql', 'c/b.ddl', 'd/b.sql']);
  const exclusions = selector.split(',').filter((x) => x.startsWith('!**/b.'));
  assert.deepEqual(exclusions, [...new Set(exclusions)]);
  assert.equal(exclusions.length, 10);
});
