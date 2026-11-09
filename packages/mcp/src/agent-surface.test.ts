/**
 * What the agent surface prints, whatever `allowFields` says.
 *
 * `allowFields` selects the fields of an exported file. On the MCP surface it
 * governs two groups only: the location fields (`path`, `sourceRef`, `srcFile`,
 * `dstFile`) and the lifecycle fields (`firstSeenRun`, `lastSeenRun`,
 * `deletedAt`). Everything else a tool prints is fixed: `id`, `kind`, `name`,
 * `src`, `dst`, `untrusted`, `provenance`, `confidence`, `sensitivity` and the
 * props that `allowProps` and `allowEdgeProps` name (the parser refuses a
 * profile that names props without selecting `props`, so a file and the agent
 * surface never disagree about them).
 *
 * These tests pin that contract by outcome: the same graph is served under
 * profiles that differ only in `allowFields`, and what each tool prints is
 * compared and searched for the values the profile did not name. The values
 * that must not leak are distinctive strings, so a substring search cannot be
 * satisfied by an id or a name that happens to contain them.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import {
  AUDIT_PROFILE,
  PUBLIC_PROFILE,
  TEAM_PROFILE,
  pairs,
  parseExportProfile,
  type ExportProfile,
  type RecordField,
} from '@seamline/core';
import type { DetectionReport } from './ports.ts';
import { createServer } from './server.ts';
import { TOOL_NAMES } from './tools/index.ts';
import type { ToolEnvelope } from './result.ts';
import { fixedNonce, makeEdge, makeNode, makeRun, makeResult, memorySource } from './testing.ts';

// ---------------------------------------------------------------------------
// A graph in which every record carries a value for every field a profile can
// withhold: a location, a source reference, run ids and, on one node, a
// deletion time. Each of those values is distinctive.
// ---------------------------------------------------------------------------

const LEAK = {
  path: 'layout-leak/handler.ts',
  nodeRef: 'layout-leak/handler.ts#L40',
  edgeRef: 'layout-leak/edge.ts#L7',
  firstRun: 'run-2026-10-19T09:00:00.000Z-first',
  lastRun: 'run-2026-10-19T10:00:00.000Z-last',
  deletedAt: '2031-02-03T04:05:06.000Z',
} as const;

function stamped(node: SeamlineNode): SeamlineNode {
  return { ...node, firstSeenRun: LEAK.firstRun, lastSeenRun: LEAK.lastRun };
}
function stampedEdge(edge: SeamlineEdge): SeamlineEdge {
  return {
    ...edge,
    srcFile: LEAK.path,
    dstFile: LEAK.path,
    firstSeenRun: LEAK.firstRun,
    lastSeenRun: LEAK.lastRun,
  };
}

const file = stamped(
  makeNode({
    kind: 'File',
    canonicalName: 'src/api.ts',
    path: LEAK.path,
    sourceRef: LEAK.nodeRef,
    props: { loc: 120 },
  }),
);
const handler = stamped(
  makeNode({
    kind: 'Symbol',
    canonicalName: 'src/api.ts#createOrder',
    path: LEAK.path,
    sourceRef: LEAK.nodeRef,
    props: { symbolKind: 'function', note: 'a prop no profile names' },
  }),
);
const helper = stamped(
  makeNode({
    kind: 'Symbol',
    canonicalName: 'src/api.ts#price',
    path: LEAK.path,
    sourceRef: LEAK.nodeRef,
    props: { symbolKind: 'function' },
  }),
);
const removed = stamped(
  makeNode({
    kind: 'Symbol',
    canonicalName: 'src/api.ts#legacy',
    path: LEAK.path,
    sourceRef: LEAK.nodeRef,
    deletedAt: LEAK.deletedAt,
  }),
);
const orderEmail = stamped(
  makeNode({
    kind: 'CodeField',
    canonicalName: 'Order.email',
    path: LEAK.path,
    sourceRef: LEAK.nodeRef,
    props: { optional: false },
  }),
);
const emailProperty = stamped(
  makeNode({
    kind: 'SchemaProperty',
    canonicalName: 'OrderDto#/email',
    sourceRef: LEAK.nodeRef,
    props: { required: true },
  }),
);

const NODES = [file, handler, helper, removed, orderEmail, emailProperty];
const EDGES = [
  stampedEdge(
    makeEdge({
      kind: 'CONTAINS',
      src: file.id,
      dst: handler.id,
      provenance: 'EXTRACTED',
      confidence: 1,
      sourceRef: LEAK.edgeRef,
    }),
  ),
  stampedEdge(
    makeEdge({
      kind: 'CALLS',
      src: handler.id,
      dst: helper.id,
      provenance: 'EXTRACTED',
      confidence: 1,
      sourceRef: LEAK.edgeRef,
    }),
  ),
  stampedEdge(
    makeEdge({
      kind: 'CALLS',
      src: handler.id,
      dst: removed.id,
      provenance: 'EXTRACTED',
      confidence: 1,
      sourceRef: LEAK.edgeRef,
      deletedAt: LEAK.deletedAt,
    }),
  ),
  stampedEdge(
    makeEdge({
      kind: 'EXPOSED_AS',
      src: orderEmail.id,
      dst: emailProperty.id,
      provenance: 'INFERRED',
      confidence: 0.8,
      sourceRef: LEAK.edgeRef,
    }),
  ),
];

const RUN = makeRun(LEAK.lastRun, [makeResult('extract-code-ts', 'PASS', ['code.ts'])]);
const DETECTION: DetectionReport = {
  contradictions: [
    {
      code: 'X1_NULLABILITY',
      severity: 'high',
      left: orderEmail.id,
      right: emailProperty.id,
      claim: 'a claim the server rebuilds',
      leftFact: 'optional=false',
      rightFact: 'required=true',
      viaPath: ['EXPOSED_AS'],
      confidence: 0.8,
    },
  ],
  unknown: [],
};

/**
 * A profile over the graph above that names `fields` and the props in
 * `props` (which needs `props` among the fields).
 */
