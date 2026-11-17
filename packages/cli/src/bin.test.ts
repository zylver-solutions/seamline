/**
 * `--version` and `--help` against the built binary: they open no store, so
 * they load no `node:sqlite` and print nothing on stderr. Everything else goes
 * through the command runner the binary loads on demand.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMAND_HELP, COMMANDS, HELP_TEXT } from './args.ts';
import { VERSION } from './version.ts';

const binary = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

function seamline(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: mkdtempSync(join(tmpdir(), 'seamline-preflight-')),
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('the built CLI prints the version with an empty stderr', () => {
  for (const args of [['--version'], ['-v'], ['check', '--version']]) {
    assert.deepEqual(
      seamline(args),
      { status: 0, stdout: `${VERSION}\n`, stderr: '' },
      args.join(' '),
    );
  }
});

test('the built CLI prints the global help with an empty stderr', () => {
  for (const args of [['--help'], ['-h']]) {
    assert.deepEqual(seamline(args), { status: 0, stdout: HELP_TEXT, stderr: '' }, args.join(' '));
  }
});

test('the built CLI prints the help of every command with an empty stderr', () => {
  for (const command of COMMANDS) {
    assert.deepEqual(
      seamline([command, '--help']),
      { status: 0, stdout: COMMAND_HELP[command], stderr: '' },
      `${command} --help`,
    );
  }
});

test('the built CLI loads the command runner for anything that is not help or version', () => {
  // A command that runs: the usage error comes from the runner, not from the preflight.
  const check = seamline(['check']);
  assert.equal(check.status, 2);
  assert.equal(check.stdout, '');
  assert.match(check.stderr, /no seamline\.config\.json found/);

  // No command and an unknown command are usage errors with the help on stderr.
  for (const args of [[], ['nonsense']]) {
    const result = seamline(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '', args.join(' '));
    assert.ok(result.stderr.includes('USAGE'), args.join(' '));
  }
});
