import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { test } from 'node:test';
import { DirtyCheckoutError, PinMismatchError, UnguardedCheckoutError } from './errors.ts';
import { ATTRIBUTES_GUARD, checkoutDir, fetchRepo, isCloned, verifyPinned } from './fetch.ts';
import { runGit } from './git.ts';
import { commitFiles, makeTempDir, removeDir } from './testing.ts';
import type { CorpusEntry } from './types.ts';

const execFileAsync = promisify(execFile);

async function fixture(): Promise<{
  readonly root: string;
  readonly source: string;
  readonly cache: string;
  readonly first: string;
  readonly second: string;
}> {
  const root = await makeTempDir();
  const source = path.join(root, 'source');
  const first = await commitFiles(source, { 'README.md': 'one\n' }, 'first', true);
  const second = await commitFiles(source, { 'README.md': 'two\n' }, 'second');
  return { root, source, cache: path.join(root, 'cache'), first, second };
}

function entry(source: string, sha: string): CorpusEntry {
  return {
    name: 'tiny',
    url: source,
    sha,
    license: 'MIT',
    partition: 'dev',
    stacks: ['prisma'],
    why: 'A fixture.',
  };
}

test('fetchRepo clones the repository and leaves HEAD at the pinned commit, not at the tip', async () => {
  const f = await fixture();
  try {
    const result = await fetchRepo(entry(f.source, f.first), { cacheDir: f.cache });
    assert.equal(result.action, 'cloned');
    assert.equal((await runGit(['rev-parse', 'HEAD'], result.dir)).trim(), f.first);
    assert.equal(await readFile(path.join(result.dir, 'README.md'), 'utf8'), 'one\n');
  } finally {
    await removeDir(f.root);
  }
});

test('a second fetch of a good checkout changes nothing', async () => {
  const f = await fixture();
  try {
    const e = entry(f.source, f.first);
    await fetchRepo(e, { cacheDir: f.cache });
    const again = await fetchRepo(e, { cacheDir: f.cache });
    assert.equal(again.action, 'reused');
  } finally {
    await removeDir(f.root);
  }
});

test('verifyPinned refuses a checkout whose HEAD is not the pinned commit', async () => {
  const f = await fixture();
  try {
    // The cache holds the second commit; the corpus pins the first.
    const e = entry(f.source, f.second);
    await fetchRepo(e, { cacheDir: f.cache });
    const pinnedToFirst = entry(f.source, f.first);
    await assert.rejects(
      verifyPinned(pinnedToFirst, checkoutDir(f.cache, 'tiny')),
      (err: unknown) => {
        assert.ok(err instanceof PinMismatchError);
        assert.equal(err.expected, f.first);
        assert.equal(err.actual, f.second);
        assert.match(err.message, /Refusing to evaluate a different commit/);
        return true;
      },
    );
  } finally {
    await removeDir(f.root);
  }
});

test('verifyPinned refuses a pinned tree with local modifications', async () => {
  const f = await fixture();
  try {
    const e = entry(f.source, f.first);
    const { dir } = await fetchRepo(e, { cacheDir: f.cache });
    await writeFile(path.join(dir, 'README.md'), 'tampered\n', 'utf8');
    await assert.rejects(verifyPinned(e, dir), DirtyCheckoutError);
    await writeFile(path.join(dir, 'README.md'), 'one\n', 'utf8');
    await writeFile(path.join(dir, 'stray.txt'), 'extra\n', 'utf8');
    await assert.rejects(
      verifyPinned(e, dir),
      DirtyCheckoutError,
      'an untracked file is also not the pin',
    );
  } finally {
    await removeDir(f.root);
  }
});

test('fetchRepo repairs a checkout that has drifted, then proves it is the pin', async () => {
  const f = await fixture();
  try {
    const wrong = entry(f.source, f.second);
    const right = entry(f.source, f.first);
    const { dir } = await fetchRepo(wrong, { cacheDir: f.cache });
    await writeFile(path.join(dir, 'stray.txt'), 'extra\n', 'utf8');
    const repaired = await fetchRepo(right, { cacheDir: f.cache });
    assert.equal(repaired.action, 'repinned');
    await verifyPinned(right, dir);
    assert.equal(await readFile(path.join(dir, 'README.md'), 'utf8'), 'one\n');
    await assert.rejects(readFile(path.join(dir, 'stray.txt'), 'utf8'), /ENOENT/);
  } finally {
    await removeDir(f.root);
  }
});

test('fetchRepo does not claim success for a commit the repository does not have', async () => {
  const f = await fixture();
  try {
    const missing = entry(f.source, 'deadbeef'.repeat(5));
    await assert.rejects(fetchRepo(missing, { cacheDir: f.cache }));
    // Whatever was cloned is never accepted as the pin.
    const dir = checkoutDir(f.cache, 'tiny');
    if (await isCloned(dir)) await assert.rejects(verifyPinned(missing, dir), PinMismatchError);
  } finally {
    await removeDir(f.root);
  }
});

