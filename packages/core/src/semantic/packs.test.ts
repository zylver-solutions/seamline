import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompiledRegistry } from './registry.ts';
import {
  authoringProfile,
  builtInProfiles,
  inventoryProfile,
  softwareProfile,
  stockQuantity,
  worldProfile,
} from './packs.ts';
import type { Entity, Profile, Properties, Snapshot } from './types.ts';

const agent = (id: string): Entity => ({ id, type: 'world.Agent', properties: { label: id } });
const item = (id: string): Entity => ({ id, type: 'world.Object', properties: { label: id } });
const stock = (id: string, quantity: string, unit = 'piece'): Entity => ({
  id,
  type: 'inventory.Stock',
  properties: { label: id, commodity: 'battery', unit, quantity },
});
function execute(
  registry: CompiledRegistry,
  snapshot: Snapshot,
  id: string,
  args: Properties,
): Snapshot {
  registry.validateInput(id, args, snapshot);
  const changes = registry
    .command(id)
    .apply(
      { snapshot: structuredClone(snapshot), actor: 'test-host', timeline: 'story', validAt: 0 },
      args,
    );
  const entityMap = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  const relationMap = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  for (const removed of changes.removeEntities ?? []) entityMap.delete(removed);
  for (const removed of changes.removeRelations ?? []) relationMap.delete(removed);
  for (const entity of changes.putEntities ?? []) entityMap.set(entity.id, entity);
  for (const relation of changes.putRelations ?? []) relationMap.set(relation.id, relation);
  const next = { entities: [...entityMap.values()], relations: [...relationMap.values()] };
  registry.validate(next, snapshot, id);
  return next;
}

test('all built-in packs compose and software works without physical-world imports', () => {
  new CompiledRegistry(builtInProfiles).validate({ entities: [], relations: [] });
  const registry = new CompiledRegistry([softwareProfile]);
  const entities: Entity[] = [
    {
      id: 'commit-1',
      type: 'software.SourceRevision',
      properties: { repository: 'repo', revision: 'abc123' },
    },
    {
      id: 'build-1',
      type: 'software.Build',
      properties: { source: 'commit-1', status: 'passed', toolchain: 'node-22' },
    },
    {
      id: 'artifact-1',
      type: 'software.Artifact',
      properties: { label: 'service', sourceRevision: 'abc123', digest: 'sha256:123' },
    },
    { id: 'production', type: 'software.Environment', properties: { label: 'production' } },
    {
      id: 'deploy-1',
      type: 'software.Deployment',
      properties: { artifact: 'artifact-1', environment: 'production', status: 'active' },
    },
    {
      id: 'incident-1',
      type: 'software.Incident',
      properties: { label: 'failure', deployment: 'deploy-1', evidence: 'log-record-123' },
    },
  ];
  const snapshot = execute(registry, { entities: [], relations: [] }, 'software.record', {
    entities: entities as unknown as Properties['entities'],
    relations: [
      {
        id: 'output',
        type: 'software.produces',
        from: 'build-1',
        to: 'artifact-1',
        properties: {},
      },
    ],
  });
  assert.equal(
    snapshot.entities.find((entity) => entity.id === 'deploy-1')?.properties['artifact'],
    'artifact-1',
  );
  assert.equal(snapshot.relations[0]?.from, 'build-1');
  assert.throws(
    () =>
      execute(registry, snapshot, 'software.record', {
        entities: [entities[0]!] as unknown as Properties['entities'],
      }),
    /already exists/,
  );
});

