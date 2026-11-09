/**
 * The data-model index at the composition root.
 *
 * `extract-data` publishes it, `extract-code-ts` consumes it, and neither
 * depends on the other: `extract` is the only place they meet. These tests check
 * the hand-off with fake extractors (when the index is passed, and when it must
 * not be) and then with the real ones, end to end through the real store and the
 * SIF snapshot.
 */

import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { ExtractorStatus } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig, type SeamlineConfig } from '../config.ts';
import { bufferIo, EXIT_OK } from '../io.ts';
import type { CliDeps, ExtractContext, ExtractorPort } from '../ports.ts';
import { runCli } from '../run.ts';
import { fileSnapshots, parseSif } from '../sif.ts';
import { makeNode, makeResult, memoryGraph, memoryStorePort } from '../testing.ts';
import {
  buildCliDeps,
  codeTsExtractorPort,
  dataExtractorPort,
  sqliteStorePort,
} from '../wiring.ts';
import type { ExtractReport } from './extract.ts';

const roots: string[] = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function repoWith(
  config: SeamlineConfig,
  files: Readonly<Record<string, string>> = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-model-index-'));
  roots.push(dir);
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(config), 'utf8');
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text, 'utf8');
  }
  return dir;
}

function configOf(...names: string[]): SeamlineConfig {
  return {
    ...defaultConfig('demo'),
    extractors: names.map((name) => ({ name, enabled: true, options: {} })),
  };
}

/**
 * A data extractor that publishes `index` with `status`, recording the context it was given.
 * `noSchemaSource` is the flag a real one sets when discovery found no schema source it reads and
 * knew of none it did not read.
 */
function publisher(
  status: ExtractorStatus,
  index: string,
  seen: ExtractContext[],
  noSchemaSource = false,
): ExtractorPort {
  return {
    name: 'extract-data',
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: (ctx) => {
      seen.push(ctx);
      return Promise.resolve({
        result: makeResult(
          'extract-data',
          status,
          ['data'],
          status === 'PASS' ? [] : ['no schema'],
        ),
        nodes:
          status === 'PASS'
            ? [makeNode({ kind: 'File', canonicalName: 'db/schema.sql', path: 'db/schema.sql' })]
            : [],
        edges: [],
        // A fake that offers an index whatever its status: the command takes it from a PASS, and
        // from an UNAVAILABLE only when the extractor says discovery found no schema source.
        dataModelIndex: index,
        ...(noSchemaSource ? { noSchemaSource: true as const } : {}),
      });
    },
  };
}

function consumer(seen: ExtractContext[]): ExtractorPort {
  return {
    name: 'extract-code-ts',
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: (ctx) => {
      seen.push(ctx);
      return Promise.resolve({
        result: makeResult('extract-code-ts', 'PASS', ['code.ts'], []),
        nodes: [],
        edges: [],
      });
    },
  };
}

function fakeDeps(
  cwd: string,
  extractors: readonly ExtractorPort[],
): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env: {} });
  return {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(memoryGraph()),
    extractors,
  };
}

test('the index extract-data published reaches extract-code-ts, though the config lists code first', async () => {
  const dir = await repoWith(configOf('extract-code-ts', 'extract-data'));
  const dataSeen: ExtractContext[] = [];
  const codeSeen: ExtractContext[] = [];
  const d = fakeDeps(dir, [consumer(codeSeen), publisher('PASS', '{"version":1}', dataSeen)]);

  assert.equal(await runCli(d, ['extract', '--json']), EXIT_OK);

  assert.equal(codeSeen[0]?.dataModelIndex, '{"version":1}', 'the same text, unchanged');
  assert.equal(dataSeen[0]?.dataModelIndex, undefined, 'the publisher is not handed an index');
  const report = JSON.parse(d.io.stdout()) as ExtractReport;
  assert.deepEqual(
    report.results.map((r) => r.extractor),
    ['extract-code-ts', 'extract-data'],
    'reported in the configured order, not the order they ran in',
  );
});

test('extractors are reported in configured order whichever way the config lists data and code', async () => {
  const dir = await repoWith(configOf('extract-data', 'extract-code-ts'));
  const d = fakeDeps(dir, [consumer([]), publisher('PASS', '{"version":1}', [])]);
  await runCli(d, ['extract', '--json']);
  const report = JSON.parse(d.io.stdout()) as ExtractReport;
  assert.deepEqual(
    report.results.map((r) => r.extractor),
    ['extract-data', 'extract-code-ts'],
  );
});

