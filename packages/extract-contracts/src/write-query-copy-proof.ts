// SPDX-License-Identifier: Apache-2.0
/** A complete shared query-copy certificate, scoped to one immutable proposal. */
import type * as TS from 'typescript';
import { parseWriteParserShape } from './write-parser-shape.ts';
import { closedQueryCopyShape } from './write-query-copy-shape.ts';
import { queryConstructionSyntax } from './write-query-copy-input.ts';
import { queryCopyCallers } from './write-query-copy-callers.ts';
import { querySchemaConstruction } from './write-query-copy-schema.ts';
import { queryCopySourceWorld } from './write-query-copy-world.ts';
import { exactQueryCopyNode } from './write-query-copy-nodes.ts';
import { WriteUnknown, type WriteSource } from './write-source.ts';

type Certificate = readonly [TS.ElementAccessExpression, TS.ElementAccessExpression];
const active = new WeakMap<WriteSource, Set<TS.FunctionDeclaration>>();

export function permitsQueryDataCopy(project: WriteSource, node: TS.ElementAccessExpression): boolean {
  project.assertBudget();
  const ts = project.ts;
  let owner: TS.Node | undefined = node.parent;
  while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (owner === undefined || !ts.isFunctionDeclaration(owner) || owner.name === undefined) return false;
  const fn = owner;
  const name = owner.name;
  const pending = active.get(project) ?? new Set<TS.FunctionDeclaration>();
  active.set(project, pending);
  if (pending.has(fn)) return false;
  pending.add(fn);
  try {
    // Reuse through the source input proof cache so every enclosing memo trace
    // also receives the complete syntax, module and resolution dependencies.
    const data = project.memoize<Certificate>(`query-copy:${fn.getSourceFile().fileName}:${fn.pos}:${fn.end}`, () => {
      const parser = parseWriteParserShape(project, { file: fn.getSourceFile(), node: fn, name: name.text });
      const copy = closedQueryCopyShape(project, parser);
      queryConstructionSyntax(project, parser, copy);
      const callers = queryCopyCallers(project, parser);
      for (const caller of callers) if (caller.executesCopy) {
        if (caller.schema === undefined) throw new WriteUnknown('WRITE_QUERY_SCHEMA_EFFECTS_UNKNOWN', caller.call);
        querySchemaConstruction(project, caller.schema, caller.call);
      }
      const data: Certificate = [copy.destination, copy.source];
      queryCopySourceWorld(project, data);
      project.assertBudget();
      return data;
    });
    return exactQueryCopyNode(data, node);
  } catch (error) {
    if (!(error instanceof WriteUnknown)) throw error;
    // Budget-dependent refusals are not cached by memoize; the sticky proposal
    // failure still survives both derivation and later cached source answers.
    project.assertBudget();
    return false;
  } finally { pending.delete(fn); }
}
