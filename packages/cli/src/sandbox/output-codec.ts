// SPDX-License-Identifier: Apache-2.0
/** Authority and facts cross the worker boundary through the shared SIF codec. */
import { compareCodeUnits, readSif, SIF_FRAME, writeSif } from '@seamline/core';
import type { ExtractorResult, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import type { ExtractorOutput } from '../ports.ts';
import { outputProblem } from './protocol.ts';

export interface EncodedExtractorOutput extends Omit<ExtractorOutput, 'result' | 'nodes' | 'edges'> {
  /** One real status record and its nodes; no invented RunRecord. */
  readonly sif: string;
  /** Each existing edge scope retains its own complete framed document. */
  readonly edgeSifs: ReadonlyArray<{ readonly scope: string; readonly sif: string }>;
}

export function encodeExtractorOutput(output: ExtractorOutput): EncodedExtractorOutput {
  const problem = outputProblem(output);
  if (problem !== undefined) throw new Error(`malformed extractor output: ${problem}`);
  const { result, nodes, edges, ...extensions } = output;
  return {
    ...extensions,
    sif: writeSif([{ t: 'status', result }, ...nodes.map(node => ({ t: 'node' as const, node }))]),
    edgeSifs: edges.map(({ scope, edges }) => ({
      scope, sif: writeSif(edges.map(edge => ({ t: 'edge' as const, edge }))),
    })).sort((a, b) => compareCodeUnits(a.scope, b.scope) || compareCodeUnits(a.sif, b.sif)),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function framed(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith(SIF_FRAME + '\n'))
    throw new Error('worker facts require current SIF framing');
  return value;
}

/** Validate every document before returning any authority or fact to the host. */
export function decodeExtractorOutput(encoded: unknown): ExtractorOutput {
  if (!record(encoded) || !Array.isArray(encoded['edgeSifs']))
    throw new Error('worker output requires framed facts and scoped edge documents');
  const { sif, edgeSifs, ...extensions } = encoded;
  const primary = readSif(framed(sif));
  const results: ExtractorResult[] = [];
  const nodes: SeamlineNode[] = [];
  for (const line of primary) {
    if (line.t === 'status') results.push(line.result);
    else if (line.t === 'node') nodes.push(line.node);
    else throw new Error('worker primary document permits only one status and nodes');
  }
  if (results.length !== 1) throw new Error('worker primary document requires exactly one status');
  const edges: Array<ExtractorOutput['edges'][number]> = [];
  for (const group of edgeSifs) {
    if (!record(group) || typeof group['scope'] !== 'string')
      throw new Error('worker edge document requires its scope');
    const lines = readSif(framed(group['sif']));
    const members: SeamlineEdge[] = [];
    for (const line of lines) {
      if (line.t !== 'edge') throw new Error('worker edge document permits only edges');
      members.push(line.edge);
    }
    edges.push({ scope: group['scope'], edges: members });
  }
  const output = { ...extensions, result: results[0] as ExtractorResult, nodes, edges };
  const problem = outputProblem(output);
  if (problem !== undefined) throw new Error(`malformed decoded extractor output: ${problem}`);
  return output;
}
