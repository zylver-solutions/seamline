// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { DEFAULT_LIMITS } from './types.ts';
import { proveWriteClient } from './write-client.ts';
import { prismaWriteModels } from './write-prisma.ts';
import { WriteSource } from './write-source.ts';
import { WRITE_LIBRARY_SUMMARIES } from './write-libraries.ts';

const metadata = `generator client {
 provider = "prisma-client"
 output = "./generated"
 engineType = "client"
}
datasource db {
 provider = "postgresql"
}
model Entry {
 title String @db.VarChar(120)
}
`;
const cached = `import { PrismaClient as Database } from './generated/client';
const CACHE = 'store';
function initialize() {
 const primary = new Database({});
 if (process.env.USE_SECONDARY) {
  const alternate = new Database({});
  globalThis[CACHE] ??= alternate;
  return alternate;
 }
 globalThis[CACHE] ??= primary;
 return primary;
}
const client = globalThis[CACHE] || initialize();
export default {client};`;

function proof(source: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'write-client-'));
  try {
    for (const [path, content] of Object.entries({
      'package.json': '{"name":"@sample/forms"}', 'schema.prisma': metadata,
      'client.ts': source, 'caller.ts': 'import storage from "./client"; const value = storage.client;', ...extra,
    })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const project = new WriteSource(ts, root, DEFAULT_LIMITS);
    const caller = project.parse('caller.ts');
    const statement = caller.statements[1];
    assert.ok(statement !== undefined && ts.isVariableStatement(statement));
    const expression = statement.declarationList.declarations[0]?.initializer;
    assert.ok(expression !== undefined);
    const result = proveWriteClient(project, expression, prismaWriteModels(project));
    return { generated: project.rel(result.lineage.generatedDirectory),
      extensions: result.lineage.extensions, cacheKey: result.cacheKey, boundary: result.sourceBoundary };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('generated client aliases and all supported warm/cold source branches preserve lineage', () => {
  assert.deepEqual(proof(cached), {
    generated: 'generated', extensions: [], cacheKey: 'store', boundary: 'inspected-repository-source',
  });
  const direct = `import { PrismaClient } from './generated/client';
    const client = new PrismaClient({}); export default {client};`;
  assert.equal(proof(direct).generated, 'generated');
  assert.throws(() => proof(direct, { 'other.ts': 'new Function("replaceClient()")();' }), /WRITE_DYNAMIC_CODE/);
  assert.equal(proof(cached, { 'serialize.ts': 'BigInt.prototype.toJSON = function () { return this.toString(); };' }).cacheKey, 'store');
  assert.equal(proof(cached, { 'serialize.ts': 'BigInt.prototype.toJSON = function () { return Number(this); };' }).cacheKey, 'store');
  assert.equal(proof(cached, { 'other.cjs': 'class Local { set(value) { this.store = value; const read = () => this.store; return read(); } }' }).cacheKey, 'store');
  for (const key of ['toString', 'Object', 'process', 'fetch', 'hasOwnProperty'])
    assert.throws(() => proof(cached.replace("CACHE = 'store'", `CACHE = '${key}'`)), /WRITE_CACHE_BUILTIN_KEY/);
  assert.equal(proof(cached, {
    'keys.ts': 'export const METRICS = "metrics";',
    'metrics.ts': 'import { METRICS } from "./keys"; globalThis[METRICS] = metricsClient;',
  }).cacheKey, 'store', 'a distinct imported literal cache key is examined rather than guessed');
});

test('cached and uncached clients receive the same source-world capability scrutiny', () => {
  const direct = `import { PrismaClient } from './generated/client';
    const client = new PrismaClient({}); export default {client};`;
  for (const source of [cached, direct]) {
    for (const other of [
      "import {ZodType} from 'zod'; ZodType.prototype.safeParse = replacement;",
      "import {ZodType} from 'zod'; const alias = ZodType;",
      "import {z} from 'zod'; const alias = z.ZodType;",
      "import {z} from 'zod'; consume(z.string);",
      'const {constructor: extracted} = callable;',
      'const {__proto__: inherited} = object;',
      'const {getPrototypeOf: inherited} = Reflect;',
      'const {[unknownKey]: extracted} = object;',
      "const key = 'constructor'; const extracted = callable[key];",
      "const prefix = 'con'; const key = prefix + 'structor'; const extracted = callable[key];",
      "const key = 'Function'; const extracted = globalThis[key];",
      "const key = 'eval'; const extracted = globalThis[key];",
      'const selected = callable[unknownKey]; selected();',
      "function selectKey() { return 'prototype'; } const inherited = Object[selectKey()]; inherited.store = replacement;",
      "function selectKey() { return 'constructor'; } const bag = {capability: (() => {})[selectKey()]}; bag.capability();",
      "const storage = module['re' + 'quire']('./client'); storage.default.client.entry.update = replacement;",
      "const key = 're' + 'quire'; const native = module[key]('node:module'); native.registerHooks(replacement);",
      'callable[unknownKey]();',
      'const selected = callable[unknownKey]; const alias = selected; alias();',
      'const selected = callable[unknownKey]; selected.bind(null);',
      'const runtime = globalThis.process;',
      'const runtime = global.module;',
      'const runtime = globalThis.require;',
      "const key = 'getBuiltinModule'; const extracted = runtime[key];",
      "const key = 'createRequire'; const extracted = runtime[key];",
      'const extracted = Reflect.get(callable, member);',
      'const {get: extracted} = Reflect;',
      'const extracted = Reflect.get;',
      'process.cwd = replacement;',
      'const changeDirectory = process.chdir;',
      "const key = condition ? 'constructor' : 'safe'; const extracted = callable[key];",
      "const key = condition ? 'safe' : 'eval'; const extracted = globalThis[key];",
      "const key = condition ? '__proto__' : 'safe'; const extracted = object[key];",
      "const key = condition ? 'safe' : 'prototype'; const extracted = object[key];",
    ]) assert.throws(() => proof(source, {'other.ts': other}), /WRITE_/);
  }
  assert.throws(() => proof(direct, {'other.ts': 'export function lookup(input, key) { return input[key]; }'}), /WRITE_COMPUTED_PROPERTY_UNKNOWN/);
  for (const source of [cached, direct]) {
    assert.equal(proof(source, {'other.ts': "const methods = {lighter: value => value, darker: value => value}; methods[theme === 'light' ? 'lighter' : 'darker'](amount);"}).generated, 'generated');
    assert.equal(proof(source, {'other.ts': "const methods = {first: value => value, second: value => value}; const key = condition ? 'first' : 'second'; methods[key](amount);"}).generated, 'generated');
  }
});

test('unknown factory paths, cache writers, global aliases and dynamic keys cannot certify a client', () => {
  for (const [source, extra] of [
    [cached.replace('return alternate', 'return replacement'), {}],
    [cached, { 'other.ts': 'globalThis.store = replacement;' }],
    [cached, { 'other.ts': 'const alias = globalThis; alias.store = replacement;' }],
    [cached, { 'other.ts': 'globalThis[unknownKey] = replacement;' }],
    [cached, { 'other.ts': 'delete globalThis.store;' }],
    [cached, { 'other.ts': 'eval("globalThis.store = replacement");' }],
    [cached, { 'other.ts': 'globalThis["eval"]("globalThis.store = replacement");' }],
    [cached, { 'other.ts': 'new Function("globalThis.store = replacement")();' }],
    [cached, { 'other.ts': 'const compile = (()=>{}).constructor; compile("globalThis.store = replacement")();' }],
    [cached, { 'other.ts': 'Object["prototype"].store = replacement;' }],
    [cached, { 'other.ts': 'const Base = Object; Base.prototype.store = replacement;' }],
    [cached, { 'other.ts': 'import("./client").then(module => {module.default.client = replacement});' }],
    [cached, { 'other.ts': 'const storage = require("./client"); storage.default.client = replacement;' }],
    [cached, { 'other.ts': 'import(unknownModule).then(consume);' }],
    [cached, { 'other.ts': 'import {createRequire} from "node:module"; const load = createRequire(import.meta.url); consume(load);' }],
    [cached, { 'other.ts': 'Object.prototype.store = replacement;' }],
    [cached, { 'other.ts': '({}).__proto__.store = replacement;' }],
    [cached, { 'other.ts': 'Reflect.getPrototypeOf({}).store = replacement;' }],
    [cached, { 'other.ts': 'BigInt.prototype.toJSON = function () { return mutate(this); };' }],
    [cached, { 'other.ts': 'BigInt.prototype.toJSON = function () { return this.toString(); }; BigInt = replacement;' }],
    [cached, { 'other.ts': 'BigInt.prototype.store = replacement;' }],
    [cached, { 'other.ts': 'globalThis.BigInt = replacement;' }],
    [cached, { 'other.ts': 'consume(BigInt);' }],
    [cached, { 'other.ts': 'BigInt.prototype.toJSON = function () { return Number(this); }; Number = replacement;' }],
    [cached, { 'other.ts': 'const Number = replacement; BigInt.prototype.toJSON = function () { return Number(this); };' }],
    [cached, { 'other.ts': 'globalThis.Number = replacement;' }],
    [cached, { 'other.cjs': 'require("node:vm").runInThisContext("globalThis.store = replacement");' }],
    [cached, { 'other.ts': 'import {runInThisContext as execute} from "node:vm"; execute("globalThis.store = replacement");' }],
    [cached, { 'other.cjs': 'module["require"]("vm").compileFunction("globalThis.store = replacement")();' }],
    [cached, { 'other.ts': 'process.getBuiltinModule("vm").runInThisContext("globalThis.store = replacement");' }],
    [cached, { 'other.cjs': 'const load = require; load("vm").runInThisContext("globalThis.store = replacement");' }],
    [cached, { 'other.cjs': 'const nativeLoader = module.require;' }],
    [cached, { 'other.cjs': 'const nativeLoader = module["require"];' }],
    [cached, { 'other.cjs': 'const runtimeModule = process.mainModule;' }],
    [cached, { 'other.ts': 'import runtime from "node:process"; const runtimeModule = runtime.mainModule;' }],
    [cached, { 'other.ts': 'import {mainModule} from "process";' }],
    [cached, { 'other.cjs': 'const runtime = require("node:process");' }],
    [cached, { 'other.cjs': 'const runtime = process; runtime.binding("contextify");' }],
    [cached, { 'other.ts': 'import {z} from "zod"; z.string = replacement;' }],
    [cached, { 'other.ts': 'import * as schemas from "zod"; consume(schemas);' }],
    [cached, { 'other.ts': 'export {z} from "zod";' }],
    [cached, { 'other.cjs': 'store = replacement;' }],
    [cached, { 'other.cjs': 'function poison(){this.store = replacement;} poison();' }],
    [cached, { 'other.cjs': 'class Local { set(){function poison(){this.store = replacement;} poison();} }' }],
    [cached, { 'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./*"],"@/c*":["./c*"]}}}',
      'other.ts': 'import store from "@/client"; store.client.entry.update = replacement;' }],
    [cached, { 'other.ts': 'import store from "./client"; store.client = replacement;' }],
    [cached, { 'other.ts': 'import store from "./client"; store.client.entry.update = replacement;' }],
    [cached, { 'other.ts': 'import store from "./client"; const {client} = store; const alias = client; consume(alias);' }],
    [cached, { 'other.ts': 'import {PrismaClient} from "./generated/client"; PrismaClient.prototype.entry = replacement;' }],
    [cached, { 'other.ts': 'export {default as store} from "./client";' }],
    [cached, { 'generated/client.ts': 'export class PrismaClient {}' }],
    [cached.replace('./generated/client', './unrelated/client'), {}],
    [cached.replace('function initialize()', 'async function initialize()'), {}],
    [cached.replace('function initialize()', 'function* initialize()'), {}],
    [cached.replace('const primary = new Database({});', 'const primary = new Database({}); primary.entry = replacement;'), {}],
    [cached.replace('const primary = new Database({});', 'const primary = new Database({}); consume(primary);'), {}],
    [cached.replace('new Database({})', 'new Database({__internal: modify})'), {}],
  ] as const) assert.throws(() => proof(source, { ...extra }), /WRITE_/);
});

test('the pinned replica summary admits only unchanged writes and readonly client selectors', () => {
  const extended = `import {PrismaClient as Database} from './generated/client';
    import {readReplicas} from '@prisma/extension-read-replicas';
    const CACHE = 'store';
    function initialize() {
      const primary = new Database({});
      const replica = new Database({});
      const expanded = primary.$extends(readReplicas({replicas: [replica]}));
      globalThis[CACHE] ??= expanded;
      return expanded;
    }
    const client = globalThis[CACHE] || initialize();
    function count() {
      if ('$replica' in client) { return client.$replica().entry.count(); }
      return client.entry.count();
    }
    export default {client, count};`;
  const extra = {
    'package.json': JSON.stringify({ name: '@sample/forms', dependencies: {
      '@prisma/client': '7.6.0', '@prisma/extension-read-replicas': '0.5.0',
    } }),
    'pnpm-lock.yaml': `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@prisma/client': {specifier: 7.6.0, version: 7.6.0}
      '@prisma/extension-read-replicas': {specifier: 0.5.0, version: 0.5.0(@prisma/client@7.6.0)}
packages:
  '@prisma/extension-read-replicas@0.5.0':
    resolution: {integrity: ${WRITE_LIBRARY_SUMMARIES['@prisma/extension-read-replicas'].integrity}}
`,
  };
  assert.deepEqual(proof(extended, extra).extensions, ['@prisma/extension-read-replicas@0.5.0']);
  assert.throws(() => proof(extended, { ...extra, 'tsconfig.json': '{"compilerOptions":{"paths":{"@prisma/extension-read-replicas":["./replacement.ts"]}}}' }), /WRITE_LIBRARY_SOURCE_ALIAS/);
  for (const source of [
    extended.replace('readReplicas({replicas: [replica]})', 'unreviewed({replicas: [replica]})'),
    extended.replace('{replicas: [replica]}', '{replicas: [replica], rewrite: clip}'),
    extended.replace('return client.$replica().entry.count()', 'const alias = client.$primary(); alias.entry.update = replacement; return 0'),
    extended.replace('return client.$replica().entry.count()', 'return client.$replica(argument).entry.count()'),
  ]) assert.throws(() => proof(source, extra), /WRITE_/);
  assert.throws(() => proof(extended, { ...extra,
    'pnpm-lock.yaml': extra['pnpm-lock.yaml'].replace(WRITE_LIBRARY_SUMMARIES['@prisma/extension-read-replicas'].integrity, 'sha512-other'),
  }), /WRITE_/);
});


test('a native loader may only read checked package metadata without escaping', () => {
  const metadata = `import path from 'node:path'; import {createRequire as makeLoader} from 'module';
    const read = makeLoader(import.meta.url); const pkg = read(path.resolve(process.cwd(), 'package.json'));`;
  assert.equal(proof(cached, {'metadata.mjs': metadata}).cacheKey, 'store');
  for (const source of [
    metadata.replace("'package.json'", "'client.ts'"),
    metadata.replace('const pkg =', 'consume(read); const pkg ='),
    metadata.replace('const read =', 'export const read ='),
    metadata.replace('const pkg =', 'read.extensions = replacement; const pkg ='),
    metadata.replace('const pkg =', 'path.resolve = replacement; const pkg ='),
    metadata.replace('const pkg =', 'consume(path); const pkg ='),
    metadata.replace('makeLoader(import.meta.url)', 'makeLoader(otherURL)'),
  ]) assert.throws(() => proof(cached, {'metadata.mjs': source}), /WRITE_/);
  assert.throws(() => proof(cached, {'metadata.mjs': metadata, 'nested/package.json/index.js': 'export default replacement;'}), /WRITE_/);
});


test('client aliases cannot escape through named exports, exported factories or extra global keys', () => {
  const direct = `import {PrismaClient} from './generated/client'; const client = new PrismaClient({});
    export default {client};`;
  for (const [source, extra] of [
    [direct.replace('const client =', 'export const client ='), {}],
    [direct.replace('export default {client};', 'const box = {client}; export {box};'),
      {'caller.ts': 'import {box} from "./client"; const value = box.client;'}],
    [direct.replace('export default {client};', 'export const box = {client};'),
      {'caller.ts': 'import {box} from "./client"; const value = box.client;'}],
    [cached + '\nexport {initialize};', {}],
    [cached + '\nconst other = initialize(); other.entry.update = replacement;', {}],
    [cached.replace('globalThis[CACHE] ??= primary;', 'globalThis[CACHE] ??= primary; globalThis.secondary = primary;'), {}],
    [cached.replace('const client = globalThis[CACHE] || initialize();', 'const client = initialize();'), {}],
    [direct, {'other.ts': 'import store from "./client"; export const box = store;'}],
    [direct, {'other.ts': 'import store from "#storage"; store.client.entry.update = replacement;',
      'package.json': '{"name":"@sample/forms","imports":{"#storage":"./client.ts"}}'}],
  ] as const) assert.throws(() => proof(source, {...extra}), /WRITE_/);
});

test('disjoint relative barrels consume no client resolutions, while aliases remain refused', () => {
  const extra: Record<string,string> = {};
  for (let index = 0; index < 70; index++) extra[`hooks/item${index}.ts`] = `export const item${index} = 1;`;
  extra['hooks/index.ts'] = Array.from({length:70}, (_, index) => `export * from './item${index}';`).join('\n');
  assert.equal(proof(cached, extra).cacheKey, 'store');
  assert.throws(() => proof(cached, {...extra,
    'hooks/index.ts': extra['hooks/index.ts'] + '\nexport {default as store} from "../client";',
  }), /WRITE_CLIENT_EXPORT_ALIAS_UNSUPPORTED/);
  assert.throws(() => proof(cached, {...extra, 'bridge.ts': 'export * from "./generated/client";'}), /WRITE_GENERATED_CONSTRUCTOR_REEXPORT/);
  assert.throws(() => proof(cached, {...extra, 'hooks/package.json': '{"name":"@sample/hooks"}'}), /WRITE_IMPORT_CAP/);
});

test('single-target source aliases exclude disjoint barrels without hiding client aliases', () => {
  const extra: Record<string, string> = {
    'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./*"]}}}',
  };
  for (let index = 0; index < 70; index++) extra[`hooks/item${index}.ts`] = `export const item${index} = 1;`;
  extra['hooks/index.ts'] = Array.from({length:70}, (_, index) => `export * from '@/hooks/item${index}';`).join('\n');
  assert.equal(proof(cached, extra).cacheKey, 'store');
  assert.throws(() => proof(cached, {...extra,
    'hooks/index.ts': extra['hooks/index.ts'] + '\nexport {default as store} from "@/client";',
  }), /WRITE_CLIENT_EXPORT_ALIAS_UNSUPPORTED/);
  assert.throws(() => proof(cached, {...extra,
    'bridge.ts': 'export * from "@/generated/client";',
  }), /WRITE_GENERATED_CONSTRUCTOR_REEXPORT/);
  assert.throws(() => proof(cached, {...extra,
    'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./*","./other/*"]}}}',
  }), /WRITE_LIBRARY_SOURCE_ALIAS/);
  assert.throws(() => proof(cached, {...extra,
    'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./*"],"@/hooks/*":["./*"]}}}',
  }), /WRITE_ALIAS_AMBIGUOUS/);
});


test('transaction callback and query-list consumers cannot escape or mutate the client', () => {
  const prefix = `import store from './client';`;
  for (const source of [
    `${prefix} store.client.$transaction(async tx => { return tx.entry.count(); });`,
    `${prefix} const handler = async tx => tx.entry.count(); store.client.$transaction(handler);`,
    `${prefix} const work = []; store.client.$transaction(work);`,
    `${prefix} store.client.$transaction([]);`,
  ]) assert.equal(proof(cached, {'other.ts': source}).cacheKey, 'store');
  for (const source of [
    `${prefix} store.client.$transaction(async tx => { const raw = tx._extensions; raw.isEmpty = () => false; });`,
    `${prefix} store.client.$transaction(async tx => { const raw = tx._originalClient; raw._request = replacement; });`,
    `${prefix} store.client.$transaction(async tx => { tx.entry.update = replacement; });`,
    `${prefix} store.client.$transaction(async tx => { consume(tx); });`,
    `${prefix} store.client.$transaction(async tx => tx);`,
    `${prefix} store.client.$transaction(function(tx) { const raw = arguments[0]; consume(raw); });`,
    `${prefix} store.client.$transaction(opaque);`,
    `${prefix} const handler = async tx => tx.entry.count(); handler = replacement; store.client.$transaction(handler);`,
    `${prefix} store.client.$transaction(async tx => { const read = () => tx; return read(); });`,
  ]) assert.throws(() => proof(cached, {'other.ts': source}), /WRITE_/);
});

test('source-proved transaction dispatchers validate every exposed callback use', () => {
  const dispatched = cached.replace('export default {client};', `function batch(input, options) { return client.$transaction(input, options); }
    export default {client, batch};`);
  assert.equal(proof(dispatched, {'other.ts': 'import store from "./client"; store.batch(async tx => tx.entry.count());'}).cacheKey, 'store');
  assert.equal(proof(dispatched, {'other.ts': 'import store from "./client"; const rows = []; store.batch(rows);'}).cacheKey, 'store');
  for (const source of [
    'import store from "./client"; store.batch(async tx => {tx._extensions.isEmpty = replacement});',
    'import store from "./client"; const batch = store.batch; batch(opaque);',
    'import store from "./client"; store.batch(opaque);',
  ]) assert.throws(() => proof(dispatched, {'other.ts':source}), /WRITE_/);
});

test('destructured transaction dispatchers cannot bypass callback inspection', () => {
  const dispatched = cached.replace('export default {client};', `function batch(input, options) { return client.$transaction(input, options); }
    export default {client, batch};`);
  assert.equal(proof(dispatched, {'other.ts': 'import store from "./client"; const {client} = store; client.entry.count();'}).cacheKey,
    'store', 'the known client member retains its readonly alias proof');
  for (const source of [
    'import store from "./client"; const {batch} = store; batch(async tx => { const raw = tx._originalClient; raw._request = replacement; });',
    'import store from "./client"; const {batch: runBatch} = store; runBatch(async tx => { tx.entry.update = replacement; });',
    'import store from "./client"; const alias = store; const {batch} = alias; batch(opaque);',
  ]) assert.throws(() => proof(dispatched, {'other.ts': source}), /WRITE_/);
});

test('the base-client query event method returns a tracked alias', () => {
  assert.equal(proof(cached, {'other.ts':'import store from "./client"; const alias = store.client.$on("query", log); alias.entry.count();'}).cacheKey, 'store');
  assert.throws(() => proof(cached, {'other.ts':'import store from "./client"; const alias = store.client.$on("query", log); alias.entry.update = replacement;'}), /WRITE_/);
});
