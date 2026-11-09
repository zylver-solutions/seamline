// SPDX-License-Identifier: Apache-2.0
/** First-party intrinsic/namespace integrity and the complete strict source walk. */
import type * as TS from 'typescript';
import { tryLibraryEffectCertificate } from './write-effect-certificate.ts';
import { assertWriteScriptOrigins } from './write-script-origins.ts';
import { lockedVersion } from './write-libraries.ts';
import { prismaWriteModels } from './write-prisma.ts';
import { WRITE_SOURCE_EXTENSIONS, WriteUnknown, type WriteSource } from './write-source.ts';
import { lexicalBinding, literalKeys, references, rejectDynamicCodeForQueryCopy, writtenThrough } from './write-syntax.ts';

const CONSTRUCTORS = new Set(['Object', 'Array', 'URL', 'URLSearchParams', 'RegExp', 'String', 'Number',
  'Boolean', 'BigInt', 'Symbol', 'Buffer', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'TextEncoder', 'TextDecoder', 'Headers', 'Request', 'Response',
  'AbortController', 'AbortSignal']);
const FORBIDDEN = new Set(['eval', 'Function', 'Proxy', 'Reflect', 'WebAssembly', 'Worker', 'SharedWorker',
  'importScripts', 'document', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);
const PROTOTYPE = new Set(['prototype', '__proto__', 'constructor', 'getPrototypeOf', 'setPrototypeOf',
  '_zod', '_def', '~standard',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const STATICS: Readonly<Record<string, readonly string[]>> = {
  Object: ['keys', 'values', 'entries', 'fromEntries', 'hasOwn', 'is', 'create', 'assign', 'freeze',
    'seal', 'preventExtensions', 'defineProperty', 'defineProperties', 'isExtensible', 'isFrozen', 'isSealed'],
  Array: ['isArray', 'from', 'of'],
  URL: ['canParse', 'parse'],
  RegExp: ['escape'],
  String: ['fromCharCode', 'fromCodePoint', 'raw'],
  Number: ['isFinite', 'isInteger', 'isNaN', 'isSafeInteger', 'parseFloat', 'parseInt'],
  Date: ['now', 'parse', 'UTC'],
  Symbol: ['for', 'keyFor'],
  Buffer: ['from', 'of', 'alloc', 'allocUnsafe', 'allocUnsafeSlow', 'isBuffer', 'isEncoding', 'byteLength', 'compare', 'concat'],
  Promise: ['resolve', 'reject', 'all', 'allSettled', 'any', 'race', 'withResolvers'],
  AbortSignal: ['abort', 'timeout', 'any'],
  Response: ['error', 'redirect', 'json'],
  JSON: ['parse', 'stringify'],
  Math: ['abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'atan2', 'cbrt', 'ceil', 'clz32',
    'cos', 'cosh', 'exp', 'expm1', 'floor', 'fround', 'hypot', 'imul', 'log', 'log1p', 'log2', 'log10',
    'max', 'min', 'pow', 'random', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc'],
};
const STATIC_DATA = new Set(['name', 'length', 'NaN', 'POSITIVE_INFINITY', 'NEGATIVE_INFINITY',
  'MAX_VALUE', 'MIN_VALUE', 'MAX_SAFE_INTEGER', 'MIN_SAFE_INTEGER', 'EPSILON', 'E', 'LN2', 'LN10',
  'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2']);

function propertyName(ts: typeof TS, node: TS.Identifier): boolean {
  const parent = node.parent;
  return ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) ||
    ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) ||
    ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node);
}

function strictClassReceiver(ts: typeof TS, node: TS.Node): boolean {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isArrowFunction(parent)) continue;
    if (ts.isFunctionLike(parent)) return (ts.isMethodDeclaration(parent) || ts.isConstructorDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && ts.isClassLike(parent.parent);
    if (ts.isClassStaticBlockDeclaration(parent)) return true;
  }
  return false;
}

