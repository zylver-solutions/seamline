import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTRADICTION_CODES, type ContradictionCode } from '@seamline/ontology';
import { allUnknown, detectorOutcomes } from './findings.ts';
import { matchLabels, parseLabels } from './labels.ts';
import { judgeMutant } from './mutants.ts';
import {
  buildReport,
  diagnosticCode,
  diagnosticCodes,
  renderMarkdown,
  reportBody,
  serializeReport,
  type MutantRun,
  type MutantStatus,
  type ReportInput,
  type RepoRun,
} from './report.ts';
import { finding } from './testing.ts';
import type { CorpusEntry, Finding, Mutant, PipelineResult } from './types.ts';

function entry(name: string): CorpusEntry {
  return {
    name,
    url: `https://example.invalid/${name}`,
    sha: 'a'.repeat(40),
    license: 'MIT',
    partition: name === 'beta' ? 'sealed' : 'dev',
    stacks: ['prisma'],
    why: 'fixture',
  };
}

function pipeline(findings: readonly Finding[], unknown: ContradictionCode[] = []): PipelineResult {
  return {
    outcome: 'complete',
    detail: null,
    extractors: [
      {
        name: 'extract-data',
        version: '1',
        status: 'PASS',
        nodes: 5,
        edges: 4,
        scopes: ['data'],
        diagnostics: [],
      },
    ],
    degradedScopes: [],
    nodeCounts: { Column: 3, Table: 2 },
    edgeCounts: { CONTAINS: 4 },
    findings,
    detectors: detectorOutcomes(
      findings,
      new Map(unknown.map((c) => [c, 'scope contracts is FAIL'])),
    ),
    extractMs: 1234,
    checkMs: 56,
  };
}

function mutant(id: string, detector: ContradictionCode): Mutant {
  return {
    id,
    repo: 'alpha',
    detector,
    description: 'fixture mutant',
    edits: [{ path: 'a.ts', append: 'x' }],
    expect: { code: detector },
  };
}

function mutantRun(id: string, detector: ContradictionCode, status: MutantStatus): MutantRun {
  const m = mutant(id, detector);
  const added = finding('alpha', detector, `alpha:Column:${id}`, `alpha:SchemaProperty:${id}`);
  return {
    mutant: m,
    status,
    detail: status === 'detected' || status === 'missed' ? null : `${status} because of a reason`,
    verdict: status === 'detected' ? judgeMutant([], [added], m.expect) : null,
    wallMs: 100,
  };
}

const RUN = {
  startedAt: '2026-01-01T00:00:00.000Z',
  node: 'v22.0.0',
  totalWallMs: 1000,
  reusedBaselines: [],
};

const PROVENANCE = {
  codeId: 'c'.repeat(64),
  scorerDigest: 'e'.repeat(64),
  sealedCorpusDigest: 'a'.repeat(64),
  cli: { path: 'packages/cli/dist/index.js', ownBuild: true, distDigest: 'd'.repeat(64) },
};
const REVIEW_METADATA = { codeId: PROVENANCE.codeId,
  authors: [{ kind: 'agent' as const, account: 'provider:author', model: 'model-a' }] };

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  const x1 = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:a', 'alpha:SchemaProperty:a', 0.9);
  const x1b = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:b', 'alpha:SchemaProperty:b', 0.6);
  const x1c = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:c', 'alpha:SchemaProperty:c', 0.4);
  const x2 = finding('beta', 'X2_TYPE', 'beta:Column:a', 'beta:SchemaProperty:a', 0.95);
  const repos: RepoRun[] = [
    { entry: entry('alpha'), pipeline: pipeline([x1, x1b, x1c]) },
    { entry: entry('beta'), pipeline: pipeline([x2], ['X9_CONTRACT_DRIFT']) },
  ];
  const labels = parseLabels({
    [x1.id]: { verdict: 'tp', rationale: 'r', evidence: ['a.ts:1'], reviewer: 'rev', blind: true },
    [x1b.id]: {
      verdict: 'fp',
      rationale: 'r',
      evidence: ['a.ts:2'],
      reviewer: 'rev',
      blind: false,
    },
    [x2.id]: { verdict: 'tp', rationale: 'r', evidence: ['b.ts:3'], reviewer: 'rev', blind: true },
  });
  return {
    repos,
    mutants: [
      mutantRun('m-x1-a', 'X1_NULLABILITY', 'detected'),
      mutantRun('m-x1-b', 'X1_NULLABILITY', 'missed'),
      mutantRun('m-x5-a', 'X5_UNWRITTEN_COLUMN', 'unknown'),
      mutantRun('m-x8-a', 'X8_ORPHANED_MIGRATION', 'missed'),
      mutantRun('m-x8-b', 'X8_ORPHANED_MIGRATION', 'invalid'),
      mutantRun('m-x3-a', 'X3_CONSTRAINT', 'skipped'),
    ],
    match: matchLabels(
      repos.flatMap((r) => r.pipeline.findings),
      labels,
      true,
    ),
    partial: false,
    run: RUN,
    provenance: PROVENANCE,
    reviewMetadata: REVIEW_METADATA,
    ...overrides,
  };
}

function row(report: ReturnType<typeof buildReport>, code: ContradictionCode) {
  const r = report.detectors.find((d) => d.code === code);
  assert.ok(r !== undefined, code);
  return r;
}

