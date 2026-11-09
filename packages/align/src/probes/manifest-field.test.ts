import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { run } from '../__fixtures__/build.ts';

const ROOT = (
  engines: Record<string, string> | null,
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({ name: 'fx', private: true, ...(engines === null ? {} : { engines }), ...extra });
const WORKSPACE = "packages:\n  - 'packages/*'\n";
const NODE = { node: '>=20.3.0' };

/** What the probe made of the one floor claim a case holds: `class:reason`, `aligned`, or `none`. */
function outcome(files: Record<string, string>, subject: string): string {
  const ran = run(files);
  const f = ran.findings.find(
    (x) => x.id.endsWith(`RUNTIME_FLOOR:${subject}`) && x.class !== 'Resolved',
  );
  if (f === undefined) return ran.packet.summary.aligned > 0 ? 'aligned' : 'none';
  return `${f.class}:${f.reason}`;
}

const pkgDoc = (claim = '20.3', runtime = 'Node'): Record<string, string> => ({
  'pnpm-workspace.yaml': WORKSPACE,
  'packages/foo/package.json': JSON.stringify({ name: '@fx/foo' }),
  'packages/foo/README.md': `- **${runtime} >= ${claim}** is required.\n`,
});
const FOO = 'runtime:node@@fx/foo';

describe('manifest-field: read (4.1 step 1)', () => {
  test('R1 a package that keeps no engines inherits the floor of its root: aligned, or Observed drift, and never ABSENT', () => {
    assert.equal(outcome({ 'package.json': ROOT(NODE), ...pkgDoc('20.3') }, FOO), 'aligned');
    assert.equal(
      outcome({ 'package.json': ROOT(NODE), ...pkgDoc('20.1') }, FOO),
      'Observed drift:value-mismatch',
    );
  });

  test('R1c the nearer declaration wins', () => {
    const files = {
      'package.json': ROOT(NODE),
      ...pkgDoc('20.5'),
      'packages/foo/package.json': JSON.stringify({
        name: '@fx/foo',
        engines: { node: '>=20.5.0' },
      }),
    };
    assert.equal(outcome(files, FOO), 'aligned');
    assert.equal(
      outcome(
        {
          ...files,
          ...pkgDoc('20.3'),
          'packages/foo/package.json': files['packages/foo/package.json'],
        },
        FOO,
      ),
      'Observed drift:value-mismatch',
    );
  });

  test('R1e a manifest that holds engines.npm only: the walk goes on to the root', () => {
    const files = {
      'package.json': ROOT(NODE),
      ...pkgDoc('20.3'),
      'packages/foo/package.json': JSON.stringify({ name: '@fx/foo', engines: { npm: '>=10' } }),
    };
    assert.equal(outcome(files, FOO), 'aligned');
  });

  test('the observed value is the normalised X.Y.Z and the fact is DECLARED, with its line', () => {
    const ran = run({
      'package.json': `{\n  "name": "fx",\n  "engines": {\n    "node": ">=22.13"\n  }\n}\n`,
      ...pkgDoc('22.11'),
    });
    const f = ran.find('RUNTIME_FLOOR:' + FOO);
    assert.equal(f?.fact?.observed, '22.13.0');
    assert.equal(f?.fact?.provenance, 'DECLARED');
    assert.deepEqual(f?.fact?.source && [f.fact.source.path, f.fact.source.lineStart], [
      'package.json',
      4,
    ]);
  });

  test('R8 a range outside the single >= comparator is Unknown(unsupported-range)', () => {
    for (const range of ['^22', '>=20 <23', '20 || 22']) {
      assert.equal(
        outcome({ 'package.json': ROOT({ node: range }), ...pkgDoc('20') }, FOO),
        'Unknown:unsupported-range',
        range,
      );
    }
  });

  test('R7 an unparseable manifest on the walk is Unknown(manifest-unparseable)', () => {
    assert.equal(
      outcome({ 'package.json': '<<<<<<< ours', ...pkgDoc('20') }, FOO),
      'Unknown:manifest-unparseable',
    );
    const nearer = {
      'package.json': ROOT(NODE),
      ...pkgDoc('20'),
      'packages/foo/package.json': '{ nope',
    };
    assert.equal(outcome(nearer, 'runtime:node'), 'Unknown:manifest-unparseable');
  });
});

describe('manifest-field: survey (4.1 step 2, 5.4)', () => {
  const DOC = 'docs/toolchain.md';
  const claim = '- **Node >= 20.3** is required.\n';
  const base = (
    root: string | null,
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    ...(root === null ? {} : { 'package.json': root }),
    [DOC]: claim,
    ...extra,
  });

  test('R5 a root with no engines and no site anywhere is the Unexplained gap, as is engines.npm only (R5b)', () => {
    assert.equal(
      outcome(base(ROOT(null)), 'runtime:node'),
      'Unexplained gap:absent-in-implementation',
    );
    assert.equal(
      outcome(base(ROOT({ npm: '>=10' })), 'runtime:node'),
      'Unexplained gap:absent-in-implementation',
    );
  });

  const SITES: [string, Record<string, string>][] = [
    ['R3 .nvmrc', { '.nvmrc': '20' }],
    ['R3b .node-version', { '.node-version': '20' }],
    ['R3c .tool-versions', { '.tool-versions': 'nodejs 20' }],
    ['R3d mise.toml', { 'mise.toml': '' }],
    ['R3e .mise.toml', { '.mise.toml': '' }],
    ['R3j .config/mise/config.toml', { '.config/mise/config.toml': '' }],
    ['R3k .mise/config.toml', { '.mise/config.toml': '' }],
    ['R3l package.yaml', { 'package.yaml': 'name: x' }],
    ['R3m package.json5', { 'package.json5': '{}' }],
    ['a pin file in a subdirectory, matched by path suffix', { 'tools/web/.nvmrc': '20' }],
  ];
  for (const [name, files] of SITES) {
    test(`${name} is a site the probe does not read: Unknown(non-extracted-anchor)`, () => {
      assert.equal(
        outcome(base(ROOT(null), files), 'runtime:node'),
        'Unknown:non-extracted-anchor',
      );
    });
  }

  for (const [name, extra] of [
    ['R3f a volta key', { volta: { node: '20.0.0' } }],
    ['R3g a devEngines key', { devEngines: { runtime: { name: 'node' } } }],
    ['R3h a pnpm.executionEnv key', { pnpm: { executionEnv: { nodeVersion: '20' } } }],
  ] as const) {
    test(`${name} in the root manifest is a site`, () => {
      assert.equal(
        outcome(base(ROOT(null, extra)), 'runtime:node'),
        'Unknown:non-extracted-anchor',
      );
    });
  }

  test('R2 a pnpm requirement against packageManager pnpm@9 and no engines.pnpm is Unknown; yarn is a gap; engines.pnpm is aligned', () => {
    const doc = { 'docs/toolchain.md': '- **pnpm >= 9** is required.\n' };
    assert.equal(
      outcome(
        { 'package.json': ROOT(null, { packageManager: 'pnpm@9.15.0' }), ...doc },
        'runtime:pnpm',
      ),
      'Unknown:non-extracted-anchor',
    );
    assert.equal(
      outcome(
        { 'package.json': ROOT(null, { packageManager: 'yarn@4.0.0' }), ...doc },
        'runtime:pnpm',
      ),
      'Unexplained gap:absent-in-implementation',
    );
    assert.equal(
      outcome({ 'package.json': ROOT({ pnpm: '>=9.0.0' }), ...doc }, 'runtime:pnpm'),
      'aligned',
    );
  });

  test('R3i for a pnpm claim the node-only sites do not count', () => {
    const doc = { 'docs/toolchain.md': '- **pnpm >= 9** is required.\n', '.nvmrc': '20' };
    assert.equal(
      outcome(
        { 'package.json': ROOT(null, { pnpm: { executionEnv: { nodeVersion: '20' } } }), ...doc },
        'runtime:pnpm',
      ),
      'Unexplained gap:absent-in-implementation',
    );
  });

  test('R4 a tree with no package.json is Unknown(non-extracted-anchor)', () => {
    assert.equal(outcome(base(null), 'runtime:node'), 'Unknown:non-extracted-anchor');
  });

  test('R6 the survey covers the whole tracked tree: a package that declares it, a sibling that declares it, a pin file in a sibling', () => {
    const root = ROOT(null);
    const declaring = {
      'pnpm-workspace.yaml': WORKSPACE,
      'packages/a/package.json': JSON.stringify({ name: '@fx/a', engines: NODE }),
    };
    assert.equal(outcome(base(root, declaring), 'runtime:node'), 'Unknown:non-extracted-anchor');
    const sibling = {
      ...declaring,
      'packages/b/package.json': JSON.stringify({ name: '@fx/b' }),
      'packages/b/README.md': claim,
    };
    assert.equal(
      outcome({ 'package.json': root, ...sibling }, 'runtime:node@@fx/b'),
      'Unknown:non-extracted-anchor',
    );
    const pinned = {
      'pnpm-workspace.yaml': WORKSPACE,
      'packages/a/package.json': JSON.stringify({ name: '@fx/a' }),
      'packages/a/.nvmrc': '20',
      'packages/b/package.json': JSON.stringify({ name: '@fx/b' }),
      'packages/b/README.md': claim,
    };
    assert.equal(
      outcome({ 'package.json': root, ...pinned }, 'runtime:node@@fx/b'),
      'Unknown:non-extracted-anchor',
    );
  });

  test('R7b an unparseable manifest anywhere in the tree, when the walk found no floor, is Unknown(manifest-unparseable)', () => {
    const files = base(ROOT(null), {
      'pnpm-workspace.yaml': WORKSPACE,
      'packages/a/package.json': '{ nope',
    });
    assert.equal(outcome(files, 'runtime:node'), 'Unknown:manifest-unparseable');
  });
});

