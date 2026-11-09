/**
 * `.gitignore` maintenance for `seamline init`.
 *
 * v3 §2.5: the graph is a concentrated map of an organization's attack
 * surface. v2 told users to commit it. This module is where that is prevented,
 * so it is written to be idempotent and to recognise the entry in the forms a
 * user may already have written it in.
 */

import { readFile, writeFile } from 'node:fs/promises';

export const IGNORE_ENTRY = 'seamline-out/';
export const IGNORE_HEADER = '# Seamline: the graph is a map of your attack surface. Do not commit it.';

export interface EnsureIgnoreResult {
  readonly path: string;
  /** 'created' | 'appended' | 'already-present' */
  readonly action: 'created' | 'appended' | 'already-present';
  readonly entry: string;
}

/**
 * True when `line` already ignores `dir`.
 *
 * Accepts the four forms git treats as equivalent for a directory at the repo
 * root (`x`, `x/`, `/x`, `/x/`) plus a leading `./`. A negation (`!x`) is
 * deliberately *not* a match: it re-includes the path, so the entry still has
 * to be added after it.
 */
export function ignoresEntry(line: string, dir: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return false;
  const bare = dir.replace(/\/+$/, '');
  const normalized = trimmed.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized === bare;
}

export function hasIgnoreEntry(content: string, dir: string): boolean {
  return content.split(/\r?\n/).some((line) => ignoresEntry(line, dir));
}

/**
 * Appends `entry` to `content` if it is not already ignored.
 * Returns `undefined` when no change is needed, so callers can avoid a write
 * (and therefore avoid touching mtime on a repeat `init`).
 */
export function appendIgnoreEntry(content: string, entry: string): string | undefined {
  if (hasIgnoreEntry(content, entry)) return undefined;
  const needsNewline = content.length > 0 && !content.endsWith('\n');
  const separator = content.length === 0 ? '' : needsNewline ? '\n\n' : content.endsWith('\n\n') ? '' : '\n';
  return `${content}${separator}${IGNORE_HEADER}\n${entry}\n`;
}

export async function ensureGitignore(gitignorePath: string, entry = IGNORE_ENTRY): Promise<EnsureIgnoreResult> {
  let existing: string | undefined;
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch {
    existing = undefined;
  }

  if (existing === undefined) {
    await writeFile(gitignorePath, `${IGNORE_HEADER}\n${entry}\n`, 'utf8');
    return { path: gitignorePath, action: 'created', entry };
  }

  const next = appendIgnoreEntry(existing, entry);
  if (next === undefined) return { path: gitignorePath, action: 'already-present', entry };
  await writeFile(gitignorePath, next, 'utf8');
  return { path: gitignorePath, action: 'appended', entry };
}
