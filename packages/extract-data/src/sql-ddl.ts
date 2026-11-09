/**
 * Focused Postgres DDL parser, with a ClickHouse reading for statements that
 * carry ClickHouse-only evidence (see `clickhouse.ts`).
 *
 * It covers exactly the statement forms design v3 §6 names as this
 * extractor's input — `CREATE TABLE`, `ALTER TABLE`, constraints, indexes,
 * `CREATE TYPE ... AS ENUM`, `COMMENT ON`, `DROP` — and deliberately ignores
 * everything else rather than failing on it. A migration file is mostly DML,
 * grants, and function bodies; refusing to parse a file because it contains a
 * `GRANT` would turn a normal repo into an `UNAVAILABLE` scope.
 */

import {
  type Tok,
  collapseWs,
  group,
  ident,
  isGroup,
  isPunct,
  kw,
  makeLineIndex,
  matchKw,
  spanRaw,
  splitOn,
  splitStatements,
  tokenizeSql,
  type SqlStatement,
} from '@seamline/core/sql';
import { normalizeSqlType } from './normalize-type.ts';
import {
  CLICKHOUSE,
  CLICKHOUSE_TYPE_DEFAULT,
  type DialectVerdict,
  columnHasNoTypeToken,
  detectCreateTableDialect,
  hasClickHouseTypeEvidence,
  isClickHouseIndexAction,
  isClickHouseNonColumnItem,
  normalizeClickHouseType,
  readClickHouseColumnTail,
} from './clickhouse.ts';
import type { ColumnPatch, SchemaModel, SourceKind, SourceRef } from './model.ts';

/** Words that may continue a multi-word type name. */
const TYPE_CONTINUATION: ReadonlySet<string> = new Set(['VARYING', 'PRECISION', 'ZONE', 'LOCAL', 'ARRAY']);

/** Words that end a type expression and begin a column constraint. */
const CONSTRAINT_START: ReadonlySet<string> = new Set([
  'NOT',
  'NULL',
  'DEFAULT',
  'PRIMARY',
  'UNIQUE',
  'REFERENCES',
  'CHECK',
  'CONSTRAINT',
  'COLLATE',
  'GENERATED',
  'DEFERRABLE',
  'INITIALLY',
  'STORED',
  'VIRTUAL',
  'NO',
  'MATCH',
  'ON',
  'AUTO_INCREMENT',
  'AUTOINCREMENT',
]);

/** Words that begin a table-level constraint inside a CREATE TABLE body. */
const TABLE_CONSTRAINT_START: ReadonlySet<string> = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'FOREIGN',
  'CHECK',
  'EXCLUDE',
  'LIKE',
]);

interface Qualified {
  readonly schema: string | null;
  readonly name: string;
  readonly next: number;
}

/** Reads `a`, `a.b` or `a.b.c`, keeping the last two parts. */
function readQualified(toks: readonly Tok[], i: number): Qualified | null {
  const parts: string[] = [];
  let j = i;
  for (;;) {
    const v = ident(toks, j);
    if (v === null) break;
    parts.push(v);
    j += 1;
    const dot = toks[j];
    if (dot !== undefined && dot.t === 'punct' && dot.v === '.') {
      j += 1;
      continue;
    }
    break;
  }
  if (parts.length === 0) return null;
  const name = parts[parts.length - 1] as string;
  const schema = parts.length >= 2 ? (parts[parts.length - 2] as string) : null;
  return { schema, name, next: j };
}

interface TypeRead {
  readonly text: string;
  readonly next: number;
}

/** Consumes one type expression, including multi-word and array forms. */
function readType(toks: readonly Tok[], i: number): TypeRead | null {
  const first = ident(toks, i);
  if (first === null) return null;
  let text = first;
  let j = i + 1;

  // Schema-qualified user type: `public.user_role`.
  const dot = toks[j];
  if (dot !== undefined && dot.t === 'punct' && dot.v === '.') {
    const second = ident(toks, j + 1);
    if (second !== null) {
      text = `${text}.${second}`;
      j += 2;
    }
  }

  for (;;) {
    if (isGroup(toks, j, '(')) {
      const g = toks[j] as Tok;
      text += `(${collapseWs(g.raw.slice(1, -1))})`;
      j += 1;
      continue;
    }
    if (isGroup(toks, j, '[')) {
      text += '[]';
      j += 1;
      continue;
    }
    const word = kw(toks, j);
    if (word !== null && TYPE_CONTINUATION.has(word)) {
      text += ` ${(toks[j] as Tok).v}`;
      j += 1;
      continue;
    }
    if ((word === 'WITH' || word === 'WITHOUT') && kw(toks, j + 1) === 'TIME') {
      text += ` ${word.toLowerCase()} time`;
      j += 2;
      continue;
    }
    break;
  }
  return { text, next: j };
}

interface ColumnConstraints {
  nullable: boolean | null;
  hasDefault: boolean;
  defaultExpr: string | null;
  /** `AUTO_INCREMENT` (MySQL) or `AUTOINCREMENT` (SQLite), spelled as written, lower-cased. */
  autoIncrement: string | null;
  /** `PRIMARY KEY DESC`, which SQLite does not treat as a rowid alias. */
  primaryKeyDesc: boolean;
  /** An explicit `ON UPDATE` attribute (MySQL), which switches off the implicit TIMESTAMP default. */
  onUpdate: boolean;
  /** `UNSIGNED`, `SIGNED` or `ZEROFILL` after the type: SQLite no longer reads the type as exactly `INTEGER`. */
  typeModifier: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  checks: string[];
  references: { schema: string | null; table: string; column: string | null; onDelete: string | null; onUpdate: string | null; name: string | null } | null;
}

function emptyConstraints(): ColumnConstraints {
  return {
    nullable: null,
    hasDefault: false,
    defaultExpr: null,
    autoIncrement: null,
    primaryKeyDesc: false,
    onUpdate: false,
    typeModifier: false,
    isPrimaryKey: false,
    isUnique: false,
    checks: [],
    references: null,
  };
}

