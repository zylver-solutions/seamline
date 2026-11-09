/**
 * `seamline export` and the one export profile format.
 *
 * The command-level tests use an in-memory store. The last block extracts the
 * bundled harbor-books example with the real extractors and checks the claims
 * that need a real graph: every shipped profile exports through the command
 * exactly what the policy engine releases, a declared profile and the shipped
 * profile it copies release the same set through both `export` and `mcp`, and
 * a second export is byte-identical.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, test } from 'node:test';
import {
  applyProfile,
  FORMAT_DOC_URL,
  LOCATION_FIELDS,
  parseExportProfile,
  PROFILES,
  RECORD_FIELDS,
} from '@seamline/core';
import { NODE_KINDS, type SeamlineEdge, type SeamlineNode } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig, type ExportProfile } from '../config.ts';
import { bufferIo, EXIT_OK, EXIT_USAGE } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { runCli } from '../run.ts';
import { makeEdge, makeNode, memoryGraph, memoryStorePort } from '../testing.ts';
import { buildCliDeps } from '../wiring.ts';
import { exportThrough } from './export.ts';

async function repoWithConfig(profiles?: Record<string, ExportProfile>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-export-'));
  const base = defaultConfig('demo');
  const config = profiles === undefined ? base : { ...base, exportProfiles: profiles };
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(config), 'utf8');
  return dir;
}

function deps(cwd: string, graph = memoryGraph()): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env: {} });
  return {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(graph),
  };
}

test('export with no profile refuses, writes nothing to stdout, and exits 2', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir);
  const code = await runCli(d, ['export']);
  assert.equal(code, EXIT_USAGE);
  assert.equal(d.io.stdout(), '', 'nothing was dumped');
  assert.match(d.io.stderr(), /default-deny/);
  assert.match(d.io.stderr(), /--profile/);
});

test('the refusal names every profile that exists, shipped and declared, so it is actionable', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir);
  await runCli(d, ['export']);
  assert.match(d.io.stderr(), /audit, public, structure, team/);
});

test('export with an undeclared profile refuses rather than falling back', async () => {
  const dir = await repoWithConfig();
  const d = deps(dir);
  const code = await runCli(d, ['export', '--profile', 'everything']);
  assert.equal(code, EXIT_USAGE);
  assert.equal(d.io.stdout(), '');
  assert.match(d.io.stderr(), /no export profile named "everything"/);
});

test('a name that is merely inherited from Object is not a profile', async () => {
  const dir = await repoWithConfig();
  for (const name of ['constructor', '__proto__', 'toString']) {
    const d = deps(dir);
    assert.equal(await runCli(d, ['export', '--profile', name]), EXIT_USAGE, name);
    assert.equal(d.io.stdout(), '', name);
  }
});

test('there is no flag that exports everything', async () => {
  const dir = await repoWithConfig();
  for (const argv of [
    ['export', '--all'],
    ['export', '--profile'],
    ['export', '*'],
  ]) {
    const d = deps(dir);
    const code = await runCli(d, argv);
    assert.notEqual(code, EXIT_OK, `refused: ${argv.join(' ')}`);
    assert.equal(d.io.stdout(), '', `no output for: ${argv.join(' ')}`);
  }
});

test('--list-profiles lists shipped and declared profiles without exporting any graph content', async () => {
  const dir = await repoWithConfig();
  const graph = memoryGraph({
    nodes: [makeNode({ kind: 'Column', canonicalName: 'users.email' })],
  });
  const d = deps(dir, graph);
  const code = await runCli(d, ['export', '--list-profiles']);
  assert.equal(code, EXIT_OK);
  for (const name of ['structure', 'public (shipped)', 'team (shipped)', 'audit (shipped)']) {
    assert.ok(d.io.stdout().includes(name), name);
  }
  assert.doesNotMatch(d.io.stdout(), /users\.email/, 'listing profiles is not an export');
});

// ---------------------------------------------------------------------------
// The policy as `export` applies it
// ---------------------------------------------------------------------------

/** Every record field except where the record came from: what the shipped `public` names. */
const NON_LOCATION = RECORD_FIELDS.filter((f) => !LOCATION_FIELDS.includes(f));

