/**
 * The fact vocabulary these detectors read is produced by four other packages,
 * and a detector that reads a property name nobody emits is silently vacuous
 * forever. These tests pin the accessors against what the v0.1 extractors
 * actually write, in the shape they actually write it.
 *
 * They are written against the accessors rather than by importing the
 * extractors, because this package depends on `@seamline/ontology` alone. A
 * later integration package is the right place to assert the two sides agree
 * by construction.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  operationAuth,
  piiWeight,
  propertyDirection,
  queryInsertColumns,
  queryInsertComplete,
  queryInterpolated,
  queryOperations,
  queryUpdateColumns,
  queryUpdateComplete,
  queryWrites,
} from './props.ts';
import { graph } from './graph-memory.ts';
import { runDetectors } from './runner.ts';

describe('Operation auth, as extract-contracts emits it', () => {
  it('reads authMode as well as auth', () => {
    assert.equal(operationAuth({ authMode: 'none' }), 'none');
    assert.equal(operationAuth({ authMode: 'bearer' }), 'bearer');
  });

  it('treats the literal "unknown" the same as an absent property', () => {
    assert.equal(operationAuth({ authMode: 'unknown' }), undefined);
    assert.equal(operationAuth({}), undefined);
  });

  it('an explicit auth property wins over authMode', () => {
    assert.equal(operationAuth({ auth: 'session', authMode: 'none' }), 'session');
  });
});

describe('QUERIES writes, as extract-code-ts emits it', () => {
  it('derives the write from the parsed SQL verb', () => {
    assert.equal(queryWrites({ operation: 'insert' }), true);
    assert.equal(queryWrites({ operation: 'update' }), true);
    assert.equal(queryWrites({ operation: 'delete' }), true);
    assert.equal(queryWrites({ operation: 'select' }), false);
  });

  it('says nothing about a verb it does not recognize', () => {
    assert.equal(queryWrites({ operation: 'call' }), undefined);
    assert.equal(queryWrites({}), undefined);
  });

  it('an explicit writes flag wins over the verb', () => {
    assert.equal(queryWrites({ writes: false, operation: 'insert' }), false);
  });

  it('reads an upsert as a write', () => {
    assert.equal(queryWrites({ operation: 'upsert' }), true);
  });
});

describe('QUERIES with several classes, as extract-code-ts folds them', () => {
  it('takes `operations` when present and `operation` otherwise', () => {
    assert.deepEqual(queryOperations({ operations: 'insert,update' }), ['insert', 'update']);
    assert.deepEqual(queryOperations({ operation: 'SELECT' }), ['select']);
    assert.deepEqual(queryOperations({ operations: 'delete,select', operation: 'insert' }), ['delete', 'select']);
    assert.equal(queryOperations({}), undefined);
  });

  it('is a write when any class is, without needing the writes flag', () => {
    assert.equal(queryWrites({ operations: 'select,update' }), true);
    assert.equal(queryWrites({ operations: 'delete,insert' }), true);
    assert.equal(queryWrites({ operations: 'select' }), false);
    assert.equal(queryWrites({ operations: 'call,select' }), undefined);
  });

  it('reads the per-class column sets in the encoding the extractor writes', () => {
    const props = {
      insertColumns: 'b,a',
      insertComplete: false,
      updateColumns: 'c',
      updateComplete: true,
    };
    assert.deepEqual(queryInsertColumns(props), ['a', 'b']);
    assert.equal(queryInsertComplete(props), false);
    assert.deepEqual(queryUpdateColumns(props), ['c']);
    assert.equal(queryUpdateComplete(props), true);
  });

  it('says nothing for an edge that has no such statement, rather than guessing a default', () => {
    assert.equal(queryInsertColumns({ operation: 'select' }), undefined);
    assert.equal(queryInsertComplete({ operation: 'select' }), undefined);
    assert.equal(queryUpdateColumns({}), undefined);
    assert.equal(queryUpdateComplete({}), undefined);
    assert.equal(queryInterpolated({ operation: 'select' }), undefined);
    assert.equal(queryInterpolated({ interpolated: true }), true);
  });
});

describe('property direction, as extract-contracts emits it', () => {
  it('derives request and response from the json pointer', () => {
    assert.equal(
      propertyDirection({ jsonPointer: '/paths/~1pets/get/responses/200/content/schema/id' }),
      'response',
    );
    assert.equal(
      propertyDirection({ jsonPointer: '/paths/~1pets/post/requestBody/content/schema/name' }),
      'request',
    );
    assert.equal(propertyDirection({ jsonPointer: '/components/schemas/Pet/name' }), undefined);
  });

  it('gives no direction to a pointer that only mentions responses or requestBody', () => {
    // The pointers a Zod object with such property names lowers to.
    for (const jsonPointer of [
      '/properties/responses/properties/code',
      '/properties/requestBody/properties/id',
      '/properties/requestBodyLimit',
      '/components/schemas/Page/properties/responses/properties/code',
      '/paths/~1pets/get/parameters/0/schema/properties/responses/properties/code',
    ])
      assert.equal(propertyDirection({ jsonPointer }), undefined, jsonPointer);
  });

  it('an explicit direction wins over the pointer', () => {
    assert.equal(propertyDirection({ direction: 'request', jsonPointer: '/x/responses/200' }), 'request');
  });
});

describe('the PII label is inference, and is priced as such', () => {
  it('an unlabelled provenance is taken at face value', () => {
    assert.equal(piiWeight({ pii: 'email' }), 1);
    assert.equal(piiWeight({ pii: 'email', piiProvenance: 'EXTRACTED' }), 1);
  });

  it('an inferred label is worth its confidence', () => {
    assert.equal(piiWeight({ piiProvenance: 'INFERRED', piiConfidence: 0.7 }), 0.7);
  });

  it('an inferred label with no confidence is worth nothing', () => {
    assert.equal(piiWeight({ piiProvenance: 'INFERRED' }), 0);
  });

  it('an LLM-suggested label is worth nothing', () => {
    assert.equal(piiWeight({ piiProvenance: 'LLM_SUGGESTED', piiConfidence: 1 }), 0);
  });

  const publicRoute = (columnProps: Readonly<Record<string, string | number | boolean>>) =>
    graph({
      nodes: [
        { kind: 'Contract', name: 'api', canonical: 'openapi.api' },
        {
          kind: 'Operation',
          name: 'GET /p',
          canonical: 'openapi.api#get:/p',
          props: { authMode: 'none' },
        },
        { kind: 'RouteHandler', name: 'GET /p', canonical: 'route:GET:/p' },
        { kind: 'Symbol', name: 'getP', canonical: 'src/p.ts#getP' },
        { kind: 'Table', name: 'people', canonical: 'db.public.people' },
        { kind: 'Column', name: 'ssn', canonical: 'db.public.people.ssn', props: columnProps },
      ],
      edges: [
        { kind: 'CONTAINS', src: 'openapi.api', dst: 'openapi.api#get:/p' },
        { kind: 'CONTAINS', src: 'db.public.people', dst: 'db.public.people.ssn' },
        { kind: 'IMPLEMENTED_BY', src: 'openapi.api#get:/p', dst: 'route:GET:/p' },
        { kind: 'HANDLES_ROUTE', src: 'src/p.ts#getP', dst: 'route:GET:/p' },
        { kind: 'QUERIES', src: 'src/p.ts#getP', dst: 'db.public.people', props: { operation: 'select' } },
      ],
    });

  const x6 = (columnProps: Readonly<Record<string, string | number | boolean>>) =>
    runDetectors(publicRoute(columnProps)).findings.find((f) => f.code === 'X6_PII_UNAUTHENTICATED');

  it('a name-guessed PII label cannot on its own produce a critical finding', () => {
    const finding = x6({ type: 'text', pii: 'ssn', piiProvenance: 'INFERRED', piiConfidence: 0.8 });
    assert.ok(finding !== undefined);
    assert.equal(finding.confidence, 0.8);
    assert.equal(finding.severity, 'high', 'a 0.8 guess must not page anyone');
  });

  it('a declared PII label with a certain path does produce a critical finding', () => {
    const finding = x6({ type: 'text', pii: 'ssn', piiProvenance: 'DECLARED' });
    assert.ok(finding !== undefined);
    assert.equal(finding.severity, 'critical');
  });

  it('an LLM-suggested PII label produces nothing at all', () => {
    assert.equal(x6({ type: 'text', pii: 'ssn', piiProvenance: 'LLM_SUGGESTED', piiConfidence: 1 }), undefined);
  });
});
