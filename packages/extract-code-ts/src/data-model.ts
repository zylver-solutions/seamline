/**
 * The data-model index, read-only, and the binding of a SQL table name to a
 * `Table` node id.
 *
 * `extract-code-ts` does not read `schema.prisma`, does not depend on
 * `extract-data`, and does not re-derive a table or column name. It is handed a
 * canonical JSON document built from `extract-data`'s output (the writer is
 * `buildDataModelIndex` in `@seamline/extract-data`, which documents the format)
 * and answers one question with it: which declared table, if any, does this
 * name in this SQL statement mean. Design: `docs/design/real-world-inputs.md`,
 * section 3.3.
 *
 * The document is an input of the run. It is parsed here, never read from
 * disk, so the extractor's `reads` do not change, and what a malformed one means
 * is decided here: it is refused, and the run proceeds as if no index had been
 * supplied (`extract.ts`), which is the safe reading.
 */

import { parseNodeId } from '@seamline/ontology';
import type { NodeId } from '@seamline/ontology';
import type { SqlTableName } from './sql.ts';

export const SUPPORTED_INDEX_VERSION = 1;

export interface IndexedDataSource {
  readonly name: string;
  readonly dialect: string;
  /** The schema an unqualified table name means. */
  readonly defaultSchema: string;
}

export interface IndexedTable {
  readonly id: NodeId;
  readonly dataSource: string;
  /** Present when the table is read by another dialect's rules than its data source's. */
  readonly dialect?: string;
  readonly schema: string;
  /** The physical table name, as spelled in the schema. */
  readonly name: string;
}

export interface DataModelIndex {
  readonly version: typeof SUPPORTED_INDEX_VERSION;
  readonly dataSources: readonly IndexedDataSource[];
  /** Sorted by id. */
  readonly tables: readonly IndexedTable[];
  /** Prisma client delegate (`prisma.<delegate>`) to model name and table id. */
  readonly prismaDelegates: Readonly<
    Record<string, { readonly model: string; readonly table: NodeId }>
  >;
  /** Drizzle table binding (the exported const) to table id. */
  readonly drizzleExports: Readonly<Record<string, NodeId>>;
}

