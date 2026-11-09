/**
 * A scope whose extractor PASSed can still cover only part of the repository:
 * `extract-code-ts` names what it did not read on the `Repo` node. `why`,
 * `blast-radius` and `check` take their UNKNOWN section from `degradedScopes`,
 * so a negative answer over a partly read code scope must show up there.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ExtractorResult,
  ExtractorStatus,
  GraphView,
  RunRecord,
  SeamlineNode,
} from '@seamline/ontology';
import { degradedScopes } from './scopes.ts';

function repoNode(props: SeamlineNode['props']): SeamlineNode {
  return {
    id: 'demo:Repo:demo' as SeamlineNode['id'],
    kind: 'Repo',
    name: 'demo',
    sensitivity: 'internal',
    provenance: 'EXTRACTED',
    confidence: 1,
    props,
    firstSeenRun: 'run-1',
    lastSeenRun: 'run-1',
    deletedAt: null,
  } as SeamlineNode;
}

function view(props: SeamlineNode['props'], status: Record<string, ExtractorStatus>): GraphView {
  const repos = [repoNode(props)];
  return {
    nodesByKind: (kind) => (kind === 'Repo' ? repos : []),
    node: () => undefined,
    edgesFrom: () => [],
    edgesTo: () => [],
    scopeStatus: (scope) => status[scope] ?? 'UNAVAILABLE',
  };
}

function runOf(...results: ExtractorResult[]): RunRecord {
  return {
    runId: 'run-1',
    repo: 'demo',
    commit: null,
    startedAt: '1970-01-01T00:00:00.000Z',
    finishedAt: '1970-01-01T00:00:01.000Z',
    ontologyVersion: '1.0.0',
    results,
  };
}

const result = (extractor: string, status: ExtractorStatus, scope: string): ExtractorResult => ({
  extractor,
  version: '0.0.1',
  status,
  authoritative: [{ scope, kinds: [] }],
  nodeCount: 0,
  edgeCount: 0,
  durationMs: 0,
  diagnostics: [],
});

test('a PASS code scope that left packages unread is reported as partial, with the count and the names', () => {
  const scopes = degradedScopes(
    view(
      { unreadCodePackageCount: 2, unreadCodePackages: '["apps/landing","docs"]' },
      { 'code.ts': 'PASS' },
    ),
    runOf(result('extract-code-ts', 'PASS', 'code.ts')),
  );
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.scope, 'code.ts');
  assert.equal(scopes[0]?.status, 'PASS');
  assert.equal(scopes[0]?.unreadPackages, 2);
  assert.deepEqual(scopes[0]?.diagnostics, [
    '2 workspace package(s) were not read (apps/landing, docs)',
  ]);
});

test('names beyond the first few are elided, and the count stays exact', () => {
  const names = Array.from({ length: 25 }, (_, i) => `packages/p${String(i).padStart(2, '0')}`);
  const scopes = degradedScopes(
    view(
      { unreadCodePackageCount: 40, unreadCodePackages: JSON.stringify(names) },
      { 'code.ts': 'PASS' },
    ),
    runOf(result('extract-code-ts', 'PASS', 'code.ts')),
  );
  assert.equal(scopes[0]?.unreadPackages, 40);
  assert.deepEqual(scopes[0]?.diagnostics, [
    '40 workspace package(s) were not read (packages/p00, packages/p01, packages/p02, packages/p03, packages/p04, ...)',
  ]);
});

test('a directory name with a comma is one name', () => {
  const scopes = degradedScopes(
    view(
      { unreadCodePackageCount: 1, unreadCodePackages: '["packages/a,b"]' },
      { 'code.ts': 'PASS' },
    ),
    runOf(result('extract-code-ts', 'PASS', 'code.ts')),
  );
  assert.deepEqual(scopes[0]?.diagnostics, ['1 workspace package(s) were not read (packages/a,b)']);
});

test('a code scope that was read whole reports nothing', () => {
  assert.deepEqual(
    degradedScopes(
      view({}, { 'code.ts': 'PASS' }),
      runOf(result('extract-code-ts', 'PASS', 'code.ts')),
    ),
    [],
  );
});

test('the unread count belongs to the code scope only', () => {
  assert.deepEqual(
    degradedScopes(
      view({ unreadCodePackageCount: 3, unreadCodePackages: '["a","b","c"]' }, { data: 'PASS' }),
      runOf(result('extract-data', 'PASS', 'data')),
    ),
    [],
  );
});

test('a code scope that did not PASS is reported as before, not as partial', () => {
  const scopes = degradedScopes(
    view({ unreadCodePackageCount: 1, unreadCodePackages: '["a"]' }, { 'code.ts': 'UNAVAILABLE' }),
    runOf(result('extract-code-ts', 'UNAVAILABLE', 'code.ts')),
  );
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]?.status, 'UNAVAILABLE');
  assert.equal(scopes[0]?.unreadPackages, undefined);
});
