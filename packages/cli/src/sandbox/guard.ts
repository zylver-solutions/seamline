/**
 * The guard a sandbox child installs before any extractor code is loaded.
 *
 * This is the second layer. The first is Node's permission model, which the
 * host switches on with `--permission`: it is enforced by the runtime, covers
 * file reads and writes by directory, and stops a child process, a worker, a
 * native addon or WASI unless granted. It leaves three gaps, and these guards
 * exist for them:
 *
 *  1. It follows a symlink out of an allowed directory, so a link inside the
 *     repo that points at `~/.ssh` reads fine. (Checked on Node 22.13, 22.22
 *     and 24.22.) The guard resolves the real path of every request and refuses
 *     what lands outside the repo.
 *  2. It works on directories, not on the globs a manifest's `reads` declares.
 *     The guard applies the globs to every content read.
 *  3. It does not cover the network at all before Node 25. The guard refuses
 *     sockets, servers, DNS, `fetch` and `WebSocket`.
 *
 * These guards are JavaScript replacing properties of built-in modules in the
 * same realm the extractor runs in. They stop first-party code that wanders or
 * regresses, and they make every attempt visible; they do not stop an
 * extractor that is written to defeat them, and are not offered as if they
 * did. THREATMODEL.md (C4, R5) says so.
 *
 * What the guard does with a refusal:
 *  - A content read, a write, a socket or a process the manifest does not
 *    permit throws a `SandboxViolation` and is recorded as fatal. The host
 *    reports FAIL for the run however the extractor handled the error.
 *  - A metadata probe (`stat`, `readdir`, `realpath`, `access`, `exists`) of
 *    something outside the repo is answered "not found", the way a program
 *    walking up a directory tree for a `node_modules` expects, and is recorded
 *    as not fatal.
 *  - A probe of a path the repo names that resolves outside it (a link swapped
 *    in for a source file, a directory that is a link, a `..` after a real
 *    directory that lands on one) is answered "not found" as well, but is
 *    recorded as fatal: the run fails rather than pass with that file missing.
 *    The repo names a path when the string the extractor passed, resolved
 *    against the working directory, lies inside the repo root: the real path
 *    the request gives, or the spelling the caller used for it, which differs
 *    when the repo is reached through a symlinked directory (the working
 *    directory is always the real path). A name that goes through the link is
 *    one the runtime will refuse, since only the real path is granted, so it
 *    is refused here as well and recorded as fatal. A name that lies outside
 *    every spelling of the root is the world outside, and is not fatal. Under a
 *    `node_modules` directory it is not fatal either, because a dependency
 *    link is not a fact of the repo.
 */

import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import inspector from 'node:inspector';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { SandboxViolation, createAccessChecker } from '@seamline/core';
import type { AccessKind, SandboxViolationCode } from '@seamline/core';
import type { RecordedDenial, SandboxRequest } from './protocol.ts';

type AnyFn = (...args: unknown[]) => unknown;
type Bag = Record<string, unknown>;

export interface Guard {
  /** Everything refused so far, distinct by code and message, with counts. */
  denials(): RecordedDenial[];
  /**
   * True when a refusal that fails the run was not kept in `denials()` because the log was full.
   * A caller that reads the log for what the extractor asked for (only looks, or also content)
   * must not read it as complete when this is true.
   */
  truncated(): boolean;
}

// Each kind of refusal has a budget of its own, so that one kind can never crowd out another: an
// extractor that makes hundreds of distinct refused looks must not be able to push the read of an
// outside file out of the log. The first refusal of each kind is therefore always kept.
const MAX_DISTINCT_PROBES = 64;
const MAX_DISTINCT_FATAL_PROBES = 256;
const MAX_DISTINCT_CONTENT = 256;

/** 0: a look answered "not found" that does not fail the run. 1: a look that does. 2: anything that asked for content. */
type Rank = 0 | 1 | 2;
const CAPS: Readonly<Record<Rank, number>> = {
  0: MAX_DISTINCT_PROBES,
  1: MAX_DISTINCT_FATAL_PROBES,
  2: MAX_DISTINCT_CONTENT,
};

