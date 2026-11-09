// SPDX-License-Identifier: Apache-2.0
/** Complete bounded parser-reference inventory; unresolved value uses withhold. */
import type * as TS from 'typescript';
import { nextQueryCopyCallerMethod } from './write-framework.ts';
import type { WriteParserShape } from './write-parser-shape.ts';
import { unwrap, WRITE_SOURCE_EXTENSIONS, WriteUnknown, type WriteSource } from './write-source.ts';
import { lexicalBinding, literalKeys, references, writtenThrough } from './write-syntax.ts';

export interface QueryCopyCaller {
  readonly call: TS.CallExpression;
  readonly fn: TS.FunctionDeclaration;
  readonly request: TS.Identifier;
  readonly requestUse: TS.Identifier;
  readonly method: string;
  readonly schema?: TS.VariableDeclaration;
  readonly executesCopy: boolean;
}

export function queryCopyCallers(project: WriteSource, parser: WriteParserShape): readonly QueryCopyCaller[] {
  const ts = project.ts;
  const fail = (node: TS.Node): never => { throw new WriteUnknown('WRITE_QUERY_CALLER_CLOSURE_UNKNOWN', node); };
  if (!project.inventoryComplete || parser.fn.parent !== parser.declaration.file || parser.fn.name === undefined ||
      !parser.fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      parser.fn.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return fail(parser.fn);
  const parserName = parser.fn.name;
  const root = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/i, '').toLowerCase().replace(/\/index$/, '');
  const target = root(project.path(project.root, parser.declaration.file.fileName));
  const workspaceNames = project.inventory.filter(path => /(?:^|\/)package\.json$/i.test(path))
    .map(path => project.json(path)['name']).filter((name): name is string => typeof name === 'string');
  const reachesParser = (file: TS.SourceFile, expression: TS.Expression | undefined): boolean => {
    if (expression === undefined || !ts.isStringLiteral(expression) ||
        /[\u0000-\u0020\u007f?#%\\]/.test(expression.text) || expression.text.startsWith('/') ||
        (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(expression.text) && !expression.text.startsWith('node:'))) return fail(expression ?? file);
    if (!project.mayReference(file, expression.text, [target])) return false;
    try { return root(project.importPath(file, expression.text)) === target; }
    catch (error) {
      if (!(error instanceof WriteUnknown)) throw error;
      if (error.message !== 'WRITE_ALIAS_UNKNOWN') throw error;
      project.assertExternalImport(file, expression.text);
      if (workspaceNames.some(name => expression.text === name || expression.text.startsWith(name + '/'))) throw error;
      return false;
    }
  };
  const erasedExport = (reference: TS.Identifier): boolean => {
    const item = reference.parent;
    return ts.isExportSpecifier(item) && (item.isTypeOnly || item.parent.parent.isTypeOnly);
  };
  const calls = new Set<TS.CallExpression>();
  const collect = (file: TS.SourceFile, binding: TS.Identifier): void => {
    for (const reference of references(ts, file, binding)) {
      if (erasedExport(reference)) continue;
      let value: TS.Expression = reference;
      while ((ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent) ||
          ts.isTypeAssertionExpression(value.parent) || ts.isSatisfiesExpression(value.parent) ||
          ts.isNonNullExpression(value.parent)) && value.parent.expression === value) value = value.parent;
      const call = value.parent;
      if (writtenThrough(ts, reference) || !ts.isCallExpression(call) || call.expression !== value ||
          call.questionDotToken !== undefined || call.typeArguments !== undefined) return fail(reference);
      calls.add(call);
    }
  };
  collect(parser.declaration.file, parserName);
  for (const path of project.inventory) {
    if (!(WRITE_SOURCE_EXTENSIONS as readonly string[]).some(extension => path.toLowerCase().endsWith(extension))) continue;
    const file = project.parse(path, false);
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        if (!reachesParser(file, statement.moduleSpecifier)) continue;
        if (clause === undefined || clause.name !== undefined || clause.namedBindings === undefined ||
            !ts.isNamedImports(clause.namedBindings)) return fail(statement);
        for (const item of clause.namedBindings.elements)
          if (!item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === parserName.text) collect(file, item.name);
      } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier !== undefined) {
        if (!reachesParser(file, statement.moduleSpecifier)) continue;
        if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause) ||
            statement.exportClause.elements.some(item => !item.isTypeOnly &&
              (item.propertyName?.text ?? item.name.text) === parserName.text)) return fail(statement);
      }
    }
    const loaders = (node: TS.Node): void => {
      if (ts.isTypeNode(node)) return;
      // This module's CommonJS namespace can reach the parser without a
      // lexical reference or import. Such value uses have no caller proof.
      if (file === parser.declaration.file && ts.isIdentifier(node) && ['module', 'exports'].includes(node.text) &&
          lexicalBinding(ts, node) === undefined &&
          !((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
            (ts.isPropertyAssignment(node.parent) && node.parent.name === node))) return fail(node);
      if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) return fail(node);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
          (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require') ||
          (ts.isElementAccessExpression(node.expression) && literalKeys(project, node.expression.argumentExpression)?.includes('require')))) {
        if (node.arguments.length !== 1 || reachesParser(file, node.arguments[0])) return fail(node);
      }
      ts.forEachChild(node, loaders);
    };
    loaders(file);
  }
  const callerFunction = (call: TS.CallExpression): TS.FunctionDeclaration => {
    let owner: TS.Node | undefined = call.parent;
    while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
    if (owner === undefined || !ts.isFunctionDeclaration(owner) || owner.body === undefined) return fail(call);
    return owner;
  };
  const result: QueryCopyCaller[] = [];
  for (const call of calls) {
    const fn = callerFunction(call);
    project.count(fn);
    if (call.arguments.length < 1 || call.arguments.length > 3 || fn.parameters.length < 1 ||
        fn.parameters[0]?.initializer !== undefined || fn.parameters[0]?.dotDotDotToken !== undefined ||
        !ts.isIdentifier(fn.parameters[0]?.name as TS.BindingName)) return fail(call);
    const request = (fn.parameters[0] as TS.ParameterDeclaration).name as TS.Identifier;
    const requestUse = unwrap(ts, call.arguments[0] as TS.Expression);
    if (!ts.isIdentifier(requestUse) || lexicalBinding(ts, requestUse) !== request) return fail(call);
    const method = nextQueryCopyCallerMethod(project, call.getSourceFile(), fn);
    const argument = call.arguments[1];
    const value = argument === undefined ? undefined : unwrap(ts, argument);
    const absent = value === undefined || (ts.isIdentifier(value) && value.text === 'undefined' && lexicalBinding(ts, value) === undefined) ||
      value.kind === ts.SyntaxKind.NullKeyword || value.kind === ts.SyntaxKind.FalseKeyword;
    let schema: TS.VariableDeclaration | undefined;
    if (method === 'GET' && !absent) {
      if (value === undefined || !ts.isIdentifier(value)) return fail(call);
      const binding = lexicalBinding(ts, value);
      if (binding === undefined || !ts.isVariableDeclaration(binding.parent)) return fail(value);
      schema = binding.parent;
    }
    const options = call.arguments[2] === undefined ? undefined : unwrap(ts, call.arguments[2]);
    if (options !== undefined) {
      if (!ts.isObjectLiteralExpression(options) || options.properties.length > 1) return fail(options);
      for (const property of options.properties)
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'skipAuth' ||
            ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(unwrap(ts, property.initializer).kind)) return fail(property);
    }
    result.push({ call, fn, request, requestUse, method, executesCopy: method === 'GET' && !absent,
      ...(schema === undefined ? {} : { schema }) });
  }
  if (!result.some(caller => caller.method !== 'GET')) return fail(parser.fn);
  for (const caller of result) {
    const allowed = new Set(result.filter(other => other.fn === caller.fn).map(other => other.requestUse));
    for (const reference of references(ts, caller.fn, caller.request)) {
      if (allowed.has(reference)) continue;
      const member = reference.parent;
      if (!writtenThrough(ts, reference) && ts.isPropertyAccessExpression(member) && member.expression === reference &&
          member.questionDotToken === undefined && ['url', 'method'].includes(member.name.text)) continue;
      return fail(reference);
    }
  }
  return result;
}
