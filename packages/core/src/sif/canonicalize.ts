/**
 * Canonical serialization for SIF — the Seamline Interchange Format.
 *
 * Byte-identical output across two runs is a release gate (design v3 §2.3), so
 * this module is the load-bearing piece of SIF, not a formatting convenience.
 * Every rule below exists because its absence silently breaks that gate:
 *
 * - object keys sorted by UTF-16 code unit at every depth (RFC 8785 / JCS order),
 * - one and only one textual form per number, so `1.0` and `1` cannot differ,
 * - explicit, spec-stable string escaping including lone surrogates,
 * - repo-relative POSIX paths only: no absolute path, no backslash, no `..`,
 * - no wall-clock timestamp field anywhere in a node or edge body.
 *
 * The last rule is the one with history. v2 put `createdAt`/`updatedAt` on every
 * node, which alone makes byte-identical output impossible; the contract
 * deliberately omits them, and this module is what stops anyone adding them back.
 * `deletedAt` is the single contract-sanctioned exception (it is a tombstone
 * marker owned by the run lifecycle, v3 §2.2).
 */

import { parseNodeId, type NodeId, type SeamlineEdge, type SeamlineNode, type SifLine } from '@seamline/ontology';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when a value cannot be canonically serialized. Always names the field. */
export class CanonicalizationError extends Error {
  /** Dotted path to the offending field, e.g. `node.props.createdAt`. */
  readonly field: string;
  /** The message without the field prefix, so a caller can re-frame it. */
  readonly detail: string;

  constructor(detail: string, field: string) {
    super(field.length > 0 ? `${field}: ${detail}` : detail);
    this.name = 'CanonicalizationError';
    this.field = field;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Total order on strings by UTF-16 code unit — the order RFC 8785 (JSON
 * Canonicalization Scheme) specifies for object members. Deliberately not
 * `localeCompare`, which is locale- and ICU-version-dependent and therefore
 * not reproducible across machines.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Lexicographic order over a tuple of strings, each compared by code unit. */
export function compareKeyTuples(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareCodeUnits(a[i] as string, b[i] as string);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const WINDOWS_DRIVE = /^[A-Za-z]:/;

/** True for anything that is not unambiguously repo-relative. */
export function isAbsoluteLike(p: string): boolean {
  return (
    p.startsWith('/') ||
    p.startsWith('\\') ||
    p === '~' ||
    p.startsWith('~/') ||
    p.startsWith('~\\') ||
    WINDOWS_DRIVE.test(p)
  );
}

/**
 * Assert that `value` is already a normalized, repo-relative POSIX path.
 *
 * This is the serialization-time gate, not a normalizer: it rejects rather than
 * repairs, because a path that reaches serialization un-normalized means some
 * extractor skipped `canonicalPath` and will produce machine-dependent output.
 */
export function assertRepoRelativePosix(value: string, field: string): void {
  if (value.length === 0) {
    throw new CanonicalizationError('path must not be empty', field);
  }
  if (value.includes('\\')) {
    throw new CanonicalizationError(
      `path contains a backslash: ${JSON.stringify(value)}; SIF paths are POSIX only (v3 §2.3) — run canonicalPath() first`,
      field,
    );
  }
  if (isAbsoluteLike(value)) {
    throw new CanonicalizationError(
      `path is absolute: ${JSON.stringify(value)}; SIF stores repo-relative paths only (v3 §2.3) — run canonicalPath(p, repoRoot) first`,
      field,
    );
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new CanonicalizationError(
        `path escapes the repo root with a '..' segment: ${JSON.stringify(value)}`,
        field,
      );
    }
    if (segment === '.') {
      throw new CanonicalizationError(
        `path is not normalized ('.' segment): ${JSON.stringify(value)} — run canonicalPath() first`,
        field,
      );
    }
    if (segment === '') {
      throw new CanonicalizationError(
        `path is not normalized (empty segment from a leading, doubled or trailing '/'): ${JSON.stringify(value)}`,
        field,
      );
    }
  }
}

/**
 * Normalize `p` to a repo-relative POSIX path.
 *
 * This is the on-ramp extractors call; `assertRepoRelativePosix` is the gate the
 * writer applies afterwards. Windows separators are converted rather than
 * rejected here, because the whole point of the function is to accept what a
 * host filesystem hands you and produce the one canonical form.
 *
 * @param repoRoot Absolute or relative root to resolve `p` against. Required
 *   when `p` is absolute — an absolute path with no root cannot be made
 *   relative, and guessing is exactly the machine-dependence this prevents.
 * @throws CanonicalizationError when `p` cannot be expressed under `repoRoot`.
 */
export function canonicalPath(p: string, repoRoot?: string): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new CanonicalizationError('path must be a non-empty string', 'path');
  }

