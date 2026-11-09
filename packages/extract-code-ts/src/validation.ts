/**
 * The validation library a value is built through, if any.
 *
 * `infer-join` treats a `Symbol` as a validator only when it is a runtime value
 * and an extractor names the validation library behind it. This module supplies
 * that name, as the `library` prop, for a variable whose initializer is a call
 * chain rooted in a binding imported directly from one of the libraries below:
 * `z.object({ ... }).strict()` under `import { z } from 'zod'` gives `zod`.
 *
 * The read is syntactic plus one symbol lookup, so it needs no installed
 * dependency and is byte-stable across machines. Anything else gives nothing
 * and the prop is left off rather than guessed: a value built by a local
 * helper, a binding re-exported through a local module, or a type declaration.
 * A value computed by calling into the library (`z.string().parse(raw)`) also
 * gets the prop; that is harmless, because such a value declares no members
 * for a correspondence rule to match.
 */

import { Node, SyntaxKind } from 'ts-morph';
import type { Identifier } from 'ts-morph';

/**
 * Validation libraries, by npm package name. Mirrors `VALIDATOR_LIBRARIES` in
 * `@seamline/infer-join`, which this package may not import; an integration
 * test holds the two lists equal.
 */
export const VALIDATION_LIBRARIES: ReadonlySet<string> = new Set([
  'ajv', 'class-validator', 'io-ts', 'joi', 'superstruct', 'typebox',
  'valibot', 'yup', 'zod', '@sinclair/typebox', 'runtypes',
]);

/** Bound on the call chain walked, so a pathological expression cannot stall extraction. */
const MAX_CHAIN_STEPS = 256;

/**
 * The validation library `initializer` calls into, or null.
 *
 * Walks inward through calls, property accesses, parentheses and type
 * assertions to the root identifier. At least one call is required: `const s =
 * z` aliases the namespace, it does not build anything.
 */
export function validationLibraryOf(initializer: Node | undefined): string | null {
  let current = initializer;
  let calls = 0;
  for (let step = 0; step < MAX_CHAIN_STEPS && current !== undefined; step += 1) {
    if (Node.isCallExpression(current)) {
      calls += 1;
      current = current.getExpression();
    } else if (
      Node.isPropertyAccessExpression(current) ||
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current)
    ) {
      current = current.getExpression();
    } else if (Node.isIdentifier(current)) {
      return calls > 0 ? importedLibrary(current) : null;
    } else {
      return null;
    }
  }
  return null;
}

/** The recognized library `identifier` is imported from, read off its own import declaration. */
function importedLibrary(identifier: Identifier): string | null {
  const declarations = identifier.getSymbol()?.getDeclarations() ?? [];
  for (const declaration of declarations) {
    if (
      !Node.isImportSpecifier(declaration) &&
      !Node.isNamespaceImport(declaration) &&
      !Node.isImportClause(declaration)
    ) {
      continue;
    }
    const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (importDeclaration === undefined) continue;
    const name = packageName(importDeclaration.getModuleSpecifierValue());
    if (VALIDATION_LIBRARIES.has(name)) return name;
  }
  return null;
}

/** `zod/v4` gives `zod`; `@sinclair/typebox/compiler` gives `@sinclair/typebox`. */
export function packageName(specifier: string): string {
  const segments = specifier.split('/');
  const count = specifier.startsWith('@') ? 2 : 1;
  return segments.slice(0, count).join('/');
}