test('per-detector precision counts reviewed findings only; unlabelled ones are excluded', () => {
  const report = buildReport(input());
  const x1 = row(report, 'X1_NULLABILITY');
  assert.deepEqual([x1.findings, x1.tp, x1.fp, x1.unlabelled, x1.precision], [3, 1, 1, 1, 0.5]);
  const x2 = row(report, 'X2_TYPE');
  assert.deepEqual([x2.findings, x2.tp, x2.fp, x2.precision], [1, 1, 0, 1]);
  assert.equal(report.overall.n, 3);
  assert.equal(report.overall.unlabelled, 1);
  assert.ok(Math.abs((report.overall.precision ?? 0) - 2 / 3) < 1e-12);
  assert.equal(report.headline.status, 'incomplete', 'legacy labels have no independent identity evidence');
  assert.equal(report.headline.meetsBar, null);
});

test('a detector with no reviewed finding has precision n/a, not 0 and not 1', () => {
  const report = buildReport(input());
  for (const code of ['X3_CONSTRAINT', 'X4_UNBACKED_PROPERTY', 'X10_UNTESTED_PII_WRITE'] as const) {
    assert.equal(row(report, code).precision, null, code);
  }
});

test('recall counts detected over evaluated mutants; detector-UNKNOWN counts as a miss; invalid and skipped are excluded', () => {
  const report = buildReport(input());
  const x1 = row(report, 'X1_NULLABILITY');
  assert.deepEqual([x1.mutants, x1.detected, x1.recall], [2, 1, 0.5]);
  const x5 = row(report, 'X5_UNWRITTEN_COLUMN');
  assert.deepEqual([x5.mutants, x5.detected, x5.recall], [1, 0, 0], 'recall 0, honestly');
  const x8 = row(report, 'X8_ORPHANED_MIGRATION');
  assert.deepEqual(
    [x8.mutants, x8.detected, x8.recall],
    [1, 0, 0],
    'the invalid mutant is not counted',
  );
  const x3 = row(report, 'X3_CONSTRAINT');
  assert.deepEqual(
    [x3.mutants, x3.recall],
    [0, null],
    'only a skipped mutant: recall is n/a, not 0',
  );
  assert.equal(row(report, 'X2_TYPE').recall, null, 'no mutant at all: n/a');
});

test('fires-on-corpus is about unmodified repositories, and UNKNOWN repositories are listed', () => {
  const report = buildReport(input());
  assert.equal(row(report, 'X1_NULLABILITY').firesOnCorpus, true);
  assert.equal(row(report, 'X6_PII_UNAUTHENTICATED').firesOnCorpus, false);
  assert.deepEqual(row(report, 'X9_CONTRACT_DRIFT').unknownRepos, ['beta']);
  assert.deepEqual(row(report, 'X1_NULLABILITY').unknownRepos, []);
});

test('a detected mutant leaves its detector dormant when the unmodified corpus has no finding', () => {
  const report = buildReport(
    input({
      repos: [{ entry: entry('alpha'), pipeline: pipeline([]) }],
      mutants: [mutantRun('only-mutant', 'X1_NULLABILITY', 'detected')],
      match: matchLabels([], new Map(), false),
    }),
  );
  const x1 = row(report, 'X1_NULLABILITY');
  assert.deepEqual([x1.findings, x1.detected, x1.recall, x1.firesOnCorpus], [0, 1, 1, false]);
  assert.equal(x1.precision, null);
  const md = renderMarkdown(report, { appendix: false, runMeta: false });
  assert.ok(md.includes('| X1_NULLABILITY | 1 | 1 | 0 | 0 | 1.000 n=1 | no | 0/1 |'));
  assert.ok(
    md.includes(
      'Dormant on the measured unmodified corpus (no findings): X1, X2, X3, X4, X5, X6, X7, X8, X9, X10.',
    ),
  );
  assert.ok(
    md.includes(
      'A detected mutant measures recall; it does not establish an unmodified external firing.',
    ),
  );
  assert.ok(!md.includes('fire on real code only by a detected mutant'));
});

test('an unmodified corpus finding establishes firing without a mutant', () => {
  const report = buildReport(input({ mutants: [] }));
  const x1 = row(report, 'X1_NULLABILITY');
  assert.deepEqual([x1.findings, x1.detected, x1.recall, x1.firesOnCorpus], [3, 0, null, true]);
  const md = renderMarkdown(report, { appendix: false, runMeta: false });
  assert.ok(md.includes('| X1_NULLABILITY | 0 | 0 | 0 | 0 | n/a | yes | 0/2 |'));
  assert.ok(
    md.includes(
      'Dormant on the measured unmodified corpus (no findings): X3, X4, X5, X6, X7, X8, X9, X10.',
    ),
  );
});

test('a repository that was not analysed shows UNKNOWN for every detector, never zero', () => {
  const crashed: PipelineResult = {
    ...pipeline([]),
    outcome: 'timeout',
    detail: 'extract exceeded the 1800s timeout',
    extractors: [],
    nodeCounts: {},
    edgeCounts: {},
    detectors: allUnknown('extract exceeded the 1800s timeout'),
  };
  const report = buildReport(
    input({
      repos: [{ entry: entry('alpha'), pipeline: crashed }],
      match: matchLabels([], new Map(), false),
    }),
  );
  const md = renderMarkdown(report);
  assert.match(md, /timeout: extract exceeded the 1800s timeout/);
  assert.match(md, /\| alpha \| UNKNOWN \| UNKNOWN \|/);
  assert.equal(row(report, 'X1_NULLABILITY').unknownRepos.length, 1);
});

