/**
 * The report: a deterministic body, and run metadata kept apart from it.
 *
 * `buildReport` is a pure function of its input. Everything that varies
 * between two runs over the same inputs (the clock, wall-clock durations, the
 * Node version) lives under `run`, and the markdown renders it in its own
 * trailing section, so two runs over the same corpus and labels produce
 * byte-identical bodies.
 *
 * The sealed partition is reported as counts. Whoever tunes detectors must not
 * be able to read the held-out repositories off the report, so for a sealed
 * repository:
 *
 * - a finding is listed in `report.json` by `id`, `repo`, `partition`, `code`,
 *   `severity`, `confidence`, `calibratedConfidence`, `occurrences`, and `verdict` only: not its
 *   subjects, claim, or facts, and not the reviewer's cluster name (free text
 *   written by someone who read the finding), which is already folded into the
 *   clustered counts;
 * - an extractor diagnostic is reduced to its code, the part before the first
 *   colon (`CONTRACT_NAME_COLLISION`), because the rest names the repository's
 *   own files and symbols;
 * - a detector's UNKNOWN reason is reduced the same way (`SCOPE_NOT_PASS`),
 *   because it names scopes; a head that is not an upper-case code becomes
 *   `(unclassified)`;
 * - the cause of a crash or timeout is reduced to the outcome.
 *
 * The one door to a sealed finding is `pnpm eval label-sheet <repo>`, for
 * reviewers, and it opens only once the partition is frozen.
 */

import { CONTRADICTION_CODES, type ContradictionCode } from '@seamline/ontology';
import type { CliIdentity } from './build.ts';
import { compareFindings } from './findings.ts';
import { calibratedConfidence, confidenceFit, repositoryGroup, type ConfidenceFit } from './calibration.ts';
import { ConfigError } from './errors.ts';
import { NO_FREEZE, type FreezeState } from './freeze.ts';
import type { LabelMatch } from './labels.ts';
import { auditReviews, type ReviewAudit, type ReviewMetadata } from './review.ts';
import {
  calibrate,
  clusteredTally,
  detectorStatus,
  formatInterval,
  formatRatio,
  headline,
  precisionStat,
  rawTally,
  recall,
  RELEASE_BAR,
  strictStat,
  type CalibrationRow,
  type DetectorStatus,
  type Headline,
  type PrecisionStat,
  type TallyItem,
} from './metrics.ts';
import type { MutantVerdict } from './mutants.ts';
import {
  PARTITIONS,
  type CorpusEntry,
  type DetectorOutcome,
  type ExtractorSummary,
  type Finding,
  type Mutant,
  type Partition,
  type PipelineResult,
  type Verdict,
} from './types.ts';

export type MutantStatus = 'detected' | 'missed' | 'unknown' | 'invalid' | 'error' | 'skipped';

/** Statuses that count toward recall. The rest are reported but excluded. */
export const EVALUATED_STATUSES: readonly MutantStatus[] = ['detected', 'missed', 'unknown'];

export interface RepoRun {
  readonly entry: CorpusEntry;
  readonly pipeline: PipelineResult;
}

export interface MutantRun {
  readonly mutant: Mutant;
  readonly status: MutantStatus;
  readonly detail: string | null;
  readonly verdict: MutantVerdict | null;
  readonly wallMs: number;
}

export interface RunMetaInput {
  readonly startedAt: string;
  readonly node: string;
  readonly totalWallMs: number;
  readonly reusedBaselines: readonly string[];
}

export interface RunMeta extends RunMetaInput {
  readonly repoWallMs: Readonly<
    Record<string, { readonly extractMs: number; readonly checkMs: number }>
  >;
  readonly mutantWallMs: Readonly<Record<string, number>>;
}

/**
 * What the report measured, beyond the freeze it records separately: the sources, the code that
 * scored them, and the build that ran. Equal values mean equal inputs, so they belong to the
 * deterministic body, not to `run`.
 */
export interface Provenance {
  /** Digest of the sources that decide what a finding is (`codeIdentity`), or `no git`. */
  readonly codeId: string;
  /**
   * Digest of the harness code the freeze does not watch (`scorerIdentity`): the scorer, the
   * report and the rest. A sealed headline is read against the value recorded at the freeze.
   */
  readonly scorerDigest: string;
  /**
   * Digest of the sealed entries of the corpus the run used (`sealedEntriesDigest`): which
   * repositories are sealed, and at which commit. The freeze compares the same digest of
   * `eval/corpus.json` with the freeze commit's.
   */
  readonly sealedCorpusDigest: string;
  /** The CLI that ran, and a digest of the compiled output it was built from. */
  readonly cli: CliIdentity;
}

export interface ReportInput {
  readonly repos: readonly RepoRun[];
  readonly mutants: readonly MutantRun[];
  readonly match: LabelMatch;
  /** True when a filter was used, so the table does not describe the whole corpus. */
  readonly partial: boolean;
  readonly run: RunMetaInput;
  readonly freeze?: FreezeState;
  readonly provenance: Provenance;
  readonly reviewMetadata?: ReviewMetadata | null;
}

