/**
 * `seamline check` — report contradictions.
 *
 * Three outcomes, not two:
 *   - CLEAN   every detector ran and found nothing.        exit 0
 *   - UNKNOWN at least one detector could not run.         exit 0, reported loudly
 *   - FINDING at least one critical/high contradiction.    exit 1
 *
 * The middle one is the whole point. v3 §2.2: a detector whose required scope
 * did not PASS has not found that you are clean, and reporting it as clean is
 * how infrastructure flakiness turns into false confidence. It also must not
 * fail the build on its own — that is how a CI gate gets switched off.
 */

import path from 'node:path';
import {
  compareCodeUnits,
  describeNarrowedClaim,
  narrowedClaims,
  type NarrowedClaim,
} from '@seamline/core';
import type { Contradiction, ContradictionCode, Severity } from '@seamline/ontology';
import { parseCommandArgs, STORE_OPTION_SPEC } from '../args.ts';
import { styleFor, type Style } from '../colour.ts';
import { loadConfig } from '../config.ts';
import { EXIT_FINDINGS, EXIT_OK, notWiredError, usageError } from '../io.ts';
import type { CliDeps, DetectorNotes, UnknownDetection } from '../ports.ts';
import { printable } from '@seamline/security';
import { emitJson, emitText, failsBuild, paintSeverity, SEVERITY_ORDER, severityRank } from '../render.ts';
import { degradedScopes, type DegradedScope } from '../scopes.ts';
import { resolveStoreDir } from '../store-dir.ts';

export type CheckOutcome = 'clean' | 'unknown' | 'findings';

export interface CheckReport {
  /** `clean` only when every detector ran and found nothing. */
  readonly outcome: CheckOutcome;
  readonly contradictions: readonly Contradiction[];
  readonly counts: Readonly<Record<Severity, number>>;
  readonly unknownDetectors: readonly UnknownDetection[];
  readonly degradedScopes: readonly DegradedScope[];
  /**
   * What detectors that ran did not evaluate (X5's withheld tables). No findings with notes is not
   * the same as clean for the inputs named: they were not checked. The exit code ignores them.
   */
  readonly detectorNotes: readonly DetectorNotes[];
  /** Scopes that passed on a narrower claim; preserved independently of detector notes. */
  readonly narrowedClaims?: readonly NarrowedClaim[];
  readonly exitCode: number;
}

export async function checkCommand(deps: CliDeps, argv: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    ...STORE_OPTION_SPEC,
    severity: { type: 'string' },
    code: { type: 'string', multiple: true },
  });
  const style = styleFor(deps.io, {
    noColorFlag: parsed.globals.noColor,
    json: parsed.globals.json,
  });

  const repoRoot = path.resolve(deps.io.cwd, parsed.globals.repo ?? '.');
  const config = await loadConfig(repoRoot);
  const outDir = resolveStoreDir('check', repoRoot, config, parsed);
  if (deps.store === undefined) throw notWiredError('store', 'check');
  if (deps.detectors === undefined) throw notWiredError('detector runner', 'check');

  const minSeverity = severityOption(parsed.values['severity']);
  const codes = Array.isArray(parsed.values['code'])
    ? (parsed.values['code'] as ContradictionCode[])
    : [];

  const workspace = await deps.store.open({ repoRoot, outDir, repo: config.repo, create: false });
  let report: CheckReport;
  try {
    const latest = await workspace.runs.latest();
    const detection = await deps.detectors.run(workspace.store, latest);
    const contradictions = detection.contradictions
      .filter((c) => severityRank(c.severity) >= severityRank(minSeverity))
      .filter((c) => codes.length === 0 || codes.includes(c.code))
      .slice()
      .sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          compareCodeUnits(a.code, b.code) ||
          compareCodeUnits(a.left, b.left) ||
          compareCodeUnits(a.right, b.right),
      );

    const scopes = degradedScopes(workspace.store, latest);
    report = buildReport(contradictions, detection.unknown, scopes, narrowedClaims(workspace.store, latest), detection.notes ?? []);
  } finally {
    await workspace.store.close();
  }

  if (parsed.globals.json) {
    emitJson(deps.io, report);
    return report.exitCode;
  }

  emitText(deps.io, style, renderCheck(style, report));
  return report.exitCode;
}

