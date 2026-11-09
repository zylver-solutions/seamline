// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentObservationOf, encodeCanonicalSelector, SIF_FRAME, writeSif } from '@seamline/core';
import { secretCanary } from '@seamline/security/corpus';
import { makeEdge, makeNode, makeResult, makeRun } from '../testing.ts';
import { decodeExtractorOutput, encodeExtractorOutput } from './output-codec.ts';
import { isResponse, PROTOCOL_VERSION } from './protocol.ts';

const contract = makeNode({ kind: 'Contract', canonicalName: 'A', path: 'src/input.ts' });
const property = makeNode({ kind: 'SchemaProperty', canonicalName: 'A#/properties/title', path: 'src/input.ts' });
const other = makeNode({ kind: 'Contract', canonicalName: 'B', name: 'A', path: 'src/input.ts' });
const edge = makeEdge({ kind: 'CONTAINS', src: contract.id, dst: property.id, provenance: 'EXTRACTED' });
const result = { ...makeResult('probe', 'PASS', []), authoritative: [
  { scope: 'contracts', kinds: ['Contract'] as const,
    selector: encodeCanonicalSelector({ path: 'src/input.ts', rules: [['exact', 'A']] }) },
] };
const output = { result, nodes: [property, contract], edges: [
  { scope: 'contracts', edges: [edge] }, { scope: 'second-scope', edges: [edge] },
] };

test('framed worker output preserves literal authority and distinct scopes without inventing a run', () => {
  const wire = encodeExtractorOutput(output);
  assert.ok(wire.sif.startsWith(SIF_FRAME + '\n'));
  assert.ok(wire.edgeSifs.every(group => group.sif.startsWith(SIF_FRAME + '\n')));
  const decoded = decodeExtractorOutput(wire);
  assert.deepEqual(decoded.result, result);
  assert.deepEqual(decoded.edges.map(group => [group.scope, group.edges]),
    [['contracts', [edge]], ['second-scope', [edge]]], 'identical edge identities in different scopes remain distinct');
  assert.deepEqual(decoded.nodes.map(node => node.id), [contract.id, property.id]);
  const current = currentObservationOf(makeRun('run-1', [decoded.result]));
  assert.equal(current('contracts', contract), true);
  assert.equal(current('contracts', other), false, 'path and display name cannot widen the canonical claim');
  assert.equal(wire.sif.includes('"t":"run"'), false);
  assert.equal(JSON.stringify(encodeExtractorOutput({ ...output, nodes: [...output.nodes].reverse(), edges: [...output.edges].reverse() })),
    JSON.stringify(wire), 'permuting facts and scoped groups produces identical transport bytes');
});

test('worker decoding refuses missing, future, duplicate or misplaced framing and wrong record roles atomically', () => {
  const wire = encodeExtractorOutput(output);
  const strip = (value: string): string => value.slice(SIF_FRAME.length + 1);
  for (const sif of [strip(wire.sif), wire.sif.replace(SIF_FRAME, 'seamline-sif/9.0.0'),
    wire.sif + SIF_FRAME + '\n', SIF_FRAME + '\r\n' + strip(wire.sif), wire.sif.trimEnd() + SIF_FRAME,
    writeSif([{ t: 'run', run: makeRun('run-1', [result]) }]), writeSif([{ t: 'edge', edge }])]) {
    assert.throws(() => decodeExtractorOutput({ ...wire, sif }));
  }
  for (const sif of [strip(wire.edgeSifs[0]!.sif), writeSif([{ t: 'node', node: contract }]),
    writeSif([{ t: 'status', result }])]) {
    assert.throws(() => decodeExtractorOutput({ ...wire, edgeSifs: [...wire.edgeSifs, { scope: 'late-invalid', sif }] }),
      'a valid primary and earlier edge documents do not expose partial output');
  }
  assert.throws(() => decodeExtractorOutput(output), /framed facts/);
  assert.equal(isResponse({ v: 1, ok: true, output: wire, denials: [] }), false);
  assert.equal(isResponse({ v: PROTOCOL_VERSION + 1, ok: true, output: wire, denials: [] }), false);
  assert.equal(isResponse({ v: PROTOCOL_VERSION, ok: false, failure: { kind: 'protocol', message: 1 }, denials: [] }), false);
});

test('worker framing cannot launder a reversible credential envelope through any reported status', () => {
  const canary = secretCanary('aws-access-key-id/documented-example').secret;
  const hex = Buffer.from(canary).toString('hex');
  const selector = '/@canonical/v1/' + Buffer.from(JSON.stringify({ path: 'src/input.ts', rules: [['exact', canary]] })).toString('hex');
  for (const status of ['PASS', 'FAIL', 'UNAVAILABLE'] as const) {
    const unsafe = { ...result, status, authoritative: [{ scope: 'contracts', kinds: ['Contract'] as const, selector }] };
    for (const operation of [
      () => encodeExtractorOutput({ ...output, result: unsafe }),
      () => decodeExtractorOutput({ sif: SIF_FRAME + '\n' + JSON.stringify({ t: 'status', result: unsafe }) + '\n', edgeSifs: [] }),
    ]) assert.throws(operation, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(canary), false);
      assert.equal(error.message.includes(hex), false);
      return true;
    });
  }
});
