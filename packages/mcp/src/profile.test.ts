/**
 * Every MCP tool is evaluated inside an export-profile view.
 *
 * The property under test is the one `seamline export` already enforces for a
 * file: nothing a profile withholds may reach the caller. On the agent path
 * that has to hold for more than the returned nodes. A withheld node must not
 * be reachable as a hop in a traversal, must not be counted in a truncation
 * total or a `byKind` tally, and a prop the profile does not name must not
 * ride along on an admitted node. The differential test states all of that at
 * once: two graphs that agree on everything the profile admits must produce
 * byte-identical responses from every tool, however much they differ above
 * the ceiling.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import fc from 'fast-check';
import {
  NODE_KINDS,
  type NodeKind,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import {
  AUDIT_PROFILE,
  pairs,
  PUBLIC_PROFILE,
  TEAM_PROFILE,
  type ExportProfile,
} from '@seamline/core';
import type { DetectionReport } from './ports.ts';
import type { ToolEnvelope } from './result.ts';
import { createServer } from './server.ts';
import { fixedNonce, makeEdge, makeNode, makeResult, makeRun, memorySource } from './testing.ts';

/**
 * A code-only profile: symbols, fields and files at `internal`, nothing from
 * the data model. `Table` and `Column` default to `confidential`, so no pair
 * here can admit them.
 */
const CODE_ONLY: ExportProfile = {
  version: 1,
  name: 'code-only',
  description: 'test fixture: code surface at internal, no data model',
  allow: pairs(['Module', 'File', 'Symbol', 'CodeField', 'SchemaProperty'], ['internal']),
  allowEdges: ['CONTAINS', 'CALLS', 'QUERIES', 'MAPS_TO_FIELD', 'EXPOSED_AS', 'VALIDATED_BY'],
  allowProps: { Symbol: ['symbolKind'], CodeField: ['optional'], SchemaProperty: ['required'] },
  allowEdgeProps: {},
  allowFields: ['path', 'props', 'untrusted'],
  allowProvenance: ['EXTRACTED', 'DECLARED', 'INFERRED', 'LLM_SUGGESTED'],
  includeUntrusted: true,
};

const usersTable = makeNode({ kind: 'Table', canonicalName: 'public.users' });
const emailColumn = makeNode({
  kind: 'Column',
  canonicalName: 'public.users.email',
  props: {
    type: 'text',
    nullable: false,
    pii: 'email',
    piiConfidence: 0.9,
    piiEvidence: 'column name',
  },
});
const tableHasColumn = makeEdge({
  kind: 'CONTAINS',
  src: usersTable.id,
  dst: emailColumn.id,
  provenance: 'EXTRACTED',
  confidence: 1,
});

type CallResult = Awaited<ReturnType<ReturnType<typeof createServer>['callTool']>>;

function okEnvelope(v: CallResult): ToolEnvelope {
  assert.ok(!('error' in v), `tool succeeded: ${JSON.stringify(v)}`);
  return v;
}

function serve(
  profile: ExportProfile,
  nodes: readonly SeamlineNode[],
  edges: readonly SeamlineEdge[] = [],
) {
  return createServer({ graph: memorySource({ nodes, edges }), profile, nonce: fixedNonce() });
}

describe('mcp / the server refuses to start without a profile', () => {
  test('createServer with no profile throws instead of serving the whole store', () => {
    assert.throws(
      () =>
        createServer({ graph: memorySource({ nodes: [emailColumn] }) } as unknown as Parameters<
          typeof createServer
        >[0]),
      /export profile/,
    );
  });
});

