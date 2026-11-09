/**
 * Extractor identity, manifest, and authoritative scope.
 *
 * The manifest is enforced by the host, not documentation (contract:
 * `assertWithinCeiling`). `provenanceCeiling: 'EXTRACTED'` is the highest tier,
 * which is correct for this extractor precisely because every fact it emits is
 * read out of the TypeScript type checker rather than guessed — `infer-join`,
 * which guesses, is capped at `INFERRED`.
 *
 * The authoritative scope is what lets core tombstone: after a run, whatever
 * used to exist in `code.ts` and is no longer emitted is deleted rather than
 * left behind as a phantom.
 */

import type { AuthoritativeScope, ExtractorManifest, NodeKind } from '@seamline/ontology';

export const EXTRACTOR_NAME = 'extract-code-ts';
export const EXTRACTOR_VERSION = '0.0.1';

/** Scope key used for edge uniqueness (`UNIQUE(scope, src, dst, kind)`) and tombstoning. */
export const CODE_TS_SCOPE = 'code.ts';

export const PRODUCED_KINDS: readonly NodeKind[] = [
  'CodeField',
  'File',
  'Module',
  'Parameter',
  'Repo',
  'RouteHandler',
  'Symbol',
];

/**
 * The selector is deliberately narrow. This extractor is the authority for
 * TypeScript/JavaScript source files reachable from a `tsconfig.json` — not for
 * `Repo` in general, and not for `Table`, which `extract-data` owns even though
 * `QUERIES` edges point at it. Selector syntax and matching rules, root-level
 * files included: `scope-selector.ts` in `@seamline/core`.
 *
 * This manifest selector is the widest claim the extractor could ever make. A
 * `PASS` run narrows it to what its loaded projects include
 * (`codeTsAuthoritative`), because a TypeScript/JavaScript file outside every
 * loaded project was not looked at, and its absence from the output says
 * nothing about whether it still exists.
 */
export const CODE_TS_AUTHORITATIVE: readonly AuthoritativeScope[] = [
  {
    scope: CODE_TS_SCOPE,
    kinds: PRODUCED_KINDS,
    selector: '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
  },
];

/** A run's authoritative scope, bounded by `selector` (see `authoritativeSelector`). */
export function codeTsAuthoritative(selector: string): readonly AuthoritativeScope[] {
  return [{ scope: CODE_TS_SCOPE, kinds: PRODUCED_KINDS, selector }];
}

export const manifest: ExtractorManifest = {
  name: EXTRACTOR_NAME,
  version: EXTRACTOR_VERSION,
  // Source files, plus every JSON file the TypeScript project machinery may open: a
  // nested `tsconfig*.json`, anything a `tsconfig` `extends` or `references`, and the
  // `package.json` of each package a module specifier resolves into. `pnpm-workspace.yaml`
  // lists the workspace packages read when the root has no `tsconfig.json`.
  reads: ['**/*.json', 'pnpm-workspace.yaml', '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
  net: false,
  env: ['SEAMLINE_DETERMINISTIC'],
  memMb: 2048,
  timeoutS: 600,
  provenanceCeiling: 'EXTRACTED',
  produces: CODE_TS_AUTHORITATIVE,
};
