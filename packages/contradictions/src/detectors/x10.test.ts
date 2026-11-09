import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { graph, type GraphSpec } from '../graph-memory.ts';
import type { Props } from '../props.ts';
import { runDetectors } from '../runner.ts';
import { x10UntestedPiiWrite } from './x10-untested-pii-write.ts';

function report(props: Props, verification: 'unrelated' | 'writer' | 'none' = 'unrelated') {
  const spec: GraphSpec = {
    nodes: [
      { kind: 'Table', name: 'contacts', canonical: 'db.contacts' },
      { kind: 'Column', name: 'email', canonical: 'db.contacts.email', props: { pii: 'high' } },
      { kind: 'Column', name: 'display_name', canonical: 'db.contacts.display_name' },
      { kind: 'Symbol', name: 'writeContact' },
      { kind: 'Symbol', name: 'readControl' },
      ...(verification === 'none' ? [] : [{ kind: 'TestCase' as const, name: 'control', provenance: 'DECLARED' as const }]),
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.contacts', dst: 'db.contacts.email' },
      { kind: 'CONTAINS', src: 'db.contacts', dst: 'db.contacts.display_name' },
      { kind: 'QUERIES', src: 'writeContact', dst: 'db.contacts', props },
      ...(verification === 'none' ? [] : [{ kind: 'TESTS' as const, src: 'control', dst: verification === 'writer' ? 'writeContact' : 'readControl' }]),
    ],
  };
  const result = runDetectors(graph(spec), [x10UntestedPiiWrite]).detectors[0];
  assert.ok(result);
  return result;
}

describe('X10 consumes the explicit columns of every write class', () => {
  for (const [operation, fields] of [
    ['insert', { insertComplete: true, insertColumns: 'display_name' }],
    ['update', { updateComplete: true, updateColumns: 'display_name' }],
    ['upsert', { insertComplete: true, insertColumns: 'display_name', updateComplete: true, updateColumns: 'display_name' }],
  ] as const) {
    it(`${operation} of a non-PII column does not claim the sibling email was written`, () => {
      const result = report({ operation, ...fields });
      assert.equal(result.outcome, 'clean');
      assert.deepEqual(result.findings, []);
    });
  }

  const positiveCases: readonly Props[] = [
    { operation: 'insert', insertComplete: true, insertColumns: 'email' },
    { operation: 'update', updateComplete: true, updateColumns: 'email' },
    { operation: 'upsert', insertComplete: true, insertColumns: 'display_name', updateComplete: true, updateColumns: 'email' },
    { operation: 'upsert', insertComplete: true, insertColumns: 'email', updateComplete: true, updateColumns: 'display_name' },
    { operations: 'select,insert,update', writes: true, insertComplete: true, insertColumns: 'display_name', updateComplete: true, updateColumns: 'email' },
    { writes: true, columns: 'email' },
  ];
  for (const props of positiveCases) {
    it(`retains the exact PII endpoint for ${JSON.stringify(props)}`, () => {
      const result = report(props);
      assert.equal(result.outcome, 'fired');
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0]?.right, 'repo:Column:db.contacts.email');
      assert.equal(report(props, 'writer').outcome, 'clean');
    });
  }

  it('a legacy columns field cannot hide a typed write to email', () => {
    assert.equal(report({ operation: 'insert', columns: 'display_name', insertColumns: 'email', insertComplete: true }).outcome, 'fired');
  });

  const unknownCases: readonly Props[] = [
    { operation: 'insert' },
    { operation: 'insert', insertColumns: 'display_name' },
    { operation: 'insert', insertComplete: true },
    { operation: 'insert', insertComplete: true, insertColumns: '' },
    { operation: 'insert', insertComplete: false, insertColumns: 'display_name' },
    { operation: 'update', updateComplete: false, updateColumns: 'email' },
    { operation: 'upsert', insertComplete: true, insertColumns: 'display_name' },
    { operation: 'upsert', insertComplete: false, insertColumns: 'email', updateComplete: true, updateColumns: 'display_name' },
    { operation: 'upsert', insertComplete: true, insertColumns: 'display_name', updateComplete: false, updateColumns: 'email' },
    { operations: 'insert,update', insertComplete: true, insertColumns: 'display_name', updateComplete: false },
    { operation: 'insert', insertComplete: false, insertColumns: 'display_name', columns: 'email' },
    { writes: true },
    { operation: 'merge' },
    { operations: 'select,insert', writes: true, columns: 'email' },
    { operation: 'insert', insertComplete: true, insertColumns: 'display_name', updateComplete: false },
  ];
  for (const props of unknownCases) {
    it(`missing or incomplete write columns stay UNKNOWN: ${JSON.stringify(props)}`, () => {
      const result = report(props);
      assert.equal(result.outcome, 'unknown');
      assert.deepEqual(result.findings, []);
      assert.equal(result.result.known, false);
      if (!result.result.known) assert.match(result.result.reason, /^WRITE_COLUMNS_UNOBSERVED:/u);
    });
  }

  it('an unrelated SELECT does not make a complete non-PII write reach every column', () => {
    assert.equal(report({ operations: 'select,insert', writes: true, insertComplete: true, insertColumns: 'display_name' }).outcome, 'clean');
  });

  it('no verification facts retains the documented clean result and explanatory note', () => {
    const result = report({ operation: 'insert' }, 'none');
    assert.equal(result.outcome, 'clean');
    assert.deepEqual(result.findings, []);
    assert.equal(result.notes.length, 1);
    assert.match(result.notes[0] ?? '', /no TestCase or CoverageRecord facts/u);
  });

  it('a verified writer needs no absence conclusion even when its column set is unknown', () => {
    assert.equal(report({ operation: 'insert' }, 'writer').outcome, 'clean');
  });

  it('quoted identifiers that differ only in case are distinct column facts', () => {
    const result = runDetectors(graph({
      nodes: [
        { kind: 'Table', name: 'contacts' },
        { kind: 'Column', name: 'Email', canonical: 'contacts.Email', props: { pii: 'high' } },
        { kind: 'Column', name: 'email', canonical: 'contacts.email', props: { pii: 'high' } },
        { kind: 'Symbol', name: 'writer' },
        { kind: 'TestCase', name: 'unrelated', provenance: 'DECLARED' },
      ],
      edges: [
        { kind: 'CONTAINS', src: 'contacts', dst: 'contacts.Email' },
        { kind: 'CONTAINS', src: 'contacts', dst: 'contacts.email' },
        { kind: 'QUERIES', src: 'writer', dst: 'contacts', props: { operation: 'insert', insertComplete: true, insertColumns: 'Email' } },
      ],
    }), [x10UntestedPiiWrite]).detectors[0];
    assert.equal(result?.outcome, 'fired');
    assert.deepEqual(result?.findings.map(finding => finding.right), ['repo:Column:contacts.Email']);
  });
});
