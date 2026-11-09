/**
 * `eval/FREEZE`: when the sealed partition may be opened, and when it is spent.
 *
 * The sealed repositories exist so that one figure is not fitted to the thing
 * it measures. They keep that property only while nobody tunes against them,
 * so the design (section 6.1) says nobody opens them (no run output, no
 * labels) until the detector and extractor change set is frozen. The freeze is
 * a commit sha recorded in `eval/FREEZE`. A detector or extractor change after
 * the freeze burns the sealed partition: its figure no longer describes a
 * frozen product, and it must be replaced by new repositories.
 *
 * What this module enforces:
 *
 * - without `eval/FREEZE`, a label for a sealed finding is refused (`evaluate`
 *   throws), so sealed labels cannot be committed before the freeze;
 * - with it, the sources that decide what a finding is (`FREEZE_WATCHED_PATHS`)
 *   are compared with the frozen commit; any difference (committed or not;
 *   tests, fixtures, test-only helpers and editor leftovers excepted) makes the
 *   state `burned`, which withholds the headline and fails the run. So are the
 *   sealed entries of `eval/corpus.json` (which repository, at which commit, in
 *   which partition), compared by digest: adding a development repository does
 *   not burn.
 *
 * It also names the code that produced a stored baseline (`codeIdentity`), so a
 * baseline made by other code is never mistaken for the current run's, and the
 * harness code the freeze does not watch (`scorerIdentity`), so the report can
 * show whether the scoring changed since the freeze.
 *
 * What it does not do: decide when to freeze, replace a burned partition, stop
 * someone from reading sealed output by hand, or protect itself: this file and
 * the rest of the scorer are not watched, because changing how findings are
 * scored re-scores the same findings and exposes nothing new. Review of that
 * change is what `scorerIdentity` and the release checklist are for.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from './errors.ts';
import { GitError, runGit, type GitRunner } from './git.ts';

/**
 * Where `eval/FREEZE` stands against the code: `none` (no freeze yet, so sealed
 * labels are not allowed), `frozen` (the detectors and extractors are as they
 * were at the freeze), or `burned` (one changed since).
 */
export interface FreezeState {
  readonly state: 'none' | 'frozen' | 'burned';
  readonly sha: string | null;
  /**
   * The paths that changed since the freeze, when burned: watched sources, and `eval/corpus.json`
   * when its sealed entries differ.
   */
  readonly changed: readonly string[];
}

export const NO_FREEZE: FreezeState = { state: 'none', sha: null, changed: [] };

/**
 * What a freeze covers: the sources the CLI loads when it runs `extract` and `check`, what it is
 * built and run from, and the files that run it and read its output. Entries are git pathspecs (a
 * directory, a file, or a glob). Three kinds, and a test traces the first and the last from the
 * imports, so the list cannot drift from the code.
 *
 * It is a list of what is loaded, not of what is called: a module's top level runs when it is
 * imported, whether or not anything it exports is used. `eval/README.md` ("What a freeze cannot
 * see") lists what no list of source files can cover.
 *
 * The product, which is what the `extract` and `check` commands run:
 *
 * - the detectors, `infer-join`, every extractor package, and the ontology: all of `src/`;
 * - `core`: the root barrel and the directories it re-exports (identity, merge, sif, sql, store,
 *   security, traversal). `semantic`, an optional layer outside the root barrel, is not loaded;
 * - `cli`: the entry (`index.ts`), the dispatcher (`run.ts`) and everything they import, every
 *   command and the extractor host (`extractors/`, `sandbox/`) included, because the dispatcher's table names them all;
 * - `mcp`: all of `src/`, which the `mcp` command imports, so every run loads it;
 * - `security`: all of `src/`, which holds the redactor `extract` runs. Its `corpus/` is test data
 *   that no module imports, so it is not watched.
 *
 * What the product is built and run from: the lockfile and workspace configuration, the root
 * manifest and every package manifest (dependency ranges and entry points), and the `tsconfig`
 * files. A manifest's `version` is the one field a release changes on purpose, so a change to it
 * alone is not a change (`comparableManifest`).
 *
 * The harness's run definition: the files that fetch and verify a checkout, copy it, write the
 * configuration the CLI reads, set its argument vector and environment, build it, and turn its
 * output into findings. The scorer (metrics, labels, the report) is not here: `scorerIdentity`
 * digests it instead.
 *
 * `eval/corpus.json` is not in this list: its sealed entries are compared by digest instead
 * (`sealedCorpusDigest`), so adding a development repository does not burn the partition.
 *
 * `eval/README.md` gives the reason for each entry.
 */
