/**
 * Probe `detector-liveness` v2 (design 4.3, 5.4): is a detector dormant because
 * no scope of the run produces a node kind it reads? Completeness
 * `absence-sound under the read model, the run and the extractor packages of
 * the tree`. The level is node kinds: dormancy for property-level reasons is
 * not visible here and is not reported, and the packet says so.
 *
 * A required scope that is not declared or not `PASS` is `Unknown`, never
 * dormancy, and so is a kind that an extractor package of the tree names but
 * the run did not produce.
 */

import { memo, type ProbeEnv } from '../env.ts';
import { lineOf, literalText, parseSource } from '../source.ts';
import { TYPESCRIPT_MISSING, type TS } from '../ts.ts';
import { absent, holds, unknownFact, type FactSource, type ProbeFact } from '../types.ts';
import { compareCodeUnits, dirname, joinPosix } from '../util.ts';
import { entryPoints, otherLanguageReason, sourceFilesOf, type Pkg } from '../workspace.ts';

export const DETECTOR_REGISTRY_PATH = 'packages/contradictions/src/detectors/index.ts';
const VOCABULARY_PACKAGE = '@seamline/ontology';

export interface DetectorInfo {
  readonly code: string;
  readonly file: string;
  readonly codeLine: number;
  /** Resolved required scopes, or `null` when any element does not resolve. */
  readonly requiredScopes: readonly string[] | null;
  /** Read groups: every group is required, any member suffices. */
  readonly groups: readonly (readonly string[])[];
  /** True when a read's kind is not a string literal. */
  readonly readsIncomplete: boolean;
}

function unwrap(ts: NonNullable<ProbeEnv['ts']>, node: TS.Expression): TS.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Resolve an identifier imported from a relative module that exports it as a `const` string literal. */
function resolveScopeConstant(
  env: ProbeEnv,
  ts: NonNullable<ProbeEnv['ts']>,
  file: string,
  sf: TS.SourceFile,
  name: string,
): string | null {
  let target: { specifier: string; exported: string } | null = null;
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.namedBindings === undefined)
      continue;
    const bindings = statement.importClause.namedBindings;
    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.name.text === name && ts.isStringLiteral(statement.moduleSpecifier)) {
        target = {
          specifier: statement.moduleSpecifier.text,
          exported: (element.propertyName ?? element.name).text,
        };
      }
    }
  }
  if (target === null || !target.specifier.startsWith('.')) return null;
  const base = joinPosix(dirname(file), target.specifier);
  const candidates = /\.[cm]?[jt]sx?$/.test(base) ? [base] : [`${base}.ts`, `${base}/index.ts`];
  for (const candidate of candidates) {
    if (!env.tree.tracked.includes(candidate)) continue;
    const parsed = parseSource(env, candidate);
    if (parsed.status !== 'ok') return null;
    for (const statement of parsed.sf.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === target.exported &&
          declaration.initializer !== undefined
        ) {
          return literalText(ts, unwrap(ts, declaration.initializer));
        }
      }
    }
  }
  return null;
}

