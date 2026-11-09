/**
 * Canonical-declaration resolution.
 *
 * This is the property v3 §2.1's identity design was written for and the reason `ts-morph` is
 * a justified dependency: a symbol reachable through a barrel, a re-export, and
 * a direct import is **one** symbol, not three. Resolve by module specifier and
 * `User` from `index.ts` and `User` from `models/user.ts` become separate nodes,
 * every downstream count is inflated, and the field-level join double-reports.
 *
 * The rule applied everywhere below: never take the symbol at the use site;
 * walk its alias chain to the declaration, and identify the declaration by the
 * `{module}#{chain}` canonical name computed in `symbols.ts`.
 */

import { Node, SyntaxKind, ts } from 'ts-morph';
import type { Symbol as TsSymbol, Type } from 'ts-morph';
import type { Ctx, DeclRecord } from './context.ts';
import { declKey } from './context.ts';

/** Alias chains are short in practice; the bound stops a pathological cycle. */
const MAX_ALIAS_HOPS = 32;

/**
 * Walk an alias chain to the symbol that actually declares the entity.
 *
 * `export { User } from './user.ts'` creates an alias symbol in the barrel.
 * Without this walk, that alias is a distinct symbol with its own declaration
 * (the export specifier) in the barrel's file.
 */
export function unaliasSymbol(symbol: TsSymbol): TsSymbol {
  let current = symbol;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
    if ((current.getFlags() & ts.SymbolFlags.Alias) === 0) return current;
    const next = current.getAliasedSymbol();
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Declaration nodes for the entity a node refers to, alias-resolved.
 *
 * Returns every declaration because TypeScript declaration merging is real: an
 * `interface` reopened in two files is one entity with two declarations, and
 * collapsing it to the first would silently drop half its fields.
 */
export function resolveDeclarations(node: Node): readonly Node[] {
  const symbol = node.getSymbol();
  if (symbol === undefined) return [];
  const declared = unaliasSymbol(symbol).getDeclarations();
  if (declared.length > 0) return declared;
  if (Node.isIdentifier(node)) {
    // Fallback for cases the symbol table does not carry (some JS shapes).
    return node.getDefinitionNodes();
  }
  return [];
}

/**
 * The `DeclRecord` for the canonical declaration of whatever `node` refers to.
 *
 * When merging produced several declarations, the one with the smallest
 * canonical name wins — a total order over the names themselves, so the answer
 * does not depend on which file the walker reached first.
 */
export function resolveDeclRecord(ctx: Ctx, node: Node): DeclRecord | undefined {
  const records: DeclRecord[] = [];
  for (const decl of resolveDeclarations(node)) {
    const record = ctx.decls.get(declKey(decl));
    if (record !== undefined) records.push(record);
  }
  if (records.length === 0) return undefined;
  records.sort((a, b) => (a.canonicalName < b.canonicalName ? -1 : a.canonicalName > b.canonicalName ? 1 : 0));
  return records[0];
}

/** Resolve to a declaration that is a `Symbol` node, ignoring fields and parameters. */
export function resolveSymbolRecord(ctx: Ctx, node: Node): DeclRecord | undefined {
  const record = resolveDeclRecord(ctx, node);
  return record !== undefined && record.kind === 'Symbol' ? record : undefined;
}

/**
 * Every in-project `Symbol` a type expression names.
 *
 * Walks the *syntactic* type node rather than the checker's structural type:
 * `Promise<User[]>` must yield `User`, and the structural type of that
 * expression names `Promise` and `Array` from the standard library, neither of
 * which is in this repo. The type nodes are also what survive a `git mv`
 * unchanged, which the structural text does not.
 */
export function referencedTypeSymbols(ctx: Ctx, typeNode: Node | undefined): readonly DeclRecord[] {
  if (typeNode === undefined) return [];
  const found = new Map<string, DeclRecord>();
  const candidates: Node[] = [];
  if (typeNode.getKind() === SyntaxKind.TypeReference) candidates.push(typeNode);
  candidates.push(...typeNode.getDescendantsOfKind(SyntaxKind.TypeReference));
  candidates.push(...typeNode.getDescendantsOfKind(SyntaxKind.ExpressionWithTypeArguments));
  for (const candidate of candidates) {
    const name = Node.isTypeReference(candidate)
      ? candidate.getTypeName()
      : Node.isExpressionWithTypeArguments(candidate)
        ? candidate.getExpression()
        : undefined;
    if (name === undefined) continue;
    const record = resolveSymbolRecord(ctx, leftmostIdentifier(name));
    if (record !== undefined) found.set(record.canonicalName, record);
  }
  return [...found.values()].sort((a, b) =>
    a.canonicalName < b.canonicalName ? -1 : a.canonicalName > b.canonicalName ? 1 : 0,
  );
}

/**
 * In-project symbols named by a *checked* type, for declarations with no type
 * annotation.
 *
 * `private readonly service = new UserService()` has no type node, and dropping
 * it would lose the field's type for the join — which is most fields in an
 * idiomatic TypeScript service class. Bounded depth because a generic type can
 * be arbitrarily deep and a recursive one is unbounded.
 */
export function inferredTypeSymbols(ctx: Ctx, type: Type, enclosing: Node, depth = 2): readonly DeclRecord[] {
  const found = new Map<string, DeclRecord>();
  collectTypeSymbols(ctx, type, enclosing, depth, found, new Set<Type>());
  return [...found.values()].sort((a, b) =>
    a.canonicalName < b.canonicalName ? -1 : a.canonicalName > b.canonicalName ? 1 : 0,
  );
}

function collectTypeSymbols(
  ctx: Ctx,
  type: Type,
  enclosing: Node,
  depth: number,
  found: Map<string, DeclRecord>,
  seen: Set<Type>,
): void {
  if (depth < 0 || seen.has(type)) return;
  seen.add(type);
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  if (symbol !== undefined) {
    for (const decl of unaliasSymbol(symbol).getDeclarations()) {
      const record = ctx.decls.get(declKey(decl));
      if (record !== undefined && record.kind === 'Symbol') found.set(record.canonicalName, record);
    }
  }
  const children = [
    ...type.getTypeArguments(),
    ...type.getAliasTypeArguments(),
    ...(type.isUnion() ? type.getUnionTypes() : []),
    ...(type.isIntersection() ? type.getIntersectionTypes() : []),
  ];
  const element = type.getArrayElementType();
  if (element !== undefined) children.push(element);
  for (const child of children) collectTypeSymbols(ctx, child, enclosing, depth - 1, found, seen);
}

/** `A.B.C` resolves through its leftmost identifier when the whole name has no symbol. */
function leftmostIdentifier(node: Node): Node {
  if (node.getSymbol() !== undefined) return node;
  if (Node.isQualifiedName(node)) return leftmostIdentifier(node.getLeft());
  if (Node.isPropertyAccessExpression(node)) return leftmostIdentifier(node.getExpression());
  return node;
}

/**
 * Checker type text for a declaration, with the enclosing node supplied so the
 * checker prints the short form. Falls back to `unknown` rather than throwing:
 * a circular or unresolvable type is a fact about the code, not a crash.
 */
export function safeTypeText(type: Type, enclosing: Node): string {
  try {
    return type.getText(enclosing, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType);
  } catch {
    return 'unknown';
  }
}
