/**
 * Wiring-level regression tests.
 *
 * These are not extractor tests (each extractor package owns its own) and not
 * full `extractCommand` integration tests (`commands/extract.test.ts` owns
 * those with fakes). They cover exactly the seam this file exists to close:
 * the real packages actually agreeing with each other once wired together.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { after, test } from 'node:test';
import { nodeId } from '@seamline/ontology';
import type { ExtractorResult, GraphView, NodeId, NodeKind } from '@seamline/ontology';
import { MAX_ALIAS_CHAIN, SqliteStore } from '@seamline/core';
import { CODE_TS_SCOPE } from '@seamline/extract-code-ts';
import { DATA_SCOPE } from '@seamline/extract-data';
import { CONTRACTS_SCOPE } from '@seamline/extract-contracts';
import type { RenameLedger, RenameRecord } from '@seamline/extract-change';
import { REQUIRED_SCOPES } from '@seamline/infer-join';
import { secretCanary } from '@seamline/security/corpus';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from './config.ts';
import { bufferIo, EXIT_FINDINGS, EXIT_OK, systemClock } from './io.ts';
import { runCli } from './run.ts';
import { makeNode } from './testing.ts';
import { fileSnapshots } from './sif.ts';
import {
  buildCliDeps,
  changeExtractorPort,
  codeTsExtractorPort,
  dataExtractorPort,
  fileRenameAliases,
  gitPort,
  scopeAwareView,
  sqliteStorePort,
} from './wiring.ts';

test('infer-join REQUIRED_SCOPES names the real extractors\' authoritative scopes, not their package names', () => {
  // This is the exact bug this file's own comment above `scopeAwareView`
  // describes finding by wiring the real packages together: infer-join's
  // `REQUIRED_SCOPES` used to list extractor names ('extract-code-ts', ...)
  // rather than the `AuthoritativeScope.scope` strings those extractors
  // actually declare, so `graph.scopeStatus(...)` on any real store never
  // matched and `infer-join` was permanently UNAVAILABLE. If this assertion
  // ever fails again, `infer-join` will silently stop running against real
  // data the same way, with no test anywhere else positioned to catch it.
  assert.deepEqual(
    REQUIRED_SCOPES.slice().sort(),
    [CODE_TS_SCOPE, CONTRACTS_SCOPE, DATA_SCOPE].sort(),
  );
});

function fakeView(scopeStatus: Record<string, 'PASS' | 'FAIL' | 'UNAVAILABLE'>): GraphView {
  return {
    nodesByKind: () => [],
    node: () => undefined,
    edgesFrom: () => [],
    edgesTo: () => [],
    scopeStatus: (scope) => scopeStatus[scope] ?? 'UNAVAILABLE',
  };
}

function fakeResult(status: ExtractorResult['status'], scope: string, kinds: readonly NodeKind[] = []): ExtractorResult {
  return {
    extractor: scope,
    version: '0.0.1',
    status,
    authoritative: [{ scope, kinds }],
    nodeCount: 0,
    edgeCount: 0,
    durationMs: 0,
    diagnostics: [],
  };
}

test('scopeAwareView answers from this run\'s in-memory results before the persisted store', () => {
  // The persisted store has never heard of `code.ts` (as if `finalizeRun`
  // has not run yet for this run, which is exactly the situation `infer-join`
  // runs in mid-`extractCommand`) but this run's own loop already recorded a
  // PASS for it.
  const store = fakeView({});
  const view = scopeAwareView(store, [fakeResult('PASS', 'code.ts')]);
  assert.equal(view.scopeStatus('code.ts'), 'PASS');
});

test('scopeAwareView falls back to the store for a scope this run never touched', () => {
  const store = fakeView({ change: 'FAIL' });
  const view = scopeAwareView(store, [fakeResult('PASS', 'code.ts')]);
  assert.equal(view.scopeStatus('change'), 'FAIL', 'unrelated to this run, so the store\'s own status stands');
  assert.equal(view.scopeStatus('never-declared'), 'UNAVAILABLE');
});

test('scopeAwareView reflects a non-PASS result for this run, not just PASS', () => {
  const store = fakeView({ data: 'PASS' });
  const view = scopeAwareView(store, [fakeResult('UNAVAILABLE', 'data')]);
  assert.equal(view.scopeStatus('data'), 'UNAVAILABLE', 'this run\'s own outcome overrides a stale PASS');
});

// ---------------------------------------------------------------------------
// gitPort — real git subprocess calls against a real repository.
//
// Mirrors `extract-change`'s own test setup: the behaviour under test is
// git's own diff/status output, so a fixture beats a mock here. Nothing is
// ever created inside the Seamline tree itself.
// ---------------------------------------------------------------------------

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `seamline-${prefix}-`));
  temps.push(dir);
  return dir;
}

function git(cwd: string, args: readonly string[]): string {
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
    },
  });
}

function initRepo(): string {
  const dir = newDir('gitport');
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

function write(dir: string, rel: string, body: string): void {
  const slash = rel.lastIndexOf('/');
  if (slash > 0) mkdirSync(join(dir, rel.slice(0, slash)), { recursive: true });
  writeFileSync(join(dir, rel), body, 'utf8');
}

test('gitPort reports empty on a repo with no commits and no changes', async () => {
  const dir = initRepo();
  const files = await gitPort().changedFiles(dir);
  assert.deepEqual(files, []);
});

test('gitPort reports staged, unstaged, and untracked files, deduped and sorted', async () => {
  const dir = initRepo();
  write(dir, 'src/a.ts', 'export const a = 1;\n');
  write(dir, 'src/b.ts', 'export const b = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);

  // Staged: modify and `git add` a.ts.
  write(dir, 'src/a.ts', 'export const a = 2;\n');
  git(dir, ['add', 'src/a.ts']);
  // Unstaged: modify b.ts without adding it.
  write(dir, 'src/b.ts', 'export const b = 2;\n');
  // Untracked: a brand-new file.
  write(dir, 'src/c.ts', 'export const c = 1;\n');

  const files = await gitPort().changedFiles(dir);
  assert.deepEqual(files, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
});

test('gitPort omits gitignored untracked files', async () => {
  const dir = initRepo();
  write(dir, '.gitignore', 'ignored.ts\n');
  git(dir, ['add', '.gitignore']);
  git(dir, ['commit', '-q', '-m', 'init']);
  write(dir, 'ignored.ts', 'export const x = 1;\n');
  write(dir, 'tracked-new.ts', 'export const y = 1;\n');

  const files = await gitPort().changedFiles(dir);
  assert.deepEqual(files, ['tracked-new.ts']);
});

test('gitPort reports a clean tree as empty, not an error', async () => {
  const dir = initRepo();
  write(dir, 'src/a.ts', 'export const a = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);

  const files = await gitPort().changedFiles(dir);
  assert.deepEqual(files, []);
});

test('gitPort returns empty outside a git repository', async () => {
  const dir = newDir('not-a-repo');
  assert.equal(existsSync(join(dir, '.git')), false);
  const files = await gitPort().changedFiles(dir);
  assert.deepEqual(files, []);
});

// ---------------------------------------------------------------------------
// ADR-0011: sqliteStorePort() is the sole production construction site for a
// write-capable store, and it must never hand back the raw, unredacted one.
// `redacting-store.test.ts` (in `@seamline/core`) proves the decorator itself;
// these prove the *production wiring* specifically -- the thing that would
// actually ship a secret if this file ever regressed to `{ store, runs }`.
// ---------------------------------------------------------------------------

const CANARY = secretCanary('aws-access-key-id/documented-example').secret; // AWS's own documentation example key id.

test('sqliteStorePort never hands back the raw SqliteStore as Workspace.store', async () => {
  const outDir = newDir('store-identity');
  const workspace = await sqliteStorePort().open({ repoRoot: outDir, outDir, repo: 'demo', create: true });
  try {
    assert.equal(
      workspace.store instanceof SqliteStore,
      false,
      'Workspace.store must be the redacting wrapper, not the raw store -- ' +
        'a caller that got the raw store back could write an unredacted secret straight to disk',
    );
  } finally {
    await workspace.store.close();
  }
});

test('a secret written through sqliteStorePort() is absent from the actual on-disk database file', async () => {
  const outDir = newDir('store-secret-on-disk');
  const node = makeNode({
    kind: 'File',
    canonicalName: 'src/config.ts',
    props: { databaseUrl: `postgres://x:${CANARY}@host/db` },
  });

  const workspace = await sqliteStorePort().open({ repoRoot: outDir, outDir, repo: 'demo', create: true });
  await workspace.store.beginRun({
    runId: 'r1',
    repo: 'demo',
    commit: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    ontologyVersion: '1.0.0',
  });
  await workspace.store.upsertNodes('r1', [node]);
  await workspace.store.close();

  // Bypass the port entirely and read the real file `sqliteStorePort` wrote,
  // the way a compromised or careless second call site would have to if it
  // wanted to see what actually landed on disk.
  const raw = new SqliteStore({ path: join(outDir, 'graph.db') });
  try {
    const stored = raw.node(nodeId('demo', 'File', 'src/config.ts'));
    assert.ok(stored, 'the node exists on disk');
    const url = String(stored.props['databaseUrl']);
    assert.ok(!url.includes(CANARY), `the physical database file still contains the raw secret: ${url}`);
  } finally {
    await raw.close();
  }
});

// ---------------------------------------------------------------------------
// File aliases: extract-change's rename ledger, folded through core's alias
// table into `Alias` nodes and `ALIAS_OF` edges.
// ---------------------------------------------------------------------------

test('a file renamed across commits leaves an ALIAS_OF from each retired File id to the current one', async () => {
  const dir = initRepo();
  const pkg = { name: '@fixture/renames', version: '1.0.0', type: 'module' };
  write(dir, 'package.json', `${JSON.stringify(pkg)}\n`);
  const tsconfig = { compilerOptions: { strict: true, noEmit: true }, include: ['src'] };
  write(dir, 'tsconfig.json', `${JSON.stringify(tsconfig)}\n`);
  write(dir, 'src/old.ts', 'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'add old']);
  git(dir, ['mv', 'src/old.ts', 'src/mid.ts']);
  git(dir, ['commit', '-q', '-m', 'rename to mid']);
  git(dir, ['mv', 'src/mid.ts', 'src/new.ts']);
  git(dir, ['commit', '-q', '-m', 'rename to new']);
  const config = {
    ...defaultConfig('demo'),
    extractors: [
      { name: 'extract-code-ts', enabled: true, options: {} },
      { name: 'extract-change', enabled: true, options: {} },
    ],
  };
  writeFileSync(join(dir, CONFIG_FILENAME), serializeConfig(config), 'utf8');

  const outDir = newDir('alias-out');
  const io = bufferIo({ cwd: dir, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const code = await runCli(
    {
      io,
      clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-alias' },
      store: sqliteStorePort(),
      extractors: [codeTsExtractorPort(), changeExtractorPort()],
    },
    ['extract', '--out', outDir],
  );
  assert.equal(code, EXIT_OK, io.stderr());

  const current = nodeId('demo', 'File', 'src/new.ts');
  const store = new SqliteStore({ path: join(outDir, 'graph.db') });
  try {
    assert.equal(
      store.node(current)?.name,
      'src/new.ts',
      'the current File is live, as extract-code-ts stores it',
    );
    for (const retired of ['src/old.ts', 'src/mid.ts']) {
      const alias = nodeId('demo', 'Alias', `File::${retired}`);
      assert.equal(store.node(alias)?.kind, 'Alias', `an Alias node retires ${retired}`);
      // Follow ALIAS_OF the way a resolver would, bounded like the alias table.
      let at: NodeId = alias;
      let hops = 0;
      for (; hops < MAX_ALIAS_CHAIN; hops += 1) {
        const next = store.edgesFrom(at, 'ALIAS_OF');
        if (next.length === 0) break;
        assert.equal(next.length, 1, `${at} has one ALIAS_OF`);
        at = next[0]!.dst;
      }
      assert.equal(at, current, `${retired} resolves to the current path`);
      assert.equal(hops, 1, 'materialized aliases point straight at the resolved id');
    }
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// extract-change reads history, which the working tree does not contain, so a
// deterministic run id must see it too (`ExtractorPort.inputIdentity`).
// ---------------------------------------------------------------------------

function commitFixture(): string {
  const dir = newDir('history-id');
  const config = {
    ...defaultConfig('demo'),
    extractors: [{ name: 'extract-change', enabled: true, options: {} }],
  };
  write(dir, CONFIG_FILENAME, serializeConfig(config));
  write(dir, 'src/a.ts', 'export const a = 1;\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'first']);
  return dir;
}

async function deterministicRunIdOf(dir: string): Promise<string> {
  const io = bufferIo({ cwd: dir, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const code = await runCli(
    {
      io,
      clock: systemClock(io.env),
      store: sqliteStorePort(),
      extractors: [changeExtractorPort()],
    },
    ['extract', '--out', newDir('history-out'), '--json'],
  );
  assert.equal(code, EXIT_OK, io.stderr());
  return (JSON.parse(io.stdout()) as { runId: string }).runId;
}

test('a deterministic run over the same files but a different history gets a different run id', async () => {
  const dir = commitFixture();
  const before = await deterministicRunIdOf(dir);
  assert.equal(await deterministicRunIdOf(dir), before, 'nothing changed, so the id did not');

  // Same tree, one more commit: extract-change emits a new Commit for it.
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'second']);
  assert.notEqual(await deterministicRunIdOf(dir), before);
});

test('extract-change identifies its input by the commits it walks between', () => {
  const dir = commitFixture();
  const port = changeExtractorPort();
  const identity = (options: Record<string, unknown> = {}): string | null =>
    port.inputIdentity?.({ repoRoot: dir, options }) ?? null;

  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  assert.equal(identity(), `history:until=${head}:since=none`);
  assert.equal(identity({ until: 'main' }), identity(), 'a ref is identified by what it resolves to');
  assert.equal(identity({ since: head }), `history:until=${head}:since=${head}`);
  assert.equal(identity({ until: 'no-such-ref' }), 'history:until=unresolved:since=none');
  assert.equal(identity({ until: '--output=/tmp/x' }), 'history:until=invalid:since=none');

  const elsewhere = newDir('not-a-repo');
  assert.equal(
    port.inputIdentity?.({ repoRoot: elsewhere, options: {} }),
    'history:until=unresolved:since=none',
    'no repository and no commits are still a stable answer',
  );
});

// ---------------------------------------------------------------------------
// The CLI process runs git itself (the run id's history, the changed files), outside the sandbox.
// The repository must not be able to choose the program that is.
// ---------------------------------------------------------------------------

/** The git the operator's PATH finds when the repository has no say, found without the code under test. */
function systemGit(): string {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    try {
      accessSync(join(dir, 'git'), constants.X_OK);
      return join(dir, 'git');
    } catch {
      // not in this directory
    }
  }
  throw new Error('these tests need git on PATH');
}