test('calibration groups findings by confidence band with observed precision', () => {
  const report = buildReport(input());
  const bands = Object.fromEntries(
    report.calibration.map((c) => [c.band, [c.findings, c.labelled, c.precision]]),
  );
  assert.deepEqual(bands['[0.00, 0.50)'], [1, 0, null]);
  assert.deepEqual(bands['[0.50, 0.70)'], [1, 1, 0]);
  assert.deepEqual(bands['[0.85, 1.00]'], [1, 1, 1]);
});

test('an upstream cannot cross calibration partitions even when both checkouts have no findings', () => {
  const repos: RepoRun[] = [
    { entry: { ...entry('alpha'), url: 'https://github.com/Owner/Project.git' }, pipeline: pipeline([]) },
    { entry: { ...entry('beta'), url: 'https://GITHUB.com/owner/project/' }, pipeline: pipeline([]) },
  ];
  assert.throws(() => buildReport(input({
    repos,
    mutants: [],
    match: matchLabels([], new Map(), false),
  })), /cannot occur in both calibration partitions/);
});

test('fitted zero scores preserve every finding, occurrence, firing state and recall denominator', () => {
  const devNames = ['first', 'second', 'third'];
  const dev = devNames.flatMap((name) => Array.from({ length: 40 }, (_, i) =>
    ({ ...finding(name, 'X1_NULLABILITY', `${name}:Column:${i}`, `${name}:SchemaProperty:${i}`, 0.9), occurrences: 3 }),
  ));
  const sealed = finding('beta', 'X2_TYPE', 'beta:Column:private', 'beta:SchemaProperty:private', 0.9);
  const all = [...dev, sealed];
  const repos: RepoRun[] = [...devNames.map((name) => ({ entry: entry(name), pipeline: pipeline(dev.filter((f) => f.repo === name)) })), { entry: entry('beta'), pipeline: pipeline([sealed]) }];
  const labels = parseLabels(Object.fromEntries(all.map((f) => [f.id, { verdict: f.repo === 'beta' ? 'tp' : 'fp', rationale: 'source checked', evidence: ['model.ts:1'], reviewer: 'reviewer', blind: true }])));
  const report = buildReport(input({ repos, match: matchLabels(all, labels, true) }));
  assert.deepEqual(report.findings.map((f) => f.id).sort(), all.map((f) => f.id).sort());
  assert.ok(report.findings.every((f) => f.confidence === 0.9 && f.calibratedConfidence === 0));
  assert.equal(report.findings.filter((f) => f.occurrences === 3).length, 120);
  assert.equal(report.overall.findings, 121);
  assert.equal(report.overall.n, 121);
  assert.equal(row(report, 'X1_NULLABILITY').firesOnCorpus, true);
  assert.equal(row(report, 'X1_NULLABILITY').findings, 120);
  assert.equal(row(report, 'X1_NULLABILITY').mutants, 2);
  assert.equal(row(report, 'X1_NULLABILITY').recall, 0.5);
  assert.equal(report.overall.mutants, 4);
  assert.equal(report.overall.clusteredStrict.n, 121);
  assert.equal(report.confidenceFit.sealedCheck.calibratedBrier, 1);
  assert.ok(!serializeReport(report).includes('beta:Column:private'));
});

test('the report body is identical across runs; only the run metadata differs', () => {
  const first = buildReport(input());
  const second = buildReport(
    input({
      run: {
        startedAt: '2027-06-06T06:06:06.000Z',
        node: 'v24.0.0',
        totalWallMs: 999999,
        reusedBaselines: ['alpha'],
      },
    }),
  );
  assert.deepEqual(reportBody(first), reportBody(second));
  assert.notDeepEqual(first.run, second.run);
  const options = { appendix: true, runMeta: false };
  assert.equal(renderMarkdown(first, options), renderMarkdown(second, options));
  assert.ok(!renderMarkdown(first, options).includes('2026-01-01'), 'no timestamp in the body');
});

test('the report names what it measured, in its body, so a different measurement is a different report', () => {
  const frozen = { state: 'frozen', sha: 'f'.repeat(40), changed: [] } as const;
  const report = buildReport(input({ freeze: frozen }));
  assert.equal(report.schema, 8);
  assert.deepEqual(report.provenance, PROVENANCE);
  assert.equal(report.freeze.sha, 'f'.repeat(40));
  const md = renderMarkdown(report, { appendix: false, runMeta: false });
  for (const text of [
    'f'.repeat(40),
    PROVENANCE.codeId,
    PROVENANCE.scorerDigest,
    PROVENANCE.sealedCorpusDigest,
    PROVENANCE.cli.distDigest,
    PROVENANCE.cli.path,
    "this repository's own build",
  ]) {
    assert.ok(md.includes(text), `the markdown body names ${text}`);
  }

  const scored = buildReport(
    input({ freeze: frozen, provenance: { ...PROVENANCE, scorerDigest: '0'.repeat(64) } }),
  );
  assert.notDeepEqual(reportBody(scored), reportBody(report), 'other scoring code, other report');
  assert.notEqual(renderMarkdown(scored), renderMarkdown(report));

  const elsewhere = buildReport(
    input({
      provenance: {
        ...PROVENANCE,
        cli: { path: '/tmp/cli.js', ownBuild: false, distDigest: '1'.repeat(64) },
      },
    }),
  );
  assert.ok(
    renderMarkdown(elsewhere, { appendix: false, runMeta: false }).includes(
      "not this repository's build; digest of that file alone",
    ),
  );
});

