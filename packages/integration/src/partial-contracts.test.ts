/**
 * Partial Zod coverage, against the real store and the real detectors.
 *
 * `extract-contracts` used to fail the whole `contracts` scope on any one Zod
 * construct it could not read, which left `infer-join` UNAVAILABLE and every
 * contract detector UNKNOWN. It now withholds only the schema it could not
 * read and narrows its claim to the files it did read to the end. Three things
 * have to hold for that to be safe, and each is asserted here rather than
 * assumed:
 *
 * 1. a contract an earlier run read from a file that is now unreadable stays
 *    live (invariant 2: a run buries only what its claim covers), while a file
 *    the run did vouch for is still forgotten when it vanishes;
 * 2. the selector the extractor writes is one the store can evaluate, and it
 *    matches what the extractor says it matches;
 * 3. no detector that reasons from the absence of a contracts fact can be made
 *    to fire by a file the claim leaves out.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { nodeId } from '@seamline/ontology';
import type { ExtractorResult, GraphView, NodeId } from '@seamline/ontology';
import {
  SqliteStore,
  compileSelector,
  describeNarrowedClaim,
  narrowedClaims,
  profileView,
  TEAM_PROFILE,
} from '@seamline/core';
import type { NarrowedClaim } from '@seamline/core';
import { runDetectors, x9ContractDrift } from '@seamline/contradictions';
import { extractCodeTs, CODE_TS_SCOPE } from '@seamline/extract-code-ts';
import { CONTRACTS_SCOPE, extractContracts } from '@seamline/extract-contracts';
import { DATA_SCOPE, extractData } from '@seamline/extract-data';
import { INFER_JOIN_SCOPE, inferJoins, toExtractorResult } from '@seamline/infer-join';

const REPO = 'partial';
const ZOD = `import { z } from 'zod';\n`;

test('a truncated discovered JSON header preserves the prior contract and property', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seamline-partial-json-'));
  const storePath = join(root, 'graph.db');
  const store = new SqliteStore({ path: storePath, ontologyVersion: '1.0.0' });
  const fragile = nodeId(REPO, 'Contract', 'Fragile');
  const field = nodeId(REPO, 'SchemaProperty', 'Fragile#/properties/id');
  const schema = (title: string) =>
    JSON.stringify({ title, type: 'object', properties: { id: { type: 'string' } } });
  const persist = async (runId: string) => {
    const out = extractContracts({ repoRoot: root, repo: REPO, runId });
    await store.beginRun({
      runId,
      repo: REPO,
      commit: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      ontologyVersion: '1.0.0',
    });
    await store.upsertNodes(runId, out.nodes);
    await store.upsertEdges(runId, CONTRACTS_SCOPE, out.edges);
    await store.finalizeRun(runId, [out.result]);
    return out.result;
  };
  try {
    writeFileSync(join(root, 'data.json'), schema('Fragile'));
    writeFileSync(join(root, 'keep.json'), schema('Keep'));
    assert.equal((await persist('json-1')).status, 'PASS');
    assert.ok(store.node(fragile));
    assert.ok(store.node(field));
    writeFileSync(join(root, 'data.json'), '{"title":"Fragile", "type":');
    const result = await persist('json-2');
    assert.equal(result.status, 'PASS');
    assert.ok(store.node(fragile), 'unread is not evidence the prior contract vanished');
    assert.ok(store.node(field), 'the prior property also stays live');
    assert.equal(
      compileSelector(result.authoritative[0]?.selector as string).matches('data.json'),
      false,
    );
    assert.ok(
      result.diagnostics.some((d) => d.startsWith('CONTRACTS_PARTIAL_COVERAGE: 1 file(s)')),
    );
    assert.equal(store.edgesFrom(fragile, 'CONTAINS').length, 1);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  }
}

/* ------------------------------------------------------------------ */
/* 1 and 2: two runs through the real SqliteStore                      */
/* ------------------------------------------------------------------ */

