// Authoritative-scope selectors: the one definition of their syntax and meaning.
//
// `AuthoritativeScope.selector` narrows a scope's claim to the nodes whose
// repo-relative `path` it matches, and to the edges those nodes anchor, and
// tombstoning is confined to that claim (v3 §2.2). A selector the store cannot
// evaluate is therefore not harmless: it matches nothing, and every fact that
// vanishes from the scope stays live forever. This module is the only place a
// selector is parsed, and it refuses anything it cannot evaluate exactly.
// Manifest validation, the store's sweep and the in-memory merge all go
// through it.
//
// Syntax
// ------
//
// A selector is a comma-separated list of path patterns: `a,b`. A pattern may
// contain brace groups, `{x,y}`, each of which expands to one pattern per
// alternative; several groups in one pattern expand to every combination.
// Braces do not nest. A long brace group of literal paths is fine.
//
//     **/*.{ts,tsx}                     every .ts and .tsx file, root level included
//     **/*.sql,**/*.prisma              two patterns
//     {src/a.ts,src/b.ts,app/[id]/x.ts} three literal paths
//
// After expansion, each pattern is a repo-relative POSIX path pattern with the
// same wildcards a manifest's `reads` globs use:
//
//     *     any run of characters inside one path segment, never `/`
//     ?     exactly one character other than `/`
//     **    as a whole segment, zero or more whole segments
//     other itself, case-sensitively; `[` and `]` are literal
//
// `**` is accepted only in the forms the store can evaluate exactly, where
// `dir/` is an optional literal prefix:
//
//     **  and  dir/**           every path, or every path under dir/
//     dir/**/*suffix            any depth, last segment ending in a literal suffix
//     dir/**/literal/path       that literal path at any depth
//
// Rejected, with the reason: an empty selector, pattern or brace alternative;
// whitespace at either end of one (the mark of prose, not a path); a leading
// `/`; an empty, `.` or `..` segment; a backslash; a control character;
// unbalanced or nested braces; `**` inside a segment, more than once, after a
// wildcard, or in any other form; a selector with no positive pattern. A
// literal `,`, `{`, `}`, `*` or `?` cannot be written, and neither can a path
// that begins with `!` (see Exclusions).
//
// Exclusions
// ----------
//
// A list item that begins with `!` is an exclusion: its patterns (after brace
// expansion, same forms as above) take paths OUT of the selection. A path is
// selected when some positive pattern matches it and no exclusion does:
//
//     **/*.{sql,prisma},!db/b.sql,!vendor/**    every .sql/.prisma file except two
//
// An exclusion is how an extractor that could not read some of the files its
// positive patterns cover keeps them out of its claim, without having to name
// every file it did read (which would stop a deleted file from being swept).
// The order of items does not matter. A path that must be excluded but cannot
// be written (see above) is excluded by a pattern that over-matches it, with
// `?` in place of each unwritable character; the claim only ever shrinks. Such
// a pattern holds a wildcard, so it cannot take the `/**` form (a wildcard may
// not precede `**`); a caller that must exclude what lies under it names a
// writable ancestor with `/**` instead (`extract-data` does).
//
// Two rules are easy to miss. Only a list item that BEGINS with `!` is an
// exclusion, and that is a change: before exclusions existed, `!a.sql` was a
// literal positive pattern, so a path that begins with `!` can no longer be
// selected by writing it (`!!a.sql` excludes the literal `!a.sql`). And a `!`
// inside a brace group is not an exclusion: `{**/*.sql,!a.sql}` selects every
// .sql file and also the literal path `!a.sql`. A selector with no positive
// pattern is refused.
//
// Evaluation
// ----------
//
// The store evaluates selectors in SQLite with `GLOB`, whose `*` and `?` also
// match `/`. Each expanded pattern compiles to a GLOB plus, for a pattern with
// no `**`, the exact number of `/` a matching path contains. A POSIX wildcard
// never matches `/`, and each literal `/` in the pattern consumes one in the
// path, so equal counts are exactly what stops a GLOB wildcard from consuming
// one. A leading `**/` compiles to a bare `*`, which already spans
// directories; that is also what lets the root-level `a.ts` match `**/*.ts`.
//
// What a claim covers
// -------------------
//
// A claim is `(scope, kinds, selector?)`. The store's sweeps and the in-memory
// merge's tombstoning both ask exactly two questions of it, answered by
// `claimCoversNode` and `claimCoversEdge` here, with the SQL twin of each
// beside them. A run buries a fact only when the answer is yes and the run did
// not re-observe the fact.
//
// A node is covered when its kind is one of the claim's `kinds` and, if the
// claim has a selector, its `path` matches it. A node with no path never
// matches a selector: no file read vouches for it, so only a claim without a
// selector can bury one. Its name is never consulted.
//
// An edge is stored under exactly one scope, and only a claim of that scope
// can cover it. Without a selector the claim covers every edge of the scope.
// With a selector, an edge is covered when the file that anchors it matches:
//
//     anchor = srcFile, else dstFile, else none
//
// So an edge is placed by the file of its SOURCE endpoint, and the selector
// that places it is the one that places a node: the same matcher, applied to a
// file path. `srcFile` is that file (for the code extractor, the file whose read
// produced the edge), which is why a run that did not read a file cannot bury
// the edges it declares: an edge is judged by its source's file as its source
// node is judged by its own path. `dstFile` is the fallback for an edge whose
// source lives in no file (a repo or module root containing a file), which the
// file it contains places instead. An edge with neither is outside every
// selector, like a path-less node.
//
// A claim that names no node kinds has no nodes for a selector to narrow. Its
// selector is a label (infer-join lists the edge kinds it owns), not a path
// filter, and the claim covers the scope's edges whole. This is
// `selectorNarrowsEdges`.
//
// A label over kinds that carry no path (extract-change's revision range)
// cannot place any edge, since an anchor is always a file. Such a claim leaves
// the scope's edges alone, as it leaves its Commit and Changeset nodes alone.

