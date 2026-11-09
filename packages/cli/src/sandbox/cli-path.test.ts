/**
 * The real `seamline extract` path goes through the sandbox.
 *
 * `host.test.ts` shows each control blocks what it should, using a purpose-built
 * probe. These tests show the controls are attached to the path a user's
 * command takes: `buildCliDeps` -> `runCli` -> `extractCommand` -> the bundled
 * extractors, with no extractor running anywhere but in a confined child.
 *
 *  - The children that `seamline extract` starts are observed as they are
 *    started (the arguments, the environment handed over, and on Linux the
 *    environment the kernel recorded for the process), not inferred from the
 *    code that starts them.
 *  - The graph a sandboxed run produces is byte-identical to the one the same
 *    extractors produce in process. The sandbox changes what an extractor may
 *    reach, never what it finds.
 *  - A host that cannot start a child does not quietly run the extractors in
 *    process: nothing passes.
 *  - A sandboxed failure on a second run replaces a first run's PASS for the
 *    scope instead of leaving it standing.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SqliteStore } from '@seamline/core';
import { runDetectors } from '@seamline/contradictions';
import type { ExtractorStatus } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig, type SeamlineConfig } from '../config.ts';
import { bufferIo, systemClock } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { runCli } from '../run.ts';
import { fileSnapshots } from '../sif.ts';
import type { ExtractReport } from '../commands/extract.ts';
import {
  buildCliDeps,
  changeExtractorPort,
  codeTsExtractorPort,
  contractsExtractorPort,
  dataExtractorPort,
  inferJoinExtractorPort,
  sqliteStorePort,
} from '../wiring.ts';
import { createSandboxHost, sandboxedPort, type SandboxProgram, type SpawnFn } from './host.ts';

const HARBOR_BOOKS = fileURLToPath(new URL('../../../../examples/harbor-books', import.meta.url));
const PROBE = fileURLToPath(new URL('../__fixtures__/sandbox/probe.ts', import.meta.url));
const IS_LINUX = process.platform === 'linux';

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `seamline-${prefix}-`));
  scratch.push(dir);
  return dir;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], {
    cwd,
    stdio: 'ignore',
    env: {
      PATH: process.env['PATH'] ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Tester',
      GIT_AUTHOR_EMAIL: 'tester@example.test',
      GIT_COMMITTER_NAME: 'Tester',
      GIT_COMMITTER_EMAIL: 'tester@example.test',
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  });
}

/**
 * The bundled example, as a real git repository with history, so `extract-change` has something to
 * read. In a fresh temporary directory, or at `into` when the caller wants it somewhere particular.
 */
function harborBooksWithHistory(into?: string, prepare?: (dir: string) => void): string {
  const dir = into ?? tempDir('cli-path-repo');
  cpSync(HARBOR_BOOKS, dir, { recursive: true });
  prepare?.(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  writeFileSync(join(dir, 'src', 'touched.ts'), 'export const touched = true;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'touch']);
  return dir;
}

interface Started {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string | undefined;
  /** What the kernel recorded as the child's environment, where /proc exists. */
  readonly environ: readonly string[] | undefined;
  /** Bounded crash evidence from this test's synthetic fixture children only. */
  readonly stderrTail: () => string;
}

function recordingSpawn(started: Started[]): SpawnFn {
  return (command, args, options) => {
    const child = spawn(command, args, options);
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192);
    });
    let environ: string[] | undefined;
    if (IS_LINUX && child.pid !== undefined) {
      try {
        environ = readFileSync(`/proc/${child.pid}/environ`, 'utf8')
          .split('\0')
          .filter((e) => e !== '');
      } catch {
        environ = undefined;
      }
    }
    started.push({
      args: [...args],
      env: { ...options.env },
      cwd: options.cwd === undefined ? undefined : String(options.cwd),
      environ,
      stderrTail: () => stderrTail,
    });
    return child;
  };
}

const CANARY = 'canary-aws-secret-for-the-cli-path-test';

function parentEnv(): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '/root',
    SEAMLINE_DETERMINISTIC: '1',
    AWS_SECRET_ACCESS_KEY: CANARY,
    SOPS_AGE_KEY: CANARY,
    NPM_TOKEN: CANARY,
  };
}

