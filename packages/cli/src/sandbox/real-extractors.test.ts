/**
 * The bundled extractors against a repository shaped like a real monorepo,
 * under enforcement of their own manifests.
 *
 * A capability manifest that under-declares what its extractor opens is not
 * harmless once the host enforces it: the run fails. These tests run the real
 * programs, through the real sandbox, over a fixture that has what real
 * repositories have and small fixtures do not: nested `package.json` and
 * `tsconfig.json` files, a `tsconfig` that `extends` a file at the root,
 * project references, a workspace symlink in `node_modules`, a dependency that
 * ships `.d.ts`, upper-case extensions on SQL and YAML, and a `$ref` into
 * another document.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ExtractorManifest } from '@seamline/ontology';
import { matchesReads } from '@seamline/core';
import { CHANGE_MANIFEST } from '@seamline/extract-change';
import { manifest as CODE_TS_MANIFEST } from '@seamline/extract-code-ts';
import { MANIFEST as CONTRACTS_MANIFEST } from '@seamline/extract-contracts';
import { MANIFEST as DATA_MANIFEST } from '@seamline/extract-data';
import * as codeTs from '../extractors/code-ts.ts';
import * as contracts from '../extractors/contracts.ts';
import * as data from '../extractors/data.ts';
import type { ExtractContext, ExtractorOutput } from '../ports.ts';
import { FIRST_PARTY_PROGRAMS, firstPartyHost } from './first-party.ts';

const root = mkdtempSync(join(tmpdir(), 'seamline-monorepo-'));
const repo = join(root, 'repo');
let symlinks = true;

function write(rel: string, text: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

before(() => {
  write(
    'package.json',
    JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
  );
  write(
    'tsconfig.base.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        composite: true,
      },
    }),
  );
  write(
    'tsconfig.json',
    JSON.stringify({ files: [], references: [{ path: 'packages/a' }, { path: 'packages/b' }] }),
  );
  for (const name of ['a', 'b']) {
    write(
      `packages/${name}/package.json`,
      JSON.stringify({ name: `@mono/${name}`, type: 'module', version: '1.0.0' }),
    );
    write(
      `packages/${name}/tsconfig.json`,
      JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { outDir: 'dist', rootDir: 'src' },
        include: ['src'],
      }),
    );
  }
  write(
    'packages/a/src/index.ts',
    "import { greet } from 'dep';\nexport interface User { id: number; email: string | null }\nexport const hello: string = greet('a');\n",
  );
  write(
    'packages/b/src/index.ts',
    "import type { User } from '@mono/a';\nexport function emailOf(u: User): string | null { return u.email; }\n",
  );
  write(
    'node_modules/dep/package.json',
    JSON.stringify({ name: 'dep', version: '1.0.0', types: 'index.d.ts' }),
  );
  write('node_modules/dep/index.d.ts', 'export declare function greet(who: string): string;\n');
  write(
    'db/migrations/0001_init.SQL',
    'CREATE TABLE users (id integer PRIMARY KEY, email text);\n',
  );
  write('api/components/user.json', JSON.stringify({ Email: { type: 'string', format: 'email' } }));
  write(
    'api/OPENAPI.YML',
    [
      'openapi: 3.0.3',
      'info: { title: Mono API, version: 1.0.0 }',
      'paths:',
      '  /users:',
      '    post:',
      '      operationId: createUser',
      '      requestBody:',
      '        content:',
      '          application/json:',
      "            schema: { $ref: '#/components/schemas/User' }",
      '      responses:',
      "        '201': { description: created }",
      'components:',
      '  schemas:',
      '    User:',
      '      type: object',
      '      required: [id]',
      '      properties:',
      '        id: { type: integer }',
      "        email: { $ref: './components/user.json#/Email' }",
      '',
    ].join('\n'),
  );
  try {
    mkdirSync(join(repo, 'node_modules', '@mono'), { recursive: true });
    symlinkSync('../../packages/a', join(repo, 'node_modules', '@mono', 'a'));
  } catch {
    symlinks = false;
  }
});

// In process, `extract-contracts` zeroes its reported duration from the real process.env; a sandboxed
// one is handed the variable its manifest declares. Both must see the same value to be compared.
const savedDeterministic = process.env['SEAMLINE_DETERMINISTIC'];
process.env['SEAMLINE_DETERMINISTIC'] = '1';

after(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedDeterministic === undefined) delete process.env['SEAMLINE_DETERMINISTIC'];
  else process.env['SEAMLINE_DETERMINISTIC'] = savedDeterministic;
});

function ctx(): ExtractContext {
  return {
    repoRoot: repo,
    repo: 'mono',
    runId: 'run-1',
    outDir: join(root, 'out'),
    include: ['**/*'],
    exclude: ['node_modules/**', 'dist/**'],
    options: {},
    deterministic: true,
  };
}