/** Runs `fn` with this process's PATH replaced, which is what the CLI's own git lookup reads. */
async function withPath<T>(value: string, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env['PATH'];
  process.env['PATH'] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env['PATH'];
    else process.env['PATH'] = saved;
  }
}

test(
  'the CLI process runs the git outside the repository, whatever its PATH names inside it',
  { skip: process.platform === 'win32' },
  async () => {
    // A repository can ship a `git` where a PATH entry reaches it: a `bin` directory named by an
    // absolute entry, the `node_modules/.bin` that `npm run` puts first, an empty entry, `.`, a
    // relative entry, or a /proc name for the working directory. Each program here records that it
    // ran and then hands over to the real git, so a run that was fooled still looks right and only
    // the record tells.
    const dir = commitFixture();
    const head = git(dir, ['rev-parse', 'HEAD']).trim();
    const marker = join(newDir('planted-ran'), 'RAN');
    const real = systemGit();
    for (const where of ['bin/git', 'git', 'node_modules/.bin/git']) {
      write(dir, where, `#!/bin/sh\necho ran >> ${marker}\nexec ${real} "$@"\n`);
      chmodSync(join(dir, where), 0o755);
    }
    const port = changeExtractorPort();
    const original = process.env['PATH'] ?? '';
    const entries: Array<[string, string]> = [
      ['an absolute entry inside the repository', join(dir, 'bin')],
      ['the node_modules/.bin directory npm run puts first', join(dir, 'node_modules', '.bin')],
      ['an empty entry', ''],
      ['the dot entry', '.'],
      ['a relative entry', 'bin'],
    ];
    if (process.platform === 'linux') {
      entries.push(['a /proc name for the working directory', '/proc/self/cwd/bin']);
    }
    for (const [label, entry] of entries) {
      await withPath(`${entry}${delimiter}${original}`, async () => {
        rmSync(marker, { force: true });
        spawnSync('git', ['--version'], { cwd: dir });
        assert.ok(
          existsSync(marker),
          `${label}: precondition, started in the repository this PATH finds the planted program`,
        );
        rmSync(marker);

        assert.equal(
          port.inputIdentity?.({ repoRoot: dir, options: {} }),
          `history:until=${head}:since=none`,
          `${label}: the real git answered`,
        );
        assert.deepEqual(
          await gitPort().changedFiles(dir),
          ['bin/git', 'git', 'node_modules/.bin/git'],
          `${label}: the real git answered`,
        );
        assert.ok(!existsSync(marker), `${label}: the program the repository supplied ran`);
      });
    }

    // With no git outside the repository the answer is the one for "no git", and nothing runs.
    await withPath(join(dir, 'bin'), async () => {
      assert.equal(
        port.inputIdentity?.({ repoRoot: dir, options: {} }),
        'history:until=unresolved:since=none',
      );
      // No git is a failure to read the tree, not an empty tree.
      await assert.rejects(gitPort().changedFiles(dir), /no git was found on PATH outside the repository/);
      assert.ok(!existsSync(marker), 'the program the repository supplied ran');
    });
  },
);

