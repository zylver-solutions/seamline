/**
 * Drizzle schema reader.
 *
 * Reads `pgTable`, `pgSchema(...).table`, `pgEnum`, the builder chain on each
 * column, and the third-argument table extras (`primaryKey`, `uniqueIndex`,
 * `foreignKey`, `check`).
 *
 * Cross-table `.references(() => other.column)` cannot be resolved while
 * reading one file, because the target may live in another module. Those are
 * queued and resolved once every Drizzle file has been read.
 *
 * Resolution uses the importing module's own binding, so two modules that
 * export one variable name cannot change the target by being read in a
 * different order (Drizzle foreign-key binding order). An import is followed from its specifier,
 * resolved relative to the importing file, to that module's export. Otherwise
 * a declaration in the same module is used. The variable name across modules
 * is used only when every binding of that name is the same table. Anything
 * else is left unresolved: no edge, and a diagnostic.
 */

import { posix } from 'node:path';
import { type Tok, isGroup, makeLineIndex, splitOn } from '@seamline/core/sql';
import { tokenizeTs, type TsComment } from './ts-lex.ts';
import { TS_EXTENSIONS } from './discover.ts';
import { normalizeSqlType } from './normalize-type.ts';
import type { ColumnPatch, SchemaModel, SourceRef } from './model.ts';

const SOURCE = 'drizzle' as const;

interface TableBinding {
  readonly schema: string;
  readonly table: string;
  /** Object-literal key -> physical column name. */
  readonly keyToColumn: Map<string, string>;
}

interface PendingRef {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly targetVar: string;
  /** `s` in `s.users.id`: the name a namespace import binds, when the target is reached through one. */
  readonly targetNamespace: string | null;
  readonly targetKey: string;
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
  readonly path: string;
  readonly line: number;
}

/** A name brought into a module by an `import` clause. */
interface ImportBinding {
  /** Name of the export in the module the specifier points at; `*` for `import * as ns`. */
  readonly imported: string;
  readonly specifier: string;
  /** `import type` binds the name and does not refer to a table value. */
  readonly typeOnly: boolean;
}

/** `export { name } from '...'`: this module's export, defined in another module. */
interface ReexportBinding {
  readonly imported: string;
  readonly specifier: string;
}

interface DrizzleModule {
  readonly path: string;
  /** Const name declared in this file -> the table it builds. */
  readonly locals: Map<string, TableBinding>;
  /** Export name -> const name declared in this file. */
  readonly localExports: Map<string, string>;
  readonly reexports: Map<string, ReexportBinding>;
  /** Specifiers of `export * from '...'`, in source order. */
  readonly starExports: string[];
  readonly imports: Map<string, ImportBinding>;
  readonly ambiguousImports: Set<string>;
  readonly ambiguousExports: Set<string>;
}

interface ModuleLinks {
  readonly imports: Map<string, ImportBinding>;
  readonly ambiguousImports: Set<string>;
  readonly localExports: Map<string, string>;
  readonly reexports: Map<string, ReexportBinding>;
  readonly starExports: string[];
  readonly ambiguousExports: Set<string>;
}

interface NamedBinding {
  readonly local: string;
  readonly imported: string;
  readonly typeOnly: boolean;
}

export interface DrizzleRegistry {
  /** Every table a variable name builds, in the order the modules were read. */
  readonly tablesByVar: Map<string, TableBinding[]>;
  readonly modules: Map<string, DrizzleModule>;
  readonly pendingRefs: PendingRef[];
}

export function createDrizzleRegistry(): DrizzleRegistry {
  return { tablesByVar: new Map(), modules: new Map(), pendingRefs: [] };
}

/**
 * A relative specifier, resolved against the modules this run actually read.
 * Extensionless specifiers try the extensions discovery treats as modules, then
 * an `index` file. A `.js` specifier also tries the TypeScript file it would
 * be emitted from. Two matches are ambiguous: the caller must not pick one.
 */
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

