/**
 * Packages and the source universe (design 5.3).
 *
 * Package discovery reads the workspace file with a small line reader (no YAML
 * library) and the manifests it finds. Discovery is either complete or it is
 * not: a manifest that does not parse, or a workspace entry the reader does not
 * support, can hide a whole package (a `bin` package, a dependent, an
 * extractor), so every `ABSENT` that needs discovery turns into
 * `UNKNOWN(manifest-unparseable)` when it is incomplete.
 */

import { readText, type Tree } from './tree.ts';
import { basename, compareCodeUnits, dirname, extname, joinPosix, uniqueSorted } from './util.ts';

export const SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];
/** The closed list of other languages whose presence in a package withholds absence (5.3). */
export const OTHER_LANGUAGE_EXTENSIONS: readonly string[] = [
  '.go',
  '.rs',
  '.py',
  '.rb',
  '.java',
  '.kt',
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.swift',
  '.zig',
];

export type Manifest = Record<string, unknown>;

export interface Pkg {
  readonly dir: string;
  readonly name: string;
  readonly manifest: Manifest;
}

export interface Discovery {
  readonly packages: readonly Pkg[];
  /** True when a manifest does not parse, or the workspace file holds something the reader does not support. */
  readonly incomplete: boolean;
  readonly incompleteDetail: string;
}

export function isDeclarationFile(path: string): boolean {
  return /\.d\.[cm]?ts$/.test(path);
}

/** A test, by path (4.4): `*.test.*`, `*.spec.*`, or under `__fixtures__/` or `__tests__/`. */
export function isTestPath(path: string): boolean {
  const base = basename(path);
  if (/\.(?:test|spec)\./.test(base)) return true;
  const slashed = `/${path}`;
  return slashed.includes('/__fixtures__/') || slashed.includes('/__tests__/');
}

export function isSourceExtension(path: string): boolean {
  return SOURCE_EXTENSIONS.includes(extname(path));
}

// ---------------------------------------------------------------------------
// JSON with comments (tsconfig)
// ---------------------------------------------------------------------------

