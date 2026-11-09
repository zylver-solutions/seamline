/**
 * Which node each side of a finding is, per detector.
 *
 * A mutant names the finding it expects with `leftMatch` and `rightMatch`:
 * substrings of the finding's `left` and `right` node ids. A match put on the
 * wrong side can never be credited, however well the edit works, and it looks
 * exactly like a detector that cannot find the defect. The detectors fix the
 * sides: X4 reports the unbacked property on the left and the producer of a
 * backed sibling on the right; X10 reports the writing symbol on the left and
 * the PII column on the right.
 *
 * This table records those roles, and `fitsRole` checks a match string
 * against the shape of the node ids that role holds. `parseMutants` refuses a
 * mutant whose match does not fit, so the mistake surfaces when the file is
 * loaded and not as a recall of 0 after the detector's inputs exist. A test
 * (`data.test.ts`) reads the detector sources and fails when a detector's
 * sides stop matching this table, which is the cue to re-read the mutants.
 *
 * Id shapes (path-free canonical names, `{repo}:{Kind}:{canonical}`):
 *
 * - `Column`        `schema.table.column`
 * - `Table`         `schema.table`
 * - `SchemaProperty` the contract name and a property pointer, so `#` or `/`
 * - `CodeField`     `module#Type.field`, so `#`
 * - `Symbol`        `module#name`, so `#`
 * - `Operation`, `RouteHandler`, `Migration`: no shape is assumed
 */

import type { ContradictionCode } from '@seamline/ontology';

export type NodeRole =
  | 'Column'
  | 'Table'
  | 'SchemaProperty'
  | 'CodeField'
  | 'Symbol'
  | 'Operation'
  | 'RouteHandler'
  | 'Migration';

export interface DetectorRoles {
  /** The node kinds the detector can put in `left`. */
  readonly left: readonly NodeRole[];
  /** The node kinds the detector can put in `right`. */
  readonly right: readonly NodeRole[];
  /**
   * The expressions the detector source assigns to `left:` and `right:` in a
   * draft. `data.test.ts` checks them against the source text.
   */
  readonly leftExpressions: readonly string[];
  readonly rightExpressions: readonly string[];
}

export const DETECTOR_ROLES: Readonly<Record<ContradictionCode, DetectorRoles>> = {
  X1_NULLABILITY: {
    left: ['Column'],
    right: ['SchemaProperty'],
    leftExpressions: ['column.id'],
    rightExpressions: ['j.node.id'],
  },
  X2_TYPE: {
    left: ['Column'],
    right: ['SchemaProperty'],
    leftExpressions: ['column.id'],
    rightExpressions: ['j.node.id'],
  },
  X3_CONSTRAINT: {
    left: ['Column'],
    right: ['Symbol'],
    leftExpressions: ['column.id'],
    rightExpressions: ['j.node.id'],
  },
  X4_UNBACKED_PROPERTY: {
    left: ['SchemaProperty'],
    right: ['Column', 'CodeField'],
    leftExpressions: ['p.id'],
    rightExpressions: ['witness.producer.node.id'],
  },
  X5_UNWRITTEN_COLUMN: {
    left: ['Column'],
    right: ['Symbol'],
    leftExpressions: ['column.id'],
    rightExpressions: ['witness.id'],
  },
  X6_PII_UNAUTHENTICATED: {
    left: ['Operation'],
    right: ['Column'],
    leftExpressions: ['op.id'],
    rightExpressions: ['column.id'],
  },
  X7_VALIDATOR_DIVERGENCE: {
    left: ['Column'],
    right: ['SchemaProperty'],
    leftExpressions: ['pair.column.id'],
    rightExpressions: ['pair.property.id'],
  },
  X8_ORPHANED_MIGRATION: {
    left: ['Migration'],
    right: ['Migration'],
    leftExpressions: ['reference.id'],
    rightExpressions: ['creation.id'],
  },
  X9_CONTRACT_DRIFT: {
    left: ['Operation', 'RouteHandler'],
    right: ['RouteHandler', 'Operation'],
    leftExpressions: ['op.id', 'handler.id'],
    rightExpressions: ['witness.other.id'],
  },
  X10_UNTESTED_PII_WRITE: {
    left: ['Symbol'],
    right: ['Column'],
    leftExpressions: ['symbol.id'],
    rightExpressions: ['column.id'],
  },
};

const IDENT = String.raw`[A-Za-z0-9_$-]+`;
const DOTTED = new RegExp(String.raw`^${IDENT}(\.${IDENT})+$`);
const BARE = new RegExp(String.raw`^${IDENT}$`);