describe('mcp / withheld nodes never reach the caller', () => {
  test('context on a table below the profile ceiling finds nothing and names nothing', async () => {
    const s = serve(CODE_ONLY, [usersTable, emailColumn], [tableHasColumn]);
    const env = okEnvelope(await s.callTool('context', { symbol: 'users' }));
    const r = env.result as { found: boolean; candidates: unknown[] };
    assert.equal(r.found, false);
    assert.deepEqual(r.candidates, []);
    const text = JSON.stringify(env);
    assert.doesNotMatch(text, /public\.users/);
    assert.doesNotMatch(text, /pii/);
  });

  test('a withheld node id resolves nowhere: explain and impact treat it as absent', async () => {
    const s = serve(CODE_ONLY, [usersTable, emailColumn], [tableHasColumn]);
    const explained = okEnvelope(await s.callTool('explain', { id: emailColumn.id }));
    assert.equal((explained.result as { found: boolean }).found, false);
    const impact = okEnvelope(await s.callTool('impact', { ids: [emailColumn.id] }));
    assert.deepEqual((impact.result as { reached: unknown[] }).reached, []);
    assert.deepEqual((impact.result as { missing: string[] }).missing, [emailColumn.id]);
  });

  test('impact does not reach through a withheld node that sits between two admitted ones', async () => {
    const reader = makeNode({
      kind: 'Symbol',
      canonicalName: 'src/read#loadUser',
      path: 'src/read.ts',
    });
    const writer = makeNode({
      kind: 'Symbol',
      canonicalName: 'src/write#saveUser',
      path: 'src/write.ts',
    });
    const edges = [
      makeEdge({
        kind: 'QUERIES',
        src: reader.id,
        dst: usersTable.id,
        provenance: 'EXTRACTED',
        confidence: 1,
      }),
      makeEdge({
        kind: 'QUERIES',
        src: writer.id,
        dst: usersTable.id,
        provenance: 'EXTRACTED',
        confidence: 1,
      }),
    ];
    const s = serve(CODE_ONLY, [reader, writer, usersTable], edges);
    const env = okEnvelope(await s.callTool('impact', { ids: [reader.id], depth: 4 }));
    const r = env.result as {
      reached: Array<{ node: { id: string } }>;
      byKind: Record<string, number>;
    };
    assert.deepEqual(
      r.reached,
      [],
      'the only path from reader to writer runs through the withheld table',
    );
    assert.deepEqual(r.byKind, {});
    assert.equal(env.truncated, false);
  });

  test('props the profile does not name are stripped from an admitted node', async () => {
    const s = serve(TEAM_PROFILE, [usersTable, emailColumn], [tableHasColumn]);
    const env = okEnvelope(await s.callTool('explain', { id: emailColumn.id }));
    const r = env.result as { found: boolean; node: { props: Record<string, unknown> } };
    assert.equal(r.found, true);
    assert.deepEqual(r.node.props, { nullable: false, type: 'text' });
  });

  test('path is stripped unless the profile names it', async () => {
    const mod = makeNode({
      kind: 'Module',
      canonicalName: 'src/orders',
      path: 'src/orders/index.ts',
    });
    const s = serve(PUBLIC_PROFILE, [mod]);
    const env = okEnvelope(await s.callTool('explain', { id: mod.id }));
    const r = env.result as { found: boolean; node: { path: string | null } };
    assert.equal(r.found, true);
    assert.equal(r.node.path, null);
  });

  test('a truncation total and a match count include only in-view items', async () => {
    const visible = ['Order', 'Invoice'].map((owner) =>
      makeNode({
        kind: 'CodeField',
        canonicalName: `${owner}.email`,
        path: `src/${owner.toLowerCase()}.ts`,
      }),
    );
    const hidden = Array.from({ length: 30 }, (_, i) =>
      makeNode({ kind: 'Column', canonicalName: `public.t${i}.email` }),
    );
    const s = createServer({
      graph: memorySource({ nodes: [...visible, ...hidden] }),
      profile: CODE_ONLY,
      nonce: fixedNonce(),
      bounds: { maxResults: 1 },
    });
    const env = okEnvelope(await s.callTool('context', { symbol: 'email' }));
    const r = env.result as { ambiguous: boolean; totalMatches: number; candidates: unknown[] };
    assert.equal(r.ambiguous, true);
    assert.equal(r.totalMatches, visible.length);
    assert.equal(env.truncated, true);
    assert.deepEqual(
      {
        returned: (env.truncation as { returned: number }).returned,
        total: (env.truncation as { total: number }).total,
      },
      { returned: 1, total: visible.length },
    );
    assert.doesNotMatch(JSON.stringify(env), /public\.t\d/);
  });
});

describe('mcp / detection is read through the profile too', () => {
  test('a finding whose endpoint is withheld is dropped', async () => {
    const userEmail = makeNode({
      kind: 'CodeField',
      canonicalName: 'User.email',
      path: 'src/user.ts',
    });
    const s = createServer({
      graph: memorySource({
        nodes: [usersTable, emailColumn, userEmail],
        edges: [tableHasColumn],
        detection: {
          contradictions: [
            {
              code: 'X1_NULLABILITY',
              severity: 'critical',
              left: emailColumn.id,
              right: userEmail.id,
              claim: 'NOT NULL column mapped to an optional field',
              leftFact: 'nullable=false',
              rightFact: 'optional=true',
              viaPath: ['MAPS_TO_FIELD'],
              confidence: 0.9,
            },
          ],
          unknown: [],
        },
      }),
      profile: CODE_ONLY,
      nonce: fixedNonce(),
    });
    const env = okEnvelope(await s.callTool('contradictions', {}));
    const r = env.result as { available: boolean; total: number; findings: unknown[] };
    assert.equal(r.available, true);
    assert.equal(r.total, 0);
    assert.deepEqual(r.findings, []);
    assert.doesNotMatch(JSON.stringify(env), /public\.users/);
  });
});

