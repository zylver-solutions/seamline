/**
 * Fact-only traversal.
 *
 * Two rules are enforced here rather than in each detector, because a detector
 * that forgets either one produces a finding this project has no right to
 * report.
 *
 * 1. **Every node on a path is a fact.** `isFact(provenance)`, EXTRACTED or
 *    DECLARED. An INFERRED or LLM_SUGGESTED *node* is a guess about what
 *    exists, and a guess about what exists cannot disagree with anything.
 *
 * 2. **Edges may be INFERRED, never LLM_SUGGESTED.** The join between two
 *    facts is normally produced by `infer-join` and is therefore INFERRED by
 *    construction (v3 §4, §6), refusing inferred edges would leave no
 *    cross-domain detector able to fire at all. So the join is allowed, and
 *    its confidence is carried through to the finding, where it caps severity
 *    (see `detector.ts`). An LLM_SUGGESTED edge is dropped outright: a model's
 *    guess never justifies a finding at any severity.
 *
 * Tombstoned nodes and edges (`deletedAt !== null`) are excluded everywhere.
 * X8 also requires current live replay witnesses; historical absence does not
 * come from a tombstoned endpoint.
 */

import {
  isFact,
  type EdgeKind,
  type GraphView,
  type NodeId,
  type NodeKind,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';

export interface Step {
  readonly kind: EdgeKind;
  /** `out` follows src -> dst, `in` follows dst -> src. */
  readonly dir: 'out' | 'in';
}

export const out = (kind: EdgeKind): Step => ({ kind, dir: 'out' });
export const into = (kind: EdgeKind): Step => ({ kind, dir: 'in' });

export interface JoinHop {
  readonly edge: SeamlineEdge;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly step: Step;
}

export interface Joined {
  readonly node: SeamlineNode;
  readonly hops: ReadonlyArray<JoinHop>;
  readonly viaPath: ReadonlyArray<EdgeKind>;
  /** Product of the confidences of the inferred hops; 1 when the path is all facts. */
  readonly confidence: number;
}

/** An edge usable as a join: live, and not an LLM guess. */
export function isUsableEdge(e: SeamlineEdge): boolean {
  return e.deletedAt === null && e.provenance !== 'LLM_SUGGESTED';
}

/** A node usable as a fact endpoint or waypoint: live, and EXTRACTED or DECLARED. */
export function isFactNode(n: SeamlineNode | undefined): n is SeamlineNode {
  return n !== undefined && n.deletedAt === null && isFact(n.provenance);
}

/**
 * The confidence of a join path.
 *
 * A fact edge contributes 1, its confidence field is not evidence weight, the
 * extractor observed it. Each inferred hop contributes its own confidence, and
 * they multiply because each hop is an independent guess: two 0.8 guesses in
 * series are worth 0.64, not 0.8. That product is what caps severity.
 */
export function pathConfidence(hops: ReadonlyArray<JoinHop>): number {
  let c = 1;
  for (const h of hops) {
    if (!isFact(h.edge.provenance)) c *= clamp01(h.edge.confidence);
  }
  return round6(c);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Fixed precision so a product of floats serializes identically across runs (v3 §2.3). */
export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Live, non-LLM edges leaving `id`, sorted for determinism. */
export function factEdgesFrom(g: GraphView, id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
  return sortEdges(g.edgesFrom(id, kind).filter(isUsableEdge));
}

/** Live, non-LLM edges arriving at `id`, sorted for determinism. */
export function factEdgesTo(g: GraphView, id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
  return sortEdges(g.edgesTo(id, kind).filter(isUsableEdge));
}

function sortEdges(edges: ReadonlyArray<SeamlineEdge>): ReadonlyArray<SeamlineEdge> {
  return [...edges].sort(
    (a, b) => cmp(a.kind, b.kind) || cmp(a.src, b.src) || cmp(a.dst, b.dst),
  );
}

/** Live fact nodes of a kind, sorted by id. */
export function factNodes(g: GraphView, kind: NodeKind): ReadonlyArray<SeamlineNode> {
  return [...g.nodesByKind(kind)].filter(isFactNode).sort((a, b) => cmp(a.id, b.id));
}

/**
 * The workspace packages `extract-code-ts` named as unread, from the `Repo`
 * node it emits (`unreadCodePackages`, a JSON array of the first names, sorted;
 * the exact count is `unreadCodePackageCount`). Empty when the code scope was
 * read whole.
 *
 * `code.ts` can be PASS and still cover only part of the repository: its
 * authoritative selector names what it read. `GraphView.scopeStatus` is one
 * status per scope, so this is the only place a detector can learn that a
 * package, or a project of a root tsconfig, was not looked at.
 */
export function unreadCodePackages(g: GraphView): { readonly count: number; readonly named: ReadonlyArray<string> } {
  let count = 0;
  const named = new Set<string>();
  for (const repo of factNodes(g, 'Repo')) {
    const n = repo.props['unreadCodePackageCount'];
    const list = repo.props['unreadCodePackages'];
    if (typeof n === 'number' && n > 0) count += n;
    if (typeof list === 'string') for (const dir of namesOf(list)) named.add(dir);
  }
  return { count, named: [...named].sort(cmp) };
}

/** The names in a JSON array of strings; none when the value is anything else. */
function namesOf(json: string): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  } catch {
    return [];
  }
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Walk a fixed sequence of steps from one node, returning every fact node
 * reachable by exactly that sequence.
 *
 * Deterministic: when several paths reach the same node, the highest-confidence
 * path wins, ties broken by the edge-kind sequence, and results are sorted by
 * node id. No node repeats within a single path.
 */
export function follow(
  g: GraphView,
  from: NodeId,
  steps: ReadonlyArray<Step>,
  toKind?: NodeKind,
): ReadonlyArray<Joined> {
  let frontier: Array<{ id: NodeId; hops: ReadonlyArray<JoinHop> }> = [{ id: from, hops: [] }];
  for (const s of steps) {
    const next: Array<{ id: NodeId; hops: ReadonlyArray<JoinHop> }> = [];
    for (const f of frontier) {
      const edges = s.dir === 'out' ? factEdgesFrom(g, f.id, s.kind) : factEdgesTo(g, f.id, s.kind);
      for (const e of edges) {
        const to = s.dir === 'out' ? e.dst : e.src;
        if (to === from || f.hops.some((h) => h.to === to)) continue; // cycle guard
        if (!isFactNode(g.node(to))) continue;
        next.push({ id: to, hops: [...f.hops, { edge: e, from: f.id, to, step: s }] });
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const best = new Map<NodeId, Joined>();
  for (const f of frontier) {
    const node = g.node(f.id);
    if (!isFactNode(node)) continue;
    if (toKind !== undefined && node.kind !== toKind) continue;
    const j: Joined = {
      node,
      hops: f.hops,
      viaPath: f.hops.map((h) => h.edge.kind),
      confidence: pathConfidence(f.hops),
    };
    const prev = best.get(f.id);
    if (prev === undefined || j.confidence > prev.confidence) best.set(f.id, j);
  }
  return [...best.values()].sort((a, b) => cmp(a.node.id, b.node.id));
}

/** Every node reachable by any of several step sequences, best path per node. */
export function followAny(
  g: GraphView,
  from: NodeId,
  routes: ReadonlyArray<ReadonlyArray<Step>>,
  toKind?: NodeKind,
): ReadonlyArray<Joined> {
  const best = new Map<NodeId, Joined>();
  for (const route of routes) {
    for (const j of follow(g, from, route, toKind)) {
      const prev = best.get(j.node.id);
      if (prev === undefined || j.confidence > prev.confidence) best.set(j.node.id, j);
    }
  }
  return [...best.values()].sort((a, b) => cmp(a.node.id, b.node.id));
}

/** The single parent of a contained node, or undefined. */
export function parentOf(g: GraphView, id: NodeId, parentKind: NodeKind): SeamlineNode | undefined {
  for (const e of factEdgesTo(g, id, 'CONTAINS')) {
    const n = g.node(e.src);
    if (isFactNode(n) && n.kind === parentKind) return n;
  }
  return undefined;
}

/** Live fact children of a node. */
export function childrenOf(g: GraphView, id: NodeId, childKind: NodeKind): ReadonlyArray<SeamlineNode> {
  const out2: SeamlineNode[] = [];
  for (const e of factEdgesFrom(g, id, 'CONTAINS')) {
    const n = g.node(e.dst);
    if (isFactNode(n) && n.kind === childKind) out2.push(n);
  }
  return out2.sort((a, b) => cmp(a.id, b.id));
}

/** A short human label for a node, used in claims and in `explain`. */
export function label(n: SeamlineNode): string {
  return `${n.kind} ${n.name}`;
}

/** Where the fact came from: source ref if the extractor recorded one, else path, else id. */
export function whereFrom(n: SeamlineNode): string {
  return n.sourceRef ?? n.path ?? String(n.id);
}
