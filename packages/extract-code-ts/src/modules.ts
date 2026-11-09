/**
 * Module (package) resolution.
 *
 * A `Module` in the core profile is a package-shaped grouping: the thing a
 * `package.json` names, which `CONTAINS` files and `EXPORTS` symbols. Its name
 * is the identity anchor for every symbol inside it (see `canonical.ts`), which
 * is why the name comes from `package.json` and never from the directory: a
 * directory rename is a `git mv`, and a `git mv` within a package (or of the
 * whole package directory) must not change a `Module` or `Symbol` id. Moving,
 * renaming or removing the `package.json` itself does change the package that
 * the files below it belong to (ADR-0016 item 4).
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { ROOT_MODULE } from './canonical.ts';
import { dirnamePosix } from './paths.ts';

export interface ModuleInfo {
  /** Package name, or `<root>` when no `package.json` governs the file. */
  readonly name: string;
  /** Repo-relative POSIX directory of the governing `package.json`. `''` at the root. */
  readonly dir: string;
  /** Repo-relative POSIX path of the module's entry source file, when resolvable. */
  readonly entry: string | null;
}

interface RawPackage {
  readonly name?: unknown;
  readonly main?: unknown;
  readonly module?: unknown;
  readonly types?: unknown;
  readonly exports?: unknown;
}

const ENTRY_CANDIDATES = ['src/index.ts', 'src/index.tsx', 'src/index.mts', 'index.ts', 'index.tsx', 'src/index.js', 'index.js'];

/**
 * Caches `package.json` lookups per directory.
 *
 * Reads the filesystem directly rather than through ts-morph: a `package.json`
 * is not a source file, and going through the project would pull it into the
 * program.
 */
export class ModuleResolver {
  readonly #repoRoot: string;
  readonly #byDir = new Map<string, ModuleInfo>();
  readonly #modules = new Map<string, ModuleInfo>();

  constructor(repoRoot: string) {
    this.#repoRoot = nodePath.resolve(repoRoot);
  }

  /** All modules discovered so far, sorted by name. */
  discovered(): readonly ModuleInfo[] {
    return [...this.#modules.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Resolve the module governing a repo-relative POSIX file path. */
  forFile(repoRelativeFile: string): ModuleInfo {
    let dir = dirnamePosix(repoRelativeFile);
    const visited: string[] = [];
    for (;;) {
      const cached = this.#byDir.get(dir);
      if (cached !== undefined) {
        for (const v of visited) this.#byDir.set(v, cached);
        return cached;
      }
      const info = this.#readPackage(dir);
      if (info !== null) {
        this.#byDir.set(dir, info);
        for (const v of visited) this.#byDir.set(v, info);
        this.#modules.set(info.name, info);
        return info;
      }
      visited.push(dir);
      if (dir === '') break;
      dir = dirnamePosix(dir);
    }
    const root: ModuleInfo = { name: ROOT_MODULE, dir: '', entry: null };
    for (const v of visited) this.#byDir.set(v, root);
    this.#modules.set(root.name, root);
    return root;
  }

  #readPackage(relDir: string): ModuleInfo | null {
    const abs = nodePath.join(this.#repoRoot, relDir, 'package.json');
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
    let parsed: RawPackage;
    try {
      parsed = JSON.parse(text) as RawPackage;
    } catch {
      return null;
    }
    const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : null;
    if (name === null) return null;
    return { name, dir: relDir, entry: this.#resolveEntry(relDir) };
  }

  #resolveEntry(relDir: string): string | null {
    for (const candidate of ENTRY_CANDIDATES) {
      const rel = relDir === '' ? candidate : `${relDir}/${candidate}`;
      if (fs.existsSync(nodePath.join(this.#repoRoot, rel))) return rel;
    }
    return null;
  }
}
