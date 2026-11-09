/**
 * SIF writer — `SifLine[]` to JSON-Lines text.
 *
 * Emission order is fixed and total (design v3 §2.3): the `run` line, then
 * `status` lines, then `node` lines, then `edge` lines, each group in canonical
 * sort order. Ordering requires the whole set, so the writer materializes its
 * input before emitting; the streaming entry points stream the *output*, which
 * is the half that matters for memory when writing a large SIF to a file.
 */

import type { SifLine } from '@seamline/ontology';
import { SIF_FRAME } from './framing.ts';
import { assertSifAuthority } from './authority.ts';
import {
  canonicalSifLine,
  compareCodeUnits,
  compareKeyTuples,
  SIF_GROUP_ORDER,
  sifSortKey,
} from './canonicalize.ts';

/** A SIF line reduced to what ordering and output need. */
interface Emission {
  readonly group: number;
  readonly key: readonly string[];
  readonly json: string;
}

function toEmission(line: SifLine): Emission {
  const json = canonicalSifLine(line);
  const group = SIF_GROUP_ORDER[line.t];
  if (group === undefined) {
    throw new Error(`unknown SIF line type ${JSON.stringify(line.t)}`);
  }
  return { group, key: sifSortKey(line), json };
}

function compareEmissions(a: Emission, b: Emission): number {
  if (a.group !== b.group) return a.group - b.group;
  const byKey = compareKeyTuples(a.key, b.key);
  if (byKey !== 0) return byKey;
  return compareCodeUnits(a.json, b.json);
}

/**
 * Canonicalize and order `lines`, returning each as its own JSON text.
 *
 * Every line is canonicalized before any is returned, so a rejected path or a
 * stray timestamp fails the whole write rather than producing a truncated file.
 */
export function canonicalSifOrder(lines: Iterable<SifLine>): string[] {
  const records = [...lines];
  assertSifAuthority(records, true);
  const emissions: Emission[] = [];
  for (const line of records) emissions.push(toEmission(line));
  emissions.sort(compareEmissions);
  return emissions.map((e) => e.json);
}

/**
 * Serialize `lines` to SIF text.
 *
 * Every line is terminated by `\n`, including the last. Version-2 framing is
 * mandatory, including when there are no records.
 */
export function writeSif(lines: Iterable<SifLine>): string {
  const ordered = canonicalSifOrder(lines);
  return `${[SIF_FRAME, ...ordered].join('\n')}\n`;
}

/** `writeSif` over an async source (an extractor's streamed output). */
export async function writeSifAsync(
  lines: AsyncIterable<SifLine> | Iterable<SifLine>,
): Promise<string> {
  return writeSif(await collect(lines));
}

/**
 * Yield SIF text one line at a time, in canonical order, each already
 * terminated by `\n` so the consumer can write chunks straight through.
 */
export async function* streamSif(
  lines: AsyncIterable<SifLine> | Iterable<SifLine>,
): AsyncGenerator<string, void, undefined> {
  const ordered = canonicalSifOrder(await collect(lines));
  yield `${SIF_FRAME}\n`;
  for (const json of ordered) {
    yield `${json}\n`;
  }
}

/** Minimal sink: anything with a `write` that accepts a string. */
export interface SifSink {
  write(chunk: string): unknown;
}

/**
 * Write canonical SIF into `sink`. Kept structurally typed rather than bound to
 * `node:stream` so the writer stays dependency-free and testable with an array.
 */
export async function writeSifTo(
  sink: SifSink,
  lines: AsyncIterable<SifLine> | Iterable<SifLine>,
): Promise<number> {
  const ordered = canonicalSifOrder(await collect(lines));
  sink.write(`${SIF_FRAME}\n`);
  for (const json of ordered) {
    sink.write(`${json}\n`);
  }
  return ordered.length;
}

async function collect(
  lines: AsyncIterable<SifLine> | Iterable<SifLine>,
): Promise<SifLine[]> {
  const out: SifLine[] = [];
  if (Symbol.asyncIterator in Object(lines)) {
    for await (const line of lines as AsyncIterable<SifLine>) out.push(line);
  } else {
    for (const line of lines as Iterable<SifLine>) out.push(line);
  }
  return out;
}