/** The first SIF line that differs, for a failure message a person can act on. */
function firstDifference(a: Buffer, b: Buffer): string {
  const left = a.toString('utf8').split('\n');
  const right = b.toString('utf8').split('\n');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (left[i] !== right[i])
      return `line ${i + 1}\n  in-process: ${(left[i] ?? '(none)').slice(0, 400)}\n  sandboxed:  ${(right[i] ?? '(none)').slice(0, 400)}`;
  }
  return 'no differing line';
}

async function extract(deps: CliDeps, io: ReturnType<typeof bufferIo>, repo: string, out: string) {
  const code = await runCli(deps, ['extract', '--repo', repo, '--out', out, '--json']);
  const report = JSON.parse(io.stdout()) as ExtractReport;
  return { code, report, stderr: io.stderr() };
}

describe('seamline extract / production wiring', () => {
  it('wires every bundled extractor as a sandboxed port, and not one in-process', () => {
    const deps = buildCliDeps(bufferIo({ env: parentEnv() }));
    assert.deepEqual(
      (deps.extractors ?? []).map((e) => [e.name, e.confinement]),
      [
        ['extract-code-ts', 'process-sandbox'],
        ['extract-data', 'process-sandbox'],
        ['extract-contracts', 'process-sandbox'],
        ['extract-change', 'process-sandbox'],
        ['infer-join', 'process-sandbox'],
      ],
    );
  });

  it('starts one confined child per extractor, with the credentials left behind', async () => {
    const repo = harborBooksWithHistory();
    const out = tempDir('cli-path-out');
    const started: Started[] = [];
    const io = bufferIo({ cwd: repo, env: parentEnv() });
    const deps = buildCliDeps(io, { sandbox: { spawn: recordingSpawn(started) } });

    const { code, report, stderr } = await extract(deps, io, repo, join(out, 'sandboxed'));
    assert.equal(code, 0, stderr);
    assert.deepEqual(
      report.results.map((r) => [r.extractor, r.status]),
      [
        ['extract-code-ts', 'PASS'],
        ['extract-data', 'PASS'],
        ['extract-contracts', 'PASS'],
        ['extract-change', 'PASS'],
        ['infer-join', 'PASS'],
      ],
    );

    assert.equal(started.length, 5, 'one child per configured extractor');
    for (const child of started) {
      assert.equal(child.args[0], '--permission', 'confined by the Node permission model');
      assert.ok(child.args.some((a) => a.startsWith('--allow-fs-read=')));
      for (const never of [
        '--allow-fs-write',
        '--allow-worker',
        '--allow-addons',
        '--allow-wasi',
      ]) {
        assert.ok(!child.args.some((a) => a.startsWith(never)), `${never} must never be granted`);
      }
      // cwd is the repo root, and no ancestor of it is readable.
      assert.equal(child.cwd, repo);
      const readable = child.args
        .filter((a) => a.startsWith('--allow-fs-read='))
        .map((a) => a.slice('--allow-fs-read='.length));
      for (const path of readable)
        assert.ok(path !== '/' && path !== tmpdir(), `${path} is too broad`);
      // Credentials stay behind; the synthetic HOME is not the real one.
      for (const [name, value] of Object.entries(child.env)) {
        assert.notEqual(value, CANARY, `${name} carries the canary`);
      }
      assert.equal(child.env['AWS_SECRET_ACCESS_KEY'], undefined);
      assert.equal(child.env['NPM_TOKEN'], undefined);
      assert.notEqual(child.env['HOME'], parentEnv()['HOME']);
      if (child.environ !== undefined) {
        assert.ok(
          !child.environ.some((e) => e.includes(CANARY)),
          'the kernel recorded the canary in the child',
        );
        assert.ok(
          !child.environ.some((e) => e.startsWith('HOME=') && e === `HOME=${parentEnv()['HOME']}`),
        );
      }
    }
    // Memory caps come from each manifest. `extract-data` starts first (the data-model index it
    // publishes is an input of the code extractor), then the rest in config order: code-ts,
    // contracts, change, infer-join.
    assert.deepEqual(
      started.map((c) => c.args.find((a) => a.startsWith('--max-old-space-size='))),
      [
        '--max-old-space-size=512',
        '--max-old-space-size=2048',
        '--max-old-space-size=512',
        '--max-old-space-size=256',
        '--max-old-space-size=512',
      ],
    );
    // Only extract-change may start a process (git); infer-join reads no repository file at all.
    assert.deepEqual(
      started.map((c) => c.args.includes('--allow-child-process')),
      [false, false, false, true, false],
    );
    assert.deepEqual(
      started.map((c) => c.args.includes(`--allow-fs-read=${repo}`)),
      [true, true, true, true, false],
    );
  });

  it('finds exactly what the same extractors find in process', async () => {
    const repo = harborBooksWithHistory();
    const out = tempDir('cli-path-equal');

    const inProcessIo = bufferIo({ cwd: repo, env: parentEnv() });
    const inProcess: CliDeps = {
      io: inProcessIo,
      clock: systemClock(inProcessIo.env),
      store: sqliteStorePort(),
      extractors: [
        codeTsExtractorPort(),
        dataExtractorPort(),
        contractsExtractorPort(),
        changeExtractorPort(),
        inferJoinExtractorPort(),
      ],
      snapshots: fileSnapshots(),
    };
    // In process an extractor reads the real process.env (`extract-contracts` zeroes its duration from
    // SEAMLINE_DETERMINISTIC itself); a sandboxed one is handed the variable its manifest declares.
    const saved = process.env['SEAMLINE_DETERMINISTIC'];
    process.env['SEAMLINE_DETERMINISTIC'] = '1';
    let a: Awaited<ReturnType<typeof extract>>;
    try {
      a = await extract(inProcess, inProcessIo, repo, join(out, 'in-process'));
    } finally {
      if (saved === undefined) delete process.env['SEAMLINE_DETERMINISTIC'];
      else process.env['SEAMLINE_DETERMINISTIC'] = saved;
    }
    assert.equal(a.code, 0, a.stderr);

    const sandboxedIo = bufferIo({ cwd: repo, env: parentEnv() });
    const b = await extract(buildCliDeps(sandboxedIo), sandboxedIo, repo, join(out, 'sandboxed'));
    assert.equal(b.code, 0, b.stderr);

    assert.deepEqual(
      b.report.results.map((r) => [r.extractor, r.status, r.nodeCount, r.edgeCount]),
      a.report.results.map((r) => [r.extractor, r.status, r.nodeCount, r.edgeCount]),
    );
    // The deterministic run id is derived from the run's inputs, extract-change's history included
    // (`ExtractorPort.inputIdentity`). The same id from both ports shows the sandboxed one
    // contributes the same inputs as the in-process one.
    assert.equal(b.report.runId, a.report.runId);
    const inProcessSif = readFileSync(join(out, 'in-process', 'runs', `${a.report.runId}.sif`));
    const sandboxedSif = readFileSync(join(out, 'sandboxed', 'runs', `${b.report.runId}.sif`));
    assert.ok(inProcessSif.length > 10_000, 'precondition: the snapshot has content');
    assert.ok(
      sandboxedSif.equals(inProcessSif),
      `the SIF snapshots differ: ${firstDifference(inProcessSif, sandboxedSif)}`,
    );
  });

  it('runs nothing, and passes nothing, when no child can be started', async () => {
    const repo = harborBooksWithHistory();
    const out = tempDir('cli-path-nospawn');
    const io = bufferIo({ cwd: repo, env: parentEnv() });
    const deps = buildCliDeps(io, {
      sandbox: {
        spawn: () => {
          throw new Error('EAGAIN: cannot fork');
        },
      },
    });
    const { code, report } = await extract(deps, io, repo, out);
    assert.equal(
      code,
      0,
      'UNAVAILABLE alone does not fail the run, as for any extractor that cannot run',
    );
    assert.deepEqual(
      report.results.map((r) => r.status),
      ['UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE'],
    );
    assert.equal(report.totals.nodes, 0);
    assert.equal(report.totals.edges, 0);
    assert.deepEqual(report.degradedScopes, [
      'change',
      'code.ts',
      'contracts',
      'data',
      'infer-join',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A sandboxed failure replaces an earlier PASS
// ---------------------------------------------------------------------------

describe('seamline extract / a sandboxed failure never leaves a stale PASS standing', () => {
  const NAME = 'extract-data';

  function probeProgram(timeoutS: number): SandboxProgram {
    return {
      manifest: {
        name: NAME,
        version: '0.0.1',
        reads: ['src/**'],
        net: false,
        env: [],
        memMb: 256,
        timeoutS,
        provenanceCeiling: 'EXTRACTED',
        produces: [{ scope: 'data', kinds: ['File'] }],
      },
      module: PROBE,
      packages: [],
      codeRoots: [join(PROBE, '..')],
    };
  }

  async function run(
    repo: string,
    outDir: string,
    runId: string,
    program: SandboxProgram,
    options: Record<string, unknown>,
  ) {
    const config: SeamlineConfig = {
      ...defaultConfig('probe'),
      extractors: [
        { name: NAME, enabled: true, options: { name: NAME, scope: 'data', ...options } },
      ],
    };
    writeFileSync(join(repo, CONFIG_FILENAME), serializeConfig(config), 'utf8');
    const io = bufferIo({
      cwd: repo,
      env: { PATH: process.env['PATH'] ?? '', SEAMLINE_DETERMINISTIC: '1' },
    });
    const deps: CliDeps = {
      io,
      clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => runId },
      store: sqliteStorePort(),
      extractors: [sandboxedPort(createSandboxHost({ env: io.env }), program)],
    };
    return extract(deps, io, repo, outDir);
  }

  it("reads FAIL, keeps the first run's node, and leaves detectors over the scope UNKNOWN", async () => {
    const repo = tempDir('stale-repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.txt'), 'declared-content\n');
    const outDir = join(tempDir('stale-out'), 'out');

    // Run 1: the extractor passes, and the scope is PASS.
    const first = await run(repo, outDir, 'run-1', probeProgram(60), {
      mode: 'ok',
      path: 'src/a.txt',
    });
    assert.equal(first.report.results[0]?.status, 'PASS', JSON.stringify(first.report.results));
    const orphanedMigration = (status: ExtractorStatus) => {
      const store = new SqliteStore({ path: join(outDir, 'graph.db') });
      try {
        assert.equal(store.scopeStatus('data'), status);
        const report = runDetectors(store);
        const answer = report.detectors.find((d) => d.code === 'X8_ORPHANED_MIGRATION');
        assert.ok(answer);
        return { outcome: answer.outcome, reason: answer.result.known ? null : answer.result.reason };
      } finally {
        void store.close();
      }
    };
    const before = orphanedMigration('PASS');
    assert.equal(before.outcome, 'unknown');
    assert.match(before.reason ?? '', /no bounded current migration replay inventory/,
      'this probe emits a File, so a PASS scope alone cannot certify migration history');

    // Run 2: the same extractor hangs and is killed at its timeout.
    const second = await run(repo, outDir, 'run-2', probeProgram(1), { mode: 'busy' });
    const result = second.report.results[0];
    assert.equal(result?.status, 'FAIL');
    assert.match(result?.diagnostics[0] ?? '', /\[timeout\]/);
    assert.deepEqual(second.report.degradedScopes, ['data']);

    // The earlier PASS is gone. The reason must now name the scope failure,
    // rather than retaining the first run's certificate-only uncertainty.
    const after = orphanedMigration('FAIL');
    assert.equal(after.outcome, 'unknown');
    assert.match(after.reason ?? '', /data=FAIL/);

    // Failing did not delete anything: no tombstone from a run that did not pass.
    const store = new SqliteStore({ path: join(outDir, 'graph.db') });
    try {
      const survivors = store.nodesByKind('File').map((n) => n.name);
      assert.deepEqual(survivors, ['probe:File:src/a.txt']);
    } finally {
      await store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// A file replaced by a link that leaves the repo
// ---------------------------------------------------------------------------

describe('seamline extract / a source file replaced by an outbound link between two runs', () => {
  it('does not PASS and tombstone what the file held', { skip: !IS_LINUX }, async () => {
    const repo = tempDir('swap-repo');
    const outside = tempDir('swap-outside');
    const outDir = join(tempDir('swap-out'), 'out');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'seamline.config.json'),
      serializeConfig(defaultConfig('swap')),
      'utf8',
    );
    writeFileSync(
      join(repo, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
        },
        include: ['src'],
      }),
    );
    writeFileSync(join(repo, 'src', 'keep.ts'), 'export const keep = 1;\n');
    const validator = 'export function validator(v: string): boolean { return v.length > 0; }\n';
    writeFileSync(join(repo, 'src', 'validator.ts'), validator);
    writeFileSync(join(outside, 'validator.ts'), validator);

    const runOnce = async () => {
      const io = bufferIo({ cwd: repo, env: { PATH: process.env['PATH'] ?? '', HOME: '/root' } });
      const deps = buildCliDeps(io, {});
      const code = await runCli(deps, [
        'extract',
        '--repo',
        repo,
        '--out',
        outDir,
        '--only',
        'extract-code-ts',
        '--json',
      ]);
      return { code, report: JSON.parse(io.stdout()) as ExtractReport };
    };
    const store = async <T>(read: (s: SqliteStore) => T): Promise<T> => {
      const s = new SqliteStore({ path: join(outDir, 'graph.db') });
      try {
        return read(s);
      } finally {
        await s.close();
      }
    };
    const livePaths = (s: SqliteStore) =>
      s
        .nodesByKind('File')
        .map((n) => n.path)
        .sort();

    const first = await runOnce();
    assert.equal(first.report.results[0]?.status, 'PASS', JSON.stringify(first.report.results));
    assert.deepEqual(await store(livePaths), ['src/keep.ts', 'src/validator.ts']);

    // Between the runs the file becomes a link to a copy outside the repo.
    rmSync(join(repo, 'src', 'validator.ts'));
    symlinkSync(join(outside, 'validator.ts'), join(repo, 'src', 'validator.ts'));
    const second = await runOnce();

    const result = second.report.results[0];
    assert.equal(
      result?.status,
      'FAIL',
      `a PASS here would tombstone src/validator.ts: ${JSON.stringify(result)}`,
    );
    assert.match(result?.diagnostics.join('\n') ?? '', /\[symlink-escape\].*src\/validator\.ts/);
    assert.deepEqual(second.report.degradedScopes, ['code.ts']);
    assert.equal(second.code, 1, 'the command reports the failure');
    // Nothing was forgotten and the scope no longer reads PASS.
    assert.deepEqual(await store(livePaths), ['src/keep.ts', 'src/validator.ts']);
    assert.equal(await store((s) => s.scopeStatus('code.ts')), 'FAIL');
  });
});

// ---------------------------------------------------------------------------
// A repository reached through a symlinked directory
// ---------------------------------------------------------------------------

describe('seamline extract / a repository reached through a symlinked directory', () => {
  // The usual shapes are a checkout under macOS `/tmp` or `/var`, which are links, and a workspace
  // mounted through a link. The child's working directory is always the real path, so a grant of
  // the path as named would not cover what the child reads.
  it(
    'passes every bundled extractor and produces the bytes the real path produces',
    { skip: !IS_LINUX },
    async () => {
      const world = tempDir('cli-path-link');
      const realParent = join(world, 'real-parent');
      mkdirSync(realParent);
      const real = harborBooksWithHistory(join(realParent, 'repo'));
      const linkParent = join(world, 'link-parent');
      symlinkSync(realParent, linkParent);
      const viaLink = join(linkParent, 'repo');
      const out = tempDir('cli-path-link-out');

      const through = async (repo: string, name: string) => {
        const started: Started[] = [];
        const io = bufferIo({ cwd: world, env: parentEnv() });
        const deps = buildCliDeps(io, { sandbox: { spawn: recordingSpawn(started) } });
        const run = await extract(deps, io, repo, join(out, name));
        return { ...run, started };
      };
      const direct = await through(real, 'real');
      const linked = await through(viaLink, 'linked');

      const outcomes = (r: typeof direct) => ({
        results: r.report.results.map((x) => [x.extractor, x.status, x.diagnostics.join(' | ')]),
        childStderr: r.started.map((child, index) => ({ index, tail: child.stderrTail() }))
          .filter((child) => child.tail !== ''),
      });
      const statuses = (r: typeof direct) => r.report.results.map((x) => [x.extractor, x.status]);
      const allPass = [
        ['extract-code-ts', 'PASS'],
        ['extract-data', 'PASS'],
        ['extract-contracts', 'PASS'],
        ['extract-change', 'PASS'],
        ['infer-join', 'PASS'],
      ];
      assert.deepEqual(statuses(direct), allPass, JSON.stringify(outcomes(direct)));
      assert.deepEqual(statuses(linked), allPass, JSON.stringify(outcomes(linked)));
      assert.equal(linked.code, 0, linked.stderr);

      // The same bytes, whichever way the repository was named.
      assert.equal(linked.report.runId, direct.report.runId);
      const sif = (name: string, runId: string) =>
        readFileSync(join(out, name, 'runs', `${runId}.sif`));
      const realSif = sif('real', direct.report.runId);
      const linkedSif = sif('linked', linked.report.runId);
      assert.ok(realSif.length > 10_000, 'precondition: the snapshot has content');
      assert.ok(
        linkedSif.equals(realSif),
        `the SIF snapshots differ: ${firstDifference(realSif, linkedSif)}`,
      );

      // What each child may read is the real directory: neither the link nor the directory that
      // holds it is granted, and no ancestor is.
      for (const child of linked.started) {
        const readable = child.args
          .filter((a) => a.startsWith('--allow-fs-read='))
          .map((a) => a.slice('--allow-fs-read='.length));
        for (const path of [viaLink, linkParent, realParent, world])
          assert.ok(!readable.includes(path), `${path} must not be granted`);
        assert.equal(child.cwd, real);
      }
      assert.deepEqual(
        linked.started.map((c) => c.args.includes(`--allow-fs-read=${real}`)),
        [true, true, true, true, false],
      );
    },
  );
});

// ---------------------------------------------------------------------------
// A repository whose own config names a program it supplies
// ---------------------------------------------------------------------------

describe('seamline extract / a program the repository supplies', () => {
  // `extract-change` takes a `gitBin` option, and the option comes from the repository's own
  // `seamline.config.json`. Pointed at a file the repository commits, it would run code the
  // repository supplies, as the user, outside the permission model. The planted `bin/git` appends
  // to a file outside the repository and then runs the real one, so a run that let it through
  // would still look healthy; only the file outside the repository tells.
  const spellings: Array<[string, (repo: string) => string]> = [
    ['the real path', (repo) => `${repo}/bin/git`],
    ['/proc/self/cwd', () => '/proc/self/cwd/bin/git'],
    ['/proc/self/root and the real path', (repo) => `/proc/self/root${repo}/bin/git`],
  ];

  for (const [label, gitBin] of spellings) {
    it(
      `fails extract-change, and never runs the planted program, for a gitBin of ${label}`,
      { skip: !IS_LINUX },
      async () => {
        const world = tempDir('cli-path-planted');
        const marker = join(world, 'MARKER');
        const repo = join(world, 'repo');
        const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
        harborBooksWithHistory(repo, (dir) => {
          mkdirSync(join(dir, 'bin'));
          writeFileSync(
            join(dir, 'bin', 'git'),
            `#!/bin/sh\necho "planted program ran" >> ${marker}\nexec ${realGit} "$@"\n`,
          );
          chmodSync(join(dir, 'bin', 'git'), 0o755);
          const path = join(dir, CONFIG_FILENAME);
          const config = JSON.parse(readFileSync(path, 'utf8')) as {
            extractors: Array<{ name: string; options?: Record<string, unknown> }>;
          };
          const change = config.extractors.find((e) => e.name === 'extract-change');
          assert.ok(change, 'the example configures extract-change');
          change.options = { ...change.options, gitBin: gitBin(dir) };
          writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
        });

        // Without the control this value runs the planted program, from the repository.
        const direct = spawn(gitBin(repo), ['--version'], { cwd: repo, stdio: 'ignore' });
        await new Promise((done) => direct.on('close', done));
        assert.ok(existsSync(marker), 'precondition: this gitBin runs the planted program');
        rmSync(marker);

        const io = bufferIo({ cwd: world, env: parentEnv() });
        const code = await runCli(buildCliDeps(io, {}), [
          'extract',
          '--repo',
          repo,
          '--out',
          join(world, 'out'),
          '--only',
          'extract-change',
          '--json',
        ]);
        const report = JSON.parse(io.stdout()) as ExtractReport;
        const change = report.results.find((r) => r.extractor === 'extract-change');
        assert.equal(change?.status, 'FAIL', JSON.stringify(report.results));
        assert.match(change?.diagnostics.join('\n') ?? '', /\[exec\] extract-change: starting /);
        assert.notEqual(code, 0, 'the command reports the failure');
        assert.ok(!existsSync(marker), 'the planted program ran');
      },
    );
  }
});
