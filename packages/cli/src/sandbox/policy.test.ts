import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BUILD_ROOT } from './host.ts';
import {
  SandboxSetupError,
  closureRoots,
  permissionArgs,
  resolveCodeRoots,
  resolveExecGrants,
  withoutNested,
} from './policy.ts';

describe('sandbox policy / code roots', () => {
  const roots = resolveCodeRoots(BUILD_ROOT, [
    '@seamline/core',
    '@seamline/ontology',
    '@seamline/extract-contracts',
  ]).roots;

  it("names the CLI's own build and manifest, which Node reads to load the child", () => {
    assert.ok(roots.includes(BUILD_ROOT));
    assert.ok(roots.includes(join(dirname(BUILD_ROOT), 'package.json')));
  });

  it('reaches the whole dependency closure, optional peers included', () => {
    // `typescript` is an optional peer of extract-contracts: it is loaded with createRequire, and
    // a closure that stopped at `dependencies` would leave Zod extraction silently unavailable.
    const real = (name: string) =>
      roots.some((r) => r.endsWith(`/${name}`) && existsSync(join(r, 'package.json')));
    for (const name of ['core', 'ontology', 'extract-contracts', 'yaml', 'typescript']) {
      assert.ok(real(name), `${name} is not readable: ${roots.join(', ')}`);
    }
  });

  it('names real, canonical directories for packages, and never anything broad', () => {
    for (const root of roots) {
      assert.ok(root !== '/' && root.length > 4, `${root} is too broad`);
      assert.ok(!root.includes('*'));
      if (existsSync(root)) assert.equal(realpathSync(root), root, `${root} is not canonical`);
    }
    // No root is an ancestor of the CLI's own install: nothing above the package is granted.
    const cliPackage = dirname(BUILD_ROOT);
    for (const root of roots) {
      assert.ok(
        !(cliPackage.startsWith(`${root}/`) && !root.endsWith('node_modules')),
        `${root} contains the whole CLI package`,
      );
    }
  });

  it('is deterministic', () => {
    assert.deepEqual(
      resolveCodeRoots(BUILD_ROOT, ['@seamline/extract-contracts']),
      resolveCodeRoots(BUILD_ROOT, ['@seamline/extract-contracts']),
    );
  });

  it('fails the setup, rather than guessing, when a required package is not installed', () => {
    assert.throws(
      () => resolveCodeRoots(BUILD_ROOT, ['@seamline/no-such-package']),
      (e: unknown) =>
        e instanceof SandboxSetupError &&
        /cannot find package @seamline\/no-such-package/.test(e.message),
    );
  });
});

describe('sandbox policy / permission flags', () => {
  it('confines to the named paths, with no write, worker, addon or WASI access', () => {
    const args = permissionArgs(['/a/repo', '/b/code'], false);
    assert.deepEqual(args, ['--permission', '--allow-fs-read=/a/repo', '--allow-fs-read=/b/code']);
  });

  it('grants child processes only when asked', () => {
    assert.ok(permissionArgs(['/a'], true).includes('--allow-child-process'));
    assert.ok(!permissionArgs(['/a'], false).includes('--allow-child-process'));
  });

  it('refuses a path that Node would read as a wildcard', () => {
    assert.throws(() => permissionArgs(['/a/we*ird'], false), SandboxSetupError);
  });

  it('accepts a path with a comma, which Node keeps whole', () => {
    assert.deepEqual(permissionArgs(['/a/x,y'], false), ['--permission', '--allow-fs-read=/a/x,y']);
  });

  it('grants a directory once, not again for each path inside it', () => {
    // Nested grants add no access, and on Node 22.13 they take away the outer directory's own
    // readdir and stat (see withoutNested). Same access set, fewer flags, on every Node.
    assert.deepEqual(permissionArgs(['/r', '/r/dist', '/r/node_modules/x/y', '/c/lib'], false), [
      '--permission',
      '--allow-fs-read=/r',
      '--allow-fs-read=/c/lib',
    ]);
    assert.deepEqual(withoutNested(['/r/a', '/r', '/r']), ['/r']);
  });

  it('does not treat a sibling that shares a name prefix as nested', () => {
    assert.deepEqual(withoutNested(['/r/app', '/r/app-extra', '/r/ap']), [
      '/r/app',
      '/r/app-extra',
      '/r/ap',
    ]);
    assert.deepEqual(withoutNested(['/r/..x', '/r']), ['/r']);
  });
});

