#!/usr/bin/env node
/**
 * Tests for scripts/dogfood-lib.mjs and scripts/dogfood-gate.mjs.
 *
 * The gate's job is to fail when what Seamline finds about itself changes
 * without review, and to stay green when an unrelated source file changes. Both
 * halves are asserted as outcomes, with negative controls: a baseline with one
 * finding removed, one severity changed, one extra unread file or one changed
 * examples line must fail with a message that names what differed, and a new
 * file the extractor does read must not.
 *
 * The pure functions are tested against small inline fixtures. The gate script
 * itself is run end to end as a subprocess against a throwaway repository and a
 * fake CLI, so its "does not pass when it cannot check" paths (missing CLI,
 * missing baseline, failed extract, crashed check) are exercised for real
 * without a ten-second self-extraction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_FILES,
  baselineSelfReferences,
  canonicalJson,
  canonicalizeFindings,
  compareBaselines,
  compareCoverage,
  compareExamples,
  compareFindings,
  compareWhy,
  foreignRunIds,
  formatProblems,
  isTrackedCodeFile,
  measureCodeCoverage,
  normalizeRunIds,
  parseCheckRun,
  renderBaselineFiles,
  RUN_ID_PLACEHOLDER,
  runIdOfRunFile,
  selectExamplesSif,
} from './dogfood-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNREAD = 'not in any loaded tsconfig project: ';
/** Two derived run ids, and the fixed one that baselines written before ids were derived carry. */
const RUN_A = 'run-det-0123456789abcdef';
const RUN_B = 'run-det-fedcba9876543210';
const LEGACY_RUN = 'run-deterministic-0000';
const EXAMPLE_SQL = 'examples/harbor-books/db/migrations/0014_orders_shipping.sql';
const OTHER_SQL = 'db/migrations/0001_users.sql';

// ---------------------------------------------------------------------------
// Fixtures: a miniature self-extraction in SIF, and a check report for it
// ---------------------------------------------------------------------------

const node = (id, kind, path, props = {}) => ({
  t: 'node',
  node: {
    id,
    kind,
    path,
    name: id,
    confidence: 1,
    provenance: 'EXTRACTED',
    sensitivity: 'internal',
    firstSeenRun: RUN_A,
    lastSeenRun: RUN_A,
    props,
  },
});

const edge = (kind, src, dst) => ({
  t: 'edge',
  edge: {
    kind,
    src,
    dst,
    confidence: 1,
    provenance: 'EXTRACTED',
    firstSeenRun: RUN_A,
    lastSeenRun: RUN_A,
    props: {},
  },
});

/** The same extraction or output as a different run: every run id's value swapped. */
const asRun = (text, runId) => text.replaceAll(RUN_A, runId);

const status = (extractor, state, scope, extra = {}) => ({
  t: 'status',
  result: {
    extractor,
    version: '0.0.1',
    status: state,
    authoritative: [{ scope, kinds: [], selector: '*' }],
    diagnostics: [],
    nodeCount: 10,
    edgeCount: 10,
    durationMs: 0,
    ...extra,
  },
});

const GROUP = { sif: 0, status: 1, node: 2, edge: 3 };
const tupleOf = (e) =>
  e.t === 'status'
    ? [e.result.extractor]
    : e.t === 'node'
      ? [e.node.id]
      : e.t === 'edge'
        ? [e.edge.src, e.edge.dst, e.edge.kind]
        : [''];

/** Canonical order: header, statuses, nodes by id, edges by (src, dst, kind). */
function sifText(entries) {
  const sorted = [...entries].sort((a, b) => {
    if (GROUP[a.t] !== GROUP[b.t]) return GROUP[a.t] - GROUP[b.t];
    const ta = tupleOf(a);
    const tb = tupleOf(b);
    for (let i = 0; i < ta.length; i += 1) {
      if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
    }
    return 0;
  });
  return `${sorted.map((e) => JSON.stringify(e)).join('\n')}\n`;
}

const ID = {
  exField: 'seamline:CodeField:app#Order.customerEmail',
  exProp: 'seamline:SchemaProperty:OrderResponse#/properties/customerEmail',
  exCol: 'seamline:Column:public.orders.customer_email',
  exColId: 'seamline:Column:public.orders.id',
  exTable: 'seamline:Table:public.orders',
  coreField: 'seamline:CodeField:@seamline/core#Order.customerEmail',
  userTable: 'seamline:Table:app.users',
  userCol: 'seamline:Column:app.users.id',
};

/**
 * A small self-extraction: ordinary source files, the bundled example (including
 * its SQL migration), look-alike paths that must not count as the example, and
 * an unrelated SQL fixture.
 */
function selfExtraction({
  readFiles = ['src/a.ts'],
  unread = ['src/b.ts'],
  reportUnread = true,
  extraEntries = [],
  exampleProps = {},
  counts = {},
} = {}) {
  return sifText([
    { t: 'sif', version: '1.0.0', runId: RUN_A },
    status('extract-code-ts', 'PASS', 'code.ts', {
      diagnostics: reportUnread ? unread.map((p) => `${UNREAD}${p}`) : [],
      ...counts,
    }),
    status('extract-data', 'UNAVAILABLE', 'data.sql', counts),
    status('infer-join', 'PASS', 'infer-join', counts),
    ...readFiles.map((p) => node(`seamline:File:${p}`, 'File', p)),
    node('seamline:Repo:seamline', 'Repo', undefined),
    node(ID.exField, 'CodeField', 'examples/harbor-books/src/models/order.ts', exampleProps),
    node(ID.exProp, 'SchemaProperty', 'examples/harbor-books/contracts/order-response.schema.json'),
    node(ID.exCol, 'Column', EXAMPLE_SQL),
    node(ID.exColId, 'Column', EXAMPLE_SQL),
    node(ID.exTable, 'Table', EXAMPLE_SQL),
    node(ID.coreField, 'CodeField', 'packages/core/src/order.ts'),
    node('seamline:Symbol:packages-look-alike', 'Symbol', 'packages/foo/examples/demo.ts'),
    node('seamline:Symbol:sibling-dir', 'Symbol', 'examples-old/demo.ts'),
    node(ID.userTable, 'Table', OTHER_SQL),
    node(ID.userCol, 'Column', OTHER_SQL),
    edge('MAPS_TO_FIELD', ID.exCol, ID.exField),
    edge('EXPOSED_AS', ID.exField, ID.exProp),
    edge('CONTAINS', ID.exTable, ID.exCol),
    edge('CONTAINS', ID.exTable, ID.exColId),
    edge('EXPOSED_AS', ID.coreField, ID.exProp),
    edge('CONTAINS', ID.userTable, ID.userCol),
    ...extraEntries,
  ]);
}

const checkReport = (overrides = {}) => ({
  outcome: 'findings',
  contradictions: [
    {
      code: 'X1_NULLABILITY',
      severity: 'high',
      left: 'seamline:Column:public.orders.shipped_at',
      right: 'seamline:SchemaProperty:OrderResponse#/properties/shippedAt',
      claim:
        'the database permits NULL in shipped_at but the contract declares shippedAt non-nullable',
      leftFact: 'shipped_at is NULL-able (db/orders.sql:7)',
      rightFact: 'shippedAt is non-nullable (contracts/order.json#/properties/shippedAt)',
      viaPath: ['EXPOSED_AS'],
      confidence: 0.917,
    },
    {
      code: 'X2_TYPE_MISMATCH',
      severity: 'medium',
      left: 'seamline:Column:public.orders.total',
      right: 'seamline:SchemaProperty:OrderResponse#/properties/total',
      claim: 'the column is numeric but the contract declares a string',
      leftFact: 'total is numeric (db/orders.sql:9)',
      rightFact: 'total is a string (contracts/order.json#/properties/total)',
      viaPath: [],
      confidence: 0.8,
    },
  ],
  counts: { critical: 0, high: 1, medium: 1, low: 0 },
  unknownDetectors: [
    {
      code: 'X3_PII_EXPOSURE',
      severity: 'high',
      reason:
        'SCOPE_NOT_PASS: scope(s) not PASS: data.sql=UNAVAILABLE; UNKNOWN rather than a finding (v3 section 2.2)',
      scopes: ['data.sql'],
      scopeStatus: { 'data.sql': 'UNAVAILABLE' },
    },
  ],
  degradedScopes: [
    {
      scope: 'data.sql',
      status: 'UNAVAILABLE',
      extractor: 'extract-data',
      diagnostics: ['the SQL parser crashed after 12 files'],
    },
  ],
  exitCode: 1,
  ...overrides,
});

