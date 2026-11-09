// SPDX-License-Identifier: Apache-2.0
/** Bounded generated-client lineage; application code and plugins stay unevaluated. */
import type * as TS from 'typescript';
import { metadataLoads } from './write-metadata-loads.ts';
import { assertWriteImportEffects } from './write-import-effects.ts';
import { assertWriteScriptOrigins } from './write-script-origins.ts';
import { RESERVED_CACHE_KEYS, WRITE_INTRINSIC_DATA, WRITE_INTRINSIC_ROOTS } from './write-globals.ts';
import { lockedVersion } from './write-libraries.ts';
import { type WriteModel } from './write-prisma.ts';
import { declaredName, unwrap, WRITE_SOURCE_EXTENSIONS, WriteSource, WriteUnknown } from './write-source.ts';
import { isAssignment, isLibraryBinding, lexicalBinding, literalKeys, literalString, references, rejectDynamicCode,
  sourceReference, writtenThrough } from './write-syntax.ts';

export interface WriteClientLineage {
  readonly generatedDirectory: string;
  readonly extensions: readonly string[];
}

export interface WriteClientProof {
  readonly lineage: WriteClientLineage;
  readonly cacheKey?: string;
  readonly sourceBoundary: 'inspected-repository-source';
}

type Values = ReadonlyMap<TS.Identifier, WriteClientLineage | undefined>;
interface CacheWrite { readonly key: string; readonly lineage: WriteClientLineage }

function sameLineage(a: WriteClientLineage, b: WriteClientLineage): boolean {
  return a.generatedDirectory === b.generatedDirectory;
}

class ClientBuilder {
  readonly project: WriteSource;
  readonly models: readonly WriteModel[];
  readonly writes = new Map<TS.ElementAccessExpression | TS.PropertyAccessExpression, CacheWrite>();
  readonly reads = new Map<TS.ElementAccessExpression | TS.PropertyAccessExpression, string>();
  readonly factories = new Set<TS.FunctionDeclaration>();
  readonly constructors = new Map<TS.Identifier, string>();
  readonly exports = new Map<TS.SourceFile, TS.ObjectLiteralExpression>();
  readonly exportMembers = new Set<string>();
  readonly clientBindings = new Set<TS.Identifier>();
  readonly objectBindings = new Set<TS.Identifier>();
  readonly clientFactories = new Set<TS.FunctionDeclaration>();
  readonly factoryCalls = new Set<TS.CallExpression>();
  readonly replicaOptions = new Set<TS.ObjectLiteralExpression>();
  readonly extensionCalls = new Set<TS.CallExpression>();
  readonly optionReferences = new Map<TS.Identifier, Set<TS.Identifier>>();

  constructor(project: WriteSource, models: readonly WriteModel[]) {
    this.project = project;
    this.models = models;
  }

  literal(expression: TS.Expression, visiting = new Set<TS.Identifier>()): string | undefined {
    return literalString(this.project, expression, visiting);
  }

  globalAccess(expression: TS.Expression): { key: string; access: TS.ElementAccessExpression | TS.PropertyAccessExpression } | undefined {
    const ts = this.project.ts;
    const value = unwrap(ts, expression);
    if (!ts.isElementAccessExpression(value) && !ts.isPropertyAccessExpression(value)) return undefined;
    const root = unwrap(ts, value.expression);
    if (!ts.isIdentifier(root) || !['globalThis', 'global'].includes(root.text) || lexicalBinding(ts, root) !== undefined) return undefined;
    const key = ts.isPropertyAccessExpression(value) ? value.name.text : this.literal(value.argumentExpression);
    if (key === undefined) throw new WriteUnknown('WRITE_DYNAMIC_GLOBAL_KEY');
    return { key, access: value };
  }