test('lending retains ownership and placement, clears old equipment, and requires custody for new equipment', () => {
  const registry = new CompiledRegistry([worldProfile, inventoryProfile]);
  let snapshot: Snapshot = {
    entities: [
      agent('calder'),
      agent('sage'),
      item('jacket'),
      { id: 'room', type: 'world.Place', properties: { label: 'room' } },
    ],
    relations: [],
  };
  snapshot = execute(registry, snapshot, 'world.move', { entity: 'jacket', destination: 'room' });
  snapshot = execute(registry, snapshot, 'inventory.transferOwnership', {
    item: 'jacket',
    owner: 'calder',
  });
  snapshot = execute(registry, snapshot, 'inventory.lend', { item: 'jacket', recipient: 'calder' });
  snapshot = execute(registry, snapshot, 'inventory.equip', {
    item: 'jacket',
    wearer: 'calder',
    slot: 'outerwear',
  });
  snapshot = execute(registry, snapshot, 'inventory.lend', { item: 'jacket', recipient: 'sage' });
  assert.equal(
    snapshot.relations.find((relation) => relation.type === 'inventory.ownedBy')?.to,
    'calder',
  );
  assert.equal(
    snapshot.relations.find((relation) => relation.type === 'world.placedAt')?.to,
    'room',
  );
  assert.equal(
    snapshot.relations.find((relation) => relation.type === 'inventory.custodyOf')?.to,
    'sage',
  );
  assert.equal(
    snapshot.relations.filter((relation) => relation.type === 'inventory.equippedBy').length,
    0,
  );
  assert.throws(
    () =>
      execute(registry, snapshot, 'inventory.equip', {
        item: 'jacket',
        wearer: 'calder',
        slot: 'outerwear',
      }),
    /custody/,
  );
  snapshot = execute(registry, snapshot, 'inventory.equip', {
    item: 'jacket',
    wearer: 'sage',
    slot: 'outerwear',
  });
  assert.equal(
    snapshot.relations.find((relation) => relation.type === 'inventory.equippedBy')?.to,
    'sage',
  );
});

test('placement rejects transitive containment cycles and accepts third-party facet composition', () => {
  const equipment: Profile = {
    id: 'workshop',
    version: '1.0.0',
    requires: { world: '1.0.0', inventory: '1.0.0' },
    types: [
      {
        id: 'workshop.Equipment',
        facets: ['world.locatable', 'world.ownable'],
        fields: {
          serial: { required: true, schema: { kind: 'string' } },
          condition: { required: true, schema: { kind: 'string', enum: ['working', 'damaged'] } },
        },
      },
    ],
    relations: [],
    commands: [
      {
        id: 'workshop.damage',
        version: '1',
        input: { item: { required: true, schema: { kind: 'ref', types: ['workshop.Equipment'] } } },
        apply({ snapshot }, args) {
          const target = snapshot.entities.find((entity) => entity.id === args['item'])!;
          return {
            putEntities: [
              { ...target, properties: { ...target.properties, condition: 'damaged' } },
            ],
          };
        },
      },
    ],
  };
  const registry = new CompiledRegistry([worldProfile, inventoryProfile, equipment]);
  let snapshot: Snapshot = {
    entities: [agent('owner'), item('bag-a'), item('bag-b')],
    relations: [],
  };
  snapshot = execute(registry, snapshot, 'world.move', { entity: 'bag-a', destination: 'bag-b' });
  assert.throws(
    () => execute(registry, snapshot, 'world.move', { entity: 'bag-b', destination: 'bag-a' }),
    /cycle/,
  );
  snapshot = execute(registry, snapshot, 'world.create', {
    entities: [
      {
        id: 'drill',
        type: 'workshop.Equipment',
        properties: { serial: 'd-1', condition: 'working' },
      },
    ],
  });
  snapshot = execute(registry, snapshot, 'world.move', { entity: 'drill', destination: 'bag-a' });
  snapshot = execute(registry, snapshot, 'inventory.transferOwnership', {
    item: 'drill',
    owner: 'owner',
  });
  snapshot = execute(registry, snapshot, 'workshop.damage', { item: 'drill' });
  assert.equal(
    snapshot.entities.find((entity) => entity.id === 'drill')?.properties['condition'],
    'damaged',
  );
  assert.equal(
    snapshot.relations.find((relation) => relation.type === 'inventory.ownedBy')?.from,
    'drill',
  );
});

test('exact stock transfers conserve large quantities and reservations restrict availability', () => {
  const registry = new CompiledRegistry([worldProfile, inventoryProfile]);
  let snapshot: Snapshot = { entities: [agent('holder')], relations: [] };
  for (const entity of [stock('a', '900719925474099300000'), stock('b', '0')])
    snapshot = execute(registry, snapshot, 'inventory.createStock', {
      id: entity.id,
      ...entity.properties,
    });
  snapshot = execute(registry, snapshot, 'inventory.transferStock', {
    from: 'a',
    to: 'b',
    quantity: '900719925474099299999',
  });
  assert.equal(snapshot.entities.find((entity) => entity.id === 'a')?.properties['quantity'], '1');
  assert.equal(
    snapshot.entities.find((entity) => entity.id === 'b')?.properties['quantity'],
    '900719925474099299999',
  );
  snapshot = execute(registry, snapshot, 'inventory.reserve', {
    id: 'reservation',
    stock: 'a',
    holder: 'holder',
    quantity: '1',
  });
  assert.throws(
    () => execute(registry, snapshot, 'inventory.consume', { stock: 'a', quantity: '1' }),
    /insufficient/,
  );
  assert.throws(
    () =>
      execute(registry, snapshot, 'inventory.reserve', {
        id: 'second',
        stock: 'a',
        holder: 'holder',
        quantity: '1',
      }),
    /insufficient/,
  );
  snapshot = execute(registry, snapshot, 'inventory.release', { reservation: 'reservation' });
  snapshot = execute(registry, snapshot, 'inventory.consume', { stock: 'a', quantity: '1' });
  assert.equal(snapshot.entities.find((entity) => entity.id === 'a')?.properties['quantity'], '0');
  assert.equal(
    snapshot.entities.some((entity) => entity.id === 'reservation'),
    false,
  );
});

