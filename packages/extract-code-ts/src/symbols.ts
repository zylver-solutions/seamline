/**
 * Pass one: declarations.
 *
 * Emits `Symbol`, `CodeField`, and `Parameter` nodes plus the containment edges
 * that hold them together, and records every declaration in `ctx.decls` so
 * pass two can resolve references to them.
 *
 * `CodeField` gets disproportionate attention here on purpose: the field-level
 * join is the product. A column's nullability against a field's nullability is
 * a contradiction only if both are recorded accurately, so optionality and
 * nullability are read as three separate facts — the `?` token, `undefined` in
 * the type, and `null` in the type — rather than conflated into one flag.
 */

import { Node } from 'ts-morph';
import type {
  ClassDeclaration, ConstructorDeclaration, EnumDeclaration, FunctionDeclaration,
  GetAccessorDeclaration, InterfaceDeclaration, MethodDeclaration, MethodSignature,
  ModuleDeclaration, ParameterDeclaration, PropertyDeclaration, PropertySignature,
  SourceFile, TypeAliasDeclaration, VariableDeclaration,
} from 'ts-morph';
import type { NodeId } from '@seamline/ontology';
import {
  codeFieldCanonicalName, codeFieldId, parameterCanonicalName, parameterId,
  symbolCanonicalName, symbolId,
} from './canonical.ts';
import type { Ctx, FileRecord } from './context.ts';
import { declKey } from './context.ts';
import type { Props } from './collector.ts';
import { sourceRef } from './paths.ts';
import { safeTypeText } from './resolve.ts';
import { normalizeTypeText } from './typetext.ts';
import { validationLibraryOf } from './validation.ts';

/** A named declaration container: a source file or a `namespace` body. */
type Container = SourceFile | ModuleDeclaration;

/** Name used for a declaration with no identifier (`export default class {}`). */
const ANONYMOUS_DEFAULT = 'default';

export interface SymbolEmit {
  readonly id: NodeId;
  readonly canonicalName: string;
  readonly chain: readonly string[];
}

/** Walk a file's declarations, emitting nodes and recording them in `ctx.decls`. */
export function declareFile(ctx: Ctx, sf: SourceFile, file: FileRecord): void {
  declareContainer(ctx, sf, file, []);
}

function declareContainer(ctx: Ctx, container: Container, file: FileRecord, parents: readonly string[]): void {
  for (const decl of container.getModules()) {
    const emitted = emitSymbol(ctx, file, parents, decl, nameOf(decl), 'namespace', {
      exported: decl.isExported(),
    });
    if (emitted !== undefined) declareContainer(ctx, decl, file, emitted.chain);
  }
  for (const decl of container.getClasses()) declareClass(ctx, decl, file, parents);
  for (const decl of container.getInterfaces()) declareInterface(ctx, decl, file, parents);
  for (const decl of container.getTypeAliases()) declareTypeAlias(ctx, decl, file, parents);
  for (const decl of container.getEnums()) declareEnum(ctx, decl, file, parents);
  for (const decl of container.getFunctions()) declareFunction(ctx, decl, file, parents);
  for (const decl of container.getVariableDeclarations()) declareVariable(ctx, decl, file, parents);
}

/* ------------------------------------------------------------------ classes */

function declareClass(ctx: Ctx, decl: ClassDeclaration, file: FileRecord, parents: readonly string[]): void {
  const owner = emitSymbol(ctx, file, parents, decl, nameOf(decl), 'class', {
    exported: decl.isExported(),
    abstract: decl.isAbstract(),
    decorators: decoratorNames(decl.getDecorators().map((d) => d.getName())),
  });
  if (owner === undefined) return;

  let ordinal = 0;
  for (const prop of decl.getProperties()) {
    emitField(ctx, file, owner, prop.getName(), ordinal, propertyFacts(prop), prop);
    ordinal += 1;
  }
  for (const accessor of decl.getGetAccessors()) {
    emitField(ctx, file, owner, accessor.getName(), ordinal, accessorFacts(accessor), accessor);
    ordinal += 1;
  }
  for (const ctor of decl.getConstructors()) {
    for (const param of ctor.getParameters()) {
      if (!param.isParameterProperty()) continue;
      emitField(ctx, file, owner, param.getName(), ordinal, parameterPropertyFacts(param), param);
      ordinal += 1;
    }
    declareFunctionLike(ctx, file, owner.chain, ctor, 'constructor', 'constructor', {
      visibility: ctor.getScope(),
    });
  }
  for (const method of decl.getMethods()) {
    declareFunctionLike(ctx, file, owner.chain, method, method.getName(), 'method', {
      exported: false,
      static: method.isStatic(),
      abstract: method.isAbstract(),
      async: method.isAsync(),
      visibility: method.getScope(),
      decorators: decoratorNames(method.getDecorators().map((d) => d.getName())),
    });
  }
}

