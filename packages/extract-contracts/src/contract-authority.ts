// SPDX-License-Identifier: Apache-2.0
/** Known contract families, checked before any canonical claim is emitted. */
import { compareCodeUnits, encodeCanonicalSelector, MAX_CANONICAL_SELECTOR_BYTES, MAX_CANONICAL_SELECTOR_RULES } from '@seamline/core';
import type { AuthoritativeScope } from '@seamline/ontology';

export interface ContractNameSource { readonly name: string; readonly file: string }

function lowerBound(values: readonly string[], value: string): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareCodeUnits(values[mid] as string, value) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function canonicalContractAuthority(candidates: readonly ContractNameSource[],
  declared: readonly ContractNameSource[], namesComplete: boolean,
  protectionRoots: readonly ContractNameSource[] = candidates): {
    readonly claims: readonly AuthoritativeScope[]; readonly withheld: ReadonlySet<string>;
  } {
  // Two claims, each with one rule, per binding. Exhaustion cannot fall back
  // to a filename claim and cannot allocate an unbounded rules buffer.
  if (candidates.length * 2 > MAX_CANONICAL_SELECTOR_RULES)
    throw new Error('canonical producer rule budget exceeded');
  const files = new Map<string, Set<string>>();
  for (const { name, file } of [...declared, ...candidates, ...protectionRoots]) {
    const paths = files.get(name) ?? new Set<string>();
    paths.add(file);
    files.set(name, paths);
  }
  const names = [...files.keys()].sort(compareCodeUnits);
  const roots = new Set<string>();
  // Reserved or subsequently withheld identities can protect a family from
  // deletion. Only complete candidates below can ever grant authority.
  for (const { name } of protectionRoots) {
    if (!namesComplete || (files.get(name)?.size ?? 0) > 1) roots.add(name);
    const prefix = name + '#/';
    const first = names[lowerBound(names, prefix)];
    if (first !== undefined && first.startsWith(prefix)) roots.add(name);
    for (let at = name.indexOf('#/'); at !== -1; at = name.indexOf('#/', at + 2)) {
      const parent = name.slice(0, at);
      if (files.has(parent)) roots.add(parent);
    }
  }
  const withheld = new Set<string>();
  const disjointRoots: string[] = [];
  for (const root of [...roots].sort(compareCodeUnits)) {
    if (disjointRoots.some(parent => root.startsWith(parent + '#/'))) continue;
    disjointRoots.push(root);
    withheld.add(root);
    const prefix = root + '#/';
    for (let i = lowerBound(names, prefix); i < names.length && names[i]!.startsWith(prefix); i++)
      withheld.add(names[i] as string);
  }
  const claims: AuthoritativeScope[] = [];
  let bytes = 0;
  for (const { name, file } of [...candidates].sort((a, b) => compareCodeUnits(a.file, b.file) || compareCodeUnits(a.name, b.name))) {
    if (withheld.has(name)) continue;
    for (const [kind, rule] of [
      ['Contract', ['exact', name]], ['SchemaProperty', ['prefix', name + '#/']],
    ] as const) {
      const selector = encodeCanonicalSelector({ path: file, rules: [rule] });
      bytes += Buffer.byteLength(selector, 'utf8');
      if (bytes > MAX_CANONICAL_SELECTOR_BYTES) throw new Error('canonical producer byte budget exceeded');
      claims.push({ scope: 'contracts', kinds: [kind], selector });
    }
  }
  return { claims, withheld };
}
