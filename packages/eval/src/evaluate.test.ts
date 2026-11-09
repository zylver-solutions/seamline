import assert from 'node:assert/strict';
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildProduct, distDigest } from './build.ts';
import { ConfigError, PinMismatchError } from './errors.ts';
import { evaluate, type EvaluateOptions } from './evaluate.ts';
import { fetchRepo, verifyPinned } from './fetch.ts';
import { findingId } from './findings.ts';
import { codeIdentity, NO_GIT, scorerIdentity, sealedCorpusDigest } from './freeze.ts';
import { reportBody, type Report } from './report.ts';
import {
  commitFiles,
  contradiction,
  invocations,
  makeTempDir,
  MINI_CLI,
  miniDetectorSource,
  removeDir,
  writeFakeCli,
  writeMiniMonorepo,
  writeOwnFakeCli,
} from './testing.ts';
import type { CorpusEntry, Partition } from './types.ts';

const PASSING = [
  {
    extractor: 'extract-data',
    version: '1',
    status: 'PASS',
    nodeCount: 3,
    edgeCount: 2,
    authoritative: [{ scope: 'data' }],
    diagnostics: [],
  },
];

const A = contradiction('X1_NULLABILITY', 'tiny:Column:a', 'tiny:SchemaProperty:a', 0.9);
const B = contradiction('X1_NULLABILITY', 'tiny:Column:b', 'tiny:SchemaProperty:b', 0.6);
const ID_A = findingId('tiny', 'X1_NULLABILITY', 'tiny:Column:a', 'tiny:SchemaProperty:a');
const ID_B = findingId('tiny', 'X1_NULLABILITY', 'tiny:Column:b', 'tiny:SchemaProperty:b');

function spec(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ results: PASSING, nodes: { Table: 1 }, contradictions: [], ...extra });
}

interface Scenario {
  readonly root: string;
  readonly source: string;
  readonly sha: string;
  readonly opts: EvaluateOptions;
  readonly logs: string[];
}

async function scenario(
  fakeJson: string,
  files: {
    readonly labels?: unknown;
    readonly mutants?: unknown;
    readonly overrides?: Partial<EvaluateOptions>;
    readonly partition?: Partition;
  } = {},
): Promise<Scenario> {
  const root = await makeTempDir();
  const source = path.join(root, 'source');
  const sha = await commitFiles(
    source,
    { 'fake.json': fakeJson, 'README.md': 'tiny\n' },
    'pin',
    true,
  );
  const entry: CorpusEntry = {
    name: 'tiny',
    url: 'https://example.invalid/tiny',
    sha,
    license: 'MIT',
    partition: files.partition ?? 'dev',
    stacks: ['prisma'],
    why: 'fixture',
  };
  const cacheDir = path.join(root, 'cache');
  // Pre-populate the cache from the local repository; the https URL in the
  // corpus file is never contacted because the checkout already exists.
  await fetchRepo({ ...entry, url: source }, { cacheDir });

  const corpusFile = path.join(root, 'corpus.json');
  const labelsFile = path.join(root, 'labels.json');
  const mutantsFile = path.join(root, 'mutants.json');
  await writeFile(corpusFile, JSON.stringify([entry]), 'utf8');
  await writeFile(labelsFile, JSON.stringify(files.labels ?? {}), 'utf8');
  await writeFile(mutantsFile, JSON.stringify(files.mutants ?? []), 'utf8');
  const logs: string[] = [];
  const opts: EvaluateOptions = {
    corpusFile,
    labelsFile,
    mutantsFile,
    cacheDir,
    outDir: path.join(root, 'out'),
    cli: await writeOwnFakeCli(root),
    only: [],
    mutantIds: [],
    runMutants: true,
    allowUnlabelled: false,
    timeoutMs: 20_000,
    heapMb: 256,
    keepScratch: false,
    reuseBaseline: false,
    build: async () => {},
    codeIdentity: async () => 'code-a',
    scorerIdentity: async () => 'scorer-a',
    scratchRoot: path.join(root, 'scratch'),
    freezeFile: path.join(root, 'FREEZE'),
    root,
    log: (line) => logs.push(line),
    ...files.overrides,
  };
  return { root, source, sha, opts, logs };
}

function tp(evidence = 'a.ts:1') {
  return {
    verdict: 'tp',
    rationale: 'reviewed',
    evidence: [evidence],
    reviewer: 'rev',
    blind: true,
  };
}
function fp() {
  return {
    verdict: 'fp',
    rationale: 'reviewed',
    evidence: ['a.ts:2'],
    reviewer: 'rev',
    blind: false,
  };
}

test('a finding with no label fails the evaluation and is listed by id', async () => {
  const s = await scenario(spec({ contradictions: [A] }));
  try {
    const result = await evaluate(s.opts);
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.problems.some((p) => p.includes(ID_A)),
      result.problems.join('\n'),
    );
    assert.deepEqual(result.report.labels.unlabelled, [ID_A]);
    assert.equal(
      result.report.overall.precision,
      null,
      'unreviewed findings never enter precision',
    );
  } finally {
    await removeDir(s.root);
  }
});

