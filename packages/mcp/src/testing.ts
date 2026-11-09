/**
 * In-memory test doubles for the MCP server.
 *
 * Kept in `src/` rather than inside one test file because several of the
 * server's test files need the same doubles. It is not part of the public
 * surface: `index.ts` does not re-export it, the package `exports` map does not
 * reach it, and `files` leaves it out of the tarball (`pnpm gate:pack` fails if a
 * shipped file still imports it). This is a double, not a store.
 */

import {
  DEFAULT_SENSITIVITY,
  nodeId,
  type EdgeKind,
  type ExtractorResult,
  type ExtractorStatus,
  type GraphView,
  type NodeId,
  type NodeKind,
  type RunRecord,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import type { DetectionReport, GraphSource } from './ports.ts';

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
  const base = {
    id: nodeId(repo, seed.kind, seed.canonicalName),
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
  readonly deletedAt?: string | null;
}

export function makeEdge(seed: EdgeSeed): SeamlineEdge {
  const base = {
    kind: seed.kind,
    src: seed.src,
    dst: seed.dst,
    provenance: seed.provenance ?? 'INFERRED',
    confidence: seed.confidence ?? 0.9,
    props: {},
    firstSeenRun: 'run-1',
    lastSeenRun: 'run-1',
    deletedAt: seed.deletedAt ?? null,
  };
  return { ...base, ...(seed.sourceRef === undefined ? {} : { sourceRef: seed.sourceRef }) };
}

export function memoryView(
  nodes: readonly SeamlineNode[],
  edges: readonly SeamlineEdge[] = [],
  scopeStatus: Readonly<Record<string, ExtractorStatus>> = {},
): GraphView {
  const byId = new Map<string, SeamlineNode>(nodes.map((n) => [n.id, n]));
  return {
    nodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    node: (id) => byId.get(id),
    edgesFrom: (id, kind) => edges.filter((e) => e.src === id && (kind === undefined || e.kind === kind)),
    edgesTo: (id, kind) => edges.filter((e) => e.dst === id && (kind === undefined || e.kind === kind)),
    scopeStatus: (scope) => scopeStatus[scope] ?? 'PASS',
  };
}

export function makeResult(
  extractor: string,
  status: ExtractorStatus,
  scopes: readonly string[],
  diagnostics: readonly string[] = [],
  /** The node kinds each scope is authoritative for. Which scope produces test facts is read from these. */
  kinds: readonly NodeKind[] = [],
): ExtractorResult {
  return {
    extractor,
    version: '0.0.1',
    status,
    authoritative: scopes.map((scope) => ({ scope, kinds })),
    nodeCount: 0,
    edgeCount: 0,
    durationMs: 1,
    diagnostics,
  };
}

export function makeRun(runId: string, results: readonly ExtractorResult[]): RunRecord {
  return {
    runId,
    repo: 'demo',
    commit: null,
    startedAt: '1970-01-01T00:00:00.000Z',
    finishedAt: '1970-01-01T00:00:01.000Z',
    ontologyVersion: '1.0.0',
    results,
  };
}

export interface MemorySourceOptions {
  readonly nodes?: readonly SeamlineNode[];
  readonly edges?: readonly SeamlineEdge[];
  readonly scopeStatus?: Readonly<Record<string, ExtractorStatus>>;
  readonly run?: RunRecord;
  readonly detection?: DetectionReport;
}

export function memorySource(opts: MemorySourceOptions = {}): GraphSource {
  const view = memoryView(opts.nodes ?? [], opts.edges ?? [], opts.scopeStatus ?? {});
  const base: GraphSource = {
    view: () => Promise.resolve(view),
    latestRun: () => Promise.resolve(opts.run),
  };
  if (opts.detection === undefined) return base;
  return { ...base, detect: () => Promise.resolve(opts.detection as DetectionReport) };
}

/** A deterministic nonce, so a test can assert on the exact delimiter. */
export function fixedNonce(value = 'deadbeef'): () => string {
  return () => value;
}
