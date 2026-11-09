/**
 * Whether the receiver of a router-style call is a server router or app.
 *
 * `x.get('/users')` has the same shape whether `x` is an Express app or an HTTP
 * client, so the call alone proves nothing. `routes.ts` therefore asks this
 * module for positive evidence about `x` before it records a route, and a call
 * with no such evidence is not a route. A missed route is a scope gap; an
 * invented one is a false fact that the contract-drift detector would report
 * as an undeclared endpoint.
 *
 * Evidence, in the order it is tried. The first two need no installed
 * dependency, so the answer does not change with whether `node_modules` is
 * present on the machine that ran the extraction:
 *
 *  1. **Construction.** The receiver was built by a factory or constructor
 *     imported from a supported server framework: `express()`,
 *     `express.Router()`, `Router()`, `Fastify()`, `new Hono()`, `new Elysia()`.
 *     The receiver may be a variable, an import of a variable declared in
 *     another project file, a property, or a builder chain on any of those
 *     (`new Hono().basePath('/v1')`, `app.use(mw)`).
 *  2. **Declaration.** The receiver is declared with a server type, such as
 *     `app: Express` or `fastify: FastifyInstance`. A type imported from a
 *     package other than a supported framework does not count, however it is
 *     named: a client SDK's own `Router` type is not a server.
 *  3. **Checked type.** When the packages are installed, the checker's type for
 *     the receiver is a server type declared by a supported framework package or
 *     by this project. This is what covers a contextually typed parameter, such
 *     as the `instance` of a Fastify plugin.
 *
 * Not recognised, and so not extracted: a receiver whose declaration cannot be
 * traced (an untyped parameter, a destructured binding, a value returned by a
 * project helper while the framework is not installed) and any framework not
 * listed here. NestJS controllers are decorator routes and do not pass through
 * this module.
 *
 * A handler argument is deliberately not part of the rule. It cannot separate
 * a server from a client (`$.get('/users', (data) => ...)` passes a function),
 * and Elysia accepts a plain value as a handler.
 */

import { Node, SyntaxKind } from 'ts-morph';
import type { SourceFile, Type } from 'ts-morph';
import { unaliasSymbol } from './resolve.ts';
import { packageName } from './validation.ts';

/** Frameworks whose routers and apps are recognised, by npm package name. */
const SERVER_FRAMEWORKS: ReadonlySet<string> = new Set([
  '@koa/router',
  'elysia',
  'express',
  'fastify',
  'hono',
  'koa-router',
]);

/** Names those frameworks give the type of an app or router instance. */
const SERVER_TYPE_NAMES: ReadonlySet<string> = new Set([
  'Application',
  'Elysia',
  'Express',
  'FastifyInstance',
  'Hono',
  'IRouter',
  'Router',
]);

/** Where an installed framework's declarations live, including the `@types` packages. */
const SERVER_PACKAGE_PATH =
  /\/node_modules\/(?:@types\/)?(?:@koa\/router|elysia|express|express-serve-static-core|fastify|hono|koa-router|koa__router)\//;

/** Bound on declarations followed per call, so a cyclic or very deep chain cannot stall extraction. */
const MAX_STEPS = 64;

interface Walk {
  readonly seen: Set<Node>;
  steps: number;
}

/** True when `receiver`, the expression before `.get`/`.post`/..., is a server router or app. */
export function isServerReceiver(receiver: Node): boolean {
  return fromExpression(receiver, { seen: new Set<Node>(), steps: 0 });
}

/** Spend one step on `node`; false once the budget is gone or `node` was already visited. */
function visit(node: Node, walk: Walk): boolean {
  if (walk.steps >= MAX_STEPS || walk.seen.has(node)) return false;
  walk.steps += 1;
  walk.seen.add(node);
  return true;
}

function fromExpression(node: Node, walk: Walk): boolean {
  if (!visit(node, walk)) return false;

  if (
    Node.isParenthesizedExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isNonNullExpression(node)
  ) {
    return fromExpression(node.getExpression(), walk);
  }
  if (Node.isAsExpression(node)) {
    const asserted = node.getTypeNode();
    return (
      (asserted !== undefined && fromTypeNode(asserted, walk)) ||
      fromExpression(node.getExpression(), walk)
    );
  }
  if (Node.isNewExpression(node)) {
    return fromFrameworkBinding(node.getExpression()) || fromCheckedType(node);
  }
  if (Node.isCallExpression(node)) {
    const callee = node.getExpression();
    if (fromFrameworkBinding(callee)) return true;
    // A builder call returns its receiver: `new Hono().basePath('/v1')`, `app.use(mw)`.
    if (Node.isPropertyAccessExpression(callee) && fromExpression(callee.getExpression(), walk))
      return true;
    return fromCheckedType(node);
  }
  if (Node.isIdentifier(node) || Node.isPropertyAccessExpression(node)) {
    return fromDeclaration(node, walk) || fromCheckedType(node);
  }
  return false;
}