describe('mcp / run metadata is read through the profile too', () => {
  const handlerSymbol = makeNode({
    kind: 'Symbol',
    canonicalName: 'src/a.ts#handler',
    path: 'src/a.ts',
  });
  const payrollColumn = makeNode({
    kind: 'Column',
    canonicalName: 'hr.salaries.ssn',
    props: { pii: 'ssn' },
  });

  test('extractor diagnostics never reach the caller: unknown carries scope and status only', async () => {
    const s = createServer({
      graph: memorySource({
        nodes: [handlerSymbol, payrollColumn],
        scopeStatus: { data: 'FAIL' },
        run: makeRun('run-1', [
          makeResult('extract-code-ts', 'PASS', ['code.ts']),
          makeResult(
            'extract-data',
            'FAIL',
            ['data'],
            ['SCHEMA_DEPTH_EXCEEDED: db/hr/salaries.schema.json#/properties/ssn'],
          ),
        ]),
      }),
      profile: CODE_ONLY,
      nonce: fixedNonce(),
    });
    const env = okEnvelope(await s.callTool('context', { symbol: 'handler' }));
    assert.deepEqual(env.unknown, [
      { scope: 'data', status: 'FAIL', extractor: 'extract-data', diagnostics: [] },
    ]);
    const line = await s.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'context', arguments: { symbol: 'handler' } },
      }),
    );
    for (const out of [JSON.stringify(env), line ?? '']) {
      assert.doesNotMatch(out, /salaries|ssn|SCHEMA_DEPTH/);
    }
  });

  test('the count of contract files not read crosses a profile that releases no contract kind, and nothing else of the diagnostic does', async () => {
    // Deliberate: like `unknown`, which lists scope, status and extractor
    // whatever kinds the profile releases, the notice states how many files an
    // extractor left out of its claim. It is a count, not a name, and a reader
    // who is told "none" has to be told what "none" rests on.
    const NO_CONTRACTS: ExportProfile = {
      ...CODE_ONLY,
      name: 'no-contracts',
      allow: pairs(['Module', 'File', 'Symbol', 'CodeField'], ['internal']),
      allowProps: { Symbol: ['symbolKind'], CodeField: ['optional'] },
    };
    const releasesContracts = NO_CONTRACTS.allow.some(([kind]) =>
      ['Contract', 'SchemaProperty', 'Operation'].includes(kind),
    );
    assert.equal(releasesContracts, false, 'the fixture profile releases no contract kind');

    const narrowedRun = makeRun('run-1', [
      {
        ...makeResult(
          'extract-contracts',
          'PASS',
          ['contracts'],
          [
            'CONTRACTS_PARTIAL_COVERAGE: 4 file(s) are outside the authoritative claim; see hr/salaries.schema.ts',
          ],
        ),
        authoritative: [{ scope: 'contracts', kinds: [], selector: '{src/a/**,src/main.ts}' }],
      },
    ]);
    const s = createServer({
      graph: memorySource({
        nodes: [handlerSymbol],
        detection: { contradictions: [], unknown: [] },
        run: narrowedRun,
      }),
      profile: NO_CONTRACTS,
      nonce: fixedNonce(),
    });
    const env = okEnvelope(await s.callTool('contradictions', {}));
    assert.deepEqual((env.result as { findings: unknown[] }).findings, []);
    assert.match(
      env.notices.join('\n'),
      /PARTIAL COVERAGE: the contracts claim is partial: 4 file\(s\) not read to the end \(extract-contracts\)/,
    );
    // The count crosses; the diagnostic's own text does not.
    assert.doesNotMatch(JSON.stringify(env), /salaries|hr\//);
    assert.deepEqual(env.unknown, []);
  });
});

