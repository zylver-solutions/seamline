/**
 * `seamline diff <a> <b>` — compare two runs.
 *
 * Only meaningful because extraction is byte-reproducible (v3 §2.3): without
 * that, every diff is noise. Nodes are compared by id, edges by
 * `(src, dst, kind)`; a node present in both but with a changed field is
 * reported as changed with the specific fields named, because "42 nodes
 * changed" is not actionable.
 */

import path from 'node:path';
import { edgeKey, type SeamlineEdge, type SeamlineNode } from '@seamline/ontology';
import { parseCommandArgs, STORE_OPTION_SPEC } from '../args.ts';
import { styleFor, type Style } from '../colour.ts';
import { loadConfig } from '../config.ts';
import { EXIT_OK, notWiredError, usageError } from '../io.ts';
import type { CliDeps, Snapshot } from '../ports.ts';
import { printable } from '@seamline/security';
import { emitJson, emitText } from '../render.ts';
import { resolveStoreDir } from '../store-dir.ts';

/** Fields whose change is worth reporting. Run bookkeeping is excluded. */
const COMPARED_FIELDS = ['kind', 'name', 'path', 'sensitivity', 'provenance', 'confidence', 'deletedAt'] as const;

export interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface ChangedEntity {
  readonly id: string;
  readonly changes: readonly FieldChange[];
}

export interface DiffReport {
  readonly from: string;
  readonly to: string;
  readonly nodes: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly ChangedEntity[];
  };
  readonly edges: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly ChangedEntity[];
  };
  readonly identical: boolean;
}

export async function diffCommand(deps: CliDeps, argv: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, STORE_OPTION_SPEC);
  const style = styleFor(deps.io, { noColorFlag: parsed.globals.noColor, json: parsed.globals.json });

  const [a, b] = parsed.positionals;
  if (a === undefined || b === undefined) {
    throw usageError(
      'seamline diff needs two refs.',
      'Each ref is a run id from `seamline extract`, or a path to a .sif snapshot file.',
    );
  }

  const repoRoot = path.resolve(deps.io.cwd, parsed.globals.repo ?? '.');
  const config = await loadConfig(repoRoot);
  const outDir = resolveStoreDir('diff', repoRoot, config, parsed);

  if (deps.snapshots === undefined) throw notWiredError('snapshot reader', 'diff');
  const left = await deps.snapshots.read(outDir, a);
  const right = await deps.snapshots.read(outDir, b);

  const report = diffSnapshots(a, b, left, right);

  if (parsed.globals.json) {
    emitJson(deps.io, report);
    return EXIT_OK;
  }
  emitText(deps.io, style, renderDiff(style, report));
  return EXIT_OK;
}

export function diffSnapshots(fromRef: string, toRef: string, from: Snapshot, to: Snapshot): DiffReport {
  const nodes = diffCollection(
    indexBy(from.nodes, (n) => n.id),
    indexBy(to.nodes, (n) => n.id),
  );
  const edges = diffCollection(
    indexBy(from.edges, (e) => edgeKey('', e).trim()),
    indexBy(to.edges, (e) => edgeKey('', e).trim()),
  );
  return {
    from: fromRef,
    to: toRef,
    nodes,
    edges,
    identical:
      nodes.added.length === 0 &&
      nodes.removed.length === 0 &&
      nodes.changed.length === 0 &&
      edges.added.length === 0 &&
      edges.removed.length === 0 &&
      edges.changed.length === 0,
  };
}

function indexBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const item of items) m.set(key(item), item);
  return m;
}

function diffCollection<T extends SeamlineNode | SeamlineEdge>(
  from: ReadonlyMap<string, T>,
  to: ReadonlyMap<string, T>,
): { added: readonly string[]; removed: readonly string[]; changed: readonly ChangedEntity[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: ChangedEntity[] = [];

  for (const key of [...to.keys()].sort()) {
    if (!from.has(key)) added.push(key);
  }
  for (const key of [...from.keys()].sort()) {
    if (!to.has(key)) {
      removed.push(key);
      continue;
    }
    const before = from.get(key) as unknown as Record<string, unknown>;
    const after = to.get(key) as unknown as Record<string, unknown>;
    const changes: FieldChange[] = [];
    for (const field of COMPARED_FIELDS) {
      if (!deepEqual(before[field], after[field])) {
        changes.push({ field, before: before[field] ?? null, after: after[field] ?? null });
      }
    }
    if (!deepEqual(before['props'], after['props'])) {
      changes.push({ field: 'props', before: before['props'] ?? null, after: after['props'] ?? null });
    }
    if (changes.length > 0) changed.push({ id: key, changes });
  }
  return { added, removed, changed };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sorted((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function renderDiff(style: Style, r: DiffReport): string {
  if (r.identical) {
    return `${style.green('identical')}  ${printable(r.from)} and ${printable(r.to)} produce the same graph.\n`;
  }
  const lines: string[] = [`${printable(r.from)} ${style.dim('->')} ${printable(r.to)}`, ''];
  section(lines, style, 'NODES', r.nodes);
  section(lines, style, 'EDGES', r.edges);
  return `${lines.join('\n')}\n`;
}

function section(
  lines: string[],
  style: Style,
  title: string,
  d: { added: readonly string[]; removed: readonly string[]; changed: readonly ChangedEntity[] },
): void {
  if (d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0) return;
  lines.push(
    `${style.bold(title)}  +${d.added.length} -${d.removed.length} ~${d.changed.length}`,
  );
  for (const id of d.added) lines.push(`  ${style.green('+')} ${printable(id)}`);
  for (const id of d.removed) lines.push(`  ${style.red('-')} ${printable(id)}`);
  for (const c of d.changed) {
    lines.push(`  ${style.yellow('~')} ${printable(c.id)}`);
    for (const ch of c.changes) {
      lines.push(`      ${ch.field}: ${printable(JSON.stringify(ch.before))} ${style.dim('->')} ${printable(JSON.stringify(ch.after))}`);
    }
  }
  lines.push('');
}
