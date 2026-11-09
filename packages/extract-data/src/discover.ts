/**
 * Static source discovery.
 *
 * Design v3 §6 is explicit that v0.1 reads **static files only** — no live
 * database introspection. That is not a scope compromise: introspection needs
 * a credential path that does not exist yet, and the security lens flagged it.
 * Nothing in this package opens a socket, and the extractor manifest declares
 * `net: false` so the host enforces it (v3 §2.7).
 *
 * Traversal is sorted at every level, so discovery order is a function of the
 * tree's contents rather than of the filesystem's readdir order (v3 §2.3).
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { tokenizeTs } from './ts-lex.ts';
import type { Tok } from '@seamline/core/sql';
import { migrationOrder, type MigrationOrder } from './migration-order.ts';

/**
 * Directories the walk does not read, by name at any depth.
 *
 * Skipping a directory does not make what is in it absent. Two groups: the
 * dependency and tool directories (`node_modules`, `.git`, caches, virtual
 * environments, coverage output) hold third-party or generated state, and
 * nothing in them is looked at. The output and vendor directories (`OUTPUT_DIRS`)
 * are where a team keeps built or vendored copies of its own files, so they are
 * listed, without being read, for schema files: each one found is recorded in
 * `Discovery.unread`.
 */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
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
 * The default skip directories that are listed for schema files rather than
 * left alone: build output and vendored code. A schema file in one of them is
 * `unread`, not absent. Naming one in `DiscoverOptions.skipDirs` opts it out,
 * which is the way to say "this is third-party, ignore it".
 */
const OUTPUT_DIRS: ReadonlySet<string> = new Set([
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  'build',
  'dist',
  'out',
  'target',
  'vendor',
]);

/**
 * Extensions of files that declare a schema but that no reader here parses:
 * SQL dialect scripts (`.ddl`, `.psql`, `.pgsql`, `.mysql`, `.tsql`, `.plsql`),
 * CQL and HQL schema files (`.cql`, `.hql`) and DBML (`.dbml`). Plain `.sql` is
 * parsed, and binary database files (`.db`, `.sqlite`, `.sqlite3`) are not
 * declarations: reading one is introspection, which this extractor does not do.
 * Such a file is recorded as unread and never opened.
 */
const UNPARSED_SCHEMA_EXTENSIONS: readonly string[] = [
  '.cql',
  '.ddl',
  '.dbml',
  '.hql',
  '.mysql',
  '.pgsql',
  '.plsql',
  '.psql',
  '.tsql',
];

/** Path segments that mark a `.sql` file as an ordered migration. */
const MIGRATION_DIRS: readonly string[] = ['migrations', 'migration', 'migrate', '_migrations', 'drizzle'];

/** Modules opened to look for Drizzle table declarations. `.d.ts` is skipped. */
export const TS_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Text every Drizzle schema module contains, used as a cheap content filter. */
const DRIZZLE_MARKERS: readonly string[] = ['pgTable(', 'pgSchema(', 'pgEnum('];

/**
 * Drizzle table constructors and schema builders that declare tables and that
 * the Drizzle reader does not parse: every dialect but PostgreSQL, and the
 * `*TableCreator` factories (create-t3-app's `pgTableCreator` among them). A
 * module that names one is a schema source this extractor does not read.
 */
const UNPARSED_DRIZZLE_NAMES: ReadonlySet<string> = new Set([
  'mysqlSchema',
  'mysqlTable',
  'mysqlTableCreator',
  'pgTableCreator',
  'singlestoreSchema',
  'singlestoreTable',
  'singlestoreTableCreator',
  'sqliteTable',
  'sqliteTableCreator',
]);

/**
 * The names the Drizzle reader recognises by spelling. Importing or
 * destructuring one under another name (`import { pgTable as table }`) hides it
 * from the reader, so a rename of any of these, or of an unparsed one, marks
 * the module.
 */
const RENAMEABLE_DRIZZLE_NAMES: ReadonlySet<string> = new Set([
  ...UNPARSED_DRIZZLE_NAMES,
  'pgEnum',
  'pgSchema',
  'pgTable',
]);

