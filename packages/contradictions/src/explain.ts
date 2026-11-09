/**
 * Rendering one contradiction as something a developer can act on.
 *
 * A finding a developer cannot act on is noise, and noise is what gets a CI
 * gate switched off. So every rendering answers four questions without the
 * reader opening the graph:
 *
 * 1. **What disagrees** - the claim, in the two subjects' own names.
 * 2. **Which two facts** - each with the source ref the extractor recorded, so
 *    the reader can open the file and see it.
 * 3. **How they were joined** - every hop, with its provenance and, for the
 *    inferred hops, its confidence. If the join is wrong, this is the line that
 *    shows it, and a reader who can see the join is wrong can dismiss the
 *    finding in seconds instead of arguing with it.
 * 4. **Why this severity** - stated explicitly when the confidence gate lowered
 *    it from the detector's declared severity.
 */

import type { Contradiction, EdgeKind, GraphView, NodeId, SeamlineEdge } from '@seamline/ontology';
import { isFact } from '@seamline/ontology';

import { SEVERITY_CONFIDENCE_FLOOR } from './detector.ts';
import { DETECTORS_BY_CODE } from './detectors/index.ts';
import { factEdgesFrom, factEdgesTo, isFactNode, label } from './graph.ts';
import type { RunReport } from './runner.ts';

interface RecoveredHop {
  readonly edge: SeamlineEdge;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly reversed: boolean;
}

/**
 * Find the actual edges that connect `left` to `right` along `viaPath`.
 *
 * `Contradiction.viaPath` records edge kinds only, which is enough to sort and
 * to compare but not enough to show a reader why the join was believed. This
 * walks the graph back over those kinds, trying each hop in both directions,
 * and returns the concrete edges. It returns `undefined` when the path cannot
 * be recovered - a tombstone since the run, a synthesized `right` id from X8 -
 * and the renderer then falls back to kinds alone rather than inventing detail.
 */
export function recoverPath(
  g: GraphView,
  left: NodeId,
  right: NodeId,
  viaPath: ReadonlyArray<EdgeKind>,
): ReadonlyArray<RecoveredHop> | undefined {
  if (viaPath.length === 0) return left === right ? [] : undefined;

  const walk = (at: NodeId, index: number, acc: RecoveredHop[]): RecoveredHop[] | undefined => {
    if (index === viaPath.length) return at === right ? acc : undefined;
    const kind = viaPath[index];
    if (kind === undefined) return undefined;
    for (const e of factEdgesFrom(g, at, kind)) {
      const found = walk(e.dst, index + 1, [...acc, { edge: e, from: at, to: e.dst, reversed: false }]);
      if (found !== undefined) return found;
    }
    for (const e of factEdgesTo(g, at, kind)) {
      const found = walk(e.src, index + 1, [...acc, { edge: e, from: at, to: e.src, reversed: true }]);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return walk(left, 0, []);
}

function nodeLabel(g: GraphView, id: NodeId): string {
  const n = g.node(id);
  return n === undefined ? String(id) : label(n);
}

function renderJoin(g: GraphView, c: Contradiction): ReadonlyArray<string> {
  if (c.viaPath.length === 0) {
    return ['  joined by:   nothing inferred - both facts come from the same authoritative scope'];
  }
  const recovered = recoverPath(g, c.left, c.right, c.viaPath);
  if (recovered === undefined) {
    return [`  joined by:   ${c.viaPath.join(' -> ')} (edges not recoverable from the current graph)`];
  }
  const lines = ['  joined by:'];
  for (const h of recovered) {
    const e = h.edge;
    const weight = isFact(e.provenance) ? e.provenance : `${e.provenance} ${e.confidence}`;
    const arrow = h.reversed ? '<-' : '->';
    const where = e.sourceRef === undefined ? '' : `  ${e.sourceRef}`;
    lines.push(`    ${nodeLabel(g, h.from)}  ${arrow}[${e.kind} ${weight}]${arrow}  ${nodeLabel(g, h.to)}${where}`);
  }
  return lines;
}

function renderSeverity(c: Contradiction): string {
  const detector = DETECTORS_BY_CODE.get(c.code);
  const declared = detector?.severity;
  const floor = SEVERITY_CONFIDENCE_FLOOR[c.severity];
  if (declared !== undefined && declared !== c.severity) {
    return `  severity:    ${c.severity} (${c.code} claims ${declared}; lowered because the join confidence ${c.confidence} is below the ${SEVERITY_CONFIDENCE_FLOOR[declared]} required for ${declared})`;
  }
  return `  severity:    ${c.severity} (join confidence ${c.confidence}, at or above the ${floor} required)`;
}

/** Render one contradiction as text a developer can act on. */
export function explain(g: GraphView, c: Contradiction): string {
  const detector = DETECTORS_BY_CODE.get(c.code);
  const leftNode = g.node(c.left);
  const rightNode = g.node(c.right);

  const lines: string[] = [];
  lines.push(`${c.code} [${c.severity}] ${c.claim}`);
  if (detector !== undefined) lines.push(`  detector:    ${detector.description}`);
  lines.push(`  left fact:   ${nodeLabel(g, c.left)}`);
  lines.push(`               ${c.leftFact}`);
  if (leftNode?.sourceRef !== undefined) lines.push(`               source: ${leftNode.sourceRef}`);
  else if (leftNode?.path !== undefined) lines.push(`               source: ${leftNode.path}`);
  lines.push(`  right fact:  ${nodeLabel(g, c.right)}`);
  lines.push(`               ${c.rightFact}`);
  if (rightNode?.sourceRef !== undefined) lines.push(`               source: ${rightNode.sourceRef}`);
  else if (rightNode?.path !== undefined) lines.push(`               source: ${rightNode.path}`);
  else if (rightNode === undefined) {
    lines.push(`               source: not present in the current graph (${c.right})`);
  }
  lines.push(...renderJoin(g, c));
  lines.push(`  confidence:  ${c.confidence}`);
  lines.push(renderSeverity(c));
  if (isFactNode(leftNode) && leftNode.untrusted === true) {
    lines.push('  note:        the left fact contains third-party text and is rendered untrusted');
  }
  if (isFactNode(rightNode) && rightNode.untrusted === true) {
    lines.push('  note:        the right fact contains third-party text and is rendered untrusted');
  }
  return lines.join('\n');
}

/** Render a whole run: findings in order, then the detectors that could not answer. */
export function explainReport(g: GraphView, report: RunReport): string {
  const blocks: string[] = [];
  for (const c of report.findings) blocks.push(explain(g, c));

  for (const d of report.detectors) {
    if (d.outcome !== 'unknown' || d.result.known) continue;
    blocks.push(`${d.code} [UNKNOWN] ${d.result.reason}`);
  }
  for (const d of report.detectors) {
    for (const n of d.notes) blocks.push(`${d.code} [note] ${n}`);
  }

  if (blocks.length === 0) return 'no contradictions, and every detector had the facts it needed.';
  return blocks.join('\n\n');
}
