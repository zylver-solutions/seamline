// SPDX-License-Identifier: Apache-2.0
/** The admitted local write producer, kept separate from legacy top-level Zod identity. */
import type * as TS from 'typescript';
import { proveLocalWrite, type LocalWriteProof } from './write-binding.ts';
import { writeTableFromIndex, type WriteTable } from './write-index.ts';
import { prismaWriteModels } from './write-prisma.ts';
import { unwrap, writeInventory, WriteSource, WriteUnknown, type WriteInventory } from './write-source.ts';
import { lexicalBinding, references, transparentReference, writtenThrough } from './write-syntax.ts';
import { defaultLoadTs } from './zod.ts';
import type { ContractFact, ExtractLimits, ExtractOptions, PropertyFact } from './types.ts';
import { couldShareWriteIdentity, inventoryWriteAuthority, isWriteRoute } from './write-authority-inventory.ts';
import { decodeWriteContractName } from './write-identity.ts';
import { assertInventoryScriptOrigins } from './write-script-origins.ts';

export interface ValidatedWriteExtraction {
  readonly contracts: readonly ContractFact[];
  readonly properties: readonly PropertyFact[];
  readonly diagnostics: readonly string[];
  readonly withheld: readonly { readonly name: string; readonly file: string }[];
  readonly unvouched: ReadonlySet<string>;
  readonly sourceFiles: ReadonlySet<string>;
  readonly explicitAuthorityOnly: boolean;
  readonly typeScriptUnavailable: boolean;
  readonly handlerFiles: ReadonlySet<string>;
  readonly authorityCandidates: readonly { readonly name: string; readonly file: string }[];
  readonly sourceInventory: WriteInventory;
}

function bindingNames(ts: typeof TS, name: TS.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(ts, element.name) : []);
}

