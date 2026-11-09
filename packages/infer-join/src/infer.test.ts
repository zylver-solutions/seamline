import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { EdgeKind, NodeId, SeamlineEdge } from '@seamline/ontology';
import { assertWithinCeiling } from '@seamline/ontology';

import { inferJoins, toExtractorResult } from './infer.ts';
import { INFER_JOIN_MANIFEST, guardProvenance } from './manifest.ts';
import { buildEdge, compareEdges } from './emit.ts';
import type { MemoryGraph } from './test-graph.ts';
import {
  addBareSymbol, addContract, addLoweredSchema, addSymbol, addTable, makeEdge, memoryGraph,
} from './test-graph.ts';

const RUN = 'run-1';

function edgesOfKind(edges: ReadonlyArray<SeamlineEdge>, kind: EdgeKind): ReadonlyArray<SeamlineEdge> {
  return edges.filter((e) => e.kind === kind);
}

function edgeBetween(
  edges: ReadonlyArray<SeamlineEdge>,
  kind: EdgeKind,
  src: NodeId,
  dst: NodeId,
): SeamlineEdge | undefined {
  return edges.find((e) => e.kind === kind && e.src === src && e.dst === dst);
}

/** A minimal but realistic repo: one table, one model class, one OpenAPI schema. */
function blogGraph(): {
  graph: MemoryGraph;
  columns: ReadonlyMap<string, ReturnType<typeof addTable>['columns'] extends ReadonlyMap<string, infer T> ? T : never>;
} {
  const graph = memoryGraph();
  const table = addTable(graph, {
    name: 'posts',
    path: 'db/schema.sql',
    columns: [
      { name: 'id', type: 'uuid' },
      { name: 'title', type: 'varchar(200)' },
      { name: 'scheduled_at', type: 'timestamptz', nullable: true },
    ],
  });
  return { graph, columns: table.columns };
}

describe('inferJoins: naming conventions', () => {
  it('joins a snake_case column to a field written in any convention', () => {
    for (const spelling of ['scheduled_at', 'scheduledAt', 'ScheduledAt', 'scheduled-at']) {
      const graph = memoryGraph();
      const table = addTable(graph, { name: 'posts', columns: [{ name: 'scheduled_at', type: 'timestamptz' }] });
      const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: spelling, type: 'Date' }] });
      const result = inferJoins(graph, { runId: RUN });

      const column = table.columns.get('scheduled_at')?.id;
      const field = model.fields.get(spelling)?.id;
      assert.ok(column !== undefined && field !== undefined);
      const edge = edgeBetween(result.edges, 'MAPS_TO_FIELD', column, field);
      assert.ok(edge !== undefined, `no edge for spelling ${spelling}`);
      assert.ok(edge.confidence > 0.85, `${spelling} confidence ${edge.confidence}`);
      const variant = edge.props['nameVariant'];
      assert.ok(variant === 'convention' || variant === 'identical', `variant ${String(variant)}`);
    }
  });

  it('joins a plural table to a singular class', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'categories', columns: [{ name: 'slug', type: 'text' }] });
    const model = addSymbol(graph, { name: 'Category', path: 'src/category.ts', fields: [{ name: 'slug', type: 'string' }] });
    const result = inferJoins(graph, { runId: RUN });

    const edge = edgeBetween(
      result.edges, 'MAPS_TO_FIELD',
      table.columns.get('slug')?.id as NodeId,
      model.fields.get('slug')?.id as NodeId,
    );
    assert.ok(edge !== undefined);
    assert.equal(edge.props['srcContainer'], 'categories');
    assert.equal(edge.props['dstContainer'], 'Category');
    assert.equal(edge.props['signalContainer'], 1);
  });

  it('does not join a table to a different affixed shape', () => {
    const graph = memoryGraph();
    addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    addSymbol(graph, { name: 'PostRow', path: 'src/rows.ts', fields: [{ name: 'title', type: 'string' }] });
    const result = inferJoins(graph, { runId: RUN });
    assert.equal(edgesOfKind(result.edges, 'MAPS_TO_FIELD').length, 0);
  });
});

