/**
 * The subprocess layer for `git`.
 *
 * There is deliberately no git library here. `simple-git` and `isomorphic-git`
 * are both avoidable: the commands this extractor needs are four, they have
 * been stable for a decade, and a runtime dependency is a supply-chain
 * liability this project has publicly committed to not taking on
 * (design v3 §2.7, §10).
 *
 * Two rules hold everywhere in this file:
 *
 * 1. **Argument arrays, never a shell string.** `spawnSync` is called with
 *    `shell: false` (the default) and an array. Refs, paths and commit text are
 *    third-party content; none of it is ever concatenated into a command line.
 * 2. **A neutralised environment.** User/system git config is routed to
 *    `os.devNull` so that `log.showSignature`, `log.mailmap`, `diff.external`
 *    and friends cannot change what this extractor reads. Determinism is a
 *    release gate (v3 §2.3); output that depends on the operator's `~/.gitconfig`
 *    is not deterministic.
 * 3. **The repository's own config starts no program.** `.git/config` and
 *    `.gitattributes` belong to whoever delivered the repository, and git runs the
 *    programs they name (`core.fsmonitor`, filters, textconv, external diff, hooks,
 *    `gpg.program`, transports). Every such route is overridden on the command line
 *    in `runGit` (untrusted repository git configuration). The reasoning, and the list's twin that the CLI process
 *    uses, are in `@seamline/core`'s `security/untrusted-git.ts`; this package cannot
 *    import core, so it carries a copy and a test in `@seamline/cli` fails if they differ.
 */
import { spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { delimiter, isAbsolute, resolve, sep } from 'node:path';

/** 64 MiB. A bounded commit range produces far less; this is a stop, not a target. */
export const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface GitInvocation {
  readonly gitBin: string;
  readonly cwd: string;
  readonly maxBufferBytes: number;
}

export interface GitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  /** Set when the process could not run at all: git not on PATH, output over maxBuffer. */
  readonly spawnError: string | null;
}

/**
 * A ref this extractor is willing to hand to git.
 *
 * The leading character must not be `-`, which is what stops a branch named
 * `--upload-pack=...` from being read as an option. Everything else here is
 * ordinary ref-name syntax; `git check-ref-format` is stricter still, and git
 * itself rejects what gets through.
 */
const SAFE_REV = /^[A-Za-z0-9_][A-Za-z0-9._/@^~{}-]*$/;

export function isSafeRev(rev: string): boolean {
  return rev.length > 0 && rev.length <= 256 && SAFE_REV.test(rev);
}

/**
 * Settings with a fixed name, each overridden on the command line. A path value is `os.devNull`, so
 * a route that is somehow reached cannot execute. Kept identical to `@seamline/core`'s
 * `UNTRUSTED_GIT_CONFIG`.
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

const MAX_DRIVER_NAMES = 512;

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

type DriverOverrides = Array<readonly [string, string]> | { readonly refusal: string };

/**
 * Overrides for every driver the effective config defines, or a refusal when one cannot be passed
 * through `-c` (its name holds `=`), there are unreasonably many, or the config cannot be read
 * (failing closed). `git config --list` reads files and starts nothing.
 */
