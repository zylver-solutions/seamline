/**
 * The shape of a run id under `SEAMLINE_DETERMINISTIC=1`.
 *
 * A leaf module with no imports, so both the clock (`io.ts`) and the code that
 * computes the digest (`run-inputs.ts`) can depend on it without a cycle.
 *
 * ## What a deterministic run id is
 *
 * `run-det-<16 lowercase hex digits>`: the first 64 bits of the SHA-256 digest
 * of the run's inputs (`run-inputs.ts` says exactly which). It is a function of
 * those inputs and of nothing else, so two runs over the same tree, the same
 * effective config and the same extractor versions get the same id and the same
 * bytes (v3 §2.3, ADR-0009), and runs over different inputs get different ids.
 *
 * ## What it is not: an ordering
 *
 * The id says which inputs a run saw. It says nothing about when the run
 * happened relative to another run, and it must never be compared with `<` to
 * find out. The store orders runs by its own insertion sequence (`runs.seq`),
 * tombstones by equality with the finalizing run's id, and `started_at` is
 * frozen to a constant in this mode, so none of them consults the id's value.
 * The pure merge layer's `compareRuns` (`@seamline/core`'s `merge/lifecycle.ts`)
 * does compare ids as strings; it needs ids that sort chronologically, which a
 * digest does not, so it is for callers that bring their own ordered ids.
 *
 * ## Same id twice
 *
 * The same inputs run again into one store give the same id. That is a retry of
 * one run, not a successor to it: the store re-opens the existing run (see
 * `SqliteStore.restartRun`) and the second pass is idempotent.
 */

/** Prefix that marks a run id as derived from run inputs. */
export const DETERMINISTIC_RUN_ID_PREFIX = 'run-det-';

/** How many hex digits of the inputs digest the id keeps. */
export const DETERMINISTIC_RUN_ID_DIGITS = 16;

/** A SHA-256 digest as `run-inputs.ts` returns it. */
const INPUTS_DIGEST = /^[0-9a-f]{64}$/;

/** Matches exactly the ids `deterministicRunId` produces. */
export const DETERMINISTIC_RUN_ID_PATTERN = /^run-det-[0-9a-f]{16}$/;

/** The run id for a run whose inputs hash to `inputsDigest` (64 lowercase hex digits). */
export function deterministicRunId(inputsDigest: string): string {
  if (!INPUTS_DIGEST.test(inputsDigest)) {
    throw new Error(
      'a deterministic run id is derived from a SHA-256 run-inputs digest (64 lowercase hex digits)',
    );
  }
  return `${DETERMINISTIC_RUN_ID_PREFIX}${inputsDigest.slice(0, DETERMINISTIC_RUN_ID_DIGITS)}`;
}
