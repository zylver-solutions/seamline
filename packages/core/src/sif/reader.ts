/**
 * SIF reader — JSON-Lines text to validated `SifLine[]`.
 *
 * Validation is against the contract, not merely against JSON: node kinds are
 * checked against `NODE_KINDS`, every edge against `isValidEdge` with its
 * endpoint kinds resolved through `parseNodeId`, provenance and sensitivity
 * against their vocabularies, confidence against [0, 1]. Anything a
 * conforming writer would refuse to emit, the reader refuses to accept, so a
 * read/write round trip is closed.
 *
 * A malformed line is a `SifParseError` naming the 1-based line number and the
 * offending field. There is no lenient mode and no silent skip: a dropped fact
 * is indistinguishable from an absent one, and the whole design turns on the
 * difference between "not there" and "not observed" (v3 §2.2).
 */

import {
  EDGE_KINDS,
  EDGE_SIGNATURES,
  EXTRACTOR_STATUS,
  isValidEdge,
  NODE_KINDS,
  parseNodeId,
  PROVENANCE,
  SENSITIVITY,
  SIF_VERSION,
} from '@seamline/ontology';
import type {
  AuthoritativeScope,
  EdgeKind,
  ExtractorResult,
  ExtractorStatus,
  NodeId,
  NodeKind,
  Provenance,
  RunRecord,
  SeamlineEdge,
  SeamlineNode,
  Sensitivity,
  SifLine,
} from '@seamline/ontology';
import { assertCleanEdgeBody, assertCleanNodeBody, CanonicalizationError, isTimestampField } from './canonicalize.ts';
import { SifFraming } from './framing.ts';
import { assertSifAuthority } from './authority.ts';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** A SIF line that could not be validated. Always carries a line number and a field. */
export class SifParseError extends Error {
  /** 1-based physical line number in the source text. */
  readonly line: number;
  /** Dotted path to the offending field, e.g. `node.confidence`. `''` for whole-line faults. */
  readonly field: string;
  /** The message without the `SIF line N:` prefix. */
  readonly detail: string;