describe('mcp / detector output is rebuilt from the view, not forwarded', () => {
  const left = makeNode({
    kind: 'CodeField',
    canonicalName: 'User.email',
    props: { optional: true },
  });
  const right = makeNode({
    kind: 'SchemaProperty',
    canonicalName: 'UserDto#/email',
    props: { required: true },
  });
  const payrollColumn = makeNode({
    kind: 'Column',
    canonicalName: 'hr.salaries.ssn',
    props: { pii: 'ssn' },
  });

  function withDetection(detection: DetectionReport) {
    return createServer({
      graph: memorySource({
        nodes: [left, right, payrollColumn],
        run: makeRun('run-1', [makeResult('extract-data', 'FAIL', ['data'])]),
        scopeStatus: { data: 'FAIL' },
        detection,
      }),
      profile: CODE_ONLY,
      nonce: fixedNonce(),
    });
  }

  for (const [label, viaPath] of [
    ['a string', 'EXPOSED_AS'],
    ['a nested array', [['EXPOSED_AS']]],
    [
      'an array-like object that answers every() with true',
      {
        length: 1,
        every: () => true,
        join: () => 'hr.salaries.ssn',
        *[Symbol.iterator]() {
          yield 'hr.salaries.ssn';
        },
      },
    ],
  ] as const) {
    test(`a finding whose viaPath is ${label} is dropped, not trusted`, async () => {
      const s = withDetection({
        contradictions: [
          {
            code: 'X1_NULLABILITY',
            severity: 'critical',
            left: left.id,
            right: right.id,
            claim: 'x',
            leftFact: 'x',
            rightFact: 'x',
            viaPath: viaPath as unknown as DetectionReport['contradictions'][number]['viaPath'],
            confidence: 1,
          },
        ],
        unknown: [],
      });
      const line = await s.handle(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'contradictions', arguments: {} },
        }),
      );
      const reply = JSON.parse(line ?? '{}') as {
        result?: { structuredContent: { result: { total: number } } };
      };
      assert.equal(reply.result?.structuredContent.result.total, 0, line ?? '');
      assert.doesNotMatch(line ?? '', /salaries|ssn/);
    });
  }

  test('a finding whose viaPath crosses an edge kind the profile does not allow is dropped', async () => {
    const s = withDetection({
      contradictions: [
        {
          code: 'X1_NULLABILITY',
          severity: 'critical',
          left: left.id,
          right: right.id,
          claim: 'joined through a column',
          leftFact: 'x',
          rightFact: 'y',
          viaPath: ['BACKED_BY', 'FK_TO'],
          confidence: 1,
        },
      ],
      unknown: [],
    });
    const env = okEnvelope(await s.callTool('contradictions', {}));
    const r = env.result as { total: number; findings: unknown[] };
    assert.equal(r.total, 0);
    assert.doesNotMatch(JSON.stringify(env), /FK_TO|BACKED_BY/);
  });

  test('claim and facts from a detector that ignored the view are replaced by text rendered from the view', async () => {
    const s = withDetection({
      contradictions: [
        {
          code: 'X1_NULLABILITY',
          severity: 'critical',
          left: left.id,
          right: right.id,
          claim: 'mapped via hr.salaries.ssn',
          leftFact: 'backs column hr.salaries.ssn (pii=ssn)',
          rightFact: 'required, see db/hr/salaries.sql',
          viaPath: ['EXPOSED_AS'],
          confidence: 0.9,
        },
      ],
      unknown: [],
    });
    const env = okEnvelope(await s.callTool('contradictions', {}));
    const r = env.result as {
      findings: Array<{
        code: string;
        left: string;
        right: string;
        claim: string;
        leftFact: string;
        rightFact: string;
      }>;
    };
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.equal(f?.left, left.id);
    assert.equal(f?.right, right.id);
    assert.equal(f?.leftFact, 'CodeField email: optional=true');
    assert.equal(f?.rightFact, 'SchemaProperty email: required=true');
    assert.doesNotMatch(JSON.stringify(env), /salaries|ssn/);
  });

  test('an unknown detector keeps only known scopes, and its reason is rebuilt from their status', async () => {
    const s = withDetection({
      contradictions: [],
      unknown: [
        {
          code: 'X6_PII_UNAUTHENTICATED',
          severity: 'critical',
          reason: 'could not read db/hr/salaries.sql',
          scopes: ['data', 'hr.salaries'],
          scopeStatus: { data: 'FAIL', 'hr.salaries': 'FAIL' },
        },
      ],
    });
    const env = okEnvelope(await s.callTool('contradictions', {}));
    const r = env.result as {
      unknownDetectors: Array<{ reason: string; scopes: string[]; scopeStatus: object }>;
    };
    assert.deepEqual(r.unknownDetectors, [
      {
        code: 'X6_PII_UNAUTHENTICATED',
        severity: 'critical',
        reason: 'SCOPE_NOT_PASS: scope(s) not PASS: data=FAIL',
        scopes: ['data'],
        scopeStatus: { data: 'FAIL' },
      },
    ]);
    assert.doesNotMatch(JSON.stringify(env), /salaries/);
  });

  test('the code that starts a rebuilt reason is the one the detector runner declares', async () => {
    // The server does not depend on the detectors, so `profiled.ts` repeats the code. The runner's
    // declaration is the source of truth, and this fails when the two stop agreeing.
    const runner = await readFile(
      new URL('../../contradictions/src/runner.ts', import.meta.url),
      'utf8',
    );
    const declared = /export const SCOPE_NOT_PASS = '([A-Z_]+)';/.exec(runner)?.[1];
    assert.ok(declared !== undefined, 'runner.ts declares SCOPE_NOT_PASS');
    const reasonFor = async (scopes: string[]): Promise<string | undefined> => {
      const s = withDetection({
        contradictions: [],
        unknown: [
          {
            code: 'X6_PII_UNAUTHENTICATED',
            severity: 'critical',
            reason: 'ignored',
            scopes,
            scopeStatus: Object.fromEntries(scopes.map((scope) => [scope, 'FAIL'])),
          },
        ],
      });
      const env = okEnvelope(await s.callTool('contradictions', {}));
      return (env.result as { unknownDetectors: Array<{ reason: string }> }).unknownDetectors[0]
        ?.reason;
    };
    // A listed scope the profile does not declare is withheld: the reason still starts with the code.
    for (const scopes of [['not-declared'], ['data']]) {
      const reason = await reasonFor(scopes);
      assert.ok(reason?.startsWith(`${declared}: `), `${JSON.stringify(scopes)}: ${reason}`);
    }
  });

  test('a detector that is UNKNOWN for its own reason is listed with no scope and a reason that does not blame one', async () => {
    const s = withDetection({
      contradictions: [],
      unknown: [
        {
          code: 'X5_UNWRITTEN_COLUMN',
          severity: 'medium',
          // The detector's own text may name what the profile withholds: it is not passed on.
          reason: '3 write call(s) could not be attributed to hr.salaries',
          scopes: [],
          scopeStatus: {},
        },
      ],
    });
    const env = okEnvelope(await s.callTool('contradictions', {}));
    const r = env.result as {
      unknownDetectors: Array<{ reason: string; scopes: string[]; scopeStatus: object }>;
    };
    assert.deepEqual(r.unknownDetectors, [
      {
        code: 'X5_UNWRITTEN_COLUMN',
        severity: 'medium',
        reason: 'the extractors recorded facts that leave this detector unable to answer',
        scopes: [],
        scopeStatus: {},
      },
    ]);
    assert.doesNotMatch(JSON.stringify(env), /salaries/);
    assert.doesNotMatch(JSON.stringify(r.unknownDetectors), /scope this detector requires/);
  });
});

