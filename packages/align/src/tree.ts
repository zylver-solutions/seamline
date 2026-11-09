/**
 * The evaluated tree: the tracked files of one commit, read from the git object
 * database (or, with `--worktree`, from the working tree).
 *
 * Probes see the tree only through this interface: a sorted list of tracked
 * regular files and their bytes. Nothing here runs repository code. The only
 * process this module starts is `git`, and only to read objects or the index
 * (design section 5.2, "No network, no execution"). It starts it through
 * `spawnUntrustedGit`, so the repository's own `.git/config` and attributes cannot
 * name a program for git to run (untrusted repository git configuration).
 */

import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnUntrustedGit } from '@seamline/core';
import { usageFailure, runtimeFailure } from './errors.ts';
import { basename, compareCodeUnits, extname } from './util.ts';

export interface Tree {
  /** Tracked regular files, repo-relative POSIX paths, sorted by code unit. */
  readonly tracked: readonly string[];
  /** Size in bytes, or `null` when the file is not in the tree or its size cannot be told. */
  size(path: string): number | null;
  /** The file's bytes, or `null` when the path is not tracked or the blob cannot be read. */
  read(path: string): Uint8Array | null;
}

const decoder = new TextDecoder('utf-8');

/** Text of a file, a leading byte order mark removed; `null` when it cannot be read. */
export function readText(tree: Tree, path: string): string | null {
  const bytes = tree.read(path);
  if (bytes === null) return null;
  const text = decoder.decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** An in-memory tree, for tests and fixtures. */
export function memTree(files: Readonly<Record<string, string>>): Tree {
  const encoder = new TextEncoder();
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) bytes.set(path, encoder.encode(content));
  const tracked = [...bytes.keys()].sort(compareCodeUnits);
  return {
    tracked,
    size: (path) => bytes.get(path)?.length ?? null,
    read: (path) => bytes.get(path) ?? null,
  };
}

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** The files a probe or the scanner may read. Anything else is known by name only. */
export function isInputFile(path: string): boolean {
  const base = basename(path);
  if (base === 'package.json' || base === 'pnpm-workspace.yaml') return true;
  if (/^tsconfig.*\.json$/.test(base)) return true;
  if (/\.d\.[cm]?ts$/.test(base)) return false;
  const ext = extname(path);
  return ext === '.md' || SOURCE_EXTENSIONS.includes(ext);
}

/** Blobs above this size are not read into memory; their size still reaches the engine. */
const MAX_PRELOAD_BYTES = 8 * 1024 * 1024;

/** The bare name: the lookup uses the PATH `spawnUntrustedGit` builds, which has no entry inside the repository. */
const GIT = 'git';

function git(repoRoot: string, args: readonly string[]): Buffer {
  const result = spawnUntrustedGit(GIT, repoRoot, args, {
    encoding: 'buffer',
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error === undefined && result.status === 0) return result.stdout;
  const stderr = result.stderr?.toString('utf8').trim();
  const reason = result.error !== undefined ? result.error.message : stderr?.split('\n')[0];
  throw runtimeFailure(
    `git ${args[0] ?? ''} failed in ${repoRoot}${reason ? `: ${reason}` : ''}`,
    'Run `seamline align` inside a git repository, with git installed.',
  );
}

/** Resolve a revision to a full commit SHA. An unknown revision is a usage error. */
export function resolveCommit(repoRoot: string, rev: string): string {
  if (rev.length === 0 || rev.startsWith('-')) {
    throw usageFailure(`\`${rev}\` is not a revision.`, 'Pass a commit, branch or tag to --at.');
  }
  const result = spawnUntrustedGit(GIT, repoRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${rev}^{commit}`,
  ]);
  // Git was refused or could not be started: that is a failure, not an unknown revision.
  if (result.error !== undefined) {
    throw runtimeFailure(
      `git rev-parse failed in ${repoRoot}: ${result.error.message}`,
      'Run `seamline align` inside a git repository, with git installed.',
    );
  }
  const sha = (result.stdout ?? '').trim();
  if (result.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw usageFailure(
      `unknown revision \`${rev}\`.`,
      'Pass a commit, branch or tag that exists in this repository to --at.',
    );
  }
  return sha;
}

