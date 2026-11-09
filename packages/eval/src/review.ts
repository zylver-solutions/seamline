/** Declared review evidence. This checks records, never authenticates an account or authorship. */
import { ConfigError } from './errors.ts';
import type { LabelMatch } from './labels.ts';
import type { Finding, Label, Partition, ReviewerIdentity, SourceReview, Verdict } from './types.ts';

export interface ReviewMetadata {
  readonly codeId: string;
  readonly authors: readonly ReviewerIdentity[];
}

const accountOf = (identity: ReviewerIdentity): string => identity.account.trim().toLowerCase();
const identityKey = (identity: ReviewerIdentity): string =>
  JSON.stringify([identity.kind, accountOf(identity), identity.kind === 'agent' ? identity.model : null]);

function object(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('review evidence must contain JSON objects.');
  }
  return raw as Record<string, unknown>;
}

function keys(rec: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(rec).some((key) => !allowed.includes(key))) {
    // Never echo untrusted keys, reviewer text, citations, or sealed subjects.
    throw new ConfigError('review evidence contains an unrecognised field.');
  }
}

export function parseIdentity(raw: unknown): ReviewerIdentity {
  const rec = object(raw);
  keys(rec, ['kind', 'account', 'model']);
  if (typeof rec['account'] !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._@/-]{0,127}$/i.test(rec['account'].trim())) {
    throw new ConfigError('review identity needs a canonical provider/account identifier.');
  }
  const account = rec['account'].trim().toLowerCase();
  if (rec['kind'] === 'human' && rec['model'] === undefined) return { kind: 'human', account };
  if (rec['kind'] === 'agent' && typeof rec['model'] === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(rec['model'])) {
    return { kind: 'agent', account, model: rec['model'] };
  }
  throw new ConfigError('review identity must name a human account or an agent account and model.');
}

export function parseReviewMetadata(raw: unknown): ReviewMetadata | null {
  if (raw === undefined) return null;
  const rec = object(raw);
  keys(rec, ['codeId', 'authors']);
  if (typeof rec['codeId'] !== 'string' || !/^[0-9a-f]{64}$/.test(rec['codeId'])) {
    throw new ConfigError('review metadata needs the measured 64-character product codeId.');
  }
  if (!Array.isArray(rec['authors']) || rec['authors'].length === 0) {
    throw new ConfigError('review metadata needs the complete, nonempty change-author roster.');
  }
  return { codeId: rec['codeId'], authors: rec['authors'].map(parseIdentity) };
}

function parseSourceReview(raw: unknown): SourceReview {
  const rec = object(raw);
  keys(rec, ['identity', 'verdict', 'rationale', 'evidence', 'blind']);
  if (!['tp', 'fp', 'unclear'].includes(String(rec['verdict'])) || typeof rec['verdict'] !== 'string' ||
      typeof rec['rationale'] !== 'string' || rec['rationale'].trim() === '' ||
      typeof rec['blind'] !== 'boolean' || !Array.isArray(rec['evidence']) || rec['evidence'].length === 0 ||
      rec['evidence'].some((e) => typeof e !== 'string' || !/^[^\s:][^:]*:\d+(?:-\d+)?$/.test(e))) {
    throw new ConfigError('each source review needs a verdict, rationale, path:line evidence and blind state.');
  }
  return {
    identity: parseIdentity(rec['identity']), verdict: rec['verdict'] as Verdict,
    rationale: rec['rationale'], evidence: (rec['evidence'] as string[]).slice(), blind: rec['blind'],
  };
}

export function parseReviewFields(rec: Record<string, unknown>): Pick<Label, 'identity' | 'reviews'> {
  const identity = rec['identity'] === undefined ? undefined : parseIdentity(rec['identity']);
  if (rec['reviews'] !== undefined && !Array.isArray(rec['reviews'])) {
    throw new ConfigError('secondary source reviews must be an array.');
  }
  const reviews = rec['reviews'] === undefined ? undefined : (rec['reviews'] as unknown[]).map(parseSourceReview);
  const identities = new Set<string>();
  for (const who of [...(identity === undefined ? [] : [identity]), ...(reviews ?? []).map((review) => review.identity)]) {
    const key = identityKey(who);
    if (identities.has(key)) throw new ConfigError('a finding can record only one current verdict per reviewer identity.');
    identities.add(key);
  }
  return { ...(identity === undefined ? {} : { identity }), ...(reviews === undefined ? {} : { reviews }) };
}

export interface ReviewCounts {
  readonly findings: number;
  readonly labelledFindings: number;
  readonly independentPrimaryFindings: number;
  readonly missingPrimaryFindings: number;
  readonly clusters: number;
  readonly doubleReviewedClusters: number;
  readonly reviewPairs: number;
  readonly agreeingPairs: number;
  readonly agreement: number | null;
}

