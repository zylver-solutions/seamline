import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ALL_PASS,
  COMMIT,
  REPO,
  asBaseline,
  caseFiles,
  factsFor,
  run,
  runCase,
  withResult,
  type Ran,
} from './__fixtures__/build.ts';
import { evaluate } from './engine.ts';
import type { FactsRun } from './facts.ts';
import { memTree } from './tree.ts';
import { sha256Hex } from './util.ts';

const pairs = (ran: Ran): string[] =>
  ran.findings.map((f) => `${f.class}|${f.id.slice('fx:align:'.length)}`);
const DRIFT = [
  'Observed drift|RUNTIME_FLOOR:runtime:node',
  'Unexplained gap|DETECTOR_LIVENESS:detector:X3',
  'Unexplained gap|OUTPUT_FORMAT_SET:cli:output-format:csv',
  'Unexplained gap|OUTPUT_FORMAT_SET:cli:output-format:mermaid',
  'Unknown|CONTROL_ENFORCEMENT:control:C1',
];

const aligned = (): Ran =>
  runCase({
    formats: 'Output is text and JSON from the CLI.',
    floor: '20.3',
    wired: true,
    x3Kind: 'Column',
  });
const planned = (): Ran =>
  runCase({
    formats: 'CSV and Mermaid output are planned.',
    floor: '20.3',
    wired: true,
    extraReadme: 'X3 does not fire yet.',
  });
const failedBase = { rootBroken: true } as const;
const failedA = (): Ran =>
  runCase({
    ...failedBase,
    results: withResult(ALL_PASS, 'extract-code-ts', (r) => ({
      ...r,
      status: 'FAIL' as const,
      authoritative: [],
    })),
  });
const failedB = (): Ran =>
  runCase({
    ...failedBase,
    results: withResult(ALL_PASS, 'extract-data', (r) => ({
      ...r,
      status: 'UNAVAILABLE' as const,
      authoritative: [],
    })),
  });
const failedC = (): Ran =>
  runCase({
    ...failedBase,
    results: withResult(ALL_PASS, 'extract-code-ts', (r) => ({ ...r, status: 'FAIL' as const })),
  });