const openProfile = parseExportProfile({
  version: 1,
  name: 'open',
  description: 'test',
  allow: [
    ['File', 'internal'],
    ['Column', 'confidential'],
  ],
  allowEdges: ['CONTAINS'],
  allowProps: { Column: ['nullable'] },
  allowEdgeProps: {},
  allowFields: NON_LOCATION,
  allowProvenance: ['EXTRACTED'],
  includeUntrusted: false,
});

test('exportThrough drops nodes above the profile, and says why by count', () => {
  const internal = makeNode({ kind: 'File', canonicalName: 'src/a.ts', sensitivity: 'internal' });
  const secret = makeNode({
    kind: 'Column',
    canonicalName: 'users.ssn',
    sensitivity: 'restricted',
  });
  const graph = memoryGraph({ nodes: [internal, secret] });
  const report = exportThrough(graph.store, openProfile);
  assert.deepEqual(
    report.nodes.map((n) => n.id),
    [internal.id],
  );
  assert.deepEqual(report.withheld.byReason, { 'sensitivity-not-allowed': 1 });
});

test('a declared sensitivity cannot talk the policy down: the kind default is a floor', () => {
  // A Column defaults to `confidential`. An extractor that stored `internal` does not make it so.
  const understated = makeNode({
    kind: 'Column',
    canonicalName: 'users.email',
    sensitivity: 'internal',
  });
  const internalOnly = parseExportProfile({
    ...openProfile,
    name: 'internal-only',
    allow: [['Column', 'internal']],
    allowProps: {},
  });
  const graph = memoryGraph({ nodes: [understated] });
  const report = exportThrough(graph.store, internalOnly);
  assert.equal(
    report.nodes.length,
    0,
    'the effective level is confidential, so (Column, internal) does not match',
  );
  assert.equal(
    exportThrough(graph.store, openProfile).nodes[0]?.sensitivity,
    'confidential',
    'and the export reports the effective level',
  );
});

test('exportThrough drops kinds the profile did not name', () => {
  const table = makeNode({ kind: 'Table', canonicalName: 'users', sensitivity: 'internal' });
  const file = makeNode({ kind: 'File', canonicalName: 'src/a.ts', sensitivity: 'internal' });
  const report = exportThrough(memoryGraph({ nodes: [table, file] }).store, openProfile);
  assert.deepEqual(
    report.nodes.map((n) => n.id),
    [file.id],
  );
});

test('exportThrough drops untrusted nodes unless the profile opts in', () => {
  const tainted = makeNode({
    kind: 'File',
    canonicalName: 'src/b.ts',
    sensitivity: 'internal',
    untrusted: true,
  });
  const graph = memoryGraph({ nodes: [tainted] });
  assert.equal(exportThrough(graph.store, openProfile).nodes.length, 0);
  const opted = parseExportProfile({ ...openProfile, includeUntrusted: true });
  assert.equal(exportThrough(graph.store, opted).nodes.length, 1);
});

test('exportThrough drops a node whose provenance the profile does not list', () => {
  const guessed = makeNode({ kind: 'File', canonicalName: 'src/g.ts', provenance: 'INFERRED' });
  const graph = memoryGraph({ nodes: [guessed] });
  assert.equal(exportThrough(graph.store, openProfile).nodes.length, 0);
  const wider = parseExportProfile({ ...openProfile, allowProvenance: ['EXTRACTED', 'INFERRED'] });
  assert.equal(exportThrough(graph.store, wider).nodes.length, 1);
});

test('exportThrough emits only the named fields and props', () => {
  const node = makeNode({
    kind: 'Column',
    canonicalName: 'users.email',
    path: 'db/schema.sql',
    props: { nullable: false, pii: 'email' },
  });
  const graph = memoryGraph({ nodes: [node] });
  const [row] = exportThrough(graph.store, openProfile).nodes;
  assert.ok(row !== undefined);
  assert.equal(row.path, undefined, 'path was not named by allowFields');
  assert.deepEqual(row.props, { nullable: false }, 'the pii prop was not allow-listed');
  const withPath = parseExportProfile({ ...openProfile, allowFields: [...NON_LOCATION, 'path'] });
  assert.equal(exportThrough(graph.store, withPath).nodes[0]?.path, 'db/schema.sql');
});

