/**
 * Ports — the injection seam for the `seamline` CLI.
 *
 * The CLI owns presentation, argument parsing, exit codes, and policy
 * (default-deny export, UNKNOWN-is-not-clean). It owns no storage, no
 * extraction, and no detection. Everything it cannot do itself arrives as an
 * implementation of one of the interfaces below, so both surfaces are testable
 * with fakes and integration is pure wiring.
 *
 * Every type here is expressed in terms of `@seamline/ontology`'s contract.
 * Nothing here widens or reinterprets that contract.
 *
 * `@seamline/mcp` declares a structurally identical `GraphSource` seam. Because
 * TypeScript is structural, one concrete implementation satisfies both; the
 * duplication exists only so neither package depends on the other.
 */

import type {
  AuthoritativeScope,
  Contradiction,
  ContradictionCode,
  ExtractorResult,
  ExtractorStatus,
  GraphStore,
  GraphView,
  Provenance,
  RunRecord,
  SeamlineEdge,
  SeamlineNode,
  Severity,
} from '@seamline/ontology';
import type { TaggedAmbiguity } from '@seamline/infer-join';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface OpenStoreOptions {
  /** Absolute path to the repository root being analysed. */
  readonly repoRoot: string;
  /** Absolute path to the output directory (`seamline-out/` by default). */
  readonly outDir: string;
  /** Logical repo name; the first segment of every `NodeId`. */
  readonly repo: string;
  /** Create the store if it does not exist. `false` for read-only commands. */
  readonly create: boolean;
  /** Extraction clock for persisted run completion, including deterministic runs. */
  readonly now?: () => string;
}

/**
 * Run metadata lookup.
 *
 * `GraphStore` in the contract writes runs but exposes no way to read them
 * back; every user-facing surface needs that (to report per-extractor status,
 * to name a snapshot, to diff two runs). Implementations back this with the
 * same table `finalizeRun` writes.
 */
export interface RunHistory {
  latest(): Promise<RunRecord | undefined>;
  list(limit: number): Promise<readonly RunRecord[]>;
  get(runId: string): Promise<RunRecord | undefined>;
}

export interface Workspace {
  readonly store: GraphStore;
  readonly runs: RunHistory;
  /**
   * Re-open a run that already exists, so the same run id can be executed again.
   *
   * `store.beginRun` refuses an id that is on record. In deterministic mode an id
   * is derived from the run's inputs (`run-id.ts`), so running the same inputs
   * again, retrying a run that was cut short, or returning to an earlier tree
   * reaches `beginRun` with an id the store already holds. `extract` calls this
   * instead: the run is re-opened as the newest run, its previous results are
   * dropped, the facts it writes re-stamp what it sees, and what it does not
   * re-observe inside a PASS scope is buried as for any run, whatever the earlier
   * attempt stored under the same id. Absent on a store that
   * cannot do this, in which case a repeated id is refused as before.
   */
  readonly restartRun?: (run: Omit<RunRecord, 'finishedAt' | 'results'>) => Promise<void>;
}

