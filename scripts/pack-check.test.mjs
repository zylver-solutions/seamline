#!/usr/bin/env node
/**
 * Tests for scripts/pack-check.mjs and the release workflow's artifact verification.
 *
 * The gate's job is to fail when a tarball would be wrong and to stay green when
 * it is right. Both halves are asserted as outcomes:
 *
 *  - the real workspace, packed with the real `pnpm pack`, is clean and covers
 *    exactly the reviewed publishable packages (and never `@seamline/integration`);
 *  - every violation class is shown firing on a deliberately broken package, next
 *    to an unbroken control that stays clean, so a check that always passes (or
 *    always fails) cannot satisfy these tests;
 *  - the same violations are shown end to end: a throwaway workspace is packed
 *    with the real tool and the real CLI exits 1 on it.
 *
 * Needs built output (`pnpm build`): a missing `dist/` is a failure here, not a skip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  ALLOWED_TOP_LEVEL,
  DATA_DIRECTORIES,
  INTERNAL_PACKAGES,
  PUBLIC_ENTRY_POINTS,
  REPO_ROOT,
  checkPackage,
  checkPrivatePackage,
  checkWorkspace,
  readTarball,
  workspaceDirs,
} from './pack-check.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'pack-check.mjs');
const NODE_RANGE = '>=22.13.0';
const ROOT_NOTICE = Buffer.from('Seamline\nCopyright\n');
const ROOT_REPO_URL = 'git+https://example.test/seamline.git';
const REL_DIR = 'packages/ontology';

// ---------------------------------------------------------------------------
// Synthetic packages for the pure checker
// ---------------------------------------------------------------------------

const file = (text = '', extra = {}) => ({ content: Buffer.from(text), ...extra });

function cleanManifest() {
  return {
    name: '@seamline/ontology',
    version: '0.0.1',
    type: 'module',
    license: 'Apache-2.0',
    engines: { node: NODE_RANGE },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    publishConfig: { access: 'public' },
    description: 'A package.',
    repository: { type: 'git', url: ROOT_REPO_URL, directory: REL_DIR },
    homepage: 'https://example.test/seamline/tree/main/packages/ontology#readme',
    bugs: { url: 'https://example.test/seamline/issues' },
    dependencies: {},
  };
}

function cleanFiles() {
  return new Map([
    ['package.json', file('{}')],
    ['README.md', file('# readme')],
    ['LICENSE', file('license')],
    ['NOTICE', file(ROOT_NOTICE)],
    ['dist/index.js', file("export * from './contract.js';\n")],
    ['dist/index.d.ts', file("export * from './contract.ts';\n")],
    ['dist/contract.js', file('export const a = 1;\n')],
    ['dist/contract.d.ts', file('export declare const a = 1;\n')],
  ]);
}

/** Runs the checker on a clean package after `mutate(manifest, files)` and returns the codes. */
function codesAfter(mutate = () => {}, { privateNames = new Set() } = {}) {
  const manifest = cleanManifest();
  const files = cleanFiles();
  mutate(manifest, files);
  return checkPackage({
    manifest,
    packed: manifest,
    files,
    expectedNode: NODE_RANGE,
    rootNotice: ROOT_NOTICE,
    rootRepositoryUrl: ROOT_REPO_URL,
    relDir: REL_DIR,
    privateNames,
  })
    .map((v) => v.code)
    .sort();
}

test('control: an unbroken synthetic package has no violations', () => {
  assert.deepEqual(codesAfter(), []);
});

test('a fake exports target that is not in the tarball is reported', () => {
  assert.deepEqual(
    codesAfter((m) => {
      m.exports['.'].default = './dist/does-not-exist.js';
    }),
    ['ENTRY_MISSING'],
  );
});

test('main, types and bin targets must exist, and a bin must start with a shebang', () => {
  assert.deepEqual(
    codesAfter((m) => {
      m.main = './dist/gone.js';
    }),
    ['ENTRY_MISSING'],
  );
  assert.deepEqual(
    codesAfter((m) => {
      m.types = './dist/gone.d.ts';
    }),
    ['ENTRY_MISSING'],
  );
  assert.deepEqual(
    codesAfter((m) => {
      m.bin = { seamline: './dist/bin.js' };
    }),
    ['ENTRY_MISSING'],
  );
  assert.deepEqual(
    codesAfter((m, files) => {
      m.bin = { seamline: './dist/bin.js' };
      files.set('dist/bin.js', file('console.log(1);\n'));
    }),
    ['BIN_NO_SHEBANG'],
  );
  assert.deepEqual(
    codesAfter((m, files) => {
      m.bin = { seamline: './dist/bin.js' };
      files.set('dist/bin.js', file('#!/usr/bin/env node\nconsole.log(1);\n'));
    }),
    [],
  );
});

test('test files, fixtures, source maps, TypeScript source and src/ are each forbidden', () => {
  const cases = {
    'dist/a.test.js': 'test file',
    'dist/a.test.d.ts': 'test file',
    'dist/__fixtures__/p.js': 'fixture',
    'dist/fixtures/p.js': 'fixture',
    'dist/a.js.map': 'source map',
    'dist/a.d.ts.map': 'source map',
    'dist/a.ts': 'TypeScript source',
    'dist/tsconfig.tsbuildinfo': 'TypeScript build info',
    'dist/data.json': 'dist holds only',
  };
  for (const [path, why] of Object.entries(cases)) {
    const manifest = cleanManifest();
    const files = cleanFiles();
    files.set(path, file('x'));
    const found = checkPackage({
      manifest,
      packed: manifest,
      files,
      expectedNode: NODE_RANGE,
      rootNotice: ROOT_NOTICE,
      rootRepositoryUrl: ROOT_REPO_URL,
      relDir: REL_DIR,
      privateNames: new Set(),
    });
    assert.deepEqual(
      found.map((v) => v.code),
      ['FORBIDDEN_FILE'],
      path,
    );
    assert.match(found[0].message, new RegExp(why), path);
  }
  assert.deepEqual(
    codesAfter((_m, files) => files.set('src/index.ts', file('x'))),
    ['UNEXPECTED_TOP_LEVEL'],
    'src/ is not an allowed top-level entry',
  );
});

