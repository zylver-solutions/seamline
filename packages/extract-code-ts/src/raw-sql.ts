/**
 * Raw SQL in string and template literals, read as tokens.
 *
 * `classifyRawSql` takes the text of one literal and returns, for each statement
 * in it, the (table, class) pairs it touches and, for an insert or an update,
 * the columns it names and whether that list is complete. Design:
 * `docs/design/real-world-inputs.md`, sections 3.4 and 4.2.
 *
 * A write statement is recognised by its shape (`INSERT ... INTO <name>`,
 * `UPDATE <name> SET`, `DELETE FROM <name>`, ...), read from the tokens of
 * `@seamline/core/sql`, not from a pattern over the characters. Text that
 * begins with a verb but lacks the rest of the structure (`"Update assumption"`,
 * `"Call us"`) is not a statement and yields nothing. A `SELECT` or a `WITH`
 * keeps the read gate of `sql.ts`.
 *
 * What a column set promises. `complete` is true only when every column the
 * statement writes is known from this text: a column list that is closed in
 * this literal, whose items are plain identifiers, and which is followed by
 * `VALUES`, `SELECT` or `DEFAULT`. Anything else (a list the literal cuts off,
 * an item that is a substitution, a literal that is an operand of `+`) is
 * incomplete and carries no columns at all, never a shorter list. That is what
 * keeps an extraction limit from reading as a column the code does not write.
 */

import { group, isGroup, isPunct, kw, splitStatements, tokenizeSql } from '@seamline/core/sql';
import type { Tok } from '@seamline/core/sql';
import { NOT_A_TABLE, SUBSTITUTION, looksLikeSql, scanTableMatches } from './sql.ts';
import type { SqlTableName, SqlTableOccurrence } from './sql.ts';

export type SqlClass = 'delete' | 'insert' | 'select' | 'update' | 'upsert';

/** The columns one statement names for one write class. */
export interface ColumnSet {
  /** Sorted, without repeats. Empty unless `complete`. */
  readonly columns: readonly string[];
  readonly complete: boolean;
}

/** One statement's effect on one table. */
export interface RawSqlCall {
  readonly table: SqlTableName;
  /** Sorted. `REPLACE` is `delete` and `insert`; an upsert is the one class `upsert`. */
  readonly classes: readonly SqlClass[];
  /** The insert half (an upsert's create branch included), or null when the call has none. */
  readonly insert: ColumnSet | null;
  /** The update half (an upsert's update branch included), or null when the call has none. */
  readonly update: ColumnSet | null;
}

/**
 * Why a possible SQL statement names no table the extractor can attribute:
 * a substitution in the table position (`INSERT INTO ${t} ...`, `users_${s}`),
 * `CALL` / `EXEC`, which run a procedure whose tables are unknown, or a
 * tokenizer resource limit that leaves the statement unread.
 */
export type UnattributedReason = 'procedure' | 'table-placeholder' | 'resource-limit';

export interface RawSqlReading {
  readonly calls: readonly RawSqlCall[];
  readonly unattributed: readonly UnattributedReason[];
}

export interface ClassifyOptions {
  /**
   * The literal is an operand of `+`: the statement may be longer than this
   * text, so no column set it yields can be complete.
   */
  readonly concatenated?: boolean;
}

const NOTHING: RawSqlReading = Object.freeze({ calls: [], unattributed: [] });
const INCOMPLETE: ColumnSet = Object.freeze({ columns: [], complete: false });

const VERBS = 'select|with|insert|replace|merge|copy|update|delete|truncate|call|exec|execute';

/** Text that starts with a statement verb, the way the read gate has always required. */
const STARTS_WITH_VERB = new RegExp(`^\\s*(?:${VERBS})\\b`, 'i');
/** Text that starts with a comment, behind which the first statement may begin. */
const STARTS_WITH_COMMENT = /^\s*(?:--|\/\*)/;
const VERB_WORD = new RegExp(`\\b(?:${VERBS})\\b`, 'i');

/** The verbs a statement can start with; a literal that starts with anything else is not read. */
const STATEMENT_VERBS: ReadonlySet<string> = new Set([
  'SELECT',
  'WITH',
  'INSERT',
  'REPLACE',
  'MERGE',
  'COPY',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'CALL',
  'EXEC',
  'EXECUTE',
]);

/** Whether `text` can start a statement: the test before anything is tokenized or walked. */
export function mayBeSql(text: string): boolean {
  // Most literals are not SQL and fail the anchored test at their first word. A leading comment can hide the
  // verb, so that case looks for it anywhere, and the tokenizer decides.
  return STARTS_WITH_COMMENT.test(text) ? VERB_WORD.test(text) : STARTS_WITH_VERB.test(text);
}

/**
 * Classify the statements in `text`. `text` comes from `sqlText`: the literal
 * parts of a string or template, a sentinel in place of each substitution.
 */
