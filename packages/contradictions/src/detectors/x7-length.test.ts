// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphView } from '@seamline/ontology';
import { graph, type GraphSpec } from '../graph-memory.ts';
import { observationView, type CurrentObservation } from '../observation.ts';
import { runDetectors } from '../runner.ts';
import type { PropValue } from '../props.ts';
import { x7ValidatorDivergence as detector } from './x7-validator-divergence.ts';

function specification(props: Record<string, PropValue> = {}, confidence = 0.9): GraphSpec {
  return {
    nodes: [
      { kind: 'Table', name: 'entries', canonical: 'default.public.entries', path: 'schema.prisma', props: { ormModel: 'Entry' } },
      { kind: 'Column', name: 'title', canonical: 'default.public.entries.title', path: 'schema.prisma',
        props: { type: 'varchar(120)', typeCategory: 'text', isArray: false, maxLength: 120 } },
      { kind: 'Contract', name: 'writeInput', path: 'app/entry/route.ts' },
      { kind: 'SchemaProperty', name: 'title', canonical: 'writeInput#/properties/title', path: 'app/entry/route.ts',
        props: { direction: 'request', contract: 'writeInput', jsonPointer: '/properties/title', type: 'string', typeCategory: 'text', isArray: false,
          valueRole: 'validated-write-input', writeBindingComplete: true, successfulParse: true,
          unchangedForwarding: true, modelBindingComplete: true, lengthUpperState: 'unbounded',
          storageTable: 'repo:Table:default.public.entries', storageModel: 'Entry', storageField: 'title', ...props } },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'default.public.entries', dst: 'default.public.entries.title' },
      { kind: 'CONTAINS', src: 'writeInput', dst: 'writeInput#/properties/title' },
      { kind: 'BACKED_BY', src: 'writeInput#/properties/title', dst: 'default.public.entries.title', provenance: 'INFERRED', confidence },
    ],
  };
}

/** Unit-fixture authority only. The CLI adapter has separate real-store lifecycle tests. */
const current: CurrentObservation = (_scope, node) => node === undefined || node.lastSeenRun === 'run-fixture';
function report(spec = specification(), observation = current) {
  return runDetectors(graph(spec), [detector], observation).detectors[0];
}

test('X7 compares the two current facts and preserves join confidence and severity', () => {
  const fired = report();
  assert.equal(fired?.outcome, 'fired');
  const finding = fired?.findings[0];
  assert.equal(finding?.left, 'repo:Column:default.public.entries.title');
  assert.equal(finding?.right, 'repo:SchemaProperty:writeInput#/properties/title');
  assert.deepEqual(finding?.viaPath, ['BACKED_BY']);
  assert.equal(finding?.confidence, 0.9);
  assert.equal(finding?.severity, 'high');
  assert.match(finding?.claim ?? '', /permits strings longer than 120/);
  assert.doesNotMatch(finding?.claim ?? '', /500|database error|HTTP/);
  assert.equal(report(specification({}, 0.6))?.findings[0]?.severity, 'medium');
  assert.equal(report(specification({}, 0.34))?.findings.length, 0);
});

test('equal, stricter and looser stated upper limits remain outside this X7 admission', () => {
  for (const maxLength of [80, 120, 400]) {
    const control = report(specification({ lengthUpperState: 'bounded', maxLength }));
    assert.equal(control?.outcome, 'clean');
    assert.deepEqual(control.findings, []);
  }
});

test('each positive length, parse, forwarding, model and role control is necessary', () => {
  for (const props of [
    { lengthUpperState: 'unknown' }, { lengthUpperState: 'bounded' },
    { writeBindingComplete: false }, { successfulParse: false }, { unchangedForwarding: false },
    { modelBindingComplete: false }, { valueRole: 'response' }, { storageModel: 'Different' },
    { storageField: 'caption' }, { storageTable: 'repo:Table:other' }, { isArray: true },
    { typeCategory: 'unknown' }, { maxLength: 120 }, { direction: 'response' }, { direction: '' },
  ]) {
    const denied = report(specification(props));
    assert.equal(denied?.outcome, 'unknown', JSON.stringify(props));
    assert.deepEqual(denied.findings, []);
  }
});

