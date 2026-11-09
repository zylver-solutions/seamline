/**
 * Export is default-deny. Design v3 section 2.5.
 *
 * What Seamline builds is, in one queryable file, an organisation's complete
 * attack map. v2 told the user to commit it to git. The rule that replaces that
 * advice is structural: **a profile is an allow-list of `(kind, sensitivity)`
 * pairs, and there is no "export everything".** A node whose pair is not
 * listed is withheld, and the caller is told what was withheld and why.
 *
 * Default-deny applies at three levels, not one:
 *
 * - **Nodes** by `(kind, effectiveSensitivity)`. Unlisted pair, withheld.
 * - **Edges** by kind, *and* both endpoints must themselves be admitted. An
 *   edge must not be a side channel that reveals a withheld node's existence.
 * - **Fields and props.** `props` are open-ended and extractor-authored, so a
 *   kind with no `allowProps` entry exports no props at all. A released record
 *   carries only the fields the profile names in `allowFields`; the run ids and
 *   `deletedAt` (extraction wall-clock time under the real clock) are released
 *   only when named. `'*'` is available for props but must be written down per
 *   kind, so "all props" is visible in the profile rather than implied by omission.
 *
 * - **Provenance and untrusted text.** A node or edge whose provenance is not
 *   in `allowProvenance` is withheld, and a node tagged `untrusted` is withheld
 *   unless `includeUntrusted` is true. Both are written down in every profile.
 *
 * What a profile is, and the one parser every consumer loads it through, are
 * in `export-profile.ts`; the design is `docs/design/export-profile.md`.
 *
 * Withholding is reported per item, not summarised away: a profile that
 * silently drops 90% of a graph and a profile that drops 2% look identical in
 * the output file, and only the summary distinguishes them.
 *
 * The same decisions are served two ways: `applyProfile` materializes an
 * export, and `profileView` answers reads against a live `GraphView`. Both go
 * through `projectNode` and `projectEdge` below, so a caller reading through
 * the view can never see a node, edge or prop the export would drop, nor a
 * location field it would strip. The one difference is the record fields: a
 * `GraphView` returns whole `SeamlineNode`s and `SeamlineEdge`s (the contract
 * fixes their shape, and the traversal and the detectors read provenance,
 * confidence and `deletedAt` from them), so the view keeps those and the MCP
 * tools decide what they print; a file written by `applyProfile` carries only
 * the fields named in `allowFields`. See `docs/design/export-profile.md`,
 * section 3.1.
 */

import { EDGE_KINDS, NODE_KINDS, PROVENANCE, isFact } from '@seamline/ontology';
import type {
  EdgeKind,
  GraphView,
  NodeId,
  NodeKind,
  SeamlineEdge,
  SeamlineNode,
  Sensitivity,
} from '@seamline/ontology';
import {
  assertProfileKey,
  assertProfileObject,
  ExportPolicyError,
  LIFECYCLE_FIELDS,
  LOCATION_FIELDS,
  parseExportProfile,
  RECORD_FIELDS,
  type ExportProfile,
  type PropAllowance,
  type RecordField,
} from './export-profile.ts';
import { effectiveSensitivity } from './sensitivity.ts';

export const WITHHOLD_REASONS = [
  'kind-not-in-profile',
  'sensitivity-not-allowed',
  'edge-kind-not-in-profile',
  'endpoint-withheld',
  'dangling-endpoint',
  'provenance-not-allowed',
  'untrusted-not-allowed',
] as const;
export type WithholdReason = (typeof WITHHOLD_REASONS)[number];

export interface WithheldItem {
  readonly item: 'node' | 'edge';
  /** NodeId, or `src->dst:kind` for an edge. */
  readonly id: string;
  readonly kind: string;
  readonly reason: WithholdReason;
  /** Human-readable, and free of any value from the withheld item's props. */
  readonly detail: string;
}

