import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { buildProduct, cliIdentity, distDigest, ownCliPath } from './build.ts';
import { ConfigError } from './errors.ts';
import {
  makeTempDir,
  MINI_CLI,
  miniDetectorSource,
  removeDir,
  writeFakeCli,
  writeMiniMonorepo,
} from './testing.ts';

const DETECTOR_SOURCE = ['packages', 'contradictions', 'src', 'index.ts'];
const DETECTOR_DIST = ['packages', 'contradictions', 'dist', 'index.js'];

test('buildProduct compiles the sources as they are now, so a stale dist is replaced', async () => {
  const root = await makeTempDir();
  try {
    await writeMiniMonorepo(root, 'first');
    await buildProduct(root);
    assert.match(await readFile(path.join(root, ...DETECTOR_DIST), 'utf8'), /'first'/);

    // Edited, not rebuilt: the compiled file is the old one until the build runs.
    await writeFile(path.join(root, ...DETECTOR_SOURCE), miniDetectorSource('second'), 'utf8');
    assert.match(await readFile(path.join(root, ...DETECTOR_DIST), 'utf8'), /'first'/);
    await buildProduct(root);
    assert.match(await readFile(path.join(root, ...DETECTOR_DIST), 'utf8'), /'second'/);

    // Nothing changed: the build leaves the output as it is.
    const digest = await distDigest(root);
    await buildProduct(root);
    assert.equal(await distDigest(root), digest);
  } finally {
    await removeDir(root);
  }
});

test('buildProduct refuses a source that does not build, and shows the compiler output', async () => {
  const root = await makeTempDir();
  try {
    await writeMiniMonorepo(root, 'first');
    await writeFile(
      path.join(root, ...DETECTOR_SOURCE),
      "export const MESSAGE: number = 'not a number';\n",
      'utf8',
    );
    await assert.rejects(buildProduct(root), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /the build failed/);
      assert.match(e.message, /error TS2322/);
      return true;
    });
  } finally {
    await removeDir(root);
  }
});

test('buildProduct says what to do when TypeScript is not installed', async () => {
  const root = await makeTempDir();
  try {
    await assert.rejects(buildProduct(root), /Run `pnpm install` first/);
  } finally {
    await removeDir(root);
  }
});

async function compiled(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await makeTempDir();
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true });
    await writeFile(path.join(root, ...rel.split('/')), text, 'utf8');
  }
  return root;
}

test('distDigest follows the compiled JavaScript of the product and nothing else', async () => {
  const root = await compiled({
    'packages/cli/dist/index.js': 'export const a = 1;\n',
    'packages/cli/dist/index.d.ts': 'export declare const a = 1;\n',
    'packages/core/dist/store/store.js': 'export const s = 1;\n',
  });
  const write = (rel: string, text: string): Promise<void> =>
    mkdir(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true }).then(() =>
      writeFile(path.join(root, ...rel.split('/')), text, 'utf8'),
    );
  try {
    const base = await distDigest(root);
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(await distDigest(root), base, 'stable');

    await write('packages/cli/dist/index.d.ts', 'export declare const a = 2;\n');
    await write('packages/cli/dist/index.js.map', '{}\n');
    await write('packages/cli/dist/invocations.log', 'extract\n');
    await write('packages/cli/dist/index.test.js', 'x\n');
    await write('packages/cli/dist/__fixtures__/f.js', 'x\n');
    await write('packages/eval/dist/index.js', 'export const scorer = 1;\n');
    await write('packages/mcp/src/index.ts', 'export const m = 1;\n');
    assert.equal(
      await distDigest(root),
      base,
      'declarations, maps, logs, tests, fixtures, the harness and sources are not the build',
    );

    await write('packages/core/dist/store/store.js', 'export const s = 2;\n');
    const edited = await distDigest(root);
    assert.notEqual(edited, base, 'an edit to a compiled file');
    await write('packages/mcp/dist/index.js', 'export const m = 1;\n');
    assert.notEqual(await distDigest(root), edited, 'a compiled file of another package');
  } finally {
    await removeDir(root);
  }
});

