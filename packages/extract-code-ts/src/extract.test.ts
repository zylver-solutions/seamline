/**
 * Integration tests over a materialized fixture project.
 *
 * Extraction runs once per fixture layout and is shared across tests: building
 * a TypeScript program is the expensive part, and re-running it per assertion
 * would trade minutes for nothing. Each `test` still asserts an independent
 * outcome over that output.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { posix } from 'node:path';
import { isValidEdge, parseNodeId } from '@seamline/ontology';
import type { NodeKind, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { extractCodeTs } from './extract.ts';
import type { ExtractCodeTsOutput } from './extract.ts';
import { manifest } from './manifest.ts';
import { toCanonicalSif } from './serialize.ts';
import {
  APP_PROJECT, APP_PROJECT_RENAMED, LOOSE_FILE_PROJECT, NESTED_TSCONFIG_PROJECT, NO_TSCONFIG_PROJECT,
  WORKSPACE_PROJECT, cleanup, materialize,
} from './__fixtures__/projects.ts';

const roots: string[] = [];

/**
 * A data-model index that declares no table. The fixture projects hold raw SQL, and a run with no
 * index at all is UNAVAILABLE when it reads any (`table-alignment.test.ts` pins that); an index
 * that declares nothing binds nothing, so every statement keeps the name-only answer these tests
 * are about and the run is a PASS, as it is for a repository whose `extract-data` found no table.
 */
const NO_TABLES_INDEX = JSON.stringify({
  version: 1,
  dataSources: [{ name: 'default', dialect: 'postgres', defaultSchema: 'public' }],
  tables: [],
  prismaDelegates: {},
  drizzleExports: {},
});

function run(files: Readonly<Record<string, string>>, label: string): ExtractCodeTsOutput {
  const root = materialize(files, label);
  roots.push(root);
  return extractCodeTs({
    repoRoot: root,
    repo: 'fixture',
    runId: 'run-1',
    deterministic: true,
    dataModelIndex: NO_TABLES_INDEX,
  });
}

/** Same layout, second temporary directory: proves no absolute path leaks. */
const app = run(APP_PROJECT, 'app');
const appElsewhere = run(APP_PROJECT, 'elsewhere');
const renamed = run(APP_PROJECT_RENAMED, 'renamed');
const noTsconfig = run(NO_TSCONFIG_PROJECT, 'no-tsconfig');

after(() => {
  for (const root of roots) cleanup(root);
});

function nodesOfKind(output: ExtractCodeTsOutput, kind: NodeKind): readonly SeamlineNode[] {
  return output.nodes.filter((n) => n.kind === kind);
}

function node(output: ExtractCodeTsOutput, id: string): SeamlineNode {
  const found = output.nodes.find((n) => String(n.id) === id);
  assert.ok(found !== undefined, `no node ${id}`);
  return found;
}

function edgesOfKind(output: ExtractCodeTsOutput, kind: SeamlineEdge['kind']): readonly SeamlineEdge[] {
  return output.edges.filter((e) => e.kind === kind);
}

/* ------------------------------------------------------------ status envelope */

test('the fixture project extracts as PASS with facts in it', () => {
  assert.equal(app.result.status, 'PASS');
  assert.equal(app.result.extractor, 'extract-code-ts');
  assert.ok(app.result.nodeCount > 0, 'PASS with zero nodes would be indistinguishable from an empty repo');
  assert.equal(app.result.nodeCount, app.nodes.length);
  assert.equal(app.result.edgeCount, app.edges.length);
  assert.deepEqual(app.result.diagnostics, []);
});

test('a project with no tsconfig.json is UNAVAILABLE, never an empty PASS', () => {
  assert.equal(noTsconfig.result.status, 'UNAVAILABLE');
  assert.equal(noTsconfig.nodes.length, 0);
  assert.equal(noTsconfig.edges.length, 0);
  assert.ok(
    noTsconfig.result.diagnostics.some((d) => d.includes('tsconfig')),
    'the reason for UNAVAILABLE must be stated',
  );
});

