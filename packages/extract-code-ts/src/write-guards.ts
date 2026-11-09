/**
 * The writes this extractor cannot turn into an edge, noticed so that a detector can
 * tell "no traced write supplies this column" from "something writes this table that
 * was not seen". Design: `docs/design/real-world-inputs.md`, section 5.2.
 *
 * Everything here is lexical. A call is recognised by the shape of its callee and the
 * kind of its arguments, never by resolving a receiver, so the answer does not depend
 * on `node_modules` or on a type checker that may disagree with the text. The cost is
 * stated in the design (9.4): a name collision can only over-count, which withholds a
 * table or makes a detector UNKNOWN; it never hides a writer.
 *
 * What is recorded, and where it goes:
 *
 * - `untracedWriteCalls` on the `Repo` node (`Ctx.guards.untraced`): rules (1) to (5) of
 *   the design table. Rules (2), (2b) and (3) are about literals and are noted from
 *   `relations.ts` where the literals are read; (1), (4) and (5) are calls, noted here.
 * - `writeHooks` (`Ctx.guards.hooks`): `$use(...)` and field-injecting `$extends(...)`.
 * - `unknownWriterTables` (`Ctx.unknownWriterTables`): an ORM-shaped write call that
 *   names a delegate or a table export of the data-model index (part (a)). The raw-SQL
 *   parts (c) are noted in `relations.ts`, the unread-file part (b) in `unread-files.ts`.
 */

import { Node, SyntaxKind } from 'ts-morph';
import { kw, splitStatements, tokenizeSql } from '@seamline/core/sql';
import type { CallExpression, SourceFile } from 'ts-morph';
import type { Ctx, UnknownWriter, UntracedRule, UntracedVerb } from './context.ts';
import { DRIZZLE_STARTERS, PRISMA_WRITE_OPS } from './orm-shape.ts';
import { classifyRawSql } from './raw-sql.ts';
import type { RawSqlReading } from './raw-sql.ts';
import { SUBSTITUTION, sqlText } from './sql.ts';

/* ------------------------------------------------------------------- places */

function siteKey(file: string, node: Node): string {
  return `${file}\u0000${node.getStart()}`;
}

const RUNTIME_DDL_VERBS: ReadonlySet<string> = new Set([
  'CREATE', 'ALTER', 'DROP', 'RENAME', 'COMMENT', 'DO', 'EXEC', 'EXECUTE',
]);
const RUNTIME_DDL_WORD = /\b(?:create|alter|drop|rename|comment|do|exec|execute)\b/i;

/**
 * Embedded schema mutation can supply or remove a default that the data replay never saw.
 * This is a conservative measurement of expression sites, independent of symbol ownership or
 * receiver names. Only top-level statement verbs count; words inside SQL strings or comments do not.
 */
function noteRuntimeDdl(ctx: Ctx, file: string, node: Node, text: string): void {
  if (!RUNTIME_DDL_WORD.test(text)) return;
  let mutates = false;
  try {
    mutates = splitStatements(tokenizeSql(text)).some((s) => RUNTIME_DDL_VERBS.has(kw(s.toks, 0) ?? ''));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // A limited read cannot prove that a candidate literal has no schema mutation.
    mutates = true;
    const held = ctx.sqlResourceLimit.site;
    const line = node.getStartLineNumber();
    if (held === null || file < held.file || (file === held.file && line < held.line)) {
      ctx.sqlResourceLimit.site = { file, line };
    }
  }
  if (mutates) ctx.guards.runtimeDdl.set(siteKey(file, node), { file, line: node.getStartLineNumber() });
}

/** A string operand defers to its outer composition, through transparent wrappers. */
function hasStringCompositionParent(node: Node): boolean {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (parent === undefined) return false;
    if (Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent) || Node.isTypeAssertion(parent)
      || Node.isSatisfiesExpression(parent) || Node.isNonNullExpression(parent)) {
      current = parent;
      continue;
    }
    return Node.isTemplateSpan(parent) || (Node.isBinaryExpression(parent)
      && parent.getOperatorToken().getKind() === SyntaxKind.PlusToken);
  }
}

