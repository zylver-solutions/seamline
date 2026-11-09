/**
 * Export-policy tests.
 *
 * The property under test is default-deny, in the only form that is worth
 * asserting: a node whose `(kind, sensitivity)` pair no profile rule names is
 * absent from the output. Every other test here exists because there is a way
 * to defeat that property while still passing a naive check - an edge that
 * survives its withheld endpoint, a prop that rides along on an admitted node,
 * a declared sensitivity that talks the policy down.
 */

import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  DEFAULT_SENSITIVITY,
  EDGE_KINDS,
  NODE_KINDS,
  SENSITIVITY,
  nodeId,
} from '@seamline/ontology';
import type {
  GraphView,
  NodeId,
  SeamlineEdge,
  SeamlineNode,
  Sensitivity,
} from '@seamline/ontology';
import {
  AUDIT_PROFILE,
  PROFILES,
  PUBLIC_PROFILE,
  TEAM_PROFILE,
  applyProfile,
  getProfile,
  pairs,
  profileView,
} from './export-policy.ts';
import {
  ExportPolicyError,
  LIFECYCLE_FIELDS,
  LOCATION_FIELDS,
  RECORD_FIELDS,
  parseExportProfile,
} from './export-profile.ts';
import type { ExportProfile } from './export-profile.ts';
import { effectiveSensitivity, moreRestrictive } from './sensitivity.ts';

const RUN = 'run-0001';

function node(
  kind: SeamlineNode['kind'],
  name: string,
  over: Partial<SeamlineNode> = {},
): SeamlineNode {
  return {
    id: nodeId('repo', kind, name),
    kind,
    name,
    path: `src/${name}.ts`,
    sensitivity: DEFAULT_SENSITIVITY[kind],
    provenance: 'EXTRACTED',
    confidence: 1,
    sourceRef: `src/${name}.ts#L1`,
    props: { note: 'x', size: 12 },
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    deletedAt: null,
    ...over,
  };
}

function edge(kind: SeamlineEdge['kind'], src: NodeId, dst: NodeId): SeamlineEdge {
  return {
    kind,
    src,
    dst,
    provenance: 'EXTRACTED',
    confidence: 1,
    props: { via: 'import' },
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    deletedAt: null,
  };
}

/** Every record field except where the record came from, as the `public` profile names them. */
const NON_LOCATION = RECORD_FIELDS.filter((f) => !LOCATION_FIELDS.includes(f));

/** A deliberately narrow profile, so "not listed" is the common case. */
const ONLY_FILES: ExportProfile = {
  version: 1,
  name: 'only-files',
  description: 'test fixture',
  allow: pairs(['File'], ['internal']),
  allowEdges: ['IMPORTS'],
  allowProps: {},
  allowEdgeProps: {},
  allowFields: NON_LOCATION,
  allowProvenance: ['EXTRACTED', 'DECLARED', 'INFERRED', 'LLM_SUGGESTED'],
  includeUntrusted: true,
};

describe('export policy / default-deny', () => {
  it('withholds a node whose (kind, sensitivity) pair no rule names', () => {
    const file = node('File', 'a');
    const symbol = node('Symbol', 'f');
    const owner = node('Owner', 'team-platform');
    const result = applyProfile([file, symbol, owner], [], ONLY_FILES);

    deepStrictEqual(
      result.nodes.map((n) => n.kind),
      ['File'],
    );
    strictEqual(result.withheld.nodes, 2);
    const reasons = result.withheld.items.map((w) => `${w.kind}:${w.reason}`).sort();
    deepStrictEqual(reasons, ['Owner:kind-not-in-profile', 'Symbol:kind-not-in-profile']);
  });

  it('distinguishes "kind not listed" from "kind listed at another level"', () => {
    const restrictedFile = node('File', 'a', { sensitivity: 'restricted' });
    const result = applyProfile([restrictedFile, node('Symbol', 'f')], [], ONLY_FILES);
    const byKind = new Map(result.withheld.items.map((w) => [w.kind, w.reason]));
    strictEqual(byKind.get('File'), 'sensitivity-not-allowed');
    strictEqual(byKind.get('Symbol'), 'kind-not-in-profile');
  });

  it('has no profile that admits every kind at every level except audit', () => {
    for (const [name, p] of Object.entries(PROFILES)) {
      const admitsEverything = NODE_KINDS.every((k) =>
        (['public', 'internal', 'confidential', 'restricted'] as Sensitivity[]).every((s) =>
          p.allow.some(([pk, ps]) => pk === k && ps === s),
        ),
      );
      strictEqual(admitsEverything, name === 'audit', `profile '${name}' admits everything`);
    }
  });

  it('refuses an unknown profile name rather than falling back', () => {
    throws(() => getProfile('everything'), ExportPolicyError);
    throws(() => getProfile(''), ExportPolicyError);
    strictEqual(getProfile('team'), TEAM_PROFILE);
  });

  it('refuses to treat an empty allow-list as "everything"', () => {
    throws(
      () => parseExportProfile({ ...ONLY_FILES, allow: [] }),
      (e: unknown) => e instanceof ExportPolicyError && /admits nothing/.test(e.message),
    );
  });
});