/**
 * True when the module declares tables through Drizzle in a form the Drizzle
 * reader does not parse: it names an unparsed constructor, or renames a
 * recognised one in an import, a re-export or a destructuring, in a module that
 * mentions `drizzle-orm`. Lexical, over the token stream, so a name only in a
 * comment, string or string-valued object label does not count. A constructor
 * reached by another route (assigned to another binding, passed as an argument)
 * is not seen.
 */
function usesUnparsedDrizzle(text: string): boolean {
  const mentioned = [...RENAMEABLE_DRIZZLE_NAMES].some((name) => text.includes(name));
  if (!mentioned) return false;
  let drizzleModule = false;
  let renamed = false;
  let unparsed = false;
  const visit = (list: readonly Tok[]): void => {
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i] as Tok;
      if (t.t === 'group') {
        visit(t.items);
        continue;
      }
      if (t.t === 'str' && /^drizzle-orm(?:\/|$)/u.test(t.v)) drizzleModule = true;
      if (t.t !== 'word') continue;
      const next = list[i + 1];
      const after = list[i + 2];
      // A string-valued object label holds fixture text, not a constructor or binding.
      if (next?.t === 'punct' && next.v === ':' && after?.t === 'str') continue;
      if (UNPARSED_DRIZZLE_NAMES.has(t.v)) unparsed = true;
      if (!RENAMEABLE_DRIZZLE_NAMES.has(t.v)) continue;
      const asRename =
        next?.t === 'word' && next.v === 'as' && after?.t === 'word' && after.v !== t.v;
      const colonRename = next?.t === 'punct' && next.v === ':';
      if (asRename || colonRename) renamed = true;
    }
  };
  visit(tokenizeTs(text).toks);
  return unparsed || (renamed && drizzleModule);
}

/** Config files that can name a Prisma schema: `prisma.config.ts` and its module variants. */
const PRISMA_CONFIG = /^prisma\.config\.(?:ts|mts|cts|js|mjs|cjs)$/u;

/**
 * The `schema` entries of a `prisma.config.*` module, as strings where the value is
 * a string literal or a `join`/`resolve` of string literals, and `null` where it is
 * anything else (an environment variable, a computed path). Lexical.
 */
function prismaConfigPointers(text: string): Array<string | null> {
  const found: Array<string | null> = [];
  const literal = (toks: readonly Tok[]): string | null => {
    const first = toks[0];
    if (first === undefined || first.t !== 'str' || first.v.includes('${')) return null;
    // `'prisma/schema.prisma' as const` is still the literal.
    if (toks.length === 1 || (toks[1]?.t === 'word' && toks[1].v === 'as')) return first.v;
    return null;
  };
  const joined = (toks: readonly Tok[]): string | null => {
    // `join(...)` or `<ident>.join(...)`, also `resolve`, with only string literals as arguments.
    const callee = toks[toks.length - 2];
    const args = toks[toks.length - 1];
    if (toks.length < 2 || callee?.t !== 'word' || args?.t !== 'group' || args.v !== '(')
      return null;
    if (callee.v !== 'join' && callee.v !== 'resolve') return null;
    for (let i = 0; i < toks.length - 2; i += 2) {
      const owner = toks[i];
      const dot = toks[i + 1];
      if (owner?.t !== 'word' || dot?.t !== 'punct' || dot.v !== '.') return null;
    }
    const parts: string[] = [];
    let expectValue = true;
    for (const tok of args.items) {
      if (expectValue) {
        if (tok.t !== 'str' || tok.v.includes('${')) return null;
        parts.push(tok.v);
      } else if (tok.t !== 'punct' || tok.v !== ',') {
        return null;
      }
      expectValue = !expectValue;
    }
    return parts.length === 0 ? null : posix.join(...parts);
  };
  const visit = (list: readonly Tok[]): void => {
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i] as Tok;
      if (t.t === 'group') {
        visit(t.items);
        continue;
      }
      const colon = list[i + 1];
      if (t.t !== 'word' || t.v !== 'schema' || colon?.t !== 'punct' || colon.v !== ':') continue;
      let end = i + 2;
      while (end < list.length && !(list[end]?.t === 'punct' && list[end]?.v === ',')) end += 1;
      const value = list.slice(i + 2, end);
      found.push(literal(value) ?? joined(value));
    }
  };
  visit(tokenizeTs(text).toks);
  return found;
}

