/**
 * `@seamline/core/sql` - the SQL tokenizer and the token helpers the readers
 * built on it share.
 *
 * It is a subpath entry and deliberately not part of the package root: the root
 * loads `node:sqlite`, and the extractors that need only a tokenizer should not
 * pay for that import (the same reason `@seamline/core/identity` exists). The
 * module is pure. It does no I/O, imports nothing from `node:` and nothing from
 * the semantic layer.
 *
 * Two extractors read SQL with it: `extract-data` reads DDL, and
 * `extract-code-ts` classifies the statements it finds in string and template
 * literals. A single tokenizer means a quoted identifier, a comment, a
 * dollar-quoted body and a nested bracket mean the same thing to both.
 */
export { splitStatements, tokenizeSql } from './lex.ts';
export type { SqlStatement } from './lex.ts';
export {
  collapseWs,
  group,
  ident,
  isGroup,
  isPunct,
  kw,
  makeLineIndex,
  makeTok,
  matchKw,
  spanRaw,
  splitOn,
} from './tokens.ts';
export type { Tok, TokKind } from './tokens.ts';
