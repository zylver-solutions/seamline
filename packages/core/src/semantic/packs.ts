/** Reusable, trusted domain packs. Applications compose these rather than own another world store. */
import type {
  Changes,
  Entity,
  Field,
  Profile,
  Properties,
  Relation,
  Snapshot,
  Value,
} from './types.ts';

const text: Field = { schema: { kind: 'string' }, required: true };
const optionalText: Field = { schema: { kind: 'string' } };
const ref = (...types: string[]): Field => ({ schema: { kind: 'ref', types }, required: true });
const natural: Field = { schema: { kind: 'integer', min: 0 }, required: true };
const json: Field = { schema: { kind: 'json' }, required: true };
const strings = (...values: string[]): Field => ({
  schema: { kind: 'string', enum: values },
  required: true,
});
const entityInput: Field = {
  required: true,
  schema: {
    kind: 'list',
    maxItems: 100,
    items: {
      kind: 'record',
      fields: { id: text, type: text, properties: json },
    },
  },
};
const relationInput: Field = {
  required: true,
  schema: {
    kind: 'list',
    maxItems: 100,
    items: {
      kind: 'record',
      fields: { id: text, type: text, from: text, to: text, properties: json },
    },
  },
};

function object(value: Value | undefined): Properties {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected properties object');
  return value;
}
function string(value: Value | undefined): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('expected nonempty string');
  return value;
}
function lookup(snapshot: Snapshot, id: string, type?: string): Entity {
  const entity = snapshot.entities.find((candidate) => candidate.id === id);
  if (!entity || (type !== undefined && entity.type !== type))
    throw new Error(`missing ${type ?? 'entity'}: ${id}`);
  return entity;
}
function fresh(snapshot: Snapshot, id: string): void {
  if (
    snapshot.entities.some((entity) => entity.id === id) ||
    snapshot.relations.some((relation) => relation.id === id)
  )
    throw new Error(`identity already exists: ${id}`);
}
function entities(value: Value | undefined): Entity[] {
  if (!Array.isArray(value)) throw new Error('entities must be a list');
  return value.map((entry) => {
    const record = object(entry);
    return {
      id: string(record['id']),
      type: string(record['type']),
      properties: object(record['properties']),
    };
  });
}
function relations(value: Value | undefined): Relation[] {
  if (!Array.isArray(value)) throw new Error('relations must be a list');
  return value.map((entry) => {
    const record = object(entry);
    return {
      id: string(record['id']),
      type: string(record['type']),
      from: string(record['from']),
      to: string(record['to']),
      properties: object(record['properties']),
    };
  });
}
function bind(
  snapshot: Snapshot,
  type: string,
  from: string,
  to: string,
  properties: Properties = {},
): Changes {
  lookup(snapshot, from);
  lookup(snapshot, to);
  const id = `${type}:${from}`;
  return {
    removeRelations: snapshot.relations
      .filter((relation) => relation.type === type && relation.from === from && relation.id !== id)
      .map((relation) => relation.id),
    putRelations: [{ id, type, from, to, properties }],
  };
}

