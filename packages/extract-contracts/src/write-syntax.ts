// SPDX-License-Identifier: Apache-2.0
/** Lexical source witnesses, without a compiler program or type-checker execution. */
import type * as TS from 'typescript';
import { exactQueryCopyNode } from './write-query-copy-nodes.ts';
import { permitsQueryDataCopy } from './write-query-copy-proof.ts';
import { unwrap, WriteUnknown, type WriteDeclaration, type WriteSource } from './write-source.ts';

function binders(ts: typeof TS, binding: TS.BindingName): TS.Identifier[] {
  if (ts.isIdentifier(binding)) return [binding];
  const found: TS.Identifier[] = [];
  for (const element of binding.elements) {
    if (ts.isBindingElement(element)) found.push(...binders(ts, element.name));
  }
  return found;
}

function variableBindings(ts: typeof TS, node: TS.VariableStatement): TS.Identifier[] {
  return node.declarationList.declarations.flatMap(declaration => binders(ts, declaration.name));
}

function statementBindings(ts: typeof TS, statements: readonly TS.Statement[]): TS.Identifier[] {
  const out: TS.Identifier[] = [];
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) out.push(...variableBindings(ts, statement));
    else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name !== undefined)
      out.push(statement.name);
    else if (ts.isImportDeclaration(statement) && statement.importClause !== undefined) {
      const clause = statement.importClause;
      if (clause.isTypeOnly) continue;
      if (clause.name !== undefined) out.push(clause.name);
      if (clause.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) out.push(clause.namedBindings.name);
        else for (const specifier of clause.namedBindings.elements) {
          if (!specifier.isTypeOnly) out.push(specifier.name);
        }
      }
    }
  }
  return out;
}

// Nodes belong to immutable parsed source. Weak keys let an extraction release
// its input trees; no source answer survives into a newly parsed revision.
const lexicalAnswers = new WeakMap<TS.Identifier, { readonly binding?: TS.Identifier }>();

/** Return the identifier that declares the nearest lexical value binding. */
export function lexicalBinding(ts: typeof TS, reference: TS.Identifier): TS.Identifier | undefined {
  const known = lexicalAnswers.get(reference);
  if (known !== undefined) return known.binding;
  const binding = findLexicalBinding(ts, reference);
  lexicalAnswers.set(reference, binding === undefined ? {} : { binding });
  return binding;
}

function findLexicalBinding(ts: typeof TS, reference: TS.Identifier): TS.Identifier | undefined {
  for (let scope: TS.Node | undefined = reference.parent; scope !== undefined; scope = scope.parent) {
    let candidates: TS.Identifier[] = [];
    if (ts.isSourceFile(scope) || ts.isBlock(scope)) candidates = statementBindings(ts, scope.statements);
    else if (ts.isFunctionLike(scope)) {
      candidates = scope.parameters.flatMap(parameter => binders(ts, parameter.name));
      if ((ts.isFunctionExpression(scope) || ts.isFunctionDeclaration(scope)) && scope.name !== undefined)
        candidates.push(scope.name);
      // A var in a nested block is function-scoped. Treat it as a shadow even
      // before its statement, as JavaScript does; nested functions are separate.
      const scan = (node: TS.Node): void => {
        if (node !== scope && ts.isFunctionLike(node)) return;
        if (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped)) {
          for (const declaration of node.declarations) candidates.push(...binders(ts, declaration.name));
        }
        ts.forEachChild(node, scan);
      };
      const body = (scope as TS.FunctionLikeDeclaration).body;
      if (body !== undefined) scan(body);
    } else if (ts.isCatchClause(scope) && scope.variableDeclaration !== undefined) {
      candidates = binders(ts, scope.variableDeclaration.name);
    } else if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
      const initializer = scope.initializer;
      if (initializer !== undefined && ts.isVariableDeclarationList(initializer))
        candidates = initializer.declarations.flatMap(declaration => binders(ts, declaration.name));
    }
    const matches = candidates.filter(candidate => candidate.text === reference.text);
    if (matches.length > 1) throw new WriteUnknown('WRITE_LEXICAL_BINDING_AMBIGUOUS');
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

