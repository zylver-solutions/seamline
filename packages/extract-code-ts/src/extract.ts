/**
 * The extractor entry point and its status envelope.
 *
 * The envelope is the part that matters most operationally. Design v3 §2.2:
 * UNAVAILABLE is never PASS, and a query that depends on an UNAVAILABLE scope
 * returns UNKNOWN rather than a negative finding. So this function refuses to
 * return `PASS` with zero nodes when the reason for zero is "there was no
 * tsconfig" or "the checker could not start" — downstream, an empty PASS is
 * indistinguishable from "this repo has no symbols" and manufactures a wall of
 * false contradictions.
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { Project, ts } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { assertWithinCeiling, nodeId } from '@seamline/ontology';
import type {
  AuthoritativeScope, ExtractorResult, ExtractorStatus, NodeId, SeamlineEdge, SeamlineNode,
} from '@seamline/ontology';
import { fileId, moduleId, repoId } from './canonical.ts';
import { Collector } from './collector.ts';
import type { Ctx, FileRecord } from './context.ts';
import { ormNames, parseDataModelIndex, tableBinder } from './data-model.ts';
import type { OrmNames } from './data-model.ts';
import {
  authoritativeSelector, coverageDiagnostics, listCandidateFiles, listPackageManifests, listProjectConfigs,
  loadProjects,
} from './coverage.ts';
import type { CandidateFileOptions, LoadedProject } from './coverage.ts';
import {
  CODE_TS_AUTHORITATIVE, CODE_TS_SCOPE, EXTRACTOR_NAME, EXTRACTOR_VERSION, codeTsAuthoritative, manifest,
} from './manifest.ts';
import { MemoryCeilingError, estimateProgramMib, planPrograms, resolveMemory, sourceBytes } from './memory.ts';
import type { MemoryBudget } from './memory.ts';
import { ModuleResolver } from './modules.ts';
import { firstOrmShapedWrite } from './orm-shape.ts';
import { OUTSIDE_REPOSITORY, redactPaths, toRepoRelative } from './paths.ts';
import { scanUnreadFiles } from './unread-files.ts';
import type { UnreadScan } from './unread-files.ts';
import { scanRuntimeDdl } from './write-guards.ts';
import { emitModuleImports, emitQueryEdges, relateDeclarations, relateFile } from './relations.ts';
import type { SqlTableName } from './sql.ts';
import { declareFile } from './symbols.ts';
import {
  discoverWorkspacePackages, parseUnit, readWorkspaceConfig, workspaceConfigHost,
} from './workspace.ts';
import type { WorkspacePackage, WorkspaceUnit } from './workspace.ts';

export interface ExtractCodeTsOptions {
  /** Absolute path to the repository root. Never appears in any emitted value. */
  readonly repoRoot: string;
  /** Repository identifier used as the id prefix. Must not contain `:`. */
  readonly repo: string;
  readonly runId: string;
  /** Defaults to `<repoRoot>/tsconfig.json`. */
  readonly tsConfigFilePath?: string;
  /**
   * The data-model index: a canonical JSON document, built by
   * `buildDataModelIndex` in `@seamline/extract-data` from that extractor's
   * output, handed in as text so it can cross a process boundary unchanged. Its
   * bytes are an input of the run: the same index and the same repository give
   * the same output. It is never read from disk.
   *
   * With it, a table name in a SQL string binds to the `Table` node it means
   * (dialect folding, schema qualification, the default schema), and a name two
   * tables could mean gets no edge and is listed in `unknownWriterTables` on
   * the `Repo` node. A name no table matches keeps the name-only answer, and so
   * does a name only one non-default schema declares, which is also listed in
   * `unknownWriterTables`.
   *
   * An index with no tables is still an index: it is what the composition root
   * hands over when `extract-data` found no schema source it reads or recognises
   * (and knew of none it did not read), so nothing it saw is declared for a name
   * to bind to and every name keeps the name-only answer.
   *
   * Absent (or refused as malformed): the `Repo` node carries
   * `ormIndexAbsent`, and the run is UNAVAILABLE rather than PASS when the files
   * it read contain an ORM-shaped write call or a raw-SQL table reference (any
   * string the SQL classifier reads, which includes prose that starts with a
   * statement verb): the
   * ORM edges that call would have produced are missing, and the edge a
   * statement had bound to a declared table would be re-pointed to the
   * name-only table, and a PASS would sweep the earlier ones.
   */
  readonly dataModelIndex?: string;
  /** Force deterministic mode. Defaults to `SEAMLINE_DETERMINISTIC=1`. */
  readonly deterministic?: boolean;
  /**
   * Repository-relative globs, in tsconfig `include`/`exclude` syntax, bounding
   * which TypeScript/JavaScript files count toward coverage and which
   * unreferenced `tsconfig.json` files are discovered. What a loaded project
   * reads is still decided by its own tsconfig. By default every file under
   * the root counts and none is excluded.
   */
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /**
   * Bounds how much of a workspace (a repository with no root `tsconfig.json`)
   * one run reads, from the size of its files, and sets the ceiling on resident
   * memory past which the run is `UNAVAILABLE`; see `MemoryBudget`. The default
   * follows the manifest.
   */
  readonly memoryBudget?: MemoryBudget;
}

const DEFAULT_INCLUDE: readonly string[] = ['**/*'];

export interface ExtractCodeTsOutput {
  readonly result: ExtractorResult;
  readonly nodes: readonly SeamlineNode[];
  readonly edges: readonly SeamlineEdge[];
}

/**
 * Default `Table` id: `{repo}:Table:{schema}.{table}`, schema defaulting to
 * `public`. It is the answer for a name no declared table matches (or when there
 * is no index), so the edge still points at an external `Table` node.
 */
export function defaultTableId(repo: string): (ref: Pick<SqlTableName, 'table' | 'schema'>) => NodeId {
  return (ref) => nodeId(repo, 'Table', `${ref.schema ?? 'public'}.${ref.table}`);
}

