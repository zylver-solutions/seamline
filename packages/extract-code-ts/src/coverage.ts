/**
 * What this run read, and what it is the authority for.
 *
 * The extractor reads the TypeScript projects it loads (the root
 * `tsconfig.json` graph plus every other `tsconfig.json` found under the root,
 * see `listProjectConfigs`), not every TypeScript/JavaScript file in the
 * repository. Two things follow, and this module is both of them:
 *
 * - Files no loaded project includes are reported as diagnostics, so a
 *   consumer can tell "this file has no symbols" apart from "this file was
 *   never read".
 * - The run's authoritative selector is what the loaded projects include, not
 *   every TypeScript/JavaScript path. Tombstoning is confined to the selector
 *   (v3 §2.2): a file deleted from an included directory is still inside it,
 *   so its facts are tombstoned, while a file outside every project is outside
 *   it and is never treated as deleted just because this run did not read it.
 */

import * as nodePath from 'node:path';
import { ts } from 'ts-morph';
import { toRepoRelative } from './paths.ts';
import { isManifestName } from './workspace.ts';

/** Every extension this extractor can read, declaration files aside. */
export const CODE_TS_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

const TS_EXTENSIONS: readonly string[] = ['.cts', '.mts', '.ts', '.tsx'];
const JS_EXTENSIONS: readonly string[] = ['.cjs', '.js', '.jsx', '.mjs'];

/** Uncovered files listed one per diagnostic; the summary line always carries the full count. */
export const MAX_LISTED_UNCOVERED = 50;

const DECLARATION_FILE = /\.d(\.[^./]+)?\.[cm]?ts$/;

/**
 * Parses a tsconfig without expanding `include`: the file list was already
 * resolved by the project itself, and only the specs and options are wanted.
 */
export const SPECS_ONLY_HOST: ts.ParseConfigFileHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  fileExists: (file) => ts.sys.fileExists(file),
  readFile: (file) => ts.sys.readFile(file),
  getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
  readDirectory: () => [],
  onUnRecoverableConfigFileDiagnostic: () => undefined,
};

export interface IncludedDirectory {
  /** Absolute. */
  readonly path: string;
  /** True when an `include` spec reaches below the directory, not only into it. */
  readonly recursive: boolean;
}

/** What one loaded tsconfig says it includes, `extends` resolved. */
export interface LoadedProject {
  /** The directories the `include` specs reach, as TypeScript itself computes them. */
  readonly directories: readonly IncludedDirectory[];
  /** Absolute paths listed in `files`, whether or not they still exist. */
  readonly files: readonly string[];
  /** Extensions the project reads: TypeScript, plus JavaScript under `allowJs`. */
  readonly extensions: readonly string[];
  /** Absolute `outDir` and `declarationDir`: build output, never source. */
  readonly outputDirs: readonly string[];
}

/**
 * `host` resolves `extends`; the default reads the real file system. It must
 * not enumerate files (`readDirectory` returning nothing), see `SPECS_ONLY_HOST`.
 */
export function loadProjects(
  configPaths: Iterable<string>,
  host: ts.ParseConfigFileHost = SPECS_ONLY_HOST,
): readonly LoadedProject[] {
  const projects: LoadedProject[] = [];
  for (const configPath of configPaths) {
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
    if (parsed === undefined) continue;
    projects.push({
      directories: Object.entries(parsed.wildcardDirectories ?? {}).map(([path, flags]) => ({
        path: nodePath.resolve(path),
        recursive: (flags & ts.WatchDirectoryFlags.Recursive) !== 0,
      })),
      // With `readDirectory` stubbed out, `fileNames` holds only the `files` entries.
      files: parsed.fileNames.map((file) => nodePath.resolve(file)),
      extensions: parsed.options.allowJs === true ? [...TS_EXTENSIONS, ...JS_EXTENSIONS] : TS_EXTENSIONS,
      outputDirs: [parsed.options.outDir, parsed.options.declarationDir]
        .filter((dir): dir is string => dir !== undefined)
        .map((dir) => nodePath.resolve(dir)),
    });
  }
  return projects;
}

export interface CandidateFileOptions {
  readonly repoRoot: string;
  /** Repository-relative globs in tsconfig `include` syntax. */
  readonly include: readonly string[];
  /** Repository-relative globs in tsconfig `exclude` syntax. */
  readonly exclude: readonly string[];
  /** Absolute directories whose contents are build output. */
  readonly outputDirs: readonly string[];
}

/**
 * Repository-relative POSIX paths under the root with one of `extensions`,
 * sorted.
 *
 * The walk is TypeScript's own `include`/`exclude` matcher, so it follows the
 * same rules a root tsconfig would: wildcards skip `node_modules` (and the
 * other package folders), dot-directories, dot-files, and `.min.js` files.
 */
function walkRepository(options: CandidateFileOptions, extensions: readonly string[]): readonly string[] {
  const found = ts.sys.readDirectory(
    options.repoRoot,
    extensions,
    [...options.exclude, ...options.outputDirs],
    options.include,
  );
  const rels = new Set<string>();
  for (const file of found) {
    const rel = toRepoRelative(options.repoRoot, file);
    if (rel !== null && !rel.split('/').includes('node_modules')) rels.add(rel);
  }
  return [...rels].sort(compareCodeUnits);
}

/**
 * Every TypeScript/JavaScript source file under the root, repository-relative
 * and sorted. Declaration files are not source and are dropped.
 */
export function listCandidateFiles(options: CandidateFileOptions): readonly string[] {
  return walkRepository(options, CODE_TS_EXTENSIONS).filter((rel) => !DECLARATION_FILE.test(rel));
}

