/**
 * `classifyRawSql`: which statements a literal holds, which table and class each
 * touches, and what it can say about the columns it writes.
 *
 * Every test asserts an outcome: the (table, class) pairs, the column set and
 * whether it is complete, or that a text which merely begins with a verb is not
 * a statement at all. Design: `docs/design/real-world-inputs.md`, 4.2 and 7.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { classifyRawSql } from './raw-sql.ts';
import type { RawSqlReading } from './raw-sql.ts';
import { SUBSTITUTION, sqlText } from './sql.ts';

/** One line per call: `schema.table [classes] insert=complete(a,b) update=incomplete()`. */
function show(reading: RawSqlReading): string[] {
  return reading.calls.map((c) => {
    const half = (
      name: string,
      set: { complete: boolean; columns: readonly string[] } | null,
    ): string =>
      set === null
        ? ''
        : ` ${name}=${set.complete ? 'complete' : 'incomplete'}(${set.columns.join(',')})`;
    const table = `${c.table.schema === null ? '' : `${c.table.schema}.`}${c.table.table}`;
    return `${table} [${c.classes.join(',')}]${half('insert', c.insert)}${half('update', c.update)}`;
  });
}

/** Classify a literal given as its parts: more than one part means a substitution between them. */
function read(parts: string | readonly string[], concatenated = false): RawSqlReading {
  return classifyRawSql(sqlText(typeof parts === 'string' ? [parts] : parts), { concatenated });
}

function calls(parts: string | readonly string[], concatenated = false): string[] {
  return show(read(parts, concatenated));
}

function untraced(parts: string | readonly string[]): string[] {
  return [...read(parts).unattributed];
}

/* ------------------------------------------------------------ write shapes */

test('INSERT: every verb form is an insert, and an explicit plain list is complete', () => {
  const forms = [
    'INSERT INTO t (a, b) VALUES (1, 2)',
    'INSERT IGNORE INTO t (a, b) VALUES (1, 2)',
    'INSERT OR REPLACE INTO t (a, b) VALUES (1, 2)',
    'INSERT OR IGNORE INTO t (a, b) VALUES (1, 2)',
    'INSERT OR ABORT INTO t (a, b) VALUES (1, 2)',
    'INSERT OR FAIL INTO t (a, b) VALUES (1, 2)',
    'INSERT OR ROLLBACK INTO t (a, b) VALUES (1, 2)',
    'insert into t (a, b) values (1, 2)',
    'INSERT INTO t AS x (a, b) VALUES (1, 2)',
  ];
  for (const form of forms) {
    assert.deepEqual(calls(form), ['t [insert] insert=complete(a,b)'], form);
  }
  // The variant that cannot be attributed: the table is a substitution.
  assert.deepEqual(untraced(['INSERT INTO ', ' (a, b) VALUES (1, 2)']), ['table-placeholder']);
  assert.deepEqual(calls(['INSERT INTO ', ' (a, b) VALUES (1, 2)']), []);
});

test('REPLACE INTO is an insert and a delete; its explicit list is the insert half', () => {
  assert.deepEqual(calls('REPLACE INTO t (a, b) VALUES (1, 2)'), [
    't [delete,insert] insert=complete(a,b)',
  ]);
  assert.deepEqual(calls('REPLACE INTO t VALUES (1, 2)'), [
    't [delete,insert] insert=incomplete()',
  ]);
  assert.deepEqual(untraced(['REPLACE INTO ', ' (a) VALUES (1)']), ['table-placeholder']);
  // Without INTO it is not the shape.
  assert.deepEqual(calls('Replace the cache'), []);
});

test('an upsert is one class with both halves; DO NOTHING is a plain insert', () => {
  assert.deepEqual(
    calls('INSERT INTO t (a, b) VALUES (1, 2) ON CONFLICT (a) DO UPDATE SET b = excluded.b, c = 3'),
    ['t [upsert] insert=complete(a,b) update=complete(b,c)'],
  );
  assert.deepEqual(
    calls('INSERT INTO t (a, b) VALUES (1, 2) ON DUPLICATE KEY UPDATE b = VALUES(b)'),
    ['t [upsert] insert=complete(a,b) update=complete(b)'],
  );
  assert.deepEqual(calls('INSERT INTO t (a, b) VALUES (1, 2) ON CONFLICT DO NOTHING'), [
    't [insert] insert=complete(a,b)',
  ]);
  // The update half is incomplete when a target is not a plain identifier.
  assert.deepEqual(
    calls('INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET (b, c) = (1, 2)'),
    ['t [upsert] insert=complete(a) update=incomplete()'],
  );
});

test('MERGE INTO is an upsert whose halves come from its INSERT and UPDATE SET actions', () => {
  const merge =
    'MERGE INTO t USING s ON t.id = s.id ' +
    'WHEN MATCHED THEN UPDATE SET a = s.a, b = CASE WHEN s.b > 0 THEN s.b ELSE 0 END ' +
    'WHEN NOT MATCHED THEN INSERT (a, b) VALUES (s.a, s.b)';
  assert.deepEqual(calls(merge), ['t [upsert] insert=complete(a,b) update=complete(a,b)']);
  // An action without a plain list leaves its half incomplete.
  assert.deepEqual(
    calls('MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED THEN INSERT VALUES (s.a)'),
    ['t [upsert] insert=incomplete() update=incomplete()'],
  );
  assert.deepEqual(calls('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE'), [
    't [delete,upsert] insert=incomplete() update=incomplete()',
  ]);
  assert.deepEqual(untraced(['MERGE INTO ', ' USING s ON 1 = 1 WHEN MATCHED THEN DELETE']), [
    'table-placeholder',
  ]);
});

