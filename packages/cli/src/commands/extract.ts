/**
 * `seamline extract` — run the configured extractors, merge, persist.
 *
 * The status line is the point of this command's output. v3 §2.2: UNAVAILABLE
 * is never PASS, and a user who cannot see that a scope is missing will read a
 * partial graph as a complete one. Every configured extractor gets a line,
 * including one that is configured but has no implementation wired in — that
 * is UNAVAILABLE, not silence.
 */

import path from 'node:path';
import type {
  AuthoritativeScope,
  ExtractorResult,
  NodeId,
  SeamlineEdge,
  SeamlineNode,
} from '@seamline/ontology';
import { assertAuthoritySelectors, EMPTY_STATE, isCanonicalSelectorText, mergeStates, stateFromBatch, type MergeState } from '@seamline/core';
import { createRedactor, printable, type RedactionFinding } from '@seamline/security';
import { parseCommandArgs, STORE_OPTION_SPEC } from '../args.ts';
import { styleFor } from '../colour.ts';
import { loadConfig, type ExtractorConfig } from '../config.ts';
import { CliError, EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME, notWiredError } from '../io.ts';
import type { CliDeps, ExtractContext, ExtractorPort, Snapshot } from '../ports.ts';
import { emitJson, emitText, emitTextErr, paintStatus } from '../render.ts';
import { digestRunInputs, type ExtractorInput } from '../run-inputs.ts';
import { resolveStoreDir } from '../store-dir.ts';
import { firstPartyScopes } from '../sandbox/first-party.ts';
import { scopeAwareView, type TaggedAmbiguity } from '../wiring.ts';

/**
 * `extractorPriority` for the precedence order (v3 §2.4: provenance, then
 * extractor priority, then run), which decides the stored body when two
 * extractors emit the same node id in one run. Higher wins.
 *
 * The built-in extractors share ids in exactly two places, and both resolve to
 * `extract-code-ts`, which asserts the node's full body from the type checker:
 *
 * - `File`: `extract-change` emits it only as a `TOUCHES`/`RENAMED_FROM`
 *   endpoint (basename, no props) and declares no authority over the kind.
 * - `RouteHandler`: `extract-contracts` emits it as the `IMPLEMENTED_BY`
 *   endpoint, keyed like `extract-code-ts`'s node so the two joins meet; the
 *   code-side body is the one that locates where the route is served.
 *
 * An extractor not listed here ranks below every listed one.
 */
const EXTRACTOR_PRIORITY: ReadonlyMap<string, number> = new Map([
  ['extract-code-ts', 4],
  ['extract-data', 3],
  ['extract-contracts', 2],
  ['extract-change', 1],
]);

/**
 * Extractors that publish the data-model index (`ExtractorOutput.dataModelIndex`)
 * for the ones after them, and so run before every other extractor whatever
 * order the config lists them in. They are reported in the configured order all
 * the same: the order is a scheduling fact, not part of the output.
 */
const RUNS_FIRST: ReadonlySet<string> = new Set(['extract-data']);

function executionOrder(planned: readonly ExtractorConfig[]): ExtractorConfig[] {
  return [
    ...planned.filter((e) => RUNS_FIRST.has(e.name)),
    ...planned.filter((e) => !RUNS_FIRST.has(e.name)),
  ];
}

interface NodeFold {
  readonly state: MergeState;
  /** Bodies the store must receive so that it holds each id's current winner. */
  readonly writes: readonly SeamlineNode[];
}

/**
 * Fold one extractor's nodes into this run's merged state (`mergeStates`).
 *
 * The store keeps one row per node id and its upsert replaces the row, so the
 * store holds each id's winner only if a body is written exactly when it
 * becomes the winner. That makes the stored graph independent of the order the
 * extractors run in.
 *
 * The fold carries nodes only. An edge is keyed by the scope it is written
 * under, and each built-in extractor writes under its own scope, so edges do
 * not collide across extractors; scope status is recorded by `finalizeRun`.
 * The batch `scope` below only satisfies `stateFromBatch`.
 */
