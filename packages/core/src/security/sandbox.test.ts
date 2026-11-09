/**
 * Sandbox tests.
 *
 * Every assertion here is about an observable outcome of enforcement: a
 * variable that is absent from the returned environment, a call that threw with
 * a specific violation code, a budget that rejected. None of them assert that a
 * function exists or that a manifest field is set - a manifest field being set
 * is exactly the v2 failure mode this module replaces.
 */

import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ExtractorManifest, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import {
  SANDBOX_BASE_ENV,
  SANDBOX_VIOLATIONS,
  SandboxViolation,
  createAccessChecker,
  globToRegExp,
  isForbiddenEnvName,
  matchesReads,
  resolveHostLimits,
  resolveReadPath,
  runWithinBudget,
  sandboxSpawnOptions,
  scrubEnvironment,
  sealExtractorOutput,
  validateManifest,
} from './sandbox.ts';

function manifest(over: Partial<ExtractorManifest> = {}): ExtractorManifest {
  return {
    name: 'extract-code-ts',
    version: '0.1.0',
    reads: ['src/**/*.ts', 'package.json'],
    net: false,
    env: ['CI'],
    memMb: 512,
    timeoutS: 30,
    provenanceCeiling: 'EXTRACTED',
    produces: [],
    ...over,
  };
}

const RUN = 'run-0001';

function node(provenance: SeamlineNode['provenance']): SeamlineNode {
  return {
    id: 'repo:File:a.ts' as SeamlineNode['id'],
    kind: 'File',
    name: 'a.ts',
    sensitivity: 'internal',
    provenance,
    confidence: 1,
    props: {},
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    deletedAt: null,
  };
}