test('test-support modules are forbidden even though their names are not *.test.*', () => {
  for (const path of [
    'dist/testing.js',
    'dist/store/testing.d.ts',
    'dist/fixtures.js',
    'dist/graph-memory.js',
    'dist/test-graph.js',
    'dist/test-harness.d.ts',
    'dist/sif/test-fixtures.js',
  ]) {
    assert.deepEqual(
      codesAfter((_m, files) => files.set(path, file('export {};\n'))),
      ['FORBIDDEN_FILE'],
      path,
    );
  }
  // Names that merely contain the letters are fine.
  for (const path of ['dist/contest.js', 'dist/latest.js', 'dist/detectors/x1-nullability.js']) {
    assert.deepEqual(
      codesAfter((_m, files) => files.set(path, file('export {};\n'))),
      [],
      path,
    );
  }
});

test('a shipped module that imports a file the tarball leaves out is reported', () => {
  assert.deepEqual(
    codesAfter((_m, files) =>
      files.set(
        'dist/index.js',
        file("export * from './contract.js';\nexport * from './testing.js';\n"),
      ),
    ),
    ['DANGLING_IMPORT'],
  );
  assert.deepEqual(
    codesAfter((_m, files) =>
      files.set('dist/index.d.ts', file("import type { T } from './nope.ts';\n")),
    ),
    ['DANGLING_IMPORT'],
  );
  assert.deepEqual(
    codesAfter((_m, files) =>
      files.set(
        'dist/index.js',
        file("export * from './contract.js';\nconst m = await import('./nope.js');\n"),
      ),
    ),
    ['DANGLING_IMPORT'],
  );
  // The same text inside a comment is not an import.
  assert.deepEqual(
    codesAfter((_m, files) =>
      files.set(
        'dist/index.js',
        file(
          "/**\n * import { x } from './nope.js';\n */\n// from './nope.js'\nexport * from './contract.js';\n",
        ),
      ),
    ),
    [],
  );
});

test('engines.node must be present and equal to the root range', () => {
  assert.deepEqual(
    codesAfter((m) => {
      delete m.engines;
    }),
    ['ENGINES_MISSING'],
  );
  assert.deepEqual(
    codesAfter((m) => {
      m.engines = { node: '>=18' };
    }),
    ['ENGINES_MISMATCH'],
  );
});

test('license must be Apache-2.0, and LICENSE and README.md must be in the tarball', () => {
  assert.deepEqual(
    codesAfter((m) => {
      m.license = 'MIT';
    }),
    ['LICENSE_FIELD'],
  );
  assert.deepEqual(
    codesAfter((_m, files) => files.delete('LICENSE')),
    ['LICENSE_MISSING'],
  );
  assert.deepEqual(
    codesAfter((_m, files) => files.delete('README.md')),
    ['README_MISSING'],
  );
});

test('NOTICE must be in the tarball and byte-equal to the root NOTICE', () => {
  assert.deepEqual(
    codesAfter((_m, files) => files.delete('NOTICE')),
    ['NOTICE_MISSING'],
  );
  assert.deepEqual(
    codesAfter((_m, files) => files.set('NOTICE', file('Seamline\nCopyright 2020\n'))),
    ['NOTICE_DRIFT'],
    'an edited copy',
  );
  assert.deepEqual(
    codesAfter((_m, files) => files.set('NOTICE', file(`${ROOT_NOTICE.toString()}\n`))),
    ['NOTICE_DRIFT'],
    'one trailing byte is drift',
  );
});

test('exports lists exactly the reviewed entry points', () => {
  assert.deepEqual(
    codesAfter((m, files) => {
      m.exports['./internal'] = { types: './dist/contract.d.ts', default: './dist/contract.js' };
      assert.ok(files.has('dist/contract.js'));
    }),
    ['EXPORTS_UNREVIEWED'],
    'a reachable but unreviewed subpath',
  );
  assert.deepEqual(
    codesAfter((m) => {
      m.exports['./*'] = './dist/*.js';
    }),
    ['ENTRY_MISSING', 'EXPORTS_PATTERN', 'EXPORTS_UNREVIEWED'],
    'a wildcard subpath',
  );
  assert.deepEqual(
    codesAfter((m) => {
      m.exports = {};
    }),
    ['EXPORTS_REMOVED'],
    'a reviewed entry point dropped',
  );
  assert.deepEqual(
    codesAfter((m) => {
      delete m.exports;
    }),
    ['EXPORTS_MISSING'],
  );
  assert.deepEqual(
    codesAfter((m) => {
      m.exports['.'] = { default: './dist/index.js', types: './dist/index.d.ts' };
    }),
    ['TYPES_NOT_FIRST'],
  );
  assert.deepEqual(
    codesAfter((m) => {
      m.exports['.'].default = '../outside.js';
    }),
    ['EXPORT_TARGET_INVALID'],
  );
});

test('a package missing from the reviewed table is reported as unreviewed', () => {
  assert.deepEqual(
    codesAfter((m) => {
      m.name = '@seamline/brand-new';
    }),
    ['UNREVIEWED_PACKAGE'],
  );
});

