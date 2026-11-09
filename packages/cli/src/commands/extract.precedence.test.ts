/**
 * Cross-extractor node precedence, end to end through `seamline extract`.
 *
 * Two extractors can emit the same node id in one run: `extract-change` emits
 * `File` nodes as the endpoints of its `TOUCHES`/`RENAMED_FROM` edges, and
 * `extract-contracts` emits `RouteHandler` nodes as the endpoints of its
 * `IMPLEMENTED_BY` edges, both keyed exactly like `extract-code-ts`'s own
 * nodes so the joins converge. The store keeps one row per id, so which body
 * lands there has to be decided by the precedence order (v3 §2.4), not by
 * whichever extractor the config happened to list last.
 *
 * These tests run the real extractors over a small synthetic git repository
 * and compare the stored node against the one a `extract-code-ts`-only run
 * stores for the same id.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { SqliteStore } from '@seamline/core';
import { NODE_KINDS, nodeId, type NodeId, type SeamlineNode } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig, type SeamlineConfig } from '../config.ts';
import { bufferIo, EXIT_OK } from '../io.ts';
import type { CliDeps, ExtractorOutput, ExtractorPort } from '../ports.ts';
import { runCli } from '../run.ts';
import { fileSnapshots, parseSif } from '../sif.ts';
import {
  changeExtractorPort,
  codeTsExtractorPort,
  contractsExtractorPort,
  dataExtractorPort,
  sqliteStorePort,
} from '../wiring.ts';

const REPO = 'demo';
const RUN = 'run-precedence';

const FILE_A = nodeId(REPO, 'File', 'src/a.ts');
const ROUTE = nodeId(REPO, 'RouteHandler', 'GET /users/:id');

const FIXTURE: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify({ name: '@fixture/precedence', version: '1.0.0', type: 'module' }, null, 2)}\n`,
  'tsconfig.json': `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['src'],
    },
    null,
    2,
  )}\n`,
  'src/a.ts': 'export interface Account {\n  id: string;\n  email: string;\n}\n',
  'src/routes.ts': [
    'interface Router {',
    '  get(path: string, handler: (id: string) => unknown): void;',
    '}',
    '',
    'declare const app: Router;',
    '',
    'export function getUser(id: string): unknown {',
    '  return { id };',
    '}',
    '',
    "app.get('/users/:id', getUser);",
    '',
  ].join('\n'),
  'openapi.yaml': [
    'openapi: 3.0.3',
    'info:',
    '  title: Precedence Fixture API',
    '  version: 1.0.0',
    'paths:',
    '  /users/{id}:',
    '    get:',
    '      operationId: getUser',
    '      x-openapi-router-controller: UserController',
    '      responses:',
    "        '200':",
    '          description: ok',
    '',
  ].join('\n'),
  'db/schema.sql': 'CREATE TABLE accounts (\n  id text PRIMARY KEY,\n  email text NOT NULL\n);\n',
};

const fixtureDirs: string[] = [];
let repoRoot: string;

function fixtureDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `seamline-${prefix}-`));
  fixtureDirs.push(dir);
  return dir;
}

function gitInFixture(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: cwd,
      TZ: 'UTC',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'author@example.invalid',
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'Fixture Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.invalid',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  });
}

function writeFixture(rel: string, body: string): void {
  const abs = path.join(repoRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

before(() => {
  repoRoot = fixtureDir('precedence-repo');
  gitInFixture(repoRoot, ['init', '-q', '-b', 'main']);
  for (const [rel, body] of Object.entries(FIXTURE)) writeFixture(rel, body);
  gitInFixture(repoRoot, ['add', '.']);
  gitInFixture(repoRoot, ['commit', '-q', '-m', 'initial']);
  // A second commit, so `extract-change` has a non-root change touching both
  // TypeScript files and emits them as `File` endpoints.
  writeFixture('src/a.ts', `${FIXTURE['src/a.ts'] ?? ''}export const ACCOUNT_KIND = 'account';\n`);
  writeFixture(
    'src/routes.ts',
    `${FIXTURE['src/routes.ts'] ?? ''}// served by the fixture router\n`,
  );
  gitInFixture(repoRoot, ['add', '.']);
  gitInFixture(repoRoot, ['commit', '-q', '-m', 'touch sources']);
  // Written after the commits so the config file is not part of the history.
  const config: SeamlineConfig = defaultConfig(REPO);
  writeFileSync(path.join(repoRoot, CONFIG_FILENAME), serializeConfig(config), 'utf8');
});

after(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

const REAL_EXTRACTORS: readonly ExtractorPort[] = [
  codeTsExtractorPort(),
  dataExtractorPort(),
  contractsExtractorPort(),
  changeExtractorPort(),
];

interface Extraction {
  readonly stored: (id: NodeId) => SeamlineNode | undefined;
  readonly all: ReadonlyArray<SeamlineNode>;
  readonly snapshotNodes: ReadonlyArray<SeamlineNode>;
}

async function extract(
  extractors: readonly ExtractorPort[],
  argv: readonly string[],
): Promise<Extraction> {
  const outDir = fixtureDir('precedence-out');
  const io = bufferIo({ cwd: repoRoot, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const deps: CliDeps = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => RUN },
    store: sqliteStorePort(),
    extractors,
    snapshots: fileSnapshots(),
  };
  const code = await runCli(deps, ['extract', '--out', outDir, ...argv]);
  assert.equal(code, EXIT_OK, io.stderr());

  const store = new SqliteStore({ path: path.join(outDir, 'graph.db') });
  try {
    const all = NODE_KINDS.flatMap((kind) => [...store.nodesByKind(kind)]).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const byId = new Map(all.map((n) => [n.id, n]));
    const snapshot = parseSif(
      readFileSync(path.join(outDir, 'runs', `${RUN}.sif`), 'utf8'),
      'snapshot',
    );
    return { stored: (id) => byId.get(id), all, snapshotNodes: snapshot.nodes };
  } finally {
    await store.close();
  }
}

/** The part of a node an extractor asserts; lifecycle is the store's bookkeeping. */
function body(node: SeamlineNode | undefined): unknown {
  assert.ok(node, 'expected the node to be stored');
  const { firstSeenRun: _first, lastSeenRun: _last, deletedAt: _deleted, ...rest } = node;
  return rest;
}

