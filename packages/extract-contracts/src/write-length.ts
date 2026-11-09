// SPDX-License-Identifier: Apache-2.0
/** Positive, deliberately small Zod upper-length grammar for X7. */
import type * as TS from 'typescript';

export type LengthState =
  | { readonly state: 'unbounded' }
  | { readonly state: 'bounded'; readonly maxLength: number }
  | { readonly state: 'unknown' };

const UNKNOWN: LengthState = { state: 'unknown' };

export function writeStringLength(
  ts: typeof TS,
  expression: TS.Expression,
  zodBindings: ReadonlySet<string>,
  maxDepth: number,
): LengthState {
  let cursor = expression;
  let bound: number | undefined;
  let depth = 0;
  for (;;) {
    if (++depth > maxDepth) return UNKNOWN;
    if (ts.isParenthesizedExpression(cursor)) {
      cursor = cursor.expression;
      continue;
    }
    if (!ts.isCallExpression(cursor) || cursor.questionDotToken !== undefined ||
        cursor.typeArguments !== undefined || !ts.isPropertyAccessExpression(cursor.expression) ||
        cursor.expression.questionDotToken !== undefined) return UNKNOWN;
    const access = cursor.expression;
    const operation = access.name.text;
    if (ts.isIdentifier(access.expression) && zodBindings.has(access.expression.text)) {
      if (operation !== 'string' || cursor.arguments.length !== 0) return UNKNOWN;
      return bound === undefined ? { state: 'unbounded' } : { state: 'bounded', maxLength: bound };
    }
    if (operation === 'optional' || operation === 'nullable' || operation === 'nullish') {
      if (cursor.arguments.length !== 0) return UNKNOWN;
    } else if (operation === 'max' || operation === 'length') {
      const argument = cursor.arguments[0];
      if (bound !== undefined || cursor.arguments.length !== 1 || argument === undefined ||
          !ts.isNumericLiteral(argument)) return UNKNOWN;
      bound = Number(argument.text);
      if (!Number.isSafeInteger(bound) || bound < 0) return UNKNOWN;
    } else {
      return UNKNOWN;
    }
    cursor = access.expression;
  }
}