function resolveModuleSpecifier(
  fromPath: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | 'ambiguous' | null {
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  if (base === '..' || base.startsWith('../') || base === '') return null;
  if (known.has(base)) return base;

  const ext = posix.extname(base);
  const stem = ext === '' ? base : base.slice(0, -ext.length);
  const extensions = ext === '' ? TS_EXTENSIONS : (JS_TO_TS[ext] ?? []);
  const files = extensions.map((suffix) => `${stem}${suffix}`).filter((p) => known.has(p));
  if (files.length > 1) return 'ambiguous';
  const file = files[0];
  if (file !== undefined) return file;
  if (ext !== '') return null;

  const indexes = TS_EXTENSIONS.map((suffix) => posix.join(base, `index${suffix}`)).filter((p) =>
    known.has(p),
  );
  if (indexes.length > 1) return 'ambiguous';
  return indexes[0] ?? null;
}

function rememberImport(
  map: Map<string, ImportBinding>,
  ambiguous: Set<string>,
  local: string,
  binding: ImportBinding,
): void {
  if (ambiguous.has(local)) return;
  const prev = map.get(local);
  if (prev === undefined) {
    map.set(local, binding);
    return;
  }
  if (
    prev.specifier !== binding.specifier ||
    prev.imported !== binding.imported ||
    prev.typeOnly !== binding.typeOnly
  ) {
    map.delete(local);
    ambiguous.add(local);
  }
}

function rememberExport(
  map: Map<string, string>,
  ambiguous: Set<string>,
  exportName: string,
  localName: string,
): void {
  if (ambiguous.has(exportName)) return;
  const prev = map.get(exportName);
  if (prev === undefined) {
    map.set(exportName, localName);
    return;
  }
  if (prev !== localName) {
    map.delete(exportName);
    ambiguous.add(exportName);
  }
}

function rememberReexport(
  map: Map<string, ReexportBinding>,
  ambiguous: Set<string>,
  exportName: string,
  binding: ReexportBinding,
): void {
  if (ambiguous.has(exportName)) return;
  const prev = map.get(exportName);
  if (prev === undefined) {
    map.set(exportName, binding);
    return;
  }
  if (prev.imported !== binding.imported || prev.specifier !== binding.specifier) {
    map.delete(exportName);
    ambiguous.add(exportName);
  }
}

/** `{ a, b as c, type d }` inside an import or export clause. */
function namedBindings(items: readonly Tok[], clauseTypeOnly: boolean): NamedBinding[] {
  const out: NamedBinding[] = [];
  for (const part of splitOn(items, ',')) {
    const words = part.filter((t) => t.t === 'word');
    const first = words[0];
    if (first === undefined) continue;
    let idx = 0;
    let typeOnly = clauseTypeOnly;
    if (first.v === 'type') {
      typeOnly = true;
      idx = 1;
    }
    const imported = words[idx];
    if (imported === undefined) continue;
    const alias = words[idx + 1]?.v === 'as' ? words[idx + 2] : undefined;
    out.push({
      local: alias === undefined ? imported.v : alias.v,
      imported: imported.v,
      typeOnly,
    });
  }
  return out;
}

/** `import * as ns from '...'`; `star` indexes the `*`. */
function readNamespaceImport(
  toks: readonly Tok[],
  star: number,
  imports: Map<string, ImportBinding>,
  ambiguous: Set<string>,
): void {
  const as = toks[star + 1];
  const local = toks[star + 2];
  const from = toks[star + 3];
  const spec = toks[star + 4];
  if (as?.t !== 'word' || as.v !== 'as' || local?.t !== 'word') return;
  if (from?.t !== 'word' || from.v !== 'from') return;
  if (spec === undefined || spec.t !== 'str' || spec.v === '') return;
  rememberImport(imports, ambiguous, local.v, {
    imported: '*',
    specifier: spec.v,
    typeOnly: false,
  });
}

function readImport(
  toks: readonly Tok[],
  i: number,
  imports: Map<string, ImportBinding>,
  ambiguous: Set<string>,
): void {
  let j = i + 1;
  const next = toks[j];
  if (next === undefined || next.t === 'str') return;
  if (next.t === 'punct' && next.v === '*') {
    readNamespaceImport(toks, j, imports, ambiguous);
    return;
  }

  let typeOnly = false;
  if (next.t === 'word' && next.v === 'type') {
    typeOnly = true;
    j += 1;
  }

  const bindings: NamedBinding[] = [];
  const head = toks[j];
  if (!typeOnly && head !== undefined && head.t === 'word') {
    bindings.push({ local: head.v, imported: 'default', typeOnly: false });
    j += 1;
    if (toks[j]?.t === 'punct' && toks[j]?.v === ',') j += 1;
  }

  const brace = toks[j];
  if (brace !== undefined && brace.t === 'group' && brace.v === '{') {
    bindings.push(...namedBindings(brace.items, typeOnly));
    j += 1;
  }

  if (toks[j]?.t !== 'word' || toks[j]?.v !== 'from') return;
  j += 1;
  const spec = toks[j];
  if (spec === undefined || spec.t !== 'str' || spec.v === '') return;
  for (const binding of bindings) {
    rememberImport(imports, ambiguous, binding.local, {
      imported: binding.imported,
      specifier: spec.v,
      typeOnly: binding.typeOnly,
    });
  }
}

function readExport(toks: readonly Tok[], i: number, links: ModuleLinks): void {
  const next = toks[i + 1];
  if (next === undefined) return;
  if (next.t === 'word' && next.v === 'type') return;
  if (next.t === 'punct' && next.v === '*') {
    // `export * from '...'`; `export * as ns from` binds one namespace name, not the names inside.
    const from = toks[i + 2];
    const spec = toks[i + 3];
    if (from?.t === 'word' && from.v === 'from' && spec?.t === 'str' && spec.v !== '') {
      links.starExports.push(spec.v);
    }
    return;
  }
  if (next.t === 'word' && next.v === 'default') {
    const name = toks[i + 2];
    if (
      name !== undefined &&
      name.t === 'word' &&
      name.v !== 'function' &&
      name.v !== 'class' &&
      name.v !== 'async'
    ) {
      rememberExport(links.localExports, links.ambiguousExports, 'default', name.v);
    }
    return;
  }
  if (next.t !== 'group' || next.v !== '{') return;
  const names = namedBindings(next.items, false).filter((binding) => !binding.typeOnly);
  const from = toks[i + 2];
  if (from !== undefined && from.t === 'word' && from.v === 'from') {
    const spec = toks[i + 3];
    if (spec === undefined || spec.t !== 'str' || spec.v === '') return;
    for (const binding of names) {
      rememberReexport(links.reexports, links.ambiguousExports, binding.local, {
        imported: binding.imported,
        specifier: spec.v,
      });
    }
    return;
  }
  for (const binding of names) {
    rememberExport(links.localExports, links.ambiguousExports, binding.local, binding.imported);
  }
}

/** Top-level import and export clauses. A binding inside a function is not a module binding. */
function collectModuleLinks(toks: readonly Tok[]): ModuleLinks {
  const links: ModuleLinks = {
    imports: new Map(),
    ambiguousImports: new Set(),
    localExports: new Map(),
    reexports: new Map(),
    starExports: [],
    ambiguousExports: new Set(),
  };
  for (let i = 0; i < toks.length; i += 1) {
    const tok = toks[i];
    if (tok === undefined || tok.t !== 'word') continue;
    if (tok.v === 'import') readImport(toks, i, links.imports, links.ambiguousImports);
    else if (tok.v === 'export') readExport(toks, i, links);
  }
  return links;
}

/** True when the called binding is `export const name = ...` (also `let` / `var`). */
function bindingIsExported(list: readonly Tok[], callIndex: number): boolean {
  let start = callIndex;
  while (start >= 2) {
    const dot = list[start - 1];
    const owner = list[start - 2];
    if (dot === undefined || owner === undefined) return false;
    if (dot.t !== 'punct' || dot.v !== '.' || owner.t !== 'word') break;
    start -= 2;
  }
  const keyword = list[start - 3];
  const exported = list[start - 4];
  if (keyword === undefined || exported === undefined) return false;
  const declaration =
    keyword.t === 'word' && (keyword.v === 'const' || keyword.v === 'let' || keyword.v === 'var');
  return declaration && exported.t === 'word' && exported.v === 'export';
}

function recordBinding(
  reg: DrizzleRegistry,
  moduleRec: DrizzleModule,
  constName: string,
  binding: TableBinding,
  exported: boolean,
): void {
  moduleRec.locals.set(constName, binding);
  const bound = reg.tablesByVar.get(constName);
  if (bound === undefined) reg.tablesByVar.set(constName, [binding]);
  else bound.push(binding);
  if (exported) {
    rememberExport(moduleRec.localExports, moduleRec.ambiguousExports, constName, constName);
  }
}

/** Drizzle column builder -> SQL base type. `null` means "not modelled". */
const TYPE_FUNCS: Readonly<Record<string, string>> = {
  uuid: 'uuid',
  varchar: 'varchar',
  char: 'char',
  text: 'text',
  citext: 'citext',
  integer: 'integer',
  int: 'integer',
  smallint: 'smallint',
  bigint: 'bigint',
  serial: 'serial',
  smallserial: 'smallserial',
  bigserial: 'bigserial',
  boolean: 'boolean',
  timestamp: 'timestamp',
  date: 'date',
  time: 'time',
  numeric: 'numeric',
  decimal: 'numeric',
  real: 'real',
  doublePrecision: 'double precision',
  json: 'json',
  jsonb: 'jsonb',
  interval: 'interval',
  inet: 'inet',
  cidr: 'cidr',
  macaddr: 'macaddr',
  macaddr8: 'macaddr8',
  bytea: 'bytea',
  vector: 'vector',
  point: 'point',
  line: 'line',
};

/**
 * Chain methods that give the column a default the database supplies, because
 * `drizzle-kit` writes them into the migration.
 */
const DB_DEFAULT_METHODS: ReadonlySet<string> = new Set([
  'default',
  'defaultNow',
  'defaultRandom',
  'generatedAlwaysAs',
  'generatedAlwaysAsIdentity',
  'generatedByDefaultAsIdentity',
]);

/**
 * Chain methods whose function Drizzle runs in the client when it builds the
 * statement. `$onUpdate` and `$onUpdateFn` also supply the value on insert when
 * no other default exists, so they count as defaults here.
 */
const CLIENT_DEFAULT_METHODS: ReadonlySet<string> = new Set([
  '$default',
  '$defaultFn',
  '$onUpdate',
  '$onUpdateFn',
]);

export function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .toLowerCase();
}

