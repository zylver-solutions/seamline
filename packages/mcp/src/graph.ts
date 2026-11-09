/**
 * Bounded graph reads, and the rendering of a node into agent-safe JSON.
 *
 * Traversal here is deliberately narrow: fixed edge-kind sets per tool, a
 * depth cap, and a visited-node cap. There is no general query entry point,
 * because v3 §2.6 removes `cypher` from the store interface — on the Postgres
 * adapter it was arbitrary query execution inside the database.
 *
 * `neighbours`/`bfs`/`IMPACT_EDGE_KINDS` (and their `Neighbour`/`Reached`/
 * `BfsResult` types) are `@seamline/core`'s — shared with the CLI's
 * `blast-radius` and `why` commands — and re-exported here unchanged.
 * `CONTEXT_EDGE_KINDS`, `LINEAGE_EDGE_KINDS`, `LINEAGE_TARGET_KINDS`, and the
 * agent-facing rendering below stay local: they are MCP-specific.
 */

import {
  parseNodeId,
  type EdgeKind,
  type GraphView,
  type NodeId,
  type NodeKind,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import { bfs, compareCodeUnits, IMPACT_EDGE_KINDS, neighbours } from '@seamline/core';
import type { BfsResult, Neighbour, Reached } from '@seamline/core';
import { capString } from './bounds.ts';
import type { Bounds } from './ports.ts';
import { attemptedEscape, neutralize, wrapUntrusted } from '@seamline/security';

export { bfs, IMPACT_EDGE_KINDS, neighbours };
export type { BfsResult, Neighbour, Reached };

/**
 * What a node sits in and what it directly touches: structural and code edges,
 * plus the cross-domain joins.
 *
 * The joins belong here even though `lineage` walks them in depth. An agent
 * asking "what is this column" needs to be told the column is exposed as an
 * API property in the same breath as being told which table contains it;
 * omitting that is exactly the siloed answer this project exists to fix.
 */
export const CONTEXT_EDGE_KINDS: readonly EdgeKind[] = [
  'CONTAINS',
  'IMPORTS',
  'EXPORTS',
  'CALLS',
  'EXTENDS',
  'IMPLEMENTS',
  'USES_TYPE',
  'DECORATED_WITH',
  'HANDLES_ROUTE',
  'QUERIES',
  'TESTS',
  'OWNED_BY',
  'MAPS_TO_FIELD',
  'BACKED_BY',
  'EXPOSED_AS',
  'VALIDATED_BY',
  'PERSISTED_IN',
  'STORED_IN',
  'FK_TO',
  'ALIAS_OF',
];

/** The join — v3 §4's wedge. Identical to the CLI's set, by design. */
export const LINEAGE_EDGE_KINDS: readonly EdgeKind[] = [
  'MAPS_TO_FIELD',
  'BACKED_BY',
  'EXPOSED_AS',
  'VALIDATED_BY',
  'PERSISTED_IN',
  'STORED_IN',
  'FK_TO',
  'ALIAS_OF',
];

export const LINEAGE_TARGET_KINDS: readonly NodeKind[] = [
  'Column',
  'CodeField',
  'SchemaProperty',
  'DomainProperty',
  'Parameter',
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface NodeSummary {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly path: string | null;
  readonly provenance: string;
  readonly confidence: number;
  readonly sensitivity: string;
  readonly untrusted: boolean;
  readonly props: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EdgeSummary {
  readonly kind: EdgeKind;
  readonly src: string;
  readonly dst: string;
  readonly provenance: string;
  readonly confidence: number;
  readonly sourceRef: string | null;
}

/**
 * Accumulates the untrusted blocks a response must carry, so the caller can
 * append them once at the end rather than interleaving them with structured
 * data.
 */
export interface RenderContext {
  readonly bounds: Bounds;
  readonly nonce: string;
  readonly blocks: string[];
  /** True when any input tried to break out of a delimiter. Surfaced in the response. */
  escapeAttempts: number;
}

export function renderContext(bounds: Bounds, nonce: string): RenderContext {
  return { bounds, nonce, blocks: [], escapeAttempts: 0 };
}

/**
 * Renders a node for an agent.
 *
 * When `untrusted` is set, every string the node carries is neutralized in the
 * structured output *and* reproduced inside a delimited block, so the agent
 * sees the content, sees that it is data, and cannot be addressed by it.
 */
export function summarizeNode(node: SeamlineNode, ctx: RenderContext): NodeSummary {
  const untrusted = node.untrusted === true;
  const clean = (s: string): string => {
    if (!untrusted) return capString(s, ctx.bounds.maxStringLength).value;
    if (attemptedEscape(s)) ctx.escapeAttempts += 1;
    return capString(neutralize(s), ctx.bounds.maxStringLength).value;
  };

  const props: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(node.props).sort()) {
    const v = node.props[key];
    props[key] = typeof v === 'string' ? clean(v) : (v ?? null);
  }

  if (untrusted) {
    const textFields = [`name: ${node.name}`];
    for (const key of Object.keys(node.props).sort()) {
      const v = node.props[key];
      if (typeof v === 'string') textFields.push(`${key}: ${v}`);
    }
    ctx.blocks.push(wrapUntrusted(`${node.kind} ${node.id}`, textFields.join('\n'), ctx.nonce));
  }

  return {
    id: node.id,
    kind: node.kind,
    name: clean(node.name),
    path: node.path ?? null,
    provenance: node.provenance,
    confidence: node.confidence,
    sensitivity: node.sensitivity,
    untrusted,
    props,
  };
}

export function summarizeEdge(e: SeamlineEdge): EdgeSummary {
  return {
    kind: e.kind,
    src: e.src,
    dst: e.dst,
    provenance: e.provenance,
    confidence: e.confidence,
    sourceRef: e.sourceRef ?? null,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveResult {
  readonly matches: readonly SeamlineNode[];
  readonly strategy: 'node-id' | 'canonical-name' | 'suffix' | 'name' | 'none';
}

/**
 * Resolves a symbol/field name to nodes. Every match is returned; the tool
 * decides whether an ambiguous answer is an error or a list, and neither
 * silently picks one.
 */
export function resolveNode(view: GraphView, raw: string, kinds: readonly NodeKind[]): ResolveResult {
  const query = raw.trim();
  if (query.length === 0) return { matches: [], strategy: 'none' };

  if (query.split(':').length >= 3) {
    try {
      parseNodeId(query as NodeId);
      const direct = view.node(query as NodeId);
      if (direct !== undefined && direct.deletedAt === null) return { matches: [direct], strategy: 'node-id' };
    } catch {
      // fall through
    }
  }

  const pool: SeamlineNode[] = [];
  for (const kind of kinds) {
    for (const n of view.nodesByKind(kind)) if (n.deletedAt === null) pool.push(n);
  }
  pool.sort((a, b) => compareCodeUnits(a.id, b.id));

  const exact = pool.filter((n) => parseNodeId(n.id).canonicalName === query);
  if (exact.length > 0) return { matches: exact, strategy: 'canonical-name' };

  const lower = query.toLowerCase();
  const suffix = pool.filter((n) => {
    const cn = parseNodeId(n.id).canonicalName.toLowerCase();
    return cn === lower || cn.endsWith(`.${lower}`) || cn.endsWith(`/${lower}`) || cn.endsWith(`#${lower}`);
  });
  if (suffix.length > 0) return { matches: suffix, strategy: 'suffix' };

  const byName = pool.filter((n) => n.name.toLowerCase() === lower);
  if (byName.length > 0) return { matches: byName, strategy: 'name' };

  return { matches: [], strategy: 'none' };
}

/** The `CONTAINS` parent, if any. */
export function containerOf(view: GraphView, id: NodeId): SeamlineNode | undefined {
  for (const e of view.edgesTo(id, 'CONTAINS')) {
    if (e.deletedAt !== null) continue;
    const parent = view.node(e.src);
    if (parent !== undefined) return parent;
  }
  return undefined;
}
