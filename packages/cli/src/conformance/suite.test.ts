/**
 * The conformance suite against controls.
 *
 * Every property has a positive control (`good.mjs`, which must PASS it) and at least one negative
 * control (a deliberately misbehaving extractor from `__fixtures__/conformance/`, which must FAIL
 * it). A suite that only ever sees well-behaved extractors proves nothing about its own checks, so
 * the assertions here are on outcomes: the verdict of each property, the code the host stopped the
 * run on, and the evidence line that names it. Where a control is a claim about what the sandbox
 * takes away, the same extractor is also run directly, outside the sandbox, to show it can do the
 * thing, so that the FAIL is the control's doing and not an accident of the fixture.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { conformanceOfModule, loadFailureReport } from './suite.ts';
import {
  PROPERTY_IDS,
  type ConformanceReport,
  type FixtureKind,
  type PropertyId,
  type Verdict,
} from './types.ts';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../__fixtures__/conformance/${name}`, import.meta.url));

const env = { PATH: process.env['PATH'] ?? '' };

function run(
  name: string,
  extra: { options?: Record<string, unknown>; fixtures?: FixtureKind[]; seed?: string } = {},
): Promise<ConformanceReport> {
  return conformanceOfModule(fixture(name), process.cwd(), { env, ...extra });
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

describe('positive control: a well-behaved extractor passes every property', () => {
  it('good.mjs', async () => {
    const report = await run('good.mjs');
    assert.deepEqual(
      verdicts(report),
      Object.fromEntries(PROPERTY_IDS.map((id) => [id, 'PASS'])),
      JSON.stringify(report.properties, null, 2),
    );
    assert.equal(report.verdict, 'PASS');
    assert.deepEqual(report.extractor, { name: 'conformance-good', version: '0.0.1' });
    // The evidence is about this run, not boilerplate: it names what the fixtures held and what was seen.
    assert.match(evidence(report, 'reads-confined'), /symlink lure\(s\) leading outside the repo/);
    assert.match(evidence(report, 'reads-confined'), /undeclared file conformance-lures\//);
    assert.match(evidence(report, 'no-network'), /received 0 connections/);
    assert.match(evidence(report, 'unavailable-not-pass'), /EACCES; it reported UNAVAILABLE/);
    assert.deepEqual(
      report.runs.map((r) => [r.fixture, r.status]),
      [
        ['clean', 'PASS'],
        ['links', 'PASS'],
        ['bait', 'PASS'],
        ['unreadable', 'UNAVAILABLE'],
        ['stress', 'PASS'],
      ],
    );
  });

  it("a seed directory is copied into the fixtures, so the extractor sees the author's own input", async () => {
    const seed = mkdtempSync(join(tmpdir(), 'seamline-seed-'));
    try {
      mkdirSync(join(seed, 'docs'));
      writeFileSync(join(seed, 'docs', 'from-seed.txt'), 'hello\n');
      const report = await run('good.mjs', { seed, fixtures: ['clean'] });
      assert.match(evidence(report, 'exercised'), /3 node\(s\)/, evidence(report, 'exercised'));
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
  });
});

describe('reads: an extractor that reads outside its declared globs fails reads-confined', () => {
  const cases: ReadonlyArray<{ mode: string; code: RegExp }> = [
    // Every regular file, declared or not, without following a symlink.
    {
      mode: 'undeclared',
      code: /\[path-not-declared\] conformance-bad-reads: conformance-lures\/undeclared/,
    },
    // A declared-looking name that is a link out of the repo, or to an undeclared file in it.
    { mode: 'symlink', code: /\[symlink-escape\]|\[path-not-declared\][^\n]*is a symlink to/ },
    // A path that walks up out of the repo with ..
    { mode: 'dotdot', code: /\[path-escape\] conformance-bad-reads: [^\n]*outside the repo root/ },
    { mode: 'all', code: /\[(symlink-escape|path-not-declared|path-escape)\]/ },
  ];
  for (const { mode, code } of cases) {
    it(`mode ${mode}`, async () => {
      const report = await run('bad-reads.mjs', {
        options: { mode },
        fixtures: ['clean', 'links', 'bait'],
      });
      assert.equal(verdicts(report)['reads-confined'], 'FAIL', JSON.stringify(report.properties));
      assert.match(evidence(report, 'reads-confined'), code);
      assert.equal(report.verdict, 'FAIL');
      // Nothing reached for the network, so that property is not FAIL, whatever else stopped.
      assert.notEqual(verdicts(report)['no-network'], 'FAIL');
      // (`dotdot` reaches out on the clean fixture too, so no run of it completes.)
      if (mode !== 'dotdot') {
        assert.equal(verdicts(report)['exercised'], 'PASS');
        assert.equal(verdicts(report)['provenance-ceiling'], 'PASS');
      }
    });
  }

  it('an extractor that only looks at a link out of the repo is stopped by the host, but it read nothing, so reads-confined is not FAIL', async () => {
    const report = await run('bad-reads.mjs', {
      options: { mode: 'probe' },
      fixtures: ['clean', 'links', 'bait'],
    });
    const links = report.runs.find((r) => r.fixture === 'links');
    assert.ok(links);
    // The host failed the run closed; the extractor's own result was discarded.
    assert.equal(links.status, 'FAIL');
    assert.ok(links.violations.includes('symlink-escape'), links.violations.join(','));
    assert.equal(verdicts(report)['reads-confined'], 'PASS', evidence(report, 'reads-confined'));
    assert.match(
      evidence(report, 'reads-confined'),
      /looked at a symlink that leads outside the repo/,
    );
    assert.match(
      evidence(report, 'reads-confined'),
      /cannot finish on a repository that holds such a link/,
    );
  });

  it('without the sandbox the same extractor does read the undeclared file (the control is live)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'seamline-direct-'));
    try {
      mkdirSync(join(root, 'repo', 'conformance-lures'), { recursive: true });
      writeFileSync(join(root, 'repo', 'conformance-lures', 'private.dat'), 'DIRECT-CANARY\n');
      writeFileSync(join(root, 'repo', 'a.txt'), 'a\n');
      const mod = (await import(fixture('bad-reads.mjs'))) as {
        run(ctx: unknown): Promise<{ result: { diagnostics: string[] } }>;
      };
      const out = await mod.run({
        repoRoot: join(root, 'repo'),
        repo: 'r',
        runId: 'x',
        options: { mode: 'undeclared' },
      });
      assert.deepEqual(out.result.diagnostics, [
        'read a.txt: 2 chars',
        'read conformance-lures/private.dat: 14 chars',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('network: an extractor that reaches for it fails no-network, whatever it does with the error', () => {
  const cases: ReadonlyArray<{ mode: string; code: string }> = [
    { mode: 'net', code: 'network' },
    { mode: 'http', code: 'network' },
    { mode: 'dns', code: 'network' },
    { mode: 'fetch', code: 'network' },
    { mode: 'spawn', code: 'exec' },
    { mode: 'bait', code: 'network' },
  ];
  for (const { mode, code } of cases) {
    it(`mode ${mode}`, async () => {
      const report = await run('bad-network.mjs', { options: { mode }, fixtures: ['bait'] });
      assert.equal(verdicts(report)['no-network'], 'FAIL', JSON.stringify(report.properties));
      assert.match(
        evidence(report, 'no-network'),
        new RegExp(`\\[${code}\\] conformance-bad-network`),
      );
      assert.equal(report.verdict, 'FAIL');
    });
  }

  it('without the sandbox the same extractor does connect (the control is live)', async () => {
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((settle) => server.listen(0, '127.0.0.1', settle));
    const address = server.address();
    assert.ok(typeof address === 'object' && address !== null);
    const root = mkdtempSync(join(tmpdir(), 'seamline-direct-'));
    try {
      mkdirSync(join(root, 'repo'), { recursive: true });
      writeFileSync(
        join(root, 'repo', 'bait.json'),
        JSON.stringify({ $ref: `http://127.0.0.1:${address.port}/x` }),
      );
      const mod = (await import(fixture('bad-network.mjs'))) as {
        run(ctx: unknown): Promise<unknown>;
      };
      await mod.run({
        repoRoot: join(root, 'repo'),
        repo: 'r',
        runId: 'x',
        options: { mode: 'net' },
      });
      assert.equal(connections, 1);
    } finally {
      await new Promise<void>((settle) => server.close(() => settle()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ceilings and budgets', () => {
  it('a node labelled above the declared provenance ceiling fails provenance-ceiling', async () => {
    const report = await run('bad-ceiling.mjs', {
      options: { mode: 'provenance' },
      fixtures: ['clean'],
    });
    assert.equal(verdicts(report)['provenance-ceiling'], 'FAIL');
    assert.match(
      evidence(report, 'provenance-ceiling'),
      /\[provenance-ceiling\] conformance-bad-ceiling: .*EXTRACTED.*ceiling INFERRED/,
    );
  });

  it('a claim on a scope the manifest does not produce fails provenance-ceiling', async () => {
    const report = await run('bad-ceiling.mjs', {
      options: { mode: 'scope' },
      fixtures: ['clean'],
    });
    assert.equal(verdicts(report)['provenance-ceiling'], 'FAIL');
    assert.match(
      evidence(report, 'provenance-ceiling'),
      /\[scope-undeclared\] .*someone-elses-scope/,
    );
  });

  it('holding more than the declared memory fails memory-ceiling', async () => {
    const report = await run('bad-memory.mjs', { fixtures: ['clean'] });
    assert.equal(verdicts(report)['memory-ceiling'], 'FAIL');
    assert.match(evidence(report, 'memory-ceiling'), /\[memory\] conformance-bad-memory: .*64 MiB/);
  });

  for (const mode of ['spin', 'wait']) {
    it(`not finishing inside the declared time fails time-budget (${mode})`, async () => {
      const started = Date.now();
      const report = await run('bad-time.mjs', { options: { mode }, fixtures: ['clean'] });
      assert.equal(verdicts(report)['time-budget'], 'FAIL');
      assert.match(evidence(report, 'time-budget'), /\[timeout\] conformance-bad-time: .*2s/);
      // It was stopped at its two seconds, not left to run.
      assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
    });
  }
});

describe('UNAVAILABLE is never PASS', () => {
  it('an extractor that swallows a read failure and reports PASS fails unavailable-not-pass', async () => {
    const report = await run('bad-masks.mjs', { fixtures: ['clean', 'unreadable'] });
    assert.equal(verdicts(report)['exercised'], 'PASS');
    assert.equal(verdicts(report)['unavailable-not-pass'], 'FAIL');
    assert.match(
      evidence(report, 'unavailable-not-pass'),
      /open\(s\) of repository files failed with EACCES, and it still reported PASS/,
    );
  });

  it('the well-behaved extractor, given the same unreadable input, reports UNAVAILABLE and passes', async () => {
    const report = await run('good.mjs', { fixtures: ['clean', 'unreadable'] });
    assert.equal(verdicts(report)['unavailable-not-pass'], 'PASS');
  });

  it('an extractor that emits nothing is UNAVAILABLE on what it was never made to exercise, not PASS', async () => {
    const report = await run('empty.mjs');
    const v = verdicts(report);
    assert.equal(v['exercised'], 'UNAVAILABLE');
    assert.equal(v['provenance-ceiling'], 'UNAVAILABLE');
    assert.equal(v['unavailable-not-pass'], 'UNAVAILABLE');
    assert.equal(report.verdict, 'UNAVAILABLE');
    assert.match(evidence(report, 'exercised'), /supply --seed/);
  });

  it('a run limited to some fixtures reports the properties of the others as UNAVAILABLE', async () => {
    const report = await run('good.mjs', { fixtures: ['clean'] });
    const v = verdicts(report);
    assert.equal(v['exercised'], 'PASS');
    assert.equal(v['reads-confined'], 'UNAVAILABLE');
    assert.equal(v['memory-ceiling'], 'UNAVAILABLE');
    assert.equal(report.verdict, 'UNAVAILABLE');
  });
});

describe('a module that cannot be loaded fails manifest and assesses nothing else', () => {
  const cases: ReadonlyArray<[string, string, RegExp]> = [
    ['a path that does not exist', 'does-not-exist.mjs', /no extractor module at/],
    ['a module with no manifest', 'no-manifest.mjs', /exports neither MANIFEST nor manifest/],
    ['a manifest that asks for the network', 'net-true.mjs', /net must be false/],
    [
      'a module that goes to the network when it is imported',
      'phones-home-on-import.mjs',
      /importing the module failed: \[network\]/,
    ],
  ];
  for (const [label, file, pattern] of cases) {
    it(label, async () => {
      const report = await run(file);
      assert.equal(report.verdict, 'FAIL');
      assert.equal(verdicts(report)['manifest'], 'FAIL');
      assert.match(evidence(report, 'manifest'), pattern);
      for (const id of PROPERTY_IDS.filter((p) => p !== 'manifest')) {
        assert.equal(verdicts(report)[id], 'UNAVAILABLE', id);
      }
    });
  }

  it('loadFailureReport never contains a PASS', () => {
    const report = loadFailureReport('x');
    assert.ok(report.properties.every((p) => p.verdict !== 'PASS'));
  });
});

describe('the report is independent of where the module lives', () => {
  it('a relative module path resolves against the given directory', async () => {
    const report = await conformanceOfModule('good.mjs', dirname(fixture('good.mjs')), {
      env,
      fixtures: ['clean'],
    });
    assert.equal(report.extractor?.name, 'conformance-good');
  });
});
