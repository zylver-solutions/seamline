import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeId } from '@seamline/ontology';
import type { ModuleImport } from './context.ts';
import { mergeImportFacts, mergeModuleImports } from './imports.ts';
import type { ImportFact } from './imports.ts';

/** Every ordering of `items`. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

function foldFacts(facts: readonly ImportFact[]): ImportFact {
  const [first, ...rest] = facts;
  assert.ok(first !== undefined);
  return rest.reduce(mergeImportFacts, first);
}

function foldModules(imports: readonly ModuleImport[]): ModuleImport {
  const [first, ...rest] = imports;
  assert.ok(first !== undefined);
  return rest.reduce(mergeModuleImports, first);
}

const fact = (specifier: string, typeOnly: boolean, reExport: boolean): ImportFact => ({
  specifier,
  typeOnly,
  reExport,
});

test('one value import among type-only imports makes the folded edge a value dependency', () => {
  assert.equal(
    mergeImportFacts(fact('./a.ts', true, false), fact('./a.ts', false, false)).typeOnly,
    false,
  );
  assert.equal(
    mergeImportFacts(fact('./a.ts', false, false), fact('./a.ts', true, false)).typeOnly,
    false,
  );
  assert.equal(
    mergeImportFacts(fact('./a.ts', true, false), fact('./a.ts', true, false)).typeOnly,
    true,
  );
  assert.equal(
    mergeImportFacts(fact('./a.ts', false, false), fact('./a.ts', false, false)).typeOnly,
    false,
  );
});

test('any re-export makes the folded edge a re-export', () => {
  assert.equal(
    mergeImportFacts(fact('./a.ts', false, true), fact('./a.ts', false, false)).reExport,
    true,
  );
  assert.equal(
    mergeImportFacts(fact('./a.ts', false, false), fact('./a.ts', false, true)).reExport,
    true,
  );
  assert.equal(
    mergeImportFacts(fact('./a.ts', false, false), fact('./a.ts', false, false)).reExport,
    false,
  );
});

test('the folded specifier is the smallest spelling', () => {
  assert.equal(
    mergeImportFacts(fact('./b.ts', false, false), fact('./a.ts', false, false)).specifier,
    './a.ts',
  );
  assert.equal(
    mergeImportFacts(fact('./a.ts', false, false), fact('./a.ts', false, false)).specifier,
    './a.ts',
  );
  // Code-unit order, as every other sort in this package, not locale order.
  assert.equal(
    mergeImportFacts(fact('./B.ts', false, false), fact('./a.ts', false, false)).specifier,
    './B.ts',
  );
});

test('folding a declaration with itself changes nothing', () => {
  const only = fact('./a.ts', true, true);
  assert.deepEqual(mergeImportFacts(only, only), only);
});

test('the folded facts are the same for every ordering of the declarations', () => {
  const declarations = [
    fact('./a.ts', true, false),
    fact('./a.js', true, false),
    fact('./a.ts', false, false),
    fact('./a.ts', true, true),
  ];
  const expected = { specifier: './a.js', typeOnly: false, reExport: true };
  const orderings = permutations(declarations);
  assert.equal(orderings.length, 24);
  for (const ordering of orderings) {
    assert.deepEqual(foldFacts(ordering), expected, JSON.stringify(ordering));
  }
});

test('folding is associative: how the declarations are grouped does not matter', () => {
  const a = fact('./z.ts', true, false);
  const b = fact('./m.ts', true, true);
  const c = fact('./a.ts', false, false);
  assert.deepEqual(
    mergeImportFacts(mergeImportFacts(a, b), c),
    mergeImportFacts(a, mergeImportFacts(b, c)),
  );
});

const SRC = nodeId('r', 'Module', '@r/api');
const DST = nodeId('r', 'Module', '@r/core');

const moduleFact = (srcFile: string, dstFile: string, specifier: string): ModuleImport => ({
  src: SRC,
  dst: DST,
  srcFile,
  dstFile,
  specifier,
});

test('the module edge is attributed to the smallest file pair and carries the smallest specifier, for every ordering', () => {
  const imports = [
    moduleFact('api/src/b.ts', 'core/src/a.ts', '../../core/src/a.js'),
    moduleFact('api/src/a.ts', 'core/src/z.ts', '../../core/src/z.ts'),
    moduleFact('api/src/a.ts', 'core/src/m.ts', '../../core/src/m.ts'),
    moduleFact('api/src/c.ts', 'core/src/a.ts', '@r/core'),
  ];
  // The smallest pair is (a.ts, m.ts); the smallest specifier is a different declaration's.
  const expected = moduleFact('api/src/a.ts', 'core/src/m.ts', '../../core/src/a.js');
  for (const ordering of permutations(imports)) {
    assert.deepEqual(foldModules(ordering), expected, JSON.stringify(ordering));
  }
});
