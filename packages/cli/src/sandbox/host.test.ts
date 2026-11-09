/**
 * Negative controls for the extractor sandbox (THREATMODEL.md C4).
 *
 * Every control gets the same two-part test. First the probe extractor
 * (`__fixtures__/sandbox/probe.ts`) is run directly in this process, to show it
 * can do the thing: read the credential, read the file outside the repo,
 * open the socket. Then the same probe is run through the sandbox host, and the
 * thing does not happen. A control that is merely present would pass the second
 * half alone; the first half is what shows the second half is the control's
 * doing and not an accident of the fixture.
 *
 * What is asserted is always an outcome: a value the extractor saw, a status
 * the host returned, a connection a server did or did not receive.
 */

import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ExtractorManifest } from '@seamline/ontology';
import { currentObservationOf, encodeCanonicalSelector } from '@seamline/core';
import { makeRun } from '../testing.ts';
import { run as runProbe } from '../__fixtures__/sandbox/probe.ts';
import type { ExtractContext, ExtractorOutput } from '../ports.ts';
import {
  createSandboxHost,
  observationOf,
  readRssBytes,
  type SandboxProgram,
  type SpawnFn,
} from './host.ts';

const PROBE = fileURLToPath(new URL('../__fixtures__/sandbox/probe.ts', import.meta.url));
const IS_LINUX = process.platform === 'linux';

// ---------------------------------------------------------------------------
// A repository to run in, and a place outside it that must stay out of reach
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'seamline-sbx-'));
const repo = join(root, 'repo');
const outside = join(root, 'outside');
let symlinks = true;

before(() => {
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'private'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(repo, 'src', 'a.txt'), 'declared-content\n');
  writeFileSync(join(repo, 'private', 'secret.env'), 'TOKEN=in-repo-but-undeclared\n');
  writeFileSync(join(outside, 'secret.txt'), 'outside-the-repo\n');
  try {
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'src', 'link-out.txt'));
    symlinkSync(outside, join(repo, 'src', 'dir-out'));
    symlinkSync(join(repo, 'private', 'secret.env'), join(repo, 'src', 'link-private.txt'));
  } catch {
    symlinks = false;
  }
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function manifest(over: Partial<ExtractorManifest> = {}): ExtractorManifest {
  return {
    name: 'probe',
    version: '0.0.1',
    reads: ['src/**'],
    net: false,
    env: [],
    memMb: 256,
    timeoutS: 60,
    provenanceCeiling: 'EXTRACTED',
    produces: [{ scope: 'probe', kinds: ['File'] }],
    ...over,
  };
}

function program(
  over: Partial<ExtractorManifest> = {},
  extra: Partial<SandboxProgram> = {},
): SandboxProgram {
  return {
    manifest: manifest(over),
    module: PROBE,
    packages: [],
    codeRoots: [dirname(PROBE)],
    ...extra,
  };
}

function ctx(options: Record<string, unknown>): ExtractContext {
  return {
    repoRoot: repo,
    repo: 'probe',
    runId: 'run-1',
    outDir: join(root, 'out'),
    include: [],
    exclude: [],
    options,
    deterministic: true,
  };
}

const host = createSandboxHost({ env: process.env, rssPollMs: 20 });
const text = (out: ExtractorOutput): string => out.result.diagnostics.join('\n');

/** The `key=value` findings a probe reported, as a map. */
function findings(out: ExtractorOutput): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of out.result.diagnostics) {
    const at = line.indexOf('=');
    if (at > 0) map[line.slice(0, at)] = line.slice(at + 1);
  }
  return map;
}

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ---------------------------------------------------------------------------
// 1. Environment
// ---------------------------------------------------------------------------

describe('sandbox / environment', () => {
  const planted = {
    AWS_SECRET_ACCESS_KEY: 'canary-aws-secret-value',
    SEAMLINE_TEST_ALLOWED: 'allowed-value',
    SEAMLINE_TEST_UNLISTED: 'unlisted-value',
  };
  const names = [
    'AWS_SECRET_ACCESS_KEY',
    'HOME',
    'SEAMLINE_TEST_ALLOWED',
    'SEAMLINE_TEST_UNLISTED',
  ];

  it('lets the in-process extractor read the credential and HOME, which is what the sandbox exists to prevent', async () => {
    await withEnv(planted, async () => {
      const seen = findings(await runProbe(ctx({ mode: 'env', names })));
      assert.equal(seen['env.AWS_SECRET_ACCESS_KEY'], 'canary-aws-secret-value');
      assert.equal(seen['env.HOME'], process.env['HOME']);
      assert.equal(seen['env.SEAMLINE_TEST_UNLISTED'], 'unlisted-value');
    });
  });

  it('shows the sandboxed extractor neither the credential, nor the real HOME, nor an unlisted variable', async () => {
    await withEnv(planted, async () => {
      // `host` reads process.env when it builds the child's environment, so the planted values are in play.
      const out = await createSandboxHost({ env: process.env }).run(
        program({ env: ['SEAMLINE_TEST_ALLOWED'] }),
        ctx({ mode: 'env', names }),
      );
      assert.equal(out.result.status, 'PASS', text(out));
      const seen = findings(out);
      assert.equal(seen['env.AWS_SECRET_ACCESS_KEY'], 'undefined');
      assert.equal(seen['env.SEAMLINE_TEST_UNLISTED'], 'undefined');
      assert.notEqual(seen['env.HOME'], process.env['HOME']);
      assert.match(
        seen['env.HOME'] ?? '',
        /seamline-sandbox-/,
        'HOME is the synthetic scratch directory',
      );
      // The allow-listed variable the manifest declared does arrive.
      assert.equal(seen['env.SEAMLINE_TEST_ALLOWED'], 'allowed-value');
      // And the credential's value appears nowhere in what came back.
      assert.ok(!JSON.stringify(out).includes('canary-aws-secret-value'));
    });
  });

  it('hands the child exactly the base variables, the declared ones, and a synthetic HOME', async () => {
    await withEnv(planted, async () => {
      const out = await createSandboxHost({ env: process.env }).run(
        program({ env: ['SEAMLINE_TEST_ALLOWED'] }),
        ctx({ mode: 'env', names: [] }),
      );
      const base = ['PATH', 'LANG', 'LC_ALL', 'TZ'].filter((n) => process.env[n] !== undefined);
      const expected = [...base, 'HOME', 'SEAMLINE_TEST_ALLOWED'].sort();
      assert.equal(findings(out)['env.keys'], expected.join(','));
    });
  });

  it('refuses a manifest that asks for a credential variable, and never starts the extractor', async () => {
    let started = 0;
    const counting: SpawnFn = (...args) => {
      started += 1;
      return spawn(...args);
    };
    const out = await createSandboxHost({ env: process.env, spawn: counting }).run(
      program({ env: ['AWS_REGION'] }),
      ctx({ mode: 'env', names: [] }),
    );
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.match(text(out), /AWS_REGION is on the forbidden list/);
    assert.equal(started, 0, 'a refused manifest must not start a process');
  });
});

// ---------------------------------------------------------------------------
// 2. Read paths
// ---------------------------------------------------------------------------

