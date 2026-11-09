/**
 * `IMPORTS` aggregation, asserted through the public extractor.
 *
 * The graph keeps one `IMPORTS` edge per (importer, imported) pair, but a file
 * can reach another file through several `import` and `export ... from`
 * declarations. Every case here is run with the statements in both orders: the
 * facts on the kept edge describe the set of declarations, so reordering
 * statements must not change them (or a single byte of the emitted SIF).
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SeamlineEdge } from '@seamline/ontology';
import { extractCodeTs } from './extract.ts';
import type { ExtractCodeTsOutput } from './extract.ts';
import { toCanonicalSif } from './serialize.ts';
import { WORKSPACE_PROJECT, cleanup, materialize, sourceProject } from './__fixtures__/projects.ts';
import type { FileMap } from './__fixtures__/projects.ts';

const importRoots: string[] = [];

function extractImports(files: FileMap, label: string): ExtractCodeTsOutput {
  const root = materialize(files, label);
  importRoots.push(root);
  const output = extractCodeTs({
    repoRoot: root,
    repo: 'fixture',
    runId: 'run-1',
    deterministic: true,
  });
  assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('; '));
  return output;
}

after(() => {
  for (const root of importRoots) cleanup(root);
});

const A_TS = `export interface A {
  id: string;
}

export interface B {
  name: string;
}

export function makeA(): A {
  return { id: '' };
}
`;

/**
 * `src/consumer.ts` holding `statements`, one per line, then a one-line
 * declaration. Every statement is a single line, so reordering them moves no
 * other line number and the whole SIF can be compared byte for byte.
 */
function consumerProject(statements: readonly string[]): FileMap {
  return sourceProject({
    'src/a.ts': A_TS,
    'src/consumer.ts': `${statements.join('\n')}\n\nexport const marker = 1;\n`,
  });
}

/** Extract `statements` as written, and again reversed. */
function bothOrders(
  statements: readonly string[],
  label: string,
): { readonly forward: ExtractCodeTsOutput; readonly reversed: ExtractCodeTsOutput } {
  return {
    forward: extractImports(consumerProject(statements), `${label}-forward`),
    reversed: extractImports(consumerProject([...statements].reverse()), `${label}-reversed`),
  };
}

function fileImportEdge(output: ExtractCodeTsOutput, from: string, to: string): SeamlineEdge {
  const matches = output.edges.filter(
    (e) =>
      e.kind === 'IMPORTS' &&
      String(e.src) === `fixture:File:${from}` &&
      String(e.dst) === `fixture:File:${to}`,
  );
  assert.equal(matches.length, 1, `exactly one IMPORTS edge ${from} -> ${to}`);
  return matches[0] as SeamlineEdge;
}

function moduleImportEdge(output: ExtractCodeTsOutput, from: string, to: string): SeamlineEdge {
  const matches = output.edges.filter(
    (e) =>
      e.kind === 'IMPORTS' &&
      String(e.src) === `fixture:Module:${from}` &&
      String(e.dst) === `fixture:Module:${to}`,
  );
  assert.equal(matches.length, 1, `exactly one IMPORTS edge ${from} -> ${to}`);
  return matches[0] as SeamlineEdge;
}

/** The props of the `consumer.ts -> a.ts` edge in both statement orders. */
function consumerProps(statements: readonly string[], label: string) {
  const { forward, reversed } = bothOrders(statements, label);
  return {
    forward: fileImportEdge(forward, 'src/consumer.ts', 'src/a.ts').props,
    reversed: fileImportEdge(reversed, 'src/consumer.ts', 'src/a.ts').props,
  };
}

const TYPE_IMPORT = "import type { A } from './a.ts';";
const VALUE_IMPORT = "import { makeA } from './a.ts';";

test('a type-only import beside a value import of the same file is not type-only, in either order', () => {
  const props = consumerProps([TYPE_IMPORT, VALUE_IMPORT], 'type-then-value');
  const expected = { reExport: false, specifier: './a.ts', typeOnly: false };
  assert.deepEqual(props.forward, expected);
  assert.deepEqual(props.reversed, expected);
});

test('the SIF is byte-identical whichever order the import statements are written in', () => {
  const { forward, reversed } = bothOrders([TYPE_IMPORT, VALUE_IMPORT], 'sif-order');
  const forwardSif = toCanonicalSif(forward);
  assert.ok(
    forwardSif.includes('"kind":"IMPORTS"') &&
      forwardSif.includes('"src":"fixture:File:src/consumer.ts"'),
    'the comparison must cover the consumer IMPORTS edge, or it proves nothing',
  );
  // Line by line, so a failure shows the lines that differ rather than two whole documents.
  assert.deepEqual(toCanonicalSif(reversed).split('\n'), forwardSif.split('\n'));
});

test('two type-only imports of the same file are type-only, in either order', () => {
  const props = consumerProps(
    ["import type { A } from './a.ts';", "import type { B } from './a.ts';"],
    'type-type',
  );
  const expected = { reExport: false, specifier: './a.ts', typeOnly: true };
  assert.deepEqual(props.forward, expected);
  assert.deepEqual(props.reversed, expected);
});

