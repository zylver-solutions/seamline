/**
 * ADR-0015 conformance: the semantic engine stays an optional profile layer.
 *
 * The layer is `packages/core/src/semantic/`. These tests read every source file
 * with the TypeScript parser (no regular expressions over source text) and
 * assert three things about the import graph:
 *
 * 1. Nothing outside the layer imports it. The core contradiction pipeline
 *    (ontology, the rest of core, the extractors, infer-join, contradictions,
 *    cli, mcp) must not depend on it. Two sets of exceptions are named below,
 *    each with its reason, and each is checked for staleness so an entry that
 *    no longer matches an import fails the test:
 *      - OPT_IN_CONSUMERS: files that opt in on purpose (an integration test and
 *        the runnable example). None of them is part of the pipeline.
 *      - TRACKED_DEVIATIONS: places where the boundary is known to be broken.
 *        Empty at acceptance. An entry is a defect to fix, never a decision.
 *    A re-export of the layer from the `@seamline/core` barrel is an import of
 *    the layer by `packages/core/src/index.ts`, so the same scan catches it.
 * 2. The layer itself imports only shared primitives and a short list of Node
 *    modules, so it adds no network, process, file-system or clock access.
 * 3. The layer does not directly reference network, process, clock, timer, locale or
 *    randomness globals. This is a tripwire for the listed names, not a sandbox and not
 *    an exhaustive list: an alias such as `const g = (0, eval)('this')` is not caught,
 *    and neither is a global that is not named. `node:crypto` is imported only for
 *    `createHash`, and `@seamline/security` only for `createRedactor`. Every source file in the
 *    layer is read, whatever its extension (SCANNED_EXTENSIONS); only `*.test.<ext>` files are
 *    skipped.
 * 4. `@seamline/core/semantic` is the only package export that reaches the layer.
 *
 * A final block feeds synthetic source to the scanner functions, so each rule
 * above is shown to fire on the forms it claims to catch and to stay quiet on
 * ordinary code.
 *
 * The run-time half (a default `seamline extract` and `check` load none of it)
 * is in `semantic-boundary-runtime.test.ts`.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SEMANTIC_DIR = 'packages/core/src/semantic';

/** Every extension the scan reads. All are handled by the TypeScript import scanner. */
const SCANNED_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.jsx', '.mjs', '.cjs', '.js'] as const;

/** Every package under `packages/`. A new package must be classified here on purpose. */
// `align` is the alignment report (ADR-0014): a report family beside the pipeline, held to the same strict
// no-import rule because it must not import the optional semantic layer either (alignment design 9, 11).
const PIPELINE_PACKAGES = [
  'align',
  'cli',
  'contradictions',
  'core',
  'extract-change',
  'extract-code-ts',
  'extract-contracts',
  'extract-data',
  'infer-join',
  'mcp',
  'ontology',
  'security',
];
// `eval` is the private evaluation harness (`pnpm eval`). It drives the built CLI as a subprocess and
// imports no extractor, detector, or semantic module, so it is outside the pipeline.
const NON_PIPELINE_PACKAGES = ['eval', 'integration'];

/** Files outside the pipeline that opt in on purpose. Key: the repo-relative file path. */
const OPT_IN_CONSUMERS = new Map<string, string>([
  [
    'examples/semantic-world/demo.mjs',
    'The runnable example in docs/semantic-engine.md. It is documentation, not pipeline code.',
  ],
  [
    'packages/integration/src/semantic-bridge.test.ts',
    'Tests the code.import bridge against real extractor output through the @seamline/core/semantic entry.',
  ],
]);

/**
 * Places where the boundary is known to be broken. Empty at acceptance: the @seamline/core root no
 * longer re-exports the layer. Key: the repo-relative file path, value: why and the fix.
 */
const TRACKED_DEVIATIONS = new Map<string, string>();

/** Node modules and shared primitives the layer may import. Everything else is a boundary change. */
const SEMANTIC_ALLOWED_IMPORTS = new Map<string, string>([
  ['node:sqlite', 'the semantic store is its own SQLite file'],
  ['node:crypto', 'fingerprints and payload digests'],
  ['@seamline/ontology', 'the frozen contract the legacy code profile maps'],
  ['../merge/serialize.ts', 'canonicalJson, shared with SIF'],
  [
    '@seamline/security',
    'code.import runs the redactor itself (createRedactor); the package depends on @seamline/ontology only',
  ],
]);

