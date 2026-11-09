/**
 * The conformance suite against extractors it has to be hard on: modules whose own files, package
 * layout or behaviour try to make a verdict come out better than the evidence allows.
 *
 * Every extractor here is written into a temporary directory by the test, so what is under test is
 * the layout as well as the code: a `package.json` that names a directory, a module in the tools
 * directory of a larger project, a glob that names one file. None of them is a tracked file.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { moduleCodeRoots } from './load.ts';
import { conformanceOfModule } from './suite.ts';
import type { ConformanceReport, FixtureKind, PropertyId, Verdict } from './types.ts';

const world = realpathSync(mkdtempSync(join(tmpdir(), 'seamline-third-party-')));
after(() => {
  rmSync(world, { recursive: true, force: true });
});

const env = { PATH: process.env['PATH'] ?? '' };

/** Source shared by the extractors below: what `__fixtures__/conformance/lib.mjs` offers, inline. */
const PREAMBLE = `
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

function walk(root, dir = '') {
  const found = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? entry.name : dir + '/' + entry.name;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) found.push(...walk(root, rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found.sort();
}

function fileNode(ctx, path, props = {}) {
  return {
    id: ctx.repo + ':File:' + path, kind: 'File', name: path, path, sensitivity: 'internal',
    provenance: 'EXTRACTED', confidence: 1, props, firstSeenRun: ctx.runId, lastSeenRun: ctx.runId,
    deletedAt: null,
  };
}

function output(status, nodes, diagnostics = []) {
  return {
    result: {
      extractor: MANIFEST.name, version: MANIFEST.version, status,
      authoritative: status === 'PASS' ? MANIFEST.produces.map((p) => ({ ...p })) : [],
      nodeCount: nodes.length, edgeCount: 0, durationMs: 0, diagnostics,
    },
    nodes,
    edges: [{ scope: MANIFEST.name, edges: [] }],
  };
}
`;

interface Source {
  readonly name: string;
  /** Overrides for the manifest. */
  readonly manifest?: Record<string, unknown>;
  /** The text of `run(ctx)`'s body. It returns `output(...)`; `walk`, `fileNode` and `here` are in scope. */
  readonly body: string;
  /** Lines to put before `run`, e.g. an import. */
  readonly head?: string;
}

function sourceOf(source: Source): string {
  const manifest = {
    name: source.name,
    version: '0.0.1',
    reads: ['**/*.txt'],
    net: false,
    env: [],
    memMb: 128,
    timeoutS: 30,
    provenanceCeiling: 'EXTRACTED',
    produces: [{ scope: source.name, kinds: ['File'] }],
    ...source.manifest,
  };
  return `${source.head ?? ''}\nexport const MANIFEST = ${JSON.stringify(manifest)};\n${PREAMBLE}\nexport async function run(ctx) {\n${source.body}\n}\n`;
}

/** The nodes for the declared files, the way a plain extractor makes them. */
const PLAIN = `
  const nodes = [];
  for (const path of walk(ctx.repoRoot).filter((p) => p.endsWith('.txt'))) {
    nodes.push(fileNode(ctx, path, { bytes: readFileSync(join(ctx.repoRoot, path)).length }));
  }
`;