export interface RepoReport {
  readonly name: string;
  readonly sha: string;
  readonly license: string;
  readonly partition: Partition;
  readonly stacks: readonly string[];
  readonly analysis: PipelineResult['outcome'];
  readonly detail: string | null;
  readonly extractors: readonly ExtractorSummary[];
  readonly degradedScopes: readonly string[];
  readonly nodeCounts: Readonly<Record<string, number>>;
  readonly edgeCounts: Readonly<Record<string, number>>;
  readonly nodes: number;
  readonly edges: number;
  readonly findings: number;
  readonly detectors: Readonly<Record<ContradictionCode, DetectorOutcome>>;
}

export interface DetectorRow extends PrecisionStat {
  readonly code: ContradictionCode;
  /** Distinct findings on the unmodified repositories. Mutants never count. */
  readonly findings: number;
  /** The strict reading of the raw verdicts: `unclear` is not `tp`. */
  readonly strict: PrecisionStat;
  /** The lenient verdicts with each cluster counted once. */
  readonly clustered: PrecisionStat;
  /** The strict verdicts with each cluster counted once. */
  readonly clusteredStrict: PrecisionStat;
  /** Labelled sealed clusters (strict reading), and what they say about the detector. */
  readonly sealedClusters: number;
  readonly status: DetectorStatus;
  /** Mutants that were evaluated (detected, missed, or detector UNKNOWN). */
  readonly mutants: number;
  readonly detected: number;
  /** Evaluated mutants whose detector was UNKNOWN on the mutated run (counted as misses). */
  readonly unknownMutants: number;
  /** `detected / mutants`, or `null` (n/a) when there is no evaluated mutant. */
  readonly recall: number | null;
  readonly firesOnCorpus: boolean;
  readonly unknownRepos: readonly string[];
}

export interface PartitionReport extends PrecisionStat {
  readonly partition: Partition;
  readonly repos: readonly string[];
  readonly findings: number;
  readonly strict: PrecisionStat;
  readonly clustered: PrecisionStat;
  readonly clusteredStrict: PrecisionStat;
}

export interface MutantReport {
  readonly id: string;
  readonly repo: string;
  readonly detector: ContradictionCode;
  readonly description: string;
  readonly status: MutantStatus;
  readonly detail: string | null;
  readonly matched: { readonly id: string; readonly left: string; readonly right: string } | null;
  readonly newFindingCount: number;
  readonly newFindings: readonly {
    readonly id: string;
    readonly code: ContradictionCode;
    readonly left: string;
    readonly right: string;
  }[];
  readonly lostFindings: number;
}

/**
 * A finding as the report lists it. For a sealed repository only the fields
 * above the line are present (see the module comment).
 */
export interface FindingReport {
  readonly id: string;
  readonly repo: string;
  readonly partition: Partition;
  readonly code: ContradictionCode;
  readonly severity: Finding['severity'];
  readonly confidence: number;
  /** Additive development-fit estimate; null when the band cannot be estimated. */
  readonly calibratedConfidence: number | null;
  readonly occurrences: number;
  readonly verdict: Verdict | null;
  // Dev partition only:
  readonly cluster?: string | null;
  readonly left?: string;
  readonly right?: string;
  readonly claim?: string;
  readonly leftFact?: string;
  readonly rightFact?: string;
  readonly viaPath?: readonly string[];
}

export interface Report {
  readonly schema: 8;
  readonly partial: boolean;
  readonly freeze: FreezeState;
  readonly provenance: Provenance;
  readonly repos: readonly RepoReport[];
  readonly detectors: readonly DetectorRow[];
  readonly overall: PrecisionStat & {
    readonly findings: number;
    readonly strict: PrecisionStat;
    readonly clustered: PrecisionStat;
    readonly clusteredStrict: PrecisionStat;
    readonly mutants: number;
    readonly detected: number;
    readonly recall: number | null;
  };
  readonly partitions: readonly PartitionReport[];
  readonly headline: Headline;
  readonly calibration: readonly CalibrationRow[];
  readonly confidenceFit: ConfidenceFit;
  readonly review: ReviewAudit;
  readonly mutants: readonly MutantReport[];
  readonly findings: readonly FindingReport[];
  readonly labels: {
    readonly unlabelled: readonly string[];
    readonly stale: readonly string[];
    readonly staleChecked: boolean;
    /** Labelled findings whose reviewer saw only the label sheet. */
    readonly blind: number;
  };
  /** Varies between runs. Never read by anything that compares reports. */
  readonly run: RunMeta;
}

const MAX_NEW_FINDINGS = 10;

function sum(values: Iterable<number>): number {
  let n = 0;
  for (const v of values) n += v;
  return n;
}

function byName<T extends { readonly name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** What a diagnostic code looks like: an upper-case identifier such as `CONTRACT_NAME_COLLISION`. */
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]+$/;

/**
 * The code of an extractor diagnostic: the text before the first colon, when it
 * is an upper-case identifier (`CONTRACT_NAME_COLLISION`). Anything else is
 * `(unclassified)`. This is an allow-list, not a shape test: a head such as a
 * symbol or file name that a future message interpolates before its colon
 * (`SecretIdentifier: ...`) is not an upper-case code, so it cannot pass for
 * one, and a message without a colon is all detail.
 */
