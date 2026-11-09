/**
 * The tool registry.
 *
 * v3 §2.6: **parameterized tools only, no raw query tool.** Five tools, each
 * with a declared parameter schema that is both advertised and enforced. There
 * is no escape hatch here: no `query`, no `cypher`, no `sql`. A tool's optional
 * parameters (`tokenBudget` on `context` and `impact`, `targets` on `impact`)
 * are declared in the same schema and bounded the same way.
 */

import type { NarrowedClaim, RecordField } from '@seamline/core';
import type { EdgeKind, GraphView, NodeKind, RunRecord } from '@seamline/ontology';
import type { RenderContext } from '../graph.ts';
import type { Bounds, DetectionReport } from '../ports.ts';
import type { ToolEnvelope } from '../result.ts';
import type { ParamSchema } from '../validate.ts';

/**
 * What the export profile releases, by kind. `view` already hides everything
 * else; this lets a tool tell "the profile withholds it" from "it is absent",
 * which are different answers when the question is about absence.
 */
export interface Released {
  nodeKind(kind: NodeKind): boolean;
  edgeKind(kind: EdgeKind): boolean;
  /**
   * Whether the profile names this record field in `allowFields`. The graph view
   * keeps the fields the traversal needs, so a tool that prints one of the
   * lifecycle fields (run ids carry extraction wall-clock time) asks first.
   */
  field(name: RecordField): boolean;
}

export interface ToolContext {
  readonly view: GraphView;
  readonly run: RunRecord | undefined;
  /**
   * Scopes that PASSed on a claim narrower than the whole scope. Worked out
   * from the run's diagnostics before they are dropped, and carrying only the
   * scope, the extractor and the count the extractor reported.
   */
  readonly narrowed: readonly NarrowedClaim[];
  readonly bounds: Bounds;
  readonly render: RenderContext;
  readonly released: Released;
  /** `undefined` when no detector is wired; tools must say so rather than return `[]`. */
  readonly detect: (() => Promise<DetectionReport>) | undefined;
}

export interface ToolDefinition<P = Record<string, unknown>> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schema: ParamSchema;
  /** Read-only: no tool in this server mutates the graph. */
  readonly readOnly: true;
  run(params: P, ctx: ToolContext): Promise<ToolEnvelope> | ToolEnvelope;
}