export function extractCodeTs(options: ExtractCodeTsOptions): ExtractCodeTsOutput {
  const startedAt = Date.now();
  const deterministic = options.deterministic ?? process.env['SEAMLINE_DETERMINISTIC'] === '1';
  const diagnostics: string[] = [];

  // Enforced by the host in production; asserted here so a ceiling regression
  // fails in this package's own tests rather than three packages downstream.
  assertWithinCeiling(manifest, 'EXTRACTED');

  const repoRoot = nodePath.resolve(options.repoRoot);
  const tsConfigFilePath = options.tsConfigFilePath ?? nodePath.join(repoRoot, 'tsconfig.json');
  const bounds = { repoRoot, include: options.include ?? DEFAULT_INCLUDE, exclude: options.exclude ?? [] };

  if (!fs.existsSync(tsConfigFilePath)) {
    const missing = `no tsconfig.json at ${toRepoRelative(repoRoot, tsConfigFilePath) ?? 'the configured path'}`;
    // Only the default location falls back to the workspace packages: a path the
    // caller named and that is not there is a mistake to report, not to route around.
    if (options.tsConfigFilePath === undefined) {
      const workspace = extractWorkspace(options, repoRoot, bounds, missing, startedAt, deterministic);
      if (workspace !== null) return workspace;
    }
    return unavailable([missing], startedAt, deterministic);
  }

  let project: Project;
  try {
    project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false });
  } catch (error) {
    return unavailable([`tsconfig could not be loaded: ${messageOf(repoRoot, error)}`], startedAt, deterministic);
  }

  const loadedConfigs: string[] = [nodePath.resolve(tsConfigFilePath)];
  const unreadProjects: string[] = [];
  if (selectSourceFiles(project, repoRoot).length === 0) {
    // A solution-style root tsconfig (`"files": []` plus `references`) is the
    // normal shape of a monorepo and resolves no files of its own. Following
    // the references is the difference between extracting the whole workspace
    // and reporting UNAVAILABLE on every repo built this way.
    addReferencedProjects(project, tsConfigFilePath, diagnostics, loadedConfigs, unreadProjects, repoRoot);
  }
  addDiscoveredProjects(project, bounds, diagnostics, loadedConfigs, unreadProjects);
  const sourceFiles = selectSourceFiles(project, repoRoot);
  if (sourceFiles.length === 0) {
    return unavailable(['tsconfig resolved zero in-repo source files'], startedAt, deterministic);
  }

  const checkerProbe = probeTypeChecker(repoRoot, project, sourceFiles);
  if (checkerProbe !== null) {
    return unavailable([`type checker unavailable: ${checkerProbe}`], startedAt, deterministic);
  }

  const { bindTable, names } = resolveBinder(options, diagnostics);

  let passes: Passes;
  try {
    passes = runPasses({
      repo: options.repo,
      repoRoot,
      runId: options.runId,
      bindTable,
      names,
      programs: [sourceFiles],
      diagnostics,
      repoProps: unreadPackageProps([...new Set(unreadProjects)].sort(compareCodeUnits)),
      coverage: (readFiles) => measureCoverage(loadedConfigs, bounds, readFiles),
    });
  } catch (error) {
    diagnostics.push(`extraction failed: ${messageOf(repoRoot, error)}`);
    return envelope('FAIL', [], [], diagnostics, startedAt, deterministic);
  }

  const collected = passes.collector.finish();
  if (collected.rejectedEdges.length > 0) {
    diagnostics.push(
      `${collected.rejectedEdges.length} edge(s) not emitted (out-of-project endpoints or signature violations)`,
      ...collected.rejectedEdges.slice(0, 20),
    );
  }

  const read = new Set([...passes.ctx.files.values()].map((f) => f.rel));
  const projects: readonly LoadedProject[] = passes.coverage.projects;
  const unread: readonly string[] | null = passes.coverage.unread;
  diagnostics.push(...passes.coverage.diagnostics);
  // Without the walk no directory can be shown to hold only read files, so the
  // selector falls back to naming paths (see `authoritativeSelector`).
  const selector = authoritativeSelector(repoRoot, projects, read, unread);

  // No index, and something in what was read that the index would have bound: an
  // ORM-shaped write call (its ORM edge is missing) or a raw-SQL table reference (its
  // edge is built without the index, so it would point at the name-only table, and the
  // edge an earlier run bound to a declared table would be re-pointed and swept). Only a
  // PASS sweeps, so a PASS here would bury what an earlier run emitted. The output is
  // still returned; UNAVAILABLE is what keeps it from being read as "the code does not
  // touch that table".
  const lost = sqlResourceLimitDiagnostic(passes.ctx) ??
    (bindTable === null ? lostWithoutIndex(sourceFiles, repoRoot, passes.ctx) : null);
  if (lost !== null) diagnostics.unshift(lost);
  return envelope(
    lost === null ? 'PASS' : 'UNAVAILABLE',
    collected.nodes, collected.edges, diagnostics, startedAt, deterministic, codeTsAuthoritative(selector),
  );
}

/* ------------------------------------------------------------ shared passes */

interface PassesInput {
  readonly repo: string;
  readonly repoRoot: string;
  readonly runId: string;
  /** Binds a SQL table reference to a declared `Table` node; `null` when there is no data-model index. */
  readonly bindTable: Ctx['bindTable'];
  /** What the data-model index lets raw SQL and ORM-shaped writes be matched against; `null` without an index. */
  readonly names: OrmNames | null;
  /** One entry per TypeScript program; each file belongs to exactly one, in sorted order. */
  readonly programs: ReadonlyArray<readonly SourceFile[]>;
  readonly diagnostics: string[];
  /** Props of the `Repo` node. Empty unless the run has something to say about its own coverage. */
  readonly repoProps: Readonly<Record<string, string | number | boolean | null>>;
  /** Called between files; throws to stop the passes (the resident-memory fail-safe). */
  readonly checkpoint?: () => void;
  /**
   * What the loaded projects read and leave out, given the set of repo-relative files the passes
   * read. Called once, after every file is related: the files no project reads are scanned for
   * writes (`unknownWriterTables`). Never throws.
   */
  readonly coverage: (read: ReadonlySet<string>) => Coverage;
}

interface Passes {
  readonly collector: Collector;
  readonly ctx: Ctx;
  readonly coverage: Coverage;
}

/** The two things a data-model index gives the passes. */
interface Binder {
  readonly bindTable: Ctx['bindTable'];
  readonly names: OrmNames | null;
}

/**
 * The extraction passes over one or more programs.
 *
 * Declarations are keyed by `file|position` (see `declKey`), not by program, so
 * a reference in one program that resolves into a file another program owns
 * finds that file's declaration. Every pass runs over every program before the
 * next begins, because relationships cannot be resolved while declarations are
 * still being discovered.
 */
