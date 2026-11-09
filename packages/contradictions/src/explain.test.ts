/**
 * A finding a developer cannot act on is noise. These tests assert the
 * rendering carries everything acting on it requires: both facts, both source
 * refs, the join that connected them with its provenance and confidence, and
 * the reason the severity is what it is.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ALL_DETECTORS } from './detectors/index.ts';
import { explain, explainReport } from './explain.ts';
import { FIXTURES, SQL_SLICE_FACTS } from './fixtures.ts';
import { emptyReplayFixtureNodes } from './__fixtures__/replay.ts';
import { graph } from './graph-memory.ts';
import { runDetectors } from './runner.ts';
import { SCOPE_DATA } from './scopes.ts';

describe('explain', () => {
  it('names both facts, both sources, the join and the confidence', () => {
    const g = FIXTURES.X1_NULLABILITY.firing();
    const report = runDetectors(g);
    const finding = report.findings.find((f) => f.code === 'X1_NULLABILITY');
    assert.ok(finding !== undefined);
    const text = explain(g, finding);

    // What disagrees.
    assert.ok(text.startsWith('X1_NULLABILITY [high]'), text);
    assert.match(text, /permits NULL/);

    // The two facts, by name.
    assert.match(text, /Column email/);
    assert.match(text, /SchemaProperty email/);
    assert.match(text, /NULL-able/);
    assert.match(text, /declared non-nullable in the contract/);

    // Both source refs, so the reader can open the files.
    assert.match(text, /db\/schema\.sql:12/);
    assert.match(text, /openapi\.yaml:44/);

    // The path that joined them, with its provenance and weight.
    assert.match(text, /BACKED_BY INFERRED 0\.9/);
    assert.match(text, /infer-join: exact name and type match/);

    // The confidence, and why this severity.
    assert.match(text, /confidence:\s+0\.9/);
    assert.match(text, /severity:\s+high/);
  });

  it('states when the confidence gate lowered the severity', () => {
    const g = graph({
      nodes: [
        { kind: 'Table', name: 'users', canonical: 'db.public.users' },
        {
          kind: 'Column',
          name: 'email',
          canonical: 'db.public.users.email',
          sourceRef: 'db/schema.sql:12',
          props: { type: 'text', nullable: true },
        },
        { kind: 'Contract', name: 'usersApi', canonical: 'openapi.usersApi' },
        {
          kind: 'SchemaProperty',
          name: 'email',
          canonical: 'openapi.usersApi#/User/email',
          sourceRef: 'openapi.yaml:44',
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
          confidence: 0.6,
        },
      ],
    });
    const finding = runDetectors(g).findings.find((f) => f.code === 'X1_NULLABILITY');
    assert.ok(finding !== undefined);
    const text = explain(g, finding);
    assert.match(text, /severity:\s+medium \(X1_NULLABILITY claims high; lowered/);
    assert.match(text, /0\.6 is below the 0\.75 required for high/);
  });

  it('says so plainly when no inference was involved', () => {
    const g = FIXTURES.X8_ORPHANED_MIGRATION.firing();
    const finding = runDetectors(g).findings.find((f) => f.code === 'X8_ORPHANED_MIGRATION');
    assert.ok(finding !== undefined);
    const text = explain(g, finding);
    assert.match(text, /nothing inferred/);
    assert.match(text, /declared migration replay/);
    assert.match(text, /supabase\/migrations\/001_ref\.sql:1/);
  });

  it('renders every hop of a multi-hop join', () => {
    const g = FIXTURES.X6_PII_UNAUTHENTICATED.firing();
    const finding = runDetectors(g).findings.find((f) => f.code === 'X6_PII_UNAUTHENTICATED');
    assert.ok(finding !== undefined);
    const text = explain(g, finding);
    for (const kind of ['IMPLEMENTED_BY', 'HANDLES_ROUTE', 'QUERIES', 'CONTAINS']) {
      assert.match(text, new RegExp(kind));
    }
    assert.match(text, /Operation GET \/profile/);
    assert.match(text, /Column ssn/);
  });
});

describe('explainReport', () => {
  it('renders the findings and then the detectors that could not answer', () => {
    const g = FIXTURES.X1_NULLABILITY.firing();
    const blocked = graph({
      scopes: { [SCOPE_DATA]: 'FAIL' },
      nodes: [],
    });
    assert.match(explainReport(g, runDetectors(g)), /X1_NULLABILITY \[high\]/);
    const text = explainReport(blocked, runDetectors(blocked));
    assert.match(text, /\[UNKNOWN\]/);
    assert.match(text, new RegExp(`${SCOPE_DATA}=FAIL`));
  });

  it('says nothing was found rather than printing an empty string', () => {
    const g = graph({
      nodes: [
        ...SQL_SLICE_FACTS.filter((node) => node.kind !== 'DataSource'),
        ...emptyReplayFixtureNodes('db'),
        { kind: 'Table', name: 'users', canonical: 'db.users' },
        { kind: 'Column', name: 'email', canonical: 'db.users.email', props: { type: 'text', nullable: false } },
        { kind: 'Contract', name: 'usersApi', canonical: 'api.users', props: { unreadStructuredDocuments: 0 } },
        { kind: 'SchemaProperty', name: 'email', canonical: 'api.users.email', props: { type: 'string', nullable: false, direction: 'response' } },
      ],
      edges: [
        { kind: 'CONTAINS', src: 'db.users', dst: 'db.users.email' },
        { kind: 'CONTAINS', src: 'api.users', dst: 'api.users.email' },
        { kind: 'EXPOSED_AS', src: 'db.users.email', dst: 'api.users.email' },
      ],
    });
    const report = runDetectors(g, ALL_DETECTORS.filter(detector => detector.code !== 'X7_VALIDATOR_DIVERGENCE'));
    assert.equal(report.counts.unknown, 0);
    assert.equal(report.findings.length, 0);
    assert.match(explainReport(g, report), /no contradictions/);
    const full = explainReport(g, runDetectors(g));
    assert.match(full, /X7_VALIDATOR_DIVERGENCE \[UNKNOWN\]/);
    assert.doesNotMatch(full, /no contradictions/);
  });

  it('does not describe unobserved value comparisons as no contradictions', () => {
    const g = graph({ nodes: [...SQL_SLICE_FACTS] });
    const text = explainReport(g, runDetectors(g));
    assert.match(text, /X1_NULLABILITY \[UNKNOWN\] VALUE_ROLE_UNOBSERVED/);
    assert.match(text, /X2_TYPE \[UNKNOWN\] VALUE_ROLE_UNOBSERVED/);
    assert.doesNotMatch(text, /no contradictions/);
  });
});
