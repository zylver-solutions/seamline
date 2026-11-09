/**
 * Cross-package coverage for `module-wiring` (alignment design 4.4, fixtures
 * W16 to W19): the shapes the extraction does not record.
 *
 * `extract-code-ts` records a file-level `IMPORTS` edge only from an `import`
 * declaration and an `export ... from` declaration. It records none for a
 * dynamic `import()`, a `require()`, a `new URL('./x.ts', import.meta.url)` or
 * a path named in a `package.json` script. These tests run the REAL extractor
 * over a small tree and hand the graph it produced to the alignment engine, so
 * the module-wiring probe is judged against what the extraction actually
 * recorded and not against a hand-written graph. A rule that read a missing
 * edge as absence would call each of these modules unwired.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { evaluate, memTree, redactPacket, type AlignFacts, type ImportEdge } from '@seamline/align';
import { extractCodeTs } from '@seamline/extract-code-ts';

const REPO = 'wiring';

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
  include: ['packages/*/src'],
});

function tree(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'package.json': JSON.stringify({
      name: 'wiring',
      private: true,
      scripts: { job: 'node --experimental-strip-types packages/p/src/job.ts' },
      engines: { node: '>=22.13.0' },
    }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'packages/p/package.json': JSON.stringify({ name: '@w/p', type: 'module' }),
    'tsconfig.json': TSCONFIG,
    'packages/p/src/guard.ts': 'export function guard(): boolean {\n  return true;\n}\n',
    'packages/p/src/lazy.ts': "export const load = async () => import('./guard.ts');\n",
    'packages/p/src/req.ts': 'export function req(): boolean {\n  return true;\n}\n',
    'packages/p/src/reqer.ts':
      "declare const require: (s: string) => unknown;\nexport const r = (): unknown => require('./req.ts');\n",
    'packages/p/src/urlref.ts': 'export function urlref(): boolean {\n  return true;\n}\n',
    'packages/p/src/urler.ts': "export const u = new URL('./urlref.ts', import.meta.url);\n",
    'packages/p/src/job.ts': 'export const job = 1;\n',
    'packages/p/src/static.ts':
      "import { load } from './lazy.ts';\nimport { r } from './reqer.ts';\nimport { u } from './urler.ts';\nimport type { Stats } from 'node:fs';\n\nexport const all: [typeof load, typeof r, URL, ((s: Stats) => void) | undefined, import('node:fs').Stats | undefined] = [load, r, u, undefined, undefined];\n",
    'README.md': [
      '## Controls',
      '',
      '| # | Control | Where |',
      '| --- | --- | --- |',
      '| C1 | The guard is wired. | `packages/p/src/guard.ts` |',
      '| C2 | The require is wired. | `packages/p/src/req.ts` |',
      '| C3 | The URL reference is wired. | `packages/p/src/urlref.ts` |',
      '| C4 | The job is wired. | `packages/p/src/job.ts` |',
      '',
    ].join('\n'),
    ...extra,
  };
}

describe('module-wiring over the real extraction (W16 to W19)', () => {
  let root = '';
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'align-wiring-'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function run(
    files: Record<string, string>,
    label: string,
  ): { reasons: Record<string, string>; edges: ImportEdge[]; files: readonly string[] } {
    const dir = join(root, label);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text, 'utf8');
    }
    const extracted = extractCodeTs({
      repo: REPO,
      runId: 'run-1',
      repoRoot: dir,
      deterministic: true,
    });
    assert.equal(extracted.result.status, 'PASS', extracted.result.diagnostics.join('; '));
    const pathOf = new Map<string, string>();
    const symbolPaths = new Set<string>();
    for (const n of extracted.nodes) {
      if (n.kind === 'File' && n.path !== undefined) pathOf.set(n.id, n.path);
      if (n.kind === 'Symbol' && n.path !== undefined) symbolPaths.add(n.path);
    }
    const edges: ImportEdge[] = [];
    for (const e of extracted.edges) {
      const src = pathOf.get(e.src);
      const dst = pathOf.get(e.dst);
      if (e.kind === 'IMPORTS' && src !== undefined && dst !== undefined)
        edges.push({ src, dst, reExport: e.props['reExport'] === true });
    }
    const facts: AlignFacts = {
      source: 'sif',
      digest: 'sha256:fixture',
      runs: [{ runId: 'run-1', commit: null, ontologyVersion: null, results: [extracted.result] }],
      files: [...pathOf.values()].sort(),
      symbolPaths: [...symbolPaths].sort(),
      imports: edges,
    };
    const body = evaluate({
      repo: REPO,
      tree: memTree(files),
      commit: 'a'.repeat(40),
      worktree: false,
      facts,
      producer: { toolVersion: 'test', sifVersion: '1.0.0' },
    });
    const packet = redactPacket(body).packet;
    const reasons: Record<string, string> = {};
    for (const f of packet.findings)
      if (f.claimKind === 'CONTROL_ENFORCEMENT') reasons[f.subject] = `${f.class}:${f.reason}`;
    for (const c of ['C1', 'C2', 'C3', 'C4']) reasons[`control:${c}`] ??= 'HOLDS';
    return { reasons, edges, files: facts.files };
  }

  test('the extraction records the static edges only: none reaches a module that is loaded lazily, required, referenced by URL or named in a script', () => {
    const { edges, files } = run(tree(), 'base');
    assert.ok(
      files.includes('packages/p/src/guard.ts'),
      'the module is a File node of the run, so M is not empty',
    );
    assert.deepEqual(edges.map((e) => `${e.src} -> ${e.dst}`).sort(), [
      'packages/p/src/static.ts -> packages/p/src/lazy.ts',
      'packages/p/src/static.ts -> packages/p/src/reqer.ts',
      'packages/p/src/static.ts -> packages/p/src/urler.ts',
    ]);
  });

  test('W16 to W19: each module is Unknown(no-static-consumer), never unwired and never wired', () => {
    const { reasons } = run(tree(), 'unwired');
    assert.deepEqual(reasons, {
      'control:C1': 'Unknown:no-static-consumer',
      'control:C2': 'Unknown:no-static-consumer',
      'control:C3': 'Unknown:no-static-consumer',
      'control:C4': 'Unknown:no-static-consumer',
    });
  });

  test('the same row is HOLDS once a non-test file imports the module statically; the others are unchanged', () => {
    const { reasons } = run(
      tree({
        'packages/p/src/use.ts':
          "import { guard } from './guard.ts';\n\nexport const g = guard();\n",
      }),
      'wired',
    );
    assert.equal(reasons['control:C1'], 'HOLDS');
    assert.equal(reasons['control:C2'], 'Unknown:no-static-consumer');
    assert.equal(reasons['control:C3'], 'Unknown:no-static-consumer');
    assert.equal(reasons['control:C4'], 'Unknown:no-static-consumer');
  });
});