/** The `prisma.schema` string of a `package.json`, or `undefined` when it names none. */
function packageJsonPointer(text: string): string | undefined {
  if (!text.includes('"prisma"')) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const prisma = (parsed as Record<string, unknown>)['prisma'];
    if (typeof prisma !== 'object' || prisma === null) return undefined;
    const schema = (prisma as Record<string, unknown>)['schema'];
    return typeof schema === 'string' && schema.length > 0 ? schema : undefined;
  } catch {
    return undefined;
  }
}

/** A Prisma schema location named by a package or a config file. */
interface PrismaPointer {
  /** Repo-relative path of the file that holds the pointer. */
  readonly from: string;
  /** The pointer as written, or `null` where it is not a string literal. */
  readonly value: string | null;
}

/**
 * Where a pointer lands: a repo-relative path inside the root, `outside` when it
 * leaves the root (or is an absolute path elsewhere), `unresolved` when the
 * config does not say with a literal.
 */
function pointerTarget(root: string, pointer: PrismaPointer): string | 'outside' | 'unresolved' {
  if (pointer.value === null) return 'unresolved';
  const written = pointer.value.split('\\').join('/');
  let target: string;
  if (isAbsolute(pointer.value) || written.startsWith('/')) {
    target = toPosix(relative(root, pointer.value));
  } else {
    target = posix.normalize(posix.join(dirname(pointer.from), written));
  }
  if (target === '..' || target.startsWith('../') || isAbsolute(target)) return 'outside';
  const trimmed = target.replace(/\/+$/u, '');
  return trimmed === '' ? '.' : trimmed;
}

export type SourceFileKind = 'sql' | 'sql-migration' | 'drizzle' | 'prisma';

export interface DiscoveredFile {
  /** Repo-relative POSIX path. */
  readonly path: string;
  readonly absolute: string;
  readonly kind: SourceFileKind;
  readonly text: string;
  /** Migration version, for `sql-migration` only. Not a path, but taken from a file or directory name, so renaming either changes the `Migration` id (ADR-0016). */
  readonly version: string | null;
  /** Directory group a migration belongs to: its apply order and, on a version collision, its qualifier (ADR-0016). */
  readonly group: string;
}

/**
 * Why a candidate was not read, as `DiscoverOptions.onSkip` reports it.
 * `unreadable-directory` is a directory whose listing failed, so any schema
 * source in it is unknown; `symlink` is a symbolic link to a `.sql`, `.prisma`
 * or TypeScript/JavaScript file that is not read at its own path;
 * `symlinked-directory` is a symbolic link to a directory (or one that cannot be
 * resolved) whose content is not read anywhere else in the walk.
 */
export type SkipReason =
  | 'too-large'
  | 'unreadable'
  | 'unreadable-directory'
  | 'symlink'
  | 'symlinked-directory';

export interface DiscoverOptions {
  readonly root: string;
  readonly skipDirs?: readonly string[];
  readonly maxFileBytes?: number;
  /**
   * Called, with its repo-relative POSIX path (`.` for the root), for each
   * candidate that `Discovery.unread` records because it could not be read at the
   * walk or read step: a `.sql` or `.prisma` file (or `package.json`) that was too
   * large or failed to read, a symbolic link to such a file, a directory that
   * could not be listed, and a symbolic link to a directory that is not read at
   * its own path. Every TypeScript or JavaScript source file over the size cap,
   * unreadable, or named by a symbolic link is reported as a possible Drizzle
   * schema. Candidate aliases stay unread even when their target is separately
   * read, protecting facts previously owned by the alias's path.
   * Every path reported here is also in `Discovery.unread`; the callback
   * adds the reason, which the list does not carry.
   */
  readonly onSkip?: (path: string, reason: SkipReason) => void;
}

