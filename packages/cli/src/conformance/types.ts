/**
 * The shapes the extractor conformance suite reports and the options it takes.
 *
 * A property has one of four verdicts, and only one of them is a pass:
 *
 *  - `PASS`: the property was exercised and held.
 *  - `FAIL`: the property was exercised and did not hold.
 *  - `UNAVAILABLE`: the property could not be assessed (the extractor never did its job on the
 *    fixtures, so there was nothing to hold or break). It is never a pass: the whole suite is a
 *    `PASS` only when every property is, which is the project's rule that a check which could not
 *    run is not a check which passed (AGENTS.md, invariant 3).
 *  - `NOT_APPLICABLE`: the property is about something the extractor declares it does not do. Only
 *    `unavailable-not-pass` can be, for an extractor that declares no reads and reads no graph, so
 *    that it has no input it could lose.
 */

import type { GraphView } from '@seamline/ontology';
import type { SandboxHost } from '../sandbox/host.ts';

export type Verdict = 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'NOT_APPLICABLE';

export const PROPERTY_IDS = [
  'manifest',
  'exercised',
  'reads-confined',
  'no-network',
  'provenance-ceiling',
  'memory-ceiling',
  'time-budget',
  'unavailable-not-pass',
] as const;
export type PropertyId = (typeof PROPERTY_IDS)[number];

export const PROPERTY_TITLES: Readonly<Record<PropertyId, string>> = {
  manifest: 'the capability manifest is well formed and within the host limits',
  exercised: 'does its job on a clean fixture (PASS, with output)',
  'reads-confined': 'reads only what its declared globs admit, through symlinks and .. included',
  'no-network': 'makes no network, DNS, fetch or child-process attempt',
  'provenance-ceiling':
    'emits nothing above its declared provenance ceiling or outside its declared scopes',
  'memory-ceiling': 'stays under its declared memory ceiling, on a stress fixture',
  'time-budget': 'terminates within its declared time budget',
  'unavailable-not-pass': 'reports UNAVAILABLE or FAIL, never PASS, when its input is unreadable',
};

export interface PropertyResult {
  readonly id: PropertyId;
  readonly title: string;
  readonly verdict: Verdict;
  /** Why, in plain lines: what was run, what was seen. Always present, whatever the verdict. */
  readonly evidence: ReadonlyArray<string>;
}

/** One run of the extractor under the sandbox host, on one fixture. */
export interface RunSummary {
  readonly fixture: FixtureKind;
  /** What the extractor (or the host, for it) reported. */
  readonly status: 'PASS' | 'FAIL' | 'UNAVAILABLE';
  /** False when the host never started the extractor. */
  readonly ran: boolean;
  /** The sandbox violation codes the host judged the run on. */
  readonly violations: ReadonlyArray<string>;
  readonly nodes: number;
  readonly edges: number;
  readonly durationMs: number;
  /** The first few diagnostics, bounded. */
  readonly diagnostics: ReadonlyArray<string>;
}

/** Where the fixtures put the padded files and the bait (repo-relative, POSIX). The wrapper tallies the opens under each. */
export const STRESS_DIR = 'conformance-stress';
export const BAIT_DIR = 'conformance-lures/bait';

export const FIXTURE_KINDS = ['clean', 'links', 'bait', 'unreadable', 'stress'] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

export interface ConformanceReport {
  /** Bumped when a property is added, removed or redefined. */
  readonly suite: number;
  readonly extractor: { readonly name: string; readonly version: string } | null;
  /** `PASS` only when every property is `PASS` or `NOT_APPLICABLE`. */
  readonly verdict: Exclude<Verdict, 'NOT_APPLICABLE'>;
  readonly properties: ReadonlyArray<PropertyResult>;
  readonly runs: ReadonlyArray<RunSummary>;
}

export const SUITE_VERSION = 1;

export interface ConformanceOptions {
  /** The sandbox host to run under. Default: a host over the process environment with the default limits. */
  readonly host?: SandboxHost;
  /** The environment the extractor's own is derived from. Default: the process's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** A directory of representative input, copied into every fixture. Strongly advised: see docs/conformance.md. */
  readonly seed?: string;
  /** `ctx.options` for the extractor, verbatim. */
  readonly options?: Readonly<Record<string, unknown>>;
  /** For a program that reads the run's graph: the graph it is handed. The suite degrades it for `unavailable-not-pass`. */
  readonly graph?: GraphView;
  /** Approximate size of the stress fixture, in MiB. Default 8. */
  readonly stressMb?: number;
  /**
   * Which fixtures to run. Default: all four. A property that depends on a fixture that was not run
   * is `UNAVAILABLE`, so narrowing this can only turn a report from PASS into UNAVAILABLE; it is for
   * iterating on one property, and the report of a narrowed run says which fixtures it ran.
   */
  readonly fixtures?: ReadonlyArray<FixtureKind>;
  /** The directory fixtures are created under. Default: the OS temp directory. */
  readonly workDir?: string;
}
