/**
 * X10 - untested PII write path.
 *
 * A symbol that writes a column classified as PII, with no test case testing it
 * and no coverage record covering it. Two facts: the write (a `QUERIES` edge
 * with `writes=true`, extracted) and the PII classification on the column.
 *
 * The control: the graph must contain verification facts at all. A repository
 * with no `TestCase` and no `CoverageRecord` nodes has an absent test suite,
 * not an untested PII path, and reporting one write per PII column there would
 * be reporting "this project has no tests" ten times over. That case emits a
 * runner note instead of findings.
 *
 * No shipped extractor produces the verification half yet (v3 section 9).
 * Explicitly supplied TestCase/TESTS or CoverageRecord/COVERS facts are read
 * when present; authored controls do not establish real extraction coverage.
 */

import type { GraphView, NodeId } from '@seamline/ontology';
import { isFact } from '@seamline/ontology';

import { defineDetector, type FindingDraft } from '../detector.ts';
import {
  childrenOf,
  factEdgesFrom,
  factEdgesTo,
  factNodes,
  isFactNode,
  parentOf,
  round6,
  whereFrom,
} from '../graph.ts';
import {
  columnPii, coverageCovered, isPiiColumn, piiWeight, queryColumns,
  queryInsertColumns, queryInsertComplete, queryOperations, queryUpdateColumns,
  queryUpdateComplete, queryWrites, type Props,
} from '../props.ts';
import { SCOPE_CODE, SCOPE_DATA, SCOPE_JOIN } from '../scopes.ts';

/** How many symbol-writes-PII-column pairs exist, regardless of test coverage. */
function piiWritePathCount(g: GraphView): number {
  let count = 0;
  for (const symbol of factNodes(g, 'Symbol')) {
    for (const e of factEdgesFrom(g, symbol.id, 'QUERIES')) {
      if (queryWrites(e.props) !== true) continue;
      const table = g.node(e.dst);
      if (!isFactNode(table)) continue;
      count += childrenOf(g, table.id, 'Column').filter((c) => isPiiColumn(c.props)).length;
    }
  }
  return count;
}

function verificationFactsExist(g: GraphView): boolean {
  return factNodes(g, 'TestCase').length > 0 || factNodes(g, 'CoverageRecord').length > 0;
}

function isVerified(g: GraphView, id: NodeId): boolean {
  for (const e of factEdgesTo(g, id, 'TESTS')) {
    if (isFactNode(g.node(e.src))) return true;
  }
  for (const e of factEdgesTo(g, id, 'COVERS')) {
    const record = g.node(e.src);
    if (isFactNode(record) && coverageCovered(record.props) !== false) return true;
  }
  return false;
}

/** Complete explicit write sets, never the read columns of a folded SELECT. */
function writtenColumns(props: Props): readonly string[] | undefined {
  const typed = ['insertColumns', 'insertComplete', 'updateColumns', 'updateComplete']
    .some(key => Object.hasOwn(props, key));
  // Keep explicitly supplied legacy facts. They cannot override the producer's
  // newer per-class facts, including an incomplete or withheld column list.
  if (!typed && props['operations'] === undefined && props['operation'] === undefined &&
      props['writes'] === true && queryColumns(props) !== undefined) return queryColumns(props);
  const operations = queryOperations(props);
  if (operations === undefined || operations.length === 0) return undefined;
  const insert = operations.some(operation => operation === 'insert' || operation === 'upsert');
  const update = operations.some(operation => operation === 'update' || operation === 'upsert');
  if ((!insert && ['insertColumns', 'insertComplete'].some(key => Object.hasOwn(props, key))) ||
      (!update && ['updateColumns', 'updateComplete'].some(key => Object.hasOwn(props, key)))) return undefined;
  if ((!insert && !update) || operations.some(operation =>
    !['insert', 'update', 'upsert', 'select', 'read', 'query'].includes(operation))) return undefined;
  const columns = new Set<string>();
  for (const [required, complete, names] of [
    [insert, queryInsertComplete(props), queryInsertColumns(props)],
    [update, queryUpdateComplete(props), queryUpdateColumns(props)],
  ] as const) {
    if (!required) continue;
    if (complete !== true || names === undefined) return undefined;
    for (const name of names) columns.add(name);
  }
  return [...columns].sort();
}