/** The "current" record the gate builds, from fixtures. */
function currentRecord({ sif = selfExtraction(), report = checkReport(), tracked, why } = {}) {
  const examples = selectExamplesSif(sif);
  return {
    coverage: measureCodeCoverage(tracked ?? ['src/a.ts', 'src/b.ts'], sif),
    examples: examples.text,
    findings: canonicalizeFindings(report, sif),
    why:
      why ??
      canonicalJson({
        chains: [
          {
            confidence: 0.79,
            hops: [{ firstSeenRun: RUN_A, id: ID.exCol, lastSeenRun: RUN_A }],
          },
        ],
        target: 'orders.customer_email',
      }),
  };
}

/** The committed baseline texts that `--update` would write for `current`. */
function baselineTexts(current) {
  const files = renderBaselineFiles(current);
  return Object.fromEntries(
    Object.entries(BASELINE_FILES).map(([key, name]) => [key, files[name]]),
  );
}

const parseLines = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// ---------------------------------------------------------------------------
// examples.sif: the subset that comes from examples/
// ---------------------------------------------------------------------------

test('selectExamplesSif keeps exactly the nodes under examples/ and the edges between them', () => {
  const picked = selectExamplesSif(selfExtraction());
  const lines = parseLines(picked.text);

  const nodeIds = lines.filter((l) => l.t === 'node').map((l) => l.node.id);
  assert.deepEqual(
    nodeIds,
    [ID.exField, ID.exProp, ID.exCol, ID.exColId, ID.exTable].sort(),
    'exactly the nodes whose path is under examples/, SQL migration included',
  );

  const edges = lines
    .filter((l) => l.t === 'edge')
    .map((l) => `${l.edge.kind} ${l.edge.src} ${l.edge.dst}`);
  assert.deepEqual(
    edges,
    [
      `EXPOSED_AS ${ID.exField} ${ID.exProp}`,
      `MAPS_TO_FIELD ${ID.exCol} ${ID.exField}`,
      `CONTAINS ${ID.exTable} ${ID.exCol}`,
      `CONTAINS ${ID.exTable} ${ID.exColId}`,
    ],
    'only edges whose source and destination are both in the subset, in canonical order',
  );

  assert.equal(lines[0].t, 'sif', 'the SIF header is kept so the file is a loadable SIF');
  assert.equal(picked.nodes, 5);
  assert.equal(picked.edges, 4);
  assert.ok(picked.text.endsWith('\n'));
});

test('selectExamplesSif does not claim look-alike paths, ordinary neighbours or an unrelated SQL fixture', () => {
  const text = selectExamplesSif(selfExtraction()).text;
  for (const excluded of [
    'packages/foo/examples/demo.ts',
    'examples-old/demo.ts',
    ID.coreField,
    ID.userTable,
    ID.userCol,
    'seamline:Repo:seamline',
    'src/a.ts',
  ]) {
    assert.ok(!text.includes(excluded), `${excluded} must not be in examples.sif`);
  }
});

test('selectExamplesSif places a node by its path alone, however it is joined to the examples', () => {
  const opaque = '\u00abredacted:sha256:b422879d\u00bb.sql';
  const sif = selfExtraction({
    extraEntries: [
      node('seamline:Table:opaque-path', 'Table', opaque),
      node('seamline:Table:no-path', 'Table', undefined),
      edge('CONTAINS', 'seamline:Table:opaque-path', ID.exCol),
      edge('CONTAINS', 'seamline:Table:no-path', ID.exCol),
    ],
  });
  const lines = parseLines(selectExamplesSif(sif).text);
  const nodeIds = lines.filter((l) => l.t === 'node').map((l) => l.node.id);
  assert.deepEqual(
    nodeIds,
    [ID.exField, ID.exProp, ID.exCol, ID.exColId, ID.exTable].sort(),
    'a node joined to an example node but not under examples/ is not an example node',
  );
  assert.ok(
    !lines.some((l) => l.t === 'edge' && JSON.stringify(l).includes('opaque-path')),
    'an edge to a node outside the subset is not in the subset',
  );
});

test('selectExamplesSif emits the source lines byte for byte, in source order', () => {
  const sif = selfExtraction();
  const sourceLines = sif.split('\n').filter(Boolean);
  const picked = selectExamplesSif(sif).text.split('\n').filter(Boolean);
  let from = 0;
  for (const line of picked) {
    const at = sourceLines.indexOf(line, from);
    assert.notEqual(
      at,
      -1,
      `line must appear verbatim, and after the previous one: ${line.slice(0, 80)}`,
    );
    from = at + 1;
  }
});

test('an unrelated source edit does not move examples.sif or any other baseline file', () => {
  const before = currentRecord();
  const after = currentRecord({
    sif: selfExtraction({
      readFiles: ['src/a.ts', 'src/helper.ts'],
      counts: { nodeCount: 99999, edgeCount: 88888, durationMs: 7 },
      extraEntries: [
        node('seamline:Symbol:@seamline/core#aNewHelper', 'Symbol', 'packages/core/src/helper.ts', {
          exported: true,
        }),
        node(
          'seamline:Symbol:@seamline/core#aNewTest',
          'Symbol',
          'packages/core/src/helper.test.ts',
        ),
        edge(
          'CONTAINS',
          'seamline:Symbol:@seamline/core#aNewHelper',
          'seamline:Symbol:@seamline/core#aNewTest',
        ),
      ],
    }),
    tracked: ['src/a.ts', 'src/b.ts', 'src/helper.ts'],
  });
  assert.equal(after.examples, before.examples);
  assert.deepEqual(compareBaselines(baselineTexts(before), after), []);
  assert.notEqual(after.coverage.tracked, before.coverage.tracked, 'the new file was counted');
});

