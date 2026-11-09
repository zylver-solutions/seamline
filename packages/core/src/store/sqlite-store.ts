/**
 * `GraphStore` over `node:sqlite`.
 *
 * Normative reference: docs/design/v3.md §2.2 (the graph can forget) and §3.
 *
 * Two things in here are load-bearing and easy to mistake for detail:
 *
 * 1. `finalizeRun` tombstones only inside the authoritative scope of a run
 *    whose extractor reported PASS, and never hard-deletes. A crashed extractor
 *    that tombstoned its scope would delete the graph and then report a clean
 *    bill of health on the next query.
 * 2. `traverse` returns UNKNOWN when any scope its answer depends on is not
 *    PASS. Returning an empty result there would turn infrastructure flakiness
 *    into a finding, and a gate that reports invented findings gets turned off.
 *
 * `node:sqlite` and not `better-sqlite3`: it is in the standard library, so it
 * has no install step, no native postinstall, and no chmod that a drvfs mount
 * cannot perform. Design v3 §3 names `better-sqlite3`; the schema, the SQL and
 * the traversal are identical either way, and §2.7/§10's supply-chain position
 * argues for the dependency-free one.
 */

import { DatabaseSync } from 'node:sqlite';
import { isValidEdge, known, parseNodeId, unknown } from '@seamline/ontology';
import type {
  AuthoritativeScope,
  EdgeKind,
  ExtractorResult,
  ExtractorStatus,
  GraphStore,
  Maybe,
  NodeId,
  NodeKind,
  RunRecord,
  SeamlineEdge,
  SeamlineNode,
  TraverseQuery,
} from '@seamline/ontology';
import {
  RunStateError,
  StoreError,
  applySchema,
  assertOntologyVersion,
  canonicalProps,
  nodeColumns,
  rowToEdge,
  rowToNode,
  SUPERSEDED_PREFIX,
  supersededStamp,
} from './schema.ts';
import type { EdgeRow, NodeRow } from './schema.ts';
import {
  SelectorError,
  compiledSelectorOf,
  isCanonicalCompiled,
  edgeAnchorSql,
  selectorNarrowsEdges,
  selectorHasExclusions,
  selectorParam,
  selectorPredicateSql,
  type CompiledAuthoritySelector,
} from './scope-selector.ts';
import { assertCanonicalSelectorBudget } from './canonical-selector.ts';
import { canonicalEdgePredicateSql, canonicalIdKindFromBytes, canonicalNodePredicateSql } from './canonical-authority.ts';
import {
  BUDGET_FUNCTION,
  DEFAULT_TRAVERSE_LIMITS,
  buildTraverseSql,
  createStepBudget,
  dependentNodeKinds,
  validateTraverseQuery,
} from './traverse.ts';
import type { TraverseLimits } from './traverse.ts';

export interface SqliteStoreOptions {
  /** File path, or `:memory:` (the default). */
  readonly path?: string;
  /** Stamped on a fresh database; compared against on every later open. */
  readonly ontologyVersion?: string;
  readonly limits?: Partial<TraverseLimits>;
  /**
   * Clock for run and tombstone timestamps. Defaults to wall clock, or to a
   * frozen clock under `SEAMLINE_DETERMINISTIC=1` (v3 §2.3). No timestamp ever
   * reaches a node or edge body; `deleted_at` is lifecycle state, not a fact.
   */
  readonly now?: () => string;
}

const FROZEN_CLOCK = '1970-01-01T00:00:00.000Z';

function defaultClock(): () => string {
  if (process.env['SEAMLINE_DETERMINISTIC'] === '1') return () => FROZEN_CLOCK;
  return () => new Date().toISOString();
}

const EDGE_COLUMNS =
  'scope, src_id, dst_id, kind, src_file, dst_file, provenance, confidence, source_ref, props, run_id, first_seen_run, last_seen_run, deleted_at';

/** An edge is hidden once either endpoint is tombstoned, without touching the edge row. */
const LIVE_ENDPOINTS =
  'NOT EXISTS (SELECT 1 FROM nodes tn WHERE tn.id IN (e.src_id, e.dst_id) AND tn.deleted_at IS NOT NULL)';

interface ScopeFacts {
  readonly seq: number;
  readonly status: ExtractorStatus;
  readonly kinds: ReadonlySet<NodeKind>;
}

