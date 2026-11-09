/**
 * X5 - unexposed required column.
 *
 * A column that is `NOT NULL`, has no default the writers supply, and that no
 * traced insert names. The schema says a value is mandatory on every insert; the
 * code says no insert supplies one. Those two facts cannot both hold, so some
 * insert fails at runtime or some write path is not what it appears to be.
 *
 * The claim is "no traced write path supplies it", which is only sound where the
 * extractors saw the write paths. The detector therefore stands down, or
 * withholds a table, on every fact that says they did not:
 *
 * - **Repo-wide, UNKNOWN** (`unknownWhen`): `untracedWriteCalls`, `writeHooks` or
 *   `runtimeDdl` or `dynamicDdl` above zero, any of them absent (an absent count is not zero),
 *   and `unknownWriterTables` absent (the list was not measured, so any table
 *   may have a writer nobody traced).
 * - **Per table, withheld with a note**: a table in `unknownWriterTables`, one
 *   with `insertTrigger` true, one with `declarations` above one (its columns are
 *   a union of several sources), one whose `insertTrigger` or `declarations` is
 *   absent, and one that any insert edge reaches without a complete column list
 *   or without fact provenance on the assertion and its writer.
 *   A withheld table is named in the detector's notes, so it never reads as clean.
 *
 * Only inserts can omit a required column: an `UPDATE` that does not set a column
 * is correct. An insert edge without `insertComplete` counts as incomplete, and
 * one incomplete insert silences the table, because the insert it cannot read may
 * supply the column.
 *
 * A column's default is supplied to the writer according to where it lives
 * (`defaultSite`): a database default (`db`) reaches every writer, a client-side
 * one (`client`, an ORM's `@updatedAt`) only an edge that went through the ORM
 * client (`insertOrm`), and a raw statement does not receive it. An absent
 * `defaultSite` is unknown and the column is not reported.
 *
 * Confidence is the weakest contributing insert edge's own confidence: a
 * name-only table binding is 0.7, and the finding carries 0.7, not 1.
 *
 * This detector needs no inferred join at all - `QUERIES` and `CONTAINS` are
 * both extracted - so it does not depend on `infer-join`.
 */

import { isFact, type GraphView, type SeamlineEdge, type SeamlineNode } from '@seamline/ontology';

import { defineDetector, type FindingDraft } from '../detector.ts';
import {
  childrenOf,
  cmp,
  factNodes,
  isFactNode,
  round6,
  whereFrom,
} from '../graph.ts';
import {
  boolProp,
  columnNullable,
  numProp,
  queryInsertColumns,
  queryInsertComplete,
  queryOperations,
  strProp,
  unknownWriterTables,
} from '../props.ts';
import { SCOPE_CODE, SCOPE_DATA } from '../scopes.ts';

/** Statement classes that contain an insert (an upsert's insert half). */
const INSERT_CLASSES: ReadonlySet<string> = new Set(['insert', 'upsert', 'merge', 'replace']);
/** Classes that are known not to insert. */
const NON_INSERT_CLASSES: ReadonlySet<string> = new Set([
  'select',
  'read',
  'query',
  'update',
  'delete',
]);

/** True when the edge has an insert-class statement, or when it cannot be told it has none. */
function isInsertEdge(e: SeamlineEdge): boolean {
  if (queryInsertComplete(e.props) !== undefined) return true;
  const ops = queryOperations(e.props);
  // An edge that says nothing about its statements may hold an insert.
  if (ops === undefined) return true;
  if (ops.some((o) => INSERT_CLASSES.has(o))) return true;
  return !ops.every((o) => NON_INSERT_CLASSES.has(o));
}

/** Why a table is not evaluated, or `undefined` when it is. */
function withheldReason(
  table: SeamlineNode,
  unknownTables: ReadonlyArray<string>,
): string | undefined {
  const declarations = numProp(table.props, 'declarations');
  if (declarations === undefined) {
    return 'its declaration count was not recorded, so its columns may be a union of several sources';
  }
  if (declarations > 1) {
    return `${declarations} source files declare it, so its columns are a union that one insert may not be written for`;
  }
  const trigger = boolProp(table.props, 'insertTrigger');
  if (trigger === undefined)
    return 'whether a BEFORE INSERT trigger supplies its columns was not recorded';
  if (trigger) return 'a BEFORE INSERT trigger on it may supply the column';
  if (unknownTables.includes(table.name.toLowerCase())) {
    return 'a writer the extractor could not turn into an edge may reach it (unknownWriterTables)';
  }
  return undefined;
}

interface Withheld {
  readonly table: string;
  readonly reason: string;
}

interface Evaluation {
  readonly drafts: FindingDraft[];
  /** Tables with an insert path that were not evaluated, with the reason. */
  readonly withheld: Withheld[];
}

/** The `unknownWriterTables` of the repository, lower-cased; `undefined` when any Repo node lacks the measurement. */
function repoUnknownWriterTables(g: GraphView): ReadonlyArray<string> | undefined {
  const repos = factNodes(g, 'Repo');
  if (repos.length === 0) return undefined;
  const all: string[] = [];
  for (const repo of repos) {
    const list = unknownWriterTables(repo.props);
    if (list === undefined) return undefined;
    all.push(...list.map((t) => t.toLowerCase()));
  }
  return all;
}

