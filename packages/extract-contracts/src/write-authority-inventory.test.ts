// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';
import { DEFAULT_LIMITS } from './types.ts';
import { makeWriteFixture, WRITE_ROUTE } from './write-test-support.ts';
import { WriteSource, writeInventory } from './write-source.ts';
import { couldShareWriteIdentity, inventoryWriteAuthority } from './write-authority-inventory.ts';

function inventory(root: string) {
  const files = writeInventory(root, DEFAULT_LIMITS.maxFiles);
  return inventoryWriteAuthority(new WriteSource(ts, root, DEFAULT_LIMITS, files), files, ['src/app/items/route.ts']);
}

test('opaque binding names are inventoried in unselected routes without recognizing a parser call', () => {
  const fixture = makeWriteFixture({ 'src/app/other/route.ts':
    'export async function POST(request) { const otherSchema = makeSchema(); const first = await opaque(otherSchema); const second = first; return second.body; }' });
  try {
    const found = inventory(fixture.root);
    assert.equal(found.complete, true);
    assert.equal(found.handlerFiles.has('src/app/items/route.ts'), true);
    assert.equal(found.handlerFiles.has('src/app/other/route.ts'), true);
    const unknown = found.slots.find(slot => slot.file === 'src/app/other/route.ts' && slot.schema === 'otherSchema');
    assert.ok(unknown !== undefined);
    assert.equal(couldShareWriteIdentity(unknown, { owner: '@sample/forms', method: 'POST', schema: 'otherSchema' }), true);
    assert.equal(couldShareWriteIdentity(unknown, { owner: '@sample/forms', method: 'POST', schema: 'schema' }), false);
    assert.equal(couldShareWriteIdentity(unknown, { owner: '@different/forms', method: 'POST', schema: 'otherSchema' }), false);
  } finally { fixture.dispose(); }
});

test('unsupported HTTP exports reserve unknown schema and persistence identities', () => {
  for (const source of [
    "export * as POST from './handler';", 'export class POST {}',
    'export enum POST { value }', "export import POST = require('./handler');",
    'export const POST = opaque;', "export { handler as POST } from './handler';",
    "export * from './handler';", 'module.exports[method] = opaque;',
  ]) {
    const fixture = makeWriteFixture({ 'src/app/other/route.ts': source });
    try {
      const found = inventory(fixture.root);
      assert.equal(found.handlerFiles.has('src/app/other/route.ts'), true, source);
      assert.equal(found.slots.some(slot => slot.file === 'src/app/other/route.ts' && slot.schema === undefined &&
        couldShareWriteIdentity(slot, { owner: '@sample/forms', method: 'POST', schema: 'schema' })), true, source);
    } finally { fixture.dispose(); }
  }
});

test('a completely read GET-only route permits ordinary handler disappearance', () => {
  const fixture = makeWriteFixture({ 'src/app/items/route.ts': WRITE_ROUTE.replace('function POST', 'function GET') });
  try {
    const found = inventory(fixture.root);
    assert.equal(found.complete, true);
    assert.equal(found.handlerFiles.has('src/app/items/route.ts'), false);
    assert.deepEqual(found.slots, []);
  } finally { fixture.dispose(); }
});

test('parse failure and syntax exhaustion preserve global identity uncertainty', () => {
  for (const source of ['export async function POST( {',
    'export async function POST(request) {' + Array.from({ length: 3_000 }, (_, i) => `const item${i} = ${i};`).join('') + '}']) {
    const fixture = makeWriteFixture({ 'src/app/other/route.ts': source });
    try {
      const found = inventory(fixture.root);
      assert.equal(found.complete, false);
      const unknown = found.slots.find(slot => slot.file === 'src/app/other/route.ts' && slot.method === undefined);
      assert.ok(unknown !== undefined);
      assert.equal(couldShareWriteIdentity(unknown, { owner: '@any/forms', method: 'PATCH', schema: 'anything' }), true);
    } finally { fixture.dispose(); }
  }
});