describe('mcp / an internal error reaches the client without its detail', () => {
  const handlerSymbol = makeNode({ kind: 'Symbol', canonicalName: 'src/a.ts#handler' });

  test('a detector that throws yields a generic error to the client and the detail to the server log only', async () => {
    const logged: string[] = [];
    const audited: Array<{ tool: string; ok: boolean; error?: string }> = [];
    const base = memorySource({ nodes: [handlerSymbol] });
    const s = createServer({
      graph: {
        ...base,
        detect: () => Promise.reject(new Error('column hr.salaries.ssn has no type')),
      },
      profile: CODE_ONLY,
      nonce: fixedNonce(),
      log: (line) => logged.push(line),
      audit: (e) =>
        audited.push({
          tool: e.tool,
          ok: e.ok,
          ...(e.error === undefined ? {} : { error: e.error }),
        }),
    });
    const line = await s.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'contradictions', arguments: {} },
      }),
    );
    const reply = JSON.parse(line ?? '{}') as { error?: { code: number; message: string } };
    assert.equal(reply.error?.code, -32603);
    assert.doesNotMatch(line ?? '', /salaries|ssn|no type/);
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? '', /hr\.salaries\.ssn has no type/);
    assert.deepEqual(audited, [{ tool: 'contradictions', ok: false, error: 'internal-error' }]);
  });

  test('a graph source that throws while opening the view is reported the same way', async () => {
    const logged: string[] = [];
    const s = createServer({
      graph: {
        view: () => Promise.reject(new Error('cannot open /srv/private/graph.db')),
        latestRun: () => Promise.resolve(undefined),
      },
      profile: CODE_ONLY,
      nonce: fixedNonce(),
      log: (line) => logged.push(line),
    });
    const line = await s.handle(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'context', arguments: { symbol: 'x' } },
      }),
    );
    assert.doesNotMatch(line ?? '', /private|graph\.db/);
    assert.match(logged.join('\n'), /\/srv\/private\/graph\.db/);
  });
});