test('a change inside the example moves examples.sif and the comparison names the node and field', () => {
  const before = currentRecord({ sif: selfExtraction({ exampleProps: { nullable: false } }) });
  const after = currentRecord({ sif: selfExtraction({ exampleProps: { nullable: true } }) });
  assert.notEqual(after.examples, before.examples);
  const problems = compareExamples(before.examples, after.examples);
  assert.equal(problems.length, 1);
  const text = formatProblems(problems, 'docs/dogfood/baseline');
  assert.match(text, /examples\.sif/);
  assert.match(text, /changed: node seamline:CodeField:app#Order\.customerEmail/);
  assert.match(text, /props\.nullable: false -> true/);
});

test('selectExamplesSif rejects a line that is not JSON and names the line', () => {
  assert.throws(
    () => selectExamplesSif('{"t":"sif"}\nnot json\n'),
    /self-extraction SIF: line 2 is not a JSON object/,
  );
});

test('example selection preserves v2 framing and refuses duplicate, late and future framing', () => {
  const legacy = selfExtraction();
  const records = legacy.trimEnd().split('\n').map(line => JSON.parse(line));
  const run = { runId: RUN_A, repo: 'seamline', commit: null, startedAt: '1970-01-01T00:00:00.000Z', finishedAt: '1970-01-01T00:00:00.000Z', ontologyVersion: '1.0.0', results: records.filter(record => record.t === 'status').map(record => record.result) };
  const framed = `seamline-sif/2.0.0\n${JSON.stringify({ t: 'run', run })}\n${records.filter(record => record.t !== 'sif').map(record => JSON.stringify(record)).join('\n')}\n`;
  const oldSubset = selectExamplesSif(legacy);
  const newSubset = selectExamplesSif(framed);
  const subset = newSubset.text.trimEnd().split('\n');
  assert.equal(subset.shift(), 'seamline-sif/2.0.0');
  const header = JSON.parse(subset.shift());
  assert.deepEqual(header, { t: 'run', run: { ...run, results: [] } }, 'the example subset keeps actual run metadata and certifies no full-repository scope');
  assert.equal(subset.join('\n'), oldSubset.text.trimEnd().split('\n').slice(1).join('\n'), 'selected facts remain byte-identical');
  const changedCounts = framed.replace('"nodeCount":10', '"nodeCount":999');
  assert.equal(selectExamplesSif(changedCounts).text, newSubset.text, 'full-repository counts do not make the example baseline depend on unrelated source changes');
  assert.equal(newSubset.nodes, oldSubset.nodes);
  assert.equal(newSubset.edges, oldSubset.edges);
  for (const text of [`seamline-sif/9.0.0\n${legacy}`, `${legacy}seamline-sif/2.0.0\n`, `${framed}seamline-sif/2.0.0\n`]) {
    assert.throws(() => selectExamplesSif(text), /framing/);
  }
  assert.throws(() => selectExamplesSif(`seamline-sif/2.0.0\n${legacy}`), /not a version-2 SIF record/);
});

test('selectExamplesSif returns nothing for a SIF with no example nodes, so the gate can refuse it', () => {
  const sif = sifText([
    { t: 'sif', version: '1.0.0', runId: 'r' },
    node('seamline:File:src/a.ts', 'File', 'src/a.ts'),
  ]);
  const picked = selectExamplesSif(sif);
  assert.equal(picked.nodes, 0);
  assert.equal(picked.edges, 0);
});

// ---------------------------------------------------------------------------
// examples.sif comparison: negative controls
// ---------------------------------------------------------------------------

test('compareExamples reports an added node, a removed edge and a changed node, with line numbers', () => {
  const base = selectExamplesSif(selfExtraction()).text;
  const lines = base.split('\n').filter(Boolean);
  const edgeLine = lines.findIndex((l) => l.includes('"MAPS_TO_FIELD"'));
  assert.ok(edgeLine > 0);
  const mutated = [...lines];
  const removedEdge = mutated.splice(edgeLine, 1)[0];
  const nodeLine = mutated.findIndex((l) => l.includes(ID.exProp));
  mutated[nodeLine] = mutated[nodeLine].replace(
    '"sensitivity":"internal"',
    '"sensitivity":"restricted"',
  );
  mutated.push(JSON.stringify(node('seamline:Symbol:examples-new', 'Symbol', 'examples/x.ts')));

  const [problem] = compareExamples(`${lines.join('\n')}\n`, `${mutated.join('\n')}\n`);
  const text = problem.details.join('\n');
  assert.match(text, /removed: edge MAPS_TO_FIELD seamline:Column:public\.orders\.customer_email/);
  assert.match(
    text,
    /changed: node seamline:SchemaProperty:OrderResponse#\/properties\/customerEmail/,
  );
  assert.match(text, /sensitivity: "internal" -> "restricted"/);
  assert.match(text, /added: node seamline:Symbol:examples-new/);
  assert.ok(removedEdge.length > 0);
});

test('compareExamples is silent for identical text and notices a mere reordering', () => {
  const base = selectExamplesSif(selfExtraction()).text;
  assert.deepEqual(compareExamples(base, base), []);
  const lines = base.split('\n').filter(Boolean);
  const swapped = [lines[0], lines[2], lines[1], ...lines.slice(3)].join('\n') + '\n';
  const [problem] = compareExamples(base, swapped);
  assert.match(problem.details.join('\n'), /different order/);
});

// ---------------------------------------------------------------------------
// code-ts-coverage.json: the unread list
// ---------------------------------------------------------------------------

test('measureCodeCoverage lists unread files and the ones the extractor stayed silent about', () => {
  const sif = selfExtraction({
    readFiles: ['src/a.ts'],
    unread: ['src/b.ts'],
    reportUnread: false,
  });
  const m = measureCodeCoverage(['src/a.ts', 'src/b.ts', 'tools/run.mjs'], sif);
  assert.deepEqual(m.unread, ['src/b.ts', 'tools/run.mjs']);
  assert.deepEqual(m.unreported, ['src/b.ts', 'tools/run.mjs']);
  assert.equal(m.read, 1);
  assert.equal(m.tracked, 3);
  assert.equal(m.ratio, 0.3333);
});

test('measureCodeCoverage accepts an unread file the extractor named, and a truncated list', () => {
  const named = measureCodeCoverage(['src/a.ts', 'src/b.ts'], selfExtraction());
  assert.deepEqual(named.unread, ['src/b.ts']);
  assert.deepEqual(named.unreported, []);

  const sif = selfExtraction({ reportUnread: false });
  const truncated = sif.replace('"diagnostics":[]', '"diagnostics":["... 3 more not listed"]');
  assert.deepEqual(measureCodeCoverage(['src/a.ts', 'src/b.ts'], truncated).unreported, []);
});

test('measureCodeCoverage refuses an extraction with no extract-code-ts status', () => {
  const sif = sifText([
    { t: 'sif', version: '1.0.0', runId: 'r' },
    status('infer-join', 'PASS', 'x'),
  ]);
  assert.throws(() => measureCodeCoverage(['src/a.ts'], sif), /no extract-code-ts status line/);
});

test('isTrackedCodeFile counts TS/JS sources and skips declaration files', () => {
  assert.equal(isTrackedCodeFile('scripts/x.mjs'), true);
  assert.equal(isTrackedCodeFile('packages/a/src/x.ts'), true);
  assert.equal(isTrackedCodeFile('packages/a/src/x.d.ts'), false);
  assert.equal(isTrackedCodeFile('docs/x.md'), false);
});

test('compareCoverage fails on an extra unread file and names it', () => {
  const base = currentRecord();
  const worse = currentRecord({
    sif: selfExtraction({ unread: ['src/b.ts', 'src/c.ts'] }),
    tracked: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  });
  const [problem] = compareCoverage(baselineTexts(base).coverage, worse.coverage);
  assert.match(problem.summary, /unread/);
  assert.match(problem.details.join('\n'), /src\/c\.ts/);
  assert.doesNotMatch(problem.details.join('\n'), /src\/b\.ts/);
});

test('compareCoverage does not fail when a file that IS read is added', () => {
  const base = currentRecord();
  const grown = currentRecord({
    sif: selfExtraction({ readFiles: ['src/a.ts', 'src/new.ts'] }),
    tracked: ['src/a.ts', 'src/b.ts', 'src/new.ts'],
  });
  assert.equal(grown.coverage.tracked, base.coverage.tracked + 1);
  assert.equal(grown.coverage.read, base.coverage.read + 1);
  assert.notEqual(grown.coverage.ratio, base.coverage.ratio);
  assert.deepEqual(compareCoverage(baselineTexts(base).coverage, grown.coverage), []);
});

test('compareCoverage fails when an unread file becomes read, so the improvement is recorded', () => {
  const base = currentRecord();
  const better = currentRecord({
    sif: selfExtraction({ readFiles: ['src/a.ts', 'src/b.ts'], unread: [] }),
  });
  const [problem] = compareCoverage(baselineTexts(base).coverage, better.coverage);
  assert.match(problem.details.join('\n'), /src\/b\.ts/);
  assert.match(problem.details.join('\n'), /now read/);
});

test('compareCoverage ignores ratio, read and tracked if a baseline still carries them', () => {
  const current = currentRecord().coverage;
  const legacy = JSON.stringify({ ratio: 0.01, read: 1, tracked: 500, unread: current.unread });
  assert.deepEqual(compareCoverage(legacy, current), []);
});

test('compareCoverage reports a malformed baseline instead of passing', () => {
  const current = currentRecord().coverage;
  for (const bad of ['not json', '{}', '{"unread":"src/b.ts"}', '{"unread":[1]}']) {
    const [problem] = compareCoverage(bad, current);
    assert.match(problem.summary, /malformed/, bad);
  }
});

// ---------------------------------------------------------------------------
// findings.json: what `seamline check` reports
// ---------------------------------------------------------------------------

test('canonicalizeFindings is independent of input order', () => {
  const report = checkReport();
  const shuffled = checkReport({
    contradictions: [...report.contradictions].reverse(),
    unknownDetectors: [
      {
        ...report.unknownDetectors[0],
        scopes: ['z.scope', 'data.sql'],
        scopeStatus: { 'z.scope': 'FAIL', 'data.sql': 'UNAVAILABLE' },
      },
    ],
  });
  const reordered = checkReport({
    contradictions: report.contradictions,
    unknownDetectors: [
      {
        ...report.unknownDetectors[0],
        scopes: ['data.sql', 'z.scope'],
        scopeStatus: { 'data.sql': 'UNAVAILABLE', 'z.scope': 'FAIL' },
      },
    ],
  });
  const sif = selfExtraction();
  assert.equal(
    canonicalJson(canonicalizeFindings(shuffled, sif)),
    canonicalJson(canonicalizeFindings(reordered, sif)),
  );
  assert.deepEqual(
    canonicalizeFindings(report, sif).contradictions.map((c) => c.code),
    ['X1_NULLABILITY', 'X2_TYPE_MISMATCH'],
  );
});

test('canonicalizeFindings keeps subjects, claims and statuses, and drops run-dependent fields', () => {
  const sif = selfExtraction();
  const findings = canonicalizeFindings(checkReport(), sif);
  assert.deepEqual(findings.contradictions[0], {
    claim:
      'the database permits NULL in shipped_at but the contract declares shippedAt non-nullable',
    code: 'X1_NULLABILITY',
    left: 'seamline:Column:public.orders.shipped_at',
    right: 'seamline:SchemaProperty:OrderResponse#/properties/shippedAt',
    severity: 'high',
    viaPath: ['EXPOSED_AS'],
  });
  assert.equal(findings.outcome, 'findings');
  assert.deepEqual(
    findings.unknownDetectors.map((u) => u.code),
    ['X3_PII_EXPOSURE'],
  );
  assert.deepEqual(findings.degradedScopes, [
    { extractor: 'extract-data', scope: 'data.sql', status: 'UNAVAILABLE' },
  ]);
  assert.deepEqual(findings.extractors, [
    { extractor: 'extract-code-ts', scopes: ['code.ts'], status: 'PASS' },
    { extractor: 'extract-data', scopes: ['data.sql'], status: 'UNAVAILABLE' },
    { extractor: 'infer-join', scopes: ['infer-join'], status: 'PASS' },
  ]);

  const text = canonicalJson(findings);
  for (const volatile of [
    'leftFact',
    'rightFact',
    'confidence',
    'diagnostics',
    'durationMs',
    'nodeCount',
    'edgeCount',
    'counts',
    'exitCode',
    '.sql:7',
  ]) {
    assert.ok(!text.includes(volatile), `${volatile} must not be recorded`);
  }

  const noisy = checkReport({ counts: { critical: 9, high: 9, medium: 9, low: 9 } });
  noisy.contradictions[0] = {
    ...noisy.contradictions[0],
    leftFact: 'moved to db/orders.sql:42',
    confidence: 0.1,
  };
  noisy.degradedScopes[0] = {
    ...noisy.degradedScopes[0],
    diagnostics: ['a different crash message'],
  };
  assert.equal(
    canonicalJson(
      canonicalizeFindings(
        noisy,
        selfExtraction({ counts: { nodeCount: 1, edgeCount: 2, durationMs: 3 } }),
      ),
    ),
    text,
  );
});

test('canonicalizeFindings rejects a malformed report and an extraction with no status lines', () => {
  const sif = selfExtraction();
  assert.throws(() => canonicalizeFindings(null, sif), /not a JSON object/);
  assert.throws(
    () => canonicalizeFindings({ ...checkReport(), contradictions: undefined }, sif),
    /contradictions is not an array/,
  );
  const broken = checkReport();
  delete broken.contradictions[1].severity;
  assert.throws(
    () => canonicalizeFindings(broken, sif),
    /contradictions\[1\]\.severity is not a string/,
  );
  assert.throws(
    () =>
      canonicalizeFindings(checkReport(), sifText([{ t: 'sif', version: '1.0.0', runId: 'r' }])),
    /no extractor status lines/,
  );
});

test('parseCheckRun accepts exit 1 (contradictions found) and rejects every kind of crash', () => {
  const stdout = JSON.stringify(checkReport());
  assert.equal(parseCheckRun(1, stdout).outcome, 'findings');
  assert.equal(parseCheckRun(0, JSON.stringify(checkReport({ exitCode: 0 }))).exitCode, 0);

  assert.throws(() => parseCheckRun(3, stdout), /exited 3.*crash/s);
  assert.throws(() => parseCheckRun(2, stdout), /exited 2/);
  assert.throws(() => parseCheckRun(null, stdout), /exited abnormally/);
  assert.throws(() => parseCheckRun(1, 'Error: boom'), /did not print JSON/);
  assert.throws(() => parseCheckRun(1, '{"hello":1}'), /not a check report/);
  assert.throws(() => parseCheckRun(0, stdout), /exited 0 but its report says exitCode 1/);
});

/** Parse a rendered baseline, mutate it, and render it again as a committed file would be. */
function mutatedFindings(current, mutate) {
  const parsed = JSON.parse(baselineTexts(current).findings);
  mutate(parsed);
  return canonicalJson(parsed);
}

test('compareFindings is silent when nothing changed, whatever the whitespace', () => {
  const current = currentRecord();
  assert.deepEqual(compareFindings(baselineTexts(current).findings, current.findings), []);
  const compact = JSON.stringify(JSON.parse(baselineTexts(current).findings));
  assert.deepEqual(compareFindings(compact, current.findings), []);
});

test('compareFindings names a contradiction that disappeared from the current report', () => {
  const current = currentRecord();
  const base = mutatedFindings(current, (b) => {
    b.contradictions.push({
      claim: 'a contradiction the reviewed run had',
      code: 'X9_OLD',
      left: 'seamline:Column:public.legacy.id',
      right: 'seamline:SchemaProperty:Legacy#/properties/id',
      severity: 'critical',
      viaPath: [],
    });
  });
  const [problem] = compareFindings(base, current.findings);
  const text = problem.details.join('\n');
  assert.match(
    text,
    /- contradiction disappeared: \[critical\] X9_OLD seamline:Column:public\.legacy\.id/,
  );
});

test('compareFindings names a contradiction that appeared in the current report', () => {
  const current = currentRecord();
  const base = mutatedFindings(current, (b) => {
    b.contradictions = b.contradictions.filter((c) => c.code !== 'X2_TYPE_MISMATCH');
  });
  const [problem] = compareFindings(base, current.findings);
  assert.match(
    problem.details.join('\n'),
    /\+ contradiction appeared: \[medium\] X2_TYPE_MISMATCH/,
  );
});

test('compareFindings names a changed severity', () => {
  const current = currentRecord();
  const base = mutatedFindings(current, (b) => {
    b.contradictions[0].severity = 'low';
  });
  const [problem] = compareFindings(base, current.findings);
  const text = problem.details.join('\n');
  assert.match(text, /~ contradiction changed: \[low\] X1_NULLABILITY/);
  assert.match(text, /severity: "low" -> "high"/);
});

test('compareFindings names an extractor whose scope status changed, and a vanished UNKNOWN', () => {
  const current = currentRecord();
  const base = mutatedFindings(current, (b) => {
    b.extractors.find((e) => e.extractor === 'extract-data').status = 'PASS';
    b.unknownDetectors = [];
    b.degradedScopes = [];
    b.outcome = 'clean';
  });
  const text = compareFindings(base, current.findings)[0].details.join('\n');
  assert.match(
    text,
    /~ extractor scope status changed: extract-data \(data\.sql\) \(status: "PASS" -> "UNAVAILABLE"\)/,
  );
  assert.match(text, /\+ UNKNOWN detector appeared: X3_PII_EXPOSURE/);
  assert.match(text, /\+ degraded scope appeared: data\.sql \(extract-data\)/);
  assert.match(text, /~ outcome changed: "clean" -> "findings"/);
});

test('compareFindings reports a malformed baseline instead of passing', () => {
  const [problem] = compareFindings('[1,2]', currentRecord().findings);
  assert.match(problem.summary, /malformed/);
});

// ---------------------------------------------------------------------------
// why-orders-customer-email.json
// ---------------------------------------------------------------------------

test('compareWhy names the path that changed and tolerates reformatting', () => {
  const current = currentRecord();
  assert.deepEqual(compareWhy(JSON.stringify(JSON.parse(current.why)), current.why), []);
  const changed = JSON.parse(current.why);
  changed.chains[0].confidence = 0.5;
  const [problem] = compareWhy(canonicalJson(changed), current.why);
  assert.match(problem.details.join('\n'), /chains\[0\]\.confidence: 0\.5 -> 0\.79/);
});

// ---------------------------------------------------------------------------
// Run ids: compared modulo their value, everything else byte for byte
// ---------------------------------------------------------------------------

test('normalizeRunIds replaces a derived and a legacy run id wherever they appear, and nothing else', () => {
  const text = [
    `{"runId":"${RUN_A}"}`,
    `{"firstSeenRun":"${RUN_B}","lastSeenRun":"${LEGACY_RUN}","note":"see ${RUN_A}.sif"}`,
  ].join('\n');
  assert.equal(
    normalizeRunIds(text),
    [
      `{"runId":"${RUN_ID_PLACEHOLDER}"}`,
      `{"firstSeenRun":"${RUN_ID_PLACEHOLDER}","lastSeenRun":"${RUN_ID_PLACEHOLDER}","note":"see ${RUN_ID_PLACEHOLDER}.sif"}`,
    ].join('\n'),
  );

  const untouched = [
    'run-det-', // the bare prefix, as it appears in source text
    `${RUN_A}0`, // 17 hex digits is not a derived id
    'run-det-0123456789abcde', // 15 is not either
    'run-det-0123456789ABCDEF', // ids are lower-case
    'run-deterministic-0001', // only the fixed legacy id
    'run-inputs',
    'run-1',
    `x${RUN_A}`,
    `${RUN_A}-x`,
  ].join('\n');
  assert.equal(normalizeRunIds(untouched), untouched, 'text that is not a run id is left alone');
});

test('a changed run id alone passes, in examples.sif and in the why output', () => {
  const before = currentRecord();
  const after = currentRecord({
    sif: asRun(selfExtraction(), RUN_B),
    why: asRun(before.why, RUN_B),
  });
  assert.notEqual(after.examples, before.examples, 'the run id really is in examples.sif');
  assert.notEqual(after.why, before.why, 'the run id really is in the why output');
  assert.ok(after.examples.includes(RUN_B) && !after.examples.includes(RUN_A));
  assert.deepEqual(compareBaselines(baselineTexts(before), after), []);
  assert.deepEqual(compareExamples(before.examples, after.examples), []);
  assert.deepEqual(compareWhy(before.why, after.why), []);
});

test('a baseline that still carries the legacy run id compares clean against a derived one', () => {
  const current = currentRecord();
  const legacy = {
    ...baselineTexts(current),
    examples: current.examples.replaceAll(RUN_A, LEGACY_RUN),
    why: current.why.replaceAll(RUN_A, LEGACY_RUN),
  };
  assert.ok(legacy.examples.includes(LEGACY_RUN) && legacy.why.includes(LEGACY_RUN));
  assert.deepEqual(compareBaselines(legacy, current), []);
});

test('any other change still fails when the run id changed too, and the report names it, not the run id', () => {
  const base = currentRecord();
  const baseline = baselineTexts(base);

  // An example field changed in the same run that changed the id.
  const exampleMoved = currentRecord({
    sif: asRun(selfExtraction({ exampleProps: { nullable: true } }), RUN_B),
    why: asRun(base.why, RUN_B),
  });
  const examplesProblems = compareBaselines(baseline, exampleMoved);
  assert.equal(examplesProblems.length, 1);
  const examplesText = formatProblems(examplesProblems, 'docs/dogfood/baseline');
  assert.match(examplesText, /examples\.sif/);
  assert.match(examplesText, /changed: node seamline:CodeField:app#Order\.customerEmail/);
  assert.match(examplesText, /props\.nullable/);
  assert.ok(!examplesText.includes(RUN_A) && !examplesText.includes(RUN_B));
  assert.ok(!examplesText.includes(RUN_ID_PLACEHOLDER), 'the run id is not reported as a change');

  // A why value changed in the same run that changed the id.
  const whyMoved = JSON.parse(asRun(base.why, RUN_B));
  whyMoved.chains[0].confidence = 0.5;
  const whyProblems = compareBaselines(
    baseline,
    currentRecord({ sif: asRun(selfExtraction(), RUN_B), why: canonicalJson(whyMoved) }),
  );
  assert.equal(whyProblems.length, 1);
  assert.match(whyProblems[0].file, /why-orders-customer-email\.json/);
  assert.match(whyProblems[0].details.join('\n'), /chains\[0\]\.confidence: 0\.79 -> 0\.5/);

  // A node added or removed.
  const extra = node(
    'seamline:Column:public.orders.extra',
    'Column',
    'examples/harbor-books/x.sql',
  );
  const added = currentRecord({
    sif: asRun(selfExtraction({ extraEntries: [extra] }), RUN_B),
    why: asRun(base.why, RUN_B),
  });
  assert.match(
    formatProblems(compareBaselines(baseline, added), 'd'),
    /added: node seamline:Column:public\.orders\.extra/,
  );
});

test('a run-id-valued field that holds something else is a difference, not a run id', () => {
  const base = currentRecord();
  const baseline = baselineTexts(base);
  for (const imposter of ['run-0001', 'run-det-', 'run-det-0123456789abcdeg', 'r', '']) {
    const sif = selfExtraction().replaceAll(
      `"firstSeenRun":"${RUN_A}"`,
      `"firstSeenRun":"${imposter}"`,
    );
    const problems = compareExamples(baseline.examples, currentRecord({ sif }).examples);
    assert.equal(problems.length, 1, `firstSeenRun ${JSON.stringify(imposter)} must be reported`);
    assert.match(problems[0].details.join('\n'), /node\.firstSeenRun/);
  }
});

test('a run id that is not where it was, or is missing, is still a difference', () => {
  const base = currentRecord();
  const baseline = baselineTexts(base);
  const without = selfExtraction().replaceAll(`"lastSeenRun":"${RUN_A}",`, '');
  const [problem] = compareExamples(baseline.examples, currentRecord({ sif: without }).examples);
  assert.match(problem.details.join('\n'), /node\.lastSeenRun: "<run-id>" -> \(absent\)/);
});

test('a committed baseline that names two different runs is a problem, though the extraction names one', () => {
  const base = currentRecord();
  const baseline = baselineTexts(base);
  // The first run id in the committed text becomes one run's, the second another's.
  const mixed = (text) =>
    text.replace(RUN_ID_PLACEHOLDER, RUN_A).replace(RUN_ID_PLACEHOLDER, RUN_B);

  for (const [key, compare] of [
    ['examples', compareExamples],
    ['why', compareWhy],
  ]) {
    const text = mixed(baseline[key]);
    assert.ok(text.includes(RUN_A) && text.includes(RUN_B), `${key}: two runs are in the text`);
    // Without the check the normalisation would make the two indistinguishable
    // from the one-run baseline, and this comparison would report nothing.
    assert.equal(normalizeRunIds(text), baseline[key]);
    const problems = compare(text, base[key]);
    assert.equal(problems.length, 1, `${key} must be reported`);
    assert.equal(problems[0].file, BASELINE_FILES[key]);
    assert.match(problems[0].summary, /more than one run id/);
    assert.match(problems[0].details.join('\n'), new RegExp(`${RUN_A}\\n${RUN_B}`));
  }

  const whole = compareBaselines({ ...baseline, examples: mixed(baseline.examples) }, base);
  assert.equal(whole.length, 1);
  assert.match(formatProblems(whole, 'docs/dogfood/baseline'), /more than one run id/);

  // One run is still one run, whichever kind of id it is, however often it is named.
  for (const one of [RUN_A, RUN_B, LEGACY_RUN]) {
    const text = baseline.examples.replaceAll(RUN_ID_PLACEHOLDER, one);
    assert.deepEqual(compareExamples(text, base.examples), [], one);
  }
});

test('runIdOfRunFile accepts only the snapshot of a derived run id', () => {
  assert.equal(runIdOfRunFile(`${RUN_A}.sif`), RUN_A);
  for (const name of [
    `${LEGACY_RUN}.sif`,
    'run-det-0123456789abcde.sif',
    `${RUN_A}0.sif`,
    `${RUN_A}.sif.bak`,
    `x${RUN_A}.sif`,
    `${RUN_A}.json`,
    'run-0001.sif',
    '',
  ]) {
    assert.equal(runIdOfRunFile(name), null, `${name} is not a derived run's snapshot`);
  }
});

test('foreignRunIds finds a run id other than the extracted one, derived or legacy', () => {
  const own = selfExtraction();
  assert.deepEqual(foreignRunIds(own, RUN_A), []);
  assert.deepEqual(foreignRunIds('no ids here', RUN_A), []);
  assert.deepEqual(foreignRunIds(asRun(own, RUN_B), RUN_A), [RUN_B]);
  assert.deepEqual(
    foreignRunIds(`${own}\n{"lastSeenRun":"${RUN_B}"}\n{"lastSeenRun":"${LEGACY_RUN}"}`, RUN_A),
    [RUN_B, LEGACY_RUN].sort(),
  );
});

test('a baseline is written with the placeholder in place of every run id, and compares clean', () => {
  const current = currentRecord();
  const files = renderBaselineFiles(current);
  for (const name of [BASELINE_FILES.examples, BASELINE_FILES.why]) {
    assert.ok(!files[name].includes('run-det-'), `${name} must not carry the run id`);
    assert.ok(files[name].includes(RUN_ID_PLACEHOLDER), `${name} carries the placeholder`);
  }
  assert.equal(files[BASELINE_FILES.examples], normalizeRunIds(current.examples));
  assert.ok(
    parseLines(files[BASELINE_FILES.examples]).every(
      (l) => l.t === 'sif' || (l.node ?? l.edge).firstSeenRun === RUN_ID_PLACEHOLDER,
    ),
  );
  assert.deepEqual(compareBaselines(baselineTexts(current), current), []);
  assert.equal(
    renderBaselineFiles(currentRecord({ sif: asRun(selfExtraction(), RUN_B) }))[
      BASELINE_FILES.examples
    ],
    files[BASELINE_FILES.examples],
    'regenerating the baseline under another run id writes the same bytes',
  );
});

// ---------------------------------------------------------------------------
// The whole baseline
// ---------------------------------------------------------------------------

test('a baseline rendered from the current record compares clean', () => {
  const current = currentRecord();
  assert.deepEqual(compareBaselines(baselineTexts(current), current), []);
});

test('rendered baseline files are the four reviewed surfaces, and extract.sif is not one of them', () => {
  const files = renderBaselineFiles(currentRecord());
  assert.deepEqual(Object.keys(files).sort(), [
    'code-ts-coverage.json',
    'examples.sif',
    'findings.json',
    'why-orders-customer-email.json',
  ]);
  assert.deepEqual(Object.keys(JSON.parse(files['code-ts-coverage.json'])), ['unread']);
});

test('a baseline with one finding removed, one severity changed, one extra unread file and one changed examples line fails on each, by name', () => {
  const current = currentRecord();
  const texts = baselineTexts(current);

  // One finding removed from the baseline, so the current report has one the baseline lacks.
  const findings = JSON.parse(texts.findings);
  findings.contradictions.pop();
  // One severity changed.
  findings.contradictions[0].severity = 'low';
  // One extra unread file recorded in the baseline, which is now read.
  const coverage = JSON.parse(texts.coverage);
  coverage.unread.push('src/was-unread.ts');
  // One examples.sif line changed.
  const exampleLines = texts.examples.split('\n');
  const target = exampleLines.findIndex((l) => l.includes('"t":"node"') && l.includes(ID.exField));
  assert.ok(target > 0);
  exampleLines[target] = exampleLines[target].replace('"confidence":1', '"confidence":0.5');

  const mutated = {
    ...texts,
    findings: canonicalJson(findings),
    coverage: canonicalJson(coverage),
    examples: exampleLines.join('\n'),
  };
  const problems = compareBaselines(mutated, current);
  assert.deepEqual(
    problems.map((p) => p.file),
    ['code-ts-coverage.json', 'findings.json', 'examples.sif'],
  );
  const report = formatProblems(problems, 'docs/dogfood/baseline');
  assert.match(report, /docs\/dogfood\/baseline\/findings\.json/);
  assert.match(report, /X2_TYPE_MISMATCH/);
  assert.match(report, /severity: "low" -> "high"/);
  assert.match(report, /src\/was-unread\.ts/);
  assert.match(report, /confidence: 0\.5 -> 1/);
});

test('a missing baseline part is a problem, never a pass', () => {
  const current = currentRecord();
  const texts = baselineTexts(current);
  delete texts.findings;
  const problems = compareBaselines(texts, current);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].file, 'findings.json');
  assert.match(problems[0].summary, /no committed baseline/);
});

