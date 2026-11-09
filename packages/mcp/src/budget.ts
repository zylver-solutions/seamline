/**
 * Token-budgeted response assembly.
 *
 * An agent has a context window, not a byte cap. `tokenBudget` lets it say how
 * much of that window one answer may take, and the server assembles the most
 * important part of the answer that fits, in a fixed priority order, and says
 * so when something was left out.
 *
 * **The token count is an estimate.** There is no tokenizer here, by design:
 * every runtime dependency is supply-chain surface this project has committed
 * to minimizing, and a tokenizer is specific to one model family anyway. The
 * estimate is `ceil(utf8 bytes / BYTES_PER_TOKEN)` over the text a client reads
 * for the response: the notices, the result as pretty-printed JSON, and the
 * untrusted blocks, as `toolResult` emits them in `content[0].text`. The
 * indentation counts, because the model is sent it; measuring a compact
 * serialization would under-count that text by about a third. The same data is
 * repeated in `structuredContent` for programmatic clients, and that copy is
 * not counted. Identifiers, punctuation and short keys tokenize worse than
 * prose, so the ratio is deliberately low (more tokens per byte than English
 * text) and errs towards under-filling the budget. Treat the figure as an
 * order-of-magnitude guard, not as a promise about any particular model.
 *
 * Three properties hold, and each has a test:
 *  - the choice is deterministic: items arrive in a total priority order, and
 *    the response keeps the longest prefix of that order that fits;
 *  - a budget that bites is reported (`truncation.reasons` carries
 *    `token-budget`, or `size-cap` when the server's own byte cap is the
 *    tighter of the two), never silently short;
 *  - the server's byte cap still applies: the effective limit is
 *    `min(tokenBudget * BYTES_PER_TOKEN, bounds.maxBytes)`.
 */

import { isFact, type SeamlineEdge, type SeamlineNode } from '@seamline/ontology';
import { truncation, type TruncationReason, type TruncationState } from './bounds.ts';
import { renderContext, summarizeNode, type NodeSummary, type RenderContext } from './graph.ts';
import type { Bounds } from './ports.ts';
import { envelope, renderToolContent, type ToolEnvelope, type UnknownScope } from './result.ts';
import type { ParamSpec } from './validate.ts';

/** Estimator ratio: one token is counted per this many UTF-8 bytes. See the module comment. */
export const BYTES_PER_TOKEN = 3;

/**
 * How the estimate is computed, echoed in every budgeted response (as `tokenEstimator`, next to
 * `estimatedTokens`) so it cannot be mistaken for a tokenizer count. Kept short: it is paid for in the budget.
 */
export const TOKEN_ESTIMATOR = `ceil(utf8 bytes / ${BYTES_PER_TOKEN})`;

export const MIN_TOKEN_BUDGET = 512;
export const MAX_TOKEN_BUDGET = 32768;

/** The shared `tokenBudget` parameter, so `context` and `impact` advertise and enforce the same range. */
export const TOKEN_BUDGET_PARAM: ParamSpec = {
  kind: 'integer',
  required: false,
  description:
    `Optional token budget for the whole response, ${MIN_TOKEN_BUDGET} to ${MAX_TOKEN_BUDGET}. ` +
    'When set, the answer is assembled in priority order (the resolved node, its container, direct facts, joins, then farther hops, ' +
    'ties broken by id) and the longest prefix that fits is returned, with `tokenBudget`, `estimatedTokens` and an explicit ' +
    `truncation reason. Tokens are estimated as utf8 bytes / ${BYTES_PER_TOKEN} of the response text (pretty-printed JSON, as sent), not counted by a tokenizer. ` +
    'The server byte cap still applies. Omit for the default bounded response.',
  min: MIN_TOKEN_BUDGET,
  max: MAX_TOKEN_BUDGET,
};

/** The estimate for a payload of `bytes` UTF-8 bytes. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** The byte limit a budgeted response must stay under: the tighter of the token budget and the server cap. */
export function budgetByteLimit(tokenBudget: number, bounds: Bounds): number {
  return Math.min(tokenBudget * BYTES_PER_TOKEN, bounds.maxBytes);
}

/** Total order on strings by UTF-16 code unit, independent of locale. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Facts sort before guesses. */
export function factRank(edge: Pick<SeamlineEdge, 'provenance'> | undefined): number {
  return edge !== undefined && isFact(edge.provenance) ? 0 : 1;
}

/** A node rendered once, away from the shared context, with the untrusted blocks it produced. */
export interface DetachedSummary {
  readonly summary: NodeSummary;
  readonly blocks: readonly string[];
}

/**
 * Summarizes a node into a private render context.
 *
 * The shared context appends an untrusted block every time a node is
 * summarized, so rendering a candidate prefix repeatedly (as fitting does)
 * would duplicate blocks. A detached summary is rendered once; the blocks of
 * the items that are kept are appended to the shared context at the end.
 */
export function summarizeDetached(node: SeamlineNode, shared: RenderContext): DetachedSummary {
  const scratch = renderContext(shared.bounds, shared.nonce);
  const summary = summarizeNode(node, scratch);
  return { summary, blocks: scratch.blocks };
}