import type { AuthoritativeScope } from '@seamline/ontology';
import { assertCanonicalSelectorBudget, compileCanonicalSelector, isCanonicalSelectorText, type CompiledCanonicalSelector } from './canonical-selector.ts';
import { canonicalClaimCoversEdge, canonicalClaimCoversNode, type AuthorityContext, type AuthorityNode } from './canonical-authority.ts';

/** Guards brace expansion, whose combinations grow multiplicatively. */
export const MAX_SELECTOR_PATTERNS = 100_000;

export { SelectorError } from './selector-error.ts';
import { SelectorError } from './selector-error.ts';

/** One SQLite GLOB, and the exact `/` count a match has, or `null` for any depth. */
export interface GlobClause {
  readonly glob: string;
  readonly slashes: number | null;
  /** An exclusion (`!pattern`): a path it matches is not selected. */
  readonly negated: boolean;
}

export interface CompiledSelector {
  readonly selector: string;
  /** The expanded POSIX patterns, in source order, without duplicates (exclusions not included). */
  readonly patterns: ReadonlyArray<string>;
  /**
   * What the store evaluates: a path is selected when any non-negated clause
   * matches it and no negated clause does.
   */
  readonly clauses: ReadonlyArray<GlobClause>;
  /** Evaluates `clauses` exactly as the store's SQL does. */
  matches(path: string): boolean;
}

type Fail = (reason: string) => never;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const WILDCARD = /[*?]/u;

function checkEnds(text: string, what: string, fail: Fail): void {
  if (text.length === 0) fail(`empty ${what}`);
  if (text.trim() !== text) fail(`${what} ${JSON.stringify(text)} has whitespace at an end`);
}

/** Split on commas outside braces, checking that braces balance and do not nest. */
function splitList(selector: string, fail: Fail): string[] {
  const items: string[] = [];
  let open = false;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '{') {
      if (open) fail('braces do not nest');
      open = true;
    } else if (c === '}') {
      if (!open) fail('unbalanced `}`');
      open = false;
    } else if (c === ',' && !open) {
      items.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  if (open) fail('unclosed `{`');
  items.push(selector.slice(start));
  return items;
}