interface TreeEntry {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
}

function parseLsTree(output: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.toString('utf8').split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const match = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)$/.exec(record.slice(0, tab));
    if (match === null) continue;
    // Regular files only: a symbolic link (120000) or a submodule (160000) is not a document or a source file.
    if (match[2] !== 'blob' || (match[1] !== '100644' && match[1] !== '100755')) continue;
    entries.push({
      path: record.slice(tab + 1),
      sha: match[3] ?? '',
      size: match[4] === '-' ? 0 : Number(match[4]),
    });
  }
  return entries;
}

/** `git cat-file --batch` over the given object names; returns object bytes by SHA. */
function readBlobs(repoRoot: string, shas: readonly string[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (shas.length === 0) return out;
  const result = spawnUntrustedGit(GIT, repoRoot, ['cat-file', '--batch'], {
    encoding: 'buffer',
    input: `${shas.join('\n')}\n`,
    maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0 || !(result.stdout instanceof Buffer)) {
    throw runtimeFailure(
      `git cat-file failed in ${repoRoot}${result.error !== undefined ? `: ${result.error.message}` : ''}`,
      'Run `seamline align` inside a git repository, with git installed.',
    );
  }
  const buf = result.stdout;
  let pos = 0;
  while (pos < buf.length) {
    const eol = buf.indexOf(0x0a, pos);
    if (eol < 0) break;
    const header = buf.toString('utf8', pos, eol).split(' ');
    pos = eol + 1;
    const size = Number(header[2]);
    if (header[1] !== 'blob' || !Number.isInteger(size)) continue;
    out.set(header[0] ?? '', buf.subarray(pos, pos + size));
    pos += size + 1;
  }
  return out;
}

/** The tree of one commit, read from the object database. */
export function gitTree(repoRoot: string, commit: string): Tree {
  const entries = parseLsTree(git(repoRoot, ['ls-tree', '-r', '-l', '-z', commit])).sort((a, b) =>
    compareCodeUnits(a.path, b.path),
  );
  const wanted = entries.filter((e) => isInputFile(e.path) && e.size <= MAX_PRELOAD_BYTES);
  const blobs = readBlobs(repoRoot, [...new Set(wanted.map((e) => e.sha))]);
  const sizes = new Map(entries.map((e) => [e.path, e.size] as const));
  const bytes = new Map<string, Uint8Array>();
  for (const e of wanted) {
    const blob = blobs.get(e.sha);
    if (blob !== undefined) bytes.set(e.path, blob);
  }
  return {
    tracked: entries.map((e) => e.path),
    size: (path) => sizes.get(path) ?? null,
    read: (path) => bytes.get(path) ?? null,
  };
}

/** The tracked files of the working tree (`--worktree`), read from disk. */
export function worktreeTree(repoRoot: string): Tree {
  const names = git(repoRoot, ['ls-files', '-z', '--cached'])
    .toString('utf8')
    .split('\0')
    .filter((p) => p.length > 0);
  const tracked: string[] = [];
  const sizes = new Map<string, number>();
  for (const name of [...new Set(names)].sort(compareCodeUnits)) {
    try {
      const stat = lstatSync(join(repoRoot, name));
      if (!stat.isFile()) continue;
      tracked.push(name);
      sizes.set(name, stat.size);
    } catch {
      // Tracked but deleted in the working tree: not a file the report can read.
    }
  }
  return {
    tracked,
    size: (path) => sizes.get(path) ?? null,
    read: (path) => {
      const size = sizes.get(path);
      if (size === undefined || !isInputFile(path) || size > MAX_PRELOAD_BYTES) return null;
      try {
        return readFileSync(join(repoRoot, path));
      } catch {
        return null;
      }
    },
  };
}
