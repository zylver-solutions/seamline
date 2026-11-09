// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { DEFAULT_LIMITS } from './types.ts';
import { nextWriteMethod } from './write-framework.ts';
import { lockedVersion, WRITE_LIBRARY_SUMMARIES } from './write-libraries.ts';
import { prismaWriteModels } from './write-prisma.ts';
import { WriteSource } from './write-source.ts';
import { extractContracts } from './extract.ts';
import { isCanonicalSelectorText } from '@seamline/core';
import { makeWriteFixture, WRITE_FILES, writeFixtureIndex } from './write-test-support.ts';

const lock = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      next: {specifier: 16.2.6, version: 16.2.6}
      next-intl: {specifier: 4.9.2, version: 4.9.2(next@16.2.6)}
packages:
  next@16.2.6:
    resolution: {integrity: sha512-qOVgKJg1+At15NpeUP+eJgCHvTCgXsogweq87Ri/Ix7PkqQHg4sdaXmSFqKlgaIXE4kW0g25LE68W87UANlHtw==}
  next-intl@4.9.2:
    resolution: {integrity: ${WRITE_LIBRARY_SUMMARIES['next-intl'].integrity}}
`;

function setup(extra: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'write-metadata-'));
  const files = {
    'package.json': JSON.stringify({ name: '@sample/forms', dependencies: { next: '16.2.6', 'next-intl': '4.9.2' } }),
    'pnpm-lock.yaml': lock,
    'src/app/items/route.ts': 'export async function POST(request: Request) { return request; }',
    ...extra,
  };
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  }
  const project = new WriteSource(ts, root, DEFAULT_LIMITS);
  return { project, close: () => rmSync(root, { recursive: true, force: true }) };
}

function method(project: WriteSource): string {
  const file = project.parse('src/app/items/route.ts');
  const fn = file.statements.find(ts.isFunctionDeclaration);
  assert.ok(fn !== undefined);
  return nextWriteMethod(project, file, fn);
}

test('Next method eligibility requires direct route export, supported metadata and known extensions', () => {
  const repo = setup({});
  try { assert.equal(method(repo.project), 'POST'); } finally { repo.close(); }
  for (const extra of [
    { 'next.config.ts': 'export default {pageExtensions: ["custom.ts"]};' },
    { 'next.config.ts': 'export default {...custom};' },
    { 'next.config.ts': 'export default unknown({});' },
    { 'next.config.ts': 'export default {webpack(config) {return rewrite(config);}};' },
    { 'next.config.ts': 'export default {turbopack: {resolveAlias: {zod: "./replacement"}}};' },
    { 'pnpm-lock.yaml': lock.replaceAll('16.2.6', '16.2.5') },
    { 'src/app/items/route.ts': 'async function POST(request: Request) { return request; } export { POST };' },
  ]) {
    const rejected = setup(extra);
    try { assert.throws(() => method(rejected.project), /WRITE_/); } finally { rejected.close(); }
  }
});

test('the reviewed locale wrapper preserves page extensions only at its exact artifact and option shape', () => {
  const config = `import plugin from 'next-intl/plugin'; const withLocale = plugin('./src/request.ts');
    export default withLocale({output: 'standalone', async headers() { return []; }});`;
  const repo = setup({ 'next.config.ts': config });
  try {
    assert.equal(method(repo.project), 'POST');
    assert.equal(lockedVersion(repo.project, repo.project.parse('next.config.ts'), 'next-intl'), '4.9.2');
  } finally { repo.close(); }
  for (const extra of [
    { 'next.config.ts': config.replace("'./src/request.ts'", '{experimental: true}') },
    { 'pnpm-lock.yaml': lock.replace(WRITE_LIBRARY_SUMMARIES['next-intl'].integrity, 'sha512-unreviewed') },
    { '.pnpmfile.cjs': 'module.exports = {hooks: {readPackage: mutate}};' },
    { 'tsconfig.json': '{"compilerOptions":{"paths":{"next-intl/plugin":["./src/custom.ts"]}}}' },
    { 'pnpm-workspace.yaml': 'overrides:\n  next-intl: replacement\n' },
    { 'next.config.ts': config.replace("export default", 'withLocale = replacement; export default') },
  ]) {
    const rejected = setup({ 'next.config.ts': config, ...extra });
    try { assert.throws(() => method(rejected.project), /WRITE_/); } finally { rejected.close(); }
  }
});

test('query-validator artifact eligibility requires independent exact lock identity and ordinary resolution', () => {
  // Independent artifact identity: changing the production table cannot also
  // change this lock fixture and make a replacement artifact pass vacuously.
  const integrity = 'sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg==';
  const manifest = (reference = '4.3.6') => JSON.stringify({ name: '@sample/forms',
    dependencies: { next: '16.2.6', zod: reference } });
  const validatorLock = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      zod: {specifier: 4.3.6, version: 4.3.6}
packages:
  zod@4.3.6:
    resolution: {integrity: ${integrity}}
`;
  const eligible = setup({ 'package.json': manifest(), 'pnpm-lock.yaml': validatorLock });
  try {
    assert.equal(lockedVersion(eligible.project, eligible.project.parse('src/app/items/route.ts'), 'zod'), '4.3.6');
  } finally { eligible.close(); }
  for (const extra of [
    { 'pnpm-lock.yaml': validatorLock.replace(integrity, 'sha512-unreviewed') },
    { 'package.json': manifest('4.3.7'), 'pnpm-lock.yaml': validatorLock.replaceAll('4.3.6', '4.3.7') },
    { 'package.json': manifest('file:./replacement'),
      'pnpm-lock.yaml': validatorLock.replace('specifier: 4.3.6', 'specifier: file:./replacement') },
    { 'pnpm-workspace.yaml': 'overrides:\n  zod: replacement\n' },
    { '.pnpmfile.cjs': 'module.exports = {hooks: {readPackage: replace}};' },
    { '.npmrc': 'registry=https://registry.invalid/\n' },
    { 'tsconfig.json': '{"compilerOptions":{"paths":{"zod":["./replacement"]}}}' },
  ]) {
    const rejected = setup({ 'package.json': manifest(), 'pnpm-lock.yaml': validatorLock, ...extra });
    try {
      assert.throws(() => lockedVersion(rejected.project, rejected.project.parse('src/app/items/route.ts'), 'zod'), /WRITE_/);
    } finally { rejected.close(); }
  }
});

