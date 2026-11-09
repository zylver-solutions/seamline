/**
 * Small shared helpers: canonical JSON, hashing, ordering, globs.
 *
 * Everything here is deterministic and offline. Ordering is by UTF-16 code
 * unit (never by locale), as in the rest of the repository (ADR-0009).
 */

import { createHash } from 'node:crypto';

/** Order two strings by UTF-16 code unit. Locale-independent. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** `sha256:<hex>`, the form every digest in a packet takes. */
export function sha256Tagged(data: string | Uint8Array): string {
  return `sha256:${sha256Hex(data)}`;
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

/** Object keys sorted by code unit, recursively; `undefined` members dropped. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnits)) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}

/** Compact canonical JSON, for digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** The packet serialisation: sorted keys, two-space indent, LF, one trailing newline. */
export function prettyCanonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
}

/**
 * Glob to regular expression for repo-relative POSIX paths. `*` matches within
 * one segment, `**` as a whole segment matches any number of segments (a
 * trailing `**` matches everything below). No other syntax. Every quantified
 * group consumes a `/` per iteration, so matching is linear.
 */
export function globToRegExp(glob: string): RegExp {
  const segments = glob.split('/');
  let source = '^';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    const last = i === segments.length - 1;
    if (segment === '**') {
      source += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    source += segment.split('*').map(escapeRegExp).join('[^/]*');
    if (!last) source += '/';
  }
  return new RegExp(`${source}$`);
}

export function matchesAny(patterns: readonly RegExp[], path: string): boolean {
  return patterns.some((p) => p.test(path));
}

/** Last path segment of a POSIX path. */
export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Directory of a POSIX path, `.` for a top-level entry. */
export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '.' : path.slice(0, i);
}

/** Extension including the dot, empty when there is none. */
export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

/** Join and normalise POSIX segments; `..` that would leave the root is kept as a leading `..`. */
export function joinPosix(...parts: string[]): string {
  const out: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/** Truncate to at most `max` UTF-16 code units without leaving half of a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}
