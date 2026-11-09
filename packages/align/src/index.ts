/**
 * @seamline/align: the public surface.
 *
 * A second report family beside the contradiction pipeline (ADR-0014): it
 * compares what a repository's documents claim with what its code and
 * manifests show, classifies each comparison, and emits a versioned, redacted,
 * consumer-agnostic finding packet. It never gates a build.
 */

export { AlignError, type AlignErrorKind } from './errors.ts';
export { readBaseline, packetDigest, type Baseline, type BaselineFinding } from './baseline.ts';
export {
  DEFAULT_DOC_GLOBS,
  DEFAULT_EXCLUDE_GLOBS,
  evaluate,
  findingId,
  selectDocuments,
  type EvaluateInput,
} from './engine.ts';
export {
  buildScopeTable,
  runProvenance,
  type AlignFacts,
  type FactsRun,
  type ImportEdge,
  type ScopeEntry,
} from './facts.ts';
export {
  ALIGN_VERSION,
  PACKET_SCHEMA,
  PACKET_SCHEMA_VERSION,
  UNTRUSTED_FIELDS,
  type Packet,
  type PacketBody,
  type PacketFinding,
  type PacketProposal,
} from './packet.ts';
export { RedactedPacket, redactPacket } from './redact.ts';
export { runAlign, type AlignOutput, type AlignRequest } from './run.ts';
export { SUMMARY_SCHEMA, summaryJson, summaryObject, summaryText } from './summary.ts';
export { memTree, gitTree, resolveCommit, worktreeTree, type Tree } from './tree.ts';
export {
  CLAIM_KINDS,
  CLASSES,
  UNKNOWN_REASONS,
  type AlignClass,
  type ClaimKind,
  type UnknownReason,
} from './types.ts';
export { Rendered, writeOutput, type AlignSink, type Destination } from './write.ts';
