/**
 * The sandbox program the conformance suite runs in place of the extractor under test.
 *
 * It is an ordinary program for the sandbox host (`export run(ctx, graph?)`), loaded by the child
 * after the guards are installed, so everything the host enforces on the extractor is enforced on it
 * too. What it adds is two things the host does not do:
 *
 *  - It counts the repository files the extractor opens for reading, and which of them its declared
 *    globs do not admit. The guard already refuses those, and the host already fails the run; this is
 *    the independent tally the suite reports as evidence, taken at the same fs calls but kept on its
 *    own account.
 *  - When asked (`unreadable`), it makes every open of a repository file fail with EACCES. That is
 *    the only portable way to hand an extractor input it cannot read: a file mode does not stop root,
 *    and a directory in a file's place is simply skipped by a walker. It counts how often it did.
 *
 * It also notes, without changing what happens, the looks the host allows and no glob admits: a
 * stat, an existence check or a directory listing of a path inside the repository. The host lets an
 * extractor look at any path inside the repo (it needs only containment), so these are not
 * violations; the suite prints them so a reader can see what an extractor learned about files it
 * may not read.
 *
 * It then calls the extractor's own `run` with the options the extractor was given, and appends one
 * diagnostic line carrying the tally. It changes nothing else in the result.
 */

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchesReads } from '@seamline/core';
import type { ExtractorManifest } from '@seamline/ontology';
import type { ExtractContext, ExtractorOutput } from '../ports.ts';
import type { GraphSnapshot } from '../sandbox/protocol.ts';
import {
  OBSERVED_PREFIX,
  WRAPPER_KEY,
  type WrapperConfig,
  type WrapperObservation,
} from './observation.ts';
import { BAIT_DIR, STRESS_DIR } from './types.ts';

type AnyFn = (...args: unknown[]) => unknown;
const MAX_TRACKED = 20_000;
const LOOK_FUNCTIONS = [
  'statSync',
  'lstatSync',
  'existsSync',
  'accessSync',
  'stat',
  'lstat',
  'access',
];
const LIST_FUNCTIONS = ['readdirSync', 'readdir', 'opendirSync', 'opendir'];

function eacces(path: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EACCES: permission denied, ${syscall} '${path}'`), {
    errno: -13,
    code: 'EACCES',
    syscall,
    path,
  });
}

function install(root: string, config: WrapperConfig): () => WrapperObservation {
  const manifest = { reads: config.reads } as unknown as ExtractorManifest;
  const opened = new Set<string>();
  const undeclared = new Set<string>();
  const looked = new Set<string>();
  const listed = new Set<string>();
  let stressOpened = 0;
  let baitOpened = 0;
  let faultsHit = 0;

  /** The repo-relative POSIX path `target` names, or undefined when it names nothing inside the repo. */
  const inRepo = (target: unknown): string | undefined => {
    let text: string;
    if (typeof target === 'string') text = target;
    else if (target instanceof URL) text = target.protocol === 'file:' ? target.pathname : '';
    else if (Buffer.isBuffer(target)) text = target.toString('utf8');
    else return undefined;
    if (text === '') return undefined;
    const rel = relative(root, resolve(text));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return sep === '/' ? rel : rel.split(sep).join('/');
  };

  /** Records an open of `target`; true when it is a repository file this run must make fail. */
  const note = (target: unknown): boolean => {
    const posix = inRepo(target);
    if (posix === undefined) return false;
    if (opened.size < MAX_TRACKED && !opened.has(posix)) {
      opened.add(posix);
      if (posix.startsWith(`${STRESS_DIR}/`)) stressOpened += 1;
      if (posix.startsWith(`${BAIT_DIR}/`)) baitOpened += 1;
    }
    if (!matchesReads(manifest, posix) && undeclared.size < 5) undeclared.add(posix);
    if (!config.unreadable) return false;
    faultsHit += 1;
    return true;
  };

  const target = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;
  const patch = (
    holder: Record<string, unknown>,
    name: string,
    style: 'sync' | 'callback' | 'promise' | 'stream',
  ): void => {
    const original = holder[name];
    if (typeof original !== 'function') return;
    const wrapped: AnyFn = function (this: unknown, ...args: unknown[]) {
      if (!note(args[0])) return (original as AnyFn).apply(this, args);
      const error = eacces(String(args[0]), 'open');
      if (style === 'sync') throw error;
      if (style === 'promise') return Promise.reject(error);
      if (style === 'stream') {
        const stream = new Readable({ read() {} });
        process.nextTick(() => stream.destroy(error));
        return stream;
      }
      const callback = args.find((a) => typeof a === 'function') as AnyFn | undefined;
      if (callback !== undefined) process.nextTick(callback, error);
      return undefined;
    };
    Object.assign(wrapped, original);
    Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
    holder[name] = wrapped;
  };

  /** Wraps `name` so that a call is noted first and then made exactly as before. */
  const watch = (
    holder: Record<string, unknown>,
    name: string,
    into: Set<string>,
    onlyUndeclared: boolean,
  ): void => {
    const original = holder[name];
    if (typeof original !== 'function') return;
    const wrapped: AnyFn = function (this: unknown, ...args: unknown[]) {
      const posix = inRepo(args[0]);
      if (
        posix !== undefined &&
        into.size < MAX_TRACKED &&
        (!onlyUndeclared || !matchesReads(manifest, posix))
      ) {
        into.add(posix);
      }
      return (original as AnyFn).apply(this, args);
    };
    Object.assign(wrapped, original);
    Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
    holder[name] = wrapped;
  };
  for (const name of LOOK_FUNCTIONS) {
    watch(target, name, looked, true);
    watch(promises, name, looked, true);
  }
  for (const name of LIST_FUNCTIONS) {
    watch(target, name, listed, false);
    watch(promises, name, listed, false);
  }

  patch(target, 'readFileSync', 'sync');
  patch(target, 'openSync', 'sync');
  patch(target, 'readFile', 'callback');
  patch(target, 'open', 'callback');
  patch(target, 'createReadStream', 'stream');
  patch(promises, 'readFile', 'promise');
  patch(promises, 'open', 'promise');
  syncBuiltinESMExports();

  return () => ({
    opened: opened.size,
    undeclared: [...undeclared].sort(),
    faultsHit,
    stressOpened,
    baitOpened,
    looked: looked.size,
    lookedAt: [...looked].sort().slice(0, 5),
    listed: listed.size,
  });
}

export async function run(ctx: ExtractContext, graph?: GraphSnapshot): Promise<ExtractorOutput> {
  const { [WRAPPER_KEY]: raw, ...options } = ctx.options;
  const config = raw as WrapperConfig | undefined;
  if (config === undefined || typeof config.target !== 'string') {
    throw new Error('the conformance wrapper was started without a target extractor');
  }
  const tally = install(resolve(ctx.repoRoot), config);
  const program = (await import(pathToFileURL(config.target).href)) as {
    run?: (ctx: ExtractContext, graph?: GraphSnapshot) => Promise<ExtractorOutput>;
  };
  if (typeof program.run !== 'function') throw new Error('the extractor module exports no run()');
  const output = await program.run({ ...ctx, options }, graph);
  const line = `${OBSERVED_PREFIX}${JSON.stringify(tally())}`;
  return {
    ...output,
    result: { ...output.result, diagnostics: [...output.result.diagnostics, line] },
  };
}
