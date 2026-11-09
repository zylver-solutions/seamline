/**
 * The sandbox child: the process that actually runs one extractor.
 *
 * The host starts this file with `node --permission ...`, a scrubbed
 * environment and a memory cap, writes one `SandboxRequest` to its stdin, and
 * reads one `SandboxResponse` from file descriptor 3. Nothing else is trusted:
 * stdout and stderr are for humans.
 *
 * Order matters. The request is read first, the guards are installed second,
 * and only then is the extractor's module imported, so no extractor code has
 * run, or even loaded, when the guards go in. This file imports nothing from
 * the extractors. It does load Seamline's own libraries (`@seamline/core` and
 * `@seamline/ontology`, whole) and the guard before the guards are installed,
 * so what runs first is first-party code with no repository input, not a
 * small file: the permission model, which is in force from the first
 * instruction, is what bounds that part.
 */

import { readSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { SandboxViolation, runWithinBudget } from '@seamline/core';
import type { ExtractContext } from '../ports.ts';
import { installGuards, type Guard } from './guard.ts';
import { encodeExtractorOutput } from './output-codec.ts';
import {
  PROTOCOL_VERSION,
  type ChildPhase,
  type ProgramModule,
  type RecordedDenial,
  type SandboxRequest,
  type SandboxResponse,
} from './protocol.ts';

const REQUEST_FD = 0;
const RESPONSE_FD = 3;
const OBSERVATION_FD = 4;

/** Constant metadata only. Diagnostics must never affect an extractor outcome. */
function phase(value: ChildPhase): void {
  try { writeSync(OBSERVATION_FD, `[seamline-child-phase:${value}]\n`); } catch { /* best effort */ }
}

function readRequest(): SandboxRequest {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(1 << 16);
  for (;;) {
    let n: number;
    try {
      n = readSync(REQUEST_FD, buffer, 0, buffer.length, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      if ((e as NodeJS.ErrnoException).code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, n)));
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SandboxRequest;
  if (request.v !== PROTOCOL_VERSION)
    throw new Error(`unsupported sandbox protocol version ${String(request.v)}`);
  return request;
}

function send(response: SandboxResponse): void {
  const bytes = Buffer.from(JSON.stringify(response), 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(RESPONSE_FD, bytes, offset, bytes.length - offset);
    } catch (e) {
      // A pipe the host has not drained yet: wait a moment and write again.
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        continue;
      }
      throw e;
    }
  }
}

/** What the guard refused, as the response carries it. */
interface Refusals {
  readonly denials: ReadonlyArray<RecordedDenial>;
  readonly denialsTruncated: boolean;
}

function failureOf(e: unknown, refusals: Refusals): SandboxResponse {
  if (e instanceof SandboxViolation) {
    return {
      v: PROTOCOL_VERSION,
      ok: false,
      failure: { kind: 'violation', code: e.code, message: e.detail },
      ...refusals,
    };
  }
  const error = e instanceof Error ? e : new Error(String(e));
  // The runtime's own refusal (the permission model) names what it refused only in extra fields.
  const refused = error as Error & { code?: string; permission?: string; resource?: string };
  const message =
    refused.code === 'ERR_ACCESS_DENIED' && refused.resource !== undefined
      ? `${error.message} (${refused.permission ?? 'permission'}: ${refused.resource})`
      : error.message;
  return {
    v: PROTOCOL_VERSION,
    ok: false,
    failure: { kind: 'error', name: error.name, message },
    ...refusals,
  };
}

async function main(): Promise<void> {
  const installed: { guard?: Guard } = {};
  const refusals = (): Refusals => ({
    denials: installed.guard?.denials() ?? [],
    denialsTruncated: installed.guard?.truncated() ?? false,
  });
  // A bug that escapes the extractor's own error handling still has to reach the host as a failure.
  const bail = (e: unknown): never => {
    try {
      phase('send');
      send(failureOf(e, refusals()));
      phase('sent');
    } finally {
      process.exit(1);
    }
  };
  process.on('uncaughtException', bail);
  process.on('unhandledRejection', bail);

  phase('bootstrap');
  const request = readRequest();
  phase('request-read');
  const guard = installGuards(request);
  installed.guard = guard;
  phase('guards-installed');

  let response: SandboxResponse;
  try {
    phase('program-import');
    const program = (await import(pathToFileURL(request.program).href)) as Partial<ProgramModule>;
    phase('program-loaded');
    if (typeof program.run !== 'function') throw new Error('the program module exports no run()');
    const run = program.run.bind(program);
    const ctx = request.ctx as ExtractContext;
    // The same budget the host enforces from outside, applied from the inside as well: this is what
    // reports a memory overrun that unfolds across awaits, and stops a cooperative extractor cleanly.
    phase('run');
    const output = await runWithinBudget(request.manifest, () => run(ctx, request.graph));
    phase('output');
    try {
      response = { v: PROTOCOL_VERSION, ok: true, output: encodeExtractorOutput(output), ...refusals() };
    } catch (error) {
      response = { v: PROTOCOL_VERSION, ok: false,
        failure: { kind: 'protocol', message: error instanceof Error ? error.message : String(error) }, ...refusals() };
    }
  } catch (e) {
    response = failureOf(e, refusals());
  }
  phase('send');
  send(response);
  phase('sent');
  process.exit(0);
}

await main();
