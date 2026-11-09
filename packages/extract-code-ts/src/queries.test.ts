/**
 * `QUERIES` edges from raw SQL, through the whole extractor: one edge per
 * (symbol, table), folded order-independently, with the interpolated templates
 * of a tagged-template client read like any other statement. Design:
 * `docs/design/real-world-inputs.md`, 3.4, 4.2 and 7.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SeamlineEdge } from '@seamline/ontology';
import { extractCodeTs } from './extract.ts';
import type { ExtractCodeTsOutput } from './extract.ts';
import { canonicalJson, toCanonicalSif } from './serialize.ts';
import { cleanup, materialize } from './__fixtures__/projects.ts';
import type { FileMap } from './__fixtures__/projects.ts';

const PACKAGE_JSON = JSON.stringify({ name: '@fixture/app', version: '1.0.0', type: 'module' });
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['src'],
});

/** The declarations every fixture shares: a tagged-template client and a plain one. */
const PRELUDE = `declare function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
declare const prisma: { $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> };
declare const db: { execute(query: unknown): Promise<unknown> };
declare const client: { query(text: string, params?: unknown[]): Promise<unknown> };
`;

const roots: string[] = [];
let counter = 0;

/**
 * A data-model index that declares no table. A run without an index is UNAVAILABLE when it reads raw SQL
 * (see the last test), so the fixtures run with one; a name it does not declare keeps the name-only edge.
 */
const NO_TABLES = JSON.stringify({
  version: 1,
  dataSources: [{ name: 'default', dialect: 'postgres', defaultSchema: 'public' }],
  tables: [],
  prismaDelegates: {},
  drizzleExports: {},
});

function run(files: FileMap, dataModelIndex: string | null = NO_TABLES): ExtractCodeTsOutput {
  const root = materialize(
    { 'package.json': PACKAGE_JSON, 'tsconfig.json': TSCONFIG, ...files },
    `queries-${(counter += 1)}`,
  );
  roots.push(root);
  return extractCodeTs({
    repoRoot: root,
    repo: 'fixture',
    runId: 'run-1',
    deterministic: true,
    ...(dataModelIndex === null ? {} : { dataModelIndex }),
  });
}

function one(source: string, dataModelIndex?: string): ExtractCodeTsOutput {
  return run({ 'src/queries.ts': `${PRELUDE}${source}` }, dataModelIndex);
}

after(() => {
  for (const root of roots) cleanup(root);
});

/** `caller -> table` of an edge, by function name and table name. */
function label(e: SeamlineEdge): string {
  const caller = String(e.src).replace('fixture:Symbol:@fixture/app#', '');
  return `${caller} -> ${String(e.dst).replace('fixture:Table:', '')}`;
}

function queryEdges(output: ExtractCodeTsOutput): SeamlineEdge[] {
  return output.edges.filter((e) => e.kind === 'QUERIES');
}

/** The props of the single `QUERIES` edge the fixture is expected to produce. */
function edgeOf(output: ExtractCodeTsOutput): SeamlineEdge {
  const edges = queryEdges(output);
  assert.equal(edges.length, 1, `expected one QUERIES edge, got ${edges.map(label).join('; ')}`);
  return edges[0] as SeamlineEdge;
}

function byLabel(output: ExtractCodeTsOutput): Record<string, SeamlineEdge> {
  return Object.fromEntries(queryEdges(output).map((e) => [label(e), e]));
}

/** The edge from `save` to `users`, whatever else `save` reads. */
function saveToUsers(output: ExtractCodeTsOutput): SeamlineEdge {
  const edge = byLabel(output)['save -> public.users'];
  assert.ok(
    edge !== undefined,
    `no save -> users edge in ${queryEdges(output).map(label).join('; ')}`,
  );
  return edge;
}

function repoProps(
  output: ExtractCodeTsOutput,
): Readonly<Record<string, string | number | boolean | null>> {
  const repo = output.nodes.find((n) => n.kind === 'Repo');
  assert.ok(repo !== undefined, 'no Repo node');
  return repo.props;
}

/* ------------------------------------------- the instance-shaped regression */

test('a SQL tokenizer resource limit makes the code scope unavailable and records the untraced write', () => {
  const deep = `INSERT INTO t (a) VALUES ${'('.repeat(10_000)}1${')'.repeat(10_000)}`;
  const output = one(`export function save(): string { return ${JSON.stringify(deep)}; }`);
  assert.equal(output.result.status, 'UNAVAILABLE');
  assert.equal(repoProps(output)['untracedWriteCalls'], 1);
  assert.deepEqual(queryEdges(output), []);
  assert.ok(
    output.result.diagnostics.some((d) =>
      d.includes('SQL tokenizer resource limit at src/queries.ts:5'),
    ),
  );
});

