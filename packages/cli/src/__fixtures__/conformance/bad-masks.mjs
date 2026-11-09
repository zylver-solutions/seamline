// Negative control for UNAVAILABLE-never-PASS: it reads the .txt files it declares, and when a read
// fails it carries on and reports PASS over what it did read, which is nothing. Contrast with
// good.mjs, which reports UNAVAILABLE.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileNode, manifestFor, output, walk } from './lib.mjs';

export const MANIFEST = manifestFor('conformance-bad-masks');

export async function run(ctx) {
  const nodes = [];
  let files = [];
  try {
    files = walk(ctx.repoRoot).filter((p) => p.endsWith('.txt'));
  } catch {
    // a failure to list is hidden too
  }
  for (const path of files) {
    try {
      readFileSync(join(ctx.repoRoot, path), 'utf8');
      nodes.push(fileNode(ctx, path));
    } catch {
      // swallowed: the file is simply missing from the result
    }
  }
  return output(MANIFEST, 'PASS', nodes);
}
