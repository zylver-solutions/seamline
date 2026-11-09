/**
 * The `library` prop on value Symbols, read from real extraction.
 *
 * `infer-join` recognizes a validator only from this prop plus `symbolKind`,
 * so these tests pin both facts on the nodes the extractor actually emits: a
 * value built through a validation library carries the library's package
 * name, and nothing else carries a `library` prop at all.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SeamlineNode } from '@seamline/ontology';
import { extractCodeTs } from './extract.ts';
import { VALIDATION_PROJECT, cleanup, materialize } from './__fixtures__/projects.ts';

const root = materialize(VALIDATION_PROJECT, 'validation');
const output = extractCodeTs({ repoRoot: root, repo: 'fixture', runId: 'run-1', deterministic: true });

after(() => cleanup(root));

function symbol(name: string): SeamlineNode {
  const found = output.nodes.filter((n) => n.kind === 'Symbol' && n.name === name);
  assert.equal(found.length, 1, `expected one Symbol named ${name}`);
  const [only] = found;
  assert.ok(only !== undefined);
  return only;
}

test('the fixture extracts as PASS without any validation library installed', () => {
  assert.equal(output.result.status, 'PASS');
});

test('a value built through a validation library carries the library package name', () => {
  const expected: ReadonlyArray<readonly [string, string]> = [
    ['RowSchema', 'zod'],
    ['RowSchemaV4', 'zod'],
    ['LegacyRowSchema', 'yup'],
    ['StructRow', 'superstruct'],
    ['BoxedRow', '@sinclair/typebox'],
  ];
  for (const [name, library] of expected) {
    const node = symbol(name);
    assert.equal(node.props['symbolKind'], 'variable', name);
    assert.equal(node.props['library'], library, name);
  }
});

test('a type declaration never carries a library prop, whatever its name', () => {
  const declarations: ReadonlyArray<readonly [string, string]> = [
    ['Row', 'interface'], ['RowConstraints', 'interface'], ['RowShape', 'type-alias'],
  ];
  for (const [name, symbolKind] of declarations) {
    const node = symbol(name);
    assert.equal(node.props['symbolKind'], symbolKind, name);
    assert.equal('library' in node.props, false, name);
  }
});

test('a value not built by a validation library call carries no library prop', () => {
  for (const name of ['HelperRowSchema', 'zodAlias', 'plainRowSchema']) {
    const node = symbol(name);
    assert.equal(node.props['symbolKind'], 'variable', name);
    assert.equal('library' in node.props, false, name);
  }
});
