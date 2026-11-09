/** Closed PL/pgSQL control forms, parsed as static effects and never executed. */
import { group, ident, kw, tokenizeSql, type Tok } from '@seamline/core/sql';
import type { DdlStep, TableName } from './migration-replay-sql.ts';
import { ReplayCursor, rejectReplay, replayExpression, replayIdentifier } from './migration-replay-expression.ts';
import { completeReplaySource } from './migration-replay-source.ts';

export type ReplayGuard =
  | { readonly kind: 'table'; readonly table: TableName; readonly exists: boolean }
  | { readonly kind: 'and'; readonly terms: readonly ReplayGuard[] }
  | { readonly kind: 'unknown' };
const CATALOGS = new Set(['pg_type', 'pg_constraint', 'pg_class', 'pg_namespace', 'pg_proc', 'pg_policies']);
const CATALOG_CALLS = new Set(['pg_get_constraintdef', 'pg_get_function_identity_arguments']);
function catalogCalls(tokens: readonly Tok[], dependencies: Set<string>): void {
  for (const [i, token] of tokens.entries()) {
    if (token.t === 'word' && group(tokens, i + 1, '(') !== null) {
      if (!CATALOG_CALLS.has(token.v)) return rejectReplay();
      if (tokens[i - 1]?.v === '.' && (ident(tokens, i - 2) !== 'pg_catalog' || tokens[i - 3]?.v === '.')) return rejectReplay();
      dependencies.add(token.v);
    }
    if (token.t === 'group') catalogCalls(token.items, dependencies);
  }
}
function relation(c: ReplayCursor, dependencies: Set<string>): void {
  const start = c.pos;
  const [schema, name] = c.name();
  if ((c.pos - start > 1 && schema !== 'pg_catalog') || !CATALOGS.has(name)) return rejectReplay();
  dependencies.add('pg_catalog.' + name);
  if (ident(c.tokens, c.pos) !== null && !['JOIN', 'WHERE', 'ON'].includes(kw(c.tokens, c.pos) ?? '')) c.id();
}
/** Restricted catalog reads supply an unknown condition, never database facts. */
function catalogQuery(tokens: readonly Tok[], schema: string, dependencies: Set<string>): void {
  const c = new ReplayCursor(tokens, schema);
  catalogCalls(tokens, dependencies);
  c.require('SELECT');
  do { replayExpression(c); } while (c.punct(','));
  c.require('FROM'); relation(c, dependencies);
  while (c.word('JOIN')) { relation(c, dependencies); c.require('ON'); replayExpression(c); }
  if (c.word('WHERE')) replayExpression(c);
  c.done();
}
function tableLiteral(value: string, schema: string): TableName {
  const tokens = tokenizeSql(value);
  if (!completeReplaySource(value, tokens)) return rejectReplay();
  const c = new ReplayCursor(tokens, schema); const result = c.name(); c.done(); return result;
}
function guard(c: ReplayCursor, dependencies: Set<string>): ReplayGuard {
  const terms: ReplayGuard[] = [];
  do {
    if (c.word('TO_REGCLASS')) {
      dependencies.add('to_regclass');
      const args = c.parens();
      if (args.length !== 1 || args[0]?.t !== 'str') return rejectReplay();
      const table = tableLiteral(args[0].v, c.schema);
      c.require('IS'); const exists = c.word('NOT'); c.require('NULL');
      terms.push({ kind: 'table', table, exists });
    } else if (c.word('TO_REGPROCEDURE')) {
      dependencies.add('to_regprocedure');
      const args = c.parens();
      if (args.length !== 1 || args[0]?.t !== 'str' || !/^[a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*\(\)$/.test(args[0].v)) return rejectReplay();
      for (const name of args[0].v.slice(0, -2).split('.')) replayIdentifier(name);
      c.require('IS'); c.word('NOT'); c.require('NULL'); terms.push({ kind: 'unknown' });
    } else {
      c.word('NOT'); c.require('EXISTS'); const query = c.parens();
      // Project relation reads can invoke views, policies and stored functions.
      // A call-token scan cannot certify their effect footprint.
      catalogQuery(query, c.schema, dependencies);
      terms.push({ kind: 'unknown' });
    }
  } while (c.word('AND'));
  c.done();
  return terms.length === 1 ? terms[0]! : { kind: 'and', terms };
}
function passive(step: DdlStep): boolean {
  return step.kind === 'none' || (step.kind === 'alter' && step.actions.every((action) => !action.unprovedCalls && ['reference', 'foreign', 'none'].includes(action.kind))) || (step.kind === 'guard' && step.body.every(passive));
}
function shifted(tokens: readonly Tok[], offset: number): Tok[] {
  return tokens.map((token) => ({ ...token, pos: token.pos + offset, items: shifted(token.items, offset) }));
}

export function parseReplayProcedure(c: ReplayCursor, parse: (tokens: readonly Tok[], schema: string) => DdlStep): DdlStep {
  const nativeCalls = new Set<string>();
  // Only the language with this grammar is supported, before or after the body.
  let language = false;
  if (c.word('LANGUAGE')) { c.require('PLPGSQL'); language = true; }
  const body = c.tokens[c.pos++];
  if (body?.t !== 'str' || body.v.length > 1_000_000) return rejectReplay();
  const delimiter = /^\$[a-zA-Z_0-9]*\$/.exec(body.raw)?.[0];
  if (delimiter === undefined || body.raw !== delimiter + body.v + delimiter) return rejectReplay();
  if (c.word('LANGUAGE')) { if (language) return rejectReplay(); c.require('PLPGSQL'); }
  c.done();
  const tokens = tokenizeSql(body.v);
  if (!completeReplaySource(body.v, tokens) || tokens.length > 100_000) return rejectReplay();
  const b = new ReplayCursor(shifted(tokens, body.pos + delimiter.length), c.schema);
  const variables = new Map<string, 'text' | 'regprocedure' | 'record'>();
  if (b.word('DECLARE')) {
    while (kw(b.tokens, b.pos) !== 'BEGIN') {
      if (variables.size >= 16) return rejectReplay();
      const variable = b.id();
      if (variables.has(variable)) return rejectReplay();
      const type = b.id(); if (type !== 'text' && type !== 'regprocedure' && type !== 'record') return rejectReplay();
      variables.set(variable, type); if (!b.punct(';')) return rejectReplay();
    }
  }
  b.require('BEGIN');
  const loop = (): DdlStep[] => {
    nativeCalls.add('format');
    const variable = b.id();
    if (variables.get(variable) !== 'text') return rejectReplay();
    b.require('IN', 'ARRAY', 'ARRAY');
    const values = group(b.tokens, b.pos++, '[');
    if (values === null) return rejectReplay();
    const names: string[] = [];
    for (let i = 0; i < values.items.length; i += 2) {
      const value = values.items[i];
      if (value?.t !== 'str' || !value.v.length || value.v.length > 128 || /[\u0000-\u001f\u007f]/.test(value.v) || (i + 1 < values.items.length && values.items[i + 1]?.v !== ',')) return rejectReplay();
      names.push(replayIdentifier(value.v));
    }
    if (!names.length || names.length > 256 || values.items.length !== names.length * 2 - 1) return rejectReplay();
    b.require('LOOP');
    const guarded = b.word('IF');
    let schema: string | undefined;
    if (guarded) {
      nativeCalls.add('to_regclass');
      b.require('TO_REGCLASS');
      const regclass = new ReplayCursor(b.parens(), b.schema); regclass.require('FORMAT');
      const format = new ReplayCursor(regclass.parens(), b.schema);
      const template = format.tokens[format.pos++];
      const match = template?.t === 'str' ? /^([A-Za-z_][A-Za-z_0-9]*)\.%I$/.exec(template.v) : null;
      if (match === null || !format.punct(',') || format.id() !== variable) return rejectReplay();
      schema = replayIdentifier(match[1]!.toLowerCase()); format.done(); regclass.done();
      b.require('IS', 'NOT', 'NULL', 'THEN');
    }
    b.require('EXECUTE', 'FORMAT');
    const format = new ReplayCursor(b.parens(), b.schema);
    const template = format.tokens[format.pos++];
    const match = template?.t === 'str' ? /^alter table ([a-z_][a-z_0-9]*)\.%I enable row level security$/i.exec(template.v) : null;
    if (match === null || !template?.v.includes('%I') || !format.punct(',') || format.id() !== variable || (schema !== undefined && schema !== match[1]?.toLowerCase())) return rejectReplay();
    format.done(); if (!b.punct(';')) return rejectReplay();
    if (guarded) { b.require('END', 'IF'); if (!b.punct(';')) return rejectReplay(); }
    b.require('END', 'LOOP'); if (!b.punct(';')) return rejectReplay();
    return names.map((name): DdlStep => {
      const table: TableName = [replayIdentifier(match[1]!.toLowerCase()), name];
      const alter: DdlStep = { kind: 'alter', table, conditional: false, actions: [{ kind: 'none' }] };
      return guarded ? { kind: 'guard', condition: { kind: 'table', table, exists: true }, body: [alter] } : alter;
    });
  };
  const tablePrivileges = (): DdlStep => {
    for (const name of ['pg_class', 'pg_namespace', 'pg_policies']) nativeCalls.add('pg_catalog.' + name);
    nativeCalls.add('format');
    const variable = b.id();
    if (variables.get(variable) !== 'record') return rejectReplay();
    const qualified = (cursor: ReplayCursor, alias: string, field: string): void => {
      if (cursor.id() !== alias || !cursor.punct('.') || cursor.id() !== field) return rejectReplay();
    };
    b.require('IN', 'SELECT');
    const namespace = b.id(); if (!b.punct('.') || b.id() !== 'nspname') return rejectReplay();
    b.require('AS'); const schemaField = b.id(); if (!b.punct(',')) return rejectReplay();
    const relation = b.id(); if (!b.punct('.') || b.id() !== 'relname') return rejectReplay();
    b.require('AS'); const tableField = b.id();
    if (namespace === relation || schemaField === tableField) return rejectReplay();
    b.require('FROM', 'PG_CLASS'); if (b.id() !== relation) return rejectReplay();
    b.require('JOIN', 'PG_NAMESPACE'); if (b.id() !== namespace) return rejectReplay();
    b.require('ON'); qualified(b, namespace, 'oid'); if (!b.punct('=')) return rejectReplay(); qualified(b, relation, 'relnamespace');
    b.require('WHERE'); qualified(b, namespace, 'nspname'); if (!b.punct('=')) return rejectReplay();
    const schema = b.tokens[b.pos++]; if (schema?.t !== 'str') return rejectReplay(); replayIdentifier(schema.v);
    b.require('AND'); qualified(b, relation, 'relkind'); b.require('IN');
    const kinds = new ReplayCursor(b.parens(), b.schema);
    const firstKind = kinds.tokens[kinds.pos++];
    if (firstKind?.t !== 'str' || firstKind.v !== 'r' || !kinds.punct(',')) return rejectReplay();
    const secondKind = kinds.tokens[kinds.pos++];
    if (secondKind?.t !== 'str' || secondKind.v !== 'p') return rejectReplay();
    kinds.done();
    b.require('AND'); qualified(b, relation, 'relrowsecurity'); b.require('AND', 'NOT', 'EXISTS');
    const missing = new ReplayCursor(b.parens(), b.schema);
    missing.require('SELECT'); const value = missing.tokens[missing.pos++];
    if (value?.t !== 'num' || value.v !== '1') return rejectReplay();
    missing.require('FROM', 'PG_POLICIES'); const policy = missing.id();
    if (policy === namespace || policy === relation) return rejectReplay();
    missing.require('WHERE'); qualified(missing, policy, 'schemaname'); if (!missing.punct('=')) return rejectReplay(); qualified(missing, namespace, 'nspname');
    missing.require('AND'); qualified(missing, policy, 'tablename'); if (!missing.punct('=')) return rejectReplay(); qualified(missing, relation, 'relname'); missing.done();
    b.require('LOOP', 'EXECUTE', 'FORMAT');
    const format = new ReplayCursor(b.parens(), b.schema);
    const template = format.tokens[format.pos++];
    if (template?.t !== 'str' || !/^revoke all privileges on table %I\.%I from anon, authenticated$/i.test(template.v) || !template.v.includes('%I.%I')) return rejectReplay();
    if (!format.punct(',')) return rejectReplay(); qualified(format, variable, schemaField);
    if (!format.punct(',')) return rejectReplay(); qualified(format, variable, tableField); format.done();
    if (!b.punct(';')) return rejectReplay(); b.require('END', 'LOOP'); if (!b.punct(';')) return rejectReplay();
    return { kind: 'none' };
  };
  const functionPrivileges = (): DdlStep => {
    for (const name of ['pg_proc', 'pg_namespace']) nativeCalls.add('pg_catalog.' + name);
    nativeCalls.add('format');
    const variable = b.id();
    if (variables.get(variable) !== 'regprocedure') return rejectReplay();
    b.require('IN', 'SELECT');
    const procedure = b.id();
    if (!b.punct('.') || b.id() !== 'oid' || !b.punct('::')) return rejectReplay();
    b.require('REGPROCEDURE', 'FROM', 'PG_PROC'); if (b.id() !== procedure) return rejectReplay();
    b.require('JOIN', 'PG_NAMESPACE'); const namespace = b.id();
    if (namespace === procedure) return rejectReplay();
    b.require('ON');
    const qualified = (alias: string, field: string): void => {
      if (b.id() !== alias || !b.punct('.') || b.id() !== field) return rejectReplay();
    };
    qualified(namespace, 'oid'); if (!b.punct('=')) return rejectReplay(); qualified(procedure, 'pronamespace');
    b.require('WHERE'); qualified(namespace, 'nspname'); if (!b.punct('=')) return rejectReplay();
    const schema = b.tokens[b.pos++]; if (schema?.t !== 'str' || !schema.v.length || schema.v.length > 128) return rejectReplay();
    replayIdentifier(schema.v);
    b.require('AND'); qualified(procedure, 'prosecdef'); b.require('LOOP');
    // The only %s value comes from pg_proc.oid::regprocedure into a typed
    // variable. Its output quotes function/type identifiers when needed:
    // https://www.postgresql.org/docs/17/datatype-oid.html
    // There is no text variable, concatenation, function invocation or dynamic
    // template. These statements change privileges, never table membership.
    let changes = 0;
    while (b.word('EXECUTE')) {
      if (++changes > 32) return rejectReplay();
      b.require('FORMAT'); const format = new ReplayCursor(b.parens(), b.schema);
      const template = format.tokens[format.pos++];
      const roles = '[a-z_][a-z_0-9]*(?:, [a-z_][a-z_0-9]*)*';
      const grant = new RegExp('^grant execute on function %s to ' + roles + '$', 'i');
      const revoke = new RegExp('^revoke execute on function %s from ' + roles + '$', 'i');
      if (template?.t !== 'str' || !template.v.includes('%s') || (!grant.test(template.v) && !revoke.test(template.v)) || !format.punct(',') || format.id() !== variable) return rejectReplay();
      format.done(); if (!b.punct(';')) return rejectReplay();
    }
    if (!changes) return rejectReplay();
    b.require('END', 'LOOP'); if (!b.punct(';')) return rejectReplay();
    return { kind: 'none' };
  };
  const constraintRemoval = (): DdlStep => {
    for (const name of ['pg_constraint', 'pg_class', 'pg_namespace']) nativeCalls.add('pg_catalog.' + name);
    nativeCalls.add('format'); nativeCalls.add('pg_get_constraintdef');
    const qualified = (alias: string, field: string): void => {
      if (b.id() !== alias || !b.punct('.') || b.id() !== field) return rejectReplay();
    };
    const literal = (): string => {
      const value = b.tokens[b.pos++]; if (value?.t !== 'str') return rejectReplay(); return value.v;
    };
    const equal = (): void => { if (!b.punct('=')) return rejectReplay(); };
    // A single fixed catalog join establishes only where the constraint-name
    // value came from. It supplies no assumption about live catalog contents.
    const constraint = b.id(); if (!b.punct('.') || b.id() !== 'conname') return rejectReplay();
    b.require('INTO'); const variable = b.id();
    if (variables.get(variable) !== 'text') return rejectReplay();
    b.require('FROM', 'PG_CONSTRAINT'); if (b.id() !== constraint) return rejectReplay();
    b.require('JOIN', 'PG_CLASS'); const relation = b.id(); b.require('ON');
    qualified(relation, 'oid'); equal(); qualified(constraint, 'conrelid');
    b.require('JOIN', 'PG_NAMESPACE'); const namespace = b.id(); b.require('ON');
    qualified(namespace, 'oid'); equal(); qualified(relation, 'relnamespace');
    if (new Set([constraint, relation, namespace]).size !== 3) return rejectReplay();
    b.require('WHERE'); qualified(namespace, 'nspname'); equal(); const schema = literal();
    b.require('AND'); qualified(relation, 'relname'); equal(); const tableName = literal();
    replayIdentifier(schema); replayIdentifier(tableName);
    b.require('AND'); qualified(constraint, 'contype'); equal(); if (literal() !== 'c') return rejectReplay();
    b.require('AND', 'PG_GET_CONSTRAINTDEF');
    const args = new ReplayCursor(b.parens(), b.schema);
    if (args.id() !== constraint || !args.punct('.') || args.id() !== 'oid') return rejectReplay();
    args.done(); b.require('LIKE'); literal(); if (!b.punct(';')) return rejectReplay();
    b.require('IF'); if (b.id() !== variable) return rejectReplay(); b.require('IS', 'NOT', 'NULL', 'THEN', 'EXECUTE', 'FORMAT');
    const format = new ReplayCursor(b.parens(), b.schema);
    const template = format.tokens[format.pos++];
    const match = template?.t === 'str' ? /^alter table ([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*) drop constraint %I$/i.exec(template.v) : null;
    if (match === null || !template?.v.includes('%I') || match[1]?.toLowerCase() !== schema || match[2]?.toLowerCase() !== tableName || !format.punct(',') || format.id() !== variable) return rejectReplay();
    format.done(); if (!b.punct(';')) return rejectReplay();
    b.require('END', 'IF'); if (!b.punct(';')) return rejectReplay();
    return { kind: 'guard', condition: { kind: 'unknown' }, body: [{ kind: 'alter', table: [schema, tableName], conditional: false, actions: [{ kind: 'none' }] }] };
  };
  let work = 0;
  const statements = (depth: number): DdlStep[] => {
    if (depth > 16) return rejectReplay();
    const out: DdlStep[] = [];
    while (b.pos < b.tokens.length && kw(b.tokens, b.pos) !== 'END') {
      if (++work > 256) return rejectReplay();
      const position = b.tokens[b.pos]?.pos ?? 0;
      const first = out.length;
      if (b.word('FOR')) { out.push(variables.get(ident(b.tokens, b.pos) ?? '') === 'record' ? tablePrivileges() : functionPrivileges()); }
      else if (b.word('SELECT')) { out.push(constraintRemoval()); }
      else if (b.word('FOREACH')) { out.push(...loop()); }
      // An exception is control flow, not an effect-free declaration.
      else if (b.word('RAISE')) return rejectReplay();
      else if (b.word('IF')) {
        const start = b.pos;
        while (b.pos < b.tokens.length && kw(b.tokens, b.pos) !== 'THEN') b.pos += 1;
        const condition = guard(new ReplayCursor(b.tokens.slice(start, b.pos), b.schema), nativeCalls);
        b.require('THEN'); const children = statements(depth + 1); b.require('END', 'IF');
        if (!children.length || !children.every(passive) || !b.punct(';')) return rejectReplay();
        out.push({ kind: 'guard', condition, body: children });
      } else {
        const start = b.pos;
        while (b.pos < b.tokens.length && b.tokens[b.pos]?.v !== ';') b.pos += 1;
        if (b.pos === start || !b.punct(';')) return rejectReplay();
        const step = parse(b.tokens.slice(start, b.pos - 1), b.schema);
        if (!passive(step)) return rejectReplay();
        out.push(step);
      }
      for (let i = first; i < out.length; i += 1) out[i] = { ...out[i]!, pos: out[i]!.pos ?? position };
    }
    return out;
  };
  const effects = statements(0); b.require('END'); b.punct(';'); b.done();
  if (!effects.length) return rejectReplay();
  return { kind: 'guard', condition: { kind: 'and', terms: [] }, body: effects, nativeCalls: [...nativeCalls].sort() };
}
