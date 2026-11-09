import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { SemanticEngine } from './engine.ts';
import { CompiledRegistry } from './registry.ts';
import { disclose } from './disclosure.ts';
import type {
  Access,
  CommandDefinition,
  Entity,
  ExportPolicy,
  Profile,
  Properties,
  RecordFilter,
  Relation,
  Snapshot,
  SnapshotRequest,
} from './types.ts';

const noteAccess: Access = { tenant: 'test', actor: 'operator', authorize: () => true };
const noteScope = { world: 'desk', branch: 'main' };
const noteTime = { timeline: 'day', validAt: 0 };
const VISIBILITY = ['public', 'private'] as const;
const TOPIC = ['work', 'home'] as const;
const STATUS = ['draft', 'final'] as const;

function writer(profile: string): CommandDefinition[] {
  return [
    {
      id: `${profile}.write`,
      version: '1',
      input: {
        entities: { schema: { kind: 'json' } },
        relations: { schema: { kind: 'json' } },
        remove: { schema: { kind: 'json' } },
      },
      apply(_context, args) {
        return {
          putEntities: (args['entities'] ?? []) as unknown as Entity[],
          putRelations: (args['relations'] ?? []) as unknown as Relation[],
          removeEntities: (args['remove'] ?? []) as unknown as string[],
        };
      },
    },
  ];
}

/** Notes cite notes, people and tags; tags (no enum field) cite notes. */
const notes: Profile = {
  id: 'notes',
  version: '1.0.0',
  requires: {},
  types: [
    {
      id: 'notes.note',
      fields: {
        visibility: { required: true, schema: { kind: 'string', enum: VISIBILITY } },
        topic: { schema: { kind: 'string', enum: TOPIC } },
        body: { schema: { kind: 'string' } },
        parent: { nullable: true, schema: { kind: 'ref', types: ['notes.note'] } },
        related: { schema: { kind: 'list', items: { kind: 'ref', types: ['notes.note'] } } },
        author: { nullable: true, schema: { kind: 'ref', types: ['notes.person'] } },
        label: { schema: { kind: 'ref', types: ['notes.tag'] } },
        blob: { schema: { kind: 'json' } },
      },
    },
    {
      id: 'notes.person',
      fields: {
        visibility: { required: true, schema: { kind: 'string', enum: VISIBILITY } },
        name: { schema: { kind: 'string' } },
      },
    },
    {
      id: 'notes.tag',
      fields: {
        text: { schema: { kind: 'string' } },
        subject: { schema: { kind: 'ref', types: ['notes.note'] } },
      },
    },
  ],
  relations: [
    {
      id: 'notes.links',
      from: ['notes.note'],
      to: ['notes.note'],
      fields: { status: { schema: { kind: 'string', enum: STATUS } } },
    },
    { id: 'notes.tagged', from: ['notes.tag'], to: ['notes.note'], fields: {} },
  ],
  commands: writer('notes'),
};

/** The smallest profile that shows the defect: one type, one classification field. */
const memo: Profile = {
  id: 'memo',
  version: '1.0.0',
  requires: {},
  types: [
    {
      id: 'memo.note',
      fields: {
        visibility: { required: true, schema: { kind: 'string', enum: VISIBILITY } },
        body: { schema: { kind: 'string' } },
      },
    },
  ],
  relations: [],
  commands: writer('memo'),
};