test('--allow-unlabelled reports the finding without counting it', async () => {
  const s = await scenario(spec({ contradictions: [A] }), { overrides: { allowUnlabelled: true } });
  try {
    const result = await evaluate(s.opts);
    assert.equal(result.exitCode, 0, result.problems.join('\n'));
    assert.equal(result.report.overall.findings, 1);
    assert.equal(result.report.overall.unlabelled, 1);
    assert.equal(result.report.overall.n, 0);
    assert.equal(result.report.overall.precision, null);
  } finally {
    await removeDir(s.root);
  }
});

test('labelled findings produce precision, and a label with no finding is reported as stale', async () => {
  const s = await scenario(spec({ contradictions: [A, B] }), {
    labels: { [ID_A]: tp(), [ID_B]: fp(), '0000000000000000': tp() },
  });
  try {
    const result = await evaluate(s.opts);
    assert.equal(result.exitCode, 0, result.problems.join('\n'));
    assert.equal(result.report.overall.tp, 1);
    assert.equal(result.report.overall.fp, 1);
    assert.equal(result.report.overall.precision, 0.5);
    assert.deepEqual(result.report.labels.stale, ['0000000000000000']);
    assert.equal(result.report.labels.staleChecked, true);
    assert.deepEqual(result.report.labels.unlabelled, []);
  } finally {
    await removeDir(s.root);
  }
});

test('mutants are scored against the unmodified run: detected, missed, and invalid are told apart', async () => {
  const s = await scenario(spec({ contradictions: [A] }), {
    labels: { [ID_A]: tp() },
    mutants: [
      {
        id: 'adds-b',
        repo: 'tiny',
        detector: 'X1_NULLABILITY',
        description: 'Adds a second contradiction.',
        edits: [
          {
            path: 'fake.json',
            find: `"contradictions":[${JSON.stringify(A)}]`,
            replace: `"contradictions":[${JSON.stringify(A)},${JSON.stringify(B)}]`,
          },
        ],
        expect: { code: 'X1_NULLABILITY', leftMatch: 'Column:b' },
      },
      {
        id: 'changes-nothing-relevant',
        repo: 'tiny',
        detector: 'X1_NULLABILITY',
        description: 'Edits a file that no detector reads.',
        edits: [{ path: 'README.md', append: 'more\n' }],
        expect: { code: 'X1_NULLABILITY', leftMatch: 'Column:b' },
      },
      {
        id: 'already-there',
        repo: 'tiny',
        detector: 'X1_NULLABILITY',
        description: 'Expects a finding the baseline already had.',
        edits: [{ path: 'README.md', append: 'again\n' }],
        expect: { code: 'X1_NULLABILITY', leftMatch: 'Column:a' },
      },
      {
        id: 'bad-find',
        repo: 'tiny',
        detector: 'X2_TYPE',
        description: 'The find text is not in the file.',
        edits: [{ path: 'README.md', find: 'text that is not there', replace: 'x' }],
        expect: { code: 'X2_TYPE' },
      },
      {
        id: 'ambiguous-find',
        repo: 'tiny',
        detector: 'X2_TYPE',
        description: 'The find text occurs more than once.',
        edits: [{ path: 'fake.json', find: '"', replace: "'" }],
        expect: { code: 'X2_TYPE' },
      },
    ],
  });
  try {
    const result = await evaluate(s.opts);
    const status = Object.fromEntries(result.report.mutants.map((m) => [m.id, m.status]));
    assert.deepEqual(status, {
      'adds-b': 'detected',
      'already-there': 'missed',
      'ambiguous-find': 'invalid',
      'bad-find': 'invalid',
      'changes-nothing-relevant': 'missed',
    });
    const x1 = result.report.detectors.find((d) => d.code === 'X1_NULLABILITY');
    assert.deepEqual([x1?.mutants, x1?.detected, x1?.recall], [3, 1, 1 / 3]);
    const x2 = result.report.detectors.find((d) => d.code === 'X2_TYPE');
    assert.deepEqual([x2?.mutants, x2?.recall], [0, null], 'invalid mutants are not scored');
    assert.equal(result.exitCode, 1, 'an invalid mutant fails the run');
    assert.ok(result.problems.some((p) => p.includes('bad-find') && /found 0/.test(p)));
    assert.ok(result.problems.some((p) => p.includes('ambiguous-find') && /exactly once/.test(p)));
  } finally {
    await removeDir(s.root);
  }
});

test('a mutated tree that the CLI cannot analyse is an error, not a miss', async () => {
  const s = await scenario(spec(), {
    mutants: [
      {
        id: 'breaks-the-run',
        repo: 'tiny',
        detector: 'X5_UNWRITTEN_COLUMN',
        description: 'Makes the stand-in CLI crash.',
        edits: [
          {
            path: 'fake.json',
            find: '"contradictions":[]',
            replace: '"contradictions":[],"crash":true',
          },
        ],
        expect: { code: 'X5_UNWRITTEN_COLUMN' },
      },
    ],
  });
  try {
    const result = await evaluate(s.opts);
    assert.equal(result.report.mutants[0]?.status, 'error');
    assert.equal(
      result.report.detectors.find((d) => d.code === 'X5_UNWRITTEN_COLUMN')?.recall,
      null,
    );
    assert.equal(result.exitCode, 1);
  } finally {
    await removeDir(s.root);
  }
});

