/**
 * `seamline export --profile <name>`: default-deny export.
 *
 * v3 §2.5. What this tool builds is, in one queryable file, the complete
 * attack map of an organization: every entry point, every endpoint's auth mode
 * including the null ones, every secret reference and the function that reads
 * it, the ownership map. There is no "export everything", and no profile means
 * no output; the command refuses and says why.
 *
 * A profile is the one export profile format of `@seamline/core`
 * (`docs/design/export-profile.md`): a shipped profile (`public`, `team`,
 * `audit`) or one declared under `exportProfiles` in `seamline.config.json`.
 * It is parsed by `parseExportProfile` when the config loads, and applied here
 * by `applyProfile`, the same rule `seamline mcp` serves every tool through.
 * Anything the profile does not name is dropped.
 *
 * INTEGRATION POINT: v3 §2.5 also specifies a `Redactor` that runs post-merge
 * as the sole writer to the store, so values reaching this command are already
 * secret-free. This command does not re-implement that; it enforces the
 * allow-list. If the Redactor is bypassed, this is not a second line of
 * defence for secret *values*; it is one only for kinds, fields, and sensitivity.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyProfile,
  ExportPolicyError,
  getProfile,
  profileNames,
  type ExportProfile,
  type ReleasedEdge,
  type ReleasedNode,
} from '@seamline/core';
import { NODE_KINDS, type SeamlineEdge, type SeamlineNode } from '@seamline/ontology';
import { parseCommandArgs, STORE_OPTION_SPEC } from '../args.ts';
import { styleFor } from '../colour.ts';
import { loadConfig, type SeamlineConfig } from '../config.ts';
import { CliError, EXIT_OK, EXIT_USAGE, notWiredError } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { printable } from '@seamline/security';
import { emitJson, emitText, emitTextErr } from '../render.ts';
import { resolveStoreDir } from '../store-dir.ts';

/** What was withheld, by count only. Ids of withheld items never leave through this report. */
export interface ExportReport {
  readonly profile: string;
  /** Each carries only the fields the profile names in `allowFields`. */
  readonly nodes: readonly ReleasedNode[];
  readonly edges: readonly ReleasedEdge[];
  readonly withheld: {
    readonly nodes: number;
    readonly edges: number;
    readonly byReason: Readonly<Record<string, number>>;
  };
}

export async function exportCommand(deps: CliDeps, argv: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    ...STORE_OPTION_SPEC,
    profile: { type: 'string' },
    'list-profiles': { type: 'boolean', default: false },
  });
  const style = styleFor(deps.io, {
    noColorFlag: parsed.globals.noColor,
    json: parsed.globals.json,
  });

  const repoRoot = path.resolve(deps.io.cwd, parsed.globals.repo ?? '.');
  const config = await loadConfig(repoRoot);

  if (parsed.values['list-profiles'] === true) {
    return listProfiles(deps, config, parsed.globals.json);
  }

  const profileName = parsed.values['profile'];
  if (typeof profileName !== 'string' || profileName.length === 0) {
    throw refusal(config);
  }

  const profile = resolveProfile(config, profileName);

  if (deps.store === undefined) throw notWiredError('store', 'export');
  // `--out` is the destination file here and never selects the store: the
  // store is `--store`, else the config's outDir (see `resolveStoreDir`).
  const storeDir = resolveStoreDir('export', repoRoot, config, parsed);
  const workspace = await deps.store.open({
    repoRoot,
    outDir: storeDir,
    repo: config.repo,
    create: false,
  });

  let report: ExportReport;
  try {
    report = exportThrough(workspace.store, profile);
  } finally {
    await workspace.store.close();
  }

  const destination = parsed.globals.out;
  const payload = `${JSON.stringify({ profile: report.profile, nodes: report.nodes, edges: report.edges }, null, 2)}\n`;

  if (destination !== undefined) {
    const file = path.resolve(repoRoot, destination);
    await writeFile(file, payload, 'utf8');
    if (parsed.globals.json) {
      emitJson(deps.io, {
        profile: report.profile,
        written: file,
        nodes: report.nodes.length,
        edges: report.edges.length,
        withheld: report.withheld,
      });
    } else {
      emitText(
        deps.io,
        style,
        `${style.green('wrote')} ${printable(file)}\n  profile ${style.bold(profileName)}: ${report.nodes.length} nodes, ${report.edges.length} edges\n` +
          `  ${style.dim(describeExclusions(report))}\n`,
      );
    }
    return EXIT_OK;
  }

  deps.io.out(payload);
  if (!parsed.globals.json) {
    emitTextErr(deps.io, style, `${describeExclusions(report)}\n`);
  }
  return EXIT_OK;
}

/**
 * The one way a profile name becomes a profile, for `export` and `mcp` alike:
 * a shipped profile or one the config declares. An unknown name is an error,
 * never a fallback.
 */