describe('export policy / a malformed profile is refused, not read leniently', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['not an object', 'team'],
    ['no name', { ...ONLY_FILES, name: '' }],
    ['no edge list', { ...ONLY_FILES, allowEdges: undefined }],
    ['a pair that is not a pair', { ...ONLY_FILES, allow: [['File']] }],
    ['an unknown sensitivity', { ...ONLY_FILES, allow: [['File', 'secret']] }],
    ['a prop allowance for an unknown kind', { ...ONLY_FILES, allowProps: { Widget: '*' } }],
    [
      'a prop allowance that is neither a list nor "*"',
      { ...ONLY_FILES, allowProps: { File: 'all' } },
    ],
    ['an unknown record field', { ...ONLY_FILES, allowFields: ['author'] }],
  ];
  for (const [label, value] of cases) {
    it(`refuses ${label}`, () => {
      throws(() => parseExportProfile(value), ExportPolicyError);
    });
  }

  it('accepts every shipped profile and the narrow fixture, unchanged', () => {
    for (const p of [...Object.values(PROFILES), ONLY_FILES]) {
      deepStrictEqual(parseExportProfile(p), p, `'${p.name}' is already in canonical form`);
    }
  });
});

describe('export policy / sensitivity is a floor, never a ceiling', () => {
  it('honours an explicit level that is MORE restrictive', () => {
    const secretFile = node('File', 'a', { sensitivity: 'restricted' });
    strictEqual(effectiveSensitivity(secretFile), 'restricted');
    const result = applyProfile([secretFile], [], TEAM_PROFILE);
    strictEqual(result.nodes.length, 0);
    strictEqual(result.withheld.items[0]?.reason, 'sensitivity-not-allowed');
  });

  it('ignores an explicit level that is LESS restrictive than the kind default', () => {
    // A Column defaults to `confidential`. An extractor claiming `internal`
    // must not be able to talk it down into a lower-tier export.
    const column = node('Column', 'users.email', { sensitivity: 'internal' });
    strictEqual(effectiveSensitivity(column), 'confidential');
    const onlyInternalColumns: ExportProfile = {
      ...ONLY_FILES,
      name: 'internal-columns',
      allow: pairs(['Column'], ['internal']),
    };
    strictEqual(applyProfile([column], [], onlyInternalColumns).nodes.length, 0);
  });

  it('emits the effective level, so an export cannot round-trip a weaker claim', () => {
    const column = node('Column', 'users.email', { sensitivity: 'public' });
    const out = applyProfile([column], [], AUDIT_PROFILE);
    strictEqual(out.nodes[0]?.sensitivity, 'confidential');
  });

  it('makes Owner and ThreatModel structurally unreachable below the restricted tier', () => {
    for (const kind of ['Owner', 'ThreatModel'] as const) {
      for (const declared of [
        'public',
        'internal',
        'confidential',
        'restricted',
      ] as Sensitivity[]) {
        strictEqual(
          moreRestrictive(DEFAULT_SENSITIVITY[kind], declared),
          'restricted',
          `${kind} declared ${declared} escaped the restricted tier`,
        );
      }
    }
    const owner = node('Owner', 'team-platform', { sensitivity: 'public' });
    strictEqual(applyProfile([owner], [], PUBLIC_PROFILE).nodes.length, 0);
    strictEqual(applyProfile([owner], [], TEAM_PROFILE).nodes.length, 0);
    strictEqual(applyProfile([owner], [], AUDIT_PROFILE).nodes.length, 1);
  });
});

