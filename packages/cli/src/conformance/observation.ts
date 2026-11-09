/**
 * What the conformance wrapper is configured with and what it reports back.
 *
 * These live apart from `wrapper.ts` on purpose. The wrapper is a program the sandbox child loads
 * by path, and it imports the extractor under test with a runtime-computed specifier; nothing may
 * import it, so that the module graph that is traced statically never reaches that import. The
 * suite, which runs in the CLI process, takes the shared names from here.
 */

/** The reserved key in `ctx.options` that carries the wrapper's configuration. It is removed before the extractor sees the options. */
export const WRAPPER_KEY = '__seamlineConformance';
/** What the diagnostic line carrying the tally starts with. */
export const OBSERVED_PREFIX = 'seamline-conformance-observed ';

export interface WrapperConfig {
  /** Absolute path of the extractor's module. */
  readonly target: string;
  /** The extractor's declared `reads` globs. */
  readonly reads: ReadonlyArray<string>;
  /** Fail every open of a repository file with EACCES. */
  readonly unreadable: boolean;
}

export interface WrapperObservation {
  /** Distinct repository files opened for reading. */
  readonly opened: number;
  /** Of those, up to five that no declared glob admits. */
  readonly undeclared: ReadonlyArray<string>;
  /** Opens that were made to fail. */
  readonly faultsHit: number;
  /** Distinct repository files opened under the stress directory, and under the bait directory. */
  readonly stressOpened: number;
  readonly baitOpened: number;
  /** Distinct in-repo paths (files or directories) no declared glob admits that it stat'ed, checked or accessed. */
  readonly looked: number;
  /** Up to five of them, sorted. */
  readonly lookedAt: ReadonlyArray<string>;
  /** Distinct directories inside the repo it listed. */
  readonly listed: number;
}