/** Splits an object-literal group into key -> value tokens. */
function objectEntries(g: Tok): Map<string, Tok[]> {
  const out = new Map<string, Tok[]>();
  for (const entry of splitOn(g.items, ',')) {
    const head = entry[0];
    if (head === undefined) continue;
    if (head.t !== 'word' && head.t !== 'str') continue;
    const colon = entry[1];
    if (colon === undefined || colon.t !== 'punct' || colon.v !== ':') continue;
    out.set(head.v, entry.slice(2));
  }
  return out;
}

function numberOpt(opts: Map<string, Tok[]> | null, key: string): number | null {
  const v = opts?.get(key);
  const first = v?.[0];
  if (first === undefined || first.t !== 'num') return null;
  const n = Number.parseInt(first.v, 10);
  return Number.isFinite(n) ? n : null;
}

function boolOpt(opts: Map<string, Tok[]> | null, key: string): boolean {
  const v = opts?.get(key);
  const first = v?.[0];
  return first !== undefined && first.t === 'word' && first.v === 'true';
}

function stringOpt(opts: Map<string, Tok[]> | null, key: string): string | null {
  const v = opts?.get(key);
  const first = v?.[0];
  return first !== undefined && first.t === 'str' ? first.v : null;
}

interface ChainLink {
  readonly method: string;
  readonly args: Tok | null;
}

