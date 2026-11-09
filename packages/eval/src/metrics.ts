/**
 * Precision, recall, and calibration arithmetic.
 *
 * A ratio over an empty set is `null`, rendered `n/a`. It is never 0 and never
 * 1: a detector with no labelled finding has no measured precision, and a
 * detector with no mutant has no measured recall. Reporting either as a number
 * would be a claim the data does not support.
 */

import type { Verdict } from './types.ts';

export function precision(tp: number, fp: number): number | null {
  const reviewed = tp + fp;
  return reviewed === 0 ? null : tp / reviewed;
}

export function recall(detected: number, mutants: number): number | null {
  return mutants === 0 ? null : detected / mutants;
}

/** Fixed three decimals, or `n/a`. Fixed formatting keeps the report byte-stable. */
export function formatRatio(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

export interface ConfidenceBand {
  readonly label: string;
  /** Inclusive lower bound. */
  readonly lo: number;
  /** Exclusive upper bound, except the last band which includes 1. */
  readonly hi: number;
}

export const CONFIDENCE_BANDS: readonly ConfidenceBand[] = [
  { label: '[0.00, 0.50)', lo: 0, hi: 0.5 },
  { label: '[0.50, 0.70)', lo: 0.5, hi: 0.7 },
  { label: '[0.70, 0.85)', lo: 0.7, hi: 0.85 },
  { label: '[0.85, 1.00]', lo: 0.85, hi: 1 },
];

/** Index into `CONFIDENCE_BANDS`. A confidence of exactly 1 falls in the last band. */
export function bandIndex(confidence: number): number {
  for (let i = CONFIDENCE_BANDS.length - 1; i >= 0; i -= 1) {
    const band = CONFIDENCE_BANDS[i];
    if (band !== undefined && confidence >= band.lo) return i;
  }
  return 0;
}

/**
 * Wilson score interval at 95% for `successes` of `n`. `null` when `n` is 0.
 * The sampling error the calibration section needs: a band with three labelled
 * findings cannot distinguish 0.7 from 0.95, and the interval says so.
 */
export function wilson95(successes: number, n: number): Interval | null {
  if (n === 0) return null;
  const z = 1.959964;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  // Rounded to 12 places so that 10 of 10 reports exactly 1, not 0.9999999999999999.
  const round = (x: number): number => Math.round(x * 1e12) / 1e12;
  return { lo: Math.max(0, round(centre - margin)), hi: Math.min(1, round(centre + margin)) };
}

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

/** Verdict counts for one set of findings. `unlabelled` findings have no verdict yet. */
export interface Tally {
  readonly tp: number;
  readonly fp: number;
  readonly unclear: number;
  readonly unlabelled: number;
}

/** A tally with the precision it supports: `unclear` and `unlabelled` never enter the ratio. */
export interface PrecisionStat extends Tally {
  /** `tp + fp`: how many findings the ratio rests on. */
  readonly n: number;
  readonly precision: number | null;
  readonly interval: Interval | null;
}

export function precisionStat(t: Tally): PrecisionStat {
  const n = t.tp + t.fp;
  return { ...t, n, precision: precision(t.tp, t.fp), interval: wilson95(t.tp, n) };
}

/** One finding as the tally sees it. */
export interface TallyItem {
  readonly repo: string;
  readonly code?: string;
  readonly verdict: Verdict | null;
  readonly cluster?: string | undefined;
}

interface MutableTally {
  tp: number;
  fp: number;
  unclear: number;
  unlabelled: number;
}

function addVerdict(t: MutableTally, v: Verdict | null): void {
  if (v === 'tp') t.tp += 1;
  else if (v === 'fp') t.fp += 1;
  else if (v === 'unclear') t.unclear += 1;
  else t.unlabelled += 1;
}

/** Every finding counts once. */
export function rawTally(items: readonly TallyItem[]): Tally {
  const t: MutableTally = { tp: 0, fp: 0, unclear: 0, unlabelled: 0 };
  for (const item of items) addVerdict(t, item.verdict);
  return t;
}

/**
 * Findings that share a cluster within one repository count once. A cluster
 * is one underlying defect reported several times, so counting each report
 * would let a single bug (or a single false alarm) stand for many.
 *
 * Cluster names are scoped to a repository and detector: the same name in
 * another repository or detector is a separate cluster. Members must agree on a verdict (`matchLabels` enforces
 * that); the first member in verdict order is used here, so the result does
 * not depend on the order the items arrive in.
 */
export function clusteredTally(items: readonly TallyItem[]): Tally {
  const t: MutableTally = { tp: 0, fp: 0, unclear: 0, unlabelled: 0 };
  const seen = new Set<string>();
  const key = (v: Verdict | null): string => v ?? '';
  const sorted = items
    .slice()
    .sort((a, b) =>
      key(a.verdict) < key(b.verdict) ? -1 : key(a.verdict) > key(b.verdict) ? 1 : 0,
    );
  for (const item of sorted) {
    if (item.cluster !== undefined) {
      const id = JSON.stringify([item.repo, item.code ?? null, item.cluster]);
      if (seen.has(id)) continue;
      seen.add(id);
    }
    addVerdict(t, item.verdict);
  }
  return t;
}

export interface CalibrationRow {
  readonly band: string;
  /** Every finding in the band. */
  readonly findings: number;
  /** `tp + fp`: the sample the observed precision rests on. */
  readonly labelled: number;
  readonly tp: number;
  readonly fp: number;
  readonly unclear: number;
  readonly precision: number | null;
  readonly interval: Interval | null;
}

export interface CalibrationInput {
  readonly confidence: number;
  readonly verdict: Verdict | null;
}

/**
 * Observed precision per confidence band, over raw findings (a finding's
 * confidence belongs to that finding, not to its cluster). `unclear` findings
 * are counted but not in the ratio.
 */
export function calibrate(items: readonly CalibrationInput[]): readonly CalibrationRow[] {
  return CONFIDENCE_BANDS.map((band, index) => {
    const inBand = items.filter((i) => bandIndex(i.confidence) === index);
    const tp = inBand.filter((i) => i.verdict === 'tp').length;
    const fp = inBand.filter((i) => i.verdict === 'fp').length;
    const unclear = inBand.filter((i) => i.verdict === 'unclear').length;
    return {
      band: band.label,
      findings: inBand.length,
      labelled: tp + fp,
      tp,
      fp,
      unclear,
      precision: precision(tp, fp),
      interval: wilson95(tp, tp + fp),
    };
  });
}

/**
 * The release bar (design section 6.3), taken on the sealed partition, by
 * cluster, on the strict reading (`unclear` is not `tp`): pooled precision of
 * at least 0.90 AND a 95% Wilson lower bound of at least 0.75, over at least 30
 * labelled clusters. 27 of 30 is 0.90 with a lower bound of about 0.74 and does
 * not pass; 28 of 30 has a lower bound of about 0.79 and does. Per detector, a
 * detector with at least 5 labelled clusters needs a point estimate of at
 * least 0.80, and one with fewer is "unmeasured".
 */
export const RELEASE_BAR = {
  minPrecision: 0.9,
  minLowerBound: 0.75,
  minLabelled: 30,
  perDetector: { minClusters: 5, minPrecision: 0.8 },
} as const;

/**
 * The strict reading: `unclear` counts as not-`tp`, so it stays in the
 * denominator. The lenient reading (`precisionStat`) leaves it out; the report
 * prints both, and the bar uses this one.
 */
export function strictStat(t: Tally): PrecisionStat {
  const n = t.tp + t.fp + t.unclear;
  return { ...t, n, precision: n === 0 ? null : t.tp / n, interval: wilson95(t.tp, n) };
}

/** True when `tp` of `tp + fp + unclear` labelled clusters clears the strict bar. */
export function meetsReleaseBar(tp: number, fp: number, unclear = 0): boolean {
  const stat = strictStat({ tp, fp, unclear, unlabelled: 0 });
  return (
    stat.n >= RELEASE_BAR.minLabelled &&
    stat.precision !== null &&
    stat.precision >= RELEASE_BAR.minPrecision &&
    stat.interval !== null &&
    stat.interval.lo >= RELEASE_BAR.minLowerBound
  );
}

/**
 * `unmeasured` when a detector has fewer than 5 labelled clusters (it cannot be
 * called validated), otherwise whether its strict point estimate reaches 0.80.
 */
export type DetectorStatus = 'unmeasured' | 'meets' | 'below';

export function detectorStatus(strictClustered: PrecisionStat): DetectorStatus {
  if (
    strictClustered.n < RELEASE_BAR.perDetector.minClusters ||
    strictClustered.precision === null
  ) {
    return 'unmeasured';
  }
  return strictClustered.precision >= RELEASE_BAR.perDetector.minPrecision ? 'meets' : 'below';
}

/** Formats a Wilson interval as `[lo, hi]`, or `n/a`. */
export function formatInterval(interval: Interval | null): string {
  return interval === null ? 'n/a' : `[${interval.lo.toFixed(3)}, ${interval.hi.toFixed(3)}]`;
}

/**
 * The single figure the report leads with: strict precision on the sealed
 * partition, by cluster. It is claimed only when the sealed partition is
 * `powered`:
 *
 * - `burned`       a watched path or a sealed pin changed after `eval/FREEZE`; the sealed
 *                  repositories are spent and must be replaced
 * - `incomplete`   a sealed finding is still unlabelled. Reviewers label the easy
 *                  cases first, so a figure over the labelled ones is a selection
 * - `underpowered` fewer than 30 labelled clusters
 */
export interface Headline {
  readonly partition: 'sealed';
  readonly status: 'powered' | 'underpowered' | 'incomplete' | 'burned';
  readonly minLabelled: number;
  /** The strict reading (the bar's). */
  readonly strict: PrecisionStat;
  /** The lenient reading, printed beside it. */
  readonly lenient: PrecisionStat;
  /** Sealed findings with no label yet. */
  readonly unlabelled: number;
  /** Sealed repositories whose analysis did not complete: their findings are unknown, not absent. */
  readonly unanalysed: readonly string[];
  /** True for a filtered run (`--repo`, `--mutant`, `--no-mutants`), which does not cover the corpus. */
  readonly partial: boolean;
  /** Declared identity or double-review evidence is missing for sealed labels. */
  readonly reviewIncomplete: boolean;
  /** Detectors with at least 5 labelled sealed clusters whose point estimate is below 0.80. */
  readonly detectorsBelow: readonly string[];
  /** Whether the bar is met. `null` unless powered: no claim either way. */
  readonly meetsBar: boolean | null;
}

/**
 * A figure over the sealed findings that were seen says nothing when some were
 * never produced: a crashed or timed-out repository (UNAVAILABLE is never
 * PASS) or a run that did not cover the corpus. Both make the headline
 * `incomplete`, like an unlabelled finding, and no "met" or "not met" is printed.
 */
export function headline(
  sealedClustered: Tally,
  opts: {
    readonly burned?: boolean;
    readonly detectorsBelow?: readonly string[];
    readonly unanalysed?: readonly string[];
    readonly partial?: boolean;
    readonly reviewIncomplete?: boolean;
  } = {},
): Headline {
  const strict = strictStat(sealedClustered);
  const lenient = precisionStat(sealedClustered);
  const detectorsBelow = opts.detectorsBelow ?? [];
  const unanalysed = opts.unanalysed ?? [];
  const partial = opts.partial ?? false;
  const reviewIncomplete = opts.reviewIncomplete ?? false;
  const status =
    opts.burned === true
      ? 'burned'
      : sealedClustered.unlabelled > 0 || unanalysed.length > 0 || partial || reviewIncomplete
        ? 'incomplete'
        : strict.n < RELEASE_BAR.minLabelled
          ? 'underpowered'
          : 'powered';
  const meetsBar =
    status === 'powered' &&
    strict.precision !== null &&
    strict.interval !== null &&
    detectorsBelow.length === 0
      ? strict.precision >= RELEASE_BAR.minPrecision &&
        strict.interval.lo >= RELEASE_BAR.minLowerBound
      : status === 'powered'
        ? false
        : null;
  return {
    partition: 'sealed',
    status,
    minLabelled: RELEASE_BAR.minLabelled,
    strict,
    lenient,
    unlabelled: sealedClustered.unlabelled,
    unanalysed,
    partial,
    reviewIncomplete,
    detectorsBelow,
    meetsBar,
  };
}
