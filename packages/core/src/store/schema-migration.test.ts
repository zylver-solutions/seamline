import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applySchema, OntologyVersionMismatchError, SCHEMA_VERSION, StoreError } from './schema.ts';
import { SelectorError } from './selector-error.ts';
import { SqliteStore } from './sqlite-store.ts';
import { extractorResult, makeNode, runRecord, scope } from './testing.ts';

const legacyDdl = readFileSync(new URL('./__fixtures__/schema-v1.sql.txt', import.meta.url), 'utf8');
const origin = JSON.parse(readFileSync(new URL('./__fixtures__/schema-v1-origin.json', import.meta.url), 'utf8')) as { sha256: string };

function legacyDb(path = ':memory:'): DatabaseSync {
  assert.equal(createHash('sha256').update(legacyDdl).digest('hex'), origin.sha256);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys = ON; ${legacyDdl}`);
  db.exec(`INSERT INTO meta VALUES ('schema_version', '1'), ('ontology_version', '1.0.0');
    INSERT INTO runs VALUES (3, 'r1', 'app', 'commit', 'start', 'finish', '1.0.0');
    INSERT INTO runs VALUES (8, 'r2', 'app', NULL, 'next-start', NULL, '1.0.0');
    INSERT INTO extractor_results VALUES ('r1', 'extract', '0.0.1', 'PASS', 2, 1, 0, '[]');
    INSERT INTO authoritative_scopes VALUES ('r1', 'extract', 'z', '["File"]', '**/*.ts');
    INSERT INTO authoritative_scopes VALUES ('r1', 'extract', 'a', '[]', 'COLUMN_TO_PROPERTY');
    INSERT INTO nodes VALUES ('app:File:a.ts', 'app', 'File', 'display', 'a.ts', 'internal',
      'EXTRACTED', 1, NULL, 0, '{}', 'r1', 'r1', 'r1', NULL);
    INSERT INTO nodes VALUES ('app:File:b.ts', 'app', 'File', 'retired', 'b.ts', 'internal',
      'EXTRACTED', 1, NULL, 0, '{}', 'r1', 'r1', 'r1', 'r2');
    INSERT INTO edges VALUES ('z', 'app:File:a.ts', 'app:File:b.ts', 'IMPORTS', 'a.ts', 'b.ts',
      'EXTRACTED', 1, NULL, '{}', 'r1', 'r1', 'r1', 'r2');`);
  return db;
}

function snapshot(db: DatabaseSync): unknown {
  return ['meta', 'runs', 'extractor_results', 'authoritative_scopes', 'nodes', 'edges']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

test('v1 migration preserves facts, run order, lifecycle stamps and deterministic legacy claims', () => {
  const db = legacyDb();
  try {
    const before = snapshot(db) as unknown[];
    applySchema(db, '1.0.0');
    const after = snapshot(db) as unknown[];
    for (const index of [1, 2, 4, 5]) assert.deepEqual(after[index], before[index]);
    assert.deepEqual(after[3], []);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.['value'], String(SCHEMA_VERSION));
    assert.deepEqual(db.prepare('SELECT claim_index, scope, kinds, selector FROM authority_claims_v2 ORDER BY claim_index').all().map(row => ({ ...row })), [
      { claim_index: 0, scope: 'a', kinds: '[]', selector: 'COLUMN_TO_PROPERTY' },
      { claim_index: 1, scope: 'z', kinds: '["File"]', selector: '**/*.ts' },
    ]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const state = snapshot(db);
    applySchema(db, '1.0.0');
    assert.deepEqual(snapshot(db), state);
    assert.throws(() => db.exec("INSERT INTO authoritative_scopes VALUES ('r1','extract','x','[]',NULL)"), /CHECK constraint failed/);
    assert.throws(() => db.exec("DELETE FROM extractor_results WHERE run_id = 'r1'"), /FOREIGN KEY constraint failed/);
    assert.throws(() => db.exec("INSERT INTO authority_claims_v2 VALUES ('r1','extract',-1,'x','[]',NULL)"), /CHECK constraint failed/);
    assert.throws(() => db.exec("INSERT INTO authority_claims_v2 VALUES ('r1','missing',0,'x','[]',NULL)"), /FOREIGN KEY constraint failed/);
  } finally { db.close(); }
});

test('failed legacy validation and ontology reconciliation roll back every migration write', () => {
  for (const variant of ['invalid-path', 'canonical-label', 'bad-kinds', 'ontology'] as const) {
    const db = legacyDb();
    try {
      if (variant === 'invalid-path') db.exec("UPDATE authoritative_scopes SET selector = '../outside' WHERE scope = 'z'");
      if (variant === 'canonical-label') db.exec("UPDATE authoritative_scopes SET selector = '/@canonical/v1/00' WHERE scope = 'a'");
      if (variant === 'bad-kinds') db.exec("UPDATE authoritative_scopes SET kinds = '[\"Widget\"]' WHERE scope = 'z'");
      const before = snapshot(db);
      const ddl = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
      assert.throws(() => applySchema(db, variant === 'ontology' ? '2.0.0' : '1.0.0'), (error: unknown) => {
        if (variant === 'invalid-path') {
          assert.ok(error instanceof SelectorError);
          assert.equal(error.selector, '../outside');
          assert.equal(error.message, 'invalid authoritative-scope selector "../outside": pattern "../outside" has a `..` segment');
        } else if (variant === 'ontology') {
          assert.ok(error instanceof OntologyVersionMismatchError);
          assert.equal(error.found, '1.0.0');
          assert.equal(error.expected, '2.0.0');
        } else {
          assert.ok(error instanceof StoreError);
          assert.equal(error.message, variant === 'canonical-label'
            ? 'version 1 cannot certify canonical authority'
            : 'invalid legacy authority kinds');
        }
        return true;
      });
      assert.deepEqual(snapshot(db), before);
      assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), ddl);
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.['value'], '1');
    } finally { db.close(); }
  }
});

test('migration validation retains its statement across garbage collection', () => {
  const names = [
    'v1 migration preserves facts, run order, lifecycle stamps and deterministic legacy claims',
    'failed legacy validation and ontology reconciliation roll back every migration write',
  ];
  // The child forces collection between native iterator steps without retaining
  // the statement itself. It runs the real migration and rollback assertions.
  const preload = `
    import { StatementSync } from 'node:sqlite';
    import { after } from 'node:test';
    if (typeof globalThis.gc !== 'function') {
      throw new Error('--expose-gc did not reach the migration child process; the garbage-collection check cannot run');
    }
    const original = StatementSync.prototype.iterate;
    let steps = 0;
    StatementSync.prototype.iterate = function (...args) {
      const iterator = Reflect.apply(original, this, args);
      return {
        [Symbol.iterator]() { return this; },
        next() { steps++; globalThis.gc(); return iterator.next(); },
        return() { return typeof iterator.return === 'function' ? iterator.return() : { done: true }; },
      };
    };
    after(() => {
      StatementSync.prototype.iterate = original;
      console.log('MIGRATION_GC_STEPS=' + steps);
    });
  `;
  // The child runs this file directly rather than through `node --test`. Node
  // 24 forwards only an allow-list of flags to the runner's per-file subprocess,
  // which drops --expose-gc, whereas Node 22 forwards everything. Running the
  // file in the process that received the flag works on both. The name filter
  // keeps the child from selecting this test and recursing.
  const childEnv = { ...process.env };
  delete childEnv['NODE_TEST_CONTEXT'];
  const child = spawnSync(process.execPath, [
    '--expose-gc', '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    '--test-reporter=tap', `--test-name-pattern=^(?:${names.join('|')})$`,
    fileURLToPath(import.meta.url),
  ], { env: childEnv, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, shell: false });
  const output = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
  assert.equal(child.error, undefined, output);
  assert.equal(child.signal, null, output);
  assert.equal(child.status, 0, output);
  for (const name of names) {
    assert.ok(output.split('\n').some(line => /^ok \d+ - /u.test(line) && line.slice(line.indexOf(' - ') + 3) === name), output);
  }
  assert.match(output, /# fail 0\b/u);
  assert.match(output, /# cancelled 0\b/u);
  assert.ok([...output.matchAll(/MIGRATION_GC_STEPS=(\d+)/gu)].some(match => Number(match[1]) > 0), output);
});

test('version-2 open refuses a removed, writable or populated legacy guard', () => {
  for (const variant of ['missing', 'writable', 'populated'] as const) {
    const db = legacyDb();
    try {
      applySchema(db);
      if (variant === 'populated') {
        db.exec("PRAGMA ignore_check_constraints = ON; INSERT INTO authoritative_scopes VALUES ('r1','extract','x','[]',NULL); PRAGMA ignore_check_constraints = OFF;");
      } else {
        db.exec('DROP TABLE authoritative_scopes');
        if (variant === 'writable') db.exec(legacyDdl);
      }
      const ddl = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
      assert.throws(() => applySchema(db), /intact authoritative_scopes|guard must be empty/);
      assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), ddl);
    } finally { db.close(); }
  }
});

test('future and unversioned stores are refused before any DDL is adopted', () => {
  const db = legacyDb();
  try {
    db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'; DROP TABLE edges;");
    const ddl = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
    assert.throws(() => applySchema(db), /schema version 99/);
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), ddl);
    db.exec("DELETE FROM meta WHERE key = 'schema_version'");
    assert.throws(() => applySchema(db), /unversioned graph/);
    assert.deepEqual(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), ddl);
  } finally { db.close(); }
});

test('same-scope claims preserve result order after reopen and are all replaced on retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seamline-migration-'));
  const path = join(dir, 'graph.sqlite');
  let store: SqliteStore | undefined;
  try {
    const legacy = legacyDb(path);
    legacy.close();
    store = new SqliteStore({ path, ontologyVersion: '1.0.0' });
    assert.equal(store.scopeStatus('z'), 'PASS');
    assert.deepEqual((await store.getRun('r1'))?.results[0]?.authoritative.map(claim => claim.scope), ['a', 'z']);
    await store.beginRun(runRecord('r3'));
    const claims = [scope('code', ['Symbol'], 'z.ts'), scope('code', ['File'], 'a.ts')];
    await store.finalizeRun('r3', [extractorResult('code', 'PASS', claims)]);
    assert.deepEqual((await store.getRun('r3'))?.results[0]?.authoritative, claims);
    await store.close();
    store = new SqliteStore({ path });
    assert.deepEqual((await store.getRun('r3'))?.results[0]?.authoritative, claims);
    await store.restartRun(runRecord('r3'));
    assert.equal(store.scopeStatus('code'), 'UNAVAILABLE');
    const node = makeNode({ name: 'kept', kind: 'Symbol', path: 'z.ts' });
    await store.upsertNodes('r3', [node]);
    const replacement = [scope('code', ['Symbol'], 'z.ts')];
    await store.finalizeRun('r3', [extractorResult('code', 'PASS', replacement)]);
    assert.deepEqual((await store.getRun('r3'))?.results[0]?.authoritative, replacement);
    assert.equal(store.node(node.id)?.deletedAt, null);
  } finally {
    await store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
