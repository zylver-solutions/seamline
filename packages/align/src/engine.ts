/**
 * The alignment engine: documents in, a packet body out.
 *
 * `evaluate` reads the documents of one tree, extracts the claims, asks the
 * probes for the implementation facts, classifies each subject with the
 * decision table, computes `Resolved` against a baseline, and assembles the
 * packet (without its digest and before redaction). It is pure with respect to
 * its inputs: no clock, no environment, no network, no process other than the
 * reads `tree.ts` does. Two evaluations of the same inputs produce the same
 * bytes (design 8.3).
 */

import type { Baseline, BaselineFinding } from './baseline.ts';
import {
  claimSetDigest,
  decide,
  factDigest,
  resolvedBy,
  resolvesDrift,
  type Standing,
} from './classify.ts';
import { extractClaims, type ClaimContext } from './claims.ts';
import { DEFAULT_LIMITS, INSTRUMENT_PACKAGE, type Limits, type ProbeEnv } from './env.ts';
import { buildScopeTable, runProvenance, type AlignFacts } from './facts.ts';
import {
  ALIGN_VERSION,
  PACKET_SCHEMA,
  PACKET_SCHEMA_VERSION,
  UNTRUSTED_FIELDS,
  type PacketBody,
  type PacketDoc,
  type PacketFact,
  type PacketFinding,
  type PacketProbe,
  type PacketStatus,
} from './packet.ts';
import { loadDetectors, probeDetectorLiveness } from './probes/detector-liveness.ts';
import { formatScanSet, probeFormatWitness } from './probes/format-witness.ts';
import { probeManifestField, type Runtime } from './probes/manifest-field.ts';
import { probeModuleWiring } from './probes/module-wiring.ts';
import { proposeFor } from './proposals.ts';
import { loadTs, type TsModule } from './ts.ts';
import { readText, type Tree } from './tree.ts';
import {
  CLAIM_PROBE,
  CLASSES,
  PROBE_VERSION,
  different,
  unknownFact,
  type AlignClass,
  type ClaimKind,
  type ClaimRecord,
  type Polarity,
  type ProbeFact,
  type ProbeName,
  type UnknownReason,
} from './types.ts';
import { compareCodeUnits, dirname, globToRegExp, sha256Hex } from './util.ts';
import { discoverPackages, ownerOf } from './workspace.ts';

/** The default document set (3.1), echoed in every packet. */
export const DEFAULT_DOC_GLOBS: readonly string[] = [
  '*.md',
  'docs/**/*.md',
  'packages/*/README.md',
];
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  'docs/adr/**',
  'docs/audit/**',
  '**/CHANGELOG*',
  'docs/dogfood/**',
  '**/node_modules/**',
  'seamline-out/**',
];

export interface EvaluateInput {
  readonly repo: string;
  readonly tree: Tree;
  /** The evaluated commit, full SHA; `null` with `--worktree`. */
  readonly commit: string | null;
  readonly worktree: boolean;
  readonly facts: AlignFacts;
  readonly baseline?: Baseline | null;
  readonly config?: { readonly docs?: readonly string[]; readonly exclude?: readonly string[] };
  readonly producer: { readonly toolVersion: string; readonly sifVersion: string };
  /** The parser; defaults to the installed `typescript`, `null` when it is missing. */
  readonly ts?: TsModule | null;
  readonly limits?: Partial<Limits>;
}

interface DocResult {
  readonly path: string;
  readonly sha256: string | null;
  readonly status: 'PASS' | 'FAIL';
  /** `limit-exceeded` or `source-unreadable` when the status is `FAIL`. */
  readonly reason: 'limit-exceeded' | 'source-unreadable' | null;
  readonly diagnostics: string[];
  readonly claims: ClaimRecord[];
}

interface SubjectResult {
  readonly kind: ClaimKind;
  readonly subject: string;
  readonly member: string | null;
  readonly claims: ClaimRecord[];
  readonly fact: ProbeFact | null;
  readonly standing: Standing;
  readonly unknownDetail: string | null;
}

