/**
 * `seamline blast-radius` — what a change can reach.
 *
 * v3 §1's 10-minute gate names "blast radius for the working diff" as a
 * required output. Two modes:
 *
 *   - `--ids <comma-separated NodeIds>`: explicit roots. Matches the MCP
 *     `impact` tool's own parameter shape exactly, for parity and so the two
 *     surfaces can be tested against the same fixtures.
 *   - no `--ids`: roots are resolved from `deps.git.changedFiles(repoRoot)`,
 *     matched against the graph's node `.path` fields — "what does my working
 *     diff touch, and what does that touch reach."
 *
 * Either way the walk itself is `@seamline/core`'s `bfs` over
 * `IMPACT_EDGE_KINDS`, depth- and count-bounded, identical to what backs the
 * MCP `impact` tool — this command exists to expose that answer from a git
 * diff without an agent in the loop, not to add a second traversal algorithm.
 */

import path from 'node:path';
import { NODE_KINDS, type NodeId, type NodeKind, type SeamlineNode } from '@seamline/ontology';
import { bfs, compareCodeUnits, IMPACT_EDGE_KINDS, type Reached } from '@seamline/core';
import { parseCommandArgs, STORE_OPTION_SPEC } from '../args.ts';
import { styleFor, type Style } from '../colour.ts';
import { loadConfig } from '../config.ts';
import { EXIT_OK, notWiredError, usageError } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { degradedScopes, type DegradedScope } from '../scopes.ts';
import { printable } from '@seamline/security';
import { emitJson, emitText, fmtConfidence } from '../render.ts';
import { resolveStoreDir } from '../store-dir.ts';

export interface RootMatch {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly path: string | null;
  /** The changed-file path this root was resolved from. `null` in `--ids` mode. */
  readonly fromPath: string | null;
}

export interface ReachedNodeSummary {
  readonly id: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly path: string | null;
  readonly provenance: string;
  readonly confidence: number;
  readonly depth: number;
  readonly viaEdge: string;
}

export interface ReachedGroup {
  readonly kind: NodeKind;
  readonly count: number;
  readonly nodes: readonly ReachedNodeSummary[];
}

export interface BlastRadiusReport {
  readonly mode: 'ids' | 'diff';
  readonly depth: number;
  readonly roots: readonly RootMatch[];
  /** `--ids` that did not resolve to a live node. */
  readonly missingIds: readonly string[];
  /** Changed-file paths that matched no node at all. Informative, not an error. */
  readonly unmatchedPaths: readonly string[];
  /** True in `diff` mode when the working tree had no changed files at all. */
  readonly cleanWorkingTree: boolean;
  readonly reachedCount: number;
  readonly reached: readonly ReachedGroup[];
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly unknown: readonly DegradedScope[];
}

