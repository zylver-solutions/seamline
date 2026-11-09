import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONFIG_FILENAME, parseConfig } from '../config.ts';
import { IGNORE_ENTRY, ignoresEntry } from '../gitignore.ts';
import { bufferIo, EXIT_OK } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { runCli } from '../run.ts';

async function repo(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'seamline-init-'));
}

function deps(
  cwd: string,
  env: Record<string, string | undefined> = {},
): CliDeps & { io: ReturnType<typeof bufferIo> } {
  const io = bufferIo({ cwd, env, isTty: false });
  return {
    io,
    clock: { now: () => '1970-01-01T00:00:00.000Z', runId: () => 'run-test' },
  };
}

function ignoreCount(content: string): number {
  return content.split(/\r?\n/).filter((l) => ignoresEntry(l, IGNORE_ENTRY)).length;
}

test('init writes seamline-out/ into the repository .gitignore', async () => {
  const dir = await repo();
  await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  const d = deps(dir);

  const code = await runCli(d, ['init']);
  assert.equal(code, EXIT_OK, d.io.stderr());

  const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
  assert.equal(ignoreCount(gitignore), 1, `.gitignore now ignores the graph:\n${gitignore}`);
  assert.ok(gitignore.includes('node_modules/'), 'existing entries preserved');
});

test('init creates .gitignore when the repository has none', async () => {
  const dir = await repo();
  const d = deps(dir);
  await runCli(d, ['init']);
  const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
  assert.equal(ignoreCount(gitignore), 1);
});

test('init is idempotent: two runs leave one ignore entry and one config', async () => {
  const dir = await repo();
  const d = deps(dir);
  await runCli(d, ['init']);
  const configAfterFirst = await readFile(path.join(dir, CONFIG_FILENAME), 'utf8');

  const second = deps(dir);
  const code = await runCli(second, ['init']);
  assert.equal(code, EXIT_OK);

  const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
  assert.equal(ignoreCount(gitignore), 1, 'still exactly one entry after the second init');
  const configAfterSecond = await readFile(path.join(dir, CONFIG_FILENAME), 'utf8');
  assert.equal(configAfterSecond, configAfterFirst, 'config is not rewritten without --force');
  assert.match(second.io.stdout(), /kept/);
});

test('init still fixes .gitignore when the config already exists', async () => {
  const dir = await repo();
  await writeFile(path.join(dir, CONFIG_FILENAME), '{"version":1}\n', 'utf8');
  await writeFile(path.join(dir, '.gitignore'), 'dist/\n', 'utf8');
  const d = deps(dir);

  await runCli(d, ['init']);

  const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
  assert.equal(ignoreCount(gitignore), 1, 'the ignore write is not gated on the config write');
});

test('init --force rewrites the config', async () => {
  const dir = await repo();
  await writeFile(path.join(dir, CONFIG_FILENAME), '{"version":1}\n', 'utf8');
  const d = deps(dir);
  await runCli(d, ['init', '--force']);
  const config = await readFile(path.join(dir, CONFIG_FILENAME), 'utf8');
  const parsed = JSON.parse(config) as { exportProfiles?: Record<string, unknown> };
  assert.ok(parsed.exportProfiles !== undefined, 'scaffolded config declares export profiles');
});

test('init scaffolds a config that parses and declares a default-deny profile', async () => {
  const dir = await repo();
  const d = deps(dir);
  await runCli(d, ['init']);
  const raw = await readFile(path.join(dir, CONFIG_FILENAME), 'utf8');
  const parsed = JSON.parse(raw) as {
    exportProfiles: Record<
      string,
      { version: number; allow: unknown[]; allowProvenance: string[]; includeUntrusted: boolean }
    >;
  };
  const names = Object.keys(parsed.exportProfiles);
  assert.equal(names.length, 1);
  const profile = parsed.exportProfiles[names[0] as string];
  assert.equal(profile?.version, 1, 'the scaffolded profile is a version 1 profile');
  assert.deepEqual(profile?.allowProvenance, ['EXTRACTED'], 'extracted facts only');
  assert.equal(profile?.includeUntrusted, false);
  assert.ok((profile?.allow.length ?? 0) > 0, 'and it is an explicit allow-list, not a wildcard');
  // What init writes must be what the one parser reads back.
  assert.deepEqual(Object.keys(parseConfig(JSON.parse(raw), dir).exportProfiles), names);
});

test('init --json emits valid, colour-free JSON naming the gitignore action', async () => {
  const dir = await repo();
  const d = deps(dir);
  const code = await runCli(d, ['init', '--json']);
  assert.equal(code, EXIT_OK);
  const out = d.io.stdout();
  assert.doesNotMatch(out, /\u001b\[/, 'no ANSI escapes in --json output');
  const parsed = JSON.parse(out) as { gitignore: { entry: string; action: string } };
  assert.equal(parsed.gitignore.entry, IGNORE_ENTRY);
  assert.equal(parsed.gitignore.action, 'created');
});

test('init creates the output directory it just told git to ignore', async () => {
  const dir = await repo();
  await runCli(deps(dir), ['init']);
  const s = await stat(path.join(dir, 'seamline-out'));
  assert.ok(s.isDirectory());
});

test('init names the starter profile for what it releases, and says on screen that it is internal-level', async () => {
  const dir = await repo();
  const d = deps(dir);
  await runCli(d, ['init']);
  const raw = await readFile(path.join(dir, CONFIG_FILENAME), 'utf8');
  const parsed = JSON.parse(raw) as { exportProfiles: Record<string, { description: string }> };
  assert.deepEqual(Object.keys(parsed.exportProfiles), ['structure']);
  assert.match(parsed.exportProfiles['structure']?.description ?? '', /^Internal-level structure/);
  assert.match(parsed.exportProfiles['structure']?.description ?? '', /not a public artifact/);
  assert.match(
    d.io.stdout(),
    /starter export profile `structure` releases internal-level structure: file paths, the module tree and the import graph/,
  );
  assert.match(d.io.stdout(), /not something to publish/);
});

test('init does not talk about the starter profile when it kept an existing config', async () => {
  const dir = await repo();
  await runCli(deps(dir), ['init']);
  const again = deps(dir);
  await runCli(again, ['init']);
  assert.doesNotMatch(again.io.stdout(), /starter export profile/);
});
