/**
 * `eval/labels.json`: independent verdicts on findings.
 *
 * A finding with no label cannot enter the precision figure. That is the
 * rule that keeps a new finding from slipping past review: the evaluation
 * fails until someone has read the source at the pinned commit and decided.
 * A label whose finding no longer appears is reported as stale, so a fixed
 * detector or a changed pin does not leave verdicts silently attached to
 * nothing.
 *
 * A label is `{ verdict, cluster?, rationale, evidence, reviewer, blind }`:
 *
 * - `verdict` is `tp`, `fp`, or `unclear`. `unclear` is counted and shown but
 *   never enters precision.
 * - `cluster` overrides the default shared-endpoint components of one detector in one repository that are the same underlying
 *   defect (or false alarm); a cluster counts once in the clustered figures.
 * - `blind` records whether the reviewer judged from the label sheet alone
 *   (finding id, code, and the two subject locations), without Seamline's
 *   claim text or confidence.
 */

import { ConfigError } from './errors.ts';
import { findingClusters } from './clustering.ts';
import { parseReviewFields, parseReviewMetadata } from './review.ts';
import type { Finding, Label, Verdict } from './types.ts';

const ID = /^[0-9a-f]{16}$/;
/** `path:line` or `path:start-end`. Paths may contain brackets and parentheses. */
const EVIDENCE = /^[^\s:][^:]*:\d+(?:-\d+)?$/;
const CLUSTER = /^[a-z0-9][a-z0-9._-]*$/;
const VERDICTS: readonly string[] = ['tp', 'fp', 'unclear'];

export function parseLabels(raw: unknown): ReadonlyMap<string, Label> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('labels.json must be a JSON object mapping finding id to a label.');
  }
  const problems: string[] = [];
  const labels = new Map<string, Label>();
  parseReviewMetadata((raw as Record<string, unknown>)['_review']);

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '_review') continue;
    if (!ID.test(id)) {
      problems.push(`"${id}": a label key must be a 16-character lowercase hex finding id.`);
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.push(`${id}: the label must be an object.`);
      continue;
    }
    const rec = value as Record<string, unknown>;
    const verdict = rec['verdict'];
    const cluster = rec['cluster'];
    const rationale = rec['rationale'];
    const evidence = rec['evidence'];
    const reviewer = rec['reviewer'];
    const blind = rec['blind'];
    let ok = true;
    if (typeof verdict !== 'string' || !VERDICTS.includes(verdict)) {
      problems.push(`${id}: "verdict" must be "tp", "fp", or "unclear".`);
      ok = false;
    }
    if (cluster !== undefined && (typeof cluster !== 'string' || !CLUSTER.test(cluster))) {
      problems.push(`${id}: "cluster" must match ${CLUSTER.source} when given.`);
      ok = false;
    }
    if (typeof rationale !== 'string' || rationale.trim() === '') {
      problems.push(`${id}: "rationale" must be a non-empty string.`);
      ok = false;
    }
    if (
      !Array.isArray(evidence) ||
      evidence.length === 0 ||
      evidence.some((e) => typeof e !== 'string' || !EVIDENCE.test(e))
    ) {
      problems.push(`${id}: "evidence" must be a non-empty array of "path:line" citations.`);
      ok = false;
    }
    if (typeof reviewer !== 'string' || reviewer.trim() === '') {
      problems.push(`${id}: "reviewer" must name who reviewed the finding.`);
      ok = false;
    }
    if (typeof blind !== 'boolean') {
      problems.push(`${id}: "blind" must be true or false.`);
      ok = false;
    }
    if (ok) {
      labels.set(id, {
        verdict: verdict as Verdict,
        ...(cluster === undefined ? {} : { cluster: cluster as string }),
        rationale: rationale as string,
        evidence: (evidence as string[]).slice(),
        reviewer: reviewer as string,
        blind: blind as boolean,
        ...parseReviewFields(rec),
      });
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`labels.json is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return labels;
}

export interface LabelledFinding {
  readonly finding: Finding;
  readonly label: Label;
}

export interface LabelMatch {
  readonly labelled: readonly LabelledFinding[];
  /** Default components and explicit overrides for every finding, including unlabelled. */
  readonly clusters: ReadonlyMap<string, string>;
  /** Findings with no label. These must be reviewed before they count. */
  readonly unlabelled: readonly Finding[];
  /** Label ids that match no current finding. Empty when staleness was not checked. */
  readonly stale: readonly string[];
  /** False when the run was partial or incomplete, so absent findings prove nothing. */
  readonly staleChecked: boolean;
}

/**
 * Joins findings to labels. `checkStale` must be false whenever the set of
 * findings is not the whole corpus (a filtered run, or a repository that could
 * not be analysed): a label for a finding the run never had a chance to
 * produce is not stale.
 *
 * Throws `ConfigError` when the members of one cluster disagree on a verdict:
 * a cluster is one defect, so it has one verdict.
 */
export function matchLabels(
  findings: readonly Finding[],
  labels: ReadonlyMap<string, Label>,
  checkStale: boolean,
  sealedRepos: ReadonlySet<string> = new Set(),
): LabelMatch {
  const labelled: LabelledFinding[] = [];
  const unlabelled: Finding[] = [];
  const present = new Set<string>();
  for (const finding of findings) {
    present.add(finding.id);
    const label = labels.get(finding.id);
    if (label === undefined) unlabelled.push(finding);
    else labelled.push({ finding, label });
  }

  const clusters = findingClusters(findings, labels);
  const verdictOfCluster = new Map<string, Verdict>();
  const mixed = new Set<string>();
  const problems: string[] = [];
  const sealedMixed = new Map<string, Set<string>>();
  for (const { finding, label } of labelled) {
    const key = `${finding.repo}/${finding.code}/${clusters.get(finding.id)!}`;
    const seen = verdictOfCluster.get(key);
    if (seen === undefined) verdictOfCluster.set(key, label.verdict);
    else if (seen !== label.verdict && !mixed.has(key)) {
      mixed.add(key);
      if (sealedRepos.has(finding.repo)) {
        // A cluster name is free text from someone who read the finding, and an id names it:
        // neither may reach failure output for a sealed repository.
        const set = sealedMixed.get(finding.repo) ?? new Set<string>();
        set.add(key);
        sealedMixed.set(finding.repo, set);
      } else {
        problems.push(
          `cluster ${key} mixes verdicts "${seen}" and "${label.verdict}" (see ${finding.id}).`,
        );
      }
    }
  }
  for (const [repo, keys] of [...sealedMixed.entries()].sort()) {
    problems.push(
      `${keys.size} cluster(s) in the sealed repository ${repo} mix verdicts (names withheld).`,
    );
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `labels.json is inconsistent: a cluster is one defect and has one verdict.\n  - ${problems.join('\n  - ')}`,
    );
  }

  const stale = checkStale ? [...labels.keys()].filter((id) => !present.has(id)).sort() : [];
  return { labelled, unlabelled, clusters, stale, staleChecked: checkStale };
}