describe('inferJoins: container gating', () => {
  it('does not join a same-named field on an unrelated container', () => {
    const graph = memoryGraph();
    addTable(graph, { name: 'posts', columns: [{ name: 'scheduled_at', type: 'timestamptz' }] });
    addSymbol(graph, { name: 'Invoice', path: 'src/invoice.ts', fields: [{ name: 'scheduledAt', type: 'Date' }] });
    const result = inferJoins(graph, { runId: RUN });
    assert.equal(edgesOfKind(result.edges, 'MAPS_TO_FIELD').length, 0);
    assert.equal(result.ambiguities.length, 0);
  });

  it('picks the right container when a name appears on several classes', () => {
    const graph = memoryGraph();
    const posts = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const post = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    addSymbol(graph, { name: 'Invoice', path: 'src/invoice.ts', fields: [{ name: 'title', type: 'string' }] });
    addSymbol(graph, { name: 'Attachment', path: 'src/attachment.ts', fields: [{ name: 'title', type: 'string' }] });
    const result = inferJoins(graph, { runId: RUN });

    const mapped = edgesOfKind(result.edges, 'MAPS_TO_FIELD');
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0]?.src, posts.columns.get('title')?.id);
    assert.equal(mapped[0]?.dst, post.fields.get('title')?.id);
  });
});

describe('inferJoins: type disagreement', () => {
  it('emits the edge and records the conflict, so X2 can find it', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'published_at', type: 'timestamptz' }] });
    const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'publishedAt', type: 'boolean' }] });
    const result = inferJoins(graph, { runId: RUN });

    const edge = edgeBetween(
      result.edges, 'MAPS_TO_FIELD',
      table.columns.get('published_at')?.id as NodeId,
      model.fields.get('publishedAt')?.id as NodeId,
    );
    assert.ok(edge !== undefined, 'a type conflict must not suppress the join');
    assert.equal(edge.props['typeConflict'], true);
    assert.equal(edge.props['typeAgreement'], 'conflict');
    assert.equal(edge.props['srcType'], 'timestamp');
    assert.equal(edge.props['dstType'], 'boolean');
    assert.equal(edge.props['signalType'], 0);
  });

  it('scores the conflicting join below the agreeing one', () => {
    const conflicting = memoryGraph();
    addTable(conflicting, { name: 'posts', columns: [{ name: 'published_at', type: 'timestamptz' }] });
    addSymbol(conflicting, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'publishedAt', type: 'boolean' }] });

    const agreeing = memoryGraph();
    addTable(agreeing, { name: 'posts', columns: [{ name: 'published_at', type: 'timestamptz' }] });
    addSymbol(agreeing, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'publishedAt', type: 'Date' }] });

    const bad = edgesOfKind(inferJoins(conflicting, { runId: RUN }).edges, 'MAPS_TO_FIELD')[0];
    const good = edgesOfKind(inferJoins(agreeing, { runId: RUN }).edges, 'MAPS_TO_FIELD')[0];
    assert.ok(bad !== undefined && good !== undefined);
    assert.ok(bad.confidence < good.confidence);
  });

  it('treats an unread type as neutral rather than as a conflict', () => {
    const graph = memoryGraph();
    addTable(graph, { name: 'posts', columns: [{ name: 'payload', type: 'SomeVendorType' }] });
    addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'payload', type: 'Whatever' }] });
    const edge = edgesOfKind(inferJoins(graph, { runId: RUN }).edges, 'MAPS_TO_FIELD')[0];
    assert.ok(edge !== undefined);
    assert.equal(edge.props['typeConflict'], false);
    assert.equal(edge.props['typeAgreement'], 'unknown');
  });
});

describe('inferJoins: structural corroboration', () => {
  it('raises confidence when a repository symbol queries the table', () => {
    const build = (withQuery: boolean): SeamlineEdge | undefined => {
      const graph = memoryGraph();
      const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
      const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
      if (withQuery) {
        graph.addEdge(makeEdge({ kind: 'QUERIES', src: model.symbol, dst: table.table }));
      }
      return edgesOfKind(inferJoins(graph, { runId: RUN }).edges, 'MAPS_TO_FIELD')[0];
    };
    const bare = build(false);
    const corroborated = build(true);
    assert.ok(bare !== undefined && corroborated !== undefined);
    assert.ok(corroborated.confidence > bare.confidence);
    assert.ok(corroborated.props['signalStructure'] !== undefined);
    assert.ok(Number(corroborated.props['signalStructure']) >= 0.5);
  });

  it('reads a column name off an ORM decorator', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'scheduled_at', type: 'timestamptz' }] });
    const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'scheduledAt', type: 'Date' }] });
    const decorator = addBareSymbol(graph, 'Column', { name: 'scheduled_at' }, 'src/post.ts');
    const field = model.fields.get('scheduledAt');
    assert.ok(field !== undefined);
    graph.addEdge(makeEdge({ kind: 'DECORATED_WITH', src: field, dst: decorator }));

    const edge = edgeBetween(
      inferJoins(graph, { runId: RUN }).edges, 'MAPS_TO_FIELD',
      table.columns.get('scheduled_at')?.id as NodeId, field.id,
    );
    assert.ok(edge !== undefined);
    assert.ok(Number(edge.props['signalStructure']) >= 0.6);
    assert.ok(edge.confidence > 0.93, `confidence ${edge.confidence}`);
  });
});