export const FREEZE_WATCHED_PATHS: readonly string[] = [
  'packages/align/src',
  'packages/contradictions/src',
  'packages/infer-join/src',
  'packages/extract-*/src/*',
  'packages/ontology/src',
  'packages/core/src/index.ts',
  'packages/core/src/identity',
  'packages/core/src/merge',
  'packages/core/src/security',
  'packages/core/src/sif',
  'packages/core/src/sql',
  'packages/core/src/store',
  'packages/core/src/traversal',
  'packages/cli/src/align-port.ts',
  'packages/cli/src/args.ts',
  'packages/cli/src/commands',
  'packages/cli/src/config.ts',
  'packages/cli/src/current-observation.ts',
  'packages/cli/src/conformance',
  'packages/cli/src/extractors',
  'packages/cli/src/gitignore.ts',
  'packages/cli/src/index.ts',
  'packages/cli/src/io.ts',
  'packages/cli/src/lineage.ts',
  'packages/cli/src/render.ts',
  'packages/cli/src/run-id.ts',
  'packages/cli/src/run-inputs.ts',
  'packages/cli/src/run.ts',
  'packages/cli/src/sandbox',
  'packages/cli/src/scopes.ts',
  'packages/cli/src/sif.ts',
  'packages/cli/src/store-dir.ts',
  'packages/cli/src/version.ts',
  'packages/cli/src/wiring.ts',
  'packages/mcp/src',
  'packages/security/src',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'packages/*/package.json',
  'tsconfig*.json',
  'packages/*/tsconfig*.json',
  'packages/eval/src/analyse.ts',
  'packages/eval/src/build.ts',
  'packages/eval/src/corpus.ts',
  'packages/eval/src/fetch.ts',
  'packages/eval/src/findings.ts',
  'packages/eval/src/git.ts',
  'packages/eval/src/pipeline.ts',
  'packages/eval/src/workdir.ts',
];

/**
 * Files the import trace reaches that the freeze leaves out, each with the reason. The trace test
 * accepts a reached file only if it is watched or listed here.
 */
