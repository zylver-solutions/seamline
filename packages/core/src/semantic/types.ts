/** Versioned semantic contracts. Independent of the legacy code ontology. */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type Properties = { [key: string]: Value };
export type Schema =
  | { kind: 'string'; enum?: readonly string[] }
  | { kind: 'number' | 'integer'; min?: number; max?: number }
  | { kind: 'boolean' | 'json' }
  | { kind: 'ref'; types: readonly string[] }
  | { kind: 'list'; items: Schema; maxItems?: number }
  | { kind: 'record'; fields: Readonly<Record<string, Field>> };
export interface Field {
  schema: Schema;
  required?: boolean;
  nullable?: boolean;
  uncertain?: boolean;
}
export interface TypeDefinition {
  id: string;
  fields: Readonly<Record<string, Field>>;
  facets?: readonly string[];
}
export interface RelationDefinition {
  id: string;
  from: readonly string[];
  to: readonly string[];
  fields: Readonly<Record<string, Field>>;
  exclusive?: 'from' | 'to';
  acyclic?: boolean;
}
export interface Entity {
  id: string;
  type: string;
  properties: Properties;
}
export interface Relation {
  id: string;
  type: string;
  from: string;
  to: string;
  properties: Properties;
}
export interface Snapshot {
  entities: Entity[];
  relations: Relation[];
}
export interface Changes {
  putEntities?: readonly Entity[];
  removeEntities?: readonly string[];
  putRelations?: readonly Relation[];
  removeRelations?: readonly string[];
}
export interface CommandContext {
  readonly snapshot: Snapshot;
  readonly actor: string;
  readonly timeline: string;
  readonly validAt: number;
  readonly validUntil?: number;
}
export interface CommandDefinition {
  id: string;
  /** Bump whenever reducer behavior changes; included in the registry fingerprint. */
  version: string;
  input: Readonly<Record<string, Field>>;
  apply(context: CommandContext, args: Properties): Changes;
}
export interface Invariant {
  id: string;
  version: string;
  check(snapshot: Snapshot, previous?: Snapshot, command?: string): void;
}
export interface Profile {
  id: string;
  version: string;
  requires: Readonly<Record<string, string>>;
  facets?: readonly TypeDefinition[];
  types: readonly TypeDefinition[];
  relations: readonly RelationDefinition[];
  commands: readonly CommandDefinition[];
  invariants?: readonly Invariant[];
}
export interface Scope {
  world: string;
  branch: string;
}
export interface Timeline {
  id: string;
  unit: string;
  ticksPerUnit: { numerator: number; denominator: number };
}
export interface Temporal {
  timeline: string;
  validFrom: number;
  validTo: number | null;
}
export interface Ledger {
  entities: (Entity & Temporal)[];
  relations: (Relation & Temporal)[];
  /** Retained change boundaries, including absence after deletion. */
  barriers?: { id: string; timeline: string; validAt: number }[];
}
export interface Submission {
  scope: Scope;
  expectedRevision: number;
  commandId: string;
  command: string;
  args: Properties;
  timeline: string;
  validAt: number;
  validUntil?: number;
}
export interface Receipt {
  commandId: string;
  revision: number;
  fingerprint: string;
}
/**
 * Record-level disclosure filter over enum fields: `{type: {field: allowedValues}}`.
 * A record of a named entity or relation type is released only when every named field holds one
 * of its listed values in every version recorded at the head revision; an absent, null or
 * uncertain value fails. A filter must name every releasable type that has a top-level enum
 * field; records of a type whose classification a filter cannot name (an enum or boolean in a
 * list or record, or a boolean) are withheld. A record is withheld when a released reference
 * points outside the released set, and, for snapshot and query, when it holds an opaque json
 * value. See docs/semantic-engine.md.
 */
export type RecordFilter = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
export interface SnapshotRequest {
  timeline: string;
  validAt: number;
  revision?: number;
  /**
   * Applied to snapshot, query and export alike; requires the head revision (no `revision`).
   * Omitted: see `unfiltered`.
   */
  where?: RecordFilter;
  /**
   * Admin only: read without a record filter although a type in the registry can carry a
   * classification. Requires `admin` authorization on the branch and on every source branch it
   * was forked from, and cannot be combined with `where`. Without either, such a read is refused.
   * An export takes this flag on its policy instead.
   */
  unfiltered?: boolean;
}
export interface SnapshotResult {
  revision: number;
  snapshot: Snapshot;
}
export interface Access {
  tenant: string;
  actor: string;
  /** Host-supplied authority. Must explicitly authorize every operation. */
  authorize(operation: 'admin' | 'read' | 'write' | 'export', scope?: Scope): boolean;
}
export interface ExportPolicy {
  types: readonly string[];
  fields: Readonly<Record<string, readonly string[]>>;
  /** Releases only records that pass this filter (and any filter on the request). */
  where?: RecordFilter;
  /**
   * Admin only: export without a record filter even though an exported or referenced type has a
   * field that can carry a classification (json included). Requires `admin` authorization on the
   * branch and on every source branch it was forked from, and cannot be combined with `where`.
   * Without it, such an export is refused.
   */
  unfiltered?: boolean;
}
