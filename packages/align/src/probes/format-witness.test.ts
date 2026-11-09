import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ALL_PASS, asBaseline, run, withResult, type RunOptions } from '../__fixtures__/build.ts';
import { wordsOf } from './format-witness.ts';

const CLAIM = 'Output is JSON, CSV, and Mermaid from the CLI.\n';
const render = (extra = ''): string =>
  `export function render(f: string): string {\n  switch (f) {\n    case 'csv':\n      return 'x';\n    default:\n      return f;\n  }\n}\n${extra}`;

/** The CLI package `@fx/cli` with an option spec, and the usual claim. `null` removes a file. */
function fx(over: Record<string, string | null> = {}): Record<string, string> {
  const files: Record<string, string | null> = {
    'package.json': JSON.stringify({ name: 'fx', private: true }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'packages/cli/package.json': JSON.stringify({ name: '@fx/cli', bin: { fx: './dist/bin.js' } }),
    'packages/cli/src/bin.ts': "export const OPTIONS = { json: { type: 'boolean' } };\n",
    'README.md': CLAIM,
    ...over,
  };
  return Object.fromEntries(
    Object.entries(files).filter((e): e is [string, string] => e[1] !== null),
  );
}

/** `HOLDS` when the format is witnessed (aligned), else `class:reason`. */
function fmt(files: Record<string, string>, format = 'csv', options: RunOptions = {}): string {
  const ran = run(files, options);
  const f = ran.findings.find(
    (x) => x.id.endsWith(`OUTPUT_FORMAT_SET:cli:output-format:${format}`) && x.class !== 'Resolved',
  );
  return f === undefined ? 'HOLDS' : `${f.class}:${f.reason}`;
}

const GAP = 'Unexplained gap:absent-in-implementation';
const cliWith = (bin: string, over: Record<string, string | null> = {}): Record<string, string> =>
  fx({ 'packages/cli/src/bin.ts': bin, ...over });

describe('format-witness: which tokens witness a format (4.2 step 4)', () => {
  const DO_NOT_FIRE: [string, string, Record<string, string | null>?][] = [
    [
      'A1 a list: includes()',
      "export const ok = (format: string): boolean => ['json', 'csv'].includes(format);\n",
    ],
    ['A2 a Set literal', "export const known = new Set(['json', 'csv']);\n"],
    ['A3 a message string', "export const message = 'csv output is not supported';\n"],
    ['A4 a call argument', "declare function pick(name: string): void;\npick('csv');\n"],
    [
      'A5 a string-literal type and an array',
      "export type Format = 'json' | 'csv';\nexport const all = ['csv', 'mermaid'];\n",
    ],
    [
      'A6 a comparison in a test file only',
      'export const x = 1;\n',
      {
        'packages/cli/src/bin.test.ts': "export const t = (format: string) => format === 'csv';\n",
      },
    ],
  ];
  for (const [name, bin, over] of DO_NOT_FIRE) {
    test(`${name} does not witness csv: Unexplained gap`, () => {
      assert.equal(fmt(cliWith(bin, over ?? {})), GAP);
    });
  }

  const FIRE: [string, string, string?][] = [
    ['B1 format === "csv"', "export const a = (format: string) => format === 'csv';\n"],
    ['B2 "csv" === format', "export const a = (format: string) => 'csv' === format;\n"],
    [
      'B3 format !== "mermaid"',
      "export const a = (format: string) => format !== 'mermaid';\n",
      'mermaid',
    ],
    ['B4 format == "csv"', "export const a = (format: string) => format == 'csv';\n"],
    ['B5 format != "csv"', "export const a = (format: string) => format != 'csv';\n"],
    [
      'B6 case "csv":',
      "export const a = (f: string) => { switch (f) { case 'csv': return 1; default: return 0; } };\n",
    ],
    ['B7 the identifier renderCsv', 'export const renderCsv = (): number => 1;\n'],
    ['B8 the property { csv: 1 }', 'export const table = { csv: 1 };\n'],
    [
      'B9 the quoted property { "mermaid": 1 }',
      "export const table = { 'mermaid': 1 };\n",
      'mermaid',
    ],
  ];
  for (const [name, bin, format] of FIRE) {
    test(`${name} witnesses the format: HOLDS`, () => {
      assert.equal(fmt(cliWith(bin), format ?? 'csv'), 'HOLDS');
    });
  }

  test('the parseArgs option shape witnesses json through its property name', () => {
    assert.equal(fmt(fx(), 'json'), 'HOLDS');
  });

  test('FW7 camel case: CSVWriter is the words csv and writer; a call argument is no witness', () => {
    assert.equal(
      fmt(
        cliWith(
          "class CSVWriter {}\ndeclare const reg: { set(k: string, v: unknown): void };\nreg.set('csv', new CSVWriter());\n",
        ),
      ),
      'HOLDS',
    );
    assert.equal(fmt(cliWith('class Csvwriter {}\n')), GAP);
    assert.equal(fmt(cliWith('declare function parseCSVs(): void;\nparseCSVs();\n')), GAP);
    assert.equal(fmt(cliWith('declare function parseCSV(): void;\nparseCSV();\n')), 'HOLDS');
    assert.equal(fmt(fx({ 'packages/cli/src/CSVWriter.ts': 'export {};\n' })), 'HOLDS');
  });

  test('word splitting follows 4.2 step 4', () => {
    assert.deepEqual(wordsOf('renderCsv'), ['render', 'csv']);
    assert.deepEqual(wordsOf('CSVWriter'), ['csv', 'writer']);
    assert.deepEqual(wordsOf('parseCSV'), ['parse', 'csv']);
    assert.deepEqual(wordsOf('CSVs'), ['cs', 'vs']);
    assert.deepEqual(wordsOf('some_name-with.dots/and/slashes2Go'), [
      'some',
      'name',
      'with',
      'dots',
      'and',
      'slashes2',
      'go',
    ]);
    assert.deepEqual(wordsOf('csv output'), ['csv output']);
  });
});

describe('format-witness: names (4.2 step 4)', () => {
  const FIRE: [string, Record<string, string | null>, string?][] = [
    ['N1 src/formats/csv.ts', { 'packages/cli/src/formats/csv.ts': 'export {};\n' }],
    ['N1b src/render-csv.ts', { 'packages/cli/src/render-csv.ts': 'export {};\n' }],
    ['N1c src/csv-renderer.cjs', { 'packages/cli/src/csv-renderer.cjs': 'module.exports = {};\n' }],
    ['N1c src/mermaid.jsx', { 'packages/cli/src/mermaid.jsx': 'export {};\n' }, 'mermaid'],
    [
      'N2 a directory src/mermaid/',
      { 'packages/cli/src/mermaid/index.ts': 'export {};\n' },
      'mermaid',
    ],
    ['N2b a template templates/csv.hbs', { 'packages/cli/templates/csv.hbs': '{{x}}' }],
    [
      'N3 a dependency csv-stringify',
      {
        'packages/cli/package.json': JSON.stringify({
          name: '@fx/cli',
          bin: { fx: './dist/bin.js' },
          dependencies: { 'csv-stringify': '^6.0.0' },
        }),
      },
    ],
    [
      'N3b @mermaid-js/mermaid-cli in devDependencies',
      {
        'packages/cli/package.json': JSON.stringify({
          name: '@fx/cli',
          bin: { fx: './dist/bin.js' },
          devDependencies: { '@mermaid-js/mermaid-cli': '^10.0.0' },
        }),
      },
      'mermaid',
    ],
  ];
  for (const [name, over, format] of FIRE) {
    test(`${name} is a name witness: HOLDS`, () => {
      assert.equal(fmt(fx(over), format ?? 'csv'), 'HOLDS');
    });
  }

  const DO_NOT_FIRE: [string, Record<string, string | null>][] = [
    ['N4 a test file csv.test.ts', { 'packages/cli/src/csv.test.ts': 'export {};\n' }],
    ['N4 a __fixtures__/csv/ directory', { 'packages/cli/src/__fixtures__/csv/data.txt': 'x' }],
    ['N5 a data file sample.csv', { 'packages/cli/data/sample.csv': 'a,b\n' }],
    [
      'N6 csv.ts in a package outside the scan set',
      {
        'packages/other/package.json': JSON.stringify({ name: '@fx/other' }),
        'packages/other/src/csv.ts': 'export {};\n',
      },
    ],
  ];
  for (const [name, over] of DO_NOT_FIRE) {
    test(`${name} is not a witness: Unexplained gap`, () => {
      assert.equal(fmt(fx(over)), GAP);
    });
  }

  test('H1 the detail of a HOLDS begins "token" or "name" and names the first supplier; the weakest witness can resolve a gap (fact-changed)', () => {
    const baseline = asBaseline(run(fx()));
    const stub = run(fx({ 'packages/cli/src/formats/csv.ts': 'export {};\n' }), { baseline });
    const resolved = stub.findings.find(
      (f) => f.id.endsWith('output-format:csv') && f.class === 'Resolved',
    );
    assert.equal(resolved?.resolved?.by, 'fact-changed');
    assert.match(resolved?.fact?.detail ?? '', /^name packages\/cli\/src\/formats\/csv\.ts/);
    const dep = run(
      fx({
        'packages/cli/package.json': JSON.stringify({
          name: '@fx/cli',
          bin: { fx: './dist/bin.js' },
          dependencies: { 'csv-stringify': '^6' },
        }),
      }),
      { baseline },
    );
    assert.match(
      dep.findings.find((f) => f.id.endsWith('output-format:csv') && f.class === 'Resolved')?.fact
        ?.detail ?? '',
      /^name dependency csv-stringify/,
    );
    const token = run(cliWith("export const a = (f: string) => f === 'csv';\n"), { baseline });
    assert.match(
      token.findings.find((f) => f.id.endsWith('output-format:csv') && f.class === 'Resolved')?.fact
        ?.detail ?? '',
      /^token packages\/cli\/src\/bin\.ts/,
    );
  });
});

describe('format-witness: the closure (4.2 step 3)', () => {
  const lib = {
    'packages/render/package.json': JSON.stringify({ name: '@fx/render' }),
    'packages/render/src/index.ts': render(),
  };
  const cli = (deps: Record<string, unknown>): Record<string, string> =>
    fx({
      ...lib,
      'packages/cli/package.json': JSON.stringify({
        name: '@fx/cli',
        bin: { fx: './dist/bin.js' },
        ...deps,
      }),
      'packages/cli/src/bin.ts':
        "import { render } from '@fx/render';\n\nexport const OPTIONS = { json: { type: 'boolean' } };\nexport const out = render('x');\n",
    });

  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    test(`DV ${section} follows the CLI into a workspace library: csv HOLDS, mermaid is a gap`, () => {
      const files = cli({ [section]: { '@fx/render': 'workspace:*' } });
      assert.equal(fmt(files, 'csv'), 'HOLDS');
      assert.equal(fmt(files, 'mermaid'), GAP);
    });
  }

  test('DV4 neither listed nor imported: csv is an Unexplained gap', () => {
    assert.equal(fmt(fx(lib)), GAP);
  });

  test('DV5 the closure is transitive through devDependencies', () => {
    const files = fx({
      ...lib,
      'packages/codec/package.json': JSON.stringify({
        name: '@fx/codec',
        devDependencies: { '@fx/render': 'workspace:*' },
      }),
      'packages/codec/src/index.ts': 'export const codec = 1;\n',
      'packages/cli/package.json': JSON.stringify({
        name: '@fx/cli',
        bin: { fx: './dist/bin.js' },
        devDependencies: { '@fx/codec': 'workspace:*' },
      }),
    });
    assert.equal(fmt(files), 'HOLDS');
  });

  test('FW5 a pnpm alias is followed to the package it names; FW5d a workspace path names a discovered directory', () => {
    assert.equal(fmt(cli({ dependencies: { 'render-lib': 'workspace:@fx/render@*' } })), 'HOLDS');
    assert.equal(
      fmt(
        fx({
          ...lib,
          'packages/cli/package.json': JSON.stringify({
            name: '@fx/cli',
            bin: { fx: './dist/bin.js' },
            dependencies: { renderer: 'workspace:../render' },
          }),
        }),
      ),
      'HOLDS',
    );
    assert.equal(fmt(cli({ dependencies: { '@fx/render': 'workspace:*' } })), 'HOLDS');
  });

  test('FW2b a link: path naming a discovered package is followed', () => {
    const files = fx({
      ...lib,
      'packages/cli/package.json': JSON.stringify({
        name: '@fx/cli',
        bin: { fx: './dist/bin.js' },
        dependencies: { renderer: 'link:../render' },
      }),
    });
    assert.equal(fmt(files), 'HOLDS');
  });

  const UNRESOLVED: [string, Record<string, unknown>][] = [
    [
      'FW2 link: to a package outside the workspace entries',
      { dependencies: { '@fx/render': 'link:../../tools/render' } },
    ],
    ['FW2c file: to a tarball', { dependencies: { '@fx/render': 'file:vendor/render.tgz' } }],
    [
      'FW2d portal: in devDependencies',
      { devDependencies: { '@fx/render': 'portal:../../tools/render' } },
    ],
    [
      'FW5b an alias to a package that is not discovered',
      { dependencies: { 'render-lib': 'workspace:@fx/gone@*' } },
    ],
    ['FW5c workspace:* with no such package', { dependencies: { '@fx/missing': 'workspace:*' } }],
  ];
  for (const [name, deps] of UNRESOLVED) {
    test(`${name}: an unwitnessed format is Unknown(source-unreadable)`, () => {
      const files = cli({ dependencies: { '@fx/render': 'workspace:*' }, ...deps });
      assert.equal(fmt(files, 'mermaid'), 'Unknown:source-unreadable');
    });
  }

  test('FW3 a manifest with bin outside the workspace entries may be the CLI the document describes', () => {
    const stray = {
      'tools/cli/package.json': JSON.stringify({ name: 'cli-tool', bin: { t: './x.js' } }),
    };
    assert.equal(fmt(fx(stray), 'csv'), 'Unknown:source-unreadable');
    assert.equal(
      fmt(fx({ ...stray, 'tools/cli/package.json': JSON.stringify({ name: 'cli-tool' }) }), 'csv'),
      GAP,
    );
    assert.equal(
      fmt(
        fx({
          'tools/cli/__fixtures__/package.json': JSON.stringify({
            name: 'f',
            bin: { t: './x.js' },
          }),
        }),
        'csv',
      ),
      GAP,
    );
  });

  test('FW3e no discovered package has bin and a stray manifest has: source-unreadable, not no-source-roots', () => {
    const files = fx({
      'packages/cli/package.json': JSON.stringify({ name: '@fx/cli' }),
      'tools/cli/package.json': JSON.stringify({ name: 'cli-tool', bin: 'x.js' }),
    });
    assert.equal(fmt(files), 'Unknown:source-unreadable');
  });

  test('FW3d a tracked manifest outside every discovery that does not parse is Unknown(manifest-unparseable)', () => {
    assert.equal(fmt(fx({ 'tools/cli/package.json': '{ nope' })), 'Unknown:manifest-unparseable');
  });
});