export const worldProfile: Profile = {
  id: 'world',
  version: '1.0.0',
  requires: {},
  facets: [
    { id: 'world.locatable', fields: {} },
    { id: 'world.ownable', fields: {} },
    { id: 'world.container', fields: {} },
    { id: 'world.agent', fields: {} },
    { id: 'world.described', fields: { label: text, description: optionalText } },
  ],
  types: [
    {
      id: 'world.Agent',
      facets: ['world.agent', 'world.locatable', 'world.container', 'world.described'],
      fields: {},
    },
    {
      id: 'world.Place',
      facets: ['world.locatable', 'world.container', 'world.described'],
      fields: {},
    },
    {
      id: 'world.Object',
      facets: ['world.locatable', 'world.ownable', 'world.container', 'world.described'],
      fields: {},
    },
    {
      id: 'world.CoordinateFrame',
      fields: {
        label: text,
        unit: text,
        dimensions: { required: true, schema: { kind: 'integer', min: 2, max: 3 } },
      },
    },
    {
      id: 'world.Pose',
      fields: {
        subject: ref('world.locatable'),
        frame: ref('world.CoordinateFrame'),
        x: { required: true, schema: { kind: 'number' } },
        y: { required: true, schema: { kind: 'number' } },
        z: { schema: { kind: 'number' } },
      },
    },
    {
      id: 'world.Observation',
      fields: {
        subject: text,
        source: text,
        status: strings('observed', 'proposed', 'disputed', 'unavailable'),
        details: json,
      },
    },
  ],
  relations: [
    {
      id: 'world.placedAt',
      from: ['world.locatable'],
      to: ['world.container'],
      fields: {},
      exclusive: 'from',
      acyclic: true,
    },
    {
      id: 'world.relatedTo',
      from: ['world.agent'],
      to: ['world.agent'],
      fields: { meaning: text },
    },
  ],
  commands: [
    {
      id: 'world.create',
      version: '1',
      input: { entities: entityInput },
      apply({ snapshot }, args) {
        const created = entities(args['entities']);
        for (const entity of created) fresh(snapshot, entity.id);
        if (new Set(created.map((entity) => entity.id)).size !== created.length)
          throw new Error('duplicate entity identities');
        return { putEntities: created };
      },
    },
    {
      id: 'world.relate',
      version: '1',
      input: { relations: relationInput },
      apply({ snapshot }, args) {
        const created = relations(args['relations']);
        for (const relation of created) fresh(snapshot, relation.id);
        if (new Set(created.map((relation) => relation.id)).size !== created.length)
          throw new Error('duplicate relation identities');
        return { putRelations: created };
      },
    },
    {
      id: 'world.update',
      version: '1',
      input: { entity: text, properties: json },
      apply({ snapshot }, args) {
        const entity = lookup(snapshot, string(args['entity']));
        return { putEntities: [{ ...entity, properties: object(args['properties']) }] };
      },
    },
    {
      id: 'world.move',
      version: '1',
      input: { entity: ref('world.locatable'), destination: ref('world.container') },
      apply({ snapshot }, args) {
        return bind(
          snapshot,
          'world.placedAt',
          string(args['entity']),
          string(args['destination']),
        );
      },
    },
    {
      id: 'world.setPose',
      version: '1',
      input: {
        subject: ref('world.locatable'),
        frame: ref('world.CoordinateFrame'),
        x: { required: true, schema: { kind: 'number' } },
        y: { required: true, schema: { kind: 'number' } },
        z: { schema: { kind: 'number' } },
      },
      apply({ snapshot }, args) {
        const subject = string(args['subject']);
        const existing = snapshot.entities.find(
          (entity) => entity.type === 'world.Pose' && entity.properties['subject'] === subject,
        );
        const id = existing?.id ?? `world.pose:${subject}`;
        if (!existing) fresh(snapshot, id);
        return {
          putEntities: [
            {
              id,
              type: 'world.Pose',
              properties: {
                subject,
                frame: string(args['frame']),
                x: args['x']!,
                y: args['y']!,
                ...(args['z'] === undefined ? {} : { z: args['z'] }),
              },
            },
          ],
        };
      },
    },
  ],
  invariants: [
    {
      id: 'world.pose-dimensions',
      version: '1',
      check(snapshot) {
        const subjects = new Set<string>();
        for (const pose of snapshot.entities.filter((entity) => entity.type === 'world.Pose')) {
          const subject = string(pose.properties['subject']);
          if (subjects.has(subject))
            throw new Error('a subject has at most one pose on a timeline');
          subjects.add(subject);
          const frame = lookup(snapshot, string(pose.properties['frame']), 'world.CoordinateFrame');
          if ((frame.properties['dimensions'] === 3) !== (pose.properties['z'] !== undefined))
            throw new Error('pose coordinates must match frame dimensions');
        }
      },
    },
  ],
};

