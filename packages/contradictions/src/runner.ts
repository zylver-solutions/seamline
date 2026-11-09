/**
 * The runner, and the place the UNKNOWN rule is enforced.
 *
 * v3 section 2.2: any query whose answer depends on a scope whose producing
 * extractor did not PASS returns UNKNOWN for that portion and never a negative
 * finding. Here that is structural rather than remembered:
 *
 * - the runner checks every detector's `requiredScopes` **before** calling it,
 *   and a blocked detector is never invoked at all;
 * - `defineDetector` applies the same check inside `detect`, so a caller that
 *   bypasses the runner still cannot get a finding out of a failed scope;
 * - a detector's `unknownWhen` is asked next, and a defined answer is the same
 *   refusal for a reason the graph's own facts give (an extractor that PASSed
 *   but recorded that it did not see every writer);
 * - the per-detector outcome is a `Maybe` from the contract, so an UNKNOWN
 *   result is a different shape from an empty result and cannot be mistaken
 *   for "clean" by a consumer that forgets to look.
 *
 * The difference matters more than it looks. "No contradictions found" and "the
 * data extractor crashed so I have nothing to say" are the same empty array,
 * and a CI gate that renders them the same way is one flaky run away from
 * being switched off for good.
 */

import {
  known,
  unknown,
  type Contradiction,
  type ContradictionCode,
  type GraphView,
  type Maybe,
  type Severity,
} from '@seamline/ontology';

import { compareContradictions, type SeamlineDetector } from './detector.ts';
import { ALL_DETECTORS } from './detectors/index.ts';
import { cmp, unreadCodePackages } from './graph.ts';
import { observationView, type CurrentObservation } from './observation.ts';

export type DetectorOutcome = 'fired' | 'clean' | 'unknown';

/**
 * The code at the start of every reason a detector is UNKNOWN because a required
 * scope did not PASS. It is stable so that a consumer which must not show the
 * rest of the message (it names scopes, and scope names can carry a repository's
 * own paths) can still say why: the code is the part before the first colon.
 */
export const SCOPE_NOT_PASS = 'SCOPE_NOT_PASS';

export interface DetectorReport {
  readonly code: ContradictionCode;
  /** The severity the detector would report at with a certain join. */
  readonly declaredSeverity: Severity;
  readonly requiredScopes: ReadonlyArray<string>;
  readonly outcome: DetectorOutcome;
  /**
   * `known` with the findings, or `unknown` with the reason. The scopes are the
   * blocking ones, and none when the reason is the detector's own `unknownWhen`.
   */
  readonly result: Maybe<ReadonlyArray<Contradiction>>;
  /** Convenience view of `result`: empty when the outcome is `unknown`. */
  readonly findings: ReadonlyArray<Contradiction>;
  readonly blockedScopes: ReadonlyArray<string>;
  /**
   * How many workspace packages `code.ts` did not read, when that is why the
   * outcome is `unknown` while every scope PASSes. Only the count: it is what a
   * consumer that must not forward free text can still say.
   */
  readonly unreadCodePackages?: number;
  /** Facts the detector declined to evaluate, with the reason. */
  readonly notes: ReadonlyArray<string>;
}

export interface RunReport {
  /** Every finding from every detector that ran, in a total order. */
  readonly findings: ReadonlyArray<Contradiction>;
  /** One entry per detector, in catalog order. */
  readonly detectors: ReadonlyArray<DetectorReport>;
  /** Scopes that blocked at least one detector, with their status. A detector UNKNOWN for its own reason adds none. */
  readonly blockedScopes: ReadonlyArray<{ readonly scope: string; readonly status: string }>;
  readonly counts: Readonly<Record<DetectorOutcome, number>>;
}

export function runDetectors(
  g: GraphView,
  detectors: ReadonlyArray<SeamlineDetector> = ALL_DETECTORS,
  currentObservation?: CurrentObservation,
): RunReport {
  g = observationView(g, currentObservation);
  const reports: DetectorReport[] = [];
  const all: Contradiction[] = [];
  const blockedStatuses = new Map<string, string>();
  const counts: Record<DetectorOutcome, number> = { fired: 0, clean: 0, unknown: 0 };

  for (const d of detectors) {
    const blocked = d.blockedScopes(g);

    if (blocked.length > 0) {
      for (const s of blocked) blockedStatuses.set(s, g.scopeStatus(s));
      const reason =
        `${SCOPE_NOT_PASS}: scope(s) not PASS: ` +
        blocked.map((s) => `${s}=${g.scopeStatus(s)}`).join(', ') +
        `; UNKNOWN rather than a finding (v3 section 2.2)`;
      counts.unknown += 1;
      reports.push({
        code: d.code,
        declaredSeverity: d.severity,
        requiredScopes: d.requiredScopes,
        outcome: 'unknown',
        result: unknown(reason, blocked),
        findings: [],
        blockedScopes: blocked,
        notes: [],
      });
      continue;
    }

    // Two distinct non-scope causes, both UNKNOWN with every scope PASS: unread workspace code for an
    // absence-based detector (reported with its count), and the detector's own `unknownWhen` reason.
    const unreadCode = d.unreadCode(g);
    const ownReason = unreadCode === undefined ? d.unknownReason(g) : undefined;
    const why = unreadCode ?? ownReason;
    if (why !== undefined) {
      counts.unknown += 1;
      reports.push({
        code: d.code,
        declaredSeverity: d.severity,
        requiredScopes: d.requiredScopes,
        outcome: 'unknown',
        result: unknown(why, []),
        findings: [],
        blockedScopes: [],
        ...(unreadCode !== undefined ? { unreadCodePackages: unreadCodePackages(g).count } : {}),
        notes: [],
      });
      continue;
    }

    const findings = [...d.detect(g)].sort(compareContradictions);
    all.push(...findings);
    const outcome: DetectorOutcome = findings.length > 0 ? 'fired' : 'clean';
    counts[outcome] += 1;
    reports.push({
      code: d.code,
      declaredSeverity: d.severity,
      requiredScopes: d.requiredScopes,
      outcome,
      result: known(findings),
      findings,
      blockedScopes: [],
      notes: d.notes(g),
    });
  }

  return {
    findings: all.sort(compareContradictions),
    detectors: reports,
    blockedScopes: [...blockedStatuses.entries()]
      .map(([scope, status]) => ({ scope, status }))
      .sort((a, b) => cmp(a.scope, b.scope)),
    counts,
  };
}

/** One line per detector, for a CLI summary. */
export function summarize(report: RunReport): ReadonlyArray<string> {
  return report.detectors.map((d) => {
    if (d.outcome === 'unknown') {
      return `${d.code}  UNKNOWN  ${d.result.known ? '' : d.result.reason}`;
    }
    const noun = d.findings.length === 1 ? 'contradiction' : 'contradictions';
    return `${d.code}  ${d.outcome.toUpperCase()}  ${d.findings.length} ${noun}`;
  });
}
