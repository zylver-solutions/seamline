import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineMismatch, sealedProblem, type Measured } from './analyse.ts';

const CLI = { path: 'packages/cli/dist/index.js', ownBuild: true, distDigest: 'd'.repeat(64) };
const NOW: Measured = { codeId: 'code-a', identified: true, cli: CLI };

test('a stored baseline is accepted only when its sources and its build are the current ones', () => {
  assert.equal(baselineMismatch({ codeId: 'code-a', cli: CLI }, NOW), null);
  assert.match(
    baselineMismatch({ codeId: 'code-b', cli: CLI }, NOW) ?? '',
    /other detector or extractor sources/,
  );
  assert.match(baselineMismatch({ cli: CLI }, NOW) ?? '', /did not record them/);
  for (const [name, cli] of [
    ['another digest', { ...CLI, distDigest: '0'.repeat(64) }],
    ['another path', { ...CLI, path: '/tmp/cli.js' }],
    ['not the own build', { ...CLI, ownBuild: false }],
    ['no build recorded', undefined],
    ['a build that is not an object', 'packages/cli/dist/index.js'],
  ] as const) {
    assert.match(
      baselineMismatch({ codeId: 'code-a', cli }, NOW) ?? '',
      /another build of the CLI/,
      name,
    );
  }
});

test("nothing is reused for a CLI that is not this repository's own build, even a baseline that equals it", () => {
  const other = {
    path: '/tmp/other-checkout/dist/index.js',
    ownBuild: false,
    distDigest: 'f'.repeat(64),
  };
  const foreign: Measured = { codeId: 'code-a', identified: true, cli: other };
  const reason = baselineMismatch({ codeId: 'code-a', cli: other }, foreign) ?? '';
  assert.match(reason, /not this repository's own build/);
  assert.match(reason, /\/tmp\/other-checkout\/dist\/index\.js/);
  // The same bytes of the entry file, from another checkout: still nothing to reuse.
  assert.match(
    baselineMismatch(
      { codeId: 'code-a', cli: { ...other, path: '/tmp/b/dist/index.js' } },
      {
        ...foreign,
        cli: { ...other, path: '/tmp/b/dist/index.js' },
      },
    ) ?? '',
    /not this repository's own build/,
  );
  // The own build is unaffected.
  assert.equal(baselineMismatch({ codeId: 'code-a', cli: CLI }, NOW), null);
});

test('nothing is accepted where the sources cannot be identified, not even an equal "no git"', () => {
  const unnamed: Measured = { codeId: 'no git', identified: false, cli: CLI };
  assert.match(
    baselineMismatch({ codeId: 'no git', cli: CLI }, unnamed) ?? '',
    /cannot be identified outside a git checkout/,
  );
});

test('a sealed repository is measured only with the own build of sources that can be named', () => {
  assert.equal(sealedProblem(NOW), null);
  assert.match(
    sealedProblem({ ...NOW, cli: { ...CLI, path: '/tmp/cli.js', ownBuild: false } }) ?? '',
    /own built CLI \(packages\/cli\/dist\/index\.js\), not \/tmp\/cli\.js/,
  );
  assert.match(sealedProblem({ ...NOW, identified: false }) ?? '', /outside a git checkout/);
});