function foldNodes(
  state: MergeState,
  runId: string,
  repo: string,
  extractor: string,
  result: ExtractorResult,
  nodes: readonly SeamlineNode[],
): NodeFold {
  if (result.status !== 'PASS') {
    // `stateFromBatch` takes no facts from a batch that did not pass (v3 §2.2),
    // so such a batch can never outrank a passing one. Its nodes are still
    // stored, but only for ids no passing extractor has asserted in this run.
    return { state, writes: nodes.filter((n) => !state.nodes.has(n.id)) };
  }
  const next = mergeStates(
    state,
    stateFromBatch({
      runId,
      repo,
      extractor,
      extractorPriority: EXTRACTOR_PRIORITY.get(extractor) ?? 0,
      status: result.status,
      scope: extractor,
      authoritative: result.authoritative,
      nodes,
      edges: [],
    }),
  );
  const writes: SeamlineNode[] = [];
  const seen = new Set<NodeId>();
  for (const { id } of nodes) {
    if (seen.has(id)) continue;
    seen.add(id);
    const winner = next.nodes.get(id);
    if (winner !== undefined && winner.source.extractor === extractor) writes.push(winner.node);
  }
  return { state: next, writes };
}

export interface ExtractReport {
  readonly runId: string;
  readonly repo: string;
  readonly startedAt: string;
  readonly results: readonly ExtractorResult[];
  readonly totals: { readonly nodes: number; readonly edges: number };
  /** Scopes whose producing extractor did not PASS. Queries over these return UNKNOWN. */
  readonly degradedScopes: readonly string[];
  /**
   * `infer-join`'s ambiguity records: joins split across a tie, sources dropped
   * for too many equal candidates, and contended targets, each with its
   * candidates. A dropped join emits no edge, so this is the only place it is
   * visible for review. Empty when `infer-join` did not run. Every node id
   * here was read back from the store, which only ever holds redacted ids, so
   * this adds no path around redaction.
   */
  readonly ambiguities: readonly TaggedAmbiguity[];
  /**
   * What the redactor replaced before anything was stored, and by which rule.
   * The reference that replaces a value (`«redacted:sha256:...»`) does not
   * carry the rule, so this is where a false positive is diagnosed without
   * re-running an extractor. It lists where each replacement sits (`target`,
   * `field`) and how long the replaced text was; never the text itself. A record
   * the redactor refused instead of rewriting (a credential in an id or a path)
   * is not here: it appears as that extractor's FAIL diagnostic.
   */
  readonly redactions: ExtractRedactions;
}

export interface ExtractRedactions {
  readonly total: number;
  readonly byRule: ReadonlyArray<{ readonly rule: string; readonly count: number }>;
  readonly findings: ReadonlyArray<RedactionFinding>;
}

