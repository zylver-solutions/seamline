/**
 * The TypeScript parser, loaded the way `@seamline/extract-contracts` loads it:
 * `typescript` is an optional peer dependency, so a plain install of the CLI
 * does not pull it in. The syntax-only probes (output formats, detector
 * liveness, control wiring) need it. Without it they answer
 * `UNKNOWN(probe-failed)` and say why; a missing parser is never a missing
 * fact (AGENTS.md invariant 3).
 *
 * The runtime value comes from `loadTs()`; the `import type` below is erased
 * at compile time.
 */

import type * as TS from 'typescript';

export type TsModule = typeof TS;
export type { TS };

export const TYPESCRIPT_MISSING = 'the optional typescript peer dependency is not installed';

/**
 * `typescript`, loaded once when this module is first imported (a literal `import()`, so the
 * module graph shows it, and a failure is the same `null` as an absent peer). Never throws.
 */
const loaded: TsModule | null = await import('typescript').then(
  (mod) => (mod as unknown as { default?: TsModule }).default ?? (mod as unknown as TsModule),
  () => null,
);

/** The parser, or `null` when the optional peer dependency is not installed. */
export function loadTs(): TsModule | null {
  return loaded;
}

/**
 * Syntactic diagnostics of a parsed source file. `ts.createSourceFile` never
 * throws, so "cannot be parsed" means "the parser reported a diagnostic". The
 * list is an internal field of the source file; when a future compiler removes
 * it this returns `undefined`, and callers treat that as "cannot tell", which
 * is the fail-closed answer.
 */
export function parseDiagnosticCount(sourceFile: TS.SourceFile): number | undefined {
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
  return Array.isArray(diagnostics) ? diagnostics.length : undefined;
}
