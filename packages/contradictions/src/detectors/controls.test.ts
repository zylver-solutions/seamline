/**
 * The false-positive controls, tested as behaviour.
 *
 * v3 section 5: "false-positive controls are part of each detector, not an
 * afterthought". Four of the ten detectors reason about something not being
 * present, which is only sound because a PASSing extractor is authoritative for
 * its scope (section 2.2) and because each of them requires positive evidence
 * that the join works before it speaks. These tests pin that evidence
 * requirement: remove it and the detector must fall silent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContradictionCode } from '@seamline/ontology';

import { x5Spec, type X5Options } from '../fixtures.ts';
import { graph, type GraphSpec } from '../graph-memory.ts';
import { runDetectors } from '../runner.ts';

function codes(spec: GraphSpec): ReadonlyArray<ContradictionCode> {
  return runDetectors(graph(spec)).findings.map((f) => f.code);
}

describe('X4 speaks only where the join is demonstrably working', () => {
  const contract = (backedSiblings: number): GraphSpec => ({
    nodes: [
      { kind: 'Table', name: 'orders', canonical: 'db.public.orders' },
      { kind: 'Column', name: 'a', canonical: 'db.public.orders.a', props: { type: 'text' } },
      { kind: 'Column', name: 'b', canonical: 'db.public.orders.b', props: { type: 'text' } },
      { kind: 'Contract', name: 'orderApi', canonical: 'openapi.orderApi' },
      {
        kind: 'SchemaProperty',
        name: 'a',
        canonical: 'p.a',
        props: { type: 'string', direction: 'response' },
      },
      {
        kind: 'SchemaProperty',
        name: 'b',
        canonical: 'p.b',
        props: { type: 'string', direction: 'response' },
      },
      {
        kind: 'SchemaProperty',
        name: 'c',
        canonical: 'p.c',
        props: { type: 'string', direction: 'response' },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.orders', dst: 'db.public.orders.a' },
      { kind: 'CONTAINS', src: 'db.public.orders', dst: 'db.public.orders.b' },
      { kind: 'CONTAINS', src: 'openapi.orderApi', dst: 'p.a' },
      { kind: 'CONTAINS', src: 'openapi.orderApi', dst: 'p.b' },
      { kind: 'CONTAINS', src: 'openapi.orderApi', dst: 'p.c' },
      ...(backedSiblings > 0
        ? [
            {
              kind: 'BACKED_BY' as const,
              src: 'p.a',
              dst: 'db.public.orders.a',
              provenance: 'INFERRED' as const,
              confidence: 0.95,
            },
          ]
        : []),
      ...(backedSiblings > 1
        ? [
            {
              kind: 'BACKED_BY' as const,
              src: 'p.b',
              dst: 'db.public.orders.b',
              provenance: 'INFERRED' as const,
              confidence: 0.95,
            },
          ]
        : []),
    ],
  });

  it('says nothing when no sibling resolves, because that is the inference failing', () => {
    assert.ok(!codes(contract(0)).includes('X4_UNBACKED_PROPERTY'));
  });

  it('says nothing when only one of three resolves: 0.33 falls under the confidence floor', () => {
    assert.ok(!codes(contract(1)).includes('X4_UNBACKED_PROPERTY'));
  });

  it('fires when two of three resolve', () => {
    assert.ok(codes(contract(2)).includes('X4_UNBACKED_PROPERTY'));
  });
});

describe('X5 speaks only where column-level insert facts exist', () => {
  const insert = (o: X5Options): GraphSpec => x5Spec(o);

  it('says nothing when no write path is traced at all', () => {
    const spec = x5Spec();
    assert.ok(
      !codes({ ...spec, edges: (spec.edges ?? []).filter((e) => e.kind !== 'QUERIES') }).includes(
        'X5_UNWRITTEN_COLUMN',
      ),
    );
  });

  it('says nothing when the insert is traced but its columns were not', () => {
    assert.ok(
      !codes(insert({ insertColumns: undefined, insertComplete: undefined })).includes(
        'X5_UNWRITTEN_COLUMN',
      ),
    );
  });

  it('says nothing when the statement is a read', () => {
    assert.ok(
      !codes(
        insert({ operation: 'select', insertColumns: undefined, insertComplete: undefined }),
      ).includes('X5_UNWRITTEN_COLUMN'),
    );
  });

  it('fires when a column-level insert exists and omits the required column', () => {
    assert.ok(codes(insert({ insertColumns: 'id' })).includes('X5_UNWRITTEN_COLUMN'));
  });
});

describe('legacy Symbol constraints do not establish a validated write', () => {
  const pair = (
    validatorProps: Readonly<Record<string, string | number | boolean>>,
  ): GraphSpec => ({
    nodes: [
      { kind: 'Table', name: 'profiles', canonical: 'db.public.profiles' },
      {
        kind: 'Column',
        name: 'bio',
        canonical: 'db.public.profiles.bio',
        props: { type: 'text', nullable: false, maxLength: 500 },
      },
      { kind: 'Symbol', name: 'bioSchema', canonical: 'src/v.ts#bioSchema', props: validatorProps },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.profiles', dst: 'db.public.profiles.bio' },
      {
        kind: 'VALIDATED_BY',
        src: 'db.public.profiles.bio',
        dst: 'src/v.ts#bioSchema',
        provenance: 'INFERRED',
        confidence: 0.9,
      },
    ],
  });

  it('says nothing about a validator node carrying no constraint facts', () => {
    assert.ok(!codes(pair({})).includes('X7_VALIDATOR_DIVERGENCE'));
  });

  it('withholds X7 even with current authority when a Symbol lacks a dimension', () => {
    const report = runDetectors(graph(pair({ required: true })), undefined, () => true);
    assert.ok(!report.findings.some(finding => finding.code === 'X7_VALIDATOR_DIVERGENCE'));
    assert.equal(report.detectors.find(detector => detector.code === 'X7_VALIDATOR_DIVERGENCE')?.outcome, 'unknown');
  });

  it('X3 retains its comparison of two stated Symbol limits', () => {
    const both = codes(pair({ required: true, maxLength: 280 }));
    assert.ok(both.includes('X3_CONSTRAINT'), 'maxLength differs on both sides, so X3 owns it');
    assert.ok(
      !both.includes('X7_VALIDATOR_DIVERGENCE'),
      'a legacy Symbol does not prove a request-to-write binding',
    );
  });
});

describe('X9 speaks only where sibling routes resolve', () => {
  const contract = (implemented: number): GraphSpec => ({
    nodes: [
      {
        kind: 'Contract',
        name: 'api',
        canonical: 'openapi.api',
        props: { unreadStructuredDocuments: 0 },
      },
      {
        kind: 'Operation',
        name: 'GET /a',
        canonical: 'op.a',
        props: { unreadStructuredDocuments: 0 },
      },
      {
        kind: 'Operation',
        name: 'GET /b',
        canonical: 'op.b',
        props: { unreadStructuredDocuments: 0 },
      },
      { kind: 'RouteHandler', name: 'GET /a', canonical: 'route.a' },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'openapi.api', dst: 'op.a' },
      { kind: 'CONTAINS', src: 'openapi.api', dst: 'op.b' },
      ...(implemented > 0
        ? [{ kind: 'IMPLEMENTED_BY' as const, src: 'op.a', dst: 'route.a' }]
        : []),
    ],
  });

  it('says nothing when no operation on the contract resolves to a handler', () => {
    assert.ok(!codes(contract(0)).includes('X9_CONTRACT_DRIFT'));
  });

  it('fires when one of two resolves, and reports it at the reduced severity', () => {
    const report = runDetectors(graph(contract(1)));
    const finding = report.findings.find((f) => f.code === 'X9_CONTRACT_DRIFT');
    assert.ok(finding !== undefined);
    assert.equal(finding.confidence, 0.5);
    assert.equal(finding.severity, 'medium', 'declared high, capped by a half-resolved contract');
  });

  for (const [contractCount, operationCount, reason] of [
    [1, -1, 'CONTRACT_DOCUMENTS_UNREAD'],
    [-1, 1, 'CONTRACT_COVERAGE_UNAVAILABLE'],
  ] as const) {
    it(`preserves the first contract coverage reason before operation coverage: ${reason}`, () => {
      const base = contract(1);
      const g = graph({
        ...base,
        nodes: base.nodes.map((n) => n.kind === 'Contract' || n.kind === 'Operation'
          ? { ...n, props: { unreadStructuredDocuments: n.kind === 'Contract' ? contractCount : operationCount } }
          : n),
      });
      const result = runDetectors(g).detectors.find((d) => d.code === 'X9_CONTRACT_DRIFT');
      assert.equal(result?.outcome, 'unknown');
      assert.deepEqual(result?.findings, []);
      assert.ok(result !== undefined && !result.result.known);
      assert.match(result.result.reason, new RegExp(`^${reason}:`));
    });
  }

  for (const kind of ['Contract', 'Operation'] as const) {
    for (const count of [undefined, -1, 0.5, '0', 1]) {
      it(`is UNKNOWN when ${kind} structured-document coverage is missing, invalid or incomplete: ${count}`, () => {
        const base = contract(1);
        const g = graph({
          ...base,
          nodes: base.nodes.map((n) =>
            n.kind === kind
              ? { ...n, props: count === undefined ? {} : { unreadStructuredDocuments: count } }
              : n,
          ),
        });
        const result = runDetectors(g).detectors.find((d) => d.code === 'X9_CONTRACT_DRIFT');
        assert.equal(result?.outcome, 'unknown');
        assert.deepEqual(result?.findings, []);
      });
    }
  }

});

describe('X10 speaks only where verification facts exist', () => {
  const spec: GraphSpec = {
    nodes: [
      { kind: 'Table', name: 'customers', canonical: 'db.public.customers' },
      {
        kind: 'Column',
        name: 'email',
        canonical: 'db.public.customers.email',
        props: { type: 'text', pii: 'high' },
      },
      { kind: 'Symbol', name: 'writeEmail', canonical: 'src/c.ts#writeEmail' },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.customers', dst: 'db.public.customers.email' },
      {
        kind: 'QUERIES',
        src: 'src/c.ts#writeEmail',
        dst: 'db.public.customers',
        props: { writes: true, columns: 'email' },
      },
    ],
  };

  it('reports a note, not findings, when the repository has no tests at all', () => {
    const report = runDetectors(graph(spec));
    const d = report.detectors.find((x) => x.code === 'X10_UNTESTED_PII_WRITE');
    assert.ok(d !== undefined);
    assert.equal(d.outcome, 'clean');
    assert.equal(d.notes.length, 1);
    assert.match(d.notes[0]!, /1 PII write path/);
  });
});

describe('X2 stays silent on types it does not understand', () => {
  const pair = (fieldType: string): GraphSpec => ({
    nodes: [
      { kind: 'Table', name: 't', canonical: 'db.t' },
      { kind: 'Column', name: 'c', canonical: 'db.t.c', props: { type: 'integer' } },
      { kind: 'Contract', name: 'M', canonical: 'api.M' },
      { kind: 'SchemaProperty', name: 'c', canonical: 'api.M#/properties/c', props: { type: fieldType } },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.t', dst: 'db.t.c' },
      { kind: 'CONTAINS', src: 'api.M', dst: 'api.M#/properties/c' },
      { kind: 'EXPOSED_AS', src: 'db.t.c', dst: 'api.M#/properties/c', provenance: 'INFERRED', confidence: 0.9 },
    ],
  });

  for (const unknownType of [
    'MyBrandedId',
    'string[]',
    'string | null',
    'unknown',
    'Record<string, number>',
  ]) {
    it(`says nothing about ${unknownType}`, () => {
      assert.ok(!codes(pair(unknownType)).includes('X2_TYPE'));
    });
  }

  it('does not treat integer against number as a disagreement', () => {
    assert.ok(!codes(pair('number')).includes('X2_TYPE'));
  });

  it('does fire on integer against boolean', () => {
    assert.ok(codes(pair('boolean')).includes('X2_TYPE'));
  });
});
