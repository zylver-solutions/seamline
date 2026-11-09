/**
 * `extract-data` — database schema facts from static files.
 *
 * Emits `DataSource`, `Schema`, `Table`, `Column` and `Migration` nodes with
 * `CONTAINS`, `MIGRATED_BY` and `FK_TO` edges, all at provenance `EXTRACTED`,
 * from SQL DDL, Drizzle schema modules, `schema.prisma`, and ordered migration
 * directories. Design v3 §6.
 */

import {
  assertWithinCeiling,
  type AuthoritativeScope,
  type ExtractorManifest,
  type ExtractorResult,
  type ExtractorStatus,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import { basename, extname } from 'node:path';
import { compileSelector } from '@seamline/core';
import {
  discoverSources,
  migrationIdentity,
  TS_EXTENSIONS,
  type DiscoveredFile,
} from './discover.ts';
import { applyDrizzleFile, createDrizzleRegistry, resolveDrizzleRefs } from './drizzle.ts';
import { applyPrismaFile } from './prisma.ts';
import { applySqlFile, type ApplySqlOptions } from './sql-ddl.ts';
import { emit } from './emit.ts';
import { assignMigrationNames, type MigrationSource } from './migration-ids.ts';
import { replayMigrations } from './migration-replay.ts';
import type { MigrationOrder } from './migration-order.ts';
import { SchemaModel, SOURCE_KINDS } from './model.ts';

export const EXTRACTOR_NAME = 'extract-data';
export const EXTRACTOR_VERSION = '0.0.1';

/**
 * The diagnostic when discovery found nothing and knew of nothing it did not read. It says
 * what was looked for, not what the repository declares: a repository can hold a schema in a
 * form this extractor does not look for.
 */
const NO_SCHEMA_SOURCE_FOUND =
  'no schema source found: none this extractor reads. It reads .sql and .prisma files and Drizzle ' +
  'pgTable, pgSchema and pgEnum modules, outside dependency directories and the directories named in ' +
  'skipDirs; it does not read other ORMs or query builders, database files, or a schema that exists ' +
  'only in a running database';

/** The scope this extractor is the authority for; drives tombstoning (v3 §2.2). */
export const DATA_SCOPE = 'data';

/**
 * Every file type discovery reads, at any depth: SQL and Prisma sources, and
 * each TS/JS module it opens to look for Drizzle table declarations. A data
 * node's path is the file that declared it, and every such file in the tree
 * is read again on every run, so a table whose file was deleted, or whose
 * declaration was removed from a file that still exists, is inside the sweep.
 * A per-run list of the Drizzle modules found would not do: a deleted module
 * is missing from it, so its tables would never be buried. Dropping the
 * selector would also sweep nodes that carry no path, which no file read
 * vouches for. Selector syntax: `@seamline/core`'s `scope-selector.ts`.
 */
const DATA_SELECTOR = `**/*.{${['.sql', '.prisma', ...TS_EXTENSIONS].map((ext) => ext.slice(1)).join(',')}}`;

/** Characters a selector pattern cannot write anywhere; see `scope-selector.ts` ("Syntax"). */
const UNWRITABLE = /[,{}*?\\\u0000-\u001f\u007f]/u;

/**
 * Whether one path segment can be written in a selector pattern. `first` and `last` say whether
 * it is at an end of the whole path, where whitespace is rejected. A leading `!` is fine: an
 * exclusion is `!` plus the pattern, so `!!a.sql` excludes the literal `!a.sql`.
 */
function writableSegment(segment: string, first: boolean, last: boolean): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false;
  if (UNWRITABLE.test(segment)) return false;
  return !((first && /^\s/u.test(segment)) || (last && /\s$/u.test(segment)));
}

/**
 * `?` stands in for each character a selector cannot write, and for whitespace at either end of
 * the path: it over-matches, never under-matches, so the claim only shrinks. The result is an
 * exact-depth pattern that always compiles, but it contains a wildcard, so `<it>/**` does not.
 */
