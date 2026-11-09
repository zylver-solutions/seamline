/**
 * Structural corroboration.
 *
 * Names and types are what a pair of nodes *look* like. This module is about
 * what the codebase actually *does*: a repository class whose methods query the
 * `posts` table is real evidence that its fields correspond to that table's
 * columns, and it is evidence that survives a rename on either side.
 *
 * Every signal here is read from an EXTRACTED edge, so corroboration is
 * grounded in fact even though the join it supports is inferred. That is the
 * asymmetry worth noticing: this component never invents structure, it only
 * notices structure someone else extracted.
 *
 * Corroboration is capped at 1.0 and enters the weighted sum at weight 0.10, so
 * it can move a borderline pair over the line and can push a good pair to the
 * ceiling, but it can never carry a pair on its own.
 */

import type { GraphView, NodeId, SeamlineNode } from '@seamline/ontology';
import type { Facet } from './facets.ts';
import { canonicalKey, containerCoreKey, literalKey } from './naming.ts';

/**
 * Decorator names that mean "this field is persisted". Curated from the ORMs
 * this project actually sees: TypeORM, MikroORM, Sequelize-typescript,
 * NestJS/GraphQL field decorators.
 */
export const ORM_DECORATORS: ReadonlySet<string> = new Set([
  'Column', 'PrimaryColumn', 'PrimaryGeneratedColumn', 'PrimaryKey',
  'CreateDateColumn', 'UpdateDateColumn', 'DeleteDateColumn', 'VersionColumn',
  'ObjectIdColumn', 'Property', 'Prop', 'Field', 'Enum', 'Embedded',
  'ManyToOne', 'OneToMany', 'OneToOne', 'ManyToMany', 'JoinColumn', 'JoinTable',
  'Attribute', 'AllowNull', 'Default', 'Unique', 'Index', 'ForeignKey',
]);

/** Container-name and path shapes that mean "this type sits in the persistence layer". */
const PERSISTENCE_NAME = /(repository|repositories|repo|dao|entity|entities|model|models|record|row|table|store|schema|orm|mapper)/u;
const PERSISTENCE_PATH = /(^|\/)(repositories|repository|entities|entity|models|model|dao|db|database|schema|schemas|orm|persistence|store|stores)(\/|\.)/u;

export interface StructureIndex {
  /** table id -> symbol ids that have a QUERIES edge to it. */
  readonly symbolsQueryingTable: ReadonlyMap<NodeId, ReadonlySet<NodeId>>;
  /** table id -> files of those symbols. */
  readonly filesQueryingTable: ReadonlyMap<NodeId, ReadonlySet<string>>;
  /** node id -> DECORATED_WITH target nodes. */
  readonly decoratorsOf: ReadonlyMap<NodeId, ReadonlyArray<SeamlineNode>>;
  /** contract id -> symbol ids that handle one of its operations. */
  readonly symbolsServingContract: ReadonlyMap<NodeId, ReadonlySet<NodeId>>;
  /** contract id -> files of those symbols. */
  readonly filesServingContract: ReadonlyMap<NodeId, ReadonlySet<string>>;
  /** node id -> repo-relative path, for nodes that have one. */
  readonly fileOf: ReadonlyMap<NodeId, string>;
  /** symbol id -> ids of symbols it EXTENDS or IMPLEMENTS. */
  readonly supertypesOf: ReadonlyMap<NodeId, ReadonlyArray<SeamlineNode>>;
}

function addToSetMap<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, new Set([value]));
  else existing.add(value);
}

