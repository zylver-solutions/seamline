/** Durable, scoped semantic transactions. No raw SQL/query surface is exported. */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../merge/serialize.ts';
import { CompiledRegistry, cloneValue } from './registry.ts';
import {
  checkRecordFilter,
  disclose,
  inheritedWithheld,
  requireCoverage,
  requireFilterFor,
  type ReleaseScope,
} from './disclosure.ts';
import type {
  Access,
  Changes,
  Entity,
  ExportPolicy,
  Ledger,
  Receipt,
  RecordFilter,
  Scope,
  Snapshot,
  SnapshotRequest,
  SnapshotResult,
  Submission,
  Temporal,
  Timeline,
} from './types.ts';

const MAX_BYTES = 4_000_000;
const MAX_RECORDS = 12_000;
const MAX_BOUNDARIES = 512;
const EMPTY: Ledger = { entities: [], relations: [], barriers: [] };

function id(value: string, name: string): void {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
}
function tick(value: number): void {
  if (!Number.isSafeInteger(value)) throw new Error('Timeline ticks must be safe integers');
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid revision');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function encode(value: unknown): string {
  const text = canonicalJson(cloneValue(value));
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Semantic state exceeds byte budget');
  return text;
}
/**
 * A detached plain copy of a caller-supplied request or policy, read exactly once: accessor or
 * non-enumerable properties are rejected and undefined-valued keys dropped, so no later read can
 * see a different value than the checks did.
 */
function detach<T>(value: T, invalid: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(invalid);
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const entry = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !('value' in entry) || !entry.enumerable)
      throw new Error(`${invalid}: only plain data properties are accepted`);
    if (entry.value !== undefined) copy[key] = entry.value;
  }
  return cloneValue(copy) as T;
}
function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function active(record: Temporal, timeline: string, at: number): boolean {
  return (
    record.timeline === timeline &&
    record.validFrom <= at &&
    (record.validTo === null || at < record.validTo)
  );
}
function project(ledger: Ledger, timeline: string, at: number): Snapshot {
  const entities = ledger.entities
    .filter((e) => active(e, timeline, at))
    .map((e) => ({ id: e.id, type: e.type, properties: e.properties }));
  const relations = ledger.relations
    .filter((e) => active(e, timeline, at))
    .map((e) => ({ id: e.id, type: e.type, from: e.from, to: e.to, properties: e.properties }));
  return cloneValue({ entities, relations });
}

/** Replace only the requested interval, retaining earlier/later history. */
function replace<T extends { id: string }>(
  records: (T & Temporal)[],
  key: string,
  next: T | undefined,
  interval: Temporal,
): (T & Temporal)[] {
  const result: (T & Temporal)[] = [];
  const end = interval.validTo ?? Infinity;
  for (const record of records) {
    if (
      record.id === key &&
      record.timeline === interval.timeline &&
      record.validFrom > interval.validFrom &&
      record.validFrom < end
    ) {
      throw new Error(
        'Mutation would overwrite a later change; bound validUntil at the next change',
      );
    }
    const recordEnd = record.validTo ?? Infinity;
    if (
      record.id !== key ||
      record.timeline !== interval.timeline ||
      recordEnd <= interval.validFrom ||
      record.validFrom >= end
    ) {
      result.push(record);
      continue;
    }
    if (record.validFrom < interval.validFrom)
      result.push({ ...record, validTo: interval.validFrom });
    if (recordEnd > end) result.push({ ...record, validFrom: end });
  }
  if (next) result.push({ ...next, ...interval });
  return result.sort((a, b) =>
    a.timeline < b.timeline
      ? -1
      : a.timeline > b.timeline
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : a.validFrom - b.validFrom,
  );
}