export function diagnosticCode(diagnostic: string): string {
  const at = diagnostic.indexOf(':');
  const head = at > 0 ? diagnostic.slice(0, at).trim() : '';
  return DIAGNOSTIC_CODE.test(head) ? head : '(unclassified)';
}

/** The distinct diagnostic codes, sorted, in place of the diagnostics themselves. */
export function diagnosticCodes(diagnostics: readonly string[]): string[] {
  return [...new Set(diagnostics.map(diagnosticCode))].sort();
}

interface Row {
  readonly finding: Finding;
  readonly partition: Partition;
  readonly verdict: Verdict | null;
  readonly cluster: string | undefined;
}

function tallyItems(rows: readonly Row[]): TallyItem[] {
  return rows.map((r) => ({ repo: r.finding.repo, code: r.finding.code, verdict: r.verdict, cluster: r.cluster }));
}

function repoReport({ entry, pipeline }: RepoRun): RepoReport {
  const sealed = entry.partition === 'sealed';
  // A detector's UNKNOWN reason comes from the CLI, or from the cause of a crash; for a sealed
  // repository it is reduced like a diagnostic, and dropped when the analysis did not complete.
  const unknownReason = (o: DetectorOutcome): DetectorOutcome =>
    o.state !== 'unknown' || o.reason === undefined
      ? o
      : pipeline.outcome !== 'complete'
        ? { state: o.state, findings: o.findings }
        : { state: o.state, findings: o.findings, reason: diagnosticCode(o.reason) };
  return {
    name: entry.name,
    sha: entry.sha,
    license: entry.license,
    partition: entry.partition,
    stacks: entry.stacks,
    analysis: pipeline.outcome,
    detail: sealed && pipeline.outcome !== 'complete' ? pipeline.outcome : pipeline.detail,
    extractors: sealed
      ? pipeline.extractors.map((e) => ({ ...e, diagnostics: diagnosticCodes(e.diagnostics) }))
      : pipeline.extractors,
    degradedScopes: pipeline.degradedScopes,
    nodeCounts: pipeline.nodeCounts,
    edgeCounts: pipeline.edgeCounts,
    nodes: sum(Object.values(pipeline.nodeCounts)),
    edges: sum(Object.values(pipeline.edgeCounts)),
    findings: pipeline.findings.length,
    detectors: sealed
      ? (Object.fromEntries(
          CONTRADICTION_CODES.map((c) => [c, unknownReason(pipeline.detectors[c])]),
        ) as Record<ContradictionCode, DetectorOutcome>)
      : pipeline.detectors,
  };
}

