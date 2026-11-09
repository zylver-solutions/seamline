/**
 * Cross-package regression coverage for RouteHandler naming agreement.
 *
 * `extract-code-ts` names every `RouteHandler` node `"METHOD /path"`, using
 * whatever colon-param syntax the framework itself uses (`:id`).
 * `extract-contracts` used to name a `RouteHandler` after a vendor-extension
 * handler string when one was present (`"UserController.getUser"`, using
 * OpenAPI's own `{id}` brace syntax when it fell back to a raw path at all) --
 * and emitted no `RouteHandler` whatsoever when no vendor extension was
 * present. Either way, `OPERATION_TO_SYMBOL`
 * (`packages/contradictions/src/joins.ts`, `[out('IMPLEMENTED_BY'),
 * into('HANDLES_ROUTE')]`) had nothing to land on: the `IMPLEMENTED_BY` edge
 * and the `HANDLES_ROUTE` edge pointed at two different `RouteHandler` node
 * ids (or the contracts side didn't exist at all), so the join dangled
 * silently and both extractors still reported PASS.
 *
 * This suite runs both real extractors over one small fixture repo -- a tiny
 * OpenAPI document plus a real Express-style route registration -- and walks
 * the join exactly the way `OPERATION_TO_SYMBOL` does, asserting the
 * `IMPLEMENTED_BY` edge and the `HANDLES_ROUTE` edge for the same real route
 * land on the SAME `RouteHandler` node id. Three sub-cases: `/users/{id}` has
 * no vendor extension (the majority-case total gap); `/accounts/{id}` has
 * `x-openapi-router-controller` + `operationId` (the vendor-string-identity
 * mismatch); `/profiles/{id}/` has a trailing slash the OpenAPI document
 * declares but the registered route does not (extract-code-ts's
 * `normalizeRoutePath` trims it; `extract-contracts`'s
 * `openApiPathToRouteParams` must trim it the same way, or this exact join
 * dangles again for any trailing-slash path).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { extractCodeTs } from '@seamline/extract-code-ts';
import { extractContracts } from '@seamline/extract-contracts';

const REPO = 'joinfixture';
const RUN = 'run-1';

const PACKAGE_JSON = JSON.stringify({ name: '@fixture/join', version: '1.0.0', type: 'module' }, null, 2);

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src'],
  },
  null,
  2,
);

const ROUTES_TS = `interface Router {
  get(path: string, handler: (id: string) => unknown): void;
}

declare const app: Router;

export function getUser(id: string): unknown {
  return { id };
}

export function getAccount(id: string): unknown {
  return { id };
}

export function getProfile(id: string): unknown {
  return { id };
}

app.get('/users/:id', getUser);
app.get('/accounts/:id', getAccount);
app.get('/profiles/:id', getProfile);
`;

const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: Join Fixture API
  version: 1.0.0
paths:
  /users/{id}:
    get:
      operationId: getUser
      responses:
        '200':
          description: ok
  /accounts/{id}:
    get:
      operationId: getAccount
      x-openapi-router-controller: AccountController
      responses:
        '200':
          description: ok
  /profiles/{id}/:
    get:
      operationId: getProfile
      responses:
        '200':
          description: ok
`;

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'seamline-route-join-'));
  const files: Record<string, string> = {
    'package.json': PACKAGE_JSON,
    'tsconfig.json': TSCONFIG,
    'src/routes.ts': ROUTES_TS,
    'openapi.yaml': OPENAPI_YAML,
  };
  for (const rel of Object.keys(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, files[rel] as string, 'utf8');
  }
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function edgesOfKind(edges: readonly SeamlineEdge[], kind: SeamlineEdge['kind']): readonly SeamlineEdge[] {
  return edges.filter((e) => e.kind === kind);
}

function nodeById(nodes: readonly SeamlineNode[], id: string): SeamlineNode | undefined {
  return nodes.find((n) => (n.id as string) === id);
}

/**
 * Walk the join the way `OPERATION_TO_SYMBOL`'s first hop does:
 * `[out('IMPLEMENTED_BY'), into('HANDLES_ROUTE')]`. Returns the `Symbol` node
 * ids reachable from the given `Operation` node id, or an empty array if the
 * join dangles.
 */
function operationToSymbols(
  operationId: string,
  contractEdges: readonly SeamlineEdge[],
  codeEdges: readonly SeamlineEdge[],
): { readonly routeHandlerIds: readonly string[]; readonly symbolIds: readonly string[] } {
  const implementedBy = edgesOfKind(contractEdges, 'IMPLEMENTED_BY').filter((e) => e.src === operationId);
  const routeHandlerIds = implementedBy.map((e) => e.dst as string);
  const handlesRoute = edgesOfKind(codeEdges, 'HANDLES_ROUTE');
  const symbolIds = handlesRoute
    .filter((e) => routeHandlerIds.includes(e.dst as string))
    .map((e) => e.src as string);
  return { routeHandlerIds, symbolIds };
}

