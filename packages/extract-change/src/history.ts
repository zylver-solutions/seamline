/**
 * Reads a bounded commit range out of git and parses it into `CommitRecord`s.
 *
 * Two `git log` invocations, never more, regardless of how many commits are in
 * the range:
 *
 *  A. metadata, `-z` so records are NUL-terminated. NUL cannot appear in the
 *     fields git emits here, so the record framing survives any commit text.
 *  B. `--name-status -z`, whose output contains no free text at all (only
 *     status letters and paths), framed by a `%x1e` record sentinel.
 *
 * The split matters for safety, not speed: a commit subject that contains the
 * record sentinel byte cannot corrupt the framing of run B, because run B never
 * prints a subject. Run A frames on NUL, which commit text cannot contain.
 */
import type { GitInvocation } from './git.ts';
import { runGit } from './git.ts';
import type { ChangeStatus, CommitRecord, FileChange, RangeDescriptor } from './types.ts';

const UNIT = '\x1f';
const RECORD = '\x1e';

const META_FORMAT = [
  '%H', '%P', '%at', '%ct', '%an', '%ae', '%cn', '%ce', '%s',
].join(UNIT);

/** Fixed fields before the free-text subject. */
const META_FIXED_FIELDS = 8;

export type HistoryOutcome =
  | { readonly ok: true; readonly commits: ReadonlyArray<CommitRecord> }
  | { readonly ok: false; readonly reason: string };

export interface RangeRequest {
  readonly since: string | null;
  readonly until: string;
  readonly maxCount: number;
  /** Ratio in `(0, 1]`. Quantised to whole percent for git's CLI flags. */
  readonly renameThreshold: number;
  readonly detectCopies: boolean;
}

/** Second-resolution ISO-8601 in UTC. Fixed width, no locale, no wall clock. */
export function epochToIsoUtc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
}

export function describeRange(req: RangeRequest, commitCount: number): RangeDescriptor {
  const spec = req.since === null
    ? `${req.until} max=${req.maxCount}`
    : `${req.since}..${req.until} max=${req.maxCount}`;
  return {
    since: req.since,
    until: req.until,
    maxCount: req.maxCount,
    commitCount,
    truncated: commitCount >= req.maxCount,
    spec,
  };
}

function revSpec(req: RangeRequest): string {
  return req.since === null ? req.until : `${req.since}..${req.until}`;
}

function commonArgs(req: RangeRequest): ReadonlyArray<string> {
  return [
    'log',
    '--no-color',
    '--no-show-signature',
    '--no-ext-diff',
    '--no-textconv',
    `--max-count=${req.maxCount}`,
    '-z',
  ];
}

/**
 * Git's `--find-renames` takes whole percent, so a ratio is quantised for it.
 * Rounding down only ever widens the candidate set, and `renames.ts` re-filters
 * against the exact ratio afterwards, so a 0.605 floor never admits a 0.60 pair.
 */
function gitPercent(ratio: number): number {
  return Math.max(1, Math.min(100, Math.floor(ratio * 100)));
}

function parseStatus(token: string): { status: ChangeStatus; similarity: number | null } {
  const head = token.charAt(0);
  if (head === 'R' || head === 'C') {
    // Git reports whole percent; this package, and the identity layer it feeds,
    // speak ratios. The conversion happens once, here.
    const score = Number.parseInt(token.slice(1), 10);
    return { status: head, similarity: Number.isFinite(score) ? score / 100 : null };
  }
  switch (head) {
    case 'A': case 'M': case 'D': case 'T': case 'U':
      return { status: head, similarity: null };
    default:
      // Includes 'B' (pairing broken) and anything a future git adds.
      return { status: 'X', similarity: null };
  }
}

/** Parses run B into sha -> changes. Paths arrive unquoted because of `-z`. */
function parseNameStatus(stdout: string): Map<string, FileChange[]> {
  const byCommit = new Map<string, FileChange[]>();
  for (const chunk of stdout.split(RECORD)) {
    if (chunk.length === 0) continue;
    const nul = chunk.indexOf('\0');
    if (nul < 0) continue;
    const sha = chunk.slice(0, nul);
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    const changes: FileChange[] = [];
    const tokens = chunk.slice(nul + 1).replace(/^\n+/, '').split('\0').filter((t) => t.length > 0);
    for (let i = 0; i < tokens.length; i += 1) {
      const raw = tokens[i];
      if (raw === undefined) continue;
      const { status, similarity } = parseStatus(raw);
      if (status === 'R' || status === 'C') {
        const from = tokens[i + 1];
        const to = tokens[i + 2];
        i += 2;
        if (from === undefined || to === undefined) continue;
        changes.push({ status, path: to, fromPath: from, similarity });
      } else {
        const path = tokens[i + 1];
        i += 1;
        if (path === undefined) continue;
        changes.push({ status, path, fromPath: null, similarity });
      }
    }
    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    byCommit.set(sha, changes);
  }
  return byCommit;
}

export function readHistory(inv: GitInvocation, req: RangeRequest): HistoryOutcome {
  const rev = revSpec(req);

  const meta = runGit(inv, [...commonArgs(req), `--format=${META_FORMAT}`, rev, '--']);
  if (!meta.ok) {
    return { ok: false, reason: meta.spawnError ?? `git log (metadata) exited ${meta.code ?? -1}` };
  }

  const diffArgs = [
    ...commonArgs(req),
    '--format=' + RECORD + '%H',
    '--name-status',
    `--find-renames=${gitPercent(req.renameThreshold)}%`,
  ];
  if (req.detectCopies) diffArgs.push(`--find-copies=${gitPercent(req.renameThreshold)}%`);
  diffArgs.push(rev, '--');

  const diff = runGit(inv, diffArgs);
  if (!diff.ok) {
    return { ok: false, reason: diff.spawnError ?? `git log (name-status) exited ${diff.code ?? -1}` };
  }

  const changesBySha = parseNameStatus(diff.stdout);
  const commits: CommitRecord[] = [];
  const records = meta.stdout.split('\0').filter((r) => r.length > 0);

  for (let order = 0; order < records.length; order += 1) {
    const record = records[order];
    if (record === undefined) continue;
    const parts = record.split(UNIT);
    if (parts.length < META_FIXED_FIELDS + 1) {
      return { ok: false, reason: `malformed git log record at position ${order}` };
    }
    const sha = parts[0] ?? '';
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return { ok: false, reason: `malformed commit id at position ${order}` };
    }
    const authorEpoch = Number.parseInt(parts[2] ?? '', 10);
    const committerEpoch = Number.parseInt(parts[3] ?? '', 10);
    if (!Number.isFinite(authorEpoch) || !Number.isFinite(committerEpoch)) {
      return { ok: false, reason: `malformed commit timestamp at position ${order}` };
    }
    commits.push({
      sha,
      parents: (parts[1] ?? '').split(' ').filter((p) => p.length > 0),
      authorDate: epochToIsoUtc(authorEpoch),
      committerDate: epochToIsoUtc(committerEpoch),
      authorName: parts[4] ?? '',
      authorEmail: parts[5] ?? '',
      committerName: parts[6] ?? '',
      committerEmail: parts[7] ?? '',
      // Anything after the fixed fields is subject text; rejoin so a separator
      // byte inside the subject cannot silently truncate it.
      subject: parts.slice(META_FIXED_FIELDS).join(UNIT),
      changes: changesBySha.get(sha) ?? [],
      order,
    });
  }

  return { ok: true, commits };
}
