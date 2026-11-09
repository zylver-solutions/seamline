/** Bounded expression grammar for declarative DDL attributes, never evaluation. */
import { group, ident, isPunct, kw, matchKw, splitOn, type Tok } from '@seamline/core/sql';

export class UnsupportedReplay extends Error {}
export function rejectReplay(): never { throw new UnsupportedReplay('unsupported DDL shape'); }
export function replayIdentifier(value: string): string {
  if (value.length === 0 || Buffer.byteLength(value) > 63) return rejectReplay();
  return value;
}
export class ReplayCursor {
  pos = 0;
  readonly tokens: readonly Tok[];
  readonly schema: string;
  readonly columns: Set<string> | undefined;
  readonly query: ((cursor: ReplayCursor, depth: number) => void) | undefined;
  constructor(tokens: readonly Tok[], schema: string, columns?: Set<string>, query?: (cursor: ReplayCursor, depth: number) => void) { this.tokens = tokens; this.schema = replayIdentifier(schema); this.columns = columns; this.query = query; }
  word(...words: string[]): boolean {
    if (!matchKw(this.tokens, this.pos, words)) return false;
    // Keyword normalization must not turn a distinct UTF-8 identifier into
    // a native callee or control word inside a dollar-quoted procedure.
    if (words.some((_, index) => /[^\u0000-\u007f]/.test(this.tokens[this.pos + index]?.raw ?? ''))) return false;
    this.pos += words.length; return true;
  }
  require(...words: string[]): void { if (!this.word(...words)) rejectReplay(); }
  punct(value: string): boolean {
    if (!isPunct(this.tokens, this.pos, value)) return false;
    this.pos += 1; return true;
  }
  id(): string {
    const token = this.tokens[this.pos];
    // The shared tolerant lexer folds Unicode with JavaScript rules. This
    // UTF-8 PostgreSQL subset certifies only ASCII unquoted spellings.
    if (token?.t === 'word' && !token.quoted && /[^\u0000-\u007f]/.test(token.raw)) return rejectReplay();
    const value = ident(this.tokens, this.pos++);
    return value === null ? rejectReplay() : replayIdentifier(value);
  }
  /** An ignored policy label is never an identity, projection or presence key. */
  metadataName(): void {
    const value = ident(this.tokens, this.pos++);
    if (value === null || value.length === 0) rejectReplay();
  }
  name(): readonly [string, string] {
    const first = this.id();
    if (!this.punct('.')) return [this.schema, first];
    const second = this.id();
    if (isPunct(this.tokens, this.pos, '.')) return rejectReplay();
    return [first, second];
  }
  parens(): readonly Tok[] {
    const value = group(this.tokens, this.pos++, '(');
    if (value === null) return rejectReplay();
    return value.items;
  }
  done(): void { if (this.pos !== this.tokens.length) rejectReplay(); }
}

