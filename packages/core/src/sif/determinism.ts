/**
 * The determinism harness — the debugging tool behind the release gate.
 *
 * "Extract twice, assert byte-identical SIF" (design v3 §2.3) is a CI gate, and
 * a gate that reports only pass/fail is close to useless: a failure lands on
 * someone who now has two multi-megabyte JSONL files and a diff tool that will
 * happily tell them 40,000 lines changed because one line was inserted near the
 * top. So the contract here is narrower and more useful: report *the first*
 * divergence, at line and column, and where both lines are JSON, name the exact
 * field whose value differs.
 */

import { canonicalStringify, compareCodeUnits } from './canonicalize.ts';

/** Where two SIF texts first differ. */
export interface SifDivergence {
  /** 1-based line number of the first differing line. */
  readonly line: number;
  /** 1-based character column of the first differing character, or the length + 1 when one line is a prefix. */
  readonly column: number;
  /** The whole left line, or null when the left text ended first. */
  readonly left: string | null;
  /** The whole right line, or null when the right text ended first. */
  readonly right: string | null;
  /** Dotted JSON path of the first differing field, when both lines parse. */
  readonly fieldPath: string | null;
  /** Canonical text of the left value at `fieldPath`, or null when absent there. */
  readonly leftValue: string | null;
  /** Canonical text of the right value at `fieldPath`, or null when absent there. */
  readonly rightValue: string | null;
  /** One-sentence description suitable for an assertion message. */
  readonly summary: string;
}

export interface DeterminismReport {
  readonly identical: boolean;
  readonly divergence: SifDivergence | null;
  readonly leftLineCount: number;
  readonly rightLineCount: number;
}

/** A thing that produces SIF text. Sync or async, so a real extractor fits. */
export type SifProducer = () => string | Promise<string>;

const IDENTICAL_MARKER = '(identical)';

/**
 * Compare two SIF texts for byte identity.
 *
 * Byte identity is checked on the whole string first, so an identical pair
 * costs one comparison; the line walk only happens on failure.
 */
export function compareSif(left: string, right: string): DeterminismReport {
  const leftLines = splitSifLines(left);
  const rightLines = splitSifLines(right);

  if (left === right) {
    return {
      identical: true,
      divergence: null,
      leftLineCount: leftLines.length,
      rightLineCount: rightLines.length,
    };
  }

  const max = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < max; i++) {
    const a = i < leftLines.length ? (leftLines[i] as string) : null;
    const b = i < rightLines.length ? (rightLines[i] as string) : null;
    if (a === b) continue;
    return {
      identical: false,
      divergence: describeDivergence(i + 1, a, b, leftLines.length, rightLines.length),
      leftLineCount: leftLines.length,
      rightLineCount: rightLines.length,
    };
  }

  // Same lines, different bytes: the difference is in line termination only.
  return {
    identical: false,
    divergence: {
      line: leftLines.length,
      column: 1,
      left: leftLines.at(-1) ?? null,
      right: rightLines.at(-1) ?? null,
      fieldPath: null,
      leftValue: null,
      rightValue: null,
      summary:
        'the two texts contain the same lines but differ in line termination ' +
        `(left ends with ${JSON.stringify(tail(left))}, right ends with ${JSON.stringify(tail(right))}); ` +
        'canonical SIF terminates every line with a single \\n',
    },
    leftLineCount: leftLines.length,
    rightLineCount: rightLines.length,
  };
}

/**
 * Run a producer twice (or two producers once each) and compare the output.
 * This is the shape the CI gate uses: `checkDeterminism(() => extract(repo))`.
 */
export async function checkDeterminism(
  produce: SifProducer,
  produceAgain?: SifProducer,
): Promise<DeterminismReport> {
  const left = await produce();
  const right = await (produceAgain ?? produce)();
  return compareSif(left, right);
}

/**
 * Throw with a rendered diff unless the two texts are byte-identical.
 * `label` names what was compared, e.g. `seamline extract --repo fixtures/blog`.
 */
export function assertByteIdentical(left: string, right: string, label = 'SIF output'): void {
  const report = compareSif(left, right);
  if (report.identical) return;
  throw new Error(`${label} is not byte-reproducible.\n${formatReport(report)}`);
}

