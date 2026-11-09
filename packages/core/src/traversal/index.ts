/**
 * Public surface of the shared bounded-traversal primitives. Re-exports only.
 */

export {
  NOT_TRUNCATED,
  capDepth,
  capList,
  mergeTruncation,
  truncation,
} from './bounds.ts';
export type { Truncation, TruncationReason, TruncationState } from './bounds.ts';

export { bfs, IMPACT_EDGE_KINDS, neighbours } from './reachability.ts';
export type { BfsResult, Neighbour, Reached } from './reachability.ts';