export const FREEZE_UNWATCHED_ON_PATH: Readonly<Record<string, string>> = {
  'packages/cli/src/colour.ts':
    'terminal styling only; the harness runs the CLI with --json and NO_COLOR, so it cannot change a finding',
  'packages/eval/src/errors.ts':
    'the harness error classes: they decide a message and an exit code, not what is measured',
  'packages/eval/src/sif.ts':
    'counts nodes and edges by kind for the report tables and finds source locations for the label sheet; it never produces a finding',
  'packages/eval/src/types.ts':
    'type declarations and the two partition names the corpus loader accepts; no code that runs a repository',
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does one pathspec of `FREEZE_WATCHED_PATHS` cover `file`? A directory covers what is under it. */
export function matchesPathspec(spec: string, file: string): boolean {
  const pattern = spec.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${pattern}(/|$)`).test(file);
}

/** Does `FREEZE_WATCHED_PATHS` cover `file`? */
export function isWatched(file: string): boolean {
  return FREEZE_WATCHED_PATHS.some((spec) => matchesPathspec(spec, file));
}

const TEST_FILE = /\.test\.(ts|mjs)$/;
const BACKUP_FILE = /(\.orig|\.swp|~)$/;
/** `testing.ts`, `test-fixtures.ts`, `test-harness.ts`, `test-graph.ts`: helpers that tests share. */
const TEST_HELPER = /(^|\/)(testing|test-[a-z0-9-]+)\.ts$/;

/** Inert by its name alone: a test, a fixture, or an editor or merge leftover. */
function inertByName(file: string): boolean {
  return TEST_FILE.test(file) || file.includes('/__fixtures__/') || BACKUP_FILE.test(file);
}

/**
 * A package manifest as the freeze compares it: parsed and written back without `version`, so a
 * release bump is not a change and formatting is not either. Key order is kept, because the order
 * of `exports` conditions decides which one resolves. Text that is not a JSON object is compared
 * as it is.
 */
export function comparableManifest(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const { version: _version, ...rest } = parsed as Record<string, unknown>;
      return JSON.stringify(rest);
    }
  } catch {
    // Not JSON: a broken manifest is compared byte for byte.
  }
  return text;
}

/** The files that import `file` by a relative specifier, read from the working tree (tracked or not). */
async function importersOf(file: string, root: string, git: GitRunner): Promise<string[]> {
  const base = escapeRegExp(path.posix.basename(file));
  let out: string;
  try {
    out = await git(
      [
        'grep',
        '--untracked',
        '-a',
        '-o',
        '-n',
        '-E',
        `['"]\\.{1,2}/([^'"]*/)?${base}['"]`,
        '--',
        'packages',
      ],
      root,
    );
  } catch (e) {
    // `git grep` exits 1, with nothing on stderr, when nothing matches.
    if (e instanceof GitError && e.stderr.trim() === '') return [];
    throw e;
  }
  const importers = new Set<string>();
  for (const line of out.split('\n')) {
    const m = /^([^:]+):\d+:(['"])(.+)\2$/.exec(line);
    const importer = m?.[1];
    const specifier = m?.[3];
    if (importer === undefined || specifier === undefined) continue;
    if (path.posix.join(path.posix.dirname(importer), specifier) === file) importers.add(importer);
  }
  return [...importers].sort();
}

/**
 * Is a test helper imported, directly or through another helper, by a file that is not a test?
 * Then it is production code that merely has a test-like name.
 */
async function importedByProduction(
  file: string,
  root: string,
  git: GitRunner,
  seen: Set<string> = new Set(),
): Promise<boolean> {
  if (seen.has(file)) return false;
  seen.add(file);
  for (const importer of await importersOf(file, root, git)) {
    if (importer === file || inertByName(importer)) continue;
    if (!TEST_HELPER.test(importer)) return true;
    if (await importedByProduction(importer, root, git, seen)) return true;
  }
  return false;
}

/** Is the manifest `file` the same as it was at `sha`, apart from its `version`? */
async function manifestUnchanged(
  file: string,
  sha: string,
  root: string,
  git: GitRunner,
): Promise<boolean> {
  try {
    const before = await git(['show', `${sha}:${file}`], root);
    const after = await readFile(path.join(root, ...file.split('/')), 'utf8');
    return comparableManifest(before) === comparableManifest(after);
  } catch {
    // Added, deleted or unreadable: not the same manifest.
    return false;
  }
}

/**
 * Changes that cannot alter what a detector or extractor reports: a test, a fixture, an editor
 * or merge leftover (`*.orig`, `*.swp`, `*~`), a test helper (`testing.ts` and the like) that
 * only tests import, or a package manifest whose only change is its `version`. A file that
 * production code imports is never inert, whatever it is called.
 */
async function isInert(file: string, sha: string, root: string, git: GitRunner): Promise<boolean> {
  if (inertByName(file)) return true;
  if (path.posix.basename(file) === 'package.json') return manifestUnchanged(file, sha, root, git);
  if (!TEST_HELPER.test(file)) return false;
  return !(await importedByProduction(file, root, git));
}

/** The corpus file, relative to the repository root. */
export const CORPUS_FILE = 'eval/corpus.json';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A digest of the sealed entries of a parsed corpus: name, url, commit and partition of each,
 * in name order, whatever else the entry says and wherever it stands in the file. Which
 * repository a sealed finding comes from, at which commit, is what the headline measures, so a
 * change to any of those is a change to the frozen partition: a different commit, a repository
 * moved to `dev` or into `sealed`, a sealed repository added or removed. A `dev` entry, and the
 * `license`, `stacks` and `why` of a sealed one, are not part of it. A value that is not a
 * corpus (not an array) digests as `unreadable`, which only an identical value shares.
 */
export function sealedEntriesDigest(parsed: unknown): string {
  if (!Array.isArray(parsed)) {
    return `unreadable:${createHash('sha256')
      .update(JSON.stringify(parsed) ?? 'undefined')
      .digest('hex')}`;
  }
  const sealed = parsed
    .filter((e): e is Record<string, unknown> => isRecord(e) && e['partition'] === 'sealed')
    .map((e) => JSON.stringify([e['name'], e['url'], e['sha'], e['partition']]))
    .sort();
  return createHash('sha256').update(sealed.join('\n')).digest('hex');
}

/** `sealedEntriesDigest` of the text of a corpus file; text that is not JSON digests as `unreadable`. */
export function sealedCorpusDigest(text: string): string {
  try {
    return sealedEntriesDigest(JSON.parse(text) as unknown);
  } catch {
    return `unreadable:${createHash('sha256').update(text).digest('hex')}`;
  }
}

/** The digest of an absent corpus: no sealed entries. */
const NO_SEALED_ENTRIES = sealedEntriesDigest([]);

/**
 * Do the sealed entries of `eval/corpus.json` in the working tree differ from those at `sha`? An
 * absent file counts as a corpus with no sealed entries, on either side.
 */
async function sealedCorpusChanged(sha: string, root: string, git: GitRunner): Promise<boolean> {
  const listed = await git(['ls-tree', '--name-only', sha, '--', CORPUS_FILE], root);
  const before =
    listed.trim() === ''
      ? NO_SEALED_ENTRIES
      : sealedCorpusDigest(await git(['show', `${sha}:${CORPUS_FILE}`], root));
  let after: string;
  try {
    after = sealedCorpusDigest(await readFile(path.join(root, ...CORPUS_FILE.split('/')), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(`cannot read ${CORPUS_FILE}: ${(e as Error).message}`);
    }
    after = NO_SEALED_ENTRIES;
  }
  return before !== after;
}

/** The sha in `eval/FREEZE`: one line of 40 hex characters; blank lines and `#` comments are ignored. */
export function parseFreeze(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  const sha = lines[0];
  if (lines.length !== 1 || sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new ConfigError(
      'eval/FREEZE must hold exactly one full 40-character lowercase hex commit id ' +
        '(blank lines and lines starting with # are ignored).',
    );
  }
  return sha;
}

/** The names in a `-z` listing, in code-unit order. */
function nulSeparated(...listings: string[]): string[] {
  return [...new Set(listings.flatMap((l) => l.split('\0')))].filter((f) => f !== '').sort();
}

/**
 * Reads `file` and compares the watched paths under `root` with the frozen
 * commit. A missing file is `none`. A malformed file, or a sha that is not a
 * commit in `root`'s history (a shallow clone, say), is a `ConfigError`: the
 * harness will not guess whether the partition is intact.
 */
export async function readFreeze(
  file: string,
  root: string,
  git: GitRunner = runGit,
): Promise<FreezeState> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return NO_FREEZE;
    throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`);
  }
  const sha = parseFreeze(text);
  try {
    await git(['cat-file', '-e', `${sha}^{commit}`], root);
  } catch {
    throw new ConfigError(
      `eval/FREEZE names ${sha}, which is not a commit in this repository's history. ` +
        'Fetch the full history (a shallow clone cannot show whether the sealed partition is intact).',
    );
  }
  // `git diff <sha>` compares the working tree with the commit but does not list a file git
  // has never seen, so an untracked file under a watched path is listed separately. Renames are
  // not detected: with detection, a renamed file is listed under its new name only, and the
  // old name (a watched file that is gone) would not be seen.
  const tracked = await git(
    ['diff', '--no-renames', '--name-only', '-z', sha, '--', ...FREEZE_WATCHED_PATHS],
    root,
  );
  const untracked = await git(
    ['ls-files', '--others', '--exclude-standard', '-z', '--', ...FREEZE_WATCHED_PATHS],
    root,
  );
  const changed: string[] = [];
  for (const candidate of nulSeparated(tracked, untracked)) {
    if (!(await isInert(candidate, sha, root, git))) changed.push(candidate);
  }
  // The pins decide which tree is analysed. They are compared by digest of the sealed entries, so
  // a development repository can still be added.
  if (await sealedCorpusChanged(sha, root, git)) changed.push(CORPUS_FILE);
  changed.sort();
  return { state: changed.length > 0 ? 'burned' : 'frozen', sha, changed };
}

