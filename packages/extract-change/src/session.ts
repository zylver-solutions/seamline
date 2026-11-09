/**
 * Option resolution and the honest-status gate.
 *
 * Everything that can make this extractor unable to answer is decided here,
 * once, and both `extractChange` and `readRenames` go through it. The rule the
 * whole file exists to enforce (v3 §2.2): **UNAVAILABLE is never PASS.** A
 * `PASS` with zero nodes is downstream-indistinguishable from "this project has
 * no history", and that is how an infrastructure problem becomes a false
 * finding about someone's code.
 */
import type { ExtractorStatus } from '@seamline/ontology';
import type { GitInvocation } from './git.ts';
import { DEFAULT_MAX_BUFFER_BYTES, gitUnusable, isShallow, isSafeRev, isWorkTree, resolveCommit, runGit } from './git.ts';
import { describeRange, readHistory } from './history.ts';
import type { RangeRequest } from './history.ts';
import type { ChangeExtractorOptions, CommitRecord, RangeDescriptor, SymbolResolver } from './types.ts';
import { DEFAULT_DEPTH, DEFAULT_RENAME_THRESHOLD } from './types.ts';

export interface ResolvedOptions {
  readonly inv: GitInvocation;
  readonly repo: string;
  readonly runId: string;
  readonly req: RangeRequest;
  readonly resolveSymbols: SymbolResolver | null;
}

export interface PreparedHistory {
  readonly cfg: ResolvedOptions;
  readonly commits: ReadonlyArray<CommitRecord>;
  readonly range: RangeDescriptor;
  readonly diagnostics: ReadonlyArray<string>;
}

export type PrepareOutcome =
  | { readonly ok: true; readonly prepared: PreparedHistory }
  | {
      readonly ok: false;
      readonly status: Exclude<ExtractorStatus, 'PASS'>;
      readonly range: RangeDescriptor;
      readonly threshold: number;
      readonly diagnostics: ReadonlyArray<string>;
    };

function isPositiveInt(n: number, max: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= max;
}

/** Validation failures are FAIL, not UNAVAILABLE: the caller asked a malformed question. */
function optionError(o: ChangeExtractorOptions): string | null {
  if (typeof o.repoRoot !== 'string' || o.repoRoot.length === 0) return 'repoRoot must be a non-empty path';
  if (typeof o.repo !== 'string' || o.repo.length === 0) return 'repo must be a non-empty name';
  if (o.repo.includes(':')) return "repo must not contain ':'";
  if (typeof o.runId !== 'string' || o.runId.length === 0) return 'runId must be a non-empty string';
  if (o.depth !== undefined && !isPositiveInt(o.depth, 1_000_000)) return 'depth must be an integer in 1..1000000';
  if (o.renameThreshold !== undefined
      && !(Number.isFinite(o.renameThreshold) && o.renameThreshold > 0 && o.renameThreshold <= 1)) {
    return 'renameThreshold must be a ratio in (0, 1]';
  }
  if (o.since !== undefined && !isSafeRev(o.since)) return 'since is not a safe rev name';
  if (o.until !== undefined && !isSafeRev(o.until)) return 'until is not a safe rev name';
  if (o.gitBin !== undefined && (typeof o.gitBin !== 'string' || o.gitBin.length === 0)) {
    return 'gitBin must be a non-empty string';
  }
  return null;
}

function requestOf(o: ChangeExtractorOptions): RangeRequest {
  return {
    since: o.since ?? null,
    until: o.until ?? 'HEAD',
    maxCount: o.depth ?? DEFAULT_DEPTH,
    renameThreshold: o.renameThreshold ?? DEFAULT_RENAME_THRESHOLD,
    detectCopies: o.detectCopies ?? true,
  };
}

/**
 * Parent shas from the raw commit object.
 *
 * This deliberately does not use the parents git reports during a walk: inside
 * a shallow clone the graft makes the boundary commit look parentless, which is
 * indistinguishable from a real root commit. The stored object still carries
 * its real `parent` headers, so reading them is what tells the two apart. Only
 * header lines before the first blank line are parsed, so commit message text
 * can never be mistaken for a header.
 */