test('IMPLEMENTED_BY and HANDLES_ROUTE resolve to one shared RouteHandler node (no vendor extension)', () => {
  const contracts = extractContracts({ repoRoot: root, repo: REPO, runId: RUN });
  const code = extractCodeTs({ repoRoot: root, repo: REPO, runId: RUN, deterministic: true });

  assert.equal(contracts.result.status, 'PASS');
  assert.equal(code.result.status, 'PASS');

  const operationId = `${REPO}:Operation:GET /users/{id}`;
  assert.ok(nodeById(contracts.nodes, operationId), `expected Operation node ${operationId}`);

  const { routeHandlerIds, symbolIds } = operationToSymbols(operationId, contracts.edges, code.edges);

  // The dangling-join bug: extract-contracts previously emitted no
  // RouteHandler/IMPLEMENTED_BY at all when no vendor extension was present.
  assert.equal(routeHandlerIds.length, 1, 'exactly one RouteHandler implements this operation');
  const routeHandlerId = routeHandlerIds[0] as string;

  // extract-code-ts's own RouteHandler for the real Express route, reached
  // independently (not via the join under test), to prove it is the SAME id.
  const codeRouteHandler = nodeById(code.nodes, `${REPO}:RouteHandler:GET /users/:id`);
  assert.ok(codeRouteHandler, 'extract-code-ts must have emitted GET /users/:id');
  assert.equal(routeHandlerId, codeRouteHandler?.id, 'the two extractors must converge on one RouteHandler id');

  // The real join: HANDLES_ROUTE into that same RouteHandler id resolves to
  // the real handler Symbol, not a dangling reference.
  assert.equal(symbolIds.length, 1, 'exactly one Symbol handles this route');
  const symbol = nodeById(code.nodes, symbolIds[0] as string);
  assert.ok(symbol, 'the resolved Symbol id must be a real node');
  assert.equal(symbol?.kind, 'Symbol');
  assert.equal(symbol?.name, 'getUser');
});

test('IMPLEMENTED_BY and HANDLES_ROUTE resolve to one shared RouteHandler node (vendor extension present)', () => {
  const contracts = extractContracts({ repoRoot: root, repo: REPO, runId: RUN });
  const code = extractCodeTs({ repoRoot: root, repo: REPO, runId: RUN, deterministic: true });

  const operationId = `${REPO}:Operation:GET /accounts/{id}`;
  assert.ok(nodeById(contracts.nodes, operationId), `expected Operation node ${operationId}`);

  const { routeHandlerIds, symbolIds } = operationToSymbols(operationId, contracts.edges, code.edges);

  assert.equal(routeHandlerIds.length, 1, 'exactly one RouteHandler implements this operation');
  const routeHandler = nodeById(contracts.nodes, routeHandlerIds[0] as string);
  assert.ok(routeHandler);
  // Identity is method+path, byte-identical to extract-code-ts's own name --
  // NOT the vendor handler string ("AccountController.getAccount").
  assert.equal(routeHandler?.id, `${REPO}:RouteHandler:GET /accounts/:id`);
  // The vendor extension's binding string survives as provenance, not identity.
  assert.equal(routeHandler?.props['declaredHandler'], 'AccountController.getAccount');

  const codeRouteHandler = nodeById(code.nodes, `${REPO}:RouteHandler:GET /accounts/:id`);
  assert.ok(codeRouteHandler);
  assert.equal(routeHandler?.id, codeRouteHandler?.id);

  assert.equal(symbolIds.length, 1, 'exactly one Symbol handles this route');
  const symbol = nodeById(code.nodes, symbolIds[0] as string);
  assert.ok(symbol);
  assert.equal(symbol?.kind, 'Symbol');
  assert.equal(symbol?.name, 'getAccount');
});

test('IMPLEMENTED_BY and HANDLES_ROUTE resolve to one shared RouteHandler node (OpenAPI path has a trailing slash the registered route does not)', () => {
  const contracts = extractContracts({ repoRoot: root, repo: REPO, runId: RUN });
  const code = extractCodeTs({ repoRoot: root, repo: REPO, runId: RUN, deterministic: true });

  const operationId = `${REPO}:Operation:GET /profiles/{id}/`;
  assert.ok(nodeById(contracts.nodes, operationId), `expected Operation node ${operationId}`);

  const { routeHandlerIds, symbolIds } = operationToSymbols(operationId, contracts.edges, code.edges);

  assert.equal(routeHandlerIds.length, 1, 'exactly one RouteHandler implements this operation');
  const routeHandler = nodeById(contracts.nodes, routeHandlerIds[0] as string);
  assert.ok(routeHandler);
  // extract-code-ts's normalizeRoutePath trims the trailing slash off the
  // registered route; openApiPathToRouteParams must trim the OpenAPI path's
  // trailing slash the same way, or the two ids diverge on this input shape.
  assert.equal(routeHandler?.id, `${REPO}:RouteHandler:GET /profiles/:id`);

  const codeRouteHandler = nodeById(code.nodes, `${REPO}:RouteHandler:GET /profiles/:id`);
  assert.ok(codeRouteHandler);
  assert.equal(routeHandler?.id, codeRouteHandler?.id);

  assert.equal(symbolIds.length, 1, 'exactly one Symbol handles this route');
  const symbol = nodeById(code.nodes, symbolIds[0] as string);
  assert.ok(symbol);
  assert.equal(symbol?.kind, 'Symbol');
  assert.equal(symbol?.name, 'getProfile');
});