/** Expand every brace group of one list item. Braces are known to balance. */
function expandBraces(item: string, budget: number, fail: Fail): string[] {
  let expanded = [''];
  let i = 0;
  for (;;) {
    const open = item.indexOf('{', i);
    if (open < 0) break;
    const close = item.indexOf('}', open);
    const prefix = item.slice(i, open);
    const alternatives = item.slice(open + 1, close).split(',');
    for (const alternative of alternatives) checkEnds(alternative, 'brace alternative', fail);
    if (expanded.length * alternatives.length > budget) {
      fail(`expands to more than ${MAX_SELECTOR_PATTERNS} patterns`);
    }
    expanded = expanded.flatMap((head) =>
      alternatives.map((alternative) => head + prefix + alternative),
    );
    i = close + 1;
  }
  const rest = item.slice(i);
  return expanded.map((head) => head + rest);
}

/** Literal text as a GLOB: `[` would open a character class, so it is bracketed. */
function literalGlob(text: string): string {
  return text.replaceAll('[', '[[]');
}

function compilePattern(
  pattern: string,
  fail: Fail,
): Array<{ glob: string; slashes: number | null }> {
  const bad = (reason: string): never => fail(`pattern ${JSON.stringify(pattern)} ${reason}`);
  if (CONTROL_CHARACTER.test(pattern)) bad('contains a control character');
  if (pattern.includes('\\')) bad('contains a backslash; paths are POSIX');
  if (pattern.startsWith('/')) bad('is absolute; selectors are repo-relative');
  const segments = pattern.split('/');
  for (const segment of segments) {
    if (segment === '') bad('has an empty segment');
    if (segment === '.' || segment === '..') bad(`has a \`${segment}\` segment`);
    if (segment !== '**' && segment.includes('**'))
      bad('uses `**` inside a segment; it must be a whole segment');
  }

  const at = segments.indexOf('**');
  if (at < 0) return [{ glob: literalGlob(pattern), slashes: segments.length - 1 }];
  if (segments.lastIndexOf('**') !== at) bad('uses `**` more than once');

  const head = segments.slice(0, at);
  const tail = segments.slice(at + 1);
  if (head.some((segment) => WILDCARD.test(segment))) bad('has a wildcard before `**`');
  const prefix = head.length === 0 ? '' : `${literalGlob(head.join('/'))}/`;

  if (tail.length === 0) return [{ glob: `${prefix}*`, slashes: null }];
  const only = tail[0] as string;
  if (tail.length === 1 && only.startsWith('*') && !WILDCARD.test(only.slice(1))) {
    return [{ glob: `${prefix}*${literalGlob(only.slice(1))}`, slashes: null }];
  }
  if (!tail.some((segment) => WILDCARD.test(segment))) {
    const literal = literalGlob(tail.join('/'));
    return [
      { glob: `${prefix}${literal}`, slashes: null },
      { glob: `${prefix}*/${literal}`, slashes: null },
    ];
  }
  return bad('follows `**` with something other than `*suffix` in one segment or a literal path');
}

/** The in-memory twin of SQLite `GLOB` over the clauses this module emits. */
function globRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '*') {
      out += '[\\s\\S]*';
    } else if (c === '?') {
      out += '[\\s\\S]';
    } else if (glob.startsWith('[[]', i)) {
      out += '\\[';
      i += 2;
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
    }
  }
  return new RegExp(`${out}$`, 'u');
}

function slashCount(path: string): number {
  return path.split('/').length - 1;
}

