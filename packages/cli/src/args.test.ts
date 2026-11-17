import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FORMAT_DOC_URL } from '@seamline/core';
import { COMMAND_HELP, COMMANDS, HELP_TEXT, PROFILE_FORMAT_DOC_URL, type Command } from './args.ts';
import { PROPERTY_IDS, PROPERTY_TITLES, VERDICTS } from './conformance/types.ts';
import { bufferIo, EXIT_USAGE } from './io.ts';
import { runCli } from './run.ts';

/** Joins the wrapped lines of a help text so a sentence can be matched whole. */
const unwrapped = (text: string): string => text.replace(/\s+/g, ' ');

test('the conformance help lists every property of the suite, in order, with its title', () => {
  const help = COMMAND_HELP.conformance;
  const listed = [...help.matchAll(/^ {2}([a-z][a-z-]+) {2,}\S/gm)].map((m) => m[1]);
  assert.deepEqual(listed, [...PROPERTY_IDS]);
  for (const id of PROPERTY_IDS) {
    assert.ok(unwrapped(help).includes(`${id} ${PROPERTY_TITLES[id]}`), `${id} carries its title`);
  }
  assert.ok(help.includes(`The ${PROPERTY_IDS.length} properties`));
});

test('the conformance help names every verdict a property line can carry', () => {
  const line = /The verdict on a line is one of:\n\n {2}(.+)\n/.exec(COMMAND_HELP.conformance);
  assert.deepEqual(line?.[1]?.split(', '), [...VERDICTS]);
  assert.deepEqual([...VERDICTS].sort(), ['FAIL', 'NOT_APPLICABLE', 'PASS', 'UNAVAILABLE']);
});

test('the profile format URL in the help is the one @seamline/core publishes', () => {
  assert.equal(PROFILE_FORMAT_DOC_URL, FORMAT_DOC_URL);
  assert.ok(COMMAND_HELP.export.includes(FORMAT_DOC_URL));
});

/** The commands the global help says reject `option`, read from its GLOBAL OPTIONS entry. */
function rejectingPerHelp(option: string): ReadonlySet<string> {
  const section = /^GLOBAL OPTIONS\n([\s\S]*?)\n\n/m.exec(HELP_TEXT)?.[1];
  assert.ok(section !== undefined, 'the global help has a GLOBAL OPTIONS section');
  const entry = section.split(/\n(?= {2}-)/).find((block) => block.startsWith(`  --${option} `));
  assert.ok(entry !== undefined, `the global help documents --${option}`);
  const names = /Not accepted by: ([^.]+)\./.exec(unwrapped(entry))?.[1];
  return new Set(names === undefined ? [] : names.split(', '));
}

const GLOBAL_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  json: ['--json'],
  repo: ['--repo', '.'],
  out: ['--out', 'somewhere'],
  'no-color': ['--no-color'],
};

async function rejects(command: Command, option: string): Promise<boolean> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'seamline-globals-'));
  const io = bufferIo({ cwd, env: {} });
  const code = await runCli({ io, clock: { now: () => 'now', runId: () => 'run' } }, [
    command,
    ...(GLOBAL_ARGUMENTS[option] ?? []),
  ]);
  const refused = io.stderr().includes(`\`seamline ${command}\` does not take --${option}`);
  if (refused) {
    assert.equal(code, EXIT_USAGE, `${command} --${option}`);
    assert.equal(io.stdout(), '', `${command} --${option} did nothing`);
  }
  return refused;
}

test('a global option is a usage error on exactly the commands the help says do not accept it', async () => {
  const stated: Record<string, string[]> = {};
  const observed: Record<string, string[]> = {};
  for (const option of Object.keys(GLOBAL_ARGUMENTS)) {
    stated[option] = COMMANDS.filter((command) => rejectingPerHelp(option).has(command));
    assert.equal(
      stated[option].length,
      rejectingPerHelp(option).size,
      `--${option}: the help names only commands`,
    );
    observed[option] = [];
    for (const command of COMMANDS) {
      if (await rejects(command, option)) observed[option].push(command);
    }
  }
  assert.deepEqual(observed, stated);
  assert.deepEqual(observed, {
    json: ['mcp'],
    repo: ['conformance'],
    out: ['init', 'conformance'],
    'no-color': [],
  });
});

test('mcp --json says why it is refused and serves nothing', async () => {
  const io = bufferIo({ cwd: await mkdtemp(path.join(tmpdir(), 'seamline-mcp-json-')), env: {} });
  const code = await runCli({ io, clock: { now: () => 'now', runId: () => 'run' } }, [
    'mcp',
    '--profile',
    'team',
    '--json',
  ]);
  assert.equal(code, EXIT_USAGE);
  assert.equal(io.stdout(), '');
  const error = JSON.parse(io.stderr()) as { error: string; exitCode: number };
  assert.match(error.error, /`seamline mcp` does not take --json: it has no JSON mode/);
  assert.equal(error.exitCode, EXIT_USAGE);
});
