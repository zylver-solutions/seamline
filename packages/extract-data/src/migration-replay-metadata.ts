/** Checked declarations that do not change project-declared table/column membership. */
import { group, kw, splitOn, type Tok } from '@seamline/core/sql';
import { ReplayCursor as Cursor, UnsupportedReplay, rejectReplay as reject, replayExpression, replayType } from './migration-replay-expression.ts';
import { replayQuery } from './migration-replay-query.ts';

function parameters(tokens: readonly Tok[], schema: string, named: boolean): void {
  if (!tokens.length) return;
  for (const part of splitOn(tokens, ',')) {
    const c = new Cursor(part, schema);
    if (!c.word('INOUT') && !c.word('IN') && !c.word('OUT')) c.word('VARIADIC');
    const start = c.pos;
    const tail = (): void => {
      replayType(c);
      if (c.word('DEFAULT') || c.punct('=')) replayExpression(c);
      c.done();
    };
    try { tail(); }
    catch (error) {
      if (!(error instanceof UnsupportedReplay) || !named) throw error;
      c.pos = start; c.id(); tail();
    }
  }
}
function setting(c: Cursor): void {
  c.require('SEARCH_PATH');
  if (!c.punct('=') && !c.word('TO')) return reject();
  do {
    if (c.tokens[c.pos]?.t === 'str') c.pos += 1;
    else c.id();
  } while (c.punct(','));
}
/** SQL/PLpgSQL string bodies are stored definitions, not executed DO blocks.
 * PostgreSQL describes this distinction at
 * https://www.postgresql.org/docs/16/sql-createfunction.html
 * Runtime effects of invoking them remain outside the declared-DDL claim.
 */
export function replayFunction(c: Cursor): readonly [string, string] {
  const name = c.name(); parameters(c.parens(), c.schema, true); c.require('RETURNS');
  if (c.word('TABLE')) parameters(c.parens(), c.schema, true);
  else { c.word('SETOF'); replayType(c); }
  let language = false, body = false;
  const seen = new Set<string>();
  while (c.pos < c.tokens.length) {
    if (c.word('LANGUAGE')) {
      if (language || (!c.word('SQL') && !c.word('PLPGSQL'))) return reject();
      language = true;
    } else if (c.word('AS')) {
      if (body || c.tokens[c.pos++]?.t !== 'str') return reject();
      body = true;
    } else if (c.word('SET')) {
      if (seen.has('search_path')) return reject();
      seen.add('search_path'); setting(c);
    } else {
      const key = kw(c.tokens, c.pos);
      if (key === null || seen.has(key)) return reject();
      seen.add(key);
      if (c.word('SECURITY')) { if (!c.word('DEFINER') && !c.word('INVOKER')) return reject(); }
      else if (c.word('IMMUTABLE') || c.word('STABLE') || c.word('VOLATILE') || c.word('STRICT') || c.word('LEAKPROOF') || c.word('NOT', 'LEAKPROOF') || c.word('RETURNS', 'NULL', 'ON', 'NULL', 'INPUT') || c.word('CALLED', 'ON', 'NULL', 'INPUT')) { /* Closed attributes. */ }
      else if (c.word('PARALLEL')) { if (!c.word('SAFE') && !c.word('RESTRICTED') && !c.word('UNSAFE')) return reject(); }
      else if (c.word('COST') || c.word('ROWS')) { if (c.tokens[c.pos++]?.t !== 'num') return reject(); }
      else return reject();
    }
  }
  if (!language || !body) return reject();
  return name;
}

export function replayAlterFunction(c: Cursor): readonly [string, string] {
  const name = c.name(); parameters(c.parens(), c.schema, false); c.require('SET'); setting(c); c.done();
  return name;
}

/** Privilege syntax grants no table/column membership or existence assumptions. */
export function replayPrivilege(c: Cursor, grant: boolean, defaults = false): void {
  const privileges = new Set(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'EXECUTE', 'USAGE', 'CREATE', 'CONNECT', 'TEMPORARY', 'TEMP']);
  do {
    const privilege = kw(c.tokens, c.pos++);
    if (privilege === null || !privileges.has(privilege)) return reject();
    if (privilege === 'ALL') c.word('PRIVILEGES');
    if (group(c.tokens, c.pos, '(') !== null) {
      for (const part of splitOn(c.parens(), ',')) { const col = new Cursor(part, c.schema); col.id(); col.done(); }
    }
  } while (c.punct(','));
  c.require('ON');
  if (defaults) {
    if (!c.word('FUNCTIONS') && !c.word('TABLES') && !c.word('SEQUENCES') && !c.word('TYPES') && !c.word('SCHEMAS')) return reject();
  } else {
    const functions = c.word('FUNCTION');
    if (!functions && !c.word('TABLE') && !c.word('SEQUENCE')) c.word('SCHEMA');
    do { c.name(); if (functions) parameters(c.parens(), c.schema, false); } while (c.punct(','));
  }
  c.require(grant ? 'TO' : 'FROM');
  do { c.id(); } while (c.punct(','));
  if (grant) c.word('WITH', 'GRANT', 'OPTION');
  else c.word('RESTRICT');
  c.done();
}

export function replayDropRoutine(c: Cursor): readonly (readonly [string, string])[] {
  const names: (readonly [string, string])[] = [];
  c.word('IF', 'EXISTS');
  do { names.push(c.name()); parameters(c.parens(), c.schema, false); } while (c.punct(','));
  c.word('RESTRICT'); c.done();
  return names;
}

/** Trigger creation stores a later row-operation hook. It does not invoke it. */
export function replayTrigger(c: Cursor): void {
  c.id();
  if (!c.word('BEFORE') && !c.word('AFTER') && !c.word('INSTEAD', 'OF')) return reject();
  do {
    if (c.word('UPDATE')) {
      if (c.word('OF')) { do { c.id(); } while (c.punct(',')); }
    } else if (!c.word('INSERT') && !c.word('DELETE') && !c.word('TRUNCATE')) return reject();
  } while (c.word('OR'));
  c.require('ON'); c.name();
  if (c.word('FOR')) { c.word('EACH'); if (!c.word('ROW') && !c.word('STATEMENT')) return reject(); }
  if (c.word('WHEN')) {
    const when = new Cursor(c.parens(), c.schema); replayExpression(when); when.done();
  }
  c.require('EXECUTE'); if (!c.word('FUNCTION') && !c.word('PROCEDURE')) return reject();
  c.name();
  const args = c.parens();
  if (args.length && splitOn(args, ',').some((part) => part.length !== 1 || !['str', 'num'].includes(part[0]?.t ?? ''))) return reject();
  c.done();
}

/** Policies store row-access predicates; this grammar makes no predicate facts. */
export function replayPolicy(c: Cursor): void {
  c.metadataName(); c.require('ON'); c.name();
  if (c.word('AS') && !c.word('PERMISSIVE') && !c.word('RESTRICTIVE')) return reject();
  if (c.word('FOR') && !c.word('ALL') && !c.word('SELECT') && !c.word('INSERT') && !c.word('UPDATE') && !c.word('DELETE')) return reject();
  if (c.word('TO')) { do { c.id(); } while (c.punct(',')); }
  if (c.word('USING')) {
    const expression = new Cursor(c.parens(), c.schema, undefined, replayQuery); replayExpression(expression); expression.done();
  }
  if (c.word('WITH', 'CHECK')) {
    const expression = new Cursor(c.parens(), c.schema, undefined, replayQuery); replayExpression(expression); expression.done();
  }
  c.done();
}
