/**
 * Seamline core contract.
 *
 * This module is the seam every other package is written against. It is
 * deliberately dependency-free and runtime-light: types, enums, and the small
 * total functions whose behaviour other packages must agree on exactly
 * (provenance precedence, status combination, id construction).
 *
 * Normative reference: docs/design/v3.md §2 (invariants), §4 (core profile).
 * Nothing here may be widened without a design-spec pass; see v3 §9.
 */

// ---------------------------------------------------------------------------
// Identity — v3 §2.1
// ---------------------------------------------------------------------------

/**
 * A node id is a path-free natural key, `{repo}:{kind}:{canonicalName}`.
 *
 * It is deliberately NOT a synthetic UUID/ULID. An id minted at first sight is
 * not stable across a rebuild-from-scratch, and rebuild-from-scratch is the
 * operation this whole design rests on ("registries are truth, the graph is
 * derived"). A natural key is reproducible, diffable, and debuggable.
 */
export type NodeId = string & { readonly __brand: 'NodeId' };

/** Construct a NodeId. `canonicalName` must already be path-free. */
export function nodeId(repo: string, kind: NodeKind, canonicalName: string): NodeId {
  if (repo.includes(':')) throw new Error(`repo must not contain ':': ${repo}`);
  if (canonicalName.length === 0) throw new Error('canonicalName must not be empty');
  return `${repo}:${kind}:${canonicalName}` as NodeId;
}

export function parseNodeId(id: NodeId): { repo: string; kind: NodeKind; canonicalName: string } {
  const first = id.indexOf(':');
  const second = id.indexOf(':', first + 1);
  if (first < 0 || second < 0) throw new Error(`malformed NodeId: ${id}`);
  return {
    repo: id.slice(0, first),
    kind: id.slice(first + 1, second) as NodeKind,
    canonicalName: id.slice(second + 1),
  };
}

// ---------------------------------------------------------------------------
// Core profile vocabulary — v3 §4
// ---------------------------------------------------------------------------