// ---------------------------------------------------------------------------
// The gate script, end to end, against a throwaway repository and a fake CLI
// ---------------------------------------------------------------------------

const FAKE_CLI = `
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const env = process.env;
if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, args[0] + '\\n');
if (args[0] === 'extract') {
  const baseline = join(flag('--repo'), 'docs', 'dogfood', 'baseline');
  if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, 'baseline-present=' + existsSync(baseline) + '\\n');
  if (env.FAKE_EXTRACT_KILLS_GATE) {
    process.kill(process.ppid, 'SIGKILL');
    setTimeout(() => process.exit(9), 3000);
    await new Promise(() => {});
  }
  if (env.FAKE_EXTRACT_EXIT) {
    process.stderr.write('fake extract exploded\\n');
    process.exit(Number(env.FAKE_EXTRACT_EXIT));
  }
  const runs = join(flag('--out'), 'runs');
  mkdirSync(runs, { recursive: true });
  copyFileSync(env.FAKE_SIF, join(runs, (env.FAKE_RUN_FILE ?? env.FAKE_RUN_ID) + '.sif'));
} else if (args[0] === 'why') {
  const run = env.FAKE_WHY_RUN ?? env.FAKE_RUN_ID;
  const hops = [{ firstSeenRun: run, lastSeenRun: run }];
  process.stdout.write(JSON.stringify({ target: args[1], chains: [{ confidence: 0.79, hops }] }) + '\\n');
} else if (args[0] === 'check') {
  if (env.FAKE_CHECK_STDOUT_FILE) process.stdout.write(readFileSync(env.FAKE_CHECK_STDOUT_FILE, 'utf8'));
  if (env.FAKE_CHECK_STDERR) process.stderr.write(env.FAKE_CHECK_STDERR + '\\n');
  process.exit(Number(env.FAKE_CHECK_EXIT ?? 0));
} else {
  process.exit(2);
}
`;

