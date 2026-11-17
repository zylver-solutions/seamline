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

export type { TS };

/**
 * Every function of the compiler API that the probes call. `TsModule` is built from this list, so
 * a probe that calls a function missing from it does not typecheck, and `resolveParser` refuses a
 * module that lacks one of them before any probe runs.
 */
export const PARSER_FUNCTIONS = [
  'createSourceFile',
  'forEachChild',
  'isArrayLiteralExpression',
  'isAsExpression',
  'isBinaryExpression',
  'isCallExpression',
  'isCaseClause',
  'isElementAccessExpression',
  'isExportDeclaration',
  'isExternalModuleReference',
  'isGetAccessorDeclaration',
  'isIdentifier',
  'isImportDeclaration',
  'isImportEqualsDeclaration',
  'isImportTypeNode',
  'isLiteralTypeNode',
  'isMethodDeclaration',
  'isMethodSignature',
  'isNamedImports',
  'isNoSubstitutionTemplateLiteral',
  'isParenthesizedExpression',
  'isPrivateIdentifier',
  'isPropertyAccessExpression',
  'isPropertyAssignment',
  'isPropertyDeclaration',
  'isPropertySignature',
  'isSatisfiesExpression',
  'isSetAccessorDeclaration',
  'isStringLiteral',
  'isVariableStatement',
] as const;

/** Every member of `SyntaxKind` that the probes compare against. Typed and checked like the functions. */
export const PARSER_SYNTAX_KINDS = [
  'BarBarToken',
  'EqualsEqualsEqualsToken',
  'EqualsEqualsToken',
  'ExclamationEqualsEqualsToken',
  'ExclamationEqualsToken',
  'ExportKeyword',
  'ImportKeyword',
] as const;

/** The part of the `typescript` module the probes may use: exactly the members listed above. */
export type TsModule = Pick<typeof TS, (typeof PARSER_FUNCTIONS)[number]> & {
  readonly ScriptTarget: Pick<typeof TS.ScriptTarget, 'Latest'>;
  readonly SyntaxKind: Pick<typeof TS.SyntaxKind, (typeof PARSER_SYNTAX_KINDS)[number]>;
};

/**
 * The `typescript` versions the probes are written against: the peer range in this package's
 * manifest. It is read as npm reads it, so a prerelease or nightly build (`6.0.3-rc`,
 * `6.1.0-beta`, `6.1.0-dev.20261101`) is outside it whatever its base version.
 */
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

/** A version an installed module reports about itself, kept only when it is a plain semver string. */
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]{1,40})?$/;

/** A caret range with a major of at least 1: `^M.m.p` admits `M.x.y` at or above `M.m.p`. */
const CARET_RANGE = /^\^([1-9]\d{0,5})\.(\d{1,6})\.(\d{1,6})$/;

/**
 * Whether a release version satisfies a caret range. The bounds are read from the range string, so
 * the range has one definition. A range of any other form admits nothing.
 */
function satisfiesCaret(range: string, major: number, minor: number, patch: number): boolean {
  const floor = CARET_RANGE.exec(range);
  if (floor === null) return false;
  if (major !== Number(floor[1])) return false;
  const floorMinor = Number(floor[2]);
  return minor > floorMinor || (minor === floorMinor && patch >= Number(floor[3]));
}

/**
 * One line of an error for a report: its first line, with absolute paths removed (a packet carries
 * no absolute path and no machine name) and a bounded length.
 */
export function faultText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line = (raw.split('\n')[0] ?? '')
    .replace(/(?:file:\/\/)?(?:[A-Za-z]:)?[\\/][^\s'"`()]*/g, '<path>')
    .trim();
  return line.length > 200 ? `${line.slice(0, 200)}...` : line || 'no message';
}

/** The first member of the lists above that `mod` does not have, or `null`. */
function missingMember(mod: Record<string, unknown>): string | null {
  for (const name of PARSER_FUNCTIONS) if (typeof mod[name] !== 'function') return name;
  const table = (name: string): Record<string, unknown> => {
    const value = mod[name];
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  };
  if (typeof table('ScriptTarget')['Latest'] !== 'number') return 'ScriptTarget.Latest';
  for (const kind of PARSER_SYNTAX_KINDS)
    if (typeof table('SyntaxKind')[kind] !== 'number') return `SyntaxKind.${kind}`;
  return null;
}

/**
 * Decide whether a loaded module is a parser the probes can use. Total: any
 * value in, a `Parser` out, never a throw. `null` or `undefined` is the absent
 * peer; a module whose version is outside the supported range, or that lacks a
 * member the probes call, is refused with a reason that names what was found
 * and the supported range.
 */
export function resolveParser(
  candidate: unknown,
  range: string = SUPPORTED_TYPESCRIPT_RANGE,
): Parser {
  if (candidate === null || candidate === undefined)
    return { ts: null, unavailable: TYPESCRIPT_MISSING };
  try {
    const mod = (typeof candidate === 'object' ? candidate : {}) as Record<string, unknown>;
    const reported = mod['version'];
    const version = typeof reported === 'string' ? VERSION.exec(reported) : null;
    if (version === null) {
      return {
        ts: null,
        unavailable: `the installed typescript reports no recognisable version; the supported range is ${range}`,
      };
    }
    const found = version[0];
    const outside = `the installed typescript ${found} is outside the supported range ${range}`;
    if (version[4] !== undefined) {
      return { ts: null, unavailable: `${outside} (a prerelease or nightly build is not in it)` };
    }
    if (!satisfiesCaret(range, Number(version[1]), Number(version[2]), Number(version[3])))
      return { ts: null, unavailable: outside };
    const missing = missingMember(mod);
    if (missing !== null) {
      return {
        ts: null,
        unavailable: `the installed typescript ${found} lacks the parser API the probes need (${missing}); the supported range is ${range}`,
      };
    }
    return { ts: candidate as TsModule, unavailable: null };
  } catch (error) {
    return {
      ts: null,
      unavailable: `the installed typescript could not be inspected: ${faultText(error)}`,
    };
  }
}

/**
 * The parser state for an `import('typescript')` that rejected. Only "the package `typescript`
 * was not found" is the absent peer; any other rejection is an installed module that failed to
 * load, and the reason says so.
 */
export function parserLoadFailure(error: unknown): Parser {
  const notFound =
    (error as { code?: unknown } | null)?.code === 'ERR_MODULE_NOT_FOUND' &&
    /Cannot find (?:package|module) 'typescript'/.test(error instanceof Error ? error.message : '');
  return {
    ts: null,
    unavailable: notFound
      ? TYPESCRIPT_MISSING
      : `the installed typescript failed to load: ${faultText(error)}`,
  };
}

/**
 * `typescript`, loaded once when this module is first imported (a literal `import()`, so the
 * module graph shows it). Never throws.
 */
const loaded: Parser = await import('typescript').then(
  (mod) => resolveParser((mod as unknown as { default?: unknown }).default ?? mod),
  parserLoadFailure,
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