describe('export policy / edges are not a side channel', () => {
  it('withholds an edge whose endpoint was withheld', () => {
    const file = node('File', 'a');
    const owner = node('Owner', 'team-platform');
    const e = edge('OWNED_BY', file.id, owner.id);
    const profile: ExportProfile = { ...ONLY_FILES, allowEdges: ['OWNED_BY'] };
    const out = applyProfile([file, owner], [e], profile);
    strictEqual(out.edges.length, 0);
    strictEqual(out.withheld.items.find((w) => w.item === 'edge')?.reason, 'endpoint-withheld');
  });

  it('withholds an edge whose kind is not listed even when both endpoints are admitted', () => {
    const a = node('File', 'a');
    const b = node('File', 'b');
    const out = applyProfile([a, b], [edge('RENAMED_FROM', a.id, b.id)], ONLY_FILES);
    strictEqual(out.edges.length, 0);
    strictEqual(out.withheld.items[0]?.reason, 'edge-kind-not-in-profile');
  });

  it('fails closed on a dangling endpoint rather than guessing', () => {
    const a = node('File', 'a');
    const ghost = nodeId('repo', 'File', 'never-extracted');
    const out = applyProfile([a], [edge('IMPORTS', a.id, ghost)], ONLY_FILES);
    strictEqual(out.edges.length, 0);
    strictEqual(out.withheld.items[0]?.reason, 'dangling-endpoint');
  });

  it('admits an edge when kind and both endpoints are admitted', () => {
    const a = node('File', 'a');
    const b = node('File', 'b');
    const out = applyProfile([a, b], [edge('IMPORTS', a.id, b.id)], ONLY_FILES);
    strictEqual(out.edges.length, 1);
    strictEqual(out.withheld.edges, 0);
  });
});

describe('export policy / props and fields are default-deny too', () => {
  it('strips every prop of a kind with no allowProps entry', () => {
    const out = applyProfile([node('File', 'a')], [], ONLY_FILES);
    deepStrictEqual(out.nodes[0]?.props, {});
    strictEqual(out.withheld.propsStrippedByKind['File'], 2);
  });

  it('keeps only the named props when a kind lists them', () => {
    const profile: ExportProfile = { ...ONLY_FILES, allowProps: { File: ['note'] } };
    const out = applyProfile([node('File', 'a')], [], profile);
    deepStrictEqual(out.nodes[0]?.props, { note: 'x' });
    strictEqual(out.withheld.propsStrippedByKind['File'], 1);
  });

  it('keeps all props only when a kind explicitly says so', () => {
    const profile: ExportProfile = { ...ONLY_FILES, allowProps: { File: '*' } };
    const out = applyProfile([node('File', 'a')], [], profile);
    deepStrictEqual(out.nodes[0]?.props, { note: 'x', size: 12 });
    strictEqual(out.withheld.propsStrippedByKind['File'], undefined);
  });

  it('strips path and sourceRef unless the profile names them', () => {
    const bare = applyProfile([node('File', 'a')], [], ONLY_FILES).nodes[0];
    strictEqual(bare?.path, undefined);
    strictEqual(bare?.sourceRef, undefined);
    const kept = applyProfile([node('File', 'a')], [], {
      ...ONLY_FILES,
      allowFields: [...NON_LOCATION, 'path', 'sourceRef'],
    }).nodes[0];
    strictEqual(kept?.path, 'src/a.ts');
    strictEqual(kept?.sourceRef, 'src/a.ts#L1');
  });
});

