import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { makeTempDir, removeDir } from './testing.ts';
import { copyTree, EVAL_EXTRACTORS, evalConfig, prepareWorkTree } from './workdir.ts';

test('the scratch copy omits git metadata and every symbolic link, and keeps everything else', async () => {
  const root = await makeTempDir();
  try {
    const src = path.join(root, 'src');
    await mkdir(path.join(src, '.git'), { recursive: true });
    await mkdir(path.join(src, 'app', 'nested'), { recursive: true });
    await writeFile(path.join(src, '.git', 'HEAD'), 'ref: x\n', 'utf8');
    await writeFile(path.join(src, 'app', 'nested', 'a.ts'), 'export {};\n', 'utf8');
    await writeFile(path.join(src, 'app', '.git'), 'gitdir: elsewhere\n', 'utf8');
    await symlink('/etc/hostname', path.join(src, 'link'));

    const dest = path.join(root, 'dest');
    await copyTree(src, dest);

    assert.equal(await readFile(path.join(dest, 'app', 'nested', 'a.ts'), 'utf8'), 'export {};\n');
    await assert.rejects(lstat(path.join(dest, '.git')), /ENOENT/);
    await assert.rejects(lstat(path.join(dest, 'app', '.git')), /ENOENT/);
    await assert.rejects(
      lstat(path.join(dest, 'link')),
      /ENOENT/,
      'a link out of the tree is dropped',
    );
  } finally {
    await removeDir(root);
  }
});

test('no symbolic link survives the copy: not to a file outside the tree, not to one inside, not to a directory', async () => {
  const root = await makeTempDir();
  try {
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(
      path.join(outside, 'secret.ts'),
      'export const SECRET_OUTSIDE_TREE = 1;\n',
      'utf8',
    );
    const src = path.join(root, 'src');
    await mkdir(path.join(src, 'real'), { recursive: true });
    await writeFile(path.join(src, 'real', 'a.ts'), 'export const a = 1;\n', 'utf8');
    await symlink(path.join(outside, 'secret.ts'), path.join(src, 'leak.ts'));
    await symlink(outside, path.join(src, 'leak-dir'));
    await symlink('real/a.ts', path.join(src, 'inside.ts'));
    await symlink('real', path.join(src, 'inside-dir'));
    await symlink('missing.ts', path.join(src, 'dangling.ts'));

    const dest = path.join(root, 'dest');
    await copyTree(src, dest);

    assert.deepEqual((await readdir(dest)).sort(), ['real']);
    assert.equal(await readFile(path.join(dest, 'real', 'a.ts'), 'utf8'), 'export const a = 1;\n');
  } finally {
    await removeDir(root);
  }
});

test('the harness configuration names the repo and runs every extractor except extract-change', () => {
  const config = evalConfig('umami') as {
    repo: string;
    extractors: { name: string; enabled: boolean }[];
  };
  assert.equal(config.repo, 'umami');
  assert.deepEqual(
    config.extractors.map((e) => e.name),
    ['extract-code-ts', 'extract-data', 'extract-contracts', 'infer-join'],
  );
  assert.deepEqual(
    EVAL_EXTRACTORS,
    config.extractors.map((e) => e.name),
  );
  assert.ok(config.extractors.every((e) => e.enabled));
  assert.ok(!config.extractors.some((e) => e.name === 'extract-change'));
});

test('prepareWorkTree writes the configuration into the copy and leaves the source untouched', async () => {
  const root = await makeTempDir();
  try {
    const src = path.join(root, 'src');
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, 'a.ts'), 'export {};\n', 'utf8');
    const dest = path.join(root, 'work');
    await prepareWorkTree(src, dest, 'tiny');
    const written = JSON.parse(await readFile(path.join(dest, 'seamline.config.json'), 'utf8')) as {
      repo: string;
    };
    assert.equal(written.repo, 'tiny');
    await assert.rejects(lstat(path.join(src, 'seamline.config.json')), /ENOENT/);
  } finally {
    await removeDir(root);
  }
});
