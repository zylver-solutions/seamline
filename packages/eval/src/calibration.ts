/** Development-only finding calibration. Never changes the finding population. */
import { createHash } from 'node:crypto';
import { ConfigError } from './errors.ts';
import { bandIndex, calibrate, CONFIDENCE_BANDS, type CalibrationRow } from './metrics.ts';
import type { Partition, Verdict } from './types.ts';

export interface CalibrationDatum {
  readonly id: string;
  readonly repo: string;
  /** Canonical upstream identity, shared by parent/fix pins. Not a checkout name. */
  readonly group: string;
  readonly partition: Partition;
  readonly confidence: number;
  readonly verdict: Verdict | null;
}

export interface BandFit extends CalibrationRow {
  readonly repositories: number;
  readonly action: 'not-estimable' | 'retain' | 'refit';
  /** Development TP/(TP+FP), used only when action is refit. */
  readonly estimate: number | null;
}

export interface CalibrationCheck {
  readonly findings: number;
  readonly labelled: number;
  readonly estimated: number;
  /** Brier scores use exactly the same labelled, estimable findings. */
  readonly rawBrier: number | null;
  readonly calibratedBrier: number | null;
}

export interface ConfidenceFit {
  readonly target: 'finding-correctness';
  readonly basis: 'raw-findings-tp-over-tp-plus-fp';
  readonly inputDigest: string;
  readonly trainingRepos: readonly string[];
  readonly trainingGroups: number;
  readonly model: readonly BandFit[];
  readonly folds: readonly {
    readonly heldOutRepos: readonly string[];
    readonly trainingRepos: readonly string[];
    readonly model: readonly BandFit[];
    readonly check: CalibrationCheck;
  }[];
  readonly sealedCheck: CalibrationCheck;
}

/** HTTPS clone URLs identify upstreams; GitHub names are case-insensitive. */
export function repositoryGroup(cloneUrl: string): string {
  let url: URL;
  try { url = new URL(cloneUrl); } catch { throw new ConfigError('invalid corpus clone URL for calibration'); }
  if (url.protocol !== 'https:') throw new ConfigError('calibration requires HTTPS corpus clone URLs');
  let pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (url.hostname.toLowerCase() === 'github.com') pathname = pathname.toLowerCase();
  // Credentials and URL query parameters must not enter report metadata.
  return createHash('sha256').update(`${url.origin}${pathname}`).digest('hex');
}

const unique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

function fit(items: readonly CalibrationDatum[]): readonly BandFit[] {
  return calibrate(items).map((row, index) => {
    const band = CONFIDENCE_BANDS[index]!;
    const groups = unique(items.filter((d) => bandIndex(d.confidence) === index && (d.verdict === 'tp' || d.verdict === 'fp')).map((d) => d.group));
    const eligible = groups.length >= 2 && row.interval !== null;
    // A disjoint Wilson interval is the predeclared refit trigger. A sparse
    // band, or an interval overlapping the nominal band, does not justify it.
    const outside = eligible && row.interval !== null && (row.interval.hi < band.lo || row.interval.lo > band.hi);
    return {
      ...row,
      repositories: groups.length,
      action: !eligible ? 'not-estimable' : outside ? 'refit' : 'retain',
      estimate: outside ? row.precision : null,
    };
  });
}

export function calibratedConfidence(confidence: number, model: readonly BandFit[]): number | null {
  const band = model[bandIndex(confidence)];
  if (band === undefined || band.action === 'not-estimable') return null;
  return band.action === 'refit' ? band.estimate : confidence;
}

function check(items: readonly CalibrationDatum[], model: readonly BandFit[]): CalibrationCheck {
  let labelled = 0;
  let estimated = 0;
  let rawSquaredError = 0;
  let mappedSquaredError = 0;
  for (const d of items) {
    if (d.verdict !== 'tp' && d.verdict !== 'fp') continue;
    labelled += 1;
    const mapped = calibratedConfidence(d.confidence, model);
    if (mapped === null) continue;
    estimated += 1;
    const target = d.verdict === 'tp' ? 1 : 0;
    rawSquaredError += (d.confidence - target) ** 2;
    mappedSquaredError += (mapped - target) ** 2;
  }
  const mean = (sum: number): number | null => estimated === 0 ? null : Math.round(sum / estimated * 1e12) / 1e12;
  return { findings: items.length, labelled, estimated, rawBrier: mean(rawSquaredError), calibratedBrier: mean(mappedSquaredError) };
}

export function confidenceFit(items: readonly CalibrationDatum[]): ConfidenceFit {
  const ids = new Set<string>();
  for (const d of items) {
    if (ids.has(d.id)) throw new ConfigError('duplicate finding id in calibration input');
    ids.add(d.id);
    if (!Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1) throw new ConfigError('calibration confidence must be finite and in [0, 1]');
  }
  const sealed = items.filter((d) => d.partition === 'sealed');
  const dev = items.filter((d) => d.partition === 'dev').slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sealedGroups = new Set(sealed.map((d) => d.group));
  if (dev.some((d) => sealedGroups.has(d.group))) throw new ConfigError('one upstream repository cannot train calibration and belong to the sealed partition');
  const groups = unique(dev.map((d) => d.group));
  const model = fit(dev);
  return {
    target: 'finding-correctness',
    basis: 'raw-findings-tp-over-tp-plus-fp',
    inputDigest: createHash('sha256').update(JSON.stringify(dev.map((d) => [d.id, d.group, d.confidence, d.verdict]))).digest('hex'),
    trainingRepos: unique(dev.map((d) => d.repo)),
    trainingGroups: groups.length,
    model,
    folds: groups.map((group) => {
      const train = dev.filter((d) => d.group !== group);
      const heldOut = dev.filter((d) => d.group === group);
      const foldModel = fit(train);
      return { heldOutRepos: unique(heldOut.map((d) => d.repo)), trainingRepos: unique(train.map((d) => d.repo)), model: foldModel, check: check(heldOut, foldModel) };
    }),
    sealedCheck: check(sealed, model),
  };
}