let counter = 0;
function dir(...parts: string[]): string {
  counter += 1;
  const path = join(world, `case-${counter}`, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function verdicts(report: ConformanceReport): Record<PropertyId, Verdict> {
  return Object.fromEntries(report.properties.map((p) => [p.id, p.verdict])) as Record<
    PropertyId,
    Verdict
  >;
}

function evidence(report: ConformanceReport, id: PropertyId): string {
  const found = report.properties.find((p) => p.id === id);
  assert.ok(found, id);
  return found.evidence.join('\n');
}

function run(
  module: string,
  extra: { fixtures?: FixtureKind[]; options?: Record<string, unknown> } = {},
): Promise<ConformanceReport> {
  return conformanceOfModule(module, process.cwd(), { env, ...extra });
}

describe("a third-party package's own files do not choose what the sandbox opens", () => {
  const stealing = (name: string, target: string): Source => ({
    name,
    body: `${PLAIN}
  const props = {};
  for (const rel of ${JSON.stringify(target)}.split(',')) {
    try { props[rel] = readFileSync(join(here, rel), 'utf8'); } catch (e) { props[rel] = e.code ?? 'error'; }
  }
  nodes.push(fileNode(ctx, 'stolen.txt', props));
  return output('PASS', nodes, [JSON.stringify(props)]);`,
  });

  it('a dependency named with a path does not open the directory it points at', async () => {
    // world/case-N/ext is the extractor, world/case-N/secretproj is a neighbour with a package.json.
    const base = dir();
    const ext = join(base, 'ext');
    const secretproj = join(base, 'secretproj');
    put(join(secretproj, 'package.json'), '{"name":"secretproj"}');
    put(join(secretproj, 'secret.txt'), 'TOPSECRET-TRAV-CONTENT');
    put(join(secretproj, '.env'), 'API_KEY=TOPSECRET-DOTENV');
    put(
      join(ext, 'package.json'),
      JSON.stringify({
        name: 'ext',
        type: 'module',
        dependencies: { '../../secretproj': '1.0.0' },
      }),
    );
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf(stealing('trav-dep', '../secretproj/secret.txt,../secretproj/.env')),
    );

    const report = await run(module, { fixtures: ['clean', 'links', 'bait'] });
    assert.equal(verdicts(report)['reads-confined'], 'FAIL', JSON.stringify(report.properties));
    assert.match(evidence(report, 'reads-confined'), /\[path-escape\]/);
    assert.ok(!JSON.stringify(report).includes('TOPSECRET'), JSON.stringify(report.runs));
    assert.equal(report.verdict, 'FAIL');

    const roots = moduleCodeRoots(module);
    assert.ok(
      !roots.some((r) => r === secretproj || r.startsWith(`${secretproj}/`)),
      `granted: ${roots.join(', ')}`,
    );
  });

  it('a module in tools/ does not open the whole project around it', async () => {
    // world/case-N/proj has the package.json and a .env; the extractor is proj/tools/ext.mjs.
    const proj = dir('proj');
    put(join(proj, 'package.json'), '{"name":"proj","type":"module"}');
    put(join(proj, '.env'), 'DB_PASSWORD=TOPSECRET-DB');
    const module = put(join(proj, 'tools', 'ext.mjs'), sourceOf(stealing('tools-env', '../.env')));

    const report = await run(module, { fixtures: ['clean', 'links', 'bait'] });
    assert.equal(verdicts(report)['reads-confined'], 'FAIL', JSON.stringify(report.properties));
    assert.match(evidence(report, 'reads-confined'), /\[path-escape\]/);
    assert.ok(!JSON.stringify(report).includes('TOPSECRET'), JSON.stringify(report.runs));

    const roots = moduleCodeRoots(module);
    assert.ok(!roots.includes(proj), `granted: ${roots.join(', ')}`);
  });

  it('a dependency that is installed under node_modules, scoped or not, is still loaded', async () => {
    const ext = dir('ext');
    put(
      join(ext, 'package.json'),
      JSON.stringify({
        name: 'ext',
        type: 'module',
        dependencies: { 'dep-a': '1', '@org/dep-b': '1' },
      }),
    );
    for (const [name, value] of [
      ['dep-a', 'a'],
      ['@org/dep-b', 'b'],
    ] as const) {
      put(
        join(ext, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, type: 'module', main: 'index.js' }),
      );
      put(
        join(ext, 'node_modules', name, 'index.js'),
        `export const value = ${JSON.stringify(value)};\n`,
      );
    }
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({
        name: 'uses-deps',
        head: "import { value as a } from 'dep-a';\nimport { value as b } from '@org/dep-b';",
        body: `${PLAIN}\n  nodes.push(fileNode(ctx, 'deps.txt', { a, b }));\n  return output('PASS', nodes);`,
      }),
    );
    const report = await run(module, { fixtures: ['clean'] });
    assert.equal(verdicts(report)['manifest'], 'PASS', evidence(report, 'manifest'));
    assert.equal(verdicts(report)['exercised'], 'PASS', evidence(report, 'exercised'));
  });

  it('a dependency that is a link out of node_modules is not opened for the module', async () => {
    const base = dir();
    const ext = join(base, 'ext');
    put(
      join(base, 'elsewhere', 'package.json'),
      '{"name":"elsewhere","type":"module","main":"index.js"}',
    );
    put(join(base, 'elsewhere', 'index.js'), 'export const value = 1;\n');
    mkdirSync(join(ext, 'node_modules'), { recursive: true });
    symlinkSync(join(base, 'elsewhere'), join(ext, 'node_modules', 'elsewhere'));
    put(
      join(ext, 'package.json'),
      JSON.stringify({ name: 'ext', type: 'module', dependencies: { elsewhere: '1' } }),
    );
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({
        name: 'linked-dep',
        head: "import { value } from 'elsewhere';",
        body: `${PLAIN}\n  nodes.push(fileNode(ctx, 'v.txt', { value }));\n  return output('PASS', nodes);`,
      }),
    );
    const report = await run(module, { fixtures: ['clean'] });
    assert.equal(verdicts(report)['manifest'], 'FAIL');
    assert.match(evidence(report, 'manifest'), /importing the module failed/);
    assert.equal(report.verdict, 'FAIL');
  });

  it('code outside the module directory is not readable, and the failure says what was refused', async () => {
    const proj = dir('proj');
    put(join(proj, 'package.json'), '{"name":"proj","type":"module"}');
    put(join(proj, 'shared', 'helper.mjs'), 'export const helper = 1;\n');
    const module = put(
      join(proj, 'tools', 'ext.mjs'),
      sourceOf({
        name: 'imports-sibling',
        head: "import { helper } from '../shared/helper.mjs';",
        body: `${PLAIN}\n  nodes.push(fileNode(ctx, 'h.txt', { helper }));\n  return output('PASS', nodes);`,
      }),
    );
    const report = await run(module, { fixtures: ['clean'] });
    assert.equal(verdicts(report)['manifest'], 'FAIL');
    assert.match(evidence(report, 'manifest'), /importing the module failed/);
    assert.match(evidence(report, 'manifest'), /shared/);
  });
});

