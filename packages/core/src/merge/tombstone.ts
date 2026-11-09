/**
 * Tombstoning: how the graph forgets (v3 §2.2).
 *
 * Three rules, in order of how badly it hurts to get them wrong.
 *
 * 1. **A non-`PASS` extractor tombstones nothing.** A crashed extractor
 *    produces no facts, not the absence of facts. Without this, one flaky run
 *    empties a scope and every downstream gate turns into a false finding —
 *    which is the fastest way to get a CI gate switched off.
 * 2. **Tombstoning is confined to the run's declared authoritative scope.** A
 *    code extractor must never bury a database column. Anything outside the
 *    scope comes through untouched, down to object identity. A selector
 *    narrows edges as it narrows nodes: a run that did not read a file cannot
 *    bury the edges that file declares. What a claim covers is defined once, in
 *    `store/scope-selector.ts` ("What a claim covers"), and `SqliteStore`'s
 *    sweep evaluates the same rule in SQL.
 * 3. **Nothing is ever hard-deleted.** A tombstone is `deletedAt = runId`;
 *    the row stays, and a later sighting resurrects it (`lifecycle.ts`).
 */

import type { AuthoritativeScope, NodeId, SeamlineEdge, SeamlineNode } from '@seamline/ontology';

import { assertAuthoritySelectors, claimCoversEdge, claimCoversNode } from '../store/scope-selector.ts';
import type { AuthorityContext } from '../store/canonical-authority.ts';
import { assertCanonicalSelectorBudget } from '../store/canonical-selector.ts';
import { compareRuns, tombstone } from './lifecycle.ts';
import {
  mergeBatches,
  type MergeBatch,
  type MergedEdge,
  type MergedNode,
  type MergeState,
  type ScopeStatusEntry,
} from './state.ts';
import { compareStrings } from './serialize.ts';

const GLOB_SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * Minimal, deterministic glob: `**` crosses separators, `*` and `?` do not.
 * No brace expansion, no character classes. Selectors are not matched with
 * this: `scopeCoversNode` uses `store/scope-selector.ts`, the one definition
 * the store's sweep shares.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(GLOB_SPECIAL, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function globMatch(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

/**
 * Whether `scope` is the authority for `node`: its kind is claimed and, when
 * the claim has a selector, its path matches. A node with no path never matches
 * a selector, as in the store; its name is never consulted. Throws
 * `SelectorError` for a selector that does not compile, as the store does.
 * Canonical claims additionally require the active repository context and
 * canonical-id/kind/path matching; a display name never supplies identity.
 */
export function scopeCoversNode(scope: AuthoritativeScope, node: SeamlineNode, context?: AuthorityContext): boolean {
  return claimCoversNode(scope, node, context);
}

/**
 * Whether `scope` is the authority for an edge stored under `edgeScope`: the
 * scope is the claim's and, when the claim has a selector over node kinds, the
 * edge's anchor file (`srcFile`, else `dstFile`) matches it. The same rule the
 * store's edge sweep evaluates in SQL.
 * Canonical claims instead use endpoint identities and a stored node anchor
 * from the supplied context, as defined by ADR-0018.
 */
export function scopeCoversEdge(
  scope: AuthoritativeScope,
  edgeScope: string,
  edge: SeamlineEdge,
  context?: AuthorityContext,
): boolean {
  return claimCoversEdge(scope, edgeScope, edge, context);
}

/** One run's claim of authority over one scope. */
export interface ScopeClaim {
  readonly runId: string;
  readonly repo?: string;
  readonly scope: AuthoritativeScope;
}

/**
 * Earliest claiming run that did not see the fact. Selecting the minimum, not
 * the first match, keeps the recorded death run independent of claim order.
 */
function earliestClaim(
  claims: ReadonlyArray<ScopeClaim>,
  matches: (c: ScopeClaim) => boolean,
): ScopeClaim | undefined {
  let best: ScopeClaim | undefined;
  for (const c of claims) {
    if (!matches(c)) continue;
    if (best === undefined || compareRuns(c.runId, best.runId) < 0) best = c;
  }
  return best;
}

export interface TombstoneReport {
  readonly state: MergeState;
  readonly nodes: ReadonlyArray<NodeId>;
  readonly edges: ReadonlyArray<string>;
}

/**
 * Bury everything that was in `prior` inside a claimed scope and did not come
 * back in the claiming run. Entries outside every claim are carried over by
 * reference, so "untouched" is observable as object identity, not just equality.
 */