describe('mcp / the profile is validated and pinned when the server starts', () => {
  const graph = memorySource({
    nodes: [makeNode({ kind: 'Symbol', canonicalName: 'src/a.ts#handler' })],
  });

  for (const [label, bad] of [
    ['an empty object', {}],
    ['an empty allow-list', { ...CODE_ONLY, allow: [] }],
    [
      'a profile missing its edge, prop and field lists',
      { version: 1, name: 'partial', description: '', allow: [['Symbol', 'internal']] },
    ],
    ['a profile with no version', { ...CODE_ONLY, version: undefined }],
    ['a profile with a field the format does not have', { ...CODE_ONLY, maxSensitivity: 'public' }],
    ['an unknown sensitivity level', { ...CODE_ONLY, allow: [['Symbol', 'secret']] }],
    [
      'a prop allowance that is neither a list nor "*"',
      { ...CODE_ONLY, allowProps: { Symbol: 'all' } },
    ],
    ['a record field that does not exist', { ...CODE_ONLY, allowFields: ['path', 'author'] }],
    [
      'allowProps without `props` among the fields',
      { ...CODE_ONLY, allowFields: ['path', 'untrusted'] },
    ],
    [
      'includeUntrusted without `untrusted` among the fields',
      { ...CODE_ONLY, allowFields: ['path', 'props'] },
    ],
  ] as const) {
    test(`refuses ${label} at start, not on the first call`, () => {
      assert.throws(
        () =>
          createServer({ graph, profile: bad as unknown as ExportProfile, nonce: fixedNonce() }),
        /profile/,
      );
    });
  }

  test('a getter cannot pass validation with one allow-list and serve another', async () => {
    let reads = 0;
    const shifty = {
      ...CODE_ONLY,
      get allow() {
        reads += 1;
        return reads === 1 ? CODE_ONLY.allow : AUDIT_PROFILE.allow;
      },
    };
    const s = serve(
      shifty as unknown as ExportProfile,
      [usersTable, emailColumn],
      [tableHasColumn],
    );
    const env = okEnvelope(await s.callTool('context', { symbol: 'public.users.email' }));
    assert.equal((env.result as { found: boolean }).found, false);
    assert.doesNotMatch(JSON.stringify(env), /pii/);
  });

  test('a profile holding a function is refused, not cloned around', () => {
    assert.throws(
      () =>
        createServer({
          graph,
          profile: { ...CODE_ONLY, allowProps: { Symbol: () => '*' } } as unknown as ExportProfile,
          nonce: fixedNonce(),
        }),
      /profile/,
    );
  });

  test("mutating the caller's profile object after start changes nothing", async () => {
    const mutable = {
      ...CODE_ONLY,
      allow: [...CODE_ONLY.allow],
      allowEdges: [...CODE_ONLY.allowEdges],
      allowProps: { ...CODE_ONLY.allowProps },
    };
    const s = serve(mutable, [usersTable, emailColumn], [tableHasColumn]);
    mutable.allow.push(['Column', 'confidential'], ['Table', 'confidential']);
    mutable.allowEdges.push('CONTAINS');
    (mutable.allowProps as Record<string, unknown>)['Column'] = '*';
    const env = okEnvelope(await s.callTool('context', { symbol: 'public.users.email' }));
    assert.equal((env.result as { found: boolean }).found, false);
    assert.doesNotMatch(JSON.stringify(env), /pii/);
  });
});

// ---------------------------------------------------------------------------
// Differential: identical at or below the ceiling, arbitrary above it
// ---------------------------------------------------------------------------

/** Admitted under CODE_ONLY: the shared, in-view part of both graphs. */
const handler = makeNode({
  kind: 'Symbol',
  canonicalName: 'src/api#createOrder',
  path: 'src/api.ts',
  props: { symbolKind: 'function' },
});
const orderEmailField = makeNode({
  kind: 'CodeField',
  canonicalName: 'Order.email',
  path: 'src/order.ts',
  props: { optional: false },
});
const property = makeNode({
  kind: 'SchemaProperty',
  canonicalName: 'OrderDto#/email',
  props: { required: true },
});
const file = makeNode({ kind: 'File', canonicalName: 'src/api.ts', path: 'src/api.ts' });
const BASE_NODES = [handler, orderEmailField, property, file];
const BASE_EDGES = [
  makeEdge({
    kind: 'CONTAINS',
    src: file.id,
    dst: handler.id,
    provenance: 'EXTRACTED',
    confidence: 1,
  }),
  makeEdge({
    kind: 'EXPOSED_AS',
    src: orderEmailField.id,
    dst: property.id,
    provenance: 'INFERRED',
    confidence: 0.8,
  }),
  makeEdge({
    kind: 'CALLS',
    src: handler.id,
    dst: handler.id,
    provenance: 'EXTRACTED',
    confidence: 1,
  }),
];

/** Kinds CODE_ONLY never lists, so any node of these kinds is above the ceiling. */
const WITHHELD_KINDS: readonly NodeKind[] = NODE_KINDS.filter(
  (k) => !CODE_ONLY.allow.some(([kind]) => kind === k),
);

