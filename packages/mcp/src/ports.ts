/**
 * Ports — the injection seam for the Seamline MCP server.
 *
 * The server owns protocol handling, parameter validation, response bounding,
 * and untrusted-text delimiting. It owns no storage and no detection: those
 * arrive as an implementation of `GraphSource`.
 *
 * `@seamline/cli` declares a structurally identical `StorePort` /
 * `DetectorRunnerPort` seam. TypeScript is structural, so one concrete
 * implementation satisfies both; the duplication exists only so neither
 * package depends on the other.
 */

import type { ExportProfile } from '@seamline/core';
import type {
  Contradiction,
  ContradictionCode,
  ExtractorStatus,
  GraphView,
  RunRecord,
  Severity,
} from '@seamline/ontology';

/**
 * A detector that could not run: a required scope is not PASS (`scopes` names them), or it stood
 * down for a reason of its own read from recorded facts (`scopes` is empty).
 */
export interface UnknownDetection {
  readonly code: ContradictionCode;
  readonly severity: Severity;
  readonly reason: string;
  readonly scopes: readonly string[];
  readonly scopeStatus: Readonly<Record<string, ExtractorStatus>>;
  /**
   * Set when every scope PASSed and the detector still cannot speak because
   * `code.ts` did not read this many workspace packages.
   */
  readonly unreadCodePackages?: number;
}

export interface DetectionReport {
  readonly contradictions: readonly Contradiction[];
  readonly unknown: readonly UnknownDetection[];
}

/**
 * Everything the server reads. `detect` is optional: a build without a
 * detector still serves `context`, `impact`, `lineage`, and `explain`, and
 * `contradictions` reports that detection is unavailable rather than returning
 * an empty list an agent would read as "nothing is wrong".
 */
export interface GraphSource {
  view(): Promise<GraphView>;
  latestRun(): Promise<RunRecord | undefined>;
  /**
   * Runs detection over `view`, which is the export-profile view the server
   * built, not the raw store. An implementation must read only from it, so a
   * finding can only rest on facts the profile releases. The server keeps a
   * finding only when its endpoints and path are in the view, and re-renders
   * its claim and facts from the profiled nodes; detector prose is never
   * forwarded.
   */
  detect?(view: GraphView): Promise<DetectionReport>;
  close?(): Promise<void>;
}

/** One audited tool invocation. v3 §2.6 requires an audit log on the MCP surface. */
export interface AuditEvent {
  readonly tool: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly resultCount: number;
  readonly truncated: boolean;
  readonly error?: string;
}

export interface Bounds {
  /** Maximum items in any one result list. */
  readonly maxResults: number;
  /** Maximum traversal depth, whatever the caller asks for. */
  readonly maxDepth: number;
  /** Maximum serialized response size in bytes. */
  readonly maxBytes: number;
  /** Maximum length of any single string field before it is elided. */
  readonly maxStringLength: number;
  /** Maximum number of ids accepted by `impact`. */
  readonly maxInputIds: number;
}

/**
 * Deliberately small. An agent must never be able to pull the whole graph
 * through one call (v3 §2.6), and these are the numbers that make that true.
 * They are a ceiling: a caller may ask for less, never for more.
 */
export const DEFAULT_BOUNDS: Bounds = {
  maxResults: 100,
  maxDepth: 4,
  maxBytes: 64 * 1024,
  maxStringLength: 2000,
  maxInputIds: 32,
};

export interface McpDeps {
  readonly graph: GraphSource;
  /**
   * The export profile every tool is evaluated inside. Required: the server is
   * default-deny exactly like `seamline export`, so there is no "serve the whole
   * store" mode. Tools, detection, truncation totals and traversals all run
   * over `profileView(graph.view(), profile)`, never over the raw view.
   */
  readonly profile: ExportProfile;
  /** Overrides are clamped to `DEFAULT_BOUNDS`; they can lower a cap, never raise it. */
  readonly bounds?: Partial<Bounds>;
  /** Nonce source for untrusted-block delimiters. Injected for deterministic tests. */
  readonly nonce?: () => string;
  readonly audit?: (e: AuditEvent) => void;
  /**
   * Server-side log for detail that must not reach the client, such as the
   * message of an exception thrown by the graph source or a detector (it can
   * name paths, tables or fields the profile withholds). The client only ever
   * sees a generic internal error. Defaults to discarding the detail.
   */
  readonly log?: (line: string) => void;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

/** Clamps a caller's bounds to the ceiling. A request can only narrow. */
export function resolveBounds(override: Partial<Bounds> | undefined): Bounds {
  if (override === undefined) return DEFAULT_BOUNDS;
  return {
    maxResults: clamp(override.maxResults, DEFAULT_BOUNDS.maxResults),
    maxDepth: clamp(override.maxDepth, DEFAULT_BOUNDS.maxDepth),
    maxBytes: clamp(override.maxBytes, DEFAULT_BOUNDS.maxBytes),
    maxStringLength: clamp(override.maxStringLength, DEFAULT_BOUNDS.maxStringLength),
    maxInputIds: clamp(override.maxInputIds, DEFAULT_BOUNDS.maxInputIds),
  };
}

function clamp(v: number | undefined, ceiling: number): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return ceiling;
  return Math.min(Math.floor(v), ceiling);
}
