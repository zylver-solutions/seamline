/**
 * `infer-join` as a program the sandbox host can run. See `code-ts.ts`.
 *
 * Unlike the four extractors, this one reads no repository file: it infers over
 * the graph the earlier extractors of the same run produced. In-process that
 * graph arrives as `ctx.view`; across the sandbox boundary it arrives as a
 * `GraphSnapshot` (`sandbox/snapshot.ts`) and `run` rebuilds the same view
 * from it.
 */

import type { ExtractorResult, GraphView, SeamlineEdge } from '@seamline/ontology';
import {
  INFER_JOIN_MANIFEST,
  INFER_JOIN_SCOPE,
  INFER_JOIN_VERSION,
  REQUIRED_SCOPES,
  inferJoins,
  toExtractorResult,
  type InferJoinOptions,
  type TaggedAmbiguity,
} from '@seamline/infer-join';
import type { ExtractContext, ExtractorOutput } from '../ports.ts';
import type { GraphSnapshot } from '../sandbox/protocol.ts';
import { viewFromSnapshot } from '../sandbox/snapshot.ts';

export const NAME = INFER_JOIN_MANIFEST.name;
export const VERSION = INFER_JOIN_VERSION;
export const MANIFEST = INFER_JOIN_MANIFEST;
/** The scopes whose status `inferJoins` asks the view about; the sandbox host snapshots exactly these. */
export const SNAPSHOT_SCOPES: ReadonlyArray<string> = REQUIRED_SCOPES;

export interface InferJoinRun {
  readonly result: ExtractorResult;
  readonly edges: readonly SeamlineEdge[];
  /** Ties, dropped fanouts and contended targets, in `inferJoins`' sorted order. */
  readonly ambiguities: readonly TaggedAmbiguity[];
}

/** Runs `@seamline/infer-join` over `view` and packages it the way the store expects. */
export function runInferJoin(
  view: GraphView,
  options: InferJoinOptions,
  deterministic: boolean,
): InferJoinRun {
  const startedAt = deterministic ? 0 : Date.now();
  const inferred = inferJoins(view, options);
  const durationMs = deterministic ? 0 : Date.now() - startedAt;
  return {
    result: toExtractorResult(inferred, durationMs),
    edges: inferred.edges,
    ambiguities: inferred.ambiguities,
  };
}

export async function run(ctx: ExtractContext, graph?: GraphSnapshot): Promise<ExtractorOutput> {
  const view = ctx.view ?? (graph === undefined ? undefined : viewFromSnapshot(graph));
  if (view === undefined) {
    throw new Error(
      'infer-join needs the graph the earlier extractors produced, and none was supplied',
    );
  }
  const options: InferJoinOptions = {
    runId: ctx.runId,
    ...(ctx.options as Partial<InferJoinOptions>),
  };
  const inferred = runInferJoin(view, options, ctx.deterministic);
  return {
    result: inferred.result,
    nodes: [],
    edges: [{ scope: INFER_JOIN_SCOPE, edges: inferred.edges }],
    ambiguities: inferred.ambiguities,
  };
}
