import type {
  ExtractorResult,
  ExtractorStatus,
  NodeId,
  SeamlineEdge,
  SeamlineNode,
} from '@seamline/ontology';

/**
 * Default similarity floor, as a ratio in `(0, 1]`.
 *
 * The unit is a ratio, not a percentage, so that it matches
 * `GitRenameRecord.similarity` in `packages/core/src/identity/rename.ts`. Git
 * speaks whole percent, and this package converts at the only two places it
 * has to: `--find-renames=<n>%` on the way out, `/ 100` on the way back in.
 */
export const DEFAULT_RENAME_THRESHOLD = 0.6;

/**
 * Why 0.6 and not git's default of 0.5.
 *
 * A rename record does not stay a diff detail: the identity layer turns it into
 * an alias, and an alias permanently welds two histories together. That is a
 * one-way door, so the floor sits above git's default. Source files share
 * licence headers, import blocks and framework boilerplate, and two unrelated
 * files in the same codebase routinely score in the 50s on that alone. A real
 * refactor (`git mv` with edits) lands at 0.8-1.0. 0.6 keeps the real ones and
 * drops the coincidences. It is a starting point backed by reasoning, not
 * measurement, which is exactly why it is configurable per run.
 */

/** Default commits walked when no explicit bound is given. */
export const DEFAULT_DEPTH = 500;

export const CHANGE_SCOPE = 'change';

