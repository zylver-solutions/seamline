/**
 * The release wiring: real `@seamline/core`, `@seamline/contradictions`,
 * `@seamline/infer-join`, and extractor packages behind the ports `ports.ts`
 * declares.
 *
 * `bin.ts` is the only caller, and calls only `buildCliDeps`. The individual
 * factories below are exported too, because a test that wants a real store or
 * a real detector runner without the process-touching parts of `bin.ts`
 * should not have to reconstruct this module's wiring by hand.
 *
 * Nothing here reinterprets `@seamline/ontology`'s contract or any extractor's
 * own status/scope decisions: every adapter maps request/response shapes and
 * passes the extractor's own `ExtractorResult` through unchanged (v3 §2.2 —
 * UNAVAILABLE is never PASS, and this file does not get to decide otherwise).
 */

import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ExtractorManifest,
  ExtractorResult,
  ExtractorStatus,
  GraphView,
  RunRecord,
} from '@seamline/ontology';
import { SqliteStore, spawnUntrustedGit, wrapWithRedaction } from '@seamline/core';
import { runDetectors } from '@seamline/contradictions';
import type { SeamlineDetector } from '@seamline/contradictions';
import {
  INFER_JOIN_SCOPE,
  INFER_JOIN_VERSION,
  type InferJoinOptions,
  type TaggedAmbiguity,
} from '@seamline/infer-join';
import * as changeProgram from './extractors/change.ts';
import { fileRenameAliases, type FileRenameAliases } from './extractors/change.ts';
import * as codeTsProgram from './extractors/code-ts.ts';
import * as contractsProgram from './extractors/contracts.ts';
import * as dataProgram from './extractors/data.ts';
import * as inferJoinProgram from './extractors/infer-join.ts';
import { runInferJoin, type InferJoinRun } from './extractors/infer-join.ts';
import { stringOpt } from './extractors/options.ts';
import { alignPort } from './align-port.ts';
import { currentObservationOf } from './current-observation.ts';
import { CliError, EXIT_RUNTIME, EXIT_USAGE, systemClock } from './io.ts';
import { firstPartyHost, sandboxedExtractorPorts } from './sandbox/first-party.ts';
import { resolveOutsideRepo } from './sandbox/policy.ts';
import type { SandboxHostOptions } from './sandbox/host.ts';
import { fileSnapshots } from './sif.ts';
import type {
  CliDeps,
  DetectionReport,
  DetectorNotes,
  DetectorRunnerPort,
  ExtractorPort,
  GitPort,
  Io,
  OpenStoreOptions,
  RunHistory,
  StorePort,
  UnknownDetection,
  Workspace,
} from './ports.ts';

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** File the graph store lives in, inside a repo's configured `outDir`. */
const GRAPH_DB_FILENAME = 'graph.db';

function graphDbPath(outDir: string): string {
  return path.join(outDir, GRAPH_DB_FILENAME);
}

function runHistoryOf(store: SqliteStore): RunHistory {
  return {
    latest: async () => (await store.listRuns(1))[0],
    list: (limit) => store.listRuns(limit),
    get: (runId) => store.getRun(runId),
  };
}

/**
 * `StorePort` backed by `@seamline/core`'s `SqliteStore`, one file per `outDir`.
 *
 * This is the only production call site that constructs a `SqliteStore`
 * (ADR-0011). `Workspace.store` is `wrapWithRedaction(store)`, never `store`
 * itself, so every write any command makes -- `extractCommand`'s per-extractor
 * upserts included -- passes through the Redactor first. `runHistoryOf` keeps
 * the raw `store` reference because `RunHistory` needs `SqliteStore`-specific
 * read methods (`listRuns`/`getRun`) that carry no node/edge string fields and
 * so have no redaction obligation.
 */
