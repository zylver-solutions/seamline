/**
 * How a detector is built, and the two rules it is not allowed to forget.
 *
 * A detector author writes `find` and nothing else. `defineDetector` wraps it
 * so that both invariants below hold structurally rather than by discipline:
 *
 * **The scope gate (v3 section 2.2).** If any required scope is not `PASS`,
 * `detect` returns nothing and the runner reports UNKNOWN. The check lives in
 * the wrapper, so it applies even to a caller that reaches past
 * `runDetectors` and invokes `detect` directly. A crashed extractor must never
 * read as "the fact is absent, therefore contradiction".
 *
 * **The unknown gate.** A scope status is not the only reason a detector can be
 * unable to answer. An extractor can PASS and still record, as a fact on the
 * graph, that it did not see everything a "no writer supplies this" claim needs
 * (`docs/design/real-world-inputs.md`, section 5.2). A detector reads such a fact
 * in `unknownWhen`, and a defined answer is treated exactly like a blocked scope:
 * `detect` returns nothing, `find` is not called, and the runner reports UNKNOWN
 * with that text as the reason.
 *
 * **The confidence gate.** A detector declares the severity its claim would
 * carry if the two facts were joined with certainty. The wrapper multiplies
 * that against the confidence of the join actually used, and a weak join
 * degrades the severity or drops the finding entirely. A detector cannot emit
 * a severity, only a draft; the mapping is applied in one place.
 */

import {
  type Contradiction,
  type ContradictionCode,
  type ContradictionDetector,
  type EdgeKind,
  type GraphView,
  type NodeId,
  type Severity,
} from '@seamline/ontology';

import { cmp, round6, unreadCodePackages } from './graph.ts';

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * The minimum join confidence a severity may be reported at.
 *
 * Derived, not chosen by feel:
 *
 * - `0.9` for **critical**. Only X6 is critical, and critical means someone is
 *   paged. A single inferred hop below 0.9 is not enough to assert an
 *   unauthenticated PII path; two hops at 0.95 (0.9025) is.
 * - `0.75` for **high**. `infer-join` inherits the 0.6 confidence an earlier
 *   internal project used for interface- and abstract-resolved edges (v3
 *   section 11). One such hop
 *   must not be able to produce a high-severity finding, and 0.6 < 0.75, so it
 *   cannot.
 * - `0.5` for **medium**. Two ordinary 0.75 hops (0.5625) still land here.
 * - `0.35` floor. Three 0.7 hops (0.343) fall below it and are suppressed
 *   entirely. This is what keeps the list bounded rather than long-tailed.
 */
export const SEVERITY_CONFIDENCE_FLOOR: Readonly<Record<Severity, number>> = {
  critical: 0.9,
  high: 0.75,
  medium: 0.5,
  low: 0.35,
};

/** Below this, a finding is not reported at any severity. */
export const CONFIDENCE_FLOOR = SEVERITY_CONFIDENCE_FLOOR.low;

/** The highest severity a join of this confidence may carry, if any. */
export function severityCeiling(confidence: number): Severity | undefined {
  if (confidence >= SEVERITY_CONFIDENCE_FLOOR.critical) return 'critical';
  if (confidence >= SEVERITY_CONFIDENCE_FLOOR.high) return 'high';
  if (confidence >= SEVERITY_CONFIDENCE_FLOOR.medium) return 'medium';
  if (confidence >= SEVERITY_CONFIDENCE_FLOOR.low) return 'low';
  return undefined;
}

/**
 * The declared severity, lowered to what the join supports.
 * `undefined` means the join is too weak to report at all.
 */
export function gateSeverity(declared: Severity, confidence: number): Severity | undefined {
  const ceiling = severityCeiling(confidence);
  if (ceiling === undefined) return undefined;
  return SEVERITY_RANK[declared] >= SEVERITY_RANK[ceiling] ? declared : ceiling;
}

/** What a detector produces. Severity is assigned by the wrapper, never here. */
export interface FindingDraft {
  readonly left: NodeId;
  readonly right: NodeId;
  readonly claim: string;
  readonly leftFact: string;
  readonly rightFact: string;
  readonly viaPath: ReadonlyArray<EdgeKind>;
  /** Confidence of the join that connected the two facts; 1 for an all-fact path. */
  readonly confidence: number;
}