test('workspace: specifiers and private dependencies must not reach the registry', () => {
  const manifest = cleanManifest();
  manifest.dependencies = { '@seamline/integration': 'workspace:*' };
  const packed = { ...manifest, dependencies: { '@seamline/integration': 'workspace:*' } };
  const codes = checkPackage({
    manifest,
    packed,
    files: cleanFiles(),
    expectedNode: NODE_RANGE,
    rootNotice: ROOT_NOTICE,
    rootRepositoryUrl: ROOT_REPO_URL,
    relDir: REL_DIR,
    privateNames: new Set(['@seamline/integration']),
  })
    .map((v) => v.code)
    .sort();
  // Nothing shipped imports it either, which the unused-dependency check reports too.
  assert.deepEqual(codes, ['PRIVATE_DEPENDENCY', 'UNUSED_DEPENDENCY', 'WORKSPACE_PROTOCOL']);
});

test('publishConfig.access must be public', () => {
  assert.deepEqual(
    codesAfter((m) => {
      delete m.publishConfig;
    }),
    ['ACCESS_NOT_PUBLIC'],
  );
});

test('only the documented top-level entries are allowed', () => {
  assert.deepEqual([...ALLOWED_TOP_LEVEL].sort(), [
    'LICENSE',
    'NOTICE',
    'README.md',
    'dist',
    'package.json',
  ]);
  assert.deepEqual(
    codesAfter((_m, files) => files.set('.env', file('SECRET=1'))),
    ['UNEXPECTED_TOP_LEVEL'],
  );
});

test('a data directory is allowed only for the package named in DATA_DIRECTORIES, and holds only json', () => {
  assert.deepEqual(DATA_DIRECTORIES, { '@seamline/security': ['corpus'] });
  const securityPackage = (mutate = () => {}) => {
    const manifest = cleanManifest();
    manifest.name = '@seamline/security';
    manifest.homepage = 'https://example.test/seamline/tree/main/packages/security#readme';
    manifest.repository.directory = 'packages/security';
    manifest.exports = {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './corpus': { types: './dist/corpus.d.ts', default: './dist/corpus.js' },
      './corpus/secrets.json': './corpus/secrets.json',
      './corpus/injections.json': './corpus/injections.json',
    };
    const files = cleanFiles();
    files.set('dist/corpus.js', file('export const c = 1;\n'));
    files.set('dist/corpus.d.ts', file('export declare const c = 1;\n'));
    files.set(
      'dist/index.js',
      file("export * from './contract.js';\nexport * from './corpus.js';\n"),
    );
    files.set(
      'dist/index.d.ts',
      file("export * from './contract.ts';\nexport * from './corpus.ts';\n"),
    );
    files.set('corpus/secrets.json', file('{}'));
    files.set('corpus/injections.json', file('{}'));
    mutate(manifest, files);
    return checkPackage({
      manifest,
      packed: manifest,
      files,
      expectedNode: NODE_RANGE,
      rootNotice: ROOT_NOTICE,
      rootRepositoryUrl: ROOT_REPO_URL,
      relDir: 'packages/security',
      privateNames: new Set(),
    }).map((v) => v.code);
  };
  assert.deepEqual(
    securityPackage(),
    [],
    'control: the corpus ships clean from the security package',
  );
  assert.deepEqual(
    securityPackage((_m, files) => files.set('corpus/notes.md', file('x'))),
    ['FORBIDDEN_FILE'],
    'only json data under corpus/',
  );
  assert.deepEqual(
    securityPackage((_m, files) => files.set('corpus/fixtures/a.json', file('{}'))),
    ['FORBIDDEN_FILE'],
    'a fixture is a fixture wherever it sits',
  );
  assert.deepEqual(
    securityPackage((_m, files) => files.set('data/a.json', file('{}'))),
    ['UNEXPECTED_TOP_LEVEL'],
    'only the named directory',
  );
  // The same directory in any other package is an unexpected top-level entry.
  assert.deepEqual(
    codesAfter((_m, files) => files.set('corpus/secrets.json', file('{}'))),
    ['UNEXPECTED_TOP_LEVEL'],
  );
});

test('sideEffects must be false or absent, and a package with a bin must not set it', () => {
  assert.deepEqual(
    codesAfter((m) => (m.sideEffects = false)),
    [],
  );
  assert.deepEqual(
    codesAfter((m) => (m.sideEffects = true)),
    ['SIDE_EFFECTS_INVALID'],
  );
  assert.deepEqual(
    codesAfter((m) => (m.sideEffects = ['./dist/index.js'])),
    ['SIDE_EFFECTS_INVALID'],
  );
  assert.deepEqual(
    codesAfter((m, files) => {
      m.bin = { seamline: './dist/bin.js' };
      m.sideEffects = false;
      files.set('dist/bin.js', file('#!/usr/bin/env node\nconsole.log(1);\n'));
    }),
    ['SIDE_EFFECTS_WITH_BIN'],
  );
});

test('repository must match the root and name the package directory; registry metadata is required', () => {
  assert.deepEqual(
    codesAfter((m) => {
      delete m.repository;
    }),
    ['REPOSITORY_MISSING'],
  );
  assert.deepEqual(
    codesAfter((m) => {
      m.repository.url = 'git+https://example.test/other.git';
    }),
    ['REPOSITORY_URL'],
  );
  assert.deepEqual(
    codesAfter((m) => {
      m.repository.directory = 'packages/core';
    }),
    ['REPOSITORY_DIRECTORY'],
  );
  assert.deepEqual(
    codesAfter((m) => {
      delete m.repository.directory;
    }),
    ['REPOSITORY_DIRECTORY'],
  );
  assert.deepEqual(
    codesAfter((m) => {
      delete m.description;
      delete m.homepage;
      delete m.bugs;
    }),
    ['BUGS_MISSING', 'DESCRIPTION_MISSING', 'HOMEPAGE_MISSING'],
  );
});