function toPosix(p: string): string {
  return p.split(sep).join('/').split('\\').join('/');
}

/** Where the walk is, what it skips, and what it has found so far. */
interface WalkState {
  readonly root: string;
  /** `root` with symbolic links resolved, to tell whether a link target is inside it. */
  readonly realRoot: string;
  readonly onSkip: DiscoverOptions['onSkip'];
  /** Directory names not read: the defaults and the caller's `skipDirs`. */
  readonly skip: ReadonlySet<string>;
  /** The skipped names that are listed for schema files anyway. */
  readonly listed: ReadonlySet<string>;
  /** Absolute paths of the ordinary files found. */
  readonly files: string[];
  /** Repo-relative paths of what exists and was not read. */
  readonly unread: string[];
}

function repoPath(root: string, abs: string): string {
  return toPosix(relative(root, abs)) || '.';
}

/** True for a file name discovery opens: SQL, Prisma, a TypeScript or JavaScript module, `package.json`. */
function isCandidateName(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return (
    ext === '.sql' ||
    ext === '.prisma' ||
    UNPARSED_SCHEMA_EXTENSIONS.includes(ext) ||
    (TS_EXTENSIONS.includes(ext) && !name.endsWith('.d.ts')) ||
    name === 'package.json'
  );
}

/** True for a file name that is a schema in itself, whatever the readers do with it. */
function isSchemaName(name: string): boolean {
  const ext = extname(name).toLowerCase();
  return ext === '.sql' || ext === '.prisma' || UNPARSED_SCHEMA_EXTENSIONS.includes(ext);
}

/** Records something discovery knows is, or may be, a schema source and did not read. */
function noteUnread(st: WalkState, rel: string, reason: SkipReason): void {
  st.unread.push(rel);
  st.onSkip?.(rel, reason);
}

/** Where a symbolic link leads, as far as discovery can tell without leaving `root`. */
interface LinkTarget {
  /** `unresolved` when the link dangles, loops or cannot be resolved. */
  readonly kind: 'directory' | 'file' | 'other' | 'unresolved';
  /** The error code of a link that could not be resolved. */
  readonly code?: string | undefined;
  /** The walk reaches the target at its real path; candidate file aliases are still unread. */
  readonly readAtOwnPath: boolean;
}

async function resolveLink(st: WalkState, link: string): Promise<LinkTarget> {
  let target: string;
  let info;
  try {
    target = await realpath(link);
    info = await stat(target);
  } catch (err) {
    return { kind: 'unresolved', code: (err as NodeJS.ErrnoException).code, readAtOwnPath: false };
  }
  const rel = relative(st.realRoot, target);
  const inside = rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  const skipped = rel.split(sep).some((segment) => st.skip.has(segment));
  return {
    kind: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
    readAtOwnPath: inside && !skipped,
  };
}

/**
 * Candidate file links are always unread, even when their target is separately
 * read: the alias may own facts from a previous run, and a capped or unreadable
 * target must not authorize sweeping those facts under the alias's old path.
 * A link to a directory is ignored only when the walk reaches that directory at
 * its own path. No link is followed to read schema contents.
 */
async function noteLink(st: WalkState, abs: string, name: string): Promise<void> {
  const rel = repoPath(st.root, abs);
  const target = await resolveLink(st, abs);
  if (isCandidateName(name)) {
    noteUnread(st, rel, target.kind === 'directory' ? 'symlinked-directory' : 'symlink');
    return;
  }
  if (target.readAtOwnPath) return;
  if (target.kind === 'directory') {
    noteUnread(st, rel, 'symlinked-directory');
  } else if (target.kind === 'unresolved') {
    // A link whose target is missing is not a directory; one that could not be resolved for
    // any other reason (a loop, no permission) might be.
    if (target.code !== 'ENOENT' && target.code !== 'ENOTDIR') noteUnread(st, rel, 'symlinked-directory');
  }
}