/** What a tool renders for one candidate prefix. */
export interface Rendered {
  /** The response body, without the budget fields the assembler adds. */
  readonly result: Readonly<Record<string, unknown>>;
  /** Untrusted blocks of everything in this body, in the order the body introduces them. */
  readonly blocks: readonly string[];
  /** Notices specific to this prefix. */
  readonly notices?: readonly string[];
}

export interface AssembleOptions<T> {
  readonly tool: string;
  readonly tokenBudget: number;
  readonly bounds: Bounds;
  /** Candidates in total priority order, after the result cap. */
  readonly items: readonly T[];
  /** Truncation that already applies before the budget (result cap, depth cap). */
  readonly prior: TruncationState;
  readonly unknown: readonly UnknownScope[];
  /** Notices that hold whatever is kept. */
  readonly notices: readonly string[];
  /**
   * Whether the empty-result banner may fire when a scope is degraded. Defaults to "there are
   * no candidates"; a tool whose own answer already says KNOWN passes `false`.
   */
  readonly emptyResult?: boolean;
  readonly render: (kept: readonly T[]) => Rendered;
  /** The shared context the kept blocks are appended to. */
  readonly sink: RenderContext;
}

interface Built {
  readonly env: ToolEnvelope;
  readonly bytes: number;
  readonly blocks: readonly string[];
}

/**
 * Builds the envelope for the first `n` items, settling `estimatedTokens`.
 *
 * The estimate is a field of the body it measures, so the digits it adds are
 * part of what is measured. Each pass can only lengthen the body, so the loop
 * is monotone and settles after a few passes.
 */
function buildFor<T>(
  o: AssembleOptions<T>,
  n: number,
  reason: TruncationReason,
  extra: readonly string[] = [],
): Built {
  const kept = o.items.slice(0, n);
  const rendered = o.render(kept);
  const dropped = n < o.items.length;
  const state: TruncationState = dropped
    ? budgetState(o.prior, reason, n, o.items.length)
    : o.prior;
  const notices = [...o.notices, ...(rendered.notices ?? []), ...extra];
  if (dropped) {
    notices.push(
      `Token budget ${o.tokenBudget} bit: ${n} of ${o.items.length} candidate(s) kept, in priority order. ` +
        'Raise `tokenBudget` or narrow the query for the rest.',
    );
  }

  let estimated = 0;
  for (let pass = 0; ; pass += 1) {
    const result = {
      ...rendered.result,
      tokenBudget: o.tokenBudget,
      estimatedTokens: estimated,
      tokenEstimator: TOKEN_ESTIMATOR,
    };
    const env = envelope(o.tool, result, {
      state,
      unknown: o.unknown,
      notices,
      emptyResult: o.emptyResult ?? o.items.length === 0,
    });
    // The server appends the untrusted blocks under `untrustedBlocks`; measure them as sent,
    // in the rendition `toolResult` emits (pretty-printed JSON, with the notices before it).
    const sent =
      rendered.blocks.length === 0
        ? env
        : { ...env, result: { ...result, untrustedBlocks: rendered.blocks } };
    const bytes = Buffer.byteLength(renderToolContent(sent).text, 'utf8');
    const next = estimateTokens(bytes);
    if (next === estimated || pass >= 8) return { env, bytes, blocks: rendered.blocks };
    estimated = next;
  }
}

function budgetState(
  prior: TruncationState,
  reason: TruncationReason,
  kept: number,
  total: number,
): TruncationState {
  const reasons: TruncationReason[] = prior.truncated ? [...prior.reasons, reason] : [reason];
  // A prior total (the true size before the result cap) outranks the post-cap count; `null` stays unknown.
  return truncation(reasons, kept, prior.truncated ? prior.total : total);
}

/**
 * Assembles the largest priority-ordered prefix of `items` whose envelope fits
 * the budget.
 *
 * When even the fixed part of the response does not fit, it is returned anyway
 * with nothing optional in it and a notice saying so: an error would tell the
 * agent less than the node it asked about.
 */
export function assembleWithinBudget<T>(o: AssembleOptions<T>): ToolEnvelope {
  const limit = budgetByteLimit(o.tokenBudget, o.bounds);
  const reason: TruncationReason =
    o.tokenBudget * BYTES_PER_TOKEN <= o.bounds.maxBytes ? 'token-budget' : 'size-cap';

  let chosen = buildFor(o, o.items.length, reason);
  if (chosen.bytes > limit) {
    // Every smaller prefix carries the truncation state, so size is monotone in n from here.
    let lo = 0;
    let hi = o.items.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (buildFor(o, mid, reason).bytes <= limit) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    chosen = buildFor(o, best, reason);
    if (chosen.bytes > limit) {
      // Nothing optional is left to drop. Say so; `estimatedTokens` shows by how much.
      chosen = buildFor(o, best, reason, [
        `The fixed part of this response (the resolved node and the response frame) alone exceeds the budget of ${o.tokenBudget} estimated token(s); it is returned anyway. See \`estimatedTokens\`.`,
      ]);
    }
  }

  o.sink.blocks.push(...chosen.blocks);
  return chosen.env;
}