  constructor(line: number, field: string, detail: string) {
    super(`SIF line ${line}: ${field.length > 0 ? `${field}: ` : ''}${detail}`);
    this.name = 'SifParseError';
    this.line = line;
    this.field = field;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

const NODE_KIND_SET: ReadonlySet<string> = new Set<string>(NODE_KINDS);
const EDGE_KIND_SET: ReadonlySet<string> = new Set<string>(EDGE_KINDS);
const PROVENANCE_SET: ReadonlySet<string> = new Set<string>(PROVENANCE);
const SENSITIVITY_SET: ReadonlySet<string> = new Set<string>(SENSITIVITY);
const STATUS_SET: ReadonlySet<string> = new Set<string>(EXTRACTOR_STATUS);

const NODE_FIELDS: ReadonlySet<string> = new Set([
  'id', 'kind', 'name', 'path', 'sensitivity', 'provenance', 'confidence',
  'sourceRef', 'untrusted', 'props', 'firstSeenRun', 'lastSeenRun', 'deletedAt',
]);
const EDGE_FIELDS: ReadonlySet<string> = new Set([
  'kind', 'src', 'dst', 'srcFile', 'dstFile', 'provenance', 'confidence',
  'sourceRef', 'props', 'firstSeenRun', 'lastSeenRun', 'deletedAt',
]);
const RUN_FIELDS: ReadonlySet<string> = new Set([
  'runId', 'repo', 'commit', 'startedAt', 'finishedAt', 'ontologyVersion', 'results',
]);
const RESULT_FIELDS: ReadonlySet<string> = new Set([
  'extractor', 'version', 'status', 'authoritative', 'nodeCount', 'edgeCount',
  'durationMs', 'diagnostics',
]);
const SCOPE_FIELDS: ReadonlySet<string> = new Set(['scope', 'kinds', 'selector']);

/** Truncated vocabulary listing for an error message. */
function listSome(values: ReadonlyArray<string>, max = 8): string {
  const head = values.slice(0, max).join(', ');
  return values.length > max ? `${head}, … (${values.length} total)` : head;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ReadSifOptions {
  /**
   * Enforce the determinism rules (repo-relative POSIX paths, no timestamp
   * fields on facts) while reading. On by default: reading is where a
   * non-conforming producer is caught, and turning this off means accepting a
   * file that cannot be re-serialized byte-identically.
   */
  readonly enforceCanonicalRules?: boolean;
}

/** Parse and validate a whole SIF document. */
export function readSif(text: string, options: ReadSifOptions = {}): SifLine[] {
  return [...readSifLines(text, options)];
}

/** Validate the complete document before yielding any record or authority. */
export function* readSifLines(
  text: string,
  options: ReadSifOptions = {},
): Generator<SifLine, void, undefined> {
  const enforce = options.enforceCanonicalRules !== false;
  const rawLines = text.split('\n');
  const framing = new SifFraming();
  const records: SifLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const physical = rawLines[i] as string;
    try { if (!framing.accept(physical, i + 1, i < rawLines.length - 1)) continue; }
    catch (error) { throw new SifParseError(i + 1, 'format', (error as Error).message); }
    const raw = stripCarriageReturn(physical);
    if (raw.trim().length === 0) continue;
    records.push(parseSifRecord(raw, i + 1, enforce));
  }
  validateDocumentAuthority(records, framing.framed, rawLines.length);
  yield* records;
}

/** Parse and validate SIF arriving as text chunks of arbitrary size. */
export async function readSifStream(
  chunks: AsyncIterable<string | Uint8Array>,
  options: ReadSifOptions = {},
): Promise<SifLine[]> {
  const enforce = options.enforceCanonicalRules !== false;
  const decoder = new TextDecoder('utf-8');
  const framing = new SifFraming();
  const out: SifLine[] = [];
  let pending = '';
  let lineNumber = 0;
  for await (const chunk of chunks) {
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      lineNumber++;
      const physical = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        if (framing.accept(physical, lineNumber)) {
          const raw = stripCarriageReturn(physical);
          if (raw.trim().length > 0) out.push(parseSifRecord(raw, lineNumber, enforce));
        }
      } catch (error) {
        if (error instanceof SifParseError) throw error;
        throw new SifParseError(lineNumber, 'format', (error as Error).message);
      }
      newline = pending.indexOf('\n');
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    try {
      if (framing.accept(pending, lineNumber + 1, false) && pending.trim().length > 0)
        out.push(parseSifRecord(stripCarriageReturn(pending), lineNumber + 1, enforce));
    } catch (error) {
      if (error instanceof SifParseError) throw error;
      throw new SifParseError(lineNumber + 1, 'format', (error as Error).message);
    }
  }
  validateDocumentAuthority(out, framing.framed, lineNumber + 1);
  return out;
}

export interface ParseSifContext {
  /** Supplied by a framing-aware caller; standalone lines default to legacy. */
  readonly framedVersion?: typeof SIF_VERSION;
}

/** Parse and validate exactly one SIF line. `lineNumber` is for the error message. */
export function parseSifLine(raw: string, lineNumber: number, enforce = true, context: ParseSifContext = {}): SifLine {
  const record = parseSifRecord(raw, lineNumber, enforce);
  validateDocumentAuthority([record], context.framedVersion === SIF_VERSION, lineNumber);
  return record;
}

function validateDocumentAuthority(records: readonly SifLine[], framed: boolean, line: number): void {
  try { assertSifAuthority(records, framed); }
  catch (error) { throw new SifParseError(line, 'authoritative', (error as Error).message); }
}

function parseSifRecord(raw: string, lineNumber: number, enforce: boolean): SifLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new SifParseError(lineNumber, '', `not valid JSON (${reason}); text was ${excerpt(raw)}`);
  }

  const obj = asObject(parsed, lineNumber, '');
  const t = obj['t'];
  if (typeof t !== 'string') {
    throw new SifParseError(
      lineNumber,
      't',
      `missing the SIF line discriminator; expected a string "run", "status", "node" or "edge", got ${describe(t)}`,
    );
  }

  switch (t) {
    case 'run': {
      rejectUnknownKeys(obj, new Set(['t', 'run']), lineNumber, '');
      return { t: 'run', run: parseRun(asObject(obj['run'], lineNumber, 'run'), lineNumber, 'run') };
    }
    case 'status': {
      rejectUnknownKeys(obj, new Set(['t', 'result']), lineNumber, '');
      return {
        t: 'status',
        result: parseResult(asObject(obj['result'], lineNumber, 'result'), lineNumber, 'result'),
      };
    }
    case 'node': {
      rejectUnknownKeys(obj, new Set(['t', 'node']), lineNumber, '');
      return { t: 'node', node: parseNode(asObject(obj['node'], lineNumber, 'node'), lineNumber, enforce) };
    }
    case 'edge': {
      rejectUnknownKeys(obj, new Set(['t', 'edge']), lineNumber, '');
      return { t: 'edge', edge: parseEdge(asObject(obj['edge'], lineNumber, 'edge'), lineNumber, enforce) };
    }
    default:
      throw new SifParseError(
        lineNumber,
        't',
        `${JSON.stringify(t)} is not a SIF line type; expected one of run, status, node, edge`,
      );
  }
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

