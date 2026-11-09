/**
 * The unknown-writer facts, from the real index producer to the real reader.
 *
 * `extract-data` publishes the data-model index, `extract-code-ts` reads it and records on
 * the `Repo` node which tables something may write that no edge records
 * (`docs/design/real-world-inputs.md`, 5.2). The delegate of a Prisma model with `@@map` is
 * not its table name, so this is the seam where "an unread JS file with
 * `prisma.<camelModel>.create` over a `@@map`ped table" is withheld or is not.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractCodeTs } from '@seamline/extract-code-ts';
import type { ExtractCodeTsOutput } from '@seamline/extract-code-ts';
import { buildDataModelIndex, extractData } from '@seamline/extract-data';

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

model B2bLead {
  id           String @id
  businessName String @map("business_name")

  @@map("b2b_leads")
}

model Invitation {
  id    String @id
  email String
}
`;

const BASE: Readonly<Record<string, string>> = {
  'prisma/schema.prisma': PRISMA_SCHEMA,
  'src/app.ts': 'export const answer = 42;\n',
  'tsconfig.json': TSCONFIG,
  'package.json': JSON.stringify({ name: '@shop/app', version: '1.0.0', type: 'module' }),
};

const roots: string[] = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function code(files: Readonly<Record<string, string>>): Promise<ExtractCodeTsOutput> {
  const root = await mkdtemp(join(tmpdir(), 'seamline-unknown-writers-'));
  roots.push(root);
  for (const [rel, text] of Object.entries({ ...BASE, ...files })) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text, 'utf8');
  }
  const data = await extractData({ root, repo: REPO, runId: 'run-1', deterministic: true });
  assert.equal(data.result.status, 'PASS', data.result.diagnostics.join('; '));
  const out = extractCodeTs({
    repoRoot: root,
    repo: REPO,
    runId: 'run-1',
    deterministic: true,
    dataModelIndex: buildDataModelIndex(data.nodes),
  });
  assert.equal(out.result.status, 'PASS', out.result.diagnostics.join('; '));
  return out;
}

function repoProps(out: ExtractCodeTsOutput): Readonly<Record<string, unknown>> {
  const repo = out.nodes.find((n) => n.kind === 'Repo');
  assert.ok(repo !== undefined);
  return repo.props;
}

test('an unread JS file that writes prisma.<camelModel>.create over a @@map table withholds the table', async () => {
  const out = await code({
    'scripts/import-leads.js': "await prisma.b2bLead.create({ data: { businessName: 'x' } });\n",
  });
  // The delegate is `b2bLead`, the model `B2bLead`, the table `b2b_leads`: the file never names the table.
  assert.equal(repoProps(out)['unknownWriterTables'], 'b2b_leads');
  assert.equal(repoProps(out)['untracedWriteCalls'], 0);
});

test('the same file without a write marker, or a read, withholds nothing', async () => {
  const out = await code({
    'scripts/report.js': 'const rows = await prisma.b2bLead.findMany();\n',
  });
  assert.equal(repoProps(out)['unknownWriterTables'], '');
});

test('the same write in a file the project reads is withheld too, with no receiver evidence', async () => {
  const out = await code({
    'src/leads.ts':
      'declare const store: any;\nexport function add(): unknown { return store.b2bLead.create({ data: {} }); }\n',
  });
  assert.equal(repoProps(out)['unknownWriterTables'], 'b2b_leads');
});

/* ------------------------------------------------------------ the skip list */

/** The names in the `DEFAULT_SKIP_DIRS` array of `extract-data`, read from its source. */
function skipListIn(source: string, name: string): string[] {
  const match = new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
  assert.ok(match !== null, `${name} not found`);
  return [...(match[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string).sort();
}

test('the unread-file scan skips exactly the directories extract-data skips', () => {
  const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const data = readFileSync(join(packages, 'extract-data', 'src', 'discover.ts'), 'utf8');
  const codeTs = readFileSync(join(packages, 'extract-code-ts', 'src', 'unread-files.ts'), 'utf8');
  const expected = skipListIn(data, 'DEFAULT_SKIP_DIRS');
  assert.ok(expected.includes('node_modules') && expected.includes('dist'), 'the list was read');
  assert.deepEqual(skipListIn(codeTs, 'UNREAD_SKIP_DIRS'), expected);
});