export function classifyRawSql(text: string, options: ClassifyOptions = {}): RawSqlReading {
  if (!mayBeSql(text)) return NOTHING;
  let statements: ReturnType<typeof splitStatements>;
  let terminated: ReadonlySet<number>;
  try {
    const all = tokenizeSql(text);
    statements = splitStatements(all);
    terminated = tokensBeforeSemicolon(all);
  } catch (error) {
    // The tokenizer rejects more than 256 nested bracket groups. Preserve that uncertainty:
    // the caller records an untraced statement and withholds a complete code run.
    if (error instanceof RangeError) return { calls: [], unattributed: ['resource-limit'] };
    throw error;
  }
  // A literal is SQL only if it starts with a statement verb (after whitespace and comments), as the
  // read gate has always required: `BEGIN; UPDATE t SET ...` and a sentence that mentions a verb are not.
  const first = statements[0];
  if (first === undefined || !STATEMENT_VERBS.has(kw(first.toks, 0) ?? '')) return NOTHING;
  const reading = { calls: [] as RawSqlCall[], unattributed: [] as UnattributedReason[] };
  statements.forEach((statement, index) => {
    // A statement that ends in `;`, or follows one, is part of a script and not a phrase.
    const last = statement.toks[statement.toks.length - 1];
    const scripted = index > 0 || (last !== undefined && terminated.has(last.pos));
    readStatement(text, statement.toks, options.concatenated === true, scripted, reading);
  });
  return reading;
}

/** The position of every token that a `;` follows directly: the last token of a terminated statement. */
function tokensBeforeSemicolon(toks: readonly Tok[]): ReadonlySet<number> {
  const before = new Set<number>();
  for (let i = 0; i + 1 < toks.length; i += 1) {
    if (isPunct(toks, i + 1, ';')) before.add((toks[i] as Tok).pos);
  }
  return before;
}

interface Reading {
  readonly calls: RawSqlCall[];
  readonly unattributed: UnattributedReason[];
}

function readStatement(
  text: string,
  toks: readonly Tok[],
  concatenated: boolean,
  scripted: boolean,
  out: Reading,
): void {
  switch (kw(toks, 0)) {
    case 'SELECT':
    case 'WITH':
      return readQuery(text, toks, out);
    case 'INSERT':
      return readInsert(text, toks, concatenated, out);
    case 'REPLACE':
      return readReplace(toks, concatenated, out);
    case 'MERGE':
      return readMerge(toks, concatenated, out);
    case 'COPY':
      return readCopy(toks, concatenated, out);
    case 'UPDATE':
      return readUpdate(text, toks, concatenated, out);
    case 'DELETE':
      return readDelete(text, toks, out);
    case 'TRUNCATE':
      return readTruncate(toks, scripted, out);
    case 'CALL':
    case 'EXEC':
    case 'EXECUTE':
      return readProcedure(toks, out);
    default:
      return;
  }
}

/* ------------------------------------------------------------------- reads */

/** The text a statement spans, from its first token to the end of its last. */
function statementText(text: string, toks: readonly Tok[]): string {
  const first = toks[0];
  const last = toks[toks.length - 1];
  if (first === undefined || last === undefined) return '';
  return text.slice(first.pos, last.pos + last.raw.length);
}

/**
 * A `SELECT` or `WITH` keeps today's gate and today's reading of `FROM` and
 * `JOIN`, less the names `tableReads` knows are not tables. A write verb inside
 * a `WITH` is read as a write with no column set: the statement is not parsed as
 * a write, so nothing about its columns is known.
 */
function readQuery(text: string, toks: readonly Tok[], out: Reading): void {
  if (!looksLikeSql(statementText(text, toks))) return;
  for (const occurrence of tableReads(text, toks)) {
    out.calls.push({
      table: occurrence,
      classes: [occurrence.operation],
      insert: occurrence.operation === 'insert' ? INCOMPLETE : null,
      update: occurrence.operation === 'update' ? INCOMPLETE : null,
    });
  }
}

/**
 * The tables a write statement reads after `FROM` or `JOIN` (a subquery or an
 * `INSERT ... SELECT`). The tables after `USING` in `DELETE ... USING` are not
 * read: the pattern has no `USING`.
 */
function readsWithin(text: string, toks: readonly Tok[], out: Reading): void {
  for (const occurrence of tableReads(text, toks)) {
    if (occurrence.operation !== 'select') continue;
    out.calls.push({ table: occurrence, classes: ['select'], insert: null, update: null });
  }
}

/* ------------------------------------------------------------ table reads */

/**
 * What the tokens say about one place the table pattern matched: not a table at
 * all (`skip`), or the table that follows (`ONLY name`).
 */
type Slot = { readonly kind: 'skip' } | { readonly kind: 'name'; readonly name: SqlTableName };

const SKIP: Slot = Object.freeze({ kind: 'skip' });

/**
 * Calls whose arguments use `FROM` without it introducing a table:
 * `EXTRACT(field FROM source)`, `SUBSTRING(s FROM n)`, `TRIM(BOTH c FROM s)`,
 * `OVERLAY(s PLACING r FROM n)`. `POSITION(a IN b)` has no `FROM`; it is listed
 * so that nothing a variant of it holds is taken for a table.
 */
const FROM_CALLS: ReadonlySet<string> = new Set([
  'EXTRACT',
  'SUBSTRING',
  'TRIM',
  'OVERLAY',
  'POSITION',
]);

/**
 * The tables a statement reads or writes through the pattern of `sql.ts`
 * (`FROM`, `JOIN`, `UPDATE`, `DELETE FROM`, `INSERT INTO`), less the places the
 * tokens show are not a table reference, and with `ONLY` replaced by the name
 * that follows it:
 *
 * - a name the same statement defines as a CTE (`WITH x [(cols)] AS (...)`),
 *   within the scope the CTE has: its later siblings and the query that follows
 *   the list, and its own body only under `RECURSIVE`;
 * - a `FROM` or `JOIN` name directly followed by `(`, which is a function
 *   (`generate_series(1, 10)`);
 * - the keyword `LATERAL` in a table slot;
 * - the word after a row-locking `UPDATE` (`FOR [NO KEY] UPDATE [OF t] [NOWAIT |
 *   SKIP LOCKED]`), which is a lock and not a write;
 * - `FROM` inside `EXTRACT(...)`, `SUBSTRING(...)`, `TRIM(...)` and `OVERLAY(...)`.
 *
 * The pattern still decides what a reference looks like; the tokens only decide
 * which of its matches count. A match the tokens say nothing about is kept as it
 * was, so a quoted word or text inside a string literal is read as before.
 */
