/**
 * Type text normalization.
 *
 * `CodeField` is the field-level join this product is built on: downstream
 * `infer-join` matches these fields against database columns and API schema
 * properties. That match is only as good as the type text, so the text must be
 *
 *  - path-free (the checker happily prints `import("/abs/path").User`),
 *  - order-stable (a union's member order is not source order),
 *  - split into base type + optionality + nullability, because `string | null`
 *    against a `NOT NULL` column is a contradiction and `string` is not.
 *
 * All of this is pure string work over checker output: no ts-morph import here,
 * so it is cheap to unit-test.
 */

/** Coarse type category used as the join key by `infer-join`. */
export const NORMALIZED_TYPES = [
  'string', 'number', 'bigint', 'boolean', 'date', 'buffer', 'uuid',
  'array', 'object', 'enum', 'union', 'function', 'any', 'unknown', 'void', 'never',
] as const;
export type NormalizedType = (typeof NORMALIZED_TYPES)[number];

const UUID_HINT = /^(uuid|guid)$/i;

/** Strip `import("...").` qualifiers the checker emits for cross-file types. */
export function stripImportQualifiers(text: string): string {
  return text.replace(/import\((?:"[^"]*"|'[^']*')\)\./g, '');
}

/** Collapse all whitespace runs to a single space and trim. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Split a type's top-level union members, respecting nesting and string
 * literals. `"a" | ("b" | "c")[] | null` yields three members, not four.
 */
export function splitTopLevelUnion(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') { depth += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}' || ch === '>') { depth -= 1; continue; }
    if (ch === '|' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  const trimmed = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  return trimmed.length > 0 ? trimmed : [text.trim()];
}

export interface NormalizedTypeInfo {
  /** Full sanitized checker text, union members sorted. Includes null/undefined. */
  readonly rawType: string;
  /** `rawType` with `null` and `undefined` members removed. The joinable type. */
  readonly baseType: string;
  /** The union contains `null`. */
  readonly nullable: boolean;
  /** The union contains `undefined`. */
  readonly hasUndefined: boolean;
  /** Coarse category for cross-domain matching. */
  readonly normalized: NormalizedType;
  /**
   * Sorted literal members, quotes stripped, when the base type is a literal
   * union. Unquoted because the join compares these against database CHECK
   * constraint values and OpenAPI `enum` entries, neither of which is quoted.
   */
  readonly enumValues: readonly string[];
}

function categorize(baseMembers: readonly string[], fieldName: string): NormalizedType {
  if (baseMembers.length === 0) return 'unknown';
  if (baseMembers.length > 1) {
    if (baseMembers.every(isLiteralMember)) return 'enum';
    return 'union';
  }
  const t = baseMembers[0] ?? '';
  if (isLiteralMember(t)) return 'enum';
  if (t.endsWith('[]') || /^(readonly )?(Array|ReadonlyArray|Set|Map)</.test(t)) return 'array';
  if (/^\(.*\)\s*=>/.test(t) || t.startsWith('(')) return 'function';
  switch (t) {
    case 'string':
      return UUID_HINT.test(fieldName) || /(^|[a-z])(Uuid|Guid|UUID|GUID)$/.test(fieldName) ? 'uuid' : 'string';
    case 'number': return 'number';
    case 'bigint': return 'bigint';
    case 'boolean': case 'true': case 'false': return 'boolean';
    case 'Date': return 'date';
    case 'Buffer': case 'Uint8Array': case 'ArrayBuffer': return 'buffer';
    case 'any': return 'any';
    case 'void': return 'void';
    case 'never': return 'never';
    case 'unknown': return 'unknown';
    default: return 'object';
  }
}

/** `'active'` -> `active`. Leaves an unquoted numeric or boolean literal alone. */
function stripQuotes(t: string): string {
  const first = t.charAt(0);
  if ((first === '"' || first === "'" || first === '`') && t.endsWith(first) && t.length >= 2) {
    return t.slice(1, -1);
  }
  return t;
}

function isLiteralMember(t: string): boolean {
  return /^["'`]/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || t === 'true' || t === 'false';
}

/**
 * Normalize checker type text into the shape `CodeField` stores.
 *
 * `fieldName` only influences the `uuid` refinement — a `string` named `id` is
 * still `string`, but one named `userUuid` is `uuid`, which is what lets a
 * `uuid` column match a `string` field without a false type contradiction.
 */
export function normalizeTypeText(text: string, fieldName = ''): NormalizedTypeInfo {
  const sanitized = collapseWhitespace(stripImportQualifiers(text));
  const members = splitTopLevelUnion(sanitized);
  const nullable = members.includes('null');
  const hasUndefined = members.includes('undefined');
  const base = members.filter((m) => m !== 'null' && m !== 'undefined');
  const sortedAll = [...members].sort();
  const sortedBase = [...base].sort();
  return {
    rawType: sortedAll.join(' | '),
    baseType: sortedBase.length > 0 ? sortedBase.join(' | ') : sanitized,
    nullable,
    hasUndefined,
    normalized: categorize(sortedBase, fieldName),
    enumValues:
      sortedBase.every(isLiteralMember) && sortedBase.length > 0 ? sortedBase.map(stripQuotes) : [],
  };
}
