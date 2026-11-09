/**
 * Table references in SQL string literals.
 *
 * This is the one place the extractor reads a fact out of a string rather than
 * out of the type checker, so it is scoped hard: only the table name in the
 * `FROM` / `JOIN` position of a statement that starts with a recognised verb.
 * The emitted `QUERIES` edge carries a confidence below 1 to record that the
 * *string* is extracted while the binding to a specific `Table` node is not.
 *
 * The functions here are the read gate: they find the tables a `SELECT` (or a
 * `WITH`) reads, and the tables named after `FROM` and `JOIN` inside a write.
 * Which table a write statement writes, and which columns it names, is decided
 * by `raw-sql.ts`, which reads the statement as tokens.
 */

export type SqlOperation = 'select' | 'insert' | 'update' | 'delete';

/**
 * The stand-in for one `${...}` substitution of a template literal.
 *
 * U+FFFF is a Unicode noncharacter: it is not assigned to any character and is
 * not used for interchange, so it does not occur in SQL text. It still can in a
 * string a program holds, so `sqlText` rewrites any that does to U+FFFD first,
 * and a sentinel in the text therefore always stands for a substitution. The
 * classifier tells the two kinds of position apart by it (a value is ordinary;
 * a table name, a column or an assignment target that holds one is not a
 * literal name). It is deliberately not `?`, which is a PostgreSQL operator and
 * a parameter marker and so does occur in SQL text.
 */
export const SUBSTITUTION = '\uFFFF';

/**
 * The text a statement classifier reads, from the literal parts of a string or
 * template: one part for a string or a substitution-free template, the head and
 * the text of each span for a template with substitutions. The substitutions
 * themselves are never read, so nothing inside `${...}` can change the result.
 */
export function sqlText(parts: readonly string[]): string {
  return parts.map((part) => part.replaceAll(SUBSTITUTION, '\uFFFD')).join(SUBSTITUTION);
}

export interface SqlTableRef {
  /** Table name, lower-cased, quotes and schema qualifier stripped. */
  readonly table: string;
  /** Schema qualifier when the reference was `schema.table`, else `null`. */
  readonly schema: string | null;
  readonly operation: SqlOperation;
}

/**
 * A table name with the spelling it had in the statement.
 *
 * `table` and `schema` are lower-cased and unquoted, which loses what a database
 * that folds only unquoted names needs: `FROM "Invitation"` and `FROM invitation`
 * name different relations in PostgreSQL. Binding a name to a declared table
 * (`data-model.ts`) reads the spelling and whether it was quoted.
 */
export interface SqlTableName {
  /** Table name, lower-cased, quotes and schema qualifier stripped. */
  readonly table: string;
  /** Schema qualifier when the name was `schema.table`, else `null`. */
  readonly schema: string | null;
  /** Table name as written, quotes stripped. */
  readonly tableText: string;
  /** True when the table name was double-quoted. */
  readonly tableQuoted: boolean;
  /** Schema qualifier as written, quotes stripped, or `null`. */
  readonly schemaText: string | null;
  /** True when the schema qualifier was double-quoted. */
  readonly schemaQuoted: boolean;
}

/** A table name together with the verb that referred to it. */
export interface SqlTableOccurrence extends SqlTableName {
  readonly operation: SqlOperation;
}

const STARTS_STATEMENT = /^\s*(select|insert|update|delete|with)\b/i;

/**
 * One pass with the verb captured, rather than one pass per operation.
 *
 * Separate patterns double-count: `DELETE FROM sessions` matches both the
 * delete pattern and the bare `FROM` pattern, producing two table references
 * for one statement. A single left-to-right scan consumes `delete from` as a
 * unit, so the verb that owns the table is unambiguous.
 */
