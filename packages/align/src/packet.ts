/**
 * The finding packet, schema v1 (design section 8).
 *
 * A consumer-agnostic, versioned record of what a repository's documents claim
 * and whether the implementation facts support it. Within version 1 a producer
 * never removes, renames or retypes a field; it may add fields, and a consumer
 * must ignore fields it does not know (8.7).
 */

import type { AlignClass, Claim, ClaimKind, UnknownReason } from './types.ts';

export const PACKET_SCHEMA = 'seamline.alignment-packet';
export const PACKET_SCHEMA_VERSION = 1;
export const ALIGN_VERSION = 1;

/** Fields whose text comes from the repository and is not to be trusted by a consumer (8.1). */
export const UNTRUSTED_FIELDS: readonly string[] = [
  'findings[].claims[].excerpt',
  'findings[].fact.detail',
  'findings[].unknown.detail',
  'inputs.*.diagnostics[]',
  'proposals[].note',
];

export type PacketStatus = 'PASS' | 'FAIL' | 'UNAVAILABLE';

export interface PacketFact {
  probe: string;
  probeVersion: number;
  status: PacketStatus;
  provenance: 'EXTRACTED' | 'DECLARED';
  result: 'HOLDS' | 'DIFFERENT' | 'ABSENT' | 'UNKNOWN';
  observed: string | boolean | null;
  binding: 'B1' | null;
  detail: string;
  source: null | { path: string; lineStart: number; lineEnd: number; commit: string | null };
}

export interface PacketUnknown {
  reason: UnknownReason;
  scopes: string[];
  detail: string;
}

export interface PacketResolved {
  from: 'Observed drift' | 'Unexplained gap';
  by: string;
  baseline: { claimDigest: string | null; factDigest: string | null };
}

export interface PacketFinding {
  id: string;
  class: AlignClass;
  claimKind: ClaimKind;
  subject: string;
  member: string | null;
  reason: string;
  claims: Claim[];
  fact: PacketFact | null;
  unknown: PacketUnknown | null;
  resolved: PacketResolved | null;
  digests: { claim: string | null; fact: string | null };
}

export interface PacketProposal {
  id: string;
  claimKind: ClaimKind;
  subject: string;
  provenance: 'INFERRED';
  basis: 'name-match';
  candidate: { kind: 'File'; canonicalName: string };
  note: string;
}

export interface PacketDoc {
  path: string;
  sha256: string | null;
  status: 'PASS' | 'FAIL';
  claims: number;
  diagnostics: string[];
}

export interface PacketProbe {
  probe: string;
  version: number;
  status: PacketStatus;
  diagnostics: string[];
}

export interface Packet {
  schema: typeof PACKET_SCHEMA;
  schemaVersion: typeof PACKET_SCHEMA_VERSION;
  repo: string;
  producer: { tool: 'seamline'; toolVersion: string; alignVersion: number; sifVersion: string };
  subject: { commit: string | null; worktree: boolean };
  run: {
    runId: string;
    commit: string | null;
    ontologyVersion: string | null;
    pairing: 'verified' | 'asserted';
    extractors: { name: string; version: string; status: PacketStatus; scopes: string[] }[];
    scopes: { scope: string; status: PacketStatus; kinds: string[]; runId: string }[];
    facts: { source: 'store' | 'sif'; digest: string };
  };
  inputs: { docs: PacketDoc[]; probes: PacketProbe[]; excluded: string[] };
  baseline: null | { digest: string; commit: string | null; runId: string | null };
  summary: { classes: Record<AlignClass, number>; claims: number; aligned: number };
  sensitivity: 'internal';
  untrustedFields: string[];
  findings: PacketFinding[];
  proposals: PacketProposal[];
  digest: string;
}

/** A packet before its digest is computed. */
export type PacketBody = Omit<Packet, 'digest'>;
