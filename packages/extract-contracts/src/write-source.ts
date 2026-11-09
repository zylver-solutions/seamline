// SPDX-License-Identifier: Apache-2.0
/** Bounded source resolution for validated write bindings. Never loads project modules. */
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type * as TS from 'typescript';
import { readCapped } from './safe-fs.ts';
import type { ExtractLimits } from './types.ts';

export class WriteUnknown extends Error {
  readonly sourceRef?: string;
  constructor(code: string, node?: TS.Node) {
    super(code);
    this.name = 'WriteUnknown';
    if (node !== undefined) {
      const file = node.getSourceFile();
      this.sourceRef = `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
    }
  }
}

export interface WriteDeclaration {
  readonly file: TS.SourceFile;
  readonly node: TS.FunctionDeclaration | TS.VariableDeclaration | TS.ClassDeclaration | TS.ExportAssignment;
  readonly name: string;
}

export interface WriteOwner {
  readonly directory: string;
  readonly name: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

export const WRITE_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const SKIP = new Set(['.git', 'node_modules', '.eval-cache', 'eval-out', 'seamline-out']);

export interface WriteInventory {
  readonly files: readonly string[];
  readonly complete: boolean;
  readonly unvouched?: readonly string[];
  readonly explicitAuthorityOnly?: boolean;
}

/** An unread directory or exhausted walk cannot authorize absence beneath it. */
export function writeInventory(repoRoot: string, maxEntries: number): WriteInventory {
  const root = realpathSync(repoRoot);
  const files: string[] = [];
  const unvouched: string[] = [];
  const stack = [root];
  let complete = true;
  let explicitAuthorityOnly = false;
  let entriesSeen = 0;
  const rel = (path: string): string => relative(root, path).split(sep).join('/');
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' }); }
    catch {
      complete = false;
      explicitAuthorityOnly = true;
      unvouched.push(rel(directory));
      continue;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (SKIP.has(entry.name) && entry.isDirectory()) continue;
      if (++entriesSeen > maxEntries) return {
        files: files.sort(), complete: false, unvouched: unvouched.sort(), explicitAuthorityOnly: true,
      };
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // Resolution follows the target, whose executable type need not agree
        // with the link's extension. No skipped link proves caller absence.
        complete = false;
        explicitAuthorityOnly = true;
        unvouched.push(rel(absolute));
      } else if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile()) files.push(rel(absolute));
      else { complete = false; explicitAuthorityOnly = true; unvouched.push(rel(absolute)); }
    }
  }
  return { files: files.sort(), complete, unvouched: unvouched.sort(), explicitAuthorityOnly };
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function unwrap(ts: typeof TS, expression: TS.Expression): TS.Expression {
  let cursor = expression;
  while (ts.isParenthesizedExpression(cursor) || ts.isAsExpression(cursor) ||
         ts.isTypeAssertionExpression(cursor) || ts.isSatisfiesExpression(cursor) || ts.isNonNullExpression(cursor)) cursor = cursor.expression;
  return cursor;
}

export function declaredName(ts: typeof TS, name: TS.PropertyName | TS.BindingName | undefined): string | undefined {
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
}

interface ProofTrace {
  readonly modules: Set<string>;
  readonly resolutions: Map<string, Set<string>>;
  readonly syntax: Set<TS.Node>;
  readonly external: Map<string, number>;
}
type MemoAnswer = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: WriteUnknown };
interface ProofMemo { readonly trace: ProofTrace; readonly answer: MemoAnswer }
interface SourceInput { readonly text: string; readonly bytes: number; source?: TS.SourceFile; document?: Record<string, unknown> }

/** Read/parse results are shared only during one extraction, with bounded retention. */
class SourceInputs {
  readonly values = new Map<string, SourceInput>();
  readonly proofs = new Map<string, ProofMemo>();
  readonly owners = new Map<string, WriteOwner>();
  readonly imports = new Map<string, string | WriteUnknown>();
  bytes = 0;
  get(path: string): SourceInput | undefined {
    const input = this.values.get(path);
    if (input !== undefined) { this.values.delete(path); this.values.set(path, input); }
    return input;
  }
  put(path: string, text: string): SourceInput | undefined {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > 8 * 1024 * 1024) return undefined;
    while (this.values.size >= 2048 || this.bytes + bytes > 8 * 1024 * 1024) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= (this.values.get(oldest) as SourceInput).bytes;
      this.values.delete(oldest);
    }
    const input = { text, bytes };
    this.values.set(path, input); this.bytes += bytes;
    return input;
  }
}

/** One proposal owns its semantic budgets; only immutable source inputs are shared. */
export class WriteSource {
  readonly ts: typeof TS;
  readonly root: string;
  readonly limits: ExtractLimits;
  readonly inventory: readonly string[];
  readonly inventoryComplete: boolean;
  readonly modules = new Map<string, TS.SourceFile>();
  readonly #inputs: SourceInputs;
  readonly #resolutionCounts = new Map<string, Set<string>>();
  readonly #counted = new Set<TS.Node>();
  readonly #traces: ProofTrace[] = [];
  readonly #externalSyntax = new Map<string, number>();
  #syntaxNodes = 0;
  #budgetFailure: WriteUnknown | undefined;

  assertBudget(): void {
    if (this.#budgetFailure !== undefined) throw this.#budgetFailure;
  }
  private refuseBudget(code: string): never {
    this.#budgetFailure ??= new WriteUnknown(code);
    throw this.#budgetFailure;
  }

  exhaustCertificateBudget(): never { return this.refuseBudget('WRITE_EFFECT_CERTIFICATE_CAP'); }

  constructor(ts: typeof TS, repoRoot: string, limits: ExtractLimits,
              inventory?: WriteInventory, sharedInputs?: WriteSource) {
    this.ts = ts;
    this.root = realpathSync(repoRoot);
    this.limits = limits;
    if (sharedInputs !== undefined && (sharedInputs.root !== this.root || sharedInputs.ts !== ts ||
        sharedInputs.limits.maxFileBytes !== limits.maxFileBytes)) throw new Error('incompatible source input cache');
    this.#inputs = sharedInputs === undefined ? new SourceInputs() : sharedInputs.#inputs;
    const found = inventory ?? writeInventory(this.root, limits.maxFiles);
    this.inventory = found.files;
    this.inventoryComplete = found.complete;
  }

  rel(path: string): string {
    const absolute = this.path(this.root, path);
    return relative(this.root, absolute).split(sep).join('/');
  }

  /** Check every existing ancestor, including for absent generated client output. */
  path(fromDirectory: string, target: string): string {
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target) || target.includes('\\'))
      throw new WriteUnknown('WRITE_REMOTE_OR_NON_POSIX_PATH');
    const candidate = resolve(fromDirectory, target);
    if (!inside(this.root, candidate)) throw new WriteUnknown('WRITE_PATH_ESCAPES_ROOT');
    let ancestor = candidate;
    for (;;) {
      try {
        lstatSync(ancestor);
        const real = realpathSync(ancestor);
        if (!inside(this.root, real)) throw new WriteUnknown('WRITE_PATH_ESCAPES_ROOT');
        return resolve(real, relative(ancestor, candidate));
      } catch (error) {
        if (error instanceof WriteUnknown) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new WriteUnknown('WRITE_UNREADABLE_PATH');
        if (ancestor === this.root) throw new WriteUnknown('WRITE_UNREADABLE_PATH');
        ancestor = dirname(ancestor);
      }
    }
  }

  text(path: string): string {
    const absolute = this.path(this.root, path);
    const extension = extname(absolute).toLowerCase();
    if (![...WRITE_SOURCE_EXTENSIONS, '.json', '.yaml', '.yml', '.prisma'].includes(extension))
      throw new WriteUnknown('WRITE_UNDECLARED_READ');
    const known = this.#inputs.get(absolute);
    if (known !== undefined) return known.text;
    const read = readCapped(absolute, this.limits.maxFileBytes);
    if (!read.ok) throw new WriteUnknown(`WRITE_${read.refusal}`);
    this.#inputs.put(absolute, read.text);
    return read.text;
  }

  structured(path: string, parse: (text: string) => Record<string, unknown>): Record<string, unknown> {
    const text = this.text(path);
    const input = this.#inputs.get(this.path(this.root, path));
    const known = input?.document;
    if (known !== undefined) return known;
    const document = parse(text);
    if (input !== undefined) input.document = document;
    return document;
  }

  json(path: string): Record<string, unknown> {
    return this.structured(path, text => {
      try {
        const parsed: unknown = JSON.parse(text);
        if (record(parsed)) return parsed;
      } catch { /* malformed metadata remains unknown */ }
      throw new WriteUnknown('WRITE_INVALID_JSON');
    });
  }

  parse(path: string, cache = true): TS.SourceFile {
    this.assertBudget();
    const rel = this.rel(path);
    if (cache) for (const trace of this.#traces) trace.modules.add(rel);
    const known = this.modules.get(rel);
    if (known !== undefined) return known;
    if (cache && this.modules.size >= 32) this.refuseBudget('WRITE_MODULE_CAP');
    const extension = extname(rel).toLowerCase();
    if (!(WRITE_SOURCE_EXTENSIONS as readonly string[]).includes(extension))
      throw new WriteUnknown('WRITE_NOT_SOURCE');
    const kind = extension === '.tsx' || extension === '.jsx' ? this.ts.ScriptKind.TSX : this.ts.ScriptKind.TS;
    let file: TS.SourceFile;
    try {
      const text = this.text(rel);
      const input = this.#inputs.get(this.path(this.root, rel));
      file = input?.source ?? this.ts.createSourceFile(rel, text, this.ts.ScriptTarget.Latest, true, kind);
      if (input !== undefined) input.source = file;
    } catch {
      throw new WriteUnknown('WRITE_SOURCE_PARSE');
    }
    if ((file as TS.SourceFile & { parseDiagnostics: readonly TS.Diagnostic[] }).parseDiagnostics.length > 0)
      throw new WriteUnknown('WRITE_SOURCE_PARSE');
    if (cache) this.modules.set(rel, file);
    return file;
  }

  chargeSyntax(label: string, amount: number): void {
    this.assertBudget();
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('invalid external syntax charge');
    for (const trace of this.#traces) trace.external.set(label, amount);
    const prior = this.#externalSyntax.get(label);
    if (prior !== undefined) {
      if (prior !== amount) throw new Error('inconsistent external syntax charge');
      return;
    }
    this.#externalSyntax.set(label, amount);
    this.#syntaxNodes += amount;
    if (this.#syntaxNodes > 10_000) this.refuseBudget('WRITE_SYNTAX_CAP');
  }

  count(node: TS.Node): void {
    this.assertBudget();
    for (const trace of this.#traces) trace.syntax.add(node);
    const pending = [node];
    while (pending.length > 0) {
      const next = pending.pop() as TS.Node;
      if (this.#counted.has(next)) continue;
      this.#counted.add(next);
      if (++this.#syntaxNodes > 10_000) this.refuseBudget('WRITE_SYNTAX_CAP');
      this.ts.forEachChild(next, child => { pending.push(child); });
    }
  }

  owner(file: TS.SourceFile): WriteOwner {
    const known = this.#inputs.owners.get(file.fileName);
    if (known !== undefined) return known;
    let directory = dirname(this.path(this.root, file.fileName));
    for (;;) {
      const candidate = this.rel(resolve(directory, 'package.json'));
      if (this.inventory.includes(candidate)) {
        const manifest = this.json(candidate);
        const name = manifest['name'];
        if (typeof name !== 'string' || name.length === 0) throw new WriteUnknown('WRITE_UNNAMED_PACKAGE');
        const owner = { directory, name, manifest };
        if (this.#inputs.owners.size < 2048) this.#inputs.owners.set(file.fileName, owner);
        return owner;
      }
      if (directory === this.root) throw new WriteUnknown('WRITE_PACKAGE_UNKNOWN');
      directory = dirname(directory);
    }
  }

  /** A familiar bare spelling is not external provenance when source config replaces it. */
  assertExternalImport(file: TS.SourceFile, specifier: string): void {
    const owner = this.owner(file);
    if (owner.name === specifier || specifier.startsWith(owner.name + '/')) throw new WriteUnknown('WRITE_LIBRARY_SOURCE_ALIAS');
    const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0] as string;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const dependencies = owner.manifest[section];
      const declared = record(dependencies) ? dependencies[packageName] : undefined;
      // Only ordinary registry versions/ranges or tags identify this package.
      // Paths, bare archives, catalogs and unfamiliar protocols can replace its semantics.
      if (declared !== undefined && (typeof declared !== 'string' ||
          /\.(?:tar(?:\.gz)?|tgz)$/i.test(declared) ||
          !/^(?:[~^<>=v0-9*][0-9A-Za-z.*+<>=~^|\s-]*|[A-Za-z][A-Za-z0-9._-]*)$/.test(declared)))
        throw new WriteUnknown('WRITE_LIBRARY_SOURCE_ALIAS');
    }
    const config = this.resolverConfig(file);
    if (config === undefined) return;
    const options = config['compilerOptions'];
    if (options === undefined) return;
    if (!record(options) || options['moduleSuffixes'] !== undefined || options['rootDirs'] !== undefined)
      throw new WriteUnknown('WRITE_RESOLVER_CUSTOMIZED');
    const paths = options['paths'];
    if (paths !== undefined) {
      if (!record(paths)) throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
      for (const pattern of Object.keys(paths)) {
        const parts = pattern.split('*');
        if (parts.length > 2) throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
        if (parts.length === 1 ? pattern === specifier : specifier.startsWith(parts[0] as string) &&
            specifier.endsWith(parts[1] as string) && specifier.length >= (parts[0] as string).length + (parts[1] as string).length)
          throw new WriteUnknown('WRITE_LIBRARY_SOURCE_ALIAS');
      }
    }
    const baseUrl = options['baseUrl'];
    if (baseUrl !== undefined) {
      if (typeof baseUrl !== 'string') throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
      const base = this.rel(this.path(owner.directory, baseUrl));
      const target = `${base === '' ? '' : base + '/'}${specifier}`;
      if (this.inventory.some(path => path === target || path.startsWith(target + '/') ||
          WRITE_SOURCE_EXTENSIONS.some(extension => path === target + extension)))
        throw new WriteUnknown('WRITE_LIBRARY_SOURCE_ALIAS');
    }
  }

  /** A negative name filter only; it never resolves an import or grants provenance. */
  mayReference(file: TS.SourceFile, specifier: string, roots: readonly string[]): boolean {
    const direct = specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
    this.assertPlainResolver(file);
    // A package entrypoint can redirect a relative directory import. Without
    // proving those maps, do no name filtering in a nested package layout.
    if (this.inventory.some(path => path.toLowerCase() !== 'package.json' && path.toLowerCase().endsWith('/package.json'))) return true;
    let last = specifier.split('/').at(-1) ?? '';
    if (!direct) {
      // A single-target tsconfig alias can also prove a disjoint basename.
      // This checks only metadata, never follows a module or grants lineage.
      // Unresolved or unsupported maps still take the normal refusal path.
      try { last = this.resolveImportPath(file, specifier).split(sep).at(-1) ?? ''; }
      catch (error) {
        if (!(error instanceof WriteUnknown)) throw error;
        return true;
      }
    }
    const base = last.replace(/\.[cm]?[jt]sx?$/i, '').toLowerCase();
    if (['', '.', '..', 'index'].includes(base)) return true;
    return roots.some(root => root.split('/').at(-1)?.toLowerCase() === base);
  }

  private assertPlainResolver(file: TS.SourceFile): void {
    const owner = this.owner(file);
    if (owner.manifest['browser'] !== undefined) throw new WriteUnknown('WRITE_RESOLVER_CUSTOMIZED');
    this.resolverConfig(file);
  }

  /** An absent TypeScript config does not erase the runtime JavaScript fallback. */
  private resolverConfig(file: TS.SourceFile): Record<string, unknown> | undefined {
    const owner = this.owner(file);
    const configs = ['tsconfig.json', 'jsconfig.json'].map(name => this.rel(resolve(owner.directory, name)))
      .filter(path => this.inventory.includes(path)).map(path => this.structured(path, text => {
        const parsed = this.ts.parseConfigFileTextToJson(path, text);
        if (parsed.error !== undefined || !record(parsed.config) || parsed.config['extends'] !== undefined)
          throw new WriteUnknown('WRITE_TSCONFIG_UNKNOWN');
        return parsed.config;
      }));
    for (const config of configs) {
      const options = config['compilerOptions'];
      if (options !== undefined && (!record(options) || options['moduleSuffixes'] !== undefined || options['rootDirs'] !== undefined))
        throw new WriteUnknown('WRITE_RESOLVER_CUSTOMIZED');
    }
    // A single map keeps its existing per-import validation and diagnostics.
    if (configs.length < 2) return configs[0];
    const signature = (config: Record<string, unknown>): string => {
      const options = config['compilerOptions'];
      if (options !== undefined && !record(options)) throw new WriteUnknown('WRITE_RESOLVER_CUSTOMIZED');
      if (record(options) && (options['moduleSuffixes'] !== undefined || options['rootDirs'] !== undefined))
        throw new WriteUnknown('WRITE_RESOLVER_CUSTOMIZED');
      const baseUrl = record(options) ? options['baseUrl'] : undefined;
      if (baseUrl !== undefined && typeof baseUrl !== 'string') throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
      const paths = record(options) ? options['paths'] : undefined;
      if (paths !== undefined && !record(paths)) throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
      const entries = Object.entries(paths ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      for (const [pattern, replacements] of entries)
        if (pattern.split('*').length > 2 || !Array.isArray(replacements) || replacements.length !== 1 ||
            typeof replacements[0] !== 'string' || replacements[0].split('*').length > 2)
          throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
      return JSON.stringify([this.path(owner.directory, baseUrl ?? '.'), entries]);
    };
    const signatures = configs.map(signature);
    if (new Set(signatures).size > 1) throw new WriteUnknown('WRITE_RESOLVER_AMBIGUOUS');
    return configs[0];
  }

  importPath(file: TS.SourceFile, specifier: string): string {
    this.assertPlainResolver(file);
    if (specifier.startsWith('#')) throw new WriteUnknown('WRITE_PACKAGE_IMPORTS_UNSUPPORTED');
    if (specifier.includes('\\') || specifier.startsWith('/') || /^[A-Za-z]:/.test(specifier) ||
        (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) && !specifier.startsWith('node:')))
      throw new WriteUnknown('WRITE_UNSUPPORTED_IMPORT_PATH');
    this.chargeResolution(file.fileName, specifier);
    const key = JSON.stringify([file.fileName, specifier]);
    const known = this.#inputs.imports.get(key);
    if (known instanceof WriteUnknown) throw known;
    if (known !== undefined) return known;
    try {
      const path = this.resolveImportPath(file, specifier);
      if (this.#inputs.imports.size < 8192) this.#inputs.imports.set(key, path);
      return path;
    } catch (error) {
      if (error instanceof WriteUnknown && this.#inputs.imports.size < 8192) this.#inputs.imports.set(key, error);
      throw error;
    }
  }

  private resolveImportPath(file: TS.SourceFile, specifier: string): string {
    const direct = specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
    const owner = this.owner(file);
    let bases: string[];
    if (direct) {
      bases = [this.path(dirname(this.path(this.root, file.fileName)), specifier)];
    } else {
      const config = this.resolverConfig(file);
      if (config === undefined) throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
      const options = config['compilerOptions'];
      if (record(options) && (options['moduleSuffixes'] !== undefined || options['rootDirs'] !== undefined))
        throw new WriteUnknown('WRITE_RESOLVER_CUSTOMIZED');
      if (!record(options) || !record(options['paths'])) throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
      const baseUrl = options['baseUrl'];
      if (baseUrl !== undefined && typeof baseUrl !== 'string') throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
      const base = this.path(owner.directory, baseUrl ?? '.');
      bases = [];
      for (const [pattern, replacements] of Object.entries(options['paths'])) {
        const pieces = pattern.split('*');
        if (pieces.length > 2 || !Array.isArray(replacements) || replacements.length !== 1 ||
            typeof replacements[0] !== 'string') throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
        let middle = '';
        if (pieces.length === 1) {
          if (pattern !== specifier) continue;
        } else {
          const start = pieces[0] as string;
          const end = pieces[1] as string;
          if (!specifier.startsWith(start) || !specifier.endsWith(end) ||
              specifier.length < start.length + end.length) continue;
          middle = specifier.slice(start.length, end.length === 0 ? undefined : -end.length);
        }
        const replacement = replacements[0];
        if (replacement.split('*').length > 2) throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
        bases.push(this.path(base, replacement.replace('*', middle)));
      }
      if (bases.length === 0) throw new WriteUnknown('WRITE_ALIAS_UNKNOWN');
      if (bases.length !== 1) throw new WriteUnknown('WRITE_ALIAS_AMBIGUOUS');
    }
    if (bases.length !== 1) throw new WriteUnknown('WRITE_IMPORT_AMBIGUOUS');
    const base = bases[0] as string;
    if (this.inventory.includes(this.rel(resolve(base, 'package.json')))) throw new WriteUnknown('WRITE_PACKAGE_ENTRYPOINT_UNSUPPORTED');
    return base;
  }

  private chargeResolution(file: string, specifier: string): void {
    this.assertBudget();
    for (const trace of this.#traces) {
      const seen = trace.resolutions.get(file) ?? new Set<string>();
      seen.add(specifier); trace.resolutions.set(file, seen);
    }
    const resolutions = this.#resolutionCounts.get(file) ?? new Set<string>();
    resolutions.add(specifier);
    this.#resolutionCounts.set(file, resolutions);
    if (resolutions.size > 64) this.refuseBudget('WRITE_IMPORT_CAP');
  }

  module(file: TS.SourceFile, specifier: string): TS.SourceFile {
    this.chargeResolution(file.fileName, specifier);
    const base = this.importPath(file, specifier);
    return this.parse(this.moduleFile(base));
  }

  /** Inventory origin only: no imported declaration is followed or certified. */
  inspectedOrigin(file: TS.SourceFile, specifier: string): string {
    this.assertBudget();
    this.assertPlainResolver(file);
    if (specifier.startsWith('#')) throw new WriteUnknown('WRITE_PACKAGE_IMPORTS_UNSUPPORTED');
    if (specifier.includes('\\') || specifier.startsWith('/') || /^[A-Za-z]:/.test(specifier) ||
        (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) && !specifier.startsWith('node:')))
      throw new WriteUnknown('WRITE_UNSUPPORTED_IMPORT_PATH');
    // The complete safety walk visits this file independently. Actual binding
    // traversal still uses module/importPath and retains its own trace charges.
    return this.moduleFile(this.resolveImportPath(file, specifier));
  }

  private moduleFile(base: string): string {
    const extensions = WRITE_SOURCE_EXTENSIONS as readonly string[];
    const suffix = extname(base);
    const candidates = extensions.includes(suffix) ? [base] : [
      ...extensions.map(extension => base + extension),
      ...extensions.map(extension => resolve(base, `index${extension}`)),
    ];
    const existing = candidates.filter(candidate => this.inventory.includes(this.rel(candidate)));
    if (existing.length !== 1) throw new WriteUnknown('WRITE_MODULE_AMBIGUOUS');
    return existing[0] as string;
  }

  /** Reuse a source-world check while charging its full dependencies to this proposal. */
  memoize<T>(key: string, operation: () => T): T {
    this.assertBudget();
    const known = this.#inputs.proofs.get(key);
    if (known !== undefined) {
      for (const path of known.trace.modules) this.parse(path);
      for (const [file, specifiers] of known.trace.resolutions)
        for (const specifier of specifiers) this.chargeResolution(file, specifier);
      for (const [label, amount] of known.trace.external) this.chargeSyntax(label, amount);
      for (const node of known.trace.syntax) this.count(node);
      if (!known.answer.ok) throw known.answer.error;
      return known.answer.value as T;
    }
    const trace: ProofTrace = { modules: new Set(), resolutions: new Map(), syntax: new Set(), external: new Map() };
    this.#traces.push(trace);
    try {
      const value = operation();
      if (this.#inputs.proofs.size < 64) this.#inputs.proofs.set(key, { trace, answer: { ok: true, value } });
      return value;
    } catch (error) {
      // These refusals depend on the proposal's prior work, not source-world state.
      if (error instanceof WriteUnknown && !['WRITE_MODULE_CAP', 'WRITE_IMPORT_CAP', 'WRITE_SYNTAX_CAP', 'WRITE_EFFECT_CERTIFICATE_CAP'].includes(error.message) &&
          this.#inputs.proofs.size < 64) this.#inputs.proofs.set(key, { trace, answer: { ok: false, error } });
      throw error;
    } finally { this.#traces.pop(); }
  }

  /** Resolve only declarations; a familiar spelling alone supplies no provenance. */
  binding(file: TS.SourceFile, name: string, visited = new Set<string>()): WriteDeclaration {
    const key = `${file.fileName}\0${name}`;
    if (visited.has(key)) throw new WriteUnknown('WRITE_BINDING_CYCLE');
    const next = new Set(visited).add(key);
    const matches: WriteDeclaration[] = [];
    for (const statement of file.statements) {
      if (this.ts.isFunctionDeclaration(statement) || this.ts.isClassDeclaration(statement)) {
        if (statement.name?.text === name) matches.push({ file, node: statement, name });
      } else if (this.ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (declaredName(this.ts, declaration.name) !== name) continue;
          if (!(statement.declarationList.flags & this.ts.NodeFlags.Const))
            throw new WriteUnknown('WRITE_MUTABLE_BINDING');
          matches.push({ file, node: declaration, name });
        }
      } else if (this.ts.isImportDeclaration(statement) && statement.importClause !== undefined &&
                 this.ts.isStringLiteral(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        if (clause.isTypeOnly) continue;
        if (clause.name?.text === name) matches.push(this.exported(this.module(file, statement.moduleSpecifier.text), 'default', next));
        const bindings = clause.namedBindings;
        if (bindings !== undefined && this.ts.isNamedImports(bindings)) {
          for (const item of bindings.elements) {
            if (!item.isTypeOnly && item.name.text === name) {
              matches.push(this.exported(this.module(file, statement.moduleSpecifier.text), item.propertyName?.text ?? item.name.text, next));
            }
          }
        }
      }
    }
    if (matches.length !== 1) throw new WriteUnknown('WRITE_BINDING_AMBIGUOUS');
    return matches[0] as WriteDeclaration;
  }

  exported(file: TS.SourceFile, name: string, visited = new Set<string>()): WriteDeclaration {
    const key = `${file.fileName}\0export:${name}`;
    if (visited.has(key)) throw new WriteUnknown('WRITE_EXPORT_CYCLE');
    const next = new Set(visited).add(key);
    const matches: WriteDeclaration[] = [];
    for (const statement of file.statements) {
      if (name === 'default' && this.ts.isExportAssignment(statement) && !statement.isExportEquals) {
        matches.push({ file, node: statement, name: 'default' });
        continue;
      }
      if ((this.ts.isFunctionDeclaration(statement) || this.ts.isClassDeclaration(statement)) &&
          statement.modifiers?.some(m => m.kind === this.ts.SyntaxKind.ExportKeyword)) {
        const isDefault = statement.modifiers.some(m => m.kind === this.ts.SyntaxKind.DefaultKeyword);
        if ((isDefault ? 'default' : statement.name?.text) === name && statement.name !== undefined)
          matches.push({ file, node: statement, name: statement.name.text });
      } else if (this.ts.isVariableStatement(statement) &&
                 statement.modifiers?.some(m => m.kind === this.ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) {
          if (declaredName(this.ts, declaration.name) === name) matches.push(this.binding(file, name, next));
        }
      } else if (this.ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        if (statement.exportClause !== undefined && this.ts.isNamedExports(statement.exportClause)) {
          for (const item of statement.exportClause.elements) {
            if (item.isTypeOnly || item.name.text !== name) continue;
            const original = item.propertyName?.text ?? item.name.text;
            matches.push(statement.moduleSpecifier !== undefined && this.ts.isStringLiteral(statement.moduleSpecifier)
              ? this.exported(this.module(file, statement.moduleSpecifier.text), original, next)
              : this.binding(file, original, next));
          }
        } else if (name !== 'default' && statement.moduleSpecifier !== undefined &&
                   this.ts.isStringLiteral(statement.moduleSpecifier)) {
          // A star export can be absent, but ambiguity, parse and budget failures
          // must not be hidden by trying a more convenient barrel member.
          const module = this.module(file, statement.moduleSpecifier.text);
          try {
            matches.push(this.exported(module, name, next));
          } catch (error) {
            if (!(error instanceof WriteUnknown) || error.message !== 'WRITE_EXPORT_ABSENT') throw error;
          }
        }
      }
    }
    if (matches.length === 0) throw new WriteUnknown('WRITE_EXPORT_ABSENT');
    if (matches.length !== 1) throw new WriteUnknown('WRITE_EXPORT_AMBIGUOUS');
    return matches[0] as WriteDeclaration;
  }
}
