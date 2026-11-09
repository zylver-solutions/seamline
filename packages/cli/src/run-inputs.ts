/**
 * The digest a deterministic run id is derived from (`run-id.ts`).
 *
 * Under `SEAMLINE_DETERMINISTIC=1` the id must be a pure function of the run's
 * inputs: stable when nothing that an extractor can see has changed, different
 * when anything has. Getting "stable" wrong costs nothing but an id that
 * changed when it did not have to, so the digest errs towards covering too
 * much. Getting "different" wrong makes two runs that saw different inputs
 * look like one run repeated. That cannot be ruled out (installed dependencies,
 * a TypeScript version and Seamline's own rules are not in the digest), and
 * nothing relies on it: the store sets the earlier attempt's sightings aside
 * when an id repeats (`SqliteStore.restartRun`), so whatever the new attempt
 * does not re-observe inside a PASS scope is buried (ADR-0009 section 3a).
 *
 * ## What is hashed
 *
 * 1. **The tree: the content of every file under the repository root**, keyed by
 *    its repo-relative POSIX path. A content digest, not the git commit, because
 *    the tree may be dirty (the commit is then the wrong identity) or may not be
 *    a git repository at all. It is deliberately all files, not only the ones
 *    the config's `include`/`exclude` select: those globs bound `extract-code-ts`
 *    only, while `extract-data` and `extract-contracts` walk the root on their
 *    own, and a file one extractor reads that the digest skipped would be an
 *    input the id could not see. Left out, because they are not inputs or cannot
 *    be hashed usefully:
 *    - `.git` (history is handled by item 3), and `node_modules` (a dependency
 *      tree is represented by the lockfile and manifests, which are hashed;
 *      an approximation, as what is installed can change without them);
 *    - the output directory (`graph.db`, the snapshots: what the run writes, not
 *      what it reads, and it would make a second run's id depend on the first);
 *    - `seamline.config.json` at the root, replaced by item 2 so that editing an
 *      export profile does not rename every run;
 *    - file modes and times, which no extractor reads and which differ between
 *      checkouts of the same commit.
 *    A symbolic link is hashed by its target text and never followed.
 * 2. **The effective config**: the repo name (it is the first segment of every
 *    node id), `include`, `exclude`, and for each extractor in this run its
 *    options. `exportProfiles`, `limits` and `outDir` shape queries, export and
 *    where files go, not what is extracted, so they are not in it.
 * 3. **The extractors run, with versions, in the order they run.** They are
 *    the config's enabled extractors narrowed by `--only`, so a partial run
 *    differs from a full one, and the order is part of the input because an
 *    extractor reads what the earlier ones stored (`infer-join` does), so the
 *    same extractors listed in another order can extract different facts.
 *    An extractor that reads something outside the tree, as `extract-change`
 *    reads git history, reports an `inputIdentity` that is folded in (for it,
 *    the resolved commits). A tree-only digest would give two histories with
 *    the same files one id.
 *
 * ## What is not hashed, and why that is sound
 *
 * The authoritative scopes a run claims are not hashed separately. Each is a
 * function of the extractor (name and version), its options and the tree, all of
 * which are above. They are also known only after extraction, and the id is
 * stamped into the facts that extraction produces, so an id derived from them
 * would be circular.
 *
 * Nothing here is absolute or machine-specific: the repository root's own path,
 * the host, the clock and the user do not enter the digest, so a checkout in
 * another directory, or on another machine, produces the same id.
 *
 * The cost is one pass over the tree. It is paid only in deterministic mode,
 * which is for CI gates, golden files and tests.
 */

import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from 'node:fs';
import path from 'node:path';
import { compareCodeUnits } from '@seamline/core';
import { CONFIG_FILENAME } from './config.ts';
import { canonicalJson } from './sif.ts';

/** Bumped when what the digest covers changes, so old and new ids cannot collide. */
export const RUN_INPUTS_FORMAT = 'seamline.run-inputs/1';