function schemaCandidates(ts: typeof TS, file: TS.SourceFile): {
  candidates: Array<{ fn: TS.FunctionDeclaration; schema: TS.VariableDeclaration }>; unsupported: boolean;
} {
  const candidates: Array<{ fn: TS.FunctionDeclaration; schema: TS.VariableDeclaration }> = [];
  let unsupported = false;
  const containsObjectCall = (node: TS.Node): boolean => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ['object', 'strictObject', 'looseObject'].includes(node.expression.name.text)) return true;
    return ts.forEachChild(node, child => containsObjectCall(child) ? true : undefined) ?? false;
  };
  for (const fn of file.statements) {
    if (!ts.isFunctionDeclaration(fn) || fn.name === undefined ||
        !['POST', 'PUT', 'PATCH', 'DELETE'].includes(fn.name.text)) continue;
    const signatureUnknown = fn.body === undefined || fn.parameters[0] === undefined || !ts.isIdentifier(fn.parameters[0].name) ||
      fn.parameters[0].initializer !== undefined || fn.parameters[0].dotDotDotToken !== undefined ||
      !fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || fn.asteriskToken !== undefined;
    if (signatureUnknown) unsupported = true;
    if (fn.body === undefined) continue;
    const requestParameters = fn.parameters.flatMap(parameter => ts.isIdentifier(parameter.name) ? [parameter.name] : []);
    const variables = new Map<string, TS.VariableDeclaration[]>();
    const selected = new Set<TS.VariableDeclaration>();
    const collect = (node: TS.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        for (const name of bindingNames(ts, node.name)) {
          const matches = variables.get(name) ?? [];
          matches.push(node); variables.set(name, matches);
        }
        if (node.initializer !== undefined && containsObjectCall(node.initializer)) selected.add(node);
      }
      ts.forEachChild(node, collect);
    };
    collect(fn.body);
    const localVariables = new Set([...variables.values()].flat());
    const inspectedAliases = new Set<TS.VariableDeclaration>();
    const selectReferences = (node: TS.Node): void => {
      if (ts.isIdentifier(node)) {
        const binding = lexicalBinding(ts, node);
        if (binding !== undefined && references(ts, node, binding).length > 0) {
          let declaration: TS.Node | undefined = binding.parent;
          while (declaration !== undefined && declaration !== fn && !ts.isVariableDeclaration(declaration)) declaration = declaration.parent;
          if (declaration !== undefined && ts.isVariableDeclaration(declaration) && localVariables.has(declaration)) {
            selected.add(declaration);
            if (!inspectedAliases.has(declaration) && declaration.initializer !== undefined) {
              inspectedAliases.add(declaration);
              selectReferences(declaration.initializer);
            }
          }
        }
      }
      ts.forEachChild(node, selectReferences);
    };
    const requestDependent = (node: TS.Node, seen = new Set<TS.VariableDeclaration>(), depth = 0): boolean => {
      if (depth >= 64) { unsupported = true; return true; }
      if (ts.isIdentifier(node)) {
        const binding = lexicalBinding(ts, node);
        if (binding !== undefined && requestParameters.includes(binding)) return true;
        const declaration = binding?.parent;
        if (declaration !== undefined && ts.isVariableDeclaration(declaration) && localVariables.has(declaration) &&
            declaration.initializer !== undefined && !seen.has(declaration))
          return requestDependent(declaration.initializer, new Set(seen).add(declaration), depth + 1);
      }
      return ts.forEachChild(node, child => requestDependent(child, seen, depth + 1) ? true : undefined) ?? false;
    };
    const positionalParse = (expression: TS.Expression): boolean => {
      let value = unwrap(ts, expression);
      if (ts.isAwaitExpression(value)) value = unwrap(ts, value.expression);
      if (!ts.isCallExpression(value) || !ts.isIdentifier(value.expression) || value.arguments.length !== 2) return false;
      const request = value.arguments[0];
      const schema = value.arguments[1];
      if (request === undefined || !requestParameters.some(parameter => transparentReference(ts, request, parameter) === true) ||
          schema === undefined || !ts.isIdentifier(unwrap(ts, schema))) return false;
      const declaration = lexicalBinding(ts, unwrap(ts, schema) as TS.Identifier)?.parent;
      return declaration !== undefined && ts.isVariableDeclaration(declaration) && localVariables.has(declaration);
    };
    const parsedObject = (expression: TS.Expression, seen = new Set<TS.Identifier>(), depth = 0): boolean => {
      if (depth >= 64) return false;
      const value = unwrap(ts, expression);
      if (!ts.isIdentifier(value)) return false;
      const binding = lexicalBinding(ts, value);
      if (binding === undefined || seen.has(binding)) return false;
      const declaration = binding.parent;
      if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) &&
          ts.isVariableDeclaration(declaration.parent.parent)) {
        const source = declaration.parent.parent;
        return source.initializer !== undefined && positionalParse(source.initializer);
      }
      if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined ||
          !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const) ||
          references(ts, fn, binding).some(reference => writtenThrough(ts, reference))) return false;
      return parsedObject(declaration.initializer, new Set(seen).add(binding), depth + 1);
    };
    const calls = (node: TS.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (ts.isIdentifier(node) && node.text === 'arguments' && lexicalBinding(ts, node) === undefined)
        unsupported = true;
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer !== undefined &&
          !positionalParse(node.initializer) && !parsedObject(node.initializer)) unsupported = true;
      // The admitted parser receives this method's request first and its schema
      // second. Arbitrary calls such as permission(user, board) do not make
      // every local second argument a potential contract declaration.
      if (ts.isCallExpression(node)) {
        // Argument packing hides both request and schema from positional proof.
        // Keep prior facts outside authority rather than treating this as absence.
        if (node.arguments.some(ts.isSpreadElement) ||
            (ts.isPropertyAccessExpression(node.expression) && ['apply', 'call'].includes(node.expression.name.text)))
          unsupported = true;
        const request = node.arguments[0] === undefined ? undefined : unwrap(ts, node.arguments[0]);
        const schema = node.arguments[1] === undefined ? undefined : unwrap(ts, node.arguments[1]);
        if (node.arguments.some(argument => requestDependent(argument))) {
          if (request === undefined || !requestParameters.some(parameter => transparentReference(ts, request, parameter) === true))
            unsupported = true;
          for (const argument of node.arguments) selectReferences(argument);
        }
        if (schema !== undefined && (signatureUnknown || (request !== undefined && requestParameters.some(parameter =>
            transparentReference(ts, request, parameter) !== false || references(ts, request, parameter).length > 0))))
          selectReferences(schema);
      }
      ts.forEachChild(node, calls);
    };
    calls(fn.body);
    for (const parameter of signatureUnknown ? requestParameters : requestParameters.slice(0, 1)) {
      for (const reference of references(ts, fn, parameter)) {
        const use = reference.parent;
        if (ts.isPropertyAccessExpression(use) && use.expression === reference &&
            ['url', 'method'].includes(use.name.text) && !writtenThrough(ts, reference)) continue;
        if (ts.isCallExpression(use) && use.arguments[0] === reference && use.arguments.length === 2) {
          const argument = use.arguments[1];
          const declaration = argument !== undefined && ts.isIdentifier(argument) ? lexicalBinding(ts, argument)?.parent : undefined;
          if (declaration !== undefined && ts.isVariableDeclaration(declaration) && localVariables.has(declaration)) continue;
        }
        // Container assignments and other request escapes can feed an opaque
        // parser even when a different local binding is fully supported.
        unsupported = true;
      }
    }
    // Failure to recognize any binding is not proof that this write handler
    // ceased validating. An opaque parser must not authorize deletion.
    if (selected.size === 0) unsupported = true;
    for (const schema of selected) {
      if (ts.isIdentifier(schema.name) && ts.isVariableDeclarationList(schema.parent) &&
          ts.isVariableStatement(schema.parent.parent) && schema.parent.parent.parent === fn.body) {
        candidates.push({ fn, schema });
        if (!(schema.parent.flags & ts.NodeFlags.Const)) unsupported = true;
      }
      else unsupported = true;
    }
  }
  return { candidates, unsupported };
}

