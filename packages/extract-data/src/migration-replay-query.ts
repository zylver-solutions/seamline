/** Closed read-query syntax for stored predicates. Never runs a query. */
import { group, ident, isPunct, kw, splitOn, type Tok } from '@seamline/core/sql';
import type { TableName } from './migration-replay-sql.ts';
import { ReplayCursor as Cursor, replayExpression, rejectReplay as reject } from './migration-replay-expression.ts';

const CLAUSES = new Set(['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'FOR', 'INTO', 'WINDOW', 'RETURNING', 'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'LATERAL', 'WHEN', 'THEN', 'ELSE', 'END', 'AS', 'SELECT', 'WITH', 'VALUES', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'EXECUTE', 'DO', 'BEGIN', 'COMMIT', 'ROLLBACK', 'GRANT', 'REVOKE', 'AND', 'OR', 'NOT', 'IS', 'IN', 'BETWEEN', 'SET']);
export interface QueryProjection { readonly columns: readonly (string | null)[]; readonly widthKnown: boolean; }
const LABELLESS = new Set(['TRUE', 'FALSE', 'NULL', 'CAST', 'CASE', 'ARRAY', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'LOCALTIME', 'LOCALTIMESTAMP', 'CURRENT_USER', 'SESSION_USER']);
function label(tokens: readonly Tok[]): string | null {
  if (LABELLESS.has(kw(tokens, 0) ?? '')) return null;
  if (tokens.length === 1) return ident(tokens, 0);
  if (tokens.length === 3 && tokens[1]?.v === '.') return ident(tokens, 2);
  if (tokens.length === 2 && group(tokens, 1, '(') !== null) return ident(tokens, 0);
  if (tokens.length === 4 && tokens[1]?.v === '.' && group(tokens, 3, '(') !== null) return ident(tokens, 2);
  return null;
}
function expression(c: Cursor, depth: number): void { replayExpression(c, 0, depth + 1); }
function identifiers(tokens: readonly Tok[], schema: string): void {
  const seen = new Set<string>();
  for (const part of splitOn(tokens, ',')) {
    const c = new Cursor(part, schema); const name = c.id(); c.done();
    if (seen.has(name)) return reject(); seen.add(name);
  }
  if (!seen.size) return reject();
}
function alias(c: Cursor, columns = false): string | undefined {
  const explicit = c.word('AS');
  if (explicit || (ident(c.tokens, c.pos) !== null && !CLAUSES.has(kw(c.tokens, c.pos) ?? ''))) {
    if (CLAUSES.has(kw(c.tokens, c.pos) ?? '')) return reject();
    const name = c.id();
    if (columns && group(c.tokens, c.pos, '(') !== null) identifiers(c.parens(), c.schema);
    return name;
  }
  return undefined;
}
function source(c: Cursor, depth: number): void {
  const lateral = c.word('LATERAL');
  if (group(c.tokens, c.pos, '(') !== null) {
    const inner = new Cursor(c.parens(), c.schema, undefined, replayQuery);
    replayQuery(inner, depth + 1); inner.done();
  } else {
    c.name();
    if (group(c.tokens, c.pos, '(') !== null) {
      const args = c.parens();
      if (args.length) for (const part of splitOn(args, ',')) {
        const inner = new Cursor(part, c.schema, undefined, replayQuery); expression(inner, depth); inner.done();
      }
    } else if (lateral) return reject();
  }
  alias(c, true);
}
function from(c: Cursor, depth: number): void {
  source(c, depth);
  for (;;) {
    if (c.punct(',')) { source(c, depth); continue; }
    const natural = c.word('NATURAL');
    const cross = c.word('CROSS');
    const outer = c.word('LEFT') || c.word('RIGHT') || c.word('FULL');
    if (outer) c.word('OUTER');
    const inner = c.word('INNER');
    if (!c.word('JOIN')) {
      if (natural || cross || outer || inner) return reject();
      return;
    }
    if (cross && (natural || outer || inner)) return reject();
    source(c, depth);
    if (natural || cross) continue;
    if (c.word('ON')) expression(c, depth);
    else { c.require('USING'); identifiers(c.parens(), c.schema); }
  }
}
function ordering(c: Cursor, depth: number): void {
  do {
    expression(c, depth);
    if (!c.word('ASC')) c.word('DESC');
    if (c.word('NULLS') && !c.word('FIRST') && !c.word('LAST')) return reject();
  } while (c.punct(','));
}
function body(c: Cursor, depth: number): QueryProjection {
  if (c.word('VALUES')) {
    let width: number | undefined;
    do {
      const columns = splitOn(c.parens(), ',');
      if (width !== undefined && columns.length !== width) return reject();
      width = columns.length;
      for (const part of columns) { const inner = new Cursor(part, c.schema, undefined, replayQuery); expression(inner, depth); inner.done(); }
    } while (c.punct(','));
    return { columns: Array<string | null>(width ?? 0).fill(null), widthKnown: true };
  }
  c.require('SELECT');
  if (c.word('DISTINCT')) {
    if (c.word('ON')) for (const part of splitOn(c.parens(), ',')) {
      const inner = new Cursor(part, c.schema, undefined, replayQuery); expression(inner, depth); inner.done();
    }
  } else c.word('ALL');
  const columns: (string | null)[] = [];
  let widthKnown = true;
  do {
    const start = c.pos; expression(c, depth); const span = c.tokens.slice(start, c.pos);
    const named = alias(c);
    if ((span.length === 1 && isPunct(span, 0, '*')) || (span.length === 3 && isPunct(span, 1, '.') && isPunct(span, 2, '*'))) {
      if (named !== undefined) return reject(); widthKnown = false;
    }
    columns.push(named ?? label(span));
  } while (c.punct(','));
  if (c.word('FROM')) from(c, depth);
  if (c.word('WHERE')) expression(c, depth);
  if (c.word('GROUP', 'BY')) { do { expression(c, depth); } while (c.punct(',')); }
  if (c.word('HAVING')) expression(c, depth);
  return { columns, widthKnown };
}

