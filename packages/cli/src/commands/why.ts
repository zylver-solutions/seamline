/**
 * `seamline why <target>` — the flagship.
 *
 * v3 §1 makes this the acceptance gate: on a repository the user did not
 * annotate, `why` must print a field-lineage chain joining database column,
 * ORM/model field, API schema property, code type field, and validator, with
 * per-hop provenance and confidence, plus the contradictions touching it.
 *
 * The command is deliberately generous about what a target may look like and
 * deliberately strict about ambiguity: it lists candidates rather than picking
 * one, because silently answering about a different `email` column is worse
 * than asking.
 */

import path from 'node:path';
import { describeNarrowedClaim, narrowedClaims, type NarrowedClaim } from '@seamline/core';
import {
  parseNodeId,
  type Contradiction,
  type NodeKind,
  type SeamlineNode,
} from '@seamline/ontology';
import { parseCommandArgs, STORE_OPTION_SPEC } from '../args.ts';
import { styleFor, type Style } from '../colour.ts';
import { loadConfig } from '../config.ts';
import { CliError, EXIT_OK, EXIT_USAGE, notWiredError, usageError } from '../io.ts';
import {
  buildLineage,
  LINEAGE_TARGET_KINDS,
  resolveTarget,
  type LineageChain,
  type LineageResult,
} from '../lineage.ts';
import type { CliDeps, UnknownDetection } from '../ports.ts';
import { degradedScopes, type DegradedScope } from '../scopes.ts';
import { printable } from '@seamline/security';
import { emitJson, emitText, emitTextErr, fmtConfidence } from '../render.ts';
import { resolveStoreDir } from '../store-dir.ts';

export interface WhyReport {
  readonly target: SeamlineNode;
  readonly container: SeamlineNode | null;
  readonly chains: readonly SerializedChain[];
  readonly contradictions: readonly Contradiction[];
  /** False when no detector implementation is wired; distinct from "none found". */
  readonly contradictionsAvailable: boolean;
  /**
   * Detectors that could not run, for a scope that did not PASS or for a reason of their own
   * (`unknownWhen`). `contradictions` lists nothing on their behalf, so an empty list is not a
   * verified negative while this is non-empty.
   */
  readonly unknownDetectors: readonly UnknownDetection[];
  readonly unknown: readonly DegradedScope[];
  /**
   * Scopes that PASSed on a claim narrower than the whole scope, so a
   * "none" above is about the facts that were read. Present only when there
   * is one, so a report over a fully read repository is unchanged.
   */
  readonly narrowedClaims?: readonly NarrowedClaim[];
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
}

export interface SerializedChain {
  readonly confidence: number;
  readonly weakestProvenance: string;
  readonly hops: readonly SerializedHop[];
}

export interface SerializedHop {
  readonly edge: string;
  readonly direction: 'out' | 'in';
  readonly provenance: string;
  readonly confidence: number;
  readonly sourceRef: string | null;
  readonly to: {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
    readonly path: string | null;
  };
}