const CLASS_RANK = new Map<AlignClass, number>(CLASSES.map((c, i) => [c, i] as const));

function compareClaims(a: ClaimRecord, b: ClaimRecord): number {
  return (
    compareCodeUnits(a.source.path, b.source.path) ||
    a.source.lineStart - b.source.lineStart ||
    compareCodeUnits(a.digest, b.digest)
  );
}

/** Documents of the tree that the document set selects, in path order. */
export function selectDocuments(
  tracked: readonly string[],
  docs: readonly string[] = DEFAULT_DOC_GLOBS,
  exclude: readonly string[] = DEFAULT_EXCLUDE_GLOBS,
): string[] {
  const include = docs.map(globToRegExp);
  const skip = exclude.map(globToRegExp);
  return tracked.filter((p) => include.some((re) => re.test(p)) && !skip.some((re) => re.test(p)));
}

function subjectIdParts(kind: ClaimKind, subject: string): { member: string | null } {
  return {
    member: kind === 'OUTPUT_FORMAT_SET' ? subject.slice(subject.lastIndexOf(':') + 1) : null,
  };
}

export function findingId(repo: string, kind: ClaimKind, subject: string): string {
  return `${repo}:align:${kind}:${subject}`;
}

function sortedClaims(claims: readonly ClaimRecord[]): ClaimRecord[] {
  return [...claims].sort(compareClaims);
}

function packetClaim(record: ClaimRecord): PacketFinding['claims'][number] {
  const { extras: _extras, ...claim } = record;
  return claim;
}

function packetStatus(fact: ProbeFact): PacketStatus {
  if (fact.result !== 'UNKNOWN') return 'PASS';
  return fact.reason === 'probe-failed' ? 'FAIL' : 'UNAVAILABLE';
}

function toPacketFact(kind: ClaimKind, fact: ProbeFact, commit: string | null): PacketFact {
  return {
    probe: CLAIM_PROBE[kind],
    probeVersion: PROBE_VERSION,
    status: packetStatus(fact),
    provenance: CLAIM_PROBE[kind] === 'manifest-field' ? 'DECLARED' : 'EXTRACTED',
    result: fact.result,
    observed: fact.observed,
    binding: fact.binding,
    detail: fact.detail,
    source: fact.source === null ? null : { ...fact.source, commit },
  };
}