/* --------------------------------------------------------------- interfaces */

function declareInterface(ctx: Ctx, decl: InterfaceDeclaration, file: FileRecord, parents: readonly string[]): void {
  const owner = emitSymbol(ctx, file, parents, decl, nameOf(decl), 'interface', {
    exported: decl.isExported(),
  });
  if (owner === undefined) return;
  let ordinal = 0;
  for (const prop of decl.getProperties()) {
    emitField(ctx, file, owner, prop.getName(), ordinal, signatureFacts(prop), prop);
    ordinal += 1;
  }
  for (const method of decl.getMethods()) {
    declareFunctionLike(ctx, file, owner.chain, method, method.getName(), 'method', { exported: false });
  }
}

/* -------------------------------------------------------------- type alias */

function declareTypeAlias(ctx: Ctx, decl: TypeAliasDeclaration, file: FileRecord, parents: readonly string[]): void {
  const owner = emitSymbol(ctx, file, parents, decl, nameOf(decl), 'type-alias', {
    exported: decl.isExported(),
    aliasOf: declaredTypeText(decl.getTypeNode()),
  });
  if (owner === undefined) return;
  const typeNode = decl.getTypeNode();
  if (typeNode === undefined || !Node.isTypeLiteral(typeNode)) return;
  let ordinal = 0;
  for (const prop of typeNode.getProperties()) {
    emitField(ctx, file, owner, prop.getName(), ordinal, signatureFacts(prop), prop);
    ordinal += 1;
  }
}

/* -------------------------------------------------------------------- enums */

function declareEnum(ctx: Ctx, decl: EnumDeclaration, file: FileRecord, parents: readonly string[]): void {
  const owner = emitSymbol(ctx, file, parents, decl, nameOf(decl), 'enum', {
    exported: decl.isExported(),
    const: decl.isConstEnum(),
  });
  if (owner === undefined) return;
  let ordinal = 0;
  for (const member of decl.getMembers()) {
    const value = member.getValue();
    const info = normalizeTypeText(typeof value === 'string' ? 'string' : 'number', member.getName());
    emitField(ctx, file, owner, member.getName(), ordinal, {
      rawType: info.rawType,
      baseType: info.baseType,
      declaredType: null,
      normalized: info.normalized,
      optional: false,
      nullable: false,
      readonly: true,
      static: true,
      visibility: 'public',
      accessor: null,
      hasInitializer: value !== undefined,
      enumValues: value === undefined ? '' : String(value),
      decorators: '',
      memberKind: 'enum-member',
    }, member);
    ordinal += 1;
  }
}

/* ---------------------------------------------------------------- functions */

function declareFunction(ctx: Ctx, decl: FunctionDeclaration, file: FileRecord, parents: readonly string[]): void {
  declareFunctionLike(ctx, file, parents, decl, nameOf(decl), 'function', {
    exported: decl.isExported(),
    async: decl.isAsync(),
  });
}

function declareVariable(ctx: Ctx, decl: VariableDeclaration, file: FileRecord, parents: readonly string[]): void {
  const initializer = decl.getInitializer();
  const isFunctionValued =
    initializer !== undefined && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer));
  if (isFunctionValued && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
    declareFunctionLike(ctx, file, parents, decl, decl.getName(), 'function', {
      exported: decl.isExported(),
      async: initializer.isAsync(),
      form: 'const',
    }, initializer.getParameters(), initializer.getReturnTypeNode()?.getText());
    return;
  }
  // `library` is set only when present, so a variable built without a
  // validation library carries exactly the props it always has.
  const library = validationLibraryOf(initializer);
  emitSymbol(ctx, file, parents, decl, decl.getName(), 'variable', {
    exported: decl.isExported(),
    declaredType: declaredTypeText(decl.getTypeNode()),
    type: normalizeTypeText(safeTypeText(decl.getType(), decl), decl.getName()).baseType,
    ...(library === null ? {} : { library }),
  });
}

type FunctionLike =
  | FunctionDeclaration | MethodDeclaration | MethodSignature | ConstructorDeclaration | VariableDeclaration;

