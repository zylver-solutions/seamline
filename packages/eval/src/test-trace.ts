/**
 * The import trace behind `freeze-watch.test.ts`: which source files a set of starting files
 * loads. A test helper (it is only ever imported by tests), kept in its own file so that the
 * trace itself can be tested on a small fixture project.
 *
 * A module counts as reached when it is LOADED, not when one of its exports is used: its top
 * level runs either way. From each starting file the trace follows
 *
 * - every `import` that is not `import type` (a side-effect import, a default, namespace or named
 *   import, `import { type T }` included: the repository compiles with `verbatimModuleSyntax`,
 *   which keeps all of those as a runtime import);
 * - every `export * from` and `export { } from` that is not `export type`, so a barrel pulls in
 *   everything it re-exports, used or not;
 * - a `import()` or `require()` with a literal target, and a `require` made by `createRequire`.
 *
 * Only `import type` and `export type` are skipped: a type cannot change what a run reports.
 *
 * What the trace refuses to guess about, and reports so the caller can fail:
 *
 * - `dynamic`: an `import()` or `require()` whose target is not a literal;
 * - `unresolved`: a relative, `@seamline/*` or `#` specifier that does not resolve to a source
 *   file. `@seamline/<pkg>/<subpath>` is resolved through each `package.json` `exports` to the
 *   source file the entry is compiled from (`dist/x.js` to `src/x.ts`), never through `dist/`,
 *   so the answer does not depend on a build;
 * - `createRequire`: every use of Node's `createRequire`. It is how a module loads something the
 *   static imports do not show, so a caller accepts a file only with a reason.
 *
 * What it cannot see, and nothing here replaces: a file a module reads at run time with the file
 * system (`readFileSync(new URL('./rules.json', import.meta.url))`). That is why
 * `freeze-watch.test.ts` also requires every tracked file under `packages/*` outside `src` to be
 * a manifest, a compiler configuration or a document.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export interface Trace {
  /** Repository-relative POSIX paths of every file reached, the starting files included. */
  readonly reached: Set<string>;
  /** Every production source under `packages/*\/src`, repository-relative. */
  readonly all: readonly string[];
  /** Dynamic `import()` or `require()` calls with a target that is not a literal, as `file:line`. */
  readonly dynamic: readonly string[];
  /**
   * Relative, `@seamline/*` and `#` specifiers of a reached file that do not resolve to a source
   * file, as `file:line specifier`.
   */
  readonly unresolved: readonly string[];
  /** Uses of `createRequire` in a reached file, as `file:line`. */
  readonly createRequire: readonly string[];
}

export interface TraceInput {
  /** The repository root. */
  readonly root: string;
  /** The files to start from (repository-relative), given every production source. */
  readonly starts: (all: readonly string[]) => readonly string[];
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !/\.test\.(ts|mjs)$/.test(entry.name) &&
      !full.includes(`${path.sep}__fixtures__${path.sep}`)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** The source file a built entry is compiled from: `./dist/a/b.js` or `./dist/a/b.d.ts` to `src/a/b.ts`. */
function sourceOfBuilt(target: string): string | undefined {
  const m = /^\.\/dist\/(.+?)(?:\.d)?\.(?:c|m)?(?:js|ts)$/.exec(target);
  return m === null ? undefined : `src/${m[1] ?? ''}.ts`;
}

/** The built file of an `exports` target: a string, or the first usable condition of an object. */
function builtTarget(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return undefined;
  const conditions = target as Record<string, unknown>;
  for (const condition of ['types', 'import', 'default']) {
    const found = builtTarget(conditions[condition]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * TypeScript `paths` for the workspace: `@seamline/<pkg>` and every `exports` subpath of each
 * package, mapped to the source file the entry is built from. A package without `exports` maps its
 * root to `src/index.ts` when that exists.
 */
function workspacePaths(
  packagesDir: string,
  packages: readonly string[],
): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const pkg of packages) {
    const dir = path.join(packagesDir, pkg);
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      // No manifest (a fixture project): the root entry below is all there is.
    }
    const name = typeof manifest['name'] === 'string' ? manifest['name'] : `@seamline/${pkg}`;
    const exportsField = manifest['exports'];
    const entries: [string, unknown][] =
      typeof exportsField === 'string'
        ? [['.', exportsField]]
        : typeof exportsField === 'object' && exportsField !== null && !Array.isArray(exportsField)
          ? Object.entries(exportsField).filter(([key]) => key.startsWith('.'))
          : [];
    for (const [key, target] of entries) {
      const built = builtTarget(target);
      const source = built === undefined ? undefined : sourceOfBuilt(built);
      if (source === undefined) continue;
      const file = path.join(dir, source);
      if (key.includes('*') || existsSync(file)) paths[`${name}${key.slice(1)}`] = [file];
    }
    if (exportsField === undefined && existsSync(path.join(dir, 'src', 'index.ts'))) {
      paths[name] = [path.join(dir, 'src', 'index.ts')];
    }
  }
  return paths;
}

export function traceValueImports(input: TraceInput): Trace {
  const root = input.root;
  const packagesDir = path.join(root, 'packages');
  const packages = readdirSync(packagesDir).sort();
  const rel = (file: string): string => path.relative(root, file).split(path.sep).join('/');
  /** In this repository, and not an installed dependency. */
  const inRepository = (file: string): boolean =>
    file.startsWith(`${root}${path.sep}`) && !file.includes(`${path.sep}node_modules${path.sep}`);
  /** A TypeScript source of a package: `packages/<pkg>/src/**\/*.ts`, not a declaration file. */
  const isSource = (file: string): boolean =>
    file.startsWith(`${packagesDir}${path.sep}`) &&
    file.endsWith('.ts') &&
    !file.endsWith('.d.ts') &&
    /^[^/\\]+[/\\]src[/\\]/.test(path.relative(packagesDir, file));

  const all = packages.flatMap((p) =>
    readdirSync(path.join(packagesDir, p)).includes('src')
      ? sources(path.join(packagesDir, p, 'src'))
      : [],
  );

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    types: [],
    baseUrl: root,
    paths: workspacePaths(packagesDir, packages),
  };

