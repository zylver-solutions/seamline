// SPDX-License-Identifier: Apache-2.0
/** Closed parser shape and protected-value flow, before capability validation. */
import type * as TS from 'typescript';
import { declaredName, unwrap, WriteSource, WriteUnknown, type WriteDeclaration } from './write-source.ts';
import { lexicalBinding, references, rejectDynamicCode, sourceReference, writtenThrough } from './write-syntax.ts';

export interface WriteParserSummary {
  readonly bodyKey: string;
  readonly errorKey: string;
  readonly functionName: string;
  readonly file: string;
}

/** Shared syntax evidence; it grants no computed-access permission by itself. */
export interface WriteParserShape extends WriteParserSummary {
  readonly declaration: WriteDeclaration;
  readonly fn: TS.FunctionDeclaration;
  readonly request: TS.Identifier;
  readonly schema: TS.Identifier;
  readonly query: TS.Identifier;
  readonly savedQuery: TS.VariableDeclaration;
  readonly parsed: TS.Identifier;
  readonly method: TS.Identifier;
  readonly getBranch: TS.IfStatement;
  readonly parseCall: TS.CallExpression;
  readonly input: TS.ConditionalExpression;
  readonly variables: ReadonlyMap<string, TS.VariableDeclaration>;
  readonly returnObject: TS.ObjectLiteralExpression;
}

function expression(ts: typeof TS, node: TS.Expression): TS.Expression {
  const value = unwrap(ts, node);
  return ts.isAwaitExpression(value) ? unwrap(ts, value.expression) : value;
}

function same(ts: typeof TS, node: TS.Expression | undefined, binding: TS.Identifier): boolean {
  return node !== undefined && ts.isIdentifier(unwrap(ts, node)) &&
    lexicalBinding(ts, unwrap(ts, node) as TS.Identifier) === binding;
}

function member(ts: typeof TS, node: TS.Expression | undefined, binding: TS.Identifier, name: string): boolean {
  if (node === undefined) return false;
  const value = unwrap(ts, node);
  return ts.isPropertyAccessExpression(value) && value.questionDotToken === undefined &&
    value.name.text === name && same(ts, value.expression, binding);
}

function statements(ts: typeof TS, node: TS.Statement): readonly TS.Statement[] {
  return ts.isBlock(node) ? node.statements : [node];
}

function assignment(ts: typeof TS, node: TS.Statement): TS.BinaryExpression | undefined {
  if (!ts.isExpressionStatement(node)) return undefined;
  const value = unwrap(ts, node.expression);
  return ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.EqualsToken ? value : undefined;
}

function callable(ts: typeof TS, value: TS.Expression): boolean {
  const unwrapped = unwrap(ts, value);
  return ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped);
}

