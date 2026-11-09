/**
 * Everything the server hands a tool besides the graph, passed through the
 * export profile.
 *
 * `profileView` covers nodes and edges. Two other inputs reach a tool: the
 * latest run record and the detector's report. Both can carry free text about
 * the store (an extractor diagnostic naming a file and a field, a finding's
 * prose naming a column) that the profile cannot evaluate, so neither is
 * forwarded as-is:
 *
 *   - run diagnostics are dropped; a degraded scope still reaches the agent as
 *     scope, status and producing extractor, which is what UNKNOWN needs;
 *   - a finding is kept only when both endpoints are in the view and every
 *     edge kind on its path is one the profile allows, and its claim and facts
 *     are re-rendered from the profiled nodes;
 *   - an undetermined detector keeps only scopes the run record declares, and
 *     its reason is re-rendered from those scopes' status, or, when no scope
 *     blocked it and the code scope left workspace packages unread, from the
 *     count of them (never their names).
 *
 * The profile itself is validated and pinned (a deep-frozen copy) when the
 * server starts, so a malformed profile is refused up front and the caller's
 * object cannot change what the server admits afterwards. It is the same
 * format and the same parser `seamline export` loads (docs/design/export-profile.md).
 */

import { parseExportProfile, type ExportProfile } from '@seamline/core';
import {
  CONTRADICTION_CODES,
  type Contradiction,
  type ExtractorStatus,
  type GraphView,
  type NodeId,
  type RunRecord,
  type SeamlineNode,
  type Severity,
} from '@seamline/ontology';
import type { DetectionReport, UnknownDetection } from './ports.ts';
import { neutralize } from '@seamline/security';

const KNOWN_SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

/**
 * The profile the server pins: `parseExportProfile`, the one parser every
 * consumer of the format loads through. It copies `candidate` to plain data
 * first, then validates the copy, and returns it deep-frozen, so validating
 * the caller's object and then copying it can never read an accessor twice.
 */
export function pinProfile(candidate: unknown): ExportProfile {
  return parseExportProfile(candidate);
}

/** The run record with every extractor diagnostic removed. */
export function withoutDiagnostics(run: RunRecord | undefined): RunRecord | undefined {
  if (run === undefined) return undefined;
  return { ...run, results: run.results.map((r) => ({ ...r, diagnostics: [] })) };
}

/** A detection report reduced to what the profile view can vouch for. */
export function profiledDetection(
  report: DetectionReport,
  view: GraphView,
  profile: ExportProfile,
  run: RunRecord | undefined,
): DetectionReport {
  const contradictions: Contradiction[] = [];
  for (const c of report.contradictions) {
    if (!isCode(c.code) || !isSeverity(c.severity)) continue;
    if (typeof c.confidence !== 'number' || !(c.confidence >= 0 && c.confidence <= 1)) continue;
    // A real array of known edge kinds, checked element by element: an
    // array-like object can answer `every` however it likes.
    if (!Array.isArray(c.viaPath)) continue;
    const viaPath: string[] = [...(c.viaPath as unknown[])].filter((k): k is string => typeof k === 'string');
    if (viaPath.length !== c.viaPath.length) continue;
    if (!viaPath.every((kind) => (profile.allowEdges as readonly string[]).includes(kind))) continue;
    const left = view.node(c.left as NodeId);
    const right = view.node(c.right as NodeId);
    if (left === undefined || right === undefined) continue;
    const via = viaPath.length === 0 ? 'directly' : `via ${viaPath.join(' > ')}`;
    contradictions.push({
      code: c.code,
      severity: c.severity,
      left: left.id,
      right: right.id,
      claim: `${c.code}: ${label(left)} and ${label(right)}, joined ${via}, disagree`,
      leftFact: fact(left),
      rightFact: fact(right),
      viaPath: viaPath as Contradiction['viaPath'],
      confidence: c.confidence,
    });
  }

  const declared = new Set<string>();
  for (const result of run?.results ?? [])
    for (const a of result.authoritative) declared.add(a.scope);

  const unknown: UnknownDetection[] = [];
  for (const u of report.unknown) {
    if (!isCode(u.code) || !isSeverity(u.severity)) continue;
    const listed: unknown[] = Array.isArray(u.scopes) ? [...(u.scopes as unknown[])] : [];
    const scopes = [...new Set(listed.filter((s): s is string => typeof s === 'string' && declared.has(s)))].sort();
    const scopeStatus: Record<string, ExtractorStatus> = {};
    for (const s of scopes) scopeStatus[s] = statusOf(view, s);
    // Only the count crosses: the names of unread directories are repository
    // paths the profile has not evaluated.
    const unread = u.unreadCodePackages;
    const unreadCount = typeof unread === 'number' && Number.isInteger(unread) && unread > 0 ? unread : 0;
    unknown.push({
      code: u.code,
      severity: u.severity,
      // `SCOPE_NOT_PASS` is declared in `packages/contradictions/src/runner.ts`, which starts every
      // reason it writes with it. This package depends on `core` and `ontology` only, so the code
      // is repeated here; a test in `profile.test.ts` reads the runner and fails if they differ.
      reason:
        scopes.length > 0
          ? `SCOPE_NOT_PASS: scope(s) not PASS: ${scopes.map((s) => `${s}=${scopeStatus[s] ?? 'UNAVAILABLE'}`).join(', ')}`
          : unreadCount > 0
            ? `SCOPE_NOT_PASS: code.ts did not read ${unreadCount} workspace package(s)`
            : listed.length > 0
              ? 'SCOPE_NOT_PASS: a scope this detector requires did not PASS'
              : // No scope at all and no unread package: the detector stood down for a reason of its
                // own (`unknownWhen`), read from facts the extractors recorded. Its text is the
                // detector's, so it is not passed on, and it is not a scope either.
                'the extractors recorded facts that leave this detector unable to answer',
      scopes,
      scopeStatus,
      ...(unreadCount > 0 && scopes.length === 0 ? { unreadCodePackages: unreadCount } : {}),
    });
  }

  return { contradictions, unknown };
}

function isCode(v: unknown): v is Contradiction['code'] {
  return (CONTRADICTION_CODES as readonly unknown[]).includes(v);
}

function isSeverity(v: unknown): v is Severity {
  return (KNOWN_SEVERITIES as readonly unknown[]).includes(v);
}

function statusOf(view: GraphView, scope: string): ExtractorStatus {
  try {
    return view.scopeStatus(scope);
  } catch {
    return 'UNAVAILABLE';
  }
}

/** `Kind name`, from the profiled node. Untrusted names are neutralized. */
function label(n: SeamlineNode): string {
  return `${n.kind} ${n.untrusted === true ? neutralize(n.name) : n.name}`;
}

/** The node's label plus the props the profile released, `key=value`, sorted. */
function fact(n: SeamlineNode): string {
  const props = Object.keys(n.props)
    .sort()
    .map((k) => {
      const v = n.props[k];
      const text = String(v);
      return `${k}=${typeof v === 'string' && n.untrusted === true ? neutralize(text) : text}`;
    });
  return props.length === 0 ? label(n) : `${label(n)}: ${props.join(', ')}`;
}
