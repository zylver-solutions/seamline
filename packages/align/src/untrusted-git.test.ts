/**
 * Untrusted repository git configuration, align side: `seamline align` reads a repository it did not create with `git`, and
 * `git` obeys that repository's own `.git/config`. In a partial clone, `git cat-file --batch`
 * fetches a missing blob from the remote the config names, with the transport program the config
 * names. Real repositories and real git, as in the other tests that exercise git itself.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { AlignError } from './errors.ts';
import { gitTree, resolveCommit, worktreeTree } from './tree.ts';

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
  const r = spawnSync('git', [...args], {
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
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function write(dir: string, rel: string, body: string): void {
  const slash = rel.lastIndexOf('/');
  if (slash > 0) mkdirSync(join(dir, rel.slice(0, slash)), { recursive: true });
  writeFileSync(join(dir, rel), body, 'utf8');
}

function ran(marker: string): string {
  return existsSync(marker) ? readFileSync(marker, 'utf8') : '';
}

describe("align: the repository's own git configuration (untrusted repository git configuration)", { skip: process.platform === 'win32' }, () => {
  /** A partial clone, so `cat-file --batch` of a source file needs a blob the clone lacks. */
  function partialClone(): { victim: string; marker: string; script: string; head: string } {
    const origin = newDir('align-origin');
    git(origin, ['init', '-q', '-b', 'main']);
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    write(origin, 'src/index.ts', 'export const answer = 42;\n');
    git(origin, ['add', '.']);
    git(origin, ['commit', '-q', '-m', 'one']);

    const work = newDir('align-victim');
    const victim = join(work, 'victim');
    git(work, ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${origin}`, victim]);
    const marker = join(work, 'MARKER');
    const script = join(work, 'evil.sh');
    writeFileSync(script, `#!/bin/sh\necho "ran: $0 $*" >> ${marker}\nexit 1\n`);
    chmodSync(script, 0o755);
    git(victim, ['config', 'core.sshCommand', script]);
    git(victim, ['config', 'remote.origin.url', 'ssh://localhost/nonexistent']);
    return { victim, marker, script, head: git(victim, ['rev-parse', 'HEAD']).trim() };
  }

  it('gitTree starts no transport program in a partial clone', () => {
    const c = partialClone();
    // Precondition: left to the repository's config, the very same read runs the program.
    spawnSync('git', ['-C', c.victim, 'cat-file', '--batch'], {
      input: `${git(c.victim, ['rev-parse', 'HEAD:src/index.ts'])}`,
      env: { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.notEqual(ran(c.marker), '', 'precondition: the program runs when git is left alone');
    rmSync(c.marker);

    try {
      gitTree(c.victim, c.head);
    } catch {
      // The blob cannot be fetched; what matters is that no program ran.
    }
    assert.equal(ran(c.marker), '', `the program the repository named ran: ${ran(c.marker)}`);
  });

  it('resolveCommit and worktreeTree run no program a repository config names', () => {
    const c = partialClone();
    git(c.victim, ['config', 'core.fsmonitor', c.script]);
    git(c.victim, ['config', 'core.hooksPath', join(c.victim, 'hooks')]);
    assert.match(resolveCommit(c.victim, 'HEAD'), /^[0-9a-f]{40}$/);
    worktreeTree(c.victim);
    assert.equal(ran(c.marker), '', `the program the repository named ran: ${ran(c.marker)}`);
  });

  it('starts no git found inside the repository through PATH, in any of its four git calls', () => {
    const c = partialClone();
    const planted = join(c.victim, 'bin', 'git');
    write(c.victim, 'bin/git', `#!/bin/sh\necho "ran: planted git" >> ${c.marker}\n"$(command -v -p git || echo /usr/bin/git)" "$@"\n`);
    chmodSync(planted, 0o755);
    const saved = process.env['PATH'];
    process.env['PATH'] = `${join(c.victim, 'bin')}${delimiter}${saved ?? ''}`;
    try {
      spawnSync('git', ['--version'], { cwd: c.victim });
      assert.notEqual(ran(c.marker), '', 'precondition: this PATH finds the planted git');
      rmSync(c.marker);
      resolveCommit(c.victim, 'HEAD');
      worktreeTree(c.victim);
      try {
        gitTree(c.victim, c.head);
      } catch {
        // the blob is not there; only the program matters
      }
      assert.equal(ran(c.marker), '', `the git the repository supplied ran: ${ran(c.marker)}`);
    } finally {
      if (saved === undefined) delete process.env['PATH'];
      else process.env['PATH'] = saved;
    }
  });

  it('reports a refused repository as a runtime failure naming the reason, never as an unknown revision or an empty tree', () => {
    const c = partialClone();
    git(c.victim, ['config', 'filter.a=b.clean', c.script]);
    const reason = /cannot be passed to git on a command line/;
    for (const call of [
      () => resolveCommit(c.victim, 'HEAD'),
      () => gitTree(c.victim, c.head),
      () => worktreeTree(c.victim),
    ]) {
      assert.throws(
        call,
        (e: unknown) => e instanceof AlignError && e.kind === 'runtime' && reason.test(e.message),
      );
    }
    assert.equal(ran(c.marker), '');
  });

  it('starts a process nowhere in this package: git only through spawnUntrustedGit', () => {
    const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? e.name === '__fixtures__' ? [] : walk(join(dir, e.name))
          : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : [],
      );
    const here = new URL('.', import.meta.url).pathname;
    const offenders = walk(here).filter((f) =>
      /child_process|(?<![.\w])(spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/.test(strip(readFileSync(f, 'utf8'))),
    );
    assert.deepEqual(offenders, []);
    const tree = strip(readFileSync(join(here, 'tree.ts'), 'utf8'));
    assert.equal(tree.match(/spawnUntrustedGit\(/g)?.length, 3, 'rev-parse, the shared git(), cat-file');
  });
});