test('a private package must not look publishable', () => {
  assert.deepEqual(checkPrivatePackage({ name: 'x', private: true, version: '0.0.1' }), []);
  assert.deepEqual(
    checkPrivatePackage({
      name: 'x',
      private: true,
      exports: {},
      files: ['dist'],
      publishConfig: { access: 'public' },
    }).map((v) => v.message),
    [
      'x is private but declares "exports"',
      'x is private but declares "files"',
      'x is private but declares "publishConfig"',
    ],
  );
});

test('bare imports must be declared, and every runtime dependency must be imported by shipped code', () => {
  assert.deepEqual(
    codesAfter((_m, files) =>
      files.set('dist/contract.js', file("import { z } from 'zod';\nexport const a = z;\n")),
    ),
    ['UNDECLARED_IMPORT'],
    'an import the manifest does not declare',
  );
  assert.deepEqual(
    codesAfter((m, files) => {
      m.dependencies = { zod: '^4.0.0' };
      files.set('dist/contract.js', file("import { z } from 'zod/v4';\nexport const a = z;\n"));
    }),
    [],
    'a subpath import counts for its package',
  );
  assert.deepEqual(
    codesAfter((m, files) => {
      m.dependencies = { '@scope/pkg': '1.0.0' };
      files.set(
        'dist/contract.d.ts',
        file("import type { T } from '@scope/pkg/types';\nexport type A = T;\n"),
      );
    }),
    [],
    'a type-only import in a declaration counts, scoped names included',
  );
  assert.deepEqual(
    codesAfter((m) => {
      m.dependencies = { 'only-tests-use-me': '1.0.0' };
    }),
    ['UNUSED_DEPENDENCY'],
    'a dependency nothing shipped imports',
  );
  assert.deepEqual(
    codesAfter((_m, files) =>
      files.set(
        'dist/contract.js',
        file(
          "export const a = 'copied from \"somewhere\"';\nimport { readFileSync } from 'node:fs';\nimport { join } from 'path';\n",
        ),
      ),
    ),
    [],
    'the word from inside a string, node: specifiers and built-ins are not dependencies',
  );
});

test('a module the package starts by path is a root, but only where PROCESS_ENTRY_POINTS names it', () => {
  const child = (files) => {
    files.set(
      'dist/sandbox/child.js',
      file("import './guard.js';\nexport const started = true;\n"),
    );
    files.set('dist/sandbox/guard.js', file('export const guard = true;\n'));
    // The two modules `seamline conformance` starts by path, which import nothing.
    files.set('dist/conformance/wrapper.js', file('export const run = true;\n'));
    files.set('dist/conformance/describe-child.js', file('export const described = true;\n'));
  };
  assert.deepEqual(
    codesAfter((_m, files) => child(files)),
    ['UNREACHABLE_MODULE', 'UNREACHABLE_MODULE', 'UNREACHABLE_MODULE', 'UNREACHABLE_MODULE'],
    'another package gets no such root',
  );
  assert.deepEqual(
    codesAfter((m, files) => {
      m.name = '@seamline/cli';
      child(files);
    }),
    [],
    'the CLI starts its sandbox child by path, and the child imports the guard',
  );
  assert.deepEqual(
    codesAfter((m, files) => {
      m.name = '@seamline/cli';
      child(files);
      files.delete('dist/sandbox/child.js');
    }),
    ['ENTRY_MISSING', 'UNREACHABLE_MODULE'],
    'a named process entry missing from the tarball is reported, not skipped',
  );
});

test('a package named after an Object.prototype member is reported as unreviewed, not a crash', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.deepEqual(
      codesAfter((m) => {
        m.name = name;
      }),
      ['UNREVIEWED_PACKAGE'],
      name,
    );
  }
});

test('a shipped module nothing reaches is reported, unless it compiles to nothing', () => {
  assert.deepEqual(
    codesAfter((_m, files) => files.set('dist/memory-store.js', file('export const x = 1;\n'))),
    ['UNREACHABLE_MODULE'],
    'a helper whose name does not say "test"',
  );
  assert.deepEqual(
    codesAfter((_m, files) =>
      files.set('dist/types.js', file('export {};\n//# sourceMappingURL=types.js.map')),
    ),
    [],
    'a type-only module that compiles to an empty module',
  );
  assert.deepEqual(
    codesAfter((_m, files) => {
      files.set(
        'dist/index.js',
        file("export * from './contract.js';\nexport * from './util/a.js';\n"),
      );
      files.set('dist/util/a.js', file("export { b } from './b.js';\n"));
      files.set('dist/util/b.js', file('export const b = 1;\n'));
    }),
    [],
    'reached through a chain of relative imports',
  );
  assert.deepEqual(
    codesAfter((m, files) => {
      m.bin = { seamline: './dist/bin.js' };
      files.set('dist/bin.js', file("#!/usr/bin/env node\nimport './only-the-bin.js';\n"));
      files.set('dist/only-the-bin.js', file('console.log(1);\n'));
    }),
    [],
    'reached only from the bin',
  );
});

// ---------------------------------------------------------------------------
// The tarball reader
// ---------------------------------------------------------------------------

function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(type, 156);
  h.write('ustar\0', 257);
  return h;
}

function tarEntry(name, body, type = '0') {
  const data = Buffer.from(body);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, data.length, type), data, pad]);
}

test('readTarball strips package/, keeps content, and honours pax long paths', () => {
  const longPath = `package/dist/${'deeply-nested-directory-name/'.repeat(5)}module.js`;
  assert.ok(longPath.length > 100);
  const record = ` path=${longPath}\n`;
  const paxBody = `${String(record.length + String(record.length).length)}${record}`;
  const tar = Buffer.concat([
    tarEntry('package/package.json', '{"name":"x"}'),
    tarEntry('pax', paxBody, 'x'),
    tarEntry('truncated-name', 'export {};\n'),
    tarEntry('package/dist/', '', '5'),
    Buffer.alloc(1024),
  ]);
  const files = readTarball(gzipSync(tar));
  assert.deepEqual(
    [...files.keys()].sort(),
    ['dist/' + longPath.slice('package/dist/'.length), 'package.json'].sort(),
  );
  assert.equal(files.get('package.json').content.toString(), '{"name":"x"}');
  assert.equal(files.get(longPath.slice('package/'.length)).content.toString(), 'export {};\n');
});

