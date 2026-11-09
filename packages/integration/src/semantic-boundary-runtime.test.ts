/**
 * ADR-0015 conformance, run-time half: a default `seamline extract` and
 * `seamline check` must not load the semantic engine.
 *
 * The instrument is a Node module-resolution hook registered with `--import`.
 * It records every resolved import edge (importer URL and target URL) of the
 * real CLI binary, so the assertion is about what the process actually
 * loaded, not about what the source says. A positive control proves the
 * instrument can see the layer: importing the opt-in entry point
 * `@seamline/core/semantic` must load it.
 *
 * What the hook sees: every module the CLI binary loads. `packages/cli/src/run.ts`
 * imports every command statically (`init`, `extract`, `why`, `check`, `export`,
 * `diff`, `blast-radius`, `mcp`) and `commands/mcp.ts` imports `@seamline/mcp`,
 * so a static import of the layer anywhere in those modules or their packages is
 * loaded, and therefore seen, on any run of the binary.
 *
 * What it cannot see: (1) a dynamic `import()` on a path the run does not
 * execute. A literal one is caught by the static scan in
 * `semantic-boundary.test.ts`; a computed specifier is invisible to both.
 * (2) The standalone `packages/mcp/dist/bin.js` entry, which no run here loads.
 *
 * Requires a built workspace (`tsc --build`), like the other cross-package
 * tests. A missing build fails the test; it is never a skip.
 *
 * `TRACKED_EDGES` is the run-time twin of `TRACKED_DEVIATIONS` in
 * `semantic-boundary.test.ts`. It names import edges by which a default run is
 * known to load the layer. It is empty at acceptance, so the observed set of
 * edges entering the layer must be empty: any edge fails the test.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const INTEGRATION_DIR = fileURLToPath(new URL('..', import.meta.url));
const CLI_BIN = join(ROOT, 'packages/cli/dist/bin.js');
const FIXTURE = join(ROOT, 'examples/harbor-books');

/** Import edges, repo-relative, by which a default run is known to load the layer. Empty on purpose. */
const TRACKED_EDGES: readonly { importer: string; target: string }[] = [];

const REGISTER_JS = `import { register } from 'node:module';
register(new URL('./hooks.mjs', import.meta.url));
`;
const HOOKS_JS = `import { appendFileSync } from 'node:fs';
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  appendFileSync(
    process.env.SEAMLINE_IMPORT_LOG,
    JSON.stringify({ importer: context.parentURL ?? null, target: result.url }) + '\\n',
  );
  return result;
}
`;

interface Edge {
  importer: string | null;
  target: string;
}
interface Observed {
  status: number | null;
  stdout: string;
  stderr: string;
  edges: Edge[];
}

const toRepoPath = (url: string | null): string | null => {
  if (url === null || !url.startsWith('file:')) return null;
  return relative(ROOT, fileURLToPath(url)).split(sep).join('/');
};
const inLayer = (repoPath: string | null): boolean =>
  repoPath !== null && /^packages\/core\/(src|dist)\/semantic\//.test(repoPath);

