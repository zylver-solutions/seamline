/**
 * Rename ingestion — `git diff -M` records into alias rows (v3 §2.1).
 *
 * Two signals are combined. Git's own similarity index is the primary one, and
 * a rename below the threshold is deliberately *not* an alias: a low-similarity
 * pair is a delete plus an add, and asserting an alias there would silently
 * merge two unrelated histories. Optional content hashes are the second signal
 * and only ever promote: identical bytes at both ends is a certain rename no
 * matter what the heuristic said.
 */

import { parseNodeId, type NodeId, type NodeKind } from '@seamline/ontology';

import { AliasTable, type AliasRow } from './alias.ts';
import { columnName, fileName, makeNodeId, symbolName, type DataLocation, type SymbolNameParts } from './canonical.ts';

/**
 * Above git's own `-M` default of 0.5, and equal to `extract-change`'s rename
 * threshold, because an alias welds two histories together and is hard to
 * take back. Overridable per call via `similarityThreshold`.
 */
export const DEFAULT_RENAME_SIMILARITY = 0.6;

export interface GitRenameRecord {
  /** Repo-relative POSIX path before the rename. */
  readonly from: string;
  /** Repo-relative POSIX path after the rename. */
  readonly to: string;
  /** Similarity index in `[0, 1]`. `parseGitRenameStatus` normalizes git's 0-100. */
  readonly similarity: number;
}

export interface RenameIngestOptions {
  readonly repo: string;
  readonly runId: string;
  /** Defaults to `DEFAULT_RENAME_SIMILARITY`. */
  readonly similarityThreshold?: number;
  /** Optional path to content-hash map covering either side of a rename. */
  readonly contentHashes?: ReadonlyMap<string, string>;
}

export const RENAME_REJECTIONS = ['identical-endpoints', 'below-threshold'] as const;
export type RenameRejectionReason = (typeof RENAME_REJECTIONS)[number];

export interface RenameRejection {
  readonly record: GitRenameRecord;
  readonly reason: RenameRejectionReason;
}

export interface RenameIngestResult {
  readonly aliases: ReadonlyArray<AliasRow>;
  readonly rejected: ReadonlyArray<RenameRejection>;
}

const RENAME_STATUS = /^R(\d{1,3})$/;

/**
 * Parse one `git diff -M --name-status -z`-style record, e.g.
 * `R096\told/path.ts\tnew/path.ts`. Returns `null` for a non-rename line.
 * This is the only place git's 0-100 similarity is converted; the rest of the
 * API takes `[0, 1]` and throws on anything else.
 */
export function parseGitRenameStatus(line: string): GitRenameRecord | null {
  const parts = line.split('\t');
  const status = parts[0];
  const from = parts[1];
  const to = parts[2];
  if (status === undefined || from === undefined || to === undefined) return null;
  const m = RENAME_STATUS.exec(status.trim());
  if (m === null) return null;
  const raw = Number(m[1]);
  if (!Number.isFinite(raw) || raw > 100) {
    throw new Error(`malformed git rename status ${JSON.stringify(status)}`);
  }
  return { from: from.trim(), to: to.trim(), similarity: raw / 100 };
}

function assertSimilarity(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `similarity must be within [0, 1], got ${value}; use parseGitRenameStatus to normalize git's 0-100`,
    );
  }
  return value;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Ingest file renames. Produces `File` alias rows only. A `git mv` changes no
 * other id, unless it changes an input that the id is built from; ADR-0016
 * item 4 lists those inputs, and those changes are not aliased here.
 */
