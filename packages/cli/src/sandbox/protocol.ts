/**
 * The wire format between the sandbox host (the `seamline` process) and the
 * sandbox child (one extractor, confined).
 *
 * Request: one JSON document on the child's stdin. Response: one JSON document
 * on file descriptor 3. stdout and stderr carry nothing the host trusts, so an
 * extractor that prints cannot forge or corrupt a result.
 *
 * The JSON envelope carries framed SIF documents for output authority and
 * facts. The graph-view input has no authority metadata. The host decodes the
 * complete output before applying manifest scopes and the provenance ceiling.
 */

import { PROVENANCE } from '@seamline/ontology';
import type {
  ExtractorManifest,
  ExtractorStatus,
  NodeId,
  SeamlineEdge,
  SeamlineNode,
} from '@seamline/ontology';
import { SANDBOX_VIOLATIONS, type SandboxViolationCode } from '@seamline/core';
import type { ExtractContext, ExtractorOutput } from '../ports.ts';
import type { EncodedExtractorOutput } from './output-codec.ts';

export const PROTOCOL_VERSION = 2;

/** Advisory fd4 markers, never a result or evidence that a run passed. */
export const CHILD_PHASES = [
  'bootstrap', 'request-read', 'guards-installed', 'program-import',
  'program-loaded', 'run', 'output', 'send', 'sent',
] as const;
export type ChildPhase = (typeof CHILD_PHASES)[number];

/** What a program may do beyond the baseline, granted by the host, never by the manifest. */
export interface SandboxGrants {
  /** Binary base names the program may start (`git`). Empty: no child process at all. */
  readonly exec: ReadonlyArray<string>;
  /**
   * For each name in `exec`, the real absolute path the host found it at, outside the repository.
   * The child starts a program by its name or by exactly that path, and is run at that path; any
   * other spelling of any path is refused, and a name with no path here cannot be started at all.
   */
  readonly execPaths?: Readonly<Record<string, string>>;
}

/** A graph the host copied out of its store, for a program that infers over other extractors' facts. */
export interface GraphSnapshot {
  /** Every live node, grouped by kind in `NODE_KINDS` order, each kind in the order the store returned it. */
  readonly nodes: ReadonlyArray<SeamlineNode>;
  /** `edgesFrom(id)` for every node that has any, in the store's order. */
  readonly from: ReadonlyArray<readonly [NodeId, ReadonlyArray<SeamlineEdge>]>;
  /** `edgesTo(id)` for every node that has any, in the store's order. */
  readonly to: ReadonlyArray<readonly [NodeId, ReadonlyArray<SeamlineEdge>]>;
  /** `scopeStatus(scope)` for the scopes the program reads. Any other scope is UNAVAILABLE. */
  readonly scopes: ReadonlyArray<readonly [string, ExtractorStatus]>;
}

export type ProgramContext = Omit<ExtractContext, 'view'>;

export interface SandboxRequest {
  readonly v: typeof PROTOCOL_VERSION;
  /** Absolute path of the module that exports `run(ctx, graph?)`. */
  readonly program: string;
  readonly manifest: ExtractorManifest;
  /** The repository root, by its real path: what is granted, where the child starts, what the program is given. */
  readonly repoRoot: string;
  /**
   * The repository root as the caller named it, present only when that is a different string (the
   * repository was reached through a symlinked directory). The guard uses it to recognise a name
   * that spells the repository the way the caller did as a name of the repository; it is never
   * read, never granted and never shown to the program.
   */
  readonly repoRootAs?: string;
  /** Directories the program's own code is read from. */
  readonly codeRoots: ReadonlyArray<string>;
  readonly grants: SandboxGrants;
  readonly ctx: ProgramContext;
  readonly graph?: GraphSnapshot;
}

/** What a program module exports. */
export interface ProgramModule {
  run(ctx: ExtractContext, graph?: GraphSnapshot): Promise<ExtractorOutput>;
}

/** One thing the in-child guard refused. */
export interface RecordedDenial {
  readonly code: SandboxViolationCode;
  readonly message: string;
  /**
   * True for a content read, a write, a socket or a process the manifest does
   * not permit: the extractor asked for something it may not have, and whatever
   * it did next, its result cannot be trusted to be complete. False for a
   * metadata probe of something outside the repo (a parent directory's
   * `node_modules`), which was answered "not found" and is only logged.
   */
  readonly fatal: boolean;
  /**
   * What was asked for: `content` for a read, a write, a socket or a process, `probe` for a look at
   * metadata (stat, readdir, realpath). A probe that is fatal is a look at a repo path that leads
   * out of the repo: the extractor was told "not found" and the run fails closed. The host reads
   * anything but `probe` as `content`, because this arrives from the child.
   */
  readonly access: 'content' | 'probe';
  /** How many times this exact denial happened. */
  readonly count: number;
}

export type SandboxFailure =
  | { readonly kind: 'violation'; readonly code: SandboxViolationCode; readonly message: string }
  | { readonly kind: 'protocol'; readonly message: string }
  | { readonly kind: 'error'; readonly name: string; readonly message: string };