describe('a property the fixtures could not exercise is UNAVAILABLE, never PASS', () => {
  it('a glob that names one file leaves nothing to pad and no bait to place', async () => {
    const ext = dir();
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({
        name: 'one-file',
        manifest: { reads: ['Makefile'], memMb: 64 },
        body: `
  const nodes = [];
  for (const path of walk(ctx.repoRoot).filter((p) => p === 'Makefile')) {
    nodes.push(fileNode(ctx, path, { bytes: readFileSync(join(ctx.repoRoot, path)).length }));
  }
  return output('PASS', nodes);`,
      }),
    );
    const report = await run(module);
    const v = verdicts(report);
    assert.equal(v['memory-ceiling'], 'UNAVAILABLE', evidence(report, 'memory-ceiling'));
    assert.match(evidence(report, 'memory-ceiling'), /no stress file could be generated/);
    assert.equal(v['no-network'], 'UNAVAILABLE', evidence(report, 'no-network'));
    assert.match(evidence(report, 'no-network'), /no bait file could be generated/);
    assert.equal(report.verdict, 'UNAVAILABLE');
  });

  it('an extractor that declares no reads has nothing to pad either', async () => {
    const ext = dir();
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({
        name: 'no-reads',
        manifest: { reads: [] },
        body: "  return output('PASS', [fileNode(ctx, 'made-up.txt')]);",
      }),
    );
    const report = await run(module);
    assert.equal(verdicts(report)['memory-ceiling'], 'UNAVAILABLE');
    assert.equal(verdicts(report)['no-network'], 'UNAVAILABLE');
    assert.equal(report.verdict, 'UNAVAILABLE');
  });

  it('padded files that it never opens do not show its memory', async () => {
    const ext = dir();
    // Reads the samples and the seed, but skips the directories the stress and bait files are in.
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({
        name: 'skips-stress',
        body: `
  const nodes = [];
  const wanted = (p) => p.endsWith('.txt') && !p.startsWith('conformance-stress/') && !p.startsWith('conformance-lures/bait/');
  for (const path of walk(ctx.repoRoot).filter(wanted)) {
    nodes.push(fileNode(ctx, path, { bytes: readFileSync(join(ctx.repoRoot, path)).length }));
  }
  return output('PASS', nodes);`,
      }),
    );
    const report = await run(module);
    assert.equal(
      verdicts(report)['memory-ceiling'],
      'UNAVAILABLE',
      evidence(report, 'memory-ceiling'),
    );
    assert.match(evidence(report, 'memory-ceiling'), /opened none of the \d+ padded file/);
    assert.equal(verdicts(report)['no-network'], 'UNAVAILABLE', evidence(report, 'no-network'));
    assert.match(evidence(report, 'no-network'), /opened none of the \d+ bait file/);
  });

  it('an extractor that does read the padded and bait files still passes both', async () => {
    const ext = dir();
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({ name: 'reads-all', body: `${PLAIN}\n  return output('PASS', nodes);` }),
    );
    const report = await run(module);
    assert.equal(verdicts(report)['memory-ceiling'], 'PASS', evidence(report, 'memory-ceiling'));
    assert.equal(verdicts(report)['no-network'], 'PASS', evidence(report, 'no-network'));
    assert.match(evidence(report, 'memory-ceiling'), /opened \d+ of the \d+ padded file/);
    assert.match(evidence(report, 'no-network'), /opened \d+ of the \d+ bait file/);
    assert.equal(report.verdict, 'PASS', JSON.stringify(report.properties));
  });
});