test(
  "the CLI process's git fetches nothing and starts no transport program in a partial clone",
  { skip: process.platform === 'win32' },
  async () => {
    // `git diff --cached` pairs a deleted file with an added one by content, and a partial clone
    // does not have the deleted file's blob. Git fetches it from the remote the repository's own
    // config names, with the program that config names for the transport.
    const origin = initRepo();
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    const body = (n: number): string =>
      Array.from({ length: n }, (_, i) => `line ${i + 1} with some text`).join('\n') + '\n';
    write(origin, 'f.txt', body(200));
    git(origin, ['add', '.']);
    git(origin, ['commit', '-q', '-m', 'one']);

    const work = newDir('partial');
    const victim = join(work, 'victim');
    git(work, ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, victim]);
    // A no-checkout clone has an empty index, so adding only g.txt stages f.txt's deletion too.
    // Do not read HEAD into the index: older Git versions hydrate its missing blobs in read-tree,
    // defeating the transport attempt this negative control must exercise.
    write(work, 'g.txt', `${body(190)}changed\n`);
    const blob = git(victim, ['hash-object', '-w', join(work, 'g.txt')]).trim();
    git(victim, ['update-index', '--add', '--cacheinfo', `100644,${blob},g.txt`]);

    const marker = join(work, 'RAN');
    const script = join(work, 'evil.sh');
    writeFileSync(script, `#!/bin/sh\necho "ran: $0 $*" >> ${marker}\nexit 1\n`);
    chmodSync(script, 0o755);
    git(victim, ['config', 'core.sshCommand', script]);
    git(victim, ['config', 'remote.origin.url', 'ssh://localhost/nonexistent']);

    try {
      git(victim, ['diff', '--name-only', '--cached', 'HEAD']);
    } catch {
      // The fetch fails; what matters is that the program ran.
    }
    assert.ok(
      existsSync(marker),
      'precondition: left to the repository config, git runs the program',
    );
    rmSync(marker);

    // The fetch is not tried, so git cannot compare: that is reported, not read as "no changes".
    await assert.rejects(gitPort().changedFiles(victim), /cannot read the working tree/);
    assert.ok(
      !existsSync(marker),
      `the program the repository named ran: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`,
    );
  },
);