test('MERGE CASE conditions preserve every branch column through extraction', () => {
  for (const [action, expected] of [
    [
      'WHEN NOT MATCHED AND CASE WHEN s.enabled THEN true ELSE false END THEN INSERT (a,b) VALUES (1,2) WHEN NOT MATCHED THEN INSERT (a) VALUES (1)',
      { insertColumns: 'a,b', insertComplete: true },
    ],
    [
      'WHEN MATCHED AND CASE WHEN s.enabled THEN true ELSE false END THEN UPDATE SET a=1,b=2 WHEN MATCHED THEN UPDATE SET a=1',
      { updateColumns: 'a,b', updateComplete: true },
    ],
  ] as const) {
    const sql = `MERGE INTO t USING s ON t.id=s.id ${action}`;
    const output = one(`export function save(): string { return ${JSON.stringify(sql)}; }`);
    assert.equal(output.result.status, 'PASS');
    const edge = edgeOf(output);
    for (const [key, value] of Object.entries(expected)) assert.equal(edge.props[key], value);
  }
});

test('a tagged template with a substitution in VALUES is an insert edge with its column list', () => {
  const output = one(`
export async function load(x: string): Promise<void> {
  await sql\`INSERT INTO t (a, b) VALUES (\${x}, 'k')\`;
}
`);
  assert.equal(output.result.status, 'PASS');
  const edge = edgeOf(output);
  assert.equal(label(edge), 'load -> public.t');
  assert.equal(edge.provenance, 'EXTRACTED');
  assert.equal(edge.confidence, 0.7, 'a name-only table binding stays at 0.7');
  assert.equal(edge.srcFile, 'src/queries.ts');
  assert.equal(edge.sourceRef, 'src/queries.ts:7', 'the line the template opens on');
  assert.deepEqual(edge.props, {
    binding: 'unqualified-name',
    insertColumns: 'a,b',
    insertComplete: true,
    interpolated: true,
    operation: 'insert',
    schema: null,
    table: 't',
  });
});

test('every way of writing the template reads the same: untagged, tagged, nested in a call', () => {
  const forms: Record<string, string> = {
    tagged: `await sql\`INSERT INTO t (a, b) VALUES (\${x}, 'k')\`;`,
    untagged: `await client.query(\`INSERT INTO t (a, b) VALUES (\${x}, 'k')\`);`,
    executeRaw: `await prisma.$executeRaw\`INSERT INTO t (a, b) VALUES (\${x}, 'k')\`;`,
    nested: `await db.execute(sql\`INSERT INTO t (a, b) VALUES (\${x}, 'k')\`);`,
    objectInSubstitution: `await sql\`INSERT INTO t (a, b) VALUES (\${JSON.stringify({ a: 1 })}, 'k')\`;`,
    templateInSubstitution: `await sql\`INSERT INTO t (a, b) VALUES (\${ids.map((i) => \`\${i}\`).join(',')}, 'k')\`;`,
  };
  for (const [name, statement] of Object.entries(forms)) {
    const output = one(`
declare const ids: number[];
export async function load(x: string): Promise<void> {
  ${statement}
}
`);
    const edge = edgeOf(output);
    assert.deepEqual(
      edge.props,
      {
        binding: 'unqualified-name',
        insertColumns: 'a,b',
        insertComplete: true,
        interpolated: true,
        operation: 'insert',
        schema: null,
        table: 't',
      },
      name,
    );
  }
});

test('the substitutions are not read: a table name inside one is not a table', () => {
  const output = one(`
export async function load(x: string): Promise<void> {
  await sql\`SELECT id FROM users WHERE name = \${'DELETE FROM secrets'} AND k = \${'x'}\`;
}
`);
  const edges = byLabel(output);
  // The string literal inside the substitution is a literal of its own and is read as one; the template is not
  // confused by it. What the template names is `users`.
  assert.deepEqual(Object.keys(edges).sort(), ['load -> public.secrets', 'load -> public.users']);
  assert.equal(edges['load -> public.users']?.props['interpolated'], true);
  assert.equal(edges['load -> public.users']?.props['operation'], 'select');
});

/* ------------------------------------------------------- every shape, twice */

interface Shape {
  readonly name: string;
  /** The substitution-free statement, when replacing `${x}` with `?` would not be one. */
  readonly plain?: string;
  /** The statement with a substitution in a value position. */
  readonly statement: string;
  readonly props: Readonly<Record<string, string | number | boolean | null>>;
}

const BASE = { binding: 'unqualified-name', schema: null, table: 't' } as const;

