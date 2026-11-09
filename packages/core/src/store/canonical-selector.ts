/** ADR-0018 literal, source-confined authority metadata. No query language. */
import { Buffer } from 'node:buffer';
import type { AuthoritativeScope } from '@seamline/ontology';
import { createRedactor } from '@seamline/security';
import { isAbsoluteLike } from '../sif/canonicalize.ts';
import { SelectorError } from './selector-error.ts';

export const CANONICAL_SELECTOR_PREFIX = '/@canonical/v1/';
export const MAX_CANONICAL_SELECTOR_BYTES = 65_536;
export const MAX_CANONICAL_SELECTOR_RULES = 2_048;

export type CanonicalRule = readonly ['exact' | 'prefix', string];
export interface CanonicalSelectorInput {
  readonly path: string;
  readonly rules: readonly CanonicalRule[];
}
export interface CompiledCanonicalSelector extends CanonicalSelectorInput {
  readonly domain: 'canonical';
  readonly selector: string;
  /** Literal names only; scope matching must also check path, repo and kind. */
  matchesName(name: string): boolean;
}

const BAD_SCALAR = /[\u0000-\u001f\u007f\ud800-\udfff]/u;
const LOWER_HEX = /^[0-9a-f]+$/;

export function isCanonicalSelectorText(selector: string): boolean {
  return selector.startsWith('/@canonical/');
}

function validScalar(value: string): boolean {
  return value.length > 0 && !BAD_SCALAR.test(value);
}

function validate(input: unknown, selector: string, remainingRules = MAX_CANONICAL_SELECTOR_RULES): CanonicalSelectorInput {
  const fail = (reason: string): never => { throw new SelectorError(selector, reason); };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('canonical body must be an object');
  const object = input as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== 2 || !keys.includes('path') || !keys.includes('rules')) fail('canonical keys must be path and rules');
  const path = object['path'];
  if (typeof path !== 'string' || !validScalar(path)) fail('canonical path must be a nonempty Unicode scalar string');
  const sourcePath = path as string;
  if (Buffer.byteLength(sourcePath, 'utf8') * 2 > MAX_CANONICAL_SELECTOR_BYTES) fail('canonical byte budget exceeded');
  if (isAbsoluteLike(sourcePath) || sourcePath.includes('\\') ||
      sourcePath.split('/').some(part => part.length === 0 || part === '.' || part === '..'))
    fail('canonical path must be literal repo-relative POSIX without dot or empty segments');
  const values = object['rules'];
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_CANONICAL_SELECTOR_RULES)
    fail('canonical rule count must be 1 through 2048');
  if ((values as unknown[]).length > remainingRules) fail('aggregate canonical rule budget exceeded');
  const rules: CanonicalRule[] = [];
  for (const value of values as unknown[]) {
    if (!Array.isArray(value) || value.length !== 2 ||
        (value[0] !== 'exact' && value[0] !== 'prefix') || typeof value[1] !== 'string' || !validScalar(value[1]))
      throw new SelectorError(selector, 'canonical rules require an operation and a nonempty Unicode scalar literal');
    rules.push(Object.freeze([value[0], value[1]]) as CanonicalRule);
  }
  return { path: sourcePath, rules: Object.freeze(rules) };
}

function compareRules(a: CanonicalRule, b: CanonicalRule): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return Buffer.compare(Buffer.from(a[1], 'utf8'), Buffer.from(b[1], 'utf8'));
}

