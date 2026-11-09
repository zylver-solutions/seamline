/**
 * The run-inputs digest and the run id derived from it.
 *
 * Every test here is a statement about when two runs must share an id (so the
 * output is reproducible) or must not (so they can be told apart), checked
 * against real files in a scratch directory.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { CONFIG_FILENAME } from './config.ts';
import { systemClock } from './io.ts';
import { DETERMINISTIC_RUN_ID_PATTERN, deterministicRunId } from './run-id.ts';
import { digestRunInputs, digestTree, type ExtractorInput, type RunInputs } from './run-inputs.ts';

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'seamline-inputs-'));
  scratch.push(dir);
  return dir;
}

function put(root: string, rel: string, body: string): void {
  const file = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
}

function treeOf(files: Readonly<Record<string, string>>): string {
  const root = scratchDir();
  for (const [rel, body] of Object.entries(files)) put(root, rel, body);
  return root;
}

const CODE: ExtractorInput = {
  name: 'extract-code-ts',
  version: '0.0.1',
  options: {},
  identity: null,
};
const DATA: ExtractorInput = {
  name: 'extract-data',
  version: '0.0.1',
  options: {},
  identity: null,
};

function inputs(repoRoot: string, over: Partial<RunInputs> = {}): RunInputs {
  return {
    repo: 'demo',
    repoRoot,
    outDir: path.join(repoRoot, 'seamline-out'),
    include: ['**/*'],
    exclude: ['node_modules/**'],
    extractors: [CODE, DATA],
    ...over,
  };
}

const FILES = {
  'src/a.ts': 'export const a = 1;\n',
  'db/schema.sql': 'create table t (id int);\n',
};

describe('the digest is a function of the inputs and nothing else', () => {
  test('the same inputs give the same digest, in 64 lowercase hex digits', () => {
    const root = treeOf(FILES);
    const first = digestRunInputs(inputs(root));
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(digestRunInputs(inputs(root)), first);
  });

  test('where the tree lives does not matter', () => {
    assert.equal(digestRunInputs(inputs(treeOf(FILES))), digestRunInputs(inputs(treeOf(FILES))));
  });

  test('the order files were created in, and their timestamps, do not matter', () => {
    const forward = scratchDir();
    for (const rel of Object.keys(FILES)) put(forward, rel, FILES[rel as keyof typeof FILES]);
    const backward = scratchDir();
    for (const rel of Object.keys(FILES).reverse())
      put(backward, rel, FILES[rel as keyof typeof FILES]);
    utimesSync(path.join(backward, 'src', 'a.ts'), new Date(0), new Date(86_400_000));
    assert.equal(digestRunInputs(inputs(forward)), digestRunInputs(inputs(backward)));
  });

  test('the order of option keys does not matter', () => {
    const root = treeOf(FILES);
    const a = inputs(root, {
      extractors: [{ ...CODE, options: { x: 1, y: { p: 1, q: 2 } } }, DATA],
    });
    const b = inputs(root, {
      extractors: [{ ...CODE, options: { y: { q: 2, p: 1 }, x: 1 } }, DATA],
    });
    assert.equal(digestRunInputs(a), digestRunInputs(b));
  });

  test('the order the extractors run in does matter: a later one reads what an earlier one stored', () => {
    const root = treeOf(FILES);
    const planned = digestRunInputs(inputs(root, { extractors: [CODE, DATA] }));
    const reordered = digestRunInputs(inputs(root, { extractors: [DATA, CODE] }));
    assert.notEqual(reordered, planned, 'the same extractors in another order are another run');
  });
});

describe('anything an extractor could see changes the digest', () => {
  const root = treeOf(FILES);
  const base = digestRunInputs(inputs(root));

  test('editing a file', () => {
    const edited = treeOf({ ...FILES, 'src/a.ts': 'export const a = 2;\n' });
    assert.notEqual(digestRunInputs(inputs(edited)), base);
  });

  test('adding a file, removing a file, and moving a file', () => {
    assert.notEqual(digestRunInputs(inputs(treeOf({ ...FILES, 'src/b.ts': '' }))), base);
    assert.notEqual(digestRunInputs(inputs(treeOf({ 'src/a.ts': FILES['src/a.ts'] }))), base);
    const moved = treeOf({
      'lib/a.ts': FILES['src/a.ts'],
      'db/schema.sql': FILES['db/schema.sql'],
    });
    assert.notEqual(digestRunInputs(inputs(moved)), base, 'the path is part of what a file is');
  });

  test('the same bytes under two different names are not the same as one name', () => {
    // Guards the record framing: two files cannot be re-read as one file.
    const one = treeOf({ ab: 'x' });
    const two = treeOf({ a: 'x', b: 'x' });
    assert.notEqual(digestTree(one, path.join(one, 'out')), digestTree(two, path.join(two, 'out')));
  });

  test('a file that only an extractor outside the include globs reads', () => {
    // `extract-data` walks the root itself; the globs do not bound it.
    const narrow = { include: ['src/**'] };
    const a = digestRunInputs(inputs(treeOf(FILES), narrow));
    const b = digestRunInputs(
      inputs(treeOf({ ...FILES, 'db/schema.sql': 'create table u (id int);\n' }), narrow),
    );
    assert.notEqual(a, b);
  });

  test('the repo name, include, exclude', () => {
    assert.notEqual(digestRunInputs(inputs(root, { repo: 'other' })), base);
    assert.notEqual(digestRunInputs(inputs(root, { include: ['src/**'] })), base);
    assert.notEqual(digestRunInputs(inputs(root, { exclude: [] })), base);
  });

  test('an extractor joining the run, leaving it, changing version, options or outside identity', () => {
    assert.notEqual(
      digestRunInputs(inputs(root, { extractors: [CODE] })),
      base,
      '--only narrows the run',
    );
    assert.notEqual(
      digestRunInputs(inputs(root, { extractors: [CODE, DATA, { ...CODE, name: 'x' }] })),
      base,
    );
    assert.notEqual(
      digestRunInputs(inputs(root, { extractors: [{ ...CODE, version: '0.0.2' }, DATA] })),
      base,
    );
    assert.notEqual(
      digestRunInputs(inputs(root, { extractors: [{ ...CODE, options: { a: 1 } }, DATA] })),
      base,
    );
    assert.notEqual(
      digestRunInputs(inputs(root, { extractors: [CODE, { ...DATA, identity: 'history:abc' }] })),
      base,
    );
    assert.notEqual(
      digestRunInputs(inputs(root, { extractors: [CODE, { ...DATA, version: null }] })),
      base,
      'an extractor with nothing wired is part of the run too, as UNAVAILABLE',
    );
  });

  test('a symbolic link is hashed by its target and is not followed', () => {
    const outside = scratchDir();
    put(outside, 'target.txt', 'one');
    const a = treeOf(FILES);
    symlinkSync(path.join(outside, 'target.txt'), path.join(a, 'link'));
    const before = digestRunInputs(inputs(a));
    put(outside, 'target.txt', 'two');
    assert.equal(digestRunInputs(inputs(a)), before, 'the content behind the link is not an input');

    const b = treeOf(FILES);
    symlinkSync(path.join(outside, 'elsewhere.txt'), path.join(b, 'link'));
    assert.notEqual(digestRunInputs(inputs(b)), before, 'where it points is');
  });
});