export interface WithheldSummary {
  readonly nodes: number;
  readonly edges: number;
  readonly byReason: Readonly<Record<string, number>>;
  readonly byKind: Readonly<Record<string, number>>;
  /** Count of prop keys stripped, by kind. Keys are never listed. */
  readonly propsStrippedByKind: Readonly<Record<string, number>>;
  readonly items: ReadonlyArray<WithheldItem>;
}

/** A node as a file releases it: only the fields the profile names in `allowFields`. */
export type ReleasedNode = Partial<SeamlineNode>;
/** An edge as a file releases it: only the fields the profile names in `allowFields`. */
export type ReleasedEdge = Partial<SeamlineEdge>;

export interface ExportResult {
  readonly profile: string;
  readonly nodes: ReadonlyArray<ReleasedNode>;
  readonly edges: ReadonlyArray<ReleasedEdge>;
  readonly withheld: WithheldSummary;
}

// ---------------------------------------------------------------------------
// Profile construction helpers
// ---------------------------------------------------------------------------

/** Cross product of kinds and sensitivities, sorted for a stable profile. */
export function pairs(
  kinds: ReadonlyArray<NodeKind>,
  levels: ReadonlyArray<Sensitivity>,
): ReadonlyArray<readonly [NodeKind, Sensitivity]> {
  const out: Array<readonly [NodeKind, Sensitivity]> = [];
  for (const k of [...kinds].sort()) {
    for (const s of levels) out.push([k, s] as const);
  }
  return out;
}

function allProps(
  kinds: ReadonlyArray<NodeKind>,
): Readonly<Partial<Record<NodeKind, PropAllowance>>> {
  const out: Partial<Record<NodeKind, PropAllowance>> = {};
  for (const k of kinds) out[k] = '*';
  return out;
}

function allEdgeProps(
  kinds: ReadonlyArray<EdgeKind>,
): Readonly<Partial<Record<EdgeKind, PropAllowance>>> {
  const out: Partial<Record<EdgeKind, PropAllowance>> = {};
  for (const k of kinds) out[k] = '*';
  return out;
}

// ---------------------------------------------------------------------------
// Shipped profiles
//
// Each is built through `parseExportProfile`, so a shipped profile obeys every
// rule a declared one does and a malformed edit fails when this module loads.
// They admit every provenance level and untrusted nodes, as they did before
// those axes were part of the format. `team` and `audit` name every record
// field, as they always released them. `public` names neither the location
// fields nor the lifecycle fields (run ids and `deletedAt`, which carry
// extraction wall-clock time): see `PUBLIC_FIELDS` and the lifecycle fields of the public profile.
// ---------------------------------------------------------------------------

/** Every record field except where the record came from in the source tree. */
const NON_LOCATION_FIELDS: ReadonlyArray<RecordField> = RECORD_FIELDS.filter(
  (f) => !LOCATION_FIELDS.includes(f),
);

/**
 * What `public` releases per record: no location fields, and none of the
 * lifecycle fields. A run id is `run-<ISO timestamp>-<random>` under the real
 * clock, so releasing one would publish when the repository was last extracted
 * and change the file on every re-extraction. Every field that remains is
 * either a path-free natural key (`id`, `src`, `dst`, `name` of a Repo, Module,
 * Contract or Operation), a closed vocabulary (`kind`, `sensitivity`,
 * `provenance`), a number (`confidence`) or a flag (`untrusted`), and the one
 * prop a record may carry is an operation's method.
 */
const PUBLIC_FIELDS: ReadonlyArray<RecordField> = NON_LOCATION_FIELDS.filter(
  (f) => !LIFECYCLE_FIELDS.includes(f),
);

/** Kinds whose default is `confidential`: the data surface. */
const DATA_KINDS: ReadonlyArray<NodeKind> = ['Column', 'DataSource', 'Schema', 'Table'];

/** Kinds whose default is `restricted`: people and threat models. */
const RESTRICTED_KINDS: ReadonlyArray<NodeKind> = ['Owner', 'ThreatModel'];

const INTERNAL_KINDS: ReadonlyArray<NodeKind> = NODE_KINDS.filter(
  (k) => !DATA_KINDS.includes(k) && !RESTRICTED_KINDS.includes(k),
);