describe('inferJoins: ambiguity', () => {
  it('splits confidence across a two-way tie and records the group', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const model = addSymbol(graph, {
      name: 'Post',
      path: 'src/post.ts',
      fields: [{ name: 'title', type: 'string' }, { name: 'titles', type: 'string' }],
    });
    const result = inferJoins(graph, { runId: RUN });

    const mapped = edgesOfKind(result.edges, 'MAPS_TO_FIELD')
      .filter((e) => e.src === table.columns.get('title')?.id);
    assert.equal(mapped.length, 2);
    for (const edge of mapped) {
      assert.equal(edge.props['ambiguous'], true);
      assert.ok(edge.confidence <= 0.5, `confidence ${edge.confidence}`);
      assert.equal(edge.props['candidateCount'], 2);
      assert.ok(String(edge.props['ambiguityGroup']).includes(model.fields.get('titles')?.id ?? ''));
    }
    const tie = result.ambiguities.find((a) => a.reason === 'tie');
    assert.ok(tie !== undefined);
    assert.equal(tie.dropped, false);
    assert.equal(tie.edgeKind, 'MAPS_TO_FIELD');
  });

  it('emits nothing past the fanout cap and reports the top candidates', () => {
    // A class that carries both the snake and camel spellings of the same
    // field, four ways. Every one is an exact convention match to the column,
    // so no ranking can separate them and none should be asserted.
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'scheduled_at', type: 'timestamptz' }] });
    addSymbol(graph, {
      name: 'Post',
      path: 'src/post.ts',
      fields: [
        { name: 'scheduled_at', type: 'Date' },
        { name: 'scheduledAt', type: 'Date' },
        { name: 'ScheduledAt', type: 'Date' },
        { name: 'scheduled-at', type: 'Date' },
      ],
    });
    const result = inferJoins(graph, { runId: RUN });

    assert.equal(edgesOfKind(result.edges, 'MAPS_TO_FIELD').length, 0);
    const fanout = result.ambiguities.find((a) => a.reason === 'fanout');
    assert.ok(fanout !== undefined, 'the ambiguity must be recorded, not swallowed');
    assert.equal(fanout.dropped, true);
    assert.equal(fanout.subject, table.columns.get('scheduled_at')?.id);
    assert.equal(fanout.candidates.length, 3);
  });

  it('marks two columns contending for one field', () => {
    const graph = memoryGraph();
    addTable(graph, {
      name: 'posts',
      columns: [{ name: 'title', type: 'text' }, { name: 'titles', type: 'text' }],
    });
    addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    const result = inferJoins(graph, { runId: RUN });

    const mapped = edgesOfKind(result.edges, 'MAPS_TO_FIELD');
    assert.equal(mapped.length, 2);
    for (const edge of mapped) {
      assert.equal(edge.props['contended'], true);
      assert.equal(edge.props['claimants'], 2);
      assert.ok(edge.confidence < 0.5);
    }
    assert.ok(result.ambiguities.some((a) => a.reason === 'contention'));
  });
});

