// SPDX-License-Identifier: Apache-2.0
/** A closed, non-GET safeParse summary with the strict capability guard. */
import type { WriteDeclaration, WriteSource } from './write-source.ts';
import { parseWriteParserShape, type WriteParserSummary } from './write-parser-shape.ts';
import { rejectDynamicCode } from './write-syntax.ts';

export type { WriteParserSummary } from './write-parser-shape.ts';

export function summarizeWriteParser(project: WriteSource, declaration: WriteDeclaration): WriteParserSummary {
  const shape = parseWriteParserShape(project, declaration);
  rejectDynamicCode(project, shape.fn);
  return { bodyKey: shape.bodyKey, errorKey: shape.errorKey,
    functionName: shape.functionName, file: shape.file };
}
