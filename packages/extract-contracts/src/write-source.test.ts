// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { DEFAULT_LIMITS } from './types.ts';
import { WriteSource, WriteUnknown } from './write-source.ts';

function sourceRepo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'write-source-'));
  for (const [path, source] of Object.entries({ 'package.json': '{"name":"@sample/forms"}', ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('resolve local declarations through a relative barrel and one confined tsconfig alias', () => {
  const repo = sourceRepo({
    'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
    'src/route.ts': 'import { persist } from "@/queries";',
    'src/queries/index.ts': 'export * from "./other"; export { save as persist } from "./save";',
    'src/queries/other.ts': 'export const unrelated = 1;',
    'src/queries/save.ts': 'export function save(data: unknown) { return data; }',
  });
  try {
    const project = new WriteSource(ts, repo.root, DEFAULT_LIMITS);
    const resolved = project.binding(project.parse('src/route.ts'), 'persist');
    assert.equal(resolved.name, 'save');
    assert.equal(resolved.file.fileName, 'src/queries/save.ts');
    assert.equal(project.owner(resolved.file).name, '@sample/forms');
    assert.equal(project.inventoryComplete, true);
    assert.equal(project.modules.size, 4);
  } finally { repo.close(); }
});

test('a competing export, cyclic barrel, malformed module and ambiguous extension each withhold', () => {
  for (const [files, expected] of [
    [{ 'index.ts': 'export * from "./a"; export * from "./b";',
      'a.ts': 'export function save() {}', 'b.ts': 'export function save() {}' }, 'WRITE_EXPORT_AMBIGUOUS'],
    [{ 'index.ts': 'export * from "./a";', 'a.ts': 'export * from "./index";' }, 'WRITE_EXPORT_CYCLE'],
    [{ 'index.ts': 'export { save } from "./a";', 'a.ts': 'export function save(' }, 'WRITE_SOURCE_PARSE'],
    [{ 'index.ts': 'export { save } from "./a";', 'a.ts': 'export function save() {}',
      'a.tsx': 'export function save() {}' }, 'WRITE_MODULE_AMBIGUOUS'],
  ] as const) {
    const repo = sourceRepo({ ...files });
    try {
      const project = new WriteSource(ts, repo.root, DEFAULT_LIMITS);
      assert.throws(() => project.exported(project.parse('index.ts'), 'save'),
        (error: unknown) => error instanceof WriteUnknown && error.message === expected);
    } finally { repo.close(); }
  }
});

test('missing generated output cannot escape through an existing ancestor symlink', () => {
  const repo = sourceRepo({ 'src/route.ts': 'export {};' });
  const outside = mkdtempSync(join(tmpdir(), 'write-outside-'));
  try {
    symlinkSync(outside, join(repo.root, 'src', 'generated'), 'dir');
    const project = new WriteSource(ts, repo.root, DEFAULT_LIMITS);
    assert.equal(project.inventoryComplete, false);
    assert.throws(() => project.path(repo.root, 'src/generated/prisma/client'),
      /WRITE_PATH_ESCAPES_ROOT/);
    assert.throws(() => project.path(repo.root, '../outside.ts'), /WRITE_PATH_ESCAPES_ROOT/);
    assert.throws(() => project.path(repo.root, 'https://example.invalid/a.ts'), /WRITE_REMOTE/);
  } finally { repo.close(); rmSync(outside, { recursive: true, force: true }); }
});

test('unimported build source is inventoried and exhausted inventory or syntax is explicit', () => {
  const repo = sourceRepo({
    'route.ts': 'const value = [1,2,3];',
    'dist/hidden.js': 'globalThis.cache = replacement;',
  });
  try {
    const project = new WriteSource(ts, repo.root, DEFAULT_LIMITS);
    assert.ok(project.inventory.includes('dist/hidden.js'));
    const capped = new WriteSource(ts, repo.root, { ...DEFAULT_LIMITS, maxFiles: 1 });
    assert.equal(capped.inventoryComplete, false);
    const oversized = sourceRepo({ 'many.ts': `const values = [${'1,'.repeat(10_001)}];` });
    try {
      const huge = new WriteSource(ts, oversized.root, DEFAULT_LIMITS);
      const file = huge.parse('many.ts');
      assert.throws(() => huge.count(file), /WRITE_SYNTAX_CAP/);
      assert.throws(() => huge.count(file), /WRITE_SYNTAX_CAP/);
      assert.throws(() => huge.chargeSyntax('repeated', 0), /WRITE_SYNTAX_CAP/);
    } finally { oversized.close(); }
  } finally { repo.close(); }
});


test('shared source inputs preserve independent module and syntax budgets and expire between extractions', () => {
  const repo = sourceRepo(Object.fromEntries(Array.from({length: 34}, (_, index) => [`item${index}.ts`, 'const value = 1;'])));
  try {
    const inputs = new WriteSource(ts, repo.root, DEFAULT_LIMITS);
    for (let index = 0; index < 34; index++) inputs.parse(`item${index}.ts`, false);
    const proposal = new WriteSource(ts, repo.root, DEFAULT_LIMITS, undefined, inputs);
    for (let index = 0; index < 32; index++) proposal.parse(`item${index}.ts`);
    assert.throws(() => proposal.parse('item32.ts'), /WRITE_MODULE_CAP/);
    const fresh = new WriteSource(ts, repo.root, DEFAULT_LIMITS, undefined, inputs);
    assert.equal(fresh.parse('item32.ts'), inputs.parse('item32.ts', false));
    writeFileSync(join(repo.root, 'item32.ts'), 'const value = 2;');
    assert.match(new WriteSource(ts, repo.root, DEFAULT_LIMITS).parse('item32.ts').text, /value = 2/);
    const large = `const values = [${'1,'.repeat(10_001)}];`;
    writeFileSync(join(repo.root, 'large.ts'), large);
    const huge = inputs.parse('large.ts', false);
    for (const project of [inputs, fresh]) assert.throws(() => project.count(huge), /WRITE_SYNTAX_CAP/);
  } finally { repo.close(); }
});

test('a memoized client-world check replays module, resolution and syntax charges', () => {
  const repo = sourceRepo({ ...Object.fromEntries(Array.from({length: 35}, (_, index) => [`item${index}.ts`, 'export const value = 1;'])),
    'large.ts': `const values = [${'1,'.repeat(6000)}];`,
    'other.ts': `const values = [${'1,'.repeat(4000)}];`,
  });
  try {
    const shared = new WriteSource(ts, repo.root, DEFAULT_LIMITS);
    shared.memoize('modules', () => {
      for (let index = 0; index < 31; index++) shared.parse(`item${index}.ts`);
      return true;
    });
    const next = new WriteSource(ts, repo.root, DEFAULT_LIMITS, undefined, shared);
    next.parse('item31.ts'); next.parse('item32.ts');
    assert.throws(() => next.memoize('modules', () => assert.fail('must replay cached work')), /WRITE_MODULE_CAP/);
    // A budget-dependent refusal is never retained for a fresh proposal.
    assert.throws(() => next.memoize('proposal-budget', () => next.parse('item33.ts')), /WRITE_MODULE_CAP/);
    const fresh = new WriteSource(ts, repo.root, DEFAULT_LIMITS, undefined, shared);
    assert.equal(fresh.memoize('proposal-budget', () => fresh.parse('item33.ts')).fileName, 'item33.ts');

    const imports = new WriteSource(ts, repo.root, DEFAULT_LIMITS, undefined, shared);
    const entry = imports.parse('item0.ts');
    imports.memoize('resolutions', () => {
      for (let index = 0; index < 64; index++) imports.module(entry, './'.repeat(index + 1) + 'item1.ts');
      return true;
    });
    const imported = new WriteSource(ts, repo.root, DEFAULT_LIMITS, undefined, shared);
    imported.module(imported.parse('item0.ts'), './item2.ts');
    assert.throws(() => imported.memoize('resolutions', () => assert.fail('must replay cached work')), /WRITE_IMPORT_CAP/);

    const syntax = new WriteSource(ts, repo.root, DEFAULT_LIMITS, undefined, shared);
    syntax.memoize('syntax', () => { syntax.count(syntax.parse('large.ts')); return true; });
    const counted = new WriteSource(ts, repo.root, DEFAULT_LIMITS, undefined, shared);
    counted.count(counted.parse('other.ts'));
    assert.throws(() => counted.memoize('syntax', () => assert.fail('must replay cached work')), /WRITE_SYNTAX_CAP/);
    const metadata = new WriteSource(ts, repo.root, DEFAULT_LIMITS, undefined, shared);
    metadata.chargeSyntax('prisma-model-metadata', 6000);
    assert.throws(() => metadata.count(metadata.parse('other.ts')), /WRITE_SYNTAX_CAP/);
  } finally { repo.close(); }
});


test('metadata symlinks cannot disappear from a complete client-source inventory', () => {
  for (const name of ['.npmrc', 'pnpm-workspace.yaml', 'package.json']) {
    const repo = sourceRepo({ 'settings.txt': '{}', 'src/input.ts': 'export {};' });
    try {
      const path = name === 'package.json' ? 'src/package.json' : name;
      symlinkSync(join(repo.root, 'settings.txt'), join(repo.root, path));
      assert.equal(new WriteSource(ts, repo.root, DEFAULT_LIMITS).inventoryComplete, false, name);
    } finally { repo.close(); }
  }
});

test('inventory-only import-path resolutions enforce the same per-module cap', () => {
  const repo = sourceRepo({ 'input.ts': 'export {};' });
  try {
    const project = new WriteSource(ts, repo.root, DEFAULT_LIMITS);
    const file = project.parse('input.ts');
    for (let index = 0; index < 64; index++) project.importPath(file, './'.repeat(index + 1) + 'input');
    assert.throws(() => project.importPath(file, './different'), /WRITE_IMPORT_CAP/);
    assert.throws(() => project.importPath(file, './input'), /WRITE_IMPORT_CAP/);
  } finally { repo.close(); }
});


test('relative import exclusion refuses custom resolver or package-entrypoint ambiguity', () => {
  const repo = sourceRepo({'input.ts':'export {};', 'tsconfig.json':'{"compilerOptions":{"moduleSuffixes":[".native", ""]}}'});
  try {
    const project = new WriteSource(ts, repo.root, DEFAULT_LIMITS);
    assert.throws(() => project.mayReference(project.parse('input.ts'), './unrelated', [join(repo.root,'client')]), /WRITE_RESOLVER_CUSTOMIZED/);
  } finally { repo.close(); }
  const ordinary = sourceRepo({'input.ts':'export {};'});
  try {
    const project = new WriteSource(ts, ordinary.root, DEFAULT_LIMITS);
    assert.throws(() => project.importPath(project.parse('input.ts'), '.'), /WRITE_PACKAGE_ENTRYPOINT_UNSUPPORTED/);
    assert.throws(() => project.importPath(project.parse('input.ts'), '#storage'), /WRITE_PACKAGE_IMPORTS_UNSUPPORTED/);
  } finally { ordinary.close(); }
});
