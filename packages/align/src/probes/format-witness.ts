/**
 * Probe `format-witness` v2 (design 4.2, 5.4): does the CLI render an output
 * format at all? Completeness `absence-sound`: `ABSENT` is conclusive over the
 * sources it reads; `HOLDS` is a presence witness only (a word in an
 * identifier, a property name, a compared string, or the name of a file, a
 * directory or a dependency).
 *
 * The scan set is every package with a `bin` plus the transitive closure of
 * the workspace packages they list, less the instrument. Each token kept is
 * deliberately narrow (see `formatTokens`): a name that only sits in a list is
 * not evidence of support.
 */

import { INSTRUMENT_PACKAGE, codeScopeGate, memo, type ProbeEnv } from '../env.ts';
import { lineOf, moduleSpecifiers, parseSource } from '../source.ts';
import { TYPESCRIPT_MISSING, type TS } from '../ts.ts';
import { absent, holds, unknownFact, type FactSource, type ProbeFact } from '../types.ts';
import { compareCodeUnits, dirname, joinPosix } from '../util.ts';
import {
  dependencyLinks,
  dependencyNames,
  entryPoints,
  hasBin,
  isDeclarationFile,
  isTestPath,
  otherLanguageReason,
  sourceFilesOf,
  strayManifests,
  trackedFilesOf,
  tsconfigDeclaringPaths,
  tsconfigOf,
  type Pkg,
} from '../workspace.ts';

/**
 * Split a kept token into lower-case words (4.2 step 4). A boundary falls at
 * every `_`, `-`, `.` and `/`; between a lower-case letter or a digit and the
 * upper-case letter that follows it (`renderCsv` gives `render`, `csv`); and
 * inside a run of upper-case letters, before its last letter when a lower-case
 * letter follows that letter (`CSVWriter` gives `csv`, `writer`). The rule is
 * lexical: `CSVs` gives `cs`, `vs`.
 */
export function wordsOf(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, '$1\u0000$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\u0000$2')
    .split(/[\u0000_\-./]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w !== '');
}

const COMPARISON_OPERATORS = (ts: NonNullable<ProbeEnv['ts']>): ReadonlySet<TS.SyntaxKind> =>
  new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
  ]);

/**
 * The tokens a source file contributes (4.2 step 4), each with the line it was
 * first seen on: every identifier; every string literal used as a property
 * name; every string literal (or template literal without substitutions) that
 * is an operand of `===`, `!==`, `==` or `!=`, or the expression of a `case`
 * clause. Nothing else: a string in an array or `Set` literal, an argument of a
 * call, a message, a map value or a string-literal type is not a witness.
 */
