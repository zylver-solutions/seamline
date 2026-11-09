/**
 * X2 - type disagreement.
 *
 * Compares `Column.type` and `SchemaProperty.type` across a
 * join. Every comparison runs through `classifyType`, which returns
 * `undefined` for anything it does not recognize - arrays, unions, generics,
 * `any`, and any SQL type outside its table. An unrecognized type produces no
 * finding, because a limitation of this package's type table must never be
 * reported to a developer as a disagreement in their code.
 *
 * Compatibility is deliberately generous. `integer` against `number` is not a
 * disagreement, and neither is `uuid` or `timestamptz` against `string` - all
 * of those are the normal, correct way the two layers represent the same
 * value. A string/JSON pair is withheld because serialization is unobserved,
 * without declaring the pair compatible. Other classified incompatible pairs fire.
 */

import type { GraphView } from '@seamline/ontology';

import { defineDetector, type FindingDraft } from '../detector.ts';
import { factNodes, followAny, whereFrom } from '../graph.ts';
import { COLUMN_TO_FIELD, COLUMN_TO_PROPERTY, FIELD_TO_PROPERTY } from '../joins.ts';
import { classifyContractType, classifyType, strProp, typesCompatible, type TypeClass } from '../props.ts';
import { SCOPE_CODE, SCOPE_CONTRACTS, SCOPE_DATA, SCOPE_JOIN } from '../scopes.ts';

function representationUnobserved(a: TypeClass, b: TypeClass): boolean {
  return (a === 'string' && b === 'json') || (a === 'json' && b === 'string');
}

export const x2Type = defineDetector({
  code: 'X2_TYPE',
  severity: 'high',
  requiredScopes: [SCOPE_DATA, SCOPE_CONTRACTS, SCOPE_CODE, SCOPE_JOIN],
  description:
    'A column and the contract property exposing it declare types that cannot represent each other.',
  unknownWhen(g: GraphView): string | undefined {
    let unobserved = false;
    for (const column of factNodes(g, 'Column')) {
      const columnClass = classifyType(strProp(column.props, 'type'));
      if (columnClass === undefined) continue;
      for (const j of followAny(g, column.id, COLUMN_TO_PROPERTY, 'SchemaProperty')) {
        const otherClass = classifyContractType(j.node.props);
        if (otherClass === undefined) continue;
        if (representationUnobserved(columnClass, otherClass)) unobserved = true;
        else return undefined;
      }
    }
    return unobserved
      ? 'REPRESENTATION_UNOBSERVED: joined string and JSON declarations do not establish whether serialization mediates between them'
      : 'VALUE_ROLE_UNOBSERVED: no joined column and contract property state comparable types; generic code shapes do not prove a stored-row or insert role';
  },
  find(g: GraphView): ReadonlyArray<FindingDraft> {
    const drafts: FindingDraft[] = [];

    for (const column of factNodes(g, 'Column')) {
      const raw = strProp(column.props, 'type');
      const columnClass = classifyType(raw);
      if (columnClass === undefined) continue;
      const leftFact = `${column.name} is ${raw} (${whereFrom(column)})`;

      for (const j of followAny(g, column.id, COLUMN_TO_PROPERTY, 'SchemaProperty')) {
        const otherRaw = strProp(j.node.props, 'type');
        const otherClass = classifyContractType(j.node.props);
        if (otherClass === undefined || representationUnobserved(columnClass, otherClass) || typesCompatible(columnClass, otherClass)) continue;
        drafts.push({
          left: column.id,
          right: j.node.id,
          claim: `${column.name} stores ${columnClass} but the contract declares ${j.node.name} as ${otherClass}`,
          leftFact,
          rightFact: `${j.node.name} is ${otherRaw ?? otherClass} (${whereFrom(j.node)})`,
          viaPath: j.viaPath,
          confidence: j.confidence,
        });
      }
    }

    return drafts;
  },
  notes(g: GraphView): ReadonlyArray<string> {
    const hasColumnFields = factNodes(g, 'Column').some((c) => followAny(g, c.id, COLUMN_TO_FIELD, 'CodeField').length > 0);
    const hasFieldProperties = factNodes(g, 'CodeField').some((f) => followAny(g, f.id, FIELD_TO_PROPERTY, 'SchemaProperty').length > 0);
    const notes: string[] = [];
    if (hasColumnFields || hasFieldProperties)
      notes.push('CodeField type comparisons withheld: no shipped fact establishes that a generic code shape represents a stored row or insert value.');
    const unobserved = factNodes(g, 'Column').some((column) => {
      const columnClass = classifyType(strProp(column.props, 'type'));
      return columnClass !== undefined && followAny(g, column.id, COLUMN_TO_PROPERTY, 'SchemaProperty').some((j) => {
        const otherClass = classifyContractType(j.node.props);
        return otherClass !== undefined && representationUnobserved(columnClass, otherClass);
      });
    });
    if (unobserved)
      notes.push('String/JSON comparisons withheld: declarations do not establish whether serialization mediates between storage and contract representations.');
    return notes;
  },
});
