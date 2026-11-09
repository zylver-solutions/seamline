/**
 * Process I/O, exit codes, and the CLI's error type.
 */

import type { Clock, Io } from './ports.ts';
import { deterministicRunId } from './run-id.ts';

/**
 * Exit codes are part of the CLI's contract with CI.
 *
 * `FINDINGS` is distinct from `RUNTIME` on purpose: a pipeline that wants to
 * treat "the tool broke" differently from "the tool found something" can, and
 * UNKNOWN maps to neither.
 */
export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;
export const EXIT_RUNTIME = 3;

/** An error carrying an exit code and, optionally, a remediation hint. */
export class CliError extends Error {
  readonly code: number;
  readonly hint: string | undefined;

  constructor(message: string, code: number = EXIT_RUNTIME, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, EXIT_USAGE, hint);
}

/** Raised when a port the command needs was never wired in. */
export function notWiredError(port: string, command: string): CliError {
  return new CliError(
    `\`seamline ${command}\` needs a ${port} implementation, and none is wired into this build.`,
    EXIT_RUNTIME,
    `This is a packaging problem, not a usage problem. A released build wires ${port} at the entry point; report it with the output of \`seamline --version\`.`,
  );
}

export function processIo(): Io {
  return {
    out: (s) => {
      process.stdout.write(s);
    },
    err: (s) => {
      process.stderr.write(s);
    },
    isTty: Boolean(process.stdout.isTTY),
    env: process.env,
    cwd: process.cwd(),
  };
}

/**
 * Deterministic-mode-aware clock. v3 §2.3.
 *
 * Under `SEAMLINE_DETERMINISTIC=1` time is frozen, and the run id is derived
 * from the run's inputs rather than from the clock or a counter, so identical
 * inputs give identical output (the determinism gate) while runs over different
 * inputs still tell themselves apart (`run-id.ts`, ADR-0009).
 */
export function systemClock(env: Readonly<Record<string, string | undefined>>): Clock {
  const deterministic = env['SEAMLINE_DETERMINISTIC'] === '1';
  if (deterministic) {
    return {
      now: () => '1970-01-01T00:00:00.000Z',
      runId: (inputsDigest) => deterministicRunId(inputsDigest()),
    };
  }
  return {
    now: () => new Date().toISOString(),
    runId: () => `run-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomSuffix()}`,
  };
}

function randomSuffix(): string {
  // Not security-sensitive: only needs to avoid a collision between two runs
  // started in the same millisecond.
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}

/** Buffered `Io` for tests and for embedding the CLI in another process. */
export function bufferIo(
  opts: {
    isTty?: boolean;
    env?: Readonly<Record<string, string | undefined>>;
    cwd?: string;
  } = {},
): Io & { stdout: () => string; stderr: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    out: (s) => {
      outChunks.push(s);
    },
    err: (s) => {
      errChunks.push(s);
    },
    isTty: opts.isTty ?? false,
    env: opts.env ?? {},
    cwd: opts.cwd ?? process.cwd(),
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join(''),
  };
}
