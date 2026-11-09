import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNodeId } from '@seamline/ontology';
import {
  assertPathFree, codeFieldCanonicalName, codeFieldId, fileId, parameterCanonicalName,
  routeCanonicalName, symbolCanonicalName, symbolId,
} from './canonical.ts';

test('a symbol canonical name is the module plus the declaration chain, with no path in it', () => {
  const name = symbolCanonicalName('@acme/api', ['UserService', 'findById']);
  assert.equal(name, '@acme/api#UserService.findById');
  assert.equal(parseNodeId(symbolId('repo', name)).canonicalName, name);
});

test('assertPathFree rejects a filesystem reference in an id', () => {
  for (const bad of [
    'src/models/user.ts#User',
    './user.ts#User',
    '@acme/api#../models/User',
    'C:\\repo\\src#User',
    '/abs/path#User',
    '@acme/api#models/user.ts',
  ]) {
    assert.throws(() => assertPathFree(bad, 'Symbol'), /embeds a path/, `expected rejection: ${bad}`);
  }
});

test('assertPathFree accepts the slashes that are not paths', () => {
  // A scoped package name and an HTTP route both contain `/` legitimately.
  assertPathFree('@acme/api#User.email', 'CodeField');
  assertPathFree('GET /users/:id', 'RouteHandler');
  // A field named `ts` is not a TypeScript file.
  assertPathFree('@acme/api#Config.ts', 'CodeField');
});

test('File is the one kind whose natural name is its path', () => {
  const id = fileId('repo', 'src/models/user.ts');
  assert.equal(parseNodeId(id).canonicalName, 'src/models/user.ts');
  assert.throws(() => fileId('repo', '/abs/src/user.ts'), /repo-relative/);
  assert.throws(() => fileId('repo', 'src\\user.ts'), /repo-relative/);
});

test('field and parameter names extend their owner, and kind keeps them distinct', () => {
  const owner = symbolCanonicalName('@acme/api', ['User']);
  const field = codeFieldCanonicalName(owner, 'email');
  assert.equal(field, '@acme/api#User.email');
  assert.equal(parameterCanonicalName('@acme/api#User.rename', 0, 'next'), '@acme/api#User.rename(0)next');
  // Same canonical name, different kind => different node.
  assert.notEqual(String(codeFieldId('repo', field)), String(symbolId('repo', field)));
});

test('a route name is the route, so moving the file that registers it changes nothing', () => {
  assert.equal(routeCanonicalName('get', '/users/:id'), 'GET /users/:id');
});