  let value = p.split('\\').join('/');
  const root = repoRoot === undefined ? undefined : stripTrailingSlashes(repoRoot.split('\\').join('/'));

  if (isAbsoluteLike(value)) {
    if (root === undefined) {
      throw new CanonicalizationError(
        `cannot make the absolute path ${JSON.stringify(p)} repo-relative without a repoRoot`,
        'path',
      );
    }
    const relative = stripRootPrefix(value, root);
    if (relative === null) {
      throw new CanonicalizationError(
        `absolute path ${JSON.stringify(p)} is outside repoRoot ${JSON.stringify(repoRoot)}`,
        'path',
      );
    }
    value = relative;
  } else if (root !== undefined && isAbsoluteLike(root)) {
    // `p` is already relative; a relative-to-absolute-root pairing needs no work.
  }

  const out: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) {
        throw new CanonicalizationError(
          `path escapes the repo root: ${JSON.stringify(p)}`,
          'path',
        );
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }

  if (out.length === 0) {
    throw new CanonicalizationError(
      `path ${JSON.stringify(p)} normalizes to the repo root itself, which is not a valid node path`,
      'path',
    );
  }

  const result = out.join('/');
  assertRepoRelativePosix(result, 'path');
  return result;
}

function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 1 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

/** Returns the remainder of `value` under `root`, or null when not contained. */
function stripRootPrefix(value: string, root: string): string | null {
  if (root.length === 0) return null;
  if (value === root) return '';
  const withSlash = root.endsWith('/') ? root : `${root}/`;
  if (value.startsWith(withSlash)) return value.slice(withSlash.length);
  return null;
}

// ---------------------------------------------------------------------------
// Forbidden field names on a node or edge body
// ---------------------------------------------------------------------------

/**
 * The one `*At` field the contract sanctions on a node or edge. It is the
 * tombstone marker written by `finalizeRun`, not extractor-observed wall clock.
 */
const CONTRACT_TIME_FIELDS: ReadonlySet<string> = new Set(['deletedAt']);

/** camelCase / snake_case suffixes that mark a field as carrying a clock reading. */
const TIME_SUFFIX = /(?:At|_at|Ts|_ts|Time|_time|Date|_date|Stamp|_stamp)$/;

/** Whole names that carry a clock reading without a recognizable suffix. */
const TIME_NAMES: ReadonlySet<string> = new Set([
  'timestamp', 'time', 'date', 'datetime', 'mtime', 'ctime', 'atime',
  'epoch', 'now', 'wallclock', 'walltime', 'when', 'millis', 'unixtime',
]);

/** True when `key` names a wall-clock timestamp that must not appear on a fact. */
export function isTimestampField(key: string): boolean {
  if (CONTRACT_TIME_FIELDS.has(key)) return false;
  if (TIME_NAMES.has(key.toLowerCase())) return true;
  return TIME_SUFFIX.test(key);
}

const PATH_WORDS = ['path', 'file', 'dir', 'filename', 'filepath', 'dirname', 'folder'] as const;

/**
 * True when `key` names a path-bearing field, by camelCase or snake_case word
 * boundary. Boundary-aware on purpose: `profile` ends in "file" and is not a path.
 */
export function isPathField(key: string): boolean {
  const lower = key.toLowerCase();
  for (const word of PATH_WORDS) {
    if (lower === word) return true;
    if (!lower.endsWith(word)) continue;
    const tail = key.slice(key.length - word.length);
    if (tail.charAt(0) === (word.charAt(0).toUpperCase())) return true;
    if (key.charAt(key.length - word.length - 1) === '_') return true;
  }
  return false;
}