/** `assertByteIdentical` over producers. */
export async function assertDeterministic(
  produce: SifProducer,
  produceAgain?: SifProducer,
  label = 'SIF output',
): Promise<void> {
  const report = await checkDeterminism(produce, produceAgain);
  if (report.identical) return;
  throw new Error(`${label} is not byte-reproducible.\n${formatReport(report)}`);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Human-readable rendering of a report. Returns `(identical)` when there is nothing to show. */
export function formatReport(report: DeterminismReport): string {
  if (report.identical || report.divergence === null) return IDENTICAL_MARKER;
  const d = report.divergence;
  const lines: string[] = [];
  lines.push(`first divergence at line ${d.line}, column ${d.column}`);
  lines.push(`  ${d.summary}`);
  lines.push(`  document length: run A = ${report.leftLineCount} line(s), run B = ${report.rightLineCount} line(s)`);
  lines.push(...renderWindow(d));
  if (d.fieldPath !== null) {
    lines.push(`  field: ${d.fieldPath}`);
    lines.push(`    run A: ${d.leftValue ?? '(absent)'}`);
    lines.push(`    run B: ${d.rightValue ?? '(absent)'}`);
  }
  return lines.join('\n');
}

/** Alias kept short for assertion messages. */
export function formatDivergence(divergence: SifDivergence): string {
  return formatReport({
    identical: false,
    divergence,
    leftLineCount: divergence.left === null ? 0 : divergence.line,
    rightLineCount: divergence.right === null ? 0 : divergence.line,
  });
}

const WINDOW = 60;

function renderWindow(d: SifDivergence): string[] {
  if (d.left === null || d.right === null) {
    const present = d.left ?? d.right ?? '';
    const side = d.left === null ? 'run B' : 'run A';
    return [`  ${side} only: ${clip(present, 0, WINDOW * 2)}`];
  }
  const start = Math.max(0, d.column - 1 - WINDOW);
  const leftWindow = clip(d.left, start, WINDOW * 2);
  const rightWindow = clip(d.right, start, WINDOW * 2);
  const caretOffset = (start > 0 ? 1 : 0) + (d.column - 1 - start);
  return [
    `  run A: ${leftWindow}`,
    `  run B: ${rightWindow}`,
    `         ${' '.repeat(Math.max(0, caretOffset))}^`,
  ];
}

function clip(s: string, start: number, length: number): string {
  const prefix = start > 0 ? '…' : '';
  const slice = s.slice(start, start + length);
  const suffix = start + length < s.length ? '…' : '';
  return `${prefix}${slice}${suffix}`;
}

// ---------------------------------------------------------------------------
// Divergence detail
// ---------------------------------------------------------------------------

function describeDivergence(
  lineNumber: number,
  left: string | null,
  right: string | null,
  leftCount: number,
  rightCount: number,
): SifDivergence {
  if (left === null) {
    return {
      line: lineNumber,
      column: 1,
      left: null,
      right,
      fieldPath: null,
      leftValue: null,
      rightValue: null,
      summary: `run A ended after ${leftCount} line(s); run B has an extra line ${lineNumber}`,
    };
  }
  if (right === null) {
    return {
      line: lineNumber,
      column: 1,
      left,
      right: null,
      fieldPath: null,
      leftValue: null,
      rightValue: null,
      summary: `run B ended after ${rightCount} line(s); run A has an extra line ${lineNumber}`,
    };
  }

  const column = firstDifferingColumn(left, right);
  const field = firstDifferingField(left, right);
  const summary =
    field === null
      ? `line ${lineNumber} differs from column ${column}`
      : `line ${lineNumber} differs at field ${field.path}`;

  return {
    line: lineNumber,
    column,
    left,
    right,
    fieldPath: field === null ? null : field.path,
    leftValue: field === null ? null : field.left,
    rightValue: field === null ? null : field.right,
    summary,
  };
}

function firstDifferingColumn(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) return i + 1;
  }
  return n + 1;
}

interface FieldDivergence {
  readonly path: string;
  readonly left: string | null;
  readonly right: string | null;
}

/**
 * Name the first field whose value differs, walking both objects in canonical
 * key order so the "first" field is the same one a byte comparison would reach.
 * Returns null when either line is not JSON, which is itself worth knowing.
 */
function firstDifferingField(leftLine: string, rightLine: string): FieldDivergence | null {
  let a: unknown;
  let b: unknown;
  try {
    a = JSON.parse(leftLine);
    b = JSON.parse(rightLine);
  } catch {
    return null;
  }
  return walk(a, b, '');
}

function walk(a: unknown, b: unknown, path: string): FieldDivergence | null {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compareCodeUnits);
    for (const key of keys) {
      const childPath = path.length > 0 ? `${path}.${key}` : key;
      const inA = key in a;
      const inB = key in b;
      if (!inA || !inB) {
        return {
          path: childPath,
          left: inA ? safeStringify(a[key]) : null,
          right: inB ? safeStringify(b[key]) : null,
        };
      }
      const found = walk(a[key], b[key], childPath);
      if (found !== null) return found;
    }
    return null;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= a.length) return { path: childPath, left: null, right: safeStringify(b[i]) };
      if (i >= b.length) return { path: childPath, left: safeStringify(a[i]), right: null };
      const found = walk(a[i], b[i], childPath);
      if (found !== null) return found;
    }
    return null;
  }

  const left = safeStringify(a);
  const right = safeStringify(b);
  if (left === right) return null;
  return { path: path.length > 0 ? path : '(whole line)', left, right };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return clip(canonicalStringify(value), 0, 200);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Line splitting
// ---------------------------------------------------------------------------

/**
 * Split SIF into records. A single trailing `\n` is the canonical terminator
 * and does not create an empty final record; anything else is preserved so the
 * comparison can report it rather than normalize the difference away.
 */
function splitSifLines(text: string): string[] {
  if (text.length === 0) return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

function tail(text: string): string {
  return text.slice(Math.max(0, text.length - 4));
}
