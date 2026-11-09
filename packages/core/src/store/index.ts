/**
 * Public surface of the graph store. Re-exports only.
 *
 * `packages/core/src/index.ts` is owned elsewhere; import from
 * `./store/index.ts` until it re-exports this module.
 */

export { SqliteStore } from './sqlite-store.ts';
export type { SqliteStoreOptions } from './sqlite-store.ts';

export {
  SCHEMA_VERSION,
  SCHEMA_SQL,
  META_ONTOLOGY_VERSION,
  META_SCHEMA_VERSION,
  StoreError,
  SchemaMismatchError,
  OntologyVersionMismatchError,
  RunStateError,
  applySchema,
  assertOntologyVersion,
  canonicalProps,
  rowToEdge,
  rowToNode,
} from './schema.ts';
export type { EdgeRow, NodeRow } from './schema.ts';

export {
  DEFAULT_TRAVERSE_LIMITS,
  TraverseQueryError,
  TraversalBudgetExceededError,
  buildTraverseSql,
  dependentNodeKinds,
  validateTraverseQuery,
} from './traverse.ts';
export type { NormalizedQuery, TraverseLimits } from './traverse.ts';

export {
  MAX_SELECTOR_PATTERNS,
  SelectorError,
  assertAuthoritySelectors,
  claimCoversEdge,
  claimCoversNode,
  compiledSelectorOf,
  compileSelector,
  selectorHasExclusions,
  selectorParam,
  selectorPredicateSql,
  selectorProblem,
} from './scope-selector.ts';
export type { CompiledSelector, GlobClause } from './scope-selector.ts';
export type { AuthorityContext, AuthorityNode } from './canonical-authority.ts';

export { memoryGraphIndex } from './memory-graph.ts';
export type { MemoryGraphIndex } from './memory-graph.ts';

export { describeNarrowedClaim, narrowedClaims } from './claim-coverage.ts';
export { currentObservationOf, isCompletedRun } from './current-observation.ts';
export type { NarrowedClaim } from './claim-coverage.ts';

export {
  CANONICAL_SELECTOR_PREFIX,
  MAX_CANONICAL_SELECTOR_BYTES,
  MAX_CANONICAL_SELECTOR_RULES,
  assertCanonicalSelectorBudget,
  compileCanonicalSelector,
  encodeCanonicalSelector,
  isCanonicalSelectorText,
} from './canonical-selector.ts';
export type { CanonicalRule, CanonicalSelectorInput, CompiledCanonicalSelector } from './canonical-selector.ts';
