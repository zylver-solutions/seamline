/**
 * Prisma schema reader.
 *
 * Prisma's grammar is small and block-structured, so this is a block scanner
 * rather than a token parser. What it has to get right is the mapping from
 * Prisma's abstract scalar types to the physical Postgres types the SQL and
 * Drizzle readers produce, because `infer-join` and the X1/X2 detectors
 * compare a Prisma-derived column against a code field exactly as they would a
 * DDL-derived one — a Prisma-only repo must not systematically disagree with
 * an equivalent SQL one.
 *
 * A `String` field is `text`, not "String". A `?` is `NULL`. A relation field
 * is not a column at all; the scalar it names in `@relation(fields: [...])` is.
 */

import { makeLineIndex } from '@seamline/core/sql';
import { normalizeSqlType } from './normalize-type.ts';
import type { ColumnPatch, SchemaModel, SourceRef } from './model.ts';

const SOURCE = 'prisma' as const;

/** Prisma scalar -> Postgres type when no `@db.*` native type is given. */
const DEFAULT_SCALARS: Readonly<Record<string, string>> = {
  String: 'text',
  Boolean: 'boolean',
  Int: 'integer',
  BigInt: 'bigint',
  Float: 'double precision',
  Decimal: 'numeric(65,30)',
  DateTime: 'timestamp(3)',
  Json: 'jsonb',
  Bytes: 'bytea',
};

/**
 * `@db.X` native type -> Postgres base type, with the parameter appended.
 *
 * The short spellings (`varchar`, `timestamptz`) are deliberate: they are what
 * `normalizeSqlType` also receives from the Drizzle reader, so `declaredType`
 * as well as `type` converges across the two sources for an equivalent schema.
 */
const NATIVE_TYPES: Readonly<Record<string, string>> = {
  uuid: 'uuid',
  varchar: 'varchar',
  char: 'char',
  text: 'text',
  citext: 'citext',
  integer: 'integer',
  int: 'integer',
  smallint: 'smallint',
  bigint: 'bigint',
  oid: 'oid',
  decimal: 'numeric',
  money: 'money',
  real: 'real',
  doubleprecision: 'double precision',
  boolean: 'boolean',
  timestamp: 'timestamp',
  timestamptz: 'timestamptz',
  date: 'date',
  time: 'time',
  timetz: 'timetz',
  json: 'json',
  jsonb: 'jsonb',
  bytea: 'bytea',
  inet: 'inet',
  xml: 'xml',
  bit: 'bit',
  varbit: 'varbit',
};

interface Block {
  readonly kind: string;
  readonly name: string;
  readonly body: string;
  readonly pos: number;
}

/** Splits a Prisma file into top-level blocks. */
function readBlocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /^[ \t]*(model|enum|datasource|generator|type|view)[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\{/gmu;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const openAt = text.indexOf('{', m.index);
    let depth = 0;
    let i = openAt;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push({ kind: m[1] as string, name: m[2] as string, body: text.slice(openAt + 1, i), pos: m.index });
    re.lastIndex = i + 1;
    m = re.exec(text);
  }
  return out;
}

interface Attr {
  readonly name: string;
  readonly args: string;
}

/** Reads `@name(args)` / `@@name(args)` attributes from one field or block. */
function readAttrs(s: string): Attr[] {
  const out: Attr[] = [];
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '@') continue;
    let j = i + 1;
    if (s[j] === '@') j += 1;
    const start = j;
    while (j < s.length && /[A-Za-z0-9_.]/u.test(s[j] as string)) j += 1;
    const name = s.slice(start, j);
    let args = '';
    if (s[j] === '(') {
      let depth = 0;
      let k = j;
      for (; k < s.length; k += 1) {
        const c = s[k];
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      args = s.slice(j + 1, k);
      j = k + 1;
    }
    out.push({ name, args });
    i = j - 1;
  }
  return out;
}

function attr(attrs: readonly Attr[], name: string): Attr | undefined {
  return attrs.find((a) => a.name === name);
}

function firstString(s: string): string | null {
  const m = /"([^"]*)"/u.exec(s);
  return m === null ? null : (m[1] as string);
}

/** Names inside a `[a, b]` list. */
function bracketList(s: string): string[] {
  const m = /\[([^\]]*)\]/u.exec(s);
  if (m === null) return [];
  return (m[1] as string)
    .split(',')
    .map((x) => x.trim().replace(/^"|"$/gu, ''))
    .filter((x) => x.length > 0);
}

interface FieldLine {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly list: boolean;
  readonly attrs: readonly Attr[];
  readonly doc: string | null;
  readonly line: number;
}

