/**
 * A route is extracted only when the receiver of `x.get('/path', ...)` is a
 * server router or app instance.
 *
 * Before this rule, any `.get`/`.post`/... call whose first argument started
 * with `/` became a `RouteHandler`, so an HTTP client call inside
 * `loadUsers()` was recorded as a server endpoint `GET /users` handled by
 * `loadUsers`. These tests pin both halves: the routes the extractor must keep
 * and the calls it must not mistake for routes.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { extractCodeTs } from './extract.ts';
import type { ExtractCodeTsOutput } from './extract.ts';
import {
  ROUTE_RECEIVER_INSTALLED_PROJECT,
  ROUTE_RECEIVER_PROJECT,
  cleanup,
  materialize,
} from './__fixtures__/projects.ts';

const roots: string[] = [];

function run(files: Readonly<Record<string, string>>, label: string): ExtractCodeTsOutput {
  const root = materialize(files, label);
  roots.push(root);
  return extractCodeTs({ repoRoot: root, repo: 'fixture', runId: 'run-1', deterministic: true });
}

const bare = run(ROUTE_RECEIVER_PROJECT, 'route-receiver');
const installed = run(ROUTE_RECEIVER_INSTALLED_PROJECT, 'route-receiver-installed');

after(() => {
  for (const root of roots) cleanup(root);
});

function routeNames(output: ExtractCodeTsOutput): readonly string[] {
  return output.nodes
    .filter((n) => n.kind === 'RouteHandler')
    .map((n) => n.name)
    .sort();
}

function handles(output: ExtractCodeTsOutput): readonly string[] {
  return output.edges
    .filter((e: SeamlineEdge) => e.kind === 'HANDLES_ROUTE')
    .map((e) => `${e.src} -> ${e.dst}`)
    .sort();
}

/** Symbols the extractor minted for an inline handler it could not otherwise name. */
function inlineHandlers(output: ExtractCodeTsOutput): readonly SeamlineNode[] {
  return output.nodes.filter(
    (n) => n.kind === 'Symbol' && n.props['symbolKind'] === 'route-handler',
  );
}

test('both fixtures extract as PASS', () => {
  assert.equal(bare.result.status, 'PASS');
  assert.equal(installed.result.status, 'PASS');
});

test('every registration on an express, fastify, hono, koa-router, or elysia instance is a route', () => {
  // A router built by `express.Router()` and by `Router()`, an app imported by
  // name or as a default export, a `require`d factory, a parameter or property
  // annotated with a server type, a cast, a chained registration, and one
  // instance of each other supported framework. None of the packages is
  // installed in this fixture.
  assert.deepEqual(routeNames(bare), [
    'DELETE /orders/:id',
    'GET /commonjs/items',
    'GET /elysia/items',
    'GET /fastify/items',
    'GET /hono/items',
    'GET /koa/items',
    'GET /orders',
    'GET /orders/:id',
    'GET /shapes/cast',
    'GET /shapes/default',
    'GET /shapes/first',
    'GET /shapes/property',
    'GET /shapes/second',
    'POST /orders',
  ]);
});

test('a named handler argument is the symbol that handles the route', () => {
  const edges = handles(bare);
  assert.ok(
    edges.includes('fixture:Symbol:@fixture/app#listOrders -> fixture:RouteHandler:GET /orders'),
  );
  assert.ok(
    edges.includes('fixture:Symbol:@fixture/app#showOrder -> fixture:RouteHandler:GET /orders/:id'),
  );
  assert.ok(
    edges.includes(
      'fixture:Symbol:@fixture/app#showOrder -> fixture:RouteHandler:DELETE /orders/:id',
    ),
  );
});

test('an HTTP client call inside loadUsers() is not a route and loadUsers handles nothing', () => {
  assert.ok(!routeNames(bare).includes('GET /users'));
  const fromLoadUsers = handles(bare).filter((e) =>
    e.startsWith('fixture:Symbol:@fixture/app#loadUsers '),
  );
  assert.deepEqual(fromLoadUsers, []);
});

test('calls on a Map, a plain object, a callback-taking client, supertest, and a foreign Router type are not routes', () => {
  const names = routeNames(bare);
  for (const route of [
    'GET /key',
    'GET /health',
    'GET /legacy/users',
    'GET /probe',
    'GET /lookalike',
    'POST /startup',
  ]) {
    assert.ok(!names.includes(route), `${route} was extracted as a route`);
  }
  // clients.ts holds only client calls, so nothing in it may handle a route.
  const clientEdges = handles(bare).filter(
    (e) =>
      e.includes('#loadUsers ') ||
      e.includes('#readThrough ') ||
      e.includes('#ping ') ||
      e.includes('#legacy ') ||
      e.includes('#probe ') ||
      e.includes('#navigate '),
  );
  assert.deepEqual(clientEdges, []);
});

test('a top-level client call mints no inline handler symbol; a top-level server registration does', () => {
  // `api.post('/startup', ...)` has no enclosing function, which is the case that
  // synthesizes a handler symbol named after the route.
  const names = inlineHandlers(bare)
    .map((n) => n.name)
    .sort();
  assert.deepEqual(names, [
    'GET /elysia/items',
    'GET /fastify/items',
    'GET /hono/items',
    'GET /koa/items',
    'POST /orders',
  ]);
});

test('with packages installed, a contextually typed server instance is a route', () => {
  assert.ok(routeNames(installed).includes('GET /plugin/items'));
});

test('with packages installed, a client type named Router is still not a server', () => {
  // `client-sdk` declares `interface Router`; the name alone is not evidence.
  assert.deepEqual(routeNames(installed), ['GET /plugin/items']);
  assert.deepEqual(handles(installed), [
    'fixture:Symbol:@fixture/app#plugin -> fixture:RouteHandler:GET /plugin/items',
  ]);
});

test('a module-scope registration in a file that starts with a declaration is handled by a synthesized symbol, not by that declaration', () => {
  // A source file starts at offset 0 and so does its first statement; before the file had a key of its own,
  // the walk up from `app.get(...)` reached the file, found `first` under the same key, and `first` handled `/health`.
  const output = run(
    {
      'package.json': ROUTE_RECEIVER_PROJECT['package.json'] as string,
      'tsconfig.json': ROUTE_RECEIVER_PROJECT['tsconfig.json'] as string,
      'src/server.ts': `export function first(): void {}

import express from 'express';

const app = express();
app.get('/health', (_req, res) => {
  res.send('ok');
});
`,
    },
    'route-first-declaration',
  );
  assert.equal(output.result.status, 'PASS');
  assert.deepEqual(routeNames(output), ['GET /health']);
  assert.deepEqual(handles(output), [
    'fixture:Symbol:@fixture/app#app.GET /health -> fixture:RouteHandler:GET /health',
  ]);
  assert.deepEqual(
    inlineHandlers(output).map((n) => n.name),
    ['GET /health'],
  );
});
