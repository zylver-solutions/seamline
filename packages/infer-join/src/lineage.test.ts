import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { NodeId, SeamlineNode } from '@seamline/ontology';
import { nodeId } from '@seamline/ontology';

import { lineage, lineageBetween } from './lineage.ts';
import { inferJoins } from './infer.ts';
import type { MemoryGraph } from './test-graph.ts';
import { addBareSymbol, addContract, addSymbol, addTable, makeEdge, memoryGraph } from './test-graph.ts';

/**
 * The canonical lineage the 10-minute acceptance gate is judged on:
 *
 *   posts.scheduled_at --MAPS_TO_FIELD 0.9--> Post.scheduledAt
 *                      --EXPOSED_AS    0.8--> Post/properties/scheduledAt
 *                      --VALIDATED_BY  0.7--> PostSchema
 */
interface Fixture {
  readonly graph: MemoryGraph;
  readonly column: SeamlineNode;
  readonly field: SeamlineNode;
  readonly property: SeamlineNode;
  readonly validator: SeamlineNode;
}

function chainFixture(): Fixture {
  const graph = memoryGraph();
  const table = addTable(graph, { name: 'posts', columns: [{ name: 'scheduled_at', type: 'timestamptz' }] });
  const model = addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'scheduledAt', type: 'Date' }] });
  const contract = addContract(graph, {
    document: 'openapi.yaml', object: 'Post',
    properties: [{ name: 'scheduledAt', type: 'string', format: 'date-time' }],
  });
  const validator = addBareSymbol(graph, 'PostSchema', { library: 'zod' }, 'src/post.schema.ts');

  const column = table.columns.get('scheduled_at');
  const field = model.fields.get('scheduledAt');
  const property = contract.properties.get('scheduledAt');
  assert.ok(column !== undefined && field !== undefined && property !== undefined);

  graph.addEdge(makeEdge({ kind: 'MAPS_TO_FIELD', src: column, dst: field, provenance: 'INFERRED', confidence: 0.9 }));
  graph.addEdge(makeEdge({ kind: 'EXPOSED_AS', src: field, dst: property, provenance: 'INFERRED', confidence: 0.8 }));
  graph.addEdge(makeEdge({ kind: 'VALIDATED_BY', src: property, dst: validator, provenance: 'INFERRED', confidence: 0.7 }));

  return { graph, column, field, property, validator };
}

function expectKnown<T>(result: { known: true; value: T } | { known: false; reason: string }): T {
  assert.ok(result.known, `expected a known result, got: ${result.known ? '' : result.reason}`);
  return result.value;
}

describe('lineage: forward walk', () => {
  it('walks column to field to property to validator, with per-hop provenance', () => {
    const { graph, column, field, property, validator } = chainFixture();
    const result = expectKnown(lineage(graph, column.id));

    assert.equal(result.startKind, 'Column');
    assert.equal(result.chains.length, 3);

    const toValidator = result.chains.find((c) => c.end === validator.id);
    assert.ok(toValidator !== undefined);
    assert.deepEqual(toValidator.hops.map((h) => h.kind), ['MAPS_TO_FIELD', 'EXPOSED_AS', 'VALIDATED_BY']);
    assert.deepEqual(toValidator.hops.map((h) => h.direction), ['out', 'out', 'out']);
    assert.deepEqual(toValidator.hops.map((h) => h.to), [field.id, property.id, validator.id]);
    for (const hop of toValidator.hops) {
      assert.equal(hop.provenance, 'INFERRED');
      assert.equal(hop.fact, false);
    }
    assert.deepEqual(toValidator.hops.map((h) => h.confidence), [0.9, 0.8, 0.7]);
  });

  it('aggregates a three-hop chain as the product, not as the last hop', () => {
    const { graph, column, field, property, validator } = chainFixture();
    const result = expectKnown(lineage(graph, column.id));
    const byEnd = new Map(result.chains.map((c) => [c.end, c]));

    assert.equal(byEnd.get(field.id)?.aggregate, 0.9);
    assert.equal(byEnd.get(property.id)?.aggregate, 0.72);
    assert.equal(byEnd.get(validator.id)?.aggregate, 0.504);
    assert.equal(byEnd.get(validator.id)?.weakestHop, 0.7);
  });

  it('is monotonically non-increasing along the chain', () => {
    const { graph, column } = chainFixture();
    const result = expectKnown(lineage(graph, column.id));
    const ordered = result.chains.slice().sort((a, b) => a.hops.length - b.hops.length);
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      assert.ok(previous !== undefined && current !== undefined);
      assert.ok(current.aggregate <= previous.aggregate);
    }
  });

  it('orders chains nearest first', () => {
    const { graph, column } = chainFixture();
    const result = expectKnown(lineage(graph, column.id));
    assert.deepEqual(result.chains.map((c) => c.hops.length), [1, 2, 3]);
  });
});