export function buildReport(input: ReportInput): Report {
  const labelOf = new Map(input.match.labelled.map((l) => [l.finding.id, l.label]));
  const partitionOf = new Map(input.repos.map((r) => [r.entry.name, r.entry.partition]));
  const freeze = input.freeze ?? NO_FREEZE;

  const repos: RepoReport[] = input.repos
    .slice()
    .sort((a, b) => byName(a.entry, b.entry))
    .map(repoReport);

  const rows: Row[] = input.repos
    .flatMap((r) => r.pipeline.findings)
    .slice()
    .sort(compareFindings)
    .map((finding) => {
      const label = labelOf.get(finding.id);
      return {
        finding,
        partition: partitionOf.get(finding.repo) ?? 'dev',
        verdict: label?.verdict ?? null,
        cluster: input.match.clusters.get(finding.id),
      };
    });

  const groupOf = new Map(input.repos.map((r) => [r.entry.name, repositoryGroup(r.entry.url)]));
  const groupPartitions = new Map<string, Partition>();
  for (const { entry } of input.repos) {
    const group = groupOf.get(entry.name)!;
    const previous = groupPartitions.get(group);
    if (previous !== undefined && previous !== entry.partition) throw new ConfigError('one upstream repository cannot occur in both calibration partitions');
    groupPartitions.set(group, entry.partition);
  }
  const fittedConfidence = confidenceFit(rows.map((r) => ({
    id: r.finding.id, repo: r.finding.repo, group: groupOf.get(r.finding.repo)!,
    partition: r.partition, confidence: r.finding.confidence, verdict: r.verdict,
  })));

  const findings: FindingReport[] = rows.map(({ finding: f, partition, verdict, cluster }) => ({
    id: f.id,
    repo: f.repo,
    partition,
    code: f.code,
    severity: f.severity,
    confidence: f.confidence,
    calibratedConfidence: calibratedConfidence(f.confidence, fittedConfidence.model),
    occurrences: f.occurrences,
    verdict,
    ...(partition === 'sealed'
      ? {}
      : {
          cluster: cluster ?? null,
          left: f.left,
          right: f.right,
          claim: f.claim,
          leftFact: f.leftFact,
          rightFact: f.rightFact,
          viaPath: f.viaPath,
        }),
  }));

  const mutants: MutantReport[] = input.mutants
    .slice()
    .sort((a, b) => (a.mutant.id < b.mutant.id ? -1 : a.mutant.id > b.mutant.id ? 1 : 0))
    .map((m) => {
      const fresh = (m.verdict?.newFindings ?? []).slice().sort(compareFindings);
      return {
        id: m.mutant.id,
        repo: m.mutant.repo,
        detector: m.mutant.detector,
        description: m.mutant.description,
        status: m.status,
        detail: m.detail,
        matched:
          m.verdict?.matched == null
            ? null
            : {
                id: m.verdict.matched.id,
                left: m.verdict.matched.left,
                right: m.verdict.matched.right,
              },
        newFindingCount: fresh.length,
        newFindings: fresh
          .slice(0, MAX_NEW_FINDINGS)
          .map((f) => ({ id: f.id, code: f.code, left: f.left, right: f.right })),
        lostFindings: m.verdict?.lostFindings ?? 0,
      };
    });

  const stats = (subset: readonly Row[]) => {
    const raw = rawTally(tallyItems(subset));
    const clustered = clusteredTally(tallyItems(subset));
    return {
      ...precisionStat(raw),
      strict: strictStat(raw),
      clustered: precisionStat(clustered),
      clusteredStrict: strictStat(clustered),
    };
  };

  const detectors: DetectorRow[] = CONTRADICTION_CODES.map((code) => {
    const mine = rows.filter((r) => r.finding.code === code);
    const evaluated = mutants.filter(
      (m) => m.detector === code && EVALUATED_STATUSES.includes(m.status),
    );
    const detected = evaluated.filter((m) => m.status === 'detected').length;
    const sealedClustered = strictStat(
      clusteredTally(tallyItems(mine.filter((r) => r.partition === 'sealed'))),
    );
    return {
      code,
      findings: mine.length,
      ...stats(mine),
      sealedClusters: sealedClustered.n,
      status: detectorStatus(sealedClustered),
      mutants: evaluated.length,
      detected,
      unknownMutants: evaluated.filter((m) => m.status === 'unknown').length,
      recall: recall(detected, evaluated.length),
      firesOnCorpus: mine.length > 0,
      unknownRepos: repos
        .filter((r) => r.detectors[code].state === 'unknown')
        .map((r) => r.name)
        .sort(),
    };
  });

  const partitions: PartitionReport[] = PARTITIONS.map((partition) => {
    const mine = rows.filter((r) => r.partition === partition);
    return {
      partition,
      repos: repos.filter((r) => r.partition === partition).map((r) => r.name),
      findings: mine.length,
      ...stats(mine),
    };
  });
  const sealedRows = rows.filter((r) => r.partition === 'sealed');
  const review = auditReviews(input.reviewMetadata ?? null, input.provenance.codeId,
    rows.map((row) => row.finding), input.match, partitionOf);

  const evaluatedAll = sum(detectors.map((d) => d.mutants));
  const detectedAll = sum(detectors.map((d) => d.detected));

  return {
    schema: 8,
    partial: input.partial,
    freeze,
    provenance: input.provenance,
    repos,
    detectors,
    overall: {
      findings: rows.length,
      ...stats(rows),
      mutants: evaluatedAll,
      detected: detectedAll,
      recall: recall(detectedAll, evaluatedAll),
    },
    partitions,
    headline: headline(clusteredTally(tallyItems(sealedRows)), {
      burned: freeze.state === 'burned',
      detectorsBelow: detectors.filter((d) => d.status === 'below').map((d) => d.code),
      unanalysed: repos
        .filter((r) => r.partition === 'sealed' && r.analysis !== 'complete')
        .map((r) => r.name),
      partial: input.partial,
      reviewIncomplete: review.sealed.labelledFindings > 0 && !review.overall.ready,
    }),
    calibration: calibrate(
      rows.filter((r) => r.partition === 'dev').map((r) => ({ confidence: r.finding.confidence, verdict: r.verdict })),
    ),
    confidenceFit: fittedConfidence,
    review,
    mutants,
    findings,
    labels: {
      unlabelled: input.match.unlabelled.map((f) => f.id).sort(),
      stale: input.match.stale.slice().sort(),
      staleChecked: input.match.staleChecked,
      blind: input.match.labelled.filter((l) => l.label.blind).length,
    },
    run: {
      ...input.run,
      repoWallMs: Object.fromEntries(
        input.repos
          .slice()
          .sort((a, b) => byName(a.entry, b.entry))
          .map((r) => [
            r.entry.name,
            { extractMs: r.pipeline.extractMs, checkMs: r.pipeline.checkMs },
          ]),
      ),
      mutantWallMs: Object.fromEntries(
        input.mutants
          .slice()
          .sort((a, b) => (a.mutant.id < b.mutant.id ? -1 : 1))
          .map((m) => [m.mutant.id, m.wallMs]),
      ),
    },
  };
}

/** The report without `run`: what must be identical between two runs over the same inputs. */
export function reportBody(report: Report): Omit<Report, 'run'> {
  const { run: _run, ...body } = report;
  return body;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[k];
      if (child !== undefined) out[k] = sortKeys(child);
    }
    return out;
  }
  return v;
}

/** Canonical JSON: keys sorted at every level, two-space indent, trailing newline. */
export function serializeReport(report: Report): string {
  return `${JSON.stringify(sortKeys(report), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function short(code: string): string {
  return code.split('_')[0] ?? code;
}

/** `leftCols` leading columns are left-aligned (text); the rest are right-aligned (numbers). */
function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  leftCols = 1,
): string[] {
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map((_, i) => (i < leftCols ? '---' : '---:')).join(' | ')} |`,
  ];
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  return lines;
}