describe('12.2 controls: four cases that differ from each other and from the drift case', () => {
  test('Drift: an Observed drift, three Unexplained gaps and one Unknown record; json aligned', () => {
    const ran = runCase();
    assert.deepEqual(pairs(ran), DRIFT);
    assert.equal(ran.find('runtime:node')?.reason, 'value-mismatch');
    assert.equal(ran.find('control:C1')?.reason, 'no-static-consumer');
    assert.equal(ran.packet.summary.claims, 8);
    assert.equal(ran.packet.summary.aligned, 3);
    assert.deepEqual(ran.packet.summary.classes, {
      'Observed drift': 1,
      'Unexplained gap': 3,
      'Planned gap': 0,
      Unknown: 1,
      Resolved: 0,
    });
  });

  test('Aligned: no findings, and summary.aligned equals the 7 aligned subjects (here also the 7 claims)', () => {
    const ran = aligned();
    assert.deepEqual(pairs(ran), []);
    assert.equal(ran.packet.summary.aligned, 7);
    assert.equal(ran.packet.summary.claims, 7);
    assert.equal(ran.packet.summary.classes.Resolved, 0);
  });

  test('Planned gap: csv, mermaid and detector:X3 are Planned gaps, with no drift and no Unexplained gap', () => {
    const ran = planned();
    assert.deepEqual(pairs(ran), [
      'Planned gap|DETECTOR_LIVENESS:detector:X3',
      'Planned gap|OUTPUT_FORMAT_SET:cli:output-format:csv',
      'Planned gap|OUTPUT_FORMAT_SET:cli:output-format:mermaid',
    ]);
    assert.equal(ran.find('detector:X3')?.claims.length, 2);
    assert.deepEqual(
      ran
        .find('detector:X3')
        ?.claims.map((c) => c.polarity)
        .sort(),
      ['AFFIRM', 'DEFERRED'],
    );
  });

  test('Failed extraction (a): the code.ts result is FAIL with authoritative [], as failed() records it', () => {
    const ran = failedA();
    assert.ok(ran.findings.every((f) => f.class === 'Unknown'));
    const reasons = Object.fromEntries(
      ran.findings.map((f) => [f.id.slice('fx:align:'.length), f.reason]),
    );
    assert.deepEqual(reasons, {
      'CONTROL_ENFORCEMENT:control:C1': 'scope-not-pass',
      'DETECTOR_LIVENESS:detector:X1': 'scope-not-pass',
      'DETECTOR_LIVENESS:detector:X2': 'scope-not-pass',
      'DETECTOR_LIVENESS:detector:X3': 'scope-not-pass',
      'OUTPUT_FORMAT_SET:cli:output-format:csv': 'scope-not-pass',
      'OUTPUT_FORMAT_SET:cli:output-format:json': 'scope-not-pass',
      'OUTPUT_FORMAT_SET:cli:output-format:mermaid': 'scope-not-pass',
      'RUNTIME_FLOOR:runtime:node': 'manifest-unparseable',
    });
  });

  test('Failed extraction (b): extract-data UNAVAILABLE with no scopes; X2 and json stay aligned, the rest need discovery and say manifest-unparseable', () => {
    const ran = failedB();
    assert.ok(ran.findings.every((f) => f.class === 'Unknown'));
    const reasons = Object.fromEntries(
      ran.findings.map((f) => [f.id.slice('fx:align:'.length), f.reason]),
    );
    assert.deepEqual(reasons, {
      'CONTROL_ENFORCEMENT:control:C1': 'manifest-unparseable',
      'DETECTOR_LIVENESS:detector:X1': 'scope-not-pass',
      'DETECTOR_LIVENESS:detector:X3': 'scope-not-pass',
      'OUTPUT_FORMAT_SET:cli:output-format:csv': 'manifest-unparseable',
      'OUTPUT_FORMAT_SET:cli:output-format:mermaid': 'manifest-unparseable',
      'RUNTIME_FLOOR:runtime:node': 'manifest-unparseable',
    });
  });

  test('Failed extraction (c): code.ts FAIL with its scopes kept, as refused() records it; detail says FAIL', () => {
    const ran = failedC();
    assert.ok(ran.findings.every((f) => f.class === 'Unknown'));
    assert.match(ran.find('detector:X1')?.unknown?.detail ?? '', /code\.ts: FAIL/);
    assert.deepEqual(
      new Set(ran.findings.map((f) => f.reason)),
      new Set(['scope-not-pass', 'manifest-unparseable']),
    );
  });

  test('the four cases are pairwise different in their set of (id, class) pairs', () => {
    const sets = [runCase(), aligned(), planned(), failedA()].map((r) => JSON.stringify(pairs(r)));
    assert.equal(new Set(sets).size, 4);
    assert.equal(
      new Set([failedA(), failedB(), failedC()].map((r) => JSON.stringify(pairs(r)))).size >= 2,
      true,
    );
  });

  test('no failed shape has an Unexplained gap or a Resolved record, even with the Drift packet as baseline', () => {
    const baseline = asBaseline(runCase());
    for (const make of [failedA, failedB, failedC]) {
      const files = { ...failedBase };
      void files;
      const results =
        make === failedA
          ? withResult(ALL_PASS, 'extract-code-ts', (r) => ({
              ...r,
              status: 'FAIL' as const,
              authoritative: [],
            }))
          : make === failedB
            ? withResult(ALL_PASS, 'extract-data', (r) => ({
                ...r,
                status: 'UNAVAILABLE' as const,
                authoritative: [],
              }))
            : withResult(ALL_PASS, 'extract-code-ts', (r) => ({ ...r, status: 'FAIL' as const }));
      const ran = runCase({ ...failedBase, results, baseline });
      assert.ok(
        !ran.findings.some((f) => f.class === 'Unexplained gap' || f.class === 'Resolved'),
        make.name,
      );
      for (const id of DRIFT.slice(0, 4))
        assert.equal(
          ran.findings.find((f) => f.id.endsWith(id.split('|')[1]!))?.class,
          'Unknown',
          id,
        );
    }
  });

  test('a variant of (b) with a parseable root would report csv and mermaid as Unexplained gaps, which is why the root stays unparseable', () => {
    const results = withResult(ALL_PASS, 'extract-data', (r) => ({
      ...r,
      status: 'UNAVAILABLE' as const,
      authoritative: [],
    }));
    const ran = runCase({ results });
    assert.equal(ran.find('output-format:csv')?.class, 'Unexplained gap');
    assert.equal(ran.find('control:C1')?.reason, 'no-static-consumer');
  });
});