describe('export policy / a file carries only the record fields the profile names', () => {
  const a = node('File', 'a', { props: { note: 'x' } });
  const b = node('File', 'b', { props: { note: 'y' } });
  const link = edge('IMPORTS', a.id, b.id);
  const nodeKeys = (p: ExportProfile): string[] =>
    Object.keys(applyProfile([a, b], [link], p).nodes[0] ?? {});
  const edgeKeys = (p: ExportProfile): string[] =>
    Object.keys(applyProfile([a, b], [link], p).edges[0] ?? {});
  const only = (fields: ExportProfile['allowFields']): ExportProfile =>
    parseExportProfile({
      ...ONLY_FILES,
      includeUntrusted: false,
      allowProps: fields.includes('props') ? { File: ['note'] } : {},
      allowEdgeProps: {},
      allowFields: fields,
    });

  it('releases exactly the named fields of a node, and nothing else', () => {
    deepStrictEqual(nodeKeys(only(['id', 'kind', 'name'])), ['id', 'kind', 'name']);
    deepStrictEqual(nodeKeys(only(['id', 'props'])), ['id', 'props']);
    deepStrictEqual(nodeKeys(only(['provenance'])), ['provenance']);
  });

  it('releases exactly the named fields of an edge, and nothing else', () => {
    deepStrictEqual(edgeKeys(only(['id', 'kind', 'name'])), ['kind']);
    deepStrictEqual(edgeKeys(only(['kind', 'src', 'dst'])), ['kind', 'src', 'dst']);
  });

  it('never releases the run ids or deletedAt unless the profile names them', () => {
    const without = ONLY_FILES.allowFields.filter((f) => !LIFECYCLE_FIELDS.includes(f));
    const quiet = parseExportProfile({ ...ONLY_FILES, allowEdgeProps: {}, allowFields: without });
    const out = applyProfile([a, b], [link], quiet);
    ok(out.nodes.length === 2 && out.edges.length === 1);
    const text = JSON.stringify(out);
    for (const field of LIFECYCLE_FIELDS) ok(!text.includes(field), `${field} is not released`);
    ok(!text.includes(RUN), 'and the run id is not in the file');
    const named = parseExportProfile({
      ...ONLY_FILES,
      allowEdgeProps: {},
      allowFields: RECORD_FIELDS,
    });
    const loud = JSON.stringify(applyProfile([a, b], [link], named));
    for (const field of LIFECYCLE_FIELDS)
      ok(loud.includes(field), `${field} is released when named`);
  });

  it('keeps team and audit releasing every field they always released', () => {
    const corpus = [node('Repo', 'seamline'), node('Module', 'm')];
    const withEdge = [edge('CONTAINS', corpus[0]!.id, corpus[1]!.id)];
    deepStrictEqual(TEAM_PROFILE.allowFields, RECORD_FIELDS);
    deepStrictEqual(AUDIT_PROFILE.allowFields, RECORD_FIELDS);
    for (const p of [TEAM_PROFILE, AUDIT_PROFILE]) {
      const out = applyProfile(corpus, withEdge, p);
      deepStrictEqual(Object.keys(out.nodes[0] ?? {}), [
        'id',
        'kind',
        'name',
        'path',
        'sensitivity',
        'provenance',
        'confidence',
        'sourceRef',
        'props',
        'firstSeenRun',
        'lastSeenRun',
        'deletedAt',
      ]);
      deepStrictEqual(Object.keys(out.edges[0] ?? {}), [
        'kind',
        'src',
        'dst',
        'provenance',
        'confidence',
        'props',
        'firstSeenRun',
        'lastSeenRun',
        'deletedAt',
      ]);
    }
  });

  it('releases neither locations nor the run ids and deletedAt from the public profile (public profile lifecycle fields)', () => {
    const corpus = [node('Repo', 'seamline'), node('Module', 'm')];
    const withEdge = [edge('CONTAINS', corpus[0]!.id, corpus[1]!.id)];
    deepStrictEqual(
      PUBLIC_PROFILE.allowFields,
      RECORD_FIELDS.filter((f) => !LOCATION_FIELDS.includes(f) && !LIFECYCLE_FIELDS.includes(f)),
    );
    const out = applyProfile(corpus, withEdge, PUBLIC_PROFILE);
    deepStrictEqual(Object.keys(out.nodes[0] ?? {}), [
      'id',
      'kind',
      'name',
      'sensitivity',
      'provenance',
      'confidence',
      'props',
    ]);
    deepStrictEqual(Object.keys(out.edges[0] ?? {}), [
      'kind',
      'src',
      'dst',
      'provenance',
      'confidence',
      'props',
    ]);
    const text = JSON.stringify(out);
    for (const field of LIFECYCLE_FIELDS) ok(!text.includes(field), `${field} is not released`);
    ok(!text.includes(RUN), 'and no run id is in the export');
  });

  it('exports the same bytes for the public profile whatever run stamped the records (public profile lifecycle fields)', () => {
    const stamped = (run: string, deletedAt: string | null): string => {
      const repo = node('Repo', 'seamline', { firstSeenRun: run, lastSeenRun: run, deletedAt });
      const mod = node('Module', 'm', { firstSeenRun: run, lastSeenRun: run, deletedAt });
      const e = { ...edge('CONTAINS', repo.id, mod.id), firstSeenRun: run, lastSeenRun: run };
      return JSON.stringify(applyProfile([repo, mod], [e], PUBLIC_PROFILE));
    };
    const first = stamped('run-20261101T101500123Z-aaaa1111', null);
    const second = stamped('run-20261102T231959999Z-bbbb2222', '2026-11-02T23:19:59.999Z');
    strictEqual(first, second);
  });

  it('keeps every other record field the public profile always released, value for value', () => {
    const corpus = [
      node('Repo', 'seamline', { untrusted: true }),
      node('Module', 'm'),
      node('Operation', 'GET /x', { props: { method: 'GET', summary: 'x' } }),
    ];
    const withEdge = [edge('CONTAINS', corpus[0]!.id, corpus[1]!.id)];
    const before = applyProfile(corpus, withEdge, {
      ...PUBLIC_PROFILE,
      allowFields: RECORD_FIELDS.filter((f) => !LOCATION_FIELDS.includes(f)),
    });
    const after = applyProfile(corpus, withEdge, PUBLIC_PROFILE);
    const strip = <T extends object>(r: T): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(r).filter(([k]) => !(LIFECYCLE_FIELDS as readonly string[]).includes(k)),
      );
    deepStrictEqual(after.nodes, before.nodes.map(strip));
    deepStrictEqual(after.edges, before.edges.map(strip));
    deepStrictEqual(after.withheld, before.withheld);
  });

  it('writes `untrusted` only on a node that has the tag, and only when the profile names it', () => {
    const tagged = node('File', 'c', { untrusted: true });
    const named = parseExportProfile({
      ...ONLY_FILES,
      allowProps: {},
      allowEdgeProps: {},
      allowFields: ['id', 'untrusted'],
      includeUntrusted: true,
    });
    const out = applyProfile([a, tagged], [], named).nodes;
    deepStrictEqual(
      out.map((n) => Object.keys(n)),
      [['id'], ['id', 'untrusted']],
    );
  });

  it('fails closed on a profile built in code that allows props but does not carry `props` (the parser refuses it)', () => {
    const inconsistent: ExportProfile = {
      ...ONLY_FILES,
      includeUntrusted: false,
      allowProps: { File: '*' },
      allowEdgeProps: {},
      allowFields: ['id'],
    };
    throws(() => parseExportProfile(inconsistent), /does not name `props`/);
    const out = applyProfile([a, b], [], inconsistent);
    deepStrictEqual(Object.keys(out.nodes[0] ?? {}), ['id']);
    strictEqual(out.withheld.propsStrippedByKind['File'], 2, 'one prop on each of two nodes');
  });

  it('counts every prop of a kind with no allowance as stripped', () => {
    const none = parseExportProfile({
      ...ONLY_FILES,
      includeUntrusted: false,
      allowProps: {},
      allowEdgeProps: {},
      allowFields: ['id', 'props'],
    });
    const out = applyProfile([a, b], [], none);
    deepStrictEqual(
      out.nodes.map((n) => n.props),
      [{}, {}],
    );
    strictEqual(out.withheld.propsStrippedByKind['File'], 2, 'one prop on each of two nodes');
  });

  it('orders by identity even when the file does not carry `id`', () => {
    const z = node('File', 'z');
    const m = node('File', 'm');
    const out = applyProfile([z, m, a], [], only(['name']));
    deepStrictEqual(
      out.nodes.map((n) => n.name),
      ['a', 'm', 'z'],
    );
  });

  it('keeps a view record whole: provenance and deletedAt are what traversal reads, only locations are stripped', () => {
    const profile = only(['id']);
    const located = node('File', 'c');
    const view = {
      nodesByKind: () => [located],
      node: () => located,
      edgesFrom: () => [],
      edgesTo: () => [],
      scopeStatus: () => 'PASS' as const,
    };
    const served = profileView(view as never, profile).node(located.id);
    strictEqual(served?.provenance, 'EXTRACTED');
    strictEqual(served?.deletedAt, null);
    strictEqual(served?.path, undefined, 'a location is stripped on the view as in the file');
    strictEqual(served?.sourceRef, undefined);
    const withPath = parseExportProfile({ ...profile, allowFields: ['id', 'path'] });
    strictEqual(profileView(view as never, withPath).node(located.id)?.path, 'src/c.ts');
  });
});

