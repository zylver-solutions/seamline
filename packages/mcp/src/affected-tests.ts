/**
 * Impact to affected tests: which `TestCase` nodes does a change reach?
 *
 * The answer is built from facts only, and it is allowed to be UNKNOWN.
 *
 *  - **Facts only (invariant 5).** A test is returned only when a path of live
 *    EXTRACTED or DECLARED edges, through live EXTRACTED or DECLARED nodes,
 *    leads from a given id to it and ends in a `TESTS` edge. An INFERRED or
 *    LLM_SUGGESTED edge is never a link in that path. Such edges are not
 *    returned as proposals either; they are counted (`skippedNonFact`) so the
 *    agent knows they exist. A test is never inferred from its name.
 *  - **UNKNOWN is never "no tests" (invariant 3).** `TESTS` is produced by a
 *    scope that declares `TestCase` among its authoritative kinds. Unless the
 *    latest run declared such a scope and every such scope PASSed (and the
 *    export profile releases `TestCase` and `TESTS`), an empty list means
 *    nothing: `testFactStatus` says which of those holds, and the tool turns
 *    anything but `known` into UNKNOWN.
 *
 *  - **UNKNOWN is also "an input to the walk is missing" (invariant 3).** The
 *    edges the walk crosses (CALLS, IMPORTS, the joins) come from other scopes
 *    than the one that produces `TESTS`. `walkDegradedScopes` names the scopes
 *    that could have produced them and did not PASS; the tool turns any such
 *    scope into UNKNOWN, the same over-approximation `SqliteStore` makes for a
 *    traversal (a scope whose declared node kinds meet the kinds of the edges
 *    walked), because an extractor that failed leaves no edge behind to find.
 *    The same holds when the export profile does not release a kind the walk
 *    crosses (`withheldFromWalk`): a withheld kind is invisible, not absent.
 *    (A single node withheld by its sensitivity cannot be told apart from an
 *    absent one; the README says so.)
 *  - **A change to test code is not traced.** `TESTS` runs from a `TestCase`
 *    to the code it exercises, and the ontology has no `File` to `TestCase`
 *    edge, so nothing leads from a test file, or from a helper only tests
 *    import, to the tests it affects. `testCodeGate` finds such roots and the
 *    tool answers UNKNOWN for them. A `TestCase` root is itself affected. What it
 *    recognises is structural (see its comment for what it cannot see), and it
 *    fails closed when a `TestCase` names no file, because then the set of test
 *    files is incomplete.
 *
 * The walk goes from a changed node to the nodes that depend on it, which is
 * the reverse of the dependency edges: if `postOrder CALLS createOrder`, a
 * change to `createOrder` reaches `postOrder`. Join edges (a column and the
 * model field it maps to) are correspondences, so they are walked both ways.
 * `CONTAINS` is walked in a few pairs only, and a step down into a container's
 * members may not directly follow a step up out of one, so a change to one
 * symbol does not reach its siblings through their file. That rule is state of
 * the path, not of the node: a node is visited once as "arrived by a step up"
 * and once more if some other path reaches it by a step that permits descent.
 *
 * The edge kinds left out are listed, with the reason for each, in the
 * `Direction` paragraph of the package README.
 */

