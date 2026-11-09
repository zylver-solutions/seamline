import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { GraphView, RunRecord } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo, EXIT_OK, EXIT_USAGE } from '../io.ts';
import type { CliDeps, DetectionReport } from '../ports.ts';
import { runCli } from '../run.ts';
import {
  makeEdge,
  makeNode,
  makeResult,
  makeRun,
  memoryGraph,
  memoryStorePort,
  type MemoryGraph,
} from '../testing.ts';
import type { WhyReport } from './why.ts';

async function repoWithConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-why-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')), 'utf8');
  return dir;
}

// A repository nobody annotated: one column joined by inference to an ORM
// field, an API schema property, and the validator that enforces it.
const table = makeNode({ kind: 'Table', canonicalName: 'public.users' });
const column = makeNode({
  kind: 'Column',
  canonicalName: 'public.users.email',
  path: 'db/schema.sql',
  props: { nullable: false, type: 'text' },
});
const codeField = makeNode({
  kind: 'CodeField',
  canonicalName: 'User.email',
  path: 'src/models/user.ts',
});
const schemaProp = makeNode({
  kind: 'SchemaProperty',
  canonicalName: 'UserDto#/email',
  path: 'openapi.yaml',
});
const validator = makeNode({
  kind: 'Symbol',
  canonicalName: 'userSchema',
  path: 'src/dto/user.ts',
});

function lineageGraph(
  extra: { scopeStatus?: Record<string, 'PASS' | 'FAIL' | 'UNAVAILABLE'>; runs?: RunRecord[] } = {},
): MemoryGraph {
  return memoryGraph({
    nodes: [table, column, codeField, schemaProp, validator],
    edges: [
      makeEdge({
        kind: 'CONTAINS',
        src: table.id,
        dst: column.id,
        provenance: 'EXTRACTED',
        confidence: 1,
      }),
      makeEdge({
        kind: 'MAPS_TO_FIELD',
        src: column.id,
        dst: codeField.id,
        provenance: 'INFERRED',
        confidence: 0.92,
        sourceRef: 'name+type match',
      }),
      makeEdge({
        kind: 'EXPOSED_AS',
        src: codeField.id,
        dst: schemaProp.id,
        provenance: 'INFERRED',
        confidence: 0.87,
      }),
      makeEdge({
        kind: 'VALIDATED_BY',
        src: schemaProp.id,
        dst: validator.id,
        provenance: 'EXTRACTED',
        confidence: 1,
        sourceRef: 'src/dto/user.ts:14',
      }),
    ],
    ...(extra.scopeStatus === undefined ? {} : { scopeStatus: extra.scopeStatus }),
    runs: extra.runs ?? [
      makeRun('run-1', [
        makeResult('extract-data', 'PASS', ['data']),
        makeResult('extract-code-ts', 'PASS', ['code']),
      ]),
    ],
  });
}

function deps(
  cwd: string,
  graph: MemoryGraph,
  detection?: DetectionReport,
): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env: {} });
  return {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(graph),
    ...(detection === undefined
      ? {}
      : { detectors: { run: (_v: GraphView) => Promise.resolve(detection) } }),
  };
}

test('why renders the full lineage chain for a column with per-hop provenance', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, lineageGraph());
  const code = await runCli(d, ['why', 'users.email']);
  assert.equal(code, EXIT_OK, d.io.stderr());

  const out = d.io.stdout();
  for (const expected of [
    'public.users.email',
    'MAPS_TO_FIELD',
    'User.email',
    'EXPOSED_AS',
    'UserDto#/email',
    'VALIDATED_BY',
    'userSchema',
    'INFERRED',
    'EXTRACTED',
  ]) {
    assert.ok(out.includes(expected), `output mentions ${expected}\n---\n${out}`);
  }
  assert.ok(out.includes('0.92'), 'the MAPS_TO_FIELD confidence is shown');
  assert.ok(out.includes('0.87'), 'the EXPOSED_AS confidence is shown');
});

