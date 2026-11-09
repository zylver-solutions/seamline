import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractContracts } from './extract.ts';
import { readHandler, resolveAuth } from './openapi.ts';
import { isJsonSchemaDocument } from './json-schema.ts';
import { makeTempRepo, nodeById, prop, type TempRepo } from './test-harness.ts';

const REPO = 'testrepo';
const RUN = 'run-1';
const PETSTORE = 'Petstore API';

function extractFixtures(repo: TempRepo) {
  return extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
}

test('the four auth states are distinguishable', () => {
  const explicitlyPublic = resolveAuth([], [{ bearerAuth: [] }]);
  assert.equal(explicitlyPublic.mode, 'none');
  assert.equal(explicitlyPublic.source, 'operation');

  const emptyRequirement = resolveAuth([{}], undefined);
  assert.equal(emptyRequirement.mode, 'none', 'security: [{}] is also explicitly public');

  const optional = resolveAuth([{}, { bearerAuth: [] }], undefined);
  assert.equal(optional.mode, 'optional');
  assert.deepEqual(optional.schemes, ['bearerAuth']);

  const required = resolveAuth([{ oauth2: ['pets:read', 'pets:write'] }], undefined);
  assert.equal(required.mode, 'required');
  assert.deepEqual(required.scopes, ['oauth2:pets:read', 'oauth2:pets:write']);

  const inherited = resolveAuth(undefined, [{ bearerAuth: [] }]);
  assert.equal(inherited.mode, 'required');
  assert.equal(inherited.source, 'document');

  const undeclared = resolveAuth(undefined, undefined);
  assert.equal(undeclared.mode, 'unknown', 'an omission is not an assertion of publicness');
  assert.equal(undeclared.source, 'absent');
  assert.notEqual(undeclared.mode, 'none');
});

test('a handler binding is only emitted when the document declares one', () => {
  assert.equal(readHandler({ 'x-seamline-handler': './src/a.ts#h' }, {}, 'op'), 'src/a.ts#h');
  assert.equal(readHandler({}, { 'x-openapi-router-controller': 'Pets' }, 'getPet'), 'Pets.getPet');
  assert.equal(readHandler({ 'x-eov-operation-handler': 'routes/pets' }, {}, 'getPet'), 'routes/pets.getPet');
  assert.equal(readHandler({ operationId: 'getPet' }, {}, 'getPet'), null, 'an operationId is a name, not a binding');
});

test('operations carry method, path, and the auth the document declared', () => {
  const repo = makeTempRepo();
  try {
    const { nodes, result } = extractFixtures(repo);
    assert.equal(result.status, 'PASS');

    const health = nodeById(nodes, `${REPO}:Operation:GET /health`);
    assert.equal(prop(health, 'method'), 'GET');
    assert.equal(prop(health, 'path'), '/health');
    assert.equal(prop(health, 'authMode'), 'none', 'security: [] means explicitly public');
    assert.equal(prop(health, 'authSource'), 'operation');
    assert.equal(prop(health, 'authSchemes'), undefined);

    const list = nodeById(nodes, `${REPO}:Operation:GET /pets`);
    assert.equal(prop(list, 'authMode'), 'required');
    assert.equal(prop(list, 'authSource'), 'document');
    assert.equal(prop(list, 'authSchemes'), 'bearerAuth');

    const create = nodeById(nodes, `${REPO}:Operation:POST /pets`);
    assert.equal(prop(create, 'authMode'), 'optional', 'an anonymous alternative admits a caller');

    const reports = nodeById(nodes, `${REPO}:Operation:GET /reports`);
    assert.equal(prop(reports, 'authMode'), 'unknown');
    assert.equal(prop(reports, 'authSource'), 'absent');

    const byPet = nodeById(nodes, `${REPO}:Operation:GET /pets/{petId}`);
    assert.equal(prop(byPet, 'operationId'), 'getPet');
    assert.equal(prop(byPet, 'handlerDeclared'), true);
    assert.equal(byPet.provenance, 'EXTRACTED');
    // An Operation id is path-free: the file is a property, not part of this id.
    assert.ok(!(byPet.id as string).includes('api/'));
    assert.equal(byPet.path, 'api/petstore.yaml');
  } finally {
    repo.dispose();
  }
});

