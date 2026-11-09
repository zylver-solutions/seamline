/**
 * ClickHouse dialect support for the SQL DDL reader.
 *
 * Standard SQL makes a column nullable unless it says `NOT NULL`. ClickHouse is
 * the opposite: a column is NOT NULL unless its type is `Nullable(T)`, and an
 * insert that omits a column stores the type's default value instead of
 * failing. Reading ClickHouse DDL with the standard-SQL default therefore turns
 * every plain `session_id UUID` into a column that "permits NULL", and every
 * detector that compares nullability reports a contradiction that is not there.
 *
 * Nothing here guesses. A statement is read as ClickHouse only when it carries
 * evidence that cannot occur in Postgres, MySQL or SQLite DDL:
 *
 * - a `CREATE TABLE` whose `ENGINE` is a ClickHouse table engine, spelled the
 *   way ClickHouse spells it (`MergeTree`, `ReplacingMergeTree`, `Memory`, ...);
 * - `ON CLUSTER <name>` after the table name;
 * - a column type built from a ClickHouse-only constructor (`Nullable(...)`,
 *   `LowCardinality(...)`, `AggregateFunction(...)`, `DateTime64(...)`, `Map(...)`,
 *   `UInt32`, `Float64`, `Array(String)`, ...), spelled exactly as ClickHouse does;
 * - an `ALTER TABLE` on a table an earlier statement already established as
 *   ClickHouse.
 *
 * A statement with no such evidence is read exactly as before. An `ENGINE`
 * that names a known non-ClickHouse engine (`InnoDB`, `MyISAM`, ...) rules the
 * statement out even if something else in it looked like ClickHouse.
 */

import { type Tok, collapseWs, kw, spanRaw } from '@seamline/core/sql';
import type { NormalizedType, TypeCategory } from './normalize-type.ts';

/** The dialect name recorded on a node whose statement was recognised as ClickHouse. */
export const CLICKHOUSE = 'clickhouse';

/** Why a statement was read as ClickHouse. Carried for tests and diagnostics. */
export type ClickHouseEvidence =
  'configured' | 'engine' | 'on-cluster' | 'column-type' | 'known-table';

export interface DialectVerdict {
  readonly clickhouse: boolean;
  readonly evidence: ClickHouseEvidence | null;
}

export const NOT_CLICKHOUSE: DialectVerdict = Object.freeze({ clickhouse: false, evidence: null });

/**
 * `defaultExpr` recorded for a ClickHouse column that declares no default of
 * its own. Omitting such a column from an INSERT does not fail: ClickHouse
 * stores the type's default value (0, the empty string, the epoch, ...).
 */
export const CLICKHOUSE_TYPE_DEFAULT = 'type default';

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

/**
 * Table engines that exist in ClickHouse and in no other supported dialect.
 * Matched case-sensitively, as ClickHouse itself resolves engine names, so the
 * MySQL storage engine `MEMORY` is not mistaken for ClickHouse's `Memory`.
 */
const CLICKHOUSE_ENGINES: ReadonlySet<string> = new Set([
  'Log',
  'TinyLog',
  'StripeLog',
  'Memory',
  'Distributed',
  'Buffer',
  'Dictionary',
  'Join',
  'Set',
  'Merge',
  'Null',
  'URL',
  'File',
  'S3',
  'S3Queue',
  'HDFS',
  'Kafka',
  'RabbitMQ',
  'NATS',
  'Executable',
  'ExecutablePool',
  'GenerateRandom',
  'KeeperMap',
  'EmbeddedRocksDB',
  'PostgreSQL',
  'MySQL',
  'MongoDB',
  'Redis',
  'SQLite',
  'ODBC',
  'JDBC',
]);

const MERGE_TREE_FAMILY =
  /^(?:Replicated|Shared)?(?:Replacing|Summing|Aggregating|Collapsing|VersionedCollapsing|Graphite|Coalescing)?MergeTree$/u;

/** Storage engines of MySQL and MariaDB. An `ENGINE` naming one rules ClickHouse out. */
const OTHER_DIALECT_ENGINES: ReadonlySet<string> = new Set([
  'innodb',
  'myisam',
  'memory',
  'heap',
  'csv',
  'archive',
  'blackhole',
  'federated',
  'ndb',
  'ndbcluster',
  'merge',
  'mrg_myisam',
  'aria',
  'columnstore',
  'spider',
  'rocksdb',
  'tokudb',
  'connect',
  'sequence',
  'example',
  'mroonga',
  'oqgraph',
  'sphinx',
  'performance_schema',
]);