function writable(path: string): string {
  const chars = [...path];
  const last = chars.length - 1;
  return chars
    .map((c, i) => (UNWRITABLE.test(c) || ((i === 0 || i === last) && /\s/u.test(c)) ? '?' : c))
    .join('');
}

const STEM_EXTENSIONS: readonly string[] = ['.sql', '.prisma', ...TS_EXTENSIONS];

/** The file name of a path without its last extension. */
function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * `**` + `/stem.ext` for each extension read, in the only forms the selector can evaluate after
 * `**`: a literal path, or `*suffix` when the stem holds a character a pattern cannot write
 * (the suffix after the last such character, which over-matches).
 */
function stemPatterns(path: string): string[] {
  const stem = stemOf(path);
  if (stem === '') return [];
  const bad = [...stem].map((c, i) => (UNWRITABLE.test(c) ? i : -1)).filter((i) => i >= 0);
  const head = bad.length === 0 ? '**/' : '**/*';
  const tail =
    bad.length === 0 ? stem : [...stem].slice((bad[bad.length - 1] as number) + 1).join('');
  return STEM_EXTENSIONS.map((ext) => `${head}${tail}${ext}`);
}

/**
 * The most exclusions a claim carries before it claims nothing instead. Each exclusion is a
 * clause the store tests against every candidate row in a sweep (and again for every edge), so
 * the cost is rows times clauses. Measured on a 3.6k-node graph, 50 unread paths (about 1,100
 * exclusions) added under a second to the store step of a run and 300 (about 6,000) took 12.6 s;
 * 1,000 keeps that step in the low seconds.
 */
export const MAX_EXCLUSIONS = 1_000;

/** Excludes everything: nothing is swept. The safe direction. */
const CLAIM_NOTHING = `${DATA_SELECTOR},!**`;

export interface DataClaim {
  readonly selector: string;
  /** Present when the claim is narrower than the unread paths alone require, and why. */
  readonly note?: string;
}

/**
 * The claim for a run that did not read every candidate (`Discovery.unread`).
 *
 * Tombstoning is confined to the selector, so a table whose source this run could not
 * see must lie outside it. The selector keeps the whole-tree form (a deleted file must
 * still be swept, so the files read cannot simply be listed) and subtracts the unread
 * paths with exclusions. Each is excluded as a file and as a directory (`p` and `p/**`),
 * since an entry is either: a symlink, an over-size file or a file in a skipped output
 * directory is a file; a directory that could not be listed is a directory; `.` (a
 * Prisma schema path that resolves to the root) excludes everything.
 *
 * A path with a character a pattern cannot write (`,` `{` `}` `*` `?`, a backslash, a control
 * character, whitespace at an end, an empty or dot segment) cannot be given the `p/**` form,
 * because a wildcard may not precede `**`. It is excluded instead as `p` with `?` for each such
 * character (exact depth, so it covers the entry if it is a file) and as `a/**`, where `a` is
 * its longest run of leading segments that can be written (its nearest nameable ancestor
 * directory; `!**` when there is none), so that if the entry is a directory what lies under it
 * is withheld too. That withholds more than the entry (everything under `a`), never less.
 *
 * A file that was moved or renamed out of the reader's sight (under an output directory, to
 * an extension it does not parse) leaves its old path empty, and the old path is where the
 * nodes it declared are recorded. That looks the same as a deletion, except that an unread
 * candidate with the same stem now exists elsewhere. So each unread entry also excludes
 * every path whose file name is its stem plus an extension this extractor reads
 * (`**` + `/b.sql` for `vendor/b.sql` or `db/b.ddl`). This over-protects (an unrelated
 * `b.sql` elsewhere is withheld from the sweep while any `b` is unread), never under-protects.
 * A stem whose last character is unwritable gives `**` + `/*.sql` and so on, which withholds
 * every file of that extension.
 *
 * More than `MAX_EXCLUSIONS` exclusions claim nothing for this run (`!**`) and say so in `note`.
 * If the selector fails to compile for any reason, so does the claim: nothing, never a throw
 * (the store refuses a selector it cannot compile, and that would lose the whole run).
 *
 * Which file owns a node: a node's `path` is the file of its LAST defining statement
 * (`CREATE TABLE`, `pgTable`, a Prisma `model`; see `SchemaModel.ensureTable`); an ALTER or
 * an index in another file does not move it. The selector matches that one path, so a
 * node is protected when its owning file is unread. A table created in a read file and
 * altered in an unread one is re-emitted from the read file and stays live; a column the
 * unread file added is owned by it and is protected. A table created in an unread file
 * and altered in a read one is emitted by the ALTER (path: the read file) and stays live
 * too. See docs/design/real-world-inputs.md, "Row A, as shipped".
 *
 * Sorted by code unit and without repeats, so the same unread set is the same bytes.
 */
