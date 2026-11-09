// Shared helpers for the conformance suite's control extractors. Plain ES module, no dependency
// beyond Node's own: the same shape a third-party extractor outside this repository would have.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Regular files under `root` (repo-relative POSIX), not following symlinks, skipping `.git`. */
export function walk(root, dir = '') {
  const found = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) found.push(...walk(root, rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found.sort();
}

export function fileNode(ctx, path, provenance = 'EXTRACTED', extra = {}) {
  return {
    id: `${ctx.repo}:File:${path}`,
    kind: 'File',
    name: path,
    path,
    sensitivity: 'internal',
    provenance,
    confidence: 1,
    props: { ...extra },
    firstSeenRun: ctx.runId,
    lastSeenRun: ctx.runId,
    deletedAt: null,
  };
}

export function output(manifest, status, nodes, diagnostics = [], scope = manifest.produces[0].scope) {
  return {
    result: {
      extractor: manifest.name,
      version: manifest.version,
      status,
      authoritative: status === 'PASS' ? manifest.produces.map((p) => ({ ...p })) : [],
      nodeCount: nodes.length,
      edgeCount: 0,
      durationMs: 0,
      diagnostics,
    },
    nodes,
    edges: [{ scope, edges: [] }],
  };
}

export function manifestFor(name, over = {}) {
  return {
    name,
    version: '0.0.1',
    reads: ['**/*.txt'],
    net: false,
    env: [],
    memMb: 128,
    timeoutS: 30,
    provenanceCeiling: 'EXTRACTED',
    produces: [{ scope: name, kinds: ['File'] }],
    ...over,
  };
}