describe('the evidence says what the extractor did, not what it was shown', () => {
  it('names the undeclared in-repo paths it looked at, which the host allows and no glob admits', async () => {
    const ext = dir();
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({
        name: 'nosy',
        body: `${PLAIN}
  const props = {};
  for (const rel of ['conformance-lures/undeclared.conformance-canary', 'conformance-lures']) {
    try { const info = statSync(join(ctx.repoRoot, rel)); props[rel] = JSON.stringify([info.size, info.isDirectory()]); } catch (e) { props[rel] = e.code; }
  }
  props.listing = JSON.stringify(readdirSync(join(ctx.repoRoot, 'conformance-lures')));
  nodes.push(fileNode(ctx, 'nosy.txt', props));
  return output('PASS', nodes);`,
      }),
    );
    const report = await run(module);
    // Looking is allowed, so this is not a FAIL; it is on the page so that a reader can see it.
    assert.equal(verdicts(report)['reads-confined'], 'PASS', evidence(report, 'reads-confined'));
    assert.match(
      evidence(report, 'reads-confined'),
      /looked at \d+ in-repo path\(s\) that no declared glob admits[^\n]*conformance-lures\/undeclared\.conformance-canary/,
    );
    assert.match(evidence(report, 'reads-confined'), /listed \d+ director/);
  });

  it('does not report looks when there were none', async () => {
    const ext = dir();
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({
        name: 'incurious',
        body: `
  const nodes = [];
  for (const rel of ['conformance-samples/sample.txt']) {
    try { nodes.push(fileNode(ctx, rel, { bytes: readFileSync(join(ctx.repoRoot, rel)).length })); } catch {}
  }
  nodes.push(fileNode(ctx, 'x.txt'));
  return output('PASS', nodes);`,
      }),
    );
    const report = await run(module, { fixtures: ['clean', 'links', 'bait'] });
    assert.doesNotMatch(evidence(report, 'reads-confined'), /looked at \d+ in-repo/);
  });

  it('a crash on unreadable input does not claim that no open failed', async () => {
    const ext = dir();
    // Reads without catching: the first EACCES ends the run, and the wrapper's tally goes with it.
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({ name: 'crashes', body: `${PLAIN}\n  return output('PASS', nodes);` }),
    );
    const report = await run(module, { fixtures: ['clean', 'unreadable'] });
    assert.equal(verdicts(report)['unavailable-not-pass'], 'PASS');
    const text = evidence(report, 'unavailable-not-pass');
    assert.doesNotMatch(text, /\b0 open\(s\)/, text);
    assert.match(text, /EACCES/, text);
    assert.match(text, /stopped with an error/, text);
  });
});