export type ParsedDataModelIndex =
  | { readonly ok: true; readonly index: DataModelIndex }
  | { readonly ok: false; readonly problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tableIdOf(
  value: unknown,
  where: string,
  repo: string,
): { readonly id: NodeId } | { readonly problem: string } {
  if (typeof value !== 'string') return { problem: `${where} is not a string` };
  try {
    const parsed = parseNodeId(value as NodeId);
    if (parsed.kind !== 'Table') return { problem: `${where} is not a Table id` };
    if (parsed.repo !== repo) return { problem: `${where} belongs to another repository` };
  } catch {
    return { problem: `${where} is not a node id` };
  }
  return { id: value as NodeId };
}

/**
 * Reads an index document. Never throws: the result says whether the text was
 * an index this reader understands and, if not, the first thing that was wrong.
 * Every table id must belong to `repo`: an index built for another repository
 * would otherwise point this repository's edges at nodes that are not its own.
 */
export function parseDataModelIndex(text: string, repo: string): ParsedDataModelIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      problem: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(raw)) return { ok: false, problem: 'not an object' };
  if (raw['version'] !== SUPPORTED_INDEX_VERSION) {
    return { ok: false, problem: `unsupported version ${JSON.stringify(raw['version'])}` };
  }

  const dataSources: IndexedDataSource[] = [];
  if (!Array.isArray(raw['dataSources']))
    return { ok: false, problem: 'dataSources is not an array' };
  for (const [i, entry] of (raw['dataSources'] as unknown[]).entries()) {
    if (
      !isRecord(entry) ||
      typeof entry['name'] !== 'string' ||
      typeof entry['dialect'] !== 'string' ||
      typeof entry['defaultSchema'] !== 'string'
    ) {
      return {
        ok: false,
        problem: `dataSources[${i}] needs a string name, dialect and defaultSchema`,
      };
    }
    dataSources.push({
      name: entry['name'],
      dialect: entry['dialect'],
      defaultSchema: entry['defaultSchema'],
    });
  }

  const tables: IndexedTable[] = [];
  if (!Array.isArray(raw['tables'])) return { ok: false, problem: 'tables is not an array' };
  for (const [i, entry] of (raw['tables'] as unknown[]).entries()) {
    if (!isRecord(entry)) return { ok: false, problem: `tables[${i}] is not an object` };
    const id = tableIdOf(entry['id'], `tables[${i}].id`, repo);
    if ('problem' in id) return { ok: false, problem: id.problem };
    if (
      typeof entry['name'] !== 'string' ||
      typeof entry['schema'] !== 'string' ||
      typeof entry['dataSource'] !== 'string'
    ) {
      return { ok: false, problem: `tables[${i}] needs a string name, schema and dataSource` };
    }
    if (!dataSources.some((d) => d.name === entry['dataSource'])) {
      return {
        ok: false,
        problem: `tables[${i}] names the unknown data source ${JSON.stringify(entry['dataSource'])}`,
      };
    }
    if (entry['dialect'] !== undefined && typeof entry['dialect'] !== 'string') {
      return { ok: false, problem: `tables[${i}].dialect is not a string` };
    }
    tables.push({
      id: id.id,
      dataSource: entry['dataSource'],
      ...(entry['dialect'] === undefined ? {} : { dialect: entry['dialect'] }),
      schema: entry['schema'],
      name: entry['name'],
    });
  }

  const prismaDelegates: Record<string, { model: string; table: NodeId }> = {};
  if (!isRecord(raw['prismaDelegates']))
    return { ok: false, problem: 'prismaDelegates is not an object' };
  for (const key of Object.keys(raw['prismaDelegates']).sort()) {
    const entry = (raw['prismaDelegates'] as Record<string, unknown>)[key];
    if (!isRecord(entry) || typeof entry['model'] !== 'string') {
      return { ok: false, problem: `prismaDelegates.${key} needs a string model` };
    }
    const id = tableIdOf(entry['table'], `prismaDelegates.${key}.table`, repo);
    if ('problem' in id) return { ok: false, problem: id.problem };
    prismaDelegates[key] = { model: entry['model'], table: id.id };
  }

  const drizzleExports: Record<string, NodeId> = {};
  if (!isRecord(raw['drizzleExports']))
    return { ok: false, problem: 'drizzleExports is not an object' };
  for (const key of Object.keys(raw['drizzleExports']).sort()) {
    const id = tableIdOf(
      (raw['drizzleExports'] as Record<string, unknown>)[key],
      `drizzleExports.${key}`,
      repo,
    );
    if ('problem' in id) return { ok: false, problem: id.problem };
    drizzleExports[key] = id.id;
  }

  tables.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    ok: true,
    index: {
      version: SUPPORTED_INDEX_VERSION,
      dataSources,
      tables,
      prismaDelegates,
      drizzleExports,
    },
  };
}

/* ---------------------------------------------------------------- binding */

/**
 * How a database compares an identifier in a statement with the one in its
 * schema. Postgres folds an unquoted identifier to lower case and keeps a quoted
 * one exact; SQLite compares case-insensitively; MySQL compares exactly. A
 * dialect this does not know is compared exactly: a name that differs in case is
 * then not bound, which leaves the edge where it is today instead of guessing.
 */
type Folding = 'postgres' | 'sqlite' | 'exact';

function foldingOf(dialect: string): Folding {
  switch (dialect.toLowerCase()) {
    case 'postgres':
    case 'postgresql':
      return 'postgres';
    case 'sqlite':
    case 'sqlite3':
      return 'sqlite';
    default:
      return 'exact';
  }
}

