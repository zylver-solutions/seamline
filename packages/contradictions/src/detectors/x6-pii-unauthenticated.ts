/**
 * X6 - PII reachable without auth. The only `critical` detector.
 *
 * Two facts: an `Operation` that **declares** it requires no authentication,
 * and a `Column` that **declares** it holds PII, connected by a traced call
 * path from the operation's route handler to a query against the column's
 * table.
 *
 * The distinction the detector exists to make:
 *
 * | `auth` / `authMode` | reading | behaviour |
 * |---|---|---|
 * | `'none'`, `'public'`, `'anonymous'` | the contract asserts the endpoint is open | fires |
 * | any other value | an auth mode is declared | silent |
 * | `'unknown'`, or absent | nobody extracted an auth mode | **silent, and reported as a note** |
 *
 * `extract-contracts` spells the third row as the literal `authMode:
 * "unknown"` rather than by omitting the property, and both spellings mean the
 * same thing here. An unknown auth mode is not evidence of no auth. Treating it as such
 * would turn every unannotated endpoint into a critical finding on the first
 * run, which is exactly the failure mode - a permanently red gate - that this
 * design replaced gaps to avoid. The unevaluated operations are surfaced as
 * runner notes instead, so the blind spot is visible rather than silent.
 *
 * One kind of `QUERIES` edge is not evaluated: an edge whose every statement is
 * raw SQL read from a template literal with a substitution (`interpolated`).
 * Such an edge records which table the symbol runs SQL against and nothing about
 * which columns, and with no `columns` list X6 would read it as reaching every
 * PII column of the table. Before the interpolated templates were read these
 * statements had no edge, so skipping them keeps X6 reading exactly what it read
 * then. A symbol that also runs a plain statement against the same table has one
 * edge without `interpolated`, and is read as it always was. The skipped edges
 * are counted in a note so the blind spot is visible.
 *
 * Severity is still subject to the confidence gate: `critical` requires a join
 * confidence of at least 0.9, so a route-matched `IMPLEMENTED_BY` edge at 0.7
 * reports the same reachable PII as `high`, not as a page. The PII label is
 * priced the same way. `extract-data` guesses it from the column name and says
 * so (`piiProvenance: 'INFERRED'`), so `piiWeight` multiplies that confidence
 * in and a guessed label cannot on its own page anyone.
 */

import type { GraphView, SeamlineEdge } from '@seamline/ontology';
import { isFact } from '@seamline/ontology';

import { defineDetector, type FindingDraft } from '../detector.ts';
import { childrenOf, factEdgesFrom, factNodes, isFactNode, round6, whereFrom } from '../graph.ts';
import { followAny } from '../graph.ts';
import { OPERATION_TO_SYMBOL } from '../joins.ts';
import {
  columnPii,
  isPiiColumn,
  operationAuth,
  piiWeight,
  queryColumns,
  queryInterpolated,
} from '../props.ts';
import { SCOPE_CODE, SCOPE_CONTRACTS, SCOPE_DATA, SCOPE_JOIN } from '../scopes.ts';

/** Values that affirmatively declare an operation open to the public. */
const NO_AUTH = new Set(['none', 'public', 'anonymous']);

function effectiveConfidence(e: SeamlineEdge): number {
  return isFact(e.provenance) ? 1 : e.confidence;
}

/** The `QUERIES` edges X6 declined to evaluate, by the reason. */
interface Skipped {
  /** `src dst` keys, so an edge reached by two operations is counted once. */
  readonly interpolated: Set<string>;
}

function evaluate(g: GraphView): { readonly drafts: FindingDraft[]; readonly skipped: Skipped } {
  const drafts: FindingDraft[] = [];
  const skipped: Skipped = { interpolated: new Set() };

  for (const op of factNodes(g, 'Operation')) {
    const auth = operationAuth(op.props);
    if (auth === undefined || !NO_AUTH.has(auth.toLowerCase())) continue;

    for (const j of followAny(g, op.id, OPERATION_TO_SYMBOL, 'Symbol')) {
      for (const q of factEdgesFrom(g, j.node.id, 'QUERIES')) {
        const table = g.node(q.dst);
        if (!isFactNode(table)) continue;
        const piiColumns = childrenOf(g, table.id, 'Column').filter((c) => isPiiColumn(c.props));

        // An edge made only of statements whose select list nobody extracted: it names
        // the table, not the columns, so it is not read as reaching all of them.
        if (queryInterpolated(q.props) === true) {
          if (piiColumns.length > 0) skipped.interpolated.add(`${q.src} ${q.dst}`);
          continue;
        }

        const named = queryColumns(q.props);
        const namedLower = named === undefined ? undefined : new Set(named.map((c) => c.toLowerCase()));

        for (const column of piiColumns) {
          if (namedLower !== undefined && !namedLower.has(column.name.toLowerCase())) continue;
          const confidence = round6(j.confidence * effectiveConfidence(q) * piiWeight(column.props));
          drafts.push({
            left: op.id,
            right: column.id,
            claim: `${op.name} declares auth "${auth}" and reaches ${table.name}.${column.name}, classified pii=${columnPii(column.props) ?? 'unknown'}`,
            leftFact: `${op.name} declares auth="${auth}" (${whereFrom(op)})`,
            rightFact: `${table.name}.${column.name} is classified pii=${columnPii(column.props) ?? 'unknown'} (${whereFrom(column)})`,
            viaPath: [...j.viaPath, 'QUERIES', 'CONTAINS'],
            confidence,
          });
        }
      }
    }
  }

  return { drafts, skipped };
}

export const x6PiiUnauthenticated = defineDetector({
  code: 'X6_PII_UNAUTHENTICATED',
  severity: 'critical',
  requiredScopes: [SCOPE_CONTRACTS, SCOPE_CODE, SCOPE_DATA, SCOPE_JOIN],
  description:
    'An operation that declares no authentication reaches a column classified as PII.',
  find(g: GraphView): ReadonlyArray<FindingDraft> {
    return evaluate(g).drafts;
  },
  notes(g: GraphView): ReadonlyArray<string> {
    const notes: string[] = [];
    const unknownAuth = factNodes(g, 'Operation')
      .filter((op) => operationAuth(op.props) === undefined)
      .map((op) => String(op.id));
    if (unknownAuth.length > 0) {
      notes.push(
        `${unknownAuth.length} operation(s) declare no auth mode and were not evaluated; an absent auth property is unknown, not "no auth": ${unknownAuth.slice(0, 5).join(', ')}${unknownAuth.length > 5 ? ', ...' : ''}`,
      );
    }
    const { skipped } = evaluate(g);
    if (skipped.interpolated.size > 0) {
      notes.push(
        `${skipped.interpolated.size} query edge(s) were not evaluated; interpolated: ${skipped.interpolated.size}. ` +
          'A statement written as a template with substitutions names a table, not the columns it reads, so it is not read as reaching every PII column of that table',
      );
    }
    return notes;
  },
});
