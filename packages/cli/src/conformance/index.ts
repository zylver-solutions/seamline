/**
 * The extractor conformance suite: the public programmatic entry.
 *
 * `runConformance` takes a sandbox program, `conformanceOfModule` takes a module path, and
 * `loadExtractorProgram` is the step between. docs/conformance.md says what each property asserts
 * and what it does not promise.
 */

export { conformanceOfModule, loadFailureReport, runConformance } from './suite.ts';
export type { ConformanceRunOptions } from './suite.ts';
export { loadExtractorProgram, manifestShapeProblem } from './load.ts';
export type { Loaded } from './load.ts';
export { PROPERTY_IDS, PROPERTY_TITLES, SUITE_VERSION } from './types.ts';
export type {
  ConformanceOptions,
  ConformanceReport,
  FixtureKind,
  PropertyId,
  PropertyResult,
  RunSummary,
  Verdict,
} from './types.ts';
