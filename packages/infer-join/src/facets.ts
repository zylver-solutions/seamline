/**
 * Reading match facets off the graph.
 *
 * A "facet" is everything the matcher needs about one node: its name, the name
 * of the container it belongs to, and its normalized type category. The three
 * extractors are written by different people against the same contract, so this
 * module is deliberately tolerant about *where* each fact lives - it prefers
 * the structural `CONTAINS` edge, falls back to node props, and falls back
 * again to parsing the canonical name.
 *
 * Prop keys read here (all optional, first hit wins):
 *
 *   type          `typeCategory`, `type`, `dataType`, `sqlType`, `tsType`,
 *                 `jsonType`, `columnType`, `fieldType`
 *   type format   `format`
 *   container     `container`, `objectName`, `schemaName`, `table`, `owner`,
 *                 `parent`, `symbol`, `class`
 *   nullability   `nullable`, `optional`, `required`
 *
 * If an extractor emits a normalized `typeCategory`, that wins outright.
 */

import type { GraphView, NodeId, NodeKind, SeamlineNode } from '@seamline/ontology';
import { parseNodeId } from '@seamline/ontology';
import { canonicalKey, containerCoreKey, literalKey } from './naming.ts';
import type { TypeCategory } from './typecat.ts';
import { normalizeType } from './typecat.ts';

export interface Facet {
  /** The node the edge endpoint refers to. */
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly node: SeamlineNode;
  /** The name being matched. Usually `node.name`; for a validator member it is the member's name. */
  readonly name: string;
  /** The name of the enclosing table / class / schema object. Empty when unresolvable. */
  readonly container: string;
  readonly containerId: NodeId | undefined;
  readonly typeCategory: TypeCategory;
  readonly rawType: string | undefined;
  /** Repo-relative POSIX path of the node, carried onto the edge for re-run invalidation (v3 §2.1). */
  readonly file: string | undefined;
  /** Match keys, precomputed once because candidate generation indexes on them. */
  readonly nameKeys: ReadonlyArray<string>;
  readonly containerKeys: ReadonlyArray<string>;
}

const TYPE_PROPS = [
  'typeCategory', 'type', 'dataType', 'sqlType', 'tsType', 'jsonType',
  'columnType', 'fieldType',
] as const;

const CONTAINER_PROPS = [
  'container', 'objectName', 'schemaName', 'table', 'owner', 'parent',
  'symbol', 'class',
] as const;

/** Node kinds that act as the container of each matchable kind. */
const CONTAINER_KINDS: Readonly<Record<string, ReadonlyArray<NodeKind>>> = Object.freeze({
  Column: ['Table'],
  CodeField: ['Symbol'],
  SchemaProperty: ['Contract'],
  Parameter: ['Symbol'],
});

function propString(node: SeamlineNode, keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const value = node.props[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Container name from a JSON pointer, for `SchemaProperty` nodes whose
 * canonical name is `{contract}#{json_pointer}` (v3 §2.1).
 *
 * `openapi.yaml#/components/schemas/Post/properties/scheduledAt` gives `Post`.
 * Structural pointer segments (`components`, `schemas`, `definitions`,
 * `properties`, `items`) are never returned as a container.
 */
export function containerFromPointer(canonicalName: string): string | undefined {
  const hash = canonicalName.indexOf('#');
  const pointer = hash >= 0 ? canonicalName.slice(hash + 1) : canonicalName;
  const segments = pointer.split('/').filter((s) => s.length > 0);
  const structural = new Set(['components', 'schemas', 'definitions', 'properties', 'items', '$defs']);
  for (let i = segments.length - 1; i >= 1; i -= 1) {
    const segment = segments[i];
    if (segment !== 'properties' && segment !== 'items') continue;
    const previous = segments[i - 1];
    if (previous !== undefined && !structural.has(previous)) return previous;
  }
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment !== undefined && !structural.has(segment)) return segment;
  }
  return undefined;
}

/**
 * Container name from a dotted canonical name.
 * `main.public.orders.ship_at` gives `orders`; `src/model.ts::Post.title`
 * gives `Post`.
 */
