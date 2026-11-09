/**
 * `seamline conformance`: argument handling, rendering and exit codes. What the suite decides is
 * tested in `conformance/suite.test.ts`; this asserts what the command does with the decision.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMAND_HELP } from '../args.ts';
import { bufferIo, EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, systemClock } from '../io.ts';
import { runCli } from '../run.ts';
import type { ConformanceReport } from '../conformance/types.ts';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../__fixtures__/conformance/${name}`, import.meta.url));

const env = { PATH: process.env['PATH'] ?? '' };

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const io = bufferIo({ env, cwd: process.cwd() });
  const code = await runCli({ io, clock: systemClock(env) }, args);
  return { code, stdout: io.stdout(), stderr: io.stderr() };
}

describe('seamline conformance', () => {
  it('prints one line per property and exits 0 for a conforming extractor', async () => {
    const r = await cli(['conformance', fixture('good.mjs'), '--no-color']);
    assert.equal(r.code, EXIT_OK, r.stdout + r.stderr);
    for (const id of [
      'manifest',
      'exercised',
      'reads-confined',
      'no-network',
      'provenance-ceiling',
      'memory-ceiling',
      'time-budget',
      'unavailable-not-pass',
    ]) {
      assert.match(r.stdout, new RegExp(`^PASS +${id} `, 'm'), id);
    }
    assert.match(r.stdout, /conformance: PASS \(8 PASS, 0 FAIL, 0 UNAVAILABLE, 0 NOT_APPLICABLE\)/);
    assert.equal(r.stderr, '');
  });

  it('--json prints the report as data, and a misbehaving extractor exits 1 with its evidence in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seamline-conf-cmd-'));
    try {
      const options = join(dir, 'options.json');
      writeFileSync(options, JSON.stringify({ mode: 'net' }));
      const r = await cli([
        'conformance',
        fixture('bad-network.mjs'),
        '--options',
        options,
        '--json',
      ]);
      assert.equal(r.code, EXIT_FINDINGS, r.stderr);
      const report = JSON.parse(r.stdout) as ConformanceReport;
      assert.equal(report.verdict, 'FAIL');
      const network = report.properties.find((p) => p.id === 'no-network');
      assert.equal(network?.verdict, 'FAIL');
      assert.match(network?.evidence.join('\n') ?? '', /\[network\] conformance-bad-network/);
      assert.ok(report.runs.some((run) => run.violations.includes('network')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 3, not 0, when the suite could not tell: UNAVAILABLE is not PASS', async () => {
    const r = await cli(['conformance', fixture('empty.mjs'), '--no-color']);
    assert.equal(r.code, EXIT_RUNTIME, r.stdout);
    assert.match(r.stdout, /conformance: UNAVAILABLE/);
    assert.match(r.stdout, /UNAVAILABLE is not PASS/);
    assert.doesNotMatch(r.stdout, /conformance: PASS/);
  });

  it('a module that is not there is a FAIL of manifest, exit 1', async () => {
    const r = await cli([
      'conformance',
      join(tmpdir(), 'seamline-no-such-extractor.mjs'),
      '--no-color',
    ]);
    assert.equal(r.code, EXIT_FINDINGS);
    assert.match(r.stdout, /^FAIL +manifest /m);
  });

  it('is a usage error without a module, with two, with a bad --options or --stress-mb', async () => {
    for (const args of [
      ['conformance'],
      ['conformance', 'a.mjs', 'b.mjs'],
      ['conformance', fixture('good.mjs'), '--options', join(tmpdir(), 'seamline-no-such.json')],
      ['conformance', fixture('good.mjs'), '--stress-mb', 'lots'],
    ]) {
      const r = await cli(args);
      assert.equal(r.code, EXIT_USAGE, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stdout, '');
    }
  });

  it('documents itself, and takes no store option', async () => {
    const r = await cli(['conformance', '--help']);
    assert.equal(r.code, EXIT_OK);
    assert.equal(r.stdout, COMMAND_HELP.conformance);
    assert.doesNotMatch(r.stdout, /--store/);
    assert.match(r.stdout, /UNAVAILABLE, never PASS/);
  });
});