import {
  EDGE_SIGNATURES,
  isFact,
  nodeId,
  parseNodeId,
  type EdgeKind,
  type ExtractorStatus,
  type GraphView,
  type NodeId,
  type NodeKind,
  type RunRecord,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import { NOT_TRUNCATED, truncation, type TruncationState } from './bounds.ts';
import { compareIds } from './budget.ts';
import { containerOf, neighbours } from './graph.ts';
import type { Released } from './tools/registry.ts';

/** Edges where the source depends on the destination. A change reaches the source. */
export const DEPENDENT_EDGE_KINDS: readonly EdgeKind[] = [
  'CALLS',
  'EXTENDS',
  'IMPLEMENTS',
  'USES_TYPE',
  'IMPORTS',
  'QUERIES',
  'HANDLES_ROUTE',
  'DECORATED_WITH',
];

/**
 * The cross-domain joins: correspondences between representations of one field
 * or one endpoint. Walked both ways, as `impact` does in its `nodes` mode.
 */
export const JOIN_EDGE_KINDS: readonly EdgeKind[] = [
  'MAPS_TO_FIELD',
  'BACKED_BY',
  'EXPOSED_AS',
  'VALIDATED_BY',
  'PERSISTED_IN',
  'STORED_IN',
  'FK_TO',
  'IMPLEMENTED_BY',
];

/** `CONTAINS` pairs (parent kind, member kind) that the walk may cross. */
export const CONTAINS_PAIRS: ReadonlyArray<readonly [NodeKind, NodeKind]> = [
  ['File', 'Symbol'],
  ['Symbol', 'CodeField'],
  ['Symbol', 'Parameter'],
  ['Table', 'Column'],
  ['Contract', 'Operation'],
  ['Contract', 'SchemaProperty'],
  ['Entity', 'DomainProperty'],
];

const TEST_NODE_KIND: NodeKind = 'TestCase';
const TEST_EDGE_KIND: EdgeKind = 'TESTS';

/** Every node kind that can sit on a path the walk follows, from the declared signatures of the edges it crosses. */
const WALKED_NODE_KINDS: ReadonlySet<NodeKind> = (() => {
  const kinds = new Set<NodeKind>();
  for (const kind of [...DEPENDENT_EDGE_KINDS, ...JOIN_EDGE_KINDS, TEST_EDGE_KIND]) {
    for (const [src, dst] of EDGE_SIGNATURES[kind]) {
      kinds.add(src);
      kinds.add(dst);
    }
  }
  for (const [parent, child] of CONTAINS_PAIRS) {
    kinds.add(parent);
    kinds.add(child);
  }
  return kinds;
})();

/** Every edge kind the walk follows. */
const WALKED_EDGE_KINDS: readonly EdgeKind[] = [
  ...new Set<EdgeKind>([...DEPENDENT_EDGE_KINDS, ...JOIN_EDGE_KINDS, 'CONTAINS', TEST_EDGE_KIND]),
].sort(compareIds);

/**
 * The node and edge kinds the walk crosses that the export profile does not
 * release. `TestCase` and `TESTS` are left out: `testFactStatus` reports those.
 *
 * A kind the profile withholds is invisible to the walk, so a path through it
 * is missing without trace; that is an unknown, not an absence.
 */
export function withheldFromWalk(released: Released): {
  readonly nodeKinds: readonly NodeKind[];
  readonly edgeKinds: readonly EdgeKind[];
} {
  return {
    nodeKinds: [...WALKED_NODE_KINDS]
      .filter((kind) => kind !== TEST_NODE_KIND && !released.nodeKind(kind))
      .sort(compareIds),
    edgeKinds: WALKED_EDGE_KINDS.filter(
      (kind) => kind !== TEST_EDGE_KIND && !released.edgeKind(kind),
    ),
  };
}

// ---------------------------------------------------------------------------
// Are there test facts at all?
// ---------------------------------------------------------------------------

export type TestFactStatus =
  /** The profile does not release `TestCase` nodes or `TESTS` edges. */
  | { readonly state: 'withheld' }
  /** The latest run declared no scope that produces `TestCase`: no test facts were extracted. */
  | { readonly state: 'none-extracted' }
  /** Some scope that produces `TestCase` did not PASS: the facts may be missing or stale. */
  | { readonly state: 'degraded'; readonly scopes: readonly string[] }
  /** Every scope that produces `TestCase` PASSed. An empty answer is meaningful. */
  | { readonly state: 'known'; readonly scopes: readonly string[] };

/**
 * Whether the graph can answer a question about tests.
 *
 * A scope "produces TESTS" when the latest run recorded it with `TestCase`
 * among its authoritative kinds. The store's own `scopeStatus` is
 * authoritative for whether it PASSed; the run record only names the scopes.
 */
export function testFactStatus(
  view: GraphView,
  run: RunRecord | undefined,
  released: Released,
): TestFactStatus {
  if (!released.nodeKind(TEST_NODE_KIND) || !released.edgeKind(TEST_EDGE_KIND))
    return { state: 'withheld' };

  const producers = new Map<string, ExtractorStatus>();
  for (const result of run?.results ?? []) {
    for (const auth of result.authoritative) {
      if (!auth.kinds.includes(TEST_NODE_KIND)) continue;
      let status: ExtractorStatus;
      try {
        status = view.scopeStatus(auth.scope);
      } catch {
        status = result.status;
      }
      producers.set(auth.scope, status);
    }
  }
  if (producers.size === 0) return { state: 'none-extracted' };

  const scopes = [...producers.keys()].sort(compareIds);
  return scopes.every((s) => producers.get(s) === 'PASS')
    ? { state: 'known', scopes }
    : { state: 'degraded', scopes };
}

/**
 * Scopes that did not PASS and could have produced a node or an edge the walk
 * crosses.
 *
 * A scope is relevant when its declared node kinds meet the kinds of the edges
 * walked (`WALKED_NODE_KINDS`), or when it declares no kinds at all: nothing
 * then rules it out, so it counts. This is `SqliteStore`'s declared-kinds test
 * for a degraded traversal. Its second test, "a scope that has written an edge
 * of these kinds", needs the scope of a row, which a `GraphView` does not
 * carry, so it is replaced by the stricter reading above.
 *
 * The store's `scopeStatus` is authoritative for whether a scope PASSed; the
 * run record supplies the scope names and what each declared.
 */
export function walkDegradedScopes(view: GraphView, run: RunRecord | undefined): readonly string[] {
  const declared = new Map<string, { kinds: Set<NodeKind>; fallback: ExtractorStatus }>();
  for (const result of run?.results ?? []) {
    for (const auth of result.authoritative) {
      const entry = declared.get(auth.scope) ?? { kinds: new Set<NodeKind>(), fallback: 'PASS' };
      for (const kind of auth.kinds) entry.kinds.add(kind);
      if (entry.fallback === 'PASS') entry.fallback = result.status;
      declared.set(auth.scope, entry);
    }
  }

  const degraded: string[] = [];
  for (const [scope, entry] of declared) {
    const relevant =
      entry.kinds.size === 0 || [...entry.kinds].some((kind) => WALKED_NODE_KINDS.has(kind));
    if (!relevant) continue;
    let status: ExtractorStatus;
    try {
      status = view.scopeStatus(scope);
    } catch {
      status = entry.fallback;
    }
    if (status !== 'PASS') degraded.push(scope);
  }
  return degraded.sort(compareIds);
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export interface AffectedTest {
  readonly test: SeamlineNode;
  /** Edges on the justifying path, the final `TESTS` hop included. 0 when the given id is the test itself. */
  readonly distance: number;
  /** From the given id to the test. `edges[i]` joins `nodes[i]` and `nodes[i + 1]`, in either orientation. */
  readonly nodes: readonly NodeId[];
  readonly edges: readonly SeamlineEdge[];
}

export interface AffectedTestsWalk {
  /** In priority order: nearest first, ties by test id. */
  readonly tests: readonly AffectedTest[];
  /** The distinct nodes the walk visited, not counting the given ids, in walk order. */
  readonly reached: readonly NodeId[];
  /** Result-cap or depth-cap on the walk; the list of tests may be incomplete when set. */
  readonly state: TruncationState;
  /** Distinct non-fact links the walk met and did not use. */
  readonly skippedNonFact: number;
}

type Move = 'dependent' | 'join' | 'up' | 'down';

interface Step {
  readonly edge: SeamlineEdge;
  readonly to: SeamlineNode;
  readonly move: Move;
}

interface Visit {
  readonly id: NodeId;
  readonly depth: number;
  readonly parent: Visit | undefined;
  readonly edge: SeamlineEdge | undefined;
  readonly move: Move | undefined;
}

function edgeKey(e: SeamlineEdge): string {
  return `${e.src} ${e.dst} ${e.kind}`;
}

function isContainsPair(parent: SeamlineNode, child: SeamlineNode): boolean {
  return CONTAINS_PAIRS.some(([p, c]) => p === parent.kind && c === child.kind);
}

/** Every candidate step out of `node`, facts and non-facts alike, in a fixed order. */
function candidateSteps(
  view: GraphView,
  node: SeamlineNode,
  arrived: Move | undefined,
): readonly Step[] {
  const out: Step[] = [];
  for (const n of neighbours(view, node.id, DEPENDENT_EDGE_KINDS, 'in')) {
    out.push({ edge: n.edge, to: n.node, move: 'dependent' });
  }
  for (const n of neighbours(view, node.id, JOIN_EDGE_KINDS, 'both')) {
    out.push({ edge: n.edge, to: n.node, move: 'join' });
  }
  for (const n of neighbours(view, node.id, ['CONTAINS'], 'in')) {
    if (isContainsPair(n.node, node)) out.push({ edge: n.edge, to: n.node, move: 'up' });
  }
  if (arrived !== 'up') {
    for (const n of neighbours(view, node.id, ['CONTAINS'], 'out')) {
      if (isContainsPair(node, n.node)) out.push({ edge: n.edge, to: n.node, move: 'down' });
    }
  }
  out.sort(
    (a, b) =>
      compareIds(a.edge.kind, b.edge.kind) ||
      compareIds(a.to.id, b.to.id) ||
      compareIds(a.move, b.move),
  );
  return out;
}

/**
 * Finds the tests reached from `roots`.
 *
 * Breadth-first, so each test is reported along a shortest justifying path;
 * `maxDepth` bounds the dependency hops (the final `TESTS` hop is not counted)
 * and `maxNodes` bounds the distinct affected nodes visited. Roots are
 * deduplicated and sorted first, so the same set of ids gives the same answer
 * in any order.
 *
 * The search runs over (node, may-descend) states, not over nodes. Whether a
 * step down into a container's members is allowed depends on the step that
 * arrived (never directly after a step up), so two paths to one node can differ
 * in what they may do next. Pruning by node alone would let a shorter path that
 * cannot descend hide a longer one that can, and then adding a dependency could
 * remove a test. A state that may descend does everything one that may not can,
 * so the second is skipped once the first has been visited. Each node is
 * visited at most twice, and a second visit does not count against `maxNodes`.
 */
export function findAffectedTests(
  view: GraphView,
  roots: readonly NodeId[],
  opts: { readonly maxDepth: number; readonly maxNodes: number },
): AffectedTestsWalk {
  const skipped = new Set<string>();
  const visited = new Map<string, Visit>();
  const order: Visit[] = [];

  // A node is in the "free" state when the step that reached it permits descent, "stay" after a step up.
  const free = (id: NodeId): string => `free ${id}`;
  const stay = (id: NodeId): string => `stay ${id}`;
  const stateKey = (id: NodeId, move: Move | undefined): string =>
    move === 'up' ? stay(id) : free(id);
  const isVisited = (id: NodeId, move: Move): boolean =>
    visited.has(free(id)) || (move === 'up' && visited.has(stay(id)));

  for (const id of [...new Set(roots)].sort(compareIds)) {
    const visit: Visit = { id, depth: 0, parent: undefined, edge: undefined, move: undefined };
    visited.set(stateKey(id, undefined), visit);
    order.push(visit);
  }

  const seen = new Set<NodeId>(order.map((v) => v.id));
  const rootCount = seen.size;
  let hitCount = false;
  let frontier = [...order];
  for (let depth = 1; depth <= opts.maxDepth && !hitCount; depth += 1) {
    const next: Visit[] = [];
    for (const from of frontier) {
      const node = view.node(from.id);
      if (node === undefined) continue;
      for (const step of candidateSteps(view, node, from.move)) {
        if (!isFact(step.edge.provenance) || !isFact(step.to.provenance)) {
          skipped.add(edgeKey(step.edge));
          continue;
        }
        if (isVisited(step.to.id, step.move)) continue;
        if (!seen.has(step.to.id) && seen.size - rootCount >= opts.maxNodes) {
          hitCount = true;
          break;
        }
        const visit: Visit = {
          id: step.to.id,
          depth,
          parent: from,
          edge: step.edge,
          move: step.move,
        };
        visited.set(stateKey(step.to.id, step.move), visit);
        seen.add(step.to.id);
        order.push(visit);
        next.push(visit);
      }
      if (hitCount) break;
    }
    if (next.length === 0) break;
    frontier = next;
  }

  // Was there more graph past the depth cap?
  let hitDepth = false;
  if (!hitCount) {
    for (const from of frontier) {
      if (from.depth !== opts.maxDepth) continue;
      const node = view.node(from.id);
      if (node === undefined) continue;
      if (
        candidateSteps(view, node, from.move).some(
          (s) =>
            isFact(s.edge.provenance) && isFact(s.to.provenance) && !isVisited(s.to.id, s.move),
        )
      ) {
        hitDepth = true;
        break;
      }
    }
  }

  // A changed test case is itself affected, with no path to justify beyond the given id.
  const found = new Map<string, AffectedTest>();
  for (const visit of order) {
    if (visit.depth !== 0) break;
    const self = view.node(visit.id);
    if (
      self !== undefined &&
      self.kind === TEST_NODE_KIND &&
      self.deletedAt === null &&
      isFact(self.provenance)
    ) {
      found.set(self.id, { test: self, distance: 0, nodes: [self.id], edges: [] });
    }
  }

  // Tests: for every visited node in walk order, the TESTS edges into it.
  for (const visit of order) {
    for (const edge of view.edgesTo(visit.id, TEST_EDGE_KIND)) {
      if (edge.deletedAt !== null) continue;
      const test = view.node(edge.src);
      if (test === undefined || test.deletedAt !== null || test.kind !== TEST_NODE_KIND) continue;
      if (!isFact(edge.provenance) || !isFact(test.provenance)) {
        skipped.add(edgeKey(edge));
        continue;
      }
      if (found.has(test.id)) continue;
      const trail: Visit[] = [];
      for (let v: Visit | undefined = visit; v !== undefined; v = v.parent) trail.unshift(v);
      found.set(test.id, {
        test,
        distance: visit.depth + 1,
        nodes: [...trail.map((v) => v.id), test.id],
        edges: [...trail.flatMap((v) => (v.edge === undefined ? [] : [v.edge])), edge],
      });
    }
  }

  const tests = [...found.values()].sort(
    (a, b) => a.distance - b.distance || compareIds(a.test.id, b.test.id),
  );

  const reasons: Array<'result-cap' | 'depth-cap'> = [];
  if (hitCount) reasons.push('result-cap');
  if (hitDepth) reasons.push('depth-cap');
  return {
    tests,
    reached: [...new Set(order.filter((v) => v.depth > 0).map((v) => v.id))],
    state: reasons.length === 0 ? NOT_TRUNCATED : truncation(reasons, tests.length, null),
    skippedNonFact: skipped.size,
  };
}

// ---------------------------------------------------------------------------
// Roots that are test code
// ---------------------------------------------------------------------------

/** What `testCodeGate` found out about the given roots. */
export interface TestCodeGate {
  /** Roots that are a recognised test file, defined in one, or a recognised test helper. */
  readonly inTestCode: readonly NodeId[];
  /**
   * Live fact `TestCase` nodes whose defining file cannot be recovered (no `path`,
   * and no `<file>::` prefix in the name). Reported only when a root needed the
   * check: while any exists the set of test files is incomplete, so no root can
   * be called production code.
   */
  readonly unlocated: readonly NodeId[];
}

/**
 * Repo-relative paths of the files that define test cases: a `TestCase`'s
 * `path`, and the file part of its canonical name (its natural key is
 * `(repo, test_file, test_name)`, written `<file>::<name>`). A test case with
 * neither is `unlocated`.
 */
function testFilePaths(view: GraphView): { paths: ReadonlySet<string>; unlocated: NodeId[] } {
  const paths = new Set<string>();
  const unlocated: NodeId[] = [];
  for (const test of view.nodesByKind(TEST_NODE_KIND)) {
    if (test.deletedAt !== null || !isFact(test.provenance)) continue;
    let located = false;
    if (test.path !== undefined) {
      paths.add(test.path);
      located = true;
    }
    const name = parseNodeId(test.id).canonicalName;
    const cut = name.indexOf('::');
    if (cut > 0) {
      paths.add(name.slice(0, cut));
      located = true;
    }
    if (!located) unlocated.push(test.id);
  }
  return { paths, unlocated: unlocated.sort(compareIds) };
}

/** The `File` that is `node`, or that holds it through `CONTAINS`. */
function fileOf(view: GraphView, node: SeamlineNode): SeamlineNode | undefined {
  let current: SeamlineNode | undefined = node;
  for (let hops = 0; current !== undefined && hops < 4; hops += 1) {
    if (current.kind === 'File') return current;
    current = containerOf(view, current.id);
  }
  return undefined;
}

/** The live fact `File` at `node.path`, for a node that no `CONTAINS` edge places in a file. */
function fileAtPath(view: GraphView, node: SeamlineNode): SeamlineNode | undefined {
  if (node.path === undefined) return undefined;
  const file = view.node(nodeId(parseNodeId(node.id).repo, 'File', node.path));
  return file !== undefined && file.deletedAt === null && isFact(file.provenance)
    ? file
    : undefined;
}

/** Live fact `src` nodes of the live fact `kind` edges into `id`. */
function factSources(view: GraphView, id: NodeId, kind: EdgeKind): SeamlineNode[] {
  const out: SeamlineNode[] = [];
  for (const edge of view.edgesTo(id, kind)) {
    if (edge.deletedAt !== null || !isFact(edge.provenance)) continue;
    const src = view.node(edge.src);
    if (src !== undefined && src.deletedAt === null && isFact(src.provenance)) out.push(src);
  }
  return out;
}

/**
 * The given ids that are test code, and whether that check can be trusted.
 *
 * A change to test code affects tests, but nothing the walk follows leads from
 * it to those tests (`TESTS` runs from a `TestCase` to the code it exercises,
 * and the ontology has no `File` to `TestCase` edge). The answer for such a
 * root is therefore unknown. A `TestCase` given as a root is not test code in
 * this sense: it is returned as itself.
 *
 * A file is test support when it defines test cases, or when it has importers,
 * every one of them is test support (at any depth), and no test exercises it.
 * That is a fixpoint over `IMPORTS`. It is computed from the root's side: the
 * files that import it are collected until test files are reached, and the file
 * is support only if the whole set is grounded in test files, so a cycle of
 * helpers is support and a cycle of production files that nothing enters is not.
 *
 * What is recognised is structural, so the rule errs towards UNKNOWN in the
 * false-positive direction only: a production module that only tests import and
 * nothing exercises directly is called test support, which is safe. These are
 * not recognised, and are answered KNOWN with whatever tests were found:
 *  - a setup file that nothing imports (`conftest.py`, a jest `setupFiles`
 *    entry), which the runner loads implicitly;
 *  - a helper that has tests of its own, which looks like the production code
 *    those tests exercise;
 *  - a test file that defines no extracted `TestCase`.
 */
export function testCodeGate(view: GraphView, roots: readonly NodeId[]): TestCodeGate {
  const { paths, unlocated } = testFilePaths(view);
  if (paths.size === 0 && unlocated.length === 0) return { inTestCode: [], unlocated: [] };

  const isTestFile = (file: SeamlineNode): boolean =>
    (file.path !== undefined && paths.has(file.path)) ||
    paths.has(parseNodeId(file.id).canonicalName);
  /** Something in the file is the destination of a `TESTS` edge from a test case. */
  const isExercised = (file: SeamlineNode): boolean => {
    for (const edge of view.edgesFrom(file.id, 'CONTAINS')) {
      if (edge.deletedAt !== null) continue;
      if (factSources(view, edge.dst, TEST_EDGE_KIND).some((s) => s.kind === TEST_NODE_KIND)) {
        return true;
      }
    }
    return false;
  };
  const importersOf = (file: SeamlineNode): SeamlineNode[] =>
    factSources(view, file.id, 'IMPORTS').filter((importer) => importer.kind === 'File');

  const supportMemo = new Map<NodeId, boolean>();
  const isTestSupport = (file: SeamlineNode): boolean => {
    if (isTestFile(file)) return true;
    const known = supportMemo.get(file.id);
    if (known !== undefined) return known;

    // `file` and the files that import it, transitively, stopping at test files.
    const importers = new Map<NodeId, SeamlineNode[]>();
    const pending: SeamlineNode[] = [file];
    let support = true;
    while (pending.length > 0) {
      const current = pending.pop() as SeamlineNode;
      if (importers.has(current.id)) continue;
      const above = importersOf(current);
      // Exercised by a test: production code. Imported by nothing: an entry point, or an unimported
      // setup file (the grounding check below would reject it too; this only stops early).
      if (isExercised(current) || above.length === 0) {
        support = false;
        break;
      }
      importers.set(current.id, above);
      for (const importer of above) if (!isTestFile(importer)) pending.push(importer);
    }
    if (support) {
      // Grounded: every file in the set is reached from a test file by imports inside the set.
      const reached = new Set<NodeId>();
      for (let grew = true; grew;) {
        grew = false;
        for (const [id, above] of importers) {
          if (reached.has(id)) continue;
          if (above.some((importer) => isTestFile(importer) || reached.has(importer.id))) {
            reached.add(id);
            grew = true;
          }
        }
      }
      support = reached.size === importers.size;
    }
    supportMemo.set(file.id, support);
    return support;
  };

  const inTestCode: NodeId[] = [];
  let needed = false;
  for (const id of [...new Set(roots)].sort(compareIds)) {
    const node = view.node(id);
    if (node === undefined || node.kind === TEST_NODE_KIND) continue;
    needed = true;
    // A symbol with no container edge is still at a path, and may be in a test file or a helper.
    const file = fileOf(view, node) ?? fileAtPath(view, node);
    if (
      (node.path !== undefined && paths.has(node.path)) ||
      (file !== undefined && isTestSupport(file))
    ) {
      inTestCode.push(id);
    }
  }
  return { inTestCode, unlocated: needed ? unlocated : [] };
}