for (const status of ['UNAVAILABLE', 'FAIL'] as const) {
  test(`an extract-data that is ${status} and did not find "no schema source" publishes nothing: the index is absent, not empty`, async () => {
    const dir = await repoWith(configOf('extract-code-ts', 'extract-data'));
    const codeSeen: ExtractContext[] = [];
    const d = fakeDeps(dir, [consumer(codeSeen), publisher(status, '{"version":1}', [])]);
    await runCli(d, ['extract', '--json']);
    assert.equal(codeSeen.length, 1);
    assert.equal('dataModelIndex' in (codeSeen[0] as ExtractContext), false);
  });
}

test('an extract-data that found no schema source at all publishes the empty index, and code gets it', async () => {
  const dir = await repoWith(configOf('extract-code-ts', 'extract-data'));
  const codeSeen: ExtractContext[] = [];
  const d = fakeDeps(dir, [
    consumer(codeSeen),
    publisher('UNAVAILABLE', '{"version":1}', [], true),
  ]);
  assert.equal(await runCli(d, ['extract', '--json']), EXIT_OK);
  assert.equal(codeSeen[0]?.dataModelIndex, '{"version":1}', 'the same text, unchanged');
  const report = JSON.parse(d.io.stdout()) as ExtractReport;
  assert.equal(
    report.results.find((r) => r.extractor === 'extract-data')?.status,
    'UNAVAILABLE',
    'the data scope is still not PASS',
  );
});

test('a FAIL that carries the no-schema-source flag still publishes nothing', async () => {
  const dir = await repoWith(configOf('extract-code-ts', 'extract-data'));
  const codeSeen: ExtractContext[] = [];
  const d = fakeDeps(dir, [consumer(codeSeen), publisher('FAIL', '{"version":1}', [], true)]);
  await runCli(d, ['extract', '--json']);
  assert.equal('dataModelIndex' in (codeSeen[0] as ExtractContext), false);
});

test('an empty index from a source-less extract-data never replaces the index of one that passed', async () => {
  // Two data entries in one config: the first reaches PASS with tables, the second finds no
  // source. The second must not blank what the first published.
  const dir = await repoWith({
    ...defaultConfig('demo'),
    extractors: [
      { name: 'extract-data', enabled: true, options: {} },
      { name: 'extract-data', enabled: true, options: {} },
      { name: 'extract-code-ts', enabled: true, options: {} },
    ],
  });
  let calls = 0;
  const twoFaced: ExtractorPort = {
    name: 'extract-data',
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () => {
      calls += 1;
      const passing = calls === 1;
      return Promise.resolve({
        result: makeResult(
          'extract-data',
          passing ? 'PASS' : 'UNAVAILABLE',
          ['data'],
          passing ? [] : ['no schema'],
        ),
        nodes: passing
          ? [makeNode({ kind: 'File', canonicalName: 'db/schema.sql', path: 'db/schema.sql' })]
          : [],
        edges: [],
        dataModelIndex: passing
          ? '{"version":1,"tables":"declared"}'
          : '{"version":1,"tables":"none"}',
        ...(passing ? {} : { noSchemaSource: true as const }),
      });
    },
  };
  const codeSeen: ExtractContext[] = [];
  const d = fakeDeps(dir, [consumer(codeSeen), twoFaced]);
  await runCli(d, ['extract', '--json']);
  assert.equal(calls, 2);
  assert.equal(codeSeen[0]?.dataModelIndex, '{"version":1,"tables":"declared"}');
});

/** One scripted answer of an `extract-data` entry. */
interface Answer {
  readonly status: ExtractorStatus;
  /** Offered with the result; omitted, as the real port omits it when it publishes nothing. */
  readonly index?: string;
  readonly noSchemaSource?: boolean;
  readonly throws?: boolean;
}

