// SPDX-License-Identifier: Apache-2.0
/** Real producers, inferred joins and SQLite retention, without a synthetic authority oracle. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isCanonicalSelectorText, memoryGraphIndex, SqliteStore } from '@seamline/core';
import { runDetectors, x7ValidatorDivergence } from '@seamline/contradictions';
import { NODE_KINDS, type Contradiction, type ExtractorResult, type SeamlineNode } from '@seamline/ontology';
import { buildCliDeps, contradictionsDetectorPort, scopeAwareView, sqliteStorePort } from './wiring.ts';
import { defaultConfig, serializeConfig } from './config.ts';
import { bufferIo } from './io.ts';
import { runCli } from './run.ts';
import { parseSif, serializeSif } from './sif.ts';
import { currentObservationOf } from './current-observation.ts';
import { run as data } from './extractors/data.ts';
import { run as code } from './extractors/code-ts.ts';
import { run as contracts } from './extractors/contracts.ts';
import { runInferJoin } from './extractors/infer-join.ts';
import type { ExtractContext } from './ports.ts';
import { makeRun } from './testing.ts';

const input = JSON.parse(readFileSync(new URL('../../extract-contracts/src/__fixtures__/validated-write.files.json', import.meta.url), 'utf8')) as {
  files: Record<string, string>; route: string;
};

test('the actual sandboxed producer persists canonical authority and the CLI observes the changed write bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'write-sandbox-lifecycle-'));
  try {
    for (const [path, text] of Object.entries({ ...input.files, 'src/app/items/route.ts': input.route })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    writeFileSync(join(root, 'seamline.config.json'), serializeConfig(defaultConfig('demo')));
    const session = () => {
      const io = bufferIo({ cwd: root, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
      return { ...buildCliDeps(io), io, detectors: contradictionsDetectorPort([x7ValidatorDivergence]) };
    };
    const selected = ['extract-data', 'extract-code-ts', 'extract-contracts', 'infer-join'];
    const extract = async (): Promise<string> => {
      const deps = session();
      // Keep the production sandbox ports. No in-process extractor substitutes.
      assert.equal(await runCli(deps, ['extract', ...selected.flatMap(name => ['--only', name])]), 0,
        deps.io.stdout() + deps.io.stderr());
      const workspace = await sqliteStorePort().open({ repoRoot: root, outDir: join(root, 'seamline-out'), repo: 'demo', create: false });
      try {
        const run = await workspace.runs.latest();
        assert.ok(run !== undefined);
        assert.deepEqual(run.results.map(result => [result.extractor, result.status]).sort(),
          selected.map(name => [name, 'PASS']).sort(), JSON.stringify(run.results));
        assert.ok(run.results.find(result => result.extractor === 'extract-contracts')?.authoritative.some(claim =>
          isCanonicalSelectorText(claim.selector ?? '')), 'actual framed worker claims survive host validation and SQLite');
        const properties = workspace.store.nodesByKind('SchemaProperty').filter(node => ['title', 'caption'].includes(node.name));
        assert.equal(properties.length, 2);
        for (const property of properties) {
          assert.equal(property.props['writeBindingComplete'], true);
          assert.equal(currentObservationOf(run)('contracts', property), true);
        }
        return run.runId;
      } finally { await workspace.store.close(); }
    };
    const before = await extract();
    const conflict = session();
    await runCli(conflict, ['check', '--json']);
    const initial = JSON.parse(conflict.io.stdout()) as {
      outcome: string; contradictions: Contradiction[]; unknownDetectors: unknown[];
    };
    assert.equal(initial.outcome, 'findings');
    assert.equal(initial.contradictions.length, 2, 'both original authored string bounds reach the real consumer');
    assert.ok(initial.contradictions.every(finding => finding.code === x7ValidatorDivergence.code));
    assert.deepEqual(initial.unknownDetectors, []);
    writeFileSync(join(root, 'src/app/items/route.ts'), input.route
      .replace('title: z.string().optional()', 'title: z.string().max(120).optional()')
      .replace('caption: z.string().optional()', 'caption: z.string().max(500).optional()'));
    assert.notEqual(await extract(), before, 'the actual extraction run changes with the source bound');
    const fixed = session();
    assert.equal(await runCli(fixed, ['check', '--json']), 0, fixed.io.stderr());
    const final = JSON.parse(fixed.io.stdout()) as { outcome: string; contradictions: Contradiction[]; unknownDetectors: unknown[] };
    assert.equal(final.outcome, 'clean');
    assert.deepEqual(final.contradictions, []);
    assert.deepEqual(final.unknownDetectors, [], 'the authored fixed control is examined through actual sandbox extraction');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the compiled CLI worker persists real canonical write claims and observes a bounded repair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'write-compiled-lifecycle-'));
  const binary = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
  try {
    for (const [path, text] of Object.entries({ ...input.files, 'src/app/items/route.ts': input.route })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    writeFileSync(join(root, 'seamline.config.json'), serializeConfig(defaultConfig('demo')));
    const invoke = (args: readonly string[]) => {
      const result = spawnSync(process.execPath, [binary, ...args], { cwd: root, encoding: 'utf8',
        env: { ...process.env, SEAMLINE_DETERMINISTIC: '1', NODE_TEST_CONTEXT: undefined },
        timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.signal, null, result.stderr);
      return result;
    };
    const extract = async () => {
      const result = invoke(['extract', ...['extract-data', 'extract-code-ts', 'extract-contracts', 'infer-join'].flatMap(name => ['--only', name])]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const workspace = await sqliteStorePort().open({ repoRoot: root, outDir: join(root, 'seamline-out'), repo: 'demo', create: false });
      try {
        const run = await workspace.runs.latest();
        assert.ok(run !== undefined);
        assert.equal(run.results.length, 4);
        assert.ok(run.results.every(output => output.status === 'PASS'), JSON.stringify(run.results));
        assert.ok(run.results.find(output => output.extractor === 'extract-contracts')?.authoritative.some(claim =>
          isCanonicalSelectorText(claim.selector ?? '')), 'the compiled worker must transport the producer authority');
        const properties = workspace.store.nodesByKind('SchemaProperty').filter(node => ['title', 'caption'].includes(node.name));
        assert.equal(properties.length, 2);
        for (const property of properties) assert.equal(currentObservationOf(run)('contracts', property), true);
        return properties.map(node => node.id).sort();
      } finally { await workspace.store.close(); }
    };
    const properties = await extract();
    const before = invoke(['check', '--json', '--code', x7ValidatorDivergence.code]);
    assert.ok(before.status === 0 || before.status === 1, before.stdout + before.stderr);
    const conflict = JSON.parse(before.stdout) as { contradictions: Contradiction[]; unknownDetectors: { code: string }[] };
    assert.deepEqual(conflict.contradictions.map(finding => finding.right).sort(), properties);
    assert.equal(conflict.unknownDetectors.some(detector => detector.code === x7ValidatorDivergence.code), false);
    writeFileSync(join(root, 'src/app/items/route.ts'), input.route
      .replace('title: z.string().optional()', 'title: z.string().max(120).optional()')
      .replace('caption: z.string().optional()', 'caption: z.string().max(500).optional()'));
    assert.deepEqual(await extract(), properties, 'the bound changes preserve path-free property identity');
    const after = invoke(['check', '--json', '--code', x7ValidatorDivergence.code]);
    assert.equal(after.status, 0, after.stdout + after.stderr);
    const repaired = JSON.parse(after.stdout) as { contradictions: Contradiction[]; unknownDetectors: { code: string }[] };
    assert.deepEqual(repaired.contradictions, []);
    assert.equal(repaired.unknownDetectors.some(detector => detector.code === x7ValidatorDivergence.code), false,
      'other detectors may be unknown; the compiled X7 fixed pair must be examined');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a supported write becomes UNKNOWN when its old facts are retained, including a same-id retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'write-lifecycle-'));
  const store = new SqliteStore({ ontologyVersion: '1.0.0' });
  try {
    const initialRoute = input.route.replace('const {title, caption} = body;',
      'const record = await load(); const allowed = await permission(user, record); const {title, caption} = body;');
    for (const [path, text] of Object.entries({ ...input.files, 'src/app/items/route.ts': initialRoute, 'src/legacy.ts': "import {z} from 'zod'; export const Legacy = z.object({ok: z.boolean()});" })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const runId = 'run-det-ffffffffffffffff';
    const ctx: ExtractContext = { repoRoot: root, repo: 'demo', runId, outDir: join(root, 'seamline-out'),
      include: ['**/*'], exclude: [], options: {}, deterministic: true };
    let emittedContracts: readonly SeamlineNode[] = [];
    const execute = async (retry: boolean): Promise<readonly ExtractorResult[]> => {
      if (retry) await store.restartRun(makeRun(runId, []));
      else await store.beginRun(makeRun(runId, []));
      const outputs = [];
      const database = await data(ctx);
      assert.equal(database.result.status, 'PASS', database.result.diagnostics.join('\n'));
      assert.ok(database.dataModelIndex !== undefined);
      outputs.push(database, await code({ ...ctx, dataModelIndex: database.dataModelIndex }),
        await contracts({ ...ctx, dataModelIndex: database.dataModelIndex }));
      emittedContracts = outputs[2]?.nodes ?? [];
      for (const output of outputs) {
        assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
        await store.upsertNodes(runId, output.nodes);
        for (const scope of output.edges) await store.upsertEdges(runId, scope.scope, scope.edges);
      }
      const results = outputs.map(output => output.result);
      // The real join producer reads the actual statuses and extracted graph.
      const inferred = runInferJoin(scopeAwareView(store, results), { runId }, true);
      assert.equal(inferred.result.status, 'PASS', inferred.result.diagnostics.join('\n'));
      await store.upsertEdges(runId, 'infer-join', inferred.edges);
      await store.finalizeRun(runId, [...results, inferred.result]);
      return results;
    };
    const report = async () => runDetectors(store, [x7ValidatorDivergence], currentObservationOf(await store.getRun(runId)));
    await execute(false);
    const before = await report();
    assert.equal(before.detectors[0]?.outcome, 'fired');
    assert.deepEqual(before.findings.map(finding => store.node(finding.right)?.name).sort(), ['caption', 'title']);
    const property = store.nodesByKind('SchemaProperty').find(node => node.name === 'title');
    assert.ok(property !== undefined);
    const opaqueRoute = input.route.replace("z.object({title: z.string().optional(), caption: z.string().optional(), kind: z.enum(['note'])})", 'makeSchema()');
    assert.notEqual(opaqueRoute, input.route);
    const mixedRoute = opaqueRoute
      .replace('const schema = makeSchema();',
        `const goodSchema = z.object({title: z.string().optional()});
         const {body: goodBody, error: goodError} = await decode(request, goodSchema);
         if (goodError) { return goodError(); }
         const schema = makeSchema();`)
      .replace('const {body, error} = await decode(request, schema);',
        `const args = [undefined, undefined]; args[0] = request; args[1] = schema;
         const {body, error} = await decode['apply'](undefined, args);`)
      .replace("const saved = await persist('id', {title, caption, kind});",
        "await persist('good', {title: goodBody.title}); const saved = await persist('id', {title, caption, kind});");
    // Prove the other schema is independently admitted before testing its
    // coexistence with an opaque parser. Legacy PASS alone is insufficient.
    writeFileSync(join(root, 'src/app/items/route.ts'), input.route.replace(/\bschema\b/g, 'goodSchema'));
    await execute(true);
    const supportedOther = await report();
    assert.equal(supportedOther.detectors[0]?.outcome, 'fired');
    assert.equal(supportedOther.findings.length, 2);
    const goodProperty = supportedOther.findings.map(finding => store.node(finding.right)).find(node => node?.name === 'title');
    assert.ok(goodProperty !== undefined && goodProperty.id !== property.id);
    assert.equal(goodProperty.props['writeBindingComplete'], true);
    assert.equal(currentObservationOf(await store.getRun(runId))('contracts', goodProperty), true);
    writeFileSync(join(root, 'src/app/items/route.ts'), initialRoute);
    await execute(true);
    assert.equal((await report()).findings.length, 2);
    // Every unsupported shape must exclude the prior fact even while another
    // valid contract keeps this scope PASS and the retry retains the same stamp.
    for (const source of [
      input.route.replace('decode(request, schema)', 'decode(request, schema, options)'),
      opaqueRoute,
      mixedRoute,
      mixedRoute.replace("decode['apply'](undefined, args)", 'decodePacked(args)'),
      mixedRoute.replace('const args = [undefined, undefined]; args[0] = request; args[1] = schema;', '')
        .replace("decode['apply'](undefined, args)", 'decodePacked(schema)'),
      ...['const first = await decodePacked(schema); const {body, error} = first;',
        'const first = await decodePacked(schema); const second = first; const {body, error} = second;',
        'let first = {}; first = await decodePacked(schema); const {body, error} = first;',
        'const first = await decodePacked(schema); const {body, error} = {...first};',
      ].map(result => mixedRoute.replace('const args = [undefined, undefined]; args[0] = request; args[1] = schema;', '')
        .replace("const {body, error} = await decode['apply'](undefined, args);", result)),
      mixedRoute.replace('const args = [undefined, undefined]; args[0] = request; args[1] = schema;',
        'const args = [arguments[0], schema];').replace("decode['apply'](undefined, args)", 'decodePacked(args)'),
      opaqueRoute.replace('decode(request, schema)', 'decode({request, schema})'),
      opaqueRoute.replace('const {body, error} = await decode(request, schema);',
        'const invoke = decode.bind(undefined, request, schema); const {body, error} = await invoke();'),
      ...['decode(...args)', 'decode.apply(undefined, args)', 'decode.call(undefined, ...args)',
        "decode['apply'](undefined, args)", '(decode.apply)(undefined, args)', 'invoke(undefined, args)',
      ].map(call =>
        opaqueRoute.replace('const {body, error} = await decode(request, schema);',
          `const args = [request, schema]; const invoke = decode.apply; const {body, error} = await ${call};`)),
      ...['decode((request), schema)', 'decode(request as Request, schema)', 'decode(<Request>request, schema)',
        'decode(request, (schema))', 'decode(request, schema as Unknown)', 'decode(request, schema!)',
        'decode(request, <Unknown>schema)',
        'decode(request, forward(schema))', 'decode(forward(request), schema)',
      ].map(call => opaqueRoute.replace('decode(request, schema)', call)),
      opaqueRoute.replace('const {body, error} = await decode(request, schema);',
        'const alias = request; const nextAlias = alias; const {body, error} = await decode(nextAlias, schema);'),
      opaqueRoute.replace('const {body, error} = await decode(request, schema);',
        'const alias = schema; const {body, error} = await decode(request, forward(alias));'),
      ...['POST({request}: {request: Request})', 'POST(request: Request = makeRequest())',
        'POST(...request: Request[])', 'POST()', 'POST(context: Context, request: Request)',
      ].map(signature => opaqueRoute.replace('POST(request: Request)', signature)),
      input.route.replace('const schema =', 'let schema ='),
      input.route.replace('const schema = z.object(', 'const {schema} = {schema: z.object(').replace("kind: z.enum(['note'])});", "kind: z.enum(['note'])})};"),
      'export const {POST} = makeHandlers();',
      input.route.replace('const schema =', '{ const schema =').replace('} catch (issue) { return failed(issue); }', '} catch (issue) { return failed(issue); } }'),
      "export * from '../../implementation';",
    ]) {
      writeFileSync(join(root, 'src/app/items/route.ts'), source);
      const results = await execute(true);
      const implicitRequestAlias = source.includes('arguments[0]');
      const knownGood = source.includes('const goodSchema') && !implicitRequestAlias;
      if (implicitRequestAlias) {
        assert.match(results.find(result => result.extractor === 'extract-contracts')?.diagnostics.join('\n') ?? '',
          /WRITE_IMPLICIT_ARGUMENTS_ALIAS/);
        assert.equal(emittedContracts.some(node => node.id === goodProperty.id), false,
          'an unproved implicit argument alias invalidates the shared function proof');
        const oldGood = store.node(goodProperty.id);
        assert.ok(oldGood !== undefined);
        assert.equal(oldGood.deletedAt, null, 'refusal retains the earlier good fact instead of burying it');
        assert.equal(currentObservationOf(await store.getRun(runId))('contracts', oldGood), false);
      }
      if (knownGood) {
        const supported: SeamlineNode | undefined = emittedContracts.find(node => node.id === goodProperty.id);
        assert.ok(supported !== undefined, 'the good binding must still be emitted beside the opaque one');
        assert.equal(supported.props['writeBindingComplete'], true);
        assert.equal(currentObservationOf(await store.getRun(runId))('contracts', supported), true,
          'the distinct complete binding remains current beside an opaque neighbour');
      }
      const retained = store.node(property.id) as SeamlineNode;
      assert.equal(retained.deletedAt, null);
      assert.equal(retained.lastSeenRun, runId);
      assert.equal(retained.props['writeBindingComplete'], true);
      assert.equal(currentObservationOf(await store.getRun(runId))('contracts', retained), false);
      const unsupported = await report();
      if (knownGood) {
        assert.deepEqual(unsupported.findings.map(finding => finding.right), [goodProperty.id],
          'only the known goodSchema contradiction is reported; retained schema facts never justify a finding');
        assert.equal(unsupported.detectors[0]?.outcome, 'fired');
      } else {
        assert.equal(unsupported.findings.length, 0);
        assert.equal(unsupported.detectors[0]?.outcome, 'unknown');
      }
    }
    writeFileSync(join(root, 'src/app/items/route.ts'), input.route.replaceAll('z.string().optional()', 'z.string().max(100).optional()'));
    await execute(true);
    assert.equal((await report()).detectors[0]?.outcome, 'clean');
    const recovered = store.node(property.id) as SeamlineNode;
    assert.equal(recovered.deletedAt, null);
    assert.equal(recovered.props['maxLength'], 100);
    assert.equal(currentObservationOf(await store.getRun(runId))('contracts', recovered), true);
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('real producer authority forgets a removed field and owned edge while consumers refuse the opaque neighbour', async () => {
  const root = mkdtempSync(join(tmpdir(), 'write-authority-lifecycle-'));
  const outDir = join(root, 'seamline-out');
  mkdirSync(outDir);
  const database = join(outDir, 'graph.db');
  let store = new SqliteStore({ path: database, ontologyVersion: '1.0.0' });
  const raw = new DatabaseSync(database);
  const runId = 'run-det-ffffffffffffffff';
  const routePath = join(root, 'src/app/items/route.ts');
  const goodRoute = input.route
    .replace("const schema = z.object({title: z.string().optional(), caption: z.string().optional(), kind: z.enum(['note'])});",
      'const goodSchema = z.object({title: z.string().optional(), caption: z.string().optional()});')
    .replace('decode(request, schema)', 'decode(request, goodSchema)')
    .replace('const kind = body.kind;', '')
    .replace('{title, caption, kind}', '{title, caption}');
  // Separate method functions are proved independently. Sequential guarded
  // parses remain refused and have their own original-source negative control.
  const initialRoute = goodRoute + '\n' + input.route.slice(input.route.indexOf('export async function POST'))
    .replace('function POST', 'function PUT');
  try {
    for (const [path, text] of Object.entries({ ...input.files, 'src/app/items/route.ts': initialRoute })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    writeFileSync(join(root, 'seamline.config.json'), serializeConfig(defaultConfig('demo')));
    const ctx: ExtractContext = { repoRoot: root, repo: 'demo', runId, outDir,
      include: ['**/*'], exclude: ['seamline-out/**'], options: {}, deterministic: true };
    const execute = async (retry: boolean): Promise<readonly SeamlineNode[]> => {
      if (retry) await store.restartRun(makeRun(runId, []));
      else await store.beginRun(makeRun(runId, []));
      const databaseOutput = await data(ctx);
      assert.equal(databaseOutput.result.status, 'PASS', databaseOutput.result.diagnostics.join('\n'));
      assert.ok(databaseOutput.dataModelIndex !== undefined);
      const outputs = [databaseOutput,
        await code({ ...ctx, dataModelIndex: databaseOutput.dataModelIndex }),
        await contracts({ ...ctx, dataModelIndex: databaseOutput.dataModelIndex })];
      for (const output of outputs) {
        assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
        await store.upsertNodes(runId, output.nodes);
        for (const group of output.edges) await store.upsertEdges(runId, group.scope, group.edges);
      }
      const results = outputs.map(output => output.result);
      const inferred = runInferJoin(scopeAwareView(store, results), { runId }, true);
      assert.equal(inferred.result.status, 'PASS', inferred.result.diagnostics.join('\n'));
      await store.upsertEdges(runId, 'infer-join', inferred.edges);
      await store.finalizeRun(runId, [...results, inferred.result]);
      return outputs[2]?.nodes ?? [];
    };
    const initial = await execute(false);
    const fields = (contract: SeamlineNode): SeamlineNode[] => store.edgesFrom(contract.id, 'CONTAINS')
      .flatMap(edge => { const node = store.node(edge.dst); return node?.kind === 'SchemaProperty' ? [node] : []; });
    const bindings = initial.filter(node => node.kind === 'Contract' && node.name.startsWith('validated-write:'));
    assert.equal(bindings.length, 2);
    const goodContract = bindings.find(node => fields(node).length === 2);
    const opaqueContract = bindings.find(node => fields(node).length === 3);
    assert.ok(goodContract !== undefined && opaqueContract !== undefined, 'both real bindings initially emit distinct contracts');
    const removed = fields(goodContract).find(node => node.name === 'caption');
    const kept = fields(goodContract).find(node => node.name === 'title');
    const opaque = fields(opaqueContract);
    const opaqueEdges = [...store.edgesFrom(opaqueContract.id, 'CONTAINS')];
    assert.ok(removed !== undefined && kept !== undefined);
    assert.equal(opaque.length, 3);
    assert.equal(opaqueEdges.length, 3);
    const ownedEdge = store.edgesFrom(goodContract.id, 'CONTAINS').find(edge => edge.dst === removed.id);
    assert.ok(ownedEdge !== undefined);
    const before = runDetectors(store, [x7ValidatorDivergence], currentObservationOf(await store.getRun(runId)));
    assert.equal(before.detectors[0]?.outcome, 'fired');
    assert.deepEqual(before.findings.map(finding => finding.right).sort(), [kept.id, removed.id,
      ...opaque.filter(node => node.name !== 'kind').map(node => node.id)].sort());

    // The same edge in a different scope must survive a contracts-only sweep.
    await store.beginRun(makeRun('foreign-owner', []));
    await store.upsertEdges('foreign-owner', 'foreign-owner', [ownedEdge]);
    await store.finalizeRun('foreign-owner', []);
    const reduced = initialRoute
      .replace('const goodSchema = z.object({title: z.string().optional(), caption: z.string().optional()});',
        'const goodSchema = z.object({title: z.string().optional()});')
      .replace('const {title, caption} = body;', 'const {title} = body;')
      .replace("persist('id', {title, caption})", "persist('id', {title})")
      .replace("const schema = z.object({title: z.string().optional(), caption: z.string().optional(), kind: z.enum(['note'])});",
        'const schema = makeSchema();');
    assert.notEqual(reduced, initialRoute);
    writeFileSync(routePath, reduced);
    const emitted = await execute(true);
    assert.ok(emitted.some(node => node.id === goodContract.id));
    assert.equal(emitted.some(node => node.id === opaqueContract.id), false);
    const tombstone = (id: string): unknown => raw.prepare('SELECT deleted_at FROM nodes WHERE id = ?').get(id)?.['deleted_at'];
    const edgeTombstone = (scope: string): unknown => raw.prepare(
      'SELECT deleted_at FROM edges WHERE scope = ? AND src_id = ? AND dst_id = ? AND kind = ?',
    ).get(scope, ownedEdge.src, ownedEdge.dst, ownedEdge.kind)?.['deleted_at'];
    const opaqueEdgeTombstones = (): unknown[] => opaqueEdges.map(edge => raw.prepare(
      'SELECT deleted_at FROM edges WHERE scope = ? AND src_id = ? AND dst_id = ? AND kind = ?',
    ).get('contracts', edge.src, edge.dst, edge.kind)?.['deleted_at']);
    assert.equal(tombstone(removed.id), runId, 'the producer owns the removed property family');
    assert.equal(edgeTombstone('contracts'), runId, 'the actual owned edge is stored as a tombstone');
    assert.equal(edgeTombstone('foreign-owner'), null, 'the foreign edge row survives even though its endpoint is hidden');
    assert.equal(store.node(removed.id), undefined);
    for (const node of [opaqueContract, ...opaque]) {
      const retained = store.node(node.id);
      assert.ok(retained !== undefined);
      assert.equal(retained.deletedAt, null);
      assert.equal(retained.lastSeenRun, runId);
      assert.equal(currentObservationOf(await store.getRun(runId))('contracts', retained), false);
    }
    const currentField = store.node(kept.id);
    assert.ok(currentField !== undefined);
    assert.equal(currentObservationOf(await store.getRun(runId))('contracts', currentField), true);
    assert.deepEqual(opaqueEdgeTombstones(), [null, null, null], 'every owned opaque edge remains stored and live');
    assert.deepEqual(store.edgesFrom(opaqueContract.id, 'CONTAINS').map(edge => edge.dst).sort(),
      opaqueEdges.map(edge => edge.dst).sort(), 'all opaque neighbour edges remain readable');

    await store.close();
    store = new SqliteStore({ path: database, ontologyVersion: '1.0.0' });
    assert.deepEqual(opaqueEdgeTombstones(), [null, null, null]);
    assert.deepEqual(store.edgesFrom(opaqueContract.id, 'CONTAINS').map(edge => edge.dst).sort(),
      opaqueEdges.map(edge => edge.dst).sort(), 'reopening preserves every retained owned edge');
    const completed = await store.getRun(runId);
    assert.ok(completed !== undefined);
    const nodes = NODE_KINDS.flatMap(kind => [...store.nodesByKind(kind)]);
    const edges = nodes.flatMap(node => [...store.edgesFrom(node.id)]);
    const snapshot = parseSif(serializeSif({ runId, run: completed, results: completed.results, nodes, edges }), 'producer lifecycle');
    const index = memoryGraphIndex();
    for (const node of snapshot.nodes) index.addNode(node);
    for (const edge of snapshot.edges) index.addEdge(edge);
    const snapshotView = scopeAwareView({ ...index, scopeStatus: () => 'UNAVAILABLE' }, snapshot.results);
    for (const [view, run] of [[store, completed], [snapshotView, snapshot.run]] as const) {
      const report = runDetectors(view, [x7ValidatorDivergence], currentObservationOf(run));
      assert.equal(report.detectors[0]?.outcome, 'fired');
      assert.deepEqual(report.findings.map(finding => finding.right), [kept.id]);
    }
    await store.close();
    const opened = await sqliteStorePort().open({ repoRoot: root, outDir, repo: 'demo', create: false });
    try {
      const latest = await opened.runs.latest();
      assert.deepEqual(latest, completed, 'the production StorePort must reopen the actual completed retry');
      const detection = await contradictionsDetectorPort([x7ValidatorDivergence]).run(opened.store, latest);
      assert.deepEqual(detection.contradictions.map(finding => finding.right), [kept.id], JSON.stringify(detection));
    } finally { await opened.store.close(); }
    const cli = (): ReturnType<typeof buildCliDeps> & { io: ReturnType<typeof bufferIo> } => {
      const io = bufferIo({ cwd: root, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
      return { ...buildCliDeps(io), io, detectors: contradictionsDetectorPort([x7ValidatorDivergence]) };
    };
    const check = cli();
    assert.equal(await runCli(check, ['check', '--json']), 0, check.io.stdout() + check.io.stderr());
    const checked = JSON.parse(check.io.stdout()) as {
      outcome: string; contradictions: Contradiction[]; narrowedClaims: unknown[]; unknownDetectors: unknown[];
    };
    assert.equal(checked.outcome, 'findings', 'a nonblocking exit does not mean no finding');
    assert.deepEqual(checked.contradictions.map(finding => finding.right), [kept.id]);
    assert.deepEqual(checked.contradictions.map(finding => [finding.severity, finding.confidence]), [['low', 0.445]],
      'retained candidates still reduce join confidence; currentness cannot promote the finding severity');
    assert.deepEqual(checked.unknownDetectors, []);
    assert.ok(checked.narrowedClaims.length > 0);
    const why = cli();
    const retainedTarget = opaque.find(node => node.name === 'title');
    assert.ok(retainedTarget !== undefined);
    assert.equal(await runCli(why, ['why', retainedTarget.id, '--json']), 0, why.io.stderr());
    const explained = JSON.parse(why.io.stdout()) as {
      target: SeamlineNode; contradictions: Contradiction[]; contradictionsAvailable: boolean; narrowedClaims: unknown[];
    };
    assert.equal(explained.target.id, retainedTarget.id, 'retention is visible without certifying it');
    assert.equal(explained.contradictionsAvailable, true);
    assert.ok(explained.contradictions.every(finding => !opaque.some(node => node.id === finding.right)));
    assert.ok(explained.narrowedClaims.length > 0);
    const knownWhy = cli();
    assert.equal(await runCli(knownWhy, ['why', kept.id, '--json']), 0, knownWhy.io.stderr());
    const knownExplanation = JSON.parse(knownWhy.io.stdout()) as {
      target: SeamlineNode; contradictions: Contradiction[]; contradictionsAvailable: boolean;
    };
    assert.equal(knownExplanation.target.id, kept.id);
    assert.equal(knownExplanation.contradictionsAvailable, true);
    assert.deepEqual(knownExplanation.contradictions.map(finding => finding.right), [kept.id],
      'a why implementation that skips detection cannot pass the positive control');
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'contradictions', arguments: { codes: [x7ValidatorDivergence.code] } } },
    ];
    for (const profile of ['audit', 'team']) {
      const mcp = { ...cli(), input: () => (async function* () {
        for (const frame of frames) yield `${JSON.stringify(frame)}\n`;
      })() };
      assert.equal(await runCli(mcp, ['mcp', '--profile', profile]), 0, mcp.io.stderr());
      const reply = mcp.io.stdout().split('\n').filter(Boolean).map(line => JSON.parse(line) as {
        id: number; result?: { isError: boolean; structuredContent: {
          result: { available: boolean; findings: Contradiction[]; unknownDetectors: { code: string }[] }; notices: string[];
        } };
      }).find(message => message.id === 2)?.result;
      assert.ok(reply !== undefined);
      assert.equal(reply.isError, false);
      assert.equal(reply.structuredContent.result.available, true);
      assert.deepEqual(reply.structuredContent.result.findings.map(finding => finding.right), profile === 'audit' ? [kept.id] : [],
        'MCP needs both actual current authority and a profile releasing the compared storage facts');
      assert.deepEqual(reply.structuredContent.result.unknownDetectors.map(detector => detector.code),
        profile === 'audit' ? [] : [x7ValidatorDivergence.code], 'team withholds storage lengths and cannot certify X7');
      assert.ok(reply.structuredContent.notices.some(notice => notice.includes('PARTIAL COVERAGE')));
    }

    store = new SqliteStore({ path: database, ontologyVersion: '1.0.0' });
    // Deleting the whole handler restores ordinary file-wide absence authority.
    writeFileSync(routePath, 'export const GET = () => new Response("ok");');
    // A fully read unrelated contract keeps the extractor available.
    writeFileSync(join(root, 'src/legacy.ts'), "import {z} from 'zod'; export const Legacy = z.object({ok: z.boolean()});");
    await execute(true);
    for (const node of [goodContract, opaqueContract, kept, ...opaque]) {
      assert.equal(tombstone(node.id), runId, 'a removed handler is forgotten, including formerly opaque facts');
      assert.equal(store.node(node.id), undefined);
    }
    assert.equal(edgeTombstone('contracts'), runId);
    assert.equal(edgeTombstone('foreign-owner'), null);
    assert.deepEqual(opaqueEdgeTombstones(), [runId, runId, runId], 'handler removal tombstones every formerly retained owned edge');
    writeFileSync(routePath, initialRoute);
    await execute(true);
    for (const node of [goodContract, opaqueContract, kept, removed, ...opaque]) {
      assert.equal(tombstone(node.id), null, 'reappearing producer facts clear their stored tombstones');
      assert.ok(store.node(node.id) !== undefined);
    }
    assert.equal(edgeTombstone('contracts'), null);
    assert.deepEqual(opaqueEdgeTombstones(), [null, null, null], 'returning owned edges clear their tombstones');
    rmSync(routePath);
    await execute(true);
    for (const node of [goodContract, opaqueContract, kept, removed, ...opaque]) {
      assert.equal(tombstone(node.id), runId, 'a deleted source file is covered by ordinary absence authority');
      assert.equal(store.node(node.id), undefined);
    }
    assert.equal(edgeTombstone('contracts'), runId);
    assert.equal(edgeTombstone('foreign-owner'), null);
    assert.deepEqual(opaqueEdgeTombstones(), [runId, runId, runId], 'file removal also tombstones every formerly retained owned edge');
  } finally {
    raw.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const change of ['get-only', 'deleted'] as const)
  for (const retry of [false, true])
    for (const command of [false, true])
      test(`${command ? 'unproved' : 'scriptless'} origins ${command ? 'retain' : 'retire'} ${change} write facts on ${retry ? 'same-id retry' : 'new run'}`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'write-script-authority-'));
        const path = join(root, 'authority.sqlite');
        const store = new SqliteStore({ path, ontologyVersion: '1.0.0' });
        const sql = new DatabaseSync(path);
        try {
          const route = join(root, 'src/app/items/route.ts');
          for (const [file, text] of Object.entries({ ...input.files, 'src/app/items/route.ts': input.route,
            'independent.schema.json': JSON.stringify({ $schema:'https://json-schema.org/draft/2020-12/schema',
              title:'Independent', type:'object', properties:{ok:{type:'boolean'}} }),
          })) {
            mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text);
          }
          const firstId = 'run-det-aaaaaaaaaaaaaaaa';
          const secondId = retry ? firstId : 'run-det-bbbbbbbbbbbbbbbb';
          const execute = async (runId: string, restart: boolean) => {
            if (restart) await store.restartRun(makeRun(runId, []));
            else await store.beginRun(makeRun(runId, []));
            const ctx: ExtractContext = {repoRoot:root,repo:'demo',runId,outDir:join(root,'seamline-out'),
              include:['**/*'],exclude:[],options:{},deterministic:true};
            const database = await data(ctx);
            assert.equal(database.result.status,'PASS',database.result.diagnostics.join('\n'));
            assert.ok(database.dataModelIndex !== undefined);
            const output = await contracts({...ctx,dataModelIndex:database.dataModelIndex});
            assert.equal(output.result.status,'PASS',output.result.diagnostics.join('\n'));
            assert.ok(output.nodes.some(node=>node.kind==='Contract'&&node.name==='Independent'),
              'an independently read contract keeps PASS from being a vacuous retention result');
            for(const part of [database,output]){
              await store.upsertNodes(runId,part.nodes);
              for(const edges of part.edges)await store.upsertEdges(runId,edges.scope,edges.edges);
            }
            await store.finalizeRun(runId,[database.result,output.result]);
            return output;
          };
          await execute(firstId,false);
          const old = store.nodesByKind('SchemaProperty').find(node=>node.name==='title'&&node.props['writeBindingComplete']===true);
          assert.ok(old);
          assert.equal(currentObservationOf(await store.getRun(firstId))('contracts',old),true);
          const edge = store.edgesTo(old.id,'CONTAINS')[0]; assert.ok(edge);
          if (change==='get-only') writeFileSync(route,'export async function GET() {}');
          else rmSync(join(root,'src'),{recursive:true,force:true});
          const original = JSON.parse(input.files['package.json'] as string) as Record<string,unknown>;
          writeFileSync(join(root,'package.json'),JSON.stringify({...original,...(command?{scripts:{build:'custom-emitter'}}:{})}));
          const after = await execute(secondId,retry);
          assert.equal(after.nodes.some(node=>node.kind==='SchemaProperty'&&node.props['writeBindingComplete']===true),false);
          const row = sql.prepare('SELECT deleted_at FROM nodes WHERE id = ?').get(old.id);
          assert.ok(row,'forgetting uses a tombstone, never a hard delete');
          if(command){
            assert.equal(row['deleted_at'],null,'an unproved source writer cannot establish handler absence');
            const retained=store.node(old.id); assert.ok(retained);
            assert.equal(currentObservationOf(await store.getRun(secondId))('contracts',retained),false,
              'retained facts are not current even when their run stamp matches the retry');
            assert.ok(store.edgesFrom(edge.src,'CONTAINS').some(item=>item.dst===old.id),'retained owned edge stays live');
          }else{
            assert.equal(row['deleted_at'],secondId,'scriptless complete absence still forgets the removed handler');
            assert.equal(store.edgesFrom(edge.src,'CONTAINS').some(item=>item.dst===old.id),false);
          }
        } finally {sql.close();await store.close();rmSync(root,{recursive:true,force:true});}
      });
