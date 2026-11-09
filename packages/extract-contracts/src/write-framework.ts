// SPDX-License-Identifier: Apache-2.0
/** The source-declared Next method witness admitted by the X7 design. */
import type * as TS from 'typescript';
import { relative } from 'node:path';
import { lockedVersion } from './write-libraries.ts';
import { assertWriteImportEffects } from './write-import-effects.ts';
import { metadataLoads } from './write-metadata-loads.ts';
import { assertNativeCapabilitySummary, assertProcessCapabilitySummary } from './write-native-capabilities.ts';
import { declaredName, unwrap, WRITE_SOURCE_EXTENSIONS, WriteSource, WriteUnknown } from './write-source.ts';
import { isLibraryBinding, lexicalBinding, literalKeys, references, writtenThrough } from './write-syntax.ts';

function readonlyCallee(project: WriteSource, identifier: TS.Identifier): void {
  const ts = project.ts;
  const binding = lexicalBinding(ts, identifier);
  if (binding === undefined) throw new WriteUnknown('WRITE_FRAMEWORK_BINDING_UNKNOWN');
  for (const reference of references(ts, identifier.getSourceFile(), binding)) {
    if (writtenThrough(ts, reference) || !ts.isCallExpression(reference.parent) ||
        reference.parent.expression !== reference) throw new WriteUnknown('WRITE_FRAMEWORK_WRAPPER_ESCAPES');
  }
}

function configObject(project: WriteSource, expression: TS.Expression): TS.ObjectLiteralExpression {
  const ts = project.ts;
  const value = unwrap(ts, expression);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.arguments.length === 1) {
    const binding = lexicalBinding(ts, value.expression);
    if (binding === undefined || !ts.isVariableDeclaration(binding.parent) ||
        binding.parent.initializer === undefined) throw new WriteUnknown('WRITE_NEXT_CONFIG_UNKNOWN');
    const declaration = binding.parent;
    if (!ts.isVariableDeclarationList(declaration.parent) ||
        !(declaration.parent.flags & ts.NodeFlags.Const)) throw new WriteUnknown('WRITE_NEXT_CONFIG_UNKNOWN');
    const factory = unwrap(ts, declaration.initializer as TS.Expression);
    if (!ts.isCallExpression(factory) || !ts.isIdentifier(factory.expression) ||
        !isLibraryBinding(project, factory.expression, 'next-intl/plugin', 'default') ||
        factory.arguments.length !== 1 || !ts.isStringLiteral(factory.arguments[0] as TS.Expression))
      throw new WriteUnknown('WRITE_NEXT_CONFIG_UNKNOWN');
    readonlyCallee(project, factory.expression);
    readonlyCallee(project, value.expression);
    const requestConfig = (factory.arguments[0] as TS.StringLiteral).text;
    if (!requestConfig.startsWith('./')) throw new WriteUnknown('WRITE_NEXT_CONFIG_UNKNOWN');
    project.path(project.owner(value.getSourceFile()).directory, requestConfig);
    if (lockedVersion(project, value.getSourceFile(), 'next-intl') !== '4.9.2')
      throw new WriteUnknown('WRITE_NEXT_CONFIG_UNKNOWN');
    const argument = unwrap(ts, value.arguments[0] as TS.Expression);
    if (ts.isObjectLiteralExpression(argument)) return argument;
  }
  throw new WriteUnknown('WRITE_NEXT_CONFIG_UNKNOWN');
}