interface Builder {
  readonly func: string;
  readonly args: Tok | null;
  readonly chain: readonly ChainLink[];
}

/** Parses `fn(args).a().b()` from a token list. */
function parseBuilder(toks: readonly Tok[]): Builder | null {
  const head = toks[0];
  if (head === undefined || head.t !== 'word') return null;
  let i = 1;
  let args: Tok | null = null;
  if (isGroup(toks, i, '(')) {
    args = toks[i] as Tok;
    i += 1;
  }
  const chain: ChainLink[] = [];
  while (i < toks.length) {
    const dot = toks[i];
    if (dot === undefined || dot.t !== 'punct' || dot.v !== '.') break;
    const name = toks[i + 1];
    if (name === undefined || name.t !== 'word') break;
    i += 2;
    // Skip an explicit type argument: `.$type<Foo>()`.
    if (toks[i] !== undefined && (toks[i] as Tok).t === 'punct' && (toks[i] as Tok).v === '<') {
      let depth = 0;
      while (i < toks.length) {
        const t = toks[i] as Tok;
        if (t.t === 'punct' && t.v === '<') depth += 1;
        else if (t.t === 'punct' && t.v === '>') {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        i += 1;
      }
    }
    let callArgs: Tok | null = null;
    if (isGroup(toks, i, '(')) {
      callArgs = toks[i] as Tok;
      i += 1;
    }
    chain.push({ method: name.v, args: callArgs });
  }
  return { func: head.v, args, chain };
}

/** Finds the last `obj.prop` pair in a token list. */
function lastMemberRef(
  toks: readonly Tok[],
): { obj: string; prop: string; ns: string | null } | null {
  let found: { obj: string; prop: string; ns: string | null } | null = null;
  for (let i = 0; i + 2 < toks.length; i += 1) {
    const a = toks[i];
    const b = toks[i + 1];
    const c = toks[i + 2];
    if (a === undefined || b === undefined || c === undefined) break;
    if (a.t === 'word' && b.t === 'punct' && b.v === '.' && c.t === 'word') {
      const before = toks[i - 1];
      const owner = toks[i - 2];
      const ns = before?.t === 'punct' && before.v === '.' && owner?.t === 'word' ? owner.v : null;
      found = { obj: a.v, prop: c.v, ns };
    }
  }
  return found;
}

/** Collects every `x.prop` property name in a token tree. */
function memberProps(toks: readonly Tok[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly Tok[]): void => {
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i] as Tok;
      if (t.t === 'group') {
        walk(t.items);
        continue;
      }
      const b = list[i + 1];
      const c = list[i + 2];
      if (
        t.t === 'word' &&
        b !== undefined &&
        b.t === 'punct' &&
        b.v === '.' &&
        c !== undefined &&
        c.t === 'word'
      ) {
        if (!out.includes(c.v)) out.push(c.v);
      }
    }
  };
  walk(toks);
  return out;
}

function flatten(toks: readonly Tok[]): Tok[] {
  const out: Tok[] = [];
  const walk = (list: readonly Tok[]): void => {
    for (const t of list) {
      out.push(t);
      if (t.t === 'group') walk(t.items);
    }
  };
  walk(toks);
  return out;
}

function hasWord(toks: readonly Tok[], name: string): boolean {
  return flatten(toks).some((t) => t.t === 'word' && t.v === name);
}

/** Renders a Drizzle builder call as the SQL type it produces. */
function drizzleSqlType(
  func: string,
  opts: Map<string, Tok[]> | null,
  enumTypeName: string | null,
): string | null {
  if (enumTypeName !== null) return enumTypeName;
  const base = TYPE_FUNCS[func];
  if (base === undefined) return null;
  if (base === 'varchar' || base === 'char' || base === 'citext') {
    const len = numberOpt(opts, 'length');
    return len === null ? base : `${base}(${len})`;
  }
  if (base === 'numeric') {
    const p = numberOpt(opts, 'precision');
    const s = numberOpt(opts, 'scale');
    if (p === null) return 'numeric';
    return s === null ? `numeric(${p})` : `numeric(${p},${s})`;
  }
  if (base === 'timestamp' || base === 'time') {
    // `timestamptz` rather than `timestamp with time zone`: the short spelling
    // is what the Prisma reader also produces for `@db.Timestamptz`, so the
    // two sources agree on `declaredType` and not only on the canonical `type`.
    const tz = boolOpt(opts, 'withTimezone');
    const p = numberOpt(opts, 'precision');
    const head = tz ? (base === 'timestamp' ? 'timestamptz' : 'timetz') : base;
    return p === null ? head : `${head}(${p})`;
  }
  return base;
}

interface FileCtx {
  readonly model: SchemaModel;
  readonly reg: DrizzleRegistry;
  readonly path: string;
  readonly lineOf: (pos: number) => number;
  readonly comments: readonly TsComment[];
  readonly enumVars: Map<string, string>;
  readonly schemaVars: Map<string, string>;
}

/** The trailing `//` comment on the same line as `pos`, if any. */
function trailingComment(ctx: FileCtx, pos: number): string | null {
  const line = ctx.lineOf(pos);
  for (const c of ctx.comments) {
    if (ctx.lineOf(c.pos) === line && c.pos > pos) return c.text;
  }
  return null;
}