test('the manifest declares the EXTRACTED ceiling and every fact is emitted at it', () => {
  assert.equal(manifest.provenanceCeiling, 'EXTRACTED');
  assert.equal(manifest.net, false);
  for (const n of app.nodes) assert.equal(n.provenance, 'EXTRACTED', String(n.id));
  for (const e of app.edges) assert.equal(e.provenance, 'EXTRACTED', `${e.kind} ${e.src}`);
});

test('the authoritative scope names the kinds this extractor may tombstone', () => {
  const scope = app.result.authoritative[0];
  assert.ok(scope !== undefined);
  assert.equal(scope.scope, 'code.ts');
  const emitted = new Set(app.nodes.map((n) => n.kind));
  for (const kind of emitted) {
    assert.ok(scope.kinds.includes(kind), `emitted ${kind} outside the declared authoritative scope`);
  }
  // Table is queried but not owned, so it must not appear in the scope.
  assert.equal(scope.kinds.includes('Table'), false);
});

const SRC_SELECTOR = '{src/**/*.cts,src/**/*.mts,src/**/*.ts,src/**/*.tsx}';

test('the authoritative selector claims what the project includes, every file read among it', () => {
  const selector = app.result.authoritative[0]?.selector;
  assert.ok(selector !== undefined, 'an unbounded scope would claim files this run never read');
  // tsconfig `include: ["src"]`, no `allowJs`: every TypeScript extension under src/.
  assert.equal(selector, SRC_SELECTOR);
  const read = nodesOfKind(app, 'File').map((n) => n.path ?? '');
  assert.ok(read.length > 0);
  for (const path of read) assert.equal(posix.matchesGlob(path, selector), true, path);
  assert.equal(posix.matchesGlob('tools/unread.ts', selector), false);
});

/* ----------------------------------------------------------------- coverage */

test('a TS file outside every loaded tsconfig project is reported, not read, and not claimed', () => {
  const loose = run(LOOSE_FILE_PROJECT, 'loose');
  assert.equal(loose.result.status, 'PASS');

  const files = nodesOfKind(loose, 'File').map((n) => n.path).sort();
  assert.deepEqual(files, ['src/a.ts', 'src/b.ts'], 'tools/x.ts is outside the project graph');

  // The outDir and node_modules are not source, so they are not reported.
  assert.deepEqual(loose.result.diagnostics, [
    'tsconfig coverage: 2/3 TypeScript/JavaScript files under the repository root are in a loaded ' +
      'project; files in no loaded project are not read and not claimed',
    'not in any loaded tsconfig project: tools/x.ts',
  ]);

  const selector = loose.result.authoritative[0]?.selector;
  assert.equal(selector, SRC_SELECTOR);
  for (const path of ['src/a.ts', 'src/b.ts']) assert.equal(posix.matchesGlob(path, selector), true, path);
  for (const path of ['tools/x.ts', 'dist/a.js']) {
    assert.equal(posix.matchesGlob(path, selector), false, `${path} was never read, so it is not claimed`);
  }
});