export function isLibraryBinding(project: WriteSource, reference: TS.Identifier, packageName: string, imported: string): boolean {
  const ts = project.ts;
  project.assertExternalImport(reference.getSourceFile(), packageName);
  const binding = lexicalBinding(ts, reference);
  if (binding === undefined) return false;
  const parent = binding.parent;
  if (ts.isImportSpecifier(parent)) {
    const clause = parent.parent.parent;
    const declaration = clause.parent;
    return !parent.isTypeOnly && !clause.isTypeOnly &&
      (parent.propertyName?.text ?? parent.name.text) === imported &&
      ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier) &&
      declaration.moduleSpecifier.text === packageName;
  }
  if (ts.isImportClause(parent)) {
    const declaration = parent.parent;
    return imported === 'default' && !parent.isTypeOnly &&
      ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier) &&
      declaration.moduleSpecifier.text === packageName;
  }
  return false;
}

export function isAssignment(ts: typeof TS, node: TS.BinaryExpression): boolean {
  return node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
}

function valueIdentifier(ts: typeof TS, node: TS.Identifier): boolean {
  const parent = node.parent;
  const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isImportSpecifier(parent) && parent.propertyName === node);
  const declarationName = (ts.isVariableDeclaration(parent) || ts.isParameter(parent) ||
    ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node;
  return !propertyName && !declarationName;
}