/** Parse JSON that may carry `//` and `/* *\/` comments and trailing commas; `undefined` when it does not parse. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}

export function parseManifest(text: string | null): Manifest | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Manifest)
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// The workspace file reader
// ---------------------------------------------------------------------------

const ENTRY_SEGMENT = /^(?:\*|[A-Za-z0-9._@-]+)$/;

export interface WorkspaceRead {
  readonly entries: readonly string[];
  readonly unsupported: readonly string[];
  readonly unreadable: boolean;
  readonly hasPackagesKey: boolean;
}

/** Read `pnpm-workspace.yaml`: only the block sequence under the top-level `packages:` key (5.3). */
export function readWorkspaceFile(text: string): WorkspaceRead {
  const entries: string[] = [];
  const unsupported: string[] = [];
  let unreadable = false;
  let hasPackagesKey = false;
  let key: string | null = null;
  for (const line of text.split('\n')) {
    const content = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (content.trim() === '' || content.trim().startsWith('#')) continue;
    if (/^\s*\t/.test(content)) {
      unreadable = true;
      continue;
    }
    const column0 = !/^\s/.test(content);
    if (column0) {
      const top = /^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/.exec(content);
      if (top !== null) {
        key = top[1] ?? null;
        if (key === 'packages') {
          hasPackagesKey = true;
          if ((top[2] ?? '').trim() !== '') unsupported.push(content.trim());
        }
        continue;
      }
      if (!(content.startsWith('- ') || content === '-') || key === null) {
        unreadable = true;
        continue;
      }
    } else if (key !== 'packages') {
      continue;
    }
    if (key !== 'packages') continue;
    const item = /^\s*-\s+(.*?)\s*$/.exec(content);
    if (item === null) {
      unreadable = true;
      continue;
    }
    const scalar = item[1] ?? '';
    const quoted = /^'([^']*)'$/.exec(scalar) ?? /^"([^"]*)"$/.exec(scalar);
    const value = quoted !== null ? (quoted[1] ?? '') : scalar;
    const plainOk = quoted !== null || /^[A-Za-z0-9._@/*-]+$/.test(scalar);
    if (!plainOk || value === '' || !value.split('/').every((seg) => ENTRY_SEGMENT.test(seg))) {
      unsupported.push(scalar);
      continue;
    }
    entries.push(value);
  }
  return { entries, unsupported, unreadable, hasPackagesKey };
}

function entryMatches(entry: string, dir: string): boolean {
  const e = entry.split('/');
  const d = dir.split('/');
  return e.length === d.length && e.every((seg, i) => seg === '*' || seg === d[i]);
}

export function discoverPackages(tree: Tree): Discovery {
  let incomplete = false;
  const details: string[] = [];
  const flag = (detail: string): void => {
    incomplete = true;
    details.push(detail);
  };

  const rootText = tree.tracked.includes('package.json') ? readText(tree, 'package.json') : null;
  const rootManifest = parseManifest(rootText);
  if (tree.tracked.includes('package.json') && rootManifest === null)
    flag('package.json does not parse');

  let entries: string[] = [];
  let usedWorkspaceFile = false;
  if (tree.tracked.includes('pnpm-workspace.yaml')) {
    const text = readText(tree, 'pnpm-workspace.yaml');
    if (text === null) {
      flag('pnpm-workspace.yaml cannot be read');
    } else {
      const read = readWorkspaceFile(text);
      if (read.unreadable) flag('pnpm-workspace.yaml holds a line the reader does not support');
      for (const u of read.unsupported)
        flag(`pnpm-workspace.yaml holds an unsupported entry: ${u}`);
      if (read.hasPackagesKey) {
        usedWorkspaceFile = true;
        entries = [...read.entries];
      }
    }
  }
  if (!usedWorkspaceFile && rootManifest !== null && rootManifest['workspaces'] !== undefined) {
    const workspaces = rootManifest['workspaces'];
    if (!Array.isArray(workspaces)) {
      flag('package.json workspaces is not an array');
    } else {
      for (const w of workspaces) {
        if (typeof w === 'string' && w.split('/').every((seg) => ENTRY_SEGMENT.test(seg)))
          entries.push(w);
        else flag(`package.json workspaces holds an unsupported entry: ${String(w)}`);
      }
    }
  }

  const candidateDirs = new Set<string>();
  for (const path of tree.tracked) {
    if (basename(path) !== 'package.json') continue;
    const dir = dirname(path);
    if (dir === '.') continue;
    if (entries.some((entry) => entryMatches(entry, dir))) candidateDirs.add(dir);
  }
  const packages: Pkg[] = [];
  for (const dir of [...candidateDirs].sort(compareCodeUnits)) {
    const manifest = parseManifest(readText(tree, `${dir}/package.json`));
    if (manifest === null) {
      flag(`${dir}/package.json does not parse`);
      continue;
    }
    if (typeof manifest['name'] === 'string' && manifest['name'] !== '') {
      packages.push({ dir, name: manifest['name'], manifest });
    }
  }
  if (rootManifest !== null && rootManifest['bin'] !== undefined) {
    packages.push({
      dir: '.',
      name: typeof rootManifest['name'] === 'string' ? rootManifest['name'] : '.',
      manifest: rootManifest,
    });
  }
  return { packages, incomplete, incompleteDetail: details.join('; ') };
}

// ---------------------------------------------------------------------------
// Package facts
// ---------------------------------------------------------------------------

export function dependencyNames(pkg: Pkg, includeDev: boolean): string[] {
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  if (includeDev) sections.push('devDependencies');
  return uniqueSorted(sections.flatMap((s) => Object.keys(record(pkg.manifest[s]))));
}

/** The other discovered packages that list `pkg` in dependencies, optionalDependencies or peerDependencies. */
export function dependentsOf(discovery: Discovery, pkg: Pkg): Pkg[] {
  return discovery.packages.filter(
    (other) => other !== pkg && dependencyNames(other, false).includes(pkg.name),
  );
}

/** The discovered package whose directory most deeply contains `file`. */
export function ownerOf(discovery: Discovery, file: string): Pkg | null {
  let best: Pkg | null = null;
  for (const pkg of discovery.packages) {
    const within = pkg.dir === '.' || file === pkg.dir || file.startsWith(`${pkg.dir}/`);
    if (within && (best === null || pkg.dir.length > best.dir.length)) best = pkg;
  }
  return best;
}

export function binTargets(pkg: Pkg): string[] {
  const bin = pkg.manifest['bin'];
  if (typeof bin === 'string') return [bin];
  return Object.values(record(bin)).filter((v): v is string => typeof v === 'string');
}

export function hasBin(pkg: Pkg): boolean {
  const bin = pkg.manifest['bin'];
  return typeof bin === 'string' || Object.keys(record(bin)).length > 0;
}

function targetStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) for (const v of value) targetStrings(v, acc);
  else for (const v of Object.values(record(value))) targetStrings(v, acc);
  return acc;
}

