import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from './config.ts';
import { bufferIo, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from './io.ts';
import type { CliDeps } from './ports.ts';
import { findCommand } from './args.ts';
import { runCli, VERSION } from './run.ts';

function deps(env: Record<string, string | undefined> = {}, isTty = false): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd: process.cwd(), env, isTty });
  return { io, clock: { now: () => 'now', runId: () => 'run' } };
}

test('a bare invocation prints help to stderr and exits with a usage code', async () => {
  const d = deps();
  const code = await runCli(d, []);
  assert.equal(code, EXIT_USAGE);
  assert.equal(d.io.stdout(), '', 'help is not piped into a consumer expecting data');
  assert.match(d.io.stderr(), /USAGE/);
});

test('--help prints help to stdout and exits 0', async () => {
  const d = deps();
  const code = await runCli(d, ['--help']);
  assert.equal(code, EXIT_OK);
  assert.match(d.io.stdout(), /seamline <command>/);
  assert.equal(d.io.stderr(), '');
});

test('per-command help is available and mentions the command contract', async () => {
  const d = deps();
  await runCli(d, ['export', '--help']);
  assert.match(d.io.stdout(), /default-deny/);

  const e = deps();
  await runCli(e, ['init', '--help']);
  assert.match(e.io.stdout(), /gitignore/);
});

test('--version prints the version and exits 0', async () => {
  const d = deps();
  const code = await runCli(d, ['--version']);
  assert.equal(code, EXIT_OK);
  assert.equal(d.io.stdout().trim(), VERSION);
});

test('an unknown command is a usage error naming the valid commands', async () => {
  const d = deps();
  const code = await runCli(d, ['explode']);
  assert.equal(code, EXIT_USAGE);
  assert.match(d.io.stderr(), /unknown command `explode`/);
  assert.match(d.io.stderr(), /COMMANDS/);
});

test('an unknown option is a usage error, not an exit-1 that looks like a finding', async () => {
  const d = deps();
  const code = await runCli(d, ['check', '--nope']);
  assert.equal(code, EXIT_USAGE, 'exit 2, so CI can tell it apart from "contradictions found"');
  assert.match(d.io.stderr(), /--nope/);
});

test('an unexpected error exits 3 and offers the debug switch', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-run-'));
  await writeFile(path.join(dir, CONFIG_FILENAME), serializeConfig(defaultConfig('demo')), 'utf8');
  const io = bufferIo({ cwd: dir, env: {}, isTty: false });
  const exploding: CliDeps = {
    io,
    clock: { now: () => 'now', runId: () => 'run' },
    store: {
      open: () => {
        throw new Error('the store exploded');
      },
    },
  };
  const code = await runCli(exploding, ['extract']);
  assert.equal(code, EXIT_RUNTIME, 'a runtime failure is 3, not 1 and not 2');
  assert.match(io.stderr(), /the store exploded/);
  assert.match(io.stderr(), /SEAMLINE_DEBUG=1/);
});

test('errors in --json mode are valid JSON on stderr', async () => {
  const d = deps();
  const code = await runCli(d, ['export', '--json']);
  assert.equal(code, EXIT_USAGE);
  const parsed = JSON.parse(d.io.stderr()) as { error: string; exitCode: number };
  assert.equal(parsed.exitCode, EXIT_USAGE);
  assert.match(parsed.error, /profile|config/i);
});

test('a global option before the command does not shadow the command', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'seamline-run-'));
  const d = deps();
  const code = await runCli(d, ['--repo', dir, 'init']);
  assert.equal(code, EXIT_OK, d.io.stderr());
  assert.match(d.io.stdout(), /seamline\.config\.json/);
});

test('findCommand skips option values across every value-taking option', () => {
  assert.equal(findCommand(['--repo', '/srv/app', 'init']), 'init');
  assert.equal(findCommand(['--out', 'check', 'extract']), 'extract', 'an option value that spells a command');
  assert.equal(findCommand(['--store', 'check', 'extract']), 'extract', '--store takes a value too');
  assert.equal(findCommand(['--store', '/srv/store', 'export']), 'export');
  assert.equal(findCommand(['--json', 'check']), 'check');
  assert.equal(findCommand(['--repo=/srv/app', 'why']), 'why', '--opt=value consumes no next token');
  assert.equal(findCommand(['--', 'init']), 'init');
  assert.equal(findCommand([]), undefined);
  assert.equal(findCommand(['bogus']), undefined);
});
