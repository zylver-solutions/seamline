/** RFC 6901 JSON Pointer helpers. Pointers are part of node identity. */

/** Escape one reference token: `~` -> `~0`, `/` -> `~1`. */
export function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Append tokens to a pointer. `pointer('/a', 'b/c')` -> `/a/b~1c`. */
export function pointerAppend(base: string, ...tokens: readonly string[]): string {
  let out = base;
  for (const t of tokens) out += `/${escapeToken(t)}`;
  return out;
}

export function pointerTokens(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  return pointer.replace(/^\//, '').split('/').map(unescapeToken);
}

/** Resolve a pointer within an already-parsed document. `undefined` if absent. */
export function pointerGet(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(cur)) {
      const i = Number(token);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else if (isRecord(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return undefined;
      cur = cur[token];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