test('COPY FROM is an insert, COPY TO is a read, and a list is needed to be complete', () => {
  assert.deepEqual(calls('COPY t (a, b) FROM STDIN'), ['t [insert] insert=complete(a,b)']);
  assert.deepEqual(calls("COPY t FROM '/tmp/rows.csv'"), ['t [insert] insert=incomplete()']);
  // COPY ... TO is a read, and a read of a named table is not something this reader attributes.
  assert.deepEqual(calls('COPY t TO STDOUT'), []);
  for (const source of ["'/tmp/rows.csv'", 'STDIN', "PROGRAM 'gzip -dc rows.gz'"]) {
    assert.deepEqual(calls(`COPY t (a) FROM ${source}`), ['t [insert] insert=complete(a)'], source);
  }
  assert.deepEqual(calls(['COPY t FROM ', '']), ['t [insert] insert=incomplete()']);
  // A query on the left is not a table; there is no shape.
  assert.deepEqual(calls('COPY (SELECT a FROM t) TO STDOUT'), []);
  assert.deepEqual(untraced(['COPY ', ' (a) FROM STDIN']), ['table-placeholder']);
});

test('UPDATE: ONLY, an alias, AS and a schema are all tolerated, and every target must be plain', () => {
  const forms = [
    'UPDATE jobs SET a = 1, b = ? WHERE id = ?',
    'UPDATE ONLY jobs SET a = 1, b = ? WHERE id = ?',
    'UPDATE jobs j SET a = 1, b = ? WHERE j.id = ?',
    'UPDATE jobs AS j SET a = 1, b = ? WHERE j.id = ?',
    'UPDATE "jobs" SET a = 1, b = ? WHERE id = ?',
    'update jobs set a = 1, b = ?',
    'UPDATE jobs SET a = 1, b = ? RETURNING id',
  ];
  for (const form of forms) {
    assert.deepEqual(calls(form), ['jobs [update] update=complete(a,b)'], form);
  }
  assert.deepEqual(calls('UPDATE public.jobs SET a = 1'), [
    'public.jobs [update] update=complete(a)',
  ]);
  assert.deepEqual(untraced(['UPDATE ', ' SET a = 1']), ['table-placeholder']);
  // A target that is not one plain identifier makes the set incomplete; the statement is still an update.
  for (const form of [
    'UPDATE t SET (a, b) = (1, 2)',
    'UPDATE t SET t.a = 1',
    'UPDATE t SET a = 1, b',
    'UPDATE t SET a = 1, b =',
    'UPDATE t SET a = 1,, b = 2',
    'UPDATE t SET',
  ]) {
    assert.deepEqual(calls(form), ['t [update] update=incomplete()'], form);
  }
});

test('UPDATE: a multi-table form is an update whose targets cannot be attributed, and its join is read', () => {
  assert.deepEqual(calls('UPDATE a JOIN b ON a.id = b.id SET a.x = 1'), [
    'a [update] update=incomplete()',
    'b [select]',
  ]);
  assert.deepEqual(calls('UPDATE a, b SET a.x = b.y WHERE a.id = b.id'), [
    'a [update] update=incomplete()',
  ]);
});

test('UPDATE: the assignment list ends at its clause, and a CASE expression does not end it early', () => {
  assert.deepEqual(
    calls('UPDATE t SET a = CASE WHEN x > 0 THEN 1 ELSE 2 END, b = 3 WHERE id = 1'),
    ['t [update] update=complete(a,b)'],
  );
  // `IS DISTINCT FROM` does not end the list (the read gate does see a `FROM c` there, as it always has).
  assert.equal(
    calls('UPDATE t SET a = b IS DISTINCT FROM c, d = 4 WHERE id = 1')[0],
    't [update] update=complete(a,d)',
  );
  assert.deepEqual(calls('UPDATE t SET a = s.a FROM s WHERE s.id = t.id'), [
    't [update] update=complete(a)',
    's [select]',
  ]);
});

test('DELETE FROM and TRUNCATE are deletes with no column set', () => {
  assert.deepEqual(calls('DELETE FROM sessions WHERE id = ?'), ['sessions [delete]']);
  assert.deepEqual(calls('DELETE FROM ONLY sessions'), ['sessions [delete]']);
  assert.deepEqual(calls('TRUNCATE TABLE sessions'), ['sessions [delete]']);
  assert.deepEqual(calls('TRUNCATE TABLE a, ONLY b RESTART IDENTITY'), [
    'a [delete]',
    'b [delete]',
  ]);
  assert.deepEqual(untraced(['DELETE FROM ', ' WHERE 1 = 1']), ['table-placeholder']);
  assert.deepEqual(untraced(['TRUNCATE TABLE ', '']), ['table-placeholder']);
  // A subquery in the WHERE is a read of its table.
  assert.deepEqual(calls('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users)'), [
    'sessions [delete]',
    'users [select]',
  ]);
});

test('CALL and EXEC run a procedure whose tables are unknown, so they are counted and give no edge', () => {
  for (const text of [
    'CALL refresh_stats(1)',
    'CALL app.refresh()',
    'EXEC sp_who2 @id = 1',
    'EXECUTE do_it(1)',
    'exec dbo.p @a = 1',
  ]) {
    assert.deepEqual(calls(text), [], text);
    assert.deepEqual(untraced(text), ['procedure'], text);
  }
  // CALL needs a parenthesis; EXEC needs a parenthesis or an @.
  assert.deepEqual(untraced('CALL refresh_stats'), []);
  assert.deepEqual(untraced('EXEC sp_who2'), []);
  // A label in the form CALL <word>( is counted. That is a false UNKNOWN and costs recall only.
  assert.deepEqual(untraced('Call us (24h)'), ['procedure']);
});

/* --------------------------------------------------- text that is not SQL */

test('text that begins with a verb but lacks the rest of the structure is not a statement', () => {
  for (const text of [
    'Update assumption',
    'Call us',
    'Call now',
    'Call back',
    'Call or email us',
    'Copy reference',
    'DELETE',
    'delete',
    'update',
    'Select a file to upload',
    'Replace the cache',
    'Insert coin',
    'createHash',
    'sha256',
    'q',
    'Merge requests',
    'Truncate',
    // Class strings and sentences that begin like a statement but are not one.
    'truncate',
    'truncate text-sm font-semibold',
    'truncate px-2 text-sm text-ink-2 max-sm:hidden',
    'flex truncate',
    'Copy link to clipboard',
    'Copy text to clipboard',
    'Copy files from desktop',
    'Merge into main',
    'Merge into main and close the request',
    'Insert into your project',
    'Insert into the document',
    'Replace into the cache',
    'Update application fields, move stages and edit contacts',
    'Update the profile, then save',
  ]) {
    assert.deepEqual(read(text), { calls: [], unattributed: [] }, text);
  }
  for (const parts of [
    ['Call ', ''],
    ['Update ', ' items'],
    ['Delete ', ''],
    ['Copy ', ' to clipboard'],
  ]) {
    assert.deepEqual(read(parts), { calls: [], unattributed: [] }, parts.join('${}'));
  }
});