/** Read fixed SQL text even in module expressions and const initializers with no caller. */
export function scanRuntimeDdl(ctx: Ctx, file: string, source: SourceFile): void {
  for (const node of source.getDescendants()) {
    if (!(Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)
      || Node.isTemplateExpression(node) || (Node.isBinaryExpression(node)
        && node.getOperatorToken().getKind() === SyntaxKind.PlusToken))) continue;
    if (hasStringCompositionParent(node)) continue;
    const fixed = fixedText(node, true);
    if (fixed === null) continue;
    noteRuntimeDdl(ctx, file, node, fixed.text);
    if (fixed.text.includes(SUBSTITUTION)) {
      // An unknown prefix cannot disprove a known DDL suffix, even if the verb itself
      // spans several literal or template operands. Keep their contiguous text together.
      for (const segment of fixed.text.split(SUBSTITUTION)) {
        noteRuntimeDdl(ctx, file, node, segment);
      }
    }
  }
}

/**
 * Counts `node` in `untracedWriteCalls`, once however many rules see it (the first rule to see it
 * names it, and gives the verb).
 */
export function noteUntraced(
  ctx: Ctx,
  file: string,
  node: Node,
  rule: UntracedRule,
  verb: UntracedVerb,
): void {
  const key = siteKey(file, node);
  if (ctx.guards.untraced.has(key)) return;
  ctx.guards.untraced.set(key, { file, line: node.getStartLineNumber(), rule, verb });
}

/** The verb class of a Prisma write operation (`createMany`, `updateManyAndReturn`, `upsert`, ...). */
function operationVerb(name: string): UntracedVerb {
  if (name.startsWith('create') || name === 'upsert' || name === 'insert') return 'insert';
  if (name.startsWith('update')) return 'update';
  if (name.startsWith('delete')) return 'delete';
  return 'unknown';
}

const INSERT_WORD = /\b(?:insert|upsert)\b|\breplace\s+into\b/i;
const UPDATE_WORD = /\bupdate\b/i;
const DELETE_WORD = /\b(?:delete|truncate)\b/i;
const MERGE_WORD = /\bmerge\b/i;

/**
 * The verb class of SQL text, by the words in it rather than its first word, because a `WITH` or a
 * second statement can carry the write. A word in a string or an identifier over-counts toward
 * `insert`, the class a gate cares about; text with no write word at all is `unknown`.
 */
function sqlVerb(text: string): UntracedVerb {
  if (INSERT_WORD.test(text)) return 'insert';
  if (MERGE_WORD.test(text)) return 'unknown';
  if (UPDATE_WORD.test(text)) return 'update';
  if (DELETE_WORD.test(text)) return 'delete';
  return 'unknown';
}

/** Whether a literal lies inside the argument of a call that rule (1) already counted. */
function insideCountedCall(ctx: Ctx, node: Node): boolean {
  const start = node.getStart();
  return ctx.guards.excluded.some(([from, to]) => start >= from && start < to);
}

/**
 * Lists `table` as written by something no edge records. Keeps the first place by file and
 * then line, so which place is named does not depend on the order files were walked in.
 */
export function noteUnknownWriter(
  ctx: Ctx,
  table: string,
  file: string,
  line: number,
  why: UnknownWriter['why'],
): void {
  const held = ctx.unknownWriterTables.get(table);
  if (held !== undefined && (held.file < file || (held.file === file && held.line <= line))) return;
  ctx.unknownWriterTables.set(table, { file, line, why });
}

/* ------------------------------------------------------------------- SQL text */

const TRIVIA = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const WRITE_WORD = /\b(?:insert|update|delete|merge)\b/i;

