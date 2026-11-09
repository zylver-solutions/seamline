/**
 * The extractor conformance suite.
 *
 * It runs one extractor, as a sandbox program, under the same host `seamline extract` uses, against
 * generated fixture repositories, and turns what the host and the extractor did into one verdict per
 * property (aspirational-state.md 2.5). Nothing here weakens or reimplements a control: the guard,
 * the permission model, the budgets and the provenance gate are the host's. The suite's job is to
 * provoke them on realistic input and to read the outcome as data.
 *
 * What a verdict means is in docs/conformance.md. The short form: `PASS` is "this extractor, on
 * these fixtures, under this host, did not violate the property", and a property the fixtures could
 * not exercise is `UNAVAILABLE`, never `PASS`.
 */

import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, relative, sep } from 'node:path';
import { assertWithinCeiling, type GraphView, type Provenance } from '@seamline/ontology';
import { validateManifest, type HostLimits } from '@seamline/core';
import type { ExtractContext, ExtractorOutput } from '../ports.ts';
import {
  BUILD_ROOT,
  createSandboxHost,
  observationOf,
  type SandboxHost,
  type SandboxObservation,
  type SandboxProgram,
} from '../sandbox/host.ts';
import { buildFixture, CANARIES, FixtureError, type Fixture } from './repos.ts';
import { loadExtractorProgram, WRAPPER_MODULE } from './load.ts';
import {
  OBSERVED_PREFIX,
  WRAPPER_KEY,
  type WrapperConfig,
  type WrapperObservation,
} from './observation.ts';
import {
  BAIT_DIR,
  FIXTURE_KINDS,
  PROPERTY_IDS,
  PROPERTY_TITLES,
  STRESS_DIR,
  SUITE_VERSION,
  type ConformanceOptions,
  type ConformanceReport,
  type FixtureKind,
  type PropertyId,
  type PropertyResult,
  type RunSummary,
  type Verdict,
} from './types.ts';

const READ_CODES = new Set([
  'path-non-posix',
  'path-absolute',
  'path-escape',
  'path-not-declared',
  'symlink-escape',
  'fs-write',
]);
const NET_CODES = new Set(['network', 'exec']);
const CEILING_CODES = new Set(['provenance-ceiling', 'scope-undeclared']);
const DEFAULT_STRESS_MB = 8;
const MAX_EVIDENCE_LINE = 300;

export interface ConformanceRunOptions extends ConformanceOptions {
  /** The limits the manifest is validated against. Default: the sandbox host's defaults. */
  readonly limits?: Partial<HostLimits>;
}

interface Executed {
  readonly kind: FixtureKind;
  /** Set when the suite could not run it at all (the fixture could not be built, the host threw). */
  readonly error?: string;
  readonly output?: ExtractorOutput;
  readonly observation?: SandboxObservation;
  readonly wrapper?: WrapperObservation;
  readonly durationMs: number;
  /** Connections the loopback listener received while this run was going. */
  readonly connections: number;
  /** Canary strings found in the serialized output. */
  readonly leaked: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
  readonly baitFiles: number;
  readonly padded: number;
}

// ---------------------------------------------------------------------------
// The loopback listener the bait points at
// ---------------------------------------------------------------------------

interface Listener {
  readonly origin: string;
  readonly working: boolean;
  connections(): number;
  close(): Promise<void>;
}

async function startListener(): Promise<Listener> {
  let count = 0;
  const server: Server = createServer((socket) => {
    count += 1;
    socket.destroy();
  });
  const port = await new Promise<number | undefined>((settle) => {
    server.once('error', () => settle(undefined));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      settle(typeof address === 'object' && address !== null ? address.port : undefined);
    });
  });
  if (port === undefined) {
    return {
      origin: 'http://127.0.0.1:9',
      working: false,
      connections: () => 0,
      close: async () => undefined,
    };
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    working: true,
    connections: () => count,
    close: () => new Promise<void>((settle) => server.close(() => settle())),
  };
}

// ---------------------------------------------------------------------------
// Running one fixture
// ---------------------------------------------------------------------------

function nested(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('/'));
}

