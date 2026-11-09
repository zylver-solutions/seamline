/**
 * Loader and schema for the public injection corpus (`corpus/*.json`).
 *
 * The corpus is data, not code: two JSON files that a contributor can add to
 * without touching TypeScript, and that a downstream tool can run against its
 * own renderer. This module reads and validates them. It is a separate entry
 * point (`@seamline/security/corpus`) so the main entry stays free of file-system
 * access.
 *
 * Two files, one schema family (`seamline-corpus/1`):
 *
 * - `secrets.json`: credential-shaped strings for the redactor. Each entry has an
 *   expected outcome, `redacted` (free text: the value is replaced by a
 *   reference) or `refused` (identity and path fields: the record is rejected,
 *   never rewritten; ADR-0013).
 * - `injections.json`: payloads for the untrusted-content delimiting. The
 *   outcome is always `delimited`: the payload is rendered inside a block that
 *   it cannot escape. Per-renderer `checks` add what must (`present`) and must
 *   not (`absent`) survive in the block body.
 *
 * Every value is written as `parts`: strings joined in order, or
 * `{ "repeat": "x", "times": N }` for long inputs. A credential-shaped value is
 * split so that no part, and no run of the raw file, is itself a credential.
 * A repository secret scanner, or a consumer's scanner reading `node_modules`,
 * therefore finds nothing in the file; the tests assert exactly that.
 *
 * Everything in the corpus is written from scratch for this project and is not
 * derived from any private codebase, any vendor's customer data or any
 * third-party attack list.
 */

import { readFileSync } from 'node:fs';

export const CORPUS_FORMAT = 'seamline-corpus/1';

/** One piece of a value: a literal, or a literal repeated. */
export type Part = string | { readonly repeat: string; readonly times: number };

/** Largest repeated value the loader will assemble, so a typo cannot exhaust memory. */
export const MAX_ASSEMBLED_LENGTH = 1_000_000;

export const SECRET_SURFACES = ['free-text', 'identity'] as const;
export type SecretSurface = (typeof SECRET_SURFACES)[number];

export const SECRET_OUTCOMES = ['redacted', 'refused'] as const;
export type SecretOutcome = (typeof SECRET_OUTCOMES)[number];

/**
 * The defensive rule an injection payload exercises. `inert-text` names a
 * payload that no rule rewrites: it is kept verbatim inside the block, and the
 * block is the only control. Those entries exist so that the corpus records
 * what the layer deliberately does not do (it has no phrase blocklist).
 */
export const INJECTION_RULES = [
  'nonce-fence',
  'token-neutralisation',
  'bracket-collapsing',
  'invisible-stripping',
  'fence-sentinel',
  'role-marker',
  'chat-template-token',
  'closing-tag',
  'truncation',
  'inert-text',
] as const;
export type InjectionRule = (typeof INJECTION_RULES)[number];

/** The two renderers in this package. */
export const RENDERERS = ['fence', 'delimit'] as const;
export type Renderer = (typeof RENDERERS)[number];

export interface SecretCanary {
  readonly id: string;
  readonly category: 'secret';
  /** A `SECRET_RULES` id, or the entropy rule id. */
  readonly rule: string;
  readonly surface: SecretSurface;
  readonly expect: SecretOutcome;
  /** Why this value cannot be a live credential. Required. */
  readonly fakeBecause: string;
  /** The credential-shaped value. */
  readonly secret: string;
  /** The field text an extractor might plausibly have produced, secret included. */
  readonly text: string;
}

export interface RendererChecks {
  /** Substrings that must appear verbatim in the block body. */
  readonly present: ReadonlyArray<string>;
  /** Substrings that must not appear in the block body. */
  readonly absent: ReadonlyArray<string>;
  /** `delimit` only: neutralisation rules that must have fired. */
  readonly hits?: ReadonlyArray<string>;
  /** `delimit` only: whether the body must (or must not) have been truncated. */
  readonly truncated?: boolean;
}

export interface InjectionPayload {
  readonly id: string;
  readonly category: string;
  readonly rule: InjectionRule;
  readonly expect: 'delimited';
  readonly description: string;
  readonly payload: string;
  readonly checks: Readonly<Partial<Record<Renderer, RendererChecks>>>;
}

export interface InjectionCorpus {
  /** The nonce the fence renderer is run with, so a payload can quote it. */
  readonly nonce: string;
  readonly entries: ReadonlyArray<InjectionPayload>;
}