describe('export policy / shipped profiles', () => {
  const corpus: SeamlineNode[] = [
    node('Repo', 'seamline'),
    node('Module', 'core'),
    node('Contract', 'openapi'),
    node('Operation', 'getUser'),
    node('File', 'a'),
    node('Symbol', 'handler'),
    node('Table', 'users'),
    node('Column', 'users.email'),
    node('Owner', 'team-platform'),
    node('ThreatModel', 'stride-2026'),
  ];

  it('all three are structurally valid allow-lists', () => {
    for (const p of Object.values(PROFILES)) parseExportProfile(p);
  });

  it('public emits system shape only, with no paths and no data model', () => {
    const out = applyProfile(corpus, [], PUBLIC_PROFILE);
    deepStrictEqual(out.nodes.map((n) => n.kind).sort(), [
      'Contract',
      'Module',
      'Operation',
      'Repo',
    ]);
    ok(out.nodes.every((n) => n.path === undefined && n.sourceRef === undefined));
    strictEqual(out.withheld.nodes, 6);
  });

  it('team emits code and data but never people or threat models', () => {
    const out = applyProfile(corpus, [], TEAM_PROFILE);
    const kinds = new Set(out.nodes.map((n) => n.kind));
    ok(kinds.has('File') && kinds.has('Column') && kinds.has('Table'));
    ok(!kinds.has('Owner') && !kinds.has('ThreatModel'));
    ok(!TEAM_PROFILE.allowEdges.includes('OWNED_BY'));
  });

  it('team enumerates data-kind props rather than wildcarding them', () => {
    strictEqual(TEAM_PROFILE.allowProps['Column'] === '*', false);
    strictEqual(TEAM_PROFILE.allowProps['File'], '*');
  });

  it('audit emits the whole corpus, and says so', () => {
    const out = applyProfile(corpus, [], AUDIT_PROFILE);
    strictEqual(out.nodes.length, corpus.length);
    strictEqual(out.withheld.nodes, 0);
    strictEqual(out.profile, 'audit');
  });
});

