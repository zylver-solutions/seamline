/** Current extraction authority is narrower than the liveness of retained facts. */
import { parseNodeId, type AuthoritativeScope, type RunRecord, type SeamlineNode } from '@seamline/ontology';
import { assertCanonicalSelectorBudget } from './canonical-selector.ts';
import { claimCoversNode, compiledSelectorOf } from './scope-selector.ts';

/** A missing or blank completion marker cannot certify observations. */
export function isCompletedRun(run: RunRecord | undefined): run is RunRecord & { readonly finishedAt: string } {
  return run !== undefined && typeof run.finishedAt === 'string' && run.finishedAt.trim().length > 0;
}

/** Shared by hosts: a fresh stamp without valid, completed authority proves nothing. */
export function currentObservationOf(run: RunRecord | undefined): (scope: string, node?: SeamlineNode) => boolean {
  if (!isCompletedRun(run)) return () => false;
  try { assertCanonicalSelectorBudget(run.results.flatMap(result => result.authoritative)); }
  catch { return () => false; }
  const claims = new Map<string, AuthoritativeScope[]>();
  const blocked = new Set<string>();
  for (const result of run.results) {
    for (const claim of result.authoritative) {
      if (result.status !== 'PASS') { blocked.add(claim.scope); continue; }
      try {
        compiledSelectorOf(claim);
        const prior = claims.get(claim.scope) ?? [];
        prior.push(claim);
        claims.set(claim.scope, prior);
      } catch { blocked.add(claim.scope); }
    }
  }
  return (scope, node) => {
    const authority = claims.get(scope);
    if (blocked.has(scope) || authority === undefined) return false;
    if (node === undefined) return true;
    if (node.deletedAt !== null || node.lastSeenRun !== run.runId) return false;
    try {
      return parseNodeId(node.id).repo === run.repo &&
        authority.some(claim => claimCoversNode(claim, node, { repo: run.repo }));
    } catch { return false; }
  };
}