/**
 * Globals that reach the network, the process, the wall clock, timers, the ambient locale and
 * time zone (`Intl`), the Web Crypto random source (the global `crypto`, which needs no import),
 * or every other global (`globalThis` is the escape hatch: `globalThis.fetch` and
 * `globalThis['process']` are the same reach as the bare names). `Math` is handled separately:
 * `Math.random` is unrecorded randomness, so `Math` may appear only as `Math.<member>` for
 * another member.
 *
 * This is a tripwire for the names listed, not an exhaustive list of every ambient API. A name
 * that is not here is not seen; ADR-0015 says so.
 */
const FORBIDDEN_GLOBALS = new Set([
  'fetch',
  'process',
  'WebSocket',
  'XMLHttpRequest',
  'EventSource',
  'performance',
  'Date',
  'globalThis',
  'crypto',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'Intl',
]);

/** The only name the layer may take from `node:crypto`: a digest, not a source of randomness. */
const ALLOWED_CRYPTO_NAMES = new Set(['createHash']);

/**
 * The only name the layer may take from `@seamline/security`. The package entry also exports
 * `makeNonce` (randomness, which ADR-0015 section 5 forbids the layer to read), the delimiters and
 * the corpus loaders; the scan of the layer's own files cannot see an imported name, so the
 * allowlist has to name it.
 */
const ALLOWED_SECURITY_NAMES = new Set(['createRedactor']);

interface Finding {
  file: string;
  specifier: string;
}

function posix(abs: string): string {
  return relative(ROOT, abs).split(sep).join('/');
}

function walk(dir: string, exts: readonly string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out.sort();
}

function parseText(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
}

function parse(abs: string): ts.SourceFile {
  return parseText(abs, readFileSync(abs, 'utf8'));
}

/** Every module specifier in `text` that is imported, re-exported, `import()`ed or `require()`d. */
function specifiersOfText(text: string): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
}

function specifiersOf(abs: string): string[] {
  return specifiersOfText(readFileSync(abs, 'utf8'));
}

/** True when `specifier`, written in `fromAbs`, names a module inside the semantic layer. */
function namesSemanticLayer(fromAbs: string, specifier: string): boolean {
  if (specifier.startsWith('.')) {
    const target = posix(resolve(dirname(fromAbs), specifier));
    return (
      /^packages\/core\/(src|dist)\/semantic(\/|$)/.test(target) ||
      /(^|\/)node_modules\/@seamline\/core\/(src|dist)\/semantic(\/|$)/.test(target)
    );
  }
  if (specifier.startsWith('@seamline/core/')) {
    return specifier.slice('@seamline/core/'.length).split('/').includes('semantic');
  }
  return false;
}

/** True when `id` is the name a declaration introduces (or a property key), not a use of a name. */
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isBindingElement(p)) return p.name === id || p.propertyName === id; // const { a: b } = x
  return (
    (ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p) ||
      ts.isParameter(p) ||
      ts.isVariableDeclaration(p)) &&
    p.name === id
  );
}

/**
 * True when `id` sits in a type reference or a `typeof` type query (`Date`, `Intl.NumberFormat`,
 * `typeof Math.PI`). Type stripping erases these, so they read nothing at run time.
 */
function inTypePosition(id: ts.Identifier): boolean {
  let n: ts.Node = id.parent;
  while (ts.isQualifiedName(n)) n = n.parent;
  return ts.isTypeReferenceNode(n) || ts.isTypeQueryNode(n);
}

/**
 * Whether `id` reads a name, as opposed to being a member name (`x.fetch`), a declaration name
 * (a method, property, accessor, enum member, parameter or variable called `process`), a
 * property key, or part of a type. There is no scope analysis: a local that shadows a forbidden
 * name declares it without a hit, but a use of that local is still a hit. Rename the local.
 * A shorthand property (`{ fetch }`) reads the binding, so it is a reference.
 */
function isReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false; // x.fetch
  if (inTypePosition(id)) return false;
  return !isDeclarationName(id);
}