describe('sandbox policy / granted programs', { skip: process.platform === 'win32' }, () => {
  const world = realpathSync(mkdtempSync(join(tmpdir(), 'seamline-policy-exec-')));
  after(() => {
    rmSync(world, { recursive: true, force: true });
  });
  const program = (dir: string, name: string, mode = 0o755): string => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode });
    chmodSync(file, mode);
    return file;
  };
  const repo = join(world, 'repo');
  const planted = program(join(repo, 'bin'), 'tool');
  const systemBin = join(world, 'system-bin');
  const system = program(systemBin, 'tool');

  it('resolves a name to the real path of the first match on PATH', () => {
    const alias = join(world, 'alias-bin');
    mkdirSync(alias);
    symlinkSync(system, join(alias, 'tool'));
    assert.deepEqual(resolveExecGrants(['tool'], alias, [repo]), { tool: system });
    // The first match wins, as the lookup a bare name would have made.
    const later = program(join(world, 'later-bin'), 'tool');
    assert.deepEqual(
      resolveExecGrants(['tool'], [systemBin, dirname(later)].join(delimiter), [repo]),
      {
        tool: system,
      },
    );
  });

  it('skips an entry without the program, one that is not a regular executable, and an empty or relative entry', () => {
    const dir = join(world, 'skipped');
    program(dir, 'tool', 0o644);
    mkdirSync(join(world, 'dir-bin', 'tool'), { recursive: true });
    const path = [
      '',
      'relative-bin',
      join(world, 'nowhere'),
      dir,
      join(world, 'dir-bin'),
      systemBin,
    ];
    assert.deepEqual(resolveExecGrants(['tool'], path.join(delimiter), [repo]), { tool: system });
  });

  it('refuses a program whose real path is in the repository, however it is reached', () => {
    const insideRepository = (e: unknown): boolean =>
      e instanceof SandboxSetupError &&
      /tool on PATH resolves to .*, inside the repository/.test(e.message);
    // A directory outside the repository whose `tool` is a link to the planted file.
    const entry = join(world, 'entry');
    mkdirSync(entry, { recursive: true });
    symlinkSync(planted, join(entry, 'tool'));
    assert.throws(() => resolveExecGrants(['tool'], entry, [repo]), insideRepository);
    // A PATH entry that reaches the repository through a link.
    const linkedRepo = join(world, 'linked-repo');
    symlinkSync(repo, linkedRepo);
    assert.throws(
      () => resolveExecGrants(['tool'], join(linkedRepo, 'bin'), [repo]),
      insideRepository,
    );
    // The repository told by a link is the same repository.
    assert.throws(
      () => resolveExecGrants(['tool'], join(repo, 'bin'), [linkedRepo]),
      insideRepository,
    );
    // The planted file is found first, so it is refused; the later system one is not a fallback.
    assert.throws(
      () => resolveExecGrants(['tool'], [entry, systemBin].join(delimiter), [repo]),
      insideRepository,
    );
  });

  it(
    'refuses a program named under /proc or /dev/fd, whatever it leads to',
    { skip: process.platform !== 'linux' },
    () => {
      // `/proc/self/root` leads to the same directory as the plain spelling, which is why the text
      // of the name is refused too, not only where it ends up.
      assert.throws(
        () => resolveExecGrants(['tool'], `/proc/self/root${systemBin}`, [repo]),
        (e: unknown) => e instanceof SandboxSetupError && /under \/proc/.test(e.message),
      );
      assert.deepEqual(resolveExecGrants(['tool'], systemBin, [repo]), { tool: system });
    },
  );

  it('refuses a program that is not on PATH, and a grant that is not a plain name', () => {
    assert.throws(
      () => resolveExecGrants(['tool'], join(world, 'nowhere'), [repo]),
      (e: unknown) =>
        e instanceof SandboxSetupError && /cannot find tool on a PATH outside/.test(e.message),
    );
    assert.throws(() => resolveExecGrants(['tool'], undefined, [repo]), SandboxSetupError);
    for (const name of ['', '.hidden', 'a/b', '../tool', '/usr/bin/tool', 'a b', '-x']) {
      assert.throws(() => resolveExecGrants([name], systemBin, [repo]), SandboxSetupError, name);
    }
    assert.deepEqual(resolveExecGrants([], undefined, [repo]), {});
  });
});

