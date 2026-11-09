/**
 * X3 - width / constraint disagreement.
 *
 * Compares a column's own constraints against the validator joined to it, on
 * the dimensions **both sides state**: a `varchar(50)` column behind a
 * validator that accepts 255 characters, a `CHECK (status IN (...))` against a
 * different enum in the validator, a numeric range that does not match.
 *
 * Only dimensions present on both sides are compared here. A dimension one
 * side states and the other does not is X7's subject, so the two detectors
 * partition the space rather than double-reporting the same pair.
 */

import type { GraphView } from '@seamline/ontology';

import { defineDetector, type FindingDraft } from '../detector.ts';
import { factNodes, followAny, whereFrom } from '../graph.ts';
import { COLUMN_TO_VALIDATOR } from '../joins.ts';
import { CONSTRAINT_DIMENSIONS, columnConstraints, validatorConstraints } from '../props.ts';
import { SCOPE_CODE, SCOPE_DATA, SCOPE_JOIN } from '../scopes.ts';

function render(dimension: string, value: string | number | boolean): string {
  return `${dimension}=${String(value)}`;
}

export const x3Constraint = defineDetector({
  code: 'X3_CONSTRAINT',
  severity: 'medium',
  requiredScopes: [SCOPE_DATA, SCOPE_CODE, SCOPE_JOIN],
  description:
    'A column and the validator guarding it both state a constraint on the same dimension, with different values.',
  find(g: GraphView): ReadonlyArray<FindingDraft> {
    const drafts: FindingDraft[] = [];

    for (const column of factNodes(g, 'Column')) {
      const dbConstraints = columnConstraints(column.props);
      if (dbConstraints.size === 0) continue;

      for (const j of followAny(g, column.id, COLUMN_TO_VALIDATOR, 'Symbol')) {
        const codeConstraints = validatorConstraints(j.node.props);
        if (codeConstraints.size === 0) continue;

        for (const d of CONSTRAINT_DIMENSIONS) {
          const dbValue = dbConstraints.get(d);
          const codeValue = codeConstraints.get(d);
          if (dbValue === undefined || codeValue === undefined) continue;
          if (dbValue === codeValue) continue;
          drafts.push({
            left: column.id,
            right: j.node.id,
            claim: `${column.name} and validator ${j.node.name} disagree on ${d}: database ${String(dbValue)}, validator ${String(codeValue)}`,
            leftFact: `${column.name} declares ${render(d, dbValue)} (${whereFrom(column)})`,
            rightFact: `${j.node.name} enforces ${render(d, codeValue)} (${whereFrom(j.node)})`,
            viaPath: j.viaPath,
            confidence: j.confidence,
          });
        }
      }
    }

    return drafts;
  },
});