test('exportThrough drops an edge whose endpoint the profile excluded', () => {
  const file = makeNode({ kind: 'File', canonicalName: 'src/a.ts', sensitivity: 'internal' });
  const secret = makeNode({
    kind: 'Column',
    canonicalName: 'users.ssn',
    sensitivity: 'restricted',
  });
  const graph = memoryGraph({
    nodes: [file, secret],
    edges: [makeEdge({ kind: 'CONTAINS', src: file.id, dst: secret.id, provenance: 'EXTRACTED' })],
  });
  const report = exportThrough(graph.store, openProfile);
  assert.equal(report.edges.length, 0, 'an excluded endpoint would leak that node exists');
  assert.equal(report.withheld.byReason['endpoint-withheld'], 1);
});

test('exportThrough never offers a tombstoned record to the policy', () => {
  const gone = makeNode({
    kind: 'File',
    canonicalName: 'src/gone.ts',
    deletedAt: '2026-01-01T00:00:00.000Z',
  });
  const live = makeNode({ kind: 'File', canonicalName: 'src/live.ts' });
  const report = exportThrough(memoryGraph({ nodes: [gone, live] }).store, openProfile);
  assert.deepEqual(
    report.nodes.map((n) => n.id),
    [live.id],
  );
  assert.equal(report.withheld.nodes, 0, 'a forgotten node is not even reported as withheld');
});

test('a node with an unrecognised sensitivity fails closed', () => {
  const weird = {
    ...makeNode({ kind: 'File', canonicalName: 'src/c.ts' }),
    sensitivity: 'totally-fine' as never,
  };
  const everything = parseExportProfile({ ...PROFILES['audit'], name: 'wide' });
  assert.equal(exportThrough(memoryGraph({ nodes: [weird] }).store, everything).nodes.length, 0);
});

// ---------------------------------------------------------------------------
// Loading: one parser, strict, no silent translation
// ---------------------------------------------------------------------------

const OLD_FORMAT_CONFIG = {
  version: 1,
  exportProfiles: {
    structure: {
      description: 'old',
      maxSensitivity: 'public',
      nodeKinds: ['Repo', 'Module', 'File'],
      edgeKinds: ['CONTAINS', 'IMPORTS'],
      fields: ['id', 'kind', 'name', 'path'],
      provenance: ['EXTRACTED'],
      includeUntrusted: false,
      props: [],
    },
  },
};

async function repoWithRawConfig(config: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-export-raw-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), `${JSON.stringify(config)}\n`, 'utf8');
  return dir;
}

test('a pre-version-1 profile in the config is refused, names its old fields, and exports nothing', async () => {
  const dir = await repoWithRawConfig(OLD_FORMAT_CONFIG);
  const d = deps(dir);
  const code = await runCli(d, ['export', '--profile', 'structure']);
  assert.equal(code, EXIT_USAGE);
  assert.equal(d.io.stdout(), '');
  assert.match(d.io.stderr(), /export profile 'structure': missing `version`/);
  assert.match(
    d.io.stderr(),
    /found maxSensitivity, nodeKinds, edgeKinds, fields, props, provenance, from the pre-version-1 profile format/,
  );
  assert.match(
    d.io.stderr(),
    /https:\/\/github\.com\/zylver-solutions\/seamline\/blob\/main\/docs\/design\/export-profile\.md#5-migration/,
    'the pointer is a URL an installed user can open',
  );
});

test('an unknown field in a declared profile is refused, not skipped', async () => {
  const declared = {
    ...JSON.parse(JSON.stringify(defaultConfig('demo').exportProfiles['structure'])),
    allowEverything: true,
  };
  delete declared.name;
  const dir = await repoWithRawConfig({ version: 1, exportProfiles: { mine: declared } });
  const d = deps(dir);
  assert.equal(await runCli(d, ['export', '--profile', 'mine']), EXIT_USAGE);
  assert.equal(d.io.stdout(), '');
  assert.match(d.io.stderr(), /export profile 'mine': unknown field "allowEverything"/);
  assert.equal(
    timesIn(d.io.stderr(), FORMAT_DOC_URL),
    1,
    'a message that carries no URL gets the format URL as a hint, once',
  );
});

test('a declared profile may not take a shipped name, so `team` means one thing in every repository', async () => {
  const declared = JSON.parse(
    JSON.stringify(defaultConfig('demo').exportProfiles['structure']),
  ) as Record<string, unknown>;
  delete declared['name'];
  const dir = await repoWithRawConfig({ version: 1, exportProfiles: { team: declared } });
  const d = deps(dir);
  assert.equal(await runCli(d, ['export', '--profile', 'team']), EXIT_USAGE);
  assert.match(d.io.stderr(), /'team' is a shipped profile/);
  assert.equal(d.io.stdout(), '');
});