/** Every value reference to this declaration; property names and types are not references. */
export function references(ts: typeof TS, root: TS.Node, binding: TS.Identifier): readonly TS.Identifier[] {
  const out: TS.Identifier[] = [];
  const visit = (node: TS.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && node !== binding && node.text === binding.text) {
      if (valueIdentifier(ts, node) && lexicalBinding(ts, node) === binding) out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** A write to the binding or any object reached from it; alias escapes are checked by consumers. */
export function writtenThrough(ts: typeof TS, reference: TS.Identifier): boolean {
  let node: TS.Node = reference;
  while ((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) &&
         node.parent.expression === node) node = node.parent;
  const parent = node.parent;
  return (ts.isBinaryExpression(parent) && parent.left === node && isAssignment(ts, parent)) ||
    ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
     (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
    ts.isDeleteExpression(parent);
}

/** Potential declaration identity only; this does not prove an alias immutable. */
export function transparentReference(ts: typeof TS, expression: TS.Expression, target: TS.Identifier,
                                     seen = new Set<TS.Identifier>()): boolean | undefined {
  const value = unwrap(ts, expression);
  if (!ts.isIdentifier(value)) return false;
  const binding = lexicalBinding(ts, value);
  if (binding === undefined) return false;
  if (binding === target) return true;
  if (seen.has(binding) || seen.size >= 64) return undefined;
  const declaration = binding.parent;
  return ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
    ? transparentReference(ts, declaration.initializer, target, new Set(seen).add(binding)) : false;
}

/** Resolve immutable source string keys without evaluating expressions. */
export function literalString(project: WriteSource, expression: TS.Expression,
                              seen = new Set<TS.Identifier>(), depth = 0): string | undefined {
  const ts = project.ts;
  const value = unwrap(ts, expression);
  if (depth >= 64) return undefined;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalString(project, value.left, seen, depth + 1);
    const right = literalString(project, value.right, seen, depth + 1);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (!ts.isIdentifier(value)) return undefined;
  const binding = lexicalBinding(ts, value);
  if (binding === undefined || seen.has(binding)) return undefined;
  if (!ts.isVariableDeclaration(binding.parent) && !ts.isImportSpecifier(binding.parent) && !ts.isImportClause(binding.parent)) return undefined;
  const declaration = ts.isVariableDeclaration(binding.parent) ? binding.parent : sourceReference(project, value).node;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || declaration.initializer === undefined ||
      !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
  project.count(declaration.initializer);
  if (references(ts, declaration.getSourceFile(), declaration.name).some(reference => writtenThrough(ts, reference))) return undefined;
  return literalString(project, declaration.initializer, new Set(seen).add(binding), depth + 1);
}

/** All statically possible property keys; never choose a convenient branch. */
export function literalKeys(project: WriteSource, expression: TS.Expression,
                            seen = new Set<TS.Identifier>(), depth = 0): readonly string[] | undefined {
  if (depth >= 64) return undefined;
  const ts = project.ts;
  const value = unwrap(ts, expression);
  if (ts.isConditionalExpression(value)) {
    project.count(value);
    const yes = literalKeys(project, value.whenTrue, seen, depth + 1);
    const no = literalKeys(project, value.whenFalse, seen, depth + 1);
    if (yes === undefined || no === undefined) return undefined;
    const keys = [...new Set([...yes, ...no])].sort();
    return keys.length <= 64 ? keys : undefined;
  }
  if (ts.isIdentifier(value)) {
    const binding = lexicalBinding(ts, value);
    if (binding === undefined || seen.has(binding)) return undefined;
    if (!ts.isVariableDeclaration(binding.parent) && !ts.isImportSpecifier(binding.parent) && !ts.isImportClause(binding.parent)) return undefined;
    const declaration = ts.isVariableDeclaration(binding.parent) ? binding.parent : sourceReference(project, value).node;
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || declaration.initializer === undefined ||
        !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
    project.count(declaration.initializer);
    if (references(ts, declaration.getSourceFile(), declaration.name).some(reference => writtenThrough(ts, reference))) return undefined;
    return literalKeys(project, declaration.initializer, new Set(seen).add(binding), depth + 1);
  }
  if (ts.isNumericLiteral(value)) return [String(Number(value.text))];
  const key = literalString(project, value);
  return key === undefined ? undefined : [key];
}

const DYNAMIC_MEMBERS = new Set(['eval', 'Function', 'constructor', 'createRequire', 'getBuiltinModule',
  'runInThisContext', 'runInNewContext', 'compileFunction', '_zod', '_def', '~standard',
  'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'getOwnPropertySymbols',
  'getPrototypeOf', 'setPrototypeOf', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

function unknownComputedCallable(project: WriteSource, expression: TS.Expression, seen = new Set<TS.Node>()): boolean {
  const ts = project.ts;
  const value = unwrap(ts, expression);
  if (seen.has(value) || seen.size >= 64) return true;
  const next = new Set(seen).add(value);
  if (ts.isElementAccessExpression(value)) return literalKeys(project, value.argumentExpression) === undefined;
  if (ts.isIdentifier(value)) {
    const binding = lexicalBinding(ts, value);
    const declaration = binding?.parent;
    return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined &&
      unknownComputedCallable(project, declaration.initializer, next);
  }
  if (ts.isPropertyAccessExpression(value) && ['call', 'apply', 'bind'].includes(value.name.text))
    return unknownComputedCallable(project, value.expression, next);
  return false;
}

/** An import or top-level declaration may be resolved by the bounded module resolver. */
export function sourceReference(project: WriteSource, identifier: TS.Identifier): WriteDeclaration {
  const ts = project.ts;
  const binding = lexicalBinding(ts, identifier);
  if (binding === undefined) throw new WriteUnknown('WRITE_SOURCE_REFERENCE_UNKNOWN', identifier);
  const declaration = binding.parent;
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) ||
      ((ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) &&
       ts.isSourceFile(declaration.parent)) ||
      (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) &&
       ts.isVariableStatement(declaration.parent.parent) && ts.isSourceFile(declaration.parent.parent.parent)))
    return project.binding(identifier.getSourceFile(), identifier.text);
  throw new WriteUnknown('WRITE_SOURCE_REFERENCE_SHADOWED', identifier);
}

/** Dynamic code can change lexical bindings or source-inspected cache state. */
export function rejectDynamicCode(project: WriteSource, root: TS.Node): void {
  strictDynamicCode(project, root, node => permitsQueryDataCopy(project, node));
}

/** Only the complete certificate builder may propose these two exact data nodes. */
export function rejectDynamicCodeForQueryCopy(project: WriteSource, root: TS.Node,
  data: readonly [TS.ElementAccessExpression, TS.ElementAccessExpression]): void {
  strictDynamicCode(project, root, node => exactQueryCopyNode(data, node));
}

/** Object assignment patterns are expressions rather than BindingElement nodes. */
function assignmentPattern(ts: typeof TS, object: TS.ObjectLiteralExpression): boolean {
  let pattern: TS.Node = object;
  for (;;) {
    const parent = pattern.parent;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === pattern) return true;
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === pattern) return true;
    if ((ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) || ts.isNonNullExpression(parent)) && parent.expression === pattern) {
      pattern = parent;
    } else if (ts.isPropertyAssignment(parent) && parent.initializer === pattern && ts.isObjectLiteralExpression(parent.parent)) {
      pattern = parent.parent;
    } else if (ts.isArrayLiteralExpression(parent)) pattern = parent;
    else return false;
  }
}