function requestJson(project: WriteSource, initializer: TS.Expression, request: TS.Identifier): void {
  const ts = project.ts;
  const awaited = unwrap(ts, initializer);
  if (!ts.isAwaitExpression(awaited)) throw new WriteUnknown('WRITE_REQUEST_BODY_NOT_AWAITED');
  const call = unwrap(ts, awaited.expression);
  if (!ts.isCallExpression(call) || call.arguments.length !== 1 || !ts.isIdentifier(call.expression) ||
      !same(ts, call.arguments[0], request)) throw new WriteUnknown('WRITE_REQUEST_BODY_UNKNOWN');
  const bound = lexicalBinding(ts, call.expression);
  if (bound === undefined) throw new WriteUnknown('WRITE_REQUEST_BODY_UNKNOWN');
  const resolved = sourceReference(project, call.expression);
  const fn = resolved.node;
  if (!ts.isFunctionDeclaration(fn) || fn.body === undefined || fn.asteriskToken !== undefined ||
      !fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || fn.parameters.length !== 1 ||
      !ts.isIdentifier(fn.parameters[0]?.name as TS.BindingName) || fn.parameters[0]?.dotDotDotToken !== undefined ||
      fn.parameters[0]?.initializer !== undefined) throw new WriteUnknown('WRITE_REQUEST_BODY_UNKNOWN');
  project.count(fn);
  rejectDynamicCode(project, fn);
  if (fn.name !== undefined && references(ts, resolved.file, fn.name).some(reference => writtenThrough(ts, reference)))
    throw new WriteUnknown('WRITE_REQUEST_READER_REPLACED');
  const param = (fn.parameters[0] as TS.ParameterDeclaration).name as TS.Identifier;
  if (fn.body.statements.length !== 1 || !ts.isTryStatement(fn.body.statements[0] as TS.Statement))
    throw new WriteUnknown('WRITE_REQUEST_BODY_UNKNOWN');
  const attempt = fn.body.statements[0] as TS.TryStatement;
  if (attempt.finallyBlock !== undefined || attempt.tryBlock.statements.length !== 1 ||
      attempt.catchClause?.block.statements.length !== 1) throw new WriteUnknown('WRITE_REQUEST_BODY_UNKNOWN');
  const success = attempt.tryBlock.statements[0];
  const failure = attempt.catchClause.block.statements[0];
  if (success === undefined || !ts.isReturnStatement(success) || success.expression === undefined ||
      failure === undefined || !ts.isReturnStatement(failure) || failure.expression === undefined ||
      !ts.isIdentifier(failure.expression) || failure.expression.text !== 'undefined' ||
      lexicalBinding(ts, failure.expression) !== undefined) throw new WriteUnknown('WRITE_REQUEST_BODY_UNKNOWN');
  const json = expression(ts, success.expression);
  if (!ts.isCallExpression(json) || json.arguments.length !== 0 ||
      !ts.isPropertyAccessExpression(json.expression) || json.expression.name.text !== 'json')
    throw new WriteUnknown('WRITE_REQUEST_BODY_UNKNOWN');
  const clone = unwrap(ts, json.expression.expression);
  if (!ts.isCallExpression(clone) || clone.arguments.length !== 0 ||
      !member(ts, clone.expression, param, 'clone')) throw new WriteUnknown('WRITE_REQUEST_BODY_UNKNOWN');
  const allowed = new Set<TS.Identifier>([(clone.expression as TS.PropertyAccessExpression).expression as TS.Identifier]);
  if (references(ts, fn, param).some(reference => !allowed.has(reference)))
    throw new WriteUnknown('WRITE_REQUEST_BODY_UNKNOWN');
}

function singleIdentifierDeclaration(ts: typeof TS, statement: TS.Statement): TS.VariableDeclaration | undefined {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return undefined;
  const declaration = statement.declarationList.declarations[0];
  return declaration !== undefined && ts.isIdentifier(declaration.name) ? declaration : undefined;
}

function truthyErrorAssignment(ts: typeof TS, branch: TS.Statement, error: TS.Identifier): void {
  const items = statements(ts, branch);
  const set = items.length === 1 && items[0] !== undefined ? assignment(ts, items[0]) : undefined;
  if (set === undefined || !same(ts, set.left, error) || !callable(ts, set.right))
    throw new WriteUnknown('WRITE_PARSE_ERROR_NOT_TRUTHY');
}

