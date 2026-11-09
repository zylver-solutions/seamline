/**
 * An in-memory `GraphView` and fixture builders, for this package's tests.
 *
 * It is a double, not a store: no runs, no tombstoning semantics beyond
 * honouring `deletedAt`, no merge. The node/edge indexing itself comes from
 * `@seamline/core`'s `memoryGraphIndex` (shared with the equivalent doubles in
 * `@seamline/contradictions` and `@seamline/cli`); this module keeps only the
 * `GraphView` wrapper, scope-status policy, and fixture builders.
 *
 * The builders mirror what the three extractors are specified to emit, so the
 * fixtures read like real extractor output rather than like matcher inputs
 * reverse-engineered to pass.
 */

import type {
  EdgeKind, ExtractorStatus, GraphView, NodeKind, Provenance, SeamlineEdge, SeamlineNode,
} from '@seamline/ontology';
import { DEFAULT_SENSITIVITY, nodeId } from '@seamline/ontology';
import { memoryGraphIndex } from '@seamline/core';

export const TEST_RUN = 'run-test';
export const TEST_REPO = 'demo';

export interface MemoryGraph extends GraphView {
  addNode(node: SeamlineNode): SeamlineNode;
  addEdge(edge: SeamlineEdge): SeamlineEdge;
  setScope(scope: string, status: ExtractorStatus): void;
  readonly allEdges: ReadonlyArray<SeamlineEdge>;
}

export function memoryGraph(scopes: Readonly<Record<string, ExtractorStatus>> = {}): MemoryGraph {
  const index = memoryGraphIndex();
  const scopeStatuses = new Map<string, ExtractorStatus>(Object.entries(scopes));

  const graph: MemoryGraph = {
    addNode(node) {
      index.addNode(node);
      return node;
    },
    addEdge(edge) {
      index.addEdge(edge);
      return edge;
    },
    setScope(scope, status) {
      scopeStatuses.set(scope, status);
    },
    get allEdges() {
      return index.allEdges;
    },
    nodesByKind(kind) {
      return index.nodesByKind(kind);
    },
    node(id) {
      return index.node(id);
    },
    edgesFrom(id, kind) {
      return index.edgesFrom(id, kind);
    },
    edgesTo(id, kind) {
      return index.edgesTo(id, kind);
    },
    scopeStatus(scope) {
      // Default PASS: a fixture that does not care about lifecycle should not
      // have to opt in to every scope being healthy.
      return scopeStatuses.get(scope) ?? 'PASS';
    },
  };
  return graph;
}

export interface NodeSpec {
  readonly kind: NodeKind;
  readonly canonicalName: string;
  readonly name: string;
  readonly path?: string;
  readonly props?: Readonly<Record<string, string | number | boolean | null>>;
  readonly provenance?: Provenance;
  readonly confidence?: number;
  readonly repo?: string;
  readonly deletedAt?: string | null;
}

export function makeNode(spec: NodeSpec): SeamlineNode {
  const repo = spec.repo ?? TEST_REPO;
  return {
    id: nodeId(repo, spec.kind, spec.canonicalName),
    kind: spec.kind,
    name: spec.name,
    ...(spec.path !== undefined ? { path: spec.path } : {}),
    sensitivity: DEFAULT_SENSITIVITY[spec.kind],
    provenance: spec.provenance ?? 'EXTRACTED',
    confidence: spec.confidence ?? 1,
    props: spec.props ?? {},
    firstSeenRun: TEST_RUN,
    lastSeenRun: TEST_RUN,
    deletedAt: spec.deletedAt ?? null,
  };
}

export interface EdgeSpec {
  readonly kind: EdgeKind;
  readonly src: SeamlineNode;
  readonly dst: SeamlineNode;
  readonly provenance?: Provenance;
  readonly confidence?: number;
  readonly props?: Readonly<Record<string, string | number | boolean | null>>;
}

