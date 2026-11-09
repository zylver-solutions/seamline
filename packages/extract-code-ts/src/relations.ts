/**
 * Pass two: relationships.
 *
 * Every edge here resolves its endpoint through `resolve.ts` rather than by
 * name, so a reference reaching a symbol through a barrel lands on the same
 * node as a direct import. Edges whose endpoint is outside the project (a
 * `CALLS` into `node_modules`, an `EXTENDS` of a `.d.ts` class) are simply not
 * emitted: this extractor is authoritative for this repo's code and nothing
 * else, and inventing a node for a dependency would claim authority it does
 * not have.
 */

import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, Decorator, NewExpression, SourceFile } from 'ts-morph';
import type { NodeId } from '@seamline/ontology';
import { routeCanonicalName, routeHandlerId, symbolCanonicalName, symbolId } from './canonical.ts';
import type { Ctx, DeclRecord, FileRecord, ModuleImport } from './context.ts';
import { declKey } from './context.ts';
import { mergeImportFacts, mergeModuleImports } from './imports.ts';
import type { ImportFact } from './imports.ts';
import { sourceRef } from './paths.ts';
import { isServerReceiver } from './receiver.ts';
import { inferredTypeSymbols, referencedTypeSymbols, resolveSymbolRecord } from './resolve.ts';
import {
  decoratorHttpMethod, isRouteLiteral, isRouterMethod, joinRoute, normalizeRoutePath,
} from './routes.ts';
import { addQuery, queryEdges } from './queries.ts';
import { classifyRawSql, mayBeSql } from './raw-sql.ts';
import { sqlText } from './sql.ts';
import {
  importsQueryBuilder, noteLiteral, noteSplicedFragments, noteUnknownWriter, scanRuntimeDdl, scanWriteCall,
} from './write-guards.ts';

/** Confidence for an edge whose endpoint binding is heuristic rather than checked. */
const HEURISTIC_CONFIDENCE = 0.7;

/** Relate declarations to one another: heritage, types, decorators. */
export function relateDeclarations(ctx: Ctx): void {
  const records = [...ctx.decls.values()].sort((a, b) =>
    a.canonicalName < b.canonicalName ? -1 : a.canonicalName > b.canonicalName ? 1 : 0,
  );
  for (const record of records) relateOne(ctx, record);
}

function relateOne(ctx: Ctx, record: DeclRecord): void {
  const decl = record.declaration;

  if (Node.isClassDeclaration(decl)) {
    const base = decl.getExtends();
    if (base !== undefined) link(ctx, record, 'EXTENDS', base.getExpression());
    for (const impl of decl.getImplements()) link(ctx, record, 'IMPLEMENTS', impl.getExpression());
    decorate(ctx, record, decl.getDecorators());
    return;
  }

  if (Node.isInterfaceDeclaration(decl)) {
    for (const base of decl.getExtends()) link(ctx, record, 'EXTENDS', base.getExpression());
    return;
  }

  if (Node.isTypeAliasDeclaration(decl)) {
    usesType(ctx, record, decl.getTypeNode());
    return;
  }

  if (Node.isPropertyDeclaration(decl) || Node.isPropertySignature(decl)) {
    const typeNode = decl.getTypeNode();
    if (typeNode === undefined) inferUsesType(ctx, record, decl);
    else usesType(ctx, record, typeNode);
    if (Node.isPropertyDeclaration(decl)) decorate(ctx, record, decl.getDecorators());
    return;
  }

  if (Node.isGetAccessorDeclaration(decl)) {
    usesType(ctx, record, decl.getReturnTypeNode());
    decorate(ctx, record, decl.getDecorators());
    return;
  }

  if (Node.isParameterDeclaration(decl)) {
    const typeNode = decl.getTypeNode();
    if (typeNode === undefined) inferUsesType(ctx, record, decl);
    else usesType(ctx, record, typeNode);
    return;
  }

  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl) || Node.isMethodSignature(decl)) {
    usesType(ctx, record, decl.getReturnTypeNode());
    if (Node.isMethodDeclaration(decl)) {
      decorate(ctx, record, decl.getDecorators());
      decoratorRoutes(ctx, record, decl);
    }
    return;
  }

  if (Node.isVariableDeclaration(decl)) {
    usesType(ctx, record, decl.getTypeNode());
  }
}