export function parseWriteParserShape(project: WriteSource, declaration: WriteDeclaration): WriteParserShape {
  const ts = project.ts;
  const fn = declaration.node;
  if (!ts.isFunctionDeclaration(fn) || fn.body === undefined || fn.name === undefined || fn.asteriskToken !== undefined ||
      !fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      fn.parameters.length < 2 || fn.parameters.length > 3 ||
      fn.parameters.some(parameter => !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined))
    throw new WriteUnknown('WRITE_PARSER_SHAPE_UNKNOWN');
  project.count(fn);
  if (references(ts, declaration.file, fn.name).some(reference => writtenThrough(ts, reference)))
    throw new WriteUnknown('WRITE_PARSER_REPLACED');
  const request = (fn.parameters[0] as TS.ParameterDeclaration).name as TS.Identifier;
  const schema = (fn.parameters[1] as TS.ParameterDeclaration).name as TS.Identifier;
  const variables = new Map<string, TS.VariableDeclaration>();
  const branches: TS.IfStatement[] = [];
  let returned: TS.ReturnStatement | undefined;
  for (const statement of fn.body.statements) {
    const variable = singleIdentifierDeclaration(ts, statement);
    if (variable !== undefined && branches.length === 0 && returned === undefined) {
      const name = (variable.name as TS.Identifier).text;
      if (variables.has(name)) throw new WriteUnknown('WRITE_PARSER_SHAPE_UNKNOWN');
      variables.set(name, variable);
    } else if (ts.isIfStatement(statement) && returned === undefined) branches.push(statement);
    else if (ts.isReturnStatement(statement) && returned === undefined) returned = statement;
    else throw new WriteUnknown('WRITE_PARSER_SHAPE_UNKNOWN');
  }
  if (returned?.expression === undefined || branches.length < 1 || branches.length > 2)
    throw new WriteUnknown('WRITE_PARSER_SHAPE_UNKNOWN');
  const returnObject = unwrap(ts, returned.expression);
  if (!ts.isObjectLiteralExpression(returnObject)) throw new WriteUnknown('WRITE_PARSER_RETURN_UNKNOWN');
  const returnedBindings = new Map<string, TS.Identifier>();
  for (const property of returnObject.properties) {
    const key = declaredName(ts, property.name);
    const value = ts.isShorthandPropertyAssignment(property) ? property.name :
      ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) ? property.initializer : undefined;
    if (key === undefined || value === undefined || returnedBindings.has(key))
      throw new WriteUnknown('WRITE_PARSER_RETURN_UNKNOWN');
    const binding = lexicalBinding(ts, value);
    if (binding === undefined) throw new WriteUnknown('WRITE_PARSER_RETURN_UNKNOWN');
    returnedBindings.set(key, binding);
  }
  const parseBranch = branches[0] as TS.IfStatement;
  if (!same(ts, parseBranch.expression, schema) || parseBranch.elseStatement !== undefined ||
      !ts.isBlock(parseBranch.thenStatement)) throw new WriteUnknown('WRITE_PARSER_BRANCH_UNKNOWN');
  const parseStatements = parseBranch.thenStatement.statements;
  const definitions: TS.VariableDeclaration[] = [];
  let resultBranch: TS.IfStatement | undefined;
  for (const statement of parseStatements) {
    const variable = singleIdentifierDeclaration(ts, statement);
    if (variable !== undefined && resultBranch === undefined) {
      if (!(variable.parent.flags & ts.NodeFlags.Const)) throw new WriteUnknown('WRITE_PARSER_BRANCH_UNKNOWN');
      definitions.push(variable);
    } else if (ts.isIfStatement(statement) && resultBranch === undefined) resultBranch = statement;
    else throw new WriteUnknown('WRITE_PARSER_BRANCH_UNKNOWN');
  }
  if (definitions.length !== 3 || resultBranch === undefined) throw new WriteUnknown('WRITE_PARSER_BRANCH_UNKNOWN');
  const method = definitions[0] as TS.VariableDeclaration;
  const queryCopy = definitions[1] as TS.VariableDeclaration;
  const parsed = definitions[2] as TS.VariableDeclaration;
  const isGet = method.initializer === undefined ? undefined : unwrap(ts, method.initializer);
  if (isGet === undefined || !ts.isBinaryExpression(isGet) ||
      isGet.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
      !member(ts, isGet.left, request, 'method') || !ts.isStringLiteral(isGet.right) || isGet.right.text !== 'GET')
    throw new WriteUnknown('WRITE_PARSER_METHOD_UNKNOWN');
  const parse = parsed.initializer === undefined ? undefined : unwrap(ts, parsed.initializer);
  if (parse === undefined || !ts.isCallExpression(parse) || parse.arguments.length !== 1 ||
      !member(ts, parse.expression, schema, 'safeParse')) throw new WriteUnknown('WRITE_SAFE_PARSE_UNKNOWN');
  const input = unwrap(ts, parse.arguments[0] as TS.Expression);
  if (!ts.isConditionalExpression(input) || !same(ts, input.condition, method.name as TS.Identifier) ||
      !ts.isIdentifier(input.whenTrue) || !ts.isIdentifier(input.whenFalse))
    throw new WriteUnknown('WRITE_SAFE_PARSE_INPUT_UNKNOWN');
  const query = lexicalBinding(ts, input.whenTrue);
  const body = lexicalBinding(ts, input.whenFalse);
  if (query === undefined || body === undefined || !same(ts, queryCopy.initializer, query))
    throw new WriteUnknown('WRITE_SAFE_PARSE_INPUT_UNKNOWN');
  const test = unwrap(ts, resultBranch.expression);
  if (!ts.isPrefixUnaryExpression(test) || test.operator !== ts.SyntaxKind.ExclamationToken ||
      !member(ts, test.operand, parsed.name as TS.Identifier, 'success'))
    throw new WriteUnknown('WRITE_SAFE_PARSE_SUCCESS_UNKNOWN');
  const failed = statements(ts, resultBranch.thenStatement);
  const setError = failed.length === 1 && failed[0] !== undefined ? assignment(ts, failed[0]) : undefined;
  if (setError === undefined || !ts.isIdentifier(setError.left)) throw new WriteUnknown('WRITE_PARSE_ERROR_UNKNOWN');
  const error = lexicalBinding(ts, setError.left);
  if (error === undefined) throw new WriteUnknown('WRITE_PARSE_ERROR_UNKNOWN');
  truthyErrorAssignment(ts, resultBranch.thenStatement, error);
  const getBranch = resultBranch.elseStatement;
  if (getBranch === undefined || !ts.isIfStatement(getBranch) ||
      !same(ts, getBranch.expression, method.name as TS.Identifier) || getBranch.elseStatement === undefined)
    throw new WriteUnknown('WRITE_PARSE_NON_GET_UNKNOWN');
  const succeeded = statements(ts, getBranch.elseStatement);
  const setBody = succeeded.length === 1 && succeeded[0] !== undefined ? assignment(ts, succeeded[0]) : undefined;
  if (setBody === undefined || !same(ts, setBody.left, body) ||
      !member(ts, setBody.right, parsed.name as TS.Identifier, 'data'))
    throw new WriteUnknown('WRITE_PARSE_BODY_CHANGED');
  const bodyDeclaration = variables.get(body.text);
  const errorDeclaration = variables.get(error.text);
  if (bodyDeclaration?.name !== body || bodyDeclaration.initializer === undefined ||
      errorDeclaration?.name !== error || errorDeclaration.initializer !== undefined)
    throw new WriteUnknown('WRITE_PARSE_INITIAL_STATE_UNKNOWN');
  requestJson(project, bodyDeclaration.initializer, request);
  const bodyKeys = [...returnedBindings].filter(([, binding]) => binding === body).map(([key]) => key);
  const errorKeys = [...returnedBindings].filter(([, binding]) => binding === error).map(([key]) => key);
  if (bodyKeys.length !== 1 || errorKeys.length !== 1) throw new WriteUnknown('WRITE_PARSER_RETURN_UNKNOWN');

  // Every successful-path use of the protected values must be one of the
  // operations above. The proven GET branch is statically disjoint here.
  const allowedBody = new Set<TS.Identifier>([input.whenFalse, setBody.left as TS.Identifier]);
  for (const property of returnObject.properties) {
    if (ts.isShorthandPropertyAssignment(property) && lexicalBinding(ts, property.name) === body) allowedBody.add(property.name);
    else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) &&
             lexicalBinding(ts, property.initializer) === body) allowedBody.add(property.initializer);
  }
  if (references(ts, fn, body).some(reference => !allowedBody.has(reference)))
    throw new WriteUnknown('WRITE_PARSER_BODY_ESCAPES');
  const allowedSchema = new Set<TS.Identifier>([parseBranch.expression as TS.Identifier,
    (parse.expression as TS.PropertyAccessExpression).expression as TS.Identifier]);
  if (references(ts, fn, schema).some(reference => !allowedSchema.has(reference)))
    throw new WriteUnknown('WRITE_PARSER_SCHEMA_ESCAPES');

  // Authentication may add a callable error, but cannot clear an existing one
  // or return a different body. No arbitrary statement is silently skipped.
  const authBranch = branches[1];
  const authErrorWrites = new Set<TS.Identifier>();
  const authRequests = new Set<TS.Identifier>();
  if (authBranch !== undefined) {
    if (authBranch.elseStatement !== undefined) throw new WriteUnknown('WRITE_AUTH_BRANCH_UNKNOWN');
    const authCondition = unwrap(ts, authBranch.expression);
    if (!ts.isBinaryExpression(authCondition) || authCondition.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
      throw new WriteUnknown('WRITE_AUTH_BRANCH_UNKNOWN');
    const errorGuard = unwrap(ts, authCondition.right);
    const optionGuard = unwrap(ts, authCondition.left);
    const options = fn.parameters[2]?.name;
    if (!ts.isPrefixUnaryExpression(errorGuard) || errorGuard.operator !== ts.SyntaxKind.ExclamationToken ||
        !same(ts, errorGuard.operand, error) || !ts.isPrefixUnaryExpression(optionGuard) ||
        optionGuard.operator !== ts.SyntaxKind.ExclamationToken || options === undefined || !ts.isIdentifier(options) ||
        !ts.isPropertyAccessExpression(optionGuard.operand) || optionGuard.operand.name.text !== 'skipAuth' ||
        !same(ts, optionGuard.operand.expression, options)) throw new WriteUnknown('WRITE_AUTH_BRANCH_UNKNOWN');
    const authItems = statements(ts, authBranch.thenStatement);
    if (authItems.length !== 2 || authItems[0] === undefined || authItems[1] === undefined ||
        !ts.isIfStatement(authItems[1]) || authItems[1].elseStatement !== undefined)
      throw new WriteUnknown('WRITE_AUTH_BRANCH_UNKNOWN');
    const setAuth = assignment(ts, authItems[0]);
    if (setAuth === undefined || !ts.isIdentifier(setAuth.left)) throw new WriteUnknown('WRITE_AUTH_BRANCH_UNKNOWN');
    const auth = lexicalBinding(ts, setAuth.left);
    const authCall = expression(ts, setAuth.right);
    if (auth === undefined || !ts.isCallExpression(authCall) || authCall.arguments.length !== 1 ||
        !same(ts, authCall.arguments[0], request)) throw new WriteUnknown('WRITE_AUTH_BRANCH_UNKNOWN');
    authRequests.add(authCall.arguments[0] as TS.Identifier);
    const authTest = unwrap(ts, authItems[1].expression);
    if (!ts.isPrefixUnaryExpression(authTest) || authTest.operator !== ts.SyntaxKind.ExclamationToken ||
        !same(ts, authTest.operand, auth)) throw new WriteUnknown('WRITE_AUTH_BRANCH_UNKNOWN');
    truthyErrorAssignment(ts, authItems[1].thenStatement, error);
    const authError = assignment(ts, statements(ts, authItems[1].thenStatement)[0] as TS.Statement);
    authErrorWrites.add(authError?.left as TS.Identifier);
  }
  for (const reference of references(ts, fn, error)) {
    if (writtenThrough(ts, reference) && reference !== setError.left && !authErrorWrites.has(reference))
      throw new WriteUnknown('WRITE_PARSE_ERROR_CLEARED');
  }
  const rawBodyCall = expression(ts, bodyDeclaration.initializer);
  const allowedRequest = new Set<TS.Identifier>([
    ((isGet.left as TS.PropertyAccessExpression).expression as TS.Identifier),
    (rawBodyCall as TS.CallExpression).arguments[0] as TS.Identifier,
    ...authRequests,
  ]);
  for (const reference of references(ts, fn, request)) {
    const parent = reference.parent;
    if (allowedRequest.has(reference)) continue;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === reference &&
        parent.name.text === 'url' && !writtenThrough(ts, reference)) continue;
    throw new WriteUnknown('WRITE_PARSER_REQUEST_ESCAPES');
  }
  // All initializers except the raw-body reader must be unable to reach the
  // protected schema/body/error. Unknown calls are not transparent helpers.
  for (const variable of variables.values()) {
    if (variable === bodyDeclaration || variable.initializer === undefined) continue;
    if (references(ts, variable.initializer, body).length > 0 ||
        references(ts, variable.initializer, schema).length > 0 ||
        references(ts, variable.initializer, error).length > 0)
      throw new WriteUnknown('WRITE_PARSER_INITIALIZER_ESCAPES');
  }
  return { bodyKey: bodyKeys[0] as string, errorKey: errorKeys[0] as string,
    functionName: fn.name.text, file: declaration.file.fileName,
    declaration, fn, request, schema, query, savedQuery: queryCopy,
    parsed: parsed.name as TS.Identifier, method: method.name as TS.Identifier,
    getBranch, parseCall: parse, input, variables, returnObject };

}