/** Exact nonnegative base-unit integers. Decimal units are declared through the unit identifier. */
export function stockQuantity(value: Value | undefined): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value))
    throw new Error('quantity must be a canonical nonnegative integer string of at most 78 digits');
  return BigInt(value);
}
function positive(value: Value | undefined): bigint {
  const quantity = stockQuantity(value);
  if (quantity === 0n) throw new Error('quantity must be positive');
  return quantity;
}
function reserved(snapshot: Snapshot, stock: string): bigint {
  return snapshot.entities
    .filter(
      (entity) => entity.type === 'inventory.Reservation' && entity.properties['stock'] === stock,
    )
    .reduce((sum, reservation) => sum + positive(reservation.properties['quantity']), 0n);
}
function available(snapshot: Snapshot, stock: Entity): bigint {
  return stockQuantity(stock.properties['quantity']) - reserved(snapshot, stock.id);
}
function withQuantity(stock: Entity, quantity: bigint): Entity {
  const serialized = quantity.toString();
  stockQuantity(serialized);
  return { ...stock, properties: { ...stock.properties, quantity: serialized } };
}
function persistentInventory(validUntil: number | undefined): void {
  if (validUntil !== undefined)
    throw new Error(
      'Inventory operations require an unbounded interval; record a subsequent explicit operation instead',
    );
}
function stockTotals(snapshot: Snapshot): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const stock of snapshot.entities.filter((entity) => entity.type === 'inventory.Stock')) {
    const key = JSON.stringify([stock.properties['commodity'], stock.properties['unit']]);
    totals.set(key, (totals.get(key) ?? 0n) + stockQuantity(stock.properties['quantity']));
  }
  return totals;
}

