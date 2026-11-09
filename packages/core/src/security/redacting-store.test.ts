/**
 * ADR-0011: the Redactor is the sole writer to the store. These tests prove
 * the property against a real `SqliteStore`, not a fake -- the thing that
 * actually persists is what matters, and `packages/security` already covers
 * the transform itself in isolation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteStore } from '../store/sqlite-store.ts';
import { extractorResult, fixedClock, makeEdge, makeNode, runRecord, scope } from '../store/testing.ts';
import { wrapWithRedaction } from './redacting-store.ts';
import { RedactionError } from '@seamline/security';
import { secretCanary } from '@seamline/security/corpus';

const RUN = 'r1';
const CANARY = secretCanary('aws-access-key-id/documented-example').secret; // AWS's own documentation example key id.
const CANARY_REF = '«redacted:sha256:6f728d6e»'; // The reference the redactor derives for that canary (pinned in packages/security).

function store(): SqliteStore {
  return new SqliteStore({ ontologyVersion: '1.0.0', now: fixedClock() });
}

test('a secret in a node prop never reaches the wrapped store', async () => {
  const inner = store();
  const wrapped = wrapWithRedaction(inner);
  const node = makeNode({ name: 'src/config.ts', props: { databaseUrl: `postgres://x:${CANARY}@host/db` } });

  await wrapped.beginRun(runRecord(RUN));
  await wrapped.upsertNodes(RUN, [node]);

  const stored = wrapped.node(node.id);
  assert.ok(stored, 'the node was still written, just redacted');
  const url = String(stored.props['databaseUrl']);
  assert.ok(!url.includes(CANARY), `stored prop still contains the raw secret: ${url}`);
  assert.ok(url.includes(CANARY_REF), 'the redacted reference replaces it, not a bare mask');
});

test('a secret in an edge prop never reaches the wrapped store', async () => {
  const inner = store();
  const wrapped = wrapWithRedaction(inner);
  const a = makeNode({ name: 'src/a.ts' });
  const b = makeNode({ name: 'src/b.ts' });
  const edge = makeEdge({ src: a.id, dst: b.id, kind: 'IMPORTS', props: { note: `token=${CANARY}` } });

  await wrapped.beginRun(runRecord(RUN));
  await wrapped.upsertNodes(RUN, [a, b]);
  await wrapped.upsertEdges(RUN, 'code.ts', [edge]);

  const [stored] = wrapped.edgesFrom(a.id);
  assert.ok(stored);
  const note = String(stored.props['note']);
  assert.ok(!note.includes(CANARY), `stored edge prop still contains the raw secret: ${note}`);
});

test('bypassing the wrapper and writing to the raw store directly lands the secret -- this is why production code must never hold a raw store reference', async () => {
  const inner = store();
  const node = makeNode({ name: 'src/config.ts', props: { databaseUrl: `postgres://x:${CANARY}@host/db` } });

  // Deliberately calling `inner`, not `wrapped`: this is the bypass.
  await inner.beginRun(runRecord(RUN));
  await inner.upsertNodes(RUN, [node]);

  const stored = inner.node(node.id);
  assert.ok(stored);
  assert.ok(
    String(stored.props['databaseUrl']).includes(CANARY),
    'the raw store has no redaction of its own -- going around the wrapper really does defeat the control, ' +
      'which is exactly why ADR-0011 wires wrapWithRedaction() at the one production construction site instead ' +
      'of trusting every caller to remember it',
  );
});

// Real repository paths the entropy heuristic used to hash when they were a
// node id, a `path`, a `sourceRef`, or an edge's `srcFile`/`dstFile`.
const LONG_PATHS = [
  'docs/adr/ADR-0012-extensible-semantic-foundation.md',
  'examples/harbor-books/db/migrations/0014_orders_shipping.sql',
  'packages/extract-data/src/__fixtures__/sql-migrations/db/migrations/10_tighten.sql',
];

test('a long repository path is stored as given: as a node id, a path, a sourceRef and an edge file', async () => {
  const inner = store();
  const wrapped = wrapWithRedaction(inner);
  const nodes = LONG_PATHS.map((p) => makeNode({ name: p, path: p, sourceRef: `${p}:3` }));
  const edges = LONG_PATHS.map((p, i) =>
    makeEdge({
      src: nodes[i]!.id,
      dst: nodes[(i + 1) % nodes.length]!.id,
      kind: 'IMPORTS',
      srcFile: p,
      dstFile: LONG_PATHS[(i + 1) % LONG_PATHS.length]!,
    }),
  );

  await wrapped.beginRun(runRecord(RUN));
  await wrapped.upsertNodes(RUN, nodes);
  await wrapped.upsertEdges(RUN, 'code.ts', edges);

  for (const [i, p] of LONG_PATHS.entries()) {
    const stored = wrapped.node(nodes[i]!.id);
    assert.ok(stored, `the node keeps its id ${String(nodes[i]!.id)}`);
    assert.equal(stored.id, nodes[i]!.id);
    assert.equal(stored.name, p);
    assert.equal(stored.path, p);
    assert.equal(stored.sourceRef, `${p}:3`);
    const [edge] = wrapped.edgesFrom(nodes[i]!.id);
    assert.ok(edge, 'the edge resolves from the unchanged id');
    assert.equal(edge.srcFile, p);
    assert.equal(edge.dstFile, LONG_PATHS[(i + 1) % LONG_PATHS.length]);
  }
  assert.equal(wrapped.redactionReport().totalFindings, 0, 'no rule fired on a repository path');
});

test('a credential in a node id is refused, and nothing from that call reaches the store', async () => {
  const inner = store();
  const wrapped = wrapWithRedaction(inner);
  const dirtyNode = makeNode({ name: CANARY });
  const clean = makeNode({ name: 'src/clean.ts' });

  await wrapped.beginRun(runRecord(RUN));
  await assert.rejects(
    wrapped.upsertNodes(RUN, [clean, dirtyNode]),
    (e: unknown) =>
      e instanceof RedactionError &&
      e.rule === 'aws-access-key-id' &&
      e.field === 'id.canonicalName' &&
      !e.message.includes(CANARY),
  );
  assert.deepEqual(
    inner.nodesByKind('File'),
    [],
    'not even the clean node of the refused batch was written',
  );
  assert.equal(
    inner.node(dirtyNode.id),
    undefined,
    'the id was not stored under a rewritten name either',
  );
});

test('a credential in an edge endpoint or file is refused, and the edge is not stored', async () => {
  const inner = store();
  const wrapped = wrapWithRedaction(inner);
  const a = makeNode({ name: 'src/a.ts' });
  const b = makeNode({ name: 'src/b.ts' });

  await wrapped.beginRun(runRecord(RUN));
  await wrapped.upsertNodes(RUN, [a, b]);
  await assert.rejects(
    wrapped.upsertEdges(RUN, 'code.ts', [
      makeEdge({ src: a.id, dst: b.id, kind: 'IMPORTS', srcFile: `config/${CANARY}.json` }),
    ]),
    (e: unknown) =>
      e instanceof RedactionError && e.field === 'srcFile' && !e.message.includes(CANARY),
  );
  assert.deepEqual(inner.edgesFrom(a.id), []);
});

test('redacting the same secret twice produces the same reference (idempotent, deterministic)', async () => {
  const inner = store();
  const wrapped = wrapWithRedaction(inner);
  const a = makeNode({ name: 'src/a.ts', props: { key: CANARY } });
  const b = makeNode({ name: 'src/b.ts', props: { key: CANARY } });

  await wrapped.beginRun(runRecord(RUN));
  await wrapped.upsertNodes(RUN, [a, b]);

  const refA = String(wrapped.node(a.id)?.props['key']);
  const refB = String(wrapped.node(b.id)?.props['key']);
  assert.equal(refA, refB, 'same secret, same reference, so "the same credential is in nine places" stays visible');
  assert.equal(refA, CANARY_REF);
});

test('reads and non-write lifecycle methods pass through to the inner store untouched', async () => {
  const inner = store();
  const wrapped = wrapWithRedaction(inner);
  const a = makeNode({ name: 'src/a.ts' });
  const b = makeNode({ name: 'src/b.ts' });

  await wrapped.beginRun(runRecord(RUN));
  await wrapped.upsertNodes(RUN, [a, b]);
  await wrapped.upsertEdges(RUN, 'code.ts', [makeEdge({ src: a.id, dst: b.id, kind: 'IMPORTS' })]);
  await wrapped.finalizeRun(RUN, [
    extractorResult('ts', 'PASS', [scope('code.ts', ['File'])], { nodeCount: 2, edgeCount: 1 }),
  ]);

  assert.deepEqual(wrapped.nodesByKind('File').map((n) => n.id).sort(), inner.nodesByKind('File').map((n) => n.id).sort());
  assert.equal(wrapped.scopeStatus('code.ts'), inner.scopeStatus('code.ts'));
  const traversed = await wrapped.traverse({ from: [a.id], via: ['IMPORTS'], maxDepth: 1 });
  assert.equal(traversed.known, true);

  await wrapped.close();
});