let codeOnlyRun: Promise<Extraction> | undefined;
let fullRun: Promise<Extraction> | undefined;
/** One `extract-code-ts`-only run and one full run, shared by the tests below. */
const codeOnly = (): Promise<Extraction> =>
  (codeOnlyRun ??= extract(REAL_EXTRACTORS, ['--only', 'extract-code-ts']));
const full = (): Promise<Extraction> => (fullRun ??= extract(REAL_EXTRACTORS, []));

test('a full run stores the File body extract-code-ts asserts, not the extract-change endpoint', async () => {
  const expected = (await codeOnly()).stored(FILE_A);
  assert.equal(
    expected?.name,
    'src/a.ts',
    'precondition: extract-code-ts names a File by its repo path',
  );
  assert.equal(
    expected?.props['extension'],
    '.ts',
    'precondition: extract-code-ts records the extension',
  );

  assert.deepEqual(body((await full()).stored(FILE_A)), body(expected));
});

test('a full run stores the RouteHandler body extract-code-ts asserts, not the extract-contracts endpoint', async () => {
  const expected = (await codeOnly()).stored(ROUTE);
  assert.equal(
    expected?.props['style'],
    'router-call',
    'precondition: extract-code-ts records how the route is registered',
  );
  assert.equal(
    expected?.path,
    'src/routes.ts',
    'precondition: extract-code-ts locates the route in code',
  );

  assert.deepEqual(body((await full()).stored(ROUTE)), body(expected));
});

test('the SIF snapshot carries exactly one line per node id, and it is the stored body', async () => {
  const run = await full();

  const ids = run.snapshotNodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'a node id appears on more than one snapshot line');

  const fileLine = run.snapshotNodes.find((n) => n.id === FILE_A);
  assert.deepEqual(body(fileLine), body(run.stored(FILE_A)));
  const routeLine = run.snapshotNodes.find((n) => n.id === ROUTE);
  assert.deepEqual(body(routeLine), body(run.stored(ROUTE)));
});

/** Replays one real extractor output, so the order of a run can be permuted cheaply. */
function replay(port: ExtractorPort, output: ExtractorOutput): ExtractorPort {
  return { ...port, extract: () => Promise.resolve(output) };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

test('the stored graph does not depend on the order the extractors run in', async () => {
  const ctx = {
    repoRoot,
    repo: REPO,
    runId: RUN,
    outDir: fixtureDir('precedence-replay'),
    include: ['**/*'],
    exclude: [],
    options: {},
    deterministic: true,
  };
  const replays: ExtractorPort[] = [];
  for (const port of REAL_EXTRACTORS) {
    const output = await port.extract(ctx);
    assert.equal(output.result.status, 'PASS', `precondition: ${port.name} passes on the fixture`);
    replays.push(replay(port, output));
  }

  let reference: string | undefined;
  for (const order of permutations(replays)) {
    const config: SeamlineConfig = {
      ...defaultConfig(REPO),
      extractors: [
        ...order.map((p) => ({ name: p.name, enabled: true, options: {} })),
        { name: 'infer-join', enabled: true, options: {} },
      ],
    };
    writeFileSync(path.join(repoRoot, CONFIG_FILENAME), serializeConfig(config), 'utf8');
    try {
      const run = await extract(order, []);
      const graph = JSON.stringify(run.all.map(body));
      if (reference === undefined) reference = graph;
      assert.equal(
        graph,
        reference,
        `order ${order.map((p) => p.name).join(', ')} stored a different graph`,
      );
    } finally {
      writeFileSync(
        path.join(repoRoot, CONFIG_FILENAME),
        serializeConfig(defaultConfig(REPO)),
        'utf8',
      );
    }
  }
});
