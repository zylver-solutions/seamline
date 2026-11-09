/**
 * The one way this process starts `git` in a repository it was pointed at and did not create.
 *
 * Untrusted repository git configuration. A repository directory that arrives together with its `.git` (an archive, a shared
 * volume, a copied checkout) carries its own `.git/config`, and `.gitattributes`. `git` obeys
 * both, and several settings name a program that `git` then runs as the user, outside the extractor
 * sandbox: `core.fsmonitor`, a clean/smudge/process filter (`filter.<name>.*`, selected by
 * `.gitattributes`), a textconv or external diff (`diff.<name>.*`, `diff.external`), a merge driver,
 * hooks, a signature program, and the transport programs a lazy fetch of a partial clone starts.
 * Clearing the system and global config (`GIT_CONFIG_SYSTEM`, `GIT_CONFIG_GLOBAL`) does not touch
 * the repository's own file.
 *
 * Every route is closed here, in the command line and the environment, so that no caller has to
 * remember which subcommand reaches which route:
 *
 * - fixed keys are overridden by `-c` (a `-c` value outranks every file);
 * - driver names are chosen by the repository, so they are read from the effective config
 *   (`git config --list -z`, which runs no program) and each one's command is overridden: empty for a
 *   filter, per-driver external diff and merge driver (git applies none), `cat` for a textconv (git
 *   fails a diff on an empty textconv command; `cat` is the identity conversion);
 * - `diff.external` cannot be overridden by an empty value (git then fails the diff), so a
 *   subcommand that produces patches gets `--no-ext-diff --no-textconv` inserted after its name;
 * - aliases need no override: an alias never shadows a built-in command, and callers pass built-ins;
 * - the environment is built from nothing, so `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`
 *   and the like are absent rather than cleared.
 *
 * Consequence: a clean filter never runs, so a working-tree comparison treats a file a filter would
 * have normalised (Git LFS pointers, for one) as modified. That errs toward reporting a file as
 * changed, never toward missing one.
 *
 * Git versions: the overrides use `-c`, `--no-pager`, `GIT_CONFIG_SYSTEM`/`GIT_CONFIG_GLOBAL`
 * (git 2.32 and later) and `GIT_ALLOW_PROTOCOL` (git 2.14 and later). Verified on git 2.34.1 only.
 * `extract-change` carries a copy of this list because it cannot depend on this package; a test in
 * `@seamline/cli` fails when the two differ.
 */

import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { devNull } from 'node:os';
import { pathOutsideRepo } from './sandbox.ts';

/**
 * Settings with a fixed name, each overridden on the command line. A value that is a path is
 * `devNull`, so a route that is somehow reached fails closed (cannot execute) instead of falling
 * back to a program found by name.
 */
export const UNTRUSTED_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', devNull],
  ['core.attributesFile', devNull],
  ['core.sshCommand', devNull],
  ['core.gitProxy', devNull],
  ['core.askPass', devNull],
  ['core.pager', 'cat'],
  ['credential.helper', ''],
  ['log.showSignature', 'false'],
  ['gpg.program', devNull],
  ['gpg.openpgp.program', devNull],
  ['gpg.x509.program', devNull],
  ['gpg.ssh.program', devNull],
  ['protocol.allow', 'never'],
  ['protocol.ext.allow', 'never'],
  ['uploadpack.packObjectsHook', devNull],
];

/** `<section>.<driver name>.<variable>` keys whose value is a command line the repository chose. */
const DRIVER_VARIABLES: Readonly<Record<string, ReadonlyArray<string>>> = {
  filter: ['clean', 'smudge', 'process'],
  diff: ['textconv', 'command'],
  merge: ['driver'],
};

/** More driver names than this in one repository is refused rather than turned into a huge command line. */
const MAX_DRIVER_NAMES = 512;

/** The environment for an untrusted repository: built from nothing, PATH without the repository's entries. */
export function untrustedGitEnv(repoRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  const path = process.env['PATH'];
  const safePath = path === undefined ? '' : pathOutsideRepo(path, repoRoot);
  if (safePath !== '') env['PATH'] = safePath;
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot !== undefined) env['SystemRoot'] = systemRoot;
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_CONFIG_SYSTEM'] = devNull;
  env['GIT_CONFIG_GLOBAL'] = devNull;
  env['GIT_ATTR_NOSYSTEM'] = '1';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_ASKPASS'] = '';
  // No network from this process: a partial clone's missing blob would otherwise be fetched with the
  // transport program the repository's own config names.
  env['GIT_NO_LAZY_FETCH'] = '1';
  env['GIT_ALLOW_PROTOCOL'] = '';
  env['GIT_PAGER'] = 'cat';
  env['LC_ALL'] = 'C';
  env['LANG'] = 'C';
  env['TZ'] = 'UTC';
  return env;
}

/**
 * Subcommands that run a textconv program, or (`diff` only) an external diff, from config alone; the
 * flags are inserted after the subcommand's name. The plumbing diffs and `format-patch` need an explicit
 * `--ext-diff` or `--textconv` to run either, which a caller must not pass.
 */
const DIFF_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'diff',
  'log',
  'show',
  // Stays although deprecated: git before 2.39 runs it from config alone, and removing it removes the guard there.
  'whatchanged',
]);