test('why --json produces the chain with hops in traversal order', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, lineageGraph());
  const code = await runCli(d, ['why', 'users.email', '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());

  const out = d.io.stdout();
  assert.doesNotMatch(out, /\u001b\[/, 'no ANSI escapes in --json output');
  const report = JSON.parse(out) as WhyReport;

  assert.equal(report.target.id, column.id);
  assert.equal(report.container?.id, table.id, 'the containing table is reported');

  const longest = report.chains[0];
  assert.ok(longest !== undefined, 'at least one chain');
  assert.deepEqual(
    longest.hops.map((h) => h.edge),
    ['MAPS_TO_FIELD', 'EXPOSED_AS', 'VALIDATED_BY'],
  );
  assert.deepEqual(
    longest.hops.map((h) => h.to.id),
    [codeField.id, schemaProp.id, validator.id],
  );
  assert.deepEqual(
    longest.hops.map((h) => h.provenance),
    ['INFERRED', 'INFERRED', 'EXTRACTED'],
  );
  assert.equal(longest.hops[0]?.confidence, 0.92);
  assert.equal(longest.hops[0]?.sourceRef, 'name+type match');
  assert.equal(longest.hops[2]?.sourceRef, 'src/dto/user.ts:14');
});

test('a chain is only as strong as its weakest hop', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, lineageGraph());
  await runCli(d, ['why', 'users.email', '--json']);
  const report = JSON.parse(d.io.stdout()) as WhyReport;
  const longest = report.chains[0];
  assert.ok(longest !== undefined);
  assert.equal(longest.weakestProvenance, 'INFERRED', 'one INFERRED hop makes the chain INFERRED');
  assert.equal(longest.confidence, Number((0.92 * 0.87 * 1).toFixed(4)));
});

test('why accepts a full NodeId as well as a suffix', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, lineageGraph());
  const code = await runCli(d, ['why', column.id, '--json']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const report = JSON.parse(d.io.stdout()) as WhyReport;
  assert.equal(report.target.id, column.id);
});

test('an ambiguous target lists candidates instead of guessing', async () => {
  const dir = await repoWithConfig();
  const other = makeNode({ kind: 'Column', canonicalName: 'analytics.users.email' });
  const graph = lineageGraph();
  await graph.store.upsertNodes('run-1', [other]);
  const d = deps(dir, graph);

  const code = await runCli(d, ['why', 'users.email']);
  assert.equal(code, EXIT_USAGE);
  assert.equal(d.io.stdout(), '', 'no lineage was printed for a guess');
  assert.match(d.io.stderr(), /matches 2 nodes/);
  assert.match(d.io.stderr(), /analytics\.users\.email/);
});

test('an unresolvable target is an actionable error, not an empty chain', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, lineageGraph());
  const code = await runCli(d, ['why', 'nope.nothing']);
  assert.equal(code, EXIT_USAGE);
  assert.match(d.io.stderr(), /no column, field, or schema property matches/);
  assert.match(d.io.stderr(), /seamline extract/);
});

test('why surfaces contradictions touching the lineage', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, lineageGraph(), {
    contradictions: [
      {
        code: 'X1_NULLABILITY',
        severity: 'high',
        left: column.id,
        right: schemaProp.id,
        claim: 'NOT NULL column exposed as an optional property',
        leftFact: 'nullable=false',
        rightFact: 'required=false',
        viaPath: ['EXPOSED_AS'],
        confidence: 0.9,
      },
      {
        code: 'X8_ORPHANED_MIGRATION',
        severity: 'low',
        left: makeNode({ kind: 'Migration', canonicalName: '0001_init' }).id,
        right: makeNode({ kind: 'Table', canonicalName: 'public.gone' }).id,
        claim: 'unrelated',
        leftFact: 'a',
        rightFact: 'b',
        viaPath: [],
        confidence: 1,
      },
    ],
    unknown: [],
  });

  await runCli(d, ['why', 'users.email', '--json']);
  const report = JSON.parse(d.io.stdout()) as WhyReport;
  assert.equal(report.contradictionsAvailable, true);
  assert.equal(report.contradictions.length, 1, 'only the one touching this lineage');
  assert.equal(report.contradictions[0]?.code, 'X1_NULLABILITY');
});

test('with no detector wired, why says so rather than reporting zero contradictions', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, lineageGraph());
  await runCli(d, ['why', 'users.email', '--json']);
  const report = JSON.parse(d.io.stdout()) as WhyReport;
  assert.equal(report.contradictionsAvailable, false);
  assert.equal(report.contradictions.length, 0);
});

test('a degraded scope is reported so an absent join is not read as absence', async () => {
  const dir = await repoWithConfig();
  const graph = lineageGraph({ scopeStatus: { data: 'UNAVAILABLE', code: 'PASS' } });
  const d = deps(dir, graph);

  await runCli(d, ['why', 'users.email', '--json']);
  const report = JSON.parse(d.io.stdout()) as WhyReport;
  assert.equal(report.unknown.length, 1);
  assert.equal(report.unknown[0]?.scope, 'data');
  assert.equal(report.unknown[0]?.status, 'UNAVAILABLE');
});

