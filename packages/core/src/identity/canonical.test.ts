import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseNodeId } from '@seamline/ontology';

import {
  aliasName,
  assertCanonicalName,
  columnName,
  commitName,
  contractName,
  codeFieldName,
  domainPropertyName,
  entityName,
  extractorName,
  fileName,
  makeNodeId,
  migrationName,
  migrationNamePart,
  moduleName,
  operationName,
  parameterName,
  ROOT_MODULE,
  routeHandlerName,
  schemaName,
  schemaPropertyName,
  symbolCanonicalName,
  symbolName,
  tableName,
  testCaseName,
} from './canonical.ts';

const REPO = 'seamline';

describe('canonical names are path-free', () => {
  test('symbol name is the resolved qualified name, with no path in it', () => {
    const name = symbolName({ module: '@seamline/core', qualifiedName: ['UserService', 'findById'] });
    assert.equal(name, '@seamline/core#UserService.findById');
    const id = makeNodeId(REPO, 'Symbol', name);
    assert.equal(id, 'seamline:Symbol:@seamline/core#UserService.findById');
    assert.equal(parseNodeId(id).canonicalName, name);
  });

  test('a symbol with no governing package.json is named under the root module', () => {
    assert.equal(symbolName({ qualifiedName: ['main'] }), `${ROOT_MODULE}#main`);
    assert.equal(symbolName({ qualifiedName: ['main'] }), symbolCanonicalName(ROOT_MODULE, ['main']));
  });

  test('a symbol name built from a file path is rejected', () => {
    assert.throws(
      () => symbolName({ module: 'src/services/user.ts', qualifiedName: ['findById'] }),
      /must not carry a file extension/,
    );
    assert.throws(() => symbolName({ module: './user', qualifiedName: ['x'] }), /relative path specifier/);
    assert.throws(() => symbolName({ module: '/abs/user', qualifiedName: ['x'] }), /absolute path/);
    assert.throws(() => symbolName({ module: 'a/../b', qualifiedName: ['x'] }), /'\.\.' segment/);
  });

  test('assertCanonicalName rejects a path used as identity for a non-File kind', () => {
    assert.throws(() => assertCanonicalName('Symbol', 'src/user.ts'), /looks like a file path/);
    assert.throws(() => assertCanonicalName('Column', 'db/public/users'), /path-free/);
    assert.throws(() => assertCanonicalName('Symbol', '/etc/passwd'), /absolute path/);
    assert.throws(() => assertCanonicalName('Symbol', 'src\\user'), /backslash/);
    assert.throws(() => assertCanonicalName('Symbol', 'C:/src/user'), /absolute path/);
  });

  test('File is the one kind identified by its repo-relative path', () => {
    assert.equal(fileName('src/identity/canonical.ts'), 'src/identity/canonical.ts');
    assert.equal(assertCanonicalName('File', 'src/a.ts'), 'src/a.ts');
    assert.throws(() => fileName('/abs/a.ts'), /not absolute/);
    assert.throws(() => fileName('./a.ts'), /must not start with/);
    assert.throws(() => fileName('src//a.ts'), /empty segment/);
    assert.throws(() => fileName('src/../a.ts'), /'\.\.' segment/);
    assert.throws(() => fileName('src/'), /must not end with a separator/);
    assert.throws(() => fileName('src\\a.ts'), /backslash/);
  });

  test("column is {schema}.{table}.{column}, datasource-qualified when supplied", () => {
    assert.equal(columnName({ schema: 'public', table: 'users', column: 'email' }), 'public.users.email');
    assert.equal(
      columnName({ dataSource: 'primary', schema: 'public', table: 'users', column: 'email' }),
      'primary.public.users.email',
    );
    // A column legitimately named after an extension-like token still resolves.
    assert.equal(columnName({ schema: 'public', table: 'events', column: 'ts' }), 'public.events.ts');
    assert.throws(() => columnName({ schema: 'pub.lic', table: 'users', column: 'email' }), /must not contain/);
    assert.throws(() => columnName({ schema: 'public', table: '', column: 'email' }), /must not be empty/);
  });

  test('schema property is {contract}#{jsonPointer}', () => {
    assert.equal(
      schemaPropertyName({ contract: 'petstore@1.0.0', jsonPointer: '/components/schemas/Pet/properties/id' }),
      'petstore@1.0.0#/components/schemas/Pet/properties/id',
    );
    assert.equal(schemaPropertyName({ contract: 'petstore@1.0.0', jsonPointer: '' }), 'petstore@1.0.0#');
    assert.throws(
      () => schemaPropertyName({ contract: 'petstore', jsonPointer: 'components/schemas/Pet' }),
      /RFC 6901/,
    );
    assert.throws(() => contractName('docs/api/petstore.yaml'), /path-free/);
  });

  test('the remaining kinds each have a builder that rejects malformed parts', () => {
    assert.equal(moduleName('@seamline/core/identity'), '@seamline/core/identity');
    assert.equal(schemaName({ schema: 'public' }), 'public');
    assert.equal(tableName({ schema: 'public', table: 'users' }), 'public.users');
    assert.equal(codeFieldName({ symbol: 'pkg#User', field: 'email' }), 'pkg#User.email');
    assert.equal(parameterName({ symbol: 'pkg#find', index: 0, parameter: 'id' }), 'pkg#find(0)id');
    assert.throws(() => parameterName({ symbol: 'pkg#find', index: -1, parameter: 'id' }), /non-negative integer/);
    assert.throws(() => parameterName({ symbol: 'pkg#find', index: 1.5, parameter: 'id' }), /non-negative integer/);
    assert.equal(routeHandlerName({ method: 'get', route: '/users/{id}' }), 'GET /users/{id}');
    assert.equal(operationName({ contract: 'petstore', operation: 'getPetById' }), 'petstore#getPetById');
    assert.equal(entityName('User'), 'User');
    assert.equal(domainPropertyName({ entity: 'User', property: 'email' }), 'User.email');
    assert.equal(testCaseName({ suite: ['merge', 'lifecycle'], name: 'resurrects' }), 'merge > lifecycle > resurrects');
    assert.equal(extractorName({ name: 'extract-code-ts', version: '0.0.1' }), 'extract-code-ts@0.0.1');
    assert.equal(aliasName({ kind: 'File', name: 'src/a.ts' }), 'File::src/a.ts');
    assert.equal(commitName('0a1b2c3d'), '0a1b2c3d');
    assert.throws(() => routeHandlerName({ method: 'GET', route: 'users' }), /must start with/);
    assert.throws(() => commitName('NOTAHEX'), /hex object id/);
    assert.throws(() => entityName('User.Name'), /must not contain/);
  });

  test('an empty or whitespace-padded part is refused, not silently trimmed', () => {
    assert.throws(() => symbolName({ qualifiedName: [] }), /at least one part/);
    assert.throws(() => symbolName({ qualifiedName: [' User'] }), /leading or trailing whitespace/);
    assert.throws(() => makeNodeId(REPO, 'Symbol', ''), /must not be empty/);
    assert.throws(() => makeNodeId('bad:repo', 'Symbol', 'X'), /must match/);
  });
});

