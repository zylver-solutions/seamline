/**
 * `extract-change` as a program the sandbox host can run. See `code-ts.ts`.
 */

import type { ExtractorResult, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import {
  AliasTable,
  ingestFileRenames,
  makeNodeId,
  materializeAliases,
  type GitRenameRecord,
} from '@seamline/core';
import {
  CHANGE_MANIFEST,
  CHANGE_SCOPE,
  EXTRACTOR_NAME,
  EXTRACTOR_VERSION,
  extractChange,
  type ChangeExtractorOptions,
  type RenameLedger,
} from '@seamline/extract-change';
import type { ExtractContext, ExtractorOutput } from '../ports.ts';
import { boolOpt, numberOpt, stringOpt } from './options.ts';

export { EXTRACTOR_NAME as NAME, EXTRACTOR_VERSION as VERSION, CHANGE_MANIFEST as MANIFEST };

export async function run(ctx: ExtractContext): Promise<ExtractorOutput> {
  const depth = numberOpt(ctx.options, 'depth');
  const since = stringOpt(ctx.options, 'since');
  const until = stringOpt(ctx.options, 'until');
  const renameThreshold = numberOpt(ctx.options, 'renameThreshold');
  const detectCopies = boolOpt(ctx.options, 'detectCopies');
  // `gitBin` is the bare name `git`, or exactly the path the sandbox host found for it (see types.ts).
  const gitBin = stringOpt(ctx.options, 'gitBin');
  const maxBufferBytes = numberOpt(ctx.options, 'maxBufferBytes');
  const options: ChangeExtractorOptions = {
    repoRoot: ctx.repoRoot,
    repo: ctx.repo,
    runId: ctx.runId,
    ...(depth === undefined ? {} : { depth }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    ...(renameThreshold === undefined ? {} : { renameThreshold }),
    ...(detectCopies === undefined ? {} : { detectCopies }),
    ...(gitBin === undefined ? {} : { gitBin }),
    ...(maxBufferBytes === undefined ? {} : { maxBufferBytes }),
  };
  const output = extractChange(options);
  // Unlike the other three extractors, `extractChange` reports real
  // wall-clock `durationMs` unconditionally: it has no `deterministic`
  // option at all (confirmed empirically: the determinism gate found a
  // byte diff in `extractor_results.duration_ms` between two runs of
  // this repo's own history). `ExtractorResult.durationMs` is run
  // telemetry, not a graph fact (v3 §2.3), but `SqliteStore.finalizeRun`
  // still persists it, so the CLI's byte-reproducibility promise has to
  // hold it to the same rule the other three extractors already apply.
  // Freezing it here, in the adapter, is a translation for the CLI's own
  // contract; it does not touch `extractChange`'s status or facts.
  const timed = ctx.deterministic ? { ...output.result, durationMs: 0 } : output.result;
  // File aliases are a deterministic function of this extractor's own rename
  // ledger, so they travel in its batch and scope: `ALIAS_OF` edges are swept
  // with `RENAMED_FROM` when a rename leaves the walked range.
  const aliases = fileRenameAliases(output.renames, ctx.runId);
  const result: ExtractorResult = {
    ...timed,
    nodeCount: timed.nodeCount + aliases.nodes.length,
    edgeCount: timed.edgeCount + aliases.edges.length,
    diagnostics: [...timed.diagnostics, ...aliases.diagnostics],
  };
  return {
    result,
    nodes: [...output.nodes, ...aliases.nodes],
    edges: [{ scope: CHANGE_SCOPE, edges: [...output.edges, ...aliases.edges] }],
  };
}

export interface FileRenameAliases {
  readonly nodes: readonly SeamlineNode[];
  readonly edges: readonly SeamlineEdge[];
  /** One line per rename the identity layer refused to alias. */
  readonly diagnostics: readonly string[];
}

/**
 * `File` aliases from `extract-change`'s rename ledger (v3 §2.1): one `Alias`
 * node per retired path and an `ALIAS_OF` edge to the path it resolves to now,
 * built by `@seamline/core`'s alias table at the ledger's own similarity
 * threshold.
 *
 * - A ledger that did not PASS carries no information, so it yields nothing.
 * - A copy is never an alias: both sides are still live.
 * - Records are folded oldest first, so a path that a later rename moves back
 *   into place is live again and loses its earlier retirement. The ledger
 *   holds renames only, so a path re-created by a plain add keeps its alias.
 * - A rename whose path the identity layer refuses is reported in
 *   `diagnostics` and skipped; it does not fail the extractor.
 *
 * Only file renames are aliased. Symbol-level rename detection is deferred.
 */
export function fileRenameAliases(ledger: RenameLedger, runId: string): FileRenameAliases {
  if (ledger.status !== 'PASS') return { nodes: [], edges: [], diagnostics: [] };
  const retired = new Map<string, GitRenameRecord>();
  const diagnostics: string[] = [];
  for (const record of ledger.records) {
    if (record.kind !== 'rename') continue;
    try {
      makeNodeId(ledger.repo, 'File', record.from);
      makeNodeId(ledger.repo, 'File', record.to);
    } catch (e) {
      diagnostics.push(
        `rename ${record.from} -> ${record.to} not aliased: ${(e as Error).message}`,
      );
      continue;
    }
    retired.delete(record.to);
    retired.set(record.from, { from: record.from, to: record.to, similarity: record.similarity });
  }
  const ingested = ingestFileRenames([...retired.values()], {
    repo: ledger.repo,
    runId,
    similarityThreshold: ledger.threshold,
  });
  const { nodes, edges } = materializeAliases(AliasTable.from(ingested.aliases), runId);
  return { nodes, edges, diagnostics };
}
