// SPDX-License-Identifier: Apache-2.0
/** Consume the existing data producer's model mapping without guessing a domain. */
import { parseNodeId, type NodeId } from '@seamline/ontology';
import type { WriteModel } from './write-prisma.ts';
import { record, WriteUnknown } from './write-source.ts';

export interface WriteTable {
  readonly id: NodeId;
  readonly name: string;
  readonly schema: string;
}

export function writeTableFromIndex(json: string | undefined, model: WriteModel, repo: string, maxBytes: number): WriteTable {
  if (json === undefined) throw new WriteUnknown('WRITE_DATA_INDEX_UNAVAILABLE');
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new WriteUnknown('WRITE_DATA_INDEX_CAP');
  let index: unknown;
  try { index = JSON.parse(json); } catch { throw new WriteUnknown('WRITE_DATA_INDEX_INVALID'); }
  if (!record(index) || index['version'] !== 1 || !Array.isArray(index['tables']) ||
      index['tables'].length > 20_000 || !record(index['prismaDelegates']))
    throw new WriteUnknown('WRITE_DATA_INDEX_INVALID');
  const delegate = model.model.charAt(0).toLowerCase() + model.model.slice(1);
  const binding = index['prismaDelegates'][delegate];
  if (!record(binding) || binding['model'] !== model.model || typeof binding['table'] !== 'string')
    throw new WriteUnknown('WRITE_DATA_MODEL_AMBIGUOUS');
  const candidates = index['tables'].filter((table: unknown): table is Record<string, unknown> =>
    record(table) && table['id'] === binding['table']);
  if (candidates.length !== 1) throw new WriteUnknown('WRITE_DATA_TABLE_AMBIGUOUS');
  const table = candidates[0] as Record<string, unknown>;
  if (typeof table['id'] !== 'string' || table['name'] !== model.table || table['schema'] !== model.schema)
    throw new WriteUnknown('WRITE_DATA_MAPPING_DISAGREES');
  try {
    const id = parseNodeId(table['id'] as NodeId);
    if (id.kind !== 'Table' || id.repo !== repo) throw new Error('not this table');
  } catch { throw new WriteUnknown('WRITE_DATA_TABLE_INVALID'); }
  return { id: table['id'] as NodeId, name: model.table, schema: model.schema };
}