test('a failed clone leaves no half-made checkout that a later run could trust', async () => {
  const root = await makeTempDir();
  try {
    const cache = path.join(root, 'cache');
    await assert.rejects(
      fetchRepo(entry(path.join(root, 'does-not-exist'), 'a'.repeat(40)), { cacheDir: cache }),
    );
    assert.equal(await isCloned(checkoutDir(cache, 'tiny')), false);
  } finally {
    await removeDir(root);
  }
});

/** Runs `fn` with extra environment variables, restoring the previous values afterwards. */
async function withEnv<T>(
  vars: Readonly<Record<string, string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('every git invocation carries the hardening flags, whatever the caller passes', async () => {
  const root = await makeTempDir();
  try {
    await runGit(['init', '-q'], root);
    assert.equal((await runGit(['config', 'core.hooksPath'], root)).trim(), '/dev/null');
    assert.equal((await runGit(['config', 'submodule.recurse'], root)).trim(), 'false');
    assert.equal((await runGit(['config', 'protocol.ext.allow'], root)).trim(), 'never');
  } finally {
    await removeDir(root);
  }
});

test('no hook runs during clone or checkout, even one installed by a template directory', async () => {
  const f = await fixture();
  try {
    const templates = path.join(f.root, 'templates');
    const marker = path.join(f.root, 'hook-ran');
    await mkdir(path.join(templates, 'hooks'), { recursive: true });
    const hook = `#!/bin/sh\necho ran > '${marker}'\n`;
    for (const name of ['post-checkout', 'post-merge', 'reference-transaction']) {
      await writeFile(path.join(templates, 'hooks', name), hook, { mode: 0o755 });
    }
    await withEnv({ GIT_TEMPLATE_DIR: templates }, () =>
      fetchRepo(entry(f.source, f.first), { cacheDir: f.cache }),
    );
    await assert.rejects(access(marker), /ENOENT/);
  } finally {
    await removeDir(f.root);
  }
});

test('the checkout holds the committed bytes: no ident expansion, no line-ending conversion, no filter driver', async () => {
  const root = await makeTempDir();
  try {
    const source = path.join(root, 'source');
    const marker = path.join(root, 'filter-ran');
    const files = {
      '.gitattributes': '*.txt ident\n*.crlf text eol=crlf\n*.dat filter=evil\n',
      'id.txt': '$Id$\n',
      'lf.crlf': 'a\nb\n',
      'payload.dat': 'plain\n',
    };
    const sha = await commitFiles(source, files, 'attributes', true);
    // A configured driver, as a machine with Git LFS installed has. It must never run.
    const driver = `sh -c 'echo ran > "${marker}"; cat'`;
    await withEnv(
      {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'filter.evil.smudge',
        GIT_CONFIG_VALUE_0: driver,
        GIT_CONFIG_KEY_1: 'filter.evil.required',
        GIT_CONFIG_VALUE_1: 'true',
      },
      async () => {
        const { dir } = await fetchRepo(entry(source, sha), { cacheDir: path.join(root, 'cache') });
        for (const [rel, content] of Object.entries(files)) {
          assert.equal(await readFile(path.join(dir, rel), 'utf8'), content, rel);
        }
        // The tree is still reported clean: the guard applies to status as well as checkout.
        await verifyPinned(entry(source, sha), dir);
      },
    );
    await assert.rejects(access(marker), /ENOENT/);
  } finally {
    await removeDir(root);
  }
});

test('the attribute guard is what keeps ident expansion out: without it the same tree differs', async () => {
  const root = await makeTempDir();
  try {
    const source = path.join(root, 'source');
    const sha = await commitFiles(
      source,
      { '.gitattributes': '*.txt ident\n', 'id.txt': '$Id$\n' },
      'x',
      true,
    );
    const bare = path.join(root, 'bare');
    await runGit(['clone', '-q', source, bare]);
    assert.notEqual(await readFile(path.join(bare, 'id.txt'), 'utf8'), '$Id$\n');
    const guarded = await fetchRepo(entry(source, sha), { cacheDir: path.join(root, 'cache') });
    assert.equal(await readFile(path.join(guarded.dir, 'id.txt'), 'utf8'), '$Id$\n');
  } finally {
    await removeDir(root);
  }
});

test('submodules are not fetched or checked out, and the tree still verifies', async () => {
  const root = await makeTempDir();
  try {
    const lib = path.join(root, 'lib');
    const libSha = await commitFiles(lib, { 'lib.txt': 'library\n' }, 'lib', true);
    const source = path.join(root, 'source');
    await commitFiles(source, { 'a.txt': 'a\n' }, 'base', true);
    await writeFile(
      path.join(source, '.gitmodules'),
      `[submodule "lib"]\n\tpath = lib\n\turl = ${lib}\n`,
      'utf8',
    );
    await runGit(['add', '.gitmodules'], source);
    await runGit(['update-index', '--add', '--cacheinfo', `160000,${libSha},lib`], source);
    await runGit(
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'submodule',
      ],
      source,
    );
    const sha = (await runGit(['rev-parse', 'HEAD'], source)).trim();
    const { dir } = await fetchRepo(entry(source, sha), { cacheDir: path.join(root, 'cache') });
    assert.deepEqual(await readdir(path.join(dir, 'lib')), []);
    await verifyPinned(entry(source, sha), dir);
  } finally {
    await removeDir(root);
  }
});

