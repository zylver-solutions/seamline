/**
 * SQL type normalization.
 *
 * `infer-join` has to compare a database column against a TypeScript field and
 * a JSON Schema property. `character varying(255)` is not comparable to
 * `string` and `int4` is not comparable to `integer` by string equality, so
 * every column carries three separate facts:
 *
 * - `declaredType` — exactly what the source file wrote, for the human.
 * - `type` — the canonical Postgres spelling, so `varchar(255)`,
 *   `@db.VarChar(255)` and `character varying(255)` converge on one string.
 * - `category` — the small closed vocabulary the cross-domain comparison
 *   actually runs on.
 *
 * `other` is deliberate: a category that lies is worse than one that abstains,
 * because a wrong category manufactures an X2 type contradiction out of a type
 * this extractor simply does not model (bytea, interval, geometry, ...).
 */

/** Closed vocabulary for cross-domain type comparison (design v3 §5, X2/X3). */
export const TYPE_CATEGORIES = [
  'integer',
  'text',
  'boolean',
  'timestamp',
  'numeric',
  'json',
  'uuid',
  'enum',
  'other',
] as const;
export type TypeCategory = (typeof TYPE_CATEGORIES)[number];

export interface NormalizedType {
  /** Source text as written, whitespace-collapsed and lower-cased. */
  readonly declaredType: string;
  /** Canonical Postgres spelling, including parameters. */
  readonly type: string;
  readonly category: TypeCategory;
  readonly isArray: boolean;
  readonly maxLength: number | null;
  readonly numericPrecision: number | null;
  readonly numericScale: number | null;
  /** True when the base type carries an implicit sequence default (serial). */
  readonly implicitDefault: boolean;
}

/** Alias -> canonical Postgres base type. */
const BASE_ALIASES: Readonly<Record<string, string>> = {
  int: 'integer',
  int4: 'integer',
  integer: 'integer',
  int2: 'smallint',
  smallint: 'smallint',
  int8: 'bigint',
  bigint: 'bigint',
  serial: 'integer',
  serial4: 'integer',
  smallserial: 'smallint',
  serial2: 'smallint',
  bigserial: 'bigint',
  serial8: 'bigint',
  bool: 'boolean',
  boolean: 'boolean',
  varchar: 'character varying',
  'character varying': 'character varying',
  char: 'character',
  bpchar: 'character',
  character: 'character',
  text: 'text',
  citext: 'citext',
  name: 'text',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'jsonb',
  numeric: 'numeric',
  decimal: 'numeric',
  money: 'money',
  real: 'real',
  float4: 'real',
  float: 'double precision',
  float8: 'double precision',
  'double precision': 'double precision',
  timestamp: 'timestamp without time zone',
  'timestamp without time zone': 'timestamp without time zone',
  timestamptz: 'timestamp with time zone',
  'timestamp with time zone': 'timestamp with time zone',
  date: 'date',
  time: 'time without time zone',
  'time without time zone': 'time without time zone',
  timetz: 'time with time zone',
  'time with time zone': 'time with time zone',
  interval: 'interval',
  bytea: 'bytea',
  inet: 'inet',
  cidr: 'cidr',
  macaddr: 'macaddr',
  macaddr8: 'macaddr8',
  xml: 'xml',
  tsvector: 'tsvector',
  tsquery: 'tsquery',
  bit: 'bit',
  'bit varying': 'bit varying',
  varbit: 'bit varying',
  point: 'point',
  line: 'line',
  polygon: 'polygon',
  circle: 'circle',
  box: 'box',
  path: 'path',
  lseg: 'lseg',
  int4range: 'int4range',
  int8range: 'int8range',
  numrange: 'numrange',
  tstzrange: 'tstzrange',
  daterange: 'daterange',
  oid: 'oid',
  regclass: 'regclass',
  'pg_lsn': 'pg_lsn',
  hstore: 'hstore',
  vector: 'vector',
};