export function dataClaimFor(unread: readonly string[]): DataClaim {
  if (unread.length === 0) return { selector: DATA_SELECTOR };
  const excluded = new Set<string>();
  for (const path of unread) {
    if (path === '' || path === '.') {
      excluded.add('**');
      continue;
    }
    const segments = path.split('/');
    const bad = segments.findIndex(
      (segment, i) => !writableSegment(segment, i === 0, i === segments.length - 1),
    );
    if (bad < 0) {
      excluded.add(path);
      excluded.add(`${path}/**`);
    } else {
      excluded.add(writable(path));
      excluded.add(bad === 0 ? '**' : `${segments.slice(0, bad).join('/')}/**`);
    }
    for (const pattern of stemPatterns(path)) excluded.add(pattern);
  }
  const sorted = [...excluded].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const selector = `${DATA_SELECTOR},${sorted.map((e) => `!${e}`).join(',')}`;
  let count: number;
  try {
    count = compileSelector(selector).clauses.filter((clause) => clause.negated).length;
  } catch (e) {
    return {
      selector: CLAIM_NOTHING,
      note: `the data scope claims nothing in this run: its claim excluding the unread paths did not compile (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  if (count > MAX_EXCLUSIONS) {
    return {
      selector: CLAIM_NOTHING,
      note:
        `the data scope claims nothing in this run, so nothing it declared is tombstoned: ` +
        `${unread.length} unread paths need ${count} exclusions, more than ${MAX_EXCLUSIONS}`,
    };
  }
  return { selector };
}

/** The selector of `dataClaimFor`. */
export function authoritativeSelectorFor(unread: readonly string[]): string {
  return dataClaimFor(unread).selector;
}

const PRODUCES: readonly AuthoritativeScope[] = [
  {
    scope: DATA_SCOPE,
    kinds: ['DataSource', 'Schema', 'Table', 'Column', 'Migration'],
    selector: DATA_SELECTOR,
  },
];

/** Every extension discovery opens: SQL and Prisma sources, and the modules it scans for Drizzle tables. */
const READ_EXTENSIONS: readonly string[] = [
  'sql',
  'prisma',
  ...TS_EXTENSIONS.map((ext) => ext.slice(1)),
];

/**
 * `ext` as a glob character-class sequence that matches in any letter case
 * (`sql` -> `[sS][qQ][lL]`). Discovery lower-cases extensions before comparing,
 * so a legacy `INIT.SQL` migration is read, and a manifest that declared only
 * `*.sql` would be wrong about what this extractor opens.
 */
function anyCase(ext: string): string {
  return [...ext]
    .map((c) =>
      c.toLowerCase() === c.toUpperCase() ? c : `[${c.toLowerCase()}${c.toUpperCase()}]`,
    )
    .join('');
}

/**
 * The capability manifest the host enforces (v3 §2.7).
 *
 * `net: false` is the one that matters here: it is what makes "static files
 * only" a property of the sandbox rather than a promise in a comment.
 */
export const MANIFEST: ExtractorManifest = Object.freeze({
  name: EXTRACTOR_NAME,
  version: EXTRACTOR_VERSION,
  // Plus every `package.json`: discovery reads its `prisma.schema` pointer to find a schema that
  // lives outside the usual places. A read the manifest does not declare is a sandbox violation
  // that discards the whole result.
  reads: [...READ_EXTENSIONS.map((ext) => `**/*.${anyCase(ext)}`), '**/package.json', '**/supabase/config.toml'],
  net: false,
  env: ['SEAMLINE_DETERMINISTIC'],
  memMb: 512,
  timeoutS: 120,
  provenanceCeiling: 'EXTRACTED',
  produces: PRODUCES,
});

/**
 * The values of the `dialect` option. `sqlite`, `mysql` and `mariadb` switch on
 * a default that is true in that dialect only; `clickhouse` reads every statement
 * under ClickHouse rules; `postgres` (alias `postgresql`) is the standard reading
 * and the default. Any other value, a non-string included, is refused rather than
 * quietly read as the default, because a near miss such as `sqlite3` would
 * otherwise leave the dialect-gated defaults off with nothing to say so.
 */
const SQL_DIALECTS: readonly string[] = [
  'clickhouse',
  'mariadb',
  'mysql',
  'postgres',
  'postgresql',
  'sqlite',
];

/**
 * Spellings of one database that are stored under a single label, so the same
 * repository does not produce different node bodies for `postgres` and
 * `postgresql`. `mariadb` is not one of them: it is a different database from
 * `mysql`, and although the two are read by the same rules today, the label is
 * what the caller stated and a rule that tells them apart would need it.
 */
const DIALECT_ALIASES: Readonly<Record<string, string>> = { postgresql: 'postgres' };

/** A short, single-line rendering of an option value for a diagnostic. */
function describeOption(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    return typeof value;
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export interface ExtractDataOptions {
  /** Absolute filesystem root of the repository being extracted. */
  readonly root: string;
  /** Repo name used to build node ids. Must not contain `:`. */
  readonly repo: string;
  readonly runId: string;
  /** Logical data source name; the `DataSource` node's canonical name. */
  readonly dataSource?: string;
  /** Schema assumed when DDL does not qualify a table. */
  readonly defaultSchema?: string;
  /**
   * SQL dialect of the repository's `.sql` files: `postgres` (the default, also
   * spelled `postgresql`), `mysql`, `mariadb`, `sqlite` or `clickhouse`; case is
   * ignored, and `postgresql` is stored as `postgres`. From `seamline.config.json`
   * it is `extractors[].options.dialect` of the `extract-data` entry. Any other
   * value, one that is not a string included (`null`, a number, an array), makes
   * the run `FAIL` with a diagnostic and extracts nothing. Only `undefined` means
   * the option is not set.
   */
  readonly dialect?: string;
  readonly skipDirs?: readonly string[];
  readonly maxFileBytes?: number;
  /** Freezes `durationMs`; also set by `SEAMLINE_DETERMINISTIC=1`. */
  readonly deterministic?: boolean;
}

export interface ExtractDataOutput {
  readonly result: ExtractorResult;
  readonly nodes: readonly SeamlineNode[];
  readonly edges: readonly SeamlineEdge[];
  /**
   * True when discovery completed and found no schema source in any form it
   * reads or recognises: no `.sql`, `.prisma` or Drizzle `pgTable` candidate, and
   * nothing it knows exists and did not read (a directory it could not list, a
   * file over the size limit, a symbolic link, a schema in an extension or a
   * Drizzle dialect it does not parse, a Prisma schema a package names that it
   * did not open, a schema file under a build output or vendor directory; see
   * `Discovery.unread`). The run is UNAVAILABLE all the same.
   *
   * This is a statement about discovery, not about the repository: a schema in a
   * form discovery neither reads nor recognises (another ORM, a database file, a
   * dependency directory, a name in `skipDirs`) leaves it true. It is true only
   * when discovery could have seen every schema it knows how to look for, which
   * a source that was not read, or a discovery that failed, never is. The
   * composition root reads it, as a boolean and not from a diagnostic, to decide
   * whether the code extractor may treat the data-model index as empty rather
   * than absent.
   */
  readonly noSchemaSource: boolean;
}

function applyFile(
  model: SchemaModel,
  file: DiscoveredFile,
  reg: ReturnType<typeof createDrizzleRegistry>,
  sql: ApplySqlOptions,
): number {
  switch (file.kind) {
    case 'prisma':
      return applyPrismaFile(model, file.text, file.path);
    case 'drizzle':
      return applyDrizzleFile(model, reg, file.text, file.path);
    case 'sql':
      return applySqlFile(model, file.text, file.path, 'sql', sql);
    case 'sql-migration':
      return applySqlFile(model, file.text, file.path, 'sql-migration', sql);
    default:
      return 0;
  }
}

/**
 * The source kinds an unread path may hold, from its name: a `.sql` file is SQL (a migration or
 * not, by where it sits), `.prisma` and the files that point at one are Prisma, a TypeScript or
 * JavaScript module is Drizzle. Anything else (a directory, a SQL-family extension no reader here
 * parses) may hold a source of any kind.
 */
function kindsOfUnread(path: string): readonly (typeof SOURCE_KINDS)[number][] {
  const name = basename(path);
  const ext = extname(name).toLowerCase();
  if (name === 'package.json' || /^prisma\.config\./u.test(name) || ext === '.prisma')
    return ['prisma'];
  if (ext === '.sql') return [migrationIdentity(path) === null ? 'sql' : 'sql-migration'];
  if (TS_EXTENSIONS.includes(ext)) return ['drizzle'];
  return SOURCE_KINDS;
}

/**
 * Runs the extractor over one repository.
 *
 * Status is honest by construction: zero nodes never reports `PASS`. An empty
 * `PASS` is indistinguishable downstream from "this project has no database",
 * and every detector that compares a code field against a column would then
 * report the column as missing (v3 §2.2 — UNAVAILABLE is never PASS).
 */
export async function extractData(opts: ExtractDataOptions): Promise<ExtractDataOutput> {
  const startedAt = Date.now();
  const deterministic = opts.deterministic ?? process.env['SEAMLINE_DETERMINISTIC'] === '1';
  const dataSource = opts.dataSource ?? 'default';
  const defaultSchema = opts.defaultSchema ?? 'public';
  // The option arrives from a JSON config, so its type is checked here and not only declared.
  const requested: unknown = opts.dialect;
  const spelled: string | null =
    requested === undefined
      ? 'postgres'
      : typeof requested === 'string'
        ? requested.toLowerCase()
        : null;

  assertWithinCeiling(MANIFEST, 'EXTRACTED');

  if (spelled === null || !SQL_DIALECTS.includes(spelled)) {
    return {
      result: {
        extractor: EXTRACTOR_NAME,
        version: EXTRACTOR_VERSION,
        status: 'FAIL',
        authoritative: PRODUCES,
        nodeCount: 0,
        edgeCount: 0,
        durationMs: deterministic ? 0 : Date.now() - startedAt,
        diagnostics: [
          `invalid option: dialect ${describeOption(requested)} is not one of ${SQL_DIALECTS.join(', ')}`,
        ],
      },
      nodes: [],
      edges: [],
      // Discovery did not run, so nothing is said about whether the repository holds a schema.
      noSchemaSource: false,
    };
  }

  const dialect = DIALECT_ALIASES[spelled] ?? spelled;
  const model = new SchemaModel(dataSource, defaultSchema, opts.dataSource !== undefined, dialect);
  const diagnostics: string[] = [];

  let files: DiscoveredFile[] = [];
  let unread: readonly string[] = [];
  let discovered = false;
  let migrationOrders: readonly MigrationOrder[] = [];
  // Paths `onSkip` named, each with its own diagnostic and the kinds it withholds.
  const reported = new Set<string>();
  try {
    const found = await discoverSources({
      root: opts.root,
      ...(opts.skipDirs === undefined ? {} : { skipDirs: opts.skipDirs }),
      ...(opts.maxFileBytes === undefined ? {} : { maxFileBytes: opts.maxFileBytes }),
      onSkip: (path, reason) => {
        reported.add(path);
        // A directory that could not be listed, or a symbolic link to one that
        // discovery did not follow, may hold a source of any kind.
        if (reason === 'unreadable-directory' || reason === 'symlinked-directory') {
          for (const kind of SOURCE_KINDS) model.markUnread(kind);
          diagnostics.push(
            `schema source not read (${reason === 'symlinked-directory' ? 'symlink' : reason}): ${path}`,
          );
          return;
        }
        // Discovery reports a TypeScript or JavaScript file only when it may hold a
        // Drizzle table (see `discover.ts`), so it is an unread Drizzle source.
        const ext = extname(path).toLowerCase();
        if (TS_EXTENSIONS.includes(ext)) model.markUnread('drizzle');
        else if (ext === '.prisma') model.markUnread('prisma');
        else if (ext === '.sql')
          model.markUnread(migrationIdentity(path) === null ? 'sql' : 'sql-migration');
        else {
          reported.delete(path);
          return;
        }
        diagnostics.push(`schema source not read (${reason}): ${path}`);
      },
    });
    files = found.files;
    migrationOrders = found.migrationOrders;
    unread = found.unread;
    discovered = true;
  } catch (err) {
    diagnostics.push(`discovery failed: ${String(err)}`);
  }
  // What discovery knows exists and did not read, and `onSkip` did not name (a schema in a form no
  // reader here parses, a file under an output directory, a Prisma schema a package points at, a
  // module using a Drizzle constructor that is not parsed): it may declare or alter anything of the
  // kinds it could be, so those kinds' facts are withheld, as they are for the paths named above.
  const unreported = unread.filter((path) => !reported.has(path));
  for (const path of unreported) {
    for (const kind of kindsOfUnread(path)) model.markUnread(kind);
  }

  const reg = createDrizzleRegistry();
  // A configured `clickhouse` dialect is the caller's own statement of fact; it
  // is the only way a SQL file without statement-level evidence is read as
  // ClickHouse.
  const sqlOptions: ApplySqlOptions = { clickhouse: dialect === 'clickhouse' };
  let migrationOrdinal = 0;
  let failed = 0;
  const failedFiles: string[] = [];

  // Names are assigned over the whole set before any file is applied, so they do
  // not depend on the order the files are visited in.
  const migrationSources: MigrationSource[] = [];
  for (const f of files) {
    if (f.kind === 'sql-migration' && f.version !== null) {
      migrationSources.push({ path: f.path, version: f.version, group: f.group });
    }
  }
  const migrationNames = assignMigrationNames(migrationSources);
  diagnostics.push(...migrationNames.diagnostics);

  let resourceLimit = false;
  for (const file of files) {
    try {
      const migrationKey =
        file.kind === 'sql-migration' ? migrationNames.names.get(file.path) : undefined;
      if (migrationKey !== undefined && file.version !== null) {
        model.currentMigration = migrationKey;
        const statementCount = applyFile(model, file, reg, sqlOptions);
        model.addMigration({
          name: migrationKey,
          version: file.version,
          ordinal: migrationOrdinal,
          path: file.path,
          statementCount,
        });
        migrationOrdinal += 1;
        model.currentMigration = null;
      } else {
        applyFile(model, file, reg, sqlOptions);
      }
    } catch (err) {
      failed += 1;
      failedFiles.push(file.path);
      if (err instanceof RangeError) resourceLimit = true;
      model.currentMigration = null;
      model.markUnread(file.kind);
      diagnostics.push(`parse failed for ${file.path}: ${String(err)}`);
    }
  }

  resolveDrizzleRefs(model, reg);

  model.migrationReplay = replayMigrations(files, migrationOrders, migrationNames.names, {
    epoch: opts.runId, schema: model.defaultSchema, dialect,
    unread: [...unread, ...failedFiles, ...(discovered ? [] : ['.'])],
  });

  const emitted = emit(model, { repo: opts.repo, runId: opts.runId, dialect });
  diagnostics.push(...model.diagnostics, ...emitted.diagnostics);

  let status: ExtractorStatus;
  // "Found none" is a statement about discovery, and only true of one that finished and knew of
  // nothing it did not read (see `Discovery.unread`); a source that was not read might have
  // declared tables.
  const noSchemaSource = discovered && files.length === 0 && unread.length === 0;
  const claim = dataClaimFor(unread);
  const listPaths = (paths: readonly string[]): string =>
    `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', ...' : ''}`;
  const listUnread = listPaths(unread);
  if (resourceLimit) {
    // A tokenizer limit leaves schema facts unknown even when another file was read.
    // A failed scope preserves prior facts instead of sweeping the unread statements.
    status = 'FAIL';
  } else if (model.migrationReplay.unavailable) {
    status = 'UNAVAILABLE';
    diagnostics.push('migration history has unsupported membership effects, ordering, or an incomplete source inventory; withholding authoritative absence and preserving prior facts');
  } else if (files.length === 0) {
    status = 'UNAVAILABLE';
    diagnostics.push(
      unread.length === 0
        ? NO_SCHEMA_SOURCE_FOUND
        : `no schema source could be read: ${unread.length} candidate path(s) not read ` +
            `(unreadable, over the size limit, a symbolic link, or a form this extractor does not read): ${listUnread}`,
    );
  } else if (failed === files.length) {
    status = 'FAIL';
  } else if (emitted.nodes.length === 0 || model.tableCount() === 0) {
    status = 'UNAVAILABLE';
    diagnostics.push(
      `schema sources were read (${files.length}) but declared no tables; reporting UNAVAILABLE rather than an empty PASS`,
    );
  } else {
    status = 'PASS';
  }
  if (files.length > 0 && unreported.length > 0) {
    // The status is unchanged: tables were read. But a schema candidate was not, so the model may
    // be incomplete, and a PASS that says nothing would read as the whole schema. A path named
    // above, with its reason, is not repeated here.
    diagnostics.push(
      `schema candidates were not read, so tables they declare are not in this run (${unreported.length}): ${listPaths(unreported)}`,
    );
  }
  if (files.length > 0 && unread.length > 0) {
    // Whatever names the unread paths, the sweep protection they cause is stated once.
    const stems = [...new Set(unread.map(stemOf).filter((stem) => stem !== ''))].sort();
    diagnostics.push(
      `files sharing a stem with an unread candidate${stems.length <= 5 ? ` (${stems.join(', ')})` : ''} ` +
        `are protected from sweeping, so a deletion of one is not recorded until a run that reads every candidate`,
    );
    if (claim.note !== undefined) diagnostics.push(claim.note);
  }

  // Guards the invariant above rather than trusting the branch order.
  if (status === 'PASS' && emitted.nodes.length === 0) {
    throw new Error('extract-data would have reported PASS with zero nodes');
  }

  const result: ExtractorResult = {
    extractor: EXTRACTOR_NAME,
    version: EXTRACTOR_VERSION,
    status,
    authoritative:
      unread.length === 0
        ? PRODUCES
        : [{ ...(PRODUCES[0] as AuthoritativeScope), selector: claim.selector }],
    nodeCount: emitted.nodes.length,
    edgeCount: emitted.edges.length,
    durationMs: deterministic ? 0 : Date.now() - startedAt,
    diagnostics: [...new Set(diagnostics)].sort(),
  };

  return { result, nodes: emitted.nodes, edges: emitted.edges, noSchemaSource };
}