/** Direct references in one source file to a forbidden global, or to `Math` other than `Math.<member>`. */
function forbiddenReferences(sf: ts.SourceFile): { line: number; what: string }[] {
  const hits: { line: number; what: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isReference(node)) {
      let what: string | undefined;
      if (FORBIDDEN_GLOBALS.has(node.text)) {
        what = node.text;
      } else if (node.text === 'Math') {
        const p = node.parent;
        const isOtherMember =
          ts.isPropertyAccessExpression(p) && p.expression === node && p.name.text !== 'random';
        if (!isOtherMember) what = 'Math.random, or Math used other than as Math.<member>';
      }
      if (what !== undefined) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        hits.push({ line: line + 1, what });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * Ways `text` reaches `specifier` other than a named import of one of the `allowed` names
 * (`import { createHash } from 'node:crypto'`).
 */
function namedImportProblems(
  text: string,
  specifier: string,
  allowed: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  let staticImports = 0;
  for (const stmt of parseText('probe.ts', text).statements) {
    if (
      !ts.isImportDeclaration(stmt) ||
      (stmt.moduleSpecifier as ts.StringLiteral).text !== specifier
    ) {
      continue;
    }
    staticImports += 1;
    const clause = stmt.importClause;
    if (clause?.isTypeOnly) continue;
    const named = clause?.namedBindings;
    if (
      clause === undefined ||
      clause.name !== undefined ||
      named === undefined ||
      !ts.isNamedImports(named)
    ) {
      problems.push(`a default, side-effect or namespace import of ${specifier}`);
      continue;
    }
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (!allowed.has(imported)) problems.push(`imports ${imported} from ${specifier}`);
    }
  }
  const all = specifiersOfText(text).filter((s) => s === specifier).length;
  if (all > staticImports) problems.push(`reaches ${specifier} through import() or require()`);
  return problems;
}

/** Ways `text` reaches `node:crypto` other than `import { createHash } from 'node:crypto'`. */
function cryptoImportProblems(text: string): string[] {
  return namedImportProblems(text, 'node:crypto', ALLOWED_CRYPTO_NAMES);
}

/** Ways `text` reaches `@seamline/security` other than `import { createRedactor } from ...`. */
function securityImportProblems(text: string): string[] {
  return namedImportProblems(text, '@seamline/security', ALLOWED_SECURITY_NAMES);
}

/**
 * Export subpaths of a package.json `exports` field with a target under the layer. A target may be
 * a string, an array, or a conditional object at any depth; `exports` may be a subpath map or a
 * bare string or conditions object (which means ".").
 */
function exportSubpathsReachingLayer(exportsField: unknown): string[] {
  const isSubpathMap =
    typeof exportsField === 'object' &&
    exportsField !== null &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).every((k) => k.startsWith('.'));
  const entries: [string, unknown][] = isSubpathMap
    ? Object.entries(exportsField as Record<string, unknown>)
    : [['.', exportsField]];
  const targetsOf = (v: unknown): string[] =>
    typeof v === 'string'
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(targetsOf)
        : typeof v === 'object' && v !== null
          ? Object.values(v).flatMap(targetsOf)
          : [];
  // A `*` pattern can expose the layer from any prefix, so test it as if it matched the layer.
  const underLayer = (t: string): boolean =>
    /^(dist|src)\/semantic(\/|$)/.test(t.replaceAll('*', 'semantic/index').replace(/^\.\//, ''));
  return entries.filter(([, v]) => targetsOf(v).some(underLayer)).map(([k]) => k);
}

/**
 * The layer's own source files: every scanned extension, so a `.mts`, `.cjs` or `.js` file placed
 * in the layer is read like a `.ts` one. Only `*.test.<ext>` files are skipped.
 */
function layerSourceFiles(dir: string): string[] {
  return walk(dir, SCANNED_EXTENSIONS).filter(
    (f) => !SCANNED_EXTENSIONS.some((ext) => f.endsWith(`.test${ext}`)),
  );
}

interface LayerImportProblems {
  /** Specifiers the allowlist does not name. */
  unlisted: string[];
  /** Relative specifiers that resolve outside `layerDir`. */
  escaping: string[];
  /** Every non-relative specifier that was seen. */
  used: Set<string>;
}

/** Check the imports of the layer's `files` against the allowlist; `label` names a file in messages. */
function layerImportProblems(
  files: readonly string[],
  layerDir: string,
  label: (abs: string) => string = posix,
): LayerImportProblems {
  const out: LayerImportProblems = { unlisted: [], escaping: [], used: new Set() };
  for (const abs of files) {
    for (const specifier of specifiersOf(abs)) {
      if (specifier.startsWith('./')) {
        if (!resolve(dirname(abs), specifier).startsWith(layerDir + sep)) {
          out.escaping.push(`${label(abs)}: ${specifier}`);
        }
        continue;
      }
      out.used.add(specifier);
      if (!SEMANTIC_ALLOWED_IMPORTS.has(specifier))
        out.unlisted.push(`${label(abs)}: ${specifier}`);
    }
  }
  return out;
}

function scannedFiles(): string[] {
  const files: string[] = [];
  for (const pkg of [...PIPELINE_PACKAGES, ...NON_PIPELINE_PACKAGES]) {
    // The whole package directory, not only src/: a stray script or config beside it counts too.
    walk(join(ROOT, 'packages', pkg), SCANNED_EXTENSIONS, files);
  }
  walk(join(ROOT, 'examples'), SCANNED_EXTENSIONS, files);
  walk(join(ROOT, 'scripts'), SCANNED_EXTENSIONS, files);
  return files.filter((abs) => !posix(abs).startsWith(`${SEMANTIC_DIR}/`));
}

function collectFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const abs of scannedFiles()) {
    const file = posix(abs);
    for (const specifier of specifiersOf(abs)) {
      if (namesSemanticLayer(abs, specifier)) findings.push({ file, specifier });
    }
  }
  return findings;
}

