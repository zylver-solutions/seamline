/**
 * `impact` with `targets: "tests"`: the tests a change reaches.
 *
 * Read `affected-tests.ts` first for what counts as a justification (facts
 * only) and for when the answer is UNKNOWN rather than an empty list. This file
 * turns that into a response: it decides the `answer`, adds the synthetic
 * UNKNOWN scope when no test facts were extracted at all, bounds the list, and
 * optionally fits it to a token budget.
 */

import {
  isFact,
  type EdgeKind,
  type NodeId,
  type NodeKind,
  type SeamlineEdge,
} from '@seamline/ontology';
import { capList, fitToByteBudget, mergeTruncation } from '../bounds.ts';
import {
  findAffectedTests,
  testCodeGate,
  testFactStatus,
  walkDegradedScopes,
  withheldFromWalk,
  type AffectedTest,
  type TestFactStatus,
} from '../affected-tests.ts';
import {
  assembleWithinBudget,
  compareIds,
  summarizeDetached,
  type DetachedSummary,
  type Rendered,
} from '../budget.ts';
import { summarizeEdge } from '../graph.ts';
import { envelope, type ToolEnvelope, type UnknownScope } from '../result.ts';
import type { ToolContext } from './registry.ts';

/**
 * The scope name reported when no scope in the latest run produces `TestCase`.
 * It is a placeholder for "the scope that would have produced them", since by
 * definition no run named one.
 */
export const MISSING_TEST_SCOPE = 'tests';

interface Candidate {
  readonly affected: AffectedTest;
  readonly detached: DetachedSummary;
}

function describeStatus(status: TestFactStatus): string[] {
  switch (status.state) {
    case 'withheld':
      return [
        'UNKNOWN: the export profile in force does not release TestCase nodes and TESTS edges, so whether tests are affected cannot be answered here. This is not "no affected tests".',
      ];
    case 'none-extracted':
      return [
        'UNKNOWN: no test facts were extracted. The latest run declared no scope that produces TestCase nodes, so TESTS edges do not exist in this graph. This is not "no affected tests".',
      ];
    case 'degraded':
      return [
        `UNKNOWN: a scope that produces test facts did not PASS (${status.scopes.join(', ')}). Tests listed are justified by facts now in the graph, but the list may be incomplete or stale. An empty list is not "no affected tests".`,
      ];
    case 'known':
      return [];
  }
}

