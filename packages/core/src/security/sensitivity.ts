/**
 * Sensitivity lattice. Design v3 section 2.5.
 *
 * `Sensitivity` and `DEFAULT_SENSITIVITY` live in the frozen contract; this
 * module supplies the ordering and the one combination rule the export policy
 * depends on:
 *
 * **The kind default is a floor, never a ceiling.** An explicit node-level
 * sensitivity wins if it is *more* restrictive and is ignored if it is less.
 * A `Column` cannot be published as `internal` by an extractor that decided its
 * own data was harmless, and an `Owner` cannot be demoted out of `restricted`.
 *
 * A direct consequence, relied on by `export-policy.ts` and asserted in its
 * tests: no node of kind `Owner` or `ThreatModel` can ever hold an effective
 * sensitivity below `restricted`, so any profile that omits the `restricted`
 * tier excludes the entire people and threat-model surface structurally rather
 * than by remembering to leave those kinds off a list.
 */

import { DEFAULT_SENSITIVITY, SENSITIVITY } from '@seamline/ontology';
import type { NodeKind, SeamlineEdge, SeamlineNode, Sensitivity } from '@seamline/ontology';

/** Total order, least restrictive first. Index into `SENSITIVITY`. */
export const SENSITIVITY_RANK: Readonly<Record<Sensitivity, number>> = Object.freeze(
  Object.fromEntries(SENSITIVITY.map((s, i) => [s, i])) as Record<Sensitivity, number>,
);

export function sensitivityRank(s: Sensitivity): number {
  return SENSITIVITY_RANK[s];
}

/** The more restrictive of two levels. Associative, commutative, idempotent. */
export function moreRestrictive(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b] ? a : b;
}

/** True when `a` is at least as restrictive as `b`. */
export function isAtLeastAsRestrictive(a: Sensitivity, b: Sensitivity): boolean {
  return SENSITIVITY_RANK[a] >= SENSITIVITY_RANK[b];
}

export function defaultSensitivityFor(kind: NodeKind): Sensitivity {
  return DEFAULT_SENSITIVITY[kind];
}

/**
 * The sensitivity an export decision must use: the kind default raised, never
 * lowered, by whatever the node itself declares.
 */
export function effectiveSensitivity(
  node: Pick<SeamlineNode, 'kind' | 'sensitivity'>,
): Sensitivity {
  return moreRestrictive(DEFAULT_SENSITIVITY[node.kind], node.sensitivity);
}

/**
 * An edge is exactly as sensitive as its most restrictive endpoint. An edge
 * carries no sensitivity of its own in the contract, and it must not be a way
 * to learn that a `restricted` node exists.
 */
export function effectiveEdgeSensitivity(
  edge: Pick<SeamlineEdge, 'src' | 'dst'>,
  nodeById: ReadonlyMap<string, Pick<SeamlineNode, 'kind' | 'sensitivity'>>,
): Sensitivity {
  const src = nodeById.get(String(edge.src));
  const dst = nodeById.get(String(edge.dst));
  // A dangling endpoint is unknown provenance; fail closed at the top of the
  // lattice rather than guessing.
  const s = src === undefined ? 'restricted' : effectiveSensitivity(src);
  const d = dst === undefined ? 'restricted' : effectiveSensitivity(dst);
  return moreRestrictive(s, d);
}

/** Kinds whose default already sits at or above `level`. */
export function kindsAtLeast(level: Sensitivity): ReadonlyArray<NodeKind> {
  return (Object.keys(DEFAULT_SENSITIVITY) as NodeKind[])
    .filter((k) => isAtLeastAsRestrictive(DEFAULT_SENSITIVITY[k], level))
    .sort();
}
