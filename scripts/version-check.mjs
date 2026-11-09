#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Seamline version-equality gate.
 *
 * The twelve published packages release in lockstep: the release workflow
 * installs every one of them at the tag's version, and it compares the tag only
 * against `packages/cli`. This gate fails when any published package differs
 * from the others, or when a version literal compiled into the code (the CLI's
 * `VERSION`, which `seamline --version` prints, and the MCP server's
 * `serverVersion` default and bin) differs from them. Extractor versions are
 * their own numbers and are not checked here.
 *
 * Private packages are ignored: they are never published, so they carry no
 * release version.
 *
 * Usage:
 *   node scripts/version-check.mjs                    exit 1 on any mismatch
 *   node scripts/version-check.mjs --expect <version> also require that version
 *   node scripts/version-check.mjs --root <dir>       check another workspace (tests)
 *
 * Plain Node with the workspace's existing TypeScript development dependency
 * for syntax parsing. No inspected source module is imported or executed.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const CLI_PACKAGE = '@seamline/cli';
/** Source files that hard-code the package version, with the literal each one must carry. */
const COMPILED_VERSIONS = [
  { file: join('packages', 'cli', 'src', 'version.ts'), slot: 'cli' },
  { file: join('packages', 'mcp', 'src', 'server.ts'), slot: 'server' },
  { file: join('packages', 'mcp', 'src', 'bin.ts'), slot: 'bin' },
];

/** Published packages under `<root>/packages`, as `{ name, version }`, sorted by name. */
export function publishedPackages(root) {
  const base = join(root, 'packages');
  const found = [];
  for (const entry of readdirSync(base).sort()) {
    const file = join(base, entry, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.private === true) continue;
    found.push({ name: manifest.name, version: manifest.version });
  }
  return found;
}

function nodes(root, predicate) {
  const found = [];
  const visit = (node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function bindingContains(name, expected) {
  if (ts.isIdentifier(name)) return name.text === expected;
  return name.elements.some((element) => ts.isBindingElement(element) && bindingContains(element.name, expected));
}

/** Count declarations, including shadowing/unsupported bindings, rather than selecting the first match. */
function declarations(source, name) {
  return nodes(source, (node) => (
    ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isImportSpecifier(node) ||
    ts.isImportClause(node) || ts.isNamespaceImport(node)
  ) && node.name !== undefined && bindingContains(node.name, name));
}

function directConst(node, container) {
  if (node === undefined) return false;
  const list = node.parent;
  return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
    ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 &&
    ts.isVariableStatement(list.parent) && list.parent.parent === container;
}

function exported(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true &&
    !node.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}

function literal(node) {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : null;
}

/** Only the known direct value import owns the bin's producer; no alias/resolver inference. */
function importedServer(source) {
  const matches = declarations(source, 'createServer');
  const binding = matches[0];
  if (matches.length !== 1 || !ts.isImportSpecifier(binding) || binding.isTypeOnly || binding.propertyName !== undefined) return false;
  const named = binding.parent, clause = named.parent, statement = clause.parent;
  return ts.isNamedImports(named) && ts.isImportClause(clause) && !clause.isTypeOnly &&
    ts.isImportDeclaration(statement) && statement.parent === source && statement.attributes === undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === './server.ts';
}

/** Literal from the one active expected producer slot, or null on unsupported/ambiguous/invalid syntax. */
export function compiledVersion(root, { file, slot }) {
  const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length !== 0) return null;
  if (slot === 'cli') {
    const matches = declarations(source, 'VERSION');
    if (matches.length !== 1 || !directConst(matches[0], source) || !exported(matches[0].parent.parent)) return null;
    return literal(matches[0].initializer);
  }
  if (slot === 'server') {
    const functions = declarations(source, 'createServer');
    const versions = declarations(source, 'serverVersion');
    const fn = functions[0], version = versions[0];
    if (functions.length !== 1 || !ts.isFunctionDeclaration(fn) || fn.parent !== source ||
        !exported(fn) || fn.body === undefined || fn.parameters.length !== 1 ||
        !ts.isIdentifier(fn.parameters[0].name) || fn.parameters[0].name.text !== 'deps' ||
        versions.length !== 1 || !directConst(version, fn.body)) return null;
    const value = version.initializer;
    if (value === undefined || !ts.isBinaryExpression(value) || value.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken ||
        !ts.isPropertyAccessExpression(value.left) || value.left.questionDotToken !== undefined ||
        !ts.isIdentifier(value.left.expression) || value.left.expression.text !== 'deps' || value.left.name.text !== 'serverVersion') return null;
    return literal(value.right);
  }
  if (slot === 'bin') {
    if (!importedServer(source)) return null;
    const matches = declarations(source, 'server');
    if (matches.length !== 1 || !directConst(matches[0], source)) return null;
    const call = matches[0].initializer;
    if (call === undefined || !ts.isCallExpression(call) || call.questionDotToken !== undefined ||
        !ts.isIdentifier(call.expression) || call.expression.text !== 'createServer' || call.arguments.length !== 1 ||
        !ts.isObjectLiteralExpression(call.arguments[0])) return null;
    const properties = call.arguments[0].properties;
    // Spreads/computed names may overwrite a literal; never assume their result.
    if (properties.some((property) => ts.isSpreadAssignment(property) || ts.isComputedPropertyName(property.name))) return null;
    const versions = properties.filter((property) => property.name !== undefined &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'serverVersion');
    return versions.length === 1 && ts.isPropertyAssignment(versions[0]) ? literal(versions[0].initializer) : null;
  }
  return null;
}

/** Returns a list of human-readable problems; empty means the versions agree. */
export function checkVersions(root, expect) {
  const problems = [];
  const packages = publishedPackages(root);
  const cli = packages.find((p) => p.name === CLI_PACKAGE);
  if (cli === undefined) return [`${CLI_PACKAGE} is not a published workspace package`];
  const reference = expect ?? cli.version;
  for (const pkg of packages) {
    if (typeof pkg.version !== 'string' || pkg.version !== reference) {
      problems.push(`${pkg.name} is at ${JSON.stringify(pkg.version)}, expected ${reference}`);
    }
  }
  for (const source of COMPILED_VERSIONS) {
    const compiled = compiledVersion(root, source);
    if (compiled !== reference) {
      problems.push(`${source.file} carries version ${JSON.stringify(compiled)}, expected ${reference}`);
    }
  }
  return problems;
}

function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let expect;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1] !== undefined) root = resolve(argv[++i]);
    else if (argv[i] === '--expect' && argv[i + 1] !== undefined) expect = argv[++i];
    else {
      console.error(`unknown or incomplete argument: ${argv[i]}`);
      return 2;
    }
  }
  const problems = checkVersions(root, expect);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`version-check: ${problem}`);
    return 1;
  }
  const packages = publishedPackages(root);
  const version = packages.find((p) => p.name === CLI_PACKAGE).version;
  console.log(`version-check: ${packages.length} published packages and the compiled-in version literals are all at ${version}`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