function tableReads(text: string, toks: readonly Tok[]): SqlTableOccurrence[] {
  const first = toks[0];
  if (first === undefined) return [];
  const plan = planSlots(toks);
  const reads: SqlTableOccurrence[] = [];
  for (const { occurrence, nameAt } of scanTableMatches(statementText(text, toks))) {
    const slot = plan.get(first.pos + nameAt);
    if (slot === undefined) reads.push(occurrence);
    else if (slot.kind === 'name') reads.push({ ...slot.name, operation: occurrence.operation });
  }
  return reads;
}

interface Walk {
  readonly list: readonly Tok[];
  /** CTE names visible to every token of `list`, as `cteKey` spells them. */
  readonly visible: ReadonlySet<string>;
  /** `list` is the argument list of `EXTRACT`, `SUBSTRING`, `TRIM` or `OVERLAY`. */
  readonly fromCall: boolean;
}

/**
 * The decision for each table slot the pattern can match, keyed by the offset of
 * the slot's first token. An explicit work list, not recursion: the tokenizer
 * nests one level per bracket, and text that nests deeply must not take the
 * extraction down here either.
 */
function planSlots(toks: readonly Tok[]): ReadonlyMap<number, Slot> {
  const plan = new Map<number, Slot>();
  const work: Walk[] = [{ list: toks, visible: new Set(), fromCall: false }];
  for (let w = work.pop(); w !== undefined; w = work.pop()) {
    const { list, fromCall } = w;
    let visible = w.visible;
    for (let i = 0; i < list.length; i += 1) {
      const tok = list[i] as Tok;
      if (tok.t === 'group') {
        const call = tok.v === '(' && FROM_CALLS.has(kw(list, i - 1) ?? '');
        work.push({ list: tok.items, visible, fromCall: call });
        continue;
      }
      const word = kw(list, i);
      if (word === 'WITH') {
        const ctes = cteList(list, i);
        if (ctes !== null) {
          const all = new Set([...visible, ...ctes.defs.map((d) => d.key)]);
          ctes.defs.forEach((def, k) => {
            const own = ctes.recursive
              ? all
              : new Set([...visible, ...ctes.defs.slice(0, k).map((d) => d.key)]);
            work.push({ list: def.body.items, visible: own, fromCall: false });
          });
          visible = all;
          i = ctes.end - 1;
        }
      } else if (word === 'FROM' && (fromCall || isDistinctFrom(list, i))) {
        skipSlot(list, i + 1, plan);
      } else if (word === 'FROM' || word === 'JOIN') {
        planSlot(list, i + 1, true, visible, plan);
      } else if (word === 'UPDATE') {
        if (locksRows(list, i)) skipSlot(list, i + 1, plan);
        else planSlot(list, i + 1, false, visible, plan);
      }
    }
  }
  return plan;
}

/** A slot that is not a table whatever it holds: a word, or a number (`SUBSTRING(s FROM 2)`). */
function skipSlot(list: readonly Tok[], at: number, plan: Map<number, Slot>): void {
  const tok = list[at];
  if (tok !== undefined && (tok.t === 'word' || tok.t === 'num')) plan.set(tok.pos, SKIP);
}

/** `a IS [NOT] DISTINCT FROM b` compares; `SELECT DISTINCT FROM t` does not match it. */
function isDistinctFrom(list: readonly Tok[], at: number): boolean {
  return (
    kw(list, at - 1) === 'DISTINCT' && (kw(list, at - 2) === 'IS' || kw(list, at - 2) === 'NOT')
  );
}

/** `FOR UPDATE` and `FOR NO KEY UPDATE` lock rows; they do not write a table. */
function locksRows(list: readonly Tok[], at: number): boolean {
  return (
    kw(list, at - 1) === 'FOR' ||
    (kw(list, at - 1) === 'KEY' && kw(list, at - 2) === 'NO' && kw(list, at - 3) === 'FOR')
  );
}

/** The slot after `FROM`, `JOIN` or `UPDATE` (`reads`: after `FROM` or `JOIN`). */
function planSlot(
  list: readonly Tok[],
  at: number,
  reads: boolean,
  visible: ReadonlySet<string>,
  plan: Map<number, Slot>,
): void {
  const tok = list[at];
  if (tok === undefined || tok.t !== 'word') return;
  const word = kw(list, at);
  if (word === 'LATERAL' && reads) {
    plan.set(tok.pos, SKIP);
  } else if (word === 'ONLY') {
    const name = readName(list, at + 1);
    plan.set(
      tok.pos,
      name !== null && name.kind === 'name' ? { kind: 'name', name: name.name } : SKIP,
    );
  } else {
    const end = nameEnd(list, at);
    if (reads && isGroup(list, end, '(')) plan.set(tok.pos, SKIP);
    else if (end === at + 1 && visible.has(cteKey(tok))) plan.set(tok.pos, SKIP);
  }
}

