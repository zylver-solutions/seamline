/**
 * `eval/mutants.json`: injected contradictions, and how they are scored.
 *
 * A mutant is a small, named edit to a scratch copy of a corpus repository
 * that is meant to create exactly one contradiction a detector should report.
 * It counts as detected when the mutated run reports a finding with the
 * expected code (and matching subjects, when the mutant names them) whose id
 * the unmodified run did not have.
 *
 * An edit that does not apply cleanly fails the mutant loudly. A `find` string
 * that matches nothing, or matches twice, means the mutant is no longer the
 * edit its author reviewed, and silently picking an occurrence would turn
 * recall into a measurement of the wrong thing.
 */

import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONTRADICTION_CODES, type ContradictionCode } from '@seamline/ontology';
import { ConfigError } from './errors.ts';
import { roleProblem } from './roles.ts';
import type {
  CorpusEntry,
  Finding,
  Mutant,
  MutantEdit,
  MutantEditAppend,
  MutantEditJson,
  MutantEditReplace,
  MutantExpect,
} from './types.ts';

export class MutantEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutantEditError';
  }
}

function isCode(v: unknown): v is ContradictionCode {
  return typeof v === 'string' && (CONTRADICTION_CODES as readonly string[]).includes(v);
}

export function isReplaceEdit(edit: MutantEdit): edit is MutantEditReplace {
  return 'find' in edit;
}

export function isJsonEdit(edit: MutantEdit): edit is MutantEditJson {
  return 'pointer' in edit;
}

function isAppendEdit(edit: MutantEdit): edit is MutantEditAppend {
  return 'append' in edit;
}

/** Validates a repo-relative POSIX path: no absolute path, no `..`, no backslash. */
export function isSafeRelativePath(p: string): boolean {
  if (p === '' || p.includes('\0') || p.includes('\\') || p.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function parseEdit(raw: unknown, where: string, problems: string[]): MutantEdit | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push(`${where}: an edit must be an object.`);
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  const p = rec['path'];
  if (typeof p !== 'string' || !isSafeRelativePath(p)) {
    problems.push(`${where}: "path" must be a repo-relative POSIX path with no "..".`);
    return undefined;
  }
  const hasFind = 'find' in rec;
  const hasAppend = 'append' in rec;
  const hasPointer = 'pointer' in rec;
  if ([hasFind, hasAppend, hasPointer].filter(Boolean).length !== 1) {
    problems.push(
      `${where}: an edit is exactly one of {find, replace}, {append}, or {pointer, set | remove | renameKey}.`,
    );
    return undefined;
  }
  if (hasPointer) {
    const pointer = rec['pointer'];
    if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer === '/') {
      problems.push(`${where}: "pointer" must be a JSON Pointer such as /paths/~1users/get.`);
      return undefined;
    }
    const ops = ['set', 'remove', 'renameKey'].filter((k) => k in rec);
    if (ops.length !== 1) {
      problems.push(`${where}: a pointer edit has exactly one of "set", "remove", or "renameKey".`);
      return undefined;
    }
    if ('set' in rec) return { path: p, pointer, set: rec['set'] };
    if ('remove' in rec) {
      if (rec['remove'] !== true) {
        problems.push(`${where}: "remove" must be true.`);
        return undefined;
      }
      return { path: p, pointer, remove: true };
    }
    const renameKey = rec['renameKey'];
    if (typeof renameKey !== 'string' || renameKey === '') {
      problems.push(`${where}: "renameKey" must be a non-empty string.`);
      return undefined;
    }
    return { path: p, pointer, renameKey };
  }
  if (hasAppend) {
    const append = rec['append'];
    if (typeof append !== 'string' || append === '') {
      problems.push(`${where}: "append" must be a non-empty string.`);
      return undefined;
    }
    return { path: p, append };
  }
  const find = rec['find'];
  const replace = rec['replace'];
  if (typeof find !== 'string' || find === '') {
    problems.push(`${where}: "find" must be a non-empty string.`);
    return undefined;
  }
  if (typeof replace !== 'string') {
    problems.push(`${where}: "replace" must be a string.`);
    return undefined;
  }
  if (find === replace) {
    problems.push(`${where}: "replace" equals "find", so the edit changes nothing.`);
    return undefined;
  }
  return { path: p, find, replace };
}

