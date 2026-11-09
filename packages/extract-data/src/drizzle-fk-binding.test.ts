/**
 * Drizzle foreign-key binding order: a `.references(() => users.id)` target follows the importing
 * module's import binding, not whichever module that exported `users` last.
 *
 * `a/schema.ts` exports `users` for table `users`. `b/schema.ts` exports `users`
 * for table `legacy_users`. `a/posts.ts` imports `{ users }` from `./schema`.
 * The FK_TO edge from `posts.uid` is `public.users.id` in every read order.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';

import { emit } from './emit.ts';
import { extractData } from './extractor.ts';
import { applyDrizzleFile, createDrizzleRegistry, resolveDrizzleRefs } from './drizzle.ts';
import { SchemaModel } from './model.ts';

const USERS_EDGE = 'demo:Column:public.posts.uid -> demo:Column:public.users.id';
const LEGACY_EDGE = 'demo:Column:public.posts.uid -> demo:Column:public.legacy_users.id';

const roots: string[] = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function usersModule(table: string): string {
  return [
    "import { pgTable, uuid } from 'drizzle-orm/pg-core';",
    `export const users = pgTable('${table}', { id: uuid('id').primaryKey() });`,
    '',
  ].join('\n');
}

function postsModule(importLine: string, reference: string): string {
  return [
    "import { pgTable, uuid } from 'drizzle-orm/pg-core';",
    importLine,
    "export const posts = pgTable('posts', {",
    "  id: uuid('id').primaryKey(),",
    `  uid: uuid('uid').references(() => ${reference}),`,
    '});',
    '',
  ].join('\n');
}

const POSTS = postsModule("import { users } from './schema';", 'users.id');

/** The issue's tree: `a` exports `users`, `b` exports `legacy_users`, posts imports `./schema`. */
function issueFiles(posts: string = POSTS): Record<string, string> {
  return {
    'a/schema.ts': usersModule('users'),
    'b/schema.ts': usersModule('legacy_users'),
    'a/posts.ts': posts,
  };
}

interface Resolved {
  readonly edges: readonly string[];
  readonly unresolved: readonly string[];
}

function resolveInOrder(
  files: Readonly<Record<string, string>>,
  order: readonly string[],
): Resolved {
  const model = new SchemaModel('default', 'public', false);
  const reg = createDrizzleRegistry();
  for (const path of order) {
    const text = files[path];
    assert.ok(text !== undefined, path);
    applyDrizzleFile(model, reg, text, path);
  }
  resolveDrizzleRefs(model, reg);
  const out = emit(model, { repo: 'demo', runId: 'r1', dialect: 'postgres' });
  return {
    edges: out.edges
      .filter((e) => e.kind === 'FK_TO')
      .map((e) => `${e.src} -> ${e.dst}`)
      .sort(),
    unresolved: model.diagnostics.filter((d) => d.includes('unresolved reference')),
  };
}

test('a Drizzle reference follows the import binding in both read orders (Drizzle foreign-key binding order)', () => {
  const files = issueFiles();
  // b/schema.ts sorts after a/, which is the order that used to bind `users` to legacy_users.
  const orders = [
    ['a/schema.ts', 'b/schema.ts', 'a/posts.ts'],
    ['b/schema.ts', 'a/schema.ts', 'a/posts.ts'],
    ['a/posts.ts', 'b/schema.ts', 'a/schema.ts'],
    ['a/posts.ts', 'a/schema.ts', 'b/schema.ts'],
  ];
  for (const order of orders) {
    const resolved = resolveInOrder(files, order);
    assert.deepEqual(resolved.edges, [USERS_EDGE], order.join(' then '));
    assert.deepEqual(resolved.unresolved, [], order.join(' then '));
    assert.ok(!resolved.edges.includes(LEGACY_EDGE), order.join(' then '));
  }
});

