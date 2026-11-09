// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteSource } from './write-source.ts';
import { DEFAULT_LIMITS } from './types.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';
import { isLibraryBinding, lexicalBinding, references, rejectDynamicCode, writtenThrough } from './write-syntax.ts';

function identifiers(source: string, name: string): { file: ts.SourceFile; ids: ts.Identifier[] } {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const ids: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) ids.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { file, ids };
}

test('library provenance follows the lexical import and refuses function, block and var shadows', () => {
  const { ids } = identifiers(`import { z } from 'zod';
    z.string();
    function shadow(z: any) { z.string(); }
    function block() { { const z = replacement; z.string(); } }
    function hoisted() { z.string(); if (true) { var z = replacement; } }
    z.string();`, 'z');
  const uses = ids.filter(id => ts.isPropertyAccessExpression(id.parent) && id.parent.expression === id);
  const root = mkdtempSync(join(tmpdir(), 'write-library-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"@sample/forms"}');
    const project = new WriteSource(ts, root, DEFAULT_LIMITS);
    assert.deepEqual(uses.map(id => isLibraryBinding(project, id, 'zod', 'z')), [true, false, false, false, true]);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('object writes, replacement, increment and delete are visible through binding references', () => {
  const { file, ids } = identifiers(`const body = {}; body.title = 'changed'; body['title']++;
    delete body.title; consume(body); function unrelated(body: any) { body.title = 'other'; }`, 'body');
  const binding = ids[0];
  assert.ok(binding !== undefined);
  const refs = references(ts, file, binding);
  assert.equal(refs.length, 4);
  assert.deepEqual(refs.map(ref => writtenThrough(ts, ref)), [true, true, true, false]);
  assert.ok(refs.every(ref => lexicalBinding(ts, ref) === binding));
});

test('implicit argument values are refused while ordinary argument-named properties remain data', () => {
  const root = mkdtempSync(join(tmpdir(), 'write-implicit-arguments-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"@sample/forms"}');
    const project = new WriteSource(ts, root, DEFAULT_LIMITS);
    const data = identifiers("const item = {arguments: 'value'}; item.arguments;", 'arguments');
    assert.doesNotThrow(() => rejectDynamicCode(project, data.file));
    for (const source of ['function read() { return arguments[0]; }',
      'function read() { const alias = arguments; return alias[0]; }',
      'function read() { return (() => arguments[0])(); }']) {
      assert.throws(() => rejectDynamicCode(project, identifiers(source, 'arguments').file), /WRITE_IMPLICIT_ARGUMENTS_ALIAS/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('assignment destructuring retains strict capability extraction refusals', () => {
  const root = mkdtempSync(join(tmpdir(), 'write-assignment-pattern-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"name":"@sample/forms"}');
    const project = new WriteSource(ts, root, DEFAULT_LIMITS);
    for (const source of [
      'let item; ({constructor: item} = {});',
      "let item; ({['constructor']: item} = {});",
      'let constructor; ({constructor} = {});',
      'let item; ({outer: {constructor: item}} = value);',
      'let item; ([{constructor: item}] = value);',
      'let item; for ({constructor: item} of values) {}',
      'let item; ({[unknownKey]: item} = value);',
    ]) assert.throws(() => rejectDynamicCode(project, identifiers(source, 'item').file), /WRITE_DYNAMIC_PROPERTY_EXTRACTION/);
    for (const source of ['const value = {constructor: 1};', 'let item; ({data: item} = value);'])
      assert.doesNotThrow(() => rejectDynamicCode(project, identifiers(source, 'item').file));
  } finally { rmSync(root, {recursive: true, force: true}); }
});