function link(ctx: Ctx, from: DeclRecord, kind: 'EXTENDS' | 'IMPLEMENTS', target: Node): void {
  const to = resolveSymbolRecord(ctx, target);
  if (to === undefined || to.id === from.id) return;
  ctx.collector.edge({
    kind, src: from.id, dst: to.id, srcFile: from.file, dstFile: to.file,
  });
}

/** `USES_TYPE` from the checked type, for a declaration with no annotation. */
function inferUsesType(ctx: Ctx, from: DeclRecord, decl: Node): void {
  let inferred: readonly DeclRecord[];
  try {
    inferred = inferredTypeSymbols(ctx, decl.getType(), decl);
  } catch {
    return;
  }
  for (const target of inferred) {
    if (target.id === from.id) continue;
    ctx.collector.edge({
      kind: 'USES_TYPE', src: from.id, dst: target.id, srcFile: from.file, dstFile: target.file,
      props: { inferredFromChecker: true },
    });
  }
}

function usesType(ctx: Ctx, from: DeclRecord, typeNode: Node | undefined): void {
  for (const target of referencedTypeSymbols(ctx, typeNode)) {
    if (target.id === from.id) continue;
    ctx.collector.edge({
      kind: 'USES_TYPE', src: from.id, dst: target.id, srcFile: from.file, dstFile: target.file,
    });
  }
}

/**
 * `DECORATED_WITH` only fires for a decorator declared in this repo. A NestJS
 * `@Injectable()` resolves into `node_modules`, so the name is recorded as a
 * node property instead — a fact this extractor can stand behind, unlike an
 * edge to a node it would have to invent.
 */
function decorate(ctx: Ctx, from: DeclRecord, decorators: readonly Decorator[]): void {
  for (const decorator of decorators) {
    const target = resolveSymbolRecord(ctx, decorator.getNameNode());
    if (target === undefined || target.id === from.id) continue;
    ctx.collector.edge({
      kind: 'DECORATED_WITH', src: from.id, dst: target.id, srcFile: from.file, dstFile: target.file,
    });
  }
}

/* -------------------------------------------------------- per-file scanning */

/**
 * Imports, exports, calls, routes, and queries for one source file. Module-level
 * `IMPORTS` are only accumulated here: run `emitModuleImports` after the last file.
 */
export function relateFile(ctx: Ctx, sf: SourceFile, file: FileRecord): void {
  relateImports(ctx, sf, file);
  relateExports(ctx, sf, file);
  scanBodies(ctx, sf, file);
}

/**
 * `IMPORTS` from one file. A file can reach the same target through several
 * `import` and `export ... from` declarations but owns one edge per target, and
 * the collector keeps whichever write came last. So the declarations are folded
 * here first (see `imports.ts`), and exactly one edge per target is emitted,
 * whatever order the statements are written in.
 */
function relateImports(ctx: Ctx, sf: SourceFile, file: FileRecord): void {
  const byTarget = new Map<NodeId, { readonly to: FileRecord; fact: ImportFact }>();
  const note = (target: SourceFile, fact: ImportFact): void => {
    const to = ctx.files.get(target.getFilePath());
    if (to === undefined || to.id === file.id) return;
    const seen = byTarget.get(to.id);
    byTarget.set(to.id, { to, fact: seen === undefined ? fact : mergeImportFacts(seen.fact, fact) });
  };

  for (const imp of sf.getImportDeclarations()) {
    const target = imp.getModuleSpecifierSourceFile();
    if (target !== undefined) {
      note(target, { specifier: imp.getModuleSpecifierValue(), typeOnly: imp.isTypeOnly(), reExport: false });
    }
  }
  for (const exp of sf.getExportDeclarations()) {
    const target = exp.getModuleSpecifierSourceFile();
    const specifier = exp.getModuleSpecifierValue();
    if (target !== undefined && specifier !== undefined) {
      note(target, { specifier, typeOnly: exp.isTypeOnly(), reExport: true });
    }
  }

  for (const id of [...byTarget.keys()].sort()) {
    const entry = byTarget.get(id);
    if (entry === undefined) continue;
    const { to, fact } = entry;
    ctx.collector.edge({
      kind: 'IMPORTS', src: file.id, dst: to.id, srcFile: file.rel, dstFile: to.rel,
      props: { specifier: fact.specifier, typeOnly: fact.typeOnly, reExport: fact.reExport },
    });
    if (to.moduleId !== file.moduleId) noteModuleImport(ctx, file, to, fact.specifier);
  }
}