describe('format-witness: leaving the scan set (4.2 step 5)', () => {
  const LEAVES: [string, string][] = [
    ['L1 export ... from a path outside the package', "export * from '../../shared/render.ts';\n"],
    [
      'L1b import() of a path outside the package',
      "export const lazy = () => import('../../shared/render.ts');\n",
    ],
    [
      'L1c require() of a path outside the package',
      "declare const require: (s: string) => unknown;\nexport const r = require('../../shared/render.cjs');\n",
    ],
  ];
  for (const [name, bin] of LEAVES) {
    test(`${name}: an unwitnessed format is Unknown(source-unreadable) and a witnessed one stays HOLDS (L1d)`, () => {
      const files = cliWith(`${bin}export const OPTIONS = { json: { type: 'boolean' } };\n`);
      assert.equal(fmt(files, 'csv'), 'Unknown:source-unreadable');
      assert.equal(fmt(files, 'json'), 'HOLDS');
    });
  }

  test('L2 an import of a workspace package the manifest does not list; L2b the instrument, L2c node: and external packages do not fire', () => {
    const render = {
      'packages/render/package.json': JSON.stringify({ name: '@fx/render' }),
      'packages/render/src/index.ts': 'export const r = 1;\n',
    };
    assert.equal(
      fmt(
        fx({
          ...render,
          'packages/cli/src/bin.ts': "import { r } from '@fx/render';\nexport const x = r;\n",
        }),
      ),
      'Unknown:source-unreadable',
    );
    const align = {
      'packages/align/package.json': JSON.stringify({ name: '@seamline/align' }),
      'packages/align/src/index.ts': "export const formats = ['csv', 'mermaid'];\n",
    };
    assert.equal(
      fmt(
        fx({
          ...align,
          'packages/cli/src/bin.ts':
            "import { formats } from '@seamline/align';\nexport const x = formats;\n",
        }),
      ),
      GAP,
    );
    assert.equal(
      fmt(
        fx({
          'packages/cli/src/bin.ts':
            "import { readFileSync } from 'node:fs';\nimport _ from 'lodash';\nexport const x = [readFileSync, _];\n",
        }),
      ),
      GAP,
    );
  });

  test('L0 a relative import that stays inside the package does not fire', () => {
    assert.equal(
      fmt(
        fx({
          'packages/cli/src/bin.ts': "import { u } from './util.ts';\nexport const x = u;\n",
          'packages/cli/src/util.ts': 'export const u = 1;\n',
        }),
      ),
      GAP,
    );
  });

  const withPaths = { compilerOptions: { paths: { '@x/*': ['./x/*'] } } };
  test('L3 a root tsconfig.base.json that declares paths; L3b a package tsconfig.json; L3c one without paths does not fire', () => {
    assert.equal(
      fmt(fx({ 'tsconfig.base.json': JSON.stringify(withPaths) })),
      'Unknown:source-unreadable',
    );
    assert.equal(
      fmt(fx({ 'packages/cli/tsconfig.json': JSON.stringify(withPaths) })),
      'Unknown:source-unreadable',
    );
    assert.equal(
      fmt(fx({ 'tsconfig.base.json': JSON.stringify({ compilerOptions: { strict: true } }) })),
      GAP,
    );
  });

  test('12.4 item 7: an unparseable tsconfig is one that may declare paths: Unknown(source-unreadable), never a gap', () => {
    assert.equal(
      fmt(fx({ 'packages/cli/tsconfig.json': '{ "compilerOptions": { "paths": ' })),
      'Unknown:source-unreadable',
    );
    assert.equal(
      fmt(fx({ 'tsconfig.base.json': '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n' })),
      'Unknown:source-unreadable',
    );
    assert.equal(fmt(fx({ 'packages/cli/tsconfig.json': '{ "compilerOptions": {} }' })), GAP);
  });

  test('FW4 paths reached through a relative extends, one or two steps; a base without paths and an installed package do not fire', () => {
    const cliCfg = (extendsPath: string): Record<string, string> => ({
      'packages/cli/tsconfig.json': JSON.stringify({ extends: extendsPath }),
    });
    assert.equal(
      fmt(
        fx({
          ...cliCfg('../../config/tsconfig.base.json'),
          'config/tsconfig.base.json': JSON.stringify(withPaths),
        }),
      ),
      'Unknown:source-unreadable',
    );
    assert.equal(
      fmt(
        fx({
          ...cliCfg('../../config/mid'),
          'config/mid.json': JSON.stringify({ extends: './tsconfig.base.json' }),
          'config/tsconfig.base.json': JSON.stringify(withPaths),
        }),
      ),
      'Unknown:source-unreadable',
    );
    assert.equal(
      fmt(
        fx({
          ...cliCfg('../../config/tsconfig.base.json'),
          'config/tsconfig.base.json': JSON.stringify({ compilerOptions: {} }),
        }),
      ),
      GAP,
    );
    assert.equal(fmt(fx({ ...cliCfg('@tsconfig/node22/tsconfig.json') })), GAP);
    assert.equal(fmt(fx({ ...cliCfg('../../config/missing.json') })), 'Unknown:source-unreadable');
  });

  test('a tsconfig with comments and trailing commas is read', () => {
    assert.equal(
      fmt(
        fx({
          'tsconfig.base.json':
            '{\n  // strict\n  "compilerOptions": { "paths": { "@x/*": ["x"], }, },\n}\n',
        }),
      ),
      'Unknown:source-unreadable',
    );
  });
});