/** git's `--name-status` letters, normalised. */
export const CHANGE_STATUSES = ['A', 'M', 'D', 'T', 'R', 'C', 'U', 'X'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

/** One path-level change inside one commit. Paths are repo-relative POSIX. */
export interface FileChange {
  readonly status: ChangeStatus;
  /** Post-image path. For a delete, the path that was removed. */
  readonly path: string;
  /** Pre-image path for `R`/`C` only. */
  readonly fromPath: string | null;
  /** Similarity ratio in `[0, 1]` for `R`/`C`, null otherwise. */
  readonly similarity: number | null;
}

/** One commit inside the bounded range, with its file changes. */
export interface CommitRecord {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  /** ISO-8601 UTC, second resolution, e.g. `2020-01-02T03:04:05Z`. */
  readonly authorDate: string;
  readonly committerDate: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
  /** First line of the commit message. Third-party text. */
  readonly subject: string;
  readonly changes: ReadonlyArray<FileChange>;
  /** Position in git's walk. 0 is newest; larger is older and topologically earlier. */
  readonly order: number;
}

/**
 * Exactly what was walked, so a consumer never has to guess whether "no rename
 * found" means "no rename exists" or "the bound stopped short of it".
 */
export interface RangeDescriptor {
  /** Exclusive lower bound ref as supplied, or null for "walk back from `until`". */
  readonly since: string | null;
  /** Upper bound ref as supplied. Defaults to `HEAD`. */
  readonly until: string;
  /** The `--max-count` actually passed to git. */
  readonly maxCount: number;
  /** Commits actually returned. */
  readonly commitCount: number;
  /** True when the walk stopped on `maxCount`, so older history was not read. */
  readonly truncated: boolean;
  /** Stable one-line rendering, e.g. `v1.0.0..HEAD max=500`. Goes in the ExtractorResult. */
  readonly spec: string;
}

/**
 * ── Interface to `@seamline/core` identity (packages/core/src/identity/) ──────
 *
 * A `RenameRecord` is one observation, not a conclusion. It says "in commit
 * `commit`, git matched `from` to `to` at `similarity` percent". Whether that
 * becomes an alias is the identity layer's decision, and it needs all four
 * fields to make it:
 *
 * - `from`/`to` are repo-relative POSIX paths, never absolute, never a
 *   backslash. They are the `File` natural keys on both sides, so
 *   `nodeId(repo, 'File', from)` is the pre-image node id; `fromId`/`toId` are
 *   supplied already built so the two packages cannot disagree on construction.
 * - `similarity` is a ratio in `[0, 1]`: the same unit and range as
 *   `GitRenameRecord.similarity` in `packages/core/src/identity/rename.ts`, so
 *   these records feed that module's alias ingest with no conversion at the
 *   call site. Git's own resolution is one whole percent, so the value is
 *   always a multiple of 0.01. It is reported for every record at or above the
 *   run's threshold; the threshold is on the ledger, so a consumer can re-filter
 *   upward but never downward, because records below it were never fetched.
 * - `commit` is where the rename was observed, which is what lets the identity
 *   layer place an alias in time rather than treating history as a flat set.
 * - `kind` separates a rename from a copy. **A copy is not an alias.** Both
 *   sides of a copy still exist; welding their identities together would merge
 *   two live files. Copies are reported so the identity layer can see them and
 *   deliberately not alias them, which is more useful than silently dropping
 *   them.
 */
export interface RenameRecord {
  readonly kind: 'rename' | 'copy';
  readonly from: string;
  readonly to: string;
  readonly similarity: number;
  readonly commit: string;
  /** ISO-8601 UTC. Data, not wall clock; safe to persist. */
  readonly authorDate: string;
  readonly fromId: NodeId;
  readonly toId: NodeId;
}

/**
 * The full rename answer for one bounded walk.
 *
 * `records` is sorted **oldest first, in git's topological walk order**, so an
 * alias table can be folded forward in a single pass: apply `a -> b` before
 * `b -> c` and the chain resolves without a second sort or a graph traversal.
 * Ties inside one commit break on (`from`, `to`) so the order is total.
 *
 * `complete` is the field that must not be ignored. When it is false the walk
 * hit its bound, so a path with no record here may still have had an earlier
 * name. The identity layer must treat that as unknown, not as "never renamed";
 * a negative conclusion drawn from a truncated walk is exactly the manufactured
 * false finding that `UNAVAILABLE is never PASS` exists to prevent (v3 §2.2).
 */
export interface RenameLedger {
  readonly repo: string;
  /**
   * `UNAVAILABLE` means the question could not be asked at all: no git, not a
   * repository, a shallow clone whose history stops short. `records` is then
   * empty and carries no information whatsoever. An empty `records` under
   * `PASS` is a real answer; under `UNAVAILABLE` it is not an answer.
   */
  readonly status: ExtractorStatus;
  readonly range: RangeDescriptor;
  /** Minimum similarity accepted on this run, as a ratio in `(0, 1]`. */
  readonly threshold: number;
  readonly complete: boolean;
  readonly records: ReadonlyArray<RenameRecord>;
  readonly diagnostics: ReadonlyArray<string>;
}

/**
 * Optional hook that turns a file change into canonical symbol names.
 *
 * This extractor cannot resolve symbols: canonical qualified names come from
 * `extract-code-ts`'s type-checker-backed resolution (v3 §6), and guessing them
 * here would emit `TOUCHES` edges pointing at ids no other extractor produces.
 * So symbol-level attribution is a caller-supplied function or it does not
 * happen. Returned names are used as-is for `nodeId(repo, 'Symbol', name)`.
 */
export type SymbolResolver = (change: {
  readonly commit: string;
  readonly path: string;
  readonly status: ChangeStatus;
}) => ReadonlyArray<string>;

export interface ChangeExtractorOptions {
  /** Absolute path to a git work tree. Never interpolated into a shell. */
  readonly repoRoot: string;
  /** Logical repo name used to build every NodeId. Must not contain `:`. */
  readonly repo: string;
  /** Run id stamped on every node and edge as firstSeenRun/lastSeenRun. */
  readonly runId: string;
  /** Commits to walk. Default `DEFAULT_DEPTH`. */
  readonly depth?: number;
  /** Exclusive lower bound ref. Default none. */
  readonly since?: string;
  /** Upper bound ref. Default `HEAD`. */
  readonly until?: string;
  /** Similarity floor as a ratio in `(0, 1]`. Default `DEFAULT_RENAME_THRESHOLD`. */
  readonly renameThreshold?: number;
  /** Ask git for copy detection as well as renames. Default true. */
  readonly detectCopies?: boolean;
  /** The bare name `git` (the default) or, under the sandbox, exactly the path its host found for it; any other path, even a link to the same program, is refused (FAIL `exec`). */
  readonly gitBin?: string;
  readonly maxBufferBytes?: number;
  readonly resolveSymbols?: SymbolResolver;
}

/**
 * The extractor's whole output. `result` carries the honest status; `nodes` and
 * `edges` are empty whenever `result.status` is not `PASS`.
 *
 * Determinism note: `nodes`, `edges` and `renames` are byte-identical across
 * two runs over the same commit range. `result.durationMs` is not, and is not
 * part of the graph; it is run telemetry, and `RunRecord` is where time lives
 * (v3 §2.3).
 */
export interface ChangeExtraction {
  readonly result: ExtractorResult;
  readonly nodes: ReadonlyArray<SeamlineNode>;
  readonly edges: ReadonlyArray<SeamlineEdge>;
  readonly renames: RenameLedger;
}
