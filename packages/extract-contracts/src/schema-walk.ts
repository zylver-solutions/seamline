/**
 * Walks a JSON-Schema-family schema and emits one `PropertyFact` per declared
 * property.
 *
 * Two structural rules keep this bounded and cycle-free:
 *
 *  1. **Recursion never crosses a `$ref`.** A property whose value is a `$ref`
 *     is analysed (so its type category is known) but is not descended into.
 *     Its target is emitted at its own pointer when that schema is walked, so
 *     nothing is lost and `{"next": {"$ref": "#/.../Node"}}` cannot recurse.
 *  2. **Depth and ref-chain length are capped**, and every `$ref` chain
 *     carries the set of `(file, pointer)` pairs already visited, so a cycle
 *     terminates with a `REF_CYCLE` diagnostic.
 *
 * `allOf` composition: `required` is merged across every branch, including
 * `$ref` branches, because a base's `required` genuinely applies to the
 * composed object. Properties are emitted at their true pointer, so a
 * property contributed by a `$ref`'d base belongs to that base's schema, not
 * to the composing one.
 */

import { isRecord, pointerAppend } from './json-pointer.ts';
import { categorizeJsonType, readTypeField, unifyCategories } from './normalize-type.ts';
import { derefSchema, type DocumentLoader, type LoadedDocument } from './document.ts';
import { TYPE_CATEGORIES, type ExtractLimits, type PropertyFact, type TypeCategory } from './types.ts';

/**
 * A dialect's way to say "this property exists, but this facet could not be
 * read". The value is a list of facet groups: `type` (raw type, format, type
 * category), `nullable` and `default`. A named facet is left off the emitted
 * node rather than defaulted, so a reader sees it as not extracted, never as a
 * declared `false`, `'unknown'` or `''`. `array`-ness survives `type` when the
 * schema itself says `type: array`.
 */
export const UNKNOWN_FACETS = 'x-seamline-unknown-facets';

/**
 * On an object schema: the names of properties whose presence obligation
 * (`required`) could not be read. The properties are declared; whether they may
 * be omitted is not known, so they are emitted without a `required` fact.
 */
export const UNKNOWN_REQUIRED = 'x-seamline-unknown-required';

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Escape hatch for a dialect that knows a category the JSON Schema encoding
 * cannot express — `z.nativeEnum(Role)` is provably an enum even though its
 * member values live in another declaration. Honoured only when the value is
 * a real `TypeCategory`.
 */
export const CATEGORY_OVERRIDE = 'x-seamline-type-category';

function categoryOverride(schema: Record<string, unknown>): TypeCategory | null {
  const v = schema[CATEGORY_OVERRIDE];
  return typeof v === 'string' && (TYPE_CATEGORIES as readonly string[]).includes(v)
    ? (v as TypeCategory)
    : null;
}

export interface WalkContext {
  readonly loader: DocumentLoader;
  readonly limits: ExtractLimits;
  readonly contract: string;
  readonly out: PropertyFact[];
  readonly emitted: Set<string>;
  /** Internal OpenAPI 3.1 policy; absent for legacy callers and nonliteral analysis. */
  readonly emptySchemaNullability?: 'allow-null' | 'unobserved';
  /** The OpenAPI entry point already selected this independent root's dialect. */
  readonly emptySchemaRoot?: boolean;
}

const JSON_TYPES: ReadonlySet<string> = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer']);

function uniqueStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((member: unknown) => typeof member === 'string') &&
    new Set(value).size === value.length;
}

