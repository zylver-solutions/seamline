// SPDX-License-Identifier: Apache-2.0
/** Conservative possible identities, independent of parser-call recognition. */
import type * as TS from 'typescript';
import { WriteSource, WriteUnknown, type WriteInventory } from './write-source.ts';
import { rejectDynamicCode } from './write-syntax.ts';

const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const isWriteRoute = (path: string): boolean => /(?:^|\/)app\/(?:[^/]+\/)*route\.ts$/.test(path);

export interface WriteIdentitySlot {
  readonly file: string;
  /** Internal source correlation only, never an input to a fact's identity. */
  readonly declaration?: number;
  readonly owner?: string;
  readonly method?: string;
  readonly schema?: string;
}

export interface WriteAuthorityInventory {
  readonly handlerFiles: ReadonlySet<string>;
  readonly slots: readonly WriteIdentitySlot[];
  readonly complete: boolean;
}

function names(ts: typeof TS, name: TS.BindingName): string[] {
  return ts.isIdentifier(name) ? [name.text] : name.elements.flatMap(item =>
    ts.isBindingElement(item) ? names(ts, item.name) : []);
}

/** Scan the complete route inventory, including files not selected for emission. */
export function inventoryWriteAuthority(shared: WriteSource, inventory: WriteInventory,
  selected: readonly string[]): WriteAuthorityInventory {
  const ts = shared.ts;
  const handlerFiles = new Set<string>();
  const slots: WriteIdentitySlot[] = [];
  let complete = inventory.complete;
  const routes = [...new Set([...inventory.files, ...selected].filter(isWriteRoute))].sort();
  for (const path of routes) {
    const project = new WriteSource(ts, shared.root, shared.limits, inventory, shared);
    let file: TS.SourceFile;
    try { file = project.parse(path, false); project.count(file); }
    catch (error) {
      if (!(error instanceof WriteUnknown)) throw error;
      handlerFiles.add(path);
      slots.push({ file: path });
      complete = false;
      continue;
    }
    let owner: string | undefined;
    try { owner = project.owner(file).name; }
    catch (error) { if (!(error instanceof WriteUnknown)) throw error; }
    const reserve = (method?: string): void => {
      handlerFiles.add(path);
      slots.push({ file: path, ...(owner === undefined ? {} : { owner }), ...(method === undefined ? {} : { method }) });
    };
    for (const statement of file.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && METHODS.has(statement.name.text)) {
        const method = statement.name.text;
        handlerFiles.add(path);
        if (statement.body === undefined) { reserve(method); continue; }
        try { rejectDynamicCode(project, statement); }
        catch (error) {
          if (!(error instanceof WriteUnknown)) throw error;
          reserve(method);
          continue;
        }
        // Opaque parsers can hide a schema behind aliases, property reads or
        // helpers. Every named variable remains a possible retained key.
        const visit = (node: TS.Node): void => {
          if (ts.isTypeNode(node)) return;
          if (ts.isVariableDeclaration(node)) for (const schema of names(ts, node.name)) {
            slots.push({ file: path, declaration: node.getStart(file), method, schema,
              ...(owner === undefined ? {} : { owner }) });
          }
          ts.forEachChild(node, visit);
        };
        visit(statement.body);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          for (const method of names(ts, declaration.name)) if (METHODS.has(method)) reserve(method);
      } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        if (statement.exportClause === undefined) reserve();
        else if (ts.isNamedExports(statement.exportClause)) {
          for (const item of statement.exportClause.elements)
            if (!item.isTypeOnly && METHODS.has(item.name.text)) reserve(item.name.text);
        } else if (METHODS.has(statement.exportClause.name.text)) reserve(statement.exportClause.name.text);
      } else if (ts.isExportAssignment(statement) ||
          (ts.isExpressionStatement(statement) && !ts.isStringLiteral(statement.expression))) {
        // Unknown export mutation cannot certify that a previous handler vanished.
        reserve();
      } else if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
        const name = (statement as TS.Statement & { readonly name?: TS.Node }).name;
        if (name !== undefined && ts.isIdentifier(name) && METHODS.has(name.text)) reserve(name.text);
      }
    }
  }
  return { handlerFiles, slots, complete };
}

/** A failed proof's recognizable name never discharges its unknown remainder. */
export function couldShareWriteIdentity(slot: WriteIdentitySlot,
  key: { readonly owner: string; readonly method: string; readonly schema: string }): boolean {
  return (slot.owner === undefined || slot.owner === key.owner) &&
    (slot.method === undefined || slot.method === key.method) &&
    (slot.schema === undefined || slot.schema === key.schema);
}