const schema = `generator client {
  provider = "prisma-client"
  output = "../src/generated/prisma"
  engineType = "client"
}
datasource db {
  provider = "postgresql"
}
model Entry {
  id String @id
  title String @db.VarChar(120)
  caption String? @map("caption_text") @db.VarChar(240)
  aliases String[]
  count Int
  ignored String @ignore
  @@map("entries")
}
`;

test('declared Prisma generator lineage preserves model and physical field mappings without output present', () => {
  const repo = setup({ 'prisma/schema.prisma': schema });
  try {
    const models = prismaWriteModels(repo.project);
    assert.equal(models.length, 1);
    const model = models[0];
    assert.ok(model !== undefined);
    assert.equal(model.model, 'Entry');
    assert.equal(model.table, 'entries');
    assert.equal(model.schema, 'public');
    assert.equal(repo.project.rel(model.generatedDirectory), 'src/generated/prisma');
    assert.deepEqual([...model.fields], [['id', 'id'], ['title', 'title'], ['caption', 'caption_text']]);
  } finally { repo.close(); }
});

test('unresolved, custom, duplicated or malformed generator/model metadata withholds', () => {
  for (const source of [
    schema.replace('"prisma-client"', 'env("GENERATOR")'),
    schema.replace('"prisma-client"', '"custom-client"'),
    schema.replace('"../src/generated/prisma"', '"../../../outside"'),
    schema + '\nmodel Entry {\n title String\n}\n',
    schema.replace('title String', 'title String @map(dynamic)'),
    schema.replace('@@map("entries")', '@@map("entries")\n@@map("other")'),
    schema.slice(0, -2),
  ]) {
    const rejected = setup({ 'prisma/schema.prisma': source });
    try { assert.throws(() => prismaWriteModels(rejected.project), /WRITE_/); } finally { rejected.close(); }
  }
});


// Independent published identity, not imported from the production table.
const nextIntegrity = 'sha512-qOVgKJg1+At15NpeUP+eJgCHvTCgXsogweq87Ri/Ix7PkqQHg4sdaXmSFqKlgaIXE4kW0g25LE68W87UANlHtw==';
const nextResolution = `  next@16.2.6:\n    resolution: {integrity: ${nextIntegrity}}\n`;
const refusedNextLocks: ReadonlyArray<readonly [string, string]> = [
  ['missing package resolution', lock.replace(nextResolution, '')],
  ['different package integrity', lock.replace(nextIntegrity, 'sha512-unreviewed')],
  ['custom artifact URL', lock.replace(`resolution: {integrity: ${nextIntegrity}}`,
    `resolution: {integrity: ${nextIntegrity}, tarball: https://example.invalid/framework.tgz}`)],
  ['missing resolution integrity', lock.replace(`resolution: {integrity: ${nextIntegrity}}`, 'resolution: {}')],
  ['unmatched package record', lock.replace('next@16.2.6:', 'next@16.2.5:')],
];
for (const [label, rejectedLock] of refusedNextLocks)
  test(`Next method evidence withholds an unreviewed artifact: ${label}`, () => {
    const repo = setup({ 'pnpm-lock.yaml': rejectedLock });
    try { assert.throws(() => method(repo.project), /WRITE_/); } finally { repo.close(); }
  });

for (const [label, rejectedLock] of refusedNextLocks.slice(0, 3))
  test(`an unreviewed Next artifact emits no validated-write facts or authority: ${label}`, () => {
    const fixtureLock = WRITE_FILES['pnpm-lock.yaml'] as string;
    const changed = label === 'missing package resolution' ? fixtureLock.replace(nextResolution, '') :
      label === 'different package integrity' ? fixtureLock.replace(nextIntegrity, 'sha512-unreviewed') :
      fixtureLock.replace(`resolution: {integrity: ${nextIntegrity}}`,
        `resolution: {integrity: ${nextIntegrity}, tarball: https://example.invalid/framework.tgz}`);
    assert.notEqual(changed, fixtureLock, 'the counterexample must change the artifact identity');
    // rejectedLock is independently checked by the direct method tests above.
    assert.notEqual(rejectedLock, lock);
    const fixture = makeWriteFixture({ 'pnpm-lock.yaml': changed });
    try {
      const output = extractContracts({ repoRoot: fixture.root, repo: 'write-demo', runId: 'run-next-artifact',
        dataModelIndex: writeFixtureIndex('write-demo') });
      assert.deepEqual(output.nodes.filter(node => node.kind === 'Contract' || node.kind === 'SchemaProperty'), []);
      assert.equal(output.result.authoritative.some(claim => isCanonicalSelectorText(claim.selector ?? '')), false);
      assert.ok(output.result.diagnostics.some(diagnostic => diagnostic.includes('WRITE_')));
    } finally { fixture.dispose(); }
  });
