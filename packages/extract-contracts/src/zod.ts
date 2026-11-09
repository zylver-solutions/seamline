/**
 * Zod schema extraction from TypeScript source, statically.
 *
 * The file is parsed with `ts.createSourceFile`, which is a pure syntactic
 * parse: no `ts.Program`, no type checker, no module resolution, and above all
 * no evaluation. Importing the project's own modules to read `z.object(...)`
 * at runtime would be arbitrary code execution inside the extractor, which
 * §2.7 forbids outright.
 *
 * The Zod expression tree is lowered to a JSON-Schema-shaped object and then
 * handed to the same walker the OpenAPI and JSON Schema paths use. That is
 * deliberate: it makes `typeCategory` and the required/nullable modelling
 * identical across all three dialects by construction rather than by review.
 *
 * ## `typescript` is an optional peer dependency
 *
 * This is the only file in the package that touches `typescript`, and it uses
 * it for one thing: a syntactic parse. Forcing a ~23 MB runtime dependency on
 * every consumer of contract extraction, including one who only wants OpenAPI
 * or JSON Schema, is disproportionate to that.
 *
 * `import type * as TS from 'typescript'` below is erased at compile time by
 * `verbatimModuleSyntax` -- it costs nothing at runtime and needs no runtime
 * dependency, only `typescript`'s `.d.ts` files to be resolvable while
 * building *this* package (a `devDependency`, never shipped). The actual
 * runtime value comes from `loadTs()`, a `require('typescript')` wrapped in
 * try/catch and cached, because `require` fails synchronously and
 * predictably when a module is missing, unlike a dynamic `import()`, which
 * would have forced every function below -- and `extractContracts`, and
 * every one of its own callers -- to become `async` for the sake of one
 * optional dependency.
 *
 * Every helper below that needs the TypeScript AST takes the loaded module as
 * its first parameter (`ts: TsModule`) rather than closing over a module-level
 * binding. `extractZod` is the only place that calls `loadTs()`; if it comes
 * back `null`, none of those helpers ever run, and the document degrades to
 * `TYPESCRIPT_UNAVAILABLE` the same honest way a missing extractor scope does
 * elsewhere in this codebase -- a diagnostic, not a crash, and not a silently
 * narrower graph (`extract.ts`'s `merge()` already treats zero contracts from
 * one document as a no-op, so this does not touch `extractContracts`'s own
 * PASS/FAIL/UNAVAILABLE status).
 */

import { createRequire } from 'node:module';
import type * as TS from 'typescript';
import {
  walkSchemaTree,
  CATEGORY_OVERRIDE,
  UNKNOWN_FACETS,
  UNKNOWN_REQUIRED,
  type WalkContext,
} from './schema-walk.ts';
import type { LoadedDocument, DocumentLoader } from './document.ts';
import type { ContractFact, DocumentFacts, ExtractLimits, PropertyFact } from './types.ts';

type TsModule = typeof TS;

/** Emitted, deliberately without a filename, so repeated occurrences across a
 *  repo walk collapse into one diagnostic via `extractContracts`'s own
 *  `[...new Set(diagnostics)]` dedup rather than one line per file. */
const TS_UNAVAILABLE_DIAGNOSTIC =
  'TYPESCRIPT_UNAVAILABLE: the optional typescript peer dependency is not installed; Zod schema extraction is skipped';

let cachedTs: TsModule | null | undefined;

/** `require('typescript')`, cached for the process. Never throws. */
export function defaultLoadTs(): TsModule | null {
  if (cachedTs === undefined) {
    try {
      const req = createRequire(import.meta.url);
      cachedTs = req('typescript') as TsModule;
    } catch {
      cachedTs = null;
    }
  }
  return cachedTs;
}

/** Cheap pre-filter so a repo full of TypeScript is not fully parsed. */
export function mentionsZod(text: string): boolean {
  return /\bfrom\s*['"]zod(?:\/v\d+)?['"]|require\(\s*['"]zod(?:\/v\d+)?['"]\s*\)/.test(text);
}

interface ChainLink {
  readonly name: string;
  readonly args: readonly TS.Expression[];
}

interface Unwound {
  readonly base: string;
  readonly baseArgs: readonly TS.Expression[];
  /** Chain calls in source order, e.g. `['email', 'max', 'optional']`. */
  readonly chain: readonly ChainLink[];
  /**
   * The base is a `z.coerce.*` call. Coercion runs before validation, so it
   * turns a null or a missing key into a value (`'null'`, `0`, the epoch,
   * `false`) and the schema accepts what its base type alone would reject.
   */
  readonly coerce: boolean;
}

/** Identifiers bound to the zod namespace in this file. */
function zodBindings(ts: TsModule, sf: TS.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const spec = statement.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || !/^zod(\/v\d+)?$/.test(spec.text)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    else for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

/**
 * Peel a `z.string().email().optional()` chain apart into its base call and
 * the modifiers applied to it. Returns null when the chain does not bottom out
 * in the zod namespace.
 */
function unwind(
  ts: TsModule,
  expr: TS.Expression,
  zod: ReadonlySet<string>,
  consts: ReadonlyMap<string, TS.Expression>,
  visiting: ReadonlySet<string>,
  maxSteps: number,
): Unwound | null {
  const chain: ChainLink[] = [];
  let cur: TS.Expression = expr;
  const seen = new Set(visiting);
  for (let guard = 0; guard < Math.min(256, maxSteps); guard += 1) {
    if (
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isParenthesizedExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }
    if (ts.isIdentifier(cur)) {
      const target = consts.get(cur.text);
      if (target === undefined || seen.has(cur.text)) return null;
      seen.add(cur.text);
      cur = target;
      continue;
    }
    if (!ts.isCallExpression(cur) || !ts.isPropertyAccessExpression(cur.expression)) return null;
    const name = cur.expression.name.text;
    const target = cur.expression.expression;
    const args = cur.arguments;
    if (ts.isIdentifier(target) && zod.has(target.text)) {
      return { base: name, baseArgs: args, chain: chain.reverse(), coerce: false };
    }
    // `z.coerce.string()` — the coercion namespace sits between z and the base.
    if (
      ts.isPropertyAccessExpression(target) &&
      ts.isIdentifier(target.expression) &&
      zod.has(target.expression.text) &&
      target.name.text === 'coerce'
    ) {
      return { base: name, baseArgs: args, chain: chain.reverse(), coerce: true };
    }
    chain.push({ name, args });
    cur = target;
  }
  return null;
}

type Json = Record<string, unknown>;

/** Resolve only constant values in this source file, with the same cycle/depth bound. */
function staticValue(
  ts: TsModule,
  expression: TS.Expression,
  consts: ReadonlyMap<string, TS.Expression>,
  visiting: ReadonlySet<string>,
  depth: number,
  maxDepth: number,
): TS.Expression | undefined {
  if (depth > maxDepth) return undefined;
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  )
    return staticValue(ts, expression.expression, consts, visiting, depth + 1, maxDepth);
  if (ts.isIdentifier(expression)) {
    const target = consts.get(expression.text);
    if (target === undefined || visiting.has(expression.text)) return undefined;
    return staticValue(
      ts,
      target,
      consts,
      new Set([...visiting, expression.text]),
      depth + 1,
      maxDepth,
    );
  }
  return expression;
}

/** Literal value of a syntactic expression, or `undefined` when not literal. */
function literalOf(ts: TsModule, expr: TS.Expression): unknown {
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const inner = literalOf(ts, expr.operand);
    return typeof inner === 'number' ? -inner : undefined;
  }
  if (ts.isBigIntLiteral(expr)) return expr.text.replace(/n$/, '');
  return undefined;
}

