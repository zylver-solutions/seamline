/**
 * Canonical serialization (v3 §2.3).
 *
 * Merge needs this twice: as the final tie-break that makes the precedence
 * order *total*, and as the equality relation the property tests compare
 * merged states with. Keys are sorted, `undefined` members are omitted, and a
 * non-finite number throws rather than serializing as `null`.
 */

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`non-finite number is not serializable: ${String(n)}`);
  }
  return Object.is(n, -0) ? '0' : String(n);
}

/** Deterministic JSON: object keys sorted by code unit, arrays in place. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return serializeNumber(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
      return 'null';
    case 'object':
      break;
    default:
      throw new Error(`unserializable value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',');
  return `{${body}}`;
}

/** Code-unit string comparison. Never locale-aware; locale is not deterministic. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
