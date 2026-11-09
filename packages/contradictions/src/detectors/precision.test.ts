import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { graph, type GraphSpec } from '../graph-memory.ts';
import { runDetectors } from '../runner.ts';

type Props = Readonly<Record<string, string | number | boolean>>;

function pair(column: Props, property: Props = {}, field: Props = {}): GraphSpec {
  return {
    nodes: [
      { kind: 'Table', name: 'users', canonical: 'db.users' },
      { kind: 'Column', name: 'email', canonical: 'db.users.email', props: column },
      { kind: 'Contract', name: 'api', canonical: 'api' },
      { kind: 'SchemaProperty', name: 'email', canonical: 'api#/properties/email', props: property },
      { kind: 'Symbol', name: 'UserRow', canonical: 'UserRow' },
      { kind: 'CodeField', name: 'email', canonical: 'UserRow.email', props: field },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.users', dst: 'db.users.email' },
      { kind: 'CONTAINS', src: 'api', dst: 'api#/properties/email' },
      { kind: 'CONTAINS', src: 'UserRow', dst: 'UserRow.email' },
      { kind: 'EXPOSED_AS', src: 'db.users.email', dst: 'api#/properties/email' },
      { kind: 'MAPS_TO_FIELD', src: 'db.users.email', dst: 'UserRow.email' },
      { kind: 'EXPOSED_AS', src: 'UserRow.email', dst: 'api#/properties/email' },
    ],
  };
}

const result = (spec: GraphSpec, code: 'X1_NULLABILITY' | 'X2_TYPE') => {
  const r = runDetectors(graph(spec)).detectors.find((d) => d.code === code);
  assert.ok(r);
  return r;
};

describe('X1 precision on present facts', () => {
  it('keeps a genuine response contradiction alongside unsupported field shapes', () => {
    const r = result(pair({ nullable: true }, { nullable: false, direction: 'response' }, { nullable: true, optional: false }), 'X1_NULLABILITY');
    assert.equal(r.outcome, 'fired');
    assert.equal(r.findings.length, 1);
    assert.match(r.findings[0]!.right, /SchemaProperty/);
    assert.match(r.notes.join('\n'), /stored-row or insert role/);
  });

  it('keeps the response finding without also reporting a stricter request in the same graph', () => {
    const spec = pair({ nullable: true }, { nullable: false, direction: 'response' });
    const mixed: GraphSpec = {
      ...spec,
      nodes: [...spec.nodes, { kind: 'SchemaProperty', name: 'email', canonical: 'request.email', props: { nullable: false, direction: 'request' } }],
      edges: [...spec.edges!, { kind: 'EXPOSED_AS', src: 'db.users.email', dst: 'request.email' }],
    };
    const r = result(mixed, 'X1_NULLABILITY');
    assert.equal(r.outcome, 'fired');
    assert.equal(r.findings.length, 1);
    assert.match(r.findings[0]!.right, /api#/);
    assert.match(r.notes.join('\n'), /stricter input contract/);
  });

  for (const direction of ['request', 'unspecified']) {
    it(`withholds stricter ${direction} validation`, () => {
      const property = direction === 'request' ? { nullable: false, direction } : { nullable: false };
      const r = result(pair({ nullable: true }, property), 'X1_NULLABILITY');
      assert.equal(r.findings.length, 0);
      assert.equal(r.outcome, 'unknown');
      assert.equal(r.result.known, false);
      if (!r.result.known) assert.match(r.result.reason, /request properties/);
    });
  }

  for (const nullable of [true, false]) {
    for (const optional of [true, false]) {
      it(`does not infer a row or insert role from a field (nullable=${nullable}, optional=${optional})`, () => {
        const r = result(pair(
          { nullable: !nullable, hasDefault: false, defaultSite: 'none' },
          { nullable: !nullable, direction: 'response' },
          { nullable, optional },
        ), 'X1_NULLABILITY');
        assert.equal(r.outcome, 'clean');
        assert.equal(r.result.known, true);
        assert.equal(r.findings.length, 0);
      });
    }
  }

  for (const column of [{ hasDefault: true, defaultSite: 'db' }, { hasDefault: false, defaultSite: 'none' }, { hasDefault: false }]) {
    it(`does not equate an optional request with an insert obligation (${JSON.stringify(column)})`, () => {
      const spec = pair({ nullable: false, ...column }, { required: false, direction: 'request' });
      const mixed: GraphSpec = {
        ...spec,
        nodes: [...spec.nodes, { kind: 'SchemaProperty', name: 'email', canonical: 'response.email', props: { nullable: false, direction: 'response' } }],
        edges: [...spec.edges!, { kind: 'EXPOSED_AS', src: 'db.users.email', dst: 'response.email' }],
      };
      const r = result(mixed, 'X1_NULLABILITY');
      assert.equal(r.outcome, 'clean');
      assert.equal(r.result.known, true);
      assert.equal(r.findings.length, 0);
    });
  }
});

describe('X2 requires comparable value roles', () => {
  it('retains a column-to-contract type contradiction and notes withheld fields', () => {
    const r = result(pair({ type: 'integer' }, { type: 'boolean', direction: 'response' }, { type: 'string' }), 'X2_TYPE');
    assert.equal(r.findings.length, 1);
    assert.match(r.findings[0]!.left, /Column/);
    assert.match(r.findings[0]!.right, /SchemaProperty/);
    assert.match(r.notes.join('\n'), /generic code shape/);
  });

  it('does not compare UI and write shapes with columns or contracts on name-based joins', () => {
    const r = result(pair({ type: 'integer' }, { type: 'number' }, { type: 'boolean' }), 'X2_TYPE');
    assert.equal(r.findings.length, 0);
    assert.match(r.notes.join('\n'), /stored row or insert value/);
  });
});
