/**
 * Shared rendering helpers. Human output on the left, JSON on the right; the
 * two never share a code path that could leak an escape sequence into JSON.
 */

import type { ExtractorStatus, Severity } from '@seamline/ontology';
import type { Style } from './colour.ts';
import type { Io } from './ports.ts';
import { terminalText } from '@seamline/security';

export const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/** Severities that fail a build (v3 §5, `seamline check`). */
export function failsBuild(s: Severity): boolean {
  return s === 'critical' || s === 'high';
}

export function paintSeverity(style: Style, s: Severity): string {
  const label = s.toUpperCase().padEnd(8);
  switch (s) {
    case 'critical':
      return style.red(style.bold(label));
    case 'high':
      return style.red(label);
    case 'medium':
      return style.yellow(label);
    case 'low':
      return style.dim(label);
    default:
      return label;
  }
}

export function paintStatus(style: Style, s: ExtractorStatus): string {
  const label = s.padEnd(11);
  switch (s) {
    case 'PASS':
      return style.green(label);
    case 'FAIL':
      return style.red(style.bold(label));
    case 'UNAVAILABLE':
      return style.yellow(label);
    default:
      return label;
  }
}

/** The UNKNOWN badge. Never green: UNKNOWN is not clean. */
export function paintUnknown(style: Style): string {
  return style.yellow('UNKNOWN');
}

/**
 * Writes a rendered text-mode block to stdout. Renderers escape each outside
 * field with `printable` as they build the block; this is the second line, so a
 * field one of them forgot still cannot move the cursor or set the title.
 * Never use it for `--json`, an export or a packet: those bytes are pinned.
 */
export function emitText(io: Io, style: Style, text: string): void {
  io.out(terminalText(text, style.enabled));
}

/** `emitText` for stderr. */
export function emitTextErr(io: Io, style: Style, text: string): void {
  io.err(terminalText(text, style.enabled));
}

export function emitJson(io: Io, value: unknown): void {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
}

/** Confidence as a fixed two-decimal string. Fixed formatting is a determinism requirement. */
export function fmtConfidence(c: number): string {
  return c.toFixed(2);
}
