/**
 * What a sandbox child may read, and the Node flags that say so.
 *
 * Two kinds of path are readable. The repository (only when the manifest
 * declares any `reads`), and the program's own code: the directory the CLI's
 * compiled modules live in, and the install directory of every package the
 * program loads, found by walking the same `node_modules` chain Node's
 * resolver will walk. A directory the resolver probes on the way to a package
 * has to be readable too, or Node answers "access denied" where it would have
 * said "not found" and resolution stops.
 *
 * Nothing here is a glob. `--allow-fs-read` takes paths, so the manifest's
 * `reads` globs are enforced by the in-child guard (`guard.ts`); these flags are
 * the floor underneath it.
 */

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathOutsideRepo } from '@seamline/core';

/** Raised when a sandbox cannot be established. The host reports UNAVAILABLE, never a run. */
export class SandboxSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxSetupError';
  }
}

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

function readPackageJson(dir: string): PackageJson {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    return {};
  }
}

interface Lookup {
  /** Real directory of the package, when it was found. */
  readonly found: string | undefined;
  /** Every `node_modules` directory the walk looked in, nearest first, ending at the one that held the package. */
  readonly probed: ReadonlyArray<string>;
}

/**
 * True for a name `npm` would publish: an optional `@scope/` and one name, each starting with a
 * letter or digit and made of letters, digits, `.`, `_`, `-` and `~`, at most 214 characters. So no
 * `..` or `.` segment, no separator other than the one after a scope, no drive or absolute path.
 * A `package.json` is data its author wrote; this is what stops it from naming a directory instead
 * of a package.
 */
export function isPackageName(name: string): boolean {
  return (
    name.length <= 214 &&
    /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(name)
  );
}

/** The outermost `node_modules` directory that `modules` is or is inside (pnpm keeps its store at `node_modules/.pnpm/<id>/node_modules`). */
function installRoot(modules: string): string {
  let root = modules;
  for (let dir = modules; ; dir = dirname(dir)) {
    if (basename(dir) === 'node_modules') root = dir;
    if (dirname(dir) === dir) return root;
  }
}

/**
 * Node's own walk for a bare specifier: `<dir>/node_modules/<name>` from `from` up to the
 * filesystem root. A name that is not a package name is not looked up. With `confined`, a package
 * counts only if its real directory is inside the install tree it was found in: a link out of
 * `node_modules` (a linked package, a workspace) is not followed.
 */
function lookupPackage(from: string, name: string, confined: boolean): Lookup {
  const probed: string[] = [];
  if (!isPackageName(name)) return { found: undefined, probed };
  let dir = from;
  for (;;) {
    const modules = join(dir, 'node_modules');
    probed.push(modules);
    const candidate = join(modules, name);
    if (existsSync(join(candidate, 'package.json'))) {
      const real = realpathSync(candidate);
      if (!confined || isNestedIn(realPathOrSame(installRoot(modules)), real)) {
        return { found: real, probed };
      }
      // Present, but it leads out of the install tree: as good as absent.
      return { found: undefined, probed: [] };
    }
    const parent = dirname(dir);
    if (parent === dir) return { found: undefined, probed };
    dir = parent;
  }
}

export interface CodeRoots {
  /** Absolute directories (and `package.json` files) the child's code is loaded from. */
  readonly roots: ReadonlyArray<string>;
}

/**
 * The paths a child must be able to read to load `packages` and everything they
 * depend on, starting from the CLI's own install directory.
 *
 * `buildRoot` is the directory the CLI's compiled modules sit in (`dist`, or
 * `src` when run from a checkout), `packageDir` the directory above it that
 * holds the CLI's `package.json`. A package that is a declared dependency but
 * is not installed fails the setup if it is a `dependencies` entry, and is
 * skipped if it is an optional or peer one.
 */
export function resolveCodeRoots(buildRoot: string, packages: ReadonlyArray<string>): CodeRoots {
  const packageDir = dirname(buildRoot);
  return closureRoots(packageDir, packages, [buildRoot, join(packageDir, 'package.json')], true);
}

/**
 * The install directory of each of `packages` as Node would find it from `packageDir`, with the
 * directories the lookup probed and the same for everything those packages depend on, added to
 * `start`. `required` says whether a package that cannot be found fails the setup: the top-level
 * ones, and what the packages depend on where their manifests list it under `dependencies` (an
 * optional or peer dependency is never required).
 *
 * The conformance suite uses this for a third-party extractor's own dependencies, which it can only
 * name as a best effort (`required: false`): a dependency that is not installed shows up when the
 * extractor's module fails to import. Those names come from a `package.json` that the code under
 * test ships, so it also asks for `confined`: a package is used only if its real directory is
 * inside the `node_modules` tree it was found in. Every name in the closure, ours included, must be
 * an npm package name (`isPackageName`).
 */
