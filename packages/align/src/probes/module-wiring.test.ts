import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { THREATMODEL_CONTROLS_PREFIX, THREATMODEL_CONTROLS_MAIN } from '../__fixtures__/frozen.ts';
import { ALL_PASS, run, withResult, type FactsOptions } from '../__fixtures__/build.ts';

const WORKSPACE = "packages:\n  - 'packages/*'\n";

/** One controls row, `C1`, with a cue, naming `paths` in code spans. */
const row = (paths: string[]): string =>
  `## Controls\n\n| # | Control | Where |\n| --- | --- | --- |\n| C1 | The module is wired. | ${paths.map((p) => `\`${p}\``).join(' and ')} |\n`;

function base(extra: Record<string, string>, paths: string[]): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'fx', private: true }),
    'pnpm-workspace.yaml': WORKSPACE,
    'packages/p/package.json': JSON.stringify({ name: '@fx/p' }),
    'README.md': row(paths),
    ...extra,
  };
}

/** `class:reason` of control:C1, or `aligned` (a HOLDS has no finding). */
function wiring(files: Record<string, string>, options: FactsOptions = {}): string {
  const ran = run(files, options);
  const f = ran.find('control:C1');
  return f === undefined ? 'aligned' : `${f.class}:${f.reason}`;
}

const MOD = 'packages/p/src/guard.ts';
const mod = { [MOD]: 'export function guard(): boolean {\n  return true;\n}\n' };
const UNWIRED = 'Unknown:no-static-consumer';

describe('module-wiring: consumers, tests and barrels (4.4)', () => {
  test('W1 a module imported by a non-test, non-barrel file outside the claim’s paths is HOLDS', () => {
    const files = base(
      {
        ...mod,
        'packages/p/src/use.ts':
          "import { guard } from './guard.ts';\nexport const used = guard();\n",
      },
      [MOD],
    );
    assert.equal(wiring(files), 'aligned');
  });

  test('W2 one imported only by its test is Unknown(no-static-consumer)', () => {
    const files = base(
      { ...mod, 'packages/p/src/guard.test.ts': "import { guard } from './guard.ts';\nguard();\n" },
      [MOD],
    );
    assert.equal(wiring(files), UNWIRED);
  });

  test('W3 one imported only by a barrel that nothing imports is Unknown(no-static-consumer)', () => {
    const files = base({ ...mod, 'packages/p/src/index.ts': "export * from './guard.ts';\n" }, [
      MOD,
    ]);
    assert.equal(wiring(files), UNWIRED);
  });

  test('W4 one reached through a chain of two barrels by a non-test file is HOLDS', () => {
    const files = base(
      {
        ...mod,
        'packages/p/src/inner.ts': "export * from './guard.ts';\n",
        'packages/p/src/outer.ts': "export * from './inner.ts';\n",
        'packages/p/src/use.ts':
          "import { guard } from './outer.ts';\nexport const used = guard();\n",
      },
      [MOD],
    );
    assert.equal(wiring(files), 'aligned');
  });

  test('W5 two files of one package that export a function of the same name: only the one a third file imports is HOLDS (file-level edges, never symbol-level)', () => {
    const files = {
      'packages/p/src/a.ts': 'export function same(): number {\n  return 1;\n}\n',
      'packages/p/src/b.ts': 'export function same(): number {\n  return 2;\n}\n',
      'packages/p/src/use.ts': "import { same } from './b.ts';\nexport const x = same();\n",
    };
    assert.equal(wiring(base(files, ['packages/p/src/a.ts'])), UNWIRED);
    assert.equal(wiring(base(files, ['packages/p/src/b.ts'])), 'aligned');
  });

  test('a type-only import counts as a consumer (errs toward HOLDS)', () => {
    const files = base(
      {
        ...mod,
        'packages/p/src/use.ts':
          "import type { guard } from './guard.ts';\nexport type G = typeof guard;\n",
      },
      [MOD],
    );
    assert.equal(wiring(files), 'aligned');
  });
});

describe('module-wiring: other packages and entry points (4.4)', () => {
  const dependent = {
    'packages/q/package.json': JSON.stringify({
      name: '@fx/q',
      dependencies: { '@fx/p': 'workspace:*' },
    }),
    'packages/q/src/index.ts': "import { guard } from '@fx/p';\nexport const x = guard;\n",
  };

  test('W6 a module whose only consumer is in another package that lists its package in dependencies is Unknown(cross-package-unobservable)', () => {
    assert.equal(
      wiring(base({ ...mod, ...dependent }, [MOD])),
      'Unknown:cross-package-unobservable',
    );
  });

  const entry = {
    'packages/p/package.json': JSON.stringify({
      name: '@fx/p',
      bin: { p: './dist/bin.js' },
      main: './dist/index.js',
    }),
    'packages/p/src/bin.ts': 'export const run = 1;\n',
    'packages/p/src/index.ts': 'export const api = 1;\n',
  };

  test('W7 the bin target and the main target, each imported by nothing and named alone, are HOLDS; the whole package is not', () => {
    assert.equal(wiring(base(entry, ['packages/p/src/bin.ts'])), 'aligned');
    assert.equal(wiring(base(entry, ['packages/p/src/index.ts'])), 'aligned');
    assert.equal(wiring(base(entry, ['packages/p'])), UNWIRED);
  });

  test('W8 a library module imported only by the entry file is HOLDS and one imported by nothing is Unknown(no-static-consumer)', () => {
    const files = {
      ...entry,
      'packages/p/src/bin.ts': "import { lib } from './lib.ts';\nexport const run = lib;\n",
      'packages/p/src/lib.ts': 'export const lib = 1;\n',
      'packages/p/src/orphan.ts': 'export const orphan = 1;\n',
    };
    assert.equal(wiring(base(files, ['packages/p/src/lib.ts'])), 'aligned');
    assert.equal(wiring(base(files, ['packages/p/src/orphan.ts'])), UNWIRED);
  });

  test('W9 a package whose every file is a test, and a row that names only a test file, are Unknown(non-extracted-anchor)', () => {
    const files = {
      'packages/p/src/a.test.ts': 'export const a = 1;\n',
      'packages/p/src/b.test.ts': 'export const b = 1;\n',
    };
    assert.equal(wiring(base(files, ['packages/p'])), 'Unknown:non-extracted-anchor');
    assert.equal(wiring(base(files, ['packages/p/src/a.test.ts'])), 'Unknown:non-extracted-anchor');
  });

  test('W10 the whole package of W7 when another package depends on it is cross-package-unobservable although it has a bin; its bin file named alone is still HOLDS', () => {
    const files = { ...entry, ...dependent };
    assert.equal(wiring(base(files, ['packages/p'])), 'Unknown:cross-package-unobservable');
    assert.equal(wiring(base(files, ['packages/p/src/bin.ts'])), 'aligned');
  });

  test('W11 a tracked .mjs script the run did not read does not change the class; its detail gives the size of U', () => {
    const files = base(
      {
        ...mod,
        'packages/p/src/guard.test.ts': "import { guard } from './guard.ts';\nguard();\n",
        'scripts/job.mjs': "import './x.mjs';\n",
      },
      [MOD],
    );
    const ran = run(files, { files: Object.keys(files).filter((p) => /\.ts$/.test(p)) });
    assert.equal(ran.find('control:C1')?.reason, 'no-static-consumer');
    assert.match(ran.find('control:C1')?.unknown?.detail ?? '', /1 tracked source file/);
  });
});

describe('module-wiring: unreadable manifests and unread code (4.4, 5.3)', () => {
  const unwired = {
    ...mod,
    'packages/p/src/guard.test.ts': "import { guard } from './guard.ts';\nguard();\n",
  };

  test('W15 an unparseable manifest anywhere turns no-static-consumer into manifest-unparseable; the same tree with a parsing dependent is cross-package; a consumer still HOLDS', () => {
    for (const broken of [
      {
        'packages/q/package.json':
          '<<<<<<< ours\n{ "name": "@fx/q", "dependencies": { "@fx/p": "workspace:*" } }\n=======\n{}\n>>>>>>> theirs\n',
      },
      { 'packages/other/package.json': '{ nope' },
      { 'package.json': '{ nope' },
    ]) {
      assert.equal(
        wiring(base({ ...unwired, ...broken }, [MOD])),
        'Unknown:manifest-unparseable',
        Object.keys(broken)[0] ?? '',
      );
    }
    const dependent = {
      'packages/q/package.json': JSON.stringify({
        name: '@fx/q',
        dependencies: { '@fx/p': 'workspace:*' },
      }),
      'packages/q/src/index.ts': 'export const x = 1;\n',
    };
    assert.equal(
      wiring(base({ ...unwired, ...dependent }, [MOD])),
      'Unknown:cross-package-unobservable',
    );
    assert.equal(
      wiring(
        base(
          {
            ...unwired,
            'packages/q/package.json': JSON.stringify({ name: '@fx/q' }),
            'packages/q/src/index.ts': 'export const x = 1;\n',
          },
          [MOD],
        ),
      ),
      UNWIRED,
    );
    const consumed = {
      ...mod,
      'packages/p/src/use.ts': "import { guard } from './guard.ts';\nexport const u = guard();\n",
      'packages/other/package.json': '{ nope',
    };
    assert.equal(wiring(base(consumed, [MOD])), 'aligned');
  });

  test('(a) a .mjs file named in a controls row that the run did not read is Unknown(non-extracted-anchor); (b) so is a TypeScript file outside every loaded project', () => {
    const files = base(
      {
        'scripts/gate.mjs': 'export {};\n',
        'package.json': JSON.stringify({
          name: 'fx',
          private: true,
          scripts: { gate: 'node scripts/gate.mjs' },
        }),
      },
      ['scripts/gate.mjs'],
    );
    assert.equal(wiring(files, { files: [] }), 'Unknown:non-extracted-anchor');
    const outside = base({ 'tools/outside.ts': 'export const o = 1;\n' }, ['tools/outside.ts']);
    assert.equal(wiring(outside, { files: [] }), 'Unknown:non-extracted-anchor');
  });

  test('(c) a row naming two paths, one with File nodes and an unwired module and one without, is non-extracted-anchor; HOLDS once the first is wired', () => {
    const two = base({ ...mod, 'scripts/gate.mjs': 'export {};\n' }, [MOD, 'scripts/gate.mjs']);
    const tracked = Object.keys(two).filter((p) => p.endsWith('.ts'));
    assert.equal(wiring(two, { files: tracked }), 'Unknown:non-extracted-anchor');
    const wired = {
      ...two,
      'packages/p/src/use.ts': "import { guard } from './guard.ts';\nexport const u = guard();\n",
    };
    assert.equal(
      wiring(wired, { files: Object.keys(wired).filter((p) => p.endsWith('.ts')) }),
      'aligned',
    );
  });

  test('(d) a row naming a whole package that has dependents is cross-package-unobservable', () => {
    const files = base(
      {
        ...mod,
        'packages/q/package.json': JSON.stringify({
          name: '@fx/q',
          dependencies: { '@fx/p': '1.0.0' },
        }),
      },
      ['packages/p'],
    );
    assert.equal(wiring(files), 'Unknown:cross-package-unobservable');
  });

  test('(e) a row with a cue and no existing path is Unknown(claim-unanchored), with proposals that the classifier never reads', () => {
    const files = base(
      {
        'packages/p/src/sandbox.ts':
          '/**\n * The capability manifest is enforced here, with a provenance ceiling.\n */\nexport const sandbox = 1;\n',
      },
      [],
    );
    files['README.md'] =
      '## Controls\n\n| # | Control | Where |\n| --- | --- | --- |\n| C1 | The capability manifest is enforced with a provenance ceiling. | host runtime |\n';
    const ran = run(files);
    assert.equal(ran.find('control:C1')?.reason, 'claim-unanchored');
    assert.deepEqual(
      ran.packet.proposals.map((p) => [p.id, p.candidate.canonicalName, p.provenance, p.basis]),
      [
        [
          'fx:align-proposal:CONTROL_ENFORCEMENT:control:C1:1',
          'packages/p/src/sandbox.ts',
          'INFERRED',
          'name-match',
        ],
      ],
    );
    const stripped = run(files);
    const without = { ...stripped.packet, proposals: [] };
    assert.deepEqual(without.findings, ran.packet.findings);
  });

  test('a failed code.ts is Unknown(scope-not-pass) for a control, never wired and never unwired', () => {
    const files = base(
      {
        ...mod,
        'packages/p/src/use.ts': "import { guard } from './guard.ts';\nexport const u = guard();\n",
      },
      [MOD],
    );
    const results = withResult(ALL_PASS, 'extract-code-ts', (r) => ({
      ...r,
      status: 'FAIL' as const,
      authoritative: [],
    }));
    assert.equal(wiring(files, { results }), 'Unknown:scope-not-pass');
  });

  test('a module-wiring result is never a gap: no control is ever an Unexplained gap or a Planned gap', () => {
    for (const files of [
      base(mod, [MOD]),
      base(mod, ['packages/p']),
      base({}, ['nowhere/at/all.ts']),
    ]) {
      const ran = run(files);
      assert.ok(
        !ran.findings.some(
          (f) =>
            f.claimKind === 'CONTROL_ENFORCEMENT' &&
            (f.class === 'Unexplained gap' ||
              f.class === 'Planned gap' ||
              f.class === 'Observed drift'),
        ),
      );
    }
  });
});

describe('module-wiring: the controls of THREATMODEL.md, frozen (12.2 f)', () => {
  const tree = (controls: string): Record<string, string> => ({
    'package.json': JSON.stringify({ name: 'seamline-monorepo', private: true }),
    'pnpm-workspace.yaml': WORKSPACE,
    'packages/core/package.json': JSON.stringify({ name: '@seamline/core' }),
    'packages/core/src/index.ts': 'export const core = 1;\n',
    'packages/cli/package.json': JSON.stringify({
      name: '@seamline/cli',
      bin: { seamline: './dist/bin.js' },
      dependencies: { '@seamline/core': 'workspace:*' },
    }),
    'packages/cli/src/bin.ts': 'export const bin = 1;\n',
    'packages/mcp/package.json': JSON.stringify({
      name: '@seamline/mcp',
      dependencies: { '@seamline/core': 'workspace:*' },
    }),
    'packages/mcp/src/index.ts': 'export const mcp = 1;\n',
    'scripts/license-gate.mjs': 'export {};\n',
    'THREATMODEL.md': controls,
  });

  for (const [label, controls] of [
    ['the pre-fix tree', THREATMODEL_CONTROLS_PREFIX],
    ['main', THREATMODEL_CONTROLS_MAIN],
  ] as const) {
    test(`at ${label}: exactly four control records, none of them drift, C4 with its reason`, () => {
      const files = tree(controls);
      const ran = run(files, { files: Object.keys(files).filter((p) => p.endsWith('.ts')) });
      const records = ran.findings
        .filter((f) => f.claimKind === 'CONTROL_ENFORCEMENT')
        .map((f) => `${f.subject}|${f.class}|${f.reason}`);
      assert.deepEqual(records, [
        'control:C3|Unknown|cross-package-unobservable',
        'control:C4|Unknown|claim-unanchored',
        'control:C8|Unknown|cross-package-unobservable',
        'control:C9|Unknown|non-extracted-anchor',
      ]);
    });
  }
});