/** Opens a graph store over a repository. Wired to `@seamline/core`. */
export interface StorePort {
  open(opts: OpenStoreOptions): Promise<Workspace>;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractContext {
  readonly repoRoot: string;
  readonly repo: string;
  readonly runId: string;
  /** Absolute path to the output directory. Needed by `infer-join`'s adapter to open a second, read-only view of the graph the earlier extractors in this run already committed. */
  readonly outDir: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Extractor-specific options, verbatim from the config file. */
  readonly options: Readonly<Record<string, unknown>>;
  /** True when `SEAMLINE_DETERMINISTIC=1`; freezes clocks and emission order. */
  readonly deterministic: boolean;
  /**
   * The data-model index (canonical JSON text) of this run, when an extractor
   * that publishes one reached PASS before this one started, or reported that
   * discovery found no schema source it reads or recognises (an index with no
   * tables, which is then true of what it looked at). Plain text on purpose: it
   * is an input of the run, it crosses a process boundary unchanged, and "the
   * same index in" is a statement about bytes. Absent has three causes: no such
   * extractor ran (`--only`); one ran and did not see the schema (it knew of a
   * source it did not read, failed or crashed, in any entry the config lists,
   * even if another entry reached the empty index); or it read sources that
   * declared no tables (UNAVAILABLE without the flag below). A consumer must
   * treat an absent index as missing, never as empty.
   */
  readonly dataModelIndex?: string;
  /**
   * The graph the earlier extractors of this run have already produced, with
   * this run's own statuses applied. Set by `extractCommand`. Only an extractor
   * that infers over other extractors' facts (`infer-join`) reads it; the rest
   * ignore it. It holds functions, so it never crosses a process boundary: a
   * sandboxed extractor is handed a snapshot of it instead.
   */
  readonly view?: GraphView;
}

/** Edges grouped by the authoritative scope they belong to (v3 §2.2). */
export interface ScopedEdges {
  readonly scope: string;
  readonly edges: readonly SeamlineEdge[];
}

export interface ExtractorOutput {
  readonly result: ExtractorResult;
  readonly nodes: readonly SeamlineNode[];
  readonly edges: readonly ScopedEdges[];
  /**
   * The data-model index this extractor publishes for the extractors after it
   * (only `extract-data` does). The command passes it on in
   * `ExtractContext.dataModelIndex` when the result is PASS, or when the result
   * is UNAVAILABLE and `noSchemaSource` is true and no publisher in the run
   * could not look; never otherwise.
   */
  readonly dataModelIndex?: string;
  /**
   * Set by an extractor that publishes a data-model index, on an UNAVAILABLE
   * result, to say that its discovery found no schema source it reads or
   * recognises: it completed, found nothing, and knew of nothing it did not
   * read. The index it publishes has no tables, which is true of what it looked
   * at and is a statement about discovery, not about the repository (a schema
   * in a form it neither reads nor recognises leaves the flag set). It is a
   * structured flag, not a diagnostic, and it is not set for a source that was
   * not read or a discovery that failed.
   */
  readonly noSchemaSource?: true;
  /**
   * Joins the extractor declined to make and why (ties, dropped fanouts,
   * contended targets). Only `infer-join` reports any; `extractCommand` carries
   * them into the report because a dropped join emits no edge to look at.
   */
  readonly ambiguities?: readonly TaggedAmbiguity[];
}

/**
 * Where an extractor's code runs.
 *
 * - `process-sandbox`: in a child process under its capability manifest, with
 *   the environment, filesystem, network, time, memory and provenance controls
 *   of THREATMODEL.md C4 enforced (`sandbox/`). What a release build wires.
 * - `in-process`: in the CLI's own process, unconfined. Unit tests and
 *   embedders that bring their own isolation only.
 *
 * Absent means the port did not say, which is how test doubles read.
 */
export type Confinement = 'process-sandbox' | 'in-process';

/**
 * One extractor.
 *
 * An extractor that cannot run returns `status: 'UNAVAILABLE'` with a
 * diagnostic. It must not throw for a missing scope and must not report PASS
 * with partial output — the CLI renders UNAVAILABLE distinctly precisely so a
 * missing scope is visible rather than silently narrowing the graph.
 */
export interface ExtractorPort {
  readonly name: string;
  readonly version: string;
  readonly provenanceCeiling: Provenance;
  /**
   * The scopes this extractor is authoritative for (its manifest's `produces`).
   * `extractCommand` puts them on any result that did not PASS, however the
   * failure arrived (a throw, a crash, a result that named no scope), because
   * the store answers `scopeStatus` from the latest run that *declared* the
   * scope: a failure that declares nothing leaves the previous run's PASS
   * standing. Absent means the port did not say.
   */
  readonly produces?: ReadonlyArray<AuthoritativeScope>;
  /**
   * How this port runs its extractor: `process-sandbox` (a confined child, what `buildCliDeps`
   * wires for every bundled extractor) or `in-process` (unit tests and library callers). The
   * command never branches on it. It is the marker `cli-path.test.ts` reads to assert that
   * production wiring contains no in-process port, a check that would otherwise need a spawned
   * child per extractor to make, and a consumer building its own deps can read it to tell which
   * kind it was given.
   */
  readonly confinement?: Confinement;
  extract(ctx: ExtractContext): Promise<ExtractorOutput>;
  /**
   * Identity of what this extractor reads from outside the working tree, or
   * `null` when it reads nothing outside it. Deterministic mode derives the run
   * id from the run's inputs (`run-inputs.ts`), and the CLI hashes the tree; an
   * extractor that also reads something the tree does not contain, such as the
   * commit history, must say which version of it this run sees, or two runs that
   * differ only there would share a run id. Called only in deterministic mode,
   * before extraction. Must be a pure function of that outside state.
   */
  inputIdentity?(ctx: {
    readonly repoRoot: string;
    readonly options: Readonly<Record<string, unknown>>;
  }): string | null;
}

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

/**
 * A detector that could not run: one of its required scopes is not PASS (`scopes` names them, with
 * their status), or it stood down for a reason of its own read from facts the extractors recorded
 * (`unknownWhen`: `scopes` is empty and `reason` is its text). This is reported distinctly from
 * "clean" and never fails a build.
 */
export interface UnknownDetection {
  readonly code: ContradictionCode;
  readonly severity: Severity;
  readonly reason: string;
  readonly scopes: readonly string[];
  readonly scopeStatus: Readonly<Record<string, ExtractorStatus>>;
  /**
   * Set when every scope PASSed and the detector still cannot speak because
   * `code.ts` did not read this many workspace packages.
   */
  readonly unreadCodePackages?: number;
}

/**
 * What a detector that ran did not evaluate, in its own words (X5 names the tables it withheld).
 * A detector with nothing to say has no entry. A reader must not take "no findings" for "clean"
 * for an input named here.
 */
export interface DetectorNotes {
  readonly code: ContradictionCode;
  readonly notes: readonly string[];
}

export interface DetectionReport {
  readonly contradictions: readonly Contradiction[];
  readonly unknown: readonly UnknownDetection[];
  /** Absent from a port that predates notes; the catalog port always sets it. */
  readonly notes?: readonly DetectorNotes[];
}

/** Runs the contradiction catalog. Wired to `@seamline/contradictions`. */
export interface DetectorRunnerPort {
  run(view: GraphView, currentRun?: RunRecord): Promise<DetectionReport>;
}

// ---------------------------------------------------------------------------
// Snapshots (for `seamline diff`)
// ---------------------------------------------------------------------------

export interface Snapshot {
  readonly runId: string;
  /** Actual persisted metadata, required to write v2. Absent on legacy v1 reads. */
  readonly run?: RunRecord;
  readonly nodes: readonly SeamlineNode[];
  readonly edges: readonly SeamlineEdge[];
  /** Complete primary run results when available; legacy status records otherwise. */
  readonly results: readonly ExtractorResult[];
}

/**
 * Reads and writes canonical SIF snapshots.
 *
 * `outDir` is passed per call, not bound at construction, so one port
 * instance is reused across invocations that may target different `--repo`/
 * `--out` combinations (each CLI command resolves its own `outDir` from
 * config and flags, same as `StorePort.open`).
 *
 * `sif.ts` uses the core framed codec. Legacy snapshots without full run
 * metadata remain readable for diff, but cannot be silently upgraded on write.
 */
export interface SnapshotPort {
  read(outDir: string, ref: string): Promise<Snapshot>;
  write(outDir: string, ref: string, snapshot: Snapshot): Promise<void>;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * The working tree's own changed files, for `seamline blast-radius`'s default
 * (no `--ids`) mode: "what is the blast radius of the diff I have right now".
 *
 * Injected for the same reason every other port here is: the command needs to
 * stay testable with a fake, and the real implementation shells out to `git`
 * (v3 §2.7 — no git library dependency; see `extract-change`'s `git.ts` for the
 * established subprocess convention this follows).
 */
export interface GitPort {
  /** Repo-relative POSIX paths changed in the working tree: staged, unstaged, and untracked (not gitignored). Empty array outside a git repo or on a clean tree. */
  changedFiles(repoRoot: string): Promise<readonly string[]>;
}

// ---------------------------------------------------------------------------
// Alignment (a report family beside the contradiction pipeline, ADR-0014)
// ---------------------------------------------------------------------------

/** Where the alignment report may write. The CLI supplies both; `@seamline/align` writes through them at one site. */
export interface AlignSink {
  stdout(text: string): void;
  file(path: string, text: string): void;
}

/** Where the graph facts for an alignment report come from (alignment design 5.1). */
export type AlignFactsSource =
  | { readonly kind: 'sif'; readonly file: string }
  | { readonly kind: 'store'; readonly workspace: Workspace };

export interface AlignPortRequest {
  readonly repoRoot: string;
  readonly repo: string;
  /** A revision; `null` is `HEAD`. Ignored when `worktree`. */
  readonly at: string | null;
  readonly worktree: boolean;
  readonly facts: AlignFactsSource;
  /** The baseline packet's text, or `null`. */
  readonly baselineText: string | null;
  readonly config: { readonly docs?: readonly string[]; readonly exclude?: readonly string[] };
  /** `packet` is true only when an export profile allows `packets: ['alignment']`. */
  readonly output:
    | { readonly packet: false; readonly json: boolean }
    | { readonly packet: true; readonly file: string | null; readonly json: boolean };
  readonly toolVersion: string;
}

/**
 * Runs the alignment report: reads the documents and the implementation facts
 * of one commit, classifies each comparison, and writes the result through
 * `sink`. It never decides an exit code: drift does not gate. Wired to
 * `@seamline/align`.
 */
export interface AlignPort {
  run(request: AlignPortRequest, sink: AlignSink): Promise<void>;
}

// ---------------------------------------------------------------------------
// Ambient
// ---------------------------------------------------------------------------

/**
 * Time and identity. Injected because v3 §2.3 makes byte-reproducibility a
 * gate: under `SEAMLINE_DETERMINISTIC=1` both are frozen.
 */
export interface Clock {
  /** ISO-8601 instant, for the `Run` record only — never a node or edge body. */
  now(): string;
  /**
   * The id for the run being started.
   *
   * Normally fresh and unique. Under `SEAMLINE_DETERMINISTIC=1` it is instead
   * derived from the run's inputs (`run-id.ts`), so identical inputs give an
   * identical id and different inputs a different one. `inputsDigest` yields the
   * SHA-256 of those inputs as hex (`run-inputs.ts`); it is a function because
   * computing it reads the whole tree, which only the deterministic clock needs.
   */
  runId(inputsDigest: () => string): string;
}

/** Process I/O, injected so tests capture output without spawning. */
export interface Io {
  out(s: string): void;
  err(s: string): void;
  readonly isTty: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

/**
 * Everything the CLI needs from the outside world. Optional ports produce an
 * actionable "not wired" error at the point of use rather than a crash, so a
 * partially-integrated build still gives a usable `seamline --help`.
 */
export interface CliDeps {
  readonly io: Io;
  readonly clock: Clock;
  readonly store?: StorePort;
  readonly extractors?: readonly ExtractorPort[];
  readonly detectors?: DetectorRunnerPort;
  readonly snapshots?: SnapshotPort;
  readonly git?: GitPort;
  readonly align?: AlignPort;
  /**
   * The process's standard input, opened on demand. Only `seamline mcp` reads
   * it: the MCP client speaks to the server over stdin/stdout.
   */
  readonly input?: () => AsyncIterable<string | Uint8Array>;
}