/** The primitives whose constructor takes a `coerce` option, in Zod 3.25 and Zod 4. */
const COERCIBLE_BASES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'bigint',
]);

/**
 * True when the first argument of a primitive constructor may switch coercion
 * on: `z.number({ coerce: true })` is `z.coerce.number()` spelled as an option.
 * Only a missing argument, a string (an error message) and an object literal
 * whose keys are all read and either omit `coerce` or set it to a literal
 * `false` are known not to. A binding that does not resolve, a call, a spread,
 * a computed key and a shorthand `coerce` are not read, so they may.
 */
function optionsMayCoerce(
  ts: TsModule,
  args: readonly TS.Expression[],
  consts: ReadonlyMap<string, TS.Expression>,
  visiting: ReadonlySet<string>,
  depth: number,
  maxDepth: number,
): boolean {
  const arg = args[0];
  if (arg === undefined) return false;
  const options = staticValue(ts, arg, consts, visiting, depth, maxDepth);
  if (options === undefined) return true;
  if (ts.isStringLiteralLike(options)) return false;
  if (!ts.isObjectLiteralExpression(options)) return true;
  for (const member of options.properties) {
    if (ts.isSpreadAssignment(member)) return true;
    const key = propertyName(ts, member.name);
    if (key === null) return true;
    if (key !== 'coerce') continue;
    if (!ts.isPropertyAssignment(member)) return true;
    const value = staticValue(ts, member.initializer, consts, visiting, depth, maxDepth);
    if (value === undefined || value.kind !== ts.SyntaxKind.FalseKeyword) return true;
  }
  return false;
}

function numberArg(
  ts: TsModule,
  args: readonly TS.Expression[],
  index: number,
): number | undefined {
  const arg = args[index];
  if (arg === undefined) return undefined;
  const v = literalOf(ts, arg);
  return typeof v === 'number' ? v : undefined;
}

const STRING_CHECK_FORMAT: Readonly<Record<string, string>> = {
  uuid: 'uuid',
  guid: 'uuid',
  email: 'email',
  url: 'uri',
  uri: 'uri',
  datetime: 'date-time',
  date: 'date',
  time: 'time',
  duration: 'duration',
  ip: 'ipv4',
  ipv4: 'ipv4',
  ipv6: 'ipv6',
  cuid: 'cuid',
  cuid2: 'cuid2',
  ulid: 'ulid',
  nanoid: 'nanoid',
  emoji: 'emoji',
  base64: 'byte',
};

/**
 * What one schema's lowering could not read, split by blast radius.
 *
 * - `facet`: one property's type, format, enum members, optionality or
 *   nullability is unknown. The schema's property set is still known, so the
 *   property is emitted without that facet.
 * - `shape`: the schema's own property set is unknown (an expression, mutation,
 *   reference, cycle, shape, schema, lazy, depth or work-limit failure, or a
 *   modifier applied to something that has nested properties). Nothing this
 *   schema would emit can be trusted, so the contract is withheld.
 *
 * Both are listed as diagnostics; only `shape` withholds. A reason is never
 * promoted or demoted by where it was found except `ZOD_UNSUPPORTED_MODIFIER`,
 * whose radius depends on its receiver (see `lower`).
 *
 * Per-schema work is deterministic, including repeated aliases/spreads.
 */
class CoverageIssues extends Set<string> {
  readonly shapeReasons = new Set<string>();
  private remaining = 100_000;

  facet(reason: string): void {
    this.add(reason);
  }

  shape(reason: string): void {
    this.add(reason);
    this.shapeReasons.add(reason);
  }

  consume(): boolean {
    if (this.remaining > 0) {
      this.remaining -= 1;
      return true;
    }
    this.shape('ZOD_UNSUPPORTED_WORK_LIMIT');
    return false;
  }
}

/** Every facet group a property can lose. */
const ALL_UNKNOWN_FACETS: readonly string[] = ['default', 'nullable', 'type'];

function markUnknown(schema: Json, facet: string): void {
  const current = Array.isArray(schema[UNKNOWN_FACETS]) ? (schema[UNKNOWN_FACETS] as string[]) : [];
  if (!current.includes(facet)) schema[UNKNOWN_FACETS] = [...current, facet].sort();
}

