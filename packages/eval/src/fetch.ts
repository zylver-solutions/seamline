/**
 * Fetching the corpus into a gitignored cache and proving it is the pinned tree.
 *
 * `fetchRepo` is the only function here that may touch the network (through a
 * plain `git clone` / `git fetch` subprocess). `verifyPinned` is offline and
 * is what every evaluation run calls: a checkout whose `HEAD` is not the
 * pinned commit, or whose working tree has local changes, is refused rather
 * than measured.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DirtyCheckoutError, PinMismatchError, UnguardedCheckoutError } from './errors.ts';
import { runGit, type GitRunner } from './git.ts';
import type { CorpusEntry } from './types.ts';

export interface FetchOptions {
  readonly cacheDir: string;
  /**
   * Directory holding local clones named after the corpus entries. When
   * `<mirrorDir>/<name>` exists, git borrows its objects while cloning from the
   * URL, which is a speed-up for development only: the URL is still the origin
   * and the pin is verified the same way.
   */
  readonly mirrorDir?: string | undefined;
  readonly git?: GitRunner;
  readonly log?: (line: string) => void;
}

export type FetchAction = 'cloned' | 'repinned' | 'reused';

export interface FetchResult {
  readonly dir: string;
  readonly action: FetchAction;
}

export function checkoutDir(cacheDir: string, name: string): string {
  return path.join(cacheDir, name);
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** True when `dir` holds a clone (the clone's metadata directory exists). */
export async function isCloned(dir: string): Promise<boolean> {
  return isDirectory(path.join(dir, '.git'));
}

async function hasCommit(git: GitRunner, dir: string, sha: string): Promise<boolean> {
  try {
    await git(['cat-file', '-e', `${sha}^{commit}`], dir);
    return true;
  } catch {
    return false;
  }
}

async function headOf(git: GitRunner, dir: string): Promise<string> {
  try {
    return (await git(['rev-parse', 'HEAD'], dir)).trim();
  } catch {
    return '(no HEAD)';
  }
}

async function dirtyPaths(git: GitRunner, dir: string): Promise<readonly string[]> {
  const out = await git(
    ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=all'],
    dir,
  );
  return out.split('\n').filter((line) => line.trim() !== '');
}

/**
 * Written to `<clone>/.git/info/attributes`, which outranks every
 * `.gitattributes` inside the fetched tree. It unsets the attributes that make
 * a checkout differ from the stored blobs: line-ending conversion, `$Id$`
 * expansion, re-encoding, and clean/smudge filters (Git LFS included). The
 * working tree is then the committed bytes, whatever the repository, a global
 * Git configuration, or an installed filter driver would otherwise do.
 */
export const ATTRIBUTES_GUARD = '* -text -eol -ident -filter -working-tree-encoding\n';

function guardFile(dir: string): string {
  return path.join(dir, '.git', 'info', 'attributes');
}

async function hasAttributesGuard(dir: string): Promise<boolean> {
  try {
    return (await readFile(guardFile(dir), 'utf8')) === ATTRIBUTES_GUARD;
  } catch {
    return false;
  }
}

/** Installs the guard. Returns true when it changed (so the tree must be checked out again). */
async function installAttributesGuard(dir: string): Promise<boolean> {
  if (await hasAttributesGuard(dir)) return false;
  await mkdir(path.dirname(guardFile(dir)), { recursive: true });
  await writeFile(guardFile(dir), ATTRIBUTES_GUARD, 'utf8');
  return true;
}

/**
 * Throws unless `dir` is a checkout of exactly `entry.sha`, made with the
 * attribute guard, with a clean tree. Offline.
 */
export async function verifyPinned(
  entry: CorpusEntry,
  dir: string,
  git: GitRunner = runGit,
): Promise<void> {
  const head = await headOf(git, dir);
  if (head !== entry.sha) throw new PinMismatchError(entry.name, entry.sha, head);
  if (!(await hasAttributesGuard(dir))) throw new UnguardedCheckoutError(entry.name);
  const dirty = await dirtyPaths(git, dir);
  if (dirty.length > 0) throw new DirtyCheckoutError(entry.name, dirty);
}

/**
 * Makes `<cacheDir>/<name>` a clean checkout of the pinned commit, cloning
 * when it is missing, and verifies the result. Never runs anything from the
 * fetched tree.
 */
export async function fetchRepo(entry: CorpusEntry, opts: FetchOptions): Promise<FetchResult> {
  const git = opts.git ?? runGit;
  const log = opts.log ?? (() => {});
  const dir = checkoutDir(opts.cacheDir, entry.name);
  let action: FetchAction = 'reused';

  if (!(await isCloned(dir))) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(opts.cacheDir, { recursive: true });
    const mirror =
      opts.mirrorDir === undefined ? undefined : path.resolve(opts.mirrorDir, entry.name);
    const local = mirror !== undefined && (await isDirectory(mirror));
    log(`${entry.name}: cloning ${entry.url}${local ? ` (borrowing objects from ${mirror})` : ''}`);
    try {
      await git([
        'clone',
        '--no-checkout',
        '--no-tags',
        '--filter=blob:none',
        ...(local ? ['--reference-if-able', mirror, '--dissociate'] : []),
        entry.url,
        dir,
      ]);
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    action = 'cloned';
  }

  // Before any checkout: nothing in the tree may convert, expand, or filter content.
  const guardChanged = await installAttributesGuard(dir);

  if (!(await hasCommit(git, dir, entry.sha))) {
    log(`${entry.name}: fetching pinned commit ${entry.sha}`);
    await git(['fetch', '--no-tags', 'origin', entry.sha], dir);
  }

  const head = await headOf(git, dir);
  const dirty = head === entry.sha ? await dirtyPaths(git, dir) : [];
  if (action === 'cloned' || guardChanged || head !== entry.sha || dirty.length > 0) {
    log(`${entry.name}: checking out ${entry.sha}`);
    await git(['checkout', '--detach', '--force', entry.sha], dir);
    await git(['clean', '-ffdx'], dir);
    if (action === 'reused') action = 'repinned';
  }

  await verifyPinned(entry, dir, git);
  return { dir, action };
}
