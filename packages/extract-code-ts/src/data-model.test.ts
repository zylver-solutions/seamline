/**
 * Binding a SQL table name to a declared table, one rule per test.
 *
 * Each test builds the index document by hand, in the documented format, so
 * this package's tests do not need `extract-data`; the integration package
 * builds the same document from the real extractor and reads it with this code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeId } from '@seamline/ontology';
import { parseDataModelIndex, tableBinder } from './data-model.ts';
import type { TableBinding } from './data-model.ts';
import { canonicalJson } from './serialize.ts';
import { sqlTableOccurrences } from './sql.ts';

interface Declared {
  readonly schema: string;
  readonly name: string;
  /** The table's own dialect, when it differs from its data source's. */
  readonly dialect?: string;
}

function indexText(dialect: string, defaultSchema: string, tables: readonly Declared[]): string {
  return canonicalJson({
    version: 1,
    dataSources: [{ name: 'default', dialect, defaultSchema }],
    tables: tables.map((t) => ({
      id: `r:Table:${t.schema}.${t.name}`,
      dataSource: 'default',
      schema: t.schema,
      name: t.name,
      ...(t.dialect === undefined ? {} : { dialect: t.dialect }),
    })),
    prismaDelegates: {},
    drizzleExports: {},
  });
}

function binder(
  dialect: string,
  tables: readonly Declared[],
  defaultSchema = 'public',
): (sql: string) => TableBinding {
  const parsed = parseDataModelIndex(indexText(dialect, defaultSchema, tables), 'r');
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem);
  const bind = tableBinder(parsed.index);
  return (sql) => {
    const refs = sqlTableOccurrences(sql);
    assert.equal(refs.length, 1, `expected one table in: ${sql}`);
    return bind(refs[0] as NonNullable<(typeof refs)[number]>);
  };
}

const id = (value: string): NodeId => value as NodeId;

/* ------------------------------------------------------------ dialect rules */

test('Postgres: an unquoted name folds to lower case and does not reach a quoted mixed-case table', () => {
  const bind = binder('postgres', [{ schema: 'public', name: 'Invitation' }]);
  // `FROM Invitation` is `invitation` to Postgres, which is not the table `"Invitation"`.
  assert.deepEqual(bind('SELECT id FROM Invitation'), { kind: 'none' });
  assert.deepEqual(bind('SELECT id FROM invitation'), { kind: 'none' });
  // Quoted, the name is exact, and it is the table.
  assert.deepEqual(bind('SELECT id FROM "Invitation"'), {
    kind: 'bound',
    id: id('r:Table:public.Invitation'),
  });
  assert.deepEqual(bind('SELECT id FROM "invitation"'), { kind: 'none' });
});

test('Postgres: an unquoted mixed-case name reaches the lower-case table it folds to, a quoted one does not', () => {
  const bind = binder('postgres', [{ schema: 'public', name: 'users' }]);
  assert.deepEqual(bind('SELECT id FROM Users'), { kind: 'bound', id: id('r:Table:public.users') });
  assert.deepEqual(bind('SELECT id FROM USERS'), { kind: 'bound', id: id('r:Table:public.users') });
  assert.deepEqual(bind('SELECT id FROM "Users"'), { kind: 'none' });
});

test('SQLite compares case-insensitively, quoted or not', () => {
  const bind = binder('sqlite', [{ schema: 'public', name: 'Invitation' }]);
  const bound = { kind: 'bound', id: id('r:Table:public.Invitation') };
  assert.deepEqual(bind('SELECT id FROM invitation'), bound);
  assert.deepEqual(bind('SELECT id FROM INVITATION'), bound);
  assert.deepEqual(bind('SELECT id FROM "invitation"'), bound);
});

test('MySQL compares exactly: a name that differs in case is not the table', () => {
  const bind = binder('mysql', [{ schema: 'public', name: 'Invitation' }]);
  assert.deepEqual(bind('SELECT id FROM Invitation'), {
    kind: 'bound',
    id: id('r:Table:public.Invitation'),
  });
  assert.deepEqual(bind('SELECT id FROM invitation'), { kind: 'none' });
});

test('a table read by another dialect than its data source is compared by its own', () => {
  const bind = binder('postgres', [
    { schema: 'public', name: 'Events', dialect: 'clickhouse' },
    { schema: 'public', name: 'Invitation' },
  ]);
  // ClickHouse folds nothing, so an unquoted name is exactly what was written; PostgreSQL would fold it.
  assert.deepEqual(bind('SELECT id FROM Events'), {
    kind: 'bound',
    id: id('r:Table:public.Events'),
  });
  assert.deepEqual(bind('SELECT id FROM events'), { kind: 'none' });
  // The rest of the data source keeps its own rules.
  assert.deepEqual(bind('SELECT id FROM Invitation'), { kind: 'none' });
  assert.deepEqual(bind('SELECT id FROM "Invitation"'), {
    kind: 'bound',
    id: id('r:Table:public.Invitation'),
  });
});