export function formatTokens(
  ts: NonNullable<ProbeEnv['ts']>,
  sf: TS.SourceFile,
): Map<string, number> {
  const words = new Map<string, number>();
  const operators = COMPARISON_OPERATORS(ts);
  const add = (text: string, node: TS.Node): void => {
    for (const word of wordsOf(text)) if (!words.has(word)) words.set(word, lineOf(sf, node));
  };
  const isPropertyName = (node: TS.StringLiteral | TS.NoSubstitutionTemplateLiteral): boolean => {
    const parent = node.parent;
    if (
      (ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent)) &&
      parent.name === node
    ) {
      return true;
    }
    return ts.isElementAccessExpression(parent) && parent.argumentExpression === node;
  };
  const visit = (node: TS.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      add(node.text, node);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const compared = ts.isBinaryExpression(parent) && operators.has(parent.operatorToken.kind);
      const cased = ts.isCaseClause(parent) && parent.expression === node;
      if (compared || cased || isPropertyName(node)) add(node.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return words;
}

/** Who supplied a word: a kept token, or a name. Tokens are reported over names; within each, the first in path order. */
interface Supplier {
  /** Sort key: the path, or the dependency name. */
  readonly key: string;
  readonly describe: string;
  readonly source: FactSource | null;
}

interface FormatScan {
  readonly scanSet: readonly Pkg[];
  readonly tokens: ReadonlyMap<string, Supplier>;
  readonly names: ReadonlyMap<string, Supplier>;
  readonly dependencies: ReadonlyMap<string, Supplier>;
  /** First reason the scan is not complete, per reason class. */
  readonly unreadable: string | null;
  readonly limit: string | null;
  readonly scannedFiles: number;
}

function buildScan(
  env: ProbeEnv,
  ts: NonNullable<ProbeEnv['ts']>,
  roots: readonly Pkg[],
): FormatScan {
  const byName = new Map(env.discovery.packages.map((p) => [p.name, p] as const));
  let unreadable: string | null = null;
  let limit: string | null = null;

  // The closure of the workspace packages the roots list, followed by key, by alias and by path (step 3).
  const seen = new Set<string>();
  const queue: Pkg[] = [...roots];
  while (queue.length > 0) {
    const pkg = queue.shift();
    if (pkg === undefined || seen.has(pkg.name) || pkg.name === INSTRUMENT_PACKAGE) continue;
    seen.add(pkg.name);
    for (const link of dependencyLinks(env.discovery, pkg, true)) {
      if (
        link.problem !== null &&
        link.key !== INSTRUMENT_PACKAGE &&
        !link.problem.includes(INSTRUMENT_PACKAGE)
      ) {
        unreadable ??= link.problem;
      }
      for (const target of link.targets) queue.push(target);
    }
  }
  const scanSet = [...seen]
    .sort(compareCodeUnits)
    .map((n) => byName.get(n))
    .filter((p): p is Pkg => p !== undefined);
  const scanSetNames = new Set(scanSet.map((p) => p.name));

  const tokens = new Map<string, Supplier>();
  const names = new Map<string, Supplier>();
  const dependencies = new Map<string, Supplier>();
  const put = (map: Map<string, Supplier>, word: string, supplier: Supplier): void => {
    const current = map.get(word);
    if (current === undefined || compareCodeUnits(supplier.key, current.key) < 0)
      map.set(word, supplier);
  };
  let scannedFiles = 0;

  for (const pkg of scanSet) {
    const missing = entryPoints(env.tree, pkg).unmapped;
    if (missing.length > 0) unreadable ??= `${pkg.name}: an entry point cannot be mapped: ${missing[0]}`;
    // Names: directories and file names below the package, and the dependency names it declares.
    const { outDir } = tsconfigOf(env.tree, pkg.dir);
    const outPrefix = pkg.dir === '.' ? `${outDir}/` : `${pkg.dir}/${outDir}/`;
    const prefix = pkg.dir === '.' ? '' : `${pkg.dir}/`;
    for (const path of trackedFilesOf(env.discovery, env.tree, pkg)) {
      if (
        isDeclarationFile(path) ||
        isTestPath(path) ||
        path.includes('node_modules/') ||
        path.startsWith(outPrefix)
      )
        continue;
      const parts = path.slice(prefix.length).split('/');
      const file = parts.pop() ?? '';
      const stem =
        file.includes('.') && !file.startsWith('.') ? file.slice(0, file.lastIndexOf('.')) : file;
      for (const part of [...parts, stem]) {
        for (const word of wordsOf(part))
          put(names, word, { key: path, describe: path, source: null });
      }
    }
    for (const dep of dependencyNames(pkg, true)) {
      for (const word of wordsOf(dep.replace(/^@/, ''))) {
        put(dependencies, word, { key: dep, describe: `dependency ${dep}`, source: null });
      }
    }

    // The scan set must not leave itself: a path alias leads where this probe cannot see.
    for (const dir of new Set(['.', pkg.dir])) {
      const reason = tsconfigDeclaringPaths(env.tree, dir);
      if (reason !== null) unreadable ??= `${reason}, so an import may lead outside the scan set`;
    }
    const other = otherLanguageReason(env.tree, env.discovery, pkg);
    if (other !== null) unreadable ??= other;

    for (const path of sourceFilesOf(env.tree, env.discovery, pkg)) {
      if (scannedFiles >= env.limits.maxSourceFiles) {
        limit ??= `more than ${env.limits.maxSourceFiles} source files in the scan set`;
        break;
      }
      scannedFiles += 1;
      const parsed = parseSource(env, path);
      if (parsed.status === 'too-large') {
        limit ??= parsed.detail;
        continue;
      }
      if (parsed.status === 'unreadable') {
        unreadable ??= parsed.detail;
        continue;
      }
      for (const [word, line] of formatTokens(ts, parsed.sf)) {
        put(tokens, word, {
          key: path,
          describe: path,
          source: { path, lineStart: line, lineEnd: line },
        });
      }
      for (const specifier of moduleSpecifiers(ts, parsed.sf)) {
        if (specifier.startsWith('.')) {
          const resolved = joinPosix(dirname(path), specifier);
          const inside =
            pkg.dir === '.' ? !resolved.startsWith('..') : resolved.startsWith(`${pkg.dir}/`);
          if (!inside)
            unreadable ??= `${path} imports ${specifier}, which leaves ${pkg.dir === '.' ? 'the repository' : pkg.dir}`;
        } else if (!specifier.startsWith('/') && !specifier.startsWith('node:')) {
          const name = specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : (specifier.split('/')[0] ?? '');
          if (byName.has(name) && !scanSetNames.has(name) && name !== INSTRUMENT_PACKAGE) {
            unreadable ??= `${path} imports the workspace package ${name}, which is not in the scan set`;
          }
        }
      }
    }
  }
  return { scanSet, tokens, names, dependencies, unreadable, limit, scannedFiles };
}

export function probeFormatWitness(env: ProbeEnv, format: string): ProbeFact {
  const gate = codeScopeGate(env);
  if (gate !== null) return gate;
  if (env.ts === null) return unknownFact('probe-failed', TYPESCRIPT_MISSING);
  const ts = env.ts;

  const roots = env.discovery.packages.filter((p) => hasBin(p) && p.name !== INSTRUMENT_PACKAGE);
  const stray = memo(env, 'stray-manifests', () => strayManifests(env.tree, env.discovery));
  // A tracked manifest with a bin that no discovery reached may be the CLI a document describes (way 5).
  const strayBin =
    stray.withBin.length > 0
      ? `${stray.withBin[0]} declares a bin but is neither the root nor a discovered package, so the CLI it describes was not scanned`
      : null;
  const strayBroken =
    stray.unparseable.length > 0
      ? `${stray.unparseable[0]} does not parse and is neither the root nor a discovered package; it might be a bin package`
      : null;

  const scan =
    roots.length === 0 ? null : memo(env, 'format-scan', () => buildScan(env, ts, roots));
  if (scan !== null) {
    const token = scan.tokens.get(format);
    if (token !== undefined) {
      return holds(
        true,
        `token ${token.describe}`,
        token.source === null ? {} : { source: token.source },
      );
    }
    const name = scan.names.get(format);
    if (name !== undefined) return holds(true, `name ${name.describe}`);
    const dependency = scan.dependencies.get(format);
    if (dependency !== undefined) return holds(true, `name ${dependency.describe}`);
  }

  // Not witnessed. Absence needs a complete scan; the reasons are tried in a fixed order.
  if (scan === null) {
    // No root: incomplete discovery may hide the bin package, then a stray manifest may be it.
    if (env.discovery.incomplete) {
      return unknownFact(
        'manifest-unparseable',
        `no package with a bin was found, and package discovery is incomplete: ${env.discovery.incompleteDetail}`,
      );
    }
    if (strayBin !== null) return unknownFact('source-unreadable', strayBin);
    if (strayBroken !== null) return unknownFact('manifest-unparseable', strayBroken);
    return unknownFact(
      'no-source-roots',
      'no workspace package declares a bin, so there is no CLI to scan',
    );
  }
  if (scan.unreadable !== null) return unknownFact('source-unreadable', scan.unreadable);
  if (strayBin !== null) return unknownFact('source-unreadable', strayBin);
  if (scan.limit !== null) return unknownFact('limit-exceeded', scan.limit);
  if (env.discovery.incomplete) {
    return unknownFact(
      'manifest-unparseable',
      `package discovery is incomplete: ${env.discovery.incompleteDetail}`,
    );
  }
  if (strayBroken !== null) return unknownFact('manifest-unparseable', strayBroken);
  return {
    ...absent(
      `no kept token or name in the scan set (${scan.scanSet.map((p) => p.name).join(', ')}; ${scan.scannedFiles} source files) carries the word ${format}`,
    ),
    observed: false,
  };
}

/** Exposed for the packet: the packages the probe scanned, or `null` when it did not run a scan. */
export function formatScanSet(env: ProbeEnv): readonly string[] | null {
  const cached = env.cache.get('format-scan') as FormatScan | undefined;
  return cached === undefined ? null : cached.scanSet.map((p) => p.name);
}