/**
 * Record one file-level import as crossing a module boundary. Many files fold
 * into a single module-to-module edge, so this only accumulates; the edge is
 * emitted by `emitModuleImports` once every file has been scanned, after which
 * the order the files were walked in can no longer show in the result.
 */
function noteModuleImport(ctx: Ctx, from: FileRecord, to: FileRecord, specifier: string): void {
  const key = `${from.moduleId} ${to.moduleId}`;
  const next: ModuleImport = {
    src: from.moduleId, dst: to.moduleId, srcFile: from.rel, dstFile: to.rel, specifier,
  };
  const seen = ctx.moduleImports.get(key);
  ctx.moduleImports.set(key, seen === undefined ? next : mergeModuleImports(seen, next));
}

/** Emit the module-level `IMPORTS` edges accumulated while scanning files. Call once, after the last file. */
export function emitModuleImports(ctx: Ctx): void {
  for (const key of [...ctx.moduleImports.keys()].sort()) {
    const edge = ctx.moduleImports.get(key);
    if (edge === undefined) continue;
    ctx.collector.edge({
      kind: 'IMPORTS', src: edge.src, dst: edge.dst, srcFile: edge.srcFile, dstFile: edge.dstFile,
      props: { specifier: edge.specifier },
    });
  }
  ctx.moduleImports.clear();
}

/**
 * `EXPORTS` uses ts-morph's `getExportedDeclarations`, which is the barrel
 * resolution itself: `export { User } from './user.ts'` yields the
 * `ClassDeclaration` in `user.ts`, not the export specifier in the barrel. Both
 * the barrel file and the declaring file therefore export the *same* Symbol
 * node, which is the identity property this project requires (v3 §2.1) and the
 * reason a re-exported symbol is counted once.
 */
function relateExports(ctx: Ctx, sf: SourceFile, file: FileRecord): void {
  let exported: ReadonlyMap<string, readonly Node[]>;
  try {
    exported = sf.getExportedDeclarations();
  } catch (error) {
    ctx.diagnostics.push(`export resolution failed for ${file.rel}: ${messageOf(error)}`);
    return;
  }
  const isEntry = file.module.entry === file.rel;
  for (const name of [...exported.keys()].sort()) {
    for (const decl of exported.get(name) ?? []) {
      const record = ctx.decls.get(declKey(decl));
      if (record === undefined || record.kind !== 'Symbol') continue;
      ctx.collector.edge({
        kind: 'EXPORTS', src: file.id, dst: record.id, srcFile: file.rel, dstFile: record.file,
        props: { exportName: name, reExport: record.file !== file.rel },
      });
      if (isEntry) {
        ctx.collector.edge({
          kind: 'EXPORTS', src: file.moduleId, dst: record.id, srcFile: file.rel, dstFile: record.file,
          props: { exportName: name },
        });
      }
    }
  }
}

