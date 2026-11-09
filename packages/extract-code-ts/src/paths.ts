/**
 * Path normalization.
 *
 * Design v3 §2.3: repo-relative POSIX paths only, never absolute, never a
 * backslash. Every path that reaches a node or an edge goes through here, so
 * the determinism gate has exactly one place to fail.
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';

/** True when `p` is repo-relative POSIX: no drive letter, no leading `/`, no `\`. */
export function isRepoRelativePosix(p: string): boolean {
  if (p.length === 0) return false;
  if (p.includes('\\')) return false;
  if (p.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').includes('..');
}

/**
 * Convert an absolute filesystem path to a repo-relative POSIX path.
 *
 * Returns `null` when the path is outside the repo root — callers treat that as
 * "not ours" rather than emitting an out-of-repo node, which is how
 * `node_modules` and ambient lib files are excluded.
 */
export function toRepoRelative(repoRoot: string, absolutePath: string): string | null {
  const rel = nodePath.relative(nodePath.resolve(repoRoot), nodePath.resolve(absolutePath));
  if (rel.length === 0) return null;
  const posix = rel.split(nodePath.sep).join('/');
  if (posix.startsWith('../') || posix === '..') return null;
  if (nodePath.isAbsolute(rel)) return null;
  return posix;
}

/** What stands in for an absolute path that is not inside the repository. */
export const OUTSIDE_REPOSITORY = '<outside the repository>';

/** A quoted absolute path (spaces allowed inside the quotes), or an unquoted one that ends at whitespace. */
const ABSOLUTE_PATH_IN_TEXT =
  /(?<![\w./\\-])(?:(['"`])((?:\/|[A-Za-z]:[\\/])[^'"`\r\n]*)\1|(?:\/|[A-Za-z]:[\\/])[^\s'"`<>|]*)/g;

/** Stands in for the repository root while the rest of a path is read; cannot occur in a message. */
const ROOT_MARK = '\u0001';

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

/** The ways the repository root can be spelled in a message: native and POSIX, as given and with symlinks resolved. */
function spellingsOfRoot(repoRoot: string): {
  readonly forms: readonly string[];
  readonly windows: boolean;
} {
  // A drive-qualified root is not a path of a POSIX host: `resolve` would read it as relative to the working directory.
  const windows = nodePath.win32.isAbsolute(repoRoot) && !nodePath.posix.isAbsolute(repoRoot);
  const normalize = (p: string): string =>
    windows ? nodePath.win32.normalize(p) : nodePath.resolve(p);
  const roots = [normalize(repoRoot)];
  if (!windows) {
    try {
      roots.push(fs.realpathSync(roots[0] as string));
    } catch {
      // A root that cannot be resolved is spelled only as it was given.
    }
  }
  const forms = new Set<string>();
  for (const root of roots) {
    const bare = root.length > 1 ? root.replace(/[\\/]+$/, '') : root;
    forms.add(bare);
    forms.add(bare.split('\\').join('/'));
  }
  return {
    forms: [...forms].filter((f) => f.length > 1).sort((a, b) => b.length - a.length),
    windows,
  };
}

/**
 * The repository root, by exact string, in every spelling, replaced by
 * `ROOT_MARK`. It is matched as a whole name: not inside a longer path
 * (`/other/work/repo`) and not as the start of a sibling (`/work/repo-two`,
 * `/work/repo two`). A match must be followed by a separator, the end, a quote,
 * a bracket or sentence punctuation. Whitespace after it also counts, but only
 * for a root that holds whitespace itself (a home directory such as `John
 * Smith`): no pattern can find such a root, so a bare mention of it is taken as
 * the root rather than left as a fragment of the checkout path. For a root
 * without whitespace the shape rule below finds a bare mention anyway, so
 * whitespace after it does not make the sibling `/work/repo two` the root.
 *
 * A quoted absolute path is one token: it is the root only when the quoted text
 * begins with the root as a whole name, so `'/work/repo two/x.json'` is a path
 * outside the repository, not the root followed by words.
 *
 * Done before anything is guessed from the shape of a path, because a root with
 * a space in it has no shape a pattern can follow.
 */
function markRoot(repoRoot: string, text: string): string {
  const { forms, windows } = spellingsOfRoot(repoRoot);
  if (forms.length === 0) return text;
  const alternatives = forms.map(escapeRegExp).join('|');
  const spaced = forms.some((form) => /\s/.test(form));
  const follow = `(?=$|[\\\\/\\r\\n'"\`<>|)\\]${spaced ? '\\s' : ''}]|[.,;:](?=$|[\\s'"\`]))`;
  const bare = `(?<![\\w./\\\\-])(?:${alternatives})${follow}`;
  const quoted = `(['"\`])((?:\\/|[A-Za-z]:[\\\\/])[^'"\`\\r\\n]*)\\1`;
  const rootOfQuoted = new RegExp(`^(?:${alternatives})(?=$|[\\\\/])`, windows ? 'i' : '');
  return text.replace(
    new RegExp(`${quoted}|${bare}`, windows ? 'gi' : 'g'),
    (match, quote: string | undefined, body: string | undefined) => {
      if (quote === undefined || body === undefined) return ROOT_MARK;
      const root = rootOfQuoted.exec(body);
      // Not under the root: left for the shape rule, which makes the whole token outside.
      return root === null ? match : `${quote}${ROOT_MARK}${body.slice(root[0].length)}${quote}`;
    },
  );
}

/** What follows `ROOT_MARK` (a separator and the rest of the path, or nothing) as a repo-relative POSIX path, or `null` when it leaves the repository. */
function relativeAfterRoot(rest: string): string | null {
  const below = rest.split('\\').join('/').replace(/^\/+/, '');
  const posix = nodePath.posix.normalize(below.length === 0 ? '.' : below).replace(/\/+$/, '');
  if (posix === '..' || posix.startsWith('../')) return null;
  return posix.length === 0 ? '.' : posix;
}

/**
 * `text` with every absolute path in it made reproducible: a path inside the
 * repository becomes repo-relative POSIX, any other absolute path becomes
 * `OUTSIDE_REPOSITORY`. Messages that come from TypeScript or ts-morph name
 * files by absolute path, and a diagnostic is persisted and compared byte for
 * byte, so no absolute path may reach one (design v3 §2.3).
 *
 * The known root is replaced first, by exact string, so a checkout path that
 * holds whitespace leaves no fragment behind and a path inside the repository is
 * never reported as outside it. Only then are the remaining absolute paths found
 * by their shape: a quoted one is taken whole, an unquoted one ends at
 * whitespace.
 */
export function redactPaths(repoRoot: string, text: string): string {
  const marked = markRoot(repoRoot, text).replace(
    new RegExp(`${ROOT_MARK}([\\\\/][^\\s'"\`<>|]*)?`, 'g'),
    (_match, rest: string | undefined) => {
      if (rest === undefined) return '.';
      // Sentence punctuation after a path ("... not found.") is not part of it.
      const trailing = /[.,;:)\]]+$/.exec(rest)?.[0] ?? '';
      const kept = trailing.length > 0 ? rest.slice(0, -trailing.length) : rest;
      const rel = relativeAfterRoot(kept);
      return (rel === null ? OUTSIDE_REPOSITORY : rel) + trailing;
    },
  );
  return marked.replace(
    ABSOLUTE_PATH_IN_TEXT,
    (match, quote: string | undefined, quoted: string | undefined) => {
      const body = quoted ?? match;
      // Sentence punctuation after a path ("... not found.") is not part of it.
      const trailing = quoted === undefined ? (/[.,;:)\]]+$/.exec(body)?.[0] ?? '') : '';
      const candidate = trailing.length > 0 ? body.slice(0, -trailing.length) : body;
      if (candidate.length <= 1) return match;
      const replaced = replacementFor(repoRoot, candidate) + trailing;
      return quote === undefined ? replaced : `${quote}${replaced}${quote}`;
    },
  );
}

/** The stand-in for one absolute path that is not spelled with the root as given. */
function replacementFor(repoRoot: string, candidate: string): string {
  // A drive-qualified path on a POSIX host is not a path of this machine, and `resolve` would read it as relative to the working directory.
  if (!nodePath.isAbsolute(candidate)) return OUTSIDE_REPOSITORY;
  const rel = toRepoRelative(repoRoot, candidate);
  if (rel !== null) return rel;
  return nodePath.resolve(repoRoot) === nodePath.resolve(candidate) ? '.' : OUTSIDE_REPOSITORY;
}

/** Repo-relative POSIX directory of a repo-relative POSIX file path. `''` at the root. */
export function dirnamePosix(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

/** `path:line` source reference. Never absolute; `line` is 1-based. */
export function sourceRef(relPath: string, line: number): string {
  return `${relPath}:${line}`;
}

/** Join two POSIX route/path fragments with exactly one separator. */
export function joinPosix(a: string, b: string): string {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
}