const host = firstPartyHost({ PATH: process.env['PATH'] ?? '', SEAMLINE_DETERMINISTIC: '1' });
const programFor = (name: string) => {
  const found = FIRST_PARTY_PROGRAMS.find((p) => p.manifest.name === name);
  assert.ok(found, name);
  return found;
};
// SIF orders edge records by endpoints; individual producers may order by kind.
// Compare the full edge multiset independently of either production codec while
// retaining every node, edge body, scope, status and extension in the assertion.
const comparable = (output: ExtractorOutput) => ({
  ...output,
  edges: output.edges.map(group => ({ ...group, edges: [...group.edges].sort((a, b) => {
    const left = JSON.stringify([a.kind, a.src, a.dst]);
    const right = JSON.stringify([b.kind, b.src, b.dst]);
    return left < right ? -1 : left > right ? 1 : 0;
  }) })),
});
const same = (a: ExtractorOutput, b: ExtractorOutput) =>
  assert.deepEqual(JSON.parse(JSON.stringify(comparable(a))), JSON.parse(JSON.stringify(comparable(b))));

describe('real extractors under their own manifests, over a monorepo-shaped fixture', () => {
  it('extract-code-ts passes, reads nested package.json and tsconfig files, and finds what it finds in process', async () => {
    const boxed = await host.run(programFor('extract-code-ts'), ctx());
    assert.equal(boxed.result.status, 'PASS', boxed.result.diagnostics.join('\n'));
    const files = boxed.nodes.filter((n) => n.kind === 'File').map((n) => n.path);
    assert.ok(files.includes('packages/a/src/index.ts'), files.join(','));
    assert.ok(files.includes('packages/b/src/index.ts'), files.join(','));
    same(boxed, await codeTs.run(ctx()));
  });

  it('extract-data passes and reads an upper-case .SQL migration', async () => {
    const boxed = await host.run(programFor('extract-data'), ctx());
    assert.equal(boxed.result.status, 'PASS', boxed.result.diagnostics.join('\n'));
    assert.ok(
      boxed.nodes.some((n) => n.kind === 'Table' && n.name === 'users'),
      boxed.nodes.map((n) => `${n.kind}:${n.name}`).join(','),
    );
    same(boxed, await data.run(ctx()));
  });

  it('extract-contracts passes, reads an upper-case .YML spec, and follows its $ref into another document', async () => {
    const boxed = await host.run(programFor('extract-contracts'), ctx());
    assert.equal(boxed.result.status, 'PASS', boxed.result.diagnostics.join('\n'));
    const email = boxed.nodes.find(
      (n) => n.kind === 'SchemaProperty' && (n.id as string).endsWith('/properties/email'),
    );
    assert.ok(email, boxed.nodes.map((n) => n.id).join(','));
    // The type came from the other document, so the $ref was followed, not left unresolved.
    assert.equal(email.props['typeCategory'], 'text');
    same(boxed, await contracts.run(ctx()));
  });

  it('the declaration this change replaced would have failed the same run: undeclared reads still fail', async () => {
    // The old code-ts declaration: tsconfig.json and package.json at the repo root only.
    const narrowed: ExtractorManifest = {
      ...CODE_TS_MANIFEST,
      reads: ['tsconfig.json', 'package.json', '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    };
    const out = await host.run({ ...programFor('extract-code-ts'), manifest: narrowed }, ctx());
    assert.equal(out.result.status, 'FAIL');
    assert.match(
      out.result.diagnostics.join('\n'),
      /\[path-not-declared\] extract-code-ts: packages\/a\/(package|tsconfig)\.json matches no declared reads glob/,
    );
    assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
  });

  it(
    'a workspace symlink inside the repo is read through, not refused',
    { skip: !symlinks },
    async () => {
      // packages/b imports '@mono/a' through node_modules/@mono/a -> ../../packages/a
      const boxed = await host.run(programFor('extract-code-ts'), ctx());
      assert.equal(boxed.result.status, 'PASS', boxed.result.diagnostics.join('\n'));
      const names = boxed.nodes.map((n) => `${n.kind}:${n.name}`);
      assert.ok(
        names.some((n) => n.startsWith('Symbol:') && n.includes('emailOf')),
        names.join(','),
      );
    },
  );
});

describe('manifest reads cover the files each extractor opens, and not the ones it does not', () => {
  const cases: ReadonlyArray<{
    name: string;
    manifest: ExtractorManifest;
    opens: string[];
    never: string[];
  }> = [
    {
      name: 'extract-code-ts',
      manifest: CODE_TS_MANIFEST,
      opens: [
        'tsconfig.json',
        'package.json',
        'packages/a/package.json',
        'packages/a/tsconfig.build.json',
        'configs/base.json',
        'src/a.ts',
        'src/b.tsx',
        'src/c.mts',
        'src/d.cts',
        'src/e.js',
        'src/e.jsx',
        'src/f.mjs',
        'src/g.cjs',
        'node_modules/dep/index.d.ts',
        'node_modules/dep/package.json',
      ],
      never: ['.env', 'README.md', 'db/init.sql', 'secrets/key.pem'],
    },
    {
      name: 'extract-data',
      manifest: DATA_MANIFEST,
      opens: [
        'db/schema.sql',
        'db/0001_INIT.SQL',
        'prisma/schema.prisma',
        'src/schema.ts',
        'src/schema.jsx',
        'src/s.mjs',
        'src/s.cjs',
        'src/s.mts',
        'src/s.cts',
        'src/s.tsx',
        'src/s.js',
        'package.json',
        'packages/a/package.json',
      ],
      never: ['.env', 'package.jsonc', 'api/openapi.yaml', 'README.md'],
    },
    {
      name: 'extract-contracts',
      manifest: CONTRACTS_MANIFEST,
      opens: [
        'api/openapi.yaml',
        'api/OPENAPI.YML',
        'a/b/schema.JSON',
        'package.json',
        'src/zod.ts',
        'src/zod.TSX',
        'src/z.mts',
        'src/z.cts',
        'src/app.js',
        'src/app.jsx',
        'src/app.mjs',
        'src/app.cjs',
        'prisma/schema.prisma',
      ],
      never: ['.env', 'notes.txt', 'db/init.sql', 'secrets/key.pem'],
    },
    {
      name: 'infer-join',
      manifest: programFor('infer-join').manifest,
      opens: [],
      never: ['package.json', 'src/a.ts', '.env'],
    },
    {
      name: 'extract-change',
      manifest: CHANGE_MANIFEST,
      opens: ['.git/HEAD', '.git/objects/ab/cdef'],
      never: ['src/a.ts', '.env'],
    },
  ];
  for (const c of cases) {
    it(`${c.name}`, () => {
      for (const rel of c.opens)
        assert.ok(matchesReads(c.manifest, rel), `${rel} is opened but not declared`);
      for (const rel of c.never)
        assert.ok(!matchesReads(c.manifest, rel), `${rel} is declared but never opened`);
    });
  }
});
