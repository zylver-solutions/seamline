import assert from 'node:assert/strict';
import test from 'node:test';
import { nodeId } from '@seamline/ontology';
import type { RunRecord, SeamlineNode } from '@seamline/ontology';
import {
  legacyCodeProfile,
  legacyIsFact,
  legacyScopeStatus,
  prepareLegacyImport,
} from './legacy.ts';
import { RedactionError } from '@seamline/security';
import { secretCanary } from '@seamline/security/corpus';
import { CompiledRegistry } from './registry.ts';
import type { Snapshot } from './types.ts';

const legacyFixtureNode: SeamlineNode = {
  id: nodeId('fixture', 'Symbol', 'read'),
  kind: 'Symbol',
  name: 'read',
  sensitivity: 'internal',
  provenance: 'EXTRACTED',
  confidence: 1,
  props: {},
  firstSeenRun: 'r1',
  lastSeenRun: 'r1',
  deletedAt: null,
};
const run: RunRecord = {
  runId: 'r1',
  repo: 'fixture',
  commit: null,
  startedAt: '2026-01-01',
  finishedAt: '2026-01-01',
  ontologyVersion: '1.0.0',
  results: [
    {
      extractor: 'test',
      version: '1',
      status: 'PASS',
      authoritative: [{ scope: 'code.ts', kinds: ['Symbol'] }],
      nodeCount: 1,
      edgeCount: 0,
      durationMs: 0,
      diagnostics: [],
    },
  ],
};

test('only code.import can create, change or delete code records', () => {
  const registry = new CompiledRegistry([legacyCodeProfile]);
  const snapshot = imported();
  const empty = { entities: [], relations: [] };
  assert.throws(
    () => registry.validate(snapshot, empty, 'world.create'),
    /only through code.import/,
  );
  const changed = structuredClone(snapshot);
  changed.entities[0]!.properties['name'] = 'spoofed';
  assert.throws(
    () => registry.validate(changed, snapshot, 'world.update'),
    /only through code.import/,
  );
  assert.throws(
    () => registry.validate(empty, snapshot, 'custom.delete'),
    /only through code.import/,
  );
  registry.validate(snapshot);
  registry.validate(snapshot, empty, 'code.import');
  registry.validate(
    { entities: [...snapshot.entities].reverse(), relations: [] },
    snapshot,
    'custom.noop',
  );
  const statusChanged = structuredClone(snapshot);
  statusChanged.entities.find((e) => e.type === 'code.SourceScope')!.properties['status'] =
    'UNAVAILABLE';
  assert.throws(
    () => registry.validate(statusChanged, snapshot, 'software.record'),
    /only through code.import/,
  );
  const edgeChanged = structuredClone(snapshot);
  edgeChanged.relations.push({
    id: 'spoofed-call',
    type: 'code.CALLS',
    from: legacyFixtureNode.id,
    to: legacyFixtureNode.id,
    properties: {
      provenance: 'EXTRACTED',
      confidence: 1,
      props: {},
      firstSeenRun: 'r1',
      lastSeenRun: 'r1',
      deletedAt: null,
    },
  });
  assert.throws(
    () => registry.validate(edgeChanged, snapshot, 'custom.link'),
    /only through code.import/,
  );
});

