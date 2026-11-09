/** Value-aware disclosure: which records a snapshot, query or export may release. */
import { cloneValue, type CompiledRegistry } from './registry.ts';
import type {
  Entity,
  Field,
  Ledger,
  Properties,
  RecordFilter,
  Relation,
  Schema,
  Snapshot,
  Value,
} from './types.ts';

function invalidFilter(message: string): never {
  throw new Error(`Invalid record filter: ${message}`);
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function fieldsOf(
  registry: CompiledRegistry,
  type: string,
): Readonly<Record<string, Field>> | undefined {
  for (const lookup of [() => registry.type(type).fields, () => registry.relation(type).fields]) {
    try {
      return lookup();
    } catch {
      // Not a type of this category; try the next one.
    }
  }
  return undefined;
}

/**
 * Validate a filter against the registry and return a detached copy. Fails closed on anything
 * that is not a nonempty map of known entity/relation types to their declared enum fields, each
 * with distinct declared values.
 */
export function checkRecordFilter(registry: CompiledRegistry, value: unknown): RecordFilter {
  if (!plain(value)) invalidFilter('must map type ids to field conditions');
  let copy: Record<string, unknown>;
  try {
    copy = cloneValue(value);
  } catch (error) {
    invalidFilter(error instanceof Error ? error.message : 'not a plain value');
  }
  const types = Object.keys(copy);
  if (types.length === 0 || types.length > 128) invalidFilter('must name 1..128 types');
  for (const type of types) {
    const fields = fieldsOf(registry, type);
    if (!fields) invalidFilter(`unknown type ${type}`);
    const conditions = copy[type];
    if (!plain(conditions) || Object.keys(conditions).length === 0)
      invalidFilter(`${type} must name at least one field`);
    for (const [field, values] of Object.entries(conditions)) {
      if (!Object.hasOwn(fields, field)) invalidFilter(`${type} has no field ${field}`);
      const schema = fields[field]!.schema;
      if (schema.kind !== 'string' || schema.enum === undefined)
        invalidFilter(`${type}.${field} is not an enum field`);
      const allowed = schema.enum;
      if (
        !Array.isArray(values) ||
        new Set(values).size !== values.length ||
        values.some((v) => typeof v !== 'string' || !allowed.includes(v))
      )
        invalidFilter(`${type}.${field} needs distinct values of its enum`);
    }
  }
  return copy as RecordFilter;
}

/** The type and field allow-list an export releases through; absent for snapshot and query. */
export interface ReleaseScope {
  readonly types: readonly string[];
  readonly fields: Readonly<Record<string, readonly string[]>>;
}

interface Catalog {
  entities: readonly string[];
  relations: readonly string[];
}
const catalogs = new WeakMap<CompiledRegistry, Catalog>();
function catalog(registry: CompiledRegistry): Catalog {
  let known = catalogs.get(registry);
  if (!known) {
    const profiles = registry.descriptor() as {
      types: { id: string }[];
      relations: { id: string }[];
    }[];
    known = {
      entities: profiles.flatMap((p) => p.types.map((t) => t.id)).sort(),
      relations: profiles.flatMap((p) => p.relations.map((r) => r.id)).sort(),
    };
    catalogs.set(registry, known);
  }
  return known;
}
/** A filter can name only top-level enum fields. */
function nameable(schema: Schema): boolean {
  return schema.kind === 'string' && schema.enum !== undefined;
}
/** Whether a schema can carry a classification: a string enum or a boolean, at any depth. */
function classifying(schema: Schema): boolean {
  if (schema.kind === 'string') return schema.enum !== undefined;
  if (schema.kind === 'boolean') return true;
  if (schema.kind === 'list') return classifying(schema.items);
  if (schema.kind === 'record')
    return Object.values(schema.fields).some((field) => classifying(field.schema));
  return false;
}
/** Top-level fields that can carry a classification, and those a filter cannot name. */
function classification(fields: Readonly<Record<string, Field>>): {
  all: string[];
  unnameable: string[];
} {
  const all = Object.keys(fields).filter((name) => classifying(fields[name]!.schema));
  return { all, unnameable: all.filter((name) => !nameable(fields[name]!.schema)) };
}
function refTargets(schema: Schema, out: string[]): void {
  if (schema.kind === 'ref') out.push(...schema.types);
  else if (schema.kind === 'list') refTargets(schema.items, out);
  else if (schema.kind === 'record')
    for (const field of Object.values(schema.fields)) refTargets(field.schema, out);
}
function containsJson(schema: Schema): boolean {
  if (schema.kind === 'json') return true;
  if (schema.kind === 'list') return containsJson(schema.items);
  if (schema.kind === 'record')
    return Object.values(schema.fields).some((field) => containsJson(field.schema));
  return false;
}

/**
 * Types a read may release or reveal: every type for snapshot and query; for an export, its
 * allowed types plus every type their references and relation endpoints can point at.
 */
function releasableTypes(registry: CompiledRegistry, release?: ReleaseScope): string[] {
  const known = catalog(registry);
  if (!release) return [...known.entities, ...known.relations];
  const releasable = new Set<string>(release.types);
  for (const type of release.types) {
    const targets: string[] = [];
    for (const field of Object.values(fieldsOf(registry, type)!)) refTargets(field.schema, targets);
    if (known.relations.includes(type)) {
      const definition = registry.relation(type);
      targets.push(...definition.from, ...definition.to);
    }
    for (const candidate of known.entities) {
      const facets = registry.type(candidate).facets ?? [];
      if (targets.includes(candidate) || facets.some((facet) => targets.includes(facet)))
        releasable.add(candidate);
    }
  }
  return [...releasable].sort();
}

/**
 * Reject a filtered call that could release a classification the filters do not decide: an
 * unnamed type with a top-level enum field, or an exported type whose classification a filter
 * cannot name (inside a list or record, or a boolean). Also reject an export that would release
 * opaque json. Types with unnameable classification are withheld wholesale by `disclose`, so
 * snapshot and query need not name them.
 */
export function requireCoverage(
  registry: CompiledRegistry,
  filters: readonly RecordFilter[],
  release?: ReleaseScope,
): void {
  for (const type of release?.types ?? []) {
    const fields = fieldsOf(registry, type)!;
    const [hidden] = classification(fields).unnameable;
    if (hidden !== undefined)
      invalidFilter(
        `${type}.${hidden} holds a classification a filter cannot name, so ${type} cannot be exported under a filter`,
      );
    const allowed = Object.hasOwn(release!.fields, type) ? release!.fields[type]! : [];
    for (const field of allowed)
      if (containsJson(fields[field]!.schema))
        invalidFilter(`${type}.${field} is opaque json, which a filtered export cannot release`);
  }
  const named = new Set(filters.flatMap((filter) => Object.keys(filter)));
  for (const type of releasableTypes(registry, release)) {
    const { all, unnameable } = classification(fieldsOf(registry, type)!);
    if (!named.has(type) && unnameable.length === 0 && all.length > 0)
      invalidFilter(`must name ${type}, which has an enum field and may be released`);
  }
}

/**
 * Reading without a record filter is default-deny for classified data: refuse when a type the
 * read may release or reveal (every type for snapshot and query; the export's releasable types)
 * has a field that can carry a classification. Opaque json counts, since it can hold any value.
 */
export function requireFilterFor(registry: CompiledRegistry, release?: ReleaseScope): void {
  for (const type of releasableTypes(registry, release)) {
    const fields = fieldsOf(registry, type)!;
    const field = Object.keys(fields).find(
      (name) => classifying(fields[name]!.schema) || containsJson(fields[name]!.schema),
    );
    if (field !== undefined)
      throw new Error(
        `${release ? 'Export' : 'Read'} needs a record filter: ${type}.${field} can carry a classification (an admin may pass unfiltered: true)`,
      );
  }
}

/**
 * Ids a fork inherited that a source branch no longer holds at its head, or holds in a version
 * that fails the filters. Applied along the whole chain of sources, so a later reclassification
 * or removal on a source withholds the inherited record on every fork taken before it.
 */
export function inheritedWithheld(
  filters: readonly RecordFilter[],
  sources: readonly { inherited: Ledger; head: Ledger }[],
): Set<string> {
  const withheld = new Set<string>();
  for (const { inherited, head } of sources) {
    const passing = new Map<string, boolean>();
    for (const version of [...head.entities, ...head.relations])
      passing.set(
        version.id,
        (passing.get(version.id) ?? true) &&
          passesFilters(filters, version.type, version.properties),
      );
    for (const version of [...inherited.entities, ...inherited.relations])
      if (passing.get(version.id) !== true) withheld.add(version.id);
  }
  return withheld;
}

function passesFilters(
  filters: readonly RecordFilter[],
  type: string,
  properties: Properties,
): boolean {
  return filters.every((filter) => {
    if (!Object.hasOwn(filter, type)) return true;
    return Object.entries(filter[type]!).every(([field, values]) => {
      const value = Object.hasOwn(properties, field) ? properties[field] : undefined;
      return typeof value === 'string' && values.includes(value);
    });
  });
}

type Released = (field: string) => boolean;
/** Present, non-uncertain values of the released fields. */
function releasedValues(
  fields: Readonly<Record<string, Field>>,
  value: Properties,
  released: Released,
): [Field, Value][] {
  const out: [Field, Value][] = [];
  for (const [key, field] of Object.entries(fields)) {
    if (!released(key) || !Object.hasOwn(value, key)) continue;
    const item = value[key]!;
    if (field.uncertain && plain(item) && Object.hasOwn(item, '$state')) continue;
    out.push([field, item]);
  }
  return out;
}
/** Entity ids held by released `ref` fields, including refs nested in lists and records. */
function references(
  fields: Readonly<Record<string, Field>>,
  value: Properties,
  out: string[],
  released: Released,
): void {
  for (const [field, item] of releasedValues(fields, value, released))
    collectRefs(field.schema, item, out);
}
function collectRefs(schema: Schema, value: Value, out: string[]): void {
  if (schema.kind === 'ref' && typeof value === 'string') out.push(value);
  else if (schema.kind === 'list' && Array.isArray(value))
    for (const item of value) collectRefs(schema.items, item, out);
  else if (schema.kind === 'record' && plain(value))
    references(schema.fields, value as Properties, out, () => true);
}
/** Whether a released field holds an opaque json value, which could carry any id. */
function holdsJson(
  fields: Readonly<Record<string, Field>>,
  value: Properties,
  released: Released,
): boolean {
  return releasedValues(fields, value, released).some(([field, item]) =>
    jsonValue(field.schema, item),
  );
}
function jsonValue(schema: Schema, value: Value): boolean {
  if (schema.kind === 'json') return value !== null;
  if (schema.kind === 'list' && Array.isArray(value))
    return value.some((item) => jsonValue(schema.items, item));
  if (schema.kind === 'record' && plain(value))
    return holdsJson(schema.fields, value as Properties, () => true);
  return false;
}

/**
 * The records a filtered read may release. A record is released only when its type is released
 * and has no classification a filter cannot name, every recorded version of its id in the head
 * ledger passes the filters (and a fork's source does not withhold it), none of its released
 * fields holds opaque json, and every entity its released fields reference is itself released
 * (a greatest fixpoint, so references to withheld, unreleased or absent ids withhold the
 * referrer transitively). A relation also needs both endpoints released. Released records are
 * returned unchanged, so no output carries a withheld id.
 */
export function disclose(
  registry: CompiledRegistry,
  snapshot: Snapshot,
  filters: readonly RecordFilter[],
  options: {
    /** Every version recorded at the head revision of the branch being read. */
    versions: readonly (Entity | Relation)[];
    /** The export's allow-list; absent for snapshot and query. */
    release?: ReleaseScope;
    /** Ids to withhold regardless of their own versions (see `inheritedWithheld`). */
    withheld?: ReadonlySet<string>;
  },
): Snapshot {
  const { versions, release } = options;
  const failing = new Set([
    ...versions.filter((v) => !passesFilters(filters, v.type, v.properties)).map((v) => v.id),
    ...(options.withheld ?? []),
  ]);
  const opaqueTypes = new Map<string, boolean>();
  const opaque = (type: string, fields: Readonly<Record<string, Field>>): boolean => {
    if (!opaqueTypes.has(type)) opaqueTypes.set(type, classification(fields).unnameable.length > 0);
    return opaqueTypes.get(type)!;
  };
  const releasedField =
    (type: string): Released =>
    (field) =>
      !release || (Object.hasOwn(release.fields, type) && release.fields[type]!.includes(field));
  const eligible = (record: Entity | Relation, fields: Readonly<Record<string, Field>>) =>
    (!release || release.types.includes(record.type)) &&
    !opaque(record.type, fields) &&
    !failing.has(record.id) &&
    passesFilters(filters, record.type, record.properties) &&
    !holdsJson(fields, record.properties, releasedField(record.type));

  const released = new Set<string>();
  const cites = new Map<string, string[]>();
  const referrers = new Map<string, string[]>();
  for (const entity of snapshot.entities) {
    const fields = registry.type(entity.type).fields;
    if (!eligible(entity, fields)) continue;
    released.add(entity.id);
    const cited: string[] = [];
    references(fields, entity.properties, cited, releasedField(entity.type));
    cites.set(entity.id, cited);
    for (const target of cited) {
      const list = referrers.get(target);
      if (list) list.push(entity.id);
      else referrers.set(target, [entity.id]);
    }
  }
  const pending: string[] = [];
  const drop = (id: string): void => {
    if (released.delete(id)) pending.push(id);
  };
  for (const [id, cited] of cites) if (cited.some((target) => !released.has(target))) drop(id);
  while (pending.length) for (const referrer of referrers.get(pending.pop()!) ?? []) drop(referrer);

  const relations = snapshot.relations.filter((relation) => {
    const fields = registry.relation(relation.type).fields;
    if (!released.has(relation.from) || !released.has(relation.to)) return false;
    if (!eligible(relation, fields)) return false;
    const cited: string[] = [];
    references(fields, relation.properties, cited, releasedField(relation.type));
    return cited.every((target) => released.has(target));
  });
  return { entities: snapshot.entities.filter((e) => released.has(e.id)), relations };
}
