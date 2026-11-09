// SPDX-License-Identifier: Apache-2.0
/** Admit only the reviewed zero-argument factory; no callable aliases or re-exports. */
import type * as TS from 'typescript';
import { references, lexicalBinding, writtenThrough } from './write-syntax.ts';
import { WriteUnknown, type WriteSource } from './write-source.ts';

export function assertEffectUse(project: WriteSource, file: TS.SourceFile, specifier: TS.StringLiteral): void {
  const ts = project.ts;
  function fail(node: TS.Node): never { throw new WriteUnknown('WRITE_EFFECT_CERTIFICATE_USE_UNKNOWN', node); }
  const call = (reference: TS.Expression): void => {
    const parent = reference.parent;
    if (!ts.isCallExpression(parent) || parent.expression !== reference || parent.questionDotToken !== undefined ||
        parent.typeArguments !== undefined || parent.arguments.length !== 0) fail(reference);
    project.count(parent);
  };
  const binding = (identifier: TS.Identifier, namespace: boolean): void => {
    for (const reference of references(ts, file, identifier)) {
      if (writtenThrough(ts, reference)) fail(reference);
      if (!namespace) { call(reference); continue; }
      const member = reference.parent;
      if (!ts.isPropertyAccessExpression(member) || member.expression !== reference || member.name.text !== 'default' ||
          member.questionDotToken !== undefined) fail(reference);
      call(member);
    }
  };
  const parent = specifier.parent;
  if (ts.isImportDeclaration(parent)) {
    if (parent.attributes !== undefined) return fail(parent);
    const clause = parent.importClause;
    if (clause === undefined || clause.isTypeOnly) return;
    if (clause.name !== undefined) binding(clause.name, false);
    const names = clause.namedBindings;
    if (names === undefined) return;
    if (ts.isNamespaceImport(names)) { binding(names.name, true); return; }
    for (const item of names.elements) {
      if (item.isTypeOnly) continue;
      if ((item.propertyName?.text ?? item.name.text) !== 'default') fail(item);
      binding(item.name, false);
    }
    return;
  }
  if (ts.isExportDeclaration(parent)) {
    if (parent.attributes !== undefined || parent.exportClause === undefined || !ts.isNamedExports(parent.exportClause) ||
        parent.exportClause.elements.some(item => !item.isTypeOnly)) return fail(parent);
    return;
  }
  if (!ts.isCallExpression(parent) || parent.arguments.length !== 1) return fail(parent);
  // No dynamic namespace promise or opaque createRequire result receives API credit.
  if (!ts.isIdentifier(parent.expression) || parent.expression.text !== 'require' ||
      lexicalBinding(ts, parent.expression) !== undefined) return fail(parent);
  if (ts.isExpressionStatement(parent.parent)) return;
  const target = parent.parent;
  if (ts.isVariableDeclaration(target) && target.initializer === parent && ts.isIdentifier(target.name) &&
      ts.isVariableDeclarationList(target.parent) && (target.parent.flags & ts.NodeFlags.Const)) {
    const statement = target.parent.parent;
    if (!ts.isVariableStatement(statement) || statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
      return fail(target);
    binding(target.name, false); return;
  }
  if (ts.isCallExpression(target) && target.expression === parent) { call(parent); return; }
  return fail(parent);
}