test('a config that declares no profiles still has the shipped ones, and nothing else', async () => {
  const dir = await repoWithRawConfig({ version: 1 });
  const d = deps(dir);
  await runCli(d, ['export']);
  assert.match(d.io.stderr(), /Available profiles: audit, public, team\b/);
});

test('the scaffolded config round-trips: what init writes is what the parser reads, with no name field', () => {
  const written = serializeConfig(defaultConfig('demo'));
  const parsed = JSON.parse(written) as { exportProfiles: Record<string, Record<string, unknown>> };
  assert.equal(parsed.exportProfiles['structure']?.['name'], undefined, 'the key is the name');
  assert.equal(parsed.exportProfiles['structure']?.['version'], 1);
});

// ---------------------------------------------------------------------------
// A declared profile releases only the fields it selects
// ---------------------------------------------------------------------------

/**
 * `fields: [id, kind, name]` with `props: [loc]` in the earlier format,
 * migrated by hand as design section 5 says. The earlier command wrote the node
 * keys id, kind, name and props, and the single edge key kind; it never wrote a
 * sensitivity, a provenance, a run id or a deletion time, because the profile
 * did not name them.
 */
const MIGRATED = {
  version: 1,
  description: 'migrated from the earlier format',
  allow: [['File', 'internal']],
  allowEdges: ['IMPORTS'],
  allowProps: { File: ['loc'] },
  allowEdgeProps: {},
  allowFields: ['id', 'kind', 'name', 'props'],
  allowProvenance: ['EXTRACTED'],
  includeUntrusted: false,
};

type Row = Record<string, unknown>;