test('every operation yields exactly one IMPLEMENTED_BY edge, RouteHandler keyed by method+path', () => {
  const repo = makeTempRepo();
  try {
    const { nodes, edges } = extractFixtures(repo);
    const implemented = edges.filter((e) => e.kind === 'IMPLEMENTED_BY');
    // Four operations in the petstore fixture plus one in no-security.yaml
    // (both live under the temp repo's `api/` dir), and every one now gets a
    // RouteHandler -- not only the one with a vendor extension.
    assert.equal(implemented.length, 5);

    // The operation WITH a vendor extension: RouteHandler identity is still
    // method+path (converged with extract-code-ts), and the vendor string
    // survives as the `declaredHandler` property, not as the node's identity.
    const withHandler = nodeById(nodes, `${REPO}:RouteHandler:GET /pets/:petId`);
    const byPetEdge = implemented.find((e) => e.src === `${REPO}:Operation:GET /pets/{petId}`);
    assert.equal(byPetEdge?.dst, withHandler.id);
    assert.equal(byPetEdge?.provenance, 'EXTRACTED');
    assert.equal(prop(withHandler, 'declaredHandler'), 'src/routes/pets.ts#getPet');

    // An operation with NO vendor extension (`GET /health`) still gets a
    // RouteHandler and an IMPLEMENTED_BY edge, from method+path alone.
    const noHandler = nodeById(nodes, `${REPO}:RouteHandler:GET /health`);
    const healthEdge = implemented.find((e) => e.src === `${REPO}:Operation:GET /health`);
    assert.equal(healthEdge?.dst, noHandler.id);
    assert.equal(prop(noHandler, 'declaredHandler'), undefined, 'no vendor extension means no declaredHandler');
  } finally {
    repo.dispose();
  }
});

test('required and nullable are independent axes, all four combinations distinct', () => {
  const repo = makeTempRepo();
  try {
    const { nodes } = extractFixtures(repo);
    const at = (name: string) =>
      nodeById(nodes, `${REPO}:SchemaProperty:${PETSTORE}#/components/schemas/Pet/properties/${name}`);

    // required, not nullable
    assert.equal(prop(at('id'), 'required'), true);
    assert.equal(prop(at('id'), 'nullable'), false);

    // required AND nullable
    assert.equal(prop(at('ownerId'), 'required'), true);
    assert.equal(prop(at('ownerId'), 'nullable'), true);

    // optional AND not nullable
    assert.equal(prop(at('tagCount'), 'required'), false);
    assert.equal(prop(at('tagCount'), 'nullable'), false);

    // optional AND nullable
    assert.equal(prop(at('retiredAt'), 'required'), false);
    assert.equal(prop(at('retiredAt'), 'nullable'), true);

    // The pair that must never be conflated: same required-ness, opposite
    // nullability, and vice versa.
    assert.notDeepEqual(
      [prop(at('tagCount'), 'required'), prop(at('tagCount'), 'nullable')],
      [prop(at('ownerId'), 'required'), prop(at('ownerId'), 'nullable')],
    );
    assert.notDeepEqual(
      [prop(at('retiredAt'), 'required'), prop(at('retiredAt'), 'nullable')],
      [prop(at('ownerId'), 'required'), prop(at('ownerId'), 'nullable')],
    );
  } finally {
    repo.dispose();
  }
});

test('schema properties carry the normalized category and their constraints', () => {
  const repo = makeTempRepo();
  try {
    const { nodes } = extractFixtures(repo);
    const at = (name: string) =>
      nodeById(nodes, `${REPO}:SchemaProperty:${PETSTORE}#/components/schemas/Pet/properties/${name}`);

    assert.equal(prop(at('id'), 'typeCategory'), 'uuid');
    assert.equal(prop(at('createdAt'), 'typeCategory'), 'timestamp');
    assert.equal(prop(at('createdAt'), 'format'), 'date-time');
    assert.equal(prop(at('tagCount'), 'typeCategory'), 'integer');
    assert.equal(prop(at('weight'), 'typeCategory'), 'numeric');
    assert.equal(prop(at('active'), 'typeCategory'), 'boolean');
    assert.equal(prop(at('metadata'), 'typeCategory'), 'json');
    assert.equal(prop(at('status'), 'typeCategory'), 'enum');
    assert.equal(prop(at('status'), 'enumCount'), 3);
    assert.equal(prop(at('status'), 'enumValues'), '["\\"available\\"","\\"pending\\"","\\"sold\\""]');

    assert.equal(prop(at('name'), 'minLength'), 1);
    assert.equal(prop(at('name'), 'maxLength'), 64);
    assert.equal(prop(at('active'), 'hasDefault'), true);
    assert.equal(prop(at('active'), 'default'), true);

    // An array carries its ELEMENT category plus isArray, so `text[]` and
    // `array<string>` agree on both axes.
    assert.equal(prop(at('tags'), 'typeCategory'), 'text');
    assert.equal(prop(at('tags'), 'isArray'), true);
    assert.equal(prop(at('tags'), 'maxItems'), 12);

    // jsonPointer is carried explicitly and matches the identity component.
    assert.equal(prop(at('id'), 'jsonPointer'), '/components/schemas/Pet/properties/id');
  } finally {
    repo.dispose();
  }
});