function scanBodies(ctx: Ctx, sf: SourceFile, file: FileRecord): void {
  scanRuntimeDdl(ctx, file.rel, sf);
  // The calls come first: a call that rule (1) counts claims its argument, so a literal inside it
  // is not counted a second time when the literals are read below.
  ctx.guards.excluded = [];
  const builderFile = importsQueryBuilder(sf);
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    emitCall(ctx, file, call);
    emitRouterRoute(ctx, file, call);
    scanWriteCall(ctx, file.rel, call, builderFile);
  }
  for (const expr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    emitNew(ctx, file, expr);
  }
  for (const kind of [SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral] as const) {
    for (const literal of sf.getDescendantsOfKind(kind)) {
      emitQueries(ctx, file, literal, [literal.getLiteralText()], false);
    }
  }
  for (const template of sf.getDescendantsOfKind(SyntaxKind.TemplateExpression)) {
    // The template's own literal text, a sentinel for each substitution. Never `getText()`,
    // which starts with the backtick and so is never a statement; and the substitutions are
    // not read, so nothing inside `${...}` can change the result. A template nested in a
    // substitution is a separate node and is read on its own.
    const parts = [
      template.getHead().getLiteralText(),
      ...template.getTemplateSpans().map((span) => span.getLiteral().getLiteralText()),
    ];
    emitQueries(ctx, file, template, parts, true);
  }
}

function emitCall(ctx: Ctx, file: FileRecord, call: CallExpression): void {
  const caller = enclosingSymbol(ctx, call);
  if (caller === undefined) return;
  const callee = resolveSymbolRecord(ctx, call.getExpression());
  if (callee === undefined || callee.id === caller.id) return;
  ctx.collector.edge({
    kind: 'CALLS', src: caller.id, dst: callee.id, srcFile: file.rel, dstFile: callee.file,
    sourceRef: sourceRef(file.rel, call.getStartLineNumber()),
  });
}

function emitNew(ctx: Ctx, file: FileRecord, expr: NewExpression): void {
  const caller = enclosingSymbol(ctx, expr);
  if (caller === undefined) return;
  const callee = resolveSymbolRecord(ctx, expr.getExpression());
  if (callee === undefined || callee.id === caller.id) return;
  ctx.collector.edge({
    kind: 'CALLS', src: caller.id, dst: callee.id, srcFile: file.rel, dstFile: callee.file,
    sourceRef: sourceRef(file.rel, expr.getStartLineNumber()),
    props: { construct: true },
  });
}

/* ------------------------------------------------------------------- routes */

/**
 * A router-style call is a route only when its receiver is a server router or
 * app (`isServerReceiver`). The method name and a `/`-prefixed literal are the
 * shape of a registration, not evidence of one: `api.get('/users')` on an HTTP
 * client has both.
 */
function emitRouterRoute(ctx: Ctx, file: FileRecord, call: CallExpression): void {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return;
  const method = callee.getName();
  if (!isRouterMethod(method)) return;
  const args = call.getArguments();
  const first = args[0];
  if (first === undefined || !Node.isStringLiteral(first)) return;
  const literal = first.getLiteralText();
  if (!isRouteLiteral(literal)) return;
  if (!isServerReceiver(callee.getExpression())) return;

  const routePath = normalizeRoutePath(literal);
  const routeId = emitRouteNode(ctx, file, method.toUpperCase(), routePath, 'router-call', call.getStartLineNumber());

  const handler = handlerSymbol(ctx, args.slice(1)) ?? enclosingSymbol(ctx, call);
  const src = handler ?? synthesizeHandler(ctx, file, callee, method.toUpperCase(), routePath, call.getStartLineNumber());
  ctx.collector.edge({
    kind: 'HANDLES_ROUTE', src: src.id, dst: routeId, srcFile: file.rel, dstFile: file.rel,
    sourceRef: sourceRef(file.rel, call.getStartLineNumber()),
    ...(handler === undefined ? { confidence: HEURISTIC_CONFIDENCE } : {}),
  });
}

function handlerSymbol(ctx: Ctx, args: readonly Node[]): DeclRecord | undefined {
  for (const arg of args) {
    if (!Node.isIdentifier(arg) && !Node.isPropertyAccessExpression(arg)) continue;
    const record = resolveSymbolRecord(ctx, arg);
    if (record !== undefined) return record;
  }
  return undefined;
}

/**
 * A top-level `app.get('/x', (req, res) => …)` has no enclosing declared
 * symbol. Rather than drop the edge, mint a Symbol named after the router
 * variable and the route. It has the usual `{module}#{chain}` shape and no part
 * of it is a file path, so it is stable under a file rename within a package
 * and changes with the package like any other Symbol (ADR-0016).
 */
