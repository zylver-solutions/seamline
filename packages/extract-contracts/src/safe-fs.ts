/**
 * Repo-root confinement and capped reads (design v3 §2.7).
 *
 * Every read this extractor performs goes through here. The module has two
 * jobs: keep resolution inside the repo root (a `$ref` that escapes the root,
 * or that names a URL, is an SSRF / arbitrary-file-read vector), and keep the
 * bytes bounded so a hostile document cannot exhaust memory.
 */

import { realpathSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, resolve, relative, dirname, sep } from 'node:path';

/** Why a path was refused. The string is stable and is asserted by tests. */
export const REFUSAL_REMOTE = 'REMOTE_REF_REFUSED';
export const REFUSAL_ESCAPE = 'REF_ESCAPES_REPO_ROOT';
export const REFUSAL_TOO_LARGE = 'FILE_TOO_LARGE';
export const REFUSAL_UNREADABLE = 'FILE_UNREADABLE';

export type PathResolution =
  | { readonly ok: true; readonly absolute: string; readonly relPosix: string }
  | { readonly ok: false; readonly refusal: string; readonly detail: string };

/**
 * True for anything that names a location this extractor must never fetch:
 * an absolute URL of any scheme, a protocol-relative `//host/x`, or a
 * Windows drive letter. Bare fragments and relative paths are not URIs.
 */
export function isRemoteReference(target: string): boolean {
  if (target.startsWith('//')) return true;
  // Scheme per RFC 3986, but a single leading letter followed by ':' is a
  // Windows drive, which is equally refused.
  return /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(target);
}

/** Convert an absolute path to a repo-relative POSIX path. Determinism gate. */
export function toRepoRelativePosix(repoRoot: string, absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join('/');
}

/**
 * Resolve `target` (a path relative to `fromFile`, or repo-relative when
 * `fromFile` is the root itself) and prove it stays inside `repoRoot`.
 *
 * Symlinks are resolved before the containment check, so a symlink pointing
 * out of the repo is refused rather than followed.
 */
export function resolveInsideRoot(
  repoRoot: string,
  fromFileAbs: string,
  target: string,
): PathResolution {
  if (isRemoteReference(target)) {
    return { ok: false, refusal: REFUSAL_REMOTE, detail: target };
  }
  const rootReal = realpathSync(repoRoot);
  const base = statSyncSafe(fromFileAbs)?.isDirectory() === true ? fromFileAbs : dirname(fromFileAbs);
  const candidate = isAbsolute(target) ? resolve(target) : resolve(base, target);

  // Containment is checked twice: once lexically (so a non-existent path is
  // still refused rather than throwing) and once on the realpath (so a
  // symlink cannot smuggle the read out of the tree).
  if (!isInside(rootReal, candidate)) {
    return { ok: false, refusal: REFUSAL_ESCAPE, detail: target };
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    real = candidate;
  }
  if (!isInside(rootReal, real)) {
    return { ok: false, refusal: REFUSAL_ESCAPE, detail: target };
  }
  return { ok: true, absolute: real, relPosix: toRepoRelativePosix(rootReal, real) };
}

function isInside(rootReal: string, candidate: string): boolean {
  if (candidate === rootReal) return true;
  const rel = relative(rootReal, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function statSyncSafe(p: string): import('node:fs').Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export type ReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly refusal: string; readonly detail: string };

/**
 * Read a UTF-8 file, refusing anything above `maxBytes`.
 *
 * Every caller already has, and reports, the repo-relative path of the file
 * being read (`toRepoRelativePosix` beside its own `readCapped` call), so
 * `detail` on failure must never repeat `absolute` itself: an ENOENT/EACCES
 * error's own `.message` embeds the absolute path too, and both are exactly
 * the H13 leak class ADR-0009 forbids (a maintainer's local path baked into
 * committed output). `detail` reports the error `code` instead, which is
 * both path-free and, unlike `.message` wording, stable across platforms.
 */
export function readCapped(absolute: string, maxBytes: number): ReadResult {
  const st = statSyncSafe(absolute);
  if (st === null || !st.isFile()) {
    return { ok: false, refusal: REFUSAL_UNREADABLE, detail: 'not found' };
  }
  if (st.size > maxBytes) {
    return { ok: false, refusal: REFUSAL_TOO_LARGE, detail: `${st.size} > ${maxBytes}` };
  }
  try {
    return { ok: true, text: readFileSync(absolute, 'utf8') };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
    return { ok: false, refusal: REFUSAL_UNREADABLE, detail: code };
  }
}

const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.next', '.turbo', '.cache', 'vendor', '.venv', '__pycache__',
  // The evaluation harness's fetched third-party clones and its run output.
  '.eval-cache', 'eval-out',
]);

/**
 * Depth-first walk of the repo, returning repo-relative POSIX paths sorted
 * lexicographically. Sorting here is what makes discovery order independent
 * of filesystem readdir order (determinism gate, v3 §2.3).
 */
export function walkRepo(repoRoot: string, maxFiles: number): string[] {
  const rootReal = realpathSync(repoRoot);
  const found: string[] = [];
  const stack: string[] = [rootReal];
  while (stack.length > 0 && found.length < maxFiles) {
    const dir = stack.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        if (found.length >= maxFiles) break;
        found.push(toRepoRelativePosix(rootReal, abs));
      }
    }
  }
  found.sort();
  return found;
}