function facetIsUnknown(schema: Json, facet: string): boolean {
  const current = schema[UNKNOWN_FACETS];
  return Array.isArray(current) && current.includes(facet);
}

function typeIsUnknown(schema: Json): boolean {
  return facetIsUnknown(schema, 'type');
}

/**
 * True when a lowered schema accepts null or may: it states a null, or its
 * null-ness is unknown. Only the parts that decide whether the value itself is
 * null are read, never `properties` or `items`.
 */
function mayAcceptNull(schema: Json): boolean {
  if (schema['nullable'] === true || facetIsUnknown(schema, 'nullable')) return true;
  const type = schema['type'];
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true;
  const members = schema['enum'];
  if (Array.isArray(members) && members.includes(null)) return true;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = schema[key];
    if (
      Array.isArray(branches) &&
      branches.some((b) => typeof b === 'object' && b !== null && mayAcceptNull(b as Json))
    )
      return true;
  }
  return false;
}

function unknownRequiredOf(schema: Json): Set<string> {
  const current = schema[UNKNOWN_REQUIRED];
  return new Set(Array.isArray(current) ? (current as string[]) : []);
}

function setUnknownRequired(schema: Json, names: ReadonlySet<string>): void {
  if (names.size === 0) delete schema[UNKNOWN_REQUIRED];
  else schema[UNKNOWN_REQUIRED] = [...names].sort();
}

/** True when walking this schema would emit properties below it. */
function hasNestedProperties(schema: Json): boolean {
  if (schema['properties'] !== undefined) return true;
  const items = schema['items'];
  if (typeof items === 'object' && items !== null && hasNestedProperties(items as Json))
    return true;
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const branches = schema[key];
    if (
      Array.isArray(branches) &&
      branches.some((b) => typeof b === 'object' && b !== null && hasNestedProperties(b as Json))
    )
      return true;
  }
  return false;
}

/**
 * True when a lowered schema is an object: it says so, or it is an intersection
 * every branch of which is one. A schema whose type is unknown is not.
 */
function isObjectSchema(schema: Json): boolean {
  if (typeIsUnknown(schema)) return false;
  if (schema['type'] === 'object') return true;
  const branches = schema['allOf'];
  return (
    schema['type'] === undefined &&
    Array.isArray(branches) &&
    branches.length > 0 &&
    branches.every((b) => typeof b === 'object' && b !== null && isObjectSchema(b as Json))
  );
}

interface Lowered {
  readonly schema: Json;
  /** `.optional()` / `.nullish()` / `.default()` seen on this expression. */
  readonly optional: boolean | null;
}

/**
 * Lower one Zod expression to a JSON-Schema-shaped object.
 *
 * `visiting` carries the const names on the current resolution chain so a
 * self-referential schema (`const Node = z.object({ next: Node })`, or a
 * lazy pair) terminates instead of recursing.
 */