// A bundled extractor that runs in the sandbox must still tell the run id what it reads from
// outside the tree: the identity is computed by the CLI, not by the confined child.

test('the production wiring gives the sandboxed extract-change port the same input identity as the in-process one', () => {
  const dir = commitFixture();
  const wired = buildCliDeps(bufferIo({ cwd: dir, env: { PATH: process.env['PATH'] ?? '' } }));
  const port = (wired.extractors ?? []).find((e) => e.name === 'extract-change');
  assert.equal(port?.confinement, 'process-sandbox');

  const head = git(dir, ['rev-parse', 'HEAD']).trim();
  const options = { until: 'main' };
  assert.equal(port?.inputIdentity?.({ repoRoot: dir, options: {} }), `history:until=${head}:since=none`);
  assert.equal(
    port?.inputIdentity?.({ repoRoot: dir, options }),
    changeExtractorPort().inputIdentity?.({ repoRoot: dir, options }),
  );
  // The other bundled extractors read nothing from outside the tree.
  for (const other of (wired.extractors ?? []).filter((e) => e.name !== 'extract-change')) {
    assert.equal(other.inputIdentity, undefined, other.name);
  }
});

test('through the sandbox, a deterministic run over the same files but a different history gets a different run id', async () => {
  const dir = commitFixture();
  const runIdOf = async (): Promise<string> => {
    const io = bufferIo({
      cwd: dir,
      isTty: false,
      env: { SEAMLINE_DETERMINISTIC: '1', PATH: process.env['PATH'] ?? '' },
    });
    const outDir = newDir('sandboxed-history-out');
    const code = await runCli(buildCliDeps(io), [
      'extract',
      '--out',
      outDir,
      '--only',
      'extract-change',
      '--json',
    ]);
    assert.equal(code, EXIT_OK, io.stderr());
    const runId = (JSON.parse(io.stdout()) as { runId: string }).runId;
    const snapshot = await fileSnapshots().read(outDir, runId);
    const commit = snapshot.nodes.find(node => node.kind === 'Commit');
    assert.ok(commit, 'real history extractor output survives the strict shared SIF codec');
    assert.match(String(commit.props['authorDate']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(commit.props['authorDate'], git(dir, ['show', '-s', '--format=%aI', String(commit.props['sha'])]).trim().replace('+00:00', 'Z'));
    return runId;
  };
  const before = await runIdOf();
  assert.equal(await runIdOf(), before, 'nothing changed, so the id did not');
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'second']);
  assert.notEqual(await runIdOf(), before);
});

