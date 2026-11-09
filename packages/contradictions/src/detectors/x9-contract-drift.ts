/**
 * X9 - contract drift, in both directions.
 *
 * - **Declared, unserved.** A contract operation with no route handler
 *   implementing it, on a contract whose sibling operations are implemented.
 *   The contract promises an endpoint the service does not serve.
 * - **Served, undeclared.** A route handler with no contract operation, in a
 *   file whose sibling handlers do map to operations. The service serves an
 *   endpoint the contract does not describe, which is how an undocumented
 *   surface reaches production.
 *
 * The sibling control carries the same weight it does in X4, and for the same
 * reason: a contract where nothing at all resolves means route matching did
 * not work here, and reporting every operation on it would be reporting the
 * inference's own failure as the developer's bug. `confidence = servedShare *
 * bestSiblingJoin`, so exactly that case falls under the confidence floor and
 * is dropped.
 */

import type { GraphView, SeamlineNode } from '@seamline/ontology';

import { defineDetector, type FindingDraft } from '../detector.ts';
import {
  childrenOf,
  cmp,
  factEdgesFrom,
  factEdgesTo,
  factNodes,
  isFactNode,
  parentOf,
  round6,
  whereFrom,
} from '../graph.ts';
import { isFact } from '@seamline/ontology';
import { SCOPE_CODE, SCOPE_CONTRACTS, SCOPE_JOIN } from '../scopes.ts';

interface Mapped {
  readonly node: SeamlineNode;
  readonly other: SeamlineNode;
  readonly confidence: number;
}

function structuredCoverageIssue(nodes: ReadonlyArray<SeamlineNode>): string | undefined {
  for (const node of nodes) {
    const count = node.props['unreadStructuredDocuments'];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
      return 'CONTRACT_COVERAGE_UNAVAILABLE: structured-document coverage was not measured or was withheld';
    if (count > 0)
      return `CONTRACT_DOCUMENTS_UNREAD: ${count} structured document(s) could hide operations; UNKNOWN rather than an absence finding`;
  }
  return undefined;
}

export const x9ContractDrift = defineDetector({
  code: 'X9_CONTRACT_DRIFT',
  severity: 'high',
  requiredScopes: [SCOPE_CONTRACTS, SCOPE_CODE, SCOPE_JOIN],
  absenceOfCode: true, // direction 1: "no route handler implements it"; the handler may be in an unread package
  description:
    'A declared operation that no route handler implements, or a route handler that no declared operation covers.',
  unknownWhen(g: GraphView): string | undefined {
    const contractIssue = structuredCoverageIssue(factNodes(g, 'Contract'));
    if (contractIssue !== undefined) return contractIssue;
    return structuredCoverageIssue(factNodes(g, 'Operation'));
  },
  find(g: GraphView): ReadonlyArray<FindingDraft> {
    const drafts: FindingDraft[] = [];

    // Direction 1: operations grouped by their contract.
    for (const contract of factNodes(g, 'Contract')) {
      const operations = childrenOf(g, contract.id, 'Operation');
      if (operations.length < 2) continue;

      const served: Mapped[] = [];
      const unserved: SeamlineNode[] = [];
      for (const op of operations) {
        let best: Mapped | undefined;
        for (const e of factEdgesFrom(g, op.id, 'IMPLEMENTED_BY')) {
          const handler = g.node(e.dst);
          if (!isFactNode(handler) || handler.kind !== 'RouteHandler') continue;
          const confidence = isFact(e.provenance) ? 1 : e.confidence;
          if (best === undefined || confidence > best.confidence) {
            best = { node: op, other: handler, confidence };
          }
        }
        if (best === undefined) unserved.push(op);
        else served.push(best);
      }
      if (served.length === 0 || unserved.length === 0) continue;

      const witness = [...served].sort(
        (a, b) => b.confidence - a.confidence || cmp(a.other.id, b.other.id),
      )[0];
      if (witness === undefined) continue;
      const confidence = round6((served.length / operations.length) * witness.confidence);

      for (const op of unserved) {
        drafts.push({
          left: op.id,
          right: witness.other.id,
          claim: `${contract.name} declares ${op.name} but no route handler implements it, while ${witness.node.name} on the same contract resolves to ${witness.other.name}`,
          leftFact: `${op.name} is declared on ${contract.name} (${whereFrom(op)})`,
          rightFact: `${witness.node.name} is implemented by ${witness.other.name} (${whereFrom(witness.other)}); ${served.length} of ${operations.length} operations resolve`,
          viaPath: ['IMPLEMENTED_BY'],
          confidence,
        });
      }
    }

    // Direction 2: route handlers grouped by the file that declares them.
    const byFile = new Map<string, SeamlineNode[]>();
    for (const handler of factNodes(g, 'RouteHandler')) {
      const file = fileOfHandler(g, handler);
      const key = file === undefined ? '' : String(file.id);
      const bucket = byFile.get(key);
      if (bucket === undefined) byFile.set(key, [handler]);
      else bucket.push(handler);
    }

    for (const key of [...byFile.keys()].sort(cmp)) {
      const handlers = byFile.get(key) ?? [];
      if (key === '' || handlers.length < 2) continue;

      const declared: Mapped[] = [];
      const undeclared: SeamlineNode[] = [];
      for (const handler of handlers) {
        let best: Mapped | undefined;
        for (const e of factEdgesTo(g, handler.id, 'IMPLEMENTED_BY')) {
          const op = g.node(e.src);
          if (!isFactNode(op) || op.kind !== 'Operation') continue;
          const confidence = isFact(e.provenance) ? 1 : e.confidence;
          if (best === undefined || confidence > best.confidence) {
            best = { node: handler, other: op, confidence };
          }
        }
        if (best === undefined) undeclared.push(handler);
        else declared.push(best);
      }
      if (declared.length === 0 || undeclared.length === 0) continue;

      const witness = [...declared].sort(
        (a, b) => b.confidence - a.confidence || cmp(a.other.id, b.other.id),
      )[0];
      if (witness === undefined) continue;
      const confidence = round6((declared.length / handlers.length) * witness.confidence);

      for (const handler of undeclared) {
        drafts.push({
          left: handler.id,
          right: witness.other.id,
          claim: `route ${handler.name} is served but no contract operation declares it, while ${witness.node.name} in the same file maps to ${witness.other.name}`,
          leftFact: `${handler.name} is served by code (${whereFrom(handler)})`,
          rightFact: `${witness.node.name} maps to declared operation ${witness.other.name} (${whereFrom(witness.other)}); ${declared.length} of ${handlers.length} routes in this file are declared`,
          viaPath: ['IMPLEMENTED_BY'],
          confidence,
        });
      }
    }

    return drafts;
  },
});

function fileOfHandler(g: GraphView, handler: SeamlineNode): SeamlineNode | undefined {
  for (const e of factEdgesTo(g, handler.id, 'HANDLES_ROUTE')) {
    const symbol = g.node(e.src);
    if (!isFactNode(symbol)) continue;
    const file = parentOf(g, symbol.id, 'File');
    if (file !== undefined) return file;
  }
  return undefined;
}