describe('inferJoins: contract joins', () => {
  it('produces the full column to field to property chain', () => {
    const { graph, columns } = blogGraph();
    const model = addSymbol(graph, {
      name: 'Post',
      path: 'src/post.ts',
      fields: [{ name: 'id', type: 'string' }, { name: 'title', type: 'string' }, { name: 'scheduledAt', type: 'Date' }],
    });
    const contract = addContract(graph, {
      document: 'openapi.yaml',
      object: 'Post',
      properties: [
        { name: 'id', type: 'string', format: 'uuid' },
        { name: 'title', type: 'string' },
        { name: 'scheduledAt', type: 'string', format: 'date-time' },
      ],
    });
    const result = inferJoins(graph, { runId: RUN });

    const column = columns.get('scheduled_at')?.id as NodeId;
    const field = model.fields.get('scheduledAt')?.id as NodeId;
    const property = contract.properties.get('scheduledAt')?.id as NodeId;

    assert.ok(edgeBetween(result.edges, 'MAPS_TO_FIELD', column, field));
    assert.ok(edgeBetween(result.edges, 'EXPOSED_AS', field, property));
    assert.ok(edgeBetween(result.edges, 'EXPOSED_AS', column, property));
    assert.ok(edgeBetween(result.edges, 'BACKED_BY', property, column));
  });

  it('resolves the schema object from the JSON pointer, not the document name', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const contract = addContract(graph, {
      document: 'contracts/openapi.yaml',
      object: 'Post',
      properties: [{ name: 'title', type: 'string' }],
    });
    const result = inferJoins(graph, { runId: RUN });
    const edge = edgeBetween(
      result.edges, 'EXPOSED_AS',
      table.columns.get('title')?.id as NodeId,
      contract.properties.get('title')?.id as NodeId,
    );
    assert.ok(edge !== undefined);
    assert.equal(edge.props['dstContainer'], 'Post');
  });

  it('emits BACKED_BY and EXPOSED_AS as one decision at one confidence', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const contract = addContract(graph, {
      document: 'openapi.yaml', object: 'Post', properties: [{ name: 'title', type: 'string' }],
    });
    const result = inferJoins(graph, { runId: RUN });
    const column = table.columns.get('title')?.id as NodeId;
    const property = contract.properties.get('title')?.id as NodeId;
    const exposed = edgeBetween(result.edges, 'EXPOSED_AS', column, property);
    const backed = edgeBetween(result.edges, 'BACKED_BY', property, column);
    assert.ok(exposed !== undefined && backed !== undefined);
    assert.equal(exposed.confidence, backed.confidence);
    assert.equal(backed.props['inverseOf'], 'EXPOSED_AS');
  });
});

describe('inferJoins: VALIDATED_BY', () => {
  it('reads a class-validator decorator as a validator', () => {
    const graph = memoryGraph();
    const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    const decorator = addBareSymbol(graph, 'IsString', {}, 'src/post.ts');
    const field = model.fields.get('title');
    assert.ok(field !== undefined);
    graph.addEdge(makeEdge({ kind: 'DECORATED_WITH', src: field, dst: decorator }));

    const result = inferJoins(graph, { runId: RUN });
    const edge = edgeBetween(result.edges, 'VALIDATED_BY', field.id, decorator.id);
    assert.ok(edge !== undefined);
    assert.equal(edge.confidence, 0.9);
    assert.equal(edge.props['rule'], 'validator-decorator');
  });

  it('does not treat an ordinary decorator as a validator', () => {
    const graph = memoryGraph();
    const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    const decorator = addBareSymbol(graph, 'Memoize', {}, 'src/post.ts');
    const field = model.fields.get('title');
    assert.ok(field !== undefined);
    graph.addEdge(makeEdge({ kind: 'DECORATED_WITH', src: field, dst: decorator }));
    assert.equal(edgesOfKind(inferJoins(graph, { runId: RUN }).edges, 'VALIDATED_BY').length, 0);
  });

  it('joins a schema object to the field, property and column it constrains', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    const contract = addContract(graph, {
      document: 'openapi.yaml', object: 'Post', properties: [{ name: 'title', type: 'string' }],
    });
    const validator = addSymbol(graph, {
      name: 'PostSchema',
      path: 'src/post.schema.ts',
      props: { symbolKind: 'variable', library: 'zod' },
      fields: [{ name: 'title', type: 'string' }],
    });
    const result = inferJoins(graph, { runId: RUN });

    for (const subject of [
      model.fields.get('title')?.id,
      contract.properties.get('title')?.id,
      table.columns.get('title')?.id,
    ]) {
      assert.ok(subject !== undefined);
      const edge = edgeBetween(result.edges, 'VALIDATED_BY', subject, validator.symbol.id);
      assert.ok(edge !== undefined, `no VALIDATED_BY from ${subject}`);
      assert.equal(edge.props['rule'], 'validator-correspondence');
    }
  });

  it('keeps validator members out of the data joins', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    addSymbol(graph, {
      name: 'PostSchema', path: 'src/post.schema.ts', props: { symbolKind: 'variable', library: 'zod' },
      fields: [{ name: 'title', type: 'string' }],
    });
    const mapped = edgesOfKind(inferJoins(graph, { runId: RUN }).edges, 'MAPS_TO_FIELD');
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0]?.src, table.columns.get('title')?.id);
    assert.equal(mapped[0]?.dst, model.fields.get('title')?.id);
    assert.equal(mapped[0]?.props['ambiguous'], false);
  });

  // The pair below mirrors what extract-code-ts emits: an interface is a
  // Symbol with `symbolKind: 'interface'`, and a Zod object value is a Symbol
  // with `symbolKind: 'variable'` and `library: 'zod'`.
  it('fires for a Zod object value whose members match a model field', () => {
    const graph = memoryGraph();
    const row = addSymbol(graph, {
      name: 'Row', path: 'src/row.ts', props: { symbolKind: 'interface' },
      fields: [{ name: 'nullable', type: 'boolean' }],
    });
    const schema = addSymbol(graph, {
      name: 'RowSchema', path: 'src/row.ts', props: { symbolKind: 'variable', library: 'zod' },
      fields: [{ name: 'nullable', type: 'boolean' }],
    });
    const nullable = row.fields.get('nullable');
    assert.ok(nullable !== undefined);

    const validated = edgesOfKind(inferJoins(graph, { runId: RUN }).edges, 'VALIDATED_BY');
    assert.equal(validated.length, 1);
    assert.equal(validated[0]?.src, nullable.id);
    assert.equal(validated[0]?.dst, schema.symbol.id);
    assert.equal(validated[0]?.props['rule'], 'validator-correspondence');
  });

  it('does not fire for an interface whose name ends in a validation word', () => {
    for (const name of ['RowConstraints', 'RowSchema', 'RowRule', 'RowValidator']) {
      const graph = memoryGraph();
      addSymbol(graph, {
        name: 'Row', path: 'src/row.ts', props: { symbolKind: 'interface' },
        fields: [{ name: 'nullable', type: 'boolean' }],
      });
      addSymbol(graph, {
        name, path: 'src/row.ts', props: { symbolKind: 'interface' },
        fields: [{ name: 'nullable', type: 'boolean' }],
      });
      const result = inferJoins(graph, { runId: RUN });
      assert.deepEqual(edgesOfKind(result.edges, 'VALIDATED_BY'), [], name);
    }
  });
});

