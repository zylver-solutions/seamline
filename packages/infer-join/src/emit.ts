/**
 * Edge construction, and the two runtime guards on it.
 *
 * Every edge this package produces goes through `buildEdge`, which:
 *
 *   1. runs the provenance through `assertWithinCeiling` (v3 §2.7) - passing
 *      `EXTRACTED` throws rather than being caught in review;
 *   2. runs the endpoint kinds through `isValidEdge` (v3 §4) - an edge outside
 *      its declared domain and range never reaches the store.
 *
 * It also enforces the determinism rules of v3 §2.3 on its own output: prop
 * keys are sorted, floats are rounded to a fixed precision, and no wall-clock
 * value is ever written into an edge body.
 */

import type { EdgeKind, NodeId, Provenance, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { isValidEdge } from '@seamline/ontology';
import { guardProvenance } from './manifest.ts';
import { roundTo } from './confidence.ts';

export type PropValue = string | number | boolean | null;

/** Sort prop keys and round float values. Serialization must be byte-stable. */
export function canonicalProps(props: Readonly<Record<string, PropValue>>): Readonly<Record<string, PropValue>> {
  const out: Record<string, PropValue> = {};
  for (const key of Object.keys(props).sort()) {
    const value = props[key];
    if (value === undefined) continue;
    out[key] = typeof value === 'number' && !Number.isInteger(value) ? roundTo(value, 4) : value;
  }
  return out;
}

export interface BuildEdgeInput {
  readonly kind: EdgeKind;
  readonly src: SeamlineNode;
  readonly dst: SeamlineNode;
  readonly confidence: number;
  readonly props: Readonly<Record<string, PropValue>>;
  readonly runId: string;
  readonly sourceRef?: string;
  /**
   * Present only so the ceiling can be exercised. Defaults to INFERRED, and
   * anything above the manifest ceiling throws.
   */
  readonly provenance?: Provenance;
}

export function buildEdge(input: BuildEdgeInput): SeamlineEdge {
  const provenance = guardProvenance(input.provenance ?? 'INFERRED');
  if (!isValidEdge(input.kind, input.src.kind, input.dst.kind)) {
    throw new Error(
      `edge ${input.kind} is not declared for ${input.src.kind} -> ${input.dst.kind}`,
    );
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new RangeError(`edge confidence must be within [0,1], got ${input.confidence}`);
  }
  return {
    kind: input.kind,
    src: input.src.id,
    dst: input.dst.id,
    ...(input.src.path !== undefined ? { srcFile: input.src.path } : {}),
    ...(input.dst.path !== undefined ? { dstFile: input.dst.path } : {}),
    provenance,
    confidence: roundTo(input.confidence, 4),
    ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
    props: canonicalProps(input.props),
    firstSeenRun: input.runId,
    lastSeenRun: input.runId,
    deletedAt: null,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total order over edges: kind, then src, then dst. Never locale-aware. */
export function compareEdges(a: SeamlineEdge, b: SeamlineEdge): number {
  return compare(a.kind, b.kind) || compare(a.src, b.src) || compare(a.dst, b.dst);
}

/**
 * Sort and de-duplicate. UNIQUE(scope, src, dst, kind) means the same triple
 * may appear once; when two rules produce it, the higher confidence wins and
 * the losing rule is recorded in `alsoFrom` so the provenance of the decision
 * is not lost.
 */
export function finalizeEdges(edges: ReadonlyArray<SeamlineEdge>): ReadonlyArray<SeamlineEdge> {
  const byKey = new Map<string, SeamlineEdge>();
  for (const edge of edges.slice().sort(compareEdges)) {
    const key = `${edge.kind} ${edge.src} ${edge.dst}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, edge);
      continue;
    }
    const winner = edge.confidence > existing.confidence ? edge : existing;
    const loser = winner === edge ? existing : edge;
    const loserRule = loser.props['rule'];
    byKey.set(key, {
      ...winner,
      props: canonicalProps({
        ...winner.props,
        ...(typeof loserRule === 'string' ? { alsoFrom: loserRule } : {}),
      }),
    });
  }
  return [...byKey.values()].sort(compareEdges);
}

export type { NodeId };