const TABLE_REF =
  /\b(insert\s+into|delete\s+from|update|from|join)\s+("?[\w$]+"?\.)?("?)([\w$]+)"?/gi;

const VERB_OPERATION: ReadonlyArray<readonly [RegExp, SqlOperation]> = [
  [/^insert/i, 'insert'],
  [/^delete/i, 'delete'],
  [/^update/i, 'update'],
];

function operationFor(verb: string): SqlOperation {
  for (const [pattern, operation] of VERB_OPERATION) {
    if (pattern.test(verb)) return operation;
  }
  return 'select';
}

/** Words that follow a verb but are never the table it names. */
export const NOT_A_TABLE: ReadonlySet<string> = new Set([
  'select',
  'where',
  'set',
  'values',
  'on',
  'as',
  'dual',
]);

/** True when `text` reads as a SQL statement rather than an arbitrary string. */
export function looksLikeSql(text: string): boolean {
  if (text.length < 12) return false;
  if (!STARTS_STATEMENT.test(text)) return false;
  return /\b(from|into|update|join)\b/i.test(text);
}

/**
 * Every table reference in `text`, in source order, with the spelling it had,
 * without the `looksLikeSql` gate (the caller has decided the text is a
 * statement).
 *
 * A name that a substitution touches (`users_${suffix}`, `${schema}.users`,
 * `"${t}"`) is not a literal name, so it is not a reference: the pattern would
 * otherwise read the part before the substitution as the table.
 */
export function scanTableOccurrences(text: string): readonly SqlTableOccurrence[] {
  return scanTableMatches(text).map((match) => match.occurrence);
}

/** One reference `scanTableOccurrences` reads, with where in the scanned text its name starts. */
export interface SqlTableMatch {
  readonly occurrence: SqlTableOccurrence;
  /**
   * Offset in the scanned text of the first character of the name: the schema
   * qualifier when there is one, else the table name (its opening quote
   * included). A reader that knows what the text means at that place, from its
   * tokens, can tell a reference it should not take (a CTE, a function, a
   * keyword) and drop it by this offset.
   */
  readonly nameAt: number;
}

/** `scanTableOccurrences` with the position of each name, in source order. */
export function scanTableMatches(text: string): readonly SqlTableMatch[] {
  const found: SqlTableMatch[] = [];
  // A fresh RegExp per call: a shared /g regex carries lastIndex between calls,
  // which would make the result depend on call order.
  const re = new RegExp(TABLE_REF.source, `${TABLE_REF.flags}d`);
  let m = re.exec(text);
  while (m !== null) {
    const verb = m[1];
    const tableText = m[4];
    const after = re.lastIndex;
    const spliced =
      text[after] === SUBSTITUTION || (text[after] === '.' && text[after + 1] === SUBSTITUTION);
    if (verb !== undefined && tableText !== undefined && !spliced) {
      const table = tableText.toLowerCase();
      if (!NOT_A_TABLE.has(table)) {
        const rawSchema = m[2];
        const schemaText = rawSchema === undefined ? null : rawSchema.replace(/["\s.]/g, '');
        const nameAt = (m.indices?.[2] ?? m.indices?.[3])?.[0] ?? m.index;
        found.push({
          nameAt,
          occurrence: {
            table,
            schema: schemaText === null ? null : schemaText.toLowerCase(),
            operation: operationFor(verb),
            tableText,
            tableQuoted: m[3] === '"',
            schemaText,
            schemaQuoted: rawSchema !== undefined && rawSchema.startsWith('"'),
          },
        });
      }
    }
    m = re.exec(text);
  }
  return found;
}

function scanTableRefs(text: string): readonly SqlTableOccurrence[] {
  return looksLikeSql(text) ? scanTableOccurrences(text) : [];
}

function compareRefs(a: SqlTableRef, b: SqlTableRef): number {
  if (a.table !== b.table) return a.table < b.table ? -1 : 1;
  if (a.operation !== b.operation) return a.operation < b.operation ? -1 : 1;
  return (a.schema ?? '') < (b.schema ?? '') ? -1 : (a.schema ?? '') > (b.schema ?? '') ? 1 : 0;
}

/**
 * Extract table references from a SQL statement.
 *
 * Returns them sorted and de-duplicated so that the same query text always
 * yields the same edge set in the same order.
 */
export function sqlTableRefs(text: string): readonly SqlTableRef[] {
  const seen = new Map<string, SqlTableRef>();
  for (const occurrence of scanTableRefs(text)) {
    const key = `${occurrence.operation}:${occurrence.schema ?? ''}:${occurrence.table}`;
    if (!seen.has(key)) {
      seen.set(key, {
        table: occurrence.table,
        schema: occurrence.schema,
        operation: occurrence.operation,
      });
    }
  }
  return [...seen.values()].sort(compareRefs);
}

/**
 * The same references with their spelling, for binding to a declared table.
 *
 * De-duplicated on the spelling as well, so `"Users"` and `users` in one
 * statement stay two references: they are two relations in PostgreSQL. The
 * order is the one `sqlTableRefs` uses, with the spelling as the last key.
 */
export function sqlTableOccurrences(text: string): readonly SqlTableOccurrence[] {
  const seen = new Map<string, SqlTableOccurrence>();
  for (const occurrence of scanTableRefs(text)) {
    const key = [
      occurrence.operation,
      occurrence.schemaQuoted ? `"${occurrence.schemaText ?? ''}"` : (occurrence.schema ?? ''),
      occurrence.tableQuoted ? `"${occurrence.tableText}"` : occurrence.table,
    ].join(':');
    if (!seen.has(key)) seen.set(key, occurrence);
  }
  return [...seen.values()].sort((a, b) => {
    const base = compareRefs(a, b);
    if (base !== 0) return base;
    if (a.tableText !== b.tableText) return a.tableText < b.tableText ? -1 : 1;
    return Number(a.tableQuoted) - Number(b.tableQuoted);
  });
}