export async function extractCommand(deps: CliDeps, argv: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    ...STORE_OPTION_SPEC,
    only: { type: 'string', multiple: true },
  });
  const style = styleFor(deps.io, {
    noColorFlag: parsed.globals.noColor,
    json: parsed.globals.json,
  });

  const repoRoot = path.resolve(deps.io.cwd, parsed.globals.repo ?? '.');
  const config = await loadConfig(repoRoot);
  const outDir = resolveStoreDir('extract', repoRoot, config, parsed);

  if (deps.store === undefined) throw notWiredError('store', 'extract');

  const only = Array.isArray(parsed.values['only']) ? (parsed.values['only'] as string[]) : [];
  const registry = new Map<string, ExtractorPort>((deps.extractors ?? []).map((e) => [e.name, e]));

  const planned = config.extractors
    .filter((e) => e.enabled)
    .filter((e) => only.length === 0 || only.includes(e.name));

  if (planned.length === 0) {
    const known = config.extractors.map((e) => e.name).join(', ');
    emitTextErr(deps.io, style, `no extractor selected. Configured: ${printable(known) || '(none)'}\n`);
    return EXIT_FINDINGS;
  }

  const workspace = await deps.store.open({ repoRoot, outDir, repo: config.repo, create: true, now: () => deps.clock.now() });
  // Under SEAMLINE_DETERMINISTIC=1 the clock derives the id from this digest
  // (run-id.ts); otherwise it never calls it and the tree is not read.
  const runId = deps.clock.runId(() =>
    digestRunInputs({
      repo: config.repo,
      repoRoot,
      outDir,
      include: config.include,
      exclude: config.exclude,
      extractors: planned.map((spec) => extractorInput(spec, registry, repoRoot)),
    }),
  );
  const startedAt = deps.clock.now();
  const deterministic = deps.io.env['SEAMLINE_DETERMINISTIC'] === '1';

  const results: ExtractorResult[] = [];
  // Each id's stored body, so the snapshot matches the store one line per id.
  const storedNodes = new Map<NodeId, SeamlineNode>();
  const allEdges: SeamlineEdge[] = [];
  let merged: MergeState = EMPTY_STATE;
  const ambiguities: TaggedAmbiguity[] = [];
  // The index handed on to the extractors after a publisher. A PASS publishes its index (the most
  // recent PASS wins). With no PASS, a publisher that found no schema source publishes the empty
  // index, unless some publisher could not look: the empty index says "nothing exists", and a
  // publisher that could not read a source, failed or crashed contradicts it, whichever ran first.
  let passedIndex: string | undefined;
  let emptyIndex: string | undefined;
  let publisherBlind = false;
  const dataModelIndex = (): string | undefined =>
    passedIndex ?? (publisherBlind ? undefined : emptyIndex);
  // Where each result's extractor sat in the configured list, to report in that order.
  const reportedAt = new Map<ExtractorResult, number>();

  // ADR-0011: `workspace.store` already redacts everything it persists (it is
  // `wrapWithRedaction(rawStore)`, never the raw store -- see `wiring.ts`).
  // But the SIF snapshot below is a second, independent export path that does
  // not go through the store at all, so it needs its own redaction, and it
  // must be the *same* redaction the store write used, so a value redacted
  // for one destination is redacted identically for the other. One redactor,
  // applied here, before either destination sees the output. Re-redacting
  // an already-clean value inside the store's wrapper is
  // a documented no-op (`redactor.ts`'s idempotence guarantee), so this is
  // belt-and-suspenders for the store, not a behaviour change for it.
  const redactor = createRedactor();

  try {
    const run = { runId, repo: config.repo, commit: null, startedAt, ontologyVersion: '1.0.0' };
    // A fresh run id is new to the store. A deterministic one is derived from the
    // run's inputs, so one the store already holds is the same run again: running
    // the same tree twice, retrying a run that was cut short, or coming back to an
    // earlier tree after a different one. Re-open it rather than refuse it. The run
    // then becomes the newest (which is what `runs.latest()` and the scope status
    // follow). The same inputs usually yield the same facts, so its writes re-stamp
    // what it already stored: nothing is buried, nothing is duplicated. When they do
    // not (an input the id cannot see, such as installed dependencies), `restartRun`
    // buries what this attempt no longer produces inside its PASS scopes.
    if (workspace.restartRun !== undefined && (await workspace.runs.get(runId)) !== undefined) {
      await workspace.restartRun(run);
    } else {
      await workspace.store.beginRun(run);
    }

    for (const spec of executionOrder(planned)) {
      const record = (result: ExtractorResult): void => {
        // Non-PASS coverage must suppress an older PASS without retaining an
        // unsafe selector. Do this after every declared-scope fallback is added.
        const safe = result.status === 'PASS' ? result : { ...result,
          authoritative: result.authoritative.map(({ scope, kinds }) => ({ scope, kinds: [...kinds] })),
        };
        results.push(safe);
        reportedAt.set(safe, planned.indexOf(spec));
      };
      const impl = registry.get(spec.name);
      if (impl === undefined) {
        record(
          unavailable(
            spec.name,
            'no implementation registered for this extractor in this build',
            firstPartyScopes(spec.name),
          ),
        );
        continue;
      }
      const heldIndex = dataModelIndex();
      // The scopes a failure of this extractor must declare. A port that does not say falls back to
      // the bundled manifest of the same name, as an unwired extractor does, so an embedder's port
      // that omits `produces` cannot leave an earlier PASS standing when it throws.
      const declared = impl.produces ?? firstPartyScopes(impl.name);
      const ctx: ExtractContext = {
        repoRoot,
        repo: config.repo,
        runId,
        outDir,
        include: config.include,
        exclude: config.exclude,
        options: spec.options,
        deterministic,
        ...(heldIndex === undefined ? {} : { dataModelIndex: heldIndex }),
        // The facts earlier extractors produced, with this run's own statuses applied (see
        // `scopeAwareView`). Only an extractor that infers over them, `infer-join`, reads it.
        view: scopeAwareView(workspace.store, results),
      };
      // Exactly one result per extractor reaches `finalizeRun`, and it is recorded only once the
      // extractor's output is in the store. The store keys a result on (run, extractor), so a PASS
      // pushed before a store or redactor rejection and a FAIL pushed after it would not replace
      // each other: they would make `finalizeRun` throw and roll the whole run back, leaving every
      // earlier run's PASS standing for every scope.
      let result: ExtractorResult | undefined;
      try {
        const output = await impl.extract(ctx);
        result = withDeclaredScopes(output.result, declared);
        assertAuthoritySelectors(result.authoritative);
        for (const claim of result.authoritative) {
          if (claim.selector !== undefined && !isCanonicalSelectorText(claim.selector))
            redactor.guardStructural(claim.selector, 'authority.selector', 'extractor authority');
        }
        if (output.nodes.length > 0) {
          const { nodes: redactedNodes } = redactor.redactGraph(output.nodes, []);
          const fold = foldNodes(merged, runId, config.repo, impl.name, result, redactedNodes);
          if (fold.writes.length > 0) await workspace.store.upsertNodes(runId, fold.writes);
          merged = fold.state;
          for (const node of fold.writes) storedNodes.set(node.id, node);
        }
        for (const group of output.edges) {
          if (group.edges.length === 0) continue;
          const { edges: redactedEdges } = redactor.redactGraph([], group.edges);
          await workspace.store.upsertEdges(runId, group.scope, redactedEdges);
          allEdges.push(...redactedEdges);
        }
        // Recorded last: a write or a redaction above that throws must leave exactly one
        // result for this extractor (the one in the `catch`), because `extractor_results`
        // is keyed by (run, extractor). The index is taken only now: a batch the redactor or
        // the store refused publishes nothing.
        if (RUNS_FIRST.has(impl.name)) {
          if (result.status === 'PASS') {
            if (output.dataModelIndex !== undefined) passedIndex = output.dataModelIndex;
          } else if (
            result.status === 'UNAVAILABLE' &&
            output.noSchemaSource === true &&
            output.dataModelIndex !== undefined
          ) {
            // Discovery found no schema source it reads: the empty index is true of what it
            // looked at. The first one stands, and it never replaces the index of a PASS.
            emptyIndex ??= output.dataModelIndex;
          } else {
            // A source it could not read, a FAIL: this publisher did not see the schema.
            publisherBlind = true;
          }
        }
        if (output.ambiguities !== undefined) ambiguities.push(...output.ambiguities);
        record(result);
      } catch (e) {
        if (RUNS_FIRST.has(impl.name)) publisherBlind = true;
        // A rejected output retains its reported and declared scope coverage
        // (ADR-0013). `record` removes selectors after the fallback is added.
        const reason = redactor.redactString(e instanceof Error ? e.message : String(e));
        record(
          result !== undefined
            ? withDeclaredScopes(refused(result, reason), declared)
            : failed(impl.name, impl.version, reason, declared),
        );
      }
    }

    results.sort((a, b) => (reportedAt.get(a) ?? 0) - (reportedAt.get(b) ?? 0));
    await workspace.store.finalizeRun(runId, results);

    if (deps.snapshots !== undefined) {
      const finalized = await workspace.runs.get(runId);
      if (finalized === undefined || finalized.finishedAt === null)
        throw new CliError('finalized run metadata is unavailable for the SIF snapshot', EXIT_RUNTIME);
      redactor.guardStructural(finalized.repo, 'run.repo', 'SIF run');
      redactor.guardStructural(finalized.runId, 'run.runId', 'SIF run');
      if (finalized.commit !== null) redactor.guardStructural(finalized.commit, 'run.commit', 'SIF run');
      const snapshot: Snapshot = {
        runId,
        run: finalized,
        nodes: [...storedNodes.values()],
        edges: allEdges,
        results: finalized.results,
      };
      await deps.snapshots.write(outDir, runId, snapshot);
    }
  } finally {
    await workspace.store.close();
  }

  const degradedScopes = results
    .filter((r) => r.status !== 'PASS')
    .flatMap((r) => r.authoritative.map((a) => a.scope))
    .filter((s, i, xs) => xs.indexOf(s) === i)
    .sort();

  const report: ExtractReport = {
    runId,
    repo: config.repo,
    startedAt,
    results,
    totals: {
      nodes: results.reduce((n, r) => n + r.nodeCount, 0),
      edges: results.reduce((n, r) => n + r.edgeCount, 0),
    },
    degradedScopes,
    ambiguities,
    redactions: summarizeRedactions(redactor.redactionReport().findings),
  };

  const anyFail = results.some((r) => r.status === 'FAIL');

  if (parsed.globals.json) {
    emitJson(deps.io, report);
    return anyFail ? EXIT_FINDINGS : EXIT_OK;
  }

  const lines: string[] = [`run ${style.bold(printable(runId))}  repo ${printable(config.repo)}`, ''];
  const width = Math.max(...results.map((r) => printable(r.extractor).length), 12);
  for (const r of results) {
    const head = `${paintStatus(style, r.status)} ${printable(r.extractor).padEnd(width)}`;
    const counts =
      r.status === 'PASS'
        ? `${String(r.nodeCount).padStart(6)} nodes ${String(r.edgeCount).padStart(6)} edges ${String(r.durationMs).padStart(6)}ms`
        : style.dim(printable(r.diagnostics[0] ?? 'no diagnostic reported'));
    lines.push(`${head}  ${counts}`);
    if (r.status === 'PASS' && r.diagnostics.length > 0) {
      for (const d of r.diagnostics) lines.push(`${' '.repeat(12 + width)}  ${style.dim(printable(d))}`);
    }
  }
  lines.push('');
  lines.push(`total  ${report.totals.nodes} nodes, ${report.totals.edges} edges`);
  if (report.redactions.total > 0) {
    const byRule = report.redactions.byRule.map((r) => `${r.rule} x${r.count}`).join(', ');
    lines.push(
      style.dim(
        `redacted ${report.redactions.total} value(s) before storage: ${byRule} (run with --json for where)`,
      ),
    );
  }
  if (degradedScopes.length > 0) {
    lines.push('');
    lines.push(
      style.yellow(
        `${degradedScopes.length} scope(s) did not PASS. Queries touching them return UNKNOWN, not a negative finding:`,
      ),
    );
    for (const s of degradedScopes) lines.push(`  ${printable(s)}`);
  }
  emitText(deps.io, style, `${lines.join('\n')}\n`);

  if (anyFail) {
    deps.io.err(
      '\nAt least one extractor FAILED. The graph is incomplete; findings from its scope are suppressed.\n',
    );
    return EXIT_FINDINGS;
  }
  return EXIT_OK;
}