test('a mutant whose detector is UNKNOWN on the mutated run is not a detection', async () => {
  const s = await scenario(
    spec({ unknown: [{ code: 'X9_CONTRACT_DRIFT', reason: 'scope contracts is FAIL' }] }),
    {
      mutants: [
        {
          id: 'blocked-detector',
          repo: 'tiny',
          detector: 'X9_CONTRACT_DRIFT',
          description: 'A contradiction that a blocked detector cannot report.',
          edits: [{ path: 'README.md', append: 'x\n' }],
          expect: { code: 'X9_CONTRACT_DRIFT' },
        },
      ],
    },
  );
  try {
    const result = await evaluate(s.opts);
    assert.equal(result.report.mutants[0]?.status, 'unknown');
    const x9 = result.report.detectors.find((d) => d.code === 'X9_CONTRACT_DRIFT');
    assert.deepEqual([x9?.mutants, x9?.detected, x9?.recall], [1, 0, 0]);
    assert.equal(result.exitCode, 0, result.problems.join('\n'));
  } finally {
    await removeDir(s.root);
  }
});

test('a repository the CLI crashes on is UNKNOWN for every detector, its mutants are skipped, and the run fails', async () => {
  const s = await scenario(JSON.stringify({ crash: true }), {
    mutants: [
      {
        id: 'never-runs',
        repo: 'tiny',
        detector: 'X1_NULLABILITY',
        description: 'Needs a baseline.',
        edits: [{ path: 'README.md', append: 'x\n' }],
        expect: { code: 'X1_NULLABILITY' },
      },
    ],
  });
  try {
    const result = await evaluate(s.opts);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.repos[0]?.analysis, 'crashed');
    assert.ok(
      Object.values(result.report.repos[0]?.detectors ?? {}).every((d) => d.state === 'unknown'),
    );
    assert.equal(result.report.mutants[0]?.status, 'skipped');
    assert.equal(result.report.labels.staleChecked, false);
  } finally {
    await removeDir(s.root);
  }
});

test('the evaluation refuses to run when the checkout is not the pinned commit, and measures nothing', async () => {
  const s = await scenario(spec({ contradictions: [A] }));
  try {
    // The corpus now pins a later commit than the one in the cache.
    const next = await commitFiles(s.source, { 'README.md': 'next\n' }, 'next');
    const corpus = JSON.parse(await readFile(s.opts.corpusFile, 'utf8')) as CorpusEntry[];
    await writeFile(s.opts.corpusFile, JSON.stringify([{ ...corpus[0], sha: next }]), 'utf8');

    await assert.rejects(evaluate(s.opts), (e: unknown) => {
      assert.ok(e instanceof PinMismatchError);
      assert.equal(e.expected, next);
      assert.equal(e.actual, s.sha);
      return true;
    });
    await assert.rejects(access(path.join(s.opts.outDir, 'report.json')), /ENOENT/);
    assert.ok(!s.logs.some((l) => l.includes('extracting')), 'no analysis started');
  } finally {
    await removeDir(s.root);
  }
});

test('the evaluation never modifies the cached checkout', async () => {
  const s = await scenario(spec({ contradictions: [A] }), {
    labels: { [ID_A]: tp() },
    mutants: [
      {
        id: 'edits-the-copy',
        repo: 'tiny',
        detector: 'X1_NULLABILITY',
        description: 'Edits a file.',
        edits: [{ path: 'README.md', append: 'scratch only\n' }],
        expect: { code: 'X1_NULLABILITY', leftMatch: 'Column:nothing' },
      },
    ],
  });
  try {
    await evaluate(s.opts);
    const corpus = JSON.parse(await readFile(s.opts.corpusFile, 'utf8')) as CorpusEntry[];
    const entry = corpus[0];
    assert.ok(entry !== undefined);
    await verifyPinned(entry, path.join(s.opts.cacheDir, 'tiny'));
    assert.equal(await readFile(path.join(s.opts.cacheDir, 'tiny', 'README.md'), 'utf8'), 'tiny\n');
  } finally {
    await removeDir(s.root);
  }
});

test('two evaluations of the same inputs write the same report body', async () => {
  const s = await scenario(spec({ contradictions: [A, B] }), {
    labels: { [ID_A]: tp(), [ID_B]: fp() },
    mutants: [
      {
        id: 'noop',
        repo: 'tiny',
        detector: 'X1_NULLABILITY',
        description: 'Nothing relevant.',
        edits: [{ path: 'README.md', append: 'x\n' }],
        expect: { code: 'X1_NULLABILITY', leftMatch: 'Column:zzz' },
      },
    ],
  });
  try {
    const first = await evaluate(s.opts);
    const secondOut = path.join(s.root, 'out2');
    const second = await evaluate({ ...s.opts, outDir: secondOut });
    assert.deepEqual(reportBody(first.report), reportBody(second.report));

    const read = async (dir: string): Promise<Report> =>
      JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')) as Report;
    const a = await read(s.opts.outDir);
    const b = await read(secondOut);
    assert.deepEqual(reportBody(a), reportBody(b));
    const mdA = (await readFile(path.join(s.opts.outDir, 'report.md'), 'utf8')).split(
      '## Run metadata',
    )[0];
    const mdB = (await readFile(path.join(secondOut, 'report.md'), 'utf8')).split(
      '## Run metadata',
    )[0];
    assert.equal(mdA, mdB);
  } finally {
    await removeDir(s.root);
  }
});