export function sqliteStorePort(): StorePort {
  return {
    async open(opts: OpenStoreOptions): Promise<Workspace> {
      const file = graphDbPath(opts.outDir);
      if (opts.create) {
        await mkdir(opts.outDir, { recursive: true });
      } else {
        try {
          await access(file);
        } catch {
          throw new CliError(
            `no graph store found at ${file}`,
            EXIT_USAGE,
            'Run `seamline extract` first, or point --store at the directory that holds graph.db.',
          );
        }
      }
      const store = new SqliteStore({ path: file, ...(opts.now === undefined ? {} : { now: opts.now }) });
      return {
        store: wrapWithRedaction(store),
        runs: runHistoryOf(store),
        // Carries no node or edge fields, so like `runs` it needs no redaction.
        restartRun: (run) => store.restartRun(run),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * The four extractor packages as in-process `ExtractorPort`s.
 *
 * These run in the CLI's own process with its environment, its filesystem
 * reach and its network, which is exactly what C4 (THREATMODEL.md) says an
 * extractor must not have. They exist for unit tests and for embedders who
 * bring their own isolation. `buildCliDeps` does not use them: it wires
 * `sandboxedExtractorPorts` (`sandbox/first-party.ts`), which runs the same
 * `run` functions in a confined child process.
 */
function inProcessPort(program: {
  readonly NAME: string;
  readonly VERSION: string;
  readonly MANIFEST: ExtractorManifest;
  readonly run: ExtractorPort['extract'];
}): ExtractorPort {
  return withInputIdentity({
    name: program.NAME,
    version: program.VERSION,
    provenanceCeiling: program.MANIFEST.provenanceCeiling,
    produces: program.MANIFEST.produces,
    confinement: 'in-process',
    extract: program.run,
  });
}

export const codeTsExtractorPort = (): ExtractorPort => inProcessPort(codeTsProgram);
export const dataExtractorPort = (): ExtractorPort => inProcessPort(dataProgram);
export const contractsExtractorPort = (): ExtractorPort => inProcessPort(contractsProgram);
export const changeExtractorPort = (): ExtractorPort => inProcessPort(changeProgram);

export { fileRenameAliases, type FileRenameAliases };

/**
 * The commits `extract-change` walks between, resolved to hashes: the tip
 * (`until`, default `HEAD`) and the exclusive floor (`since`), if any. This is
 * the part of its input that the working tree does not contain, so a deterministic
 * run id (`run-inputs.ts`) has to include it: two checkouts with the same files
 * and different history extract different `Commit` nodes.
 */
function changeInputIdentity(repoRoot: string, options: Readonly<Record<string, unknown>>): string {
  // Found once, outside the repository. With no such git there is no history to name.
  const gitBin = resolveGit(repoRoot);
  const resolve = (ref: string): string => {
    // A ref that starts with `-` would be read by git as an option.
    if (ref.startsWith('-')) return 'invalid';
    if (gitBin === undefined) return 'unresolved';
    const out = runGit(gitBin, repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = out.stdout.trim();
    // git was refused or failed to run: not the same input as a ref that does not exist.
    if (out.exitCode === null) return 'unreadable';
    return out.ok && sha.length > 0 ? sha : 'unresolved';
  };
  const since = stringOpt(options, 'since');
  return `history:until=${resolve(stringOpt(options, 'until') ?? 'HEAD')}:since=${since === undefined ? 'none' : resolve(since)}`;
}

/**
 * Adds the input identity a deterministic run id needs (`ExtractorPort.inputIdentity`) to a
 * bundled port. The identity is computed here, in the CLI process, from what only the CLI can
 * see (git history), so it is attached the same way to the in-process port and to the sandboxed
 * one: a port that runs in a confined child still contributes it. Only `extract-change` has one.
 */
export function withInputIdentity(port: ExtractorPort): ExtractorPort {
  if (port.name !== changeProgram.NAME || port.inputIdentity !== undefined) return port;
  return {
    ...port,
    inputIdentity: ({ repoRoot, options }) => changeInputIdentity(repoRoot, options),
  };
}

/**
 * `infer-join` is an `ExtractorPort` like the others, with one difference: it
 * reads the graph the earlier extractors of the same run already produced,
 * which arrives as `ExtractContext.view`.
 *
 * That view cannot come from a second store connection opened mid-run.
 * `GraphView.scopeStatus()` is backed by the `authoritative_scopes` /
 * `extractor_results` tables, which `SqliteStore.finalizeRun` writes exactly
 * once, for the whole batch, after `extractCommand`'s loop has finished. A
 * second connection opened before that still sees every required scope as
 * UNAVAILABLE however many connections it opens, because the persisted status
 * does not exist yet (confirmed by running such an adapter against this
 * repository: `extract-code-ts` had already reported PASS with 5,585 nodes and
 * `infer-join` still reported UNAVAILABLE).
 *
 * So `extractCommand` passes the still-open `workspace.store`, decorated by
 * `scopeAwareView` below with the in-memory `ExtractorResult`s the loop has
 * already accumulated: the authoritative answer to "did this run's code, data
 * and contracts pass", even before `finalizeRun` persists it. Under the sandbox
 * the host copies that view into a snapshot for the child (`sandbox/snapshot.ts`).
 */
export const inferJoinExtractorPort = (): ExtractorPort => inProcessPort(inferJoinProgram);

export function scopeAwareView(
  store: GraphView,
  resultsSoFar: readonly ExtractorResult[],
): GraphView {
  const declared = new Map<string, ExtractorStatus>();
  for (const result of resultsSoFar) {
    for (const scope of result.authoritative) declared.set(scope.scope, result.status);
  }
  return {
    nodesByKind: (kind) => store.nodesByKind(kind),
    node: (id) => store.node(id),
    edgesFrom: (id, kind) => store.edgesFrom(id, kind),
    edgesTo: (id, kind) => store.edgesTo(id, kind),
    scopeStatus: (scope) => declared.get(scope) ?? store.scopeStatus(scope),
  };
}

export {
  INFER_JOIN_SCOPE,
  INFER_JOIN_VERSION,
  runInferJoin,
  type InferJoinOptions,
  type InferJoinRun,
  type TaggedAmbiguity,
};

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

/**
 * `DetectorRunnerPort` backed by `@seamline/contradictions`'s catalog. A detector
 * that is UNKNOWN is listed whatever made it so: a scope that is not PASS (with
 * the scopes and their status) or its own `unknownWhen` (with its reason and no
 * scope). `detectors` replaces the catalog, which only a test has a use for.
 */
export function contradictionsDetectorPort(detectors?: ReadonlyArray<SeamlineDetector>): DetectorRunnerPort {
  return {
    async run(view: GraphView, currentRun?: RunRecord): Promise<DetectionReport> {
      const report = runDetectors(view, detectors, currentObservationOf(currentRun));
      const unknown: UnknownDetection[] = report.detectors
        .filter((d) => d.outcome === 'unknown')
        .map((d) => {
          const scopeStatus: Record<string, ExtractorStatus> = {};
          for (const scope of d.blockedScopes) scopeStatus[scope] = view.scopeStatus(scope);
          return {
            code: d.code,
            severity: d.declaredSeverity,
            reason: d.result.known ? '' : d.result.reason,
            scopes: d.blockedScopes,
            scopeStatus,
            ...(d.unreadCodePackages === undefined ? {} : { unreadCodePackages: d.unreadCodePackages }),
          };
        });
      const notes: DetectorNotes[] = report.detectors
        .filter((d) => d.outcome !== 'unknown' && d.notes.length > 0)
        .map((d) => ({ code: d.code, notes: d.notes }));
      return { contradictions: report.findings, unknown, notes };
    },
  };
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  /** git's exit status; null when it did not run to an exit (could not be started, or refused). */
  readonly exitCode: number | null;
  /**
   * Set when git did not give an answer: it could not be started, `spawnUntrustedGit` refused to run
   * it for this repository, or it exited non-zero (the message says which). A caller must report
   * this; it is never "no output".
   */
  readonly failure: string | null;
}

function resolveGit(repoRoot: string): string | undefined {
  return resolveOutsideRepo('git', process.env['PATH'], repoRoot);
}

export function runGit(gitBin: string, cwd: string, args: readonly string[]): GitOutcome {
  // The one door for the CLI process's git (untrusted repository git configuration): the repository's own config and
  // attributes cannot start a program. See `spawnUntrustedGit`.
  const r = spawnUntrustedGit(gitBin, cwd, args);
  if (r.error) return { ok: false, stdout: '', exitCode: null, failure: r.error.message };
  if (r.status !== 0) {
    return {
      ok: false,
      stdout: r.stdout ?? '',
      exitCode: r.status,
      failure: `git ${args[0] ?? ''} exited ${r.status ?? 'on a signal'}`,
    };
  }
  return { ok: true, stdout: r.stdout ?? '', exitCode: 0, failure: null };
}

/** A git failure the CLI reports with a non-success exit, never as "no changes". */
function gitFailure(what: string, reason: string): CliError {
  return new CliError(
    `${what}: ${reason}.`,
    EXIT_RUNTIME,
    'Nothing was concluded about the working tree. Fix the repository or its git configuration, then run again.',
  );
}

function linesOf(out: GitOutcome): readonly string[] {
  return (
    out.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // Paths git prints are already repo-relative; normalise to POSIX so the
      // output stays comparable to `SeamlineNode.path` regardless of platform.
      .map((line) => line.replace(/\\/g, '/'))
  );
}

/** `GitPort` backed by real `git` subprocess calls. */
export function gitPort(): GitPort {
  return {
    async changedFiles(repoRoot: string): Promise<readonly string[]> {
      const gitBin = resolveGit(repoRoot);
      if (gitBin === undefined) {
        throw gitFailure('cannot read the working tree', 'no git was found on PATH outside the repository');
      }
      const must = (out: GitOutcome): GitOutcome => {
        if (!out.ok) throw gitFailure('cannot read the working tree', out.failure ?? 'git failed');
        return out;
      };
      const inside = runGit(gitBin, repoRoot, ['rev-parse', '--is-inside-work-tree']);
      // git ran and said this is not a work tree: there is nothing to compare. Anything else is a failure.
      if (inside.exitCode !== null && inside.exitCode !== 0) return [];
      must(inside);
      if (inside.stdout.trim() !== 'true') return [];

      // An unborn branch has no HEAD to compare with; only untracked files can be listed.
      const head = runGit(gitBin, repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
      // `--verify --quiet` exits 1 for a missing HEAD; any other failure is a failure.
      if (!head.ok && head.exitCode !== 1) must(head);
      const hasHead = head.ok;
      const unstaged = hasHead ? must(runGit(gitBin, repoRoot, ['diff', '--name-only', 'HEAD'])) : null;
      const staged = hasHead ? must(runGit(gitBin, repoRoot, ['diff', '--name-only', '--cached', 'HEAD'])) : null;
      const untracked = must(runGit(gitBin, repoRoot, ['ls-files', '--others', '--exclude-standard']));

      const files = new Set<string>();
      for (const line of [
        ...(unstaged === null ? [] : linesOf(unstaged)),
        ...(staged === null ? [] : linesOf(staged)),
        ...linesOf(untracked),
      ]) {
        files.add(line);
      }
      return [...files].sort();
    },
  };
}

// ---------------------------------------------------------------------------
// Full CliDeps
// ---------------------------------------------------------------------------

export interface BuildCliDepsOptions {
  /** Overrides for the sandbox host. A test passes a recording `spawn`; a release build passes nothing. */
  readonly sandbox?: Partial<SandboxHostOptions>;
}

/**
 * Constructs the full, real `CliDeps` for the `seamline` binary.
 *
 * Every extractor in `extractors` is a sandboxed port: its code runs in a
 * confined child process under its capability manifest (THREATMODEL.md C4,
 * `sandbox/`), never in this process. The in-process ports above are not used
 * here, and `extractCommand` has no in-process fallback of its own: an
 * extractor that is configured but not in this list is UNAVAILABLE.
 */
export function buildCliDeps(io: Io, options: BuildCliDepsOptions = {}): CliDeps {
  const store = sqliteStorePort();
  return {
    io,
    clock: systemClock(io.env),
    store,
    extractors: sandboxedExtractorPorts(firstPartyHost(io.env, options.sandbox)).map(
      withInputIdentity,
    ),
    detectors: contradictionsDetectorPort(),
    snapshots: fileSnapshots(),
    git: gitPort(),
    align: alignPort(),
    input: () => {
      process.stdin.setEncoding('utf8');
      return process.stdin;
    },
  };
}