export const inventoryProfile: Profile = {
  id: 'inventory',
  version: '1.0.0',
  requires: { world: '1.0.0' },
  types: [
    {
      id: 'inventory.Stock',
      facets: ['world.locatable', 'world.ownable'],
      fields: { label: text, commodity: text, unit: text, quantity: text },
    },
    {
      id: 'inventory.Reservation',
      fields: { stock: ref('inventory.Stock'), holder: ref('world.agent'), quantity: text },
    },
  ],
  relations: [
    {
      id: 'inventory.ownedBy',
      from: ['world.ownable'],
      to: ['world.agent'],
      fields: {},
      exclusive: 'from',
    },
    {
      id: 'inventory.custodyOf',
      from: ['world.ownable'],
      to: ['world.agent'],
      fields: {},
      exclusive: 'from',
    },
    {
      id: 'inventory.equippedBy',
      from: ['world.ownable'],
      to: ['world.agent'],
      fields: { slot: text },
      exclusive: 'from',
    },
  ],
  commands: [
    {
      id: 'inventory.transferOwnership',
      version: '1',
      input: { item: ref('world.ownable'), owner: ref('world.agent') },
      apply({ snapshot }, args) {
        return bind(snapshot, 'inventory.ownedBy', string(args['item']), string(args['owner']));
      },
    },
    {
      id: 'inventory.lend',
      version: '1',
      input: { item: ref('world.ownable'), recipient: ref('world.agent') },
      apply({ snapshot }, args) {
        const item = string(args['item']);
        const custody = bind(snapshot, 'inventory.custodyOf', item, string(args['recipient']));
        return {
          ...custody,
          removeRelations: [
            ...(custody.removeRelations ?? []),
            ...snapshot.relations
              .filter(
                (relation) => relation.from === item && relation.type === 'inventory.equippedBy',
              )
              .map((relation) => relation.id),
          ],
        };
      },
    },
    {
      id: 'inventory.equip',
      version: '1',
      input: { item: ref('world.ownable'), wearer: ref('world.agent'), slot: text },
      apply({ snapshot }, args) {
        return bind(
          snapshot,
          'inventory.equippedBy',
          string(args['item']),
          string(args['wearer']),
          { slot: string(args['slot']) },
        );
      },
    },
    {
      id: 'inventory.return',
      version: '1',
      input: { item: ref('world.ownable') },
      apply({ snapshot }, args) {
        const item = string(args['item']);
        const ownership = snapshot.relations.find(
          (relation) => relation.type === 'inventory.ownedBy' && relation.from === item,
        );
        if (!ownership) throw new Error('return requires known ownership');
        const custody = bind(snapshot, 'inventory.custodyOf', item, ownership.to);
        return {
          ...custody,
          removeRelations: [
            ...(custody.removeRelations ?? []),
            ...snapshot.relations
              .filter(
                (relation) => relation.type === 'inventory.equippedBy' && relation.from === item,
              )
              .map((relation) => relation.id),
          ],
        };
      },
    },
    {
      id: 'inventory.unequip',
      version: '1',
      input: { item: ref('world.ownable') },
      apply({ snapshot }, args) {
        return {
          removeRelations: snapshot.relations
            .filter(
              (relation) =>
                relation.type === 'inventory.equippedBy' && relation.from === args['item'],
            )
            .map((relation) => relation.id),
        };
      },
    },
    {
      id: 'inventory.createStock',
      version: '1',
      input: { id: text, label: text, commodity: text, unit: text, quantity: text },
      apply({ snapshot, validUntil }, args) {
        persistentInventory(validUntil);
        const id = string(args['id']);
        fresh(snapshot, id);
        stockQuantity(args['quantity']);
        return {
          putEntities: [
            {
              id,
              type: 'inventory.Stock',
              properties: {
                label: string(args['label']),
                commodity: string(args['commodity']),
                unit: string(args['unit']),
                quantity: string(args['quantity']),
              },
            },
          ],
        };
      },
    },
    {
      id: 'inventory.consume',
      version: '1',
      input: { stock: ref('inventory.Stock'), quantity: text },
      apply({ snapshot, validUntil }, args) {
        persistentInventory(validUntil);
        const stock = lookup(snapshot, string(args['stock']), 'inventory.Stock');
        const quantity = positive(args['quantity']);
        if (available(snapshot, stock) < quantity) throw new Error('insufficient unreserved stock');
        return {
          putEntities: [
            withQuantity(stock, stockQuantity(stock.properties['quantity']) - quantity),
          ],
        };
      },
    },
    {
      id: 'inventory.transferStock',
      version: '1',
      input: { from: ref('inventory.Stock'), to: ref('inventory.Stock'), quantity: text },
      apply({ snapshot, validUntil }, args) {
        persistentInventory(validUntil);
        const from = lookup(snapshot, string(args['from']), 'inventory.Stock');
        const to = lookup(snapshot, string(args['to']), 'inventory.Stock');
        if (from.id === to.id) throw new Error('stock transfer requires distinct accounts');
        if (
          from.properties['commodity'] !== to.properties['commodity'] ||
          from.properties['unit'] !== to.properties['unit']
        )
          throw new Error('stock commodity and unit must match');
        const quantity = positive(args['quantity']);
        if (available(snapshot, from) < quantity) throw new Error('insufficient unreserved stock');
        return {
          putEntities: [
            withQuantity(from, stockQuantity(from.properties['quantity']) - quantity),
            withQuantity(to, stockQuantity(to.properties['quantity']) + quantity),
          ],
        };
      },
    },
    {
      id: 'inventory.reserve',
      version: '1',
      input: {
        id: text,
        stock: ref('inventory.Stock'),
        holder: ref('world.agent'),
        quantity: text,
      },
      apply({ snapshot, validUntil }, args) {
        persistentInventory(validUntil);
        const id = string(args['id']);
        fresh(snapshot, id);
        const stock = lookup(snapshot, string(args['stock']), 'inventory.Stock');
        if (available(snapshot, stock) < positive(args['quantity']))
          throw new Error('insufficient unreserved stock');
        return {
          putEntities: [
            {
              id,
              type: 'inventory.Reservation',
              properties: {
                stock: stock.id,
                holder: string(args['holder']),
                quantity: string(args['quantity']),
              },
            },
          ],
        };
      },
    },
    {
      id: 'inventory.release',
      version: '1',
      input: { reservation: ref('inventory.Reservation') },
      apply({ snapshot, validUntil }, args) {
        persistentInventory(validUntil);
        lookup(snapshot, string(args['reservation']), 'inventory.Reservation');
        return { removeEntities: [string(args['reservation'])] };
      },
    },
  ],
  invariants: [
    {
      id: 'inventory.integrity',
      version: '1',
      check(snapshot, previous?: Snapshot, command?: string) {
        for (const stock of snapshot.entities.filter(
          (entity) => entity.type === 'inventory.Stock',
        )) {
          stockQuantity(stock.properties['quantity']);
          if (available(snapshot, stock) < 0n) throw new Error('reservations exceed stock');
        }
        for (const reservation of snapshot.entities.filter(
          (entity) => entity.type === 'inventory.Reservation',
        )) {
          positive(reservation.properties['quantity']);
          lookup(snapshot, string(reservation.properties['stock']), 'inventory.Stock');
        }
        for (const equipment of snapshot.relations.filter(
          (relation) => relation.type === 'inventory.equippedBy',
        )) {
          const custody = snapshot.relations.find(
            (relation) =>
              relation.type === 'inventory.custodyOf' && relation.from === equipment.from,
          );
          if (!custody || custody.to !== equipment.to)
            throw new Error('equipment requires custody by its wearer');
        }
        // Third-party reducers may transfer, split or merge balances, but cannot
        // mint or burn them. The host installs all reducer code as trusted code;
        // the two explicit supply-changing primitives retain a narrow exception.
        if (previous && command !== 'inventory.createStock' && command !== 'inventory.consume') {
          const before = stockTotals(previous);
          const after = stockTotals(snapshot);
          for (const key of new Set([...before.keys(), ...after.keys()])) {
            if ((before.get(key) ?? 0n) !== (after.get(key) ?? 0n))
              throw new Error('stock conservation requires an explicit inventory supply command');
          }
        }
      },
    },
  ],
};