const SHAPES: readonly Shape[] = [
  {
    name: 'insert',
    statement: 'INSERT INTO t (a, b) VALUES (${x}, 1)',
    props: { ...BASE, operation: 'insert', insertColumns: 'a,b', insertComplete: true },
  },
  {
    name: 'insert ignore',
    statement: 'INSERT IGNORE INTO t (a, b) VALUES (${x}, 1)',
    props: { ...BASE, operation: 'insert', insertColumns: 'a,b', insertComplete: true },
  },
  {
    name: 'insert or replace',
    statement: 'INSERT OR REPLACE INTO t (a, b) VALUES (${x}, 1)',
    props: { ...BASE, operation: 'insert', insertColumns: 'a,b', insertComplete: true },
  },
  {
    name: 'replace',
    statement: 'REPLACE INTO t (a, b) VALUES (${x}, 1)',
    props: {
      ...BASE,
      operations: 'delete,insert',
      writes: true,
      insertColumns: 'a,b',
      insertComplete: true,
    },
  },
  {
    name: 'upsert on conflict',
    statement: 'INSERT INTO t (a, b) VALUES (${x}, 1) ON CONFLICT (a) DO UPDATE SET b = ${x}',
    props: {
      ...BASE,
      operation: 'upsert',
      insertColumns: 'a,b',
      insertComplete: true,
      updateColumns: 'b',
      updateComplete: true,
    },
  },
  {
    name: 'upsert on duplicate key',
    statement: 'INSERT INTO t (a, b) VALUES (${x}, 1) ON DUPLICATE KEY UPDATE b = ${x}',
    props: {
      ...BASE,
      operation: 'upsert',
      insertColumns: 'a,b',
      insertComplete: true,
      updateColumns: 'b',
      updateComplete: true,
    },
  },
  {
    name: 'merge',
    statement:
      'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET b = ${x} WHEN NOT MATCHED THEN INSERT (a, b) VALUES (${x}, 1)',
    props: {
      ...BASE,
      operation: 'upsert',
      insertColumns: 'a,b',
      insertComplete: true,
      updateColumns: 'b',
      updateComplete: true,
    },
  },
  {
    name: 'copy from',
    statement: "COPY t (a, b) FROM '${x}'",
    props: { ...BASE, operation: 'insert', insertColumns: 'a,b', insertComplete: true },
  },
  {
    name: 'update',
    statement: 'UPDATE t SET a = ${x}, b = 2 WHERE id = ${x}',
    props: { ...BASE, operation: 'update', updateColumns: 'a,b', updateComplete: true },
  },
  {
    name: 'update with an alias',
    statement: 'UPDATE t j SET a = ${x} WHERE j.id = ${x}',
    props: { ...BASE, operation: 'update', updateColumns: 'a', updateComplete: true },
  },
  {
    name: 'delete',
    statement: 'DELETE FROM t WHERE id = ${x}',
    props: { ...BASE, operation: 'delete' },
  },
  {
    name: 'truncate',
    plain: 'TRUNCATE TABLE t CASCADE',
    statement: 'TRUNCATE TABLE t ${x}',
    props: { ...BASE, operation: 'delete' },
  },
  {
    name: 'select',
    statement: 'SELECT a FROM t WHERE id = ${x}',
    props: { ...BASE, operation: 'select' },
  },
];

test('each statement shape, written as an interpolated template, gives the edge its plain form gives', () => {
  for (const shape of SHAPES) {
    // The same statement with a `?` for each substitution is a plain string literal.
    const plainText = shape.plain ?? shape.statement.replace(/\$\{x\}/g, '?');
    const plainEdge = edgeOf(
      one(`export function f(): void { client.query(${JSON.stringify(plainText)}); }`),
    );
    assert.equal(
      plainEdge.props['interpolated'],
      undefined,
      `${shape.name}: a plain literal is not interpolated`,
    );

    for (const [form, code] of [
      ['tagged', `sql\`${shape.statement}\``],
      ['untagged', `client.query(\`${shape.statement}\`)`],
      ['execute', `db.execute(sql\`${shape.statement}\`)`],
    ] as const) {
      const edge = edgeOf(one(`export function f(x: string): void { ${code}; }`));
      assert.equal(label(edge), 'f -> public.t', `${shape.name} (${form})`);
      assert.deepEqual(
        edge.props,
        { ...shape.props, interpolated: true },
        `${shape.name} (${form})`,
      );
      // Apart from `interpolated`, the plain statement gives the same props and the same confidence.
      const { interpolated: _flag, ...withoutFlag } = edge.props;
      assert.deepEqual(
        withoutFlag,
        plainEdge.props,
        `${shape.name} (${form}) vs the plain statement`,
      );
      assert.equal(edge.confidence, plainEdge.confidence, `${shape.name} (${form})`);
    }
  }
});