/** Parses the field lines of a `model` body, keeping `///` docs attached. */
function readFields(body: string, bodyStart: number, lineOf: (pos: number) => number): FieldLine[] {
  const out: FieldLine[] = [];
  let pendingDoc: string | null = null;
  let offset = 0;
  for (const rawLine of body.split('\n')) {
    const at = bodyStart + offset;
    offset += rawLine.length + 1;
    const line = rawLine.trim();
    if (line.startsWith('///')) {
      pendingDoc = line.slice(3).trim();
      continue;
    }
    if (line.startsWith('//') || line.length === 0) continue;
    if (line.startsWith('@@')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?(.*)$/u.exec(line);
    if (m === null) {
      pendingDoc = null;
      continue;
    }
    const rest = (m[5] ?? '').split('//')[0] ?? '';
    out.push({
      name: m[1] as string,
      type: m[2] as string,
      list: m[3] !== undefined,
      optional: m[4] !== undefined,
      attrs: readAttrs(rest),
      doc: pendingDoc,
      line: lineOf(at),
    });
    pendingDoc = null;
  }
  return out;
}

/**
 * Prisma evaluates these in the client, so no database default exists and a raw
 * SQL insert does not receive the value. Every other `@default` is written into
 * the migration (a constant, `now()`, `autoincrement()`, `dbgenerated(...)`,
 * `sequence()`), which is what makes it the database's.
 */
const CLIENT_GENERATED = /^\s*(?:cuid|uuid|ulid|nanoid)\s*\(/u;

/** Resolves the physical Postgres type for one scalar field. */
function physicalType(field: FieldLine, isEnum: boolean): string | null {
  if (isEnum) return field.type.toLowerCase();
  const native = field.attrs.find((a) => a.name.startsWith('db.'));
  if (native !== undefined) {
    const key = native.name.slice(3).toLowerCase();
    const base = NATIVE_TYPES[key];
    if (base !== undefined) {
      const params = native.args.trim();
      return params.length === 0 ? base : `${base}(${params.replace(/\s+/gu, '')})`;
    }
  }
  return DEFAULT_SCALARS[field.type] ?? null;
}

/**
 * Applies one `schema.prisma`.
 *
 * @returns the number of models turned into tables.
 */
export function applyPrismaFile(model: SchemaModel, text: string, path: string): number {
  const lineOf = makeLineIndex(text);
  const blocks = readBlocks(text);

  const modelNames = new Set(blocks.filter((b) => b.kind === 'model' || b.kind === 'view').map((b) => b.name));
  const enumNames = new Set(blocks.filter((b) => b.kind === 'enum').map((b) => b.name));
  for (const e of enumNames) model.registerEnumType(e.toLowerCase());

  // `datasource` may declare extra schemas; the default stays `public`.
  const datasource = blocks.find((b) => b.kind === 'datasource');
  if (datasource !== undefined) {
    for (const s of bracketList(/schemas\s*=\s*(\[[^\]]*\])/u.exec(datasource.body)?.[1] ?? '')) {
      model.ensureSchema(s, { path, line: lineOf(datasource.pos), sourceKind: SOURCE });
    }
  }

  // Physical table name per model, needed before relations can be resolved.
  const tableOf = new Map<string, { schema: string; table: string }>();
  const columnOf = new Map<string, Map<string, string>>();

  let tableCount = 0;
  for (const block of blocks) {
    if (block.kind !== 'model' && block.kind !== 'view') continue;
    const blockAttrs = readAttrs(block.body.split('\n').filter((l) => l.trim().startsWith('@@')).join('\n'));
    const mapped = attr(blockAttrs, 'map');
    const schemaAttr = attr(blockAttrs, 'schema');
    const table = mapped === undefined ? block.name : (firstString(mapped.args) ?? block.name);
    const schema = schemaAttr === undefined ? model.defaultSchema : (firstString(schemaAttr.args) ?? model.defaultSchema);
    tableOf.set(block.name, { schema, table });
    const ref: SourceRef = { path, line: lineOf(block.pos), sourceKind: SOURCE };
    model.ensureTable(schema, table, ref, true);
    model.recordOrmName(schema, table, 'prisma', block.name);
    tableCount += 1;

    const bodyStart = text.indexOf('{', block.pos) + 1;
    const fields = readFields(block.body, bodyStart, lineOf);
    const keyToColumn = new Map<string, string>();
    columnOf.set(block.name, keyToColumn);

    for (const field of fields) {
      if (modelNames.has(field.type)) continue; // relation field, not a column
      const isEnum = enumNames.has(field.type);
      const base = physicalType(field, isEnum);
      if (base === null) continue;
      const mapAttr = attr(field.attrs, 'map');
      const physical = mapAttr === undefined ? field.name : (firstString(mapAttr.args) ?? field.name);
      const isId = attr(field.attrs, 'id') !== undefined;
      const isUnique = attr(field.attrs, 'unique') !== undefined;
      const defaultAttr = attr(field.attrs, 'default');
      const updatedAt = attr(field.attrs, 'updatedAt') !== undefined;

      const n = normalizeSqlType(field.list ? `${base}[]` : base, model.enumTypes);
      const patch: ColumnPatch = {
        declaredType: n.declaredType,
        type: n.type,
        category: n.category,
        isArray: n.isArray,
        maxLength: n.maxLength,
        numericPrecision: n.numericPrecision,
        numericScale: n.numericScale,
        nullable: isId ? false : field.optional,
      };
      if (defaultAttr !== undefined) {
        if (CLIENT_GENERATED.test(defaultAttr.args)) patch.clientDefault = true;
        else patch.dbDefault = true;
        patch.defaultExpr = defaultAttr.args.trim();
      }
      if (updatedAt) {
        // Prisma sets the value on every create and update, but writes no
        // database default for it: `@default(now())` beside it does.
        patch.clientDefault = true;
        if (defaultAttr === undefined) patch.defaultExpr = 'now()';
      }
      // A scalar list is optional on create, yet it reads `nullable = false`
      // because the field is not marked `?`. Prisma Migrate creates the column
      // as a nullable array (`"tags" TEXT[]`), so a statement that omits it
      // stores NULL and succeeds, raw SQL included: the database supplies the
      // value, and it is not the ORM's to supply. That is `db`, not `client`,
      // which would leave a raw insert that omits it reported. It is a flag of
      // its own and not a `dbDefault`, so a later `DROP DEFAULT` (what Prisma
      // emits when `@default([])` is removed) cannot erase it; only a migration
      // that declares the column NOT NULL does.
      if (field.list) patch.scalarList = true;
      if (isId) patch.isPrimaryKey = true;
      if (isUnique) patch.isUnique = true;
      if (field.doc !== null) patch.comment = field.doc;

      model.upsertColumn(schema, table, physical, patch, { path, line: field.line, sourceKind: SOURCE });
      keyToColumn.set(field.name, physical);
    }

    // Block-level composite keys, applied after every column exists.
    const idAttr = attr(blockAttrs, 'id');
    if (idAttr !== undefined) {
      for (const key of bracketList(idAttr.args)) {
        const col = keyToColumn.get(key);
        if (col !== undefined) model.upsertColumn(schema, table, col, { isPrimaryKey: true }, ref);
      }
    }
    for (const a of blockAttrs) {
      if (a.name !== 'unique') continue;
      const keys = bracketList(a.args);
      if (keys.length !== 1) continue;
      const col = keyToColumn.get(keys[0] as string);
      if (col !== undefined) model.upsertColumn(schema, table, col, { isUnique: true }, ref);
    }
  }

  // Second pass: relations, once every model's physical names are known.
  for (const block of blocks) {
    if (block.kind !== 'model' && block.kind !== 'view') continue;
    const self = tableOf.get(block.name);
    if (self === undefined) continue;
    const bodyStart = text.indexOf('{', block.pos) + 1;
    for (const field of readFields(block.body, bodyStart, lineOf)) {
      const rel = attr(field.attrs, 'relation');
      if (rel === undefined || !modelNames.has(field.type)) continue;
      const fieldsArg = /fields\s*:\s*\[([^\]]*)\]/u.exec(rel.args);
      const refsArg = /references\s*:\s*\[([^\]]*)\]/u.exec(rel.args);
      if (fieldsArg === null || refsArg === null) continue;
      const localKeys = bracketList(`[${fieldsArg[1] as string}]`);
      const refKeys = bracketList(`[${refsArg[1] as string}]`);
      const target = tableOf.get(field.type);
      if (target === undefined || localKeys.length !== refKeys.length) continue;
      const localCols = localKeys
        .map((k) => columnOf.get(block.name)?.get(k))
        .filter((c): c is string => c !== undefined);
      const refCols = refKeys
        .map((k) => columnOf.get(field.type)?.get(k))
        .filter((c): c is string => c !== undefined);
      if (localCols.length === 0 || localCols.length !== refCols.length) continue;
      const onDelete = /onDelete\s*:\s*([A-Za-z]+)/u.exec(rel.args)?.[1] ?? null;
      const onUpdate = /onUpdate\s*:\s*([A-Za-z]+)/u.exec(rel.args)?.[1] ?? null;
      model.addForeignKey({
        name: null,
        schema: self.schema,
        table: self.table,
        columns: localCols,
        refSchema: target.schema,
        refTable: target.table,
        refColumns: refCols,
        onDelete: onDelete === null ? null : onDelete.toUpperCase(),
        onUpdate: onUpdate === null ? null : onUpdate.toUpperCase(),
        path,
        line: field.line,
      });
    }
  }

  return tableCount;
}