export interface TsConfigInfo {
  readonly outDir: string;
  readonly rootDir: string;
}

export function tsconfigOf(tree: Tree, dir: string, file = 'tsconfig.json'): TsConfigInfo {
  const path = dir === '.' ? file : `${dir}/${file}`;
  const parsed = tree.tracked.includes(path) ? parseJsonc(readText(tree, path) ?? '') : undefined;
  const options = record(record(parsed)['compilerOptions']);
  const clean = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v !== '' ? joinPosix(v) || '.' : fallback;
  return {
    outDir: clean(options['outDir'], 'dist'),
    rootDir: clean(options['rootDir'], 'src'),
  };
}

/**
 * Does this configuration declare `compilerOptions.paths`, directly or through a
 * chain of relative `extends`? The chain is followed from the extending file's
 * directory with `.json` added when the path does not end in it. A file that
 * cannot be read as a configuration, or an `extends` that names an untracked
 * file, counts as a `paths` the probe cannot read. A bare `extends` names an
 * installed package and is not followed (5.4, residue).
 */
export function tsconfigPathsReason(
  tree: Tree,
  file: string,
  seen: Set<string> = new Set(),
): string | null {
  if (seen.has(file)) return null;
  seen.add(file);
  const text = tree.tracked.includes(file) ? readText(tree, file) : null;
  const parsed = text === null ? undefined : parseJsonc(text);
  if (parsed === undefined)
    return `${file} cannot be read as a tsconfig, so it may declare compilerOptions.paths`;
  const config = record(parsed);
  if (record(config['compilerOptions'])['paths'] !== undefined)
    return `${file} declares compilerOptions.paths`;
  const extended = config['extends'];
  const list =
    typeof extended === 'string'
      ? [extended]
      : Array.isArray(extended)
        ? extended.filter((e): e is string => typeof e === 'string')
        : [];
  for (const entry of list) {
    if (!entry.startsWith('.')) continue;
    let target = joinPosix(dirname(file), entry);
    if (!target.endsWith('.json')) target = `${target}.json`;
    if (!tree.tracked.includes(target)) {
      return `${file} extends ${entry}, which names an untracked file, so its compilerOptions.paths cannot be read`;
    }
    const reason = tsconfigPathsReason(tree, target, seen);
    if (reason !== null) return `${reason} (reached through ${file})`;
  }
  return null;
}

/** The first tracked `tsconfig*.json` directly in `dir` that declares `compilerOptions.paths`, with the reason. */
export function tsconfigDeclaringPaths(tree: Tree, dir: string): string | null {
  for (const path of tree.tracked) {
    if (dirname(path) !== dir || !/^tsconfig[^/]*\.json$/.test(basename(path))) continue;
    const reason = tsconfigPathsReason(tree, path);
    if (reason !== null) return reason;
  }
  return null;
}