test('a dialect the binder does not know compares exactly instead of guessing', () => {
  const bind = binder('clickhouse', [{ schema: 'public', name: 'events' }]);
  assert.deepEqual(bind('SELECT id FROM events'), {
    kind: 'bound',
    id: id('r:Table:public.events'),
  });
  assert.deepEqual(bind('SELECT id FROM Events'), { kind: 'none' });
});

/* ----------------------------------------------------------------- schemas */

const AUTH_AND_PUBLIC: readonly Declared[] = [
  { schema: 'auth', name: 'users' },
  { schema: 'public', name: 'users' },
];

test('an unqualified name binds to the default schema when another schema also has the table', () => {
  const bind = binder('postgres', AUTH_AND_PUBLIC);
  assert.deepEqual(bind('SELECT id FROM users'), { kind: 'bound', id: id('r:Table:public.users') });
});

test('a schema-qualified name binds only to that schema', () => {
  const bind = binder('postgres', AUTH_AND_PUBLIC);
  assert.deepEqual(bind('SELECT id FROM auth.users'), {
    kind: 'bound',
    id: id('r:Table:auth.users'),
  });
  assert.deepEqual(bind('UPDATE public.users SET email = $1'), {
    kind: 'bound',
    id: id('r:Table:public.users'),
  });
  // `app` declares no `users`: the reference must not fall through to `public.users`.
  assert.deepEqual(bind('SELECT id FROM app.users'), { kind: 'none' });
});

test('an unqualified name declared in several schemas, none the default, is ambiguous', () => {
  const bind = binder('postgres', [
    { schema: 'auth', name: 'users' },
    { schema: 'app', name: 'users' },
  ]);
  assert.deepEqual(bind('INSERT INTO users (id) VALUES (1)'), {
    kind: 'ambiguous',
    tables: ['users'],
  });
  // Qualified, the same statement is not ambiguous.
  assert.deepEqual(bind('INSERT INTO app.users (id) VALUES (1)'), {
    kind: 'bound',
    id: id('r:Table:app.users'),
  });
});

test('an unqualified name declared in one non-default schema only is not bound, not ambiguous, and names the table', () => {
  const bind = binder('postgres', [{ schema: 'auth', name: 'users' }]);
  assert.deepEqual(bind('SELECT id FROM users'), { kind: 'elsewhere', tables: ['users'] });
  // Qualified with a schema that declares nothing, the same name is simply not bound.
  assert.deepEqual(bind('SELECT id FROM app.users'), { kind: 'none' });
  // A default-schema table of that name wins: the other schema's table is not a candidate.
  const both = binder('postgres', [
    { schema: 'auth', name: 'users' },
    { schema: 'public', name: 'users' },
  ]);
  assert.deepEqual(both('SELECT id FROM users'), { kind: 'bound', id: id('r:Table:public.users') });
});

test('a name declared in one non-default schema is found under the dialect folding of that table', () => {
  assert.deepEqual(
    binder('sqlite', [{ schema: 'only_other', name: 'Widgets' }])('SELECT id FROM widgets'),
    { kind: 'elsewhere', tables: ['Widgets'] },
  );
  assert.deepEqual(
    binder('postgres', [{ schema: 'only_other', name: 'Widgets' }])('SELECT id FROM widgets'),
    { kind: 'none' },
    'unquoted folds to lower case, which is not the declared mixed-case name',
  );
});

test('the default schema is the data source\'s, not always "public"', () => {
  const bind = binder(
    'postgres',
    [
      { schema: 'app', name: 'users' },
      { schema: 'public', name: 'users' },
    ],
    'app',
  );
  assert.deepEqual(bind('SELECT id FROM users'), { kind: 'bound', id: id('r:Table:app.users') });
});

test('a name no table matches is not ambiguous and not bound', () => {
  const bind = binder('postgres', AUTH_AND_PUBLIC);
  assert.deepEqual(bind('SELECT id FROM widgets'), { kind: 'none' });
});

test('a name a case-folding dialect cannot tell apart is ambiguous and lists both tables', () => {
  const bind = binder('sqlite', [
    { schema: 'public', name: 'Users' },
    { schema: 'public', name: 'users' },
  ]);
  assert.deepEqual(bind('SELECT id FROM users'), { kind: 'ambiguous', tables: ['Users', 'users'] });
});

/* ----------------------------------------------------------------- parsing */