interface Entry {
  code: SandboxViolationCode;
  message: string;
  rank: Rank;
  count: number;
}

class DenialLog {
  readonly #entries = new Map<string, Entry>();
  readonly #held: Record<Rank, number> = { 0: 0, 1: 0, 2: 0 };
  #truncated = false;

  record(
    code: SandboxViolationCode,
    message: string,
    fatal: boolean,
    access: 'content' | 'probe',
  ): void {
    const rank: Rank = !fatal ? 0 : access === 'probe' ? 1 : 2;
    const key = `${code}\0${message}`;
    const hit = this.#entries.get(key);
    if (hit !== undefined) {
      hit.count += 1;
      // The same refusal reached by a stronger kind of access is that kind: a content read and a
      // stat of one path carry the same code and message, and the read must not be hidden by the
      // stat that came first.
      if (rank > hit.rank) {
        this.#held[hit.rank] -= 1;
        hit.rank = rank;
        this.#held[rank] += 1;
      }
      return;
    }
    if (this.#held[rank] >= CAPS[rank]) {
      // A look that does not fail the run is only ever a courtesy to the reader and may be dropped
      // silently. Anything that does fail it was refused and is not in the log: say so.
      if (rank > 0) this.#truncated = true;
      return;
    }
    this.#held[rank] += 1;
    this.#entries.set(key, { code, message, rank, count: 1 });
  }

  all(): RecordedDenial[] {
    return [...this.#entries.values()].map((e) => ({
      code: e.code,
      message: e.message,
      fatal: e.rank > 0,
      access: e.rank === 2 ? 'content' : 'probe',
      count: e.count,
    }));
  }

  truncated(): boolean {
    return this.#truncated;
  }
}

function notFound(syscall: string, path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), {
    errno: -2,
    code: 'ENOENT',
    syscall,
    path,
  });
}

/**
 * Replaces `target[name]` with `make(original)`, which keeps the original's static members
 * (`realpathSync.native`) and, when `delegates` (the wrapper calls the original after its check),
 * its symbol-keyed ones as well: they are not enumerable, so `Object.assign` leaves them, and
 * `util.promisify` looks for its `custom` hook, and for the names of a callback's arguments, there.
 *
 * A wrapper that only refuses must not carry them: the hook of `exec` calls Node's own `exec`, not
 * the wrapper, and would hand the caller the very function that was taken away. A hook that does
 * call Node's own function behind a wrapper that delegates (`execFile`) is still judged, because
 * every asynchronous start funnels through `ChildProcess#spawn`, patched below.
 */
function replace(
  target: Bag,
  name: string,
  make: (original: AnyFn) => AnyFn,
  delegates = true,
): AnyFn | undefined {
  const original = target[name];
  if (typeof original !== 'function') return undefined;
  const wrapped = make(original as AnyFn);
  Object.assign(wrapped, original);
  if (delegates) {
    for (const symbol of Object.getOwnPropertySymbols(original)) {
      const descriptor = Object.getOwnPropertyDescriptor(original, symbol);
      if (descriptor !== undefined) Object.defineProperty(wrapped, symbol, descriptor);
    }
  }
  Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
  target[name] = wrapped;
  return wrapped;
}

/** The fields `child_process` reads from the options of a start, which an inherited property can supply. */
const START_OPTION_FIELDS: ReadonlyArray<string> = [
  'argv0',
  'args',
  'cwd',
  'detached',
  'encoding',
  'env',
  'envPairs',
  'file',
  'gid',
  'input',
  'killSignal',
  'maxBuffer',
  'serialization',
  'shell',
  'signal',
  'stdio',
  'timeout',
  'uid',
  'windowsHide',
  'windowsVerbatimArguments',
];