/** The index after `name`, `schema.name` or `catalog.schema.name` starting at `at`. */
function nameEnd(list: readonly Tok[], at: number): number {
  let end = at + 1;
  for (
    let parts = 1;
    parts < 3 && isPunct(list, end, '.') && list[end + 1]?.t === 'word';
    parts += 1
  ) {
    end += 2;
  }
  return end;
}

/** A word that is nothing but the stand-in for a substitution. */
function isSubstitution(tok: Tok): boolean {
  return (
    tok.t === 'word' &&
    !tok.quoted &&
    tok.v.length > 0 &&
    [...tok.v].every((c) => c === SUBSTITUTION)
  );
}

/** How a CTE name is compared: folded unless quoted, and a quoted name never equals an unquoted one. */
function cteKey(tok: Tok): string {
  return tok.quoted ? `"${tok.v}` : tok.v.toLowerCase();
}

interface CteList {
  readonly recursive: boolean;
  readonly defs: ReadonlyArray<{ readonly key: string; readonly body: Tok }>;
  /** Index of the first token after the last definition. */
  readonly end: number;
}

/**
 * `WITH [RECURSIVE] name [(cols)] AS [[NOT] MATERIALIZED] (query) [, ...]` at
 * `at`, or null when the tokens are not that (`WITH TIME ZONE`, `WITH CHECK
 * OPTION`, `WITH ORDINALITY`). A definition after the first that does not parse
 * ends the list before its comma. A definition that is a substitution followed
 * by a comma (`WITH ${fragment}, x AS (...)`) defines names the text does not
 * show: it is passed over, and the others are read.
 */
function cteList(list: readonly Tok[], at: number): CteList | null {
  let k = at + 1;
  const recursive = kw(list, k) === 'RECURSIVE';
  if (recursive) k += 1;
  const defs: Array<{ key: string; body: Tok }> = [];
  for (;;) {
    const name = list[k];
    let next = k + 1;
    if (name === undefined || name.t !== 'word') break;
    if (isSubstitution(name) && isPunct(list, next, ',')) {
      k = next + 1;
      continue;
    }
    if (list[next]?.t === 'group') next += 1;
    if (kw(list, next) !== 'AS') break;
    next += 1;
    if (kw(list, next) === 'NOT') next += 1;
    if (kw(list, next) === 'MATERIALIZED') next += 1;
    const body = list[next];
    if (body === undefined || !isGroup(list, next, '(')) break;
    defs.push({ key: cteKey(name), body });
    k = next + 1;
    if (!isPunct(list, k, ',')) return { recursive, defs, end: k };
    k += 1;
  }
  // The first definition did not parse, or a later one did not: the list ends before its comma.
  return defs.length === 0 ? null : { recursive, defs, end: k - 1 };
}

/* ------------------------------------------------------------------- names */

type NameRead =
  | { readonly kind: 'name'; readonly name: SqlTableName; readonly next: number }
  | { readonly kind: 'placeholder'; readonly next: number };

const PLAIN_NAME = /^[\w$]+$/;

function isWord(tok: Tok | undefined): tok is Tok {
  return tok !== undefined && tok.t === 'word' && tok.unterminated !== true;
}

/**
 * `name`, `schema.name` or `catalog.schema.name`, quoted or not. A name any part
 * of which holds a substitution is a `placeholder`: the table is not literal.
 * Null when the tokens at `at` are not a name this extractor can attribute (not
 * a word, a dangling `.`, characters outside `[\w$]`, a keyword).
 */
function readName(toks: readonly Tok[], at: number): NameRead | null {
  const first = toks[at];
  if (!isWord(first)) return null;
  const parts: Tok[] = [first];
  let next = at + 1;
  while (parts.length < 3 && isPunct(toks, next, '.')) {
    const part = toks[next + 1];
    if (!isWord(part)) return null;
    parts.push(part);
    next += 2;
  }
  if (parts.some((p) => p.v.includes(SUBSTITUTION))) return { kind: 'placeholder', next };

  const written = (t: Tok): string => (t.quoted ? t.v : t.raw);
  const tableTok = parts[parts.length - 1] as Tok;
  const schemaTok = parts.length >= 2 ? (parts[parts.length - 2] as Tok) : undefined;
  const tableText = written(tableTok);
  const schemaText = schemaTok === undefined ? null : written(schemaTok);
  if (!PLAIN_NAME.test(tableText)) return null;
  if (schemaText !== null && !PLAIN_NAME.test(schemaText)) return null;
  if (!tableTok.quoted && NOT_A_TABLE.has(tableText.toLowerCase())) return null;
  return {
    kind: 'name',
    next,
    name: {
      table: tableText.toLowerCase(),
      schema: schemaText === null ? null : schemaText.toLowerCase(),
      tableText,
      tableQuoted: tableTok.quoted,
      schemaText,
      schemaQuoted: schemaTok !== undefined && schemaTok.quoted,
    },
  };
}

/* ------------------------------------------------------------- column sets */

function oneOf(toks: readonly Tok[], at: number, words: ReadonlySet<string>): boolean {
  const word = kw(toks, at);
  return word !== null && words.has(word);
}

/** The longest column name put in a list prop (PostgreSQL itself limits an identifier to 63 bytes). */
const MAX_COLUMN_LENGTH = 128;