/**
 * `public` - the shape of the system and nothing else.
 *
 * Repository, module decomposition and the declared contract surface. No files,
 * no symbols, no paths, no source refs, no data model, no ownership, no tests,
 * no commits, and no run ids or deletion times, so two extractions of an
 * unchanged repository export the same bytes. This is what may accompany an open-source README or a vendor
 * questionnaire.
 *
 * Note the pairs are listed at `internal`, not `public`: no node of these kinds
 * can ever hold an effective sensitivity of `public`, because the kind default
 * is a floor (see `sensitivity.ts`). The profile name describes the audience,
 * the pair describes the lattice position it admits.
 */
export const PUBLIC_PROFILE: ExportProfile = parseExportProfile({
  version: 1,
  name: 'public',
  description:
    'System shape only: repo, modules and the declared contract surface. No paths, no props beyond an operation method, no data model, no people.',
  allow: pairs(['Repo', 'Module', 'Contract', 'Operation'], ['internal']),
  allowEdges: ['CONTAINS'],
  allowProps: { Operation: ['method'] },
  allowEdgeProps: {},
  allowFields: PUBLIC_FIELDS,
  allowProvenance: PROVENANCE,
  includeUntrusted: true,
});

/**
 * `team` - engineering inside the organisation.
 *
 * The full code, contract, verification and change surface, plus the data model
 * at `confidential`. Excludes the `restricted` tier entirely, which removes
 * `Owner` and `ThreatModel` structurally: their kind default is `restricted`,
 * so no pair at `internal` or `confidential` can ever match them.
 */
export const TEAM_PROFILE: ExportProfile = parseExportProfile({
  version: 1,
  name: 'team',
  description:
    'Engineering-internal: code, contracts, verification, change history and the data model. Excludes the restricted tier, so ownership and threat models never appear.',
  allow: [...pairs(INTERNAL_KINDS, ['internal']), ...pairs(DATA_KINDS, ['confidential'])],
  allowEdges: EDGE_KINDS.filter((k) => k !== 'OWNED_BY'),
  allowProps: {
    ...allProps(INTERNAL_KINDS),
    // Data-kind props can carry column defaults and sample values, so they are
    // enumerated rather than wildcarded even for an internal audience.
    Column: ['type', 'nullable', 'primaryKey', 'unique', 'ordinal'],
    Table: ['schema', 'kind'],
    Schema: ['dialect'],
    DataSource: ['dialect', 'kind'],
  },
  allowEdgeProps: allEdgeProps(EDGE_KINDS.filter((k) => k !== 'OWNED_BY')),
  allowFields: RECORD_FIELDS,
  allowProvenance: PROVENANCE,
  includeUntrusted: true,
});

/**
 * `audit` - an authenticated internal auditor, and nothing that leaves the
 * building. This is the only profile that admits the `restricted` tier, and it
 * is the reason `applyProfile` reports what it emitted rather than trusting the
 * caller to remember which profile they asked for.
 */
export const AUDIT_PROFILE: ExportProfile = parseExportProfile({
  version: 1,
  name: 'audit',
  description:
    'Full graph including ownership and threat models. For an authenticated internal auditor only; never a shareable artifact.',
  allow: pairs(NODE_KINDS, ['public', 'internal', 'confidential', 'restricted']),
  allowEdges: EDGE_KINDS,
  allowProps: allProps(NODE_KINDS),
  allowEdgeProps: allEdgeProps(EDGE_KINDS),
  allowFields: RECORD_FIELDS,
  allowProvenance: PROVENANCE,
  includeUntrusted: true,
});

export const PROFILES: Readonly<Record<string, ExportProfile>> = Object.freeze({
  public: PUBLIC_PROFILE,
  team: TEAM_PROFILE,
  audit: AUDIT_PROFILE,
});