/** The first word of `text` after whitespace and comments, upper-cased. */
function leadingWord(text: string): string {
  const rest = text.slice((TRIVIA.exec(text) as RegExpExecArray)[0].length);
  return (/^[A-Za-z]+/.exec(rest)?.[0] ?? '').toUpperCase();
}

/**
 * Statements that cannot write a row: a read (`SELECT`, or a `WITH` that has no write verb in it) and
 * the session and transaction commands (`SET search_path TO ...`, `RESET`, `SHOW`, `BEGIN`, `COMMIT`,
 * `ROLLBACK`, `SAVEPOINT`, `RELEASE`). The design exempts a call whose fixed text is a read; a
 * session command shows the same thing in its fixed text, and a repository that sets the search
 * path from a variable would otherwise be UNKNOWN for a statement that writes nothing. `EXPLAIN` is
 * not here: `EXPLAIN ANALYZE` runs the statement.
 */
const NO_ROW_WRITE: ReadonlySet<string> = new Set([
  'SELECT',
  'SHOW',
  'SET',
  'RESET',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
]);

function isReadStatement(text: string): boolean {
  const word = leadingWord(text);
  if (NO_ROW_WRITE.has(word)) return true;
  return word === 'WITH' && !WRITE_WORD.test(text);
}

/** Split only on statement boundaries, leaving semicolons inside strings and groups intact. */
function statementTexts(text: string): readonly string[] | null {
  try {
    return splitStatements(tokenizeSql(text)).map(({ toks, pos }) => {
      const last = toks[toks.length - 1];
      return text.slice(pos, last === undefined ? pos : last.pos + last.raw.length);
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function isReadText(text: string): boolean {
  const statements = statementTexts(text);
  return statements !== null && statements.length > 0 && statements.every(isReadStatement);
}

/**
 * Rule (2b): the whole text of a literal that is an operand of `+` is a write phrase that
 * ends where the table name would begin, the name being spliced by the concatenation. A bare
 * `UPDATE ` is not one: `"Update " + name` is prose.
 */
const WRITE_PHRASE = new RegExp(
  '^\\s*(?:' +
    'INSERT(?:\\s+(?:IGNORE|LOW_PRIORITY|DELAYED|HIGH_PRIORITY))*(?:\\s+OR\\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK))?\\s+INTO' +
    '|REPLACE\\s+INTO|MERGE\\s+INTO|DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?' +
    ')\\s*$',
  'i',
);

/**
 * Notes what a string or template literal says about writes it cannot attribute: rule (2), a
 * statement of a write shape with no attributable table (a placeholder in the table slot,
 * `CALL`, `EXEC`, a tokenizer resource limit), and rule (2b), a write phrase that a concatenation completes.
 * `reading` is `classifyRawSql` of the literal's text.
 */
export function noteLiteral(
  ctx: Ctx,
  file: string,
  node: Node,
  text: string,
  reading: RawSqlReading,
  concatenated: boolean,
  interpolated: boolean,
): void {
  if (insideCountedCall(ctx, node)) return;
  if (reading.unattributed.length > 0) {
    noteUntraced(ctx, file, node, 'unattributed-statement', sqlVerb(text));
  } else if (concatenated && !interpolated && WRITE_PHRASE.test(text)) {
    noteUntraced(ctx, file, node, 'concatenated-statement', sqlVerb(text));
  }
}

/* ---------------------------------------------------- rule (3): spliced fragments */

/** A tag whose template is handed to the database as a statement: `$queryRaw`, `$executeRaw`, `sql`. */
function isRawTag(tag: Node): boolean {
  const name = Node.isIdentifier(tag)
    ? tag.getText()
    : Node.isPropertyAccessExpression(tag)
      ? tag.getName()
      : '';
  return name === '$queryRaw' || name === '$executeRaw' || name === 'sql';
}

/** `Prisma.raw(...)` or a `Prisma.sql` template: SQL text spliced in, not a bound parameter. */
function isPrismaFragment(expression: Node): boolean {
  const e = unwrap(expression);
  if (Node.isCallExpression(e)) {
    const callee = e.getExpression();
    return (
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === 'raw' &&
      callee.getExpression().getText() === 'Prisma'
    );
  }
  if (Node.isTaggedTemplateExpression(e)) {
    const tag = e.getTag();
    return (
      Node.isPropertyAccessExpression(tag) &&
      tag.getName() === 'sql' &&
      tag.getExpression().getText() === 'Prisma'
    );
  }
  return false;
}

/** The offset of the `n`-th (0-based) substitution sentinel in `text`. */
function sentinelAt(text: string, n: number): number {
  let at = -1;
  for (let i = 0; i <= n; i += 1) {
    at = text.indexOf(SUBSTITUTION, at + 1);
    if (at < 0) return -1;
  }
  return at;
}

const TABLE_KEYWORD_BEFORE = /\b(?:into|update|from|join|table|only)\s+$/i;

/**
 * Rule (3): a `$queryRaw`, `$executeRaw` or `sql` template that splices `Prisma.raw(...)` or a
 * `Prisma.sql` fragment into the statement-verb or the table position. Whatever is spliced there
 * is text of the statement, not a value, so the statement is not the one that is written. A
 * template whose fixed text only reads is not a write and is not counted.
 */
export function noteSplicedFragments(ctx: Ctx, file: string, template: Node, text: string): void {
  if (!Node.isTemplateExpression(template)) return;
  const parent = template.getParent();
  if (!Node.isTaggedTemplateExpression(parent) || parent.getTemplate() !== template) return;
  if (!isRawTag(parent.getTag())) return;
  if (insideCountedCall(ctx, template) || isReadText(text)) return;
  const spans = template.getTemplateSpans();
  for (let k = 0; k < spans.length; k += 1) {
    if (!isPrismaFragment((spans[k] as (typeof spans)[number]).getExpression())) continue;
    const at = sentinelAt(text, k);
    if (at < 0) continue;
    const before = text.slice(0, at);
    const verbPosition =
      (TRIVIA.exec(before) as RegExpExecArray)[0].length === before.length || /;\s*$/.test(before);
    if (verbPosition || TABLE_KEYWORD_BEFORE.test(before)) {
      noteUntraced(ctx, file, template, 'spliced-fragment', sqlVerb(text));
      return;
    }
  }
}

/* ----------------------------------------------------------------- the calls */

function unwrap(node: Node): Node {
  let current = node;
  for (;;) {
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isTypeAssertion(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current)
    ) {
      current = current.getExpression();
      continue;
    }
    return current;
  }
}

/** The fixed text of a statement argument and whether it was joined from several operands. */
function fixedText(argument: Node, expandTemplates = false): { readonly text: string; readonly joined: boolean } | null {
  const pending: Array<Node | string> = [argument];
  const parts: string[] = [];
  let joined = false;
  let literal = false;
  // Iterative folding avoids making the host stack limit part of the measurement.
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (typeof next === 'string') {
      parts.push(next);
      continue;
    }
    const e = unwrap(next);
    if (Node.isStringLiteral(e) || Node.isNoSubstitutionTemplateLiteral(e)) {
      parts.push(sqlText([e.getLiteralText()]));
      literal = true;
    } else if (Node.isTemplateExpression(e)) {
      if (expandTemplates) {
        const spans = e.getTemplateSpans();
        for (let i = spans.length - 1; i >= 0; i -= 1) {
          const span = spans[i]!;
          pending.push(sqlText([span.getLiteral().getLiteralText()]), span.getExpression());
        }
        pending.push(sqlText([e.getHead().getLiteralText()]));
      } else {
        parts.push(sqlText([
          e.getHead().getLiteralText(),
          ...e.getTemplateSpans().map((span) => span.getLiteral().getLiteralText()),
        ]));
      }
      literal = true;
    } else if (Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
      pending.push(e.getRight(), e.getLeft());
      joined = true;
    } else {
      parts.push(SUBSTITUTION);
    }
  }
  return joined || literal ? { text: parts.join(''), joined } : null;
}

/**
 * Whether a call that runs its argument as a statement (rule (1)) runs one the extractor did not
 * read as a statement. An argument that is a plain literal is read as one (rule (2) counts it if
 * it cannot be attributed). An argument built from a template or a concatenation is read by its
 * fixed text with a sentinel for each part it does not know: a read is not a write, a statement
 * the classifier attributes has its edge, and anything else (a name, a call result, text that
 * starts with a substitution) is a statement nobody saw.
 */
function runsUnreadStatement(argument: Node | undefined): boolean {
  if (argument === undefined) return true;
  const e = unwrap(argument);
  if (Node.isStringLiteral(e) || Node.isNoSubstitutionTemplateLiteral(e)) return false;
  const fixed = fixedText(e);
  if (fixed === null) return true;
  const statements = statementTexts(fixed.text);
  if (statements === null) return true;
  if (statements.length > 0 && statements.every(isReadStatement)) return false;
  const reading = classifyRawSql(fixed.text, { concatenated: fixed.joined });
  if (reading.unattributed.length > 0) return true;
  for (const statement of statements) {
    if (isReadStatement(statement)) continue;
    const part = classifyRawSql(statement, { concatenated: fixed.joined });
    if (part.unattributed.length > 0 || part.calls.length === 0) return true;
  }
  return reading.calls.length === 0;
}

/** `sql.raw` and `<x>.sql.raw`: the receiver is named `sql`. */
function receiverIsSql(receiver: Node): boolean {
  if (Node.isIdentifier(receiver)) return receiver.getText() === 'sql';
  return Node.isPropertyAccessExpression(receiver) && receiver.getName() === 'sql';
}

/** Modules whose `insert`, `update` and `delete` calls rule (5) reads, as the design lists them. */
const QUERY_BUILDER_MODULES: readonly string[] = [
  'drizzle-orm',
  '@supabase/supabase-js',
  'knex',
  'kysely',
  'typeorm',
  'sequelize',
  '@mikro-orm/core',
];

const MODULE_ALTERNATIVES = QUERY_BUILDER_MODULES.map((m) =>
  m.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&'),
).join('|');

const QUERY_BUILDER_IMPORT = new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)['"](?:${MODULE_ALTERNATIVES})(?:/[^'"\\n]*)?['"]`,
);

/**
 * Whether the file imports (or requires) one of the query-builder modules of rule (5). Read from
 * the text, so a mention in a comment over-counts, which is the safe direction.
 */
export function importsQueryBuilder(sf: SourceFile): boolean {
  return QUERY_BUILDER_IMPORT.test(sf.getFullText());
}

/** An identifier, or a member of a namespace import (`schema.users`), as the name it ends in. */
function tableExportName(argument: Node | undefined): string | null {
  if (argument === undefined) return null;
  const e = unwrap(argument);
  if (Node.isIdentifier(e)) return e.getText();
  if (Node.isPropertyAccessExpression(e)) {
    let root: Node = e.getExpression();
    while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
    if (Node.isIdentifier(root) || root.getKind() === SyntaxKind.ThisKeyword) return e.getName();
  }
  return null;
}

/**
 * A Prisma `$extends` argument that may inject fields into every write: anything but an object
 * literal, or one with a `query` component, a spread, or a name that is not written out.
 */
function extendsMayInject(argument: Node | undefined): boolean {
  if (argument === undefined) return true;
  const e = unwrap(argument);
  if (!Node.isObjectLiteralExpression(e)) return true;
  for (const property of e.getProperties()) {
    if (
      !Node.isPropertyAssignment(property) &&
      !Node.isShorthandPropertyAssignment(property) &&
      !Node.isMethodDeclaration(property) &&
      !Node.isGetAccessorDeclaration(property) &&
      !Node.isSetAccessorDeclaration(property)
    ) {
      return true;
    }
    const name = property.getNameNode();
    if (Node.isIdentifier(name)) {
      if (name.getText() === 'query') return true;
    } else if (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name)) {
      if (name.getLiteralText() === 'query') return true;
    } else {
      return true;
    }
  }
  return false;
}

/** Every method name `scanWriteCall` has anything to say about. */
const WATCHED_CALLS: ReadonlySet<string> = new Set([
  '$use',
  '$extends',
  '$executeRawUnsafe',
  '$queryRawUnsafe',
  'unsafe',
  'raw',
  ...PRISMA_WRITE_OPS,
  ...DRIZZLE_STARTERS,
]);

/**
 * Reads one call expression for everything this module notices: rule (1), the write hooks, the
 * ORM-shaped writes of part (a) and rules (4) and (5). `builderFile` is `importsQueryBuilder` of
 * the call's file.
 */
export function scanWriteCall(
  ctx: Ctx,
  file: string,
  call: CallExpression,
  builderFile: boolean,
): void {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return;
  const name = callee.getName();
  // Most calls are none of these; they cost a set lookup, not a walk of their arguments.
  if (!WATCHED_CALLS.has(name)) return;
  const args = call.getArguments();

  if (name === '$use') {
    ctx.guards.hooks.set(siteKey(file, call), { file, line: call.getStartLineNumber() });
    return;
  }
  if (name === '$extends') {
    if (extendsMayInject(args[0]))
      ctx.guards.hooks.set(siteKey(file, call), { file, line: call.getStartLineNumber() });
    return;
  }

  // Rule (1): a statement run from a value the extractor cannot read.
  if (
    name === '$executeRawUnsafe' ||
    name === '$queryRawUnsafe' ||
    name === 'unsafe' ||
    (name === 'raw' && receiverIsSql(callee.getExpression()))
  ) {
    if (runsUnreadStatement(args[0])) {
      const statement = args[0] === undefined ? null : fixedText(args[0]);
      noteUntraced(
        ctx,
        file,
        call,
        'unsafe-raw-call',
        statement === null ? 'unknown' : sqlVerb(statement.text),
      );
      const first = args[0];
      if (first !== undefined) ctx.guards.excluded.push([first.getStart(), first.getEnd()]);
    }
    return;
  }

  // Part (a) and rule (4): `<expr>.<delegate>.<writeOp>(...)`.
  if (PRISMA_WRITE_OPS.has(name)) {
    const holder = callee.getExpression();
    if (Node.isPropertyAccessExpression(holder)) {
      const table = ctx.names?.delegates.get(holder.getName());
      if (table !== undefined) {
        noteUnknownWriter(ctx, table, file, call.getStartLineNumber(), 'orm-write');
        return;
      }
    } else if (Node.isElementAccessExpression(holder)) {
      const key = holder.getArgumentExpression();
      if (
        key !== undefined &&
        (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key))
      ) {
        const table = ctx.names?.delegates.get(key.getLiteralText());
        if (table !== undefined) {
          noteUnknownWriter(ctx, table, file, call.getStartLineNumber(), 'orm-write');
          return;
        }
      } else if (key !== undefined && !Node.isNumericLiteral(key)) {
        noteUntraced(ctx, file, call, 'computed-delegate', operationVerb(name));
        return;
      }
    }
  }

  // Part (a) and rule (5): `<expr>.insert|update|delete(<argument>)`.
  if (DRIZZLE_STARTERS.has(name)) {
    const exported = tableExportName(args[0]);
    const table = exported === null ? undefined : ctx.names?.exports.get(exported);
    if (table !== undefined) {
      noteUnknownWriter(ctx, table, file, call.getStartLineNumber(), 'orm-write');
    } else if (builderFile) {
      noteUntraced(ctx, file, call, 'query-builder-call', operationVerb(name));
    }
  }
}
