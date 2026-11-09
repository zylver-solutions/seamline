import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTRADICTION_CODES, type ExtractorStatus } from '@seamline/ontology';

import { ALL_DETECTORS } from './detectors/index.ts';
import { FIXTURES, SQL_SLICE_FACTS } from './fixtures.ts';
import { emptyReplayFixtureNodes, replayFixtureNodes } from './__fixtures__/replay.ts';
import { graph } from './graph-memory.ts';
import { runDetectors, summarize } from './runner.ts';
import { SCOPE_CONTRACTS, SCOPE_DATA, SCOPES } from './scopes.ts';

function firingX1(scopes: Readonly<Record<string, ExtractorStatus>>) {
  return graph({
    scopes,
    nodes: [
      ...SQL_SLICE_FACTS.filter((node) => node.kind !== 'DataSource'),
      ...emptyReplayFixtureNodes('db'),
      { kind: 'Table', name: 'users', canonical: 'db.public.users' },
      {
        kind: 'Column',
        name: 'email',
        canonical: 'db.public.users.email',
        props: { type: 'text', nullable: true },
      },
      { kind: 'Contract', name: 'usersApi', canonical: 'openapi.usersApi' },
      {
        kind: 'SchemaProperty',
        name: 'email',
        canonical: 'openapi.usersApi#/User/email',
        props: { type: 'string', required: true, nullable: false, direction: 'response' },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.users', dst: 'db.public.users.email' },
      { kind: 'CONTAINS', src: 'openapi.usersApi', dst: 'openapi.usersApi#/User/email' },
      {
        kind: 'BACKED_BY',
        src: 'openapi.usersApi#/User/email',
        dst: 'db.public.users.email',
        provenance: 'INFERRED',
        confidence: 0.95,
      },
    ],
  });
}

describe('the UNKNOWN rule', () => {
  for (const status of ['FAIL', 'UNAVAILABLE'] as const) {
    it(`a ${status} scope yields UNKNOWN, not a finding, on a graph that would otherwise fire`, () => {
      const control = runDetectors(firingX1({}));
      assert.ok(
        control.findings.some((f) => f.code === 'X1_NULLABILITY'),
        'the control graph must actually fire, or this test proves nothing',
      );

      const report = runDetectors(firingX1({ [SCOPE_DATA]: status }));
      const x1 = report.detectors.find((d) => d.code === 'X1_NULLABILITY');
      assert.ok(x1 !== undefined);
      assert.equal(x1.outcome, 'unknown');
      assert.equal(x1.findings.length, 0);
      assert.equal(x1.result.known, false);
      if (!x1.result.known) {
        assert.match(x1.result.reason, new RegExp(`${SCOPE_DATA}=${status}`));
        // A stable code leads the reason, so a consumer that must withhold the rest (it names
        // scopes) can still say why. The head is an upper-case identifier before the first colon.
        assert.equal(x1.result.reason.split(':')[0], 'SCOPE_NOT_PASS');
        assert.match(x1.result.reason, /^[A-Z][A-Z0-9_]+: /);
        assert.deepEqual(x1.result.scopes, [SCOPE_DATA]);
      }
      assert.equal(
        report.findings.filter((f) => f.code === 'X1_NULLABILITY').length,
        0,
        'a failed scope must never contribute a finding to the run',
      );
      assert.deepEqual(report.blockedScopes.map((b) => b.scope).includes(SCOPE_DATA), true);
    });
  }

  it('a detector cannot bypass the gate by being called directly', () => {
    const g = firingX1({ [SCOPE_DATA]: 'FAIL' });
    for (const d of ALL_DETECTORS) {
      if (!d.requiredScopes.includes(SCOPE_DATA)) continue;
      assert.deepEqual(
        d.detect(g),
        [],
        `${d.code}.detect returned findings while ${SCOPE_DATA} was FAIL`,
      );
    }
  });

  it('only detectors that read the failed scope go UNKNOWN', () => {
    const report = runDetectors(firingX1({ [SCOPE_CONTRACTS]: 'UNAVAILABLE' }));
    const unknownCodes = report.detectors.filter((d) => d.outcome === 'unknown').map((d) => d.code);
    const expected = ALL_DETECTORS.filter((d) => d.requiredScopes.includes(SCOPE_CONTRACTS)).map(
      (d) => d.code,
    );
    assert.deepEqual([...unknownCodes].sort(), [...expected].sort());
    assert.ok(unknownCodes.length > 0 && unknownCodes.length < ALL_DETECTORS.length);
  });

  it('an unrecognized scope name is UNAVAILABLE, so a typo fails safe', () => {
    const g = graph({ nodes: [] });
    assert.equal(g.scopeStatus('extract-nonexistent'), 'UNAVAILABLE');
  });

  it('every scope a detector requires is a known extractor scope', () => {
    const known = new Set<string>(SCOPES);
    for (const d of ALL_DETECTORS) {
      for (const s of d.requiredScopes) {
        assert.ok(known.has(s), `${d.code} requires unknown scope ${s}`);
      }
      assert.ok(d.requiredScopes.length > 0, `${d.code} declares no required scopes`);
    }
  });
});

describe('the run report', () => {
  it('reports one entry per detector, in catalog order', () => {
    const report = runDetectors(graph({ nodes: [] }));
    assert.deepEqual(
      report.detectors.map((d) => d.code),
      ALL_DETECTORS.map((d) => d.code),
    );
    assert.deepEqual([...CONTRADICTION_CODES].sort(), report.detectors.map((d) => d.code).sort());
  });

  it('counts fired, clean and unknown detectors', () => {
    const report = runDetectors(firingX1({ [SCOPE_DATA]: 'FAIL' }));
    const total = report.counts.fired + report.counts.clean + report.counts.unknown;
    assert.equal(total, ALL_DETECTORS.length);
    assert.ok(report.counts.unknown > 0);
  });

  it('distinguishes clean from unknown in the summary text', () => {
    const clean = summarize(runDetectors(FIXTURES.X1_NULLABILITY.clean()));
    assert.ok(clean.some((l) => l.startsWith('X1_NULLABILITY') && l.includes('CLEAN')));
    const empty = runDetectors(graph({ nodes: [] }));
    assert.equal(empty.detectors.find((d) => d.code === 'X1_NULLABILITY')?.outcome, 'unknown');
    assert.equal(empty.detectors.find((d) => d.code === 'X2_TYPE')?.outcome, 'unknown');
    const blocked = summarize(runDetectors(firingX1({ [SCOPE_DATA]: 'UNAVAILABLE' })));
    assert.ok(blocked.some((l) => l.includes('UNKNOWN')));
  });
});

describe('deterministic output', () => {
  it('two runs over the same graph produce byte-identical findings', () => {
    const once = JSON.stringify(runDetectors(FIXTURES.X4_UNBACKED_PROPERTY.firing()).findings);
    const twice = JSON.stringify(runDetectors(FIXTURES.X4_UNBACKED_PROPERTY.firing()).findings);
    assert.equal(once, twice);
  });

  it('findings are ordered by severity, then code, then left id', () => {
    const g = graph({
      nodes: [
        // X6, critical: a public operation reaching PII.
        { kind: 'Contract', name: 'api', canonical: 'openapi.api' },
        {
          kind: 'Operation',
          name: 'GET /p',
          canonical: 'openapi.api#get:/p',
          props: { auth: 'none' },
        },
        { kind: 'RouteHandler', name: 'GET /p', canonical: 'route:GET:/p' },
        { kind: 'Symbol', name: 'getP', canonical: 'src/p.ts#getP' },
        { kind: 'Table', name: 'people', canonical: 'db.public.people' },
        {
          kind: 'Column',
          name: 'ssn',
          canonical: 'db.public.people.ssn',
          props: { type: 'text', pii: 'high', nullable: true },
        },
        // X8, low: a checked reference precedes its local creation.
        ...replayFixtureNodes(),
        // X1, high: a NULL-able column behind a required property.
        { kind: 'SchemaProperty', name: 'ssn', canonical: 'openapi.api#/P/ssn', props: { type: 'string', required: true, nullable: false, direction: 'response' } },
      ],
      edges: [
        { kind: 'CONTAINS', src: 'openapi.api', dst: 'openapi.api#get:/p' },
        { kind: 'CONTAINS', src: 'openapi.api', dst: 'openapi.api#/P/ssn' },
        { kind: 'CONTAINS', src: 'db.public.people', dst: 'db.public.people.ssn' },
        { kind: 'IMPLEMENTED_BY', src: 'openapi.api#get:/p', dst: 'route:GET:/p' },
        { kind: 'HANDLES_ROUTE', src: 'src/p.ts#getP', dst: 'route:GET:/p' },
        {
          kind: 'QUERIES',
          src: 'src/p.ts#getP',
          dst: 'db.public.people',
          props: { writes: false },
        },
        {
          kind: 'BACKED_BY',
          src: 'openapi.api#/P/ssn',
          dst: 'db.public.people.ssn',
          provenance: 'INFERRED',
          confidence: 0.95,
        },
      ],
    });

    const codes = runDetectors(g).findings.map((f) => `${f.severity}:${f.code}`);
    assert.deepEqual(codes, [
      'critical:X6_PII_UNAUTHENTICATED',
      'high:X1_NULLABILITY',
      'low:X8_ORPHANED_MIGRATION',
    ]);
  });
});