/** Parse, validate and compile a selector. Throws `SelectorError`. */
export function compileSelector(selector: string): CompiledSelector {
  const fail: Fail = (reason) => {
    throw new SelectorError(selector, reason);
  };
  if (selector.length === 0) fail('empty selector');

  const patterns: string[] = [];
  const seenPatterns = new Set<string>();
  const clauses: GlobClause[] = [];
  const seenClauses = new Set<string>();
  let budget = MAX_SELECTOR_PATTERNS;
  for (const rawItem of splitList(selector, fail)) {
    checkEnds(rawItem, 'pattern', fail);
    const negated = rawItem.startsWith('!');
    const item = negated ? rawItem.slice(1) : rawItem;
    if (negated) checkEnds(item, 'exclusion', fail);
    for (const pattern of expandBraces(item, budget, fail)) {
      const seenKey = `${negated ? '!' : ''}${pattern}`;
      if (seenPatterns.has(seenKey)) continue;
      seenPatterns.add(seenKey);
      if (!negated) patterns.push(pattern);
      budget -= 1;
      if (budget < 0) fail(`expands to more than ${MAX_SELECTOR_PATTERNS} patterns`);
      for (const clause of compilePattern(pattern, fail)) {
        const key = `${clause.glob}\u0000${String(clause.slashes)}\u0000${String(negated)}`;
        if (seenClauses.has(key)) continue;
        seenClauses.add(key);
        clauses.push({ ...clause, negated });
      }
    }
  }
  if (patterns.length === 0)
    fail('has no positive pattern; an exclusion needs something to exclude from');

  const matchers = clauses.map((clause) => ({
    regex: globRegExp(clause.glob),
    slashes: clause.slashes,
    negated: clause.negated,
  }));
  const hit = (m: (typeof matchers)[number], path: string): boolean =>
    (m.slashes === null || slashCount(path) === m.slashes) && m.regex.test(path);
  return {
    selector,
    patterns,
    clauses,
    matches: (path) =>
      matchers.some((m) => !m.negated && hit(m, path)) &&
      !matchers.some((m) => m.negated && hit(m, path)),
  };
}

/** The reason a selector is invalid, or `undefined` when it compiles. */
export function selectorProblem(selector: string): string | undefined {
  try {
    compileSelector(selector);
    return undefined;
  } catch (e) {
    if (e instanceof SelectorError) return e.message;
    throw e;
  }
}

/** Whether the compiled selector has an exclusion (`!pattern`) clause. */
export function selectorHasExclusions(compiled: CompiledSelector): boolean {
  return compiled.clauses.some((clause) => clause.negated);
}

/**
 * The value to bind for `selectorPredicateSql`'s parameter. A selector with no
 * exclusion binds `[glob, slashes]` pairs, exactly as before exclusions existed;
 * one with an exclusion adds a third element, 1 for a negated clause.
 */
export function selectorParam(compiled: CompiledSelector): string {
  const withExclusions = selectorHasExclusions(compiled);
  return JSON.stringify(
    compiled.clauses.map((clause) =>
      withExclusions
        ? [clause.glob, clause.slashes, clause.negated ? 1 : 0]
        : [clause.glob, clause.slashes],
    ),
  );
}

/**
 * SQL that is true when `column` matches at least one non-negated clause bound
 * to `param` (see `selectorParam`) and, when `withExclusions` is true, no
 * negated one. A selector without an exclusion (`selectorHasExclusions` false)
 * gets exactly the predicate it had before exclusions existed, so every
 * extractor that never writes a `!` keeps its SQL, and its cost, unchanged.
 * The clauses travel as one JSON array rather than an `OR` chain because
 * SQLite caps expression depth at 1000, which a long list of literal paths
 * would exceed. `column` must be table-qualified: `json_each` has a `path`
 * column of its own.
 */
export function selectorPredicateSql(
  column: string,
  param: string,
  withExclusions: boolean,
): string {
  const matching = (
    negated: 0 | 1 | undefined,
  ): string => `SELECT 1 FROM json_each(${param}) AS clause
    WHERE ${negated === undefined ? '' : `json_extract(clause.value, '$[2]') = ${negated}\n      AND `}${column} GLOB json_extract(clause.value, '$[0]')
      AND (json_extract(clause.value, '$[1]') IS NULL
        OR length(${column}) - length(replace(${column}, '/', '')) = json_extract(clause.value, '$[1]'))`;
  if (!withExclusions) return `(${column} IS NOT NULL AND EXISTS (\n    ${matching(undefined)}))`;
  return `(${column} IS NOT NULL AND EXISTS (${matching(0)}) AND NOT EXISTS (${matching(1)}))`;
}

