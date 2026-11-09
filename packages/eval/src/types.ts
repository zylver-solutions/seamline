/**
 * Shared shapes for the evaluation harness.
 *
 * Everything here is plain data. The harness never imports an extractor or a
 * detector: it drives the built `seamline` CLI as a subprocess and reads what
 * that CLI reports, so it measures the product a user runs, not a library
 * surface a test happens to reach.
 */

import type { ContradictionCode, Severity } from '@seamline/ontology';

/**
 * Which half of the corpus a repository belongs to.
 *
 * `dev` repositories are the ones detector work is tuned against: their
 * findings are read, discussed, and fixed. `sealed` repositories are held out:
 * the people who change detectors look at counts, not at individual findings,
 * so the sealed precision figure is not fitted to the thing it measures.
 */
export type Partition = 'dev' | 'sealed';

export const PARTITIONS: readonly Partition[] = ['dev', 'sealed'];

/** One pinned public repository. Nothing from it is ever committed here. */
export interface CorpusEntry {
  readonly name: string;
  readonly url: string;
  /** Full 40-hex commit id. A branch or tag is not a pin. */
  readonly sha: string;
  readonly license: string;
  readonly partition: Partition;
  readonly stacks: readonly string[];
  readonly why: string;
}

/** A contradiction as reported by `seamline check --json`, plus its stable id. */
export interface Finding {
  /** `sha256(repo|code|left|right)` truncated to 16 hex characters. */
  readonly id: string;
  readonly repo: string;
  readonly code: ContradictionCode;
  readonly severity: Severity;
  readonly left: string;
  readonly right: string;
  readonly claim: string;
  readonly leftFact: string;
  readonly rightFact: string;
  readonly viaPath: readonly string[];
  readonly confidence: number;
  /** How many raw contradictions collapsed into this id (same code, left, right). */
  readonly occurrences: number;
}

/**
 * `tp` and `fp` enter precision. `unclear` is a finding the reviewer could not
 * decide from the source (the intent is not recoverable, or it depends on
 * behaviour outside the repository): it is counted and shown, never folded
 * into either side of the ratio.
 */
export type Verdict = 'tp' | 'fp' | 'unclear';

/** Declared account identity, checked by reviewers rather than authenticated by the harness. */
export type ReviewerIdentity =
  | { readonly kind: 'human'; readonly account: string }
  | { readonly kind: 'agent'; readonly account: string; readonly model: string };

export interface SourceReview {
  readonly identity: ReviewerIdentity;
  readonly verdict: Verdict;
  readonly rationale: string;
  readonly evidence: readonly string[];
  readonly blind: boolean;
}

/** An independent reviewer's verdict on one finding id. */
export interface Label {
  readonly verdict: Verdict;
  /**
   * Findings of one detector in one repository that share a cluster are one underlying
   * defect (or one underlying false alarm) reported several times, and count
   * once in the clustered figures. All members must carry the same verdict.
   */
  readonly cluster?: string;
  readonly rationale: string;
  /** `path:line` citations at the pinned SHA. */
  readonly evidence: readonly string[];
  readonly reviewer: string;
  /** True when the reviewer judged from the label sheet alone, without Seamline's claim or confidence. */
  readonly blind: boolean;
  /** Absent on legacy labels, which receive no formal identity credit. */
  readonly identity?: ReviewerIdentity;
  readonly reviews?: readonly SourceReview[];
}

/**
 * What one detector did on one repository.
 *
 * `unknown` is not `clean`: the detector could not run (a scope it needs did
 * not PASS, or the run itself failed), so it has said nothing about the repo.
 */
export type DetectorState = 'fired' | 'clean' | 'unknown';

export interface DetectorOutcome {
  readonly state: DetectorState;
  /** Findings produced (distinct ids). Zero for `clean` and `unknown`. */
  readonly findings: number;
  /** Why the detector was UNKNOWN, when it was. */
  readonly reason?: string;
}

export interface ExtractorSummary {
  readonly name: string;
  readonly version: string;
  readonly status: string;
  readonly nodes: number;
  readonly edges: number;
  readonly scopes: readonly string[];
  readonly diagnostics: readonly string[];
}

/**
 * How far the harness got on one repository.
 *
 * - `complete`  extract and check both ran and produced parseable output
 *               (individual extractors may still be FAIL or UNAVAILABLE)
 * - `crashed`   a CLI invocation exited abnormally or printed unparseable output
 * - `timeout`   a CLI invocation exceeded the per-repo timeout
 */
export type PipelineOutcome = 'complete' | 'crashed' | 'timeout';

export interface PipelineResult {
  readonly outcome: PipelineOutcome;
  /** Human-readable cause when `outcome` is not `complete`. */
  readonly detail: string | null;
  readonly extractors: readonly ExtractorSummary[];
  readonly degradedScopes: readonly string[];
  readonly nodeCounts: Readonly<Record<string, number>>;
  readonly edgeCounts: Readonly<Record<string, number>>;
  readonly findings: readonly Finding[];
  readonly detectors: Readonly<Record<ContradictionCode, DetectorOutcome>>;
  /** Wall-clock milliseconds. Run metadata only; never part of the report body. */
  readonly extractMs: number;
  readonly checkMs: number;
}

export interface MutantEditReplace {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
}

export interface MutantEditAppend {
  readonly path: string;
  readonly append: string;
}

/**
 * Edits to a JSON document by RFC 6901 JSON Pointer, so a mutant needs no text
 * from the document it edits: `set` the value at the pointer (adding the key
 * if the parent lacks it), `remove` it, or rename its key in place.
 */
export interface MutantEditJsonSet {
  readonly path: string;
  readonly pointer: string;
  readonly set: unknown;
}

export interface MutantEditJsonRemove {
  readonly path: string;
  readonly pointer: string;
  readonly remove: true;
}

export interface MutantEditJsonRename {
  readonly path: string;
  readonly pointer: string;
  readonly renameKey: string;
}

export type MutantEditJson = MutantEditJsonSet | MutantEditJsonRemove | MutantEditJsonRename;

export type MutantEdit = MutantEditReplace | MutantEditAppend | MutantEditJson;

export interface MutantExpect {
  readonly code: ContradictionCode;
  /** Substring that the finding's `left` node id must contain. */
  readonly leftMatch?: string;
  /** Substring that the finding's `right` node id must contain. */
  readonly rightMatch?: string;
}

/** One injected contradiction. */
export interface Mutant {
  readonly id: string;
  readonly repo: string;
  readonly detector: ContradictionCode;
  readonly description: string;
  readonly edits: readonly MutantEdit[];
  readonly expect: MutantExpect;
}