export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusError';
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function fail(where: string, message: string): never {
  throw new CorpusError(`${where}: ${message}`);
}

function asObject(value: unknown, where: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(where, 'expected an object');
  }
  return value as Json;
}

function exactKeys(
  obj: Json,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
  where: string,
): void {
  for (const key of required) {
    if (!(key in obj)) fail(where, `missing "${key}"`);
  }
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) fail(where, `unknown key "${key}"`);
  }
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(where, 'expected a non-empty string');
  return value;
}

function asOneOf<T extends string>(value: unknown, allowed: ReadonlyArray<T>, where: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(where, `expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function asStringArray(value: unknown, where: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) fail(where, 'expected an array of strings');
  return value.map((v, i) => {
    if (typeof v !== 'string') fail(`${where}[${i}]`, 'expected a string');
    return v;
  });
}

/** Joins `parts`. An empty parts list is an error: an empty value tests nothing. */
export function assembleParts(value: unknown, where: string): string {
  if (!Array.isArray(value) || value.length === 0)
    fail(where, 'expected a non-empty array of parts');
  let out = '';
  value.forEach((part: unknown, i) => {
    const at = `${where}[${i}]`;
    if (typeof part === 'string') {
      out += part;
    } else {
      const obj = asObject(part, at);
      exactKeys(obj, ['repeat', 'times'], [], at);
      const unit = asString(obj['repeat'], `${at}.repeat`);
      const times = obj['times'];
      if (typeof times !== 'number' || !Number.isInteger(times) || times < 1) {
        fail(`${at}.times`, 'expected a positive integer');
      }
      if (out.length + unit.length * times > MAX_ASSEMBLED_LENGTH) {
        fail(at, `assembled value would exceed ${MAX_ASSEMBLED_LENGTH} characters`);
      }
      out += unit.repeat(times);
    }
    if (out.length > MAX_ASSEMBLED_LENGTH)
      fail(where, `assembled value exceeds ${MAX_ASSEMBLED_LENGTH} characters`);
  });
  return out;
}

function header(root: Json, kind: string, where: string): ReadonlyArray<unknown> {
  if (root['format'] !== CORPUS_FORMAT) fail(where, `"format" must be "${CORPUS_FORMAT}"`);
  if (root['kind'] !== kind) fail(where, `"kind" must be "${kind}"`);
  const entries = root['entries'];
  if (!Array.isArray(entries) || entries.length === 0)
    fail(where, '"entries" must be a non-empty array');
  return entries;
}

function uniqueId(seen: Set<string>, id: string, where: string): void {
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(id)) {
    fail(where, `id "${id}" must look like "<group>/<slug>" in lower-case kebab-case`);
  }
  if (seen.has(id)) fail(where, `duplicate id "${id}"`);
  seen.add(id);
}

/** Placeholder a secret `text` template uses for the credential. */
export const SECRET_PLACEHOLDER = '{{secret}}';

// ---------------------------------------------------------------------------
// secrets.json
// ---------------------------------------------------------------------------

export function parseSecretCorpus(json: unknown): ReadonlyArray<SecretCanary> {
  const root = asObject(json, 'secrets corpus');
  exactKeys(root, ['format', 'kind', 'description', 'entries'], [], 'secrets corpus');
  const seen = new Set<string>();
  return header(root, 'secrets', 'secrets corpus').map((raw, i) => {
    const where = `secrets corpus entry ${i}`;
    const e = asObject(raw, where);
    exactKeys(
      e,
      ['id', 'category', 'rule', 'surface', 'expect', 'fakeBecause', 'template', 'secret'],
      [],
      where,
    );
    const id = asString(e['id'], `${where}.id`);
    uniqueId(seen, id, where);
    if (e['category'] !== 'secret') fail(`${where}.category`, 'must be "secret"');
    const surface = asOneOf(e['surface'], SECRET_SURFACES, `${id}.surface`);
    const expect = asOneOf(e['expect'], SECRET_OUTCOMES, `${id}.expect`);
    if ((surface === 'free-text') !== (expect === 'redacted')) {
      fail(id, 'a free-text surface is "redacted" and an identity surface is "refused"');
    }
    const template = assembleParts(e['template'], `${id}.template`);
    if (template.split(SECRET_PLACEHOLDER).length !== 2) {
      fail(`${id}.template`, `must contain ${SECRET_PLACEHOLDER} exactly once`);
    }
    const secret = assembleParts(e['secret'], `${id}.secret`);
    return {
      id,
      category: 'secret' as const,
      rule: asString(e['rule'], `${id}.rule`),
      surface,
      expect,
      fakeBecause: asString(e['fakeBecause'], `${id}.fakeBecause`),
      secret,
      text: template.replace(SECRET_PLACEHOLDER, () => secret),
    };
  });
}

// ---------------------------------------------------------------------------
// injections.json
// ---------------------------------------------------------------------------

function parseChecks(value: unknown, where: string): RendererChecks {
  const obj = asObject(value, where);
  exactKeys(obj, [], ['present', 'absent', 'hits', 'truncated'], where);
  const checks: {
    present: ReadonlyArray<string>;
    absent: ReadonlyArray<string>;
    hits?: ReadonlyArray<string>;
    truncated?: boolean;
  } = {
    present: obj['present'] === undefined ? [] : asStringArray(obj['present'], `${where}.present`),
    absent: obj['absent'] === undefined ? [] : asStringArray(obj['absent'], `${where}.absent`),
  };
  if (obj['hits'] !== undefined) checks.hits = asStringArray(obj['hits'], `${where}.hits`);
  if (obj['truncated'] !== undefined) {
    if (typeof obj['truncated'] !== 'boolean') fail(`${where}.truncated`, 'expected a boolean');
    checks.truncated = obj['truncated'];
  }
  return checks;
}

export function parseInjectionCorpus(json: unknown): InjectionCorpus {
  const root = asObject(json, 'injection corpus');
  exactKeys(root, ['format', 'kind', 'description', 'nonce', 'entries'], [], 'injection corpus');
  const nonce = asString(root['nonce'], 'injection corpus.nonce');
  if (!/^[A-Za-z0-9]{8,64}$/.test(nonce))
    fail('injection corpus.nonce', 'must be 8 to 64 alphanumeric characters');
  const seen = new Set<string>();
  const entries = header(root, 'injections', 'injection corpus').map((raw, i): InjectionPayload => {
    const where = `injection corpus entry ${i}`;
    const e = asObject(raw, where);
    exactKeys(e, ['id', 'category', 'rule', 'expect', 'description', 'payload'], ['checks'], where);
    const id = asString(e['id'], `${where}.id`);
    uniqueId(seen, id, where);
    if (e['expect'] !== 'delimited') fail(`${id}.expect`, 'must be "delimited"');
    const checksIn = e['checks'] === undefined ? {} : asObject(e['checks'], `${id}.checks`);
    const checks: Partial<Record<Renderer, RendererChecks>> = {};
    for (const key of Object.keys(checksIn)) {
      const renderer = asOneOf(key, RENDERERS, `${id}.checks`);
      const parsed = parseChecks(checksIn[key], `${id}.checks.${renderer}`);
      if (renderer === 'fence' && (parsed.hits !== undefined || parsed.truncated !== undefined)) {
        fail(`${id}.checks.fence`, '"hits" and "truncated" apply to the delimit renderer only');
      }
      checks[renderer] = parsed;
    }
    return {
      id,
      category: asString(e['category'], `${id}.category`),
      rule: asOneOf(e['rule'], INJECTION_RULES, `${id}.rule`),
      expect: 'delimited',
      description: asString(e['description'], `${id}.description`),
      payload: assembleParts(e['payload'], `${id}.payload`),
      checks,
    };
  });
  return { nonce, entries };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function readCorpusFile(name: string): unknown {
  // Resolved from this module, so it works from `src/` (tests) and from
  // `dist/` (installed): both sit one level below the package root.
  const url = new URL(`../corpus/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

/** The raw text of a corpus file, for tests that must inspect the bytes shipped. */
export function readCorpusText(name: 'secrets.json' | 'injections.json'): string {
  return readFileSync(new URL(`../corpus/${name}`, import.meta.url), 'utf8');
}

export function loadSecretCanaries(): ReadonlyArray<SecretCanary> {
  return parseSecretCorpus(readCorpusFile('secrets.json'));
}

export function loadInjectionCorpus(): InjectionCorpus {
  return parseInjectionCorpus(readCorpusFile('injections.json'));
}

/** One canary by id; throws when it does not exist, so a renamed entry fails loudly. */
export function secretCanary(id: string): SecretCanary {
  const found = loadSecretCanaries().find((c) => c.id === id);
  if (found === undefined) throw new CorpusError(`no secret canary with id "${id}"`);
  return found;
}