describe('export policy / determinism', () => {
  it('sorts nodes, edges and the withheld list stably', () => {
    const a = node('File', 'a');
    const b = node('File', 'b');
    const c = node('Symbol', 'c');
    const forward = applyProfile([a, b, c], [edge('IMPORTS', a.id, b.id)], ONLY_FILES);
    const reverse = applyProfile([c, b, a], [edge('IMPORTS', a.id, b.id)], ONLY_FILES);
    strictEqual(JSON.stringify(forward), JSON.stringify(reverse));
    deepStrictEqual(
      forward.nodes.map((n) => String(n.id)),
      [String(a.id), String(b.id)],
    );
  });

  it('reports counts that reconcile with the item list', () => {
    const out = applyProfile(
      [node('File', 'a'), node('Symbol', 'f'), node('Owner', 'o')],
      [],
      ONLY_FILES,
    );
    strictEqual(out.withheld.items.length, out.withheld.nodes + out.withheld.edges);
    const summed = Object.values(out.withheld.byReason).reduce((x, y) => x + y, 0);
    strictEqual(summed, out.withheld.items.length);
  });
});

// ---------------------------------------------------------------------------
// profileView: the same policy, served as a GraphView
// ---------------------------------------------------------------------------

function graphOf(nodes: readonly SeamlineNode[], edges: readonly SeamlineEdge[]): GraphView {
  const byId = new Map<string, SeamlineNode>(nodes.map((n) => [String(n.id), n]));
  return {
    nodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    node: (id) => byId.get(String(id)),
    edgesFrom: (id, kind) =>
      edges.filter((e) => e.src === id && (kind === undefined || e.kind === kind)),
    edgesTo: (id, kind) =>
      edges.filter((e) => e.dst === id && (kind === undefined || e.kind === kind)),
    scopeStatus: (scope) => (scope === 'data' ? 'FAIL' : 'PASS'),
  };
}