/** An `extract-data` that gives the answers in order, one per entry the config lists. */
function scripted(answers: readonly Answer[]): ExtractorPort {
  let call = 0;
  return {
    name: 'extract-data',
    version: '0.0.1',
    provenanceCeiling: 'EXTRACTED',
    extract: () => {
      const answer = answers[call] as Answer;
      call += 1;
      if (answer.throws === true) return Promise.reject(new Error('extract-data crashed'));
      return Promise.resolve({
        result: makeResult(
          'extract-data',
          answer.status,
          ['data'],
          answer.status === 'PASS' ? [] : ['no schema'],
        ),
        nodes:
          answer.status === 'PASS'
            ? [makeNode({ kind: 'File', canonicalName: 'db/schema.sql', path: 'db/schema.sql' })]
            : [],
        edges: [],
        ...(answer.index === undefined ? {} : { dataModelIndex: answer.index }),
        ...(answer.noSchemaSource === true ? { noSchemaSource: true as const } : {}),
      });
    },
  };
}

const EMPTY: Answer = {
  status: 'UNAVAILABLE',
  index: '{"version":1,"tables":"none"}',
  noSchemaSource: true,
};
const EMPTY_AGAIN: Answer = { ...EMPTY, index: '{"version":1,"tables":"none","again":true}' };
const PASSED: Answer = { status: 'PASS', index: '{"version":1,"tables":"declared"}' };
/** What the real port returns for a source it could not read: no index, no flag. */
const BLIND: Answer = { status: 'UNAVAILABLE' };
const CRASHED: Answer = { status: 'UNAVAILABLE', throws: true };
const FAILED: Answer = { status: 'FAIL' };

/**
 * Two `extract-data` entries (possible only with different `skipDirs` or `maxFileBytes`) answer in
 * order. The empty index says "nothing exists", so any entry that could not look contradicts it,
 * whichever came first; an index from a PASS stands whatever else was answered.
 */
const ORDERINGS: ReadonlyArray<readonly [string, readonly [Answer, Answer], string | undefined]> = [
  ['an empty index, then an entry that could not read a source', [EMPTY, BLIND], undefined],
  ['an entry that could not read a source, then an empty index', [BLIND, EMPTY], undefined],
  ['an empty index, then a FAIL', [EMPTY, FAILED], undefined],
  ['a FAIL, then an empty index', [FAILED, EMPTY], undefined],
  ['an empty index, then a crash', [EMPTY, CRASHED], undefined],
  ['a crash, then an empty index', [CRASHED, EMPTY], undefined],
  ['an empty index, then a PASS', [EMPTY, PASSED], PASSED.index],
  ['a PASS, then an empty index', [PASSED, EMPTY], PASSED.index],
  ['a PASS, then an entry that could not read a source', [PASSED, BLIND], PASSED.index],
  ['an entry that could not read a source, then a PASS', [BLIND, PASSED], PASSED.index],
  ['two empty indexes: the first stands', [EMPTY, EMPTY_AGAIN], EMPTY.index],
];

for (const [label, answers, expected] of ORDERINGS) {
  test(`two extract-data entries, ${label}: ${expected === undefined ? 'the index is absent' : 'the index handed on is the expected one'}`, async () => {
    const dir = await repoWith({
      ...defaultConfig('demo'),
      extractors: [
        { name: 'extract-data', enabled: true, options: {} },
        { name: 'extract-data', enabled: true, options: {} },
        { name: 'extract-code-ts', enabled: true, options: {} },
      ],
    });
    const codeSeen: ExtractContext[] = [];
    const d = fakeDeps(dir, [consumer(codeSeen), scripted(answers)]);
    await runCli(d, ['extract', '--json']);
    assert.equal(codeSeen.length, 1);
    if (expected === undefined) {
      assert.equal('dataModelIndex' in (codeSeen[0] as ExtractContext), false);
    } else {
      assert.equal(codeSeen[0]?.dataModelIndex, expected);
    }
  });
}

test('--only extract-code-ts has no index to pass', async () => {
  const dir = await repoWith(configOf('extract-code-ts', 'extract-data'));
  const codeSeen: ExtractContext[] = [];
  const dataSeen: ExtractContext[] = [];
  const d = fakeDeps(dir, [consumer(codeSeen), publisher('PASS', '{"version":1}', dataSeen)]);
  await runCli(d, ['extract', '--only', 'extract-code-ts', '--json']);
  assert.equal(dataSeen.length, 0);
  assert.equal('dataModelIndex' in (codeSeen[0] as ExtractContext), false);
});

/* ---------------------------------------------------- the real extractors */

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