test('generic creation and custom reducers cannot bypass the stock operation boundary', () => {
  const registry = new CompiledRegistry([worldProfile, inventoryProfile]);
  const before: Snapshot = { entities: [agent('holder'), stock('a', '1')], relations: [] };
  assert.throws(
    () =>
      execute(registry, before, 'world.create', {
        entities: [stock('b', '50')] as unknown as Properties['entities'],
      }),
    /stock conservation/,
  );
  assert.throws(
    () =>
      registry.validate(
        { ...before, entities: [agent('holder'), stock('a', '900')] },
        before,
        'custom.mint',
      ),
    /stock conservation/,
  );
  assert.throws(
    () => registry.validate({ ...before, entities: [agent('holder')] }, before, 'custom.delete'),
    /stock conservation/,
  );
  for (const quantity of ['-1', '01', '1.0', '1e3', '9'.repeat(79)])
    assert.throws(() => stockQuantity(quantity), /quantity/);
  assert.throws(() => stockQuantity(1), /quantity/);
  assert.throws(
    () => execute(registry, before, 'inventory.consume', { stock: 'a', quantity: '0' }),
    /positive/,
  );
  const mismatched: Snapshot = {
    entities: [stock('a', '1'), stock('b', '0', 'gram')],
    relations: [],
  };
  assert.throws(
    () =>
      execute(registry, mismatched, 'inventory.transferStock', {
        from: 'a',
        to: 'b',
        quantity: '1',
      }),
    /unit/,
  );
});

test('world generic input is validated against final domain definitions', () => {
  const registry = new CompiledRegistry([worldProfile]);
  const empty: Snapshot = { entities: [], relations: [] };
  assert.throws(
    () =>
      execute(registry, empty, 'world.create', {
        entities: [
          { id: 'bad', type: 'world.Object', properties: { label: 'bad', invented: true } },
        ],
      }),
    /unknown field/,
  );
  assert.throws(
    () =>
      execute(registry, empty, 'world.create', {
        entities: [{ id: 'bad', type: 'unknown.Type', properties: {} }],
      }),
    /unknown type/,
  );
  assert.throws(
    () =>
      execute(registry, empty, 'world.create', {
        entities: [{ id: 'bad', type: 'world.Object', properties: [] }],
      }),
    /properties object/,
  );
});

test('authoring keeps story structure optional and edit placements independently reuse one take', () => {
  const registry = new CompiledRegistry([worldProfile, authoringProfile]);
  const entities: Entity[] = [
    item('jacket'),
    { id: 'story', type: 'authoring.Story', properties: { title: 'A quiet walk' } },
    {
      id: 'scene',
      type: 'authoring.Scene',
      properties: {
        label: 'Arrival',
        snapshot: { world: 'town', branch: 'main', revision: 42, timeline: 'story', validAt: 21 },
      },
    },
    {
      id: 'shot',
      type: 'authoring.Shot',
      properties: {
        label: 'Insert',
        scene: 'scene',
        subjects: ['jacket'],
        detailRequirements: ['clasp'],
      },
    },
    {
      id: 'take',
      type: 'authoring.Take',
      properties: {
        shot: 'shot',
        artifact: 'video:1',
        recipeVersion: '1',
        verification: 'unverified',
      },
    },
    ...['edit-a', 'edit-b'].map((id, index) => ({
      id,
      type: 'authoring.EditPlacement',
      properties: {
        take: 'take',
        timeline: id,
        start: index * 200,
        duration: 100,
        ticksNumerator: 30000,
        ticksDenominator: 1001,
      },
    })),
  ];
  registry.validate({ entities, relations: [] });
  assert.equal(entities.filter((entity) => entity.type === 'authoring.EditPlacement').length, 2);
  assert.equal(
    entities.find((entity) => entity.id === 'take')?.properties['verification'],
    'unverified',
  );
});