function runPasses(input: PassesInput): Passes {
  const collector = new Collector({ runId: input.runId, scope: CODE_TS_SCOPE, provenance: 'EXTRACTED' });
  const ctx: Ctx = {
    repo: input.repo,
    repoRoot: input.repoRoot,
    collector,
    modules: new ModuleResolver(input.repoRoot),
    files: new Map<string, FileRecord>(),
    decls: new Map(),
    diagnostics: input.diagnostics,
    tableId: defaultTableId(input.repo),
    bindTable: input.bindTable,
    unknownWriterTables: new Map(),
    names: input.names,
    guards: { untraced: new Map(), hooks: new Map(), runtimeDdl: new Map(), excluded: [] },
    firstRawSql: { site: null },
    sqlResourceLimit: { site: null },
    moduleImports: new Map(),
    queries: new Map(),
  };
  const sourceFiles = input.programs.flat();

  const rootId = collector.node({ id: repoId(input.repo), kind: 'Repo', name: input.repo, props: input.repoProps });

  for (const sf of sourceFiles) {
    input.checkpoint?.();
    const rel = toRepoRelative(input.repoRoot, sf.getFilePath());
    if (rel === null) continue;
    const module = ctx.modules.forFile(rel);
    const modId = moduleId(input.repo, module.name);
    collector.node({
      id: modId,
      kind: 'Module',
      name: module.name,
      ...(module.dir === '' ? {} : { path: module.dir }),
      props: { ...(module.entry === null ? {} : { entry: module.entry }) },
    });
    const record: FileRecord = { rel, id: fileId(input.repo, rel), module, moduleId: modId };
    collector.node({
      id: record.id,
      kind: 'File',
      name: rel,
      path: rel,
      props: { extension: extensionOf(rel), module: module.name },
    });
    collector.edge({ kind: 'CONTAINS', src: rootId, dst: record.id, dstFile: rel });
    collector.edge({ kind: 'CONTAINS', src: rootId, dst: modId });
    collector.edge({ kind: 'CONTAINS', src: modId, dst: record.id, dstFile: rel });
    ctx.files.set(sf.getFilePath(), record);
  }

  for (const sf of sourceFiles) {
    input.checkpoint?.();
    const record = ctx.files.get(sf.getFilePath());
    if (record !== undefined) declareFile(ctx, sf, record);
  }

  input.checkpoint?.();
  relateDeclarations(ctx);

  for (const sf of sourceFiles) {
    input.checkpoint?.();
    const record = ctx.files.get(sf.getFilePath());
    if (record !== undefined) relateFile(ctx, sf, record);
  }
  input.checkpoint?.();
  emitModuleImports(ctx);
  emitQueryEdges(ctx);
  const coverage = input.coverage(new Set([...ctx.files.values()].map((f) => f.rel)));
  describeRepo(ctx, rootId, input.repoRoot, coverage.unread, input.diagnostics);
  return { collector, ctx, coverage };
}

/* ------------------------------------------------------- workspace packages */

/** How many unread package directories the `Repo` node names; its count is always exact. */
const MAX_NAMED_UNREAD_PACKAGES = 25;

/** The reason given for a tsconfig left unread because the memory budget ran out. */
const MEMORY_BUDGET_REASON = 'memory budget';

export type { MemoryBudget } from './memory.ts';

/** What reading one workspace package produced. */
interface PackageRead {
  readonly pkg: WorkspacePackage;
  /** Units that loaded, probed, and built a program. */
  readonly units: WorkspaceUnit[];
  /** One line per tsconfig of the package that could not be read, with the reason. */
  readonly failures: string[];
  /** One line per tsconfig read although a package it extends is not installed. */
  readonly notes: string[];
}

interface BuiltUnit {
  readonly unit: WorkspaceUnit;
  readonly project: Project;
  /** Absolute paths in the unit's own file list, declaration files and `node_modules` aside. */
  readonly members: ReadonlySet<string>;
}

/**
 * Reads a repository that has no root `tsconfig.json` from its workspace
 * packages, one program per tsconfig. `null` when the repository declares no
 * workspace, which leaves the caller's UNAVAILABLE as it was.
 *
 * - Packages come from `pnpm-workspace.yaml` and the root `package.json`
 *   (`workspace.ts`); each package's own `tsconfig.json` is a unit, and a
 *   package whose tsconfig resolves no files of its own and has `references`
 *   (a solution-style package) contributes the referenced configs instead. A
 *   package manifest is `package.json`, `package.json5` or `package.yaml`, as
 *   pnpm accepts all three; the last two are discovered but not read (no parser,
 *   so no package name to build ids from), and such a package with a tsconfig is
 *   named unread, never silently absent.
 * - A tsconfig whose files or options cannot be known (`extends` into a package
 *   that is not installed and is not in the workspace, a syntax error) is not
 *   read, and the package is named in a diagnostic. Its options could differ
 *   from the ones a guess would use, and `strict` decides what is nullable.
 * - Each unit is its own program, so each keeps its own `paths`, `jsx`, and
 *   `moduleResolution`; a combined program could hold only one set. A file the
 *   program reaches by import belongs to the unit whose tsconfig includes it,
 *   the one whose directory is nearest above the file first, else to the first
 *   unit (by config path) that reaches it, so every file is declared once. Ids
 *   do not depend on which program read a file.
 * - Programs are considered in package order (sorted by directory) and each one
 *   built stays alive until the run ends, so memory grows with their number. Which
 *   are built is decided before the first one is, from the size of each program's
 *   own file list against a budget that follows the manifest's `memMb`
 *   (`memory.ts`): a tsconfig whose estimate does not fit what is left of the
 *   budget is not built, the next ones are tried (first fit), and the packages
 *   left out are named unread with the reason `memory budget`. A very large
 *   workspace is therefore read partially, the output says so, and the packages
 *   read depend on the repository alone, never on the machine. Resident memory is
 *   checked only as a fail-safe: past the ceiling the run is `UNAVAILABLE`, never
 *   a different `PASS`.
 * - The authoritative selector is built from the units that were read, so a
 *   package that was not read is outside it and its facts are never tombstoned.
 *   The `Repo` node names the packages not read, which is how the contradiction
 *   detectors that reason from the absence of code facts know to report UNKNOWN.
 */
