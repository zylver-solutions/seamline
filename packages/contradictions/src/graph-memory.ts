/**
 * A minimal in-memory `GraphView` used to build detector fixtures.
 *
 * This is not the store: no persistence, no run history, no tombstone
 * lifecycle beyond honouring `deletedAt`. It borrows `@seamline/core`'s
 * node/edge indexing (`memoryGraphIndex`) so the three packages that each grew
 * one of these have exactly one implementation to keep correct; the
 * fixture-authoring surface here (nodes and edges addressed by name, not id)
 * stays package-specific, since a detector fixture should read as a literal
 * description of a handful of facts rather than a database.
 */

import {
  nodeId,
  type EdgeKind,
  type ExtractorStatus,
  type GraphView,
  type NodeId,
  type NodeKind,
  type Provenance,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import { memoryGraphIndex, type MemoryGraphIndex } from '@seamline/core';

import type { PropValue } from './props.ts';
import { SCOPES } from './scopes.ts';

export interface NodeSpec {
  readonly kind: NodeKind;
  /** Display name, as an extractor would emit it (`email`, not `users.email`). */
  readonly name: string;
  /**
   * Canonical key (path-free, except for a `File`, whose key is its path),
   * defaulting to `name`. This is the node id's
   * canonical part and the handle edges refer to, so two columns can both be
   * called `email` as long as their canonical keys differ.
   */
  readonly canonical?: string;
  readonly path?: string;
  readonly sourceRef?: string;
  readonly provenance?: Provenance;
  readonly confidence?: number;
  readonly untrusted?: boolean;
  readonly deletedAt?: string | null;
  readonly props?: Readonly<Record<string, PropValue>>;
}

export interface EdgeSpec {
  readonly kind: EdgeKind;
  /** A node's canonical key (or its name, when no canonical key was given). */
  readonly src: string;
  readonly dst: string;
  readonly provenance?: Provenance;
  readonly confidence?: number;
  readonly sourceRef?: string;
  readonly deletedAt?: string | null;
  readonly props?: Readonly<Record<string, PropValue>>;
}

export interface GraphSpec {
  readonly repo?: string;
  readonly scopes?: Readonly<Record<string, ExtractorStatus>>;
  readonly nodes: ReadonlyArray<NodeSpec>;
  readonly edges?: ReadonlyArray<EdgeSpec>;
}

const RUN = 'run-fixture';

export class MemoryGraph implements GraphView {
  readonly #index: MemoryGraphIndex = memoryGraphIndex();
  readonly #scopes: Map<string, ExtractorStatus>;

  constructor(spec: GraphSpec) {
    const repo = spec.repo ?? 'repo';
    this.#scopes = new Map(SCOPES.map((s) => [s, 'PASS' as ExtractorStatus]));
    for (const [scope, status] of Object.entries(spec.scopes ?? {})) this.#scopes.set(scope, status);

    const byName = new Map<string, NodeId>();
    for (const n of spec.nodes) {
      const key = n.canonical ?? n.name;
      if (byName.has(key)) throw new Error(`fixture declares two nodes with key: ${key}`);
      const id = nodeId(repo, n.kind, key);
      const node: SeamlineNode = {
        id,
        kind: n.kind,
        name: n.name,
        ...(n.path === undefined ? {} : { path: n.path }),
        sensitivity: 'internal',
        provenance: n.provenance ?? 'EXTRACTED',
        confidence: n.confidence ?? 1,
        ...(n.sourceRef === undefined ? {} : { sourceRef: n.sourceRef }),
        ...(n.untrusted === undefined ? {} : { untrusted: n.untrusted }),
        props: n.props ?? {},
        firstSeenRun: RUN,
        lastSeenRun: RUN,
        deletedAt: n.deletedAt ?? null,
      };
      this.#index.addNode(node);
      byName.set(key, id);
    }

    for (const e of spec.edges ?? []) {
      const src = byName.get(e.src);
      const dst = byName.get(e.dst);
      if (src === undefined) throw new Error(`fixture edge references unknown node: ${e.src}`);
      if (dst === undefined) throw new Error(`fixture edge references unknown node: ${e.dst}`);
      const edge: SeamlineEdge = {
        kind: e.kind,
        src,
        dst,
        provenance: e.provenance ?? 'EXTRACTED',
        confidence: e.confidence ?? 1,
        ...(e.sourceRef === undefined ? {} : { sourceRef: e.sourceRef }),
        props: e.props ?? {},
        firstSeenRun: RUN,
        lastSeenRun: RUN,
        deletedAt: e.deletedAt ?? null,
      };
      this.#index.addEdge(edge);
    }
  }

  nodesByKind(kind: NodeKind): ReadonlyArray<SeamlineNode> {
    return this.#index.nodesByKind(kind);
  }

  node(id: NodeId): SeamlineNode | undefined {
    return this.#index.node(id);
  }

  edgesFrom(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
    return this.#index.edgesFrom(id, kind);
  }

  edgesTo(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
    return this.#index.edgesTo(id, kind);
  }

  scopeStatus(scope: string): ExtractorStatus {
    return this.#scopes.get(scope) ?? 'UNAVAILABLE';
  }
}

export function graph(spec: GraphSpec): MemoryGraph {
  return new MemoryGraph(spec);
}