test('a refused index says why, and a document for another repository is refused', () => {
  const good = indexText('postgres', 'public', [{ schema: 'public', name: 'users' }]);
  assert.equal(parseDataModelIndex(good, 'r').ok, true);

  const reasons = new Map<string, string>([
    ['not json', 'not JSON'],
    ['[]', 'not an object'],
    [JSON.stringify({ version: 2 }), 'unsupported version'],
    [good.replace('"version":1', '"version":1,"tables":"x"'), 'tables is not an array'],
    [good.replace('r:Table:public.users', 'r:Column:public.users'), 'is not a Table id'],
    [good.replace('r:Table:public.users', 'public.users'), 'is not a node id'],
  ]);
  for (const [text, expected] of reasons) {
    const parsed = parseDataModelIndex(text, 'r');
    assert.equal(parsed.ok, false, text);
    if (!parsed.ok)
      assert.ok(parsed.problem.includes(expected), `${parsed.problem} should mention ${expected}`);
  }

  const other = parseDataModelIndex(good, 'another-repo');
  assert.equal(other.ok, false);
  if (!other.ok) assert.ok(other.problem.includes('another repository'));
});

test('tables are read in id order whatever order the document lists them in', () => {
  const forward = parseDataModelIndex(indexText('postgres', 'public', AUTH_AND_PUBLIC), 'r');
  const backward = parseDataModelIndex(
    indexText('postgres', 'public', [...AUTH_AND_PUBLIC].reverse()),
    'r',
  );
  assert.ok(forward.ok && backward.ok);
  assert.deepEqual(forward.index.tables, backward.index.tables);
});

/* ----------------------------------------------------- lookup by folded name */

test('the lookup by folded name answers exactly what comparing every table does', () => {
  // The reference is the rule written out over every table: the same folding per table, the
  // same default-schema and ambiguity rules, with no bucket. The tables mix dialects, schemas
  // and spellings so that each folding is exercised against each spelling of the reference.
  const tables: Declared[] = [
    { schema: 'public', name: 'Users' },
    { schema: 'public', name: 'users' },
    { schema: 'auth', name: 'users' },
    { schema: 'auth', name: 'Events' },
    { schema: 'app', name: 'events' },
    { schema: 'app', name: 'LEGACY', dialect: 'mysql' },
    { schema: 'public', name: 'Legacy', dialect: 'sqlite' },
    { schema: 'billing', name: 'Invoices' },
    { schema: 'public', name: 'orders' },
  ];
  const names = [
    'users',
    'Users',
    'USERS',
    'events',
    'Events',
    'legacy',
    'LEGACY',
    'Legacy',
    'invoices',
    'Invoices',
    'orders',
    'nothing',
  ];
  const schemas: Array<string | null> = [
    null,
    'public',
    'PUBLIC',
    'auth',
    'app',
    'billing',
    'missing',
  ];
  for (const dialect of ['postgres', 'sqlite', 'mysql', 'clickhouse']) {
    const parsed = parseDataModelIndex(indexText(dialect, 'public', tables), 'r');
    assert.ok(parsed.ok);
    const bucketed = tableBinder(parsed.index);
    const folds = (d: string): 'postgres' | 'sqlite' | 'exact' =>
      ['postgres', 'postgresql'].includes(d)
        ? 'postgres'
        : ['sqlite', 'sqlite3'].includes(d)
          ? 'sqlite'
          : 'exact';
    const same = (f: string, written: string, quoted: boolean, declared: string): boolean =>
      f === 'postgres'
        ? (quoted ? written : written.toLowerCase()) === declared
        : f === 'sqlite'
          ? written.toLowerCase() === declared.toLowerCase()
          : written === declared;
    const reference = (ref: ReturnType<typeof sqlTableOccurrences>[number]): TableBinding => {
      const f = (t: (typeof parsed.index.tables)[number]) => folds(t.dialect ?? dialect);
      const named = parsed.index.tables.filter((t) =>
        same(f(t), ref.tableText, ref.tableQuoted, t.name),
      );
      const resolved =
        ref.schemaText !== null
          ? named.filter((t) => same(f(t), ref.schemaText as string, ref.schemaQuoted, t.schema))
          : named.filter((t) => t.schema === 'public');
      const physical = (list: typeof named): string[] =>
        [...new Set(list.map((t) => t.name))].sort();
      if (resolved.length === 1)
        return { kind: 'bound', id: (resolved[0] as (typeof named)[number]).id };
      if (resolved.length > 1) return { kind: 'ambiguous', tables: physical(resolved) };
      if (ref.schemaText === null && named.length > 0) {
        return new Set(named.map((t) => t.schema)).size > 1
          ? { kind: 'ambiguous', tables: physical(named) }
          : { kind: 'elsewhere', tables: physical(named) };
      }
      return { kind: 'none' };
    };
    for (const name of names) {
      for (const schema of schemas) {
        for (const quoteTable of [false, true]) {
          const q = (text: string, quoted: boolean): string => (quoted ? `"${text}"` : text);
          const text = `SELECT id FROM ${schema === null ? '' : `${q(schema, quoteTable)}.`}${q(name, quoteTable)}`;
          const [ref] = sqlTableOccurrences(text);
          assert.ok(ref !== undefined, text);
          assert.deepEqual(bucketed(ref), reference(ref), `${dialect}: ${text}`);
        }
      }
    }
  }
});