describe('sandbox / read paths', () => {
  const read = (...paths: string[]) => ctx({ mode: 'read', paths });

  it('reads a declared in-repo file, in process and in the sandbox alike', async () => {
    const inProc = findings(await runProbe(read(join(repo, 'src', 'a.txt'))));
    const out = await host.run(program(), read('src/a.txt'));
    assert.equal(out.result.status, 'PASS', text(out));
    assert.equal(inProc[`readFileSync:${join(repo, 'src', 'a.txt')}`], 'got:declared-content');
    assert.equal(findings(out)['readFileSync:src/a.txt'], 'got:declared-content');
  });

  it('refuses an absolute path outside the repo that the in-process extractor reads', async () => {
    const target = join(outside, 'secret.txt');
    assert.equal(
      findings(await runProbe(read(target)))[`readFileSync:${target}`],
      'got:outside-the-repo',
    );

    const out = await host.run(program(), read(target));
    assert.equal(out.result.status, 'FAIL');
    assert.match(
      text(out),
      /\[path-escape\] probe: \.\.\/outside\/secret\.txt is outside the repo root/,
    );
    assert.ok(!text(out).includes('outside-the-repo'), 'the content never reached the result');
    assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
  });

  it('refuses a ../ path outside the repo', async () => {
    const out = await host.run(program(), read('../outside/secret.txt'));
    assert.equal(out.result.status, 'FAIL');
    assert.match(text(out), /\[path-escape\]/);
  });

  it('refuses a symlink inside the repo that points outside it', { skip: !symlinks }, async () => {
    const link = join(repo, 'src', 'link-out.txt');
    assert.equal(
      findings(await runProbe(read(link)))[`readFileSync:${link}`],
      'got:outside-the-repo',
    );

    for (const path of ['src/link-out.txt', 'src/dir-out/secret.txt']) {
      const out = await host.run(program(), read(path));
      assert.equal(out.result.status, 'FAIL', path);
      assert.match(text(out), /\[symlink-escape\]/, path);
      assert.ok(!text(out).includes('outside-the-repo'), path);
    }
  });

  it(
    'refuses an in-repo file no declared glob admits, and a declared name that links to one',
    { skip: !symlinks },
    async () => {
      const direct = join(repo, 'private', 'secret.env');
      assert.equal(
        findings(await runProbe(read(direct)))[`readFileSync:${direct}`],
        'got:TOKEN=in-repo-but-undeclared',
      );

      const out = await host.run(program(), read('private/secret.env'));
      assert.equal(out.result.status, 'FAIL');
      assert.match(
        text(out),
        /\[path-not-declared\] probe: private\/secret\.env matches no declared reads glob \(src\/\*\*\)/,
      );

      const laundered = await host.run(program(), read('src/link-private.txt'));
      assert.equal(laundered.result.status, 'FAIL');
      assert.match(
        text(laundered),
        /\[path-not-declared\].*src\/link-private\.txt is a symlink to private\/secret\.env/,
      );
    },
  );

  it('refuses every way of opening the file, not just readFileSync', async () => {
    const target = join(outside, 'secret.txt');
    const out = await host.run(program(), ctx({ mode: 'read-apis', path: target }));
    assert.equal(out.result.status, 'FAIL');
    // readFileSync, openSync, promises.readFile, promises.open, readFile(callback), createReadStream.
    assert.match(
      text(out),
      /\[path-escape\] probe: \.\.\/outside\/secret\.txt is outside the repo root \(x6\)/,
    );
  });

  it('fails the run even when the extractor swallows the refusal and reports a clean PASS', async () => {
    const target = join(outside, 'secret.txt');
    const inProc = await runProbe(ctx({ mode: 'swallow', path: target }));
    assert.equal(
      inProc.result.status,
      'PASS',
      'precondition: in process, the swallowing extractor passes',
    );

    const out = await host.run(program(), ctx({ mode: 'swallow', path: target }));
    assert.equal(out.result.status, 'FAIL');
    assert.match(text(out), /\[path-escape\]/);
    assert.match(text(out), /discarded/);
  });

  it('answers a probe of the world outside the repo as "not found", and does not fail the run for it', async () => {
    const inProc = findings(await runProbe(ctx({ mode: 'probe-outside', path: outside })));
    assert.equal(inProc['existsSync'], 'true');

    const out = await host.run(program(), ctx({ mode: 'probe-outside', path: outside }));
    assert.equal(out.result.status, 'PASS', text(out));
    assert.deepEqual(findings(out), {
      existsSync: 'false',
      statSync: 'threw:ENOENT',
      readdirSync: 'threw:ENOENT',
      realpathSync: 'threw:ENOENT',
    });
    assert.equal(
      out.result.diagnostics.length,
      4,
      'a passing run is left exactly as the extractor wrote it',
    );
  });

  it(
    'reports a read of an outside file even after hundreds of distinct refused looks have filled the log',
    { skip: !symlinks },
    async () => {
      // 400 distinct looks at names under a link out of the repo, then one read outside it. The guard
      // keeps a bounded log of what it refused; the read is the entry that must never be the one it
      // drops, and the host must say that the log is not the whole story.
      const options = {
        mode: 'saturate',
        dir: join(repo, 'src', 'dir-out'),
        count: 400,
        path: join(outside, 'secret.txt'),
      };
      const inProc = findings(await runProbe(ctx(options)));
      assert.equal(
        inProc[`readFileSync:${options.path}`],
        'got:outside-the-repo',
        'precondition: in process the read succeeds',
      );

      const out = await host.run(program(), ctx(options));
      assert.equal(out.result.status, 'FAIL', text(out));
      assert.match(
        text(out),
        /\[path-escape\] probe: \.\.\/outside\/secret\.txt is outside the repo root/,
        'the read is among the refusals the host lists',
      );
      assert.match(text(out), /further refusals were not recorded/);
      assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
    },
  );

  it(
    'fails the run when a path the repo names leads out of it, though it answers "not found" to the probe',
    { skip: !symlinks },
    async () => {
      // A source file replaced by a link to somewhere else, and a directory that is one: the extractor
      // is told they are not there, and a PASS built on that would tombstone what they used to hold.
      for (const path of [join(repo, 'src', 'link-out.txt'), join(repo, 'src', 'dir-out')]) {
        const inProc = findings(await runProbe(ctx({ mode: 'probe-outside', path })));
        assert.equal(inProc['existsSync'], 'true', 'precondition: in process the path is there');
        const out = await host.run(program(), ctx({ mode: 'probe-outside', path }));
        assert.equal(out.result.status, 'FAIL', `${path}: ${text(out)}`);
        assert.match(
          text(out),
          /\[symlink-escape\] probe: src\/(link-out\.txt|dir-out) resolves outside the repo root/,
        );
        assert.match(text(out), /discarded/);
        assert.equal(out.nodes.length, 0);
      }
    },
  );

  it(
    'fails the run when a path the repo names leads out of it, though it is spelled with a ..',
    { skip: !symlinks },
    async () => {
      // The same two links, reached through a real directory and a `..`. The kernel opens the
      // link's target, so the decision is taken there and the code is `path-escape`; the repo
      // still named a path inside itself, and a PASS that read "not found" would tombstone it.
      const real = join(repo, 'src', 'real');
      const fileOut = join(repo, 'src', 'file-out.ts');
      mkdirSync(real, { recursive: true });
      symlinkSync(join(outside, 'secret.txt'), fileOut);
      try {
        const spellings = [
          'src/real/../dir-out',
          'src/real/../file-out.ts',
          // Not `join`: it would collapse the `..` before the extractor ever saw it.
          `${repo}/src/real/../dir-out/secret.txt`,
        ];
        for (const path of spellings) {
          // `probe-outside` asks `existsSync`, `statSync`, `readdirSync` and `realpathSync`.
          const options = { mode: 'probe-outside', path };
          // The test process is not in the repo, so its own run needs the absolute name.
          const here = { mode: 'probe-outside', path: isAbsolute(path) ? path : `${repo}/${path}` };
          const inProc = findings(await runProbe(ctx(here)));
          assert.equal(inProc['existsSync'], 'true', `${path}: precondition, it is there`);
          assert.equal(typeof inProc['statSync'], 'string');
          assert.ok(!inProc['statSync']?.startsWith('threw'), `${path}: precondition, stat works`);
          const out = await host.run(program(), ctx(options));
          assert.equal(out.result.status, 'FAIL', `${path}: ${text(out)}`);
          assert.match(text(out), /\[(path-escape|symlink-escape)\] probe: /);
          assert.match(text(out), /discarded/);
          assert.equal(out.nodes.length, 0);
        }
      } finally {
        rmSync(fileOut, { force: true });
        rmSync(real, { recursive: true, force: true });
      }
    },
  );

  it(
    'does not fail the run for a dependency link under node_modules that leads out of the repo',
    { skip: !symlinks },
    async () => {
      mkdirSync(join(repo, 'node_modules'), { recursive: true });
      symlinkSync(outside, join(repo, 'node_modules', 'linked-dep'));
      const out = await host.run(
        program(),
        ctx({ mode: 'probe-outside', path: join(repo, 'node_modules', 'linked-dep') }),
      );
      assert.equal(out.result.status, 'PASS', text(out));
      assert.equal(findings(out)['statSync'], 'threw:ENOENT');
    },
  );

  it(
    'fails the run when a read is refused after a probe of the same path, though the extractor swallows both',
    { skip: !symlinks },
    async () => {
      // The probe and the read carry the same code and message, so the read was folded into the
      // probe's non-fatal entry and the run passed. Order must not matter.
      const dependency = join(repo, 'node_modules', 'linked-dep');
      mkdirSync(join(repo, 'node_modules'), { recursive: true });
      if (!existsSync(dependency)) symlinkSync(outside, dependency);
      for (const path of [join(outside, 'secret.txt'), join(dependency, 'secret.txt')]) {
        const inProc = findings(await runProbe(ctx({ mode: 'probe-then-read', path })));
        assert.equal(
          inProc['readFileSync'],
          'got:outside-the-repo',
          'precondition: the read works',
        );
        const out = await host.run(program(), ctx({ mode: 'probe-then-read', path }));
        assert.equal(out.result.status, 'FAIL', `${path}: ${text(out)}`);
        assert.match(text(out), /\[(path-escape|symlink-escape)\]/);
        assert.match(text(out), /discarded/);
      }
    },
  );

  it(
    'judges src/link/../x by where the kernel opens it, not by the name with the .. collapsed',
    { skip: !symlinks },
    async () => {
      // `src/dir-out` leads outside the repo, so `src/dir-out/../x` is a file beside the link's
      // target. Collapsing the `..` first would judge `src/x`, which is inside the repo.
      writeFileSync(join(root, 'x'), 'above-the-repo-secret\n');
      const raw = `${repo}/src/dir-out/../x`;
      const inProc = findings(await runProbe(ctx({ mode: 'read', paths: [raw] })));
      assert.equal(inProc[`readFileSync:${raw}`], 'got:above-the-repo-secret', 'precondition');
      for (const path of ['src/dir-out/../x', raw]) {
        const out = await host.run(program(), ctx({ mode: 'read', paths: [path] }));
        assert.equal(out.result.status, 'FAIL', `${path}: ${text(out)}`);
        assert.match(text(out), /\[path-escape\] probe: \.\.\/x is outside the repo root/);
      }
    },
  );

  describe('a repository reached through a symlinked directory', () => {
    // `<world>/link-parent` is a link to `<world>/real-parent`, and the repository is `repo` in it,
    // named to the host through the link: the shape of a checkout under macOS `/tmp` or `/var`. The
    // child's working directory is the real path, so a name that is relative, or spelled through
    // the real parent, is resolved there, and must be judged against the repo it really is.
    const world = join(root, 'linked-world');
    const realParent = join(world, 'real-parent');
    const linkParent = join(world, 'link-parent');
    const realRepo = join(realParent, 'repo');
    const linkedRepo = join(linkParent, 'repo');
    let linked = false;

    before(() => {
      mkdirSync(join(realRepo, 'src', 'real'), { recursive: true });
      writeFileSync(join(realRepo, 'src', 'a.txt'), 'declared-content\n');
      try {
        symlinkSync(outside, join(realRepo, 'src', 'dir-out'));
        symlinkSync(realParent, linkParent);
        linked = true;
      } catch {
        linked = false;
      }
    });

    // Every spelling of a repository path that leads out: relative, through the link, through the
    // real parent, with a `..` after a real directory, and plain. Not `join`: it would collapse the
    // `..` before the extractor ever saw it.
    const leadingOut = [
      'src/dir-out',
      'src/real/../dir-out',
      `${linkedRepo}/src/dir-out`,
      `${linkedRepo}/src/real/../dir-out`,
      `${realRepo}/src/dir-out`,
      `${realRepo}/src/real/../dir-out`,
      `${realRepo}/src/real/../dir-out/secret.txt`,
    ];
    const linkedCtx = (options: Record<string, unknown>): ExtractContext => ({
      ...ctx(options),
      repoRoot: linkedRepo,
    });

    it('fails the run for a path the repo names that leads out of it, however it is reached', async (t) => {
      if (!linked) return t.skip('this platform cannot make the symlinks');
      for (const path of leadingOut) {
        // `probe-outside` asks `existsSync`, `statSync`, `readdirSync` and `realpathSync`.
        const here = {
          mode: 'probe-outside',
          path: isAbsolute(path) ? path : `${realRepo}/${path}`,
        };
        const inProc = findings(await runProbe(ctx(here)));
        assert.equal(inProc['existsSync'], 'true', `${path}: precondition, it is there`);
        const out = await host.run(program(), linkedCtx({ mode: 'probe-outside', path }));
        assert.equal(out.result.status, 'FAIL', `${path}: ${text(out)}`);
        assert.match(text(out), /\[(path-escape|symlink-escape)\] probe: /, path);
        assert.match(text(out), /discarded/, path);
        assert.equal(out.nodes.length, 0);
      }
    });

    it('still reads a declared file, relative or absolute, and does not fail for the world outside', async (t) => {
      if (!linked) return t.skip('this platform cannot make the symlinks');
      // The extractor is told the real path of the repository, so these are the names it has.
      const spellings = [
        'src/a.txt',
        'src/real/../a.txt',
        `${realRepo}/src/real/../a.txt`,
        `${realRepo}/src/a.txt`,
      ];
      const read = await host.run(program(), linkedCtx({ mode: 'read', paths: spellings }));
      assert.equal(read.result.status, 'PASS', text(read));
      for (const path of spellings)
        assert.equal(findings(read)[`readFileSync:${path}`], 'got:declared-content', path);

      // A look at the directory above the repo, the way a resolver walks up, is the world outside.
      const above = await host.run(
        program(),
        linkedCtx({ mode: 'probe-outside', path: `${realParent}/../real-parent` }),
      );
      assert.equal(above.result.status, 'PASS', text(above));
    });

    it('refuses a read that goes through the link, which the extractor is never given', async (t) => {
      if (!linked) return t.skip('this platform cannot make the symlinks');
      // Loudly, not as a file that quietly is not there: the runtime refuses these names (only the
      // real path is granted) with an error of its own, which an extractor can swallow.
      const names = [`${linkedRepo}/src/a.txt`, `${linkedRepo}/src/real/../a.txt`];
      for (const path of names) {
        const read = await host.run(program(), linkedCtx({ mode: 'read', paths: [path] }));
        assert.equal(read.result.status, 'FAIL', `read ${path}: ${text(read)}`);
        assert.match(text(read), /\[path-escape\]/, path);
        const probe = await host.run(program(), linkedCtx({ mode: 'probe-outside', path }));
        assert.equal(probe.result.status, 'FAIL', `probe ${path}: ${text(probe)}`);
        assert.match(text(probe), /\[path-escape\]/, path);
      }
    });

    // Since the host names the real path, the guard is told the link only as the spelling the caller
    // used. A guard handed the link as THE root, and allowed to look at it, which is how the host
    // stood before the grant became the real path, must still judge a relative name, resolved
    // against the real working directory, as the repo's: the name is asked against the real root.
    it('judges a name against the real repo root when the guard is given the link as the root', async (t) => {
      if (!linked) return t.skip('this platform cannot make the symlinks');
      const asLinkRoot: SpawnFn = (command, args, options) => {
        // Grant the link too, so the child may resolve it, as it could when the link was the grant.
        const [permission, ...rest] = args;
        const child = spawn(
          command,
          [permission ?? '', `--allow-fs-read=${linkedRepo}`, ...rest],
          options,
        );
        const stdin = child.stdin;
        if (stdin !== null) {
          const end = stdin.end.bind(stdin) as (chunk: string) => unknown;
          (stdin as unknown as { end: (chunk: string) => unknown }).end = (json) => {
            const request = JSON.parse(json) as {
              repoRoot: string;
              repoRootAs?: string;
              ctx: { repoRoot: string };
            };
            request.repoRoot = linkedRepo;
            request.ctx.repoRoot = linkedRepo;
            delete request.repoRootAs;
            return end(JSON.stringify(request));
          };
        }
        return child;
      };
      const own = createSandboxHost({ env: process.env, rssPollMs: 20, spawn: asLinkRoot });
      for (const path of leadingOut) {
        const out = await own.run(program(), linkedCtx({ mode: 'probe-outside', path }));
        assert.equal(out.result.status, 'FAIL', `${path}: ${text(out)}`);
        assert.match(text(out), /\[(path-escape|symlink-escape)\] probe: /, path);
      }
    });
  });

  it('writes nothing, whatever the extractor is willing to try', async () => {
    const file = join(repo, 'src', 'dropped.txt');
    const dir = join(root, 'made-by-extractor');
    const inProc = findings(await runProbe(ctx({ mode: 'write', path: file, dir })));
    assert.equal(inProc['writeFileSync'], 'ok');
    assert.ok(existsSync(file) && existsSync(dir), 'precondition: in process, the writes land');
    rmSync(file);
    rmSync(dir, { recursive: true });

    const out = await host.run(program(), ctx({ mode: 'write', path: file, dir }));
    assert.equal(out.result.status, 'FAIL');
    assert.match(text(out), /\[fs-write\]/);
    assert.ok(!existsSync(file) && !existsSync(dir), 'nothing was written');
  });

  it("can still list the repo when the extractor's own code is installed inside it", async () => {
    // A checkout whose build output or node_modules sit under the repo root (this repository, and
    // any project that depends on Seamline) grants a path nested in a path it already granted. Node
    // 22.13 answered a directory listing or stat of the outer grant with ERR_ACCESS_DENIED then.
    const vendored = join(repo, 'vendor');
    mkdirSync(vendored, { recursive: true });
    const listing = [repo, join(repo, 'src')];
    const inProc = findings(await runProbe(ctx({ mode: 'list', paths: listing })));
    assert.match(inProc[`readdirSync:${repo}`] ?? '', /^got:.*\bvendor\b/);
    const out = await host.run(
      program({}, { codeRoots: [dirname(PROBE), vendored] }),
      ctx({ mode: 'list', paths: listing }),
    );
    assert.equal(out.result.status, 'PASS', text(out));
    const seen = findings(out);
    for (const path of listing) {
      assert.equal(
        seen[`readdirSync:${path}`],
        inProc[`readdirSync:${path}`],
        `readdirSync ${path}`,
      );
      assert.equal(
        seen[`promises.readdir:${path}`],
        inProc[`readdirSync:${path}`],
        `readdir ${path}`,
      );
      assert.equal(seen[`statSync:${path}`], 'got:directory', `statSync ${path}`);
    }
  });

  it('declares nothing to read when the manifest declares no reads', async () => {
    const out = await host.run(program({ reads: [] }), read('src/a.txt'));
    assert.equal(out.result.status, 'FAIL');
    assert.match(text(out), /\[path-not-declared\].*none declared/);
  });
});