function lower(
  ts: TsModule,
  expr: TS.Expression,
  zod: ReadonlySet<string>,
  consts: ReadonlyMap<string, TS.Expression>,
  visiting: ReadonlySet<string>,
  depth: number,
  maxDepth: number,
  issues: CoverageIssues,
): Lowered {
  if (!issues.consume()) return unsupported(issues, 'ZOD_UNSUPPORTED_WORK_LIMIT');
  if (depth > maxDepth) return unsupported(issues, 'ZOD_UNSUPPORTED_DEPTH');

  // A bare identifier is this dialect's `$ref`: resolve it in-file only.
  if (ts.isIdentifier(expr)) {
    const target = consts.get(expr.text);
    if (target === undefined) return unsupported(issues, 'ZOD_UNSUPPORTED_REFERENCE');
    if (visiting.has(expr.text)) return unsupported(issues, 'ZOD_UNSUPPORTED_CYCLE');
    return lower(
      ts,
      target,
      zod,
      consts,
      new Set([...visiting, expr.text]),
      depth + 1,
      maxDepth,
      issues,
    );
  }
  if (
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isParenthesizedExpression(expr)
  ) {
    return lower(ts, expr.expression, zod, consts, visiting, depth + 1, maxDepth, issues);
  }

  const u = unwind(ts, expr, zod, consts, visiting, maxDepth - depth + 1);
  if (u === null) return unsupported(issues, 'ZOD_UNSUPPORTED_EXPRESSION');

  const schema: Json = {};
  let optional: boolean | null = false;
  let unknownModifier = false;
  // A union or intersection with a branch whose facets could not be read.
  let unreadBranch = false;
  // A union or intersection whose own null-ness cannot be derived from its
  // branches, though the rest of what it states can be read.
  let nullableUnread = false;
  // The base coerces its input: `z.coerce.number()`, or the same thing spelled
  // as an option, `z.number({ coerce: true })`.
  const coerces =
    u.coerce ||
    (COERCIBLE_BASES.has(u.base) &&
      optionsMayCoerce(ts, u.baseArgs, consts, visiting, depth + 1, maxDepth));

  switch (u.base) {
    case 'string':
      schema['type'] = 'string';
      break;
    case 'number':
      schema['type'] = 'number';
      break;
    case 'bigint':
      schema['type'] = 'integer';
      break;
    case 'boolean':
      schema['type'] = 'boolean';
      break;
    case 'date':
      schema['type'] = 'string';
      schema['format'] = 'date-time';
      break;
    case 'literal': {
      const v = u.baseArgs[0] === undefined ? undefined : literalOf(ts, u.baseArgs[0]);
      schema['enum'] = v === undefined ? [] : [v];
      if (typeof v === 'string') schema['type'] = 'string';
      else if (typeof v === 'number') schema['type'] = 'number';
      else if (typeof v === 'boolean') schema['type'] = 'boolean';
      else if (v === null) schema['type'] = 'null';
      if (v === undefined) {
        // A binding, a call or the Zod 4 list form `z.literal(['a', null])`:
        // the value is not read, and it may be a null or an `undefined`, which
        // a missing key satisfies.
        schema[CATEGORY_OVERRIDE] = 'enum';
        markUnknown(schema, 'nullable');
        optional = null;
      }
      break;
    }
    case 'enum': {
      const arg = u.baseArgs[0];
      const resolved =
        arg === undefined ? undefined : staticValue(ts, arg, consts, visiting, depth + 1, maxDepth);
      const members =
        resolved !== undefined && ts.isArrayLiteralExpression(resolved)
          ? resolved.elements.map((element) => literalOf(ts, element))
          : [];
      // `z.enum` members are strings, so the raw type is a fact even when the
      // member list itself is not readable.
      schema['type'] = 'string';
      if (members.length > 0 && members.every((member) => typeof member === 'string'))
        schema['enum'] = members;
      else {
        schema[CATEGORY_OVERRIDE] = 'enum';
        issues.facet('ZOD_UNSUPPORTED_ENUM_MEMBERS');
      }
      break;
    }
    case 'nativeEnum':
      issues.facet('ZOD_UNSUPPORTED_ENUM_MEMBERS');
      // The member values live in another declaration. That the value is an
      // enum is a fact; whether its members are strings or numbers, and which
      // they are, is not, so neither the raw type nor the members are declared.
      schema[CATEGORY_OVERRIDE] = 'enum';
      break;
    case 'object':
    case 'strictObject':
    case 'looseObject': {
      schema['type'] = 'object';
      const shape = u.baseArgs[0];
      if (shape === undefined) issues.shape('ZOD_UNSUPPORTED_SHAPE');
      else {
        const lowered = lowerShape(ts, shape, zod, consts, visiting, depth, maxDepth, issues);
        schema['properties'] = lowered.properties;
        schema['required'] = [...lowered.required].sort();
        setUnknownRequired(schema, lowered.unknownRequired);
      }
      break;
    }
    case 'record':
    case 'map':
      schema['type'] = 'object';
      break;
    case 'array':
    case 'set': {
      const inner = u.baseArgs[0];
      schema['type'] = 'array';
      if (inner !== undefined) {
        const element = lower(ts, inner, zod, consts, visiting, depth + 1, maxDepth, issues);
        schema['items'] = element.schema;
        // An element whose type is unknown leaves the array's own type unknown.
        // Whether the element may be omitted is not the array's concern, so an
        // element with an unread presence obligation (`z.coerce.number()`) does not.
        if (typeIsUnknown(element.schema)) markUnknown(schema, 'type');
      }
      break;
    }
    case 'tuple':
      schema['type'] = 'array';
      break;
    case 'union':
    case 'discriminatedUnion': {
      const arrayArg = u.baseArgs.find((a) => ts.isArrayLiteralExpression(a));
      const branches: Json[] = [];
      let optionalBranch = false;
      if (arrayArg !== undefined && ts.isArrayLiteralExpression(arrayArg)) {
        for (const element of arrayArg.elements) {
          const branch = lower(ts, element, zod, consts, visiting, depth + 1, maxDepth, issues);
          branches.push(branch.schema);
          if (branch.optional === null) unreadBranch = true;
          else if (branch.optional) optionalBranch = true;
          if (facetIsUnknown(branch.schema, 'nullable')) nullableUnread = true;
        }
      }
      // A union accepts what any branch accepts, a missing key included.
      if (optionalBranch) optional = true;
      // Branches that were never enumerated (`z.union(OPTIONS)`, an argument
      // that is a call) are as unread as one that could not be lowered.
      if (branches.length > 0) schema['anyOf'] = branches;
      else unreadBranch = true;
      break;
    }
    case 'intersection': {
      const lowered = u.baseArgs.map((a) =>
        lower(ts, a, zod, consts, visiting, depth + 1, maxDepth, issues),
      );
      for (const branch of lowered) {
        if (branch.optional === null) unreadBranch = true;
        // `nullable` is read from the intersection's own schema and not from its
        // branches, so a branch that is, or may be, null cannot leave a stated
        // `false` behind.
        if (mayAcceptNull(branch.schema)) nullableUnread = true;
      }
      const branches = lowered.map((branch) => branch.schema);
      if (branches.length > 0) schema['allOf'] = branches;
      // The shared schema walk reads an `allOf` with no type of its own as an
      // object. That holds for an intersection of objects only: of two strings
      // it would state a type nobody read.
      if (!branches.every(isObjectSchema)) markUnknown(schema, 'type');
      // An intersection never accepts a missing key unless every branch does, so
      // one with a required branch is required. When every branch is optional the
      // answer depends on the release: Zod 3.25 accepts it (when the values the
      // branches parse it to agree: `.optional()` yields `undefined`,
      // `.default(v)` and `.catch(v)` yield `v`, and two that differ are
      // unmergeable), and current Zod 4 rejects it even for two `.optional()`.
      // So it is never stated `false`.
      if (lowered.length > 0 && lowered.every((branch) => branch.optional === true))
        optional = null;
      break;
    }
    case 'null':
      schema['type'] = 'null';
      break;
    case 'undefined':
    case 'void':
      // Zod 3.25 accepts a missing key for these (and for a union holding one);
      // current Zod 4 rejects it. Which release the code runs on is not known,
      // so the presence obligation is unread, like a coercion's. A null is
      // rejected on both, so `nullable` is still read.
      optional = null;
      break;
    case 'lazy': {
      // `z.lazy(() => Schema)` is the recursive form; the body is resolved
      // through `visiting`, so a self-reference stops here.
      const fn = u.baseArgs[0];
      if (fn === undefined || !ts.isArrowFunction(fn) || ts.isBlock(fn.body))
        return unsupported(issues, 'ZOD_UNSUPPORTED_LAZY');
      const inner = lower(ts, fn.body, zod, consts, visiting, depth + 1, maxDepth, issues);
      Object.assign(schema, inner.schema);
      optional = inner.optional;
      break;
    }
    default:
      return unsupported(issues, 'ZOD_UNSUPPORTED_SCHEMA');
  }

  if (unreadBranch) {
    // The branch that could not be read may be a `.nullable()`, an
    // `.optional()` or a different type altogether, and `analyzeSchema` would
    // recompute `nullable` from the branches that were read, which say nothing
    // about null. So the type, the null-ness and the presence obligation are
    // all unknown. A presence modifier on the union itself (`.optional()`)
    // is still read below and stated; `.nullable()` stays unknown, which is
    // conservative.
    markUnknown(schema, 'type');
    markUnknown(schema, 'nullable');
    optional = null;
  }
  if (nullableUnread) markUnknown(schema, 'nullable');
  if (coerces) {
    // The coercion runs before the check: `null` becomes 'null', 0, the epoch or
    // false, so the schema accepts a null the base type alone would reject. A
    // missing key is accepted for some bases (`z.coerce.string()` on Zod 3.25)
    // and not for others (`z.coerce.number()`), and the answer for a base
    // changes with the release, so the presence obligation is unread too. What
    // the base says about the output type is still a fact. An options argument
    // that is not read (`z.number(opts)`) may switch the coercion on, and is
    // treated as if it did.
    markUnknown(schema, 'nullable');
    optional = null;
  }

  for (const link of u.chain) {
    switch (link.name) {
      case 'optional':
        optional = true;
        break;
      case 'nullable':
        schema['nullable'] = true;
        break;
      case 'nullish':
        optional = true;
        schema['nullable'] = true;
        break;
      case 'default': {
        optional = true;
        const arg = link.args[0];
        const v = arg === undefined ? undefined : literalOf(ts, arg);
        schema['default'] = v === undefined ? null : v;
        break;
      }
      case 'catch': {
        if (hasNestedProperties(schema)) {
          // A catch swallows a failure anywhere below it, so no nested property's
          // `nullable`, `required` or `type` is a fact: `{ a: null }` is accepted
          // by `z.object({ a: z.string() }).catch(...)`. Like any modifier on a
          // receiver with nested properties, the property set cannot be trusted.
          issues.shape('ZOD_UNSUPPORTED_MODIFIER');
          unknownModifier = true;
          break;
        }
        // Whatever fails to parse becomes the fallback, a null included: the
        // schema accepts a null whatever its base says. A missing key is another
        // matter. From Zod 4.4.0 an object consults each property's `optin`, and
        // a catch takes its `optin` from its receiver until 4.4.3 sets it on the
        // catch itself, so on 4.4.0 to 4.4.2 `z.string().catch('x')` rejects a
        // missing key, while 3.25, 4.0 to 4.3 and 4.4.3 onwards accept it. So a catch states `required: false` only when the
        // receiver already accepts a missing key (`.optional()`, `.default(v)`),
        // and leaves the presence unread otherwise.
        markUnknown(schema, 'nullable');
        optional = optional === true ? true : null;
        const arg = link.args[0];
        const v = arg === undefined ? undefined : literalOf(ts, arg);
        schema['default'] = v === undefined ? null : v;
        break;
      }
      case 'describe': {
        const arg = link.args[0];
        const v = arg === undefined ? undefined : literalOf(ts, arg);
        if (typeof v === 'string') schema['description'] = v;
        break;
      }
      case 'readonly':
        schema['readOnly'] = true;
        break;
      case 'array': {
        const inner: Json = { ...schema };
        delete inner['nullable'];
        for (const k of Object.keys(schema)) delete schema[k];
        schema['type'] = 'array';
        schema['items'] = inner;
        // The array is rebuilt around what was read, so what was not read has to
        // be carried over by hand, as `z.array(...)` does for its element.
        if (typeIsUnknown(inner)) markUnknown(schema, 'type');
        optional = false;
        break;
      }
      case 'int':
        if (schema['type'] === 'number') schema['type'] = 'integer';
        break;
      case 'min': {
        const n = numberArg(ts, link.args, 0);
        if (n === undefined) break;
        if (schema['type'] === 'string') schema['minLength'] = n;
        else if (schema['type'] === 'array') schema['minItems'] = n;
        else schema['minimum'] = n;
        break;
      }
      case 'max': {
        const n = numberArg(ts, link.args, 0);
        if (n === undefined) break;
        if (schema['type'] === 'string') schema['maxLength'] = n;
        else if (schema['type'] === 'array') schema['maxItems'] = n;
        else schema['maximum'] = n;
        break;
      }
      case 'length': {
        const n = numberArg(ts, link.args, 0);
        if (n === undefined) break;
        if (schema['type'] === 'array') {
          schema['minItems'] = n;
          schema['maxItems'] = n;
        } else {
          schema['minLength'] = n;
          schema['maxLength'] = n;
        }
        break;
      }
      case 'nonempty':
        if (schema['type'] === 'array') schema['minItems'] = 1;
        else schema['minLength'] = 1;
        break;
      case 'gte':
      case 'gt': {
        const n = numberArg(ts, link.args, 0);
        if (n !== undefined) schema[link.name === 'gt' ? 'exclusiveMinimum' : 'minimum'] = n;
        break;
      }
      case 'lte':
      case 'lt': {
        const n = numberArg(ts, link.args, 0);
        if (n !== undefined) schema[link.name === 'lt' ? 'exclusiveMaximum' : 'maximum'] = n;
        break;
      }
      case 'positive':
        schema['exclusiveMinimum'] = 0;
        break;
      case 'nonnegative':
        schema['minimum'] = 0;
        break;
      case 'negative':
        schema['exclusiveMaximum'] = 0;
        break;
      case 'nonpositive':
        schema['maximum'] = 0;
        break;
      case 'multipleOf':
      case 'step': {
        const n = numberArg(ts, link.args, 0);
        if (n !== undefined) schema['multipleOf'] = n;
        break;
      }
      case 'regex': {
        const arg = link.args[0];
        if (arg !== undefined && ts.isRegularExpressionLiteral(arg)) {
          const m = /^\/(.*)\/[a-z]*$/s.exec(arg.text);
          if (m !== null) schema['pattern'] = m[1] as string;
        }
        break;
      }
      case 'partial': {
        if (link.args.length > 0) {
          // A mask makes some properties optional. Which, is not read, so the
          // property set stays and every property's presence obligation is unknown.
          issues.facet('ZOD_UNSUPPORTED_PARTIAL_MASK');
          const names = Object.keys((schema['properties'] as Json | undefined) ?? {});
          schema['required'] = [];
          setUnknownRequired(schema, new Set([...unknownRequiredOf(schema), ...names]));
          break;
        }
        // Every declared property becomes optional.
        schema['required'] = [];
        setUnknownRequired(schema, new Set());
        break;
      }
      case 'extend': {
        const shape = link.args[0];
        if (shape === undefined) {
          issues.shape('ZOD_UNSUPPORTED_SHAPE');
          schema['properties'] = {};
          schema['required'] = [];
          break;
        }
        const added = lowerShape(ts, shape, zod, consts, visiting, depth, maxDepth, issues);
        const props: Json = added.complete ? { ...(schema['properties'] as Json | undefined) } : {};
        const req = new Set<string>(
          added.complete ? ((schema['required'] as string[] | undefined) ?? []) : [],
        );
        const unknownReq = added.complete ? unknownRequiredOf(schema) : new Set<string>();
        for (const key of Object.keys(added.properties)) {
          delete props[key];
          req.delete(key);
          unknownReq.delete(key);
        }
        Object.assign(props, added.properties);
        for (const key of added.required) req.add(key);
        for (const key of added.unknownRequired) unknownReq.add(key);
        schema['properties'] = props;
        schema['required'] = [...req].sort();
        setUnknownRequired(schema, unknownReq);
        break;
      }
      default: {
        const format = STRING_CHECK_FORMAT[link.name];
        if (format !== undefined && schema['type'] === 'string') schema['format'] = format;
        else {
          // An unrecognised modifier may change the value's type, make it
          // optional or nullable, or (`omit`, `pick`, `merge`, `pipe`, ...)
          // reshape it. On a receiver with nothing below it only this
          // property's own facets are at stake; on one with nested properties
          // the property set is, and the contract cannot be trusted.
          if (hasNestedProperties(schema)) issues.shape('ZOD_UNSUPPORTED_MODIFIER');
          else issues.facet('ZOD_UNSUPPORTED_MODIFIER');
          unknownModifier = true;
        }
        break;
      }
    }
  }
  if (unknownModifier) {
    // Nothing the chain said before or after the modifier survives it.
    return { schema: { [UNKNOWN_FACETS]: [...ALL_UNKNOWN_FACETS] }, optional: null };
  }
  return { schema, optional };
}