test('the report does not depend on the order its inputs arrive in', () => {
  const a = input();
  const b = input({
    repos: a.repos.slice().reverse(),
    mutants: a.mutants.slice().reverse(),
  });
  assert.equal(serializeReport(buildReport(a)), serializeReport(buildReport(b)));
  assert.equal(renderMarkdown(buildReport(a)), renderMarkdown(buildReport(b)));
});

test('wall-clock durations appear only under run metadata', () => {
  const report = buildReport(input());
  const body = JSON.stringify(reportBody(report));
  assert.ok(!body.includes('1234'), 'extract milliseconds must not leak into the body');
  assert.equal(report.run.repoWallMs['alpha']?.extractMs, 1234);
  assert.equal(report.run.mutantWallMs['m-x1-a'], 100);
});

test('serializeReport sorts keys at every level and ends with a newline', () => {
  const text = serializeReport(buildReport(input()));
  assert.ok(text.endsWith('}\n'));
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), Object.keys(parsed).slice().sort());
});

test('every detector in the catalog has a row, in catalog order', () => {
  const report = buildReport(input());
  assert.deepEqual(
    report.detectors.map((d) => d.code),
    [...CONTRADICTION_CODES],
  );
});

test('the markdown table gives each precision with its Wilson interval and n, and recall with n', () => {
  const md = renderMarkdown(buildReport(input()), { appendix: false, runMeta: false });
  assert.ok(
    md.includes(
      '| X1_NULLABILITY | 3 | 1 | 1 | 0 | 1 | 0.500 [0.095, 0.905] n=2 | 0.500 [0.095, 0.905] n=2 | 0.500 [0.095, 0.905] n=2 | 0.500 [0.095, 0.905] n=2 | unmeasured (0 of 5 sealed clusters) |',
    ),
    'lenient and strict precision with interval and n, raw and clustered',
  );
  assert.ok(
    md.includes(
      '| X3_CONSTRAINT | 0 | 0 | 0 | 0 | 0 | n/a (n=0) | n/a (n=0) | n/a (n=0) | n/a (n=0) | unmeasured (0 of 5 sealed clusters) |',
    ),
    'undefined ratios print as n/a, never 0',
  );
  assert.ok(
    md.includes('| X1_NULLABILITY | 2 | 1 | 1 | 0 | 0.500 n=2 | yes | 0/2 |'),
    'recall with n, and how many of the misses were UNKNOWN',
  );
  assert.ok(
    md.includes('| X8_ORPHANED_MIGRATION | 1 | 0 | 1 | 0 | 0.000 n=1 | no | 0/2 |'),
    'recall 0 of 1 that ran and missed prints as 0.000 with its n, not n/a',
  );
  assert.ok(
    md.includes('| X5_UNWRITTEN_COLUMN | 1 | 0 | 1 | 1 | 0.000 n=1 | no | 0/2 |'),
    'a mutant whose detector was UNKNOWN is a miss, and is separated from one that ran',
  );
});

test('the recall table separates a detector that ran and missed from one that could not run', () => {
  const report = buildReport(input());
  const x5 = row(report, 'X5_UNWRITTEN_COLUMN');
  const x8 = row(report, 'X8_ORPHANED_MIGRATION');
  assert.deepEqual([x5.mutants, x5.detected, x5.unknownMutants, x5.recall], [1, 0, 1, 0]);
  assert.deepEqual([x8.mutants, x8.detected, x8.unknownMutants, x8.recall], [1, 0, 0, 0]);
  assert.match(renderMarkdown(report, { appendix: false, runMeta: false }), /of which UNKNOWN/);
});

test('the headline is underpowered until the sealed partition has 30 clustered labelled findings', () => {
  const { found, labels } = thirtyTruePositives();
  const subset = found.slice(0, 10);
  const report = buildReport(input({ repos: [{ entry: sealedEntry('s1'), pipeline: pipeline(subset) }],
    match: matchLabels(subset, labels, false), mutants: [] }));
  assert.equal(report.review.overall.ready, true, 'ten fully double-reviewed clusters meet the review sample');
  assert.equal(report.headline.status, 'underpowered');
  assert.equal(
    report.headline.strict.n,
    10,
    'independent review does not replace the thirty-cluster precision requirement',
  );
  const md = renderMarkdown(report, { appendix: false, runMeta: false });
  assert.match(md, /\*\*Headline: underpowered\.\*\*/);
  assert.ok(!md.includes('Headline (sealed partition'), 'no headline number is claimed');
});

test('partitions report dev and sealed separately, each raw and clustered', () => {
  const report = buildReport(input());
  const dev = report.partitions.find((p) => p.partition === 'dev');
  const sealed = report.partitions.find((p) => p.partition === 'sealed');
  assert.deepEqual(
    [dev?.repos, dev?.findings, dev?.tp, dev?.fp, dev?.unlabelled],
    [['alpha'], 3, 1, 1, 1],
  );
  assert.deepEqual([sealed?.repos, sealed?.findings, sealed?.tp, sealed?.fp], [['beta'], 1, 1, 0]);
});

