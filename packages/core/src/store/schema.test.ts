import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SqliteStore } from './sqlite-store.ts';
import {
  META_SCHEMA_VERSION,
  OntologyVersionMismatchError,
  SCHEMA_VERSION,
  SchemaMismatchError,
  applySchema,
  canonicalProps,
  rowToNode,
} from './schema.ts';
import { runRecord } from './testing.ts';

/** A database with the schema applied and one run row, so foreign keys resolve. */
function seeded(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applySchema(db, '1.0.0');
  db.prepare(
    `INSERT INTO runs (run_id, repo, commit_sha, started_at, finished_at, ontology_version)
     VALUES ('r1', 'app', NULL, '2026-01-01T00:00:00.000Z', NULL, '1.0.0')`,
  ).run();
  return db;
}

function insertEdge(db: DatabaseSync, scope: string, src: string, dst: string, kind: string): void {
  db.prepare(
    `INSERT INTO edges (scope, src_id, dst_id, kind, src_file, dst_file, provenance, confidence,
                        source_ref, props, run_id, first_seen_run, last_seen_run, deleted_at)
     VALUES (:scope, :src, :dst, :kind, NULL, NULL, 'EXTRACTED', 1.0, NULL, '{}', 'r1', 'r1', 'r1', NULL)`,
  ).run({ scope, src, dst, kind });
}

test('the edge identity constraint rejects a duplicate in the same scope', () => {
  const db = seeded();
  insertEdge(db, 'code', 'app:File:a.ts', 'app:File:b.ts', 'IMPORTS');
  assert.throws(
    () => insertEdge(db, 'code', 'app:File:a.ts', 'app:File:b.ts', 'IMPORTS'),
    /UNIQUE constraint failed/,
  );
  const count = db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number };
  assert.equal(count.c, 1);
  db.close();
});

test('the same edge asserted by a second scope is a distinct row', () => {
  const db = seeded();
  insertEdge(db, 'code', 'app:File:a.ts', 'app:File:b.ts', 'IMPORTS');
  insertEdge(db, 'bundler', 'app:File:a.ts', 'app:File:b.ts', 'IMPORTS');
  const count = db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number };
  assert.equal(count.c, 2);
  db.close();
});

test('a node kind outside the ontology is rejected by the schema, not by convention', () => {
  const db = seeded();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO nodes (id, repo, kind, name, path, sensitivity, provenance, confidence,
                              source_ref, untrusted, props, run_id, first_seen_run, last_seen_run, deleted_at)
           VALUES ('app:Widget:x', 'app', 'Widget', 'x', NULL, 'internal', 'EXTRACTED', 1.0,
                   NULL, 0, '{}', 'r1', 'r1', 'r1', NULL)`,
        )
        .run(),
    /CHECK constraint failed/,
  );
  db.close();
});

test('a non-numeric confidence is rejected by the STRICT table', () => {
  const db = seeded();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO nodes (id, repo, kind, name, path, sensitivity, provenance, confidence,
                              source_ref, untrusted, props, run_id, first_seen_run, last_seen_run, deleted_at)
           VALUES ('app:File:x', 'app', 'File', 'x', NULL, 'internal', 'EXTRACTED', 'high',
                   NULL, 0, '{}', 'r1', 'r1', 'r1', NULL)`,
        )
        .run(),
    /cannot store TEXT value in REAL column/,
  );
  db.close();
});

test('a row whose run was never begun is rejected by the foreign key', () => {
  const db = seeded();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO edges (scope, src_id, dst_id, kind, src_file, dst_file, provenance, confidence,
                              source_ref, props, run_id, first_seen_run, last_seen_run, deleted_at)
           VALUES ('code', 'app:File:a.ts', 'app:File:b.ts', 'IMPORTS', NULL, NULL, 'EXTRACTED', 1.0,
                   NULL, '{}', 'ghost-run', 'ghost-run', 'ghost-run', NULL)`,
        )
        .run(),
    /FOREIGN KEY constraint failed/,
  );
  db.close();
});

test('a graph stamped with a different schema version is refused, not read', () => {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  db.prepare('UPDATE meta SET value = :v WHERE key = :k').run({
    v: String(SCHEMA_VERSION + 41),
    k: META_SCHEMA_VERSION,
  });
  assert.throws(() => applySchema(db), (error: unknown) => {
    assert.ok(error instanceof SchemaMismatchError);
    assert.equal(error.found, SCHEMA_VERSION + 41);
    assert.equal(error.expected, SCHEMA_VERSION);
    return true;
  });
  db.close();
});

test('a run declaring a different ontology version is refused', async () => {
  const store = new SqliteStore({ ontologyVersion: '1.0.0' });
  await store.beginRun(runRecord('r1', { ontologyVersion: '1.0.0' }));
  await assert.rejects(
    store.beginRun(runRecord('r2', { ontologyVersion: '2.0.0' })),
    (error: unknown) => {
      assert.ok(error instanceof OntologyVersionMismatchError);
      assert.equal(error.found, '1.0.0');
      assert.equal(error.expected, '2.0.0');
      return true;
    },
  );
  await store.close();
});

test('canonicalProps serializes two key orderings to the same bytes', () => {
  assert.equal(
    canonicalProps({ b: 2, a: 1, c: null }),
    canonicalProps({ c: null, a: 1, b: 2 }),
  );
  assert.equal(canonicalProps({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test('rowToNode omits absent optional fields rather than setting them undefined', () => {
  const node = rowToNode({
    id: 'app:File:a.ts',
    repo: 'app',
    kind: 'File',
    name: 'a.ts',
    path: null,
    sensitivity: 'internal',
    provenance: 'EXTRACTED',
    confidence: 1,
    source_ref: null,
    untrusted: 0,
    props: '{}',
    run_id: 'r1',
    first_seen_run: 'r1',
    last_seen_run: 'r1',
    deleted_at: null,
  });
  assert.equal('path' in node, false);
  assert.equal('sourceRef' in node, false);
  assert.equal('untrusted' in node, false);
  assert.deepEqual(Object.keys(node).sort(), [
    'confidence',
    'deletedAt',
    'firstSeenRun',
    'id',
    'kind',
    'lastSeenRun',
    'name',
    'props',
    'provenance',
    'sensitivity',
  ]);
});
