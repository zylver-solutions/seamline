/**
 * The `infer-join` capability manifest (design v3 §2.7) and the runtime guard
 * that makes its provenance ceiling real.
 *
 * v3 §6: "`infer-join` cannot emit `EXTRACTED`; the manifest ceiling makes that
 * a runtime error, not a code-review question." Every edge this package emits
 * goes through `guardProvenance`, so the ceiling is enforced on the write path
 * rather than asserted in a comment.
 */

import type { ExtractorManifest, Provenance } from '@seamline/ontology';
import { assertWithinCeiling } from '@seamline/ontology';

/** The scope this extractor is authoritative for. Drives UNIQUE(scope, src, dst, kind). */
export const INFER_JOIN_SCOPE = 'infer-join';

/**
 * Scopes whose facts this inference reads. If any of these is not `PASS`, the
 * inference is degraded and must not be read as a negative finding (v3 §2.2:
 * "UNAVAILABLE is never PASS").
 *
 * These are authoritative *scope* strings (`AuthoritativeScope.scope`, the
 * key `GraphView.scopeStatus` is queried with and `SqliteStore` groups
 * `UNIQUE(scope, src, dst, kind)` by) — not extractor package names. They
 * must match `@seamline/extract-code-ts`'s `CODE_TS_SCOPE` ('code.ts'),
 * `@seamline/extract-contracts`'s `CONTRACTS_SCOPE` ('contracts'), and
 * `@seamline/extract-data`'s `DATA_SCOPE` ('data') exactly, or every real
 * store reports every one of them UNAVAILABLE regardless of whether those
 * extractors actually passed — no authoritative scope is ever literally
 * named `extract-code-ts`. Repeated here as literals rather than imported so
 * this package keeps its "reads the merged graph only" dependency profile
 * (only `@seamline/ontology`); a cross-package contract test protects the
 * values from drifting apart again.
 */
export const REQUIRED_SCOPES: ReadonlyArray<string> = ['code.ts', 'contracts', 'data'];

export const INFER_JOIN_VERSION = '0.1.0';

export const INFER_JOIN_MANIFEST: ExtractorManifest = Object.freeze({
  name: 'infer-join',
  version: INFER_JOIN_VERSION,
  // Reads the merged graph only. No repo files, so no globs.
  reads: [],
  net: false,
  env: [],
  memMb: 512,
  timeoutS: 120,
  provenanceCeiling: 'INFERRED',
  produces: [
    {
      scope: INFER_JOIN_SCOPE,
      // Emits no nodes. Claiming authority over Column/CodeField/SchemaProperty
      // here would let a tombstoning pass delete facts this extractor did not
      // produce, which is precisely the corruption the ceiling exists to stop.
      kinds: [],
      selector: 'MAPS_TO_FIELD|BACKED_BY|EXPOSED_AS|VALIDATED_BY',
    },
  ],
});

/**
 * Assert a provenance is within this extractor's ceiling and return it.
 *
 * Called on every emitted edge. Passing `EXTRACTED` throws, which is the whole
 * point: a bug in a scoring path cannot launder a guess into a fact.
 */
export function guardProvenance(
  provenance: Provenance,
  manifest: ExtractorManifest = INFER_JOIN_MANIFEST,
): Provenance {
  assertWithinCeiling(manifest, provenance);
  return provenance;
}
