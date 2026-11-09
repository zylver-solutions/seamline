/**
 * Provenance is the line between a fact and a guess (v3 section 2.4).
 *
 * These tests pin the exact rule the design states and the one subtlety that
 * makes it interesting: the two *facts* must be EXTRACTED or DECLARED, but the
 * *join* between them is normally INFERRED, and refusing inferred joins would
 * leave no cross-domain detector able to fire at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Provenance } from '@seamline/ontology';

import { graph } from './graph-memory.ts';
import { runDetectors } from './runner.ts';

function nullabilityGraph(opts: {
  nodeProvenance?: Provenance;
  edgeProvenance?: Provenance;
  edgeConfidence?: number;
}) {
  return graph({
    nodes: [
      { kind: 'Table', name: 'users', canonical: 'db.public.users' },
      {
        kind: 'Column',
        name: 'email',
        canonical: 'db.public.users.email',
        provenance: opts.nodeProvenance ?? 'EXTRACTED',
        props: { type: 'text', nullable: true },
      },
      { kind: 'Contract', name: 'usersApi', canonical: 'openapi.usersApi' },
      {
        kind: 'SchemaProperty',
        name: 'email',
        canonical: 'openapi.usersApi#/User/email',
        provenance: opts.nodeProvenance ?? 'EXTRACTED',
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
        provenance: opts.edgeProvenance ?? 'INFERRED',
        confidence: opts.edgeConfidence ?? 0.95,
      },
    ],
  });
}

const fired = (g: ReturnType<typeof graph>): boolean =>
  runDetectors(g).findings.some((f) => f.code === 'X1_NULLABILITY');

describe('detectors read facts only', () => {
  it('the control fires, so the negative cases below mean something', () => {
    assert.equal(fired(nullabilityGraph({})), true);
  });

  it('DECLARED nodes are facts and still fire', () => {
    assert.equal(fired(nullabilityGraph({ nodeProvenance: 'DECLARED' })), true);
  });

  for (const provenance of ['INFERRED', 'LLM_SUGGESTED'] as const) {
    it(`${provenance} nodes never produce a finding`, () => {
      assert.equal(fired(nullabilityGraph({ nodeProvenance: provenance })), false);
    });
  }

  it('a graph whose only edges are INFERRED still fires, because the join is the wedge', () => {
    assert.equal(fired(nullabilityGraph({ edgeProvenance: 'INFERRED' })), true);
  });

  it('an LLM_SUGGESTED join never produces a finding at any confidence', () => {
    assert.equal(
      fired(nullabilityGraph({ edgeProvenance: 'LLM_SUGGESTED', edgeConfidence: 1 })),
      false,
    );
  });

  it('a tombstoned fact produces nothing', () => {
    const g = graph({
      nodes: [
        { kind: 'Table', name: 'users', canonical: 'db.public.users' },
        {
          kind: 'Column',
          name: 'email',
          canonical: 'db.public.users.email',
          deletedAt: 'run-7',
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
    assert.equal(fired(g), false);
  });
});
