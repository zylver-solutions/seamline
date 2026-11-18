/** Closed native validation/read shapes. No row truth or SQL execution is inferred. */
import { group, ident, kw, type Tok } from '@seamline/core/sql';
import { ReplayCursor, rejectReplay, UnsupportedReplay } from './migration-replay-expression.ts';
import type { TableName } from './migration-replay-sql.ts';

export type ValidationCheck =
  | { readonly kind: 'jsonb'; readonly column: string }
  | { readonly kind: 'text-any'; readonly column: string }
  | { readonly kind: 'text-contained'; readonly column: string };
export interface ReadRelation { readonly table: TableName; readonly alias: string; }
export type ReadColumn = readonly [alias: string, column: string];
export type ReadPredicate = { readonly left: ReadColumn; readonly right: ReadColumn | null };
export interface ValidationRead { readonly relations: readonly ReadRelation[]; readonly predicates: readonly ReadPredicate[]; }
function textArray(c: ReplayCursor): void {
  c.require('ARRAY'); const values = group(c.tokens, c.pos++, '[');
  if (values === null || values.items.length === 0 || values.items.length > 2047) return rejectReplay();
  for (let i = 0; i < values.items.length; i += 2) {
    if (values.items[i]?.t !== 'str' || (i + 1 < values.items.length && values.items[i + 1]?.v !== ',')) return rejectReplay();
  }
  if (values.items.length % 2 !== 1 || !c.punct('::')) return rejectReplay();
  const first = c.id();
  if (c.punct('.')) { if (first !== 'pg_catalog' || c.id() !== 'text') return rejectReplay(); }
  else if (first !== 'text') return rejectReplay();
  const array = group(c.tokens, c.pos++, '['); if (array === null || array.items.length !== 0) return rejectReplay();
}
export function validationCheck(tokens: readonly Tok[], schema: string): ValidationCheck | undefined {
  try {
    const c = new ReplayCursor(tokens, schema); const first = c.id();
    let callee = first;
    if (c.punct('.')) { if (first !== 'pg_catalog') return undefined; callee = c.id(); }
    if (callee === 'jsonb_typeof' && group(c.tokens, c.pos, '(') !== null) {
      const args = new ReplayCursor(c.parens(), schema); const column = args.id(); args.done();
      if (!c.punct('=') || c.tokens[c.pos++]?.t !== 'str') return undefined;
      c.done(); return { kind: 'jsonb', column };
    }
    // A qualified non-call never becomes a local column by suffix.
    if (callee !== first) return undefined;
    if (c.punct('=')) {
      c.require('ANY'); const args = new ReplayCursor(c.parens(), schema); textArray(args); args.done(); c.done();
      return { kind: 'text-any', column: first };
    }
    // The shared lexer emits separate '<' and '@' tokens here.
    if (!c.punct('<') || !c.punct('@')) return undefined;
    textArray(c); c.done(); return { kind: 'text-contained', column: first };
  } catch (error) { if (error instanceof UnsupportedReplay) return undefined; throw error; }
}
export function needsNativeValidation(tokens: readonly Tok[]): boolean {
  return tokens.some((t, i) => t.t === 'word' && ['jsonb_typeof', 'any'].includes(t.v.toLowerCase()) || t.v === '<' && tokens[i + 1]?.v === '@' || t.t === 'group' && needsNativeValidation(t.items));
}
/** A small ordinary-relation SELECT grammar, with a complete relation/alias/column footprint.
 * Joins need not form a connected graph. Every declared alias still participates in validation. */
export function validationRead(tokens: readonly Tok[], schema: string): ValidationRead {
  const c = new ReplayCursor(tokens, schema); const relations: ReadRelation[] = []; const predicates: ReadPredicate[] = [];
  c.require('SELECT'); const value = c.tokens[c.pos++]; if (value?.t !== 'num' || value.v !== '1') return rejectReplay();
  const relation = (): void => {
    if (relations.length >= 64) return rejectReplay();
    const table = c.name();
    if (table[0] === 'information_schema' || table[0].startsWith('pg_') || table[1].startsWith('pg_')) return rejectReplay();
    let alias = table[1];
    if (c.word('AS')) alias = c.id();
    else if (ident(c.tokens, c.pos) !== null && !['LEFT', 'INNER', 'JOIN', 'WHERE', 'ON'].includes(kw(c.tokens, c.pos) ?? '')) alias = c.id();
    if (relations.some(r => r.alias === alias)) return rejectReplay();
    relations.push({ table, alias });
  };
  const column = (): ReadColumn => { const alias = c.id(); if (!c.punct('.')) return rejectReplay(); return [alias, c.id()]; };
  const predicate = (): void => {
    do {
      if (predicates.length >= 256) return rejectReplay();
      const left = column();
      if (c.punct('=')) predicates.push({ left, right: column() });
      else { c.require('IS', 'NULL'); predicates.push({ left, right: null }); }
    } while (c.word('AND'));
  };
  c.require('FROM'); relation();
  while (['LEFT', 'INNER', 'JOIN'].includes(kw(c.tokens, c.pos) ?? '')) {
    if (c.word('LEFT')) c.word('OUTER'); else c.word('INNER');
    c.require('JOIN'); relation(); c.require('ON'); predicate();
  }
  if (c.word('WHERE')) predicate();
  c.done();
  if (!relations.length || predicates.some(p => [p.left, ...(p.right === null ? [] : [p.right])].some(v => !relations.some(r => r.alias === v[0])))) return rejectReplay();
  return { relations, predicates };
}
