/**
 * Reducing several import declarations to the one `IMPORTS` edge the graph keeps.
 *
 * Edge identity is `(scope, src, dst, kind)` (design v3 §2.2), so a file that
 * reaches another file through three declarations still owns exactly one
 * `IMPORTS` edge to it. Which declaration's facts that edge carries must not
 * depend on where the declarations sit in the file, or on which file happens to
 * be walked last: reordering two `import` lines is not a change to the code's
 * dependencies, and the byte-reproducibility invariant says it cannot change a
 * byte of the output. So the facts are folded with rules that are commutative,
 * associative, and idempotent, never by letting the last write win.
 *
 * These functions are pure on purpose. `relations.ts` walks the AST and calls
 * them; the rules live here where they can be tested against every ordering.
 */

import type { ModuleImport } from './context.ts';

/** What one `import` or `export ... from` declaration says about its target file. */
export interface ImportFact {
  /** The module specifier as written. */
  readonly specifier: string;
  /** Whether this declaration is `import type` or `export type`, and so erased at runtime. */
  readonly typeOnly: boolean;
  /** Whether this declaration is an `export ... from`, rather than an `import`. */
  readonly reExport: boolean;
}

function smallerString(a: string, b: string): string {
  return a <= b ? a : b;
}

/**
 * Fold two declarations that reach the same target into one set of facts.
 *
 *  - `typeOnly` is true only when **every** declaration is type-only. A single
 *    value import makes the importer a runtime dependent of the target, and a
 *    type-only flag must never hide that. A consumer reading the flag as "this
 *    edge is erased at runtime" stays correct.
 *  - `reExport` is true when **any** declaration re-exports: the target's API
 *    is visible through the importer, whatever else the importer does with it.
 *  - `specifier` is the lexicographically smallest spelling used. The prop is a
 *    single string by contract (edge props are scalars), so a list is not
 *    available, and joining spellings would stop it being a specifier. The
 *    smallest is a real specifier, is independent of order, and is what a
 *    lone declaration reports, so a file with one import is unchanged. The
 *    spelling is a label: the edge's `dst` carries the identity of the target.
 */
export function mergeImportFacts(a: ImportFact, b: ImportFact): ImportFact {
  return {
    specifier: smallerString(a.specifier, b.specifier),
    typeOnly: a.typeOnly && b.typeOnly,
    reExport: a.reExport || b.reExport,
  };
}

/**
 * Fold two file-level imports between the same pair of modules into the single
 * module-level edge. Many files collapse into it, so the same order-freedom
 * applies across files: the edge is attributed to the smallest
 * `(srcFile, dstFile)` pair by code-unit order, and carries the smallest
 * specifier. Both inputs must be for the same `(src, dst)` module pair.
 */
export function mergeModuleImports(a: ModuleImport, b: ModuleImport): ModuleImport {
  const aFirst = a.srcFile < b.srcFile || (a.srcFile === b.srcFile && a.dstFile <= b.dstFile);
  const attributed = aFirst ? a : b;
  return {
    src: attributed.src,
    dst: attributed.dst,
    srcFile: attributed.srcFile,
    dstFile: attributed.dstFile,
    specifier: smallerString(a.specifier, b.specifier),
  };
}