test('a substitution in the table slot gives no edge', () => {
  const output = one(`
export function a(t: string): void { sql\`INSERT INTO \${t} (a) VALUES (1)\`; }
export function b(s: string): void { sql\`INSERT INTO \${s}.users (a) VALUES (1)\`; }
export function c(s: string): void { sql\`INSERT INTO users_\${s} (a) VALUES (1)\`; }
export function d(t: string): void { sql\`DELETE FROM "\${t}" WHERE id = 1\`; }
export function e(t: string): void { sql\`UPDATE \${t} SET a = 1\`; }
export function f(t: string): void { sql\`SELECT id FROM users_\${t} WHERE id = 1\`; }
`);
  assert.deepEqual(queryEdges(output).map(label), []);
});

test('a substitution in the column list or in a SET target keeps the edge and leaves its set incomplete', () => {
  const output = one(`
export function a(c: string): void { sql\`INSERT INTO t (a, \${c}) VALUES (1, 2)\`; }
export function b(c: string): void { sql\`UPDATE t SET \${c} = 1\`; }
`);
  const edges = byLabel(output);
  assert.deepEqual(edges['a -> public.t']?.props, {
    ...BASE,
    operation: 'insert',
    insertComplete: false,
    interpolated: true,
  });
  assert.deepEqual(edges['b -> public.t']?.props, {
    ...BASE,
    operation: 'update',
    updateComplete: false,
    interpolated: true,
  });
});

test('a fragment spliced after a value in a SET clause leaves the update set incomplete', () => {
  // The fragment adds `, email = ...`; the set must not claim that `name` is all the statement writes.
  const output = one(`
export function save(name: string, email: string | null, id: string): void {
  sql\`UPDATE users SET name = \${name} \${email ? sql\`, email = \${email}\` : sql\`\`} WHERE id = \${id}\`;
}
export function upsert(more: string): void {
  sql\`INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET b = 1 \${more}\`;
}
`);
  const edges = byLabel(output);
  assert.deepEqual(edges['save -> public.users']?.props, {
    ...BASE,
    table: 'users',
    operation: 'update',
    updateComplete: false,
    interpolated: true,
  });
  assert.deepEqual(edges['upsert -> public.t']?.props, {
    ...BASE,
    operation: 'upsert',
    insertColumns: 'a',
    insertComplete: true,
    updateComplete: false,
    interpolated: true,
  });
});

test('a column name that hides text, or is the rewritten sentinel, leaves the column set incomplete', () => {
  // U+202E is a bidi override; U+FFFF in a literal is rewritten to U+FFFD before the text is read.
  const output = one(`
export function bidi(): void { client.query("INSERT INTO t (a, b\\u202E) VALUES (1, 2)"); }
export function sentinel(): void { client.query("INSERT INTO u (a, b\\uFFFF) VALUES (1, 2)"); }
export function plain(): void { client.query("INSERT INTO v (a, b) VALUES (1, 2)"); }
`);
  const edges = byLabel(output);
  assert.deepEqual(edges['bidi -> public.t']?.props, {
    ...BASE,
    operation: 'insert',
    insertComplete: false,
  });
  assert.deepEqual(edges['sentinel -> public.u']?.props, {
    ...BASE,
    table: 'u',
    operation: 'insert',
    insertComplete: false,
  });
  assert.deepEqual(edges['plain -> public.v']?.props, {
    ...BASE,
    table: 'v',
    operation: 'insert',
    insertColumns: 'a,b',
    insertComplete: true,
  });
});

/* --------------------------------------------------------- the fold per edge */

test('an insert and an update on one table are one edge carrying both classes and both column sets', () => {
  const edge = edgeOf(
    one(`
export function save(x: string): void {
  client.query('INSERT INTO users (id, email) VALUES (?, ?)');
  client.query('UPDATE users SET name = ?, email = ? WHERE id = ?');
}
`),
  );
  assert.deepEqual(edge.props, {
    ...BASE,
    table: 'users',
    operations: 'insert,update',
    writes: true,
    insertColumns: 'email,id',
    insertComplete: true,
    updateColumns: 'email,name',
    updateComplete: true,
  });
  assert.equal('operation' in edge.props, false, 'a reader takes `operations` when present');
});

test('two inserts with different literals give the union of their lists', () => {
  const edge = edgeOf(
    one(`
export function save(): void {
  client.query('INSERT INTO users (id, email) VALUES (?, ?)');
  client.query('INSERT INTO users (id, phone) VALUES (?, ?)');
}
`),
  );
  assert.deepEqual(edge.props, {
    ...BASE,
    table: 'users',
    operation: 'insert',
    insertColumns: 'email,id,phone',
    insertComplete: true,
  });
});