test('a repository or mutant filter marks the report partial and skips the stale-label check', async () => {
  const s = await scenario(spec({ contradictions: [A] }), {
    labels: { [ID_A]: tp(), ffffffffffffffff: tp() },
    overrides: { runMutants: false },
  });
  try {
    const result = await evaluate(s.opts);
    assert.equal(result.report.partial, true);
    assert.equal(result.report.labels.staleChecked, false);
    assert.deepEqual(result.report.labels.stale, []);
  } finally {
    await removeDir(s.root);
  }
});

test('an unknown repository or mutant name is a configuration error', async () => {
  const s = await scenario(spec());
  try {
    await assert.rejects(evaluate({ ...s.opts, only: ['nope'] }), ConfigError);
    await assert.rejects(evaluate({ ...s.opts, mutantIds: ['nope'] }), /unknown mutant/);
  } finally {
    await removeDir(s.root);
  }
});

test('an unlabelled finding in the sealed partition is counted but its subjects are not printed', async () => {
  const s = await scenario(spec({ contradictions: [A] }), { partition: 'sealed' });
  try {
    const result = await evaluate(s.opts);
    assert.equal(result.exitCode, 1);
    const text = result.problems.join('\n');
    assert.ok(text.includes('1 finding(s) have no label'), text);
    assert.ok(text.includes('sealed partition'), text);
    assert.ok(!text.includes('tiny:Column:a'), `sealed subjects leaked into: ${text}`);
    assert.ok(!text.includes(ID_A), 'the id of a sealed finding is not printed either');
    const md = await readFile(path.join(s.opts.outDir, 'report.md'), 'utf8');
    assert.ok(!md.includes('tiny:Column:a'));
    assert.equal(result.report.partitions.find((p) => p.partition === 'sealed')?.findings, 1);
  } finally {
    await removeDir(s.root);
  }
});

test('the stored baseline of a run is what label-sheet reads: it holds the findings and the pin', async () => {
  const s = await scenario(spec({ contradictions: [A, B] }), {
    overrides: { allowUnlabelled: true },
  });
  try {
    await evaluate(s.opts);
    const stored = JSON.parse(
      await readFile(path.join(s.opts.outDir, 'tiny', 'baseline.json'), 'utf8'),
    ) as {
      sha: string;
      pipeline: { outcome: string; findings: { id: string }[] };
    };
    assert.equal(stored.sha, s.sha);
    assert.equal(stored.pipeline.outcome, 'complete');
    assert.deepEqual(stored.pipeline.findings.map((f) => f.id).sort(), [ID_A, ID_B].sort());
  } finally {
    await removeDir(s.root);
  }
});

/**
 * A repository with a detector source, and a FREEZE file naming its first commit. It is also the
 * root the run measures, so it carries the fake CLI where this repository's own build would be
 * (ignored, as `dist/` is in the real one).
 */
async function freezeAt(
  s: Scenario,
  after: 'untouched' | 'detector-changed' | 'test-changed',
): Promise<Partial<EvaluateOptions>> {
  const repo = path.join(s.root, 'frozen-repo');
  const sha = await commitFiles(
    repo,
    {
      '.gitignore': 'dist/\n',
      'packages/contradictions/src/x1.ts': 'export const x = 1;\n',
      'packages/contradictions/src/x1.test.ts': 'export const t = 1;\n',
    },
    'freeze',
    true,
  );
  if (after === 'detector-changed') {
    await commitFiles(
      repo,
      { 'packages/contradictions/src/x1.ts': 'export const x = 2;\n' },
      'change',
    );
  }
  if (after === 'test-changed') {
    await commitFiles(
      repo,
      { 'packages/contradictions/src/x1.test.ts': 'export const t = 2;\n' },
      'test',
    );
  }
  const freezeFile = path.join(s.root, 'FREEZE');
  await writeFile(freezeFile, `# frozen\n${sha}\n`, 'utf8');
  return { root: repo, freezeFile, cli: await writeOwnFakeCli(repo) };
}

function sealedLabels(clusterA?: string, clusterB?: string) {
  return {
    [ID_A]: { ...tp(), ...(clusterA === undefined ? {} : { cluster: clusterA }) },
    [ID_B]: { ...fp(), ...(clusterB === undefined ? {} : { cluster: clusterB }) },
  };
}

test('a label for a sealed finding is refused before eval/FREEZE exists', async () => {
  const s = await scenario(spec({ contradictions: [A, B] }), {
    partition: 'sealed',
    labels: sealedLabels(),
  });
  try {
    await assert.rejects(evaluate(s.opts), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /sealed partition/);
      assert.match(e.message, /FREEZE/);
      assert.ok(!e.message.includes(ID_A) && !e.message.includes('tiny:Column'));
      return true;
    });
  } finally {
    await removeDir(s.root);
  }
});

test('a freeze admits legacy sealed labels but does not establish independent review evidence', async () => {
  const s = await scenario(spec({ contradictions: [A, B] }), {
    partition: 'sealed',
    labels: sealedLabels(),
  });
  try {
    const result = await evaluate({ ...s.opts, ...(await freezeAt(s, 'test-changed')) });
    assert.equal(result.exitCode, 1);
    assert.match(result.problems.join('\n'), /review evidence is incomplete/);
    assert.equal(result.report.headline.reviewIncomplete, true);
    assert.equal(
      result.report.freeze.state,
      'frozen',
      'a changed test does not burn the partition',
    );
    assert.deepEqual([result.report.overall.tp, result.report.overall.fp], [1, 1]);
  } finally {
    await removeDir(s.root);
  }
});

