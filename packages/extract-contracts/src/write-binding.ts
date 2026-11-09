// SPDX-License-Identifier: Apache-2.0
/** Local request schema -> successful parse -> unchanged literal write fields. */
import type * as TS from 'typescript';
import { nextWriteMethod, possibleWriteMethod } from './write-framework.ts';
import { writeContractName } from './write-identity.ts';
import { writeStringLength, type LengthState } from './write-length.ts';
import { lockedVersion } from './write-libraries.ts';
import { summarizeWriteParser } from './write-parser.ts';
import { summarizeWritePersistence, type WritePersistence } from './write-persistence.ts';
import { type WriteModel } from './write-prisma.ts';
import { declaredName, unwrap, WriteSource, WriteUnknown } from './write-source.ts';
import { isLibraryBinding, lexicalBinding, references, rejectDynamicCode, sourceReference, transparentReference, writtenThrough } from './write-syntax.ts';

export interface WriteFieldProof {
  readonly name: string;
  readonly length: LengthState;
  readonly required: boolean | null;
  readonly nullable: boolean | null;
  readonly storageField?: string;
  readonly modelField?: string;
  readonly complete: boolean;
}

export interface LocalWriteProof {
  /** An internal collision reservation until `admitted` is true. */
  readonly name: string;
  readonly admitted: boolean;
  /** All parsed-value output uses are accounted for by the single proved write. */
  readonly identityComplete: boolean;
  readonly fields: readonly WriteFieldProof[];
  readonly persistence: WritePersistence;
  readonly file: string;
  readonly parser: { readonly file: string; readonly functionName: string };
  readonly method: string;
}

function zodBinding(project: WriteSource, identifier: TS.Identifier): boolean {
  const ts = project.ts;
  if (['zod', 'zod/v4'].some(source => isLibraryBinding(project, identifier, source, 'z'))) {
    if (lockedVersion(project, identifier.getSourceFile(), 'zod') !== '4.3.6')
      throw new WriteUnknown('WRITE_REVIEWED_ARTIFACT_MISMATCH', identifier);
    return true;
  }
  const binding = lexicalBinding(ts, identifier);
  if (binding === undefined || !ts.isNamespaceImport(binding.parent)) return false;
  const clause = binding.parent.parent;
  const declaration = clause.parent;
  const known = !clause.isTypeOnly && ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier) &&
    ['zod', 'zod/v4'].includes(declaration.moduleSpecifier.text);
  if (known && lockedVersion(project, identifier.getSourceFile(), 'zod') !== '4.3.6')
    throw new WriteUnknown('WRITE_REVIEWED_ARTIFACT_MISMATCH', identifier);
  return known;
}

