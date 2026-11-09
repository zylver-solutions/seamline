/**
 * Workspace discovery for a repository that has no root `tsconfig.json`.
 *
 * A monorepo commonly keeps one `tsconfig.json` per workspace package and none
 * at the root. Requiring a root file, or a config entry naming the packages,
 * would put a declaration in front of the first run on a repository this tool
 * did not write. So when the root has no `tsconfig.json`, the packages are
 * found the way the package manager finds them: `packages` in
 * `pnpm-workspace.yaml`, and `workspaces` in the root `package.json` (an array,
 * or an object with a `packages` array). Both are read; the union is the
 * workspace.
 *
 * Everything here is offline and deterministic. Nothing is installed, nothing
 * is fetched, and every list it returns is sorted by code unit.
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { ts } from 'ts-morph';
import { OUTSIDE_REPOSITORY, redactPaths, toRepoRelative } from './paths.ts';

export interface WorkspaceConfig {
  /** Human-readable origin of the patterns, for the diagnostic. */
  readonly source: string;
  /** Workspace globs exactly as written, negations (`!glob`) included. */
  readonly patterns: readonly string[];
}

/**
 * The manifest file names a package manager accepts for a workspace package, in
 * the order pnpm tries them: a directory with more than one uses the first.
 */
export const MANIFEST_NAMES = ['package.json', 'package.json5', 'package.yaml'] as const;

export type ManifestName = (typeof MANIFEST_NAMES)[number];

export function isManifestName(name: string): name is ManifestName {
  return (MANIFEST_NAMES as readonly string[]).includes(name);
}

export interface WorkspacePackage {
  /** Repo-relative POSIX directory. */
  readonly dir: string;
  /** The manifest file that makes the directory a package. */
  readonly manifest: ManifestName;
  /**
   * The `name` in its `package.json`, when it has a non-empty one. Always `null`
   * for `package.json5` and `package.yaml`: this package takes no parser for
   * either, so the name of such a package is not known.
   */
  readonly name: string | null;
  /** Absolute path of the package's own `tsconfig.json`, or `null` when it has none. */
  readonly tsconfig: string | null;
}

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/* ----------------------------------------------------------- reading patterns */

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1] as string))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function unquote(item: string): string {
  const t = item.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0])
    return t.slice(1, -1);
  return t;
}

/** Splits a flow sequence body on commas that are outside quotes. */
function splitFlow(body: string): string[] {
  const items: string[] = [];
  let quote: string | null = null;
  let current = '';
  for (const ch of body) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map(unquote).filter((s) => s.length > 0);
}

/**
 * The top-level `packages` list of a `pnpm-workspace.yaml`, without a YAML
 * parser (this package takes no new dependency for one list of strings).
 * Understands a block sequence and a flow sequence, quoted or bare items, and
 * comments. `null` when the key is absent or not a list of strings, which the
 * caller reports and treats as no pnpm workspace.
 */
export function parsePnpmWorkspacePackages(text: string): readonly string[] | null {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^packages\s*:/.test(l));
  if (at < 0) return null;
  const rest = stripComment((lines[at] as string).replace(/^packages\s*:/, '')).trim();

  if (rest.startsWith('[')) {
    let body = rest;
    let next = at + 1;
    while (!body.includes(']') && next < lines.length) {
      body += ` ${stripComment(lines[next] as string).trim()}`;
      next += 1;
    }
    const close = body.indexOf(']');
    if (close < 0) return null;
    return splitFlow(body.slice(1, close));
  }
  if (rest.length > 0) return null;

  const items: string[] = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = stripComment(lines[i] as string);
    if (line.trim().length === 0) continue;
    const m = /^\s*-\s+(.*)$/.exec(line);
    if (m === null) break;
    const item = unquote(m[1] as string);
    if (item.length > 0) items.push(item);
  }
  return items;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : null;
}

/**
 * The workspace patterns of the repository root, or `null` when it declares
 * none. A declaration that cannot be read is reported and counts as none.
 */