export function ingestFileRenames(
  records: ReadonlyArray<GitRenameRecord>,
  options: RenameIngestOptions,
): RenameIngestResult {
  const threshold = assertSimilarity(options.similarityThreshold ?? DEFAULT_RENAME_SIMILARITY);
  const hashes = options.contentHashes;
  const aliases: AliasRow[] = [];
  const rejected: RenameRejection[] = [];

  for (const record of records) {
    const similarity = assertSimilarity(record.similarity);
    const from = fileName(record.from);
    const to = fileName(record.to);
    if (from === to) {
      rejected.push({ record, reason: 'identical-endpoints' });
      continue;
    }
    const fromHash = hashes?.get(from);
    const toHash = hashes?.get(to);
    const hashMatch = fromHash !== undefined && fromHash === toHash;
    if (!hashMatch && similarity < threshold) {
      rejected.push({ record, reason: 'below-threshold' });
      continue;
    }
    aliases.push({
      from: makeNodeId(options.repo, 'File', from),
      to: makeNodeId(options.repo, 'File', to),
      runId: options.runId,
      confidence: hashMatch ? 1 : similarity,
      reason: hashMatch ? 'content-hash' : 'git-rename',
    });
  }

  aliases.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  return { aliases, rejected };
}

export interface SymbolRename {
  readonly from: SymbolNameParts;
  readonly to: SymbolNameParts;
  readonly similarity?: number;
}

/**
 * Ingest symbol renames. A symbol id changes only when its *canonical
 * qualified name* changes, which a file move within a package never does, so
 * these come from an actual identifier or module-export rename, not from a
 * `git mv` inside one package.
 */
export function ingestSymbolRenames(
  renames: ReadonlyArray<SymbolRename>,
  options: RenameIngestOptions,
): RenameIngestResult {
  const threshold = assertSimilarity(options.similarityThreshold ?? DEFAULT_RENAME_SIMILARITY);
  const aliases: AliasRow[] = [];
  const rejected: RenameRejection[] = [];

  for (const rename of renames) {
    const from = symbolName(rename.from);
    const to = symbolName(rename.to);
    const similarity = assertSimilarity(rename.similarity ?? 1);
    const record: GitRenameRecord = { from, to, similarity };
    if (from === to) {
      rejected.push({ record, reason: 'identical-endpoints' });
      continue;
    }
    if (similarity < threshold) {
      rejected.push({ record, reason: 'below-threshold' });
      continue;
    }
    aliases.push({
      from: makeNodeId(options.repo, 'Symbol', from),
      to: makeNodeId(options.repo, 'Symbol', to),
      runId: options.runId,
      confidence: similarity,
      reason: 'git-rename',
    });
  }

  aliases.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  return { aliases, rejected };
}

export interface ColumnRename {
  readonly from: Pick<DataLocation, 'dataSource' | 'schema'> & { readonly table: string; readonly column: string };
  readonly to: Pick<DataLocation, 'dataSource' | 'schema'> & { readonly table: string; readonly column: string };
  readonly similarity?: number;
}

/** Column renames, e.g. from a migration that runs `ALTER TABLE ... RENAME COLUMN`. */
export function ingestColumnRenames(
  renames: ReadonlyArray<ColumnRename>,
  options: RenameIngestOptions,
): RenameIngestResult {
  const threshold = assertSimilarity(options.similarityThreshold ?? DEFAULT_RENAME_SIMILARITY);
  const aliases: AliasRow[] = [];
  const rejected: RenameRejection[] = [];

  for (const rename of renames) {
    const from = columnName(rename.from);
    const to = columnName(rename.to);
    const similarity = assertSimilarity(rename.similarity ?? 1);
    const record: GitRenameRecord = { from, to, similarity };
    if (from === to) {
      rejected.push({ record, reason: 'identical-endpoints' });
      continue;
    }
    if (similarity < threshold) {
      rejected.push({ record, reason: 'below-threshold' });
      continue;
    }
    aliases.push({
      from: makeNodeId(options.repo, 'Column', from),
      to: makeNodeId(options.repo, 'Column', to),
      runId: options.runId,
      confidence: similarity,
      reason: 'git-rename',
    });
  }

  aliases.sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to));
  return { aliases, rejected };
}

/** Convenience: ingest into a table in one step. */
export function applyRenames(table: AliasTable, result: RenameIngestResult): AliasTable {
  table.addAll(result.aliases);
  return table;
}

/** The retired ids a result introduces, for callers that want to diff. */
export function retiredIds(result: RenameIngestResult): ReadonlyArray<NodeId> {
  return result.aliases.map((a) => a.from);
}

/** Kind of a retired id, without re-parsing at every call site. */
export function retiredKind(id: NodeId): NodeKind {
  return parseNodeId(id).kind;
}