const APP: Readonly<Record<string, string>> = {
  'prisma/schema.prisma': 'model Invitation {\n  id    String @id\n  email String\n}\n',
  'src/queries.ts': `import type { PrismaClient } from '@prisma/client';

export function find(): string {
  return 'SELECT id FROM "Invitation" WHERE id = $1';
}

export async function invite(prisma: PrismaClient): Promise<void> {
  await prisma.invitation.create({ data: { email: 'a@example.com' } });
}
`,
  'tsconfig.json': TSCONFIG,
  'package.json': JSON.stringify({ name: '@demo/app', version: '1.0.0', type: 'module' }),
};

async function runReal(
  extractors: readonly string[],
  files: Readonly<Record<string, string>>,
  runId: string,
): Promise<{ readonly report: ExtractReport; readonly sif: string; readonly dir: string }> {
  const dir = await repoWith(configOf(...extractors), files);
  const io = bufferIo({ cwd: dir, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const d: CliDeps = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => runId },
    store: sqliteStorePort(),
    extractors: [codeTsExtractorPort(), dataExtractorPort()],
    snapshots: fileSnapshots(),
  };
  assert.equal(await runCli(d, ['extract', '--json']), EXIT_OK, io.stderr());
  const report = JSON.parse(io.stdout()) as ExtractReport;
  const sif = await readFile(path.join(dir, 'seamline-out', 'runs', `${runId}.sif`), 'utf8');
  return { report, sif, dir };
}

test('through the real extractors, a quoted mixed-case statement lands on the Prisma table, in either config order', async () => {
  for (const order of [
    ['extract-code-ts', 'extract-data'],
    ['extract-data', 'extract-code-ts'],
  ]) {
    const { report, sif } = await runReal(order, APP, 'run-real');
    assert.deepEqual(
      report.results.map((r) => r.extractor),
      order,
    );
    assert.ok(
      report.results.every((r) => r.status === 'PASS'),
      JSON.stringify(report.results.map((r) => [r.extractor, r.status])),
    );

    const snapshot = parseSif(sif, 'data-model-index integration');
    const tableIds = snapshot.nodes.filter(node => node.kind === 'Table').map(node => node.id);
    assert.deepEqual(tableIds, ['demo:Table:public.Invitation']);
    const queries = snapshot.edges.filter(edge => edge.kind === 'QUERIES').map(edge => edge.dst);
    assert.deepEqual(
      queries,
      ['demo:Table:public.Invitation'],
      'the edge joins the table extract-data emitted',
    );
  }
});

test('the same tree twice, in two directories, gives the same SIF bytes', async () => {
  const first = await runReal(['extract-code-ts', 'extract-data'], APP, 'run-det');
  const second = await runReal(['extract-code-ts', 'extract-data'], APP, 'run-det');
  assert.notEqual(first.dir, second.dir);
  assert.equal(first.sif, second.sif);
});

test('without extract-data the code scope is UNAVAILABLE for a repository that writes through an ORM', async () => {
  const { report, sif } = await runReal(['extract-code-ts'], APP, 'run-absent');
  const code = report.results.find((r) => r.extractor === 'extract-code-ts');
  assert.equal(code?.status, 'UNAVAILABLE');
  assert.match(code?.diagnostics[0] ?? '', /data-model index absent/);
  assert.deepEqual(report.degradedScopes, ['code.ts']);
  assert.ok(sif.includes('"ormIndexAbsent":true'), 'the Repo node says why');
});

/* ------------------------------------- a repository the schema extractor has nothing to read in */

/** No schema file anywhere; the only SQL-looking string is interface prose. */
const NO_SCHEMA_APP: Readonly<Record<string, string>> = {
  'src/ui.ts': `export function pickerLabel(): string {
  return 'Select files from your computer';
}
`,
  'tsconfig.json': TSCONFIG,
  'package.json': JSON.stringify({ name: '@demo/app', version: '1.0.0', type: 'module' }),
};

const BOTH = ['extract-code-ts', 'extract-data'];

function statusOf(report: ExtractReport, extractor: string): string | undefined {
  return report.results.find((r) => r.extractor === extractor)?.status;
}

test('a repository with no schema source and a prose-like SQL string keeps a PASS code scope in a full run', async () => {
  for (const order of [BOTH, [...BOTH].reverse()]) {
    const { report, sif } = await runReal(order, NO_SCHEMA_APP, 'run-noschema');
    assert.equal(statusOf(report, 'extract-data'), 'UNAVAILABLE', 'there is still no data scope');
    assert.equal(statusOf(report, 'extract-code-ts'), 'PASS', order.join(','));
    assert.deepEqual(report.degradedScopes, ['data']);
    assert.ok(!sif.includes('ormIndexAbsent'), 'the index was empty, not absent');
    const queries = queryTargets(sif);
    assert.deepEqual(queries, ['demo:Table:public.your'], 'the name-only edge, as before row A');
  }
});

