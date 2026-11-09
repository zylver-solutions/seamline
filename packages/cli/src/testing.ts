/**
 * In-memory test doubles.
 *
 * Kept in `src/` rather than inside one test file because several of the CLI's
 * test files need the same doubles. It is not part of the public surface: the
 * package `exports` map does not reach it, `index.ts` does not re-export it, and
 * `files` leaves it out of the tarball (`pnpm gate:pack` fails if a shipped file
 * still imports it). This is a double, not a store: it has no
 * persistence, no tombstoning, and no merge. The node/edge indexing behind
 * `nodesByKind`/`node`/`edgesFrom`/`edgesTo` comes from `@seamline/core`'s
 * `memoryGraphIndex`, shared with the equivalent doubles in
 * `@seamline/contradictions` and `@seamline/infer-join`; this module keeps
 * only the `GraphStore` write path (`upsertNodes`, `traverse`, run history)
 * on top.
 */

import {
  DEFAULT_SENSITIVITY,
  nodeId,
  type EdgeKind,
  type ExtractorResult,
  type ExtractorStatus,
  type GraphStore,
  type Maybe,
  type NodeId,
  type NodeKind,
  type RunRecord,
  type SeamlineEdge,
  type SeamlineNode,
  type TraverseQuery,
  known,
} from '@seamline/ontology';
import { compareCodeUnits, memoryGraphIndex } from '@seamline/core';
import type { GitPort, OpenStoreOptions, RunHistory, StorePort, Workspace } from './ports.ts';

export interface NodeSeed {
  readonly repo?: string;
  readonly kind: NodeKind;
  readonly canonicalName: string;
  readonly name?: string;
  readonly path?: string;
  readonly provenance?: SeamlineNode['provenance'];
  readonly confidence?: number;
  readonly sensitivity?: SeamlineNode['sensitivity'];
  readonly untrusted?: boolean;
  readonly props?: SeamlineNode['props'];
  readonly sourceRef?: string;
  readonly deletedAt?: string | null;
}