test('clusters count once in the clustered figures and every member counts in the raw figures', () => {
  const a = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:a', 'alpha:SchemaProperty:a');
  const b = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:b', 'alpha:SchemaProperty:b');
  const c = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:c', 'alpha:SchemaProperty:c');
  const d = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:d', 'alpha:SchemaProperty:d');
  const label = (verdict: string, cluster?: string) => ({
    verdict,
    ...(cluster === undefined ? {} : { cluster }),
    rationale: 'r',
    evidence: ['a.ts:1'],
    reviewer: 'rev',
    blind: true,
  });
  const labels = parseLabels({
    [a.id]: label('tp', 'same-bug'),
    [b.id]: label('tp', 'same-bug'),
    [c.id]: label('fp'),
    [d.id]: label('unclear'),
  });
  const repos: RepoRun[] = [{ entry: entry('alpha'), pipeline: pipeline([a, b, c, d]) }];
  const report = buildReport(
    input({ repos, mutants: [], match: matchLabels([a, b, c, d], labels, true) }),
  );
  const x1 = row(report, 'X1_NULLABILITY');
  assert.deepEqual([x1.findings, x1.tp, x1.fp, x1.unclear, x1.n], [4, 2, 1, 1, 3]);
  assert.ok(Math.abs((x1.precision ?? 0) - 2 / 3) < 1e-12);
  assert.deepEqual(
    [x1.clustered.tp, x1.clustered.fp, x1.clustered.unclear, x1.clustered.n],
    [1, 1, 1, 2],
  );
  assert.equal(x1.clustered.precision, 0.5);
  assert.deepEqual([report.overall.n, report.overall.clustered.n], [3, 2]);
  const band = report.calibration.find((c) => c.band === '[0.85, 1.00]');
  const fittedBand = report.confidenceFit.model.find((c) => c.band === '[0.85, 1.00]');
  assert.deepEqual([band?.findings, band?.labelled, band?.unclear], [4, 3, 1], 'reliability bands retain every raw finding');
  assert.deepEqual([fittedBand?.findings, fittedBand?.labelled, fittedBand?.unclear], [4, 3, 1], 'confidence fitting retains every raw finding');
  assert.equal(report.overall.clusteredStrict.n, 3, 'the same four raw findings form three strict clusters');
  const md = renderMarkdown(report, { appendix: false, runMeta: false });
  assert.match(md, /lenient \(unclear excluded\): 0\.667 \[0\.208, 0\.939\] n=3;/);
  assert.match(md, /lenient 0\.500 \[0\.095, 0\.905\] n=2; strict 0\.333 \[0\.061, 0\.792\] n=3/);
  assert.match(md, /1 unclear/);
});

test('unclear findings are counted and shown but never enter precision, calibration ratios, or n', () => {
  const x1 = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:a', 'alpha:SchemaProperty:a', 0.9);
  const labels = parseLabels({
    [x1.id]: {
      verdict: 'unclear',
      rationale: 'r',
      evidence: ['a.ts:1'],
      reviewer: 'rev',
      blind: true,
    },
  });
  const repos: RepoRun[] = [{ entry: entry('alpha'), pipeline: pipeline([x1]) }];
  const report = buildReport(input({ repos, mutants: [], match: matchLabels([x1], labels, true) }));
  const row1 = row(report, 'X1_NULLABILITY');
  assert.deepEqual([row1.unclear, row1.n, row1.precision, row1.interval], [1, 0, null, null]);
  const band = report.calibration.find((c) => c.band === '[0.85, 1.00]');
  assert.deepEqual(
    [band?.findings, band?.unclear, band?.labelled, band?.precision],
    [1, 1, 0, null],
  );
});

test('sealed findings are reported as counts: no subjects, claim, or facts in the markdown or the JSON', () => {
  const report = buildReport(input());
  const md = renderMarkdown(report);
  assert.ok(!md.includes('beta:Column:a'), 'sealed subjects must not appear in the markdown');
  assert.match(md, /Sealed partition: 1 finding\(s\), not listed\./);
  assert.ok(md.includes('alpha:Column:a'), 'dev findings are listed');
  const sealedEntry = report.findings.find((f) => f.repo === 'beta');
  // The fields the module comment and eval/README.md promise, and no others.
  assert.deepEqual(Object.keys(sealedEntry ?? {}).sort(), [
    'calibratedConfidence',
    'code',
    'confidence',
    'id',
    'occurrences',
    'partition',
    'repo',
    'severity',
    'verdict',
  ]);
  assert.ok(!serializeReport(report).includes('beta:Column:a'));
});

function labelledSealed(cluster: string | undefined, secret: string) {
  const a = finding('beta', 'X2_TYPE', `beta:Column:${secret}`, 'beta:SchemaProperty:a');
  const labels = parseLabels({
    [a.id]: {
      verdict: 'tp',
      ...(cluster === undefined ? {} : { cluster }),
      rationale: 'r',
      evidence: ['b.ts:3'],
      reviewer: 'rev',
      blind: true,
    },
  });
  const repos: RepoRun[] = [{ entry: entry('beta'), pipeline: pipeline([a]) }];
  return input({ repos, mutants: [], match: matchLabels([a], labels, true, new Set(['beta'])) });
}

test('the reviewer cluster name of a sealed finding is in neither report.json nor report.md', () => {
  const report = buildReport(labelledSealed('secret-cluster-name', 'SECRETCOLUMN'));
  assert.ok(!serializeReport(report).includes('secret-cluster-name'));
  assert.ok(!renderMarkdown(report).includes('secret-cluster-name'));
  assert.equal(report.findings[0]?.cluster, undefined);
  // It still counts: the cluster is folded into the clustered figures.
  assert.equal(report.partitions.find((p) => p.partition === 'sealed')?.clusteredStrict.tp, 1);
});

test('a dev finding keeps its cluster name in the report', () => {
  const a = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:a', 'alpha:SchemaProperty:a');
  const labels = parseLabels({
    [a.id]: {
      verdict: 'tp',
      cluster: 'dev-cluster',
      rationale: 'r',
      evidence: ['a.ts:1'],
      reviewer: 'rev',
      blind: false,
    },
  });
  const repos: RepoRun[] = [{ entry: entry('alpha'), pipeline: pipeline([a]) }];
  const report = buildReport(input({ repos, mutants: [], match: matchLabels([a], labels, true) }));
  assert.equal(report.findings[0]?.cluster, 'dev-cluster');
});