// ---------------------------------------------------------------------------
// The real workspace
// ---------------------------------------------------------------------------

test('every real publishable package packs clean, and the internal package is never packed', () => {
  assert.ok(
    existsSync(join(REPO_ROOT, 'packages/ontology/dist/index.js')),
    'run `pnpm build` before this test: the tarballs are built from dist/',
  );
  const report = checkWorkspace(REPO_ROOT);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(
    report.packages.map((p) => p.name).sort(),
    Object.keys(PUBLIC_ENTRY_POINTS).sort(),
  );
  for (const internal of INTERNAL_PACKAGES) {
    assert.ok(!report.packages.some((p) => p.name === internal), `${internal} must not be packed`);
  }
  for (const p of report.packages)
    assert.ok(p.fileCount > 3, `${p.name} packed ${p.fileCount} files`);
});

test('the internal packages are private in the real manifests', () => {
  for (const dir of workspaceDirs(REPO_ROOT)) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (INTERNAL_PACKAGES.includes(manifest.name))
      assert.equal(manifest.private, true, manifest.name);
  }
});

// ---------------------------------------------------------------------------
// End to end: a throwaway workspace, the real `pnpm pack`, the real CLI
// ---------------------------------------------------------------------------

/** A two-package workspace: a copy of the real ontology package, and a private integration stub. */
function makeWorkspace(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'pack-check-ws-'));
  // Pin the same package manager as the repository, or corepack resolves its
  // own default outside the repository and may have nothing cached for it.
  const { packageManager, repository: rootRepository } = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'ws',
      private: true,
      engines: { node: NODE_RANGE },
      repository: rootRepository,
      packageManager,
    }),
  );
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  cpSync(join(REPO_ROOT, 'NOTICE'), join(root, 'NOTICE'));
  const pkg = join(root, 'packages/ontology');
  mkdirSync(pkg, { recursive: true });
  for (const entry of ['package.json', 'README.md', 'dist']) {
    cpSync(join(REPO_ROOT, 'packages/ontology', entry), join(pkg, entry), { recursive: true });
  }
  cpSync(join(REPO_ROOT, 'LICENSE'), join(pkg, 'LICENSE'));
  cpSync(join(REPO_ROOT, 'NOTICE'), join(pkg, 'NOTICE'));
  const integration = join(root, 'packages/integration');
  mkdirSync(integration, { recursive: true });
  writeFileSync(
    join(integration, 'package.json'),
    JSON.stringify({ name: '@seamline/integration', version: '0.0.1', private: true }),
  );
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  mutate(manifest, { pkg, integration });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest, null, 2));
  return root;
}

function runCli(root) {
  return spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
}

