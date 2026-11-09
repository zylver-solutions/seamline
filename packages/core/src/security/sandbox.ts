/**
 * Extractor sandbox. Design v3 section 2.7.
 *
 * The plugin contract is third-party code execution by design, and v2 specified
 * no sandbox while planning for community extractors. The capability manifest
 * in `ExtractorManifest` is enforced here, at runtime, rather than described in
 * a plugin-authoring guide.
 *
 * What this module provides:
 *
 * | control            | mechanism                                              |
 * |--------------------|--------------------------------------------------------|
 * | environment        | allow-list intersected with a forbidden-name deny pass |
 * | read paths         | repo-relative, declared-glob, realpath containment      |
 * | wallclock          | AbortSignal + rejection at `timeoutS`                   |
 * | memory             | RSS sampling in-process; hard cap via child-process args|
 * | provenance ceiling | `assertWithinCeiling` on every emitted node and edge    |
 * | network            | `net` is `false` in the type; asserted in the manifest  |
 *
 * This module is the policy, not the enforcement point. `seamline extract`
 * enforces it by running every extractor in a child process built from
 * `sandboxSpawnOptions`, with the Node permission model as a floor and the
 * `createAccessChecker` decisions installed as a guard inside that child (see
 * `packages/cli/src/sandbox/` and THREATMODEL.md, control C4).
 *
 * The memory control is the weakest of the six and is documented as such: a V8
 * heap cannot be hard-capped from inside the same isolate, so `runWithinBudget`
 * samples RSS and aborts, while `sandboxSpawnOptions` supplies the
 * `--max-old-space-size` and cwd/env a host runner needs to get a real cap by
 * running the extractor in a child process.
 */

import { realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { posix as posixPath } from 'node:path';
import { assertWithinCeiling } from '@seamline/ontology';
import type { ExtractorManifest, Provenance, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { compiledSelectorOf } from '../store/scope-selector.ts';
import { assertCanonicalSelectorBudget } from '../store/canonical-selector.ts';

export const SANDBOX_VIOLATIONS = [
  'manifest-invalid',
  'env-forbidden',
  'path-non-posix',
  'path-absolute',
  'path-escape',
  'path-not-declared',
  'symlink-escape',
  'timeout',
  'memory',
  /** A socket, DNS lookup, `fetch` or server was attempted. `net` is `false`. */
  'network',
  /** A child process was started without a host grant for that binary. */
  'exec',
  /** A write to the filesystem was attempted. Extractors are read-only. */
  'fs-write',
  /** An emitted node or edge claimed a provenance above the manifest ceiling. */
  'provenance-ceiling',
  /** A result claimed an authoritative scope or edge scope the manifest does not produce. */
  'scope-undeclared',
  /** The extractor process ended without delivering a result. */
  'crash',
  /** The extractor's result was missing, malformed, or over the size cap. */
  'protocol',
] as const;
export type SandboxViolationCode = (typeof SANDBOX_VIOLATIONS)[number];

export class SandboxViolation extends Error {
  readonly code: SandboxViolationCode;
  readonly extractor: string;
  /** The message without its `[code] extractor:` prefix, for a caller that formats its own. */
  readonly detail: string;
  constructor(code: SandboxViolationCode, extractor: string, message: string) {
    super(`[${code}] ${extractor}: ${message}`);
    this.name = 'SandboxViolation';
    this.code = code;
    this.extractor = extractor;
    this.detail = message;
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * The only variables an extractor sees without asking. Deliberately does not
 * include `HOME`: `HOME` is how `~/.aws/credentials`, `~/.kube/config`,
 * `~/.docker/config.json`, `~/.npmrc` and the SOPS age keyring are found, so a
 * sandboxed process gets a synthetic one from `sandboxSpawnOptions` instead.
 */
export const SANDBOX_BASE_ENV: ReadonlyArray<string> = ['PATH', 'LANG', 'LC_ALL', 'TZ'];

/**
 * Names refused even when a manifest asks for them. This is the second pass,
 * not the primary control - the primary control is that only `SANDBOX_BASE_ENV`
 * plus `manifest.env` are considered at all. It exists because a plausible
 * manifest (`env: ["AWS_REGION"]`) is how the surface widens one review at a
 * time.
 */
export const FORBIDDEN_ENV_PATTERNS: ReadonlyArray<RegExp> = [
  /^AWS_/,
  /^AZURE_/,
  /^GOOGLE_/,
  /^GCP_/,
  /^KUBE/,
  /^SOPS/,
  /^AGE_/,
  /AGE_KEY/,
  /^GNUPGHOME$/,
  /^GPG_/,
  /^VAULT_/,
  /^DOCKER_/,
  /^NPM_TOKEN$/,
  // Variables that change how the runtime loads or runs code, or that name a credential by what it
  // is. Broad on purpose: this is the second pass, and a variable that is wrongly removed costs a
  // manifest review, while one that is wrongly kept is a credential or a code-loading hook.
  /^NODE_/,
  /^LD_/,
  /^DYLD_/,
  /SECRET/,
  /TOKEN/,
  /PASS/,
  /PWD/,
  /AUTH/,
  /COOKIE/,
  /CREDENTIAL/,
  /PRIVATE/,
  /ACCESS_KEY/,
  /_URL$/,
  /_URI$/,
  /DSN$/,
  /^GH_/,
  /^GITHUB_TOKEN$/,
  /^GITLAB_/,
  /^SSH_AUTH_SOCK$/,
  /^HOME$/,
  /^USERPROFILE$/,
  /^NETRC$/,
  /_TOKEN$/,
  /^TOKEN$/,
  /_SECRET$/,
  /^SECRET$/,
  /_KEY$/,
  /^KEY$/,
  /_KEY_FILE$/,
  /_PASSWORD$/,
  /^PASSWORD$/,
  /_CREDENTIAL$/,
  /_CREDENTIALS$/,
  /_PASSPHRASE$/,
];

export interface StrippedVar {
  readonly name: string;
  /** `not-allow-listed` or `forbidden-name`. Never carries the value. */
  readonly reason: 'not-allow-listed' | 'forbidden-name';
}

export interface ScrubbedEnv {
  readonly env: Readonly<Record<string, string>>;
  readonly stripped: ReadonlyArray<StrippedVar>;
}

export function isForbiddenEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return FORBIDDEN_ENV_PATTERNS.some((re) => re.test(upper));
}

/**
 * Build the environment an extractor is allowed to see.
 *
 * Allow-list first: a variable survives only if it is in `SANDBOX_BASE_ENV` or
 * in `manifest.env`. Then the deny pass removes anything credential-shaped even
 * if the manifest asked for it.
 */
export function scrubEnvironment(
  manifest: ExtractorManifest,
  source: Readonly<Record<string, string | undefined>> = process.env,
): ScrubbedEnv {
  const requested = new Set<string>([...SANDBOX_BASE_ENV, ...manifest.env]);
  const env: Record<string, string> = {};
  const stripped: StrippedVar[] = [];
  for (const name of Object.keys(source).sort()) {
    const value = source[name];
    if (value === undefined) continue;
    if (!requested.has(name)) {
      stripped.push({ name, reason: 'not-allow-listed' });
      continue;
    }
    if (isForbiddenEnvName(name)) {
      stripped.push({ name, reason: 'forbidden-name' });
      continue;
    }
    env[name] = value;
  }
  return { env, stripped };
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

/**
 * Minimal glob to RegExp. Supports `**`, `*`, `?`, `{a,b}` and `[abc]`, which
 * is the whole surface a `reads` declaration needs. No dependency: every
 * runtime dependency is a supply-chain liability this project has publicly
 * committed to minimising (v3 section 10).
 */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === '*') {
      const isDouble = glob[i + 1] === '*';
      if (isDouble) {
        if (glob[i + 2] === '/') {
          out += '(?:[^/]*/)*'; // `**/` spans zero or more directories
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close > i) {
        const alts = glob.slice(i + 1, close).split(',');
        out += `(?:${alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close + 1;
        continue;
      }
    }
    if (c === '[') {
      const close = glob.indexOf(']', i);
      if (close > i) {
        out += glob.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  // A directory glob such as `src/**` also admits `src` itself.
  return new RegExp(`${out}$`);
}

export function matchesReads(manifest: ExtractorManifest, relPath: string): boolean {
  return manifest.reads.some((g) => globToRegExp(g).test(relPath));
}

/** `fs.realpathSync.native` where it exists: it resolves through libc and so also works from inside a permission-restricted process. */
function nativeRealpath(p: string): string {
  const native = (realpathSync as typeof realpathSync & { native?: (p: string) => string }).native;
  return native === undefined ? realpathSync(p) : native(p);
}

/**
 * realpath of the nearest existing ancestor, so a not-yet-created file still
 * gets checked.
 *
 * Only "does not exist" walks up. Any other failure (permission, a symlink
 * loop) is rethrown: walking up on an arbitrary error would answer with the
 * realpath of an ancestor that is inside the repo while the path itself leads
 * somewhere else, which turns a failure to look into an "inside" verdict.
 */
function realpathOfNearestExisting(
  abs: string,
  realpath: (p: string) => string = nativeRealpath,
): string {
  let candidate = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpath(candidate);
      return tail.length === 0 ? real : resolve(real, ...tail.reverse());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = dirname(candidate);
      if (parent === candidate) return abs;
      tail.push(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Validate and resolve one read request.
 *
 * Rejects, in order: a backslash or NUL (not a POSIX repo path), an absolute or
 * drive-qualified path, a normalised path that leaves the repo, a path no
 * declared `reads` glob admits, and finally a path whose realpath escapes the
 * repo root - which is the symlink case, and the reason the check is done after
 * the glob rather than instead of it.
 *
 * Returns the absolute, symlink-resolved path the host may open.
 */
export function resolveReadPath(
  manifest: ExtractorManifest,
  repoRoot: string,
  requested: string,
): string {
  const name = manifest.name;
  if (requested.includes('\\') || requested.includes('\0')) {
    throw new SandboxViolation(
      'path-non-posix',
      name,
      `read path is not a POSIX repo path: ${JSON.stringify(requested)}`,
    );
  }
  if (isAbsolute(requested) || posixPath.isAbsolute(requested) || /^[A-Za-z]:/.test(requested)) {
    throw new SandboxViolation(
      'path-absolute',
      name,
      `read path must be repo-relative, got ${requested}`,
    );
  }
  const normalised = posixPath.normalize(requested);
  if (normalised === '..' || normalised.startsWith('../') || normalised.includes('/../')) {
    throw new SandboxViolation(
      'path-escape',
      name,
      `read path escapes the repo root: ${requested}`,
    );
  }
  if (!matchesReads(manifest, normalised)) {
    throw new SandboxViolation(
      'path-not-declared',
      name,
      `${normalised} matches no declared reads glob (${manifest.reads.join(', ')})`,
    );
  }
  let realRoot: string;
  let target: string;
  try {
    realRoot = realpathOfNearestExisting(resolve(repoRoot));
    target = realpathOfNearestExisting(resolve(realRoot, normalised));
  } catch (e) {
    // Fail closed: a path that cannot be resolved cannot be shown to be inside.
    throw new SandboxViolation(
      'symlink-escape',
      name,
      `${normalised} could not be resolved (${(e as NodeJS.ErrnoException).code ?? 'unknown error'})`,
    );
  }
  if (target !== realRoot && !target.startsWith(realRoot + sep)) {
    throw new SandboxViolation(
      'symlink-escape',
      name,
      `${normalised} resolves outside the repo root after following symlinks`,
    );
  }
  return target;
}

// ---------------------------------------------------------------------------
// Access checker (the decision a runtime guard makes on every filesystem call)
// ---------------------------------------------------------------------------

/**
 * `read`  opens the content of a file. Needs a declared `reads` glob.
 * `probe` looks at metadata or a directory listing (stat, readdir, realpath,
 *         access, exists). Needs only containment: a glob names file content,
 *         and a walker has to be able to list a directory to find the files
 *         its globs admit.
 */
export type AccessKind = 'read' | 'probe';

export interface AccessPolicy {
  readonly manifest: ExtractorManifest;
  /** Absolute repository root, as the host named it. */
  readonly repoRoot: string;
  /**
   * Absolute directories the extractor's own code is loaded from (the
   * extractor, Seamline's libraries, the TypeScript compiler). Readable
   * without a glob: they are the program, not the repository.
   */
  readonly codeRoots: ReadonlyArray<string>;
}

export type AccessDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly violation: SandboxViolation;
      /**
       * True when the path was named inside the repository (so a symlink led
       * out of it, or no glob admits it). False for a path that was never
       * under the repo root: a stray look at the world outside it.
       */
      readonly namedInsideRepo: boolean;
    };

export interface AccessChecker {
  check(requested: string, kind: AccessKind, cwd: string): AccessDecision;
}

export interface AccessIo {
  /** Symlink-resolving realpath; must throw ENOENT/ENOTDIR for a missing path. */
  readonly realpath: (p: string) => string;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * The decision procedure, as a pure function of the policy and the filesystem
 * `io` it is given.
 *
 * A runtime guard that wraps `node:fs` must hand in the *unwrapped* `realpath`,
 * otherwise deciding recurses into the guard it is part of.
 *
 * Order matters and is the reason the codes differ:
 *  0. Decided from the name alone, with no filesystem call, because they are the names the
 *     host never granted: a path under neither the repo nor a code root is `path-escape`,
 *     and any path in the repo is `path-not-declared` when the manifest declares no reads.
 *     This keeps the verdict the same on every Node version, whether or not its permission
 *     model lets a process resolve a path it was not granted.
 *  1. The real path (symlinks followed) is inside a code root: allowed.
 *  2. The real path is not inside the repo: `symlink-escape` if the request
 *     named a path inside the repo (a link led out), else `path-escape`.
 *  3. A probe inside the repo is allowed.
 *  4. A content read needs a declared glob to admit the requested name, and
 *     the symlink-resolved name too: a link must not launder an undeclared
 *     file through a declared name.
 */
export function createAccessChecker(
  policy: AccessPolicy,
  io: AccessIo = { realpath: nativeRealpath },
): AccessChecker {
  const name = policy.manifest.name;
  const lexicalRoot = resolve(policy.repoRoot);
  // An extractor that declares no reads is not allowed to look at the repo root at all, and a
  // permission-restricted runtime may refuse even to resolve it. It stays as named in that case:
  // nothing inside it is readable then, and a name that cannot be matched is denied, not allowed.
  const realRoot = (() => {
    try {
      return realpathOfNearestExisting(lexicalRoot, io.realpath);
    } catch {
      return lexicalRoot;
    }
  })();
  // A code root is a directory the host named, usually already canonical, and it may not exist (a
  // `node_modules` the resolver probes and finds absent). Resolve it directly rather than by walking
  // up to an ancestor, which a permission-restricted process may not be allowed to look at; if it
  // cannot be resolved it stays as named, which can only make it match less, never more.
  const codeRoots = policy.codeRoots.map((r) => {
    const abs = resolve(r);
    try {
      return io.realpath(abs);
    } catch {
      return abs;
    }
  });
  const cache = new Map<string, AccessDecision>();
  const ALLOWED: AccessDecision = { allowed: true };

  const display = (abs: string): string => {
    const relLexical = isInside(lexicalRoot, abs)
      ? relative(lexicalRoot, abs)
      : relative(realRoot, abs);
    return toPosix(relLexical === '' ? '.' : relLexical);
  };

  const decide = (abs: string, kind: AccessKind): AccessDecision => {
    const namedInsideRepo = isInside(lexicalRoot, abs) || isInside(realRoot, abs);
    const inCodeRoot = codeRoots.some((root) => isInside(root, abs));

    // A name the process was never granted is settled from the name alone, before any filesystem
    // call. Whether the runtime may even resolve such a path depends on its version (Node 24
    // refuses `realpath` of an ungranted path with ERR_ACCESS_DENIED, Node 22 answers it), so
    // resolving first would make the verdict depend on the Node that happens to run.
    if (!namedInsideRepo && !inCodeRoot) {
      return {
        allowed: false,
        namedInsideRepo: false,
        violation: new SandboxViolation(
          'path-escape',
          name,
          `${display(abs)} is outside the repo root`,
        ),
      };
    }
    if (namedInsideRepo && !inCodeRoot && policy.manifest.reads.length === 0) {
      // Nothing is declared, so the host grants no read access to the repo at all: neither a
      // content read nor a look at metadata.
      return {
        allowed: false,
        namedInsideRepo: true,
        violation: new SandboxViolation(
          'path-not-declared',
          name,
          `${display(abs)} matches no declared reads glob (none declared)`,
        ),
      };
    }

    let real: string;
    try {
      real = realpathOfNearestExisting(abs, io.realpath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? 'unknown error';
      return {
        allowed: false,
        namedInsideRepo,
        violation: new SandboxViolation(
          namedInsideRepo ? 'symlink-escape' : 'path-escape',
          name,
          `${display(abs)} could not be resolved (${code}); a path that cannot be resolved cannot be shown to be inside the repo`,
        ),
      };
    }
    if (codeRoots.some((root) => isInside(root, real))) return ALLOWED;
    if (!isInside(realRoot, real)) {
      return {
        allowed: false,
        namedInsideRepo,
        violation: new SandboxViolation(
          namedInsideRepo ? 'symlink-escape' : 'path-escape',
          name,
          namedInsideRepo
            ? `${display(abs)} resolves outside the repo root after following symlinks`
            : `${display(abs)} is outside the repo root`,
        ),
      };
    }
    if (kind === 'probe') return ALLOWED;
    const requestedRel = isInside(lexicalRoot, abs)
      ? toPosix(relative(lexicalRoot, abs))
      : toPosix(relative(realRoot, abs));
    const realRel = toPosix(relative(realRoot, real));
    if (!matchesReads(policy.manifest, requestedRel)) {
      return {
        allowed: false,
        namedInsideRepo: true,
        violation: new SandboxViolation(
          'path-not-declared',
          name,
          `${requestedRel} matches no declared reads glob (${policy.manifest.reads.join(', ') || 'none declared'})`,
        ),
      };
    }
    if (realRel !== requestedRel && !matchesReads(policy.manifest, realRel)) {
      return {
        allowed: false,
        namedInsideRepo: true,
        violation: new SandboxViolation(
          'path-not-declared',
          name,
          `${requestedRel} is a symlink to ${realRel}, which matches no declared reads glob (${policy.manifest.reads.join(', ') || 'none declared'})`,
        ),
      };
    }
    return ALLOWED;
  };

  return {
    check(requested, kind, cwd) {
      const abs = resolve(cwd, requested);
      const key = `${kind}\0${abs}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const decision = decide(abs, kind);
      cache.set(key, decision);
      return decision;
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

export interface HostLimits {
  readonly maxMemMb: number;
  readonly maxTimeoutS: number;
}

export const DEFAULT_HOST_LIMITS: HostLimits = Object.freeze({ maxMemMb: 2048, maxTimeoutS: 300 });

/**
 * Resolved once, near the top, rather than read inline at each call site: a
 * `DEFAULT_` name is a claim that a real override exists.
 */
export function resolveHostLimits(overrides?: Partial<HostLimits>): HostLimits {
  return {
    maxMemMb: overrides?.maxMemMb ?? DEFAULT_HOST_LIMITS.maxMemMb,
    maxTimeoutS: overrides?.maxTimeoutS ?? DEFAULT_HOST_LIMITS.maxTimeoutS,
  };
}

export function validateManifest(
  manifest: ExtractorManifest,
  overrides?: Partial<HostLimits>,
): void {
  const limits = resolveHostLimits(overrides);
  const fail = (msg: string): never => {
    throw new SandboxViolation('manifest-invalid', manifest.name, msg);
  };
  if (manifest.name.length === 0) fail('name must not be empty');
  if (manifest.version.length === 0) fail('version must not be empty');
  // `net` is `false` in the type, but a manifest loaded from JSON is not
  // type-checked at the boundary; assert the value that was actually parsed.
  if ((manifest.net as unknown) !== false) fail('net must be false; there is no opt-in in v0.1');
  // An empty `reads` declares that the extractor reads no repository file (the
  // inference pass reads the merged graph and nothing else). It never means
  // "everything": `matchesReads` admits no path against an empty list.
  for (const g of manifest.reads) {
    if (posixPath.isAbsolute(g) || /^[A-Za-z]:/.test(g) || g.includes('\\')) {
      fail(`reads glob must be repo-relative POSIX, got ${g}`);
    }
    if (g === '..' || g.startsWith('../') || g.includes('/../')) {
      fail(`reads glob escapes the repo root: ${g}`);
    }
  }
  for (const e of manifest.env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)) fail(`env entry is not a variable name: ${e}`);
    if (isForbiddenEnvName(e))
      fail(`env entry ${e} is on the forbidden list and can never be granted`);
  }
  if (!Number.isFinite(manifest.memMb) || manifest.memMb <= 0) fail('memMb must be positive');
  if (manifest.memMb > limits.maxMemMb) {
    fail(`memMb ${manifest.memMb} exceeds the host limit ${limits.maxMemMb}`);
  }
  if (!Number.isFinite(manifest.timeoutS) || manifest.timeoutS <= 0)
    fail('timeoutS must be positive');
  if (manifest.timeoutS > limits.maxTimeoutS) {
    fail(`timeoutS ${manifest.timeoutS} exceeds the host limit ${limits.maxTimeoutS}`);
  }
  // A selector the store cannot evaluate matches nothing, which silently turns
  // tombstoning off for that scope; refuse it here, where it is declared.
  try { assertCanonicalSelectorBudget(manifest.produces); }
  catch (error) { fail(`produces authority: ${(error as Error).message}`); }
  for (const scope of manifest.produces) {
    try { compiledSelectorOf(scope); }
    catch (error) { fail(`produces scope ${scope.scope}: ${(error as Error).message}`); }
  }
}

// ---------------------------------------------------------------------------
// Provenance ceiling
// ---------------------------------------------------------------------------

/**
 * Enforce the declared ceiling on one provenance claim. Delegates to the
 * contract's own `assertWithinCeiling` so the error text stays canonical: this
 * is enforcement, not a second implementation that could drift from it.
 */
export function guardProvenance(manifest: ExtractorManifest, p: Provenance): void {
  assertWithinCeiling(manifest, p);
}

/**
 * The gate every extractor's output passes through. `infer-join` declares a
 * ceiling of `INFERRED`, so a node it labels `EXTRACTED` throws here rather
 * than being caught, or not caught, in review.
 */
export function sealExtractorOutput(
  manifest: ExtractorManifest,
  nodes: ReadonlyArray<SeamlineNode>,
  edges: ReadonlyArray<SeamlineEdge>,
): void {
  for (const n of nodes) guardProvenance(manifest, n.provenance);
  for (const e of edges) guardProvenance(manifest, e.provenance);
}

// ---------------------------------------------------------------------------
// Wallclock and memory budget
// ---------------------------------------------------------------------------

export interface BudgetProbe {
  /** Monotonic milliseconds. Injectable so budget tests do not sleep. */
  now(): number;
  /** Resident set size in bytes. */
  rssBytes(): number;
}

export const systemProbe: BudgetProbe = {
  now: () => Number(process.hrtime.bigint() / 1_000_000n),
  rssBytes: () => process.memoryUsage().rss,
};

export interface BudgetOptions {
  readonly probe?: BudgetProbe;
  /** RSS sampling interval in ms. */
  readonly sampleMs?: number;
  /** Baseline RSS to subtract, so the budget measures the task, not the host. */
  readonly baselineRssBytes?: number;
}

export const DEFAULT_SAMPLE_MS = 50;

/**
 * Run `task` under the manifest's wallclock and memory budget.
 *
 * The wallclock cap is real: the returned promise rejects at `timeoutS` and the
 * task is handed an `AbortSignal` so a cooperative extractor can stop.
 *
 * The memory cap is **best-effort in-process**. RSS is sampled and the task is
 * aborted when it exceeds `memMb` over the baseline, but a synchronous
 * allocation loop inside one isolate cannot be pre-empted. A host that needs a
 * hard cap runs the extractor in a child process with `sandboxSpawnOptions`.
 */
export async function runWithinBudget<T>(
  manifest: ExtractorManifest,
  task: (signal: AbortSignal) => Promise<T>,
  options: BudgetOptions = {},
): Promise<T> {
  const probe = options.probe ?? systemProbe;
  const sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS;
  const baseline = options.baselineRssBytes ?? probe.rssBytes();
  const capBytes = manifest.memMb * 1024 * 1024;
  const controller = new AbortController();

  let settle: ((v: never) => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sampler: ReturnType<typeof setInterval> | null = null;

  const breach = new Promise<never>((_resolve, reject) => {
    settle = reject as unknown as (v: never) => void;
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new SandboxViolation(
          'timeout',
          manifest.name,
          `exceeded its declared wallclock budget of ${manifest.timeoutS}s`,
        ),
      );
    }, manifest.timeoutS * 1000);
    // Deliberately left ref'd (not .unref()): an unref'd timer does not count
    // as pending work, so if nothing else keeps the process alive while a
    // task hangs, the process (or a host that tracks pending work per-task,
    // such as Node's own test runner on some versions) can conclude there is
    // nothing left to wait for and move on before this timer ever fires --
    // silently skipping the enforcement this function exists to guarantee.
    // The `finally` block below always clears it as soon as the race settles,
    // so this never holds a process open longer than `manifest.timeoutS`.
    sampler = setInterval(() => {
      const used = probe.rssBytes() - baseline;
      if (used > capBytes) {
        controller.abort();
        reject(
          new SandboxViolation(
            'memory',
            manifest.name,
            `exceeded its declared memory budget of ${manifest.memMb} MiB (observed ${Math.round(used / 1024 / 1024)} MiB above baseline)`,
          ),
        );
      }
    }, sampleMs);
  });
  void settle;

  try {
    return await Promise.race([task(controller.signal), breach]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (sampler !== null) clearInterval(sampler);
    // Nothing awaits `breach` after the race resolves; mark it handled so a
    // later rejection does not surface as an unhandled rejection.
    breach.catch(() => undefined);
  }
}

export interface SandboxSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly execArgv: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly strippedEnv: ReadonlyArray<StrippedVar>;
}

/**
 * Everything a host needs to run an extractor as a child process with a real
 * memory cap. `--max-old-space-size` is what turns the sampled budget above
 * into an enforced one, and `HOME` is redirected at a scratch directory so a
 * credential helper finds nothing.
 */
function realOrSame(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * `PATH` without the entries a repository could put a program in: an empty entry or a relative one
 * (both mean the working directory, which is the repo root) and any entry inside the repo, however
 * it is spelled or linked. A bare command name is looked up through `PATH`, so an entry the repo
 * controls is a way to run a repo-supplied program that no check on the program's name sees.
 */
export function pathOutsideRepo(pathValue: string, repoRoot: string): string {
  const root = resolve(repoRoot);
  const realRoot = realOrSame(root);
  return pathValue
    .split(delimiter)
    .filter((entry) => {
      if (entry === '' || !isAbsolute(entry)) return false;
      const abs = resolve(entry);
      return !isInside(root, abs) && !isInside(realRoot, realOrSame(abs));
    })
    .join(delimiter);
}

export function sandboxSpawnOptions(
  manifest: ExtractorManifest,
  repoRoot: string,
  scratchHome: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
): SandboxSpawnOptions {
  const scrubbed = scrubEnvironment(manifest, source);
  const env: Record<string, string> = { ...scrubbed.env, HOME: resolve(scratchHome) };
  if (env['PATH'] !== undefined) {
    const safe = pathOutsideRepo(env['PATH'], repoRoot);
    if (safe === '') delete env['PATH'];
    else env['PATH'] = safe;
  }
  return {
    cwd: resolve(repoRoot),
    env,
    execArgv: [`--max-old-space-size=${manifest.memMb}`],
    timeoutMs: manifest.timeoutS * 1000,
    strippedEnv: scrubbed.stripped,
  };
}