test('custom domain relations can refer to immutable imported code', () => {
  const registry = new CompiledRegistry([
    legacyCodeProfile,
    {
      id: 'custom',
      version: '1',
      requires: { code: '1.0.0' },
      types: [],
      commands: [],
      relations: [{ id: 'custom.related', from: ['code.Symbol'], to: ['code.Symbol'], fields: {} }],
    },
  ]);
  const previous = imported();
  const snapshot = structuredClone(previous);
  snapshot.relations.push({
    id: 'custom-link',
    type: 'custom.related',
    from: legacyFixtureNode.id,
    to: legacyFixtureNode.id,
    properties: {},
  });
  registry.validate(snapshot, previous, 'custom.link');
});
function imported(nodes: SeamlineNode[] = [legacyFixtureNode], source = run): Snapshot {
  const registry = new CompiledRegistry([legacyCodeProfile]);
  const before = { entities: [], relations: [] };
  const args = prepareLegacyImport(nodes, [], source);
  registry.validateInput('code.import', args, before);
  const changes = legacyCodeProfile.commands[0]!.apply(
    { snapshot: before, actor: 'test', timeline: 'source', validAt: 1 },
    args,
  );
  const snapshot = {
    entities: [...(changes.putEntities ?? [])],
    relations: [...(changes.putRelations ?? [])],
  };
  registry.validate(snapshot);
  return snapshot;
}
test('imports actual legacy identity and source availability without promoting inference', () => {
  const snapshot = imported([
    { ...legacyFixtureNode, provenance: 'INFERRED', confidence: 0.6, untrusted: true },
  ]);
  const entity = snapshot.entities.find((e) => e.id === legacyFixtureNode.id)!;
  assert.equal(entity.type, 'code.Symbol');
  assert.equal(entity.properties['untrusted'], true);
  assert.equal(legacyIsFact(entity), false);
  assert.equal(legacyScopeStatus(snapshot, 'code.ts'), 'PASS');
  assert.equal(legacyScopeStatus(snapshot, 'missing'), 'UNAVAILABLE');
  const failed = imported([legacyFixtureNode], {
    ...run,
    results: [{ ...run.results[0]!, status: 'UNAVAILABLE' }],
  });
  assert.equal(legacyScopeStatus(failed, 'code.ts'), 'UNAVAILABLE');
  assert.ok(failed.entities.some((e) => e.id === legacyFixtureNode.id));
});
test('redacts secret-bearing free-text metadata and diagnostics before storage', () => {
  const secret = secretCanary('aws-access-key-id/documented-example').secret;
  const source = { ...run, results: [{ ...run.results[0]!, diagnostics: [secret] }] };
  const snapshot = imported(
    [{ ...legacyFixtureNode, props: { token: secret }, sourceRef: 'src/read.ts:3' }],
    source,
  );
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.ok(!JSON.stringify(prepareLegacyImport([legacyFixtureNode], [], source)).includes(secret));
});
test('refuses, rather than rewrites, a credential in an identity or locator field', () => {
  const secret = secretCanary('aws-access-key-id/documented-example').secret;
  const refused = (e: unknown): boolean =>
    e instanceof RedactionError && e.rule === 'aws-access-key-id' && !e.message.includes(secret);
  assert.throws(
    () => imported([{ ...legacyFixtureNode, sourceRef: secret }]),
    (e) => refused(e) && (e as RedactionError).field === 'sourceRef',
  );
  assert.throws(
    () => imported([{ ...legacyFixtureNode, path: `config/${secret}.json` }]),
    (e) => refused(e) && (e as RedactionError).field === 'path',
  );
  assert.throws(
    () => prepareLegacyImport([{ ...legacyFixtureNode, sourceRef: secret }], [], run),
    refused,
  );
});
test('rejects endpoint Cartesian products not allowed by the legacy ontology', () => {
  const registry = new CompiledRegistry([legacyCodeProfile]);
  const snapshot = imported();
  snapshot.relations.push({
    id: 'bad',
    type: 'code.CONTAINS',
    from: legacyFixtureNode.id,
    to: legacyFixtureNode.id,
    properties: {
      provenance: 'EXTRACTED',
      confidence: 1,
      props: {},
      firstSeenRun: 'r1',
      lastSeenRun: 'r1',
      deletedAt: null,
    },
  });
  assert.throws(() => registry.validate(snapshot), /endpoint|range|domain|relation/i);
});
test('rejects nested raw properties instead of bypassing the legacy redactor', () => {
  assert.throws(
    () =>
      imported([
        { ...legacyFixtureNode, props: { nested: { secret: 'value' } } } as unknown as SeamlineNode,
      ]),
    /primitive/,
  );
});
test('a repository snapshot does not remove another repository or application objects', () => {
  const previous = imported();
  previous.entities.push({ ...previous.entities[0]!, id: 'other:Symbol:read' });
  previous.entities.push({ id: 'shot-1', type: 'atelier.Shot', properties: {} });
  const changes = legacyCodeProfile.commands[0]!.apply(
    { snapshot: previous, actor: 'test', timeline: 'source', validAt: 2 },
    prepareLegacyImport([], [], run),
  );
  assert.deepEqual(changes.removeEntities, [legacyFixtureNode.id]);
});
test('direct command calls also redact credentials and reject duplicate identities', () => {
  const secret = secretCanary('aws-access-key-id/documented-example').secret;
  const context = {
    snapshot: { entities: [], relations: [] },
    actor: 'test',
    timeline: 'source',
    validAt: 1,
  };
  const raw = {
    nodes: [{ ...legacyFixtureNode, props: { token: secret } }],
    edges: [],
    run,
  } as unknown as import('./types.ts').Properties;
  const changes = legacyCodeProfile.commands[0]!.apply(context, raw);
  assert.ok(!JSON.stringify(changes).includes(secret));
  assert.throws(
    () =>
      legacyCodeProfile.commands[0]!.apply(
        context,
        prepareLegacyImport([legacyFixtureNode, legacyFixtureNode], [], run),
      ),
    /duplicate/,
  );
});
