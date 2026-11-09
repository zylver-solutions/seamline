/**
 * Relational schema for the SQLite graph store.
 *
 * Normative reference: docs/design/v3.md §2.2 (lifecycle) and §3 (storage).
 *
 * The DDL is generated from the ontology arrays in the shared contract rather
 * than hand-transcribed, so a kind added to `NODE_KINDS` cannot silently drift
 * out of the `CHECK` constraint that is supposed to enforce it. Tables are
 * `STRICT`: SQLite's default type affinity would happily store the string
 * `"0.9"` in `confidence`, and a store whose column types are advisory is not
 * a place to keep facts a CI gate depends on.
 */

import type { DatabaseSync } from 'node:sqlite';
import { compileSelector } from './scope-selector.ts';
import {
  EDGE_KINDS,
  EXTRACTOR_STATUS,
  NODE_KINDS,
  PROVENANCE,
  SENSITIVITY,
  parseNodeId,
} from '@seamline/ontology';
import type {
  NodeId,
  NodeKind,
  EdgeKind,
  Provenance,
  Sensitivity,
  SeamlineEdge,
  SeamlineNode,
} from '@seamline/ontology';

/**
 * Bumped whenever the DDL below changes shape. A store written by a different
 * version is rejected at open time rather than misread: the failure mode this
 * prevents is a query silently returning fewer rows because a column it filters
 * on did not exist yet.
 */
export const SCHEMA_VERSION = 2;

export const META_SCHEMA_VERSION = 'schema_version';
export const META_ONTOLOGY_VERSION = 'ontology_version';

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

/** The database on disk was written by a different schema version. */
export class SchemaMismatchError extends StoreError {
  readonly found: number;
  readonly expected: number;
  constructor(found: number, expected: number) {
    super(`graph schema version ${found} does not match this build's version ${expected}`);
    this.name = 'SchemaMismatchError';
    this.found = found;
    this.expected = expected;
  }
}

/** The database holds a graph built against a different ontology version. */
export class OntologyVersionMismatchError extends StoreError {
  readonly found: string;
  readonly expected: string;
  constructor(found: string, expected: string) {
    super(`graph was built against ontology ${found}, this run declares ${expected}`);
    this.name = 'OntologyVersionMismatchError';
    this.found = found;
    this.expected = expected;
  }
}

/** A run was used out of order: unknown, already finalized, or never begun. */
export class RunStateError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = 'RunStateError';
  }
}

function sqlStringList(values: ReadonlyArray<string>): string {
  return values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ');
}

const NODE_KIND_CHECK = sqlStringList(NODE_KINDS);
const EDGE_KIND_CHECK = sqlStringList(EDGE_KINDS);
const PROVENANCE_CHECK = sqlStringList(PROVENANCE);
const SENSITIVITY_CHECK = sqlStringList(SENSITIVITY);
const STATUS_CHECK = sqlStringList(EXTRACTOR_STATUS);

// Kept as a real, empty table because version-1 bootstrap executes its DDL
// before checking the version marker. Dropping it would permit a failed old
// reopen to recreate a writable certification surface (ADR-0018).
const LEGACY_SCOPE_GUARD_SQL = `CREATE TABLE IF NOT EXISTS authoritative_scopes (
  run_id    TEXT NOT NULL,
  extractor TEXT NOT NULL,
  scope     TEXT NOT NULL,
  kinds     TEXT NOT NULL,
  selector  TEXT,
  PRIMARY KEY (run_id, extractor, scope),
  FOREIGN KEY (run_id, extractor) REFERENCES extractor_results(run_id, extractor),
  CHECK (0)
) STRICT`;

const AUTHORITY_CLAIMS_SQL = `CREATE TABLE IF NOT EXISTS authority_claims_v2 (
  run_id      TEXT NOT NULL,
  extractor   TEXT NOT NULL,
  claim_index INTEGER NOT NULL CHECK (claim_index >= 0),
  scope       TEXT NOT NULL,
  kinds       TEXT NOT NULL,
  selector    TEXT,
  PRIMARY KEY (run_id, extractor, claim_index),
  FOREIGN KEY (run_id, extractor) REFERENCES extractor_results(run_id, extractor)
) STRICT`;

