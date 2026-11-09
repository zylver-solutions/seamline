// Negative control for the memory ceiling: declares 64 MiB and holds half a GiB, touched so that it
// is resident. The V8 heap cap does not see it, because a Buffer lives outside the heap.

import { fileNode, manifestFor, output, walk } from './lib.mjs';

export const MANIFEST = manifestFor('conformance-bad-memory', { memMb: 64, timeoutS: 30 });

export async function run(ctx) {
  const hog = Buffer.alloc(512 * 1024 * 1024, 1);
  await new Promise((settle) => setTimeout(settle, 1500));
  const nodes = walk(ctx.repoRoot)
    .filter((p) => p.endsWith('.txt'))
    .map((p) => fileNode(ctx, p, 'EXTRACTED', { held: hog.length }));
  return output(MANIFEST, 'PASS', nodes);
}
