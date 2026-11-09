import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCorpus } from './corpus.ts';
import { ConfigError } from './errors.ts';

const GOOD = {
  name: 'tiny',
  url: 'https://example.invalid/tiny/tiny',
  sha: 'a'.repeat(40),
  license: 'MIT',
  partition: 'dev',
  stacks: ['prisma'],
  why: 'A fixture.',
};

test('parseCorpus accepts a pinned entry and returns entries sorted by name', () => {
  const parsed = parseCorpus([
    { ...GOOD, name: 'zeta' },
    { ...GOOD, name: 'alpha' },
  ]);
  assert.deepEqual(
    parsed.map((e) => e.name),
    ['alpha', 'zeta'],
  );
});

test('parseCorpus refuses anything looser than a full commit id', () => {
  for (const sha of ['main', 'v1.2.3', 'a'.repeat(7), 'A'.repeat(40), 'a'.repeat(41)]) {
    assert.throws(() => parseCorpus([{ ...GOOD, sha }]), ConfigError, sha);
  }
});

test('parseCorpus refuses non-https URLs, duplicate names, and missing reasons', () => {
  assert.throws(() => parseCorpus([{ ...GOOD, url: 'http://example.invalid/x' }]), /https/);
  assert.throws(() => parseCorpus([{ ...GOOD, url: 'file:///tmp/x' }]), /https/);
  assert.throws(() => parseCorpus([GOOD, GOOD]), /duplicate name/);
  assert.throws(() => parseCorpus([{ ...GOOD, why: '' }]), /why/);
  assert.throws(() => parseCorpus([{ ...GOOD, stacks: [] }]), /stacks/);
  assert.throws(() => parseCorpus([{ ...GOOD, name: 'Has Space' }]), /name/);
  assert.throws(() => parseCorpus([]), /no repositories/);
  assert.throws(() => parseCorpus({}), /array/);
});

test('parseCorpus requires every entry to be assigned to the dev or sealed partition', () => {
  const { partition: _omitted, ...without } = GOOD;
  assert.throws(() => parseCorpus([without]), /partition/);
  assert.throws(() => parseCorpus([{ ...GOOD, partition: 'holdout' }]), /partition/);
  const parsed = parseCorpus([
    { ...GOOD, name: 'a', partition: 'sealed' },
    { ...GOOD, name: 'b' },
  ]);
  assert.deepEqual(
    parsed.map((e) => e.partition),
    ['sealed', 'dev'],
  );
});