describe('path is a property, never identity (v3 §2.1)', () => {
  test('the same symbol declared at two different paths has one id', () => {
    const name = symbolName({ module: '@seamline/core', qualifiedName: ['UserService', 'findById'] });
    const before = { id: makeNodeId(REPO, 'Symbol', name), path: 'src/services/user.ts' };
    const after = { id: makeNodeId(REPO, 'Symbol', name), path: 'src/domain/user/service.ts' };
    assert.equal(before.id, after.id);
    assert.notEqual(before.path, after.path);
  });

  test('no non-File id contains its declaration path', () => {
    const path = 'src/services/user.ts';
    const ids = [
      makeNodeId(REPO, 'Symbol', symbolName({ module: '@seamline/core', qualifiedName: ['User'] })),
      makeNodeId(REPO, 'Column', columnName({ schema: 'public', table: 'users', column: 'email' })),
      makeNodeId(REPO, 'SchemaProperty', schemaPropertyName({ contract: 'api@1', jsonPointer: '/x' })),
    ];
    for (const id of ids) assert.ok(!id.includes(path), `${id} must not embed ${path}`);
  });
});

describe('a Migration name is one thing for migrationName and makeNodeId', () => {
  test('a bare version and a qualified version both pass makeNodeId', () => {
    for (const name of [
      migrationName('0001_init'),
      migrationName('0001_init', ['packages', 'api', 'migrations']),
      migrationName('20240101120000_init', ['prisma', 'migrations']),
    ]) {
      assert.ok(!name.includes('/'), `${name} must be path-free`);
      assert.equal(parseNodeId(makeNodeId(REPO, 'Migration', name)).canonicalName, name);
      // An Alias for a Migration is built by makeNodeId and must accept the same name.
      assert.equal(aliasName({ kind: 'Migration', name }), `Migration::${name}`);
    }
    assert.equal(migrationName('0001_init'), '0001_init');
    assert.equal(migrationName('0001_init', ['a', 'migrations']), '0001_init~a~migrations');
  });

  test('a slashed name is rejected by both, so they cannot disagree', () => {
    assert.throws(() => migrationName('migrations/0001_init'), /migration version/);
    assert.throws(() => migrationName('0001_init', ['a/migrations']), /migration qualifier/);
    assert.throws(() => makeNodeId(REPO, 'Migration', 'migrations/0001_init'), /path-free/);
  });

  test('a version cannot contain the qualifier separator, so a qualified name never equals a bare one', () => {
    assert.throws(() => migrationName('0001~a'), /migration version/);
    assert.notEqual(migrationName('0001_init', ['a']), migrationName('0001_init'));
  });

  test('migrationNamePart maps onto the accepted alphabet', () => {
    for (const raw of ['001 init', 'v1/2', 'a~b', '..', '', 'h\u00e9llo']) {
      assert.doesNotThrow(() => migrationName(migrationNamePart(raw)), raw);
    }
    assert.equal(migrationNamePart('0001_init'), '0001_init');
    assert.equal(migrationNamePart('001 init'), '001_init');
  });
});