function applyColumnEntry(
  ctx: FileCtx,
  schema: string,
  table: string,
  key: string,
  value: readonly Tok[],
  binding: TableBinding,
): void {
  const b = parseBuilder(value);
  if (b === null) return;
  const enumTypeName = ctx.enumVars.get(b.func) ?? null;
  if (enumTypeName === null && TYPE_FUNCS[b.func] === undefined) return;

  const argParts = b.args === null ? [] : splitOn(b.args.items, ',');
  let columnName: string | null = null;
  let opts: Map<string, Tok[]> | null = null;
  for (const part of argParts) {
    const head = part[0];
    if (head === undefined) continue;
    if (head.t === 'str' && columnName === null) columnName = head.v;
    else if (head.t === 'group' && head.v === '{') opts = objectEntries(head);
  }
  // Drizzle's newer API omits the physical name and derives it from the key.
  const physical = columnName ?? toSnakeCase(key);

  const sqlType = drizzleSqlType(b.func, opts, enumTypeName);
  if (sqlType === null) return;

  let isArray = false;
  let nullable = true;
  let dbDefault = false;
  let clientDefault = false;
  // The database's expression wins over a client function when a column has both.
  let dbExpr: string | null = null;
  let clientExpr: string | null = null;
  let isPrimaryKey = false;
  let isUnique = false;
  const pos = (value[0] as Tok).pos;

  for (const link of b.chain) {
    if (link.method === 'notNull') nullable = false;
    else if (link.method === 'primaryKey') isPrimaryKey = true;
    else if (link.method === 'unique') isUnique = true;
    else if (link.method === 'array') isArray = true;
    else if (DB_DEFAULT_METHODS.has(link.method) || CLIENT_DEFAULT_METHODS.has(link.method)) {
      const client = CLIENT_DEFAULT_METHODS.has(link.method);
      let expr: string | null = null;
      if (link.method === 'defaultNow') expr = 'now()';
      else if (link.method === 'defaultRandom') expr = 'gen_random_uuid()';
      else if (link.args !== null && link.args.items.length > 0) {
        expr = link.args.raw.slice(1, -1).replace(/\s+/gu, ' ').trim();
      }
      if (client) {
        clientDefault = true;
        if (expr !== null) clientExpr = expr;
      } else {
        dbDefault = true;
        if (expr !== null) dbExpr = expr;
      }
      if (link.method.endsWith('Identity')) nullable = false;
    } else if (link.method === 'references' && link.args !== null) {
      const parts = splitOn(link.args.items, ',');
      const target = lastMemberRef(parts[0] ?? []);
      const refOpts =
        parts[1] !== undefined && parts[1]?.[0]?.t === 'group'
          ? objectEntries(parts[1][0] as Tok)
          : null;
      if (target !== null) {
        ctx.reg.pendingRefs.push({
          schema,
          table,
          column: physical,
          targetVar: target.obj,
          targetNamespace: target.ns,
          targetKey: target.prop,
          onDelete: stringOpt(refOpts, 'onDelete'),
          onUpdate: stringOpt(refOpts, 'onUpdate'),
          path: ctx.path,
          line: ctx.lineOf(pos),
        });
      }
    }
  }

  const n = normalizeSqlType(isArray ? `${sqlType}[]` : sqlType, ctx.model.enumTypes);
  const patch: ColumnPatch = {
    declaredType: n.declaredType,
    type: n.type,
    category: n.category,
    isArray: n.isArray,
    maxLength: n.maxLength,
    numericPrecision: n.numericPrecision,
    numericScale: n.numericScale,
    nullable: isPrimaryKey ? false : nullable,
  };
  if (dbDefault || clientDefault || n.implicitDefault) {
    // `serial` and its siblings carry a sequence the builder does not spell out.
    if (dbDefault || n.implicitDefault) patch.dbDefault = true;
    if (clientDefault) patch.clientDefault = true;
    patch.defaultExpr = dbExpr ?? clientExpr ?? (n.implicitDefault ? 'nextval()' : null);
  }
  if (isPrimaryKey) patch.isPrimaryKey = true;
  if (isUnique) patch.isUnique = true;
  const comment = trailingComment(ctx, pos);
  if (comment !== null) patch.comment = comment;

  const ref: SourceRef = { path: ctx.path, line: ctx.lineOf(pos), sourceKind: SOURCE };
  ctx.model.upsertColumn(schema, table, physical, patch, ref);
  binding.keyToColumn.set(key, physical);
}