/** One extractor in this run. `RunInputs.extractors` lists them in the order they run. */
export interface ExtractorInput {
  readonly name: string;
  /** `null` for an extractor with no implementation wired in (reported UNAVAILABLE). */
  readonly version: string | null;
  /** Verbatim from the config file. */
  readonly options: Readonly<Record<string, unknown>>;
  /** What the extractor reads from outside the tree, or `null` (`ExtractorPort.inputIdentity`). */
  readonly identity: string | null;
}

export interface RunInputs {
  readonly repo: string;
  /** Absolute. Where the walk starts; never part of the digest. */
  readonly repoRoot: string;
  /** Absolute. Skipped by the walk. */
  readonly outDir: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly extractors: readonly ExtractorInput[];
}

/** Directory entries never hashed, wherever they occur. */
const SKIPPED_ENTRIES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

const CHUNK_BYTES = 1 << 16;

function sha256(...parts: ReadonlyArray<string | Uint8Array>): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/** SHA-256 of a file's bytes, read in chunks so a large file is not held in memory. */
function hashFile(file: string): string {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      const n = readSync(fd, chunk, 0, CHUNK_BYTES, null);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * The fingerprint of one tree entry: its content, or a stand-in that is itself
 * a function of the input (a link's target, or why it could not be read). A
 * file that cannot be read is an input the digest cannot see into, so it is
 * recorded as such rather than skipped, and the run does not fail over it.
 */
function fingerprint(absolute: string): string | undefined {
  try {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return `link:${sha256(readlinkSync(absolute))}`;
    if (stat.isFile()) return `file:${hashFile(absolute)}`;
    return undefined;
  } catch (error) {
    return `unreadable:${errorCode(error)}`;
  }
}

/**
 * SHA-256 over the sorted `(path, fingerprint)` pairs of every file under
 * `root` that is not skipped (see the module comment).
 */
export function digestTree(root: string, outDir: string): string {
  const skippedOut = path.resolve(outDir);
  const hash = createHash('sha256');

  const walk = (relative: string): void => {
    const absolute = relative === '' ? root : path.join(root, ...relative.split('/'));
    let names: string[];
    try {
      // Code-unit order: a locale-dependent order would make the digest depend on the locale.
      names = readdirSync(absolute).sort(compareCodeUnits);
    } catch (error) {
      hash.update(`${relative}\0unreadable:${errorCode(error)}\n`);
      return;
    }
    for (const name of names) {
      if (SKIPPED_ENTRIES.has(name)) continue;
      const rel = relative === '' ? name : `${relative}/${name}`;
      if (rel === CONFIG_FILENAME) continue;
      const child = path.join(absolute, name);
      if (path.resolve(child) === skippedOut) continue;
      let isDirectory = false;
      try {
        isDirectory = lstatSync(child).isDirectory();
      } catch {
        // Fingerprinted as unreadable below.
      }
      if (isDirectory) {
        walk(rel);
        continue;
      }
      const print = fingerprint(child);
      if (print !== undefined) hash.update(`${rel}\0${print}\n`);
    }
  };

  walk('');
  return hash.digest('hex');
}

/** The run-inputs digest: 64 lowercase hex digits. */
export function digestRunInputs(inputs: RunInputs): string {
  // In the order they run, not sorted: an extractor reads what the earlier ones
  // stored (`infer-join` reads the store as they filled it), so the same
  // extractors in another order can extract different facts. `canonicalJson`
  // sorts option keys, which are a set, and leaves array order alone.
  const extractors = inputs.extractors.map((e) => ({
    name: e.name,
    version: e.version,
    options: e.options,
    identity: e.identity,
  }));
  return sha256(
    canonicalJson({
      format: RUN_INPUTS_FORMAT,
      repo: inputs.repo,
      include: inputs.include,
      exclude: inputs.exclude,
      extractors,
      tree: digestTree(inputs.repoRoot, inputs.outDir),
    }),
  );
}