test('the same tree extracted from disk points posts.uid at public.users.id (Drizzle foreign-key binding order)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'seamline-drizzle-fk-'));
  roots.push(root);
  const files = issueFiles();
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text, 'utf8');
  }
  const out = await extractData({ root, repo: 'demo', runId: 'r1', deterministic: true });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('; '));
  assert.deepEqual(
    out.edges
      .filter((e) => e.kind === 'FK_TO')
      .map((e) => `${e.src} -> ${e.dst}`)
      .sort(),
    [USERS_EDGE],
  );
});

test('an import alias resolves to the exported table, not another module with the same export name', () => {
  const files = issueFiles(
    postsModule("import { users as account } from './schema';", 'account.id'),
  );
  for (const order of [
    ['a/schema.ts', 'b/schema.ts', 'a/posts.ts'],
    ['b/schema.ts', 'a/schema.ts', 'a/posts.ts'],
  ]) {
    const resolved = resolveInOrder(files, order);
    assert.deepEqual(resolved.edges, [USERS_EDGE], order.join(' then '));
  }
});

test('a same-module binding wins over another module that exports the same name', () => {
  const posts = [
    "import { pgTable, uuid } from 'drizzle-orm/pg-core';",
    "export const users = pgTable('users', { id: uuid('id').primaryKey() });",
    "export const posts = pgTable('posts', {",
    "  id: uuid('id').primaryKey(),",
    "  uid: uuid('uid').references(() => users.id),",
    '});',
    '',
  ].join('\n');
  const files = issueFiles(posts);
  for (const order of [
    ['a/posts.ts', 'b/schema.ts'],
    ['b/schema.ts', 'a/posts.ts'],
  ]) {
    assert.deepEqual(resolveInOrder(files, order).edges, [USERS_EDGE], order.join(' then '));
  }
});

test('a variable name bound to one table still resolves when the file does not import it', () => {
  const files = {
    'a/schema.ts': usersModule('users'),
    'a/posts.ts': postsModule('', 'users.id'),
  };
  const resolved = resolveInOrder(files, ['a/posts.ts', 'a/schema.ts']);
  assert.deepEqual(resolved.edges, [USERS_EDGE]);
  assert.deepEqual(resolved.unresolved, []);
});

test('an ambiguous name with no import emits no FK_TO edge', () => {
  const files = issueFiles(postsModule('', 'users.id'));
  for (const order of [
    ['a/schema.ts', 'b/schema.ts', 'a/posts.ts'],
    ['b/schema.ts', 'a/schema.ts', 'a/posts.ts'],
  ]) {
    const resolved = resolveInOrder(files, order);
    assert.deepEqual(resolved.edges, [], order.join(' then '));
    assert.deepEqual(resolved.unresolved, [
      'drizzle: unresolved reference target users.id from public.posts.uid (ambiguous)',
    ]);
  }
});

test('a type-only import is not a table binding and does not fall back to another module', () => {
  const files = {
    'b/schema.ts': usersModule('legacy_users'),
    'a/posts.ts': postsModule("import type { users } from './schema';", 'users.id'),
  };
  const resolved = resolveInOrder(files, ['b/schema.ts', 'a/posts.ts']);
  assert.deepEqual(resolved.edges, []);
  assert.deepEqual(resolved.unresolved, [
    'drizzle: unresolved reference target users.id from public.posts.uid',
  ]);
});

test('an unresolvable specifier falls back to a name only one table is exported under', () => {
  const files = {
    'b/schema.ts': usersModule('legacy_users'),
    'a/posts.ts': postsModule("import { users } from './missing';", 'users.id'),
  };
  for (const order of [
    ['b/schema.ts', 'a/posts.ts'],
    ['a/posts.ts', 'b/schema.ts'],
  ]) {
    const resolved = resolveInOrder(files, order);
    assert.deepEqual(resolved.edges, [LEGACY_EDGE], order.join(' then '));
    assert.deepEqual(resolved.unresolved, []);
  }
});

test('a tsconfig path alias resolves through the unique global name', () => {
  const files = {
    'a/schema.ts': usersModule('users'),
    'a/posts.ts': postsModule("import { users } from '@/db/schema';", 'users.id'),
  };
  for (const order of [
    ['a/schema.ts', 'a/posts.ts'],
    ['a/posts.ts', 'a/schema.ts'],
  ]) {
    const resolved = resolveInOrder(files, order);
    assert.deepEqual(resolved.edges, [USERS_EDGE], order.join(' then '));
    assert.deepEqual(resolved.unresolved, []);
  }
});

