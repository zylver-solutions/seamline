/**
 * The cross-domain type normalization scheme.
 *
 * This is the whole point of the extractor: a `SchemaProperty` declaring
 * `{"type":"string","format":"date-time"}` and a `Column` declaring
 * `timestamptz` are the same fact in two dialects, and nothing downstream can
 * compare them until both have been reduced to one category.
 *
 * SCHEME (must stay identical to the one `extract-data` applies to SQL types):
 *
 *   integer    integer / int32 / int64 types
 *   numeric    non-integral numbers (numeric, decimal, real, double)
 *   text       character data with no more specific category
 *   boolean    booleans
 *   timestamp  instants and dates: date, date-time, time
 *   uuid       uuid / guid
 *   json       objects and free-form documents (json, jsonb)
 *   enum       a closed set of permitted values
 *   unknown    could not be determined
 *
 * Two rules that matter more than the table:
 *
 * 1. `enum` outranks the base type. A `{"type":"string","enum":[...]}` is an
 *    enum, because X3/X7 compare it against a SQL enum or CHECK constraint,
 *    not against `text`.
 * 2. `unknown` is emitted rather than guessed. A category invented for an
 *    undetermined type manufactures an X2 finding from nothing.
 *
 * Arrays are NOT their own category. An array carries the category of its
 * element type plus `isArray: true`, so `text[]` and `{"type":"array",
 * "items":{"type":"string"}}` compare equal on both axes.
 */

import type { TypeCategory } from './types.ts';
import { isRecord } from './json-pointer.ts';

/** Formats that pin a `string` to a more specific category. */
const STRING_FORMAT_CATEGORY: Readonly<Record<string, TypeCategory>> = {
  uuid: 'uuid',
  guid: 'uuid',
  'date-time': 'timestamp',
  date: 'timestamp',
  time: 'timestamp',
  duration: 'text',
  email: 'text',
  hostname: 'text',
  ipv4: 'text',
  ipv6: 'text',
  uri: 'text',
  'uri-reference': 'text',
  binary: 'text',
  byte: 'text',
  password: 'text',
};

/** Formats that pin a `number`/`integer` to a category. */
const NUMBER_FORMAT_CATEGORY: Readonly<Record<string, TypeCategory>> = {
  int32: 'integer',
  int64: 'integer',
  float: 'numeric',
  double: 'numeric',
  decimal: 'numeric',
};

/**
 * Reduce a JSON-Schema-family `type` (+ optional `format`) to a category.
 * `hasEnum` short-circuits to `enum`.
 */
export function categorizeJsonType(
  type: string | null,
  format: string | null,
  hasEnum: boolean,
): TypeCategory {
  if (hasEnum) return 'enum';
  switch (type) {
    case 'string': {
      if (format !== null) {
        const mapped = STRING_FORMAT_CATEGORY[format.toLowerCase()];
        if (mapped !== undefined) return mapped;
      }
      return 'text';
    }
    case 'integer':
      return 'integer';
    case 'number': {
      if (format !== null) {
        const mapped = NUMBER_FORMAT_CATEGORY[format.toLowerCase()];
        if (mapped !== undefined) return mapped;
      }
      return 'numeric';
    }
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'json';
    case 'null':
    case 'array':
    case null:
    default:
      return 'unknown';
  }
}

/**
 * Reduce a set of branch categories (from `oneOf`/`anyOf`/a `type` array) to
 * one. Agreement wins; disagreement is `unknown`, never a guess.
 * `null` branches are dropped — nullability is a separate axis.
 */
export function unifyCategories(categories: readonly TypeCategory[]): TypeCategory {
  const real = categories.filter((c) => c !== 'unknown');
  if (real.length === 0) return 'unknown';
  const first = real[0] as TypeCategory;
  return real.every((c) => c === first) ? first : 'unknown';
}

/**
 * The declared JSON Schema `type` as a plain string, and whether `"null"`
 * appeared in it. OAS 3.1 and JSON Schema use `type: ["string","null"]`;
 * OAS 3.0 uses `nullable: true`, handled by the caller.
 */
export function readTypeField(schema: Record<string, unknown>): {
  type: string | null;
  typeIsNullable: boolean;
  rawType: string;
} {
  const t = schema['type'];
  if (typeof t === 'string') return { type: t, typeIsNullable: t === 'null', rawType: t };
  if (Array.isArray(t)) {
    const names = t.filter((x): x is string => typeof x === 'string');
    const nonNull = names.filter((x) => x !== 'null');
    const sorted = [...names].sort();
    return {
      type: nonNull.length === 1 ? (nonNull[0] as string) : null,
      typeIsNullable: names.includes('null'),
      rawType: sorted.join('|'),
    };
  }
  // No declared type. An object shape is still an object.
  if (isRecord(schema['properties'])) return { type: 'object', typeIsNullable: false, rawType: 'object' };
  return { type: null, typeIsNullable: false, rawType: '' };
}