function timesIn(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function exportedBy(
  profile: Record<string, unknown>,
): Promise<{ nodes: Row[]; edges: Row[]; text: string }> {
  const dir = await repoWithRawConfig({ version: 1, exportProfiles: { mine: profile } });
  const a = makeNode({
    kind: 'File',
    canonicalName: 'src/a.ts',
    sensitivity: 'internal',
    props: { loc: 10, secret: 'x' },
  });
  const b = makeNode({
    kind: 'File',
    canonicalName: 'src/b.ts',
    sensitivity: 'internal',
    path: 'src/b.ts',
    props: { loc: 20 },
  });
  const link = makeEdge({
    kind: 'IMPORTS',
    src: a.id,
    dst: b.id,
    provenance: 'EXTRACTED',
    props: { via: 'static' },
  });
  const d = deps(dir, memoryGraph({ nodes: [a, b], edges: [link] }));
  assert.equal(await runCli(d, ['export', '--profile', 'mine']), EXIT_OK, d.io.stderr());
  const parsed = JSON.parse(d.io.stdout()) as { nodes: Row[]; edges: Row[] };
  return { nodes: parsed.nodes, edges: parsed.edges, text: d.io.stdout() };
}

test('a migrated profile with fields [id, kind, name] releases exactly the keys the earlier command wrote', async () => {
  const out = await exportedBy(MIGRATED);
  assert.equal(out.nodes.length, 2);
  for (const n of out.nodes) assert.deepEqual(Object.keys(n), ['id', 'kind', 'name', 'props']);
  assert.deepEqual(
    out.nodes.map((n) => n['props']),
    [{ loc: 10 }, { loc: 20 }],
    'only the listed prop; the other prop and its value are not released',
  );
  assert.equal(out.edges.length, 1);
  // The one shape difference: a profile that selects `props` writes the object,
  // empty when nothing on that record matched, where the earlier command left the key out.
  assert.deepEqual(Object.keys(out.edges[0] ?? {}), ['kind', 'props']);
  assert.deepEqual(out.edges[0]?.['props'], {}, 'and the edge prop `via` is not released');
  for (const word of ['run-1', 'firstSeenRun', 'lastSeenRun', 'deletedAt', 'sensitivity']) {
    assert.ok(!out.text.includes(word), `${word} is not released`);
  }
  assert.ok(!out.text.includes('"path"'), 'and neither is a path the profile did not name');
});

test('without `props` among the fields, the file carries no props object at all', async () => {
  const out = await exportedBy({
    ...MIGRATED,
    allowProps: {},
    allowFields: ['id', 'kind', 'name'],
  });
  for (const n of out.nodes) assert.deepEqual(Object.keys(n), ['id', 'kind', 'name']);
  assert.ok(!out.text.includes('"loc"'));
});

test('the run ids and deletedAt are released when, and only when, the profile names them', async () => {
  const out = await exportedBy({
    ...MIGRATED,
    allowProps: {},
    allowFields: ['id', 'firstSeenRun', 'lastSeenRun', 'deletedAt', 'src', 'dst', 'kind'],
  });
  for (const n of out.nodes) {
    assert.deepEqual(Object.keys(n), ['id', 'kind', 'firstSeenRun', 'lastSeenRun', 'deletedAt']);
    assert.equal(n['firstSeenRun'], 'run-1');
    assert.equal(n['deletedAt'], null);
  }
  assert.deepEqual(Object.keys(out.edges[0] ?? {}), [
    'kind',
    'src',
    'dst',
    'firstSeenRun',
    'lastSeenRun',
    'deletedAt',
  ]);
});

test('a path or a source reference is released only when named, per field', async () => {
  const out = await exportedBy({ ...MIGRATED, allowProps: {}, allowFields: ['id', 'path'] });
  assert.deepEqual(
    out.nodes.map((n) => Object.keys(n)),
    [['id'], ['id', 'path']],
    'only the node that has a path carries one',
  );
});

test('a profile that allows props but does not select `props` is refused, naming the profile and the field', async () => {
  const dir = await repoWithRawConfig({
    version: 1,
    exportProfiles: { mine: { ...MIGRATED, allowFields: ['id', 'kind'] } },
  });
  const d = deps(dir);
  assert.equal(await runCli(d, ['export', '--profile', 'mine']), EXIT_USAGE);
  assert.equal(d.io.stdout(), '', 'nothing was written');
  assert.match(
    d.io.stderr(),
    /export profile 'mine': `allowProps` is not empty but `allowFields` does not name `props`/,
  );
  assert.match(d.io.stderr(), /docs\/design\/export-profile\.md/);
  assert.equal(timesIn(d.io.stderr(), FORMAT_DOC_URL), 1, 'the format URL is printed once');
});

test('a profile whose only prop entries are empty lists releases no props and needs no `props` field', async () => {
  const out = await exportedBy({
    ...MIGRATED,
    allowProps: { File: [] },
    allowEdgeProps: { IMPORTS: [] },
    allowFields: ['id', 'kind', 'name'],
  });
  assert.equal(out.nodes.length, 2);
  for (const n of out.nodes) assert.deepEqual(Object.keys(n), ['id', 'kind', 'name']);
  assert.deepEqual(Object.keys(out.edges[0] ?? {}), ['kind']);
  assert.ok(!out.text.includes('loc') && !out.text.includes('via'), 'no prop name or value');
});

test('a profile that names a prop without `props` among the fields is refused even for one prop', async () => {
  const dir = await repoWithRawConfig({
    version: 1,
    exportProfiles: {
      mine: { ...MIGRATED, allowProps: { File: ['x'] }, allowFields: ['id', 'kind', 'name'] },
    },
  });
  const d = deps(dir);
  assert.equal(await runCli(d, ['export', '--profile', 'mine']), EXIT_USAGE);
  assert.equal(d.io.stdout(), '', 'nothing was written');
  assert.match(d.io.stderr(), /export profile 'mine': `allowProps` is not empty/);
});

test('includeUntrusted without `untrusted` among the fields is refused, so untrusted text never leaves without its marker', async () => {
  const dir = await repoWithRawConfig({
    version: 1,
    exportProfiles: { mine: { ...MIGRATED, includeUntrusted: true } },
  });
  const d = deps(dir);
  assert.equal(await runCli(d, ['export', '--profile', 'mine']), EXIT_USAGE);
  assert.equal(d.io.stdout(), '', 'nothing was written');
  assert.match(
    d.io.stderr(),
    /export profile 'mine': `includeUntrusted` is true but `allowFields` does not name `untrusted`/,
  );
});

// ---------------------------------------------------------------------------
// A real store: harbor-books
// ---------------------------------------------------------------------------

const EXAMPLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../examples/harbor-books',
);
const NON_HISTORY = ['extract-code-ts', 'extract-data', 'extract-contracts', 'infer-join'];