export function makeNode(seed: NodeSeed): SeamlineNode {
  const repo = seed.repo ?? 'demo';
  const id = nodeId(repo, seed.kind, seed.canonicalName);
  const base = {
    id,
    kind: seed.kind,
    name: seed.name ?? seed.canonicalName.split(/[.#/]/).pop() ?? seed.canonicalName,
    sensitivity: seed.sensitivity ?? DEFAULT_SENSITIVITY[seed.kind],
    provenance: seed.provenance ?? 'EXTRACTED',
    confidence: seed.confidence ?? 1,
    props: seed.props ?? {},
    firstSeenRun: 'run-1',
    lastSeenRun: 'run-1',
    deletedAt: seed.deletedAt ?? null,
  };
  return {
    ...base,
    ...(seed.path === undefined ? {} : { path: seed.path }),
    ...(seed.sourceRef === undefined ? {} : { sourceRef: seed.sourceRef }),
    ...(seed.untrusted === undefined ? {} : { untrusted: seed.untrusted }),
  };
}

export interface EdgeSeed {
  readonly kind: EdgeKind;
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly provenance?: SeamlineEdge['provenance'];
  readonly confidence?: number;
  readonly sourceRef?: string;
  readonly props?: SeamlineEdge['props'];
  readonly deletedAt?: string | null;
}

export function makeEdge(seed: EdgeSeed): SeamlineEdge {
  const base = {
    kind: seed.kind,
    src: seed.src,
    dst: seed.dst,
    provenance: seed.provenance ?? 'INFERRED',
    confidence: seed.confidence ?? 0.9,
    props: seed.props ?? {},
    firstSeenRun: 'run-1',
    lastSeenRun: 'run-1',
    deletedAt: seed.deletedAt ?? null,
  };
  return { ...base, ...(seed.sourceRef === undefined ? {} : { sourceRef: seed.sourceRef }) };
}

export interface MemoryGraphOptions {
  readonly nodes?: readonly SeamlineNode[];
  readonly edges?: readonly SeamlineEdge[];
  readonly scopeStatus?: Readonly<Record<string, ExtractorStatus>>;
  readonly runs?: readonly RunRecord[];
}

export interface MemoryGraph extends Workspace {
  readonly writes: {
    readonly nodes: SeamlineNode[];
    readonly edges: Array<{ scope: string; edges: readonly SeamlineEdge[] }>;
    readonly finalized: Array<{ runId: string; results: readonly ExtractorResult[] }>;
  };
  readonly opened: OpenStoreOptions[];
  readonly closed: () => number;
}

/** A `GraphStore` over arrays. Deterministic ordering, no persistence. */
export function memoryGraph(opts: MemoryGraphOptions = {}): MemoryGraph {
  const index = memoryGraphIndex();
  for (const n of opts.nodes ?? []) index.addNode(n);
  for (const e of opts.edges ?? []) index.addEdge(e);
  const runs: RunRecord[] = [...(opts.runs ?? [])];
  const writes = {
    nodes: [] as SeamlineNode[],
    edges: [] as Array<{ scope: string; edges: readonly SeamlineEdge[] }>,
    finalized: [] as Array<{ runId: string; results: readonly ExtractorResult[] }>,
  };
  let closeCount = 0;

  const store: GraphStore = {
    nodesByKind: (kind) => [...index.nodesByKind(kind)].sort(byId),
    node: (id) => index.node(id),
    edgesFrom: (id, kind) => index.edgesFrom(id, kind),
    edgesTo: (id, kind) => index.edgesTo(id, kind),
    scopeStatus: (scope) => opts.scopeStatus?.[scope] ?? 'PASS',
    beginRun: (run) => {
      runs.push({ ...run, finishedAt: null, results: [] });
      return Promise.resolve();
    },
    upsertNodes: (_runId, incoming) => {
      for (const n of incoming) {
        index.addNode(n);
        writes.nodes.push(n);
      }
      return Promise.resolve();
    },
    upsertEdges: (_runId, scope, incoming) => {
      for (const e of incoming) index.addEdge(e);
      writes.edges.push({ scope, edges: incoming });
      return Promise.resolve();
    },
    finalizeRun: (runId, results) => {
      writes.finalized.push({ runId, results });
      const idx = runs.findIndex((r) => r.runId === runId);
      if (idx >= 0) {
        const existing = runs[idx] as RunRecord;
        runs[idx] = { ...existing, results, finishedAt: '1970-01-01T00:00:01.000Z' };
      }
      return Promise.resolve();
    },
    traverse: (q: TraverseQuery): Promise<Maybe<ReadonlyArray<SeamlineNode>>> => {
      const out: SeamlineNode[] = [];
      for (const from of q.from) {
        for (const e of index.edgesFrom(from)) {
          if (!q.via.includes(e.kind)) continue;
          const n = index.node(e.dst);
          if (n !== undefined) out.push(n);
        }
      }
      return Promise.resolve(known(out.sort(byId).slice(0, q.limit ?? out.length)));
    },
    close: () => {
      closeCount += 1;
      return Promise.resolve();
    },
  };

  const history: RunHistory = {
    latest: () => Promise.resolve(runs.at(-1)),
    list: (limit) => Promise.resolve(runs.slice(-limit)),
    get: (runId) => Promise.resolve(runs.find((r) => r.runId === runId)),
  };

  return { store, runs: history, writes, opened: [], closed: () => closeCount };
}

/** A `StorePort` returning the same `MemoryGraph` on every open. */
export function memoryStorePort(graph: MemoryGraph): StorePort {
  return {
    open: (o: OpenStoreOptions) => {
      graph.opened.push(o);
      return Promise.resolve(graph);
    },
  };
}

function byId(a: SeamlineNode, b: SeamlineNode): number {
  return compareCodeUnits(a.id, b.id);
}

export function makeRun(
  runId: string,
  results: readonly ExtractorResult[],
  repo = 'demo',
): RunRecord {
  return {
    runId,
    repo,
    commit: null,
    startedAt: '1970-01-01T00:00:00.000Z',
    finishedAt: '1970-01-01T00:00:01.000Z',
    ontologyVersion: '1.0.0',
    results,
  };
}

export function makeResult(
  extractor: string,
  status: ExtractorStatus,
  scopes: readonly string[],
  diagnostics: readonly string[] = [],
): ExtractorResult {
  return {
    extractor,
    version: '0.0.1',
    status,
    authoritative: scopes.map((scope) => ({ scope, kinds: [] as readonly NodeKind[] })),
    nodeCount: status === 'PASS' ? 1 : 0,
    edgeCount: 0,
    durationMs: 1,
    diagnostics,
  };
}

/** A `GitPort` returning a fixed set of changed files, for `blast-radius` tests. */
export function fakeGitPort(files: readonly string[]): GitPort {
  return {
    changedFiles: (_repoRoot: string) => Promise.resolve(files),
  };
}

/** Anything a terminal could act on or a reader could not see, except LF and TAB. */
export const UNSAFE_OUTPUT =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff0-\ufffc\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{e0000}-\u{e0fff}]/u;
