/**
 * Untrusted repository git configuration, extract-change side: `git` obeys the repository's own `.git/config` and
 * `.gitattributes`, and several settings there name a program. This extractor runs in the sandbox,
 * but the sandbox is not the only control. Each test below builds a repository that names a marker
 * program for one route, shows (precondition) that plain `git` with only the system and global
 * config cleared does run it, and then shows `runGit`, this package's one door to git, does not.
 * `runGit` takes any subcommand, so a route is tested with the subcommand that reaches it, whether
 * or not the extractor uses that subcommand today.
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
import { delimiter, isAbsolute, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DEFAULT_MAX_BUFFER_BYTES, runGit as runGitInvocation } from './git.ts';
import type { GitOutcome } from './git.ts';
import { extractChange } from './index.ts';

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

function runGit(gitBin: string, cwd: string, args: readonly string[]): GitOutcome {
  return runGitInvocation({ gitBin, cwd, maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES }, args);
}

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

describe('extract-change git runs no program the repository names (untrusted repository git configuration)', () => {
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

  it('extractChange runs no gpg.program on a signed commit and still reports the history', () => {
    const fx = fixture();
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
    plainGit(fx.repo, ['log', '-1']);
    assert.notEqual(ran(fx.marker), '', 'precondition: plain git runs the program');
    rmSync(fx.marker);

    const out = extractChange({ repoRoot: fx.repo, repo: 'fixture', runId: 'run-fixture-0001' });
    assert.equal(ran(fx.marker), '', `the program the repository named ran: ${ran(fx.marker)}`);
    assert.equal(out.result.status, 'PASS');
    assert.equal(out.nodes.filter((n) => n.kind === 'Commit').length, 2);
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
    assert.match(outcome.spawnError ?? '', /^refused: .*cannot be passed to git on a command line/);
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

  it('an alias cannot stand in for a built-in command this package runs', () => {
    // Not a route: git never lets an alias shadow a built-in. Pinned so that a git that did would be seen here.
    const fx = fixture();
    git(fx.repo, ['config', 'alias.diff', `!${fx.record}`]);
    git(fx.repo, ['config', 'alias.rev-parse', `!${fx.record}`]);
    runGit(GIT, fx.repo, ['rev-parse', '--is-inside-work-tree']);
    runGit(GIT, fx.repo, ['diff', '--name-only', 'HEAD']);
    assert.equal(ran(fx.marker), '');
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
      const r = runGit('git', fx.repo, ['--version']);
      assert.equal(r.ok, true, String(r.spawnError));
      assert.equal(ran(fx.marker), '', `the git the repository supplied ran: ${ran(fx.marker)}`);
    } finally {
      if (saved === undefined) delete process.env['PATH'];
      else process.env['PATH'] = saved;
    }
  });

  describe('a refusal or a git failure is a status, never a default (untrusted repository git configuration, follow-up)', () => {
    /** A git that behaves, except that it exits 1 for any command line containing `needle`. */
    function gitFailingOn(needle: string): string {
      const dir = newDir('untrusted-git-wrapper');
      const wrapper = join(dir, 'git');
      writeFileSync(
        wrapper,
        `#!/bin/sh\ncase " $* " in *" ${needle} "*) exit 1;; esac\n${GIT} "$@"\n`,
      );
      chmodSync(wrapper, 0o755);
      return wrapper;
    }

    it('extractChange is UNAVAILABLE, and says git was refused, when the config cannot be neutralised', () => {
      const fx = fixture();
      git(fx.repo, ['config', 'filter.a=b.clean', fx.passthrough]);
      const out = extractChange({ repoRoot: fx.repo, repo: 'fixture', runId: 'run-fixture-0001' });
      assert.equal(out.result.status, 'UNAVAILABLE');
      assert.ok(
        out.result.diagnostics.some((d) => /git was refused for this repository .*cannot be passed to git/.test(d)),
        out.result.diagnostics.join('\n'),
      );
      assert.equal(out.nodes.length, 0);
      assert.equal(ran(fx.marker), '');
    });

    it('extractChange is not PASS when git cannot say whether the clone is shallow', () => {
      const fx = fixture();
      const out = extractChange({
        repoRoot: fx.repo,
        repo: 'fixture',
        runId: 'run-fixture-0001',
        gitBin: gitFailingOn('--is-shallow-repository'),
      });
      assert.notEqual(out.result.status, 'PASS');
      assert.ok(out.result.diagnostics.some((d) => /whether this clone is shallow/.test(d)));
      assert.equal(out.nodes.length, 0);
    });

    it('extractChange is not PASS when git cannot read the oldest commit of a shallow clone', () => {
      const origin = fixture();
      write(origin.repo, 'c.txt', 'three\n');
      git(origin.repo, ['add', '.']);
      git(origin.repo, ['commit', '-q', '-m', 'two']);
      const work = newDir('untrusted-git-shallow');
      const shallow = join(work, 'shallow');
      git(work, ['clone', '-q', '--depth', '1', `file://${origin.repo}`, shallow]);
      const control = extractChange({ repoRoot: shallow, repo: 'fixture', runId: 'run-fixture-0001' });
      assert.equal(control.result.status, 'UNAVAILABLE', 'precondition: the walk stops on the graft boundary');
      const out = extractChange({
        repoRoot: shallow,
        repo: 'fixture',
        runId: 'run-fixture-0001',
        gitBin: gitFailingOn('cat-file commit'),
      });
      assert.notEqual(out.result.status, 'PASS', 'a boundary git could not check is not an absent boundary');
      assert.equal(out.nodes.length, 0);
    });
  });

  it('is the only module here that starts a process, and starts git in exactly two places', () => {
    const dir = new URL('.', import.meta.url).pathname;
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const spawning = sources.filter((f) => /child_process|(?<![.\w])(spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/.test(
      readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''),
    ));
    assert.deepEqual(spawning, ['git.ts']);
    const code = readFileSync(join(dir, 'git.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.equal(code.match(/\bspawnSync\(/g)?.length, 2, 'the config listing and runGit');
    assert.equal(code.match(/from 'node:child_process'/g)?.length, 1);
  });
});
