/** The tolerant SQL lexer cannot by itself certify complete source coverage. */
import type { Tok } from '@seamline/core/sql';

function trivia(text: string, start: number, end: number): boolean {
  let at = start;
  while (at < end) {
    const char = text[at];
    if (char !== undefined && /[ \t\n\r\f\v]/.test(char)) { at += 1; continue; }
    if (text.startsWith('--', at)) {
      const newline = text.indexOf('\n', at + 2);
      at = newline === -1 ? end : Math.min(newline + 1, end); continue;
    }
    if (!text.startsWith('/*', at)) return false;
    at += 2;
    let depth = 1;
    while (at < end && depth > 0) {
      if (text.startsWith('/*', at)) { depth += 1; at += 2; }
      else if (text.startsWith('*/', at)) { depth -= 1; at += 2; }
      else at += 1;
      if (depth > 64) return false;
    }
    if (depth !== 0 || at > end) return false;
  }
  return at === end;
}

/** Every non-comment character must belong to a complete, balanced token. */
export function completeReplaySource(text: string, tokens: readonly Tok[], start = 0, end = text.length, depth = 0): boolean {
  if (depth > 64) return false;
  let at = start;
  for (const token of tokens) {
    if (token.t === 'punct' && [')', ']', '}'].includes(token.v)) return false;
    const next = token.pos + token.raw.length;
    if (token.unterminated || token.pos < at || next > end || !trivia(text, at, token.pos) || text.slice(token.pos, next) !== token.raw) return false;
    if (token.t === 'group') {
      const close = token.v === '(' ? ')' : token.v === '[' ? ']' : token.v === '{' ? '}' : '';
      if (!close || token.raw.at(-1) !== close || !completeReplaySource(text, token.items, token.pos + 1, next - 1, depth + 1)) return false;
    }
    at = next;
  }
  return trivia(text, at, end);
}
