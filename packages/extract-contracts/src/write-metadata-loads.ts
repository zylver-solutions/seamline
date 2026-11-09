// SPDX-License-Identifier: Apache-2.0
/** Recognize data-only Node package metadata reads, never execute a loader. */
import { dirname } from 'node:path';
import type * as TS from 'typescript';
import { unwrap, WriteSource, WriteUnknown } from './write-source.ts';
import { lexicalBinding, references, writtenThrough } from './write-syntax.ts';

const MODULE = new Set(['module', 'node:module']);
const PATH = new Set(['path', 'node:path']);

export function metadataLoads(project: WriteSource, file: TS.SourceFile): {
  readonly factories: ReadonlySet<TS.Identifier>; readonly calls: ReadonlySet<TS.CallExpression>;
} {
  const ts = project.ts;
  const factories = new Set<TS.Identifier>();
  const paths = new Set<TS.Identifier>();
  const calls = new Set<TS.CallExpression>();
  for (const statement of file.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
        statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (!MODULE.has(module) && !PATH.has(module)) continue;
    if (ts.isExportDeclaration(statement)) {
      if (!statement.isTypeOnly) throw new WriteUnknown('WRITE_NATIVE_MODULE_REEXPORT', statement);
      continue;
    }
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    project.assertExternalImport(file, module);
    if (MODULE.has(module)) {
      if (clause === undefined || clause.name !== undefined || clause.namedBindings === undefined ||
          !ts.isNamedImports(clause.namedBindings)) throw new WriteUnknown('WRITE_NATIVE_LOADER_UNKNOWN', statement);
      for (const item of clause.namedBindings.elements) {
        if (item.isTypeOnly) continue;
        if ((item.propertyName?.text ?? item.name.text) !== 'createRequire') throw new WriteUnknown('WRITE_NATIVE_LOADER_UNKNOWN', item);
        factories.add(item.name);
      }
    } else if (clause !== undefined) {
      if (clause.name !== undefined) paths.add(clause.name);
      if (clause.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) paths.add(clause.namedBindings.name);
        else for (const item of clause.namedBindings.elements)
          if (!item.isTypeOnly && ['default', 'posix', 'win32'].includes(item.propertyName?.text ?? item.name.text)) paths.add(item.name);
      }
    }
  }
  for (const path of paths) for (const reference of references(ts, file, path)) {
    const member = reference.parent;
    if (writtenThrough(ts, reference) || !ts.isPropertyAccessExpression(member) || member.expression !== reference)
      throw new WriteUnknown('WRITE_NATIVE_PATH_ESCAPES', reference);
    // A namespace result such as path.posix is the same mutable API object on
    // its native platform. It cannot escape into an untracked alias.
    if (['sep', 'delimiter'].includes(member.name.text)) continue;
    if (!['resolve', 'join', 'dirname', 'basename', 'extname', 'normalize', 'relative',
      'isAbsolute', 'toNamespacedPath', 'parse'].includes(member.name.text) ||
        !ts.isCallExpression(member.parent) || member.parent.expression !== member)
      throw new WriteUnknown('WRITE_NATIVE_PATH_ESCAPES', reference);
  }
  const packageFile = (argument: TS.Expression): boolean => {
    const value = unwrap(ts, argument);
    if (ts.isStringLiteral(value) && /^\.\.?\/(?:[^/]+\/)*package\.json$/.test(value.text)) {
      const target = project.rel(project.path(dirname(project.path(project.root, file.fileName)), value.text));
      if (!project.inventory.includes(target)) return false;
      project.json(target);
      return true;
    }
    if (!ts.isCallExpression(value) || value.arguments.length !== 2 || value.typeArguments !== undefined || value.questionDotToken !== undefined ||
        !ts.isPropertyAccessExpression(value.expression) || value.expression.questionDotToken !== undefined || value.expression.name.text !== 'resolve' ||
        !ts.isIdentifier(value.expression.expression) || !paths.has(lexicalBinding(ts, value.expression.expression) as TS.Identifier)) return false;
    const cwd = value.arguments[0];
    const name = value.arguments[1];
    if (cwd === undefined || !ts.isCallExpression(cwd) || cwd.arguments.length !== 0 || cwd.typeArguments !== undefined || cwd.questionDotToken !== undefined ||
        !ts.isPropertyAccessExpression(cwd.expression) || cwd.expression.questionDotToken !== undefined || cwd.expression.name.text !== 'cwd' ||
        !ts.isIdentifier(cwd.expression.expression) || cwd.expression.expression.text !== 'process' || lexicalBinding(ts, cwd.expression.expression) !== undefined ||
        name === undefined || !ts.isStringLiteral(name) || name.text !== 'package.json') return false;
    // This form names data only within the inspected source boundary. A JSON-
    // named directory could instead load executable package code, so refuse it.
    if (project.inventory.some(path => path.split('/').slice(0, -1).includes('package.json'))) return false;
    project.json('package.json');
    return true;
  };
  for (const factory of factories) for (const reference of references(ts, file, factory)) {
    const call = reference.parent;
    if (!ts.isCallExpression(call) || call.expression !== reference || call.arguments.length !== 1 || call.typeArguments !== undefined ||
        call.questionDotToken !== undefined) throw new WriteUnknown('WRITE_NATIVE_LOADER_UNKNOWN', reference);
    const url = call.arguments[0];
    if (url === undefined || !ts.isPropertyAccessExpression(url) || url.name.text !== 'url' ||
        !ts.isMetaProperty(url.expression) || url.expression.keywordToken !== ts.SyntaxKind.ImportKeyword)
      throw new WriteUnknown('WRITE_NATIVE_LOADER_UNKNOWN', reference);
    const binding = call.parent;
    if (!ts.isVariableDeclaration(binding) || binding.initializer !== call || !ts.isIdentifier(binding.name) ||
        !ts.isVariableDeclarationList(binding.parent) || !(binding.parent.flags & ts.NodeFlags.Const) ||
        !ts.isVariableStatement(binding.parent.parent) || binding.parent.parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
      throw new WriteUnknown('WRITE_NATIVE_LOADER_ESCAPES', call);
    for (const use of references(ts, file, binding.name)) {
      const read = use.parent;
      if (!ts.isCallExpression(read) || read.expression !== use || read.arguments.length !== 1 || read.typeArguments !== undefined ||
          read.questionDotToken !== undefined || read.arguments[0] === undefined || !packageFile(read.arguments[0]))
        throw new WriteUnknown('WRITE_NATIVE_LOADER_ESCAPES', use);
      calls.add(read);
    }
  }
  return { factories, calls };
}
