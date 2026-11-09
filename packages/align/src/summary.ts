/**
 * The no-profile summary (design 8.8): projections of a `RedactedPacket`, never
 * a second path to the data. Without an export profile `seamline align` prints
 * a human summary and, with `--json`, a summary object: class counts, and per
 * finding only `id`, `class`, `claimKind`, `member` and `reason`. It carries no
 * excerpt, no observed value and no source path.
 */

import { printable } from '@seamline/core';
import type { RedactedPacket } from './redact.ts';
import { CLASSES } from './types.ts';
import { prettyCanonicalJson } from './util.ts';

export const SUMMARY_SCHEMA = 'seamline.alignment-summary';

export interface SummaryObject {
  schema: typeof SUMMARY_SCHEMA;
  schemaVersion: 1;
  classes: Record<string, number>;
  claims: number;
  aligned: number;
  /** Documents whose claims may be incomplete: unread, over a bound, or read only in part. */
  documentsNotReadInFull: { count: number; reasons: Record<string, number> };
  findings: {
    id: string;
    class: string;
    claimKind: string;
    member: string | null;
    reason: string;
  }[];
}

/**
 * Documents with status FAIL: skipped for a bound or an unreadable blob, or read only up to a
 * line bound. Their claims may be missing from the counts, so the summary names them (counts and
 * closed reasons only, never a path). Without this a 0 drift line could hide an unread document.
 */
function notReadInFull(redacted: RedactedPacket): {
  count: number;
  reasons: Record<string, number>;
} {
  const reasons: Record<string, number> = {};
  let count = 0;
  for (const d of redacted.packet.inputs.docs) {
    if (d.status === 'PASS') continue;
    count += 1;
    const reason = (d.diagnostics[0] ?? '').split(':')[0] || 'source-unreadable';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return {
    count,
    reasons: Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

export function summaryObject(redacted: RedactedPacket): SummaryObject {
  const { packet } = redacted;
  return {
    schema: SUMMARY_SCHEMA,
    schemaVersion: 1,
    classes: { ...packet.summary.classes },
    claims: packet.summary.claims,
    aligned: packet.summary.aligned,
    documentsNotReadInFull: notReadInFull(redacted),
    findings: packet.findings.map((f) => ({
      id: f.id,
      class: f.class,
      claimKind: f.claimKind,
      member: f.member,
      reason: f.reason,
    })),
  };
}

export function summaryJson(redacted: RedactedPacket): string {
  return prettyCanonicalJson(summaryObject(redacted));
}

/**
 * The human summary. `packetEmitted` is true when the same run also wrote the finding packet, in
 * which case the closing hint on how to get a packet is left out (it would tell the reader to do
 * what they just did).
 */
export function summaryText(redacted: RedactedPacket, packetEmitted = false): string {
  const { packet } = redacted;
  const lines: string[] = [];
  const docs = packet.inputs.docs;
  lines.push(
    `alignment of ${printable(packet.repo)} at ${packet.subject.commit ?? 'the working tree'}: ${packet.summary.claims} claim(s) in ${docs.length} document(s) read`,
  );
  lines.push(
    `facts: ${packet.run.facts.source} run ${printable(packet.run.runId) || '(none)'}, pairing ${packet.run.pairing}${packet.run.pairing === 'asserted' ? ' (asserted by the caller, not verified)' : ''}`,
  );
  const unread = notReadInFull(redacted);
  if (unread.count > 0) {
    const why = Object.entries(unread.reasons)
      .map(([r, n]) => `${r}: ${n}`)
      .join(', ');
    lines.push(
      `Unknown: ${unread.count} document(s) not read in full (${why}); their claims may be missing from the counts below.`,
    );
  }
  lines.push('');
  for (const cls of CLASSES) {
    const count = packet.summary.classes[cls];
    lines.push(`${cls.padEnd(16)} ${String(count).padStart(4)}`);
    for (const f of packet.findings.filter((x) => x.class === cls)) {
      lines.push(`    ${printable(f.id)}  (${f.reason})`);
    }
  }
  lines.push(`${'Aligned'.padEnd(16)} ${String(packet.summary.aligned).padStart(4)}`);
  lines.push('');
  lines.push('Drift is reported, never enforced: this command exits 0 whatever it finds.');
  lines.push('Unknown is not the same as clean: the comparison could not be made.');
  if (!packetEmitted) {
    lines.push(
      'Pass --profile <name> with a profile that allows packets: ["alignment"] to emit the finding packet.',
    );
  }
  return `${lines.join('\n')}\n`;
}