function evaluate(g: GraphView): Evaluation {
  const drafts: FindingDraft[] = [];
  const withheld: Withheld[] = [];
  const listed = repoUnknownWriterTables(g);

  for (const table of factNodes(g, 'Table')) {
    const inserts = g.edgesTo(table.id, 'QUERIES').filter(
      (e) => e.deletedAt === null && isInsertEdge(e),
    );
    if (inserts.length === 0) continue; // no insert path is traced: say nothing

    // Unlike a cross-domain join, an insert assertion must itself be a fact.
    // Do not drop a guessed writer and then claim the remaining writers omit a column:
    // the writer whose columns are not authoritative may supply it.
    if (inserts.some((e) => !isFact(e.provenance) || !isFactNode(g.node(e.src)))) {
      withheld.push({ table: table.name, reason: 'an insert assertion or its writer is not a fact' });
      continue;
    }

    // An unmeasured list is a repo-wide UNKNOWN (`unknownWhen`); when `find` is reached anyway
    // (a caller that skips the hook), every table counts as having an unknown writer.
    const reason =
      listed === undefined
        ? 'the list of tables with an untraced writer was not measured'
        : withheldReason(table, listed);
    if (reason !== undefined) {
      withheld.push({ table: table.name, reason });
      continue;
    }
    // One insert whose columns are not fully known may supply the column.
    if (inserts.some((e) => queryInsertComplete(e.props) !== true)) {
      withheld.push({ table: table.name, reason: 'an insert into it has no complete column list' });
      continue;
    }

    const written = new Set<string>();
    for (const e of inserts) {
      for (const c of queryInsertColumns(e.props) ?? []) written.add(c.toLowerCase());
    }
    const viaOrm = inserts.some((e) => boolProp(e.props, 'insertOrm') === true);

    // The weakest traced insert governs: the claim is that *every* insert omits the
    // column, so it is only as strong as the least certain of them.
    const confidence = round6(Math.min(...inserts.map((e) => e.confidence)));
    const witnessEdge = [...inserts].sort((a, b) => cmp(a.src, b.src))[0];
    if (witnessEdge === undefined) continue;
    const witness = g.node(witnessEdge.src);
    if (!isFactNode(witness)) continue;

    // Membership establishes which table requires this column, not an inferred join.
    const factColumns = new Set(g.edgesFrom(table.id, 'CONTAINS')
      .filter((e) => e.deletedAt === null && isFact(e.provenance))
      .map((e) => e.dst));
    for (const column of childrenOf(g, table.id, 'Column')) {
      if (!factColumns.has(column.id)) continue;
      if (columnNullable(column.props) !== false) continue;
      if (written.has(column.name.toLowerCase())) continue;
      const site = strProp(column.props, 'defaultSite');
      // Absent (or unrecognised) is unknown: never "no default".
      if (site !== 'none' && site !== 'db' && site !== 'client') continue;
      if (site === 'db') continue;
      if (site === 'client' && viaOrm) continue;

      const detail =
        site === 'client'
          ? 'has only a client-side default, which a raw insert does not receive'
          : 'has no default';
      drafts.push({
        left: column.id,
        right: witness.id,
        claim: `${table.name}.${column.name} is NOT NULL and ${detail}, and none of the ${inserts.length} traced insert path(s) into ${table.name} writes it`,
        leftFact: `${column.name} is NOT NULL and ${detail} (${whereFrom(column)})`,
        rightFact: `${witness.name} inserts into ${table.name} columns [${[...written].sort().join(', ')}] (${witnessEdge.sourceRef ?? whereFrom(witness)})`,
        viaPath: ['QUERIES', 'CONTAINS'],
        confidence,
      });
    }
  }

  return { drafts, withheld };
}

/** A count that must be present and zero, or a reason. */
function countReason(
  nodes: ReadonlyArray<SeamlineNode>,
  kind: string,
  prop: string,
  what: string,
): string | undefined {
  if (nodes.length === 0) return `no ${kind} node records ${prop}, so ${what} was not measured`;
  let total = 0;
  for (const n of nodes) {
    const v = n.props[prop];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      return `${prop} is ${v === undefined ? 'absent' : 'invalid'} on ${kind} ${n.name}, so ${what} was not measured (an absent count is not zero)`;
    }
    total += v;
  }
  return total > 0 ? `${prop} is ${total}: ${what}` : undefined;
}

export const x5UnwrittenColumn = defineDetector({
  code: 'X5_UNWRITTEN_COLUMN',
  severity: 'medium',
  requiredScopes: [SCOPE_DATA, SCOPE_CODE],
  absenceOfCode: true, // "every traced write omits it": a write in an unread package is not traced
  description:
    'A NOT NULL column with no default the writers supply that every traced insert path into its table omits.',
  unknownWhen(g: GraphView): string | undefined {
    const repos = factNodes(g, 'Repo');
    const sources = factNodes(g, 'DataSource');
    const reasons = [
      countReason(
        repos,
        'Repo',
        'untracedWriteCalls',
        'write call(s) could not be attributed to a table',
      ),
      countReason(repos, 'Repo', 'writeHooks', 'write hook(s) may change what an insert writes'),
      countReason(repos, 'Repo', 'runtimeDdl', 'embedded SQL may change schema defaults or triggers outside the data replay'),
      countReason(
        sources,
        'DataSource',
        'dynamicDdl',
        'dynamic DDL (DO blocks, EXECUTE) means the replay of the schema is incomplete',
      ),
      repoUnknownWriterTables(g) === undefined
        ? 'unknownWriterTables is absent, so which tables have a writer nobody traced was not measured'
        : undefined,
    ].filter((r): r is string => r !== undefined);
    return reasons.length === 0 ? undefined : reasons.join('; ');
  },
  find(g: GraphView): ReadonlyArray<FindingDraft> {
    return evaluate(g).drafts;
  },
  notes(g: GraphView): ReadonlyArray<string> {
    return evaluate(g)
      .withheld.sort((a, b) => cmp(a.table, b.table))
      .map((w) => `table ${w.table} was not evaluated: ${w.reason}`);
  },
});
