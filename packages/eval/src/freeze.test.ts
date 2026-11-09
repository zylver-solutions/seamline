import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError } from './errors.ts';
import {
  codeIdentity,
  comparableManifest,
  FREEZE_WATCHED_PATHS,
  isWatched,
  NO_GIT,
  parseFreeze,
  readFreeze,
  scorerIdentity,
  sealedCorpusDigest,
  sealedEntriesDigest,
} from './freeze.ts';
import { runGit } from './git.ts';
import { commitFiles, makeTempDir, removeDir } from './testing.ts';

const DETECTOR = 'packages/contradictions/src/x1.ts';
const EXTRACTOR = 'packages/extract-data/src/discover.ts';

async function frozenRepo(): Promise<{ root: string; repo: string; sha: string; file: string }> {
  const root = await makeTempDir();
  const repo = path.join(root, 'repo');
  const sha = await commitFiles(
    repo,
    {
      [DETECTOR]: 'export const a = 1;\n',
      [EXTRACTOR]: 'export const b = 1;\n',
      'packages/contradictions/src/x1.test.ts': 'export const t = 1;\n',
      'docs/note.md': 'one\n',
    },
    'freeze',
    true,
  );
  return { root, repo, sha, file: path.join(root, 'FREEZE') };
}

test('parseFreeze takes one 40-hex commit id and ignores blank lines and comments', () => {
  const sha = 'a'.repeat(40);
  assert.equal(parseFreeze(`${sha}\n`), sha);
  assert.equal(parseFreeze(`# frozen for the v0.1 candidate\n\n${sha}\n\n`), sha);
  for (const bad of [
    '',
    '# only a comment\n',
    'abc123\n',
    `${sha}\n${sha}\n`,
    `${sha.toUpperCase()}\n`,
    'main\n',
  ]) {
    assert.throws(() => parseFreeze(bad), ConfigError, JSON.stringify(bad));
  }
});

test('no FREEZE file means none: sealed labels are not allowed yet', async () => {
  const f = await frozenRepo();
  try {
    const state = await readFreeze(f.file, f.repo);
    assert.deepEqual(state, { state: 'none', sha: null, changed: [] });
  } finally {
    await removeDir(f.root);
  }
});

test('a freeze with the detectors and extractors untouched is frozen', async () => {
  const f = await frozenRepo();
  try {
    await writeFile(f.file, `${f.sha}\n`, 'utf8');
    assert.deepEqual(await readFreeze(f.file, f.repo), {
      state: 'frozen',
      sha: f.sha,
      changed: [],
    });
  } finally {
    await removeDir(f.root);
  }
});

test('a committed detector or extractor change after the freeze burns it, and names the paths', async () => {
  const f = await frozenRepo();
  try {
    await writeFile(f.file, `${f.sha}\n`, 'utf8');
    await commitFiles(f.repo, { [DETECTOR]: 'export const a = 2;\n' }, 'tune a detector');
    await commitFiles(f.repo, { [EXTRACTOR]: 'export const b = 2;\n' }, 'tune an extractor');
    const state = await readFreeze(f.file, f.repo);
    assert.equal(state.state, 'burned');
    assert.deepEqual(state.changed, [EXTRACTOR, DETECTOR].sort());
  } finally {
    await removeDir(f.root);
  }
});

test('an uncommitted change to a detector burns it too', async () => {
  const f = await frozenRepo();
  try {
    await writeFile(f.file, `${f.sha}\n`, 'utf8');
    await writeFile(path.join(f.repo, DETECTOR), 'export const a = 3;\n', 'utf8');
    assert.equal((await readFreeze(f.file, f.repo)).state, 'burned');
  } finally {
    await removeDir(f.root);
  }
});

test('changes to tests, fixtures, and docs do not burn the sealed partition', async () => {
  const f = await frozenRepo();
  try {
    await writeFile(f.file, `${f.sha}\n`, 'utf8');
    await commitFiles(
      f.repo,
      {
        'packages/contradictions/src/x1.test.ts': 'export const t = 2;\n',
        'packages/contradictions/src/__fixtures__/a.ts': 'export const f = 1;\n',
        'docs/note.md': 'two\n',
        'packages/core/src/semantic/engine.ts': 'export const c = 1;\n',
      },
      'tests, a fixture, docs, and the optional semantic layer',
    );
    assert.equal((await readFreeze(f.file, f.repo)).state, 'frozen');
  } finally {
    await removeDir(f.root);
  }
});