function session(
  cwd: string,
  frames: readonly unknown[] = [],
): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const lines = frames.map((f) => `${JSON.stringify(f)}\n`);
  return {
    ...buildCliDeps(io),
    io,
    input: () =>
      (async function* () {
        for (const line of lines) yield line;
      })(),
  };
}

const LINEAGE = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'lineage', arguments: { field: 'shipped_at' } },
  },
];

interface Exported {
  readonly profile: string;
  readonly nodes: Array<{ id: string }>;
  readonly edges: unknown[];
}

describe('export over a real store (harbor-books)', () => {
  let repo = '';

  async function exportBytes(profile: string): Promise<string> {
    const d = session(repo);
    assert.equal(
      await runCli(d, ['export', '--repo', repo, '--profile', profile]),
      EXIT_OK,
      d.io.stderr(),
    );
    return d.io.stdout();
  }

  async function wholeStore(): Promise<{ nodes: SeamlineNode[]; edges: SeamlineEdge[] }> {
    const d = session(repo);
    const ws = await d.store!.open({
      repoRoot: repo,
      outDir: path.join(repo, 'seamline-out'),
      repo: 'harbor-books',
      create: false,
    });
    try {
      const nodes = NODE_KINDS.flatMap((k) => [...ws.store.nodesByKind(k)]);
      const edges = nodes.flatMap((n) => [...ws.store.edgesFrom(n.id)]);
      return { nodes, edges };
    } finally {
      await ws.store.close();
    }
  }

  before(async () => {
    repo = mkdtempSync(path.join(tmpdir(), 'seamline-export-hb-'));
    cpSync(EXAMPLE, repo, { recursive: true });
    const d = session(repo);
    const code = await runCli(d, [
      'extract',
      '--repo',
      repo,
      ...NON_HISTORY.flatMap((n) => ['--only', n]),
    ]);
    assert.equal(code, EXIT_OK, d.io.stderr());
  });

  test('the example repository ships a config the parser reads', async () => {
    const d = session(repo);
    assert.equal(
      await runCli(d, ['export', '--repo', repo, '--list-profiles']),
      EXIT_OK,
      d.io.stderr(),
    );
    assert.match(d.io.stdout(), /structure/);
  });

  test('each shipped profile exports exactly what the policy engine releases from the same store', async () => {
    const { nodes, edges } = await wholeStore();
    assert.ok(nodes.length > 10 && edges.length > 10, 'a real graph, not an empty one');
    for (const [name, profile] of Object.entries(PROFILES)) {
      const released = applyProfile(nodes, edges, profile);
      const expected = `${JSON.stringify({ profile: name, nodes: released.nodes, edges: released.edges }, null, 2)}\n`;
      assert.equal(await exportBytes(name), expected, `export --profile ${name}`);
    }
  });

  test('the shipped profiles differ from one another on this graph, so the comparison above is not vacuous', async () => {
    const counts = new Map<string, number>();
    for (const name of Object.keys(PROFILES))
      counts.set(name, (JSON.parse(await exportBytes(name)) as Exported).nodes.length);
    assert.ok((counts.get('public') ?? 0) > 0);
    assert.ok((counts.get('public') ?? 0) < (counts.get('team') ?? 0));
  });

  test('no profile, no output, even over a populated store', async () => {
    const d = session(repo);
    assert.equal(await runCli(d, ['export', '--repo', repo]), EXIT_USAGE);
    assert.equal(d.io.stdout(), '');
  });

  test('export is deterministic: two runs are byte-identical', async () => {
    for (const name of Object.keys(PROFILES))
      assert.equal(await exportBytes(name), await exportBytes(name), name);
  });

  test('export and mcp read one declared profile identically: same allow-set, through the same parser', async () => {
    const config = JSON.parse(await readFile(path.join(repo, CONFIG_FILENAME), 'utf8')) as {
      exportProfiles: Record<string, unknown>;
    };
    const asDeclared = (name: string): Record<string, unknown> => {
      const { name: _drop, ...rest } = JSON.parse(JSON.stringify(PROFILES[name])) as Record<
        string,
        unknown
      >;
      return rest;
    };
    config.exportProfiles['like-team'] = asDeclared('team');
    config.exportProfiles['like-public'] = asDeclared('public');
    await writeFile(
      path.join(repo, CONFIG_FILENAME),
      `${JSON.stringify(config, null, 2)}\n`,
      'utf8',
    );

    for (const [declared, shipped] of [
      ['like-team', 'team'],
      ['like-public', 'public'],
    ] as const) {
      const viaDeclared = JSON.parse(await exportBytes(declared)) as Exported;
      const viaShipped = JSON.parse(await exportBytes(shipped)) as Exported;
      assert.deepEqual(
        { ...viaDeclared, profile: shipped },
        viaShipped,
        `export: ${declared} releases what ${shipped} does`,
      );

      const lineageVia = async (profile: string): Promise<string> => {
        const d = session(repo, LINEAGE);
        assert.equal(
          await runCli(d, ['mcp', '--repo', repo, '--profile', profile]),
          EXIT_OK,
          d.io.stderr(),
        );
        return d.io.stdout().replace(/\b[0-9a-f]{16}\b/g, '<nonce>');
      };
      assert.equal(
        await lineageVia(declared),
        await lineageVia(shipped),
        `mcp: ${declared} serves what ${shipped} does`,
      );
    }
    // The two are not the same thing: team serves the lineage chain, public serves none.
    const team = session(repo, LINEAGE);
    await runCli(team, ['mcp', '--repo', repo, '--profile', 'like-team']);
    assert.match(team.io.stdout(), /"found":true/);
    const open = session(repo, LINEAGE);
    await runCli(open, ['mcp', '--repo', repo, '--profile', 'like-public']);
    assert.match(open.io.stdout(), /"found":false/);
  });

  test('mcp refuses a malformed declared profile before serving a frame', async () => {
    const config = JSON.parse(await readFile(path.join(repo, CONFIG_FILENAME), 'utf8')) as {
      exportProfiles: Record<string, unknown>;
    };
    config.exportProfiles['broken'] = { description: 'no version', allow: [['File', 'internal']] };
    const broken = mkdtempSync(path.join(tmpdir(), 'seamline-export-broken-'));
    cpSync(repo, broken, { recursive: true });
    await writeFile(path.join(broken, CONFIG_FILENAME), `${JSON.stringify(config)}\n`, 'utf8');
    const d = session(broken, LINEAGE);
    assert.equal(await runCli(d, ['mcp', '--repo', broken, '--profile', 'team']), EXIT_USAGE);
    assert.equal(d.io.stdout(), '');
    assert.match(d.io.stderr(), /export profile 'broken': missing `version`/);
  });
});