/**
 * The profiles declared in `seamline.config.json` under `exportProfiles`: an
 * object whose keys are profile names and whose values are profile objects
 * without a `name`. Every entry goes through `parseExportProfile`. A declared
 * profile may not reuse the name of a shipped one, so `team` means the same
 * thing in every repository.
 */
export function parseDeclaredProfiles(input: unknown): Readonly<Record<string, ExportProfile>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ExportPolicyError('`exportProfiles` must be an object of profile name to profile');
  }
  const out: Record<string, ExportProfile> = {};
  for (const key of Object.keys(input).sort()) {
    // The key is the profile's name: check it, and the shape of its value,
    // here, so the message names the key rather than a `name` field the file
    // is not allowed to contain.
    assertProfileKey(key);
    if (Object.hasOwn(PROFILES, key)) {
      throw new ExportPolicyError(
        `export profile '${key}' is declared, but '${key}' is a shipped profile; choose another name`,
      );
    }
    const value: unknown = (input as Record<string, unknown>)[key];
    assertProfileObject(key, value);
    if (Object.hasOwn(value, 'name')) {
      throw new ExportPolicyError(
        `export profile '${key}': remove \`name\`; the profile is named by its key under \`exportProfiles\``,
      );
    }
    out[key] = parseExportProfile({ ...value, name: key });
  }
  return Object.freeze(out);
}

/** Shipped profiles first by name, then declared ones; the names a caller may pass to `getProfile`. */
export function profileNames(
  declared: Readonly<Record<string, ExportProfile>> = {},
): ReadonlyArray<string> {
  return [...new Set([...Object.keys(PROFILES), ...Object.keys(declared)])].sort();
}

/**
 * No profile, no output. A name is either a shipped profile or one the caller
 * declared; an unknown name is an error, never a fallback.
 */