/**
 * One planned extractor as the run-inputs digest sees it: its version (the
 * registered implementation's, or `null` when nothing is wired for it), its
 * options, and what it reads from outside the tree. A sandboxed port reports
 * the same: the identity is computed in this process, never in the child.
 */
function extractorInput(
  spec: ExtractorConfig,
  registry: ReadonlyMap<string, ExtractorPort>,
  repoRoot: string,
): ExtractorInput {
  const impl = registry.get(spec.name);
  const version = impl?.version ?? null;
  const identity = impl?.inputIdentity?.({ repoRoot, options: spec.options }) ?? null;
  return { name: spec.name, version, options: spec.options, identity };
}

/**
 * The result of an extractor that did not run, or did not finish.
 *
 * `authoritative` is the scopes the extractor is responsible for, not the empty
 * list. The store answers `scopeStatus` from the latest run that declared the
 * scope, so a result that declares none leaves the previous run's PASS standing
 * and every detector over that scope goes on answering "clean" about a graph
 * this run did not refresh. A degraded result declares the scope; it carries no
 * nodes, so it tombstones nothing (v3 section 2.2).
 */
function unavailable(
  name: string,
  reason: string,
  scopes: ReadonlyArray<AuthoritativeScope>,
): ExtractorResult {
  return {
    extractor: name,
    version: '0.0.0',
    status: 'UNAVAILABLE',
    authoritative: scopes.map((s) => ({ ...s })),
    nodeCount: 0,
    edgeCount: 0,
    durationMs: 0,
    diagnostics: [reason],
  };
}