// ---------------------------------------------------------------------------
// The real clock (public profile lifecycle fields)
// ---------------------------------------------------------------------------

describe('export under the real clock', () => {
  /** No SEAMLINE_DETERMINISTIC: run ids are `run-<ISO timestamp>-<random>`. */
  function realClockSession(cwd: string): CliDeps & { io: ReturnType<typeof bufferIo> } {
    const io = bufferIo({ cwd, isTty: false, env: {} });
    return { ...buildCliDeps(io), io };
  }

  async function extract(repo: string): Promise<void> {
    const d = realClockSession(repo);
    const code = await runCli(d, [
      'extract',
      '--repo',
      repo,
      ...NON_HISTORY.flatMap((n) => ['--only', n]),
    ]);
    assert.equal(code, EXIT_OK, d.io.stderr());
  }

  async function exportOf(repo: string, profile: string): Promise<string> {
    const d = realClockSession(repo);
    assert.equal(
      await runCli(d, ['export', '--repo', repo, '--profile', profile]),
      EXIT_OK,
      d.io.stderr(),
    );
    return d.io.stdout();
  }

  test('the public profile writes the same bytes after a re-extraction of an unchanged repository, and no run id', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'seamline-export-clock-'));
    cpSync(EXAMPLE, repo, { recursive: true });
    await extract(repo);
    const first = await exportOf(repo, 'public');
    const teamFirst = await exportOf(repo, 'team');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await extract(repo);
    const second = await exportOf(repo, 'public');

    assert.ok((JSON.parse(first) as Exported).nodes.length > 0, 'a real export, not an empty one');
    assert.equal(second, first, 'two extractions of one tree, one public export');
    assert.doesNotMatch(first, /"(firstSeenRun|lastSeenRun|deletedAt)"/);
    assert.doesNotMatch(first, /run-\d/);
    // The profiles that still name the run ids do release them, so the claim
    // above is about `public` and not about an export that lost them everywhere.
    assert.match(teamFirst, /"lastSeenRun": "run-\d{8}T/);
  });
});