describe('a hung extractor costs one budget, not five', () => {
  it('stops running fixtures after the first timeout', async () => {
    const ext = dir();
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({
        name: 'hangs',
        manifest: { timeoutS: 2 },
        body: '  await new Promise(() => setInterval(() => {}, 1000));',
      }),
    );
    const started = Date.now();
    const report = await run(module);
    const took = Date.now() - started;
    assert.equal(verdicts(report)['time-budget'], 'FAIL');
    assert.equal(report.verdict, 'FAIL');
    assert.deepEqual(
      report.runs.map((r) => r.fixture),
      ['clean'],
      'later fixtures were run after the extractor was killed',
    );
    assert.match(evidence(report, 'time-budget'), /not run after it was killed/);
    // One two-second budget plus start-up; five would be over ten seconds.
    assert.ok(took < 9_000, `took ${took} ms`);
  });
});

describe('reading the manifest is bounded too', () => {
  it('a module that holds most of a gigabyte at import time is stopped, not waited for', async () => {
    const ext = dir();
    const manifest = {
      name: 'import-hog',
      version: '0.0.1',
      reads: ['**/*.txt'],
      net: false,
      env: [],
      memMb: 128,
      timeoutS: 30,
      provenanceCeiling: 'EXTRACTED',
      produces: [{ scope: 'import-hog', kinds: ['File'] }],
    };
    const module = put(
      join(ext, 'ext.mjs'),
      [
        `export const MANIFEST = ${JSON.stringify(manifest)};`,
        'const hog = Buffer.alloc(900 * 1024 * 1024, 1);',
        'await new Promise((resolve) => setTimeout(resolve, 8000));',
        'export async function run() { return hog.length; }',
        '',
      ].join('\n'),
    );
    const started = Date.now();
    const report = await run(module, { fixtures: ['clean'] });
    assert.equal(verdicts(report)['manifest'], 'FAIL', evidence(report, 'manifest'));
    assert.match(evidence(report, 'manifest'), /held more than \d+ MiB/);
    assert.ok(Date.now() - started < 7_000, `took ${Date.now() - started} ms`);
  });
});

describe('the host stops a run that looks first and reads after', () => {
  // The guard keeps a bounded log of what it refused. An extractor that fills it with harmless
  // looks must not be able to push a real read out of the record, because the suite reads "the
  // host stopped it on looks alone" as a PASS of `reads-confined`. The sandbox change (the sandbox change) never
  // drops a content denial and treats a truncated log as not probe-only; this is the suite-side
  // check that it holds end to end.
  it('a read outside the repo after 400 distinct looks at a link out of it is a FAIL, not a probe-only stop', async () => {
    const ext = dir();
    const module = put(
      join(ext, 'ext.mjs'),
      sourceOf({
        name: 'saturates',
        body: `${PLAIN}
  
  if (readdirSync(join(ctx.repoRoot, 'conformance-lures')).includes('up')) {
    for (let i = 0; i < 400; i += 1) {
      try { statSync(join(ctx.repoRoot, 'conformance-lures', 'up', 'a' + i)); } catch {}
    }
    try { readFileSync(join(ctx.repoRoot, '..', 'outside', 'secret-0.txt')); } catch {}
  }
  return output('PASS', nodes);`,
      }),
    );
    const report = await run(module, { fixtures: ['clean', 'links', 'bait'] });
    assert.equal(verdicts(report)['reads-confined'], 'FAIL', evidence(report, 'reads-confined'));
    assert.equal(report.verdict, 'FAIL');
  });
});