interface RunRow {
  readonly run_id: string;
  readonly repo: string;
  readonly commit_sha: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly ontology_version: string;
}

interface ResultRow {
  readonly extractor: string;
  readonly version: string;
  readonly status: ExtractorStatus;
  readonly node_count: number;
  readonly edge_count: number;
  readonly duration_ms: number;
  readonly diagnostics: string;
}

interface ScopeRow {
  readonly extractor: string;
  readonly scope: string;
  readonly kinds: string;
  readonly selector: string | null;
}

function assertUsableRunId(runId: string): void {
  if (runId.length === 0) throw new RunStateError('runId must not be empty');
  if (runId.startsWith(SUPERSEDED_PREFIX)) {
    throw new RunStateError(`runId must not start with '${SUPERSEDED_PREFIX}'`);
  }
}

function worseStatus(a: ExtractorStatus, b: ExtractorStatus): ExtractorStatus {
  if (a === 'FAIL' || b === 'FAIL') return 'FAIL';
  if (a === 'UNAVAILABLE' || b === 'UNAVAILABLE') return 'UNAVAILABLE';
  return 'PASS';
}

/**
 * Compile the selector of every scope a PASS result claims. Only a PASS result
 * is swept, so only its selectors are evaluated; the rest are recorded as-is.
 */
function compilePassSelectors(
  results: ReadonlyArray<ExtractorResult>,
): ReadonlyMap<AuthoritativeScope, CompiledAuthoritySelector> {
  assertCanonicalSelectorBudget(results.flatMap(result => result.authoritative));
  const compiled = new Map<AuthoritativeScope, CompiledAuthoritySelector>();
  for (const result of results) {
    if (result.status !== 'PASS') continue;
    for (const scope of result.authoritative) {
      if (scope.selector === undefined) continue;
      try {
        const selector = compiledSelectorOf(scope);
        if (selector !== undefined) compiled.set(scope, selector);
      } catch (e) {
        if (!(e instanceof SelectorError)) throw e;
        throw new StoreError(`extractor ${result.extractor}, scope ${scope.scope}: ${e.message}`);
      }
    }
  }
  return compiled;
}

export class SqliteStore implements GraphStore {
  readonly #db: DatabaseSync;
  readonly #limits: TraverseLimits;
  readonly #budget = createStepBudget();
  readonly #now: () => string;
  readonly #cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  #closed = false;

  constructor(options: SqliteStoreOptions = {}) {
    this.#db = new DatabaseSync(options.path ?? ':memory:');
    this.#limits = { ...DEFAULT_TRAVERSE_LIMITS, ...options.limits };
    this.#now = options.now ?? defaultClock();
    try {
      applySchema(this.#db, options.ontologyVersion);
    } catch (error) {
      this.#db.close();
      throw error;
    }
    // Must stay non-deterministic: SQLite may hoist a deterministic function out
    // of the recursive term, and a budget that is charged once counts nothing.
    this.#db.function(BUDGET_FUNCTION, { deterministic: false }, this.#budget.guard);
    this.#db.function('seamline_canonical_id_kind', { deterministic: true }, canonicalIdKindFromBytes);
  }

  // ---------------------------------------------------------------- internals

  #assertOpen(): void {
    if (this.#closed) throw new StoreError('store is closed');
  }

  #stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    const hit = this.#cache.get(sql);
    if (hit !== undefined) return hit;
    const prepared = this.#db.prepare(sql);
    this.#cache.set(sql, prepared);
    return prepared;
  }

