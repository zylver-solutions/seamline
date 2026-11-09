// SPDX-License-Identifier: Apache-2.0
/** Fresh-input syntax evidence; intrinsic integrity and caller proofs are separate. */
import type * as TS from 'typescript';
import type { WriteParserShape } from './write-parser-shape.ts';
import type { QueryCopyShape } from './write-query-copy-shape.ts';
import { unwrap, WriteUnknown, type WriteSource } from './write-source.ts';
import { lexicalBinding, references } from './write-syntax.ts';

export interface QueryConstructionSyntax {
  readonly record: TS.CallExpression;
  readonly url: TS.NewExpression;
  readonly objectIntrinsic: TS.Identifier;
  readonly urlIntrinsic: TS.Identifier;
  readonly urlAlias?: TS.Identifier;
}

export function queryConstructionSyntax(project: WriteSource, parser: WriteParserShape,
  copy: QueryCopyShape): QueryConstructionSyntax {
  const ts = project.ts;
  const fail = (): never => { throw new WriteUnknown('WRITE_QUERY_INPUT_PROVENANCE_UNKNOWN', parser.fn); };
  const record = unwrap(ts, copy.initializer);
  if (!ts.isCallExpression(record) || record.arguments.length !== 1 || record.questionDotToken !== undefined ||
      record.typeArguments !== undefined || !ts.isPropertyAccessExpression(record.expression) ||
      record.expression.questionDotToken !== undefined || record.expression.name.text !== 'fromEntries' ||
      !ts.isIdentifier(record.expression.expression) || record.expression.expression.text !== 'Object' ||
      lexicalBinding(ts, record.expression.expression) !== undefined) return fail();
  const objectIntrinsic = record.expression.expression;
  const parameters = unwrap(ts, record.arguments[0] as TS.Expression);
  if (!ts.isPropertyAccessExpression(parameters) || parameters.questionDotToken !== undefined ||
      parameters.name.text !== 'searchParams') return fail();
  let value = unwrap(ts, parameters.expression);
  let urlAlias: TS.Identifier | undefined;
  if (ts.isIdentifier(value)) {
    const binding = lexicalBinding(ts, value);
    const declaration = binding?.parent;
    if (binding === undefined || declaration === undefined || !ts.isVariableDeclaration(declaration) ||
        declaration.initializer === undefined || !ts.isVariableDeclarationList(declaration.parent) ||
        declaration.parent.getFirstToken(parser.declaration.file)?.kind !== ts.SyntaxKind.ConstKeyword ||
        parser.variables.get(binding.text) !== declaration || declaration.getStart() >= copy.queryDeclaration.getStart()) return fail();
    const allowed = new Set<TS.Identifier>([value]);
    for (const property of parser.returnObject.properties) {
      const returned = ts.isShorthandPropertyAssignment(property) ? property.name :
        ts.isPropertyAssignment(property) ? unwrap(ts, property.initializer) : undefined;
      if (returned !== undefined && ts.isIdentifier(returned) && lexicalBinding(ts, returned) === binding) allowed.add(returned);
    }
    if (references(ts, parser.fn, binding).some(reference => !allowed.has(reference))) return fail();
    urlAlias = binding;
    value = unwrap(ts, declaration.initializer);
  }
  if (!ts.isNewExpression(value) || value.arguments?.length !== 1 || value.typeArguments !== undefined ||
      !ts.isIdentifier(value.expression) || value.expression.text !== 'URL' ||
      lexicalBinding(ts, value.expression) !== undefined) return fail();
  const input = unwrap(ts, value.arguments[0] as TS.Expression);
  if (!ts.isPropertyAccessExpression(input) || input.questionDotToken !== undefined || input.name.text !== 'url' ||
      !ts.isIdentifier(input.expression) || lexicalBinding(ts, input.expression) !== parser.request) return fail();
  return { record, url: value, objectIntrinsic, urlIntrinsic: value.expression,
    ...(urlAlias === undefined ? {} : { urlAlias }) };
}
