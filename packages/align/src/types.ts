/**
 * Shared vocabulary of the alignment engine (design sections 2, 3.3 and 5.2).
 * Nothing here touches the ontology contract: claims are not graph nodes.
 */

export const CLAIM_KINDS = [
  'RUNTIME_FLOOR',
  'OUTPUT_FORMAT_SET',
  'DETECTOR_LIVENESS',
  'CONTROL_ENFORCEMENT',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const POLARITIES = ['AFFIRM', 'DEFERRED', 'ABSENT'] as const;
export type Polarity = (typeof POLARITIES)[number];

/** The extractor name and version recorded on every claim (3.3). */
export const DOCS_EXTRACTOR = { name: 'align-docs', version: '1' } as const;

export interface ClaimSource {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly commit: string | null;
  readonly extractor: { readonly name: string; readonly version: string };
}

/** A statement a document makes (3.3). Provenance is always `DECLARED`: a human wrote it. */
export interface Claim {
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly member: string | null;
  readonly polarity: Polarity;
  readonly value: string | boolean | null;
  readonly provenance: 'DECLARED';
  readonly source: ClaimSource;
  /** Normalised text of the unit, at most 240 characters. Untrusted; redacted before it leaves. */
  readonly excerpt: string;
  /** SHA-256 of the canonical JSON of `{ kind, subject, member, polarity, value }`. */
  readonly digest: string;
}

/** What the engine keeps beside a claim and the packet does not carry. */
export interface ClaimExtras {
  /** `RUNTIME_FLOOR`: the runtime the claim names. */
  readonly runtime?: 'node' | 'pnpm';
  /** `CONTROL_ENFORCEMENT`: paths from code spans of the row that exist in the tree (binding B1). */
  readonly boundPaths?: readonly string[];
  /** `CONTROL_ENFORCEMENT`: the row's second cell, for proposals. */
  readonly secondCell?: string;
}

export type ClaimRecord = Claim & { readonly extras: ClaimExtras };

// ---------------------------------------------------------------------------
// Probe results
// ---------------------------------------------------------------------------

/** The closed reason set for Unknown (5.2). */
export const UNKNOWN_REASONS = [
  'scope-not-pass',
  'probe-failed',
  'source-unreadable',
  'manifest-unparseable',
  'unsupported-range',
  'non-extracted-anchor',
  'claim-unanchored',
  'reads-unresolvable',
  'run-commit-mismatch',
  'facts-missing',
  'limit-exceeded',
  'cannot-confirm-presence',
  'no-source-roots',
  'cross-package-unobservable',
  'no-static-consumer',
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

export type ProbeName = 'manifest-field' | 'format-witness' | 'detector-liveness' | 'module-wiring';
export type Completeness = 'exact' | 'absence-sound' | 'presence-only';

export interface FactSource {
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** One probe's reading of the implementation for one claim or subject (5.1 to 5.4). */
export interface ProbeFact {
  readonly result: 'HOLDS' | 'DIFFERENT' | 'ABSENT' | 'UNKNOWN';
  readonly observed: string | boolean | null;
  readonly binding: 'B1' | null;
  readonly detail: string;
  readonly source: FactSource | null;
  /** Set when `result` is `UNKNOWN`. */
  readonly reason: UnknownReason | null;
  /** Scopes an `UNKNOWN(scope-not-pass)` names. */
  readonly scopes: readonly string[];
}

export function holds(
  observed: string | boolean | null,
  detail: string,
  extra: Partial<ProbeFact> = {},
): ProbeFact {
  return {
    result: 'HOLDS',
    observed,
    binding: null,
    detail,
    source: null,
    reason: null,
    scopes: [],
    ...extra,
  };
}

export function different(
  observed: string | boolean | null,
  detail: string,
  extra: Partial<ProbeFact> = {},
): ProbeFact {
  return {
    result: 'DIFFERENT',
    observed,
    binding: null,
    detail,
    source: null,
    reason: null,
    scopes: [],
    ...extra,
  };
}

export function absent(detail: string, extra: Partial<ProbeFact> = {}): ProbeFact {
  return {
    result: 'ABSENT',
    observed: null,
    binding: null,
    detail,
    source: null,
    reason: null,
    scopes: [],
    ...extra,
  };
}

export function unknownFact(
  reason: UnknownReason,
  detail: string,
  extra: { scopes?: readonly string[]; source?: FactSource | null } = {},
): ProbeFact {
  return {
    result: 'UNKNOWN',
    observed: null,
    binding: null,
    detail,
    source: extra.source ?? null,
    reason,
    scopes: extra.scopes ?? [],
  };
}

export const PROBE_VERSION = 2;

export const PROBE_COMPLETENESS: Readonly<Record<ProbeName, Completeness>> = {
  'manifest-field': 'exact',
  'format-witness': 'absence-sound',
  'detector-liveness': 'absence-sound',
  'module-wiring': 'presence-only',
};

export const CLAIM_PROBE: Readonly<Record<ClaimKind, ProbeName>> = {
  RUNTIME_FLOOR: 'manifest-field',
  OUTPUT_FORMAT_SET: 'format-witness',
  DETECTOR_LIVENESS: 'detector-liveness',
  CONTROL_ENFORCEMENT: 'module-wiring',
};

export const CLASSES = [
  'Observed drift',
  'Unexplained gap',
  'Planned gap',
  'Unknown',
  'Resolved',
] as const;
export type AlignClass = (typeof CLASSES)[number];