describe('a contract in a file the next run cannot read is not buried', () => {
  let root: string;
  let storeDir: string;
  let storePath: string;

  const keep = `${ZOD}export const Keep = z.object({ id: z.string() });`;
  const fragileGood = `${ZOD}export const Fragile = z.object({ name: z.string(), note: z.string().optional() });`;
  const fragileBroken = `${ZOD}export const Fragile = z.object({ ...imported, name: z.string() });`;

  const contract = (name: string): NodeId => nodeId(REPO, 'Contract', name);
  const property = (name: string, key: string): NodeId =>
    nodeId(REPO, 'SchemaProperty', `${name}#/properties/${key}`);

  async function persist(runId: string, files?: readonly string[]): Promise<ExtractorResult> {
    const out = extractContracts({
      repoRoot: root,
      repo: REPO,
      runId,
      ...(files === undefined ? {} : { files }),
    });
    const store = new SqliteStore({ path: storePath, ontologyVersion: '1.0.0' });
    try {
      await store.beginRun({
        runId,
        repo: REPO,
        commit: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        ontologyVersion: '1.0.0',
      });
      await store.upsertNodes(runId, out.nodes);
      await store.upsertEdges(runId, CONTRACTS_SCOPE, out.edges);
      await store.finalizeRun(runId, [out.result]);
      assert.equal(store.scopeStatus(CONTRACTS_SCOPE), out.result.status);
    } finally {
      await store.close();
    }
    return out.result;
  }

  function deletedAt(ids: ReadonlyArray<NodeId>): Record<string, string | null> {
    const raw = new DatabaseSync(storePath, { readOnly: true });
    try {
      const stmt = raw.prepare('SELECT deleted_at FROM nodes WHERE id = :id');
      return Object.fromEntries(
        ids.map((id) => {
          const row = stmt.get({ id }) as { deleted_at: string | null } | undefined;
          assert.ok(row !== undefined, `expected a persisted row for ${id}`);
          return [id, row.deleted_at];
        }),
      );
    } finally {
      raw.close();
    }
  }

  function containsEdgeDeletedAt(src: NodeId, dst: NodeId): string | null {
    const raw = new DatabaseSync(storePath, { readOnly: true });
    try {
      const row = raw
        .prepare(
          "SELECT deleted_at FROM edges WHERE kind = 'CONTAINS' AND src_id = :src AND dst_id = :dst",
        )
        .get({ src, dst }) as { deleted_at: string | null } | undefined;
      assert.ok(row !== undefined, `expected a persisted CONTAINS edge ${src} -> ${dst}`);
      return row.deleted_at;
    } finally {
      raw.close();
    }
  }

  const live = (ids: ReadonlyArray<NodeId>) => Object.fromEntries(ids.map((id) => [id, null]));
  const buried = (ids: ReadonlyArray<NodeId>, run: string) =>
    Object.fromEntries(ids.map((id) => [id, run]));

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'seamline-partial-repo-'));
    storeDir = mkdtempSync(join(tmpdir(), 'seamline-partial-db-'));
    storePath = join(storeDir, 'graph.db');
    writeTree(root, {
      'src/keep.ts': keep,
      'src/fragile.ts': fragileGood,
      'src/stale.ts': `${ZOD}export const Stale = z.object({ y: z.number() });`,
      'lib/stay.ts': 'export const n = 1;\n',
      'lib/gone.ts': `${ZOD}export const Gone = z.object({ x: z.number() });`,
    });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  });

  test('run 1 reads every file, claims the whole scope, and emits all four contracts', async () => {
    const result = await persist('run-1');
    assert.equal(result.status, 'PASS');
    assert.equal(result.authoritative[0]?.selector, undefined);
    assert.deepEqual(
      deletedAt([contract('Keep'), contract('Fragile'), contract('Stale'), contract('Gone')]),
      live([contract('Keep'), contract('Fragile'), contract('Stale'), contract('Gone')]),
    );
  });

  test('run 2 cannot lower src/fragile.ts: the scope passes, the contract stays live, a vouched deletion is buried', async () => {
    writeTree(root, { 'src/fragile.ts': fragileBroken });
    rmSync(join(root, 'lib/gone.ts'));
    rmSync(join(root, 'src/stale.ts'));
    const result = await persist('run-2');

    assert.equal(result.status, 'PASS', 'one unreadable schema does not fail the scope');
    const selector = result.authoritative[0]?.selector;
    assert.equal(selector, '{lib/**,src/keep.ts}');
    // The store can evaluate it, and it says what the extractor meant.
    const compiled = compileSelector(selector as string);
    assert.equal(compiled.matches('src/fragile.ts'), false);
    assert.equal(compiled.matches('src/keep.ts'), true);
    assert.equal(
      compiled.matches('lib/gone.ts'),
      true,
      'a deleted file in a vouched directory is forgotten',
    );
    assert.equal(
      compiled.matches('src/stale.ts'),
      false,
      'a deleted file beside an unvouched one is not',
    );

    // Fragile and everything under it survive: not re-observed, not covered.
    const fragileNodes = [
      contract('Fragile'),
      property('Fragile', 'name'),
      property('Fragile', 'note'),
    ];
    assert.deepEqual(deletedAt(fragileNodes), live(fragileNodes));
    assert.equal(containsEdgeDeletedAt(contract('Fragile'), property('Fragile', 'name')), null);

    // Stale was in the same directory as the unreadable file: conservatively kept.
    assert.deepEqual(deletedAt([contract('Stale')]), live([contract('Stale')]));
    // Gone was in a directory the run read in full: forgotten, with the burying run's id.
    assert.deepEqual(deletedAt([contract('Gone')]), buried([contract('Gone')], 'run-2'));
    assert.deepEqual(deletedAt([contract('Keep')]), live([contract('Keep')]));
  });

  test('run 3 reads everything again: the claim is whole and the graph forgets what is gone', async () => {
    writeTree(root, { 'src/fragile.ts': fragileGood });
    const result = await persist('run-3');
    assert.equal(result.status, 'PASS');
    assert.equal(result.authoritative[0]?.selector, undefined);
    assert.deepEqual(deletedAt([contract('Stale')]), buried([contract('Stale')], 'run-3'));
    assert.deepEqual(
      deletedAt([contract('Fragile'), contract('Keep')]),
      live([contract('Fragile'), contract('Keep')]),
    );
  });

  test('explicit aliases of an unread source cannot authorize its canonical path', async () => {
    writeTree(root, { 'src/fragile.ts': fragileBroken });
    const aliases = ['./src/fragile.ts', 'src/../src/fragile.ts', join(root, 'src/fragile.ts')];
    for (const [index, alias] of aliases.entries()) {
      const result = await persist(`alias-${index}`, ['src/keep.ts', alias]);
      assert.equal(result.status, 'PASS');
      assert.equal(result.authoritative[0]?.selector, 'src/keep.ts');
      assert.equal(
        compileSelector(result.authoritative[0]?.selector as string).matches('src/fragile.ts'),
        false,
      );
      const retained = [
        contract('Fragile'),
        property('Fragile', 'name'),
        property('Fragile', 'note'),
      ];
      assert.deepEqual(deletedAt(retained), live(retained));
      assert.equal(containsEdgeDeletedAt(contract('Fragile'), property('Fragile', 'name')), null);
    }
  });

  test('logical reader and owner survive an internal symlink to a different extension', async () => {
    renameSync(join(root, 'src/fragile.ts'), join(root, 'src/fragile.source'));
    symlinkSync('fragile.source', join(root, 'src/fragile.ts'));
    const files = ['src/keep.ts', './src/fragile.ts'];
    const unread = await persist('linked-unread', files);
    assert.equal(unread.status, 'PASS');
    assert.equal(unread.authoritative[0]?.selector, 'src/keep.ts');
    assert.deepEqual(deletedAt([contract('Fragile')]), live([contract('Fragile')]));
    writeFileSync(join(root, 'src/fragile.source'), fragileGood);
    const readable = await persist('linked-readable', files);
    assert.equal(readable.status, 'PASS');
    assert.equal(readable.authoritative[0]?.selector, '{src/fragile.ts,src/keep.ts}');
    const covered = compileSelector(readable.authoritative[0]?.selector as string);
    assert.equal(covered.matches('src/fragile.ts'), true);
    assert.equal(covered.matches('src/keep.ts'), true);
    assert.equal(covered.matches('src/fragile.source'), false,
      'reading through a logical alias does not authorize the physical target path');
    assert.equal(covered.matches('src/unselected.ts'), false,
      'an explicit run cannot forget an unselected source');
    const store = new SqliteStore({ path: storePath, ontologyVersion: '1.0.0' });
    try {
      assert.equal(store.node(contract('Fragile'))?.path, 'src/fragile.ts');
      assert.equal(store.node(contract('Fragile'))?.lastSeenRun, 'linked-readable');
    } finally {
      await store.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3: no contract-absence detector reads a file the claim leaves out   */
/* ------------------------------------------------------------------ */

describe('an excluded Zod file cannot make a detector that reads contract absence fire', () => {
  const TSCONFIG = JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src'],
  });

  // X9 reasons from the absence of a contracts-scope fact: a served route
  // (code scope) with no declared Operation. Three routes, two declared.
  const ROUTES = `interface Router { get(path: string, handler: (id: string) => unknown): void }
declare const app: Router;
export function getUser(id: string): unknown { return { id }; }
export function getAccount(id: string): unknown { return { id }; }
export function getOrder(id: string): unknown { return { id }; }
app.get('/users/:id', getUser);
app.get('/accounts/:id', getAccount);
app.get('/orders/:id', getOrder);
`;
  const OPENAPI = `openapi: 3.0.3
info: { title: Fixture API, version: 1.0.0 }
paths:
  /users/{id}:
    get: { operationId: getUser, responses: { '200': { description: ok } } }
  /accounts/{id}:
    get: { operationId: getAccount, responses: { '200': { description: ok } } }
`;
  const BASE: Readonly<Record<string, string>> = {
    'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }),
    'tsconfig.json': TSCONFIG,
    'src/routes.ts': ROUTES,
    'openapi.yaml': OPENAPI,
    'src/known.ts': `${ZOD}export const Known = z.object({ id: z.string() });`,
  };
  const EXTRA: Readonly<Record<string, string>> = {
    'src/unreadable.ts': `${ZOD}export const Unreadable = z.object({ ...imported, id: z.string() });`,
  };

  interface Outcome {
    readonly contractsStatus: string;
    readonly selector: string | undefined;
    readonly operations: ReadonlyArray<string>;
    readonly findings: ReadonlyArray<string>;
    readonly x9: string | undefined;
    readonly x9Direct: number;
    readonly x9Withheld: string | undefined;
    readonly x9ContractWithheld: string | undefined;
  }

  async function analyse(
    files: Readonly<Record<string, string>>,
    priorFiles?: Readonly<Record<string, string>>,
  ): Promise<Outcome> {
    const root = mkdtempSync(join(tmpdir(), 'seamline-partial-x9-'));
    const dir = mkdtempSync(join(tmpdir(), 'seamline-partial-x9-db-'));
    try {
      const prior =
        priorFiles === undefined
          ? undefined
          : (() => {
              writeTree(root, priorFiles);
              return extractContracts({ repoRoot: root, repo: REPO, runId: 'r0' });
            })();
      writeTree(root, files);
      const code = extractCodeTs({ repoRoot: root, repo: REPO, runId: 'r1', deterministic: true });
      const contracts = extractContracts({ repoRoot: root, repo: REPO, runId: 'r1' });
      const join_: ExtractorResult = {
        extractor: 'infer-join',
        version: '0',
        status: 'PASS',
        authoritative: [{ scope: 'infer-join', kinds: [], selector: 'IMPLEMENTED_BY' }],
        nodeCount: 0,
        edgeCount: 0,
        durationMs: 0,
        diagnostics: [],
      };
      assert.equal(code.result.status, 'PASS', code.result.diagnostics.join('\n'));
      const store = new SqliteStore({ path: join(dir, 'graph.db'), ontologyVersion: '1.0.0' });
      try {
        if (prior !== undefined) {
          assert.equal(prior.result.status, 'PASS');
          assert.equal(prior.nodes.filter((node) => node.kind === 'Operation').length, 2);
          await store.beginRun({
            runId: 'r0',
            repo: REPO,
            commit: null,
            startedAt: '2026-01-01T00:00:00.000Z',
            ontologyVersion: '1.0.0',
          });
          await store.upsertNodes('r0', prior.nodes);
          await store.upsertEdges('r0', CONTRACTS_SCOPE, prior.edges);
          await store.finalizeRun('r0', [prior.result]);
          assert.equal(store.nodesByKind('Operation').length, 2);
        }
        await store.beginRun({
          runId: 'r1',
          repo: REPO,
          commit: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          ontologyVersion: '1.0.0',
        });
        await store.upsertNodes('r1', [...code.nodes, ...contracts.nodes]);
        await store.upsertEdges('r1', CODE_TS_SCOPE, code.edges);
        await store.upsertEdges('r1', CONTRACTS_SCOPE, contracts.edges);
        await store.finalizeRun('r1', [code.result, contracts.result, join_]);

        const view: GraphView = store;
        const report = runDetectors(view);
        return {
          contractsStatus: view.scopeStatus(CONTRACTS_SCOPE),
          selector: contracts.result.authoritative[0]?.selector,
          operations: view
            .nodesByKind('Operation')
            .map((n) => n.id as string)
            .sort(),
          findings: report.findings.map((f) => `${f.code} ${f.left} ${f.right} ${f.claim}`),
          x9: report.detectors.find((d) => d.code === 'X9_CONTRACT_DRIFT')?.outcome,
          x9Direct: x9ContractDrift.detect(view).length,
          x9Withheld: runDetectors(
            profileView(view, {
              ...TEAM_PROFILE,
              allowProps: { ...TEAM_PROFILE.allowProps, Contract: [], Operation: [] },
            }),
          ).detectors.find((d) => d.code === 'X9_CONTRACT_DRIFT')?.outcome,
          x9ContractWithheld: runDetectors(
            profileView(view, {
              ...TEAM_PROFILE,
              allow: TEAM_PROFILE.allow.filter(([kind]) => kind !== 'Contract'),
              allowProps: Object.fromEntries(
                Object.entries(TEAM_PROFILE.allowProps).filter(([kind]) => kind !== 'Contract'),
              ),
            }),
          ).detectors.find((d) => d.code === 'X9_CONTRACT_DRIFT')?.outcome,
        };
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a Zod file never contributes an Operation, which is all X9 reads from the contracts scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seamline-partial-ops-'));
    try {
      writeTree(dir, { ...EXTRA, 'src/known.ts': BASE['src/known.ts'] as string });
      const out = extractContracts({ repoRoot: dir, repo: REPO, runId: 'r1' });
      assert.deepEqual(
        out.nodes.filter((n) => n.kind === 'Operation' || n.kind === 'RouteHandler'),
        [],
      );
      assert.ok(out.nodes.some((n) => n.kind === 'Contract' && n.name === 'Known'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('X9 reports the same undeclared route with and without the excluded file, and the scope still passes', async () => {
    const control = await analyse(BASE);
    const partial = await analyse({ ...BASE, ...EXTRA });

    assert.equal(control.contractsStatus, 'PASS');
    assert.equal(control.selector, undefined);
    assert.equal(partial.contractsStatus, 'PASS', 'the unreadable schema does not fail the scope');
    assert.ok(partial.selector !== undefined, 'the claim is narrowed to the files it vouches for');
    assert.ok(!partial.selector.includes('unreadable.ts'));

    // The only absence the detector reads is an Operation, and the unreadable
    // file declares none: operations and findings are identical.
    assert.deepEqual(partial.operations, control.operations);
    assert.equal(control.operations.length, 2);
    assert.equal(partial.x9, 'fired');
    assert.deepEqual(partial.findings, control.findings);
    assert.equal(partial.findings.filter((f) => f.startsWith('X9_CONTRACT_DRIFT')).length, 1);
    assert.match(
      partial.findings.join('\n'),
      /GET \/orders\/:id is served but no contract operation declares it/u,
    );
  });

  test('an unread discovered document makes X9 UNKNOWN even with unsupported Zod and PASS scopes', async () => {
    const control = await analyse(BASE);
    assert.equal(control.x9, 'fired', 'the absence conclusion is otherwise observable');
    assert.equal(control.x9Withheld, 'unknown', 'a profile cannot erase the coverage guard');
    const partial = await analyse({ ...BASE, ...EXTRA, 'data.json': '{"openapi":' });
    assert.equal(partial.contractsStatus, 'PASS');
    assert.equal(partial.x9, 'unknown');
    assert.equal(partial.x9Direct, 0, 'direct detection also refuses the unsupported absence');
    assert.equal(partial.findings.filter((f) => f.startsWith('X9_CONTRACT_DRIFT')).length, 0);
  });

  test('a withheld current witness cannot make retained operations prove completeness', async () => {
    const { 'openapi.yaml': _api, ...other } = BASE;
    const operation = (operationId: string) => ({
      get: {
        operationId,
        responses: { '200': { description: 'ok' } },
      },
    });
    const prior = {
      ...other,
      'data.json': JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Fixture API', version: '1.0.0' },
        paths: { '/users/{id}': operation('getUser'), '/accounts/{id}': operation('getAccount') },
      }),
    };
    const partial = await analyse({ ...prior, ...EXTRA, 'data.json': '{"openapi":' }, prior);
    assert.equal(partial.contractsStatus, 'PASS');
    assert.equal(partial.operations.length, 2, 'unread document retains prior operations');
    assert.equal(partial.x9, 'unknown');
    assert.equal(partial.x9ContractWithheld, 'unknown');
    assert.equal(partial.findings.filter((f) => f.startsWith('X9_CONTRACT_DRIFT')).length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* 4: a facet the extractor left unknown is never a stated fact        */
/* ------------------------------------------------------------------ */

describe('X1 reads only the null-ness a Zod property states', () => {
  const TSCONFIG = JSON.stringify({
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
  });
  const sql = (columnType: string) => `CREATE TABLE orders (
    id          bigserial PRIMARY KEY,
    shipped_at  ${columnType}
);
`;

  // Where the unions below get their branches from. The extractor does not
  // follow a list through a binding or a call, and one branch is a `null`.
  const UNENUMERATED_BRANCHES = `const OPTIONS = [z.string(), z.null()] as const;
const NUL = null;
const UND = undefined;
const COERCING = { coerce: true };
function make() {
  return [z.string(), z.null()] as const;
}
function options() {
  return { coerce: true };
}
`;

  /** Extract, persist, infer joins, persist the joins, and run the detectors. */
  async function x1For(shippedAt: string, declarations = '', columnType = 'timestamptz', sameContainer = true) {
    const root = mkdtempSync(join(tmpdir(), 'seamline-partial-x1-'));
    const dir = mkdtempSync(join(tmpdir(), 'seamline-partial-x1-db-'));
    try {
      writeTree(root, {
        'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }),
        'tsconfig.json': TSCONFIG,
        // These controls isolate the extracted property's facts. Give it a
        // matching container without claiming that its name proves direction.
        'db/schema.sql': sameContainer ? sql(columnType).replace('orders (', 'order_response (') : sql(columnType),
        'src/order-response.ts': `${ZOD}${declarations}export const OrderResponse = z.object({ id: z.number(), shippedAt: ${shippedAt} });`,
      });
      const run = { repo: REPO, runId: 'r1' };
      const code = extractCodeTs({ ...run, repoRoot: root, deterministic: true });
      const contracts = extractContracts({ ...run, repoRoot: root });
      const data = await extractData({ ...run, root, deterministic: true });
      for (const r of [code.result, contracts.result, data.result])
        assert.equal(r.status, 'PASS', `${r.extractor}: ${r.diagnostics.join('; ')}`);

      const store = new SqliteStore({ path: join(dir, 'graph.db'), ontologyVersion: '1.0.0' });
      try {
        const begin = (runId: string) =>
          store.beginRun({
            runId,
            repo: REPO,
            commit: null,
            startedAt: '2026-01-01T00:00:00.000Z',
            ontologyVersion: '1.0.0',
          });
        await begin('r1');
        await store.upsertNodes('r1', [...code.nodes, ...contracts.nodes, ...data.nodes]);
        await store.upsertEdges('r1', CODE_TS_SCOPE, code.edges);
        await store.upsertEdges('r1', CONTRACTS_SCOPE, contracts.edges);
        await store.upsertEdges('r1', DATA_SCOPE, data.edges);
        await store.finalizeRun('r1', [code.result, contracts.result, data.result]);

        const inferred = inferJoins(store, { runId: 'r2' });
        assert.equal(inferred.status, 'PASS');
        await begin('r2');
        await store.upsertEdges('r2', INFER_JOIN_SCOPE, inferred.edges);
        await store.finalizeRun('r2', [toExtractorResult(inferred, 0)]);

        const property = contracts.nodes.find(
          (n) => n.kind === 'SchemaProperty' && n.name === 'shippedAt',
        );
        assert.ok(property !== undefined, 'the property is emitted');
        const joined = inferred.edges.some((e) => e.src === property.id || e.dst === property.id);
        const report = runDetectors(store);
        const x2Report = report.detectors.find((d) => d.code === 'X2_TYPE');
        assert.ok(x2Report);
        const column = data.nodes.find((n) => n.kind === 'Column' && n.name === 'shipped_at');
        assert.ok(column);
        const columnJoined = inferred.edges.some((e) =>
          (e.kind === 'EXPOSED_AS' && e.src === column.id && e.dst === property.id) ||
          (e.kind === 'BACKED_BY' && e.src === property.id && e.dst === column.id));
        return {
          props: property.props,
          joined,
          columnJoined,
          x2Outcome: x2Report.outcome,
          x2Notes: x2Report.notes,
          x1: report.findings.filter((f) => f.code === 'X1_NULLABILITY').map((f) => f.claim),
          x2: report.findings.filter((f) => f.code === 'X2_TYPE').map((f) => f.claim),
        };
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a standalone non-nullable Zod property does not establish response direction', async () => {
    const out = await x1For('z.string().datetime()');
    assert.equal(out.joined, true, 'the column and the property are joined');
    assert.equal(out.props['nullable'], false);
    assert.deepEqual(out.x1, []);
  });

  test('a Response suffix cannot establish a join to a different container', async () => {
    const out = await x1For('z.string().datetime()', '', 'timestamptz', false);
    assert.equal(out.joined, false);
    assert.equal(out.props['nullable'], false, 'the extracted fact is preserved');
    assert.deepEqual(out.x1, []);
    assert.deepEqual(out.x2, []);
  });

  // [name, expression, column type, stated nullable, stated required]. Every
  // expression here accepts null, or may: none may state `nullable: false`.
  for (const [name, expression, columnType, nullable, required] of [
    ['a union whose branch hides a null', 'z.union([z.string().or(z.null()), z.number()])'],
    [
      'a union whose branch has an unread refinement',
      'z.union([z.string().refine(ok), z.number()])',
    ],
    [
      'an intersection with an unread refinement',
      'z.intersection(z.string().refine(ok), z.string())',
    ],
    // The branches are never enumerated: the argument is not an array literal.
    ['a union over a named list of branches', 'z.union(OPTIONS)'],
    ['a discriminated union over a named list', "z.discriminatedUnion('kind', OPTIONS)"],
    ['a union over a call result', 'z.union(make())'],
    // A literal null is a null; a literal the extractor cannot read is not a value.
    ['a literal null', 'z.literal(null)', 'timestamptz', true, true],
    [
      'a union with a literal null branch',
      'z.union([z.string(), z.literal(null)])',
      'timestamptz',
      true,
      true,
    ],
    ['a Zod 4 literal list holding a null', "z.literal(['a', null])", 'text', undefined, undefined],
    ['a literal of a named null', 'z.literal(NUL)', 'text', undefined, undefined],
    // Every branch is read and every branch accepts null; the intersection's own
    // schema says nothing about it.
    [
      'an intersection of nullable objects',
      'z.intersection(z.object({ a: z.string() }).nullable(), z.object({ b: z.string() }).nullable())',
      'jsonb',
      undefined,
      true,
    ],
    [
      'an intersection of nullable strings',
      'z.intersection(z.string().nullable(), z.string().nullable())',
      'text',
      undefined,
      true,
    ],
    // `.catch(v)` swallows a failure, so a null parses to `v`. A missing key is
    // accepted only when the receiver accepts one: Zod 4.4.0 to 4.4.2 reject it
    // for `z.string().catch('x')` and every other release accepts it, so a bare
    // catch leaves the presence unread and a catch after `.optional()` or
    // `.default(v)` states `required: false`. `z.coerce.*` turns a null into
    // 'null', 0, the epoch or false.
    ['a catch on a string', 'z.string().catch("x")', 'text', undefined, undefined],
    [
      'a catch on a datetime',
      'z.string().datetime().catch("1970-01-01T00:00:00Z")',
      'timestamptz',
      undefined,
      undefined,
    ],
    ['a catch after optional', 'z.string().optional().catch("x")', 'text', undefined, false],
    ['a catch after a default', 'z.string().default("d").catch("x")', 'text', undefined, false],
    ['a string coercion', 'z.coerce.string()', 'text', undefined, undefined],
    ['a number coercion', 'z.coerce.number()', 'integer', undefined, undefined],
    ['a date coercion', 'z.coerce.date()', 'timestamptz', undefined, undefined],
    ['a boolean coercion', 'z.coerce.boolean()', 'boolean', undefined, undefined],
    // The same coercion spelled as a constructor option, which Zod 3.25 and Zod 4
    // both read, and as an options argument that is not read at all.
    ['a string coercion by option', 'z.string({ coerce: true })', 'text', undefined, undefined],
    ['a number coercion by option', 'z.number({ coerce: true })', 'integer', undefined, undefined],
    ['a date coercion by option', 'z.date({ coerce: true })', 'timestamptz', undefined, undefined],
    [
      'a boolean coercion by option',
      'z.boolean({ coerce: true })',
      'boolean',
      undefined,
      undefined,
    ],
    ['a coercion by an options binding', 'z.number(COERCING)', 'integer', undefined, undefined],
    ['a coercion by an options call', 'z.number(options())', 'integer', undefined, undefined],
    // A bare catch branch has an unread presence, so the union and the
    // intersection holding it read as holding an unread branch.
    [
      'a union with a catch branch',
      "z.union([z.string().catch('x'), z.number()])",
      'text',
      undefined,
      undefined,
    ],
    [
      'an intersection with a catch branch',
      "z.intersection(z.string().catch('x'), z.string())",
      'text',
      undefined,
      undefined,
    ],
    [
      'a union with a catch-after-optional branch',
      "z.union([z.string().optional().catch('x'), z.number()])",
      'text',
      undefined,
      false,
    ],
    // The union has a single non-null branch, which the schema walk collapses to.
    [
      'a catch on a one-branch union',
      "z.union([z.literal('a')]).catch(null)",
      'text',
      undefined,
      undefined,
    ],
    // An unread literal may be `undefined`, so the key may be missing.
    ['a literal of a named undefined', 'z.literal(UND)', 'text', undefined, undefined],
    [
      'a Zod 4 literal list holding an undefined',
      "z.literal(['a', undefined])",
      'text',
      undefined,
      undefined,
    ],
  ] as ReadonlyArray<
    readonly [string, string, string?, (boolean | undefined)?, (boolean | undefined)?]
  >) {
    test(`${name}: the property states no non-null fact and X1 stays silent`, async () => {
      const out = await x1For(expression, UNENUMERATED_BRANCHES, columnType);
      assert.equal(out.joined, true, 'still joined, so silence is not for want of a join');
      assert.deepEqual(out.x1, []);
      assert.equal(out.props['nullable'], nullable);
      assert.equal(out.props['required'], required);
    });
  }

  // The controls for the coercion option: an options argument that cannot turn
  // coercion on states what the property says. Its response direction remains unknown.
  for (const [name, expression, columnType] of [
    ['an explicit coerce: false', 'z.number({ coerce: false })', 'integer'],
    ['a message option', "z.string({ required_error: 'needed' })", 'text'],
    ['a message string', "z.string('needed')", 'text'],
  ] as ReadonlyArray<readonly [string, string, string]>) {
    test(`control: ${name} still states a non-null property without inventing response direction`, async () => {
      const out = await x1For(expression, UNENUMERATED_BRANCHES, columnType);
      assert.equal(out.joined, true, 'the column and the property are joined');
      assert.equal(out.props['nullable'], false);
      assert.equal(out.props['required'], true);
      assert.deepEqual(out.x1, []);
    });
  }

  // X2 reads the type a property states. The shared schema walk reads a bare
  // `allOf` as an object, which an intersection of scalars is not.
  for (const [name, expression] of [
    ['an intersection of strings', 'z.intersection(z.string(), z.string())'],
    ['an intersection of bounded strings', 'z.intersection(z.string().min(1), z.string().max(9))'],
    [
      'an intersection of an object and a string',
      'z.intersection(z.object({ a: z.string() }), z.string())',
    ],
  ] as ReadonlyArray<readonly [string, string]>) {
    test(`${name}: the property states no type and X2 stays silent`, async () => {
      const out = await x1For(expression, '', 'text');
      assert.equal(out.joined, true, 'still joined, so silence is not for want of a join');
      assert.deepEqual(out.x2, []);
      assert.equal(out.props['type'], undefined);
      assert.equal(out.props['typeCategory'], undefined);
    });
  }

  for (const [columnType, expectedOutcome] of [['text', 'clean'], ['boolean', 'fired']] as const) {
    test(`control: an object intersection against ${columnType} retains X2 ${expectedOutcome} evidence`, async () => {
      const out = await x1For(
        'z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))',
        '',
        columnType,
      );
      assert.equal(out.joined, true);
      assert.equal(out.columnJoined, true, 'the actual column/property pair exists');
      assert.equal(out.props['type'], 'object');
      assert.equal(out.x2Outcome, expectedOutcome);
      if (columnType === 'text') {
        assert.deepEqual(out.x2, []);
        assert.match(out.x2Notes.join('\n'), /String\/JSON comparisons withheld/);
      } else {
        assert.deepEqual(out.x2, [
          'shipped_at stores boolean but the contract declares shippedAt as json',
        ]);
      }
    });
  }

});

/* ------------------------------------------------------------------ */
/* 5: a contract document that stops parsing is unread, not deleted    */
/* ------------------------------------------------------------------ */

describe('an OpenAPI document an edit leaves unparseable is not buried by the next run', () => {
  const OPENAPI = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Docs API', version: '1.0.0' },
    paths: { '/orders': { get: { operationId: 'listOrders', responses: { '200': {} } } } },
  });
  // The same document, cut off in the middle of an edit.
  const TRUNCATED = OPENAPI.slice(0, 60);

  async function liveRows(storePath: string): Promise<Record<string, string | null>> {
    const raw = new DatabaseSync(storePath, { readOnly: true });
    try {
      const rows = raw
        .prepare("SELECT kind, deleted_at FROM nodes WHERE kind IN ('Contract', 'Operation')")
        .all() as Array<{ kind: string; deleted_at: string | null }>;
      return Object.fromEntries(rows.map((row) => [row.kind, row.deleted_at]));
    } finally {
      raw.close();
    }
  }

  async function persistRun(
    root: string,
    storePath: string,
    runId: string,
  ): Promise<ExtractorResult> {
    const out = extractContracts({ repoRoot: root, repo: REPO, runId });
    const store = new SqliteStore({ path: storePath, ontologyVersion: '1.0.0' });
    try {
      await store.beginRun({
        runId,
        repo: REPO,
        commit: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        ontologyVersion: '1.0.0',
      });
      await store.upsertNodes(runId, out.nodes);
      await store.upsertEdges(runId, CONTRACTS_SCOPE, out.edges);
      await store.finalizeRun(runId, [out.result]);
    } finally {
      await store.close();
    }
    return out.result;
  }

  test('the contract and its operation stay live, and are forgotten only once the document is gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seamline-partial-doc-'));
    const dir = mkdtempSync(join(tmpdir(), 'seamline-partial-doc-db-'));
    const storePath = join(dir, 'graph.db');
    try {
      // `docs/api.json` is not a name that marks a file as a contract, so a
      // failure to parse it used to be ignored and the run claimed it whole.
      writeTree(root, {
        'docs/api.json': OPENAPI,
        'src/fine.ts': `${ZOD}export const Fine = z.object({ id: z.string() });`,
      });
      const first = await persistRun(root, storePath, 'run-1');
      assert.equal(first.status, 'PASS');
      assert.equal(first.authoritative[0]?.selector, undefined);
      assert.deepEqual(await liveRows(storePath), { Contract: null, Operation: null });

      writeTree(root, { 'docs/api.json': TRUNCATED });
      const second = await persistRun(root, storePath, 'run-2');
      assert.equal(second.status, 'PASS');
      assert.equal(second.authoritative[0]?.selector, 'src/**');
      assert.deepEqual(
        await liveRows(storePath),
        { Contract: null, Operation: null },
        'an unreadable document is not a deleted one',
      );

      rmSync(join(root, 'docs/api.json'));
      const third = await persistRun(root, storePath, 'run-3');
      assert.equal(third.authoritative[0]?.selector, undefined);
      assert.deepEqual(
        await liveRows(storePath),
        { Contract: 'run-3', Operation: 'run-3' },
        'a document that is gone, in a run that reads everything, is forgotten',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6: the notice the extractor writes is the one the readers parse     */
/* ------------------------------------------------------------------ */

describe('the count of contract files not read survives the extractor, the store and the reader', () => {
  // Every file below is read, and five of them are left out of the claim for
  // three different reasons: a shape that cannot be lowered, a name that two
  // files declare, and a document that reads like a contract but does not parse.
  const TREE: Readonly<Record<string, string>> = {
    'src/ok/a.ts': `${ZOD}export const A = z.object({ id: z.string() });`,
    'src/ok/b.ts': `${ZOD}export const B = z.object({ id: z.number() });`,
    'src/shape/spread.ts': `${ZOD}export const Spread = z.object({ ...imported, name: z.string() });`,
    'src/shape/spread-too.ts': `${ZOD}export const SpreadToo = z.object({ ...imported, size: z.number() });`,
    'src/dup/one.ts': `${ZOD}export const FormSchema = z.object({ email: z.string() });`,
    'src/dup/two.ts': `${ZOD}export const FormSchema = z.object({ total: z.number() });`,
    'docs/api.json': '{ "openapi": "3.0.3", "info": { "title": "Docs API", "version": "1.0.0" },',
  };
  const NOT_READ = [
    'docs/api.json',
    'src/dup/one.ts',
    'src/dup/two.ts',
    'src/shape/spread-too.ts',
    'src/shape/spread.ts',
  ];

  async function reportedBy(tree: Readonly<Record<string, string>>) {
    const root = mkdtempSync(join(tmpdir(), 'seamline-partial-notice-'));
    const dir = mkdtempSync(join(tmpdir(), 'seamline-partial-notice-db-'));
    try {
      writeTree(root, tree);
      const out = extractContracts({ repoRoot: root, repo: REPO, runId: 'r1' });
      const store = new SqliteStore({ path: join(dir, 'graph.db'), ontologyVersion: '1.0.0' });
      try {
        await store.beginRun({
          runId: 'r1',
          repo: REPO,
          commit: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          ontologyVersion: '1.0.0',
        });
        await store.upsertNodes('r1', out.nodes);
        await store.upsertEdges('r1', CONTRACTS_SCOPE, out.edges);
        await store.finalizeRun('r1', [out.result]);
        const run = await store.getRun('r1');
        return { result: out.result, narrowed: narrowedClaims(store, run) };
      } finally {
        await store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('the reader reports exactly the files the claim leaves out', async () => {
    const { result, narrowed } = await reportedBy(TREE);
    assert.equal(result.status, 'PASS');

    // What the claim leaves out, derived from the selector and not from the notice.
    const selector = result.authoritative[0]?.selector;
    assert.ok(selector !== undefined, 'the claim is narrowed');
    const claimed = compileSelector(selector);
    assert.deepEqual(
      Object.keys(TREE)
        .filter((file) => !claimed.matches(file))
        .sort(),
      NOT_READ,
    );

    assert.deepEqual(narrowed, [
      { scope: CONTRACTS_SCOPE, extractor: result.extractor, filesNotRead: NOT_READ.length },
    ]);
    assert.match(describeNarrowedClaim(narrowed[0] as NarrowedClaim), /5 file\(s\) not read/u);
  });

  test('a repository the extractor reads to the end reports nothing', async () => {
    const readable = Object.fromEntries(
      Object.entries(TREE).filter(([file]) => file.startsWith('src/ok/')),
    );
    const { result, narrowed } = await reportedBy(readable);
    assert.equal(result.authoritative[0]?.selector, undefined);
    assert.deepEqual(narrowed, []);
  });
});