test('parameters become schema properties with a location and their own required-ness', () => {
  const repo = makeTempRepo();
  try {
    const { nodes } = extractFixtures(repo);
    const petId = nodes.find(
      (n) => n.kind === 'SchemaProperty' && n.name === 'petId' && n.props['in'] === 'path',
    );
    assert.ok(petId !== undefined, 'the path parameter is emitted');
    assert.equal(petId.props['required'], true, 'a path parameter is required by specification');
    assert.equal(petId.props['typeCategory'], 'uuid');

    const limit = nodes.find(
      (n) => n.kind === 'SchemaProperty' && n.name === 'limit' && n.props['in'] === 'query',
    );
    assert.ok(limit !== undefined);
    assert.equal(limit.props['required'], false);
    assert.equal(limit.props['typeCategory'], 'integer');
    assert.equal(limit.props['minimum'], 1);
    assert.equal(limit.props['maximum'], 100);

    const trace = nodes.find(
      (n) => n.kind === 'SchemaProperty' && n.name === 'X-Trace-Id' && n.props['in'] === 'header',
    );
    assert.ok(trace !== undefined);
    assert.equal(trace.props['required'], false, 'an absent `required` is false, not unknown');
  } finally {
    repo.dispose();
  }
});

test('a standalone JSON Schema is extracted, and configuration JSON is not', () => {
  const repo = makeTempRepo();
  try {
    const { nodes } = extractFixtures(repo);
    const contract = 'https://example.com/schemas/user.json';

    const deletedAt = nodeById(nodes, `${REPO}:SchemaProperty:${contract}#/properties/deletedAt`);
    assert.equal(prop(deletedAt, 'required'), true, 'listed in the parent required array');
    assert.equal(prop(deletedAt, 'nullable'), true, 'type: [string, null] is nullability');
    assert.equal(prop(deletedAt, 'typeCategory'), 'timestamp');

    const avatar = nodeById(nodes, `${REPO}:SchemaProperty:${contract}#/properties/avatar`);
    assert.equal(prop(avatar, 'nullable'), true, 'an anyOf null branch is nullability');
    assert.equal(prop(avatar, 'required'), false);
    assert.equal(prop(avatar, 'typeCategory'), 'text');

    const email = nodeById(nodes, `${REPO}:SchemaProperty:${contract}#/properties/email`);
    assert.equal(prop(email, 'maxLength'), 255);
    assert.equal(prop(email, 'pattern'), '^.+@.+$');

    // Nested and $defs shapes are reachable at their true pointers.
    nodeById(nodes, `${REPO}:SchemaProperty:${contract}#/properties/settings/properties/theme`);
    const city = nodeById(nodes, `${REPO}:SchemaProperty:${contract}#/$defs/Address/properties/city`);
    assert.equal(prop(city, 'required'), true);

    // Schema-SHAPED configuration is still configuration. `renovate.json` in
    // the fixture tree declares `type: object` plus `properties` and is
    // rejected by name, as is `package.json`.
    assert.equal(isJsonSchemaDocument('api/package.json', { type: 'object', properties: {} }), false);
    assert.equal(isJsonSchemaDocument('api/renovate.json', { type: 'object', properties: {} }), false);
    assert.equal(isJsonSchemaDocument('a/tsconfig.build.json', { type: 'object', properties: {} }), false);
    assert.equal(isJsonSchemaDocument('api/thing.json', { type: 'object', properties: {} }), true);
    assert.ok(
      nodes.every((n) => n.kind !== 'Contract' || (n.name !== 'renovate' && n.name !== 'package')),
      'deny-listed configuration must not become a Contract',
    );
    assert.equal(
      nodes.filter((n) => n.kind === 'SchemaProperty' && n.name === 'extends').length,
      0,
      'no property may be sourced from renovate.json',
    );
  } finally {
    repo.dispose();
  }
});