// ---------------------------------------------------------------------------
// What a claim covers
// ---------------------------------------------------------------------------

export type CompiledAuthoritySelector = CompiledSelector | CompiledCanonicalSelector;

export function isCanonicalCompiled(selector: CompiledAuthoritySelector): selector is CompiledCanonicalSelector {
  return 'domain' in selector && selector.domain === 'canonical';
}

const compiledByScope = new WeakMap<AuthoritativeScope, CompiledAuthoritySelector>();

/**
 * The compiled selector of a claim, or `undefined` when it has none. Compiled
 * once per claim object, which a run shares across every fact it is asked
 * about. Throws `SelectorError` for a selector that does not compile.
 */
export function compiledSelectorOf(scope: AuthoritativeScope): CompiledAuthoritySelector | undefined {
  if (scope.selector === undefined) return undefined;
  const canonical = isCanonicalSelectorText(scope.selector);
  if (canonical && scope.kinds.length === 0)
    throw new SelectorError(scope.selector, 'canonical authority requires node kinds');
  let compiled = compiledByScope.get(scope);
  if (compiled === undefined || compiled.selector !== scope.selector) {
    compiled = canonical ? compileCanonicalSelector(scope.selector) : compileSelector(scope.selector);
    compiledByScope.set(scope, compiled);
  }
  return compiled;
}

/** Manifest/result boundary: budget the whole claim set before decoding any body. */
export function assertAuthoritySelectors(scopes: readonly AuthoritativeScope[]): void {
  assertCanonicalSelectorBudget(scopes);
  for (const scope of scopes) compiledSelectorOf(scope);
}

/** The two fields of an edge that say which files it lives in. */
export interface EdgeFiles {
  readonly srcFile?: string | undefined;
  readonly dstFile?: string | undefined;
  readonly src?: string | undefined;
  readonly dst?: string | undefined;
}

/** The file an edge is judged by: its source file, else its destination file. */
export function edgeAnchor(edge: EdgeFiles): string | undefined {
  return edge.srcFile ?? edge.dstFile;
}

/**
 * SQL for `edgeAnchor` over the `edges` table (or an alias of it). Table
 * qualified, as `selectorPredicateSql` requires of its column.
 */
export function edgeAnchorSql(table: string): string {
  return `COALESCE(${table}.src_file, ${table}.dst_file)`;
}

/**
 * Whether a claim's selector narrows the edges of its scope. It does not when
 * the claim names no node kinds: there is nothing for a path filter to narrow,
 * so the selector is a label and the claim covers its scope's edges whole.
 */
export function selectorNarrowsEdges(scope: AuthoritativeScope): boolean {
  return scope.selector !== undefined && scope.kinds.length > 0;
}

/** Whether `scope` is the authority for a node. See "What a claim covers". */
export function claimCoversNode(
  scope: AuthoritativeScope,
  node: AuthorityNode,
  context?: AuthorityContext,
): boolean {
  const selector = compiledSelectorOf(scope);
  if (!scope.kinds.includes(node.kind)) return false;
  if (selector === undefined) return true;
  if (isCanonicalCompiled(selector)) return canonicalClaimCoversNode(scope, selector, node, context);
  return node.path !== undefined && selector.matches(node.path);
}

/**
 * Whether `scope` is the authority for an edge stored under `edgeScope`. See
 * "What a claim covers".
 */
export function claimCoversEdge(
  scope: AuthoritativeScope,
  edgeScope: string,
  edge: EdgeFiles,
  context?: AuthorityContext,
): boolean {
  if (scope.scope !== edgeScope) return false;
  const selector = compiledSelectorOf(scope);
  if (selector !== undefined && isCanonicalCompiled(selector))
    return canonicalClaimCoversEdge(scope, selector, edge, context);
  if (selector === undefined || !selectorNarrowsEdges(scope)) return true;
  const anchor = edgeAnchor(edge);
  return anchor !== undefined && selector.matches(anchor);
}