/**
 * Full DDL. Every statement is `IF NOT EXISTS` so `applySchema` is idempotent.
 *
 * `runs.seq` is the order runs happened in: `listRuns` follows it, and so does
 * which run's declaration of a scope is the newest. It is never the order of
 * `run_id`, which in deterministic mode is a digest of the run's inputs
 * (ADR-0009 §3a) and sorts arbitrarily, and never `started_at`, which is a
 * constant there. `SqliteStore.restartRun` moves a repeated run to the end.
 *
 * Index rationale (there are no speculative indexes here; each one serves a
 * query implemented in this directory):
 *  - `idx_nodes_kind_live`      -> `nodesByKind`
 *  - `idx_nodes_scope_sweep`    -> the `finalizeRun` node tombstone sweep
 *  - `idx_edges_out` / `_in`    -> `edgesFrom` / `edgesTo` and both traversal
 *                                  directions of the recursive CTE
 *  - `idx_edges_scope_sweep`    -> the `finalizeRun` edge tombstone sweep
 *  - `idx_edges_kind`           -> the scope-dependency lookup behind UNKNOWN
 *  - `idx_edges_src_file/_dst_file` -> the re-run invalidation rule (v3 §2.1),
 *                                  which finds edges by changed file
 *  - `idx_claims_v2_scope`      -> `scopeStatus`
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS runs (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id           TEXT NOT NULL UNIQUE,
  repo             TEXT NOT NULL,
  commit_sha       TEXT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  ontology_version TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS extractor_results (
  run_id      TEXT NOT NULL REFERENCES runs(run_id),
  extractor   TEXT NOT NULL,
  version     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN (${STATUS_CHECK})),
  node_count  INTEGER NOT NULL,
  edge_count  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  diagnostics TEXT NOT NULL,
  PRIMARY KEY (run_id, extractor)
) STRICT;

${LEGACY_SCOPE_GUARD_SQL};
${AUTHORITY_CLAIMS_SQL};
CREATE INDEX IF NOT EXISTS idx_claims_v2_scope ON authority_claims_v2(scope);

CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,
  repo           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN (${NODE_KIND_CHECK})),
  name           TEXT NOT NULL,
  path           TEXT,
  sensitivity    TEXT NOT NULL CHECK (sensitivity IN (${SENSITIVITY_CHECK})),
  provenance     TEXT NOT NULL CHECK (provenance IN (${PROVENANCE_CHECK})),
  confidence     REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_ref     TEXT,
  untrusted      INTEGER NOT NULL DEFAULT 0 CHECK (untrusted IN (0, 1)),
  props          TEXT NOT NULL,
  run_id         TEXT NOT NULL REFERENCES runs(run_id),
  first_seen_run TEXT NOT NULL,
  last_seen_run  TEXT NOT NULL,
  deleted_at     TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_nodes_kind_live ON nodes(kind, deleted_at);
CREATE INDEX IF NOT EXISTS idx_nodes_scope_sweep ON nodes(repo, kind, last_seen_run);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON nodes(path);

CREATE TABLE IF NOT EXISTS edges (
  scope          TEXT NOT NULL,
  src_id         TEXT NOT NULL,
  dst_id         TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN (${EDGE_KIND_CHECK})),
  src_file       TEXT,
  dst_file       TEXT,
  provenance     TEXT NOT NULL CHECK (provenance IN (${PROVENANCE_CHECK})),
  confidence     REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_ref     TEXT,
  props          TEXT NOT NULL,
  run_id         TEXT NOT NULL REFERENCES runs(run_id),
  first_seen_run TEXT NOT NULL,
  last_seen_run  TEXT NOT NULL,
  deleted_at     TEXT,
  CONSTRAINT edges_identity UNIQUE (scope, src_id, dst_id, kind)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_edges_out ON edges(src_id, kind, deleted_at);
CREATE INDEX IF NOT EXISTS idx_edges_in ON edges(dst_id, kind, deleted_at);
CREATE INDEX IF NOT EXISTS idx_edges_scope_sweep ON edges(scope, last_seen_run);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind, scope);
CREATE INDEX IF NOT EXISTS idx_edges_src_file ON edges(src_file);
CREATE INDEX IF NOT EXISTS idx_edges_dst_file ON edges(dst_file);
`;

/** Columns of `nodes`, in a fixed order, qualified by `alias`. */
export function nodeColumns(alias: string): string {
  return [
    'id', 'repo', 'kind', 'name', 'path', 'sensitivity', 'provenance', 'confidence',
    'source_ref', 'untrusted', 'props', 'run_id', 'first_seen_run', 'last_seen_run', 'deleted_at',
  ]
    .map((c) => `${alias}.${c}`)
    .join(', ');
}

/**
 * Create the tables if absent and reconcile the stamped versions.
 *
 * Version 1 is migrated atomically; other versions are refused before DDL.
 * `expectedOntology`
 * is stamped on first use and compared on every later open, so a graph built by a
 * different ontology is a loud failure and not a quiet under-count.
 */