/** True when the name as written in a statement means the declared `name`. */
function sameIdentifier(
  folding: Folding,
  written: string,
  quoted: boolean,
  declared: string,
): boolean {
  switch (folding) {
    case 'postgres':
      return (quoted ? written : written.toLowerCase()) === declared;
    case 'sqlite':
      return written.toLowerCase() === declared.toLowerCase();
    case 'exact':
      return written === declared;
  }
}

export type TableBinding =
  /** The reference means this declared table. */
  | { readonly kind: 'bound'; readonly id: NodeId }
  /**
   * The reference could mean more than one declared table, or one of several
   * declared tables, and nothing says which. `tables` are the physical names of
   * those candidates, sorted and without repeats.
   */
  | { readonly kind: 'ambiguous'; readonly tables: readonly string[] }
  /**
   * An unqualified name that no table of the default schema has, declared in
   * exactly one other schema. The caller keeps its own (name-only) answer for the
   * edge, because which schema a connection searches first is not in the code,
   * and `tables` are the physical names of what the statement may have meant, to
   * be listed as written by something unseen. Sorted and without repeats.
   */
  | { readonly kind: 'elsewhere'; readonly tables: readonly string[] }
  /** No declared table has this name. Not ambiguous: the caller keeps its own answer. */
  | { readonly kind: 'none' };

/**
 * Binds table references of SQL statements to declared tables.
 *
 * - A schema-qualified name binds only to that schema.
 * - An unqualified name binds to the data source's default schema.
 * - If more than one table in the candidate set matches (several data sources,
 *   or a dialect that folds two declared names to one) the reference is
 *   ambiguous. So is an unqualified name that is declared in more than one
 *   schema when none of them is the default, such as `auth.users` and
 *   `app.users`: which one the connection's search path picks is not in the
 *   code.
 * - An unqualified name declared in exactly one schema that is not the default
 *   (and in no default schema) is not bound and is not ambiguous either: it
 *   names no table of the default schema, and the search path that could say
 *   otherwise is not in the code. It is `elsewhere`, which keeps the edge the
 *   caller always built and names the table it may have meant.
 */
export function tableBinder(index: DataModelIndex): (ref: SqlTableName) => TableBinding {
  const folding = new Map<string, Folding>(
    index.dataSources.map((d) => [d.name, foldingOf(d.dialect)]),
  );
  const defaultSchema = new Map<string, string>(
    index.dataSources.map((d) => [d.name, d.defaultSchema]),
  );
  // A table read by another dialect's rules (a ClickHouse table in a PostgreSQL source) is
  // compared by its own.
  const foldingFor = (t: IndexedTable): Folding =>
    t.dialect !== undefined ? foldingOf(t.dialect) : (folding.get(t.dataSource) ?? 'exact');

  // Tables bucketed by the name they are compared under, once per binder, so that a lookup
  // reads the few tables that could match instead of every table: a table sits in the bucket
  // of its folding, keyed by its name as that folding compares it. The value is the position
  // in `index.tables`, so a lookup returns candidates in table order, as a filter would.
  const buckets: Record<Folding, Map<string, number[]>> = {
    postgres: new Map(),
    sqlite: new Map(),
    exact: new Map(),
  };
  index.tables.forEach((t, position) => {
    const f = foldingFor(t);
    const key = f === 'sqlite' ? t.name.toLowerCase() : t.name;
    const held = buckets[f].get(key);
    if (held === undefined) buckets[f].set(key, [position]);
    else held.push(position);
  });
  const candidates = (ref: SqlTableName): IndexedTable[] => {
    const positions = [
      ...(buckets.postgres.get(ref.tableQuoted ? ref.tableText : ref.tableText.toLowerCase()) ??
        []),
      ...(buckets.sqlite.get(ref.tableText.toLowerCase()) ?? []),
      ...(buckets.exact.get(ref.tableText) ?? []),
    ].sort((a, b) => a - b);
    return positions.map((position) => index.tables[position] as IndexedTable);
  };

  return (ref) => {
    const named = candidates(ref);
    const schemaText = ref.schemaText;
    const resolved =
      schemaText !== null
        ? named.filter((t) => sameIdentifier(foldingFor(t), schemaText, ref.schemaQuoted, t.schema))
        : named.filter((t) => t.schema === defaultSchema.get(t.dataSource));

    if (resolved.length === 1) return { kind: 'bound', id: (resolved[0] as IndexedTable).id };
    if (resolved.length > 1) return { kind: 'ambiguous', tables: namesOf(resolved) };
    // Nothing in the schema the name resolves to. A qualified name that no table
    // carries is simply not bound. An unqualified name declared in several
    // schemas, none of them the default, is the ambiguous case; one declared in a
    // single other schema is `elsewhere`; one declared nowhere is not bound.
    if (schemaText === null && named.length > 0) {
      const places = new Set(named.map((t) => `${t.dataSource}\u0000${t.schema}`));
      return places.size > 1
        ? { kind: 'ambiguous', tables: namesOf(named) }
        : { kind: 'elsewhere', tables: namesOf(named) };
    }
    return { kind: 'none' };
  };
}