/**
 * Lower a `z.object({...})` shape literal to `{ properties, required }`.
 *
 * `required` is placed on the PARENT object, exactly as JSON Schema does, and
 * is driven only by presence obligation: a field is required unless it carries
 * `.optional()`, `.nullish()`, or `.default()`. `.nullable()` sets
 * `nullable: true` on the property and does NOT touch `required`.
 */
interface LoweredShape {
  readonly properties: Json;
  readonly required: Set<string>;
  /** Declared properties whose presence obligation could not be read. */
  readonly unknownRequired: Set<string>;
  readonly complete: boolean;
}

/** A shape-level failure: nothing is known about this expression. */
function unsupported(issues: CoverageIssues, reason: string): Lowered {
  issues.shape(reason);
  return { schema: {}, optional: null };
}

/** Resolve only in-file constant literal shapes. Never evaluate a helper. */
function lowerShape(
  ts: TsModule,
  expression: TS.Expression,
  zod: ReadonlySet<string>,
  consts: ReadonlyMap<string, TS.Expression>,
  visiting: ReadonlySet<string>,
  depth: number,
  maxDepth: number,
  issues: CoverageIssues,
): LoweredShape {
  const empty = (): LoweredShape => ({
    properties: {},
    required: new Set(),
    unknownRequired: new Set(),
    complete: false,
  });
  if (!issues.consume()) return empty();
  if (depth > maxDepth) {
    issues.shape('ZOD_UNSUPPORTED_DEPTH');
    return empty();
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  )
    return lowerShape(
      ts,
      expression.expression,
      zod,
      consts,
      visiting,
      depth + 1,
      maxDepth,
      issues,
    );
  if (ts.isIdentifier(expression)) {
    const target = consts.get(expression.text);
    if (target === undefined) {
      issues.shape('ZOD_UNSUPPORTED_SHAPE_REFERENCE');
      return empty();
    }
    if (visiting.has(expression.text)) {
      issues.shape('ZOD_UNSUPPORTED_CYCLE');
      return empty();
    }
    return lowerShape(
      ts,
      target,
      zod,
      consts,
      new Set([...visiting, expression.text]),
      depth + 1,
      maxDepth,
      issues,
    );
  }
  if (!ts.isObjectLiteralExpression(expression)) {
    issues.shape('ZOD_UNSUPPORTED_SHAPE');
    return empty();
  }
  const properties: Json = Object.create(null) as Json;
  const required = new Set<string>();
  const unknownRequired = new Set<string>();
  let complete = true;
  const clear = () => {
    for (const key of Object.keys(properties)) delete properties[key];
    required.clear();
    unknownRequired.clear();
    complete = false;
  };
  for (const member of expression.properties) {
    if (ts.isSpreadAssignment(member)) {
      const spread = lowerShape(
        ts,
        member.expression,
        zod,
        consts,
        visiting,
        depth + 1,
        maxDepth,
        issues,
      );
      if (!spread.complete) clear();
      for (const key of Object.keys(spread.properties)) {
        delete properties[key];
        required.delete(key);
        unknownRequired.delete(key);
      }
      Object.assign(properties, spread.properties);
      for (const key of spread.required) required.add(key);
      for (const key of spread.unknownRequired) unknownRequired.add(key);
      continue;
    }
    if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
      issues.shape('ZOD_UNSUPPORTED_SHAPE_MEMBER');
      clear();
      continue;
    }
    const key = propertyName(ts, member.name);
    if (key === null) {
      issues.shape('ZOD_UNSUPPORTED_COMPUTED_KEY');
      clear();
      continue;
    }
    if (key === '__proto__' && ts.isPropertyAssignment(member)) {
      issues.shape('ZOD_UNSUPPORTED_PROTOTYPE_KEY');
      clear();
      continue;
    }
    const value = ts.isPropertyAssignment(member) ? member.initializer : member.name;
    const lowered = lower(ts, value, zod, consts, visiting, depth + 1, maxDepth, issues);
    delete properties[key];
    required.delete(key);
    unknownRequired.delete(key);
    // The key is declared whatever its value turned out to be, so the property
    // is always listed; a value that could not be read leaves its presence
    // obligation, and the facets marked on its schema, unknown.
    properties[key] = lowered.schema;
    if (lowered.optional === null) unknownRequired.add(key);
    else if (!lowered.optional) required.add(key);
  }
  return { properties, required, unknownRequired, complete };
}

