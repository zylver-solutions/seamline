/**
 * The baseline (design section 7): an earlier packet, supplied by the caller,
 * against which `Resolved` is computed. It is read as data. Its schema version
 * must be 1 and its digest must verify, else the command fails with a usage
 * error. A baseline need not be an ancestor of the evaluated commit.
 */

import { usageFailure } from './errors.ts';
import { PACKET_SCHEMA, PACKET_SCHEMA_VERSION } from './packet.ts';
import { CLASSES, CLAIM_KINDS, type AlignClass, type ClaimKind } from './types.ts';
import { prettyCanonicalJson, sha256Tagged } from './util.ts';

export interface BaselineFinding {
  readonly id: string;
  readonly class: AlignClass;
  readonly claimKind: ClaimKind;
  readonly subject: string;
  readonly member: string | null;
  readonly digests: { readonly claim: string | null; readonly fact: string | null };
  /** Paths of the documents that held the finding's claims in the baseline. */
  readonly claimPaths: readonly string[];
}

export interface Baseline {
  readonly digest: string;
  readonly commit: string | null;
  readonly runId: string | null;
  readonly findings: readonly BaselineFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The digest a packet carries: SHA-256 of its canonical serialisation with the `digest` field omitted (8.3). */
export function packetDigest(packet: Record<string, unknown>): string {
  const { digest: _omitted, ...rest } = packet;
  return sha256Tagged(prettyCanonicalJson(rest));
}

export function readBaseline(text: string): Baseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usageFailure(
      'the baseline is not valid JSON.',
      'Pass a packet written by `seamline align --packet`.',
    );
  }
  if (!isRecord(parsed) || parsed['schema'] !== PACKET_SCHEMA) {
    throw usageFailure(
      `the baseline is not a ${PACKET_SCHEMA} packet.`,
      'Pass a packet written by `seamline align --packet`.',
    );
  }
  if (parsed['schemaVersion'] !== PACKET_SCHEMA_VERSION) {
    throw usageFailure(
      `the baseline has schemaVersion ${String(parsed['schemaVersion'])}; this build reads version ${PACKET_SCHEMA_VERSION}.`,
    );
  }
  const digest = parsed['digest'];
  if (typeof digest !== 'string' || digest !== packetDigest(parsed)) {
    throw usageFailure(
      'the baseline digest does not verify; the packet was changed after it was written.',
      'Pass the packet exactly as `seamline align` wrote it.',
    );
  }
  const findings: BaselineFinding[] = [];
  const rawFindings = parsed['findings'];
  if (!Array.isArray(rawFindings)) throw usageFailure('the baseline has no findings array.');
  for (const raw of rawFindings) {
    if (!isRecord(raw)) continue;
    const cls = raw['class'];
    const kind = raw['claimKind'];
    if (typeof raw['id'] !== 'string' || typeof raw['subject'] !== 'string') continue;
    if (
      !(CLASSES as readonly unknown[]).includes(cls) ||
      !(CLAIM_KINDS as readonly unknown[]).includes(kind)
    )
      continue;
    const digests = isRecord(raw['digests']) ? raw['digests'] : {};
    const claims = Array.isArray(raw['claims']) ? raw['claims'] : [];
    const claimPaths = claims
      .map((c) => (isRecord(c) && isRecord(c['source']) ? stringOrNull(c['source']['path']) : null))
      .filter((p): p is string => p !== null);
    findings.push({
      id: raw['id'],
      class: cls as AlignClass,
      claimKind: kind as ClaimKind,
      subject: raw['subject'],
      member: stringOrNull(raw['member']),
      digests: { claim: stringOrNull(digests['claim']), fact: stringOrNull(digests['fact']) },
      claimPaths: [...new Set(claimPaths)].sort(),
    });
  }
  const subject = isRecord(parsed['subject']) ? parsed['subject'] : {};
  const run = isRecord(parsed['run']) ? parsed['run'] : {};
  return {
    digest,
    commit: stringOrNull(subject['commit']),
    runId: stringOrNull(run['runId']),
    findings,
  };
}
