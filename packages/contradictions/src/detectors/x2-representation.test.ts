import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nodeId } from '@seamline/ontology';
import { graph, type GraphSpec } from '../graph-memory.ts';
import { classifyContractType, classifyType, typesCompatible } from '../props.ts';
import { runDetectors } from '../runner.ts';
import { x2Type } from './x2-type.ts';

function pair(key: string, column: string, property: string): GraphSpec {
  return {
    nodes: [
      { kind: 'Column', name: 'payload', canonical: `${key}.column`, props: { type: column }, sourceRef: 'schema.sql:1' },
      { kind: 'SchemaProperty', name: 'payload', canonical: `${key}.property`, props: { type: property }, sourceRef: 'openapi.json:1' },
    ],
    edges: [{ kind: 'EXPOSED_AS', src: `${key}.column`, dst: `${key}.property`, provenance: 'INFERRED', confidence: 0.91 }],
  };
}

const combine = (...specs: GraphSpec[]): GraphSpec => ({ nodes: specs.flatMap((s) => s.nodes), edges: specs.flatMap((s) => s.edges ?? []) });
const report = (spec: GraphSpec) => {
  const g = graph(spec);
  const result = runDetectors(g).detectors.find((d) => d.code === 'X2_TYPE');
  assert.ok(result);
  return { g, result };
};

function representationUnknown(spec: GraphSpec): void {
  const { g, result } = report(spec);
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.result.known, false);
  if (!result.result.known) assert.match(result.result.reason, /^REPRESENTATION_UNOBSERVED:/);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(x2Type.detect(g), []);
  assert.match(x2Type.unknownReason(g) ?? '', /^REPRESENTATION_UNOBSERVED:/);
}

describe('X2 does not infer serialization from declarations', () => {
  it('retains classified types and does not add string/JSON compatibility', () => {
    assert.equal(classifyType('text'), 'string');
    assert.equal(classifyType('jsonb'), 'json');
    assert.equal(classifyContractType({ type: 'object' }), 'json');
    assert.equal(classifyContractType({ type: 'array' }), 'json');
    assert.equal(typesCompatible('string', 'json'), false);
    assert.equal(typesCompatible('json', 'string'), false);
  });

  for (const [column, property] of [['text', 'object'], ['text', 'array'], ['jsonb', 'string']] as const) {
    it(`reports representation UNKNOWN for ${column}/${property}`, () => {
      representationUnknown(pair('ambiguous', column, property));
    });
  }

  it('preserves an independently incompatible finding, facts and confidence in a mixed graph', () => {
    const positive = pair('positive', 'integer', 'boolean');
    const { g, result } = report(combine(pair('ambiguous', 'text', 'object'), positive));
    const alone = report(positive).result;
    assert.equal(result.outcome, 'fired');
    assert.deepEqual(result.findings, alone.findings);
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0]!;
    assert.equal(finding.left, nodeId('repo', 'Column', 'positive.column'));
    assert.equal(finding.right, nodeId('repo', 'SchemaProperty', 'positive.property'));
    assert.equal(finding.confidence, 0.91);
    assert.equal(finding.leftFact, 'payload is integer (schema.sql:1)');
    assert.equal(finding.rightFact, 'payload is boolean (openapi.json:1)');
    assert.deepEqual(finding.viaPath, ['EXPOSED_AS']);
    assert.equal(g.node(finding.left)?.provenance, 'EXTRACTED');
    assert.equal(g.node(finding.right)?.provenance, 'EXTRACTED');
    assert.equal(g.node(finding.left)?.sourceRef, 'schema.sql:1');
    assert.equal(g.node(finding.right)?.sourceRef, 'openapi.json:1');
    assert.match(result.notes.join('\n'), /String\/JSON comparisons withheld/);
  });

  it('retains known clean comparisons and both partial-coverage notes', () => {
    const spec = combine(pair('ambiguous', 'text', 'object'), pair('compatible', 'integer', 'number'));
    const withField: GraphSpec = {
      nodes: [...spec.nodes, { kind: 'CodeField', name: 'payload', canonical: 'ui.payload', props: { type: 'boolean' } }],
      edges: [...spec.edges!, { kind: 'MAPS_TO_FIELD', src: 'ambiguous.column', dst: 'ui.payload' }],
    };
    const { result } = report(withField);
    assert.equal(result.outcome, 'clean');
    assert.equal(result.result.known, true);
    assert.deepEqual(result.findings, []);
    assert.equal(result.notes.length, 2);
    assert.match(result.notes.join('\n'), /generic code shape/);
    assert.match(result.notes.join('\n'), /String\/JSON comparisons withheld/);
    assert.equal(report(pair('compatible', 'integer', 'number')).result.outcome, 'clean');
    assert.equal(report(pair('retained-positive', 'integer', 'string')).result.outcome, 'fired');
  });

  for (const endpoint of ['Column', 'SchemaProperty']) {
    for (const excluded of ['INFERRED', 'LLM_SUGGESTED', 'tombstoned'] as const) {
      it(`does not use a ${excluded} ${endpoint} to make a mixed graph observable`, () => {
        const apparent = pair('excluded', 'integer', 'boolean');
        const altered: GraphSpec = {
          ...apparent,
          nodes: apparent.nodes.map((n) => n.kind !== endpoint ? n : excluded === 'tombstoned'
            ? { ...n, deletedAt: 'retired-run' }
            : { ...n, provenance: excluded }),
        };
        representationUnknown(combine(pair('ambiguous', 'text', 'object'), altered));
      });
    }
  }

  it('keeps blocked scope precedence and direct-detection refusal', () => {
    const spec = { ...pair('ambiguous', 'text', 'object'), scopes: { contracts: 'UNAVAILABLE' as const } };
    const { g, result } = report(spec);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.result.known, false);
    if (!result.result.known) assert.match(result.result.reason, /^SCOPE_NOT_PASS:/);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(x2Type.detect(g), []);
  });

  it('keeps unsupported-only comparisons as value-role UNKNOWN', () => {
    const { result } = report(pair('unsupported', 'custom_type', 'object'));
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.result.known, false);
    if (!result.result.known) assert.match(result.result.reason, /^VALUE_ROLE_UNOBSERVED:/);
    assert.deepEqual(result.findings, []);
  });
});
