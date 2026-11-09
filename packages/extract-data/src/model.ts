/**
 * The intermediate schema model every source parser writes into.
 *
 * Sources are applied in ascending authority (Prisma, then Drizzle, then plain
 * SQL, then migration files in migration order), so a later write wins on any
 * property it actually asserts. That is what makes `ALTER TABLE ... ADD COLUMN`
 * in migration 0003 the final answer rather than a duplicate of the CREATE in
 * 0001, and what makes a checked-in `schema.sql` outrank a Prisma model that
 * has drifted from it.
 *
 * Nothing here knows about node ids or the graph; `emit.ts` owns that.
 */

import { normalizeSqlType, type TypeCategory } from './normalize-type.ts';
import type { ReplayFacts } from './migration-replay.ts';

/** Which kind of file a fact came from. Ordered by authority, lowest first. */
export const SOURCE_KINDS = ['prisma', 'drizzle', 'sql', 'sql-migration'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceRef {
  /** Repo-relative POSIX path. Never absolute, never a backslash (v3 §2.3). */
  readonly path: string;
  readonly line: number;
  readonly sourceKind: SourceKind;
}

export interface ColumnFact {
  schema: string;
  table: string;
  name: string;
  declaredType: string;
  type: string;
  category: TypeCategory;
  isArray: boolean;
  nullable: boolean;
  /** True once a source stated nullability explicitly rather than defaulting. */
  nullableDeclared: boolean;
  /** True while any source declares a default, wherever it is supplied. */
  hasDefault: boolean;
  /**
   * Some source declares a default the database itself supplies (SQL `DEFAULT`,
   * a sequence, an identity, `AUTO_INCREMENT`, a rowid alias, Prisma `now()`,
   * Drizzle `.defaultNow()`). Such a default reaches every writer, raw SQL
   * included.
   */
  dbDefault: boolean;
  /**
   * Some source declares a default only the ORM client supplies (Prisma
   * `cuid()` and `@updatedAt`, Drizzle `$defaultFn` and `$onUpdate`). A raw SQL
   * statement does not receive it.
   */
  clientDefault: boolean;
  /**
   * The column is a Prisma scalar list (`tags String[]`). Prisma Migrate creates
   * it as a nullable array with no default, so while no DDL declares it
   * `NOT NULL` the database accepts a statement that omits it (see
   * `suppliesNullList`). Kept apart from `dbDefault` so that
   * `ALTER COLUMN ... DROP DEFAULT`, which Prisma emits when `@default([])` is
   * removed, cannot erase it: dropping a default does not make an array column
   * NOT NULL.
   */
  scalarList: boolean;
  /**
   * What the last SQL statement that said anything about the column's
   * nullability said (`NOT NULL`, `SET NOT NULL`, `NULL`, `DROP NOT NULL`);
   * `null` when no SQL statement has. A Prisma model states `nullable` for a
   * list field without having seen the database, so this is the only evidence
   * about the column that the database itself gives.
   */
  ddlNullable: boolean | null;
  defaultExpr: string | null;
  isPrimaryKey: boolean;
  isUnique: boolean;
  /**
   * The SQL declaration put an `UNSIGNED`, `SIGNED` or `ZEROFILL` modifier after
   * the type. SQLite then reads the declared type as `INTEGER UNSIGNED`, which
   * is no longer exactly `INTEGER`, so the column is not a rowid alias.
   */
  typeModified: boolean;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  checks: string[];
  comment: string | null;
  ordinal: number;
  path: string;
  line: number;
  sourceKind: SourceKind;
  sources: SourceKind[];
  migrations: string[];
  /**
   * SQL dialect the declaring statement was recognised as, or `null` when the
   * statement carried no dialect evidence (the extractor-wide default applies).
   * Only evidence-backed dialects are recorded here; see `clickhouse.ts`.
   */
  dialect: string | null;
}

/**
 * A Prisma scalar list that no DDL declares `NOT NULL`. Prisma Migrate creates
 * the column as a nullable array (`"tags" TEXT[]`, with or without a default),
 * so a statement that omits it stores `NULL` and succeeds, raw SQL included: the
 * database supplies the value. That holds through `DROP DEFAULT`, which Prisma
 * emits when `@default([])` is removed from a list field, and it stops holding
 * only when a migration says the column is `NOT NULL`.
 */
export function suppliesNullList(col: ColumnFact): boolean {
  return col.scalarList && col.ddlNullable !== false;
}

/** The two sources that name a table through a client API: a Prisma model, a Drizzle table binding. */
export type OrmSource = 'prisma' | 'drizzle';

/** A name an ORM source gives a table: the Prisma model name, or the Drizzle table binding. */
export interface OrmName {
  readonly source: OrmSource;
  readonly name: string;
}

export interface TableFact {
  schema: string;
  name: string;
  columns: Map<string, ColumnFact>;
  comment: string | null;
  path: string;
  line: number;
  sourceKind: SourceKind;
  sources: SourceKind[];
  migrations: string[];
  checks: string[];
  /** Dialect the table's defining statement was recognised as; `null` when none. */
  dialect: string | null;
  /**
   * Repo-relative paths of the non-migration files that declare this table
   * (`CREATE TABLE`, `pgTable`, a Prisma `model`). A migration that creates or
   * alters the table is history, not a declaration. A table that two files
   * declare is a union of both, which is what `declarations` reports.
   */
  declaredIn: Set<string>;
  /** Distinct names ORM sources gave this table, in the order they were applied. */
  ormNames: OrmName[];
}

export interface SchemaFact {
  name: string;
  tables: Map<string, TableFact>;
  path: string;
  line: number;
  sourceKind: SourceKind;
}

export interface ForeignKeyFact {
  readonly name: string | null;
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly refSchema: string;
  readonly refTable: string;
  readonly refColumns: readonly string[];
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
  readonly path: string;
  readonly line: number;
}

export interface MigrationFact {
  /** Canonical name, unique per migration file (see `migration-ids.ts`). */
  readonly name: string;
  /** The version as the file or directory spells it; shared by migrations in different directories. */
  readonly version: string;
  readonly ordinal: number;
  readonly path: string;
  readonly statementCount: number;
}

/** Fields a source may assert about a column. Absent means "says nothing". */
export interface ColumnPatch {
  declaredType?: string;
  type?: string;
  category?: TypeCategory;
  isArray?: boolean;
  nullable?: boolean;
  /**
   * The source declares (`true`) or removes (`false`, `DROP DEFAULT`) a
   * database-side default. Removing one never removes a client-side default,
   * which belongs to the ORM schema and which DDL cannot drop.
   */
  dbDefault?: boolean;
  /** The source declares a default that only the ORM client supplies. */
  clientDefault?: boolean;
  /** The column is a Prisma scalar list, created by Prisma Migrate as a nullable array. */
  scalarList?: boolean;
  defaultExpr?: string | null;
  isPrimaryKey?: boolean;
  isUnique?: boolean;
  /** The declaration carries an `UNSIGNED`, `SIGNED` or `ZEROFILL` type modifier. */
  typeModified?: boolean;
  maxLength?: number | null;
  numericPrecision?: number | null;
  numericScale?: number | null;
  check?: string;
  comment?: string | null;
  /** Dialect evidence for the statement making this assertion. */
  dialect?: string | null;
}

function pushUnique(arr: string[], v: string): void {
  if (!arr.includes(v)) arr.push(v);
}

function pushUniqueSource(arr: SourceKind[], v: SourceKind): void {
  if (!arr.includes(v)) arr.push(v);
}

/** `schema.table` key for the per-table maps below. Not an identity: never emitted. */
function tableKey(schema: string, table: string): string {
  return `${schema}\u0000${table}`;
}

function triggersOf(store: Map<string, Map<string, boolean>>, key: string): Map<string, boolean> {
  let byName = store.get(key);
  if (byName === undefined) {
    byName = new Map();
    store.set(key, byName);
  }
  return byName;
}

function firesBeforeInsert(byName: ReadonlyMap<string, boolean> | undefined): boolean {
  return byName !== undefined && [...byName.values()].some((before) => before);
}

export class SchemaModel {
  migrationReplay: ReplayFacts | null = null;
  readonly dataSource: string;
  /**
   * True when the caller actually configured a datasource, as opposed to
   * `dataSource` carrying the `'default'` fallback. Only the explicit case
   * qualifies Schema/Table/Column identity (v3 §2.1) -- the single-datasource
   * majority must keep its existing 3-part ids unchanged.
   */
  readonly hasExplicitDataSource: boolean;
  readonly defaultSchema: string;
  /**
   * Lower-cased SQL dialect the caller named. Two default forms are only true
   * in one dialect (`INTEGER PRIMARY KEY` is a rowid alias in SQLite and a bare
   * key in Postgres; the implicit `TIMESTAMP` default is MySQL's), so the
   * dialect gates them rather than letting one dialect's rule rewrite another's
   * schema.
   */
  readonly dialect: string;
  readonly schemas: Map<string, SchemaFact> = new Map();
  readonly foreignKeys: ForeignKeyFact[] = [];
  readonly migrations: MigrationFact[] = [];
  readonly enumTypes: Set<string> = new Set();
  readonly diagnostics: string[] = [];

  /**
   * Kinds of source that failed to parse, or that discovery found and could not
   * read. A fact that would be true only if every such file had been read (no
   * trigger, one declaration, a client-side default) is omitted rather than
   * emitted when its kind is in here: absence of evidence from a file nobody
   * read is not evidence of absence.
   */
  readonly unreadSources: Set<SourceKind> = new Set();

  /**
   * `BEFORE INSERT` triggers by table and trigger name (`true`: fires before an
   * insert; `false`: some other timing, kept so a `CREATE OR REPLACE` that swaps
   * one for the other leaves the answer correct).
   *
   * Three stores, because a removal (`DROP TRIGGER`, `DROP TABLE`, a rename, an
   * `OR REPLACE`) is only meaningful against a trigger whose order relative to
   * it is known:
   *
   * - `fileTriggers`: the file being applied. Statements run in file order, so
   *   a removal reaches every trigger created above it in the same file.
   * - `replayedTriggers`: the migrations applied so far. Migrations are
   *   ordered, so a removal in migration N reaches the triggers of earlier
   *   migrations as well.
   * - `standaloneTriggers`: the union of what every non-migration `.sql` file
   *   leaves behind. Those files are applied in path order, which says nothing
   *   about deployment order, so a removal in one never reaches another's
   *   triggers and a trigger that any of them creates is kept.
   */
  private fileTriggers: Map<string, Map<string, boolean>> = new Map();
  private fileIsMigration = false;
  private readonly replayedTriggers: Map<string, Map<string, boolean>> = new Map();
  private readonly standaloneTriggers: Map<string, Map<string, boolean>> = new Map();
  /** `[from, to]` table keys renamed by any file; a standalone trigger on `from` is also on `to`. */
  private readonly renamedTables: Array<readonly [string, string]> = [];
  /**
   * `CREATE TRIGGER` statements whose table or timing could not be read. Each
   * might be a BEFORE INSERT trigger on any table, so none of them can make a
   * table's `false` certain; none of them removes a trigger already seen.
   */
  unresolvedTriggers = 0;
  /**
   * Constructs that hide statements from the lexer (`DELIMITER` blocks, MySQL
   * version comments) in a file that mentions a trigger. What they hide may add
   * a trigger or drop one, so they make `false` and `true` alike uncertain.
   */
  hiddenTriggers = 0;
  /**
   * `DO` blocks and `EXECUTE` statements: DDL this parser cannot replay. Every
   * one in a migration counts; elsewhere only those whose text contains
   * `CREATE`, `ALTER` or `DROP`.
   */
  dynamicDdl = 0;

  /** Migration currently being applied, so writes can record `MIGRATED_BY`. */
  currentMigration: string | null = null;

  constructor(dataSource: string, defaultSchema: string, hasExplicitDataSource: boolean, dialect = 'postgres') {
    this.dataSource = dataSource;
    this.hasExplicitDataSource = hasExplicitDataSource;
    this.defaultSchema = defaultSchema;
    this.dialect = dialect.toLowerCase();
  }

  markUnread(kind: SourceKind): void {
    this.unreadSources.add(kind);
  }

  /** Starts a SQL file: its triggers are replayed in its own order, then merged by `endTriggerFile`. */
  beginTriggerFile(kind: SourceKind): void {
    this.fileTriggers = new Map();
    this.fileIsMigration = kind === 'sql-migration';
  }

  /** Merges the finished file's surviving triggers into the migration replay or the standalone union. */
  endTriggerFile(): void {
    for (const [key, byName] of this.fileTriggers) {
      if (byName.size === 0) continue;
      if (this.fileIsMigration) {
        const target = triggersOf(this.replayedTriggers, key);
        for (const [name, before] of byName) target.set(name, before);
      } else {
        const target = triggersOf(this.standaloneTriggers, key);
        for (const [name, before] of byName) target.set(name, (target.get(name) ?? false) || before);
      }
    }
    this.fileTriggers = new Map();
    this.fileIsMigration = false;
  }

  /** The stores a removal in the current file may reach: its own, and the earlier migrations when it is one. */
  private removable(): Array<Map<string, Map<string, boolean>>> {
    return this.fileIsMigration ? [this.fileTriggers, this.replayedTriggers] : [this.fileTriggers];
  }

  /** Records that `trigger` on `schema.table` does (or does not) fire before an insert. */
  recordTrigger(
    schema: string,
    table: string,
    trigger: string,
    beforeInsert: boolean,
    ifNotExists = false,
    triggerSchema = schema,
  ): void {
    const triggerKey = `${triggerSchema}\u0000${trigger}`;
    // An ordered CREATE IF NOT EXISTS leaves an existing trigger untouched,
    // including one installed by an earlier migration. Standalone files have
    // no deployment order, so only this file's history can make it a no-op.
    if (ifNotExists) {
      for (const store of this.removable()) {
        for (const byName of store.values()) {
          if (byName.has(triggerKey)) return;
        }
      }
    }
    triggersOf(this.fileTriggers, tableKey(schema, table)).set(triggerKey, beforeInsert);
  }

  dropTrigger(schema: string, table: string, trigger: string, triggerSchema = schema): void {
    const key = tableKey(schema, table);
    for (const store of this.removable()) store.get(key)?.delete(`${triggerSchema}\u0000${trigger}`);
  }

  /** `DROP TRIGGER name` with no `ON <table>` (MySQL, SQLite): resolved by the trigger's own name and schema. */
  dropTriggerByName(schema: string, trigger: string, unqualified = false): void {
    const stores = this.removable();
    const temporaryKey = `temp\u0000${trigger}`;
    // SQLite resolves an unqualified DROP against its temporary namespace first.
    const temporary = unqualified && this.dialect === 'sqlite' &&
      stores.some((store) => [...store.values()].some((byName) => byName.has(temporaryKey)));
    const key = temporary ? temporaryKey : `${schema}\u0000${trigger}`;
    for (const store of stores) {
      for (const byName of store.values()) byName.delete(key);
    }
  }

  hasInsertTrigger(schema: string, table: string): boolean {
    const key = tableKey(schema, table);
    if (firesBeforeInsert(this.replayedTriggers.get(key))) return true;
    // Standalone triggers follow a rename made by any file, in whichever order the files were read.
    const names = new Set([key]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [from, to] of this.renamedTables) {
        if (names.has(to) && !names.has(from)) {
          names.add(from);
          grew = true;
        }
      }
    }
    for (const name of names) {
      if (firesBeforeInsert(this.standaloneTriggers.get(name))) return true;
    }
    return false;
  }

  ensureSchema(name: string, ref: SourceRef): SchemaFact {
    const existing = this.schemas.get(name);
    if (existing !== undefined) return existing;
    const created: SchemaFact = {
      name,
      tables: new Map(),
      path: ref.path,
      line: ref.line,
      sourceKind: ref.sourceKind,
    };
    this.schemas.set(name, created);
    return created;
  }

  table(schema: string, table: string): TableFact | undefined {
    return this.schemas.get(schema)?.tables.get(table);
  }

  /**
   * Gets or creates a table.
   *
   * `defining` separates "this statement declares the table" (CREATE TABLE,
   * `pgTable`, a Prisma `model`) from "this statement touches it" (ALTER, an
   * index, a comment). Only the former moves the table's recorded path, so a
   * table stays attributed to where it is defined rather than to whichever
   * migration last altered it.
   */
  ensureTable(schema: string, table: string, ref: SourceRef, defining = false): TableFact {
    const sf = this.ensureSchema(schema, ref);
    const existing = sf.tables.get(table);
    if (existing !== undefined) {
      if (defining) {
        existing.path = ref.path;
        existing.line = ref.line;
        existing.sourceKind = ref.sourceKind;
        if (ref.sourceKind !== 'sql-migration') existing.declaredIn.add(ref.path);
      }
      pushUniqueSource(existing.sources, ref.sourceKind);
      if (this.currentMigration !== null) pushUnique(existing.migrations, this.currentMigration);
      return existing;
    }
    const created: TableFact = {
      schema,
      name: table,
      columns: new Map(),
      comment: null,
      path: ref.path,
      line: ref.line,
      sourceKind: ref.sourceKind,
      sources: [ref.sourceKind],
      migrations: this.currentMigration === null ? [] : [this.currentMigration],
      checks: [],
      dialect: null,
      declaredIn: defining && ref.sourceKind !== 'sql-migration' ? new Set([ref.path]) : new Set(),
      ormNames: [],
    };
    sf.tables.set(table, created);
    return created;
  }

  /**
   * Records the dialect a table's defining or altering statement was
   * recognised as. A later statement without evidence never clears it; a later
   * `CREATE TABLE` that is recognised as something else replaces it.
   */
  setTableDialect(schema: string, table: string, dialect: string | null): void {
    const tf = this.table(schema, table);
    if (tf !== undefined) tf.dialect = dialect;
  }

  /**
   * Records the name a Prisma model or a Drizzle table binding gives an existing
   * table. The same name from the same kind of source is recorded once, so two
   * `schema.prisma` files that declare one model add one entry.
   */
  recordOrmName(schema: string, table: string, source: OrmSource, name: string): void {
    const tf = this.table(schema, table);
    if (tf === undefined) return;
    if (tf.ormNames.some((n) => n.source === source && n.name === name)) return;
    tf.ormNames.push({ source, name });
  }

  dropTable(schema: string, table: string): void {
    this.schemas.get(schema)?.tables.delete(table);
    // A dropped table takes with it the triggers this file or an earlier
    // migration created; a table of the same name created later starts with
    // none of those. A trigger another standalone file created stays: nothing
    // says that file was applied first.
    for (const store of this.removable()) store.delete(tableKey(schema, table));
  }

  /** Creates or updates a column, honouring "absent means says nothing". */
  upsertColumn(schema: string, table: string, name: string, patch: ColumnPatch, ref: SourceRef): ColumnFact {
    const tf = this.ensureTable(schema, table, ref);
    let col = tf.columns.get(name);
    const creating = col === undefined;
    if (col === undefined) {
      const seed = normalizeSqlType(patch.declaredType ?? patch.type ?? 'text', this.enumTypes);
      col = {
        schema,
        table,
        name,
        declaredType: seed.declaredType,
        type: seed.type,
        category: seed.category,
        isArray: seed.isArray,
        nullable: true,
        nullableDeclared: false,
        hasDefault: false,
        dbDefault: false,
        clientDefault: false,
        scalarList: false,
        ddlNullable: null,
        defaultExpr: null,
        isPrimaryKey: false,
        isUnique: false,
        typeModified: false,
        maxLength: seed.maxLength,
        numericPrecision: seed.numericPrecision,
        numericScale: seed.numericScale,
        checks: [],
        comment: null,
        ordinal: tf.columns.size,
        path: ref.path,
        line: ref.line,
        sourceKind: ref.sourceKind,
        sources: [],
        migrations: [],
        dialect: null,
      };
      tf.columns.set(name, col);
    }

    if (patch.declaredType !== undefined) col.declaredType = patch.declaredType;
    if (patch.type !== undefined) col.type = patch.type;
    if (patch.category !== undefined) col.category = patch.category;
    if (patch.isArray !== undefined) col.isArray = patch.isArray;
    if (patch.maxLength !== undefined) col.maxLength = patch.maxLength;
    if (patch.numericPrecision !== undefined) col.numericPrecision = patch.numericPrecision;
    if (patch.numericScale !== undefined) col.numericScale = patch.numericScale;
    if (patch.nullable !== undefined) {
      col.nullable = patch.nullable;
      col.nullableDeclared = true;
    }
    if (patch.dbDefault !== undefined) col.dbDefault = patch.dbDefault;
    if (patch.clientDefault !== undefined) col.clientDefault = patch.clientDefault;
    if (patch.scalarList !== undefined) col.scalarList = patch.scalarList;
    if (
      patch.nullable !== undefined &&
      (ref.sourceKind === 'sql' || ref.sourceKind === 'sql-migration')
    ) {
      col.ddlNullable = patch.nullable;
    }
    col.hasDefault = col.dbDefault || col.clientDefault || suppliesNullList(col);
    if (patch.defaultExpr !== undefined) col.defaultExpr = patch.defaultExpr;
    // Constraints accumulate: a later ADD CONSTRAINT never un-declares an
    // earlier one, and `DROP CONSTRAINT` is handled explicitly where supported.
    if (patch.isPrimaryKey === true) {
      col.isPrimaryKey = true;
      // A primary key column is NOT NULL whether or not the DDL says so. This
      // is the single most common source of a false X1 nullability finding.
      col.nullable = false;
      col.nullableDeclared = true;
    }
    if (patch.isUnique === true) col.isUnique = true;
    if (patch.typeModified !== undefined) col.typeModified = patch.typeModified;
    if (patch.check !== undefined) pushUnique(col.checks, patch.check);
    if (patch.comment !== undefined && patch.comment !== null) col.comment = patch.comment;
    if (patch.dialect !== undefined) col.dialect = patch.dialect;

    // A column is attributed to where it is declared, not to a later
    // `ALTER ... SET NOT NULL` that merely constrains it.
    if (creating || patch.declaredType !== undefined) {
      col.path = ref.path;
      col.line = ref.line;
      col.sourceKind = ref.sourceKind;
    }
    pushUniqueSource(col.sources, ref.sourceKind);
    if (this.currentMigration !== null) {
      pushUnique(col.migrations, this.currentMigration);
      pushUnique(tf.migrations, this.currentMigration);
    }
    return col;
  }

  dropColumn(schema: string, table: string, name: string): void {
    const tf = this.table(schema, table);
    if (tf === undefined) return;
    tf.columns.delete(name);
    if (this.currentMigration !== null) pushUnique(tf.migrations, this.currentMigration);
  }

  renameColumn(schema: string, table: string, from: string, to: string): void {
    const tf = this.table(schema, table);
    if (tf === undefined) return;
    const col = tf.columns.get(from);
    if (col === undefined) return;
    tf.columns.delete(from);
    col.name = to;
    tf.columns.set(to, col);
    if (this.currentMigration !== null) pushUnique(col.migrations, this.currentMigration);
  }

  renameTable(schema: string, from: string, to: string): void {
    const sf = this.schemas.get(schema);
    const tf = sf?.tables.get(from);
    if (sf === undefined || tf === undefined) return;
    sf.tables.delete(from);
    tf.name = to;
    for (const col of tf.columns.values()) col.table = to;
    sf.tables.set(to, tf);
    // Triggers follow their table through a rename: the ones this file or an
    // earlier migration created move with it, and the standalone ones are
    // recorded as renamed, so the answer does not depend on which file came first.
    const fromKey = tableKey(schema, from);
    const toKey = tableKey(schema, to);
    for (const store of this.removable()) {
      const moved = store.get(fromKey);
      if (moved === undefined) continue;
      store.delete(fromKey);
      store.set(toKey, moved);
    }
    this.renamedTables.push([fromKey, toKey]);
  }

  addForeignKey(fk: ForeignKeyFact): void {
    const key = (f: ForeignKeyFact): string =>
      [f.schema, f.table, f.columns.join(','), f.refSchema, f.refTable, f.refColumns.join(',')].join('\u0000');
    const k = key(fk);
    if (this.foreignKeys.some((f) => key(f) === k)) return;
    this.foreignKeys.push(fk);
  }

  registerEnumType(name: string): void {
    this.enumTypes.add(name.toLowerCase());
  }

  addMigration(m: MigrationFact): void {
    this.migrations.push(m);
  }

  note(message: string): void {
    this.diagnostics.push(message);
  }

  columnCount(): number {
    let n = 0;
    for (const sf of this.schemas.values()) {
      for (const tf of sf.tables.values()) n += tf.columns.size;
    }
    return n;
  }

  tableCount(): number {
    let n = 0;
    for (const sf of this.schemas.values()) n += sf.tables.size;
    return n;
  }
}
