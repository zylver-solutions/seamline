/** Supported migration order is evidence, not a guess from numeric prefixes. */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_VALUES = 8192;
const MAX_DEPTH = 16;
const MAX_DIRECTORY_ENTRIES = 8192;

export type MigrationOrder =
  | { readonly group: string; readonly state: 'known'; readonly policy: 'supabase-filename-v1'; readonly configHash: string; readonly accepted: ReadonlySet<string> }
  | { readonly group: string; readonly state: 'unknown'; readonly candidate: boolean; readonly reason: string };

type Value = string | number | boolean | Value[];

/**
 * Complete parsing of a deliberately small TOML subset. Unsupported TOML is
 * unknown, including multiline strings, inline tables, dates and array tables.
 * Nothing is evaluated. Maps keep attacker-controlled keys off object prototypes.
 */
class ConfigReader {
  private pos = 0;
  private values = 0;
  private table: string[] = [];
  private readonly namespaces = new Map<string, 'table' | 'value'>();
  private readonly explicitTables = new Set<string>();
  private readonly assignments = new Map<string, Value>();

  constructor(privateText: string) { this.text = privateText; }
  private readonly text: string;

  private fail(): never { throw new Error('unsupported or malformed TOML'); }
  private space(lines = false): void {
    for (;;) {
      const c = this.text[this.pos];
      if (c === ' ' || c === '\t' || (lines && (c === '\n' || c === '\r'))) { this.pos += 1; continue; }
      if (lines && c === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }
  private string(): string {
    const quote = this.text[this.pos];
    if (quote !== '"' && quote !== "'") return this.fail();
    if (this.text.slice(this.pos, this.pos + 3) === quote.repeat(3)) return this.fail();
    const start = this.pos++;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos++];
      if (c === quote) {
        const raw = this.text.slice(start, this.pos);
        const value: unknown = quote === '"' ? JSON.parse(raw) : raw.slice(1, -1);
        if (typeof value !== 'string') return this.fail();
        for (const ch of value) {
          const cp = ch.codePointAt(0) as number;
          if (cp >= 0xd800 && cp <= 0xdfff) return this.fail();
        }
        return value;
      }
      if (c === undefined || c === '\n' || c === '\r' || ((c.charCodeAt(0) < 0x20 && c !== '\t') || c.charCodeAt(0) === 0x7f)) return this.fail();
      if (quote === '"' && c === '\\') {
        const escaped = this.text[this.pos++];
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.pos, this.pos + 4))) return this.fail();
          this.pos += 4;
        } else if (escaped === undefined || !'btnfr"\\'.includes(escaped)) return this.fail();
      }
    }
    return this.fail();
  }
  private keys(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.space();
      const c = this.text[this.pos];
      let key: string;
      if (c === '"' || c === "'") key = this.string();
      else {
        const match = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.pos));
        if (match === null) return this.fail();
        key = match[0]; this.pos += key.length;
      }
      parts.push(key);
      if (parts.length > MAX_DEPTH) return this.fail();
      this.space();
      if (this.text[this.pos] !== '.') return parts;
      this.pos += 1;
    }
  }
  private value(depth: number): Value {
    if (++this.values > MAX_VALUES || depth > MAX_DEPTH) return this.fail();
    this.space();
    const c = this.text[this.pos];
    if (c === '"' || c === "'") return this.string();
    if (c === '[') {
      this.pos += 1;
      const out: Value[] = [];
      this.space(true);
      while (this.text[this.pos] !== ']') {
        if (this.pos >= this.text.length) return this.fail();
        out.push(this.value(depth + 1)); this.space(true);
        if (this.text[this.pos] === ']') break;
        if (this.text[this.pos++] !== ',') return this.fail();
        this.space(true);
      }
      this.pos += 1;
      return out;
    }
    const token = /^[^\s,\]#]+/.exec(this.text.slice(this.pos))?.[0];
    if (token === undefined) return this.fail();
    this.pos += token.length;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (!/^[+-]?(?:0|[1-9](?:_?[0-9])*)$/.test(token)) return this.fail();
    const n = Number(token.replaceAll('_', ''));
    if (!Number.isSafeInteger(n)) return this.fail();
    return n;
  }
  private parents(parts: readonly string[]): void {
    if (parts.length > MAX_DEPTH) return this.fail();
    for (let i = 1; i < parts.length; i += 1) {
      const key = JSON.stringify(parts.slice(0, i));
      if (this.namespaces.get(key) === 'value') return this.fail();
      this.namespaces.set(key, 'table');
    }
  }
  read(): boolean {
    while (this.pos < this.text.length) {
      this.space(true);
      if (this.pos === this.text.length) break;
      if (this.text[this.pos] === '[') {
        this.pos += 1;
        const parts = this.keys();
        if (this.text[this.pos++] !== ']') return this.fail();
        this.parents(parts);
        const key = JSON.stringify(parts);
        if (this.explicitTables.has(key) || this.namespaces.get(key) === 'value') return this.fail();
        this.explicitTables.add(key); this.namespaces.set(key, 'table'); this.table = parts;
      } else {
        const keyParts = this.keys();
        // Dotted assignments have additional TOML table-definition semantics;
        // they are outside this supported subset, unlike dotted headers.
        if (keyParts.length !== 1) return this.fail();
        const parts = [...this.table, ...keyParts];
        if (this.text[this.pos++] !== '=') return this.fail();
        this.parents(parts);
        const key = JSON.stringify(parts);
        if (this.namespaces.has(key)) return this.fail();
        this.assignments.set(key, this.value(0)); this.namespaces.set(key, 'value');
      }
      this.space();
      if (this.text[this.pos] === '#') while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      if (this.pos < this.text.length) {
        if (this.text[this.pos] === '\r') this.pos += 1;
        if (this.text[this.pos++] !== '\n') return this.fail();
      }
    }
    const get = (...keys: string[]): Value | undefined => this.assignments.get(JSON.stringify(keys));
    const project = get('project_id');
    const paths = get('db', 'migrations', 'schema_paths');
    return typeof project === 'string' && project.length > 0 &&
      get('db', 'migrations', 'enabled') === true && Array.isArray(paths) && paths.length === 0;
  }
}

