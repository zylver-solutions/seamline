// Positive control: a well-behaved extractor. It reads the .txt files its manifest declares, never
// follows a symlink, makes no network attempt, stays far under its limits, and reports UNAVAILABLE,
// not PASS, when a file it set out to read cannot be read.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileNode, manifestFor, output, walk } from './lib.mjs';

export const MANIFEST = manifestFor('conformance-good');

export async function run(ctx) {
  const nodes = [];
  const unread = [];
  for (const path of walk(ctx.repoRoot).filter((p) => p.endsWith('.txt'))) {
    try {
      const text = readFileSync(join(ctx.repoRoot, path), 'utf8');
      nodes.push(fileNode(ctx, path, 'EXTRACTED', { bytes: Buffer.byteLength(text) }));
    } catch (e) {
      unread.push(`${path}: ${e.code ?? e.message}`);
    }
  }
  if (unread.length > 0) {
    return output(MANIFEST, 'UNAVAILABLE', [], [`could not read ${unread.length} file(s): ${unread[0]}`]);
  }
  return output(MANIFEST, 'PASS', nodes);
}