test('pose updates use stable identity and honor coordinate frame dimensions', () => {
  const registry = new CompiledRegistry([worldProfile]);
  let snapshot: Snapshot = {
    entities: [
      item('object'),
      {
        id: 'frame',
        type: 'world.CoordinateFrame',
        properties: { label: 'room', unit: 'meter', dimensions: 3 },
      },
    ],
    relations: [],
  };
  assert.throws(
    () =>
      execute(registry, snapshot, 'world.setPose', {
        subject: 'object',
        frame: 'frame',
        x: 0,
        y: 1,
      }),
    /dimensions/,
  );
  snapshot = execute(registry, snapshot, 'world.setPose', {
    subject: 'object',
    frame: 'frame',
    x: 0,
    y: 1,
    z: 2,
  });
  const poseId = snapshot.entities.find((entity) => entity.type === 'world.Pose')!.id;
  snapshot = execute(registry, snapshot, 'world.setPose', {
    subject: 'object',
    frame: 'frame',
    x: 10,
    y: 11,
    z: 12,
  });
  assert.equal(snapshot.entities.filter((entity) => entity.type === 'world.Pose').length, 1);
  assert.equal(snapshot.entities.find((entity) => entity.id === poseId)?.properties['x'], 10);
});

test('third-party stock splitting composes while custom minting violates conservation', () => {
  const extension: Profile = {
    id: 'warehouse',
    version: '1.0.0',
    requires: { inventory: '1.0.0' },
    types: [],
    relations: [],
    commands: [
      {
        id: 'warehouse.split',
        version: '1',
        input: {},
        apply({ snapshot }) {
          const source = snapshot.entities.find((entity) => entity.id === 'source')!;
          return {
            putEntities: [
              { ...source, properties: { ...source.properties, quantity: '6' } },
              { ...source, id: 'split', properties: { ...source.properties, quantity: '4' } },
            ],
          };
        },
      },
      {
        id: 'warehouse.mint',
        version: '1',
        input: {},
        apply({ snapshot }) {
          const source = snapshot.entities.find((entity) => entity.id === 'source')!;
          return {
            putEntities: [{ ...source, properties: { ...source.properties, quantity: '11' } }],
          };
        },
      },
    ],
  };
  const registry = new CompiledRegistry([worldProfile, inventoryProfile, extension]);
  const before = { entities: [stock('source', '10')], relations: [] };
  const after = execute(registry, before, 'warehouse.split', {});
  assert.equal(
    after.entities.find((entity) => entity.id === 'source')?.properties['quantity'],
    '6',
  );
  assert.equal(after.entities.find((entity) => entity.id === 'split')?.properties['quantity'], '4');
  assert.throws(() => execute(registry, before, 'warehouse.mint', {}), /stock conservation/);
});

test('stock operations reject finite intervals that would silently reverse economic effects', () => {
  const registry = new CompiledRegistry([worldProfile, inventoryProfile]);
  const snapshot: Snapshot = {
    entities: [
      agent('holder'),
      stock('source', '10'),
      stock('target', '0'),
      {
        id: 'reservation',
        type: 'inventory.Reservation',
        properties: { stock: 'source', holder: 'holder', quantity: '1' },
      },
    ],
    relations: [],
  };
  const calls: [string, Properties][] = [
    [
      'inventory.createStock',
      { id: 'new', label: 'new', commodity: 'battery', unit: 'piece', quantity: '1' },
    ],
    ['inventory.consume', { stock: 'source', quantity: '1' }],
    ['inventory.transferStock', { from: 'source', to: 'target', quantity: '1' }],
    [
      'inventory.reserve',
      { id: 'new-reservation', stock: 'source', holder: 'holder', quantity: '1' },
    ],
    ['inventory.release', { reservation: 'reservation' }],
  ];
  for (const [command, args] of calls) {
    registry.validateInput(command, args, snapshot);
    assert.throws(
      () =>
        registry
          .command(command)
          .apply({ snapshot, actor: 'host', timeline: 'world', validAt: 5, validUntil: 10 }, args),
      /unbounded interval/,
      command,
    );
  }
});
