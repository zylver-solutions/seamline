// SPDX-License-Identifier: Apache-2.0
/** Exact source-node confinement, shared by normal and certification walks. */
import type * as TS from 'typescript';
export function exactQueryCopyNode(data: readonly [TS.ElementAccessExpression, TS.ElementAccessExpression],
  node: TS.ElementAccessExpression): boolean {
  return node === data[0] || node === data[1];
}