test('TRUNCATE is a statement only when it ends where the statement ends', () => {
  assert.deepEqual(calls('TRUNCATE TABLE a, b RESTART IDENTITY CASCADE'), [
    'a [delete]',
    'b [delete]',
  ]);
  assert.deepEqual(calls('TRUNCATE a CONTINUE IDENTITY RESTRICT'), ['a [delete]']);
  assert.deepEqual(calls('truncate a; truncate b'), ['a [delete]', 'b [delete]']);
  assert.deepEqual(calls(['TRUNCATE TABLE a ', '']), ['a [delete]']);
  assert.deepEqual(calls('TRUNCATE a, text-sm'), []);
});

test('a bare TRUNCATE <word> at the end of the text needs a second signal', () => {
  // Tailwind utilities after `truncate` are one word each, and the text ends there.
  for (const text of [
    'truncate block',
    'truncate flex',
    'truncate italic',
    'truncate hidden',
    'truncate relative',
    'truncate grow',
    'truncate inline',
    'truncate text',
    'Truncate message',
  ]) {
    assert.deepEqual(read(text), { calls: [], unattributed: [] }, text);
  }
  // `className={`truncate ${className}`}`: a bare word that is a substitution is no more a statement.
  assert.deepEqual(read(['truncate ', '']), { calls: [], unattributed: [] });
  // The genuine forms each carry a signal: TABLE, ONLY, a schema, a quoted name, a name list, an option, or `;`.
  const genuine: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['TRUNCATE TABLE sessions', ['sessions [delete]']],
    ['TRUNCATE ONLY sessions', ['sessions [delete]']],
    ['TRUNCATE public.sessions', ['public.sessions [delete]']],
    ['TRUNCATE "Sessions"', ['sessions [delete]']],
    ['TRUNCATE sessions, accounts', ['sessions [delete]', 'accounts [delete]']],
    ['TRUNCATE sessions CASCADE', ['sessions [delete]']],
    ['TRUNCATE sessions RESTART IDENTITY', ['sessions [delete]']],
    ['TRUNCATE sessions CONTINUE IDENTITY', ['sessions [delete]']],
    ['TRUNCATE sessions RESTRICT', ['sessions [delete]']],
    ['TRUNCATE sessions;', ['sessions [delete]']],
    ['truncate sessions ;', ['sessions [delete]']],
  ];
  for (const [text, expected] of genuine) assert.deepEqual(calls(text), expected, text);
  // A statement after a terminated one is part of a script.
  assert.deepEqual(calls('truncate a; truncate b'), ['a [delete]', 'b [delete]']);
  // A table that is a substitution is counted when a signal says it is a statement, and not otherwise.
  assert.deepEqual(untraced(['TRUNCATE ', ' CASCADE']), ['table-placeholder']);
  assert.deepEqual(untraced(['TRUNCATE ', ';']), ['table-placeholder']);
  assert.deepEqual(untraced(['truncate ', '']), []);
});

test('REPLACE INTO and MERGE INTO need a second signal beyond the table, as INSERT INTO does not', () => {
  // `REPLACE INTO <name>` with nothing after it is a sentence unless the literal is cut off by a `+`.
  assert.deepEqual(calls('Replace into inventory'), []);
  assert.deepEqual(calls('REPLACE INTO inventory'), []);
  assert.deepEqual(calls('REPLACE INTO inventory ', true), [
    'inventory [delete,insert] insert=incomplete()',
  ]);
  for (const text of [
    'REPLACE INTO t (a, b)',
    'REPLACE INTO t VALUES (1, 2)',
    'REPLACE INTO t SELECT * FROM s',
    'REPLACE INTO t SET a = 1',
    'REPLACE LOW_PRIORITY INTO t (a) VALUES (1)',
  ]) {
    assert.equal(calls(text).length >= 1, true, text);
    assert.match(calls(text)[0] as string, /^t \[delete,insert\]/, text);
  }
  assert.deepEqual(calls(['REPLACE INTO t ', '']), ['t [delete,insert] insert=incomplete()']);
  // MERGE needs USING <source> [[AS] alias] ON.
  assert.deepEqual(calls('Merge into main using git'), []);
  assert.deepEqual(calls('MERGE INTO t USING s'), []);
  assert.deepEqual(calls('MERGE INTO t USING s ', true), [
    't [upsert] insert=incomplete() update=incomplete()',
  ]);
  for (const text of [
    'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE',
    'MERGE INTO t AS m USING s AS x ON m.id = x.id WHEN MATCHED THEN DELETE',
    'MERGE INTO t m USING s x ON m.id = x.id WHEN MATCHED THEN DELETE',
    'MERGE INTO t USING (SELECT 1 AS id) s ON t.id = s.id WHEN MATCHED THEN DELETE',
    'MERGE INTO t USING other.s ON t.id = s.id WHEN MATCHED THEN DELETE',
  ]) {
    assert.equal(calls(text).length, 1, text);
    assert.match(calls(text)[0] as string, /^t \[delete,upsert\]/, text);
  }
});

