/**
 * X4 - unbacked response property.
 *
 * A response property the contract promises, that nothing in the codebase or
 * the schema produces. On its face this is an absence, which is what v2's gaps
 * were and what this package refuses to report. It becomes a contradiction
 * through the **sibling control**:
 *
 * > The join is demonstrably working for this contract, because other response
 * > properties on it *are* backed by real columns or fields. Against that, this
 * > property having no producer is a disagreement between two authoritative
 * > scopes, not a missing extractor.
 *
 * The control is also the confidence. `confidence = backedShare * bestSiblingJoin`,
 * where `backedShare` is the fraction of the contract's response properties
 * that do resolve to a producer. A contract where nine of ten properties
 * resolve yields roughly 0.9 and reports; one where one of ten resolves yields
 * roughly 0.1 and is suppressed by the confidence floor, because at that point
 * the honest reading is that inference failed on this contract, not that the
 * API returns nine invented fields.
 */

import type { GraphView, NodeId, SeamlineNode } from '@seamline/ontology';

import { defineDetector, type FindingDraft } from '../detector.ts';
import { childrenOf, cmp, factNodes, followAny, round6, whereFrom, type Joined } from '../graph.ts';
import { into, out } from '../graph.ts';
import { propertyDirection, propertyRequired } from '../props.ts';
import { SCOPE_CODE, SCOPE_CONTRACTS, SCOPE_DATA, SCOPE_JOIN } from '../scopes.ts';

/** Anything that can produce a value for a response property. */
const PRODUCER_ROUTES = [[out('BACKED_BY')], [into('EXPOSED_AS')]];

function bestProducer(g: GraphView, property: SeamlineNode): Joined | undefined {
  let best: Joined | undefined;
  for (const j of followAny(g, property.id, PRODUCER_ROUTES)) {
    if (j.node.kind !== 'Column' && j.node.kind !== 'CodeField') continue;
    if (best === undefined || j.confidence > best.confidence) best = j;
  }
  return best;
}

export const x4UnbackedProperty = defineDetector({
  code: 'X4_UNBACKED_PROPERTY',
  severity: 'medium',
  requiredScopes: [SCOPE_CONTRACTS, SCOPE_DATA, SCOPE_CODE, SCOPE_JOIN],
  absenceOfCode: true, // `bestProducer` finds nothing: the producer may be in a package code.ts did not read
  description:
    'A contract promises a response property that no column or computed field produces, on a contract whose other properties do resolve.',
  find(g: GraphView): ReadonlyArray<FindingDraft> {
    const drafts: FindingDraft[] = [];

    for (const contract of factNodes(g, 'Contract')) {
      const responses = childrenOf(g, contract.id, 'SchemaProperty').filter(
        (p) => propertyDirection(p.props) === 'response',
      );
      if (responses.length < 2) continue; // a single property gives the control nothing to stand on

      const backed: Array<{ property: SeamlineNode; producer: Joined }> = [];
      const unbacked: SeamlineNode[] = [];
      for (const p of responses) {
        const producer = bestProducer(g, p);
        if (producer === undefined) unbacked.push(p);
        else backed.push({ property: p, producer });
      }
      if (backed.length === 0 || unbacked.length === 0) continue;

      const witness = [...backed].sort(
        (a, b) => b.producer.confidence - a.producer.confidence || cmp(a.producer.node.id, b.producer.node.id),
      )[0];
      if (witness === undefined) continue;

      const backedShare = backed.length / responses.length;
      const confidence = round6(backedShare * witness.producer.confidence);
      const right: NodeId = witness.producer.node.id;

      for (const p of unbacked) {
        const required = propertyRequired(p.props);
        drafts.push({
          left: p.id,
          right,
          claim: `${contract.name} returns ${p.name} but nothing produces it, while ${witness.property.name} on the same response resolves to ${witness.producer.node.name}`,
          leftFact: `${p.name} is declared${required === true ? ' required' : ''} on the ${contract.name} response (${whereFrom(p)})`,
          rightFact: `${witness.property.name} resolves to ${witness.producer.node.kind} ${witness.producer.node.name} (${whereFrom(witness.producer.node)}); ${backed.length} of ${responses.length} response properties resolve`,
          viaPath: witness.producer.viaPath,
          confidence,
        });
      }
    }

    return drafts;
  },
});
