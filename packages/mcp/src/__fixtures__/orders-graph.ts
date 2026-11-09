/**
 * A hand-built graph for the budget and affected-test tests.
 *
 * Small enough to read in one screen, wide enough that a token budget has
 * something to cut. Everything carries explicit provenance, because which edges
 * are facts is the point of several tests.
 */

import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { makeEdge, makeNode } from '../testing.ts';

// -- the data and contract side: a column with joins, a table, direct queries --

export const table = makeNode({ kind: 'Table', canonicalName: 'public.orders' });
export const column = makeNode({ kind: 'Column', canonicalName: 'public.orders.total', props: { nullable: false } });
export const repoA = makeNode({ kind: 'Symbol', canonicalName: 'Repo.a', path: 'src/repo.ts' });
export const repoB = makeNode({ kind: 'Symbol', canonicalName: 'Repo.b', path: 'src/repo.ts' });
export const repoC = makeNode({ kind: 'Symbol', canonicalName: 'Repo.c', path: 'src/repo.ts' });
export const codeField = makeNode({ kind: 'CodeField', canonicalName: 'Order.total', path: 'src/order.ts' });
export const schemaProp = makeNode({ kind: 'SchemaProperty', canonicalName: 'OrderDto#/total' });
export const validateTotal = makeNode({ kind: 'Symbol', canonicalName: 'validateTotal', path: 'src/dto.ts' });

// -- the code side: a service, its caller, and files that import each other --

export const serviceFile = makeNode({ kind: 'File', canonicalName: 'src/orders/service.ts', path: 'src/orders/service.ts' });
export const handlerFile = makeNode({ kind: 'File', canonicalName: 'src/orders/handler.ts', path: 'src/orders/handler.ts' });
export const createOrder = makeNode({ kind: 'Symbol', canonicalName: 'createOrder', path: 'src/orders/service.ts' });
export const priceOrder = makeNode({ kind: 'Symbol', canonicalName: 'priceOrder', path: 'src/orders/service.ts' });
export const postOrder = makeNode({ kind: 'Symbol', canonicalName: 'postOrder', path: 'src/orders/handler.ts' });
export const unrelated = makeNode({ kind: 'Symbol', canonicalName: 'unrelated', path: 'src/other.ts' });

// -- tests --

export const testCreates = makeNode({
  kind: 'TestCase',
  canonicalName: 'tests/orders/service.test.ts::creates an order',
  path: 'tests/orders/service.test.ts',
});
export const testPosts = makeNode({
  kind: 'TestCase',
  canonicalName: 'tests/orders/handler.test.ts::posts an order',
  path: 'tests/orders/handler.test.ts',
});
export const testGuessed = makeNode({
  kind: 'TestCase',
  canonicalName: 'tests/guess.test.ts::prices an order',
  path: 'tests/guess.test.ts',
});
// Named after the thing it claims to test, wired to nothing. A name is not evidence.
export const testNamedOnly = makeNode({
  kind: 'TestCase',
  canonicalName: 'tests/names.test.ts::createOrder works',
  path: 'tests/names.test.ts',
});

export const NODES: readonly SeamlineNode[] = [
  table, column, repoA, repoB, repoC, codeField, schemaProp, validateTotal,
  serviceFile, handlerFile, createOrder, priceOrder, postOrder, unrelated,
  testCreates, testPosts, testGuessed, testNamedOnly,
];

const fact = (kind: SeamlineEdge['kind'], src: SeamlineNode, dst: SeamlineNode): SeamlineEdge =>
  makeEdge({ kind, src: src.id, dst: dst.id, provenance: 'EXTRACTED', confidence: 1 });
const guess = (kind: SeamlineEdge['kind'], src: SeamlineNode, dst: SeamlineNode): SeamlineEdge =>
  makeEdge({ kind, src: src.id, dst: dst.id, provenance: 'INFERRED', confidence: 0.7 });

export const EDGES: readonly SeamlineEdge[] = [
  fact('CONTAINS', table, column),
  fact('QUERIES', repoA, table),
  fact('QUERIES', repoB, table),
  fact('QUERIES', repoC, table),
  guess('MAPS_TO_FIELD', column, codeField),
  guess('EXPOSED_AS', column, schemaProp),
  fact('VALIDATED_BY', schemaProp, validateTotal),

  fact('CONTAINS', serviceFile, createOrder),
  fact('CONTAINS', serviceFile, priceOrder),
  fact('CONTAINS', handlerFile, postOrder),
  fact('IMPORTS', handlerFile, serviceFile),
  fact('CALLS', postOrder, createOrder),
  fact('CALLS', createOrder, priceOrder),

  fact('TESTS', testCreates, createOrder),
  fact('TESTS', testPosts, postOrder),
  // An inferred link from a test to a symbol: a proposal at best, never a justification.
  guess('TESTS', testGuessed, priceOrder),
];

// -- extra material for the context budget: a field with a container, direct facts, joins and farther hops --
//
// Kept apart from NODES/EDGES because the byte-identity goldens were recorded over those, and adding a
// reachable node to them would change what the unbudgeted tools return for the same call.

export const orderClass = makeNode({ kind: 'Symbol', canonicalName: 'Order', path: 'src/order.ts' });
export const money = makeNode({ kind: 'Symbol', canonicalName: 'Money', path: 'src/money.ts' });
export const currency = makeNode({ kind: 'Symbol', canonicalName: 'Currency', path: 'src/money.ts' });

export const BUDGET_NODES: readonly SeamlineNode[] = [...NODES, orderClass, money, currency];
export const BUDGET_EDGES: readonly SeamlineEdge[] = [
  ...EDGES,
  fact('CONTAINS', orderClass, codeField),
  fact('USES_TYPE', codeField, money),
  fact('USES_TYPE', codeField, currency),
];