test('facts, liveness, current authority and all four required scopes are enforced', () => {
  for (const kind of ['Column', 'SchemaProperty', 'Contract', 'Table'] as const) {
    for (const change of [{ provenance: 'INFERRED' as const }, { provenance: 'LLM_SUGGESTED' as const }, { deletedAt: 'buried' }]) {
      const spec = specification();
      const changed = { ...spec, nodes: spec.nodes.map(node => node.kind === kind ? { ...node, ...change } : node) };
      assert.equal(report(changed)?.outcome, 'unknown', `${kind} ${JSON.stringify(change)}`);
    }
  }
  for (const scope of ['data', 'contracts', 'code.ts', 'infer-join']) {
    for (const status of ['FAIL', 'UNAVAILABLE'] as const) {
      const spec = { ...specification(), scopes: { [scope]: status } };
      assert.equal(report(spec)?.outcome, 'unknown');
      assert.deepEqual(detector.detect(observationView(graph(spec), current)), []);
    }
    const omitted: CurrentObservation = (candidate, node) => candidate !== scope && current(candidate, node);
    assert.equal(report(specification(), omitted)?.outcome, 'unknown', `scope omitted from current run: ${scope}`);
  }
  const retained: CurrentObservation = (scope, node) => node?.kind !== 'SchemaProperty' && current(scope, node);
  assert.equal(report(specification(), retained)?.outcome, 'unknown', 'a retained fact outside current authority is not fresh evidence');
  assert.equal(runDetectors(graph(specification()), [detector]).detectors[0]?.outcome, 'unknown', 'a bare historical graph cannot certify the current run');
});

test('a stale inferred join cannot connect otherwise current endpoints', () => {
  const base = graph(specification());
  const stale = <T extends { readonly kind: string; readonly lastSeenRun: string }>(edge: T): T =>
    edge.kind === 'BACKED_BY' ? { ...edge, lastSeenRun: 'prior-run' } : edge;
  const view: GraphView = {
    nodesByKind: kind => base.nodesByKind(kind), node: id => base.node(id), scopeStatus: scope => base.scopeStatus(scope),
    edgesFrom: (id, kind) => base.edgesFrom(id, kind).map(stale), edgesTo: (id, kind) => base.edgesTo(id, kind).map(stale),
  };
  assert.equal(runDetectors(view, [detector], current).detectors[0]?.outcome, 'unknown');
});

test('X7 rejects a tombstone even when a host view exposes it', () => {
  const base = graph(specification());
  for (const kind of ['Column', 'SchemaProperty', 'Table', 'Contract']) {
    const tombstone = <T extends { readonly kind: string; readonly deletedAt: string | null }>(node: T): T =>
      node.kind === kind ? {...node, deletedAt: 'buried'} : node;
    const view: GraphView = {
      nodesByKind: requested => base.nodesByKind(requested).map(tombstone),
      node: id => { const node = base.node(id); return node === undefined ? undefined : tombstone(node); },
      scopeStatus: scope => base.scopeStatus(scope),
      edgesFrom: (id, edge) => base.edgesFrom(id, edge), edgesTo: (id, edge) => base.edgesTo(id, edge),
    };
    assert.equal(runDetectors(view, [detector], current).detectors[0]?.outcome, 'unknown', kind);
  }
});

test('synthetic Symbol constraints cannot supply X7 producer coverage', () => {
  const spec: GraphSpec = {
    nodes: [
      { kind: 'Column', name: 'title', canonical: 'default.public.entries.title', props: { maxLength: 120 } },
      { kind: 'Symbol', name: 'validator', props: { maxLength: 20, required: true } },
    ],
    edges: [{ kind: 'VALIDATED_BY', src: 'default.public.entries.title', dst: 'validator' }],
  };
  assert.equal(report(spec)?.outcome, 'unknown');
  assert.deepEqual(report(spec)?.findings, []);
});


test('missing request direction is UNKNOWN even when all write flags are present', () => {
  const base = specification();
  const spec = { ...base, nodes: base.nodes.map(node => {
    if (node.kind !== 'SchemaProperty') return node;
    const { direction: _direction, ...props } = node.props ?? {};
    return { ...node, props };
  }) };
  assert.equal(report(spec)?.outcome, 'unknown');
});