export interface DependencyLink {
  readonly key: string;
  readonly spec: string;
  /** The discovered packages this dependency leads to (by key, by alias, or by path). */
  readonly targets: readonly Pkg[];
  /** Set when the specifier names a path or a workspace target that is not a discovered package. */
  readonly problem: string | null;
}

/**
 * How a package's dependencies lead to other discovered packages (4.2 step 3):
 * by key when the key is the name of a discovered package; by a
 * `workspace:<name>@<range>` alias to the package `<name>`; by a path specifier
 * (`file:`, `link:`, `portal:`, or `workspace:` followed by `./` or `../`),
 * resolved from the package's directory, to the discovered package whose
 * directory it is. A specifier that says "workspace" or "path" and leads to no
 * discovered package is a `problem` (step 5, way 4).
 */
export function dependencyLinks(
  discovery: Discovery,
  pkg: Pkg,
  includeDev: boolean,
): DependencyLink[] {
  const sections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  if (includeDev) sections.push('devDependencies');
  const byName = new Map(discovery.packages.map((p) => [p.name, p] as const));
  const byDir = new Map(discovery.packages.map((p) => [p.dir, p] as const));
  const links: DependencyLink[] = [];
  for (const section of sections) {
    for (const [key, raw] of Object.entries(record(pkg.manifest[section]))) {
      const spec = typeof raw === 'string' ? raw : '';
      const targets: Pkg[] = [];
      let problem: string | null = null;
      const keyed = byName.get(key);
      if (keyed !== undefined) targets.push(keyed);
      let path: string | null = null;
      let workspaceName: string | null = null;
      let workspaceByKey = false;
      if (/^(?:file|link|portal):/.test(spec)) {
        path = spec.slice(spec.indexOf(':') + 1);
      } else if (spec.startsWith('workspace:')) {
        const rest = spec.slice('workspace:'.length);
        if (rest.startsWith('./') || rest.startsWith('../')) path = rest;
        else if (rest.lastIndexOf('@') > 0) workspaceName = rest.slice(0, rest.lastIndexOf('@'));
        else workspaceByKey = true;
      }
      if (path !== null) {
        const resolved = joinPosix(pkg.dir === '.' ? '' : pkg.dir, path.replace(/\/+$/, '')) || '.';
        const target = byDir.get(resolved);
        if (target !== undefined) targets.push(target);
        else
          problem = `${pkg.name} lists ${key} as "${spec}", a path that is not the directory of a discovered package`;
      } else if (workspaceName !== null) {
        const target = byName.get(workspaceName);
        if (target !== undefined) targets.push(target);
        else
          problem = `${pkg.name} lists ${key} as "${spec}", but ${workspaceName} is not a discovered package`;
      } else if (workspaceByKey && keyed === undefined) {
        problem = `${pkg.name} lists ${key} as "${spec}", but ${key} is not a discovered package`;
      }
      links.push({ key, spec, targets, problem });
    }
  }
  return links;
}

/**
 * Tracked manifests that no discovery reached: neither the root nor a
 * discovered package, outside `__fixtures__/`, `__tests__/` and `node_modules/`.
 * One that has a `bin` may be the CLI a document describes; one that does not
 * parse might be.
 */
export function strayManifests(
  tree: Tree,
  discovery: Discovery,
): { withBin: string[]; unparseable: string[] } {
  const known = new Set(
    discovery.packages.map((p) => (p.dir === '.' ? 'package.json' : `${p.dir}/package.json`)),
  );
  known.add('package.json');
  const withBin: string[] = [];
  const unparseable: string[] = [];
  for (const path of tree.tracked) {
    if (basename(path) !== 'package.json' || known.has(path)) continue;
    const slashed = `/${path}`;
    if (
      slashed.includes('/__fixtures__/') ||
      slashed.includes('/__tests__/') ||
      slashed.includes('/node_modules/')
    )
      continue;
    const manifest = parseManifest(readText(tree, path));
    if (manifest === null) unparseable.push(path);
    else if (hasBin({ dir: dirname(path), name: String(manifest['name'] ?? path), manifest }))
      withBin.push(path);
  }
  return { withBin, unparseable };
}

