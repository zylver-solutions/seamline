/**
 * The data-model index: what a code extractor needs to know about the schema
 * without reading it.
 *
 * `extract-code-ts` binds a table name found in a SQL string to a `Table` node,
 * and a Prisma delegate or a Drizzle table binding to the table behind it. It
 * does not read `schema.prisma`, does not depend on this package, and does not
 * re-derive a name. This module is the one place the schema's naming is turned
 * into a document it can read. Design: `docs/design/real-world-inputs.md`,
 * section 3.3.
 *
 * The index is a canonical JSON document, built from this extractor's own
 * output and nothing else, so it is a pure function of the nodes: the same nodes
 * in any order give the same bytes. It travels as text (a string option), which
 * is what lets it cross a process boundary unchanged and makes "the same index
 * in, the same SIF out" a statement about bytes.
 *
 * Format, version 1 (the reader is `parseDataModelIndex` in
 * `@seamline/extract-code-ts`; the integration tests build with one and read
 * with the other):
 *
 * ```text
 * {
 *   "dataSources": [{ "defaultSchema": "public", "dialect": "postgres", "name": "default" }],
 *   "drizzleExports": { "<table binding>": "<table id>" },
 *   "prismaDelegates": { "<delegate>": { "model": "<model name>", "table": "<table id>" } },
 *   "tables": [{ "dataSource": "default", "id": "<table id>", "name": "<table>", "schema": "<schema>" }],
 *                     (plus "dialect" on a table whose own dialect differs from its data source's)
 *   "version": 1
 * }
 * ```
 *
 * A table is identified by `(schema, name)` within its data source, as spelled
 * in the schema (a Prisma model without `@@map` is the mixed-case name
 * `Invitation`, not `invitation`). `defaultSchema` and `dialect` are what a
 * reader needs to decide which table an unqualified or differently cased name
 * means. A delegate or binding that two tables claim is left out of the maps:
 * a name that does not identify one table identifies none.
 */

import type { SeamlineNode } from '@seamline/ontology';
import { canonicalJson } from './emit.ts';

export const DATA_MODEL_INDEX_VERSION = 1;

/** Used when a node does not carry the fact, as `extract-data` itself does. */
const FALLBACK_DATA_SOURCE = 'default';
const FALLBACK_DIALECT = 'postgres';
const FALLBACK_SCHEMA = 'public';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Prisma names a model's client delegate by lower-casing the model's first character only. */
export function prismaDelegateName(model: string): string {
  return model.length === 0 ? model : `${(model[0] as string).toLowerCase()}${model.slice(1)}`;
}

interface TableEntry {
  readonly dataSource: string;
  /** Only when the table's own dialect differs from its data source's (a ClickHouse table in a PostgreSQL source). */
  readonly dialect?: string;
  readonly id: string;
  readonly name: string;
  readonly schema: string;
}

/** Adds `value` under `key`, or marks the key as claimed twice so it is dropped. */
function claim<T>(
  map: Map<string, T | null>,
  key: string,
  value: T,
  same: (a: T, b: T) => boolean,
): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, value);
  else if (existing === null || !same(existing, value)) map.set(key, null);
}

/**
 * Builds the index from `extract-data` output. Only `DataSource` and `Table`
 * nodes are read; a tombstoned node is ignored. Throws nothing: a node missing
 * a field the index needs is skipped, and an index with no tables is a valid
 * (empty) index.
 */
export function buildDataModelIndex(nodes: readonly SeamlineNode[]): string {
  const dataSources = new Map<string, { dialect: string; defaultSchema: string }>();
  const tables: TableEntry[] = [];
  const delegates = new Map<string, { model: string; table: string } | null>();
  const bindings = new Map<string, string | null>();

  for (const node of nodes) {
    if (node.deletedAt !== null) continue;
    if (node.kind === 'DataSource') {
      const name = str(node.props['dataSource']) ?? FALLBACK_DATA_SOURCE;
      dataSources.set(name, {
        dialect: str(node.props['dialect']) ?? FALLBACK_DIALECT,
        defaultSchema: str(node.props['defaultSchema']) ?? FALLBACK_SCHEMA,
      });
    }
  }

  for (const node of nodes) {
    if (node.deletedAt !== null || node.kind !== 'Table') continue;
    const name = str(node.props['table']);
    const schema = str(node.props['schema']);
    if (name === undefined || schema === undefined) continue;
    const dataSource = str(node.props['dataSource']) ?? FALLBACK_DATA_SOURCE;
    if (!dataSources.has(dataSource)) {
      dataSources.set(dataSource, {
        dialect: str(node.props['dialect']) ?? FALLBACK_DIALECT,
        defaultSchema: FALLBACK_SCHEMA,
      });
    }
    // A table read by another dialect's rules carries that dialect on its node; the
    // index repeats it only when it differs, so a single-dialect index stays small.
    const tableDialect = str(node.props['dialect']);
    const sourceDialect = (dataSources.get(dataSource) as { dialect: string }).dialect;
    tables.push({
      dataSource,
      ...(tableDialect === undefined || tableDialect === sourceDialect
        ? {}
        : { dialect: tableDialect }),
      id: node.id,
      name,
      schema,
    });

    const ormModel = str(node.props['ormModel']);
    if (ormModel === undefined) continue;
    // `extract-data` records `ormModel` only for a table with exactly one ORM
    // source, so this split is not a guess.
    const kinds = (str(node.props['sourceKinds']) ?? '').split(',');
    if (kinds.includes('prisma')) {
      claim(
        delegates,
        prismaDelegateName(ormModel),
        { model: ormModel, table: node.id },
        (a, b) => a.table === b.table,
      );
    } else if (kinds.includes('drizzle')) {
      claim(bindings, ormModel, node.id, (a, b) => a === b);
    }
  }

  const live = <T>(map: ReadonlyMap<string, T | null>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [key, value] of map) if (value !== null) out[key] = value;
    return out;
  };

  return canonicalJson({
    dataSources: [...dataSources.entries()]
      .map(([name, ds]) => ({ name, dialect: ds.dialect, defaultSchema: ds.defaultSchema }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    drizzleExports: live(bindings),
    prismaDelegates: live(delegates),
    tables: tables.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    version: DATA_MODEL_INDEX_VERSION,
  });
}