function symbolIsVerified(g: GraphView, id: NodeId): boolean {
  if (isVerified(g, id)) return true;
  const file = parentOf(g, id, 'File');
  return file !== undefined && isVerified(g, file.id);
}

export const x10UntestedPiiWrite = defineDetector({
  code: 'X10_UNTESTED_PII_WRITE',
  severity: 'medium',
  requiredScopes: [SCOPE_CODE, SCOPE_DATA, SCOPE_JOIN],
  absenceOfCode: true, // "no test reaches it": the test may be in an unread package
  description:
    'A symbol writes a column classified as PII and no test or coverage record reaches it.',
  unknownWhen(g) {
    // Missing verification facts retain their documented clean-with-note
    // behavior. This guard concerns the write fact, once verification exists.
    if (!verificationFactsExist(g)) return undefined;
    for (const symbol of factNodes(g, 'Symbol')) {
      if (symbolIsVerified(g, symbol.id)) continue;
      for (const edge of factEdgesFrom(g, symbol.id, 'QUERIES')) {
        if (queryWrites(edge.props) !== true) continue;
        const table = g.node(edge.dst);
        if (!isFactNode(table) || !childrenOf(g, table.id, 'Column').some(column => isPiiColumn(column.props))) continue;
        if (writtenColumns(edge.props) === undefined)
          return 'WRITE_COLUMNS_UNOBSERVED: a write to a table with PII has no complete explicit write-column set';
      }
    }
    return undefined;
  },
  find(g: GraphView): ReadonlyArray<FindingDraft> {
    if (!verificationFactsExist(g)) return [];
    const drafts: FindingDraft[] = [];

    for (const symbol of factNodes(g, 'Symbol')) {
      const writes = factEdgesFrom(g, symbol.id, 'QUERIES').filter((e) => queryWrites(e.props) === true);
      if (writes.length === 0) continue;
      if (symbolIsVerified(g, symbol.id)) continue;

      for (const e of writes) {
        const table = g.node(e.dst);
        if (!isFactNode(table)) continue;
        const named = writtenColumns(e.props);
        if (named === undefined) continue;
        const namedColumns = new Set(named);
        const edgeConfidence = isFact(e.provenance) ? 1 : e.confidence;

        for (const column of childrenOf(g, table.id, 'Column')) {
          if (!isPiiColumn(column.props)) continue;
          if (!namedColumns.has(column.name)) continue;
          const confidence = round6(edgeConfidence * piiWeight(column.props));
          drafts.push({
            left: symbol.id,
            right: column.id,
            claim: `${symbol.name} writes ${table.name}.${column.name} (pii=${columnPii(column.props) ?? 'unknown'}) and no test case or coverage record reaches it`,
            leftFact: `${symbol.name} writes ${table.name} (${whereFrom(symbol)})`,
            rightFact: `${table.name}.${column.name} is classified pii=${columnPii(column.props) ?? 'unknown'} (${whereFrom(column)})`,
            viaPath: ['QUERIES', 'CONTAINS'],
            confidence,
          });
        }
      }
    }

    return drafts;
  },
  notes(g: GraphView): ReadonlyArray<string> {
    if (verificationFactsExist(g)) return [];
    const candidates = piiWritePathCount(g);
    if (candidates === 0) return [];
    return [
      `${candidates} PII write path(s) exist but no TestCase or CoverageRecord facts are present, so none can be shown to be untested; X10 reported nothing rather than reporting every PII write`,
    ];
  },
});
