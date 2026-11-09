import { createHash } from 'node:crypto';
import { canonicalJson } from '../merge/serialize.ts';
import type {
  CommandDefinition,
  Entity,
  Field,
  Profile,
  Properties,
  RelationDefinition,
  Schema,
  Snapshot,
  TypeDefinition,
} from './types.ts';

const MAX_DEPTH = 32;
const MAX_VALUES = 100_000;
const NAME = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message: string): never {
  throw new Error(`semantic registry: ${message}`);
}
function record(value: unknown, where: string): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    fail(`${where} must be a plain record`);
}
function keys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${where}: unknown field ${key}`);
}
function name(value: unknown, where: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 256 || !NAME.test(value) || BAD_KEYS.has(value))
    fail(`${where}: invalid name`);
}
function string(value: unknown, where: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024)
    fail(`${where} must be a nonempty string`);
}
function array(value: unknown, where: string): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > 4000) fail(`${where} must be a bounded array`);
}

/** Strict detached JSON copy. Rejects silent JSON coercion, getters and unsafe keys. */
export function cloneValue<T>(value: T): T {
  let count = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++count > MAX_VALUES || depth > MAX_DEPTH) fail('value exceeds structural budget');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (item.length > 1_000_000) fail('string exceeds budget');
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('number must be finite');
      return Object.is(item, -0) ? 0 : item;
    }
    if (Array.isArray(item)) {
      if (item.length > MAX_VALUES || Reflect.ownKeys(item).length !== item.length + 1)
        fail('array must be dense without extra properties');
      return Array.from({ length: item.length }, (_, i) => {
        const entry = Object.getOwnPropertyDescriptor(item, String(i));
        if (!entry || !('value' in entry)) fail('array must have plain entries');
        return visit(entry.value, depth + 1);
      });
    }
    record(item, 'value');
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string' || BAD_KEYS.has(key)) fail('value contains unsafe key');
      const entry = Object.getOwnPropertyDescriptor(item, key)!;
      if (!entry.enumerable || !('value' in entry))
        fail('value must have enumerable data properties');
      out[key] = visit(entry.value, depth + 1);
    }
    return out;
  };
  return visit(value, 0) as T;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function profileCopy(profile: Profile): Profile {
  record(profile, 'profile');
  const descriptors = Object.getOwnPropertyDescriptors(profile);
  for (const d of Object.values(descriptors))
    if (!('value' in d)) fail('profile contains accessor');
  array(profile.commands, 'commands');
  if (profile.invariants !== undefined) array(profile.invariants, 'invariants');
  // Only these two explicitly trusted implementation slots accept functions.
  const commands = profile.commands.map((command) => {
    record(command, 'command');
    for (const d of Object.values(Object.getOwnPropertyDescriptors(command)))
      if (!('value' in d)) fail('command contains accessor');
    const { apply, ...metadata } = command;
    if (typeof apply !== 'function') fail('command.apply must be a trusted function');
    return { ...cloneValue(metadata), apply };
  });
  const invariants = profile.invariants?.map((invariant) => {
    record(invariant, 'invariant');
    for (const d of Object.values(Object.getOwnPropertyDescriptors(invariant)))
      if (!('value' in d)) fail('invariant contains accessor');
    const { check, ...metadata } = invariant;
    if (typeof check !== 'function') fail('invariant.check must be a trusted function');
    return { ...cloneValue(metadata), check };
  });
  const { commands: _commands, invariants: _invariants, ...metadata } = profile;
  return freeze({
    ...cloneValue(metadata),
    commands,
    ...(invariants === undefined ? {} : { invariants }),
  });
}

function fieldsShape(
  fields: unknown,
  refs: string[],
  depth = 0,
): asserts fields is Readonly<Record<string, Field>> {
  if (depth > MAX_DEPTH) fail('schema exceeds depth budget');
  record(fields, 'fields');
  if (Object.keys(fields).length > 256) fail('too many fields');
  for (const [id, field] of Object.entries(fields)) {
    name(id, 'field');
    record(field, id);
    keys(field, ['schema', 'required', 'nullable', 'uncertain'], id);
    for (const flag of ['required', 'nullable', 'uncertain'])
      if (field[flag] !== undefined && typeof field[flag] !== 'boolean')
        fail(`${id}.${flag} must be boolean`);
    schemaShape(field.schema, refs, depth + 1);
  }
}

function schemaShape(schema: unknown, refs: string[], depth: number): asserts schema is Schema {
  if (depth > MAX_DEPTH) fail('schema exceeds depth budget');
  record(schema, 'schema');
  switch (schema.kind) {
    case 'string':
      keys(schema, ['kind', 'enum'], 'string schema');
      if (schema.enum !== undefined) {
        array(schema.enum, 'enum');
        if (
          !schema.enum.length ||
          schema.enum.some((v) => typeof v !== 'string') ||
          new Set(schema.enum).size !== schema.enum.length
        )
          fail('enum must contain unique strings');
      }
      break;
    case 'number':
    case 'integer':
      keys(schema, ['kind', 'min', 'max'], 'numeric schema');
      for (const key of ['min', 'max'])
        if (
          schema[key] !== undefined &&
          (typeof schema[key] !== 'number' ||
            !Number.isFinite(schema[key]) ||
            (schema.kind === 'integer' && !Number.isSafeInteger(schema[key])))
        )
          fail('invalid numeric bound');
      if (
        schema.min !== undefined &&
        schema.max !== undefined &&
        (schema.min as number) > (schema.max as number)
      )
        fail('inverted numeric bounds');
      break;
    case 'boolean':
    case 'json':
      keys(schema, ['kind'], 'scalar schema');
      break;
    case 'ref':
      keys(schema, ['kind', 'types'], 'ref schema');
      array(schema.types, 'ref types');
      if (!schema.types.length) fail('ref types cannot be empty');
      for (const id of schema.types) {
        name(id, 'reference type');
        refs.push(id);
      }
      break;
    case 'list':
      keys(schema, ['kind', 'items', 'maxItems'], 'list schema');
      if (
        schema.maxItems !== undefined &&
        (!Number.isSafeInteger(schema.maxItems) ||
          (schema.maxItems as number) < 0 ||
          (schema.maxItems as number) > MAX_VALUES)
      )
        fail('invalid list bound');
      schemaShape(schema.items, refs, depth + 1);
      break;
    case 'record':
      keys(schema, ['kind', 'fields'], 'record schema');
      fieldsShape(schema.fields, refs, depth + 1);
      break;
    default:
      fail('unknown schema kind');
  }
}

/** Compiles immutable profiles once; all writes validate against the same definitions. */
export class CompiledRegistry {
  readonly fingerprint: string;
  readonly #profiles: readonly Profile[];
  readonly #types = new Map<string, TypeDefinition>();
  readonly #facets = new Map<string, TypeDefinition>();
  readonly #relations = new Map<string, RelationDefinition>();
  readonly #commands = new Map<string, CommandDefinition>();

  constructor(profiles: readonly Profile[]) {
    array(profiles, 'profiles');
    if (!profiles.length || profiles.length > 128) fail('profiles must contain 1..128 profiles');
    this.#profiles = profiles
      .map(profileCopy)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const byId = new Map<string, Profile>();
    for (const p of this.#profiles) {
      keys(
        p as unknown as Record<string, unknown>,
        ['id', 'version', 'requires', 'facets', 'types', 'relations', 'commands', 'invariants'],
        'profile',
      );
      name(p.id, 'profile id');
      string(p.version, 'profile version');
      if (byId.has(p.id)) fail(`duplicate profile ${p.id}`);
      byId.set(p.id, p);
      record(p.requires, 'requires');
      for (const [id, version] of Object.entries(p.requires)) {
        name(id, 'dependency');
        string(version, 'dependency version');
      }
      for (const category of ['types', 'relations', 'commands'] as const)
        array(p[category], category);
      if (p.facets !== undefined) array(p.facets, 'facets');
    }
    const closures = new Map<string, Set<string>>();
    const closure = (id: string, visiting = new Set<string>()): Set<string> => {
      if (visiting.has(id)) fail(`dependency cycle at ${id}`);
      if (closures.has(id)) return closures.get(id)!;
      const p = byId.get(id)!;
      const result = new Set([id]);
      const next = new Set(visiting).add(id);
      for (const [dep, version] of Object.entries(p.requires)) {
        if (byId.get(dep)?.version !== version)
          fail(`missing or incompatible dependency ${id} -> ${dep}@${version}`);
        for (const reachable of closure(dep, next)) result.add(reachable);
      }
      closures.set(id, result);
      return result;
    };
    for (const p of this.#profiles) closure(p.id);
    const owners = new Map<string, string>();
    const references: { owner: string; refs: string[] }[] = [];
    const own = (p: Profile, id: string): void => {
      name(id, 'definition id');
      if (!id.startsWith(`${p.id}.`) || owners.has(id))
        fail(`definition collision or foreign namespace: ${id}`);
      owners.set(id, p.id);
    };
    for (const p of this.#profiles) {
      for (const [definitions, target] of [
        [p.types, this.#types],
        [p.facets ?? [], this.#facets],
      ] as const) {
        for (const definition of definitions) {
          record(definition, 'type');
          keys(definition, ['id', 'fields', 'facets'], 'type');
          own(p, definition.id);
          const refs: string[] = [];
          fieldsShape(definition.fields, refs);
          if (definition.facets !== undefined) {
            array(definition.facets, 'facets');
            for (const facet of definition.facets) {
              name(facet, 'facet');
              refs.push(facet);
            }
          }
          references.push({ owner: p.id, refs });
          target.set(definition.id, definition);
        }
      }
      for (const relation of p.relations) {
        record(relation, 'relation');
        keys(relation, ['id', 'from', 'to', 'fields', 'exclusive', 'acyclic'], 'relation');
        own(p, relation.id);
        const refs: string[] = [];
        fieldsShape(relation.fields, refs);
        for (const endpoints of [relation.from, relation.to]) {
          array(endpoints, 'relation endpoints');
          if (!endpoints.length) fail('empty relation signature');
          for (const endpoint of endpoints) {
            name(endpoint, 'endpoint');
            refs.push(endpoint);
          }
        }
        if (
          relation.exclusive !== undefined &&
          relation.exclusive !== 'from' &&
          relation.exclusive !== 'to'
        )
          fail('invalid exclusivity');
        if (relation.acyclic !== undefined && typeof relation.acyclic !== 'boolean')
          fail('invalid acyclic flag');
        references.push({ owner: p.id, refs });
        this.#relations.set(relation.id, relation);
      }
      for (const command of p.commands) {
        record(command, 'command');
        keys(command, ['id', 'version', 'input', 'apply'], 'command');
        own(p, command.id);
        string(command.version, 'command version');
        const refs: string[] = [];
        fieldsShape(command.input, refs);
        references.push({ owner: p.id, refs });
        this.#commands.set(command.id, command);
      }
      for (const invariant of p.invariants ?? []) {
        record(invariant, 'invariant');
        keys(invariant, ['id', 'version', 'check'], 'invariant');
        own(p, invariant.id);
        string(invariant.version, 'invariant version');
      }
    }
    for (const { owner, refs } of references)
      for (const ref of refs) {
        const targetOwner = owners.get(ref);
        if (
          (!this.#types.has(ref) && !this.#facets.has(ref)) ||
          (targetOwner !== owner && !Object.hasOwn(byId.get(owner)!.requires, targetOwner ?? ''))
        )
          fail(`undeclared or unresolved reference ${owner} -> ${ref}`);
      }
    const expanded = new Map<string, TypeDefinition>();
    const expand = (definition: TypeDefinition, visiting = new Set<string>()): TypeDefinition => {
      if (visiting.has(definition.id)) fail(`facet cycle at ${definition.id}`);
      if (expanded.has(definition.id)) return expanded.get(definition.id)!;
      const fields: Record<string, Field> = {};
      const facets = new Set<string>();
      const add = (incoming: Readonly<Record<string, Field>>): void => {
        for (const [id, field] of Object.entries(incoming)) {
          if (fields[id] !== undefined && canonicalJson(fields[id]) !== canonicalJson(field))
            fail(`incompatible field ${definition.id}.${id}`);
          fields[id] = field;
        }
      };
      for (const id of definition.facets ?? []) {
        const facet = this.#facets.get(id);
        if (!facet) fail(`not a facet: ${id}`);
        const merged = expand(facet, new Set(visiting).add(definition.id));
        add(merged.fields);
        facets.add(id);
        for (const inherited of merged.facets ?? []) facets.add(inherited);
      }
      add(definition.fields);
      const result = freeze({ id: definition.id, fields, facets: [...facets].sort() });
      expanded.set(definition.id, result);
      return result;
    };
    for (const facet of this.#facets.values()) expand(facet);
    for (const [id, definition] of this.#types) this.#types.set(id, expand(definition));
    this.fingerprint = createHash('sha256').update(canonicalJson(this.descriptor())).digest('hex');
    Object.freeze(this);
  }

  type(id: string): TypeDefinition {
    const value = this.#types.get(id);
    return value ?? fail(`unknown type ${id}`);
  }
  relation(id: string): RelationDefinition {
    const value = this.#relations.get(id);
    return value ?? fail(`unknown relation ${id}`);
  }
  command(id: string): CommandDefinition {
    const value = this.#commands.get(id);
    return value ?? fail(`unknown command ${id}`);
  }

  /** Stable serializable registration metadata; executable source is fingerprinted, never evaluated. */
  descriptor(): unknown {
    return cloneValue(
      this.#profiles.map((p) => ({
        ...p,
        types: [...p.types].sort((a, b) => (a.id < b.id ? -1 : 1)),
        relations: [...p.relations].sort((a, b) => (a.id < b.id ? -1 : 1)),
        ...(p.facets === undefined
          ? {}
          : { facets: [...p.facets].sort((a, b) => (a.id < b.id ? -1 : 1)) }),
        commands: [...p.commands]
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map(({ apply, ...metadata }) => ({
            ...metadata,
            implementation: Function.prototype.toString.call(apply),
          })),
        ...(p.invariants === undefined
          ? {}
          : {
              invariants: [...p.invariants]
                .sort((a, b) => (a.id < b.id ? -1 : 1))
                .map(({ check, ...metadata }) => ({
                  ...metadata,
                  implementation: Function.prototype.toString.call(check),
                })),
            }),
      })),
    );
  }

  #matches(entity: Entity, types: readonly string[]): boolean {
    return (
      types.includes(entity.type) ||
      (this.type(entity.type).facets ?? []).some((facet) => types.includes(facet))
    );
  }

  #fields(
    fields: Readonly<Record<string, Field>>,
    value: unknown,
    entities: Map<string, Entity>,
    where: string,
  ): void {
    record(value, where);
    for (const key of Object.keys(value))
      if (!Object.hasOwn(fields, key)) fail(`${where}: unknown field ${key}`);
    for (const [key, field] of Object.entries(fields)) {
      if (!Object.hasOwn(value, key)) {
        if (field.required) fail(`${where}.${key} required`);
        continue;
      }
      const item = value[key];
      if (item === null && field.nullable) continue;
      if (
        field.uncertain &&
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Object.hasOwn(item, '$state')
      ) {
        const uncertain = item as Record<string, unknown>;
        keys(uncertain, ['$state', 'reason'], 'uncertainty');
        if (
          !['unknown', 'unavailable', 'notApplicable', 'redacted'].includes(
            uncertain.$state as string,
          ) ||
          (uncertain.reason !== undefined && typeof uncertain.reason !== 'string')
        )
          fail('invalid uncertainty');
        continue;
      }
      this.#value(field.schema, item, entities, `${where}.${key}`);
    }
  }

  #value(schema: Schema, value: unknown, entities: Map<string, Entity>, where: string): void {
    switch (schema.kind) {
      case 'json':
        return;
      case 'string':
        if (typeof value !== 'string' || (schema.enum && !schema.enum.includes(value)))
          fail(`${where}: expected string/enum`);
        return;
      case 'boolean':
        if (typeof value !== 'boolean') fail(`${where}: expected boolean`);
        return;
      case 'number':
      case 'integer':
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          (schema.kind === 'integer' && !Number.isSafeInteger(value)) ||
          (schema.min !== undefined && value < schema.min) ||
          (schema.max !== undefined && value > schema.max)
        )
          fail(`${where}: invalid number`);
        return;
      case 'ref': {
        const entity = typeof value === 'string' ? entities.get(value) : undefined;
        if (!entity || !this.#matches(entity, schema.types)) fail(`${where}: invalid reference`);
        return;
      }
      case 'list':
        if (!Array.isArray(value) || value.length > (schema.maxItems ?? MAX_VALUES))
          fail(`${where}: invalid list`);
        for (const item of value) this.#value(schema.items, item, entities, where);
        return;
      case 'record':
        this.#fields(schema.fields, value, entities, where);
        return;
    }
  }

  validateInput(commandId: string, args: Properties, snapshot: Snapshot): void {
    this.#fields(
      this.command(commandId).input,
      cloneValue(args),
      new Map(snapshot.entities.map((e) => [e.id, e])),
      'command input',
    );
  }

  validate(snapshot: Snapshot, previous?: Snapshot, command?: string): void {
    const copy = cloneValue(snapshot);
    record(copy, 'snapshot');
    keys(copy, ['entities', 'relations'], 'snapshot');
    array(copy.entities, 'entities');
    array(copy.relations, 'relations');
    if (copy.entities.length > 2000 || copy.relations.length > 4000)
      fail('snapshot exceeds entity/relation budget');
    const entities = new Map<string, Entity>();
    const relationIds = new Set<string>();
    for (const entity of copy.entities) {
      record(entity, 'entity');
      keys(entity, ['id', 'type', 'properties'], 'entity');
      string(entity.id, 'entity id');
      this.type(entity.type);
      if (entities.has(entity.id)) fail(`duplicate entity ${entity.id}`);
      entities.set(entity.id, entity);
    }
    for (const entity of entities.values())
      this.#fields(this.type(entity.type).fields, entity.properties, entities, entity.id);
    const exclusives = new Set<string>();
    const graphs = new Map<string, Map<string, string[]>>();
    for (const relation of copy.relations) {
      record(relation, 'relation');
      keys(relation, ['id', 'type', 'from', 'to', 'properties'], 'relation');
      string(relation.id, 'relation id');
      if (relationIds.has(relation.id) || entities.has(relation.id))
        fail(`duplicate relation ${relation.id}`);
      relationIds.add(relation.id);
      const definition = this.relation(relation.type);
      const from = entities.get(relation.from);
      const to = entities.get(relation.to);
      if (
        !from ||
        !to ||
        !this.#matches(from, definition.from) ||
        !this.#matches(to, definition.to)
      )
        fail(`invalid endpoints ${relation.id}`);
      this.#fields(definition.fields, relation.properties, entities, relation.id);
      if (definition.exclusive) {
        const key = canonicalJson([relation.type, relation[definition.exclusive]]);
        if (exclusives.has(key)) fail(`exclusive relation ${relation.type}`);
        exclusives.add(key);
      }
      if (definition.acyclic) {
        const graph = graphs.get(relation.type) ?? new Map<string, string[]>();
        const targets = graph.get(relation.from) ?? [];
        targets.push(relation.to);
        graph.set(relation.from, targets);
        graphs.set(relation.type, graph);
      }
    }
    for (const [id, graph] of graphs) {
      const done = new Set<string>();
      const visiting = new Set<string>();
      const walk = (node: string): void => {
        if (visiting.has(node)) fail(`cycle in ${id}`);
        if (done.has(node)) return;
        visiting.add(node);
        for (const next of graph.get(node) ?? []) walk(next);
        visiting.delete(node);
        done.add(node);
      };
      for (const node of graph.keys()) walk(node);
    }
    const immutable = freeze(copy);
    const prior = previous === undefined ? undefined : freeze(cloneValue(previous));
    for (const profile of this.#profiles)
      for (const invariant of profile.invariants ?? []) {
        const result: unknown = invariant.check(immutable, prior, command);
        if (result !== undefined)
          fail(`invariant ${invariant.id} must return synchronously with no value`);
      }
  }
}