test('a frozen sealed headline needs complete declared primary and second review evidence even with allow-unlabelled', async () => {
  const codeId = 'c'.repeat(64);
  const author = { kind: 'agent', account: 'provider:author', model: 'model-a' };
  const first = { kind: 'agent', account: 'provider:first', model: 'model-a' };
  const second = { kind: 'agent', account: 'provider:second', model: 'model-b' };
  const found = Array.from({ length: 30 }, (_, i) => contradiction('X2_TYPE', `tiny:Column:c${i}`, `tiny:SchemaProperty:p${i}`, 0.99));
  const records = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [
    findingId('tiny', 'X2_TYPE', `tiny:Column:c${i}`, `tiny:SchemaProperty:p${i}`),
    { ...tp(), reviewer: first.account, identity: first, reviews: i < 10 ? [{ ...tp(), identity: second }] : [] },
  ]));
  // Secondary source reviews have no legacy display-name field.
  for (const label of Object.values(records)) for (const review of label.reviews) delete (review as { reviewer?: string }).reviewer;
  const metadata = { codeId, authors: [author] };
  const s = await scenario(spec({ contradictions: found }), { partition: 'sealed',
    labels: { _review: metadata, ...records }, overrides: { codeIdentity: async () => codeId, allowUnlabelled: true } });
  try {
    const opts = { ...s.opts, ...(await freezeAt(s, 'untouched')) };
    const good = await evaluate(opts);
    assert.equal(good.exitCode, 0, good.problems.join('\n'));
    assert.deepEqual([good.report.headline.status, good.report.headline.meetsBar], ['powered', true]);
    assert.equal(good.report.review.overall.doubleReviewedClusters, 10);
    for (const variant of [
      { ...records },
      { _review: { ...metadata, codeId: 'd'.repeat(64) }, ...records },
      { _review: { ...metadata, authors: [first] }, ...records },
      { _review: metadata, ...Object.fromEntries(Object.entries(records).map(([id, label]) => [id, { ...label, reviews: [] }])) },
      { _review: metadata, ...Object.fromEntries(Object.entries(records).map(([id, label]) => [id,
        { ...label, reviews: label.reviews.map((review) => ({ ...review, identity: { ...first, model: 'model-b' } })) }])) },
    ]) {
      await writeFile(s.opts.labelsFile, JSON.stringify(variant), 'utf8');
      const bad = await evaluate(opts);
      assert.equal(bad.exitCode, 1);
      assert.deepEqual([bad.report.headline.status, bad.report.headline.meetsBar], ['incomplete', null]);
      assert.deepEqual(bad.report.overall, good.report.overall, 'review failures do not drop findings or change numeric counts');
      assert.match(bad.problems.join('\n'), /review evidence is incomplete/);
      const body = JSON.stringify(reportBody(bad.report));
      assert.doesNotMatch(body, /provider:|model-a|model-b|"identity"|"reviews"/);
    }
  } finally { await removeDir(s.root); }
});

test('a detector change after the freeze burns the sealed partition: no headline, and the run fails', async () => {
  const s = await scenario(spec({ contradictions: [A, B] }), {
    partition: 'sealed',
    labels: sealedLabels(),
  });
  try {
    const result = await evaluate({ ...s.opts, ...(await freezeAt(s, 'detector-changed')) });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.freeze.state, 'burned');
    assert.deepEqual(result.report.freeze.changed, ['packages/contradictions/src/x1.ts']);
    assert.equal(result.report.headline.status, 'burned');
    assert.ok(
      result.problems.some((p) => p.includes('burned')),
      result.problems.join('\n'),
    );
  } finally {
    await removeDir(s.root);
  }
});

test('the mixed-verdict error for a sealed repository names no cluster and no finding id', async () => {
  const s = await scenario(spec({ contradictions: [A, B] }), {
    partition: 'sealed',
    labels: sealedLabels('secret-cluster-name', 'secret-cluster-name'),
  });
  try {
    await assert.rejects(
      evaluate({ ...s.opts, ...(await freezeAt(s, 'untouched')) }),
      (e: unknown) => {
        assert.ok(e instanceof ConfigError);
        assert.match(e.message, /1 cluster\(s\) in the sealed repository tiny mix verdicts/);
        assert.ok(!e.message.includes('secret-cluster-name'), e.message);
        assert.ok(!e.message.includes(ID_A) && !e.message.includes(ID_B), e.message);
        return true;
      },
    );
  } finally {
    await removeDir(s.root);
  }
});

test('the same mixed-verdict error for a dev repository still names the cluster and the finding', async () => {
  const s = await scenario(spec({ contradictions: [A, B] }), {
    labels: sealedLabels('dev-cluster', 'dev-cluster'),
  });
  try {
    await assert.rejects(evaluate(s.opts), /tiny\/X1_NULLABILITY\/dev-cluster mixes verdicts/);
  } finally {
    await removeDir(s.root);
  }
});