export function applySchema(db: DatabaseSync, expectedOntology?: string): void {
  db.exec('PRAGMA foreign_keys = ON;');
  if ((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys !== 1)
    throw new StoreError('graph schema requires enabled foreign keys');
  db.exec('SAVEPOINT seamline_schema_upgrade');
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    const hasMeta = tables.some(row => row['name'] === 'meta');
    const found = hasMeta
      ? db.prepare('SELECT value FROM meta WHERE key = :key').get({ key: META_SCHEMA_VERSION }) as { value: string } | undefined
      : undefined;
    if (found === undefined) {
      if (tables.length !== 0) throw new StoreError('unversioned graph schema cannot be adopted');
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO meta(key, value) VALUES (:key, :value)').run({
        key: META_SCHEMA_VERSION, value: String(SCHEMA_VERSION),
      });
    } else if (found.value === '1') {
      migrateVersionOne(db);
    } else if (found.value !== String(SCHEMA_VERSION)) {
      throw new SchemaMismatchError(Number(found.value), SCHEMA_VERSION);
    }
    assertVersionTwoAuthority(db);
    if (expectedOntology !== undefined) assertOntologyVersion(db, expectedOntology);
    db.exec('RELEASE seamline_schema_upgrade');
  } catch (error) {
    db.exec('ROLLBACK TO seamline_schema_upgrade; RELEASE seamline_schema_upgrade');
    throw error;
  }
}