/**
 * Contract fields that hold a path but are not named after one.
 * `sourceRef` is `path[:line[:col]]`, which passes the same checks.
 */
const EXPLICIT_PATH_FIELDS: ReadonlySet<string> = new Set(['sourceRef', 'srcFile', 'dstFile']);

function factIdentity(value: unknown): ReturnType<typeof parseNodeId> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = parseNodeId(value as NodeId);
    return parsed.repo.length > 0 && parsed.canonicalName.length > 0 ? parsed : undefined;
  } catch { return undefined; }
}

/** Exact existing source-data exceptions, never a generic path/time bypass (ADR-0009). */
function assertSourceDataProp(body: Record<string, unknown>, props: Record<string, unknown>, key: string, field: string): boolean {
  const httpPath = (body['kind'] === 'RouteHandler' && key === 'routePath') ||
    (body['kind'] === 'Operation' && key === 'path');
  const commitDate = body['kind'] === 'Commit' && (key === 'authorDate' || key === 'committerDate');
  const renameDate = body['kind'] === 'RENAMED_FROM' && key === 'authorDate';
  if (!httpPath && !commitDate && !renameDate) return false;
  const value = props[key];
  const invalid = (): never => { throw new CanonicalizationError('invalid typed source-data value or identity context (ADR-0009)', field); };
  if (typeof value !== 'string') return invalid();
  if (httpPath) {
    const method = props['method'];
    const identity = factIdentity(body['id']);
    if (!value.startsWith('/') || typeof method !== 'string' || !/^[A-Z]+$/.test(method) ||
        identity === undefined || identity.kind !== body['kind'] || identity.canonicalName !== `${method} ${value}`) return invalid();
    for (const char of value) {
      const point = char.codePointAt(0) as number;
      if (point <= 31 || point === 127 || point === 92 || (point >= 0xd800 && point <= 0xdfff)) return invalid();
    }
    return true;
  }
  // Git's source epoch is serialized once as UTC, never read from the extraction clock.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value.slice(0, -1) + '.000Z') return invalid();
  const hash = commitDate ? props['sha'] : props['commit'];
  if (typeof hash !== 'string' || !/^[a-f0-9]{40}$/.test(hash) || body['sourceRef'] !== hash) return invalid();
  if (commitDate) {
    const identity = factIdentity(body['id']);
    if (identity?.kind !== 'Commit' || identity.canonicalName !== hash) return invalid();
  } else {
    const src = factIdentity(body['src']);
    const dst = factIdentity(body['dst']);
    if (src?.kind !== 'File' || dst?.kind !== 'File' || src.repo !== dst.repo) return invalid();
  }
  return true;
}

function assertCleanFactBody(body: Record<string, unknown>, prefix: string): void {
  for (const key of Object.keys(body)) {
    const value = body[key];
    const field = `${prefix}.${key}`;
    if (isTimestampField(key)) {
      throw new CanonicalizationError(
        `wall-clock timestamp field is not allowed on a fact; time belongs to the Run record, not to a node or edge (v3 §2.3). ` +
          `The contract omits createdAt/updatedAt deliberately — move this to the RunRecord or into a run id.`,
        field,
      );
    }
    if (typeof value !== 'string') continue;
    if (EXPLICIT_PATH_FIELDS.has(key) || isPathField(key)) {
      assertRepoRelativePosix(value, field);
    }
  }
  const props = body['props'];
  if (props !== undefined && props !== null && typeof props === 'object' && !Array.isArray(props)) {
    for (const key of Object.keys(props as Record<string, unknown>)) {
      const field = `${prefix}.props.${key}`;
      if (assertSourceDataProp(body, props as Record<string, unknown>, key, field)) continue;
      if (isTimestampField(key)) {
        throw new CanonicalizationError(
          `wall-clock timestamp field is not allowed in a fact's props; time belongs to the Run record (v3 §2.3)`,
          field,
        );
      }
      const value = (props as Record<string, unknown>)[key];
      if (typeof value === 'string' && (EXPLICIT_PATH_FIELDS.has(key) || isPathField(key))) {
        assertRepoRelativePosix(value, field);
      }
    }
  }
}