describe('12.2 baseline: Resolved records', () => {
  const baseline = (): ReturnType<typeof asBaseline> => asBaseline(runCase());

  test('with the Aligned run: Resolved for all four drift ids and no other id, with the stated reasons', () => {
    const ran = runCase({
      formats: 'Output is text and JSON from the CLI.',
      floor: '20.3',
      wired: true,
      x3Kind: 'Column',
      baseline: baseline(),
    });
    const resolved = ran.findings
      .filter((f) => f.class === 'Resolved')
      .map(
        (f) =>
          `${f.id.slice('fx:align:'.length)}|${f.resolved?.from}|${f.resolved?.by}|${f.reason}`,
      );
    assert.deepEqual(resolved, [
      'DETECTOR_LIVENESS:detector:X3|Unexplained gap|fact-changed|fact-changed',
      'OUTPUT_FORMAT_SET:cli:output-format:csv|Unexplained gap|claim-removed|claim-removed',
      'OUTPUT_FORMAT_SET:cli:output-format:mermaid|Unexplained gap|claim-removed|claim-removed',
      'RUNTIME_FLOOR:runtime:node|Observed drift|claim-corrected|claim-corrected',
    ]);
    assert.ok(!ran.findings.some((f) => f.id.endsWith('control:C1')), 'Unknown is never resolved');
    assert.equal(ran.packet.baseline?.digest, baseline().digest);
  });

  test('with the Planned gap run: the gaps are explained and also stand as Planned gaps (uniqueness is (id, class))', () => {
    const ran = runCase({
      formats: 'CSV and Mermaid output are planned.',
      floor: '20.3',
      wired: true,
      extraReadme: 'X3 does not fire yet.',
      baseline: baseline(),
    });
    const byClass = (c: string): string[] =>
      ran.findings.filter((f) => f.class === c).map((f) => f.id.slice('fx:align:'.length));
    assert.deepEqual(byClass('Planned gap'), [
      'DETECTOR_LIVENESS:detector:X3',
      'OUTPUT_FORMAT_SET:cli:output-format:csv',
      'OUTPUT_FORMAT_SET:cli:output-format:mermaid',
    ]);
    const explained = ran.findings
      .filter((f) => f.class === 'Resolved' && f.resolved?.by === 'explained')
      .map((f) => f.id.slice('fx:align:'.length));
    assert.deepEqual(explained, byClass('Planned gap'));
    assert.equal(new Set(ran.findings.map((f) => `${f.id}|${f.class}`)).size, ran.findings.length);
  });

  test('a baseline drift stays what it is when it is still drift', () => {
    const ran = runCase({ baseline: baseline() });
    assert.deepEqual(pairs(ran), DRIFT);
  });

  test('a baseline of Unknown, Planned gap or Resolved findings produces no Resolved record', () => {
    const plannedBaseline = asBaseline(planned());
    const ran = runCase({
      formats: 'Output is text and JSON from the CLI.',
      floor: '20.3',
      wired: true,
      x3Kind: 'Column',
      baseline: plannedBaseline,
    });
    assert.deepEqual(pairs(ran), []);
  });

  test('a baseline runtime:node drift whose document is deleted at head resolves as claim-removed without any probe running', () => {
    const files = caseFiles();
    delete files['docs/toolchain.md'];
    const ran = run(files, { baseline: baseline() });
    assert.equal(
      ran.findings.find((f) => f.id.endsWith('runtime:node') && f.class === 'Resolved')?.resolved
        ?.by,
      'claim-removed',
    );
    assert.equal(
      ran.findings.find((f) => f.id.endsWith('runtime:node') && f.class === 'Resolved')?.fact,
      null,
    );
  });

  test('a baseline csv drift whose document is over the size bound at head is Unknown(limit-exceeded) with no Resolved record; shortened, it resolves as claim-removed', () => {
    const long = `${'Filler words for the bound. '.repeat(40)}\n`;
    const files = caseFiles({ formats: long });
    const over = run(files, { baseline: baseline(), limits: { maxDocumentBytes: 600 } });
    assert.equal(over.packet.inputs.docs.find((d) => d.path === 'README.md')?.status, 'FAIL');
    const csv = over.findings.filter((f) => f.id.endsWith('output-format:csv'));
    assert.deepEqual(
      csv.map((f) => `${f.class}|${f.reason}`),
      ['Unknown|limit-exceeded'],
    );
    assert.ok(
      !over.findings.some((f) => f.class === 'Resolved' && f.id.endsWith('output-format:csv')),
    );
    const shortened = run(caseFiles({ formats: 'Short.' }), {
      baseline: baseline(),
      limits: { maxDocumentBytes: 600 },
    });
    assert.equal(
      shortened.findings.find((f) => f.id.endsWith('output-format:csv') && f.class === 'Resolved')
        ?.resolved?.by,
      'claim-removed',
    );
  });
});

