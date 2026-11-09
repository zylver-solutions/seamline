/**
 * Deterministic node/edge accumulation.
 *
 * Two properties are enforced here rather than trusted at each call site:
 *
 *  1. **Every edge is checked against `isValidEdge`** using the kinds of the
 *     endpoints actually present in this run. An edge whose endpoint node was
 *     never emitted is a dangling edge, which is just as wrong as a
 *     domain/range violation, so both are rejected the same way.
 *  2. **Output is sorted, not insertion-ordered.** Filesystem traversal order
 *     is not stable across machines; design v3 §2.3 makes byte-identical output
 *     a CI gate. Sorting happens once, in `finish()`.
 */

import { edgeKey, isValidEdge, parseNodeId, DEFAULT_SENSITIVITY } from '@seamline/ontology';
import type {
  EdgeKind, NodeId, NodeKind, Provenance, SeamlineEdge, SeamlineNode, Sensitivity,
} from '@seamline/ontology';

export type PropValue = string | number | boolean | null;
export type Props = Record<string, PropValue>;

/** Sort object keys so the serialized form is stable regardless of insertion order. */
export function sortProps(props: Props): Readonly<Props> {
  const out: Props = {};
  for (const key of Object.keys(props).sort()) {
    const v = props[key];
    if (v === undefined) continue;
    out[key] = v;
  }
  return Object.freeze(out);
}

export interface NodeInput {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly name: string;
  readonly path?: string | undefined;
  readonly sourceRef?: string | undefined;
  readonly confidence?: number | undefined;
  readonly sensitivity?: Sensitivity | undefined;
  readonly untrusted?: boolean | undefined;
  readonly props?: Props | undefined;
}

export interface EdgeInput {
  readonly kind: EdgeKind;
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly srcFile?: string | undefined;
  readonly dstFile?: string | undefined;
  readonly confidence?: number | undefined;
  readonly sourceRef?: string | undefined;
  readonly props?: Props | undefined;
}

export interface CollectorOptions {
  readonly runId: string;
  readonly scope: string;
  readonly provenance: Provenance;
}

/**
 * Collected output. `rejectedEdges` is surfaced in diagnostics rather than
 * thrown: a dangling `CALLS` into a `.d.ts` we did not emit is expected and
 * routine, and stopping the run over it would be worse than reporting it.
 */
export interface Collected {
  readonly nodes: readonly SeamlineNode[];
  readonly edges: readonly SeamlineEdge[];
  readonly rejectedEdges: readonly string[];
}

export class Collector {
  readonly #nodes = new Map<NodeId, SeamlineNode>();
  readonly #edges = new Map<string, SeamlineEdge>();
  readonly #pending: EdgeInput[] = [];
  readonly #rejected = new Set<string>();
  readonly #external = new Map<NodeId, NodeKind>();
  readonly #opts: CollectorOptions;

  constructor(opts: CollectorOptions) {
    this.#opts = opts;
  }

  has(id: NodeId): boolean {
    return this.#nodes.has(id);
  }

  kindOf(id: NodeId): NodeKind | undefined {
    return this.#nodes.get(id)?.kind ?? this.#external.get(id);
  }

  /**
   * Register the kind of a node this extractor is NOT authoritative for, so an
   * edge that crosses a scope boundary can still be signature-checked.
   *
   * `QUERIES` points at a `Table`, which `extract-data` owns. Emitting a `Table`
   * node here would make two extractors authoritative for the same kind and put
   * them in a tombstoning fight after every run. Declaring the kind without
   * emitting the node keeps `isValidEdge` enforced and authority undivided.
   */
  external(id: NodeId, kind: NodeKind): NodeId {
    this.#external.set(id, kind);
    return id;
  }