export function resolveProfile(config: SeamlineConfig, name: string): ExportProfile {
  try {
    return getProfile(name, config.exportProfiles);
  } catch (e) {
    if (e instanceof ExportPolicyError) {
      throw new CliError(
        `no export profile named ${JSON.stringify(name.slice(0, 80))}.`,
        EXIT_USAGE,
        `Available profiles: ${availableProfiles(config)}. Declare one in seamline.config.json under "exportProfiles".`,
      );
    }
    throw e;
  }
}

/** Every name `--profile` accepts here: shipped profiles, then declared ones. */
export function availableProfiles(config: SeamlineConfig): string {
  return profileNames(config.exportProfiles).join(', ');
}

/** The refusal. Separate function so the message is one place and testable. */
export function refusal(config: SeamlineConfig): CliError {
  return new CliError(
    'export requires --profile. Export is default-deny: there is no "export everything".',
    EXIT_USAGE,
    `The graph is a concentrated map of this repository's attack surface, so a profile must name\n` +
      `exactly what may leave it. Available profiles: ${availableProfiles(config)}\n` +
      `Run \`seamline export --list-profiles\` for details.`,
  );
}

function listProfiles(deps: CliDeps, config: SeamlineConfig, json: boolean): number {
  const entries = profileNames(config.exportProfiles).map(
    (n) => [n, getProfile(n, config.exportProfiles)] as const,
  );
  if (json) {
    emitJson(deps.io, { profiles: Object.fromEntries(entries) });
    return EXIT_OK;
  }
  const lines: string[] = [];
  for (const [name, p] of entries) {
    const shipped = config.exportProfiles[name] === undefined;
    lines.push(`${name}${shipped ? ' (shipped)' : ''}`);
    if (p.description.length > 0) lines.push(`  ${printable(p.description)}`);
    const levels = new Map<string, string[]>();
    for (const [k, s] of p.allow) levels.set(k, [...(levels.get(k) ?? []), s]);
    lines.push(
      `  nodes            ${[...levels].map(([k, s]) => `${k}@${s.join('|')}`).join(', ')}`,
    );
    lines.push(`  edge kinds       ${p.allowEdges.join(', ') || '(none)'}`);
    lines.push(`  node props       ${describeProps(p.allowProps)}`);
    lines.push(`  edge props       ${describeProps(p.allowEdgeProps)}`);
    lines.push(`  fields           ${p.allowFields.join(', ') || '(none)'}`);
    lines.push(`  provenance       ${p.allowProvenance.join(', ')}`);
    lines.push(`  untrusted text   ${p.includeUntrusted ? 'included' : 'excluded'}`);
    lines.push('');
  }
  deps.io.out(lines.join('\n'));
  return EXIT_OK;
}

function describeProps(
  props: Readonly<Record<string, readonly string[] | '*' | undefined>>,
): string {
  const parts = Object.entries(props).map(
    ([k, v]) => `${k}=${v === '*' ? '*' : (v ?? []).join('|') || '(none)'}`,
  );
  return printable(parts.join(', ')) || '(none)';
}

interface MinimalView {
  nodesByKind(kind: SeamlineNode['kind']): ReadonlyArray<SeamlineNode>;
  edgesFrom(id: SeamlineNode['id'], kind?: SeamlineEdge['kind']): ReadonlyArray<SeamlineEdge>;
}

/**
 * Read every live node and edge from `view` and release what `profile` admits,
 * with `applyProfile`: the same rule `seamline mcp` serves reads through.
 * Tombstoned records are never offered to the policy.
 */
export function exportThrough(view: MinimalView, profile: ExportProfile): ExportReport {
  const nodes: SeamlineNode[] = [];
  for (const kind of NODE_KINDS) {
    for (const n of view.nodesByKind(kind)) if (n.deletedAt === null) nodes.push(n);
  }
  const seen = new Set<string>();
  const edges: SeamlineEdge[] = [];
  for (const n of nodes) {
    for (const e of view.edgesFrom(n.id)) {
      const key = `${e.src}|${e.dst}|${e.kind}`;
      if (e.deletedAt !== null || seen.has(key)) continue;
      seen.add(key);
      edges.push(e);
    }
  }
  const result = applyProfile(nodes, edges, profile);
  return {
    profile: result.profile,
    nodes: result.nodes,
    edges: result.edges,
    withheld: {
      nodes: result.withheld.nodes,
      edges: result.withheld.edges,
      byReason: result.withheld.byReason,
    },
  };
}

function describeExclusions(r: ExportReport): string {
  const reasons = Object.entries(r.withheld.byReason)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, n]) => `${n} ${reason}`);
  return `withheld: ${r.withheld.nodes} nodes, ${r.withheld.edges} edges${reasons.length === 0 ? '' : ` (${reasons.join(', ')})`}`;
}