function apply(ledger: Ledger, changes: Changes, interval: Temporal): Ledger {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes))
    throw new Error('Changes must be a record');
  const allowed = new Set(['putEntities', 'removeEntities', 'putRelations', 'removeRelations']);
  for (const key of Object.keys(changes))
    if (!allowed.has(key)) throw new Error(`Unknown change operation ${key}`);
  const result = cloneValue(ledger);
  // Absence is a retained temporal decision. Active rows alone cannot remember
  // a deletion that removed the complete lifetime of a record. Boundaries live
  // inside each revision so forks inherit exactly their pinned parent's view.
  const barriers = new Map<string, { id: string; timeline: string; validAt: number }>();
  const remember = (key: string, timeline: string, validAt: number): void => {
    barriers.set(canonicalJson([timeline, key, validAt]), { id: key, timeline, validAt });
  };
  for (const barrier of ledger.barriers ?? [])
    remember(barrier.id, barrier.timeline, barrier.validAt);
  // Also preserve boundaries in older internally-created ledgers without the
  // optional collection. An empty old ledger has no recoverable prior history.
  for (const record of [...ledger.entities, ...ledger.relations]) {
    remember(record.id, record.timeline, record.validFrom);
    if (record.validTo !== null) remember(record.id, record.timeline, record.validTo);
  }
  const retained = [...barriers.values()];
  const mutate = <T extends { id: string }>(
    records: (T & Temporal)[],
    puts: readonly T[],
    removes: readonly string[],
  ) => {
    if (!Array.isArray(puts) || !Array.isArray(removes))
      throw new Error('Changes must contain arrays');
    const seen = new Set<string>();
    for (const key of [...puts.map((p) => p.id), ...removes]) {
      id(key, 'record id');
      if (seen.has(key)) throw new Error(`Duplicate change for ${key}`);
      seen.add(key);
      if (
        retained.some(
          (barrier) =>
            barrier.id === key &&
            barrier.timeline === interval.timeline &&
            barrier.validAt > interval.validFrom &&
            barrier.validAt < (interval.validTo ?? Infinity),
        )
      ) {
        throw new Error(
          'Mutation would overwrite a later change or deletion; bound validUntil at the next change',
        );
      }
      remember(key, interval.timeline, interval.validFrom);
      if (interval.validTo !== null) remember(key, interval.timeline, interval.validTo);
    }
    let updated = records;
    for (const put of puts) updated = replace(updated, put.id, put, interval);
    for (const key of removes) updated = replace(updated, key, undefined, interval);
    return updated;
  };
  result.entities = mutate(
    result.entities,
    changes.putEntities ?? [],
    changes.removeEntities ?? [],
  );
  result.relations = mutate(
    result.relations,
    changes.putRelations ?? [],
    changes.removeRelations ?? [],
  );
  result.barriers = [...barriers.values()].sort((a, b) =>
    a.timeline < b.timeline
      ? -1
      : a.timeline > b.timeline
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : a.validAt - b.validAt,
  );
  if (result.entities.length + result.relations.length + result.barriers.length > MAX_RECORDS)
    throw new Error('Temporal record budget exceeded');
  return result;
}

export interface QueryRequest extends SnapshotRequest {
  from: readonly string[];
  via: readonly string[];
  maxDepth: number;
  limit: number;
  maxSteps?: number;
}
export interface QueryResult {
  revision: number;
  entities: Entity[];
  truncated: boolean;
  steps: number;
}
export interface HistoryEntry {
  receipt: Receipt;
  command: string;
  actor: string;
  timeline: string;
  validAt: number;
  validUntil?: number;
  previousRevision: number;
}

export class SemanticEngine {
  readonly #db: DatabaseSync;
  readonly #registry: CompiledRegistry;
  readonly #access: Access;

