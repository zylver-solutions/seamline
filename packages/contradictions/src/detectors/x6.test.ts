/**
 * X6 is the only critical detector, so the difference between "this endpoint
 * declares it needs no auth" and "nobody extracted an auth mode" is the
 * difference between a page and a false alarm. These tests pin it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { graph } from '../graph-memory.ts';
import { runDetectors } from '../runner.ts';

function api(operationProps: Readonly<Record<string, string | boolean | number>>, piiValue?: string) {
  return graph({
    nodes: [
      { kind: 'Contract', name: 'api', canonical: 'openapi.api' },
      {
        kind: 'Operation',
        name: 'GET /profile',
        canonical: 'openapi.api#get:/profile',
        sourceRef: 'openapi.yaml:10',
        props: operationProps,
      },
      { kind: 'RouteHandler', name: 'GET /profile', canonical: 'route:GET:/profile' },
      { kind: 'Symbol', name: 'getProfile', canonical: 'src/profile.ts#getProfile' },
      { kind: 'Symbol', name: 'loadPerson', canonical: 'src/people.ts#loadPerson' },
      { kind: 'Table', name: 'people', canonical: 'db.public.people' },
      {
        kind: 'Column',
        name: 'ssn',
        canonical: 'db.public.people.ssn',
        sourceRef: 'db/schema.sql:60',
        props: piiValue === undefined ? { type: 'text' } : { type: 'text', pii: piiValue },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'openapi.api', dst: 'openapi.api#get:/profile' },
      { kind: 'CONTAINS', src: 'db.public.people', dst: 'db.public.people.ssn' },
      { kind: 'IMPLEMENTED_BY', src: 'openapi.api#get:/profile', dst: 'route:GET:/profile' },
      { kind: 'HANDLES_ROUTE', src: 'src/profile.ts#getProfile', dst: 'route:GET:/profile' },
      { kind: 'CALLS', src: 'src/profile.ts#getProfile', dst: 'src/people.ts#loadPerson' },
      { kind: 'QUERIES', src: 'src/people.ts#loadPerson', dst: 'db.public.people', props: { writes: false } },
    ],
  });
}

const report = (g: ReturnType<typeof graph>) => {
  const r = runDetectors(g);
  const d = r.detectors.find((x) => x.code === 'X6_PII_UNAUTHENTICATED');
  assert.ok(d !== undefined);
  return d;
};

describe('X6 distinguishes declared-no-auth from unknown-auth', () => {
  for (const value of ['none', 'public', 'anonymous']) {
    it(`fires when the operation declares auth="${value}"`, () => {
      const d = report(api({ auth: value }, 'high'));
      assert.equal(d.outcome, 'fired');
      assert.equal(d.findings.length, 1);
      assert.match(d.findings[0]!.leftFact, new RegExp(`auth="${value}"`));
      assert.equal(d.notes.length, 0);
    });
  }

  it('does not fire when an auth mode is declared', () => {
    const d = report(api({ auth: 'bearer' }, 'high'));
    assert.equal(d.outcome, 'clean');
  });

  it('does not fire when no auth mode was extracted, and says so', () => {
    const d = report(api({ method: 'GET' }, 'high'));
    assert.equal(d.outcome, 'clean');
    assert.equal(d.findings.length, 0);
    assert.equal(d.notes.length, 1);
    assert.match(d.notes[0]!, /declare no auth mode/);
    assert.match(d.notes[0]!, /unknown, not "no auth"/);
  });

  it('does not fire when the column is classified pii=none', () => {
    assert.equal(report(api({ auth: 'none' }, 'none')).outcome, 'clean');
  });

  it('does not fire when the column has no pii classification at all', () => {
    assert.equal(report(api({ auth: 'none' })).outcome, 'clean');
  });

  it('follows CALLS out of the handler, and names the whole path', () => {
    const d = report(api({ auth: 'none' }, 'high'));
    assert.deepEqual(d.findings[0]!.viaPath, [
      'IMPLEMENTED_BY',
      'HANDLES_ROUTE',
      'CALLS',
      'QUERIES',
      'CONTAINS',
    ]);
  });
});

/**
 * An interpolated statement names a table, not the columns it reads. With no `columns` list X6 would
 * read it as reaching every PII column of the table, so it does not evaluate an edge made only of such
 * statements, and counts what it skipped.
 */
