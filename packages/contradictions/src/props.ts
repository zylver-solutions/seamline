/**
 * The fact vocabulary the detectors read.
 *
 * A detector never reads a free-form string; it reads a named property off a
 * node whose provenance is EXTRACTED or DECLARED. This module is the single
 * place those property names are written down, so an extractor author can see
 * exactly which key makes a detector able to speak, and every accessor returns
 * `undefined` rather than a default when the property is absent.
 *
 * `undefined` is load-bearing: an absent property means *the fact was not
 * extracted*, which is never evidence of a contradiction. Detectors skip on
 * `undefined`; they never substitute a default and then report the default
 * disagreeing with something.
 */

export type PropValue = string | number | boolean | null;
export type Props = Readonly<Record<string, PropValue>>;

export function strProp(p: Props, key: string): string | undefined {
  const v = p[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function numProp(p: Props, key: string): number | undefined {
  const v = p[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function boolProp(p: Props, key: string): boolean | undefined {
  const v = p[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** Comma-separated list property, normalized and sorted for determinism. */
export function listProp(p: Props, key: string): ReadonlyArray<string> | undefined {
  const raw = strProp(p, key);
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? [...parts].sort() : undefined;
}

/* ------------------------------------------------------------------ *
 * Repo facts (extract-code-ts)
 * ------------------------------------------------------------------ */

/**
 * `Repo.unknownWriterTables`: the physical tables some write may reach that the extractor
 * could not attribute to an edge.
 *
 * Unlike the other list props this one has three states, and `listProp` cannot tell them
 * apart: `[]` when the extractor measured the list and it is empty (the stored prop is
 * `''`), a sorted list of names when it is not, and `undefined` when the list was not
 * measured (no ORM index, or the walk of the unread files failed), including a prop that
 * is not a string. A reader must treat `undefined` as "any table may have an unknown
 * writer" and never as `[]`: `listProp` and `strProp` return `undefined` for `''`, so
 * `listProp(p, 'unknownWriterTables')?.includes(t)` trusts "no unknown writer" when
 * nothing was measured, which is the unsafe direction. A name that contains a comma
 * cannot round-trip through the stored text.
 */
export function unknownWriterTables(p: Props): ReadonlyArray<string> | undefined {
  const raw = p['unknownWriterTables'];
  if (typeof raw !== 'string') return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .sort();
}

/* ------------------------------------------------------------------ *
 * Column facts (extract-data)
 * ------------------------------------------------------------------ */

/** `Column.nullable`, whether the database permits NULL. */
export const columnNullable = (p: Props): boolean | undefined => boolProp(p, 'nullable');
/** `Column.hasDefault`, whether the DDL supplies a default. */
export const columnHasDefault = (p: Props): boolean | undefined => boolProp(p, 'hasDefault');
/** `Column.pii`, classification string. `'none'` is an assertion, absence is not. */
export const columnPii = (p: Props): string | undefined => strProp(p, 'pii');

/** True only when PII is affirmatively classified as something other than none. */
export function isPiiColumn(p: Props): boolean {
  const pii = columnPii(p);
  return pii !== undefined && pii !== 'none' && piiWeight(p) > 0;
}

/**
 * How much a PII label is worth as evidence.
 *
 * `extract-data` classifies PII from the column name and type, and labels the
 * verdict honestly: the `Column` node is EXTRACTED because the column really is
 * declared in the file, but `piiProvenance` is `INFERRED` for any non-none
 * category, with a calibrated `piiConfidence`. So the label is a second
 * inferred hop in the same sense the join is, and it is priced the same way.
 * Its confidence multiplies into the finding, and an LLM-suggested label is
 * worth nothing at all. Without this, X6 would report critical on a guess made
 * from a column name.
 */
export function piiWeight(p: Props): number {
  const provenance = strProp(p, 'piiProvenance');
  if (provenance === 'LLM_SUGGESTED') return 0;
  if (provenance === undefined || provenance === 'EXTRACTED' || provenance === 'DECLARED') return 1;
  const confidence = numProp(p, 'piiConfidence');
  if (confidence === undefined) return 0;
  return confidence < 0 ? 0 : confidence > 1 ? 1 : confidence;
}

/* ------------------------------------------------------------------ *
 * Contract and code facts
 * ------------------------------------------------------------------ */

/** `SchemaProperty.required`, the contract promises the property is present. */
export const propertyRequired = (p: Props): boolean | undefined => boolProp(p, 'required');
/**
 * `'request'` or `'response'` for a contract property.
 *
 * `extract-contracts` does not emit a `direction` property. It emits the
 * `jsonPointer` the property was found at, and that pointer runs through
 * `requestBody` or `responses` by construction. Deriving it here reads a fact
 * that already exists instead of demanding a new one, and an explicit
 * `direction` property still wins when some other extractor supplies one.
 */
export function propertyDirection(p: Props): string | undefined {
  const explicit = strProp(p, 'direction');
  if (explicit !== undefined) return explicit;
  const pointer = strProp(p, 'jsonPointer');
  if (pointer === undefined) return undefined;
  if (OPENAPI_RESPONSE_POINTER.test(pointer)) return 'response';
  if (OPENAPI_REQUEST_POINTER.test(pointer)) return 'request';
  return undefined;
}

/**
 * The two places an operation's bodies live: `/paths/{path}/{method}/requestBody`
 * and `/paths/{path}/{method}/responses/{status}`. Anchored, because a pointer
 * into any other dialect (a Zod property named `responses` is
 * `/properties/responses/properties/...`) must not be given a direction.
 */
const OPENAPI_RESPONSE_POINTER = /^\/paths\/[^/]+\/[^/]+\/responses\//;
const OPENAPI_REQUEST_POINTER = /^\/paths\/[^/]+\/[^/]+\/requestBody(?:\/|$)/;

/** `SchemaProperty.nullable`, the contract's separate null-ness axis. */
export const propertyNullable = (p: Props): boolean | undefined => boolProp(p, 'nullable');
/** `CodeField.optional`, the declared type permits the field to be absent. */
export const fieldOptional = (p: Props): boolean | undefined => boolProp(p, 'optional');
/**
 * `Operation.auth`, the declared authentication mode.
 *
 * `'none'` means the contract affirmatively declares the operation public.
 * `undefined` means nobody extracted an auth mode, which X6 must treat as
 * unknown rather than as "no auth". That distinction is the whole detector.
 */
export function operationAuth(p: Props): string | undefined {
  const value = strProp(p, 'auth') ?? strProp(p, 'authMode');
  // `extract-contracts` spells the unknown case as the literal `"unknown"`
  // rather than by omitting the property. Both mean the same thing here.
  return value === 'unknown' ? undefined : value;
}

/** `Migration.targetTable` / `Migration.targetColumn`, what the DDL statement names. */
export const migrationTargetTable = (p: Props): string | undefined => strProp(p, 'targetTable');
export const migrationTargetColumn = (p: Props): string | undefined => strProp(p, 'targetColumn');

/**
 * The classes of statement a `QUERIES` edge stands for.
 *
 * One edge is one (symbol, table) pair and may fold several statements. With a
 * single class the edge carries `operation`; with two or more it carries
 * `operations`, the sorted comma-separated set, and no `operation`. A reader
 * takes `operations` when present and `operation` otherwise. Values are the SQL
 * verb classes `select`, `insert`, `update`, `upsert` and `delete`, lower-cased.
 */
export function queryOperations(p: Props): ReadonlyArray<string> | undefined {
  const several = listProp(p, 'operations');
  if (several !== undefined) return several.map((o) => o.toLowerCase());
  const one = strProp(p, 'operation');
  return one === undefined ? undefined : [one.toLowerCase()];
}

/**
 * Whether a `QUERIES` edge is a write.
 *
 * `extract-code-ts` records the SQL verb class it parsed (`select`, `insert`,
 * `update`, `upsert`, `delete`) rather than a boolean, so the class is the
 * primary source and an explicit `writes` flag is honoured when an extractor
 * supplies one (an edge that folds several classes carries it). When several
 * classes are present the edge is a write if any of them is. An unrecognized
 * class returns `undefined` and the detector stays silent.
 */
const WRITE_OPERATIONS = new Set(['insert', 'update', 'delete', 'upsert', 'merge', 'replace']);
const READ_OPERATIONS = new Set(['select', 'read', 'query']);

export function queryWrites(p: Props): boolean | undefined {
  const explicit = boolProp(p, 'writes');
  if (explicit !== undefined) return explicit;
  const operations = queryOperations(p);
  if (operations === undefined) return undefined;
  if (operations.some((o) => WRITE_OPERATIONS.has(o))) return true;
  if (operations.every((o) => READ_OPERATIONS.has(o))) return false;
  return undefined;
}

/**
 * The columns a `QUERIES` edge's insert-class statements name, and whether that
 * list is complete.
 *
 * `insertColumns` is the union over the statements whose own list was complete,
 * so it is never a partial list presented as complete. `insertComplete` is the
 * AND over every insert-class statement of the edge, and an undetermined one
 * (no column list, a list the literal cuts off, a substitution in the list)
 * makes it `false`. Both are absent when the edge has no insert-class statement,
 * and an edge with an insert-class statement but no `insertComplete` must be
 * read as incomplete, never as a statement that wrote nothing. `update...` is
 * the same for update-class statements, an upsert's update branch included.
 */
export const queryInsertColumns = (p: Props): ReadonlyArray<string> | undefined => listProp(p, 'insertColumns');
export const queryInsertComplete = (p: Props): boolean | undefined => boolProp(p, 'insertComplete');
export const queryUpdateColumns = (p: Props): ReadonlyArray<string> | undefined => listProp(p, 'updateColumns');
export const queryUpdateComplete = (p: Props): boolean | undefined => boolProp(p, 'updateComplete');

/**
 * True when every statement behind the edge is a raw statement read from a
 * template literal with at least one substitution. Such an edge says which table
 * a symbol runs SQL against, and nothing about which columns: X6 does not
 * evaluate it (docs/contradictions/X6.md). Absent means some statement is not
 * of that kind.
 */
export const queryInterpolated = (p: Props): boolean | undefined => boolProp(p, 'interpolated');
export const queryColumns = (p: Props): ReadonlyArray<string> | undefined => listProp(p, 'columns');

/** `CoverageRecord.covered`, whether the record represents executed lines. */
export const coverageCovered = (p: Props): boolean | undefined => boolProp(p, 'covered');

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export const TYPE_CLASSES = [
  'string', 'number', 'integer', 'boolean', 'datetime', 'date', 'uuid', 'json', 'binary',
] as const;
export type TypeClass = (typeof TYPE_CLASSES)[number];

const TYPE_MAP: Readonly<Record<string, TypeClass>> = {
  // SQL
  text: 'string', varchar: 'string', 'character varying': 'string', char: 'string',
  character: 'string', citext: 'string', name: 'string',
  int: 'integer', int2: 'integer', int4: 'integer', int8: 'integer', integer: 'integer',
  smallint: 'integer', bigint: 'integer', serial: 'integer', bigserial: 'integer',
  numeric: 'number', decimal: 'number', real: 'number', double: 'number',
  'double precision': 'number', float: 'number', float4: 'number', float8: 'number',
  money: 'number',
  bool: 'boolean', boolean: 'boolean',
  timestamp: 'datetime', timestamptz: 'datetime', 'timestamp with time zone': 'datetime',
  'timestamp without time zone': 'datetime', datetime: 'datetime',
  date: 'date',
  uuid: 'uuid',
  json: 'json', jsonb: 'json',
  bytea: 'binary', blob: 'binary',
  // TypeScript
  Date: 'datetime',
  Buffer: 'binary', Uint8Array: 'binary',
  // TypeScript and JSON Schema primitives
  string: 'string', number: 'number',
  // JSON Schema / OpenAPI
  object: 'json', array: 'json',
};

/**
 * Map a raw declared type onto a comparison class, or `undefined` when the
 * type is not recognized.
 *
 * `undefined` suppresses X2 for that pair. That is deliberate: an unrecognized
 * type is a limitation of this table, and a limitation of this table must not
 * be reported to a developer as a disagreement in their code.
 */
export function classifyType(raw: string | undefined): TypeClass | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t.length === 0) return undefined;
  // Arrays, unions, generics and `any`/`unknown` are deliberately unclassified.
  if (/[[\]<>|&]/.test(t)) return undefined;
  const direct = TYPE_MAP[t];
  if (direct !== undefined) return direct;
  const lower = t.toLowerCase();
  const byLower = TYPE_MAP[lower];
  if (byLower !== undefined) return byLower;
  // varchar(255), numeric(10,2), timestamp(3)
  const parenless = lower.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (parenless !== lower) {
    const byParenless = TYPE_MAP[parenless];
    if (byParenless !== undefined) return byParenless;
  }
  return undefined;
}

/** Classify a contract property, honouring `format` (e.g. `string`/`date-time`). */
export function classifyContractType(p: Props): TypeClass | undefined {
  const format = strProp(p, 'format');
  if (format === 'date-time') return 'datetime';
  if (format === 'date') return 'date';
  if (format === 'uuid') return 'uuid';
  if (format === 'binary' || format === 'byte') return 'binary';
  return classifyType(strProp(p, 'type'));
}

const COMPATIBLE: Readonly<Record<TypeClass, ReadonlyArray<TypeClass>>> = {
  string: ['string', 'uuid', 'date', 'datetime'],
  number: ['number', 'integer'],
  integer: ['integer', 'number'],
  boolean: ['boolean'],
  datetime: ['datetime', 'date', 'string'],
  date: ['date', 'datetime', 'string'],
  uuid: ['uuid', 'string'],
  json: ['json'],
  binary: ['binary', 'string'],
};

/** Symmetric: two classes disagree only when neither can represent the other. */
export function typesCompatible(a: TypeClass, b: TypeClass): boolean {
  return COMPATIBLE[a].includes(b) || COMPATIBLE[b].includes(a);
}

/* ------------------------------------------------------------------ *
 * Constraints
 * ------------------------------------------------------------------ */

/**
 * Constraint dimensions that *both* a relational column and a validator can
 * express. X7 compares presence across this set only; a dimension a database
 * cannot state (regex, format, cross-field rules) is excluded by construction,
 * because "the validator checks an email format and Postgres does not" is not
 * a disagreement, it is how the two layers differ everywhere.
 */
export const CONSTRAINT_DIMENSIONS = [
  'required', 'maxLength', 'minLength', 'minimum', 'maximum', 'enum',
] as const;
export type ConstraintDimension = (typeof CONSTRAINT_DIMENSIONS)[number];

export type ConstraintValue = string | number | boolean;

function readDimension(p: Props, d: ConstraintDimension): ConstraintValue | undefined {
  if (d === 'enum') {
    const list = listProp(p, 'enum');
    return list === undefined ? undefined : list.join(',');
  }
  if (d === 'required') return boolProp(p, 'required');
  return numProp(p, d);
}

/** Constraints a column asserts. `nullable` is the column's way of saying `required`. */
export function columnConstraints(p: Props): ReadonlyMap<ConstraintDimension, ConstraintValue> {
  const out = new Map<ConstraintDimension, ConstraintValue>();
  const nullable = columnNullable(p);
  if (nullable !== undefined) out.set('required', !nullable);
  for (const d of CONSTRAINT_DIMENSIONS) {
    if (d === 'required') continue;
    const v = readDimension(p, d);
    if (v !== undefined) out.set(d, v);
  }
  return out;
}

/** Constraints a validator symbol asserts, read from the same dimension names. */
export function validatorConstraints(p: Props): ReadonlyMap<ConstraintDimension, ConstraintValue> {
  const out = new Map<ConstraintDimension, ConstraintValue>();
  for (const d of CONSTRAINT_DIMENSIONS) {
    const v = readDimension(p, d);
    if (v !== undefined) out.set(d, v);
  }
  return out;
}

/**
 * True when the validator enumerated its rules at all.
 *
 * Without this guard, a validator symbol that some extractor emitted with no
 * constraint properties would look like "enforces nothing", and X7 would
 * report every column constraint as unenforced. That is absence masquerading
 * as a fact, which is precisely what this package exists to not do.
 */
export function validatorIsEnumerated(p: Props): boolean {
  return boolProp(p, 'constraintsEnumerated') === true || validatorConstraints(p).size > 0;
}