/**
 * A copy of the options object of a start, in which every field is read once, or the value itself
 * when it is not an options object (a program's argument array, a callback).
 *
 * The guard decides on `shell`, and Node reads the options again to start the process. An object
 * whose `shell` answers differently the second time (a getter) would pass the first read and run
 * through a shell on the second. The copy is what is checked and what Node is handed, so there is
 * no second read of the caller's object. Fields are copied by reference, one level deep: a
 * `stdio` array or a `signal` is the caller's own.
 */
function snapshotOptions(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const source = value as Bag;
  const copy = Object.create(null) as Bag;
  for (const key of Object.keys(source)) copy[key] = source[key];
  for (const key of START_OPTION_FIELDS) {
    if (!(key in copy) && key in source) copy[key] = source[key];
  }
  return copy;
}

/** The path a call names, as a string; undefined for a file descriptor, a handle, or anything unrecognised. */
function pathOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) {
    try {
      return fileURLToPath(arg);
    } catch {
      return undefined;
    }
  }
  if (arg instanceof Uint8Array) return Buffer.from(arg).toString();
  return undefined;
}

/** `open`-style flags that ask for write access. */
function opensForWrite(flags: unknown): boolean {
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  if (typeof flags === 'number') {
    const c = fs.constants;
    return (flags & (c.O_WRONLY | c.O_RDWR | c.O_APPEND | c.O_CREAT | c.O_TRUNC)) !== 0;
  }
  return false;
}