export function buildReport(
  contradictions: readonly Contradiction[],
  unknownDetectors: readonly UnknownDetection[],
  scopes: readonly DegradedScope[],
  narrowed: readonly NarrowedClaim[] = [],
  detectorNotes: readonly DetectorNotes[] = [],
): CheckReport {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const c of contradictions) counts[c.severity] += 1;

  const blocking = contradictions.some((c) => failsBuild(c.severity));
  const degraded = unknownDetectors.length > 0 || scopes.length > 0;

  // Precedence: a real finding outranks UNKNOWN in the summary, but UNKNOWN
  // still outranks clean. UNKNOWN never contributes to the exit code.
  const outcome: CheckOutcome =
    contradictions.length > 0 ? 'findings' : degraded ? 'unknown' : 'clean';

  return {
    outcome,
    contradictions,
    counts,
    unknownDetectors,
    degradedScopes: scopes,
    detectorNotes,
    ...(narrowed.length > 0 ? { narrowedClaims: narrowed } : {}),
    exitCode: blocking ? EXIT_FINDINGS : EXIT_OK,
  };
}

function renderCheck(style: Style, report: CheckReport): string {
  const lines: string[] = [];

  const narrowed = report.narrowedClaims ?? [];
  if (report.contradictions.length === 0) {
    lines.push(
      report.outcome === 'clean'
        ? report.detectorNotes.length === 0
          ? narrowed.length === 0
            ? `${style.green('CLEAN')}  every detector ran; no contradictions found.`
            : `${style.green('CLEAN')}  every detector ran; no contradictions found among the facts it read.`
          : `${style.green('CLEAN')}  every detector ran; no contradictions found, but see the notes below for what a detector did not evaluate.`
        : `${style.yellow('UNKNOWN')}  no contradictions found, but not every detector could run.`,
    );
  } else {
    for (const c of report.contradictions) {
      lines.push(`${paintSeverity(style, c.severity)} ${style.bold(c.code)}  ${printable(c.claim)}`);
      lines.push(`         ${style.dim('left ')} ${printable(c.left)}`);
      lines.push(`                ${printable(c.leftFact)}`);
      lines.push(`         ${style.dim('right')} ${printable(c.right)}`);
      lines.push(`                ${printable(c.rightFact)}`);
      if (c.viaPath.length > 0)
        lines.push(`         ${style.dim('via  ')} ${c.viaPath.join(' -> ')}`);
      lines.push('');
    }
    const summary = SEVERITY_ORDER.slice()
      .reverse()
      .filter((s) => report.counts[s] > 0)
      .map((s) => `${report.counts[s]} ${s}`)
      .join(', ');
    lines.push(`${report.contradictions.length} contradiction(s): ${summary}`);
  }

  if (report.detectorNotes.length > 0) {
    lines.push('');
    lines.push(style.yellow('NOT EVALUATED: no finding here is not the same as clean'));
    for (const d of report.detectorNotes) {
      for (const note of d.notes) lines.push(`  ${style.bold(d.code)}  ${printable(note)}`);
    }
  }

  if (report.unknownDetectors.length > 0 || report.degradedScopes.length > 0) {
    lines.push('');
    lines.push(style.yellow('UNKNOWN — not the same as clean'));
    for (const u of report.unknownDetectors) {
      lines.push(`  ${style.bold(u.code)}  ${printable(u.reason)}`);
      for (const s of u.scopes) {
        lines.push(`      scope ${printable(s)}: ${u.scopeStatus[s] ?? 'UNAVAILABLE'}`);
      }
    }
    for (const s of report.degradedScopes) {
      lines.push(`  scope ${printable(s.scope)}: ${s.unreadPackages === undefined ? s.status : 'PARTIAL'} (${printable(s.extractor)})`);
      for (const d of s.diagnostics) lines.push(`      ${style.dim(printable(d))}`);
    }
    lines.push(
      style.dim('These detectors did not run. They have not reported that you are clean, and they'),
    );
    const standDown = report.unknownDetectors.some((u) => u.scopes.length === 0);
    const scopeBlocked =
      report.unknownDetectors.some((u) => u.scopes.length > 0) || report.degradedScopes.length > 0;
    lines.push(
      style.dim(
        'do not fail this build on their own.' +
          (scopeBlocked ? ' Fix the extractor, then re-check.' : '') +
          (standDown
            ? ' A detector with a reason and no scope stood down on facts the extractors recorded; it speaks again when those facts change.'
            : ''),
      ),
    );
  }

  if (narrowed.length > 0) {
    lines.push('');
    lines.push(style.yellow('PARTIAL COVERAGE: not the same as complete'));
    for (const claim of narrowed) lines.push(`  ${printable(describeNarrowedClaim(claim))}`);
    lines.push(
      style.dim('Facts that an earlier run read from those files stay in the graph until they can be read again.'),
    );
  }

  lines.push('');
  return lines.join('\n');
}

function severityOption(v: unknown): Severity {
  if (v === undefined) return 'low';
  if (typeof v === 'string' && (SEVERITY_ORDER as readonly string[]).includes(v))
    return v as Severity;
  throw usageError(`--severity must be one of: ${SEVERITY_ORDER.join(', ')}.`);
}
