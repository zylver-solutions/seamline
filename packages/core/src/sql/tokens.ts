/**
 * Token shape shared by the hand-written SQL lexer (`lex.ts`), `extract-data`'s
 * Drizzle TypeScript lexer, and the readers built on them.
 *
 * A dedicated SQL parser was considered and rejected: the statement surface
 * the extractors need is small and fully enumerated (design v3 section 6),
 * while a general parser is a large runtime dependency whose unused surface is
 * pure supply-chain liability (v3 sections 2.7 and 10).
 */

export type TokKind = 'word' | 'num' | 'str' | 'group' | 'punct';

export interface Tok {
  /** Token class. */
  readonly t: TokKind;
  /**
   * Normalized value. `word`: identifier text, lower-cased when unquoted.
   * `str`: decoded literal content. `group`: the opening bracket.
   * `punct`/`num`: the literal text.
   */
  readonly v: string;
  /** Original source slice, used for round-tripping expressions verbatim. */
  readonly raw: string;
  /** Absolute byte offset in the file the token came from. */
  readonly pos: number;
  /** True for a quoted identifier, whose case is significant. */
  readonly quoted: boolean;
  /** Balanced contents, for `group` tokens only. */
  readonly items: readonly Tok[];
  /**
   * Present (and `true`) only when the text ended before the token did: a
   * `group` whose closing bracket was not found, a string or quoted identifier
   * whose closing quote was not found, or a dollar-quoted body whose closing
   * tag was not found. The lexer tolerates such text, so a reader that must not
   * act on a truncated statement checks this instead of guessing from `raw`.
   */
  readonly unterminated?: true;
}

export const NO_ITEMS: readonly Tok[] = Object.freeze([]);

export function makeTok(
  t: TokKind,
  v: string,
  raw: string,
  pos: number,
  quoted = false,
  items: readonly Tok[] = NO_ITEMS,
  unterminated = false,
): Tok {
  return unterminated
    ? { t, v, raw, pos, quoted, items, unterminated: true }
    : { t, v, raw, pos, quoted, items };
}

/** Maps an absolute offset to a 1-based line number. */
export function makeLineIndex(text: string): (pos: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Upper-cased keyword at `i`, or null when that token is not an unquoted word. */
export function kw(toks: readonly Tok[], i: number): string | null {
  const t = toks[i];
  if (t === undefined || t.t !== 'word' || t.quoted) return null;
  return t.v.toUpperCase();
}

/** Identifier value at `i` (case-folded when unquoted), or null. */
export function ident(toks: readonly Tok[], i: number): string | null {
  const t = toks[i];
  if (t === undefined || t.t !== 'word') return null;
  return t.v;
}

export function isPunct(toks: readonly Tok[], i: number, v: string): boolean {
  const t = toks[i];
  return t !== undefined && t.t === 'punct' && t.v === v;
}

export function isGroup(toks: readonly Tok[], i: number, open: string): boolean {
  const t = toks[i];
  return t !== undefined && t.t === 'group' && t.v === open;
}

export function group(toks: readonly Tok[], i: number, open: string): Tok | null {
  const t = toks[i];
  return t !== undefined && t.t === 'group' && t.v === open ? t : null;
}

/** True when the tokens at `i` are exactly this keyword sequence. */
export function matchKw(toks: readonly Tok[], i: number, words: readonly string[]): boolean {
  for (let k = 0; k < words.length; k += 1) {
    if (kw(toks, i + k) !== words[k]) return false;
  }
  return true;
}

/** Splits a token list on top-level occurrences of one punctuation token. */
export function splitOn(toks: readonly Tok[], sep: string): Tok[][] {
  const out: Tok[][] = [];
  let cur: Tok[] = [];
  for (const t of toks) {
    if (t.t === 'punct' && t.v === sep) {
      out.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  out.push(cur);
  return out.filter((g) => g.length > 0);
}

/** Source text spanned by a token list, reconstructed from the original file. */
export function spanRaw(text: string, toks: readonly Tok[]): string {
  const first = toks[0];
  const last = toks[toks.length - 1];
  if (first === undefined || last === undefined) return '';
  return text.slice(first.pos, last.pos + last.raw.length);
}

/** Collapses whitespace so a captured expression is byte-stable across formatting. */
export function collapseWs(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}