/**
 * `corpus` supplies the known repositories and their partitions. A mutant
 * against a sealed repository is refused: building one means reading that
 * repository's source, and the sealed partition is held out.
 */
export function parseMutants(
  raw: unknown,
  corpus: ReadonlyArray<Pick<CorpusEntry, 'name' | 'partition'>>,
): readonly Mutant[] {
  const partitionOf = new Map(corpus.map((c) => [c.name, c.partition]));
  if (!Array.isArray(raw)) throw new ConfigError('mutants.json must be a JSON array of mutants.');
  const problems: string[] = [];
  const mutants: Mutant[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    const where = `mutants[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`${where}: must be an object.`);
      return;
    }
    const rec = item as Record<string, unknown>;
    const id = rec['id'];
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      problems.push(`${where}: "id" must match [a-z0-9][a-z0-9-]*.`);
      return;
    }
    if (seen.has(id)) problems.push(`${id}: duplicate mutant id.`);
    seen.add(id);

    const repo = rec['repo'];
    if (typeof repo !== 'string' || !partitionOf.has(repo)) {
      problems.push(`${id}: "repo" must name a corpus repository.`);
    } else if (partitionOf.get(repo) === 'sealed') {
      problems.push(
        `${id}: "repo" ${repo} is in the sealed partition; mutants are written against dev repositories only.`,
      );
    }
    const detector = rec['detector'];
    if (!isCode(detector)) problems.push(`${id}: "detector" must be a contradiction code.`);
    const description = rec['description'];
    if (typeof description !== 'string' || description.trim() === '') {
      problems.push(`${id}: "description" must say what the edit does.`);
    }

    const editsRaw = rec['edits'];
    const edits: MutantEdit[] = [];
    if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
      problems.push(`${id}: "edits" must be a non-empty array.`);
    } else {
      editsRaw.forEach((e, i) => {
        const edit = parseEdit(e, `${id}.edits[${i}]`, problems);
        if (edit !== undefined) edits.push(edit);
      });
    }

    const expectRaw = rec['expect'];
    let expect: MutantExpect | undefined;
    if (typeof expectRaw !== 'object' || expectRaw === null || Array.isArray(expectRaw)) {
      problems.push(`${id}: "expect" must be an object with a "code".`);
    } else {
      const e = expectRaw as Record<string, unknown>;
      const leftMatch = e['leftMatch'];
      const rightMatch = e['rightMatch'];
      if (!isCode(e['code'])) {
        problems.push(`${id}: "expect.code" must be a contradiction code.`);
      } else if (isCode(detector) && e['code'] !== detector) {
        problems.push(`${id}: "expect.code" must equal "detector" (${detector}).`);
      } else if (
        (leftMatch !== undefined && (typeof leftMatch !== 'string' || leftMatch === '')) ||
        (rightMatch !== undefined && (typeof rightMatch !== 'string' || rightMatch === ''))
      ) {
        problems.push(`${id}: "leftMatch" and "rightMatch" must be non-empty strings when given.`);
      } else {
        expect = {
          code: e['code'],
          ...(leftMatch === undefined ? {} : { leftMatch: leftMatch as string }),
          ...(rightMatch === undefined ? {} : { rightMatch: rightMatch as string }),
        };
        for (const side of ['left', 'right'] as const) {
          const match = side === 'left' ? leftMatch : rightMatch;
          const problem = typeof match === 'string' ? roleProblem(e['code'], side, match) : null;
          if (problem !== null) problems.push(`${id}: ${problem}`);
        }
      }
    }

    if (
      typeof repo === 'string' &&
      isCode(detector) &&
      typeof description === 'string' &&
      edits.length > 0 &&
      expect !== undefined
    ) {
      mutants.push({ id, repo, detector, description, edits, expect });
    }
  });

  if (problems.length > 0) {
    throw new ConfigError(`mutants.json is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return mutants.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Counts occurrences of `needle` in `haystack`, overlapping ones included. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + 1;
  }
}

