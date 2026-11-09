/**
 * Probe `manifest-field` v2 (design 4.1, 5.4): the Node or pnpm floor a
 * manifest declares. Provenance `DECLARED`. It reads no run.
 *
 * `HOLDS` and `DIFFERENT` are both conclusive (completeness `exact`), for a
 * floor read from the document's own package or inherited from a farther
 * manifest across directories that hold no other floor site. `ABSENT` is
 * conclusive only as the closed-world answer of the survey: no site that is
 * known to carry a floor declares one.
 */

import type { ProbeEnv } from '../env.ts';
import { readText } from '../tree.ts';
import { absent, holds, unknownFact, type ProbeFact } from '../types.ts';
import { basename, dirname, uniqueSorted } from '../util.ts';
import { parseManifest, type Manifest } from '../workspace.ts';

export type Runtime = 'node' | 'pnpm';

const COMPARATOR = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * Pin files known to carry a floor, matched by path suffix: a path is a pin
 * file if it is, or ends in `/` followed by, one of these. These sites are not
 * parsed: that one exists is the finding.
 */
const PIN_FILES: Readonly<Record<Runtime, readonly string[]>> = {
  node: [
    '.tool-versions',
    'mise.toml',
    '.mise.toml',
    '.config/mise/config.toml',
    '.mise/config.toml',
    '.nvmrc',
    '.node-version',
  ],
  pnpm: [
    '.tool-versions',
    'mise.toml',
    '.mise.toml',
    '.config/mise/config.toml',
    '.mise/config.toml',
  ],
};
/** The other manifest formats pnpm reads, which the probe does not parse. */
const OTHER_MANIFESTS: readonly string[] = ['package.yaml', 'package.json5'];

function isPinFile(runtime: Runtime, path: string): boolean {
  return PIN_FILES[runtime].some((pin) => path === pin || path.endsWith(`/${pin}`));
}

function manifestPath(dir: string): string {
  return dir === '.' ? 'package.json' : `${dir}/package.json`;
}

function engineValue(manifest: Manifest, runtime: Runtime): unknown {
  const engines = manifest['engines'];
  if (typeof engines !== 'object' || engines === null || Array.isArray(engines)) return undefined;
  return (engines as Record<string, unknown>)[runtime];
}

/** The keys of a manifest that pin a tool or runtime other than through `engines` (4.1). */
function manifestPins(manifest: Manifest, runtime: Runtime): string[] {
  const out: string[] = [];
  if (manifest['devEngines'] !== undefined) out.push('devEngines');
  if (manifest['volta'] !== undefined) out.push('volta');
  if (
    runtime === 'pnpm' &&
    typeof manifest['packageManager'] === 'string' &&
    manifest['packageManager'].startsWith('pnpm@')
  ) {
    out.push('packageManager');
  }
  const pnpm = manifest['pnpm'];
  if (
    runtime === 'node' &&
    typeof pnpm === 'object' &&
    pnpm !== null &&
    (pnpm as Record<string, unknown>)['executionEnv'] !== undefined
  ) {
    out.push('pnpm.executionEnv');
  }
  return out;
}

/** Line of `engines.<runtime>` in a manifest's text, for the fact's source. */
function engineLine(text: string, runtime: Runtime): number {
  const engines = text.search(/"engines"\s*:/);
  const base = engines < 0 ? 0 : engines;
  const at = text.slice(base).search(new RegExp(`"${runtime}"\\s*:`));
  const index = at < 0 ? base : base + at;
  return text.slice(0, index).split('\n').length;
}

export function probeManifestField(env: ProbeEnv, docPath: string, runtime: Runtime): ProbeFact {
  const tracked = new Set(env.tree.tracked);
  const discoveredDirs = new Set(env.discovery.packages.map((p) => p.dir));

  // 1. Read: walk up from the document's directory, nearest first, to the nearest manifest that declares
  //    engines.<runtime>. The inheritance crosses only directories that hold no other floor site.
  let nearestSite: string | null = null;
  for (let dir = dirname(docPath); ; dir = dirname(dir)) {
    const path = manifestPath(dir);
    let manifest: Manifest | null = null;
    if (tracked.has(path)) {
      const text = readText(env.tree, path);
      manifest = parseManifest(text);
      // An unparseable manifest met on the way is decided before any floor site is reported.
      if (manifest === null) return unknownFact('manifest-unparseable', `${path} does not parse`);
      const value = engineValue(manifest, runtime);
      if (value !== undefined) {
        if (nearestSite !== null) {
          return unknownFact(
            'non-extracted-anchor',
            `${path} declares engines.${runtime}, but ${nearestSite} lies nearer the document and may pin the runtime of the document's own package; this probe does not read it`,
          );
        }
        const line = engineLine(text ?? '', runtime);
        const source = { path, lineStart: line, lineEnd: line };
        const m = typeof value === 'string' ? COMPARATOR.exec(value.trim()) : null;
        if (m === null) {
          return unknownFact(
            'unsupported-range',
            `${path} declares engines.${runtime} as ${JSON.stringify(value)}, which is not a single >= comparator`,
            { source },
          );
        }
        return holds(
          `${m[1] ?? '0'}.${m[2] ?? '0'}.${m[3] ?? '0'}`,
          `engines.${runtime} of ${path}`,
          { source },
        );
      }
    }
    // Not the declaring manifest: what sits in this directory is nearer than the one that will declare.
    if (nearestSite === null) {
      const prefix = dir === '.' ? '' : `${dir}/`;
      if (manifest !== null) {
        const pins = manifestPins(manifest, runtime);
        if (pins.length > 0) nearestSite = `${path}: ${pins[0]}`;
        else if (!discoveredDirs.has(dir) && dir !== '.')
          nearestSite = `${path}, which is not a discovered package`;
      }
      if (nearestSite === null) {
        const here = env.tree.tracked.find(
          (p) =>
            p.startsWith(prefix) &&
            (isPinFile(runtime, p.slice(prefix.length)) ||
              OTHER_MANIFESTS.includes(p.slice(prefix.length))),
        );
        if (here !== undefined) nearestSite = here;
      }
    }
    if (dir === '.') break;
  }

  // 2. Survey: a floor can be declared elsewhere, and a document can describe any package of the repository.
  const sites: string[] = [];
  let manifests = 0;
  for (const path of env.tree.tracked) {
    const base = basename(path);
    if (base === 'package.json') {
      manifests += 1;
      const manifest = parseManifest(readText(env.tree, path));
      if (manifest === null) return unknownFact('manifest-unparseable', `${path} does not parse`);
      if (engineValue(manifest, runtime) !== undefined) sites.push(`${path}: engines.${runtime}`);
      for (const pin of manifestPins(manifest, runtime)) sites.push(`${path}: ${pin}`);
    } else if (isPinFile(runtime, path) || OTHER_MANIFESTS.includes(base)) {
      sites.push(path);
    }
  }
  if (sites.length > 0) {
    return unknownFact(
      'non-extracted-anchor',
      `a ${runtime} floor may be declared at ${uniqueSorted(sites)[0]}, which this probe does not read`,
    );
  }
  if (manifests === 0) {
    return unknownFact(
      'non-extracted-anchor',
      'the tree tracks no package.json, so no floor can be read from it',
    );
  }
  return absent(`no tracked manifest or pin file declares a ${runtime} floor`);
}