export function affectedTests(input: {
  readonly ctx: ToolContext;
  readonly roots: readonly NodeId[];
  /** Ids that did not resolve to a live node. */
  readonly missing: readonly string[];
  /** Ids the input cap dropped before they were looked up: never assessed. */
  readonly dropped: readonly string[];
  readonly depth: number;
  readonly unknown: readonly UnknownScope[];
  readonly notices: readonly string[];
  readonly tokenBudget: number | undefined;
}): ToolEnvelope {
  const { ctx } = input;
  const status = testFactStatus(ctx.view, ctx.run, ctx.released);
  // The same set of ids is the same question, so the answer must not depend on the order they were typed in.
  const distinctRoots = [...new Set(input.roots)].sort(compareIds);
  // A path of facts starts at a fact. A starting node that is only INFERRED or LLM_SUGGESTED is not assessed.
  const notFacts = distinctRoots.filter((id) => {
    const node = ctx.view.node(id);
    return node === undefined || !isFact(node.provenance);
  });
  const roots = distinctRoots.filter((id) => !notFacts.includes(id));
  // An id dropped by the input cap is not assessed either, unless an earlier copy of it was.
  const dropped = input.dropped.filter((id) => !distinctRoots.includes(id as NodeId));
  const missing = [...new Set([...input.missing, ...dropped, ...notFacts])].sort(compareIds);

  const unknown =
    status.state === 'none-extracted'
      ? [
          ...input.unknown,
          {
            scope: MISSING_TEST_SCOPE,
            status: 'UNAVAILABLE' as const,
            extractor: 'none declared',
            diagnostics: [],
          },
        ].sort((a, b) => compareIds(a.scope, b.scope))
      : input.unknown;

  const notices = [...input.notices, ...describeStatus(status)];

  // Walk only when there are test facts to walk: with none extracted or released,
  // anything found would rest on facts no PASS scope vouches for.
  const walkable = status.state === 'known' || status.state === 'degraded';
  const walk =
    walkable && roots.length > 0
      ? findAffectedTests(ctx.view, roots, {
          maxDepth: input.depth,
          maxNodes: ctx.bounds.maxResults,
        })
      : undefined;

  // The scopes that produce test facts are described by `describeStatus`; this is every other scope the walk depends on.
  const testScopes = 'scopes' in status ? status.scopes : [];
  const walkDegraded = walkable
    ? walkDegradedScopes(ctx.view, ctx.run).filter((scope) => !testScopes.includes(scope))
    : [];
  const walkState = walk?.state;
  const walkStopped = walkState?.truncated === true;
  const stoppedBy = walkState !== undefined && walkState.truncated ? walkState.reasons : [];

  // A kind the profile withholds is invisible to the walk, not absent from the graph.
  const withheld = walkable
    ? withheldFromWalk(ctx.released)
    : { nodeKinds: [] as NodeKind[], edgeKinds: [] as EdgeKind[] };
  const hidden = [
    ...withheld.nodeKinds.map((kind) => `${kind} nodes`),
    ...withheld.edgeKinds.map((kind) => `${kind} edges`),
  ];
  const { inTestCode, unlocated } =
    walkable && roots.length > 0
      ? testCodeGate(ctx.view, roots)
      : { inTestCode: [] as NodeId[], unlocated: [] as NodeId[] };

  // KNOWN only when nothing the answer rests on is missing: every test scope and every
  // scope that produces what the walk crosses PASSed, the profile releases every kind the
  // walk crosses, every requested id was assessed and is not test code (and the check
  // for that can be trusted), and the walk reached the end of the graph it was allowed to
  // look at. A list that is merely cut afterwards (result cap, token budget) keeps its
  // answer: its truncation reports the true total.
  const answer =
    status.state === 'known' &&
    walkDegraded.length === 0 &&
    hidden.length === 0 &&
    missing.length === 0 &&
    inTestCode.length === 0 &&
    unlocated.length === 0 &&
    !walkStopped &&
    roots.length > 0
      ? 'KNOWN'
      : 'UNKNOWN';

  if (walkDegraded.length > 0) {
    notices.push(
      `UNKNOWN: a scope that produces nodes or edges this walk crosses did not PASS (${walkDegraded.join(', ')}). Tests listed are justified by facts now in the graph, but a dependent may be missing from it. An empty list is not "no affected tests".`,
    );
  }
  if (hidden.length > 0) {
    notices.push(
      `UNKNOWN: the export profile in force does not release ${hidden.join(', ')}, which this walk crosses, so a dependent may be hidden from it. Tests listed are justified by what the profile releases. An empty list is not "no affected tests".`,
    );
  }
  if (missing.length > 0) {
    notices.push(
      `UNKNOWN: ${missing.length} requested id(s) were not assessed (${missing.join(', ')}). The answer covers only the ids that were.`,
    );
  }
  if (notFacts.length > 0) {
    notices.push(
      `${notFacts.length} id(s) resolved to an INFERRED or LLM_SUGGESTED node and were not assessed: only facts justify a test, so a guessed node is not a starting point.`,
    );
  }
  if (inTestCode.length > 0) {
    notices.push(
      `UNKNOWN: ${inTestCode.join(', ')} ${inTestCode.length === 1 ? 'is' : 'are'} a recognised test file, defined in one, or a recognised test helper (a file that only test files import, directly or through other helpers, and that no test exercises): changes to test files and test helpers are not traced to the tests they affect (the ontology has no File to TestCase edge). Tests listed are those the walk found; others may be affected. An empty list is not "no affected tests".`,
    );
  }
  if (unlocated.length > 0) {
    const shown = unlocated.slice(0, 3).join(', ');
    const more = unlocated.length > 3 ? ` and ${unlocated.length - 3} more` : '';
    notices.push(
      `UNKNOWN: ${unlocated.length} test case(s) carry neither a path nor a file in their name (${shown}${more}), so the files that define tests are not all known and whether a given id is test code cannot be checked. An empty list is not "no affected tests".`,
    );
  }
  if (stoppedBy.includes('depth-cap')) {
    notices.push(
      `UNKNOWN: the walk stopped at its depth cap (${input.depth} hop(s)), so dependents beyond it were not examined. Raise \`depth\` (the server ceiling is ${ctx.bounds.maxDepth}) or narrow the ids. An empty list is not "no affected tests".`,
    );
  }
  if (stoppedBy.includes('result-cap')) {
    notices.push(
      `UNKNOWN: the walk stopped at its node cap (${ctx.bounds.maxResults} nodes), so dependents beyond it were not examined. Narrow the ids; raising \`depth\` does not lift this cap. An empty list is not "no affected tests".`,
    );
  }

  const capped = capList(walk?.tests ?? [], ctx.bounds.maxResults);
  const prior = mergeTruncation(walk?.state ?? { truncated: false }, capped.state);

  const items: Candidate[] = capped.items.map((affected) => ({
    affected,
    detached: summarizeDetached(affected.test, ctx.render),
  }));

  if (walk !== undefined && walk.skippedNonFact > 0) {
    notices.push(
      `${walk.skippedNonFact} INFERRED or LLM_SUGGESTED link(s) met on the walk were not used: only facts justify a test.`,
    );
  }
  if (answer === 'KNOWN' && items.length === 0 && !prior.truncated) {
    notices.push(
      `No test case reaches these ids over fact-justified paths within ${input.depth} dependency hop(s) and within the walked edge kinds, given the extracted test facts.`,
    );
  }
  if (answer === 'KNOWN' && unknown.length > 0) {
    // A scope that did not PASS but that no walked edge can depend on. Say so, so the list of
    // scopes in `unknown` is not read as a doubt about this answer.
    notices.push(
      `Scope(s) listed in \`unknown\` (${unknown.map((u) => u.scope).join(', ')}) declare no node kind this walk crosses, so this answer does not depend on them.`,
    );
  }
  // Tests found, as opposed to tests returned: a reader of `result` alone sees a cut list.
  const found = walk?.tests.length ?? 0;
  // "Empty result with degraded scopes" is an UNKNOWN banner. It must not sit next to a KNOWN absence.
  const emptyResult = items.length === 0 && answer !== 'KNOWN';

  const render = (kept: readonly Candidate[]): Rendered => {
    const used = new Map<string, SeamlineEdge>();
    for (const c of kept)
      for (const e of c.affected.edges) used.set(`${e.src} ${e.dst} ${e.kind}`, e);
    const edges = [...used.values()].sort(
      (a, b) => compareIds(a.src, b.src) || compareIds(a.dst, b.dst) || compareIds(a.kind, b.kind),
    );
    return {
      result: {
        targets: 'tests',
        answer,
        testScopes,
        roots,
        missing,
        depth: input.depth,
        tests: kept.map((c) => ({
          test: c.detached.summary,
          distance: c.affected.distance,
          path: { nodes: c.affected.nodes, via: c.affected.edges.map((e) => e.kind) },
        })),
        ...(kept.length < found ? { testsReturned: kept.length, testsTotal: found } : {}),
        edges: edges.map(summarizeEdge),
        nonFactLinksNotUsed: walk?.skippedNonFact ?? 0,
      },
      blocks: kept.flatMap((c) => c.detached.blocks),
    };
  };

  if (input.tokenBudget !== undefined) {
    return assembleWithinBudget({
      tool: 'impact',
      tokenBudget: input.tokenBudget,
      bounds: ctx.bounds,
      items,
      prior,
      unknown,
      notices,
      emptyResult,
      render,
      sink: ctx.render,
    });
  }

  const fitted = fitToByteBudget(items, (kept) => render(kept).result, ctx.bounds.maxBytes, prior);
  ctx.render.blocks.push(...render(fitted.items).blocks);
  return envelope('impact', fitted.body, {
    state: fitted.state,
    unknown,
    notices,
    emptyResult,
  });
}