  /**
   * Add a node. A repeated id merges rather than replaces: TypeScript
   * declaration merging (an `interface` reopened in two places) is one symbol,
   * and the merged node keeps the lexicographically smallest path so the result
   * does not depend on traversal order.
   */
  node(input: NodeInput): NodeId {
    const existing = this.#nodes.get(input.id);
    const props = sortProps(input.props ?? {});
    if (existing !== undefined) {
      const mergedPath = pickSmaller(existing.path, input.path);
      const mergedRef = pickSmaller(existing.sourceRef, input.sourceRef);
      const mergedProps = sortProps({ ...existing.props, ...props } as Props);
      this.#nodes.set(input.id, {
        ...existing,
        ...(mergedPath === undefined ? {} : { path: mergedPath }),
        ...(mergedRef === undefined ? {} : { sourceRef: mergedRef }),
        props: mergedProps,
      });
      return input.id;
    }
    const node: SeamlineNode = {
      id: input.id,
      kind: input.kind,
      name: input.name,
      ...(input.path === undefined ? {} : { path: input.path }),
      sensitivity: input.sensitivity ?? DEFAULT_SENSITIVITY[input.kind],
      provenance: this.#opts.provenance,
      confidence: input.confidence ?? 1,
      ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
      ...(input.untrusted === undefined ? {} : { untrusted: input.untrusted }),
      props,
      firstSeenRun: this.#opts.runId,
      lastSeenRun: this.#opts.runId,
      deletedAt: null,
    };
    this.#nodes.set(input.id, node);
    return input.id;
  }

  /**
   * Queue an edge. Validation is deferred to `finish()` because an edge is
   * routinely discovered before its destination node has been emitted (a call
   * to a symbol in a file not yet walked).
   *
   * Edge identity is `(scope, src, dst, kind)`, so edges queued for the same
   * key are merged in `finish()` in queue order: `confidence` takes the maximum,
   * `props` are shallow-merged with the later edge winning a conflicting key, and
   * `srcFile`, `dstFile`, and `sourceRef` keep the first edge's. A caller that
   * can queue several edges for one key with differing values (several import
   * declarations reaching one file) must fold them with an order-independent
   * rule first, as `imports.ts` does, or the result depends on queue order.
   */
  edge(input: EdgeInput): void {
    this.#pending.push(input);
  }

  finish(): Collected {
    for (const e of this.#pending) {
      const srcKind = this.kindOf(e.src);
      const dstKind = this.kindOf(e.dst);
      if (srcKind === undefined || dstKind === undefined) {
        this.#rejected.add(
          `dangling ${e.kind}: ${srcKind === undefined ? `src ${e.src}` : `dst ${e.dst}`} was not emitted`,
        );
        continue;
      }
      if (!isValidEdge(e.kind, srcKind, dstKind)) {
        this.#rejected.add(`invalid ${e.kind}: ${srcKind} -> ${dstKind}`);
        continue;
      }
      const key = edgeKey(this.#opts.scope, e);
      const existing = this.#edges.get(key);
      const props = sortProps(e.props ?? {});
      if (existing !== undefined) {
        this.#edges.set(key, {
          ...existing,
          confidence: Math.max(existing.confidence, e.confidence ?? 1),
          props: sortProps({ ...existing.props, ...props } as Props),
        });
        continue;
      }
      this.#edges.set(key, {
        kind: e.kind,
        src: e.src,
        dst: e.dst,
        ...(e.srcFile === undefined ? {} : { srcFile: e.srcFile }),
        ...(e.dstFile === undefined ? {} : { dstFile: e.dstFile }),
        provenance: this.#opts.provenance,
        confidence: e.confidence ?? 1,
        ...(e.sourceRef === undefined ? {} : { sourceRef: e.sourceRef }),
        props,
        firstSeenRun: this.#opts.runId,
        lastSeenRun: this.#opts.runId,
        deletedAt: null,
      });
    }
    this.#pending.length = 0;

    const nodes = [...this.#nodes.values()].sort(compareNodes);
    const edges = [...this.#edges.values()].sort(compareEdges);
    return { nodes, edges, rejectedEdges: [...this.#rejected].sort() };
  }
}

function pickSmaller(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a <= b ? a : b;
}

/** Sort by kind (declaration order in the ontology is irrelevant; lexical is stable), then id. */
export function compareNodes(a: SeamlineNode, b: SeamlineNode): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function compareEdges(a: SeamlineEdge, b: SeamlineEdge): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.src !== b.src) return a.src < b.src ? -1 : 1;
  if (a.dst !== b.dst) return a.dst < b.dst ? -1 : 1;
  return 0;
}

/** Kind of a node id without a lookup — used by tests asserting edge signatures. */
export function kindFromId(id: NodeId): NodeKind {
  return parseNodeId(id).kind;
}