describe('12.2 digests, ids and reproducibility', () => {
  const floor = (doc: string, engines: string): Record<string, string> => ({
    'package.json': JSON.stringify({ name: 'fx', private: true, engines: { node: engines } }),
    'docs/toolchain.md': `- **Node >= ${doc}** is required.\n`,
  });

  test('correcting only the document’s Node floor gives Resolved claim-corrected', () => {
    const head = run(floor('22.13', '>=22.13.0'), {
      baseline: asBaseline(run(floor('22.11', '>=22.13.0'))),
    });
    assert.equal(
      head.findings.find((f) => f.class === 'Resolved')?.resolved?.by,
      'claim-corrected',
    );
  });

  test('changing only engines, leaving the document, gives fact-changed', () => {
    const head = run(floor('22.13', '>=22.13.0'), {
      baseline: asBaseline(run(floor('22.13', '>=22.11.0'))),
    });
    assert.equal(head.findings.find((f) => f.class === 'Resolved')?.resolved?.by, 'fact-changed');
  });

  test('changing both gives claim-and-fact-changed', () => {
    const head = run(floor('22.13', '>=22.13.0'), {
      baseline: asBaseline(run(floor('20.1', '>=20.3.0'))),
    });
    assert.equal(
      head.findings.find((f) => f.class === 'Resolved')?.resolved?.by,
      'claim-and-fact-changed',
    );
  });

  test('rewording a claim without changing its meaning changes neither digest', () => {
    const a = run(floor('22.11', '>=22.13.0')).find('runtime:node');
    const b = run({
      ...floor('22.11', '>=22.13.0'),
      'docs/toolchain.md': 'Preamble.\n\n- **Node >= 22.11.0**, which is quite old now.\n',
    }).find('runtime:node');
    assert.deepEqual(a?.digests, b?.digests);
    assert.notEqual(a?.claims[0]?.excerpt, b?.claims[0]?.excerpt);
  });

  test('git mv of docs/toolchain.md changes no id and no per-finding digest, and changes the packet digest', () => {
    const before = runCase();
    const files = caseFiles();
    const moved: Record<string, string> = {
      ...files,
      'docs/guides/toolchain.md': files['docs/toolchain.md'] ?? '',
    };
    delete moved['docs/toolchain.md'];
    const after = run(moved);
    assert.deepEqual(
      after.findings.map((f) => [f.id, f.digests]),
      before.findings.map((f) => [f.id, f.digests]),
    );
    assert.notEqual(after.packet.digest, before.packet.digest);
    assert.equal(after.find('runtime:node')?.claims[0]?.source.path, 'docs/guides/toolchain.md');
  });

  test('classification is identical with proposals removed', () => {
    const row =
      '## Controls\n\n| # | Control | Where |\n| --- | --- | --- |\n| C1 | The capability manifest is enforced with a provenance ceiling. | host runtime |\n';
    const withHeader = {
      'package.json': '{"name":"fx"}',
      'README.md': row,
      'src/sandbox.ts':
        '/** The capability manifest is enforced here, with a provenance ceiling. */\nexport const s = 1;\n',
    };
    const withoutHeader = { ...withHeader, 'src/sandbox.ts': 'export const s = 1;\n' };
    const a = run(withHeader);
    const b = run(withoutHeader);
    assert.equal(a.packet.proposals.length, 1);
    assert.equal(b.packet.proposals.length, 0);
    assert.deepEqual(a.packet.findings, b.packet.findings);
  });

  test('two evaluations of the same inputs are byte-identical, and the bytes are canonical', () => {
    const one = runCase();
    const two = runCase();
    assert.equal(one.bytes, two.bytes);
    assert.ok(one.bytes.endsWith('}\n') && !one.bytes.endsWith('\n\n'));
    assert.ok(!one.bytes.includes('\r'));
    const keys = Object.keys(JSON.parse(one.bytes) as object);
    assert.deepEqual(keys, [...keys].sort());
    assert.ok(one.bytes.startsWith('{\n  "baseline": null,'));
  });

  test('the packet states the schema, its version, the producer and run provenance', () => {
    const { packet } = runCase();
    assert.equal(packet.schema, 'seamline.alignment-packet');
    assert.equal(packet.schemaVersion, 1);
    assert.deepEqual(packet.producer, {
      tool: 'seamline',
      toolVersion: '0.0.0-test',
      alignVersion: 1,
      sifVersion: '1.0.0',
    });
    assert.deepEqual(packet.subject, { commit: COMMIT, worktree: false });
    assert.equal(packet.run.facts.source, 'sif');
    assert.equal(packet.run.pairing, 'asserted');
    assert.equal(packet.run.commit, null);
    assert.equal(packet.run.ontologyVersion, null);
    assert.equal(packet.sensitivity, 'internal');
    assert.deepEqual(
      packet.run.extractors.map((e) => e.name),
      ['extract-code-ts', 'extract-contracts', 'extract-data', 'infer-join'],
    );
    assert.deepEqual(
      packet.run.scopes.map((s) => s.scope),
      ['code.ts', 'contracts', 'data', 'infer-join'],
    );
    assert.ok(packet.inputs.excluded.includes('docs/adr/**'));
    assert.ok(!/\b\d{4}-\d\d-\d\dT/.test(runCase().bytes), 'no timestamp in a packet');
  });

  test('the --worktree packet records worktree true and no commit', () => {
    const ran = run(caseFiles(), { commit: null });
    assert.deepEqual(ran.packet.subject, { commit: null, worktree: true });
    assert.equal(ran.packet.run.pairing, 'asserted');
    assert.equal(ran.findings[0]?.claims[0]?.source.commit, null);
  });
});