  const dynamic: string[] = [];
  const unresolved: string[] = [];
  const createRequireUses: string[] = [];

  type Resolution =
    | { readonly kind: 'file'; readonly file: string }
    | { readonly kind: 'external' }
    | { readonly kind: 'unresolved' };

  /** What an import specifier written in `from` names. */
  const resolve = (specifier: string, from: string): Resolution => {
    if (specifier.startsWith('node:')) return { kind: 'external' };
    const relative = specifier.startsWith('.') || specifier.startsWith('/');
    if (!relative && !specifier.startsWith('@seamline/') && !specifier.startsWith('#')) {
      return { kind: 'external' };
    }
    const resolved = ts.resolveModuleName(specifier, from, options, ts.sys).resolvedModule;
    if (resolved !== undefined && isSource(resolved.resolvedFileName)) {
      return { kind: 'file', file: path.normalize(resolved.resolvedFileName) };
    }
    if (relative) {
      // Not a TypeScript module (a script, a data file): still a file the run can load.
      const target = path.resolve(path.dirname(from), specifier);
      if (existsSync(target) && statSync(target).isFile()) return { kind: 'file', file: target };
    }
    return { kind: 'unresolved' };
  };

  /** The files a source file loads. */
  const followedFrom = (file: string): string[] => {
    const text = ts.sys.readFile(file);
    if (text === undefined) return [];
    const sf = ts.createSourceFile(file, text, options.target ?? ts.ScriptTarget.ES2023, true);
    const lineOf = (node: ts.Node): number =>
      sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const found = new Set<string>();
    const follow = (specifier: string, at: ts.Node): void => {
      const target = resolve(specifier, file);
      if (target.kind === 'file') {
        if (inRepository(target.file) && target.file !== file) found.add(target.file);
      } else if (target.kind === 'unresolved') {
        unresolved.push(`${rel(file)}:${lineOf(at)} ${specifier}`);
      }
    };

    // Top-level static imports and re-exports. Only the `type` forms are erased by the compiler.
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (statement.importClause?.isTypeOnly === true) continue;
        if (ts.isStringLiteral(statement.moduleSpecifier)) {
          follow(statement.moduleSpecifier.text, statement);
        }
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        if (
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          follow(statement.moduleSpecifier.text, statement);
        }
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        !statement.isTypeOnly &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteral(statement.moduleReference.expression)
      ) {
        follow(statement.moduleReference.expression.text, statement);
      }
    }

    // `createRequire`, under whatever name it is imported or reached by, and the `require`
    // functions it makes. Found first so a `require` declared after its use is still recognised.
    const makers = new Set<string>(['createRequire']);
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === 'createRequire') {
          makers.add(element.name.text);
        }
      }
    }
    const isMaker = (callee: ts.Expression): boolean =>
      (ts.isIdentifier(callee) && makers.has(callee.text)) ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire') ||
      (ts.isElementAccessExpression(callee) &&
        ts.isStringLiteralLike(callee.argumentExpression) &&
        callee.argumentExpression.text === 'createRequire');
    const requires = new Set<string>(['require']);
    const collect = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isCallExpression(node.initializer) &&
        isMaker(node.initializer.expression)
      ) {
        requires.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (isMaker(callee)) createRequireUses.push(`${rel(file)}:${lineOf(node)}`);
        const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(callee) && requires.has(callee.text);
        if (isImport || isRequire) {
          const arg = node.arguments[0];
          if (
            arg !== undefined &&
            (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
          ) {
            follow(arg.text, node);
          } else {
            dynamic.push(`${rel(file)}:${lineOf(node)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return [...found];
  };

  const allRel = all.map(rel);
  const reached = new Set<string>();
  const queue = input.starts(allRel).map((f) => path.join(root, ...f.split('/')));
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || reached.has(file)) continue;
    reached.add(file);
    // A data file or a script is reached, but there is nothing in it to follow.
    if (file.endsWith('.ts') && !file.endsWith('.d.ts')) queue.push(...followedFrom(file));
  }
  return {
    reached: new Set([...reached].map(rel)),
    all: allRel,
    dynamic: dynamic.sort(),
    unresolved: [...new Set(unresolved)].sort(),
    createRequire: [...new Set(createRequireUses)].sort(),
  };
}