function withDiagnostics(name: string, diagnostics: string[]): RepoRun {
  const base = pipeline([]);
  return {
    entry: entry(name),
    pipeline: {
      ...base,
      extractors: [
        {
          name: 'extract-contracts',
          version: '1',
          status: 'FAIL',
          nodes: 0,
          edges: 0,
          scopes: ['contracts'],
          diagnostics,
        },
      ],
      degradedScopes: ['contracts'],
    },
  };
}

test('a sealed repository shows an extractor diagnostic as its code only, in the markdown and the JSON', () => {
  const messages = [
    'CONTRACT_NAME_COLLISION: SECRETCONTRACT also declared in packages/secret/path.ts',
    'no tsconfig.json at apps/secret/tsconfig.json',
  ];
  const report = buildReport(
    input({
      repos: [withDiagnostics('alpha', messages), withDiagnostics('beta', messages)],
      mutants: [],
      match: matchLabels([], new Map(), false),
    }),
  );
  const json = serializeReport(report);
  const md = renderMarkdown(report);
  const beta = report.repos.find((r) => r.name === 'beta');
  assert.deepEqual(beta?.extractors[0]?.diagnostics, ['(unclassified)', 'CONTRACT_NAME_COLLISION']);
  assert.match(
    md,
    /- beta \/ extract-contracts \(FAIL\): \(unclassified\), CONTRACT_NAME_COLLISION/,
  );
  // The dev repository keeps its full diagnostic; the sealed one leaks neither name nor path.
  assert.match(
    md,
    /- alpha \/ extract-contracts \(FAIL\): CONTRACT_NAME_COLLISION: SECRETCONTRACT/,
  );
  assert.equal(json.split('SECRETCONTRACT').length - 1, 1, 'only the dev repository mentions it');
  assert.equal(
    json.split('packages/secret/path.ts').length - 1,
    1,
    'the sealed path is not in the JSON',
  );
  assert.equal(md.split('apps/secret/tsconfig.json').length - 1, 0);
});

test('diagnosticCode is an allow-list: only an upper-case identifier before the first colon is a code', () => {
  assert.equal(
    diagnosticCode('CONTRACT_NAME_COLLISION: x also declared in y'),
    'CONTRACT_NAME_COLLISION',
  );
  assert.equal(
    diagnosticCode('ZOD_UNSUPPORTED_EXPRESSION: a/b.ts contract c'),
    'ZOD_UNSUPPORTED_EXPRESSION',
  );
  assert.equal(diagnosticCode('FK_TO2: x'), 'FK_TO2');
  // Heads a shape test would let through, and a future message could put a name in.
  for (const head of [
    'SecretIdentifierHead',
    'export resolution failed for Makefile',
    'tsconfig coverage',
    'Zod_Unsupported',
    'ALL CAPS WITH SPACES',
    'A',
    '1ABC',
    'packages/secret/path.ts',
    'SECRET.NAME',
  ]) {
    assert.equal(diagnosticCode(`${head}: detail`), '(unclassified)', head);
  }
  assert.equal(diagnosticCode('no tsconfig.json at tsconfig.json'), '(unclassified)');
  assert.equal(diagnosticCode('CODE_WITHOUT_A_COLON'), '(unclassified)', 'no colon: all detail');
  assert.equal(diagnosticCode(': leading colon'), '(unclassified)');
  assert.deepEqual(diagnosticCodes(['B_X: 1', 'A_X: 2', 'B_X: 3']), ['A_X', 'B_X']);
});

test('a sealed repository shows a detector UNKNOWN reason as an allow-listed code or (unclassified)', () => {
  const unknownWith = (name: string, reason: string): RepoRun => ({
    entry: entry(name),
    pipeline: {
      ...pipeline([]),
      detectors: {
        ...pipeline([]).detectors,
        X1_NULLABILITY: { state: 'unknown', findings: 0, reason },
        // The shape the contradictions runner produces (packages/contradictions/src/runner.ts).
        X2_TYPE: {
          state: 'unknown',
          findings: 0,
          reason:
            'SCOPE_NOT_PASS: scope(s) not PASS: contracts=FAIL; UNKNOWN rather than a finding (v3 section 2.2)',
        },
      },
    },
  });
  const reason = 'scope(s) not PASS: SECRETSCOPE=FAIL in packages/secret/path.ts';
  const report = buildReport(
    input({
      repos: [unknownWith('alpha', reason), unknownWith('beta', reason)],
      mutants: [],
      match: matchLabels([], new Map(), false),
    }),
  );
  const alpha = report.repos.find((r) => r.name === 'alpha');
  const beta = report.repos.find((r) => r.name === 'beta');
  assert.equal(
    alpha?.detectors['X1_NULLABILITY'].reason,
    reason,
    'a dev repository keeps the reason',
  );
  assert.equal(beta?.detectors['X1_NULLABILITY'].reason, '(unclassified)');
  assert.equal(beta?.detectors['X2_TYPE'].reason, 'SCOPE_NOT_PASS');
  const json = serializeReport(report);
  assert.equal(json.split('SECRETSCOPE').length - 1, 1, 'only the dev repository mentions it');
  assert.ok(!renderMarkdown(report).includes('SECRETSCOPE'));
});