function parseNode(obj: Record<string, unknown>, line: number, enforce: boolean): SeamlineNode {
  rejectTimestampKeys(obj, line, 'node');
  rejectUnknownKeys(obj, NODE_FIELDS, line, 'node');

  const id = requireNonEmptyString(obj, 'id', line, 'node');
  const kind = requireEnum(obj, 'kind', NODE_KIND_SET, NODE_KINDS, line, 'node', 'node kind') as NodeKind;

  let parsedId: { repo: string; kind: NodeKind; canonicalName: string };
  try {
    parsedId = parseNodeId(id as NodeId);
  } catch {
    throw new SifParseError(
      line,
      'node.id',
      `${JSON.stringify(id)} is not a NodeId; expected the natural key {repo}:{kind}:{canonicalName} (v3 §2.1)`,
    );
  }
  if (parsedId.kind !== kind) {
    throw new SifParseError(
      line,
      'node.id',
      `id encodes kind ${JSON.stringify(parsedId.kind)} but node.kind is ${JSON.stringify(kind)}; ` +
        'the id is the natural key and must agree with the kind',
    );
  }

  const node: Record<string, unknown> = {
    id: id as NodeId,
    kind,
    name: requireString(obj, 'name', line, 'node'),
    sensitivity: requireEnum(obj, 'sensitivity', SENSITIVITY_SET, SENSITIVITY, line, 'node', 'sensitivity') as Sensitivity,
    provenance: requireEnum(obj, 'provenance', PROVENANCE_SET, PROVENANCE, line, 'node', 'provenance') as Provenance,
    confidence: requireConfidence(obj, 'confidence', line, 'node'),
    props: requireProps(obj, line, 'node'),
    firstSeenRun: requireNonEmptyString(obj, 'firstSeenRun', line, 'node'),
    lastSeenRun: requireNonEmptyString(obj, 'lastSeenRun', line, 'node'),
    deletedAt: requireNullableString(obj, 'deletedAt', line, 'node'),
  };

  const path = optionalString(obj, 'path', line, 'node');
  if (path !== undefined) node['path'] = path;
  const sourceRef = optionalString(obj, 'sourceRef', line, 'node');
  if (sourceRef !== undefined) node['sourceRef'] = sourceRef;
  const untrusted = optionalBoolean(obj, 'untrusted', line, 'node');
  if (untrusted !== undefined) node['untrusted'] = untrusted;

  const result = node as unknown as SeamlineNode;
  if (enforce) rethrowCanonical(line, () => assertCleanNodeBody(result));
  return result;
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

function parseEdge(obj: Record<string, unknown>, line: number, enforce: boolean): SeamlineEdge {
  rejectTimestampKeys(obj, line, 'edge');
  rejectUnknownKeys(obj, EDGE_FIELDS, line, 'edge');

  const kind = requireEnum(obj, 'kind', EDGE_KIND_SET, EDGE_KINDS, line, 'edge', 'edge kind') as EdgeKind;
  const src = requireNonEmptyString(obj, 'src', line, 'edge');
  const dst = requireNonEmptyString(obj, 'dst', line, 'edge');

  const srcKind = endpointKind(src, line, 'edge.src');
  const dstKind = endpointKind(dst, line, 'edge.dst');

  if (!NODE_KIND_SET.has(srcKind)) {
    throw new SifParseError(
      line,
      'edge.src',
      `endpoint id ${JSON.stringify(src)} encodes kind ${JSON.stringify(srcKind)}, which is not a known node kind`,
    );
  }
  if (!NODE_KIND_SET.has(dstKind)) {
    throw new SifParseError(
      line,
      'edge.dst',
      `endpoint id ${JSON.stringify(dst)} encodes kind ${JSON.stringify(dstKind)}, which is not a known node kind`,
    );
  }
  if (!isValidEdge(kind, srcKind, dstKind)) {
    throw new SifParseError(
      line,
      'edge.kind',
      `${kind} is not declared for ${srcKind} -> ${dstKind}; ` +
        `EDGE_SIGNATURES[${kind}] allows ${formatSignatures(kind)} (v3 §4)`,
    );
  }

  const edge: Record<string, unknown> = {
    kind,
    src: src as NodeId,
    dst: dst as NodeId,
    provenance: requireEnum(obj, 'provenance', PROVENANCE_SET, PROVENANCE, line, 'edge', 'provenance') as Provenance,
    confidence: requireConfidence(obj, 'confidence', line, 'edge'),
    props: requireProps(obj, line, 'edge'),
    firstSeenRun: requireNonEmptyString(obj, 'firstSeenRun', line, 'edge'),
    lastSeenRun: requireNonEmptyString(obj, 'lastSeenRun', line, 'edge'),
    deletedAt: requireNullableString(obj, 'deletedAt', line, 'edge'),
  };

  const srcFile = optionalString(obj, 'srcFile', line, 'edge');
  if (srcFile !== undefined) edge['srcFile'] = srcFile;
  const dstFile = optionalString(obj, 'dstFile', line, 'edge');
  if (dstFile !== undefined) edge['dstFile'] = dstFile;
  const sourceRef = optionalString(obj, 'sourceRef', line, 'edge');
  if (sourceRef !== undefined) edge['sourceRef'] = sourceRef;

  const result = edge as unknown as SeamlineEdge;
  if (enforce) rethrowCanonical(line, () => assertCleanEdgeBody(result));
  return result;
}

function endpointKind(id: string, line: number, field: string): NodeKind {
  try {
    return parseNodeId(id as NodeId).kind;
  } catch {
    throw new SifParseError(
      line,
      field,
      `${JSON.stringify(id)} is not a NodeId; expected the natural key {repo}:{kind}:{canonicalName} (v3 §2.1)`,
    );
  }
}

/** The declared endpoint pairs, for the error message only; the decision is `isValidEdge`. */
function formatSignatures(kind: EdgeKind): string {
  const pairs = EDGE_SIGNATURES[kind];
  if (pairs.length === 0) return '(none)';
  return pairs.map(([s, d]) => `${s} -> ${d}`).join(', ');
}

// ---------------------------------------------------------------------------
// Run and status
// ---------------------------------------------------------------------------

function parseRun(obj: Record<string, unknown>, line: number, prefix: string): RunRecord {
  rejectUnknownKeys(obj, RUN_FIELDS, line, prefix);
  const rawResults = obj['results'];
  if (!Array.isArray(rawResults)) {
    throw new SifParseError(line, `${prefix}.results`, `expected an array, got ${describe(rawResults)}`);
  }
  const results = rawResults.map((r, i) =>
    parseResult(asObject(r, line, `${prefix}.results[${i}]`), line, `${prefix}.results[${i}]`),
  );
  return {
    runId: requireNonEmptyString(obj, 'runId', line, prefix),
    repo: requireNonEmptyString(obj, 'repo', line, prefix),
    commit: requireNullableString(obj, 'commit', line, prefix),
    startedAt: requireNonEmptyString(obj, 'startedAt', line, prefix),
    finishedAt: requireNullableString(obj, 'finishedAt', line, prefix),
    ontologyVersion: requireNonEmptyString(obj, 'ontologyVersion', line, prefix),
    results,
  };
}

function parseResult(obj: Record<string, unknown>, line: number, prefix: string): ExtractorResult {
  rejectUnknownKeys(obj, RESULT_FIELDS, line, prefix);
  const rawScopes = obj['authoritative'];
  if (!Array.isArray(rawScopes)) {
    throw new SifParseError(line, `${prefix}.authoritative`, `expected an array, got ${describe(rawScopes)}`);
  }
  const authoritative = rawScopes.map((s, i) =>
    parseScope(asObject(s, line, `${prefix}.authoritative[${i}]`), line, `${prefix}.authoritative[${i}]`),
  );
  return {
    extractor: requireNonEmptyString(obj, 'extractor', line, prefix),
    version: requireNonEmptyString(obj, 'version', line, prefix),
    status: requireEnum(obj, 'status', STATUS_SET, EXTRACTOR_STATUS, line, prefix, 'extractor status') as ExtractorStatus,
    authoritative,
    nodeCount: requireNonNegativeInteger(obj, 'nodeCount', line, prefix),
    edgeCount: requireNonNegativeInteger(obj, 'edgeCount', line, prefix),
    durationMs: requireNonNegativeInteger(obj, 'durationMs', line, prefix),
    diagnostics: requireStringArray(obj, 'diagnostics', line, prefix),
  };
}

function parseScope(obj: Record<string, unknown>, line: number, prefix: string): AuthoritativeScope {
  rejectUnknownKeys(obj, SCOPE_FIELDS, line, prefix);
  const rawKinds = obj['kinds'];
  if (!Array.isArray(rawKinds)) {
    throw new SifParseError(line, `${prefix}.kinds`, `expected an array of node kinds, got ${describe(rawKinds)}`);
  }
  const kinds = rawKinds.map((k, i) => {
    if (typeof k !== 'string' || !NODE_KIND_SET.has(k)) {
      throw new SifParseError(
        line,
        `${prefix}.kinds[${i}]`,
        `${describe(k)} is not a known node kind; expected one of NODE_KINDS (${listSome(NODE_KINDS)})`,
      );
    }
    return k as NodeKind;
  });
  const scope: Record<string, unknown> = {
    scope: requireNonEmptyString(obj, 'scope', line, prefix),
    kinds,
  };
  const selector = optionalString(obj, 'selector', line, prefix);
  if (selector !== undefined) scope['selector'] = selector;
  return scope as unknown as AuthoritativeScope;
}

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

function asObject(value: unknown, line: number, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SifParseError(line, field, `expected a JSON object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  line: number,
  prefix: string,
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue;
    throw new SifParseError(
      line,
      prefix.length > 0 ? `${prefix}.${key}` : key,
      `unknown field; the contract declares ${listSome([...allowed], 16)}. ` +
        'Extension data belongs in `props`, which is where it stays round-trippable.',
    );
  }
}

function rejectTimestampKeys(obj: Record<string, unknown>, line: number, prefix: string): void {
  for (const key of Object.keys(obj)) {
    if (!isTimestampField(key)) continue;
    throw new SifParseError(
      line,
      `${prefix}.${key}`,
      'wall-clock timestamp field is not allowed on a fact; time belongs to the Run record, not to a node or edge (v3 §2.3). ' +
        'The contract omits createdAt/updatedAt deliberately: they alone make byte-identical output impossible.',
    );
  }
}

function requireString(obj: Record<string, unknown>, key: string, line: number, prefix: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new SifParseError(line, `${prefix}.${key}`, `expected a string, got ${describe(value)}`);
  }
  return value;
}

function requireNonEmptyString(obj: Record<string, unknown>, key: string, line: number, prefix: string): string {
  const value = requireString(obj, key, line, prefix);
  if (value.length === 0) {
    throw new SifParseError(line, `${prefix}.${key}`, 'expected a non-empty string, got ""');
  }
  return value;
}

function requireNullableString(obj: Record<string, unknown>, key: string, line: number, prefix: string): string | null {
  if (!(key in obj)) {
    throw new SifParseError(line, `${prefix}.${key}`, 'is required; expected a string or null, but the field is absent');
  }
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new SifParseError(line, `${prefix}.${key}`, `expected a string or null, got ${describe(value)}`);
  }
  return value;
}

function optionalString(obj: Record<string, unknown>, key: string, line: number, prefix: string): string | undefined {
  if (!(key in obj)) return undefined;
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new SifParseError(line, `${prefix}.${key}`, `expected a string when present, got ${describe(value)}`);
  }
  return value;
}

function optionalBoolean(obj: Record<string, unknown>, key: string, line: number, prefix: string): boolean | undefined {
  if (!(key in obj)) return undefined;
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new SifParseError(line, `${prefix}.${key}`, `expected a boolean when present, got ${describe(value)}`);
  }
  return value;
}

function requireEnum(
  obj: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
  vocabulary: ReadonlyArray<string>,
  line: number,
  prefix: string,
  label: string,
): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new SifParseError(line, `${prefix}.${key}`, `expected a ${label} string, got ${describe(value)}`);
  }
  if (!allowed.has(value)) {
    const hint = nearest(value, vocabulary);
    throw new SifParseError(
      line,
      `${prefix}.${key}`,
      `${JSON.stringify(value)} is not a known ${label}; expected one of ${listSome(vocabulary)}` +
        (hint === null ? '' : `. Did you mean ${JSON.stringify(hint)}?`),
    );
  }
  return value;
}

function requireConfidence(obj: Record<string, unknown>, key: string, line: number, prefix: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SifParseError(line, `${prefix}.${key}`, `expected a finite number in [0, 1], got ${describe(value)}`);
  }
  if (value < 0 || value > 1) {
    throw new SifParseError(line, `${prefix}.${key}`, `expected a number in [0, 1], got ${String(value)}`);
  }
  return value;
}

function requireNonNegativeInteger(obj: Record<string, unknown>, key: string, line: number, prefix: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SifParseError(line, `${prefix}.${key}`, `expected a non-negative integer, got ${describe(value)}`);
  }
  return value;
}

function requireStringArray(obj: Record<string, unknown>, key: string, line: number, prefix: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new SifParseError(line, `${prefix}.${key}`, `expected an array of strings, got ${describe(value)}`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== 'string') {
      throw new SifParseError(line, `${prefix}.${key}[${i}]`, `expected a string, got ${describe(entry)}`);
    }
    return entry;
  });
}

function requireProps(
  obj: Record<string, unknown>,
  line: number,
  prefix: string,
): Record<string, string | number | boolean | null> {
  const value = obj['props'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SifParseError(line, `${prefix}.props`, `expected a JSON object, got ${describe(value)}`);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') {
      out[key] = entry;
      continue;
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) {
        throw new SifParseError(
          line,
          `${prefix}.props.${key}`,
          `expected a finite number, got ${String(entry)}`,
        );
      }
      out[key] = entry;
      continue;
    }
    throw new SifParseError(
      line,
      `${prefix}.props.${key}`,
      `props values must be string, number, boolean or null; got ${describe(entry)}. ` +
        'Nested structure is not allowed: it has no canonical merge semantics.',
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rethrowCanonical(line: number, fn: () => void): void {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof CanonicalizationError) {
      throw new SifParseError(line, cause.field, cause.detail);
    }
    throw cause;
  }
}

function stripCarriageReturn(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined (field absent)';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array (length ${value.length})`;
  const type = typeof value;
  if (type === 'object') return 'an object';
  if (type === 'string') return `the string ${JSON.stringify(value)}`;
  return `${type} ${String(value)}`;
}

function excerpt(s: string, max = 120): string {
  const oneLine = s.length <= max ? s : `${s.slice(0, max)}…`;
  return JSON.stringify(oneLine);
}

/** Cheap edit-distance-1-ish suggestion, for "did you mean" on a misspelled kind. */
function nearest(value: string, vocabulary: ReadonlyArray<string>): string | null {
  const lower = value.toLowerCase();
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of vocabulary) {
    const score = distance(lower, candidate.toLowerCase(), 3);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= 2 ? best : null;
}

function distance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }
  return previous[b.length] as number;
}