/** Build every index the corroboration functions need, in one pass over the graph. */
export function buildStructureIndex(graph: GraphView): StructureIndex {
  const symbolsQueryingTable = new Map<NodeId, Set<NodeId>>();
  const filesQueryingTable = new Map<NodeId, Set<string>>();
  const decoratorsOf = new Map<NodeId, SeamlineNode[]>();
  const symbolsServingContract = new Map<NodeId, Set<NodeId>>();
  const filesServingContract = new Map<NodeId, Set<string>>();
  const fileOf = new Map<NodeId, string>();
  const supertypesOf = new Map<NodeId, SeamlineNode[]>();

  const live = (n: SeamlineNode): boolean => n.deletedAt === null;
  const sortedNodes = (kind: Parameters<GraphView['nodesByKind']>[0]): ReadonlyArray<SeamlineNode> =>
    graph.nodesByKind(kind).filter(live).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const kind of ['Symbol', 'CodeField', 'Table', 'Column', 'Contract', 'SchemaProperty', 'RouteHandler', 'Operation', 'File'] as const) {
    for (const node of sortedNodes(kind)) {
      if (node.path !== undefined) fileOf.set(node.id, node.path);
    }
  }

  for (const symbol of sortedNodes('Symbol')) {
    for (const edge of graph.edgesFrom(symbol.id, 'QUERIES')) {
      if (edge.deletedAt !== null) continue;
      addToSetMap(symbolsQueryingTable, edge.dst, symbol.id);
      const file = symbol.path ?? edge.srcFile;
      if (file !== undefined) addToSetMap(filesQueryingTable, edge.dst, file);
    }
    for (const kind of ['EXTENDS', 'IMPLEMENTS'] as const) {
      for (const edge of graph.edgesFrom(symbol.id, kind)) {
        if (edge.deletedAt !== null) continue;
        const target = graph.node(edge.dst);
        if (target === undefined || !live(target)) continue;
        const bucket = supertypesOf.get(symbol.id);
        if (bucket === undefined) supertypesOf.set(symbol.id, [target]);
        else bucket.push(target);
      }
    }
  }

  for (const kind of ['Symbol', 'CodeField'] as const) {
    for (const node of sortedNodes(kind)) {
      for (const edge of graph.edgesFrom(node.id, 'DECORATED_WITH')) {
        if (edge.deletedAt !== null) continue;
        const decorator = graph.node(edge.dst);
        if (decorator === undefined || !live(decorator)) continue;
        const bucket = decoratorsOf.get(node.id);
        if (bucket === undefined) decoratorsOf.set(node.id, [decorator]);
        else bucket.push(decorator);
      }
    }
  }

  // Contract -> Operation -> RouteHandler <- Symbol.
  for (const contract of sortedNodes('Contract')) {
    for (const contains of graph.edgesFrom(contract.id, 'CONTAINS')) {
      if (contains.deletedAt !== null) continue;
      const operation = graph.node(contains.dst);
      if (operation === undefined || operation.kind !== 'Operation' || !live(operation)) continue;
      for (const impl of graph.edgesFrom(operation.id, 'IMPLEMENTED_BY')) {
        if (impl.deletedAt !== null) continue;
        for (const handles of graph.edgesTo(impl.dst, 'HANDLES_ROUTE')) {
          if (handles.deletedAt !== null) continue;
          const symbol = graph.node(handles.src);
          if (symbol === undefined || !live(symbol)) continue;
          addToSetMap(symbolsServingContract, contract.id, symbol.id);
          const file = symbol.path ?? handles.srcFile;
          if (file !== undefined) addToSetMap(filesServingContract, contract.id, file);
        }
      }
    }
  }

  return {
    symbolsQueryingTable,
    filesQueryingTable,
    decoratorsOf,
    symbolsServingContract,
    filesServingContract,
    fileOf,
    supertypesOf,
  };
}

