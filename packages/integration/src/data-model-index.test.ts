/**
 * The data-model index, from the real producer to the real reader.
 *
 * `extract-data` writes the index and `extract-code-ts` reads it; neither
 * depends on the other (`docs/design/real-world-inputs.md`, 3.3), so the format
 * is the only thing they share and this suite is where the two halves meet. A
 * raw-SQL `QUERIES` edge has to land on the id of a `Table` node `extract-data`
 * emitted, and the same index bytes have to give the same SIF bytes.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { extractCodeTs, parseDataModelIndex, toCanonicalSif } from '@seamline/extract-code-ts';
import type { ExtractCodeTsOutput } from '@seamline/extract-code-ts';
import { buildDataModelIndex, extractData } from '@seamline/extract-data';
import type { ExtractDataOutput } from '@seamline/extract-data';

const REPO = 'shop';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['src'],
});

const PRISMA_SCHEMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Invitation {
  id    String @id
  email String
}

model B2bLead {
  id           String @id
  businessName String @map("business_name")

  @@map("b2b_leads")
}
`;

const SQL_SCHEMA = `CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.users (id uuid PRIMARY KEY, email text NOT NULL);
`;

const QUERIES_TS = `export function findInvitation(): string {
  return 'SELECT id FROM "Invitation" WHERE id = $1';
}
export function unquotedInvitation(): string {
  return 'SELECT id FROM Invitation WHERE id = $1';
}
export function addLead(): string {
  return 'INSERT INTO b2b_leads (business_name) VALUES ($1)';
}
export function findUser(): string {
  return 'SELECT id FROM users WHERE id = $1';
}
export function findAuthUser(): string {
  return 'SELECT id FROM auth.users WHERE id = $1';
}
export function findWidget(): string {
  return 'SELECT id FROM widgets WHERE id = $1';
}
`;

const SHOP: Readonly<Record<string, string>> = {
  'prisma/schema.prisma': PRISMA_SCHEMA,
  'db/schema.sql': SQL_SCHEMA,
  'src/queries.ts': QUERIES_TS,
  'tsconfig.json': TSCONFIG,
  'package.json': JSON.stringify({ name: '@shop/app', version: '1.0.0', type: 'module' }),
};

const roots: string[] = [];

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'seamline-model-index-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text, 'utf8');
  }
  return root;
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

interface Extracted {
  readonly data: ExtractDataOutput;
  readonly index: string;
  readonly code: ExtractCodeTsOutput;
}

async function extractBoth(
  files: Readonly<Record<string, string>>,
  withIndex = true,
  dataOptions: { readonly defaultSchema?: string } = {},
): Promise<Extracted> {
  const repoRoot = await tree(files);
  const data = await extractData({
    root: repoRoot,
    repo: REPO,
    runId: 'run-1',
    deterministic: true,
    ...dataOptions,
  });
  assert.equal(data.result.status, 'PASS', data.result.diagnostics.join('; '));
  const index = buildDataModelIndex(data.nodes);
  const code = extractCodeTs({
    repoRoot,
    repo: REPO,
    runId: 'run-1',
    deterministic: true,
    ...(withIndex ? { dataModelIndex: index } : {}),
  });
  return { data, index, code };
}

function destinations(code: ExtractCodeTsOutput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of code.edges.filter((x) => x.kind === 'QUERIES')) {
    out[String(e.src).replace(`${REPO}:Symbol:@shop/app#`, '')] = String(e.dst);
  }
  return out;
}

test('the reader accepts what the writer produced, for the repository it was produced for', async () => {
  const { index } = await extractBoth(SHOP);
  const parsed = parseDataModelIndex(index, REPO);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem);
  assert.deepEqual(
    parsed.index.tables.map((t) => `${t.schema}.${t.name}`),
    ['auth.users', 'public.Invitation', 'public.b2b_leads', 'public.users'],
  );
  assert.deepEqual(Object.keys(parsed.index.prismaDelegates), ['b2bLead', 'invitation']);
  assert.equal(parseDataModelIndex(index, 'another-repo').ok, false);
});

test('raw SQL lands on the ids of the Table nodes extract-data emitted', async () => {
  const { data, code } = await extractBoth(SHOP);
  assert.equal(code.result.status, 'PASS');
  const tableIds = new Set(data.nodes.filter((n) => n.kind === 'Table').map((n) => String(n.id)));

  assert.deepEqual(destinations(code), {
    findInvitation: 'shop:Table:public.Invitation',
    // Unquoted `Invitation` is `invitation` to Postgres: not the Prisma table, and it is not claimed to be.
    unquotedInvitation: 'shop:Table:public.invitation',
    addLead: 'shop:Table:public.b2b_leads',
    findUser: 'shop:Table:public.users',
    findAuthUser: 'shop:Table:auth.users',
    findWidget: 'shop:Table:public.widgets',
  });
  const real = Object.entries(destinations(code))
    .filter(([, dst]) => tableIds.has(dst))
    .map(([fn]) => fn);
  assert.deepEqual(real.sort(), ['addLead', 'findAuthUser', 'findInvitation', 'findUser']);
});

test('before the index, the same quoted mixed-case statement pointed at a table that does not exist', async () => {
  const { data, code } = await extractBoth(SHOP, false);
  const dst = destinations(code)['findInvitation'] as string;
  assert.equal(dst, 'shop:Table:public.invitation');
  assert.ok(
    !data.nodes.some((n) => n.id === dst),
    'the name-only answer is not a Table extract-data emitted',
  );
});

test('the same tree gives the same index bytes and the same SIF bytes, in a different directory', async () => {
  const first = await extractBoth(SHOP);
  const second = await extractBoth(SHOP);
  assert.equal(first.index, second.index);
  assert.equal(toCanonicalSif(first.code), toCanonicalSif(second.code));
});

test('auth.users and app.users with no public.users: an unqualified name is withheld, not guessed', async () => {
  const { code } = await extractBoth({
    'db/schema.sql':
      'CREATE SCHEMA auth;\nCREATE SCHEMA app;\nCREATE TABLE auth.users (id uuid);\nCREATE TABLE app.users (id uuid);\n',
    'src/queries.ts': `export function addUser(): string {
  return 'INSERT INTO users (id) VALUES ($1)';
}
export function addAppUser(): string {
  return 'INSERT INTO app.users (id) VALUES ($1)';
}
`,
    'tsconfig.json': TSCONFIG,
    'package.json': JSON.stringify({ name: '@shop/app', version: '1.0.0', type: 'module' }),
  });
  assert.deepEqual(destinations(code), { addAppUser: 'shop:Table:app.users' });
  const repo = code.nodes.find((n) => n.kind === 'Repo');
  assert.equal(repo?.props['unknownWriterTables'], 'users');
});

const ONE_SCHEMA: Readonly<Record<string, string>> = {
  'db/schema.sql':
    'CREATE SCHEMA only_other;\nCREATE TABLE only_other.widgets (id int PRIMARY KEY, name text NOT NULL);\n',
  'src/queries.ts': `export function addWidget(): string {
  return 'INSERT INTO widgets (id, name) VALUES ($1, $2)';
}
export function addQualified(): string {
  return 'INSERT INTO only_other.widgets (id, name) VALUES ($1, $2)';
}
`,
  'tsconfig.json': TSCONFIG,
  'package.json': JSON.stringify({ name: '@shop/app', version: '1.0.0', type: 'module' }),
};

test('a table only a non-default schema declares: the unqualified statement keeps the name-only edge and the table is listed', async () => {
  const { data, code } = await extractBoth(ONE_SCHEMA);
  assert.equal(code.result.status, 'PASS');
  assert.deepEqual(destinations(code), {
    // The name-only answer, as before the index: a node extract-data did not emit.
    addWidget: 'shop:Table:public.widgets',
    addQualified: 'shop:Table:only_other.widgets',
  });
  assert.ok(data.nodes.some((n) => n.id === 'shop:Table:only_other.widgets'));
  assert.ok(!data.nodes.some((n) => n.id === 'shop:Table:public.widgets'));
  // So that a detector over the real table withholds instead of trusting "no traced write".
  assert.equal(code.nodes.find((n) => n.kind === 'Repo')?.props['unknownWriterTables'], 'widgets');
});

test('the extract-data defaultSchema option names the schema the tables live in, and then they bind', async () => {
  const { code } = await extractBoth(ONE_SCHEMA, true, { defaultSchema: 'only_other' });
  assert.equal(code.result.status, 'PASS');
  assert.deepEqual(destinations(code), {
    addWidget: 'shop:Table:only_other.widgets',
    addQualified: 'shop:Table:only_other.widgets',
  });
  assert.equal(code.nodes.find((n) => n.kind === 'Repo')?.props['unknownWriterTables'], '');
});