describe('lineage: reverse walk', () => {
  it('walks a schema property back to the column that carries it', () => {
    const { graph, column, field, property } = chainFixture();
    const result = expectKnown(lineage(graph, property.id));
    const back = result.chains.find((c) => c.end === column.id);
    assert.ok(back !== undefined);
    assert.deepEqual(back.hops.map((h) => h.kind), ['EXPOSED_AS', 'MAPS_TO_FIELD']);
    assert.deepEqual(back.hops.map((h) => h.direction), ['in', 'in']);
    assert.deepEqual(back.hops.map((h) => h.to), [field.id, column.id]);
    assert.equal(back.aggregate, 0.72);
  });

  it('reaches the same nodes forward and backward with the same aggregate', () => {
    const { graph, column, property } = chainFixture();
    const forward = expectKnown(lineage(graph, column.id)).chains.find((c) => c.end === property.id);
    const backward = expectKnown(lineage(graph, property.id)).chains.find((c) => c.end === column.id);
    assert.ok(forward !== undefined && backward !== undefined);
    assert.equal(forward.aggregate, backward.aggregate);
  });

  it('restricts to one direction on request', () => {
    const { graph, column, property } = chainFixture();
    const outOnly = expectKnown(lineage(graph, property.id, { direction: 'out' }));
    assert.equal(outOnly.chains.some((c) => c.end === column.id), false);
    const inOnly = expectKnown(lineage(graph, property.id, { direction: 'in' }));
    assert.ok(inOnly.chains.some((c) => c.end === column.id));
  });
});

describe('lineage: bounds and filters', () => {
  it('respects maxDepth and reports truncation', () => {
    const { graph, column, validator } = chainFixture();
    const shallow = expectKnown(lineage(graph, column.id, { maxDepth: 2 }));
    assert.equal(shallow.chains.some((c) => c.end === validator.id), false);
    assert.equal(shallow.truncated, true);

    const deep = expectKnown(lineage(graph, column.id, { maxDepth: 6 }));
    assert.equal(deep.truncated, false);
  });

  it('follows only the requested relations', () => {
    const { graph, column, field, property } = chainFixture();
    const result = expectKnown(lineage(graph, column.id, { via: ['MAPS_TO_FIELD'] }));
    assert.deepEqual(result.chains.map((c) => c.end), [field.id]);
    assert.equal(result.chains.some((c) => c.end === property.id), false);
  });

  it('factsOnly drops inferred hops, because gates read facts only', () => {
    const { graph, column } = chainFixture();
    const result = expectKnown(lineage(graph, column.id, { factsOnly: true }));
    assert.deepEqual(result.chains, []);
  });

  it('keeps a fact hop under factsOnly', () => {
    const { graph, column, field } = chainFixture();
    graph.addEdge(makeEdge({ kind: 'MAPS_TO_FIELD', src: column, dst: field, provenance: 'DECLARED', confidence: 1 }));
    const result = expectKnown(lineage(graph, column.id, { factsOnly: true }));
    assert.deepEqual(result.chains.map((c) => c.end), [field.id]);
    assert.equal(result.chains[0]?.hops[0]?.fact, true);
  });

  it('accepts an alternative aggregation model', () => {
    const { graph, column, validator } = chainFixture();
    const weakest = expectKnown(lineage(graph, column.id, { aggregation: { model: 'min' } }));
    assert.equal(weakest.chains.find((c) => c.end === validator.id)?.aggregate, 0.7);
  });

  it('does not revisit a node, so a cycle terminates', () => {
    const { graph, column, field } = chainFixture();
    graph.addEdge(makeEdge({ kind: 'MAPS_TO_FIELD', src: column, dst: field, provenance: 'INFERRED', confidence: 0.5 }));
    const result = expectKnown(lineage(graph, column.id));
    assert.equal(result.chains.filter((c) => c.end === field.id).length, 1);
    // Two parallel edges: the better one wins.
    assert.equal(result.chains.find((c) => c.end === field.id)?.aggregate, 0.9);
  });
});