function declareFunctionLike(
  ctx: Ctx,
  file: FileRecord,
  parents: readonly string[],
  decl: FunctionLike,
  name: string,
  symbolKind: string,
  extraProps: Props,
  parametersOverride?: readonly ParameterDeclaration[],
  returnTypeOverride?: string,
): void {
  const parameters = parametersOverride ?? getParameters(decl);
  const returnText = returnTypeOverride ?? returnTypeTextOf(decl);
  const returnInfo = returnText === null ? null : normalizeTypeText(returnText, name);
  const owner = emitSymbol(ctx, file, parents, decl, name, symbolKind, {
    ...extraProps,
    parameterCount: parameters.length,
    ...(returnInfo === null ? {} : { returnType: returnInfo.baseType, returnTypeNormalized: returnInfo.normalized }),
  });
  if (owner === undefined) return;
  parameters.forEach((param, index) => emitParameter(ctx, file, owner, param, index));
}

function getParameters(decl: FunctionLike): readonly ParameterDeclaration[] {
  if (Node.isVariableDeclaration(decl)) return [];
  return decl.getParameters();
}

function returnTypeTextOf(decl: FunctionLike): string | null {
  if (Node.isVariableDeclaration(decl)) return null;
  if (Node.isConstructorDeclaration(decl)) return null;
  const annotated = decl.getReturnTypeNode();
  if (annotated !== undefined) return annotated.getText();
  try {
    return safeTypeText(decl.getReturnType(), decl);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- fields */

interface FieldFacts {
  readonly rawType: string;
  readonly baseType: string;
  readonly declaredType: string | null;
  readonly normalized: string;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly readonly: boolean;
  readonly static: boolean;
  readonly visibility: string;
  readonly accessor: string | null;
  readonly hasInitializer: boolean;
  readonly enumValues: string;
  readonly decorators: string;
  readonly memberKind: string;
}

function propertyFacts(prop: PropertyDeclaration): FieldFacts {
  const info = normalizeTypeText(safeTypeText(prop.getType(), prop), prop.getName());
  return {
    rawType: info.rawType,
    baseType: info.baseType,
    declaredType: declaredTypeText(prop.getTypeNode()),
    normalized: info.normalized,
    optional: prop.hasQuestionToken() || info.hasUndefined,
    nullable: info.nullable,
    readonly: prop.isReadonly(),
    static: prop.isStatic(),
    visibility: prop.getScope(),
    accessor: null,
    hasInitializer: prop.getInitializer() !== undefined,
    enumValues: info.enumValues.join(','),
    decorators: decoratorNames(prop.getDecorators().map((d) => d.getName())),
    memberKind: 'property',
  };
}

function signatureFacts(prop: PropertySignature): FieldFacts {
  const info = normalizeTypeText(safeTypeText(prop.getType(), prop), prop.getName());
  return {
    rawType: info.rawType,
    baseType: info.baseType,
    declaredType: declaredTypeText(prop.getTypeNode()),
    normalized: info.normalized,
    optional: prop.hasQuestionToken() || info.hasUndefined,
    nullable: info.nullable,
    readonly: prop.isReadonly(),
    static: false,
    visibility: 'public',
    accessor: null,
    hasInitializer: false,
    enumValues: info.enumValues.join(','),
    decorators: '',
    memberKind: 'property',
  };
}

function accessorFacts(accessor: GetAccessorDeclaration): FieldFacts {
  const info = normalizeTypeText(safeTypeText(accessor.getReturnType(), accessor), accessor.getName());
  return {
    rawType: info.rawType,
    baseType: info.baseType,
    declaredType: declaredTypeText(accessor.getReturnTypeNode()),
    normalized: info.normalized,
    optional: info.hasUndefined,
    nullable: info.nullable,
    readonly: true,
    static: accessor.isStatic(),
    visibility: accessor.getScope(),
    accessor: 'get',
    hasInitializer: false,
    enumValues: info.enumValues.join(','),
    decorators: decoratorNames(accessor.getDecorators().map((d) => d.getName())),
    memberKind: 'accessor',
  };
}

/**
 * A constructor parameter property (`constructor(private readonly x: T)`) is a
 * field. It is banned in this repo by `erasableSyntaxOnly`, but it is extremely
 * common in the NestJS/Angular code this extractor reads, and missing it would
 * silently drop most fields of a typical service class.
 */
function parameterPropertyFacts(param: ParameterDeclaration): FieldFacts {
  const info = normalizeTypeText(safeTypeText(param.getType(), param), param.getName());
  return {
    rawType: info.rawType,
    baseType: info.baseType,
    declaredType: declaredTypeText(param.getTypeNode()),
    normalized: info.normalized,
    optional: param.isOptional() || info.hasUndefined,
    nullable: info.nullable,
    readonly: param.isReadonly(),
    static: false,
    // A parameter property without an explicit modifier is public.
    visibility: param.getScope() ?? 'public',
    accessor: null,
    hasInitializer: param.hasInitializer(),
    enumValues: info.enumValues.join(','),
    decorators: decoratorNames(param.getDecorators().map((d) => d.getName())),
    memberKind: 'parameter-property',
  };
}

function emitField(
  ctx: Ctx,
  file: FileRecord,
  owner: SymbolEmit,
  name: string,
  ordinal: number,
  facts: FieldFacts,
  decl: Node,
): void {
  const canonicalName = codeFieldCanonicalName(owner.canonicalName, name);
  const id = codeFieldId(ctx.repo, canonicalName);
  ctx.collector.node({
    id,
    kind: 'CodeField',
    name,
    path: file.rel,
    sourceRef: sourceRef(file.rel, decl.getStartLineNumber()),
    props: {
      owner: owner.canonicalName,
      ordinal,
      type: facts.baseType,
      rawType: facts.rawType,
      declaredType: facts.declaredType,
      normalizedType: facts.normalized,
      optional: facts.optional,
      required: !facts.optional,
      nullable: facts.nullable,
      readonly: facts.readonly,
      static: facts.static,
      visibility: facts.visibility,
      accessor: facts.accessor,
      hasInitializer: facts.hasInitializer,
      enumValues: facts.enumValues,
      decorators: facts.decorators,
      memberKind: facts.memberKind,
    },
  });
  ctx.decls.set(declKey(decl), { id, canonicalName, kind: 'CodeField', file: file.rel, declaration: decl });
  ctx.collector.edge({
    kind: 'CONTAINS', src: owner.id, dst: id, srcFile: file.rel, dstFile: file.rel,
  });
}

/* --------------------------------------------------------------- parameters */

function emitParameter(
  ctx: Ctx,
  file: FileRecord,
  owner: SymbolEmit,
  param: ParameterDeclaration,
  index: number,
): void {
  const name = param.getName();
  const info = normalizeTypeText(safeTypeText(param.getType(), param), name);
  const canonicalName = parameterCanonicalName(owner.canonicalName, index, name);
  const id = parameterId(ctx.repo, canonicalName);
  ctx.collector.node({
    id,
    kind: 'Parameter',
    name,
    path: file.rel,
    sourceRef: sourceRef(file.rel, param.getStartLineNumber()),
    props: {
      owner: owner.canonicalName,
      index,
      type: info.baseType,
      rawType: info.rawType,
      declaredType: declaredTypeText(param.getTypeNode()),
      normalizedType: info.normalized,
      optional: param.isOptional() || info.hasUndefined,
      nullable: info.nullable,
      rest: param.isRestParameter(),
      hasDefault: param.hasInitializer(),
      decorators: decoratorNames(param.getDecorators().map((d) => d.getName())),
    },
  });
  ctx.decls.set(declKey(param), { id, canonicalName, kind: 'Parameter', file: file.rel, declaration: param });
  ctx.collector.edge({
    kind: 'CONTAINS', src: owner.id, dst: id, srcFile: file.rel, dstFile: file.rel,
  });
}

/* ------------------------------------------------------------------- shared */

function emitSymbol(
  ctx: Ctx,
  file: FileRecord,
  parents: readonly string[],
  decl: Node,
  name: string,
  symbolKind: string,
  props: Props,
): SymbolEmit | undefined {
  if (name.length === 0) return undefined;
  const chain = [...parents, name];
  const canonicalName = symbolCanonicalName(file.module.name, chain);
  const id = symbolId(ctx.repo, canonicalName);
  ctx.collector.node({
    id,
    kind: 'Symbol',
    name,
    path: file.rel,
    sourceRef: sourceRef(file.rel, decl.getStartLineNumber()),
    props: { ...props, symbolKind, module: file.module.name, qualifiedName: chain.join('.') },
  });
  ctx.decls.set(declKey(decl), { id, canonicalName, kind: 'Symbol', file: file.rel, declaration: decl });
  ctx.collector.edge({
    kind: 'CONTAINS', src: file.id, dst: id, srcFile: file.rel, dstFile: file.rel,
  });
  return { id, canonicalName, chain };
}

function nameOf(decl: { getName(): string | undefined }): string {
  return decl.getName() ?? ANONYMOUS_DEFAULT;
}

/** Source-order decorator names, sorted so the prop is stable. */
function decoratorNames(names: readonly string[]): string {
  return [...names].sort().join(',');
}

function declaredTypeText(typeNode: Node | undefined): string | null {
  if (typeNode === undefined) return null;
  return typeNode.getText().replace(/\s+/g, ' ').trim();
}