/** Reads the third `pgTable` argument: composite keys, unique indexes, FKs. */
function applyTableExtras(
  ctx: FileCtx,
  schema: string,
  table: string,
  binding: TableBinding,
  extras: readonly Tok[],
): void {
  const ref: SourceRef = {
    path: ctx.path,
    line: ctx.lineOf((extras[0] as Tok).pos),
    sourceKind: SOURCE,
  };
  const container = flatten(extras).find((t) => t.t === 'group' && (t.v === '{' || t.v === '['));
  const entries = container === undefined ? [extras.slice()] : splitOn(container.items, ',');

  for (const entry of entries) {
    if (entry.length === 0) continue;
    const resolve = (key: string): string | null => binding.keyToColumn.get(key) ?? null;

    if (hasWord(entry, 'primaryKey')) {
      const cols = memberProps(entry)
        .map(resolve)
        .filter((c): c is string => c !== null);
      for (const c of cols) {
        ctx.model.upsertColumn(schema, table, c, { isPrimaryKey: true }, ref);
        if (cols.length === 1) ctx.model.upsertColumn(schema, table, c, { isUnique: true }, ref);
      }
      continue;
    }

    if (hasWord(entry, 'foreignKey')) {
      const g = flatten(entry).find((t) => t.t === 'group' && t.v === '{');
      if (g === undefined) continue;
      const obj = objectEntries(g);
      const local = memberProps(obj.get('columns') ?? [])
        .map(resolve)
        .filter((c): c is string => c !== null);
      const target = lastMemberRef(flatten(obj.get('foreignColumns') ?? []));
      if (local.length !== 1 || target === null) continue;
      ctx.reg.pendingRefs.push({
        schema,
        table,
        column: local[0] as string,
        targetVar: target.obj,
        targetNamespace: target.ns,
        targetKey: target.prop,
        onDelete: null,
        onUpdate: null,
        path: ctx.path,
        line: ref.line,
      });
      continue;
    }

    if (hasWord(entry, 'uniqueIndex') || hasWord(entry, 'unique')) {
      const onIdx = entry.findIndex(
        (t, i) => t.t === 'word' && t.v === 'on' && isGroup(entry, i + 1, '('),
      );
      const scope = onIdx >= 0 ? [entry[onIdx + 1] as Tok] : entry;
      const cols = memberProps(scope)
        .map(resolve)
        .filter((c): c is string => c !== null);
      if (cols.length === 1)
        ctx.model.upsertColumn(schema, table, cols[0] as string, { isUnique: true }, ref);
      continue;
    }

    if (hasWord(entry, 'check')) {
      const expr = flatten(entry).find((t) => t.t === 'str' && t.v.includes(' '));
      if (expr === undefined) continue;
      const tf = ctx.model.table(schema, table);
      if (tf === undefined) continue;
      const named = [...tf.columns.keys()].filter((c) =>
        new RegExp(`\\b${c}\\b`, 'u').test(expr.v),
      );
      if (named.length === 1) {
        ctx.model.upsertColumn(schema, table, named[0] as string, { check: expr.v.trim() }, ref);
      } else if (!tf.checks.includes(expr.v.trim())) {
        tf.checks.push(expr.v.trim());
      }
    }
  }
}

/**
 * Walks a token list for `const NAME = <call>` bindings, recursing into groups.
 *
 * The call may sit behind a member prefix, `const NAME = pg.pgTable(...)` (a namespace
 * import) or `const NAME = appSchema.table(...)`: each `<ident>.` before the called name is
 * skipped, so the binding name is the one before the `=`. A call that is not the right-hand
 * side of an `=` (an argument, a chain in the middle of an expression) has none.
 */
function eachCall(
  toks: readonly Tok[],
  visit: (constName: string | null, i: number, list: readonly Tok[]) => void,
): void {
  const walk = (list: readonly Tok[]): void => {
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i] as Tok;
      if (t.t === 'group') {
        walk(t.items);
        continue;
      }
      if (t.t !== 'word') continue;
      let start = i;
      while (
        start >= 2 &&
        (list[start - 1] as Tok).t === 'punct' &&
        (list[start - 1] as Tok).v === '.' &&
        (list[start - 2] as Tok).t === 'word'
      ) {
        start -= 2;
      }
      const prev = list[start - 1];
      const prev2 = list[start - 2];
      const constName =
        prev !== undefined &&
        prev.t === 'punct' &&
        prev.v === '=' &&
        prev2 !== undefined &&
        prev2.t === 'word'
          ? prev2.v
          : null;
      visit(constName, i, list);
    }
  };
  walk(toks);
}

/**
 * Applies one Drizzle schema module.
 *
 * @returns the number of tables found, so the caller can tell "parsed, nothing
 *   here" from "parsed, found schema".
 */