describe('inferJoins: VALIDATED_BY from a lowered schema value', () => {
  // `extract-code-ts` emits a Zod object value as a Symbol with no member
  // CodeFields; `extract-contracts` lowers the same value to a Contract of the
  // same name in the same file. These fixtures mirror both.
  function rowGraph(): { graph: MemoryGraph; nullable: NodeId; schema: NodeId } {
    const graph = memoryGraph();
    const row = addSymbol(graph, {
      name: 'Row', path: 'src/row.ts', props: { symbolKind: 'interface' },
      fields: [{ name: 'nullable', type: 'boolean' }],
    });
    const schema = addBareSymbol(graph, 'RowSchema', { symbolKind: 'variable', library: 'zod' }, 'src/row.ts');
    const nullable = row.fields.get('nullable')?.id;
    assert.ok(nullable !== undefined);
    return { graph, nullable, schema: schema.id };
  }

  it('takes the members from the schema the value was lowered to', () => {
    const { graph, nullable, schema } = rowGraph();
    const pointer = '/properties/nullable';
    const lowered = addLoweredSchema(graph, {
      name: 'RowSchema', path: 'src/row.ts', dialect: 'zod', properties: [{ pointer, type: 'boolean' }],
    });
    const result = inferJoins(graph, { runId: RUN });

    const validated = edgesOfKind(result.edges, 'VALIDATED_BY');
    assert.deepEqual(validated.map((e) => [e.src, e.dst]), [[nullable, schema]]);
    assert.equal(validated[0]?.props['rule'], 'validator-correspondence');
    const member = lowered.properties.get(pointer)?.id;
    assert.ok(member !== undefined);
    assert.equal(validated.some((e) => e.src === member), false, 'a schema does not validate its own members');
    assert.deepEqual(result.diagnostics.filter((d) => d.startsWith('validator ')), []);
  });

  it('links a lowered schema only by the same name, the same file and a dialect equal to the library', () => {
    const variants = [
      { name: 'RowSchema', path: 'src/other.ts', dialect: 'zod' },
      { name: 'RowSchema', path: 'src/row.ts', dialect: 'openapi' },
      { name: 'RowInput', path: 'src/row.ts', dialect: 'zod' },
    ];
    for (const variant of variants) {
      const { graph, schema } = rowGraph();
      addLoweredSchema(graph, { ...variant, properties: [{ pointer: '/properties/nullable', type: 'boolean' }] });
      const result = inferJoins(graph, { runId: RUN });
      const label = JSON.stringify(variant);
      assert.deepEqual(edgesOfKind(result.edges, 'VALIDATED_BY').filter((e) => e.dst === schema), [], label);
      assert.ok(result.diagnostics.includes(
        `validator ${schema} declares no members; VALIDATED_BY not inferable from it`), label);
    }
  });

  it('reads only the top-level properties of the lowered schema as members', () => {
    const { graph, schema } = rowGraph();
    addLoweredSchema(graph, {
      name: 'RowSchema', path: 'src/row.ts', dialect: 'zod',
      properties: [
        { pointer: '/properties/title', type: 'string' },
        { pointer: '/properties/address/properties/nullable', type: 'boolean' },
      ],
    });
    const validated = edgesOfKind(inferJoins(graph, { runId: RUN }).edges, 'VALIDATED_BY');
    assert.deepEqual(validated.filter((e) => e.dst === schema), []);
  });
});