test('an aliased import under a path alias uses the exported name', () => {
  const files = {
    'a/schema.ts': usersModule('users'),
    'a/posts.ts': postsModule("import { users as u } from '@/db/schema';", 'u.id'),
  };
  assert.deepEqual(resolveInOrder(files, ['a/schema.ts', 'a/posts.ts']).edges, [USERS_EDGE]);
});

test('a path alias with a name exported under two tables emits no edge and says ambiguous', () => {
  const files = issueFiles(postsModule("import { users } from '@/db/schema';", 'users.id'));
  for (const order of [
    ['a/schema.ts', 'b/schema.ts', 'a/posts.ts'],
    ['b/schema.ts', 'a/schema.ts', 'a/posts.ts'],
  ]) {
    const resolved = resolveInOrder(files, order);
    assert.deepEqual(resolved.edges, [], order.join(' then '));
    assert.deepEqual(resolved.unresolved, [
      'drizzle: unresolved reference target users.id from public.posts.uid (ambiguous)',
    ]);
  }
});

test('a path alias type-only import gets no global fallback', () => {
  const files = {
    'a/schema.ts': usersModule('users'),
    'a/posts.ts': postsModule("import type { users } from '@/db/schema';", 'users.id'),
  };
  assert.deepEqual(resolveInOrder(files, ['a/schema.ts', 'a/posts.ts']).edges, []);
});

test('a resolved module without the export gets no global fallback', () => {
  const files = {
    'a/schema.ts': 'export const other = 1;\n',
    'b/schema.ts': usersModule('legacy_users'),
    'a/posts.ts': postsModule("import { users } from './schema';", 'users.id'),
  };
  const resolved = resolveInOrder(files, ['a/schema.ts', 'b/schema.ts', 'a/posts.ts']);
  assert.deepEqual(resolved.edges, []);
  assert.deepEqual(resolved.unresolved, [
    'drizzle: unresolved reference target users.id from public.posts.uid',
  ]);
});

test('a barrel index with export * resolves the table in every read order', () => {
  const files = {
    'a/schema.ts': usersModule('users'),
    'a/index.ts': "export * from './schema';\n",
    'b/schema.ts': usersModule('legacy_users'),
    'a/posts.ts': postsModule("import { users } from './index';", 'users.id'),
  };
  for (const order of [
    ['a/schema.ts', 'a/index.ts', 'b/schema.ts', 'a/posts.ts'],
    ['b/schema.ts', 'a/posts.ts', 'a/index.ts', 'a/schema.ts'],
    ['a/posts.ts', 'b/schema.ts', 'a/schema.ts', 'a/index.ts'],
  ]) {
    const resolved = resolveInOrder(files, order);
    assert.deepEqual(resolved.edges, [USERS_EDGE], order.join(' then '));
    assert.deepEqual(resolved.unresolved, []);
  }
});

test('export * follows nested barrels and survives a cycle', () => {
  const files = {
    'a/schema.ts': usersModule('users'),
    'a/inner.ts': "export * from './schema';\nexport * from './outer';\n",
    'a/outer.ts': "export * from './inner';\n",
    'a/posts.ts': postsModule("import { users } from './outer';", 'users.id'),
  };
  const resolved = resolveInOrder(files, ['a/posts.ts', 'a/outer.ts', 'a/inner.ts', 'a/schema.ts']);
  assert.deepEqual(resolved.edges, [USERS_EDGE]);
});