describe('lineage: UNKNOWN semantics', () => {
  it('returns unknown for an empty walk when a source scope did not PASS', () => {
    const graph = memoryGraph({ 'code.ts': 'UNAVAILABLE' });
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const column = table.columns.get('title');
    assert.ok(column !== undefined);

    const result = lineage(graph, column.id);
    assert.equal(result.known, false);
    if (!result.known) {
      assert.deepEqual(result.scopes, ['code.ts']);
      assert.match(result.reason, /absence is not a finding/);
    }
  });

  it('returns a known but degraded result when the walk did find something', () => {
    const { graph, column } = chainFixture();
    graph.setScope('code.ts', 'FAIL');
    const result = expectKnown(lineage(graph, column.id));
    assert.deepEqual(result.degradedScopes, ['code.ts']);
    assert.ok(result.chains.length > 0);
  });

  it('returns an empty known result when every scope passed and there is genuinely nothing', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const column = table.columns.get('title');
    assert.ok(column !== undefined);
    const result = expectKnown(lineage(graph, column.id));
    assert.deepEqual(result.chains, []);
    assert.deepEqual(result.degradedScopes, []);
  });

  it('returns unknown for a node that is not in the graph', () => {
    const result = lineage(memoryGraph(), nodeId('demo', 'Column', 'nope') as NodeId);
    assert.equal(result.known, false);
  });

  it('ignores a tombstoned edge', () => {
    const { graph, column, field } = chainFixture();
    const dead = graph.allEdges.find((e) => e.kind === 'MAPS_TO_FIELD');
    assert.ok(dead !== undefined);
    graph.addEdge({ ...dead, deletedAt: 'run-0' });
    // The live edge is still there, so the chain still resolves once.
    const result = expectKnown(lineage(graph, column.id));
    assert.equal(result.chains.filter((c) => c.end === field.id).length, 1);
  });
});

describe('lineageBetween', () => {
  it('returns the single chain to a named endpoint', () => {
    const { graph, column, validator } = chainFixture();
    const found = lineageBetween(graph, column.id, validator.id);
    assert.ok(found.known);
    if (found.known) {
      assert.equal(found.value?.hops.length, 3);
      assert.equal(found.value?.aggregate, 0.504);
    }
  });

  it('returns undefined when the endpoint is unreachable', () => {
    const { graph, column } = chainFixture();
    const unrelated = addBareSymbol(graph, 'Unrelated', {}, 'src/other.ts');
    const found = lineageBetween(graph, column.id, unrelated.id);
    assert.ok(found.known);
    if (found.known) assert.equal(found.value, undefined);
  });
});

describe('lineage over inferred output', () => {
  it('renders a field-lineage map from a repo with zero declarations', () => {
    // The end-to-end shape of `seamline extract && seamline why`: infer the
    // joins, write them back, then walk them.
    const graph = memoryGraph();
    const table = addTable(graph, {
      name: 'posts', path: 'db/schema.sql',
      columns: [{ name: 'scheduled_at', type: 'timestamptz' }],
    });
    addSymbol(graph, { name: 'Post', path: 'src/post.ts', fields: [{ name: 'scheduledAt', type: 'Date' }] });
    addContract(graph, {
      document: 'openapi.yaml', object: 'Post',
      properties: [{ name: 'scheduledAt', type: 'string', format: 'date-time' }],
    });

    for (const edge of inferJoins(graph, { runId: 'run-1' }).edges) graph.addEdge(edge);

    const column = table.columns.get('scheduled_at');
    assert.ok(column !== undefined);
    const result = expectKnown(lineage(graph, column.id));

    const kinds = result.chains.map((c) => c.endKind).sort();
    assert.deepEqual(kinds, ['CodeField', 'SchemaProperty']);
    for (const chain of result.chains) {
      assert.ok(chain.aggregate > 0.5, `${chain.endKind} aggregate ${chain.aggregate}`);
      for (const hop of chain.hops) assert.equal(hop.provenance, 'INFERRED');
    }
  });
});