describe('inferJoins: provenance ceiling', () => {
  it('emits every edge at INFERRED and nothing above it', () => {
    const { graph } = blogGraph();
    addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    const result = inferJoins(graph, { runId: RUN });
    assert.ok(result.edges.length > 0);
    for (const edge of result.edges) assert.equal(edge.provenance, 'INFERRED');
  });

  it('throws if anything tries to claim EXTRACTED', () => {
    assert.throws(() => assertWithinCeiling(INFER_JOIN_MANIFEST, 'EXTRACTED'), /above its declared ceiling INFERRED/);
    assert.throws(() => guardProvenance('EXTRACTED'), /above its declared ceiling INFERRED/);
    assert.throws(() => guardProvenance('DECLARED'), /above its declared ceiling INFERRED/);
    assert.equal(guardProvenance('INFERRED'), 'INFERRED');
    assert.equal(guardProvenance('LLM_SUGGESTED'), 'LLM_SUGGESTED');
  });

  it('refuses to build an edge above the ceiling on the write path', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const model = addSymbol(graph, { name: 'Post', fields: [{ name: 'title', type: 'string' }] });
    const column = table.columns.get('title');
    const field = model.fields.get('title');
    assert.ok(column !== undefined && field !== undefined);

    assert.throws(
      () => buildEdge({
        kind: 'MAPS_TO_FIELD', src: column, dst: field, confidence: 0.9,
        props: {}, runId: RUN, provenance: 'EXTRACTED',
      }),
      /above its declared ceiling/,
    );
    assert.equal(
      buildEdge({ kind: 'MAPS_TO_FIELD', src: column, dst: field, confidence: 0.9, props: {}, runId: RUN }).provenance,
      'INFERRED',
    );
  });

  it('refuses an edge outside its declared domain and range', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const model = addSymbol(graph, { name: 'Post', fields: [{ name: 'title', type: 'string' }] });
    const column = table.columns.get('title');
    const field = model.fields.get('title');
    assert.ok(column !== undefined && field !== undefined);
    assert.throws(
      () => buildEdge({ kind: 'MAPS_TO_FIELD', src: field, dst: column, confidence: 0.9, props: {}, runId: RUN }),
      /not declared for CodeField -> Column/,
    );
  });
});

describe('inferJoins: determinism', () => {
  function fullGraph(reverse: boolean): MemoryGraph {
    const graph = memoryGraph();
    const columns = [
      { name: 'id', type: 'uuid' },
      { name: 'title', type: 'text' },
      { name: 'scheduled_at', type: 'timestamptz' },
    ];
    const fields = [
      { name: 'id', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'scheduledAt', type: 'Date' },
    ];
    const properties = [
      { name: 'id', type: 'string', format: 'uuid' },
      { name: 'title', type: 'string' },
      { name: 'scheduledAt', type: 'string', format: 'date-time' },
    ];
    if (reverse) {
      addContract(graph, { document: 'openapi.yaml', object: 'Post', properties: properties.slice().reverse() });
      addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: fields.slice().reverse() });
      addTable(graph, { name: 'posts', columns: columns.slice().reverse() });
    } else {
      addTable(graph, { name: 'posts', columns });
      addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields });
      addContract(graph, { document: 'openapi.yaml', object: 'Post', properties });
    }
    return graph;
  }

  it('produces byte-identical output regardless of node insertion order', () => {
    const forward = inferJoins(fullGraph(false), { runId: RUN });
    const reversed = inferJoins(fullGraph(true), { runId: RUN });
    assert.equal(JSON.stringify(forward.edges), JSON.stringify(reversed.edges));
    assert.equal(JSON.stringify(forward.ambiguities), JSON.stringify(reversed.ambiguities));
  });

  it('sorts edges by kind, then source, then target', () => {
    const result = inferJoins(fullGraph(false), { runId: RUN });
    const sorted = result.edges.slice().sort(compareEdges);
    assert.deepEqual(result.edges, sorted);
    assert.ok(result.edges.length >= 9);
  });

  it('sorts prop keys and writes no wall-clock value into an edge body', () => {
    const result = inferJoins(fullGraph(false), { runId: RUN });
    for (const edge of result.edges) {
      const keys = Object.keys(edge.props);
      assert.deepEqual(keys, keys.slice().sort());
      assert.equal(edge.firstSeenRun, RUN);
      assert.equal(edge.lastSeenRun, RUN);
      assert.equal(edge.deletedAt, null);
      for (const value of Object.values(edge.props)) {
        assert.notEqual(typeof value, 'undefined');
      }
    }
  });

  it('carries srcFile and dstFile so re-run invalidation can find the edge', () => {
    const result = inferJoins(fullGraph(false), { runId: RUN });
    const mapped = edgesOfKind(result.edges, 'MAPS_TO_FIELD')[0];
    assert.ok(mapped !== undefined);
    assert.equal(mapped.dstFile, 'src/post.ts');
  });
});

