/**
 * The alias table — how history survives a rename (v3 §2.1).
 *
 * When a canonical name is retired, an `ALIAS_OF` row maps the old id to the
 * current one. `resolve` walks that chain. A rename loop is a real thing that
 * happens (A renamed to B in one run, B back to A in the next), so resolution
 * is cycle-detecting and depth-bounded by construction: it terminates on every
 * input, and it picks a *deterministic* representative for a cycle rather than
 * whichever entry it happened to start from.
 */

import {
  isValidEdge,
  parseNodeId,
  type NodeId,
  type NodeKind,
  type Provenance,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';

import { aliasName, makeNodeId } from './canonical.ts';

/** Hard ceiling on chain length. A longer chain is a data bug, not a rename. */
export const MAX_ALIAS_CHAIN = 32;

export const ALIAS_REASONS = ['git-rename', 'content-hash', 'declared'] as const;
export type AliasReason = (typeof ALIAS_REASONS)[number];

/** Kinds `ALIAS_OF` may target, per `EDGE_SIGNATURES` in the contract. */
export const ALIAS_TARGET_KINDS: ReadonlyArray<NodeKind> = ['Symbol', 'Column', 'File'];

export interface AliasRow {
  /** The retired id. */
  readonly from: NodeId;
  /** The id it was renamed to. May itself be retired later. */
  readonly to: NodeId;
  readonly runId: string;
  readonly confidence: number;
  readonly reason: AliasReason;
}

export type AliasTermination = 'terminal' | 'cycle' | 'depth';

export interface AliasResolution {
  /** The current id. For a cycle, the lexicographically smallest member. */
  readonly id: NodeId;
  readonly hops: number;
  readonly terminatedBy: AliasTermination;
  /** The ids walked, starting at the input. */
  readonly chain: ReadonlyArray<NodeId>;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic winner when two rows retire the same id to different targets:
 * higher confidence, then later run, then the lexicographically smaller target.
 * Order-independent, so ingestion order cannot change the table.
 */
export function preferAlias(a: AliasRow, b: AliasRow): AliasRow {
  if (a.confidence !== b.confidence) return a.confidence > b.confidence ? a : b;
  const byRun = cmp(a.runId, b.runId);
  if (byRun !== 0) return byRun > 0 ? a : b;
  const byTo = cmp(a.to, b.to);
  if (byTo !== 0) return byTo < 0 ? a : b;
  return cmp(a.reason, b.reason) <= 0 ? a : b;
}

export class AliasTable {
  readonly #rows = new Map<NodeId, AliasRow>();

  static from(rows: Iterable<AliasRow>): AliasTable {
    const t = new AliasTable();
    t.addAll(rows);
    return t;
  }

  get size(): number {
    return this.#rows.size;
  }

  add(row: AliasRow): void {
    if (row.from === row.to) {
      throw new Error(`alias from and to must differ: ${row.from}`);
    }
    if (!(row.confidence >= 0 && row.confidence <= 1)) {
      throw new Error(`alias confidence must be within [0, 1]: ${row.confidence}`);
    }
    const from = parseNodeId(row.from);
    const to = parseNodeId(row.to);
    if (from.repo !== to.repo) {
      throw new Error(`alias must stay within one repo: ${from.repo} -> ${to.repo}`);
    }
    if (from.kind !== to.kind) {
      throw new Error(`alias must map a node to the same kind: ${from.kind} -> ${to.kind}`);
    }
    if (!isValidEdge('ALIAS_OF', 'Alias', from.kind)) {
      throw new Error(
        `ALIAS_OF has no declared range for ${from.kind}; allowed: ${ALIAS_TARGET_KINDS.join(', ')}`,
      );
    }
    const existing = this.#rows.get(row.from);
    this.#rows.set(row.from, existing === undefined ? row : preferAlias(existing, row));
  }

  addAll(rows: Iterable<AliasRow>): void {
    for (const r of rows) this.add(r);
  }

  /** Rows sorted by retired id, so serialization is deterministic. */
  rows(): ReadonlyArray<AliasRow> {
    return [...this.#rows.values()].sort((a, b) => cmp(a.from, b.from));
  }

  /**
   * Follow the chain to the current id. Never loops: a repeat marks a cycle and
   * resolution stops, and the walk is capped at `MAX_ALIAS_CHAIN` regardless.
   */
  resolve(id: NodeId): AliasResolution {
    const chain: NodeId[] = [id];
    const seen = new Set<NodeId>([id]);
    let current = id;
    for (let hops = 0; hops < MAX_ALIAS_CHAIN; hops += 1) {
      const row = this.#rows.get(current);
      if (row === undefined) {
        return { id: current, hops, terminatedBy: 'terminal', chain };
      }
      if (seen.has(row.to)) {
        const start = chain.indexOf(row.to);
        const members = chain.slice(start === -1 ? 0 : start);
        const representative = [...members].sort(cmp)[0] ?? current;
        return { id: representative, hops: hops + 1, terminatedBy: 'cycle', chain };
      }
      seen.add(row.to);
      chain.push(row.to);
      current = row.to;
    }
    return { id: current, hops: MAX_ALIAS_CHAIN, terminatedBy: 'depth', chain };
  }

  /** `resolve`, discarding the diagnostics. */
  resolveId(id: NodeId): NodeId {
    return this.resolve(id).id;
  }
}

function provenanceFor(reason: AliasReason): Provenance {
  return reason === 'declared' ? 'DECLARED' : 'EXTRACTED';
}

export interface AliasMaterialization {
  readonly nodes: ReadonlyArray<SeamlineNode>;
  readonly edges: ReadonlyArray<SeamlineEdge>;
}

/**
 * Turn alias rows into the `Alias` nodes and `ALIAS_OF` edges the graph stores.
 * The edge always points at the *fully resolved* current id, so a two-step
 * rename still leaves the original name one hop from the truth.
 */
export function materializeAliases(table: AliasTable, runId: string): AliasMaterialization {
  const nodes: SeamlineNode[] = [];
  const edges: SeamlineEdge[] = [];
  for (const row of table.rows()) {
    const parsed = parseNodeId(row.from);
    const id = makeNodeId(parsed.repo, 'Alias', aliasName({ kind: parsed.kind, name: parsed.canonicalName }));
    const provenance = provenanceFor(row.reason);
    const target = table.resolveId(row.to);
    nodes.push({
      id,
      kind: 'Alias',
      name: parsed.canonicalName,
      sensitivity: 'internal',
      provenance,
      confidence: row.confidence,
      props: { retiredKind: parsed.kind, reason: row.reason, to: target },
      firstSeenRun: row.runId,
      lastSeenRun: runId,
      deletedAt: null,
    });
    edges.push({
      kind: 'ALIAS_OF',
      src: id,
      dst: target,
      provenance,
      confidence: row.confidence,
      props: { reason: row.reason },
      firstSeenRun: row.runId,
      lastSeenRun: runId,
      deletedAt: null,
    });
  }
  return { nodes, edges };
}

/** Rewrite both endpoints of an edge through the alias table. */
export function rewriteEdgeEndpoints(table: AliasTable, edge: SeamlineEdge): SeamlineEdge {
  const src = table.resolveId(edge.src);
  const dst = table.resolveId(edge.dst);
  if (src === edge.src && dst === edge.dst) return edge;
  return { ...edge, src, dst };
}

export function rewriteEdges(
  table: AliasTable,
  edges: ReadonlyArray<SeamlineEdge>,
): ReadonlyArray<SeamlineEdge> {
  return edges.map((e) => rewriteEdgeEndpoints(table, e));
}