const KIND_PREFIX =
  /^(?:[^:]+:)?(Column|Table|SchemaProperty|CodeField|Symbol|Operation|RouteHandler|Migration):/;

/** True when `match` could be a substring of an id of the given kind. */
export function fitsKind(match: string, kind: NodeRole): boolean {
  // A match that spells the node kind (`Column:public.t.a`, `repo:Column:...`) says which role it
  // means, so the kind must be the one asked about; the shape of the rest is then the author's.
  const spelled = KIND_PREFIX.exec(match)?.[1];
  if (spelled !== undefined) return spelled === kind;
  switch (kind) {
    case 'Column':
      return DOTTED.test(match);
    case 'Table':
      return DOTTED.test(match) || BARE.test(match);
    case 'SchemaProperty':
      return BARE.test(match) || match.includes('#') || match.includes('/');
    case 'CodeField':
    case 'Symbol':
      return match.includes('#') || (kind === 'Symbol' && BARE.test(match));
    case 'Operation':
    case 'RouteHandler':
      return true;
    case 'Migration':
      // A selector is a substring, but it still cannot carry path characters
      // or a code-symbol fragment outside Migration's canonical alphabet.
      return /^[A-Za-z0-9._@+~-]+$/.test(match);
  }
}

export type Side = 'left' | 'right';

/**
 * Whether `match` fits some node kind the detector can put on `side`. Returns
 * a sentence naming the mismatch, or `null` when it fits.
 */
export function roleProblem(code: ContradictionCode, side: Side, match: string): string | null {
  const kinds = DETECTOR_ROLES[code][side];
  if (kinds.some((kind) => fitsKind(match, kind))) return null;
  const other: Side = side === 'left' ? 'right' : 'left';
  const swapped = DETECTOR_ROLES[code][other].some((kind) => fitsKind(match, kind));
  return (
    `"${side}Match" is "${match}", which does not look like ${kinds.join(' or ')}, ` +
    `what ${code} puts on the ${side}` +
    (swapped ? `; it fits the ${other} side, so the match is on the wrong side` : '') +
    '.'
  );
}

/**
 * The node kinds each detector source names where it chooses what to look at:
 * as the kind argument of `factNodes(g, 'Kind')`, `followAny(g, id, ROUTE, 'Kind')`
 * and `childrenOf(g, id, 'Kind')`, and in `.kind !== 'Kind'` tests. A test compares
 * these with the source, so changing the kind a detector follows (X3's validator
 * `'Symbol'` to `'SchemaProperty'`, say) fails it even though the `left:` and
 * `right:` expressions are unchanged. The role table above says which of them end
 * up on which side; this says which the detector reaches for.
 */
export const REFERENCED_KINDS: Readonly<Record<ContradictionCode, readonly string[]>> = {
  X1_NULLABILITY: ['CodeField', 'Column', 'SchemaProperty'],
  X2_TYPE: ['CodeField', 'Column', 'SchemaProperty'],
  X3_CONSTRAINT: ['Column', 'Symbol'],
  X4_UNBACKED_PROPERTY: ['CodeField', 'Column', 'Contract', 'SchemaProperty'],
  X5_UNWRITTEN_COLUMN: ['Column', 'DataSource', 'Repo', 'Table'],
  X6_PII_UNAUTHENTICATED: ['Column', 'Operation', 'Symbol'],
  X7_VALIDATOR_DIVERGENCE: ['Column', 'SchemaProperty'],
  X8_ORPHANED_MIGRATION: ['DataSource', 'Migration'],
  X9_CONTRACT_DRIFT: ['Contract', 'Operation', 'RouteHandler'],
  X10_UNTESTED_PII_WRITE: ['Column', 'CoverageRecord', 'Symbol', 'TestCase'],
};

/** The pattern that selects the lines of a detector source `REFERENCED_KINDS` is read from. */
export const KIND_BEARING_LINE = /followAny\(|factNodes\(|childrenOf\(|\.kind\s*[!=]==/;

/** The node kinds a detector source names on its kind-bearing lines (see `REFERENCED_KINDS`). */
export function referencedKindsIn(source: string): string[] {
  const found = new Set<string>();
  for (const line of source.split('\n')) {
    if (!KIND_BEARING_LINE.test(line)) continue;
    for (const m of line.matchAll(/'([A-Z][A-Za-z]+)'/g)) found.add(m[1] as string);
  }
  return [...found].sort();
}