test('a mutant against a sealed repository is refused by the run, not only by the committed file', async () => {
  const mutant = {
    id: 'sealed-mutant',
    repo: 'tiny',
    detector: 'X1_NULLABILITY',
    description: 'An edit to a sealed repository.',
    edits: [{ path: 'README.md', append: 'x\n' }],
    expect: { code: 'X1_NULLABILITY' },
  };
  const s = await scenario(spec(), { partition: 'sealed', mutants: [mutant] });
  try {
    await assert.rejects(evaluate(s.opts), /sealed partition/);
  } finally {
    await removeDir(s.root);
  }
});

test('the cause of a crash in a sealed repository is not printed', async () => {
  const s = await scenario(JSON.stringify({ crash: true }), { partition: 'sealed' });
  try {
    const result = await evaluate(s.opts);
    assert.equal(result.exitCode, 1);
    const text = result.problems.join('\n');
    assert.match(text, /tiny: analysis crashed \(crashed\)/);
    assert.ok(!text.includes('simulated crash'), text);
  } finally {
    await removeDir(s.root);
  }
});

const OWN_CLI_PATH = 'packages/cli/dist/index.js';

async function storedBaseline(s: Scenario): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(s.opts.outDir, 'tiny', 'baseline.json'), 'utf8'),
  ) as Record<string, unknown>;
}

