/**
 * Fixture builders for the SIF tests.
 *
 * Not part of the public surface (`sif/index.ts` does not re-export it) and not
 * a test file (the `*.test.ts` glob does not match it). Kept beside the tests
 * because four test files need the same handful of well-formed facts, and a
 * hand-rolled node literal per assertion is where fixture drift starts.
 */

import { nodeId } from '@seamline/ontology';
import type { EdgeKind, NodeKind, RunRecord, SeamlineEdge, SeamlineNode } from '@seamline/ontology';

export const REPO = 'demo';
export const RUN = 'run-0001';

/** A well-formed node. `overrides` is applied last, including invalid values on purpose. */
export function makeNode(
  kind: NodeKind,
  canonicalName: string,
  overrides: Record<string, unknown> = {},
): SeamlineNode {
  return {
    id: nodeId(REPO, kind, canonicalName),
    kind,
    name: canonicalName,
    sensitivity: 'internal',
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    deletedAt: null,
    ...overrides,
  } as unknown as SeamlineNode;
}

/** A well-formed edge between two existing node ids. */
export function makeEdge(
  kind: EdgeKind,
  src: SeamlineNode,
  dst: SeamlineNode,
  overrides: Record<string, unknown> = {},
): SeamlineEdge {
  return {
    kind,
    src: src.id,
    dst: dst.id,
    provenance: 'INFERRED',
    confidence: 0.8,
    props: {},
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    deletedAt: null,
    ...overrides,
  } as unknown as SeamlineEdge;
}

export function makeRun(overrides: Record<string, unknown> = {}): RunRecord {
  return {
    runId: RUN,
    repo: REPO,
    commit: 'a'.repeat(40),
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    ontologyVersion: '1.0.0',
    results: [],
    ...overrides,
  } as unknown as RunRecord;
}

export function makeResult(overrides: Record<string, unknown> = {}): RunRecord['results'][number] {
  return {
    extractor: 'extract-code-ts',
    version: '0.0.1',
    status: 'PASS',
    authoritative: [{ scope: 'code:ts', kinds: ['File', 'Symbol'] }],
    nodeCount: 2,
    edgeCount: 1,
    durationMs: 12,
    diagnostics: [],
    ...overrides,
  } as unknown as RunRecord['results'][number];
}

/**
 * Deterministic shuffle: a Fisher-Yates driven by a small LCG, so a failing
 * shuffle-order test reproduces exactly instead of flaking once a week.
 */
export function shuffle<T>(items: ReadonlyArray<T>, seed: number): T[] {
  const out = [...items];
  let state = (seed >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/**
 * Capture the error a call throws.
 *
 * `assert.throws` returns `undefined`, so it can validate an error but cannot
 * hand one back for further assertions. These tests assert on `line` and
 * `field`, not only on the type, so they need the object itself.
 */
export function caught<E = unknown>(fn: () => unknown): E {
  try {
    fn();
  } catch (error) {
    return error as E;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

/** `caught` for a promise. */
export async function caughtAsync<E = unknown>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (error) {
    return error as E;
  }
  throw new Error('expected the promise to reject, but it resolved');
}
