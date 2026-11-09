/**
 * Loading and `$ref` resolution for JSON/YAML contract documents.
 *
 * Hardening (design v3 §2.7):
 *  - no network fetch, ever: a `$ref` naming any URI scheme is refused;
 *  - `$ref` resolves only inside the repo root, symlinks included;
 *  - input size is capped per file and document count is capped per root;
 *  - resolution depth is capped and a `$ref` cycle terminates instead of
 *    hanging, by tracking the `(file, pointer)` pairs on the current chain.
 *
 * YAML is parsed with `yaml` in a mode that refuses custom tags, so a
 * document cannot construct arbitrary objects. There is no XML path in this
 * extractor at all, which is the strongest form of "XXE disabled".
 */

import { parseDocument as parseYamlDocument } from 'yaml';
import { pointerGet, isRecord } from './json-pointer.ts';
import { readCapped, resolveInsideRoot, toRepoRelativePosix, REFUSAL_REMOTE } from './safe-fs.ts';
import type { ExtractLimits } from './types.ts';

/**
 * The only file types a contract document can be. Discovery reads these, and a
 * `$ref` may follow into these and nothing else: a `$ref` is attacker-shaped
 * text in a repository file, and "parse whatever it names as YAML" would let it
 * pull any file in the tree (an `.env`, a key) into a parse error's code frame.
 * The capability manifest declares reads for exactly these types.
 */
export const DOCUMENT_EXTENSIONS = ['.yaml', '.yml', '.json'] as const;

export function isDocumentPath(rel: string): boolean {
  const lower = rel.toLowerCase();
  return DOCUMENT_EXTENSIONS.some((e) => lower.endsWith(e));
}

export interface LoadedDocument {
  readonly absolute: string;
  readonly relPosix: string;
  readonly value: unknown;
}

export type LoadOutcome =
  | { readonly ok: true; readonly doc: LoadedDocument }
  | { readonly ok: false; readonly diagnostic: string };

/**
 * JSON documents allow comments as whitespace, then use `JSON.parse` for the
 * value grammar. YAML-only syntax is still an error in a JSON document, in
 * every letter case. See docs/design/json-document-comments.md.
 */
export function parseDocument(
  relPosix: string,
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    if (relPosix.toLowerCase().endsWith('.json')) {
      return { ok: true, value: JSON.parse(jsonCommentWhitespace(text)) as unknown };
    }
    const document = parseYamlDocument(text, {
      // Refuse anything but the core schema: no custom tags, no merge keys
      // resolving to shared mutable state, no implicit type coercion beyond
      // JSON's own.
      customTags: [],
      merge: false,
      // The document API returns warnings without logging them. A non-silent
      // level is needed for its MULTIPLE_DOCS error to be recorded.
      logLevel: 'error',
      prettyErrors: false,
    });
    // A recovered partial value cannot authorize deletion. Error messages can
    // contain source text; release only parser codes and numeric source offsets.
    if (document.errors.length > 0)
      return {
        ok: false,
        error: document.errors
          .map((error) => `YAML_PARSE_ERROR: ${error.code} at offset ${error.pos[0]}`)
          .join('; '),
      };
    return { ok: true, value: document.toJS({ maxAliasCount: 100 }) as unknown };
  } catch {
    // JSON syntax and YAML conversion errors can also quote input values.
    return {
      ok: false,
      error: relPosix.toLowerCase().endsWith('.json') ? 'JSON_PARSE_ERROR' : 'YAML_VALUE_ERROR',
    };
  }
}

/** Remove only comments outside strings; whitespace prevents token concatenation. */
function jsonCommentWhitespace(text: string): string {
  const parts: string[] = [];
  let last = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char !== '/') continue;

    const next = text[index + 1];
    if (next !== '/' && next !== '*') continue;
    const start = index;
    let end: number;
    if (next === '/') {
      end = index + 2;
      while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end += 1;
    } else {
      const close = text.indexOf('*/', index + 2);
      if (close === -1) throw new Error('Unterminated JSON comment');
      end = close + 2;
    }
    parts.push(text.slice(last, start), text.slice(start, end).replace(/[^\r\n]/g, ' '));
    last = end;
    index = end - 1;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(last));
  return parts.join('');
}

/**
 * Loads documents on demand, confined to the repo root, with a per-root cap
 * on how many distinct files one resolution session may open.
 */
export class DocumentLoader {
  readonly repoRoot: string;
  readonly limits: ExtractLimits;
  readonly diagnostics: string[] = [];
  private readonly cache = new Map<string, LoadedDocument | null>();

  constructor(repoRoot: string, limits: ExtractLimits) {
    this.repoRoot = repoRoot;
    this.limits = limits;
  }

  /** Number of distinct files successfully loaded. */
  get loadedCount(): number {
    let n = 0;
    for (const v of this.cache.values()) if (v !== null) n += 1;
    return n;
  }

  /** Register an already-parsed root document so a self-`$ref` reuses it. */
  primeCache(doc: LoadedDocument): void {
    this.cache.set(doc.absolute, doc);
  }