function extractWorkspace(
  options: ExtractCodeTsOptions,
  repoRoot: string,
  bounds: Omit<CandidateFileOptions, 'outputDirs'>,
  missing: string,
  startedAt: number,
  deterministic: boolean,
): ExtractCodeTsOutput | null {
  const notes: string[] = [];
  const config = readWorkspaceConfig(repoRoot, notes);
  if (config === null) return notes.length === 0 ? null : unavailable([missing, ...notes], startedAt, deterministic);

  let packages: readonly WorkspacePackage[];
  let incompletePatterns: readonly string[];
  try {
    const walk = { ...bounds, outputDirs: [] };
    ({ packages, incompletePatterns } = discoverWorkspacePackages(
      repoRoot, config, listPackageManifests(walk), listProjectConfigs(walk), notes,
    ));
  } catch (error) {
    return unavailable(
      [missing, ...notes, `workspace discovery failed: ${messageOf(repoRoot, error)}`], startedAt, deterministic,
    );
  }
  notes.push(`${packages.length} workspace package(s) from ${config.source}`);

  const parseHost = workspaceConfigHost(repoRoot, packages, ts.sys.readDirectory);
  const specsHost = workspaceConfigHost(repoRoot, packages, () => []);
  const reads: PackageRead[] = packages.map((pkg) => readPackage(pkg, repoRoot, parseHost));

  const memory = resolveMemory(options.memoryBudget);
  const built: BuiltUnit[] = [];
  const skipped = { units: 0, packages: new Set<string>() };
  const planned = reads.flatMap((read) => read.units.map((unit) => ({ read, unit })));
  const plan = planPrograms(
    planned.map(({ unit }) => estimateProgramMib(sourceBytes(repoRoot, unit.parsed.fileNames))),
    memory.budgetMb,
  );
  notes.push(
    `memory estimate: ${plan.totalMib} MiB of resident memory for ${planned.length} tsconfig(s), from the size of their files, ` +
      `against a budget of ${memory.budgetMb} MiB`,
  );
  try {
    for (const [index, { read, unit }] of planned.entries()) {
      memory.checkCeiling();
      const fits = plan.fits[index] === true;
      const failure = fits ? buildUnit(unit, repoRoot) : MEMORY_BUDGET_REASON;
      memory.checkCeiling();
      if (typeof failure === 'string') {
        read.units.splice(read.units.indexOf(unit), 1);
        read.failures.push(`${relOrAbsolute(repoRoot, unit.configPath)}: ${failure}`);
        if (!fits) {
          skipped.units += 1;
          skipped.packages.add(read.pkg.dir);
        }
      } else {
        built.push(failure);
      }
    }
  } catch (error) {
    if (error instanceof MemoryCeilingError) return memoryCeilingReached(missing, notes, memory.ceilingMb, startedAt, deterministic);
    throw error;
  }
  if (skipped.units > 0) {
    notes.push(
      `memory budget reached: ${skipped.units} tsconfig(s) in ${skipped.packages.size} workspace package(s) were not read; ` +
        'a tsconfig whose estimate does not fit what is left of the budget is not read and the next ones are ' +
        'tried, in package order, so a very large workspace is read partially',
    );
  }
  // Config order, not package order, decides ties below.
  built.sort((a, b) => compareCodeUnits(a.unit.configPath, b.unit.configPath));

  const programs = assignFiles(built, repoRoot);
  const sourceCount = programs.reduce((n, p) => n + p.length, 0);
  if (built.length === 0 || sourceCount === 0) {
    const failed = reads.flatMap((r) => r.failures.map((f) => `workspace package not read: ${r.pkg.dir}: ${f}`));
    return unavailable(
      [missing, ...notes, ...failed, 'no workspace package tsconfig resolved an in-repo source file'],
      startedAt,
      deterministic,
    );
  }

  const diagnostics: string[] = [`${missing}; reading workspace packages instead`, ...notes];
  for (const read of reads) {
    for (const note of read.notes) diagnostics.push(`workspace package read: ${read.pkg.dir}: ${note}`);
  }
  const loadedConfigs = built.map((b) => b.unit.configPath);
  const readUnits = programs.flat();
  const readRels = new Set(readUnits.map((sf) => toRepoRelative(repoRoot, sf.getFilePath())).filter((r): r is string => r !== null));

  let passes: Passes;
  try {
    // The marker needs the candidate walk, which needs the units; run it first.
    const projects = loadProjects(loadedConfigs, specsHost);
    const candidates = listCandidateFiles({ ...bounds, outputDirs: projects.flatMap((p) => p.outputDirs) });
    const unreadCandidates = candidates.filter((rel) => !readRels.has(rel));
    const unreadPackages = unreadPackageDirs(reads, incompletePatterns, unreadCandidates, diagnostics);
    const { bindTable, names } = resolveBinder(options, diagnostics);
    passes = runPasses({
      repo: options.repo,
      repoRoot,
      runId: options.runId,
      bindTable,
      names,
      programs,
      diagnostics,
      repoProps: unreadPackageProps(unreadPackages),
      checkpoint: memory.checkCeiling,
      coverage: (read) => ({
        projects,
        unread: candidates.filter((rel) => !read.has(rel)),
        diagnostics: coverageDiagnostics(candidates, read),
      }),
    });
    const collected = passes.collector.finish();
    if (collected.rejectedEdges.length > 0) {
      diagnostics.push(
        `${collected.rejectedEdges.length} edge(s) not emitted (out-of-project endpoints or signature violations)`,
        ...collected.rejectedEdges.slice(0, 20),
      );
    }
    diagnostics.push(...coverageDiagnostics(candidates, readRels));
    const selector = authoritativeSelector(repoRoot, projects, readRels, unreadCandidates);
    // Same rule as the single-program path: without the index, a read ORM-shaped write or
    // raw-SQL table reference makes the scope UNAVAILABLE, never PASS.
    const lost = sqlResourceLimitDiagnostic(passes.ctx) ??
      (bindTable === null ? lostWithoutIndex(readUnits, repoRoot, passes.ctx) : null);
    if (lost !== null) diagnostics.unshift(lost);
    return envelope(
      lost === null ? 'PASS' : 'UNAVAILABLE',
      collected.nodes, collected.edges, diagnostics, startedAt, deterministic, codeTsAuthoritative(selector),
    );
  } catch (error) {
    if (error instanceof MemoryCeilingError) return memoryCeilingReached(missing, notes, memory.ceilingMb, startedAt, deterministic);
    diagnostics.push(`extraction failed: ${messageOf(repoRoot, error)}`);
    return envelope('FAIL', [], [], diagnostics, startedAt, deterministic);
  }
}