const CANDIDATE_NAMES = [
  'email',
  'orders',
  'createOrder',
  'Order.email',
  'OrderDto#/email',
  'secret',
  'users',
];

interface Hidden {
  readonly nodes: readonly SeamlineNode[];
  readonly edges: readonly SeamlineEdge[];
  readonly strayProps: Readonly<Record<string, string>>;
  /** Free text the store holds about a failed scope: extractor diagnostics. */
  readonly diagnostics: readonly string[];
  /** Detector prose, and findings that cite withheld nodes or withheld edge kinds. */
  readonly detectorText: string;
  readonly strayFindings: DetectionReport['contradictions'];
  readonly strayScopes: readonly string[];
}

const EMPTY_HIDDEN: Hidden = {
  nodes: [],
  edges: [],
  strayProps: {},
  diagnostics: [],
  detectorText: '',
  strayFindings: [],
  strayScopes: [],
};

const hiddenArb: fc.Arbitrary<Hidden> = fc
  .record({
    specs: fc.array(
      fc.oneof(
        fc.record({
          kind: fc.constantFrom(...WITHHELD_KINDS),
          name: fc.constantFrom(...CANDIDATE_NAMES),
          idx: fc.nat(5),
          raised: fc.constant(undefined),
        }),
        // An admitted kind declared above the ceiling: withheld by level, not by kind.
        fc.record({
          kind: fc.constantFrom<NodeKind>('Symbol', 'CodeField', 'File'),
          name: fc.constantFrom(...CANDIDATE_NAMES),
          idx: fc.nat(5),
          raised: fc.constantFrom<SeamlineNode['sensitivity']>('confidential', 'restricted'),
        }),
      ),
      { maxLength: 6 },
    ),
    links: fc.array(
      fc.record({
        kind: fc.constantFrom(...CODE_ONLY.allowEdges, 'FK_TO' as const, 'BACKED_BY' as const),
        hidden: fc.nat(20),
        base: fc.nat(3),
        outward: fc.boolean(),
      }),
      { maxLength: 10 },
    ),
    stray: fc.dictionary(
      fc.constantFrom('pii', 'secretNote', 'default'),
      fc.string({ maxLength: 8 }),
      { maxKeys: 3 },
    ),
    diagnostics: fc.array(fc.string({ maxLength: 24 }), { maxLength: 3 }),
    detectorText: fc.string({ maxLength: 24 }),
    findings: fc.array(
      fc.record({ hidden: fc.nat(20), base: fc.nat(3), crossesWithheldEdge: fc.boolean() }),
      { maxLength: 3 },
    ),
    strayScopes: fc.subarray(['hr.salaries', 'private-scope']),
  })
  .map(({ specs, links, stray, diagnostics, detectorText, findings, strayScopes }) => {
    const nodes = new Map<string, SeamlineNode>();
    for (const s of specs) {
      const n = makeNode({
        kind: s.kind,
        canonicalName: `hidden${s.idx}.${s.name}`,
        name: s.name,
        props: { pii: 'email' },
        ...(s.raised === undefined ? {} : { sensitivity: s.raised }),
      });
      nodes.set(n.id, n);
    }
    const hidden = [...nodes.values()];
    const edges: SeamlineEdge[] = [];
    if (hidden.length > 0) {
      for (const l of links) {
        const h = hidden[l.hidden % hidden.length] as SeamlineNode;
        const b = BASE_NODES[l.base % BASE_NODES.length] as SeamlineNode;
        edges.push(
          makeEdge({ kind: l.kind, src: l.outward ? b.id : h.id, dst: l.outward ? h.id : b.id }),
        );
      }
    }
    const strayFindings: DetectionReport['contradictions'] = findings.map((f) => {
      const b = BASE_NODES[f.base % BASE_NODES.length] as SeamlineNode;
      const h =
        hidden.length === 0 || f.crossesWithheldEdge ? undefined : hidden[f.hidden % hidden.length];
      return {
        code: 'X2_TYPE',
        severity: 'high',
        left: b.id,
        right: h === undefined ? property.id : h.id,
        claim: detectorText,
        leftFact: detectorText,
        rightFact: detectorText,
        viaPath: h === undefined ? ['FK_TO'] : ['EXPOSED_AS'],
        confidence: 0.5,
      };
    });
    return {
      nodes: hidden,
      edges,
      strayProps: stray,
      diagnostics,
      detectorText,
      strayFindings,
      strayScopes,
    };
  });