function profile(
  fields: readonly RecordField[],
  props: ExportProfile['allowProps'] = {},
): ExportProfile {
  return parseExportProfile({
    version: 1,
    name: 'agent-surface',
    description: 'test fixture: what the agent surface prints',
    allow: pairs(['File', 'Symbol', 'CodeField', 'SchemaProperty'], ['internal']),
    allowEdges: ['CONTAINS', 'CALLS', 'EXPOSED_AS'],
    allowProps: props,
    allowEdgeProps: {},
    allowFields: fields,
    allowProvenance: ['EXTRACTED', 'DECLARED', 'INFERRED', 'LLM_SUGGESTED'],
    includeUntrusted: false,
  });
}

function serve(p: ExportProfile) {
  return createServer({
    graph: memorySource({ nodes: NODES, edges: EDGES, run: RUN, detection: DETECTION }),
    profile: p,
    nonce: fixedNonce(),
  });
}

type CallResult = Awaited<ReturnType<ReturnType<typeof createServer>['callTool']>>;

function ok(v: CallResult): ToolEnvelope {
  assert.ok(!('error' in v), `tool succeeded: ${JSON.stringify(v)}`);
  return v;
}

const LOCATION_VALUES = [LEAK.path, LEAK.nodeRef, LEAK.edgeRef];
const LIFECYCLE_VALUES = [LEAK.firstRun, LEAK.lastRun, LEAK.deletedAt];

/** Every value that only a named location or lifecycle field may release. */
function assertNoneOf(text: string, values: readonly string[], why: string): void {
  for (const value of values) assert.ok(!text.includes(value), `${why}: ${value} must not print`);
  assert.doesNotMatch(text, /deletedAt|firstSeenRun|lastSeenRun/, `${why}: no lifecycle key`);
}