export function getProfile(
  name: string,
  declared: Readonly<Record<string, ExportProfile>> = {},
): ExportProfile {
  const p = Object.hasOwn(PROFILES, name)
    ? PROFILES[name]
    : Object.hasOwn(declared, name)
      ? declared[name]
      : undefined;
  if (p === undefined) {
    throw new ExportPolicyError(
      `unknown export profile ${JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}...` : name)}; export is default-deny and there is no default profile. Known profiles: ${profileNames(declared).join(', ')}`,
    );
  }
  return p;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function admits(profile: ExportProfile, kind: NodeKind, level: Sensitivity): boolean {
  return profile.allow.some(([k, s]) => k === kind && s === level);
}

function kindListed(profile: ExportProfile, kind: NodeKind): boolean {
  return profile.allow.some(([k]) => k === kind);
}

function filterProps(
  props: Readonly<Record<string, string | number | boolean | null>>,
  allowance: PropAllowance | undefined,
): { kept: Record<string, string | number | boolean | null>; stripped: number } {
  const kept: Record<string, string | number | boolean | null> = {};
  let stripped = 0;
  for (const key of Object.keys(props).sort()) {
    const value = props[key];
    if (value === undefined) continue;
    const ok = allowance === '*' || (Array.isArray(allowance) && allowance.includes(key));
    if (ok) kept[key] = value;
    else stripped += 1;
  }
  return { kept, stripped };
}

/**
 * Why `profile` withholds `node`, or `undefined` when it releases it. The
 * single admission rule for nodes: `projectNode` and `applyProfile` both use
 * it, so the reason reported is the reason applied.
 */
function nodeVerdict(profile: ExportProfile, node: SeamlineNode): WithholdReason | undefined {
  if (!admits(profile, node.kind, effectiveSensitivity(node))) {
    return kindListed(profile, node.kind) ? 'sensitivity-not-allowed' : 'kind-not-in-profile';
  }
  if (!profile.allowProvenance.includes(node.provenance)) return 'provenance-not-allowed';
  if (node.untrusted === true && !profile.includeUntrusted) return 'untrusted-not-allowed';
  return undefined;
}

/**
 * Why `profile` withholds an edge before its endpoints are considered, or
 * `undefined`. The single rule for edge kind and edge provenance.
 */
function edgeVerdict(profile: ExportProfile, edge: SeamlineEdge): WithholdReason | undefined {
  if (!profile.allowEdges.includes(edge.kind)) return 'edge-kind-not-in-profile';
  if (!profile.allowProvenance.includes(edge.provenance)) return 'provenance-not-allowed';
  return undefined;
}

/**
 * Where a projection goes: a file (`applyProfile`) or an agent's `GraphView`
 * (`profileView`).
 */
type Surface = 'file' | 'view';

/**
 * Whether a released record carries `field`. A file carries exactly what
 * `allowFields` names. A view keeps every field a `GraphView` record must have
 * (the contract types them as required, and traversal and detection read
 * provenance, confidence and `deletedAt` from them) and applies the profile to
 * the location fields, which a view has always stripped unless named. The MCP
 * tools then decide what they print; the lifecycle fields are printed only
 * when the profile names them (see `packages/mcp/src/tools/explain.ts`).
 *
 * Props are the same on both surfaces: `allowProps` and `allowEdgeProps` apply
 * to a view as they do to a file, and the parser refuses a profile that allows
 * props without naming `props`, so a file never withholds props that a view
 * serves.
 */
function carries(profile: ExportProfile, field: RecordField, surface: Surface): boolean {
  if (surface === 'view' && !LOCATION_FIELDS.includes(field)) return true;
  return profile.allowFields.includes(field);
}

/** The prop allowance in force for a node kind: none at all when a file does not carry `props`. */
function nodeAllowance(
  profile: ExportProfile,
  kind: NodeKind,
  surface: Surface,
): PropAllowance | undefined {
  return carries(profile, 'props', surface) ? profile.allowProps[kind] : undefined;
}

function edgeAllowance(
  profile: ExportProfile,
  kind: EdgeKind,
  surface: Surface,
): PropAllowance | undefined {
  return carries(profile, 'props', surface) ? profile.allowEdgeProps[kind] : undefined;
}

/**
 * The node as `profile` releases it, or `undefined` when the profile withholds
 * it. The single projection rule for nodes: `applyProfile` and `profileView`
 * both call this, and nothing else decides. Keys are written in a fixed order.
 */
function projectNode(
  profile: ExportProfile,
  node: SeamlineNode,
  surface: Surface,
): ReleasedNode | undefined {
  if (nodeVerdict(profile, node) !== undefined) return undefined;
  const { kept } = filterProps(node.props, nodeAllowance(profile, node.kind, surface));
  const out: Record<string, unknown> = {};
  const put = (field: RecordField, value: unknown): void => {
    if (value !== undefined && carries(profile, field, surface)) out[field] = value;
  };
  put('id', node.id);
  put('kind', node.kind);
  put('name', node.name);
  put('path', node.path);
  // Always the effective level, so an export can never round-trip back in
  // carrying a weaker declaration than the one the policy decided on.
  put('sensitivity', effectiveSensitivity(node));
  put('provenance', node.provenance);
  put('confidence', node.confidence);
  put('sourceRef', node.sourceRef);
  put('untrusted', node.untrusted);
  put('props', kept);
  put('firstSeenRun', node.firstSeenRun);
  put('lastSeenRun', node.lastSeenRun);
  put('deletedAt', node.deletedAt);
  return out as ReleasedNode;
}

/**
 * The edge as `profile` releases it. The caller has already established that
 * the edge kind is allowed and both endpoints were admitted.
 */
function projectEdge(profile: ExportProfile, edge: SeamlineEdge, surface: Surface): ReleasedEdge {
  const { kept } = filterProps(edge.props, edgeAllowance(profile, edge.kind, surface));
  const out: Record<string, unknown> = {};
  const put = (field: RecordField, value: unknown): void => {
    if (value !== undefined && carries(profile, field, surface)) out[field] = value;
  };
  put('kind', edge.kind);
  put('src', edge.src);
  put('dst', edge.dst);
  put('srcFile', edge.srcFile);
  put('dstFile', edge.dstFile);
  put('provenance', edge.provenance);
  put('confidence', edge.confidence);
  put('sourceRef', edge.sourceRef);
  put('props', kept);
  put('firstSeenRun', edge.firstSeenRun);
  put('lastSeenRun', edge.lastSeenRun);
  put('deletedAt', edge.deletedAt);
  return out as ReleasedEdge;
}

/**
 * Apply a profile. Returns only what the profile admits, plus a per-item record
 * of what was withheld and why.
 *
 * Output ordering is stable (nodes by id, edges by `src|dst|kind`) so the
 * determinism gate can compare two runs byte for byte.
 */
export function applyProfile(
  nodes: ReadonlyArray<SeamlineNode>,
  edges: ReadonlyArray<SeamlineEdge>,
  profile: ExportProfile,
): ExportResult {
  const withheldItems: WithheldItem[] = [];
  const propsStrippedByKind: Record<string, number> = {};
  const admittedIds = new Set<string>();
  const knownIds = new Set<string>(nodes.map((n) => String(n.id)));
  const nodeRows: Array<{ key: string; record: ReleasedNode }> = [];

  for (const node of nodes) {
    const projected = projectNode(profile, node, 'file');
    if (projected === undefined) {
      const level = effectiveSensitivity(node);
      const reason = nodeVerdict(profile, node) as WithholdReason;
      withheldItems.push({
        item: 'node',
        id: String(node.id),
        kind: node.kind,
        reason,
        detail:
          reason === 'provenance-not-allowed'
            ? `provenance ${node.provenance} is not in the allow-list of profile '${profile.name}'`
            : reason === 'untrusted-not-allowed'
              ? `untrusted nodes are excluded by profile '${profile.name}'`
              : `(${node.kind}, ${level}) is not in the allow-list of profile '${profile.name}'`,
      });
      continue;
    }
    admittedIds.add(String(node.id));
    const { stripped } = filterProps(node.props, nodeAllowance(profile, node.kind, 'file'));
    if (stripped > 0) {
      propsStrippedByKind[node.kind] = (propsStrippedByKind[node.kind] ?? 0) + stripped;
    }
    nodeRows.push({ key: String(node.id), record: projected });
  }

  const edgeRows: Array<{ key: string; record: ReleasedEdge }> = [];
  for (const edge of edges) {
    const id = `${String(edge.src)}->${String(edge.dst)}:${edge.kind}`;
    const edgeReason = edgeVerdict(profile, edge);
    if (edgeReason !== undefined) {
      withheldItems.push({
        item: 'edge',
        id,
        kind: edge.kind,
        reason: edgeReason,
        detail:
          edgeReason === 'provenance-not-allowed'
            ? `provenance ${edge.provenance} is not in the allow-list of profile '${profile.name}'`
            : `edge kind ${edge.kind} is not in the allow-list of profile '${profile.name}'`,
      });
      continue;
    }
    const srcKnown = knownIds.has(String(edge.src));
    const dstKnown = knownIds.has(String(edge.dst));
    if (!srcKnown || !dstKnown) {
      withheldItems.push({
        item: 'edge',
        id,
        kind: edge.kind,
        reason: 'dangling-endpoint',
        detail: 'an endpoint is not present in the input node set; failing closed',
      });
      continue;
    }
    if (!admittedIds.has(String(edge.src)) || !admittedIds.has(String(edge.dst))) {
      withheldItems.push({
        item: 'edge',
        id,
        kind: edge.kind,
        reason: 'endpoint-withheld',
        detail: 'at least one endpoint was withheld, so the edge would reveal its existence',
      });
      continue;
    }
    const { stripped } = filterProps(edge.props, edgeAllowance(profile, edge.kind, 'file'));
    if (stripped > 0) {
      propsStrippedByKind[edge.kind] = (propsStrippedByKind[edge.kind] ?? 0) + stripped;
    }
    edgeRows.push({
      key: `${String(edge.src)}|${String(edge.dst)}|${edge.kind}`,
      record: projectEdge(profile, edge, 'file'),
    });
  }

  // Ordered by the real identity, not by what the file carries: a profile that
  // does not name `id` still gets a stable order.
  const byKey = (a: { key: string }, b: { key: string }): number =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  nodeRows.sort(byKey);
  edgeRows.sort(byKey);
  const outNodes = nodeRows.map((r) => r.record);
  const outEdges = edgeRows.map((r) => r.record);
  withheldItems.sort(
    (a, b) =>
      (a.item < b.item ? -1 : a.item > b.item ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const byReason: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const w of withheldItems) {
    byReason[w.reason] = (byReason[w.reason] ?? 0) + 1;
    byKind[w.kind] = (byKind[w.kind] ?? 0) + 1;
  }

  return {
    profile: profile.name,
    nodes: outNodes,
    edges: outEdges,
    withheld: {
      nodes: withheldItems.filter((w) => w.item === 'node').length,
      edges: withheldItems.filter((w) => w.item === 'edge').length,
      byReason,
      byKind,
      propsStrippedByKind,
      items: withheldItems,
    },
  };
}

/**
 * A read-only `GraphView` restricted to what `profile` admits.
 *
 * This is how a profile applies to a query surface rather than to a file: a
 * traversal over this view can only step onto admitted nodes along admitted
 * edges, so a withheld node is neither returned, nor counted, nor used as a
 * hop between two admitted ones. Every node and edge it returns is projected
 * by the same rule `applyProfile` uses, so the same nodes and edges are
 * released, with the same props. The records differ only in the fields a view
 * must keep (`carries`): for a profile that names those fields, as the shipped
 * profiles do, enumerating the whole view yields exactly the export (asserted
 * by a property test over them).
 *
 * A degraded scope still reaches the caller as UNKNOWN. Structured-document
 * coverage is checked before projection, so withholding its witness cannot
 * make retained zero-count operations look complete. Only availability crosses.
 */
export function profileView(view: GraphView, profile: ExportProfile): GraphView {
  const incompleteContracts = () =>
    (['Contract', 'Operation'] as const).some((kind) =>
      view.nodesByKind(kind).some((node) => {
        if (!isFact(node.provenance)) return false;
        const count = node.props['unreadStructuredDocuments'];
        return typeof count !== 'number' || !Number.isSafeInteger(count) || count !== 0;
      }),
    );
  const admitted = (id: NodeId): SeamlineNode | undefined => {
    const raw = view.node(id);
    // A view record is a whole `SeamlineNode`: see `carries`.
    return raw === undefined ? undefined : (projectNode(profile, raw, 'view') as SeamlineNode);
  };
  const releasable = (edges: ReadonlyArray<SeamlineEdge>): ReadonlyArray<SeamlineEdge> => {
    const out: SeamlineEdge[] = [];
    for (const e of edges) {
      if (edgeVerdict(profile, e) !== undefined) continue;
      if (admitted(e.src) === undefined || admitted(e.dst) === undefined) continue;
      out.push(projectEdge(profile, e, 'view') as SeamlineEdge);
    }
    return out;
  };
  return {
    nodesByKind(kind: NodeKind): ReadonlyArray<SeamlineNode> {
      if (!kindListed(profile, kind)) return [];
      const out: SeamlineNode[] = [];
      for (const n of view.nodesByKind(kind)) {
        const projected = projectNode(profile, n, 'view');
        if (projected !== undefined) out.push(projected as SeamlineNode);
      }
      return out;
    },
    node: admitted,
    edgesFrom(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
      return admitted(id) === undefined ? [] : releasable(view.edgesFrom(id, kind));
    },
    edgesTo(id: NodeId, kind?: EdgeKind): ReadonlyArray<SeamlineEdge> {
      return admitted(id) === undefined ? [] : releasable(view.edgesTo(id, kind));
    },
    scopeStatus: (scope: string) => {
      const status = view.scopeStatus(scope);
      return scope === 'contracts' && status === 'PASS' && incompleteContracts()
        ? 'UNAVAILABLE'
        : status;
    },
  };
}