/** Routing conventions do not constrain calls made by inspected source. */
function frameworkInvocationClosure(project: WriteSource, file: TS.SourceFile,
  binding: TS.Identifier): void {
  const ts = project.ts;
  if (references(ts, file, binding).length !== 0)
    throw new WriteUnknown('WRITE_NEXT_METHOD_INVOCATION_UNKNOWN', binding);
  project.memoize(`next-entry-world:${file.fileName}`, () => {
    if (!project.inventoryComplete) throw new WriteUnknown('WRITE_SOURCE_INVENTORY_INCOMPLETE');
    const sourceRoot = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/i, '').toLowerCase().replace(/\/index$/, '');
    const target = sourceRoot(project.path(project.root, file.fileName));
    const workspaceNames = project.inventory.filter(path => /(?:^|\/)package\.json$/i.test(path))
      .map(path => project.json(path)['name']).filter((name): name is string => typeof name === 'string');
    const load = (source: TS.SourceFile, specifier: TS.Expression | undefined): void => {
      if (specifier === undefined || !ts.isStringLiteral(specifier))
        throw new WriteUnknown('WRITE_NEXT_METHOD_INVOCATION_UNKNOWN', source);
      // ESM resolves URL suffixes and percent escapes before choosing a file.
      // This proof does not model that resolver, so raw basename disjointness
      // cannot exclude such a load (or unsupported path spellings).
      if (/[\u0000-\u0020\u007f?#%\\]/.test(specifier.text) || specifier.text.startsWith('/') ||
          (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier.text) && !specifier.text.startsWith('node:')))
        throw new WriteUnknown('WRITE_NEXT_METHOD_INVOCATION_UNKNOWN', specifier);
      assertNativeCapabilitySummary(specifier.text, specifier);
      assertWriteImportEffects(project, source, specifier);
      if (!project.mayReference(source, specifier.text, [target])) return;
      let resolved: string;
      try { resolved = sourceRoot(project.importPath(source, specifier.text)); }
      catch (error) {
        if (!(error instanceof WriteUnknown)) throw error;
        if (error.message !== 'WRITE_ALIAS_UNKNOWN') throw error;
        project.assertExternalImport(source, specifier.text);
        if (workspaceNames.some(name => specifier.text === name || specifier.text.startsWith(name + '/'))) throw error;
        return;
      }
      if (resolved === target) throw new WriteUnknown('WRITE_NEXT_METHOD_INVOCATION_UNKNOWN', specifier);
    };
    for (const path of project.inventory) {
      if (!(WRITE_SOURCE_EXTENSIONS as readonly string[]).some(extension => path.toLowerCase().endsWith(extension))) continue;
      const source = project.parse(path, false);
      const metadata = metadataLoads(project, source);
      const visit = (node: TS.Node): void => {
        if (ts.isTypeNode(node)) return;
        assertProcessCapabilitySummary(project, node);
        if (ts.isImportDeclaration(node)) {
          const clause = node.importClause;
          if (!clause?.isTypeOnly) load(source, node.moduleSpecifier);
        } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined) {
          load(source, node.moduleSpecifier);
        } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
          // There is no reviewed namespace/capability summary for this runtime
          // syntax. A native module namespace can expose loaders such as _load.
          throw new WriteUnknown('WRITE_NEXT_METHOD_INVOCATION_UNKNOWN', node);
        } else if (ts.isCallExpression(node) && !metadata.calls.has(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
            (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require') ||
            (ts.isElementAccessExpression(node.expression) &&
              literalKeys(project, node.expression.argumentExpression)?.includes('require')))) {
          if (node.arguments.length !== 1) throw new WriteUnknown('WRITE_NEXT_METHOD_INVOCATION_UNKNOWN', node);
          load(source, node.arguments[0]);
        }
        // A CommonJS namespace can invoke this export without a lexical reference
        // or an import. Its ordinary runtime uses are outside this certificate.
        if (source.fileName === file.fileName && ts.isIdentifier(node) && ['module', 'exports'].includes(node.text) &&
            lexicalBinding(ts, node) === undefined &&
            !((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
              (ts.isPropertyAssignment(node.parent) && node.parent.name === node)))
          throw new WriteUnknown('WRITE_NEXT_METHOD_INVOCATION_UNKNOWN', node);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return true;
  });
}

function nextRequestMethod(project: WriteSource, file: TS.SourceFile, fn: TS.FunctionDeclaration,
  methods: readonly string[], invocationProof = true): string {
  const ts = project.ts;
  const method = fn.name?.text;
  if (method === undefined || !methods.includes(method) ||
      fn.asteriskToken !== undefined || fn.parent !== file || !fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      fn.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword))
    throw new WriteUnknown('WRITE_NOT_DIRECT_NEXT_METHOD');
  if (file.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === method).length !== 1 ||
      references(ts, file, fn.name as TS.Identifier).some(reference => writtenThrough(ts, reference)))
    throw new WriteUnknown('WRITE_NEXT_METHOD_REPLACED');
  const owner = project.owner(file);
  const rel = relative(owner.directory, project.path(project.root, file.fileName)).split('\\').join('/');
  if (!/^(?:src\/)?app\/(?:[^/]+\/)*route\.ts$/.test(rel) ||
      lockedVersion(project, file, 'next') !== '16.2.6') throw new WriteUnknown('WRITE_NEXT_METHOD_UNKNOWN');
  const configs = project.inventory.filter(path =>
    /^next\.config\.(?:ts|mjs|js|cjs)$/i.test(relative(owner.directory, project.path(project.root, path))));
  if (configs.length > 1) throw new WriteUnknown('WRITE_NEXT_CONFIG_AMBIGUOUS');
  if (configs.length === 1) {
    const config = project.parse(configs[0] as string);
    const exports = config.statements.filter((statement): statement is TS.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals);
    if (exports.length !== 1) throw new WriteUnknown('WRITE_NEXT_CONFIG_UNKNOWN');
    project.count(exports[0] as TS.ExportAssignment);
    const object = configObject(project, (exports[0] as TS.ExportAssignment).expression);
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property) || property.name === undefined ||
          declaredName(ts, property.name) === undefined || ['pageExtensions', 'webpack', 'turbopack', 'experimental'].includes(declaredName(ts, property.name) ?? ''))
        throw new WriteUnknown('WRITE_NEXT_PAGE_EXTENSIONS_UNKNOWN');
      if (declaredName(ts, property.name) === 'typescript') {
        if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(unwrap(ts, property.initializer)))
          throw new WriteUnknown('WRITE_NEXT_TYPESCRIPT_CONFIG_UNKNOWN', property);
        const options = unwrap(ts, property.initializer) as TS.ObjectLiteralExpression;
        for (const option of options.properties) {
          if (!ts.isPropertyAssignment(option) || declaredName(ts, option.name) === undefined)
            throw new WriteUnknown('WRITE_NEXT_TYPESCRIPT_CONFIG_UNKNOWN', option);
          const key = declaredName(ts, option.name);
          const value = unwrap(ts, option.initializer);
          if (key === 'tsconfigPath' ? !ts.isStringLiteral(value) || !['tsconfig.json', './tsconfig.json'].includes(value.text) :
              key !== 'ignoreBuildErrors' || ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(value.kind))
            throw new WriteUnknown('WRITE_NEXT_TYPESCRIPT_CONFIG_UNKNOWN', option);
        }
      }
    }
  }
  if (invocationProof) frameworkInvocationClosure(project, file, fn.name as TS.Identifier);
  return method;
}

/** Existing write admission remains confined to the original method set. */
export function nextWriteMethod(project: WriteSource, file: TS.SourceFile, fn: TS.FunctionDeclaration): string {
  return nextRequestMethod(project, file, fn, ['POST', 'PUT', 'PATCH', 'DELETE']);
}

/** Local eligibility reserves a possible name; it never proves an invocation. */
export function possibleWriteMethod(project: WriteSource, file: TS.SourceFile, fn: TS.FunctionDeclaration): string {
  return nextRequestMethod(project, file, fn, ['POST', 'PUT', 'PATCH', 'DELETE'], false);
}

/** Method evidence for query-copy callers; it grants no write-binding admission. */
export function nextQueryCopyCallerMethod(project: WriteSource, file: TS.SourceFile,
  fn: TS.FunctionDeclaration): string {
  return nextRequestMethod(project, file, fn, ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
}
