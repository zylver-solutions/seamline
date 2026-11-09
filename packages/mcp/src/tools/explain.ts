/**
 * `explain(id)` — why does the graph believe this?
 *
 * Provenance, confidence, and source reference for one node and every edge
 * incident to it, plus the contradictions citing it. This is the tool that
 * lets an agent decide how much weight to give a fact: an `INFERRED` edge at
 * confidence 0.4 is a hypothesis, and the agent should be able to tell.
 */

import type { NodeId } from '@seamline/ontology';
import { capList, fitToByteBudget, mergeTruncation, NOT_TRUNCATED } from '../bounds.ts';
import { containerOf, neighbours, summarizeEdge, summarizeNode, CONTEXT_EDGE_KINDS, LINEAGE_EDGE_KINDS } from '../graph.ts';
import type { UnknownDetection } from '../ports.ts';
import { envelope, unknownScopes } from '../result.ts';
import type { ToolDefinition } from './registry.ts';

interface Params {
  readonly id: string;
}

const ALL_EDGE_KINDS = [...new Set([...CONTEXT_EDGE_KINDS, ...LINEAGE_EDGE_KINDS])];

export const explainTool: ToolDefinition<Params> = {
  name: 'explain',
  title: 'Explain a fact',
  description:
    'Return the provenance, confidence, source reference, and run lifecycle of one node, plus every edge incident to it ' +
    'with its own provenance and confidence, plus any contradiction citing it. Use this to decide how much to trust a ' +
    'fact before acting on it: EXTRACTED is observed, INFERRED is a guess with a confidence attached.',
  schema: {
    id: {
      kind: 'string',
      required: true,
      description: 'A NodeId: repo:Kind:canonicalName.',
      maxLength: 512,
      pattern: '^[^:]+:[A-Za-z]+:.+$',
    },
  },
  readOnly: true,
  async run(params, ctx) {
    const unknown = unknownScopes(ctx.view, ctx.run);
    const node = ctx.view.node(params.id as NodeId);

    if (node === undefined) {
      return envelope(
        'explain',
        { found: false },
        {
          state: NOT_TRUNCATED,
          unknown,
          emptyResult: true,
          notices: [`No node with id \`${params.id}\`. Use \`context\` to resolve a name to a NodeId.`],
        },
      );
    }

    const incident = neighbours(ctx.view, node.id, ALL_EDGE_KINDS, 'both');
    const capped = capList(incident, ctx.bounds.maxResults);
    const container = containerOf(ctx.view, node.id);

    let citing: readonly unknown[] = [];
    let detectionAvailable = false;
    let unknownDetectors: readonly UnknownDetection[] = [];
    if (ctx.detect !== undefined) {
      detectionAvailable = true;
      const report = await ctx.detect();
      // A detector can be UNKNOWN with every scope PASS (its own `unknownWhen`), so the envelope's
      // `unknown` scopes cannot carry it: an empty `contradictions` here would read as a verified negative.
      unknownDetectors = report.unknown;
      citing = report.contradictions
        .filter((c) => c.left === node.id || c.right === node.id)
        .map((c) => ({
          code: c.code,
          severity: c.severity,
          claim: c.claim,
          left: c.left,
          leftFact: c.leftFact,
          right: c.right,
          rightFact: c.rightFact,
          confidence: c.confidence,
        }));
    }

    const build = (kept: typeof incident): unknown => ({
      found: true,
      node: summarizeNode(node, ctx.render),
      container: container === undefined ? null : summarizeNode(container, ctx.render),
      lifecycle: {
        // Whether the node still exists is the substance of the answer; the
        // run ids and the deletion time are released only when the profile
        // names them (they carry extraction wall-clock time).
        ...(ctx.released.field('firstSeenRun') ? { firstSeenRun: node.firstSeenRun } : {}),
        ...(ctx.released.field('lastSeenRun') ? { lastSeenRun: node.lastSeenRun } : {}),
        ...(ctx.released.field('deletedAt') ? { deletedAt: node.deletedAt } : {}),
        tombstoned: node.deletedAt !== null,
      },
      sourceRef: node.sourceRef ?? null,
      incidentEdges: kept.map((n) => ({
        direction: n.direction,
        other: n.node.id,
        otherKind: n.node.kind,
        ...summarizeEdge(n.edge),
      })),
      contradictions: citing,
      detectionAvailable,
      unknownDetectors: unknownDetectors.map((u) => ({
        code: u.code,
        severity: u.severity,
        reason: u.reason,
        scopes: u.scopes,
        scopeStatus: u.scopeStatus,
      })),
    });

    const fitted = fitToByteBudget(capped.items, build, ctx.bounds.maxBytes, mergeTruncation(NOT_TRUNCATED, capped.state));

    const notices: string[] = [];
    if (!detectionAvailable) {
      notices.push('No contradiction detector is wired; `contradictions` here is empty because nothing ran, not because nothing was found.');
    }
    if (unknownDetectors.length > 0) {
      notices.push(
        `${unknownDetectors.length} detector(s) could not run: ${unknownDetectors.map((u) => u.code).join(', ')}. ` +
          'Those checks are UNKNOWN, not clean.',
      );
    }
    if (node.deletedAt !== null) {
      const when = ctx.released.field('deletedAt') ? ` (deletedAt=${node.deletedAt})` : '';
      notices.push(`This node is tombstoned${when}; it no longer exists in the authoritative scope.`);
    }
    if (ctx.render.escapeAttempts > 0) {
      notices.push(
        `${ctx.render.escapeAttempts} untrusted string(s) on this node contained delimiter-escape sequences; they were neutralized.`,
      );
    }

    return envelope('explain', fitted.body, { state: fitted.state, unknown, notices });
  },
};
