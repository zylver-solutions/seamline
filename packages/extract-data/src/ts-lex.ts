/**
 * Minimal TypeScript/JavaScript lexer, sufficient for reading a Drizzle
 * schema module.
 *
 * A Drizzle schema is a set of top-level `const` bindings to builder-chain
 * expressions. Reading that shape needs bracket matching, string and template
 * literals, and comments — not a type checker. `extract-code-ts` owns
 * ts-morph and the real resolution problem (design v3 §6); pulling the same
 * dependency in here to read object literals would be the wrong trade.
 *
 * Identifier case is preserved: `createdAt` and `createdat` are different
 * bindings, unlike SQL identifiers.
 */

import { type Tok, makeTok } from '@seamline/core/sql';

const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

const MULTI_PUNCT: readonly string[] = [
  '>>>=',
  '===',
  '!==',
  '**=',
  '...',
  '<<=',
  '>>=',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**',
];

const IDENT_START = /[A-Za-z_$\u0080-\uFFFF]/u;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/u;

export interface TsComment {
  readonly pos: number;
  readonly text: string;
}

export interface TsLexResult {
  readonly toks: readonly Tok[];
  readonly comments: readonly TsComment[];
}

interface ScanState {
  readonly text: string;
  readonly comments: TsComment[];
}

/** True when a `/` at this point can only start a regular expression. */
function regexAllowed(prev: Tok | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.t === 'num' || prev.t === 'str') return false;
  if (prev.t === 'group') return false;
  if (prev.t === 'word') {
    return ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield'].includes(prev.v);
  }
  return true;
}

function readTemplate(st: ScanState, from: number): { tok: Tok; next: number } {
  const { text } = st;
  let i = from + 1;
  let body = '';
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '\\') {
      body += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '`') {
      i += 1;
      break;
    }
    if (c === '$' && text[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        const d = text[j] as string;
        if (d === '{') depth += 1;
        else if (d === '}') depth -= 1;
        j += 1;
      }
      body += text.slice(i, j);
      i = j;
      continue;
    }
    body += c;
    i += 1;
  }
  return { tok: makeTok('str', body, text.slice(from, i), from), next: i };
}

function scan(st: ScanState, from: number, closer: string | null): { toks: Tok[]; next: number } {
  const { text } = st;
  const toks: Tok[] = [];
  let i = from;
  while (i < text.length) {
    const c = text[i] as string;

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i += 1;
      continue;
    }

    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      st.comments.push({ pos: i, text: text.slice(i + 2, end).trim() });
      i = end;
      continue;
    }

    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      st.comments.push({ pos: i, text: text.slice(i + 2, end < 0 ? text.length : end).trim() });
      i = stop;
      continue;
    }

    if (closer !== null && c === closer) return { toks, next: i + 1 };
    if (closer === null && (c === ')' || c === ']' || c === '}')) {
      i += 1;
      continue;
    }

    if (c === '(' || c === '[' || c === '{') {
      const start = i;
      const inner = scan(st, i + 1, CLOSERS[c] as string);
      toks.push(makeTok('group', c, text.slice(start, inner.next), start, false, inner.toks));
      i = inner.next;
      continue;
    }

    if (c === '`') {
      const r = readTemplate(st, i);
      toks.push(r.tok);
      i = r.next;
      continue;
    }

    if (c === "'" || c === '"') {
      const start = i;
      i += 1;
      let out = '';
      while (i < text.length) {
        const d = text[i] as string;
        if (d === '\\') {
          out += text[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (d === c) {
          i += 1;
          break;
        }
        if (d === '\n') break;
        out += d;
        i += 1;
      }
      toks.push(makeTok('str', out, text.slice(start, i), start));
      continue;
    }

    if (c === '/' && regexAllowed(toks[toks.length - 1])) {
      const start = i;
      i += 1;
      let inClass = false;
      let closed = false;
      while (i < text.length) {
        const d = text[i] as string;
        if (d === '\\') {
          i += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) {
          i += 1;
          closed = true;
          break;
        } else if (d === '\n') break;
        i += 1;
      }
      if (closed) {
        while (i < text.length && IDENT_PART.test(text[i] as string)) i += 1;
        toks.push(makeTok('str', text.slice(start, i), text.slice(start, i), start));
        continue;
      }
      i = start + 1;
      toks.push(makeTok('punct', '/', '/', start));
      continue;
    }

    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < text.length && /[0-9a-fA-FxXoObBnE_.+-]/u.test(text[i] as string)) {
        const ch = text[i] as string;
        if ((ch === '+' || ch === '-') && !/[eE]/u.test(text[i - 1] ?? '')) break;
        i += 1;
      }
      toks.push(makeTok('num', text.slice(start, i), text.slice(start, i), start));
      continue;
    }

    if (IDENT_START.test(c)) {
      const start = i;
      while (i < text.length && IDENT_PART.test(text[i] as string)) i += 1;
      const raw = text.slice(start, i);
      toks.push(makeTok('word', raw, raw, start));
      continue;
    }

    let matched = '';
    for (const p of MULTI_PUNCT) {
      if (text.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (matched !== '') {
      toks.push(makeTok('punct', matched, matched, i));
      i += matched.length;
      continue;
    }

    toks.push(makeTok('punct', c, c, i));
    i += 1;
  }
  return { toks, next: i };
}

export function tokenizeTs(text: string): TsLexResult {
  const st: ScanState = { text, comments: [] };
  const { toks } = scan(st, 0, null);
  return { toks, comments: st.comments };
}
