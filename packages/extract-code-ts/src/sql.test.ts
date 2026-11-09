import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSql, sqlTableOccurrences, sqlTableRefs } from './sql.ts';

test('a string is only SQL when it starts with a statement verb', () => {
  assert.equal(looksLikeSql('SELECT id FROM users'), true);
  assert.equal(looksLikeSql('the user selected a row from the table'), false);
  assert.equal(looksLikeSql('/users/:id'), false);
  assert.equal(looksLikeSql('select'), false);
});

test('table references are extracted per operation', () => {
  assert.deepEqual(sqlTableRefs('SELECT id, email FROM users WHERE id = $1'), [
    { table: 'users', schema: null, operation: 'select' },
  ]);
  assert.deepEqual(sqlTableRefs('INSERT INTO public.users (email) VALUES ($1)'), [
    { table: 'users', schema: 'public', operation: 'insert' },
  ]);
  assert.deepEqual(sqlTableRefs('UPDATE accounts SET email = $1 WHERE id = $2'), [
    { table: 'accounts', schema: null, operation: 'update' },
  ]);
  assert.deepEqual(sqlTableRefs('DELETE FROM sessions WHERE id = $1'), [
    { table: 'sessions', schema: null, operation: 'delete' },
  ]);
});

test('a join contributes its table, and results are order-stable across repeated calls', () => {
  const sql = 'SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id';
  const first = sqlTableRefs(sql);
  const second = sqlTableRefs(sql);
  assert.deepEqual(first.map((r) => r.table), ['orders', 'users']);
  assert.deepEqual(first, second);
});

test('a non-SQL string yields nothing rather than a guessed table', () => {
  assert.deepEqual(sqlTableRefs('GET /users/:id'), []);
  assert.deepEqual(sqlTableRefs('user.email'), []);
});

test('a quoted name is lower-cased in the plain reference but keeps its spelling for binding', () => {
  assert.deepEqual(sqlTableRefs('SELECT id FROM "Invitation"'), [
    { table: 'invitation', schema: null, operation: 'select' },
  ]);
  assert.deepEqual(sqlTableOccurrences('SELECT id FROM "Invitation"'), [
    {
      table: 'invitation', schema: null, operation: 'select',
      tableText: 'Invitation', tableQuoted: true, schemaText: null, schemaQuoted: false,
    },
  ]);
  assert.deepEqual(sqlTableOccurrences('INSERT INTO "Auth".Users (id) VALUES (1)'), [
    {
      table: 'users', schema: 'auth', operation: 'insert',
      tableText: 'Users', tableQuoted: false, schemaText: 'Auth', schemaQuoted: true,
    },
  ]);
});

test('two spellings of one name in a statement are two occurrences but one plain reference', () => {
  const sql = 'SELECT a.id FROM "Users" a JOIN users b ON b.id = a.id';
  assert.equal(sqlTableRefs(sql).length, 1);
  assert.deepEqual(
    sqlTableOccurrences(sql).map((o) => `${o.tableText}:${o.tableQuoted}`),
    ['Users:true', 'users:false'],
  );
});

test('the classifier reads any string that starts with a verb and has from, into, update or join in it', () => {
  // Pre-existing looseness, pinned so it is a known fact and not a surprise: interface prose
  // that begins with a SQL verb is read as a statement and yields a "table". The code scope's
  // UNAVAILABLE rule for a run without a data-model index counts such a string as a raw-SQL
  // table reference (design 3.3 and 9.4), so this is part of what that rule costs. Row C does not
  // change these three: design 4.2 keeps today's gate for reads, and `Delete from the list` is a
  // complete `DELETE FROM <ident>`, which the per-verb shape accepts too. Narrowing the gate is a
  // separate decision, and it would change what that rule counts.
  for (const [text, table, operation] of [
    ['Select files from your computer', 'your', 'select'],
    ['Delete from the list', 'the', 'delete'],
    ['select a plan from the options below', 'the', 'select'],
  ] as const) {
    assert.equal(looksLikeSql(text), true, text);
    assert.deepEqual(
      sqlTableOccurrences(text).map((o) => [o.table, o.schema, o.operation]),
      [[table, null, operation]],
      text,
    );
  }
  // What the classifier does decline: the verb is not first, or no table keyword follows.
  assert.equal(looksLikeSql('Please select files from your computer'), false);
  assert.equal(looksLikeSql('Select the files you want to keep'), false);
});
