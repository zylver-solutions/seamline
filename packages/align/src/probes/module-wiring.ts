/**
 * Probe `module-wiring` v2 (design 4.4): is a module that a control row names
 * imported by anything? Completeness `presence-only`: **the probe never answers
 * `ABSENT`.** The graph holds static `import` and `export ... from` edges and
 * nothing else; a dynamic `import()`, a `require()`, a `new URL(...)`
 * reference, a script in a manifest, a workflow, and every file the run did not
 * read are consumers it cannot see. A control is confirmed (`HOLDS`) or left
 * `Unknown`, and the packet can never say that a control is unwired.
 */

import { codeScopeGate, memo, type ProbeEnv } from '../env.ts';
import { holds, unknownFact, type ProbeFact } from '../types.ts';
import { compareCodeUnits } from '../util.ts';
import {
  dependentsOf,
  entryPoints,
  isDeclarationFile,
  isSourceExtension,
  isTestPath,
  ownerOf,
} from '../workspace.ts';

interface WiringGraph {
  readonly fileSet: ReadonlySet<string>;
  readonly importersOf: ReadonlyMap<string, readonly string[]>;
  readonly isBarrel: (file: string) => boolean;
}

function buildGraph(env: ProbeEnv): WiringGraph {
  const out = new Map<string, { reExport: boolean }[]>();
  const importers = new Map<string, string[]>();
  for (const edge of env.facts.imports) {
    const list = out.get(edge.src) ?? [];
    list.push({ reExport: edge.reExport });
    out.set(edge.src, list);
    const inbound = importers.get(edge.dst) ?? [];
    inbound.push(edge.src);
    importers.set(edge.dst, inbound);
  }
  const symbolPaths = new Set(env.facts.symbolPaths);
  // A barrel has at least one outgoing IMPORTS edge, all of them re-exports, and no Symbol node carries its path.
  const isBarrel = (file: string): boolean => {
    const edges = out.get(file);
    return (
      edges !== undefined &&
      edges.length > 0 &&
      edges.every((e) => e.reExport) &&
      !symbolPaths.has(file)
    );
  };
  return { fileSet: new Set(env.facts.files), importersOf: importers, isBarrel };
}

export function probeModuleWiring(env: ProbeEnv, boundPaths: readonly string[]): ProbeFact {
  const gate = codeScopeGate(env);
  if (gate !== null) return gate;
  const graph = memo(env, 'wiring-graph', () => buildGraph(env));
  const inBound = (file: string): boolean =>
    boundPaths.some((b) => file === b || file.startsWith(`${b}/`));

  // M: the File nodes of the run at or under a bound path, tests excluded.
  const modules = [...graph.fileSet]
    .filter((f) => inBound(f) && !isTestPath(f))
    .sort(compareCodeUnits);
  if (modules.length === 0) {
    return unknownFact(
      'non-extracted-anchor',
      'no File node of the run lies at or under a bound path, tests excluded',
      {},
    );
  }
  const moduleSet = new Set(modules);

  // A consumer: a file outside M, not a test, not a barrel, with an IMPORTS edge to the module or to a barrel that re-exports it.
  const hasConsumer = (file: string): boolean => {
    const seen = new Set<string>([file]);
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.shift() ?? '';
      for (const importer of graph.importersOf.get(current) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        if (graph.isBarrel(importer)) {
          queue.push(importer);
          continue;
        }
        if (!moduleSet.has(importer) && !isTestPath(importer)) return true;
      }
    }
    return false;
  };
  const wired = modules.filter(hasConsumer);
  if (wired.length > 0) {
    return holds(
      true,
      `${wired[0]} is imported statically by non-test code outside the bound paths (${wired.length} of ${modules.length} modules)`,
      { binding: 'B1' },
    );
  }

  // An entry point is wired by its manifest: bin, main and exports targets are run or exported from outside the graph.
  const entries = new Set<string>();
  for (const pkg of env.discovery.packages)
    for (const file of entryPoints(env.tree, pkg).files) entries.add(file);
  const namedEntry = modules.find((f) => boundPaths.includes(f) && entries.has(f));
  if (namedEntry !== undefined) {
    return holds(
      true,
      `${namedEntry} is an entry point named by its package manifest (bin, main or exports)`,
      { binding: 'B1' },
    );
  }

  for (const file of modules) {
    const pkg = ownerOf(env.discovery, file);
    if (pkg !== null && dependentsOf(env.discovery, pkg).length > 0) {
      return unknownFact(
        'cross-package-unobservable',
        `${file} belongs to ${pkg.name}, which other packages depend on; the extraction records no import across a package`,
      );
    }
  }
  const unanchored = boundPaths.filter(
    (b) => !env.facts.files.some((f) => f === b || f.startsWith(`${b}/`)),
  );
  if (unanchored.length > 0) {
    return unknownFact(
      'non-extracted-anchor',
      `no File node of the run lies at or under ${unanchored.join(', ')}`,
    );
  }
  if (env.discovery.incomplete) {
    return unknownFact(
      'manifest-unparseable',
      `package discovery is incomplete: ${env.discovery.incompleteDetail}`,
    );
  }
  const unread = env.tree.tracked.filter(
    (f) => isSourceExtension(f) && !isDeclarationFile(f) && !isTestPath(f) && !graph.fileSet.has(f),
  ).length;
  return unknownFact(
    'no-static-consumer',
    `the graph records no static importer; ${unread} tracked source file(s) have no File node in the run and could hold a consumer`,
  );
}
