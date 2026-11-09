/**
 * The Redactor - the sole writer to the store. Design v3 section 2.5.
 *
 * v2's entire security assertion was the parenthetical "(values never stored)"
 * with no component behind it. This is that component.
 *
 * It runs post-merge over every string field of every node and edge, replaces
 * anything credential-shaped with a **stable reference** rather than a value,
 * and reports what it caught and by which rule so a false positive is
 * diagnosable without re-running an extractor.
 *
 * Fields come in two classes, and the class decides what a match means:
 *
 * - **Free text** (a node `name` that is not its identity, every prop other
 *   than a path-valued one): every pattern rule and the entropy heuristic run,
 *   and a match is replaced by a reference.
 * - **Identity and locator fields** (a node id, an edge's `src` and `dst`,
 *   `path`, `sourceRef`, `srcFile`, `dstFile`, and the props named in
 *   `LOCATOR_PROP_KEYS`): **never rewritten.** A rewritten id breaks path-free
 *   identity (v3 section 2.1) and every join keyed on it, and a rewritten path
 *   matches nothing on disk. Only the closed-format token rules run here (see
 *   `SecretRule.closedFormat`), and a match **refuses** the record with a
 *   `RedactionError` rather than storing the secret or a changed id. The
 *   entropy heuristic does not run here at all: a repository path is a long
 *   `/`-joined run of identifier characters that scores above the threshold by
 *   length alone (reported against the redactor), and refusing a record on that guess would be worse
 *   than the guess. ADR-0013 records the trade.
 *
 * Three properties the rest of the system depends on:
 *
 * 1. **Deterministic.** The reference is `sha256(domain || value)` truncated to
 *    8 hex characters. Same input, same output, on any machine, in any run.
 *    Byte-identical output is a release gate (v3 section 2.3), so a random salt
 *    or a counter is not available to us.
 * 2. **Distinguishing.** Two different secrets get two different references, so
 *    "the same credential appears in nine places" stays visible. A bare `***`
 *    destroys exactly the signal an operator needs.
 * 3. **Idempotent.** Redacting an already-redacted graph is a no-op, so the
 *    determinism gate can re-run it.
 *
 * The reference is *not* a privacy-preserving commitment. sha256 over a
 * low-entropy secret is brute-forceable, and the fixed domain string is domain
 * separation, not a key. The control this component provides is "the value does
 * not reach the store"; the control for a burned credential is rotation.
 */