export function tombstoneVanished(
  prior: MergeState,
  merged: MergeState,
  claims: ReadonlyArray<ScopeClaim>,
): TombstoneReport {
  if (claims.length === 0) return { state: merged, nodes: [], edges: [] };
  const scopesByRun = new Map<string, AuthoritativeScope[]>();
  for (const claim of claims) {
    const scopes = scopesByRun.get(claim.runId) ?? [];
    scopes.push(claim.scope);
    scopesByRun.set(claim.runId, scopes);
  }
  for (const scopes of scopesByRun.values()) assertAuthoritySelectors(scopes);

  const nodes = new Map(merged.nodes);
  const edges = new Map(merged.edges);
  const buriedNodes: NodeId[] = [];
  const buriedEdges: string[] = [];
  const contextOf = (claim: ScopeClaim): AuthorityContext | undefined => claim.repo === undefined ? undefined : {
    repo: claim.repo,
    node: id => merged.nodes.get(id)?.node,
  };

  for (const [id, priorNode] of prior.nodes) {
    const current = nodes.get(id);
    if (current === undefined) continue;
    const claim = earliestClaim(
      claims,
      (c) =>
        scopeCoversNode(c.scope, priorNode.node, contextOf(c)) &&
        compareRuns(current.node.lastSeenRun, c.runId) < 0,
    );
    if (claim === undefined) continue;
    const life = tombstone(current.node, claim.runId);
    if (life.deletedAt === current.node.deletedAt) continue;
    const next: MergedNode = { node: { ...current.node, ...life }, source: current.source };
    nodes.set(id, next);
    buriedNodes.push(id);
  }

  for (const [key, priorEdge] of prior.edges) {
    const current = edges.get(key);
    if (current === undefined) continue;
    const claim = earliestClaim(
      claims,
      (c) =>
        scopeCoversEdge(c.scope, priorEdge.scope, priorEdge.edge, contextOf(c)) &&
        compareRuns(current.edge.lastSeenRun, c.runId) < 0,
    );
    if (claim === undefined) continue;
    const life = tombstone(current.edge, claim.runId);
    if (life.deletedAt === current.edge.deletedAt) continue;
    const next: MergedEdge = {
      edge: { ...current.edge, ...life },
      scope: current.scope,
      source: current.source,
    };
    edges.set(key, next);
    buriedEdges.push(key);
  }

  buriedNodes.sort(compareStrings);
  buriedEdges.sort(compareStrings);
  return { state: { nodes, edges, scopes: merged.scopes }, nodes: buriedNodes, edges: buriedEdges };
}

/**
 * The claims a set of batches makes. Only `PASS` batches claim anything — this
 * one line is rule 1 above, and it is the single most important behaviour in
 * this module.
 */
export function claimsOf(batches: ReadonlyArray<MergeBatch>): ReadonlyArray<ScopeClaim> {
  const claims: ScopeClaim[] = [];
  const byRun = new Map<string, AuthoritativeScope[]>();
  for (const batch of batches) {
    const scopes = byRun.get(batch.runId) ?? [];
    for (const scope of batch.authoritative) scopes.push(scope);
    byRun.set(batch.runId, scopes);
  }
  for (const scopes of byRun.values()) assertCanonicalSelectorBudget(scopes);
  for (const batch of batches) {
    if (batch.status !== 'PASS') continue;
    for (const scope of batch.authoritative) claims.push({
      runId: batch.runId, scope, ...(batch.repo === undefined ? {} : { repo: batch.repo }),
    });
  }
  return claims;
}

export interface RunApplication extends TombstoneReport {
  /** Extractors whose facts and claims were both discarded, and why. */
  readonly skipped: ReadonlyArray<{ readonly extractor: string; readonly reason: string }>;
  readonly scopes: ReadonlyArray<ScopeStatusEntry>;
}

/** Merge a run's batches into the prior state, then tombstone what vanished. */
export function applyRun(prior: MergeState, batches: ReadonlyArray<MergeBatch>): RunApplication {
  const claims = claimsOf(batches);
  const merged = mergeBatches(batches, prior);
  const report = tombstoneVanished(prior, merged, claims);
  const skipped = batches
    .filter((b) => b.status !== 'PASS')
    .map((b) => ({
      extractor: b.extractor,
      reason: `status ${b.status}: contributed no facts and claimed no authority`,
    }));
  return {
    ...report,
    skipped,
    scopes: [...report.state.scopes.values()].sort((a, b) => compareStrings(a.scope, b.scope)),
  };
}