describe('sandbox policy / the closure of a package we did not write', () => {
  const world = realpathSync(mkdtempSync(join(tmpdir(), 'seamline-policy-closure-')));
  after(() => {
    rmSync(world, { recursive: true, force: true });
  });
  const pkg = (dir: string, json: object): string => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
    return dir;
  };

  // world/ext (the package under test) and world/secretproj (a neighbour it has no business reading).
  const ext = pkg(join(world, 'ext'), { name: 'ext' });
  const secret = pkg(join(world, 'secretproj'), { name: 'secretproj' });
  const dep = pkg(join(ext, 'node_modules', 'dep-a'), { name: 'dep-a' });
  const scoped = pkg(join(ext, 'node_modules', '@org', 'dep-b'), { name: '@org/dep-b' });
  // A pnpm-style install: node_modules/dep-c is a link to a store directory inside node_modules.
  const store = pkg(join(ext, 'node_modules', '.pnpm', 'dep-c@1', 'node_modules', 'dep-c'), {
    name: 'dep-c',
  });
  symlinkSync(store, join(ext, 'node_modules', 'dep-c'));
  // A link that leaves node_modules: what `npm link` and a workspace do.
  symlinkSync(secret, join(ext, 'node_modules', 'linked'));

  const rootsOf = (names: string[], confined: boolean): string[] => [
    ...closureRoots(ext, names, [], false, confined).roots,
  ];

  it('refuses a name that is not an npm package name, so it cannot name a directory of its choosing', () => {
    // `join(<node_modules>, '../../secretproj')` is world/secretproj, which holds a package.json.
    const bad = [
      '../../secretproj',
      '../secretproj',
      '..',
      '.',
      '',
      '/etc',
      '/tmp/x',
      'a/b',
      '@org',
      '@org/',
      '@org/a/b',
      '@/a',
      '@org/../../secretproj',
      '.hidden',
      '_hidden',
      'a\\b',
      'a b',
      'x'.repeat(215),
    ];
    for (const name of bad) {
      for (const confined of [true, false]) {
        const roots = rootsOf([name], confined);
        assert.deepEqual(roots, [], `${JSON.stringify(name)} (confined ${String(confined)})`);
      }
    }
  });

  it('still finds a package by a valid name, scoped or not', () => {
    for (const confined of [true, false]) {
      const roots = rootsOf(['dep-a', '@org/dep-b', 'dep-c'], confined);
      for (const real of [dep, scoped, store]) assert.ok(roots.includes(real), `${real} missing`);
      assert.ok(roots.includes(join(ext, 'node_modules')));
      assert.ok(!roots.includes(secret));
    }
  });

  it('does not follow a dependency that a dependency names with a path', () => {
    pkg(join(ext, 'node_modules', 'dep-d'), {
      name: 'dep-d',
      // Each of these reaches world/secretproj from one of the node_modules the walk probes.
      dependencies: { '../../../../secretproj': '1' },
      optionalDependencies: { '../../secretproj': '1' },
    });
    const roots = rootsOf(['dep-d'], true);
    assert.ok(roots.includes(join(ext, 'node_modules', 'dep-d')));
    assert.ok(!roots.some((r) => r.startsWith(secret)), roots.join(', '));
  });

  it('can require that what it finds is inside node_modules, links included', () => {
    // Unconfined (the CLI's own workspace links resolve this way) the link is followed out.
    assert.ok(rootsOf(['linked'], false).includes(secret));
    // Confined (a third-party extractor's package.json chose the name) it is not.
    assert.deepEqual(rootsOf(['linked'], true), []);
    // A link that stays inside the install tree is fine.
    assert.ok(rootsOf(['dep-c'], true).includes(store));
  });
});
