/**
 * Confidence aggregation along a multi-hop path.
 *
 * The data lens of the 2026-08-29 council rejected v2's confidence model for
 * having "no computation method, no path-aggregation rule". This module is the
 * answer to the second half; `score.ts` is the answer to the first.
 *
 * The rule, stated plainly: **a chain is only as good as the product of its
 * links.** A three-hop lineage over edges of 0.8 is 0.512, not 0.8. Anything
 * else lets a long inferred chain present itself as being as trustworthy as a
 * single inferred hop, which is how a lineage map turns into a liability.
 *
 * Three models are offered because the independence assumption is a choice, not
 * a fact, and the caller should be able to say which one it is making:
 *
 *   product     P(all hops correct) under independence. The default, and the
 *               only one that is strictly decreasing in path length.
 *   min         the weakest link. An *upper bound* on the product - use it to
 *               answer "at best, how good could this chain be?", never to
 *               report a chain's trustworthiness.
 *   correlated  a log-space interpolation between the two, parameterized by a
 *               correlation coefficient. rho = 0 is `product`, rho = 1 is
 *               `min`. Errors in a name-driven matcher *are* correlated (one
 *               bad naming convention poisons every hop through it), so a
 *               caller with a calibration set can move rho off zero rather than
 *               pretending the hops are independent.
 *
 * All three are monotonically non-increasing as hops are appended, which is the
 * property the rest of the system relies on: extending a path can never make it
 * more trustworthy.
 */

/** Round to `digits` decimals. Fixed formatting is a determinism gate (v3 §2.3). */
export function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export const AGGREGATION_MODELS = ['product', 'min', 'correlated'] as const;
export type AggregationModel = (typeof AGGREGATION_MODELS)[number];

export interface AggregateOptions {
  readonly model?: AggregationModel;
  /** Only used by `correlated`. 0 reproduces `product`, 1 reproduces `min`. */
  readonly correlation?: number;
  /** Decimal places in the result. Default 6. */
  readonly digits?: number;
}

export const DEFAULT_AGGREGATION: Required<AggregateOptions> = Object.freeze({
  model: 'product',
  correlation: 0,
  digits: 6,
});

/**
 * Aggregate per-hop confidences into a path confidence.
 *
 * An empty path aggregates to 1: a zero-hop "path" is the starting node itself,
 * about which the walk asserts nothing, so it cannot lose confidence.
 *
 * Throws on a confidence outside [0,1] - failing fast at the boundary beats
 * silently producing a nonsense aggregate that then propagates into a lineage
 * report.
 */
export function aggregateConfidence(
  confidences: ReadonlyArray<number>,
  options: AggregateOptions = {},
): number {
  const model = options.model ?? DEFAULT_AGGREGATION.model;
  const correlation = options.correlation ?? DEFAULT_AGGREGATION.correlation;
  const digits = options.digits ?? DEFAULT_AGGREGATION.digits;

  for (const c of confidences) {
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      throw new RangeError(`hop confidence must be within [0,1], got ${c}`);
    }
  }
  if (correlation < 0 || correlation > 1) {
    throw new RangeError(`correlation must be within [0,1], got ${correlation}`);
  }
  if (confidences.length === 0) return 1;

  let product = 1;
  let weakest = 1;
  for (const c of confidences) {
    product *= c;
    if (c < weakest) weakest = c;
  }

  if (model === 'product') return roundTo(product, digits);
  if (model === 'min') return roundTo(weakest, digits);

  // correlated: exp((1 - rho) * sum(ln c) + rho * ln(min c)).
  if (product === 0 || weakest === 0) return 0;
  let logSum = 0;
  for (const c of confidences) logSum += Math.log(c);
  const value = Math.exp((1 - correlation) * logSum + correlation * Math.log(weakest));
  return roundTo(Math.min(1, value), digits);
}

/** Convenience over anything hop-shaped. */
export function pathConfidence(
  hops: ReadonlyArray<{ readonly confidence: number }>,
  options: AggregateOptions = {},
): number {
  return aggregateConfidence(hops.map((h) => h.confidence), options);
}