/**
 * The run ended because resident memory passed the ceiling. Which packages a run
 * reads never depends on memory, so the honest answer is that this run could not
 * finish: `UNAVAILABLE`, with nothing extracted, so no store sweeps anything and
 * every scope that needs `code.ts` reports UNKNOWN. The message names the ceiling
 * (the manifest's, a constant) and not the reading, which differs between runs.
 */
function memoryCeilingReached(
  missing: string,
  notes: readonly string[],
  ceilingMb: number,
  startedAt: number,
  deterministic: boolean,
): ExtractCodeTsOutput {
  return unavailable(
    [
      missing,
      ...notes,
      `resident memory passed the ${ceilingMb} MiB ceiling while reading the workspace; nothing was extracted. ` +
        'Which packages are read depends on the repository alone, so this is a limit of the machine, not a partial read',
    ],
    startedAt,
    deterministic,
  );
}

/** Loads a package's tsconfig, following `references` when it resolves no files of its own. */
function readPackage(pkg: WorkspacePackage, repoRoot: string, host: ts.ParseConfigFileHost): PackageRead {
  const read: PackageRead = { pkg, units: [], failures: [], notes: [] };
  if (pkg.tsconfig === null) return read;
  if (pkg.manifest !== 'package.json') {
    // Ids are built from the package name, and this extractor reads no JSON5 or YAML: the name is not known.
    read.failures.push(
      `${relOrAbsolute(repoRoot, pkg.tsconfig)}: its manifest is ${pkg.manifest}, which is not read ` +
        '(no parser for it), so the package name its ids are built from is not known',
    );
    return read;
  }
  const seen = new Set<string>();
  const visit = (configPath: string, depth: number): void => {
    const resolved = nodePath.resolve(configPath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const parsed = parseUnit(resolved, repoRoot, host);
    if (!parsed.ok) {
      read.failures.push(`${relOrAbsolute(repoRoot, resolved)}: ${parsed.reason}`);
      return;
    }
    if (parsed.unresolvedBases.length > 0) {
      read.notes.push(
        `${relOrAbsolute(repoRoot, resolved)}: extends ${parsed.unresolvedBases.map((b) => `"${b}"`).join(', ')} is not installed; ` +
          'read with the options that could be resolved, which settle null checking',
      );
    }
    if (parsed.unit.parsed.fileNames.length > 0) {
      read.units.push(parsed.unit);
      return;
    }
    if (depth >= MAX_REFERENCE_DEPTH) return;
    const references = (parsed.unit.parsed.projectReferences ?? [])
      .map((ref) => nodePath.resolve(ts.resolveProjectReferencePath(ref)))
      .sort(compareCodeUnits);
    for (const reference of references) {
      if (fs.existsSync(reference)) visit(reference, depth + 1);
      else read.failures.push(`${relOrAbsolute(repoRoot, reference)}: referenced project not found`);
    }
  };
  visit(pkg.tsconfig, 0);
  return read;
}

/**
 * A program for the unit, or the reason it cannot have one. A unit whose type
 * checker does not answer is as unread as one whose config does not parse.
 */
function buildUnit(unit: WorkspaceUnit, repoRoot: string): BuiltUnit | string {
  try {
    const project = new Project({ compilerOptions: unit.parsed.options, skipAddingFilesFromTsConfig: true });
    for (const file of unit.parsed.fileNames) project.addSourceFileAtPathIfExists(file);
    project.resolveSourceFileDependencies();
    const files = selectSourceFiles(project, repoRoot);
    if (files.length > 0) {
      const probe = probeTypeChecker(repoRoot, project, files);
      if (probe !== null) return `type checker unavailable: ${probe}`;
    }
    const members = new Set<string>();
    for (const file of unit.parsed.fileNames) {
      const rel = toRepoRelative(repoRoot, file);
      if (rel === null || rel.split('/').includes('node_modules') || /\.d(\.[^./]+)?\.[cm]?ts$/.test(rel)) continue;
      members.add(nodePath.resolve(file));
    }
    return { unit, project, members };
  } catch (error) {
    return messageOf(repoRoot, error);
  }
}

/**
 * Splits the source files of every built unit into programs so each file is
 * declared once, sorted by repo-relative path within its program.
 *
 * A file a unit's tsconfig includes belongs to the unit whose tsconfig
 * directory is the nearest ancestor of the file (the tsconfig an editor would
 * pick), then to the first unit in config order. A unit whose directory is not
 * above the file at all (`../shared/src` in its `include`, an `e2e/` config
 * that reaches into `../src`) ranks below every unit whose directory is, so the
 * options applied to a file are those of the package it lives in. A file no unit
 * includes, reached only through an import, belongs to the first unit in config
 * order that reaches it.
 */
function assignFiles(built: readonly BuiltUnit[], repoRoot: string): ReadonlyArray<readonly SourceFile[]> {
  /** How far down the file the unit's directory is: -1 when it is not an ancestor. */
  const proximity = (b: BuiltUnit, file: string): number => {
    const rel = nodePath.relative(nodePath.dirname(b.unit.configPath), file);
    if (rel.startsWith('..') || nodePath.isAbsolute(rel)) return -1;
    return nodePath.dirname(b.unit.configPath).split(nodePath.sep).length;
  };
  const owner = new Map<string, BuiltUnit>();
  for (const b of built) {
    for (const file of b.members) {
      const current = owner.get(file);
      if (current === undefined || proximity(b, file) > proximity(current, file)) owner.set(file, b);
    }
  }
  const taken = new Set<string>(owner.keys());
  const perUnit = new Map<BuiltUnit, SourceFile[]>(built.map((b) => [b, []]));
  for (const b of built) {
    for (const sf of selectSourceFiles(b.project, repoRoot)) {
      const file = nodePath.resolve(sf.getFilePath());
      if (owner.get(file) === b) perUnit.get(b)?.push(sf);
      else if (!taken.has(file)) {
        taken.add(file);
        perUnit.get(b)?.push(sf);
      }
    }
  }
  return built.map((b) => perUnit.get(b) ?? []);
}

/**
 * What the run did not read, sorted: workspace packages whose code was not read
 * (a tsconfig that could not be read, or no readable tsconfig and TypeScript or
 * JavaScript files left unread), and `pattern:<glob>` for each workspace pattern
 * the matcher cannot evaluate, because the packages it names were never found.
 * A package whose tsconfig was read is read even where its own `include` leaves
 * files out; those files are in the coverage diagnostics.
 */
function unreadPackageDirs(
  reads: readonly PackageRead[],
  incompletePatterns: readonly string[],
  unreadCandidates: readonly string[],
  diagnostics: string[],
): readonly string[] {
  const dirs = reads.map((r) => r.pkg.dir).sort((a, b) => b.length - a.length);
  const holdsUnread = new Set<string>();
  for (const rel of unreadCandidates) {
    const dir = dirs.find((d) => rel.startsWith(`${d}/`));
    if (dir !== undefined) holdsUnread.add(dir);
  }
  const unread: string[] = [];
  for (const read of reads) {
    if (read.failures.length > 0) {
      for (const failure of read.failures) diagnostics.push(`workspace package not read: ${read.pkg.dir}: ${failure}`);
      unread.push(read.pkg.dir);
    } else if (read.units.length === 0 && holdsUnread.has(read.pkg.dir)) {
      const why = read.pkg.tsconfig === null ? 'no tsconfig.json' : 'its tsconfig.json includes none of its files';
      diagnostics.push(`workspace package not read: ${read.pkg.dir}: ${why}`);
      unread.push(read.pkg.dir);
    }
  }
  for (const pattern of incompletePatterns) unread.push(`pattern:${pattern}`);
  unread.sort(compareCodeUnits);
  if (unread.length > 0) {
    diagnostics.push(
      `${unread.length} workspace package(s) not read; the code.ts scope does not cover them, and detectors that ` +
        'reason from the absence of a code fact report UNKNOWN',
    );
  }
  return unread;
}

/**
 * The `Repo` props that say part of the code was not read: an exact count, and
 * the first names as a JSON array of strings (a directory name can hold any
 * character, so no separator is safe). Empty when everything was read.
 */
function unreadPackageProps(unread: readonly string[]): Readonly<Record<string, string | number>> {
  if (unread.length === 0) return {};
  return {
    unreadCodePackageCount: unread.length,
    unreadCodePackages: JSON.stringify(unread.slice(0, MAX_NAMED_UNREAD_PACKAGES)),
  };
}

function relOrAbsolute(repoRoot: string, file: string): string {
  return toRepoRelative(repoRoot, file) ?? OUTSIDE_REPOSITORY;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ helpers */

interface Coverage {
  readonly projects: readonly LoadedProject[];
  /** TypeScript/JavaScript files under the root that no loaded project reads, or `null` when the walk could not run. */
  readonly unread: readonly string[] | null;
  readonly diagnostics: readonly string[];
}

/** What the loaded projects read and what they leave out (see `coverage.ts`). Never throws. */
function measureCoverage(
  loadedConfigs: readonly string[],
  bounds: Omit<CandidateFileOptions, 'outputDirs'>,
  read: ReadonlySet<string>,
): Coverage {
  let projects: readonly LoadedProject[] = [];
  try {
    projects = loadProjects(loadedConfigs);
    const candidates = listCandidateFiles({ ...bounds, outputDirs: projects.flatMap((p) => p.outputDirs) });
    return {
      projects,
      unread: candidates.filter((rel) => !read.has(rel)),
      diagnostics: coverageDiagnostics(candidates, read),
    };
  } catch (error) {
    return {
      projects,
      unread: null,
      diagnostics: [`tsconfig coverage could not be measured: ${messageOf(bounds.repoRoot, error)}`],
    };
  }
}

/** Sites listed one per diagnostic; the summary line always carries the full count. */
const MAX_LISTED_SITES = 20;

/** The binder and ORM names for the supplied data-model index, or `null`s when it is absent or refused as malformed. */
function resolveBinder(options: ExtractCodeTsOptions, diagnostics: string[]): Binder {
  if (options.dataModelIndex === undefined) return { bindTable: null, names: null };
  const parsed = parseDataModelIndex(options.dataModelIndex, options.repo);
  if (parsed.ok) return { bindTable: tableBinder(parsed.index), names: ormNames(parsed.index) };
  diagnostics.push(`data-model index refused (${parsed.problem}); treated as absent`);
  return { bindTable: null, names: null };
}

/**
 * Facts about the run that are not about any one file, on the `Repo` node (design 5.2). They are
 * written on every run, so that a prop that is missing means the extractor did not run, never
 * "zero":
 *
 * - `untracedWriteCalls`: how many places write something no edge can name (`write-guards.ts`).
 * - `writeHooks`: Prisma `$use` and field-injecting `$extends` calls.
 * - `runtimeDdl`: SQL expression sites that may change schema facts outside the data replay,
 *   including bounded unread-source syntax scans. Absent when those scans cannot complete.
 * - `unknownWriterTables`: sorted, comma-separated physical names of tables something may write
 *   that no edge records: raw statements the index cannot settle, ORM-shaped writes that name a
 *   delegate or table export, and files in no loaded project with a write marker. `''` when
 *   there are none. Absent when it could not be measured, which is when the run has no index (no
 *   names to look for) or the unread files could not be scanned: a list that might be missing
 *   tables is not offered as the list.
 * - `ormIndexAbsent`: the run had no data-model index (absent when it had one).
 */
function describeRepo(
  ctx: Ctx,
  rootId: NodeId,
  repoRoot: string,
  unread: readonly string[] | null,
  diagnostics: string[],
): void {
  const props: Record<string, string | number | boolean> = {
    untracedWriteCalls: ctx.guards.untraced.size,
    writeHooks: ctx.guards.hooks.size,
  };
  if (ctx.bindTable === null) props['ormIndexAbsent'] = true;

  const listed = new Map<string, string>(
    [...ctx.unknownWriterTables].map(([table, w]) => [table, `${w.file}:${w.line} (${w.why})`]),
  );
  let complete = ctx.names !== null;
  let runtimeDdlComplete = unread !== null;
  const unreadSyntax: string[] = [];
  let syntaxProject: Project | undefined;
  if (unread === null) {
    complete = false;
    if (ctx.names !== null)
      diagnostics.push('unknownWriterTables not recorded: the files outside every loaded project could not be listed');
    diagnostics.push('runtimeDdl not recorded: the files outside every loaded project could not be listed');
  } else {
    const names: OrmNames = ctx.names ?? {
      delegates: new Map(), exports: new Map(), exact: new Map(), folded: new Map(),
    };
    const scan: UnreadScan = scanUnreadFiles(repoRoot, unread, names, undefined, (rel, text) => {
      // Syntax only: no real filesystem, imports, libraries or type checker. The
      // file remains outside the graph's authoritative source set.
      syntaxProject ??= new Project({
        useInMemoryFileSystem: true,
        compilerOptions: {
          allowJs: true, noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.ESNext,
        },
      });
      const source = syntaxProject.createSourceFile('/' + rel, text);
      try {
        if (syntaxProject.getProgram().getSyntacticDiagnostics(source).length > 0) {
          runtimeDdlComplete = false;
          unreadSyntax.push(rel);
        } else scanRuntimeDdl(ctx, rel, source);
      } finally {
        // Keep at most one bounded source file in the auxiliary parser.
        syntaxProject.removeSourceFile(source);
      }
    });
    if (scan.failure !== null) {
      complete = false;
      runtimeDdlComplete = false;
      if (ctx.names !== null) diagnostics.push(`unknownWriterTables not recorded: ${scan.failure}`);
      diagnostics.push(`runtimeDdl not recorded: ${scan.failure}`);
    }
    for (const [table, file] of scan.tables) if (!listed.has(table)) listed.set(table, `${file} (unread file)`);
  }
  if (unreadSyntax.length > 0) {
    diagnostics.push(
      `runtimeDdl not recorded: ${unreadSyntax.length} unread source file(s) have syntax errors`,
      ...unreadSyntax.slice(0, MAX_LISTED_SITES).map((file) => `unread source syntax at ${file}`),
    );
  }
  if (complete) props['unknownWriterTables'] = [...listed.keys()].sort().join(',');
  if (runtimeDdlComplete) props['runtimeDdl'] = ctx.guards.runtimeDdl.size;
  ctx.collector.node({ id: rootId, kind: 'Repo', name: ctx.repo, props });

  const runtimeDdl = [...ctx.guards.runtimeDdl.values()].sort(
    (a, b) => compareCodeUnits(a.file, b.file) || a.line - b.line,
  );
  if (runtimeDdl.length > 0) {
    diagnostics.push(
      `${runtimeDdl.length} SQL expression site(s) may change schema facts outside the data replay (runtimeDdl)`,
      ...runtimeDdl.slice(0, MAX_LISTED_SITES).map((s) => `runtime DDL at ${s.file}:${s.line}`),
    );
  }

  const untraced = [...ctx.guards.untraced.values()].sort(
    (a, b) => compareCodeUnits(a.file, b.file) || a.line - b.line || compareCodeUnits(a.rule, b.rule),
  );
  if (untraced.length > 0) {
    diagnostics.push(
      `${untraced.length} write call(s) cannot be attributed to a table (untracedWriteCalls)`,
      ...untraced.slice(0, MAX_LISTED_SITES).map((s) => `untraced write at ${s.file}:${s.line} (${s.rule}, ${s.verb})`),
    );
    if (untraced.length > MAX_LISTED_SITES) diagnostics.push(`... ${untraced.length - MAX_LISTED_SITES} more not listed`);
  }
  if (complete && listed.size > 0) {
    const tables = [...listed].sort((a, b) => compareCodeUnits(a[0], b[0]));
    diagnostics.push(
      `${tables.length} table(s) may be written by something no edge records (unknownWriterTables)`,
      ...tables.slice(0, MAX_LISTED_SITES).map(([table, where]) => `unknown writer of ${table}: ${where}`),
    );
    if (tables.length > MAX_LISTED_SITES) diagnostics.push(`... ${tables.length - MAX_LISTED_SITES} more not listed`);
  }
}

/** A tokenizer resource limit leaves the whole code scope incomplete, even with an index. */
function sqlResourceLimitDiagnostic(ctx: Ctx): string | null {
  const site = ctx.sqlResourceLimit.site;
  return site === null ? null :
    `SQL tokenizer resource limit at ${site.file}:${site.line}: the code scope is UNAVAILABLE, ` +
    'so statements this run could not read are not treated as absent and prior query edges are not swept';
}

/**
 * The diagnostic that makes an index-less run UNAVAILABLE, or `null` when nothing
 * read needs the index. An ORM-shaped write call is named first; a repository with
 * only raw SQL names the first table reference of any statement
 * `sqlTableOccurrences` reads, whether or not an enclosing symbol gives it an edge,
 * so the rule does not depend on how a declaration resolved.
 */
function lostWithoutIndex(sourceFiles: readonly SourceFile[], repoRoot: string, ctx: Ctx): string | null {
  const call = firstOrmShapedWrite(ormFiles(sourceFiles, repoRoot));
  if (call !== null) {
    return (
      `data-model index absent and an ORM-shaped write call at ${call.file}:${call.line} cannot be traced to a table: ` +
      'the code scope is UNAVAILABLE, not PASS, so the ORM queries this run could not emit are not read as absent'
    );
  }
  const sql = ctx.firstRawSql.site;
  if (sql !== null) {
    return (
      `data-model index absent and a raw-SQL table reference at ${sql.file}:${sql.line} cannot be bound to a declared table: ` +
      'the code scope is UNAVAILABLE, not PASS, so the QUERIES edges this run could not bind are not read as absent'
    );
  }
  return null;
}

function ormFiles(sourceFiles: readonly SourceFile[], repoRoot: string): Array<readonly [string, SourceFile]> {
  const out: Array<readonly [string, SourceFile]> = [];
  for (const sf of sourceFiles) {
    const rel = toRepoRelative(repoRoot, sf.getFilePath());
    if (rel !== null) out.push([rel, sf]);
  }
  return out;
}

/** Depth bound on `references` chains, which are a DAG and can be deep. */
const MAX_REFERENCE_DEPTH = 4;

/**
 * Records the directory of a tsconfig that was meant to be read and was not, so
 * the `Repo` node can say so (see `unreadPackageProps`). A config outside the
 * repository is not repository code and is not named.
 */
function nameUnreadProject(repoRoot: string, configPath: string, unreadProjects: string[]): void {
  const dir = nodePath.dirname(configPath);
  const rel = toRepoRelative(repoRoot, dir);
  if (rel !== null) unreadProjects.push(rel);
  else if (nodePath.resolve(dir) === nodePath.resolve(repoRoot)) unreadProjects.push('.');
}

/**
 * Loads `references` into `project`, depth first. `loaded` holds every config
 * loaded so far, which is what stops a cycle or a shared reference from being
 * loaded twice, and each newly loaded config is appended to it.
 */
function addReferencedProjects(
  project: Project,
  tsConfigFilePath: string,
  diagnostics: string[],
  loaded: string[],
  unreadProjects: string[],
  repoRoot: string,
  depth = 0,
): void {
  if (depth >= MAX_REFERENCE_DEPTH) return;
  const resolved = nodePath.resolve(tsConfigFilePath);

  const read = ts.readConfigFile(resolved, (file) => ts.sys.readFile(file));
  const references = (read.config as { references?: ReadonlyArray<{ path?: unknown }> } | undefined)?.references;
  if (references === undefined) return;

  // Sorted so the set of files added does not depend on authoring order.
  const paths = references
    .map((r) => (typeof r.path === 'string' ? r.path : null))
    .filter((r): r is string => r !== null)
    .sort();
  for (const relative of paths) {
    const candidate = nodePath.resolve(nodePath.dirname(resolved), relative);
    const configPath = candidate.endsWith('.json') ? candidate : nodePath.join(candidate, 'tsconfig.json');
    if (loaded.includes(configPath)) continue;
    if (!fs.existsSync(configPath)) {
      diagnostics.push(`referenced project not found: ${toRepoRelative(nodePath.dirname(resolved), configPath) ?? relative}`);
      nameUnreadProject(repoRoot, configPath, unreadProjects);
      continue;
    }
    try {
      project.addSourceFilesFromTsConfig(configPath);
    } catch (error) {
      diagnostics.push(`referenced project could not be loaded: ${messageOf(repoRoot, error)}`);
      nameUnreadProject(repoRoot, configPath, unreadProjects);
      continue;
    }
    loaded.push(configPath);
    addReferencedProjects(project, configPath, diagnostics, loaded, unreadProjects, repoRoot, depth + 1);
  }
}

/**
 * Loads every `tsconfig.json` under the root that the graph so far does not
 * include (an example app, a tools package nothing references), each with its
 * own `include`/`exclude`/`files` and its `references`, the way a referenced
 * project is loaded. Like a referenced project's files, they join the root
 * program and are type-checked under its compiler options: none is invented
 * for them, and their own are not applied. The walk skips `node_modules`,
 * dot-directories, the loaded projects' emit directories, and the run's
 * `exclude`; a config that cannot be loaded is reported and skipped, the rule
 * references already follow.
 */
function addDiscoveredProjects(
  project: Project,
  bounds: Omit<CandidateFileOptions, 'outputDirs'>,
  diagnostics: string[],
  loaded: string[],
  unreadProjects: string[],
): void {
  const { repoRoot } = bounds;
  let configPaths: readonly string[];
  try {
    configPaths = listProjectConfigs({ ...bounds, outputDirs: loadProjects(loaded).flatMap((p) => p.outputDirs) });
  } catch (error) {
    diagnostics.push(`tsconfig discovery could not run: ${messageOf(repoRoot, error)}`);
    return;
  }
  for (const configPath of configPaths) {
    if (loaded.includes(configPath)) continue;
    try {
      project.addSourceFilesFromTsConfig(configPath);
    } catch (error) {
      const rel = toRepoRelative(bounds.repoRoot, configPath) ?? configPath;
      diagnostics.push(`discovered project could not be loaded: ${rel}: ${messageOf(repoRoot, error)}`);
      nameUnreadProject(repoRoot, configPath, unreadProjects);
      continue;
    }
    loaded.push(configPath);
    addReferencedProjects(project, configPath, diagnostics, loaded, unreadProjects, repoRoot);
  }
}

function selectSourceFiles(project: Project, repoRoot: string): readonly SourceFile[] {
  const kept: Array<{ readonly rel: string; readonly sf: SourceFile }> = [];
  for (const sf of project.getSourceFiles()) {
    if (sf.isDeclarationFile()) continue;
    const rel = toRepoRelative(repoRoot, sf.getFilePath());
    if (rel === null) continue;
    if (rel.split('/').includes('node_modules')) continue;
    kept.push({ rel, sf });
  }
  // Filesystem traversal order is not stable across machines; design v3 §2.3.
  kept.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return kept.map((k) => k.sf);
}

/**
 * Confirm the checker actually answers before claiming PASS.
 *
 * A tsconfig can load, resolve files, and still leave the checker unusable
 * (a broken `extends`, a missing `lib`). Returning zero nodes in that state and
 * calling it PASS is exactly the failure mode §2.2 forbids.
 */
function probeTypeChecker(repoRoot: string, project: Project, sourceFiles: readonly SourceFile[]): string | null {
  try {
    project.getTypeChecker();
    const probe = sourceFiles[0];
    if (probe === undefined) return 'no source file to probe';
    probe.getExportedDeclarations();
    return null;
  } catch (error) {
    return messageOf(repoRoot, error);
  }
}

function extensionOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.indexOf('.');
  return dot < 0 ? '' : base.slice(dot);
}

function unavailable(diagnostics: readonly string[], startedAt: number, deterministic: boolean): ExtractCodeTsOutput {
  return envelope('UNAVAILABLE', [], [], diagnostics, startedAt, deterministic);
}

function envelope(
  status: ExtractorStatus,
  nodes: readonly SeamlineNode[],
  edges: readonly SeamlineEdge[],
  diagnostics: readonly string[],
  startedAt: number,
  deterministic: boolean,
  authoritative: readonly AuthoritativeScope[] = CODE_TS_AUTHORITATIVE,
): ExtractCodeTsOutput {
  return {
    result: {
      extractor: EXTRACTOR_NAME,
      version: EXTRACTOR_VERSION,
      status,
      authoritative,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      // Wall-clock is excluded in deterministic mode: it is the only
      // non-reproducible field in the envelope and the gate compares bytes.
      durationMs: deterministic ? 0 : Date.now() - startedAt,
      diagnostics: [...diagnostics],
    },
    nodes,
    edges,
  };
}

/** An error's message with absolute paths removed: ts-morph and TypeScript name files by absolute path. */
function messageOf(repoRoot: string, error: unknown): string {
  return redactPaths(repoRoot, error instanceof Error ? error.message : String(error));
}
