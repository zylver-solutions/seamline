// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { DEFAULT_LIMITS } from './types.ts';
import { WRITE_FILES, WRITE_ROUTE } from './write-test-support.ts';
import { proveLocalWrite, type LocalWriteProof } from './write-binding.ts';
import { decodeWriteContractName } from './write-identity.ts';
import { prismaWriteModels } from './write-prisma.ts';
import { WriteSource, WriteUnknown } from './write-source.ts';

const route = WRITE_ROUTE;
const sources = WRITE_FILES;

function proof(source: string, extra: Record<string, string> = {}): LocalWriteProof {
  const root = mkdtempSync(join(tmpdir(), 'write-binding-'));
  try {
    for (const [path, content] of Object.entries({ ...sources, 'src/app/items/route.ts': source, ...extra })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const project = new WriteSource(ts, root, DEFAULT_LIMITS);
    const file = project.parse('src/app/items/route.ts');
    const fn = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'POST');
    assert.ok(fn !== undefined && ts.isFunctionDeclaration(fn) && fn.body !== undefined);
    const first = fn.body.statements.find(ts.isVariableStatement);
    const schema = first?.declarationList.declarations[0];
    assert.ok(schema !== undefined);
    return proveLocalWrite(project, file, fn, schema, prismaWriteModels(project));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function admitted(source: string): boolean {
  try { return proof(source).admitted; }
  catch (error) { if (!(error instanceof WriteUnknown)) throw error; return false; }
}

test('a caller containing an awaited parse must be an async handler', () => {
  const invalid = route.replace('export async function POST', 'export function POST');
  assert.notEqual(invalid, route);
  assert.equal(admitted(invalid), false);
});

test('the complete caller binds optional strings while an unsupported enum field stays unknown', () => {
  const result = proof(route);
  assert.equal(result.admitted, true);
  assert.equal(result.identityComplete, true, 'all output uses reach the same proved wrapper');
  assert.deepEqual(result.fields.map(field => [field.name, field.complete]), [['title', true], ['caption', true], ['kind', false]]);
  assert.deepEqual(result.fields[0]?.length, { state: 'unbounded' });
  assert.equal(result.fields[0]?.required, false);
  assert.equal(result.fields[0]?.storageField, 'title');
  assert.equal(result.persistence.model.model, 'Entry');
  assert.deepEqual(decodeWriteContractName(result.name), ['@sample/forms', ['POST', 'schema'], ['@sample/forms', ['persist']], 'Entry']);
  const limited = proof(route.replace('title: z.string().optional()', 'title: z.string().max(80).optional()'));
  assert.deepEqual(limited.fields[0]?.length, { state: 'bounded', maxLength: 80 });
  assert.equal(limited.fields[0]?.complete, true);
  assert.equal(limited.name, result.name, 'changing a limit is not a declared identity input');
});

test('a names-only reservation carries no client proof, field admission or current identity authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'write-reservation-'));
  try {
    for (const [path, content] of Object.entries({ ...sources, 'src/app/items/route.ts': route })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const project = new WriteSource(ts, root, DEFAULT_LIMITS);
    const file = project.parse('src/app/items/route.ts');
    const fn = file.statements.find(ts.isFunctionDeclaration);
    assert.ok(fn?.body !== undefined);
    const schema = fn.body.statements.find(ts.isVariableStatement)?.declarationList.declarations[0];
    assert.ok(schema !== undefined);
    const reserved = proveLocalWrite(project, file, fn, schema, prismaWriteModels(project), true);
    assert.equal(reserved.admitted, false);
    assert.equal(reserved.identityComplete, false);
    assert.equal(reserved.persistence.purpose, 'identity-reservation');
    assert.equal('client' in reserved.persistence, false);
    assert.ok(reserved.fields.every(field => field.complete === false && field.length.state === 'unknown'));
    assert.deepEqual(decodeWriteContractName(reserved.name), ['@sample/forms', ['POST', 'schema'], ['@sample/forms', ['persist']], 'Entry']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a surviving field does not exhaust an opaque second persistence identity', () => {
  for (const extra of ['await writers.saveOther({caption: body.caption});',
    'await opaque({caption: body.caption});']) {
    const result = proof(route.replace('const kind =', extra + ' const kind ='));
    assert.equal(result.admitted, true, 'the title field has a candidate proof, separate from contract admission');
    assert.equal(result.fields.find(field => field.name === 'title')?.complete, true);
    assert.equal(result.fields.find(field => field.name === 'caption')?.complete, false);
    assert.equal(result.identityComplete, false, 'an unproved output use retains its possible wrapper/model keys');
  }
  const originalOpaque = proof(route.replace('const kind = body.kind', 'const kind = normalize(body.kind)'));
  assert.equal(originalOpaque.admitted, true);
  assert.equal(originalOpaque.identityComplete, false, 'the earlier undefined normalizer is not a complete positive control');
});

test('field clipping, imperative filters and object mutation invalidate only the affected primitive', () => {
  for (const source of [
    route.replace('{title, caption, kind}', '{title: clip(title), caption, kind}'),
    route.replace('const kind =', 'if (title.length > 120) return invalid(); const kind ='),
    route.replace('const kind =', 'const alias = body; alias.title = "short"; const kind ='),
  ]) {
    const result = proof(source);
    assert.equal(result.fields.find(field => field.name === 'title')?.complete, false);
    assert.equal(result.fields.find(field => field.name === 'caption')?.complete, true);
  }
  assert.equal(admitted(route.replace('const kind =', 'consume(body); const kind =')), false);
});

test('an unknown method receives the parsed object and invalidates every protected field', () => {
  const withAction = route.replace("kind: z.enum(['note'])", "kind: z.enum(['note']), action: z.string().transform(() => new Clip().clip)")
    .replace('export async function POST', 'class Clip { clip() { this.title = this.title.slice(0, 2); } } export async function POST');
  assert.equal(admitted(withAction), true, 'the class and unknown extra field alone do not remove another field proof');
  for (const call of ['body.action()', '(body.action)()', '(body.action as Callable)()', 'body.action?.()', 'body.action`payload`']) {
    const source = withAction.replace('const {title, caption} = body;', `${call}; const {title, caption} = body;`);
    assert.notEqual(source, route);
    assert.equal(admitted(source), false, call);
  }
});

test('unreachable writes, unknown controls and unguarded parsing never supply a binding', () => {
  for (const source of [
    route.replace('if (error) { return error(); }', 'if (error) { log(error); }'),
    route.replace('try {', 'return render(); try {'),
    route.replace('try {', 'if (false) {').replace('} catch (issue) { return failed(issue); }', '}'),
    route.replace('try {', 'const enabled = false; if (enabled) {').replace('} catch (issue) { return failed(issue); }', '}'),
    route.replace('try {', 'while (true) {} try {'),
    route.replace('export async function POST', 'export async function* POST'),
    route.replace('const schema =', 'return render(); const schema ='),
    route.replace('const {body, error} = await decode(request, schema)', 'const {body, error} = await decode(changed, schema)'),
    route.replace('{title, caption, kind}', '{...replacement, title, caption, kind}'),
  ]) assert.equal(admitted(source), false, source);
  assert.equal(admitted(route.replace('const kind =', 'if (false) { while (true) {} } const kind =')), true,
    'a statically disjoint branch is excluded before its unsupported loop');
});


test('a second Zod namespace must not escape or be mutated', () => {
  const extraNamespace = route.replace("import {z} from 'zod';", "import {z} from 'zod'; import * as fields from 'zod';")
    .replace('title: z.string()', 'title: fields.string()');
  assert.equal(proof(extraNamespace).fields[0]?.complete, true);
  for (const prefix of ['consume(fields);', 'fields.string = replacement;'])
    assert.equal(admitted(extraNamespace.replace('const schema =', `${prefix} const schema =`)), false);
});


test('Zod semantics cannot be supplied by source aliases or dependency substitution', () => {
  for (const extra of [
    {'tsconfig.json': '{"compilerOptions":{"paths":{"zod":["./src/replacement.ts"]}}}'},
    {'tsconfig.json': '{"compilerOptions":{"baseUrl":"./src"}}', 'src/zod.ts': 'export const z = replacement;'},
    {'package.json': '{"name":"@sample/forms","dependencies":{"next":"16.2.6","zod":"npm:replacement@1.0.0"}}'},
  ]) assert.throws(() => proof(route, extra), /WRITE_LIBRARY_SOURCE_ALIAS/);
});
