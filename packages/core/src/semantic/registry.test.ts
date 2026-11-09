import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneValue, CompiledRegistry } from './registry.ts';
import type { Field, Profile, Snapshot } from './types.ts';

const text: Field = { schema: { kind: 'string' }, required: true };
const base = (): Profile => ({
  id: 'base',
  version: '1.0.0',
  requires: {},
  facets: [{ id: 'base.named', fields: { label: text } }],
  types: [{ id: 'base.Person', facets: ['base.named'], fields: {} }],
  relations: [],
  commands: [],
});
const equipment = (): Profile => ({
  id: 'equipment',
  version: '1.0.0',
  requires: { base: '1.0.0' },
  facets: [
    {
      id: 'equipment.maintainable',
      facets: ['base.named'],
      fields: {
        condition: { schema: { kind: 'string', enum: ['ready', 'broken'] }, required: true },
      },
    },
  ],
  types: [
    {
      id: 'equipment.Tool',
      facets: ['equipment.maintainable'],
      fields: {
        owner: { schema: { kind: 'ref', types: ['base.Person'] }, required: true },
        note: { schema: { kind: 'string' }, uncertain: true, nullable: true },
        metadata: {
          schema: {
            kind: 'record',
            fields: { count: { schema: { kind: 'integer', min: 0, max: 5 }, required: true } },
          },
        },
      },
    },
  ],
  relations: [
    {
      id: 'equipment.contains',
      from: ['base.named'],
      to: ['base.named'],
      fields: {},
      exclusive: 'to',
      acyclic: true,
    },
  ],
  commands: [
    {
      id: 'equipment.repair',
      version: '1',
      input: {
        tool: { schema: { kind: 'ref', types: ['equipment.maintainable'] }, required: true },
      },
      apply: () => ({}),
    },
  ],
});
const snapshot = (): Snapshot => ({
  entities: [
    { id: 'alice', type: 'base.Person', properties: { label: 'Alice' } },
    {
      id: 'drill',
      type: 'equipment.Tool',
      properties: { label: 'Drill', condition: 'ready', owner: 'alice' },
    },
  ],
  relations: [],
});

test('custom domain composes recursive facets and validates properties and references', () => {
  const registry = new CompiledRegistry([equipment(), base()]);
  registry.validate(snapshot());
  assert.deepEqual(registry.type('equipment.Tool').facets, [
    'base.named',
    'equipment.maintainable',
  ]);
  registry.validateInput('equipment.repair', { tool: 'drill' }, snapshot());
  assert.throws(
    () => registry.validateInput('equipment.repair', { tool: 'alice' }, snapshot()),
    /invalid reference/,
  );
  const state = snapshot();
  state.entities[1]!.properties.owner = 'missing';
  assert.throws(() => registry.validate(state), /invalid reference/);
  state.entities[1]!.properties.owner = 'drill';
  assert.throws(() => registry.validate(state), /invalid reference/);
  state.entities[1]!.properties.owner = 'alice';
  delete state.entities[1]!.properties.label;
  assert.throws(() => registry.validate(state), /label required/);
});

test('profile fingerprints ignore registration order and pin implementations and versions', () => {
  const a = new CompiledRegistry([base(), equipment()]);
  const b = new CompiledRegistry([equipment(), base()]);
  assert.equal(a.fingerprint, b.fingerprint);
  const changed = equipment();
  changed.commands = [{ ...changed.commands[0]!, apply: () => ({ removeEntities: ['drill'] }) }];
  assert.notEqual(a.fingerprint, new CompiledRegistry([base(), changed]).fingerprint);
  changed.commands = [{ ...equipment().commands[0]!, version: '2' }];
  assert.notEqual(a.fingerprint, new CompiledRegistry([base(), changed]).fingerprint);
  const description = a.descriptor() as { id: string }[];
  description[0]!.id = 'changed';
  assert.equal((a.descriptor() as { id: string }[])[0]!.id, 'base');
});

test('input profiles and returned definitions cannot alter compiled semantics', () => {
  const p = base();
  const registry = new CompiledRegistry([p]);
  (p.facets![0]!.fields.label as Field).required = false;
  assert.throws(
    () =>
      registry.validate({
        entities: [{ id: 'alice', type: 'base.Person', properties: {} }],
        relations: [],
      }),
    /required/,
  );
  assert.throws(() => {
    (registry.type('base.Person').fields.label as Field).required = false;
  }, TypeError);
});

test('composition rejects absent dependencies, version mismatches, transitive implicit imports and cycles', () => {
  assert.throws(() => new CompiledRegistry([]), /profiles/);
  assert.throws(() => new CompiledRegistry([equipment()]), /dependency/);
  const wrong = equipment();
  wrong.requires = { base: '2' };
  assert.throws(() => new CompiledRegistry([base(), wrong]), /dependency/);
  const cyclic = base();
  cyclic.requires = { equipment: '1.0.0' };
  assert.throws(() => new CompiledRegistry([cyclic, equipment()]), /cycle/);
  const third: Profile = {
    id: 'third',
    version: '1',
    requires: { equipment: '1.0.0' },
    types: [
      { id: 'third.Test', fields: { person: { schema: { kind: 'ref', types: ['base.Person'] } } } },
    ],
    relations: [],
    commands: [],
  };
  assert.throws(() => new CompiledRegistry([base(), equipment(), third]), /undeclared/);
});

