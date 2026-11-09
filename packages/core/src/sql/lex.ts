/**
 * Postgres-dialect SQL lexer.
 *
 * Handles the lexical forms that change the meaning of a statement boundary:
 * line and block comments (block comments nest in Postgres), single-quoted
 * literals with `''` escapes, `E'..'` backslash escapes, double-quoted
 * identifiers whose case is significant, and dollar-quoted bodies (which is
 * how a `CREATE FUNCTION` body avoids being split on its internal `;`).
 *
 * The lexer tolerates text that ends inside a bracket, a quote or a dollar-quoted body.
 * It rejects more than 256 nested bracket groups with RangeError before recursing,
 * so the supported depth is independent of the host stack and JIT warmup.
 * A token that the text cut short is
 * marked `unterminated` (see `tokens.ts`), so a reader can tell a complete
 * statement from a truncated one without re-scanning.
 */

import { NO_ITEMS, type Tok, makeTok } from './tokens.ts';

const TWO_CHAR_PUNCT = ['::', '<=', '>=', '<>', '!=', '||', '->', '=>'] as const;

const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const MAX_NESTING_DEPTH = 256;

const IDENT_START = /[A-Za-z_\u0080-\uFFFF]/u;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/u;

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

interface ScanResult {
  readonly toks: Tok[];
  readonly next: number;
  /** True when the scan stopped at its closing bracket, not at the end of the text. */
  readonly closed: boolean;
}

function scan(text: string, from: number, closer: string | null, depth: number): ScanResult {
  const toks: Tok[] = [];
  let i = from;
  while (i < text.length) {
    const c = text[i] as string;

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i += 1;
      continue;
    }

    // Line comment.
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }

    // Block comment; Postgres nests them.
    if (c === '/' && text[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }

    if (closer !== null && c === closer) {
      return { toks, next: i + 1, closed: true };
    }

    // A stray closer for a bracket we are not inside: tolerate and drop it.
    if (closer === null && (c === ')' || c === ']' || c === '}')) {
      i += 1;
      continue;
    }

    if (c === '(' || c === '[' || c === '{') {
      if (depth >= MAX_NESTING_DEPTH) throw new RangeError(`SQL nesting limit exceeded (${MAX_NESTING_DEPTH})`);
      const start = i;
      const inner = scan(text, i + 1, CLOSERS[c] as string, depth + 1);
      toks.push(makeTok('group', c, text.slice(start, inner.next), start, false, inner.toks, !inner.closed));
      i = inner.next;
      continue;
    }

    // Escaped string literal, E'..'.
    if ((c === 'E' || c === 'e') && text[i + 1] === "'") {
      const start = i;
      i += 2;
      let out = '';
      let terminated = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          out += text[i + 1] as string;
          i += 2;
        } else if (text[i] === "'" && text[i + 1] === "'") {
          out += "'";
          i += 2;
        } else if (text[i] === "'") {
          i += 1;
          terminated = true;
          break;
        } else {
          out += text[i] as string;
          i += 1;
        }
      }
      toks.push(makeTok('str', out, text.slice(start, i), start, false, NO_ITEMS, !terminated));
      continue;
    }

    if (c === "'") {
      const start = i;
      i += 1;
      let out = '';
      let terminated = false;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          out += "'";
          i += 2;
        } else if (text[i] === "'") {
          i += 1;
          terminated = true;
          break;
        } else {
          out += text[i] as string;
          i += 1;
        }
      }
      toks.push(makeTok('str', out, text.slice(start, i), start, false, NO_ITEMS, !terminated));
      continue;
    }

    if (c === '"') {
      const start = i;
      i += 1;
      let out = '';
      let terminated = false;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') {
          out += '"';
          i += 2;
        } else if (text[i] === '"') {
          i += 1;
          terminated = true;
          break;
        } else {
          out += text[i] as string;
          i += 1;
        }
      }
      toks.push(makeTok('word', out, text.slice(start, i), start, true, NO_ITEMS, !terminated));
      continue;
    }

    // Dollar-quoted body, $tag$ ... $tag$.
    if (c === '$') {
      const m = /^\$[A-Za-z_0-9]*\$/u.exec(text.slice(i));
      if (m !== null) {
        const tag = m[0];
        const start = i;
        const end = text.indexOf(tag, i + tag.length);
        const stop = end < 0 ? text.length : end + tag.length;
        const body = text.slice(i + tag.length, end < 0 ? text.length : end);
        toks.push(makeTok('str', body, text.slice(start, stop), start, false, NO_ITEMS, end < 0));
        i = stop;
        continue;
      }
      // Positional parameter, $1.
      if (isDigit(text[i + 1] ?? '')) {
        const start = i;
        i += 1;
        while (i < text.length && isDigit(text[i] as string)) i += 1;
        toks.push(makeTok('num', text.slice(start, i), text.slice(start, i), start));
        continue;
      }
    }

    if (isDigit(c) || (c === '.' && isDigit(text[i + 1] ?? ''))) {
      const start = i;
      while (i < text.length) {
        const ch = text[i] as string;
        if (isDigit(ch)) {
          i += 1;
          continue;
        }
        if (ch === '.' && !text.slice(start, i).includes('.')) {
          i += 1;
          continue;
        }
        if ((ch === 'e' || ch === 'E') && isDigit(text[i + 1] ?? '')) {
          i += 2;
          continue;
        }
        if ((ch === 'e' || ch === 'E') && /[+-]/u.test(text[i + 1] ?? '') && isDigit(text[i + 2] ?? '')) {
          i += 3;
          continue;
        }
        break;
      }
      toks.push(makeTok('num', text.slice(start, i), text.slice(start, i), start));
      continue;
    }

    if (IDENT_START.test(c)) {
      const start = i;
      while (i < text.length && IDENT_PART.test(text[i] as string)) i += 1;
      const raw = text.slice(start, i);
      toks.push(makeTok('word', raw.toLowerCase(), raw, start));
      continue;
    }

    const two = text.slice(i, i + 2);
    if ((TWO_CHAR_PUNCT as readonly string[]).includes(two)) {
      toks.push(makeTok('punct', two, two, i));
      i += 2;
      continue;
    }

    toks.push(makeTok('punct', c, c, i));
    i += 1;
  }
  return { toks, next: i, closed: closer === null };
}

export function tokenizeSql(text: string): Tok[] {
  return scan(text, 0, null, 0).toks;
}

export interface SqlStatement {
  readonly toks: readonly Tok[];
  /** Absolute offset of the statement's first token. */
  readonly pos: number;
}

/** Splits a lexed file into statements on top-level `;`. */
export function splitStatements(toks: readonly Tok[]): SqlStatement[] {
  const out: SqlStatement[] = [];
  let cur: Tok[] = [];
  for (const t of toks) {
    if (t.t === 'punct' && t.v === ';') {
      if (cur.length > 0) out.push({ toks: cur, pos: (cur[0] as Tok).pos });
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length > 0) out.push({ toks: cur, pos: (cur[0] as Tok).pos });
  return out;
}