function strictDynamicCode(project: WriteSource, root: TS.Node,
  dataNode?: (node: TS.ElementAccessExpression) => boolean): void {
  const ts = project.ts;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop() as TS.Node;
    if (ts.isTypeNode(node)) continue;
    // Numeric indices still alias actual parameters through the implicit
    // arguments object. Named-reference proofs cannot certify those effects.
    if (ts.isIdentifier(node) && node.text === 'arguments' && valueIdentifier(ts, node) && lexicalBinding(ts, node) === undefined)
      throw new WriteUnknown('WRITE_IMPLICIT_ARGUMENTS_ALIAS', node);
    const bindingKey = ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && node.dotDotDotToken === undefined ?
      node.propertyName ?? node.name : undefined;
    const assignmentKey = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isObjectLiteralExpression(node.parent) && assignmentPattern(ts, node.parent) ? node.name : undefined;
    const key = bindingKey ?? assignmentKey;
    if (key !== undefined) {
      // Destructuring can extract the same capabilities as member syntax.
      // Unknown computed keys cannot certify that those capabilities stayed put.
      const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
      if (name === undefined || DYNAMIC_MEMBERS.has(name) ||
          ['constructor', '__proto__', 'prototype', 'getPrototypeOf', 'setPrototypeOf', 'eval', 'Function',
           'createRequire', 'getBuiltinModule', 'runInThisContext', 'runInNewContext', 'compileFunction',
           'require', 'mainModule', 'binding', '_linkedBinding', 'dlopen'].includes(name))
        throw new WriteUnknown('WRITE_DYNAMIC_PROPERTY_EXTRACTION', node);
    }
    if ((ts.isIdentifier(node) && ['eval', 'Function', '__defineGetter__', '__defineSetter__',
          '__lookupGetter__', '__lookupSetter__'].includes(node.text)) ||
        (ts.isIdentifier(node) && node.text === 'Reflect' && lexicalBinding(ts, node) === undefined &&
          !ts.isTypeOfExpression(node.parent)) ||
        (ts.isPropertyAccessExpression(node) && DYNAMIC_MEMBERS.has(node.name.text)) ||
        (ts.isElementAccessExpression(node) && literalKeys(project, node.argumentExpression)?.some(key => DYNAMIC_MEMBERS.has(key))))
      throw new WriteUnknown('WRITE_DYNAMIC_CODE');
    // An unknown property value may itself be a callable or a prototype.
    // Checking only its immediate invocation misses aliases and object storage.
    if (ts.isElementAccessExpression(node) && literalKeys(project, node.argumentExpression) === undefined && !dataNode?.(node))
      throw new WriteUnknown('WRITE_COMPUTED_PROPERTY_UNKNOWN', node);
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && unknownComputedCallable(project, node.expression))
      throw new WriteUnknown('WRITE_COMPUTED_CALLABLE_UNKNOWN', node);
    ts.forEachChild(node, child => { pending.push(child); });
  }
}