/**
 * The result for an extractor whose output validation or storage refused. A
 * credential in an identity, path or authority is one cause. It is FAIL: the
 * refused records are missing from the graph, and an absent node must not read
 * as "the fact does not exist". It keeps the extractor's authoritative scopes
 * so those scopes are recorded as FAIL for this run and queries over them
 * answer UNKNOWN instead of falling back to an older run's PASS. A FAIL result
 * never tombstones anything. Counts are zero because nothing of this batch is
 * trusted to have been stored. `record` strips selectors after declared-scope fallback.
 */
function refused(result: ExtractorResult, reason: string): ExtractorResult {
  return {
    ...result,
    status: 'FAIL',
    nodeCount: 0,
    edgeCount: 0,
    diagnostics: [reason],
  };
}

function summarizeRedactions(findings: ReadonlyArray<RedactionFinding>): ExtractRedactions {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  return {
    total: findings.length,
    byRule: [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([rule, count]) => ({ rule, count })),
    findings,
  };
}

function failed(
  name: string,
  version: string,
  reason: string,
  scopes: ReadonlyArray<AuthoritativeScope>,
): ExtractorResult {
  return {
    extractor: name,
    version,
    status: 'FAIL',
    authoritative: scopes.map((s) => ({ ...s })),
    nodeCount: 0,
    edgeCount: 0,
    durationMs: 0,
    diagnostics: [reason],
  };
}

/**
 * A result that did not PASS, with every scope its port declares added to the
 * scopes it named. A PASS is returned as it is: a scope claim on a PASS is what
 * lets it tombstone, and that is the extractor's to make, not this command's.
 */
function withDeclaredScopes(
  result: ExtractorResult,
  declared: ReadonlyArray<AuthoritativeScope> | undefined,
): ExtractorResult {
  if (result.status === 'PASS' || declared === undefined) return result;
  const named = new Set(result.authoritative.map((a) => a.scope));
  const missing = declared.filter((d) => !named.has(d.scope));
  if (missing.length === 0) return result;
  return { ...result, authoritative: [...result.authoritative, ...missing.map((m) => ({ ...m }))] };
}