export function applyDrizzleFile(
  model: SchemaModel,
  reg: DrizzleRegistry,
  text: string,
  path: string,
): number {
  const { toks, comments } = tokenizeTs(text);
  const links = collectModuleLinks(toks);
  const moduleRec: DrizzleModule = {
    path,
    locals: new Map(),
    localExports: links.localExports,
    reexports: links.reexports,
    starExports: links.starExports,
    imports: links.imports,
    ambiguousImports: links.ambiguousImports,
    ambiguousExports: links.ambiguousExports,
  };
  reg.modules.set(path, moduleRec);
  const ctx: FileCtx = {
    model,
    reg,
    path,
    lineOf: makeLineIndex(text),
    comments,
    enumVars: new Map(),
    schemaVars: new Map(),
  };

  // Pass 1: enum and schema bindings, which columns and tables refer back to.
  eachCall(toks, (constName, i, list) => {
    const t = list[i] as Tok;
    if (t.v === 'pgEnum' && isGroup(list, i + 1, '(')) {
      const args = splitOn((list[i + 1] as Tok).items, ',');
      const nameTok = args[0]?.[0];
      if (nameTok !== undefined && nameTok.t === 'str') {
        model.registerEnumType(nameTok.v);
        if (constName !== null) ctx.enumVars.set(constName, nameTok.v);
      }
      return;
    }
    if (t.v === 'pgSchema' && isGroup(list, i + 1, '(')) {
      const args = splitOn((list[i + 1] as Tok).items, ',');
      const nameTok = args[0]?.[0];
      if (nameTok !== undefined && nameTok.t === 'str' && constName !== null) {
        ctx.schemaVars.set(constName, nameTok.v);
        model.ensureSchema(nameTok.v, { path, line: ctx.lineOf(t.pos), sourceKind: SOURCE });
      }
    }
  });

  // Pass 2: table declarations.
  let tableCount = 0;
  eachCall(toks, (constName, i, list) => {
    const t = list[i] as Tok;
    let schemaName = model.defaultSchema;
    const argsIdx = i + 1;

    if (t.v === 'pgTable') {
      if (!isGroup(list, argsIdx, '(')) return;
    } else if (t.v === 'table') {
      const dot = list[i - 1];
      const owner = list[i - 2];
      if (dot === undefined || dot.t !== 'punct' || dot.v !== '.') return;
      if (owner === undefined) return;
      if (owner.t === 'word' && ctx.schemaVars.has(owner.v))
        schemaName = ctx.schemaVars.get(owner.v) as string;
      else if (owner.t === 'group' && list[i - 3]?.v === 'pgSchema') {
        const inner = splitOn(owner.items, ',')[0]?.[0];
        if (inner === undefined || inner.t !== 'str') return;
        schemaName = inner.v;
      } else return;
      if (!isGroup(list, argsIdx, '(')) return;
    } else {
      return;
    }

    const args = splitOn((list[argsIdx] as Tok).items, ',');
    const first = args[0]?.[0];
    let tableName: string | null = null;
    let columnsGroup: Tok | null = null;
    let extras: Tok[] = [];

    if (first !== undefined && first.t === 'str') {
      tableName = first.v;
      const second = args[1]?.[0];
      if (second !== undefined && second.t === 'group' && second.v === '{') columnsGroup = second;
      extras = args[2] ?? [];
    } else if (first !== undefined && first.t === 'group' && first.v === '{') {
      tableName = constName === null ? null : toSnakeCase(constName);
      columnsGroup = first;
      extras = args[1] ?? [];
    }
    if (tableName === null || columnsGroup === null) return;

    const ref: SourceRef = { path, line: ctx.lineOf(t.pos), sourceKind: SOURCE };
    model.ensureTable(schemaName, tableName, ref, true);
    if (constName !== null) model.recordOrmName(schemaName, tableName, 'drizzle', constName);
    tableCount += 1;

    const binding: TableBinding = { schema: schemaName, table: tableName, keyToColumn: new Map() };
    if (constName !== null) {
      recordBinding(reg, moduleRec, constName, binding, bindingIsExported(list, i));
    }

    for (const entry of splitOn(columnsGroup.items, ',')) {
      const key = entry[0];
      const colon = entry[1];
      if (key === undefined || colon === undefined) continue;
      if (key.t !== 'word' && key.t !== 'str') continue;
      if (colon.t !== 'punct' || colon.v !== ':') continue;
      applyColumnEntry(ctx, schemaName, tableName, key.v, entry.slice(2), binding);
    }

    if (extras.length > 0) applyTableExtras(ctx, schemaName, tableName, binding, extras);
  });

  return tableCount;
}

type TargetResolution =
  | { readonly kind: 'table'; readonly binding: TableBinding }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'missing' };

function knownModules(reg: DrizzleRegistry): ReadonlySet<string> {
  return new Set(reg.modules.keys());
}

/** The export `exportName` of `modulePath`, following `export { name } from`. */
function lookupExport(
  reg: DrizzleRegistry,
  modulePath: string,
  exportName: string,
  seen: Set<string>,
): TargetResolution {
  const mark = `${modulePath}\u0000${exportName}`;
  if (seen.has(mark)) return { kind: 'missing' };
  seen.add(mark);
  const mod = reg.modules.get(modulePath);
  if (mod === undefined) return { kind: 'missing' };
  if (mod.ambiguousExports.has(exportName)) return { kind: 'ambiguous' };
  const localName = mod.localExports.get(exportName);
  const reexport = mod.reexports.get(exportName);
  if (localName !== undefined && reexport !== undefined) return { kind: 'ambiguous' };
  if (localName !== undefined) {
    const binding = mod.locals.get(localName);
    return binding === undefined ? { kind: 'missing' } : { kind: 'table', binding };
  }
  if (reexport === undefined) return lookupStarExports(reg, mod, exportName, seen);
  const next = resolveModuleSpecifier(modulePath, reexport.specifier, knownModules(reg));
  if (next === 'ambiguous') return { kind: 'ambiguous' };
  if (next === null) return { kind: 'missing' };
  return lookupExport(reg, next, reexport.imported, seen);
}

/**
 * `export * from` sources of `mod`, for a name `mod` does not export itself.
 * Sources that disagree on the table are ambiguous; `default` is never re-exported.
 */