export async function blastRadiusCommand(deps: CliDeps, argv: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    ...STORE_OPTION_SPEC,
    ids: { type: 'string' },
    depth: { type: 'string' },
    limit: { type: 'string' },
  });
  const style = styleFor(deps.io, { noColorFlag: parsed.globals.noColor, json: parsed.globals.json });

  const repoRoot = path.resolve(deps.io.cwd, parsed.globals.repo ?? '.');
  const config = await loadConfig(repoRoot);
  const outDir = resolveStoreDir('blast-radius', repoRoot, config, parsed);
  if (deps.store === undefined) throw notWiredError('store', 'blast-radius');

  const maxDepth = intOption(parsed.values['depth'], config.limits.maxDepth, '--depth');
  const maxNodes = intOption(parsed.values['limit'], config.limits.maxResults, '--limit');

  const idsRaw = typeof parsed.values['ids'] === 'string' ? (parsed.values['ids'] as string) : undefined;
  const explicitIds =
    idsRaw === undefined
      ? undefined
      : idsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
  if (explicitIds !== undefined && explicitIds.length === 0) {
    throw usageError('--ids needs at least one NodeId.', 'Example: --ids myrepo:Symbol:src/foo.ts#bar');
  }
  const mode: 'ids' | 'diff' = explicitIds !== undefined ? 'ids' : 'diff';

  const workspace = await deps.store.open({ repoRoot, outDir, repo: config.repo, create: false });
  try {
    const view = workspace.store;

    const roots: RootMatch[] = [];
    const missingIds: string[] = [];
    const unmatchedPaths: string[] = [];
    let cleanWorkingTree = false;

    if (explicitIds !== undefined) {
      for (const id of explicitIds) {
        const node = view.node(id as NodeId);
        if (node === undefined || node.deletedAt !== null) {
          missingIds.push(id);
          continue;
        }
        roots.push(toRootMatch(node, null));
      }
    } else {
      if (deps.git === undefined) throw notWiredError('git', 'blast-radius');
      const changed = await deps.git.changedFiles(repoRoot);
      cleanWorkingTree = changed.length === 0;

      const byPath = indexNodesByPath(view);
      const seen = new Set<string>();
      for (const filePath of changed) {
        const matches = byPath.get(filePath) ?? [];
        if (matches.length === 0) {
          unmatchedPaths.push(filePath);
          continue;
        }
        for (const node of matches) {
          if (seen.has(node.id)) continue;
          seen.add(node.id);
          roots.push(toRootMatch(node, filePath));
        }
      }
    }

    roots.sort((a, b) => compareCodeUnits(a.id, b.id));
    unmatchedPaths.sort();
    missingIds.sort();

    const unknown = degradedScopes(view, await workspace.runs.latest());

    if (roots.length === 0) {
      const report: BlastRadiusReport = {
        mode,
        depth: maxDepth,
        roots: [],
        missingIds,
        unmatchedPaths,
        cleanWorkingTree,
        reachedCount: 0,
        reached: [],
        truncated: false,
        truncationReasons: [],
        unknown,
      };
      if (parsed.globals.json) {
        emitJson(deps.io, report);
        return EXIT_OK;
      }
      emitText(deps.io, style, renderReport(style, report));
      return EXIT_OK;
    }

    const walk = bfs(
      view,
      roots.map((r) => r.id as NodeId),
      IMPACT_EDGE_KINDS,
      { maxDepth, maxNodes, direction: 'both' },
    );

    const reached = groupReached(walk.reached);
    const report: BlastRadiusReport = {
      mode,
      depth: maxDepth,
      roots,
      missingIds,
      unmatchedPaths,
      cleanWorkingTree,
      reachedCount: walk.reached.length,
      reached,
      truncated: walk.state.truncated,
      truncationReasons: walk.state.truncated ? walk.state.reasons : [],
      unknown,
    };

    if (parsed.globals.json) {
      emitJson(deps.io, report);
      return EXIT_OK;
    }
    emitText(deps.io, style, renderReport(style, report));
    return EXIT_OK;
  } finally {
    await workspace.store.close();
  }
}

function toRootMatch(node: SeamlineNode, fromPath: string | null): RootMatch {
  return { id: node.id, kind: node.kind, name: node.name, path: node.path ?? null, fromPath };
}

/** Every live node keyed by its `.path`, across every kind. */
function indexNodesByPath(view: { nodesByKind: (kind: NodeKind) => ReadonlyArray<SeamlineNode> }): Map<string, SeamlineNode[]> {
  const byPath = new Map<string, SeamlineNode[]>();
  for (const kind of NODE_KINDS) {
    for (const node of view.nodesByKind(kind)) {
      if (node.deletedAt !== null || node.path === undefined) continue;
      const bucket = byPath.get(node.path);
      if (bucket === undefined) byPath.set(node.path, [node]);
      else bucket.push(node);
    }
  }
  return byPath;
}

function groupReached(reached: readonly Reached[]): readonly ReachedGroup[] {
  const byKind = new Map<NodeKind, ReachedNodeSummary[]>();
  for (const r of reached) {
    const summary: ReachedNodeSummary = {
      id: r.node.id,
      kind: r.node.kind,
      name: r.node.name,
      path: r.node.path ?? null,
      provenance: r.node.provenance,
      confidence: r.node.confidence,
      depth: r.depth,
      viaEdge: r.viaEdge,
    };
    const bucket = byKind.get(r.node.kind);
    if (bucket === undefined) byKind.set(r.node.kind, [summary]);
    else bucket.push(summary);
  }
  const groups: ReachedGroup[] = [];
  for (const [kind, nodes] of byKind) {
    nodes.sort((a, b) => a.depth - b.depth || compareCodeUnits(a.id, b.id));
    groups.push({ kind, count: nodes.length, nodes });
  }
  groups.sort((a, b) => compareCodeUnits(a.kind, b.kind));
  return groups;
}