test('a file deleted from a covered directory is still inside the selector', () => {
  const root = materialize(LOOSE_FILE_PROJECT, 'loose-deleted');
  roots.push(root);
  const extract = (runId: string): ExtractCodeTsOutput =>
    extractCodeTs({ repoRoot: root, repo: 'fixture', runId, deterministic: true });
  const before = extract('run-1');
  fs.rmSync(nodePath.join(root, 'src', 'b.ts'));
  const after = extract('run-2');

  assert.deepEqual(nodesOfKind(before, 'File').map((n) => n.path).sort(), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(nodesOfKind(after, 'File').map((n) => n.path), ['src/a.ts']);
  const selector = after.result.authoritative[0]?.selector ?? '';
  // Run 2 did not read src/b.ts, and it is claimed anyway: that is what lets its facts be tombstoned.
  assert.equal(posix.matchesGlob('src/b.ts', selector), true, 'a deleted file must stay claimable');
  assert.equal(posix.matchesGlob('tools/x.ts', selector), false, 'a loose file still exists and is not claimed');
  assert.deepEqual(after.result.diagnostics.slice(1), ['not in any loaded tsconfig project: tools/x.ts']);
});

test('coverage respects the run\'s include and exclude', () => {
  const root = materialize(LOOSE_FILE_PROJECT, 'loose-bounded');
  roots.push(root);
  const base = { repoRoot: root, repo: 'fixture', runId: 'run-1', deterministic: true } as const;
  for (const bounds of [{ exclude: ['tools/**'] }, { include: ['src/**/*'] }]) {
    const bounded = extractCodeTs({ ...base, ...bounds });
    assert.equal(bounded.result.status, 'PASS');
    assert.deepEqual(bounded.result.diagnostics, [], `${JSON.stringify(bounds)}: tools/x.ts is not a coverage gap`);
    assert.equal(bounded.result.authoritative[0]?.selector, SRC_SELECTOR, 'bounds never change what is claimed');
  }
});

/* ------------------------------------------------------ discovered projects */

test('an unreferenced tsconfig.json is a project too: its files are read and its directories claimed', () => {
  const nested = run(NESTED_TSCONFIG_PROJECT, 'nested');
  assert.equal(nested.result.status, 'PASS');

  // node_modules, the dot-directory and the referenced project's outDir hold no project of this repo.
  const files = nodesOfKind(nested, 'File').map((n) => n.path).sort();
  assert.deepEqual(files, ['examples/app/src/order.ts', 'src/a.ts']);
  assert.equal(node(nested, 'fixture:CodeField:@fixture/app#Order.shippedAt').props['optional'], true);

  const selector = nested.result.authoritative[0]?.selector ?? '';
  assert.equal(
    selector,
    '{examples/app/src/**/*.cts,examples/app/src/**/*.mts,examples/app/src/**/*.ts,examples/app/src/**/*.tsx,' +
      'src/**/*.cts,src/**/*.mts,src/**/*.ts,src/**/*.tsx}',
  );
  for (const path of ['examples/app/src/order.ts', 'examples/app/src/deleted.ts', 'src/a.ts']) {
    assert.equal(posix.matchesGlob(path, selector), true, path);
  }
  for (const path of ['tools/x.ts', 'dist/leak.ts', 'examples/broken/a.ts']) {
    assert.equal(posix.matchesGlob(path, selector), false, path);
  }

  const [broken, ...coverage] = nested.result.diagnostics;
  assert.match(broken ?? '', /^discovered project could not be loaded: examples\/broken\/tsconfig\.json: /);
  assert.deepEqual(coverage, [
    'tsconfig coverage: 2/3 TypeScript/JavaScript files under the repository root are in a loaded ' +
      'project; files in no loaded project are not read and not claimed',
    'not in any loaded tsconfig project: tools/x.ts',
  ]);
});

test('the run\'s exclude keeps a tsconfig.json from being discovered', () => {
  const root = materialize(NESTED_TSCONFIG_PROJECT, 'nested-excluded');
  roots.push(root);
  const excluded = extractCodeTs({
    repoRoot: root, repo: 'fixture', runId: 'run-1', deterministic: true, exclude: ['examples/**'],
  });
  assert.deepEqual(nodesOfKind(excluded, 'File').map((n) => n.path), ['src/a.ts']);
  assert.equal(excluded.result.authoritative[0]?.selector, '{src/**/*.cts,src/**/*.mts,src/**/*.ts,src/**/*.tsx}');
});

/* ------------------------------------------------------------------- fields */

test('a class yields CodeField nodes with resolved type, optionality, and nullability', () => {
  const email = node(app, 'fixture:CodeField:@fixture/app#User.email');
  assert.equal(email.props['type'], 'string');
  assert.equal(email.props['normalizedType'], 'string');
  assert.equal(email.props['optional'], false);
  assert.equal(email.props['required'], true);
  assert.equal(email.props['nullable'], false);
  assert.equal(email.path, 'src/models/user.ts');

  const nickname = node(app, 'fixture:CodeField:@fixture/app#User.nickname');
  assert.equal(nickname.props['type'], 'string');
  assert.equal(nickname.props['optional'], true, '`nickname?: string` is optional');
  assert.equal(nickname.props['required'], false);
  assert.equal(nickname.props['nullable'], false, 'optional is not the same fact as nullable');
  assert.equal(nickname.props['rawType'], 'string | undefined');

  const deletedAt = node(app, 'fixture:CodeField:@fixture/app#User.deletedAt');
  assert.equal(deletedAt.props['type'], 'Date', 'null is stripped from the joinable base type');
  assert.equal(deletedAt.props['normalizedType'], 'date');
  assert.equal(deletedAt.props['nullable'], true);
  assert.equal(deletedAt.props['optional'], false, '`Date | null` is required and nullable');

  const createdAt = node(app, 'fixture:CodeField:@fixture/app#User.createdAt');
  assert.equal(createdAt.props['readonly'], true);

  const tags = node(app, 'fixture:CodeField:@fixture/app#User.tags');
  assert.equal(tags.props['type'], 'string[]');
  assert.equal(tags.props['normalizedType'], 'array');

  const status = node(app, 'fixture:CodeField:@fixture/app#User.status');
  assert.equal(status.props['normalizedType'], 'enum');
  assert.equal(status.props['enumValues'], 'active,banned');

  const secret = node(app, 'fixture:CodeField:@fixture/app#User.secret');
  assert.equal(secret.props['visibility'], 'private');

  const tableName = node(app, 'fixture:CodeField:@fixture/app#User.tableName');
  assert.equal(tableName.props['static'], true);
});

test('interface, type-alias, and accessor members are fields too', () => {
  assert.equal(node(app, 'fixture:CodeField:@fixture/app#Profile.bio').props['optional'], true);
  assert.equal(node(app, 'fixture:CodeField:@fixture/app#Profile.avatarUrl').props['nullable'], true);
  const patch = node(app, 'fixture:CodeField:@fixture/app#UserPatch.nickname');
  assert.equal(patch.props['optional'], true);
  assert.equal(patch.props['nullable'], true);
  const displayName = node(app, 'fixture:CodeField:@fixture/app#User.displayName');
  assert.equal(displayName.props['accessor'], 'get');
  assert.equal(displayName.props['type'], 'string');
});

test('every field is contained by its declaring symbol', () => {
  const contains = new Set(
    edgesOfKind(app, 'CONTAINS').map((e) => `${e.src}|${e.dst}`),
  );
  for (const field of nodesOfKind(app, 'CodeField')) {
    const owner = `fixture:Symbol:${String(field.props['owner'])}`;
    assert.ok(contains.has(`${owner}|${field.id}`), `no CONTAINS ${owner} -> ${field.id}`);
  }
});

/* ------------------------------------------------------ canonical resolution */

test('a re-export through a barrel resolves to one canonical symbol, not two', () => {
  const users = nodesOfKind(app, 'Symbol').filter((n) => n.name === 'User');
  assert.equal(users.length, 1, `expected one User symbol, got ${users.map((u) => u.id).join(', ')}`);
  assert.equal(String(users[0]?.id), 'fixture:Symbol:@fixture/app#User');
  assert.equal(users[0]?.path, 'src/models/user.ts', 'the node lives at the declaration site');

  // Declaring file, barrel, and package entry all export the same node.
  const exporters = edgesOfKind(app, 'EXPORTS')
    .filter((e) => String(e.dst) === 'fixture:Symbol:@fixture/app#User')
    .map((e) => String(e.src))
    .sort();
  assert.deepEqual(exporters, [
    'fixture:File:src/index.ts',
    'fixture:File:src/models/index.ts',
    'fixture:File:src/models/user.ts',
    'fixture:Module:@fixture/app',
  ]);

  // And a consumer importing through the barrel points at that same node.
  const uses = edgesOfKind(app, 'USES_TYPE').filter(
    (e) => String(e.dst) === 'fixture:Symbol:@fixture/app#User',
  );
  assert.ok(uses.length > 0, 'the barrel consumer must resolve to the declaration node');
});

test('extends and implements produce edges between the resolved declarations', () => {
  const extendsEdges = edgesOfKind(app, 'EXTENDS').map((e) => `${e.src} -> ${e.dst}`);
  assert.deepEqual(extendsEdges, [
    'fixture:Symbol:@fixture/app#User -> fixture:Symbol:@fixture/app#BaseEntity',
  ]);
  const implementsEdges = edgesOfKind(app, 'IMPLEMENTS').map((e) => `${e.src} -> ${e.dst}`).sort();
  assert.deepEqual(implementsEdges, [
    'fixture:Symbol:@fixture/app#BaseEntity -> fixture:Symbol:@fixture/app#Identifiable',
    'fixture:Symbol:@fixture/app#User -> fixture:Symbol:@fixture/app#Identifiable',
  ]);
});

test('calls, imports, and in-project decorators are resolved through the checker', () => {
  const calls = new Set(edgesOfKind(app, 'CALLS').map((e) => `${e.src} -> ${e.dst}`));
  assert.ok(
    calls.has('fixture:Symbol:@fixture/app#UserService.apply -> fixture:Symbol:@fixture/app#normalizeEmail'),
  );
  assert.ok(
    calls.has('fixture:Symbol:@fixture/app#UserController.show -> fixture:Symbol:@fixture/app#UserService.findById'),
  );
  const imports = edgesOfKind(app, 'IMPORTS').filter((e) => e.src === node(app, 'fixture:File:src/service.ts').id);
  assert.ok(imports.some((e) => String(e.dst) === 'fixture:File:src/models/index.ts'));

  const decorated = new Set(edgesOfKind(app, 'DECORATED_WITH').map((e) => `${e.src} -> ${e.dst}`));
  assert.ok(decorated.has('fixture:Symbol:@fixture/app#UserController -> fixture:Symbol:@fixture/app#Controller'));
  assert.ok(decorated.has('fixture:Symbol:@fixture/app#UserController.show -> fixture:Symbol:@fixture/app#Get'));
});

test('routes are named by the route, from both the router-call and decorator styles', () => {
  const routes = nodesOfKind(app, 'RouteHandler').map((n) => n.name).sort();
  assert.deepEqual(routes, ['GET /accounts/:id', 'GET /users/:id', 'POST /users']);
  const handles = edgesOfKind(app, 'HANDLES_ROUTE').map((e) => `${e.src} -> ${e.dst}`);
  assert.ok(handles.includes('fixture:Symbol:@fixture/app#getUser -> fixture:RouteHandler:GET /users/:id'));
  assert.ok(
    handles.includes('fixture:Symbol:@fixture/app#UserController.show -> fixture:RouteHandler:GET /accounts/:id'),
  );
});

test('SQL in a method yields QUERIES edges without claiming authority over Table', () => {
  const queries = edgesOfKind(app, 'QUERIES').map((e) => `${e.src} -> ${e.dst}`).sort();
  assert.deepEqual(queries, [
    'fixture:Symbol:@fixture/app#UserService.create -> fixture:Table:public.users',
    'fixture:Symbol:@fixture/app#UserService.findById -> fixture:Table:public.users',
  ]);
  assert.equal(nodesOfKind(app, 'Table' as NodeKind).length, 0, 'Table nodes belong to extract-data');
  for (const e of edgesOfKind(app, 'QUERIES')) {
    assert.ok(e.confidence < 1, 'an unqualified table binding must not be asserted at full confidence');
  }
});

/* ------------------------------------------------------------------ identity */

test('a renamed file produces the same symbol, field, and parameter ids', () => {
  const idsOf = (output: ExtractCodeTsOutput): string[] =>
    output.nodes
      .filter((n) => n.kind === 'Symbol' || n.kind === 'CodeField' || n.kind === 'Parameter')
      .map((n) => String(n.id))
      .sort();
  assert.deepEqual(idsOf(renamed), idsOf(app));

  // The fixture really did move, so the assertion above is not vacuous.
  const filesBefore = nodesOfKind(app, 'File').map((n) => n.name);
  const filesAfter = nodesOfKind(renamed, 'File').map((n) => n.name);
  assert.ok(filesBefore.includes('src/models/user.ts'));
  assert.ok(filesAfter.includes('src/domain/account.ts'));
  assert.equal(filesAfter.includes('src/models/user.ts'), false);

  // path follows the file; identity does not.
  assert.equal(node(app, 'fixture:Symbol:@fixture/app#User').path, 'src/models/user.ts');
  assert.equal(node(renamed, 'fixture:Symbol:@fixture/app#User').path, 'src/domain/account.ts');
});

test('edges survive the rename as well, with only their file annotations moving', () => {
  const shape = (output: ExtractCodeTsOutput): string[] =>
    output.edges
      .filter((e) => !String(e.src).includes(':File:') && !String(e.dst).includes(':File:'))
      .map((e) => `${e.kind} ${e.src} ${e.dst}`)
      .sort();
  assert.deepEqual(shape(renamed), shape(app));
});

test('no emitted value contains an absolute path or a backslash', () => {
  const serialized = toCanonicalSif(app);
  assert.equal(serialized.includes('\\'), false, 'a Windows separator leaked into the output');
  assert.equal(/"[^"]*\/tmp\//.test(serialized), false, 'a temporary-directory path leaked into the output');
  for (const n of app.nodes) {
    if (n.path !== undefined) assert.equal(n.path.startsWith('/'), false, String(n.id));
    if (n.sourceRef !== undefined) assert.equal(n.sourceRef.startsWith('/'), false, String(n.id));
  }
});

/* --------------------------------------------------------------- determinism */

test('two runs over the same tree produce byte-identical output', () => {
  const first = toCanonicalSif(app);
  const second = toCanonicalSif(
    extractCodeTs({
      repoRoot: roots[0] ?? '',
      repo: 'fixture',
      runId: 'run-1',
      deterministic: true,
      dataModelIndex: NO_TABLES_INDEX,
    }),
  );
  assert.equal(second, first);
});

test('output is identical even when the same tree sits at a different absolute path', () => {
  assert.equal(toCanonicalSif(appElsewhere), toCanonicalSif(app));
});

/* ------------------------------------------------------------ edge signatures */

test('every emitted edge satisfies isValidEdge', () => {
  const kinds = new Map<string, NodeKind>(app.nodes.map((n) => [String(n.id), n.kind]));
  assert.ok(app.edges.length > 0);
  for (const e of app.edges) {
    // A cross-scope endpoint has no node here; its kind comes from its id.
    const src = kinds.get(String(e.src)) ?? parseNodeId(e.src).kind;
    const dst = kinds.get(String(e.dst)) ?? parseNodeId(e.dst).kind;
    assert.ok(isValidEdge(e.kind, src, dst), `${e.kind}: ${src} -> ${dst} (${e.src} -> ${e.dst})`);
  }
});

test('every edge kind this extractor claims is actually produced by the fixture', () => {
  const produced = new Set(app.edges.map((e) => e.kind));
  for (const kind of [
    'CONTAINS', 'IMPORTS', 'EXPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS',
    'USES_TYPE', 'DECORATED_WITH', 'HANDLES_ROUTE', 'QUERIES',
  ] as const) {
    assert.ok(produced.has(kind), `${kind} was never produced, so its handling is untested`);
  }
});

test('every node kind this extractor claims is actually produced by the fixture', () => {
  const produced = new Set(app.nodes.map((n) => n.kind));
  for (const kind of ['Repo', 'File', 'Module', 'Symbol', 'CodeField', 'Parameter', 'RouteHandler'] as const) {
    assert.ok(produced.has(kind), `${kind} was never produced, so its handling is untested`);
  }
});

/* -------------------------------------------------------- monorepo workspace */

test('a solution-style root tsconfig is followed through its project references', () => {
  const workspace = run(WORKSPACE_PROJECT, 'workspace');
  assert.equal(workspace.result.status, 'PASS');

  const modules = nodesOfKind(workspace, 'Module').map((n) => n.name).sort();
  assert.deepEqual(modules, ['@fixture/api', '@fixture/core']);

  // Each package anchors its own symbols, so a file moving within a package is
  // free while moving between packages is a genuine identity change.
  const symbols = nodesOfKind(workspace, 'Symbol').map((n) => String(n.id)).sort();
  assert.deepEqual(symbols, ['fixture:Symbol:@fixture/api#Invoice', 'fixture:Symbol:@fixture/core#Money']);

  const moduleImports = workspace.edges
    .filter((e) => e.kind === 'IMPORTS' && String(e.src).includes(':Module:'))
    .map((e) => `${e.src} -> ${e.dst}`);
  assert.deepEqual(moduleImports, ['fixture:Module:@fixture/api -> fixture:Module:@fixture/core']);

  assert.equal(
    node(workspace, 'fixture:CodeField:@fixture/api#Invoice.total').props['type'],
    'Money',
    'a cross-package field type resolves to the declaring package',
  );
});