function renameRecord(kind: RenameRecord['kind'], from: string, to: string, commit: string): RenameRecord {
  return {
    kind,
    from,
    to,
    similarity: 0.9,
    commit,
    authorDate: '2020-01-01T00:00:00Z',
    fromId: nodeId('demo', 'File', from),
    toId: nodeId('demo', 'File', to),
  };
}

function ledgerOf(records: readonly RenameRecord[], status: RenameLedger['status'] = 'PASS'): RenameLedger {
  return {
    repo: 'demo',
    status,
    range: {
      since: null,
      until: 'HEAD',
      maxCount: 500,
      commitCount: 2,
      truncated: false,
      spec: 'HEAD max=500',
    },
    threshold: 0.6,
    complete: true,
    records,
    diagnostics: [],
  };
}

function aliasTargets(ledger: RenameLedger): Record<string, string> {
  const { nodes, edges } = fileRenameAliases(ledger, 'run-1');
  assert.equal(nodes.length, edges.length);
  return Object.fromEntries(edges.map((e) => [e.src, e.dst]));
}

test('a path a later rename moves back into place is live again, so only the other side is retired', () => {
  const targets = aliasTargets(
    ledgerOf([
      renameRecord('rename', 'src/a.ts', 'src/b.ts', 'c1'),
      renameRecord('rename', 'src/b.ts', 'src/a.ts', 'c2'),
    ]),
  );
  assert.deepEqual(targets, {
    [nodeId('demo', 'Alias', 'File::src/b.ts')]: nodeId('demo', 'File', 'src/a.ts'),
  });
});