describe('profileView retains uncertainty when a coverage witness is withheld', () => {
  const operationsOnly = parseExportProfile({
    ...TEAM_PROFILE,
    allow: TEAM_PROFILE.allow.filter(([kind]) => kind !== 'Contract'),
    allowProps: Object.fromEntries(
      Object.entries(TEAM_PROFILE.allowProps).filter(([kind]) => kind !== 'Contract'),
    ),
  });
  for (const count of [undefined, -1, 0.5, 1, '0']) {
    it(`cannot expose a complete contracts scope after hiding coverage ${count}`, () => {
      const current = node('Contract', 'current', {
        props: count === undefined ? {} : { unreadStructuredDocuments: count },
      });
      const retained = node('Operation', 'retained', { props: { unreadStructuredDocuments: 0 } });
      const view = profileView(graphOf([current, retained], []), operationsOnly);
      strictEqual(view.node(current.id), undefined);
      strictEqual(view.nodesByKind('Operation').length, 1);
      strictEqual(view.scopeStatus('contracts'), 'UNAVAILABLE');
      strictEqual(view.scopeStatus('data'), 'FAIL');
    });
  }
  it('keeps a measured complete scope available without exporting the witness', () => {
    const current = node('Contract', 'current', { props: { unreadStructuredDocuments: 0 } });
    strictEqual(
      profileView(graphOf([current], []), operationsOnly).scopeStatus('contracts'),
      'PASS',
    );
  });
  it('checks current coverage when a live underlying view advances to another run', () => {
    const retained = node('Operation', 'retained', { props: { unreadStructuredDocuments: 0 } });
    const nodes = [retained];
    const view = profileView(graphOf(nodes, []), operationsOnly);
    strictEqual(view.scopeStatus('contracts'), 'PASS');
    nodes.push(node('Contract', 'current', { props: { unreadStructuredDocuments: 1 } }));
    strictEqual(view.scopeStatus('contracts'), 'UNAVAILABLE');
    nodes.pop();
    strictEqual(view.scopeStatus('contracts'), 'PASS');
  });
});