describe('X6 does not evaluate an edge made only of interpolated templates', () => {
  const PUBLIC = { auth: 'none' } as const;

  function reaching(queries: ReadonlyArray<Readonly<Record<string, string | boolean>>>, pii = 'high') {
    return graph({
      nodes: [
        { kind: 'Contract', name: 'api', canonical: 'openapi.api' },
        { kind: 'Operation', name: 'GET /profile', canonical: 'openapi.api#get:/profile', props: PUBLIC },
        { kind: 'Operation', name: 'GET /me', canonical: 'openapi.api#get:/me', props: PUBLIC },
        { kind: 'RouteHandler', name: 'GET /profile', canonical: 'route:GET:/profile' },
        { kind: 'RouteHandler', name: 'GET /me', canonical: 'route:GET:/me' },
        { kind: 'Symbol', name: 'getProfile', canonical: 'src/profile.ts#getProfile' },
        { kind: 'Symbol', name: 'getMe', canonical: 'src/me.ts#getMe' },
        { kind: 'Table', name: 'people', canonical: 'db.public.people' },
        { kind: 'Column', name: 'ssn', canonical: 'db.public.people.ssn', props: { type: 'text', pii } },
        { kind: 'Column', name: 'nickname', canonical: 'db.public.people.nickname', props: { type: 'text', pii: 'none' } },
      ],
      edges: [
        { kind: 'CONTAINS', src: 'openapi.api', dst: 'openapi.api#get:/profile' },
        { kind: 'CONTAINS', src: 'openapi.api', dst: 'openapi.api#get:/me' },
        { kind: 'CONTAINS', src: 'db.public.people', dst: 'db.public.people.ssn' },
        { kind: 'CONTAINS', src: 'db.public.people', dst: 'db.public.people.nickname' },
        { kind: 'IMPLEMENTED_BY', src: 'openapi.api#get:/profile', dst: 'route:GET:/profile' },
        { kind: 'IMPLEMENTED_BY', src: 'openapi.api#get:/me', dst: 'route:GET:/me' },
        { kind: 'HANDLES_ROUTE', src: 'src/profile.ts#getProfile', dst: 'route:GET:/profile' },
        { kind: 'HANDLES_ROUTE', src: 'src/me.ts#getMe', dst: 'route:GET:/me' },
        ...queries.map((props, i) => ({
          kind: 'QUERIES' as const,
          src: i === 0 ? 'src/profile.ts#getProfile' : 'src/me.ts#getMe',
          dst: 'db.public.people',
          props,
        })),
      ],
    });
  }

  it('gives no finding for a symbol whose only statement on a PII table is an interpolated template, and says so', () => {
    const d = report(reaching([{ operation: 'select', interpolated: true }]));
    assert.equal(d.outcome, 'clean');
    assert.equal(d.findings.length, 0);
    assert.equal(d.notes.length, 1);
    assert.match(d.notes[0]!, /1 query edge\(s\) were not evaluated; interpolated: 1/);
  });

  it('gives the finding as today for the same statement without a substitution', () => {
    const d = report(reaching([{ operation: 'select' }]));
    assert.equal(d.outcome, 'fired');
    assert.equal(d.findings.length, 1);
    assert.equal(d.notes.length, 0);
  });

  it('gives the finding as today for a symbol with a plain SELECT and an interpolated UPDATE on the table', () => {
    // One edge: `interpolated` is the AND over its statements, so a plain one leaves it absent.
    const d = report(reaching([{ operations: 'select,update', writes: true }]));
    assert.equal(d.outcome, 'fired');
    assert.equal(d.findings.length, 1);
    assert.equal(d.notes.length, 0);
  });

  it('skips only the interpolated edge: another symbol on the same table is still read', () => {
    const d = report(
      reaching([
        { operation: 'select', interpolated: true },
        { operation: 'select' },
      ]),
    );
    assert.equal(d.findings.length, 1, 'getMe runs a plain statement');
    assert.match(d.findings[0]!.leftFact, /GET \/me/);
    assert.equal(d.notes.length, 1);
    assert.match(d.notes[0]!, /1 query edge\(s\) were not evaluated; interpolated: 1/);
  });

  it('counts each skipped edge once, however many operations reach it', () => {
    const g = graph({
      nodes: [
        { kind: 'Contract', name: 'api', canonical: 'openapi.api' },
        { kind: 'Operation', name: 'GET /a', canonical: 'openapi.api#get:/a', props: PUBLIC },
        { kind: 'Operation', name: 'GET /b', canonical: 'openapi.api#get:/b', props: PUBLIC },
        { kind: 'RouteHandler', name: 'GET /a', canonical: 'route:GET:/a' },
        { kind: 'RouteHandler', name: 'GET /b', canonical: 'route:GET:/b' },
        { kind: 'Symbol', name: 'shared', canonical: 'src/shared.ts#shared' },
        { kind: 'Table', name: 'people', canonical: 'db.public.people' },
        { kind: 'Column', name: 'ssn', canonical: 'db.public.people.ssn', props: { type: 'text', pii: 'high' } },
      ],
      edges: [
        { kind: 'CONTAINS', src: 'openapi.api', dst: 'openapi.api#get:/a' },
        { kind: 'CONTAINS', src: 'openapi.api', dst: 'openapi.api#get:/b' },
        { kind: 'CONTAINS', src: 'db.public.people', dst: 'db.public.people.ssn' },
        { kind: 'IMPLEMENTED_BY', src: 'openapi.api#get:/a', dst: 'route:GET:/a' },
        { kind: 'IMPLEMENTED_BY', src: 'openapi.api#get:/b', dst: 'route:GET:/b' },
        { kind: 'HANDLES_ROUTE', src: 'src/shared.ts#shared', dst: 'route:GET:/a' },
        { kind: 'HANDLES_ROUTE', src: 'src/shared.ts#shared', dst: 'route:GET:/b' },
        {
          kind: 'QUERIES', src: 'src/shared.ts#shared', dst: 'db.public.people',
          props: { operation: 'select', interpolated: true },
        },
      ],
    });
    const d = report(g);
    assert.equal(d.findings.length, 0);
    assert.match(d.notes[0]!, /1 query edge\(s\) were not evaluated; interpolated: 1/);
  });

  it('says nothing when the skipped edge reaches no PII column', () => {
    const d = report(reaching([{ operation: 'select', interpolated: true }], 'none'));
    assert.equal(d.findings.length, 0);
    assert.deepEqual(d.notes, []);
  });
});
