/**
 * Findings: stable ids, and reading `seamline check --json`.
 *
 * The id is `sha256(repo|code|left|right)` truncated to 16 hex characters.
 * `left` and `right` are node ids that carry no path (invariant 1; no detector
 * puts a `File` id in either), so the id of a finding survives a `git mv` that
 * changes no id of the nodes it names (ADR-0016 item 4 says which moves do) and is
 * the same in an unmodified run and in a mutated copy of the same repository,
 * which is what lets a mutant be recognised as "absent before, present now".
 */

import { createHash } from 'node:crypto';
import { CONTRADICTION_CODES, type ContradictionCode, type Severity } from '@seamline/ontology';
import { ConfigError } from './errors.ts';
import type { DetectorOutcome, Finding } from './types.ts';

const SEVERITIES: readonly string[] = ['critical', 'high', 'medium', 'low'];

export function findingId(repo: string, code: string, left: string, right: string): string {
  return createHash('sha256').update(`${repo}|${code}|${left}|${right}`).digest('hex').slice(0, 16);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Total order used everywhere findings are listed. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    cmp(a.code, b.code) ||
    cmp(a.repo, b.repo) ||
    cmp(a.left, b.left) ||
    cmp(a.right, b.right) ||
    cmp(a.id, b.id)
  );
}

/**
 * Collapses raw contradictions that share an id into one finding.
 *
 * A detector may report the same pair more than once (for example X3 on two
 * dimensions). A label applies to the id, so the evaluation counts it once;
 * `occurrences` keeps the raw count visible. The representative is the first
 * in the total order of claims, and its confidence is the highest seen, so the
 * choice does not depend on input order.
 */
export function dedupeFindings(findings: readonly Finding[]): readonly Finding[] {
  const byId = new Map<string, Finding[]>();
  for (const f of findings) {
    const bucket = byId.get(f.id);
    if (bucket === undefined) byId.set(f.id, [f]);
    else bucket.push(f);
  }
  const out: Finding[] = [];
  for (const bucket of byId.values()) {
    const sorted = bucket
      .slice()
      .sort(
        (a, b) =>
          cmp(a.claim, b.claim) || cmp(a.leftFact, b.leftFact) || cmp(a.rightFact, b.rightFact),
      );
    const first = sorted[0];
    if (first === undefined) continue;
    const occurrences = sorted.reduce((n, f) => n + f.occurrences, 0);
    const confidence = Math.max(...sorted.map((f) => f.confidence));
    out.push({ ...first, confidence, occurrences });
  }
  return out.sort(compareFindings);
}

export interface ParsedCheck {
  readonly findings: readonly Finding[];
  /** Per detector: UNKNOWN reasons the CLI reported. */
  readonly unknown: ReadonlyMap<ContradictionCode, string>;
  readonly degradedScopes: readonly string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(rec: Record<string, unknown>, key: string, where: string): string {
  const v = rec[key];
  if (typeof v !== 'string') throw new ConfigError(`${where}: "${key}" must be a string.`);
  return v;
}

function isCode(v: string): v is ContradictionCode {
  return (CONTRADICTION_CODES as readonly string[]).includes(v);
}

/** Parses the JSON that `seamline check --json` prints. Throws on a shape it does not know. */
export function parseCheckOutput(repo: string, raw: unknown): ParsedCheck {
  if (!isRecord(raw) || !Array.isArray(raw['contradictions'])) {
    throw new ConfigError('check output has no "contradictions" array.');
  }
  const findings: Finding[] = [];
  raw['contradictions'].forEach((item, index) => {
    const where = `check output contradictions[${index}]`;
    if (!isRecord(item)) throw new ConfigError(`${where}: must be an object.`);
    const code = str(item, 'code', where);
    if (!isCode(code)) throw new ConfigError(`${where}: unknown contradiction code "${code}".`);
    const severity = str(item, 'severity', where);
    if (!SEVERITIES.includes(severity)) throw new ConfigError(`${where}: unknown severity.`);
    const confidence = item['confidence'];
    if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) {
      throw new ConfigError(`${where}: "confidence" must be a number in [0, 1].`);
    }
    const left = str(item, 'left', where);
    const right = str(item, 'right', where);
    const via = item['viaPath'];
    findings.push({
      id: findingId(repo, code, left, right),
      repo,
      code,
      severity: severity as Severity,
      left,
      right,
      claim: str(item, 'claim', where),
      leftFact: str(item, 'leftFact', where),
      rightFact: str(item, 'rightFact', where),
      viaPath: Array.isArray(via) ? via.filter((v): v is string => typeof v === 'string') : [],
      confidence,
      occurrences: 1,
    });
  });

  const unknown = new Map<ContradictionCode, string>();
  const unknownRaw = raw['unknownDetectors'];
  if (Array.isArray(unknownRaw)) {
    for (const u of unknownRaw) {
      if (!isRecord(u) || typeof u['code'] !== 'string' || !isCode(u['code'])) continue;
      unknown.set(
        u['code'],
        typeof u['reason'] === 'string' ? u['reason'] : 'detector did not run',
      );
    }
  }

  const degradedRaw = raw['degradedScopes'];
  const degraded = new Set<string>();
  if (Array.isArray(degradedRaw)) {
    for (const d of degradedRaw) {
      if (isRecord(d) && typeof d['scope'] === 'string') degraded.add(d['scope']);
    }
  }

  return {
    findings: dedupeFindings(findings),
    unknown,
    degradedScopes: [...degraded].sort(cmp),
  };
}

/** Every detector's outcome on one repository, from a parsed `check` run. */
export function detectorOutcomes(
  findings: readonly Finding[],
  unknown: ReadonlyMap<ContradictionCode, string>,
): Readonly<Record<ContradictionCode, DetectorOutcome>> {
  const out = {} as Record<ContradictionCode, DetectorOutcome>;
  for (const code of CONTRADICTION_CODES) {
    const reason = unknown.get(code);
    if (reason !== undefined) {
      out[code] = { state: 'unknown', findings: 0, reason };
      continue;
    }
    const n = findings.filter((f) => f.code === code).length;
    out[code] = { state: n > 0 ? 'fired' : 'clean', findings: n };
  }
  return out;
}

/** Every detector UNKNOWN, for a repository the harness could not analyse. */
export function allUnknown(reason: string): Readonly<Record<ContradictionCode, DetectorOutcome>> {
  const out = {} as Record<ContradictionCode, DetectorOutcome>;
  for (const code of CONTRADICTION_CODES) out[code] = { state: 'unknown', findings: 0, reason };
  return out;
}
