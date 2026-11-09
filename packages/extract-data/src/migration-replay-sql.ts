/** Closed DDL steps for historical table/column membership, never SQL execution. */
import { group, ident, kw, splitOn, type Tok } from '@seamline/core/sql';

import { ReplayCursor as Cursor, UnsupportedReplay as Unsupported, rejectReplay as reject, replayType, replayExpression, replayCheck } from './migration-replay-expression.ts';

import { parseReplayProcedure, type ReplayGuard } from './migration-replay-procedure.ts';

import { replayFunction, replayAlterFunction, replayPrivilege, replayDropRoutine, replayTrigger, replayPolicy } from './migration-replay-metadata.ts';
import { replayDataStatement, replayQuery } from './migration-replay-query.ts';

export type TableName = readonly [schema: string, table: string];
export type Target = readonly [schema: string, table: string, column: string | null];
export interface ForeignReference { readonly pos: number; readonly columns: readonly string[]; readonly table: TableName; readonly remote: readonly string[]; }
export type ImplicitRelation = { readonly kind: 'named'; readonly name: string } | { readonly kind: 'generated'; readonly label: 'pkey' | 'key' | 'seq' };
export interface ColumnDefinition { readonly name: string; readonly pos: number; readonly references: readonly ForeignReference[]; readonly local: readonly string[]; readonly implicit: readonly ImplicitRelation[]; }
export type AlterAction = (
  | { readonly kind: 'add'; readonly column: ColumnDefinition; readonly conditional: boolean }
  | { readonly kind: 'drop'; readonly column: string; readonly conditional: boolean }
  | { readonly kind: 'rename-column'; readonly from: string; readonly to: string }
  | { readonly kind: 'rename-table'; readonly to: string }
  | { readonly kind: 'set-schema'; readonly to: string }
  | { readonly kind: 'reference'; readonly columns: readonly string[]; readonly implicit?: readonly ImplicitRelation[] }
  | { readonly kind: 'foreign'; readonly reference: ForeignReference }
  | { readonly kind: 'none' }) & { readonly pos?: number; readonly unprovedCalls?: boolean };