const FS_PROBES = [
  'stat',
  'lstat',
  'access',
  'readdir',
  'opendir',
  'readlink',
  'realpath',
  'statfs',
] as const;
const FS_WRITES = [
  'writeFile',
  'appendFile',
  'mkdir',
  'mkdtemp',
  'rm',
  'rmdir',
  'unlink',
  'rename',
  'copyFile',
  'cp',
  'symlink',
  'link',
  'chmod',
  'chown',
  'lchmod',
  'lchown',
  'utimes',
  'lutimes',
  'truncate',
] as const;

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function installGuards(request: SandboxRequest): Guard {
  const name = request.manifest.name;
  const repoRoot = resolve(request.repoRoot);
  const log = new DenialLog();
  // Captured before anything is replaced: the checker must not decide through the guard it belongs to.
  const realpath = fs.realpathSync.native;
  // The repo root as it really is, for a name judged lexically (`refusal`); the root as the request
  // gave it when it cannot be resolved, which is then the only reading there is.
  const realRepoRoot = (() => {
    try {
      return realpath(repoRoot);
    } catch {
      return repoRoot;
    }
  })();
  // The root as the caller named it, when that is another string. It is only ever compared with a
  // name as a string: the runtime refuses a look at a spelling that was not granted, and the host
  // grants the real one.
  const namedRoot = request.repoRootAs === undefined ? undefined : resolve(request.repoRootAs);
  /** The spelling of the repo root that holds `abs`, or the real one when none does. */
  const rootHolding = (abs: string): string =>
    [repoRoot, realRepoRoot, namedRoot].find((r) => r !== undefined && isInside(r, abs)) ??
    repoRoot;
  const checker = createAccessChecker(
    { manifest: request.manifest, repoRoot: request.repoRoot, codeRoots: request.codeRoots },
    { realpath },
  );
  let deciding = false;

  const violation = (code: SandboxViolationCode, message: string): SandboxViolation => {
    log.record(code, message, true, 'content');
    return new SandboxViolation(code, name, message);
  };

  // -------------------------------------------------------------------------
  // Filesystem
  // -------------------------------------------------------------------------

  const display = (p: string): string => {
    const rel = relative(rootHolding(resolve(p)), resolve(p));
    return rel === '' ? '.' : rel.split('\\').join('/');
  };

  /** True when a path, taken relative to the repo root, passes through a `node_modules` directory. */
  const underNodeModules = (p: string): boolean => {
    const abs = resolve(process.cwd(), p);
    return relative(rootHolding(abs), abs).split(sep).includes('node_modules');
  };

  /**
   * The path the kernel will open for this string. A `..` after a symlink steps up from where the
   * link leads, so `src/link/../x` with `link` pointing outside the repo names a file next to the
   * link's target, not `src/x`; `resolve` would collapse it to `src/x` before following any link.
   * With a `..` segment in the raw string the decision is taken on the real path of the raw
   * absolute name, and on the lexical name only when that cannot be resolved (the open would fail
   * too, or the runtime refuses to look).
   */
  const kernelName = (target: string): string => {
    if (!target.split(/[\\/]+/).includes('..')) return target;
    try {
      return realpath(isAbsolute(target) ? target : `${process.cwd()}${sep}${target}`);
    } catch {
      return target;
    }
  };

  /** True for a name that spells the repo the way the caller did, through a link, and not by its real path. */
  const throughLink = (target: string): boolean => {
    if (namedRoot === undefined) return false;
    const abs = resolve(process.cwd(), target);
    return isInside(namedRoot, abs) && !isInside(repoRoot, abs) && !isInside(realRepoRoot, abs);
  };

  /** The error to raise for this call, or undefined to let it through. */
  const refusal = (op: string, kind: AccessKind | 'write', args: unknown[]): Error | undefined => {
    if (deciding) return undefined;
    const target = pathOf(args[0]);
    if (target === undefined) return undefined;
    if (kind === 'write') {
      return violation('fs-write', `${op} ${display(target)} is refused: extractors are read-only`);
    }
    deciding = true;
    let decision: ReturnType<typeof checker.check>;
    try {
      decision = checker.check(kernelName(target), kind, process.cwd());
    } finally {
      deciding = false;
    }
    if (decision.allowed && throughLink(target)) {
      // The checker allowed it by the real path it resolves to (a name with a `..` is resolved that
      // way), but the runtime compares the string with what it granted, the real path of the repo,
      // and will refuse it with an error of its own that the guard never sees. Told here, it is
      // recorded: an extractor that swallows that error would otherwise pass without the file.
      const message = `${display(target)} names the repo through a link, and only its real path is open`;
      if (kind === 'read') return violation('path-escape', message);
      log.record('path-escape', message, true, 'probe');
      return notFound(op, target);
    }
    if (decision.allowed) return undefined;
    if (kind === 'read') {
      log.record(decision.violation.code, decision.violation.detail, true, 'content');
      return decision.violation;
    }
    // A look at a path the repo names that leads out of it (a link swapped in for a source file,
    // a directory that is a link to elsewhere) is not a resolver walking up to a parent's
    // `node_modules`: the extractor is told the file is not there, and a PASS built on that would
    // read as "the fact does not exist" and tombstone it. It is recorded as fatal, so the run
    // fails instead, and the answer the extractor gets is still "not found". A path under a
    // `node_modules` directory is dependency resolution, not a fact of the repo, and stays a
    // logged non-event (THREATMODEL.md C4 names this limit).
    //
    // "The repo names it" is a question about the string the extractor passed, not about where the
    // kernel opens it. `kernelName` hands the checker the real path when the string has a `..`
    // (so `src/real/../dir-out` is judged as the outside directory it leads to, `path-escape`),
    // and then the checker's own `namedInsideRepo` is false. The lexical reading of the raw string
    // is asked separately, and either reading counts. A relative name is resolved against the
    // working directory, which is always a real path, so the name is asked against the repo root
    // as the request gave it, against that root as it really is, and against the root as the
    // caller named it: they differ when the repository is reached through a link.
    const resolvedName = resolve(process.cwd(), target);
    const namedInside =
      decision.namedInsideRepo ||
      isInside(repoRoot, resolvedName) ||
      isInside(realRepoRoot, resolvedName) ||
      (namedRoot !== undefined && isInside(namedRoot, resolvedName));
    const hidesRepoPath =
      namedInside &&
      (decision.violation.code === 'symlink-escape' || decision.violation.code === 'path-escape') &&
      !underNodeModules(target);
    log.record(decision.violation.code, decision.violation.detail, hidesRepoPath, 'probe');
    return notFound(op, target);
  };

  const fsBag = fs as unknown as Bag;
  const promisesBag = fs.promises as unknown as Bag;

  const guardSync = (
    target: Bag,
    fn: string,
    op: string,
    kindOf: (args: unknown[]) => AccessKind | 'write',
  ): void => {
    replace(
      target,
      fn,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          const error = refusal(op, kindOf(args), args);
          if (error !== undefined) throw error;
          return Reflect.apply(original, this, args);
        },
    );
  };
  const guardCallback = (
    fn: string,
    op: string,
    kindOf: (args: unknown[]) => AccessKind | 'write',
  ): void => {
    replace(
      fsBag,
      fn,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          const error = refusal(op, kindOf(args), args);
          if (error === undefined) return Reflect.apply(original, this, args);
          const callback = args[args.length - 1];
          if (typeof callback !== 'function') throw error;
          process.nextTick(callback as AnyFn, error);
          return undefined;
        },
    );
  };
  const guardPromise = (
    fn: string,
    op: string,
    kindOf: (args: unknown[]) => AccessKind | 'write',
  ): void => {
    replace(
      promisesBag,
      fn,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          const error = refusal(op, kindOf(args), args);
          if (error !== undefined) return Promise.reject(error);
          return Reflect.apply(original, this, args);
        },
    );
  };
  const guardAll = (base: string, kindOf: (args: unknown[]) => AccessKind | 'write'): void => {
    guardSync(fsBag, `${base}Sync`, base, kindOf);
    guardCallback(base, base, kindOf);
    guardPromise(base, base, kindOf);
  };

  const read = (): AccessKind => 'read';
  const probe = (): AccessKind => 'probe';
  const write = (): 'write' => 'write';
  const byFlags = (args: unknown[]): AccessKind | 'write' =>
    opensForWrite(args[1]) ? 'write' : 'read';

  guardAll('readFile', read);
  guardAll('open', byFlags);
  for (const op of FS_PROBES) guardAll(op, probe);
  for (const op of FS_WRITES) guardAll(op, write);
  guardSync(fsBag, 'createReadStream', 'createReadStream', read);
  guardSync(fsBag, 'createWriteStream', 'createWriteStream', write);
  guardSync(fsBag, 'openAsBlob', 'openAsBlob', read);
  guardSync(fsBag, 'watch', 'watch', probe);
  guardSync(fsBag, 'watchFile', 'watchFile', probe);
  // Kept as the `native` member of the wrapped functions, which `replace` copied over from the originals.
  for (const fn of ['realpathSync', 'realpath'] as const) {
    const wrapped = fsBag[fn] as AnyFn & { native?: AnyFn };
    const nativeOriginal = wrapped.native;
    if (typeof nativeOriginal === 'function') {
      wrapped.native = function (this: unknown, ...args: unknown[]) {
        const error = refusal(fn, 'probe', args);
        if (error !== undefined) {
          const callback = args[args.length - 1];
          if (fn === 'realpath' && typeof callback === 'function') {
            process.nextTick(callback as AnyFn, error);
            return undefined;
          }
          throw error;
        }
        return Reflect.apply(nativeOriginal, this, args);
      };
    }
  }
  // `exists` answers a boolean and never throws.
  replace(
    fsBag,
    'existsSync',
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        if (refusal('exists', 'probe', args) !== undefined) return false;
        return Reflect.apply(original, this, args);
      },
  );
  replace(
    fsBag,
    'exists',
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        if (refusal('exists', 'probe', args) === undefined)
          return Reflect.apply(original, this, args);
        const callback = args[args.length - 1];
        if (typeof callback === 'function') process.nextTick(callback as AnyFn, false);
        return undefined;
      },
  );

  // -------------------------------------------------------------------------
  // Network: `net` is `false` in every manifest and there is no way to ask for it.
  // -------------------------------------------------------------------------

  const refuseSync = (target: Bag, fn: string, label: string): void => {
    replace(
      target,
      fn,
      () =>
        function () {
          throw violation(
            'network',
            `${label} is refused: net is false in every extractor manifest`,
          );
        },
      false,
    );
  };
  const refuseAsync = (target: Bag, fn: string, label: string): void => {
    replace(
      target,
      fn,
      () =>
        function () {
          return Promise.reject(
            violation('network', `${label} is refused: net is false in every extractor manifest`),
          );
        },
      false,
    );
  };

  for (const fn of ['connect', 'createConnection', 'createServer'])
    refuseSync(net as unknown as Bag, fn, `net.${fn}`);
  refuseSync(net.Socket.prototype as unknown as Bag, 'connect', 'net.Socket#connect');
  refuseSync(net.Server.prototype as unknown as Bag, 'listen', 'net.Server#listen');
  for (const fn of ['connect', 'createServer']) refuseSync(tls as unknown as Bag, fn, `tls.${fn}`);
  for (const fn of ['request', 'get', 'createServer']) {
    refuseSync(http as unknown as Bag, fn, `http.${fn}`);
    refuseSync(https as unknown as Bag, fn, `https.${fn}`);
  }
  for (const fn of ['connect', 'createServer', 'createSecureServer'])
    refuseSync(http2 as unknown as Bag, fn, `http2.${fn}`);
  refuseSync(dgram as unknown as Bag, 'createSocket', 'dgram.createSocket');
  const DNS_CALLS = [
    'lookup',
    'lookupService',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCaa',
    'resolveCname',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
    'reverse',
  ];
  for (const fn of DNS_CALLS) {
    refuseSync(dns as unknown as Bag, fn, `dns.${fn}`);
    refuseAsync(dns.promises as unknown as Bag, fn, `dns.promises.${fn}`);
    refuseSync(dns.Resolver.prototype as unknown as Bag, fn, `dns.Resolver#${fn}`);
    refuseAsync(
      dns.promises.Resolver.prototype as unknown as Bag,
      fn,
      `dns.promises.Resolver#${fn}`,
    );
  }
  refuseSync(inspector as unknown as Bag, 'open', 'inspector.open');
  const globals = globalThis as unknown as Bag;
  for (const fn of ['fetch', 'WebSocket', 'EventSource']) {
    if (globals[fn] === undefined) continue;
    Object.defineProperty(globalThis, fn, {
      configurable: true,
      writable: true,
      enumerable: false,
      value: function () {
        throw violation('network', `${fn} is refused: net is false in every extractor manifest`);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Child processes: only the programs the host granted, each at the one path it found for it,
  // never through a shell.
  // -------------------------------------------------------------------------

  // Base name to the real absolute path the host resolved, outside the repository. The host does
  // that, not this guard: here a look at a path that was not granted is refused by the runtime on
  // some Node versions (`realpath` of `/usr/bin/git` and of the repo's planted file alike), so a
  // name cannot be judged by where it leads. It is judged by what it says instead, and only two
  // things are good enough: the bare name, which is replaced by the host's path before anything is
  // started (so `PATH`, whatever the call passes as its own, is never searched), and exactly that
  // path. Every other string that names a file, however it reaches the repository (`..`, a link,
  // `/proc/self/cwd`, `/proc/self/root`, `/dev/fd`), is refused because it is not the granted one.
  const grantedNames = new Set(request.grants.exec);
  const hostPaths = new Map(Object.entries(request.grants.execPaths ?? {}));
  const grantedPaths = new Set(hostPaths.values());
  const stripExtension = (s: string): string => s.replace(/\.(exe|cmd|bat)$/i, '');
  /**
   * What to run in place of `file`, or why it is refused. The result is the path the process is
   * started at: the host's, whichever of the two allowed spellings the caller used.
   */
  const commandTarget = (
    file: unknown,
    rest: unknown[],
  ): { readonly run: string } | { readonly problem: string } => {
    if (typeof file !== 'string' || file === '') return { problem: 'no command to run' };
    if (rest.some((a) => typeof a === 'object' && a !== null && (a as Bag)['shell'])) {
      return { problem: `${file} through a shell` };
    }
    const hasSeparator = /[\\/]/.test(file);
    const base = stripExtension(basename(file));
    if (!grantedNames.has(base)) {
      return {
        problem: `${base}, which is not a granted binary (granted: ${[...grantedNames].join(', ') || 'none'})`,
      };
    }
    if (!hasSeparator) {
      // A name the host found no path for cannot be started: PATH is never searched here.
      const path = hostPaths.get(base);
      return path === undefined
        ? { problem: `${file}, which the host resolved to no path` }
        : { run: path };
    }
    if (grantedPaths.has(file)) return { run: file };
    if (!isAbsolute(file)) {
      return {
        problem: `${file}, a relative path (a grant is a program on PATH, or the path the host found for it)`,
      };
    }
    // The text of the name decides which refusal is shown, never whether it is refused.
    const abs = resolve(file);
    const where = [repoRoot, realRepoRoot, namedRoot].some(
      (r) => r !== undefined && isInside(r, abs),
    )
      ? 'a program inside the repository'
      : ['/proc', '/dev/fd'].some((d) => isInside(d, abs))
        ? 'a path under /proc or /dev/fd'
        : 'an absolute path other than the one the host found (use the bare name)';
    return { problem: `${file}, ${where}` };
  };
  const refuseExec = (problem: string): SandboxViolation =>
    violation('exec', `starting ${problem} is refused`);
  for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    replace(
      childProcess as unknown as Bag,
      fn,
      (original) =>
        function (this: unknown, ...args: unknown[]) {
          // The options are read once, here, and Node is handed what was read: an object that
          // answers differently the second time (a getter) cannot pass the check and then run
          // through a shell.
          const rest = args.slice(1).map(snapshotOptions);
          const target = commandTarget(args[0], rest);
          if ('problem' in target) throw refuseExec(target.problem);
          return Reflect.apply(original, this, [target.run, ...rest]);
        },
    );
  }
  // Refused whatever they are given, and without the promisify hook: `promisify(exec)` reaches the
  // refusal, not Node's own `exec`.
  for (const fn of ['exec', 'execSync', 'fork']) {
    replace(
      childProcess as unknown as Bag,
      fn,
      () =>
        function () {
          throw refuseExec(`${fn}()`);
        },
      false,
    );
  }
  // `process.execve` (Node 22.15 and 23.11 on) replaces this process with a program. It is not in
  // `child_process`, the permission model gates it by `--allow-child-process` alone, and it takes
  // a path as given, so a granted binary would let it run the repository's own file. Nothing a
  // first-party extractor does needs it.
  replace(
    process as unknown as Bag,
    'execve',
    () =>
      function () {
        throw refuseExec('process.execve()');
      },
    false,
  );
  // Every asynchronous start funnels through here, including a hand-built ChildProcess.
  replace(
    childProcess.ChildProcess.prototype as unknown as Bag,
    'spawn',
    (original) =>
      function (this: unknown, ...args: unknown[]) {
        // Read once, as above: what is checked is what Node starts.
        const options = snapshotOptions(args[0]) as Bag | undefined;
        const target = commandTarget(options?.['file'], []);
        if ('problem' in target) throw refuseExec(target.problem);
        // Started by a bare name only when a ChildProcess is built by hand; the calls above have
        // already put the host's path there.
        return Reflect.apply(original, this, [{ ...options, file: target.run }, ...args.slice(1)]);
      },
  );

  // The ESM facades of the built-ins above were created before they were patched.
  syncBuiltinESMExports();

  return { denials: () => log.all(), truncated: () => log.truncated() };
}