test('a dev baseline is reused only while the sources and the CLI build are the ones that made it', async () => {
  const s = await scenario(spec({ contradictions: [A] }), { labels: { [ID_A]: tp() } });
  try {
    const first = await evaluate(s.opts);
    assert.equal(first.exitCode, 0, first.problems.join('\n'));
    const stored = await storedBaseline(s);
    assert.deepEqual(
      [stored['sha'], stored['codeId']],
      [s.sha, 'code-a'],
      'the sources are stored',
    );
    const cli = stored['cli'] as { path: string; ownBuild: boolean; distDigest: string };
    assert.deepEqual([cli.path, cli.ownBuild], [OWN_CLI_PATH, true], 'and the build');
    assert.match(cli.distDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(await invocations(s.opts.cli), ['extract', 'check']);

    const reuse = { ...s.opts, reuseBaseline: true };

    // Same sources, same build: the baseline is reused and the CLI is not run again.
    const same = await evaluate(reuse);
    assert.equal(same.exitCode, 0, same.problems.join('\n'));
    assert.deepEqual(same.report.run.reusedBaselines, ['tiny']);
    assert.deepEqual(await invocations(s.opts.cli), ['extract', 'check']);

    // Other sources: refused, and the repository is analysed again.
    s.logs.length = 0;
    const other = await evaluate({ ...reuse, codeIdentity: async () => 'code-b' });
    assert.deepEqual(other.report.run.reusedBaselines, []);
    assert.equal((await invocations(s.opts.cli)).length, 4, 'the CLI ran again');
    assert.ok(
      s.logs.some((l) => /not reusing the stored baseline, it was made by other detector/.test(l)),
      s.logs.join('\n'),
    );

    // The same sources, but the compiled CLI is no longer what made the baseline.
    await appendFile(s.opts.cli, '// rebuilt\n');
    s.logs.length = 0;
    const rebuilt = await evaluate({ ...reuse, codeIdentity: async () => 'code-b' });
    assert.deepEqual(rebuilt.report.run.reusedBaselines, []);
    assert.equal((await invocations(s.opts.cli)).length, 6, 'the CLI ran again');
    assert.ok(
      s.logs.some((l) => /not reusing the stored baseline, it was made by another build/.test(l)),
      s.logs.join('\n'),
    );
  } finally {
    await removeDir(s.root);
  }
});

test("a dev baseline made with a CLI that is not this repository's own build is never reused, even by the same file", async () => {
  const s = await scenario(spec({ contradictions: [A] }), { labels: { [ID_A]: tp() } });
  try {
    const elsewhere = await writeFakeCli(s.root, 'elsewhere/cli.mjs');
    const foreign = { ...s.opts, cli: elsewhere, reuseBaseline: true };
    const first = await evaluate(foreign);
    assert.equal(first.exitCode, 0, first.problems.join('\n'));
    assert.deepEqual(await invocations(elsewhere), ['extract', 'check']);

    s.logs.length = 0;
    const again = await evaluate(foreign);
    assert.deepEqual(again.report.run.reusedBaselines, [], 'nothing was reused');
    assert.deepEqual(
      await invocations(elsewhere),
      ['extract', 'check', 'extract', 'check'],
      'the other CLI ran again',
    );
    assert.ok(
      s.logs.some((l) =>
        /not reusing the stored baseline, the CLI is .*not this repository's own build/.test(l),
      ),
      s.logs.join('\n'),
    );
  } finally {
    await removeDir(s.root);
  }
});

test('a stored baseline that recorded its sources or its build is not reused without them', async () => {
  const s = await scenario(spec({ contradictions: [A] }), { labels: { [ID_A]: tp() } });
  try {
    let runs = 0;
    for (const field of ['codeId', 'cli']) {
      await evaluate(s.opts);
      runs += 1;
      const file = path.join(s.opts.outDir, 'tiny', 'baseline.json');
      const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      delete stored[field];
      await writeFile(file, JSON.stringify(stored), 'utf8');
      const again = await evaluate({ ...s.opts, reuseBaseline: true });
      runs += 1;
      assert.deepEqual(again.report.run.reusedBaselines, [], field);
      assert.equal((await invocations(s.opts.cli)).length, runs * 2, `${field}: analysed again`);
    }
  } finally {
    await removeDir(s.root);
  }
});

test('a baseline made where the sources cannot be named is never reused', async () => {
  const s = await scenario(spec({ contradictions: [A] }), { labels: { [ID_A]: tp() } });
  try {
    const unnamed = { ...s.opts, codeIdentity: async () => NO_GIT };
    const first = await evaluate(unnamed);
    assert.equal(first.exitCode, 0, first.problems.join('\n'));
    assert.equal(
      first.report.provenance.codeId,
      NO_GIT,
      'a dev run records that it has no sources',
    );
    s.logs.length = 0;
    const again = await evaluate({ ...unnamed, reuseBaseline: true });
    assert.deepEqual(again.report.run.reusedBaselines, []);
    assert.equal(
      (await invocations(s.opts.cli)).length,
      4,
      'two equal "no git" are not the same code',
    );
    assert.ok(
      s.logs.some((l) => /cannot be identified outside a git checkout/.test(l)),
      s.logs.join('\n'),
    );
  } finally {
    await removeDir(s.root);
  }
});

test('a sealed repository is analysed afresh even when a baseline with the same sources and build is stored', async () => {
  const s = await scenario(spec(), { partition: 'sealed' });
  try {
    const first = await evaluate(s.opts);
    assert.equal(first.exitCode, 0, first.problems.join('\n'));
    s.logs.length = 0;
    const again = await evaluate({ ...s.opts, reuseBaseline: true });
    assert.deepEqual(again.report.run.reusedBaselines, []);
    assert.equal((await invocations(s.opts.cli)).length, 4, 'it was analysed again, not reused');
    assert.ok(
      s.logs.some((l) => /sealed, so analysed afresh/.test(l)),
      s.logs.join('\n'),
    );
  } finally {
    await removeDir(s.root);
  }
});

test('the build runs before anything is measured, and the sources are named after it', async () => {
  const order: string[] = [];
  const s = await scenario(spec(), {
    overrides: {
      build: async () => {
        order.push('build');
      },
      codeIdentity: async () => {
        order.push('codeId');
        return 'code-a';
      },
      scorerIdentity: async () => {
        order.push('scorer');
        return 'scorer-a';
      },
      log: (line) => {
        order.push(line);
      },
    },
  });
  try {
    const result = await evaluate(s.opts);
    assert.equal(result.exitCode, 0, result.problems.join('\n'));
    assert.deepEqual(order.slice(0, 3), ['build', 'codeId', 'scorer']);
    assert.ok(order.indexOf('tiny: copying the pinned tree') > 2, order.join('\n'));
  } finally {
    await removeDir(s.root);
  }
});

test('a build that fails stops the run before the CLI is run and before a report is written', async () => {
  const s = await scenario(spec(), {
    overrides: {
      build: async () => {
        throw new ConfigError('the build failed (simulated)');
      },
    },
  });
  try {
    await assert.rejects(evaluate(s.opts), /the build failed/);
    assert.deepEqual(await invocations(s.opts.cli), [], 'the CLI was not run');
    await assert.rejects(
      access(path.join(s.opts.outDir, 'report.json')),
      'and nothing was reported',
    );
  } finally {
    await removeDir(s.root);
  }
});

test("a sealed repository is analysed only with this repository's own build; a dev run records the CLI it used", async () => {
  const sealed = await scenario(spec(), { partition: 'sealed' });
  const dev = await scenario(spec({ contradictions: [A] }), { labels: { [ID_A]: tp() } });
  try {
    const elsewhereForSealed = await writeFakeCli(sealed.root, 'elsewhere/cli.mjs');
    await assert.rejects(
      evaluate({ ...sealed.opts, cli: elsewhereForSealed }),
      /sealed repository is measured only with this repository's own built CLI/,
    );
    assert.deepEqual(await invocations(elsewhereForSealed), [], 'the other CLI was never run');
    await assert.rejects(access(path.join(sealed.opts.outDir, 'report.json')));

    const elsewhere = await writeFakeCli(dev.root, 'elsewhere/cli.mjs');
    const result = await evaluate({ ...dev.opts, cli: elsewhere });
    assert.equal(result.exitCode, 0, result.problems.join('\n'));
    assert.deepEqual(
      [result.report.provenance.cli.path, result.report.provenance.cli.ownBuild],
      [elsewhere, false],
      'a dev run may use another CLI, and the report says so',
    );
  } finally {
    await removeDir(sealed.root);
    await removeDir(dev.root);
  }
});

test('a sealed repository is not analysed where the sources cannot be named', async () => {
  const sealed = await scenario(spec(), {
    partition: 'sealed',
    overrides: { codeIdentity: async () => NO_GIT },
  });
  try {
    await assert.rejects(evaluate(sealed.opts), /not measured outside a git checkout/);
    assert.deepEqual(await invocations(sealed.opts.cli), []);
  } finally {
    await removeDir(sealed.root);
  }
});

test('the report records the freeze, the sources, the scorer and the CLI build it measured', async () => {
  const s = await scenario(spec({ contradictions: [A] }), {
    labels: { [ID_A]: tp() },
    overrides: { scorerIdentity: async () => 'scorer-x' },
  });
  try {
    const frozen = await freezeAt(s, 'untouched');
    const result = await evaluate({ ...s.opts, ...frozen });
    assert.equal(result.exitCode, 0, result.problems.join('\n'));
    const root = frozen.root ?? s.root;
    const expected = {
      codeId: 'code-a',
      scorerDigest: 'scorer-x',
      sealedCorpusDigest: sealedCorpusDigest(await readFile(s.opts.corpusFile, 'utf8')),
      cli: { path: OWN_CLI_PATH, ownBuild: true, distDigest: await distDigest(root) },
    };
    assert.deepEqual(result.report.provenance, expected);

    const onDisk = JSON.parse(
      await readFile(path.join(s.opts.outDir, 'report.json'), 'utf8'),
    ) as Report;
    assert.deepEqual(onDisk.provenance, expected);
    assert.equal(onDisk.freeze.sha, result.report.freeze.sha);
    assert.equal(onDisk.schema, 8);

    const md = await readFile(path.join(s.opts.outDir, 'report.md'), 'utf8');
    for (const text of [
      result.report.freeze.sha ?? 'no freeze sha',
      'code-a',
      'scorer-x',
      expected.sealedCorpusDigest,
      expected.cli.distDigest,
      OWN_CLI_PATH,
    ]) {
      assert.ok(md.includes(text), `report.md names ${text}`);
    }
  } finally {
    await removeDir(s.root);
  }
});

test('the report records a digest of the sealed corpus entries the run used, the same one the freeze compares', async () => {
  const dev = await scenario(spec());
  const sealed = await scenario(spec(), { partition: 'sealed' });
  try {
    const devResult = await evaluate({ ...dev.opts, allowUnlabelled: true });
    const sealedResult = await evaluate({ ...sealed.opts, allowUnlabelled: true });
    assert.equal(
      sealedResult.report.provenance.sealedCorpusDigest,
      sealedCorpusDigest(await readFile(sealed.opts.corpusFile, 'utf8')),
    );
    assert.equal(
      devResult.report.provenance.sealedCorpusDigest,
      sealedCorpusDigest('[]'),
      'a corpus with no sealed entry digests as an empty one',
    );
    assert.notEqual(
      sealedResult.report.provenance.sealedCorpusDigest,
      devResult.report.provenance.sealedCorpusDigest,
    );
  } finally {
    await removeDir(dev.root);
    await removeDir(sealed.root);
  }
});

test('editing a source without building cannot produce a report attributed to the new sources', async () => {
  const s = await scenario(spec());
  const mono = path.join(s.root, 'mono');
  try {
    await writeMiniMonorepo(mono, 'before');
    const real: Partial<EvaluateOptions> = {
      root: mono,
      cli: path.join(mono, MINI_CLI),
      build: () => buildProduct(mono),
      codeIdentity: () => codeIdentity(mono),
      scorerIdentity: () => scorerIdentity(mono),
      allowUnlabelled: true,
    };
    const leftOf = async (): Promise<string> => {
      const stored = (await storedBaseline(s)) as { pipeline: { findings: { left: string }[] } };
      return stored.pipeline.findings[0]?.left ?? '';
    };

    const first = await evaluate({ ...s.opts, ...real });
    assert.equal(first.exitCode, 0, first.problems.join('\n'));
    assert.equal(await leftOf(), 'tiny:Column:before');
    const before = { codeId: await codeIdentity(mono), dist: await distDigest(mono) };
    assert.deepEqual(
      [first.report.provenance.codeId, first.report.provenance.cli.distDigest],
      [before.codeId, before.dist],
    );

    // The edit that used to slip through: the sources change, `dist/` does not.
    await writeFile(
      path.join(mono, 'packages', 'contradictions', 'src', 'index.ts'),
      miniDetectorSource('after'),
      'utf8',
    );
    assert.notEqual(await codeIdentity(mono), before.codeId, 'the sources are different now');
    assert.equal(await distDigest(mono), before.dist, 'and the compiled output is stale');

    const second = await evaluate({ ...s.opts, ...real });
    assert.equal(second.exitCode, 0, second.problems.join('\n'));
    assert.equal(await leftOf(), 'tiny:Column:after', 'the run measured the edited source');
    assert.equal(second.report.provenance.codeId, await codeIdentity(mono));
    assert.notEqual(second.report.provenance.codeId, before.codeId);
    assert.notEqual(second.report.provenance.cli.distDigest, before.dist, 'a different build');
    assert.equal((await storedBaseline(s))['codeId'], second.report.provenance.codeId);

    // A source that does not build is not measured at all.
    const reportFile = path.join(s.opts.outDir, 'report.json');
    const reported = await readFile(reportFile, 'utf8');
    await writeFile(
      path.join(mono, 'packages', 'contradictions', 'src', 'index.ts'),
      "export const MESSAGE: number = 'not a number';\n",
      'utf8',
    );
    await assert.rejects(evaluate({ ...s.opts, ...real }), /the build failed[\s\S]*error TS/);
    assert.equal(await readFile(reportFile, 'utf8'), reported, 'the earlier report is untouched');
  } finally {
    await removeDir(s.root);
  }
});
