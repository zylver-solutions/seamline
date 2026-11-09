/**
 * One `QUERIES` edge per (symbol, table), folded order-independently.
 *
 * Edge identity is `(scope, src, dst, kind)`, so a function that runs an
 * `INSERT` and then an `UPDATE` on one table is one edge, and the collector's
 * own merge (later props win, first `sourceRef` wins) would make that edge
 * depend on the order the statements were visited. This module folds every
 * statement per (symbol, table) with rules that do not look at order: sets are
 * unioned, completeness is an AND, confidence is a minimum, the location is the
 * smallest `(path, line)`. Design: `docs/design/real-world-inputs.md`, 3.4.
 */

import type { NodeId } from '@seamline/ontology';
import type { EdgeInput, Props } from './collector.ts';
import { sourceRef } from './paths.ts';
import type { RawSqlCall, SqlClass } from './raw-sql.ts';

interface SetFold {
  readonly columns: Set<string>;
  /** AND over every call that has this half. A call with no determination is `false`. */
  complete: boolean;
}

interface Location {
  readonly file: string;
  readonly line: number;
  readonly table: string;
  readonly schema: string | null;
}

export interface QueryFold {
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly classes: Set<SqlClass>;
  confidence: number;
  at: Location;
  /** AND over every call: true only while each is read from a template with a substitution. */
  interpolated: boolean;
  insert: SetFold | null;
  update: SetFold | null;
}

/** One statement's contribution, resolved to the edge it belongs to. */
export interface QueryContribution {
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly file: string;
  readonly line: number;
  readonly confidence: number;
  /** The literal is a template literal with at least one substitution. */
  readonly interpolated: boolean;
  readonly call: RawSqlCall;
}

export type QueryFolds = Map<string, QueryFold>;

function compareLocations(a: Location, b: Location): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.table !== b.table) return a.table < b.table ? -1 : 1;
  const left = a.schema ?? '';
  const right = b.schema ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

function foldSet(into: SetFold | null, columns: readonly string[], complete: boolean): SetFold {
  const fold = into ?? { columns: new Set<string>(), complete: true };
  fold.complete = fold.complete && complete;
  if (complete) for (const column of columns) fold.columns.add(column);
  return fold;
}

/** Add one statement to the fold for its (symbol, table). Order does not matter. */
export function addQuery(folds: QueryFolds, c: QueryContribution): void {
  const key = `${c.src}\u0000${c.dst}`;
  const at: Location = {
    file: c.file,
    line: c.line,
    table: c.call.table.table,
    schema: c.call.table.schema,
  };
  let fold = folds.get(key);
  if (fold === undefined) {
    fold = {
      src: c.src,
      dst: c.dst,
      classes: new Set(),
      confidence: c.confidence,
      at,
      interpolated: c.interpolated,
      insert: null,
      update: null,
    };
    folds.set(key, fold);
  } else {
    fold.confidence = Math.min(fold.confidence, c.confidence);
    if (compareLocations(at, fold.at) < 0) fold.at = at;
    fold.interpolated = fold.interpolated && c.interpolated;
  }
  for (const cls of c.call.classes) fold.classes.add(cls);
  if (c.call.insert !== null)
    fold.insert = foldSet(fold.insert, c.call.insert.columns, c.call.insert.complete);
  if (c.call.update !== null)
    fold.update = foldSet(fold.update, c.call.update.columns, c.call.update.complete);
}

const WRITES: ReadonlySet<SqlClass> = new Set(['delete', 'insert', 'update', 'upsert']);

function sortedList(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The props of the folded edge.
 *
 * - One class: `operation`, exactly as before this fold existed. Two or more:
 *   `operations` (the sorted, comma-separated set) and `writes`, and no
 *   `operation`; a reader takes `operations` when present.
 * - `insertColumns` and `insertComplete` when some call is insert-class (an
 *   upsert's create branch included); `updateColumns` and `updateComplete` for
 *   update-class. `...Columns` is the union over the calls whose own set is
 *   complete, so it is never a partial list presented as complete; `...Complete`
 *   is the AND over every call, so one undetermined call makes it `false`.
 * - `interpolated` only when true.
 * - `binding` is `unqualified-name`: every call here is raw SQL, bound by name.
 *   (`bindings`, the set, arrives with the first ORM-bound call.)
 */
export function queryProps(fold: QueryFold): Props {
  const classes = sortedList(fold.classes);
  const props: Props = {
    table: fold.at.table,
    schema: fold.at.schema,
    binding: 'unqualified-name',
  };
  if (classes.length === 1) {
    props['operation'] = classes[0] as string;
  } else {
    props['operations'] = classes.join(',');
    props['writes'] = classes.some((c) => WRITES.has(c as SqlClass));
  }
  if (fold.insert !== null) {
    props['insertComplete'] = fold.insert.complete;
    if (fold.insert.columns.size > 0)
      props['insertColumns'] = sortedList(fold.insert.columns).join(',');
  }
  if (fold.update !== null) {
    props['updateComplete'] = fold.update.complete;
    if (fold.update.columns.size > 0)
      props['updateColumns'] = sortedList(fold.update.columns).join(',');
  }
  if (fold.interpolated) props['interpolated'] = true;
  return props;
}

/** The edges, in sorted order of (src, dst). */
export function queryEdges(folds: QueryFolds): EdgeInput[] {
  return [...folds.values()]
    .sort((a, b) =>
      a.src !== b.src ? (a.src < b.src ? -1 : 1) : a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0,
    )
    .map((fold) => ({
      kind: 'QUERIES' as const,
      src: fold.src,
      dst: fold.dst,
      srcFile: fold.at.file,
      sourceRef: sourceRef(fold.at.file, fold.at.line),
      confidence: fold.confidence,
      props: queryProps(fold),
    }));
}