test('INSERT, REPLACE and MERGE need what follows their table to be what follows it in a statement', () => {
  assert.deepEqual(
    calls('INSERT INTO t'),
    ['t [insert] insert=incomplete()'],
    'a builder may still be building',
  );
  assert.deepEqual(calls('INSERT INTO t WITH x AS (SELECT 1) SELECT * FROM x'), [
    't [insert] insert=incomplete()',
  ]);
  assert.deepEqual(calls('INSERT INTO t WITH x AS (SELECT 1 FROM s) SELECT * FROM x'), [
    't [insert] insert=incomplete()',
    's [select]',
  ]);
  assert.deepEqual(calls('MERGE INTO t AS m USING s ON m.id = s.id WHEN MATCHED THEN DELETE'), [
    't [delete,upsert] insert=incomplete() update=incomplete()',
  ]);
  assert.deepEqual(
    calls('MERGE INTO t m USING s ON m.id = s.id WHEN MATCHED THEN DELETE').length,
    1,
  );
  assert.deepEqual(calls('REPLACE INTO t SELECT * FROM s'), [
    't [delete,insert] insert=incomplete()',
  ]);
});

test('"Delete from cart" has the whole structure of a statement, so it is a delete of a table named cart', () => {
  assert.deepEqual(calls('Delete from cart'), ['cart [delete]']);
  assert.deepEqual(untraced('Delete from cart'), []);
});

test('a keyword where a table name belongs is not a table', () => {
  assert.deepEqual(calls('DELETE FROM WHERE id = 1'), []);
  assert.deepEqual(calls('UPDATE SET a = 1'), []);
  assert.deepEqual(calls('INSERT INTO VALUES (1)'), []);
});

/* ---------------------------------------------------- the column-list rule */

test('an insert list is complete only when closed in this literal and followed by VALUES, SELECT or DEFAULT', () => {
  assert.deepEqual(calls('INSERT INTO t (a, b) VALUES (1, 2)'), [
    't [insert] insert=complete(a,b)',
  ]);
  assert.deepEqual(calls('INSERT INTO t (a, b) SELECT x, y FROM s'), [
    't [insert] insert=complete(a,b)',
    's [select]',
  ]);
  assert.deepEqual(calls('INSERT INTO t (a, b) DEFAULT VALUES'), [
    't [insert] insert=complete(a,b)',
  ]);

  // The string-builder statement: the literal ends inside the list.
  assert.deepEqual(calls('INSERT INTO t (a'), ['t [insert] insert=incomplete()']);
  assert.deepEqual(calls('INSERT INTO t (a, b'), ['t [insert] insert=incomplete()']);
  // The closing parenthesis that ends the text belongs to an inner group, not to the list.
  assert.deepEqual(calls('INSERT INTO t (a, f(x)'), ['t [insert] insert=incomplete()']);
  // The text stops inside a comment that hides the closing parenthesis.
  assert.deepEqual(calls('INSERT INTO t (a, b -- )'), ['t [insert] insert=incomplete()']);
  // The text stops inside a quoted name.
  assert.deepEqual(calls('INSERT INTO t (a, "b'), ['t [insert] insert=incomplete()']);
  // Closed, but nothing says what follows: more of the statement may come from code.
  assert.deepEqual(calls('INSERT INTO t (a, b)'), ['t [insert] insert=incomplete()']);
  assert.deepEqual(calls('INSERT INTO t (a, b) '), ['t [insert] insert=incomplete()']);
  assert.deepEqual(calls('INSERT INTO t (a, b) ON CONFLICT DO NOTHING'), [
    't [insert] insert=incomplete()',
  ]);
  // No list at all.
  assert.deepEqual(calls('INSERT INTO t VALUES (1, 2)'), ['t [insert] insert=incomplete()']);
  assert.deepEqual(calls('INSERT INTO t SELECT * FROM s'), [
    't [insert] insert=incomplete()',
    's [select]',
  ]);
  assert.deepEqual(calls('INSERT INTO t DEFAULT VALUES'), ['t [insert] insert=incomplete()']);
});

test('an incomplete list carries no columns at all, never a shorter list', () => {
  for (const text of [
    'INSERT INTO t (a',
    'INSERT INTO t (a, f(x)',
    'INSERT INTO t (a, b)',
    'INSERT INTO t (a, b + 1) VALUES (1, 2)',
    'INSERT INTO t (a, , b) VALUES (1, 2, 3)',
    'INSERT INTO t (a, 1) VALUES (1, 2)',
    "INSERT INTO t (a, 'b') VALUES (1, 2)",
    'INSERT INTO t (a, t.b) VALUES (1, 2)',
    'INSERT INTO t () VALUES ()',
    'INSERT INTO t (SELECT a FROM s)',
  ]) {
    const [call] = read(text).calls;
    assert.ok(call !== undefined && call.insert !== null, text);
    assert.deepEqual(call.insert, { columns: [], complete: false }, text);
  }
});

test('column names: unquoted fold to lower case, quoted keep their case, and an unencodable name makes the list incomplete', () => {
  assert.deepEqual(calls('INSERT INTO t (Email, "Created", id) VALUES (1, 2, 3)'), [
    't [insert] insert=complete(Created,email,id)',
  ]);
  for (const name of ['"a,b"', '"a b"', '"it\'s"', '"say ""hi"""']) {
    assert.deepEqual(
      calls(`INSERT INTO t (a, ${name}) VALUES (1, 2)`),
      ['t [insert] insert=incomplete()'],
      name,
    );
  }
});

test('a column name with a control, format, separator or replacement character, or over 128 characters, is not encoded', () => {
  const bad: ReadonlyArray<readonly [string, string]> = [
    ['bidi override', 'b‮'],
    ['bidi override inside the name', 'b‮c'],
    ['zero-width space', 'b​c'],
    ['next line (U+0085)', 'b\u0085c'],
    ['control character', 'b\u0001c'],
    ['line separator', 'b c'],
    ['no-break space', 'b c'],
    ['replacement character', 'b�c'],
    ['private use', 'bc'],
    ['129 characters', 'x'.repeat(129)],
    ['5000 characters', 'x'.repeat(5000)],
  ];
  for (const [what, name] of bad) {
    for (const spelled of [name, `"${name}"`]) {
      assert.deepEqual(
        calls(`INSERT INTO t (a, ${spelled}) VALUES (1, 2)`),
        ['t [insert] insert=incomplete()'],
        `insert list: ${what}`,
      );
    }
    assert.deepEqual(
      calls(`UPDATE t SET a = 1, ${name} = 2`),
      ['t [update] update=incomplete()'],
      `SET target: ${what}`,
    );
    assert.deepEqual(
      calls(`INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET ${name} = 2`),
      ['t [upsert] insert=complete(a) update=incomplete()'],
      `upsert target: ${what}`,
    );
  }
  // A U+FFFF in the literal is rewritten to U+FFFD before the text is read (see sqlText), and is then such a name.
  assert.deepEqual(calls('INSERT INTO t (a, b￿) VALUES (1, 2)'), [
    't [insert] insert=incomplete()',
  ]);
  // Letters of other scripts, digits, `$` and `_` are names, and so is a name of exactly 128 characters.
  assert.deepEqual(calls('INSERT INTO t (café, 名前, a_1$, "Ünï") VALUES (1, 2, 3, 4)'), [
    't [insert] insert=complete(a_1$,café,Ünï,名前)',
  ]);
  assert.deepEqual(calls(`INSERT INTO t (${'x'.repeat(128)}) VALUES (1)`), [
    `t [insert] insert=complete(${'x'.repeat(128)})`,
  ]);
});

