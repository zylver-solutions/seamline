// Negative control for the network: an extractor that reaches for it. `mode` picks how:
//   net     opens a TCP socket          http    http.get          dns   resolves a name
//   fetch   global fetch                spawn   starts a process  bait  follows the URL in a bait file
// Each attempt is made inside try/catch, because a careless extractor swallows what it cannot do,
// and the result it reports is a PASS.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { fileNode, manifestFor, output, walk } from './lib.mjs';

export const MANIFEST = manifestFor('conformance-bad-network', { reads: ['**/*.txt', '**/*.json'] });

function target(ctx) {
  // The suite's bait file is a declared-looking .json holding a URL of its loopback listener.
  for (const rel of walk(ctx.repoRoot).filter((p) => p.endsWith('.json'))) {
    const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(readFileSync(join(ctx.repoRoot, rel), 'utf8'));
    if (match !== null) return Number(match[1]);
  }
  return 9;
}

export async function run(ctx) {
  const mode = ctx.options.mode ?? 'net';
  const port = target(ctx);
  try {
    if (mode === 'net' || mode === 'bait') {
      await new Promise((settle) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.destroy();
          settle();
        });
        socket.on('error', () => settle());
      });
    } else if (mode === 'http') {
      await new Promise((settle) => {
        http.get(`http://127.0.0.1:${port}/x`, () => settle()).on('error', () => settle());
      });
    } else if (mode === 'dns') {
      await new Promise((settle) => dns.lookup('conformance.invalid', () => settle()));
    } else if (mode === 'fetch') {
      await fetch(`http://127.0.0.1:${port}/x`);
    } else if (mode === 'spawn') {
      spawnSync(process.execPath, ['-e', '0']);
    }
  } catch {
    // swallowed
  }
  const nodes = walk(ctx.repoRoot)
    .filter((p) => p.endsWith('.txt'))
    .map((p) => fileNode(ctx, p));
  return output(MANIFEST, 'PASS', nodes);
}