export const NODE_KINDS = [
  // Code
  'Repo', 'File', 'Module', 'Symbol', 'CodeField', 'Parameter', 'RouteHandler',
  // Data
  'DataSource', 'Schema', 'Table', 'Column', 'Migration',
  // Contract
  'Contract', 'Operation', 'SchemaProperty',
  // Domain (declared-only, optional)
  'Entity', 'DomainProperty',
  // Verification
  'TestCase', 'TestRun', 'CoverageRecord',
  // Change
  'Commit', 'Changeset',
  // People
  'Owner',
  // Meta
  'Run', 'Extractor', 'Contradiction', 'Alias', 'Lens', 'ThreatModel',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  // Containment — enumerated pairs, never "all domains" (v3 §4, fixes v2 C10)
  'CONTAINS',
  // Code
  'IMPORTS', 'EXPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'USES_TYPE',
  'DECORATED_WITH', 'HANDLES_ROUTE', 'QUERIES',
  // Data
  'MIGRATED_BY', 'FK_TO',
  // Contract
  'IMPLEMENTED_BY',
  // The join — the wedge, mostly INFERRED
  'MAPS_TO_FIELD', 'BACKED_BY', 'EXPOSED_AS', 'VALIDATED_BY', 'PERSISTED_IN', 'STORED_IN',
  // Verification
  'TESTS', 'COVERS',
  // Change
  'TOUCHES', 'RENAMED_FROM',
  // Meta
  'PRODUCED_BY', 'ALIAS_OF', 'OWNED_BY',
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * Declared domain and range for every edge kind.
 *
 * v2 declared its containment edges as "all domains" with no constraint, which
 * is how that design ended up with no Component -> File edge at all while four
 * of its lenses traversed one. Every edge here carries explicit endpoints, and
 * `ontology lint` fails the build on any edge used outside them.
 */
export const EDGE_SIGNATURES: Readonly<Record<EdgeKind, ReadonlyArray<readonly [NodeKind, NodeKind]>>> = {
  CONTAINS: [
    ['Repo', 'File'], ['Repo', 'Module'], ['Module', 'File'], ['File', 'Symbol'],
    ['Symbol', 'CodeField'], ['Symbol', 'Parameter'],
    ['DataSource', 'Schema'], ['Schema', 'Table'], ['Table', 'Column'],
    ['Contract', 'Operation'], ['Contract', 'SchemaProperty'],
    ['Entity', 'DomainProperty'],
  ],
  IMPORTS: [['File', 'File'], ['Module', 'Module']],
  EXPORTS: [['File', 'Symbol'], ['Module', 'Symbol']],
  CALLS: [['Symbol', 'Symbol']],
  EXTENDS: [['Symbol', 'Symbol']],
  IMPLEMENTS: [['Symbol', 'Symbol']],
  USES_TYPE: [['Symbol', 'Symbol'], ['CodeField', 'Symbol'], ['Parameter', 'Symbol']],
  DECORATED_WITH: [['Symbol', 'Symbol'], ['CodeField', 'Symbol']],
  HANDLES_ROUTE: [['Symbol', 'RouteHandler']],
  QUERIES: [['Symbol', 'Table']],
  MIGRATED_BY: [['Table', 'Migration'], ['Column', 'Migration']],
  FK_TO: [['Column', 'Column']],
  IMPLEMENTED_BY: [['Operation', 'RouteHandler']],
  MAPS_TO_FIELD: [['Column', 'CodeField']],
  BACKED_BY: [['SchemaProperty', 'Column']],
  EXPOSED_AS: [['Column', 'SchemaProperty'], ['CodeField', 'SchemaProperty']],
  VALIDATED_BY: [['CodeField', 'Symbol'], ['SchemaProperty', 'Symbol'], ['Column', 'Symbol']],
  PERSISTED_IN: [['Entity', 'Table']],
  STORED_IN: [['DomainProperty', 'Column']],
  TESTS: [['TestCase', 'Symbol']],
  COVERS: [['CoverageRecord', 'Symbol'], ['CoverageRecord', 'File']],
  TOUCHES: [['Commit', 'File'], ['Commit', 'Symbol'], ['Changeset', 'Symbol']],
  RENAMED_FROM: [['File', 'File'], ['Symbol', 'Symbol']],
  PRODUCED_BY: [['Run', 'Extractor']],
  ALIAS_OF: [['Alias', 'Symbol'], ['Alias', 'Column'], ['Alias', 'File']],
  OWNED_BY: [['File', 'Owner'], ['Module', 'Owner'], ['Table', 'Owner']],
};

export function isValidEdge(kind: EdgeKind, src: NodeKind, dst: NodeKind): boolean {
  return EDGE_SIGNATURES[kind].some(([s, d]) => s === src && d === dst);
}

// ---------------------------------------------------------------------------
// Provenance — v3 §2.4
// ---------------------------------------------------------------------------

export const PROVENANCE = ['EXTRACTED', 'DECLARED', 'INFERRED', 'LLM_SUGGESTED'] as const;
export type Provenance = (typeof PROVENANCE)[number];

/**
 * Total precedence order, highest first. Merge resolves conflicts by this
 * order, then by (extractorPriority, runId), so the outcome is deterministic
 * regardless of the order inputs arrive in.
 */
export const PROVENANCE_RANK: Readonly<Record<Provenance, number>> = {
  EXTRACTED: 3,
  DECLARED: 2,
  INFERRED: 1,
  LLM_SUGGESTED: 0,
};

/** True when `a` outranks `b`. Never returns true for equal provenance. */
export function outranks(a: Provenance, b: Provenance): boolean {
  return PROVENANCE_RANK[a] > PROVENANCE_RANK[b];
}

/** Provenance that is treated as fact. Gates and contradiction detection read only these. */
export function isFact(p: Provenance): boolean {
  return p === 'EXTRACTED' || p === 'DECLARED';
}

// ---------------------------------------------------------------------------
// Sensitivity — v3 §2.5
// ---------------------------------------------------------------------------

export const SENSITIVITY = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Sensitivity = (typeof SENSITIVITY)[number];

/** Default sensitivity per kind. Export is default-deny; a profile must allow-list. */
export const DEFAULT_SENSITIVITY: Readonly<Record<NodeKind, Sensitivity>> = Object.freeze(
  Object.fromEntries(
    NODE_KINDS.map((k) => [
      k,
      k === 'Owner' || k === 'ThreatModel' ? 'restricted'
      : k === 'Column' || k === 'DataSource' || k === 'Schema' || k === 'Table' ? 'confidential'
      : 'internal',
    ]),
  ) as Record<NodeKind, Sensitivity>,
);

// ---------------------------------------------------------------------------
// Nodes and edges
// ---------------------------------------------------------------------------

/**
 * NOTE: no `createdAt`/`updatedAt` here, by design. v2 put wall-clock
 * timestamps on every node, which alone makes byte-identical output
 * impossible. Time belongs to the run, not to the fact. See v3 §2.3.
 */
export interface SeamlineNode {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly name: string;
  /** Repo-relative POSIX path. A property, never part of identity (v3 §2.1). */
  readonly path?: string;
  readonly sensitivity: Sensitivity;
  readonly provenance: Provenance;
  readonly confidence: number;
  readonly sourceRef?: string;
  /** True when any string field derives from third-party content (v3 §2.6). */
  readonly untrusted?: boolean;
  readonly props: Readonly<Record<string, string | number | boolean | null>>;
  readonly firstSeenRun: string;
  readonly lastSeenRun: string;
  readonly deletedAt: string | null;
}

export interface SeamlineEdge {
  readonly kind: EdgeKind;
  readonly src: NodeId;
  readonly dst: NodeId;
  /** Carried so the re-run invalidation rule can find affected edges (v3 §2.1). */
  readonly srcFile?: string;
  readonly dstFile?: string;
  readonly provenance: Provenance;
  readonly confidence: number;
  readonly sourceRef?: string;
  readonly props: Readonly<Record<string, string | number | boolean | null>>;
  readonly firstSeenRun: string;
  readonly lastSeenRun: string;
  readonly deletedAt: string | null;
}

/** Edge identity for the UNIQUE(scope, src, dst, kind) constraint (v3 §2.2). */
export function edgeKey(scope: string, e: Pick<SeamlineEdge, 'src' | 'dst' | 'kind'>): string {
  return `${scope} ${e.src} ${e.dst} ${e.kind}`;
}

// ---------------------------------------------------------------------------
// Runs, scopes, extractor status — v3 §2.2
// ---------------------------------------------------------------------------

/**
 * UNAVAILABLE is never PASS. Any query whose answer depends on a scope whose
 * producing extractor did not PASS returns UNKNOWN for that portion and never
 * a negative finding. This is what stops infrastructure flakiness from
 * manufacturing false findings.
 */
export const EXTRACTOR_STATUS = ['PASS', 'FAIL', 'UNAVAILABLE'] as const;
export type ExtractorStatus = (typeof EXTRACTOR_STATUS)[number];

/** The (kind, selector) pairs a run is the authority for. Drives tombstoning. */
export interface AuthoritativeScope {
  readonly scope: string;
  readonly kinds: ReadonlyArray<NodeKind>;
  readonly selector?: string;
}

export interface ExtractorResult {
  readonly extractor: string;
  readonly version: string;
  readonly status: ExtractorStatus;
  readonly authoritative: ReadonlyArray<AuthoritativeScope>;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly durationMs: number;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface RunRecord {
  readonly runId: string;
  readonly repo: string;
  readonly commit: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly ontologyVersion: string;
  readonly results: ReadonlyArray<ExtractorResult>;
}

/** A query answer that may be unknown because a producing extractor did not PASS. */
export type Known<T> = { readonly known: true; readonly value: T };
export type Unknown = { readonly known: false; readonly reason: string; readonly scopes: ReadonlyArray<string> };
export type Maybe<T> = Known<T> | Unknown;

export const known = <T>(value: T): Known<T> => ({ known: true, value });
export const unknown = (reason: string, scopes: ReadonlyArray<string> = []): Unknown => ({ known: false, reason, scopes });

// ---------------------------------------------------------------------------
// Extractor manifest — v3 §2.7
// ---------------------------------------------------------------------------

/**
 * The host enforces this; it is not documentation. An extractor may not assert
 * a provenance above `provenanceCeiling` — `infer-join` cannot emit EXTRACTED,
 * and that is a runtime error rather than a code-review question.
 */
export interface ExtractorManifest {
  readonly name: string;
  readonly version: string;
  readonly reads: ReadonlyArray<string>;
  readonly net: false;
  readonly env: ReadonlyArray<string>;
  readonly memMb: number;
  readonly timeoutS: number;
  readonly provenanceCeiling: Provenance;
  readonly produces: ReadonlyArray<AuthoritativeScope>;
}

export function assertWithinCeiling(m: ExtractorManifest, p: Provenance): void {
  if (PROVENANCE_RANK[p] > PROVENANCE_RANK[m.provenanceCeiling]) {
    throw new Error(
      `extractor ${m.name} asserted provenance ${p} above its declared ceiling ${m.provenanceCeiling}`,
    );
  }
}

// ---------------------------------------------------------------------------
// SIF — Seamline Interchange Format, v3 §2.3
// ---------------------------------------------------------------------------

export type SifLine =
  | { readonly t: 'run'; readonly run: RunRecord }
  | { readonly t: 'status'; readonly result: ExtractorResult }
  | { readonly t: 'node'; readonly node: SeamlineNode }
  | { readonly t: 'edge'; readonly edge: SeamlineEdge };

// ADR-0018: documents begin with the non-JSON line seamline-sif/2.0.0 plus LF.
export const SIF_VERSION = '2.0.0';

// ---------------------------------------------------------------------------
// Contradictions — v3 §5
// ---------------------------------------------------------------------------

export const CONTRADICTION_CODES = [
  'X1_NULLABILITY', 'X2_TYPE', 'X3_CONSTRAINT', 'X4_UNBACKED_PROPERTY',
  'X5_UNWRITTEN_COLUMN', 'X6_PII_UNAUTHENTICATED', 'X7_VALIDATOR_DIVERGENCE',
  'X8_ORPHANED_MIGRATION', 'X9_CONTRACT_DRIFT', 'X10_UNTESTED_PII_WRITE',
] as const;
export type ContradictionCode = (typeof CONTRADICTION_CODES)[number];

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/**
 * A contradiction cites the two authoritative facts that disagree. It is never
 * raised from the absence of a declaration — that was v2's `Gap`, which the
 * council found unactionable, gameable, and in violation of "assert
 * authoritative state, not presence".
 */
export interface Contradiction {
  readonly code: ContradictionCode;
  readonly severity: Severity;
  readonly left: NodeId;
  readonly right: NodeId;
  readonly claim: string;
  readonly leftFact: string;
  readonly rightFact: string;
  readonly viaPath: ReadonlyArray<EdgeKind>;
  readonly confidence: number;
}

/** A detector must declare the scopes it needs, so it can yield UNKNOWN. */
export interface ContradictionDetector {
  readonly code: ContradictionCode;
  readonly severity: Severity;
  readonly requiredScopes: ReadonlyArray<string>;
  detect(g: GraphView): ReadonlyArray<Contradiction>;
}

// ---------------------------------------------------------------------------
// Store — v3 §2.6, §3. Typed traversal only; `cypher` is deliberately absent.
// ---------------------------------------------------------------------------

export interface TraverseQuery {
  readonly from: ReadonlyArray<NodeId>;
  readonly via: ReadonlyArray<EdgeKind>;
  readonly direction?: 'out' | 'in' | 'both';
  /** Bounded by construction. The store rejects anything above its configured cap. */
  readonly maxDepth: number;
  readonly toKinds?: ReadonlyArray<NodeKind>;
  readonly factsOnly?: boolean;
  readonly limit?: number;
}

export interface GraphView {
  nodesByKind(kind: NodeKind): ReadonlyArray<SeamlineNode>;
  node(id: NodeId): SeamlineNode | undefined;
  edgesFrom(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge>;
  edgesTo(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge>;
  /** UNKNOWN when a scope's producing extractor did not PASS (v3 §2.2). */
  scopeStatus(scope: string): ExtractorStatus;
}

export interface GraphStore extends GraphView {
  beginRun(run: Omit<RunRecord, 'finishedAt' | 'results'>): Promise<void>;
  upsertNodes(runId: string, nodes: ReadonlyArray<SeamlineNode>): Promise<void>;
  upsertEdges(runId: string, scope: string, edges: ReadonlyArray<SeamlineEdge>): Promise<void>;
  /** Tombstones what vanished from this run's authoritative scope. Never hard-deletes. */
  finalizeRun(runId: string, results: ReadonlyArray<ExtractorResult>): Promise<void>;
  traverse(q: TraverseQuery): Promise<Maybe<ReadonlyArray<SeamlineNode>>>;
  close(): Promise<void>;
}