function lookupStarExports(
  reg: DrizzleRegistry,
  mod: DrizzleModule,
  exportName: string,
  seen: Set<string>,
): TargetResolution {
  if (exportName === 'default') return { kind: 'missing' };
  let found: TableBinding | null = null;
  for (const specifier of mod.starExports) {
    const next = resolveModuleSpecifier(mod.path, specifier, knownModules(reg));
    if (next === 'ambiguous') return { kind: 'ambiguous' };
    if (next === null) continue;
    const hit = lookupExport(reg, next, exportName, seen);
    if (hit.kind === 'ambiguous') return hit;
    if (hit.kind === 'missing') continue;
    if (
      found !== null &&
      (found.schema !== hit.binding.schema || found.table !== hit.binding.table)
    ) {
      return { kind: 'ambiguous' };
    }
    found ??= hit.binding;
  }
  return found === null ? { kind: 'missing' } : { kind: 'table', binding: found };
}

function resolveImport(
  reg: DrizzleRegistry,
  fromPath: string,
  imported: ImportBinding,
  exportName: string,
): TargetResolution {
  if (imported.typeOnly) return { kind: 'missing' };
  const target = resolveModuleSpecifier(fromPath, imported.specifier, knownModules(reg));
  if (target === 'ambiguous') return { kind: 'ambiguous' };
  // A specifier no read module answers to (a tsconfig path alias such as '@/db/schema',
  // a workspace package) cannot be followed, so the name falls back to the global lookup,
  // which still refuses a name that more than one table is exported under. A specifier that
  // resolves to a module without the export gets no fallback.
  if (target === null) return uniqueGlobal(reg.tablesByVar.get(exportName) ?? []);
  return lookupExport(reg, target, exportName, new Set());
}

/**
 * Bindings of one variable name that all build the same table. Column keys that
 * disagree are dropped, so a later read cannot pick between them.
 */
function uniqueGlobal(bindings: readonly TableBinding[]): TargetResolution {
  const first = bindings[0];
  if (first === undefined) return { kind: 'missing' };
  if (bindings.some((b) => b.schema !== first.schema || b.table !== first.table)) {
    return { kind: 'ambiguous' };
  }
  if (bindings.length === 1) return { kind: 'table', binding: first };
  const keyToColumn = new Map<string, string>();
  const conflict = new Set<string>();
  for (const binding of bindings) {
    for (const [key, column] of binding.keyToColumn) {
      const prev = keyToColumn.get(key);
      if (prev === undefined) keyToColumn.set(key, column);
      else if (prev !== column) conflict.add(key);
    }
  }
  for (const key of conflict) keyToColumn.delete(key);
  return { kind: 'table', binding: { schema: first.schema, table: first.table, keyToColumn } };
}

function resolveRefTarget(reg: DrizzleRegistry, ref: PendingRef): TargetResolution {
  const mod = reg.modules.get(ref.path);
  if (mod !== undefined) {
    if (mod.ambiguousImports.has(ref.targetVar)) return { kind: 'ambiguous' };
    // `s.users.id` with `import * as s from './schema'` follows the namespace's module.
    if (ref.targetNamespace !== null) {
      if (mod.ambiguousImports.has(ref.targetNamespace)) return { kind: 'ambiguous' };
      const ns = mod.imports.get(ref.targetNamespace);
      if (ns !== undefined && ns.imported === '*') {
        return resolveImport(reg, ref.path, ns, ref.targetVar);
      }
    }
    const imported = mod.imports.get(ref.targetVar);
    if (imported !== undefined && imported.imported !== '*') {
      return resolveImport(reg, ref.path, imported, imported.imported);
    }
    const local = mod.locals.get(ref.targetVar);
    if (local !== undefined) return { kind: 'table', binding: local };
  }
  return uniqueGlobal(reg.tablesByVar.get(ref.targetVar) ?? []);
}

/** Resolves queued `.references()` targets once every module has been read. */
export function resolveDrizzleRefs(model: SchemaModel, reg: DrizzleRegistry): void {
  // Sorted so the emitted FK order does not depend on file traversal order.
  const key = (r: PendingRef): string =>
    [r.schema, r.table, r.column, r.path, String(r.line).padStart(9, '0')].join('\u0000');
  const sorted = [...reg.pendingRefs].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
  );
  for (const r of sorted) {
    const target = resolveRefTarget(reg, r);
    const described = `${r.targetVar}.${r.targetKey}`;
    if (target.kind === 'ambiguous') {
      model.note(
        `drizzle: unresolved reference target ${described} from ${r.schema}.${r.table}.${r.column} (ambiguous)`,
      );
      continue;
    }
    if (target.kind === 'missing') {
      model.note(
        `drizzle: unresolved reference target ${described} from ${r.schema}.${r.table}.${r.column}`,
      );
      continue;
    }
    const refColumn = target.binding.keyToColumn.get(r.targetKey);
    if (refColumn === undefined) {
      model.note(`drizzle: unresolved reference column ${described}`);
      continue;
    }
    model.addForeignKey({
      name: null,
      schema: r.schema,
      table: r.table,
      columns: [r.column],
      refSchema: target.binding.schema,
      refTable: target.binding.table,
      refColumns: [refColumn],
      onDelete: r.onDelete === null ? null : r.onDelete.toUpperCase(),
      onUpdate: r.onUpdate === null ? null : r.onUpdate.toUpperCase(),
      path: r.path,
      line: r.line,
    });
  }
  reg.pendingRefs.length = 0;
}