/** Validate a node body against the determinism rules. Throws on violation. */
export function assertCleanNodeBody(node: SeamlineNode, prefix = 'node'): void {
  assertCleanFactBody(node as unknown as Record<string, unknown>, prefix);
}

/** Validate an edge body against the determinism rules. Throws on violation. */
export function assertCleanEdgeBody(edge: SeamlineEdge, prefix = 'edge'): void {
  assertCleanFactBody(edge as unknown as Record<string, unknown>, prefix);
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * One textual form per numeric value.
 *
 * `1.0` and `1` are the same IEEE-754 double, so the guarantee is that a single
 * formatter is the only path to text: integers always render without a decimal
 * point or exponent, non-integers render in the shortest round-trip form that
 * ECMA-262 Number::toString defines exactly (so it is engine-independent).
 * `-0` normalizes to `0`; NaN and Infinity are rejected rather than silently
 * becoming `null` the way `JSON.stringify` would.
 */
export function formatNumber(n: number, field: string): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalizationError(
      `${String(n)} is not representable in JSON; JSON.stringify would silently emit null`,
      field,
    );
  }
  if (Object.is(n, -0)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
  return String(n);
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/**
 * Quote a string with stable escaping: the two mandatory escapes, the five
 * short forms, `\u00xx` for the remaining C0 controls, and `\uXXXX` for lone
 * surrogates so the output is always well-formed UTF-8. Everything else is
 * emitted literally, so the file is UTF-8 rather than ASCII-with-escapes.
 */
export function quoteString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const escape = SHORT_ESCAPES[ch];
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    const code = s.charCodeAt(i);
    if (code < 0x20) {
      out += unicodeEscape(code);
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += ch + s.charAt(i + 1);
        i++;
        continue;
      }
      out += unicodeEscape(code);
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += unicodeEscape(code);
      continue;
    }
    out += ch;
  }
  return `${out}"`;
}

function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// canonicalStringify
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON text for `value`.
 *
 * Object keys are sorted at every depth; arrays keep their given order (an
 * array's order is data — see `sortNodes`/`sortEdges` for the SIF collections
 * whose order is *not* data). Properties whose value is `undefined` are
 * dropped, matching `JSON.stringify`; `undefined` inside an array is an error
 * rather than a silent `null`.
 *
 * Deliberately does not honour `toJSON`: `Date#toJSON` is precisely the hole
 * through which wall-clock time gets back into a fact body.
 */
export function canonicalStringify(value: unknown, rootField = ''): string {
  const out: string[] = [];
  writeValue(value, out, rootField, new Set<object>());
  return out.join('');
}

function writeValue(value: unknown, out: string[], field: string, seen: Set<object>): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      out.push(formatNumber(value, field));
      return;
    case 'string':
      out.push(quoteString(value));
      return;
    case 'bigint':
      throw new CanonicalizationError('bigint is not representable in JSON', field);
    case 'undefined':
      throw new CanonicalizationError('undefined is not representable in JSON', field);
    case 'function':
      throw new CanonicalizationError('a function is not representable in JSON', field);
    case 'symbol':
      throw new CanonicalizationError('a symbol is not representable in JSON', field);
    default:
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalizationError('circular reference', field);
  }
  if (obj instanceof Date) {
    throw new CanonicalizationError(
      'a Date is not serializable in SIF; wall-clock time belongs to the Run record, not to a fact (v3 §2.3)',
      field,
    );
  }
  if (obj instanceof Map || obj instanceof Set) {
    throw new CanonicalizationError(
      `a ${obj.constructor.name} serializes to {} and would silently drop its contents; convert it to a plain object or array first`,
      field,
    );
  }
  if (obj instanceof RegExp) {
    throw new CanonicalizationError('a RegExp serializes to {} and is not representable in SIF', field);
  }
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    throw new CanonicalizationError('binary data is not representable in SIF', field);
  }

  seen.add(obj);
  if (Array.isArray(obj)) {
    out.push('[');
    for (let i = 0; i < obj.length; i++) {
      if (i > 0) out.push(',');
      const element = obj[i] as unknown;
      const elementField = field.length > 0 ? `${field}[${i}]` : `[${i}]`;
      if (element === undefined) {
        throw new CanonicalizationError(
          'undefined inside an array would become null; make the absence explicit',
          elementField,
        );
      }
      writeValue(element, out, elementField, seen);
    }
    out.push(']');
  } else {
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareCodeUnits);
    out.push('{');
    let written = 0;
    for (const key of keys) {
      const child = record[key];
      if (child === undefined) continue;
      if (written > 0) out.push(',');
      out.push(quoteString(key));
      out.push(':');
      writeValue(child, out, field.length > 0 ? `${field}.${key}` : key, seen);
      written++;
    }
    out.push('}');
  }
  seen.delete(obj);
}