function emitted(output: ExtractorOutput): { nodes: number; edges: number } {
  return {
    nodes: output.nodes.length,
    edges: output.edges.reduce((n, group) => n + group.edges.length, 0),
  };
}

function observedLine(output: ExtractorOutput): WrapperObservation | undefined {
  for (let i = output.result.diagnostics.length - 1; i >= 0; i -= 1) {
    const line = output.result.diagnostics[i] as string;
    if (line.startsWith(OBSERVED_PREFIX)) {
      try {
        return JSON.parse(line.slice(OBSERVED_PREFIX.length)) as WrapperObservation;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function degradeGraph(view: GraphView): GraphView {
  return {
    nodesByKind: (kind) => view.nodesByKind(kind),
    node: (id) => view.node(id),
    edgesFrom: (id, kind) => view.edgesFrom(id, kind),
    edgesTo: (id, kind) => view.edgesTo(id, kind),
    scopeStatus: () => 'UNAVAILABLE',
  };
}

function clip(text: string): string {
  return text.length > MAX_EVIDENCE_LINE ? `${text.slice(0, MAX_EVIDENCE_LINE)}...` : text;
}

function shown(output: ExtractorOutput): string[] {
  return output.result.diagnostics.filter((line) => !line.startsWith(OBSERVED_PREFIX));
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

type Runs = Readonly<Partial<Record<FixtureKind, Executed>>>;

function result(id: PropertyId, verdict: Verdict, evidence: string[]): PropertyResult {
  return { id, title: PROPERTY_TITLES[id], verdict, evidence: evidence.map(clip) };
}

/** Why a glob list yields no padded or bait file, for the evidence line. */
function noFilesBecause(manifest: SandboxProgram['manifest']): string {
  if (manifest.reads.length === 0) return 'it declares no reads';
  if (manifest.reads.every((glob) => glob.startsWith('.git/') || glob === '.git')) {
    return 'its reads are inside .git, which the suite does not fill';
  }
  return 'its globs name fixed files only, or use syntax the suite does not expand; declare a glob with a wildcard in the file name';
}

function violationsOf(run: Executed): ReadonlyArray<string> {
  return run.observation?.violations ?? [];
}

/** The extractor ran to the end and the host accepted what it delivered, whatever status that carried. */
function completed(run: Executed | undefined): run is Executed & {
  output: ExtractorOutput;
  observation: SandboxObservation;
  wrapper: WrapperObservation;
} {
  return (
    run !== undefined &&
    run.error === undefined &&
    run.output !== undefined &&
    run.observation?.ran === true &&
    run.observation.violations.length === 0 &&
    run.wrapper !== undefined
  );
}

function why(run: Executed | undefined): string {
  if (run === undefined) return 'was not run';
  if (run.error !== undefined) return `could not be run: ${run.error}`;
  if (run.output === undefined) return 'produced no output';
  const first = shown(run.output)[0];
  const codes = violationsOf(run);
  return `ended ${run.output.result.status}${codes.length > 0 ? ` with ${codes.map((c) => `[${c}]`).join(' ')}` : ''}${first === undefined ? '' : `: ${first}`}`;
}

function violationEvidence(runs: Executed[], codes: ReadonlySet<string>): string[] {
  const lines: string[] = [];
  for (const run of runs) {
    const hit = violationsOf(run).filter((c) => codes.has(c));
    if (hit.length === 0 || run.output === undefined) continue;
    for (const line of shown(run.output).filter((l) => hit.some((c) => l.startsWith(`[${c}]`)))) {
      lines.push(`${run.kind} fixture: ${line}`);
    }
    if (!shown(run.output).some((l) => hit.some((c) => l.startsWith(`[${c}]`)))) {
      lines.push(`${run.kind} fixture: stopped for ${hit.map((c) => `[${c}]`).join(' ')}`);
    }
  }
  return lines;
}

function evaluate(
  program: SandboxProgram,
  runs: Runs,
  listener: Listener,
  limits: Partial<HostLimits> | undefined,
  graphProvided: boolean,
  notRun: ReadonlyArray<FixtureKind>,
): PropertyResult[] {
  const manifest = program.manifest;
  const executed = Object.values(runs).filter((r): r is Executed => r !== undefined);
  const clean = runs.clean;
  const links = runs.links;
  const bait = runs.bait;
  const viaChild = (program.exec?.length ?? 0) > 0;
  const stress = runs.stress;
  const unreadable = runs.unreadable;
  const out: PropertyResult[] = [];

  // manifest
  try {
    validateManifest(manifest, limits);
    out.push(
      result('manifest', 'PASS', [
        `${manifest.name}@${manifest.version}: reads ${manifest.reads.length === 0 ? 'nothing' : manifest.reads.join(', ')}; net false; memMb ${manifest.memMb}; timeoutS ${manifest.timeoutS}; provenance ceiling ${manifest.provenanceCeiling}; produces ${manifest.produces.map((p) => p.scope).join(', ') || 'no scope'}`,
      ]),
    );
  } catch (e) {
    out.push(result('manifest', 'FAIL', [(e as Error).message]));
  }

  // exercised
  {
    const evidence: string[] = [];
    let verdict: Verdict;
    if (!completed(clean)) {
      const codes = clean === undefined ? [] : violationsOf(clean);
      // Stopped by the host on a clean fixture: it did not do its job, and the property it broke is
      // reported under its own name below. Not run, or ended on an error of its own: not assessed.
      verdict = codes.length > 0 ? 'FAIL' : 'UNAVAILABLE';
      evidence.push(`the clean fixture ${why(clean)}`);
      if (codes.length === 0) {
        evidence.push(
          'supply --seed with input the extractor extracts from, and --options if it needs them',
        );
      }
    } else {
      const count = emitted(clean.output);
      const status = clean.output.result.status;
      const opened = clean.wrapper.opened;
      evidence.push(
        `clean fixture (${clean.facts.join('; ')}): ${status}, ${count.nodes} node(s), ${count.edges} edge(s), ${opened} repository file(s) opened, ${clean.durationMs} ms`,
      );
      if (status !== 'PASS') {
        verdict = 'UNAVAILABLE';
        evidence.push(
          `it reported ${status} on a clean fixture: ${shown(clean.output)[0] ?? 'no diagnostic'}; supply --seed with input it can extract from`,
        );
      } else if (count.nodes + count.edges === 0) {
        verdict = 'UNAVAILABLE';
        evidence.push(
          'it emitted nothing, so the controls on what it emits were not exercised; supply --seed with input it extracts from',
        );
      } else if (manifest.reads.length > 0 && opened === 0 && !viaChild) {
        verdict = 'UNAVAILABLE';
        evidence.push('it opened no repository file, so nothing shows what it reads');
      } else {
        verdict = 'PASS';
      }
    }
    out.push(result('exercised', verdict, evidence));
  }

  // reads-confined
  {
    const evidence: string[] = [];
    // A run the host stopped for looking at a link that leads out of the repo, and for nothing else,
    // asked for no content it may not have: it failed closed, which is what the host is for.
    const closed = executed.filter(
      (r) => r.observation?.probeOnly === true && violationsOf(r).some((c) => READ_CODES.has(c)),
    );
    const hits = violationEvidence(
      executed.filter((r) => !closed.includes(r)),
      READ_CODES,
    );
    const leaked = executed.filter((r) => r.leaked.length > 0);
    const undeclared = executed.filter((r) => (r.wrapper?.undeclared.length ?? 0) > 0);
    let verdict: Verdict;
    if (hits.length > 0 || leaked.length > 0 || undeclared.length > 0) {
      verdict = 'FAIL';
      evidence.push(...hits);
      for (const r of leaked) {
        evidence.push(
          `${r.kind} fixture: the output contains canary content from a file it may not read (${r.leaked.join(', ')})`,
        );
      }
      for (const r of undeclared) {
        evidence.push(
          `${r.kind} fixture: opened ${(r.wrapper?.undeclared ?? []).join(', ')}, which no declared glob admits`,
        );
      }
    } else if (!completed(bait)) {
      verdict = 'UNAVAILABLE';
      evidence.push(`the bait fixture ${why(bait)}`);
    } else if (links === undefined || (!completed(links) && !closed.includes(links))) {
      verdict = 'UNAVAILABLE';
      evidence.push(`the links fixture ${why(links)}`);
    } else if (links.skipped.length > 0) {
      verdict = 'UNAVAILABLE';
      evidence.push(`symlinks could not be built here: ${links.skipped.join('; ')}`);
    } else if (manifest.reads.length > 0 && !viaChild && bait.wrapper.opened === 0) {
      verdict = 'UNAVAILABLE';
      evidence.push(
        'it opened no repository file on the bait fixture, so nothing shows what it reads',
      );
    } else {
      verdict = 'PASS';
      evidence.push(`links fixture: ${links.facts.join('; ')}`);
      evidence.push(
        closed.includes(links)
          ? 'it looked at a symlink that leads outside the repo, and the host stopped the run (fail closed); it read no content outside its globs, which is what this property asks, but it cannot finish on a repository that holds such a link'
          : 'it followed no symlink out of the repo or to an undeclared file',
      );
      evidence.push(
        viaChild
          ? 'it reads through a granted child process (git), which the in-process guards do not see; this covers the files it opens itself'
          : `bait fixture: it opened ${bait.wrapper.opened} repository file(s), none outside its declared globs, and no output holds canary content`,
      );
      // The host lets an extractor look at any path inside the repo, so this cannot fail the run;
      // it is printed because "reads only what its globs admit" is about content, not about names.
      const seen = bait.wrapper;
      if (seen.looked > 0) {
        const names = `${seen.lookedAt.join(', ')}${seen.looked > seen.lookedAt.length ? ', ...' : ''}`;
        evidence.push(
          `bait fixture: it looked at ${seen.looked} in-repo path(s) that no declared glob admits (${names}) and listed ${seen.listed} director(ies); the host allows a look at a path inside the repo, so the names, sizes and times of files no glob admits are not checked`,
        );
      }
    }
    out.push(result('reads-confined', verdict, evidence));
  }

  // no-network
  {
    const evidence: string[] = [];
    const hits = violationEvidence(executed, NET_CODES);
    const connections = executed.reduce((n, r) => n + r.connections, 0);
    let verdict: Verdict;
    if (hits.length > 0 || connections > 0) {
      verdict = 'FAIL';
      evidence.push(...hits);
      if (connections > 0) {
        evidence.push(
          `the loopback listener at ${listener.origin} received ${connections} connection(s)`,
        );
      }
    } else if (!completed(bait)) {
      verdict = 'UNAVAILABLE';
      evidence.push(`the bait fixture ${why(bait)}`);
    } else if (bait.baitFiles === 0) {
      verdict = 'UNAVAILABLE';
      evidence.push(
        `no bait file could be generated from the declared globs (${noFilesBecause(manifest)}), so nothing offered it an address to connect to`,
      );
    } else if (!viaChild && bait.wrapper.baitOpened === 0) {
      verdict = 'UNAVAILABLE';
      evidence.push(
        `it opened none of the ${bait.baitFiles} bait file(s) the bait fixture put under ${BAIT_DIR}/ (an extractor that finds its input from its own configuration needs a --seed whose configuration includes that directory), so nothing offered it an address to connect to`,
      );
    } else {
      verdict = 'PASS';
      evidence.push(
        `no network, DNS, fetch, socket or child-process attempt in ${executed.length} run(s); ${viaChild ? `${bait.baitFiles} bait file(s) held` : `it opened ${bait.wrapper.baitOpened} of the ${bait.baitFiles} bait file(s), which held`} ${listener.origin}, ${
          listener.working
            ? 'a loopback listener received 0 connections'
            : 'no loopback listener could be started here'
        }`,
      );
    }
    out.push(result('no-network', verdict, evidence));
  }

  // provenance-ceiling
  {
    const evidence: string[] = [];
    const hits = violationEvidence(executed, CEILING_CODES);
    let verdict: Verdict;
    if (hits.length > 0) {
      verdict = 'FAIL';
      evidence.push(...hits);
    } else if (!completed(clean) || clean.output.result.status !== 'PASS') {
      verdict = 'UNAVAILABLE';
      evidence.push(`the clean fixture ${why(clean)}`);
    } else {
      const count = emitted(clean.output);
      if (count.nodes + count.edges === 0) {
        verdict = 'UNAVAILABLE';
        evidence.push(
          'it emitted no node or edge, so the ceiling was not exercised; supply --seed',
        );
      } else {
        const seen = new Map<Provenance, number>();
        for (const item of [...clean.output.nodes, ...clean.output.edges.flatMap((g) => g.edges)]) {
          seen.set(item.provenance, (seen.get(item.provenance) ?? 0) + 1);
        }
        try {
          for (const p of seen.keys()) assertWithinCeiling(manifest, p);
          verdict = 'PASS';
          evidence.push(
            `${count.nodes} node(s) and ${count.edges} edge(s), provenance ${[...seen].map(([p, n]) => `${p} x${n}`).join(', ')}, against a ceiling of ${manifest.provenanceCeiling}; every scope claimed is one the manifest produces`,
          );
        } catch (e) {
          verdict = 'FAIL';
          evidence.push((e as Error).message);
        }
      }
    }
    out.push(result('provenance-ceiling', verdict, evidence));
  }

  // memory-ceiling
  {
    const evidence: string[] = [];
    const hits = violationEvidence(executed, new Set(['memory']));
    let verdict: Verdict;
    if (hits.length > 0) {
      verdict = 'FAIL';
      evidence.push(...hits);
    } else if (!completed(stress)) {
      verdict = 'UNAVAILABLE';
      evidence.push(`the stress fixture ${why(stress)}`);
    } else if (stress.padded === 0) {
      verdict = 'UNAVAILABLE';
      evidence.push(
        `no stress file could be generated from the declared globs (${noFilesBecause(manifest)}), so its memory under load was not exercised`,
      );
    } else if (!viaChild && stress.wrapper.stressOpened === 0) {
      verdict = 'UNAVAILABLE';
      evidence.push(
        `it opened none of the ${stress.padded} padded file(s) the stress fixture put under ${STRESS_DIR}/ (an extractor that finds its input from its own configuration needs a --seed whose configuration includes that directory), so its memory under load was not exercised`,
      );
    } else {
      verdict = 'PASS';
      evidence.push(
        `stress fixture (${stress.facts.join('; ')}): ${viaChild ? '' : `it opened ${stress.wrapper.stressOpened} of the ${stress.padded} padded file(s); `}finished in ${stress.durationMs} ms under a ceiling of ${manifest.memMb} MiB (the host also allows 256 MiB for the runtime)`,
      );
    }
    out.push(result('memory-ceiling', verdict, evidence));
  }

  // time-budget
  {
    const evidence: string[] = [];
    const hits = violationEvidence(executed, new Set(['timeout']));
    let verdict: Verdict;
    if (hits.length > 0) {
      verdict = 'FAIL';
      evidence.push(...hits);
      if (notRun.length > 0) {
        evidence.push(
          `the ${notRun.join(', ')} fixture(s) were not run after it was killed at its budget, so a hung extractor costs one budget, not five`,
        );
      }
    } else if (!completed(clean) && !completed(stress)) {
      verdict = 'UNAVAILABLE';
      evidence.push(`no run finished: the clean fixture ${why(clean)}`);
    } else {
      verdict = 'PASS';
      const longest = Math.max(...executed.filter((r) => completed(r)).map((r) => r.durationMs));
      evidence.push(
        `every run that started finished; the longest took ${longest} ms against a budget of ${manifest.timeoutS * 1000} ms`,
      );
    }
    out.push(result('time-budget', verdict, evidence));
  }

  // unavailable-not-pass
  {
    const evidence: string[] = [];
    let verdict: Verdict;
    const readsGraph = program.graphScopes !== undefined;
    if (manifest.reads.length === 0 && !readsGraph) {
      verdict = 'NOT_APPLICABLE';
      evidence.push('it declares no reads and reads no graph, so there is no input it could lose');
    } else if (readsGraph && !graphProvided) {
      verdict = 'UNAVAILABLE';
      evidence.push("the program reads the run's graph and none was supplied");
    } else if (!completed(clean) || clean.output.result.status !== 'PASS') {
      verdict = 'UNAVAILABLE';
      evidence.push(
        `there is no passing clean run to contrast with: the clean fixture ${why(clean)}`,
      );
    } else if (
      unreadable === undefined ||
      unreadable.error !== undefined ||
      unreadable.output === undefined
    ) {
      verdict = 'UNAVAILABLE';
      evidence.push(`the unreadable fixture ${why(unreadable)}`);
    } else if (unreadable.observation?.ran !== true) {
      verdict = 'UNAVAILABLE';
      evidence.push(`the unreadable fixture ${why(unreadable)}`);
    } else {
      const status = unreadable.output.result.status;
      const faults = unreadable.wrapper?.faultsHit ?? 0;
      // A run that ended in an error takes the wrapper's tally with it: say that, not "0 opens".
      const how = readsGraph
        ? 'the graph it reads reported every scope UNAVAILABLE'
        : unreadable.wrapper === undefined
          ? 'every open of a repository file was made to fail with EACCES, and the run stopped with an error before the count could be read'
          : `${faults} open(s) of repository files failed with EACCES`;
      if (status !== 'PASS') {
        verdict = 'PASS';
        evidence.push(
          `${how}; it reported ${status}${shown(unreadable.output)[0] === undefined ? '' : `: ${shown(unreadable.output)[0]}`}`,
        );
      } else if (!readsGraph && faults === 0) {
        verdict = 'UNAVAILABLE';
        evidence.push(
          'it reported PASS but never tried to open a repository file, so its input was not lost',
        );
      } else {
        verdict = 'FAIL';
        evidence.push(`${how}, and it still reported PASS`);
      }
    }
    out.push(result('unavailable-not-pass', verdict, evidence));
  }

  return out;
}

function overall(properties: ReadonlyArray<PropertyResult>): ConformanceReport['verdict'] {
  if (properties.some((p) => p.verdict === 'FAIL')) return 'FAIL';
  if (properties.some((p) => p.verdict === 'UNAVAILABLE')) return 'UNAVAILABLE';
  return 'PASS';
}

function summarize(run: Executed): RunSummary {
  const count = run.output === undefined ? { nodes: 0, edges: 0 } : emitted(run.output);
  return {
    fixture: run.kind,
    status: run.output?.result.status ?? 'UNAVAILABLE',
    ran: run.observation?.ran === true,
    violations: violationsOf(run),
    nodes: count.nodes,
    edges: count.edges,
    durationMs: run.durationMs,
    diagnostics:
      run.output === undefined
        ? run.error === undefined
          ? []
          : [clip(run.error)]
        : shown(run.output).slice(0, 5).map(clip),
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Runs the suite over `program`. The program is run under the sandbox host, never in this process.
 *
 * `program` is a `SandboxProgram` so the bundled extractors, which need grants a manifest cannot ask
 * for (`git`, the run's graph), can be put through the same suite as a third-party module; use
 * `conformanceOfModule` for a module on disk.
 */
export async function runConformance(
  program: SandboxProgram,
  options: ConformanceRunOptions = {},
): Promise<ConformanceReport> {
  const host: SandboxHost =
    options.host ??
    createSandboxHost({
      env: options.env ?? process.env,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  const workDir = options.workDir ?? tmpdir();
  const stressBytes = Math.max(0, options.stressMb ?? DEFAULT_STRESS_MB) * 1024 * 1024;
  const wrapped: SandboxProgram = {
    ...program,
    module: WRAPPER_MODULE,
    codeRoots: [...(program.codeRoots ?? []), dirname(program.module)],
  };
  const codeDirs = [BUILD_ROOT, ...(wrapped.codeRoots ?? [])];
  const listener = await startListener();

  async function execute(kind: FixtureKind): Promise<Executed> {
    let fixture: Fixture;
    try {
      fixture = buildFixture(kind, {
        manifest: program.manifest,
        exec: program.exec ?? [],
        seed: options.seed,
        workDir,
        baitOrigin: listener.origin,
        stressBytes,
      });
    } catch (e) {
      const message =
        e instanceof FixtureError
          ? e.message
          : `could not build the fixture: ${(e as Error).message}`;
      return empty(kind, message);
    }
    try {
      const overlap = codeDirs.find(
        (dir) => nested(dir, fixture.root) || nested(fixture.root, dir),
      );
      if (overlap !== undefined) {
        return empty(
          kind,
          `the fixture directory ${fixture.root} overlaps the extractor's code at ${overlap}, which the sandbox lets it read without a glob; run from another directory or set TMPDIR`,
        );
      }
      const config: WrapperConfig = {
        target: program.module,
        reads: program.manifest.reads,
        unreadable: kind === 'unreadable',
      };
      const view =
        options.graph === undefined
          ? undefined
          : kind === 'unreadable'
            ? degradeGraph(options.graph)
            : options.graph;
      const ctx: ExtractContext = {
        repoRoot: fixture.repo,
        repo: 'conformance',
        runId: 'conformance-run',
        outDir: fixture.out,
        include: ['**/*'],
        exclude: ['node_modules/**', 'dist/**'],
        options: { ...(options.options ?? {}), [WRAPPER_KEY]: config },
        deterministic: true,
        ...(view === undefined ? {} : { view }),
      };
      const before = listener.connections();
      const started = Date.now();
      let output: ExtractorOutput;
      try {
        output = await host.run(wrapped, ctx);
      } catch (e) {
        return empty(kind, `the sandbox host threw: ${(e as Error).message}`);
      }
      const durationMs = Date.now() - started;
      const serialized = JSON.stringify(output);
      return {
        kind,
        output,
        ...(observationOf(output) === undefined ? {} : { observation: observationOf(output) }),
        ...(observedLine(output) === undefined ? {} : { wrapper: observedLine(output) }),
        durationMs,
        connections: listener.connections() - before,
        leaked: CANARIES.filter((c) => serialized.includes(c)),
        facts: fixture.facts,
        skipped: fixture.skipped,
        baitFiles: fixture.baitFiles,
        padded: fixture.padded,
      } as Executed;
    } finally {
      fixture.dispose();
    }
  }

  const empty = (kind: FixtureKind, error: string): Executed => ({
    kind,
    error,
    durationMs: 0,
    connections: 0,
    leaked: [],
    facts: [],
    skipped: [],
    baitFiles: 0,
    padded: 0,
  });

  try {
    const runs: Partial<Record<FixtureKind, Executed>> = {};
    const notRun: FixtureKind[] = [];
    let killed = false;
    // The stress run goes last: it is the slow one. A run the host killed at the extractor's time
    // budget ends the suite: the verdicts that need the other fixtures are already FAIL or
    // UNAVAILABLE, and running them would cost the budget again each time.
    for (const kind of FIXTURE_KINDS) {
      if (options.fixtures !== undefined && !options.fixtures.includes(kind)) continue;
      if (killed) {
        notRun.push(kind);
        continue;
      }
      const executedRun = await execute(kind);
      runs[kind] = executedRun;
      if (violationsOf(executedRun).includes('timeout')) killed = true;
    }
    const properties = evaluate(
      program,
      runs,
      listener,
      options.limits,
      options.graph !== undefined,
      notRun,
    );
    return {
      suite: SUITE_VERSION,
      extractor: { name: program.manifest.name, version: program.manifest.version },
      verdict: overall(properties),
      properties,
      runs: Object.values(runs).map(summarize),
    };
  } finally {
    await listener.close();
  }
}

/** Loads the extractor module at `modulePath` (relative to `cwd`) and runs the suite over it. */
export async function conformanceOfModule(
  modulePath: string,
  cwd: string,
  options: ConformanceRunOptions = {},
): Promise<ConformanceReport> {
  const loaded = await loadExtractorProgram(modulePath, cwd);
  if (!loaded.ok) return loadFailureReport(loaded.message);
  return runConformance(loaded.program, options);
}

/** The report for a module that could not be loaded: `manifest` fails, and nothing else could be assessed. */
export function loadFailureReport(message: string): ConformanceReport {
  const properties = PROPERTY_IDS.map((id) =>
    id === 'manifest'
      ? result(id, 'FAIL', [message])
      : result(id, 'UNAVAILABLE', ['not assessed: the extractor module could not be loaded']),
  );
  return { suite: SUITE_VERSION, extractor: null, verdict: 'FAIL', properties, runs: [] };
}