/**
 * Replaces the single occurrence of `find` in `content`. Throws unless there
 * is exactly one. Uses slicing, never `String.replace`, so `$&` and friends in
 * `replace` are inserted literally.
 */
export function replaceExactlyOnce(
  content: string,
  find: string,
  replace: string,
  label: string,
): string {
  const n = countOccurrences(content, find);
  if (n !== 1) {
    throw new MutantEditError(
      `${label}: expected the "find" text to occur exactly once, found ${n} occurrence(s).`,
    );
  }
  const at = content.indexOf(find);
  return content.slice(0, at) + replace + content.slice(at + find.length);
}

async function resolveInside(root: string, rel: string): Promise<string> {
  if (!isSafeRelativePath(rel))
    throw new MutantEditError(`${rel}: not a repo-relative POSIX path.`);
  const rootReal = await realpath(root);
  const target = path.resolve(rootReal, ...rel.split('/'));
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
    throw new MutantEditError(`${rel}: resolves outside the working tree.`);
  }
  // Refuse to write through a link: a symlink in an untrusted tree can point anywhere.
  let walk = rootReal;
  for (const seg of rel.split('/')) {
    walk = path.join(walk, seg);
    try {
      if ((await lstat(walk)).isSymbolicLink()) {
        throw new MutantEditError(
          `${rel}: ${seg} is a symbolic link; refusing to edit through it.`,
        );
      }
    } catch (e) {
      if (e instanceof MutantEditError) throw e;
      break; // the rest of the path does not exist yet (append may create it)
    }
  }
  return target;
}