function rootFields(project: WriteSource, declaration: TS.VariableDeclaration): Map<string, Omit<WriteFieldProof, 'complete'>> {
  const ts = project.ts;
  if (declaration.initializer === undefined) throw new WriteUnknown('WRITE_SCHEMA_UNKNOWN');
  const root = unwrap(ts, declaration.initializer);
  if (!ts.isCallExpression(root) || root.arguments.length !== 1 || root.typeArguments !== undefined ||
      root.questionDotToken !== undefined || !ts.isPropertyAccessExpression(root.expression) ||
      root.expression.questionDotToken !== undefined || root.expression.name.text !== 'object' ||
      !ts.isIdentifier(root.expression.expression) || !zodBinding(project, root.expression.expression))
    throw new WriteUnknown('WRITE_SCHEMA_ROOT_UNKNOWN');
  const shape = unwrap(ts, root.arguments[0] as TS.Expression);
  if (!ts.isObjectLiteralExpression(shape)) throw new WriteUnknown('WRITE_SCHEMA_SHAPE_UNKNOWN');
  const checked = new Set<TS.Identifier>();
  const verifyNamespace = (identifier: TS.Identifier): void => {
    const namespace = lexicalBinding(ts, identifier) as TS.Identifier;
    if (checked.has(namespace)) return;
    checked.add(namespace);
    for (const reference of references(ts, declaration.getSourceFile(), namespace)) {
      if (writtenThrough(ts, reference) || !ts.isPropertyAccessExpression(reference.parent) ||
          reference.parent.expression !== reference) throw new WriteUnknown('WRITE_ZOD_NAMESPACE_ESCAPES');
    }
  };
  verifyNamespace(root.expression.expression);
  const fields = new Map<string, Omit<WriteFieldProof, 'complete'>>();
  for (const property of shape.properties) {
    const name = declaredName(ts, property.name);
    if (!ts.isPropertyAssignment(property) || name === undefined || name === '__proto__' || fields.has(name))
      throw new WriteUnknown('WRITE_SCHEMA_SHAPE_UNKNOWN');
    let value = unwrap(ts, property.initializer);
    const bindings = new Set<string>();
    let required = true;
    let nullable = false;
    for (let depth = 0; depth < project.limits.maxSchemaDepth; depth++) {
      if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) break;
      const access = value.expression;
      if (ts.isIdentifier(access.expression)) {
        if (zodBinding(project, access.expression)) { verifyNamespace(access.expression); bindings.add(access.expression.text); }
        break;
      }
      if (access.name.text === 'optional' || access.name.text === 'nullish') required = false;
      if (access.name.text === 'nullable' || access.name.text === 'nullish') nullable = true;
      value = unwrap(ts, access.expression);
    }
    const length = writeStringLength(ts, property.initializer, bindings, project.limits.maxSchemaDepth);
    fields.set(name, { name, length, required: length.state === 'unknown' ? null : required,
      nullable: length.state === 'unknown' ? null : nullable });
  }
  return fields;
}