function directoryOf(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function decoratorNamesFor(index: StructureIndex, ids: ReadonlyArray<NodeId | undefined>): ReadonlyArray<SeamlineNode> {
  const out: SeamlineNode[] = [];
  for (const id of ids) {
    if (id === undefined) continue;
    for (const decorator of index.decoratorsOf.get(id) ?? []) out.push(decorator);
  }
  return out;
}

/**
 * Corroboration for Column -> CodeField.
 *
 *   0.50  the field's class has a QUERIES edge to the column's table
 *   0.30  some symbol in the field's file queries that table (weaker: file, not class)
 *   0.25  the field or its class carries an ORM persistence decorator
 *   +0.35 that decorator names this exact column (`@Column({ name: 'scheduled_at' })`)
 *   0.15  the field's class name or path is persistence-layer shaped
 *   0.20  the class and the table are declared in the same file (Drizzle, Prisma-in-TS)
 */
export function corroborateColumnField(index: StructureIndex, column: Facet, field: Facet): number {
  let score = 0;
  const tableId = column.containerId;
  const symbolId = field.containerId;

  if (tableId !== undefined) {
    const queryingSymbols = index.symbolsQueryingTable.get(tableId);
    if (symbolId !== undefined && queryingSymbols?.has(symbolId) === true) {
      score += 0.5;
    } else if (field.file !== undefined && index.filesQueryingTable.get(tableId)?.has(field.file) === true) {
      score += 0.3;
    }
  }

  const decorators = decoratorNamesFor(index, [field.id, symbolId]);
  if (decorators.some((d) => ORM_DECORATORS.has(d.name))) {
    score += 0.25;
    const columnKey = literalKey(column.name);
    const namesThisColumn = decorators.some((d) => {
      for (const key of ['name', 'column', 'field', 'columnName']) {
        const value = d.props[key];
        if (typeof value === 'string' && literalKey(value) === columnKey) return true;
      }
      return false;
    });
    if (namesThisColumn) score += 0.35;
  }

  const containerName = field.container;
  const containerPath = symbolId === undefined ? field.file : index.fileOf.get(symbolId) ?? field.file;
  if (PERSISTENCE_NAME.test(canonicalKey(containerName)) || (containerPath !== undefined && PERSISTENCE_PATH.test(containerPath))) {
    score += 0.15;
  }

  const tableFile = tableId === undefined ? undefined : index.fileOf.get(tableId);
  if (tableFile !== undefined && containerPath !== undefined && tableFile === containerPath) {
    score += 0.2;
  }

  return Math.min(1, score);
}

/**
 * Corroboration for CodeField -> SchemaProperty.
 *
 *   0.40  the field's class serves an operation of the property's contract
 *   0.25  some symbol in the field's file serves that contract
 *   0.20  the field's class extends or implements a type named like the schema object
 *   0.10  the class and the contract document live in the same directory
 */
export function corroborateFieldProperty(index: StructureIndex, field: Facet, property: Facet): number {
  let score = 0;
  const contractId = property.containerId;
  const symbolId = field.containerId;

  if (contractId !== undefined) {
    const serving = index.symbolsServingContract.get(contractId);
    if (symbolId !== undefined && serving?.has(symbolId) === true) {
      score += 0.4;
    } else if (field.file !== undefined && index.filesServingContract.get(contractId)?.has(field.file) === true) {
      score += 0.25;
    }
  }

  if (symbolId !== undefined) {
    const objectKey = containerCoreKey(property.container);
    const supertypes = index.supertypesOf.get(symbolId) ?? [];
    if (objectKey.length > 0 && supertypes.some((s) => containerCoreKey(s.name) === objectKey)) {
      score += 0.2;
    }
  }

  const contractDir = directoryOf(contractId === undefined ? undefined : index.fileOf.get(contractId));
  const fieldDir = directoryOf(field.file);
  if (contractDir !== undefined && fieldDir !== undefined && contractDir === fieldDir) {
    score += 0.1;
  }

  return Math.min(1, score);
}

/**
 * Corroboration for Column -> SchemaProperty.
 *
 * The strong signal here is transitive: if the column already maps to a code
 * field, and that field is already exposed as this property, then the column
 * and the property are the same value two hops apart. That is inference over
 * inference, so it is capped well below the direct signals and is *evidence*,
 * not a shortcut - the pair still has to pass the name and container gates on
 * its own.
 *
 *   0.60  a code field joins both sides (Column -> field -> SchemaProperty)
 *   0.40  a symbol querying the column's table serves the property's contract
 */
export function corroborateColumnProperty(
  index: StructureIndex,
  column: Facet,
  property: Facet,
  columnToFields: ReadonlyMap<NodeId, ReadonlySet<NodeId>>,
  fieldToProperties: ReadonlyMap<NodeId, ReadonlySet<NodeId>>,
): number {
  let score = 0;
  const fields = columnToFields.get(column.id);
  if (fields !== undefined) {
    for (const fieldId of fields) {
      if (fieldToProperties.get(fieldId)?.has(property.id) === true) {
        score += 0.6;
        break;
      }
    }
  }

  const tableId = column.containerId;
  const contractId = property.containerId;
  if (tableId !== undefined && contractId !== undefined) {
    const querying = index.symbolsQueryingTable.get(tableId);
    const serving = index.symbolsServingContract.get(contractId);
    if (querying !== undefined && serving !== undefined) {
      for (const symbolId of querying) {
        if (serving.has(symbolId)) {
          score += 0.4;
          break;
        }
      }
    }
  }

  return Math.min(1, score);
}

/**
 * Corroboration for a target and a validator symbol: co-location is the only
 * structural evidence available without executing anything.
 *
 *   0.40  the validator and the target's container are declared in the same file
 *   0.20  same directory
 */
export function corroborateValidator(index: StructureIndex, target: Facet, validator: SeamlineNode): number {
  const validatorFile = validator.path ?? index.fileOf.get(validator.id);
  const targetFile = target.containerId === undefined
    ? target.file
    : index.fileOf.get(target.containerId) ?? target.file;
  if (validatorFile === undefined || targetFile === undefined) return 0;
  if (validatorFile === targetFile) return 0.4;
  return directoryOf(validatorFile) === directoryOf(targetFile) ? 0.2 : 0;
}