function rawParents(inv: GitInvocation, sha: string): ReadonlyArray<string> | null {
  const out = runGit(inv, ['cat-file', 'commit', sha]);
  if (!out.ok) return null;
  const parents: string[] = [];
  for (const line of out.stdout.split('\n')) {
    if (line.length === 0) break;
    const match = /^parent ([0-9a-f]{40})$/.exec(line);
    if (match?.[1] !== undefined) parents.push(match[1]);
  }
  return parents;
}

/**
 * True when the oldest commit read sits on a shallow graft boundary: its stored
 * object claims parents that are not in the object store. Checked only when the
 * walk returned fewer commits than asked for, because a walk that filled its
 * bound answered the question that was actually put to it.
 */
function stopsOnGraft(inv: GitInvocation, commits: ReadonlyArray<CommitRecord>): boolean {
  const oldest = commits[commits.length - 1];
  if (oldest === undefined) return true;
  const parents = rawParents(inv, oldest.sha);
  // Git could not read the commit it just listed: the boundary cannot be ruled out.
  if (parents === null) return true;
  for (const parent of parents) {
    if (!runGit(inv, ['cat-file', '-e', `${parent}^{commit}`]).ok) return true;
  }
  return false;
}

export function prepareHistory(o: ChangeExtractorOptions): PrepareOutcome {
  const req = requestOf(o);
  const emptyRange = describeRange(req, 0);
  const fail = (status: Exclude<ExtractorStatus, 'PASS'>, ...diagnostics: string[]): PrepareOutcome => ({
    ok: false, status, range: emptyRange, threshold: req.renameThreshold, diagnostics,
  });

  const invalid = optionError(o);
  if (invalid !== null) return fail('FAIL', `invalid option: ${invalid}`);

  const inv: GitInvocation = {
    gitBin: o.gitBin ?? 'git',
    cwd: o.repoRoot,
    maxBufferBytes: o.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
  };

  const unusable = gitUnusable(inv);
  if (unusable !== null) return fail('UNAVAILABLE', unusable);
  if (!isWorkTree(inv)) return fail('UNAVAILABLE', `not a git work tree: ${o.repoRoot}`);
  if (resolveCommit(inv, req.until) === null) {
    return fail('UNAVAILABLE', `rev '${req.until}' does not resolve to a commit (unborn branch or empty repository)`);
  }
  if (req.since !== null && resolveCommit(inv, req.since) === null) {
    return fail('UNAVAILABLE', `rev '${req.since}' does not resolve to a commit`);
  }

  const history = readHistory(inv, req);
  if (!history.ok) return fail('FAIL', history.reason);

  const commits = history.commits;
  const range = describeRange(req, commits.length);
  if (commits.length === 0) {
    return fail('UNAVAILABLE', `bounded range ${range.spec} selected no commits`);
  }

  const diagnostics: string[] = [
    `range ${range.spec}`,
    `commits ${range.commitCount} truncated=${range.truncated}`,
    `renameThreshold ${req.renameThreshold}`,
    `copyDetection ${req.detectCopies}`,
  ];

  const shallow = isShallow(inv);
  if (shallow === null) return fail('FAIL', 'git could not say whether this clone is shallow; the history cannot be trusted');
  if (shallow) {
    if (commits.length < req.maxCount && stopsOnGraft(inv, commits)) {
      return {
        ok: false,
        status: 'UNAVAILABLE',
        range,
        threshold: req.renameThreshold,
        diagnostics: [...diagnostics, 'shallow clone: the walk stops on a graft boundary, history cannot be answered'],
      };
    }
    diagnostics.push('shallow clone: requested range is fully present');
  }

  return {
    ok: true,
    prepared: {
      cfg: {
        inv,
        repo: o.repo,
        runId: o.runId,
        req,
        resolveSymbols: o.resolveSymbols ?? null,
      },
      commits,
      range,
      diagnostics,
    },
  };
}
