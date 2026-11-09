/**
 * Errors the harness raises on purpose, each mapped to an exit code in `bin.ts`.
 *
 * `ConfigError` means an input file or flag is wrong: the harness refuses to
 * guess. `PinMismatchError` means a fetched repository is not at the commit the
 * corpus pins: the harness refuses to measure something other than what it
 * claims to measure.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class PinMismatchError extends Error {
  readonly repo: string;
  readonly expected: string;
  readonly actual: string;

  constructor(repo: string, expected: string, actual: string) {
    super(
      `${repo}: the checkout is at ${actual} but the corpus pins ${expected}. ` +
        'Refusing to evaluate a different commit than the one pinned. ' +
        'Run `pnpm eval fetch` to restore the pin.',
    );
    this.name = 'PinMismatchError';
    this.repo = repo;
    this.expected = expected;
    this.actual = actual;
  }
}

/** The cached checkout has local changes, so it is not the pinned tree. */
export class DirtyCheckoutError extends Error {
  readonly repo: string;

  constructor(repo: string, sample: readonly string[]) {
    super(
      `${repo}: the cached checkout has local changes (${sample.slice(0, 3).join(', ')}). ` +
        'Refusing to evaluate a tree that is not the pinned commit. ' +
        'Run `pnpm eval fetch` to restore it.',
    );
    this.name = 'DirtyCheckoutError';
    this.repo = repo;
  }
}

/** The cached checkout was not made with the harness's attribute guard (an older or foreign clone). */
export class UnguardedCheckoutError extends Error {
  readonly repo: string;

  constructor(repo: string) {
    super(
      `${repo}: the cached checkout was not made by this harness (no attribute guard), so its files may ` +
        'have been converted or filtered. Refusing to evaluate it. ' +
        'Run `pnpm eval fetch` to rebuild it.',
    );
    this.name = 'UnguardedCheckoutError';
    this.repo = repo;
  }
}