function synthesizeHandler(
  ctx: Ctx,
  file: FileRecord,
  callee: Node,
  method: string,
  routePath: string,
  line: number,
): DeclRecord {
  const receiver = Node.isPropertyAccessExpression(callee) ? callee.getExpression().getText() : 'router';
  const routerName = /^[A-Za-z_$][\w$]*$/.test(receiver) ? receiver : 'router';
  const chain = [routerName, routeCanonicalName(method, routePath)];
  const canonicalName = symbolCanonicalName(file.module.name, chain);
  const id = symbolId(ctx.repo, canonicalName);
  ctx.collector.node({
    id,
    kind: 'Symbol',
    name: chain[1] ?? routePath,
    path: file.rel,
    sourceRef: sourceRef(file.rel, line),
    confidence: HEURISTIC_CONFIDENCE,
    props: {
      symbolKind: 'route-handler',
      module: file.module.name,
      qualifiedName: chain.join('.'),
      inline: true,
    },
  });
  ctx.collector.edge({ kind: 'CONTAINS', src: file.id, dst: id, srcFile: file.rel, dstFile: file.rel });
  return { id, canonicalName, kind: 'Symbol', file: file.rel, declaration: callee };
}

function decoratorRoutes(ctx: Ctx, record: DeclRecord, decl: Node): void {
  if (!Node.isMethodDeclaration(decl)) return;
  const owner = decl.getParent();
  if (!Node.isClassDeclaration(owner)) return;
  const base = controllerBasePath(owner);
  for (const decorator of decl.getDecorators()) {
    const method = decoratorHttpMethod(decorator.getName());
    if (method === null) continue;
    const sub = firstStringArgument(decorator) ?? '';
    const routePath = base === null ? normalizeRoutePath(sub) : joinRoute(base, sub);
    const file = ctx.files.get(decl.getSourceFile().getFilePath());
    if (file === undefined) continue;
    const routeId = emitRouteNode(ctx, file, method, routePath, 'decorator', decl.getStartLineNumber());
    ctx.collector.edge({
      kind: 'HANDLES_ROUTE', src: record.id, dst: routeId, srcFile: record.file, dstFile: file.rel,
      sourceRef: sourceRef(file.rel, decl.getStartLineNumber()),
    });
  }
}

function controllerBasePath(cls: Node): string | null {
  if (!Node.isClassDeclaration(cls)) return null;
  for (const decorator of cls.getDecorators()) {
    if (decorator.getName() !== 'Controller') continue;
    return normalizeRoutePath(firstStringArgument(decorator) ?? '');
  }
  return null;
}

function firstStringArgument(decorator: Decorator): string | null {
  for (const arg of decorator.getArguments()) {
    if (Node.isStringLiteral(arg)) return arg.getLiteralText();
  }
  return null;
}

function emitRouteNode(
  ctx: Ctx,
  file: FileRecord,
  method: string,
  routePath: string,
  style: string,
  line: number,
): NodeId {
  const canonicalName = routeCanonicalName(method, routePath);
  const id = routeHandlerId(ctx.repo, canonicalName);
  ctx.collector.node({
    id,
    kind: 'RouteHandler',
    name: canonicalName,
    path: file.rel,
    sourceRef: sourceRef(file.rel, line),
    props: { method, routePath, style },
  });
  return id;
}

/* ------------------------------------------------------------------ queries */

/**
 * Read one literal as SQL and fold what it says into the (symbol, table) edges.
 * `parts` are the literal's own text: one part for a string or a template with
 * no substitution, the head and the text of each span for a template with some
 * (`interpolated`). The edges themselves are emitted by `emitQueryEdges` once
 * every file has been read, so the order literals are visited in cannot show.
 */