test('the same repository narrowed to extract-code-ts is UNAVAILABLE: the data run did not happen', async () => {
  const { report } = await runReal(['extract-code-ts'], NO_SCHEMA_APP, 'run-noschema-only');
  assert.equal(statusOf(report, 'extract-code-ts'), 'UNAVAILABLE');
  assert.match(report.results[0]?.diagnostics[0] ?? '', /raw-SQL table reference at src\/ui\.ts:2/);
});

test('a repository whose only schema file could not be read keeps an UNAVAILABLE code scope', async () => {
  // The schema file is over the size limit extract-data is configured with, so it is a source that
  // could not be read and not a repository without one: the tables it declares are unknown.
  const dir = await repoWith(
    {
      ...defaultConfig('demo'),
      extractors: [
        { name: 'extract-code-ts', enabled: true, options: {} },
        { name: 'extract-data', enabled: true, options: { maxFileBytes: 1000 } },
      ],
    },
    {
      ...NO_SCHEMA_APP,
      'src/ui.ts': `export function find(): string {\n  return 'SELECT id FROM "User" WHERE id = $1';\n}\n`,
      // Over the 1000 byte limit; every other file in the repository is under it.
      'prisma/schema.prisma': `// ${'x'.repeat(1200)}\nmodel User {\n  id Int @id\n}\n`,
    },
  );
  const out = await again(dir, ['extract', '--json'], 'run-unread');
  assert.equal(out.code, EXIT_OK);
  const report = JSON.parse(out.out) as ExtractReport;
  assert.equal(statusOf(report, 'extract-data'), 'UNAVAILABLE');
  assert.equal(statusOf(report, 'extract-code-ts'), 'UNAVAILABLE');
  assert.match(
    report.results[0]?.diagnostics[0] ?? '',
    /data-model index absent and a raw-SQL table reference at src\/ui\.ts:2/,
  );
  assert.deepEqual(report.degradedScopes, ['code.ts', 'data']);
});

test('a repository whose only schema source was read and declares no tables keeps an UNAVAILABLE code scope', async () => {
  // The third case in which the index is absent: a parser that yields no tables from schema text
  // must not read as "no tables", so this is not the empty index even though nothing was unread.
  const dir = await repoWith(configOf('extract-code-ts', 'extract-data'), {
    ...NO_SCHEMA_APP,
    'src/ui.ts': `export function find(): string {\n  return 'SELECT id FROM "User" WHERE id = $1';\n}\n`,
    'db/seed.sql': `INSERT INTO "User" (id) VALUES (1);\n`,
  });
  const out = await again(dir, ['extract', '--json'], 'run-seed-only');
  assert.equal(out.code, EXIT_OK);
  const report = JSON.parse(out.out) as ExtractReport;
  const data = report.results.find((r) => r.extractor === 'extract-data');
  assert.equal(data?.status, 'UNAVAILABLE');
  assert.ok(
    data?.diagnostics.some((d) => d.includes('were read (1) but declared no tables')),
    JSON.stringify(data?.diagnostics),
  );
  assert.equal(statusOf(report, 'extract-code-ts'), 'UNAVAILABLE');
  assert.match(
    report.results.find((r) => r.extractor === 'extract-code-ts')?.diagnostics[0] ?? '',
    /data-model index absent and a raw-SQL table reference at src\/ui\.ts:2/,
  );
});

/* ------------------------- a narrowed run without the index, over a real store */

const READER_REPO: Readonly<Record<string, string>> = {
  'prisma/schema.prisma': 'model User {\n  id    Int    @id\n  email String @unique\n}\n',
  'src/repo.ts': `import type { PrismaClient } from '@prisma/client';

export function listUsers(prisma: PrismaClient, email: string): unknown {
  return prisma.user.findMany({ where: { email } });
}

export function rawRead(): string {
  return 'SELECT id FROM "User" WHERE id = $1';
}
`,
  'tsconfig.json': TSCONFIG,
  'package.json': JSON.stringify({ name: '@demo/app', version: '1.0.0', type: 'module' }),
};

