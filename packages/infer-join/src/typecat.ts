/**
 * Normalized type categories and the compatibility relation between them.
 *
 * The three extractors speak three different type languages (SQL DDL,
 * TypeScript, JSON Schema). They are expected to emit a normalized category on
 * the node; this module normalizes whatever they emit into the same closed set
 * and, critically, defines what *disagreement* means.
 *
 * The design constraint that shapes this file (v3 §5, X2): a type disagreement
 * must never block a join. If a column and a field agree on name and container
 * but disagree on type, that pair is exactly the fact X2_TYPE exists to report.
 * Suppressing the edge would suppress the finding. So `compareTypes` returns a
 * verdict, and the scorer turns a `conflict` into *no positive evidence* rather
 * than a veto.
 */

export const TYPE_CATEGORIES = [
  'integer', 'text', 'boolean', 'timestamp', 'numeric', 'json', 'uuid', 'enum', 'unknown',
] as const;
export type TypeCategory = (typeof TYPE_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(TYPE_CATEGORIES);

/**
 * Raw type spelling to category. Covers SQL DDL, TypeScript and JSON Schema in
 * one table because the spellings do not collide.
 */
const RAW_TYPES: Readonly<Record<string, TypeCategory>> = Object.freeze({
  // SQL - integer
  int: 'integer', int2: 'integer', int4: 'integer', int8: 'integer',
  integer: 'integer', smallint: 'integer', bigint: 'integer', tinyint: 'integer',
  mediumint: 'integer', serial: 'integer', smallserial: 'integer', bigserial: 'integer',
  // SQL - numeric
  numeric: 'numeric', decimal: 'numeric', real: 'numeric', float: 'numeric',
  float4: 'numeric', float8: 'numeric', double: 'numeric', 'double precision': 'numeric',
  money: 'numeric',
  // SQL - text
  text: 'text', varchar: 'text', 'character varying': 'text', character: 'text',
  char: 'text', bpchar: 'text', citext: 'text', nvarchar: 'text', clob: 'text',
  // SQL - boolean
  bool: 'boolean', boolean: 'boolean',
  // SQL - timestamp
  timestamp: 'timestamp', timestamptz: 'timestamp',
  'timestamp with time zone': 'timestamp', 'timestamp without time zone': 'timestamp',
  date: 'timestamp', datetime: 'timestamp', time: 'timestamp', timetz: 'timestamp',
  // SQL - structured
  json: 'json', jsonb: 'json', hstore: 'json', xml: 'json',
  uuid: 'uuid',
  enum: 'enum',
  // TypeScript
  string: 'text', number: 'numeric', bigintts: 'integer',
  Date: 'timestamp', object: 'json', Record: 'json', Array: 'json',
  any: 'unknown', unknown: 'unknown', never: 'unknown', void: 'unknown', null: 'unknown',
  // JSON Schema
  array: 'json',
});

/**
 * JSON Schema `format` overrides, applied when the base type is `string`.
 * `format: date-time` on a string is a timestamp, not free text, and joining it
 * to a `timestamptz` column must count as agreement.
 */
const FORMATS: Readonly<Record<string, TypeCategory>> = Object.freeze({
  'date-time': 'timestamp',
  date: 'timestamp',
  time: 'timestamp',
  uuid: 'uuid',
  int32: 'integer',
  int64: 'integer',
  float: 'numeric',
  double: 'numeric',
  decimal: 'numeric',
  binary: 'text',
  byte: 'text',
  email: 'text',
  uri: 'text',
  url: 'text',
  hostname: 'text',
  ipv4: 'text',
  ipv6: 'text',
});

/**
 * Normalize a raw type spelling into a category. Tolerates the parameterized
 * and decorated forms the extractors will realistically emit:
 * `varchar(255)`, `numeric(10,2)`, `timestamp with time zone`, `text[]`,
 * `string | null`, `Date | undefined`, `Post['status']`.
 *
 * Returns `unknown` rather than guessing. `unknown` is neutral evidence, never
 * a conflict - an extractor that could not resolve a type must not manufacture
 * a contradiction.
 */
export function normalizeType(raw?: string | number | boolean | null, format?: string | number | boolean | null): TypeCategory {
  if (typeof format === 'string') {
    const byFormat = FORMATS[format.trim().toLowerCase()];
    if (byFormat !== undefined) return byFormat;
  }
  if (typeof raw !== 'string') return 'unknown';
  let text = raw.trim();
  if (text.length === 0) return 'unknown';

  // Already a category.
  if (CATEGORY_SET.has(text.toLowerCase())) return text.toLowerCase() as TypeCategory;

  // Union types: drop null/undefined members, then take the single survivor.
  if (text.includes('|')) {
    const members = text.split('|')
      .map((m) => m.trim())
      .filter((m) => m.length > 0 && m !== 'null' && m !== 'undefined');
    if (members.length === 0) return 'unknown';
    if (members.length === 1) {
      const only = members[0];
      if (only !== undefined) {
        text = only;
      }
    } else {
      // A union of string literals is an enum; anything else is unresolvable.
      const allLiterals = members.every((m) => /^(['"`]).*\1$/u.test(m));
      return allLiterals ? 'enum' : 'unknown';
    }
  }

  // Array suffix or generic array: the container is JSON-shaped.
  if (/\[\s*\]\s*$/u.test(text) || /^(Array|ReadonlyArray|Set)\s*</u.test(text)) return 'json';

  // Strip parameters and modifiers: `varchar(255)`, `numeric(10,2)`, `Record<...>`.
  const paren = text.indexOf('(');
  if (paren > 0) text = text.slice(0, paren);
  const angle = text.indexOf('<');
  if (angle > 0) text = text.slice(0, angle);
  text = text.replace(/\s+/gu, ' ').trim();

  const lower = text.toLowerCase();
  const direct = RAW_TYPES[text] ?? RAW_TYPES[lower];
  if (direct !== undefined) return direct;
  if (lower === 'bigint') return 'integer';

  // Postgres/Drizzle write `character varying` and friends; the head word is
  // enough once the modifiers are gone.
  const head = lower.split(' ')[0];
  if (head !== undefined) {
    const byHead = RAW_TYPES[head];
    if (byHead !== undefined) return byHead;
  }

  // A quoted string literal is a single-member enum.
  if (/^(['"`]).*\1$/u.test(text)) return 'enum';

  return 'unknown';
}

export const TYPE_AGREEMENTS = ['equal', 'compatible', 'conflict', 'unknown'] as const;
export type TypeAgreement = (typeof TYPE_AGREEMENTS)[number];

/**
 * Category pairs that are not identical but are routinely the same value
 * crossing a representation boundary. Each entry is a real, observed encoding:
 *
 *   integer/numeric    a JS `number` field over an `int` column
 *   text/uuid          a `string` field over a `uuid` column
 *   text/enum          a `string` field over a Postgres enum
 *   text/timestamp     an ISO-8601 string over `timestamptz` (the JSON case)
 *   integer/timestamp  epoch millis stored as bigint
 *   text/numeric       decimal-as-string, the standard fix for float loss
 *   integer/boolean    SQLite and MySQL have no boolean; 0/1 in a tinyint
 *   integer/enum       an enum persisted by ordinal
 *   json/text          serialized JSON in a text column
 */
const COMPATIBLE: ReadonlySet<string> = new Set([
  'integer|numeric',
  'text|uuid',
  'enum|text',
  'text|timestamp',
  'integer|timestamp',
  'numeric|text',
  'boolean|integer',
  'enum|integer',
  'json|text',
]);

function pairKey(a: TypeCategory, b: TypeCategory): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Are two categories the same, a known encoding of each other, or a conflict? */
export function compareTypes(a: TypeCategory, b: TypeCategory): TypeAgreement {
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  if (a === b) return 'equal';
  return COMPATIBLE.has(pairKey(a, b)) ? 'compatible' : 'conflict';
}
