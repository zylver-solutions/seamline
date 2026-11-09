import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticEngine } from './engine.ts';
import { CompiledRegistry } from './registry.ts';
import { authoringProfile, worldProfile } from './packs.ts';
import type { Entity, Properties, Relation, Submission } from './types.ts';

const authoringScope = { world: 'studio', branch: 'main' };
const authoringAccess = { tenant: 'marketing', actor: 'editor', authorize: () => true };
const compositionEntities: Entity[] = [
  { id: 'story', type: 'authoring.Story', properties: { title: 'A walk' } },
  { id: 'beat', type: 'authoring.Beat', properties: { label: 'Arrival' } },
  {
    id: 'scene',
    type: 'authoring.Scene',
    properties: {
      label: 'Station',
      snapshot: { world: 'studio', branch: 'main', revision: 1, timeline: 'story', validAt: 0 },
    },
  },
  {
    id: 'shot',
    type: 'authoring.Shot',
    properties: { label: 'Arrival wide', scene: 'scene', subjects: ['traveler'] },
  },
  {
    id: 'take',
    type: 'authoring.Take',
    properties: {
      shot: 'shot',
      artifact: 'media:arrival',
      recipeVersion: '1',
      verification: 'unverified',
    },
  },
  {
    id: 'placement',
    type: 'authoring.EditPlacement',
    properties: {
      take: 'take',
      timeline: 'cut',
      start: 0,
      duration: 240,
      ticksNumerator: 30000,
      ticksDenominator: 1001,
    },
  },
];
const compositionRelations: Relation[] = [
  {
    id: 'story-beat',
    type: 'authoring.hasBeat',
    from: 'story',
    to: 'beat',
    properties: { order: 0 },
  },
  { id: 'story-scene', type: 'authoring.hasScene', from: 'story', to: 'scene', properties: {} },
  { id: 'scene-beat', type: 'authoring.depicts', from: 'scene', to: 'beat', properties: {} },
  { id: 'scene-shot', type: 'authoring.hasShot', from: 'scene', to: 'shot', properties: {} },
  { id: 'shot-take', type: 'authoring.hasTake', from: 'shot', to: 'take', properties: {} },
  {
    id: 'take-placement',
    type: 'authoring.hasPlacement',
    from: 'take',
    to: 'placement',
    properties: {},
  },
];
function authoringArgs(entities: Entity[], relations: Relation[] = []): Properties {
  return { entities, relations } as unknown as Properties;
}
function authoringRequest(
  args: Properties,
  expectedRevision = 1,
  commandId = 'record',
): Submission {
  return {
    scope: authoringScope,
    expectedRevision,
    commandId,
    command: 'authoring.record',
    args,
    timeline: 'story',
    validAt: 0,
  };
}
function authoringFixture(run: (engine: SemanticEngine, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'seamline-authoring-'));
  const path = join(directory, 'studio.sqlite');
  const engine = new SemanticEngine(
    path,
    new CompiledRegistry([worldProfile, authoringProfile]),
    authoringAccess,
  );
  try {
    engine.createUniverse('cinema');
    engine.createWorld('cinema', 'studio', [
      { id: 'story', unit: 'tick', ticksPerUnit: { numerator: 1, denominator: 1 } },
    ]);
    engine.submit({
      ...authoringRequest(
        { entities: [{ id: 'traveler', type: 'world.Agent', properties: { label: 'Traveler' } }] },
        0,
        'subject',
      ),
      command: 'world.create',
    });
    run(engine, path);
  } finally {
    engine.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('Atelier composition persists, traverses, edits atomically and retains recorded history', () => {
  authoringFixture((engine, path) => {
    const request = authoringRequest(authoringArgs(compositionEntities, compositionRelations));
    const receipt = engine.submit(request);
    assert.equal(receipt.revision, 2);
    assert.deepEqual(engine.submit(request), receipt);
    const result = engine.query(authoringScope, {
      unfiltered: true,
      timeline: 'story',
      validAt: 0,
      from: ['story'],
      via: compositionRelations.map((relation) => relation.type),
      maxDepth: 4,
      limit: 20,
    });
    assert.equal(result.truncated, false);
    assert.deepEqual(
      result.entities.map((entity) => entity.id).sort(),
      compositionEntities.map((entity) => entity.id).sort(),
    );
    const reopen = new SemanticEngine(
      path,
      new CompiledRegistry([worldProfile, authoringProfile]),
      authoringAccess,
    );
    try {
      assert.equal(
        reopen.snapshot(authoringScope, { unfiltered: true, timeline: 'story', validAt: 0 })
          .snapshot.entities.length,
        7,
      );
      const revisedTake = {
        ...compositionEntities[4]!,
        properties: { ...compositionEntities[4]!.properties, verification: 'reviewed' },
      };
      engine.submit(
        authoringRequest(
          {
            ...authoringArgs([revisedTake]),
            removeEntities: ['placement'],
            removeRelations: ['take-placement'],
          },
          2,
          'edit',
        ),
      );
      assert.throws(
        () => reopen.submit(authoringRequest(authoringArgs([compositionEntities[0]!]), 2, 'stale')),
        /revision/i,
      );
      const latest = reopen.snapshot(authoringScope, {
        unfiltered: true,
        timeline: 'story',
        validAt: 0,
      });
      assert.equal(latest.revision, 3);
      assert.equal(
        latest.snapshot.entities.some((entity) => entity.id === 'placement'),
        false,
      );
      assert.equal(
        latest.snapshot.entities.find((entity) => entity.id === 'take')!.properties['verification'],
        'reviewed',
      );
      const original = reopen.snapshot(authoringScope, {
        unfiltered: true,
        timeline: 'story',
        validAt: 0,
        revision: 2,
      });
      assert.equal(
        original.snapshot.entities.find((entity) => entity.id === 'take')!.properties[
          'verification'
        ],
        'unverified',
      );
      assert.equal(
        original.snapshot.entities.some((entity) => entity.id === 'placement'),
        true,
      );
    } finally {
      reopen.close();
    }
  });
});

test('Atelier composition rejects invalid references, ordering, durations and namespace writes without partial state', () => {
  authoringFixture((engine) => {
    const invalid: Properties[] = [];
    const missingSubject = structuredClone(compositionEntities);
    missingSubject[3]!.properties['subjects'] = ['absent'];
    invalid.push(authoringArgs(missingSubject, compositionRelations));
    for (const duration of [0, Number.MAX_SAFE_INTEGER]) {
      const wrongDuration = structuredClone(compositionEntities);
      wrongDuration[5]!.properties['start'] = 10;
      wrongDuration[5]!.properties['duration'] = duration;
      invalid.push(authoringArgs(wrongDuration, compositionRelations));
    }
    const secondBeat = { id: 'beat-2', type: 'authoring.Beat', properties: { label: 'Departure' } };
    invalid.push(
      authoringArgs(
        [...compositionEntities, secondBeat],
        [
          ...compositionRelations,
          {
            id: 'story-beat-2',
            type: 'authoring.hasBeat',
            from: 'story',
            to: 'beat-2',
            properties: { order: 0 },
          },
        ],
      ),
    );
    const secondScene = { ...compositionEntities[2]!, id: 'scene-2' };
    invalid.push(
      authoringArgs(
        [...compositionEntities, secondScene],
        compositionRelations.map((relation) =>
          relation.id === 'scene-shot' ? { ...relation, from: 'scene-2' } : relation,
        ),
      ),
    );
    invalid.push(
      authoringArgs([{ id: 'forged', type: 'world.Agent', properties: { label: 'No' } }]),
    );
    invalid.push({ entities: [], removeEntities: ['traveler'] });
    invalid.push(authoringArgs([compositionEntities[0]!, compositionEntities[0]!]));
    for (const [index, args] of invalid.entries()) {
      assert.throws(() => engine.submit(authoringRequest(args, 1, `invalid-${index}`)));
      const unchanged = engine.snapshot(authoringScope, {
        unfiltered: true,
        timeline: 'story',
        validAt: 0,
      });
      assert.equal(unchanged.revision, 1);
      assert.deepEqual(
        unchanged.snapshot.entities.map((entity) => entity.id),
        ['traveler'],
      );
    }
    engine.submit(authoringRequest(authoringArgs(compositionEntities, compositionRelations)));
    assert.throws(() =>
      engine.submit(authoringRequest({ entities: [], removeEntities: ['take'] }, 2, 'dangling')),
    );
    assert.equal(
      engine.snapshot(authoringScope, { unfiltered: true, timeline: 'story', validAt: 0 }).revision,
      2,
    );
  });
});