export function readWorkspaceConfig(
  repoRoot: string,
  diagnostics: string[],
): WorkspaceConfig | null {
  const sources: string[] = [];
  const patterns: string[] = [];

  const pnpmFile = nodePath.join(repoRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmFile)) {
    let listed: readonly string[] | null = null;
    try {
      listed = parsePnpmWorkspacePackages(fs.readFileSync(pnpmFile, 'utf8'));
    } catch {
      listed = null;
    }
    if (listed === null) {
      diagnostics.push('pnpm-workspace.yaml has no readable `packages` list');
    } else {
      sources.push('pnpm-workspace.yaml');
      patterns.push(...listed);
    }
  }

  const manifestFile = nodePath.join(repoRoot, 'package.json');
  if (fs.existsSync(manifestFile)) {
    const parsed = readJson(manifestFile) as { workspaces?: unknown } | undefined;
    const field = parsed?.workspaces;
    const listed =
      stringList(field) ??
      stringList((field as { packages?: unknown } | null | undefined)?.packages);
    if (listed !== null) {
      sources.push('package.json workspaces');
      patterns.push(...listed);
    } else if (field !== undefined) {
      diagnostics.push('package.json `workspaces` is not a list of globs and was ignored');
    }
  }

  if (sources.length === 0) return null;
  return { source: sources.join(' and '), patterns };
}

/* -------------------------------------------------------------- glob matching */

/** Longest workspace pattern read; a longer one is reported and counts as incomplete. */
const MAX_PATTERN_LENGTH = 256;
/** Most path segments a pattern may have, after consecutive `**` are collapsed. */
const MAX_PATTERN_SEGMENTS = 24;
/** Most alternatives one segment may expand to through `{a,b}` groups. */
const MAX_SEGMENT_ALTERNATIVES = 32;

/** A segment of a compiled pattern: `**`, or the wildcard alternatives one directory name may match. */
type PatternSegment = '**' | readonly string[];

type CompiledPattern =
  | { readonly kind: 'ok'; readonly segments: readonly PatternSegment[] }
  /** Leaves the repository (`..`, absolute): it can name no package of this repository. */
  | { readonly kind: 'outside' }
  /** Uses syntax this matcher does not implement, or is too large to match safely. */
  | { readonly kind: 'unsupported'; readonly why: string };

/**
 * `{a,b}` groups in one segment expanded into the alternatives they stand for,
 * or the reason they cannot be: an unclosed or stray brace (a group that spans a
 * `/` ends up unclosed in its segment), nested braces, or too many alternatives.
 */
function expandBraces(segment: string): readonly string[] | string {
  let alternatives: string[] = [''];
  let i = 0;
  while (i < segment.length) {
    const ch = segment[i] as string;
    if (ch === '}') return 'a `}` with no `{`';
    if (ch !== '{') {
      alternatives = alternatives.map((a) => a + ch);
      i += 1;
      continue;
    }
    const close = segment.indexOf('}', i);
    if (close < 0)
      return 'a `{` that is never closed in its path segment (a brace group cannot contain `/`)';
    const body = segment.slice(i + 1, close);
    if (body.includes('{')) return 'nested braces';
    const choices = body.split(',');
    if (alternatives.length * choices.length > MAX_SEGMENT_ALTERNATIVES)
      return 'too many brace alternatives';
    alternatives = alternatives.flatMap((a) => choices.map((c) => a + c));
    i = close + 1;
  }
  return alternatives;
}

