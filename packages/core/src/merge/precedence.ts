/**
 * Conflict resolution (v3 §2.4).
 *
 * `PROVENANCE_RANK` in the contract is the primary order, tie-broken by
 * `(extractorPriority, runId)`. Those three are not enough on their own: two
 * facts equal on all three but with different bodies would leave the winner
 * dependent on arrival order, and merge would stop being commutative. So the
 * order is extended with a content tie-break and finally the extractor name,
 * which makes it **total** — `compareFacts(...) === 0` implies the two facts
 * are the same fact, so `max` over it is commutative, associative, idempotent.
 *
 * The comparison deliberately ignores `firstSeenRun`/`lastSeenRun`/`deletedAt`.
 * Lifecycle is merged separately by a commutative fold (`lifecycle.ts`); if it
 * fed the winner selection, a merged node's advanced `lastSeenRun` could flip a
 * later comparison and associativity would be lost.
 */

import { PROVENANCE_RANK, type Provenance, type SeamlineEdge, type SeamlineNode } from '@seamline/ontology';

import { canonicalJson, compareStrings } from './serialize.ts';

/** Who asserted a fact. `extractorPriority`: higher wins. */
export interface FactSource {
  readonly extractor: string;
  readonly extractorPriority: number;
  readonly runId: string;
}

export type Assertable = SeamlineNode | SeamlineEdge;

const LIFECYCLE_KEYS = ['firstSeenRun', 'lastSeenRun', 'deletedAt'] as const;

/** The assertion itself, with the lifecycle bookkeeping stripped off. */
export function factBody(value: Assertable): string {
  const record: Record<string, unknown> = { ...value };
  for (const k of LIFECYCLE_KEYS) delete record[k];
  return canonicalJson(record);
}

export function provenanceRank(p: Provenance): number {
  const rank = PROVENANCE_RANK[p];
  if (rank === undefined) throw new Error(`unknown provenance ${JSON.stringify(p)}`);
  return rank;
}

/**
 * Total order over competing facts for one id. Positive means `a` wins.
 *
 * 1. provenance, by `PROVENANCE_RANK` (EXTRACTED > DECLARED > INFERRED > LLM_SUGGESTED)
 * 2. `extractorPriority`, higher first
 * 3. `runId`, later first
 * 4. canonical body, lexicographically smaller first
 * 5. extractor name, lexicographically smaller first
 */
export function compareFacts<T extends Assertable>(
  aValue: T,
  aSource: FactSource,
  bValue: T,
  bSource: FactSource,
): number {
  const byProvenance = provenanceRank(aValue.provenance) - provenanceRank(bValue.provenance);
  if (byProvenance !== 0) return byProvenance;

  const byPriority = aSource.extractorPriority - bSource.extractorPriority;
  if (byPriority !== 0) return byPriority;

  const byRun = compareStrings(aSource.runId, bSource.runId);
  if (byRun !== 0) return byRun;

  const byBody = compareStrings(factBody(aValue), factBody(bValue));
  if (byBody !== 0) return -byBody;

  const byExtractor = compareStrings(aSource.extractor, bSource.extractor);
  return byExtractor === 0 ? 0 : -byExtractor;
}

export interface Fact<T extends Assertable> {
  readonly value: T;
  readonly source: FactSource;
}

/** The winner under `compareFacts`. Commutative because the order is total. */
export function pickWinner<T extends Assertable>(a: Fact<T>, b: Fact<T>): Fact<T> {
  return compareFacts(a.value, a.source, b.value, b.source) >= 0 ? a : b;
}