/** A finite admission guard, not a schema validator or an applicator solver. */
function ordinaryEmptySchemaContext(schema: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case 'type':
        if (!(typeof value === 'string' && JSON_TYPES.has(value)) &&
            !(uniqueStrings(value) && value.length > 0 && value.every(member => JSON_TYPES.has(member)))) return false;
        break;
      case 'properties':
      case '$defs':
      case 'definitions':
        if (!isRecord(value) || !Object.values(value).every(member => isRecord(member) || typeof member === 'boolean')) return false;
        break;
      case 'required':
        if (!uniqueStrings(value)) return false;
        break;
      case 'items':
        if (!isRecord(value) && typeof value !== 'boolean') return false;
        break;
      case '$id':
        if (typeof value !== 'string' || value.length === 0) return false;
        break;
      case '$schema':
      case 'title':
      case 'description':
        if (typeof value !== 'string') return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function emptySchemaContext(ctx: WalkContext, schema: Record<string, unknown>): WalkContext {
  let policy = ctx.emptySchemaNullability;
  if (policy === undefined) return ctx;
  // Decide before own properties: sibling applicators can constrain the same child.
  if ((!ctx.emptySchemaRoot && Object.prototype.hasOwnProperty.call(schema, '$schema')) ||
      !ordinaryEmptySchemaContext(schema)) policy = 'unobserved';
  return { ...ctx, emptySchemaNullability: policy, emptySchemaRoot: false };
}

export interface SchemaAnalysis {
  readonly rawType: string;
  readonly format: string | null;
  readonly category: TypeCategory;
  readonly nullable: boolean;
  readonly isArray: boolean;
  readonly refTarget: string | null;
  /** The schema constraints are read from (after `$ref`/`anyOf` collapse). */
  readonly effective: Record<string, unknown>;
}

const UNKNOWN_ANALYSIS: SchemaAnalysis = {
  rawType: '',
  format: null,
  category: 'unknown',
  nullable: false,
  isArray: false,
  refTarget: null,
  effective: {},
};

function isNullBranch(v: unknown): boolean {
  return isRecord(v) && v['type'] === 'null' && Object.keys(v).length === 1;
}

/**
 * Reduce a schema to (raw type, format, category, nullability, arrayness).
 *
 * `nullable` is computed here and ONLY from value-level signals: OAS 3.0's
 * `nullable: true`, a `"null"` member of a `type` array (JSON Schema /
 * OAS 3.1), or a `{"type":"null"}` branch of `anyOf`/`oneOf`. Presence
 * obligation (`required`) is never consulted, and never inferred from this.
 */
export function analyzeSchema(
  ctx: WalkContext,
  doc: LoadedDocument,
  raw: unknown,
  depth: number,
  chain: Set<string>,
): SchemaAnalysis {
  if (depth > ctx.limits.maxSchemaDepth) {
    ctx.loader.diagnostics.push(`SCHEMA_DEPTH_EXCEEDED: ${doc.relPosix} at depth ${depth}`);
    return UNKNOWN_ANALYSIS;
  }
  if (!isRecord(raw)) return UNKNOWN_ANALYSIS;

  let nullable = false;
  let refTarget: string | null = null;
  let curDoc = doc;
  let schema: Record<string, unknown> = raw;

  if (typeof schema['$ref'] === 'string') {
    refTarget = schema['$ref'];
    const resolved = derefSchema(ctx.loader, curDoc, schema, new Set(chain));
    curDoc = resolved.doc;
    if (!isRecord(resolved.value)) return { ...UNKNOWN_ANALYSIS, refTarget };
    schema = resolved.value;
  }

  if (schema['nullable'] === true) nullable = true;

  // `anyOf` / `oneOf`: strip explicit null branches (that is nullability, a
  // separate axis), then collapse a single remaining branch.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const nonNull = branches.filter((b) => !isNullBranch(b));
    if (nonNull.length !== branches.length) nullable = true;
    if (nonNull.length === 1) {
      const inner = analyzeSchema(ctx, curDoc, nonNull[0], depth + 1, chain);
      // The collapse reads the branch's facets, so a facet the wrapper itself
      // marked unknown (a Zod `.catch(...)` on a one-branch union) has to be
      // carried over or the branch's own value would be stated in its place.
      const wrapperUnknown = stringList(schema[UNKNOWN_FACETS]);
      const effective =
        wrapperUnknown.length === 0
          ? inner.effective
          : {
              ...inner.effective,
              [UNKNOWN_FACETS]: [
                ...new Set([...stringList(inner.effective[UNKNOWN_FACETS]), ...wrapperUnknown]),
              ].sort(),
            };
      return {
        ...inner,
        nullable: nullable || inner.nullable,
        refTarget: refTarget ?? inner.refTarget,
        effective,
      };
    }
    if (nonNull.length > 1) {
      const analyses = nonNull.map((b) => analyzeSchema(ctx, curDoc, b, depth + 1, chain));
      const rawTypes = [...new Set(analyses.map((a) => a.rawType).filter((t) => t !== ''))].sort();
      return {
        rawType: rawTypes.join('|'),
        format: null,
        category: unifyCategories(analyses.map((a) => a.category)),
        nullable: nullable || analyses.some((a) => a.nullable),
        isArray: analyses.every((a) => a.isArray),
        refTarget,
        effective: schema,
      };
    }
  }

  const { type, typeIsNullable, rawType } = readTypeField(schema);
  if (typeIsNullable) nullable = true;
  const format = typeof schema['format'] === 'string' ? schema['format'] : null;
  const enumMembers = schema['enum'];
  const hasEnum = Array.isArray(enumMembers) && enumMembers.length > 0;

  if (type === 'array') {
    const items = schema['items'];
    const inner = isRecord(items)
      ? analyzeSchema(ctx, curDoc, items, depth + 1, chain)
      : UNKNOWN_ANALYSIS;
    return {
      rawType: inner.rawType === '' ? 'array' : `array<${inner.rawType}>`,
      format: inner.format,
      // An array carries its ELEMENT's category plus `isArray`, so
      // `text[]` and `{"type":"array","items":{"type":"string"}}` agree on
      // both axes. An array of objects, or of nothing declared, is `json`.
      category: inner.category === 'unknown' || inner.category === 'json' ? 'json' : inner.category,
      nullable,
      isArray: true,
      refTarget: refTarget ?? inner.refTarget,
      effective: schema,
    };
  }

  // A bare `allOf` with no own type composes objects.
  if (type === null && Array.isArray(schema['allOf']) && schema['allOf'].length > 0) {
    return { rawType: 'object', format, category: 'json', nullable, isArray: false, refTarget, effective: schema };
  }

  return {
    rawType,
    format,
    category: categorizeJsonType(type, format, hasEnum),
    nullable,
    isArray: false,
    refTarget,
    effective: schema,
  };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Canonical JSON for a set of enum members, sorted so that two enums with the
 * same members in different declaration order compare equal. Set equality is
 * what X3/X7 need; declaration order is not a fact either side can rely on.
 */
export function canonicalEnum(members: readonly unknown[]): string {
  return JSON.stringify([...members].map((m) => JSON.stringify(m) ?? 'null').sort());
}

function scalar(v: unknown): string | number | boolean | null {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v as string | number | boolean;
  return JSON.stringify(v) ?? null;
}

/**
 * Collect the `required` names in force at one object level: the schema's own
 * `required`, plus that of every `allOf` branch (a `$ref` branch included,
 * since a base's `required` applies to the composed object).
 */
export function effectiveRequired(
  ctx: WalkContext,
  doc: LoadedDocument,
  schema: Record<string, unknown>,
  depth: number,
  chain: Set<string>,
  key: string = 'required',
): Set<string> {
  const required = new Set<string>();
  const own = schema[key];
  if (Array.isArray(own)) for (const r of own) if (typeof r === 'string') required.add(r);
  if (depth > ctx.limits.maxSchemaDepth) return required;
  const allOf = schema['allOf'];
  if (!Array.isArray(allOf)) return required;
  for (const branch of allOf) {
    if (!isRecord(branch)) continue;
    const nextChain = new Set(chain);
    const resolved = derefSchema(ctx.loader, doc, branch, nextChain);
    if (resolved.cyclic || !isRecord(resolved.value)) continue;
    for (const r of effectiveRequired(ctx, resolved.doc, resolved.value, depth + 1, nextChain, key)) {
      required.add(r);
    }
  }
  return required;
}

export interface EmitOptions {
  /** `null` when the presence obligation could not be read (see `UNKNOWN_REQUIRED`). */
  readonly required: boolean | null;
  readonly in?: string;
}

/** Build and record one `PropertyFact`. Duplicate pointers are dropped once. */
export function emitProperty(
  ctx: WalkContext,
  doc: LoadedDocument,
  raw: unknown,
  jsonPointer: string,
  name: string,
  opts: EmitOptions,
  depth: number,
  chain: Set<string>,
): void {
  const key = `${ctx.contract}#${jsonPointer}`;
  if (ctx.emitted.has(key)) return;
  ctx.emitted.add(key);

  const a = analyzeSchema(ctx, doc, raw, depth, chain);
  const e = a.effective;
  const unknown = new Set(stringList(e[UNKNOWN_FACETS]));
  const typeUnknown = unknown.has('type');
  const defaultUnknown = unknown.has('default');
  let nullable: boolean | null = a.nullable;
  // Only original {} or true proves this. Ref/union/limit fallbacks may also be {}.
  if (ctx.emptySchemaNullability !== undefined && (raw === true || (isRecord(raw) && Object.keys(raw).length === 0))) {
    nullable = ctx.emptySchemaNullability === 'allow-null' && depth <= ctx.limits.maxSchemaDepth ? true : null;
  }
  const category = categoryOverride(e) ?? a.category;
  const enumMembers = Array.isArray(e['enum']) ? (e['enum'] as unknown[]) : null;
  const hasDefault = isRecord(e) && Object.prototype.hasOwnProperty.call(e, 'default');

  ctx.out.push({
    contract: ctx.contract,
    jsonPointer,
    name,
    type: typeUnknown ? '' : a.rawType,
    format: typeUnknown ? null : a.format,
    typeCategory: typeUnknown ? null : category,
    required: opts.required,
    nullable: unknown.has('nullable') ? null : nullable,
    // An array that is declared as one stays an array when its element is unknown.
    isArray: typeUnknown ? (e['type'] === 'array' ? true : null) : a.isArray,
    hasDefault: defaultUnknown ? null : hasDefault,
    defaultValue: hasDefault && !defaultUnknown ? scalar(e['default']) : null,
    readOnly: e['readOnly'] === true,
    writeOnly: e['writeOnly'] === true,
    deprecated: e['deprecated'] === true,
    minLength: num(e['minLength']),
    maxLength: num(e['maxLength']),
    pattern: str(e['pattern']),
    minimum: num(e['minimum']) ?? num(e['exclusiveMinimum']),
    maximum: num(e['maximum']) ?? num(e['exclusiveMaximum']),
    exclusiveMinimum: num(e['exclusiveMinimum']),
    exclusiveMaximum: num(e['exclusiveMaximum']),
    multipleOf: num(e['multipleOf']),
    minItems: num(e['minItems']),
    maxItems: num(e['maxItems']),
    enumValues: enumMembers !== null && enumMembers.length > 0 ? canonicalEnum(enumMembers) : null,
    enumCount: enumMembers !== null && enumMembers.length > 0 ? enumMembers.length : null,
    in: opts.in ?? null,
    description: str(e['description']),
    file: doc.relPosix,
  });
}

/**
 * Descend an object schema, emitting a fact per declared property, then
 * recursing into inline sub-schemas only (never through a `$ref`).
 */
export function walkSchemaTree(
  ctx: WalkContext,
  doc: LoadedDocument,
  raw: unknown,
  pointer: string,
  depth: number,
  chain: Set<string>,
): void {
  if (depth > ctx.limits.maxSchemaDepth) {
    ctx.loader.diagnostics.push(`SCHEMA_DEPTH_EXCEEDED: ${doc.relPosix}#${pointer}`);
    return;
  }
  if (!isRecord(raw)) return;
  // A `$ref` at this position is emitted at its own pointer elsewhere.
  if (typeof raw['$ref'] === 'string') return;

  const subtreeCtx = emptySchemaContext(ctx, raw);

  const required = effectiveRequired(ctx, doc, raw, 0, chain);
  const unknownRequired = effectiveRequired(ctx, doc, raw, 0, chain, UNKNOWN_REQUIRED);

  const properties = raw['properties'];
  if (isRecord(properties)) {
    for (const name of Object.keys(properties).sort()) {
      const propPointer = pointerAppend(pointer, 'properties', name);
      const propSchema = properties[name];
      emitProperty(
        subtreeCtx, doc, propSchema, propPointer, name,
        { required: unknownRequired.has(name) ? null : required.has(name) },
        depth + 1, new Set(chain),
      );
      walkSchemaTree(subtreeCtx, doc, propSchema, propPointer, depth + 1, new Set(chain));
    }
  }

  // Arrays: descend into the element schema without minting a node for the
  // element itself; the array property already carries the element category.
  const items = raw['items'];
  if (isRecord(items)) {
    walkSchemaTree(subtreeCtx, doc, items, pointerAppend(pointer, 'items'), depth + 1, new Set(chain));
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = raw[key];
    if (!Array.isArray(branches)) continue;
    for (let i = 0; i < branches.length; i += 1) {
      const branch = branches[i];
      if (!isRecord(branch) || typeof branch['$ref'] === 'string') continue;
      walkSchemaTree(subtreeCtx, doc, branch, pointerAppend(pointer, key, String(i)), depth + 1, new Set(chain));
    }
  }

  for (const key of ['$defs', 'definitions'] as const) {
    const defs = raw[key];
    if (!isRecord(defs)) continue;
    for (const name of Object.keys(defs).sort()) {
      walkSchemaTree(subtreeCtx, doc, defs[name], pointerAppend(pointer, key, name), depth + 1, new Set(chain));
    }
  }
}