/**
 * Absolute paths of every `tsconfig.json` under the root, sorted, found by the
 * same walk as the candidate files: never under `node_modules`, a
 * dot-directory, an emit directory, or the run's `exclude`.
 */
export function listProjectConfigs(options: CandidateFileOptions): readonly string[] {
  return walkRepository(options, ['.json'])
    .filter((rel) => rel === 'tsconfig.json' || rel.endsWith('/tsconfig.json'))
    .map((rel) => nodePath.join(options.repoRoot, rel));
}

/**
 * Absolute paths of every package manifest under the root (`package.json`,
 * `package.json5` and `package.yaml`, the three names pnpm accepts), sorted,
 * found by the same walk as `listProjectConfigs`. Only the names are listed:
 * the content of a `package.json5` or `package.yaml` is never opened.
 */
export function listPackageManifests(options: CandidateFileOptions): readonly string[] {
  return walkRepository(options, ['.json', '.json5', '.yaml'])
    .filter((rel) => isManifestName(rel.slice(rel.lastIndexOf('/') + 1)))
    .map((rel) => nodePath.join(options.repoRoot, rel));
}

/**
 * One diagnostic line per candidate the run did not read, after a summary
 * carrying the ratio. A fully covered run reports nothing.
 */
export function coverageDiagnostics(candidates: readonly string[], read: ReadonlySet<string>): readonly string[] {
  const unread = candidates.filter((rel) => !read.has(rel));
  if (unread.length === 0) return [];
  const lines = [
    `tsconfig coverage: ${candidates.length - unread.length}/${candidates.length} TypeScript/JavaScript files ` +
      'under the repository root are in a loaded project; files in no loaded project are not read and not claimed',
    ...unread.slice(0, MAX_LISTED_UNCOVERED).map((rel) => `not in any loaded tsconfig project: ${rel}`),
  ];
  if (unread.length > MAX_LISTED_UNCOVERED) lines.push(`... ${unread.length - MAX_LISTED_UNCOVERED} more not listed`);
  return lines;
}

/**
 * Characters the selector syntax cannot write (`,` `{` `}` `*` `?`, a
 * backslash, a control character), plus whitespace at either end, which it
 * rejects, and a leading `!`, which marks an exclusion. A path or directory carrying one is
 * not claimed: the safe direction.
 * `[` and `]` are literal in a selector and need no escaping.
 */
const UNNAMEABLE = /[,{}*?\\\u0000-\u001f\u007f]|^\s|\s$|^!/u;

/**
 * Claims nothing this extractor emits: it never emits a path under
 * `node_modules`. Only reachable when no read path is nameable at all.
 */
export const CLAIMS_NOTHING_SELECTOR = 'node_modules/**';

/** One included directory narrowed to one extension: `dir/**` + `/*.ts`, or `dir/*.ts`. */
interface DirectoryPattern {
  /** Repository-relative directory with a trailing `/`, or `''` at the root. */
  readonly prefix: string;
  readonly recursive: boolean;
  readonly extension: string;
}

function patternText(p: DirectoryPattern): string {
  return `${p.prefix}${p.recursive ? '**/' : ''}*${p.extension}`;
}

function patternMatches(p: DirectoryPattern, rel: string): boolean {
  if (!rel.startsWith(p.prefix) || !rel.endsWith(p.extension)) return false;
  return p.recursive || !rel.slice(p.prefix.length).includes('/');
}

/**
 * The run's authoritative selector: a brace list of path patterns in the
 * store's selector syntax, or the bare pattern when there is one.
 *
 * - Each included directory contributes one pattern per extension its project
 *   reads (`src/**` + `/*.ts`), so a file deleted from it stays claimed.
 * - A pattern that would also match a file the run did not read (`unread`,
 *   say one the project's own `exclude` drops) is not emitted: the selector
 *   never claims a file that exists and was not read.
 * - `files` entries, and read files no emitted pattern covers (a file the
 *   program reached through an import), are named literally.
 *
 * `unread` is `null` when the candidate walk could not run. No directory can
 * then be shown to hold only read files, so only literal paths are claimed.
 */
export function authoritativeSelector(
  repoRoot: string,
  projects: readonly LoadedProject[],
  read: ReadonlySet<string>,
  unread: readonly string[] | null,
): string {
  const patterns: DirectoryPattern[] = [];
  for (const project of unread === null ? [] : projects) {
    for (const dir of project.directories) {
      const rel = dir.path === repoRoot ? '' : toRepoRelative(repoRoot, dir.path);
      if (rel === null || UNNAMEABLE.test(rel)) continue;
      const prefix = rel === '' ? '' : `${rel}/`;
      for (const extension of project.extensions) {
        const pattern: DirectoryPattern = { prefix, recursive: dir.recursive, extension };
        if (!unread?.some((u) => patternMatches(pattern, u))) patterns.push(pattern);
      }
    }
  }

  const selected = new Set(patterns.map(patternText));
  const name = (rel: string | null): void => {
    if (rel === null || UNNAMEABLE.test(rel) || patterns.some((p) => patternMatches(p, rel))) return;
    selected.add(rel);
  };
  for (const project of projects) for (const file of project.files) name(toRepoRelative(repoRoot, file));
  for (const rel of read) name(rel);

  const sorted = [...selected].sort(compareCodeUnits);
  if (sorted.length === 0) return CLAIMS_NOTHING_SELECTOR;
  if (sorted.length === 1) return sorted[0] as string;
  return `{${sorted.join(',')}}`;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
