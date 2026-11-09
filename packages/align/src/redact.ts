/**
 * Redaction: the existing redactor is the sole writer (design 8.5, ADR-0011,
 * ADR-0013).
 *
 *  - Every free-text string (`claims[].excerpt`, `fact.detail`,
 *    `unknown.detail`, every `diagnostics[]` entry, `proposals[].note`) passes
 *    through `redactString`: a matched secret becomes a reference.
 *  - Every identity and locator (`id`, `subject`, `member`, `repo`, every
 *    `source.path` and `source.commit`, `inputs.docs[].path`,
 *    `candidate.canonicalName`) follows ADR-0013: never rewritten, and a
 *    closed-format credential in one refuses the whole packet. No partial
 *    packet is written; the failure names the rule and the field, never the
 *    credential.
 *
 * `RedactedPacket` is opaque. Only `redactPacket` can construct one (the
 * token is module-private), and the serialiser, the summaries and the single
 * write site accept nothing else. So no byte of a packet reaches a consumer
 * without passing the redactor.
 */

import { RedactionError, createRedactor, type Redactor } from '@seamline/core';
import { runtimeFailure } from './errors.ts';
import { packetDigest } from './baseline.ts';
import type { Packet, PacketBody, PacketFinding } from './packet.ts';
import { prettyCanonicalJson } from './util.ts';

const TOKEN = Symbol('seamline.align.redacted');

export class RedactedPacket {
  readonly packet: Packet;
  /** The canonical serialisation: sorted keys, two-space indent, LF, one trailing newline. */
  readonly bytes: string;

  constructor(token: symbol, packet: Packet) {
    if (token !== TOKEN) throw new TypeError('a RedactedPacket can only be made by redactPacket');
    this.packet = packet;
    this.bytes = prettyCanonicalJson(packet);
    Object.freeze(this);
  }
}

function guard(redactor: Redactor, value: string, field: string, owner?: string): string {
  return redactor.guardStructural(value, field, owner);
}

/**
 * Redact a packet body and seal it. Throws an `AlignError` (runtime, exit 3)
 * when an identity or locator field holds a credential.
 */
export function redactPacket(
  body: PacketBody,
  redactor: Redactor = createRedactor(),
): RedactedPacket {
  try {
    const text = (value: string, target: string, field: string): string =>
      redactor.redactString(value, target, field);
    const guarded = (value: string, field: string): string => guard(redactor, value, field);
    const optional = (value: string | null, field: string): string | null =>
      value === null ? null : guarded(value, field);

    const findings: PacketFinding[] = body.findings.map((f) => {
      const id = guarded(f.id, 'findings[].id');
      return {
        ...f,
        id,
        subject: guarded(f.subject, 'findings[].subject'),
        member: optional(f.member, 'findings[].member'),
        claims: f.claims.map((c) => ({
          ...c,
          subject: guarded(c.subject, 'findings[].claims[].subject'),
          member: optional(c.member, 'findings[].claims[].member'),
          source: {
            ...c.source,
            path: guarded(c.source.path, 'findings[].claims[].source.path'),
            commit: optional(c.source.commit, 'findings[].claims[].source.commit'),
          },
          excerpt: text(c.excerpt, id, 'findings[].claims[].excerpt'),
        })),
        fact:
          f.fact === null
            ? null
            : {
                ...f.fact,
                detail: text(f.fact.detail, id, 'findings[].fact.detail'),
                source:
                  f.fact.source === null
                    ? null
                    : {
                        ...f.fact.source,
                        path: guarded(f.fact.source.path, 'findings[].fact.source.path'),
                        commit: optional(f.fact.source.commit, 'findings[].fact.source.commit'),
                      },
              },
        unknown:
          f.unknown === null
            ? null
            : { ...f.unknown, detail: text(f.unknown.detail, id, 'findings[].unknown.detail') },
      };
    });

    const redacted: PacketBody = {
      ...body,
      repo: guarded(body.repo, 'repo'),
      subject: { ...body.subject, commit: optional(body.subject.commit, 'subject.commit') },
      run: {
        ...body.run,
        runId: guarded(body.run.runId, 'run.runId'),
        commit: optional(body.run.commit, 'run.commit'),
        extractors: body.run.extractors.map((e) => ({
          ...e,
          name: guarded(e.name, 'run.extractors[].name'),
        })),
      },
      inputs: {
        docs: body.inputs.docs.map((d) => ({
          ...d,
          path: guarded(d.path, 'inputs.docs[].path'),
          diagnostics: d.diagnostics.map((x) => text(x, d.path, 'inputs.docs[].diagnostics[]')),
        })),
        probes: body.inputs.probes.map((p) => ({
          ...p,
          diagnostics: p.diagnostics.map((x) => text(x, p.probe, 'inputs.probes[].diagnostics[]')),
        })),
        excluded: body.inputs.excluded.map((e) => guarded(e, 'inputs.excluded[]')),
      },
      baseline:
        body.baseline === null
          ? null
          : {
              ...body.baseline,
              commit: optional(body.baseline.commit, 'baseline.commit'),
              runId: optional(body.baseline.runId, 'baseline.runId'),
            },
      findings,
      proposals: body.proposals.map((p) => ({
        ...p,
        id: guarded(p.id, 'proposals[].id'),
        subject: guarded(p.subject, 'proposals[].subject'),
        candidate: {
          ...p.candidate,
          canonicalName: guarded(p.candidate.canonicalName, 'proposals[].candidate.canonicalName'),
        },
        note: text(p.note, p.id, 'proposals[].note'),
      })),
    };
    const digest = packetDigest({ ...redacted });
    return new RedactedPacket(TOKEN, { ...redacted, digest });
  } catch (error) {
    if (error instanceof RedactionError) {
      throw runtimeFailure(
        `the packet was not written: ${error.message}`,
        'Identity and path fields are never rewritten. Remove the credential from the named field and rotate it.',
      );
    }
    throw error;
  }
}