function edge(provenance: SeamlineEdge['provenance']): SeamlineEdge {
  return {
    kind: 'MAPS_TO_FIELD',
    src: 'repo:Column:users.email' as SeamlineEdge['src'],
    dst: 'repo:CodeField:User.email' as SeamlineEdge['dst'],
    provenance,
    confidence: 0.8,
    props: {},
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    deletedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** One entry per class of credential the design names in v3 section 2.7. */
const DANGEROUS_ENV: Readonly<Record<string, string>> = {
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_SESSION_TOKEN: 'FwoGZXIvYXdzEExample',
  AWS_REGION: 'us-east-1',
  KUBECONFIG: '/home/example/.kube/config',
  KUBERNETES_SERVICE_HOST: '10.0.0.1',
  SOPS_AGE_KEY_FILE: '/home/example/.config/sops/age/keys.txt',
  SOPS_AGE_KEY: 'AGE-SECRET-KEY-1EXAMPLE',
  AGE_KEY_FILE: '/home/example/keys.txt',
  GITHUB_TOKEN: 'ghp_examplevalue000000000000000000000000',
  GH_TOKEN: 'ghp_examplevalue000000000000000000000000',
  GITLAB_TOKEN: 'glpat-example000000000',
  NPM_TOKEN: 'npm_example00000000000000000000000000',
  VAULT_TOKEN: 'hvs.example',
  DOCKER_AUTH_CONFIG: '{"auths":{}}',
  GOOGLE_APPLICATION_CREDENTIALS: '/home/example/gcp.json',
  AZURE_CLIENT_SECRET: 'example',
  MY_APP_SECRET: 'example',
  SIGNING_KEY: 'example',
  DB_PASSWORD: 'example',
  SERVICE_CREDENTIALS: 'example',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  GNUPGHOME: '/home/example/.gnupg',
  HOME: '/home/dev',
  USERPROFILE: 'C:\\Users\\dev',
};

describe('sandbox / environment scrubbing', () => {
  const source = { ...DANGEROUS_ENV, PATH: '/usr/bin', LANG: 'en_US.UTF-8', CI: 'true', EDITOR: 'vim' };

  it('removes every named credential variable from the extractor environment', () => {
    const { env } = scrubEnvironment(manifest(), source);
    for (const name of Object.keys(DANGEROUS_ENV)) {
      strictEqual(env[name], undefined, `${name} reached the extractor environment`);
    }
  });

  it('carries no credential VALUE through in any variable', () => {
    const { env } = scrubEnvironment(manifest(), source);
    doesNotMatch(JSON.stringify(env), /AKIAIOSFODNN7EXAMPLE|AGE-SECRET-KEY|ghp_|glpat-|npm_/);
  });

  it('keeps the base allow-list and the manifest-declared variable, and nothing else', () => {
    const { env } = scrubEnvironment(manifest(), source);
    deepStrictEqual(Object.keys(env).sort(), ['CI', 'LANG', 'PATH']);
    strictEqual(env['EDITOR'], undefined, 'an undeclared benign variable still leaked through');
  });

  it('does not include HOME in the base allow-list', () => {
    ok(!SANDBOX_BASE_ENV.includes('HOME'));
    ok(isForbiddenEnvName('HOME'));
  });

  it('reports each strip with a reason and never with a value', () => {
    const { stripped } = scrubEnvironment(manifest(), source);
    const byName = new Map(stripped.map((s) => [s.name, s.reason]));
    strictEqual(byName.get('AWS_SECRET_ACCESS_KEY'), 'not-allow-listed');
    strictEqual(byName.get('EDITOR'), 'not-allow-listed');
    doesNotMatch(JSON.stringify(stripped), /AKIAIOSFODNN7EXAMPLE/);
  });

  it('refuses a forbidden name even when a manifest asks for it', () => {
    // Bypasses validateManifest deliberately: this is the second line, and the
    // point is that it holds when the first is skipped.
    const greedy = { ...manifest(), env: ['AWS_REGION', 'GITHUB_TOKEN', 'CI'] } as ExtractorManifest;
    const { env, stripped } = scrubEnvironment(greedy, source);
    strictEqual(env['AWS_REGION'], undefined);
    strictEqual(env['GITHUB_TOKEN'], undefined);
    strictEqual(env['CI'], 'true');
    const byName = new Map(stripped.map((s) => [s.name, s.reason]));
    strictEqual(byName.get('AWS_REGION'), 'forbidden-name');
    strictEqual(byName.get('GITHUB_TOKEN'), 'forbidden-name');
  });

  it('refuses what the review named as credential-shaped or as a code-loading hook, even if listed', () => {
    for (const name of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'DATABASE_URL',
      'REDIS_URL',
      'DB_PASS',
      'DB_PWD',
      'BASIC_AUTH',
      'AUTH_HEADER',
      'COOKIE',
      'SECRET_KEY_BASE',
      'CLIENT_SECRET_FILE',
      'ACCESS_KEY_ID',
      'TOKEN_FILE',
      'PRIVATE_KEY_PATH',
      'SENTRY_DSN',
      'db_password',
    ]) {
      ok(isForbiddenEnvName(name), `${name} is allowed`);
    }
  });

  it('still allows the variables the bundled extractors declare, and the base allow-list', () => {
    for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'SEAMLINE_DETERMINISTIC']) {
      ok(!isForbiddenEnvName(name), `${name} is refused`);
    }
  });

  it('rejects such a manifest at validation time too', () => {
    throws(
      () => validateManifest(manifest({ env: ['AWS_REGION'] })),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'manifest-invalid',
    );
  });
});

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