test('a literal that is an operand of + never yields a complete column set', () => {
  assert.deepEqual(calls('INSERT INTO t (a, b) VALUES (?, ?)', true), [
    't [insert] insert=incomplete()',
  ]);
  assert.deepEqual(calls('UPDATE t SET a = 1 WHERE id = ', true), [
    't [update] update=incomplete()',
  ]);
  assert.deepEqual(
    calls('INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET b = 1', true),
    ['t [upsert] insert=incomplete() update=incomplete()'],
  );
  // The table is still known.
  assert.deepEqual(calls('DELETE FROM t WHERE id = ', true), ['t [delete]']);
});

/* ----------------------------------------------------- interpolated text */

test('the text of a template joins its parts with one sentinel per substitution', () => {
  assert.equal(sqlText(['a', 'b', 'c']), `a${SUBSTITUTION}b${SUBSTITUTION}c`);
  assert.equal(sqlText(['plain']), 'plain');
  // The sentinel is not `?`, which occurs in SQL (the PostgreSQL jsonb operator, a parameter marker).
  assert.notEqual(SUBSTITUTION, '?');
});

test('a sentinel character already in a literal is not read as a substitution', () => {
  const text = sqlText([`INSERT INTO t (a, b) VALUES ('${SUBSTITUTION}', 2)`]);
  assert.ok(!text.includes(SUBSTITUTION), 'the literal could smuggle in a placeholder');
  assert.deepEqual(show(classifyRawSql(text)), ['t [insert] insert=complete(a,b)']);
  // The same character in a table position does not make the table a placeholder.
  assert.deepEqual(untraced([`INSERT INTO t${SUBSTITUTION} (a) VALUES (1)`]), []);
  assert.deepEqual(untraced(['INSERT INTO t', ' (a) VALUES (1)']), ['table-placeholder']);
});

test('a substitution in a value position changes nothing about the statement', () => {
  assert.deepEqual(calls(['INSERT INTO t (a, b) VALUES (', ", 'k')"]), [
    't [insert] insert=complete(a,b)',
  ]);
  assert.deepEqual(calls(['UPDATE t SET a = ', ', b = ', ' WHERE id = ', '']), [
    't [update] update=complete(a,b)',
  ]);
  assert.deepEqual(calls(['DELETE FROM t WHERE id = ', '']), ['t [delete]']);
  assert.deepEqual(calls(['SELECT id FROM users WHERE email = ', '']), ['users [select]']);
  assert.deepEqual(
    calls(['INSERT INTO t (a, b) VALUES (', ', ', ') ON CONFLICT (a) DO UPDATE SET b = ', '']),
    ['t [upsert] insert=complete(a,b) update=complete(b)'],
  );
});

test('a substitution in the table position makes the table non-literal: counted, no edge', () => {
  const shapes: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['alone', ['INSERT INTO ', ' (a) VALUES (1)']],
    ['qualified by a substitution', ['INSERT INTO ', '.users (a) VALUES (1)']],
    ['qualifying a substitution', ['INSERT INTO public.', ' (a) VALUES (1)']],
    ['a suffix', ['INSERT INTO users_', ' (a) VALUES (1)']],
    ['a prefix', ['INSERT INTO ', 'users (a) VALUES (1)']],
    ['inside quotes', ['INSERT INTO "', '" (a) VALUES (1)']],
    ['update', ['UPDATE ', ' SET a = 1']],
    ['update with a suffix', ['UPDATE users_', ' SET a = 1']],
    ['delete', ['DELETE FROM ', ' WHERE id = 1']],
    ['delete inside quotes', ['DELETE FROM "', '"']],
  ];
  for (const [label, parts] of shapes) {
    assert.deepEqual(read(parts), { calls: [], unattributed: ['table-placeholder'] }, label);
  }
});

test('a substitution in a column list or a SET target keeps the statement and leaves its set incomplete', () => {
  assert.deepEqual(calls(['INSERT INTO t (a, ', ') VALUES (1, 2)']), [
    't [insert] insert=incomplete()',
  ]);
  assert.deepEqual(calls(['INSERT INTO t (', ') VALUES (1)']), ['t [insert] insert=incomplete()']);
  assert.deepEqual(calls(['INSERT INTO t (a, col_', ') VALUES (1, 2)']), [
    't [insert] insert=incomplete()',
  ]);
  assert.deepEqual(calls(['INSERT INTO t (a, b) ', '']), ['t [insert] insert=incomplete()']);
  assert.deepEqual(calls(['UPDATE t SET ', ' = 1']), ['t [update] update=incomplete()']);
  assert.deepEqual(calls(['UPDATE t SET a = 1, ', '']), ['t [update] update=incomplete()']);
  assert.deepEqual(calls(['UPDATE t SET ', '']), ['t [update] update=incomplete()']);
  assert.deepEqual(untraced(['INSERT INTO t (a, ', ') VALUES (1, 2)']), []);
});