test('one undetermined insert makes the edge incomplete, and the list is the complete calls only', () => {
  const edge = saveToUsers(
    one(`
export function save(c: string): void {
  client.query('INSERT INTO users (id, email) VALUES (?, ?)');
  client.query('INSERT INTO users SELECT * FROM staging');
}
`),
  );
  assert.equal(edge.props['insertComplete'], false);
  assert.equal(
    edge.props['insertColumns'],
    'email,id',
    'never a shorter list presented as complete',
  );
});

test('an upsert is one class with both halves, and folds with an update', () => {
  const upsert = edgeOf(
    one(`
export function save(): void {
  client.query('INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email');
}
`),
  );
  assert.deepEqual(upsert.props, {
    ...BASE,
    table: 'users',
    operation: 'upsert',
    insertColumns: 'email,id',
    insertComplete: true,
    updateColumns: 'email',
    updateComplete: true,
  });
  const both = edgeOf(
    one(`
export function save(): void {
  client.query('INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email');
  client.query('UPDATE users SET name = ? WHERE id = ?');
}
`),
  );
  assert.equal(both.props['operations'], 'update,upsert');
  assert.equal(both.props['updateColumns'], 'email,name');
  assert.equal(both.props['insertColumns'], 'email,id');
});

test('a single class keeps `operation` and gains no per-class prop it has no fact for', () => {
  const output = one(`
export function read(): void { client.query('SELECT id FROM users WHERE id = ?'); }
export function remove(): void { client.query('DELETE FROM users WHERE id = ?'); }
`);
  const edges = byLabel(output);
  assert.deepEqual(edges['read -> public.users']?.props, {
    ...BASE,
    table: 'users',
    operation: 'select',
  });
  assert.deepEqual(edges['remove -> public.users']?.props, {
    ...BASE,
    table: 'users',
    operation: 'delete',
  });
});

test('`interpolated` is true only when every statement behind the edge is an interpolated template', () => {
  const output = one(`
export function onlyTemplates(x: string): void {
  sql\`UPDATE users SET name = \${x} WHERE id = 1\`;
  sql\`SELECT name FROM users WHERE id = \${x}\`;
}
export function withPlainSelect(x: string): void {
  client.query('SELECT name FROM users WHERE id = ?');
  sql\`UPDATE users SET name = \${x} WHERE id = 1\`;
}
export function withBareTemplate(x: string): void {
  client.query(\`SELECT name FROM users WHERE id = 1\`);
  sql\`UPDATE users SET name = \${x} WHERE id = 1\`;
}
export function withInterpolatedOnAnotherTable(x: string): void {
  client.query('SELECT name FROM users WHERE id = ?');
  sql\`UPDATE accounts SET name = \${x} WHERE id = 1\`;
}
`);
  const edges = byLabel(output);
  assert.equal(edges['onlyTemplates -> public.users']?.props['interpolated'], true);
  assert.equal(edges['withPlainSelect -> public.users']?.props['interpolated'], undefined);
  assert.equal(edges['withBareTemplate -> public.users']?.props['interpolated'], undefined);
  assert.equal(
    edges['withInterpolatedOnAnotherTable -> public.users']?.props['interpolated'],
    undefined,
  );
  assert.equal(
    edges['withInterpolatedOnAnotherTable -> public.accounts']?.props['interpolated'],
    true,
  );
  // The mixed pair is still one edge with both classes.
  assert.equal(edges['withPlainSelect -> public.users']?.props['operations'], 'select,update');
});

test('the edge location is the smallest (path, line) among its statements, not the first visited', () => {
  const output = run({
    'src/b.ts': `${PRELUDE}export function POST(): void {\n  client.query('SELECT 1 FROM users');\n}\n`,
    'src/a.ts': `${PRELUDE}\n\n\n\nexport function POST(): void {\n  client.query('DELETE FROM users');\n}\n`,
  });
  const edge = edgeOf(output);
  assert.equal(edge.srcFile, 'src/a.ts');
  assert.equal(edge.sourceRef, 'src/a.ts:10');
  assert.equal(
    edge.props['operations'],
    'delete,select',
    'both files fold into the one symbol-table pair',
  );

  const sameFile = edgeOf(
    one(`
export function f(): void {
  client.query('SELECT 1 FROM users');
  client.query('DELETE FROM users');
}
`),
  );
  assert.equal(sameFile.sourceRef, 'src/queries.ts:7');
});

test('the confidence of an edge is the weakest of its statements', () => {
  // Every raw statement is a name-only binding at 0.7, so the minimum is 0.7 whatever the mix.
  const edge = edgeOf(
    one(`
export function f(x: string): void {
  client.query('SELECT 1 FROM users');
  sql\`UPDATE users SET a = \${x}\`;
}
`),
  );
  assert.equal(edge.confidence, 0.7);
});

/* ------------------------------------------------------------- determinism */