// ---------------------------------------------------------------------------
// 3. Network
// ---------------------------------------------------------------------------

describe('sandbox / network', () => {
  let server: Server;
  let connections = 0;
  let port = 0;

  before(async () => {
    server = createServer((socket) => {
      connections += 1;
      // A client that connects and hangs up (the probe does) resets the socket; that is not under test.
      socket.on('error', () => undefined);
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  after(() => {
    server.close();
  });

  it('lets the in-process extractor connect, fetch and resolve names', async () => {
    connections = 0;
    const seen = findings(await runProbe(ctx({ mode: 'net', port })));
    assert.equal(seen['net.connect'], 'got:connected');
    assert.equal(seen['fetch'], 'ok');
    assert.equal(seen['http.get'], 'got:status 200');
    assert.ok(connections >= 3, `the server saw ${connections} connections`);
  });

  it('stops the sandboxed extractor at every door, and the server sees nothing', async () => {
    connections = 0;
    const out = await host.run(program(), ctx({ mode: 'net', port }));
    assert.equal(out.result.status, 'FAIL');
    const lines = text(out);
    for (const door of ['net.connect', 'fetch', 'http.get', 'dns.lookup', 'dns.promises.lookup']) {
      assert.match(
        lines,
        new RegExp(`\\[network\\] probe: ${door.replace('.', '\\.')} is refused`),
        door,
      );
    }
    assert.equal(connections, 0, 'no connection reached the server');
  });
});

// ---------------------------------------------------------------------------
// 4. Child processes
// ---------------------------------------------------------------------------

describe('sandbox / child processes', () => {
  const exec = (commands: string[], shell = false) => ctx({ mode: 'exec', commands, shell });

  it('runs a binary in process', async () => {
    assert.equal(findings(await runProbe(exec(['git'])))['spawnSync:git'], 'got:ran');
  });

  it(
    'does not resolve the granted binary through a PATH entry the repo controls',
    { skip: process.platform === 'win32' },
    async () => {
      const marker = join(root, 'planted-ran');
      mkdirSync(join(repo, 'bin'), { recursive: true });
      const planted = join(repo, 'bin', 'git');
      writeFileSync(planted, `#!/bin/sh\necho ran > ${marker}\nexit 0\n`);
      chmodSync(planted, 0o755);
      const env = {
        ...process.env,
        PATH: ['bin', '', join(repo, 'bin'), process.env['PATH'] ?? ''].join(delimiter),
      };
      spawnSync('git', ['--version'], { cwd: repo, env });
      assert.ok(
        existsSync(marker),
        'precondition: looked up from the repo root, the planted file runs',
      );
      rmSync(marker);

      const boxed = createSandboxHost({ env, rssPollMs: 20 });
      const out = await boxed.run(program({}, { exec: ['git'] }), exec(['git']));
      assert.equal(out.result.status, 'PASS', text(out));
      assert.equal(findings(out)['spawnSync:git'], 'got:ran');
      assert.ok(!existsSync(marker), 'the file the repo supplied did not run');
    },
  );

  it('refuses any binary when none was granted', async () => {
    const out = await host.run(program(), exec(['git']));
    assert.equal(out.result.status, 'FAIL');
    assert.match(
      text(out),
      /\[exec\] probe: starting git, which is not a granted binary \(granted: none\) is refused/,
    );
  });

  it('runs a granted binary, and only that one, and never through a shell', async () => {
    const granted = program({}, { exec: ['git'] });
    const ok = await host.run(granted, exec(['git']));
    assert.equal(ok.result.status, 'PASS', text(ok));
    assert.equal(findings(ok)['spawnSync:git'], 'got:ran');

    const other = await host.run(granted, exec(['echo']));
    assert.equal(other.result.status, 'FAIL');
    assert.match(
      text(other),
      /\[exec\] probe: starting echo, which is not a granted binary \(granted: git\)/,
    );

    const shell = await host.run(granted, exec(['git'], true));
    assert.equal(shell.result.status, 'FAIL');
    assert.match(text(shell), /\[exec\] probe: starting echo hi through a shell is refused/);
  });

  it('runs the granted binary at the real path the host found for it, by name or by exactly that path', async () => {
    const found = systemGit();
    const granted = program({}, { exec: ['git'] });
    for (const command of ['git', found]) {
      const out = await host.run(granted, exec([command]));
      assert.equal(out.result.status, 'PASS', `${command}: ${text(out)}`);
      assert.equal(findings(out)[`spawnSync:${command}`], 'got:ran', command);
    }
  });

  it(
    'refuses another name for the same binary, because only the host can tell where a name leads',
    { skip: process.platform === 'win32' },
    async () => {
      // A link outside the repository to the very program the host granted. It is the same file, and
      // it is refused all the same: the guard cannot look at where a name leads (on Node 24 the
      // runtime refuses the look), so it allows the bare name and the host's own path, nothing else.
      const bin = join(root, 'other-bin');
      mkdirSync(bin, { recursive: true });
      const alias = join(bin, 'git');
      rmSync(alias, { force: true });
      symlinkSync(systemGit(), alias);
      const out = await host.run(program({}, { exec: ['git'] }), exec([alias]));
      assert.equal(out.result.status, 'FAIL', text(out));
      assert.match(
        text(out),
        /\[exec\] probe: starting .*\/other-bin\/git, an absolute path other than the one the host found/,
      );
    },
  );

  it('reads the options of a start once, so a getter cannot turn a shell on after the check', async () => {
    // `shell` answers "no" to the first read and "yes" to every one after. A guard that reads it to
    // decide and hands the same object on to Node lets Node read it again and run the command
    // through a shell, which is what `; echo SHELLRAN` shows.
    const out = await host.run(
      program({}, { exec: ['git'] }),
      ctx({ mode: 'shell-getter', commands: ['git'] }),
    );
    assert.equal(out.result.status, 'PASS', text(out));
    assert.equal(findings(out)['spawnSync:git'], 'got:no-shell');
  });

  it('keeps the result util.promisify gives execFile, and still refuses what it refuses', async () => {
    const options = { mode: 'promisify', commands: ['git'] };
    assert.equal(
      findings(await runProbe(ctx(options)))['promisify(execFile):git'],
      'got:resolved stdout and stderr',
      'precondition: Node resolves both',
    );
    const granted = program({}, { exec: ['git'] });
    const ok = await host.run(granted, ctx(options));
    assert.equal(ok.result.status, 'PASS', text(ok));
    assert.equal(findings(ok)['promisify(execFile):git'], 'got:resolved stdout and stderr');

    // The hook that comes with it calls Node's own function, and the start is still judged.
    const other = await host.run(granted, ctx({ mode: 'promisify', commands: ['echo'] }));
    assert.equal(other.result.status, 'FAIL', text(other));
    assert.match(text(other), /\[exec\] probe: starting echo, which is not a granted binary/);

    const viaExec = await host.run(granted, ctx({ mode: 'promisify', commands: [], exec: true }));
    assert.equal(viaExec.result.status, 'FAIL', text(viaExec));
    assert.match(text(viaExec), /\[exec\] probe: starting exec\(\) is refused/);
  });

  const HAS_EXECVE = typeof (process as { execve?: unknown }).execve === 'function';

  it(
    'refuses process.execve, which would replace the extractor with a program, whether or not a binary was granted',
    { skip: !HAS_EXECVE && 'this Node has no process.execve (it was added in 22.15 and 23.11)' },
    async () => {
      const ungranted = await host.run(program(), ctx({ mode: 'execve', commands: ['/bin/true'] }));
      assert.equal(ungranted.result.status, 'FAIL', text(ungranted));
      assert.match(text(ungranted), /\[exec\] probe: starting process\.execve\(\) is refused/);

      const granted = await host.run(
        program({}, { exec: ['git'] }),
        ctx({ mode: 'execve', commands: [systemGit()] }),
      );
      assert.equal(granted.result.status, 'FAIL', text(granted));
      assert.match(text(granted), /\[exec\] probe: starting process\.execve\(\) is refused/);
      assert.doesNotMatch(text(granted), /\[crash\]/);
    },
  );
});

// ---------------------------------------------------------------------------
// 4b. A program the repository supplies
// ---------------------------------------------------------------------------

/** The real path of the `git` found on this process's PATH, found without the code under test. */
function systemGit(): string {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    try {
      const real = realpathSync(join(dir, 'git'));
      if (statSync(real).isFile()) return real;
    } catch {
      // not in this directory
    }
  }
  throw new Error('these tests need git on PATH');
}

describe(
  'sandbox / a program the repository supplies',
  { skip: process.platform === 'win32' },
  () => {
    // A hostile repository's own config can name the program an extractor option such as `gitBin`
    // runs. The planted `bin/git` here appends to a file outside the repository when it runs, so
    // "did not run" is read off the file, not off the status. `told` is the root the host is given:
    // the repository as it really is, or reached through a symlinked directory (a checkout under
    // macOS `/tmp` or `/var`).
    const world = join(root, 'exec-world');
    const realParent = join(world, 'real-parent');
    const linkParent = join(world, 'link-parent');
    const realRepo = join(realParent, 'repo');
    const linkedRepo = join(linkParent, 'repo');
    const marker = join(world, 'MARKER');
    let linked = false;

    before(() => {
      mkdirSync(join(realRepo, 'src'), { recursive: true });
      mkdirSync(join(realRepo, 'bin'), { recursive: true });
      writeFileSync(join(realRepo, 'src', 'a.txt'), 'declared-content\n');
      writeFileSync(join(realRepo, 'bin', 'git'), `#!/bin/sh\necho ran >> ${marker}\nexit 0\n`, {
        mode: 0o755,
      });
      try {
        symlinkSync(realParent, linkParent);
        linked = true;
      } catch {
        linked = false;
      }
    });

    const layouts: Array<{ layout: string; told: () => string }> = [
      { layout: 'a repository told by its real path', told: () => realRepo },
      { layout: 'a repository told through a symlinked directory', told: () => linkedRepo },
    ];

    /** Every way to spell the planted program that does not lie inside the repository by its text. */
    function namesOfPlanted(told: string): Array<[string, string]> {
      return [
        ['the real path', `${realRepo}/bin/git`],
        ['a .. after a real directory', `${realRepo}/src/../bin/git`],
        ['the spelling the host was told', `${told}/bin/git`],
        ['the spelling through the link', `${linkedRepo}/bin/git`],
        ['a .. after the link spelling', `${linkedRepo}/src/../bin/git`],
        ['/proc/self/cwd', '/proc/self/cwd/bin/git'],
        ['/proc/self/cwd with a ..', '/proc/self/cwd/src/../bin/git'],
        ['/proc/self/root and the real path', `/proc/self/root${realRepo}/bin/git`],
        ['/proc/self/root and the link spelling', `/proc/self/root${linkedRepo}/bin/git`],
        ['a relative path', './bin/git'],
        ['a relative path without the dot', 'bin/git'],
      ];
    }

    for (const { layout, told } of layouts) {
      it(
        `does not run it under any name, for ${layout}`,
        { skip: process.platform !== 'linux' },
        async (t) => {
          if (!linked) return t.skip('this platform cannot make the symlinks');
          const granted = program({}, { exec: ['git'] });
          for (const [label, name] of namesOfPlanted(told())) {
            // Without the control the name runs the planted program, as a process started in the repo
            // would see it.
            rmSync(marker, { force: true });
            const direct = spawnSync(name, ['--version'], { cwd: realRepo });
            assert.ok(!direct.error, `${label}: precondition, ${direct.error?.message}`);
            assert.ok(existsSync(marker), `${label}: precondition, the planted program runs`);
            rmSync(marker);

            const out = await host.run(granted, {
              ...ctx({ mode: 'exec', commands: [name] }),
              repoRoot: told(),
            });
            assert.equal(out.result.status, 'FAIL', `${label} (${name}): ${text(out)}`);
            assert.match(text(out), /\[exec\] probe: starting .* is refused/, label);
            assert.ok(!existsSync(marker), `${label} (${name}): the planted program ran`);
            assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
          }
        },
      );

      it(`still runs the system binary by name, for ${layout}`, async (t) => {
        if (!linked) return t.skip('this platform cannot make the symlinks');
        rmSync(marker, { force: true });
        const out = await host.run(program({}, { exec: ['git'] }), {
          ...ctx({ mode: 'exec', commands: ['git', systemGit()] }),
          repoRoot: told(),
        });
        assert.equal(out.result.status, 'PASS', text(out));
        assert.equal(findings(out)['spawnSync:git'], 'got:ran');
        assert.equal(findings(out)[`spawnSync:${systemGit()}`], 'got:ran');
        assert.ok(!existsSync(marker), 'the planted program did not run');
      });
    }

    it('does not start when the binary on PATH is a link to the repository, however the link is spelled', async (t) => {
      if (!linked) return t.skip('this platform cannot make the symlinks');
      // The one PATH entry outside the repo holds a `git` that leads into it: the lookup the child
      // would have made lands on the planted file, which no check on a name sees.
      for (const [label, target] of [
        ['the real path', join(realRepo, 'bin', 'git')],
        ['the link spelling', join(linkedRepo, 'bin', 'git')],
      ] as const) {
        const bin = mkdtempSync(join(world, 'path-entry-'));
        symlinkSync(target, join(bin, 'git'));
        rmSync(marker, { force: true });
        spawnSync('git', ['--version'], {
          cwd: realRepo,
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` },
        });
        assert.ok(
          existsSync(marker),
          `${label}: precondition, the lookup finds the planted program`,
        );
        rmSync(marker);

        const boxed = createSandboxHost({
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` },
          rssPollMs: 20,
        });
        const out = await boxed.run(program({}, { exec: ['git'] }), {
          ...ctx({ mode: 'exec', commands: ['git'] }),
          repoRoot: linkedRepo,
        });
        assert.equal(out.result.status, 'UNAVAILABLE', `${label}: ${text(out)}`);
        assert.match(
          text(out),
          /git on PATH resolves to .*\/bin\/git, inside the repository/,
          label,
        );
        assert.ok(!existsSync(marker), `${label}: the planted program ran`);
        assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
      }
    });

    it(
      'does not run the planted program through process.execve, by any name that reaches it',
      {
        skip:
          typeof (process as { execve?: unknown }).execve !== 'function' &&
          'this Node has no process.execve (it was added in 22.15 and 23.11)',
      },
      async () => {
        // `execve` takes the path as given, does no PATH search, and is not in `child_process`; the
        // permission model gates it by `--allow-child-process` only, which the granted `git` brings.
        const names = [`${realRepo}/bin/git`, '/proc/self/cwd/bin/git', 'bin/git'];
        for (const name of names) {
          rmSync(marker, { force: true });
          const direct = spawnSync(
            process.execPath,
            ['-e', `process.execve(${JSON.stringify(name)}, [${JSON.stringify(name)}], {})`],
            { cwd: realRepo },
          );
          assert.ok(!direct.error, `${name}: precondition, ${direct.error?.message}`);
          assert.ok(existsSync(marker), `${name}: precondition, execve runs the planted program`);
          rmSync(marker);
        }

        const out = await host.run(program({}, { exec: ['git'] }), {
          ...ctx({ mode: 'execve', commands: names }),
          repoRoot: realRepo,
        });
        assert.equal(out.result.status, 'FAIL', text(out));
        assert.match(text(out), /\[exec\] probe: starting process\.execve\(\) is refused/);
        assert.ok(!existsSync(marker), 'the planted program ran');
        assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
      },
    );

    it('does not search a PATH the call brings along, because the bare name is replaced by the host path', async () => {
      // libuv looks a bare name up on the PATH of the environment the call passes, not the process's.
      // An extractor that hands one with the repository's `bin` in it would otherwise run the planted
      // file, though the child's own PATH has no such entry.
      rmSync(marker, { force: true });
      const callPath = join(realRepo, 'bin');
      spawnSync('git', ['--version'], { cwd: realRepo, env: { PATH: callPath } });
      assert.ok(existsSync(marker), 'precondition: that PATH finds the planted program');
      rmSync(marker);

      const out = await host.run(program({}, { exec: ['git'] }), {
        ...ctx({ mode: 'exec', commands: ['git'], callPath }),
        repoRoot: realRepo,
      });
      assert.equal(out.result.status, 'PASS', text(out));
      assert.equal(findings(out)['spawnSync:git'], 'got:ran');
      assert.ok(!existsSync(marker), 'the planted program did not run');
    });

    it('does not start, and runs nothing, when the binary is nowhere on PATH', async () => {
      rmSync(marker, { force: true });
      const boxed = createSandboxHost({
        env: { ...process.env, PATH: '/nonexistent-bin' },
        rssPollMs: 20,
      });
      const out = await boxed.run(program({}, { exec: ['git'] }), {
        ...ctx({ mode: 'exec', commands: ['git'] }),
        repoRoot: realRepo,
      });
      assert.equal(out.result.status, 'UNAVAILABLE', text(out));
      assert.match(text(out), /cannot find git on a PATH outside the repository/);
    });
  },
);

// ---------------------------------------------------------------------------
// 5. Wallclock
// ---------------------------------------------------------------------------

describe('sandbox / process shutdown', () => {
  async function reapIfRunning(child: ChildProcess | undefined): Promise<void> {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
  }

  it('delivers its response and exits after allocations with pending async work', { timeout: 90_000 }, async (t) => {
    const pids: number[] = [];
    const children: ChildProcess[] = [];
    t.after(async () => { await Promise.all(children.map(reapIfRunning)); });
    const stressing: SpawnFn = (command, args, options) => {
      const child = spawn(command, ['--stress-concurrent-allocation', ...args], options);
      children.push(child);
      if (child.pid !== undefined) pids.push(child.pid);
      return child;
    };
    const boxed = createSandboxHost({ env: process.env, spawn: stressing });
    // The original failure is a scheduling race. Repeated fresh processes
    // exercise shutdown; an unavailable or timed-out attempt cannot pass.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const out = await boxed.run(program({ timeoutS: 15 }), ctx({ mode: 'exit-background-gc' }));
      assert.equal(out.result.status, 'PASS', `attempt ${attempt}: ${text(out)}`);
      assert.equal(findings(out)['shutdownProbe'], '100000');
      assert.deepEqual(observationOf(out)?.violations, []);
      assert.equal(pids.length, attempt + 1);
      assert.throws(() => process.kill(pids[attempt]!, 0), { code: 'ESRCH' }, 'the child exited');
    }
  });

  it('rejects a complete response when exit remains blocked and reaps the child', { timeout: 30_000 }, async (t) => {
    let pid: number | undefined;
    let child: ChildProcess | undefined;
    t.after(async () => { await reapIfRunning(child); });
    let reportedSent = false;
    let responseBytes = 0;
    let phaseTail = '';
    const recording: SpawnFn = (...args) => {
      child = spawn(...args);
      pid = child.pid;
      child.stdio[3]?.on('data', (chunk: Buffer) => { responseBytes += chunk.length; });
      child.stdio[4]?.on('data', (chunk: Buffer) => {
        phaseTail = (phaseTail + chunk.toString('utf8')).slice(-128);
        if (phaseTail.includes('[seamline-child-phase:sent]')) reportedSent = true;
      });
      return child;
    };
    const out = await createSandboxHost({ env: process.env, spawn: recording }).run(
      program({ timeoutS: 15 }), ctx({ mode: 'exit-wait' }),
    );
    assert.ok(reportedSent && responseBytes > 0, 'the child sent a response before blocking');
    assert.equal(out.result.status, 'FAIL');
    assert.match(text(out), /\[timeout\]/);
    assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' }, 'the child was reaped');
  });
});

describe('sandbox / wallclock', () => {
  it('enforces the declared timeout, reports FAIL, and leaves no process behind', async () => {
    let pid: number | undefined;
    const recording: SpawnFn = (...args) => {
      const child: ChildProcess = spawn(...args);
      pid = child.pid;
      return child;
    };
    const started = Date.now();
    const observations: string[] = [];
    const stderr = mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
      observations.push(String(chunk));
      return true;
    });
    let out: ExtractorOutput;
    try {
      out = await createSandboxHost({ env: process.env, spawn: recording }).run(
        program({ timeoutS: 1 }),
        ctx({ mode: 'busy', stderr: 'private-timeout-canary [seamline-child-phase:injected]' }),
      );
    } finally { stderr.mock.restore(); }
    const took = Date.now() - started;
    assert.equal(out.result.status, 'FAIL');
    assert.match(
      text(out),
      /\[timeout\] probe: exceeded its declared wallclock budget of 1s and was killed/,
    );
    assert.ok(took < 15_000, `took ${took}ms for a 1s budget`);
    assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
    // A real deadline can expire during startup. The ready-probe control below
    // separately proves phase delivery and privacy after the probe has run.
    assert.match(observations.join(''), /sandbox-timeout-observation: reportedPhase=\S+ stdinFinished=(?:true|false) responseBytes=\d+/);
    assert.doesNotMatch(JSON.stringify(out), /cpuTicks|rssBytes|stdinFinished|responseBytes|reportedPhase|seamline-child-phase/, 'observation metadata never enters the extraction output');
    if (IS_LINUX) assert.match(observations.join(''), /state=[RSDZTWtXxIKP] cpuTicks=\d+ rssBytes=\d+/);
    assert.ok(pid !== undefined);
    assert.throws(() => process.kill(pid as number, 0), { code: 'ESRCH' }, 'the child is gone');
  });

  it('observes a running probe at timeout without assuming startup fits its budget', { timeout: 15_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let child: ChildProcess | undefined;
    let started!: () => void;
    let failed!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { started = resolve; failed = reject; });
    t.signal.addEventListener('abort', () => {
      child?.kill('SIGKILL');
      failed(new Error('probe did not become ready'));
    }, { once: true });
    const recording: SpawnFn = (...args) => {
      child = spawn(...args);
      let stderrBytes = '';
      let phaseBytes = '';
      const check = () => {
        if (stderrBytes.includes('private-timeout-canary') && phaseBytes.includes('[seamline-child-phase:injected]')) started();
      };
      child.stderr?.on('data', (bytes: Buffer) => { stderrBytes += String(bytes); check(); });
      child.stdio[4]?.on('data', (bytes: Buffer) => { phaseBytes += String(bytes); check(); });
      child.once('error', failed);
      child.once('close', () => failed(new Error('probe exited before both readiness canaries')));
      if (t.signal.aborted) child.kill('SIGKILL');
      return child;
    };
    const observations: string[] = [];
    const stderr = mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
      observations.push(String(chunk));
      return true;
    });
    const pending = createSandboxHost({ env: process.env, spawn: recording }).run(
      program({ timeoutS: 1 }), ctx({ mode: 'busy', stderr: 'private-timeout-canary' }),
    );
    try {
      // These are actual bytes from the real child, independent of its host
      // observation. A missing run marker must still fail the assertion below.
      await ready;
      t.mock.timers.tick(1_000);
      const out = await pending;
      assert.equal(out.result.status, 'FAIL');
      assert.match(text(out), /\[timeout\] probe: exceeded its declared wallclock budget of 1s and was killed/);
      assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
      assert.match(observations.join(''), /sandbox-timeout-observation: reportedPhase=run stdinFinished=true responseBytes=0/);
      assert.ok(!observations.join('').includes('private-timeout-canary'), 'observed raw child stderr never enters timeout metadata');
      assert.doesNotMatch(JSON.stringify(out), /cpuTicks|rssBytes|stdinFinished|responseBytes|reportedPhase|seamline-child-phase/);
      assert.ok(child?.pid !== undefined);
      assert.throws(() => process.kill(child!.pid!, 0), { code: 'ESRCH' });
    } finally {
      try {
        child?.kill('SIGKILL');
        await pending;
      } finally {
        stderr.mock.restore();
        t.mock.timers.reset();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Memory
// ---------------------------------------------------------------------------

describe('sandbox / memory', () => {
  it('holds 200 MB in process without complaint', async () => {
    const out = await runProbe(ctx({ mode: 'alloc', sizeMb: 200 }));
    assert.equal(findings(out)['allocated'], '200MB');
  });

  it('stops the same allocation under a 128 MiB cap, and reports it', async () => {
    const out = await host.run(program({ memMb: 128 }), ctx({ mode: 'alloc', sizeMb: 2000 }));
    assert.equal(out.result.status, 'FAIL');
    assert.match(
      text(out),
      /\[memory\] probe: ran out of memory under its declared limit of 128 MiB/,
    );
    assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
  });

  it('allows an allocation under the cap', async () => {
    const out = await host.run(program({ memMb: 512 }), ctx({ mode: 'alloc', sizeMb: 64 }));
    assert.equal(out.result.status, 'PASS', text(out));
    assert.equal(findings(out)['allocated'], '64MB');
  });

  it('kills off-heap growth the V8 heap cap cannot see', { skip: !IS_LINUX }, async () => {
    // 1.5 GB of Buffers against a 64 MiB cap (+256 MiB of runtime headroom).
    const out = await host.run(program({ memMb: 64 }), ctx({ mode: 'buffer', sizeMb: 1536 }));
    assert.equal(out.result.status, 'FAIL');
    assert.match(text(out), /\[memory\] probe: exceeded its declared memory budget of 64 MiB/);
  });

  it(
    "can read a process's resident size, which is what the off-heap check rests on",
    { skip: !IS_LINUX },
    () => {
      const rss = readRssBytes(process.pid);
      assert.ok(rss !== undefined && rss > 10 * 1024 * 1024, `rss ${String(rss)}`);
      assert.equal(readRssBytes(2 ** 22 + 12345), undefined);
    },
  );
});

// ---------------------------------------------------------------------------
// 7. Provenance ceiling, scope, and what a result may look like
// ---------------------------------------------------------------------------

describe('sandbox / result', () => {
  it('lets an EXTRACTED node through in process, and rejects it under an INFERRED ceiling', async () => {
    const inProc = await runProbe(ctx({ mode: 'ceiling', provenance: 'EXTRACTED' }));
    assert.equal(
      inProc.nodes[0]?.provenance,
      'EXTRACTED',
      'precondition: nothing in the extractor stops it',
    );

    const out = await host.run(
      program({ provenanceCeiling: 'INFERRED' }),
      ctx({ mode: 'ceiling', provenance: 'EXTRACTED' }),
    );
    assert.equal(out.result.status, 'FAIL');
    assert.match(
      text(out),
      /\[provenance-ceiling\] probe: extractor probe asserted provenance EXTRACTED above its declared ceiling INFERRED/,
    );
    assert.deepEqual([out.nodes.length, out.edges.length], [0, 0], 'the node was not passed on');
  });

  it('rejects an EXTRACTED edge under an INFERRED ceiling', async () => {
    const out = await host.run(
      program({ provenanceCeiling: 'INFERRED' }),
      ctx({ mode: 'ceiling', provenance: 'EXTRACTED', on: 'edge' }),
    );
    assert.equal(out.result.status, 'FAIL');
    assert.match(text(out), /\[provenance-ceiling\]/);
  });

  it('accepts a claim at or below the ceiling', async () => {
    const at = await host.run(
      program({ provenanceCeiling: 'INFERRED' }),
      ctx({ mode: 'ceiling', provenance: 'INFERRED' }),
    );
    assert.equal(at.result.status, 'PASS', text(at));
    assert.equal(at.nodes.length, 1);
    const below = await host.run(
      program({ provenanceCeiling: 'EXTRACTED' }),
      ctx({ mode: 'ceiling', provenance: 'INFERRED' }),
    );
    assert.equal(below.result.status, 'PASS', text(below));
  });

  it('rejects a result that claims authority over a scope its manifest does not produce', async () => {
    const out = await host.run(program(), ctx({ mode: 'scope' }));
    assert.equal(out.result.status, 'FAIL');
    assert.match(text(out), /\[scope-undeclared\] probe: claimed authority over scope "code\.ts"/);
  });

  it('rejects a node whose kind is not in the ontology, before the store sees it', async () => {
    const bogus = await host.run(program(), ctx({ mode: 'kind', kind: 'Bogus' }));
    assert.equal(bogus.result.status, 'FAIL');
    assert.match(
      text(bogus),
      /\[protocol\] probe: sent a malformed framed result: SIF line \d+: node.kind:/,
    );
    assert.match(text(bogus), /"Bogus"/);
    assert.equal(bogus.nodes.length, 0, 'nothing the child emitted is kept');
    // A real kind passes, including one outside the manifest's own: a contribution claims no authority.
    for (const kind of ['File', 'Table']) {
      const ok = await host.run(program(), ctx({ mode: 'kind', kind }));
      assert.equal(ok.result.status, 'PASS', text(ok));
    }
  });

  it('rejects an authoritative selector that does not compile, and accepts one that does', async () => {
    const bad = await host.run(program(), ctx({ mode: 'selector', selector: '' }));
    assert.equal(bad.result.status, 'FAIL');
    assert.match(text(bad), /\[protocol\] probe: sent a malformed result: .*selector/);
    const fine = await host.run(program(), ctx({ mode: 'selector', selector: 'src/**/*.ts' }));
    assert.equal(fine.result.status, 'PASS', text(fine));
  });

  it('carries canonical authority through a real worker without certifying a neighbouring fresh fact', async () => {
    const selector = encodeCanonicalSelector({ path: 'src/a.txt', rules: [['exact', 'src/a.txt']] });
    const output = await host.run(program(), ctx({ mode: 'canonical', selector }));
    assert.equal(output.result.status, 'PASS', text(output));
    assert.equal(output.result.authoritative[0]?.selector, selector);
    assert.equal(output.nodes.length, 2);
    const current = currentObservationOf(makeRun('run-1', [output.result], 'probe'));
    const known = output.nodes.find(node => node.path === 'src/a.txt');
    const neighbour = output.nodes.find(node => node.path === 'src/b.txt');
    assert.ok(known !== undefined && neighbour !== undefined);
    assert.equal(current('probe', known), true);
    assert.equal(current('probe', neighbour), false);
  });

  it('refuses a response larger than its cap, and accepts one under it', async () => {
    const capped = createSandboxHost({ env: process.env, maxResponseBytes: 1024 * 1024 });
    const over = await capped.run(program(), ctx({ mode: 'big', bytes: 2 * 1024 * 1024 }));
    assert.equal(over.result.status, 'FAIL');
    assert.match(text(over), /\[protocol\] probe: sent a result larger than 1 MiB/);
    assert.equal(over.nodes.length, 0);
    const under = await capped.run(program(), ctx({ mode: 'big', bytes: 100 * 1024 }));
    assert.equal(under.result.status, 'PASS', text(under));
  });

  it('does not run an extractor at all on a Node with no permission model', async () => {
    let started = 0;
    const old = createSandboxHost({
      env: process.env,
      permissionModel: () => false,
      spawn: () => {
        started += 1;
        throw new Error('a child must not be started without the permission model');
      },
    });
    const out = await old.run(program(), ctx({ mode: 'ok', path: 'src/a.txt' }));
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.match(text(out), /no permission model/);
    assert.equal(started, 0, 'nothing ran unconfined');
    assert.deepEqual(out.result.authoritative, [{ scope: 'probe', kinds: ['File'] }]);
  });

  it('rejects a malformed result', async () => {
    const out = await host.run(program(), ctx({ mode: 'malformed' }));
    assert.equal(out.result.status, 'FAIL');
    assert.match(text(out), /\[protocol\] probe: sent a malformed result/);
  });

  it('reports a crash, with the exit code, as FAIL', async () => {
    const out = await host.run(program(), ctx({ mode: 'exit', code: 7 }));
    assert.equal(out.result.status, 'FAIL');
    assert.match(text(out), /\[crash\] probe: exited with code 7 without delivering a result/);
    assert.deepEqual(out.result.diagnostics, ['[crash] probe: exited with code 7 without delivering a result']);
  });

  it('reports an extractor that throws as FAIL, with its message', async () => {
    const out = await host.run(
      program(),
      ctx({ mode: 'throw', message: 'schema parser exploded' }),
    );
    assert.equal(out.result.status, 'FAIL');
    assert.equal(out.result.diagnostics[0], 'schema parser exploded');
  });

  it('does not take stdout or stderr for a result', async () => {
    const out = await host.run(program(), ctx({ mode: 'chatty' }));
    assert.equal(out.result.status, 'PASS', text(out));
    assert.equal(findings(out)['outcome'], 'quiet result');
  });

  it('degraded results name the scopes the manifest produces, so the UNKNOWN machinery sees them', async () => {
    const out = await host.run(program(), ctx({ mode: 'exit' }));
    assert.deepEqual(out.result.authoritative, [{ scope: 'probe', kinds: ['File'] }]);
    assert.equal(out.result.extractor, 'probe');
    assert.equal(out.result.durationMs, 0, 'deterministic runs report no wall clock');
  });
});

// ---------------------------------------------------------------------------
// 8. Positive control and setup failures
// ---------------------------------------------------------------------------

describe('sandbox / well-behaved extractor', () => {
  it('passes under the sandbox with output identical to the in-process run', async () => {
    const inProc = await runProbe(ctx({ mode: 'ok', path: join(repo, 'src', 'a.txt') }));
    const out = await host.run(program(), ctx({ mode: 'ok', path: 'src/a.txt' }));
    assert.equal(out.result.status, 'PASS', text(out));
    assert.equal(out.nodes.length, 1);
    // Same node, same digest of the same file: only the path the probe was asked about differs.
    assert.equal(out.nodes[0]?.props['digest'], inProc.nodes[0]?.props['digest']);
    const normalise = (o: ExtractorOutput, path: string) =>
      JSON.parse(JSON.stringify(o).split(path).join('P')) as unknown;
    assert.deepEqual(normalise(out, 'src/a.txt'), normalise(inProc, join(repo, 'src', 'a.txt')));
  });
});

describe('sandbox / setup failures are UNAVAILABLE, never a silent in-process run', () => {
  it('reports UNAVAILABLE when the child cannot be started', async () => {
    const out = await createSandboxHost({
      env: process.env,
      nodeBinary: join(root, 'no-such-node'),
    }).run(program(), ctx({ mode: 'ok', path: 'src/a.txt' }));
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.match(text(out), /sandbox could not be started/);
  });

  it('reports UNAVAILABLE when spawning throws', async () => {
    const out = await createSandboxHost({
      env: process.env,
      spawn: () => {
        throw new Error('EPERM: no processes for you');
      },
    }).run(program(), ctx({ mode: 'ok', path: 'src/a.txt' }));
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.deepEqual([out.nodes.length, out.edges.length], [0, 0]);
  });

  it('refuses a repository path the permission flag cannot express safely', async () => {
    const wild = join(root, 'we*ird');
    mkdirSync(join(wild, 'src'), { recursive: true });
    writeFileSync(join(wild, 'src', 'a.txt'), 'x');
    const out = await host.run(program(), {
      ...ctx({ mode: 'ok', path: 'src/a.txt' }),
      repoRoot: wild,
    });
    assert.equal(out.result.status, 'UNAVAILABLE');
    assert.match(text(out), /reads "\*" as a wildcard/);
  });

  it('produces no files of its own: the scratch HOME is gone afterwards', async () => {
    // A directory made for this test and given to the host, so that a sandbox started by another
    // process in the shared temporary directory (a second test run, `seamline extract` in another
    // terminal) cannot be mistaken for a leak from this one.
    const scratchRoot = mkdtempSync(join(tmpdir(), 'seamline-sbx-scratch-'));
    try {
      const own = createSandboxHost({ env: process.env, rssPollMs: 20, scratchRoot });
      const out = await own.run(program(), ctx({ mode: 'env', names: ['HOME'] }));
      assert.equal(out.result.status, 'PASS', text(out));
      // The probe was in a synthetic HOME made under the directory given to the host ...
      assert.ok(
        findings(out)['env.HOME']?.startsWith(join(scratchRoot, 'seamline-sandbox-')),
        `the child's HOME was ${findings(out)['env.HOME']}`,
      );
      // ... and it is gone, with nothing left beside it.
      assert.deepEqual(readdirSync(scratchRoot), []);
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});

describe('sandbox / observation', () => {
  it(
    'records the violation codes a run was judged on, and whether it failed closed on looks alone',
    { skip: !symlinks },
    async () => {
      // Looks only: lists and stats a directory that is a link out of the repo, and opens nothing.
      const look = await host.run(program(), ctx({ mode: 'list', paths: ['src/dir-out'] }));
      assert.equal(look.result.status, 'FAIL');
      assert.deepEqual(observationOf(look), {
        ran: true,
        violations: ['symlink-escape'],
        probeOnly: true,
      });
      // The same code reached by opening a file through a link out: a content refusal.
      const read = await host.run(program(), ctx({ mode: 'read', paths: ['src/link-out.txt'] }));
      assert.equal(read.result.status, 'FAIL');
      assert.deepEqual(observationOf(read), {
        ran: true,
        violations: ['symlink-escape'],
        probeOnly: false,
      });
    },
  );

  it('records nothing for a run that completed, and ran:false for one that was never started', async () => {
    const ok = await host.run(program(), ctx({ mode: 'ok', path: 'src/a.txt' }));
    assert.equal(ok.result.status, 'PASS');
    assert.deepEqual(observationOf(ok), { ran: true, violations: [], probeOnly: false });
    // A copy of the output is a different object and carries no observation.
    assert.equal(observationOf({ ...ok }), undefined);

    const refused = await host.run(program({ net: true as never }), ctx({ mode: 'ok' }));
    assert.equal(refused.result.status, 'UNAVAILABLE');
    assert.deepEqual(observationOf(refused), { ran: false, violations: [], probeOnly: false });
  });

  it('judges a timeout as a violation that is not a look', async () => {
    const slow = await host.run(program({ timeoutS: 1 }), ctx({ mode: 'busy' }));
    assert.equal(slow.result.status, 'FAIL');
    assert.deepEqual(observationOf(slow), { ran: true, violations: ['timeout'], probeOnly: false });
  });
});
