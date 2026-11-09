/**
 * The relationship between join confidence and severity.
 *
 * The contradiction is between two facts, but the *connection* between them is
 * inferred, so the finding is only as strong as the join. These tests pin that
 * a weak join cannot produce a loud finding, and that a very weak one produces
 * no finding at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Severity } from '@seamline/ontology';

import {
  CONFIDENCE_FLOOR,
  SEVERITY_CONFIDENCE_FLOOR,
  gateSeverity,
  severityCeiling,
} from './detector.ts';
import { graph } from './graph-memory.ts';
import { pathConfidence } from './graph.ts';
import { runDetectors } from './runner.ts';

function piiRoute(implementedByConfidence: number, provenance: 'EXTRACTED' | 'INFERRED') {
  return graph({
    nodes: [
      { kind: 'Contract', name: 'api', canonical: 'openapi.api' },
      { kind: 'Operation', name: 'GET /p', canonical: 'openapi.api#get:/p', props: { auth: 'none' } },
      { kind: 'RouteHandler', name: 'GET /p', canonical: 'route:GET:/p' },
      { kind: 'Symbol', name: 'getP', canonical: 'src/p.ts#getP' },
      { kind: 'Table', name: 'people', canonical: 'db.public.people' },
      {
        kind: 'Column',
        name: 'ssn',
        canonical: 'db.public.people.ssn',
        props: { type: 'text', pii: 'high' },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'openapi.api', dst: 'openapi.api#get:/p' },
      { kind: 'CONTAINS', src: 'db.public.people', dst: 'db.public.people.ssn' },
      {
        kind: 'IMPLEMENTED_BY',
        src: 'openapi.api#get:/p',
        dst: 'route:GET:/p',
        provenance,
        confidence: implementedByConfidence,
      },
      { kind: 'HANDLES_ROUTE', src: 'src/p.ts#getP', dst: 'route:GET:/p' },
      { kind: 'QUERIES', src: 'src/p.ts#getP', dst: 'db.public.people', props: { writes: false } },
    ],
  });
}

const x6 = (g: ReturnType<typeof graph>) =>
  runDetectors(g).findings.find((f) => f.code === 'X6_PII_UNAUTHENTICATED');

describe('gateSeverity', () => {
  it('keeps the declared severity when the join is certain', () => {
    for (const s of ['critical', 'high', 'medium', 'low'] as const) {
      assert.equal(gateSeverity(s, 1), s);
    }
  });

  it('lowers, never raises', () => {
    assert.equal(gateSeverity('low', 1), 'low');
    assert.equal(gateSeverity('critical', 0.8), 'high');
    assert.equal(gateSeverity('critical', 0.6), 'medium');
    assert.equal(gateSeverity('high', 0.6), 'medium');
    assert.equal(gateSeverity('medium', 0.4), 'low');
  });

  it('suppresses entirely below the floor', () => {
    assert.equal(gateSeverity('critical', CONFIDENCE_FLOOR - 0.01), undefined);
    assert.equal(severityCeiling(0.34), undefined);
  });

  it('the floors are ordered', () => {
    const order: ReadonlyArray<Severity> = ['critical', 'high', 'medium', 'low'];
    for (let i = 1; i < order.length; i += 1) {
      const higher = SEVERITY_CONFIDENCE_FLOOR[order[i - 1] as Severity];
      const lower = SEVERITY_CONFIDENCE_FLOOR[order[i] as Severity];
      assert.ok(higher > lower, `${order[i - 1]} floor must exceed ${order[i]} floor`);
    }
  });
});

describe('pathConfidence', () => {
  it('a fact hop costs nothing and inferred hops multiply', () => {
    const g = graph({
      nodes: [
        { kind: 'Table', name: 't', canonical: 't' },
        { kind: 'Column', name: 'c', canonical: 't.c' },
      ],
      edges: [{ kind: 'CONTAINS', src: 't', dst: 't.c' }],
    });
    const factEdge = g.edgesFrom(g.nodesByKind('Table')[0]!.id)[0]!;
    assert.equal(pathConfidence([{ edge: factEdge, from: factEdge.src, to: factEdge.dst, step: { kind: 'CONTAINS', dir: 'out' } }]), 1);

    const inferred = { ...factEdge, provenance: 'INFERRED' as const, confidence: 0.8 };
    const hop = { edge: inferred, from: inferred.src, to: inferred.dst, step: { kind: 'CONTAINS' as const, dir: 'out' as const } };
    assert.equal(pathConfidence([hop, hop]), 0.64);
  });
});

describe('a low-confidence join cannot produce a high-severity contradiction', () => {
  it('an extracted route mapping reports X6 at its declared critical', () => {
    const finding = x6(piiRoute(1, 'EXTRACTED'));
    assert.ok(finding !== undefined);
    assert.equal(finding.confidence, 1);
    assert.equal(finding.severity, 'critical');
  });

  it('a 0.8 inferred route mapping reports the same facts as high, not critical', () => {
    const finding = x6(piiRoute(0.8, 'INFERRED'));
    assert.ok(finding !== undefined);
    assert.equal(finding.confidence, 0.8);
    assert.equal(finding.severity, 'high');
  });

  it('a 0.55 inferred route mapping drops it to medium', () => {
    const finding = x6(piiRoute(0.55, 'INFERRED'));
    assert.ok(finding !== undefined);
    assert.equal(finding.severity, 'medium');
  });

  it('a 0.2 inferred route mapping reports nothing at all', () => {
    assert.equal(x6(piiRoute(0.2, 'INFERRED')), undefined);
  });

  it('no detector ever reports above the ceiling its confidence allows', () => {
    for (const confidence of [1, 0.95, 0.8, 0.55, 0.4, 0.2]) {
      for (const f of runDetectors(piiRoute(confidence, 'INFERRED')).findings) {
        const ceiling = severityCeiling(f.confidence);
        assert.ok(ceiling !== undefined);
        assert.ok(
          SEVERITY_CONFIDENCE_FLOOR[f.severity] <= f.confidence,
          `${f.code} reported ${f.severity} on a join of ${f.confidence}`,
        );
      }
    }
  });
});
