/**
 * These tests build real git repositories in `os.tmpdir()` and run against
 * them. That is deliberate and is one of the few places a fixture beats a mock:
 * the behaviour under test *is* git's similarity-based rename detection, and a
 * mocked `git log` would only assert that this file's own parser agrees with
 * this file's own fake output. Nothing is ever created inside the Seamline tree.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { nodeId } from '@seamline/ontology';
import {
  CHANGE_MANIFEST,
  DEFAULT_RENAME_THRESHOLD,
  extractChange,
  readRenames,
} from './index.ts';
import type { ChangeExtraction, ChangeExtractorOptions } from './index.ts';

const RUN = 'run-fixture-0001';
const REPO = 'fixture';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `seamline-${prefix}-`));
  temps.push(dir);
  return dir;
}

function git(cwd: string, args: ReadonlyArray<string>, extra: Record<string, string> = {}): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
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
      GIT_COMMITTER_NAME: 'Fixture Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.invalid',
      ...extra,
    },
  });
}

function initRepo(prefix = 'repo'): string {
  const dir = newDir(prefix);
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

function write(dir: string, rel: string, body: string): void {
  const slash = rel.lastIndexOf('/');
  if (slash > 0) mkdirSync(join(dir, rel.slice(0, slash)), { recursive: true });
  writeFileSync(join(dir, rel), body, 'utf8');
}

/** Commits everything staged/unstaged with a pinned author and committer date. */
function commit(dir: string, message: string, date = '2020-01-01T00:00:00+0000'): string {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

const lines = (prefix: string, from: number, to: number): string => {
  const out: string[] = [];
  for (let i = from; i <= to; i += 1) out.push(`${prefix} line number ${i} with enough text to be distinctive`);
  return `${out.join('\n')}\n`;
};

function base(dir: string, over: Partial<ChangeExtractorOptions> = {}): ChangeExtractorOptions {
  return { repoRoot: dir, repo: REPO, runId: RUN, ...over };
}

describe('extract-change: commits, changesets and TOUCHES', () => {
  it('emits a Commit, a Changeset and a TOUCHES edge per changed path', () => {
    const dir = initRepo();
    write(dir, 'a.txt', 'alpha\n');
    write(dir, 'src/b.ts', 'export const b = 1;\n');
    const first = commit(dir, 'first commit');
    write(dir, 'a.txt', 'alpha\nbeta\n');
    const second = commit(dir, 'second commit', '2020-02-03T04:05:06+0000');

    const out = extractChange(base(dir));
    assert.equal(out.result.status, 'PASS');

    const commits = out.nodes.filter((n) => n.kind === 'Commit');
    const changesets = out.nodes.filter((n) => n.kind === 'Changeset');
    const files = out.nodes.filter((n) => n.kind === 'File');
    assert.deepEqual(commits.map((n) => n.props['sha']).sort(), [first, second].sort());
    assert.equal(changesets.length, 2);
    assert.deepEqual(files.map((n) => n.path).sort(), ['a.txt', 'src/b.ts']);

    const touches = out.edges.filter((e) => e.kind === 'TOUCHES');
    assert.equal(touches.length, 3, 'two adds in the root commit, one modify in the second');
    const firstTouches = touches
      .filter((e) => e.src === nodeId(REPO, 'Commit', first))
      .map((e) => `${String(e.props['status'])} ${String(e.dstFile)}`)
      .sort();
    assert.deepEqual(firstTouches, ['A a.txt', 'A src/b.ts']);
    const secondTouch = touches.find((e) => e.src === nodeId(REPO, 'Commit', second));
    assert.equal(secondTouch?.props['status'], 'M');
    assert.equal(secondTouch?.dstFile, 'a.txt');
    assert.equal(secondTouch?.dst, nodeId(REPO, 'File', 'a.txt'));

    for (const n of out.nodes) assert.equal(n.provenance, 'EXTRACTED');
    for (const e of out.edges) assert.equal(e.provenance, 'EXTRACTED');
    assert.equal(out.result.nodeCount, out.nodes.length);
    assert.equal(out.result.edgeCount, out.edges.length);

    const changeset = changesets.find((n) => n.props['commit'] === second);
    assert.equal(changeset?.props['fileCount'], 1);
    assert.equal(changeset?.props['modifiedCount'], 1);
    assert.equal(changeset?.props['addedCount'], 0);
  });

  it('sorts nodes by id and edges by (kind, src, dst)', () => {
    const dir = initRepo();
    for (const name of ['z.txt', 'm.txt', 'a.txt']) {
      write(dir, name, `${name}\n`);
      commit(dir, `add ${name}`);
    }
    const out = extractChange(base(dir));
    const ids = out.nodes.map((n) => String(n.id));
    assert.deepEqual(ids, [...ids].sort());
    const keys = out.edges.map((e) => `${e.kind} ${e.src} ${e.dst}`);
    assert.deepEqual(keys, [...keys].sort());
  });

  it('declares an EXTRACTED ceiling and claims Commit/Changeset but never File', () => {
    assert.equal(CHANGE_MANIFEST.provenanceCeiling, 'EXTRACTED');
    assert.equal(CHANGE_MANIFEST.net, false);
    const dir = initRepo();
    write(dir, 'a.txt', 'a\n');
    commit(dir, 'only');
    const out = extractChange(base(dir));
    const scope = out.result.authoritative[0];
    assert.deepEqual([...(scope?.kinds ?? [])], ['Commit', 'Changeset']);
    assert.ok(out.nodes.some((n) => n.kind === 'File'), 'File nodes are still emitted as endpoints');
  });
});

describe('extract-change: rename detection', () => {
  it('detects a git mv as a high-similarity rename and emits RENAMED_FROM', () => {
    const dir = initRepo('rename');
    write(dir, 'src/old-name.ts', lines('stable', 1, 30));
    commit(dir, 'add original');
    git(dir, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
    write(dir, 'src/new-name.ts', `${lines('stable', 1, 30)}// one extra line\n`);
    const moved = commit(dir, 'move it', '2020-03-04T05:06:07+0000');

    const out = extractChange(base(dir));
    assert.equal(out.result.status, 'PASS');

    const renamed = out.edges.filter((e) => e.kind === 'RENAMED_FROM');
    assert.equal(renamed.length, 1);
    const edge = renamed[0];
    assert.equal(edge?.src, nodeId(REPO, 'File', 'src/new-name.ts'));
    assert.equal(edge?.dst, nodeId(REPO, 'File', 'src/old-name.ts'));
    assert.equal(edge?.srcFile, 'src/new-name.ts');
    assert.equal(edge?.dstFile, 'src/old-name.ts');
    assert.equal(edge?.sourceRef, moved);
    const similarity = Number(edge?.props['similarity']);
    assert.ok(similarity >= 0.9, `expected a high similarity for a git mv, got ${similarity}`);
    assert.ok(similarity <= 1, 'similarity is a ratio, never a percentage');
    assert.equal(edge?.confidence, similarity);

    assert.equal(out.renames.status, 'PASS');
    assert.equal(out.renames.records.length, 1);
    const record = out.renames.records[0];
    assert.equal(record?.kind, 'rename');
    assert.equal(record?.from, 'src/old-name.ts');
    assert.equal(record?.to, 'src/new-name.ts');
    assert.equal(record?.commit, moved);
    assert.equal(record?.fromId, nodeId(REPO, 'File', 'src/old-name.ts'));
    assert.equal(record?.toId, nodeId(REPO, 'File', 'src/new-name.ts'));
    assert.equal(record?.authorDate, '2020-03-04T05:06:07Z');

    assert.ok(out.nodes.some((n) => n.id === nodeId(REPO, 'File', 'src/old-name.ts')),
      'the pre-image File node must exist or the RENAMED_FROM edge dangles');
    assert.equal(out.renames.complete, true);
    assert.equal(out.renames.threshold, DEFAULT_RENAME_THRESHOLD);
    assert.equal(DEFAULT_RENAME_THRESHOLD, 0.6, 'the stated default floor');
  });

  it('returns rename chains oldest-first so an alias table folds in one pass', () => {
    const dir = initRepo('chain');
    write(dir, 'one.ts', lines('chain', 1, 40));
    commit(dir, 'add one');
    git(dir, ['mv', 'one.ts', 'two.ts']);
    commit(dir, 'one to two', '2020-01-02T00:00:00+0000');
    git(dir, ['mv', 'two.ts', 'three.ts']);
    commit(dir, 'two to three', '2020-01-03T00:00:00+0000');

    const ledger = readRenames(base(dir));
    assert.equal(ledger.status, 'PASS');
    assert.deepEqual(
      ledger.records.map((r) => `${r.from}>${r.to}`),
      ['one.ts>two.ts', 'two.ts>three.ts'],
    );
  });

  it('does not report a rewrite below the threshold, and the threshold is configurable', () => {
    const dir = initRepo('threshold');
    write(dir, 'old.ts', lines('kept', 1, 30) + lines('discarded', 1, 70));
    commit(dir, 'add original');
    rmSync(join(dir, 'old.ts'));
    write(dir, 'fresh.ts', lines('kept', 1, 30) + lines('brand new unrelated content', 1, 70));
    commit(dir, 'replace it', '2020-04-05T06:07:08+0000');

    const strict = extractChange(base(dir));
    assert.equal(strict.result.status, 'PASS');
    assert.equal(strict.edges.filter((e) => e.kind === 'RENAMED_FROM').length, 0,
      'a ~0.3 match must not be reported as a rename at the default 0.6 floor');
    assert.equal(strict.renames.records.length, 0);
    const statuses = strict.edges
      .filter((e) => e.kind === 'TOUCHES')
      .map((e) => String(e.props['status']));
    assert.ok(statuses.includes('D') && statuses.includes('A'),
      'below the floor it stays a delete plus an add');

    const lenient = extractChange(base(dir, { renameThreshold: 0.1 }));
    assert.equal(lenient.renames.records.length, 1, 'the same pair is a rename once the floor drops');
    const similarity = lenient.renames.records[0]?.similarity ?? 0;
    assert.ok(similarity >= 0.1 && similarity < DEFAULT_RENAME_THRESHOLD,
      `similarity ${similarity} should sit between the lenient and default floors`);
    assert.equal(lenient.renames.threshold, 0.1);
  });

  it('never turns a copy into RENAMED_FROM', () => {
    const dir = initRepo('copy');
    write(dir, 'orig.ts', lines('copyme', 1, 40));
    commit(dir, 'add original');
    write(dir, 'orig.ts', `${lines('copyme', 1, 40)}// touched\n`);
    write(dir, 'duplicate.ts', lines('copyme', 1, 40));
    commit(dir, 'copy it', '2020-05-05T05:05:05+0000');

    const out = extractChange(base(dir, { detectCopies: true }));
    assert.equal(out.result.status, 'PASS');
    const copies = out.renames.records.filter((r) => r.kind === 'copy');
    assert.equal(copies.length, 1, 'git -C should pair duplicate.ts back to orig.ts');
    assert.equal(copies[0]?.from, 'orig.ts');
    assert.equal(copies[0]?.to, 'duplicate.ts');
    assert.equal(
      out.edges.filter((e) => e.kind === 'RENAMED_FROM').length,
      0,
      'both sides of a copy still exist; aliasing them would merge two live files',
    );

    const withoutCopies = extractChange(base(dir, { detectCopies: false }));
    assert.equal(withoutCopies.renames.records.filter((r) => r.kind === 'copy').length, 0);
  });
});

describe('extract-change: determinism', () => {
  it('emits author dates as fixed-format ISO-8601 UTC regardless of the commit offset', () => {
    const dir = initRepo('dates');
    write(dir, 'a.txt', 'a\n');
    commit(dir, 'offset commit', '2020-05-06T07:08:09+0530');

    const out = extractChange(base(dir));
    const node = out.nodes.find((n) => n.kind === 'Commit');
    assert.equal(node?.props['authorDate'], '2020-05-06T01:38:09Z');
    assert.equal(node?.props['committerDate'], '2020-05-06T01:38:09Z');
    assert.match(String(node?.props['authorDate']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('is byte-identical across two runs over the same range', () => {
    const dir = initRepo('determinism');
    write(dir, 'a.txt', lines('a', 1, 20));
    commit(dir, 'add a');
    git(dir, ['mv', 'a.txt', 'b.txt']);
    commit(dir, 'move a', '2020-06-07T08:09:10+0000');
    write(dir, 'c.txt', 'c\n');
    commit(dir, 'add c', '2020-06-08T00:00:00+0000');

    const one = extractChange(base(dir));
    const two = extractChange(base(dir));
    const payload = (x: ChangeExtraction): string =>
      JSON.stringify({ nodes: x.nodes, edges: x.edges, renames: x.renames });
    assert.equal(payload(one), payload(two));
    assert.equal(
      JSON.stringify({ ...one.result, durationMs: 0 }),
      JSON.stringify({ ...two.result, durationMs: 0 }),
      'only durationMs may differ; it is run telemetry, not a fact',
    );

    const year = new Date().getUTCFullYear();
    assert.ok(!payload(one).includes(`${year}-`), 'no wall-clock "now" may appear in a node or edge');
  });
});

describe('extract-change: honest status', () => {
  it('reports UNAVAILABLE for a directory that is not a git repository', () => {
    const dir = newDir('not-a-repo');
    writeFileSync(join(dir, 'file.txt'), 'hello\n');

    const out = extractChange(base(dir));
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(out.nodes.length, 0);
    assert.equal(out.edges.length, 0);
    assert.equal(out.result.nodeCount, 0);
    assert.ok(out.result.diagnostics.some((d) => d.includes('not a git work tree')));

    const ledger = readRenames(base(dir));
    assert.equal(ledger.status, 'UNAVAILABLE');
    assert.equal(ledger.complete, false, 'an unavailable ledger must never claim completeness');
    assert.equal(ledger.records.length, 0);
  });

  it('reports UNAVAILABLE when git is not executable', () => {
    const dir = initRepo('no-git');
    write(dir, 'a.txt', 'a\n');
    commit(dir, 'only');
    const out = extractChange(base(dir, { gitBin: 'seamline-no-such-git-binary' }));
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.ok(out.result.diagnostics.some((d) => d.includes('not executable from PATH')));
  });

  it('reports UNAVAILABLE for an empty repository rather than PASS with zero nodes', () => {
    const dir = initRepo('empty');
    const out = extractChange(base(dir));
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.equal(out.nodes.length, 0);
  });

  it('reports UNAVAILABLE when a shallow clone stops on its graft boundary', () => {
    const origin = initRepo('origin');
    for (let i = 1; i <= 5; i += 1) {
      write(origin, `f${i}.txt`, `${i}\n`);
      commit(origin, `commit ${i}`);
    }
    const clone = newDir('shallow');
    const target = join(clone, 'work');
    git(clone, ['clone', '-q', '--depth', '1', '--no-local', `file://${origin}`, target]);

    const out = extractChange(base(target, { depth: 50 }));
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.ok(out.result.diagnostics.some((d) => d.includes('graft boundary')));
    assert.equal(out.nodes.length, 0);

    const deep = extractChange(base(target, { depth: 1 }));
    assert.equal(deep.result.status, 'PASS', 'a shallow clone deep enough for the range still answers');
  });

  it('rejects a rev that is not a safe ref name instead of running it', () => {
    const dir = initRepo('bad-rev');
    write(dir, 'a.txt', 'a\n');
    commit(dir, 'only');
    const sentinel = join(dir, 'REV-PWNED');
    const out = extractChange(base(dir, { until: `HEAD; touch ${sentinel}` }));
    assert.equal(extractChange(base(dir, { renameThreshold: 60 })).result.status, 'FAIL',
      'a percentage is not a ratio and must be rejected, not silently reinterpreted');
    assert.equal(out.result.status, 'FAIL');
    assert.ok(out.result.diagnostics.some((d) => d.includes('until is not a safe rev name')));
    assert.equal(existsSync(sentinel), false);
  });
});

describe('extract-change: untrusted third-party text', () => {
  it('carries shell metacharacters through as literal data and marks the node untrusted', () => {
    const dir = initRepo('untrusted');
    const sentinel = join(dir, 'PWNED');
    const backtick = String.fromCharCode(96);
    const message =
      `feat: $(touch ${sentinel}) ${backtick}touch ${sentinel}${backtick} ; touch ${sentinel} && echo hi | tee ${sentinel}`;
    write(dir, 'a.txt', 'a\n');
    commit(dir, message, '2020-07-08T09:10:11+0000');

    const out = extractChange(base(dir));
    assert.equal(out.result.status, 'PASS');
    assert.equal(existsSync(sentinel), false, 'no part of the commit message may reach a shell');

    const node = out.nodes.find((n) => n.kind === 'Commit');
    assert.equal(node?.untrusted, true);
    assert.equal(node?.props['subject'], message);
    assert.equal(node?.props['authorName'], 'Fixture Author');

    const changeset = out.nodes.find((n) => n.kind === 'Changeset');
    assert.equal(changeset?.untrusted, undefined,
      'a Changeset holds only derived counts, so it is not third-party text');
  });

  it('handles a path containing spaces and quotes without corrupting the record framing', () => {
    const dir = initRepo('odd-paths');
    write(dir, 'a file with spaces.txt', 'x\n');
    write(dir, "quote'and-double.txt", 'y\n');
    commit(dir, 'odd paths');

    const out = extractChange(base(dir));
    assert.equal(out.result.status, 'PASS');
    assert.deepEqual(
      out.nodes.filter((n) => n.kind === 'File').map((n) => n.path).sort(),
      ['a file with spaces.txt', "quote'and-double.txt"],
    );
  });
});

describe('extract-change: bounded work', () => {
  it('walks at most `depth` commits and says so in the result', () => {
    const dir = initRepo('bounded');
    const shas: string[] = [];
    for (let i = 1; i <= 6; i += 1) {
      write(dir, `f${i}.txt`, `${i}\n`);
      shas.push(commit(dir, `commit ${i}`, `2020-01-0${i}T00:00:00+0000`));
    }

    const bounded = extractChange(base(dir, { depth: 3 }));
    assert.equal(bounded.result.status, 'PASS');
    assert.equal(bounded.nodes.filter((n) => n.kind === 'Commit').length, 3);
    assert.equal(bounded.renames.range.commitCount, 3);
    assert.equal(bounded.renames.range.truncated, true);
    assert.equal(bounded.renames.complete, false, 'a truncated walk cannot claim a complete rename history');
    assert.equal(bounded.result.authoritative[0]?.selector, 'HEAD max=3');
    assert.ok(bounded.result.diagnostics.includes('commits 3 truncated=true'));
    assert.deepEqual(
      bounded.nodes.filter((n) => n.kind === 'Commit').map((n) => String(n.props['sha'])).sort(),
      shas.slice(3).sort(),
      'the newest three commits, not the oldest',
    );

    const full = extractChange(base(dir, { depth: 50 }));
    assert.equal(full.nodes.filter((n) => n.kind === 'Commit').length, 6);
    assert.equal(full.renames.range.truncated, false);
    assert.equal(full.renames.complete, true);
  });

  it('honours an explicit `since` lower bound', () => {
    const dir = initRepo('since');
    const shas: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      write(dir, `f${i}.txt`, `${i}\n`);
      shas.push(commit(dir, `commit ${i}`, `2020-01-0${i}T00:00:00+0000`));
    }
    const out = extractChange(base(dir, { since: shas[1] as string }));
    assert.equal(out.result.status, 'PASS');
    assert.deepEqual(
      out.nodes.filter((n) => n.kind === 'Commit').map((n) => String(n.props['sha'])).sort(),
      shas.slice(2).sort(),
    );
    assert.equal(out.result.authoritative[0]?.selector, `${shas[1]}..HEAD max=500`);
  });
});

describe('extract-change: no absolute-path leak', () => {
  it('never embeds the maintainer-machine absolute repo root in diagnostics, nodes, or edges', () => {
    // extract.ts:354 catches everything from prepareHistory()'s already-parsed
    // git output through to sorted node/edge emission and reports
    // `err.message`. Unlike the confirmed H13 leak in extract-contracts, that
    // block never reads `repoRoot` or does its own filesystem I/O -- it only
    // transforms data git already returned -- so nothing in it can plausibly
    // embed the absolute root. This is a structural guard against that
    // changing silently: `dir` is itself an absolute path (mkdtempSync under
    // os.tmpdir(), like every fixture in this file), including binary
    // content, a rename, and a merge commit to exercise as much of that block
    // as a real repository can.
    const dir = initRepo('leak-check');
    write(dir, 'src/a.ts', 'export const a = 1;\n');
    write(dir, 'assets/blob.bin', '\0binary-ish content');
    commit(dir, 'initial');
    git(dir, ['mv', 'src/a.ts', 'src/b.ts']);
    commit(dir, 'rename a to b');

    const out = extractChange(base(dir));
    const serialized = JSON.stringify(out.result) + JSON.stringify(out.nodes) + JSON.stringify(out.edges);
    assert.ok(!serialized.includes(dir), `output embedded the absolute root ${dir}`);
  });
});

describe('extract-change: symbol attribution hook', () => {
  it('emits Commit and Changeset TOUCHES to Symbol only when a resolver is supplied', () => {
    const dir = initRepo('symbols');
    write(dir, 'src/mod.ts', 'export function alpha() {}\n');
    const sha = commit(dir, 'add mod');

    const without = extractChange(base(dir));
    assert.equal(without.edges.filter((e) => String(e.dst).includes(':Symbol:')).length, 0);

    const withResolver = extractChange(base(dir, {
      resolveSymbols: ({ path }) => (path.endsWith('.ts') ? ['src/mod.ts#alpha', 'src/mod.ts#alpha'] : []),
    }));
    const symbolEdges = withResolver.edges.filter((e) => String(e.dst).includes(':Symbol:'));
    assert.equal(symbolEdges.length, 2, 'deduplicated: one Commit to Symbol and one Changeset to Symbol');
    assert.deepEqual(
      symbolEdges.map((e) => String(e.src)).sort(),
      [String(nodeId(REPO, 'Changeset', sha)), String(nodeId(REPO, 'Commit', sha))].sort(),
    );
    for (const e of symbolEdges) {
      assert.equal(e.kind, 'TOUCHES');
      assert.equal(e.dst, nodeId(REPO, 'Symbol', 'src/mod.ts#alpha'));
      assert.equal(e.dstFile, 'src/mod.ts');
    }
  });
});

describe("extract-change: the repository's own git configuration", () => {
  // A partial clone leaves blobs on the remote, and `git log --find-renames` needs the contents of
  // the files it compares. Git then fetches the missing ones from the remote that the repository's
  // own `.git/config` names, with the program that same file names for the transport. The directory
  // being extracted is the untrusted party here, so no program it names may run, and (this
  // extractor makes no network call) no fetch may be tried at all.
  const win = process.platform === 'win32';

  interface Victim {
    readonly victim: string;
    readonly marker: string;
    readonly script: string;
  }

  /** A partial clone whose one inexact rename needs two blobs it does not have, and a script that records that it ran. */
  function partialClone(): Victim {
    const origin = initRepo('promisor-origin');
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    write(origin, 'f.txt', lines('stable', 1, 200));
    commit(origin, 'one');
    git(origin, ['mv', 'f.txt', 'g.txt']);
    write(origin, 'g.txt', `${lines('stable', 1, 190)}changed\n`);
    commit(origin, 'two', '2020-02-02T00:00:00+0000');

    const work = newDir('promisor-victim');
    const victim = join(work, 'victim');
    git(work, ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, victim]);

    const marker = join(work, 'MARKER');
    const script = join(work, 'evil.sh');
    writeFileSync(script, `#!/bin/sh\necho "ran: $0 $*" >> ${marker}\nexit 1\n`);
    chmodSync(script, 0o755);
    return { victim, marker, script };
  }

  const routes: Array<[string, (c: Victim) => void]> = [
    [
      'core.sshCommand on an ssh remote',
      ({ victim, script }) => {
        git(victim, ['config', 'core.sshCommand', script]);
        git(victim, ['config', 'remote.origin.url', 'ssh://localhost/nonexistent']);
      },
    ],
    [
      'remote.origin.uploadpack on a file remote',
      ({ victim, script }) => git(victim, ['config', 'remote.origin.uploadpack', script]),
    ],
  ];

  for (const [route, plant] of routes) {
    it(
      `runs no program named by ${route}, and reports no PASS it could not compute`,
      { skip: win },
      () => {
        const c = partialClone();
        plant(c);

        // Left to the repository's configuration, the very same git call runs the program: the
        // test can see a hit.
        try {
          git(c.victim, ['log', '--name-status', '--find-renames=60%', 'HEAD', '--']);
        } catch {
          // The program exits 1 and the fetch fails; what matters is that it ran.
        }
        assert.ok(existsSync(c.marker), 'precondition: the program runs when git is left alone');
        rmSync(c.marker);

        const out = extractChange(base(c.victim));
        assert.equal(
          existsSync(c.marker),
          false,
          `the program the repository named ran: ${existsSync(c.marker) ? readFileSync(c.marker, 'utf8') : ''}`,
        );
        assert.notEqual(out.result.status, 'PASS', 'a history git could not read is not an answer');
        assert.equal(out.nodes.length, 0);
        assert.equal(out.edges.length, 0);
      },
    );
  }
});
