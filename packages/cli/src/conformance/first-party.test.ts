/**
 * The five bundled extractors through the conformance suite.
 *
 * They are the suite's hardest positive control: real extractors with real manifests, the only ones
 * that need grants a manifest cannot ask for (`git`, the run's graph), run under the same host
 * `seamline extract` uses. Each must PASS every property its input lets the fixtures exercise. If
 * one did not, either the extractor or the suite would be wrong, and the report would say which
 * property and why.
 *
 * Two of them read no files of the repository that the suite can pad or plant bait in:
 * `extract-change` reads history (`.git/**`, which the suite does not fill) and `infer-join` reads
 * the run's graph. For them the stress fixture has nothing to pad and the bait fixture nothing to
 * place, so `memory-ceiling` and `no-network` are UNAVAILABLE, and the test says so rather than
 * allowing it.
 *
 * The seed is a small repository of the kind each one reads: a tsconfig and a TypeScript model, a SQL
 * migration, and an OpenAPI document. `infer-join` reads the graph the other three produce, so the
 * graph handed to it is built from their output on that same seed.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ExtractorStatus, GraphView, NodeId, SeamlineEdge } from '@seamline/ontology';
import { REQUIRED_SCOPES } from '@seamline/infer-join';
import {
  FIRST_PARTY_LIMITS,
  FIRST_PARTY_PROGRAMS,
  firstPartyHost,
} from '../sandbox/first-party.ts';
import type { ExtractContext } from '../ports.ts';
import { viewFromSnapshot } from '../sandbox/snapshot.ts';
import { runConformance } from './suite.ts';
import { PROPERTY_IDS, type PropertyId, type Verdict } from './types.ts';

const root = mkdtempSync(join(tmpdir(), 'seamline-first-party-seed-'));
const seed = join(root, 'seed');

function write(rel: string, text: string): void {
  const abs = join(seed, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

before(() => {
  write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext' },
      // `conformance-stress` and `conformance-lures/bait` are where the suite puts the padded files
      // and the bait: a program that finds its input from a configuration reads them only if the
      // configuration says so, and a property the fixtures did not reach is UNAVAILABLE.
      include: ['src', 'conformance-stress', 'conformance-lures/bait'],
    }),
  );
  write(
    'src/model.ts',
    'export interface User { id: number; email: string | null }\nexport const table = "users";\n',
  );
  write('db/0001_init.sql', 'CREATE TABLE users (id integer PRIMARY KEY, email text);\n');
  write(
    'api/openapi.yaml',
    [
      'openapi: 3.0.3',
      'info: { title: Seed API, version: 1.0.0 }',
      'paths: {}',
      'components:',
      '  schemas:',
      '    User:',
      '      type: object',
      '      required: [id]',
      '      properties:',
      '        id: { type: integer }',
      '        email: { type: string }',
      '',
    ].join('\n'),
  );
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const env = { PATH: process.env['PATH'] ?? '' };
const host = firstPartyHost(env);

/** The graph the three source extractors produce over the seed, as `infer-join` is handed it. */
async function graphOverSeed(): Promise<GraphView> {
  const ctx: ExtractContext = {
    repoRoot: seed,
    repo: 'seed',
    runId: 'run-1',
    outDir: join(root, 'out'),
    include: ['**/*'],
    exclude: ['node_modules/**'],
    options: {},
    deterministic: true,
  };
  const nodes = new Map<NodeId, ReturnType<GraphView['nodesByKind']>[number]>();
  const edges: SeamlineEdge[] = [];
  for (const name of ['extract-code-ts', 'extract-data', 'extract-contracts']) {
    const program = FIRST_PARTY_PROGRAMS.find((p) => p.manifest.name === name);
    assert.ok(program, name);
    const out = await host.run(program, ctx);
    assert.equal(out.result.status, 'PASS', `${name}: ${out.result.diagnostics.join(' | ')}`);
    for (const n of out.nodes) nodes.set(n.id, n);
    for (const group of out.edges) edges.push(...group.edges);
  }
  const from = new Map<NodeId, SeamlineEdge[]>();
  const to = new Map<NodeId, SeamlineEdge[]>();
  for (const e of edges) {
    from.set(e.src, [...(from.get(e.src) ?? []), e]);
    to.set(e.dst, [...(to.get(e.dst) ?? []), e]);
  }
  return viewFromSnapshot({
    nodes: [...nodes.values()],
    from: [...from],
    to: [...to],
    scopes: REQUIRED_SCOPES.map((s) => [s, 'PASS' as ExtractorStatus] as const),
  });
}

/** Properties the fixtures cannot exercise for a program whose input is not files the suite can pad. */
const NOT_EXERCISED: Readonly<Record<string, ReadonlyArray<PropertyId>>> = {
  'extract-change': ['no-network', 'memory-ceiling'],
  'infer-join': ['no-network', 'memory-ceiling'],
};

describe('the bundled extractors through the conformance suite', { concurrency: false }, () => {
  for (const program of FIRST_PARTY_PROGRAMS) {
    const name = program.manifest.name;
    it(name, { timeout: 280_000 }, async () => {
      const graph = program.graphScopes === undefined ? undefined : await graphOverSeed();
      const report = await runConformance(program, {
        host,
        limits: FIRST_PARTY_LIMITS,
        env,
        seed,
        ...(graph === undefined ? {} : { graph }),
      });
      const summary = report.properties.map((p) => `${p.id}=${p.verdict}`).join(' ');
      const unexercised = NOT_EXERCISED[name] ?? [];
      for (const p of report.properties) {
        const expected: Verdict =
          p.id === 'unavailable-not-pass' && p.verdict === 'NOT_APPLICABLE'
            ? 'NOT_APPLICABLE'
            : unexercised.includes(p.id)
              ? 'UNAVAILABLE'
              : 'PASS';
        assert.equal(
          p.verdict,
          expected,
          `${name}: ${summary}\n${p.id}: ${p.evidence.join(' | ')}`,
        );
        if (expected === 'UNAVAILABLE') {
          assert.match(p.evidence.join('\n'), /no (bait|stress) file could be generated/, p.id);
        }
      }
      assert.equal(report.verdict, unexercised.length > 0 ? 'UNAVAILABLE' : 'PASS', summary);
      assert.deepEqual(
        report.properties.map((p) => p.id),
        [...PROPERTY_IDS],
      );
    });
  }
});