test('a cached checkout made without the attribute guard is refused, and fetch rebuilds it', async () => {
  const f = await fixture();
  try {
    const e = entry(f.source, f.first);
    const { dir } = await fetchRepo(e, { cacheDir: f.cache });
    const guard = path.join(dir, '.git', 'info', 'attributes');
    assert.equal(await readFile(guard, 'utf8'), ATTRIBUTES_GUARD);
    await rm(guard);
    await assert.rejects(verifyPinned(e, dir), UnguardedCheckoutError);
    const repaired = await fetchRepo(e, { cacheDir: f.cache });
    assert.equal(repaired.action, 'repinned');
    await verifyPinned(e, dir);
  } finally {
    await removeDir(f.root);
  }
});

test('an ext:: remote is refused and its command never runs, even when the machine configuration allows ext', async () => {
  const root = await makeTempDir();
  try {
    const marker = path.join(root, 'ext-ran');
    // `ext::` runs a command named in the URL (`%` followed by a space is a space inside one
    // argument). Git refuses it by default; a user configuration of `protocol.ext.allow=always`
    // turns that off. Only the harness's own `protocol.ext.allow=never` stands between a hostile
    // remote URL and a shell command on such a machine.
    const url = `ext::sh -c touch% ${marker} x`;
    const ambient = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'protocol.ext.allow',
      GIT_CONFIG_VALUE_0: 'always',
    };
    await withEnv(ambient, async () => {
      // Control: plain git, with that configuration and without the harness's flags, runs it.
      await assert.rejects(
        execFileAsync('git', ['clone', '--no-checkout', url, path.join(root, 'plain')]),
      );
      await access(marker);
      await rm(marker);
      await rm(path.join(root, 'plain'), { recursive: true, force: true });

      // The harness's runner refuses it.
      await assert.rejects(
        runGit(['clone', '--no-checkout', url, path.join(root, 'dest')]),
        /transport 'ext' not allowed/,
      );
      const e: CorpusEntry = {
        name: 'tiny',
        url,
        sha: 'a'.repeat(40),
        license: 'MIT',
        partition: 'dev',
        stacks: ['prisma'],
        why: 'A hostile remote.',
      };
      await assert.rejects(
        fetchRepo(e, { cacheDir: path.join(root, 'cache') }),
        /transport 'ext' not allowed/,
      );
    });
    await assert.rejects(access(marker), /ENOENT/, 'the ext:: helper command ran');
    assert.equal(await isCloned(checkoutDir(path.join(root, 'cache'), 'tiny')), false);
  } finally {
    await removeDir(root);
  }
});

test('a submodule is not checked out even when the machine configuration would recurse into it', async () => {
  const root = await makeTempDir();
  try {
    const lib = path.join(root, 'lib');
    const libSha = await commitFiles(lib, { 'lib.txt': 'library\n' }, 'lib', true);
    const source = path.join(root, 'source');
    await commitFiles(source, { 'a.txt': 'a\n' }, 'base', true);
    await writeFile(
      path.join(source, '.gitmodules'),
      `[submodule "lib"]\n\tpath = lib\n\turl = ${lib}\n`,
      'utf8',
    );
    await runGit(['add', '.gitmodules'], source);
    await runGit(['update-index', '--add', '--cacheinfo', `160000,${libSha},lib`], source);
    await runGit(
      [
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'submodule',
      ],
      source,
    );
    const sha = (await runGit(['rev-parse', 'HEAD'], source)).trim();
    // A user configuration that activates every submodule, recurses into them on checkout, and
    // allows the local transport the submodule URL needs. Git would then fetch and check out lib.
    await withEnv(
      {
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'submodule.recurse',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'submodule.active',
        GIT_CONFIG_VALUE_1: '.',
        GIT_CONFIG_KEY_2: 'protocol.file.allow',
        GIT_CONFIG_VALUE_2: 'always',
      },
      async () => {
        const { dir } = await fetchRepo(entry(source, sha), { cacheDir: path.join(root, 'cache') });
        assert.deepEqual(await readdir(path.join(dir, 'lib')), [], 'the submodule was checked out');
        await verifyPinned(entry(source, sha), dir);
      },
    );
  } finally {
    await removeDir(root);
  }
});