test('the cause of a crash in a sealed repository is reduced to the outcome', () => {
  const crashed = (name: string): RepoRun => ({
    entry: entry(name),
    pipeline: {
      ...pipeline([]),
      outcome: 'crashed',
      detail: 'extract failed (exit 3: cannot read /srv/secret/path.ts)',
      detectors: allUnknown('extract failed (exit 3: cannot read /srv/secret/path.ts)'),
    },
  });
  const report = buildReport(
    input({
      repos: [crashed('alpha'), crashed('beta')],
      mutants: [],
      match: matchLabels([], new Map(), false),
    }),
  );
  const beta = report.repos.find((r) => r.name === 'beta');
  assert.equal(beta?.detail, 'crashed');
  assert.equal(beta?.detectors['X1_NULLABILITY'].reason, undefined);
  assert.match(report.repos.find((r) => r.name === 'alpha')?.detail ?? '', /secret/);
  assert.equal(renderMarkdown(report).split('/srv/secret/path.ts').length - 1, 1, 'only alpha');
});

test('the headline is incomplete while a sealed finding is unlabelled, and burned after a change', () => {
  const a = finding('beta', 'X2_TYPE', 'beta:Column:a', 'beta:SchemaProperty:a');
  const repos: RepoRun[] = [{ entry: entry('beta'), pipeline: pipeline([a]) }];
  const incomplete = buildReport(
    input({ repos, mutants: [], match: matchLabels([a], new Map(), true) }),
  );
  assert.equal(incomplete.headline.status, 'incomplete');
  assert.match(
    renderMarkdown(incomplete),
    /\*\*Headline: incomplete\.\*\* 1 sealed finding\(s\) have no label/,
  );
  const burned = buildReport(
    input({
      repos,
      mutants: [],
      match: matchLabels([a], new Map(), true),
      freeze: {
        state: 'burned',
        sha: 'f'.repeat(40),
        changed: ['packages/contradictions/src/x1.ts'],
      },
    }),
  );
  assert.equal(burned.headline.status, 'burned');
  assert.match(renderMarkdown(burned), /\*\*Headline: withheld, the sealed partition is burned\./);
});

test('the strict reading is reported beside the lenient one, and the bar is read on the strict', () => {
  const report = buildReport(input());
  const x1 = row(report, 'X1_NULLABILITY');
  assert.deepEqual([x1.n, x1.strict.n], [2, 2], 'no unclear: the readings agree');
  const a = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:a', 'alpha:SchemaProperty:a');
  const b = finding('alpha', 'X1_NULLABILITY', 'alpha:Column:b', 'alpha:SchemaProperty:b');
  const labels = parseLabels({
    [a.id]: { verdict: 'tp', rationale: 'r', evidence: ['a.ts:1'], reviewer: 'rev', blind: true },
    [b.id]: {
      verdict: 'unclear',
      rationale: 'r',
      evidence: ['a.ts:2'],
      reviewer: 'rev',
      blind: true,
    },
  });
  const repos: RepoRun[] = [{ entry: entry('alpha'), pipeline: pipeline([a, b]) }];
  const split = buildReport(
    input({ repos, mutants: [], match: matchLabels([a, b], labels, true) }),
  );
  const d = row(split, 'X1_NULLABILITY');
  assert.deepEqual([d.precision, d.n], [1, 1], 'lenient leaves unclear out');
  assert.deepEqual(
    [d.strict.precision, d.strict.n],
    [0.5, 2],
    'strict keeps it in the denominator',
  );
  const md = renderMarkdown(split, { appendix: false, runMeta: false });
  assert.match(md, /lenient \(unclear excluded\)/);
  assert.match(md, /strict \(unclear is not a true positive\)/);
});

test('a detector with at least five labelled sealed clusters is read against 0.80; fewer is unmeasured', () => {
  const many = Array.from({ length: 6 }, (_, i) =>
    finding('beta', 'X2_TYPE', `beta:Column:c${i}`, `beta:SchemaProperty:c${i}`),
  );
  const labelFor = (i: number) => ({
    verdict: i < 3 ? 'tp' : 'fp',
    rationale: 'r',
    evidence: ['b.ts:1'],
    reviewer: 'rev',
    blind: true,
  });
  const labels = parseLabels(Object.fromEntries(many.map((f, i) => [f.id, labelFor(i)])));
  const repos: RepoRun[] = [{ entry: entry('beta'), pipeline: pipeline(many) }];
  const report = buildReport(input({ repos, mutants: [], match: matchLabels(many, labels, true) }));
  assert.deepEqual(
    [row(report, 'X2_TYPE').status, row(report, 'X2_TYPE').sealedClusters],
    ['below', 6],
  );
  assert.equal(row(report, 'X1_NULLABILITY').status, 'unmeasured');
});

function sealedEntry(name: string): CorpusEntry {
  return { ...entry(name), partition: 'sealed' };
}

/** Thirty labelled true positives in sealed repository `s1`: a powered, passing sealed figure. */
function thirtyTruePositives() {
  const found = Array.from({ length: 30 }, (_, i) =>
    finding('s1', 'X2_TYPE', `s1:Column:c${i}`, `s1:SchemaProperty:c${i}`),
  );
  const labels = parseLabels(
    Object.fromEntries(
      found.map((f, i) => [
        f.id,
        { verdict: 'tp', rationale: 'r', evidence: ['b.ts:1'], reviewer: 'provider:first', blind: true,
          identity: { kind: 'agent', account: 'provider:first', model: 'model-a' },
          reviews: i < 10 ? [{ verdict: 'tp', rationale: 'independent synthetic source check', evidence: ['b.ts:1'],
            blind: true, identity: { kind: 'agent', account: 'provider:second', model: 'model-b' } }] : [] },
      ]),
    ),
  );
  return { found, labels };
}

