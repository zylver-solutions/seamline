/**
 * A table X5 withheld must not look like a clean one (docs/design/real-world-inputs.md, 5.2).
 *
 * A detector that ran and found nothing may still have declined to evaluate part of its input
 * and said so in `notes`. `check` prints those notes beside the result, adds them to `--json`
 * as `detectorNotes`, and does not call the run CLEAN without pointing at them. They never
 * change the exit code.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defineDetector, SCOPE_CODE } from '@seamline/contradictions';
import type { FindingDraft } from '@seamline/contradictions';
import type { GraphView } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo, EXIT_OK } from '../io.ts';
import type { CliDeps, DetectionReport } from '../ports.ts';
import { runCli } from '../run.ts';
import { makeNode, memoryGraph, memoryStorePort } from '../testing.ts';
import { contradictionsDetectorPort } from '../wiring.ts';

async function repoWithConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-check-notes-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')), 'utf8');
  return dir;
}

const NOTE =
  'table accounts was not evaluated: a BEFORE INSERT trigger on it may supply the column';

function depsFor(
  cwd: string,
  report: DetectionReport,
): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, isTty: false, env: {} });
  return {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
    store: memoryStorePort(
      memoryGraph({ nodes: [makeNode({ kind: 'Column', canonicalName: 'a.b' })] }),
    ),
    detectors: { run: (_view: GraphView) => Promise.resolve(report) },
  };
}

test('check prints what a detector did not evaluate, and does not call that clean without saying so', async () => {
  const dir = await repoWithConfig();
  const d = depsFor(dir, {
    contradictions: [],
    unknown: [],
    notes: [{ code: 'X5_UNWRITTEN_COLUMN', notes: [NOTE] }],
  });
  assert.equal(await runCli(d, ['check']), EXIT_OK);
  const out = d.io.stdout();
  assert.match(out, /NOT EVALUATED/u);
  assert.ok(out.includes(`X5_UNWRITTEN_COLUMN  ${NOTE}`), out);
  assert.match(out, /no contradictions found, but see the notes below/u);
});

test('check with no notes prints the plain CLEAN line and no notes section', async () => {
  const dir = await repoWithConfig();
  const d = depsFor(dir, { contradictions: [], unknown: [], notes: [] });
  assert.equal(await runCli(d, ['check']), EXIT_OK);
  assert.match(d.io.stdout(), /CLEAN {2}every detector ran; no contradictions found\./u);
  assert.doesNotMatch(d.io.stdout(), /NOT EVALUATED/u);
});

test('check --json carries detectorNotes', async () => {
  const dir = await repoWithConfig();
  const d = depsFor(dir, {
    contradictions: [],
    unknown: [],
    notes: [{ code: 'X5_UNWRITTEN_COLUMN', notes: [NOTE] }],
  });
  await runCli(d, ['check', '--json']);
  const body = JSON.parse(d.io.stdout()) as { detectorNotes: unknown };
  assert.deepEqual(body.detectorNotes, [{ code: 'X5_UNWRITTEN_COLUMN', notes: [NOTE] }]);
});

test('the catalog port hands a ran detector its notes, and an UNKNOWN one none', async () => {
  const noting = (unknown: boolean) =>
    defineDetector({
      code: 'X5_UNWRITTEN_COLUMN',
      severity: 'medium',
      requiredScopes: [SCOPE_CODE],
      description: 'fixture',
      ...(unknown ? { unknownWhen: () => 'stood down' } : {}),
      find: (): ReadonlyArray<FindingDraft> => [],
      notes: () => [NOTE],
    });
  const view = memoryGraph({ nodes: [] }).store;
  const ran = await contradictionsDetectorPort([noting(false)]).run(view);
  assert.deepEqual(ran.notes, [{ code: 'X5_UNWRITTEN_COLUMN', notes: [NOTE] }]);
  const stood = await contradictionsDetectorPort([noting(true)]).run(view);
  assert.deepEqual(stood.notes, []);
});
