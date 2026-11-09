import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinRoute, normalizeRoutePath } from './routes.ts';

test('route normalization collapses the spellings that would otherwise split one endpoint in two', () => {
  assert.equal(normalizeRoutePath('/users/'), '/users');
  assert.equal(normalizeRoutePath('users'), '/users');
  assert.equal(normalizeRoutePath('//users//:id/'), '/users/:id');
  assert.equal(normalizeRoutePath('/'), '/');
  assert.equal(normalizeRoutePath(''), '/');
});

test('a controller base and a method path compose to one normalized route', () => {
  assert.equal(joinRoute('/accounts', ':id'), '/accounts/:id');
  assert.equal(joinRoute('/accounts/', '/:id'), '/accounts/:id');
  assert.equal(joinRoute('/', ''), '/');
});