/** A character class, an extglob group, or an escape: syntax a workspace glob may use that this matcher does not implement. */
function unsupportedSyntax(segment: string): string | null {
  if (segment.includes('[')) return 'a character class `[...]`';
  if (segment.includes('\\')) return 'a backslash escape';
  if (/[?*+@!]\(/.test(segment)) return 'an extglob group';
  return null;
}

/**
 * A workspace glob as segments a directory can be matched against. `*` stays
 * inside one path segment, `**` crosses segments, `?` is one character, and
 * `{a,b}` is a choice. A leading `./`, a trailing `/`, and a trailing
 * `/package.json` are dropped, and consecutive `**` collapse into one (they
 * match what one does). Syntax this matcher does not implement is reported, not
 * guessed at: a pattern that silently matched nothing would hide packages.
 */
function compileDirectoryPattern(pattern: string): CompiledPattern {
  const normalized = pattern
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/package\.json$/, '')
    .replace(/\/+$/, '');
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.split('/').includes('..'))
    return { kind: 'outside' };
  if (normalized.length > MAX_PATTERN_LENGTH)
    return { kind: 'unsupported', why: `longer than ${MAX_PATTERN_LENGTH} characters` };

  const raw = normalized.split('/').filter((s, i, all) => !(s === '**' && all[i - 1] === '**'));
  if (raw.length > MAX_PATTERN_SEGMENTS)
    return { kind: 'unsupported', why: `more than ${MAX_PATTERN_SEGMENTS} path segments` };

  const segments: PatternSegment[] = [];
  for (const segment of raw) {
    if (segment === '**') {
      segments.push('**');
      continue;
    }
    const bad = unsupportedSyntax(segment);
    if (bad !== null) return { kind: 'unsupported', why: bad };
    const expanded = expandBraces(segment);
    if (typeof expanded === 'string') return { kind: 'unsupported', why: expanded };
    segments.push(expanded);
  }
  return { kind: 'ok', segments };
}