const USER_TABLE = 'demo:Table:public.User';
const READER = 'demo:Symbol:@demo/app#rawRead';

/** One CLI invocation over `dir` with the real extractors and the real store, as run `runId`. */
async function again(
  dir: string,
  argv: readonly string[],
  runId: string,
): Promise<{ readonly out: string; readonly code: number }> {
  const io = bufferIo({ cwd: dir, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const d: CliDeps = {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => runId },
    store: sqliteStorePort(),
    extractors: [codeTsExtractorPort(), dataExtractorPort()],
    snapshots: fileSnapshots(),
  };
  const code = await runCli(d, argv);
  return { out: io.stdout(), code };
}

interface Reach {
  readonly reachedCount: number;
  readonly reached: ReadonlyArray<{ readonly nodes: ReadonlyArray<{ readonly id: string }> }>;
  readonly unknown: ReadonlyArray<{ readonly scope: string }>;
}

async function reachOfUserTable(dir: string, runId: string): Promise<Reach> {
  const { out, code } = await again(dir, ['blast-radius', '--ids', USER_TABLE, '--json'], runId);
  assert.equal(code, EXIT_OK, out);
  return JSON.parse(out) as Reach;
}

/** The `QUERIES` edges as stored, tombstoned ones included. */
function storedQueries(
  dir: string,
): Array<{ readonly src: string; readonly dst: string; readonly deletedAt: string | null }> {
  const db = new DatabaseSync(path.join(dir, 'seamline-out', 'graph.db'), { readOnly: true });
  try {
    return db
      .prepare(
        "select src_id, dst_id, deleted_at from edges where kind = 'QUERIES' order by src_id, dst_id",
      )
      .all()
      .map((r) => ({
        src: String(r['src_id']),
        dst: String(r['dst_id']),
        deletedAt: r['deleted_at'] === null ? null : String(r['deleted_at']),
      }));
  } finally {
    db.close();
  }
}

test('a code-only run over a raw-SQL reader neither re-points nor buries the edge the full run bound', async () => {
  const dir = await repoWith(configOf('extract-code-ts', 'extract-data'), READER_REPO);

  const full = await again(dir, ['extract', '--json'], 'run-1');
  assert.equal(full.code, EXIT_OK);
  const fullReport = JSON.parse(full.out) as ExtractReport;
  assert.ok(fullReport.results.every((r) => r.status === 'PASS'));
  assert.deepEqual(storedQueries(dir), [{ src: READER, dst: USER_TABLE, deletedAt: null }]);
  const before = await reachOfUserTable(dir, 'run-1');
  assert.equal(before.reachedCount, 1);
  assert.deepEqual(
    before.reached.flatMap((g) => g.nodes.map((n) => n.id)),
    [READER],
  );

  // The index cannot reach a narrowed run: extract-data is not in it.
  const narrowed = await again(dir, ['extract', '--only', 'extract-code-ts', '--json'], 'run-2');
  const code = (JSON.parse(narrowed.out) as ExtractReport).results.find(
    (r) => r.extractor === 'extract-code-ts',
  );
  assert.equal(code?.status, 'UNAVAILABLE', 'a PASS here would sweep the bound edge');
  assert.match(code?.diagnostics[0] ?? '', /raw-SQL table reference at src\/repo\.ts:8/);

  // Nothing was swept: the bound edge is live. The UNAVAILABLE run's output is still stored, so
  // the name-only edge it built (`public.user`, which no schema declares) sits beside it.
  const stored = storedQueries(dir);
  assert.deepEqual(
    stored,
    [
      { src: READER, dst: USER_TABLE, deletedAt: null },
      { src: READER, dst: 'demo:Table:public.user', deletedAt: null },
    ],
    'no edge is tombstoned',
  );
  const after = await reachOfUserTable(dir, 'run-2');
  assert.equal(after.reachedCount, 1, 'the reader is still reached from the table');
  assert.deepEqual(
    after.reached.flatMap((g) => g.nodes.map((n) => n.id)),
    [READER],
  );
  assert.deepEqual(
    after.unknown.map((u) => u.scope),
    ['code.ts'],
    'and the report says the code scope is not known to be current',
  );

  // The next full run is a PASS with the index: the name-only edge is no longer seen and is
  // buried, and the bound edge is the only live one.
  const healed = await again(dir, ['extract', '--json'], 'run-3');
  assert.ok((JSON.parse(healed.out) as ExtractReport).results.every((r) => r.status === 'PASS'));
  assert.deepEqual(
    storedQueries(dir).map((e) => [e.dst, e.deletedAt === null]),
    [
      [USER_TABLE, true],
      ['demo:Table:public.user', false],
    ],
  );
  assert.equal((await reachOfUserTable(dir, 'run-3')).reachedCount, 1);
});

/* ---------------- a schema that stops being visible between two full runs (invariants 2 and 3) */

/** A schema in SQL and the one raw-SQL reader of its table, so that the bound edge is observable. */
const SQL_READER_REPO: Readonly<Record<string, string>> = {
  'db/schema.sql': 'CREATE TABLE "User" (\n  id integer PRIMARY KEY,\n  email text NOT NULL\n);\n',
  'src/repo.ts': `export function rawRead(): string {
  return 'SELECT id FROM "User" WHERE id = $1';
}
`,
  'tsconfig.json': TSCONFIG,
  'package.json': JSON.stringify({ name: '@demo/app', version: '1.0.0', type: 'module' }),
};

interface Hiding {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  /** Makes the schema invisible to discovery without deleting it. `outside` is beside the repository. */
  readonly hide: (dir: string, outside: string) => Promise<void>;
}

const HIDINGS: readonly Hiding[] = [
  {
    name: 'a symbolic link to the schema file',
    files: SQL_READER_REPO,
    hide: async (dir, outside) => {
      await rename(path.join(dir, 'db', 'schema.sql'), path.join(outside, 'schema.sql'));
      await symlink(path.join(outside, 'schema.sql'), path.join(dir, 'db', 'schema.sql'));
    },
  },
  {
    name: 'a symbolic link to the directory that holds it',
    files: SQL_READER_REPO,
    hide: async (dir, outside) => {
      await rename(path.join(dir, 'db'), path.join(outside, 'db'));
      await symlink(path.join(outside, 'db'), path.join(dir, 'db'));
    },
  },
  {
    name: 'the schema file renamed from .sql to .ddl',
    files: SQL_READER_REPO,
    hide: async (dir) => {
      await rename(path.join(dir, 'db', 'schema.sql'), path.join(dir, 'db', 'schema.ddl'));
    },
  },
  {
    name: 'the schema file moved under vendor/',
    files: SQL_READER_REPO,
    hide: async (dir) => {
      await mkdir(path.join(dir, 'vendor', 'db'), { recursive: true });
      await rename(
        path.join(dir, 'db', 'schema.sql'),
        path.join(dir, 'vendor', 'db', 'schema.sql'),
      );
    },
  },
  {
    name: 'a Prisma schema kept under a name discovery does not take, named by package.json',
    files: READER_REPO,
    hide: async (dir) => {
      await mkdir(path.join(dir, 'db'), { recursive: true });
      await rename(path.join(dir, 'prisma', 'schema.prisma'), path.join(dir, 'db', 'app.schema'));
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({
          name: '@demo/app',
          version: '1.0.0',
          type: 'module',
          prisma: { schema: 'db/app.schema' },
        }),
        'utf8',
      );
    },
  },
];

