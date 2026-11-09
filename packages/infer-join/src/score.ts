/**
 * The scoring model.
 *
 * Four independent signals, each normalized to [0,1], combined by a weighted
 * sum and then mapped through a documented calibration curve. The council's
 * objection to v2 was that its confidences had "no computation method"; this
 * file is the computation method, and every emitted edge carries the four
 * signal values in its props so any number can be traced back to its inputs.
 *
 * ## The signals and their weights
 *
 * | signal      | weight | what it measures                                  |
 * |-------------|--------|---------------------------------------------------|
 * | name        | 0.45   | the two names are the same name (naming.ts)       |
 * | container   | 0.30   | the two owners are the same thing (naming.ts)     |
 * | type        | 0.15   | the two types are the same type (typecat.ts)      |
 * | structure   | 0.10   | independent corroboration (structure.ts)          |
 *
 * Name carries the most weight because it is the only signal that is nearly
 * always present. Container is next and is *gated*, not merely weighted: a pair
 * whose containers do not correspond is rejected outright, because matching
 * field names globally across a repository produces garbage at scale (every
 * `id`, `name`, `createdAt` in the codebase would join to every other).
 *
 * ## Why a type conflict does not veto
 *
 * The type signal contributes 1.0 for agreement, 0.6 for a known cross-
 * representation encoding, 0.5 when either side is unknown, and **0.0 for a
 * conflict** - never a negative. A conflicting pair therefore scores lower than
 * an agreeing one and can still clear the threshold. This is deliberate: v3 §5
 * X2_TYPE detects exactly the case where a joined column and field disagree on
 * type, and it cannot detect what the matcher refused to join. Suppressing the
 * edge would suppress the finding.
 *
 * Note that `unknown` scores 0.5 and `conflict` scores 0.0, so "we could not
 * read the type" is strictly better evidence than "the types disagree", while
 * still not being as good as "the types agree".
 *
 * ## Calibration
 *
 * The weighted sum is not a probability, so it is passed through a monotone
 * piecewise-linear map anchored on three interpretable points:
 *
 *   raw 0.55 -> 0.50   the minimum admissible match: a coin flip
 *   raw 0.80 -> 0.80   name and container agree, type is unread
 *   raw 1.00 -> 0.98   every signal maximal
 *
 * The ceiling is 0.98, not 1.0. An INFERRED edge is never certain; only an
 * extractor may claim certainty, and this package cannot be an extractor
 * (manifest.ts).
 */

import type { NameMatch } from './naming.ts';
import { matchContainer, matchNameInContainer } from './naming.ts';
import type { TypeAgreement } from './typecat.ts';
import { compareTypes } from './typecat.ts';
import type { Facet } from './facets.ts';
import { roundTo } from './confidence.ts';

export interface SignalWeights {
  readonly name: number;
  readonly container: number;
  readonly type: number;
  readonly structure: number;
}

export const DEFAULT_WEIGHTS: SignalWeights = Object.freeze({
  name: 0.45,
  container: 0.3,
  type: 0.15,
  structure: 0.1,
});

/** Type agreement to signal value. `conflict` is 0, never negative. See header. */
export const TYPE_SIGNAL: Readonly<Record<TypeAgreement, number>> = Object.freeze({
  equal: 1,
  compatible: 0.6,
  unknown: 0.5,
  conflict: 0,
});

export interface Thresholds {
  /** Minimum name signal for a pair to be considered at all. */
  readonly minName: number;
  /** Minimum container signal. A hard gate: this is what stops global field matching. */
  readonly minContainer: number;
  /** Minimum weighted sum for a pair to be emitted. */
  readonly minScore: number;
  /** Confidence gap below which a runner-up makes the match ambiguous. */
  readonly ambiguityMargin: number;
  /** Above this many tied candidates, emit nothing and record the ambiguity. */
  readonly maxAmbiguousFanout: number;
  /** Hard ceiling on the confidence of any edge emitted from an ambiguous group. */
  readonly ambiguousCeiling: number;
  /** Hard ceiling on any inferred confidence. */
  readonly maxConfidence: number;
  /** Candidates retained per source before ambiguity resolution. */
  readonly maxCandidatesPerSource: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({
  minName: 0.55,
  minContainer: 0.5,
  minScore: 0.55,
  ambiguityMargin: 0.1,
  maxAmbiguousFanout: 3,
  ambiguousCeiling: 0.5,
  maxConfidence: 0.98,
  maxCandidatesPerSource: 32,
});

export interface PairScore {
  readonly name: NameMatch;
  readonly container: number;
  readonly typeAgreement: TypeAgreement;
  readonly typeSignal: number;
  readonly structure: number;
  /** The weighted sum, before calibration. */
  readonly raw: number;
  /** The calibrated confidence in [0, maxConfidence]. */
  readonly confidence: number;
  /** False when a hard gate rejected the pair; `confidence` is still reported. */
  readonly admissible: boolean;
}

/** Normalize weights so they sum to 1, so a caller can pass any positive ratios. */
export function normalizeWeights(weights: SignalWeights): SignalWeights {
  const total = weights.name + weights.container + weights.type + weights.structure;
  if (!(total > 0)) throw new RangeError('signal weights must sum to a positive number');
  return {
    name: weights.name / total,
    container: weights.container / total,
    type: weights.type / total,
    structure: weights.structure / total,
  };
}

/**
 * Map a weighted sum onto a calibrated confidence. Piecewise linear through
 * (0,0), (minScore, 0.5), (0.8, 0.8), (1, maxConfidence). Monotone by
 * construction, so ordering by raw score and ordering by confidence agree.
 */
export function calibrate(raw: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): number {
  const floor = thresholds.minScore;
  const cap = thresholds.maxConfidence;
  const clamped = Math.max(0, Math.min(1, raw));
  let value: number;
  if (clamped <= floor) {
    value = floor === 0 ? 0 : (clamped / floor) * 0.5;
  } else if (clamped <= 0.8) {
    const span = 0.8 - floor;
    value = span <= 0 ? 0.8 : 0.5 + ((clamped - floor) / span) * 0.3;
  } else {
    value = 0.8 + ((clamped - 0.8) / 0.2) * (cap - 0.8);
  }
  return roundTo(Math.min(cap, Math.max(0, value)), 4);
}

/**
 * Score one candidate pair. Pure: the structural corroboration is passed in so
 * this function has no view of the graph and is trivially testable.
 *
 * `admissible` is reported separately from `confidence` so callers (and tests)
 * can see *how much lower* an unrelated-container pair scores, rather than only
 * that it was dropped.
 */
export function scorePair(
  source: Facet,
  target: Facet,
  structure: number,
  weights: SignalWeights = DEFAULT_WEIGHTS,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): PairScore {
  const name = matchNameInContainer(source.name, source.container, target.name, target.container);
  const container = matchContainer(source.container, target.container);
  const typeAgreement = compareTypes(source.typeCategory, target.typeCategory);
  const typeSignal = TYPE_SIGNAL[typeAgreement];
  const corroboration = Math.max(0, Math.min(1, structure));

  const w = normalizeWeights(weights);
  const raw = roundTo(
    w.name * name.score + w.container * container + w.type * typeSignal + w.structure * corroboration,
    6,
  );
  const confidence = calibrate(raw, thresholds);
  const admissible =
    name.score >= thresholds.minName &&
    container > 0 && container >= thresholds.minContainer &&
    raw >= thresholds.minScore;

  return { name, container, typeAgreement, typeSignal, structure: corroboration, raw, confidence, admissible };
}