test('the control: 30 labelled true positives over fully analysed sealed repositories read as powered and met', () => {
  const { found, labels } = thirtyTruePositives();
  const repos: RepoRun[] = [
    { entry: sealedEntry('s1'), pipeline: pipeline(found) },
    { entry: sealedEntry('s2'), pipeline: pipeline([]) },
  ];
  const report = buildReport(
    input({ repos, mutants: [], match: matchLabels(found, labels, true, new Set(['s1', 's2'])) }),
  );
  assert.deepEqual([report.headline.status, report.headline.meetsBar], ['powered', true]);
  const md = renderMarkdown(report);
  assert.match(md, /Release bar .*: met\./);
  // Thirty true positives from one detector: the bar reads as met, and the headline line itself
  // says that the other nine detectors were not measured, so it cannot be quoted without that.
  assert.match(md, /: met\. 9 of 10 detectors unmeasured\./);
  assert.equal(report.detectors.filter((d) => d.status === 'unmeasured').length, 9);
});

test('the headline is incomplete, with no met or not met, when a sealed repository was not analysed', () => {
  const { found, labels } = thirtyTruePositives();
  const crashed: PipelineResult = {
    ...pipeline([]),
    outcome: 'crashed',
    detail: 'extract failed',
    extractors: [],
    nodeCounts: {},
    edgeCounts: {},
    detectors: allUnknown('extract failed'),
  };
  for (const outcome of ['crashed', 'timeout'] as const) {
    const repos: RepoRun[] = [
      { entry: sealedEntry('s1'), pipeline: pipeline(found) },
      { entry: sealedEntry('s2'), pipeline: { ...crashed, outcome } },
    ];
    const report = buildReport(
      input({
        repos,
        mutants: [],
        match: matchLabels(found, labels, false, new Set(['s1', 's2'])),
      }),
    );
    assert.equal(report.headline.status, 'incomplete', outcome);
    assert.equal(
      report.headline.meetsBar,
      null,
      'no met or not met over a partly unknown sealed partition',
    );
    assert.deepEqual(report.headline.unanalysed, ['s2']);
    const md = renderMarkdown(report);
    assert.match(
      md,
      /\*\*Headline: incomplete\.\*\* the analysis of sealed repository s2 did not complete/,
    );
    assert.ok(
      !/Release bar .*: (not )?met\./.test(md),
      'the markdown must not claim the bar either way',
    );
  }
});

test('an unanalysed dev repository does not make the sealed headline incomplete', () => {
  const { found, labels } = thirtyTruePositives();
  const crashed: PipelineResult = {
    ...pipeline([]),
    outcome: 'timeout',
    detail: 'extract exceeded the timeout',
    extractors: [],
    detectors: allUnknown('timeout'),
  };
  const repos: RepoRun[] = [
    { entry: sealedEntry('s1'), pipeline: pipeline(found) },
    { entry: entry('alpha'), pipeline: crashed },
  ];
  const report = buildReport(
    input({ repos, mutants: [], match: matchLabels(found, labels, false, new Set(['s1'])) }),
  );
  assert.deepEqual([report.headline.status, report.headline.meetsBar], ['powered', true]);
});

test('the headline is incomplete, with no met or not met, on a partial run', () => {
  const { found, labels } = thirtyTruePositives();
  const repos: RepoRun[] = [{ entry: sealedEntry('s1'), pipeline: pipeline(found) }];
  const report = buildReport(
    input({
      repos,
      mutants: [],
      partial: true,
      match: matchLabels(found, labels, false, new Set(['s1'])),
    }),
  );
  assert.equal(report.headline.status, 'incomplete');
  assert.equal(report.headline.meetsBar, null);
  assert.equal(report.headline.partial, true);
  const md = renderMarkdown(report);
  assert.match(md, /\*\*Headline: incomplete\.\*\* this was a partial run/);
  assert.ok(!/Release bar .*: (not )?met\./.test(md));
});

test('thirty duplicate-endpoint sealed findings cannot manufacture thirty release clusters', () => {
  const found = Array.from({ length: 30 }, (_, i) => finding('s1', 'X2_TYPE', 's1:Column:one', `s1:SchemaProperty:p${i}`));
  const labels = parseLabels(Object.fromEntries(found.map((f) => [f.id, { verdict: 'tp', rationale: 'r', evidence: ['a.sql:1'], reviewer: 'rev', blind: true }])));
  const repos: RepoRun[] = [{ entry: sealedEntry('s1'), pipeline: pipeline(found) }];
  const report = buildReport(input({ repos, mutants: [], match: matchLabels(found, labels, true, new Set(['s1'])) }));
  assert.equal(report.overall.n, 30, 'raw findings remain visible');
  assert.equal(report.overall.clusteredStrict.n, 1);
  assert.deepEqual([report.confidenceFit.sealedCheck.findings, report.confidenceFit.sealedCheck.labelled], [30, 30], 'sealed calibration checks retain all raw findings');
  assert.equal(report.headline.status, 'incomplete', 'legacy identity evidence is also incomplete');
  assert.equal(report.headline.strict.n, 1, 'the numeric headline still counts only one root cause');
  assert.notEqual(report.headline.meetsBar, true);
  assert.equal(row(report, 'X2_TYPE').sealedClusters, 1);
  assert.doesNotMatch(serializeReport(report), /auto:/, 'sealed component identities are withheld');
});
