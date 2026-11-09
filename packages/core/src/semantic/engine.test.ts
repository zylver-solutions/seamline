import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SemanticEngine } from './engine.ts';
import { CompiledRegistry } from './registry.ts';
import { builtInProfiles } from './packs.ts';
import type { Access, Entity, ExportPolicy, Profile, Properties, Submission } from './types.ts';

const access: Access = { tenant: 'test', actor: 'operator', authorize: () => true };
const timeline = { id: 'story', unit: 'second', ticksPerUnit: { numerator: 1, denominator: 1 } };
const semanticTestScope = { world: 'town', branch: 'main' };
const equipment: Profile = {
  id: 'equipment',
  version: '1.0.0',
  requires: { world: '1.0.0', inventory: '1.0.0' },
  types: [
    {
      id: 'equipment.Tool',
      facets: ['world.locatable', 'world.ownable', 'world.described'],
      fields: {
        condition: { required: true, schema: { kind: 'string', enum: ['working', 'damaged'] } },
      },
    },
  ],
  relations: [],
  commands: [
    {
      id: 'equipment.damage',
      version: '1',
      input: { tool: { required: true, schema: { kind: 'ref', types: ['equipment.Tool'] } } },
      apply({ snapshot }, args) {
        const tool = snapshot.entities.find((e) => e.id === args['tool'])!;
        return {
          putEntities: [{ ...tool, properties: { ...tool.properties, condition: 'damaged' } }],
        };
      },
    },
    {
      id: 'equipment.erase',
      version: '1',
      input: { id: { required: true, schema: { kind: 'string' } } },
      apply(_context, args) {
        return { removeEntities: [args['id'] as string] };
      },
    },
    {
      id: 'equipment.eraseRelation',
      version: '1',
      input: { id: { required: true, schema: { kind: 'string' } } },
      apply(_context, args) {
        return { removeRelations: [args['id'] as string] };
      },
    },
    {
      id: 'equipment.fail',
      version: '1',
      input: {},
      apply() {
        return {
          putEntities: [{ id: 'bad', type: 'world.Agent', properties: { label: 'A' } }],
          putRelations: [
            { id: 'dangling', type: 'world.placedAt', from: 'bad', to: 'absent', properties: {} },
          ],
        };
      },
    },
  ],
};
const registry = () => new CompiledRegistry([...builtInProfiles, equipment]);
const entities: Entity[] = [
  { id: 'owner', type: 'world.Agent', properties: { label: 'Owner' } },
  { id: 'borrower', type: 'world.Agent', properties: { label: 'Borrower' } },
  { id: 'lobby', type: 'world.Place', properties: { label: 'Lobby' } },
  { id: 'portico', type: 'world.Place', properties: { label: 'Portico' } },
  {
    id: 'tool',
    type: 'equipment.Tool',
    properties: { label: 'Audio guide', condition: 'working' },
  },
];