export function isClickHouseEngine(name: string): boolean {
  return CLICKHOUSE_ENGINES.has(name) || MERGE_TREE_FAMILY.test(name);
}

/** Names the engine in a `CREATE TABLE` tail (`ENGINE [=] Name[(...)]`), as written. */
export function readEngineName(tail: readonly Tok[]): string | null {
  for (let i = 0; i < tail.length; i += 1) {
    if (kw(tail, i) !== 'ENGINE') continue;
    let j = i + 1;
    const eq = tail[j];
    if (eq !== undefined && eq.t === 'punct' && eq.v === '=') j += 1;
    const name = tail[j];
    return name !== undefined && name.t === 'word' ? name.raw : null;
  }
  return null;
}

const CONSTRUCTOR_EVIDENCE =
  /\b(?:Nullable|LowCardinality|AggregateFunction|SimpleAggregateFunction|DateTime64|FixedString|Enum8|Enum16|Map|Tuple|Nested|Variant|Decimal(?:32|64|128|256))\s*\(/u;
const SCALAR_EVIDENCE =
  /\b(?:UInt(?:8|16|32|64|128|256)|Int(?:16|32|64|128|256)|Float(?:32|64)|IPv[46]|Date32)\b/u;
const ARRAY_OF_CLICKHOUSE_TYPE =
  /\bArray\s*\(\s*(?:Nullable|LowCardinality|Array|String|UUID|Date|DateTime|Int8|Bool|Decimal|AggregateFunction|SimpleAggregateFunction|DateTime64|FixedString|Enum8|Enum16|Map|Tuple|Nested|Variant|Decimal(?:32|64|128|256)|UInt(?:8|16|32|64|128|256)|Int(?:16|32|64|128|256)|Float(?:32|64)|IPv[46]|Date32)\b/u;
const DATETIME_WITH_ZONE = /\bDateTime\s*\(\s*'/u;
const STRING_LITERAL = /'(?:[^'\\]|\\.|'')*'/gu;

/**
 * True when a column's type text uses a ClickHouse-only spelling. Matching is
 * case-sensitive on purpose: `Int64` is ClickHouse, `int8` is Postgres, and
 * `INT` is neither. `Int8`, `Bool`, `Date` and `UUID` alone prove nothing.
 */
export function hasClickHouseTypeEvidence(typeSource: string): boolean {
  if (DATETIME_WITH_ZONE.test(typeSource)) return true;
  const bare = typeSource.replace(STRING_LITERAL, "''");
  return (
    CONSTRUCTOR_EVIDENCE.test(bare) ||
    SCALAR_EVIDENCE.test(bare) ||
    ARRAY_OF_CLICKHOUSE_TYPE.test(bare)
  );
}

export interface CreateTableEvidence {
  /** `ON CLUSTER` followed the table name. */
  readonly onCluster: boolean;
  /** Tokens after the column list (or after the name when there is no list). */
  readonly tail: readonly Tok[];
  /** Source text of every column's type. */
  readonly typeSources: readonly string[];
}

/** Decides the dialect of one `CREATE TABLE` statement from its own text. */
export function detectCreateTableDialect(e: CreateTableEvidence): DialectVerdict {
  const engine = readEngineName(e.tail);
  if (engine !== null) {
    if (isClickHouseEngine(engine)) return { clickhouse: true, evidence: 'engine' };
    if (OTHER_DIALECT_ENGINES.has(engine.toLowerCase())) return NOT_CLICKHOUSE;
  }
  if (e.onCluster) return { clickhouse: true, evidence: 'on-cluster' };
  if (e.typeSources.some(hasClickHouseTypeEvidence))
    return { clickhouse: true, evidence: 'column-type' };
  return NOT_CLICKHOUSE;
}

/* ------------------------------------------------------------------ *
 * Type normalization
 * ------------------------------------------------------------------ */

export interface ClickHouseType extends NormalizedType {
  /** True only for `Nullable(T)`, bare or inside `LowCardinality(...)`. */
  readonly nullable: boolean;
}

interface TypeExpr {
  readonly name: string;
  readonly args: readonly string[] | null;
}

/** Splits `(a, b(c, d), 'e,f')` into its top-level arguments, or null when unbalanced. */
function splitArgs(s: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] as string;
    if (c === "'") {
      cur += c;
      i += 1;
      while (i < s.length) {
        const d = s[i] as string;
        cur += d;
        if (d === '\\') {
          i += 1;
          cur += s[i] ?? '';
        } else if (d === "'") {
          if (s[i + 1] === "'") {
            i += 1;
            cur += "'";
          } else {
            break;
          }
        }
        i += 1;
      }
      continue;
    }
    if (c === '(') {
      depth += 1;
      if (depth === 1) continue;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        out.push(cur.trim());
        return out;
      }
    } else if (c === ',' && depth === 1) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  return null;
}