import { createHash } from 'node:crypto';
import { parseNodeId } from '@seamline/ontology';
import type { NodeId, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import {
  ENTROPY_THRESHOLD,
  ENTROPY_TOKEN_RE,
  classifyToken,
} from './entropy.ts';
import { REDACTION_PREFIX, REDACTION_SUFFIX, SECRET_RULES } from './patterns.ts';
import type { SecretRule } from './patterns.ts';

/** Domain separation for the reference digest. Not a secret, and not a key. */
const REDACTION_DOMAIN = 'seamline/redaction/v1 ';

/** Rule id used for entropy-only findings. */
export const ENTROPY_RULE_ID = 'high-entropy-string';

/**
 * Raised when a record cannot be stored safely and cannot be rewritten either:
 * credential-shaped text in the repo segment of a node id, or a closed-format
 * credential in an identity or locator field. The message names the rule and
 * the field and quotes the surrounding text with the credential replaced by its
 * reference; it never contains the credential.
 */
export class RedactionError extends Error {
  readonly field: string;
  /** Id of the rule that matched, or `null` when the refusal is not about one rule. */
  readonly rule: string | null;
  constructor(message: string, field: string, rule: string | null = null) {
    super(message);
    this.name = 'RedactionError';
    this.field = field;
    this.rule = rule;
  }
}

/**
 * Prop keys whose value is a repository path or a locator derived from
 * structure rather than free text. Each is emitted by a shipped extractor:
 * `entry` (`Module`), `declaredHandler`, `jsonPointer` and `path` (`RouteHandler`,
 * `Operation`, `SchemaProperty`), `specifier` (`IMPORTS`). The snake_case
 * spellings match the contract's `srcFile`/`dstFile` for extractors that follow
 * the column naming. A key not listed here is free text and is fully scanned,
 * which is the safe direction for a new extractor to fail in.
 */
export const LOCATOR_PROP_KEYS: ReadonlySet<string> = new Set([
  'declaredHandler',
  'dstFile',
  'dst_file',
  'entry',
  'file',
  'jsonPointer',
  'path',
  'specifier',
  'srcFile',
  'src_file',
]);

export interface RedactionFinding {
  /** Rule id, e.g. `aws-access-key-id` or `high-entropy-string`. */
  readonly rule: string;
  /** The replacement written into the store. */
  readonly ref: string;
  /** Node id, edge key, or `<literal>` for a bare `redactString` call. */
  readonly target: string;
  /** Dotted field path, e.g. `props.databaseUrl`. */
  readonly field: string;
  /** Length of the redacted span. The value itself is never recorded. */
  readonly length: number;
  /** Measured entropy for `high-entropy-string`; `null` for pattern rules. */
  readonly entropy: number | null;
}

export interface RedactionRuleSummary {
  readonly rule: string;
  readonly description: string;
  readonly count: number;
}

export interface RedactionReport {
  readonly totalFindings: number;
  readonly distinctSecrets: number;
  readonly byRule: ReadonlyArray<RedactionRuleSummary>;
  readonly findings: ReadonlyArray<RedactionFinding>;
  readonly entropyThreshold: number;
}

export interface RedactorOptions {
  /** Override the entropy threshold. Changing it changes output bytes. */
  readonly entropyThreshold?: number;
  /** Disable the entropy heuristic, leaving pattern rules only. */
  readonly entropyEnabled?: boolean;
  /** Override the pattern rule set (tests, or a stricter host profile). */
  readonly rules?: ReadonlyArray<SecretRule>;
}

export interface RedactedGraph {
  readonly nodes: ReadonlyArray<SeamlineNode>;
  readonly edges: ReadonlyArray<SeamlineEdge>;
  readonly report: RedactionReport;
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly rule: string;
  readonly priority: number;
  readonly entropy: number | null;
}

type ScalarProp = string | number | boolean | null;

// ---------------------------------------------------------------------------
// Reference construction
// ---------------------------------------------------------------------------

/** Stable, deterministic reference for a secret value. */
export function redactionRef(value: string): string {
  const digest = createHash('sha256').update(REDACTION_DOMAIN + value, 'utf8').digest('hex');
  return `${REDACTION_PREFIX}${digest.slice(0, 8)}${REDACTION_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Span collection
// ---------------------------------------------------------------------------

/**
 * Whether a closed-format match is a name of three or more lower-case words
 * made of letters only (`github_pat_is_valid_for_repository`). Digits disqualify
 * it: a token's random part is where they appear.
 */
function isLowerWordIdentifier(s: string): boolean {
  const parts = s.split(/[_-]+/).filter((p) => p.length > 0);
  return parts.length >= 3 && parts.every((p) => /^[a-z]+$/.test(p));
}

function ruleSpans(text: string, rules: ReadonlyArray<SecretRule>): Span[] {
  const spans: Span[] = [];
  for (let priority = 0; priority < rules.length; priority += 1) {
    const rule = rules[priority];
    if (rule === undefined) continue;
    if (rule.guard !== undefined && !rule.guard(text)) continue;
    for (const m of text.matchAll(rule.pattern)) {
      const indices = m.indices;
      if (indices === undefined) continue;
      let group: number;
      if (rule.group === 'first-defined') {
        group = 0;
        for (let i = 1; i <= 3; i += 1) {
          if (m[i] !== undefined) {
            group = i;
            break;
          }
        }
        if (group === 0) continue;
      } else {
        group = rule.group ?? 0;
      }
      const span = indices[group];
      if (span === undefined) continue;
      const [start, end] = span;
      if (end <= start) continue;
      const value = text.slice(start, end);
      if (rule.reject !== undefined && rule.reject(value)) continue;
      spans.push({ start, end, rule: rule.id, priority, entropy: null });
    }
  }
  return spans;
}

function entropySpans(text: string, threshold: number): Span[] {
  const spans: Span[] = [];
  // A fresh RegExp per call: a shared `g` regex carries `lastIndex` state and
  // would make output depend on call order, which the determinism gate forbids.
  const re = new RegExp(ENTROPY_TOKEN_RE.source, 'gd');
  for (const m of text.matchAll(re)) {
    const indices = m.indices;
    if (indices === undefined) continue;
    const span = indices[0];
    if (span === undefined) continue;
    const verdict = classifyToken(m[0], threshold);
    if (!verdict.isSecret) continue;
    spans.push({
      start: span[0],
      end: span[1],
      rule: ENTROPY_RULE_ID,
      priority: Number.MAX_SAFE_INTEGER,
      entropy: verdict.entropy,
    });
  }
  return spans;
}

/**
 * Resolve overlaps: earliest start wins, then longest span, then lowest rule
 * priority (pattern rules before entropy). Total and order-independent.
 */
function resolveSpans(spans: ReadonlyArray<Span>): Span[] {
  const sorted = [...spans].sort(
    (a, b) =>
      a.start - b.start ||
      b.end - a.end ||
      a.priority - b.priority ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
  );
  const accepted: Span[] = [];
  let cursor = -1;
  for (const s of sorted) {
    if (s.start < cursor) continue;
    accepted.push(s);
    cursor = s.end;
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// Redactor
// ---------------------------------------------------------------------------

export interface Redactor {
  /** Redact one string. Findings accumulate into `redactionReport()`. */
  redactString(text: string, target?: string, field?: string): string;
  redactNode(node: SeamlineNode): SeamlineNode;
  /**
   * Redact nodes then edges. Ids are never changed; a closed-format credential
   * in an identity or locator field throws `RedactionError` instead.
   */
  redactGraph(
    nodes: ReadonlyArray<SeamlineNode>,
    edges: ReadonlyArray<SeamlineEdge>,
  ): RedactedGraph;
  redactionReport(): RedactionReport;
  /**
   * Guard one identity or locator string (an id, a path, a commit) that a
   * consumer other than the graph store writes out. Returns `value` unchanged,
   * or throws `RedactionError` when a closed-format credential sits in it:
   * identity and path fields are never rewritten (ADR-0013). This is the same
   * rule `redactGraph` applies to node ids and paths, offered for a plain
   * string so that no second scanner has to exist. `owner` names the record for
   * the message and must itself be free of credentials.
   */
  guardStructural(value: string, field: string, owner?: string): string;
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const rules = options.rules ?? SECRET_RULES;
  const threshold = options.entropyThreshold ?? ENTROPY_THRESHOLD;
  const entropyEnabled = options.entropyEnabled ?? true;

  const findings: RedactionFinding[] = [];
  // Identity and locator fields get the closed-format token rules and nothing
  // else; see the header comment.
  const structuralRules = rules.filter((r) => r.closedFormat === true);
  // A locator prop can be a URL (an import `specifier`), and a URL can carry
  // `user:password@` userinfo. That rule is as self-delimiting as the
  // closed-format ones and cannot match a repository path, so locator props
  // are refused on it too.
  const locatorRules = [
    ...structuralRules,
    ...rules.filter((r) => r.id === 'connection-string-password'),
  ];

  function redactString(text: string, target = '<literal>', field = '<value>'): string {
    if (text.length === 0) return text;
    const spans = resolveSpans([
      ...ruleSpans(text, rules),
      ...(entropyEnabled ? entropySpans(text, threshold) : []),
    ]);
    if (spans.length === 0) return text;

    const parts: string[] = [];
    let cursor = 0;
    for (const s of spans) {
      const value = text.slice(s.start, s.end);
      const ref = redactionRef(value);
      parts.push(text.slice(cursor, s.start), ref);
      cursor = s.end;
      findings.push({
        rule: s.rule,
        ref,
        target,
        field,
        length: value.length,
        entropy: s.entropy,
      });
    }
    parts.push(text.slice(cursor));
    return parts.join('');
  }

  /**
   * Guard for an identity or locator field. Returns `value` unchanged, or
   * throws when a closed-format credential sits in it. `owner` names the record
   * for the message and must itself be free of credentials (callers check the
   * id before anything that uses it as an owner).
   */
  function keepStructural(
    value: string,
    field: string,
    owner?: string,
    applied: ReadonlyArray<SecretRule> = structuralRules,
  ): string {
    if (value.length === 0) return value;
    // A name of three or more lower-case words that happens to start with a
    // token prefix, such as the snake case `github_pat_is_valid_for_repository`,
    // is an identifier, not a token, and refusing a record over a symbol name
    // would be a worse failure than the one it prevents. The exemption is
    // confined to words made of letters only: a token's random part carries
    // digits or upper case, and some real formats are entirely lower case with
    // digits (the legacy Slack `xoxp-<digits>-<digits>-<digits>-<hex>`), so a
    // digit anywhere in the match keeps the refusal.
    const hits = ruleSpans(value, applied).filter(
      (s) => !isLowerWordIdentifier(value.slice(s.start, s.end)),
    );
    const spans = resolveSpans(hits);
    const first = spans[0];
    if (first === undefined) return value;
    const parts: string[] = [];
    let cursor = 0;
    for (const s of spans) {
      parts.push(value.slice(cursor, s.start), redactionRef(value.slice(s.start, s.end)));
      cursor = s.end;
    }
    parts.push(value.slice(cursor));
    throw new RedactionError(
      `refused: rule "${first.rule}" matched credential-shaped text in ${field}` +
        `${owner === undefined ? '' : ` of ${owner}`} (${parts.join('')}). ` +
        'Identity and path fields are never rewritten, so the record is not stored. ' +
        'Exclude the path from extraction, or rename the file or symbol and rotate the credential.',
      field,
      first.rule,
    );
  }

  function keepOptional(v: string | undefined, field: string, owner: string): string | undefined {
    return v === undefined ? undefined : keepStructural(v, field, owner);
  }

  function redactProps(
    props: Readonly<Record<string, ScalarProp>>,
    target: string,
    prefix: string,
  ): Readonly<Record<string, ScalarProp>> {
    const out: Record<string, ScalarProp> = {};
    // Sorted so serialization is byte-stable regardless of insertion order.
    for (const key of Object.keys(props).sort()) {
      const value = props[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        out[key] = value;
      } else if (LOCATOR_PROP_KEYS.has(key)) {
        out[key] = keepStructural(value, `${prefix}.${key}`, target, locatorRules);
      } else {
        out[key] = redactString(value, target, `${prefix}.${key}`);
      }
    }
    return out;
  }

  /**
   * A NodeId is `{repo}:{kind}:{canonicalName}` and is never rewritten. `repo`
   * is operator configuration, so any credential-shaped text in it is an error
   * and fails closed. The canonical name gets the closed-format token rules and
   * is refused on a match: a reference substituted into an id would make the
   * node unjoinable, and the id would no longer be the natural key.
   */
  function keepNodeId(id: NodeId): string {
    const { repo, kind, canonicalName } = parseNodeId(id);
    const probeCount = findings.length;
    const repoProbe = redactString(repo, String(id), 'id.repo');
    if (repoProbe !== repo) {
      findings.length = probeCount;
      // `repoProbe` is the slug with the credential already replaced by its
      // reference, so the message does not repeat the credential.
      throw new RedactionError(
        `credential-shaped text in the repo segment of NodeId ${repoProbe}:${kind}:...; ` +
          'the repo slug is operator configuration and must not carry a secret',
        'id.repo',
      );
    }
    keepStructural(canonicalName, 'id.canonicalName');
    return canonicalName;
  }

  function redactNode(node: SeamlineNode): SeamlineNode {
    const canonicalName = keepNodeId(node.id);
    const target = String(node.id);
    const path = keepOptional(node.path, 'path', target);
    const sourceRef = keepOptional(node.sourceRef, 'sourceRef', target);
    // A name that repeats the canonical name or the path is the node's identity
    // and was just checked as such. Any other name is display text.
    const nameIsIdentity =
      node.name === canonicalName || (path !== undefined && node.name === path);
    return {
      id: node.id,
      kind: node.kind,
      name: nameIsIdentity ? node.name : redactString(node.name, target, 'name'),
      ...(path !== undefined ? { path } : {}),
      sensitivity: node.sensitivity,
      provenance: node.provenance,
      confidence: node.confidence,
      ...(sourceRef !== undefined ? { sourceRef } : {}),
      ...(node.untrusted !== undefined ? { untrusted: node.untrusted } : {}),
      props: redactProps(node.props, target, 'props'),
      firstSeenRun: node.firstSeenRun,
      lastSeenRun: node.lastSeenRun,
      deletedAt: node.deletedAt,
    };
  }

  function redactEdge(edge: SeamlineEdge): SeamlineEdge {
    const src = keepStructural(String(edge.src), 'src') as NodeId;
    const dst = keepStructural(String(edge.dst), 'dst') as NodeId;
    const target = `${src}->${dst}:${edge.kind}`;
    const srcFile = keepOptional(edge.srcFile, 'srcFile', target);
    const dstFile = keepOptional(edge.dstFile, 'dstFile', target);
    const sourceRef = keepOptional(edge.sourceRef, 'sourceRef', target);
    return {
      kind: edge.kind,
      src,
      dst,
      ...(srcFile !== undefined ? { srcFile } : {}),
      ...(dstFile !== undefined ? { dstFile } : {}),
      provenance: edge.provenance,
      confidence: edge.confidence,
      ...(sourceRef !== undefined ? { sourceRef } : {}),
      props: redactProps(edge.props, target, 'props'),
      firstSeenRun: edge.firstSeenRun,
      lastSeenRun: edge.lastSeenRun,
      deletedAt: edge.deletedAt,
    };
  }

  function redactionReport(): RedactionReport {
    const sorted = [...findings].sort(
      (a, b) =>
        (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) ||
        (a.field < b.field ? -1 : a.field > b.field ? 1 : 0) ||
        (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
        (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
    );
    const counts = new Map<string, number>();
    for (const f of sorted) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
    const describe = new Map<string, string>(rules.map((r) => [r.id, r.description]));
    describe.set(
      ENTROPY_RULE_ID,
      `Shannon entropy >= ${threshold} bits/char over a token of 32..128 characters matching no known pattern`,
    );
    const byRule = [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([rule, count]) => ({ rule, description: describe.get(rule) ?? 'unknown rule', count }));
    return {
      totalFindings: sorted.length,
      distinctSecrets: new Set(sorted.map((f) => f.ref)).size,
      byRule,
      findings: sorted,
      entropyThreshold: threshold,
    };
  }

  function redactGraph(
    nodes: ReadonlyArray<SeamlineNode>,
    edges: ReadonlyArray<SeamlineEdge>,
  ): RedactedGraph {
    // A refused batch is not stored, so the replacements made in it before the
    // refusal must not be reported as if they were.
    const mark = findings.length;
    try {
      const outNodes = nodes.map(redactNode);
      const outEdges = edges.map(redactEdge);
      return { nodes: outNodes, edges: outEdges, report: redactionReport() };
    } catch (e) {
      findings.length = mark;
      throw e;
    }
  }

  return {
    redactString,
    redactNode,
    redactGraph,
    redactionReport,
    guardStructural: (value, field, owner) => keepStructural(value, field, owner),
  };
}

/** One-shot convenience over a fresh redactor. */
export function redactGraph(
  nodes: ReadonlyArray<SeamlineNode>,
  edges: ReadonlyArray<SeamlineEdge>,
  options?: RedactorOptions,
): RedactedGraph {
  return createRedactor(options).redactGraph(nodes, edges);
}