function fixture(test: (engine: SemanticEngine, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'semantic-engine-'));
  const path = join(dir, 'world.sqlite');
  const engine = new SemanticEngine(path, registry(), access);
  try {
    engine.createUniverse('universe');
    engine.createWorld('universe', 'town', [timeline]);
    test(engine, path);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
function request(
  engine: SemanticEngine,
  command: string,
  args: Properties,
  at = 0,
  overrides: Partial<Submission> = {},
): Submission {
  const head = engine.snapshot(semanticTestScope, {
    unfiltered: true,
    timeline: 'story',
    validAt: at,
  }).revision;
  return {
    scope: semanticTestScope,
    command,
    args,
    validAt: at,
    timeline: 'story',
    expectedRevision: head,
    commandId: `cmd-${head + 1}`,
    ...overrides,
  };
}
function run(
  engine: SemanticEngine,
  command: string,
  args: Properties,
  at = 0,
  overrides: Partial<Submission> = {},
) {
  return engine.submit(request(engine, command, args, at, overrides));
}
function seed(engine: SemanticEngine) {
  run(engine, 'world.create', { entities: entities as unknown as Properties['entities'] });
}

describe('durable semantic engine', () => {
  it('refuses pre-barrier storage whose completely deleted history cannot be recovered', () =>
    fixture((_engine, path) => {
      const old = new DatabaseSync(path);
      try {
        old.exec('UPDATE semantic_meta SET version=1');
      } finally {
        old.close();
      }
      assert.throws(
        () => new SemanticEngine(path, registry(), access),
        /Unsupported semantic storage version/,
      );
    }));

  it('retains a later deletion when applying an explicitly bounded earlier correction', () =>
    fixture((engine) => {
      seed(engine);
      run(engine, 'equipment.erase', { id: 'tool' }, 10);
      const at = (time: number) =>
        engine.snapshot(semanticTestScope, { unfiltered: true, timeline: 'story', validAt: time });
      assert.throws(
        () => run(engine, 'equipment.damage', { tool: 'tool' }, 5),
        /later change or deletion/,
      );
      assert.equal(at(20).revision, 2);
      assert.equal(
        at(20).snapshot.entities.some((entity) => entity.id === 'tool'),
        false,
      );
      run(engine, 'equipment.damage', { tool: 'tool' }, 5, { validUntil: 10 });
      assert.equal(
        at(7).snapshot.entities.find((entity) => entity.id === 'tool')?.properties['condition'],
        'damaged',
      );
      assert.equal(
        at(10).snapshot.entities.some((entity) => entity.id === 'tool'),
        false,
      );
      assert.equal(
        engine
          .snapshot(semanticTestScope, {
            unfiltered: true,
            timeline: 'story',
            validAt: 7,
            revision: 2,
          })
          .snapshot.entities.find((entity) => entity.id === 'tool')?.properties['condition'],
        'working',
      );
    }));

  it('retains complete deletions across pinned forks and reopening without blocking a bounded repair', () =>
    fixture((engine, path) => {
      seed(engine);
      run(engine, 'equipment.erase', { id: 'tool' }, 0);
      engine.fork(semanticTestScope, 'deleted', 2);
      const reopened = new SemanticEngine(path, registry(), access);
      const tool = entities.find((entity) => entity.id === 'tool')!;
      const args = { entities: [tool] as unknown as Properties['entities'] };
      try {
        for (const branch of ['main', 'deleted']) {
          const target = { world: 'town', branch };
          const head = reopened.snapshot(target, {
            unfiltered: true,
            timeline: 'story',
            validAt: 5,
          }).revision;
          const req = request(reopened, 'world.create', args, -5, {
            scope: target,
            expectedRevision: head,
            commandId: `repair-${branch}`,
          });
          assert.throws(() => reopened.submit(req), /later change or deletion/);
          assert.equal(
            reopened.snapshot(target, { unfiltered: true, timeline: 'story', validAt: 5 }).revision,
            head,
          );
          reopened.submit({ ...req, validUntil: 0 });
          assert.equal(
            reopened
              .snapshot(target, { unfiltered: true, timeline: 'story', validAt: -3 })
              .snapshot.entities.some((entity) => entity.id === 'tool'),
            true,
          );
          assert.equal(
            reopened
              .snapshot(target, { unfiltered: true, timeline: 'story', validAt: 5 })
              .snapshot.entities.some((entity) => entity.id === 'tool'),
            false,
          );
        }
      } finally {
        reopened.close();
      }
    }));

  it('retains relationship deletion barriers and permits correction ending exactly at deletion', () =>
    fixture((engine) => {
      run(engine, 'world.create', { entities: entities as unknown as Properties['entities'] }, -10);
      run(engine, 'world.move', { entity: 'tool', destination: 'lobby' }, 0);
      const placed = engine.snapshot(semanticTestScope, {
        unfiltered: true,
        timeline: 'story',
        validAt: 0,
      }).snapshot.relations[0]!;
      run(engine, 'equipment.eraseRelation', { id: placed.id }, 0);
      assert.throws(
        () => run(engine, 'world.move', { entity: 'tool', destination: 'lobby' }, -5),
        /later change or deletion/,
      );
      run(engine, 'world.move', { entity: 'tool', destination: 'lobby' }, -5, { validUntil: 0 });
      assert.equal(
        engine.snapshot(semanticTestScope, { unfiltered: true, timeline: 'story', validAt: -3 })
          .snapshot.relations.length,
        1,
      );
      assert.equal(
        engine.snapshot(semanticTestScope, { unfiltered: true, timeline: 'story', validAt: 5 })
          .snapshot.relations.length,
        0,
      );
      // An explicit new operation at the deleted boundary is allowed.
      run(engine, 'world.move', { entity: 'tool', destination: 'lobby' }, 0);
      assert.equal(
        engine.snapshot(semanticTestScope, { unfiltered: true, timeline: 'story', validAt: 5 })
          .snapshot.relations.length,
        1,
      );
    }));

  it('persists generic custom domain state, custody, placement and original receipts across reopening', () =>
    fixture((engine, path) => {
      seed(engine);
      run(engine, 'inventory.transferOwnership', { item: 'tool', owner: 'owner' });
      run(engine, 'inventory.lend', { item: 'tool', recipient: 'borrower' });
      run(engine, 'world.move', { entity: 'borrower', destination: 'lobby' });
      run(engine, 'equipment.damage', { tool: 'tool' }, 5);
      const req = request(engine, 'world.move', { entity: 'borrower', destination: 'portico' }, 10);
      const receipt = engine.submit(req);
      const reopened = new SemanticEngine(path, registry(), access);
      try {
        const snap = reopened.snapshot(semanticTestScope, {
          unfiltered: true,
          timeline: 'story',
          validAt: 10,
        });
        assert.equal(
          snap.snapshot.entities.find((e) => e.id === 'tool')?.properties['condition'],
          'damaged',
        );
        assert.equal(
          snap.snapshot.relations.find((r) => r.type === 'inventory.ownedBy')?.to,
          'owner',
        );
        assert.equal(
          snap.snapshot.relations.find((r) => r.type === 'inventory.custodyOf')?.to,
          'borrower',
        );
        assert.equal(
          snap.snapshot.relations.find((r) => r.type === 'world.placedAt' && r.from === 'borrower')
            ?.to,
          'portico',
        );
        assert.deepEqual(reopened.submit(req), receipt);
        const history = reopened.history(semanticTestScope, { limit: 2 });
        assert.equal(history.length, 2);
        assert.equal(history[0]?.command, 'world.move');
        assert.equal(history[0]?.previousRevision, receipt.revision - 1);
        assert.equal(history[0]?.actor, 'operator');
        assert.equal(Object.hasOwn(history[0]!, 'args'), false);
        assert.throws(
          () => reopened.submit({ ...req, args: { ...req.args, destination: 'lobby' } }),
          /different payload/,
        );
      } finally {
        reopened.close();
      }
    }));

  it('forks pin parent revision and do not inherit later corrections', () =>
    fixture((engine) => {
      seed(engine);
      engine.fork(semanticTestScope, 'alternate', 1);
      run(engine, 'equipment.damage', { tool: 'tool' }, 0);
      assert.equal(
        engine
          .snapshot(
            { ...semanticTestScope, branch: 'alternate' },
            { unfiltered: true, timeline: 'story', validAt: 100 },
          )
          .snapshot.entities.find((e) => e.id === 'tool')?.properties['condition'],
        'working',
      );
      assert.equal(
        engine
          .snapshot(semanticTestScope, {
            unfiltered: true,
            revision: 1,
            timeline: 'story',
            validAt: 100,
          })
          .snapshot.entities.find((e) => e.id === 'tool')?.properties['condition'],
        'working',
      );
      assert.equal(
        engine
          .snapshot(semanticTestScope, { unfiltered: true, timeline: 'story', validAt: 0 })
          .snapshot.entities.find((e) => e.id === 'tool')?.properties['condition'],
        'damaged',
      );
    }));

  it('finite corrections use half-open intervals and preserve recorded historical views', () =>
    fixture((engine) => {
      seed(engine);
      run(engine, 'equipment.damage', { tool: 'tool' }, 5, { validUntil: 10 });
      const condition = (at: number, rev?: number) =>
        engine
          .snapshot(semanticTestScope, {
            unfiltered: true,
            timeline: 'story',
            validAt: at,
            ...(rev === undefined ? {} : { revision: rev }),
          })
          .snapshot.entities.find((e) => e.id === 'tool')?.properties['condition'];
      assert.equal(condition(4), 'working');
      assert.equal(condition(5), 'damaged');
      assert.equal(condition(9), 'damaged');
      assert.equal(condition(10), 'working');
      assert.equal(condition(6, 1), 'working');
    }));

  it('rolls back failed multi-record writes, heads, identities and idempotency receipts', () =>
    fixture((engine) => {
      const invalid = request(engine, 'equipment.fail', {});
      assert.throws(() => engine.submit(invalid));
      assert.deepEqual(
        engine.snapshot(semanticTestScope, { unfiltered: true, timeline: 'story', validAt: 0 }),
        {
          revision: 0,
          snapshot: { entities: [], relations: [] },
        },
      );
      const valid = {
        ...invalid,
        command: 'world.create',
        args: { entities: [{ id: 'bad', type: 'world.Place', properties: { label: 'Safe' } }] },
      };
      assert.equal(engine.submit(valid).revision, 1);
    }));

  it('two database handles cannot consume the same last unit and retries do not consume twice', () =>
    fixture((engine, path) => {
      run(engine, 'inventory.createStock', {
        id: 'water',
        label: 'Water',
        commodity: 'water',
        unit: 'bottle',
        quantity: '1',
      });
      const other = new SemanticEngine(path, registry(), access);
      try {
        const first = request(engine, 'inventory.consume', { stock: 'water', quantity: '1' });
        const competing = { ...first, commandId: 'competing' };
        const receipt = engine.submit(first);
        assert.throws(() => other.submit(competing), /Revision conflict/);
        assert.deepEqual(other.submit(first), receipt);
        assert.equal(
          other.snapshot(semanticTestScope, { unfiltered: true, timeline: 'story', validAt: 0 })
            .snapshot.entities[0]?.properties['quantity'],
          '0',
        );
      } finally {
        other.close();
      }
    }));

  it('rejects retroactive changes that overwrite later accepted effects', () =>
    fixture((engine) => {
      run(engine, 'inventory.createStock', {
        id: 'water',
        label: 'Water',
        commodity: 'water',
        unit: 'bottle',
        quantity: '10',
      });
      run(engine, 'inventory.consume', { stock: 'water', quantity: '1' }, 10);
      assert.throws(
        () => run(engine, 'inventory.consume', { stock: 'water', quantity: '1' }, 5),
        /later change/,
      );
      const state = engine.snapshot(semanticTestScope, {
        unfiltered: true,
        timeline: 'story',
        validAt: 20,
      });
      assert.equal(state.revision, 2);
      assert.equal(state.snapshot.entities[0]?.properties['quantity'], '9');
    }));

  it('validates constraints at future boundaries, not only at command time', () =>
    fixture((engine) => {
      seed(engine);
      run(engine, 'world.move', { entity: 'owner', destination: 'lobby' }, 10);
      assert.throws(
        () =>
          run(
            engine,
            'world.relate',
            {
              relations: [
                {
                  id: 'second',
                  type: 'world.placedAt',
                  from: 'owner',
                  to: 'portico',
                  properties: {},
                },
              ],
            },
            5,
          ),
        /exclusive/i,
      );
      assert.equal(
        engine.snapshot(semanticTestScope, { unfiltered: true, timeline: 'story', validAt: 20 })
          .revision,
        2,
      );
    }));

  it('retains identity category and type after deletion, across branches and timelines', () =>
    fixture((engine) => {
      seed(engine);
      run(engine, 'equipment.erase', { id: 'tool' });
      assert.throws(
        () =>
          run(engine, 'world.create', {
            entities: [{ id: 'tool', type: 'world.Place', properties: { label: 'Different' } }],
          }),
        /identity/i,
      );
      engine.fork(semanticTestScope, 'alternate', 1);
      assert.throws(
        () =>
          run(engine, 'world.relate', {
            relations: [
              {
                id: 'tool',
                type: 'world.relatedTo',
                from: 'owner',
                to: 'borrower',
                properties: { meaning: 'friend' },
              },
            ],
          }),
        /identity/i,
      );
    }));

  it('isolates tenants, worlds and timeline selections', () =>
    fixture((engine, path) => {
      seed(engine);
      engine.createWorld('universe', 'other', [timeline]);
      assert.equal(
        engine.snapshot(
          { world: 'other', branch: 'main' },
          { unfiltered: true, timeline: 'story', validAt: 0 },
        ).snapshot.entities.length,
        0,
      );
      assert.throws(
        () =>
          engine.snapshot(semanticTestScope, {
            unfiltered: true,
            timeline: 'other-clock',
            validAt: 0,
          }),
        /timeline/,
      );
      const outsider = new SemanticEngine(path, registry(), { ...access, tenant: 'outsider' });
      try {
        assert.throws(
          () =>
            outsider.snapshot(semanticTestScope, {
              unfiltered: true,
              timeline: 'story',
              validAt: 0,
            }),
          /world/,
        );
      } finally {
        outsider.close();
      }
    }));

  it('fails closed for denied and asynchronous authorization callbacks', () =>
    fixture((_engine, path) => {
      for (const authorize of [
        () => false,
        (async () => false) as unknown as Access['authorize'],
      ]) {
        const denied = new SemanticEngine(path, registry(), { ...access, authorize });
        try {
          assert.throws(() => denied.createUniverse('denied'), /Unauthorized/);
          assert.throws(
            () =>
              denied.snapshot(semanticTestScope, {
                unfiltered: true,
                timeline: 'story',
                validAt: 0,
              }),
            /Unauthorized/,
          );
        } finally {
          denied.close();
        }
      }
    }));

  it('bounds traversal work/results and does not expose mutable storage handles', () =>
    fixture((engine) => {
      seed(engine);
      run(engine, 'world.move', { entity: 'owner', destination: 'lobby' });
      const result = engine.query(semanticTestScope, {
        unfiltered: true,
        timeline: 'story',
        validAt: 0,
        from: ['owner'],
        via: ['world.placedAt'],
        maxDepth: 2,
        limit: 1,
      });
      assert.equal(result.entities.length, 1);
      assert.equal(result.truncated, true);
      const bounded = engine.query(semanticTestScope, {
        unfiltered: true,
        timeline: 'story',
        validAt: 0,
        from: ['owner'],
        via: ['world.placedAt'],
        maxDepth: 2,
        limit: 10,
        maxSteps: 1,
      });
      assert.equal(bounded.truncated, true);
      assert.equal(bounded.steps, 1);
      result.entities[0]!.properties['label'] = 'mutated';
      assert.equal(
        engine
          .snapshot(semanticTestScope, { unfiltered: true, timeline: 'story', validAt: 0 })
          .snapshot.entities.find((e) => e.id === 'owner')?.properties['label'],
        'Owner',
      );
    }));

  it('requires explicit validated export policy and removes unallowed fields/endpoints', () =>
    fixture((engine) => {
      seed(engine);
      const query = { timeline: 'story', validAt: 0 };
      assert.throws(
        () => engine.exportSnapshot(semanticTestScope, query, undefined as unknown as ExportPolicy),
        /allowlist/,
      );
      assert.throws(
        () =>
          engine.exportSnapshot(semanticTestScope, query, {
            types: ['world.Agent'],
            fields: { 'world.Agent': 'label' },
          } as unknown as ExportPolicy),
        /allowlist/,
      );
      const result = engine.exportSnapshot(semanticTestScope, query, {
        types: ['world.Agent'],
        fields: { 'world.Agent': [] },
      });
      assert.equal(result.snapshot.entities.length, 2);
      assert.deepEqual(result.snapshot.entities[0]!.properties, {});
      assert.equal(result.snapshot.relations.length, 0);
    }));

  it('rejects incompatible profile reinterpretation on reopen', () =>
    fixture((_engine, path) => {
      const changed = { ...equipment, version: '2.0.0' };
      const other = new SemanticEngine(
        path,
        new CompiledRegistry([...builtInProfiles, changed]),
        access,
      );
      try {
        assert.throws(
          () =>
            other.snapshot(semanticTestScope, { unfiltered: true, timeline: 'story', validAt: 0 }),
          /fingerprint/,
        );
      } finally {
        other.close();
      }
    }));
});