function decodePointer(pointer: string, label: string): string[] {
  if (!pointer.startsWith('/') || pointer === '/') {
    throw new MutantEditError(`${label}: "${pointer}" is not a JSON Pointer.`);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return typeof v === 'object' && v !== null;
}

/**
 * Applies a JSON-pointer edit to the text of a JSON document. The pointer must
 * resolve to a parent that exists; `remove` and `renameKey` also need the key
 * to exist, and `renameKey` needs the new key to be free, so an edit written
 * against one version of a document fails loudly on another. The document is
 * written back with two-space indentation and a trailing newline.
 */
function applyJsonEdit(content: string, edit: MutantEditJson, label: string): string {
  let root: unknown;
  try {
    root = JSON.parse(content) as unknown;
  } catch {
    throw new MutantEditError(`${label}: the file is not valid JSON.`);
  }
  const keys = decodePointer(edit.pointer, label);
  const last = keys[keys.length - 1] as string;
  let parent: unknown = root;
  for (const key of keys.slice(0, -1)) {
    parent = isContainer(parent) ? (parent as Record<string, unknown>)[key] : undefined;
    if (parent === undefined) {
      throw new MutantEditError(`${label}: ${edit.pointer} does not resolve (no "${key}").`);
    }
  }
  if (!isContainer(parent) || Array.isArray(parent)) {
    throw new MutantEditError(`${label}: the parent of ${edit.pointer} is not an object.`);
  }
  const obj = parent as Record<string, unknown>;
  const has = Object.prototype.hasOwnProperty.call(obj, last);
  if ('set' in edit) {
    obj[last] = edit.set;
  } else if ('remove' in edit) {
    if (!has) {
      throw new MutantEditError(
        `${label}: ${edit.pointer} does not exist, so it cannot be removed.`,
      );
    }
    delete obj[last];
  } else {
    if (!has) {
      throw new MutantEditError(
        `${label}: ${edit.pointer} does not exist, so it cannot be renamed.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(obj, edit.renameKey)) {
      throw new MutantEditError(
        `${label}: "${edit.renameKey}" already exists next to ${edit.pointer}.`,
      );
    }
    const entries = Object.entries(obj).map(
      ([k, v]) => [k === last ? edit.renameKey : k, v] as const,
    );
    for (const k of Object.keys(obj)) delete obj[k];
    for (const [k, v] of entries) obj[k] = v;
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

/**
 * The text of a file after one edit. `content` is `undefined` for a file that
 * does not exist: only `append` may create one. Shared by the real run and the
 * dry run, so what `check-mutants` accepts is what the run applies.
 */
export function applyEditToContent(
  content: string | undefined,
  edit: MutantEdit,
  label: string,
): string {
  if (isAppendEdit(edit)) return (content ?? '') + edit.append;
  if (content === undefined) throw new MutantEditError(`${label}: the file does not exist.`);
  if (isReplaceEdit(edit)) return replaceExactlyOnce(content, edit.find, edit.replace, label);
  return applyJsonEdit(content, edit, label);
}

/**
 * Applies the edits in order to the tree at `root`. Throws `MutantEditError`
 * on the first edit that does not apply cleanly; the tree is a scratch copy,
 * so a partial application is simply discarded.
 */
export async function applyEdits(root: string, edits: readonly MutantEdit[]): Promise<void> {
  for (const [index, edit] of edits.entries()) {
    const label = `edit ${index + 1} (${edit.path})`;
    const target = await resolveInside(root, edit.path);
    let content: string | undefined;
    try {
      content = await readFile(target, 'utf8');
    } catch {
      content = undefined;
    }
    const next = applyEditToContent(content, edit, label);
    if (content === undefined) await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, next, 'utf8');
  }
}

export interface MutantCheck {
  readonly id: string;
  /** Null when every edit applies. */
  readonly problem: string | null;
}

/**
 * Applies each mutant's edits in memory against the files under `rootOf(repo)`
 * and reports the ones that would fail. Nothing is written and nothing is
 * extracted: this is the cheap check that a mutant still describes the edit
 * its author reviewed, at the pinned commit.
 */
export async function checkMutants(
  mutants: readonly Mutant[],
  rootOf: (repo: string) => string,
): Promise<readonly MutantCheck[]> {
  const results: MutantCheck[] = [];
  for (const mutant of mutants) {
    const root = rootOf(mutant.repo);
    const files = new Map<string, string>();
    let problem: string | null = null;
    for (const [index, edit] of mutant.edits.entries()) {
      const label = `edit ${index + 1} (${edit.path})`;
      if (!isSafeRelativePath(edit.path)) {
        problem = `${label}: not a repo-relative POSIX path.`;
        break;
      }
      let content = files.get(edit.path);
      if (content === undefined) {
        try {
          content = await readFile(path.join(root, ...edit.path.split('/')), 'utf8');
        } catch {
          content = undefined;
        }
      }
      try {
        files.set(edit.path, applyEditToContent(content, edit, label));
      } catch (e) {
        problem = (e as Error).message;
        break;
      }
    }
    results.push({ id: mutant.id, problem });
  }
  return results;
}

export function matchesExpectation(finding: Finding, expect: MutantExpect): boolean {
  if (finding.code !== expect.code) return false;
  if (expect.leftMatch !== undefined && !finding.left.includes(expect.leftMatch)) return false;
  if (expect.rightMatch !== undefined && !finding.right.includes(expect.rightMatch)) return false;
  return true;
}

export interface MutantVerdict {
  readonly detected: boolean;
  /** The finding that satisfied the expectation, when detected. */
  readonly matched: Finding | null;
  /** Every finding in the mutated run whose id the baseline did not have. */
  readonly newFindings: readonly Finding[];
  /** Baseline findings that the mutation made disappear. */
  readonly lostFindings: number;
}

/**
 * Scores one mutant. A match that the baseline already had does not count: a
 * mutant that "detects" a finding that was there before it was applied has
 * detected nothing.
 */
export function judgeMutant(
  baseline: readonly Finding[],
  mutated: readonly Finding[],
  expect: MutantExpect,
): MutantVerdict {
  const before = new Set(baseline.map((f) => f.id));
  const after = new Set(mutated.map((f) => f.id));
  const newFindings = mutated.filter((f) => !before.has(f.id));
  const matched = newFindings.find((f) => matchesExpectation(f, expect)) ?? null;
  const lostFindings = baseline.filter((f) => !after.has(f.id)).length;
  return { detected: matched !== null, matched, newFindings, lostFindings };
}
