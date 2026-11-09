/**
 * Fixture builders for the store tests.
 *
 * These live in `src/` rather than inside a single test file because design v3
 * §3 makes the traversal conformance suite the definition of "supported store":
 * a second adapter is only supported when it passes the identical suite, and a
 * suite that cannot be imported cannot be run twice.
 */

import { DEFAULT_SENSITIVITY, nodeId } from '@seamline/ontology';
import type {
  AuthoritativeScope,
  EdgeKind,
  ExtractorResult,
  ExtractorStatus,
  NodeId,
  NodeKind,
  Provenance,
  RunRecord,
  SeamlineEdge,
  SeamlineNode,
} from '@seamline/ontology';

export interface NodeSpec {
  /**
   * Canonical name (path-free, except for a `File`). Combined with repo and kind into the
   * natural key.
   */
  readonly name: string;
  readonly kind?: NodeKind;
  readonly repo?: string;
  readonly path?: string;
  readonly provenance?: Provenance;
  readonly confidence?: number;
  readonly props?: Readonly<Record<string, string | number | boolean | null>>;
  readonly untrusted?: boolean;
  readonly sourceRef?: string;
  readonly firstSeenRun?: string;
}

export function makeNode(spec: NodeSpec): SeamlineNode {
  const kind = spec.kind ?? 'File';
  const repo = spec.repo ?? 'app';
  return {
    id: nodeId(repo, kind, spec.name),
    kind,
    name: spec.name,
    ...(spec.path === undefined ? {} : { path: spec.path }),
    sensitivity: DEFAULT_SENSITIVITY[kind],
    provenance: spec.provenance ?? 'EXTRACTED',
    confidence: spec.confidence ?? 1,
    ...(spec.sourceRef === undefined ? {} : { sourceRef: spec.sourceRef }),
    ...(spec.untrusted === undefined ? {} : { untrusted: spec.untrusted }),
    props: spec.props ?? {},
    firstSeenRun: spec.firstSeenRun ?? '',
    lastSeenRun: '',
    deletedAt: null,
  };
}

/** A `File` node whose path mirrors its canonical name, the common case. */
export function fileNode(path: string, repo = 'app'): SeamlineNode {
  return makeNode({ name: path, kind: 'File', repo, path });
}

export interface EdgeSpec {
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly kind: EdgeKind;
  readonly srcFile?: string;
  readonly dstFile?: string;
  readonly provenance?: Provenance;
  readonly confidence?: number;
  readonly props?: Readonly<Record<string, string | number | boolean | null>>;
}

export function makeEdge(spec: EdgeSpec): SeamlineEdge {
  return {
    kind: spec.kind,
    src: spec.src,
    dst: spec.dst,
    ...(spec.srcFile === undefined ? {} : { srcFile: spec.srcFile }),
    ...(spec.dstFile === undefined ? {} : { dstFile: spec.dstFile }),
    provenance: spec.provenance ?? 'EXTRACTED',
    confidence: spec.confidence ?? 1,
    props: spec.props ?? {},
    firstSeenRun: '',
    lastSeenRun: '',
    deletedAt: null,
  };
}

/** An `IMPORTS` edge between two file nodes, carrying both endpoint paths. */
export function importsEdge(src: SeamlineNode, dst: SeamlineNode): SeamlineEdge {
  return makeEdge({
    src: src.id,
    dst: dst.id,
    kind: 'IMPORTS',
    ...(src.path === undefined ? {} : { srcFile: src.path }),
    ...(dst.path === undefined ? {} : { dstFile: dst.path }),
  });
}

export function runRecord(
  runId: string,
  over: { repo?: string; commit?: string | null; startedAt?: string; ontologyVersion?: string } = {},
): Omit<RunRecord, 'finishedAt' | 'results'> {
  return {
    runId,
    repo: over.repo ?? 'app',
    commit: over.commit ?? null,
    startedAt: over.startedAt ?? '2026-01-01T00:00:00.000Z',
    ontologyVersion: over.ontologyVersion ?? '1.0.0',
  };
}

export function scope(name: string, kinds: ReadonlyArray<NodeKind>, selector?: string): AuthoritativeScope {
  return {
    scope: name,
    kinds,
    ...(selector === undefined ? {} : { selector }),
  };
}

export function extractorResult(
  extractor: string,
  status: ExtractorStatus,
  authoritative: ReadonlyArray<AuthoritativeScope>,
  counts: { nodeCount?: number; edgeCount?: number; diagnostics?: ReadonlyArray<string> } = {},
): ExtractorResult {
  return {
    extractor,
    version: '0.0.1',
    status,
    authoritative,
    nodeCount: counts.nodeCount ?? 0,
    edgeCount: counts.edgeCount ?? 0,
    durationMs: 0,
    diagnostics: counts.diagnostics ?? [],
  };
}

/** Deterministic clock so tombstone timestamps are assertable. */
export function fixedClock(value = '2026-01-01T00:00:01.000Z'): () => string {
  return () => value;
}