function underPackage(pkg: Pkg, path: string): string {
  return pkg.dir === '.' ? path : `${pkg.dir}/${path}`;
}

/**
 * The package's entry points (5.3, "Output to source"): the `bin`, `main` and
 * `exports` targets mapped from the build directory to the source directory,
 * declaration files dropped. A target that does not map to an existing file is
 * used as named when that exists; otherwise it contributes nothing (a missing
 * target is reported by `unmappedTargets`).
 */
export function entryPoints(tree: Tree, pkg: Pkg): { files: string[]; unmapped: string[] } {
  const { outDir, rootDir } = tsconfigOf(tree, pkg.dir);
  const targets = [...binTargets(pkg)];
  if (typeof pkg.manifest['main'] === 'string') targets.push(pkg.manifest['main']);
  targets.push(...targetStrings(pkg.manifest['exports']));
  const tracked = new Set(tree.tracked);
  const files = new Set<string>();
  const unmapped: string[] = [];
  for (const raw of targets) {
    const target = joinPosix(raw);
    if (target === '' || isDeclarationFile(target)) continue;
    if (target.startsWith(`${outDir}/`)) {
      const mapped = underPackage(
        pkg,
        joinPosix(rootDir, target.slice(outDir.length + 1).replace(/\.js$/, '.ts')),
      );
      if (tracked.has(mapped)) {
        files.add(mapped);
        continue;
      }
    }
    const named = underPackage(pkg, target);
    if (tracked.has(named)) files.add(named);
    else unmapped.push(raw);
  }
  return { files: [...files].sort(compareCodeUnits), unmapped };
}

/** The tracked source files of a package (5.3). */
export function sourceFilesOf(tree: Tree, discovery: Discovery, pkg: Pkg): string[] {
  const { outDir } = tsconfigOf(tree, pkg.dir);
  const outPrefix = underPackage(pkg, `${outDir}/`);
  const files = new Set<string>();
  for (const path of tree.tracked) {
    if (!isSourceExtension(path) || isDeclarationFile(path) || isTestPath(path)) continue;
    if (path.includes('/node_modules/') || path.startsWith('node_modules/')) continue;
    if (ownerOf(discovery, path) !== pkg) continue;
    if (path.startsWith(outPrefix)) continue;
    files.add(path);
  }
  const binaries = new Set(entryPoints(tree, { ...pkg, manifest: { bin: pkg.manifest['bin'] } }).files);
  for (const entry of entryPoints(tree, pkg).files) {
    // Manifest exports can name JSON resources. Their names and entry-point
    // status remain observable, but their contents are not TypeScript source.
    if (extname(entry) !== '.json' || binaries.has(entry)) files.add(entry);
  }
  return [...files].sort(compareCodeUnits);
}

/** Every tracked file of a package, of any extension (for names, 4.2 step 4). */
export function trackedFilesOf(discovery: Discovery, tree: Tree, pkg: Pkg): string[] {
  return tree.tracked.filter((path) => ownerOf(discovery, path) === pkg);
}

/** The reason a package is not wholly TypeScript or JavaScript (5.3), or `null`. */
export function otherLanguageReason(tree: Tree, discovery: Discovery, pkg: Pkg): string | null {
  for (const target of binTargets(pkg)) {
    if (!SOURCE_EXTENSIONS.includes(extname(target))) {
      return `${pkg.name}: the bin target ${target} is not a TypeScript or JavaScript file`;
    }
  }
  for (const path of trackedFilesOf(discovery, tree, pkg)) {
    if (OTHER_LANGUAGE_EXTENSIONS.includes(extname(path))) return `${pkg.name}: tracks ${path}`;
  }
  return null;
}