function kv(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts);
  return entries.length === 0 ? '(none)' : entries.map(([k, n]) => `${k} ${n}`).join(', ');
}

function yesNo(b: boolean): string {
  return b ? 'yes' : 'no';
}

/** `0.923 [0.667, 0.986] n=13`, or `n/a (n=0)`: a ratio, its Wilson interval, and the sample it rests on. */
export function formatStat(stat: PrecisionStat): string {
  return stat.precision === null
    ? `n/a (n=${stat.n})`
    : `${formatRatio(stat.precision)} ${formatInterval(stat.interval)} n=${stat.n}`;
}

function formatRecall(value: number | null, n: number): string {
  return value === null ? 'n/a' : `${formatRatio(value)} n=${n}`;
}

function statusText(d: Pick<DetectorRow, 'status' | 'sealedClusters'>): string {
  return d.status === 'unmeasured'
    ? `unmeasured (${d.sealedClusters} of ${RELEASE_BAR.perDetector.minClusters} sealed clusters)`
    : d.status === 'meets'
      ? `meets ${RELEASE_BAR.perDetector.minPrecision.toFixed(2)}`
      : `below ${RELEASE_BAR.perDetector.minPrecision.toFixed(2)}`;
}

function headlineLines(report: Report): string[] {
  const h = report.headline;
  const sealed = report.partitions.find((p) => p.partition === 'sealed');
  const where =
    sealed === undefined
      ? ''
      : `, from ${sealed.findings} finding(s) in ${sealed.repos.join(', ') || 'no repository'}`;
  const bar =
    `Release bar (strict precision >= ${RELEASE_BAR.minPrecision} and Wilson lower bound >= ` +
    `${RELEASE_BAR.minLowerBound} over >= ${h.minLabelled} labelled clusters, no detector with ` +
    `>= ${RELEASE_BAR.perDetector.minClusters} clusters below ${RELEASE_BAR.perDetector.minPrecision})`;
  if (h.status === 'powered') {
    const blockers =
      h.detectorsBelow.length === 0
        ? ''
        : ` Below ${RELEASE_BAR.perDetector.minPrecision}: ${h.detectorsBelow.join(', ')}.`;
    // The pooled figure can be carried by a few detectors while others are unmeasured, so the
    // line says how many, and a quoted headline cannot hide it.
    const unmeasured = report.detectors.filter((d) => d.status === 'unmeasured').length;
    return [
      `**Headline (sealed partition, by cluster, strict reading): precision ${formatStat(h.strict)}.** ` +
        `Lenient reading (unclear excluded): ${formatStat(h.lenient)}. ` +
        `${bar}: ${h.meetsBar === true ? 'met' : 'not met'}.${blockers} ` +
        `${unmeasured} of ${report.detectors.length} detectors unmeasured.`,
    ];
  }
  if (h.status === 'burned') {
    return [
      `**Headline: withheld, the sealed partition is burned.** A watched path changed after the freeze ` +
        `(${report.freeze.changed.length} path(s)), so the sealed repositories no longer measure a frozen ` +
        'product and must be replaced. No sealed figure is claimed.',
    ];
  }
  if (h.status === 'incomplete') {
    const why: string[] = [];
    if (h.unlabelled > 0) {
      why.push(
        `${h.unlabelled} sealed finding(s) have no label, so a figure over the labelled ones is a selection of the easy cases`,
      );
    }
    if (h.unanalysed.length > 0) {
      why.push(
        `the analysis of sealed ${h.unanalysed.length === 1 ? 'repository' : 'repositories'} ${h.unanalysed.join(', ')} did not complete, so what it would have found is unknown, not absent`,
      );
    }
    if (h.partial) {
      why.push(
        'this was a partial run (a repository or mutant filter), which does not cover the corpus',
      );
    }
    if (h.reviewIncomplete) why.push('declared independent identities or the required double-review sample are incomplete');
    return [
      `**Headline: incomplete.** ${why.join('; ')}. No headline precision is claimed and the release ` +
        `bar cannot be assessed. Sealed so far: ${formatStat(h.strict)} strict${where}.`,
    ];
  }
  return [
    `**Headline: underpowered.** The sealed partition has ${h.strict.n} labelled cluster(s) ` +
      `(true positive, false positive, or unclear; need at least ${h.minLabelled}), so no headline ` +
      `precision is claimed and the release bar cannot be assessed. Sealed so far: ` +
      `${formatStat(h.strict)} strict${where}.`,
  ];
}

export interface MarkdownOptions {
  /** Include the per-finding appendix. Left out of the stdout summary. */
  readonly appendix: boolean;
  /** Include the run-metadata section. */
  readonly runMeta: boolean;
}