const keyOf = (f: Finding): string => f.file;

describe('semantic boundary: nothing outside the layer imports it', () => {
  const findings = collectFindings();

  test('every package under packages/ is classified as pipeline or non-pipeline', () => {
    const onDisk = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    assert.deepEqual(
      onDisk,
      [...PIPELINE_PACKAGES, ...NON_PIPELINE_PACKAGES].sort(),
      'A package was added or removed. Classify it in PIPELINE_PACKAGES or NON_PIPELINE_PACKAGES so the ' +
        'boundary scan covers it (ADR-0015).',
    );
  });

  test('no pipeline or unlisted file imports the semantic layer', () => {
    const allowed = new Set([...OPT_IN_CONSUMERS.keys(), ...TRACKED_DEVIATIONS.keys()]);
    const violations = findings.filter((f) => !allowed.has(keyOf(f)));
    assert.deepEqual(
      violations.map((f) => `${f.file}: ${f.specifier}`),
      [],
      'The core contradiction pipeline must not depend on the semantic engine (ADR-0015). A host opts in ' +
        'by importing @seamline/core/semantic itself; pipeline code does not.',
    );
  });

  test('opt-in consumers are never pipeline packages', () => {
    for (const key of OPT_IN_CONSUMERS.keys()) {
      const file = key.split('|')[0] ?? '';
      const pkg = /^packages\/([^/]+)\//.exec(file)?.[1];
      assert.ok(
        pkg === undefined || NON_PIPELINE_PACKAGES.includes(pkg),
        `${file} is in the pipeline package "${pkg}"; an opt-in consumer must live outside the pipeline.`,
      );
    }
  });

  test('every named exception is still live (a fixed deviation must be deleted from the list)', () => {
    const live = new Set(findings.map(keyOf));
    const stale = [...OPT_IN_CONSUMERS.keys(), ...TRACKED_DEVIATIONS.keys()].filter(
      (k) => !live.has(k),
    );
    assert.deepEqual(
      stale,
      [],
      'These exceptions no longer match any import. Remove or update them so the list stays exact.',
    );
  });
});