for (const hiding of HIDINGS) {
  test(`${hiding.name}: the next full run keeps the code scope UNAVAILABLE and sweeps nothing`, async () => {
    const dir = await repoWith(configOf('extract-code-ts', 'extract-data'), hiding.files);
    const outside = await mkdtemp(path.join(tmpdir(), 'seamline-model-index-outside-'));
    roots.push(outside);

    const first = await again(dir, ['extract', '--json'], 'run-1');
    const firstReport = JSON.parse(first.out) as ExtractReport;
    assert.equal(statusOf(firstReport, 'extract-data'), 'PASS');
    assert.equal(statusOf(firstReport, 'extract-code-ts'), 'PASS');
    assert.deepEqual(storedQueries(dir), [{ src: READER, dst: USER_TABLE, deletedAt: null }]);
    assert.equal((await reachOfUserTable(dir, 'run-1')).reachedCount, 1);

    await hiding.hide(dir, outside);

    const second = await again(dir, ['extract', '--json'], 'run-2');
    assert.equal(second.code, EXIT_OK);
    const report = JSON.parse(second.out) as ExtractReport;
    assert.equal(
      statusOf(report, 'extract-data'),
      'UNAVAILABLE',
      'the data scope did not see the schema',
    );
    assert.equal(
      statusOf(report, 'extract-code-ts'),
      'UNAVAILABLE',
      'a PASS here would sweep the edge run 1 bound to the table',
    );
    assert.ok(report.degradedScopes.includes('code.ts'));
    assert.deepEqual(
      storedQueries(dir),
      [
        { src: READER, dst: USER_TABLE, deletedAt: null },
        { src: READER, dst: 'demo:Table:public.user', deletedAt: null },
      ],
      'no edge is tombstoned',
    );
    const after = await reachOfUserTable(dir, 'run-2');
    assert.equal(after.reachedCount, 1, 'the reader is still reached from the table');
    assert.ok(
      after.unknown.some((u) => u.scope === 'code.ts'),
      'and the report says the code scope is not known to be current',
    );
  });
}

