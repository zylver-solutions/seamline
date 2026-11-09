import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { COMMANDS, parseCommandArgs, STORE_OPTION_SPEC, type Command } from './args.ts';
import { CliError, EXIT_USAGE } from './io.ts';
import { resolveStoreDir } from './store-dir.ts';

const SRV_REPO = path.resolve('/srv/repo');
const CONFIG = { outDir: 'seamline-out' };

function resolve(command: Command, ...flags: string[]): string {
  return resolveStoreDir(
    command,
    SRV_REPO,
    CONFIG,
    parseCommandArgs([command, ...flags], STORE_OPTION_SPEC),
  );
}

const DEFAULT = path.join(SRV_REPO, 'seamline-out');
const READERS = COMMANDS.filter((c) => c !== 'init');

test('with no flag the store is the config outDir, resolved against the repository root', () => {
  for (const command of READERS) assert.equal(resolve(command), DEFAULT, command);
  assert.equal(
    resolveStoreDir(
      'check',
      SRV_REPO,
      { outDir: 'build/graph' },
      parseCommandArgs(['check'], STORE_OPTION_SPEC),
    ),
    path.join(SRV_REPO, 'build', 'graph'),
  );
});

test('--store selects the store on every command', () => {
  for (const command of READERS)
    assert.equal(resolve(command, '--store', 'a'), path.join(SRV_REPO, 'a'), command);
  assert.equal(
    resolve('check', '--store', '/elsewhere/s'),
    path.resolve('/elsewhere/s'),
    'an absolute path stands',
  );
});

test('--out is the store everywhere except export, where it is only the destination file', () => {
  for (const command of READERS.filter((c) => c !== 'export')) {
    assert.equal(resolve(command, '--out', 'b'), path.join(SRV_REPO, 'b'), command);
  }
  assert.equal(
    resolve('export', '--out', 'slice.json'),
    DEFAULT,
    'export --out never selects the store',
  );
});

test('export takes the store from --store whatever --out names', () => {
  assert.equal(resolve('export', '--store', 'a', '--out', 'slice.json'), path.join(SRV_REPO, 'a'));
  assert.equal(
    resolve('export', '--store', 'a', '--out', 'a'),
    path.join(SRV_REPO, 'a'),
    'even when --out spells the same path',
  );
});

test('where --out is also a store, --store and --out must agree', () => {
  for (const command of READERS.filter((c) => c !== 'export')) {
    assert.equal(resolve(command, '--store', 'a', '--out', 'a'), path.join(SRV_REPO, 'a'), command);
    assert.equal(
      resolve(command, '--store', './a', '--out', 'a/'),
      path.join(SRV_REPO, 'a'),
      `${command}: same directory`,
    );

    assert.throws(
      () => resolve(command, '--store', 'a', '--out', 'b'),
      (e: unknown) => {
        assert.ok(e instanceof CliError);
        assert.equal(e.code, EXIT_USAGE, 'a usage error, so a script can tell it from a finding');
        assert.ok(
          e.message.includes(path.join(SRV_REPO, 'a')) &&
            e.message.includes(path.join(SRV_REPO, 'b')),
          e.message,
        );
        return true;
      },
      command,
    );
  }
});

test('an empty --store is refused rather than read as the repository root', () => {
  assert.throws(
    () => resolve('check', '--store='),
    (e: unknown) =>
      e instanceof CliError && e.code === EXIT_USAGE && /--store needs a directory/.test(e.message),
  );
});