export function closureRoots(
  packageDir: string,
  packages: ReadonlyArray<string>,
  start: ReadonlyArray<string>,
  required: boolean,
  confined = false,
): CodeRoots {
  const roots = new Set<string>(start);
  const queue: Array<{ name: string; from: string; required: boolean }> = packages.map((name) => ({
    name,
    from: packageDir,
    required,
  }));
  const seen = new Set<string>();
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { found, probed } = lookupPackage(next.from, next.name, confined);
    if (found === undefined) {
      if (next.required) {
        throw new SandboxSetupError(
          `cannot find package ${next.name} from ${next.from}; it is needed to load the extractor`,
        );
      }
      continue;
    }
    // `probed` ends at the directory that held the package: the walk went no further.
    for (const dir of probed) roots.add(dir);
    roots.add(found);
    if (seen.has(found)) continue;
    seen.add(found);
    const manifest = readPackageJson(found);
    for (const dep of Object.keys(manifest.dependencies ?? {}))
      queue.push({ name: dep, from: found, required });
    for (const dep of Object.keys(manifest.optionalDependencies ?? {}))
      queue.push({ name: dep, from: found, required: false });
    for (const dep of Object.keys(manifest.peerDependencies ?? {}))
      queue.push({ name: dep, from: found, required: false });
  }
  return { roots: [...roots].sort() };
}

/**
 * The real path of `path`, or `path` as given when it cannot be resolved (it does not exist, so the
 * child could not read it either).
 *
 * The permission model compares the path a call names, as a string, with its grants, and a process
 * reports its working directory with every link resolved. A grant of a path that reaches the
 * repository through a link therefore covers neither the real spelling nor a relative name, and
 * Node refuses even the look at the link's own directory that `realpathSync` takes. Granting, and
 * naming to the child, the real path puts a repository reached through a link (a checkout under
 * macOS `/tmp` or `/var`, a mounted workspace) where a real one is, and grants exactly the one
 * directory: not the link's parent, and not both spellings.
 */