describe('12.2 facts source', () => {
  const results = (names: string[]) => ALL_PASS.filter((r) => names.includes(r.extractor));
  const runs = (a: string | null, b: string | null): FactsRun[] => [
    {
      runId: 'r2',
      commit: a,
      ontologyVersion: '1.0.0',
      results: results(['extract-code-ts', 'extract-data']),
    },
    {
      runId: 'r1',
      commit: b,
      ontologyVersion: '1.0.0',
      results: results(['extract-contracts', 'infer-join']),
    },
  ];
  const aligned_ = {
    formats: 'Output is text and JSON from the CLI.',
    floor: '20.3',
    wired: true,
    x3Kind: 'Column',
  } as const;

  test('a SIF yields run.commit null, facts.source sif, pairing asserted and no run-commit-mismatch, even if a commit were recorded', () => {
    const ran = runCase({ ...aligned_, runs: runs('d'.repeat(40), 'd'.repeat(40)), source: 'sif' });
    assert.equal(ran.packet.run.pairing, 'asserted');
    assert.deepEqual(pairs(ran), []);
  });

  test('(1) every supplying run has commit null, the shape seamline extract writes today: asserted, no mismatch, and the Aligned result', () => {
    const ran = runCase({ ...aligned_, runs: runs(null, null), source: 'store' });
    assert.equal(ran.packet.run.pairing, 'asserted');
    assert.deepEqual(pairs(ran), []);
  });

  test('(2) every supplying run carries a commit equal to --at: verified, and the same result', () => {
    const ran = runCase({ ...aligned_, runs: runs(COMMIT, COMMIT), source: 'store' });
    assert.equal(ran.packet.run.pairing, 'verified');
    assert.deepEqual(pairs(ran), []);
  });

  test('(3) a supplying run carries a different non-null commit: Unknown(run-commit-mismatch) for every probe that reads the run, RUNTIME_FLOOR untouched', () => {
    const ran = runCase({ runs: runs(COMMIT, 'd'.repeat(40)), source: 'store' });
    const reasons = Object.fromEntries(
      ran.findings.map((f) => [f.id.slice('fx:align:'.length), f.reason]),
    );
    assert.equal(reasons['RUNTIME_FLOOR:runtime:node'], 'value-mismatch');
    for (const id of [
      'OUTPUT_FORMAT_SET:cli:output-format:csv',
      'OUTPUT_FORMAT_SET:cli:output-format:mermaid',
      'DETECTOR_LIVENESS:detector:X3',
      'CONTROL_ENFORCEMENT:control:C1',
    ]) {
      assert.equal(reasons[id], 'run-commit-mismatch', id);
    }
    assert.equal(ran.packet.run.pairing, 'asserted');
  });

  test('(4) one supplying run has commit null and another carries the equal commit: asserted', () => {
    const ran = runCase({ ...aligned_, runs: runs(COMMIT, null), source: 'store' });
    assert.equal(ran.packet.run.pairing, 'asserted');
    assert.deepEqual(pairs(ran), []);
  });

  test('a run that supplies nothing is not asked: a stale commit on it is no mismatch', () => {
    const extra: FactsRun = {
      runId: 'old',
      commit: 'e'.repeat(40),
      ontologyVersion: '1.0.0',
      results: results(['extract-data']),
    };
    const all: FactsRun[] = [
      { runId: 'new', commit: COMMIT, ontologyVersion: '1.0.0', results: ALL_PASS },
      extra,
    ];
    const ran = runCase({ ...aligned_, runs: all, source: 'store' });
    assert.equal(ran.packet.run.pairing, 'verified');
    assert.deepEqual(pairs(ran), []);
  });
});