/** What `setAsideAttempt` set aside, so that `settleAttempt` gives back exactly that. */
interface SetAside {
  readonly state: MergeState;
  readonly nodes: ReadonlySet<NodeId>;
  readonly edges: ReadonlySet<string>;
}

/**
 * `prior` as the new attempt at `runId` sees it: every live entry that an earlier
 * attempt at the same run id stamped has that sighting set aside (`lastSeenRun`
 * becomes empty, which `lifecycle.ts` already reads as never seen). Without this a
 * repeated run id would find its own earlier stamps on everything and bury nothing,
 * because `tombstoneVanished` asks whether an entry's last sighting is older than
 * the claiming run. Entries buried, or stamped by another run, are carried over by
 * reference. The store does the same in SQL (`SqliteStore.restartRun`), where the
 * stamp itself says whose sighting was set aside; here the entries are recorded, so
 * that an entry whose `lastSeenRun` was already empty is never mistaken for one.
 */
function setAsideAttempt(prior: MergeState, runId: string): SetAside {
  const nodes = new Map(prior.nodes);
  const setAsideNodes = new Set<NodeId>();
  for (const [id, entry] of prior.nodes) {
    if (entry.node.deletedAt !== null || entry.node.lastSeenRun !== runId) continue;
    nodes.set(id, { node: { ...entry.node, lastSeenRun: '' }, source: entry.source });
    setAsideNodes.add(id);
  }
  const edges = new Map(prior.edges);
  const setAsideEdges = new Set<string>();
  for (const [key, entry] of prior.edges) {
    if (entry.edge.deletedAt !== null || entry.edge.lastSeenRun !== runId) continue;
    edges.set(key, {
      edge: { ...entry.edge, lastSeenRun: '' },
      scope: entry.scope,
      source: entry.source,
    });
    setAsideEdges.add(key);
  }
  return {
    state: { nodes, edges, scopes: prior.scopes },
    nodes: setAsideNodes,
    edges: setAsideEdges,
  };
}

/**
 * The end of an attempt: an entry that was set aside and is still unseen and live
 * was outside every claim of the attempt, so nothing was learned about it and it
 * takes back the stamp it had, the run's. A buried one keeps the empty stamp, so
 * its tombstone postdates it. An entry that was not set aside is never touched,
 * whatever its stamp.
 */
function settleAttempt(state: MergeState, setAside: SetAside, runId: string): MergeState {
  const nodes = new Map(state.nodes);
  for (const id of setAside.nodes) {
    const entry = state.nodes.get(id);
    if (entry === undefined || entry.node.deletedAt !== null || entry.node.lastSeenRun !== '') {
      continue;
    }
    nodes.set(id, { node: { ...entry.node, lastSeenRun: runId }, source: entry.source });
  }
  const edges = new Map(state.edges);
  for (const key of setAside.edges) {
    const entry = state.edges.get(key);
    if (entry === undefined || entry.edge.deletedAt !== null || entry.edge.lastSeenRun !== '') {
      continue;
    }
    edges.set(key, {
      edge: { ...entry.edge, lastSeenRun: runId },
      scope: entry.scope,
      source: entry.source,
    });
  }
  return { nodes, edges, scopes: state.scopes };
}

/**
 * `applyRun` for a run id the state has already seen: a new attempt at `runId`.
 *
 * Run ids repeat under `SEAMLINE_DETERMINISTIC=1` (they are derived from inputs),
 * and the earlier attempt's entries already carry the id, so `applyRun` alone would
 * take them for the new attempt's. This sets that sighting aside first and settles
 * it afterwards: whatever a PASS batch claims and the attempt did not re-emit is
 * buried, whatever the earlier attempt stored under the same id, and everything
 * outside a PASS claim is carried over live with its stamp. All batches must be
 * the attempt's own.
 */
export function applyRestartedRun(
  prior: MergeState,
  runId: string,
  batches: ReadonlyArray<MergeBatch>,
): RunApplication {
  for (const batch of batches) {
    if (batch.runId !== runId) {
      throw new Error(`batch of run ${batch.runId} cannot be applied as an attempt at ${runId}`);
    }
  }
  const setAside = setAsideAttempt(prior, runId);
  const result = applyRun(setAside.state, batches);
  const state = settleAttempt(result.state, setAside, runId);
  return {
    ...result,
    state,
    scopes: [...state.scopes.values()].sort((a, b) => compareStrings(a.scope, b.scope)),
  };
}