describe('what is not an input leaves the digest alone', () => {
  const base = digestRunInputs(inputs(treeOf(FILES)));

  test('dependencies, version-control metadata, and the output directory', () => {
    const noisy = treeOf({
      ...FILES,
      'node_modules/dep/index.js': 'x',
      'packages/p/node_modules/dep/index.js': 'y',
      '.git/HEAD': 'ref: refs/heads/main\n',
      'seamline-out/graph.db': 'binary',
      'seamline-out/runs/run-det-0123456789abcdef.sif': '{}',
    });
    assert.equal(digestRunInputs(inputs(noisy)), base);
  });

  test('a custom output directory inside the tree', () => {
    const root = treeOf({ ...FILES, 'build/out/graph.db': 'binary' });
    assert.equal(digestRunInputs(inputs(root, { outDir: path.join(root, 'build', 'out') })), base);
  });

  test('a .git file, as a linked worktree has', () => {
    assert.equal(
      digestRunInputs(inputs(treeOf({ ...FILES, '.git': 'gitdir: /elsewhere\n' }))),
      base,
    );
  });

  test('the config file at the root, whose effective part is hashed separately', () => {
    const withConfig = treeOf({ ...FILES, [CONFIG_FILENAME]: '{"exportProfiles":{}}\n' });
    assert.equal(digestRunInputs(inputs(withConfig)), base);
  });

  test('but a config file anywhere else is just a file', () => {
    const nested = treeOf({ ...FILES, [`sub/${CONFIG_FILENAME}`]: '{}\n' });
    assert.notEqual(digestRunInputs(inputs(nested)), base);
  });
});

describe('the clock', () => {
  test('in deterministic mode derives the id from the digest and freezes time', () => {
    const digest = digestRunInputs(inputs(treeOf(FILES)));
    const clock = systemClock({ SEAMLINE_DETERMINISTIC: '1' });
    assert.equal(
      clock.runId(() => digest),
      deterministicRunId(digest),
    );
    assert.equal(
      clock.runId(() => digest),
      clock.runId(() => digest),
      'asking twice does not count',
    );
    assert.equal(clock.now(), '1970-01-01T00:00:00.000Z');
    assert.throws(() => clock.runId(() => 'not a digest'), /SHA-256/);
  });

  test('otherwise issues unique ids and never reads the tree', () => {
    const clock = systemClock({});
    const unreadable = (): string => {
      throw new Error('the tree was read');
    };
    const ids = Array.from({ length: 3 }, () => clock.runId(unreadable));
    for (const id of ids) assert.match(id, /^run-\d{8}T\d{9}Z-[0-9a-f]{6}$/);
    assert.equal(
      new Set(ids).size,
      3,
      'a random suffix tells runs from the same millisecond apart',
    );
  });
});

describe('deterministic run ids', () => {
  test('are run-det- and the first 16 digits of the digest', () => {
    const digest = digestRunInputs(inputs(treeOf(FILES)));
    const id = deterministicRunId(digest);
    assert.equal(id, `run-det-${digest.slice(0, 16)}`);
    assert.match(id, DETERMINISTIC_RUN_ID_PATTERN);
    assert.equal(id.length, 'run-det-'.length + 16, 'the length does not vary');
  });

  test('refuse anything that is not a SHA-256 digest, so a constant id cannot slip back in', () => {
    for (const bad of [
      '',
      'run-deterministic-0000',
      'abc',
      'G'.repeat(64),
      'A'.repeat(64),
      '0'.repeat(63),
    ]) {
      assert.throws(() => deterministicRunId(bad), /SHA-256/, JSON.stringify(bad));
    }
  });

  test('different inputs give different ids', () => {
    const ids = new Set(
      ['a', 'b', 'c', 'd'].map((body) =>
        deterministicRunId(digestRunInputs(inputs(treeOf({ 'f.txt': body })))),
      ),
    );
    assert.equal(ids.size, 4);
  });
});