describe('format-witness: parse failure, other languages, bounds, discovery (4.2 step 5, 5.3)', () => {
  test('P1 a syntax error in a scan-set source file with no witness is Unknown(source-unreadable); P1b a witnessed format stays HOLDS; P1c a test file only does not fire', () => {
    const broken = cliWith("export const a = (f: string) => f === 'csv';\n", {
      'packages/cli/src/broken.ts': 'export const = ;\n',
    });
    assert.equal(fmt(broken, 'csv'), 'HOLDS');
    assert.equal(fmt(broken, 'mermaid'), 'Unknown:source-unreadable');
    assert.equal(fmt(fx({ 'packages/cli/src/broken.test.ts': 'export const = ;\n' })), GAP);
  });

  test('D1 a .go file, D2 a shell bin, D3 one native target of a bin map each make an unwitnessed format Unknown(source-unreadable)', () => {
    assert.equal(
      fmt(fx({ 'packages/cli/src/native.go': 'package main\n' }), 'csv'),
      'Unknown:source-unreadable',
    );
    assert.equal(
      fmt(
        fx({
          'packages/cli/package.json': JSON.stringify({
            name: '@fx/cli',
            bin: { fx: './bin/fx.sh' },
          }),
        }),
        'csv',
      ),
      'Unknown:source-unreadable',
    );
    assert.equal(
      fmt(
        fx({
          'packages/cli/package.json': JSON.stringify({
            name: '@fx/cli',
            bin: { fx: './dist/bin.js', y: './bin/y' },
          }),
        }),
        'csv',
      ),
      'Unknown:source-unreadable',
    );
  });

  test('D4 bin targets that are JavaScript, and D6 a .go file outside the scan set, are an Unexplained gap; D5 a witnessed format stays HOLDS beside the .go file', () => {
    assert.equal(
      fmt(
        fx({
          'packages/cli/package.json': JSON.stringify({
            name: '@fx/cli',
            bin: { fx: './dist/bin.js', y: './dist/y.mjs' },
          }),
          'packages/cli/src/y.mjs': 'export const noop = true;\n',
        }),
      ),
      GAP,
    );
    assert.equal(
      fmt(
        fx({
          'packages/other/package.json': JSON.stringify({ name: '@fx/other' }),
          'packages/other/src/x.go': 'package x\n',
        }),
      ),
      GAP,
    );
    const files = cliWith("export const a = (f: string) => f === 'csv';\n", {
      'packages/cli/src/native.go': 'package main\n',
    });
    assert.equal(fmt(files, 'csv'), 'HOLDS');
    assert.equal(fmt(files, 'mermaid'), 'Unknown:source-unreadable');
  });

  test('W12 a package scanned wherever its source sits: lib/, .cjs, .jsx', () => {
    for (const path of [
      'packages/cli/lib/render.ts',
      'packages/cli/src/render.cjs',
      'packages/cli/src/render.jsx',
    ]) {
      assert.equal(fmt(fx({ [path]: 'const renderCsv = 1;\n' })), 'HOLDS', path);
    }
  });

  test('W13 a source file over the size bound with no witness is Unknown(limit-exceeded); a format witnessed elsewhere is HOLDS', () => {
    const files = cliWith("export const a = (f: string) => f === 'csv';\n", {
      'packages/cli/src/big.ts': `export const big = '${'x'.repeat(300)}';\n`,
    });
    const options = { limits: { maxSourceBytes: 200 } };
    assert.equal(fmt(files, 'mermaid', options), 'Unknown:limit-exceeded');
    assert.equal(fmt(files, 'csv', options), 'HOLDS');
  });

  test('more source files than the bound is Unknown(limit-exceeded)', () => {
    const files = fx({
      'packages/cli/src/a.ts': 'export const a = 1;\n',
      'packages/cli/src/b.ts': 'export const b = 1;\n',
    });
    assert.equal(fmt(files, 'csv', { limits: { maxSourceFiles: 2 } }), 'Unknown:limit-exceeded');
  });

  test('W14 a discovered package whose package.json does not parse is Unknown(manifest-unparseable) for an unwitnessed format', () => {
    assert.equal(
      fmt(fx({ 'packages/broken/package.json': '{ nope' })),
      'Unknown:manifest-unparseable',
    );
    assert.equal(
      fmt(
        fx({
          'packages/broken/package.json': '{ nope',
          'packages/cli/src/bin.ts': 'export const OPTIONS = { json: 1, csv: 1 };\n',
        }),
        'csv',
      ),
      'HOLDS',
    );
  });

  const UNSUPPORTED: [string, string][] = [
    ['a double star', "packages:\n  - 'packages/*'\n  - 'tools/**'\n"],
    ['a negation', "packages:\n  - 'packages/*'\n  - '!packages/legacy'\n"],
    ['a brace set', "packages:\n  - 'packages/*'\n  - 'apps/{web,api}'\n"],
    ['a trailing comment', 'packages:\n  - packages/*\n  - tools/* # internal\n'],
    ['a segment that mixes * with text', "packages:\n  - 'packages/*'\n  - 'tools/x-*'\n"],
    ['a merge-conflict marker', "packages:\n  - 'packages/*'\n<<<<<<< ours\n  - 'x'\n"],
  ];
  for (const [name, workspace] of UNSUPPORTED) {
    test(`W14b ${name} leaves package discovery incomplete: an unwitnessed format is manifest-unparseable, never ABSENT, and a witnessed one stays HOLDS`, () => {
      assert.equal(
        fmt(fx({ 'pnpm-workspace.yaml': workspace }), 'mermaid'),
        'Unknown:manifest-unparseable',
      );
      assert.equal(fmt(fx({ 'pnpm-workspace.yaml': workspace }), 'json'), 'HOLDS');
    });
  }

  const NOTHING_DISCOVERED: [string, string][] = [
    ['a flow-style sequence', "packages: ['packages/*']\n"],
    ['a tab-indented entry', "packages:\n\t- 'packages/*'\n"],
    ['a lone packages/**', "packages:\n  - 'packages/**'\n"],
  ];
  for (const [name, workspace] of NOTHING_DISCOVERED) {
    test(`W14b ${name} leaves no package discovered: every format is manifest-unparseable, not no-source-roots and not source-unreadable`, () => {
      for (const format of ['csv', 'mermaid', 'json']) {
        assert.equal(
          fmt(fx({ 'pnpm-workspace.yaml': workspace }), format),
          'Unknown:manifest-unparseable',
          format,
        );
      }
    });
  }

  test('W14b the supported forms read as complete: quotes, comments, other top-level keys, a root workspaces array', () => {
    for (const workspace of [
      "packages:\n  - 'packages/*'\n",
      'packages:\n  - "packages/*"\n',
      'packages:\n  - packages/*\n',
      "# a comment\npackages:\n  # another\n  - 'packages/*'\nallowBuilds:\n  esbuild: set this to true or false\n\nonlyBuiltDependencies:\n  - esbuild\n",
      "packages:\n- 'packages/*'\n",
    ]) {
      assert.equal(fmt(fx({ 'pnpm-workspace.yaml': workspace })), GAP, workspace);
    }
    assert.equal(
      fmt(
        fx({
          'pnpm-workspace.yaml': null,
          'package.json': JSON.stringify({ name: 'fx', workspaces: ['packages/*'] }),
        }),
      ),
      GAP,
    );
    assert.equal(
      fmt(
        fx({
          'pnpm-workspace.yaml': null,
          'package.json': JSON.stringify({ name: 'fx', workspaces: { packages: ['packages/*'] } }),
        }),
      ),
      'Unknown:manifest-unparseable',
    );
  });

  test('a repository whose packages have no bin is Unknown(no-source-roots) for every format, never ABSENT', () => {
    const files = fx({ 'packages/cli/package.json': JSON.stringify({ name: '@fx/cli' }) });
    for (const format of ['csv', 'mermaid', 'json'])
      assert.equal(fmt(files, format), 'Unknown:no-source-roots', format);
  });

  test('the instrument is excluded: a lexicon-carrying @seamline/align in the closure still reports ABSENT for a format nobody else mentions', () => {
    const files = fx({
      'packages/align/package.json': JSON.stringify({ name: '@seamline/align' }),
      'packages/align/src/index.ts':
        "export const formats = { csv: 1, mermaid: 1 };\nexport const isCsv = (f: string) => f === 'csv';\n",
      'packages/cli/package.json': JSON.stringify({
        name: '@fx/cli',
        bin: { fx: './dist/bin.js' },
        dependencies: { '@seamline/align': 'workspace:*' },
      }),
    });
    assert.equal(fmt(files, 'csv'), GAP);
    const packet = run(files).packet;
    const probe = packet.inputs.probes.find((p) => p.probe === 'format-witness');
    assert.ok(probe?.diagnostics.some((d) => d.includes('@seamline/align')));
  });

  test('a failed code.ts makes every format finding Unknown(scope-not-pass)', () => {
    const failed = {
      results: withResult(ALL_PASS, 'extract-code-ts', (r) => ({
        ...r,
        status: 'FAIL' as const,
        authoritative: [],
      })),
    };
    for (const format of ['csv', 'mermaid', 'json'])
      assert.equal(fmt(fx(), format, failed), 'Unknown:scope-not-pass', format);
  });

  test('no TypeScript parser is Unknown(probe-failed), never absence', () => {
    assert.equal(fmt(fx(), 'csv', { ts: null }), 'Unknown:probe-failed');
  });
});