interface Step {
  entities?: Entity[];
  relations?: Relation[];
  remove?: string[];
  validAt?: number;
}
function openWorlds(profile: Profile, test: (engine: SemanticEngine) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'semantic-disclosure-'));
  const engine = new SemanticEngine(
    join(dir, 'notes.sqlite'),
    new CompiledRegistry([profile]),
    noteAccess,
  );
  try {
    engine.createUniverse('universe');
    test(engine);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
function seedWorld(engine: SemanticEngine, world: string, steps: Step[], profile = 'notes'): void {
  engine.createWorld('universe', world, [
    { id: 'day', unit: 'day', ticksPerUnit: { numerator: 1, denominator: 1 } },
  ]);
  steps.forEach((step, index) => {
    engine.submit({
      scope: { world, branch: 'main' },
      expectedRevision: index,
      commandId: `c-${index}`,
      command: `${profile}.write`,
      args: {
        entities: (step.entities ?? []) as unknown as Properties['entities'],
        relations: (step.relations ?? []) as unknown as Properties['relations'],
        remove: (step.remove ?? []) as unknown as Properties['remove'],
      },
      timeline: 'day',
      validAt: step.validAt ?? 0,
    });
  });
}
function withNotes(steps: Step[], test: (engine: SemanticEngine) => void): void {
  openWorlds(notes, (engine) => {
    seedWorld(engine, noteScope.world, steps);
    test(engine);
  });
}

const note = (id: string, visibility: string, properties: Properties = {}): Entity => ({
  id,
  type: 'notes.note',
  properties: { visibility, ...properties },
});
const person = (id: string, visibility: string): Entity => ({
  id,
  type: 'notes.person',
  properties: { visibility, name: `name of ${id}` },
});
const link = (id: string, from: string, to: string, status = 'final'): Relation => ({
  id,
  type: 'notes.links',
  from,
  to,
  properties: { status },
});

/** Names every notes type with an enum field, as a filter must. */
const PUBLIC: RecordFilter = {
  'notes.note': { visibility: ['public'] },
  'notes.person': { visibility: ['public'] },
  'notes.links': { status: ['draft', 'final'] },
};
const NOTE_FIELDS = ['visibility', 'topic', 'body', 'parent', 'related', 'author', 'label'];
const exportAll = (where?: RecordFilter): ExportPolicy => ({
  types: ['notes.note', 'notes.person', 'notes.tag', 'notes.links', 'notes.tagged'],
  fields: {
    'notes.note': NOTE_FIELDS,
    'notes.person': ['visibility', 'name'],
    'notes.tag': ['text', 'subject'],
    'notes.links': ['status'],
    'notes.tagged': [],
  },
  ...(where === undefined ? {} : { where }),
});
const sortedIds = (records: readonly { id: string }[]): string[] => records.map((r) => r.id).sort();

/** Every record-bearing read, given the same filter. */
function disclosures(
  engine: SemanticEngine,
  where: RecordFilter,
  from: string[],
  target = noteScope,
  request: SnapshotRequest = noteTime,
): Snapshot[] {
  const read = engine.snapshot(target, { ...request, where }).snapshot;
  const exported = engine.exportSnapshot(target, request, exportAll(where)).snapshot;
  const queried = engine.query(target, {
    ...request,
    where,
    from,
    via: ['notes.links', 'notes.tagged'],
    maxDepth: 8,
    limit: 500,
  });
  return [read, exported, { entities: queried.entities, relations: [] }];
}
function assertAbsent(outputs: readonly unknown[], tokens: readonly string[]): void {
  for (const output of outputs) {
    const text = JSON.stringify(output);
    for (const token of tokens)
      assert.equal(text.includes(`"${token}"`), false, `${token} leaked in ${text}`);
  }
}

describe('value-aware disclosure', () => {
  it('repro: export where visibility = public releases only the public note', () =>
    openWorlds(memo, (engine) => {
      seedWorld(
        engine,
        noteScope.world,
        [
          {
            entities: [
              {
                id: 'n-public',
                type: 'memo.note',
                properties: { visibility: 'public', body: 'a' },
              },
              {
                id: 'n-private',
                type: 'memo.note',
                properties: { visibility: 'private', body: 'b' },
              },
            ],
          },
        ],
        'memo',
      );
      const policy: ExportPolicy = {
        types: ['memo.note'],
        fields: { 'memo.note': ['visibility', 'body'] },
      };
      assert.throws(
        () => engine.exportSnapshot(noteScope, noteTime, policy),
        /memo\.note.*unfiltered/,
        'a classified type is not exported without a filter',
      );
      assert.deepEqual(
        sortedIds(
          engine.exportSnapshot(noteScope, noteTime, { ...policy, unfiltered: true }).snapshot
            .entities,
        ),
        ['n-private', 'n-public'],
        'an admin unfiltered export releases every record of an allowed type',
      );
      const filtered = engine.exportSnapshot(noteScope, noteTime, {
        ...policy,
        where: { 'memo.note': { visibility: ['public'] } },
      });
      assert.deepEqual(filtered.snapshot.entities, [
        { id: 'n-public', type: 'memo.note', properties: { visibility: 'public', body: 'a' } },
      ]);
    }));

  it('applies the same filter to snapshot and query, and leaves unfiltered reads unchanged', () =>
    withNotes(
      [
        {
          entities: [note('n-public', 'public'), note('n-private', 'private')],
          relations: [link('l-1', 'n-public', 'n-private')],
        },
      ],
      (engine) => {
        for (const disclosed of disclosures(engine, PUBLIC, ['n-public', 'n-private'])) {
          assert.deepEqual(sortedIds(disclosed.entities), ['n-public']);
          assert.deepEqual(disclosed.relations, []);
        }
        const plain = engine.snapshot(noteScope, { ...noteTime, unfiltered: true }).snapshot;
        assert.deepEqual(sortedIds(plain.entities), ['n-private', 'n-public']);
        assert.deepEqual(sortedIds(plain.relations), ['l-1']);
        const traversal = engine.query(noteScope, {
          ...noteTime,
          unfiltered: true,
          from: ['n-public'],
          via: ['notes.links'],
          maxDepth: 1,
          limit: 10,
        });
        assert.deepEqual(sortedIds(traversal.entities), ['n-private', 'n-public']);
      },
    ));

  it('a query cannot start at, reach through or count work on a withheld record', () =>
    withNotes(
      [
        {
          entities: [note('a', 'public'), note('b', 'private'), note('c', 'public')],
          relations: [link('ab', 'a', 'b'), link('bc', 'b', 'c')],
        },
      ],
      (engine) => {
        const query = { ...noteTime, where: PUBLIC, via: ['notes.links'], maxDepth: 8, limit: 10 };
        assert.deepEqual(sortedIds(engine.query(noteScope, { ...query, from: ['a'] }).entities), [
          'a',
        ]);
        const hidden = engine.query(noteScope, { ...query, from: ['b'] });
        const absent = engine.query(noteScope, { ...query, from: ['missing'] });
        assert.deepEqual(
          hidden,
          absent,
          'a withheld start is indistinguishable from an unknown id',
        );
      },
    ));

  it('fixture pair: a referrer to a withheld record exposes no id', () => {
    const referrers = (target: string): Step[] => [
      {
        entities: [
          note('n-referrer', 'public', { parent: 'n-target' }),
          note('n-lister', 'public', { related: ['n-free', 'n-target'] }),
          note('n-second', 'public', { parent: 'n-referrer' }),
          note('n-free', 'public', { parent: null }),
          note('n-target', target),
        ],
        relations: [link('l-free', 'n-free', 'n-target')],
      },
    ];
    const everyone = ['n-free', 'n-lister', 'n-referrer', 'n-second', 'n-target'];
    withNotes(referrers('public'), (engine) => {
      for (const disclosed of disclosures(engine, PUBLIC, everyone))
        assert.deepEqual(sortedIds(disclosed.entities), everyone);
    });
    withNotes(referrers('private'), (engine) => {
      const outputs = disclosures(engine, PUBLIC, everyone);
      for (const disclosed of outputs) assert.deepEqual(sortedIds(disclosed.entities), ['n-free']);
      assertAbsent(outputs, ['n-target', 'n-referrer', 'n-lister', 'n-second', 'l-free']);
    });
  });

  it('filters relation records by their own enum fields', () =>
    withNotes(
      [
        {
          entities: [note('a', 'public'), note('b', 'public')],
          relations: [
            link('l-draft', 'a', 'b', 'draft'),
            link('l-final', 'b', 'a', 'final'),
            { id: 'l-unset', type: 'notes.links', from: 'a', to: 'a', properties: {} },
          ],
        },
      ],
      (engine) => {
        const where = { ...PUBLIC, 'notes.links': { status: ['final'] } };
        assert.deepEqual(
          sortedIds(engine.snapshot(noteScope, { ...noteTime, where }).snapshot.relations),
          ['l-final'],
        );
        assert.deepEqual(
          sortedIds(
            engine.exportSnapshot(noteScope, noteTime, exportAll(where)).snapshot.relations,
          ),
          ['l-final'],
        );
        const walk = engine.query(noteScope, {
          ...noteTime,
          where,
          from: ['a'],
          via: ['notes.links'],
          maxDepth: 1,
          limit: 10,
        });
        assert.deepEqual(sortedIds(walk.entities), ['a'], 'a withheld relation is not traversed');
      },
    ));

  it('export applies both the policy filter and a request filter', () =>
    withNotes(
      [
        {
          entities: [
            note('p-work', 'public', { topic: 'work' }),
            note('p-home', 'public', { topic: 'home' }),
            note('q-work', 'private', { topic: 'work' }),
          ],
        },
      ],
      (engine) => {
        const exported = engine.exportSnapshot(
          noteScope,
          { ...noteTime, where: { 'notes.note': { topic: ['work'] } } },
          exportAll(PUBLIC),
        );
        assert.deepEqual(sortedIds(exported.snapshot.entities), ['p-work']);
      },
    ));

  it('an admin unfiltered export still releases allow-listed references and json unchanged', () =>
    withNotes(
      [
        {
          entities: [
            person('person:p1', 'private'),
            note('n1', 'public', { author: 'person:p1', blob: { see: 'person:p1' } }),
          ],
        },
      ],
      (engine) => {
        const exported = engine.exportSnapshot(noteScope, noteTime, {
          types: ['notes.note'],
          fields: { 'notes.note': ['visibility', 'author', 'blob'] },
          unfiltered: true,
        });
        assert.deepEqual(exported.snapshot.entities, [
          {
            id: 'n1',
            type: 'notes.note',
            properties: { visibility: 'public', author: 'person:p1', blob: { see: 'person:p1' } },
          },
        ]);
      },
    ));

  it('rejects an invalid filter on every path before reading, fail-closed', () =>
    withNotes([{ entities: [note('n', 'public')] }], (engine) => {
      const invalid: unknown[] = [
        null,
        [],
        {},
        'notes.note',
        { ...PUBLIC, 'notes.missing': { visibility: ['public'] } },
        { ...PUBLIC, 'notes.note': {} },
        { ...PUBLIC, 'notes.note': { colour: ['public'] } },
        { ...PUBLIC, 'notes.note': { body: ['a'] } },
        { ...PUBLIC, 'notes.note': { parent: ['n'] } },
        { ...PUBLIC, 'notes.note': { visibility: ['secret'] } },
        { ...PUBLIC, 'notes.note': { visibility: ['Public'] } },
        { ...PUBLIC, 'notes.note': { visibility: 'public' } },
        { ...PUBLIC, 'notes.note': { visibility: ['public', 'public'] } },
        { ...PUBLIC, 'notes.note': { constructor: ['public'] } },
        { ...PUBLIC, 'notes.links': { status: ['archived'] } },
      ];
      for (const where of invalid) {
        const filter = where as RecordFilter;
        assert.throws(
          () => engine.exportSnapshot(noteScope, noteTime, exportAll(filter)),
          /record filter|unsafe key/,
          `export accepted ${JSON.stringify(where)}`,
        );
        assert.throws(
          () => engine.snapshot(noteScope, { ...noteTime, where: filter }),
          /record filter|unsafe key/,
          `snapshot accepted ${JSON.stringify(where)}`,
        );
        assert.throws(
          () =>
            engine.query(noteScope, {
              ...noteTime,
              where: filter,
              from: ['n'],
              via: [],
              maxDepth: 0,
              limit: 1,
            }),
          /record filter|unsafe key/,
          `query accepted ${JSON.stringify(where)}`,
        );
      }
    }));
});

describe('value-aware disclosure: review regressions', () => {
  it('A: a withheld write changes nothing a filtered reader sees except the revision counter', () =>
    openWorlds(notes, (engine) => {
      const base = { world: 'base', branch: 'main' };
      const extra = { world: 'extra', branch: 'main' };
      const joined = { world: 'joined', branch: 'main' };
      seedWorld(engine, base.world, [{ entities: [note('n1', 'public', { body: 'hi' })] }]);
      seedWorld(engine, extra.world, [
        { entities: [note('n1', 'public', { body: 'hi' })] },
        { entities: [note('x', 'private', { body: 'body of x' })] },
      ]);
      seedWorld(engine, joined.world, [
        {
          entities: [note('n1', 'public', { body: 'hi' }), note('x', 'private')],
          relations: [link('r1', 'n1', 'x')],
        },
      ]);
      const reads = (target: typeof base) => {
        const request = { ...noteTime, where: PUBLIC };
        const query = {
          ...request,
          from: ['n1', 'x'],
          via: ['notes.links'],
          maxDepth: 8,
          limit: 9,
        };
        return {
          snapshot: engine.snapshot(target, request),
          exported: engine.exportSnapshot(target, noteTime, exportAll(PUBLIC)),
          queried: engine.query(target, query),
        };
      };
      const withoutRevision = (result: ReturnType<typeof reads>) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(result).map(([path, { revision: _revision, ...rest }]) => [path, rest]),
          ),
        );
      // Same number of accepted commands: identical, revision included.
      assert.deepEqual(reads(joined), reads(base));
      // One more accepted command: identical except the documented revision counter.
      assert.equal(withoutRevision(reads(extra)), withoutRevision(reads(base)));
      assert.equal(reads(extra).snapshot.revision, reads(base).snapshot.revision + 1);
      // History would list the withheld command, so it is refused under a filter.
      assert.throws(
        () => engine.history(extra, { limit: 10, where: PUBLIC }),
        /history.*record filter/i,
      );
    }));

  it('B: a reference to a record outside the released set withholds the referrer', () =>
    withNotes(
      [
        {
          entities: [
            person('person:p1', 'private'),
            person('person:p2', 'public'),
            note('n1', 'public', { author: 'person:p1' }),
            note('n2', 'public', { author: 'person:p2' }),
            note('n3', 'public'),
            { id: 't1', type: 'notes.tag', properties: { text: 'tag one', subject: 'n1' } },
            { id: 't3', type: 'notes.tag', properties: { text: 'tag three', subject: 'n3' } },
          ],
        },
      ],
      (engine) => {
        // A filter must name every releasable type that has an enum field.
        const noteOnly = {
          'notes.note': PUBLIC['notes.note']!,
          'notes.links': PUBLIC['notes.links']!,
        };
        assert.throws(
          () => engine.snapshot(noteScope, { ...noteTime, where: noteOnly }),
          /record filter: .*notes\.person/,
        );
        assert.throws(
          () =>
            engine.exportSnapshot(noteScope, noteTime, {
              types: ['notes.note'],
              fields: { 'notes.note': ['visibility'] },
              where: noteOnly,
            }),
          /record filter: .*notes\.person/,
          'a type referenced by an exported type must be named too',
        );
        // The private person, and every record that cites it, is withheld on every path.
        const outputs = disclosures(engine, PUBLIC, ['n1', 'n2', 'n3', 't1', 't3']);
        for (const disclosed of outputs)
          assert.deepEqual(sortedIds(disclosed.entities), [
            'n2',
            'n3',
            ...(disclosed.entities.some((e) => e.type === 'notes.person') ? ['person:p2'] : []),
            't3',
          ]);
        assertAbsent(outputs, ['person:p1', 'name of person:p1', 'n1', 't1', 'tag one']);
        // A type left out of the export allow-list is outside the released set as well.
        const notesOnly = (fields: string[]) =>
          engine.exportSnapshot(noteScope, noteTime, {
            types: ['notes.note'],
            fields: { 'notes.note': fields },
            where: PUBLIC,
          }).snapshot;
        const cited = notesOnly(['visibility', 'author']);
        assert.deepEqual(sortedIds(cited.entities), ['n3']);
        assertAbsent([cited], ['person:p1', 'person:p2']);
        assert.deepEqual(
          sortedIds(notesOnly(['visibility']).entities),
          ['n1', 'n2', 'n3'],
          'a reference in a field that is not released withholds nothing',
        );
      },
    ));

  it('C: a filter reads the head revision only and withholds any id that fails in any version', () =>
    withNotes(
      [
        {
          entities: [
            note('reclassified', 'public', { body: 'memo text' }),
            note('later-private', 'public', { body: 'early text' }),
            note('declassified', 'private', { body: 'released text' }),
            note('opened-later', 'private', { body: 'opened text' }),
          ],
        },
        {
          entities: [
            note('reclassified', 'private', { body: 'memo text' }),
            note('declassified', 'public', { body: 'released text' }),
          ],
        },
        {
          validAt: 5,
          entities: [
            note('later-private', 'private', { body: 'early text' }),
            note('opened-later', 'public', { body: 'opened text' }),
          ],
        },
      ],
      (engine) => {
        const everyone = ['reclassified', 'later-private', 'declassified', 'opened-later'];
        for (const validAt of [0, 4, 5, 9]) {
          const outputs = disclosures(engine, PUBLIC, everyone, noteScope, {
            ...noteTime,
            validAt,
          });
          for (const disclosed of outputs)
            assert.deepEqual(sortedIds(disclosed.entities), ['declassified']);
          assertAbsent(outputs, [
            'reclassified',
            'memo text',
            'later-private',
            'early text',
            'opened-later',
            'opened text',
          ]);
        }
        const earlier = { ...noteTime, revision: 1 };
        assert.throws(
          () => engine.exportSnapshot(noteScope, earlier, exportAll(PUBLIC)),
          /head revision/,
        );
        assert.throws(
          () => engine.snapshot(noteScope, { ...earlier, where: PUBLIC }),
          /head revision/,
        );
        assert.throws(
          () =>
            engine.query(noteScope, {
              ...earlier,
              where: PUBLIC,
              from: ['reclassified'],
              via: [],
              maxDepth: 0,
              limit: 1,
            }),
          /head revision/,
        );
        // Unfiltered time travel is unchanged.
        assert.deepEqual(
          sortedIds(engine.snapshot(noteScope, { ...earlier, unfiltered: true }).snapshot.entities),
          [...everyone].sort(),
        );
      },
    ));

  it('D: history is refused under a record filter and unchanged without one', () =>
    withNotes(
      [{ entities: [note('n1', 'public')] }, { entities: [note('x', 'private')] }],
      (engine) => {
        assert.throws(
          () => engine.history(noteScope, { limit: 10, where: PUBLIC }),
          /history.*record filter/i,
        );
        assert.deepEqual(
          engine.history(noteScope, { limit: 10 }).map((entry) => entry.receipt.commandId),
          ['c-1', 'c-0'],
        );
      },
    ));

  it('E: a backdated removal cannot leave a released reference dangling', () => {
    withNotes(
      [
        { entities: [note('x', 'private', { body: 'body of x' })] },
        { validAt: 5, entities: [note('y', 'public', { parent: 'x' })] },
      ],
      (engine) => {
        assert.throws(
          () =>
            engine.submit({
              scope: noteScope,
              expectedRevision: 2,
              commandId: 'c-2',
              command: 'notes.write',
              args: { remove: ['x'] },
              timeline: 'day',
              validAt: 3,
            }),
          /invalid reference/,
        );
        const outputs = disclosures(engine, PUBLIC, ['x', 'y'], noteScope, {
          ...noteTime,
          validAt: 5,
        });
        for (const disclosed of outputs) assert.deepEqual(disclosed.entities, []);
        assertAbsent(outputs, ['x', 'y', 'body of x']);
      },
    );
    // Defensive: a reference to an id that is not in the snapshot at all withholds the referrer.
    const registry = new CompiledRegistry([notes]);
    const dangling = note('y', 'public', { parent: 'gone' });
    const released = disclose(
      registry,
      { entities: [dangling, note('z', 'public')], relations: [] },
      [PUBLIC],
      { versions: [dangling, note('z', 'public')] },
    );
    assert.deepEqual(sortedIds(released.entities), ['z']);
  });

  it('F: opaque json cannot carry a withheld id out', () =>
    withNotes(
      [
        {
          entities: [
            note('x', 'private'),
            note('y', 'public', { blob: { see: 'x' } }),
            note('z', 'public', { parent: 'y' }),
            note('w', 'public'),
          ],
        },
      ],
      (engine) => {
        assert.throws(
          () =>
            engine.exportSnapshot(noteScope, noteTime, {
              types: ['notes.note'],
              fields: { 'notes.note': ['visibility', 'blob'] },
              where: PUBLIC,
            }),
          /record filter: .*json/,
        );
        const exported = engine.exportSnapshot(noteScope, noteTime, exportAll(PUBLIC)).snapshot;
        assert.deepEqual(sortedIds(exported.entities), ['w', 'y', 'z'], 'json is not released');
        assertAbsent([exported], ['x']);
        const read = [
          engine.snapshot(noteScope, { ...noteTime, where: PUBLIC }).snapshot,
          engine.query(noteScope, {
            ...noteTime,
            where: PUBLIC,
            from: ['w', 'x', 'y', 'z'],
            via: [],
            maxDepth: 0,
            limit: 9,
          }),
        ];
        for (const output of read) assert.deepEqual(sortedIds(output.entities), ['w']);
        assertAbsent(read, ['x', 'y', 'z']);
      },
    ));
});