/** External capability effects cannot be inferred from an unrelated basename. */
export function sourceImport(project: WriteSource, file: TS.SourceFile, name: string,
  node: TS.Node, declaration?: TS.ImportDeclaration, code = 'WRITE_QUERY_EXTERNAL_EFFECTS_UNKNOWN'): void {
  const ts = project.ts;
  try {
    project.inspectedOrigin(file, name);
    return;
  } catch (error) {
    if (!(error instanceof WriteUnknown)) throw error;
    project.assertBudget();
    if (error.message === 'WRITE_ALIAS_UNKNOWN') project.assertExternalImport(file, name);
    else if (error.message !== 'WRITE_MODULE_AMBIGUOUS') throw error;
  }
  const exported = ts.isExportDeclaration(node) ? node : ts.isExportDeclaration(node.parent) ? node.parent : undefined;
  if (exported !== undefined) {
    try {
      const target = project.importPath(file, name);
      if (prismaWriteModels(project).some(model => target === `${model.generatedDirectory}/client` ||
          target === `${model.generatedDirectory}/client.ts`))
        throw new WriteUnknown('WRITE_GENERATED_CONSTRUCTOR_REEXPORT', exported);
    } catch (error) {
      if (!(error instanceof WriteUnknown) || error.message === 'WRITE_GENERATED_CONSTRUCTOR_REEXPORT') throw error;
      project.assertBudget();
    }
  }
  // The existing generated-client summary has no installed source. Retain
  // only its declared generator lineage and direct constructor-only uses.
  const clause = declaration?.importClause;
  if (clause !== undefined && clause.name === undefined && clause.namedBindings !== undefined &&
      ts.isNamedImports(clause.namedBindings)) {
    const items = clause.namedBindings.elements.filter(item => !item.isTypeOnly);
    if (items.length === 1 && (items[0]?.propertyName?.text ?? items[0]?.name.text) === 'PrismaClient') {
      const target = project.importPath(file, name);
      const roots = [...new Set(prismaWriteModels(project).map(model => model.generatedDirectory))]
        .filter(root => target === `${root}/client` || target === `${root}/client.ts`);
      const binding = items[0]?.name;
      if (roots.length === 1 && binding !== undefined &&
          !project.inventory.some(path => project.path(project.root, path).startsWith(`${roots[0] as string}/`)) &&
          references(ts, file, binding).every(reference => ts.isNewExpression(reference.parent) &&
            reference.parent.expression === reference)) return;
    }
  }
  throw new WriteUnknown(code, node);
}