function readWith(c: Cursor, depth: number, read: (cursor: Cursor, depth: number) => void = replayQuery): void {
  if (depth > 32) return reject();
  if (c.word('WITH')) {
    c.word('RECURSIVE');
    const names = new Set<string>();
    do {
      const name = c.id(); if (names.has(name) || names.size >= 256) return reject(); names.add(name);
      if (group(c.tokens, c.pos, '(') !== null) identifiers(c.parens(), c.schema);
      c.require('AS'); if (c.word('NOT')) c.require('MATERIALIZED'); else c.word('MATERIALIZED');
      const inner = new Cursor(c.parens(), c.schema, undefined, replayQuery); read(inner, depth + 1); inner.done();
    } while (c.punct(','));
  }
}

/** SELECT/VALUES and read-only CTEs. INTO, locking and DML are not accepted. */
export function replayQuery(c: Cursor, depth = 0): QueryProjection {
  readWith(c, depth);
  const projection = body(c, depth);
  let widthKnown = projection.widthKnown;
  while (c.word('UNION') || c.word('INTERSECT') || c.word('EXCEPT')) {
    if (!c.word('ALL')) c.word('DISTINCT');
    const other = body(c, depth);
    if (widthKnown && other.widthKnown && projection.columns.length !== other.columns.length) return reject();
    widthKnown = widthKnown && other.widthKnown;
  }
  if (c.word('ORDER', 'BY')) ordering(c, depth);
  if (c.word('LIMIT') && !c.word('ALL')) expression(c, depth);
  if (c.word('OFFSET')) { expression(c, depth); if (!c.word('ROW')) c.word('ROWS'); }
  return { columns: projection.columns, widthKnown };
}

function assignments(c: Cursor, depth: number): void {
  const seen = new Set<string>();
  do {
    const column = c.id();
    if (seen.has(column) || !c.punct('=')) return reject(); seen.add(column);
    if (!c.word('DEFAULT')) expression(c, depth);
  } while (c.punct(','));
}

/** Catalog rows encode membership. They cannot receive the ordinary-row
 * exemption, including through a writable CTE or an implicit catalog name. */
function rowTarget(c: Cursor, targets: TableName[]): void {
  const start = c.pos;
  const [schema, name] = c.name();
  targets.push([schema, name]);
  if (schema === 'information_schema' || schema.startsWith('pg_') || (c.pos - start === 1 && name.startsWith('pg_'))) return reject();
}

/** Checked row writes have no project-declared table/column membership effect.
 * They contribute no reference validity or runtime side-effect evidence.
 * Policy query delegates never call this entry point.
 */
function dataBody(c: Cursor, depth: number, targets: TableName[]): void {
  readWith(c, depth, (inner, nesting) => dataBody(inner, nesting, targets));
  if (['SELECT', 'VALUES'].includes(kw(c.tokens, c.pos) ?? '')) { replayQuery(c, depth); return; }
  if (c.word('INSERT')) {
    c.require('INTO'); rowTarget(c, targets);
    if (c.word('AS')) c.id();
    if (group(c.tokens, c.pos, '(') !== null) identifiers(c.parens(), c.schema);
    if (c.word('DEFAULT')) c.require('VALUES');
    else replayQuery(c, depth);
    if (c.word('ON', 'CONFLICT')) {
      let target = false;
      if (group(c.tokens, c.pos, '(') !== null) { identifiers(c.parens(), c.schema); target = true; }
      else if (c.word('ON', 'CONSTRAINT')) { c.id(); target = true; }
      if (target && c.word('WHERE')) expression(c, depth);
      c.require('DO');
      if (!c.word('NOTHING')) {
        if (!target) return reject(); c.require('UPDATE', 'SET'); assignments(c, depth);
        if (c.word('WHERE')) expression(c, depth);
      }
    }
  } else if (c.word('UPDATE')) {
    c.word('ONLY'); rowTarget(c, targets); alias(c); c.require('SET'); assignments(c, depth);
    if (c.word('FROM')) from(c, depth);
    if (c.word('WHERE')) expression(c, depth);
  } else if (c.word('DELETE')) {
    c.require('FROM'); c.word('ONLY'); rowTarget(c, targets); alias(c);
    if (c.word('USING')) from(c, depth);
    if (c.word('WHERE')) expression(c, depth);
  } else return reject();
  if (c.word('RETURNING')) { do { expression(c, depth); alias(c); } while (c.punct(',')); }
}

export function replayDataStatement(cursor: Cursor): readonly TableName[] {
  const c = new Cursor(cursor.tokens.slice(cursor.pos), cursor.schema, undefined, replayQuery);
  const targets: TableName[] = [];
  dataBody(c, 0, targets);
  c.done(); cursor.pos = cursor.tokens.length;
  return targets;
}