function driverOverrides(inv: GitInvocation, env: Record<string, string>): DriverOverrides {
  const listed = spawnSync(
    inv.gitBin,
    ['--no-pager', ...configArgs(UNTRUSTED_GIT_CONFIG), 'config', '--list', '-z'],
    { cwd: inv.cwd, encoding: 'utf8', env, windowsHide: true, shell: false },
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
    if (name.includes('=') || name.includes('\n') || name.includes('\0')) {
      return {
        refusal:
          'the repository configuration defines a command driver whose name cannot be passed to git on a command line',
      };
    }
    names.add(`${section}.${name}`);
    pairs.set(`${section}.${name}.${variable}`, variable === 'textconv' ? 'cat' : '');
  }
  if (names.size > MAX_DRIVER_NAMES) {
    return { refusal: `the repository configuration defines more than ${MAX_DRIVER_NAMES} command drivers` };
  }
  for (const driver of names) {
    if (driver.startsWith('filter.')) pairs.set(`${driver}.required`, 'false');
  }
  return [...pairs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * `PATH` without the entries a repository could put a program in: empty and relative entries (both
 * mean the working directory) and any entry inside the repository by its spelling. This is the
 * lexical half of `@seamline/core`'s `pathOutsideRepo`. It does not resolve links: this code runs in
 * the extractor sandbox, where a file-system read outside the declared reads is reported as a
 * violation, and the sandbox host has already removed every entry that links into the repository
 * from the PATH this process was given.
 */
function pathOutsideRepo(pathValue: string, repoRoot: string): string {
  const root = resolve(repoRoot);
  return pathValue
    .split(delimiter)
    .filter((entry) => entry !== '' && isAbsolute(entry) && !isInside(root, resolve(entry)))
    .join(delimiter);
}

function deterministicEnv(cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  // PATH is needed to resolve a bare `git`, and nothing else from the caller's environment is
  // forwarded. Entries inside the repository are dropped: git looks up its own helpers on it.
  const path = process.env['PATH'];
  const safePath = path === undefined ? '' : pathOutsideRepo(path, cwd);
  if (safePath !== '') env['PATH'] = safePath;
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot !== undefined) env['SystemRoot'] = systemRoot;
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_CONFIG_SYSTEM'] = devNull;
  env['GIT_CONFIG_GLOBAL'] = devNull;
  env['GIT_ATTR_NOSYSTEM'] = '1';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_TERMINAL_PROMPT'] = '0';
  // This extractor reads a repository's history and nothing else; it makes no network call. In a
  // partial clone a missing blob is fetched from the remote the repository's own `.git/config`
  // names, with the transport program that file names (`core.sshCommand`, `remote.*.uploadpack`),
  // and `git log --find-renames` asks for blobs. `GIT_NO_LAZY_FETCH` turns the fetch off, and an
  // empty `GIT_ALLOW_PROTOCOL` allows no transport at all, so that a git that predates the first
  // still starts no program. A history that needs a blob the clone does not have is then a FAIL
  // (git exits non-zero), never a PASS built on part of it.
  env['GIT_NO_LAZY_FETCH'] = '1';
  env['GIT_ALLOW_PROTOCOL'] = '';
  env['GIT_PAGER'] = 'cat';
  env['GIT_ASKPASS'] = '';
  env['LC_ALL'] = 'C';
  env['LANG'] = 'C';
  env['TZ'] = 'UTC';
  return env;
}

/** What `runGit` would start for `args`, or why it will not. Exposed for the parity test with `@seamline/core`. */
export function gitCommand(
  inv: GitInvocation,
  args: ReadonlyArray<string>,
): { readonly argv: string[]; readonly env: Record<string, string> } | { readonly refusal: string } {
  const env = deterministicEnv(inv.cwd);
  const drivers = driverOverrides(inv, env);
  if ('refusal' in drivers) return drivers;
  return {
    env,
    argv: ['--no-pager', ...configArgs(UNTRUSTED_GIT_CONFIG), ...configArgs(drivers), ...withDiffGuards(args)],
  };
}

/** The `spawnError` of an outcome `runGit` produced by refusing to run, not by git failing. */
export const REFUSED_PREFIX = 'refused: ';

export function runGit(inv: GitInvocation, args: ReadonlyArray<string>): GitOutcome {
  const command = gitCommand(inv, args);
  if ('refusal' in command) {
    return { ok: false, stdout: '', stderr: '', code: null, spawnError: `${REFUSED_PREFIX}${command.refusal}` };
  }
  const r = spawnSync(inv.gitBin, command.argv, {
    cwd: inv.cwd,
    encoding: 'utf8',
    maxBuffer: inv.maxBufferBytes,
    env: command.env,
    windowsHide: true,
    shell: false,
  });
  if (r.error) {
    return { ok: false, stdout: '', stderr: '', code: null, spawnError: r.error.message };
  }
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { ok: r.status === 0, stdout, stderr, code: r.status, spawnError: null };
}

/** Why the configured git cannot be used here, or null when it can. A refusal says so; it is not "not found". */
export function gitUnusable(inv: GitInvocation): string | null {
  const probe = runGit(inv, ['--version']);
  if (probe.ok) return null;
  if (probe.spawnError?.startsWith(REFUSED_PREFIX)) {
    return `git was refused for this repository (${probe.spawnError.slice(REFUSED_PREFIX.length)}); change history cannot be read`;
  }
  return 'git is not executable from PATH; change history cannot be read';
}

/** True when `cwd` is inside a git work tree (a bare repo answers false). */
export function isWorkTree(inv: GitInvocation): boolean {
  const r = runGit(inv, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

/** True for a `--depth`-limited clone, whose history stops at a graft boundary; null when git could not say. */
export function isShallow(inv: GitInvocation): boolean | null {
  const r = runGit(inv, ['rev-parse', '--is-shallow-repository']);
  return r.ok ? r.stdout.trim() === 'true' : null;
}

/** Full 40-hex sha for a rev, or null when it does not resolve to a commit. */
export function resolveCommit(inv: GitInvocation, rev: string): string | null {
  if (!isSafeRev(rev)) return null;
  const r = runGit(inv, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  const sha = r.stdout.trim();
  return r.ok && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * The pieces the parity test in `@seamline/cli` compares with `@seamline/core`'s door. Not an API.
 */
export const untrustedGitInternals = { gitCommand, pathOutsideRepo, deterministicEnv } as const;
