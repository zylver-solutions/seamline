/**
 * The two failures `seamline align` can end in. Neither depends on what drift
 * was found: a usage error is exit 2 and a runtime error is exit 3 in the CLI.
 * Drift itself never produces an error.
 */

export type AlignErrorKind = 'usage' | 'runtime';

export class AlignError extends Error {
  readonly kind: AlignErrorKind;
  readonly hint: string | undefined;

  constructor(kind: AlignErrorKind, message: string, hint?: string) {
    super(message);
    this.name = 'AlignError';
    this.kind = kind;
    this.hint = hint;
  }
}

export function usageFailure(message: string, hint?: string): AlignError {
  return new AlignError('usage', message, hint);
}

export function runtimeFailure(message: string, hint?: string): AlignError {
  return new AlignError('runtime', message, hint);
}