test('a substitution right after a value in a SET clause may add assignments, so the set is incomplete', () => {
  // The review fixture: a fragment that adds `, email = ...` follows the value of `name` with nothing between.
  assert.deepEqual(calls(['UPDATE users SET name = ', ' ', ' WHERE id = ', '']), [
    'users [update] update=incomplete()',
  ]);
  // After each kind of value: a number, a string, a parameter, a column, a call, another substitution.
  for (const value of ['1', "'x'", '$1', 'other_col', 'now()', 'a.b', 'NULL', 'END']) {
    assert.deepEqual(
      calls([`UPDATE t SET a = ${value} `, '']),
      ['t [update] update=incomplete()'],
      value,
    );
  }
  assert.deepEqual(calls(['UPDATE t SET a = ', ' ', '']), ['t [update] update=incomplete()']);
  // Touching the value counts as directly after it.
  assert.deepEqual(calls(['UPDATE t SET a = 1', '']), ['t [update] update=incomplete()']);
  assert.deepEqual(calls(['UPDATE t SET a = ', '', '']), ['t [update] update=incomplete()']);
  assert.deepEqual(calls(['UPDATE t SET a = x_', '']), ['t [update] update=incomplete()']);
  // The same in the update half of an upsert and of a MERGE; the insert half is unaffected.
  assert.deepEqual(
    calls(['INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET b = 1 ', '']),
    ['t [upsert] insert=complete(a) update=incomplete()'],
  );
  assert.deepEqual(calls(['INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE b = 1 ', '']), [
    't [upsert] insert=complete(a) update=incomplete()',
  ]);
  assert.deepEqual(
    calls(['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET b = 1 ', '']),
    ['t [upsert] insert=incomplete() update=incomplete()'],
  );
  // A substitution that is a whole value, or follows an operator or a keyword, leaves the set complete.
  for (const [parts, expected] of [
    [['UPDATE t SET a = ', ', b = ', ' WHERE id = ', ''], 'update=complete(a,b)'],
    [['UPDATE t SET a = ', ' + 1'], 'update=complete(a)'],
    [['UPDATE t SET a = a || ', ''], 'update=complete(a)'],
    [['UPDATE t SET a = -', ''], 'update=complete(a)'],
    [['UPDATE t SET a = coalesce(', ', a)'], 'update=complete(a)'],
    [['UPDATE t SET a = CASE WHEN ', ' THEN ', ' ELSE ', ' END'], 'update=complete(a)'],
    [['UPDATE t SET a = ', '::int'], 'update=complete(a)'],
    [['UPDATE t SET a = ', ' IS NULL'], 'update=complete(a)'],
    [['UPDATE t SET a = b AND ', ''], 'update=complete(a)'],
    [['UPDATE t SET a = NOT ', ''], 'update=complete(a)'],
    [['UPDATE t SET a = 1, b = ', ' WHERE id = ', ''], 'update=complete(a,b)'],
  ] as const) {
    assert.deepEqual(calls(parts), [`t [update] ${expected}`], parts.join('${}'));
  }
});

test('a read whose table a substitution touches names no table', () => {
  for (const parts of [
    ['SELECT id FROM "', '" WHERE x = 1'],
    ['SELECT id FROM users_', ' WHERE x = 1'],
    ['SELECT id FROM ', '.users'],
    ['SELECT id FROM public.', ''],
    ['SELECT id FROM ', ''],
  ]) {
    assert.deepEqual(read(parts), { calls: [], unattributed: [] }, parts.join('${}'));
  }
  // A literal table next to a substitution elsewhere is still read.
  assert.deepEqual(calls(['SELECT id FROM users WHERE a = ', ' AND b IN (', ')']), [
    'users [select]',
  ]);
});

/* --------------------------------------------- comments, reads, many statements */

test('a statement preceded by a comment is read as the statement it is', () => {
  assert.deepEqual(calls('-- load the user\nSELECT id FROM users WHERE id = $1'), [
    'users [select]',
  ]);
  assert.deepEqual(calls('/* upsert */ INSERT INTO t (a) VALUES (1)'), [
    't [insert] insert=complete(a)',
  ]);
  assert.deepEqual(calls('-- a\n-- b\n\n  UPDATE t SET a = 1'), ['t [update] update=complete(a)']);
  assert.deepEqual(calls(['-- note\nDELETE FROM t WHERE id = ', '']), ['t [delete]']);
  // A comment that hides part of the statement hides it from the reader too.
  assert.deepEqual(calls('INSERT INTO t (a, /* b, */ c) VALUES (1, 2)'), [
    't [insert] insert=complete(a,c)',
  ]);
});

test('reads keep the gate: a SELECT or WITH names the tables after FROM and JOIN', () => {
  assert.deepEqual(calls('SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id'), [
    'users [select]',
    'orders [select]',
  ]);
  assert.deepEqual(calls('WITH x AS (SELECT 1 FROM a) SELECT * FROM x'), ['a [select]']);
  assert.deepEqual(calls('select 1'), []);
  assert.deepEqual(calls('the user selected a row from the table'), []);
  // A write inside a WITH is read as a write whose columns are unknown; x is the CTE, not a table.
  assert.deepEqual(calls('WITH x AS (SELECT 1) INSERT INTO t (a) SELECT a FROM x'), [
    't [insert] insert=incomplete()',
  ]);
});

test('several statements in one literal are read one by one', () => {
  // A literal that does not start with a statement verb is not read, as the read gate has always required.
  assert.deepEqual(calls('BEGIN; INSERT INTO a (x) VALUES (1); UPDATE b SET y = 2; COMMIT'), []);
  assert.deepEqual(calls('INSERT INTO a (x) VALUES (1); UPDATE b SET y = 2'), [
    'a [insert] insert=complete(x)',
    'b [update] update=complete(y)',
  ]);
  // A `;` inside a string or a dollar-quoted body does not split.
  assert.deepEqual(calls("INSERT INTO a (x) VALUES ('1;2'); DELETE FROM b"), [
    'a [insert] insert=complete(x)',
    'b [delete]',
  ]);
});

test('the insert and the read in one statement are two calls', () => {
  assert.deepEqual(calls('INSERT INTO t (a) SELECT a FROM t WHERE a > 0'), [
    't [insert] insert=complete(a)',
    't [select]',
  ]);
});