describe('inferJoins: lifecycle', () => {
  it('reports UNAVAILABLE and says so in a diagnostic when a source scope did not PASS', () => {
    const graph = memoryGraph({ contracts: 'FAIL' });
    addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    const result = inferJoins(graph, { runId: RUN });

    assert.equal(result.status, 'UNAVAILABLE');
    assert.deepEqual(result.degradedScopes, ['contracts']);
    assert.ok(result.diagnostics.some((d) => d.includes('contracts')));
    // Still emits what it could derive: degraded is not silent.
    assert.equal(edgesOfKind(result.edges, 'MAPS_TO_FIELD').length, 1);
  });

  it('reports PASS when every source scope passed', () => {
    const { graph } = blogGraph();
    const result = inferJoins(graph, { runId: RUN });
    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.degradedScopes, []);
  });

  it('ignores tombstoned nodes', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    const field = model.fields.get('title');
    assert.ok(field !== undefined);
    graph.addNode({ ...field, deletedAt: 'run-0' });
    const result = inferJoins(graph, { runId: RUN });
    assert.equal(edgesOfKind(result.edges, 'MAPS_TO_FIELD').length, 0);
    assert.ok(table.columns.get('title') !== undefined);
  });

  it('packages an ExtractorResult that never claims authority over node kinds', () => {
    const { graph } = blogGraph();
    const result = inferJoins(graph, { runId: RUN });
    const packaged = toExtractorResult(result, 12);
    assert.equal(packaged.extractor, 'infer-join');
    assert.equal(packaged.status, 'PASS');
    assert.equal(packaged.nodeCount, 0);
    assert.equal(packaged.edgeCount, result.edges.length);
    assert.deepEqual(packaged.authoritative[0]?.kinds, []);
  });
});

describe('inferJoins: empty and degenerate inputs', () => {
  it('returns nothing on an empty graph without throwing', () => {
    const result = inferJoins(memoryGraph(), { runId: RUN });
    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.ambiguities, []);
  });

  it('returns nothing when there is nothing to join to', () => {
    const graph = memoryGraph();
    addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    assert.deepEqual(inferJoins(graph, { runId: RUN }).edges, []);
  });

  it('honours an overridden threshold', () => {
    const graph = memoryGraph();
    addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    const strict = inferJoins(graph, { runId: RUN, thresholds: { minScore: 0.99 } });
    assert.deepEqual(strict.edges, []);
  });
});

