/**
 * The only way the harness touches `git`: a subprocess with an argument
 * vector and no shell.
 *
 * Fetched repositories are untrusted data. Nothing in them is ever executed:
 * no install, no scripts, no build. The `-c` flags below also keep a hostile
 * repository (or a stray global configuration) from running hooks, a
 * filesystem monitor, or an `ext::` transport during clone and checkout.
 */

import { execFile } from 'node:child_process';

/** Runs `git <args>` and resolves with stdout. `cwd` is the repository to act on. */
export type GitRunner = (args: readonly string[], cwd?: string) => Promise<string>;

export class GitError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string, cause: unknown) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || String(cause)}`);
    this.name = 'GitError';
    this.args = args;
    this.stderr = stderr;
  }
}

/**
 * Configuration passed to every invocation. A fetched repository is untrusted
 * data, so nothing it carries may run: no hooks, no filesystem monitor, no
 * `ext::` transport, and no submodule recursion (a submodule is another
 * repository at a commit nobody pinned). Attribute-driven conversions are
 * switched off separately, per clone, in `fetch.ts`.
 */
export const HARDENING: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'submodule.recurse=false',
  '-c',
  'advice.detachedHead=false',
];

const GIT_TIMEOUT_MS = 30 * 60 * 1000;

export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    LC_ALL: 'C',
  };
}

export const runGit: GitRunner = (args, cwd) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      [...HARDENING, ...args],
      {
        ...(cwd === undefined ? {} : { cwd }),
        env: gitEnv(),
        maxBuffer: 256 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) reject(new GitError(args, String(stderr), error));
        else resolve(String(stdout));
      },
    );
  });