export function replayType(c: ReplayCursor): void {
  const first = kw(c.tokens, c.pos);
  c.name();
  if (first === 'DOUBLE') c.require('PRECISION');
  else if (first === 'CHARACTER' || first === 'CHAR' || first === 'BIT') c.word('VARYING');
  if (group(c.tokens, c.pos, '(') !== null) {
    const args = c.parens();
    const parts = splitOn(args, ',');
    if (!parts.length || parts.length > 2 || !parts.every((p) => p.length === 1 && p[0]?.t === 'num' && /^\d+$/.test(p[0].v))) return rejectReplay();
  }
  if ((first === 'TIMESTAMP' || first === 'TIME') && (c.word('WITH') || c.word('WITHOUT'))) c.require('TIME', 'ZONE');
  while (group(c.tokens, c.pos, '[') !== null) {
    const bracket = c.tokens[c.pos++];
    if (bracket?.items.length !== 0) return rejectReplay();
  }
}
const FORBIDDEN = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'EXECUTE', 'DO', 'BEGIN', 'END', 'WHEN', 'THEN', 'ELSE', 'FROM', 'INTO', 'RETURNING', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'BY', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'LATERAL', 'ON', 'USING', 'AS', 'SET', 'FOR', 'AND', 'OR', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'NULLS', 'FIRST', 'LAST', 'ASC', 'DESC']);
const OPERATORS: Readonly<Record<string, number>> = { OR: 1, AND: 2, '=': 3, '<>': 3, '!=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3, LIKE: 3, ILIKE: 3, '~': 3, '~*': 3, '!~': 3, '!~*': 3, '@>': 3, '<@': 3, '||': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6, '->': 7, '->>': 7, '#>': 7, '#>>': 7 };
function list(tokens: readonly Tok[], schema: string, depth: number, empty = false, columns?: Set<string>, query?: ReplayCursor['query']): void {
  if (!tokens.length) { if (empty) return; return rejectReplay(); }
  if (query !== undefined && ['SELECT', 'WITH', 'VALUES'].includes(kw(tokens, 0) ?? '')) {
    const inner = new ReplayCursor(tokens, schema, columns, query); query(inner, depth + 1); inner.done(); return;
  }
  for (const part of splitOn(tokens, ',')) {
    const inner = new ReplayCursor(part, schema, columns, query); replayExpression(inner, 0, depth + 1); inner.done();
  }
}
function queryCall(c: ReplayCursor, depth: number): void {
  const args = new ReplayCursor(c.parens(), c.schema, c.columns, c.query);
  if (!args.tokens.length) return;
  if (!args.word('DISTINCT')) args.word('ALL');
  do { replayExpression(args, 0, depth + 1); } while (args.punct(','));
  if (args.word('ORDER', 'BY')) {
    do {
      replayExpression(args, 0, depth + 1);
      if (!args.word('ASC')) args.word('DESC');
      if (args.word('NULLS') && !args.word('FIRST') && !args.word('LAST')) return rejectReplay();
    } while (args.punct(','));
  }
  args.done();
  if (c.word('FILTER')) {
    const predicate = new ReplayCursor(c.parens(), c.schema, c.columns, c.query);
    predicate.require('WHERE'); replayExpression(predicate, 0, depth + 1); predicate.done();
  }
}
function atom(c: ReplayCursor, depth: number): void {
  if (depth > 64) return rejectReplay();
  if (c.query !== undefined && c.word('EXISTS')) {
    const inner = new ReplayCursor(c.parens(), c.schema, undefined, c.query); c.query(inner, depth + 1); inner.done(); return;
  }
  if (c.punct('+') || c.punct('-') || c.word('NOT')) { replayExpression(c, 8, depth + 1); return; }
  if (c.word('CASE')) {
    if (kw(c.tokens, c.pos) !== 'WHEN') replayExpression(c, 0, depth + 1);
    let branches = 0;
    while (c.word('WHEN')) {
      replayExpression(c, 0, depth + 1); c.require('THEN'); replayExpression(c, 0, depth + 1);
      if (++branches > 1024) return rejectReplay();
    }
    if (!branches) return rejectReplay();
    if (c.word('ELSE')) replayExpression(c, 0, depth + 1);
    c.require('END'); return;
  }
  if (c.word('CAST')) {
    const inner = new ReplayCursor(c.parens(), c.schema, c.columns, c.query);
    replayExpression(inner, 0, depth + 1); inner.require('AS'); replayType(inner); inner.done(); return;
  }
  if (c.word('INTERVAL') || c.word('DATE') || c.word('TIMESTAMP') || c.word('TIME')) {
    if (c.tokens[c.pos++]?.t !== 'str') return rejectReplay();
    return;
  }
  if (c.word('ARRAY')) {
    const array = group(c.tokens, c.pos++, '['); if (array === null) return rejectReplay();
    list(array.items, c.schema, depth, true, c.columns, c.query); return;
  }
  if (group(c.tokens, c.pos, '(') !== null) { list(c.parens(), c.schema, depth, false, c.columns, c.query); return; }
  if (c.query !== undefined && c.punct('*')) return;
  const token = c.tokens[c.pos];
  if (token?.t === 'str' || token?.t === 'num') { c.pos += 1; return; }
  if (token?.t !== 'word' || (!token.quoted && FORBIDDEN.has(token.v.toUpperCase()))) return rejectReplay();
  const name = c.id();
  const qualified = c.punct('.');
  if (qualified) { if (c.query !== undefined && c.punct('*')) return; c.id(); if (isPunct(c.tokens, c.pos, '.')) return rejectReplay(); }
  if (group(c.tokens, c.pos, '(') !== null) {
    if (c.query !== undefined) queryCall(c, depth);
    else list(c.parens(), c.schema, depth, true, c.columns);
  }
  else if (c.columns !== undefined) {
    // A qualified non-call could be a composite field or another relation.
    // This subset cannot turn a suffix into a local column identity.
    if (qualified) return rejectReplay();
    if (token.quoted || !['TRUE', 'FALSE', 'NULL', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'LOCALTIME', 'LOCALTIMESTAMP', 'CURRENT_USER', 'SESSION_USER'].includes(name.toUpperCase())) c.columns.add(name);
  }
}

/** Consumes one expression and leaves a following DDL clause for its owner. */
export function replayExpression(c: ReplayCursor, min = 0, depth = 0): void {
  atom(c, depth);
  while (c.pos < c.tokens.length) {
    if (c.query !== undefined && group(c.tokens, c.pos, '[') !== null) {
      const bracket = c.tokens[c.pos++];
      if (bracket === undefined) return rejectReplay();
      const subscript = new ReplayCursor(bracket.items, c.schema, c.columns, c.query);
      if (!subscript.punct(':')) {
        replayExpression(subscript, 0, depth + 1);
        if (subscript.punct(':') && subscript.pos < subscript.tokens.length) replayExpression(subscript, 0, depth + 1);
      } else if (subscript.pos < subscript.tokens.length) replayExpression(subscript, 0, depth + 1);
      subscript.done(); continue;
    }
    if (c.punct('::')) { replayType(c); continue; }
    if (min <= 3 && c.word('IS')) {
      c.word('NOT');
      if (c.word('NULL') || c.word('TRUE') || c.word('FALSE') || c.word('UNKNOWN')) continue;
      c.require('DISTINCT', 'FROM'); replayExpression(c, 4, depth + 1); continue;
    }
    const start = c.pos;
    const negated = min <= 3 && c.word('NOT');
    if (min <= 3 && c.word('IN')) { list(c.parens(), c.schema, depth, false, c.columns, c.query); continue; }
    if (min <= 3 && c.word('BETWEEN')) {
      replayExpression(c, 4, depth + 1); c.require('AND'); replayExpression(c, 4, depth + 1); continue;
    }
    let op = kw(c.tokens, c.pos) ?? c.tokens[c.pos]?.v ?? '';
    let width = 1;
    for (const candidate of ['!~*', '!~', '~*', '->>', '#>>', '#>', '<@', '@>']) {
      const chars = candidate === '->>' ? ['->', '>'] : [...candidate];
      if (chars.every((part, i) => isPunct(c.tokens, c.pos + i, part))) { op = candidate; width = chars.length; break; }
    }
    const precedence = OPERATORS[op];
    if (precedence === undefined || precedence < min || (negated && op !== 'LIKE' && op !== 'ILIKE')) { c.pos = start; return; }
    c.pos += width;
    replayExpression(c, precedence + 1, depth + 1);
  }
}

export function replayCheck(c: ReplayCursor): void {
  const expression = new ReplayCursor(c.parens(), c.schema, c.columns);
  replayExpression(expression); expression.done(); c.word('NO', 'INHERIT');
}