export function evaluate(input: EvaluateInput): PacketBody {
  const limits: Limits = { ...DEFAULT_LIMITS, ...input.limits };
  const { tree, facts } = input;
  const baseline = input.baseline ?? null;
  const discovery = discoverPackages(tree);
  const scopes = buildScopeTable(facts.runs);
  const provenance = runProvenance(facts, input.commit, scopes);
  const env: ProbeEnv = {
    tree,
    commit: input.commit,
    discovery,
    facts,
    scopes,
    runMismatch: provenance.mismatch,
    ts: input.ts === undefined ? loadTs() : input.ts,
    limits,
    cache: new Map(),
  };

  // ---- documents and claims -------------------------------------------------
  const docGlobs = input.config?.docs ?? DEFAULT_DOC_GLOBS;
  const excludeGlobs = input.config?.exclude ?? DEFAULT_EXCLUDE_GLOBS;
  const docPaths = selectDocuments(tree.tracked, docGlobs, excludeGlobs);

  const trackedSet = new Set(tree.tracked);
  const directories = new Set<string>();
  for (const path of tree.tracked)
    for (let d = dirname(path); d !== '.' && !directories.has(d); d = dirname(d))
      directories.add(d);
  // The subject of a floor is suffixed with the npm name of the non-root package the document lives under: a
  // discovered package (5.3), so a manifest outside the workspace entries gives its documents no suffix.
  const packageNameOf = (docPath: string): string | null => {
    const owner = ownerOf(discovery, docPath);
    return owner === null || owner.dir === '.' ? null : owner.name;
  };
  const registryCodes = new Set<string>(loadDetectors(env).keys());
  const claimContext: ClaimContext = {
    commit: input.commit,
    registryCodes,
    pathExists: (path) => trackedSet.has(path) || directories.has(path),
    packageNameOf,
    scan: { maxLineLength: limits.maxLineLength },
  };

  const docs: DocResult[] = [];
  let claimTotal = 0;
  let claimCapHit = false;
  docPaths.forEach((path, index) => {
    const unread = (
      reason: 'limit-exceeded' | 'source-unreadable',
      message: string,
      sha256: string | null = null,
    ): void => {
      docs.push({
        path,
        sha256,
        status: 'FAIL',
        reason,
        diagnostics: [`${reason}: ${message}`],
        claims: [],
      });
    };
    if (index >= limits.maxDocuments)
      return unread('limit-exceeded', `more than ${limits.maxDocuments} documents`);
    if (claimCapHit)
      return unread('limit-exceeded', `more than ${limits.maxClaims} claims in the documents read`);
    const bytes = tree.read(path);
    const size = tree.size(path);
    const sha256 = bytes === null ? null : sha256Hex(bytes);
    if (size !== null && size > limits.maxDocumentBytes) {
      return unread(
        'limit-exceeded',
        `${size} bytes, over the bound of ${limits.maxDocumentBytes}`,
        sha256,
      );
    }
    const text = bytes === null ? null : readText(tree, path);
    if (text === null) return unread('source-unreadable', 'the blob cannot be read');
    const { claims, truncatedLines } = extractClaims(path, text, claimContext);
    if (claimTotal + claims.length > limits.maxClaims) {
      claimCapHit = true;
      return unread(
        'limit-exceeded',
        `more than ${limits.maxClaims} claims in the documents read`,
        sha256,
      );
    }
    claimTotal += claims.length;
    if (truncatedLines.length > 0) {
      docs.push({
        path,
        sha256,
        status: 'FAIL',
        reason: 'limit-exceeded',
        diagnostics: [
          `limit-exceeded: ${truncatedLines.length} line(s) over ${limits.maxLineLength} characters were read only up to the bound (first at line ${truncatedLines[0] ?? 0})`,
        ],
        claims: [...claims],
      });
      return;
    }
    docs.push({ path, sha256, status: 'PASS', reason: null, diagnostics: [], claims: [...claims] });
  });
  const docStatus = new Map(docs.map((d) => [d.path, d] as const));

  // ---- subjects --------------------------------------------------------------
  const grouped = new Map<
    string,
    { kind: ClaimKind; subject: string; claims: ClaimRecord[]; baseline: BaselineFinding | null }
  >();
  const keyOf = (kind: ClaimKind, subject: string): string => `${kind}\u0000${subject}`;
  for (const doc of docs) {
    for (const claim of doc.claims) {
      const key = keyOf(claim.kind, claim.subject);
      const entry = grouped.get(key) ?? {
        kind: claim.kind,
        subject: claim.subject,
        claims: [],
        baseline: null,
      };
      entry.claims.push(claim);
      grouped.set(key, entry);
    }
  }
  const baselineDrift = (baseline?.findings ?? []).filter(
    (f) => f.class === 'Observed drift' || f.class === 'Unexplained gap',
  );
  for (const finding of baselineDrift) {
    const key = keyOf(finding.claimKind, finding.subject);
    const entry = grouped.get(key) ?? {
      kind: finding.claimKind,
      subject: finding.subject,
      claims: [],
      baseline: null,
    };
    entry.baseline = finding;
    grouped.set(key, entry);
  }

  const floorProbes = new Map<string, ProbeFact>();
  const probeLog = new Map<ProbeName, ProbeFact[]>();
  const logged = (probe: ProbeName, fact: ProbeFact): ProbeFact => {
    const list = probeLog.get(probe) ?? [];
    list.push(fact);
    probeLog.set(probe, list);
    return fact;
  };

  const floorFact = (claims: readonly ClaimRecord[]): ProbeFact | null => {
    const affirm = sortedClaims(claims.filter((c) => c.polarity === 'AFFIRM'));
    if (affirm.length === 0) return null;
    const results: { claim: ClaimRecord; fact: ProbeFact }[] = [];
    for (const claim of affirm) {
      const runtime: Runtime = claim.extras.runtime ?? 'node';
      const key = `${dirname(claim.source.path)}\u0000${runtime}`;
      let fact = floorProbes.get(key);
      if (fact === undefined) {
        fact = logged('manifest-field', probeManifestField(env, claim.source.path, runtime));
        floorProbes.set(key, fact);
      }
      results.push({ claim, fact });
    }
    const unknown = results.find((r) => r.fact.result === 'UNKNOWN');
    if (unknown !== undefined) return unknown.fact;
    const absentOnes = results.filter((r) => r.fact.result === 'ABSENT');
    if (absentOnes.length === results.length) return absentOnes[0]?.fact ?? null;
    if (absentOnes.length > 0) {
      return unknownFact(
        'probe-failed',
        'documents of this subject disagree on whether a floor is declared at all',
      );
    }
    const differing = results.filter((r) => r.claim.value !== r.fact.observed);
    const first = differing[0] ?? results[0];
    if (first === undefined) return null;
    if (differing.length > 0) {
      const lines = differing.map(
        (r) =>
          `${r.claim.source.path}:${r.claim.source.lineStart} says ${String(r.claim.value)}, ${r.fact.detail} says ${String(r.fact.observed)}`,
      );
      return different(
        first.fact.observed,
        lines.join('; '),
        first.fact.source === null ? {} : { source: first.fact.source },
      );
    }
    return first.fact;
  };

  const probeFor = (
    kind: ClaimKind,
    subject: string,
    claims: readonly ClaimRecord[],
  ): ProbeFact | null => {
    switch (kind) {
      case 'RUNTIME_FLOOR':
        return floorFact(claims);
      case 'OUTPUT_FORMAT_SET': {
        const member = subject.slice(subject.lastIndexOf(':') + 1);
        return logged('format-witness', probeFormatWitness(env, member));
      }
      case 'DETECTOR_LIVENESS':
        return logged(
          'detector-liveness',
          probeDetectorLiveness(env, subject.slice(subject.indexOf(':') + 1)),
        );
      case 'CONTROL_ENFORCEMENT': {
        if (claims.length === 0) return null;
        const paths = [...new Set(claims.flatMap((c) => c.extras.boundPaths ?? []))].sort(
          compareCodeUnits,
        );
        if (paths.length === 0) {
          return logged(
            'module-wiring',
            unknownFact(
              'claim-unanchored',
              'the row names no path that exists in the tree, so it is not bound to any code',
            ),
          );
        }
        return logged('module-wiring', probeModuleWiring(env, paths));
      }
    }
  };

  const results: SubjectResult[] = [];
  for (const entry of [...grouped.values()].sort((a, b) =>
    compareCodeUnits(keyOf(a.kind, a.subject), keyOf(b.kind, b.subject)),
  )) {
    const claims = sortedClaims(entry.claims);
    const polarities = new Set<Polarity>(claims.map((c) => c.polarity));
    const member = subjectIdParts(entry.kind, entry.subject).member;

    // A claim that vanished with an unread document was not removed (6).
    if (claims.length === 0 && entry.baseline !== null) {
      const unread = entry.baseline.claimPaths
        .map((p) => docStatus.get(p))
        .find((d) => d !== undefined && d.status !== 'PASS');
      if (unread !== undefined) {
        results.push({
          kind: entry.kind,
          subject: entry.subject,
          member,
          claims,
          fact: null,
          standing: {
            kind: 'class',
            class: 'Unknown',
            reason: unread.reason ?? 'source-unreadable',
          },
          unknownDetail: `the document that held the baseline claim could not be read in full: ${unread.path} (${unread.diagnostics[0] ?? 'unread'})`,
        });
        continue;
      }
    }
    const fact = probeFor(entry.kind, entry.subject, claims);
    const standing = decide(entry.kind, polarities, fact);
    results.push({
      kind: entry.kind,
      subject: entry.subject,
      member,
      claims,
      fact,
      standing,
      unknownDetail:
        standing.kind === 'class' && standing.detail !== undefined ? standing.detail : null,
    });
  }

  // ---- findings ---------------------------------------------------------------
  const findings: PacketFinding[] = [];
  let aligned = 0;
  const baselineById = new Map(baselineDrift.map((f) => [f.id, f] as const));
  for (const r of results) {
    const id = findingId(input.repo, r.kind, r.subject);
    const digests = {
      claim: claimSetDigest(r.claims.map((c) => c.digest)),
      fact: factDigest(r.kind, r.fact),
    };
    if (r.standing.kind === 'aligned' && r.claims.length > 0) aligned += 1;
    if (r.standing.kind === 'class') {
      const unknown =
        r.standing.class === 'Unknown'
          ? {
              reason: r.standing.reason as UnknownReason,
              scopes: [...(r.fact?.scopes ?? [])],
              detail: r.unknownDetail ?? r.fact?.detail ?? '',
            }
          : null;
      findings.push({
        id,
        class: r.standing.class,
        claimKind: r.kind,
        subject: r.subject,
        member: r.member,
        reason: r.standing.reason,
        claims: r.claims.map(packetClaim),
        fact: r.fact === null ? null : toPacketFact(r.kind, r.fact, input.commit),
        unknown,
        resolved: null,
        digests,
      });
    }
    // Row R and the Resolved rules (7).
    const base = baselineById.get(id);
    if (base !== undefined && resolvesDrift(r.standing)) {
      const by = resolvedBy({
        headStanding: r.standing,
        headHasClaims: r.claims.length > 0,
        baselineClaimDigest: base.digests.claim,
        baselineFactDigest: base.digests.fact,
        headClaimDigest: digests.claim,
        headFactDigest: digests.fact,
      });
      if (by !== null) {
        findings.push({
          id,
          class: 'Resolved',
          claimKind: r.kind,
          subject: r.subject,
          member: r.member,
          reason: by,
          claims: r.claims.map(packetClaim),
          fact: r.fact === null ? null : toPacketFact(r.kind, r.fact, input.commit),
          unknown: null,
          resolved: {
            from: base.class === 'Observed drift' ? 'Observed drift' : 'Unexplained gap',
            by,
            baseline: { claimDigest: base.digests.claim, factDigest: base.digests.fact },
          },
          digests,
        });
      }
    }
  }
  findings.sort(
    (a, b) =>
      (CLASS_RANK.get(a.class) ?? 0) - (CLASS_RANK.get(b.class) ?? 0) ||
      compareCodeUnits(a.id, b.id),
  );
  const limitDiagnostics: string[] = [];
  if (findings.length > limits.maxFindings) {
    limitDiagnostics.push(
      `limit-exceeded: ${findings.length} findings, only the first ${limits.maxFindings} are listed`,
    );
    findings.length = limits.maxFindings;
  }

  // ---- proposals --------------------------------------------------------------
  const proposals = results
    .filter(
      (r) =>
        r.kind === 'CONTROL_ENFORCEMENT' &&
        r.standing.kind === 'class' &&
        r.standing.class === 'Unknown' &&
        r.standing.reason === 'claim-unanchored',
    )
    .flatMap((r) =>
      proposeFor(
        env,
        r.claims.map((c) => ({
          repo: input.repo,
          claimKind: r.kind,
          subject: r.subject,
          secondCell: c.extras.secondCell ?? '',
        })),
      ),
    )
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  // ---- packet ------------------------------------------------------------------
  const classes: Record<AlignClass, number> = {
    'Observed drift': 0,
    'Unexplained gap': 0,
    'Planned gap': 0,
    Unknown: 0,
    Resolved: 0,
  };
  for (const f of findings) classes[f.class] += 1;

  const newest = facts.runs[0];
  const packetDocs: PacketDoc[] = docs
    .map((d) => ({
      path: d.path,
      sha256: d.sha256,
      status: d.status,
      claims: d.claims.length,
      diagnostics: d.diagnostics,
    }))
    .sort((a, b) => compareCodeUnits(a.path, b.path));

  const probes: PacketProbe[] = (
    ['manifest-field', 'format-witness', 'detector-liveness', 'module-wiring'] as const
  ).map((probe) => {
    const log = probeLog.get(probe) ?? [];
    let status: PacketStatus = 'PASS';
    if (log.length > 0 && log.every((f) => f.result === 'UNKNOWN')) status = 'UNAVAILABLE';
    if (log.some((f) => f.reason === 'probe-failed')) status = 'FAIL';
    const diagnostics: string[] = [];
    if (probe === 'format-witness') {
      const scanSet = formatScanSet(env);
      if (scanSet !== null && probeLog.has('format-witness')) {
        diagnostics.push(`scan set: ${scanSet.join(', ') || '(none)'}`);
        if (discovery.packages.some((p) => p.name === INSTRUMENT_PACKAGE)) {
          diagnostics.push(
            `excluded from the scan set: ${INSTRUMENT_PACKAGE} (its lexicons name every format)`,
          );
        }
      }
    }
    if (probe === 'detector-liveness' && probeLog.has(probe)) {
      diagnostics.push(
        `registry: ${[...registryCodes].sort(compareCodeUnits).join(', ') || '(empty)'}; level: node kinds`,
      );
    }
    if (probe === 'manifest-field' || probe === 'module-wiring') {
      if (discovery.incomplete && log.length > 0)
        diagnostics.push(`package discovery is incomplete: ${discovery.incompleteDetail}`);
    }
    if (limitDiagnostics.length > 0 && probe === 'manifest-field')
      diagnostics.push(...limitDiagnostics);
    return { probe, version: PROBE_VERSION, status, diagnostics };
  });

  const pkgStatus = (status: string): PacketStatus =>
    status === 'PASS' || status === 'FAIL' || status === 'UNAVAILABLE' ? status : 'FAIL';
  return {
    schema: PACKET_SCHEMA,
    schemaVersion: PACKET_SCHEMA_VERSION,
    repo: input.repo,
    producer: {
      tool: 'seamline',
      toolVersion: input.producer.toolVersion,
      alignVersion: ALIGN_VERSION,
      sifVersion: input.producer.sifVersion,
    },
    subject: { commit: input.commit, worktree: input.worktree },
    run: {
      runId: newest?.runId ?? '',
      commit: newest?.commit ?? null,
      ontologyVersion: newest?.ontologyVersion ?? null,
      pairing: provenance.pairing,
      extractors: (newest?.results ?? [])
        .map((r) => ({
          name: r.extractor,
          version: r.version,
          status: pkgStatus(r.status),
          scopes: [...new Set(r.authoritative.map((a) => a.scope))].sort(compareCodeUnits),
        }))
        .sort((a, b) => compareCodeUnits(a.name, b.name)),
      scopes: [...scopes.values()]
        .map((e) => ({
          scope: e.scope,
          status: pkgStatus(e.status),
          kinds: [...e.kinds],
          runId: e.runId,
        }))
        .sort((a, b) => compareCodeUnits(a.scope, b.scope)),
      facts: { source: facts.source, digest: facts.digest },
    },
    inputs: { docs: packetDocs, probes, excluded: [...excludeGlobs] },
    baseline:
      baseline === null
        ? null
        : { digest: baseline.digest, commit: baseline.commit, runId: baseline.runId },
    summary: { classes, claims: claimTotal, aligned },
    sensitivity: 'internal',
    untrustedFields: [...UNTRUSTED_FIELDS],
    findings,
    proposals,
  };
}
