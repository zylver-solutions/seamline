/**
 * The tool response envelope.
 *
 * Every tool returns the same shape, and three of its fields exist because of
 * a specific v3 §2.6 requirement:
 *
 *  - `truncation` — a bounded response must say it was bounded.
 *  - `unknown`    — a scope that is FAIL/UNAVAILABLE must reach the agent. An
 *                   empty result with a degraded scope is not "nothing exists".
 *  - `untrusted`  — third-party text arrives in labelled, delimited blocks.
 */

import { compareCodeUnits } from '@seamline/core';
import type { ExtractorStatus, GraphView, RunRecord } from '@seamline/ontology';
import type { TruncationState } from './bounds.ts';

export interface UnknownScope {
  readonly scope: string;
  readonly status: ExtractorStatus;
  readonly extractor: string;
  readonly diagnostics: readonly string[];
  /**
   * Set on a scope whose extractor PASSed but did not read this many workspace
   * packages. What it did read is sound; what is absent from it is not evidence
   * of absence. Only the count is given: the names are repository paths.
   */
  readonly unreadPackages?: number;
}

/** The scope `extract-code-ts` owns; the same name the detectors require. */
const CODE_SCOPE = 'code.ts';

/** The count `extract-code-ts` puts on the `Repo` node (`unreadCodePackageCount`). */
function unreadCodePackageCount(view: GraphView): number {
  let count = 0;
  for (const repo of view.nodesByKind('Repo')) {
    const n = repo.props['unreadCodePackageCount'];
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) count += n;
  }
  return count;
}

export interface ToolEnvelope {
  readonly ok: boolean;
  readonly tool: string;
  readonly result: unknown;
  readonly truncated: boolean;
  readonly truncation: unknown;
  /** Scopes whose producing extractor did not PASS. Never omitted, even when empty. */
  readonly unknown: readonly UnknownScope[];
  /** Human-and-agent-readable warnings. Always present, possibly empty. */
  readonly notices: readonly string[];
}

export function envelope(
  tool: string,
  result: unknown,
  opts: {
    readonly state: TruncationState;
    readonly unknown: readonly UnknownScope[];
    readonly notices?: readonly string[];
    readonly emptyResult?: boolean;
  },
): ToolEnvelope {
  const notices = [...(opts.notices ?? [])];

  // The load-bearing notice. An agent that receives `[]` will conclude the
  // thing does not exist; if a scope is degraded, that conclusion is unsound.
  if (opts.emptyResult === true && opts.unknown.length > 0) {
    notices.unshift(
      'EMPTY RESULT WITH DEGRADED SCOPES: this result is empty, but ' +
        `${opts.unknown.length} scope(s) did not fully PASS (${opts.unknown.map((u) => u.scope).join(', ')}). ` +
        'Treat this as UNKNOWN, not as evidence that nothing exists.',
    );
  }
  if (opts.state.truncated) notices.push(opts.state.message);

  return {
    ok: true,
    tool,
    result,
    truncated: opts.state.truncated,
    truncation: opts.state.truncated ? opts.state : null,
    unknown: opts.unknown,
    notices,
  };
}

/**
 * The text a client reads for a response, and the structured result beside it.
 *
 * Notices first, then the unknown scopes, then the result as pretty-printed
 * JSON, then each untrusted block. `toolResult` sends exactly this (after the
 * final size gate), and a `tokenBudget` is measured on exactly this, so the
 * budget bounds what the model reads rather than a smaller rendition of it.
 */
export function renderToolContent(env: ToolEnvelope): {
  readonly text: string;
  readonly structured: unknown;
} {
  const sections: string[] = [];

  for (const notice of env.notices) sections.push(`NOTE: ${notice}`);
  if (env.unknown.length > 0) {
    sections.push(
      `UNKNOWN SCOPES (${env.unknown.length}): ` +
        env.unknown
          .map((u) =>
            u.unreadPackages === undefined
              ? `${u.scope}=${u.status} (${u.extractor})`
              : `${u.scope}=PARTIAL, ${u.unreadPackages} workspace package(s) not read (${u.extractor})`,
          )
          .join('; ') +
        '\nQueries touching these scopes return UNKNOWN. An absent result here is not evidence of absence.',
    );
  }

  const { structured, blocks } = splitBlocks(env.result);
  sections.push(JSON.stringify(structured, null, 2));
  for (const block of blocks) sections.push(block);

  return { text: sections.join('\n\n'), structured };
}

function splitBlocks(resultValue: unknown): { structured: unknown; blocks: readonly string[] } {
  if (typeof resultValue !== 'object' || resultValue === null || Array.isArray(resultValue)) {
    return { structured: resultValue, blocks: [] };
  }
  const rec = { ...(resultValue as Record<string, unknown>) };
  const blocks = Array.isArray(rec['untrustedBlocks']) ? (rec['untrustedBlocks'] as string[]) : [];
  delete rec['untrustedBlocks'];
  return { structured: rec, blocks };
}

export interface ToolError {
  readonly ok: false;
  readonly tool: string;
  readonly error: string;
  readonly details: readonly string[];
}

export function toolError(tool: string, error: string, details: readonly string[] = []): ToolError {
  return { ok: false, tool, error, details };
}

/**
 * Scopes whose producing extractor did not PASS.
 *
 * The store's own `scopeStatus` is authoritative; the run record supplies the
 * list of scopes to ask about and the diagnostics to explain them.
 */
export function unknownScopes(view: GraphView, run: RunRecord | undefined): readonly UnknownScope[] {
  if (run === undefined) return [];
  const out: UnknownScope[] = [];
  const seen = new Set<string>();
  for (const result of run.results) {
    for (const auth of result.authoritative) {
      if (seen.has(auth.scope)) continue;
      seen.add(auth.scope);
      let status: ExtractorStatus;
      try {
        status = view.scopeStatus(auth.scope);
      } catch {
        status = result.status;
      }
      if (status === 'PASS') {
        const unread = auth.scope === CODE_SCOPE ? unreadCodePackageCount(view) : 0;
        if (unread > 0) {
          out.push({
            scope: auth.scope,
            status,
            extractor: result.extractor,
            diagnostics: [`${unread} workspace package(s) were not read`],
            unreadPackages: unread,
          });
        }
        continue;
      }
      out.push({
        scope: auth.scope,
        status,
        extractor: result.extractor,
        diagnostics: result.diagnostics,
      });
    }
  }
  out.sort((a, b) => compareCodeUnits(a.scope, b.scope));
  return out;
}