test('text past the tokenizer nesting limit records an unattributed statement', () => {
  for (const deep of [
    `INSERT INTO t (a) VALUES ${'('.repeat(10_000)}1${')'.repeat(10_000)}`,
    `INSERT INTO t (a) VALUES ${'('.repeat(200_000)}1`,
  ]) {
    assert.deepEqual(read(deep), { calls: [], unattributed: ['resource-limit'] });
  }
});

test('MERGE branch conditions with CASE keep every INSERT and UPDATE action', () => {
  const condition =
    'CASE WHEN s.enabled THEN CASE WHEN s.ready THEN true ELSE false END ELSE false END';
  assert.deepEqual(
    calls(
      `MERGE INTO t USING s ON t.id=s.id WHEN NOT MATCHED AND ${condition} THEN INSERT (a,b) VALUES (1,2) WHEN NOT MATCHED THEN INSERT (a) VALUES (1)`,
    ),
    ['t [upsert] insert=complete(a,b) update=incomplete()'],
  );
  assert.deepEqual(
    calls(
      `MERGE INTO t USING s ON t.id=s.id WHEN MATCHED AND ${condition} THEN UPDATE SET a=1,b=2 WHEN MATCHED THEN UPDATE SET a=1`,
    ),
    ['t [upsert] insert=incomplete() update=complete(a,b)'],
  );
});

test('text that nests brackets deep but within the tokenizer limit is read without failing', () => {
  const deep = `SELECT * FROM t WHERE a IN ${'('.repeat(256)}1${')'.repeat(256)} AND EXTRACT(EPOCH FROM c) > 0`;
  assert.deepEqual(calls(deep), ['t [select]']);
});

test('cold and warmed SQL classification agree on the deterministic nesting limit', () => {
  const script = `
    import { classifyRawSql } from ${JSON.stringify(new URL('./raw-sql.ts', import.meta.url).href)};
    const query = (n) => 'SELECT ' + '('.repeat(n) + 'SELECT * FROM users' + ')'.repeat(n);
    const cold = classifyRawSql(query(3000));
    for (let depth = 100; depth <= 2500; depth += 100) classifyRawSql(query(depth));
    const warm = classifyRawSql(query(3000));
    const control = classifyRawSql(query(128));
    console.log(JSON.stringify({ cold, warm, control }));
  `;
  const actual = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8' }));
  assert.deepEqual(actual.cold, { calls: [], unattributed: ['resource-limit'] });
  assert.deepEqual(actual.warm, actual.cold);
  assert.equal(actual.control.calls[0]?.table.table, 'users');
  assert.deepEqual(actual.control.unattributed, []);
});

test('schema and quoting are kept as written for the binder', () => {
  const [call] = read('INSERT INTO "Auth".Users (id) VALUES (1)').calls;
  assert.ok(call !== undefined);
  assert.deepEqual(call.table, {
    table: 'users',
    schema: 'auth',
    tableText: 'Users',
    tableQuoted: false,
    schemaText: 'Auth',
    schemaQuoted: true,
  });
});

/* ------------------------------------------- table reader precision (reads) */

test('a name the statement defines as a CTE is not a table', () => {
  assert.deepEqual(calls('WITH sessions AS (SELECT 1 AS id) SELECT * FROM sessions'), []);
  assert.deepEqual(
    calls('WITH sessions AS (SELECT id FROM users) SELECT * FROM sessions JOIN orders ON true'),
    ['users [select]', 'orders [select]'],
  );
  // A column list, MATERIALIZED, and a name written in capitals.
  assert.deepEqual(calls('WITH t(a, b) AS (SELECT 1, 2) SELECT * FROM T'), []);
  assert.deepEqual(calls('WITH x AS MATERIALIZED (SELECT 1) SELECT * FROM x'), []);
  assert.deepEqual(calls('WITH x AS NOT MATERIALIZED (SELECT 1) SELECT * FROM x'), []);
  // Several CTEs: a later one reads an earlier one, and the main query reads both.
  assert.deepEqual(
    calls(
      'WITH a AS (SELECT * FROM t1), b AS (SELECT * FROM a) SELECT * FROM b JOIN a ON true JOIN t2 ON true',
    ),
    ['t1 [select]', 't2 [select]'],
  );
  // Nested: the inner WITH is visible in its own query only.
  assert.deepEqual(
    calls('WITH a AS (WITH b AS (SELECT 1 FROM t1) SELECT * FROM b) SELECT * FROM a'),
    ['t1 [select]'],
  );
  assert.deepEqual(
    calls('SELECT * FROM (WITH x AS (SELECT 1) SELECT * FROM x) q JOIN x ON true'),
    ['x [select]'],
    'outside the subquery that defines it, x is a table',
  );
  // WITH RECURSIVE: the CTE reads itself.
  assert.deepEqual(
    calls(
      'WITH RECURSIVE tree(id, parent) AS (SELECT id, parent FROM nodes WHERE parent IS NULL UNION ALL SELECT n.id, n.parent FROM edges n JOIN tree t ON t.id = n.parent) SELECT * FROM tree',
    ),
    ['nodes [select]', 'edges [select]'],
  );
  // Without RECURSIVE a CTE's own name inside its body is the table of that name.
  assert.deepEqual(calls('WITH users AS (SELECT * FROM users WHERE active) SELECT * FROM users'), [
    'users [select]',
  ]);
  // A CTE is an unqualified name: a schema-qualified one, or one in another case when quoted, is a table.
  assert.deepEqual(calls('WITH s AS (SELECT 1) SELECT * FROM public.s'), ['public.s [select]']);
  assert.deepEqual(calls('WITH "Sessions" AS (SELECT 1) SELECT * FROM sessions'), [
    'sessions [select]',
  ]);
  assert.deepEqual(calls('WITH "Sessions" AS (SELECT 1) SELECT * FROM "Sessions"'), []);
  // The write in a WITH keeps its table; what it returns is the CTE.
  assert.deepEqual(
    calls('WITH moved AS (DELETE FROM old RETURNING *) INSERT INTO new SELECT * FROM moved'),
    ['old [delete]', 'new [insert] insert=incomplete()'],
  );
  // A definition that is a substitution defines names the text does not show; the others are still read.
  assert.deepEqual(calls(['WITH ', ', events AS (SELECT 1) SELECT * FROM events JOIN t ON true']), [
    't [select]',
  ]);
  assert.deepEqual(
    calls(['WITH a AS (SELECT 1), ', ', c AS (SELECT * FROM a) SELECT * FROM c JOIN t ON true']),
    ['t [select]'],
  );
  // A write whose query holds a WITH.
  assert.deepEqual(calls('INSERT INTO t (a) WITH src AS (SELECT 1 AS a) SELECT a FROM src'), [
    't [insert] insert=incomplete()',
  ]);
});