// ---------------------------------------------------------------------------
// SIF line canonicalization
// ---------------------------------------------------------------------------

/** Emission group order within a SIF file: run, then status, then nodes, then edges. */
export const SIF_GROUP_ORDER: Readonly<Record<SifLine['t'], number>> = {
  run: 0,
  status: 1,
  node: 2,
  edge: 3,
};

/**
 * Canonical text for one SIF line, with the determinism rules enforced.
 *
 * This is the enforcement point: `canonicalStringify` alone is a generic JSON
 * canonicalizer, while this function additionally rejects absolute paths,
 * backslash paths, `..` paths and timestamp fields on node and edge bodies.
 */
export function canonicalSifLine(line: SifLine): string {
  switch (line.t) {
    case 'run':
      return canonicalStringify({ t: 'run', run: line.run }, '');
    case 'status':
      return canonicalStringify({ t: 'status', result: line.result }, '');
    case 'node':
      assertCleanNodeBody(line.node);
      return canonicalStringify({ t: 'node', node: line.node }, '');
    case 'edge':
      assertCleanEdgeBody(line.edge);
      return canonicalStringify({ t: 'edge', edge: line.edge }, '');
    default: {
      const t = (line as { t?: unknown }).t;
      throw new CanonicalizationError(
        `unknown SIF line type ${JSON.stringify(t)}; expected one of run, status, node, edge`,
        't',
      );
    }
  }
}

/**
 * The sort key for a SIF line. Nodes order by `id`, edges by `(src, dst, kind)`,
 * statuses by `(extractor, version)`, runs by `runId`. Callers tie-break on the
 * canonical text so the order is total even when two lines share a key — a
 * relative order that fell through to `Array#sort` stability would be input
 * order, which is exactly what must not affect the bytes.
 */
export function sifSortKey(line: SifLine): readonly string[] {
  switch (line.t) {
    case 'run':
      return [line.run.runId];
    case 'status':
      return [line.result.extractor, line.result.version];
    case 'node':
      return [line.node.id];
    case 'edge':
      return [line.edge.src, line.edge.dst, line.edge.kind];
    default:
      return [];
  }
}

/** Total order on nodes: by `id`, tie-broken by canonical text. */
export function compareNodes(a: SeamlineNode, b: SeamlineNode): number {
  const byId = compareCodeUnits(a.id, b.id);
  if (byId !== 0) return byId;
  return compareCodeUnits(canonicalStringify(a), canonicalStringify(b));
}

/** Total order on edges: by `(src, dst, kind)`, tie-broken by canonical text. */
export function compareEdges(a: SeamlineEdge, b: SeamlineEdge): number {
  const bySrc = compareCodeUnits(a.src, b.src);
  if (bySrc !== 0) return bySrc;
  const byDst = compareCodeUnits(a.dst, b.dst);
  if (byDst !== 0) return byDst;
  const byKind = compareCodeUnits(a.kind, b.kind);
  if (byKind !== 0) return byKind;
  return compareCodeUnits(canonicalStringify(a), canonicalStringify(b));
}

/** Copy of `nodes` in canonical order. Does not mutate the input. */
export function sortNodes(nodes: ReadonlyArray<SeamlineNode>): SeamlineNode[] {
  return [...nodes].sort(compareNodes);
}

/** Copy of `edges` in canonical order. Does not mutate the input. */
export function sortEdges(edges: ReadonlyArray<SeamlineEdge>): SeamlineEdge[] {
  return [...edges].sort(compareEdges);
}