test('distDigest tells the same file in another package from a moved one', async () => {
  const a = await compiled({ 'packages/cli/dist/x.js': 'one\n' });
  const b = await compiled({ 'packages/core/dist/x.js': 'one\n' });
  try {
    assert.notEqual(await distDigest(a), await distDigest(b));
  } finally {
    await removeDir(a);
    await removeDir(b);
  }
});

test('distDigest refuses a symbolic link in a build', async () => {
  const root = await compiled({ 'packages/cli/dist/real.js': 'one\n' });
  try {
    await symlink(
      path.join(root, 'packages', 'cli', 'dist', 'real.js'),
      path.join(root, 'packages', 'cli', 'dist', 'index.js'),
    );
    await assert.rejects(distDigest(root), /is a symbolic link/);
  } finally {
    await removeDir(root);
  }
});

test("cliIdentity names this repository's own build by its compiled output, and any other CLI by its file", async () => {
  const root = await compiled({ 'packages/core/dist/store.js': 'export const s = 1;\n' });
  try {
    await writeFakeCli(root, MINI_CLI);
    const own = await cliIdentity(root, ownCliPath(root));
    assert.deepEqual(own, {
      path: 'packages/cli/dist/index.js',
      ownBuild: true,
      distDigest: await distDigest(root),
    });
    assert.deepEqual(
      await cliIdentity(root, path.join(root, 'packages', 'cli', 'dist', '..', 'dist', 'index.js')),
      own,
      'the same file by another spelling',
    );

    const other = await writeFakeCli(root, 'elsewhere/cli.mjs');
    const identity = await cliIdentity(root, other);
    assert.equal(identity.ownBuild, false);
    assert.equal(identity.path, other);
    assert.notEqual(identity.distDigest, own.distDigest);

    await assert.rejects(cliIdentity(root, path.join(root, 'absent.js')), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /does not exist/);
      return true;
    });
  } finally {
    await removeDir(root);
  }
});

test("the compiled CLI of a build changes the identity of the repository's own build", async () => {
  const root = await compiled({});
  try {
    await writeFakeCli(root, MINI_CLI);
    const before = await cliIdentity(root, ownCliPath(root));
    await writeFile(ownCliPath(root), '// another build\n', 'utf8');
    const after = await cliIdentity(root, ownCliPath(root));
    assert.notEqual(after.distDigest, before.distDigest);
    assert.equal(after.ownBuild, true);
  } finally {
    await removeDir(root);
  }
});

test('buildProduct recompiles whatever the file times say, so a tree restored with its old times is not measured as the build that came before', async () => {
  const root = await makeTempDir();
  try {
    await writeMiniMonorepo(root, 'first');
    await buildProduct(root);
    const frozenDigest = await distDigest(root);

    // An edit that is built: the output now holds the edit.
    await writeFile(path.join(root, ...DETECTOR_SOURCE), miniDetectorSource('tuned'), 'utf8');
    await buildProduct(root);
    assert.match(await readFile(path.join(root, ...DETECTOR_DIST), 'utf8'), /'tuned'/);

    // The source goes back to what it was, and its modification time goes back to before the
    // build, as `tar`, `rsync -a` and `cp -p` leave it. Judged by times, the output is current.
    await writeFile(path.join(root, ...DETECTOR_SOURCE), miniDetectorSource('first'), 'utf8');
    const past = new Date('2020-01-01T00:00:00Z');
    await utimes(path.join(root, ...DETECTOR_SOURCE), past, past);
    await buildProduct(root);

    const output = await readFile(path.join(root, ...DETECTOR_DIST), 'utf8');
    assert.match(output, /'first'/, 'the output is compiled from the source as it stands');
    assert.doesNotMatch(output, /tuned/, 'nothing of the earlier edit is left in the output');
    assert.equal(await distDigest(root), frozenDigest, 'the digest is the frozen build');
  } finally {
    await removeDir(root);
  }
});

test('a --cli that is a directory is a configuration error, not a failure of the harness', async () => {
  const root = await compiled({ 'packages/core/dist/store.js': 'export const s = 1;\n' });
  try {
    await assert.rejects(cliIdentity(root, path.join(root, 'packages', 'core')), (e: unknown) => {
      assert.ok(e instanceof ConfigError, 'a ConfigError ends in exit code 2');
      assert.match(e.message, /is not a file/);
      return true;
    });
  } finally {
    await removeDir(root);
  }
});
