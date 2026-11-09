/**
 * The environment every probe reads: the evaluated tree, discovered packages,
 * the facts source with its scope table, the parser, and the bounds. Built once
 * per evaluation; probes memoise their scans on `cache`.
 */

import type { AlignFacts, ScopeEntry } from './facts.ts';
import type { TsModule } from './ts.ts';
import type { Tree } from './tree.ts';
import { unknownFact, type ProbeFact } from './types.ts';
import type { Discovery } from './workspace.ts';

/** Bounds (3.1). All fail-safe: an exceeded bound is `limit-exceeded`, never absence. */
export interface Limits {
  readonly maxDocuments: number;
  readonly maxDocumentBytes: number;
  readonly maxLineLength: number;
  readonly maxClaims: number;
  readonly maxFindings: number;
  readonly maxSourceFiles: number;
  readonly maxSourceBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxDocuments: 2000,
  maxDocumentBytes: 1024 * 1024,
  maxLineLength: 4096,
  maxClaims: 10000,
  maxFindings: 5000,
  maxSourceFiles: 5000,
  maxSourceBytes: 1024 * 1024,
};

/** The package that is this tool. Its lexicons name every format, so `format-witness` leaves it out (4.2). */
export const INSTRUMENT_PACKAGE = '@seamline/align';

export interface ProbeEnv {
  readonly tree: Tree;
  readonly commit: string | null;
  readonly discovery: Discovery;
  readonly facts: AlignFacts;
  readonly scopes: ReadonlyMap<string, ScopeEntry>;
  /** Non-null when a supplying run carries another commit (5.1). */
  readonly runMismatch: string | null;
  readonly ts: TsModule | null;
  readonly limits: Limits;
  readonly cache: Map<string, unknown>;
}

export function memo<T>(env: ProbeEnv, key: string, compute: () => T): T {
  if (env.cache.has(key)) return env.cache.get(key) as T;
  const value = compute();
  env.cache.set(key, value);
  return value;
}

/**
 * The gate `format-witness` and `module-wiring` apply before reading anything
 * (4.2 step 1, 4.4): the commit rule, then `code.ts` must be declared and
 * `PASS`. A scope that no result declares is not declared, and a scope that is
 * not declared is not `PASS` (5.1).
 */
export function codeScopeGate(env: ProbeEnv): ProbeFact | null {
  if (env.runMismatch !== null) return unknownFact('run-commit-mismatch', env.runMismatch);
  const entry = env.scopes.get('code.ts');
  if (entry === undefined)
    return unknownFact('scope-not-pass', 'code.ts: not declared by any result of the run', {
      scopes: ['code.ts'],
    });
  if (entry.status !== 'PASS')
    return unknownFact('scope-not-pass', `code.ts: ${entry.status}`, { scopes: ['code.ts'] });
  return null;
}
