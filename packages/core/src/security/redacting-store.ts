/**
 * The `GraphStore` decorator that makes the Redactor the sole writer to the
 * store. ADR-0011.
 *
 * `createRedactor()`/`redactGraph()` in `@seamline/security`
 * (`packages/security/src/redactor.ts`) are a correct, independently-tested
 * transform from a graph to a redacted graph. Neither
 * calls itself: something has to sit at the one place every node and edge
 * passes through on the way into storage, and that is what this file is.
 *
 * `wrapWithRedaction` is a pure `GraphStore -> GraphStore` decorator, not a
 * pipeline stage bolted onto `extractCommand`. That shape is deliberate
 * (ADR-0011's Alternatives section): it changes zero call sites in
 * `packages/cli/src/commands/extract.ts`, including the `infer-join` special
 * case that reads mid-run store state, and it makes "sole writer" a property
 * of *construction* (there is exactly one place a production `Workspace` is
 * built, and it is wrapped there) rather than a discipline every future write
 * call site has to remember.
 */

import type {
  EdgeKind,
  ExtractorResult,
  ExtractorStatus,
  GraphStore,
  Maybe,
  NodeId,
  NodeKind,
  RunRecord,
  SeamlineEdge,
  SeamlineNode,
  TraverseQuery,
} from '@seamline/ontology';
import { createRedactor, type RedactionReport, type RedactorOptions } from '@seamline/security';

export interface RedactingGraphStore extends GraphStore {
  /** The accumulated report for every write this store instance has made. */
  redactionReport(): RedactionReport;
}

/**
 * Wraps `inner` so every node and edge written through the result has passed
 * through one `Redactor` first. One redactor per wrapper, held for the
 * wrapper's lifetime, so its report covers every write the wrapper made.
 *
 * A node id, an edge endpoint, and the repository-path fields are never
 * rewritten (ADR-0013). A closed-format credential in one of them makes the
 * write reject with a `RedactionError`, and nothing from that call is stored.
 * There is no id remapping to keep consistent across calls, so the cross-call
 * ordering residual ADR-0011 recorded no longer exists.
 *
 * Every method other than `upsertNodes`/`upsertEdges` passes through to
 * `inner` untouched: reads carry no write obligation, and `beginRun`/
 * `finalizeRun`/`traverse`/`close` do not touch node or edge string fields.
 */
export function wrapWithRedaction(
  inner: GraphStore,
  options?: RedactorOptions,
): RedactingGraphStore {
  const redactor = createRedactor(options);

  return {
    beginRun(run: Omit<RunRecord, 'finishedAt' | 'results'>): Promise<void> {
      return inner.beginRun(run);
    },

    upsertNodes(runId: string, nodes: ReadonlyArray<SeamlineNode>): Promise<void> {
      // A refusal is a rejected promise, like every other store failure, not a
      // synchronous throw out of a method that returns a promise.
      try {
        const { nodes: redacted } = redactor.redactGraph(nodes, []);
        return inner.upsertNodes(runId, redacted);
      } catch (e) {
        return Promise.reject(e);
      }
    },

    upsertEdges(runId: string, scope: string, edges: ReadonlyArray<SeamlineEdge>): Promise<void> {
      try {
        const { edges: redacted } = redactor.redactGraph([], edges);
        return inner.upsertEdges(runId, scope, redacted);
      } catch (e) {
        return Promise.reject(e);
      }
    },

    finalizeRun(runId: string, results: ReadonlyArray<ExtractorResult>): Promise<void> {
      return inner.finalizeRun(runId, results);
    },

    traverse(q: TraverseQuery): Promise<Maybe<ReadonlyArray<SeamlineNode>>> {
      return inner.traverse(q);
    },

    close(): Promise<void> {
      return inner.close();
    },

    nodesByKind(kind: NodeKind): ReadonlyArray<SeamlineNode> {
      return inner.nodesByKind(kind);
    },

    node(id: NodeId): SeamlineNode | undefined {
      return inner.node(id);
    },

    edgesFrom(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
      return inner.edgesFrom(id, kind);
    },

    edgesTo(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
      return inner.edgesTo(id, kind);
    },

    scopeStatus(scope: string): ExtractorStatus {
      return inner.scopeStatus(scope);
    },

    redactionReport(): RedactionReport {
      return redactor.redactionReport();
    },
  };
}
