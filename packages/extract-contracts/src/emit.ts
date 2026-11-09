/**
 * Node and edge construction.
 *
 * Every id here is path-free (v3 2.1) except where a contract that declares no
 * title falls back to its file stem for its name, which also names the
 * `SchemaProperty` ids under it (ADR-0016 item 4). Every edge is checked
 * against `isValidEdge` before it is returned, so an edge outside its declared
 * domain and range cannot leave this package.
 */

import {
  DEFAULT_SENSITIVITY,
  isValidEdge,
  nodeId,
  type EdgeKind,
  type NodeId,
  type NodeKind,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import type { ContractFact, OperationFact, PropertyFact } from './types.ts';

export type PropValue = string | number | boolean | null;

/**
 * Build a props bag with sorted keys, dropping entries that were never
 * declared. An undeclared constraint is omitted rather than stored as `null`,
 * so a node body carries only facts the document actually stated.
 */
export function props(entries: Readonly<Record<string, PropValue | undefined>>): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const key of Object.keys(entries).sort()) {
    const v = entries[key];
    if (v === undefined || v === null) continue;
    out[key] = v;
  }
  return out;
}

/** `{repo}:Contract:{contractName}` */
export function contractCanonicalName(contract: string): string {
  return contract;
}

/** `{repo}:Operation:{METHOD} {path}` */
export function operationCanonicalName(method: string, path: string): string {
  return `${method} ${path}`;
}

/** `{repo}:SchemaProperty:{contractName}#{jsonPointer}` */
export function schemaPropertyCanonicalName(contract: string, jsonPointer: string): string {
  return `${contract}#${jsonPointer}`;
}

interface BaseArgs {
  readonly repo: string;
  readonly runId: string;
}

function baseNode(
  args: BaseArgs,
  kind: NodeKind,
  canonicalName: string,
  name: string,
  path: string | null,
  sourceRef: string | null,
  bag: Record<string, PropValue>,
): SeamlineNode {
  const id: NodeId = nodeId(args.repo, kind, canonicalName);
  return {
    id,
    kind,
    name,
    ...(path === null ? {} : { path }),
    sensitivity: DEFAULT_SENSITIVITY[kind],
    provenance: 'EXTRACTED',
    confidence: 1,
    ...(sourceRef === null ? {} : { sourceRef }),
    props: bag,
    firstSeenRun: args.runId,
    lastSeenRun: args.runId,
    deletedAt: null,
  };
}

export function contractNode(args: BaseArgs, fact: ContractFact): SeamlineNode {
  return baseNode(
    args, 'Contract', contractCanonicalName(fact.name), fact.name, fact.file, fact.file,
    props({
      dialect: fact.dialect,
      version: fact.version,
      title: fact.title,
    }),
  );
}

export function operationNode(args: BaseArgs, fact: OperationFact): SeamlineNode {
  return baseNode(
    args,
    'Operation',
    operationCanonicalName(fact.method, fact.path),
    `${fact.method} ${fact.path}`,
    fact.file,
    `${fact.file}#${fact.jsonPointer}`,
    props({
      contract: fact.contract,
      method: fact.method,
      path: fact.path,
      operationId: fact.operationId,
      summary: fact.summary,
      deprecated: fact.deprecated,
      // The X6 inputs. `authMode: "unknown"` is not `authMode: "none"`.
      authMode: fact.auth.mode,
      authSource: fact.auth.source,
      authSchemes: fact.auth.schemes.length > 0 ? fact.auth.schemes.join(',') : null,
      authScopes: fact.auth.scopes.length > 0 ? fact.auth.scopes.join(',') : null,
      handlerDeclared: fact.handler !== null,
      jsonPointer: fact.jsonPointer,
    }),
  );
}