/** Import edges that enter the layer from a module outside it. */
function crossingEdges(edges: Edge[]): { importer: string; target: string }[] {
  const seen = new Set<string>();
  const out: { importer: string; target: string }[] = [];
  for (const e of edges) {
    const importer = toRepoPath(e.importer);
    const target = toRepoPath(e.target);
    if (importer === null || target === null || !inLayer(target) || inLayer(importer)) continue;
    const key = `${importer} -> ${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ importer, target });
  }
  return out.sort((a, b) => `${a.importer} ${a.target}`.localeCompare(`${b.importer} ${b.target}`));
}

function loadedLayerModules(edges: Edge[]): string[] {
  const loaded = new Set<string>();
  for (const e of edges) {
    const target = toRepoPath(e.target);
    if (inLayer(target)) loaded.add(target as string);
  }
  return [...loaded].sort();
}

describe('semantic boundary: a default run does not load the semantic engine', () => {
  let work = '';
  let repo = '';
  let outDir = '';
  let extract: Observed;
  let check: Observed;
  let control: Observed;

  function observe(args: string[], cwd: string, name: string): Observed {
    const log = join(work, `${name}.imports.jsonl`);
    writeFileSync(log, '');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SEAMLINE_IMPORT_LOG: log,
      NO_COLOR: '1',
      TZ: 'UTC',
      LC_ALL: 'C',
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const r = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(join(work, 'hook', 'register.mjs')).href, ...args],
      { cwd, env, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(r.error, undefined, `could not run ${name}: ${String(r.error)}`);
    const edges = readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Edge);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, edges };
  }

  before(() => {
    assert.ok(
      existsSync(CLI_BIN),
      'packages/cli/dist/bin.js is missing: run `./node_modules/.bin/tsc --build` first. ' +
        'A missing build is a failure, never a pass.',
    );
    work = mkdtempSync(join(tmpdir(), 'seamline-boundary-'));
    mkdirSync(join(work, 'hook'));
    writeFileSync(join(work, 'hook', 'register.mjs'), REGISTER_JS);
    writeFileSync(join(work, 'hook', 'hooks.mjs'), HOOKS_JS);
    repo = join(work, 'fixture');
    cpSync(FIXTURE, repo, { recursive: true });
    outDir = join(work, 'store');

    // `--only` narrows what executes (extract-change needs git history), not what loads:
    // `packages/cli/src/wiring.ts` imports every extractor package statically.
    const only = ['extract-code-ts', 'extract-data', 'extract-contracts', 'infer-join'].flatMap(
      (n) => ['--only', n],
    );
    extract = observe(
      [CLI_BIN, 'extract', '--repo', repo, '--out', outDir, ...only],
      repo,
      'extract',
    );
    check = observe([CLI_BIN, 'check', '--repo', repo, '--out', outDir, '--json'], repo, 'check');
    control = observe(
      ['--input-type=module', '-e', "await import('@seamline/core/semantic');"],
      INTEGRATION_DIR,
      'control',
    );
  });

  after(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test('the runs did real work (an unavailable run is never a pass)', () => {
    assert.equal(extract.status, 0, extract.stderr);
    assert.ok(
      readdirSync(join(outDir, 'runs')).some((f) => f.endsWith('.sif')),
      'extract wrote no run file',
    );
    const report = JSON.parse(check.stdout) as {
      outcome: string;
      contradictions: { code: string }[];
      unknownDetectors: { code: string; reason: string }[];
    };
    assert.equal(report.outcome, 'unknown');
    assert.deepEqual(
      report.contradictions.map((c) => c.code),
      [],
      'the standalone schema does not establish response direction',
    );
    assert.ok(report.unknownDetectors.some((d) => d.code === 'X1_NULLABILITY' && d.reason.startsWith('VALUE_ROLE_UNOBSERVED:')));
    assert.equal(check.status, 0, 'UNKNOWN is reported without manufacturing a high finding');
  });

  test('positive control: the opt-in entry point loads the layer and the hook sees it', () => {
    assert.equal(control.status, 0, control.stderr);
    const loaded = loadedLayerModules(control.edges);
    assert.ok(
      loaded.includes('packages/core/dist/semantic/engine.js'),
      `the instrument did not observe the layer loading; saw ${JSON.stringify(loaded)}`,
    );
  });

  for (const name of ['extract', 'check'] as const) {
    test(`default ${name}: the layer is entered only through the tracked edges`, () => {
      const run = name === 'extract' ? extract : check;
      assert.deepEqual(
        crossingEdges(run.edges),
        TRACKED_EDGES,
        `A default \`seamline ${name}\` loaded the semantic engine by an unexpected route. The pipeline must not ` +
          `import it (ADR-0015). Loaded: ${JSON.stringify(loadedLayerModules(run.edges))}`,
      );
      if (TRACKED_EDGES.length === 0) {
        assert.deepEqual(loadedLayerModules(run.edges), []);
      }
    });
  }

  test('default runs write no semantic output', () => {
    const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
    assert.deepEqual(
      files.filter((f) => /semantic/i.test(relative(outDir, f))),
      [],
    );
    const db = new DatabaseSync(join(outDir, 'graph.db'), { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => String(r.name));
      assert.ok(tables.includes('runs'), 'the extraction store was not created');
      assert.deepEqual(
        tables.filter((t) => t.startsWith('semantic_')),
        [],
        'the extraction store must never contain semantic tables',
      );
    } finally {
      db.close();
    }
  });
});
