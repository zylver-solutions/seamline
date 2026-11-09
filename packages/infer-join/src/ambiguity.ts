/**
 * Ambiguity resolution.
 *
 * A silent wrong join is worse than an absent join, because lineage,
 * contradiction detection and blast radius all inherit the error and none of
 * them can tell that they did. So "pick the highest score" is not an acceptable
 * policy, and this module implements a documented one instead.
 *
 * ## The decision
 *
 * For each source node, its admissible candidates are ranked by confidence
 * descending, then by node id ascending (which makes the ranking total and the
 * output deterministic). Let `top` be the best score and
 * `tied = { c : top - c.confidence < ambiguityMargin }`.
 *
 *   |tied| == 1                    -> DECISIVE. One edge, full confidence.
 *   1 < |tied| <= maxFanout (3)    -> AMBIGUOUS. One edge per tied candidate,
 *                                     each at `confidence / |tied|` and hard-
 *                                     capped at `ambiguousCeiling` (0.5).
 *   |tied| > maxFanout             -> DROPPED. No edges. The top `maxFanout`
 *                                     candidates are recorded on the result.
 *
 * Two things follow from that middle branch. First, the confidence is *divided*
 * rather than merely capped: at most one candidate can be correct, so the
 * probability mass is split between them, and a 3-way tie of 0.9 edges yields
 * three 0.3 edges rather than three 0.5 edges. Second, the emitted edges carry
 * `ambiguous: true` and the full candidate group, so a consumer can render "one
 * of these two" instead of asserting either.
 *
 * The cutoff at 3 is a judgement, and it is the one place a number here is not
 * derived: past three plausible targets the pattern is a naming collision
 * (every class in the repo has a `name`), not a join, and emitting four
 * quarter-confidence edges only pollutes the graph. Below the cutoff the
 * information is useful to a human reading `seamline why`; above it, it is not.
 *
 * ## Contention: the same decision from the other side
 *
 * A match can also be ambiguous from the target's point of view - two different
 * columns both plausibly mapping onto one field. Ranking per source cannot see
 * this. So a second pass finds every target claimed by more than one source and
 * divides those claims' confidence by the number of claimants, marking them
 * `contended: true`. At most one claimant can be right, so the same probability
 * -mass argument applies.
 *
 * Contention demotes confidence but does not drop the edge: unlike source-side
 * fanout, the losing claimant is usually a genuinely related column (a foreign
 * key, a denormalized copy), and dropping it would lose real lineage.
 */

import type { NodeId } from '@seamline/ontology';
import type { PairScore, Thresholds } from './score.ts';
import { DEFAULT_THRESHOLDS } from './score.ts';
import { roundTo } from './confidence.ts';