function normalizedDdl(sql: string): string {
  return sql.replace(/\bIF NOT EXISTS\b/giu, '').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function assertOwnedTable(db: DatabaseSync, table: string, expected: string): void {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = :table").get({ table }) as { sql: string } | undefined;
  if (row === undefined || normalizedDdl(row.sql) !== normalizedDdl(expected))
    throw new StoreError(`graph version 2 requires its intact ${table} table`);
}

function assertVersionTwoAuthority(db: DatabaseSync): void {
  assertOwnedTable(db, 'authoritative_scopes', LEGACY_SCOPE_GUARD_SQL);
  assertOwnedTable(db, 'authority_claims_v2', AUTHORITY_CLAIMS_SQL);
  if (db.prepare('SELECT 1 FROM authoritative_scopes LIMIT 1').get() !== undefined)
    throw new StoreError('graph legacy authority guard must be empty');
}

function migrateVersionOne(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'authority_claims_v2'").get() !== undefined)
    throw new StoreError('version 1 contains conflicting version-2 authority metadata');
  // Iterate rather than materializing the entire claim history in JS. Old
  // labels over kinds=[] are retained verbatim; they never narrowed a sweep.
  const claims = db.prepare('SELECT kinds, selector FROM authoritative_scopes');
  try {
    for (const row of claims.iterate()) {
      const kinds: unknown = JSON.parse(row['kinds'] as string);
      if (!Array.isArray(kinds) || kinds.some(kind => !NODE_KINDS.includes(kind as NodeKind)))
        throw new StoreError('invalid legacy authority kinds');
      const selector = row['selector'] as string | null;
      if (selector === null) continue;
      if (selector.startsWith('/@canonical/'))
        throw new StoreError('version 1 cannot certify canonical authority');
      if (kinds.length > 0) compileSelector(selector);
    }
  } finally {
    // Node 22.13 iterators do not retain their statement. This native accessor
    // keeps it live through iteration and exception cleanup, before any DDL.
    void claims.sourceSQL;
  }
  db.exec(`${AUTHORITY_CLAIMS_SQL};
    INSERT INTO authority_claims_v2 (run_id, extractor, claim_index, scope, kinds, selector)
    SELECT run_id, extractor,
           ROW_NUMBER() OVER (PARTITION BY run_id, extractor ORDER BY scope) - 1,
           scope, kinds, selector FROM authoritative_scopes;
    DROP TABLE authoritative_scopes;
    ${LEGACY_SCOPE_GUARD_SQL};
    CREATE INDEX idx_claims_v2_scope ON authority_claims_v2(scope);`);
  db.prepare('UPDATE meta SET value = :value WHERE key = :key').run({
    key: META_SCHEMA_VERSION, value: String(SCHEMA_VERSION),
  });
}

/**
 * Stamp the ontology version on first use; thereafter require agreement.
 * Called again from `beginRun`, because a run declares its own ontology version
 * and a store opened without one must still catch a mismatched run.
 */
export function assertOntologyVersion(db: DatabaseSync, version: string): void {
  const row = db.prepare('SELECT value FROM meta WHERE key = :key').get({
    key: META_ONTOLOGY_VERSION,
  }) as { value: string } | undefined;
  if (row === undefined) {
    db.prepare('INSERT INTO meta(key, value) VALUES (:key, :value)').run({
      key: META_ONTOLOGY_VERSION,
      value: version,
    });
    return;
  }
  if (row.value !== version) {
    throw new OntologyVersionMismatchError(row.value, version);
  }
}

/**
 * Deterministic JSON for a props bag: keys sorted, so two runs that produced the
 * same facts produce byte-identical rows (v3 §2.3).
 */
export function canonicalProps(props: Readonly<Record<string, string | number | boolean | null>>): string {
  const keys = Object.keys(props).sort();
  const out: Record<string, string | number | boolean | null> = {};
  for (const k of keys) out[k] = props[k] ?? null;
  return JSON.stringify(out);
}

export function parseProps(json: string): Readonly<Record<string, string | number | boolean | null>> {
  return JSON.parse(json) as Record<string, string | number | boolean | null>;
}

export interface NodeRow {
  id: string;
  repo: string;
  kind: string;
  name: string;
  path: string | null;
  sensitivity: string;
  provenance: string;
  confidence: number;
  source_ref: string | null;
  untrusted: number;
  props: string;
  run_id: string;
  first_seen_run: string;
  last_seen_run: string;
  deleted_at: string | null;
}

export interface EdgeRow {
  scope: string;
  src_id: string;
  dst_id: string;
  kind: string;
  src_file: string | null;
  dst_file: string | null;
  provenance: string;
  confidence: number;
  source_ref: string | null;
  props: string;
  run_id: string;
  first_seen_run: string;
  last_seen_run: string;
  deleted_at: string | null;
}

/**
 * The `last_seen_run` of a row that an earlier attempt at `runId` stamped and the
 * attempt now running has not seen again (`SqliteStore.restartRun`). It is not any
 * run's id (`beginRun` and `restartRun` refuse an id that starts with the prefix),
 * so the sweep's `last_seen_run <> :run_id` reads such a row as unseen. It carries
 * the run id so that one run's leftovers are never mistaken for another's, and it
 * sorts before every ordinary run id, as an unseen row's stamp should.
 *
 * It exists on disk only, and no reader sees it: `visibleLastSeen` strips it.
 * A crash between `restartRun` and `finalizeRun` leaves it on the rows the
 * attempt had not re-observed, and it stays there through the finalize of any
 * run that does not cover them, until an attempt at the same run id finalizes.
 */
export const SUPERSEDED_PREFIX = '!superseded:';
export const supersededStamp = (runId: string): string => `${SUPERSEDED_PREFIX}${runId}`;

/**
 * What a reader is told a row's `last_seen_run` is. A set-aside row was last seen
 * by the run whose id the stamp carries, so that is what it reports.
 */
export function visibleLastSeen(stamp: string): string {
  return stamp.startsWith(SUPERSEDED_PREFIX) ? stamp.slice(SUPERSEDED_PREFIX.length) : stamp;
}

/**
 * Optional fields are omitted rather than set to `undefined`: the repo compiles
 * with `exactOptionalPropertyTypes`, and a present-but-undefined key would also
 * change the canonical serialization of a node.
 */
export function rowToNode(row: NodeRow): SeamlineNode {
  return {
    id: row.id as NodeId,
    kind: row.kind as NodeKind,
    name: row.name,
    ...(row.path === null ? {} : { path: row.path }),
    sensitivity: row.sensitivity as Sensitivity,
    provenance: row.provenance as Provenance,
    confidence: row.confidence,
    ...(row.source_ref === null ? {} : { sourceRef: row.source_ref }),
    ...(row.untrusted === 0 ? {} : { untrusted: true }),
    props: parseProps(row.props),
    firstSeenRun: row.first_seen_run,
    lastSeenRun: visibleLastSeen(row.last_seen_run),
    deletedAt: row.deleted_at,
  };
}

export function rowToEdge(row: EdgeRow): SeamlineEdge {
  return {
    kind: row.kind as EdgeKind,
    src: row.src_id as NodeId,
    dst: row.dst_id as NodeId,
    ...(row.src_file === null ? {} : { srcFile: row.src_file }),
    ...(row.dst_file === null ? {} : { dstFile: row.dst_file }),
    provenance: row.provenance as Provenance,
    confidence: row.confidence,
    ...(row.source_ref === null ? {} : { sourceRef: row.source_ref }),
    props: parseProps(row.props),
    firstSeenRun: row.first_seen_run,
    lastSeenRun: visibleLastSeen(row.last_seen_run),
    deletedAt: row.deleted_at,
  };
}

/** `repo` is a derived column: it is the first segment of the natural key. */
export function repoOf(id: NodeId): string {
  return parseNodeId(id).repo;
}