/** Analyse one detector file: its code, required scopes and read model (4.3 steps 1 to 3). */
export function analyseDetector(
  env: ProbeEnv,
  ts: NonNullable<ProbeEnv['ts']>,
  file: string,
): DetectorInfo | null {
  const parsed = parseSource(env, file);
  if (parsed.status !== 'ok') return null;
  const sf = parsed.sf;
  let code: string | null = null;
  let codeLine = 1;
  let requiredScopes: string[] | null = null;
  let scopesFound = false;
  let scopesBroken = false;

  const visitProperties = (node: TS.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === 'code' && code === null) {
        const text = literalText(ts, node.initializer);
        const m = text === null ? null : /^X\d+/.exec(text);
        if (m !== null) {
          code = m[0];
          codeLine = lineOf(sf, node);
        }
      } else if (
        node.name.text === 'requiredScopes' &&
        !scopesFound &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        scopesFound = true;
        requiredScopes = [];
        for (const element of node.initializer.elements) {
          const literal = literalText(ts, element);
          if (literal !== null) requiredScopes.push(literal);
          else if (ts.isIdentifier(element)) {
            const resolved = resolveScopeConstant(env, ts, file, sf, element.text);
            if (resolved === null) scopesBroken = true;
            else requiredScopes.push(resolved);
          } else scopesBroken = true;
        }
      }
    }
    ts.forEachChild(node, visitProperties);
  };
  visitProperties(sf);
  if (code === null) return null;

  // Reads: every call named factNodes (kind in the second argument) or nodesByKind (kind in the first).
  interface Read {
    readonly node: TS.CallExpression;
    readonly kind: string;
  }
  const reads: Read[] = [];
  let readsIncomplete = false;
  const collect = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (callee === 'factNodes' || callee === 'nodesByKind') {
        const kind = literalText(
          ts,
          callee === 'factNodes' ? node.arguments[1] : node.arguments[0],
        );
        if (kind === null) readsIncomplete = true;
        else reads.push({ node, kind });
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const isOr = (node: TS.Node): node is TS.BinaryExpression =>
    ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken;
  const hasOrAncestor = (node: TS.Node): boolean => {
    for (let p: TS.Node | undefined = node.parent; p !== undefined; p = p.parent)
      if (isOr(p)) return true;
    return false;
  };
  const operandsOf = (node: TS.Expression, acc: TS.Expression[] = []): TS.Expression[] => {
    const inner = unwrap(ts, node);
    if (isOr(inner)) {
      operandsOf(inner.left, acc);
      operandsOf(inner.right, acc);
    } else acc.push(inner);
    return acc;
  };
  const readsWithin = (node: TS.Node): Read[] =>
    reads.filter((r) => r.node.pos >= node.pos && r.node.end <= node.end);

  const inChain = new Set<Read>();
  const groups: string[][] = [];
  const findChains = (node: TS.Node): void => {
    if (isOr(node) && !hasOrAncestor(node)) {
      const within = readsWithin(node);
      for (const r of within) inChain.add(r);
      if (
        within.length > 0 &&
        operandsOf(node).every((operand) => readsWithin(operand).length > 0)
      ) {
        groups.push([...new Set(within.map((r) => r.kind))].sort(compareCodeUnits));
      }
      // Reads of a chain with a read-less operand are optional and join no group.
    }
    ts.forEachChild(node, findChains);
  };
  findChains(sf);
  for (const r of reads) if (!inChain.has(r)) groups.push([r.kind]);

  const unique = new Map<string, string[]>();
  for (const g of groups) unique.set(g.join('|'), g);
  return {
    code,
    file,
    codeLine,
    requiredScopes: scopesFound && !scopesBroken ? requiredScopes : null,
    groups: [...unique.values()],
    readsIncomplete,
  };
}