function renderReport(style: Style, report: BlastRadiusReport): string {
  const lines: string[] = [];
  lines.push(style.bold(`BLAST RADIUS  ${report.mode === 'ids' ? 'explicit ids' : 'working diff'}  depth ${report.depth}`));
  lines.push('');

  if (report.mode === 'diff' && report.cleanWorkingTree) {
    lines.push(style.green('Working tree is clean.'));
    lines.push(style.dim('No changed files, so there is nothing to compute a blast radius for.'));
    lines.push('');
    return lines.join('\n');
  }

  if (report.roots.length === 0) {
    lines.push(style.yellow('No roots resolved.'));
    if (report.mode === 'ids') {
      lines.push(style.dim(`None of the given id(s) resolved to a live node.`));
    } else {
      lines.push(
        style.dim(
          'None of the changed file(s) matched a node in the graph. Either they are outside every ' +
            "extractor's scope, or `seamline extract` has not run since they changed.",
        ),
      );
    }
  } else {
    lines.push(style.bold(`ROOTS  ${report.roots.length}`));
    for (const r of report.roots) {
      const from = r.fromPath === null ? '' : `  ${style.dim(`<- ${printable(r.fromPath)}`)}`;
      lines.push(`  ${style.cyan(r.kind.padEnd(15))} ${printable(r.name)}${from}`);
    }
    lines.push('');
  }

  if (report.missingIds.length > 0) {
    lines.push(style.yellow(`MISSING  ${report.missingIds.length} id(s) did not resolve to a live node`));
    for (const id of report.missingIds) lines.push(`  ${printable(id)}`);
    lines.push('');
  }

  if (report.unmatchedPaths.length > 0) {
    lines.push(style.yellow(`UNMATCHED  ${report.unmatchedPaths.length} changed path(s) matched no node`));
    lines.push(style.dim("Outside every extractor's scope, or not yet extracted. Not a failure."));
    for (const p of report.unmatchedPaths) lines.push(`  ${printable(p)}`);
    lines.push('');
  }

  if (report.roots.length > 0) {
    if (report.reached.length === 0) {
      lines.push(style.yellow('Nothing reachable from these root(s).'));
      lines.push(
        style.dim(
          'Either nothing depends on them, or the extractor that would produce the edge did not run.\n' +
            'Check the UNKNOWN section below before concluding the former.',
        ),
      );
      lines.push('');
    } else {
      lines.push(style.bold(`REACHED  ${report.reachedCount} node(s) across ${report.reached.length} kind(s)`));
      lines.push('');
      for (const g of report.reached) {
        lines.push(`  ${style.cyan(g.kind.padEnd(15))} ${g.count}`);
        for (const n of g.nodes) {
          const loc = n.path === null ? '' : `  ${style.dim(printable(n.path))}`;
          lines.push(
            `    ${style.dim(`depth ${n.depth}`.padEnd(9))} ${style.magenta(n.viaEdge.padEnd(16))} ${printable(n.name)}${loc}`,
          );
          lines.push(`             ${style.dim(`${n.provenance} conf ${fmtConfidence(n.confidence)}`)}`);
        }
      }
      lines.push('');
    }
  }

  if (report.truncated) {
    lines.push(style.yellow(`TRUNCATED  ${report.truncationReasons.join(', ')}`));
    lines.push(style.dim('Raise --depth or --limit to see more. This is a cap, not an empty result.'));
    lines.push('');
  }

  if (report.unknown.length > 0) {
    lines.push(style.yellow(`UNKNOWN  ${report.unknown.length} scope(s) did not fully PASS`));
    lines.push(style.dim('A root or node that looks unreachable may just come from a scope that did not run.'));
    for (const u of report.unknown) {
      lines.push(`  ${(u.unreadPackages === undefined ? u.status : 'PARTIAL').padEnd(12)} ${printable(u.scope)}  ${style.dim(`(${printable(u.extractor)})`)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function intOption(v: unknown, fallback: number, flag: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw usageError(`${flag} must be a positive integer, got ${JSON.stringify(v)}.`);
  }
  return n;
}
