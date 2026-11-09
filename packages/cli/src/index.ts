/**
 * `@seamline/cli` — public surface.
 *
 * The CLI is a library that happens to ship a binary. `runCli(deps, argv)` is
 * total (returns an exit code, never exits the process), so the whole surface
 * is testable in-process and embeddable.
 *
 * Wiring: `wiring.ts` constructs `CliDeps` with the real implementations of
 * `StorePort`, `ExtractorPort[]`, `DetectorRunnerPort`, and `SnapshotPort`.
 * `bin.ts` (built to `dist/bin.js`, the package's published `bin` entry) is
 * the normal way to run it as a process.
 *
 * This module (`dist/index.js`) is this package's `main`/`exports` target —
 * the conventional place a tool looks for a runnable entry point given only
 * the package, without knowing about the separate `bin.js`. The guard at the
 * bottom of this file makes `node dist/index.js <args>` work the same way as
 * `dist/bin.js` when this module is the process entry point, while staying
 * an inert set of exports — never touching the process — when it is imported
 * as a library, which is what every test and every other command does.
 */

import { pathToFileURL } from 'node:url';
import { processIo } from './io.ts';
import { runCli } from './run.ts';
import { buildCliDeps } from './wiring.ts';

export { runCli, VERSION } from './run.ts';
export {
  bufferIo,
  CliError,
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  processIo,
  systemClock,
} from './io.ts';
export {
  COMMANDS,
  HELP_TEXT,
  COMMAND_HELP,
  findCommand,
  parseCommandArgs,
  isCommand,
  VALUE_OPTIONS,
} from './args.ts';
export type { Command, GlobalOptions, ParsedInvocation } from './args.ts';
export { colourEnabled, makeStyle, stripAnsi, styleFor } from './colour.ts';
export type { Style } from './colour.ts';
export {
  CONFIG_FILENAME,
  CONFIG_VERSION,
  DEFAULT_OUT_DIR,
  STARTER_PROFILE,
  defaultConfig,
  loadConfig,
  parseConfig,
  serializeConfig,
} from './config.ts';
export type { ExportProfile, ExtractorConfig, SeamlineConfig } from './config.ts';
export {
  appendIgnoreEntry,
  ensureGitignore,
  hasIgnoreEntry,
  IGNORE_ENTRY,
  ignoresEntry,
} from './gitignore.ts';
export {
  LINEAGE_EDGE_KINDS,
  LINEAGE_TARGET_KINDS,
  buildLineage,
  containerOf,
  resolveTarget,
} from './lineage.ts';
export type {
  LineageChain,
  LineageHop,
  LineageOptions,
  LineageResult,
  ResolveResult,
} from './lineage.ts';
export { canonicalJson, fileSnapshots, parseSif, serializeSif } from './sif.ts';
export { degradedScopes } from './scopes.ts';
export type { DegradedScope } from './scopes.ts';
export { failsBuild, SEVERITY_ORDER, severityRank } from './render.ts';

export { initCommand } from './commands/init.ts';
export type { InitReport } from './commands/init.ts';
export { extractCommand } from './commands/extract.ts';
export type { ExtractRedactions, ExtractReport } from './commands/extract.ts';
export { whyCommand } from './commands/why.ts';
export type { WhyReport } from './commands/why.ts';
export { buildReport, checkCommand } from './commands/check.ts';
export type { CheckOutcome, CheckReport } from './commands/check.ts';
export { exportCommand, exportThrough, refusal, resolveProfile } from './commands/export.ts';
export type { ExportReport } from './commands/export.ts';
export { diffCommand, diffSnapshots } from './commands/diff.ts';
export type { DiffReport } from './commands/diff.ts';
export { blastRadiusCommand } from './commands/blast-radius.ts';
export { mcpCommand } from './commands/mcp.ts';
export { conformanceCommand, renderConformance } from './commands/conformance.ts';
export type {
  BlastRadiusReport,
  ReachedGroup,
  ReachedNodeSummary,
  RootMatch,
} from './commands/blast-radius.ts';

export type {
  Clock,
  CliDeps,
  Confinement,
  DetectionReport,
  DetectorRunnerPort,
  ExtractContext,
  ExtractorOutput,
  ExtractorPort,
  GitPort,
  Io,
  OpenStoreOptions,
  RunHistory,
  ScopedEdges,
  Snapshot,
  SnapshotPort,
  StorePort,
  UnknownDetection,
  Workspace,
} from './ports.ts';

export {
  buildCliDeps,
  changeExtractorPort,
  codeTsExtractorPort,
  contractsExtractorPort,
  contradictionsDetectorPort,
  dataExtractorPort,
  gitPort,
  inferJoinExtractorPort,
  runInferJoin,
  scopeAwareView,
  sqliteStorePort,
} from './wiring.ts';
export type { BuildCliDepsOptions, InferJoinRun } from './wiring.ts';

export {
  FIRST_PARTY_LIMITS,
  FIRST_PARTY_PROGRAMS,
  firstPartyHost,
  sandboxedExtractorPorts,
} from './sandbox/first-party.ts';
export {
  createSandboxHost,
  hasPermissionModel,
  observationOf,
  sandboxedPort,
} from './sandbox/host.ts';
export type { SandboxObservation } from './sandbox/host.ts';
export {
  PROPERTY_IDS,
  PROPERTY_TITLES,
  SUITE_VERSION,
  conformanceOfModule,
  loadExtractorProgram,
  runConformance,
} from './conformance/index.ts';
export type {
  ConformanceOptions,
  ConformanceReport,
  ConformanceRunOptions,
  PropertyId,
  PropertyResult,
  RunSummary,
  Verdict,
} from './conformance/index.ts';
export type { SandboxHost, SandboxHostOptions, SandboxProgram, SpawnFn } from './sandbox/host.ts';

// ---------------------------------------------------------------------------
// Script entry point
// ---------------------------------------------------------------------------

/**
 * Fires only when this file *is* the process entry point (`node
 * dist/index.js ...`), never on import. Mirrors `bin.ts`'s wiring exactly, so
 * the two entry points cannot disagree about what `seamline` does.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deps = buildCliDeps(processIo());
  process.exitCode = await runCli(deps, process.argv.slice(2));
}