function namesOf(tables: readonly IndexedTable[]): readonly string[] {
  return [...new Set(tables.map((t) => t.name))].sort();
}

/* ------------------------------------------------------------------ names */

/**
 * The names the ORM clients use for a declared table, and the spellings a file the run
 * did not read can use to write one (design 5.2, `unknownWriterTables` (a) and (b)).
 * Every value is a physical table name, the one `unknownWriterTables` lists.
 */
export interface OrmNames {
  /** Prisma client delegate (`prisma.<delegate>`) to the physical name of its table. */
  readonly delegates: ReadonlyMap<string, string>;
  /** Drizzle table binding (the exported const) to the physical name of its table. */
  readonly exports: ReadonlyMap<string, string>;
  /**
   * Spellings compared exactly: a delegate, a Prisma model name, a Drizzle binding. A spelling
   * two tables share (the same model name in two data sources) maps to both.
   */
  readonly exact: ReadonlyMap<string, readonly string[]>;
  /** Physical table names compared without regard to case, keyed by the lower-cased name. */
  readonly folded: ReadonlyMap<string, readonly string[]>;
}

export function ormNames(index: DataModelIndex): OrmNames {
  const physical = new Map<string, string>(index.tables.map((t) => [t.id, t.name]));
  // An id the table list does not hold (a hand-written index) is named by what follows the schema.
  const nameOf = (id: NodeId): string => {
    const held = physical.get(id);
    if (held !== undefined) return held;
    const canonical = parseNodeId(id).canonicalName;
    return canonical.slice(canonical.indexOf('.') + 1);
  };

  const delegates = new Map<string, string>();
  const exports = new Map<string, string>();
  const exact = new Map<string, Set<string>>();
  const add = (into: Map<string, Set<string>>, spelling: string, table: string): void => {
    const held = into.get(spelling);
    if (held === undefined) into.set(spelling, new Set([table]));
    else held.add(table);
  };
  for (const [delegate, entry] of Object.entries(index.prismaDelegates)) {
    const table = nameOf(entry.table);
    delegates.set(delegate, table);
    add(exact, delegate, table);
    add(exact, entry.model, table);
  }
  for (const [binding, id] of Object.entries(index.drizzleExports)) {
    const table = nameOf(id);
    exports.set(binding, table);
    add(exact, binding, table);
  }
  const folded = new Map<string, Set<string>>();
  for (const t of index.tables) add(folded, t.name.toLowerCase(), t.name);

  const sorted = (from: Map<string, Set<string>>): Map<string, readonly string[]> =>
    new Map([...from].map(([k, v]) => [k, [...v].sort()]));
  return { delegates, exports, exact: sorted(exact), folded: sorted(folded) };
}
