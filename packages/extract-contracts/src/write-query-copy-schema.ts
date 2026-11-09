// SPDX-License-Identifier: Apache-2.0
/** Exact-artifact local constructor evidence; namespace and caller closure are separate. */
import type * as TS from 'typescript';
import { lockedVersion, WRITE_LIBRARY_SUMMARIES } from './write-libraries.ts';
import { declaredName, unwrap, WriteUnknown, type WriteSource } from './write-source.ts';
import { isLibraryBinding, lexicalBinding, references } from './write-syntax.ts';

export interface QuerySchemaConstruction {
  readonly version: '4.3.6';
  readonly fields: readonly string[];
  readonly namespaceUses: readonly TS.Identifier[];
}

// The reviewed published artifact is identified in write-libraries.ts. Its
// core/parse.ts safeParse and core/schemas.ts object/string parsers provide the
// local model: ordinary primitive input, default strip, fresh ordinary output.
// Source-world intrinsic integrity, global hooks and all callers must also pass.
export function querySchemaConstruction(project: WriteSource, schema: TS.VariableDeclaration,
  call: TS.CallExpression): QuerySchemaConstruction {
  const ts = project.ts;
  const fail = (): never => { throw new WriteUnknown('WRITE_QUERY_SCHEMA_EFFECTS_UNKNOWN', schema); };
  let owner: TS.Node | undefined = schema.parent;
  while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
  let caller: TS.Node | undefined = call.parent;
  while (caller !== undefined && !ts.isFunctionLike(caller)) caller = caller.parent;
  if (owner === undefined || !ts.isFunctionDeclaration(owner) || owner.body === undefined || caller !== owner) return fail();
  project.count(owner);
  if (!ts.isIdentifier(schema.name) || schema.initializer === undefined ||
      !ts.isVariableDeclarationList(schema.parent) ||
      schema.parent.getFirstToken(schema.getSourceFile())?.kind !== ts.SyntaxKind.ConstKeyword) return fail();
  const argument = call.arguments[1];
  const use = argument === undefined ? undefined : unwrap(ts, argument);
  if (use === undefined || !ts.isIdentifier(use) || lexicalBinding(ts, use) !== schema.name ||
      references(ts, schema.getSourceFile(), schema.name).some(reference => reference !== use)) return fail();
  const namespaces: TS.Identifier[] = [];
  const factory = (value: TS.Expression, name: string): TS.CallExpression => {
    const node = unwrap(ts, value);
    if (!ts.isCallExpression(node) || node.questionDotToken !== undefined || node.typeArguments !== undefined ||
        !ts.isPropertyAccessExpression(node.expression) || node.expression.questionDotToken !== undefined ||
        node.expression.name.text !== name || !ts.isIdentifier(node.expression.expression) ||
        !isLibraryBinding(project, node.expression.expression, 'zod', 'z')) return fail();
    const namespace = node.expression.expression;
    if (WRITE_LIBRARY_SUMMARIES.zod.version !== '4.3.6' ||
        lockedVersion(project, namespace.getSourceFile(), 'zod') !== '4.3.6') return fail();
    namespaces.push(namespace);
    return node;
  };
  const object = factory(schema.initializer, 'object');
  if (object.arguments.length !== 1) return fail();
  const shape = unwrap(ts, object.arguments[0] as TS.Expression);
  if (!ts.isObjectLiteralExpression(shape)) return fail();
  const names = new Set<string>();
  for (const property of shape.properties) {
    if (!ts.isPropertyAssignment(property)) return fail();
    const name = declaredName(ts, property.name);
    if (name === undefined || names.has(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) return fail();
    names.add(name);
    let field = unwrap(ts, property.initializer);
    while (ts.isCallExpression(field) && ts.isPropertyAccessExpression(field.expression) &&
        ['optional', 'nullable', 'nullish'].includes(field.expression.name.text)) {
      if (field.arguments.length !== 0 || field.questionDotToken !== undefined || field.typeArguments !== undefined ||
          field.expression.questionDotToken !== undefined) return fail();
      field = unwrap(ts, field.expression.expression);
    }
    const string = factory(field, 'string');
    if (string.arguments.length !== 0) return fail();
  }
  return { version: '4.3.6', fields: [...names].sort(), namespaceUses: namespaces };
}