  loadAbsolute(absolute: string): LoadOutcome {
    const cached = this.cache.get(absolute);
    if (cached !== undefined) {
      return cached === null
        ? {
            ok: false,
            diagnostic: `document previously failed to load: ${toRepoRelativePosix(this.repoRoot, absolute)}`,
          }
        : { ok: true, doc: cached };
    }
    if (this.loadedCount >= this.limits.maxRefDocuments) {
      this.cache.set(absolute, null);
      const rel = toRepoRelativePosix(this.repoRoot, absolute);
      return { ok: false, diagnostic: `REF_DOCUMENT_CAP: refused to load ${rel}` };
    }
    const rel = toRepoRelativePosix(this.repoRoot, absolute);
    if (!isDocumentPath(rel)) {
      this.cache.set(absolute, null);
      return {
        ok: false,
        diagnostic: `REF_UNSUPPORTED_TYPE: ${rel} (a $ref may only name a ${DOCUMENT_EXTENSIONS.join(', ')} document)`,
      };
    }
    const read = readCapped(absolute, this.limits.maxFileBytes);
    if (!read.ok) {
      this.cache.set(absolute, null);
      return { ok: false, diagnostic: `${read.refusal}: ${rel} (${read.detail})` };
    }
    const parsed = parseDocument(rel, read.text);
    if (!parsed.ok) {
      this.cache.set(absolute, null);
      return { ok: false, diagnostic: `PARSE_ERROR: ${rel}: ${parsed.error}` };
    }
    const doc: LoadedDocument = { absolute, relPosix: rel, value: parsed.value };
    this.cache.set(absolute, doc);
    return { ok: true, doc };
  }
}

export interface RefTarget {
  readonly doc: LoadedDocument;
  readonly pointer: string;
  readonly value: unknown;
  /** Stable chain key `relPosix#pointer`, used for cycle detection. */
  readonly key: string;
}

export type RefOutcome =
  | { readonly ok: true; readonly target: RefTarget }
  | { readonly ok: false; readonly diagnostic: string; readonly refused: boolean };

/**
 * Resolve one `$ref` against `from`.
 *
 * A ref is `[<relative-file-path>]#<json-pointer>`. Anything with a URI
 * scheme, a protocol-relative prefix, or a resolved location outside the repo
 * root is refused and reported; it is never fetched and never read.
 */
export function resolveRef(loader: DocumentLoader, from: LoadedDocument, ref: string): RefOutcome {
  const hash = ref.indexOf('#');
  const filePart = hash < 0 ? ref : ref.slice(0, hash);
  const pointer = hash < 0 ? '' : ref.slice(hash + 1);

  if (filePart === '') {
    const value = pointerGet(from.value, pointer);
    if (value === undefined) {
      return {
        ok: false,
        refused: false,
        diagnostic: `REF_NOT_FOUND: ${from.relPosix}#${pointer}`,
      };
    }
    return { ok: true, target: { doc: from, pointer, value, key: `${from.relPosix}#${pointer}` } };
  }

  const resolution = resolveInsideRoot(loader.repoRoot, from.absolute, filePart);
  if (!resolution.ok) {
    const label = resolution.refusal === REFUSAL_REMOTE ? REFUSAL_REMOTE : resolution.refusal;
    return {
      ok: false,
      refused: true,
      diagnostic: `${label}: ${from.relPosix} -> ${resolution.detail}`,
    };
  }
  const loaded = loader.loadAbsolute(resolution.absolute);
  if (!loaded.ok) return { ok: false, refused: false, diagnostic: loaded.diagnostic };
  const value = pointerGet(loaded.doc.value, pointer);
  if (value === undefined) {
    return {
      ok: false,
      refused: false,
      diagnostic: `REF_NOT_FOUND: ${loaded.doc.relPosix}#${pointer}`,
    };
  }
  return {
    ok: true,
    target: { doc: loaded.doc, pointer, value, key: `${loaded.doc.relPosix}#${pointer}` },
  };
}

/**
 * Follow a chain of `$ref`s to the first non-`$ref` value.
 *
 * `seen` carries the `(file, pointer)` pairs already on this chain, so a
 * cycle (`A -> B -> A`) terminates with a diagnostic rather than recursing.
 * `maxRefDepth` bounds a long non-cyclic chain independently.
 */
export function derefSchema(
  loader: DocumentLoader,
  from: LoadedDocument,
  value: unknown,
  seen: Set<string>,
): { doc: LoadedDocument; value: unknown; cyclic: boolean } {
  let curDoc = from;
  let cur = value;
  let hops = 0;
  while (isRecord(cur) && typeof cur['$ref'] === 'string') {
    if (hops >= loader.limits.maxRefDepth) {
      loader.diagnostics.push(`REF_DEPTH_EXCEEDED: ${curDoc.relPosix} after ${hops} hops`);
      return { doc: curDoc, value: {}, cyclic: true };
    }
    hops += 1;
    const outcome = resolveRef(loader, curDoc, cur['$ref']);
    if (!outcome.ok) {
      loader.diagnostics.push(outcome.diagnostic);
      return { doc: curDoc, value: {}, cyclic: false };
    }
    if (seen.has(outcome.target.key)) {
      loader.diagnostics.push(`REF_CYCLE: ${outcome.target.key}`);
      return { doc: outcome.target.doc, value: {}, cyclic: true };
    }
    seen.add(outcome.target.key);
    curDoc = outcome.target.doc;
    cur = outcome.target.value;
  }
  return { doc: curDoc, value: cur, cyclic: false };
}
