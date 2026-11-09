/** X7: a proved validated write input permits lengths beyond declared storage. */
import { isFact, type GraphView, type NodeKind, type SeamlineNode } from '@seamline/ontology';
import { defineDetector, type FindingDraft } from '../detector.ts';
import { factEdgesTo, factNodes, followAny, isFactNode, whereFrom, type Joined } from '../graph.ts';
import { COLUMN_TO_PROPERTY } from '../joins.ts';
import { currentlyObserved } from '../observation.ts';
import { SCOPE_CODE, SCOPE_CONTRACTS, SCOPE_DATA, SCOPE_JOIN } from '../scopes.ts';

const REQUIRED = [SCOPE_DATA, SCOPE_CONTRACTS, SCOPE_CODE, SCOPE_JOIN] as const;

interface LengthPair {
  readonly column: SeamlineNode;
  readonly property: SeamlineNode;
  readonly joined: Joined;
  readonly maximum: number;
}

function finiteLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function uniqueParent(g: GraphView, node: SeamlineNode, kind: NodeKind): SeamlineNode | undefined {
  const parents = new Map<string, SeamlineNode>();
  for (const edge of factEdgesTo(g, node.id, 'CONTAINS')) {
    if (!isFact(edge.provenance)) continue;
    const parent = g.node(edge.src);
    if (isFactNode(parent) && parent.kind === kind) parents.set(parent.id, parent);
  }
  return parents.size === 1 ? [...parents.values()][0] : undefined;
}

function currentScopes(g: GraphView): boolean {
  return REQUIRED.every(scope => currentlyObserved(g, scope));
}

function observablePairs(g: GraphView): readonly LengthPair[] {
  if (!currentScopes(g)) return [];
  const pairs: LengthPair[] = [];
  for (const column of factNodes(g, 'Column')) {
    const maximum = column.props['maxLength'];
    if (!finiteLength(maximum) || column.props['isArray'] !== false || column.props['typeCategory'] !== 'text' ||
        !currentlyObserved(g, SCOPE_DATA, column)) continue;
    const table = uniqueParent(g, column, 'Table');
    if (table === undefined || !currentlyObserved(g, SCOPE_DATA, table)) continue;
    for (const joined of followAny(g, column.id, COLUMN_TO_PROPERTY, 'SchemaProperty')) {
      const property = joined.node;
      const props = property.props;
      if (props['direction'] !== 'request' || props['valueRole'] !== 'validated-write-input' || props['writeBindingComplete'] !== true ||
          props['successfulParse'] !== true || props['unchangedForwarding'] !== true || props['modelBindingComplete'] !== true ||
          props['isArray'] !== false || props['typeCategory'] !== 'text' || props['storageTable'] !== table.id ||
          props['storageField'] !== column.name || typeof props['storageModel'] !== 'string' || props['storageModel'].length === 0 ||
          props['storageModel'] !== table.props['ormModel'] || !currentlyObserved(g, SCOPE_CONTRACTS, property)) continue;
      const contract = uniqueParent(g, property, 'Contract');
      if (contract === undefined || contract.name !== props['contract'] || !currentlyObserved(g, SCOPE_CONTRACTS, contract)) continue;
      if ([column, table, contract].some(node => node.lastSeenRun !== property.lastSeenRun) ||
          joined.hops.some(hop => hop.edge.lastSeenRun !== property.lastSeenRun)) continue;
      const state = props['lengthUpperState'];
      if (state === 'bounded' ? !finiteLength(props['maxLength']) :
          state !== 'unbounded' || props['maxLength'] !== undefined) continue;
      pairs.push({ column, property, joined, maximum });
    }
  }
  return pairs;
}

export const x7ValidatorDivergence = defineDetector({
  code: 'X7_VALIDATOR_DIVERGENCE',
  severity: 'high',
  requiredScopes: REQUIRED,
  description: 'A source-proved validated write input accepts unbounded strings for a field whose storage declares a finite length.',
  unknownWhen(g) {
    if (!currentScopes(g)) return 'X7_CURRENT_RUN_UNAVAILABLE: a required scope has no successful claim in the current run';
    return observablePairs(g).length === 0
      ? 'X7_NO_OBSERVABLE_LENGTH_PAIR: no current finite-length column and completely bound validated string input can be compared'
      : undefined;
  },
  notes(g) {
    const withheld = factNodes(g, 'SchemaProperty').filter(node =>
      node.props['writeBindingComplete'] === false && currentlyObserved(g, SCOPE_CONTRACTS, node)).length;
    return withheld === 0 ? [] : [`${withheld} request-schema properties have incomplete binding or unknown effective length and were not evaluated`];
  },
  find(g: GraphView): readonly FindingDraft[] {
    return observablePairs(g).filter(pair => pair.property.props['lengthUpperState'] === 'unbounded').map(pair => ({
      left: pair.column.id,
      right: pair.property.id,
      claim: `validated write input ${pair.property.name} permits strings longer than ${pair.maximum} along its extracted binding to ${pair.column.name}`,
      leftFact: `${pair.column.name} declares maxLength=${pair.maximum} (${whereFrom(pair.column)})`,
      rightFact: `${pair.property.name} has a positively proved unbounded string validator and unchanged validated write binding (${whereFrom(pair.property)})`,
      viaPath: pair.joined.viaPath,
      confidence: pair.joined.confidence,
    }));
  },
});