/** `args` with the flags that keep a patch-producing subcommand from running an external diff or textconv program. */
function withDiffGuards(args: ReadonlyArray<string>): string[] {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || !DIFF_SUBCOMMANDS.has(subcommand)) return [...args];
  return [subcommand, '--no-ext-diff', '--no-textconv', ...rest];
}

function configArgs(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  return pairs.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

/** A driver name this module cannot pass through `-c` (it would split at the wrong `=`). */
function nameIsUnsafe(name: string): boolean {
  return name.includes('=') || name.includes('\n') || name.includes('\0');
}

/** Why a command was not run, or the driver overrides for the repository's effective config. */
type DriverOverrides = Array<readonly [string, string]> | { readonly refusal: string };

/**
 * The overrides for every driver the effective config defines, or a refusal when one cannot be
 * overridden, the repository defines an unreasonable number, or the config cannot be read (failing
 * closed: running without the overrides would run the programs). Runs `git config --list`, which
 * reads files and starts nothing.
 */
function driverOverrides(gitBin: string, cwd: string, env: Record<string, string>): DriverOverrides {
  const listed = spawnSync(
    gitBin,
    ['--no-pager', ...configArgs(UNTRUSTED_GIT_CONFIG), 'config', '--list', '-z'],
    { cwd, encoding: 'utf8', env, windowsHide: true, shell: false },
  );
  // git could not be started at all: the command that follows reports the same error, and nothing ran.
  if (listed.error !== undefined) return [];
  if (listed.status !== 0) {
    return { refusal: `git could not read the repository configuration (exit ${listed.status ?? 'signal'})` };
  }
  const pairs = new Map<string, string>();
  const names = new Set<string>();
  for (const entry of (listed.stdout ?? '').split('\0')) {
    const key = entry.split('\n', 1)[0] ?? '';
    const first = key.indexOf('.');
    const last = key.lastIndexOf('.');
    if (first < 0 || last <= first) continue;
    const section = key.slice(0, first).toLowerCase();
    const variable = key.slice(last + 1).toLowerCase();
    const name = key.slice(first + 1, last);
    if (!DRIVER_VARIABLES[section]?.includes(variable)) continue;
    if (nameIsUnsafe(name)) {
      return {
        refusal:
          'the repository configuration defines a command driver whose name cannot be passed to git on a command line',
      };
    }
    names.add(`${section}.${name}`);
    pairs.set(`${section}.${name}.${variable}`, variable === 'textconv' ? 'cat' : '');
  }
  if (names.size > MAX_DRIVER_NAMES) {
    return {
      refusal: `the repository configuration defines more than ${MAX_DRIVER_NAMES} command drivers`,
    };
  }
  // A filter marked `required` makes git fail when it is not applied; the filter is off, so it is not required.
  for (const driver of names) {
    if (driver.startsWith('filter.')) pairs.set(`${driver}.required`, 'false');
  }
  return [...pairs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export type UntrustedGitCommand =
  | { readonly argv: string[]; readonly env: Record<string, string> }
  | { readonly refusal: string };

/**
 * The command line and environment `spawnUntrustedGit` uses for `git <args>` in `cwd`, or the reason
 * it will not run it. Exposed so a parity test can compare it with `extract-change`'s copy.
 */
export function untrustedGitCommand(
  gitBin: string,
  cwd: string,
  args: ReadonlyArray<string>,
): UntrustedGitCommand {
  const env = untrustedGitEnv(cwd);
  const drivers = driverOverrides(gitBin, cwd, env);
  if ('refusal' in drivers) return drivers;
  return {
    env,
    argv: ['--no-pager', ...configArgs(UNTRUSTED_GIT_CONFIG), ...configArgs(drivers), ...withDiffGuards(args)],
  };
}

function refused(reason: string): SpawnSyncReturns<string> & SpawnSyncReturns<Buffer> {
  return {
    pid: 0,
    output: [null, null, null],
    stdout: '',
    stderr: '',
    status: null,
    signal: null,
    error: new Error(reason),
  } as unknown as SpawnSyncReturns<string> & SpawnSyncReturns<Buffer>;
}

export interface UntrustedGitOptions {
  /** Bytes written to the command's standard input. */
  readonly input?: string;
  /** Output limit in bytes; the child is killed past it. */
  readonly maxBuffer?: number;
}

/**
 * Runs `git <args>` in `cwd` with every program route closed. `gitBin` is the git the caller found
 * outside the repository. Never goes through a shell. A result with `error` set means nothing ran: git
 * could not be started, or this function refused (the message says why). A caller must report that as a
 * failure, never as an empty answer.
 * `args[0]` must be the subcommand's name (no global options before it).
 */
export function spawnUntrustedGit(
  gitBin: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options: UntrustedGitOptions & { readonly encoding: 'buffer' },
): SpawnSyncReturns<Buffer>;
export function spawnUntrustedGit(
  gitBin: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: UntrustedGitOptions & { readonly encoding?: 'utf8' },
): SpawnSyncReturns<string>;
export function spawnUntrustedGit(
  gitBin: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options: UntrustedGitOptions & { readonly encoding?: 'utf8' | 'buffer' } = {},
): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  const command = untrustedGitCommand(gitBin, cwd, args);
  if ('refusal' in command) return refused(command.refusal);
  const { argv, env } = command;
  const common = {
    cwd,
    env,
    windowsHide: true,
    shell: false,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
  };
  return options.encoding === 'buffer'
    ? spawnSync(gitBin, argv, common)
    : spawnSync(gitBin, argv, { ...common, encoding: 'utf8' });
}