/** The receiver's declaration: its annotation, or the expression that initialises it. */
function fromDeclaration(node: Node, walk: Walk): boolean {
  const symbol = node.getSymbol();
  if (symbol === undefined) return false;
  // Unaliased, so `import { app } from './app.ts'` is judged by `app`'s own declaration.
  for (const decl of unaliasSymbol(symbol).getDeclarations()) {
    if (Node.isExportAssignment(decl)) {
      if (fromExpression(decl.getExpression(), walk)) return true;
      continue;
    }
    if (
      !Node.isVariableDeclaration(decl) &&
      !Node.isParameterDeclaration(decl) &&
      !Node.isPropertyDeclaration(decl) &&
      !Node.isPropertySignature(decl)
    ) {
      continue;
    }
    const typeNode = decl.getTypeNode();
    if (typeNode !== undefined && fromTypeNode(typeNode, walk)) return true;
    const initializer = Node.isPropertySignature(decl) ? undefined : decl.getInitializer();
    if (initializer !== undefined && fromExpression(initializer, walk)) return true;
  }
  return false;
}

/** A type annotation naming a server type, judged by the checker first and by its import second. */
function fromTypeNode(typeNode: Node, walk: Walk): boolean {
  if (!visit(typeNode, walk)) return false;
  if (typeIsServer(safeType(typeNode))) return true;
  if (!Node.isTypeReference(typeNode)) return false;

  // Unresolved (the package is not installed): judge by the import declaration alone.
  const name = typeNode.getTypeName();
  const member = Node.isQualifiedName(name) ? name.getRight().getText() : undefined;
  let root: Node = name;
  while (Node.isQualifiedName(root)) root = root.getLeft();
  for (const decl of root.getSymbol()?.getDeclarations() ?? []) {
    if (Node.isTypeAliasDeclaration(decl)) {
      const aliased = decl.getTypeNode();
      if (aliased !== undefined && fromTypeNode(aliased, walk)) return true;
      continue;
    }
    const pkg = boundPackage(decl);
    if (pkg === undefined || !SERVER_FRAMEWORKS.has(pkg)) continue;
    const imported = member ?? (Node.isImportSpecifier(decl) ? decl.getName() : undefined);
    // A default import used as a type (`import KoaRouter from '@koa/router'`) is the class itself.
    if (imported === undefined ? Node.isImportClause(decl) : SERVER_TYPE_NAMES.has(imported))
      return true;
  }
  return false;
}

/** True when `callee` is, or is a member of, a binding imported from a supported framework. */
function fromFrameworkBinding(callee: Node): boolean {
  let root = callee;
  while (Node.isPropertyAccessExpression(root) || Node.isParenthesizedExpression(root))
    root = root.getExpression();
  if (!Node.isIdentifier(root)) return false;
  for (const decl of root.getSymbol()?.getDeclarations() ?? []) {
    const pkg = boundPackage(decl);
    if (pkg !== undefined && SERVER_FRAMEWORKS.has(pkg)) return true;
  }
  return false;
}

/**
 * The package a binding comes from, read off its own declaration: an `import`
 * of any form, or `const x = require('pkg')`. Relative specifiers give a name
 * that is in no allow-list, which is the intent.
 */
function boundPackage(decl: Node): string | undefined {
  if (Node.isImportSpecifier(decl) || Node.isImportClause(decl) || Node.isNamespaceImport(decl)) {
    const imported = decl.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    return imported === undefined ? undefined : packageName(imported.getModuleSpecifierValue());
  }
  if (Node.isVariableDeclaration(decl)) {
    const initializer = decl.getInitializer();
    if (initializer === undefined || !Node.isCallExpression(initializer)) return undefined;
    if (initializer.getExpression().getText() !== 'require') return undefined;
    const specifier = initializer.getArguments()[0];
    return specifier !== undefined && Node.isStringLiteral(specifier)
      ? packageName(specifier.getLiteralText())
      : undefined;
  }
  return undefined;
}

function fromCheckedType(node: Node): boolean {
  return typeIsServer(safeType(node));
}

function safeType(node: Node): Type | undefined {
  try {
    return node.getType();
  } catch {
    // A type the checker cannot produce is no evidence either way.
    return undefined;
  }
}

/**
 * A server type: named like one, and declared by this project or by a
 * supported framework's own package. The second condition is what keeps a
 * client SDK's `Router` interface from counting.
 */
function typeIsServer(type: Type | undefined): boolean {
  if (type === undefined) return false;
  const present = type.getNonNullableType();
  for (const symbol of [present.getSymbol(), present.getAliasSymbol()]) {
    if (symbol === undefined || !SERVER_TYPE_NAMES.has(symbol.getName())) continue;
    if (symbol.getDeclarations().some((decl) => declaredByServerSource(decl.getSourceFile())))
      return true;
  }
  return false;
}

function declaredByServerSource(file: SourceFile): boolean {
  return !file.isInNodeModules() || SERVER_PACKAGE_PATH.test(file.getFilePath());
}