function propertyFact(proof: LocalWriteProof, field: LocalWriteProof['fields'][number], table: WriteTable, project: WriteSource): PropertyFact {
  if (proof.persistence.purpose !== 'validated-write')
    throw new WriteUnknown('WRITE_IDENTITY_RESERVATION_IS_NOT_FACT');
  const knownString = field.length.state !== 'unknown';
  const witness = field.complete ? JSON.stringify({
    method: proof.method,
    parser: { file: proof.parser.file, declaration: proof.parser.functionName },
    persistence: { file: proof.persistence.file, declarations: proof.persistence.lexicalChain, operation: proof.persistence.operation },
    generator: project.rel(proof.persistence.client.lineage.generatedDirectory),
    extensions: proof.persistence.client.lineage.extensions,
    sourceBoundary: proof.persistence.client.sourceBoundary,
    ...(proof.persistence.client.cacheKey === undefined ? {} : { cacheKey: proof.persistence.client.cacheKey }),
    storageModel: proof.persistence.model.model,
    modelField: field.modelField,
    storageField: field.storageField,
    storageTable: table.id,
  }) : undefined;
  return {
    contract: proof.name,
    jsonPointer: `/properties/${field.name.replaceAll('~', '~0').replaceAll('/', '~1')}`,
    name: field.name,
    type: knownString ? 'string' : '',
    typeCategory: knownString ? 'text' : null,
    format: null,
    required: field.required,
    nullable: field.nullable,
    isArray: knownString ? false : null,
    hasDefault: knownString ? false : null,
    defaultValue: null,
    readOnly: false,
    writeOnly: false,
    deprecated: false,
    minLength: null,
    maxLength: field.length.state === 'bounded' ? field.length.maxLength : null,
    pattern: null,
    minimum: null,
    maximum: null,
    exclusiveMinimum: null,
    exclusiveMaximum: null,
    multipleOf: null,
    minItems: null,
    maxItems: null,
    enumValues: null,
    enumCount: null,
    in: null,
    description: null,
    file: proof.file,
    direction: 'request',
    lengthUpperState: field.length.state,
    writeBindingComplete: field.complete,
    successfulParse: true,
    unchangedForwarding: field.complete,
    modelBindingComplete: field.complete,
    ...(field.complete ? {
      valueRole: 'validated-write-input',
      storageModel: proof.persistence.model.model,
      storageField: field.storageField as string,
      storageTable: table.id,
      container: table.name,
      bindingWitness: witness as string,
    } : {}),
  };
}