export async function whyCommand(deps: CliDeps, argv: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    ...STORE_OPTION_SPEC,
    depth: { type: 'string' },
    limit: { type: 'string' },
    kind: { type: 'string' },
  });
  const style = styleFor(deps.io, {
    noColorFlag: parsed.globals.noColor,
    json: parsed.globals.json,
  });

  const raw = parsed.positionals[0];
  if (raw === undefined || raw.length === 0) {
    throw usageError(
      'seamline why needs a target.',
      'Try a column (`users.email`), a NodeId (`myrepo:Column:public.users.email`), or a bare field name.',
    );
  }

  const repoRoot = path.resolve(deps.io.cwd, parsed.globals.repo ?? '.');
  const config = await loadConfig(repoRoot);
  const outDir = resolveStoreDir('why', repoRoot, config, parsed);
  if (deps.store === undefined) throw notWiredError('store', 'why');

  const maxDepth = intOption(parsed.values['depth'], config.limits.maxDepth, '--depth');
  const maxNodes = intOption(parsed.values['limit'], config.limits.maxResults, '--limit');
  const kindFilter = parsed.values['kind'];
  const kinds: readonly NodeKind[] =
    typeof kindFilter === 'string' ? [kindFilter as NodeKind] : LINEAGE_TARGET_KINDS;

  const workspace = await deps.store.open({ repoRoot, outDir, repo: config.repo, create: false });
  try {
    const view = workspace.store;
    const resolved = resolveTarget(view, raw, kinds);

    if (resolved.matches.length === 0) {
      throw new CliError(
        `no column, field, or schema property matches \`${raw}\`.`,
        EXIT_USAGE,
        'Run `seamline extract` first, or check the spelling. `--kind Column` narrows the search.',
      );
    }
    if (resolved.matches.length > 1) {
      return reportAmbiguous(deps, style, raw, resolved.matches, parsed.globals.json);
    }

    const target = resolved.matches[0] as SeamlineNode;
    const lineage = buildLineage(view, target, { maxDepth, maxNodes, maxChains: 40 });

    let contradictions: readonly Contradiction[] = [];
    let contradictionsAvailable = false;
    let unknownDetectors: readonly UnknownDetection[] = [];
    const latest = await workspace.runs.latest();
    if (deps.detectors !== undefined) {
      contradictionsAvailable = true;
      const report = await deps.detectors.run(view, latest);
      unknownDetectors = report.unknown;
      contradictions = report.contradictions.filter(
        (c) => lineage.nodes.has(c.left) || lineage.nodes.has(c.right),
      );
    }

    const unknown = degradedScopes(view, latest);
    const narrowed = narrowedClaims(view, latest);
    const container = lineage.containers.get(target.id) ?? null;

    const report: WhyReport = {
      target,
      container,
      chains: lineage.chains.map((c) => serializeChain(c, lineage)),
      contradictions,
      contradictionsAvailable,
      unknownDetectors,
      unknown,
      ...(narrowed.length > 0 ? { narrowedClaims: narrowed } : {}),
      truncated: lineage.truncated,
      truncationReasons: lineage.truncationReasons,
    };

    if (parsed.globals.json) {
      emitJson(deps.io, report);
      return EXIT_OK;
    }

    emitText(deps.io, style, renderWhy(style, report, lineage));
    return EXIT_OK;
  } finally {
    await workspace.store.close();
  }
}

function serializeChain(c: LineageChain, lineage: LineageResult): SerializedChain {
  return {
    confidence: Number(c.confidence.toFixed(4)),
    weakestProvenance: c.weakestProvenance,
    hops: c.hops.map((h) => {
      const node = lineage.nodes.get(h.to);
      return {
        edge: h.edge,
        direction: h.direction,
        provenance: h.provenance,
        confidence: Number(h.confidence.toFixed(4)),
        sourceRef: h.sourceRef ?? null,
        to: {
          id: h.to,
          kind: node?.kind ?? 'unknown',
          name: node?.name ?? parseNodeId(h.to).canonicalName,
          path: node?.path ?? null,
        },
      };
    }),
  };
}