/* ------------------------------------------------------- the same hand-off, under the process sandbox */

/**
 * `seamline extract` as a release build wires it: every extractor in a confined child process. The
 * index is a string in the context the host sends to the child and in the output it sends back, so
 * these are the tests that show it survives the process boundary.
 */
async function runSandboxed(
  config: SeamlineConfig,
  files: Readonly<Record<string, string>>,
): Promise<{ readonly report: ExtractReport; readonly sif: string }> {
  const dir = await repoWith(config, files);
  const io = bufferIo({
    cwd: dir,
    isTty: false,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '/root',
      SEAMLINE_DETERMINISTIC: '1',
    },
  });
  assert.equal(await runCli(buildCliDeps(io), ['extract', '--json']), EXIT_OK, io.stderr());
  const report = JSON.parse(io.stdout()) as ExtractReport;
  const runs = path.join(dir, 'seamline-out', 'runs');
  const [file] = (await readdir(runs)).filter((f) => f.endsWith('.sif'));
  assert.ok(file !== undefined, 'the run wrote a SIF snapshot');
  return { report, sif: await readFile(path.join(runs, file), 'utf8') };
}

function queryTargets(sif: string): string[] {
  return parseSif(sif, 'data-model-index integration').edges
    .filter(edge => edge.kind === 'QUERIES').map(edge => edge.dst);
}

test('under the sandbox, the index crosses to the code child and a quoted statement lands on the Prisma table, in either config order', async () => {
  for (const order of [BOTH, [...BOTH].reverse()]) {
    const { report, sif } = await runSandboxed(configOf(...order), APP);
    assert.deepEqual(
      report.results.map((r) => [r.extractor, r.status]),
      order.map((name) => [name, 'PASS']),
    );
    assert.deepEqual(queryTargets(sif), ['demo:Table:public.Invitation'], order.join(','));
    assert.ok(!sif.includes('ormIndexAbsent'));
  }
});

test('under the sandbox, no schema source gives the code child the empty index: PASS, with the data scope still UNAVAILABLE', async () => {
  const { report, sif } = await runSandboxed(configOf(...BOTH), NO_SCHEMA_APP);
  assert.equal(statusOf(report, 'extract-data'), 'UNAVAILABLE');
  assert.equal(statusOf(report, 'extract-code-ts'), 'PASS');
  assert.deepEqual(report.degradedScopes, ['data']);
  assert.ok(!sif.includes('ormIndexAbsent'), 'the index was empty, not absent');
});

test('under the sandbox, the code child is UNAVAILABLE when no index reaches it', async () => {
  const absent = await runSandboxed(configOf('extract-code-ts'), APP);
  assert.equal(statusOf(absent.report, 'extract-code-ts'), 'UNAVAILABLE');
  assert.ok(absent.sif.includes('"ormIndexAbsent":true'));

  // A schema the data child could not read (over its size limit) is not "no schema": it is blind.
  const blind = await runSandboxed(
    {
      ...defaultConfig('demo'),
      extractors: [
        { name: 'extract-code-ts', enabled: true, options: {} },
        { name: 'extract-data', enabled: true, options: { maxFileBytes: 10 } },
      ],
    },
    APP,
  );
  assert.equal(statusOf(blind.report, 'extract-data'), 'UNAVAILABLE');
  assert.equal(statusOf(blind.report, 'extract-code-ts'), 'UNAVAILABLE');
  assert.ok(blind.sif.includes('"ormIndexAbsent":true'));
});