/** A throwaway "repository" holding copies of the gate, a fake CLI, and two tracked sources. */
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dogfood-gate-test-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(HERE, 'dogfood-gate.mjs'), join(root, 'scripts', 'dogfood-gate.mjs'));
  copyFileSync(join(HERE, 'dogfood-lib.mjs'), join(root, 'scripts', 'dogfood-lib.mjs'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  writeFileSync(join(root, 'fake-cli.mjs'), FAKE_CLI);
  writeFileSync(join(root, 'fake.sif'), selfExtraction());
  writeFileSync(join(root, 'fake-check.json'), JSON.stringify(checkReport()));
  const git = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const add = spawnSync('git', ['add', 'src'], { cwd: root, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);

  const baselineDir = join(root, 'docs', 'dogfood', 'baseline');
  return {
    root,
    baselineDir,
    log: join(root, 'cli.log'),
    cliCalls: () =>
      existsSync(join(root, 'cli.log'))
        ? readFileSync(join(root, 'cli.log'), 'utf8').split('\n').filter(Boolean)
        : [],
    run(args = [], env = {}) {
      return spawnSync(process.execPath, [join(root, 'scripts', 'dogfood-gate.mjs'), ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          SEAMLINE_CLI: join(root, 'fake-cli.mjs'),
          FAKE_SIF: join(root, 'fake.sif'),
          FAKE_RUN_ID: RUN_A,
          FAKE_CHECK_STDOUT_FILE: join(root, 'fake-check.json'),
          FAKE_CHECK_EXIT: '1',
          FAKE_LOG: join(root, 'cli.log'),
          ...env,
        },
      });
    },
    setSif(text) {
      writeFileSync(join(root, 'fake.sif'), text);
    },
    read(name) {
      return readFileSync(join(baselineDir, name), 'utf8');
    },
    write(name, text) {
      writeFileSync(join(baselineDir, name), text);
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function withSandbox(fn) {
  const sandbox = makeSandbox();
  try {
    return fn(sandbox);
  } finally {
    sandbox.dispose();
  }
}

/** A sandbox with a freshly written baseline. */
function withBaseline(fn) {
  return withSandbox((sb) => {
    const updated = sb.run(['--update']);
    assert.equal(updated.status, 0, updated.stderr);
    return fn(sb);
  });
}

test('gate: --update writes the four reviewed surfaces, and the next run passes', () => {
  withSandbox((sb) => {
    const updated = sb.run(['--update']);
    assert.equal(updated.status, 0, updated.stderr);
    assert.deepEqual(readdirSync(sb.baselineDir).sort(), [
      'code-ts-coverage.json',
      'examples.sif',
      'findings.json',
      'why-orders-customer-email.json',
    ]);
    assert.deepEqual(JSON.parse(sb.read('code-ts-coverage.json')), { unread: ['src/b.ts'] });
    assert.equal(JSON.parse(sb.read('findings.json')).contradictions.length, 2);
    assert.match(sb.read('examples.sif'), /seamline:CodeField:app#Order\.customerEmail/);

    const run = sb.run();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /dogfood-gate PASSED/);
    assert.match(
      run.stdout,
      /check: 2 contradiction\(s\), 1 UNKNOWN detector\(s\), 3 extractor scope status/,
    );
  });
});

test('gate: a run under a different run id passes, and regenerating the baseline writes the same bytes', () => {
  withBaseline((sb) => {
    const examples = sb.read('examples.sif');
    const why = sb.read('why-orders-customer-email.json');
    assert.ok(!examples.includes('run-det-') && !why.includes('run-det-'));
    assert.ok(examples.includes(RUN_ID_PLACEHOLDER) && why.includes(RUN_ID_PLACEHOLDER));

    sb.setSif(asRun(selfExtraction(), RUN_B));
    const run = sb.run([], { FAKE_RUN_ID: RUN_B });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /dogfood-gate PASSED/);

    const updated = sb.run(['--update'], { FAKE_RUN_ID: RUN_B });
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(sb.read('examples.sif'), examples);
    assert.equal(sb.read('why-orders-customer-email.json'), why);
  });
});

test('gate: a baseline still carrying the legacy run id passes under a derived one', () => {
  withBaseline((sb) => {
    for (const name of ['examples.sif', 'why-orders-customer-email.json']) {
      sb.write(name, sb.read(name).replaceAll(RUN_ID_PLACEHOLDER, LEGACY_RUN));
      assert.ok(sb.read(name).includes(LEGACY_RUN));
    }
    const run = sb.run();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /dogfood-gate PASSED/);
  });
});

test('gate: a changed example field still fails, naming the field, when the run id changed too', () => {
  withBaseline((sb) => {
    sb.setSif(asRun(selfExtraction({ exampleProps: { nullable: true } }), RUN_B));
    const run = sb.run([], { FAKE_RUN_ID: RUN_B });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /examples\.sif/);
    assert.match(run.stderr, /props\.nullable/);
    assert.ok(!run.stderr.includes(RUN_B), 'the new run id is not what the report is about');
  });
});

test('gate: a run file not named for a derived run id fails, with or without --update', () => {
  withBaseline((sb) => {
    const before = sb.read('examples.sif');
    for (const args of [[], ['--update']]) {
      const run = sb.run(args, { FAKE_RUN_FILE: LEGACY_RUN });
      assert.equal(run.status, 1, run.stdout);
      assert.match(run.stderr, /the run file is not named for a deterministic run id/);
      assert.match(run.stderr, /found run-deterministic-0000\.sif/);
    }
    assert.equal(sb.read('examples.sif'), before, 'a refused run does not rewrite the baseline');
  });
});

test('gate: output that names a run other than the one extracted fails, so normalising cannot hide it', () => {
  withBaseline((sb) => {
    // One node reports it was first seen in some other run.
    sb.setSif(selfExtraction().replace(`"firstSeenRun":"${RUN_A}"`, `"firstSeenRun":"${RUN_B}"`));
    const snapshot = sb.run();
    assert.equal(snapshot.status, 1, snapshot.stdout);
    assert.match(
      snapshot.stderr,
      /the run snapshot mentions a run other than the one just extracted/,
    );
    assert.ok(snapshot.stderr.includes(RUN_A) && snapshot.stderr.includes(RUN_B));

    // The why output names another run.
    sb.setSif(selfExtraction());
    const why = sb.run([], { FAKE_WHY_RUN: RUN_B });
    assert.equal(why.status, 1, why.stdout);
    assert.match(why.stderr, /`seamline why orders\.customer_email` mentions a run other than/);

    // And with the ids agreeing again it passes.
    const clean = sb.run();
    assert.equal(clean.status, 0, clean.stderr);
  });
});

test('gate: a check that exits 1 because it found contradictions is expected, not a failure', () => {
  withBaseline((sb) => {
    const run = sb.run([], { FAKE_CHECK_EXIT: '1' });
    assert.equal(run.status, 0, run.stderr);
  });
});

test('gate: an unrelated source change passes against the unchanged baseline', () => {
  withBaseline((sb) => {
    writeFileSync(join(sb.root, 'src', 'helper.ts'), 'export const helper = () => 1;\n');
    spawnSync('git', ['add', 'src'], { cwd: sb.root });
    sb.setSif(
      selfExtraction({
        readFiles: ['src/a.ts', 'src/helper.ts'],
        counts: { nodeCount: 4242, edgeCount: 1717, durationMs: 9 },
        extraEntries: [node('seamline:Symbol:@seamline/core#helper', 'Symbol', 'src/helper.ts')],
      }),
    );
    const run = sb.run();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /dogfood-gate PASSED/);
  });
});