export function schemaPropertyNode(args: BaseArgs, fact: PropertyFact): SeamlineNode {
  return baseNode(
    args,
    'SchemaProperty',
    schemaPropertyCanonicalName(fact.contract, fact.jsonPointer),
    fact.name,
    fact.file,
    `${fact.file}#${fact.jsonPointer}`,
    props({
      contract: fact.contract,
      direction: fact.direction,
      lengthUpperState: fact.lengthUpperState,
      valueRole: fact.valueRole,
      writeBindingComplete: fact.writeBindingComplete,
      successfulParse: fact.successfulParse,
      unchangedForwarding: fact.unchangedForwarding,
      modelBindingComplete: fact.modelBindingComplete,
      storageModel: fact.storageModel,
      storageField: fact.storageField,
      storageTable: fact.storageTable,
      container: fact.container,
      bindingWitness: fact.bindingWitness,
      jsonPointer: fact.jsonPointer,
      type: fact.type === '' ? null : fact.type,
      format: fact.format,
      typeCategory: fact.typeCategory,
      // Two independent axes. Neither is ever derived from the other.
      required: fact.required,
      nullable: fact.nullable,
      isArray: fact.isArray,
      hasDefault: fact.hasDefault,
      default: fact.hasDefault ? fact.defaultValue : null,
      readOnly: fact.readOnly ? true : null,
      writeOnly: fact.writeOnly ? true : null,
      deprecated: fact.deprecated ? true : null,
      minLength: fact.minLength,
      maxLength: fact.maxLength,
      pattern: fact.pattern,
      minimum: fact.minimum,
      maximum: fact.maximum,
      exclusiveMinimum: fact.exclusiveMinimum,
      exclusiveMaximum: fact.exclusiveMaximum,
      multipleOf: fact.multipleOf,
      minItems: fact.minItems,
      maxItems: fact.maxItems,
      enumValues: fact.enumValues,
      enumCount: fact.enumCount,
      in: fact.in,
      description: fact.description,
    }),
  );
}

/**
 * `{repo}:RouteHandler:{METHOD} {path}`, colon-param syntax. Keyed the same
 * way `extract-code-ts`'s `routeCanonicalName` keys its own `RouteHandler`
 * nodes, so the two extractors converge on one shared node per real route
 * instead of each minting their own. `declaredHandler` carries the vendor
 * extension's binding string when the document declared one; it is
 * provenance, never identity.
 */
export function routeHandlerCanonicalName(method: string, routeParamPath: string): string {
  return `${method.toUpperCase()} ${routeParamPath}`;
}

export function routeHandlerNode(
  args: BaseArgs,
  method: string,
  routeParamPath: string,
  declaredHandler: string | null,
  file: string,
): SeamlineNode {
  const canonicalName = routeHandlerCanonicalName(method, routeParamPath);
  return baseNode(
    args, 'RouteHandler', canonicalName, canonicalName, file, file,
    props({ declaredBy: 'contract', declaredHandler }),
  );
}

export class InvalidEdgeError extends Error {}

/**
 * Construct an edge, refusing any `(kind, srcKind, dstKind)` triple outside
 * the ontology's declared signatures.
 */
export function makeEdge(
  args: BaseArgs,
  kind: EdgeKind,
  src: SeamlineNode,
  dst: SeamlineNode,
): SeamlineEdge {
  if (!isValidEdge(kind, src.kind, dst.kind)) {
    throw new InvalidEdgeError(`${kind} is not declared for ${src.kind} -> ${dst.kind}`);
  }
  return {
    kind,
    src: src.id,
    dst: dst.id,
    ...(src.path === undefined ? {} : { srcFile: src.path }),
    ...(dst.path === undefined ? {} : { dstFile: dst.path }),
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: args.runId,
    lastSeenRun: args.runId,
    deletedAt: null,
  };
}

export function sortNodes(nodes: readonly SeamlineNode[]): SeamlineNode[] {
  return [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function sortEdges(edges: readonly SeamlineEdge[]): SeamlineEdge[] {
  return [...edges].sort((a, b) => {
    const ka = `${a.kind} ${a.src} ${a.dst}`;
    const kb = `${b.kind} ${b.src} ${b.dst}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