function parseTypeExpr(src: string): TypeExpr {
  const s = src.trim();
  const m = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(s);
  if (m === null) return { name: '', args: null };
  const name = m[0];
  const rest = s.slice(name.length).trimStart();
  if (!rest.startsWith('(')) return { name, args: null };
  return { name, args: splitArgs(rest) };
}

/** Strips `Nullable(...)` and `LowCardinality(...)`, recording whether `Nullable` was seen. */
function unwrap(expr: TypeExpr): { expr: TypeExpr; nullable: boolean } {
  let cur = expr;
  let nullable = false;
  for (let depth = 0; depth < 8; depth += 1) {
    const lname = cur.name.toLowerCase();
    if (
      (lname === 'nullable' || lname === 'lowcardinality') &&
      cur.args !== null &&
      cur.args.length === 1
    ) {
      if (lname === 'nullable') nullable = true;
      cur = parseTypeExpr(cur.args[0] as string);
      continue;
    }
    break;
  }
  return { expr: cur, nullable };
}

interface Shape {
  readonly type: string;
  readonly category: TypeCategory;
  readonly isArray: boolean;
  readonly maxLength: number | null;
  readonly numericPrecision: number | null;
  readonly numericScale: number | null;
}

function shape(type: string, category: TypeCategory, extra: Partial<Shape> = {}): Shape {
  return {
    type,
    category,
    isArray: false,
    maxLength: null,
    numericPrecision: null,
    numericScale: null,
    ...extra,
  };
}

/** Scalar ClickHouse type names (lower-cased) and the canonical spelling they converge on. */
const SCALARS: Readonly<Record<string, readonly [string, TypeCategory]>> = {
  string: ['text', 'text'],
  text: ['text', 'text'],
  tinytext: ['text', 'text'],
  mediumtext: ['text', 'text'],
  longtext: ['text', 'text'],
  varchar: ['text', 'text'],
  varchar2: ['text', 'text'],
  char: ['text', 'text'],
  character: ['text', 'text'],
  nchar: ['text', 'text'],
  nvarchar: ['text', 'text'],
  clob: ['text', 'text'],
  blob: ['text', 'text'],
  tinyblob: ['text', 'text'],
  mediumblob: ['text', 'text'],
  longblob: ['text', 'text'],
  bytea: ['text', 'text'],
  uuid: ['uuid', 'uuid'],
  bool: ['boolean', 'boolean'],
  boolean: ['boolean', 'boolean'],
  int8: ['smallint', 'integer'],
  uint8: ['smallint', 'integer'],
  int16: ['smallint', 'integer'],
  uint16: ['smallint', 'integer'],
  tinyint: ['smallint', 'integer'],
  smallint: ['smallint', 'integer'],
  int1: ['smallint', 'integer'],
  byte: ['smallint', 'integer'],
  short: ['smallint', 'integer'],
  int32: ['integer', 'integer'],
  uint32: ['integer', 'integer'],
  int: ['integer', 'integer'],
  integer: ['integer', 'integer'],
  mediumint: ['integer', 'integer'],
  int64: ['bigint', 'integer'],
  uint64: ['bigint', 'integer'],
  int128: ['bigint', 'integer'],
  uint128: ['bigint', 'integer'],
  int256: ['bigint', 'integer'],
  uint256: ['bigint', 'integer'],
  bigint: ['bigint', 'integer'],
  float32: ['real', 'numeric'],
  float: ['real', 'numeric'],
  real: ['real', 'numeric'],
  float64: ['double precision', 'numeric'],
  double: ['double precision', 'numeric'],
  date: ['date', 'timestamp'],
  date32: ['date', 'timestamp'],
  time: ['time without time zone', 'timestamp'],
  json: ['json', 'json'],
  object: ['json', 'json'],
  ipv4: ['inet', 'other'],
  ipv6: ['inet', 'other'],
  enum: ['enum', 'enum'],
  enum8: ['enum', 'enum'],
  enum16: ['enum', 'enum'],
};