/** Names alone reserve a conflict; this path never supplies field proof. */
function reservationFields(project: WriteSource, declaration: TS.VariableDeclaration): Map<string, Omit<WriteFieldProof, 'complete'>> {
  const ts = project.ts;
  let cursor = declaration.initializer;
  for (let depth = 0; cursor !== undefined && depth < project.limits.maxSchemaDepth; depth++) {
    const value = unwrap(ts, cursor);
    if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) break;
    const shape = value.arguments[0];
    if (['object', 'strictObject', 'looseObject'].includes(value.expression.name.text) && shape !== undefined && ts.isObjectLiteralExpression(shape)) {
      const fields = new Map<string, Omit<WriteFieldProof, 'complete'>>();
      for (const property of shape.properties) {
        const name = declaredName(ts, property.name);
        if (!ts.isPropertyAssignment(property) || name === undefined || fields.has(name)) throw new WriteUnknown('WRITE_RESERVATION_SHAPE_UNKNOWN');
        fields.set(name, { name, length: { state: 'unknown' }, required: null, nullable: null });
      }
      return fields;
    }
    cursor = value.expression.expression;
  }
  // An opaque shape supplies no scalar facts. Its caller can still name the
  // fields it forwards, so an otherwise proved relationship reserves a conflict.
  const names = new Set<string>();
  const fn = declaration.parent.parent.parent;
  const visit = (node: TS.Node): void => {
    if (ts.isPropertyAccessExpression(node)) names.add(node.name.text);
    if (ts.isBindingElement(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = declaredName(ts, node.name);
      if (name !== undefined) names.add(name);
      if (ts.isBindingElement(node) && node.propertyName !== undefined) {
        const key = declaredName(ts, node.propertyName);
        if (key !== undefined) names.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return new Map([...names].map(name => [name, { name, length: {state: 'unknown'} as const, required: null, nullable: null }]));
}

interface Origin { readonly field: string; readonly node: TS.Expression }

function booleanLiteral(ts: typeof TS, expression: TS.Expression, visiting = new Set<TS.Identifier>()): boolean | undefined {
  if (visiting.size >= 64) return undefined;
  const value = unwrap(ts, expression);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword || value.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text.length !== 0;
  if (ts.isNumericLiteral(value)) return Number(value.text) !== 0;
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = booleanLiteral(ts, value.operand, visiting);
    return operand === undefined ? undefined : !operand;
  }
  if (ts.isIdentifier(value) && ['undefined', 'NaN'].includes(value.text) && lexicalBinding(ts, value) === undefined) return false;
  if (ts.isIdentifier(value)) {
    const binding = lexicalBinding(ts, value);
    if (binding !== undefined && !visiting.has(binding) && ts.isVariableDeclaration(binding.parent) &&
        (binding.parent.parent.flags & ts.NodeFlags.Const) && binding.parent.initializer !== undefined)
      return booleanLiteral(ts, binding.parent.initializer, new Set(visiting).add(binding));
  }
  return undefined;
}

function nullishLiteral(ts: typeof TS, expression: TS.Expression, visiting = new Set<TS.Identifier>()): boolean | undefined {
  if (visiting.size >= 64) return undefined;
  const value = unwrap(ts, expression);
  if (value.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(value)) {
    const binding = lexicalBinding(ts, value);
    if (value.text === 'undefined' && binding === undefined) return true;
    if (binding !== undefined && !visiting.has(binding) && ts.isVariableDeclaration(binding.parent) &&
        (binding.parent.parent.flags & ts.NodeFlags.Const) && binding.parent.initializer !== undefined)
      return nullishLiteral(ts, binding.parent.initializer, new Set(visiting).add(binding));
  }
  if (booleanLiteral(ts, value) !== undefined || ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) return false;
  return undefined;
}

function directAwaitOrReturn(ts: typeof TS, expression: TS.Expression): boolean {
  let node: TS.Node = expression;
  while (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) ||
         ts.isSatisfiesExpression(node.parent) || ts.isNonNullExpression(node.parent)) node = node.parent;
  return (ts.isAwaitExpression(node.parent) && node.parent.expression === node) ||
    (ts.isReturnStatement(node.parent) && node.parent.expression === node);
}

export function proveLocalWrite(
  project: WriteSource,
  file: TS.SourceFile,
  fn: TS.FunctionDeclaration,
  schema: TS.VariableDeclaration,
  models: readonly WriteModel[],
  reservationOnly = false,
): LocalWriteProof {
  const ts = project.ts;
  const parameter = fn.parameters[0];
  const request = parameter !== undefined && ts.isIdentifier(parameter.name) ? parameter.name : undefined;
  if (fn.name === undefined || fn.body === undefined || !ts.isIdentifier(schema.name) ||
      !ts.isVariableDeclarationList(schema.parent) || (!reservationOnly && !(schema.parent.flags & ts.NodeFlags.Const)) ||
      !ts.isVariableStatement(schema.parent.parent) || schema.parent.parent.parent !== fn.body ||
      (!reservationOnly && (parameter === undefined || request === undefined || parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined || !fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))))
    throw new WriteUnknown('WRITE_LOCAL_DECLARATION_UNKNOWN');
  project.count(fn);
  rejectDynamicCode(project, fn);
  const method = reservationOnly ? possibleWriteMethod(project, file, fn) : nextWriteMethod(project, file, fn);
  const fields = reservationOnly ? reservationFields(project, schema) : rootFields(project, schema);
  const mentionsSchema = (node: TS.Node): boolean => {
    if (ts.isTypeNode(node)) return false;
    if (ts.isIdentifier(node)) {
      const binding = lexicalBinding(ts, node);
      if (binding !== undefined && references(ts, node, binding).length > 0 &&
          transparentReference(ts, node, schema.name as TS.Identifier) === true) return true;
    }
    return ts.forEachChild(node, child => mentionsSchema(child) ? true : undefined) ?? false;
  };
  const parserCalls: Array<{ declaration: TS.VariableDeclaration; call: TS.CallExpression }> = [];
  for (const statement of fn.body.statements) {
    if (!ts.isVariableStatement(statement) || (!reservationOnly && !(statement.declarationList.flags & ts.NodeFlags.Const))) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isObjectBindingPattern(declaration.name) || declaration.initializer === undefined) continue;
      let value = unwrap(ts, declaration.initializer);
      if (ts.isAwaitExpression(value)) value = unwrap(ts, value.expression);
      else if (!reservationOnly) continue;
      if (!ts.isCallExpression(value) || (reservationOnly ? value.arguments.length < 2 : value.arguments.length !== 2) || value.questionDotToken !== undefined ||
          (!reservationOnly && !ts.isIdentifier(value.expression))) continue;
      const requestArgument = reservationOnly ? unwrap(ts, value.arguments[0] as TS.Expression) : value.arguments[0];
      const schemaArgument = reservationOnly ? unwrap(ts, value.arguments[1] as TS.Expression) : value.arguments[1];
      if (requestArgument === undefined || schemaArgument === undefined ||
          (!reservationOnly && (!ts.isIdentifier(requestArgument) || lexicalBinding(ts, requestArgument) !== request)) ||
          (reservationOnly ? !mentionsSchema(schemaArgument) :
            !ts.isIdentifier(schemaArgument) || lexicalBinding(ts, schemaArgument) !== schema.name)) continue;
      parserCalls.push({ declaration, call: value });
    }
  }
  if (parserCalls.length !== 1) throw new WriteUnknown('WRITE_LOCAL_PARSER_AMBIGUOUS');
  const parsed = parserCalls[0] as (typeof parserCalls)[number];
  if (!reservationOnly && references(ts, fn, schema.name).some(reference => reference !== parsed.call.arguments[1]))
    throw new WriteUnknown('WRITE_LOCAL_SCHEMA_ESCAPES');
  // Collision reservations identify possible declared keys only. An opaque
  // parser must not erase that possibility, and supplies no parse/field credit.
  const parser = reservationOnly ? undefined : summarizeWriteParser(project, sourceReference(project, parsed.call.expression as TS.Identifier));
  const output = new Map<string, TS.Identifier>();
  for (const element of (parsed.declaration.name as TS.ObjectBindingPattern).elements) {
    const name = declaredName(ts, element.propertyName ?? element.name);
    if (name === undefined || !ts.isIdentifier(element.name) || element.initializer !== undefined ||
        element.dotDotDotToken !== undefined || output.has(name)) throw new WriteUnknown('WRITE_PARSE_DESTRUCTURE_UNKNOWN');
    output.set(name, element.name);
  }
  const body = parser === undefined ? undefined : output.get(parser.bodyKey);
  const error = parser === undefined ? undefined : output.get(parser.errorKey);
  const bodies = reservationOnly ? [...output.values()] : body === undefined ? [] : [body];
  if (bodies.length === 0 || (!reservationOnly && error === undefined)) throw new WriteUnknown('WRITE_PARSE_DESTRUCTURE_UNKNOWN');
  const at = fn.body.statements.indexOf(parsed.declaration.parent.parent as TS.VariableStatement);
  const schemaAt = fn.body.statements.indexOf(schema.parent.parent as TS.VariableStatement);
  if (at < 0 || schemaAt < 0 || schemaAt >= at || (!reservationOnly && fn.body.statements.slice(0, at).some(statement =>
    !ts.isVariableStatement(statement) && !ts.isFunctionDeclaration(statement) &&
    !ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement))))
    throw new WriteUnknown('WRITE_PARSE_PREFIX_UNKNOWN');
  for (const reference of reservationOnly || request === undefined ? [] : references(ts, fn, request)) {
    if (reference.getStart(file) >= parsed.declaration.getStart(file)) continue;
    const parent = reference.parent;
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== reference ||
        !['url', 'method'].includes(parent.name.text) || writtenThrough(ts, reference))
      throw new WriteUnknown('WRITE_PARSE_REQUEST_CHANGED');
  }
  const guard = fn.body.statements[at + 1];
  if (!reservationOnly) {
    if (guard === undefined || !ts.isIfStatement(guard) || guard.elseStatement !== undefined ||
        !ts.isIdentifier(unwrap(ts, guard.expression)) || lexicalBinding(ts, unwrap(ts, guard.expression) as TS.Identifier) !== error)
      throw new WriteUnknown('WRITE_PARSE_ERROR_NOT_GUARDED');
    const guardItems = ts.isBlock(guard.thenStatement) ? guard.thenStatement.statements : [guard.thenStatement];
    if (guardItems.length !== 1 || guardItems[0] === undefined || !ts.isReturnStatement(guardItems[0]))
      throw new WriteUnknown('WRITE_PARSE_ERROR_NOT_GUARDED');
  }
  const objects = new Set<TS.Identifier>(bodies);
  const scalars = new Map<TS.Identifier, string>();
  const allowedObjects = new Set<TS.Identifier>();
  const allowedScalars = new Set<TS.Expression>();
  const ignored = new Set<TS.Node>();
  const unsafe = new Set<string>();
  const persistenceRefusals = new Set<string>();
  const writes: Array<{ persistence: WritePersistence; fields: Map<string, Set<string>> }> = [];
  const origin = (expression: TS.Expression): Origin | undefined => {
    const value = unwrap(ts, expression);
    if (ts.isIdentifier(value)) {
      const binding = lexicalBinding(ts, value);
      const field = binding === undefined ? undefined : scalars.get(binding);
      return field === undefined ? undefined : { field, node: value };
    }
    if (ts.isPropertyAccessExpression(value) && value.questionDotToken === undefined && ts.isIdentifier(value.expression)) {
      const binding = lexicalBinding(ts, value.expression);
      return binding !== undefined && objects.has(binding) && fields.has(value.name.text)
        ? { field: value.name.text, node: value } : undefined;
    }
    return undefined;
  };
  const isObject = (expression: TS.Expression): expression is TS.Identifier => {
    const value = unwrap(ts, expression);
    const binding = ts.isIdentifier(value) ? lexicalBinding(ts, value) : undefined;
    return binding !== undefined && objects.has(binding);
  };
  const isIgnored = (node: TS.Node): boolean => {
    for (let cursor: TS.Node | undefined = node; cursor !== undefined && cursor !== fn; cursor = cursor.parent)
      if (ignored.has(cursor)) return true;
    return false;
  };
  const visitExpression = (node: TS.Node, admitWrites: boolean): void => {
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isTypeNode(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && lexicalBinding(ts, node.expression) === fn.name)
      throw new WriteUnknown('WRITE_CALLER_RECURSION', node);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      visitExpression(node.left, admitWrites);
      const condition = booleanLiteral(ts, node.left);
      if ((condition === false && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) ||
          (condition === true && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) ||
          (nullishLiteral(ts, node.left) === false && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) ignored.add(node.right);
      else visitExpression(node.right, admitWrites);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visitExpression(node.condition, admitWrites);
      const condition = booleanLiteral(ts, node.condition);
      if (condition !== false) visitExpression(node.whenTrue, admitWrites); else ignored.add(node.whenTrue);
      if (condition !== true) visitExpression(node.whenFalse, admitWrites); else ignored.add(node.whenFalse);
      return;
    }
    if (admitWrites && ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.questionDotToken === undefined && node.typeArguments === undefined && directAwaitOrReturn(ts, node)) {
      const literalArguments = node.arguments.filter(argument => ts.isObjectLiteralExpression(unwrap(ts, argument)) &&
        (unwrap(ts, argument) as TS.ObjectLiteralExpression).properties.some(property => {
          const value = ts.isShorthandPropertyAssignment(property) ? property.name : ts.isPropertyAssignment(property) ? property.initializer : undefined;
          return value !== undefined && origin(value) !== undefined;
        }));
      if (literalArguments.length > 0) {
        let persistence: WritePersistence | undefined;
        try { persistence = summarizeWritePersistence(project, sourceReference(project, node.expression), models, reservationOnly); }
        catch (failure) {
          if (!(failure instanceof WriteUnknown)) throw failure;
          project.assertBudget();
          persistenceRefusals.add(failure.message);
        }
        if (persistence !== undefined) {
          const argument = node.arguments[persistence.parameterIndex];
          const data = argument === undefined ? undefined : unwrap(ts, argument);
          if (data !== undefined && ts.isObjectLiteralExpression(data) && data.properties.every(property =>
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && declaredName(ts, property.name) !== undefined)) {
            const targetCounts = new Map<string, number>();
            for (const property of data.properties) {
              const key = declaredName(ts, property.name) as string;
              targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
            }
            const forwarded = new Map<string, Set<string>>();
            for (const property of data.properties) {
              const key = declaredName(ts, property.name) as string;
              const value = ts.isShorthandPropertyAssignment(property) ? property.name :
                (property as TS.PropertyAssignment).initializer;
              const from = origin(value);
              if (from === undefined || !persistence.model.fields.has(key) || targetCounts.get(key) !== 1) continue;
              const targets = forwarded.get(from.field) ?? new Set<string>();
              targets.add(key);
              forwarded.set(from.field, targets);
              allowedScalars.add(from.node);
            }
            writes.push({ persistence, fields: forwarded });
          }
        }
      }
    }
    ts.forEachChild(node, child => { visitExpression(child, admitWrites); });
  };
  const visitVariable = (statement: TS.VariableStatement, admitWrites: boolean): void => {
    const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer === undefined) continue;
      const value = unwrap(ts, declaration.initializer);
      if (ts.isIdentifier(declaration.name)) {
        const from = origin(value);
        if (from !== undefined) {
          if (!constant) unsafe.add(from.field);
          else { scalars.set(declaration.name, from.field); allowedScalars.add(from.node); }
        } else if (isObject(value)) {
          if (!constant) for (const field of fields.keys()) unsafe.add(field);
          else { objects.add(declaration.name); allowedObjects.add(value); }
        }
      } else if (ts.isObjectBindingPattern(declaration.name) && isObject(value)) {
        allowedObjects.add(value);
        for (const element of declaration.name.elements) {
          const key = declaredName(ts, element.propertyName ?? element.name);
          if (element.dotDotDotToken !== undefined || key === undefined) {
            for (const field of fields.keys()) unsafe.add(field);
          } else if (fields.has(key)) {
            if (!constant || element.initializer !== undefined || !ts.isIdentifier(element.name)) unsafe.add(key);
            else scalars.set(element.name, key);
          }
        }
      }
      visitExpression(declaration.initializer, admitWrites);
    }
  };
  const walk = (items: readonly TS.Statement[], admitWrites: boolean): boolean => {
    let continuing = true;
    for (const statement of items) {
      if (!continuing) { ignored.add(statement); continue; }
      if (ts.isVariableStatement(statement)) visitVariable(statement, admitWrites);
      else if (ts.isExpressionStatement(statement)) visitExpression(statement.expression, admitWrites);
      else if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
        if (statement.expression !== undefined) visitExpression(statement.expression, admitWrites);
        continuing = false;
      } else if (ts.isBlock(statement)) continuing = walk(statement.statements, admitWrites);
      else if (ts.isIfStatement(statement)) {
        visitExpression(statement.expression, admitWrites);
        const condition = booleanLiteral(ts, statement.expression);
        const thenItems = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
        let thenContinues = true;
        let elseContinues = true;
        if (condition !== false) thenContinues = walk(thenItems, admitWrites); else ignored.add(statement.thenStatement);
        if (statement.elseStatement !== undefined) {
          const otherwise = statement.elseStatement;
          if (condition !== true) elseContinues = walk(ts.isBlock(otherwise) ? otherwise.statements : [otherwise], admitWrites);
          else ignored.add(otherwise);
        }
        continuing = condition === true ? thenContinues : condition === false ? elseContinues : thenContinues || elseContinues;
      } else if (ts.isTryStatement(statement)) {
        const tried = walk(statement.tryBlock.statements, admitWrites);
        const caught = statement.catchClause === undefined ? false : walk(statement.catchClause.block.statements, false);
        const finalized = statement.finallyBlock === undefined || walk(statement.finallyBlock.statements, false);
        continuing = (tried || caught) && finalized;
      } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEmptyStatement(statement)) {
        // Captures are still checked below; no nested helper gains a third boundary.
      } else throw new WriteUnknown('WRITE_CALLER_CONTROL_UNKNOWN', statement);
    }
    return continuing;
  };
  // A names-only reservation supplies no parse or field credit. Inspect all
  // statements after the candidate parse rather than assuming a valid guard.
  walk(fn.body.statements.slice(at + (reservationOnly ? 1 : 2)), true);
  for (const binding of objects) {
    for (const reference of references(ts, fn, binding)) {
      if (isIgnored(reference) || allowedObjects.has(reference)) continue;
      const parent = reference.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === reference) {
        let member: TS.Node = parent;
        while ((ts.isParenthesizedExpression(member.parent) || ts.isAsExpression(member.parent) ||
                ts.isTypeAssertionExpression(member.parent) || ts.isNonNullExpression(member.parent) ||
                ts.isSatisfiesExpression(member.parent)) && unwrap(ts, member.parent) === parent) member = member.parent;
        if ((ts.isCallExpression(member.parent) && member.parent.expression === member) ||
            (ts.isTaggedTemplateExpression(member.parent) && member.parent.tag === member)) {
          // Calling a member passes the containing object as its receiver.
          for (const field of fields.keys()) unsafe.add(field);
          continue;
        }
      }
      if (ts.isPropertyAccessExpression(parent) && parent.expression === reference && fields.has(parent.name.text)) {
        if (!allowedScalars.has(parent)) unsafe.add(parent.name.text);
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === reference && !writtenThrough(ts, reference)) {
        // A different declared property does not access a protected primitive.
        if (!fields.has(parent.name.text)) continue;
      } else for (const field of fields.keys()) unsafe.add(field);
    }
  }
  for (const [binding, field] of scalars) {
    if (references(ts, fn, binding).some(reference => !isIgnored(reference) && !allowedScalars.has(reference))) unsafe.add(field);
  }
  project.assertBudget();
  if (writes.length === 0 && persistenceRefusals.size > 0)
    throw new WriteUnknown(`WRITE_LOCAL_PERSISTENCE_UNPROVED: ${[...persistenceRefusals].sort().join('; ')}`);
  if (writes.length !== 1) throw new WriteUnknown('WRITE_LOCAL_PERSISTENCE_AMBIGUOUS');
  const write = writes[0] as (typeof writes)[number];
  const result: WriteFieldProof[] = [...fields.values()].map(field => {
    const targets = write.fields.get(field.name);
    const modelField = targets?.size === 1 ? [...targets][0] : undefined;
    const storageField = modelField === undefined ? undefined : write.persistence.model.fields.get(modelField);
    const complete = field.length.state !== 'unknown' && !unsafe.has(field.name) && storageField !== undefined;
    return { ...field, ...(complete ? { storageField: storageField as string, modelField: modelField as string } : {}), complete };
  });
  project.assertBudget();
  const name = writeContractName([project.owner(file).name, [fn.name.text, schema.name.text],
    [write.persistence.owningPackage, write.persistence.lexicalChain], write.persistence.model.model]);
  return { name, admitted: !reservationOnly && result.some(field => field.complete),
    identityComplete: !reservationOnly && unsafe.size === 0 && persistenceRefusals.size === 0,
    fields: result, persistence: write.persistence,
    file: file.fileName, parser: parser === undefined
      ? {file: file.fileName, functionName: ts.isIdentifier(parsed.call.expression) ? parsed.call.expression.text : ''}
      : { file: parser.file, functionName: parser.functionName }, method };
}