export function queryCopySourceWorld(project: WriteSource,
  data: readonly [TS.ElementAccessExpression, TS.ElementAccessExpression]): void {
  const ts = project.ts;
  const fail = (node: TS.Node): never => { throw new WriteUnknown('WRITE_QUERY_INTRINSICS_UNKNOWN', node); };
  if (!project.inventoryComplete) throw new WriteUnknown('WRITE_SOURCE_INVENTORY_INCOMPLETE');
  assertWriteScriptOrigins(project);
  for (const path of project.inventory) {
    if (!(WRITE_SOURCE_EXTENSIONS as readonly string[]).some(extension => path.toLowerCase().endsWith(extension))) continue;
    const file = project.parse(path, false);
    rejectDynamicCodeForQueryCopy(project, file, data);
    for (const statement of file.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
          statement.moduleSpecifier === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const name = statement.moduleSpecifier.text;
      // Inline type specifiers leave an empty runtime load under type stripping.
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
      if (name !== 'zod' && !name.startsWith('zod/')) {
        if (tryLibraryEffectCertificate(project, file, statement.moduleSpecifier)) continue;
        sourceImport(project, file, name, statement, ts.isImportDeclaration(statement) ? statement : undefined);
        continue;
      }
      if (ts.isExportDeclaration(statement)) return fail(statement);
      const clause = statement.importClause;
      if (name !== 'zod' || clause === undefined || clause.name !== undefined || clause.namedBindings === undefined ||
          lockedVersion(project, file, 'zod') !== '4.3.6') return fail(statement);
      const namespaces: TS.Identifier[] = [];
      if (ts.isNamespaceImport(clause.namedBindings)) namespaces.push(clause.namedBindings.name);
      else for (const item of clause.namedBindings.elements) {
        if (item.isTypeOnly) continue;
        if ((item.propertyName?.text ?? item.name.text) !== 'z') return fail(item);
        namespaces.push(item.name);
      }
      for (const namespace of namespaces) for (const reference of references(ts, file, namespace)) {
        const member = reference.parent;
        if (writtenThrough(ts, reference) || !ts.isPropertyAccessExpression(member) || member.expression !== reference ||
            member.questionDotToken !== undefined || !['object', 'string', 'enum'].includes(member.name.text) ||
            !ts.isCallExpression(member.parent) || member.parent.expression !== member ||
            member.parent.questionDotToken !== undefined || member.parent.typeArguments !== undefined) return fail(reference);
      }
    }
    const visit = (node: TS.Node): void => {
      if (ts.isTypeNode(node)) return;
      // Dynamic loads cannot supply the audited namespace-use closure. Every
      // subpath shares mutable library state, including the core constructors.
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
          (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require') ||
          (ts.isElementAccessExpression(node.expression) && literalKeys(project, node.expression.argumentExpression)?.includes('require')))) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteral(argument) &&
            (argument.text === 'zod' || argument.text.startsWith('zod/'))) return fail(node);
        if (argument === undefined || !ts.isStringLiteral(argument)) return fail(node);
        sourceImport(project, file, argument.text, node);
      }
      if (node.kind === ts.SyntaxKind.ThisKeyword && !strictClassReceiver(ts, node)) return fail(node);
      // Schema internals can expose shared constructors even when the public
      // namespace stays readonly. Reflection has no reviewed summary here.
      if ((ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) ||
          ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const key = ts.isBindingElement(node) ? node.propertyName ?? node.name : node.name;
        const keys = ts.isComputedPropertyName(key) ? literalKeys(project, key.expression) :
          ts.isIdentifier(key) || ts.isStringLiteral(key) ? [key.text] : undefined;
        if (keys?.some(key => PROTOTYPE.has(key))) return fail(node);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const keys = ts.isPropertyAccessExpression(node) ? [node.name.text] : literalKeys(project, node.argumentExpression);
        if (keys?.some(key => PROTOTYPE.has(key))) return fail(node);
      }
      if (ts.isIdentifier(node) && !propertyName(ts, node) && lexicalBinding(ts, node) === undefined) {
        const use = node.parent;
        if (FORBIDDEN.has(node.text) && !ts.isTypeOfExpression(use)) return fail(node);
        if (GLOBAL_OBJECTS.has(node.text)) {
          const keys = ts.isPropertyAccessExpression(use) && use.expression === node ? [use.name.text] :
            ts.isElementAccessExpression(use) && use.expression === node ? literalKeys(project, use.argumentExpression) : undefined;
          if (keys === undefined || keys.some(key => CONSTRUCTORS.has(key) || FORBIDDEN.has(key) || GLOBAL_OBJECTS.has(key) ||
              ['JSON', 'Math', 'process', 'module', 'require'].includes(key))) return fail(node);
        }
        if (CONSTRUCTORS.has(node.text) || ['JSON', 'Math'].includes(node.text)) {
          if (writtenThrough(ts, node)) return fail(node);
          const direct = (ts.isCallExpression(use) || ts.isNewExpression(use)) && use.expression === node && CONSTRUCTORS.has(node.text);
          const keys = ts.isPropertyAccessExpression(use) && use.expression === node ? [use.name.text] :
            ts.isElementAccessExpression(use) && use.expression === node ? literalKeys(project, use.argumentExpression) : undefined;
          const memberCall = keys !== undefined && keys.every(key => STATICS[node.text]?.includes(key)) &&
            ts.isCallExpression(use.parent) && use.parent.expression === use;
          const primitive = keys !== undefined && keys.every(key => STATIC_DATA.has(key));
          if (!direct && !memberCall && !primitive && !ts.isTypeOfExpression(use)) return fail(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  project.assertBudget();
}