describe('mcp / the agent surface prints a fixed set of fields, whatever allowFields says', () => {
  const NO_OPTIONAL_FIELDS = profile([]);

  test('context prints identity, provenance, confidence and sensitivity, and no location or lifecycle value', async () => {
    const env = ok(await serve(NO_OPTIONAL_FIELDS).callTool('context', { symbol: handler.id }));
    const r = env.result as {
      found: boolean;
      node: Record<string, unknown>;
      edges: Array<Record<string, unknown>>;
    };
    assert.equal(r.found, true);
    assert.deepEqual(r.node, {
      id: handler.id,
      kind: 'Symbol',
      name: 'createOrder',
      path: null,
      provenance: 'EXTRACTED',
      confidence: 1,
      sensitivity: 'internal',
      untrusted: false,
      props: {},
    });
    assert.deepEqual(
      r.edges.map((e) => Object.keys(e)),
      r.edges.map(() => ['kind', 'src', 'dst', 'provenance', 'confidence', 'sourceRef']),
    );
    assert.ok(r.edges.length >= 2, 'the node has incident edges to inspect');
    for (const e of r.edges) {
      assert.equal(typeof e['provenance'], 'string');
      assert.equal(typeof e['confidence'], 'number');
      assert.equal(e['sourceRef'], null);
    }
    assertNoneOf(
      JSON.stringify(env),
      [...LOCATION_VALUES, ...LIFECYCLE_VALUES],
      'allowFields is empty',
    );
  });

  test('explain prints the same, and says a node is a tombstone without saying when', async () => {
    const s = serve(NO_OPTIONAL_FIELDS);
    const live = ok(await s.callTool('explain', { id: handler.id }));
    const liveResult = live.result as {
      node: Record<string, unknown>;
      sourceRef: unknown;
      lifecycle: unknown;
      incidentEdges: Array<Record<string, unknown>>;
    };
    assert.deepEqual(liveResult.node, {
      id: handler.id,
      kind: 'Symbol',
      name: 'createOrder',
      path: null,
      provenance: 'EXTRACTED',
      confidence: 1,
      sensitivity: 'internal',
      untrusted: false,
      props: {},
    });
    assert.equal(liveResult.sourceRef, null);
    assert.deepEqual(liveResult.lifecycle, { tombstoned: false });
    assert.ok(liveResult.incidentEdges.length > 0);
    for (const e of liveResult.incidentEdges) {
      assert.deepEqual(Object.keys(e).sort(), [
        'confidence',
        'direction',
        'dst',
        'kind',
        'other',
        'otherKind',
        'provenance',
        'sourceRef',
        'src',
      ]);
      assert.equal(e['sourceRef'], null);
    }
    assertNoneOf(
      JSON.stringify(live),
      [...LOCATION_VALUES, ...LIFECYCLE_VALUES],
      'explain, live node',
    );

    const gone = ok(await s.callTool('explain', { id: removed.id }));
    assert.deepEqual((gone.result as { lifecycle: unknown }).lifecycle, { tombstoned: true });
    assertNoneOf(
      JSON.stringify(gone),
      [...LOCATION_VALUES, ...LIFECYCLE_VALUES],
      'explain, tombstone',
    );
  });

  test('naming more fields that are not location or lifecycle fields changes nothing a tool prints', async () => {
    const outcomes = new Set<string>();
    for (const fields of [
      [],
      ['kind'],
      ['id', 'kind', 'name'],
      ['id', 'kind', 'name', 'sensitivity', 'provenance', 'confidence', 'untrusted', 'src', 'dst'],
    ] as RecordField[][]) {
      const s = serve(profile(fields));
      const answers = [
        await s.callTool('context', { symbol: handler.id, depth: 2 }),
        await s.callTool('explain', { id: handler.id }),
        await s.callTool('explain', { id: removed.id }),
      ];
      outcomes.add(JSON.stringify(answers));
    }
    assert.equal(outcomes.size, 1, 'the four profiles produced byte-identical answers');
  });

  test('the props that print are the props allowProps names, and only with `props` selected', async () => {
    const named = profile(['props'], { Symbol: ['symbolKind'] });
    const env = ok(await serve(named).callTool('explain', { id: handler.id }));
    const node = (env.result as { node: { props: Record<string, unknown> } }).node;
    assert.deepEqual(node.props, { symbolKind: 'function' }, 'the prop no profile names stays out');
    assert.ok(!JSON.stringify(env).includes('a prop no profile names'));

    // The agent surface and a file can never disagree about props: a profile that
    // allows props without selecting `props` is refused when the server starts.
    assert.throws(
      () =>
        createServer({
          graph: memorySource({ nodes: NODES, edges: EDGES }),
          profile: {
            ...named,
            allowFields: ['kind'],
          } as unknown as ExportProfile,
          nonce: fixedNonce(),
        }),
      /export profile 'agent-surface': `allowProps` is not empty but `allowFields` does not name `props`/,
    );
  });

  test('naming the location and lifecycle fields prints them (so the searches above are not vacuous)', async () => {
    const loud = profile([
      'path',
      'sourceRef',
      'srcFile',
      'dstFile',
      'firstSeenRun',
      'lastSeenRun',
      'deletedAt',
    ]);
    const s = serve(loud);
    const live = JSON.stringify(ok(await s.callTool('explain', { id: handler.id })));
    for (const value of [LEAK.path, LEAK.nodeRef, LEAK.edgeRef, LEAK.firstRun, LEAK.lastRun]) {
      assert.ok(live.includes(value), `${value} prints when named`);
    }
    const gone = JSON.stringify(ok(await s.callTool('explain', { id: removed.id })));
    assert.ok(gone.includes(LEAK.deletedAt), 'a deletion time prints when deletedAt is named');
  });
});

