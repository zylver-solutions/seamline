// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript';
import { DEFAULT_LIMITS } from './types.ts';
import { summarizeWritePersistence } from './write-persistence.ts';
import { prismaWriteModels } from './write-prisma.ts';
import { WriteSource } from './write-source.ts';

const schema = `generator client {
 provider = "prisma-client"
 output = "./generated"
 engineType = "client"
}
datasource db {
 provider = "postgresql"
}
model Entry {
 title String @db.VarChar(120)
 @@map("entries")
}
`;
const storage = `import {PrismaClient} from './generated/client';
  const client = new PrismaClient({}); export default {client};`;
const wrapper = `import database from './storage';
export async function persist(id: string, payload: unknown) {
 return database.client.entry.update({where: {id}, data: payload});
}`;

function summary(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'write-persistence-'));
  try {
    for (const [path, content] of Object.entries({ 'package.json': '{"name":"@sample/forms"}',
      'schema.prisma': schema, 'storage.ts': storage, 'write.ts': source })) writeFileSync(join(root, path), content);
    const project = new WriteSource(ts, root, DEFAULT_LIMITS);
    return summarizeWritePersistence(project, project.exported(project.parse('write.ts'), 'persist'), prismaWriteModels(project));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('an unchanged parameter binds the declared model through literal Prisma data', () => {
  const result = summary(wrapper);
  assert.equal(result.parameterIndex, 1);
  assert.equal(result.model.model, 'Entry');
  assert.equal(result.model.table, 'entries');
  assert.equal(result.model.fields.get('title'), 'title');
  assert.equal(result.owningPackage, '@sample/forms');
  assert.deepEqual(result.lexicalChain, ['persist']);
  assert.equal(result.operation, 'update');
  assert.equal(result.file, 'write.ts');
  const aliased = summary(wrapper.replace('return database', 'const forwarded = payload; return database')
    .replace('data: payload', 'data: forwarded'));
  assert.equal(aliased.parameterIndex, 1);
});

test('clipping, unknown effects, overwriting, mutation and unproved model bindings withhold', () => {
  for (const source of [
    wrapper.replace('data: payload', 'data: clip(payload)'),
    wrapper.replace('return database', 'consume(payload); return database'),
    wrapper.replace('return database', 'payload.title = "short"; return database'),
    wrapper.replace('data: payload', 'data: payload, ...other'),
    wrapper.replace('data: payload', 'data: payload, data: replacement'),
    wrapper.replace('.entry.update', '.unknown.update'),
    wrapper.replace('.entry.update', '.entry.upsert'),
    wrapper.replace('async function persist', 'async function* persist'),
    wrapper.replace('return database', 'let forwarded = payload; return database').replace('data: payload', 'data: forwarded'),
    wrapper + '\npersist = replacement;',
  ]) assert.throws(() => summary(source), /WRITE_/, source);
});
