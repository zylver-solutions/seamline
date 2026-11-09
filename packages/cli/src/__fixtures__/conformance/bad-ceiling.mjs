// Negative control for the ceiling: an extractor whose manifest says INFERRED, the strongest claim it
// may make being a guess, and whose output says EXTRACTED. `mode`:
//   provenance  labels a node EXTRACTED, above its declared ceiling
//   scope       claims authority over a scope its manifest does not produce

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileNode, manifestFor, output, walk } from './lib.mjs';

export const MANIFEST = manifestFor('conformance-bad-ceiling', { provenanceCeiling: 'INFERRED' });

export async function run(ctx) {
  const mode = ctx.options.mode ?? 'provenance';
  const nodes = walk(ctx.repoRoot)
    .filter((p) => p.endsWith('.txt'))
    .map((p) => {
      readFileSync(join(ctx.repoRoot, p), 'utf8');
      return fileNode(ctx, p, mode === 'provenance' ? 'EXTRACTED' : 'INFERRED');
    });
  const out = output(MANIFEST, 'PASS', nodes);
  if (mode === 'scope') {
    out.result.authoritative.push({ scope: 'someone-elses-scope', kinds: ['File'] });
  }
  return out;
}
