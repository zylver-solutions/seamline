// SPDX-License-Identifier: Apache-2.0
/** Closed data-copy syntax. This evidence alone grants no capability permission. */
import type * as TS from 'typescript';
import { unwrap, WriteUnknown, type WriteSource } from './write-source.ts';
import type { WriteParserShape } from './write-parser-shape.ts';
import { lexicalBinding, references } from './write-syntax.ts';

export interface QueryCopyShape {
  readonly initializer: TS.Expression;
  readonly queryDeclaration: TS.VariableDeclaration;
  readonly saved: TS.Identifier;
  readonly key: TS.Identifier;
  readonly regex: TS.RegularExpressionLiteral;
  readonly destination: TS.ElementAccessExpression;
  readonly source: TS.ElementAccessExpression;
}

const DIGIT_SUFFIX = new Set([String.raw`/\d+$/`, String.raw`/[0-9]+$/`]);

export function closedQueryCopyShape(project: WriteSource, shape: WriteParserShape): QueryCopyShape {
  const ts = project.ts;
  project.count(shape.fn);
  const fail = (): never => { throw new WriteUnknown('WRITE_QUERY_COPY_SHAPE_UNKNOWN', shape.fn); };
  const identifier = (value: TS.Expression, binding: TS.Identifier): TS.Identifier => {
    const node = unwrap(ts, value);
    if (!ts.isIdentifier(node) || lexicalBinding(ts, node) !== binding) return fail();
    return node;
  };
  const isConst = (declaration: TS.VariableDeclaration): boolean =>
    ts.isVariableDeclarationList(declaration.parent) &&
    declaration.parent.getFirstToken(shape.declaration.file)?.kind === ts.SyntaxKind.ConstKeyword;
  const queryDeclaration = shape.variables.get(shape.query.text);
  if (queryDeclaration?.name !== shape.query || queryDeclaration.initializer === undefined ||
      !ts.isIdentifier(shape.savedQuery.name) || shape.savedQuery.initializer === undefined || !isConst(shape.savedQuery)) return fail();
  const saved = shape.savedQuery.name;
  const savedInput = identifier(shape.savedQuery.initializer, shape.query);
  for (const binding of [shape.method, shape.parsed]) {
    if (!ts.isVariableDeclaration(binding.parent) || !isConst(binding.parent)) return fail();
  }
  if (!ts.isBlock(shape.getBranch.thenStatement) || shape.getBranch.thenStatement.statements.length !== 2) return fail();
  const [setQuery, loop] = shape.getBranch.thenStatement.statements;
  if (setQuery === undefined || !ts.isExpressionStatement(setQuery)) return fail();
  const assigned = unwrap(ts, setQuery.expression);
  if (!ts.isBinaryExpression(assigned) || assigned.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return fail();
  const queryAssignment = identifier(assigned.left, shape.query);
  const data = unwrap(ts, assigned.right);
  if (!ts.isPropertyAccessExpression(data) || data.questionDotToken !== undefined || data.name.text !== 'data') return fail();
  identifier(data.expression, shape.parsed);
  if (loop === undefined || !ts.isForOfStatement(loop) || loop.awaitModifier !== undefined ||
      !ts.isVariableDeclarationList(loop.initializer) || loop.initializer.declarations.length !== 1 ||
      loop.initializer.getFirstToken(shape.declaration.file)?.kind !== ts.SyntaxKind.ConstKeyword) return fail();
  const declaration = loop.initializer.declarations[0];
  if (declaration === undefined || !ts.isIdentifier(declaration.name) || declaration.initializer !== undefined) return fail();
  const key = declaration.name;
  const enumeration = unwrap(ts, loop.expression);
  if (!ts.isCallExpression(enumeration) || enumeration.arguments.length !== 1 || enumeration.questionDotToken !== undefined ||
      enumeration.typeArguments !== undefined || !ts.isPropertyAccessExpression(enumeration.expression) ||
      enumeration.expression.questionDotToken !== undefined || enumeration.expression.name.text !== 'keys' ||
      !ts.isIdentifier(enumeration.expression.expression) || enumeration.expression.expression.text !== 'Object' ||
      lexicalBinding(ts, enumeration.expression.expression) !== undefined) return fail();
  const enumerateSaved = identifier(enumeration.arguments[0] as TS.Expression, saved);
  if (!ts.isBlock(loop.statement) || loop.statement.statements.length !== 1) return fail();
  const guard = loop.statement.statements[0];
  if (guard === undefined || !ts.isIfStatement(guard) || guard.elseStatement !== undefined ||
      !ts.isBlock(guard.thenStatement) || guard.thenStatement.statements.length !== 1) return fail();
  const condition = unwrap(ts, guard.expression);
  if (!ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return fail();
  const digitTest = unwrap(ts, condition.left);
  if (!ts.isCallExpression(digitTest) || digitTest.arguments.length !== 1 || digitTest.questionDotToken !== undefined ||
      digitTest.typeArguments !== undefined || !ts.isPropertyAccessExpression(digitTest.expression) ||
      digitTest.expression.questionDotToken !== undefined || digitTest.expression.name.text !== 'test') return fail();
  const regex = unwrap(ts, digitTest.expression.expression);
  if (!ts.isRegularExpressionLiteral(regex) || !DIGIT_SUFFIX.has(regex.text)) return fail();
  const digitKey = identifier(digitTest.arguments[0] as TS.Expression, key);
  const absence = unwrap(ts, condition.right);
  if (!ts.isPrefixUnaryExpression(absence) || absence.operator !== ts.SyntaxKind.ExclamationToken) return fail();
  const membership = unwrap(ts, absence.operand);
  if (!ts.isBinaryExpression(membership) || membership.operatorToken.kind !== ts.SyntaxKind.InKeyword) return fail();
  const absenceKey = identifier(membership.left, key);
  const absenceQuery = identifier(membership.right, shape.query);
  const statement = guard.thenStatement.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement)) return fail();
  const copy = unwrap(ts, statement.expression);
  if (!ts.isBinaryExpression(copy) || copy.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return fail();
  const destination = unwrap(ts, copy.left);
  const source = unwrap(ts, copy.right);
  if (!ts.isElementAccessExpression(destination) || destination.questionDotToken !== undefined ||
      !ts.isElementAccessExpression(source) || source.questionDotToken !== undefined) return fail();
  const destinationQuery = identifier(destination.expression, shape.query);
  const sourceSaved = identifier(source.expression, saved);
  const destinationKey = identifier(destination.argumentExpression, key);
  const sourceKey = identifier(source.argumentExpression, key);
  const allowedKey = new Set([digitKey, absenceKey, destinationKey, sourceKey]);
  const allowedSaved = new Set([enumerateSaved, sourceSaved]);
  const queryInput = identifier(shape.input.whenTrue, shape.query);
  const allowedQuery = new Set([savedInput, queryInput, queryAssignment, absenceQuery, destinationQuery]);
  for (const property of shape.returnObject.properties) {
    const value = ts.isShorthandPropertyAssignment(property) ? property.name :
      ts.isPropertyAssignment(property) ? unwrap(ts, property.initializer) : undefined;
    if (value !== undefined && ts.isIdentifier(value) && lexicalBinding(ts, value) === shape.query) allowedQuery.add(value);
  }
  if (references(ts, shape.fn, key).some(reference => !allowedKey.has(reference)) ||
      references(ts, shape.fn, saved).some(reference => !allowedSaved.has(reference)) ||
      references(ts, shape.fn, shape.query).some(reference => !allowedQuery.has(reference))) return fail();
  return { initializer: queryDeclaration.initializer, queryDeclaration, saved, key, regex, destination, source };
}
