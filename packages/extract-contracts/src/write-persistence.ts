// SPDX-License-Identifier: Apache-2.0
/** A parameter forwarded unchanged to a literal Prisma create/update data member. */
import type * as TS from 'typescript';
import { possibleWriteClientLineage, proveWriteClient, type WriteClientProof } from './write-client.ts';
import { type WriteModel } from './write-prisma.ts';
import { declaredName, unwrap, WriteSource, WriteUnknown, type WriteDeclaration } from './write-source.ts';
import { lexicalBinding, references, rejectDynamicCode, writtenThrough } from './write-syntax.ts';

interface PersistenceIdentity {
  readonly parameterIndex: number;
  readonly model: WriteModel;
  readonly owningPackage: string;
  readonly lexicalChain: readonly string[];
  readonly operation: 'create' | 'update';
  readonly file: string;
}

export interface WritePersistenceSummary extends PersistenceIdentity {
  readonly purpose: 'validated-write';
  readonly client: WriteClientProof;
}

export interface WritePersistenceReservation extends PersistenceIdentity {
  readonly purpose: 'identity-reservation';
}

export type WritePersistence = WritePersistenceSummary | WritePersistenceReservation;

export function summarizeWritePersistence(project: WriteSource, declaration: WriteDeclaration,
  models: readonly WriteModel[], identityOnly?: false): WritePersistenceSummary;
export function summarizeWritePersistence(project: WriteSource, declaration: WriteDeclaration,
  models: readonly WriteModel[], identityOnly: boolean): WritePersistence;

export function summarizeWritePersistence(
  project: WriteSource,
  declaration: WriteDeclaration,
  models: readonly WriteModel[],
  identityOnly = false,
): WritePersistence {
  const ts = project.ts;
  const fn = declaration.node;
  if (!ts.isFunctionDeclaration(fn) || fn.name === undefined || fn.body === undefined || fn.asteriskToken !== undefined ||
      fn.parent !== declaration.file || fn.parameters.length === 0 ||
      fn.parameters.some(parameter => !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined))
    throw new WriteUnknown('WRITE_PERSISTENCE_SHAPE_UNKNOWN');
  project.count(fn);
  rejectDynamicCode(project, fn);
  if (references(ts, declaration.file, fn.name).some(reference => writtenThrough(ts, reference)))
    throw new WriteUnknown('WRITE_PERSISTENCE_REPLACED');
  const final = fn.body.statements[fn.body.statements.length - 1];
  if (final === undefined || !ts.isReturnStatement(final) || final.expression === undefined)
    throw new WriteUnknown('WRITE_PERSISTENCE_RETURN_UNKNOWN');
  let call = unwrap(ts, final.expression);
  if (ts.isAwaitExpression(call)) call = unwrap(ts, call.expression);
  if (!ts.isCallExpression(call) || call.questionDotToken !== undefined || call.typeArguments !== undefined ||
      !ts.isPropertyAccessExpression(call.expression) || call.expression.questionDotToken !== undefined ||
      !['create', 'update'].includes(call.expression.name.text) || call.arguments.length !== 1 ||
      !ts.isPropertyAccessExpression(call.expression.expression) || call.expression.expression.questionDotToken !== undefined)
    throw new WriteUnknown('WRITE_PERSISTENCE_CALL_UNKNOWN');
  const delegate = call.expression.expression;
  const options = unwrap(ts, call.arguments[0] as TS.Expression);
  if (!ts.isObjectLiteralExpression(options) || options.properties.some(property =>
    !ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)))
    throw new WriteUnknown('WRITE_PERSISTENCE_DATA_UNKNOWN');
  const names = options.properties.map(property => declaredName(ts, property.name));
  if (names.some(name => name === undefined) || new Set(names).size !== names.length)
    throw new WriteUnknown('WRITE_PERSISTENCE_DATA_UNKNOWN');
  const data = options.properties.find(property => declaredName(ts, property.name) === 'data');
  const dataValue = data !== undefined && ts.isShorthandPropertyAssignment(data) ? data.name :
    data !== undefined && ts.isPropertyAssignment(data) ? unwrap(ts, data.initializer) : undefined;
  if (dataValue === undefined || !ts.isIdentifier(dataValue)) throw new WriteUnknown('WRITE_PERSISTENCE_DATA_CHANGED');
  let binding = lexicalBinding(ts, dataValue);
  const allowed = new Map<TS.Identifier, Set<TS.Identifier>>();
  let reference = dataValue;
  const seen = new Set<TS.Identifier>();
  while (binding !== undefined && ts.isVariableDeclaration(binding.parent)) {
    if (seen.has(binding)) throw new WriteUnknown('WRITE_PERSISTENCE_ALIAS_CYCLE');
    seen.add(binding);
    allowed.set(binding, new Set([reference]));
    const alias = binding.parent;
    if (!(alias.parent.flags & ts.NodeFlags.Const) || alias.initializer === undefined ||
        !ts.isIdentifier(unwrap(ts, alias.initializer)) || !ts.isVariableStatement(alias.parent.parent) ||
        alias.parent.parent.parent !== fn.body) throw new WriteUnknown('WRITE_PERSISTENCE_ALIAS_UNKNOWN');
    reference = unwrap(ts, alias.initializer) as TS.Identifier;
    binding = lexicalBinding(ts, reference);
  }
  const parameterIndex = fn.parameters.findIndex(parameter => parameter.name === binding);
  if (binding === undefined || parameterIndex < 0) throw new WriteUnknown('WRITE_PERSISTENCE_PARAMETER_UNKNOWN');
  allowed.set(binding, new Set([reference]));
  for (const [variable, expected] of allowed) {
    if (references(ts, fn, variable).some(use => !expected.has(use)))
      throw new WriteUnknown('WRITE_PERSISTENCE_DATA_ESCAPES');
  }
  // The prefix is solely immutable aliases in the proved chain. It cannot
  // contain a helper with arbitrary effects before the data reaches Prisma.
  for (const statement of fn.body.statements.slice(0, -1)) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const) ||
        statement.declarationList.declarations.some(variable => !ts.isIdentifier(variable.name) || !allowed.has(variable.name)))
      throw new WriteUnknown('WRITE_PERSISTENCE_PREFIX_UNKNOWN');
  }
  const client = identityOnly ? undefined : proveWriteClient(project, delegate.expression, models);
  const lineage = client?.lineage ?? possibleWriteClientLineage(project, delegate.expression, models);
  const candidates = models.filter(model => model.generatedDirectory === lineage.generatedDirectory &&
    model.model.charAt(0).toLowerCase() + model.model.slice(1) === delegate.name.text);
  if (candidates.length !== 1) throw new WriteUnknown('WRITE_PERSISTENCE_MODEL_UNKNOWN');
  return {
    parameterIndex,
    model: candidates[0] as WriteModel,
    ...(client === undefined ? { purpose: 'identity-reservation' as const } : { purpose: 'validated-write' as const, client }),
    owningPackage: project.owner(declaration.file).name,
    lexicalChain: [fn.name.text],
    operation: call.expression.name.text as 'create' | 'update',
    file: declaration.file.fileName,
  };
}
