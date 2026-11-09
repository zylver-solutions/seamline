/**
 * X1 compares a nullable column with an affirmatively non-nullable response.
 * Request validation may legitimately be stricter than storage. Generic code
 * shapes do not establish a stored-row or insert obligation, so their separate
 * optional/nullable axes cannot yet justify a database contradiction.
 */

import type { GraphView } from '@seamline/ontology';

import { defineDetector, type FindingDraft } from '../detector.ts';
import { factNodes, followAny, whereFrom } from '../graph.ts';
import { COLUMN_TO_FIELD, COLUMN_TO_PROPERTY } from '../joins.ts';
import {
  columnNullable,
  propertyDirection,
  propertyNullable,
} from '../props.ts';
import { SCOPE_CODE, SCOPE_CONTRACTS, SCOPE_DATA, SCOPE_JOIN } from '../scopes.ts';

export const x1Nullability = defineDetector({
  code: 'X1_NULLABILITY',
  severity: 'high',
  requiredScopes: [SCOPE_DATA, SCOPE_CONTRACTS, SCOPE_CODE, SCOPE_JOIN],
  description:
    'A nullable column and the response property joined to it disagree about whether the value can be null.',
  unknownWhen(g: GraphView): string | undefined {
    const observable = factNodes(g, 'Column').some((c) => columnNullable(c.props) !== undefined &&
      followAny(g, c.id, COLUMN_TO_PROPERTY, 'SchemaProperty').some((j) =>
        propertyDirection(j.node.props) === 'response' && propertyNullable(j.node.props) !== undefined,
      ));
    return observable ? undefined : 'VALUE_ROLE_UNOBSERVED: no joined response property states comparable nullability; generic code shapes and request properties do not prove a stored-row or insert obligation';
  },
  find(g: GraphView): ReadonlyArray<FindingDraft> {
    const drafts: FindingDraft[] = [];

    for (const column of factNodes(g, 'Column')) {
      const nullable = columnNullable(column.props);
      if (nullable === undefined) continue; // not extracted: not a fact, not a finding
      const leftFact = `${column.name} is ${nullable ? 'NULL-able' : 'NOT NULL'} (${whereFrom(column)})`;

      for (const j of followAny(g, column.id, COLUMN_TO_PROPERTY, 'SchemaProperty')) {
        const contractNullable = propertyNullable(j.node.props);
        const direction = propertyDirection(j.node.props);

        // Presence and null-ness are two axes, and `extract-contracts` emits
        // them separately for exactly that reason. A column that permits NULL
        // is only in tension with a property whose null-ness the contract
        // STATES as non-nullable. A property that omits `nullable` has not
        // stated it (an unrecognised Zod modifier may be hiding a `.nullable()`),
        // and `required` says the key is present, not that the value is not
        // null, so presence never stands in for it.
        if (nullable && contractNullable === false && direction === 'response') {
          drafts.push({
            left: column.id,
            right: j.node.id,
            claim: `the database permits NULL in ${column.name} but the contract declares ${j.node.name} non-nullable`,
            leftFact,
            rightFact: `${j.node.name} is declared non-nullable in the contract (${whereFrom(j.node)})`,
            viaPath: j.viaPath,
            confidence: j.confidence,
          });
        }
      }
    }

    return drafts;
  },
  notes(g: GraphView): ReadonlyArray<string> {
    const columns = factNodes(g, 'Column');
    const hasFields = columns.some((c) => followAny(g, c.id, COLUMN_TO_FIELD, 'CodeField').length > 0);
    const hasOtherContracts = columns.some((c) =>
      followAny(g, c.id, COLUMN_TO_PROPERTY, 'SchemaProperty').some((j) => propertyDirection(j.node.props) !== 'response'),
    );
    return [
      ...(hasFields ? ['CodeField nullability comparisons withheld: no shipped fact establishes a stored-row or insert role; optional and nullable are separate axes.'] : []),
      ...(hasOtherContracts ? ['Request and unknown-direction properties withheld: a stricter input contract or an optional request does not establish a storage contradiction or an insert obligation.'] : []),
    ];
  },
});