/** `*` and `?` over one path segment, in time proportional to the product of the lengths (no backtracking blow-up). */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starAt = -1;
  let starText = 0;
  while (t < text.length) {
    const pc = pattern[p];
    if (pc === '*') {
      starAt = p;
      starText = t;
      p += 1;
    } else if (p < pattern.length && (pc === '?' || pc === text[t])) {
      p += 1;
      t += 1;
    } else if (starAt >= 0) {
      p = starAt + 1;
      starText += 1;
      t = starText;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** Whether the directory's segments match the compiled pattern; memoized, so `**` cannot multiply work. */
function matchesPattern(segments: readonly PatternSegment[], dir: string): boolean {
  const parts = dir.split('/');
  const memo = new Map<number, boolean>();
  const walk = (pi: number, ti: number): boolean => {
    const key = pi * (parts.length + 1) + ti;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    const segment = segments[pi];
    if (segment === undefined) {
      result = ti === parts.length;
    } else if (segment === '**') {
      // `**` may match no segment at all, a trailing one included: the package
      // managers match `<pattern>/package.json`, so `packages/**` also names
      // `packages` itself, `packages/*/**` names `packages/a`, and `!**/test/**`
      // leaves out `a/test`.
      if (pi === segments.length - 1) {
        result = true;
      } else {
        result = false;
        for (let k = ti; k <= parts.length && !result; k += 1) result = walk(pi + 1, k);
      }
    } else {
      const part = parts[ti];
      result =
        part !== undefined &&
        segment.some((alt) => wildcardMatch(alt, part)) &&
        walk(pi + 1, ti + 1);
    }
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/** Most characters of one workspace pattern that reach a diagnostic or the `Repo` node. */
const MAX_SHOWN_PATTERN = 80;

/**
 * A workspace pattern as it may be written to a diagnostic or a node prop: the
 * first `MAX_SHOWN_PATTERN` characters and the number left out. The pattern comes
 * from a file of the repository and has no length of its own, while the output
 * that names it is persisted and compared byte for byte.
 */
export function shownPattern(pattern: string): string {
  const chars = [...pattern];
  if (chars.length <= MAX_SHOWN_PATTERN) return pattern;
  return `${chars.slice(0, MAX_SHOWN_PATTERN).join('')}... (${chars.length - MAX_SHOWN_PATTERN} more characters)`;
}

export interface WorkspaceMatch {
  /** Directories matched by a positive pattern and by no `!` pattern, in input order. */
  readonly dirs: readonly string[];
  /**
   * Positive patterns the matcher cannot evaluate, one entry per distinct pattern
   * and each as `shownPattern` writes it. Packages they name are never
   * discovered, so they are neither read nor listed as unread: the workspace is
   * known to be incomplete, which is what the caller must carry forward.
   */
  readonly incompletePatterns: readonly string[];
}

export function matchWorkspaceDirs(
  patterns: readonly string[],
  dirs: readonly string[],
  diagnostics: string[],
): WorkspaceMatch {
  const positive: Array<readonly PatternSegment[]> = [];
  const negative: Array<readonly PatternSegment[]> = [];
  const incomplete = new Set<string>();
  for (const raw of patterns) {
    const negated = raw.trim().startsWith('!');
    const written = negated ? raw.trim().slice(1) : raw;
    const compiled = compileDirectoryPattern(written);
    if (compiled.kind === 'outside') {
      diagnostics.push(`workspace pattern ignored: ${shownPattern(raw)}`);
    } else if (compiled.kind === 'unsupported') {
      diagnostics.push(
        negated
          ? `workspace pattern not supported (${compiled.why}): ${shownPattern(raw)}; a package it excludes may be read`
          : `workspace pattern not supported (${compiled.why}): ${shownPattern(raw)}; packages it names are not discovered`,
      );
      if (!negated) incomplete.add(raw.trim());
    } else {
      (negated ? negative : positive).push(compiled.segments);
    }
  }
  return {
    dirs: dirs.filter(
      (dir) =>
        positive.some((p) => matchesPattern(p, dir)) &&
        !negative.some((n) => matchesPattern(n, dir)),
    ),
    incompletePatterns: [...incomplete].sort(compareCodeUnits).map(shownPattern),
  };
}

/* ------------------------------------------------------------- the packages */

export interface DiscoveredPackages {
  readonly packages: readonly WorkspacePackage[];
  /** See `WorkspaceMatch.incompletePatterns`. */
  readonly incompletePatterns: readonly string[];
}

/**
 * The workspace packages: directories holding a manifest (`package.json`,
 * `package.json5` or `package.yaml`, as pnpm accepts all three) that the
 * workspace patterns match. `manifests` and `configs` are the absolute paths of
 * every manifest and `tsconfig.json` the repository walk found, so a package
 * under `node_modules` or a dot-directory is never a workspace package. A
 * directory with several manifests is a package of the first in `MANIFEST_NAMES`.
 */
export function discoverWorkspacePackages(
  repoRoot: string,
  config: WorkspaceConfig,
  manifests: readonly string[],
  configs: readonly string[],
  diagnostics: string[],
): DiscoveredPackages {
  const dirOf = (file: string): string =>
    nodePath.relative(repoRoot, nodePath.dirname(file)).split(nodePath.sep).join('/');
  const tsconfigByDir = new Map<string, string>();
  for (const file of configs) tsconfigByDir.set(dirOf(file), file);

  const manifestByDir = new Map<string, ManifestName>();
  for (const file of manifests) {
    const base = nodePath.basename(file);
    if (!isManifestName(base)) continue;
    const dir = dirOf(file);
    const known = manifestByDir.get(dir);
    if (known === undefined || MANIFEST_NAMES.indexOf(base) < MANIFEST_NAMES.indexOf(known))
      manifestByDir.set(dir, base);
  }
  const candidateDirs = [...manifestByDir.keys()].filter((d) => d !== '').sort(compareCodeUnits);
  const matched = matchWorkspaceDirs(config.patterns, candidateDirs, diagnostics);

  const packages = matched.dirs.map((dir): WorkspacePackage => {
    const manifest = manifestByDir.get(dir) ?? 'package.json';
    const parsed =
      manifest === 'package.json'
        ? (readJson(nodePath.join(repoRoot, dir, manifest)) as { name?: unknown } | undefined)
        : undefined;
    const name = typeof parsed?.name === 'string' && parsed.name.length > 0 ? parsed.name : null;
    return { dir, manifest, name, tsconfig: tsconfigByDir.get(dir) ?? null };
  });
  return { packages, incompletePatterns: matched.incompletePatterns };
}

/* ----------------------------------------------------- offline `extends` host */

/**
 * `node_modules/<workspace package name>/...` mapped onto the workspace
 * package's own directory.
 *
 * A fresh clone has no `node_modules`, so a tsconfig that extends a sibling
 * package (`"extends": "@acme/tsconfig/base.json"`) cannot resolve through the
 * file system, though the package is in the repository. Installing the
 * dependencies would link exactly this directory; this answers the same
 * lookups without it. A real `node_modules` entry always wins, and a name that
 * is not a workspace package (an external base such as `expo/tsconfig.base`)
 * is not mapped and stays unresolved.
 *
 * Nothing outside the repository is read: a file there does not exist as far as
 * this host is concerned. Its content would differ between machines, so a
 * config that depends on it cannot be read reproducibly, and it is reported as
 * a base that is not there.
 */
export function workspaceConfigHost(
  repoRoot: string,
  packages: readonly WorkspacePackage[],
  readDirectory: ts.ParseConfigFileHost['readDirectory'],
): ts.ParseConfigFileHost {
  const dirByName = new Map<string, string>();
  for (const p of packages)
    if (p.name !== null && !dirByName.has(p.name)) dirByName.set(p.name, p.dir);

  const inside = (file: string): boolean => toRepoRelative(repoRoot, file) !== null;
  const marker = '/node_modules/';
  const remap = (file: string): string | undefined => {
    const at = file.lastIndexOf(marker);
    if (at < 0) return undefined;
    const parts = file.slice(at + marker.length).split('/');
    const nameParts = (parts[0] as string).startsWith('@') ? 2 : 1;
    const dir = dirByName.get(parts.slice(0, nameParts).join('/'));
    if (dir === undefined) return undefined;
    return nodePath.join(repoRoot, dir, ...parts.slice(nameParts));
  };

  return {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (file) => {
      if (!inside(file)) return false;
      if (ts.sys.fileExists(file)) return true;
      const mapped = remap(file);
      return mapped !== undefined && ts.sys.fileExists(mapped);
    },
    readFile: (file) => {
      if (!inside(file)) return undefined;
      const real = ts.sys.readFile(file);
      if (real !== undefined) return real;
      const mapped = remap(file);
      return mapped === undefined ? undefined : ts.sys.readFile(mapped);
    },
    getCurrentDirectory: () => repoRoot,
    readDirectory,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  };
}

/* ------------------------------------------------------------ parsing a unit */

/** A tsconfig the extractor builds one program from. */
export interface WorkspaceUnit {
  /** Absolute. */
  readonly configPath: string;
  readonly parsed: ts.ParsedCommandLine;
}

export type UnitParse =
  | {
      readonly ok: true;
      readonly unit: WorkspaceUnit;
      /** `extends` specifiers that resolved to nothing and were tolerated (see `parseUnit`). */
      readonly unresolvedBases: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** `File 'x' not found.`: raised for an `extends` that resolves to nothing. */
const FILE_NOT_FOUND = 6053;

/**
 * `The 'files' list in config file is empty` and `No inputs were found in config
 * file`: the config resolves no files. That is a fact about the package (the
 * caller reports it as one whose tsconfig includes none of its files, or follows
 * its `references`), not a doubt about what the config means.
 */
const RESOLVES_NO_FILES: ReadonlySet<number> = new Set([18002, 18003]);

/**
 * The specifier of an `extends` that names a package (`@tsconfig/node22/tsconfig.json`,
 * `expo/tsconfig.base`) and found nothing; `null` for any other error. A
 * relative `extends` is reported with its leading dot, so only a bare specifier
 * is a package that is not installed.
 */
function unresolvedPackageBase(d: ts.Diagnostic): string | null {
  if (d.code !== FILE_NOT_FOUND) return null;
  const m = /^File '(.*)' not found\.$/.exec(ts.flattenDiagnosticMessageText(d.messageText, ' '));
  const specifier = m?.[1];
  if (
    specifier === undefined ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    /^[A-Za-z]:/.test(specifier)
  ) {
    return null;
  }
  return specifier;
}

/**
 * Whether `host` answers for a base named `specifier` with `content`, wherever
 * module resolution looks for it (`node_modules/<specifier>.json`,
 * `node_modules/<specifier>`, `node_modules/<specifier>/tsconfig.json`).
 */
function hostWithBase(
  host: ts.ParseConfigFileHost,
  specifiers: readonly string[],
  content: string,
): ts.ParseConfigFileHost {
  const marker = '/node_modules/';
  const isBase = (file: string): boolean => {
    const at = file.lastIndexOf(marker);
    if (at < 0) return false;
    const tail = file.slice(at + marker.length);
    return specifiers.some(
      (s) => tail === s || tail === `${s}.json` || tail === `${s}/tsconfig.json`,
    );
  };
  return {
    ...host,
    readDirectory: () => [],
    fileExists: (file) => isBase(file) || host.fileExists(file),
    readFile: (file) => (isBase(file) ? content : host.readFile(file)),
  };
}

/** Whether null checks are on under `options`, as the checker decides it. */
function nullChecksOn(options: ts.CompilerOptions): boolean {
  return options.strictNullChecks !== undefined
    ? options.strictNullChecks
    : options.strict === true;
}

/**
 * Whether what the readable part of the config says about null checking holds
 * whatever the packages it extends and could not be found say.
 *
 * A base that is missing is probed with stand-ins that say the opposite things,
 * placed exactly where the real one would sit in the `extends` order, and the
 * answer is trusted when the stand-ins cannot change it:
 *
 * - an explicit `strictNullChecks` that nothing missing can override (set in the
 *   config itself, or in a base listed after the missing one): the answer is
 *   settled, whatever its value;
 * - otherwise `strict: true` set the same way, with no explicit
 *   `strictNullChecks` anywhere readable (a missing base could still set that
 *   one option to false; it is the residual this rule accepts, because
 *   presets that do so are rare and refusing every preset would leave a fresh
 *   clone with almost nothing readable).
 *
 * Not trusted: `strict: false` (a missing base could set `strictNullChecks:
 * true`, which flips what is optional), nothing set at all, and a setting that
 * a base listed after the missing one overrides.
 */
function nullChecksSettled(
  configPath: string,
  specifiers: readonly string[],
  host: ts.ParseConfigFileHost,
  readable: ts.CompilerOptions,
): boolean {
  const optionsWith = (compilerOptions: Record<string, boolean>): ts.CompilerOptions | undefined =>
    ts.getParsedCommandLineOfConfigFile(
      configPath,
      undefined,
      hostWithBase(host, specifiers, JSON.stringify({ compilerOptions })),
    )?.options;
  const strictest = optionsWith({ strict: true, strictNullChecks: true });
  const laxest = optionsWith({ strict: false, strictNullChecks: false });
  if (
    strictest !== undefined &&
    laxest !== undefined &&
    nullChecksOn(strictest) === nullChecksOn(laxest)
  )
    return true;
  if (readable.strictNullChecks !== undefined) return false;
  const strictBase = optionsWith({ strict: true });
  const laxBase = optionsWith({ strict: false });
  return (
    strictBase !== undefined &&
    laxBase !== undefined &&
    nullChecksOn(strictBase) &&
    nullChecksOn(laxBase)
  );
}

/**
 * Parses one tsconfig the way the TypeScript API does, with `extends` resolved
 * through `host`, and decides whether the result can be trusted.
 *
 * Not trusted, so not read: any error TypeScript reports on the config. That is
 * a syntax error in the config itself (TypeScript recovers from one and goes on
 * to report the options it managed to read, which would be wrong rather than
 * absent), a syntax error in a base, an unreadable file, circular `extends`, a
 * relative `extends` that is not there, an unknown option, an option given a
 * value of the wrong type or outside its choices (`"strict": "yes"`), and a
 * `files` entry that is not there. Also not trusted: a package `extends` that
 * is not installed (and not a workspace package) when what the readable part of
 * the config says about null checking does not settle it (`nullChecksSettled`),
 * because the missing base could change what the checker reports as nullable.
 *
 * Trusted: a package `extends` that is not installed when the readable part of
 * the chain settles null checking itself. The config is then read with the
 * options that could be resolved (an options-only base such as
 * `@tsconfig/node22` contributes `lib`, `module` and the like, which affect how
 * much resolves, not what is nullable), and the specifiers are returned so the
 * caller can say so.
 *
 * Every message has absolute paths removed, so none reaches a diagnostic.
 */
export function parseUnit(
  configPath: string,
  repoRoot: string,
  host: ts.ParseConfigFileHost,
): UnitParse {
  let fatal: string | undefined;
  const describe = (d: ts.Diagnostic): string => {
    const text = redactPaths(repoRoot, ts.flattenDiagnosticMessageText(d.messageText, ' '));
    if (d.file === undefined || d.start === undefined) return text;
    const line = d.file.getLineAndCharacterOfPosition(d.start).line + 1;
    const rel = toRepoRelative(repoRoot, d.file.fileName) ?? OUTSIDE_REPOSITORY;
    return `${rel}:${line}: ${text}`;
  };

  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...host,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      fatal = describe(d);
    },
  });
  if (parsed === undefined) return { ok: false, reason: fatal ?? 'the tsconfig could not be read' };

  // The config's own syntax errors are on its source file, not in `parsed.errors`.
  const errors = ts
    .getConfigFileParsingDiagnostics(parsed)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  const unresolved = new Set<string>();
  const blocking: string[] = [];
  for (const d of errors) {
    const base = unresolvedPackageBase(d);
    if (base !== null) unresolved.add(base);
    else if (!RESOLVES_NO_FILES.has(d.code)) blocking.push(describe(d));
  }
  blocking.push(...missingFiles(configPath, repoRoot, parsed, host));
  if (
    unresolved.size > 0 &&
    !nullChecksSettled(configPath, [...unresolved], host, parsed.options)
  ) {
    blocking.push(
      `extends ${[...unresolved]
        .sort(compareCodeUnits)
        .map((s) => `"${s}"`)
        .join(', ')} cannot be resolved ` +
        'and nothing readable settles null checking over it (`strict: true` set after the base, or an explicit `strictNullChecks`), ' +
        'so what is nullable cannot be known',
    );
  }
  if (blocking.length > 0)
    return { ok: false, reason: [...new Set(blocking)].sort(compareCodeUnits).join('; ') };
  return {
    ok: true,
    unit: { configPath: nodePath.resolve(configPath), parsed },
    unresolvedBases: [...unresolved].sort(compareCodeUnits),
  };
}

/**
 * `files` entries that are not there. TypeScript reports a missing `files` entry
 * when a program is created, not when the config is parsed, and a program built
 * without it would silently lack the file the config names. An entry outside the
 * repository is reported too: it cannot be read, so whether it exists is not
 * something this run can say.
 */
function missingFiles(
  configPath: string,
  repoRoot: string,
  parsed: ts.ParsedCommandLine,
  host: ts.ParseConfigFileHost,
): string[] {
  const files = (parsed.raw as { files?: unknown } | undefined)?.files;
  if (!Array.isArray(files)) return [];
  const out: string[] = [];
  for (const entry of files) {
    if (typeof entry !== 'string') continue;
    const absolute = nodePath.resolve(nodePath.dirname(configPath), entry);
    const rel = toRepoRelative(repoRoot, absolute);
    if (rel === null) out.push(`'files' entry is outside the repository: ${OUTSIDE_REPOSITORY}`);
    else if (!host.fileExists(absolute)) out.push(`'files' entry is not there: ${rel}`);
  }
  return out;
}