export interface DetectorSpec {
  readonly code: ContradictionCode;
  /** Severity when the join is certain. Lowered by `gateSeverity` otherwise. */
  readonly severity: Severity;
  readonly requiredScopes: ReadonlyArray<string>;
  /**
   * True when the detector concludes something from the **absence** of a code
   * fact: no producer for a property, no writer for a column, no handler for an
   * operation, no test for a write. Such a conclusion is only as good as the
   * code that was read, and `code.ts` can PASS while covering part of a
   * workspace, so the detector reports UNKNOWN while any workspace package is
   * known to be unread. Detectors that compare two present facts leave this off:
   * an unread package cannot make two facts disagree.
   */
  readonly absenceOfCode?: boolean;
  /** One sentence naming the two facts compared. Rendered by `explain`. */
  readonly description: string;
  find(g: GraphView): ReadonlyArray<FindingDraft>;
  /**
   * A reason this detector cannot answer on this graph that is not a scope status,
   * read from facts the extractors recorded (a count of writers they could not
   * attribute, a prop that is absent where absence means "not measured").
   *
   * Any string, the empty one included, makes the outcome UNKNOWN exactly as a
   * blocked scope does: no findings, `find` is not called, and the string is the
   * reason the runner reports. `undefined` leaves the detector as it was, so a
   * hook that collects reasons returns `undefined`, not `''`, when it has nothing
   * to report (`reasons.join('; ')` of an empty list is `''`, which is UNKNOWN with
   * a stand-in text). Any other return (`null`, `false`, a number, an object: a JS
   * caller or a cast) is also UNKNOWN with that stand-in, never a pass. It is
   * asked only when every required scope PASSes, so a scope that is not PASS keeps
   * its own reason; and it must not throw on a graph that lacks the facts it reads,
   * because a fact that is absent is itself a reason to return a string.
   */
  unknownWhen?(g: GraphView): string | undefined;
  /**
   * Facts the detector could not evaluate for a reason other than a failed
   * scope - X6's "this operation declares no auth mode at all", for instance.
   * Surfaced by the runner so a partial answer is visible rather than silently
   * indistinguishable from a clean result.
   */
  notes?(g: GraphView): ReadonlyArray<string>;
}

export interface SeamlineDetector extends ContradictionDetector {
  readonly description: string;
  /** Scopes this detector needs that are not PASS. Empty when it may run. */
  blockedScopes(g: GraphView): ReadonlyArray<string>;
  /**
   * Why the detector is UNKNOWN on `g` although every scope it needs PASSes: the
   * text its `unknownWhen` returned, or a stand-in when that text is empty.
   * `undefined` when `unknownWhen` is absent, returns `undefined`, or a scope is
   * blocked (the blocked scope is then the reason).
   */
  unknownReason(g: GraphView): string | undefined;
  /** Why an absence-based detector cannot speak because code went unread; `undefined` when it may. */
  unreadCode(g: GraphView): string | undefined;
  notes(g: GraphView): ReadonlyArray<string>;
}

/** Shown when `unknownWhen` returns an empty string or a non-string: UNKNOWN must never read as no reason at all. */
const UNSTATED_REASON = 'the detector reported UNKNOWN without stating a reason';

export function blockedScopes(g: GraphView, scopes: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...scopes].filter((s) => g.scopeStatus(s) !== 'PASS').sort(cmp);
}

export function defineDetector(spec: DetectorSpec): SeamlineDetector {
  const blocked = (g: GraphView): ReadonlyArray<string> => blockedScopes(g, spec.requiredScopes);
  const unknownReason = (g: GraphView): string | undefined => {
    if (spec.unknownWhen === undefined || blocked(g).length > 0) return undefined;
    const reason = spec.unknownWhen(g);
    if (reason === undefined) return undefined;
    // Fail closed on a value the type forbids (`null`, a cast): UNKNOWN with the stand-in, not a throw
    // from `.length` and not a pass.
    return typeof reason === 'string' && reason.length > 0 ? reason : UNSTATED_REASON;
  };
  const unreadCode = (g: GraphView): string | undefined => {
    if (spec.absenceOfCode !== true) return undefined;
    const { count, named } = unreadCodePackages(g);
    if (count === 0) return undefined;
    const shown = named.slice(0, 5).join(', ') + (named.length > 5 || count > named.length ? ', ...' : '');
    return (
      `code.ts did not read ${count} workspace package(s) (${shown}); this detector reasons from the absence ` +
      'of a code fact, which an unread package could supply, so it reports UNKNOWN rather than a finding'
    );
  };
  return {
    code: spec.code,
    severity: spec.severity,
    requiredScopes: spec.requiredScopes,
    description: spec.description,
    blockedScopes: blocked,
    unknownReason,
    unreadCode,
    notes: (g) =>
      blocked(g).length > 0 || unreadCode(g) !== undefined || unknownReason(g) !== undefined
        ? []
        : (spec.notes?.(g) ?? []),
    detect(g: GraphView): ReadonlyArray<Contradiction> {
      // The scope gate. Non-negotiable, and applied before `find` ever runs.
      if (blocked(g).length > 0) return [];
      // The unknown gates: the same refusal, for a reason the graph's own facts give (unread code
      // for an absence-based detector, or whatever `unknownWhen` reports).
      if (unreadCode(g) !== undefined || unknownReason(g) !== undefined) return [];
      const drafts = spec.find(g);
      const kept = new Map<string, Contradiction>();
      for (const d of drafts) {
        const confidence = round6(d.confidence);
        const severity = gateSeverity(spec.severity, confidence);
        if (severity === undefined) continue; // the join is too weak to assert anything
        const c: Contradiction = {
          code: spec.code,
          severity,
          left: d.left,
          right: d.right,
          claim: d.claim,
          leftFact: d.leftFact,
          rightFact: d.rightFact,
          viaPath: d.viaPath,
          confidence,
        };
        const key = `${c.left} ${c.right} ${c.claim}`;
        const prev = kept.get(key);
        if (prev === undefined || c.confidence > prev.confidence) kept.set(key, c);
      }
      return [...kept.values()].sort(compareContradictions);
    },
  };
}

/** Total order over findings. Severity first, then code, then the left fact. */
export function compareContradictions(a: Contradiction, b: Contradiction): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    cmp(a.code, b.code) ||
    cmp(a.left, b.left) ||
    cmp(a.right, b.right) ||
    cmp(a.claim, b.claim)
  );
}
