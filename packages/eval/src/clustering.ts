/** Default root-cause components, scoped to repository and detector. */
import type { Finding, Label } from './types.ts';

/**
 * Same-left or same-right links are transitive. Explicit label clusters opt a
 * finding out of automatic links, so a documented override can split a default
 * component. Unlabelled findings still connect their labelled neighbours.
 */
export function findingClusters(findings: readonly Finding[], labels: ReadonlyMap<string, Label>): ReadonlyMap<string, string> {
  const sorted = findings.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const parent = new Map(sorted.map((f) => [f.id, f.id]));
  const root = (id: string): string => {
    let found = id;
    while (parent.get(found) !== found) found = parent.get(found)!;
    while (id !== found) { const next = parent.get(id)!; parent.set(id, found); id = next; }
    return found;
  };
  const join = (a: string, b: string): void => {
    const left = root(a); const right = root(b);
    if (left !== right) parent.set(left < right ? right : left, left < right ? left : right);
  };
  const lefts = new Map<string, string>();
  const rights = new Map<string, string>();
  const explicit = new Map<string, string>();
  for (const f of sorted) {
    const cluster = labels.get(f.id)?.cluster;
    if (cluster !== undefined) {
      const key = JSON.stringify([f.repo, f.code, cluster]);
      const previous = explicit.get(key);
      if (previous === undefined) explicit.set(key, f.id); else join(previous, f.id);
      continue;
    }
    for (const [index, endpoint] of [[lefts, f.left], [rights, f.right]] as const) {
      const key = JSON.stringify([f.repo, f.code, endpoint]);
      const previous = index.get(key);
      if (previous === undefined) index.set(key, f.id); else join(previous, f.id);
    }
  }
  return new Map(sorted.map((f) => [f.id, labels.get(f.id)?.cluster ?? `auto:${root(f.id)}`]));
}
