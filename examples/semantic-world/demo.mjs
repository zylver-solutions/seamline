/** Run after tsc --build. Local, in-memory, no network/provider calls. */
import {
  CompiledRegistry,
  SemanticEngine,
  builtInProfiles,
} from '../../packages/core/dist/semantic/index.js';

const equipment = {
  id: 'equipment',
  version: '1.0.0',
  requires: { world: '1.0.0' },
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
      input: {
        tool: { required: true, schema: { kind: 'ref', types: ['equipment.Tool'] } },
      },
      apply({ snapshot }, args) {
        const tool = snapshot.entities.find((e) => e.id === args.tool);
        return {
          putEntities: [{ ...tool, properties: { ...tool.properties, condition: 'damaged' } }],
        };
      },
    },
  ],
};
const engine = new SemanticEngine(
  ':memory:',
  new CompiledRegistry([...builtInProfiles, equipment]),
  {
    tenant: 'demo',
    actor: 'local-demo-host',
    authorize: () => true,
  },
);
const scope = { world: 'museum', branch: 'main' };
let revision = 0;
function command(name, args, validAt = 0) {
  const receipt = engine.submit({
    scope,
    expectedRevision: revision,
    commandId: `demo-${revision + 1}`,
    command: name,
    args,
    timeline: 'story',
    validAt,
  });
  revision = receipt.revision;
}
try {
  engine.createUniverse('training');
  engine.createWorld('training', 'museum', [
    { id: 'story', unit: 'second', ticksPerUnit: { numerator: 1, denominator: 1 } },
  ]);
  command('world.create', {
    entities: [
      { id: 'museum', type: 'world.Agent', properties: { label: 'Museum' } },
      { id: 'visitor', type: 'world.Agent', properties: { label: 'Visitor' } },
      { id: 'lobby', type: 'world.Place', properties: { label: 'Lobby' } },
      {
        id: 'guide',
        type: 'equipment.Tool',
        properties: { label: 'Audio guide', condition: 'working' },
      },
    ],
  });
  command('inventory.transferOwnership', { item: 'guide', owner: 'museum' });
  command('inventory.lend', { item: 'guide', recipient: 'visitor' });
  command('world.move', { entity: 'visitor', destination: 'lobby' });
  engine.fork(scope, 'undamaged', revision);
  command('equipment.damage', { tool: 'guide' }, 10);
  const state = engine.snapshot(scope, { unfiltered: true, timeline: 'story', validAt: 10 });
  const earlier = engine.snapshot(scope, { unfiltered: true, timeline: 'story', validAt: 5 });
  const location = engine.query(scope, {
    unfiltered: true,
    timeline: 'story',
    validAt: 10,
    from: ['visitor'],
    via: ['world.placedAt'],
    maxDepth: 3,
    limit: 10,
  });
  console.log(
    JSON.stringify(
      {
        owner: state.snapshot.relations.find((r) => r.type === 'inventory.ownedBy')?.to,
        custodian: state.snapshot.relations.find((r) => r.type === 'inventory.custodyOf')?.to,
        before: earlier.snapshot.entities.find((e) => e.id === 'guide')?.properties.condition,
        after: state.snapshot.entities.find((e) => e.id === 'guide')?.properties.condition,
        locationChain: location.entities.map((e) => e.id),
        lastOperation: engine.history(scope, { limit: 1 })[0],
      },
      null,
      2,
    ),
  );
} finally {
  engine.close();
}
