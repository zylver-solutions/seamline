/**
 * Classification (design section 6) and the Resolved rules (section 7).
 *
 * The decision table is a total function over (which polarities are present,
 * what the probe found, whether the probe is `exact`). Rows are tried in order
 * and the first match gives the standing result. Nothing here reads the
 * proposals, the excerpts or the baseline: classification is exact, with no
 * score and no threshold.
 */

import {
  CLAIM_PROBE,
  PROBE_COMPLETENESS,
  PROBE_VERSION,
  type AlignClass,
  type ClaimKind,
  type Polarity,
  type ProbeFact,
} from './types.ts';
import { canonicalJson, sha256Tagged } from './util.ts';

export type Standing =
  | { readonly kind: 'aligned' }
  | { readonly kind: 'nothing' }
  | {
      readonly kind: 'class';
      readonly class: Exclude<AlignClass, 'Resolved'>;
      readonly reason: string;
      /** Set by the guard row D11, which names the combination it refused to classify. */
      readonly detail?: string;
    };

const aligned: Standing = { kind: 'aligned' };
const nothing: Standing = { kind: 'nothing' };
const cls = (c: Exclude<AlignClass, 'Resolved'>, reason: string): Standing => ({
  kind: 'class',
  class: c,
  reason,
});

/**
 * The first matching row of D1 to D11 (6). `fact` is `null` when no probe ran
 * for the subject (a baseline-only floor or control), whose standing result is nothing.
 */
export function decide(
  kind: ClaimKind,
  polarities: ReadonlySet<Polarity>,
  fact: ProbeFact | null,
): Standing {
  if (fact === null) return nothing;
  const exact = PROBE_COMPLETENESS[CLAIM_PROBE[kind]] === 'exact';
  const affirm = polarities.has('AFFIRM');
  const deferred = polarities.has('DEFERRED');
  const absentMarker = polarities.has('ABSENT');
  const none = polarities.size === 0;
  const result = fact.result;

  // D1: an Unknown beats everything. A failing extraction cannot manufacture resolution.
  if (result === 'UNKNOWN') return cls('Unknown', fact.reason ?? 'probe-failed');
  // D2
  if (affirm && result === 'DIFFERENT') return cls('Observed drift', 'value-mismatch');
  // D3 and D4
  if (affirm && result === 'ABSENT') {
    return deferred
      ? cls('Planned gap', 'deferred-and-absent')
      : cls('Unexplained gap', 'absent-in-implementation');
  }
  // D5
  if (deferred && !affirm && result === 'ABSENT') return cls('Planned gap', 'deferred-and-absent');
  // D6
  if ((none || (affirm && !deferred && !absentMarker)) && result === 'HOLDS') return aligned;
  // D7
  if (deferred && result === 'HOLDS') {
    return exact
      ? cls('Observed drift', 'stale-deferral')
      : cls('Unknown', 'cannot-confirm-presence');
  }
  // D8
  if (absentMarker && !deferred && result === 'HOLDS') {
    return exact
      ? cls('Observed drift', 'stale-absence')
      : cls('Unknown', 'cannot-confirm-presence');
  }
  // D9
  if (absentMarker && !affirm && !deferred && result === 'ABSENT') return aligned;
  // D10
  if (none && (result === 'ABSENT' || result === 'DIFFERENT')) return nothing;
  // D11: a total-function guard. A future probe that can produce a combination above fails closed.
  return {
    kind: 'class',
    class: 'Unknown',
    reason: 'probe-failed',
    detail: `no row of the decision table covers claims [${[...polarities].sort().join(', ') || 'none'}] against a ${result} fact`,
  };
}

// ---------------------------------------------------------------------------
// Digests (7)
// ---------------------------------------------------------------------------

/** SHA-256 of the sorted claim digests joined by LF, or `null` when there are none. */
export function claimSetDigest(claimDigests: readonly string[]): string | null {
  if (claimDigests.length === 0) return null;
  return sha256Tagged([...claimDigests].sort().join('\n'));
}

/**
 * The fact digest: probe, version, observed value and binding, and `result`
 * only when it is `ABSENT` or `UNKNOWN`. `HOLDS` and `DIFFERENT` are the outcome
 * of comparing the claim with the fact, so they change when only the document
 * changes; `ABSENT` and `UNKNOWN` belong to the implementation side alone. No
 * detail, source, commit, line number or scan count.
 */
export function factDigest(kind: ClaimKind, fact: ProbeFact | null): string | null {
  if (fact === null) return null;
  const body: Record<string, unknown> = {
    probe: CLAIM_PROBE[kind],
    probeVersion: PROBE_VERSION,
    observed: fact.observed,
    binding: fact.binding,
  };
  if (fact.result === 'ABSENT' || fact.result === 'UNKNOWN') body['result'] = fact.result;
  return sha256Tagged(canonicalJson(body));
}

// ---------------------------------------------------------------------------
// Resolved (7)
// ---------------------------------------------------------------------------

export type ResolvedBy =
  'claim-corrected' | 'claim-removed' | 'fact-changed' | 'claim-and-fact-changed' | 'explained';

/**
 * How a baseline drift was resolved at head, or `null` when the digests show
 * nothing moved (which cannot happen when the standing result changed, so the
 * report declines to claim a resolution it cannot explain). Checked in order:
 * `explained`, `claim-removed`, then the three digest rows.
 */
export function resolvedBy(input: {
  readonly headStanding: Standing;
  readonly headHasClaims: boolean;
  readonly baselineClaimDigest: string | null;
  readonly baselineFactDigest: string | null;
  readonly headClaimDigest: string | null;
  readonly headFactDigest: string | null;
}): ResolvedBy | null {
  if (input.headStanding.kind === 'class' && input.headStanding.class === 'Planned gap')
    return 'explained';
  if (!input.headHasClaims) return 'claim-removed';
  const claimChanged = input.headClaimDigest !== input.baselineClaimDigest;
  const factChanged = input.headFactDigest !== input.baselineFactDigest;
  if (claimChanged && factChanged) return 'claim-and-fact-changed';
  if (claimChanged) return 'claim-corrected';
  if (factChanged) return 'fact-changed';
  return null;
}

/** Row R: a baseline drift is resolved when the standing result is aligned, a Planned gap, or nothing. */
export function resolvesDrift(standing: Standing): boolean {
  return (
    standing.kind === 'aligned' ||
    standing.kind === 'nothing' ||
    (standing.kind === 'class' && standing.class === 'Planned gap')
  );
}