test('a FROM or JOIN name followed by ( is a function, not a table', () => {
  assert.deepEqual(calls('SELECT * FROM generate_series(1, 10) AS g(n)'), []);
  assert.deepEqual(calls('SELECT * FROM public.jsonb_to_recordset(x) AS r(a int)'), []);
  assert.deepEqual(
    calls('SELECT u.id FROM users u CROSS JOIN unnest(u.tags) AS tag JOIN orders o ON true'),
    ['users [select]', 'orders [select]'],
  );
  assert.deepEqual(calls('INSERT INTO t (a) SELECT n FROM generate_series(1, 3) n'), [
    't [insert] insert=complete(a)',
  ]);
  // The name of an INSERT target followed by its column list is the table.
  assert.deepEqual(calls('WITH x AS (INSERT INTO t (a) VALUES (1) RETURNING a) SELECT a FROM x'), [
    't [insert] insert=incomplete()',
  ]);
});

test('LATERAL is a keyword, and ONLY names the table that follows it', () => {
  assert.deepEqual(
    calls(
      'SELECT * FROM users u LEFT JOIN LATERAL (SELECT * FROM orders o WHERE o.user_id = u.id LIMIT 1) l ON true',
    ),
    ['users [select]', 'orders [select]'],
  );
  assert.deepEqual(calls('SELECT * FROM LATERAL (SELECT 1) l'), []);
  assert.deepEqual(calls('SELECT * FROM ONLY parent'), ['parent [select]']);
  assert.deepEqual(calls('SELECT * FROM ONLY public.parent p'), ['public.parent [select]']);
  assert.deepEqual(calls('SELECT * FROM a JOIN ONLY "Child" c ON true'), [
    'a [select]',
    'child [select]',
  ]);
  assert.deepEqual(calls('WITH x AS (UPDATE ONLY parent SET a = 1 RETURNING *) SELECT * FROM x'), [
    'parent [update] update=incomplete()',
  ]);
  // A quoted word is a name, not a keyword.
  assert.deepEqual(calls('SELECT * FROM "lateral"'), ['lateral [select]']);
});

test('a row-locking clause is not a write, and its OF list and wait policy are not tables', () => {
  for (const lock of [
    'FOR UPDATE',
    'FOR UPDATE SKIP LOCKED',
    'FOR UPDATE NOWAIT',
    'FOR UPDATE OF j',
    'FOR UPDATE OF j, k SKIP LOCKED',
    'FOR NO KEY UPDATE',
    'FOR NO KEY UPDATE SKIP LOCKED',
    'for update\n  skip locked',
    'FOR SHARE',
    'FOR SHARE NOWAIT',
    'FOR SHARE OF j SKIP LOCKED',
    'FOR KEY SHARE',
  ]) {
    assert.deepEqual(
      calls(`SELECT id FROM jobs j WHERE state = 'queued' ORDER BY id LIMIT 1 ${lock}`),
      ['jobs [select]'],
      lock,
    );
  }
  assert.deepEqual(
    calls('UPDATE jobs SET state = 1 WHERE id IN (SELECT id FROM q FOR UPDATE SKIP LOCKED)'),
    ['jobs [update] update=complete(state)', 'q [select]'],
  );
  // An UPDATE that is a write is still one.
  assert.deepEqual(calls('WITH m AS (UPDATE jobs SET state = 1 RETURNING id) SELECT * FROM m'), [
    'jobs [update] update=incomplete()',
  ]);
});

test('FROM inside EXTRACT, SUBSTRING, TRIM and OVERLAY is not a table slot', () => {
  assert.deepEqual(calls('SELECT EXTRACT(EPOCH FROM created_at) AS e FROM events'), [
    'events [select]',
  ]);
  assert.deepEqual(
    calls('select sum(extract(epoch from sr.ended_at - sr.started_at)) from session_replay sr'),
    ['session_replay [select]'],
  );
  assert.deepEqual(calls('SELECT SUBSTRING(name FROM 2 FOR 3) FROM users'), ['users [select]']);
  assert.deepEqual(calls("SELECT TRIM(BOTH ' ' FROM name) FROM users"), ['users [select]']);
  assert.deepEqual(calls('SELECT TRIM(LEADING FROM name) FROM users'), ['users [select]']);
  assert.deepEqual(calls("SELECT OVERLAY(name PLACING 'x' FROM 2) FROM users"), ['users [select]']);
  assert.deepEqual(calls("SELECT POSITION('a' IN name) FROM users"), ['users [select]']);
  // A real subquery inside the call is read as one.
  assert.deepEqual(calls('SELECT EXTRACT(EPOCH FROM (SELECT max(at) FROM audit)) FROM users'), [
    'audit [select]',
    'users [select]',
  ]);
  // The comparison IS [NOT] DISTINCT FROM is not a table slot either; SELECT DISTINCT FROM t is.
  assert.deepEqual(calls('SELECT * FROM a WHERE a.x IS DISTINCT FROM b.y'), ['a [select]']);
  assert.deepEqual(calls('SELECT * FROM a WHERE a.x IS NOT DISTINCT FROM b'), ['a [select]']);
  assert.deepEqual(calls('SELECT DISTINCT FROM t'), ['t [select]']);
  // Outside such a call, FROM names a table.
  assert.deepEqual(calls('SELECT count(*) FROM events WHERE created_at > now()'), [
    'events [select]',
  ]);
});