const CATEGORY_BY_BASE: Readonly<Record<string, TypeCategory>> = {
  smallint: 'integer',
  integer: 'integer',
  bigint: 'integer',
  oid: 'integer',
  numeric: 'numeric',
  real: 'numeric',
  'double precision': 'numeric',
  money: 'numeric',
  boolean: 'boolean',
  'character varying': 'text',
  character: 'text',
  text: 'text',
  citext: 'text',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'json',
  hstore: 'json',
  'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamp',
  date: 'timestamp',
  'time without time zone': 'timestamp',
  'time with time zone': 'timestamp',
};

/** Base types whose declaration implies a sequence-backed default. */
const SERIAL_TYPES: ReadonlySet<string> = new Set([
  'serial',
  'serial2',
  'serial4',
  'serial8',
  'smallserial',
  'bigserial',
]);

/**
 * Multi-word base types, longest first so `timestamp with time zone` is
 * matched before `timestamp`.
 */
const MULTIWORD_BASES: readonly string[] = [
  'timestamp without time zone',
  'timestamp with time zone',
  'time without time zone',
  'time with time zone',
  'character varying',
  'double precision',
  'bit varying',
];

function parseParams(raw: string): number[] {
  return raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Renders the canonical spelling, keeping the parameter next to the base word
 * for the split types Postgres itself writes as `timestamp(3) with time zone`.
 */
function renderCanonical(base: string, params: readonly number[]): string {
  if (params.length === 0) return base;
  const rendered = `(${params.join(',')})`;
  const split = base.indexOf(' with');
  const splitAlt = base.indexOf(' without');
  const at = split >= 0 ? split : splitAlt;
  if (at > 0) return `${base.slice(0, at)}${rendered}${base.slice(at)}`;
  return `${base}${rendered}`;
}

/**
 * Normalizes one SQL type expression.
 *
 * `enumTypes` carries the `CREATE TYPE ... AS ENUM` / `pgEnum` / Prisma `enum`
 * names seen in the same repo, which is the only way a user-defined type can
 * be told apart from an unmodelled built-in.
 */
export function normalizeSqlType(raw: string, enumTypes: ReadonlySet<string> = new Set()): NormalizedType {
  const declaredType = raw.replace(/\s+/gu, ' ').trim().toLowerCase();
  let work = declaredType;

  let isArray = false;
  // `int[]`, `int[3]`, `int array`, `int array[4]`
  for (;;) {
    const trimmed = work.replace(/\s*\[\s*\d*\s*\]\s*$/u, '');
    if (trimmed !== work) {
      isArray = true;
      work = trimmed;
      continue;
    }
    const noArrayWord = work.replace(/\s+array$/u, '');
    if (noArrayWord !== work) {
      isArray = true;
      work = noArrayWord;
      continue;
    }
    break;
  }

  // Strip a schema qualifier: `public.user_role` -> `user_role`.
  work = work.replace(/^[a-z0-9_]+\.(?=[a-z_"])/u, '');
  work = work.replace(/"/gu, '');

  let params: number[] = [];
  const paren = /\(([^()]*)\)/u.exec(work);
  if (paren !== null) {
    params = parseParams(paren[1] ?? '');
    work = `${work.slice(0, paren.index)} ${work.slice(paren.index + paren[0].length)}`.replace(/\s+/gu, ' ').trim();
  }

  let baseRaw = work;
  for (const mw of MULTIWORD_BASES) {
    if (work === mw) {
      baseRaw = mw;
      break;
    }
  }

  const base = BASE_ALIASES[baseRaw] ?? baseRaw;
  const implicitDefault = SERIAL_TYPES.has(baseRaw);

  let category: TypeCategory;
  if (enumTypes.has(baseRaw)) category = 'enum';
  else category = CATEGORY_BY_BASE[base] ?? 'other';

  const first = params[0] ?? null;
  const second = params[1] ?? null;
  const isCharType = base === 'character varying' || base === 'character' || base === 'bit' || base === 'bit varying';
  const isNumericType = base === 'numeric';

  const canonical = renderCanonical(base, params);
  return {
    declaredType,
    type: isArray ? `${canonical}[]` : canonical,
    category,
    isArray,
    maxLength: isCharType ? first : null,
    numericPrecision: isNumericType ? first : null,
    numericScale: isNumericType ? second : null,
    implicitDefault,
  };
}