test('gate: a newly unread tracked file fails and is named; a newly read one passes', () => {
  withBaseline((sb) => {
    writeFileSync(join(sb.root, 'src', 'c.ts'), 'export const c = 3;\n');
    spawnSync('git', ['add', 'src'], { cwd: sb.root });

    sb.setSif(selfExtraction({ readFiles: ['src/a.ts', 'src/c.ts'] }));
    const read = sb.run();
    assert.equal(read.status, 0, read.stderr);

    sb.setSif(selfExtraction({ unread: ['src/b.ts', 'src/c.ts'] }));
    const unread = sb.run();
    assert.equal(unread.status, 1);
    assert.match(unread.stderr, /dogfood-gate FAILED/);
    assert.match(unread.stderr, /code-ts-coverage\.json/);
    assert.match(unread.stderr, /src\/c\.ts/);
  });
});

test('gate: an unread file the extractor does not report fails even with a matching baseline', () => {
  withBaseline((sb) => {
    sb.setSif(selfExtraction({ reportUnread: false }));
    const run = sb.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /did not read 1 tracked file\(s\) and did not report them/);
    assert.match(run.stderr, /src\/b\.ts/);
  });
});

test('gate: a changed finding, a changed severity and a changed examples line each fail with the difference named', () => {
  withBaseline((sb) => {
    const findings = JSON.parse(sb.read('findings.json'));
    const original = sb.read('findings.json');

    findings.contradictions.shift();
    sb.write('findings.json', canonicalJson(findings));
    const removed = sb.run();
    assert.equal(removed.status, 1);
    assert.match(removed.stderr, /findings\.json/);
    assert.match(removed.stderr, /contradiction appeared: \[high\] X1_NULLABILITY/);

    const reseverity = JSON.parse(original);
    reseverity.contradictions[0].severity = 'low';
    sb.write('findings.json', canonicalJson(reseverity));
    const severity = sb.run();
    assert.equal(severity.status, 1);
    assert.match(severity.stderr, /severity: "low" -> "high"/);

    sb.write('findings.json', original);
    const originalExamples = sb.read('examples.sif');
    const lines = originalExamples.split('\n');
    const at = lines.findIndex((l) => l.includes('"t":"node"') && l.includes(ID.exTable));
    lines[at] = lines[at].replace('"sensitivity":"internal"', '"sensitivity":"restricted"');
    sb.write('examples.sif', lines.join('\n'));
    const example = sb.run();
    assert.equal(example.status, 1);
    assert.match(example.stderr, /examples\.sif/);
    assert.match(example.stderr, /changed: node seamline:Table:public\.orders/);
    assert.match(example.stderr, /node\.sensitivity: "restricted" -> "internal"/);
    assert.match(example.stderr, /Never run --update just to clear a red build/);

    sb.write('examples.sif', originalExamples);
    assert.equal(sb.run().status, 0, 'restoring the baseline makes the gate pass again');
  });
});

