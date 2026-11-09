/**
 * Untrusted repository git configuration: the CLI process runs `git` in a repository it did not create, outside the extractor
 * sandbox, and `git` obeys that repository's own `.git/config` and `.gitattributes`. Several
 * settings there name a program. Each test below builds a repository that names a marker program
 * for one route, shows (precondition) that plain `git` with only the system and global config
 * cleared does run it, and then shows the CLI's git does not.
 *
 * These are real repositories and real git on purpose: the behaviour under test is what git does
 * with its own config, and a mock would only assert the test's own expectations.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  UNTRUSTED_GIT_CONFIG,
  pathOutsideRepo,
  spawnUntrustedGit,
  untrustedGitCommand,
  untrustedGitEnv,
} from '@seamline/core';
import {
  UNTRUSTED_GIT_CONFIG as EXTRACT_CHANGE_GIT_CONFIG,
  untrustedGitInternals,
} from '@seamline/extract-change';
import { defaultConfig, serializeConfig, CONFIG_FILENAME } from './config.ts';
import { CliError, EXIT_RUNTIME, bufferIo } from './io.ts';
import { runCli } from './run.ts';
import { buildCliDeps, changeExtractorPort, gitPort, runGit } from './wiring.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `seamline-${prefix}-`));
  temps.push(dir);
  return dir;
}

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

const GIT = systemGit();

/** Plain git as the repository's owner would run it, with system and global config cleared (the pre-fix environment). */
function plainGit(cwd: string, args: readonly string[]): { ok: boolean; stdout: string } {
  const r = spawnSync(GIT, [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: cwd,
      TZ: 'UTC',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'author@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture Committer',
      GIT_COMMITTER_EMAIL: 'committer@example.invalid',
    },
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
}

function git(cwd: string, args: readonly string[]): string {
  const r = plainGit(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed in ${cwd}`);
  return r.stdout;
}

function write(dir: string, rel: string, body: string): void {
  const slash = rel.lastIndexOf('/');
  if (slash > 0) mkdirSync(join(dir, rel.slice(0, slash)), { recursive: true });
  writeFileSync(join(dir, rel), body, 'utf8');
}

interface Fixture {
  readonly repo: string;
  readonly marker: string;
  /** A program that records its arguments in `marker` and fails. */
  readonly record: string;
  /** A program that records its arguments in `marker` and copies stdin to stdout. */
  readonly passthrough: string;
}

/** A repository with one commit holding `a.txt` and `b.txt`, and two marker programs outside it. */
function fixture(): Fixture {
  const outside = newDir('untrusted-git-bin');
  const marker = join(outside, 'MARKER');
  const record = join(outside, 'record.sh');
  const passthrough = join(outside, 'passthrough.sh');
  writeFileSync(record, `#!/bin/sh\necho "ran: $0 $*" >> ${marker}\nexit 1\n`);
  writeFileSync(passthrough, `#!/bin/sh\necho "ran: $0 $*" >> ${marker}\ncat\n`);
  chmodSync(record, 0o755);
  chmodSync(passthrough, 0o755);

  const repo = newDir('untrusted-git-repo');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  write(repo, 'a.txt', 'one\n');
  write(repo, 'b.txt', 'two\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'one']);
  return { repo, marker, record, passthrough };
}

/** Edits `a.txt` so git has to look at its content (its size changes, so the stat check cannot clear it). */
function dirtyWorkingTree(repo: string): void {
  write(repo, 'a.txt', 'one\nand a changed line\n');
}

function ran(marker: string): string {
  return existsSync(marker) ? readFileSync(marker, 'utf8') : '';
}

interface Route {
  readonly name: string;
  /** Makes the repository name `fx.record` / `fx.passthrough` for this route. */
  setup(fx: Fixture): void;
  /** The git subcommand that reaches the route. */
  readonly args: readonly string[];
  /** When set, the outcome the command is expected to have with the route closed. */
  readonly ok?: boolean;
  /** Why this row cannot run on this git; the test is then reported as skipped with this reason. */
  readonly skip?: string;
}

/**
 * `git whatchanged` is deprecated: git 2.39 and later refuse it without `--i-still-use-this`, and a
 * future git may drop it. The row runs wherever some spelling of it works, and is skipped, with the
 * git version in the reason, where none does.
 */
function whatchangedRoute(): { readonly args: readonly string[]; readonly skip?: string } {
  const probe = fixture();
  for (const args of [
    ['whatchanged', '-p', '-1'],
    ['whatchanged', '--i-still-use-this', '-p', '-1'],
  ]) {
    if (plainGit(probe.repo, args).ok) return { args };
  }
  const version = spawnSync(GIT, ['--version'], { encoding: 'utf8' }).stdout.trim();
  return { args: ['whatchanged', '-p', '-1'], skip: `${version} refuses git whatchanged, so the route cannot run` };
}
const WHATCHANGED = whatchangedRoute();

const ROUTES: readonly Route[] = [
  {
    name: 'core.fsmonitor',
    setup: (fx) => {
      git(fx.repo, ['config', 'core.fsmonitor', fx.record]);
      dirtyWorkingTree(fx.repo);
    },
    args: ['diff', '--name-only', 'HEAD'],
    ok: true,
  },
  {
    name: 'a clean filter (filter.<name>.clean, chosen by .gitattributes)',
    setup: (fx) => {
      write(fx.repo, '.gitattributes', '*.txt filter=x\n');
      git(fx.repo, ['config', 'filter.x.clean', fx.passthrough]);
      dirtyWorkingTree(fx.repo);
    },
    args: ['diff', '--name-only', 'HEAD'],
    ok: true,
  },
  {
    name: 'a long-running filter (filter.<name>.process)',
    setup: (fx) => {
      write(fx.repo, '.gitattributes', '*.txt filter=x\n');
      git(fx.repo, ['config', 'filter.x.process', fx.record]);
      dirtyWorkingTree(fx.repo);
    },
    args: ['diff', '--name-only', 'HEAD'],
    ok: true,
  },
  {
    name: 'a required filter whose command fails (filter.<name>.required)',
    setup: (fx) => {
      write(fx.repo, '.gitattributes', '*.txt filter=x\n');
      git(fx.repo, ['config', 'filter.x.clean', fx.record]);
      git(fx.repo, ['config', 'filter.x.required', 'true']);
      dirtyWorkingTree(fx.repo);
    },
    args: ['diff', '--name-only', 'HEAD'],
    ok: true,
  },
  {
    name: 'a filter whose name contains dots',
    setup: (fx) => {
      write(fx.repo, '.gitattributes', '*.txt filter=my.lfs.v2\n');
      git(fx.repo, ['config', 'filter.my.lfs.v2.clean', fx.passthrough]);
      dirtyWorkingTree(fx.repo);
    },
    args: ['diff', '--name-only', 'HEAD'],
    ok: true,
  },
  {
    name: 'a smudge filter (filter.<name>.smudge)',
    setup: (fx) => {
      write(fx.repo, '.gitattributes', '*.txt filter=x\n');
      git(fx.repo, ['config', 'filter.x.smudge', fx.passthrough]);
      dirtyWorkingTree(fx.repo);
    },
    args: ['checkout', '--', 'a.txt'],
    ok: true,
  },
  {
    name: 'diff.external',
    setup: (fx) => {
      git(fx.repo, ['config', 'diff.external', fx.record]);
      dirtyWorkingTree(fx.repo);
    },
    args: ['diff', 'HEAD'],
  },
  {
    name: 'a textconv program (diff.<name>.textconv, chosen by .gitattributes)',
    setup: (fx) => {
      write(fx.repo, '.gitattributes', '*.txt diff=x\n');
      git(fx.repo, ['config', 'diff.x.textconv', fx.passthrough]);
      dirtyWorkingTree(fx.repo);
    },
    args: ['diff', 'HEAD'],
    ok: true,
  },
  {
    name: 'a per-driver external diff (diff.<name>.command)',
    setup: (fx) => {
      write(fx.repo, '.gitattributes', '*.txt diff=x\n');
      git(fx.repo, ['config', 'diff.x.command', fx.record]);
      dirtyWorkingTree(fx.repo);
    },
    args: ['diff', 'HEAD'],
  },
  // Every subcommand that applies a textconv from config alone: one route each, so that a
  // subcommand dropped from the guarded set is seen. (`diff.external` runs from config alone only
  // under `diff`; the others need an explicit `--ext-diff`.)
  ...(
    [
      ['log -p', ['log', '-p', '-1']],
      ['show', ['show', 'HEAD']],
      ['whatchanged -p', WHATCHANGED.args],
    ] as ReadonlyArray<readonly [string, readonly string[]]>
  ).map(
    ([label, args]): Route => ({
      name: `a textconv program through ${label}`,
      setup: (fx) => {
        write(fx.repo, '.gitattributes', '*.txt diff=x\n');
        git(fx.repo, ['add', '.gitattributes']);
        git(fx.repo, ['config', 'diff.x.textconv', fx.passthrough]);
        dirtyWorkingTree(fx.repo);
        git(fx.repo, ['commit', '-q', '-am', 'dirty']);
      },
      args,
      ok: true,
      ...(label === 'whatchanged -p' && WHATCHANGED.skip !== undefined ? { skip: WHATCHANGED.skip } : {}),
    }),
  ),
  {
    name: 'diff.<name>.command even when the caller asks for --ext-diff',
    setup: (fx) => {
      write(fx.repo, '.gitattributes', '*.txt diff=x\n');
      git(fx.repo, ['config', 'diff.x.command', fx.record]);
      dirtyWorkingTree(fx.repo);
    },
    args: ['diff', '--ext-diff', 'HEAD'],
  },
  {
    name: 'a textconv program even when the caller asks for --textconv',
    setup: (fx) => {
      write(fx.repo, '.gitattributes', '*.txt diff=x\n');
      git(fx.repo, ['config', 'diff.x.textconv', fx.passthrough]);
      dirtyWorkingTree(fx.repo);
    },
    args: ['diff', '--textconv', 'HEAD'],
    ok: true,
  },
  {
    name: 'a hook in .git/hooks',
    setup: (fx) => {
      write(fx.repo, '.git/hooks/pre-commit', `#!/bin/sh\necho "ran: hook" >> ${fx.marker}\nexit 0\n`);
      chmodSync(join(fx.repo, '.git/hooks/pre-commit'), 0o755);
    },
    args: ['commit', '-q', '--allow-empty', '-m', 'from the CLI'],
    ok: true,
  },
  {
    name: 'core.hooksPath pointing inside the repository',
    setup: (fx) => {
      write(fx.repo, 'hooks/pre-commit', `#!/bin/sh\necho "ran: hook" >> ${fx.marker}\nexit 0\n`);
      chmodSync(join(fx.repo, 'hooks/pre-commit'), 0o755);
      git(fx.repo, ['config', 'core.hooksPath', join(fx.repo, 'hooks')]);
    },
    args: ['commit', '-q', '--allow-empty', '-m', 'from the CLI'],
    ok: true,
  },
  {
    name: 'a merge driver (merge.<name>.driver)',
    setup: (fx) => {
      write(fx.repo, '.gitattributes', '*.txt merge=x\n');
      git(fx.repo, ['add', '.gitattributes']);
      git(fx.repo, ['commit', '-q', '-m', 'attributes']);
      git(fx.repo, ['checkout', '-q', '-b', 'side']);
      write(fx.repo, 'a.txt', 'side\n');
      git(fx.repo, ['commit', '-q', '-am', 'side']);
      git(fx.repo, ['checkout', '-q', 'main']);
      write(fx.repo, 'a.txt', 'main\n');
      git(fx.repo, ['commit', '-q', '-am', 'main']);
      git(fx.repo, ['config', 'merge.x.driver', `${fx.record} %O %A %B`]);
    },
    args: ['merge', '--no-edit', 'side'],
  },
  {
    name: 'gpg.program, used to verify a signature when log.showSignature is set',
    setup: (fx) => {
      const tree = git(fx.repo, ['write-tree']).trim();
      const parent = git(fx.repo, ['rev-parse', 'HEAD']).trim();
      const raw = [
        `tree ${tree}`,
        `parent ${parent}`,
        'author A <a@example.invalid> 1 +0000',
        'committer A <a@example.invalid> 1 +0000',
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' ',
        ' AAAA',
        ' -----END PGP SIGNATURE-----',
        '',
        'signed by nobody',
        '',
      ].join('\n');
      const input = join(newDir('untrusted-git-raw'), 'commit');
      writeFileSync(input, raw);
      const sha = git(fx.repo, ['hash-object', '-t', 'commit', '-w', input]).trim();
      git(fx.repo, ['update-ref', 'refs/heads/main', sha]);
      git(fx.repo, ['config', 'log.showSignature', 'true']);
      git(fx.repo, ['config', 'gpg.program', fx.record]);
    },
    args: ['log', '-1'],
    ok: true,
  },
];

describe('the CLI process runs no program the repository names (untrusted repository git configuration)', () => {
  for (const route of ROUTES) {
    it(`does not run ${route.name}`, { skip: process.platform === 'win32' ? true : (route.skip ?? false) }, () => {
      const fx = fixture();
      route.setup(fx);
      // Precondition: left to the repository's config, git runs the program. The repository is
      // rebuilt for the control run so the CLI run below starts from the same state.
      const control = fixture();
      route.setup(control);
      plainGit(control.repo, route.args);
      assert.ok(
        existsSync(control.marker),
        `precondition: plain git runs the program this route names (route: ${route.name})`,
      );

      const outcome = runGit(GIT, fx.repo, route.args);
      assert.equal(
        ran(fx.marker),
        '',
        `the program the repository named ran: ${ran(fx.marker)}`,
      );
      if (route.ok !== undefined) {
        assert.equal(outcome.ok, route.ok, `the command itself still ran: ${outcome.stdout}`);
      }
    });
  }

  it('does not run a clean filter from gitPort.changedFiles, and still lists the edited file', async () => {
    const fx = fixture();
    write(fx.repo, '.gitattributes', '*.txt filter=x\n');
    git(fx.repo, ['config', 'filter.x.clean', fx.passthrough]);
    git(fx.repo, ['config', 'core.fsmonitor', fx.record]);
    dirtyWorkingTree(fx.repo);
    write(fx.repo, 'new.md', 'untracked\n');
    plainGit(fx.repo, ['diff', '--name-only', 'HEAD']);
    assert.notEqual(ran(fx.marker), '', 'precondition: plain git runs the programs');
    rmSync(fx.marker);

    const files = await gitPort().changedFiles(fx.repo);
    assert.equal(ran(fx.marker), '', `the program the repository named ran: ${ran(fx.marker)}`);
    assert.deepEqual(files, ['.gitattributes', 'a.txt', 'new.md']);
  });

  it('still reports a staged change, an unstaged change and an untracked file', async () => {
    const fx = fixture();
    write(fx.repo, 'b.txt', 'two\nstaged\n');
    git(fx.repo, ['add', 'b.txt']);
    dirtyWorkingTree(fx.repo);
    write(fx.repo, 'c.txt', 'untracked\n');
    assert.deepEqual(await gitPort().changedFiles(fx.repo), ['a.txt', 'b.txt', 'c.txt']);
  });

  it('refuses a repository with a driver name it cannot disable, and runs nothing', () => {
    const fx = fixture();
    // `-c name=value` splits at the first `=`, so a driver named `a=b` cannot be overridden.
    git(fx.repo, ['config', 'filter.a=b.clean', fx.passthrough]);
    write(fx.repo, '.gitattributes', '*.txt filter=a=b\n');
    dirtyWorkingTree(fx.repo);
    plainGit(fx.repo, ['diff', '--name-only', 'HEAD']);
    assert.notEqual(ran(fx.marker), '', 'precondition: plain git runs the program');
    rmSync(fx.marker);

    const outcome = runGit(GIT, fx.repo, ['diff', '--name-only', 'HEAD']);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, null, 'a refusal is not an exit status');
    assert.match(outcome.failure ?? '', /cannot be passed to git on a command line/);
    assert.equal(ran(fx.marker), '');
  });

  it('refuses a repository that defines more command drivers than it will neutralise, and runs nothing', () => {
    const fx = fixture();
    const config = join(fx.repo, '.git', 'config');
    const many = Array.from({ length: 600 }, (_, i) => `[filter "f${i}"]\n\tclean = ${fx.record}\n`).join('');
    writeFileSync(config, `${readFileSync(config, 'utf8')}${many}`);
    write(fx.repo, '.gitattributes', '*.txt filter=f0\n');
    dirtyWorkingTree(fx.repo);
    plainGit(fx.repo, ['diff', '--name-only', 'HEAD']);
    assert.notEqual(ran(fx.marker), '', 'precondition: plain git runs the program');
    rmSync(fx.marker);

    const outcome = runGit(GIT, fx.repo, ['diff', '--name-only', 'HEAD']);
    assert.equal(outcome.ok, false);
    assert.equal(ran(fx.marker), '');
  });

  it('an alias cannot stand in for a built-in command the CLI runs', () => {
    // Not a route: git never lets an alias shadow a built-in. Pinned so that a git that did would be seen here.
    const fx = fixture();
    git(fx.repo, ['config', 'alias.diff', `!${fx.record}`]);
    git(fx.repo, ['config', 'alias.rev-parse', `!${fx.record}`]);
    runGit(GIT, fx.repo, ['rev-parse', '--is-inside-work-tree']);
    runGit(GIT, fx.repo, ['diff', '--name-only', 'HEAD']);
    assert.equal(ran(fx.marker), '');
  });

  it('overrides exactly these settings, and never pages', () => {
    // State, not behaviour: no test can start a pager (it needs a terminal), ask for a credential (it
    // needs an HTTP server that does), or run a packObjectsHook from repository config (git ignores
    // it there). The list is what stands between those routes and the repository's config.
    const expected = [
      'core.fsmonitor=false',
      `core.hooksPath=${devNull}`,
      `core.attributesFile=${devNull}`,
      `core.sshCommand=${devNull}`,
      `core.gitProxy=${devNull}`,
      `core.askPass=${devNull}`,
      'core.pager=cat',
      'credential.helper=',
      'log.showSignature=false',
      `gpg.program=${devNull}`,
      `gpg.openpgp.program=${devNull}`,
      `gpg.x509.program=${devNull}`,
      `gpg.ssh.program=${devNull}`,
      'protocol.allow=never',
      'protocol.ext.allow=never',
      `uploadpack.packObjectsHook=${devNull}`,
    ];
    assert.deepEqual(UNTRUSTED_GIT_CONFIG.map(([k, v]) => `${k}=${v}`), expected);
    const fx = fixture();
    for (const command of [
      untrustedGitCommand(GIT, fx.repo, ['status']),
      untrustedGitInternals.gitCommand({ gitBin: GIT, cwd: fx.repo, maxBufferBytes: 1024 }, ['status']),
    ]) {
      assert.ok('argv' in command);
      assert.equal(command.argv[0], '--no-pager');
      assert.deepEqual(
        command.argv.slice(1, 1 + 2 * expected.length),
        expected.flatMap((entry) => ['-c', entry]),
      );
    }
  });

  it('inserts --no-ext-diff --no-textconv right after every patch-producing subcommand, in both doors', () => {
    // State, not behaviour: the per-driver textconv/command overrides make the flags redundant for any
    // one route, so removing a subcommand from the guarded set changes no marker. The flags are the
    // guard for a driver this process could not enumerate, so they are asserted where they are built.
    const fx = fixture();
    for (const subcommand of ['diff', 'log', 'show', 'whatchanged']) {
      const ours = untrustedGitCommand(GIT, fx.repo, [subcommand, '-1']);
      const theirs = untrustedGitInternals.gitCommand(
        { gitBin: GIT, cwd: fx.repo, maxBufferBytes: 1024 },
        [subcommand, '-1'],
      );
      for (const command of [ours, theirs]) {
        assert.ok('argv' in command);
        assert.deepEqual(command.argv.slice(-4), [subcommand, '--no-ext-diff', '--no-textconv', '-1']);
      }
    }
    const plain = untrustedGitCommand(GIT, fx.repo, ['rev-parse', 'HEAD']);
    assert.ok('argv' in plain);
    assert.deepEqual(plain.argv.slice(-2), ['rev-parse', 'HEAD']);
  });

  it('keeps the same override list as extract-change, which cannot import it', () => {
    assert.deepEqual(
      EXTRACT_CHANGE_GIT_CONFIG.map(([key, value]) => `${key}=${value}`),
      UNTRUSTED_GIT_CONFIG.map(([key, value]) => `${key}=${value}`),
    );
  });

  /** A repository per kind of config the door treats differently. */
  function repositoriesForParity(): string[] {
    const plain = fixture();
    const drivers = fixture();
    for (const [key, value] of [
      ['filter.x.clean', drivers.passthrough],
      ['filter.x.smudge', drivers.passthrough],
      ['filter.my.lfs.v2.process', drivers.record],
      ['diff.t.textconv', drivers.passthrough],
      ['diff.t.command', drivers.record],
      ['merge.m.driver', drivers.record],
    ] as const) {
      git(drivers.repo, ['config', key, value]);
    }
    const nameWithEquals = fixture();
    git(nameWithEquals.repo, ['config', 'filter.a=b.clean', nameWithEquals.passthrough]);
    const tooMany = fixture();
    const config = join(tooMany.repo, '.git', 'config');
    writeFileSync(
      config,
      readFileSync(config, 'utf8') +
        Array.from({ length: 600 }, (_, i) => `[filter "f${i}"]\n\tclean = cat\n`).join(''),
    );
    const unreadable = fixture();
    writeFileSync(join(unreadable.repo, '.git', 'config'), '[core\n');
    return [plain.repo, drivers.repo, nameWithEquals.repo, tooMany.repo, unreadable.repo];
  }

  it('builds the same command line, environment and refusals as extract-change, repository by repository', () => {
    const subcommands: ReadonlyArray<readonly string[]> = [
      ['rev-parse', '--is-inside-work-tree'],
      ['diff', '--name-only', 'HEAD'],
      ['log', '-p', '-1'],
      ['cat-file', '--batch'],
      ['ls-files', '--others'],
    ];
    for (const repo of repositoriesForParity()) {
      for (const args of subcommands) {
        const ours = untrustedGitCommand(GIT, repo, args);
        const theirs = untrustedGitInternals.gitCommand(
          { gitBin: GIT, cwd: repo, maxBufferBytes: 1024 },
          args,
        );
        assert.deepEqual(theirs, ours, `${repo}: git ${args.join(' ')}`);
      }
    }
  });

  it('refuses, with a reason, exactly the repositories extract-change refuses', () => {
    const [plain, drivers, nameWithEquals, tooMany, unreadable] = repositoriesForParity() as [
      string, string, string, string, string,
    ];
    const refusal = (repo: string): string | null => {
      const c = untrustedGitCommand(GIT, repo, ['status']);
      return 'refusal' in c ? c.refusal : null;
    };
    assert.equal(refusal(plain), null);
    assert.equal(refusal(drivers), null);
    assert.match(refusal(nameWithEquals) ?? '', /cannot be passed to git on a command line/);
    assert.match(refusal(tooMany) ?? '', /more than 512 command drivers/);
    assert.match(refusal(unreadable) ?? '', /could not read the repository configuration/);
  });

  it('builds the environment from nothing: only the controls below, none inherited', () => {
    const fx = fixture();
    const inherited = {
      GIT_EXTERNAL_DIFF: fx.record,
      GIT_SSH_COMMAND: fx.record,
      GIT_PROXY_COMMAND: fx.record,
      GIT_CONFIG_GLOBAL: fx.record,
      GIT_ALLOW_PROTOCOL: 'file:ssh',
      GIT_CONFIG_COUNT: '1',
      HOME: fx.repo,
    };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(inherited)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const expected: Record<string, string> = {
        GIT_ALLOW_PROTOCOL: '',
        GIT_ASKPASS: '',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: devNull,
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        LANG: 'C',
        LC_ALL: 'C',
        PATH: pathOutsideRepo(process.env['PATH'] ?? '', fx.repo),
        TZ: 'UTC',
      };
      const sorted = (o: Record<string, string>): Array<[string, string]> =>
        Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1));
      assert.deepEqual(sorted(untrustedGitEnv(fx.repo)), sorted(expected));
      assert.deepEqual(sorted(untrustedGitInternals.deterministicEnv(fx.repo)), sorted(expected));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('agrees with extract-change on which PATH entries to drop', () => {
    const fx = fixture();
    const root = fx.repo;
    const cases = [
      `${root}/bin${delimiter}/usr/bin`,
      `${delimiter}/usr/bin`,
      `bin${delimiter}/usr/bin`,
      `.${delimiter}/usr/bin`,
      `/usr/bin${delimiter}${root}`,
      `/usr/bin${delimiter}${root}/node_modules/.bin`,
      `${resolve(root, '..')}${delimiter}/usr/bin`,
      '/usr/bin',
      '',
    ];
    for (const value of cases) {
      assert.equal(
        untrustedGitInternals.pathOutsideRepo(value, root),
        pathOutsideRepo(value, root),
        `PATH=${value}`,
      );
    }
  });

  it('starts no git found inside the repository through PATH', { skip: process.platform === 'win32' }, () => {
    const fx = fixture();
    write(fx.repo, 'bin/git', `#!/bin/sh\necho "ran: planted git" >> ${fx.marker}\n${GIT} "$@"\n`);
    chmodSync(join(fx.repo, 'bin/git'), 0o755);
    const saved = process.env['PATH'];
    process.env['PATH'] = `${join(fx.repo, 'bin')}${delimiter}${saved ?? ''}`;
    try {
      spawnSync('git', ['--version'], { cwd: fx.repo });
      assert.notEqual(ran(fx.marker), '', 'precondition: this PATH finds the planted git');
      rmSync(fx.marker);
      const r = spawnUntrustedGit('git', fx.repo, ['--version']);
      assert.equal(r.status, 0, String(r.error));
      assert.equal(ran(fx.marker), '', `the git the repository supplied ran: ${ran(fx.marker)}`);
    } finally {
      if (saved === undefined) delete process.env['PATH'];
      else process.env['PATH'] = saved;
    }
  });

  describe('a refusal or a git failure is reported, never read as "no changes" (untrusted repository git configuration, follow-up)', () => {
    function dirtyRepo(): Fixture {
      const fx = fixture();
      dirtyWorkingTree(fx.repo);
      // The answer a lie would contradict: plain git sees the edit.
      assert.match(plainGit(fx.repo, ['diff', '--name-only', 'HEAD']).stdout, /a\.txt/);
      return fx;
    }

    const isRuntimeFailure =
      (reason: RegExp) =>
      (e: unknown): boolean =>
        e instanceof CliError && e.code === EXIT_RUNTIME && reason.test(e.message);

    it('changedFiles rejects when git refuses the repository (a driver name with "=")', async () => {
      const fx = dirtyRepo();
      git(fx.repo, ['config', 'filter.a=b.clean', fx.passthrough]);
      await assert.rejects(
        gitPort().changedFiles(fx.repo),
        isRuntimeFailure(/cannot be passed to git on a command line/),
      );
      assert.equal(ran(fx.marker), '');
    });

    it('changedFiles rejects when git refuses the repository (too many drivers)', async () => {
      const fx = dirtyRepo();
      const config = join(fx.repo, '.git', 'config');
      writeFileSync(
        config,
        readFileSync(config, 'utf8') +
          Array.from({ length: 600 }, (_, i) => `[filter "f${i}"]\n\tclean = cat\n`).join(''),
      );
      await assert.rejects(gitPort().changedFiles(fx.repo), isRuntimeFailure(/more than 512 command drivers/));
    });

    it('changedFiles rejects when git fails after the repository was recognised', async () => {
      const fx = dirtyRepo();
      writeFileSync(join(fx.repo, '.git', 'index'), 'not an index');
      await assert.rejects(gitPort().changedFiles(fx.repo), isRuntimeFailure(/exited 128/));
    });

    it('changedFiles still lists untracked files in a repository with no commit', async () => {
      const dir = newDir('unborn');
      git(dir, ['init', '-q', '-b', 'main']);
      write(dir, 'new.txt', 'x\n');
      assert.deepEqual(await gitPort().changedFiles(dir), ['new.txt']);
    });

    it('the run id says "unreadable" when git was refused, not "unresolved"', () => {
      const fx = dirtyRepo();
      git(fx.repo, ['config', 'filter.a=b.clean', fx.passthrough]);
      const port = changeExtractorPort();
      assert.equal(
        port.inputIdentity?.({ repoRoot: fx.repo, options: {} }),
        'history:until=unreadable:since=none',
      );
    });

    it('blast-radius, check and align report it end to end, with a non-success exit where the command concludes something', async () => {
      const fx = fixture();
      write(fx.repo, 'src/a.ts', 'export const a = 1;\n');
      write(fx.repo, 'package.json', '{"name":"demo","version":"1.0.0"}\n');
      git(fx.repo, ['add', '.']);
      git(fx.repo, ['commit', '-q', '-m', 'sources']);
      git(fx.repo, ['config', 'filter.a=b.clean', fx.passthrough]);
      write(fx.repo, CONFIG_FILENAME, serializeConfig(defaultConfig('demo')));
      const outDir = newDir('untrusted-git-out');
      const env = { PATH: process.env['PATH'] ?? '' };
      const cli = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
        const io = bufferIo({ cwd: fx.repo, isTty: false, env });
        const code = await runCli(buildCliDeps(io), argv);
        return { code, out: io.stdout(), err: io.stderr() };
      };

      const extract = await cli(['extract', '--out', outDir]);

      assert.match(extract.out, /UNAVAILABLE\s+extract-change\s+git was refused for this repository/);

      write(fx.repo, 'src/a.ts', 'export const a = 2;\n');
      const blast = await cli(['blast-radius', '--store', outDir]);
      assert.equal(blast.code, EXIT_RUNTIME, blast.out + blast.err);
      assert.doesNotMatch(blast.out, /clean/i);
      assert.match(blast.err, /cannot read the working tree: .*cannot be passed to git on a command line/);

      const check = await cli(['check', '--json', '--store', outDir]);
      const report = JSON.parse(check.out) as { outcome: string };
      assert.notEqual(report.outcome, 'clean', 'check must not call a repository clean that git was refused for');
      assert.match(check.out, /git was refused for this repository/);

      const align = await cli(['align', '--out', outDir]);
      assert.equal(align.code, EXIT_RUNTIME, align.out + align.err);
      assert.match(align.err, /cannot be passed to git on a command line/);
      assert.doesNotMatch(align.err, /unknown revision/);
      const worktree = await cli(['align', '--worktree', '--out', outDir]);
      assert.equal(worktree.code, EXIT_RUNTIME, worktree.out + worktree.err);
      assert.match(worktree.err, /cannot be passed to git on a command line/);
      assert.equal(ran(fx.marker), '');
    });
  });

  it('starts a process only in the sandbox host and the conformance fixtures; git only through spawnUntrustedGit', () => {
    const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const here = new URL('.', import.meta.url).pathname;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = join(dir, e.name);
        if (e.isDirectory()) return ['__fixtures__', 'sandbox', 'conformance'].includes(e.name) ? [] : walk(full);
        return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [full] : [];
      });
    const offenders = walk(here).filter((f) =>
      /child_process|(?<![.\w])(spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/.test(strip(readFileSync(f, 'utf8'))),
    );
    assert.deepEqual(offenders, []);
    const wiring = strip(readFileSync(join(here, 'wiring.ts'), 'utf8'));
    assert.equal(wiring.match(/spawnUntrustedGit\(/g)?.length, 1, 'runGit is the one door');
  });
});