describe('manifest-field: floor sites nearer than the declaring manifest (4.1 step 1)', () => {
  const root = { 'package.json': ROOT(NODE), 'pnpm-workspace.yaml': WORKSPACE };
  const legacy = (
    claim: string,
    extra: Record<string, string> = {},
    manifest: Record<string, unknown> = {},
  ): Record<string, string> => ({
    ...root,
    'packages/legacy/package.json': JSON.stringify({ name: '@fx/legacy', ...manifest }),
    'packages/legacy/README.md': `- **Node >= ${claim}** is required.\n`,
    ...extra,
  });
  const LEGACY = 'runtime:node@@fx/legacy';

  test('S10 with no other file the claim inherits the root floor and is Observed drift', () => {
    assert.equal(outcome(legacy('16'), LEGACY), 'Observed drift:value-mismatch');
  });

  const FILES: [string, string][] = [
    ['S8 .nvmrc', '.nvmrc'],
    ['S8b .node-version', '.node-version'],
    ['S8c .tool-versions', '.tool-versions'],
    ['S8d mise.toml', 'mise.toml'],
    ['S8e .config/mise/config.toml', '.config/mise/config.toml'],
    ['S8f package.yaml beside the manifest', 'package.yaml'],
  ];
  for (const [name, file] of FILES) {
    test(`${name} in the package turns the inherited drift into Unknown(non-extracted-anchor), naming the site`, () => {
      const ran = run(legacy('16', { [`packages/legacy/${file}`]: '16' }));
      const f = ran.find(`RUNTIME_FLOOR:${LEGACY}`);
      assert.equal(`${f?.class}:${f?.reason}`, 'Unknown:non-extracted-anchor');
      assert.match(f?.unknown?.detail ?? '', new RegExp(file.replace(/\./g, '\\.')));
    });
  }

  for (const [name, manifest] of [
    ['S9 a volta key', { volta: { node: '16.0.0' } }],
    ['S9b a devEngines key', { devEngines: { runtime: { name: 'node', version: '16' } } }],
    ['S9c a pnpm.executionEnv key', { pnpm: { executionEnv: { nodeVersion: '16' } } }],
  ] as const) {
    test(`${name} in the package manifest is a site`, () => {
      assert.equal(outcome(legacy('16', {}, manifest), LEGACY), 'Unknown:non-extracted-anchor');
    });
  }

  test('S12 a pin file in the document’s own directory, which holds no manifest, is a site too', () => {
    const files = {
      ...root,
      'docs/legacy/guide.md': '- **Node >= 16** is required.\n',
      'docs/legacy/.nvmrc': '16',
    };
    assert.equal(outcome(files, 'runtime:node'), 'Unknown:non-extracted-anchor');
  });

  test('S1 a docs/package.json outside the workspace entries is a site, and one subject: D1 beats D2 for the correct claim too', () => {
    const files = {
      ...root,
      'docs/package.json': JSON.stringify({ name: 'docs-site', private: true }),
      'docs/guide.md': '- **Node >= 18** is needed to build this site.\n',
      'docs/toolchain.md': '- **Node >= 20.3** is required.\n',
    };
    assert.equal(outcome(files, 'runtime:node'), 'Unknown:non-extracted-anchor');
  });

  test('S1b the same manifest with docs added to the workspace entries is a discovered package that inherits the root floor', () => {
    const files = {
      ...root,
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'docs'\n",
      'docs/package.json': JSON.stringify({ name: 'docs-site', private: true }),
      'docs/guide.md': '- **Node >= 18** is needed to build this site.\n',
    };
    assert.equal(outcome(files, 'runtime:node@docs-site'), 'Observed drift:value-mismatch');
    assert.equal(
      outcome(
        { ...files, 'docs/guide.md': '- **Node >= 20.3** is needed.\n' },
        'runtime:node@docs-site',
      ),
      'aligned',
    );
  });

  test('S13 the root’s own .nvmrc sits beside the declaring manifest and does not count', () => {
    const files = legacy('20.1', { '.nvmrc': '22' });
    assert.equal(outcome(files, LEGACY), 'Observed drift:value-mismatch');
    assert.equal(outcome(legacy('20.3', { '.nvmrc': '22' }), LEGACY), 'aligned');
  });

  test('S14 a package that declares engines.node itself, with a .nvmrc beside its manifest, is read from that manifest', () => {
    const files = legacy(
      '16',
      { 'packages/legacy/.nvmrc': '16' },
      { engines: { node: '>=16.0.0' } },
    );
    assert.equal(outcome(files, LEGACY), 'aligned');
  });

  test('S11 pnpm in a package that keeps packageManager pnpm@8 is Unknown; node-only pins and another manager inherit and are Observed drift', () => {
    const rootPnpm = {
      'package.json': ROOT({ pnpm: '>=9.0.0' }),
      'pnpm-workspace.yaml': WORKSPACE,
    };
    const pkg = (
      manifest: Record<string, unknown>,
      extra: Record<string, string> = {},
    ): Record<string, string> => ({
      ...rootPnpm,
      'packages/p/package.json': JSON.stringify({ name: '@fx/p', ...manifest }),
      'packages/p/README.md': '- **pnpm >= 8** is required.\n',
      ...extra,
    });
    assert.equal(
      outcome(pkg({ packageManager: 'pnpm@8.15.0' }), 'runtime:pnpm@@fx/p'),
      'Unknown:non-extracted-anchor',
    );
    assert.equal(
      outcome(
        pkg({ pnpm: { executionEnv: { nodeVersion: '20' } } }, { 'packages/p/.nvmrc': '20' }),
        'runtime:pnpm@@fx/p',
      ),
      'Observed drift:value-mismatch',
    );
    assert.equal(
      outcome(pkg({ packageManager: 'yarn@4.0.0' }), 'runtime:pnpm@@fx/p'),
      'Observed drift:value-mismatch',
    );
  });

  test('an unparseable manifest met on the way is decided before any floor site is reported', () => {
    const files = {
      ...root,
      'packages/legacy/.nvmrc': '16',
      'packages/legacy/package.json': '{ nope',
      'packages/legacy/README.md': '- **Node >= 16** is required.\n',
    };
    assert.equal(outcome(files, 'runtime:node'), 'Unknown:manifest-unparseable');
    const farther = {
      ...files,
      'packages/legacy/package.json': JSON.stringify({ name: '@fx/legacy' }),
      'package.json': ROOT(NODE),
    };
    assert.equal(
      outcome(farther, '@fx/legacy'.replace(/^/, 'runtime:node@')),
      'Unknown:non-extracted-anchor',
    );
  });
});