function renderWhy(style: Style, report: WhyReport, lineage: LineageResult): string {
  const lines: string[] = [];
  const t = report.target;
  const cn = parseNodeId(t.id).canonicalName;

  lines.push(`${style.bold(printable(cn))}  ${style.cyan(t.kind)}`);
  if (report.container !== null) {
    lines.push(`  ${style.dim('in')}       ${report.container.kind} ${printable(report.container.name)}`);
  }
  if (t.path !== undefined) lines.push(`  ${style.dim('at')}       ${printable(t.path)}`);
  lines.push(
    `  ${style.dim('fact')}     ${t.provenance} conf ${fmtConfidence(t.confidence)}  sensitivity ${t.sensitivity}`,
  );
  if (t.untrusted === true) {
    lines.push(
      `  ${style.yellow('untrusted')} this node carries third-party text; it is delimited when served to agents`,
    );
  }
  lines.push('');

  if (report.chains.length === 0) {
    lines.push(style.yellow('No lineage found for this target.'));
    lines.push(
      style.dim(
        'Either nothing joins to it, or the extractor that would produce the join did not run.\nCheck the UNKNOWN section below before concluding the former.',
      ),
    );
  } else {
    lines.push(style.bold(`LINEAGE  ${report.chains.length} chain(s)`));
    lines.push('');
    report.chains.forEach((chain, i) => {
      lines.push(
        `  ${style.dim(`chain ${i + 1}`)}  confidence ${fmtConfidence(chain.confidence)}  weakest ${paintProvenance(style, chain.weakestProvenance)}`,
      );
      lines.push(`    ${style.dim(t.kind.padEnd(15))} ${printable(cn)}`);
      for (const hop of chain.hops) {
        const arrow = hop.direction === 'out' ? '->' : '<-';
        // The canonical name, not the short name: `User.email` tells a reader
        // which model the field is on; `email` does not.
        const label = safeCanonicalName(hop.to.id, hop.to.name);
        lines.push(
          `      ${arrow} ${style.magenta(hop.edge.padEnd(16))} ${style.dim(hop.to.kind.padEnd(15))} ${printable(label)}`,
        );
        const ref = hop.sourceRef === null ? '' : `  ${style.dim(printable(hop.sourceRef))}`;
        lines.push(
          `         ${paintProvenance(style, hop.provenance)} conf ${fmtConfidence(hop.confidence)}${ref}`,
        );
      }
      lines.push('');
    });
  }

  if (lineage.truncated) {
    lines.push(style.yellow(`TRUNCATED  ${lineage.truncationReasons.join('; ')}`));
    lines.push(
      style.dim('Raise --depth or --limit to see more. This is a cap, not an empty result.'),
    );
    lines.push('');
  }

  if (!report.contradictionsAvailable) {
    lines.push(style.dim('CONTRADICTIONS  not checked (no detector wired into this build)'));
  } else if (report.contradictions.length === 0 && report.unknownDetectors.length === 0) {
    lines.push(
      (report.narrowedClaims ?? []).length === 0
        ? `${style.green('CONTRADICTIONS')}  none touching this lineage`
        : `${style.yellow('CONTRADICTIONS')}  none touching this lineage among the facts that were read`,
    );
  } else if (report.contradictions.length === 0) {
    lines.push(`${style.yellow('CONTRADICTIONS')}  none found, but not every detector could run`);
  } else {
    lines.push(style.bold(`CONTRADICTIONS  ${report.contradictions.length} touching this lineage`));
    for (const c of report.contradictions) {
      lines.push(`  ${style.red(c.severity.toUpperCase().padEnd(8))} ${c.code}  ${printable(c.claim)}`);
      lines.push(`           ${style.dim('left ')} ${printable(c.left)}: ${printable(c.leftFact)}`);
      lines.push(`           ${style.dim('right')} ${printable(c.right)}: ${printable(c.rightFact)}`);
    }
  }
  if (report.contradictionsAvailable && report.unknownDetectors.length > 0) {
    lines.push(
      style.yellow(
        `${report.unknownDetectors.length} detector(s) could not run: ${report.unknownDetectors.map((u) => u.code).join(', ')}. Those checks are UNKNOWN, not clean.`,
      ),
    );
    for (const u of report.unknownDetectors) {
      lines.push(`  ${u.code}  ${style.dim(printable(u.reason))}`);
    }
  }
  for (const claim of report.narrowedClaims ?? []) {
    lines.push(`  ${style.yellow('PARTIAL')}  ${printable(describeNarrowedClaim(claim))}`);
  }
  lines.push('');

  if (report.unknown.length > 0) {
    lines.push(style.yellow(`UNKNOWN  ${report.unknown.length} scope(s) did not fully PASS`));
    lines.push(
      style.dim('An absent join below may be a missing scope rather than a missing relationship.'),
    );
    for (const u of report.unknown) {
      lines.push(
        `  ${(u.unreadPackages === undefined ? u.status : 'PARTIAL').padEnd(12)} ${printable(u.scope)}  ${style.dim(`(${printable(u.extractor)})`)}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function safeCanonicalName(id: string, fallback: string): string {
  try {
    return parseNodeId(id as never).canonicalName;
  } catch {
    return fallback;
  }
}

function paintProvenance(style: Style, p: string): string {
  const label = p.padEnd(13);
  if (p === 'EXTRACTED') return style.green(label);
  if (p === 'DECLARED') return style.cyan(label);
  if (p === 'INFERRED') return style.yellow(label);
  return style.dim(label);
}

function reportAmbiguous(
  deps: CliDeps,
  style: Style,
  raw: string,
  matches: readonly SeamlineNode[],
  json: boolean,
): number {
  const candidates = matches
    .slice(0, 25)
    .map((n) => ({ id: n.id, kind: n.kind, name: n.name, path: n.path ?? null }));
  if (json) {
    emitJson(deps.io, {
      error: 'ambiguous-target',
      target: raw,
      candidates,
      total: matches.length,
    });
    return EXIT_USAGE;
  }
  emitTextErr(
    deps.io,
    style,
    `\`${printable(raw)}\` matches ${matches.length} nodes. Re-run with a full NodeId or --kind:\n\n` +
      `${candidates.map((c) => `  ${style.cyan(c.kind.padEnd(15))} ${printable(c.id)}`).join('\n')}\n` +
      (matches.length > candidates.length
        ? `  ... and ${matches.length - candidates.length} more\n`
        : ''),
  );
  return EXIT_USAGE;
}

function intOption(v: unknown, fallback: number, flag: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw usageError(`${flag} must be a positive integer, got ${JSON.stringify(v)}.`);
  }
  return n;
}