/** Decimal32..256 are fixed-precision decimals whose only argument is the scale. */
const DECIMAL_PRECISION: Readonly<Record<string, number>> = {
  decimal32: 9,
  decimal64: 18,
  decimal128: 38,
  decimal256: 76,
};

function toInt(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function isQuoted(s: string | undefined): boolean {
  return s !== undefined && s.trim().startsWith("'");
}

function classify(expr: TypeExpr): Shape {
  const lname = expr.name.toLowerCase();
  const args = expr.args ?? [];

  if (lname === 'array' && expr.args !== null && args.length === 1) {
    const inner = classify(unwrap(parseTypeExpr(args[0] as string)).expr);
    return { ...inner, isArray: true, type: inner.isArray ? inner.type : `${inner.type}[]` };
  }

  if (lname === 'fixedstring' || lname === 'binary') {
    const n = toInt(args[0]);
    return shape(n === null ? 'character' : `character(${n})`, 'text', { maxLength: n });
  }

  if (lname === 'decimal' || lname === 'dec' || lname === 'numeric' || lname === 'fixed') {
    const p = toInt(args[0]);
    const s = args.length > 1 ? toInt(args[1]) : p === null ? null : 0;
    const type = p === null ? 'numeric' : s === null ? `numeric(${p})` : `numeric(${p},${s})`;
    return shape(type, 'numeric', { numericPrecision: p, numericScale: s });
  }
  const fixedPrecision = DECIMAL_PRECISION[lname];
  if (fixedPrecision !== undefined) {
    const s = toInt(args[0]);
    return shape(s === null ? 'numeric' : `numeric(${fixedPrecision},${s})`, 'numeric', {
      numericPrecision: fixedPrecision,
      numericScale: s,
    });
  }

  if (lname === 'datetime' || lname === 'timestamp') {
    return shape(
      isQuoted(args[0]) ? 'timestamp with time zone' : 'timestamp without time zone',
      'timestamp',
    );
  }
  if (lname === 'datetime64') {
    return shape(
      isQuoted(args[1]) ? 'timestamp with time zone' : 'timestamp without time zone',
      'timestamp',
    );
  }

  const scalar = SCALARS[lname];
  if (scalar !== undefined) return shape(scalar[0], scalar[1]);

  // Aggregate-state, composite, geometric and unrecognised types: the category
  // abstains (`other`) and the canonical type is only the constructor's name, so
  // no comparison downstream can treat the column as any scalar type.
  return shape(lname.length > 0 ? lname : 'unknown', 'other');
}

/**
 * Normalizes one ClickHouse type expression.
 *
 * `Nullable(T)` is the only thing that makes a column nullable, so `nullable`
 * is read from the wrappers and the rest of the type is normalized without
 * them: `LowCardinality(Nullable(String))` is a nullable text column,
 * `DateTime64(3)` a timestamp, `UUID` a uuid. `AggregateFunction(...)` and
 * `SimpleAggregateFunction(...)` normalize to the `other` category, which every
 * type comparison skips.
 */
export function normalizeClickHouseType(raw: string): ClickHouseType {
  const declaredType = raw.replace(/\s+/gu, ' ').trim().toLowerCase();
  const { expr, nullable } = unwrap(parseTypeExpr(raw));
  return { declaredType, ...classify(expr), implicitDefault: false, nullable };
}

/* ------------------------------------------------------------------ *
 * Column tails
 * ------------------------------------------------------------------ */

/** Words that begin a column definition's tail rather than naming its type. */
const NO_TYPE_START: ReadonlySet<string> = new Set([
  'DEFAULT',
  'MATERIALIZED',
  'ALIAS',
  'EPHEMERAL',
  'CODEC',
  'COMMENT',
  'TTL',
  'REMOVE',
  'MODIFY',
  'RESET',
  'SETTINGS',
  'STATISTICS',
  'AFTER',
  'FIRST',
]);

/** True when the token after a column's name starts the tail, so the column declares no type. */
export function columnHasNoTypeToken(defToks: readonly Tok[]): boolean {
  const first = kw(defToks, 1);
  return defToks.length < 2 || (first !== null && NO_TYPE_START.has(first));
}

const DEFAULT_KINDS: ReadonlySet<string> = new Set([
  'DEFAULT',
  'MATERIALIZED',
  'ALIAS',
  'EPHEMERAL',
]);

export type ClickHouseDefaultKind = 'DEFAULT' | 'MATERIALIZED' | 'ALIAS' | 'EPHEMERAL';

export interface ClickHouseColumnTail {
  /** An explicit `NULL` modifier followed the type. */
  readonly explicitNull: boolean;
  readonly defaultKind: ClickHouseDefaultKind | null;
  readonly defaultExpr: string | null;
  readonly comment: string | null;
}

/** Words that end a default expression. `NULL` and `NOT` can occur inside one, so they do not. */
function endsExpression(toks: readonly Tok[], i: number): boolean {
  const w = kw(toks, i);
  if (w === null) return false;
  switch (w) {
    case 'CODEC':
    case 'COMMENT':
    case 'TTL':
    case 'STATISTICS':
    case 'SETTINGS':
    case 'REMOVE':
    case 'MODIFY':
    case 'RESET':
      return true;
    case 'PRIMARY':
      return kw(toks, i + 1) === 'KEY';
    case 'AFTER':
      return toks[i + 1]?.t === 'word';
    case 'FIRST':
      return i === toks.length - 1;
    default:
      return false;
  }
}

/** Reads what follows a ClickHouse column's type: nullability modifier, default, comment. */
export function readClickHouseColumnTail(
  text: string,
  toks: readonly Tok[],
  from: number,
): ClickHouseColumnTail {
  let explicitNull = false;
  let defaultKind: ClickHouseDefaultKind | null = null;
  let defaultExpr: string | null = null;
  let comment: string | null = null;
  let i = from;
  while (i < toks.length) {
    const w = kw(toks, i);
    if (w === 'NOT' && kw(toks, i + 1) === 'NULL') {
      i += 2;
      continue;
    }
    if (w === 'NULL') {
      explicitNull = true;
      i += 1;
      continue;
    }
    if (w !== null && DEFAULT_KINDS.has(w)) {
      const start = i + 1;
      let end = start;
      while (end < toks.length && !endsExpression(toks, end)) end += 1;
      defaultKind = w as ClickHouseDefaultKind;
      defaultExpr = end > start ? collapseWs(spanRaw(text, toks.slice(start, end))) : null;
      i = end;
      continue;
    }
    if (w === 'COMMENT') {
      const lit = toks[i + 1];
      if (lit !== undefined && lit.t === 'str') comment = lit.v;
      i += 2;
      continue;
    }
    i += 1;
  }
  return { explicitNull, defaultKind, defaultExpr, comment };
}

/* ------------------------------------------------------------------ *
 * Items inside a column list that are not columns
 * ------------------------------------------------------------------ */

/**
 * True for the entries of a ClickHouse column list that declare something other
 * than a column: `INDEX name expr TYPE t GRANULARITY n` and
 * `PROJECTION name (SELECT ...)`. Both are recognised by their own required
 * syntax, so a column that merely happens to be called `index` is not skipped.
 */
export function isClickHouseNonColumnItem(part: readonly Tok[]): boolean {
  const head = kw(part, 0);
  if (head === 'INDEX') return part.some((_, k) => kw(part, k) === 'TYPE');
  if (head === 'PROJECTION') {
    return part.some((t) => t.t === 'group' && t.v === '(' && kw(t.items, 0) === 'SELECT');
  }
  return false;
}

/** True for an `ALTER TABLE` action that adds an index or projection (ClickHouse syntax). */
export function isClickHouseIndexAction(action: readonly Tok[]): boolean {
  if (kw(action, 0) !== 'ADD') return false;
  const what = kw(action, 1);
  if (what === 'PROJECTION') return true;
  if (what === 'INDEX') return action.some((_, k) => kw(action, k) === 'TYPE');
  return false;
}