// Exclusion is an automatic-join policy, not an assertion that the remaining
// declarations have a stored-row role. The input facts and statuses stay intact.
describe('inferJoins: application ownership boundaries', () => {
  const excluded = ['test', 'tests', '__tests__', 'fixture', 'fixtures', '__fixtures__', 'testdata', 'mock', 'mocks', '__mocks__', 'components', 'vendor', 'third_party', 'third-party'];
  for (const directory of excluded) {
    it(`does not map members declared under ${directory}`, () => {
      const graph = memoryGraph();
      addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
      const model = addSymbol(graph, { name: 'Post', path: `src/${directory}/post.ts`, fields: [{ name: 'title', type: 'string' }] });
      const result = inferJoins(graph, { runId: RUN });
      assert.equal(result.status, 'PASS');
      assert.equal(result.edges.length, 0);
      assert.ok(graph.node(model.symbol.id), 'excluded declarations remain facts');
    });
  }

  it('checks the owner as well as the member path', () => {
    for (const excludedOwner of [true, false]) {
      const graph = memoryGraph();
      addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
      const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
      const target = excludedOwner ? model.symbol : model.fields.get('title')!;
      graph.addNode({ ...target, path: 'src/fixtures/post.ts' });
      assert.equal(inferJoins(graph, { runId: RUN }).edges.length, 0, excludedOwner ? 'owner' : 'member');
    }
  });

  it('excludes both sides of column/property joins and their inverses', () => {
    for (const excludedSide of ['column', 'property', 'contract']) {
      const graph = memoryGraph();
      const table = addTable(graph, { name: 'posts', path: 'db/schema.sql', columns: [{ name: 'title', type: 'text' }] });
      const schema = addContract(graph, { document: 'api/post.json', object: 'Post', properties: [{ name: 'title', type: 'string' }] });
      const target = excludedSide === 'column' ? table.columns.get('title')! : excludedSide === 'property' ? schema.properties.get('title')! : schema.contract;
      graph.addNode({ ...target, path: 'fixtures/source.ts' });
      assert.equal(inferJoins(graph, { runId: RUN }).edges.length, 0, excludedSide);
    }
    const graph = memoryGraph();
    addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    addContract(graph, { document: 'api/post.json', object: 'Post', properties: [{ name: 'title', type: 'string' }] });
    const result = inferJoins(graph, { runId: RUN });
    assert.deepEqual(result.edges.map((e) => e.kind).sort(), ['BACKED_BY', 'EXPOSED_AS']);
  });

  it('excludes validator declarations and validator members in test material', () => {
    for (const memberOnly of [true, false]) {
      const graph = memoryGraph();
      addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
      const validator = addSymbol(graph, { name: 'PostSchema', path: 'src/post.schema.ts', props: { symbolKind: 'variable', library: 'zod' }, fields: [{ name: 'title', type: 'string' }] });
      const target = memberOnly ? validator.fields.get('title')! : validator.symbol;
      graph.addNode({ ...target, path: 'testdata/post.ts' });
      assert.equal(inferJoins(graph, { runId: RUN }).edges.length, 0, memberOnly ? 'member' : 'validator');
    }
  });

  it('recognizes bounded test suffixes without rejecting nearby application names or TSX', () => {
    for (const path of ['src/post.test.ts', 'src/post.spec.ts', 'src/post.fixture.ts', 'src/post.mock.ts']) {
      const graph = memoryGraph();
      addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
      addSymbol(graph, { name: 'Post', path, fields: [{ name: 'title', type: 'string' }] });
      assert.equal(inferJoins(graph, { runId: RUN }).edges.length, 0, path);
    }
    for (const path of ['src/contest/post.ts', 'src/testimony/post.ts', 'src/fixture-store/post.ts', 'src/post.tsx']) {
      const graph = memoryGraph();
      addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
      addSymbol(graph, { name: 'Post', path, fields: [{ name: 'title', type: 'string' }] });
      assert.equal(inferJoins(graph, { runId: RUN }).edges.length, 1, path);
    }
  });
});

it('preserves meaningful validator subject affixes while removing validation-only words', () => {
  for (const shape of ['PostRow', 'CreatePostInput', 'PostResponse']) {
    const graph = memoryGraph();
    const post = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    const model = addSymbol(graph, { name: shape, path: 'src/shape.ts', fields: [{ name: 'title', type: 'string' }] });
    const validator = addSymbol(graph, { name: `${shape}Schema`, path: 'src/schema.ts', props: { symbolKind: 'variable', library: 'zod' }, fields: [{ name: 'title', type: 'string' }] });
    const joins = inferJoins(graph, { runId: RUN }).edges.filter((e) => e.kind === 'VALIDATED_BY' && e.dst === validator.symbol.id);
    assert.deepEqual(joins.map((e) => e.src), [model.fields.get('title')!.id], shape);
    assert.ok(joins.every((e) => e.src !== post.fields.get('title')!.id));
  }
});

it('excludes validator decorator targets declared in non-application paths', () => {
  for (const path of ['src/fixtures/validators.ts', 'src/vendor/validators.ts', 'src/validators.test.ts']) {
    const graph = memoryGraph();
    const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'title', type: 'string' }] });
    const decorator = addBareSymbol(graph, 'IsString', {}, path);
    graph.addEdge(makeEdge({ kind: 'DECORATED_WITH', src: model.fields.get('title')!, dst: decorator }));
    assert.equal(inferJoins(graph, { runId: RUN }).edges.length, 0, path);
  }
});