export function renderMarkdown(
  report: Report,
  options: MarkdownOptions = { appendix: true, runMeta: true },
): string {
  const o = report.overall;
  const out: string[] = [];
  out.push('# Seamline evaluation report', '');
  if (report.partial) {
    out.push(
      '> Partial run: a repository or mutant filter was used, so these tables do not describe the whole corpus.',
      '',
    );
  }
  out.push(...headlineLines(report), '');
  out.push(
    `Overall precision, every finding counted, lenient (unclear excluded): ${formatStat(o)}; ` +
      `strict (unclear is not a true positive): ${formatStat(o.strict)}. ` +
      `${o.tp} true positive, ${o.fp} false positive, ${o.unclear} unclear, ${o.unlabelled} unlabelled ` +
      '(unlabelled findings are in neither ratio). ' +
      `Clustered, each cluster counted once: lenient ${formatStat(o.clustered)}; strict ${formatStat(o.clusteredStrict)}.`,
    '',
    `Findings: ${o.findings}. ` +
      `Mutants: ${o.detected} of ${o.mutants} detected (recall ${formatRecall(o.recall, o.mutants)}). ` +
      `Labels judged blind: ${report.labels.blind} of ${o.tp + o.fp + o.unclear}.`,
    '',
  );

  out.push('## Declared review evidence', '',
    `Metadata: ${report.review.metadata}; ${report.review.declaredAuthorAccounts} declared change-author account(s).`, '',
    ...table(['Partition', 'Findings', 'Independent primary', 'Clusters', 'Double reviewed', 'Required sample', 'Agreeing pairs', 'Review pairs', 'Agreement', 'Ready'],
      (['overall', ...PARTITIONS] as const).map((partition) => {
        const r = report.review[partition];
        return [partition, String(r.findings), String(r.independentPrimaryFindings), String(r.clusters),
          String(r.doubleReviewedClusters), partition === 'overall' ? String(report.review.overall.requiredDoubleReviewedClusters) : '-', String(r.agreeingPairs),
          String(r.reviewPairs), formatRatio(r.agreement), partition === 'overall' ? (report.review.overall.ready ? 'yes' : 'no') : '-'];
      })), '',
    'Identities and the complete change-author roster are declared inputs, not authenticated accounts or verified authorship. Release reviewers must check both. Shared accounts cannot form an independent pair. Every finding in a sampled cluster must have two eligible complete reviewer identities with distinct accounts; agreement includes all such pairs and preserves disagreements. Legacy labels receive no formal identity credit. Raw findings, labels, clusters and numeric precision/recall remain unchanged.', '');
  out.push('## Detectors', '', '### Precision', '');
  out.push(
    ...table(
      [
        'Detector',
        'Findings',
        'TP',
        'FP',
        'Unclear',
        'Unlabelled',
        'Lenient precision (95% Wilson)',
        'Strict precision',
        'Clustered, lenient',
        'Clustered, strict',
        'Status',
      ],
      report.detectors.map((d) => [
        d.code,
        String(d.findings),
        String(d.tp),
        String(d.fp),
        String(d.unclear),
        String(d.unlabelled),
        formatStat(d),
        formatStat(d.strict),
        formatStat(d.clustered),
        formatStat(d.clusteredStrict),
        statusText(d),
      ]),
      1,
    ),
    '',
    `Status is read on the sealed partition, by cluster, strict: a detector with fewer than ${RELEASE_BAR.perDetector.minClusters} ` +
      `labelled clusters is unmeasured and cannot be called validated; with ${RELEASE_BAR.perDetector.minClusters} or more it needs a point estimate of ` +
      `${RELEASE_BAR.perDetector.minPrecision}. Findings are counted on the unmodified repositories only. Numeric detector statuses do not establish independent review; see Declared review evidence.`,
    '',
  );

  out.push('### Recall and firing', '');
  out.push(
    ...table(
      [
        'Detector',
        'Mutants',
        'Detected',
        'Not detected',
        'of which UNKNOWN',
        'Recall',
        'Fires on corpus',
        'UNKNOWN repos',
      ],
      report.detectors.map((d) => [
        d.code,
        String(d.mutants),
        String(d.detected),
        String(d.mutants - d.detected),
        String(d.unknownMutants),
        formatRecall(d.recall, d.mutants),
        yesNo(d.firesOnCorpus),
        `${d.unknownRepos.length}/${report.repos.length}`,
      ]),
    ),
    '',
    'A mutant whose detector was UNKNOWN on the mutated repository (the detector could not run) counts as not detected, and ' +
      'says nothing about whether it would have fired; "of which UNKNOWN" separates it from a detector that ran and missed. ' +
      'A mutant never makes a detector fire on the corpus. A detector that is UNKNOWN on a repository has said nothing ' +
      'about it, which is not the same as zero.',
    '',
  );
  const dormant = report.detectors.filter((d) => !d.firesOnCorpus);
  if (dormant.length > 0) {
    out.push(
      `Dormant on the measured unmodified corpus (no findings): ${dormant.map((d) => short(d.code)).join(', ')}. ` +
        'Each is either blocked (UNKNOWN on a repository, see the last column) or quiet where it ran; the two are different. ' +
        'A detected mutant measures recall; it does not establish an unmodified external firing.',
      '',
    );
  }

  out.push('## Partitions', '');
  out.push(
    ...table(
      [
        'Partition',
        'Repositories',
        'Findings',
        'TP',
        'FP',
        'Unclear',
        'Unlabelled',
        'Lenient precision (95% Wilson)',
        'Strict precision',
        'Clustered, strict',
      ],
      report.partitions.map((p) => [
        p.partition,
        p.repos.join(', ') || '(none)',
        String(p.findings),
        String(p.tp),
        String(p.fp),
        String(p.unclear),
        String(p.unlabelled),
        formatStat(p),
        formatStat(p.strict),
        formatStat(p.clusteredStrict),
      ]),
      2,
    ),
    '',
    'The sealed partition is held out: its findings are reported as counts and are not listed in this report. ' +
      `Freeze: ${
        report.freeze.state === 'none'
          ? 'no freeze recorded; re-freeze on the public history before the next release evaluation (sealed labels are not allowed until then)'
          : `${report.freeze.state} at ${report.freeze.sha?.slice(0, 12) ?? '?'}`
      }.`,
    '',
  );

  const cli = report.provenance.cli;
  out.push(
    '## Provenance',
    '',
    `- Freeze commit: ${report.freeze.sha ?? 'none'}`,
    `- Product sources (codeId): ${report.provenance.codeId}`,
    `- CLI: ${cli.path}, ${
      cli.ownBuild
        ? "this repository's own build; digest of the compiled output"
        : "not this repository's build; digest of that file alone"
    } ${cli.distDigest}`,
    `- Sealed corpus entries (sealedCorpusDigest): ${report.provenance.sealedCorpusDigest}`,
    `- Scorer sources (scorerDigest): ${report.provenance.scorerDigest}`,
    '',
    'The sealed headline describes the product and the sealed repositories named by the first four ' +
      'lines. The last is the harness code that scored it; it is not watched by the freeze, so it is ' +
      'compared with the value recorded at the freeze (see the release checklist).',
    '',
  );

  out.push('## Calibration', '');
  out.push(
    ...table(
      [
        'Confidence band',
        'Findings',
        'Labelled',
        'TP',
        'FP',
        'Unclear',
        'Observed precision',
        '95% interval',
      ],
      report.calibration.map((c) => [
        c.band,
        String(c.findings),
        String(c.labelled),
        String(c.tp),
        String(c.fp),
        String(c.unclear),
        formatRatio(c.precision),
        formatInterval(c.interval),
      ]),
    ),
    '',
    'Per raw finding, development partition only; TP/(TP+FP), with unclear and unlabelled counts kept separately. Sparse bands do not establish probabilities.',
    '',
  );

  out.push(
    `Finding-correctness fit: ${report.confidenceFit.trainingRepos.length} development checkout(s), ${report.confidenceFit.trainingGroups} upstream repository group(s).`,
    `Fitting-input digest: ${report.confidenceFit.inputDigest}`, '',
    ...table(['Band', 'Labelled', 'Upstreams', 'Action', 'Estimate'], report.confidenceFit.model.map((b) =>
      [b.band, String(b.labelled), String(b.repositories), b.action, formatRatio(b.estimate)],
    )), '',
    'A band needs labels from at least two development upstreams. Refit only when its Wilson interval is wholly outside the nominal band; otherwise retain raw scores. No finding is removed or re-gated.', '',
    ...table(['Held out', 'Training checkouts', 'Labelled check', 'Estimable check', 'Raw Brier', 'Mapped Brier'], report.confidenceFit.folds.map((f) =>
      [f.heldOutRepos.join(', '), f.trainingRepos.join(', '), String(f.check.labelled), String(f.check.estimated), formatRatio(f.check.rawBrier), formatRatio(f.check.calibratedBrier)],
    )), '',
    `Sealed check only: ${report.confidenceFit.sealedCheck.labelled} labelled, ${report.confidenceFit.sealedCheck.estimated} estimable; raw Brier ${formatRatio(report.confidenceFit.sealedCheck.rawBrier)}, mapped Brier ${formatRatio(report.confidenceFit.sealedCheck.calibratedBrier)}.`, '',
    'Each fold holds out every pin of one upstream together. Brier pairs use the same labelled, estimable findings; n/a means no estimate. Unclear labels do not enter these lenient calibration ratios. This calibrates finding correctness, not lineage-edge probabilities. Raw confidence, all findings, precision/recall denominators and firing states remain unchanged.', '',
  );

  out.push('## Repositories', '');
  out.push(
    ...table(
      [
        'Repository',
        'Partition',
        'Commit',
        'Analysis',
        'Nodes',
        'Edges',
        'Findings',
        'Scopes not PASS',
      ],
      report.repos.map((r) => [
        r.name,
        r.partition,
        r.sha.slice(0, 12),
        r.analysis === 'complete' ? 'complete' : `${r.analysis}: ${r.detail ?? ''}`,
        String(r.nodes),
        String(r.edges),
        String(r.findings),
        r.degradedScopes.length === 0 ? 'none' : r.degradedScopes.join(', '),
      ]),
      4,
    ),
    '',
  );

  out.push('### Extractors', '');
  const extractorRows: string[][] = [];
  for (const r of report.repos) {
    if (r.extractors.length === 0) {
      extractorRows.push([r.name, '(none ran)', r.analysis.toUpperCase(), '0', '0']);
    }
    for (const e of r.extractors) {
      extractorRows.push([r.name, e.name, e.status, String(e.nodes), String(e.edges)]);
    }
  }
  out.push(...table(['Repository', 'Extractor', 'Status', 'Nodes', 'Edges'], extractorRows, 3), '');

  const notes: string[] = [];
  for (const r of report.repos) {
    for (const e of r.extractors) {
      if (e.status !== 'PASS' && e.diagnostics.length > 0) {
        // A sealed repository's diagnostics were already reduced to codes in `repoReport`.
        const text = r.partition === 'sealed' ? e.diagnostics.join(', ') : (e.diagnostics[0] ?? '');
        notes.push(`- ${r.name} / ${e.name} (${e.status}): ${text}`);
      }
    }
  }
  if (notes.length > 0) out.push('Non-PASS extractors:', '', ...notes.map(cell), '');

  out.push('### Nodes by kind', '');
  for (const r of report.repos) out.push(`- ${r.name}: ${kv(r.nodeCounts)}`);
  out.push('', '### Edges by kind', '');
  for (const r of report.repos) out.push(`- ${r.name}: ${kv(r.edgeCounts)}`);
  out.push('');

  out.push('### Findings by detector and repository', '');
  out.push(
    ...table(
      ['Repository', ...CONTRADICTION_CODES.map(short)],
      report.repos.map((r) => [
        r.name,
        ...CONTRADICTION_CODES.map((code) => {
          const d = r.detectors[code];
          return d.state === 'unknown' ? 'UNKNOWN' : String(d.findings);
        }),
      ]),
    ),
    '',
    'UNKNOWN means the detector did not run on that repository; it is never reported as zero.',
    '',
  );

  const evaluatedMutants = report.mutants.filter((m) =>
    EVALUATED_STATUSES.includes(m.status),
  ).length;
  const unknownMutants = report.mutants.filter((m) => m.status === 'unknown').length;
  out.push('## Mutants', '');
  if (report.mutants.length === 0) {
    out.push('No mutants were run.', '');
  } else {
    out.push(
      ...table(
        ['Mutant', 'Repository', 'Detector', 'Result', 'Matched finding or note'],
        report.mutants.map((m) => [
          m.id,
          m.repo,
          short(m.detector),
          m.status,
          m.matched !== null
            ? `${m.matched.id} (${m.newFindingCount} new finding(s), ${m.lostFindings} lost)`
            : m.detail !== null
              ? m.detail
              : `${m.newFindingCount} new finding(s), ${m.lostFindings} lost`,
        ]),
        5,
      ),
      '',
      'Recall counts detected, missed, and detector-UNKNOWN mutants. Invalid, error, and skipped mutants are excluded and listed above.',
      '',
      ...(unknownMutants === 0
        ? []
        : [
            `${unknownMutants} of ${evaluatedMutants} evaluated mutant(s) were UNKNOWN on the mutated repository: the detector could not run there, so they count as misses and say nothing about whether it would have fired.`,
            '',
          ]),
    );
  }

  if (report.labels.unlabelled.length > 0) {
    out.push(
      '## Unlabelled findings',
      '',
      `${report.labels.unlabelled.length} finding(s) have no entry in labels.json and are excluded from precision.`,
      '',
    );
  }
  if (report.labels.stale.length > 0) {
    out.push(
      '## Stale labels',
      '',
      'These label ids match no current finding:',
      '',
      ...report.labels.stale.map((id) => `- ${id}`),
      '',
    );
  } else if (!report.labels.staleChecked) {
    out.push(
      'Stale-label check skipped: the run was partial or a repository was not analysed.',
      '',
    );
  }

  if (options.appendix) {
    out.push('## Findings (dev partition)', '');
    const listed = report.findings.filter((f) => f.partition === 'dev');
    if (listed.length === 0) out.push('No dev-partition findings.', '');
    for (const f of listed) {
      out.push(
        `- \`${f.id}\` ${short(f.code)} ${f.repo} ${f.severity} confidence ${f.confidence.toFixed(3)} ` +
          `[${f.verdict ?? 'unlabelled'}${f.cluster === null ? '' : `, cluster ${f.cluster}`}]: ${f.claim ?? ''}`,
        `  - left: ${f.left ?? ''}`,
        `  - right: ${f.right ?? ''}`,
      );
    }
    const held = report.findings.filter((f) => f.partition === 'sealed').length;
    out.push('', `Sealed partition: ${held} finding(s), not listed.`, '');
  }

  if (options.runMeta) {
    out.push(
      '## Run metadata (varies between runs)',
      '',
      `- Started: ${report.run.startedAt}`,
      `- Node: ${report.run.node}`,
      `- Total wall time: ${(report.run.totalWallMs / 1000).toFixed(1)}s`,
    );
    if (report.run.reusedBaselines.length > 0) {
      out.push(`- Baselines reused from a previous run: ${report.run.reusedBaselines.join(', ')}`);
    }
    out.push(
      '',
      ...table(
        ['Repository', 'Extract (s)', 'Check (s)'],
        Object.entries(report.run.repoWallMs).map(([name, w]) => [
          name,
          (w.extractMs / 1000).toFixed(1),
          (w.checkMs / 1000).toFixed(1),
        ]),
      ),
    );
    const mutantTimes = Object.entries(report.run.mutantWallMs);
    if (mutantTimes.length > 0) {
      out.push(
        '',
        ...table(
          ['Mutant', 'Wall time (s)'],
          mutantTimes.map(([id, ms]) => [id, (ms / 1000).toFixed(1)]),
        ),
      );
    }
    out.push('');
  }

  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