export function supportedSupabaseConfig(text: string): boolean {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES || /\r(?!\n)/.test(text)) return false;
  try { return new ConfigReader(text).read(); } catch { return false; }
}

/** Called only for groups discovery reached through ordinary directory entries. */
export async function migrationOrder(
  root: string,
  group: string,
  files: readonly { readonly path: string; readonly absolute: string }[],
  maxFileBytes: number,
): Promise<MigrationOrder> {
  const unknown = (reason: string, candidate = true): MigrationOrder => ({ group, state: 'unknown', candidate, reason });
  if (!/(?:^|\/)supabase\/migrations$/.test(group)) return unknown('no supported framework ordering policy', false);
  const dir = path.resolve(root, ...group.split('/'));
  if (files.some((file) => path.dirname(file.absolute) !== dir)) return unknown('nested migration layout');
  const config = path.join(path.dirname(dir), 'config.toml');
  try {
    const stat = await lstat(config);
    if (!stat.isFile() || stat.isSymbolicLink()) return unknown('configuration is not an ordinary file');
    if (stat.size > Math.min(MAX_CONFIG_BYTES, maxFileBytes)) return unknown('configuration exceeds its source limit');
    const bytes = await readFile(config);
    if (bytes.length > Math.min(MAX_CONFIG_BYTES, maxFileBytes)) return unknown('configuration exceeds its source limit');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!supportedSupabaseConfig(text)) return unknown('unsupported or malformed migration configuration');
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.length > MAX_DIRECTORY_ENTRIES) return unknown('migration directory exceeds its ordering limit');
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const accepted = new Set<string>();
    const versions = new Set<string>();
    for (const [i, entry] of entries.entries()) {
      if (entry.isDirectory()) return unknown('nested migration layout');
      if (entry.isSymbolicLink()) return unknown('symbolic link in migration directory');
      if (!entry.isFile()) return unknown('non-regular migration directory entry');
      const match = /^([0-9]+)_(.*)\.sql$/.exec(entry.name);
      if (match === null) continue;
      const legacy = /([0-9]{14})_init\.sql/.exec(entry.name);
      if (i === 0 && legacy !== null && (legacy[1] as string) < '20211209000000') continue;
      const version = match[1] as string;
      if (versions.has(version)) return unknown('duplicate migration version');
      versions.add(version); accepted.add(`${group}/${entry.name}`);
    }
    // An unread accepted file makes the group incomplete, even if another
    // migration in it was read. Never certify only the observed subset.
    const observed = new Set(files.map((file) => file.path));
    if ([...accepted].some((file) => !observed.has(file))) return unknown('accepted migration was not read');
    return { group, state: 'known', policy: 'supabase-filename-v1', configHash: createHash('sha256').update(bytes).digest('hex'), accepted };
  } catch {
    return unknown('configuration or migration directory could not be read');
  }
}