/** Classification that a filter cannot name: in a list, in a nested record, or a boolean. */
const archive: Profile = {
  id: 'archive',
  version: '1.0.0',
  requires: {},
  types: [
    {
      id: 'archive.person',
      fields: {
        visibility: { required: true, schema: { kind: 'string', enum: VISIBILITY } },
        name: { schema: { kind: 'string' } },
      },
    },
    {
      id: 'archive.labelled',
      fields: {
        labels: { schema: { kind: 'list', items: { kind: 'string', enum: VISIBILITY } } },
        body: { schema: { kind: 'string' } },
      },
    },
    {
      id: 'archive.nested',
      fields: {
        meta: {
          schema: {
            kind: 'record',
            fields: { visibility: { schema: { kind: 'string', enum: VISIBILITY } } },
          },
        },
        body: { schema: { kind: 'string' } },
      },
    },
    {
      id: 'archive.flagged',
      fields: {
        restricted: { schema: { kind: 'boolean' } },
        body: { schema: { kind: 'string' } },
      },
    },
    { id: 'archive.page', fields: { body: { schema: { kind: 'string' } } } },
    {
      id: 'archive.entry',
      fields: {
        visibility: { required: true, schema: { kind: 'string', enum: VISIBILITY } },
        body: { schema: { kind: 'string' } },
        source: {
          nullable: true,
          schema: {
            kind: 'ref',
            types: ['archive.labelled', 'archive.nested', 'archive.flagged', 'archive.page'],
          },
        },
        owners: {
          schema: {
            kind: 'record',
            fields: {
              owner: { schema: { kind: 'ref', types: ['archive.person'] } },
              deep: {
                schema: {
                  kind: 'list',
                  items: {
                    kind: 'record',
                    fields: { who: { schema: { kind: 'ref', types: ['archive.person'] } } },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      id: 'archive.pointer',
      fields: { target: { nullable: true, schema: { kind: 'ref', types: ['archive.entry'] } } },
    },
  ],
  relations: [],
  commands: writer('archive'),
};
const ARCHIVE_PUBLIC: RecordFilter = {
  'archive.entry': { visibility: ['public'] },
  'archive.person': { visibility: ['public'] },
};
function withArchive(entities: Entity[], test: (engine: SemanticEngine) => void): void {
  openWorlds(archive, (engine) => {
    seedWorld(engine, noteScope.world, [{ entities }], 'archive');
    test(engine);
  });
}
const archived = (id: string, type: string, properties: Properties): Entity => ({
  id,
  type: `archive.${type}`,
  properties,
});
function archiveReads(engine: SemanticEngine, from: string[]): { entities: Entity[] }[] {
  return [
    engine.snapshot(noteScope, { ...noteTime, where: ARCHIVE_PUBLIC }).snapshot,
    engine.query(noteScope, {
      ...noteTime,
      where: ARCHIVE_PUBLIC,
      from,
      via: [],
      maxDepth: 0,
      limit: 50,
    }),
  ];
}

describe('value-aware disclosure: classification coverage, admin export and forks', () => {
  it('classification in a list, a nested record or a boolean withholds the record under a filter', () =>
    withArchive(
      [
        archived('doc-list', 'labelled', { labels: ['private'], body: 'text one' }),
        archived('doc-list-open', 'labelled', { labels: ['public'], body: 'text four' }),
        archived('doc-nested', 'nested', { meta: { visibility: 'private' }, body: 'text two' }),
        archived('doc-flag', 'flagged', { restricted: true, body: 'text three' }),
        archived('page-1', 'page', { body: 'plain text' }),
        archived('e1', 'entry', { visibility: 'public', source: 'doc-list' }),
        archived('e2', 'entry', { visibility: 'public', source: 'doc-nested' }),
        archived('e3', 'entry', { visibility: 'public', source: 'doc-flag' }),
        archived('e4', 'entry', { visibility: 'public', source: 'page-1' }),
        archived('e5', 'entry', { visibility: 'public' }),
      ],
      (engine) => {
        const everyone = ['doc-list', 'doc-list-open', 'doc-nested', 'doc-flag', 'page-1'];
        const outputs = archiveReads(engine, [...everyone, 'e1', 'e2', 'e3', 'e4', 'e5']);
        for (const output of outputs)
          assert.deepEqual(sortedIds(output.entities), ['e4', 'e5', 'page-1']);
        assertAbsent(outputs, [
          'doc-list',
          'doc-list-open',
          'doc-nested',
          'doc-flag',
          'e1',
          'e2',
          'e3',
          'text one',
          'text two',
          'text three',
          'text four',
        ]);
        for (const [type, field] of [
          ['labelled', 'labels'],
          ['nested', 'meta'],
          ['flagged', 'restricted'],
        ] as const)
          assert.throws(
            () =>
              engine.exportSnapshot(noteScope, noteTime, {
                types: [`archive.${type}`],
                fields: { [`archive.${type}`]: ['body'] },
                where: ARCHIVE_PUBLIC,
              }),
            new RegExp(`record filter: archive\\.${type}\\.${field} `),
          );
        const exported = engine.exportSnapshot(noteScope, noteTime, {
          types: ['archive.entry', 'archive.page'],
          fields: { 'archive.entry': ['visibility', 'source'], 'archive.page': ['body'] },
          where: ARCHIVE_PUBLIC,
        }).snapshot;
        assert.deepEqual(sortedIds(exported.entities), ['e4', 'e5', 'page-1']);
      },
    ));

  it('references nested in records and lists of records are followed', () =>
    withArchive(
      [
        archived('person:p1', 'person', { visibility: 'private', name: 'name one' }),
        archived('person:p2', 'person', { visibility: 'public', name: 'name two' }),
        archived('a', 'entry', { visibility: 'public', owners: { owner: 'person:p1' } }),
        archived('b', 'entry', {
          visibility: 'public',
          owners: { owner: 'person:p2', deep: [{ who: 'person:p2' }, { who: 'person:p1' }] },
        }),
        archived('c', 'entry', { visibility: 'public', owners: { owner: 'person:p2' } }),
      ],
      (engine) => {
        const outputs = [
          ...archiveReads(engine, ['a', 'b', 'c', 'person:p1', 'person:p2']),
          engine.exportSnapshot(noteScope, noteTime, {
            types: ['archive.entry', 'archive.person'],
            fields: { 'archive.entry': ['visibility', 'owners'], 'archive.person': ['visibility'] },
            where: ARCHIVE_PUBLIC,
          }).snapshot,
        ];
        for (const output of outputs)
          assert.deepEqual(sortedIds(output.entities), ['c', 'person:p2']);
        assertAbsent(outputs, ['person:p1', 'name one', 'a', 'b']);
      },
    ));

  it('an export without a filter is refused for classified types unless an admin opts out', () =>
    withArchive(
      [
        archived('page-1', 'page', { body: 'plain text' }),
        archived('e1', 'entry', { visibility: 'private', body: 'hidden text' }),
        archived('ptr', 'pointer', { target: 'e1' }),
        archived('doc-flag', 'flagged', { restricted: true, body: 'text three' }),
      ],
      (engine) => {
        const only = (type: string, fields: string[]): ExportPolicy => ({
          types: [`archive.${type}`],
          fields: { [`archive.${type}`]: fields },
        });
        assert.deepEqual(
          sortedIds(
            engine.exportSnapshot(noteScope, noteTime, only('page', ['body'])).snapshot.entities,
          ),
          ['page-1'],
          'a type with no classification field, and no reference to one, needs no filter',
        );
        for (const [type, fields] of [
          ['entry', ['body']],
          ['flagged', ['body']],
          ['labelled', ['body']],
          ['nested', ['body']],
          ['pointer', ['target']],
        ] as const)
          assert.throws(
            () => engine.exportSnapshot(noteScope, noteTime, only(type, [...fields])),
            /needs a record filter.*unfiltered/,
            `archive.${type} was exported without a filter`,
          );
        const admin = engine.exportSnapshot(noteScope, noteTime, {
          ...only('entry', ['body']),
          unfiltered: true,
        });
        assert.deepEqual(admin.snapshot.entities, [
          { id: 'e1', type: 'archive.entry', properties: { body: 'hidden text' } },
        ]);
        for (const contradictory of [
          () =>
            engine.exportSnapshot(noteScope, noteTime, {
              ...only('entry', ['body']),
              unfiltered: true,
              where: ARCHIVE_PUBLIC,
            }),
          () =>
            engine.exportSnapshot(
              noteScope,
              { ...noteTime, where: ARCHIVE_PUBLIC },
              { ...only('entry', ['body']), unfiltered: true },
            ),
          () =>
            engine.exportSnapshot(noteScope, noteTime, {
              ...only('entry', ['body']),
              unfiltered: 'yes' as unknown as boolean,
            }),
        ])
          assert.throws(contradictory, /unfiltered/);
      },
    ));

  it('an unfiltered export needs admin authority; a filtered one does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'semantic-disclosure-'));
    const path = join(dir, 'archive.sqlite');
    const registry = new CompiledRegistry([archive]);
    const owner = new SemanticEngine(path, registry, noteAccess);
    const reader = new SemanticEngine(path, registry, {
      ...noteAccess,
      authorize: (operation) => operation !== 'admin',
    });
    try {
      owner.createUniverse('universe');
      seedWorld(
        owner,
        noteScope.world,
        [{ entities: [archived('e1', 'entry', { visibility: 'public' })] }],
        'archive',
      );
      const policy: ExportPolicy = { types: ['archive.entry'], fields: { 'archive.entry': [] } };
      assert.throws(
        () => reader.exportSnapshot(noteScope, noteTime, { ...policy, unfiltered: true }),
        /Unauthorized admin/,
      );
      assert.deepEqual(
        sortedIds(
          reader.exportSnapshot(noteScope, noteTime, { ...policy, where: ARCHIVE_PUBLIC }).snapshot
            .entities,
        ),
        ['e1'],
      );
    } finally {
      owner.close();
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a filtered read of a fork follows the source branch head classification', () =>
    openWorlds(notes, (engine) => {
      const main = noteScope;
      const old = { world: main.world, branch: 'old' };
      const older = { world: main.world, branch: 'older' };
      seedWorld(engine, main.world, [
        {
          entities: [
            note('x', 'public', { body: 'text x' }),
            note('y', 'public', { body: 'text y' }),
            note('z', 'public', { body: 'text z' }),
          ],
        },
      ]);
      const write = (scope: typeof main, expectedRevision: number, step: Step) =>
        engine.submit({
          scope,
          expectedRevision,
          commandId: `${scope.branch}-${expectedRevision}`,
          command: 'notes.write',
          args: {
            entities: (step.entities ?? []) as unknown as Properties['entities'],
            remove: (step.remove ?? []) as unknown as Properties['remove'],
          },
          ...noteTime,
        });
      engine.fork(main, 'old', 1);
      write(main, 1, { entities: [note('x', 'private', { body: 'text x' })] });
      write(main, 2, { remove: ['y'] });
      write(old, 0, { entities: [note('w', 'public', { body: 'text w' })] });
      const filtered = (scope: typeof main) => [
        engine.snapshot(scope, { ...noteTime, where: PUBLIC }).snapshot,
        engine.exportSnapshot(scope, noteTime, exportAll(PUBLIC)).snapshot,
        engine.query(scope, {
          ...noteTime,
          where: PUBLIC,
          from: ['w', 'x', 'y', 'z'],
          via: [],
          maxDepth: 0,
          limit: 9,
        }),
      ];
      for (const output of filtered(old)) assert.deepEqual(sortedIds(output.entities), ['w', 'z']);
      assertAbsent(filtered(old), ['x', 'y', 'text x', 'text y']);
      assert.deepEqual(
        sortedIds(engine.snapshot(old, { ...noteTime, unfiltered: true }).snapshot.entities),
        ['w', 'x', 'y', 'z'],
        'unfiltered reads of the fork are unchanged',
      );
      engine.fork(old, 'older', 1);
      write(main, 3, { entities: [note('z', 'private', { body: 'text z' })] });
      for (const scope of [old, older])
        for (const output of filtered(scope)) assert.deepEqual(sortedIds(output.entities), ['w']);
      assertAbsent([...filtered(old), ...filtered(older)], ['x', 'y', 'z', 'text z']);
    }));
});

/** A deep nested enum, a facet-inherited boolean and an opaque json field, next to a plain enum. */
const LEVEL = ['low', 'high'] as const;
const gate: Profile = {
  id: 'gate',
  version: '1.0.0',
  requires: {},
  facets: [{ id: 'gate.restricted', fields: { restricted: { schema: { kind: 'boolean' } } } }],
  types: [
    {
      id: 'gate.note',
      fields: {
        visibility: { required: true, schema: { kind: 'string', enum: VISIBILITY } },
        body: { schema: { kind: 'string' } },
      },
    },
    {
      id: 'gate.deep',
      fields: {
        visibility: { required: true, schema: { kind: 'string', enum: VISIBILITY } },
        meta: {
          schema: {
            kind: 'record',
            fields: {
              rows: {
                schema: {
                  kind: 'list',
                  items: {
                    kind: 'record',
                    fields: {
                      tags: {
                        schema: {
                          kind: 'list',
                          items: {
                            kind: 'record',
                            fields: { level: { schema: { kind: 'string', enum: LEVEL } } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        body: { schema: { kind: 'string' } },
      },
    },
    {
      id: 'gate.child',
      facets: ['gate.restricted'],
      fields: {
        visibility: { required: true, schema: { kind: 'string', enum: VISIBILITY } },
        body: { schema: { kind: 'string' } },
      },
    },
    {
      id: 'gate.vault',
      fields: { meta: { schema: { kind: 'json' } }, body: { schema: { kind: 'string' } } },
    },
  ],
  relations: [],
  commands: writer('gate'),
};
const GATE_PUBLIC: RecordFilter = {
  'gate.note': { visibility: ['public'] },
  'gate.deep': { visibility: ['public'] },
  'gate.child': { visibility: ['public'] },
};
const gateMain = { world: 'gated', branch: 'main' };
const withoutAdmin: Access['authorize'] = (operation) => operation !== 'admin';
/** An owner handle that may do anything and a reader handle with its own authority, one store. */
function withGate(
  profile: Profile,
  readerAuthority: Access['authorize'],
  entities: Entity[],
  test: (owner: SemanticEngine, reader: SemanticEngine) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'semantic-disclosure-'));
  const registry = new CompiledRegistry([profile]);
  const owner = new SemanticEngine(join(dir, 'gate.sqlite'), registry, noteAccess);
  const reader = new SemanticEngine(join(dir, 'gate.sqlite'), registry, {
    tenant: noteAccess.tenant,
    actor: 'reader',
    authorize: readerAuthority,
  });
  try {
    owner.createUniverse('universe');
    seedWorld(owner, gateMain.world, [{ entities }], profile.id);
    test(owner, reader);
  } finally {
    owner.close();
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const gateRecords = (): Entity[] => [
  {
    id: 'n-hidden',
    type: 'gate.note',
    properties: { visibility: 'private', body: 'hidden note text' },
  },
  { id: 'n-open', type: 'gate.note', properties: { visibility: 'public', body: 'open text' } },
  {
    id: 'd1',
    type: 'gate.deep',
    properties: {
      visibility: 'public',
      meta: { rows: [{ tags: [{ level: 'high' }] }] },
      body: 'hidden deep text',
    },
  },
  {
    id: 'c1',
    type: 'gate.child',
    properties: { visibility: 'public', restricted: true, body: 'hidden child text' },
  },
  {
    id: 'v1',
    type: 'gate.vault',
    properties: { meta: { visibility: 'private' }, body: 'hidden vault text' },
  },
];
const bodyOnly = (types: string[], extra: Partial<ExportPolicy> = {}): ExportPolicy => ({
  types,
  fields: Object.fromEntries(types.map((type) => [type, ['body']])),
  ...extra,
});

describe('value-aware disclosure: unfiltered reads, detached requests and fork authority', () => {
  it('deep nesting and a facet-inherited boolean are withheld under a filter and refused unfiltered', () =>
    withGate(gate, withoutAdmin, gateRecords(), (_owner, reader) => {
      const read = reader.snapshot(gateMain, { ...noteTime, where: GATE_PUBLIC }).snapshot;
      assert.deepEqual(sortedIds(read.entities), ['n-open']);
      assertAbsent([read], ['hidden deep text', 'hidden child text', 'hidden vault text']);
      for (const type of ['gate.deep', 'gate.child']) {
        assert.throws(
          () => reader.exportSnapshot(gateMain, noteTime, bodyOnly([type])),
          /record filter/,
        );
        assert.throws(
          () => reader.exportSnapshot(gateMain, noteTime, bodyOnly([type], { unfiltered: true })),
          /Unauthorized admin/,
        );
        assert.throws(
          () => reader.exportSnapshot(gateMain, noteTime, bodyOnly([type], { where: GATE_PUBLIC })),
          /cannot name/,
        );
      }
    }));

  it('refusal messages name the schema only, never ids or values', () =>
    withGate(gate, withoutAdmin, gateRecords(), (_owner, reader) => {
      for (const refused of [
        () => reader.exportSnapshot(gateMain, noteTime, bodyOnly(['gate.note'])),
        () => reader.snapshot(gateMain, noteTime),
        () => reader.snapshot(gateMain, { ...noteTime, unfiltered: true }),
      ])
        assert.throws(refused, (error: unknown) => {
          assert.doesNotMatch(String(error), /n-hidden|hidden note text|private/);
          return true;
        });
    }));

  it('reclassifying an inherited record to public on a fork does not release it', () =>
    withGate(
      gate,
      () => true,
      gateRecords(),
      (owner) => {
        owner.fork(gateMain, 'fork', 1);
        const fork = { world: gateMain.world, branch: 'fork' };
        const put = (scope: typeof gateMain, expectedRevision: number, entity: Entity) =>
          owner.submit({
            scope,
            expectedRevision,
            commandId: `${scope.branch}-${expectedRevision}`,
            command: 'gate.write',
            args: { entities: [entity] as unknown as Properties['entities'] },
            ...noteTime,
          });
        put(gateMain, 1, {
          id: 'n-open',
          type: 'gate.note',
          properties: { visibility: 'private', body: 'open text' },
        });
        put(fork, 0, {
          id: 'n-hidden',
          type: 'gate.note',
          properties: { visibility: 'public', body: 'hidden note text' },
        });
        const read = owner.snapshot(fork, { ...noteTime, where: GATE_PUBLIC }).snapshot;
        assertAbsent([read], ['n-hidden', 'hidden note text', 'n-open']);
      },
    ));

  it('snapshot and query without a filter are default-deny, like export', () =>
    withGate(gate, withoutAdmin, gateRecords(), (owner, reader) => {
      const query = { ...noteTime, from: ['n-hidden'], via: [], maxDepth: 0, limit: 5 };
      assert.throws(
        () => reader.exportSnapshot(gateMain, noteTime, bodyOnly(['gate.note'])),
        /record filter/,
      );
      assert.throws(() => reader.snapshot(gateMain, noteTime), /Read needs a record filter/);
      assert.throws(() => reader.query(gateMain, query), /Read needs a record filter/);
      assert.throws(
        () => reader.snapshot(gateMain, { ...noteTime, unfiltered: true }),
        /Unauthorized admin/,
      );
      assert.throws(
        () => reader.query(gateMain, { ...query, unfiltered: true }),
        /Unauthorized admin/,
      );
      assert.throws(
        () => owner.snapshot(gateMain, { ...noteTime, unfiltered: true, where: GATE_PUBLIC }),
        /unfiltered/,
      );
      assert.throws(
        () => owner.snapshot(gateMain, { ...noteTime, unfiltered: 1 as unknown as boolean }),
        /unfiltered/,
      );
      assert.throws(
        () =>
          owner.exportSnapshot(
            gateMain,
            { ...noteTime, unfiltered: true },
            bodyOnly(['gate.note']),
          ),
        /unfiltered on its policy/,
      );
      assert.deepEqual(
        sortedIds(reader.query(gateMain, { ...query, where: GATE_PUBLIC }).entities),
        [],
        'the filtered path stays open to a reader',
      );
      assert.deepEqual(
        sortedIds(owner.snapshot(gateMain, { ...noteTime, unfiltered: true }).snapshot.entities),
        ['c1', 'd1', 'n-hidden', 'n-open', 'v1'],
        'an admin opts in explicitly',
      );
    }));

  it('a registry with nothing that can carry a classification reads unfiltered without admin', () => {
    const pages: Profile = {
      id: 'pages',
      version: '1.0.0',
      requires: {},
      types: [{ id: 'pages.page', fields: { body: { schema: { kind: 'string' } } } }],
      relations: [],
      commands: writer('pages'),
    };
    withGate(
      pages,
      withoutAdmin,
      [{ id: 'p1', type: 'pages.page', properties: { body: 'plain text' } }],
      (_owner, reader) => {
        assert.deepEqual(sortedIds(reader.snapshot(gateMain, noteTime).snapshot.entities), ['p1']);
      },
    );
  });

  it('a getter that answers differently on a second read cannot turn a filtered export unfiltered', () =>
    withGate(gate, withoutAdmin, gateRecords(), (_owner, reader) => {
      let reads = 0;
      const policy = bodyOnly(['gate.note']);
      Object.defineProperty(policy, 'where', {
        enumerable: true,
        get: () => (reads++ === 0 ? GATE_PUBLIC : undefined),
      });
      assert.throws(() => reader.exportSnapshot(gateMain, noteTime, policy), /plain data/);
      const request = { ...noteTime };
      Object.defineProperty(request, 'where', {
        enumerable: true,
        get: () => (reads++ % 2 === 0 ? GATE_PUBLIC : undefined),
      });
      assert.throws(() => reader.snapshot(gateMain, request), /plain data/);
      const query = { ...noteTime, from: ['n-hidden'], via: [], maxDepth: 0, limit: 5 };
      Object.defineProperty(query, 'where', {
        enumerable: true,
        get: () => (reads++ % 2 === 0 ? GATE_PUBLIC : undefined),
      });
      assert.throws(() => reader.query(gateMain, query), /plain data/);
      assert.throws(
        () =>
          reader.exportSnapshot(gateMain, request, bodyOnly(['gate.note'], { where: GATE_PUBLIC })),
        /plain data/,
      );
    }));

  it('an unfiltered read of a fork needs admin on every source branch, not only the fork', () =>
    withGate(
      gate,
      (operation, scope) => operation !== 'admin' || scope?.branch === 'sandbox',
      gateRecords(),
      (_owner, reader) => {
        reader.fork(gateMain, 'sandbox', 1);
        const sandbox = { world: gateMain.world, branch: 'sandbox' };
        assert.throws(
          () =>
            reader.exportSnapshot(sandbox, noteTime, bodyOnly(['gate.note'], { unfiltered: true })),
          /Unauthorized admin/,
        );
        assert.throws(
          () => reader.snapshot(sandbox, { ...noteTime, unfiltered: true }),
          /Unauthorized admin/,
        );
        const filtered = reader.exportSnapshot(
          sandbox,
          noteTime,
          bodyOnly(['gate.note'], { where: GATE_PUBLIC }),
        ).snapshot;
        assert.deepEqual(sortedIds(filtered.entities), ['n-open']);
        assertAbsent([filtered], ['n-hidden', 'hidden note text']);
      },
    ));

  it('a json field counts as able to carry a classification for default-deny export', () =>
    withGate(gate, withoutAdmin, gateRecords(), (owner, reader) => {
      assert.throws(
        () => reader.exportSnapshot(gateMain, noteTime, bodyOnly(['gate.vault'])),
        /gate\.vault\.meta can carry a classification/,
      );
      assert.deepEqual(
        owner.exportSnapshot(gateMain, noteTime, bodyOnly(['gate.vault'], { unfiltered: true }))
          .snapshot.entities,
        [{ id: 'v1', type: 'gate.vault', properties: { body: 'hidden vault text' } }],
      );
    }));
});

describe('value-aware disclosure: property', () => {
  const NOTE_REFS = ['parent', 'related', 'author', 'label'] as const;
  const TYPES = ['notes.note', 'notes.person', 'notes.tag', 'notes.links', 'notes.tagged'];
  const FIELDS: Record<string, readonly string[]> = {
    'notes.note': NOTE_FIELDS,
    'notes.person': ['visibility', 'name'],
    'notes.tag': ['text', 'subject'],
    'notes.links': ['status'],
    'notes.tagged': [],
  };
  const index = (count: number) =>
    count === 0 ? fc.constant(undefined) : fc.option(fc.nat(count - 1), { nil: undefined });
  const arbWorld = fc
    .record({
      notes: fc.integer({ min: 1, max: 5 }),
      people: fc.integer({ min: 1, max: 3 }),
      tags: fc.nat(2),
    })
    .chain(({ notes: noteCount, people, tags }) =>
      fc.record({
        people: fc.array(fc.constantFrom(...VISIBILITY), { minLength: people, maxLength: people }),
        tags: fc.array(index(noteCount), { minLength: tags, maxLength: tags }),
        notes: fc.array(
          fc.record({
            visibility: fc.constantFrom(...VISIBILITY),
            topic: fc.option(fc.constantFrom(...TOPIC), { nil: undefined }),
            parent: index(noteCount),
            related: fc.uniqueArray(fc.nat(noteCount - 1), { maxLength: 2 }),
            author: index(people),
            label: index(tags),
            blob: fc.option(fc.nat(noteCount + people + tags - 1), { nil: undefined }),
          }),
          { minLength: noteCount, maxLength: noteCount },
        ),
        links: fc.array(
          fc.record({
            from: fc.nat(noteCount - 1),
            to: fc.nat(noteCount - 1),
            status: fc.option(fc.constantFrom(...STATUS), { nil: undefined }),
          }),
          { maxLength: 5 },
        ),
        tagged:
          tags === 0
            ? fc.constant<[number, number][]>([])
            : fc.array(fc.tuple(fc.nat(tags - 1), fc.nat(noteCount - 1)), { maxLength: 3 }),
        updates: fc
          .array(
            fc.record({
              validAt: fc.constantFrom(0, 2, 4),
              notes: fc.array(fc.tuple(fc.nat(noteCount - 1), fc.constantFrom(...VISIBILITY)), {
                maxLength: 3,
              }),
              people: fc.array(fc.tuple(fc.nat(people - 1), fc.constantFrom(...VISIBILITY)), {
                maxLength: 2,
              }),
              links: fc.array(
                fc.tuple(fc.nat(4), fc.option(fc.constantFrom(...STATUS), { nil: undefined })),
                { maxLength: 2 },
              ),
            }),
            { maxLength: 3 },
          )
          .map((updates) => [...updates].sort((a, b) => a.validAt - b.validAt)),
        where: fc.record({
          note: fc.subarray([...VISIBILITY]),
          topic: fc.option(fc.subarray([...TOPIC]), { nil: undefined }),
          person: fc.subarray([...VISIBILITY]),
          links: fc.subarray([...STATUS]),
        }),
        exportTypes: fc.subarray(TYPES, { minLength: 1 }),
        exportFields: fc.record(
          Object.fromEntries(TYPES.map((type) => [type, fc.subarray([...FIELDS[type]!])])),
        ),
        readAt: fc.constantFrom(0, 1, 2, 3, 4, 5),
      }),
    );
  type World = typeof arbWorld extends fc.Arbitrary<infer T> ? T : never;

  function build(world: World) {
    const steps: Step[] = [];
    const versions = new Map<string, { validFrom: number; record: Entity | Relation }[]>();
    const tokens = new Map<string, string[]>();
    const record = (validFrom: number, item: Entity | Relation, token?: string) => {
      const list = (versions.get(item.id) ?? []).filter((v) => v.validFrom !== validFrom);
      versions.set(item.id, [...list, { validFrom, record: item }]);
      if (token) tokens.set(item.id, [...(tokens.get(item.id) ?? []), token]);
    };
    const peopleIds = world.people.map((_, i) => `p${i}`);
    const tagIds = world.tags.map((_, i) => `t${i}`);
    const noteIds = world.notes.map((_, i) => `n${i}`);
    const everyId = [...noteIds, ...peopleIds, ...tagIds];
    const personAt = (i: number, visibility: string, step: number): Entity => ({
      id: `p${i}`,
      type: 'notes.person',
      properties: { visibility, name: `name:p${i}:${step}` },
    });
    const noteAt = (i: number, visibility: string, step: number): Entity => {
      const spec = world.notes[i]!;
      return {
        id: `n${i}`,
        type: 'notes.note',
        properties: {
          visibility,
          body: `body:n${i}:${step}`,
          related: spec.related.map((r) => `n${r}`),
          ...(spec.topic === undefined ? {} : { topic: spec.topic }),
          ...(spec.parent === undefined ? {} : { parent: `n${spec.parent}` }),
          ...(spec.author === undefined ? {} : { author: `p${spec.author}` }),
          ...(spec.label === undefined ? {} : { label: `t${spec.label}` }),
          ...(spec.blob === undefined ? {} : { blob: { see: everyId[spec.blob]! } }),
        },
      };
    };
    const linkAt = (i: number, status: string | undefined): Relation => ({
      id: `l${i}`,
      type: 'notes.links',
      from: `n${world.links[i]!.from}`,
      to: `n${world.links[i]!.to}`,
      properties: status === undefined ? {} : { status },
    });
    const first: Step = { entities: [], relations: [] };
    world.people.forEach((v, i) => first.entities!.push(personAt(i, v, 0)));
    world.notes.forEach((spec, i) => first.entities!.push(noteAt(i, spec.visibility, 0)));
    world.tags.forEach((subject, i) =>
      first.entities!.push({
        id: `t${i}`,
        type: 'notes.tag',
        properties: {
          text: `text:t${i}`,
          ...(subject === undefined ? {} : { subject: `n${subject}` }),
        },
      }),
    );
    world.links.forEach((l, i) => first.relations!.push(linkAt(i, l.status)));
    world.tagged.forEach(([tag, target], i) =>
      first.relations!.push({
        id: `g${i}`,
        type: 'notes.tagged',
        from: `t${tag}`,
        to: `n${target}`,
        properties: {},
      }),
    );
    for (const item of [...first.entities!, ...first.relations!]) {
      const token = (item.properties['body'] ??
        item.properties['name'] ??
        item.properties['text']) as string | undefined;
      record(0, item, token);
    }
    steps.push(first);
    world.updates.forEach((update, k) => {
      const step: Step = { validAt: update.validAt, entities: [], relations: [] };
      const seen = new Set<string>();
      for (const [i, v] of update.notes)
        if (!seen.has(`n${i}`)) {
          seen.add(`n${i}`);
          const item = noteAt(i, v, k + 1);
          step.entities!.push(item);
          record(update.validAt, item, item.properties['body'] as string);
        }
      for (const [i, v] of update.people)
        if (!seen.has(`p${i}`)) {
          seen.add(`p${i}`);
          const item = personAt(i, v, k + 1);
          step.entities!.push(item);
          record(update.validAt, item, item.properties['name'] as string);
        }
      for (const [i, status] of update.links)
        if (i < world.links.length && !seen.has(`l${i}`)) {
          seen.add(`l${i}`);
          const item = linkAt(i, status);
          step.relations!.push(item);
          record(update.validAt, item);
        }
      steps.push(step);
    });
    return { steps, versions, tokens, entityIds: everyId };
  }

  /** Independent model of what one path may release at the head revision. */
  function model(
    world: World,
    built: ReturnType<typeof build>,
    where: RecordFilter,
    releasedType: (type: string) => boolean,
    releasedField: (type: string, field: string) => boolean,
    jsonWithholds: boolean,
  ) {
    const passes = (item: Entity | Relation) =>
      Object.entries(where[item.type] ?? {}).every(([field, values]) =>
        values.includes(item.properties[field] as string),
      );
    const at = (id: string) =>
      built.versions
        .get(id)!
        .filter((v) => v.validFrom <= world.readAt)
        .sort((a, b) => b.validFrom - a.validFrom)[0]!.record;
    const failing = (id: string) => built.versions.get(id)!.some((v) => !passes(v.record));
    const cites = (item: Entity): string[] => {
      const out: string[] = [];
      const fields =
        item.type === 'notes.note' ? NOTE_REFS : item.type === 'notes.tag' ? ['subject'] : [];
      for (const field of fields) {
        if (!releasedField(item.type, field)) continue;
        const value = item.properties[field];
        if (typeof value === 'string') out.push(value);
        if (Array.isArray(value)) out.push(...(value as string[]));
      }
      return out;
    };
    const released = new Set(
      built.entityIds.filter((id) => {
        const item = at(id) as Entity;
        return (
          releasedType(item.type) &&
          !failing(id) &&
          !(jsonWithholds && item.properties['blob'] !== undefined)
        );
      }),
    );
    for (let changed = true; changed;) {
      changed = false;
      for (const id of [...released])
        if (cites(at(id) as Entity).some((target) => !released.has(target))) {
          released.delete(id);
          changed = true;
        }
    }
    const relations = [...built.versions.keys()]
      .filter((id) => id.startsWith('l') || id.startsWith('g'))
      .filter((id) => {
        const item = at(id) as Relation;
        return (
          releasedType(item.type) &&
          !failing(id) &&
          released.has(item.from) &&
          released.has(item.to)
        );
      });
    return { entities: [...released].sort(), relations: relations.sort() };
  }

  it('no snapshot, query, export or history output reveals a withheld id or value', () => {
    for (const seed of [11, 23, 37]) {
      openWorlds(notes, (engine) => {
        let run = 0;
        fc.assert(
          fc.property(arbWorld, (world) => {
            const built = build(world);
            const target = { world: `world-${seed}-${++run}`, branch: 'main' };
            seedWorld(engine, target.world, built.steps);
            const where: RecordFilter = {
              'notes.note': {
                visibility: world.where.note,
                ...(world.where.topic === undefined ? {} : { topic: world.where.topic }),
              },
              'notes.person': { visibility: world.where.person },
              'notes.links': { status: world.where.links },
            };
            const request = { timeline: 'day', validAt: world.readAt };
            const policy: ExportPolicy = {
              types: world.exportTypes,
              fields: Object.fromEntries(
                world.exportTypes.map((type) => [type, world.exportFields[type]!]),
              ),
              where,
            };
            const everything = model(
              world,
              built,
              where,
              () => true,
              () => true,
              true,
            );
            const exportable = model(
              world,
              built,
              where,
              (type) => world.exportTypes.includes(type),
              (type, field) => world.exportFields[type]?.includes(field) ?? false,
              false,
            );
            const read = engine.snapshot(target, { ...request, where }).snapshot;
            const queried = engine.query(target, {
              ...request,
              where,
              from: built.entityIds,
              via: ['notes.links', 'notes.tagged'],
              maxDepth: 8,
              limit: 500,
            });
            const exported = engine.exportSnapshot(target, request, policy).snapshot;
            for (const [output, expected] of [
              [read, everything],
              [
                { entities: queried.entities, relations: [] },
                { ...everything, relations: [] },
              ],
              [exported, exportable],
            ] as const) {
              assert.deepEqual(sortedIds(output.entities), expected.entities);
              assert.deepEqual(sortedIds(output.relations), expected.relations);
              const shown = new Set([...expected.entities, ...expected.relations]);
              const hidden = [...built.versions.keys()].filter((id) => !shown.has(id));
              assertAbsent(
                [output],
                [...hidden, ...hidden.flatMap((id) => built.tokens.get(id) ?? [])],
              );
            }
            assert.throws(() => engine.history(target, { limit: 5, where }), /record filter/);
            assert.throws(
              () => engine.snapshot(target, { ...request, revision: 0, where }),
              /head revision/,
            );
          }),
          { seed, numRuns: 40 },
        );
      });
    }
  });
});