export function makeEdge(spec: EdgeSpec): SeamlineEdge {
  return {
    kind: spec.kind,
    src: spec.src.id,
    dst: spec.dst.id,
    ...(spec.src.path !== undefined ? { srcFile: spec.src.path } : {}),
    ...(spec.dst.path !== undefined ? { dstFile: spec.dst.path } : {}),
    provenance: spec.provenance ?? 'EXTRACTED',
    confidence: spec.confidence ?? 1,
    props: spec.props ?? {},
    firstSeenRun: TEST_RUN,
    lastSeenRun: TEST_RUN,
    deletedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Domain builders
// ---------------------------------------------------------------------------

export interface ColumnSpec {
  readonly name: string;
  readonly type?: string;
  readonly nullable?: boolean;
  readonly props?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface TableFixture {
  readonly table: SeamlineNode;
  readonly columns: ReadonlyMap<string, SeamlineNode>;
}

/** A `Table` with its `Column` children, as `extract-data` would emit them. */
export function addTable(
  graph: MemoryGraph,
  spec: {
    readonly name: string;
    readonly columns: ReadonlyArray<ColumnSpec>;
    readonly datasource?: string;
    readonly schema?: string;
    readonly path?: string;
  },
): TableFixture {
  const datasource = spec.datasource ?? 'main';
  const schema = spec.schema ?? 'public';
  const table = graph.addNode(makeNode({
    kind: 'Table',
    canonicalName: `${datasource}.${schema}.${spec.name}`,
    name: spec.name,
    ...(spec.path !== undefined ? { path: spec.path } : {}),
  }));
  const columns = new Map<string, SeamlineNode>();
  for (const column of spec.columns) {
    const node = graph.addNode(makeNode({
      kind: 'Column',
      canonicalName: `${datasource}.${schema}.${spec.name}.${column.name}`,
      name: column.name,
      ...(spec.path !== undefined ? { path: spec.path } : {}),
      props: {
        ...(column.type !== undefined ? { type: column.type } : {}),
        ...(column.nullable !== undefined ? { nullable: column.nullable } : {}),
        ...column.props,
      },
    }));
    graph.addEdge(makeEdge({ kind: 'CONTAINS', src: table, dst: node }));
    columns.set(column.name, node);
  }
  return { table, columns };
}

export interface FieldSpec {
  readonly name: string;
  readonly type?: string;
  readonly optional?: boolean;
  readonly props?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SymbolFixture {
  readonly symbol: SeamlineNode;
  readonly fields: ReadonlyMap<string, SeamlineNode>;
}

/** A `Symbol` (class or interface) with its `CodeField` children. */
export function addSymbol(
  graph: MemoryGraph,
  spec: {
    readonly name: string;
    readonly fields?: ReadonlyArray<FieldSpec>;
    readonly path?: string;
    readonly props?: Readonly<Record<string, string | number | boolean | null>>;
  },
): SymbolFixture {
  const path = spec.path ?? `src/${spec.name}.ts`;
  const symbol = graph.addNode(makeNode({
    kind: 'Symbol',
    canonicalName: `${path}::${spec.name}`,
    name: spec.name,
    path,
    ...(spec.props !== undefined ? { props: spec.props } : {}),
  }));
  const fields = new Map<string, SeamlineNode>();
  for (const field of spec.fields ?? []) {
    const node = graph.addNode(makeNode({
      kind: 'CodeField',
      canonicalName: `${path}::${spec.name}.${field.name}`,
      name: field.name,
      path,
      props: {
        ...(field.type !== undefined ? { type: field.type } : {}),
        ...(field.optional !== undefined ? { optional: field.optional } : {}),
        ...field.props,
      },
    }));
    graph.addEdge(makeEdge({ kind: 'CONTAINS', src: symbol, dst: node }));
    fields.set(field.name, node);
  }
  return { symbol, fields };
}

export interface PropertySpec {
  readonly name: string;
  readonly type?: string;
  readonly format?: string;
  readonly required?: boolean;
}

export interface ContractFixture {
  readonly contract: SeamlineNode;
  readonly properties: ReadonlyMap<string, SeamlineNode>;
}

/**
 * A `Contract` with `SchemaProperty` children whose canonical names are JSON
 * pointers, as v3 §2.1 specifies (`(contract, json_pointer)`).
 */
export function addContract(
  graph: MemoryGraph,
  spec: {
    readonly document: string;
    readonly object: string;
    readonly properties: ReadonlyArray<PropertySpec>;
  },
): ContractFixture {
  const contract = graph.addNode(makeNode({
    kind: 'Contract',
    canonicalName: spec.document,
    name: spec.document,
    path: spec.document,
  }));
  const properties = new Map<string, SeamlineNode>();
  for (const property of spec.properties) {
    const pointer = `/components/schemas/${spec.object}/properties/${property.name}`;
    const node = graph.addNode(makeNode({
      kind: 'SchemaProperty',
      canonicalName: `${spec.document}#${pointer}`,
      name: property.name,
      path: spec.document,
      props: {
        ...(property.type !== undefined ? { type: property.type } : {}),
        ...(property.format !== undefined ? { format: property.format } : {}),
        ...(property.required !== undefined ? { required: property.required } : {}),
      },
    }));
    graph.addEdge(makeEdge({ kind: 'CONTAINS', src: contract, dst: node }));
    properties.set(property.name, node);
  }
  return { contract, properties };
}

/** A bare `Symbol`, e.g. a decorator or a validator schema. */
export function addBareSymbol(
  graph: MemoryGraph,
  name: string,
  props: Readonly<Record<string, string | number | boolean | null>> = {},
  path = 'src/validation.ts',
): SeamlineNode {
  return graph.addNode(makeNode({
    kind: 'Symbol',
    canonicalName: `${path}::${name}`,
    name,
    path,
    props,
  }));
}

export interface LoweredPropertySpec {
  readonly pointer: string;
  readonly type: string;
}

/**
 * A `Contract` lowered from a schema value, shaped the way `extract-contracts`
 * emits one for a Zod object: named after the value, declared in its file,
 * with `SchemaProperty` children keyed by JSON pointer.
 */
export function addLoweredSchema(
  graph: MemoryGraph,
  spec: {
    readonly name: string;
    readonly path: string;
    readonly dialect: string;
    readonly properties: ReadonlyArray<LoweredPropertySpec>;
  },
): ContractFixture {
  const contract = graph.addNode(makeNode({
    kind: 'Contract',
    canonicalName: spec.name,
    name: spec.name,
    path: spec.path,
    props: { dialect: spec.dialect },
  }));
  const properties = new Map<string, SeamlineNode>();
  for (const property of spec.properties) {
    const name = property.pointer.split('/').pop() ?? property.pointer;
    const node = graph.addNode(makeNode({
      kind: 'SchemaProperty',
      canonicalName: `${spec.name}#${property.pointer}`,
      name,
      path: spec.path,
      props: {
        contract: spec.name, jsonPointer: property.pointer, type: property.type, typeCategory: property.type,
      },
    }));
    graph.addEdge(makeEdge({ kind: 'CONTAINS', src: contract, dst: node }));
    properties.set(property.pointer, node);
  }
  return { contract, properties };
}
