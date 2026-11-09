/**
 * Canonical serialization.
 *
 * Design v3 §2.3 makes byte-identical output across two runs a CI gate, so the
 * comparison needs one canonical form: keys sorted at every depth, arrays in
 * the collector's sort order, `\n` endings, no trailing whitespace. `JSON.
 * stringify` alone does not do this — it preserves insertion order, and
 * insertion order here follows filesystem traversal.
 */

import { SIF_VERSION } from '@seamline/ontology';
import type { SifLine } from '@seamline/ontology';
import type { ExtractCodeTsOutput } from './extract.ts';

/** Recursively sort object keys. Arrays keep their order, which is already stable. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}

/** One canonical JSON line per value, key-sorted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** SIF lines for this extractor's output: the status envelope, then nodes, then edges. */
export function toSifLines(output: ExtractCodeTsOutput): readonly SifLine[] {
  return [
    { t: 'status', result: output.result },
    ...output.nodes.map((node): SifLine => ({ t: 'node', node })),
    ...output.edges.map((edge): SifLine => ({ t: 'edge', edge })),
  ];
}

/**
 * Canonical SIF text. Two runs over the same tree must produce byte-identical
 * output from this function — that is the determinism gate, and it is a test in
 * this package rather than a promise in a document.
 */
export function toCanonicalSif(output: ExtractCodeTsOutput): string {
  const header = canonicalJson({ sif: SIF_VERSION });
  const body = toSifLines(output).map(canonicalJson);
  return [header, ...body].join('\n') + '\n';
}