test('a freeze that names a commit this repository does not have is an error, not a guess', async () => {
  const f = await frozenRepo();
  try {
    await writeFile(f.file, `${'b'.repeat(40)}\n`, 'utf8');
    await assert.rejects(readFreeze(f.file, f.repo), /not a commit in this repository's history/);
    await writeFile(f.file, 'not a sha\n', 'utf8');
    await assert.rejects(readFreeze(f.file, f.repo), ConfigError);
  } finally {
    await removeDir(f.root);
  }
});

interface CorpusRow {
  readonly name: string;
  readonly url?: string;
  readonly sha?: string;
  readonly partition: 'dev' | 'sealed';
  readonly license?: string;
  readonly why?: string;
}

const PIN = (n: number): string => n.toString(16).padStart(40, '0');

function corpusText(rows: readonly CorpusRow[], indent = 2): string {
  return `${JSON.stringify(
    rows.map((r) => ({
      name: r.name,
      url: r.url ?? `https://example.test/${r.name}.git`,
      sha: r.sha ?? PIN(1),
      license: r.license ?? 'MIT',
      partition: r.partition,
      stacks: ['ts'],
      why: r.why ?? 'a test input',
    })),
    null,
    indent,
  )}\n`;
}

const CORPUS_FILE_PATH = 'eval/corpus.json';
const BASE_CORPUS: readonly CorpusRow[] = [
  { name: 'alpha', partition: 'sealed', sha: PIN(1) },
  { name: 'beta', partition: 'sealed', sha: PIN(2) },
  { name: 'gamma', partition: 'dev', sha: PIN(3) },
];

async function corpusRepo(
  rows: readonly CorpusRow[] | string,
): Promise<{ root: string; repo: string; sha: string; file: string }> {
  const root = await makeTempDir();
  const repo = path.join(root, 'repo');
  const sha = await commitFiles(
    repo,
    {
      [DETECTOR]: 'export const a = 1;\n',
      [CORPUS_FILE_PATH]: typeof rows === 'string' ? rows : corpusText(rows),
    },
    'freeze',
    true,
  );
  const file = path.join(root, 'FREEZE');
  await writeFile(file, `${sha}\n`, 'utf8');
  return { root, repo, sha, file };
}

test('a change to a sealed entry of eval/corpus.json burns the partition: a pin, a url, a repository added, removed, or moved between partitions', async () => {
  const cases: ReadonlyArray<readonly [string, readonly CorpusRow[]]> = [
    [
      'a sealed commit pin changed',
      [{ name: 'alpha', partition: 'sealed', sha: PIN(9) }, ...BASE_CORPUS.slice(1)],
    ],
    [
      'a sealed url changed',
      [
        { name: 'alpha', partition: 'sealed', url: 'https://example.test/fork.git' },
        ...BASE_CORPUS.slice(1),
      ],
    ],
    [
      'a sealed repository moved to dev',
      [{ name: 'alpha', partition: 'dev', sha: PIN(1) }, ...BASE_CORPUS.slice(1)],
    ],
    [
      'a dev repository moved to sealed',
      [...BASE_CORPUS.slice(0, 2), { name: 'gamma', partition: 'sealed', sha: PIN(3) }],
    ],
    ['a sealed repository added', [...BASE_CORPUS, { name: 'delta', partition: 'sealed' }]],
    ['a sealed repository removed', BASE_CORPUS.slice(1)],
    [
      'a sealed repository renamed',
      [{ name: 'alpha-renamed', partition: 'sealed', sha: PIN(1) }, ...BASE_CORPUS.slice(1)],
    ],
  ];
  for (const [what, rows] of cases) {
    const f = await corpusRepo(BASE_CORPUS);
    try {
      assert.equal((await readFreeze(f.file, f.repo)).state, 'frozen', `${what}: before`);
      await writeFile(path.join(f.repo, CORPUS_FILE_PATH), corpusText(rows), 'utf8');
      const state = await readFreeze(f.file, f.repo);
      assert.deepEqual(
        [state.state, state.changed],
        ['burned', [CORPUS_FILE_PATH]],
        `${what}, uncommitted`,
      );
      await commitFiles(f.repo, {}, 'commit the change');
      assert.deepEqual(
        (await readFreeze(f.file, f.repo)).changed,
        [CORPUS_FILE_PATH],
        `${what}, committed`,
      );
    } finally {
      await removeDir(f.root);
    }
  }
});

test('a change to eval/corpus.json that leaves the sealed entries as they were does not burn: a dev repository, a license, a reason, the order, the formatting', async () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['a dev repository added', corpusText([...BASE_CORPUS, { name: 'delta', partition: 'dev' }])],
    ['a dev repository removed', corpusText(BASE_CORPUS.slice(0, 2))],
    [
      'a dev pin changed',
      corpusText([...BASE_CORPUS.slice(0, 2), { name: 'gamma', partition: 'dev', sha: PIN(9) }]),
    ],
    [
      'a sealed repository described differently',
      corpusText([
        { name: 'alpha', partition: 'sealed', sha: PIN(1), license: 'Apache-2.0', why: 'reworded' },
        ...BASE_CORPUS.slice(1),
      ]),
    ],
    ['the entries reordered', corpusText([...BASE_CORPUS].reverse())],
    ['the file reformatted', corpusText(BASE_CORPUS, 4)],
  ];
  for (const [what, text] of cases) {
    const f = await corpusRepo(BASE_CORPUS);
    try {
      await writeFile(path.join(f.repo, CORPUS_FILE_PATH), text, 'utf8');
      assert.deepEqual(
        await readFreeze(f.file, f.repo),
        {
          state: 'frozen',
          sha: f.sha,
          changed: [],
        },
        what,
      );
    } finally {
      await removeDir(f.root);
    }
  }
});

test('eval/corpus.json that is absent, or not a corpus, is compared without guessing', async () => {
  // No corpus at the freeze and none now: nothing sealed on either side.
  const none = await frozenRepo();
  try {
    await writeFile(none.file, `${none.sha}\n`, 'utf8');
    assert.equal((await readFreeze(none.file, none.repo)).state, 'frozen');
    await mkdir(path.join(none.repo, 'eval'), { recursive: true });
    await writeFile(
      path.join(none.repo, CORPUS_FILE_PATH),
      corpusText(BASE_CORPUS.slice(2)),
      'utf8',
    );
    assert.equal(
      (await readFreeze(none.file, none.repo)).state,
      'frozen',
      'a corpus with only dev entries is still no sealed entry',
    );
    await writeFile(path.join(none.repo, CORPUS_FILE_PATH), corpusText(BASE_CORPUS), 'utf8');
    assert.deepEqual((await readFreeze(none.file, none.repo)).changed, [CORPUS_FILE_PATH]);
  } finally {
    await removeDir(none.root);
  }

  // The corpus deleted after the freeze: the sealed pins are gone.
  const deleted = await corpusRepo(BASE_CORPUS);
  try {
    await rm(path.join(deleted.repo, CORPUS_FILE_PATH));
    assert.deepEqual((await readFreeze(deleted.file, deleted.repo)).changed, [CORPUS_FILE_PATH]);
  } finally {
    await removeDir(deleted.root);
  }

  // Text that is not JSON is compared as it is: unchanged is frozen, anything else burns.
  const broken = await corpusRepo('[ not json');
  try {
    assert.equal((await readFreeze(broken.file, broken.repo)).state, 'frozen');
    await writeFile(path.join(broken.repo, CORPUS_FILE_PATH), '[ not json either', 'utf8');
    assert.deepEqual((await readFreeze(broken.file, broken.repo)).changed, [CORPUS_FILE_PATH]);
    await writeFile(
      path.join(broken.repo, CORPUS_FILE_PATH),
      corpusText(BASE_CORPUS.slice(2)),
      'utf8',
    );
    assert.deepEqual(
      (await readFreeze(broken.file, broken.repo)).changed,
      [CORPUS_FILE_PATH],
      'a corpus that parses is not the unreadable one the freeze saw',
    );
  } finally {
    await removeDir(broken.root);
  }
});

test('sealedEntriesDigest names the sealed entries by name, url, commit and partition, whatever their order', () => {
  const text = (rows: readonly CorpusRow[]): string => sealedCorpusDigest(corpusText(rows));
  const base = text(BASE_CORPUS);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(text([...BASE_CORPUS].reverse()), base);
  assert.equal(sealedEntriesDigest(JSON.parse(corpusText(BASE_CORPUS))), base, 'parsed or not');
  assert.equal(text([...BASE_CORPUS, { name: 'delta', partition: 'dev' }]), base);
  assert.notEqual(text([...BASE_CORPUS, { name: 'delta', partition: 'sealed' }]), base);
  assert.notEqual(
    text([{ name: 'alpha', partition: 'sealed', sha: PIN(7) }, ...BASE_CORPUS.slice(1)]),
    base,
  );
  assert.notEqual(text(BASE_CORPUS.slice(0, 1)), text(BASE_CORPUS.slice(1, 2)));
  assert.match(sealedCorpusDigest('not json'), /^unreadable:[0-9a-f]{64}$/);
  assert.match(sealedEntriesDigest({ not: 'an array' }), /^unreadable:/);
});

/** A file that matches a watched pathspec: the file itself, or a new one under a directory. */
function concreteFile(spec: string): string {
  const concrete = spec.replaceAll('*', 'example');
  return path.posix.basename(spec).includes('.') ? concrete : `${concrete}/changed-here.ts`;
}

/** Paths that are not watched: nothing the CLI loads when it runs, the scorer, and the rest of the repository. */
const UNWATCHED = [
  'packages/core/src/semantic/engine.ts',
  'packages/cli/src/colour.ts',
  'packages/cli/src/bin.ts',
  'packages/cli/src/ports.ts',
  'packages/eval/src/report.ts',
  'packages/eval/src/metrics.ts',
  'packages/eval/src/labels.ts',
  'packages/eval/src/evaluate.ts',
  'packages/eval/src/freeze.ts',
  'packages/eval/src/bin.ts',
  'docs/note.md',
];

test('a change under each watched path burns the partition, and names that path', async () => {
  const files = FREEZE_WATCHED_PATHS.map(concreteFile);
  assert.equal(new Set(files).size, files.length, 'one concrete file per watched path');
  const f = await frozenRepo();
  try {
    const sha = await commitFiles(
      f.repo,
      Object.fromEntries(files.map((file) => [file, 'export const s = 1;\n'])),
      'every watched path',
    );
    await writeFile(f.file, `${sha}\n`, 'utf8');
    assert.equal((await readFreeze(f.file, f.repo)).state, 'frozen', 'nothing has changed yet');
    for (const file of files) {
      await writeFile(path.join(f.repo, ...file.split('/')), 'export const s = 2;\n', 'utf8');
      const state = await readFreeze(f.file, f.repo);
      assert.deepEqual([state.state, state.changed], ['burned', [file]], file);
      await writeFile(path.join(f.repo, ...file.split('/')), 'export const s = 1;\n', 'utf8');
    }
    assert.equal((await readFreeze(f.file, f.repo)).state, 'frozen', 'restored');
  } finally {
    await removeDir(f.root);
  }
});

test('a change under a path that cannot alter a finding does not burn the partition', async () => {
  const f = await frozenRepo();
  try {
    const sha = await commitFiles(
      f.repo,
      Object.fromEntries(UNWATCHED.map((file) => [file, 'export const s = 1;\n'])),
      'every unwatched path',
    );
    await writeFile(f.file, `${sha}\n`, 'utf8');
    for (const file of UNWATCHED) {
      assert.ok(!isWatched(file), `${file} is not covered by FREEZE_WATCHED_PATHS`);
      await writeFile(path.join(f.repo, ...file.split('/')), 'export const s = 2;\n', 'utf8');
    }
    const state = await readFreeze(f.file, f.repo);
    assert.deepEqual([state.state, state.changed], ['frozen', []]);
  } finally {
    await removeDir(f.root);
  }
});

test('isWatched agrees with the pathspecs git is given', () => {
  assert.equal(isWatched('packages/extract-data/src/a.ts'), true);
  assert.equal(isWatched('packages/extract-newthing/src/deep/a.ts'), true);
  assert.equal(isWatched('packages/core/src/store/sqlite-store.ts'), true);
  assert.equal(
    isWatched('packages/core/src/traversal/bounds.ts'),
    true,
    'loaded by the root barrel on every run, although no command calls it',
  );
  assert.equal(isWatched('packages/core/src/semantic/engine.ts'), false, 'never loaded');
  assert.equal(isWatched('packages/cli/src/commands/check.ts'), true);
  assert.equal(isWatched('packages/cli/src/commands/why.ts'), true, 'named by the dispatcher');
  assert.equal(isWatched('packages/cli/src/version.ts'), true);
  assert.equal(isWatched('packages/mcp/src/server.ts'), true, 'the mcp command imports it');
  assert.equal(isWatched('packages/cli/src/run.tsx'), false, 'a file, not a prefix');
  assert.equal(
    isWatched('packages/cli/src/commands-extra/x.ts'),
    false,
    'a directory, not a prefix',
  );
  assert.equal(isWatched('packages/cli/src/colour.ts'), false);
  assert.equal(isWatched('packages/cli/src/run.ts'), true, 'the dispatcher');
  assert.equal(isWatched('packages/cli/src/index.ts'), true, 'the entry the harness runs');
  assert.equal(isWatched('packages/core/src/index.ts'), true, 'the root barrel');
  assert.equal(isWatched('pnpm-lock.yaml'), true);
  assert.equal(isWatched('packages/extract-code-ts/package.json'), true);
  assert.equal(isWatched('packages/mcp/package.json'), true, 'every package manifest');
  assert.equal(isWatched('package.json'), true);
  assert.equal(isWatched('tsconfig.base.json'), true);
  assert.equal(isWatched('packages/core/tsconfig.json'), true);
  assert.equal(isWatched('packages/eval/src/workdir.ts'), true, 'the config the CLI reads');
  assert.equal(isWatched('packages/eval/src/pipeline.ts'), true, 'the argument vector and env');
  assert.equal(isWatched('packages/eval/src/findings.ts'), true, 'how output becomes findings');
  assert.equal(isWatched('packages/eval/src/metrics.ts'), false, 'the scorer');
  assert.equal(isWatched('package-lock.json'), false);
  assert.equal(isWatched('packages/cli/package.json.bak'), false, 'a file, not a prefix');
});

async function helperRepo(
  files: Readonly<Record<string, string>>,
): Promise<{ root: string; repo: string; file: string }> {
  const root = await makeTempDir();
  const repo = path.join(root, 'repo');
  const sha = await commitFiles(repo, files, 'freeze', true);
  const file = path.join(root, 'FREEZE');
  await writeFile(file, `${sha}\n`, 'utf8');
  return { root, repo, file };
}

test('a test helper that only tests import is inert, and one that production code imports is not', async () => {
  const helper = 'packages/core/src/store/testing.ts';
  const graph = 'packages/infer-join/src/test-graph.ts';
  const f = await helperRepo({
    [helper]: 'export const h = 1;\n',
    [graph]: "import { h } from '../../core/src/store/testing.ts';\nexport const g = h;\n",
    'packages/core/src/store/a.test.ts': "import { h } from './testing.ts';\nvoid h;\n",
    'packages/infer-join/src/b.test.ts': "import { g } from './test-graph.ts';\nvoid g;\n",
    'packages/core/src/store/real.ts': 'export const real = 1;\n',
  });
  const edit = async (file: string, text: string): Promise<void> =>
    writeFile(path.join(f.repo, ...file.split('/')), text, 'utf8');
  try {
    await edit(helper, 'export const h = 2;\n');
    await edit(
      graph,
      "import { h } from '../../core/src/store/testing.ts';\nexport const g = h + 1;\n",
    );
    assert.deepEqual(
      (await readFreeze(f.file, f.repo)).state,
      'frozen',
      'imported only by tests (and by another helper that only tests import)',
    );

    // Production code now imports the helper directly.
    await edit(
      'packages/core/src/store/real.ts',
      "import { h } from './testing.ts';\nexport const real = h;\n",
    );
    let state = await readFreeze(f.file, f.repo);
    assert.deepEqual(
      [state.state, state.changed],
      ['burned', [helper, 'packages/core/src/store/real.ts'].sort()],
    );

    // Production code imports the other helper, which imports this one: both are production.
    await edit('packages/core/src/store/real.ts', 'export const real = 1;\n');
    await edit(
      'packages/infer-join/src/real.ts',
      "import { g } from './test-graph.ts';\nexport const r = g;\n",
    );
    state = await readFreeze(f.file, f.repo);
    assert.deepEqual(
      [...state.changed].sort(),
      [graph, helper, 'packages/infer-join/src/real.ts'].sort(),
    );
  } finally {
    await removeDir(f.root);
  }
});

test('a helper of the same name in another directory that production does not import stays inert', async () => {
  const f = await helperRepo({
    'packages/core/src/store/testing.ts': 'export const h = 1;\n',
    'packages/core/src/merge/testing.ts': 'export const m = 1;\n',
    'packages/core/src/merge/real.ts': "import { m } from './testing.ts';\nexport const r = m;\n",
  });
  try {
    await writeFile(
      path.join(f.repo, 'packages/core/src/store/testing.ts'),
      'export const h = 2;\n',
      'utf8',
    );
    assert.equal(
      (await readFreeze(f.file, f.repo)).state,
      'frozen',
      "merge's importer is not store's",
    );
    await writeFile(
      path.join(f.repo, 'packages/core/src/merge/testing.ts'),
      'export const m = 2;\n',
      'utf8',
    );
    assert.deepEqual((await readFreeze(f.file, f.repo)).changed, [
      'packages/core/src/merge/testing.ts',
    ]);
  } finally {
    await removeDir(f.root);
  }
});

test('a production file git reports as binary still counts as importing a helper', async () => {
  const f = await helperRepo({
    'packages/core/src/store/testing.ts': 'export const h = 1;\n',
    'packages/core/src/store/real.ts':
      "import { h } from './testing.ts';\nexport const r = h;\n// \0\n",
  });
  try {
    await writeFile(
      path.join(f.repo, 'packages/core/src/store/testing.ts'),
      'export const h = 2;\n',
      'utf8',
    );
    assert.deepEqual((await readFreeze(f.file, f.repo)).changed, [
      'packages/core/src/store/testing.ts',
    ]);
  } finally {
    await removeDir(f.root);
  }
});

test('editor and merge leftovers under a watched path are inert', async () => {
  const f = await frozenRepo();
  try {
    await writeFile(f.file, `${f.sha}\n`, 'utf8');
    for (const leftover of [
      `${DETECTOR}.orig`,
      'packages/contradictions/src/.x1.ts.swp',
      `${DETECTOR}~`,
    ]) {
      await writeFile(path.join(f.repo, ...leftover.split('/')), 'x\n', 'utf8');
    }
    await writeFile(path.join(f.repo, ...DETECTOR.split('/')), 'export const a = 1;\n', 'utf8');
    assert.equal((await readFreeze(f.file, f.repo)).state, 'frozen');
    await writeFile(path.join(f.repo, 'packages/contradictions/src/x2.ts'), 'x\n', 'utf8');
    assert.equal((await readFreeze(f.file, f.repo)).state, 'burned', 'a real new file still burns');
  } finally {
    await removeDir(f.root);
  }
});

test('codeIdentity changes with a watched source and with nothing else', async () => {
  const f = await frozenRepo();
  const at = async (): Promise<string> => codeIdentity(f.repo);
  const write = async (file: string, text: string): Promise<void> => {
    await mkdir(path.dirname(path.join(f.repo, ...file.split('/'))), { recursive: true });
    await writeFile(path.join(f.repo, ...file.split('/')), text, 'utf8');
  };
  try {
    const base = await at();
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(await at(), base, 'stable');

    await write('packages/contradictions/src/x1.test.ts', 'export const t = 2;\n');
    await write('packages/contradictions/src/__fixtures__/a.ts', 'export const f = 1;\n');
    await write(`${DETECTOR}.orig`, 'x\n');
    await write('packages/core/src/semantic/engine.ts', 'export const b = 1;\n');
    await write('docs/note.md', 'two\n');
    assert.equal(await at(), base, 'tests, fixtures, leftovers, unwatched paths and docs');

    await write(DETECTOR, 'export const a = 2;\n');
    const changed = await at();
    assert.notEqual(changed, base, 'an edit to a detector');
    await write(DETECTOR, 'export const a = 1;\n');
    assert.equal(await at(), base, 'restored');

    await write('packages/extract-data/src/new.ts', 'export const n = 1;\n');
    assert.notEqual(await at(), base, 'a new untracked file under a watched path');
  } finally {
    await removeDir(f.root);
  }
});

test('a new untracked file under a watched path burns the partition, a test or ignored one does not', async () => {
  const f = await frozenRepo();
  try {
    await writeFile(f.file, `${f.sha}\n`, 'utf8');
    await writeFile(path.join(f.repo, '.gitignore'), 'scratch.ts\n', 'utf8');
    await commitFiles(f.repo, { 'docs/note.md': 'one\n' }, 'ignore file');
    const frozenSha = (await runGit(['rev-parse', 'HEAD'], f.repo)).trim();
    await writeFile(f.file, `${frozenSha}\n`, 'utf8');
    const watched = path.join(f.repo, 'packages', 'core', 'src', 'store');
    await mkdir(watched, { recursive: true });
    await writeFile(path.join(watched, 'a.test.ts'), 'export const t = 1;\n', 'utf8');
    await writeFile(path.join(watched, 'scratch.ts'), 'export const s = 1;\n', 'utf8');
    assert.equal((await readFreeze(f.file, f.repo)).state, 'frozen', 'a test and an ignored file');
    await writeFile(path.join(watched, 'new-scope.ts'), 'export const n = 1;\n', 'utf8');
    const state = await readFreeze(f.file, f.repo);
    assert.deepEqual(
      [state.state, state.changed],
      ['burned', ['packages/core/src/store/new-scope.ts']],
      'an untracked file git diff cannot see',
    );
  } finally {
    await removeDir(f.root);
  }
});

test('a staged rename of a watched file burns the partition, even to a name that is inert', async () => {
  const renames: ReadonlyArray<readonly [string, string]> = [
    [DETECTOR, `${DETECTOR}.orig`],
    [EXTRACTOR, EXTRACTOR.replace('.ts', '.test.ts')],
  ];
  for (const [from, to] of renames) {
    const f = await frozenRepo();
    try {
      await writeFile(f.file, `${f.sha}\n`, 'utf8');
      await runGit(['mv', from, to], f.repo);
      const state = await readFreeze(f.file, f.repo);
      assert.deepEqual([state.state, state.changed], ['burned', [from]], `${from} -> ${to}`);
    } finally {
      await removeDir(f.root);
    }
  }
});

const MANIFEST = 'packages/extract-data/package.json';

function manifest(
  version: string,
  yaml = '^2.9.1',
  order: 'types-first' | 'default-first' = 'types-first',
): string {
  const dot =
    order === 'types-first'
      ? { types: './dist/index.d.ts', default: './dist/index.js' }
      : { default: './dist/index.js', types: './dist/index.d.ts' };
  const body = { name: '@seamline/a', version, dependencies: { yaml }, exports: { '.': dot } };
  return `${JSON.stringify(body, null, 2)}\n`;
}

test('a package manifest burns the partition unless its version is all that changed', async () => {
  const root = await makeTempDir();
  const repo = path.join(root, 'repo');
  const sha = await commitFiles(
    repo,
    { [MANIFEST]: manifest('0.0.1'), [DETECTOR]: 'export const a = 1;\n' },
    'freeze',
    true,
  );
  const file = path.join(root, 'FREEZE');
  await writeFile(file, `${sha}\n`, 'utf8');
  const write = (rel: string, text: string): Promise<void> =>
    mkdir(path.dirname(path.join(repo, ...rel.split('/'))), { recursive: true }).then(() =>
      writeFile(path.join(repo, ...rel.split('/')), text, 'utf8'),
    );
  const stateOf = async (): Promise<string> => {
    const s = await readFreeze(file, repo);
    return `${s.state}${s.changed.length === 0 ? '' : ` ${s.changed.join(',')}`}`;
  };
  try {
    assert.equal(await stateOf(), 'frozen');

    await write(MANIFEST, manifest('0.1.0'));
    assert.equal(await stateOf(), 'frozen', 'a release bump of the version');

    await write(MANIFEST, JSON.stringify(JSON.parse(manifest('0.1.0'))));
    assert.equal(await stateOf(), 'frozen', 'the same manifest with other formatting');

    await write(MANIFEST, manifest('0.1.0', '^2.9.2'));
    assert.equal(await stateOf(), `burned ${MANIFEST}`, 'a dependency range (a routine bump)');

    await write(MANIFEST, manifest('0.0.1', '^2.9.1', 'default-first'));
    assert.equal(
      await stateOf(),
      `burned ${MANIFEST}`,
      'the order of export conditions decides which one resolves',
    );

    await write(MANIFEST, 'not json\n');
    assert.equal(await stateOf(), `burned ${MANIFEST}`, 'a manifest that is not JSON');

    await rm(path.join(repo, ...MANIFEST.split('/')));
    assert.equal(await stateOf(), `burned ${MANIFEST}`, 'a deleted manifest');

    await write(MANIFEST, manifest('0.0.1'));
    await write('packages/extract-new/package.json', '{}\n');
    assert.equal(await stateOf(), 'burned packages/extract-new/package.json', 'a new package');
  } finally {
    await removeDir(root);
  }
});

test('comparableManifest drops the version and nothing else', () => {
  assert.equal(
    comparableManifest('{"name":"a","version":"1.0.0","exports":{"b":1,"a":2}}'),
    '{"name":"a","exports":{"b":1,"a":2}}',
  );
  assert.equal(comparableManifest('{ "version" : "2" }'), '{}');
  assert.equal(comparableManifest('[1, 2]'), '[1, 2]');
  assert.equal(comparableManifest('oops'), 'oops');
});

async function mixedRepo(): Promise<{
  root: string;
  repo: string;
  write: (rel: string, text: string) => Promise<void>;
}> {
  const root = await makeTempDir();
  const repo = path.join(root, 'repo');
  await commitFiles(
    repo,
    {
      [DETECTOR]: 'export const a = 1;\n',
      [MANIFEST]: manifest('0.0.1'),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'packages/eval/src/pipeline.ts': 'export const p = 1;\n',
      'packages/eval/src/metrics.ts': 'export const m = 1;\n',
      'packages/eval/src/metrics.test.ts': 'export const t = 1;\n',
    },
    'tree',
    true,
  );
  const write = async (rel: string, text: string): Promise<void> => {
    await mkdir(path.dirname(path.join(repo, ...rel.split('/'))), { recursive: true });
    await writeFile(path.join(repo, ...rel.split('/')), text, 'utf8');
  };
  return { root, repo, write };
}

test('codeIdentity follows the lockfile, the manifests (not their version) and the harness run definition', async () => {
  const f = await mixedRepo();
  try {
    const base = await codeIdentity(f.repo);
    await f.write(MANIFEST, manifest('9.9.9'));
    await f.write('packages/eval/src/metrics.ts', 'export const m = 2;\n');
    await f.write('packages/eval/src/metrics.test.ts', 'export const t = 2;\n');
    assert.equal(await codeIdentity(f.repo), base, 'a version, the scorer, and a test');

    for (const [rel, text] of [
      ['pnpm-lock.yaml', 'lockfileVersion: 10\n'],
      [MANIFEST, manifest('0.0.1', '^2.9.2')],
      ['packages/eval/src/pipeline.ts', 'export const p = 2;\n'],
    ] as const) {
      const before = await codeIdentity(f.repo);
      await f.write(rel, text);
      assert.notEqual(await codeIdentity(f.repo), before, rel);
    }
  } finally {
    await removeDir(f.root);
  }
});

test('scorerIdentity follows the harness code the freeze does not watch, and nothing else', async () => {
  const f = await mixedRepo();
  try {
    const base = await scorerIdentity(f.repo);
    assert.match(base, /^[0-9a-f]{64}$/);
    await f.write(DETECTOR, 'export const a = 2;\n');
    await f.write('packages/eval/src/pipeline.ts', 'export const p = 2;\n');
    await f.write('packages/eval/src/metrics.test.ts', 'export const t = 2;\n');
    await f.write('pnpm-lock.yaml', 'lockfileVersion: 10\n');
    assert.equal(await scorerIdentity(f.repo), base, 'watched files and tests are not the scorer');

    await f.write('packages/eval/src/metrics.ts', 'export const m = 2;\n');
    const changed = await scorerIdentity(f.repo);
    assert.notEqual(changed, base, 'an edit to the scorer');
    await f.write('packages/eval/src/report.ts', 'export const r = 1;\n');
    assert.notEqual(await scorerIdentity(f.repo), changed, 'a new scorer file');
  } finally {
    await removeDir(f.root);
  }
});

test('outside a git checkout the identities say so, and never equal a real digest', async () => {
  const archive = await makeTempDir();
  const f = await mixedRepo();
  try {
    await mkdir(path.join(archive, 'packages', 'contradictions', 'src'), { recursive: true });
    await writeFile(path.join(archive, ...DETECTOR.split('/')), 'export const a = 1;\n', 'utf8');
    assert.equal(await codeIdentity(archive), NO_GIT);
    assert.equal(await scorerIdentity(archive), NO_GIT);
    // A directory inside another repository is not that repository's top level either.
    assert.equal(await codeIdentity(path.join(f.repo, 'packages')), NO_GIT);
    assert.match(await codeIdentity(f.repo), /^[0-9a-f]{64}$/);
  } finally {
    await removeDir(archive);
    await removeDir(f.root);
  }
});