/**
 * Characters a column name never holds: whitespace, a comma or a quote (the
 * comma-separated encoding could not carry them), any control, format,
 * surrogate, private-use or unassigned character (`\p{C}`, which holds a bidi
 * override, a zero-width space and U+0085), any separator (`\p{Z}`), and
 * U+FFFD, which is what a U+FFFF in the text becomes (see `sqlText`) and so is
 * not text the program wrote.
 */
const NOT_IN_A_COLUMN = /[\s,"'`\p{C}\p{Z}�]/u;

/**
 * A column or assignment-target name this extractor will put in a list prop: a
 * single word of at most 128 characters that is neither a substitution nor
 * holds a character of `NOT_IN_A_COLUMN`. The name reaches the text an agent
 * reads (a finding quotes the column list of an edge), so a name that could
 * hide or reorder text, or that is not a name, makes the set incomplete
 * instead.
 */
function plainColumn(tok: Tok | undefined): string | null {
  if (!isWord(tok)) return null;
  const name = tok.v;
  if (name.length === 0 || name.length > MAX_COLUMN_LENGTH || name.includes(SUBSTITUTION)) {
    return null;
  }
  if (NOT_IN_A_COLUMN.test(name)) return null;
  return name;
}

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Items of a bracket group split on commas. An empty item is kept, so `(a,,b)` is not `(a,b)`. */
function splitItems(items: readonly Tok[]): Tok[][] {
  const segments: Tok[][] = [[]];
  for (const item of items) {
    if (item.t === 'punct' && item.v === ',') segments.push([]);
    else (segments[segments.length - 1] as Tok[]).push(item);
  }
  return segments;
}

/**
 * The columns of an explicit list `(a, b, c)`: the group must be closed in this
 * literal and every item one plain identifier. Null otherwise.
 */
function columnList(tok: Tok | undefined): string[] | null {
  if (tok === undefined || tok.t !== 'group' || tok.v !== '(' || tok.unterminated === true)
    return null;
  if (tok.items.length === 0) return null;
  const columns: string[] = [];
  for (const segment of splitItems(tok.items)) {
    if (segment.length !== 1) return null;
    const name = plainColumn(segment[0]);
    if (name === null) return null;
    columns.push(name);
  }
  return sortedUnique(columns);
}

const ROWS_FOLLOW: ReadonlySet<string> = new Set(['VALUES', 'SELECT', 'DEFAULT']);
const COPY_SOURCE: ReadonlySet<string> = new Set(['FROM']);
const COPY_SOURCES: ReadonlySet<string> = new Set(['STDIN', 'PROGRAM']);
const MERGE_ROWS: ReadonlySet<string> = new Set(['VALUES']);

/**
 * The insert column set for a list at `at`. Complete only when the list is a
 * closed group of plain identifiers that is followed by one of `follow`: a
 * list the literal ends right after (`"INSERT INTO t (a, b) "` continued by
 * code the literal does not hold) says nothing about what comes next.
 */
function insertColumns(
  toks: readonly Tok[],
  at: number,
  follow: ReadonlySet<string>,
  concatenated: boolean,
): ColumnSet {
  if (concatenated) return INCOMPLETE;
  const columns = columnList(toks[at]);
  if (columns === null || !oneOf(toks, at + 1, follow)) return INCOMPLETE;
  return { columns, complete: true };
}

const ASSIGNMENT_END: ReadonlySet<string> = new Set([
  'WHERE',
  'FROM',
  'RETURNING',
  'ORDER',
  'LIMIT',
]);

/**
 * The targets of the assignments that start at `from` (`a = 1, b = 2`), up to
 * the clause that ends them. Complete only when each assignment is
 * `<plain identifier> = <something>`; `(a, b) = (...)`, `t.a = ...` and a
 * substitution in the target position are not.
 */
function assignmentTargets(
  toks: readonly Tok[],
  from: number,
  concatenated: boolean,
  endsAtWhen = false,
): ColumnSet {
  if (concatenated) return INCOMPLETE;
  let end = toks.length;
  let caseDepth = 0;
  for (let k = from; k < toks.length; k += 1) {
    const word = kw(toks, k);
    if (word === 'CASE') caseDepth += 1;
    else if (word === 'END' && caseDepth > 0) caseDepth -= 1;
    const ends =
      word !== null &&
      ((ASSIGNMENT_END.has(word) && !(word === 'FROM' && kw(toks, k - 1) === 'DISTINCT')) ||
        (endsAtWhen && word === 'WHEN' && caseDepth === 0));
    if (ends) {
      end = k;
      break;
    }
  }
  const columns: string[] = [];
  const clause = toks.slice(from, end);
  if (clause.length === 0) return INCOMPLETE;
  for (const segment of splitItems(clause)) {
    const target = plainColumn(segment[0]);
    // A target, `=`, and at least one token of a value; the clause may be cut off.
    if (target === null || !isPunct(segment, 1, '=') || segment.length < 3) return INCOMPLETE;
    if (segment.some((t) => t.unterminated === true)) return INCOMPLETE;
    if (splicesIntoValue(segment)) return INCOMPLETE;
    columns.push(target);
  }
  return { columns: sortedUnique(columns), complete: true };
}

/**
 * Words after which a value continues, so that a substitution after one of them
 * is an operand: `a = b AND ${x}`, `CASE WHEN ${c} THEN ${x}`.
 */
const OPERAND_WORDS: ReadonlySet<string> = new Set([
  'AND',
  'OR',
  'NOT',
  'IS',
  'IN',
  'LIKE',
  'ILIKE',
  'BETWEEN',
  'WHEN',
  'THEN',
  'ELSE',
  'CASE',
  'ANY',
  'ALL',
  'SOME',
  'EXISTS',
  'DISTINCT',
  'ESCAPE',
]);

/** A token that can end a value: a literal, a bracket, or a name, but not an operator or a word that expects an operand. */
function endsValue(tok: Tok): boolean {
  if (tok.t === 'num' || tok.t === 'str' || tok.t === 'group') return true;
  if (tok.t !== 'word') return false;
  return tok.quoted || !OPERAND_WORDS.has(tok.v.toUpperCase());
}

/**
 * Whether a substitution in the value of an assignment (`<target> = <value>`) is
 * spliced into it rather than being the bound value: one that directly follows a
 * value (`a = 1 ${more}`, `a = ${x} ${y}`), or that touches other characters
 * (`a = 1${x}`, `a = ${x}${y}`, `a = col_${x}`). Such a fragment can be
 * anything, `, b = 2` included, so the assignments in the text are not all the
 * statement makes. A substitution that is the whole value, or follows an
 * operator or a word such as `AND` or `THEN`, is an operand.
 */
function splicesIntoValue(segment: readonly Tok[]): boolean {
  for (let k = 2; k < segment.length; k += 1) {
    const tok = segment[k] as Tok;
    if (tok.t !== 'word' || !tok.v.includes(SUBSTITUTION)) continue;
    if (tok.v !== SUBSTITUTION) return true;
    if (endsValue(segment[k - 1] as Tok)) return true;
  }
  return false;
}

/* ----------------------------------------------------------------- inserts */

const INSERT_MODIFIERS: ReadonlySet<string> = new Set([
  'LOW_PRIORITY',
  'DELAYED',
  'HIGH_PRIORITY',
  'IGNORE',
]);
const INSERT_OR: ReadonlySet<string> = new Set(['REPLACE', 'IGNORE', 'ABORT', 'FAIL', 'ROLLBACK']);

/**
 * `ON CONFLICT ... DO UPDATE SET <assignments>` or `ON DUPLICATE KEY UPDATE
 * <assignments>` after the insert: an upsert, and its update half. `ON CONFLICT
 * ... DO NOTHING` is a plain insert.
 */
function upsertTail(toks: readonly Tok[], from: number, concatenated: boolean): ColumnSet | null {
  for (let k = from; k < toks.length; k += 1) {
    if (kw(toks, k) !== 'ON') continue;
    if (
      kw(toks, k + 1) === 'DUPLICATE' &&
      kw(toks, k + 2) === 'KEY' &&
      kw(toks, k + 3) === 'UPDATE'
    ) {
      return assignmentTargets(toks, k + 4, concatenated);
    }
    if (kw(toks, k + 1) === 'CONFLICT') {
      for (let m = k + 2; m < toks.length; m += 1) {
        if (kw(toks, m) !== 'DO') continue;
        if (kw(toks, m + 1) === 'UPDATE' && kw(toks, m + 2) === 'SET') {
          return assignmentTargets(toks, m + 3, concatenated);
        }
        return null;
      }
    }
  }
  return null;
}

const ROW_SOURCE: ReadonlySet<string> = new Set([
  'VALUES',
  'SELECT',
  'DEFAULT',
  'WITH',
  'OVERRIDING',
  'SET',
  'TABLE',
  'PARTITION',
]);

/**
 * What may follow the table of an `INSERT` or `REPLACE`: the end of the text (a
 * statement a program is still building), a column list or a subquery, the
 * keyword that starts the rows, or a substitution. Another word means the text
 * only begins like a statement (`Insert into your project`).
 */
function rowsMayFollow(toks: readonly Tok[], at: number): boolean {
  const next = toks[at];
  if (next === undefined || next.t === 'group') return true;
  if (next.t === 'word' && next.v.includes(SUBSTITUTION)) return true;
  return oneOf(toks, at, ROW_SOURCE);
}

function readInsert(text: string, toks: readonly Tok[], concatenated: boolean, out: Reading): void {
  let at = 1;
  while (oneOf(toks, at, INSERT_MODIFIERS)) at += 1;
  if (kw(toks, at) === 'OR' && oneOf(toks, at + 1, INSERT_OR)) at += 2;
  if (kw(toks, at) !== 'INTO') return;
  const name = readName(toks, at + 1);
  if (name === null) return;
  let list = name.next;
  if (kw(toks, list) === 'AS' && isWord(toks[list + 1])) list += 2;
  if (!rowsMayFollow(toks, list)) return;
  if (name.kind === 'placeholder') {
    out.unattributed.push('table-placeholder');
    return;
  }
  const insert = insertColumns(toks, list, ROWS_FOLLOW, concatenated);
  const update = upsertTail(toks, list, concatenated);
  out.calls.push({
    table: name.name,
    classes: [update === null ? 'insert' : 'upsert'],
    insert,
    update,
  });
  readsWithin(text, toks, out);
}

/**
 * `REPLACE [LOW_PRIORITY | DELAYED] INTO <name>` followed by a column list, a
 * subquery, a row source or a substitution. Unlike `INSERT INTO`, the end of the
 * text is not enough (`Replace into inventory` is a sentence) unless the literal
 * is an operand of `+`, which a program may be completing.
 */
function readReplace(toks: readonly Tok[], concatenated: boolean, out: Reading): void {
  let at = 1;
  while (kw(toks, at) === 'LOW_PRIORITY' || kw(toks, at) === 'DELAYED') at += 1;
  if (kw(toks, at) !== 'INTO') return;
  const name = readName(toks, at + 1);
  if (name === null) return;
  if (toks[name.next] === undefined ? !concatenated : !rowsMayFollow(toks, name.next)) return;
  if (name.kind === 'placeholder') {
    out.unattributed.push('table-placeholder');
    return;
  }
  out.calls.push({
    table: name.name,
    classes: ['delete', 'insert'],
    insert: insertColumns(toks, name.next, ROWS_FOLLOW, concatenated),
    update: null,
  });
}

/**
 * `MERGE INTO <name> USING ... WHEN [NOT] MATCHED THEN ...`. The insert half is
 * complete when every `INSERT` action carries a plain column list and there is
 * one; the update half when every `UPDATE SET` action has plain targets and
 * there is one.
 */
function readMerge(toks: readonly Tok[], concatenated: boolean, out: Reading): void {
  if (kw(toks, 1) !== 'INTO') return;
  const name = readName(toks, 2);
  if (name === null) return;
  // `MERGE INTO <name> [[AS] alias] USING <source> [[AS] alias] ON`: without USING and ON it is a sentence
  // (`Merge into main`, `Merge into main using git`).
  let using = name.next;
  if (kw(toks, using) === 'AS' && isWord(toks[using + 1])) using += 2;
  else if (isWord(toks[using]) && kw(toks, using) !== 'USING') using += 1;
  if (kw(toks, using) !== 'USING' || !joinFollows(toks, using + 1, concatenated)) return;
  if (name.kind === 'placeholder') {
    out.unattributed.push('table-placeholder');
    return;
  }
  const inserts: ColumnSet[] = [];
  const updates: ColumnSet[] = [];
  let deletes = false;
  let caseDepth = 0;
  for (let k = name.next; k < toks.length; k += 1) {
    const word = kw(toks, k);
    if (word === 'CASE') caseDepth += 1;
    else if (word === 'END' && caseDepth > 0) caseDepth -= 1;
    if (word !== 'WHEN' || caseDepth > 0) continue;
    let then = k + 1;
    let conditionCaseDepth = 0;
    while (then < toks.length) {
      const conditionWord = kw(toks, then);
      if (conditionWord === 'CASE') conditionCaseDepth += 1;
      else if (conditionWord === 'END' && conditionCaseDepth > 0) conditionCaseDepth -= 1;
      if (conditionWord === 'THEN' && conditionCaseDepth === 0) break;
      then += 1;
    }
    const action = kw(toks, then + 1);
    if (action === 'UPDATE' && kw(toks, then + 2) === 'SET') {
      updates.push(assignmentTargets(toks, then + 3, concatenated, true));
    } else if (action === 'INSERT') {
      inserts.push(insertColumns(toks, then + 2, MERGE_ROWS, concatenated));
    } else if (action === 'DELETE') {
      deletes = true;
    }
  }
  out.calls.push({
    table: name.name,
    classes: deletes ? ['delete', 'upsert'] : ['upsert'],
    insert: merged(inserts),
    update: merged(updates),
  });
}

/**
 * The `<source> [[AS] alias] ON` of a `MERGE ... USING`: a name or a subquery, an
 * optional alias, then `ON`. A literal that is an operand of `+` may still be
 * completed by the program, so its end is accepted where `ON` would be.
 */
function joinFollows(toks: readonly Tok[], at: number, concatenated: boolean): boolean {
  let k = at;
  if (toks[k]?.t === 'group') {
    k += 1;
  } else {
    const source = readName(toks, k);
    if (source === null) return false;
    k = source.next;
  }
  if (kw(toks, k) === 'AS' && isWord(toks[k + 1])) k += 2;
  else if (isWord(toks[k]) && kw(toks, k) !== 'ON') k += 1;
  return kw(toks, k) === 'ON' || (concatenated && k >= toks.length);
}

/** Every action must be complete, and there must be at least one. */
function merged(sets: readonly ColumnSet[]): ColumnSet {
  if (sets.length === 0 || sets.some((s) => !s.complete)) return INCOMPLETE;
  return { columns: sortedUnique(sets.flatMap((s) => s.columns)), complete: true };
}

/**
 * `COPY <name> [(cols)] FROM <source>`, where the source is `STDIN`, `PROGRAM`, a
 * file name or a substitution. `COPY ... TO` is a read, which gives no edge, and a
 * `FROM` followed by anything else is a sentence (`Copy files from desktop`).
 */
function readCopy(toks: readonly Tok[], concatenated: boolean, out: Reading): void {
  const name = readName(toks, 1);
  if (name === null) return;
  const hasList = toks[name.next]?.t === 'group';
  const direction = name.next + (hasList ? 1 : 0);
  if (kw(toks, direction) !== 'FROM') return;
  const source = toks[direction + 1];
  const sourceOk =
    source !== undefined &&
    (source.t === 'str' ||
      (source.t === 'word' && source.v.includes(SUBSTITUTION)) ||
      oneOf(toks, direction + 1, COPY_SOURCES));
  if (!sourceOk) return;
  if (name.kind === 'placeholder') {
    out.unattributed.push('table-placeholder');
    return;
  }
  out.calls.push({
    table: name.name,
    classes: ['insert'],
    insert: hasList ? insertColumns(toks, name.next, COPY_SOURCE, concatenated) : INCOMPLETE,
    update: null,
  });
}

/* ----------------------------------------------------------------- updates */

const UPDATE_MODIFIERS: ReadonlySet<string> = new Set(['LOW_PRIORITY', 'IGNORE', 'ONLY']);
const JOIN_WORDS: ReadonlySet<string> = new Set([
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'STRAIGHT_JOIN',
]);

/**
 * `UPDATE [ONLY] <name> [*] [[AS] alias] SET <assignments>`. A multi-table
 * `UPDATE a JOIN b ... SET a.x = ...` or `UPDATE a, b SET ...` is recognised
 * with an incomplete set: which table each target belongs to is not in the text.
 */
function readUpdate(text: string, toks: readonly Tok[], concatenated: boolean, out: Reading): void {
  let at = 1;
  while (oneOf(toks, at, UPDATE_MODIFIERS)) at += 1;
  const name = readName(toks, at);
  if (name === null) return;
  let next = name.next;
  if (isPunct(toks, next, '*')) next += 1;
  if (kw(toks, next) === 'AS' && isWord(toks[next + 1])) next += 2;
  else if (isWord(toks[next]) && kw(toks, next) !== 'SET' && !oneOf(toks, next, JOIN_WORDS))
    next += 1;

  let update: ColumnSet;
  if (kw(toks, next) === 'SET') update = assignmentTargets(toks, next + 1, concatenated);
  else if ((oneOf(toks, next, JOIN_WORDS) || isPunct(toks, next, ',')) && hasSetAfter(toks, next)) {
    update = INCOMPLETE;
  } else return;

  if (name.kind === 'placeholder') {
    out.unattributed.push('table-placeholder');
    return;
  }
  out.calls.push({ table: name.name, classes: ['update'], insert: null, update });
  readsWithin(text, toks, out);
}

/** A multi-table update has its `SET` somewhere after the tables; prose that merely lists words does not. */
function hasSetAfter(toks: readonly Tok[], from: number): boolean {
  for (let k = from; k < toks.length; k += 1) if (kw(toks, k) === 'SET') return true;
  return false;
}

/* ------------------------------------------------------------------ deletes */

const DELETE_MODIFIERS: ReadonlySet<string> = new Set(['LOW_PRIORITY', 'QUICK', 'IGNORE']);

/** `DELETE FROM [ONLY] <name>`. A MySQL multi-table `DELETE a FROM a JOIN b` has no such shape. */
function readDelete(text: string, toks: readonly Tok[], out: Reading): void {
  let at = 1;
  while (oneOf(toks, at, DELETE_MODIFIERS)) at += 1;
  if (kw(toks, at) !== 'FROM') return;
  at += 1;
  if (kw(toks, at) === 'ONLY') at += 1;
  const name = readName(toks, at);
  if (name === null) return;
  if (name.kind === 'placeholder') {
    out.unattributed.push('table-placeholder');
    return;
  }
  out.calls.push({ table: name.name, classes: ['delete'], insert: null, update: null });
  readsWithin(text, toks, out);
}

/**
 * `TRUNCATE [TABLE] [ONLY] <name> [*] [, <name> ...] [RESTART | CONTINUE IDENTITY] [CASCADE | RESTRICT]`.
 * The statement has to end there: a class string such as `truncate text-sm`
 * begins with the verb and a word and is not one.
 *
 * A bare `TRUNCATE <word>` is also what a class string such as `truncate block`
 * or `Truncate message` looks like, so it needs a second signal that the text is
 * a statement: `TABLE` or `ONLY`, a schema qualifier, a quoted name, a list of
 * names, an option (`CASCADE`, `RESTRICT`, `RESTART IDENTITY`, `CONTINUE
 * IDENTITY`), or a `;` after it (or an earlier statement in the same text).
 */
function readTruncate(toks: readonly Tok[], scripted: boolean, out: Reading): void {
  let at = 1;
  let signal = scripted;
  if (kw(toks, at) === 'TABLE') {
    at += 1;
    signal = true;
  }
  const names: NameRead[] = [];
  for (;;) {
    if (kw(toks, at) === 'ONLY') {
      at += 1;
      signal = true;
    }
    const name = readName(toks, at);
    if (name === null) return;
    if (name.next - at > 1 || toks[at]?.quoted === true) signal = true;
    names.push(name);
    at = name.next;
    if (isPunct(toks, at, '*')) at += 1;
    if (!isPunct(toks, at, ',')) break;
    signal = true;
    at += 1;
  }
  while (at < toks.length) {
    const word = kw(toks, at);
    if ((word === 'RESTART' || word === 'CONTINUE') && kw(toks, at + 1) === 'IDENTITY') {
      at += 2;
      signal = true;
    } else if (word === 'CASCADE' || word === 'RESTRICT') {
      at += 1;
      signal = true;
    } else if (word !== null && word.includes(SUBSTITUTION)) at += 1;
    else return;
  }
  if (!signal) return;
  for (const name of names) {
    if (name.kind === 'placeholder') out.unattributed.push('table-placeholder');
    else out.calls.push({ table: name.name, classes: ['delete'], insert: null, update: null });
  }
}

/* --------------------------------------------------------------- procedures */

/** `CALL <name> (`, `EXEC[UTE] <name> (` or `EXEC[UTE] <name> @`: a procedure whose tables are unknown. */
function readProcedure(toks: readonly Tok[], out: Reading): void {
  const name = readName(toks, 1);
  if (name === null) return;
  const callable = group(toks, name.next, '(') !== null;
  const withArguments = kw(toks, 0) !== 'CALL' && isPunct(toks, name.next, '@');
  if (callable || withArguments) out.unattributed.push('procedure');
}
