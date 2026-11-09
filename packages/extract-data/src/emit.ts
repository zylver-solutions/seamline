/**
 * Turns the intermediate schema model into `SeamlineNode`/`SeamlineEdge`.
 *
 * Two invariants live here rather than in the parsers, because they are
 * properties of the *output*, not of any one source format:
 *
 * - **Identity is path-free** (v3 §2.1). A column is
 *   `{repo}:Column:{schema}.{table}.{column}`, so moving `schema.sql` changes
 *   no table or column id. Two things read a path (ADR-0016 item 4): a
 *   `Migration` id is its version, taken from the file or directory name, and
 *   the order in which SQL sources are applied is their path order, which
 *   decides the names a table or column ends with when two sources do not
 *   commute. The file is carried as the `path` property and as
 *   `srcFile`/`dstFile` on every edge, which is what the re-run invalidation
 *   rule reads.
 * - **Output is byte-reproducible** (v3 §2.3). Nodes sort by id, edges by
 *   (kind, src, dst), every props object has sorted keys, and nothing here
 *   reads a clock.
 */

import {
  DEFAULT_SENSITIVITY,
  type EdgeKind,
  isValidEdge,
  type NodeId,
  type NodeKind,
  nodeId,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import { columnName, makeNodeId, schemaName, tableName } from '@seamline/core';
import {
  suppliesNullList,
  type ColumnFact,
  type OrmName,
  type SchemaModel,
  type TableFact,
} from './model.ts';
import { classifyPii } from './pii.ts';

/** `model`'s dataSource, only when the caller actually configured one (v3 §2.1). */
function identityDataSource(model: SchemaModel): string | undefined {
  return model.hasExplicitDataSource ? model.dataSource : undefined;
}

/** Adds `dataSource` only when set -- `exactOptionalPropertyTypes` rejects an explicit `undefined`. */
function withDataSource<T extends object>(base: T, dataSource: string | undefined): T & { dataSource?: string } {
  return dataSource === undefined ? base : { ...base, dataSource };
}

export interface EmitOptions {
  readonly repo: string;
  readonly runId: string;
  readonly dialect: string;
}

type PropValue = string | number | boolean | null;

/** Sorted-key props object, so serialization is byte-stable. */
function props(entries: Readonly<Record<string, PropValue>>): Readonly<Record<string, PropValue>> {
  const out: Record<string, PropValue> = {};
  for (const key of Object.keys(entries).sort()) out[key] = entries[key] as PropValue;
  return out;
}

function joinSorted(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  return [...values].sort().join(' AND ');
}

export interface EmitResult {
  readonly nodes: readonly SeamlineNode[];
  readonly edges: readonly SeamlineEdge[];
  readonly diagnostics: readonly string[];
}

interface Builder {
  readonly nodes: SeamlineNode[];
  readonly edges: SeamlineEdge[];
  readonly kindById: Map<string, NodeKind>;
  readonly fileById: Map<string, string>;
  readonly diagnostics: string[];
}

function addNode(
  b: Builder,
  opts: EmitOptions,
  kind: NodeKind,
  canonicalName: string,
  name: string,
  path: string | null,
  line: number | null,
  body: Readonly<Record<string, PropValue>>,
): NodeId {
  // A Migration name is assembled by `migrationName` (migration-ids.ts); minting its id through
  // `makeNodeId` makes the repository's validator the arbiter of what a Migration id is, so an id
  // this extractor emits is one an Alias or any other validating caller accepts. The other kinds
  // are built by their own name builders above and keep the plain constructor.
  const id =
    kind === 'Migration'
      ? makeNodeId(opts.repo, kind, canonicalName)
      : nodeId(opts.repo, kind, canonicalName);
  const base = {
    id,
    kind,
    name,
    // Replay tuples copy data-model identifiers onto a history node. They
    // inherit the data surface's confidentiality instead of travelling under
    // Migration's older metadata-only internal classification.
    sensitivity: kind === 'Migration' && body['replayVersion'] === 1
      ? 'confidential' as const
      : DEFAULT_SENSITIVITY[kind],
    provenance: 'EXTRACTED' as const,
    confidence: 1,
    props: props(body),
    firstSeenRun: opts.runId,
    lastSeenRun: opts.runId,
    deletedAt: null,
  };
  const node: SeamlineNode =
    path === null
      ? base
      : { ...base, path, sourceRef: line === null ? path : `${path}:${line}` };
  b.nodes.push(node);
  b.kindById.set(id, kind);
  if (path !== null) b.fileById.set(id, path);
  return id;
}

function addEdge(
  b: Builder,
  opts: EmitOptions,
  kind: EdgeKind,
  src: NodeId,
  dst: NodeId,
  body: Readonly<Record<string, PropValue>> = {},
): void {
  const srcKind = b.kindById.get(src);
  const dstKind = b.kindById.get(dst);
  if (srcKind === undefined || dstKind === undefined) {
    b.diagnostics.push(`edge ${kind} skipped: endpoint not emitted (${src} -> ${dst})`);
    return;
  }
  // v3 §4: every edge declares domain and range, and `ontology lint` fails the
  // build on any edge used outside them. An extractor that emits one is a bug
  // in the extractor, so this throws rather than warning.
  if (!isValidEdge(kind, srcKind, dstKind)) {
    throw new Error(`extract-data emitted an invalid edge: ${kind} ${srcKind} -> ${dstKind}`);
  }
  const srcFile = b.fileById.get(src);
  const dstFile = b.fileById.get(dst);
  const base = {
    kind,
    src,
    dst,
    provenance: 'EXTRACTED' as const,
    confidence: 1,
    props: props(body),
    firstSeenRun: opts.runId,
    lastSeenRun: opts.runId,
    deletedAt: null,
  };
  const withSrc = srcFile === undefined ? base : { ...base, srcFile };
  const edge: SeamlineEdge = dstFile === undefined ? withSrc : { ...withSrc, dstFile };
  b.edges.push(edge);
}

/**
 * What this run can vouch for, given which sources it failed to read.
 *
 * Every fact below that says "none" or "only" (no default, no trigger, one
 * declaration, no dynamic DDL) is true of the files read, so it is written only
 * when no file of the kind that could contradict it went unread. Otherwise the
 * prop is left off and a consumer reads it as unknown, never as zero.
 */
interface Known {
  /** A client-side default, or no default, is only certain if no source went unread. */
  readonly defaults: boolean;
  readonly declarations: boolean;
  /**
   * A trigger that was seen can be reported. An unread SQL file or a construct
   * that hides statements might have dropped it, so either one withholds it.
   */
  readonly seenTriggers: boolean;
  /**
   * `false` can be reported for a table with no trigger seen. A `CREATE TRIGGER`
   * that could not be attributed to a table might be on this one, so it
   * withholds `false` (and, as it can only add a trigger, leaves a seen one alone).
   */
  readonly noTriggers: boolean;
  readonly dynamicDdl: boolean;
}

function knownFacts(model: SchemaModel): Known {
  const unread = model.unreadSources;
  const seenTriggers = !unread.has('sql') && !unread.has('sql-migration') && model.hiddenTriggers === 0;
  return {
    defaults: unread.size === 0,
    declarations: !unread.has('prisma') && !unread.has('drizzle') && !unread.has('sql'),
    seenTriggers,
    noTriggers: seenTriggers && model.unresolvedTriggers === 0,
    // A `DO` block counts in any SQL file, so an unread file of either kind might hold one.
    dynamicDdl: !unread.has('sql-migration') && !unread.has('sql'),
  };
}

/**
 * Where the column's default is supplied: `db` when any source declares one the
 * database supplies, whatever else is declared; `client` when every declared
 * default is the ORM's; `none` when no source declares one.
 *
 * An unread source can add a database default or remove one (an unread
 * migration may `DROP DEFAULT`), so with one unread neither `client` nor `none`
 * is certain and both are withheld, and `db` is not certain either. `db` is kept
 * because it is the safe direction: a consumer that reads it stays silent about
 * the column, which is also what the unread file's best case for the column is.
 * A reader that needs a certain answer gates on `defaultSite` and on the run's
 * diagnostics, never on `hasDefault`.
 */
function defaultSite(col: ColumnFact, known: Known): string | undefined {
  if (col.dbDefault || suppliesNullList(col)) return 'db';
  if (!known.defaults) return undefined;
  return col.clientDefault ? 'client' : 'none';
}

function columnProps(
  model: SchemaModel,
  col: ColumnFact,
  dialect: string,
  known: Known,
): Readonly<Record<string, PropValue>> {
  const pii = classifyPii(col.name, col.category, col.comment);
  const site = defaultSite(col, known);
  return {
    column: col.name,
    table: col.table,
    schema: col.schema,
    dataSource: model.dataSource,
    dialect: col.dialect ?? dialect, // the recognised dialect, else the extractor-wide one
    type: col.type,
    declaredType: col.declaredType,
    typeCategory: col.category,
    isArray: col.isArray,
    nullable: col.nullable,
    hasDefault: col.hasDefault,
    ...(site === undefined ? {} : { defaultSite: site }),
    defaultExpr: col.defaultExpr,
    isPrimaryKey: col.isPrimaryKey,
    isUnique: col.isUnique,
    maxLength: col.maxLength,
    numericPrecision: col.numericPrecision,
    numericScale: col.numericScale,
    checkConstraint: joinSorted(col.checks),
    checkCount: col.checks.length,
    comment: col.comment,
    ordinal: col.ordinal,
    // The column is EXTRACTED; the PII label on it is not. Downstream must
    // read `piiProvenance` before treating this as fact (v3 §2.4).
    pii: pii.category,
    piiConfidence: pii.confidence,
    piiProvenance: pii.category === 'none' ? 'EXTRACTED' : 'INFERRED',
    piiEvidence: pii.evidence === '' ? null : pii.evidence,
    sourceKinds: [...col.sources].sort().join(','),
  };
}

/**
 * `insertTrigger` for one table: a trigger that was seen stands unless an unread
 * file or a hidden block might have dropped it; `false` is written only when
 * nothing unread or unattributed might have added one.
 */
function insertTriggerProp(model: SchemaModel, tf: TableFact, known: Known): Readonly<Record<string, PropValue>> {
  if (model.hasInsertTrigger(tf.schema, tf.name)) return known.seenTriggers ? { insertTrigger: true } : {};
  return known.noTriggers ? { insertTrigger: false } : {};
}

/**
 * The name a client API gives this table: the Prisma model name, or the Drizzle
 * table binding. It is recorded only when it is unambiguous, and absent
 * otherwise, so a reader never has to guess which kind of name it holds:
 *
 * - exactly one ORM source declares the table (a Prisma model and a Drizzle
 *   binding for one table leave it unresolved, because the `ormModel` prop does
 *   not say which of the two it is);
 * - that source gave the table exactly one name (two Prisma models mapped to one
 *   table, or two bindings of one Drizzle table, leave it unresolved).
 *
 * A table with no ORM source (plain SQL, a migration) has no `ormModel`.
 */
function ormModelOf(tf: TableFact): { readonly name: string | null; readonly diagnostic: string | null } {
  if (tf.ormNames.length === 0) return { name: null, diagnostic: null };
  const first = tf.ormNames[0] as OrmName;
  const sources = new Set(tf.sources.filter((s) => s === 'prisma' || s === 'drizzle'));
  if (tf.ormNames.length === 1 && sources.size === 1 && sources.has(first.source)) {
    return { name: first.name, diagnostic: null };
  }
  const names = tf.ormNames.map((n) => `${n.source} ${n.name}`).sort().join(', ');
  return {
    name: null,
    diagnostic: `ormModel not recorded for ${tf.schema}.${tf.name}: the table has more than one ORM declaration (${names})`,
  };
}

function tableProps(
  model: SchemaModel,
  tf: TableFact,
  dialect: string,
  known: Known,
  ormModel: string | null,
): Readonly<Record<string, PropValue>> {
  return {
    table: tf.name,
    schema: tf.schema,
    dataSource: model.dataSource,
    dialect: tf.dialect ?? dialect,
    columnCount: tf.columns.size,
    checkConstraint: joinSorted(tf.checks),
    comment: tf.comment,
    sourceKinds: [...tf.sources].sort().join(','),
    // Distinct non-migration files that declare the table. 0 means only
    // migrations do; more than 1 means the columns below are a union.
    ...(known.declarations ? { declarations: tf.declaredIn.size } : {}),
    // A BEFORE INSERT trigger on the table was seen in an SQL file that was read.
    ...insertTriggerProp(model, tf, known),
    ...(ormModel === null ? {} : { ormModel }),
  };
}

function compareNodes(a: SeamlineNode, b: SeamlineNode): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function edgeSortKey(e: SeamlineEdge): string {
  return `${e.kind}\u0000${e.src}\u0000${e.dst}`;
}

/** Builds the sorted node and edge lists for one extraction. */
export function emit(model: SchemaModel, opts: EmitOptions): EmitResult {
  const b: Builder = { nodes: [], edges: [], kindById: new Map(), fileById: new Map(), diagnostics: [] };

  // No table means no fact anyone can join against. Emitting a lone
  // `DataSource` node would make an empty result look non-empty, which is the
  // exact confusion the UNAVAILABLE-is-never-PASS rule exists to prevent.
  if (model.tableCount() === 0) return { nodes: [], edges: [], diagnostics: [] };

  const known = knownFacts(model);
  const dsId = addNode(b, opts, 'DataSource', model.dataSource, model.dataSource, null, null, {
    dataSource: model.dataSource,
    dialect: opts.dialect,
    // Where an unqualified table name in SQL resolves; the data-model index
    // reads it to bind a statement to a `Table` (data-model-index.ts).
    defaultSchema: model.defaultSchema,
    introspected: false,
    // `DO` blocks and `EXECUTE` statements read (all of them in migrations, the
    // ones that name DDL elsewhere): DDL the replay of the schema could not
    // follow. Absent when a SQL file was not read.
    ...(known.dynamicDdl ? { dynamicDdl: model.dynamicDdl } : {}),
    ...(model.migrationReplay?.dataSource ?? {}),
  });

  // Keyed by canonical name, not version: two migrations can share a version.
  const migrationIds = new Map<string, { readonly id: NodeId; readonly version: string }>();
  for (const m of [...model.migrations].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    const id = addNode(b, opts, 'Migration', m.name, m.name, m.path, 1, {
      version: m.version,
      ordinal: m.ordinal,
      statementCount: m.statementCount,
      dataSource: model.dataSource,
      ...(model.migrationReplay?.migrations.get(m.name) ?? {}),
    });
    migrationIds.set(m.name, { id, version: m.version });
  }

  const ds = identityDataSource(model);
  const schemaKeys = [...model.schemas.keys()].sort();
  for (const schemaKey of schemaKeys) {
    const sf = model.schemas.get(schemaKey);
    if (sf === undefined) continue;
    // A schema with no tables carries no facts anyone can join against, and
    // emitting it would make an empty result look non-empty.
    if (sf.tables.size === 0) continue;
    const schemaNodeId = addNode(
      b,
      opts,
      'Schema',
      schemaName(withDataSource({ schema: sf.name }, ds)),
      sf.name,
      sf.path,
      sf.line,
      {
        schema: sf.name,
        dataSource: model.dataSource,
        dialect: opts.dialect,
        tableCount: sf.tables.size,
      },
    );
    addEdge(b, opts, 'CONTAINS', dsId, schemaNodeId);

    for (const tableKey of [...sf.tables.keys()].sort()) {
      const tf = sf.tables.get(tableKey);
      if (tf === undefined) continue;
      const orm = ormModelOf(tf);
      if (orm.diagnostic !== null) b.diagnostics.push(orm.diagnostic);
      const tableNodeId = addNode(
        b,
        opts,
        'Table',
        tableName(withDataSource({ schema: tf.schema, table: tf.name }, ds)),
        tf.name,
        tf.path,
        tf.line,
        tableProps(model, tf, opts.dialect, known, orm.name),
      );
      addEdge(b, opts, 'CONTAINS', schemaNodeId, tableNodeId);
      for (const migrationKey of [...tf.migrations].sort()) {
        const mig = migrationIds.get(migrationKey);
        if (mig !== undefined) addEdge(b, opts, 'MIGRATED_BY', tableNodeId, mig.id, { version: mig.version });
      }

      for (const columnKey of [...tf.columns.keys()].sort()) {
        const col = tf.columns.get(columnKey);
        if (col === undefined) continue;
        const colNodeId = addNode(
          b,
          opts,
          'Column',
          columnName(withDataSource({ schema: col.schema, table: col.table, column: col.name }, ds)),
          col.name,
          col.path,
          col.line,
          columnProps(model, col, opts.dialect, known),
        );
        addEdge(b, opts, 'CONTAINS', tableNodeId, colNodeId);
        for (const migrationKey of [...col.migrations].sort()) {
          const mig = migrationIds.get(migrationKey);
          if (mig !== undefined) addEdge(b, opts, 'MIGRATED_BY', colNodeId, mig.id, { version: mig.version });
        }
      }
    }
  }

  for (const fk of model.foreignKeys) {
    for (let i = 0; i < fk.columns.length; i += 1) {
      const localName = fk.columns[i];
      const refName = fk.refColumns[i] ?? fk.refColumns[0];
      if (localName === undefined) continue;
      const localExists = model.table(fk.schema, fk.table)?.columns.has(localName) === true;
      const refTable = model.table(fk.refSchema, fk.refTable);
      // A reference to a table this extractor never saw is a real fact about
      // the repo, but it is not an edge: a dangling endpoint would break every
      // traversal that walks FK_TO.
      if (refName === undefined || !localExists || refTable === undefined || !refTable.columns.has(refName)) {
        b.diagnostics.push(
          `FK_TO skipped: ${fk.schema}.${fk.table}.${localName ?? '?'} -> ${fk.refSchema}.${fk.refTable}.${refName ?? '?'} (endpoint not extracted)`,
        );
        continue;
      }
      const src = nodeId(
        opts.repo,
        'Column',
        columnName(withDataSource({ schema: fk.schema, table: fk.table, column: localName }, ds)),
      );
      const dst = nodeId(
        opts.repo,
        'Column',
        columnName(withDataSource({ schema: fk.refSchema, table: fk.refTable, column: refName }, ds)),
      );
      addEdge(b, opts, 'FK_TO', src, dst, {
        constraint: fk.name,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
      });
    }
  }

  b.nodes.sort(compareNodes);
  b.edges.sort((x, y) => {
    const kx = edgeSortKey(x);
    const ky = edgeSortKey(y);
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });

  return { nodes: b.nodes, edges: b.edges, diagnostics: [...b.diagnostics].sort() };
}

/** Recursively key-sorted JSON, for golden files and the determinism gate. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** Canonical SIF-shaped serialization of one extraction's facts. */
export function canonicalSif(nodes: readonly SeamlineNode[], edges: readonly SeamlineEdge[]): string {
  const lines: string[] = [];
  for (const n of nodes) lines.push(canonicalJson({ t: 'node', node: n }));
  for (const e of edges) lines.push(canonicalJson({ t: 'edge', edge: e }));
  return `${lines.join('\n')}\n`;
}