test('a copy is never an alias, and a ledger that did not PASS yields none', () => {
  assert.deepEqual(aliasTargets(ledgerOf([renameRecord('copy', 'src/a.ts', 'src/b.ts', 'c1')])), {});
  assert.deepEqual(
    aliasTargets(ledgerOf([renameRecord('rename', 'src/a.ts', 'src/b.ts', 'c1')], 'UNAVAILABLE')),
    {},
  );
});

test('a rename whose path the identity layer refuses is reported, not aliased and not fatal', () => {
  const ledger = ledgerOf([
    renameRecord('rename', 'src/a\\b.ts', 'src/c.ts', 'c1'),
    renameRecord('rename', 'src/d.ts', 'src/e.ts', 'c2'),
  ]);
  const { edges, diagnostics } = fileRenameAliases(ledger, 'run-1');
  assert.deepEqual(
    edges.map((e) => e.dst),
    [nodeId('demo', 'File', 'src/e.ts')],
  );
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? '', /src\/a\\b\.ts -> src\/c\.ts not aliased: .*backslash/);
});

// ---------------------------------------------------------------------------
// Repository paths are identity. The entropy heuristic used to replace a long
// path with a `«redacted:sha256:...»` reference when it was a File id, which
// made the node unjoinable and its id differ from the path it names.
// ---------------------------------------------------------------------------