const snapshotBinding: Field = {
  required: true,
  schema: {
    kind: 'record',
    fields: {
      world: text,
      branch: text,
      revision: natural,
      timeline: text,
      validAt: { required: true, schema: { kind: 'integer' } },
    },
  },
};
export const authoringProfile: Profile = {
  id: 'authoring',
  version: '1.1.0',
  requires: { world: '1.0.0' },
  types: [
    { id: 'authoring.Story', fields: { title: text, grammar: optionalText } },
    { id: 'authoring.Beat', fields: { label: text, purpose: optionalText } },
    { id: 'authoring.Scene', fields: { label: text, snapshot: snapshotBinding } },
    {
      id: 'authoring.Shot',
      fields: {
        label: text,
        scene: ref('authoring.Scene'),
        subjects: {
          required: true,
          schema: {
            kind: 'list',
            items: { kind: 'ref', types: ['world.locatable'] },
            maxItems: 100,
          },
        },
        detailRequirements: { schema: { kind: 'list', items: { kind: 'string' }, maxItems: 100 } },
      },
    },
    {
      id: 'authoring.Take',
      fields: {
        shot: ref('authoring.Shot'),
        artifact: text,
        recipeVersion: text,
        verification: strings('unverified', 'reviewed', 'rejected'),
      },
    },
    {
      id: 'authoring.EditPlacement',
      fields: {
        take: ref('authoring.Take'),
        timeline: text,
        start: natural,
        duration: { required: true, schema: { kind: 'integer', min: 1 } },
        ticksNumerator: { required: true, schema: { kind: 'integer', min: 1 } },
        ticksDenominator: { required: true, schema: { kind: 'integer', min: 1 } },
      },
    },
  ],
  relations: [
    {
      id: 'authoring.hasBeat',
      from: ['authoring.Story'],
      to: ['authoring.Beat'],
      fields: { order: { ...natural, required: false } },
      exclusive: 'to',
    },
    { id: 'authoring.depicts', from: ['authoring.Scene'], to: ['authoring.Beat'], fields: {} },
    {
      id: 'authoring.hasScene',
      from: ['authoring.Story'],
      to: ['authoring.Scene'],
      fields: {},
      exclusive: 'to',
    },
    {
      id: 'authoring.hasShot',
      from: ['authoring.Scene'],
      to: ['authoring.Shot'],
      fields: {},
      exclusive: 'to',
    },
    {
      id: 'authoring.hasTake',
      from: ['authoring.Shot'],
      to: ['authoring.Take'],
      fields: {},
      exclusive: 'to',
    },
    {
      id: 'authoring.hasPlacement',
      from: ['authoring.Take'],
      to: ['authoring.EditPlacement'],
      fields: {},
      exclusive: 'to',
    },
  ],
  commands: [
    {
      id: 'authoring.record',
      version: '1',
      input: {
        entities: entityInput,
        relations: { ...relationInput, required: false },
        removeEntities: { schema: { kind: 'list', items: { kind: 'string' }, maxItems: 100 } },
        removeRelations: { schema: { kind: 'list', items: { kind: 'string' }, maxItems: 100 } },
      },
      apply({ snapshot }, args) {
        const putEntities = entities(args['entities']);
        const putRelations = args['relations'] === undefined ? [] : relations(args['relations']);
        const removeEntities = (args['removeEntities'] ?? []) as string[];
        const removeRelations = (args['removeRelations'] ?? []) as string[];
        const records = [...putEntities, ...putRelations];
        const ids = [...records.map((record) => record.id), ...removeEntities, ...removeRelations];
        if (new Set(ids).size !== ids.length)
          throw new Error('duplicate authoring record operations');
        for (const record of records) {
          if (!record.type.startsWith('authoring.'))
            throw new Error('authoring.record can only write authoring records');
          const existing = [...snapshot.entities, ...snapshot.relations].find(
            (entry) => entry.id === record.id,
          );
          if (existing && !existing.type.startsWith('authoring.'))
            throw new Error('authoring.record cannot replace non-authoring records');
        }
        for (const [removed, existing] of [
          [removeEntities, snapshot.entities],
          [removeRelations, snapshot.relations],
        ] as const) {
          for (const id of removed) {
            const record = existing.find((entry) => entry.id === id);
            if (!record || !record.type.startsWith('authoring.'))
              throw new Error('authoring.record can only remove existing authoring records');
          }
        }
        return { putEntities, putRelations, removeEntities, removeRelations };
      },
    },
  ],
  invariants: [
    {
      id: 'authoring.composition',
      version: '1',
      check(snapshot) {
        const positions = new Set<string>();
        const referenceByRelation: Record<string, string> = {
          'authoring.hasShot': 'scene',
          'authoring.hasTake': 'shot',
          'authoring.hasPlacement': 'take',
        };
        for (const relation of snapshot.relations) {
          if (relation.type === 'authoring.hasBeat' && relation.properties['order'] !== undefined) {
            const position = JSON.stringify([relation.from, relation.properties['order']]);
            if (positions.has(position)) throw new Error('duplicate beat order within story');
            positions.add(position);
          }
          const field = referenceByRelation[relation.type];
          if (field && lookup(snapshot, relation.to).properties[field] !== relation.from)
            throw new Error('composition edge disagrees with authoring reference');
        }
        for (const entity of snapshot.entities) {
          if (
            entity.type === 'authoring.EditPlacement' &&
            !Number.isSafeInteger(
              Number(entity.properties['start']) + Number(entity.properties['duration']),
            )
          )
            throw new Error('edit placement end must be a safe integer');
        }
      },
    },
  ],
};