/** Every base node carries the hidden graph's stray props: values the profile never names. */
function withStray(
  nodes: readonly SeamlineNode[],
  stray: Readonly<Record<string, string>>,
): SeamlineNode[] {
  return nodes.map((n) => ({ ...n, props: { ...stray, ...n.props } }));
}

async function transcript(hidden: Hidden): Promise<string> {
  const s = createServer({
    graph: memorySource({
      nodes: [...withStray(BASE_NODES, hidden.strayProps), ...hidden.nodes],
      edges: [...BASE_EDGES, ...hidden.edges],
      scopeStatus: { data: 'FAIL' },
      run: makeRun('run-1', [
        makeResult('extract-code-ts', 'PASS', ['code.ts']),
        makeResult('extract-data', 'FAIL', ['data'], hidden.diagnostics),
      ]),
      detection: {
        contradictions: [
          {
            code: 'X1_NULLABILITY',
            severity: 'high',
            left: orderEmailField.id,
            right: property.id,
            claim: hidden.detectorText,
            leftFact: hidden.detectorText,
            rightFact: hidden.detectorText,
            viaPath: ['EXPOSED_AS'],
            confidence: 0.8,
          },
          ...hidden.strayFindings,
        ],
        unknown: [
          {
            code: 'X6_PII_UNAUTHENTICATED',
            severity: 'critical',
            reason: hidden.detectorText,
            scopes: ['data', ...hidden.strayScopes],
            scopeStatus: { data: 'FAIL' },
          },
        ],
      },
    }),
    profile: CODE_ONLY,
    nonce: fixedNonce(),
  });
  const calls: Array<[string, unknown]> = [];
  for (const name of CANDIDATE_NAMES) {
    calls.push(['context', { symbol: name, depth: 3 }]);
    calls.push(['lineage', { field: name, depth: 4 }]);
  }
  for (const n of BASE_NODES) {
    calls.push(['explain', { id: n.id }]);
    calls.push(['impact', { ids: [n.id], depth: 4 }]);
  }
  calls.push(['contradictions', {}]);
  const out: string[] = [];
  for (const [tool, args] of calls) out.push(JSON.stringify(await s.callTool(tool, args)));
  return out.join('\n');
}

describe('mcp / differential: what a profile withholds cannot change any answer', () => {
  test('two stores identical within the profile give byte-identical responses from every tool, whatever their run diagnostics and detector prose', async () => {
    const reference = await transcript(EMPTY_HIDDEN);
    await fc.assert(
      fc.asyncProperty(hiddenArb, async (hidden) => {
        assert.equal(await transcript(hidden), reference);
      }),
      { numRuns: 60 },
    );
  });
});

describe('mcp / lifecycle fields are printed only when the profile names them', () => {
  const live = makeNode({ kind: 'Symbol', canonicalName: 'src/a#f', path: 'src/a.ts' });
  const gone = makeNode({
    kind: 'Symbol',
    canonicalName: 'src/a#g',
    path: 'src/a.ts',
    deletedAt: '2026-01-01T00:00:00.000Z',
  });
  const naming = {
    ...CODE_ONLY,
    allowFields: ['path', 'props', 'untrusted', 'firstSeenRun', 'lastSeenRun', 'deletedAt'],
  } as ExportProfile;

  async function explained(profile: ExportProfile, id: string) {
    const env = okEnvelope(await serve(profile, [live, gone]).callTool('explain', { id }));
    return { env, lifecycle: (env.result as { lifecycle: Record<string, unknown> }).lifecycle };
  }

  test('a profile that names none of them gets no run id and no deletion time from explain', async () => {
    const { env, lifecycle } = await explained(CODE_ONLY, live.id);
    assert.deepEqual(lifecycle, { tombstoned: false });
    assert.doesNotMatch(JSON.stringify(env), /run-1/);
  });

  test('a profile that names them gets them', async () => {
    const { lifecycle } = await explained(naming, live.id);
    assert.deepEqual(lifecycle, {
      firstSeenRun: 'run-1',
      lastSeenRun: 'run-1',
      deletedAt: null,
      tombstoned: false,
    });
  });

  test('a tombstone is still reported as one, but its time only when deletedAt is named', async () => {
    const quiet = await explained(CODE_ONLY, gone.id);
    assert.deepEqual(quiet.lifecycle, { tombstoned: true });
    assert.match(quiet.env.notices.join('\n'), /This node is tombstoned; it no longer exists/);
    assert.doesNotMatch(JSON.stringify(quiet.env), /2026-01-01/);
    const loud = await explained(naming, gone.id);
    assert.equal(loud.lifecycle['deletedAt'], '2026-01-01T00:00:00.000Z');
    assert.match(loud.env.notices.join('\n'), /tombstoned \(deletedAt=2026-01-01/);
  });
});
