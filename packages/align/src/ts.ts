/**
 * The TypeScript parser, loaded the way `@seamline/extract-contracts` loads it:
 * `typescript` is an optional peer dependency, so a plain install of the CLI
 * does not pull it in. The syntax-only probes (output formats, detector
 * liveness) need it. Without it, or with a version outside the supported
 * range, they answer `UNKNOWN(probe-failed)` and say why; a missing parser is
 * never a missing fact (AGENTS.md invariant 3).
 *
 * The runtime value comes from `loadParser()`; the `import type` below is
 * erased at compile time.
 */

import type * as TS from 'typescript';

export type TsModule = typeof TS;
export type { TS };

/** The `typescript` versions the probes are written against: the peer range in this package's manifest. */
export const SUPPORTED_TYPESCRIPT_RANGE = '^6.0.3';

export const TYPESCRIPT_MISSING = 'the optional typescript peer dependency is not installed';

/**
 * The parser the probes may use, or the reason they have none. Exactly one of
 * the two is non-null. A parser that cannot be used is a missing parser: the
 * probes answer `UNKNOWN(probe-failed)` with `unavailable` as the detail.
 */
export type Parser =
  | { readonly ts: TsModule; readonly unavailable: null }
  | { readonly ts: null; readonly unavailable: string };

/** Members of the compiler API that the probes call. A module without one of them cannot run them. */
const REQUIRED_FUNCTIONS = ['createSourceFile', 'forEachChild', 'isIdentifier', 'isStringLiteral'];
const REQUIRED_TABLES = ['ScriptTarget', 'SyntaxKind'];

/** A version an installed module reports about itself, kept only when it is a plain semver string. */
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-[0-9A-Za-z.-]{1,40})?$/;

/** Whether `major.minor.patch` satisfies `SUPPORTED_TYPESCRIPT_RANGE`. */
function inSupportedRange(major: number, minor: number, patch: number): boolean {
  return major === 6 && (minor > 0 || patch >= 3);
}

/**
 * Decide whether a loaded module is a parser the probes can use. Total: any
 * value in, a `Parser` out, never a throw. `null` or `undefined` is the absent
 * peer; a module whose version is outside the supported range, or that lacks a
 * member the probes call, is refused with a reason that names what was found
 * and the supported range.
 */
export function resolveParser(candidate: unknown): Parser {
  if (candidate === null || candidate === undefined)
    return { ts: null, unavailable: TYPESCRIPT_MISSING };
  const mod = (typeof candidate === 'object' ? candidate : {}) as Record<string, unknown>;
  const reported = mod['version'];
  const version = typeof reported === 'string' ? VERSION.exec(reported) : null;
  if (version === null) {
    return {
      ts: null,
      unavailable: `the installed typescript reports no recognisable version; the supported range is ${SUPPORTED_TYPESCRIPT_RANGE}`,
    };
  }
  const found = version[0];
  if (!inSupportedRange(Number(version[1]), Number(version[2]), Number(version[3]))) {
    return {
      ts: null,
      unavailable: `the installed typescript ${found} is outside the supported range ${SUPPORTED_TYPESCRIPT_RANGE}`,
    };
  }
  const missing =
    REQUIRED_FUNCTIONS.find((name) => typeof mod[name] !== 'function') ??
    REQUIRED_TABLES.find((name) => typeof mod[name] !== 'object' || mod[name] === null);
  if (missing !== undefined) {
    return {
      ts: null,
      unavailable: `the installed typescript ${found} lacks the parser API the probes need (${missing}); the supported range is ${SUPPORTED_TYPESCRIPT_RANGE}`,
    };
  }
  return { ts: candidate as TsModule, unavailable: null };
}

/**
 * `typescript`, loaded once when this module is first imported (a literal `import()`, so the
 * module graph shows it, and a failure is the same `null` as an absent peer). Never throws.
 */
const loaded: Parser = resolveParser(
  await import('typescript').then(
    (mod) => (mod as unknown as { default?: unknown }).default ?? mod,
    () => null,
  ),
);

/** The installed parser, or the reason there is none the probes can use. */
export function loadParser(): Parser {
  return loaded;
}

/** The installed parser, or `null` when the probes cannot use what is installed. */
export function loadTs(): TsModule | null {
  return loaded.ts;
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