export const RESOLUTIONS = ['decisive', 'ambiguous', 'dropped'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export interface Candidate {
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly score: PairScore;
}

export interface Decision {
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly score: PairScore;
  /** Confidence after ambiguity and contention adjustment. */
  readonly confidence: number;
  readonly resolution: Resolution;
  /** All candidates tied with the winner, including the winner. Sorted. */
  readonly group: ReadonlyArray<NodeId>;
  /** True when other sources also claim this target within the margin. */
  readonly contended: boolean;
  readonly claimants: number;
}

export const AMBIGUITY_REASONS = ['tie', 'fanout', 'contention'] as const;
export type AmbiguityReason = (typeof AMBIGUITY_REASONS)[number];

export interface AmbiguityRecord {
  readonly reason: AmbiguityReason;
  /** The node the ambiguity is about: the source for tie/fanout, the target for contention. */
  readonly subject: NodeId;
  readonly candidates: ReadonlyArray<{ readonly id: NodeId; readonly confidence: number }>;
  /** True when the ambiguity caused no edge to be emitted. */
  readonly dropped: boolean;
}

export interface ResolutionResult {
  readonly decisions: ReadonlyArray<Decision>;
  readonly ambiguities: ReadonlyArray<AmbiguityRecord>;
}

export interface ResolveOptions {
  /**
   * Whether the relation is exclusive: at most one target per source and at
   * most one source per target.
   *
   * `MAPS_TO_FIELD`, `BACKED_BY` and `EXPOSED_AS` are exclusive - a column is
   * one value, and two candidates for it means at most one is right, which is
   * what justifies splitting the probability mass.
   *
   * `VALIDATED_BY` is **not** exclusive: one validator legitimately validates
   * many fields, and one field can be constrained by a create-schema and an
   * update-schema at once. For a non-exclusive relation every candidate above
   * the threshold is emitted at its own confidence, with no mass splitting and
   * no contention pass; only the fanout cap still applies, because a field
   * matching more than `maxAmbiguousFanout` validators is a matcher failure
   * rather than a fact about the code.
   *
   * Default true.
   */
  readonly exclusive?: boolean;
}

function byConfidenceThenId(a: Candidate, b: Candidate): number {
  if (b.score.confidence !== a.score.confidence) return b.score.confidence - a.score.confidence;
  return a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0;
}

function compareIds(a: NodeId, b: NodeId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Apply the documented policy to a set of admissible candidates.
 *
 * Input order does not matter: everything is sorted before it is read, so the
 * result is byte-stable across runs (v3 §2.3).
 */
export function resolveCandidates(
  candidates: ReadonlyArray<Candidate>,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  options: ResolveOptions = {},
): ResolutionResult {
  const exclusive = options.exclusive ?? true;
  const bySource = new Map<NodeId, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = bySource.get(candidate.src);
    if (bucket === undefined) bySource.set(candidate.src, [candidate]);
    else bucket.push(candidate);
  }

  const decisions: Decision[] = [];
  const ambiguities: AmbiguityRecord[] = [];

  for (const source of [...bySource.keys()].sort(compareIds)) {
    const ranked = (bySource.get(source) ?? [])
      .slice()
      .sort(byConfidenceThenId)
      .slice(0, thresholds.maxCandidatesPerSource);
    const best = ranked[0];
    if (best === undefined) continue;

    if (!exclusive) {
      if (ranked.length > thresholds.maxAmbiguousFanout) {
        ambiguities.push({
          reason: 'fanout',
          subject: source,
          candidates: ranked.slice(0, thresholds.maxAmbiguousFanout).map((c) => ({
            id: c.dst,
            confidence: c.score.confidence,
          })),
          dropped: true,
        });
        continue;
      }
      const all = ranked.map((c) => c.dst).slice().sort(compareIds);
      for (const candidate of ranked) {
        decisions.push({
          src: source,
          dst: candidate.dst,
          score: candidate.score,
          confidence: candidate.score.confidence,
          resolution: 'decisive',
          group: all,
          contended: false,
          claimants: 1,
        });
      }
      continue;
    }

    const tied = ranked.filter(
      (c) => best.score.confidence - c.score.confidence < thresholds.ambiguityMargin,
    );
    const group = tied.map((c) => c.dst).slice().sort(compareIds);

    if (tied.length === 1) {
      decisions.push({
        src: source,
        dst: best.dst,
        score: best.score,
        confidence: best.score.confidence,
        resolution: 'decisive',
        group,
        contended: false,
        claimants: 1,
      });
      continue;
    }

    if (tied.length > thresholds.maxAmbiguousFanout) {
      ambiguities.push({
        reason: 'fanout',
        subject: source,
        candidates: ranked.slice(0, thresholds.maxAmbiguousFanout).map((c) => ({
          id: c.dst,
          confidence: c.score.confidence,
        })),
        dropped: true,
      });
      continue;
    }

    for (const candidate of tied) {
      decisions.push({
        src: source,
        dst: candidate.dst,
        score: candidate.score,
        confidence: roundTo(
          Math.min(thresholds.ambiguousCeiling, candidate.score.confidence / tied.length),
          4,
        ),
        resolution: 'ambiguous',
        group,
        contended: false,
        claimants: 1,
      });
    }
    ambiguities.push({
      reason: 'tie',
      subject: source,
      candidates: tied.map((c) => ({ id: c.dst, confidence: c.score.confidence })),
      dropped: false,
    });
  }

  if (!exclusive) {
    return {
      decisions: decisions.slice().sort((a, b) => compareIds(a.src, b.src) || compareIds(a.dst, b.dst)),
      ambiguities: ambiguities.slice().sort((a, b) =>
        (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0) || compareIds(a.subject, b.subject)),
    };
  }
  return applyContention(decisions, ambiguities, thresholds);
}

/**
 * Second pass: divide confidence among sources competing for one target.
 * Only decisive and ambiguous decisions that survived the first pass compete;
 * a dropped source has already withdrawn its claim.
 */
function applyContention(
  decisions: ReadonlyArray<Decision>,
  ambiguities: ReadonlyArray<AmbiguityRecord>,
  thresholds: Thresholds,
): ResolutionResult {
  const byTarget = new Map<NodeId, Decision[]>();
  for (const decision of decisions) {
    const bucket = byTarget.get(decision.dst);
    if (bucket === undefined) byTarget.set(decision.dst, [decision]);
    else bucket.push(decision);
  }

  const adjusted = new Map<NodeId, Map<NodeId, Decision>>();
  const extraAmbiguities: AmbiguityRecord[] = [];

  for (const target of [...byTarget.keys()].sort(compareIds)) {
    const claims = (byTarget.get(target) ?? []).slice().sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return compareIds(a.src, b.src);
    });
    const leader = claims[0];
    if (leader === undefined) continue;
    const contenders = claims.filter(
      (c) => leader.confidence - c.confidence < thresholds.ambiguityMargin,
    );
    const contended = contenders.length > 1;

    for (const claim of claims) {
      const isContender = contended && contenders.some((c) => c.src === claim.src);
      const next: Decision = isContender
        ? {
            ...claim,
            confidence: roundTo(claim.confidence / contenders.length, 4),
            contended: true,
            claimants: contenders.length,
          }
        : claim;
      let row = adjusted.get(next.src);
      if (row === undefined) {
        row = new Map<NodeId, Decision>();
        adjusted.set(next.src, row);
      }
      row.set(next.dst, next);
    }

    if (contended) {
      extraAmbiguities.push({
        reason: 'contention',
        subject: target,
        candidates: contenders.map((c) => ({ id: c.src, confidence: c.confidence })),
        dropped: false,
      });
    }
  }

  const out: Decision[] = [];
  for (const src of [...adjusted.keys()].sort(compareIds)) {
    const row = adjusted.get(src);
    if (row === undefined) continue;
    for (const dst of [...row.keys()].sort(compareIds)) {
      const decision = row.get(dst);
      if (decision !== undefined) out.push(decision);
    }
  }

  const allAmbiguities = [...ambiguities, ...extraAmbiguities].sort((a, b) => {
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return compareIds(a.subject, b.subject);
  });

  return { decisions: out, ambiguities: allAmbiguities };
}