function propertyName(ts: TsModule, name: TS.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

/** Top-level `const NAME = <expr>` bindings, exported or not. */
function topLevelConsts(ts: TsModule, sf: TS.SourceFile): Map<string, TS.Expression> {
  const consts = new Map<string, TS.Expression>();
  for (const statement of sf.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.Const) === 0
    )
      continue;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) continue;
      consts.set(decl.name.text, decl.initializer);
    }
  }
  return consts;
}

/** Constant bindings can reference mutable objects. Reject writes and raw-value
 * escapes, including aliases of the same object, before trusting definitions.
 * This is conservative source coverage, not an execution/order analysis. */
function unsafeConsts(
  ts: TsModule,
  sf: TS.SourceFile,
  consts: ReadonlyMap<string, TS.Expression>,
  zod: ReadonlySet<string>,
  maxDepth: number,
): Set<string> {
  const unsafe = new Set<string>();
  const aliases = new Map<string, Set<string>>();
  const raw = new Set<string>();
  const unwrap = (expression: TS.Expression): TS.Expression => {
    let current = expression;
    while (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    )
      current = current.expression;
    return current;
  };
  for (const [name, expression] of consts) {
    const value = unwrap(expression);
    if (ts.isIdentifier(value) && consts.has(value.text)) {
      const links = aliases.get(name) ?? new Set<string>();
      links.add(value.text);
      aliases.set(name, links);
      const reverse = aliases.get(value.text) ?? new Set<string>();
      reverse.add(name);
      aliases.set(value.text, reverse);
    }
    // A container may expose an inner object/schema through a property or
    // array slot. Propagate taint only when that container escapes or is written.
    const contained = (node: TS.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(unwrap(node.initializer))) {
        const target = unwrap(node.initializer) as TS.Identifier;
        if (consts.has(target.text)) {
          const links = aliases.get(name) ?? new Set<string>();
          links.add(target.text);
          aliases.set(name, links);
        }
      } else if (ts.isShorthandPropertyAssignment(node) && consts.has(node.name.text)) {
        const links = aliases.get(name) ?? new Set<string>();
        links.add(node.name.text);
        aliases.set(name, links);
      } else if (ts.isArrayLiteralExpression(node)) {
        for (const element of node.elements) {
          const target = unwrap(element);
          if (ts.isIdentifier(target) && consts.has(target.text)) {
            const links = aliases.get(name) ?? new Set<string>();
            links.add(target.text);
            aliases.set(name, links);
          }
        }
      }
      ts.forEachChild(node, contained);
    };
    contained(expression);
    const resolved = staticValue(ts, expression, consts, new Set([name]), 0, maxDepth);
    if (
      resolved !== undefined &&
      (ts.isObjectLiteralExpression(resolved) || ts.isArrayLiteralExpression(resolved))
    )
      raw.add(name);
  }
  const root = (expression: TS.Expression): string | undefined => {
    let current = unwrap(expression);
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current))
      current = unwrap(current.expression);
    return ts.isIdentifier(current) && consts.has(current.text) ? current.text : undefined;
  };
  const taintReferences = (node: TS.Node): void => {
    if (ts.isTypeNode(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['parse', 'safeParse', 'parseAsync', 'safeParseAsync', 'spa'].includes(
        node.expression.name.text,
      ) &&
      unwind(ts, node.expression.expression, zod, consts, new Set(), maxDepth) !== null
    ) {
      // Modeled validation reads return data, not an alias of the schema.
      // Their receiver does not escape; inspect input arguments as usual.
      for (const argument of node.arguments) taintReferences(argument);
      return;
    }
    if (ts.isIdentifier(node) && consts.has(node.text)) {
      const parent = node.parent;
      if (!(
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node)
      ))
        unsafe.add(node.text);
    }
    ts.forEachChild(node, taintReferences);
  };
  const visit = (node: TS.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const declarationList = node.parent;
      const topConst =
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        ts.isVariableStatement(declarationList.parent) &&
        declarationList.parent.parent === sf &&
        ts.isIdentifier(node.name);
      if (!topConst) taintReferences(node.initializer);
    } else if (
      ts.isPropertyDeclaration(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node)
    ) {
      const expression = ts.isPropertyDeclaration(node) ? node.initializer : node.expression;
      if (expression !== undefined) taintReferences(expression);
    } else if (ts.isYieldExpression(node) && node.expression !== undefined) {
      taintReferences(node.expression);
    } else if (ts.isReturnStatement(node) && node.expression !== undefined) {
      taintReferences(node.expression);
    } else if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      const parent = node.parent;
      const allowed =
        ts.isCallExpression(parent) &&
        unwind(ts, parent, zod, consts, new Set(), maxDepth)?.base === 'lazy';
      if (!allowed) taintReferences(node.body);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const name = root(node.left);
      if (name !== undefined) unsafe.add(name);
      taintReferences(node.right);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const name = root(node.operand);
      if (name !== undefined) unsafe.add(name);
    } else if (ts.isDeleteExpression(node)) {
      const name = root(node.expression);
      if (name !== undefined) unsafe.add(name);
    } else if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)
      ) {
        const name = root(node.expression.expression);
        if (name !== undefined && raw.has(name)) unsafe.add(name);
      }
      const chain = unwind(ts, node, zod, consts, new Set(), maxDepth);
      const method = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : undefined;
      const readsLiteral =
        chain !== null &&
        method !== undefined &&
        [
          'object',
          'strictObject',
          'looseObject',
          'enum',
          'extend',
          'array',
          'set',
          'union',
          'discriminatedUnion',
          'intersection',
          'lazy',
        ].includes(method);
      if (!readsLiteral) for (const argument of node.arguments) taintReferences(argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const pending = [...unsafe];
  for (let index = 0; index < pending.length; index += 1) {
    for (const alias of aliases.get(pending[index] as string) ?? []) {
      if (unsafe.has(alias)) continue;
      unsafe.add(alias);
      pending.push(alias);
    }
  }
  return unsafe;
}