export const softwareProfile: Profile = {
  id: 'software',
  version: '1.0.0',
  requires: {},
  facets: [
    {
      id: 'software.artifact',
      fields: { label: text, sourceRevision: text, digest: optionalText },
    },
  ],
  types: [
    { id: 'software.SourceRevision', fields: { repository: text, revision: text } },
    { id: 'software.Artifact', facets: ['software.artifact'], fields: { mediaType: optionalText } },
    {
      id: 'software.Build',
      fields: {
        source: ref('software.SourceRevision'),
        status: strings('passed', 'failed', 'unavailable'),
        toolchain: text,
      },
    },
    { id: 'software.Environment', fields: { label: text } },
    {
      id: 'software.Deployment',
      fields: {
        artifact: ref('software.artifact'),
        environment: ref('software.Environment'),
        status: strings('proposed', 'active', 'retired', 'failed', 'unavailable'),
      },
    },
    {
      id: 'software.Incident',
      fields: { label: text, deployment: ref('software.Deployment'), evidence: text },
    },
    { id: 'software.Requirement', fields: { statement: text, source: text } },
    {
      id: 'software.TestEvidence',
      fields: {
        subject: text,
        sourceRevision: text,
        outcome: strings('passed', 'failed', 'unavailable'),
        evidence: text,
      },
    },
  ],
  relations: [
    { id: 'software.produces', from: ['software.Build'], to: ['software.artifact'], fields: {} },
    {
      id: 'software.derivedFrom',
      from: ['software.artifact'],
      to: ['software.artifact'],
      fields: {},
      acyclic: true,
    },
    {
      id: 'software.evidenceFor',
      from: ['software.TestEvidence'],
      to: ['software.Requirement'],
      fields: {},
    },
  ],
  commands: [
    {
      id: 'software.record',
      version: '1',
      input: { entities: entityInput, relations: { ...relationInput, required: false } },
      apply({ snapshot }, args) {
        const recordedEntities = entities(args['entities']);
        const recordedRelations =
          args['relations'] === undefined ? [] : relations(args['relations']);
        const records = [...recordedEntities, ...recordedRelations];
        for (const record of records) {
          fresh(snapshot, record.id);
        }
        if (new Set(records.map((record) => record.id)).size !== records.length)
          throw new Error('duplicate record identities');
        return { putEntities: recordedEntities, putRelations: recordedRelations };
      },
    },
  ],
};

export const builtInProfiles: readonly Profile[] = [
  worldProfile,
  inventoryProfile,
  authoringProfile,
  softwareProfile,
];