/**
 * What `codeIdentity` and `scorerIdentity` return outside a git checkout. It names no sources, so
 * two runs that both got it have nothing in common, and a stored baseline carrying it is never
 * reused. A sealed repository is not measured with it.
 */
export const NO_GIT = 'no git';

/** Is `root` the top level of a git checkout? A source archive, or a subdirectory of another repository, is not. */
async function isCheckoutRoot(root: string, git: GitRunner): Promise<boolean> {
  try {
    return (await git(['rev-parse', '--show-prefix'], root)).trim() === '';
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}

/**
 * A digest of the files under `specs` as they stand in the working tree (tracked, or untracked and
 * not ignored), tests, fixtures and leftovers excepted and `keep` applied. Test helpers are
 * included, which can only make the digest change more often.
 */
async function digestOf(
  root: string,
  git: GitRunner,
  specs: readonly string[],
  keep: (file: string) => boolean,
): Promise<string> {
  if (!(await isCheckoutRoot(root, git))) return NO_GIT;
  const listed = await git(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...specs],
    root,
  );
  const files = nulSeparated(listed).filter((f) => !inertByName(f) && keep(f));
  const digest = createHash('sha256');
  for (const file of files) {
    let content: Buffer;
    try {
      content = await readFile(path.join(root, ...file.split('/')));
    } catch (e) {
      // Tracked but deleted in the working tree: it is not part of the code.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    const bytes =
      path.posix.basename(file) === 'package.json'
        ? Buffer.from(comparableManifest(content.toString('utf8')), 'utf8')
        : content;
    digest.update(`${file}\0${createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  return digest.digest('hex');
}

/**
 * A digest of the code that decides what a finding is, as it stands in the working tree: the
 * watched paths, tests and fixtures excepted (test helpers are included, which can only make the
 * digest change more often). Equal digests mean the same sources. It is stored beside a baseline
 * so that a baseline made by other code is not reused, and recorded in the report. It covers
 * sources, not the built output: `build.ts` digests that. Outside a git checkout it is `NO_GIT`.
 */
export async function codeIdentity(root: string, git: GitRunner = runGit): Promise<string> {
  return digestOf(root, git, FREEZE_WATCHED_PATHS, () => true);
}

/**
 * A digest of the harness code the freeze does not watch: everything under `packages/eval/src`
 * that `FREEZE_WATCHED_PATHS` leaves out (the scorer, the report, the label and mutant handling,
 * and this file), tests and fixtures excepted. A change to it after the freeze does not burn the
 * sealed partition, since it only re-scores the same findings, so the report records it and the
 * release checklist asks for the value at the freeze to be compared. Outside a git checkout it is
 * `NO_GIT`.
 */
export async function scorerIdentity(root: string, git: GitRunner = runGit): Promise<string> {
  return digestOf(root, git, ['packages/eval/src'], (file) => !isWatched(file));
}
