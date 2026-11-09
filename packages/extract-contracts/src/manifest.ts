import type { ExtractorManifest } from '@seamline/ontology';

/**
 * `ext` as a glob character-class sequence that matches in any letter case
 * (`sql` -> `[sS][qQ][lL]`). Discovery compares extensions lower-cased, so a
 * `SCHEMA.YAML` is read; a manifest that declared only `*.yaml` would be wrong
 * about what this extractor opens.
 */
function anyCase(ext: string): string {
  return [...ext]
    .map((c) =>
      c.toLowerCase() === c.toUpperCase() ? c : `[${c.toLowerCase()}${c.toUpperCase()}]`,
    )
    .join('');
}

/** The scope this extractor is authoritative for. Drives tombstoning (v3 2.2). */
export const CONTRACTS_SCOPE = 'contracts';

export const EXTRACTOR_NAME = 'extract-contracts';
export const EXTRACTOR_VERSION = '0.0.4';

/**
 * Capability manifest (v3 2.7). `net: false` is load-bearing rather than
 * decorative: `$ref` resolution refuses every URI scheme, so this extractor
 * has no code path that opens a socket.
 *
 * `SEAMLINE_DETERMINISTIC` is the only environment variable read, and it only
 * zeroes the reported duration so two runs compare byte-identical end to end.
 */
export const MANIFEST: ExtractorManifest = {
  name: EXTRACTOR_NAME,
  version: EXTRACTOR_VERSION,
  reads: ['yaml', 'yml', 'json', 'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'prisma'].map((ext) => `**/*.${anyCase(ext)}`),
  net: false,
  env: ['SEAMLINE_DETERMINISTIC'],
  memMb: 512,
  timeoutS: 120,
  provenanceCeiling: 'EXTRACTED',
  produces: [
    {
      scope: CONTRACTS_SCOPE,
      kinds: ['Contract', 'Operation', 'SchemaProperty', 'RouteHandler'],
    },
  ],
};