/** Candidate discovery visits each syntax node once and stops at the first
 * Zod reference. Reused aliases cannot amplify traversal exponentially. */
function containsZod(
  ts: TsModule,
  expression: TS.Expression,
  zod: ReadonlySet<string>,
  consts: ReadonlyMap<string, TS.Expression>,
  visiting: ReadonlySet<string>,
  depth: number,
  maxDepth: number,
): boolean {
  const seen = new Set<TS.Node>();
  const walk = (node: TS.Node, level: number): boolean => {
    if (level > maxDepth) return true;
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      if (zod.has(node.text)) return true;
      const target = consts.get(node.text);
      if (target !== undefined && !visiting.has(node.text) && walk(target, level + 1)) return true;
    }
    return ts.forEachChild(node, (child) => (walk(child, level + 1) ? true : undefined)) ?? false;
  };
  return walk(expression, depth);
}

function literalShape(ts: TsModule, expression: TS.Expression): boolean {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  )
    return literalShape(ts, expression.expression);
  return ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression);
}

export function extractZod(
  loader: DocumentLoader,
  relPosix: string,
  text: string,
  limits: ExtractLimits,
  /** Injectable for tests only; every real call site uses the default. */
  loadTs: () => TsModule | null = defaultLoadTs,
): DocumentFacts {
  const ts = loadTs();
  if (ts === null) {
    return {
      contracts: [],
      operations: [],
      properties: [],
      diagnostics: [TS_UNAVAILABLE_DIAGNOSTIC],
      failed: false,
    };
  }

  const sf = ts.createSourceFile(relPosix, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parseDiagnostics = (sf as TS.SourceFile & { parseDiagnostics: readonly TS.Diagnostic[] })
    .parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    return {
      contracts: [],
      operations: [],
      properties: [],
      diagnostics: [`ZOD_UNSUPPORTED_PARSE: ${relPosix}`],
      // The file cannot be read at all, so it declares an unknown set of
      // contracts. Not a failure of the scope: the run just does not vouch for it.
      failed: false,
      unvouched: true,
    };
  }
  const zod = zodBindings(ts, sf);
  if (zod.size === 0) {
    return { contracts: [], operations: [], properties: [], diagnostics: [], failed: false };
  }
  const candidates = topLevelConsts(ts, sf);
  const unsafe = unsafeConsts(ts, sf, candidates, zod, limits.maxSchemaDepth);
  const consts = new Map([...candidates].filter(([name]) => !unsafe.has(name)));

  const contracts: ContractFact[] = [];
  const properties: PropertyFact[] = [];
  const diagnostics: string[] = [];
  const withheld: string[] = [];

  for (const name of [...candidates.keys()].sort()) {
    const expr = candidates.get(name) as TS.Expression;
    if (literalShape(ts, expr)) continue;
    const issues = new CoverageIssues();
    const lowered = unsafe.has(name)
      ? unsupported(issues, 'ZOD_UNSUPPORTED_MUTATION')
      : lower(ts, expr, zod, consts, new Set([name]), 0, limits.maxSchemaDepth, issues);
    const isZodSchema =
      lowered.schema['type'] === 'object' ||
      containsZod(ts, expr, zod, candidates, new Set([name]), 0, limits.maxSchemaDepth);
    if (isZodSchema)
      for (const issue of [...issues].sort())
        diagnostics.push(`${issue}: ${relPosix} contract ${name}`);
    if (isZodSchema && issues.shapeReasons.size > 0) {
      // The property set of this schema is unknown, so nothing it would emit can
      // be trusted, and it may be a contract an earlier run read. It is withheld
      // rather than emitted short, and its file stays out of the run's claim.
      withheld.push(name);
      diagnostics.push(`ZOD_CONTRACT_WITHHELD: ${relPosix} contract ${name}`);
      continue;
    }
    if (lowered.schema['type'] !== 'object') continue;
    const props = lowered.schema['properties'];
    if (props !== undefined && (typeof props !== 'object' || props === null)) continue;

    const doc: LoadedDocument = { absolute: relPosix, relPosix, value: lowered.schema };
    const ctx: WalkContext = {
      loader,
      limits,
      contract: name,
      out: properties,
      emitted: new Set(),
    };
    walkSchemaTree(ctx, doc, lowered.schema, '', 0, new Set());
    contracts.push({ name, dialect: 'zod', version: null, title: null, file: relPosix });
  }

  return {
    contracts,
    operations: [],
    properties,
    diagnostics: [...new Set(diagnostics)].sort(),
    // Unsupported constructs degrade per schema (`CoverageIssues`) instead of
    // failing the document: a facet-level gap leaves a property fact short, a
    // shape-level gap withholds that contract and unvouches the file.
    failed: false,
    unvouched: withheld.length > 0,
    withheld,
  };
}