export type DdlStep = (
  | { readonly kind: 'create'; readonly table: TableName; readonly columns: readonly ColumnDefinition[]; readonly foreign: readonly ForeignReference[]; readonly local: readonly string[]; readonly conditional: boolean; readonly implicit: readonly ImplicitRelation[] }
  | { readonly kind: 'alter'; readonly table: TableName; readonly conditional: boolean; readonly actions: readonly AlterAction[] }
  | { readonly kind: 'drop'; readonly tables: readonly TableName[]; readonly conditional: boolean }
  | { readonly kind: 'index'; readonly table: TableName; readonly columns: readonly string[]; readonly name: string; readonly conditional: boolean }
  | { readonly kind: 'relation'; readonly name: TableName; readonly conditional: boolean }
  | { readonly kind: 'view'; readonly table: TableName; readonly columns: readonly string[] | null; readonly replace: boolean }
  | { readonly kind: 'rows'; readonly targets: readonly TableName[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'guard'; readonly condition: ReplayGuard; readonly body: readonly DdlStep[] }
  | { readonly kind: 'unknown'; readonly reason: string }) & { readonly pos?: number; readonly nativeCalls?: readonly string[]; readonly routineChanges?: readonly TableName[] };

/** A token, bracket or literal cut short cannot establish a complete statement. */
function complete(tokens: readonly Tok[], depth = 0): boolean {
  return depth <= 64 && tokens.every((t) => !t.unterminated && (t.t !== 'word' || t.quoted || !/[^\u0000-\u007f]/.test(t.raw)) && (t.t !== 'group' || complete(t.items, depth + 1)));
}

function identifiers(tokens: readonly Tok[]): string[] {
  const values = splitOn(tokens, ',').map((part) => {
    if (part.length !== 1) return reject();
    const item = new Cursor(part, 'public'); const value = item.id(); item.done(); return value;
  });
  if (values.length === 0 || new Set(values).size !== values.length) return reject();
  return values;
}

function reference(cursor: Cursor, local: readonly string[]): ForeignReference {
  const pos = cursor.tokens[cursor.pos]?.pos ?? 0;
  cursor.require('REFERENCES');
  const table = cursor.name();
  const remote = identifiers(cursor.parens());
  if (remote.length !== local.length) return reject();
  // Each suffix has a closed grammar; an unrecognized tail is not ignored.
  while (cursor.pos < cursor.tokens.length) {
    if (cursor.word('ON')) {
      if (!cursor.word('DELETE') && !cursor.word('UPDATE')) return reject();
      if (cursor.word('NO', 'ACTION') || cursor.word('RESTRICT') || cursor.word('CASCADE')) continue;
      if (cursor.word('SET')) {
        if (!cursor.word('NULL') && !cursor.word('DEFAULT')) return reject();
        continue;
      }
      return reject();
    }
    if (cursor.word('MATCH')) {
      if (!cursor.word('FULL') && !cursor.word('SIMPLE')) return reject();
      continue;
    }
    if (cursor.word('DEFERRABLE') || cursor.word('NOT', 'DEFERRABLE')) continue;
    if (cursor.word('INITIALLY')) {
      if (!cursor.word('DEFERRED') && !cursor.word('IMMEDIATE')) return reject();
      continue;
    }
    break;
  }
  return { pos, columns: local, table, remote };
}

/** Initially accept declarations whose complete column tail is understood. */
function column(tokens: readonly Tok[], schema: string): ColumnDefinition {
  const local = new Set<string>();
  const c = new Cursor(tokens, schema, local);
  const name = c.id();
  const implicit: ImplicitRelation[] = [];
  if (['SERIAL', 'SERIAL2', 'SERIAL4', 'SERIAL8', 'SMALLSERIAL', 'BIGSERIAL'].includes((ident(c.tokens, c.pos) ?? '').toUpperCase()) && c.tokens[c.pos + 1]?.v !== '.') implicit.push({ kind: 'generated', label: 'seq' });
  replayType(c);
  const references: ForeignReference[] = [];
  let constraint: string | undefined;
  while (c.pos < tokens.length) {
    if (c.word('CONSTRAINT')) { if (constraint !== undefined) return reject(); constraint = c.id(); continue; }
    if (c.word('NOT', 'NULL') || c.word('NULL')) { constraint = undefined; continue; }
    const primary = c.word('PRIMARY', 'KEY');
    if (primary || c.word('UNIQUE')) {
      implicit.push(constraint === undefined ? { kind: 'generated', label: primary ? 'pkey' : 'key' } : { kind: 'named', name: constraint });
      constraint = undefined; continue;
    }
    if (kw(c.tokens, c.pos) === 'REFERENCES') { references.push(reference(c, [name])); constraint = undefined; continue; }
    if (c.word('GENERATED')) {
      if (c.word('ALWAYS')) { /* Only stored expressions in this subset. */ }
      else return reject();
      c.require('AS');
      const expression = new Cursor(c.parens(), c.schema, local); replayExpression(expression); expression.done();
      c.require('STORED'); constraint = undefined; continue;
    }
    if (c.word('DEFAULT')) {
      const defaults = new Set<string>();
      const expression = new Cursor(c.tokens.slice(c.pos), c.schema, defaults);
      replayExpression(expression); c.pos += expression.pos;
      if (defaults.size) return reject();
      constraint = undefined; continue;
    }
    if (c.word('CHECK')) { replayCheck(c); constraint = undefined; continue; }
    return reject();
  }
  if (constraint !== undefined) return reject();
  return { name, pos: tokens[0]?.pos ?? 0, references, local: [...local].sort(), implicit };
}

function create(cursor: Cursor): DdlStep {
  const conditional = cursor.word('IF', 'NOT', 'EXISTS');
  const table = cursor.name();
  const body = cursor.parens();
  const columns: ColumnDefinition[] = [];
  const foreign: ForeignReference[] = [];
  const local: string[] = [];
  const implicit: ImplicitRelation[] = [];
  for (const part of splitOn(body, ',')) {
    const item = new Cursor(part, cursor.schema);
    const constraint = item.word('CONSTRAINT') ? item.id() : undefined;
    if (item.word('FOREIGN', 'KEY')) {
      const local = identifiers(item.parens());
      foreign.push(reference(item, local)); item.done();
    } else if (item.word('PRIMARY', 'KEY')) {
      const names = identifiers(item.parens()); item.done();
      // Checked after all column declarations, so constraint order is irrelevant.
      local.push(...names);
      implicit.push(constraint === undefined ? { kind: 'generated', label: 'pkey' } : { kind: 'named', name: constraint });
    } else if (item.word('UNIQUE')) {
      local.push(...identifiers(item.parens())); item.done();
      implicit.push(constraint === undefined ? { kind: 'generated', label: 'key' } : { kind: 'named', name: constraint });
    } else if (item.word('CHECK')) {
      const columns = new Set<string>();
      const expression = new Cursor(item.tokens.slice(item.pos), item.schema, columns);
      replayCheck(expression); expression.done(); local.push(...columns);
    }
    else columns.push(column(part, cursor.schema));
  }
  if (!columns.length || new Set(columns.map((c) => c.name)).size !== columns.length) return reject();
  cursor.done();
  return { kind: 'create', table, columns, foreign, local, conditional, implicit };
}

/** A parsed CHECK can still invoke a routine while validating existing rows.
 * This conservative token effect inventory supplies refusal, never call purity. */
function unprovedCalls(tokens: readonly Tok[]): boolean {
  return tokens.some((token, index) =>
    (token.t === 'word' && group(tokens, index + 1, '(') !== null &&
      (token.quoted || tokens[index - 1]?.v === '.' || !['AND', 'OR', 'NOT', 'IN'].includes(token.v.toUpperCase()))) ||
    (token.t === 'group' && unprovedCalls(token.items)));
}

function alter(cursor: Cursor): DdlStep {
  const conditional = cursor.word('IF', 'EXISTS');
  const table = cursor.name();
  const actions: AlterAction[] = [];
  for (const part of splitOn(cursor.tokens.slice(cursor.pos), ',')) {
    const c = new Cursor(part, cursor.schema);
    if (c.word('ADD')) {
      const constraint = c.word('CONSTRAINT') ? c.id() : undefined;
      if (c.word('FOREIGN', 'KEY')) {
        const local = identifiers(c.parens());
        const foreign = reference(c, local); c.word('NOT', 'VALID'); c.done();
        actions.push({ kind: 'foreign', reference: foreign });
      } else if (c.word('PRIMARY', 'KEY')) {
        const names = identifiers(c.parens()); c.done();
        actions.push({ kind: 'reference', columns: names, implicit: [constraint === undefined ? { kind: 'generated', label: 'pkey' } : { kind: 'named', name: constraint }] });
      } else if (c.word('UNIQUE')) {
        const names = identifiers(c.parens()); c.done();
        actions.push({ kind: 'reference', columns: names, implicit: [constraint === undefined ? { kind: 'generated', label: 'key' } : { kind: 'named', name: constraint }] });
      } else if (c.word('CHECK')) {
        const columns = new Set<string>();
        const expression = new Cursor(c.tokens.slice(c.pos), c.schema, columns);
        replayCheck(expression); expression.word('NOT', 'VALID'); expression.done();
        actions.push({ kind: 'reference', columns: [...columns].sort(), unprovedCalls: unprovedCalls(c.tokens.slice(c.pos)) });
      } else {
        if (constraint !== undefined) return reject();
        c.word('COLUMN');
        const skip = c.word('IF', 'NOT', 'EXISTS');
        actions.push({ kind: 'add', conditional: skip, column: column(c.tokens.slice(c.pos), c.schema) });
      }
    } else if (c.word('DROP')) {
      if (c.word('CONSTRAINT')) {
        c.word('IF', 'EXISTS'); c.id(); c.word('RESTRICT'); c.done();
        actions.push({ kind: 'none' });
      } else {
        c.word('COLUMN'); const skip = c.word('IF', 'EXISTS'); const name = c.id();
        c.word('RESTRICT'); c.done();
        actions.push({ kind: 'drop', column: name, conditional: skip });
      }
    } else if (c.word('ALTER')) {
      c.word('COLUMN'); const name = c.id();
      let callEffects = false;
      if (c.word('TYPE')) {
        replayType(c); callEffects = true;
      } else if (c.word('SET', 'DEFAULT')) {
        const columns = new Set<string>();
        const expression = new Cursor(c.tokens.slice(c.pos), c.schema, columns);
        callEffects = unprovedCalls(expression.tokens);
        replayExpression(expression); expression.done();
        if (columns.size) return reject(); c.pos = c.tokens.length;
      }
      else if (!c.word('SET', 'NOT', 'NULL') && !c.word('DROP', 'NOT', 'NULL') && !c.word('DROP', 'DEFAULT')) return reject();
      c.done(); actions.push({ kind: 'reference', columns: [name], unprovedCalls: callEffects });
    } else if (c.word('VALIDATE', 'CONSTRAINT')) {
      c.id(); c.done(); actions.push({ kind: 'none', unprovedCalls: true });
    } else if (c.word('RENAME')) {
      if (c.word('TO')) { const to = c.id(); c.done(); actions.push({ kind: 'rename-table', to }); }
      else { c.word('COLUMN'); const from = c.id(); c.require('TO'); const to = c.id(); c.done(); actions.push({ kind: 'rename-column', from, to }); }
    } else if (c.word('SET', 'SCHEMA')) {
      const to = c.id(); c.done(); actions.push({ kind: 'set-schema', to });
    } else if (c.word('ENABLE', 'ROW', 'LEVEL', 'SECURITY') || c.word('DISABLE', 'ROW', 'LEVEL', 'SECURITY') || c.word('FORCE', 'ROW', 'LEVEL', 'SECURITY') || c.word('NO', 'FORCE', 'ROW', 'LEVEL', 'SECURITY')) {
      c.done(); actions.push({ kind: 'none' });
    } else return reject();
    actions[actions.length - 1] = { ...actions[actions.length - 1]!, pos: part[0]?.pos ?? 0 };
  }
  // Only homogeneous additions, or membership-preserving changes, may combine.
  // Renames, drops and mixed mutation phases remain unsupported.
  if (!actions.length || (actions.length > 1 && !actions.every((a) => a.kind === 'add') && !actions.every((a) => ['reference', 'foreign', 'none'].includes(a.kind)))) return reject();
  const added = actions.flatMap((a) => a.kind === 'add' ? [a.column.name] : []);
  if (new Set(added).size !== added.length) return reject();
  return { kind: 'alter', table, conditional, actions };
}

function view(c: Cursor, replace: boolean): DdlStep {
  const table = c.name();
  const names = c.tokens[c.pos]?.raw.startsWith('(') ? identifiers(c.parens()) : undefined;
  if (c.word('WITH')) {
    const seen = new Set<string>();
    for (const part of splitOn(c.parens(), ',')) {
      const option = new Cursor(part, c.schema); const key = option.id();
      if (!['security_invoker', 'security_barrier'].includes(key) || seen.has(key) || !option.punct('=') || (!option.word('TRUE') && !option.word('FALSE'))) return reject();
      seen.add(key); option.done();
    }
    if (!seen.size) return reject();
  }
  c.require('AS');
  const query = new Cursor(c.tokens.slice(c.pos), c.schema, undefined, replayQuery);
  const projection = replayQuery(query); query.done(); c.pos = c.tokens.length;
  const columns = [...projection.columns];
  if (names !== undefined) {
    if (projection.widthKnown && names.length > columns.length) return reject();
    for (const [index, name] of names.entries()) columns[index] = name;
  }
  const complete = projection.widthKnown && columns.every((name) => name !== null) && new Set(columns).size === columns.length;
  return { kind: 'view', table, columns: complete ? columns as string[] : null, replace };
}

function parseDdl(tokens: readonly Tok[], schema: string): DdlStep {
  if (!complete(tokens)) return { kind: 'unknown', reason: 'incomplete SQL token or nesting limit' };
  try {
    const c = new Cursor(tokens, schema);
    if (['INSERT', 'UPDATE', 'DELETE', 'WITH'].includes(kw(tokens, 0) ?? '')) { return { kind: 'rows', targets: replayDataStatement(c) }; }
    if (c.word('GRANT')) { replayPrivilege(c, true); return { kind: 'none' }; }
    if (c.word('REVOKE')) { replayPrivilege(c, false); return { kind: 'none' }; }
    if (c.word('DO')) return parseReplayProcedure(c, parseReplayDdl);
    if (c.word('CREATE')) {
      const replace = c.word('OR', 'REPLACE');
      if (c.word('VIEW')) return view(c, replace);
      if (c.word('FUNCTION')) return { kind: 'none', routineChanges: [replayFunction(c)] };
      if (c.word('TRIGGER')) { replayTrigger(c); return { kind: 'none' }; }
      if (replace) return reject();
      if (c.word('POLICY')) { replayPolicy(c); return { kind: 'none' }; }
      if (c.word('SEQUENCE')) {
        const conditional = c.word('IF', 'NOT', 'EXISTS'); const name = c.name();
        const seen = new Set<string>();
        while (c.pos < c.tokens.length) {
          const option = kw(c.tokens, c.pos++);
          if (option === null || seen.has(option)) return reject();
          seen.add(option);
          if (option === 'START') c.word('WITH');
          else if (option === 'INCREMENT') c.word('BY');
          else return reject();
          const value = c.tokens[c.pos++];
          if (value?.t !== 'num' || value.v.length > 19 || !/^[1-9][0-9]*$/.test(value.v) || BigInt(value.v) > 9223372036854775807n) return reject();
        }
        c.done(); return { kind: 'relation', name, conditional };
      }
      if (c.word('SCHEMA')) { c.word('IF', 'NOT', 'EXISTS'); c.id(); c.done(); return { kind: 'none' }; }
      if (c.word('TABLE')) return create(c);
      if (c.word('TYPE')) {
        c.name(); c.require('AS', 'ENUM');
        const parts = splitOn(c.parens(), ',');
        if (!parts.length || parts.some((part) => part.length !== 1 || part[0]?.t !== 'str')) return reject();
        if (new Set(parts.map((part) => part[0]?.v)).size !== parts.length) return reject();
        c.done(); return { kind: 'none' };
      }
      if (c.word('AGGREGATE')) {
        const name = c.name();
        for (const part of splitOn(c.parens(), ',')) { const arg = new Cursor(part, schema); replayType(arg); arg.done(); }
        const body = c.parens(); const seen = new Set<string>();
        for (const part of splitOn(body, ',')) {
          const item = new Cursor(part, schema); const field = item.id();
          if (seen.has(field) || !item.punct('=')) return reject();
          seen.add(field);
          if (field === 'sfunc') item.name();
          else if (field === 'stype') replayType(item);
          else return reject();
          item.done();
        }
        if (seen.size !== 2) return reject();
        c.done(); return { kind: 'none', routineChanges: [name] };
      }

      c.word('UNIQUE');
      if (c.word('INDEX')) {
        const conditional = c.word('IF', 'NOT', 'EXISTS'); const name = c.id(); c.require('ON');
        const table = c.name();
        if (c.word('USING')) {
          if (!['btree', 'hash', 'gin', 'gist', 'spgist', 'brin'].includes(c.id())) return reject();
        }
        const columns = new Set<string>();
        for (const part of splitOn(c.parens(), ',')) {
          const expression = new Cursor(part, schema, columns);
          replayExpression(expression);
          if (expression.word('COLLATE')) expression.name();
          if (ident(expression.tokens, expression.pos) !== null && !['ASC', 'DESC', 'NULLS'].includes(kw(expression.tokens, expression.pos) ?? '')) expression.name();
          if (!expression.word('ASC')) expression.word('DESC');
          if (expression.word('NULLS') && !expression.word('FIRST') && !expression.word('LAST')) return reject();
          expression.done();
        }
        if (c.word('WHERE')) {
          const predicate = new Cursor(c.tokens.slice(c.pos), schema, columns);
          replayExpression(predicate); predicate.done(); c.pos = c.tokens.length;
        }
        c.done(); return { kind: 'index', table, columns: [...columns].sort(), name, conditional };
      }
    } else if (c.word('ALTER', 'TABLE')) return alter(c);
    else if (c.word('ALTER', 'FUNCTION')) {
      return { kind: 'none', routineChanges: [replayAlterFunction(c)] };
    }
    else if (c.word('ALTER', 'DEFAULT', 'PRIVILEGES')) {
      if (c.word('IN', 'SCHEMA')) { do { c.id(); } while (c.punct(',')); }
      const grant = c.word('GRANT'); if (!grant) c.require('REVOKE');
      replayPrivilege(c, grant, true); return { kind: 'none' };
    }
    else if (c.word('DROP', 'FUNCTION') || c.word('DROP', 'AGGREGATE')) { return { kind: 'none', routineChanges: replayDropRoutine(c) }; }
    else if (c.word('DROP', 'POLICY')) {
      c.word('IF', 'EXISTS'); c.metadataName(); c.require('ON'); c.name(); c.word('RESTRICT'); c.done(); return { kind: 'none' };
    }
    else if (c.word('DROP', 'TRIGGER')) {
      c.word('IF', 'EXISTS'); c.id(); c.require('ON'); c.name(); c.word('RESTRICT'); c.done(); return { kind: 'none' };
    }
    else if (c.word('DROP', 'TABLE')) {
      const conditional = c.word('IF', 'EXISTS');
      const tables: TableName[] = [];
      for (const part of splitOn(c.tokens.slice(c.pos), ',')) {
        const item = new Cursor(part, schema); tables.push(item.name()); item.word('RESTRICT'); item.done();
      }
      return { kind: 'drop', tables, conditional };
    } else if (c.word('BEGIN') || c.word('COMMIT')) {
      c.done(); return { kind: 'none' };
    }
    return { kind: 'unknown', reason: 'unsupported statement form' };
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    return { kind: 'unknown', reason: error.message };
  }
}

export function parseReplayDdl(tokens: readonly Tok[], schema: string): DdlStep {
  return { ...parseDdl(tokens, schema), pos: tokens[0]?.pos ?? 0 };
}