  containsClient(node: TS.Node, values: Values): boolean {
    const ts = this.project.ts;
    let found = false;
    const visit = (child: TS.Node): void => {
      if (ts.isTypeNode(child)) return;
      if (ts.isIdentifier(child)) {
        const binding = lexicalBinding(ts, child);
        if (binding !== undefined && values.get(binding) !== undefined) found = true;
      }
      if (!found) ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  }

  generatedConstructor(identifier: TS.Identifier): string | undefined {
    const ts = this.project.ts;
    const binding = lexicalBinding(ts, identifier);
    if (binding === undefined || !ts.isImportSpecifier(binding.parent) || binding.parent.isTypeOnly ||
        (binding.parent.propertyName?.text ?? binding.parent.name.text) !== 'PrismaClient') return undefined;
    const clause = binding.parent.parent.parent;
    const declaration = clause.parent;
    if (clause.isTypeOnly || !ts.isImportDeclaration(declaration) || !ts.isStringLiteral(declaration.moduleSpecifier)) return undefined;
    const path = this.project.importPath(identifier.getSourceFile(), declaration.moduleSpecifier.text);
    const roots = [...new Set(this.models.map(model => model.generatedDirectory))]
      .filter(directory => path === `${directory}/client` || path === `${directory}/client.ts`);
    if (roots.length !== 1) return undefined;
    if (this.project.inventory.some(candidate =>
      this.project.path(this.project.root, candidate).startsWith(`${roots[0] as string}/`)))
      throw new WriteUnknown('WRITE_GENERATED_OUTPUT_UNVERIFIED');
    for (const reference of references(ts, identifier.getSourceFile(), binding)) {
      if (!ts.isNewExpression(reference.parent) || reference.parent.expression !== reference)
        throw new WriteUnknown('WRITE_GENERATED_CONSTRUCTOR_ESCAPES');
    }
    this.constructors.set(binding, roots[0] as string);
    return roots[0];
  }

  mayInitializeClient(fn: TS.FunctionDeclaration, visiting = new Set<TS.FunctionDeclaration>()): boolean {
    if (visiting.has(fn)) throw new WriteUnknown('WRITE_CLIENT_INITIALIZER_CYCLE');
    this.factories.add(fn);
    if (this.factories.size > 4) throw new WriteUnknown('WRITE_CLIENT_INITIALIZER_CAP');
    this.project.count(fn);
    rejectDynamicCode(this.project, fn);
    const ts = this.project.ts;
    const next = new Set(visiting).add(fn);
    let found = false;
    const walk = (node: TS.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
          this.generatedConstructor(node.expression) !== undefined) found = true;
      if ((ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) &&
          this.globalAccess(node) !== undefined) found = true;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === '$extends') found = true;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        let declaration;
        try { declaration = sourceReference(this.project, node.expression); }
        catch (error) { if (!(error instanceof WriteUnknown)) throw error; }
        if (declaration !== undefined && ts.isFunctionDeclaration(declaration.node) &&
            this.mayInitializeClient(declaration.node, next)) found = true;
      }
      if (!found) ts.forEachChild(node, walk);
    };
    walk(fn);
    return found;
  }

  constructorOptions(expression: TS.Expression, values: Values, loggingOnly = false,
                     visiting = new Set<TS.Node>()): ReadonlySet<string> {
    const ts = this.project.ts;
    const value = unwrap(ts, expression);
    this.project.count(value);
    if (visiting.has(value)) throw new WriteUnknown('WRITE_CLIENT_OPTIONS_CYCLE');
    const next = new Set(visiting).add(value);
    if (ts.isIdentifier(value)) {
      const declaration = sourceReference(this.project, value);
      if (!ts.isVariableDeclaration(declaration.node) || !ts.isIdentifier(declaration.node.name) ||
          declaration.node.initializer === undefined || !(declaration.node.parent.flags & ts.NodeFlags.Const))
        throw new WriteUnknown('WRITE_CLIENT_OPTIONS_UNKNOWN');
      const uses = this.optionReferences.get(declaration.node.name) ?? new Set<TS.Identifier>();
      uses.add(value);
      this.optionReferences.set(declaration.node.name, uses);
      return this.constructorOptions(declaration.node.initializer, values, loggingOnly, next);
    }
    if (ts.isConditionalExpression(value) && loggingOnly) {
      if (this.containsClient(value.condition, values)) throw new WriteUnknown('WRITE_CLIENT_OPTIONS_ESCAPE');
      return new Set([...this.constructorOptions(value.whenTrue, values, true, next),
        ...this.constructorOptions(value.whenFalse, values, true, next)]);
    }
    if (!ts.isObjectLiteralExpression(value)) throw new WriteUnknown('WRITE_CLIENT_OPTIONS_UNKNOWN');
    const keys = new Set<string>();
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const key of this.constructorOptions(property.expression, values, true, next)) {
          if (keys.has(key)) throw new WriteUnknown('WRITE_CLIENT_OPTIONS_UNKNOWN');
          keys.add(key);
        }
        continue;
      }
      const key = declaredName(ts, property.name);
      const initializer = ts.isPropertyAssignment(property) ? property.initializer :
        ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
      if (key === undefined || initializer === undefined || keys.has(key) ||
          !(loggingOnly ? ['log'] : ['adapter', 'errorFormat', 'log']).includes(key) ||
          this.containsClient(initializer, values)) throw new WriteUnknown('WRITE_CLIENT_OPTIONS_UNKNOWN');
      keys.add(key);
      const setting = unwrap(ts, initializer);
      if (key === 'errorFormat' && (!ts.isStringLiteral(setting) || !['pretty', 'colorless', 'minimal'].includes(setting.text)))
        throw new WriteUnknown('WRITE_CLIENT_OPTIONS_UNKNOWN');
      if (key === 'log') {
        if (!ts.isArrayLiteralExpression(setting)) throw new WriteUnknown('WRITE_CLIENT_LOG_OPTIONS_UNKNOWN');
        for (const item of setting.elements) {
          const entry = unwrap(ts, item);
          if (ts.isStringLiteral(entry) && ['query', 'info', 'warn', 'error'].includes(entry.text)) continue;
          if (!ts.isObjectLiteralExpression(entry) || entry.properties.length !== 2)
            throw new WriteUnknown('WRITE_CLIENT_LOG_OPTIONS_UNKNOWN');
          const seen = new Set<string>();
          for (const option of entry.properties) {
            if (!ts.isPropertyAssignment(option)) throw new WriteUnknown('WRITE_CLIENT_LOG_OPTIONS_UNKNOWN');
            const name = declaredName(ts, option.name);
            const scalar = unwrap(ts, option.initializer);
            if (name === undefined || seen.has(name) || !ts.isStringLiteral(scalar) ||
                (name === 'level' ? !['query', 'info', 'warn', 'error'].includes(scalar.text) :
                 name !== 'emit' || !['event', 'stdout'].includes(scalar.text)))
              throw new WriteUnknown('WRITE_CLIENT_LOG_OPTIONS_UNKNOWN');
            seen.add(name);
          }
        }
      }
    }
    return keys;
  }

  value(expression: TS.Expression, values: Values = new Map(), visiting = new Set<TS.Node>()): WriteClientLineage | undefined {
    const ts = this.project.ts;
    const value = unwrap(ts, expression);
    this.project.count(value);
    if (visiting.has(value)) throw new WriteUnknown('WRITE_CLIENT_CYCLE');
    const next = new Set(visiting).add(value);
    if (ts.isIdentifier(value)) {
      const binding = lexicalBinding(ts, value);
      if (binding !== undefined && values.has(binding)) return values.get(binding);
      const declaration = sourceReference(this.project, value);
      if (ts.isVariableDeclaration(declaration.node) && declaration.node.initializer !== undefined) {
        if (!ts.isIdentifier(declaration.node.name) ||
            references(ts, declaration.file, declaration.node.name).some(reference => writtenThrough(ts, reference)))
          throw new WriteUnknown('WRITE_CLIENT_ALIAS_MUTATED');
        const lineage = this.value(declaration.node.initializer, values, next);
        if (lineage !== undefined) this.clientBindings.add(declaration.node.name);
        return lineage;
      }
      return undefined;
    }
    if (ts.isNewExpression(value) && ts.isIdentifier(value.expression)) {
      const generatedDirectory = this.generatedConstructor(value.expression);
      if (generatedDirectory === undefined) return undefined;
      if (value.typeArguments !== undefined || value.arguments === undefined || value.arguments.length !== 1 ||
          !ts.isObjectLiteralExpression(unwrap(ts, value.arguments[0] as TS.Expression)))
        throw new WriteUnknown('WRITE_CLIENT_OPTIONS_UNKNOWN');
      this.constructorOptions(value.arguments[0] as TS.Expression, values);
      if (this.containsClient(value.arguments[0] as TS.Expression, values)) throw new WriteUnknown('WRITE_CLIENT_OPTIONS_ESCAPE');
      return { generatedDirectory, extensions: [] };
    }
    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) &&
        value.expression.name.text === '$extends') {
      const base = this.value(value.expression.expression, values, next);
      if (base === undefined) return undefined;
      if (base.extensions.length !== 0 || value.arguments.length !== 1 || value.typeArguments !== undefined)
        throw new WriteUnknown('WRITE_CLIENT_EXTENSION_UNKNOWN');
      const extension = unwrap(ts, value.arguments[0] as TS.Expression);
      if (!ts.isCallExpression(extension) || !ts.isIdentifier(extension.expression) || extension.arguments.length !== 1 ||
          !isLibraryBinding(this.project, extension.expression, '@prisma/extension-read-replicas', 'readReplicas') ||
          lockedVersion(this.project, extension.getSourceFile(), '@prisma/extension-read-replicas') !== '0.5.0' ||
          lockedVersion(this.project, extension.getSourceFile(), '@prisma/client') !== '7.6.0')
        throw new WriteUnknown('WRITE_CLIENT_EXTENSION_UNKNOWN');
      const options = unwrap(ts, extension.arguments[0] as TS.Expression);
      if (!ts.isObjectLiteralExpression(options) || options.properties.length !== 1)
        throw new WriteUnknown('WRITE_CLIENT_EXTENSION_OPTIONS_UNKNOWN');
      const property = options.properties[0];
      if (property === undefined || !ts.isPropertyAssignment(property) || declaredName(ts, property.name) !== 'replicas')
        throw new WriteUnknown('WRITE_CLIENT_EXTENSION_OPTIONS_UNKNOWN');
      const replicas = unwrap(ts, property.initializer);
      if (!ts.isArrayLiteralExpression(replicas) || replicas.elements.length === 0)
        throw new WriteUnknown('WRITE_CLIENT_EXTENSION_OPTIONS_UNKNOWN');
      for (const replica of replicas.elements) {
        if (ts.isSpreadElement(replica) || ts.isOmittedExpression(replica)) throw new WriteUnknown('WRITE_CLIENT_EXTENSION_OPTIONS_UNKNOWN');
        const lineage = this.value(replica, values, next);
        if (lineage === undefined || !sameLineage(base, lineage) || lineage.extensions.length !== 0)
          throw new WriteUnknown('WRITE_CLIENT_REPLICA_LINEAGE_UNKNOWN');
      }
      this.replicaOptions.add(options);
      this.extensionCalls.add(value);
      return { generatedDirectory: base.generatedDirectory, extensions: ['@prisma/extension-read-replicas@0.5.0'] };
    }
    if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
      let declaration;
      try { declaration = sourceReference(this.project, value.expression); }
      catch (error) {
        if (!(error instanceof WriteUnknown)) throw error;
        if (this.containsClient(value, values)) throw new WriteUnknown('WRITE_CLIENT_ESCAPES');
        return undefined;
      }
      if (ts.isFunctionDeclaration(declaration.node)) {
        if (value.arguments.length !== 0 || value.typeArguments !== undefined) return undefined;
        if (!this.mayInitializeClient(declaration.node)) return undefined;
        this.factoryCalls.add(value);
        return this.factory(declaration.node, next);
      }
      return undefined;
    }
    if (ts.isBinaryExpression(value) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(value.operatorToken.kind)) {
      const cache = this.globalAccess(value.left);
      if (cache === undefined) return undefined;
      const fallback = this.value(value.right, values, next);
      if (fallback === undefined) throw new WriteUnknown('WRITE_CLIENT_COLD_PATH_UNKNOWN');
      this.reads.set(cache.access, cache.key);
      return fallback;
    }
    if (ts.isPropertyAccessExpression(value)) {
      const object = this.object(value.expression, next);
      if (object === undefined) return undefined;
      const properties = object.properties.filter(property => declaredName(ts, property.name) === value.name.text);
      if (properties.length !== 1 || object.properties.some(property => ts.isSpreadAssignment(property) ||
          property.name === undefined || declaredName(ts, property.name) === undefined))
        throw new WriteUnknown('WRITE_CLIENT_EXPORT_MEMBER_UNKNOWN');
      const property = properties[0] as TS.ObjectLiteralElementLike;
      const member = ts.isShorthandPropertyAssignment(property) ? property.name :
        ts.isPropertyAssignment(property) ? property.initializer : undefined;
      if (member === undefined) throw new WriteUnknown('WRITE_CLIENT_EXPORT_MEMBER_UNKNOWN');
      this.exports.set(object.getSourceFile(), object);
      this.exportMembers.add(value.name.text);
      return this.value(member, values, next);
    }
    return undefined;
  }

  object(expression: TS.Expression, visiting: ReadonlySet<TS.Node>): TS.ObjectLiteralExpression | undefined {
    const ts = this.project.ts;
    const value = unwrap(ts, expression);
    if (ts.isObjectLiteralExpression(value)) return value;
    if (!ts.isIdentifier(value)) return undefined;
    const declaration = sourceReference(this.project, value);
    if (visiting.has(declaration.node)) throw new WriteUnknown('WRITE_CLIENT_OBJECT_CYCLE');
    const next = new Set(visiting).add(declaration.node);
    if (ts.isExportAssignment(declaration.node)) return this.object(declaration.node.expression, next);
    if (ts.isVariableDeclaration(declaration.node) && declaration.node.initializer !== undefined) {
      if (!ts.isIdentifier(declaration.node.name) ||
          references(ts, declaration.file, declaration.node.name).some(reference => writtenThrough(ts, reference)))
        throw new WriteUnknown('WRITE_CLIENT_EXPORT_MUTATED');
      this.objectBindings.add(declaration.node.name);
      return this.object(declaration.node.initializer, next);
    }
    return undefined;
  }

  factory(fn: TS.FunctionDeclaration, visiting: Set<TS.Node>): WriteClientLineage {
    this.clientFactories.add(fn);
    const ts = this.project.ts;
    if (visiting.has(fn) || fn.name === undefined || fn.body === undefined || fn.parameters.length !== 0 ||
        fn.asteriskToken !== undefined || fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))
      throw new WriteUnknown('WRITE_CLIENT_FACTORY_UNKNOWN');
    this.factories.add(fn);
    if (this.factories.size > 4) throw new WriteUnknown('WRITE_CLIENT_INITIALIZER_CAP');
    this.project.count(fn);
    rejectDynamicCode(this.project, fn);
    if (references(ts, fn.getSourceFile(), fn.name).some(reference => writtenThrough(ts, reference)))
      throw new WriteUnknown('WRITE_CLIENT_FACTORY_REPLACED');
    const returned: WriteClientLineage[] = [];
    const stack = new Set(visiting).add(fn);
    const walk = (items: readonly TS.Statement[], initial: Values): Values[] => {
      let states = [initial];
      for (const statement of items) {
        const continuing: Values[] = [];
        for (const state of states) {
          if (ts.isVariableStatement(statement)) {
            if (!(statement.declarationList.flags & ts.NodeFlags.Const)) throw new WriteUnknown('WRITE_CLIENT_FACTORY_MUTABLE');
            const next = new Map(state);
            for (const declaration of statement.declarationList.declarations) {
              if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined)
                throw new WriteUnknown('WRITE_CLIENT_FACTORY_DECLARATION_UNKNOWN');
              const lineage = this.value(declaration.initializer, next, stack);
              if (lineage === undefined && this.containsClient(declaration.initializer, next))
                throw new WriteUnknown('WRITE_CLIENT_ESCAPES');
              next.set(declaration.name, lineage);
              if (lineage !== undefined) this.clientBindings.add(declaration.name);
            }
            continuing.push(next);
          } else if (ts.isIfStatement(statement)) {
            if (this.containsClient(statement.expression, state)) throw new WriteUnknown('WRITE_CLIENT_CONDITION_ESCAPES');
            const thenItems = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
            continuing.push(...walk(thenItems, state));
            continuing.push(...(statement.elseStatement === undefined ? [state] :
              walk(ts.isBlock(statement.elseStatement) ? statement.elseStatement.statements : [statement.elseStatement], state)));
          } else if (ts.isReturnStatement(statement)) {
            const lineage = statement.expression === undefined ? undefined : this.value(statement.expression, state, stack);
            if (lineage === undefined) throw new WriteUnknown('WRITE_CLIENT_FACTORY_RETURN_UNKNOWN');
            returned.push(lineage);
          } else if (ts.isExpressionStatement(statement)) {
            const value = unwrap(ts, statement.expression);
            if (ts.isBinaryExpression(value) && isAssignment(ts, value)) {
              const cache = this.globalAccess(value.left);
              const lineage = this.value(value.right, state, stack);
              if (cache === undefined || lineage === undefined || value.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionEqualsToken)
                throw new WriteUnknown('WRITE_CLIENT_FACTORY_ASSIGNMENT_UNKNOWN');
              const prior = this.writes.get(cache.access);
              if (prior !== undefined && (!sameLineage(prior.lineage, lineage) || prior.key !== cache.key))
                throw new WriteUnknown('WRITE_CLIENT_CACHE_WRITE_AMBIGUOUS');
              this.writes.set(cache.access, { key: cache.key, lineage });
            } else if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === '$on') {
              const client = this.value(value.expression.expression, state, stack);
              if (client === undefined || value.arguments.length !== 2 || !ts.isStringLiteral(value.arguments[0] as TS.Expression) ||
                  (value.arguments[0] as TS.StringLiteral).text !== 'query' || this.containsClient(value.arguments[1] as TS.Expression, state))
                throw new WriteUnknown('WRITE_CLIENT_LISTENER_UNKNOWN');
            } else if (this.containsClient(value, state)) throw new WriteUnknown('WRITE_CLIENT_ESCAPES');
            continuing.push(state);
          } else if (ts.isBlock(statement)) continuing.push(...walk(statement.statements, state));
          else throw new WriteUnknown('WRITE_CLIENT_FACTORY_STATEMENT_UNKNOWN');
        }
        states = continuing;
        if (states.length > 64) throw new WriteUnknown('WRITE_CLIENT_FACTORY_PATH_CAP');
      }
      return states;
    };
    if (walk(fn.body.statements, new Map()).length > 0 || returned.length === 0)
      throw new WriteUnknown('WRITE_CLIENT_FACTORY_FALLTHROUGH');
    const first = returned[0] as WriteClientLineage;
    if (returned.some(value => !sameLineage(first, value))) throw new WriteUnknown('WRITE_CLIENT_FACTORY_MIXED_LINEAGE');
    return { generatedDirectory: first.generatedDirectory, extensions: [...new Set(returned.flatMap(value => value.extensions))].sort() };
  }

  verifyReadonlyHandles(): void {
    assertWriteScriptOrigins(this.project);
    const ts = this.project.ts;
    if (!this.project.inventoryComplete) throw new WriteUnknown('WRITE_CLIENT_ALIAS_INVENTORY_INCOMPLETE');
    for (const [binding, allowed] of this.optionReferences) {
      if (references(ts, binding.getSourceFile(), binding).some(reference => !allowed.has(reference)))
        throw new WriteUnknown('WRITE_CLIENT_OPTIONS_ESCAPES');
    }
    for (const fn of this.clientFactories) {
      if (fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) || fn.name === undefined ||
          references(ts, fn.getSourceFile(), fn.name).some(reference => !ts.isCallExpression(reference.parent) ||
            reference.parent.expression !== reference || !this.factoryCalls.has(reference.parent)))
        throw new WriteUnknown('WRITE_CLIENT_FACTORY_ESCAPES', fn);
    }
    const checked = new Set<TS.Identifier>();
    const methods = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow',
      'findMany', 'count', 'aggregate', 'groupBy', 'create', 'createMany', 'createManyAndReturn',
      'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany',
      '$connect', '$disconnect', '$on', '$transaction', '$extends', '$queryRaw', '$queryRawUnsafe',
      '$executeRaw', '$executeRawUnsafe']);
    const sourceRoot = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/i, '').toLowerCase().replace(/\/index$/, '');
    const exportRoots = new Set([...this.exports.keys()].map(file => sourceRoot(this.project.path(this.project.root, file.fileName))));
    const generatedRoots = this.models.map(model => sourceRoot(`${model.generatedDirectory}/client`));
    const protectedRoots = [...exportRoots, ...generatedRoots];
    const workspaceNames = this.project.inventory.filter(path => path.toLowerCase() === 'package.json' || path.toLowerCase().endsWith('/package.json'))
      .map(path => this.project.json(path)['name']).filter((name): name is string => typeof name === 'string');
    const resolveRelevant = (file: TS.SourceFile, specifier: string): string | undefined => {
      if (!this.project.mayReference(file, specifier, protectedRoots)) return undefined;
      try { return sourceRoot(this.project.importPath(file, specifier)); }
      catch (error) {
        if (!(error instanceof WriteUnknown)) throw error;
        if (error.message === 'WRITE_ALIAS_UNKNOWN') this.project.assertExternalImport(file, specifier);
        if (error.message !== 'WRITE_ALIAS_UNKNOWN' || workspaceNames.some(name => specifier === name || specifier.startsWith(name + '/'))) throw error;
        return undefined;
      }
    };
    const contains = (container: TS.Node, node: TS.Node): boolean => {
      for (let cursor: TS.Node | undefined = node; cursor !== undefined; cursor = cursor.parent) if (cursor === container) return true;
      return false;
    };
    interface TransactionWrapper { readonly fn: TS.FunctionDeclaration; readonly parameter: number }
    const wrappers = new Map<TS.FunctionDeclaration, TransactionWrapper>();
    const wrapperMembers = new Map<string, TransactionWrapper>();
    const helperUses: Array<{ member: string; cursor: TS.Expression; segments: number; reference: TS.Identifier }> = [];
    const propertyValue = (property: TS.ObjectLiteralElementLike): TS.Expression | undefined =>
      ts.isShorthandPropertyAssignment(property) ? property.name : ts.isPropertyAssignment(property) ? unwrap(ts, property.initializer) : undefined;
    const callback = (fn: TS.ArrowFunction | TS.FunctionExpression | TS.FunctionDeclaration, self?: TS.Identifier): void => {
      if (fn.body === undefined || fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0]?.name as TS.BindingName) ||
          fn.parameters[0]?.dotDotDotToken !== undefined || fn.parameters[0]?.initializer !== undefined ||
          ('asteriskToken' in fn && fn.asteriskToken !== undefined)) throw new WriteUnknown('WRITE_TRANSACTION_CALLBACK_UNKNOWN', fn);
      const source = fn.getSourceFile();
      const strictStatement = (statement: TS.Statement | undefined): boolean => statement !== undefined && ts.isExpressionStatement(statement) &&
        ts.isStringLiteral(statement.expression) && ['\"use strict\"', "'use strict'"].includes(statement.expression.getText());
      const module = source.statements.some(statement =>
        (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly &&
          (statement.importClause === undefined || statement.importClause.name !== undefined || statement.importClause.namedBindings === undefined ||
           ts.isNamespaceImport(statement.importClause.namedBindings) || statement.importClause.namedBindings.elements.some(item => !item.isTypeOnly))) ||
        (ts.isExportDeclaration(statement) && !statement.isTypeOnly &&
          (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause) || statement.exportClause.elements.some(item => !item.isTypeOnly))) ||
        (ts.isExportAssignment(statement) && !statement.isExportEquals) ||
        (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) &&
          ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)));
      if (!module && !strictStatement(source.statements[0]) && !(ts.isBlock(fn.body) && strictStatement(fn.body.statements[0])))
        throw new WriteUnknown('WRITE_TRANSACTION_CALLBACK_NOT_STRICT', fn);
      const scan = (node: TS.Node): void => {
        if (ts.isTypeNode(node)) return;
        if (ts.isIdentifier(node) && node.text === 'arguments') throw new WriteUnknown('WRITE_TRANSACTION_IMPLICIT_ARGUMENTS', node);
        ts.forEachChild(node, scan);
      };
      scan(fn.body);
      const named = 'name' in fn && fn.name !== undefined && ts.isIdentifier(fn.name) ? fn.name : undefined;
      for (const name of [self, named]) if (name !== undefined && references(ts, fn.body, name).length > 0)
        throw new WriteUnknown('WRITE_TRANSACTION_CALLBACK_SELF_REFERENCE', fn);
      verify((fn.parameters[0] as TS.ParameterDeclaration).name as TS.Identifier, false);
    };
    const transactionArgument = (expression: TS.Expression, call: TS.CallExpression, wrapperAllowed: boolean,
                                 seen = new Set<TS.Node>()): void => {
      const value = unwrap(ts, expression);
      if (seen.size >= 64 || seen.has(value)) throw new WriteUnknown('WRITE_TRANSACTION_ARGUMENT_CYCLE', value);
      const next = new Set(seen).add(value);
      if (ts.isArrayLiteralExpression(value)) return;
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) { callback(value); return; }
      if (ts.isConditionalExpression(value)) {
        transactionArgument(value.whenTrue, call, wrapperAllowed, next);
        transactionArgument(value.whenFalse, call, wrapperAllowed, next);
        return;
      }
      if (!ts.isIdentifier(value)) throw new WriteUnknown('WRITE_TRANSACTION_ARGUMENT_UNKNOWN', value);
      const binding = lexicalBinding(ts, value);
      if (binding === undefined) throw new WriteUnknown('WRITE_TRANSACTION_ARGUMENT_UNKNOWN', value);
      const declaration = binding.parent;
      if (ts.isParameter(declaration) && wrapperAllowed && ts.isFunctionDeclaration(declaration.parent)) {
        const fn = declaration.parent;
        const statement = fn.body?.statements[0];
        if (fn.name === undefined || fn.body?.statements.length !== 1 || fn.asteriskToken !== undefined ||
            fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
            fn.parameters.some(parameter => !ts.isIdentifier(parameter.name) || parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined) ||
            statement === undefined || !ts.isReturnStatement(statement) || statement.expression === undefined || unwrap(ts, statement.expression) !== call)
          throw new WriteUnknown('WRITE_TRANSACTION_WRAPPER_UNKNOWN', fn);
        const parameter = fn.parameters.indexOf(declaration);
        const prior = wrappers.get(fn);
        if (prior !== undefined) {
          if (prior.parameter !== parameter) throw new WriteUnknown('WRITE_TRANSACTION_WRAPPER_AMBIGUOUS', fn);
          return;
        }
        const descriptor = { fn, parameter };
        wrappers.set(fn, descriptor);
        for (const object of this.exports.values()) for (const property of object.properties) {
          const name = declaredName(ts, property.name);
          const initializer = propertyValue(property);
          if (name !== undefined && initializer !== undefined && ts.isIdentifier(initializer) && sourceReference(this.project, initializer).node === fn)
            wrapperMembers.set(name, descriptor);
        }
        for (const reference of references(ts, fn.getSourceFile(), fn.name)) {
          if ([...this.exports.values()].some(object => object.properties.some(property => propertyValue(property) === reference))) continue;
          const use = reference.parent;
          if (!ts.isCallExpression(use) || use.expression !== reference || use.arguments[parameter] === undefined)
            throw new WriteUnknown('WRITE_TRANSACTION_WRAPPER_ESCAPES', reference);
          transactionArgument(use.arguments[parameter], use, false, next);
        }
        return;
      }
      if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined &&
          ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const)) {
        if (references(ts, declaration.getSourceFile(), binding).some(reference => writtenThrough(ts, reference)))
          throw new WriteUnknown('WRITE_TRANSACTION_ARGUMENT_MUTATED', value);
        const initializer = unwrap(ts, declaration.initializer);
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) callback(initializer, binding);
        else transactionArgument(initializer, call, wrapperAllowed, next);
        return;
      }
      if (ts.isFunctionDeclaration(declaration)) {
        if (references(ts, declaration.getSourceFile(), binding).some(reference => writtenThrough(ts, reference)))
          throw new WriteUnknown('WRITE_TRANSACTION_ARGUMENT_MUTATED', value);
        callback(declaration, binding);
        return;
      }
      const resolved = sourceReference(this.project, value);
      if (ts.isFunctionDeclaration(resolved.node)) callback(resolved.node, resolved.node.name);
      else if (ts.isVariableDeclaration(resolved.node) && resolved.node.initializer !== undefined &&
               (resolved.node.parent.flags & ts.NodeFlags.Const)) transactionArgument(resolved.node.initializer, call, wrapperAllowed, next);
      else throw new WriteUnknown('WRITE_TRANSACTION_ARGUMENT_UNKNOWN', value);
    };
    const verify = (binding: TS.Identifier, object: boolean): void => {
      let declaration: TS.Node = binding.parent;
      while (ts.isBindingElement(declaration) || ts.isObjectBindingPattern(declaration) || ts.isArrayBindingPattern(declaration)) declaration = declaration.parent;
      if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && ts.isVariableStatement(declaration.parent.parent) &&
          declaration.parent.parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
        throw new WriteUnknown('WRITE_CLIENT_NAMED_EXPORT_UNSUPPORTED', binding);
      if (checked.has(binding)) return;
      checked.add(binding);
      if (checked.size > 10_000) throw new WriteUnknown('WRITE_CLIENT_ALIAS_CAP');
      for (const reference of references(ts, binding.getSourceFile(), binding)) {
        if (writtenThrough(ts, reference)) throw new WriteUnknown('WRITE_CLIENT_ALIAS_MUTATED');
        let cursor: TS.Expression = reference;
        const segments: Array<string | undefined> = [];
        while ((ts.isPropertyAccessExpression(cursor.parent) || ts.isElementAccessExpression(cursor.parent)) &&
               cursor.parent.expression === cursor) {
          const parent = cursor.parent;
          segments.push(ts.isPropertyAccessExpression(parent) ? parent.name.text : this.literal(parent.argumentExpression));
          cursor = parent;
        }
        if (segments.some(segment => ['__proto__', 'prototype', 'constructor'].includes(segment ?? '')))
          throw new WriteUnknown('WRITE_CLIENT_PROTOTYPE_ACCESS');
        let isClient = !object;
        if (object && segments.length > 0) {
          const member = segments.shift();
          if (member === undefined) throw new WriteUnknown('WRITE_CLIENT_EXPORT_DYNAMIC_MEMBER');
          isClient = this.exportMembers.has(member);
          if (!isClient) { helperUses.push({ member, cursor, segments: segments.length, reference }); continue; }
        }
        let parent = cursor.parent;
        while (isClient && segments.length > 0 && ts.isCallExpression(parent) && parent.expression === cursor &&
               ['$extends', '$primary', '$replica', '$on'].includes(segments[segments.length - 1] ?? '')) {
          const method = segments[segments.length - 1];
          if (segments.length !== 1 || (method === '$extends' ? !this.extensionCalls.has(parent) : method === '$on' ?
              parent.arguments.length !== 2 || !ts.isStringLiteral(parent.arguments[0] as TS.Expression) || (parent.arguments[0] as TS.StringLiteral).text !== 'query' ||
              ts.isSpreadElement(parent.arguments[1] as TS.Expression) : this.replicaOptions.size === 0 || parent.arguments.length !== 0))
            throw new WriteUnknown('WRITE_CLIENT_DERIVED_HANDLE_UNKNOWN', reference);
          cursor = parent;
          segments.length = 0;
          while ((ts.isPropertyAccessExpression(cursor.parent) || ts.isElementAccessExpression(cursor.parent)) &&
                 cursor.parent.expression === cursor) {
            const access = cursor.parent;
            segments.push(ts.isPropertyAccessExpression(access) ? access.name.text : this.literal(access.argumentExpression));
            cursor = access;
          }
          parent = cursor.parent;
        }
        if (segments.some(segment => ['__proto__', 'prototype', 'constructor'].includes(segment ?? '')))
          throw new WriteUnknown('WRITE_CLIENT_PROTOTYPE_ACCESS');
        if (segments.length > 0 && isClient &&
            ((ts.isCallExpression(parent) && parent.expression === cursor) ||
             (ts.isTaggedTemplateExpression(parent) && parent.tag === cursor))) {
          const method = segments[segments.length - 1];
          if (method === undefined || !methods.has(method) || (method.startsWith('$') ? segments.length !== 1 : segments.length !== 2))
            throw new WriteUnknown('WRITE_CLIENT_METHOD_UNKNOWN');
          if (method === '$transaction') {
            if (!ts.isCallExpression(parent) || parent.arguments[0] === undefined || parent.arguments.length > 2)
              throw new WriteUnknown('WRITE_TRANSACTION_ARGUMENT_UNKNOWN', cursor);
            transactionArgument(parent.arguments[0], parent, true);
          }
          continue;
        }
        if (isClient && ts.isCallExpression(cursor) && ts.isExpressionStatement(parent) && parent.expression === cursor) continue;
        if (isClient && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
            parent.right === cursor && ts.isStringLiteral(parent.left)) continue;
        if (ts.isVariableDeclaration(parent) && parent.initializer === cursor && ts.isIdentifier(parent.name) &&
            (parent.parent.flags & ts.NodeFlags.Const)) {
          if (segments.length > 0) throw new WriteUnknown('WRITE_CLIENT_MEMBER_ESCAPES');
          verify(parent.name, object && !isClient);
          continue;
        }
        if (object && segments.length === 0 && ts.isVariableDeclaration(parent) && parent.initializer === reference &&
            ts.isObjectBindingPattern(parent.name) && (parent.parent.flags & ts.NodeFlags.Const)) {
          for (const element of parent.name.elements) {
            if (element.dotDotDotToken !== undefined || element.initializer !== undefined || !ts.isIdentifier(element.name))
              throw new WriteUnknown('WRITE_CLIENT_EXPORT_DESTRUCTURE_UNKNOWN');
            const member = declaredName(ts, element.propertyName ?? element.name);
            if (member === undefined) throw new WriteUnknown('WRITE_CLIENT_EXPORT_DYNAMIC_MEMBER');
            if (!this.exportMembers.has(member)) throw new WriteUnknown('WRITE_CLIENT_EXPORT_DESTRUCTURE_UNKNOWN', element);
            verify(element.name, false);
          }
          continue;
        }
        if (object && segments.length === 0 && ts.isExportAssignment(parent) && !parent.isExportEquals &&
            parent.expression === cursor && this.exports.has(parent.getSourceFile())) continue;
        if (!object && [...this.exports.values()].some(literal => literal.properties.some(property => propertyValue(property) === reference))) continue;
        if (!object && [...this.writes.keys()].some(access => ts.isBinaryExpression(access.parent) &&
            access.parent.right === cursor && access.parent.left === access)) continue;
        if (!object && [...this.replicaOptions].some(options => contains(options, reference))) continue;
        if (!object && ts.isReturnStatement(parent) && parent.expression === cursor &&
            [...this.clientFactories].some(fn => {
              let owner: TS.Node | undefined = parent.parent;
              while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
              return owner === fn;
            })) continue;
        throw new WriteUnknown('WRITE_CLIENT_HANDLE_ESCAPES', reference);
      }
    };
    for (const binding of this.clientBindings) verify(binding, false);
    for (const binding of this.objectBindings) verify(binding, true);
    for (const [file, object] of this.exports) {
      for (const property of object.properties) {
        if (this.exportMembers.has(declaredName(ts, property.name) ?? '')) continue;
        const value = ts.isShorthandPropertyAssignment(property) ? property.name :
          ts.isPropertyAssignment(property) ? unwrap(ts, property.initializer) : undefined;
        if (value === undefined || !ts.isIdentifier(value)) throw new WriteUnknown('WRITE_CLIENT_EXPORT_HELPER_UNKNOWN');
        const declaration = sourceReference(this.project, value);
        if (!ts.isFunctionDeclaration(declaration.node)) throw new WriteUnknown('WRITE_CLIENT_EXPORT_HELPER_UNKNOWN');
        const scan = (node: TS.Node): void => {
          if (ts.isTypeNode(node)) return;
          if (node.kind === ts.SyntaxKind.ThisKeyword) throw new WriteUnknown('WRITE_CLIENT_EXPORT_THIS_UNKNOWN');
          ts.forEachChild(node, scan);
        };
        scan(declaration.node);
      }
      void file;
    }
    for (const path of this.project.inventory) {
      if (!(WRITE_SOURCE_EXTENSIONS as readonly string[]).some(extension => path.toLowerCase().endsWith(extension))) continue;
      const file = this.project.parse(path, false);
      rejectDynamicCode(this.project, file);
      const metadata = metadataLoads(this.project, file);
      const inspectLoads = (node: TS.Node): void => {
        if (ts.isTypeNode(node)) return;
        if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
            (ts.isExportDeclaration(node) && !node.isTypeOnly)) {
          if (node.moduleSpecifier !== undefined) assertWriteImportEffects(this.project, file, node.moduleSpecifier);
        }
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined &&
            ts.isStringLiteral(node.moduleSpecifier) && ['vm', 'node:vm', 'inspector', 'node:inspector', 'node:inspector/promises', 'repl', 'node:repl', 'process', 'node:process'].includes(node.moduleSpecifier.text))
          throw new WriteUnknown('WRITE_DYNAMIC_CODE_MODULE', node);
        if (ts.isIdentifier(node) && ['require', 'module', 'process'].includes(node.text) && lexicalBinding(ts, node) === undefined) {
          const parent = node.parent;
          const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node);
          if (!propertyName) {
            if (node.text === 'require' && !(ts.isCallExpression(parent) && parent.expression === node))
              throw new WriteUnknown('WRITE_DYNAMIC_LOADER_UNKNOWN', node);
            if (node.text !== 'require') {
              const access = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node
                ? ts.isPropertyAccessExpression(parent) ? parent.name.text : this.literal(parent.argumentExpression) : undefined;
              if (access === undefined || (node.text === 'module' ? !['exports', 'require'].includes(access) ||
                  (access === 'require' && !(ts.isCallExpression(parent.parent) && parent.parent.expression === parent)) :
                  ['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule', 'mainModule', 'chdir'].includes(access) ||
                  (access === 'cwd' && writtenThrough(ts, node))))
                throw new WriteUnknown('WRITE_DYNAMIC_LOADER_UNKNOWN', node);
            }
          }
        }
        if (ts.isImportSpecifier(node) && (node.propertyName?.text ?? node.name.text) === 'createRequire' && !metadata.factories.has(node.name))
          throw new WriteUnknown('WRITE_DYNAMIC_LOADER_UNKNOWN', node);
        if (ts.isCallExpression(node) && !metadata.calls.has(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
            (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'require') ||
            (ts.isElementAccessExpression(node.expression) &&
             literalKeys(this.project, node.expression.argumentExpression)?.includes('require')))) {
          const specifier = node.arguments[0];
          if (node.arguments.length !== 1 || specifier === undefined || !ts.isStringLiteral(specifier))
            throw new WriteUnknown('WRITE_DYNAMIC_IMPORT_UNKNOWN', node);
          assertWriteImportEffects(this.project, file, specifier);
          if (['vm', 'node:vm', 'inspector', 'node:inspector', 'node:inspector/promises', 'repl', 'node:repl', 'module', 'node:module', 'process', 'node:process', 'path', 'node:path', 'zod', 'zod/v4'].includes(specifier.text)) throw new WriteUnknown('WRITE_DYNAMIC_CODE_MODULE', node);
          try {
            const target = sourceRoot(this.project.importPath(file, specifier.text));
            if (exportRoots.has(target) || this.models.some(model => sourceRoot(`${model.generatedDirectory}/client`) === target))
              throw new WriteUnknown('WRITE_CLIENT_DYNAMIC_IMPORT_UNSUPPORTED', node);
          } catch (error) {
            if (!(error instanceof WriteUnknown)) throw error;
            if (!['WRITE_ALIAS_UNKNOWN'].includes(error.message)) throw error;
          }
        }
        ts.forEachChild(node, inspectLoads);
      };
      inspectLoads(file);
      for (const statement of file.statements) {
        if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier) && ['zod', 'zod/v4'].includes(statement.moduleSpecifier.text)) {
          if (ts.isExportDeclaration(statement) && !statement.isTypeOnly &&
              (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause) ||
               statement.exportClause.elements.some(item => !item.isTypeOnly && ['z', 'default'].includes(item.propertyName?.text ?? item.name.text))))
            throw new WriteUnknown('WRITE_ZOD_NAMESPACE_REEXPORT', statement);
          if (ts.isImportDeclaration(statement) && statement.importClause !== undefined && !statement.importClause.isTypeOnly) {
            this.project.assertExternalImport(file, statement.moduleSpecifier.text);
            const clause = statement.importClause;
            const namespaces = clause.name === undefined ? [] : [clause.name];
            if (clause.namedBindings !== undefined) {
              if (ts.isNamespaceImport(clause.namedBindings)) namespaces.push(clause.namedBindings.name);
              else for (const imported of clause.namedBindings.elements)
                if (!imported.isTypeOnly) namespaces.push(imported.name);
            }
            for (const binding of namespaces) for (const reference of references(ts, file, binding)) {
              if (writtenThrough(ts, reference) || !ts.isPropertyAccessExpression(reference.parent) || reference.parent.expression !== reference)
                throw new WriteUnknown('WRITE_ZOD_NAMESPACE_ESCAPES', reference);
              let member: TS.Expression = reference.parent;
              while (ts.isPropertyAccessExpression(member.parent) && member.parent.expression === member) member = member.parent;
              const use = member.parent;
              if (!((ts.isCallExpression(use) && use.expression === member) || ts.isTypeOfExpression(use) ||
                  (ts.isBinaryExpression(use) && use.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && use.right === member)))
                throw new WriteUnknown('WRITE_ZOD_MEMBER_ESCAPES', member);
            }
          }
        }
        if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
          const target = resolveRelevant(file, statement.moduleSpecifier.text);
          if (target === undefined) continue;
          if (generatedRoots.includes(target)) throw new WriteUnknown('WRITE_GENERATED_CONSTRUCTOR_REEXPORT', statement);
          if (exportRoots.has(target)) throw new WriteUnknown('WRITE_CLIENT_EXPORT_ALIAS_UNSUPPORTED');
        }
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
            statement.importClause === undefined || statement.importClause.isTypeOnly) continue;
        const target = resolveRelevant(file, statement.moduleSpecifier.text);
        if (target === undefined) continue;
        const clause = statement.importClause;
        const generated = [...new Set(this.models.map(model => model.generatedDirectory))]
          .some(directory => sourceRoot(`${directory}/client`) === target);
        if (generated && clause.namedBindings !== undefined) {
          if (ts.isNamespaceImport(clause.namedBindings)) throw new WriteUnknown('WRITE_GENERATED_NAMESPACE_ESCAPES');
          for (const specifier of clause.namedBindings.elements) {
            if (specifier.isTypeOnly || (specifier.propertyName?.text ?? specifier.name.text) !== 'PrismaClient') continue;
            for (const reference of references(ts, file, specifier.name)) {
              if (!ts.isNewExpression(reference.parent) || reference.parent.expression !== reference)
                throw new WriteUnknown('WRITE_GENERATED_CONSTRUCTOR_ESCAPES');
            }
          }
        }
        if (!exportRoots.has(target)) continue;
        if (clause.name !== undefined) verify(clause.name, true);
        if (clause.namedBindings !== undefined) {
          if (ts.isNamespaceImport(clause.namedBindings)) throw new WriteUnknown('WRITE_CLIENT_NAMESPACE_ESCAPES');
          for (const specifier of clause.namedBindings.elements) {
            if (!specifier.isTypeOnly && (specifier.propertyName?.text ?? specifier.name.text) === 'default') verify(specifier.name, true);
          }
        }
      }
    }
    for (const use of helperUses) {
      const wrapper = wrapperMembers.get(use.member);
      if (wrapper === undefined) continue;
      const call = use.cursor.parent;
      if (use.segments !== 0 || !ts.isCallExpression(call) || call.expression !== use.cursor)
        throw new WriteUnknown('WRITE_TRANSACTION_WRAPPER_ESCAPES', use.reference);
      const argument = call.arguments[wrapper.parameter];
      if (argument === undefined) throw new WriteUnknown('WRITE_TRANSACTION_ARGUMENT_UNKNOWN', use.reference);
      transactionArgument(argument, call, false);
    }
  }

  /** Positions identify input nodes only inside this extraction's source cache. */
  signature(lineage: WriteClientLineage): string {
    const at = (node: TS.Node): string => JSON.stringify([node.getSourceFile().fileName, node.pos, node.end]);
    const nodes = (values: Iterable<TS.Node>): string[] => [...values].map(at).sort();
    return JSON.stringify(['client-source-world-v1', lineage,
      this.models.map(model => [model.model, model.generatedDirectory]),
      [...this.writes].map(([node, write]) => [at(node), write]).sort(),
      [...this.reads].map(([node, key]) => [at(node), key]).sort(),
      nodes(this.factories), nodes(this.clientFactories), nodes(this.factoryCalls), nodes(this.objectBindings), [...this.constructors].map(([node, path]) => [at(node), path]).sort(),
      [...this.exports].map(([file, object]) => [file.fileName, at(object)]).sort(),
      [...this.exportMembers].sort(), nodes(this.clientBindings), nodes(this.replicaOptions), nodes(this.extensionCalls),
      [...this.optionReferences].map(([node, allowed]) => [at(node), nodes(allowed)]).sort()]);
  }

  /** Source-world scrutiny applies to cached and uncached clients alike. */
  verifyCache(lineage: WriteClientLineage): string | undefined {
    const ts = this.project.ts;
    let key: string | undefined;
    if (this.reads.size === 0) {
      if (this.writes.size > 0) throw new WriteUnknown('WRITE_CLIENT_CACHE_WRITE_WITHOUT_READ');
    } else {
      const keys = new Set(this.reads.values());
      if (keys.size !== 1 || [...this.writes.values()].some(write => !keys.has(write.key))) throw new WriteUnknown('WRITE_CACHE_KEYS_AMBIGUOUS');
      key = [...keys][0] as string;
      if (RESERVED_CACHE_KEYS.has(key)) throw new WriteUnknown('WRITE_CACHE_BUILTIN_KEY');
      if (![...this.writes.values()].some(write => write.key === key) ||
          [...this.writes.values()].some(write => write.key === key && !sameLineage(write.lineage, lineage)))
        throw new WriteUnknown('WRITE_CACHE_POPULATION_UNKNOWN');
    }
    if (!this.project.inventoryComplete) throw new WriteUnknown('WRITE_CACHE_INVENTORY_INCOMPLETE');
    const known = new Map([...this.reads.keys(), ...this.writes.keys()].map(access =>
      [`${access.getSourceFile().fileName}:${access.pos}:${access.end}`, true]));
    for (const path of this.project.inventory) {
      if (!(WRITE_SOURCE_EXTENSIONS as readonly string[]).some(extension => path.toLowerCase().endsWith(extension))) continue;
      const file = this.project.parse(path, false);
      rejectDynamicCode(this.project, file);
      const classReceiver = (node: TS.Node): boolean => {
        for (let parent: TS.Node | undefined = node.parent; parent !== undefined; parent = parent.parent) {
          if (ts.isFunctionLike(parent)) {
            if (ts.isArrowFunction(parent)) continue;
            return (ts.isConstructorDeclaration(parent) || ts.isMethodDeclaration(parent) ||
              ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) &&
              (ts.isClassDeclaration(parent.parent) || ts.isClassExpression(parent.parent));
          }
          if ((ts.isPropertyDeclaration(parent) && (ts.isClassDeclaration(parent.parent) || ts.isClassExpression(parent.parent))) ||
              ts.isClassStaticBlockDeclaration(parent)) return true;
        }
        return false;
      };
      const primitiveReceivers = new Set<TS.Node>();
      const primitiveRoots = new Set<TS.Identifier>();
      const primitivePrototype = (node: TS.Node): boolean => {
        if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'prototype' || !ts.isIdentifier(node.expression) ||
            node.expression.text !== 'BigInt' || lexicalBinding(ts, node.expression) !== undefined) return false;
        const member = node.parent;
        const assignment = member.parent;
        if (!ts.isPropertyAccessExpression(member) || member.expression !== node || member.name.text !== 'toJSON' ||
            !ts.isBinaryExpression(assignment) || assignment.left !== member || assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
          return false;
        const fn = unwrap(ts, assignment.right);
        if (!ts.isFunctionExpression(fn) || fn.asteriskToken !== undefined || fn.parameters.length !== 0 ||
            fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) || fn.body.statements.length !== 1) return false;
        const returned = fn.body.statements[0];
        const call = returned !== undefined && ts.isReturnStatement(returned) ? returned.expression : undefined;
        if (call === undefined || !ts.isCallExpression(call) || call.typeArguments !== undefined || call.questionDotToken !== undefined) return false;
        const method = call.expression;
        let receiver: TS.Expression | undefined;
        if (ts.isPropertyAccessExpression(method) && method.questionDotToken === undefined && method.name.text === 'toString' &&
            method.expression.kind === ts.SyntaxKind.ThisKeyword && call.arguments.length === 0) receiver = method.expression;
        else if (ts.isIdentifier(method) && method.text === 'Number' && lexicalBinding(ts, method) === undefined &&
            call.arguments.length === 1 && call.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword) receiver = call.arguments[0];
        if (receiver === undefined) return false;
        // The isolated builtin prototype does not participate in singleton lookup.
        // Both exact forms only convert their primitive receiver to a scalar.
        primitiveReceivers.add(receiver);
        primitiveRoots.add(node.expression);
        return true;
      };
      const visit = (node: TS.Node): void => {
        if (ts.isTypeNode(node)) return;
        if (node.kind === ts.SyntaxKind.ThisKeyword && !primitiveReceivers.has(node) && !classReceiver(node)) throw new WriteUnknown('WRITE_GLOBAL_THIS_UNKNOWN', node);
        if (ts.isIdentifier(node) && node.text === key && lexicalBinding(ts, node) === undefined && writtenThrough(ts, node))
          throw new WriteUnknown('WRITE_IMPLICIT_GLOBAL_CACHE_WRITE', node);
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          const member = ts.isPropertyAccessExpression(node) ? node.name.text : this.literal(node.argumentExpression);
          const members = ts.isPropertyAccessExpression(node) ? [node.name.text] : literalKeys(this.project, node.argumentExpression);
          if (members?.some(key => ['__proto__', 'getPrototypeOf', 'setPrototypeOf'].includes(key)) ||
              (member !== 'prototype' && members?.includes('prototype')))
            throw new WriteUnknown('WRITE_GLOBAL_PROTOTYPE_UNKNOWN');
          if (member === 'prototype' && !primitivePrototype(node) && !(ts.isIdentifier(node.expression) && node.expression.text === 'Object' &&
              lexicalBinding(ts, node.expression) === undefined)) throw new WriteUnknown('WRITE_GLOBAL_PROTOTYPE_UNKNOWN', node);
        }
        if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
            (ts.isPropertyAccessExpression(node) ? node.name.text : this.literal(node.argumentExpression)) === 'prototype' &&
            ts.isIdentifier(node.expression) && node.expression.text === 'Object' &&
            lexicalBinding(ts, node.expression) === undefined) {
          const member = node.parent;
          const pure = ts.isPropertyAccessExpression(member) && member.expression === node &&
            ['hasOwnProperty', 'propertyIsEnumerable', 'isPrototypeOf', 'toString'].includes(member.name.text);
          const invoked = pure && ((ts.isCallExpression(member.parent) && member.parent.expression === member) ||
            (ts.isPropertyAccessExpression(member.parent) && member.parent.expression === member &&
             ['call', 'apply'].includes(member.parent.name.text) && ts.isCallExpression(member.parent.parent) &&
             member.parent.parent.expression === member.parent));
          if (!invoked || writtenThrough(ts, node.expression)) throw new WriteUnknown('WRITE_GLOBAL_PROTOTYPE_UNKNOWN');
        }
        if (ts.isIdentifier(node) && WRITE_INTRINSIC_ROOTS.has(node.text) && lexicalBinding(ts, node) === undefined &&
            !primitiveRoots.has(node)) {
          const use = node.parent;
          const propertyName = ((ts.isPropertyAccessExpression(use) || ts.isPropertyAssignment(use) ||
            ts.isMethodDeclaration(use) || ts.isPropertyDeclaration(use) || ts.isGetAccessorDeclaration(use) ||
            ts.isSetAccessorDeclaration(use)) && use.name === node) ||
            (ts.isBindingElement(use) && use.propertyName === node);
          if (!propertyName) {
            if (writtenThrough(ts, node)) throw new WriteUnknown('WRITE_GLOBAL_INTRINSIC_WRITE', node);
            const direct = (ts.isCallExpression(use) || ts.isNewExpression(use)) && use.expression === node;
            const keys = ts.isPropertyAccessExpression(use) && use.expression === node ? [use.name.text] :
              ts.isElementAccessExpression(use) && use.expression === node ? literalKeys(this.project, use.argumentExpression) : undefined;
            const call = keys !== undefined && ts.isCallExpression(use.parent) && use.parent.expression === use;
            const data = keys !== undefined && keys.every(key => WRITE_INTRINSIC_DATA.has(key));
            // The existing exact Object.prototype read proof below remains in force.
            const objectPrototype = node.text === 'Object' && keys?.length === 1 && keys[0] === 'prototype';
            if (!direct && !call && !data && !objectPrototype && !ts.isTypeOfExpression(use))
              throw new WriteUnknown('WRITE_GLOBAL_INTRINSIC_ESCAPE', node);
          }
        }
        if (ts.isIdentifier(node) && node.text === 'Number' && lexicalBinding(ts, node) === undefined && writtenThrough(ts, node))
          throw new WriteUnknown('WRITE_GLOBAL_CONSTRUCTOR_UNKNOWN', node);
        if (ts.isIdentifier(node) && node.text === 'Reflect' && lexicalBinding(ts, node) === undefined) {
          const parent = node.parent;
          const name = ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) ||
            ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent)) && parent.name === node) ||
            (ts.isBindingElement(parent) && parent.propertyName === node);
          if (!name && !ts.isTypeOfExpression(parent)) throw new WriteUnknown('WRITE_GLOBAL_REFLECTION_UNKNOWN', node);
        }
        if (ts.isIdentifier(node) && node.text === 'BigInt' && lexicalBinding(ts, node) === undefined &&
            !primitiveRoots.has(node) && !((ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) && node.parent.expression === node) &&
            !ts.isTypeOfExpression(node.parent)) throw new WriteUnknown('WRITE_GLOBAL_CONSTRUCTOR_UNKNOWN', node);
        if (ts.isIdentifier(node) && node.text === 'Object' && lexicalBinding(ts, node) === undefined &&
            (!ts.isPropertyAccessExpression(node.parent) && !ts.isElementAccessExpression(node.parent)) &&
            !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
            !(ts.isNewExpression(node.parent) && node.parent.expression === node))
          throw new WriteUnknown('WRITE_OBJECT_CONSTRUCTOR_ESCAPES');
        if (ts.isIdentifier(node) && ['window', 'self'].includes(node.text) && lexicalBinding(ts, node) === undefined &&
            !((ts.isPropertyAccessExpression(node.parent) || ts.isPropertyAssignment(node.parent)) && node.parent.name === node) &&
            !ts.isTypeOfExpression(node.parent)) throw new WriteUnknown('WRITE_GLOBAL_ALIAS_UNKNOWN', node);
        if (ts.isIdentifier(node) && ['globalThis', 'global'].includes(node.text) && lexicalBinding(ts, node) === undefined) {
          const parent = node.parent;
          if ((!ts.isElementAccessExpression(parent) && !ts.isPropertyAccessExpression(parent)) || parent.expression !== node)
            throw new WriteUnknown('WRITE_GLOBAL_OBJECT_ESCAPES');
          const access = this.globalAccess(parent);
          if (access === undefined || WRITE_INTRINSIC_ROOTS.has(access.key) ||
              ['__proto__', 'constructor', 'prototype', 'global', 'globalThis', 'window', 'self', 'BigInt', 'Number',
              'process', 'module', 'require', 'Function', 'eval', 'Object', 'Reflect'].includes(access.key))
            throw new WriteUnknown('WRITE_GLOBAL_ALIAS_UNKNOWN');
          if (access.key === key && !known.has(`${file.fileName}:${parent.pos}:${parent.end}`))
            throw new WriteUnknown('WRITE_CACHE_OTHER_ACCESS_UNKNOWN');
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    return key;
  }
}