/** Real paths from this repository's own tree that tripped the rule (4.2..4.4 bits/char). */
const FORMERLY_HASHED_PATHS = [
  'docs/adr/ADR-0002-path-free-natural-key-identity.md',
  'docs/adr/ADR-0003-run-lifecycle-tombstones-status.md',
  'docs/adr/ADR-0008-oss-github-actions-exception.md',
  'docs/adr/ADR-0012-extensible-semantic-foundation.md',
  'docs/audit/2026-08-29-license-verification.md',
  'examples/harbor-books/db/migrations/0014_orders_shipping.sql',
  'packages/extract-data/src/__fixtures__/sql-migrations/db/migrations/10_tighten.sql',
  'packages/extract-data/src/__fixtures__/sql-migrations/db/migrations/1_init.sql',
  'packages/extract-data/src/__fixtures__/sql-migrations/db/migrations/2_add_phone.sql',
];

test('a File id is the repository path it names, however long and mixed the path is', async () => {
  const dir = initRepo();
  for (const p of FORMERLY_HASHED_PATHS) write(dir, p, '-- placeholder\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'add the paths']);
  const config = {
    ...defaultConfig('demo'),
    extractors: [{ name: 'extract-change', enabled: true, options: {} }],
  };
  writeFileSync(join(dir, CONFIG_FILENAME), serializeConfig(config), 'utf8');

  const outDir = newDir('long-path-out');
  const io = bufferIo({ cwd: dir, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const code = await runCli(
    {
      io,
      clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-long-paths' },
      store: sqliteStorePort(),
      extractors: [changeExtractorPort()],
    },
    ['extract', '--out', outDir],
  );
  assert.equal(code, EXIT_OK, io.stderr());

  const store = new SqliteStore({ path: join(outDir, 'graph.db') });
  try {
    for (const p of FORMERLY_HASHED_PATHS) {
      const file = store.node(nodeId('demo', 'File', p));
      assert.ok(file, `File ${p} is stored under its own id`);
      assert.equal(file.path, p);
      const touches = store.edgesTo(file.id, 'TOUCHES');
      assert.equal(touches.length, 1, `${p} is touched by one commit`);
      assert.equal(touches[0]?.dstFile, p);
    }
    assert.deepEqual(
      store
        .nodesByKind('File')
        .map((n) => String(n.id))
        .sort(),
      FORMERLY_HASHED_PATHS.map((p) => `demo:File:${p}`).sort(),
      'there is no File under any other id',
    );
  } finally {
    await store.close();
  }
  assert.ok(
    !readFileSync(join(outDir, 'graph.db')).includes('«redacted:'),
    'no reference replaced anything in this graph: none of these values is a secret',
  );
});

// ---------------------------------------------------------------------------
// extract-data options come straight from the JSON config. A `dialect` that is
// present and mistyped must reach the extractor, which refuses it, instead of
// being read as "not set" (a near miss that leaves the dialect-gated defaults
// off with nothing to say so).
// ---------------------------------------------------------------------------

async function extractDataWithDialect(dialect: unknown): Promise<{
  code: number;
  result: { status: string; nodeCount: number; diagnostics: string[] };
}> {
  const dir = newDir('data-dialect');
  const config = {
    ...defaultConfig('demo'),
    extractors: [
      { name: 'extract-data', enabled: true, options: dialect === undefined ? {} : { dialect } },
    ],
  };
  write(dir, CONFIG_FILENAME, serializeConfig(config));
  write(dir, 'db/schema.sql', 'CREATE TABLE lite (id INTEGER PRIMARY KEY, name TEXT);\n');
  const io = bufferIo({ cwd: dir, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const code = await runCli(
    {
      io,
      clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-dialect' },
      store: sqliteStorePort(),
      extractors: [dataExtractorPort()],
    },
    ['extract', '--out', newDir('data-dialect-out'), '--json'],
  );
  const report = JSON.parse(io.stdout()) as {
    results: { extractor: string; status: string; nodeCount: number; diagnostics: string[] }[];
  };
  const result = report.results.find((r) => r.extractor === 'extract-data');
  assert.ok(result !== undefined, io.stdout());
  return { code, result };
}

test('a dialect in seamline.config.json that is not a string fails the extract-data run, whatever its type', async () => {
  const shown: ReadonlyArray<readonly [unknown, string]> = [
    [['sqlite'], '["sqlite"]'],
    [3, '3'],
    [{ name: 'sqlite' }, '{"name":"sqlite"}'],
    [null, 'null'],
    [true, 'true'],
    ['sqlite3', '"sqlite3"'],
  ];
  for (const [value, text] of shown) {
    const { code, result } = await extractDataWithDialect(value);
    assert.equal(result.status, 'FAIL', text);
    assert.equal(result.nodeCount, 0, text);
    assert.deepEqual(
      result.diagnostics,
      [
        `invalid option: dialect ${text} is not one of clickhouse, mariadb, mysql, postgres, postgresql, sqlite`,
      ],
      text,
    );
    assert.equal(code, EXIT_FINDINGS, text);
  }
});

test('a dialect in seamline.config.json that is a supported string, or absent, runs extract-data', async () => {
  for (const value of [undefined, 'sqlite', 'SQLite', 'postgresql']) {
    const { code, result } = await extractDataWithDialect(value);
    assert.equal(result.status, 'PASS', String(value));
    assert.ok(result.nodeCount > 0, String(value));
    assert.equal(code, EXIT_OK, String(value));
  }
});