export interface ReviewAudit {
  readonly metadata: 'missing' | 'stale' | 'bound';
  readonly declaredAuthorAccounts: number;
  readonly overall: ReviewCounts & { readonly requiredDoubleReviewedClusters: number; readonly ready: boolean };
  readonly dev: ReviewCounts;
  readonly sealed: ReviewCounts;
}

export function auditReviews(
  metadata: ReviewMetadata | null,
  codeId: string,
  findings: readonly Finding[],
  match: LabelMatch,
  partitions: ReadonlyMap<string, Partition>,
): ReviewAudit {
  const state = metadata === null ? 'missing' : metadata.codeId === codeId && metadata.authors.length > 0 ? 'bound' : 'stale';
  const authors = new Set(metadata?.authors.map(accountOf) ?? []);
  const labels = new Map(match.labelled.map((row) => [row.finding.id, row.label]));
  const eligible = (identity: ReviewerIdentity | undefined): identity is ReviewerIdentity =>
    state === 'bound' && identity !== undefined && !authors.has(accountOf(identity));

  const audit = (partition: Partition | undefined): ReviewCounts => {
    const mine = partition === undefined ? findings : findings.filter((finding) => partitions.get(finding.repo) === partition);
    const groups = new Map<string, Finding[]>();
    let labelled = 0;
    let primary = 0;
    for (const finding of mine) {
      const cluster = match.clusters.get(finding.id);
      if (cluster === undefined) throw new ConfigError('review audit requires a cluster for every finding.');
      const key = JSON.stringify([finding.repo, finding.code, cluster]);
      const members = groups.get(key) ?? [];
      members.push(finding);
      groups.set(key, members);
      const label = labels.get(finding.id);
      if (label !== undefined) {
        labelled += 1;
        if (eligible(label.identity) && label.reviewer.trim().toLowerCase() === accountOf(label.identity)) primary += 1;
      }
    }
    let double = 0;
    let pairs = 0;
    let agree = 0;
    for (const members of groups.values()) {
      const accounts = new Map<string, string>();
      const byFinding = members.map((finding) => {
        const label = labels.get(finding.id);
        const votes = new Map<string, Set<Verdict>>();
        if (label === undefined || !eligible(label.identity) || label.reviewer.trim().toLowerCase() !== accountOf(label.identity)) return new Map<string, Verdict>();
        const add = (identity: ReviewerIdentity, verdict: Verdict): void => {
          const key = identityKey(identity);
          accounts.set(key, accountOf(identity));
          const seen = votes.get(key) ?? new Set<Verdict>();
          seen.add(verdict);
          votes.set(key, seen);
        };
        add(label.identity, label.verdict);
        for (const review of label.reviews ?? []) if (eligible(review.identity)) add(review.identity, review.verdict);
        // A single reviewer must cover the whole cluster. Different models on
        // one account cannot be spliced into one complete reviewer identity.
        return new Map([...votes].filter(([, values]) => values.size === 1).map(([account, values]) => [account, [...values][0]!]));
      });
      const common = [...(byFinding[0]?.keys() ?? [])].filter((account) => byFinding.every((votes) => votes.has(account))).sort();
      if (new Set(common.map((key) => accounts.get(key))).size < 2) continue;
      double += 1;
      // Include every complete reviewer pair with distinct accounts, not a
      // chosen agreeing pair. Two models sharing an account never form a pair.
      for (let a = 0; a < common.length; a += 1) for (let b = a + 1; b < common.length; b += 1) {
        if (accounts.get(common[a]!) === accounts.get(common[b]!)) continue;
        pairs += 1;
        if (byFinding.every((votes) => votes.get(common[a]!) === votes.get(common[b]!))) agree += 1;
      }
    }
    return {
      findings: mine.length, labelledFindings: labelled, independentPrimaryFindings: primary,
      missingPrimaryFindings: mine.length - primary, clusters: groups.size, doubleReviewedClusters: double,
      reviewPairs: pairs, agreeingPairs: agree,
      agreement: pairs === 0 ? null : agree / pairs,
    };
  };
  const overall = audit(undefined);
  const required = Math.max(10, Math.ceil(overall.clusters / 5));
  return { metadata: state, declaredAuthorAccounts: authors.size,
    overall: { ...overall, requiredDoubleReviewedClusters: required,
      ready: state === 'bound' && overall.findings > 0 && overall.missingPrimaryFindings === 0 && overall.doubleReviewedClusters >= required },
    dev: audit('dev'), sealed: audit('sealed') };
}