  constructor(path: string, registry: CompiledRegistry, access: Access) {
    id(access.tenant, 'tenant');
    id(access.actor, 'actor');
    if (typeof access.authorize !== 'function')
      throw new Error('Host authorization callback required');
    this.#registry = registry;
    this.#access = { ...access };
    this.#db = new DatabaseSync(path);
    try {
      this.#db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS semantic_meta(version INTEGER NOT NULL) STRICT;`);
      const versionRow = this.#db.prepare('SELECT version FROM semantic_meta').get() as
        { version: number } | undefined;
      if (versionRow && versionRow.version !== 2)
        throw new Error('Unsupported semantic storage version');
      if (!versionRow) this.#db.exec('INSERT INTO semantic_meta VALUES (2)');
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_universes(tenant TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,definition TEXT NOT NULL,PRIMARY KEY(tenant,id)) STRICT;
        CREATE TABLE IF NOT EXISTS semantic_worlds(tenant TEXT NOT NULL,id TEXT NOT NULL,universe TEXT NOT NULL,timelines TEXT NOT NULL,PRIMARY KEY(tenant,id),FOREIGN KEY(tenant,universe) REFERENCES semantic_universes(tenant,id)) STRICT;
        CREATE TABLE IF NOT EXISTS semantic_branches(tenant TEXT NOT NULL,world TEXT NOT NULL,id TEXT NOT NULL,head INTEGER NOT NULL,parent TEXT,parent_revision INTEGER,PRIMARY KEY(tenant,world,id),FOREIGN KEY(tenant,world) REFERENCES semantic_worlds(tenant,id)) STRICT;
        CREATE TABLE IF NOT EXISTS semantic_revisions(tenant TEXT NOT NULL,world TEXT NOT NULL,branch TEXT NOT NULL,revision INTEGER NOT NULL,ledger TEXT NOT NULL,PRIMARY KEY(tenant,world,branch,revision),FOREIGN KEY(tenant,world,branch) REFERENCES semantic_branches(tenant,world,id)) STRICT;
        CREATE TABLE IF NOT EXISTS semantic_receipts(tenant TEXT NOT NULL,world TEXT NOT NULL,branch TEXT NOT NULL,id TEXT NOT NULL,request TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(tenant,world,branch,id),FOREIGN KEY(tenant,world,branch) REFERENCES semantic_branches(tenant,world,id)) STRICT;
        CREATE TABLE IF NOT EXISTS semantic_identities(tenant TEXT NOT NULL,world TEXT NOT NULL,id TEXT NOT NULL,category TEXT NOT NULL,type TEXT NOT NULL,PRIMARY KEY(tenant,world,id),FOREIGN KEY(tenant,world) REFERENCES semantic_worlds(tenant,id)) STRICT;
        CREATE TABLE IF NOT EXISTS semantic_events(tenant TEXT NOT NULL,world TEXT NOT NULL,branch TEXT NOT NULL,revision INTEGER NOT NULL,envelope TEXT NOT NULL,PRIMARY KEY(tenant,world,branch,revision),FOREIGN KEY(tenant,world,branch,revision) REFERENCES semantic_revisions(tenant,world,branch,revision)) STRICT;
      `);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #authorize(operation: 'admin' | 'read' | 'write' | 'export', scope?: Scope): void {
    if (scope) {
      id(scope.world, 'world');
      id(scope.branch, 'branch');
    }
    if (this.#access.authorize(operation, scope ? freeze(cloneValue(scope)) : undefined) !== true)
      throw new Error(`Unauthorized ${operation}`);
  }
  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #world(world: string): Timeline[] {
    id(world, 'world');
    const row = this.#db
      .prepare(
        `SELECT w.timelines,u.fingerprint FROM semantic_worlds w JOIN semantic_universes u ON u.tenant=w.tenant AND u.id=w.universe WHERE w.tenant=? AND w.id=?`,
      )
      .get(this.#access.tenant, world) as { timelines: string; fingerprint: string } | undefined;
    if (!row) throw new Error('Unknown world');
    if (row.fingerprint !== this.#registry.fingerprint)
      throw new Error('Profile fingerprint mismatch; explicit migration required');
    return JSON.parse(row.timelines) as Timeline[];
  }
  #timeline(world: string, timeline: string): void {
    if (!this.#world(world).some((t) => t.id === timeline)) throw new Error('Unknown timeline');
  }
  #head(scope: Scope): number {
    this.#world(scope.world);
    const row = this.#db
      .prepare('SELECT head FROM semantic_branches WHERE tenant=? AND world=? AND id=?')
      .get(this.#access.tenant, scope.world, scope.branch) as { head: number } | undefined;
    if (!row) throw new Error('Unknown branch');
    return row.head;
  }
  /** Every source branch a fork descends from, nearest first, with its fork-point revision. */
  #lineage(scope: Scope): { source: Scope; forkedAt: number }[] {
    const lineage: { source: Scope; forkedAt: number }[] = [];
    const seen = new Set<string>();
    for (let branch = scope.branch; !seen.has(branch);) {
      seen.add(branch);
      const row = this.#db
        .prepare(
          'SELECT parent,parent_revision FROM semantic_branches WHERE tenant=? AND world=? AND id=?',
        )
        .get(this.#access.tenant, scope.world, branch) as
        { parent: string | null; parent_revision: number | null } | undefined;
      if (!row || row.parent === null || row.parent_revision === null) break;
      lineage.push({
        source: { world: scope.world, branch: row.parent },
        forkedAt: row.parent_revision,
      });
      branch = row.parent;
    }
    return lineage;
  }
  /** Each source branch a fork descends from: its ledger at the fork point and at its head. */
  #sources(scope: Scope): { inherited: Ledger; head: Ledger }[] {
    return this.#lineage(scope).map(({ source, forkedAt }) => ({
      inherited: this.#ledger(source, forkedAt),
      head: this.#ledger(source, this.#head(source)),
    }));
  }
  /**
   * An unfiltered read of classified data needs admin authority over the branch and over every
   * source it was forked from, since a fork holds its sources' records.
   */
  #authorizeUnfiltered(scope: Scope): void {
    this.#authorize('admin', scope);
    for (const { source } of this.#lineage(scope)) this.#authorize('admin', source);
  }
  #ledger(scope: Scope, atRevision: number): Ledger {
    revision(atRevision);
    const row = this.#db
      .prepare(
        'SELECT ledger FROM semantic_revisions WHERE tenant=? AND world=? AND branch=? AND revision=?',
      )
      .get(this.#access.tenant, scope.world, scope.branch, atRevision) as
      { ledger: string } | undefined;
    if (!row) throw new Error('Unknown revision');
    return JSON.parse(row.ledger) as Ledger;
  }

  createUniverse(universe: string): void {
    this.#authorize('admin');
    id(universe, 'universe');
    this.#db
      .prepare('INSERT INTO semantic_universes VALUES (?,?,?,?)')
      .run(
        this.#access.tenant,
        universe,
        this.#registry.fingerprint,
        encode(this.#registry.descriptor()),
      );
  }

  createWorld(universe: string, world: string, timelines: readonly Timeline[]): void {
    this.#authorize('admin', { world, branch: 'main' });
    id(universe, 'universe');
    const safe = cloneValue(timelines);
    if (!Array.isArray(safe) || safe.length < 1 || safe.length > 16)
      throw new Error('World needs 1..16 timelines');
    const ids = new Set<string>();
    for (const timeline of safe) {
      if (
        !timeline ||
        typeof timeline !== 'object' ||
        Object.keys(timeline).some((key) => !['id', 'unit', 'ticksPerUnit'].includes(key))
      )
        throw new Error('Invalid timeline definition');
      id(timeline.id, 'timeline');
      id(timeline.unit, 'timeline unit');
      if (ids.has(timeline.id)) throw new Error('Duplicate timeline');
      ids.add(timeline.id);
      if (
        !timeline.ticksPerUnit ||
        Object.keys(timeline.ticksPerUnit).some(
          (key) => !['numerator', 'denominator'].includes(key),
        )
      )
        throw new Error('Invalid timebase');
      for (const n of [timeline.ticksPerUnit.numerator, timeline.ticksPerUnit.denominator]) {
        if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid rational timebase');
      }
    }
    this.#transaction(() => {
      const row = this.#db
        .prepare('SELECT fingerprint FROM semantic_universes WHERE tenant=? AND id=?')
        .get(this.#access.tenant, universe) as { fingerprint: string } | undefined;
      if (!row || row.fingerprint !== this.#registry.fingerprint)
        throw new Error('Unknown or incompatible universe');
      this.#db
        .prepare('INSERT INTO semantic_worlds VALUES (?,?,?,?)')
        .run(this.#access.tenant, world, universe, encode(safe));
      this.#db
        .prepare('INSERT INTO semantic_branches VALUES (?,?,?,0,NULL,NULL)')
        .run(this.#access.tenant, world, 'main');
      this.#db
        .prepare('INSERT INTO semantic_revisions VALUES (?,?,?,0,?)')
        .run(this.#access.tenant, world, 'main', encode(EMPTY));
    });
  }

  fork(scope: Scope, branch: string, atRevision: number): void {
    this.#authorize('read', scope);
    this.#authorize('admin', { world: scope.world, branch });
    id(branch, 'branch');
    revision(atRevision);
    this.#transaction(() => {
      this.#head(scope);
      const ledger = this.#ledger(scope, atRevision);
      this.#db
        .prepare('INSERT INTO semantic_branches VALUES (?,?,?,0,?,?)')
        .run(this.#access.tenant, scope.world, branch, scope.branch, atRevision);
      this.#db
        .prepare('INSERT INTO semantic_revisions VALUES (?,?,?,0,?)')
        .run(this.#access.tenant, scope.world, branch, encode(ledger));
    });
  }

  submit(input: Submission): Receipt {
    const request = cloneValue(input);
    this.#authorize('write', request.scope);
    id(request.commandId, 'command id');
    revision(request.expectedRevision);
    tick(request.validAt);
    if (request.validUntil !== undefined) {
      tick(request.validUntil);
      if (request.validUntil <= request.validAt) throw new Error('Invalid half-open interval');
    }
    this.#timeline(request.scope.world, request.timeline);
    // Receipts persist a digest, never raw source content or credentials in args.
    const encoded = hash(encode({ request, actor: this.#access.actor }));
    return this.#transaction(() => {
      const priorReceipt = this.#db
        .prepare(
          'SELECT request,receipt FROM semantic_receipts WHERE tenant=? AND world=? AND branch=? AND id=?',
        )
        .get(this.#access.tenant, request.scope.world, request.scope.branch, request.commandId) as
        { request: string; receipt: string } | undefined;
      if (priorReceipt) {
        if (priorReceipt.request !== encoded)
          throw new Error('Idempotency key reused with different payload');
        return JSON.parse(priorReceipt.receipt) as Receipt;
      }
      const head = this.#head(request.scope);
      if (head !== request.expectedRevision)
        throw new Error(`Revision conflict: expected ${request.expectedRevision}, current ${head}`);
      const before = this.#ledger(request.scope, head);
      const snapshot = project(before, request.timeline, request.validAt);
      this.#registry.validateInput(request.command, request.args, snapshot);
      const command = this.#registry.command(request.command);
      const changes = cloneValue(
        command.apply(
          freeze({
            snapshot,
            actor: this.#access.actor,
            timeline: request.timeline,
            validAt: request.validAt,
            ...(request.validUntil === undefined ? {} : { validUntil: request.validUntil }),
          }),
          freeze(request.args),
        ),
      );
      const interval = {
        timeline: request.timeline,
        validFrom: request.validAt,
        validTo: request.validUntil ?? null,
      };
      const after = apply(before, changes, interval);
      const boundaries = new Set<number>([request.validAt]);
      for (const record of [
        ...before.entities,
        ...before.relations,
        ...after.entities,
        ...after.relations,
      ]) {
        if (record.timeline !== request.timeline) continue;
        boundaries.add(record.validFrom);
        if (record.validTo !== null) boundaries.add(record.validTo);
      }
      for (const barrier of after.barriers ?? []) {
        if (barrier.timeline === request.timeline) boundaries.add(barrier.validAt);
      }
      if (boundaries.size > MAX_BOUNDARIES) throw new Error('Temporal validation budget exceeded');
      for (const boundary of [...boundaries].sort((a, b) => a - b)) {
        this.#registry.validate(
          project(after, request.timeline, boundary),
          project(before, request.timeline, boundary),
          request.command,
        );
      }
      // An instance cannot change its registered type across time or timelines.
      for (const collection of [
        [...before.entities, ...after.entities],
        [...before.relations, ...after.relations],
      ]) {
        const seen = new Map<string, string>();
        for (const item of collection) {
          if (seen.has(item.id) && seen.get(item.id) !== item.type)
            throw new Error('Instance type cannot change');
          seen.set(item.id, item.type);
        }
      }
      const ledgerText = encode(after);
      for (const [category, collection] of [
        ['entity', after.entities],
        ['relation', after.relations],
      ] as const) {
        for (const record of collection) {
          const identity = this.#db
            .prepare(
              'SELECT category,type FROM semantic_identities WHERE tenant=? AND world=? AND id=?',
            )
            .get(this.#access.tenant, request.scope.world, record.id) as
            { category: string; type: string } | undefined;
          if (identity && (identity.category !== category || identity.type !== record.type))
            throw new Error('Persistent identity cannot change category or type');
          if (!identity)
            this.#db
              .prepare('INSERT INTO semantic_identities VALUES (?,?,?,?,?)')
              .run(this.#access.tenant, request.scope.world, record.id, category, record.type);
        }
      }
      const next = head + 1;
      revision(next);
      const receipt = {
        commandId: request.commandId,
        revision: next,
        fingerprint: hash(ledgerText),
      };
      this.#db
        .prepare('INSERT INTO semantic_revisions VALUES (?,?,?,?,?)')
        .run(this.#access.tenant, request.scope.world, request.scope.branch, next, ledgerText);
      const event: HistoryEntry = {
        receipt,
        command: request.command,
        actor: this.#access.actor,
        timeline: request.timeline,
        validAt: request.validAt,
        ...(request.validUntil === undefined ? {} : { validUntil: request.validUntil }),
        previousRevision: head,
      };
      this.#db
        .prepare('INSERT INTO semantic_events VALUES (?,?,?,?,?)')
        .run(this.#access.tenant, request.scope.world, request.scope.branch, next, encode(event));
      this.#db
        .prepare('INSERT INTO semantic_receipts VALUES (?,?,?,?,?,?)')
        .run(
          this.#access.tenant,
          request.scope.world,
          request.scope.branch,
          request.commandId,
          encoded,
          encode(receipt),
        );
      this.#db
        .prepare('UPDATE semantic_branches SET head=? WHERE tenant=? AND world=? AND id=?')
        .run(next, this.#access.tenant, request.scope.world, request.scope.branch);
      return receipt;
    });
  }

  snapshot(scope: Scope, request: SnapshotRequest): SnapshotResult {
    return this.#snapshot(scope, detach(request, 'Invalid snapshot request'), []);
  }

  /**
   * The single read path: snapshot, query and export all disclose through it. Reading without a
   * record filter is default-deny when a releasable type can carry a classification, and the
   * admin-only `unfiltered` flag is the way past it. A filtered read uses the head revision only,
   * so a record reclassified by a later revision cannot be read back through an earlier one.
   * `request` must already be detached.
   */
  #snapshot(
    scope: Scope,
    request: SnapshotRequest,
    extra: readonly RecordFilter[],
    release?: ReleaseScope,
  ): SnapshotResult {
    this.#authorize('read', scope);
    const filters =
      request.where === undefined
        ? extra
        : [checkRecordFilter(this.#registry, request.where), ...extra];
    const { unfiltered } = request;
    if (unfiltered !== undefined && typeof unfiltered !== 'boolean')
      throw new Error('The unfiltered flag must be a boolean');
    if (unfiltered === true) {
      if (filters.length) throw new Error('An unfiltered read cannot carry a record filter');
      this.#authorizeUnfiltered(scope);
    } else if (!filters.length) {
      requireFilterFor(this.#registry, release);
    }
    if (filters.length) {
      requireCoverage(this.#registry, filters, release);
      if (request.revision !== undefined)
        throw new Error('Record filters read the head revision only');
    }
    tick(request.validAt);
    this.#timeline(scope.world, request.timeline);
    const head = this.#head(scope);
    const atRevision = request.revision ?? head;
    const ledger = this.#ledger(scope, atRevision);
    const snapshot = project(ledger, request.timeline, request.validAt);
    return {
      revision: atRevision,
      snapshot: filters.length
        ? disclose(this.#registry, snapshot, filters, {
            versions: [...ledger.entities, ...ledger.relations],
            ...(release === undefined ? {} : { release }),
            withheld: inheritedWithheld(filters, this.#sources(scope)),
          })
        : snapshot,
    };
  }

  /** This branch's accepted commands, newest first. Payloads are intentionally absent. */
  history(
    scope: Scope,
    options: {
      beforeRevision?: number;
      limit: number;
      /** Refused: history lists every accepted command, so it cannot honor a record filter. */
      where?: RecordFilter;
    },
  ): HistoryEntry[] {
    this.#authorize('read', scope);
    if (options.where !== undefined)
      throw new Error('History is not available under a record filter');
    const head = this.#head(scope);
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500)
      throw new Error('History limit must be 1..500');
    const before = options.beforeRevision ?? head + 1;
    revision(before);
    return this.#db
      .prepare(
        'SELECT envelope FROM semantic_events WHERE tenant=? AND world=? AND branch=? AND revision<? ORDER BY revision DESC LIMIT ?',
      )
      .all(this.#access.tenant, scope.world, scope.branch, before, options.limit)
      .map((row) => JSON.parse(row['envelope'] as string) as HistoryEntry);
  }

  query(scope: Scope, input: QueryRequest): QueryResult {
    const request = detach(input, 'Invalid query request');
    if (
      !Array.isArray(request.from) ||
      request.from.length > 64 ||
      request.from.length < 1 ||
      !Array.isArray(request.via) ||
      request.via.length > 32
    )
      throw new Error('Query input budget exceeded');
    if (
      !Number.isInteger(request.maxDepth) ||
      request.maxDepth < 0 ||
      request.maxDepth > 8 ||
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 500
    )
      throw new Error('Query bounds exceeded');
    const maxSteps = request.maxSteps ?? 10_000;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10_000)
      throw new Error('Query work budget exceeded');
    for (const key of request.from) id(key, 'query start');
    for (const type of request.via) {
      id(type, 'query relation');
      this.#registry.relation(type);
    }
    const result = this.snapshot(scope, request);
    const nodes = new Map(result.snapshot.entities.map((e) => [e.id, e]));
    const queue = request.from.map((key) => ({ key, depth: 0 }));
    const visited = new Set<string>();
    const output: Entity[] = [];
    let steps = 0;
    let truncated = false;
    while (queue.length) {
      if (++steps > maxSteps) {
        truncated = true;
        break;
      }
      const { key, depth } = queue.shift()!;
      if (visited.has(key)) continue;
      visited.add(key);
      const node = nodes.get(key);
      if (!node) continue;
      if (output.length === request.limit) {
        truncated = true;
        break;
      }
      output.push(node);
      if (depth === request.maxDepth) continue;
      for (const edge of result.snapshot.relations) {
        if (++steps > maxSteps) {
          truncated = true;
          break;
        }
        if (edge.from === key && request.via.includes(edge.type))
          queue.push({ key: edge.to, depth: depth + 1 });
      }
      if (truncated) break;
    }
    return {
      revision: result.revision,
      entities: output,
      truncated,
      steps: Math.min(steps, maxSteps),
    };
  }

  exportSnapshot(
    scope: Scope,
    requestInput: SnapshotRequest,
    policyInput: ExportPolicy,
  ): SnapshotResult {
    this.#authorize('export', scope);
    const request = detach(requestInput, 'Invalid snapshot request');
    const policy = detach(policyInput, 'Explicit export allowlist required');
    if (
      !Array.isArray(policy.types) ||
      policy.types.length === 0 ||
      policy.types.length > 128 ||
      !policy.fields ||
      typeof policy.fields !== 'object' ||
      Array.isArray(policy.fields)
    )
      throw new Error('Explicit export allowlist required');
    for (const type of policy.types) {
      id(type, 'export type');
      let fields: readonly string[];
      try {
        fields = Object.keys(this.#registry.type(type).fields);
      } catch {
        fields = Object.keys(this.#registry.relation(type).fields);
      }
      const selected = policy.fields[type];
      if (
        !Array.isArray(selected) ||
        selected.length > 256 ||
        selected.some((field) => typeof field !== 'string' || !fields.includes(field))
      )
        throw new Error('Invalid export field allowlist');
    }
    if (Object.keys(policy.fields).some((type) => !policy.types.includes(type)))
      throw new Error('Export fields require allowed type');
    if (request.unfiltered !== undefined)
      throw new Error('An export takes unfiltered on its policy, not its request');
    const filters =
      policy.where === undefined ? [] : [checkRecordFilter(this.#registry, policy.where)];
    const result = this.#snapshot(
      scope,
      policy.unfiltered === undefined ? request : { ...request, unfiltered: policy.unfiltered },
      filters,
      policy,
    );
    const entities = result.snapshot.entities
      .filter((e) => policy.types.includes(e.type))
      .map((e) => ({
        ...e,
        properties: Object.fromEntries(
          Object.entries(e.properties).filter(([key]) => policy.fields[e.type]?.includes(key)),
        ),
      }));
    const ids = new Set(entities.map((e) => e.id));
    const relations = result.snapshot.relations
      .filter((e) => policy.types.includes(e.type) && ids.has(e.from) && ids.has(e.to))
      .map((e) => ({
        ...e,
        properties: Object.fromEntries(
          Object.entries(e.properties).filter(([key]) => policy.fields[e.type]?.includes(key)),
        ),
      }));
    return { revision: result.revision, snapshot: { entities, relations } };
  }

  close(): void {
    this.#db.close();
  }
}
