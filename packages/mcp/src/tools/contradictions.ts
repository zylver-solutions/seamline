/**
 * `contradictions(filter)` — two authoritative facts that disagree.
 *
 * Never a gap, never "you failed to declare something" (v3 §1). Two things the
 * repository already states, which cannot both be true.
 *
 * The distinction this tool must not lose: a detector that could not run has
 * NOT reported that the code is clean. When no detector is wired at all, or a
 * required scope did not PASS or it stood down for its own reason, the response says so instead of
 * returning `[]`.
 */

import { compareCodeUnits, describeNarrowedClaim } from '@seamline/core';
import { CONTRADICTION_CODES, type NodeId } from '@seamline/ontology';
import { capList, fitToByteBudget, mergeTruncation, NOT_TRUNCATED } from '../bounds.ts';
import { envelope, unknownScopes } from '../result.ts';
import type { ToolDefinition } from './registry.ts';

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
const SEVERITY_RANK: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

interface Params {
  readonly severity?: string;
  readonly codes?: readonly string[];
  readonly nodeId?: string;
  readonly limit?: number;
}

export const contradictionsTool: ToolDefinition<Params> = {
  name: 'contradictions',
  title: 'Contradictions',
  description:
    'List contradictions: pairs of authoritative facts in this repository that disagree (for example a NOT NULL column ' +
    'exposed as an optional API property). Each cites both facts. A detector that could not run, because a scope it ' +
    'requires did not PASS or because the extractors recorded facts that leave it unable to answer, is reported in ' +
    '`unknownDetectors` and in the notices: an empty list is not proof the code is clean.',
  schema: {
    severity: {
      kind: 'string',
      required: false,
      description: 'Minimum severity to return.',
      maxLength: 16,
      choices: SEVERITIES,
    },
    codes: {
      kind: 'stringArray',
      required: false,
      description: 'Restrict to specific contradiction codes.',
      maxItems: 10,
      maxLength: 32,
      choices: CONTRADICTION_CODES,
    },
    nodeId: {
      kind: 'string',
      required: false,
      description: 'Only contradictions citing this node on either side.',
      maxLength: 512,
    },
    limit: {
      kind: 'integer',
      required: false,
      description: 'Maximum findings to return. Clamped to the server ceiling.',
      min: 1,
      max: 500,
      fallback: 50,
    },
  },
  readOnly: true,
  async run(params, ctx) {
    const unknown = unknownScopes(ctx.view, ctx.run);

    if (ctx.detect === undefined) {
      return envelope(
        'contradictions',
        { available: false, findings: [], unknownDetectors: [] },
        {
          state: NOT_TRUNCATED,
          unknown,
          notices: [
            'DETECTION UNAVAILABLE: no contradiction detector is wired into this server. ' +
              'This is not a clean result — no detector ran.',
          ],
        },
      );
    }

    const report = await ctx.detect();
    const minRank = SEVERITY_RANK[params.severity ?? 'low'] ?? 0;
    const codes = params.codes === undefined ? undefined : new Set(params.codes);
    const node = params.nodeId as NodeId | undefined;

    const findings = report.contradictions
      .filter((c) => (SEVERITY_RANK[c.severity] ?? 0) >= minRank)
      .filter((c) => codes === undefined || codes.has(c.code))
      .filter((c) => node === undefined || c.left === node || c.right === node)
      .slice()
      .sort(
        (a, b) =>
          (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
          compareCodeUnits(a.code, b.code) ||
          compareCodeUnits(a.left, b.left),
      );

    const limit = Math.min(params.limit ?? ctx.bounds.maxResults, ctx.bounds.maxResults);
    const capped = capList(findings, limit);

    const build = (kept: readonly (typeof findings)[number][]): unknown => ({
      available: true,
      total: findings.length,
      findings: kept.map((c) => ({
        code: c.code,
        severity: c.severity,
        claim: c.claim,
        left: c.left,
        leftFact: c.leftFact,
        right: c.right,
        rightFact: c.rightFact,
        viaPath: c.viaPath,
        confidence: c.confidence,
      })),
      unknownDetectors: report.unknown.map((u) => ({
        code: u.code,
        severity: u.severity,
        reason: u.reason,
        scopes: u.scopes,
        scopeStatus: u.scopeStatus,
      })),
    });

    const fitted = fitToByteBudget(capped.items, build, ctx.bounds.maxBytes, mergeTruncation(NOT_TRUNCATED, capped.state));

    const notices: string[] = [];
    if (report.unknown.length > 0) {
      notices.push(
        `${report.unknown.length} detector(s) could not run: ${report.unknown.map((u) => u.code).join(', ')}. ` +
          'Those checks are UNKNOWN, not clean.',
      );
    }
    // A scope can PASS on a claim narrower than the whole scope. What the list
    // says (or does not say) is then about the facts that were read.
    for (const claim of ctx.narrowed) {
      notices.push(
        `PARTIAL COVERAGE: ${describeNarrowedClaim(claim)}. An empty list is not proof of a clean result.`,
      );
    }

    return envelope('contradictions', fitted.body, {
      state: fitted.state,
      unknown,
      notices,
      emptyResult: fitted.items.length === 0,
    });
  },
};
