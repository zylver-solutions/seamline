// SPDX-License-Identifier: Apache-2.0
/** ADR0017: reversible identity from declared inputs, without source locations. */
import { createRedactor } from '@seamline/core';
export type WriteContractKey = readonly [
  owningPackage: string,
  lexicalChain: readonly string[],
  persistence: readonly [owningPackage: string, lexicalChain: readonly string[]],
  storageModel: string,
];

const PREFIX = 'validated-write:';

function names(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(name);
}

function name(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isKey(value: unknown): value is WriteContractKey {
  return Array.isArray(value) && value.length === 4 && name(value[0]) &&
    names(value[1]) && Array.isArray(value[2]) && value[2].length === 2 &&
    name(value[2][0]) && names(value[2][1]) && name(value[3]);
}

export function writeContractName(key: WriteContractKey): string {
  if (!isKey(key)) throw new Error('invalid validated-write declaration key');
  // Guard the declared inputs before encoding; a reversible identifier must
  // not hide a credential from the later structural graph guard.
  const redactor = createRedactor();
  for (const value of [key[0], ...key[1], key[2][0], ...key[2][1], key[3]])
    redactor.guardStructural(value, 'write.identity', 'validated write declaration');
  return PREFIX + Buffer.from(JSON.stringify(key), 'utf8').toString('hex');
}

/** Refuse alternate encodings, malformed UTF-8 and noncanonical tuple JSON. */
export function decodeWriteContractName(encoded: string): WriteContractKey | undefined {
  if (!encoded.startsWith(PREFIX)) return undefined;
  const hex = encoded.slice(PREFIX.length);
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return undefined;
  try {
    const key: unknown = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
    return isKey(key) && writeContractName(key) === encoded ? key : undefined;
  } catch {
    return undefined;
  }
}