/**
 * Lists a skipped output or vendor directory for schema files, without reading any of them.
 * Dependency directories and names the caller skipped are still not entered.
 */
async function listSchemaFiles(st: WalkState, dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    noteUnread(st, repoPath(st.root, dir), 'unreadable-directory');
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (st.skip.has(e.name) && !st.listed.has(e.name)) continue;
      await listSchemaFiles(st, abs);
    } else if ((e.isFile() || e.isSymbolicLink()) && isSchemaName(e.name)) {
      // Listed, not read: not a failure of any read, so no reason to report (it is in `unread`).
      st.unread.push(repoPath(st.root, abs));
    }
  }
}

async function walk(st: WalkState, dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A directory that cannot be listed may hold a schema source; discovery records it
    // rather than reading its silence as "nothing there".
    noteUnread(st, repoPath(st.root, dir), 'unreadable-directory');
    return;
  }
  // Sorted so traversal order is content-determined, not filesystem-determined.
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of sorted) {
    const skipped = st.skip.has(e.name);
    const abs = join(dir, e.name);
    if (e.isSymbolicLink()) {
      if (!skipped) await noteLink(st, abs, e.name);
      continue;
    }
    if (e.isDirectory()) {
      if (!skipped) await walk(st, abs);
      else if (st.listed.has(e.name)) await listSchemaFiles(st, abs);
      continue;
    }
    if (e.isFile()) st.files.push(abs);
  }
}