test('gate: a missing baseline file fails before any extraction runs', () => {
  withBaseline((sb) => {
    rmSync(join(sb.baselineDir, 'findings.json'));
    rmSync(sb.log, { force: true });
    const run = sb.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no committed baseline found/);
    assert.match(run.stderr, /docs\/dogfood\/baseline\/findings\.json/);
    assert.deepEqual(
      sb.cliCalls(),
      [],
      'the gate must not spend time extracting without a baseline',
    );
  });
});

test('gate: no baseline at all fails', () => {
  withSandbox((sb) => {
    const run = sb.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no committed baseline found/);
  });
});

test('gate: a missing CLI fails', () => {
  withSandbox((sb) => {
    const run = sb.run([], { SEAMLINE_CLI: '' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /the extraction CLI could not be found/);
  });
});

test('gate: a failed extraction fails', () => {
  withBaseline((sb) => {
    const run = sb.run([], { FAKE_EXTRACT_EXIT: '3' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /`seamline extract` on this repository failed/);
    assert.match(run.stderr, /fake extract exploded/);
  });
});

test('gate: a crashed check fails, whatever the baseline says', () => {
  withBaseline((sb) => {
    const run = sb.run([], { FAKE_CHECK_EXIT: '3', FAKE_CHECK_STDERR: 'store is locked' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /`seamline check` on this repository failed/);
    assert.match(run.stderr, /exited 3/);
    assert.match(run.stderr, /store is locked/);
  });
});

test('gate: a check that exits 1 without printing a report fails', () => {
  withBaseline((sb) => {
    writeFileSync(join(sb.root, 'not-a-report.txt'), 'Error: unexpected token\n');
    const run = sb.run([], { FAKE_CHECK_STDOUT_FILE: join(sb.root, 'not-a-report.txt') });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /did not print JSON/);
  });
});

test('gate: an extraction with no example nodes is refused rather than baselined as empty', () => {
  withSandbox((sb) => {
    sb.setSif(
      sifText([
        { t: 'sif', version: '1.0.0', runId: 'r' },
        status('extract-code-ts', 'PASS', 'code.ts', { diagnostics: [`${UNREAD}src/b.ts`] }),
        node('seamline:File:src/a.ts', 'File', 'src/a.ts'),
      ]),
    );
    const run = sb.run(['--update']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no nodes from examples\//);
    assert.ok(!existsSync(sb.baselineDir) || readdirSync(sb.baselineDir).length === 0);
  });
});

/** Every baseline file's name and text, to prove a run left the tracked baseline untouched. */
function snapshotBaseline(sb) {
  return Object.fromEntries(
    readdirSync(sb.baselineDir)
      .sort()
      .map((name) => [name, sb.read(name)]),
  );
}

test('gate: the tracked baseline directory stays in place while the extraction runs', () => {
  withBaseline((sb) => {
    const before = snapshotBaseline(sb);
    rmSync(sb.log, { force: true });
    const run = sb.run();
    assert.equal(run.status, 0, run.stderr);
    assert.ok(
      sb.cliCalls().includes('baseline-present=true'),
      `the extractor must see the baseline directory: ${JSON.stringify(sb.cliCalls())}`,
    );
    assert.deepEqual(snapshotBaseline(sb), before);
  });
});

test('gate: a run killed in the middle of the extraction leaves the baseline exactly as it was', () => {
  withBaseline((sb) => {
    const before = snapshotBaseline(sb);
    assert.equal(Object.keys(before).length, 4);
    const run = sb.run([], { FAKE_EXTRACT_KILLS_GATE: '1' });
    assert.equal(run.status, null, 'the gate itself was killed');
    assert.equal(run.signal, 'SIGKILL');
    assert.deepEqual(snapshotBaseline(sb), before, 'no tracked file may be moved or deleted');
    assert.equal(sb.run().status, 0, 'the next run still passes against the same baseline');
  });
});

test('gate: a failed run does not touch the baseline either', () => {
  withBaseline((sb) => {
    const before = snapshotBaseline(sb);
    assert.equal(sb.run([], { FAKE_EXTRACT_EXIT: '3' }).status, 1);
    assert.equal(sb.run([], { FAKE_CHECK_EXIT: '3' }).status, 1);
    assert.deepEqual(snapshotBaseline(sb), before);
  });
});

test('baselineSelfReferences finds nodes extracted from inside the baseline directory', () => {
  const clean = selfExtraction();
  assert.deepEqual(baselineSelfReferences(clean, 'docs/dogfood/baseline'), []);

  const leaking = selfExtraction({
    extraEntries: [
      node('seamline:Contract:Findings', 'Contract', 'docs/dogfood/baseline/findings.json'),
      node(
        'seamline:Contract:Why',
        'Contract',
        'docs/dogfood/baseline/why-orders-customer-email.json',
      ),
      node('seamline:File:docs/dogfood/other.json', 'File', 'docs/dogfood/other.json'),
    ],
  });
  assert.deepEqual(baselineSelfReferences(leaking, 'docs/dogfood/baseline'), [
    'docs/dogfood/baseline/findings.json',
    'docs/dogfood/baseline/why-orders-customer-email.json',
  ]);
});

test('gate: an extractor that starts reading the baseline directory fails the gate', () => {
  withBaseline((sb) => {
    sb.setSif(
      selfExtraction({
        extraEntries: [
          node('seamline:Contract:Findings', 'Contract', 'docs/dogfood/baseline/findings.json'),
        ],
      }),
    );
    const run = sb.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /reads files inside docs\/dogfood\/baseline/);
    assert.match(run.stderr, /docs\/dogfood\/baseline\/findings\.json/);
  });
});

test('the checked-in baseline holds the four reviewed surfaces and not a full self-extraction', () => {
  const dir = resolve(HERE, '..', 'docs', 'dogfood', 'baseline');
  assert.deepEqual(readdirSync(dir).sort(), Object.values(BASELINE_FILES).sort());
});