  #tx<T>(body: () => T): T {
    this.#db.exec('BEGIN');
    try {
      const result = body();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // The statement that failed may have rolled the transaction back already.
      }
      throw error;
    }
  }

  #run(runId: string): { repo: string; finished_at: string | null } {
    const row = this.#stmt('SELECT repo, finished_at FROM runs WHERE run_id = :run_id').get({
      run_id: runId,
    }) as { repo: string; finished_at: string | null } | undefined;
    if (row === undefined) throw new RunStateError(`unknown run: ${runId}`);
    return row;
  }

  #openRun(runId: string): { repo: string } {
    const row = this.#run(runId);
    if (row.finished_at !== null) {
      throw new RunStateError(`run ${runId} is already finalized and cannot be written to`);
    }
    return { repo: row.repo };
  }

  // ------------------------------------------------------------------- writes

  async beginRun(run: Omit<RunRecord, 'finishedAt' | 'results'>): Promise<void> {
    this.#assertOpen();
    assertUsableRunId(run.runId);
    assertOntologyVersion(this.#db, run.ontologyVersion);
    const existing = this.#stmt('SELECT 1 AS present FROM runs WHERE run_id = :run_id').get({
      run_id: run.runId,
    });
    if (existing !== undefined) throw new RunStateError(`run ${run.runId} already exists`);
    this.#stmt(
      `INSERT INTO runs (run_id, repo, commit_sha, started_at, finished_at, ontology_version)
       VALUES (:run_id, :repo, :commit_sha, :started_at, NULL, :ontology_version)`,
    ).run({
      run_id: run.runId,
      repo: run.repo,
      commit_sha: run.commit,
      started_at: run.startedAt,
      ontology_version: run.ontologyVersion,
    });
  }

  /**
   * Run the run with `run.runId` again. The run must already be on record, whether
   * it was finalized or left open by a crash; `beginRun` refuses such an id.
   *
   * Under `SEAMLINE_DETERMINISTIC=1` a run id is derived from the run's inputs, so
   * the same inputs always reach the store with the same id: running a tree twice,
   * retrying a run that was cut short, or returning to a tree an earlier run saw
   * after a different one. This re-opens that run as a new attempt at it:
   *
   * - The run becomes the newest. `seq` is the store's run order (`listRuns`, and
   *   `scopeStatus` takes each scope's status from the newest run that declared it),
   *   and it is deliberately not the order the ids sort in, which for a digest means
   *   nothing. Leaving the run where it was would let a stale run's results answer
   *   for scopes the new attempt has just re-declared.
   * - Its results and authoritative scopes are dropped; `finalizeRun` records the
   *   new attempt's. `started_at` and `commit_sha` take the new attempt's values.
   * - Nodes and edges are kept, but the earlier attempt's sighting of them is set
   *   aside: every live row stamped with this run id gets `supersededStamp(runId)`
   *   as its `last_seen_run`. The attempt's upserts re-stamp each row it sees (the
   *   stamp is this run again, `deleted_at` is cleared), and `finalizeRun` buries,
   *   inside the scopes of its PASS results and within each scope's selector, exactly
   *   the rows still carrying another stamp, then restores the stamp on the live
   *   rows the attempt did not cover.
   *
   * What it guarantees, whatever the run id was derived from: after a PASS result,
   * every row inside its authoritative scope that this attempt did not re-observe is
   * buried, including a row the earlier attempt stored under this very id. That is
   * what makes it safe for the id to leave out an input an extractor reads (a
   * dependency under `node_modules`, the tool's own version): the same id with
   * different facts still forgets what is gone. Rows outside every PASS scope (a
   * scope that FAILed or was UNAVAILABLE, or one the attempt did not declare, or
   * files outside a selector) stay live with the stamp they had, as for any run.
   * A crash between this call and `finalizeRun` leaves the set-aside stamp on the
   * rows the attempt had not re-observed. Readers are never shown it (`rowToNode`
   * and `rowToEdge` report the run it carries), and a finalize of another run
   * neither settles it nor is misled by it; the next attempt at this run id sets
   * aside the rest and settles all of them.
   */
  async restartRun(run: Omit<RunRecord, 'finishedAt' | 'results'>): Promise<void> {
    this.#assertOpen();
    assertUsableRunId(run.runId);
    assertOntologyVersion(this.#db, run.ontologyVersion);
    const existing = this.#stmt('SELECT repo FROM runs WHERE run_id = :run_id').get({
      run_id: run.runId,
    }) as { repo: string } | undefined;
    if (existing === undefined) throw new RunStateError(`unknown run: ${run.runId}`);
    if (existing.repo !== run.repo) {
      throw new RunStateError(
        `run ${run.runId} belongs to repo ${existing.repo}, so it cannot be restarted for ${run.repo}`,
      );
    }
    const stamp = { stale: supersededStamp(run.runId), run_id: run.runId };
    this.#tx(() => {
      // Scopes reference results, so they go first.
      this.#stmt('DELETE FROM authority_claims_v2 WHERE run_id = :run_id').run({
        run_id: run.runId,
      });
      this.#stmt('DELETE FROM extractor_results WHERE run_id = :run_id').run({ run_id: run.runId });
      this.#stmt(
        `UPDATE runs
         SET commit_sha = :commit_sha, started_at = :started_at, finished_at = NULL,
             seq = (SELECT MAX(seq) + 1 FROM runs)
         WHERE run_id = :run_id`,
      ).run({ run_id: run.runId, commit_sha: run.commit, started_at: run.startedAt });
      // Set the earlier attempt's sighting aside, so that the sweep sees only what
      // this attempt re-observes. Tombstoned rows are not swept and keep their stamp.
      for (const table of ['nodes', 'edges']) {
        this.#stmt(
          `UPDATE ${table} SET last_seen_run = :stale
           WHERE last_seen_run = :run_id AND deleted_at IS NULL`,
        ).run(stamp);
      }
    });
  }

  async upsertNodes(runId: string, nodes: ReadonlyArray<SeamlineNode>): Promise<void> {
    this.#assertOpen();
    this.#openRun(runId);
    if (nodes.length === 0) return;

    const insert = this.#stmt(
      `INSERT INTO nodes (id, repo, kind, name, path, sensitivity, provenance, confidence,
                          source_ref, untrusted, props, run_id, first_seen_run, last_seen_run, deleted_at)
       VALUES (:id, :repo, :kind, :name, :path, :sensitivity, :provenance, :confidence,
               :source_ref, :untrusted, :props, :run_id, :first_seen_run, :run_id, NULL)
       ON CONFLICT(id) DO UPDATE SET
         repo = excluded.repo, kind = excluded.kind, name = excluded.name, path = excluded.path,
         sensitivity = excluded.sensitivity, provenance = excluded.provenance,
         confidence = excluded.confidence, source_ref = excluded.source_ref,
         untrusted = excluded.untrusted, props = excluded.props, run_id = excluded.run_id,
         last_seen_run = excluded.last_seen_run,
         deleted_at = NULL`,
    );

    this.#tx(() => {
      for (const node of nodes) {
        const parsed = parseNodeId(node.id);
        if (parsed.kind !== node.kind) {
          throw new StoreError(
            `node ${node.id} declares kind ${node.kind} but its natural key says ${parsed.kind}`,
          );
        }
        insert.run({
          id: node.id,
          repo: parsed.repo,
          kind: node.kind,
          name: node.name,
          path: node.path ?? null,
          sensitivity: node.sensitivity,
          provenance: node.provenance,
          confidence: node.confidence,
          source_ref: node.sourceRef ?? null,
          untrusted: node.untrusted === true ? 1 : 0,
          props: canonicalProps(node.props),
          run_id: runId,
          first_seen_run: node.firstSeenRun.length > 0 ? node.firstSeenRun : runId,
        });
      }
    });
  }

  async upsertEdges(
    runId: string,
    scope: string,
    edges: ReadonlyArray<SeamlineEdge>,
  ): Promise<void> {
    this.#assertOpen();
    this.#openRun(runId);
    if (scope.length === 0) throw new StoreError('upsertEdges requires a non-empty scope');
    if (edges.length === 0) return;

    // Two rows with the same identity in one batch would collapse into one via
    // ON CONFLICT, quietly discarding whichever the extractor emitted first.
    // That is an extractor bug and it should be reported as one.
    const seen = new Set<string>();
    for (const e of edges) {
      const key = `${e.src} ${e.dst} ${e.kind}`;
      if (seen.has(key)) {
        throw new StoreError(
          `duplicate edge in one batch for scope '${scope}': ${e.src} -[${e.kind}]-> ${e.dst}`,
        );
      }
      seen.add(key);
      const src = parseNodeId(e.src);
      const dst = parseNodeId(e.dst);
      if (!isValidEdge(e.kind, src.kind, dst.kind)) {
        throw new StoreError(
          `edge ${e.kind} is not declared for ${src.kind} -> ${dst.kind} (contract EDGE_SIGNATURES)`,
        );
      }
    }

    const insert = this.#stmt(
      `INSERT INTO edges (${EDGE_COLUMNS})
       VALUES (:scope, :src_id, :dst_id, :kind, :src_file, :dst_file, :provenance, :confidence,
               :source_ref, :props, :run_id, :first_seen_run, :run_id, NULL)
       ON CONFLICT(scope, src_id, dst_id, kind) DO UPDATE SET
         src_file = excluded.src_file, dst_file = excluded.dst_file,
         provenance = excluded.provenance, confidence = excluded.confidence,
         source_ref = excluded.source_ref, props = excluded.props, run_id = excluded.run_id,
         last_seen_run = excluded.last_seen_run,
         deleted_at = NULL`,
    );

    this.#tx(() => {
      for (const e of edges) {
        insert.run({
          scope,
          src_id: e.src,
          dst_id: e.dst,
          kind: e.kind,
          src_file: e.srcFile ?? null,
          dst_file: e.dstFile ?? null,
          provenance: e.provenance,
          confidence: e.confidence,
          source_ref: e.sourceRef ?? null,
          props: canonicalProps(e.props),
          run_id: runId,
          first_seen_run: e.firstSeenRun.length > 0 ? e.firstSeenRun : runId,
        });
      }
    });
  }

  /**
   * Record the run's extractor results and tombstone what vanished.
   *
   * The sweep is per authoritative scope, and only for results that reported
   * PASS: a FAIL or UNAVAILABLE extractor produced no evidence that anything
   * vanished, only evidence that it did not look. Rows outside the swept scopes
   * are not read, not rewritten, and not touched.
   *
   * A PASS result whose selector does not compile is refused before anything
   * is written: evaluated anyway, it would match nothing and silently switch
   * tombstoning off for its scope.
   */
  async finalizeRun(runId: string, results: ReadonlyArray<ExtractorResult>): Promise<void> {
    this.#assertOpen();
    const { repo } = this.#openRun(runId);
    const selectors = compilePassSelectors(results);
    const finishedAt = this.#now();

    const insertResult = this.#stmt(
      `INSERT INTO extractor_results (run_id, extractor, version, status, node_count, edge_count, duration_ms, diagnostics)
       VALUES (:run_id, :extractor, :version, :status, :node_count, :edge_count, :duration_ms, :diagnostics)`,
    );
    const insertScope = this.#stmt(
      `INSERT INTO authority_claims_v2 (run_id, extractor, claim_index, scope, kinds, selector)
       VALUES (:run_id, :extractor, :claim_index, :scope, :kinds, :selector)`,
    );
    this.#tx(() => {
      for (const result of results) {
        insertResult.run({
          run_id: runId,
          extractor: result.extractor,
          version: result.version,
          status: result.status,
          node_count: Math.trunc(result.nodeCount),
          edge_count: Math.trunc(result.edgeCount),
          duration_ms: Math.trunc(result.durationMs),
          diagnostics: JSON.stringify(result.diagnostics),
        });
        for (const [claimIndex, scope] of result.authoritative.entries()) {
          insertScope.run({
            claim_index: claimIndex,
            run_id: runId,
            extractor: result.extractor,
            scope: scope.scope,
            kinds: JSON.stringify([...scope.kinds].sort()),
            selector: scope.selector ?? null,
          });
        }
        if (result.status !== 'PASS') continue;
        for (const scope of result.authoritative) {
          // The tombstone marker is the RUN ID, never a wall clock: v3 s2.3 forbids
          // wall-clock time in a node or edge body, and merge/lifecycle derives
          // liveness as `deletedAt > lastSeenRun` over run ids. Passing a timestamp
          // here compiles (both are `string | null`) and silently computes wrong
          // liveness. `runs.finished_at` below keeps the real timestamp. This
          // store reads liveness as `deleted_at IS NULL` and only ever compares
          // run ids for equality, so it does not need ids to sort (deterministic
          // run ids are digests and do not; see `restartRun`).
          this.#sweepEdges(repo, scope, selectors.get(scope), runId, runId);
          this.#sweepNodes(repo, scope, selectors.get(scope), runId, runId);
        }
      }
      this.#settleSupersededStamps(runId);
      this.#stmt('UPDATE runs SET finished_at = :ts WHERE run_id = :run_id').run({
        ts: finishedAt,
        run_id: runId,
      });
    });
  }

  /**
   * End of an attempt: no row is left carrying `supersededStamp(runId)`. A live row
   * that is still set aside was outside every PASS scope of the attempt, so nothing
   * was learned about it and it takes back the stamp it had, this run's. A buried one
   * gets the empty stamp ("no run on record has seen it", which `merge/lifecycle`
   * already reads as never seen) so that its tombstone, `deleted_at = runId`, postdates
   * its last sighting, as for any buried row. A no-op for a run that was not restarted.
   */
  #settleSupersededStamps(runId: string): void {
    const params = { stale: supersededStamp(runId), run_id: runId };
    for (const table of ['nodes', 'edges']) {
      this.#stmt(
        `UPDATE ${table}
         SET last_seen_run = CASE WHEN deleted_at IS NULL THEN :run_id ELSE '' END
         WHERE last_seen_run = :stale`,
      ).run(params);
    }
  }

  /**
   * Tombstone edges stored under the scope's name that this run did not
   * re-observe and that the claim covers. Without a selector that is every
   * unseen edge of the scope. With one, an edge is covered when the file that
   * anchors it (`src_file`, else `dst_file`) matches, so a run narrowed to some
   * files cannot bury the edges of the files it did not read, any more than it
   * can bury their nodes; an edge with no file never matches one. A claim that
   * names no node kinds has none for the selector to narrow and covers the
   * scope's edges whole. The rule is `scope-selector.ts`'s "What a claim
   * covers", which the in-memory merge evaluates over `MergeState`.
   */
  #sweepEdges(
    repo: string,
    scope: AuthoritativeScope,
    selector: CompiledAuthoritySelector | undefined,
    runId: string,
    ts: string,
  ): void {
    const params: Record<string, string> = { ts, scope: scope.scope, run_id: runId };
    let selectorClause = '';
    if (selector !== undefined && selectorNarrowsEdges(scope)) {
      if (isCanonicalCompiled(selector)) {
        params['repo'] = repo;
        params['canonical_path'] = selector.path;
        params['canonical_rules'] = JSON.stringify(selector.rules);
        params['canonical_kinds'] = JSON.stringify(scope.kinds);
        selectorClause = `AND ${canonicalEdgePredicateSql()}`;
      } else {
        params['selector'] = selectorParam(selector);
        selectorClause = `AND ${selectorPredicateSql(edgeAnchorSql('edges'), ':selector', selectorHasExclusions(selector))}`;
      }
    }
    this.#stmt(
      `UPDATE edges SET deleted_at = :ts
       WHERE deleted_at IS NULL
         AND scope = :scope
         AND last_seen_run <> :run_id
         ${selectorClause}`,
    ).run(params);
  }

  /**
   * Tombstone nodes of the scope's kinds, in this run's repo, that this run did
   * not re-observe. `selector`, when the scope has one, is matched against the
   * node's repo-relative path with the syntax and semantics `scope-selector.ts`
   * defines; a node with no path never matches one, which keeps the sweep on
   * the conservative side.
   */
  #sweepNodes(
    repo: string,
    scope: AuthoritativeScope,
    selector: CompiledAuthoritySelector | undefined,
    runId: string,
    ts: string,
  ): void {
    if (scope.kinds.length === 0) return;
    const params: Record<string, string> = { ts, repo, run_id: runId };
    const kindNames = scope.kinds.map((kind, i) => {
      params[`k${i}`] = kind;
      return `:k${i}`;
    });
    let selectorClause = '';
    if (selector !== undefined) {
      if (isCanonicalCompiled(selector)) {
        params['canonical_path'] = selector.path;
        params['canonical_rules'] = JSON.stringify(selector.rules);
        selectorClause = `AND ${canonicalNodePredicateSql('nodes')}`;
      } else {
        params['selector'] = selectorParam(selector);
        selectorClause = `AND ${selectorPredicateSql('nodes.path', ':selector', selectorHasExclusions(selector))}`;
      }
    }
    this.#stmt(
      `UPDATE nodes SET deleted_at = :ts
       WHERE deleted_at IS NULL
         AND repo = :repo
         AND kind IN (${kindNames.join(', ')})
         AND last_seen_run <> :run_id
         ${selectorClause}`,
    ).run(params);
  }

  // -------------------------------------------------------------------- reads

  nodesByKind(kind: NodeKind): ReadonlyArray<SeamlineNode> {
    this.#assertOpen();
    const rows = this.#stmt(
      `SELECT ${nodeColumns('n')} FROM nodes n
       WHERE n.kind = :kind AND n.deleted_at IS NULL ORDER BY n.id`,
    ).all({ kind }) as unknown as NodeRow[];
    return rows.map(rowToNode);
  }

  node(id: NodeId): SeamlineNode | undefined {
    this.#assertOpen();
    const row = this.#stmt(
      `SELECT ${nodeColumns('n')} FROM nodes n WHERE n.id = :id AND n.deleted_at IS NULL`,
    ).get({ id }) as unknown as NodeRow | undefined;
    return row === undefined ? undefined : rowToNode(row);
  }

  edgesFrom(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
    return this.#edges('src_id', id, kind);
  }

  edgesTo(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
    return this.#edges('dst_id', id, kind);
  }

  #edges(column: 'src_id' | 'dst_id', id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
    this.#assertOpen();
    const kindClause = kind === undefined ? '' : 'AND e.kind = :kind';
    const rows = this.#stmt(
      `SELECT ${EDGE_COLUMNS} FROM edges e
       WHERE e.${column} = :id AND e.deleted_at IS NULL ${kindClause} AND ${LIVE_ENDPOINTS}
       ORDER BY e.src_id, e.dst_id, e.kind, e.scope`,
    ).all(kind === undefined ? { id } : { id, kind }) as unknown as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Live edges anchored on a file, for the re-run invalidation rule (v3 §2.1):
   * when a file changes, every edge whose source or destination lived in it has
   * to be re-resolved. This is why `src_file`/`dst_file` are on the edge at all.
   */
  edgesByFile(path: string): ReadonlyArray<SeamlineEdge> {
    this.#assertOpen();
    const rows = this.#stmt(
      `SELECT ${EDGE_COLUMNS} FROM edges e
       WHERE e.deleted_at IS NULL AND (e.src_file = :path OR e.dst_file = :path)
       ORDER BY e.src_id, e.dst_id, e.kind, e.scope`,
    ).all({ path }) as unknown as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Status of a scope as of the most recent run that declared it.
   *
   * A scope nobody has ever declared is UNAVAILABLE, not PASS. "We have no
   * record of that extractor running" and "that extractor ran and found
   * nothing" are different answers, and only one of them may be used to deny
   * that something exists.
   */
  scopeStatus(scope: string): ExtractorStatus {
    this.#assertOpen();
    const facts = this.#scopeFacts().get(scope);
    return facts === undefined ? 'UNAVAILABLE' : facts.status;
  }

  /** Latest declared status and node kinds for every scope in the store. */
  #scopeFacts(): Map<string, ScopeFacts> {
    const rows = this.#stmt(
      `SELECT s.scope AS scope, s.kinds AS kinds, r.status AS status, ru.seq AS seq
       FROM authority_claims_v2 s
       JOIN extractor_results r ON r.run_id = s.run_id AND r.extractor = s.extractor
       JOIN runs ru ON ru.run_id = s.run_id`,
    ).all() as unknown as Array<{
      scope: string;
      kinds: string;
      status: ExtractorStatus;
      seq: number;
    }>;

    const latest = new Map<string, ScopeFacts>();
    for (const row of rows) {
      const current = latest.get(row.scope);
      if (current !== undefined && current.seq > row.seq) continue;
      const kinds = new Set(JSON.parse(row.kinds) as NodeKind[]);
      if (current === undefined || current.seq < row.seq) {
        latest.set(row.scope, { seq: row.seq, status: row.status, kinds });
      } else {
        // Same run, several extractors on one scope: the worst status wins, and
        // the declared kinds are the union of what each of them claimed.
        for (const k of current.kinds) kinds.add(k);
        latest.set(row.scope, {
          seq: row.seq,
          status: worseStatus(current.status, row.status),
          kinds,
        });
      }
    }
    return latest;
  }

  // ---------------------------------------------------------------- traversal

  async traverse(q: TraverseQuery): Promise<Maybe<ReadonlyArray<SeamlineNode>>> {
    this.#assertOpen();
    const query = validateTraverseQuery(q, this.#limits);

    const degraded = this.#degradedScopes(query.via, dependentNodeKinds(query));
    if (degraded.length > 0) {
      const detail = degraded.map(([scope, status]) => `${scope}=${status}`).join(', ');
      return unknown(
        `traversal depends on scope(s) whose extractor did not PASS: ${detail}`,
        degraded.map(([scope]) => scope),
      );
    }

    const { sql, params } = buildTraverseSql(query);
    this.#budget.arm(this.#limits);
    const rows = this.#stmt(sql).all(params) as unknown as NodeRow[];
    return known(rows.map(rowToNode));
  }

  /**
   * Scopes that could change this traversal's answer and are not PASS.
   *
   * Two sources, deliberately over-approximating:
   *  - declared: a scope whose declared node kinds intersect the domain and
   *    range of the edge kinds being walked. This is data-independent, so it
   *    still fires for an extractor that failed on its very first run and wrote
   *    no rows at all, which is the case where asking the data would answer "no
   *    dependency" and produce a confident, wrong, empty result.
   *  - observed: a scope that has actually written an edge of one of these kinds.
   */
  #degradedScopes(
    via: ReadonlyArray<EdgeKind>,
    kinds: ReadonlySet<NodeKind>,
  ): Array<[string, ExtractorStatus]> {
    const facts = this.#scopeFacts();
    const relevant = new Set<string>();

    for (const [scope, fact] of facts) {
      for (const kind of fact.kinds) {
        if (kinds.has(kind)) {
          relevant.add(scope);
          break;
        }
      }
    }

    const params: Record<string, string> = {};
    const names = via.map((kind, i) => {
      params[`k${i}`] = kind;
      return `:k${i}`;
    });
    const observed = this.#stmt(
      `SELECT DISTINCT scope FROM edges WHERE kind IN (${names.join(', ')})`,
    ).all(params) as unknown as Array<{ scope: string }>;
    for (const row of observed) relevant.add(row.scope);

    const degraded: Array<[string, ExtractorStatus]> = [];
    for (const scope of [...relevant].sort()) {
      const status = facts.get(scope)?.status ?? 'UNAVAILABLE';
      if (status !== 'PASS') degraded.push([scope, status]);
    }
    return degraded;
  }

  /**
   * Run metadata by id, with its per-extractor results and authoritative
   * scopes reassembled from the tables `finalizeRun` wrote them to.
   *
   * `GraphStore` has no read path for runs — it only ever writes them — so
   * this and `listRuns` exist for callers (the CLI's `RunHistory`, `why`,
   * `check`) that need to report what a run found without re-deriving it from
   * live graph state.
   */
  async getRun(runId: string): Promise<RunRecord | undefined> {
    this.#assertOpen();
    const row = this.#stmt(
      'SELECT run_id, repo, commit_sha, started_at, finished_at, ontology_version FROM runs WHERE run_id = :run_id',
    ).get({ run_id: runId }) as unknown as RunRow | undefined;
    if (row === undefined) return undefined;
    return this.#toRunRecord(row);
  }

  /** Most recent runs first (insertion order, `runs.seq DESC`). */
  async listRuns(limit: number): Promise<readonly RunRecord[]> {
    this.#assertOpen();
    const rows = this.#stmt(
      `SELECT run_id, repo, commit_sha, started_at, finished_at, ontology_version FROM runs
       ORDER BY seq DESC LIMIT :limit`,
    ).all({ limit }) as unknown as RunRow[];
    return rows.map((row) => this.#toRunRecord(row));
  }

  #toRunRecord(row: RunRow): RunRecord {
    const resultRows = this.#stmt(
      `SELECT extractor, version, status, node_count, edge_count, duration_ms, diagnostics
       FROM extractor_results WHERE run_id = :run_id ORDER BY extractor`,
    ).all({ run_id: row.run_id }) as unknown as ResultRow[];
    const scopeRows = this.#stmt(
      'SELECT extractor, scope, kinds, selector FROM authority_claims_v2 WHERE run_id = :run_id ORDER BY extractor, claim_index',
    ).all({ run_id: row.run_id }) as unknown as ScopeRow[];

    const scopesByExtractor = new Map<string, AuthoritativeScope[]>();
    for (const s of scopeRows) {
      const list = scopesByExtractor.get(s.extractor) ?? [];
      list.push({
        scope: s.scope,
        kinds: JSON.parse(s.kinds) as NodeKind[],
        ...(s.selector === null ? {} : { selector: s.selector }),
      });
      scopesByExtractor.set(s.extractor, list);
    }

    return {
      runId: row.run_id,
      repo: row.repo,
      commit: row.commit_sha,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      ontologyVersion: row.ontology_version,
      results: resultRows.map((r) => ({
        extractor: r.extractor,
        version: r.version,
        status: r.status,
        authoritative: scopesByExtractor.get(r.extractor) ?? [],
        nodeCount: r.node_count,
        edgeCount: r.edge_count,
        durationMs: r.duration_ms,
        diagnostics: JSON.parse(r.diagnostics) as string[],
      })),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cache.clear();
    this.#db.close();
  }
}