describe('bounds and the document set (3.1)', () => {
  test('the default document set is echoed, and an override replaces it', () => {
    const only = runCase({ config: { docs: ['docs/**/*.md'], exclude: [] } });
    assert.deepEqual(
      only.packet.inputs.docs.map((d) => d.path),
      ['docs/toolchain.md'],
    );
    assert.deepEqual(only.packet.inputs.excluded, []);
    const none = runCase({ config: { exclude: ['README.md'] } });
    assert.ok(!none.packet.inputs.docs.some((d) => d.path === 'README.md'));
    assert.deepEqual(none.packet.inputs.excluded, ['README.md']);
  });

  test('ADR, audit, dogfood, changelog and node_modules documents are excluded by default; the root, docs/ and package READMEs are read', () => {
    const files = {
      ...caseFiles(),
      'docs/adr/ADR-1.md': 'x\n',
      'docs/audit/a.md': 'x\n',
      'docs/dogfood/b.md': 'x\n',
      'CHANGELOG.md': 'x\n',
      'packages/cli/CHANGELOG.md': 'x\n',
      'node_modules/pkg/README.md': 'x\n',
      'packages/cli/README.md': 'x\n',
      'packages/cli/docs/deep.md': 'x\n',
      'docs/a/b/c.md': 'x\n',
    };
    assert.deepEqual(
      run(files).packet.inputs.docs.map((d) => d.path),
      ['README.md', 'docs/a/b/c.md', 'docs/toolchain.md', 'packages/cli/README.md'],
    );
  });

  test('every document read is recorded with the SHA-256 of its bytes, even one with no claim', () => {
    const ran = runCase();
    for (const doc of ran.packet.inputs.docs) assert.match(doc.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(ran.packet.inputs.docs.find((d) => d.path === 'docs/toolchain.md')?.claims, 1);
  });

  test('a document over the claim bound and the documents after it are limit-exceeded, and a claim in them is not invented', () => {
    const ran = runCase({ limits: { maxClaims: 3 } });
    assert.ok(
      ran.packet.inputs.docs.some(
        (d) => d.status === 'FAIL' && d.diagnostics[0]?.startsWith('limit-exceeded'),
      ),
    );
    assert.ok(ran.packet.summary.claims <= 3);
  });

  test('12.4 item 6: the document that tips the claim cap keeps its hash; the documents after it have sha256 null', () => {
    const ran = runCase({ limits: { maxClaims: 3 } });
    const docs = ran.packet.inputs.docs;
    assert.deepEqual(
      docs.map((d) => [d.path, d.status]),
      [
        ['README.md', 'FAIL'],
        ['docs/toolchain.md', 'FAIL'],
      ],
    );
    assert.equal(docs[0]?.sha256, sha256Hex(caseFiles()['README.md'] ?? ''));
    assert.equal(docs[1]?.sha256, null);
  });

  test('12.4 item 6: a document skipped by the document-count bound has sha256 null, and so has one whose blob cannot be read', () => {
    const counted = runCase({ limits: { maxDocuments: 1 } });
    assert.match(counted.packet.inputs.docs[0]?.sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(counted.packet.inputs.docs[1]?.sha256, null);

    const files = caseFiles();
    const tree = memTree(files);
    const body = evaluate({
      repo: REPO,
      tree: { ...tree, read: (path) => (path === 'docs/toolchain.md' ? null : tree.read(path)) },
      commit: COMMIT,
      worktree: false,
      facts: factsFor(files),
      baseline: null,
      producer: { toolVersion: '0.0.0-test', sifVersion: '1.0.0' },
    });
    const unread = body.inputs.docs.find((d) => d.path === 'docs/toolchain.md');
    assert.equal(unread?.sha256, null);
    assert.equal(unread?.status, 'FAIL');
    assert.ok(unread?.diagnostics[0]?.startsWith('source-unreadable'));
    assert.match(
      body.inputs.docs.find((d) => d.path === 'README.md')?.sha256 ?? '',
      /^[0-9a-f]{64}$/,
    );
  });

  test('more documents than the bound are limit-exceeded and unread', () => {
    const ran = runCase({ limits: { maxDocuments: 1 } });
    assert.deepEqual(
      ran.packet.inputs.docs.map((d) => d.status),
      ['PASS', 'FAIL'],
    );
  });

  test('a line over the bound marks the document limit-exceeded; claims on the lines before it still stand', () => {
    const ran = runCase({
      formats: `Output is JSON, CSV, and Mermaid from the CLI.\n\n${'x'.repeat(5000)}`,
    });
    assert.equal(ran.packet.inputs.docs.find((d) => d.path === 'README.md')?.status, 'FAIL');
    assert.equal(ran.find('output-format:csv')?.class, 'Unexplained gap');
  });

  test('findings beyond the bound are cut, and the cut is stated', () => {
    const ran = runCase({ limits: { maxFindings: 2 } });
    assert.equal(ran.findings.length, 2);
    assert.ok(
      ran.packet.inputs.probes.some((p) => p.diagnostics.some((d) => d.includes('limit-exceeded'))),
    );
  });
});
