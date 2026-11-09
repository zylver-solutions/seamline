/**
 * X1 reads a contract property's null-ness only when the contract STATES it.
 *
 * `extract-contracts` leaves `nullable` (and `required`) off a Zod property
 * whose modifier chain it could not read, because an unrecognised modifier may
 * be hiding a `.nullable()`. A detector that read the missing prop as `false`
 * would report a database column against a contract that never said what the
 * property's null-ness is. The pair below differs in that one fact.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { graph, type GraphSpec } from '../graph-memory.ts';
import { runDetectors } from '../runner.ts';

function x1Graph(propertyProps: Record<string, string | number | boolean>): GraphSpec {
  return {
    nodes: [
      { kind: 'Table', name: 'users', canonical: 'db.public.users' },
      {
        kind: 'Column',
        name: 'email',
        canonical: 'db.public.users.email',
        props: { type: 'text', nullable: true, hasDefault: false },
      },
      { kind: 'Contract', name: 'userInput', canonical: 'zod.userInput' },
      {
        kind: 'SchemaProperty',
        name: 'email',
        canonical: 'zod.userInput#/properties/email',
        props: { direction: 'response', ...propertyProps },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.users', dst: 'db.public.users.email' },
      { kind: 'CONTAINS', src: 'zod.userInput', dst: 'zod.userInput#/properties/email' },
      {
        kind: 'BACKED_BY',
        src: 'zod.userInput#/properties/email',
        dst: 'db.public.users.email',
        provenance: 'INFERRED',
        confidence: 0.9,
      },
    ],
  };
}

const x1Findings = (spec: GraphSpec) =>
  runDetectors(graph(spec)).findings.filter((f) => f.code === 'X1_NULLABILITY');

describe('X1 does not read an unextracted nullable as a stated one', () => {
  it('fires when the contract states the property is not nullable', () => {
    const found = x1Findings(x1Graph({ type: 'string', required: true, nullable: false }));
    assert.equal(found.length, 1);
    assert.match(found[0]?.claim ?? '', /declares email non-nullable/);
  });

  it('stays silent when the same property omits nullable, though it is required', () => {
    assert.deepEqual(x1Findings(x1Graph({ type: 'string', required: true })), []);
  });

  it('stays silent when every facet of the property is unextracted', () => {
    assert.deepEqual(x1Findings(x1Graph({})), []);
  });

  it('stays silent when the contract states the property is nullable', () => {
    assert.deepEqual(x1Findings(x1Graph({ type: 'string', required: true, nullable: true })), []);
  });
});