export function realPathOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isNestedIn(outer: string, path: string): boolean {
  const rel = relative(outer, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * `readable` without any path that lies inside another path in it, in the order given.
 *
 * A grant of a directory already covers everything beneath it, so a nested grant adds no access.
 * It also breaks Node 22.13: with `--allow-fs-read=/repo` and `--allow-fs-read=/repo/dist` the
 * process may read the files in `/repo` but its `readdir`, `opendir` and `stat` of `/repo` itself
 * fail with ERR_ACCESS_DENIED (the permission tree keeps a nested grant instead of the outer one's
 * own entry). A repository that contains the extractor's code, which is true of this one, hit
 * that: every extractor that walks the repo saw an empty tree. Node 22.22 and 24 are not affected.
 * Collapsing to the outer paths grants exactly the same set on every version.
 */
export function withoutNested(readable: ReadonlyArray<string>): string[] {
  const unique = [...new Set(readable)];
  return unique.filter(
    (path) => !unique.some((other) => other !== path && isNestedIn(other, path)),
  );
}

/**
 * The Node flags that confine a child to `readable`.
 *
 * No `--allow-fs-write`, `--allow-worker`, `--allow-addons` or `--allow-wasi`,
 * ever. `--allow-child-process` only when the host granted a binary to run.
 * A path containing `*` is refused: `--allow-fs-read` treats a trailing `*` as a
 * wildcard, so such a path would widen what it names.
 */
export function permissionArgs(
  readable: ReadonlyArray<string>,
  allowChildProcess: boolean,
): string[] {
  const args = ['--permission'];
  for (const path of readable) {
    if (path.includes('*')) {
      throw new SandboxSetupError(
        `cannot confine a child to ${JSON.stringify(path)}: --allow-fs-read reads "*" as a wildcard`,
      );
    }
  }
  for (const path of withoutNested(readable)) args.push(`--allow-fs-read=${path}`);
  if (allowChildProcess) args.push('--allow-child-process');
  return args;
}

// ---------------------------------------------------------------------------
// The programs a child may start
// ---------------------------------------------------------------------------

/** Directories whose entries name a file by what a process has open, not by where the file is. */
const DESCRIPTOR_DIRS: ReadonlyArray<string> = ['/proc', '/dev/fd'];

/** Why a program at `path` may not be granted, or undefined when it may. */
function ungrantable(path: string, repoRoots: ReadonlyArray<string>): string | undefined {
  for (const dir of DESCRIPTOR_DIRS) {
    if (isNestedIn(dir, path)) return `under ${dir}, which names files by what a process has open`;
  }
  for (const root of repoRoots) {
    if (isNestedIn(root, path)) return 'inside the repository';
  }
  return undefined;
}

/**
 * The real, absolute path of each program in `names`, found the way the child would have found a
 * bare name (the first match on `pathValue`) but here, in the host, where nothing restricts the
 * lookup. The child is then handed this path and runs exactly it.
 *
 * The decision has to be taken on where the kernel will run the file, not on how a string spells
 * it: `/proc/self/cwd/bin/git`, `/proc/self/root/<repo>/bin/git` and a name through a symlinked
 * directory all reach a file in the repository, and none of them lies inside the repository by
 * its text. The child cannot take that decision itself: on Node 24 its `realpath` of a name it
 * was not granted a look at throws `ERR_ACCESS_DENIED`, for `/usr/bin/git` as for the planted file.
 *
 * Refused, with a `SandboxSetupError` that the host reports as UNAVAILABLE (nothing ran):
 *  - a name that is not a plain file name (a grant is a program, not a path);
 *  - a program that no entry of `pathValue` has: an entry that has no such file, or one that is not
 *    a regular executable file, is skipped, as `execvp` skips it, and the next entry is tried;
 *  - the first usable program, when its real path is inside the repository (a root in `repoRoots`
 *    as given, and with each link in it followed) or under `/proc` or `/dev/fd`. The repository is
 *    where an attacker's files are known to be, and the only place the repository can put one: the
 *    child can write nowhere. A second mount of the repository, or a hard link to or a copy of a
 *    file in it, is not joined to it by any spelling of the root; making one takes the operator.
 *
 * `pathValue` is the child's `PATH`, already without the entries the repository controls
 * (`pathOutsideRepo`); an empty or relative entry is skipped here as well, since it means the
 * working directory, which is the repository.
 *
 * Limit: the file is resolved once, here, and run later. A file put in its place between the two
 * would be run. That takes write access to the directory the program really lives in (`/usr/bin`),
 * which neither the repository nor a confined extractor has; Node cannot run a program by file
 * descriptor, so there is nothing closer to the exec to hold on to.
 */
export function resolveExecGrants(
  names: ReadonlyArray<string>,
  pathValue: string | undefined,
  repoRoots: ReadonlyArray<string>,
): Record<string, string> {
  // Every spelling of the repository that can be told apart: as given, and with each link followed.
  const roots = [
    ...new Set(repoRoots.flatMap((r) => [resolve(r), realPathOrSame(resolve(r))])),
  ].filter((r) => r.length > 1);
  const dirs = (pathValue ?? '').split(delimiter).filter((d) => d !== '' && isAbsolute(d));
  const extensions = process.platform === 'win32' ? ['.exe', ''] : [''];
  const granted: Record<string, string> = {};
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) {
      throw new SandboxSetupError(
        `cannot grant ${JSON.stringify(name)}: a granted program is a plain file name found on PATH`,
      );
    }
    let found: string | undefined;
    for (const dir of dirs) {
      for (const extension of extensions) {
        const candidate = join(dir, name + extension);
        let real: string;
        try {
          real = realpathSync.native(candidate);
          if (!statSync(real).isFile()) continue;
          accessSync(real, constants.X_OK);
        } catch {
          continue;
        }
        const why = ungrantable(candidate, roots) ?? ungrantable(real, roots);
        if (why !== undefined) {
          throw new SandboxSetupError(
            `${name} on PATH resolves to ${real}, ${why}; a program the repository supplies is never run`,
          );
        }
        found = real;
        break;
      }
      if (found !== undefined) break;
    }
    if (found === undefined) {
      throw new SandboxSetupError(
        `cannot find ${name} on a PATH outside the repository; it is a program the extractor may start`,
      );
    }
    granted[name] = found;
  }
  return granted;
}

/**
 * The real path of `name` for a program the CLI process itself starts in `repoRoot`, as opposed to
 * a sandbox child: found on `pathValue` the way the host finds a granted program for a child (the
 * entries the repository controls removed, `pathOutsideRepo`, then `resolveExecGrants`), and
 * undefined when no such program is found outside the repository.
 *
 * Starting a bare name would search the operator's `PATH` from the repository: an empty or relative
 * entry, `node_modules/.bin` (which `npm run` puts first) or a /proc name for the working directory
 * is the repository's own directory, and a program planted there would run as the user, outside the
 * permission model and the guard. Callers start the returned path, never the name.
 */
export function resolveOutsideRepo(
  name: string,
  pathValue: string | undefined,
  repoRoot: string,
): string | undefined {
  if (pathValue === undefined) return undefined;
  try {
    return resolveExecGrants([name], pathOutsideRepo(pathValue, repoRoot), [repoRoot])[name];
  } catch (e) {
    if (e instanceof SandboxSetupError) return undefined;
    throw e;
  }
}