export function extractValidatedWrites(options: ExtractOptions, limits: ExtractLimits, selected: readonly string[]): ValidatedWriteExtraction {
  const inventory = writeInventory(options.repoRoot, limits.maxFiles);
  const eligible = [...new Set([...inventory.files, ...selected].filter(isWriteRoute))].sort();
  const selectedFiles = new Set(selected);
  const contracts: ContractFact[] = [];
  const properties: PropertyFact[] = [];
  const diagnostics: string[] = [];
  const unvouched = new Set((inventory.unvouched ?? []).filter(path => selectedFiles.has(path) && isWriteRoute(path)));
  let originsComplete = true;
  try { assertInventoryScriptOrigins(options.repoRoot, limits, inventory); }
  catch (error) {
    if (!(error instanceof WriteUnknown)) throw error;
    originsComplete = false;
    diagnostics.push(error.message);
    for (const path of eligible) unvouched.add(path);
  }
  const sourceFiles = new Set<string>();
  const withheld: Array<{ name: string; file: string }> = [];
  let handlerFiles: ReadonlySet<string> = new Set(eligible);
  const singletons = new Map<string, string>();
  const completeNames = new Set<string>();
  const emitted = new Map<string, { readonly file: string; readonly declaration: number }>();
  const token = (file: string, declaration: number): string => JSON.stringify([file, declaration]);
  const ts = eligible.length === 0 ? null : defaultLoadTs();
  const typeScriptUnavailable = selected.some(isWriteRoute) && ts === null;
  if (inventory.explicitAuthorityOnly) diagnostics.push('WRITE_INVENTORY_INCOMPLETE: directory reads or the walk budget were incomplete; authority is limited to observed source files');
  if (typeScriptUnavailable) {
    diagnostics.push('WRITE_TYPESCRIPT_UNAVAILABLE: local write bindings cannot be read without the optional TypeScript peer');
    for (const path of eligible) unvouched.add(path);
  }
  if (ts !== null) {
    const reader = new WriteSource(ts, options.repoRoot, limits, inventory);
    const authorityInventory = inventoryWriteAuthority(reader, inventory, selected);
    handlerFiles = authorityInventory.handlerFiles;
    let models: ReturnType<typeof prismaWriteModels> | undefined;
    for (const path of eligible) {
      let file: TS.SourceFile;
      try { file = reader.parse(path, false); }
      catch (error) {
        if (!(error instanceof WriteUnknown)) throw error;
        unvouched.add(path);
        diagnostics.push(`${error.message}: ${path}`);
        continue;
      }
      const opaqueMethod = file.statements.some(statement =>
        (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(variable =>
          bindingNames(ts, variable.name).some(name => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(name)))) ||
        (ts.isExportDeclaration(statement) && (statement.exportClause === undefined ||
          (ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some(item => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(item.name.text))))));
      if (opaqueMethod) {
        unvouched.add(path);
        diagnostics.push(`WRITE_OPAQUE_METHOD_EXPORT: ${path}`);
      }
      const discovered = schemaCandidates(ts, file);
      if (discovered.unsupported) {
        unvouched.add(path);
        diagnostics.push(`WRITE_UNSUPPORTED_SCHEMA_DECLARATION: ${path}`);
      }
      for (const candidate of discovered.candidates) {
        const project = new WriteSource(ts, options.repoRoot, limits, inventory, reader);
        project.modules.set(file.fileName, file);
        try {
          models ??= prismaWriteModels(project);
          if (!originsComplete) throw new WriteUnknown('WRITE_EXECUTION_ORIGIN_UNKNOWN');
          const proof = proveLocalWrite(project, file, candidate.fn, candidate.schema, models);
          if (!proof.admitted) {
            withheld.push({ name: proof.name, file: path });
            unvouched.add(path);
            diagnostics.push(`WRITE_NO_COMPLETE_FIELD: ${path}`);
            continue;
          }
          if (!proof.identityComplete) {
            withheld.push({ name: proof.name, file: path });
            unvouched.add(path);
            diagnostics.push(`WRITE_STORAGE_IDENTITY_INCOMPLETE: ${path}`);
            continue;
          }
          // Only the complete source proof can discharge a possible key.
          // A names-only reservation below never discharges its unknown remainder.
          const declaration = candidate.schema.getStart(file);
          if (proof.identityComplete) {
            singletons.set(token(path, declaration), proof.name);
            completeNames.add(proof.name + '\0' + path);
          }
          if (!selectedFiles.has(path)) continue;
          let table: WriteTable;
          try { table = writeTableFromIndex(options.dataModelIndex, proof.persistence.model, options.repo, limits.maxFileBytes); }
          catch (error) {
            withheld.push({ name: proof.name, file: path });
            throw error;
          }
          contracts.push({ name: proof.name, dialect: 'zod', version: null, title: null, file: path });
          emitted.set(proof.name + '\0' + path, { file: path, declaration });
          for (const field of proof.fields) properties.push(propertyFact(proof, field, table, project));
          sourceFiles.add(path);
        } catch (error) {
          if (!(error instanceof WriteUnknown)) throw error;
          unvouched.add(path);
          diagnostics.push(`${error.message}: ${error.sourceRef ?? path}`);
          if (models !== undefined) {
            try {
              const reservation = proveLocalWrite(project, file, candidate.fn, candidate.schema, models, true);
              withheld.push({ name: reservation.name, file: path });
            } catch (reservationError) { if (!(reservationError instanceof WriteUnknown)) throw reservationError; }
          }
        }
      }
    }
    const ambiguous = new Set<string>();
    for (const contract of contracts) {
      const key = decodeWriteContractName(contract.name);
      const origin = emitted.get(contract.name + '\0' + contract.file);
      if (key === undefined || origin === undefined) throw new Error('missing complete write identity');
      const abstractKey = { owner: key[0], method: key[1][0] as string, schema: key[1][1] as string };
      if (!authorityInventory.complete || authorityInventory.slots.some(slot => {
        const singleton = slot.declaration === undefined ? undefined : singletons.get(token(slot.file, slot.declaration));
        if (singleton !== undefined) return singleton === contract.name &&
          (slot.file !== origin.file || slot.declaration !== origin.declaration);
        return couldShareWriteIdentity(slot, abstractKey);
      })) {
        ambiguous.add(contract.name);
        withheld.push({ name: contract.name, file: contract.file });
        unvouched.add(contract.file);
        diagnostics.push(`WRITE_IDENTITY_INVENTORY_COLLISION: ${contract.file}`);
      }
    }
    for (let i = contracts.length - 1; i >= 0; i--) if (ambiguous.has(contracts[i]!.name)) contracts.splice(i, 1);
    for (let i = properties.length - 1; i >= 0; i--) if (ambiguous.has(properties[i]!.contract)) properties.splice(i, 1);
    const surviving = new Set(contracts.map(contract => contract.file));
    for (const file of sourceFiles) if (!surviving.has(file)) sourceFiles.delete(file);
  }
  return { contracts, properties, diagnostics: [...new Set(diagnostics)].sort(), withheld, unvouched,
    sourceFiles, handlerFiles, sourceInventory: inventory,
    authorityCandidates: contracts.filter(contract => completeNames.has(contract.name + '\0' + contract.file))
      .map(({ name, file }) => ({ name, file })),
    explicitAuthorityOnly: inventory.explicitAuthorityOnly === true || !originsComplete, typeScriptUnavailable };
}