test('end to end: an unbroken throwaway workspace is clean and the CLI exits 0', () => {
  const root = makeWorkspace();
  try {
    assert.deepEqual(checkWorkspace(root).violations, []);
    const run = runCli(root);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /PASS {2}@seamline\/ontology/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('end to end: a fake exports target fails the gate with exit 1 naming the target', () => {
  const root = makeWorkspace((manifest) => {
    manifest.exports['.'].default = './dist/not-built.js';
  });
  try {
    const codes = checkWorkspace(root).violations.map((v) => v.code);
    assert.deepEqual(codes, ['ENTRY_MISSING']);
    const run = runCli(root);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /FAIL {2}@seamline\/ontology/);
    assert.match(
      run.stdout,
      /ENTRY_MISSING: exports\["\."\]\.default "\.\/dist\/not-built\.js" is not in the tarball/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('end to end: dropping the files negations ships tests and maps, and the gate says so', () => {
  const root = makeWorkspace((manifest) => {
    manifest.files = ['dist', 'README.md', 'NOTICE'];
  });
  try {
    const found = checkWorkspace(root).violations;
    assert.ok(found.length > 0);
    assert.deepEqual([...new Set(found.map((v) => v.code))], ['FORBIDDEN_FILE']);
    assert.ok(
      found.some((v) => /contract\.test\.js: test file/.test(v.message)),
      'the compiled test',
    );
    assert.ok(
      found.some((v) => /\.js\.map: source map/.test(v.message)),
      'a source map',
    );
    assert.equal(runCli(root).status, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('end to end: a package with no LICENSE or README, and no engines, fails three ways', () => {
  const root = makeWorkspace((manifest, { pkg }) => {
    rmSync(join(pkg, 'LICENSE'));
    rmSync(join(pkg, 'README.md'));
    delete manifest.engines;
  });
  try {
    assert.deepEqual(
      checkWorkspace(root)
        .violations.map((v) => v.code)
        .sort(),
      ['ENGINES_MISSING', 'LICENSE_MISSING', 'README_MISSING'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('end to end: a package that ships no NOTICE, or an edited one, fails the gate', () => {
  const missing = makeWorkspace((_manifest, { pkg }) => {
    rmSync(join(pkg, 'NOTICE'));
  });
  const drifted = makeWorkspace((_manifest, { pkg }) => {
    writeFileSync(join(pkg, 'NOTICE'), 'Seamline\nCopyright 2020 Someone Else\n');
  });
  const notListed = makeWorkspace((manifest) => {
    manifest.files = manifest.files.filter((f) => f !== 'NOTICE');
  });
  try {
    assert.deepEqual(
      checkWorkspace(missing).violations.map((v) => v.code),
      ['NOTICE_MISSING'],
      'the copy is absent from the package',
    );
    assert.deepEqual(
      checkWorkspace(drifted).violations.map((v) => v.code),
      ['NOTICE_DRIFT'],
      'the copy no longer equals the root file',
    );
    assert.deepEqual(
      checkWorkspace(notListed).violations.map((v) => v.code),
      ['NOTICE_MISSING'],
      'the copy exists but "files" does not ship it',
    );
    const run = runCli(missing);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /NOTICE_MISSING: NOTICE is not in the tarball/);
  } finally {
    for (const root of [missing, drifted, notListed])
      rmSync(root, { recursive: true, force: true });
  }
});

test('end to end: a repository with no root NOTICE cannot pass', () => {
  const root = makeWorkspace();
  try {
    rmSync(join(root, 'NOTICE'));
    const codes = checkWorkspace(root).violations.map((v) => v.code);
    assert.ok(codes.includes('ROOT_NOTICE_MISSING'), codes.join(','));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the committed per-package NOTICE copies equal the root NOTICE', () => {
  const root = readFileSync(join(REPO_ROOT, 'NOTICE'));
  for (const dir of workspaceDirs(REPO_ROOT)) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (manifest.private === true) continue;
    assert.ok(manifest.files.includes('NOTICE'), `${manifest.name}: "files" must list NOTICE`);
    assert.ok(readFileSync(join(dir, 'NOTICE')).equals(root), `${manifest.name}: NOTICE drifted`);
  }
});

test('end to end: wrong repository, an unused dependency and a publishable-looking private package fail the gate', () => {
  const wrongRepo = makeWorkspace((manifest) => {
    manifest.repository.url = 'git+https://example.test/someone-else.git';
  });
  const unusedDep = makeWorkspace((manifest) => {
    manifest.dependencies = { 'only-tests-use-me': '1.0.0' };
  });
  const privateWithExports = makeWorkspace((_manifest, { integration }) => {
    writeFileSync(
      join(integration, 'package.json'),
      JSON.stringify({
        name: '@seamline/integration',
        version: '0.0.1',
        private: true,
        exports: { '.': './dist/index.js' },
      }),
    );
  });
  try {
    assert.deepEqual(
      checkWorkspace(wrongRepo).violations.map((v) => v.code),
      ['REPOSITORY_URL'],
    );
    assert.deepEqual(
      checkWorkspace(unusedDep).violations.map((v) => v.code),
      ['UNUSED_DEPENDENCY'],
    );
    assert.deepEqual(
      checkWorkspace(privateWithExports).violations.map((v) => v.code),
      ['PRIVATE_HAS_PUBLISH_FIELDS'],
    );
    assert.equal(runCli(unusedDep).status, 1);
  } finally {
    for (const root of [wrongRepo, unusedDep, privateWithExports]) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('end to end: an internal package that loses "private": true fails the gate', () => {
  const root = makeWorkspace((_manifest, { integration }) => {
    writeFileSync(
      join(integration, 'package.json'),
      JSON.stringify({ name: '@seamline/integration', version: '0.0.1' }),
    );
  });
  try {
    const codes = checkWorkspace(root).violations.map((v) => v.code);
    assert.ok(codes.includes('INTERNAL_NOT_PRIVATE'), codes.join(','));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a package that cannot be packed is a failure, never a pass', () => {
  const root = makeWorkspace();
  try {
    const report = checkWorkspace(root, {
      pack: () => {
        throw new Error('pnpm exploded');
      },
    });
    assert.deepEqual(
      report.violations.map((v) => v.code),
      ['PACK_FAILED'],
    );
    assert.match(report.violations[0].message, /pnpm exploded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The actual Bash step runs against a synthetic npm executable. These controls
// verify artifact selection and failure semantics, not cryptographic signatures.
function provenanceStep() {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
  const section = workflow.split('      - name: Verify every published package carries provenance\n')[1];
  assert.ok(section, 'the release verification step exists');
  const lines = section.split('\n');
  const start = lines.indexOf('        run: |');
  assert.ok(start >= 0, 'the verification step contains a script');
  const script = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith('          ')) break;
    script.push(line.slice(10));
  }
  return script.join('\n');
}

function releaseTargets() {
  return workspaceDirs(REPO_ROOT)
    .map((dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')))
    .filter((manifest) => manifest.private !== true)
    .map((manifest) => manifest.name)
    .sort();
}

function runProvenanceStep(mode = 'complete', script = provenanceStep()) {
  const root = mkdtempSync(join(tmpdir(), 'seamline-provenance-test-'));
  const bin = join(root, 'bin');
  const scratch = join(root, 'scratch');
  const log = join(root, 'npm.jsonl');
  mkdirSync(bin);
  mkdirSync(scratch);
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.SEAMLINE_PROVENANCE_CASE;
fs.appendFileSync(process.env.SEAMLINE_PROVENANCE_LOG,
  JSON.stringify({args, cwd: process.cwd()}) + '\\n');
if (args[0] === 'view') process.exit(0); // npm can return no field and exit 0.
if (args[0] === 'install') {
  if (mode === 'install-fails') process.exit(17);
  fs.writeFileSync('selected.json', JSON.stringify(args.slice(args.indexOf('--') + 1)));
  process.exit(0);
}
if (args[0] !== 'audit' || args[1] !== 'signatures') process.exit(97);
if (mode === 'audit-fails') process.exit(19);
if (mode === 'malformed') { process.stdout.write('{'); process.exit(0); }
if (mode === 'null-report') { process.stdout.write('null'); process.exit(0); }
const targets = fs.existsSync('selected.json') ? JSON.parse(fs.readFileSync('selected.json')) : [];
const predicateType = mode === 'legacy-type'
  ? 'https://slsa.dev/provenance/v0.2' : 'https://slsa.dev/provenance/v1';
const records = targets.map((target) => {
  const split = target.lastIndexOf('@');
  const name = target.slice(0, split), version = target.slice(split + 1);
  const statement = {_type: mode === 'legacy-type'
    ? 'https://in-toto.io/Statement/v0.1' : 'https://in-toto.io/Statement/v1', predicateType};
  if (mode === 'relabeled-publish') statement.predicateType = 'publish';
  if (mode === 'last-relabeled-publish' && target === targets.at(-1)) statement.predicateType = 'publish';
  if (mode === 'signed-type-mismatch') statement.predicateType = 'https://slsa.dev/provenance/v0.2';
  if (mode === 'wrong-statement-type') statement._type = 'https://example.invalid/statement';
  if (mode === 'last-wrong-statement-type' && target === targets.at(-1)) statement._type = 'https://example.invalid/statement';
  if (mode === 'missing-statement-type') delete statement._type;
  const payload = Buffer.from(mode === 'malformed-statement' ? '{' :
    JSON.stringify(mode === 'null-statement' ? null : statement)).toString('base64');
  return {name, version, location: 'node_modules/' + name,
    registry: 'https://registry.npmjs.org/',
    attestations: {provenance: {predicateType}},
    attestationBundles: [{predicateType, bundle: {dsseEnvelope: {payload}}}]};
});
const report = {invalid: [], missing: [], verified: records};
if (mode === 'no-evidence') delete report.verified;
if (mode === 'empty') report.verified = [];
if (mode === 'partial') report.verified.pop();
if (mode === 'wrong-version') records[0].version = '9.9.9';
if (mode === 'wrong-location') records[0].location = 'node_modules/other/node_modules/' + records[0].name;
if (mode === 'wrong-registry') records[0].registry = 'https://example.invalid/';
if (mode === 'duplicate') records.push(records[0]);
if (mode === 'publish-only') delete records[0].attestations.provenance;
if (mode === 'unsupported-provenance') records[0].attestations.provenance.predicateType = 'publish';
if (mode === 'missing-bundle') delete records[0].attestationBundles;
if (mode === 'last-missing-bundle') delete records.at(-1).attestationBundles;
if (mode === 'null-envelope') records[0].attestationBundles[0].bundle.dsseEnvelope = null;
if (mode === 'empty-envelope') records[0].attestationBundles[0].bundle.dsseEnvelope.payload = '';
if (mode === 'wrong-bundle-type') records[0].attestationBundles[0].predicateType = 'publish';
if (mode === 'invalid') report.invalid.push({name: records[0].name});
if (mode === 'missing-signature') report.missing.push({name: records[0].name});
process.stdout.write(JSON.stringify(report));
`, { mode: 0o755 });
  // The step polls the registry before it installs. This stands in for curl:
  // a version document that names the requested version and a registry
  // tarball, then 200 for the tarball. 'never-served' answers 404 throughout;
  // 'served-late' answers 404 for the first round of version documents.
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.SEAMLINE_PROVENANCE_CASE;
const url = args.at(-1);
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
fs.appendFileSync(process.env.SEAMLINE_PROVENANCE_CURL_LOG, url + '\\n');
const seen = fs.readFileSync(process.env.SEAMLINE_PROVENANCE_CURL_LOG, 'utf8').split('\\n').filter(Boolean);
let code = '200';
if (mode === 'never-served') code = '404';
if (mode === 'served-late' && seen.filter((u) => u === url).length === 1 && !url.endsWith('.tgz')) code = '404';
if (code === '200' && out && out !== '/dev/null') {
  const match = /^https:\\/\\/registry\\.npmjs\\.org\\/(.+)\\/([^/]+)$/.exec(url);
  fs.writeFileSync(out, JSON.stringify({ name: match[1], version: match[2],
    dist: { tarball: 'https://registry.npmjs.org/' + match[1] + '/-/artifact-' + match[2] + '.tgz' } }));
}
process.stdout.write(code);
`, { mode: 0o755 });
  try {
    const run = spawnSync('bash', ['-s'], {
      input: script,
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        TMPDIR: scratch,
        GITHUB_REF_NAME: 'v0.0.1',
        SEAMLINE_PROVENANCE_CASE: mode,
        SEAMLINE_PROVENANCE_LOG: log,
        SEAMLINE_PROVENANCE_CURL_LOG: join(root, 'curl.log'),
        // No real waiting in tests: one extra round is allowed, with no sleep.
        PROPAGATION_SLEEP_SECONDS: '0',
        PROPAGATION_BUDGET_SECONDS: mode === 'never-served' ? '0' : '60',
      },
    });
    assert.equal(run.error, undefined, `workflow execution failed: ${String(run.error)}`);
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const verificationDirectorySurvived = calls.some((call) =>
      call.args[0] === 'install' && existsSync(call.cwd));
    return { ...run, calls, scratch, verificationDirectorySurvived };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('release provenance: the explicit verification list equals every publishable workspace package', () => {
  const script = provenanceStep();
  const declaration = /packages=\(\n([\s\S]*?)\n\)/.exec(script);
  assert.ok(declaration, 'the reviewed package list remains explicit');
  const names = [...declaration[1].matchAll(/"(@seamline\/[a-z-]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(names).size, names.length, 'no duplicate package can hide an omitted one');
  assert.deepEqual(names.sort(), releaseTargets());
});

for (const mode of ['complete', 'legacy-type']) {
  test(`release provenance: ${mode} exact release artifacts are installed without scripts and audited in a private directory`,
    { skip: process.platform === 'win32' }, () => {
      const run = runProvenanceStep(mode);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.deepEqual(run.calls.map((call) => call.args[0]), ['install', 'audit']);
      const [install, audit] = run.calls;
      assert.ok(install.cwd.startsWith(`${run.scratch}/`), 'the checkout is not the audited installation');
      assert.equal(audit.cwd, install.cwd);
      assert.equal(run.verificationDirectorySurvived, false, 'the private installation is removed');
      for (const flag of ['--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=https://registry.npmjs.org/']) {
        assert.ok(install.args.includes(flag), `missing install guard ${flag}`);
      }
      assert.deepEqual(install.args.slice(install.args.indexOf('--') + 1).sort(),
        releaseTargets().map((name) => `${name}@0.0.1`));
      for (const flag of ['--json', '--include-attestations', '--registry=https://registry.npmjs.org/']) {
        assert.ok(audit.args.includes(flag), `missing verification option ${flag}`);
      }
      assert.deepEqual(run.stdout.trim().split('\n').sort(),
        releaseTargets().map((name) => `Verified provenance: ${name}@0.0.1`));
    });
}

const PROVENANCE_FAILURES = [
  ['no-evidence', /did not return verified attestation evidence/],
  ['empty', /missing unique verified release artifact/],
  ['partial', /missing unique verified release artifact/],
  ['wrong-version', /missing unique verified release artifact/],
  ['wrong-location', /missing unique verified release artifact/],
  ['wrong-registry', /missing unique verified release artifact/],
  ['duplicate', /missing unique verified release artifact/],
  ['publish-only', /missing provenance/],
  ['unsupported-provenance', /missing provenance/],
  ['missing-bundle', /missing verified provenance bundle/],
  ['last-missing-bundle', /missing verified provenance bundle/],
  ['null-envelope', /missing verified provenance bundle/],
  ['empty-envelope', /missing verified provenance bundle/],
  ['wrong-bundle-type', /missing verified provenance bundle/],
  ['relabeled-publish', /missing verified provenance bundle/],
  ['last-relabeled-publish', /missing verified provenance bundle/],
  ['signed-type-mismatch', /missing verified provenance bundle/],
  ['wrong-statement-type', /missing verified provenance bundle/],
  ['last-wrong-statement-type', /missing verified provenance bundle/],
  ['missing-statement-type', /missing verified provenance bundle/],
  ['null-statement', /missing verified provenance bundle/],
  ['malformed-statement', /SyntaxError/],
  ['invalid', /npm reported invalid verification evidence/],
  ['missing-signature', /npm reported missing registry signatures/],
  ['malformed', /SyntaxError/],
  ['null-report', /TypeError/],
];
for (const [mode, message] of PROVENANCE_FAILURES) {
  test(`release provenance: a zero-exit npm audit cannot pass with ${mode}`,
    { skip: process.platform === 'win32' }, () => {
      const run = runProvenanceStep(mode);
      assert.equal(run.status, 1, run.stdout + run.stderr);
      assert.match(run.stderr, message);
      assert.equal(run.verificationDirectorySurvived, false);
    });
}

for (const [mode, exit] of [['install-fails', 17], ['audit-fails', 19]]) {
  test(`release provenance: ${mode} is fatal and the temporary installation is removed`,
    { skip: process.platform === 'win32' }, () => {
      const run = runProvenanceStep(mode);
      assert.equal(run.status, exit, run.stdout + run.stderr);
      assert.equal(run.verificationDirectorySurvived, false);
      assert.ok(!run.stdout.includes('Verified provenance:'));
    });
}

test('release provenance: a registry that is not serving the new version yet is waited for, then verified',
  { skip: process.platform === 'win32' }, () => {
    const run = runProvenanceStep('served-late');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stderr, /Registry propagation round 1: 0 of \d+ served at 0\.0\.1/);
    assert.match(run.stderr, /Registry propagation round 2: (\d+) of \1 served at 0\.0\.1/);
    assert.deepEqual(run.calls.map((call) => call.args[0]), ['install', 'audit']);
    assert.deepEqual(run.stdout.trim().split('\n').sort(),
      releaseTargets().map((name) => `Verified provenance: ${name}@0.0.1`));
  });

test('release provenance: a registry that never serves the version fails without installing and says not to re-run',
  { skip: process.platform === 'win32' }, () => {
    const run = runProvenanceStep('never-served');
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.deepEqual(run.calls, [], 'nothing is installed or audited before the registry serves the release');
    assert.match(run.stdout, /::error::The packages were published, but the registry did not serve all of them/);
    assert.match(run.stdout, /Do NOT re-run this job/);
    assert.ok(!run.stdout.includes('Verified provenance:'));
  });

test('release provenance: a failing install is retried a bounded number of times before it is fatal',
  { skip: process.platform === 'win32' }, () => {
    const run = runProvenanceStep('install-fails');
    assert.equal(run.status, 17, run.stdout + run.stderr);
    assert.deepEqual(run.calls.map((call) => call.args[0]), Array(5).fill('install'));
    assert.match(run.stdout, /::error::npm install of the published packages failed 5 times/);
  });

test('release provenance: the former view-and-audit sequence accepts missing provenance that the workflow now rejects',
  { skip: process.platform === 'win32' }, () => {
    const former = 'set -euo pipefail\nversion="${GITHUB_REF_NAME#v}"\n' +
      'packages=("@seamline/cli")\n' +
      'for pkg in "${packages[@]}"; do npm view "${pkg}@${version}" dist.attestations --json; done\n' +
      'npm audit signatures\n';
    const before = runProvenanceStep('no-evidence', former);
    assert.equal(before.status, 0, before.stdout + before.stderr);
    assert.deepEqual(before.calls.map((call) => call.args[0]), ['view', 'audit']);
    const after = runProvenanceStep('no-evidence');
    assert.equal(after.status, 1, after.stdout + after.stderr);
    assert.match(after.stderr, /did not return verified attestation evidence/);
  });
