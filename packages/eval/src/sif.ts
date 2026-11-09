/**
 * Counting what an extraction produced, from the SIF snapshot it wrote.
 *
 * SIF is JSONL: one `{"t":"node",...}` or `{"t":"edge",...}` object per line.
 * The file can be tens of megabytes for a large repository, so it is streamed
 * line by line rather than read whole.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { SIF_VERSION } from '@seamline/ontology';

function isFramingLine(line: string, lineNo: number): boolean {
  if (!line.startsWith('seamline-sif/')) return false;
  if (lineNo !== 1 || line !== `seamline-sif/${SIF_VERSION}`)
    throw new Error(`SIF line ${lineNo} has unsupported, duplicate or late framing`);
  return true;
}

export interface SifCounts {
  readonly nodes: Readonly<Record<string, number>>;
  readonly edges: Readonly<Record<string, number>>;
}

function sortedRecord(counts: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) out[key] = counts.get(key) ?? 0;
  return out;
}

/** Counts nodes and edges by kind. Throws on a line that is not valid JSON. */
export async function countSifLines(lines: AsyncIterable<string>): Promise<SifCounts> {
  const nodes = new Map<string, number>();
  const edges = new Map<string, number>();
  let lineNo = 0;
  for await (const line of lines) {
    lineNo += 1;
    if (isFramingLine(line, lineNo)) continue;
    if (line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      throw new Error(`SIF line ${lineNo} is not valid JSON: ${(e as Error).message}`);
    }
    if (typeof rec !== 'object' || rec === null) continue;
    const entry = rec as { t?: unknown; node?: { kind?: unknown }; edge?: { kind?: unknown } };
    if (entry.t === 'node' && typeof entry.node?.kind === 'string') {
      nodes.set(entry.node.kind, (nodes.get(entry.node.kind) ?? 0) + 1);
    } else if (entry.t === 'edge' && typeof entry.edge?.kind === 'string') {
      edges.set(entry.edge.kind, (edges.get(entry.edge.kind) ?? 0) + 1);
    }
  }
  return { nodes: sortedRecord(nodes), edges: sortedRecord(edges) };
}

/**
 * `path:line` (the node's `sourceRef`, else its `path`) for each wanted node id.
 * An id with no such node is simply absent from the result.
 */
export async function readSifNodeLines(
  lines: AsyncIterable<string>,
  wanted: ReadonlySet<string>,
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, string>();
  if (wanted.size === 0) return found;
  let lineNo = 0;
  for await (const line of lines) {
    lineNo += 1;
    if (isFramingLine(line, lineNo)) continue;
    if (!line.startsWith('{"node"')) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const node = (rec as { node?: { id?: unknown; sourceRef?: unknown; path?: unknown } }).node;
    if (typeof node?.id !== 'string' || !wanted.has(node.id) || found.has(node.id)) continue;
    const where = typeof node.sourceRef === 'string' ? node.sourceRef : node.path;
    if (typeof where === 'string' && where !== '') found.set(node.id, where);
  }
  return found;
}

export async function readSifNodes(
  file: string,
  wanted: ReadonlySet<string>,
): Promise<ReadonlyMap<string, string>> {
  const reader = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  return readSifNodeLines(reader, wanted);
}

export async function countSifFile(file: string): Promise<SifCounts> {
  const reader = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  return countSifLines(reader);
}