export function containerFromDottedName(canonicalName: string): string | undefined {
  const tail = canonicalName.split(/[:#]/u).pop() ?? canonicalName;
  const parts = tail.split('.').filter((s) => s.length > 0);
  if (parts.length < 2) return undefined;
  return parts[parts.length - 2];
}

function resolveContainer(
  graph: GraphView,
  node: SeamlineNode,
): { name: string; id: NodeId | undefined } {
  const allowed = CONTAINER_KINDS[node.kind];
  if (allowed !== undefined) {
    const parents = graph.edgesTo(node.id, 'CONTAINS')
      .filter((e) => e.deletedAt === null)
      .map((e) => graph.node(e.src))
      .filter((n): n is SeamlineNode => n !== undefined && allowed.includes(n.kind))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const parent = parents[0];
    // A Contract is a document, not a domain container. Its name is a filename,
    // so it is a poor match target; the JSON pointer names the real object.
    if (parent !== undefined && node.kind !== 'SchemaProperty') {
      return { name: parent.name, id: parent.id };
    }
    if (parent !== undefined && node.kind === 'SchemaProperty') {
      const fromProps = propString(node, CONTAINER_PROPS);
      const fromPointer = fromProps ?? containerFromPointer(parseNodeId(node.id).canonicalName);
      return { name: fromPointer ?? parent.name, id: parent.id };
    }
  }

  const fromProps = propString(node, CONTAINER_PROPS);
  if (fromProps !== undefined) return { name: fromProps, id: undefined };

  const canonical = parseNodeId(node.id).canonicalName;
  if (node.kind === 'SchemaProperty') {
    const fromPointer = containerFromPointer(canonical);
    if (fromPointer !== undefined) return { name: fromPointer, id: undefined };
  }
  const dotted = containerFromDottedName(canonical);
  return { name: dotted ?? '', id: undefined };
}

function resolveType(node: SeamlineNode): { category: TypeCategory; raw: string | undefined } {
  const normalized = node.props['typeCategory'];
  if (typeof normalized === 'string' && normalized.length > 0) {
    const category = normalizeType(normalized);
    if (category !== 'unknown') return { category, raw: normalized };
  }
  const raw = propString(node, TYPE_PROPS);
  const format = node.props['format'];
  return { category: normalizeType(raw, format), raw };
}

function uniqueSorted(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values.filter((v) => v.length > 0))].sort();
}

/** Build a facet for one node, optionally overriding the matched name. */
export function facetFor(graph: GraphView, node: SeamlineNode, nameOverride?: string): Facet {
  const container = resolveContainer(graph, node);
  const type = resolveType(node);
  const name = nameOverride ?? node.name;
  return {
    id: node.id,
    kind: node.kind,
    node,
    name,
    container: container.name,
    containerId: container.id,
    typeCategory: type.category,
    rawType: type.raw,
    file: node.path,
    nameKeys: uniqueSorted([literalKey(name), canonicalKey(name)]),
    containerKeys: uniqueSorted([
      literalKey(container.name),
      canonicalKey(container.name),
      containerCoreKey(container.name),
    ]),
  };
}

/**
 * A facet whose matched name and container are supplied rather than read from
 * the graph. Used for validator members: the edge endpoint is the validator
 * symbol, but the name being matched is one of its declared members.
 */
export function customFacet(input: {
  readonly node: SeamlineNode;
  readonly name: string;
  readonly container: string;
  readonly typeCategory?: TypeCategory;
  readonly rawType?: string;
}): Facet {
  return {
    id: input.node.id,
    kind: input.node.kind,
    node: input.node,
    name: input.name,
    container: input.container,
    containerId: undefined,
    typeCategory: input.typeCategory ?? 'unknown',
    rawType: input.rawType,
    file: input.node.path,
    nameKeys: uniqueSorted([literalKey(input.name), canonicalKey(input.name)]),
    containerKeys: uniqueSorted([
      literalKey(input.container),
      canonicalKey(input.container),
      containerCoreKey(input.container),
    ]),
  };
}

/** All live nodes of a kind, as facets, ordered by node id for determinism. */
export function facetsOfKind(graph: GraphView, kind: NodeKind): ReadonlyArray<Facet> {
  return graph.nodesByKind(kind)
    .filter((n) => n.deletedAt === null)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((n) => facetFor(graph, n));
}

/** Read a boolean-ish prop. Accepts booleans and the strings `true`/`false`. */
export function boolProp(node: SeamlineNode, key: string): boolean | undefined {
  const value = node.props[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Bounded path exclusions for automatic joins, without discarding extracted facts. */
const NON_APPLICATION_SEGMENTS = new Set([
  'test', 'tests', '__tests__', 'fixture', 'fixtures', '__fixtures__',
  'testdata', 'mock', 'mocks', '__mocks__', 'components', 'vendor', 'third_party', 'third-party',
]);

function applicationPath(path: string | undefined): boolean {
  if (path === undefined) return true;
  const parts = path.toLowerCase().split('/');
  if (parts.some((part) => NON_APPLICATION_SEGMENTS.has(part))) return false;
  return !/\.(?:test|spec|fixture|mock)\.[^.]+$/.test(parts.at(-1) ?? '');
}

/** Both the member and its resolved owner must be eligible. No role is invented. */
export function eligibleForAutomaticJoin(graph: GraphView, facet: Facet): boolean {
  return applicationPath(facet.node.path) &&
    applicationPath(facet.containerId === undefined ? undefined : graph.node(facet.containerId)?.path);
}
