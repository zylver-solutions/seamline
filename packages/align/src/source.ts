/**
 * Reading and parsing one source file for a probe (5.3): bounded, syntax-only,
 * memoised per evaluation. `ts.createSourceFile` never throws, so a file
 * "cannot be parsed" when the parser reports a syntactic diagnostic for it.
 */

import { memo, type ProbeEnv } from './env.ts';
import { parseDiagnosticCount, type TS } from './ts.ts';
import { readText } from './tree.ts';
import { extname } from './util.ts';
import { SOURCE_EXTENSIONS } from './workspace.ts';

export type ParsedSource =
  | { readonly status: 'ok'; readonly path: string; readonly sf: TS.SourceFile }
  | { readonly status: 'unreadable'; readonly path: string; readonly detail: string }
  | { readonly status: 'too-large'; readonly path: string; readonly detail: string };

/** Parse a tracked file with the syntax-only parser. Requires `env.ts`. */
export function parseSource(env: ProbeEnv, path: string): ParsedSource {
  return memo(env, `parse:${path}`, (): ParsedSource => {
    if (!SOURCE_EXTENSIONS.includes(extname(path))) {
      return { status: 'unreadable', path, detail: `${path} is not a TypeScript or JavaScript source file` };
    }
    const ts = env.ts;
    if (ts === null)
      return { status: 'unreadable', path, detail: 'the TypeScript parser is not available' };
    const size = env.tree.size(path);
    if (size !== null && size > env.limits.maxSourceBytes) {
      return {
        status: 'too-large',
        path,
        detail: `${path} is ${size} bytes, over the bound of ${env.limits.maxSourceBytes}`,
      };
    }
    const text = readText(env.tree, path);
    if (text === null) return { status: 'unreadable', path, detail: `${path} cannot be read` };
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const diagnostics = parseDiagnosticCount(sf);
    if (diagnostics === undefined)
      return {
        status: 'unreadable',
        path,
        detail: `${path}: syntax errors cannot be counted by this parser`,
      };
    if (diagnostics > 0) return { status: 'unreadable', path, detail: `${path} has syntax errors` };
    return { status: 'ok', path, sf };
  });
}

/** String literal text of a literal expression (a template without substitutions counts), else `null`. */
export function literalText(
  ts: NonNullable<ProbeEnv['ts']>,
  node: TS.Node | undefined,
): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** 1-based line of a node's start. */
export function lineOf(sf: TS.SourceFile, node: TS.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/**
 * Module specifiers a file names with a string literal (5.2 step 5): `import`
 * and `export ... from` declarations, `import()` and `require()` calls,
 * `import x = require()` and `import('x')` types. A specifier that is not a
 * string literal is no evidence and is not looked for.
 */
export function moduleSpecifiers(ts: NonNullable<ProbeEnv['ts']>, sf: TS.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: TS.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      const text = literalText(ts, node.moduleSpecifier);
      if (text !== null) out.push(text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const text = literalText(ts, node.moduleReference.expression);
      if (text !== null) out.push(text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const text = literalText(ts, node.arguments[0]);
      if (text !== null) out.push(text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const text = literalText(ts, node.argument.literal);
      if (text !== null) out.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