describe('semantic boundary: the layer is built from shared primitives only', () => {
  const layerDir = join(ROOT, SEMANTIC_DIR);
  const layerFiles = layerSourceFiles(layerDir);

  test('the layer has source files to check', () => {
    assert.ok(
      layerFiles.length >= 6,
      `expected the semantic layer sources, found ${layerFiles.length}`,
    );
  });

  test('the layer imports only the listed primitives and Node modules', () => {
    const { unlisted, escaping, used } = layerImportProblems(layerFiles, layerDir);
    assert.deepEqual(escaping, [], 'A layer file imports a relative path that leaves the layer.');
    assert.deepEqual(
      unlisted,
      [],
      'The semantic layer gained a dependency. Network, process, file-system and pipeline imports are ' +
        'outside ADR-0015; a new primitive needs the allowlist and the ADR updated together.',
    );
    assert.deepEqual(
      [...SEMANTIC_ALLOWED_IMPORTS.keys()].filter((k) => !used.has(k)),
      [],
      'These allowlisted imports are no longer used. Remove them so the allowlist stays exact.',
    );
  });

  test('the layer does not directly reference network, process, clock or randomness globals', () => {
    const hits: string[] = [];
    for (const abs of layerFiles) {
      for (const h of forbiddenReferences(parse(abs)))
        hits.push(`${posix(abs)}:${h.line} uses ${h.what}`);
    }
    assert.deepEqual(
      hits,
      [],
      'The semantic layer observes the network, the process, the clock or randomness (ADR-0015 forbids ' +
        'runtime observation, and handlers must be deterministic per docs/semantic-engine.md).',
    );
  });

  test('node:crypto is imported only for createHash, never for randomness', () => {
    const problems: string[] = [];
    for (const abs of layerFiles) {
      for (const p of cryptoImportProblems(readFileSync(abs, 'utf8')))
        problems.push(`${posix(abs)}: ${p}`);
    }
    assert.deepEqual(problems, []);
  });

  test('@seamline/security is imported only for createRedactor, never for makeNonce', () => {
    const problems: string[] = [];
    for (const abs of layerFiles) {
      for (const p of securityImportProblems(readFileSync(abs, 'utf8')))
        problems.push(`${posix(abs)}: ${p}`);
    }
    assert.deepEqual(problems, []);
  });
});

describe('semantic boundary: the package exposes the layer through one entry', () => {
  test('./semantic is the only packages/core export whose target is under the layer', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8')) as {
      exports?: unknown;
      main?: unknown;
      module?: unknown;
      types?: unknown;
    };
    assert.deepEqual(
      exportSubpathsReachingLayer(pkg.exports),
      ['./semantic'],
      'A second export reaches the semantic layer, or ./semantic no longer does. The layer has one public ' +
        'entry (ADR-0015); an alias or pattern export would bypass the import scan.',
    );
    for (const field of [pkg.main, pkg.module, pkg.types]) {
      assert.deepEqual(
        exportSubpathsReachingLayer(field),
        [],
        'main, module and types must not point into the layer',
      );
    }
  });
});