describe('mcp / no tool prints a run id or a deletion time unless the profile names it', () => {
  /** One valid call per tool, plus the variants that reach different code paths. */
  const CALLS: Record<string, ReadonlyArray<Record<string, unknown>>> = {
    context: [
      { symbol: handler.id },
      { symbol: handler.id, depth: 3 },
      { symbol: handler.id, tokenBudget: 4000 },
      { symbol: 'price' },
      { symbol: 'legacy' },
    ],
    impact: [
      { ids: [handler.id] },
      { ids: [handler.id, removed.id], depth: 3 },
      { ids: [helper.id], targets: 'tests' },
      { ids: [handler.id], tokenBudget: 4000 },
    ],
    lineage: [{ field: 'Order.email' }, { field: orderEmail.id, depth: 3 }],
    contradictions: [{}],
    explain: [{ id: handler.id }, { id: removed.id }, { id: file.id }, { id: orderEmail.id }],
  };

  test('every registered tool has calls here, so a new tool cannot be added without them', () => {
    assert.deepEqual(Object.keys(CALLS).sort(), [...TOOL_NAMES].sort());
  });

  test('under a profile that names no lifecycle field, no tool output carries a run id or deletedAt', async () => {
    const s = serve(profile(['id', 'kind', 'name', 'path', 'sourceRef']));
    let calls = 0;
    for (const name of TOOL_NAMES) {
      for (const args of CALLS[name] ?? []) {
        const out = await s.callTool(name, args);
        assert.ok(!('error' in out), `${name} ${JSON.stringify(args)}: ${JSON.stringify(out)}`);
        const text = JSON.stringify(out);
        const label = `${name} ${JSON.stringify(args)}`;
        for (const value of LIFECYCLE_VALUES)
          assert.ok(!text.includes(value), `${label}: ${value}`);
        assert.doesNotMatch(text, /deletedAt|firstSeenRun|lastSeenRun/, label);
        calls += 1;
      }
    }
    assert.ok(calls >= TOOL_NAMES.length, 'every tool was called');
  });

  test('the same calls under a profile that names them do print them (the loop can fail)', async () => {
    const s = serve(profile(['firstSeenRun', 'lastSeenRun', 'deletedAt']));
    let printed = 0;
    for (const name of TOOL_NAMES) {
      for (const args of CALLS[name] ?? []) {
        const text = JSON.stringify(await s.callTool(name, args));
        if (LIFECYCLE_VALUES.some((v) => text.includes(v))) printed += 1;
      }
    }
    assert.ok(printed > 0, 'at least one tool prints a lifecycle value when it is named');
  });
});

