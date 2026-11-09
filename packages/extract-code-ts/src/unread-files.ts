/**
 * Writers in files the run did not read.
 *
 * `extract-code-ts` reads the files its loaded tsconfig projects include (`coverage.ts`).
 * A TypeScript or JavaScript file in no loaded project is not read, and a write in it makes
 * no edge, so a detector that asks "does any write supply this column" would be answering
 * without it. This is part (b) of `unknownWriterTables` in
 * `docs/design/real-world-inputs.md`, section 5.2: such a file that contains a write marker
 * withholds every table whose name it uses as a whole word.
 *
 * The scan is lexical and says so. It reads the text, not the syntax, because the file is
 * outside every project and was never parsed. A table name in the text can be a comment or an
 * unrelated word, which withholds a table that nothing writes: the safe direction. A table
 * name computed at run time does not appear and is not found (design 9.4).
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { matchesReads } from '@seamline/core';
import type { OrmNames } from './data-model.ts';
import { manifest } from './manifest.ts';

/**
 * Directories that never hold first-party source, skipped wholesale. This is the list
 * `extract-data` skips (`DEFAULT_SKIP_DIRS` in its `discover.ts`); the two packages do not
 * depend on each other, and `packages/integration/src/unknown-writers.test.ts` fails if they
 * drift. Without the skip a vendored or compiled file would withhold nearly every table.
 */
export const UNREAD_SKIP_DIRS: readonly string[] = [
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.pnpm-store',
  '.svelte-kit',
  '.turbo',
  '.venv',
  '.yarn',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'venv',
  'vendor',
];

/**
 * The largest file the scan reads. A source file beyond this is generated or data, and reading
 * it whole would spike memory for a word list. It is not skipped: a file the scan cannot read
 * leaves `unknownWriterTables` unmeasured, the same as one that fails to open.
 */
export const UNREAD_MAX_BYTES = 4 * 1024 * 1024;

const SKIPPED: ReadonlySet<string> = new Set(UNREAD_SKIP_DIRS);
const MINIFIED = /\.min\.[cm]?js$/;

/** Whether the scan reads `rel` at all: not under a skipped directory, not a minified bundle. */
export function isScannedUnread(rel: string): boolean {
  if (MINIFIED.test(rel)) return false;
  return !rel.split('/').some((segment) => SKIPPED.has(segment));
}

/**
 * The write markers of the design: an `INSERT` statement, the Prisma insert-class operations
 * (`create`, `createMany`, `createManyAndReturn`, `upsert`), a query builder's `.insert(`, and
 * `$executeRaw`. Only inserts: a column can only be left unwritten by an insert (design 5.1).
 */
const WRITE_MARKER =
  /\binsert\b|\.\s*(?:create|createMany|createManyAndReturn|upsert|insert)\s*\(|\$executeRaw/i;

const WORD = /[\w$]+/g;
const PLAIN = /^[\w$]+$/;
const WORD_CHAR = /[\w$]/;

/** Whether `term` occurs in `text` with no word character against it on either side. */
function containsWord(text: string, term: string): boolean {
  for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
    const before = text[at - 1];
    const after = text[at + term.length];
    if (before !== undefined && WORD_CHAR.test(before) && WORD_CHAR.test(term[0] as string))
      continue;
    if (
      after !== undefined &&
      WORD_CHAR.test(after) &&
      WORD_CHAR.test(term[term.length - 1] as string)
    )
      continue;
    return true;
  }
  return false;
}

/** Whether `real` is `root` or below it; both are real paths. */
function isInside(root: string, real: string): boolean {
  const rel = nodePath.relative(root, real);
  return (
    rel === '' ||
    (!rel.startsWith('..' + nodePath.sep) && rel !== '..' && !nodePath.isAbsolute(rel))
  );
}

/**
 * The error code (`ENOENT`, `EACCES`), never the message: a Node message carries the absolute
 * path, and a diagnostic must not differ by checkout location.
 */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