/** Splits a repo-relative path into its segments. */
function segments(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

interface MigrationIdentity {
  readonly version: string;
  readonly group: string;
}

/**
 * Derives a migration's ordering identity from its location.
 *
 * Prisma writes `prisma/migrations/20240101120000_init/migration.sql`, where
 * the directory carries the version; Drizzle and Flyway write
 * `drizzle/0001_init.sql`, where the file does.
 */
export function migrationIdentity(relPath: string): MigrationIdentity | null {
  const segs = segments(relPath);
  let groupIdx = -1;
  for (let i = segs.length - 2; i >= 0; i -= 1) {
    if (MIGRATION_DIRS.includes((segs[i] as string).toLowerCase())) {
      groupIdx = i;
      break;
    }
  }
  if (groupIdx < 0) return null;
  const group = segs.slice(0, groupIdx + 1).join('/');
  const file = basename(relPath, extname(relPath));
  const parent = segs[segs.length - 2];
  if (file === 'migration' && parent !== undefined && groupIdx < segs.length - 2) {
    return { version: parent, group };
  }
  return { version: file, group };
}

/** Leading integer of a migration version, for numeric rather than lexical order. */
export function versionOrdinalKey(version: string): number {
  const m = /^[Vv]?(\d+)/u.exec(version);
  if (m === null) return Number.MAX_SAFE_INTEGER;
  const n = Number.parseInt(m[1] as string, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * What discovery found, and what it knows exists and did not read.
 *
 * `unread` is the repo-relative POSIX paths, sorted and without repeats, of what
 * discovery knows is, or may be, a schema source that is not among `files`:
 *
 * - a directory that could not be listed, or a file that could be a schema source
 *   (`.sql`, `.prisma`, a TypeScript or JavaScript module, a `package.json`) that
 *   was over the size limit or failed `stat` or `readFile`. A TypeScript module
 *   that cannot be opened counts because only its text says whether it declares
 *   Drizzle tables;
 * - a symbolic link that is a directory or is named like a candidate file (links
 *   are not followed);
 * - a file whose extension names a schema that no reader parses (`.ddl`, `.psql`,
 *   `.pgsql`, `.mysql`, `.tsql`, `.plsql`, `.cql`, `.hql`, `.dbml`);
 * - a TypeScript or JavaScript module that declares Drizzle tables through a
 *   constructor the Drizzle reader does not parse (`sqliteTable`, `mysqlTable`,
 *   `pgTableCreator`, a renamed `pgTable`, and the others). Such a module that
 *   also holds parsed tables is in `files` as well;
 * - a Prisma schema that a `package.json` (`prisma.schema`) or a `prisma.config.*`
 *   (`schema`) names and that is not among the files read: a missing file, a name
 *   that is not `.prisma`, a path in a skipped directory, an empty directory. A
 *   pointer that leaves the repository is recorded as the file that holds it, and
 *   so is a `prisma.config.*` pointer that is not a string literal when nothing at
 *   all was read;
 * - a `.sql`, `.prisma` or unparsed-extension file under a build output or vendor
 *   directory (`OUTPUT_DIRS`), which the walk lists but does not read.
 *
 * Not on the list, because discovery does not look for them: other ORMs and
 * query builders, database files, a schema that exists only in a running
 * database, a schema reachable only through a `prisma --schema` script flag, and
 * anything under a dependency directory or a name in `skipDirs`.
 */
export interface Discovery {
  readonly files: DiscoveredFile[];
  readonly unread: string[];
  readonly migrationOrders: readonly MigrationOrder[];
}

/**
 * Finds every static schema source under `root`, and reports what it knows is
 * there and did not read. `files` is empty and `unread` is empty only when
 * discovery found no schema source in any form it reads or recognises: that is a
 * statement about discovery, not about the repository, and a different one from
 * "nothing could be read", which is why the two are returned apart.
 *
 * The files are ordered by application authority: Prisma, then Drizzle, then
 * standalone SQL, then migrations in migration order. Applying them in that
 * order is what makes the last write the final state.
 * Within a kind the order is read from paths (sorted path for standalone SQL;
 * directory, then version, for migrations), so renaming a file or directory so
 * that it sorts differently can change the names a table or column ends with
 * when two sources do not commute (ADR-0016 item 4).
 */
export async function discoverSources(opts: DiscoverOptions): Promise<Discovery> {
  const callerSkips = opts.skipDirs ?? [];
  const skip = new Set([...DEFAULT_SKIP_DIRS, ...callerSkips]);
  // An output directory the caller names itself is the caller's choice, as any other name is.
  const listed = new Set([...OUTPUT_DIRS].filter((d) => !callerSkips.includes(d)));
  const maxBytes = opts.maxFileBytes ?? 4 * 1024 * 1024;
  const realRoot = await realpath(opts.root).catch(() => resolve(opts.root));
  const walked: WalkState = {
    root: opts.root,
    realRoot,
    onSkip: opts.onSkip,
    skip,
    listed,
    files: [],
    unread: [],
  };
  await walk(walked, opts.root);
  const absPaths = walked.files;
  const unread = walked.unread;
  const pointers: PrismaPointer[] = [];

  const prisma: DiscoveredFile[] = [];
  const drizzle: DiscoveredFile[] = [];
  const sql: DiscoveredFile[] = [];
  const migrations: DiscoveredFile[] = [];

  for (const abs of absPaths.sort()) {
    const rel = toPosix(relative(opts.root, abs));
    const name = basename(abs);
    const ext = extname(abs).toLowerCase();
    if (UNPARSED_SCHEMA_EXTENSIONS.includes(ext)) {
      // A schema no reader here parses. It is never opened: only its existence matters.
      unread.push(rel);
      continue;
    }
    const isSql = ext === '.sql';
    const isPrisma = ext === '.prisma';
    const isTs = TS_EXTENSIONS.includes(ext) && !abs.endsWith('.d.ts');
    const isPackage = name === 'package.json';
    if (!isSql && !isPrisma && !isTs && !isPackage) continue;

    let size = 0;
    try {
      size = (await stat(abs)).size;
    } catch {
      noteUnread(walked, rel, 'unreadable');
      continue;
    }
    if (size > maxBytes) {
      // A bounded prefix cannot prove that a schema declaration does not follow it.
      noteUnread(walked, rel, 'too-large');
      continue;
    }

    let text: string;
    try {
      if (isSql && migrationIdentity(rel) !== null) {
        // A lossy decode could turn invalid source bytes into valid SQL and
        // certify a history that was never read as declared. Keep the BOM
        // visible to the source-coverage check, as readFile(..., 'utf8') does.
        const bytes = await readFile(abs);
        if (bytes.length > maxBytes) { noteUnread(walked, rel, 'too-large'); continue; }
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } else text = await readFile(abs, 'utf8');
    } catch {
      noteUnread(walked, rel, 'unreadable');
      continue;
    }

    if (isPackage) {
      const value = packageJsonPointer(text);
      if (value !== undefined) pointers.push({ from: rel, value });
      continue;
    }
    if (isPrisma) {
      prisma.push({ path: rel, absolute: abs, kind: 'prisma', text, version: null, group: '' });
      continue;
    }
    if (isTs) {
      if (PRISMA_CONFIG.test(name)) {
        for (const value of prismaConfigPointers(text)) pointers.push({ from: rel, value });
      }
      // A constructor the Drizzle reader does not parse declares tables it will not see, whether
      // or not the same module also holds tables it does.
      // Lexical tokens distinguish declarations from quoted samples, including in test files.
      if (usesUnparsedDrizzle(text)) unread.push(rel);
      if (!DRIZZLE_MARKERS.some((m) => text.includes(m))) continue;
      drizzle.push({ path: rel, absolute: abs, kind: 'drizzle', text, version: null, group: '' });
      continue;
    }
    const mig = migrationIdentity(rel);
    if (mig === null) {
      sql.push({ path: rel, absolute: abs, kind: 'sql', text, version: null, group: '' });
    } else {
      migrations.push({
        path: rel,
        absolute: abs,
        kind: 'sql-migration',
        text,
        version: mig.version,
        group: mig.group,
      });
    }
  }

  const groups = new Map<string, DiscoveredFile[]>();
  for (const file of migrations) {
    const group = groups.get(file.group) ?? [];
    group.push(file); groups.set(file.group, group);
  }
  const orders: MigrationOrder[] = [];
  for (const [group, members] of groups) orders.push(await migrationOrder(opts.root, group, members, maxBytes));
  const byGroup = new Map(orders.map((order) => [order.group, order]));
  // Supported framework readers may skip files discovery otherwise recognizes
  // as SQL. They cannot contribute earlier declarations to this replay.
  const orderedMigrations = migrations.filter((file) => {
    const order = byGroup.get(file.group);
    return order?.state !== 'known' || order.accepted.has(file.path);
  });

  orderedMigrations.sort((a, b) => {
    if (a.group !== b.group) return a.group < b.group ? -1 : 1;
    if (byGroup.get(a.group)?.state === 'known') {
      return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
    }
    const oa = versionOrdinalKey(a.version ?? '');
    const ob = versionOrdinalKey(b.version ?? '');
    if (oa !== ob) return oa - ob;
    const va = a.version ?? '';
    const vb = b.version ?? '';
    return va < vb ? -1 : va > vb ? 1 : 0;
  });

  const files = [...prisma, ...drizzle, ...sql, ...orderedMigrations];

  // A Prisma schema a package or config names is a source whether or not discovery would have found
  // it by its extension; one that is not among the files read was not seen.
  const readPaths = prisma.map((f) => f.path);
  for (const pointer of pointers) {
    const target = pointerTarget(opts.root, pointer);
    if (target === 'outside') {
      unread.push(pointer.from);
    } else if (target === 'unresolved') {
      // Nothing says where it points; only when nothing at all was read is that worth recording.
      if (files.length === 0) unread.push(pointer.from);
    } else if (
      !readPaths.some((p) => target === '.' || p === target || p.startsWith(`${target}/`))
    ) {
      unread.push(target);
    }
  }

  return { files, unread: [...new Set(unread)].sort(), migrationOrders: orders };
}

/**
 * The schema sources under `root`, in application order. Files that could not be
 * read are left out; `discoverSources` says which.
 */
export async function discover(opts: DiscoverOptions): Promise<DiscoveredFile[]> {
  return (await discoverSources(opts)).files;
}