const FOLD_STATEMENTS = [
  `client.query('INSERT INTO users (id, email) VALUES (?, ?)');`,
  `client.query('UPDATE users SET name = ? WHERE id = ?');`,
  `client.query('INSERT INTO users (id, phone) VALUES (?, ?)');`,
  `client.query('INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET email = excluded.email');`,
  'sql`INSERT INTO users (id, nick) VALUES (${x}, 1)`;',
  `client.query('INSERT INTO users VALUES (?, ?)');`,
];

function foldFunction(statements: readonly string[]): string {
  return `export function save(x: string): void {\n${statements.map((s) => `  ${s}`).join('\n')}\n}\n`;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

test('the SIF is byte-identical across the order of statements within a function', () => {
  // The edge location is the smallest line among its statements, and the statements are contiguous,
  // so reordering them moves no line the output records.
  const reference = toCanonicalSif(one(foldFunction(FOLD_STATEMENTS)));
  const edge = edgeOf(one(foldFunction(FOLD_STATEMENTS)));
  assert.equal(edge.props['operations'], 'insert,update,upsert');
  assert.equal(edge.props['insertComplete'], false);
  assert.equal(edge.props['insertColumns'], 'email,id,nick,phone');
  assert.equal(edge.props['interpolated'], undefined);

  const orders = [
    [...FOLD_STATEMENTS].reverse(),
    [3, 0, 5, 2, 4, 1].map((i) => FOLD_STATEMENTS[i] as string),
    [2, 4, 1, 5, 0, 3].map((i) => FOLD_STATEMENTS[i] as string),
  ];
  for (const order of orders) {
    assert.equal(toCanonicalSif(one(foldFunction(order))), reference, order.join(' | '));
  }
  // And every permutation of a smaller set: an insert, an update, an upsert and an interpolated insert.
  const small = [0, 1, 3, 4].map((i) => FOLD_STATEMENTS[i] as string);
  const expected = toCanonicalSif(one(foldFunction(small)));
  for (const order of permutations(small)) {
    assert.equal(toCanonicalSif(one(foldFunction(order))), expected, order.join(' | '));
  }
});

test('the SIF is byte-identical across two runs and across which file holds which statements', () => {
  const body = (columns: string): string =>
    `${PRELUDE}export function POST(): void {\n  client.query('INSERT INTO items (${columns}) VALUES (?)');\n}\n`;
  const files = { 'src/a/route.ts': body('a'), 'src/b/route.ts': body('b') };
  const swapped = { 'src/a/route.ts': body('b'), 'src/b/route.ts': body('a') };
  const first = run(files);
  assert.equal(toCanonicalSif(first), toCanonicalSif(run(files)), 'two runs');
  // Two files export a handler of the same name, so they are one symbol: its edge folds both.
  assert.equal(edgeOf(first).props['insertColumns'], 'a,b');
  assert.equal(edgeOf(first).props['insertComplete'], true);
  assert.equal(toCanonicalSif(first), toCanonicalSif(run(swapped)), 'swapping the files');
});

/* --------------------------------------- statements the old gate did not see */

test('a statement preceded by a comment line is read', () => {
  const output = one(`
export function a(): void { client.query('-- load\\nSELECT id FROM users WHERE id = ?'); }
export function b(): void { client.query('/* note */ INSERT INTO t (x) VALUES (?)'); }
export function c(x: string): void { sql\`-- audit
UPDATE accounts SET seen = \${x} WHERE id = 1\`; }
`);
  const edges = byLabel(output);
  assert.equal(edges['a -> public.users']?.props['operation'], 'select');
  assert.equal(edges['b -> public.t']?.props['insertColumns'], 'x');
  assert.equal(edges['c -> public.accounts']?.props['updateColumns'], 'seen');
});

test('forms the old gate did not know give edges, and CALL and EXEC give none', () => {
  const output = one(`
export function copyIn(): void { client.query("COPY t (a, b) FROM STDIN"); }
export function wipe(): void { client.query("TRUNCATE TABLE t"); }
export function swap(): void { client.query("REPLACE INTO t (a) VALUES (?)"); }
export function merge(): void { client.query("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a"); }
export function ignore(): void { client.query("INSERT IGNORE INTO t (a) VALUES (?)"); }
export function orReplace(): void { client.query("INSERT OR REPLACE INTO t (a) VALUES (?)"); }
export function proc(): void { client.query("CALL refresh_stats(1)"); client.query("EXEC sp_who2 @id = 1"); }
`);
  const edges = byLabel(output);
  assert.equal(edges['copyIn -> public.t']?.props['operation'], 'insert');
  assert.equal(edges['wipe -> public.t']?.props['operation'], 'delete');
  assert.equal(edges['swap -> public.t']?.props['operations'], 'delete,insert');
  assert.equal(edges['merge -> public.t']?.props['operation'], 'upsert');
  assert.equal(edges['ignore -> public.t']?.props['operation'], 'insert');
  assert.equal(edges['orReplace -> public.t']?.props['operation'], 'insert');
  assert.deepEqual(
    Object.keys(edges).filter((k) => k.startsWith('proc ')),
    [],
  );
});

test('labels and sentences that begin with a verb give no edge', () => {
  const output = one(`
export function labels(n: number, phone: string): string[] {
  return [
    "Update assumption", "Call us", "Call now", "Call back", "Call or email us", "Copy reference",
    "DELETE", "update", \`Call \${phone}\`, \`Update \${n} items\`, "Select a file", "Replace the cache",
    "truncate text-sm font-semibold", "flex-1 truncate px-2 text-xs", "Copy link to clipboard",
    "Copy files from desktop", "Merge into main", "Insert into your project",
    "Update application fields, move stages and edit contacts",
    "truncate block", "truncate text", "Truncate message", \`truncate \${n}\`,
    "Replace into inventory", "Merge into main using git",
  ];
}
`);
  assert.deepEqual(queryEdges(output).map(label), []);
});

test('"Delete from cart" has the structure of a statement and gives a delete edge to a table named cart', () => {
  const output = one(`export function label(): string { return "Delete from cart"; }`);
  const edge = edgeOf(output);
  assert.equal(label(edge), 'label -> public.cart');
  assert.equal(edge.props['operation'], 'delete');
});

/* ----------------------------------------------------- truncated statements */

test('a statement built by concatenation never has a complete column set', () => {
  const output = one(`
declare const extra: string;
export function plus(): void { client.query("INSERT INTO t (a, b) VALUES (?, ?)" + extra); }
export function parenthesised(): void { client.query(("INSERT INTO u (a, b) VALUES (?, ?)") + extra); }
export function leftOperand(): void { client.query(extra + "INSERT INTO v (a, b) VALUES (?, ?)"); }
export function update(): void { client.query("UPDATE w SET a = 1 WHERE id = " + extra); }
export function inSpan(): void { client.query(\`\${"INSERT INTO x (a) VALUES (1)" + extra}\`); }
`);
  const edges = byLabel(output);
  for (const table of ['t', 'u', 'v', 'x']) {
    const edge = Object.values(edges).find((e) => e.dst === `fixture:Table:public.${table}`);
    assert.equal(edge?.props['insertComplete'], false, `insert into ${table}`);
    assert.equal(edge?.props['insertColumns'], undefined, `insert into ${table}`);
  }
  assert.equal(edges['update -> public.w']?.props['updateComplete'], false);
});

test('a string-builder statement is incomplete, never "a"', () => {
  const output = one(`
export function build(rest: string): void {
  let q = "INSERT INTO t (a";
  q += ", b";
  q += ") VALUES (?, ?)";
  client.query(q);
}
`);
  const edge = edgeOf(output);
  assert.equal(label(edge), 'build -> public.t');
  assert.equal(edge.props['insertComplete'], false);
  assert.equal(edge.props['insertColumns'], undefined);
});

test('a statement cut off inside a list, a quote or a comment gives no column list', () => {
  const output = one(`
export function a(): void { client.query("INSERT INTO t (a, b"); }
export function b(): void { client.query("INSERT INTO u (a, f(x)"); }
export function c(): void { client.query("INSERT INTO v (a, 'b"); }
export function d(): void { client.query("INSERT INTO w (a, b) "); }
`);
  for (const [fn, table] of [
    ['a', 't'],
    ['b', 'u'],
    ['c', 'v'],
    ['d', 'w'],
  ] as const) {
    const edge = byLabel(output)[`${fn} -> public.${table}`];
    assert.equal(edge?.props['insertComplete'], false, fn);
    assert.equal(edge?.props['insertColumns'], undefined, fn);
  }
});

test('module-scope code is not attributed to the first declaration of its file', () => {
  // A source file starts at 0, and so does its first statement; by position alone the file was that statement.
  const sqlAtModuleScope = run({
    'src/queries.ts': `export function first(): void {}
declare const client: { query(text: string): void };
client.query("SELECT id FROM users");
`,
  });
  assert.deepEqual(
    queryEdges(sqlAtModuleScope).map(label),
    [],
    'there is no symbol to own the statement',
  );

  const callAtModuleScope = run({
    'src/queries.ts': `export function first(): void {}
export function target(): void {}
target();
`,
  });
  assert.deepEqual(
    callAtModuleScope.edges.filter((e) => e.kind === 'CALLS').map((e) => `${e.src} -> ${e.dst}`),
    [],
    'a call at module scope is not a call made by `first`',
  );

  // Inside a function the statement is still that function's.
  const inFunction = run({
    'src/queries.ts': `export function first(): void {}
declare const client: { query(text: string): void };
export function second(): void { client.query("SELECT id FROM users"); }
`,
  });
  assert.deepEqual(queryEdges(inFunction).map(label), ['second -> public.users']);
});

test('a statement outside any function gives no edge', () => {
  // The file starts with a statement that declares nothing, so the module itself is not mistaken for a symbol.
  const output = run({
    'src/queries.ts': `void 0;\ndeclare const client: { query(text: string): void };\nclient.query("INSERT INTO t (a) VALUES (1)");\n`,
  });
  assert.deepEqual(queryEdges(output).map(label), []);
});

/* ------------------------------------------------------- binding still works */

const INDEX = canonicalJson({
  version: 1,
  dataSources: [{ name: 'default', dialect: 'postgres', defaultSchema: 'public' }],
  tables: [
    {
      id: 'fixture:Table:public.Invitation',
      dataSource: 'default',
      schema: 'public',
      name: 'Invitation',
    },
    { id: 'fixture:Table:auth.users', dataSource: 'default', schema: 'auth', name: 'users' },
    { id: 'fixture:Table:app.users', dataSource: 'default', schema: 'app', name: 'users' },
  ],
  prismaDelegates: {},
  drizzleExports: {},
});

test('an interpolated statement binds to the declared table it means, and an ambiguous name is listed, not edged', () => {
  const output = one(
    `
export function invite(x: string): void { sql\`INSERT INTO "Invitation" (email) VALUES (\${x})\`; }
export function ambiguous(x: string): void { sql\`INSERT INTO users (email) VALUES (\${x})\`; }
`,
    INDEX,
  );
  const edges = byLabel(output);
  assert.deepEqual(Object.keys(edges), ['invite -> public.Invitation']);
  assert.equal(edges['invite -> public.Invitation']?.props['interpolated'], true);
  assert.equal(repoProps(output)['unknownWriterTables'], 'users');
});

test('without a data-model index, a statement that makes an edge makes the run UNAVAILABLE, and the edge is still emitted', () => {
  const source = `${PRELUDE}
export async function load(x: string): Promise<void> {
  await sql\`INSERT INTO t (a, b) VALUES (\${x}, 'k')\`;
}
`;
  const output = run({ 'src/queries.ts': source }, null);
  assert.equal(
    output.result.status,
    'UNAVAILABLE',
    'its table cannot be bound, so a PASS would sweep a bound edge',
  );
  assert.ok(
    (output.result.diagnostics[0] ?? '').includes('src/queries.ts:7'),
    output.result.diagnostics[0] ?? '',
  );
  assert.equal(edgeOf(output).props['insertColumns'], 'a,b');
  assert.equal(repoProps(output)['ormIndexAbsent'], true);

  // A statement that names no table makes no edge, and has nothing to sweep.
  const noEdge = run(
    {
      'src/queries.ts': `${PRELUDE}
export async function load(t: string): Promise<void> {
  await sql\`INSERT INTO \${t} (a) VALUES (1)\`;
}
`,
    },
    null,
  );
  assert.equal(noEdge.result.status, 'PASS');
  assert.deepEqual(queryEdges(noEdge).map(label), []);
});

test('an interpolated statement on a name only another schema declares keeps its edge and lists the real table', () => {
  const index = canonicalJson({
    version: 1,
    dataSources: [{ name: 'default', dialect: 'postgres', defaultSchema: 'public' }],
    tables: [
      { id: 'fixture:Table:app.accounts', dataSource: 'default', schema: 'app', name: 'accounts' },
    ],
    prismaDelegates: {},
    drizzleExports: {},
  });
  const output = one(
    `export async function save(x: string): Promise<void> { await sql\`INSERT INTO accounts (email) VALUES (\${x})\`; }`,
    index,
  );
  assert.deepEqual(queryEdges(output).map(label), ['save -> public.accounts']);
  assert.equal(repoProps(output)['unknownWriterTables'], 'accounts');
});

test('a CTE alias, a function and a row lock in a statement give no edge to a table of that name', () => {
  // `sessions` is a name the statement defines, `generate_series` a function, `skip` the word after FOR UPDATE.
  // None is a table, and a CTE named like a real table must not read as a `select` of that table.
  const output = one(`
export async function load(id: string): Promise<void> {
  await sql\`WITH sessions AS (SELECT id FROM users WHERE id = \${id}) SELECT s.id, EXTRACT(EPOCH FROM now()) FROM sessions s, generate_series(1, 3) g FOR UPDATE SKIP LOCKED\`;
}
`);
  assert.deepEqual(queryEdges(output).map(label), ['load -> public.users']);
});