test('--depth truncates with an explicit marker rather than silently shortening', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, lineageGraph());
  await runCli(d, ['why', 'users.email', '--depth', '1', '--json']);
  const report = JSON.parse(d.io.stdout()) as WhyReport;
  assert.equal(report.truncated, true);
  assert.ok(report.truncationReasons.length > 0, 'the reason is named');
  assert.match(report.truncationReasons.join(' '), /depth cap/);
  assert.equal(report.chains[0]?.hops.length, 1);
});

test('--depth of 0 is rejected rather than silently treated as unlimited', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, lineageGraph());
  const code = await runCli(d, ['why', 'users.email', '--depth', '0']);
  assert.equal(code, EXIT_USAGE);
  assert.match(d.io.stderr(), /positive integer/);
});

test('a node with no joins reports no lineage instead of an empty success', async () => {
  const dir = await repoWithConfig();
  const orphan = makeNode({ kind: 'Column', canonicalName: 'public.audit.token' });
  const graph = memoryGraph({ nodes: [orphan] });
  const d = deps(dir, graph);
  const code = await runCli(d, ['why', 'audit.token']);
  assert.equal(code, EXIT_OK);
  assert.match(d.io.stdout(), /No lineage found/);
});

const NONE = { contradictions: [], unknown: [] };
const narrowedContracts = {
  ...makeResult(
    'extract-contracts',
    'PASS',
    ['contracts'],
    [
      'CONTRACTS_PARTIAL_COVERAGE: 11 file(s) are outside the authoritative claim; contracts they declare are neither emitted nor tombstoned by this run',
    ],
  ),
  authoritative: [{ scope: 'contracts', kinds: [] as const, selector: 'src/**' }],
};

test('a "none" over a narrowed contracts claim says how many files were not read', async () => {
  const dir = await repoWithConfig();
  const graph = lineageGraph({ runs: [makeRun('run-1', [narrowedContracts])] });

  const d = deps(dir, graph, NONE);
  assert.equal(await runCli(d, ['why', 'users.email']), EXIT_OK, d.io.stderr());
  const out = d.io.stdout();
  assert.doesNotMatch(out, /none touching this lineage$/m, 'never the unqualified "none"');
  assert.match(out, /none touching this lineage among the facts that were read/);
  assert.match(
    out,
    /the contracts claim is partial: 11 file\(s\) not read to the end \(extract-contracts\)/,
  );

  const json = deps(dir, lineageGraph({ runs: [makeRun('run-1', [narrowedContracts])] }), NONE);
  await runCli(json, ['why', 'users.email', '--json']);
  assert.deepEqual((JSON.parse(json.io.stdout()) as WhyReport).narrowedClaims, [
    { scope: 'contracts', extractor: 'extract-contracts', filesNotRead: 11 },
  ]);
});

test('a "none" over a claim read in full is unchanged, and the report has no narrowedClaims field', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir, lineageGraph(), NONE);
  await runCli(d, ['why', 'users.email']);
  assert.match(d.io.stdout(), /none touching this lineage$/m);
  const json = deps(dir, lineageGraph(), NONE);
  await runCli(json, ['why', 'users.email', '--json']);
  assert.ok(!('narrowedClaims' in JSON.parse(json.io.stdout())));
});

test('why preserves both detector uncertainty and narrowed coverage notices', async () => {
  const dir = await repoWithConfig();
  const detection: DetectionReport = {
    contradictions: [],
    unknown: [
      {
        code: 'X5_UNWRITTEN_COLUMN',
        severity: 'medium',
        reason: 'writer coverage was not measured',
        scopes: [],
        scopeStatus: {},
      },
    ],
  };
  const graph = () => lineageGraph({ runs: [makeRun('run-1', [narrowedContracts])] });
  const human = deps(dir, graph(), detection);
  assert.equal(await runCli(human, ['why', 'users.email']), EXIT_OK);
  assert.match(human.io.stdout(), /none found, but not every detector could run/);
  assert.match(human.io.stdout(), /Those checks are UNKNOWN, not clean/);
  assert.match(human.io.stdout(), /the contracts claim is partial: 11 file\(s\) not read/);
  assert.doesNotMatch(human.io.stdout(), /none touching this lineage$/m);
  const json = deps(dir, graph(), detection);
  assert.equal(await runCli(json, ['why', 'users.email', '--json']), EXIT_OK);
  const report = JSON.parse(json.io.stdout()) as WhyReport;
  assert.deepEqual(report.unknownDetectors, detection.unknown);
  assert.deepEqual(report.narrowedClaims, [
    { scope: 'contracts', extractor: 'extract-contracts', filesNotRead: 11 },
  ]);
});
