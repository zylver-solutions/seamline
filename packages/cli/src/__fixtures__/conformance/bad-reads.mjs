// Negative control for reads: an extractor that reads outside its declared globs. `mode` (a
// ctx.options entry) picks how, each of them something a naive walker does:
//   all        reads every file under the repo and follows every symlink
//   undeclared reads every regular file, declared or not, without following symlinks
//   symlink    follows symlinks whose names look declared, wherever they lead
//   dotdot     reads a file outside the repo by walking up with ..
//   probe      only stats every entry, following symlinks, and reads nothing (not a violation of reads)
// It swallows every error it gets, as a careless extractor does, and reports PASS.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileNode, manifestFor, output, walk } from './lib.mjs';

export const MANIFEST = manifestFor('conformance-bad-reads');

function everything(root, dir = '') {
  const found = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    if (name === '.git') continue;
    const rel = dir === '' ? name : `${dir}/${name}`;
    let info;
    try {
      info = statSync(join(root, rel));
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      try {
        found.push(...everything(root, rel));
      } catch {
        // unreadable directory: skipped, like a careless walker does
      }
    } else found.push(rel);
  }
  return found;
}

export async function run(ctx) {
  const mode = ctx.options.mode ?? 'all';
  const nodes = [];
  const diagnostics = [];
  const touch = (rel) => {
    try {
      const text = readFileSync(join(ctx.repoRoot, rel), 'utf8');
      diagnostics.push(`read ${rel}: ${text.length} chars`);
    } catch (e) {
      diagnostics.push(`read ${rel}: ${e.code ?? 'error'}`);
    }
  };
  if (mode === 'all') {
    for (const rel of everything(ctx.repoRoot)) touch(rel);
  } else if (mode === 'undeclared') {
    for (const rel of walk(ctx.repoRoot)) touch(rel);
  } else if (mode === 'symlink') {
    for (const rel of everything(ctx.repoRoot).filter((p) => p.endsWith('.txt'))) touch(rel);
  } else if (mode === 'probe') {
    // Only looks at links: stats every entry, following links, and opens none of the links. Not a read, so it is
    // not what this control is for; it is here to show the suite tells a look from a read.
    everything(ctx.repoRoot);
    // ...and reads the declared files that are plain files, as any extractor would.
    for (const rel of walk(ctx.repoRoot).filter((p) => p.endsWith('.txt'))) touch(rel);
  } else if (mode === 'dotdot') {
    touch('../outside/secret-0.txt');
  }
  for (const rel of walk(ctx.repoRoot).filter((p) => p.endsWith('.txt'))) {
    nodes.push(fileNode(ctx, rel));
  }
  return output(MANIFEST, 'PASS', nodes, diagnostics);
}