export interface UnreadScan {
  /** Physical table name to the first unread file (smallest path) that withholds it. */
  readonly tables: ReadonlyMap<string, string>;
  /** Files read and found to hold a write marker. */
  readonly markedFiles: number;
  /** Why the scan could not be completed, or `null`. A scan that failed lists nothing it can vouch for. */
  readonly failure: string | null;
}

/**
 * Scans the files in `unread` (repo-relative, sorted) for a write marker and, in each file
 * that has one, for the names `names` gives the tables.
 *
 * Nothing outside `repoRoot` is read: a path whose real location (symbolic links resolved) is
 * outside it is not read, and, like a file over `maxBytes`, a dangling link or a file that
 * cannot be opened, it fails the scan: a file the run knows it did not read must not leave
 * `unknownWriterTables` looking measured. A path that is not a regular file (a directory, a
 * FIFO) holds no source text and is skipped without failing. Failure text carries the
 * repo-relative path and the error code, never an absolute path.
 * Both the requested name and the resolved target must match the manifest's read
 * declarations: an in-root source alias may still point to undeclared content.
 * `inspectText`, when supplied, sees only text that passed these same read bounds,
 * including files with no insert marker. It adds no graph coverage for the file.
 */
export function scanUnreadFiles(
  repoRoot: string,
  unread: readonly string[],
  names: OrmNames,
  maxBytes: number = UNREAD_MAX_BYTES,
  inspectText?: (rel: string, text: string) => void,
): UnreadScan {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(repoRoot);
  } catch (error) {
    return {
      tables: new Map(),
      markedFiles: 0,
      failure: `the repository root could not be resolved (${errorCode(error)})`,
    };
  }
  const tables = new Map<string, string>();
  let markedFiles = 0;
  // A name with a character outside `[\w$]` (a hyphen, a space) is not one token of the file.
  const oddExact = [...names.exact.keys()].filter((k) => !PLAIN.test(k));
  const oddFolded = [...names.folded.keys()].filter((k) => !PLAIN.test(k));
  for (const rel of unread) {
    if (!isScannedUnread(rel)) continue;
    let text: string;
    try {
      const full = nodePath.join(repoRoot, ...rel.split('/'));
      const real = fs.realpathSync(full);
      if (!isInside(realRoot, real)) {
        return {
          tables,
          markedFiles,
          failure: `${rel} resolves to a path outside the repository root and was not read`,
        };
      }
      const realRel = nodePath.relative(realRoot, real).split(nodePath.sep).join('/');
      if (!matchesReads(manifest, rel) || !matchesReads(manifest, realRel)) {
        return {
          tables,
          markedFiles,
          failure: `${rel} or its resolved target matches no declared reads glob and was not read`,
        };
      }
      const stat = fs.statSync(real);
      // A FIFO, a socket or a directory named like a source file holds no source text.
      if (!stat.isFile()) continue;
      if (stat.size > maxBytes) {
        return {
          tables,
          markedFiles,
          failure: `${rel} is ${stat.size} bytes, over the ${maxBytes} byte limit, and was not read`,
        };
      }
      text = fs.readFileSync(real, 'utf8');
    } catch (error) {
      return {
        tables,
        markedFiles,
        failure: `${rel} could not be read (${errorCode(error)})`,
      };
    }
    inspectText?.(rel, text);
    if (!WRITE_MARKER.test(text)) continue;
    markedFiles += 1;
    for (const term of oddExact) {
      if (containsWord(text, term))
        for (const t of names.exact.get(term) ?? []) if (!tables.has(t)) tables.set(t, rel);
    }
    const lowered = oddFolded.length > 0 ? text.toLowerCase() : '';
    for (const term of oddFolded) {
      if (containsWord(lowered, term))
        for (const t of names.folded.get(term) ?? []) if (!tables.has(t)) tables.set(t, rel);
    }
    for (const word of text.matchAll(WORD)) {
      const spelling = word[0];
      for (const table of names.exact.get(spelling) ?? [])
        if (!tables.has(table)) tables.set(table, rel);
      for (const table of names.folded.get(spelling.toLowerCase()) ?? []) {
        if (!tables.has(table)) tables.set(table, rel);
      }
    }
  }
  return { tables, markedFiles, failure: null };
}