export function proveWriteClient(project: WriteSource, expression: TS.Expression, models: readonly WriteModel[]): WriteClientProof {
  project.chargeSyntax('prisma-model-metadata', models[0]?.syntaxCost ?? 0);
  const builder = new ClientBuilder(project, models);
  const lineage = builder.value(expression);
  if (lineage === undefined) throw new WriteUnknown('WRITE_CLIENT_LINEAGE_UNKNOWN');
  const cacheKey = project.memoize(builder.signature(lineage), () => {
    const key = builder.verifyCache(lineage);
    builder.verifyReadonlyHandles();
    return key;
  });
  return { lineage, ...(cacheKey === undefined ? {} : { cacheKey }), sourceBoundary: 'inspected-repository-source' };
}

/** Declared lineage is only a possible identity until the complete world proof. */
export function possibleWriteClientLineage(project: WriteSource, expression: TS.Expression,
  models: readonly WriteModel[]): WriteClientLineage {
  project.chargeSyntax('prisma-model-metadata', models[0]?.syntaxCost ?? 0);
  const lineage = new ClientBuilder(project, models).value(expression);
  project.assertBudget();
  if (lineage === undefined) throw new WriteUnknown('WRITE_CLIENT_LINEAGE_UNKNOWN');
  return lineage;
}