export type SandboxResponse =
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly ok: true;
      readonly output: EncodedExtractorOutput;
      readonly denials: ReadonlyArray<RecordedDenial>;
      readonly denialsTruncated?: boolean;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly ok: false;
      readonly failure: SandboxFailure;
      readonly denials: ReadonlyArray<RecordedDenial>;
      readonly denialsTruncated?: boolean;
    };

// ---------------------------------------------------------------------------
// Validation of what the child sent back
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const STATUSES: ReadonlyArray<string> = ['PASS', 'FAIL', 'UNAVAILABLE'];
const PROVENANCES: ReadonlyArray<string> = PROVENANCE;
const VIOLATIONS: ReadonlySet<string> = new Set(SANDBOX_VIOLATIONS);

function problemWithItems(label: string, items: unknown): string | undefined {
  if (!Array.isArray(items)) return `${label} is not an array`;
  for (let i = 0; i < items.length; i += 1) {
    const item: unknown = items[i];
    if (!isRecord(item)) return `${label}[${i}] is not an object`;
    // An unknown provenance string would sail through the ceiling comparison
    // (`undefined > n` is false), so it is refused here instead.
    if (typeof item['provenance'] !== 'string' || !PROVENANCES.includes(item['provenance'])) {
      return `${label}[${i}] has no valid provenance`;
    }
  }
  return undefined;
}

/**
 * Structural check of an `ExtractorOutput` that came off the wire. Returns the
 * first problem, or undefined. It checks what the host is about to rely on
 * (statuses, counts, provenance on every node and edge), not what the
 * extractor means by it.
 */
export function outputProblem(output: unknown): string | undefined {
  if (!isRecord(output)) return 'output is not an object';
  const result = output['result'];
  if (!isRecord(result)) return 'result is missing';
  for (const key of ['extractor', 'version']) {
    if (typeof result[key] !== 'string') return `result.${key} is not a string`;
  }
  if (typeof result['status'] !== 'string' || !STATUSES.includes(result['status'])) {
    return 'result.status is not PASS, FAIL or UNAVAILABLE';
  }
  for (const key of ['nodeCount', 'edgeCount', 'durationMs']) {
    if (typeof result[key] !== 'number' || !Number.isFinite(result[key]))
      return `result.${key} is not a number`;
  }
  const diagnostics = result['diagnostics'];
  if (!Array.isArray(diagnostics) || !diagnostics.every((d) => typeof d === 'string')) {
    return 'result.diagnostics is not an array of strings';
  }
  const authoritative = result['authoritative'];
  if (!Array.isArray(authoritative)) return 'result.authoritative is not an array';
  for (const scope of authoritative as unknown[]) {
    if (!isRecord(scope) || typeof scope['scope'] !== 'string' || !Array.isArray(scope['kinds'])) {
      return 'result.authoritative holds a malformed scope';
    }
  }
  const nodeProblem = problemWithItems('nodes', output['nodes']);
  if (nodeProblem !== undefined) return nodeProblem;
  for (const [i, node] of (output['nodes'] as Array<Record<string, unknown>>).entries()) {
    if (typeof node['id'] !== 'string' || typeof node['kind'] !== 'string') {
      return `nodes[${i}] has no string id and kind`;
    }
  }
  const groups = output['edges'];
  if (!Array.isArray(groups)) return 'edges is not an array';
  for (let i = 0; i < groups.length; i += 1) {
    const group: unknown = groups[i];
    if (!isRecord(group) || typeof group['scope'] !== 'string') return `edges[${i}] has no scope`;
    const problem = problemWithItems(`edges[${i}].edges`, group['edges']);
    if (problem !== undefined) return problem;
  }
  const ambiguities = output['ambiguities'];
  if (ambiguities !== undefined && !Array.isArray(ambiguities))
    return 'ambiguities is not an array';
  return undefined;
}

/** True for a response whose envelope the host can read. The `output` is checked separately. */
export function isResponse(v: unknown): v is SandboxResponse {
  if (!isRecord(v) || v['v'] !== PROTOCOL_VERSION || typeof v['ok'] !== 'boolean') return false;
  if (!Array.isArray(v['denials']) || !v['denials'].every(denial =>
    isRecord(denial) && typeof denial['code'] === 'string' && VIOLATIONS.has(denial['code']) &&
    typeof denial['message'] === 'string' && typeof denial['fatal'] === 'boolean' &&
    (denial['access'] === 'content' || denial['access'] === 'probe') &&
    Number.isSafeInteger(denial['count']) && (denial['count'] as number) >= 1)) return false;
  const truncated = v['denialsTruncated'];
  if (truncated !== undefined && typeof truncated !== 'boolean') return false;
  if (v['ok'] === true) return isRecord(v['output']);
  const failure = v['failure'];
  if (!isRecord(failure) || typeof failure['message'] !== 'string') return false;
  if (failure['kind'] === 'violation') return typeof failure['code'] === 'string' && VIOLATIONS.has(failure['code']);
  if (failure['kind'] === 'error') return typeof failure['name'] === 'string';
  return failure['kind'] === 'protocol';
}