/** Everything a caller can enumerate through the view, in `applyProfile`'s order. */
function enumerate(view: GraphView): { nodes: SeamlineNode[]; edges: SeamlineEdge[] } {
  const nodes = NODE_KINDS.flatMap((k) => [...view.nodesByKind(k)]).sort((a, b) =>
    String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0,
  );
  const edges = nodes
    .flatMap((n) => [...view.edgesFrom(n.id)])
    .sort((a, b) => {
      const ka = `${String(a.src)}|${String(a.dst)}|${a.kind}`;
      const kb = `${String(b.src)}|${String(b.dst)}|${b.kind}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  return { nodes, edges };
}

const graphArb = fc
  .record({
    nodes: fc.array(
      fc.record({
        kind: fc.constantFrom(...NODE_KINDS),
        name: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
        level: fc.constantFrom(...SENSITIVITY),
        withPath: fc.boolean(),
      }),
      { maxLength: 16 },
    ),
    edges: fc.array(
      fc.record({
        kind: fc.constantFrom(...EDGE_KINDS),
        src: fc.nat(40),
        dst: fc.nat(40),
        dangling: fc.boolean(),
      }),
      { maxLength: 24 },
    ),
  })
  .map(({ nodes: specs, edges: links }) => {
    const byId = new Map<string, SeamlineNode>();
    for (const s of specs) {
      const n: SeamlineNode = { ...node(s.kind, s.name, { sensitivity: s.level }) };
      if (!s.withPath) delete (n as { path?: string }).path;
      byId.set(String(n.id), n);
    }
    const nodes = [...byId.values()];
    const edges: SeamlineEdge[] = [];
    const seen = new Set<string>();
    if (nodes.length > 0) {
      for (const l of links) {
        const src = (nodes[l.src % nodes.length] as SeamlineNode).id;
        const dst = l.dangling
          ? nodeId('repo', 'Symbol', 'nowhere')
          : (nodes[l.dst % nodes.length] as SeamlineNode).id;
        const key = `${String(src)}|${String(dst)}|${l.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(edge(l.kind, src, dst));
      }
    }
    return { nodes, edges };
  });

describe('export policy / profileView serves exactly what applyProfile exports', () => {
  it('enumerating the view yields the export, node for node and edge for edge, for every shipped profile', () => {
    fc.assert(
      fc.property(
        graphArb,
        fc.constantFrom(...Object.values(PROFILES), ONLY_FILES),
        ({ nodes, edges }, profile) => {
          const exported = applyProfile(nodes, edges, profile);
          const served = enumerate(profileView(graphOf(nodes, edges), profile));
          // The view keeps the lifecycle fields on every record, because the
          // traversal and the detectors read `deletedAt` and a record without
          // it reads as a tombstone (export-profile.md, section 3.2). A file
          // carries them only when the profile names them, so compare what the
          // profile selects.
          const selected = <T extends object>(r: T): T =>
            Object.fromEntries(
              Object.entries(r).filter(
                ([k]) =>
                  !(LIFECYCLE_FIELDS as readonly string[]).includes(k) ||
                  (profile.allowFields as readonly string[]).includes(k),
              ),
            ) as T;
          deepStrictEqual(served.nodes.map(selected), exported.nodes);
          deepStrictEqual(served.edges.map(selected), exported.edges);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a withheld node is absent by id, and no edge in either direction reveals it', () => {
    const file = node('File', 'a');
    const table = node('Table', 'users');
    const out = edge('QUERIES', file.id, table.id);
    const back = edge('IMPORTS', table.id, file.id);
    const view = profileView(graphOf([file, table], [out, back]), ONLY_FILES);
    strictEqual(view.node(table.id), undefined);
    deepStrictEqual(view.edgesFrom(file.id), []);
    deepStrictEqual(view.edgesTo(file.id), []);
    deepStrictEqual(view.edgesFrom(table.id), []);
    deepStrictEqual(view.edgesTo(table.id), []);
    deepStrictEqual(view.nodesByKind('Table'), []);
  });

  it('projects an admitted node exactly as the export does: props, path and effective level', () => {
    const file = node('File', 'a', { sensitivity: 'public' });
    const view = profileView(graphOf([file], []), ONLY_FILES);
    const served = view.node(file.id);
    deepStrictEqual(served, applyProfile([file], [], ONLY_FILES).nodes[0]);
    deepStrictEqual(served?.props, {});
    strictEqual(served?.path, undefined);
    strictEqual(served?.sensitivity, 'internal');
  });

  it('passes scope status through unchanged, so UNKNOWN survives the filter', () => {
    const view = profileView(graphOf([], []), PUBLIC_PROFILE);
    strictEqual(view.scopeStatus('data'), 'FAIL');
    strictEqual(view.scopeStatus('code.ts'), 'PASS');
  });
});