/** Produce the single byte representation; input count is capped before copying. */
export function encodeCanonicalSelector(input: CanonicalSelectorInput): string {
  const parsed = validate(input, CANONICAL_SELECTOR_PREFIX);
  // Reject oversized literals before sorting or serializing them. The complete
  // JSON/hex budget is then checked before allocating its byte buffer.
  let literalBytes = Buffer.byteLength(parsed.path, 'utf8');
  for (const rule of parsed.rules) {
    literalBytes += Buffer.byteLength(rule[1], 'utf8');
    if (literalBytes * 2 > MAX_CANONICAL_SELECTOR_BYTES)
      throw new SelectorError(CANONICAL_SELECTOR_PREFIX, 'canonical byte budget exceeded');
  }
  if (literalBytes * 2 > MAX_CANONICAL_SELECTOR_BYTES)
    throw new SelectorError(CANONICAL_SELECTOR_PREFIX, 'canonical byte budget exceeded');
  // Encoding cannot hide a credential in an identity or source locator.
  // Keep budget checks ahead of scans and never put the literal in an owner label.
  const redactor = createRedactor();
  redactor.guardStructural(parsed.path, 'canonical.path', 'canonical authority');
  for (const rule of parsed.rules)
    redactor.guardStructural(rule[1], 'canonical.rule', 'canonical authority');
  const ordered = [...parsed.rules].sort(compareRules);
  const rules = ordered.filter((rule, index) => index === 0 || compareRules(rule, ordered[index - 1] as CanonicalRule) !== 0);
  const json = JSON.stringify({ path: parsed.path, rules });
  if (CANONICAL_SELECTOR_PREFIX.length + Buffer.byteLength(json, 'utf8') * 2 > MAX_CANONICAL_SELECTOR_BYTES)
    throw new SelectorError(CANONICAL_SELECTOR_PREFIX, 'canonical byte budget exceeded');
  return CANONICAL_SELECTOR_PREFIX + Buffer.from(json, 'utf8').toString('hex');
}

/** Check the envelope before decoding or allocating a rules buffer. */
export function compileCanonicalSelector(selector: string): CompiledCanonicalSelector {
  return compileWithRuleBudget(selector, MAX_CANONICAL_SELECTOR_RULES);
}

function compileWithRuleBudget(selector: string, remainingRules: number): CompiledCanonicalSelector {
  const fail = (reason: string): never => { throw new SelectorError(selector, reason); };
  if (Buffer.byteLength(selector, 'utf8') > MAX_CANONICAL_SELECTOR_BYTES) fail('canonical byte budget exceeded');
  if (!selector.startsWith(CANONICAL_SELECTOR_PREFIX)) fail('unknown canonical selector version');
  const hex = selector.slice(CANONICAL_SELECTOR_PREFIX.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !LOWER_HEX.test(hex)) fail('canonical body requires lowercase UTF-8 hex');
  const bytes = Buffer.from(hex, 'hex');
  const json = bytes.toString('utf8');
  if (Buffer.from(json, 'utf8').toString('hex') !== hex) fail('canonical body has invalid UTF-8');
  let input: unknown;
  try { input = JSON.parse(json) as unknown; }
  catch { fail('canonical body is not JSON'); }
  const parsed = validate(input, selector, remainingRules);
  if (encodeCanonicalSelector(parsed) !== selector) fail('canonical body must use sorted unique rules and compact canonical JSON');
  return Object.freeze({
    domain: 'canonical' as const,
    selector,
    path: parsed.path,
    rules: parsed.rules,
    matchesName: (name: string): boolean => typeof name === 'string' && validScalar(name) &&
      parsed.rules.some(([operation, value]) => operation === 'exact' ? name === value : name.startsWith(value)),
  });
}

/** Internal preflight, also used across repeated SIF metadata representations. */
export function canonicalEncodedClaims(scopes: readonly AuthoritativeScope[]): AuthoritativeScope[] {
  const selected: AuthoritativeScope[] = [];
  let bytes = 0;
  for (const scope of scopes) {
    if (scope.selector === undefined || !isCanonicalSelectorText(scope.selector)) continue;
    bytes += Buffer.byteLength(scope.selector, 'utf8');
    if (bytes > MAX_CANONICAL_SELECTOR_BYTES)
      throw new SelectorError(CANONICAL_SELECTOR_PREFIX, 'aggregate canonical byte budget exceeded');
    selected.push(scope);
  }
  return selected;
}

/** Aggregate encoded bytes are checked for the whole batch before any decode. */
export function assertCanonicalSelectorBudget(scopes: readonly AuthoritativeScope[]): void {
  const selected = canonicalEncodedClaims(scopes);
  let count = 0;
  for (const scope of selected) {
    if (scope.kinds.length === 0) throw new SelectorError(scope.selector as string, 'canonical claims need node kinds');
    count += compileWithRuleBudget(scope.selector as string, MAX_CANONICAL_SELECTOR_RULES - count).rules.length;
    if (count > MAX_CANONICAL_SELECTOR_RULES)
      throw new SelectorError(CANONICAL_SELECTOR_PREFIX, 'aggregate canonical rule budget exceeded');
  }
}