/** Load the registry (`ALL_DETECTORS`) and each detector's analysis (4.3 step 1). */
export function loadDetectors(env: ProbeEnv): Map<string, DetectorInfo> {
  return memo(env, 'detectors', () => {
    const out = new Map<string, DetectorInfo>();
    const ts = env.ts;
    if (ts === null || !env.tree.tracked.includes(DETECTOR_REGISTRY_PATH)) return out;
    const index = parseSource(env, DETECTOR_REGISTRY_PATH);
    if (index.status !== 'ok') return out;
    const imports = new Map<string, string>();
    let elements: string[] = [];
    for (const statement of index.sf.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        for (const el of statement.importClause.namedBindings.elements)
          imports.set(el.name.text, statement.moduleSpecifier.text);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === 'ALL_DETECTORS' &&
            declaration.initializer !== undefined
          ) {
            const init = unwrap(ts, declaration.initializer);
            if (ts.isArrayLiteralExpression(init)) {
              elements = init.elements
                .filter((e): e is TS.Identifier => ts.isIdentifier(e))
                .map((e) => e.text);
            }
          }
        }
      }
    }
    for (const name of elements) {
      const specifier = imports.get(name);
      if (specifier === undefined || !specifier.startsWith('.')) continue;
      const file = joinPosix(dirname(DETECTOR_REGISTRY_PATH), specifier);
      if (!env.tree.tracked.includes(file)) continue;
      const info = analyseDetector(env, ts, file);
      if (info !== null) out.set(info.code, info);
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Extractor packages (4.3 step 5)
// ---------------------------------------------------------------------------

interface ExtractorScan {
  readonly packages: readonly string[];
  /** Directory names and npm names (with and without the scope) of the extractor packages. */
  readonly identities: ReadonlySet<string>;
  /** First occurrence of an unproduced kind: file and kind. */
  readonly occurrences: ReadonlyMap<string, { file: string; line: number }>;
  readonly unreadable: string | null;
  readonly limit: string | null;
}

function matchesExtractorName(pkg: Pkg): boolean {
  const candidates = [
    pkg.dir.slice(pkg.dir.lastIndexOf('/') + 1),
    pkg.name.replace(/^@[^/]+\//, ''),
  ];
  return candidates.some((n) => n.startsWith('extract-') || n === 'infer-join');
}

function buildExtractorScan(
  env: ProbeEnv,
  ts: NonNullable<ProbeEnv['ts']>,
  kinds: ReadonlySet<string>,
): ExtractorScan {
  const packages: string[] = [];
  const identities = new Set<string>();
  const occurrences = new Map<string, { file: string; line: number }>();
  let unreadable: string | null = null;
  let limit: string | null = null;
  let files = 0;
  for (const pkg of env.discovery.packages) {
    const missing = entryPoints(env.tree, pkg).unmapped;
    if (missing.length > 0) unreadable ??= `${pkg.name}: an entry point cannot be mapped: ${missing[0]}`;
    const sources: { path: string; sf: TS.SourceFile }[] = [];
    let mentions = false;
    for (const path of sourceFilesOf(env.tree, env.discovery, pkg)) {
      if (files >= env.limits.maxSourceFiles) {
        limit ??= `more than ${env.limits.maxSourceFiles} source files in the discovered packages`;
        break;
      }
      files += 1;
      const parsed = parseSource(env, path);
      if (parsed.status === 'too-large') {
        limit ??= parsed.detail;
        continue;
      }
      if (parsed.status === 'unreadable') {
        unreadable ??= parsed.detail;
        continue;
      }
      sources.push({ path, sf: parsed.sf });
      // The mention test is wider than "declares a manifest" on purpose: it can only turn a gap into Unknown.
      const visit = (node: TS.Node): void => {
        if (ts.isIdentifier(node) && node.text === 'ExtractorManifest') mentions = true;
        if (!mentions) ts.forEachChild(node, visit);
      };
      if (!mentions) visit(parsed.sf);
    }
    const isExtractor = matchesExtractorName(pkg) || (mentions && pkg.name !== VOCABULARY_PACKAGE);
    if (!isExtractor) continue;
    packages.push(pkg.name);
    for (const id of [
      pkg.name,
      pkg.name.replace(/^@[^/]+\//, ''),
      pkg.dir.slice(pkg.dir.lastIndexOf('/') + 1),
    ])
      identities.add(id);
    const other = otherLanguageReason(env.tree, env.discovery, pkg);
    if (other !== null) unreadable ??= other;
    for (const { path, sf } of sources) {
      const visit = (node: TS.Node): void => {
        let text: string | null = null;
        if (ts.isIdentifier(node)) text = node.text;
        else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
          text = node.text;
        if (text !== null && kinds.has(text) && !occurrences.has(text))
          occurrences.set(text, { file: path, line: lineOf(sf, node) });
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return { packages: packages.sort(compareCodeUnits), identities, occurrences, unreadable, limit };
}

export function probeDetectorLiveness(env: ProbeEnv, code: string): ProbeFact {
  const ts = env.ts;
  if (ts === null) return unknownFact('probe-failed', TYPESCRIPT_MISSING);
  const detector = loadDetectors(env).get(code);
  if (detector === undefined) {
    return unknownFact(
      'reads-unresolvable',
      `${code} is not in the detector registry of this tree`,
    );
  }
  const source: FactSource = {
    path: detector.file,
    lineStart: detector.codeLine,
    lineEnd: detector.codeLine,
  };
  if (detector.requiredScopes === null) {
    return unknownFact(
      'reads-unresolvable',
      `${detector.file}: requiredScopes is missing or an element does not resolve to a string literal`,
      { source },
    );
  }
  if (detector.readsIncomplete) {
    return unknownFact(
      'reads-unresolvable',
      `${detector.file}: a read names a kind that is not a string literal`,
      { source },
    );
  }
  if (detector.groups.length === 0) {
    return unknownFact(
      'reads-unresolvable',
      `${detector.file}: no node kind is read through factNodes or nodesByKind`,
      { source },
    );
  }

  // 4. The scope check, before any kind is looked at.
  if (!env.facts.runs.some((run) => run.results.length > 0)) {
    return unknownFact('facts-missing', 'no extractor result is recorded for the run', { source });
  }
  if (env.runMismatch !== null)
    return unknownFact('run-commit-mismatch', env.runMismatch, { source });
  const failing: string[] = [];
  for (const scope of detector.requiredScopes) {
    const entry = env.scopes.get(scope);
    if (entry === undefined) failing.push(`${scope}: not declared`);
    else if (entry.status !== 'PASS') failing.push(`${scope}: ${entry.status}`);
  }
  if (failing.length > 0) {
    return unknownFact('scope-not-pass', `required scope(s) not PASS: ${failing.join('; ')}`, {
      scopes: detector.requiredScopes,
      source,
    });
  }

  // 5. Result, with every required scope PASS.
  const produced = new Set<string>();
  for (const entry of env.scopes.values())
    if (entry.status === 'PASS') for (const kind of entry.kinds) produced.add(kind);
  const unproduced = detector.groups.filter((group) => !group.some((kind) => produced.has(kind)));
  if (unproduced.length === 0) {
    return holds(
      true,
      `node-kind level: every read group has a produced kind (${[...produced].sort(compareCodeUnits).join(', ')}); dormancy for property-level reasons is not visible to this probe`,
      { source },
    );
  }
  for (const group of unproduced) {
    for (const entry of [...env.scopes.values()].sort((a, b) =>
      compareCodeUnits(a.scope, b.scope),
    )) {
      if (entry.status !== 'PASS' && group.some((kind) => entry.kinds.includes(kind))) {
        return unknownFact(
          'scope-not-pass',
          `${entry.scope} is ${entry.status} and declares ${group.join(' or ')}, which might have been produced`,
          { scopes: [entry.scope], source },
        );
      }
    }
  }
  const kinds = new Set(unproduced.flat());
  const scan = memo(env, `extractor-scan:${[...kinds].sort(compareCodeUnits).join(',')}`, () =>
    buildExtractorScan(env, ts, kinds),
  );
  const first = [...scan.occurrences.entries()].sort(
    (a, b) => compareCodeUnits(a[1].file, b[1].file) || compareCodeUnits(a[0], b[0]),
  )[0];
  if (first !== undefined) {
    return unknownFact(
      'scope-not-pass',
      `${first[1].file} names the kind ${first[0]}, which no scope of the run produced; an extractor that is missing from the run might produce it`,
      { source },
    );
  }
  // A lost extractor: a result of the run that did not pass, declares no scope, and names an extractor that no
  // package of the tree carries. The scope table cannot say what it would have declared and its source cannot be
  // scanned; the run is the only evidence that something which might have produced the kind did not finish.
  const lost = (env.facts.runs[0]?.results ?? [])
    .filter(
      (r) =>
        r.status !== 'PASS' && r.authoritative.length === 0 && !scan.identities.has(r.extractor),
    )
    .map((r) => r.extractor)
    .sort(compareCodeUnits)[0];
  if (lost !== undefined) {
    return unknownFact(
      'scope-not-pass',
      `the run records that ${lost} did not finish and declares no scope for it; no package of the tree carries it, so it might have produced ${[...kinds].sort(compareCodeUnits).join(' or ')}`,
      { source },
    );
  }
  if (scan.unreadable !== null)
    return unknownFact('source-unreadable', scan.unreadable, { source });
  if (scan.limit !== null) return unknownFact('limit-exceeded', scan.limit, { source });
  if (env.discovery.incomplete) {
    return unknownFact(
      'manifest-unparseable',
      `package discovery is incomplete: ${env.discovery.incompleteDetail}`,
      { source },
    );
  }
  const scopesListed = [...env.scopes.values()]
    .sort((a, b) => compareCodeUnits(a.scope, b.scope))
    .map((e) => `${e.scope}=${e.status}`)
    .join(', ');
  return {
    ...absent(
      `node-kind level: no scope of the run produces ${unproduced.map((g) => g.join(' or ')).join(' and ')}, and no extractor package names it (scopes: ${scopesListed}; extractor packages scanned: ${scan.packages.join(', ')}); dormancy for property-level reasons is not visible to this probe`,
      { source },
    ),
    observed: false,
  };
}