function readReferentialAction(toks: readonly Tok[], i: number): { action: string; next: number } | null {
  const a = kw(toks, i);
  if (a === null) return null;
  if (a === 'NO' && kw(toks, i + 1) === 'ACTION') return { action: 'NO ACTION', next: i + 2 };
  if (a === 'SET' && (kw(toks, i + 1) === 'NULL' || kw(toks, i + 1) === 'DEFAULT')) {
    return { action: `SET ${kw(toks, i + 1) as string}`, next: i + 2 };
  }
  if (a === 'CASCADE' || a === 'RESTRICT') return { action: a, next: i + 1 };
  return null;
}

/** Parses the constraint tail of a column definition. */
function readColumnConstraints(text: string, toks: readonly Tok[], from: number): ColumnConstraints {
  const out = emptyConstraints();
  let i = from;
  let pendingName: string | null = null;

  while (i < toks.length) {
    const word = kw(toks, i);
    if (word === null) {
      i += 1;
      continue;
    }

    if (word === 'CONSTRAINT') {
      pendingName = ident(toks, i + 1);
      i += 2;
      continue;
    }
    if (word === 'NOT' && kw(toks, i + 1) === 'NULL') {
      out.nullable = false;
      i += 2;
      continue;
    }
    if (word === 'NULL') {
      out.nullable = true;
      i += 1;
      continue;
    }
    if (word === 'PRIMARY' && kw(toks, i + 1) === 'KEY') {
      out.isPrimaryKey = true;
      out.primaryKeyDesc = kw(toks, i + 2) === 'DESC';
      i += 2;
      continue;
    }
    if (word === 'AUTO_INCREMENT' || word === 'AUTOINCREMENT') {
      out.autoIncrement = word.toLowerCase();
      i += 1;
      continue;
    }
    if (word === 'ON' && kw(toks, i + 1) === 'UPDATE') {
      out.onUpdate = true;
      i += 2;
      continue;
    }
    if (word === 'UNSIGNED' || word === 'SIGNED' || word === 'ZEROFILL') {
      out.typeModifier = true;
      i += 1;
      continue;
    }
    if (word === 'UNIQUE') {
      out.isUnique = true;
      i += 1;
      if (kw(toks, i) === 'NULLS') i += kw(toks, i + 1) === 'NOT' ? 3 : 2;
      continue;
    }
    if (word === 'DEFAULT') {
      const start = i + 1;
      let end = start;
      while (end < toks.length) {
        const w = kw(toks, end);
        if (end > start && w !== null && CONSTRAINT_START.has(w)) break;
        end += 1;
      }
      out.hasDefault = true;
      out.defaultExpr = collapseWs(spanRaw(text, toks.slice(start, end)));
      i = end;
      continue;
    }
    if (word === 'GENERATED') {
      out.hasDefault = true;
      // `GENERATED ALWAYS AS IDENTITY` and `... BY DEFAULT AS IDENTITY` are
      // both implicitly NOT NULL in Postgres.
      let j = i + 1;
      while (j < toks.length && kw(toks, j) !== 'AS') j += 1;
      if (kw(toks, j + 1) === 'IDENTITY') {
        out.nullable = false;
        j += 2;
      } else if (isGroup(toks, j + 1, '(')) {
        out.defaultExpr = collapseWs((toks[j + 1] as Tok).raw.slice(1, -1));
        j += 2;
      }
      i = j;
      continue;
    }
    if (word === 'CHECK') {
      const g = group(toks, i + 1, '(');
      if (g !== null) out.checks.push(collapseWs(g.raw));
      i += 2;
      continue;
    }
    if (word === 'REFERENCES') {
      const q = readQualified(toks, i + 1);
      if (q === null) {
        i += 1;
        continue;
      }
      let j = q.next;
      let refColumn: string | null = null;
      const g = group(toks, j, '(');
      if (g !== null) {
        refColumn = g.items.length > 0 ? ((g.items[0] as Tok).v) : null;
        j += 1;
      }
      let onDelete: string | null = null;
      let onUpdate: string | null = null;
      while (kw(toks, j) === 'ON') {
        const which = kw(toks, j + 1);
        const act = readReferentialAction(toks, j + 2);
        if (act === null) {
          j += 2;
          break;
        }
        if (which === 'DELETE') onDelete = act.action;
        if (which === 'UPDATE') onUpdate = act.action;
        j = act.next;
      }
      out.references = {
        schema: q.schema,
        table: q.name,
        column: refColumn,
        onDelete,
        onUpdate,
        name: pendingName,
      };
      pendingName = null;
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Collects every identifier in an expression that names a column of `known`. */
function referencedColumns(toks: readonly Tok[], known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (list: readonly Tok[]): void => {
    for (const t of list) {
      if (t.t === 'group') {
        walk(t.items);
        continue;
      }
      if (t.t === 'word' && known.has(t.v) && !out.includes(t.v)) out.push(t.v);
    }
  };
  walk(toks);
  return out;
}

interface Ctx {
  readonly model: SchemaModel;
  readonly text: string;
  readonly path: string;
  readonly sourceKind: SourceKind;
  readonly lineOf: (pos: number) => number;
  /** The caller configured the ClickHouse dialect, so every statement is read as ClickHouse. */
  readonly configuredClickHouse: boolean;
}

function refAt(ctx: Ctx, pos: number): SourceRef {
  return { path: ctx.path, line: ctx.lineOf(pos), sourceKind: ctx.sourceKind };
}

/** What the surrounding statement says about a column that its own text does not. */
interface ColumnDefOptions {
  /** SQLite `WITHOUT ROWID` table: its `INTEGER PRIMARY KEY` is an ordinary key. */
  readonly withoutRowid?: boolean;
  /** MySQL: no TIMESTAMP column precedes this one in the table, so it is the only one eligible for the implicit default. */
  readonly firstTimestamp?: boolean;
}

function isMysqlDialect(dialect: string): boolean {
  return dialect === 'mysql' || dialect === 'mariadb';
}

/** `TIMESTAMP` and `TIMESTAMP(n)`, but not the Postgres `timestamp with time zone`. */
function isPlainTimestamp(declaredType: string): boolean {
  return /^timestamp(\(\d+\))?$/u.test(declaredType);
}

/**
 * The database-side default a column has without writing `DEFAULT`, as the
 * label stored in `defaultExpr`, or null when it has none.
 *
 * - `AUTO_INCREMENT` (MySQL) and `AUTOINCREMENT` (SQLite) are spelled out.
 * - SQLite: a column declared exactly `INTEGER` and made the primary key is an
 *   alias for the rowid and takes the next one when omitted. `INT` and
 *   `BIGINT` are not aliases, nor is `INTEGER UNSIGNED` or `INTEGER(10)`, which
 *   SQLite reads as other declared types; inline `INTEGER PRIMARY KEY DESC`
 *   is not, though table-level `PRIMARY KEY (id DESC)` is. Neither is the key
 *   of a `WITHOUT ROWID` table. In Postgres or MySQL the same text is
 *   an ordinary key with no default, hence the dialect gate.
 * - The MySQL rule below is applied to `CREATE TABLE` only: a column added by
 *   `ALTER TABLE ... ADD COLUMN` does not get it.
 * - MySQL: with `explicit_defaults_for_timestamp` off (the pre-8.0 server
 *   setting, still common in dumps), the first TIMESTAMP column of a table that
 *   is declared `NOT NULL` with no `DEFAULT` and no `ON UPDATE` is silently
 *   given `DEFAULT CURRENT_TIMESTAMP`. Treating it as defaulted is the
 *   precision-safe reading when the setting is on instead.
 */
function implicitDefaultExpr(
  declaredType: string,
  cons: ColumnConstraints,
  ctx: Ctx,
  opts: ColumnDefOptions,
): string | null {
  if (cons.autoIncrement !== null) return cons.autoIncrement;
  if (
    ctx.model.dialect === 'sqlite' &&
    cons.isPrimaryKey &&
    !cons.primaryKeyDesc &&
    !cons.typeModifier &&
    opts.withoutRowid !== true &&
    declaredType === 'integer'
  ) {
    return 'rowid';
  }
  if (
    isMysqlDialect(ctx.model.dialect) &&
    opts.firstTimestamp === true &&
    isPlainTimestamp(declaredType) &&
    cons.nullable === false &&
    !cons.hasDefault &&
    !cons.onUpdate
  ) {
    return 'current_timestamp';
  }
  return null;
}

function buildPatch(typeText: string, cons: ColumnConstraints, ctx: Ctx, opts: ColumnDefOptions): ColumnPatch {
  const n = normalizeSqlType(typeText, ctx.model.enumTypes);
  const patch: ColumnPatch = {
    declaredType: n.declaredType,
    type: n.type,
    category: n.category,
    isArray: n.isArray,
    maxLength: n.maxLength,
    numericPrecision: n.numericPrecision,
    numericScale: n.numericScale,
    // A statement without ClickHouse evidence declares no dialect, which also
    // clears one an earlier ClickHouse statement recorded for the same column.
    dialect: null,
  };
  if (cons.nullable !== null) patch.nullable = cons.nullable;
  const implicit = implicitDefaultExpr(n.declaredType, cons, ctx, opts);
  if (cons.hasDefault || n.implicitDefault || implicit !== null) {
    // Every SQL form here is supplied by the database to every writer.
    patch.dbDefault = true;
    patch.defaultExpr = cons.defaultExpr ?? (n.implicitDefault ? 'nextval()' : implicit);
  }
  patch.typeModified = cons.typeModifier;
  if (cons.isPrimaryKey) patch.isPrimaryKey = true;
  if (cons.isUnique) patch.isUnique = true;
  return patch;
}

/**
 * Applies one column definition (shared by CREATE TABLE and ADD COLUMN).
 *
 * @returns whether the column is a plain `TIMESTAMP`, so the caller can tell
 *   which column is the table's first one.
 */
function applyColumnDef(
  ctx: Ctx,
  schema: string,
  table: string,
  defToks: readonly Tok[],
  clickhouse = false,
  opts: ColumnDefOptions = {},
): boolean {
  if (clickhouse) {
    applyClickHouseColumnDef(ctx, schema, table, defToks, 'define');
    return false;
  }
  const name = ident(defToks, 0);
  if (name === null) return false;
  const typeRead = readType(defToks, 1);
  if (typeRead === null) return false;
  const cons = readColumnConstraints(ctx.text, defToks, typeRead.next);
  const ref = refAt(ctx, (defToks[0] as Tok).pos);
  const patch = buildPatch(typeRead.text, cons, ctx, opts);
  if (ctx.model.table(schema, table)?.columns.get(name)?.dialect === CLICKHOUSE) {
    // This statement has no ClickHouse evidence yet redeclares a column an
    // earlier ClickHouse statement declared. What that statement implied about
    // nullability and defaults no longer holds, so restate both the standard-SQL way.
    if (patch.nullable === undefined) patch.nullable = true;
    if (patch.dbDefault === undefined) {
      patch.dbDefault = false;
      patch.defaultExpr = null;
    }
  }
  ctx.model.upsertColumn(schema, table, name, patch, ref);
  for (const c of cons.checks) {
    ctx.model.upsertColumn(schema, table, name, { check: c }, ref);
  }
  if (cons.references !== null) {
    const r = cons.references;
    ctx.model.addForeignKey({
      name: r.name,
      schema,
      table,
      columns: [name],
      refSchema: r.schema ?? ctx.model.defaultSchema,
      refTable: r.table,
      refColumns: r.column === null ? [] : [r.column],
      onDelete: r.onDelete,
      onUpdate: r.onUpdate,
      path: ctx.path,
      line: ref.line,
    });
  }
  return isPlainTimestamp(patch.declaredType ?? '');
}

/**
 * Source text of the type in a column definition, or null when the definition
 * names no type (ClickHouse allows `col ALIAS expr`, whose type is inferred).
 */
function columnTypeSource(text: string, defToks: readonly Tok[]): { source: string; next: number } | null {
  if (columnHasNoTypeToken(defToks)) return null;
  const read = readType(defToks, 1);
  if (read === null) return null;
  return { source: collapseWs(spanRaw(text, defToks.slice(1, read.next))), next: read.next };
}

/**
 * Applies one ClickHouse column definition (CREATE TABLE, ADD COLUMN, MODIFY COLUMN).
 *
 * A column is nullable exactly when its type is `Nullable(T)`; the type is
 * normalized without that wrapper so type comparisons see the underlying type.
 * A column that declares no default of its own still has one: omitting it from
 * an INSERT stores the type's default value, so it is recorded as defaulted.
 */
function applyClickHouseColumnDef(
  ctx: Ctx,
  schema: string,
  table: string,
  defToks: readonly Tok[],
  mode: 'define' | 'modify',
): void {
  const name = ident(defToks, 0);
  if (name === null) return;
  const typed = columnTypeSource(ctx.text, defToks);
  const tail = readClickHouseColumnTail(ctx.text, defToks, typed === null ? 1 : typed.next);
  const ref = refAt(ctx, (defToks[0] as Tok).pos);
  const existing = ctx.model.table(schema, table)?.columns.get(name);

  // Without a declared type the column's nullability is unknown, and a column
  // whose nullability is unknown must not be asserted as either.
  if (typed === null && (mode === 'define' || existing === undefined)) {
    ctx.model.note(`clickhouse column ${schema}.${table}.${name} declares no type; not extracted`);
    return;
  }

  const patch: ColumnPatch = { dialect: CLICKHOUSE };
  let nullable: boolean | null = null;
  if (typed !== null) {
    const n = normalizeClickHouseType(typed.source);
    nullable = n.nullable || tail.explicitNull;
    patch.declaredType = n.declaredType;
    patch.type = n.type;
    patch.category = n.category;
    patch.isArray = n.isArray;
    patch.maxLength = n.maxLength;
    patch.numericPrecision = n.numericPrecision;
    patch.numericScale = n.numericScale;
    patch.nullable = nullable;
  }
  if (tail.comment !== null) patch.comment = tail.comment;

  if (tail.defaultKind !== null) {
    // DEFAULT, MATERIALIZED, ALIAS and EPHEMERAL all supply the value, so none
    // of them is a column an insert is required to name. MATERIALIZED and
    // ALIAS columns cannot be inserted into at all. Every ClickHouse default is
    // the server's, so each of them is a database-side default.
    patch.dbDefault = true;
    patch.defaultExpr = tail.defaultExpr;
  } else if (typed !== null) {
    const keepsExplicit =
      mode === 'modify' &&
      existing !== undefined &&
      existing.hasDefault &&
      existing.defaultExpr !== null &&
      existing.defaultExpr !== CLICKHOUSE_TYPE_DEFAULT;
    if (!keepsExplicit) {
      patch.dbDefault = nullable !== true;
      patch.defaultExpr = nullable === true ? null : CLICKHOUSE_TYPE_DEFAULT;
    }
  }
  ctx.model.upsertColumn(schema, table, name, patch, ref);
}

/** Applies one table-level constraint (shared by CREATE TABLE and ADD CONSTRAINT). */
function applyTableConstraint(
  ctx: Ctx,
  schema: string,
  table: string,
  toks: readonly Tok[],
  withoutRowid = false,
): void {
  let i = 0;
  let name: string | null = null;
  if (kw(toks, 0) === 'CONSTRAINT') {
    name = ident(toks, 1);
    i = 2;
  }
  const head = kw(toks, i);
  const pos = (toks[0] as Tok).pos;
  const ref = refAt(ctx, pos);

  if (head === 'PRIMARY' && kw(toks, i + 1) === 'KEY') {
    const g = group(toks, i + 2, '(');
    if (g === null) return;
    const items = splitOn(g.items, ',');
    const cols = items.map((c) => ident(c, 0)).filter((c): c is string => c !== null);
    for (const c of cols) {
      // A composite key does not make its member columns individually unique,
      // but every member is NOT NULL.
      ctx.model.upsertColumn(schema, table, c, { isPrimaryKey: true }, ref);
      if (cols.length === 1) ctx.model.upsertColumn(schema, table, c, { isUnique: true }, ref);
    }
    // A single INTEGER column made the key by a table constraint is the rowid
    // alias exactly as `id INTEGER PRIMARY KEY` is (see `implicitDefaultExpr`),
    // including `PRIMARY KEY (id DESC)`: only the inline DESC spelling is excluded.
    const only = cols.length === 1 ? (cols[0] as string) : null;
    const col = only === null ? undefined : ctx.model.table(schema, table)?.columns.get(only);
    if (
      ctx.model.dialect === 'sqlite' &&
      !withoutRowid &&
      col !== undefined &&
      !col.hasDefault &&
      col.declaredType === 'integer' &&
      !col.typeModified
    ) {
      ctx.model.upsertColumn(schema, table, col.name, { dbDefault: true, defaultExpr: 'rowid' }, ref);
    }
    return;
  }

  if (head === 'UNIQUE') {
    const g = group(toks, i + 1, '(') ?? group(toks, i + 2, '(');
    if (g === null) return;
    const cols = splitOn(g.items, ',').map((c) => ident(c, 0)).filter((c): c is string => c !== null);
    if (cols.length === 1) ctx.model.upsertColumn(schema, table, cols[0] as string, { isUnique: true }, ref);
    return;
  }

  if (head === 'FOREIGN' && kw(toks, i + 1) === 'KEY') {
    const g = group(toks, i + 2, '(');
    if (g === null) return;
    const cols = splitOn(g.items, ',').map((c) => ident(c, 0)).filter((c): c is string => c !== null);
    let j = i + 3;
    if (kw(toks, j) !== 'REFERENCES') return;
    const q = readQualified(toks, j + 1);
    if (q === null) return;
    j = q.next;
    const rg = group(toks, j, '(');
    const refCols = rg === null ? [] : splitOn(rg.items, ',').map((c) => ident(c, 0)).filter((c): c is string => c !== null);
    if (rg !== null) j += 1;
    let onDelete: string | null = null;
    let onUpdate: string | null = null;
    while (kw(toks, j) === 'ON') {
      const which = kw(toks, j + 1);
      const act = readReferentialAction(toks, j + 2);
      if (act === null) break;
      if (which === 'DELETE') onDelete = act.action;
      if (which === 'UPDATE') onUpdate = act.action;
      j = act.next;
    }
    ctx.model.addForeignKey({
      name,
      schema,
      table,
      columns: cols,
      refSchema: q.schema ?? ctx.model.defaultSchema,
      refTable: q.name,
      refColumns: refCols,
      onDelete,
      onUpdate,
      path: ctx.path,
      line: ref.line,
    });
    return;
  }

  if (head === 'CHECK') {
    const g = group(toks, i + 1, '(');
    if (g === null) return;
    const tf = ctx.model.table(schema, table);
    const expr = collapseWs(g.raw);
    if (tf === undefined) return;
    const cols = referencedColumns(g.items, new Set(tf.columns.keys()));
    if (cols.length === 1) {
      ctx.model.upsertColumn(schema, table, cols[0] as string, { check: expr }, ref);
    } else if (!tf.checks.includes(expr)) {
      tf.checks.push(expr);
    }
  }
}

function applyCreateTable(ctx: Ctx, st: SqlStatement): void {
  const toks = st.toks;
  let i = 1;
  while (['GLOBAL', 'LOCAL', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'FOREIGN'].includes(kw(toks, i) ?? '')) i += 1;
  if (kw(toks, i) !== 'TABLE') return;
  i += 1;
  if (matchKw(toks, i, ['IF', 'NOT', 'EXISTS'])) i += 3;
  const q = readQualified(toks, i);
  if (q === null) return;
  const schema = q.schema ?? ctx.model.defaultSchema;
  // `ON CLUSTER <name>` sits between the table name and the column list, and
  // exists only in ClickHouse.
  let bodyAt = q.next;
  const onCluster = kw(toks, bodyAt) === 'ON' && kw(toks, bodyAt + 1) === 'CLUSTER';
  if (onCluster) bodyAt += 3;
  const body = group(toks, bodyAt, '(');
  const ref = refAt(ctx, st.pos);
  ctx.model.ensureTable(schema, q.name, ref, true);

  const parts = body === null ? [] : splitOn(body.items, ',');
  const columnParts = parts.filter((part) => {
    const head = kw(part, 0);
    return !(head !== null && TABLE_CONSTRAINT_START.has(head)) && !isClickHouseNonColumnItem(part);
  });
  const typeSources: string[] = [];
  for (const part of columnParts) {
    const typed = columnTypeSource(ctx.text, part);
    if (typed !== null) typeSources.push(typed.source);
  }
  const verdict: DialectVerdict = ctx.configuredClickHouse
    ? { clickhouse: true, evidence: 'configured' }
    : detectCreateTableDialect({
        onCluster,
        tail: toks.slice(body === null ? bodyAt : bodyAt + 1),
        typeSources,
      });
  ctx.model.setTableDialect(schema, q.name, verdict.clickhouse ? CLICKHOUSE : null);
  if (body === null) return;

  const withoutRowid = toks
    .slice(bodyAt + 1)
    .some((_, k, rest) => kw(rest, k) === 'WITHOUT' && kw(rest, k + 1) === 'ROWID');
  const constraintParts: Tok[][] = [];
  // MySQL gives the implicit TIMESTAMP default to the first TIMESTAMP column
  // only, whether or not that column ends up eligible.
  let firstTimestamp = true;
  for (const part of parts) {
    const head = kw(part, 0);
    if (verdict.clickhouse && isClickHouseNonColumnItem(part)) continue;
    if (head !== null && TABLE_CONSTRAINT_START.has(head)) {
      constraintParts.push(part);
      continue;
    }
    const isTimestamp = applyColumnDef(ctx, schema, q.name, part, verdict.clickhouse, {
      withoutRowid,
      firstTimestamp,
    });
    if (isTimestamp) firstTimestamp = false;
  }
  // Table constraints are applied after every column exists, so a CHECK can be
  // attributed to the column it names.
  for (const part of constraintParts) applyTableConstraint(ctx, schema, q.name, part, withoutRowid);
}

function applyAlterTable(ctx: Ctx, st: SqlStatement): void {
  const toks = st.toks;
  let i = 1;
  if (kw(toks, i) !== 'TABLE') return;
  i += 1;
  if (matchKw(toks, i, ['IF', 'EXISTS'])) i += 2;
  if (kw(toks, i) === 'ONLY') i += 1;
  const q = readQualified(toks, i);
  if (q === null) return;
  const schema = q.schema ?? ctx.model.defaultSchema;
  const table = q.name;
  const ref = refAt(ctx, st.pos);

  // `ON CLUSTER <name>` follows the table name and exists only in ClickHouse.
  let actionsAt = q.next;
  const onCluster = kw(toks, actionsAt) === 'ON' && kw(toks, actionsAt + 1) === 'CLUSTER';
  if (onCluster) actionsAt += 3;
  const knownClickHouse =
    ctx.configuredClickHouse || onCluster || ctx.model.table(schema, table)?.dialect === CLICKHOUSE;

  for (const action of splitOn(toks.slice(actionsAt), ',')) {
    const head = kw(action, 0);
    if (head === null) continue;

    // An action is read as ClickHouse when the statement already is, or when
    // the action itself uses a ClickHouse-only spelling. The table is then
    // recorded as ClickHouse so later statements about it inherit the reading.
    const addsOrModifiesColumn = head === 'ADD' || (head === 'MODIFY' && kw(action, 1) === 'COLUMN');
    let clickhouse = knownClickHouse;
    if (!clickhouse && addsOrModifiesColumn) {
      if (isClickHouseIndexAction(action)) {
        clickhouse = true;
      } else {
        let k = 1;
        if (kw(action, k) === 'COLUMN') k += 1;
        if (matchKw(action, k, ['IF', 'NOT', 'EXISTS'])) k += 3;
        const typed = columnTypeSource(ctx.text, action.slice(k));
        clickhouse = typed !== null && hasClickHouseTypeEvidence(typed.source);
      }
    }
    if (clickhouse && addsOrModifiesColumn && !knownClickHouse) {
      ctx.model.ensureTable(schema, table, ref);
      ctx.model.setTableDialect(schema, table, CLICKHOUSE);
    }

    if (clickhouse && head === 'ADD' && isClickHouseIndexAction(action)) {
      // A projection or skipping index alters the table but declares no column.
      ctx.model.ensureTable(schema, table, ref);
      continue;
    }

    if (clickhouse && head === 'MODIFY') {
      if (kw(action, 1) !== 'COLUMN') continue;
      let j = 2;
      if (matchKw(action, j, ['IF', 'EXISTS'])) j += 2;
      applyClickHouseColumnDef(ctx, schema, table, action.slice(j), 'modify');
      continue;
    }

    if (head === 'ADD') {
      let j = 1;
      if (kw(action, j) === 'COLUMN') j += 1;
      if (matchKw(action, j, ['IF', 'NOT', 'EXISTS'])) j += 3;
      const next = kw(action, j);
      if (j === 1 && next !== null && TABLE_CONSTRAINT_START.has(next)) {
        ctx.model.ensureTable(schema, table, ref);
        applyTableConstraint(ctx, schema, table, action.slice(j));
      } else {
        ctx.model.ensureTable(schema, table, ref);
        applyColumnDef(ctx, schema, table, action.slice(j), clickhouse);
      }
      continue;
    }

    if (head === 'ALTER') {
      let j = 1;
      if (kw(action, j) === 'COLUMN') j += 1;
      const col = ident(action, j);
      if (col === null) continue;
      j += 1;
      const verb = kw(action, j);
      if (verb === 'SET' && matchKw(action, j + 1, ['NOT', 'NULL'])) {
        ctx.model.upsertColumn(schema, table, col, { nullable: false }, ref);
      } else if (verb === 'DROP' && matchKw(action, j + 1, ['NOT', 'NULL'])) {
        ctx.model.upsertColumn(schema, table, col, { nullable: true }, ref);
      } else if (verb === 'SET' && kw(action, j + 1) === 'DEFAULT') {
        const expr = collapseWs(spanRaw(ctx.text, action.slice(j + 2)));
        ctx.model.upsertColumn(schema, table, col, { dbDefault: true, defaultExpr: expr }, ref);
      } else if (verb === 'DROP' && kw(action, j + 1) === 'DEFAULT') {
        ctx.model.upsertColumn(schema, table, col, { dbDefault: false, defaultExpr: null }, ref);
      } else if (verb === 'ADD' && kw(action, j + 1) === 'GENERATED') {
        // `ADD GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [(sequence options)]`: how
        // `pg_dump` writes an identity column for PostgreSQL 10 and later, after a
        // `CREATE TABLE` that left the column a plain `NOT NULL` one. It is the same
        // sequence-backed default as the `CREATE TABLE ... GENERATED` spelling.
        ctx.model.upsertColumn(schema, table, col, { dbDefault: true, defaultExpr: null }, ref);
      } else if (verb === 'DROP' && kw(action, j + 1) === 'IDENTITY') {
        // `DROP IDENTITY [IF EXISTS]` leaves a plain column behind.
        ctx.model.upsertColumn(schema, table, col, { dbDefault: false, defaultExpr: null }, ref);
      } else if (verb === 'TYPE' || (verb === 'SET' && kw(action, j + 1) === 'DATA')) {
        const typeAt = verb === 'TYPE' ? j + 1 : j + 3;
        const t = readType(action, typeAt);
        if (t !== null) {
          const n = normalizeSqlType(t.text, ctx.model.enumTypes);
          ctx.model.upsertColumn(
            schema,
            table,
            col,
            {
              declaredType: n.declaredType,
              type: n.type,
              category: n.category,
              isArray: n.isArray,
              typeModified: false,
              maxLength: n.maxLength,
              numericPrecision: n.numericPrecision,
              numericScale: n.numericScale,
            },
            ref,
          );
        }
      }
      continue;
    }

    if (head === 'DROP') {
      let j = 1;
      if (kw(action, j) === 'COLUMN') j += 1;
      if (matchKw(action, j, ['IF', 'EXISTS'])) j += 2;
      if (kw(action, 1) === 'CONSTRAINT') continue;
      const col = ident(action, j);
      if (col !== null) ctx.model.dropColumn(schema, table, col);
      continue;
    }

    if (head === 'RENAME') {
      let j = 1;
      if (kw(action, j) === 'COLUMN') j += 1;
      if (kw(action, j) === 'TO') {
        const to = ident(action, j + 1);
        if (to !== null) ctx.model.renameTable(schema, table, to);
        continue;
      }
      const from = ident(action, j);
      if (from !== null && kw(action, j + 1) === 'TO') {
        const to = ident(action, j + 2);
        if (to !== null) ctx.model.renameColumn(schema, table, from, to);
      }
      continue;
    }
  }
}

function applyCreateIndex(ctx: Ctx, st: SqlStatement): void {
  const toks = st.toks;
  let i = 1;
  const unique = kw(toks, i) === 'UNIQUE';
  if (unique) i += 1;
  if (kw(toks, i) !== 'INDEX') return;
  i += 1;
  if (kw(toks, i) === 'CONCURRENTLY') i += 1;
  if (matchKw(toks, i, ['IF', 'NOT', 'EXISTS'])) i += 3;
  if (kw(toks, i) !== 'ON') {
    const named = readQualified(toks, i);
    if (named === null) return;
    i = named.next;
  }
  if (kw(toks, i) !== 'ON') return;
  i += 1;
  if (kw(toks, i) === 'ONLY') i += 1;
  const q = readQualified(toks, i);
  if (q === null) return;
  i = q.next;
  if (kw(toks, i) === 'USING') i += 2;
  const g = group(toks, i, '(');
  if (g === null) return;
  // A partial index constrains only the rows matching its predicate, so it is
  // not evidence the column is unique.
  const rest = toks.slice(i + 1);
  if (rest.some((t) => t.t === 'word' && !t.quoted && t.v === 'where')) return;
  if (!unique) return;
  const cols = splitOn(g.items, ',').map((c) => ident(c, 0)).filter((c): c is string => c !== null);
  if (cols.length !== 1) return;
  const schema = q.schema ?? ctx.model.defaultSchema;
  const tf = ctx.model.table(schema, q.name);
  if (tf === undefined || !tf.columns.has(cols[0] as string)) return;
  ctx.model.upsertColumn(schema, q.name, cols[0] as string, { isUnique: true }, refAt(ctx, st.pos));
}

function applyComment(ctx: Ctx, st: SqlStatement): void {
  const toks = st.toks;
  if (kw(toks, 1) !== 'ON') return;
  const what = kw(toks, 2);
  const q = readQualified(toks, 3);
  if (q === null) return;
  let isIdx = q.next;
  while (isIdx < toks.length && kw(toks, isIdx) !== 'IS') isIdx += 1;
  const lit = toks[isIdx + 1];
  const value = lit !== undefined && lit.t === 'str' ? lit.v : null;
  if (value === null) return;

  if (what === 'COLUMN') {
    // `COMMENT ON COLUMN` needs three parts; readQualified keeps only two.
    const parts: string[] = [];
    let j = 3;
    for (;;) {
      const v = ident(toks, j);
      if (v === null) break;
      parts.push(v);
      j += 1;
      const dot = toks[j];
      if (dot !== undefined && dot.t === 'punct' && dot.v === '.') {
        j += 1;
        continue;
      }
      break;
    }
    if (parts.length < 2) return;
    const col = parts[parts.length - 1] as string;
    const table = parts[parts.length - 2] as string;
    const schema = parts.length >= 3 ? (parts[parts.length - 3] as string) : ctx.model.defaultSchema;
    const tf = ctx.model.table(schema, table);
    if (tf === undefined || !tf.columns.has(col)) return;
    ctx.model.upsertColumn(schema, table, col, { comment: value }, refAt(ctx, st.pos));
    return;
  }

  if (what === 'TABLE') {
    const schema = q.schema ?? ctx.model.defaultSchema;
    const tf = ctx.model.table(schema, q.name);
    if (tf !== undefined) tf.comment = value;
  }
}

function applyCreateType(ctx: Ctx, st: SqlStatement): void {
  const toks = st.toks;
  if (kw(toks, 1) !== 'TYPE') return;
  const q = readQualified(toks, 2);
  if (q === null) return;
  if (kw(toks, q.next) === 'AS' && kw(toks, q.next + 1) === 'ENUM') {
    ctx.model.registerEnumType(q.name);
  }
}

function applyDropTable(ctx: Ctx, st: SqlStatement): void {
  const toks = st.toks;
  if (kw(toks, 1) !== 'TABLE') return;
  let i = 2;
  if (matchKw(toks, i, ['IF', 'EXISTS'])) i += 2;
  for (const part of splitOn(toks.slice(i), ',')) {
    const q = readQualified(part, 0);
    if (q === null) continue;
    ctx.model.dropTable(q.schema ?? ctx.model.defaultSchema, q.name);
  }
}

export interface ApplySqlOptions {
  /**
   * The caller configured the ClickHouse dialect for this repository, so every
   * statement is read under ClickHouse rules without needing statement-level
   * evidence. Left unset, each statement is judged on its own evidence.
   */
  readonly clickhouse?: boolean;
}

/** One MySQL account component in a DEFINER clause, including its quoted forms. */
function definerAccountPart(toks: readonly Tok[], at: number): number | null {
  const token = toks[at];
  if (token?.t === 'word' || token?.t === 'str') return at + 1;
  if (token?.t !== 'punct' || token.v !== '`') return null;
  for (let i = at + 1; i < toks.length; i += 1) {
    if (!isPunct(toks, i, '`')) continue;
    if (isPunct(toks, i + 1, '`')) {
      i += 1;
      continue;
    }
    return i + 1;
  }
  return null;
}

/**
 * Read only the CREATE prefix, never another object's name or body. DEFINER
 * accounts may themselves be keywords such as USER, ROLE, TABLE or TRIGGER.
 */
function triggerKeyword(toks: readonly Tok[]): number | null {
  let at = 1;
  if (matchKw(toks, at, ['OR', 'REPLACE'])) at += 2;
  if (['TEMP', 'TEMPORARY', 'CONSTRAINT'].includes(kw(toks, at) ?? '')) at += 1;
  if (kw(toks, at) === 'DEFINER') {
    if (!isPunct(toks, at + 1, '=')) return null;
    at += 2;
    const currentUser = kw(toks, at) === 'CURRENT_USER';
    const accountEnd = definerAccountPart(toks, at);
    if (accountEnd === null) return null;
    at = accountEnd;
    if (isPunct(toks, at, '@')) {
      const hostEnd = definerAccountPart(toks, at + 1);
      if (hostEnd === null) return null;
      at = hostEnd;
    } else if (currentUser && group(toks, at, '(')?.items.length === 0) {
      at += 1;
    }
  }
  return kw(toks, at) === 'TRIGGER' ? at : null;
}

/**
 * Applies a `CREATE TRIGGER` statement.
 *
 * Only the timing and the events matter: a BEFORE INSERT trigger may assign a
 * column of the new row, so it can supply a value no writer names. An AFTER or
 * INSTEAD OF trigger cannot, and is recorded as such so a `CREATE OR REPLACE`
 * that swaps one for the other leaves the table's answer correct.
 *
 * @returns whether the statement is a `CREATE TRIGGER` at all.
 */
function applyCreateTrigger(ctx: Ctx, st: SqlStatement): boolean {
  const toks = st.toks;
  const at = triggerKeyword(toks);
  if (at === null) return false;

  let j = at + 1;
  const ifNotExists = matchKw(toks, j, ['IF', 'NOT', 'EXISTS']);
  if (ifNotExists) j += 3;
  const name = readQualified(toks, j);
  if (name === null) {
    ctx.model.unresolvedTriggers += 1;
    return true;
  }
  j = name.next;

  let timing: 'BEFORE' | 'OTHER' | null = null;
  const t = kw(toks, j);
  if (t === 'BEFORE') {
    timing = 'BEFORE';
    j += 1;
  } else if (t === 'AFTER') {
    timing = 'OTHER';
    j += 1;
  } else if (t === 'INSTEAD' && kw(toks, j + 1) === 'OF') {
    timing = 'OTHER';
    j += 2;
  }

  // Events run up to `ON <table>`: `INSERT`, `UPDATE [OF col, ...]`, `DELETE`,
  // `TRUNCATE`, joined by `OR`. The columns of `UPDATE OF` are not events.
  let insert = false;
  let inColumnList = false;
  let on = -1;
  for (; j < toks.length; j += 1) {
    const word = kw(toks, j);
    if (word === 'ON') {
      on = j;
      break;
    }
    if (word === 'OR') inColumnList = false;
    else if (word === 'OF') inColumnList = true;
    else if (!inColumnList && word === 'INSERT') insert = true;
  }
  const table = on < 0 ? null : readQualified(toks, on + 1);
  // A timing this reader does not know is not evidence that the trigger cannot
  // set a column; an AFTER or INSTEAD OF trigger needs no table to be ruled out.
  if (table === null || timing === null) {
    if (timing !== 'OTHER') ctx.model.unresolvedTriggers += 1;
    return true;
  }
  const modifierAt = matchKw(toks, 1, ['OR', 'REPLACE']) ? 3 : 1;
  const temporary = ['TEMP', 'TEMPORARY'].includes(kw(toks, modifierAt) ?? '');
  ctx.model.recordTrigger(
    table.schema ?? ctx.model.defaultSchema,
    table.name,
    name.name,
    timing === 'BEFORE' && insert,
    ifNotExists,
    name.schema ?? (temporary ? 'temp' : table.schema ?? ctx.model.defaultSchema),
  );
  return true;
}

/**
 * `DROP TRIGGER [IF EXISTS] name ON [schema.]table` (Postgres, which names the
 * table) and `DROP TRIGGER [IF EXISTS] [schema.]name` (MySQL and SQLite, where a
 * trigger name is unique in its schema and so identifies the trigger alone).
 */
function applyDropTrigger(ctx: Ctx, st: SqlStatement): void {
  const toks = st.toks;
  if (kw(toks, 1) !== 'TRIGGER') return;
  let i = 2;
  if (matchKw(toks, i, ['IF', 'EXISTS'])) i += 2;
  const name = readQualified(toks, i);
  if (name === null) return;
  if (kw(toks, name.next) !== 'ON') {
    ctx.model.dropTriggerByName(name.schema ?? ctx.model.defaultSchema, name.name, name.schema === null);
    return;
  }
  const table = readQualified(toks, name.next + 1);
  if (table === null) return;
  ctx.model.dropTrigger(table.schema ?? ctx.model.defaultSchema, table.name, name.name, name.schema ?? table.schema ?? ctx.model.defaultSchema);
}

/**
 * A trigger the lexer cannot see: the text mentions `trigger` and also uses a
 * construct that hides statements from it. mysqldump wraps `CREATE TRIGGER` in
 * version comments (`/*!50003 ... *\/`), which the lexer reads as comments, and
 * `DELIMITER` redefines where a statement ends, which turns a whole block into
 * one dollar-quoted token. Neither is parsed, so neither may count as "no
 * trigger".
 */
function hidesTrigger(text: string): boolean {
  if (!/\btrigger\b/iu.test(text)) return false;
  return /\/\*!/u.test(text) || /^[ \t]*delimiter\s/imu.test(text);
}

/** A statement that names DDL, inside the text of a `DO` block or an `EXECUTE`. */
const DDL_WORD = /\b(?:create|alter|drop)\b/iu;

/**
 * Applies every recognized statement in one SQL file to the model.
 *
 * @returns the number of statements the file contained.
 */
export function applySqlFile(
  model: SchemaModel,
  text: string,
  path: string,
  sourceKind: SourceKind,
  options: ApplySqlOptions = {},
): number {
  const statements = splitStatements(tokenizeSql(text));
  const ctx: Ctx = {
    model,
    text,
    path,
    sourceKind,
    lineOf: makeLineIndex(text),
    configuredClickHouse: options.clickhouse === true,
  };
  if (hidesTrigger(text)) model.hiddenTriggers += 1;
  model.beginTriggerFile(sourceKind);

  // Enum types first: a column referencing one must normalize to `enum` even
  // when the CREATE TYPE sits below it in the same file.
  for (const st of statements) {
    if (kw(st.toks, 0) === 'CREATE') applyCreateType(ctx, st);
  }

  for (const st of statements) {
    const head = kw(st.toks, 0);
    if (head === 'CREATE') {
      const second = kw(st.toks, 1);
      if (second === 'SCHEMA') {
        let i = 2;
        if (matchKw(st.toks, i, ['IF', 'NOT', 'EXISTS'])) i += 3;
        const name = ident(st.toks, i);
        if (name !== null && kw(st.toks, i) !== 'AUTHORIZATION') {
          model.ensureSchema(name, refAt(ctx, st.pos));
        }
        continue;
      }
      if (second === 'INDEX' || second === 'UNIQUE') {
        applyCreateIndex(ctx, st);
        continue;
      }
      if (applyCreateTrigger(ctx, st)) continue;
      applyCreateTable(ctx, st);
      continue;
    }
    // A `DO` block or an `EXECUTE` of a prepared string runs DDL this parser
    // cannot see, so the schema it replays is incomplete. Every one in a
    // migration counts. In any other file (a schema snapshot, a seed) only one
    // whose own text names `CREATE`, `ALTER` or `DROP` does: a data load in a
    // `DO` block runs no DDL, and a repository-wide count must not be raised by it.
    if (head === 'DO' || head === 'EXECUTE' || head === 'EXEC') {
      if (sourceKind === 'sql-migration' || DDL_WORD.test(st.toks.map((t) => t.raw).join(' '))) {
        model.dynamicDdl += 1;
      }
      continue;
    }
    if (head === 'ALTER') {
      applyAlterTable(ctx, st);
      continue;
    }
    if (head === 'COMMENT') {
      applyComment(ctx, st);
      continue;
    }
    if (head === 'DROP') {
      if (kw(st.toks, 1) === 'TRIGGER') applyDropTrigger(ctx, st);
      else applyDropTable(ctx, st);
      continue;
    }
  }
  model.endTriggerFile();
  return statements.length;
}
