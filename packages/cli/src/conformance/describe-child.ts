/**
 * The child that reads an extractor module's manifest.
 *
 * `seamline conformance` must know the manifest before it can run the extractor, and the manifest is
 * an export of the extractor's own module. Importing that module in the CLI process would run
 * third-party code with nothing around it, so the import happens here, in a child started with
 * `node --permission`, no repository to read, and the same in-child guards (`sandbox/guard.ts`) that
 * confine an extractor: no network, no child process, no writes. The module's top level runs, then
 * its `MANIFEST` (or `manifest`) export is sent back as data. Nothing else of it is used.
 *
 * Transport as in `sandbox/child.ts`: one JSON request on stdin, one JSON response on fd 3.
 */

import { readSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ExtractorManifest } from '@seamline/ontology';
import { installGuards } from '../sandbox/guard.ts';
import { PROTOCOL_VERSION, type SandboxRequest } from '../sandbox/protocol.ts';

export interface DescribeRequest {
  readonly module: string;
  readonly scratch: string;
  readonly codeRoots: ReadonlyArray<string>;
}

export type DescribeResponse =
  | { readonly ok: true; readonly manifest: unknown; readonly hasRun: boolean }
  | { readonly ok: false; readonly message: string };

function readRequest(): DescribeRequest {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(1 << 16);
  for (;;) {
    let n: number;
    try {
      n = readSync(0, buffer, 0, buffer.length, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((e as NodeJS.ErrnoException).code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, n)));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as DescribeRequest;
}

function send(response: DescribeResponse): void {
  const bytes = Buffer.from(JSON.stringify(response), 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(3, bytes, offset, bytes.length - offset);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        continue;
      }
      throw e;
    }
  }
}

/** A manifest that asks for nothing, so the guards deny every read of the (empty) scratch repository. */
const STUB: ExtractorManifest = {
  name: 'conformance-describe',
  version: '0.0.0',
  reads: [],
  net: false,
  env: [],
  memMb: 256,
  timeoutS: 30,
  provenanceCeiling: 'EXTRACTED',
  produces: [],
};

async function main(): Promise<void> {
  const request = readRequest();
  const guarded: SandboxRequest = {
    v: PROTOCOL_VERSION,
    program: request.module,
    manifest: STUB,
    repoRoot: request.scratch,
    codeRoots: request.codeRoots,
    grants: { exec: [] },
    ctx: {} as never,
  };
  installGuards(guarded);
  try {
    const loaded = (await import(pathToFileURL(request.module).href)) as Record<string, unknown>;
    const manifest = loaded['MANIFEST'] ?? loaded['manifest'];
    if (manifest === undefined) {
      send({ ok: false, message: 'the module exports neither MANIFEST nor manifest' });
    } else {
      send({ ok: true, manifest, hasRun: typeof loaded['run'] === 'function' });
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    const refused = error as Error & { code?: string; permission?: string; resource?: string };
    const detail =
      refused.code === 'ERR_ACCESS_DENIED' && refused.resource !== undefined
        ? `${error.message} (${refused.permission ?? 'permission'}: ${refused.resource})`
        : error.message;
    // A refused read at import time is the module reaching for code the suite does not open to it.
    const hint =
      refused.code === 'ERR_ACCESS_DENIED' || /^\[path-[a-z-]+\]/.test(error.message)
        ? ' (a module can import its own directory, the nearest package.json, and the dependencies installed under a node_modules that package.json lists; see docs/conformance.md)'
        : '';
    send({ ok: false, message: `importing the module failed: ${detail}${hint}` });
  }
  process.exit(0);
}

await main();
