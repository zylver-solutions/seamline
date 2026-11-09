/**
 * Colour support detection and styling.
 *
 * Colour is off unless stdout is a TTY *and* the environment permits it.
 * `NO_COLOR` (https://no-color.org) wins over everything except an explicit
 * `FORCE_COLOR`, and `--no-color` wins over both.
 */

import type { Io } from './ports.ts';

export interface Style {
  readonly enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
}

export interface ColourInput {
  readonly isTty: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `--no-color` on the command line. */
  readonly noColorFlag: boolean;
  /** True when `--json` was requested; machine output is never coloured. */
  readonly json: boolean;
}

export function colourEnabled(input: ColourInput): boolean {
  if (input.noColorFlag) return false;
  if (input.json) return false;

  const noColor = input.env['NO_COLOR'];
  // no-color.org: present and non-empty, regardless of value.
  if (noColor !== undefined && noColor !== '') return false;

  const forceColor = input.env['FORCE_COLOR'];
  if (forceColor !== undefined && forceColor !== '' && forceColor !== '0') return true;

  if (input.env['TERM'] === 'dumb') return false;
  return input.isTty;
}

const CODES = {
  bold: '1',
  dim: '2',
  red: '31',
  yellow: '33',
  green: '32',
  cyan: '36',
  magenta: '35',
} as const;

export function makeStyle(enabled: boolean): Style {
  const wrap =
    (code: string) =>
    (s: string): string =>
      enabled ? `\u001b[${code}m${s}\u001b[0m` : s;
  return {
    enabled,
    bold: wrap(CODES.bold),
    dim: wrap(CODES.dim),
    red: wrap(CODES.red),
    yellow: wrap(CODES.yellow),
    green: wrap(CODES.green),
    cyan: wrap(CODES.cyan),
    magenta: wrap(CODES.magenta),
  };
}

export function styleFor(io: Io, opts: { noColorFlag: boolean; json: boolean }): Style {
  return makeStyle(
    colourEnabled({
      isTty: io.isTty,
      env: io.env,
      noColorFlag: opts.noColorFlag,
      json: opts.json,
    }),
  );
}

/** Strips every ANSI SGR sequence. Used by tests and by the JSON path. */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}