function emitQueries(
  ctx: Ctx,
  file: FileRecord,
  node: Node,
  parts: readonly string[],
  interpolated: boolean,
): void {
  const text = sqlText(parts);
  // A fragment spliced into the verb position leaves no statement verb at the start of the text.
  if (interpolated) noteSplicedFragments(ctx, file.rel, node, text);
  // Most literals hold no statement verb at all; they cost one pattern test, not a walk up the tree.
  if (!mayBeSql(text)) return;
  const concatenated = isConcatenated(node);
  const reading = classifyRawSql(text, { concatenated });
  if (reading.unattributed.includes('resource-limit')) {
    const held = ctx.sqlResourceLimit.site;
    const line = node.getStartLineNumber();
    if (held === null || file.rel < held.file || (file.rel === held.file && line < held.line)) {
      ctx.sqlResourceLimit.site = { file: file.rel, line };
    }
  }
  noteLiteral(ctx, file.rel, node, text, reading, concatenated, interpolated);
  if (reading.calls.length === 0) return;
  if (ctx.bindTable === null) noteRawSql(ctx, file.rel, node.getStartLineNumber());
  const caller = enclosingSymbol(ctx, node);
  if (caller === undefined) return;
  for (const call of reading.calls) {
    const binding = ctx.bindTable === null ? undefined : ctx.bindTable(call.table);
    if (binding?.kind === 'ambiguous') {
      // Which table the statement means is not in the code, so there is no edge,
      // and the tables it may mean are recorded as written by something unseen.
      for (const name of binding.tables) {
        noteUnknownWriter(ctx, name, file.rel, node.getStartLineNumber(), 'ambiguous');
      }
      continue;
    }
    // A name only another schema declares keeps the name-only edge below, and
    // the real table is recorded as written by something unseen, so that a
    // detector over it withholds instead of trusting "no traced write".
    if (binding?.kind === 'elsewhere') {
      for (const name of binding.tables) {
        noteUnknownWriter(ctx, name, file.rel, node.getStartLineNumber(), 'elsewhere');
      }
    }
    // A name no declared table matches keeps the answer the extractor always
    // gave, so the edge still points at an external `Table` node.
    const table = binding?.kind === 'bound' ? binding.id : ctx.tableId(call.table);
    ctx.collector.external(table, 'Table');
    addQuery(ctx.queries, {
      src: caller.id,
      dst: table,
      file: file.rel,
      line: node.getStartLineNumber(),
      confidence: HEURISTIC_CONFIDENCE,
      interpolated,
      call,
    });
  }
}

/** One `QUERIES` edge per (symbol, table), after every literal of every file has been folded. */
export function emitQueryEdges(ctx: Ctx): void {
  for (const edge of queryEdges(ctx.queries)) ctx.collector.edge(edge);
  ctx.queries.clear();
}

/**
 * Whether the literal is an operand of `+` (or the right side of `+=`), looking
 * through parentheses and type assertions. Such a statement may be longer than
 * the literal, so none of its column sets can be called complete.
 */
function isConcatenated(node: Node): boolean {
  let current: Node = node;
  for (;;) {
    const parent = current.getParent();
    if (parent === undefined) return false;
    if (
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isSatisfiesExpression(parent) ||
      Node.isNonNullExpression(parent)
    ) {
      current = parent;
      continue;
    }
    if (!Node.isBinaryExpression(parent)) return false;
    const operator = parent.getOperatorToken().getKind();
    return operator === SyntaxKind.PlusToken || operator === SyntaxKind.PlusEqualsToken;
  }
}

/**
 * Keeps the first raw-SQL reference of the run, in code-unit order of file and then line, so the
 * diagnostic that names it does not depend on the order files were walked in.
 */
function noteRawSql(ctx: Ctx, file: string, line: number): void {
  const held = ctx.firstRawSql.site;
  if (held === null || file < held.file || (file === held.file && line < held.line)) {
    ctx.firstRawSql.site = { file, line };
  }
}

/* ------------------------------------------------------------------- shared */

/** Nearest ancestor that was declared as a `Symbol` in pass one. */
function enclosingSymbol(ctx: Ctx, node: Node): DeclRecord | undefined {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    const record = ctx.decls.get(declKey(current));
    if (record !== undefined && record.kind === 'Symbol') return record;
    current = current.getParent();
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