test('a single type-only import stays type-only', () => {
  const output = extractImports(consumerProject([TYPE_IMPORT]), 'single-type');
  assert.deepEqual(fileImportEdge(output, 'src/consumer.ts', 'src/a.ts').props, {
    reExport: false,
    specifier: './a.ts',
    typeOnly: true,
  });
});

test('a re-export beside an import of the same file reports reExport, in either order', () => {
  const props = consumerProps([VALUE_IMPORT, "export { B } from './a.ts';"], 'import-reexport');
  const expected = { reExport: true, specifier: './a.ts', typeOnly: false };
  assert.deepEqual(props.forward, expected);
  assert.deepEqual(props.reversed, expected);
});

test('a type-only re-export beside a value import does not hide the value dependency', () => {
  const props = consumerProps(
    ["export type { A } from './a.ts';", VALUE_IMPORT],
    'type-reexport-value',
  );
  const expected = { reExport: true, specifier: './a.ts', typeOnly: false };
  assert.deepEqual(props.forward, expected);
  assert.deepEqual(props.reversed, expected);
});

test('a type-only re-export beside a type-only import is type-only and a re-export', () => {
  const props = consumerProps(
    ["export type { B } from './a.ts';", TYPE_IMPORT],
    'type-reexport-type',
  );
  const expected = { reExport: true, specifier: './a.ts', typeOnly: true };
  assert.deepEqual(props.forward, expected);
  assert.deepEqual(props.reversed, expected);
});

test('declarations spelling one target differently keep the smallest specifier, in either order', () => {
  const props = consumerProps([TYPE_IMPORT, "import { makeA } from './a.js';"], 'specifiers');
  const expected = { reExport: false, specifier: './a.js', typeOnly: false };
  assert.deepEqual(props.forward, expected);
  assert.deepEqual(props.reversed, expected);
});

test('imports of two different files keep separate edges with their own facts', () => {
  const output = extractImports(
    sourceProject({
      'src/a.ts': A_TS,
      'src/b.ts': 'export const b = 1;\n',
      'src/consumer.ts': `${TYPE_IMPORT}\nimport { b } from './b.ts';\nexport const marker = b;\n`,
    }),
    'two-targets',
  );
  assert.equal(fileImportEdge(output, 'src/consumer.ts', 'src/a.ts').props['typeOnly'], true);
  assert.equal(fileImportEdge(output, 'src/consumer.ts', 'src/b.ts').props['typeOnly'], false);
});

/* ------------------------------------------------------------ module level */

/**
 * The two-package workspace with `@fixture/api` stripped of its own import of
 * `@fixture/core`, so the only cross-module imports are the ones a test adds.
 */
function workspaceProject(files: Readonly<Record<string, string>>): FileMap {
  return Object.freeze({
    ...WORKSPACE_PROJECT,
    'packages/api/src/index.ts': 'export const api = 1;\n',
    'packages/core/src/extra.ts': 'export const extra = 1;\n',
    ...files,
  });
}

test('the module edge takes the smallest specifier whichever file is walked last', () => {
  const ts = "import type { Money } from '../../core/src/index.ts';\nexport type M = Money;\n";
  const js = "import type { Money } from '../../core/src/index.js';\nexport type N = Money;\n";
  const first = extractImports(
    workspaceProject({ 'packages/api/src/a.ts': ts, 'packages/api/src/b.ts': js }),
    'module-spelling-1',
  );
  const second = extractImports(
    workspaceProject({ 'packages/api/src/a.ts': js, 'packages/api/src/b.ts': ts }),
    'module-spelling-2',
  );
  assert.deepEqual(moduleImportEdge(first, '@fixture/api', '@fixture/core').props, {
    specifier: '../../core/src/index.js',
  });
  assert.deepEqual(moduleImportEdge(second, '@fixture/api', '@fixture/core').props, {
    specifier: '../../core/src/index.js',
  });
});

test('the module edge is attributed to the smallest file pair whatever the statement order', () => {
  const statements = [
    "import { extra } from '../../core/src/extra.ts';",
    "import type { Money } from '../../core/src/index.ts';",
  ];
  const attribution = (order: readonly string[], label: string) => {
    const output = extractImports(
      workspaceProject({
        'packages/api/src/a.ts': `${order.join('\n')}\nexport const used = [extra];\n`,
      }),
      label,
    );
    const edge = moduleImportEdge(output, '@fixture/api', '@fixture/core');
    return { srcFile: edge.srcFile, dstFile: edge.dstFile };
  };
  const expected = { srcFile: 'packages/api/src/a.ts', dstFile: 'packages/core/src/extra.ts' };
  assert.deepEqual(attribution(statements, 'module-pair-forward'), expected);
  assert.deepEqual(attribution([...statements].reverse(), 'module-pair-reversed'), expected);
});