test('export * sources that export the name under different tables are ambiguous', () => {
  const files = {
    'a/schema.ts': usersModule('users'),
    'b/schema.ts': usersModule('legacy_users'),
    'a/index.ts': "export * from './schema';\nexport * from '../b/schema';\n",
    'a/posts.ts': postsModule("import { users } from './index';", 'users.id'),
  };
  const resolved = resolveInOrder(files, [
    'a/schema.ts',
    'b/schema.ts',
    'a/index.ts',
    'a/posts.ts',
  ]);
  assert.deepEqual(resolved.edges, []);
  assert.deepEqual(resolved.unresolved, [
    'drizzle: unresolved reference target users.id from public.posts.uid (ambiguous)',
  ]);
});

test('a name the barrel exports itself wins over export *', () => {
  const files = {
    'a/schema.ts': usersModule('legacy_users'),
    'a/real.ts': usersModule('users'),
    'a/index.ts': "export * from './schema';\nexport { users } from './real';\n",
    'a/posts.ts': postsModule("import { users } from './index';", 'users.id'),
  };
  const resolved = resolveInOrder(files, ['a/schema.ts', 'a/real.ts', 'a/index.ts', 'a/posts.ts']);
  assert.deepEqual(resolved.edges, [USERS_EDGE]);
});

test('a namespace import follows the namespace module, not the global name', () => {
  const files = {
    'a/schema.ts': usersModule('users'),
    'b/schema.ts': usersModule('legacy_users'),
    'a/posts.ts': postsModule("import * as s from './schema';", 's.users.id'),
  };
  for (const order of [
    ['a/schema.ts', 'b/schema.ts', 'a/posts.ts'],
    ['b/schema.ts', 'a/schema.ts', 'a/posts.ts'],
  ]) {
    const resolved = resolveInOrder(files, order);
    assert.deepEqual(resolved.edges, [USERS_EDGE], order.join(' then '));
    assert.deepEqual(resolved.unresolved, []);
  }
});

test('a namespace import through a barrel follows export *', () => {
  const files = {
    'a/schema.ts': usersModule('users'),
    'a/index.ts': "export * from './schema';\n",
    'b/schema.ts': usersModule('legacy_users'),
    'a/posts.ts': postsModule("import * as s from './index';", 's.users.id'),
  };
  const resolved = resolveInOrder(files, [
    'b/schema.ts',
    'a/posts.ts',
    'a/index.ts',
    'a/schema.ts',
  ]);
  assert.deepEqual(resolved.edges, [USERS_EDGE]);
});

test('pending references sort by source path and line when the column key ties', () => {
  const posts = (table: string): string =>
    postsModule("import { users } from './schema';", 'users.id').replace("'posts'", `'${table}'`);
  const files = {
    'a/schema.ts': usersModule('users'),
    'a/p1.ts': posts('dup'),
    'a/p2.ts': posts('dup'),
  };
  const lines = (order: readonly string[]): string[] => {
    const model = new SchemaModel('default', 'public', false);
    const reg = createDrizzleRegistry();
    for (const path of order) applyDrizzleFile(model, reg, files[path as keyof typeof files], path);
    resolveDrizzleRefs(model, reg);
    return model.foreignKeys.map((fk) => `${fk.path}:${fk.line}`);
  };
  assert.deepEqual(
    lines(['a/schema.ts', 'a/p1.ts', 'a/p2.ts']),
    lines(['a/p2.ts', 'a/p1.ts', 'a/schema.ts']),
  );
});

test("a re-export and a .js specifier follow the exporting module's export", () => {
  const files = {
    'a/schema.ts': [
      "import { pgTable, uuid } from 'drizzle-orm/pg-core';",
      "const people = pgTable('users', { id: uuid('id').primaryKey() });",
      'export { people as users };',
      '',
    ].join('\n'),
    'a/index.ts': "export { users } from './schema.ts';\n",
    'b/schema.ts': usersModule('legacy_users'),
    'a/posts.ts': postsModule("import { users } from './index.js';", 'users.id'),
  };
  for (const order of [
    ['b/schema.ts', 'a/posts.ts', 'a/index.ts', 'a/schema.ts'],
    ['a/schema.ts', 'a/index.ts', 'a/posts.ts', 'b/schema.ts'],
  ]) {
    assert.deepEqual(resolveInOrder(files, order).edges, [USERS_EDGE], order.join(' then '));
  }
});