test('composition rejects definition collisions, foreign namespaces and malformed schemas', () => {
  assert.throws(() => new CompiledRegistry([base(), base()]), /duplicate/);
  const bad = base();
  bad.types = [...bad.types, ...bad.types];
  assert.throws(() => new CompiledRegistry([bad]), /collision/);
  const foreign = base();
  foreign.types = [{ id: 'other.Type', fields: {} }];
  assert.throws(() => new CompiledRegistry([foreign]), /namespace/);
  for (const schema of [
    { kind: 'integer', min: 5, max: 2 },
    { kind: 'list', items: { kind: 'string' }, maxItems: -1 },
    { kind: 'string', enum: [] },
    { kind: 'wat' },
    { kind: 'string', ignored: true },
  ]) {
    const invalid = base();
    invalid.types = [{ id: 'base.Bad', fields: { value: { schema } as Field } }];
    assert.throws(() => new CompiledRegistry([invalid]));
  }
  const facetCycle = base();
  facetCycle.facets = [{ id: 'base.named', facets: ['base.named'], fields: {} }];
  assert.throws(() => new CompiledRegistry([facetCycle]), /cycle/);
  const conflicting = base();
  conflicting.types = [
    {
      id: 'base.Person',
      facets: ['base.named'],
      fields: { label: { schema: { kind: 'boolean' } } },
    },
  ];
  assert.throws(() => new CompiledRegistry([conflicting]), /incompatible field/);
});

test('unknown, null and nested field validation retain distinct meaning', () => {
  const registry = new CompiledRegistry([base(), equipment()]);
  const state = snapshot();
  for (const note of [
    null,
    { $state: 'unknown' },
    { $state: 'unavailable', reason: 'source failed' },
    'visible',
  ]) {
    state.entities[1]!.properties.note = note;
    registry.validate(state);
  }
  state.entities[1]!.properties.note = { $state: 'invented' };
  assert.throws(() => registry.validate(state), /uncertainty/);
  delete state.entities[1]!.properties.note;
  state.entities[1]!.properties.metadata = { count: 2 };
  registry.validate(state);
  state.entities[1]!.properties.metadata = { count: 2.5 };
  assert.throws(() => registry.validate(state), /invalid number/);
  state.entities[1]!.properties.metadata = { count: 2, hidden: true };
  assert.throws(() => registry.validate(state), /unknown field/);
});

test('relationships enforce inherited facet signatures, exclusivity and acyclic placement', () => {
  const registry = new CompiledRegistry([base(), equipment()]);
  const state = snapshot();
  state.relations = [
    { id: 'inside', type: 'equipment.contains', from: 'alice', to: 'drill', properties: {} },
  ];
  registry.validate(state);
  state.relations.push({
    id: 'duplicate',
    type: 'equipment.contains',
    from: 'alice',
    to: 'drill',
    properties: {},
  });
  assert.throws(() => registry.validate(state), /exclusive/);
  state.relations.pop();
  state.relations.push({
    id: 'reverse',
    type: 'equipment.contains',
    from: 'drill',
    to: 'alice',
    properties: {},
  });
  assert.throws(() => registry.validate(state), /cycle/);
  state.relations = [
    { id: 'dangling', type: 'equipment.contains', from: 'alice', to: 'missing', properties: {} },
  ];
  assert.throws(() => registry.validate(state), /endpoints/);
});

test('invariants receive detached frozen current/previous states and command identity', () => {
  let received = '';
  const profile = base();
  profile.invariants = [
    {
      id: 'base.onlyAdmin',
      version: '1',
      check(next, previous, command) {
        if (previous) {
          received = command ?? '';
          assert.throws(() => {
            next.entities[0]!.properties.label = 'tamper';
          }, TypeError);
          assert.throws(() => {
            previous.entities.pop();
          }, TypeError);
          if (command !== 'base.allowed') throw new Error('denied transition');
        }
      },
    },
  ];
  const registry = new CompiledRegistry([profile]);
  const state: Snapshot = {
    entities: [{ id: 'alice', type: 'base.Person', properties: { label: 'Alice' } }],
    relations: [],
  };
  registry.validate(state, state, 'base.allowed');
  assert.equal(received, 'base.allowed');
  assert.equal(state.entities[0]!.properties.label, 'Alice');
  assert.throws(() => registry.validate(state, state, 'base.other'), /denied transition/);
});

test('strict value cloning rejects lossy coercions, getters, cycles and sparse arrays', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    new Map(),
    [undefined],
    Array(1),
    cycle,
    {
      get value() {
        throw new Error('getter executed');
      },
    },
    JSON.parse('{"__proto__":{}}'),
  ]) {
    assert.throws(() => cloneValue(value));
  }
  const original = { values: [1, false, null, 'x'] };
  const copy = cloneValue(original);
  copy.values.push(2);
  assert.equal(original.values.length, 4);
});

test('entity budgets and unknown snapshot fields are rejected', () => {
  const registry = new CompiledRegistry([base()]);
  const entities = Array.from({ length: 2001 }, (_, i) => ({
    id: `e${i}`,
    type: 'base.Person',
    properties: { label: `${i}` },
  }));
  assert.throws(() => registry.validate({ entities, relations: [] }), /budget/);
  assert.throws(
    () => registry.validate({ entities: [], relations: [], ignored: true } as Snapshot),
    /unknown field/,
  );
});