describe('semantic boundary: the scanner catches what it claims to catch', () => {
  const fromCli = join(ROOT, 'packages/cli/src/probe.ts');
  const fromBarrel = join(ROOT, 'packages/core/src/index.ts');
  const layerSpecifierHits = (from: string, text: string): string[] =>
    specifiersOfText(text).filter((s) => namesSemanticLayer(from, s));
  const MATH = 'Math.random, or Math used other than as Math.<member>';

  test('globals: bare names, globalThis in every access form, and Math.random are flagged', () => {
    const probe = [
      'export const zz1 = globalThis.fetch;',
      "export const zz2 = globalThis['process'];",
      'export const zz3 = Math.random();',
      'export const zz4 = (globalThis as any).process;',
      "export const zz5 = Math['random']();",
      'export const { random } = Math;',
      'export const zz6 = Date.now();',
      'export const zz7 = process.env.HOME;',
      'export const zz8 = performance.now();',
      'export const zz9 = fetch;',
    ].join('\n');
    assert.deepEqual(
      forbiddenReferences(parseText('probe.ts', probe)).map((h) => `${h.line} ${h.what}`),
      [
        '1 globalThis',
        '2 globalThis',
        `3 ${MATH}`,
        '4 globalThis',
        `5 ${MATH}`,
        `6 ${MATH}`,
        '7 Date',
        '8 process',
        '9 performance',
        '10 fetch',
      ],
    );
  });

  test('globals: randomness, timer and locale globals are flagged, including their member calls', () => {
    const probe = [
      'export const r1 = crypto.randomUUID();',
      'export const r2 = crypto.getRandomValues(new Uint8Array(4));',
      'export const r3 = setTimeout(() => undefined, 1);',
      'export const r4 = setInterval;',
      'export const r5 = setImmediate;',
      'export const r6 = queueMicrotask;',
      'export const r7 = new Intl.NumberFormat();',
      "export const r8 = Intl['DateTimeFormat'];",
    ].join('\n');
    assert.deepEqual(
      forbiddenReferences(parseText('probe.ts', probe)).map((h) => `${h.line} ${h.what}`),
      [
        '1 crypto',
        '2 crypto',
        '3 setTimeout',
        '4 setInterval',
        '5 setImmediate',
        '6 queueMicrotask',
        '7 Intl',
        '8 Intl',
      ],
    );
  });

  test('globals: a use of a forbidden name is still flagged where it reads the global', () => {
    const probe = [
      'export const u1 = process.env;',
      "export const u2 = fetch('x');",
      'export const u3 = { fetch };', // a shorthand property reads the binding
      'export const u4 = typeof process;', // a `typeof` expression evaluates the name
      'export const u5 = { [process.pid]: 1 };', // a computed key is an expression
      'export const u6 = (process: string) => process.length;', // no scope analysis: the use is a hit
      'export class U7 extends Date {}',
      'export const { fetch: u8 } = globalThis;',
    ].join('\n');
    assert.deepEqual(
      forbiddenReferences(parseText('probe.ts', probe)).map((h) => `${h.line} ${h.what}`),
      [
        '1 process',
        '2 fetch',
        '3 fetch',
        '4 process',
        '5 process',
        '6 process',
        '7 Date',
        '8 globalThis',
      ],
    );
  });

  test('globals: ordinary code is not flagged (member names, declaration names, types, keys)', () => {
    const clean = [
      'export const a = Math.min(1, 2) + Math.max(3, 4) + Math.floor(5.5);',
      'export const b = { process: 1, Date: 2, fetch: 3 };',
      'export interface Shape { fetch: string; process: number }',
      'export type When = Date;',
      'export const c = (x: { fetch: number }) => x.fetch + x.process;',
      // Declaration names: a member, accessor, enum member, parameter or variable may be called
      // like a forbidden global, because declaring the name reads nothing.
      'export class D1 { process(): number { return 1; } }',
      'export interface D2 { fetch(): void }',
      'export class D3 { fetch = 1; }',
      'export enum D4 { Date, Other }',
      "export class D5 { get Date(): string { return ''; } set performance(v: number) { void v; } }",
      'export const d6 = { process() { return 1; }, get fetch() { return 2; } };',
      'export function d7(process: string, ...Date: number[]): number { return 1; }',
      'export const d8 = (fetch: number): number => 1;',
      'const WebSocket = 3;',
      'export const { process: d9, fetch: d10 } = { process: 1, fetch: 2 };',
      'export class D11 { static EventSource = 1; XMLHttpRequest?: number; }',
      // Type positions are erased by type stripping.
      'export type T1 = typeof Math.PI;',
      'export type T2 = typeof Math.random;',
      'export type T3 = typeof globalThis.fetch;',
      'export type T4 = typeof process;',
      'export type T5 = Intl.NumberFormatOptions;',
      'export type T6 = Map<string, Date>;',
      'export type T7 = Array<typeof crypto>;',
    ].join('\n');
    assert.deepEqual(
      forbiddenReferences(parseText('probe.ts', clean)).map((h) => `${h.line} ${h.what}`),
      [],
    );
  });

  test('layer walk: a source file with any scanned extension is read, test files are not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seamline-layer-'));
    try {
      const body = "import { readFileSync } from 'node:fs';\nexport const q = readFileSync;\n";
      for (const ext of SCANNED_EXTENSIONS) writeFileSync(join(dir, `zz${ext}`), body);
      writeFileSync(join(dir, 'zz.test.mts'), "import 'node:test';\n");
      const files = layerSourceFiles(dir);
      assert.deepEqual(
        files.map((f) => basename(f)),
        SCANNED_EXTENSIONS.map((ext) => `zz${ext}`).sort(),
      );
      const { unlisted } = layerImportProblems(files, dir, (abs) => basename(abs));
      assert.deepEqual(
        unlisted,
        files.map((f) => `${basename(f)}: node:fs`),
        'every extension must be checked against the import allowlist',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('layer imports: a relative path that leaves the layer is reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'seamline-layer-'));
    try {
      writeFileSync(join(dir, 'a.ts'), "import './b.ts';\nimport './sub/c.ts';\n");
      const { escaping } = layerImportProblems([join(dir, 'a.ts')], join(dir, 'sub'), (abs) =>
        basename(abs),
      );
      assert.deepEqual(escaping, ['a.ts: ./b.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('node:crypto: only a named createHash import passes', () => {
    assert.deepEqual(cryptoImportProblems("import { createHash } from 'node:crypto';"), []);
    assert.deepEqual(cryptoImportProblems("import type { Hash } from 'node:crypto';"), []);
    assert.deepEqual(
      cryptoImportProblems("import { createHash, randomUUID } from 'node:crypto';"),
      ['imports randomUUID from node:crypto'],
    );
    assert.deepEqual(cryptoImportProblems("import * as c from 'node:crypto';"), [
      'a default, side-effect or namespace import of node:crypto',
    ]);
    assert.deepEqual(cryptoImportProblems("const c = await import('node:crypto');"), [
      'reaches node:crypto through import() or require()',
    ]);
  });

  test('@seamline/security: only a named createRedactor import passes', () => {
    assert.deepEqual(
      securityImportProblems("import { createRedactor } from '@seamline/security';"),
      [],
    );
    assert.deepEqual(
      securityImportProblems("import type { Redactor } from '@seamline/security';"),
      [],
    );
    assert.deepEqual(
      securityImportProblems("import { createRedactor, makeNonce } from '@seamline/security';"),
      ['imports makeNonce from @seamline/security'],
    );
    assert.deepEqual(securityImportProblems("import { makeNonce } from '@seamline/security';"), [
      'imports makeNonce from @seamline/security',
    ]);
    assert.deepEqual(securityImportProblems("import * as sec from '@seamline/security';"), [
      'a default, side-effect or namespace import of @seamline/security',
    ]);
    assert.deepEqual(securityImportProblems("import '@seamline/security';"), [
      'a default, side-effect or namespace import of @seamline/security',
    ]);
    assert.deepEqual(securityImportProblems("const s = await import('@seamline/security');"), [
      'reaches @seamline/security through import() or require()',
    ]);
  });

  test('imports: every way of naming the layer is recognised, and its neighbours are not', () => {
    const named = [
      "import '@seamline/core/semantic';",
      "import type { Profile } from '@seamline/core/semantic';",
      "export * from '@seamline/core/semantic';",
      "const m = await import('@seamline/core/semantic');",
      "const r = require('@seamline/core/dist/semantic/index.js');",
      "import '../../core/src/semantic/index.ts';",
      "import '../node_modules/@seamline/core/dist/semantic/index.js';",
    ];
    for (const line of named) {
      assert.equal(layerSpecifierHits(fromCli, line).length, 1, `not recognised: ${line}`);
    }
    const unrelated = [
      "import '@seamline/core';",
      "import '@seamline/core/identity';",
      "import './semantic-thing.ts';",
      "import '../../core/src/merge/serialize.ts';",
    ];
    for (const line of unrelated) {
      assert.deepEqual(layerSpecifierHits(fromCli, line), [], `wrongly recognised: ${line}`);
    }
  });

  test('imports: a re-export of the layer from the core barrel is recognised', () => {
    assert.deepEqual(
      layerSpecifierHits(fromBarrel, "export { SemanticEngine } from './semantic/index.ts';"),
      ['./semantic/index.ts'],
    );
    assert.deepEqual(layerSpecifierHits(fromBarrel, "export * from './semantic/index.ts';"), [
      './semantic/index.ts',
    ]);
    assert.deepEqual(layerSpecifierHits(fromBarrel, "export * from './merge/index.ts';"), []);
  });

  test('exports: strings, conditions, nesting, aliases and patterns are all resolved', () => {
    const layer = { types: './dist/semantic/index.d.ts', default: './dist/semantic/index.js' };
    const reaching = exportSubpathsReachingLayer;
    assert.deepEqual(reaching({ '.': './dist/index.js', './semantic': layer }), ['./semantic']);
    assert.deepEqual(reaching({ './semantic': './dist/semantic/index.js' }), ['./semantic']);
    assert.deepEqual(reaching({ './sem': { import: { default: './dist/semantic/index.js' } } }), [
      './sem',
    ]);
    assert.deepEqual(reaching({ './x': ['./dist/x.js', './dist/semantic/index.js'] }), ['./x']);
    assert.deepEqual(reaching({ './*': './dist/*.js' }), ['./*']);
    assert.deepEqual(reaching({ './semantic/*': './dist/semantic/*.js' }), ['./semantic/*']);
    assert.deepEqual(reaching('./dist/semantic/index.js'), ['.']);
    assert.deepEqual(reaching({ default: './dist/semantic/index.js' }), ['.']);
    assert.deepEqual(
      reaching({ '.': './dist/index.js', './identity': { default: './dist/identity/index.js' } }),
      [],
    );
    assert.deepEqual(reaching(undefined), []);
  });
});