describe('sandbox / read paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'seamline-sandbox-'));
  const outside = mkdtempSync(join(tmpdir(), 'seamline-outside-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(outside, 'passwd'), 'root:x:0:0\n');
  let symlinkOk = true;
  try {
    symlinkSync(join(outside, 'passwd'), join(root, 'src', 'escape.ts'));
    symlinkSync(outside, join(root, 'src', 'outdir'));
  } catch {
    symlinkOk = false;
  }
  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('admits a declared path inside the repo', () => {
    const resolved = resolveReadPath(manifest(), root, 'src/a.ts');
    ok(resolved.endsWith('/src/a.ts'), resolved);
  });

  it('rejects a traversal read', () => {
    throws(
      () => resolveReadPath(manifest({ reads: ['**'] }), root, '../../etc/passwd'),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'path-escape',
    );
    throws(
      () => resolveReadPath(manifest({ reads: ['**'] }), root, 'src/../../etc/passwd'),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'path-escape',
    );
    throws(
      () => resolveReadPath(manifest({ reads: ['**'] }), root, 'src/subdir/../../../etc/passwd'),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'path-escape',
    );
  });

  it('rejects an absolute or drive-qualified path', () => {
    for (const p of ['/etc/passwd', 'C:/Windows/System32/config/SAM']) {
      throws(
        () => resolveReadPath(manifest({ reads: ['**'] }), root, p),
        (e: unknown) => e instanceof SandboxViolation && e.code === 'path-absolute',
        `accepted ${p}`,
      );
    }
  });

  it('rejects a backslash path', () => {
    throws(
      () => resolveReadPath(manifest({ reads: ['**'] }), root, 'src\\a.ts'),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'path-non-posix',
    );
  });

  it('rejects a path inside the repo that no reads glob declares', () => {
    throws(
      () => resolveReadPath(manifest(), root, 'secrets/prod.env'),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'path-not-declared',
    );
  });

  it('rejects a symlink that escapes the repo root', { skip: !symlinkOk }, () => {
    throws(
      () => resolveReadPath(manifest({ reads: ['src/**'] }), root, 'src/escape.ts'),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'symlink-escape',
    );
  });

  it('rejects a read through a symlinked directory that escapes', { skip: !symlinkOk }, () => {
    throws(
      () => resolveReadPath(manifest({ reads: ['src/**'] }), root, 'src/outdir/passwd'),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'symlink-escape',
    );
  });
});

describe('sandbox / access checker', () => {
  const root = mkdtempSync(join(tmpdir(), 'seamline-access-'));
  const outside = mkdtempSync(join(tmpdir(), 'seamline-access-outside-'));
  const codeDir = mkdtempSync(join(tmpdir(), 'seamline-access-code-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'private'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'private', 'prod.env'), 'TOKEN=canary\n');
  writeFileSync(join(outside, 'passwd'), 'root:x:0:0\n');
  writeFileSync(join(codeDir, 'lib.js'), 'export {};\n');
  let symlinkOk = true;
  try {
    symlinkSync(join(outside, 'passwd'), join(root, 'src', 'escape.ts'));
    symlinkSync(outside, join(root, 'src', 'outdir'));
    // An in-repo link whose name is declared but whose target is not.
    symlinkSync(join(root, 'private', 'prod.env'), join(root, 'src', 'laundered.ts'));
    // A link from outside the repo into it.
    symlinkSync(join(root, 'src', 'a.ts'), join(outside, 'into-repo.ts'));
  } catch {
    symlinkOk = false;
  }
  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(codeDir, { recursive: true, force: true });
  });

  const m = manifest({ reads: ['src/**/*.ts', 'package.json'] });
  const checker = () => createAccessChecker({ manifest: m, repoRoot: root, codeRoots: [codeDir] });
  const code = (d: ReturnType<ReturnType<typeof checker>['check']>) => (d.allowed ? 'allowed' : d.violation.code);

  it('admits a declared in-repo read, by relative and by absolute name', () => {
    const c = checker();
    strictEqual(code(c.check('src/a.ts', 'read', root)), 'allowed');
    strictEqual(code(c.check(join(root, 'src', 'a.ts'), 'read', '/')), 'allowed');
  });

  it('denies an in-repo read no declared glob admits, but admits a probe of it', () => {
    const c = checker();
    strictEqual(code(c.check('private/prod.env', 'read', root)), 'path-not-declared');
    strictEqual(code(c.check('private/prod.env', 'probe', root)), 'allowed', 'stat is containment-only');
    strictEqual(code(c.check('private', 'probe', root)), 'allowed', 'a directory listing is containment-only');
  });

  it('denies an absolute path outside the repo, for reads and for probes', () => {
    const c = checker();
    const d = c.check(join(outside, 'passwd'), 'read', root);
    strictEqual(code(d), 'path-escape');
    ok(!d.allowed && d.namedInsideRepo === false);
    strictEqual(code(c.check(outside, 'probe', root)), 'path-escape');
  });

  it('denies a ../ traversal, however it is spelled', () => {
    const c = checker();
    for (const p of ['../passwd', 'src/../../passwd', 'src/./../../etc/passwd']) {
      strictEqual(code(c.check(p, 'read', root)), 'path-escape', p);
    }
  });

  it('never leaks the absolute location of what it denied', () => {
    const c = checker();
    const d = c.check(join(outside, 'passwd'), 'read', root);
    ok(!d.allowed);
    doesNotMatch(d.violation.message, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    match(d.violation.message, /\.\.\//);
  });

  it('denies a symlink inside the repo that points outside it', { skip: !symlinkOk }, () => {
    const c = checker();
    const file = c.check('src/escape.ts', 'read', root);
    strictEqual(code(file), 'symlink-escape');
    ok(!file.allowed && file.namedInsideRepo === true);
    strictEqual(code(c.check('src/escape.ts', 'probe', root)), 'symlink-escape', 'stat follows the link out');
    strictEqual(code(c.check('src/outdir/passwd', 'read', root)), 'symlink-escape');
    strictEqual(code(c.check('src/outdir', 'probe', root)), 'symlink-escape');
  });

  it('denies a declared name that is a symlink to an undeclared in-repo file', { skip: !symlinkOk }, () => {
    const d = checker().check('src/laundered.ts', 'read', root);
    strictEqual(code(d), 'path-not-declared');
    ok(!d.allowed && /symlink to private\/prod\.env/.test(d.violation.message), d.allowed ? '' : d.violation.message);
  });

  it('judges a name outside the repo by that name, even when it links into the repo', { skip: !symlinkOk }, () => {
    // Resolving into the repo does not give an outside name a declared repo path: the host never
    // granted the name, so it is refused without looking at where it leads.
    strictEqual(code(checker().check(join(outside, 'into-repo.ts'), 'read', root)), 'path-escape');
    strictEqual(code(checker().check(join(outside, 'into-repo.ts'), 'probe', root)), 'path-escape');
  });

  it('admits reads of the extractor\'s own code, which no glob names', () => {
    const c = checker();
    strictEqual(code(c.check(join(codeDir, 'lib.js'), 'read', root)), 'allowed');
    strictEqual(code(c.check(codeDir, 'probe', root)), 'allowed');
  });

  it('answers a missing path by where it would be, not as inside', () => {
    const c = checker();
    strictEqual(code(c.check('src/not-yet.ts', 'read', root)), 'allowed');
    strictEqual(code(c.check(join(outside, 'not-yet'), 'read', root)), 'path-escape');
    strictEqual(code(c.check('private/not-yet.env', 'read', root)), 'path-not-declared');
  });

  it('fails closed when the real path cannot be established', () => {
    // A realpath that fails for any reason other than "does not exist" must not
    // be answered by the realpath of an ancestor, which is inside the repo.
    const real = (p: string) => realpathSync(p);
    const denying = {
      realpath: (p: string) => {
        if (p.endsWith('unreadable.ts')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return real(p);
      },
    };
    const c = createAccessChecker({ manifest: m, repoRoot: root, codeRoots: [] }, denying);
    const d = c.check('src/unreadable.ts', 'read', root);
    strictEqual(code(d), 'symlink-escape');
    ok(!d.allowed && /EACCES/.test(d.violation.message));
  });

  it('survives a code root it cannot resolve, and still matches nothing through it', () => {
    // Under a permission-restricted runtime, looking at the ancestor of a missing directory can be refused.
    const refusing = {
      realpath: (p: string) => {
        if (p.includes('absent-modules')) throw Object.assign(new Error('denied'), { code: 'ERR_ACCESS_DENIED' });
        return realpathSync(p);
      },
    };
    const absentRoot = join(codeDir, 'absent-modules');
    const c = createAccessChecker({ manifest: m, repoRoot: root, codeRoots: [absentRoot, codeDir] }, refusing);
    strictEqual(code(c.check(join(codeDir, 'lib.js'), 'read', root)), 'allowed', 'the resolvable root still works');
    strictEqual(code(c.check(join(outside, 'passwd'), 'read', root)), 'path-escape');
  });

  it('denies everything when the repo root itself cannot be resolved, rather than failing to start', () => {
    // An extractor with no declared reads has no access to the repo root, and on some runtimes
    // not even to resolve it. The checker must still build, and must still deny.
    const refusing = {
      realpath: (p: string) => {
        if (p === root || p.startsWith(root + '/')) throw Object.assign(new Error('denied'), { code: 'ERR_ACCESS_DENIED' });
        return realpathSync(p);
      },
    };
    const c = createAccessChecker({ manifest: manifest({ reads: [] }), repoRoot: root, codeRoots: [codeDir] }, refusing);
    strictEqual(code(c.check('src/a.ts', 'read', root)), 'path-not-declared');
    strictEqual(code(c.check('src', 'probe', root)), 'path-not-declared');
    strictEqual(code(c.check(join(codeDir, 'lib.js'), 'read', root)), 'allowed');
  });

  it('asks the filesystem once per distinct path and decision, not once per call', () => {
    let calls = 0;
    const counting = {
      realpath: (p: string) => {
        calls += 1;
        return realpathSync(p);
      },
    };
    const c = createAccessChecker({ manifest: m, repoRoot: root, codeRoots: [] }, counting);
    c.check('src/a.ts', 'read', root);
    const afterFirst = calls;
    for (let i = 0; i < 50; i += 1) c.check('src/a.ts', 'read', root);
    strictEqual(calls, afterFirst);
  });

  it('with an empty reads list admits no look at the repo and no content read at all', () => {
    const c = createAccessChecker({ manifest: manifest({ reads: [] }), repoRoot: root, codeRoots: [] });
    strictEqual(code(c.check('src/a.ts', 'read', root)), 'path-not-declared');
    strictEqual(code(c.check('src', 'probe', root)), 'path-not-declared');
  });

  // Node 24 checks `realpath` against the permission model, so a path the host never granted cannot
  // even be resolved there, where Node 22 answers it. The verdict must not depend on which Node ran.
  describe('on a runtime that refuses to resolve a path it was not granted', () => {
    const permissionChecked = (granted: ReadonlyArray<string>) => ({
      realpath: (p: string) => {
        if (!granted.some((g) => p === g || p.startsWith(g + '/'))) {
          throw Object.assign(new Error('Access to this API has been restricted'), { code: 'ERR_ACCESS_DENIED' });
        }
        return realpathSync(p);
      },
    });

    it('calls an absolute path outside the repo path-escape, not a failed symlink resolution', () => {
      const c = createAccessChecker(
        { manifest: m, repoRoot: root, codeRoots: [codeDir] },
        permissionChecked([root, codeDir]),
      );
      const d = c.check(join(outside, 'passwd'), 'read', root);
      strictEqual(code(d), 'path-escape');
      ok(!d.allowed && d.namedInsideRepo === false && /is outside the repo root/.test(d.violation.detail));
      strictEqual(code(c.check(join(outside, 'passwd'), 'probe', root)), 'path-escape');
      strictEqual(code(c.check(join(root, '..', 'elsewhere', 'x'), 'probe', root)), 'path-escape');
    });

    it('calls a read in a repo with no declared reads path-not-declared, and still reads its own code', () => {
      const c = createAccessChecker(
        { manifest: manifest({ reads: [] }), repoRoot: root, codeRoots: [codeDir] },
        permissionChecked([codeDir]),
      );
      const d = c.check('src/a.ts', 'read', root);
      strictEqual(code(d), 'path-not-declared');
      ok(!d.allowed && d.namedInsideRepo === true && /none declared/.test(d.violation.detail));
      strictEqual(code(c.check('src', 'probe', root)), 'path-not-declared');
      strictEqual(code(c.check(join(codeDir, 'lib.js'), 'read', root)), 'allowed');
    });

    it('gives the verdicts a runtime that resolves everything gives', () => {
      const granted = permissionChecked([root, codeDir]);
      const open = { realpath: (p: string) => realpathSync(p) };
      for (const [request, kind] of [
        [join(outside, 'passwd'), 'read'],
        [join(outside, 'passwd'), 'probe'],
        ['src/a.ts', 'read'],
        ['private/prod.env', 'read'],
        ['private/prod.env', 'probe'],
        [join(codeDir, 'lib.js'), 'read'],
      ] as const) {
        const withPermission = createAccessChecker({ manifest: m, repoRoot: root, codeRoots: [codeDir] }, granted);
        const without = createAccessChecker({ manifest: m, repoRoot: root, codeRoots: [codeDir] }, open);
        strictEqual(code(withPermission.check(request, kind, root)), code(without.check(request, kind, root)), `${kind} ${request}`);
      }
    });
  });

  it('knows the violation codes the host and the guard raise', () => {
    for (const c of ['network', 'exec', 'fs-write', 'provenance-ceiling', 'scope-undeclared', 'crash', 'protocol']) {
      ok((SANDBOX_VIOLATIONS as ReadonlyArray<string>).includes(c), c);
    }
  });
});

describe('sandbox / globs', () => {
  it('matches what a reads declaration means and nothing wider', () => {
    const m = manifest({ reads: ['src/**/*.ts', 'package.json', 'migrations/*.sql'] });
    ok(matchesReads(m, 'src/a.ts'));
    ok(matchesReads(m, 'src/deep/nested/b.ts'));
    ok(matchesReads(m, 'package.json'));
    ok(matchesReads(m, 'migrations/0001.sql'));
    ok(!matchesReads(m, 'lib/a.ts'));
    ok(!matchesReads(m, 'src/a.js'));
    ok(!matchesReads(m, 'migrations/sub/0001.sql'));
    ok(!matchesReads(m, 'other/package.json'));
  });

  it('treats * as segment-local', () => {
    ok(globToRegExp('src/*.ts').test('src/a.ts'));
    ok(!globToRegExp('src/*.ts').test('src/deep/a.ts'));
  });

  it('supports brace alternation and single-character wildcards', () => {
    ok(globToRegExp('*.{ts,tsx}').test('a.tsx'));
    ok(!globToRegExp('*.{ts,tsx}').test('a.js'));
    ok(globToRegExp('v?.json').test('v1.json'));
    ok(!globToRegExp('v?.json').test('v10.json'));
  });
});

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

describe('sandbox / manifest validation', () => {
  it('accepts a well-formed manifest', () => {
    validateManifest(manifest());
  });

  it('rejects net: true, however it was parsed in', () => {
    const sneaky = { ...manifest(), net: true } as unknown as ExtractorManifest;
    throws(
      () => validateManifest(sneaky),
      (e: unknown) => e instanceof SandboxViolation && /net must be false/.test(e.message),
    );
  });

  it('rejects a reads glob that is absolute or escapes the repo', () => {
    for (const g of ['/etc/**', '../other/**', 'src/../../etc/**', 'C:/x/**']) {
      throws(() => validateManifest(manifest({ reads: [g] })), SandboxViolation, `accepted ${g}`);
    }
  });

  it('rejects budgets above the host limit and honours an override', () => {
    throws(() => validateManifest(manifest({ memMb: 99_999 })), SandboxViolation);
    throws(() => validateManifest(manifest({ timeoutS: 99_999 })), SandboxViolation);
    throws(() => validateManifest(manifest({ memMb: 0 })), SandboxViolation);
    validateManifest(manifest({ memMb: 4096 }), { maxMemMb: 8192 });
    strictEqual(resolveHostLimits({ maxMemMb: 8192 }).maxMemMb, 8192);
    strictEqual(resolveHostLimits().maxMemMb, 2048);
  });

  it('accepts an empty reads declaration as "reads no repository file", never as "reads everything"', () => {
    // The inference pass reads the merged graph and no repo file, so its
    // honest manifest has `reads: []`. What matters is that empty admits nothing.
    const none = manifest({ reads: [] });
    validateManifest(none);
    strictEqual(matchesReads(none, 'src/a.ts'), false);
    strictEqual(matchesReads(none, 'package.json'), false);
    throws(
      () => resolveReadPath(none, tmpdir(), 'src/a.ts'),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'path-not-declared',
    );
  });

  it('rejects a produces selector the store could not evaluate, and accepts one it can', () => {
    const prose = { scope: 'data', kinds: ['Table'], selector: '**/*.sql, **/*.prisma, Drizzle schema modules' } as const;
    throws(
      () => validateManifest(manifest({ produces: [prose] })),
      (e: unknown) =>
        e instanceof SandboxViolation &&
        e.code === 'manifest-invalid' &&
        /produces scope data: invalid authoritative-scope selector/.test(e.message),
    );
    validateManifest(manifest({ produces: [{ scope: 'code.ts', kinds: ['File'], selector: '**/*.{ts,tsx}' }] }));
    validateManifest(manifest({ produces: [{ scope: 'code.ts', kinds: ['File'] }] }));
  });
});

// ---------------------------------------------------------------------------
// Provenance ceiling
// ---------------------------------------------------------------------------

describe('sandbox / provenance ceiling', () => {
  const inferJoin = manifest({ name: 'infer-join', provenanceCeiling: 'INFERRED' });

  it('blocks infer-join from claiming EXTRACTED on a node', () => {
    throws(
      () => sealExtractorOutput(inferJoin, [node('EXTRACTED')], []),
      /extractor infer-join asserted provenance EXTRACTED above its declared ceiling INFERRED/,
    );
  });

  it('blocks infer-join from claiming DECLARED on an edge', () => {
    throws(
      () => sealExtractorOutput(inferJoin, [], [edge('DECLARED')]),
      /above its declared ceiling INFERRED/,
    );
  });

  it('allows a claim at or below the ceiling', () => {
    sealExtractorOutput(inferJoin, [node('INFERRED')], [edge('LLM_SUGGESTED')]);
  });

  it('lets an EXTRACTED-ceiling extractor assert EXTRACTED', () => {
    sealExtractorOutput(manifest(), [node('EXTRACTED')], [edge('EXTRACTED')]);
  });

  it('checks every item, not just the first', () => {
    throws(
      () => sealExtractorOutput(inferJoin, [node('INFERRED'), node('EXTRACTED')], []),
      /above its declared ceiling/,
    );
  });
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe('sandbox / budgets', () => {
  it('returns the task result when it stays inside both budgets', async () => {
    const out = await runWithinBudget(manifest(), async () => 'ok');
    strictEqual(out, 'ok');
  });

  it('rejects with a timeout violation when wallclock is exceeded', async () => {
    const m = manifest({ timeoutS: 0.05 });
    await rejects(
      runWithinBudget(m, () => new Promise<never>(() => undefined)),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'timeout',
    );
  });

  it('aborts the task signal on timeout so a cooperative extractor can stop', async () => {
    const m = manifest({ timeoutS: 0.05 });
    let aborted = false;
    await rejects(
      runWithinBudget(m, (signal) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<never>(() => undefined);
      }),
      SandboxViolation,
    );
    ok(aborted, 'the task never saw an abort');
  });

  it('rejects with a memory violation when RSS exceeds the declared budget', async () => {
    const m = manifest({ memMb: 1, timeoutS: 10 });
    let rss = 0;
    const probe = {
      now: () => 0,
      rssBytes: () => {
        rss += 4 * 1024 * 1024;
        return rss;
      },
    };
    await rejects(
      runWithinBudget(m, () => new Promise<never>(() => undefined), {
        probe,
        sampleMs: 1,
        baselineRssBytes: 0,
      }),
      (e: unknown) => e instanceof SandboxViolation && e.code === 'memory',
    );
  });

  it('does not fire the memory budget for a task that stays under it', async () => {
    const m = manifest({ memMb: 64, timeoutS: 10 });
    const probe = { now: () => 0, rssBytes: () => 1024 * 1024 };
    const out = await runWithinBudget(
      m,
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        return 'done';
      },
      { probe, sampleMs: 1, baselineRssBytes: 0 },
    );
    strictEqual(out, 'done');
  });
});

describe('sandbox / spawn options', () => {
  it('hands a host a hard memory cap, a scrubbed env and a synthetic HOME', () => {
    const opts = sandboxSpawnOptions(manifest(), '/repo', '/scratch/home', {
      ...DANGEROUS_ENV,
      PATH: '/usr/bin',
      CI: 'true',
    });
    match(opts.execArgv.join(' '), /--max-old-space-size=512/);
    strictEqual(opts.timeoutMs, 30_000);
    strictEqual(opts.env['HOME'], '/scratch/home');
    strictEqual(opts.env['AWS_SECRET_ACCESS_KEY'], undefined);
    strictEqual(opts.env['KUBECONFIG'], undefined);
    strictEqual(opts.env['CI'], 'true');
    ok(opts.strippedEnv.length > 0);
  });
});

describe('sandbox / PATH handed to a child', () => {
  const repo = mkdtempSync(join(tmpdir(), 'seamline-pathrepo-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'seamline-pathbin-'));
  mkdirSync(join(repo, 'bin'), { recursive: true });
  after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('drops empty, relative and in-repo entries, so a bare command cannot resolve to a repo file', () => {
    const entries = ['', 'bin', './bin', '../bin', join(repo, 'bin'), repo, elsewhere, '/usr/bin'];
    const { env } = sandboxSpawnOptions(manifest(), repo, '/scratch/home', {
      PATH: entries.join(delimiter),
    });
    strictEqual(env['PATH'], [elsewhere, '/usr/bin'].join(delimiter));
  });

  it('drops an outside entry that is a link into the repo', { skip: process.platform === 'win32' }, () => {
    const link = join(elsewhere, 'alias');
    symlinkSync(join(repo, 'bin'), link);
    const { env } = sandboxSpawnOptions(manifest(), repo, '/scratch/home', {
      PATH: [link, '/usr/bin'].join(delimiter),
    });
    strictEqual(env['PATH'], '/usr/bin');
  });

  it('leaves no PATH at all when nothing safe remains, rather than an empty one', () => {
    const { env } = sandboxSpawnOptions(manifest(), repo, '/scratch/home', {
      PATH: ['', 'bin', join(repo, 'bin')].join(delimiter),
    });
    strictEqual('PATH' in env, false);
  });
});