// ---------------------------------------------------------------------------
// The shipped profiles, over kinds all three admit (public profile lifecycle fields)
// ---------------------------------------------------------------------------

describe('mcp / the shipped profiles and the lifecycle fields', () => {
  const repo = stamped(makeNode({ kind: 'Repo', canonicalName: 'demo' }));
  const mod = stamped(makeNode({ kind: 'Module', canonicalName: 'orders' }));
  const gone = stamped(
    makeNode({ kind: 'Module', canonicalName: 'legacy', deletedAt: LEAK.deletedAt }),
  );
  const operation = stamped(
    makeNode({ kind: 'Operation', canonicalName: 'GET /orders', props: { method: 'GET' } }),
  );
  const nodes = [repo, mod, gone, operation];
  const edges = [
    stampedEdge(
      makeEdge({
        kind: 'CONTAINS',
        src: repo.id,
        dst: mod.id,
        provenance: 'EXTRACTED',
        confidence: 1,
      }),
    ),
    stampedEdge(
      makeEdge({
        kind: 'CONTAINS',
        src: repo.id,
        dst: gone.id,
        provenance: 'EXTRACTED',
        confidence: 1,
        deletedAt: LEAK.deletedAt,
      }),
    ),
  ];
  const calls: Record<string, ReadonlyArray<Record<string, unknown>>> = {
    context: [{ symbol: repo.id }, { symbol: mod.id, depth: 3 }, { symbol: 'orders' }],
    impact: [{ ids: [mod.id] }, { ids: [repo.id, gone.id], depth: 3 }],
    lineage: [{ field: operation.id }],
    contradictions: [{}],
    explain: [{ id: repo.id }, { id: mod.id }, { id: gone.id }, { id: operation.id }],
  };

  function serveShipped(p: ExportProfile) {
    return createServer({
      graph: memorySource({ nodes, edges, run: RUN, detection: DETECTION }),
      profile: p,
      nonce: fixedNonce(),
    });
  }

  async function everything(p: ExportProfile): Promise<Map<string, string>> {
    const s = serveShipped(p);
    const out = new Map<string, string>();
    for (const name of TOOL_NAMES) {
      for (const args of calls[name] ?? []) {
        const label = `${name} ${JSON.stringify(args)}`;
        const result = await s.callTool(name, args);
        assert.ok(!('error' in result), `${label}: ${JSON.stringify(result)}`);
        out.set(label, JSON.stringify(result));
      }
    }
    return out;
  }

  test('every registered tool has calls here', () => {
    assert.deepEqual(Object.keys(calls).sort(), [...TOOL_NAMES].sort());
  });

  test('under public, no tool prints a run id, a deletion time or a lifecycle key', async () => {
    const outputs = await everything(PUBLIC_PROFILE);
    assert.ok(outputs.size >= TOOL_NAMES.length);
    for (const [label, text] of outputs) {
      for (const value of LIFECYCLE_VALUES) assert.ok(!text.includes(value), `${label}: ${value}`);
      assert.doesNotMatch(text, /deletedAt|firstSeenRun|lastSeenRun/, label);
    }
    // The tombstone is still reported as one, without its time.
    const tomb = outputs.get(`explain ${JSON.stringify({ id: gone.id })}`) ?? '';
    assert.match(tomb, /"tombstoned":true/);
  });

  test('under team and audit, explain still prints the run ids and the deletion time', async () => {
    for (const p of [TEAM_PROFILE, AUDIT_PROFILE]) {
      const outputs = await everything(p);
      const live = outputs.get(`explain ${JSON.stringify({ id: mod.id })}`) ?? '';
      const tomb = outputs.get(`explain ${JSON.stringify({ id: gone.id })}`) ?? '';
      assert.ok(live.includes(LEAK.firstRun) && live.includes(LEAK.lastRun), `${p.name}: run ids`);
      assert.match(live, /"firstSeenRun"/, p.name);
      assert.match(live, /"lastSeenRun"/, p.name);
      assert.ok(tomb.includes(LEAK.deletedAt), `${p.name}: deletedAt`);
    }
  });
});
