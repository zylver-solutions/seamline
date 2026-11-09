/**
 * The committed evaluation inputs and the wiring that keeps them offline.
 *
 * These assert the design's own acceptance conditions (section 6 of
 * docs/design/real-world-inputs.md) against the files as committed, so a corpus that drifts out of spec, a
 * detector left without a mutant, or a `verify` that starts fetching fails
 * here and not in review.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { CONTRADICTION_CODES } from '@seamline/ontology';
import { loadCorpus, readJsonFile } from './corpus.ts';
import { parseLabels } from './labels.ts';
import { parseMutants } from './mutants.ts';
import { DETECTOR_ROLES, REFERENCED_KINDS, referencedKindsIn, roleProblem } from './roles.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

test('the committed corpus pins at least five public repositories spanning every input stack', async () => {
  const corpus = await loadCorpus(path.join(ROOT, 'eval', 'corpus.json'));
  assert.ok(corpus.length >= 5, `only ${corpus.length} repositories`);
  const stacks = new Set(corpus.flatMap((c) => c.stacks));
  for (const needed of ['prisma', 'drizzle', 'openapi', 'zod']) {
    assert.ok(stacks.has(needed), `no corpus repository covers ${needed}`);
  }
  assert.ok(
    stacks.has('sql-migrations') || stacks.has('sql-ddl'),
    'no corpus repository covers SQL DDL or migrations',
  );
  for (const entry of corpus) {
    assert.match(entry.sha, /^[0-9a-f]{40}$/, entry.name);
    assert.ok(entry.url.startsWith('https://github.com/'), entry.name);
    assert.ok(
      !/seamline|zylver/i.test(entry.url),
      `${entry.name} must not be authored by this project`,
    );
  }
});

test('the committed labels file is valid', async () => {
  const labels = parseLabels(await readJsonFile(path.join(ROOT, 'eval', 'labels.json')));
  assert.deepEqual(
    [...labels.keys()].filter((id) => !/^[0-9a-f]{16}$/.test(id)),
    [],
  );
});

test('every detector in the catalog has at least one mutant, so recall is never silently n/a', async () => {
  const corpus = await loadCorpus(path.join(ROOT, 'eval', 'corpus.json'));
  const mutants = parseMutants(await readJsonFile(path.join(ROOT, 'eval', 'mutants.json')), corpus);
  const covered = new Set(mutants.map((m) => m.detector));
  const missing = CONTRADICTION_CODES.filter((code) => !covered.has(code));
  assert.deepEqual(missing, [], `detectors with no mutant: ${missing.join(', ')}`);
});

test('the evaluation is outside verify, and its fetched and generated directories stay out of git and out of extraction', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.ok(pkg.scripts['eval'] !== undefined, 'the eval script exists');
  const reachable = new Set<string>();
  const visit = (script: string): void => {
    if (reachable.has(script)) return;
    reachable.add(script);
    for (const m of (pkg.scripts[script] ?? '').matchAll(/pnpm (?:run )?([\w:-]+)/g)) {
      const next = m[1];
      if (next !== undefined && pkg.scripts[next] !== undefined) visit(next);
    }
  };
  visit('verify');
  assert.ok(!reachable.has('eval'), 'verify must not run the evaluation');
  for (const script of reachable) {
    assert.ok(!/eval\/|packages\/eval|git (clone|fetch)/.test(pkg.scripts[script] ?? ''), script);
  }

  const gitignore = (await readFile(path.join(ROOT, '.gitignore'), 'utf8'))
    .split('\n')
    .map((l) => l.trim());
  assert.ok(gitignore.includes('.eval-cache/'), '.eval-cache/ must be gitignored');
  assert.ok(gitignore.includes('eval-out/'), 'eval-out/ must be gitignored');

  const config = JSON.parse(await readFile(path.join(ROOT, 'seamline.config.json'), 'utf8')) as {
    exclude: string[];
  };
  assert.ok(
    config.exclude.includes('.eval-cache/**'),
    'the dogfood run must not read fetched repositories',
  );
  assert.ok(
    config.exclude.includes('eval-out/**'),
    'the dogfood run must not read evaluation output',
  );

  const eslint = await readFile(path.join(ROOT, 'eslint.config.js'), 'utf8');
  assert.ok(
    eslint.includes("'.eval-cache/**'") && eslint.includes("'eval-out/**'"),
    'lint ignores them',
  );
});

test('the package is private and publishes nothing', async () => {
  const pkg = JSON.parse(
    await readFile(path.join(ROOT, 'packages', 'eval', 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(pkg['name'], '@seamline/eval');
  assert.equal(pkg['private'], true);
  assert.equal('files' in pkg, false);
  assert.equal('publishConfig' in pkg, false);
});

test('the development comparisons stay outside the sealed partition', async () => {
  const corpus = await loadCorpus(path.join(ROOT, 'eval', 'corpus.json'));
  const byPartition = (p: string): string[] =>
    corpus
      .filter((c) => c.partition === p)
      .map((c) => c.name)
      .sort();
  assert.deepEqual(byPartition('dev'), [
    'dokploy',
    'reactive-resume',
    'saintandstory-fix',
    'saintandstory-parent',
    'umami',
    'umami-x7-fix',
    'umami-x7-parent',
  ]);
  assert.deepEqual(byPartition('sealed'), ['frapp', 'karakeep', 'rallly']);
});

test('mutants are written against dev repositories only, so the sealed partition is never read to build them', async () => {
  const corpus = await loadCorpus(path.join(ROOT, 'eval', 'corpus.json'));
  const sealed = new Set(corpus.filter((c) => c.partition === 'sealed').map((c) => c.name));
  const mutants = parseMutants(await readJsonFile(path.join(ROOT, 'eval', 'mutants.json')), corpus);
  assert.deepEqual(
    mutants.filter((m) => sealed.has(m.repo)).map((m) => m.id),
    [],
  );
});

test('every committed label records who reviewed it and whether they saw the claim', async () => {
  const labels = parseLabels(await readJsonFile(path.join(ROOT, 'eval', 'labels.json')));
  for (const [id, label] of labels) {
    assert.equal(typeof label.blind, 'boolean', id);
    assert.ok(label.reviewer.trim() !== '', id);
  }
});

/** Every expression a detector source assigns to `left` or `right` of a draft. */
function sidesOf(source: string): { left: Set<string>; right: Set<string> } {
  const left = new Set<string>();
  const right = new Set<string>();
  for (const m of source.matchAll(/^\s*left:\s*(.+?),\s*$/gm)) left.add(m[1] as string);
  for (const m of source.matchAll(/^\s*right:\s*(.+?),\s*$/gm)) right.add(m[1] as string);
  for (const m of source.matchAll(/const (left|right): NodeId =\s*(.+?);\s*$/gm)) {
    (m[1] === 'left' ? left : right).add(m[2] as string);
  }
  return { left, right };
}

test('the role table matches what each detector source puts on the left and the right of a finding', async () => {
  const dir = path.join(ROOT, 'packages', 'contradictions', 'src', 'detectors');
  const files = await readdir(dir);
  for (const code of CONTRADICTION_CODES) {
    const prefix = `${code.split('_')[0]?.toLowerCase()}-`;
    const file = files.find((f) => f.startsWith(prefix) && !f.endsWith('.test.ts'));
    assert.ok(file !== undefined, `no detector source for ${code}`);
    let source = await readFile(path.join(dir, file), 'utf8');
    if (code === 'X8_ORPHANED_MIGRATION') {
      // The reviewed decoder chooses the supporting kinds. Keep this check
      // bound to an actual import so an unused helper cannot certify a role.
      assert.match(source, /import\s*\{\s*readReplayEvidence\s*\}\s*from\s*['"]\.\/x8-replay-proof\.ts['"]/);
      source += '\n' + await readFile(path.join(dir, 'x8-replay-proof.ts'), 'utf8');
    }
    const { left, right } = sidesOf(source);
    const roles = DETECTOR_ROLES[code];
    // If this fails, a detector changed which node it reports on a side. Re-read the role table
    // and every mutant for the detector: a match on the wrong side is never credited.
    assert.deepEqual([...left].sort(), [...roles.leftExpressions].sort(), `${code} left`);
    assert.deepEqual([...right].sort(), [...roles.rightExpressions].sort(), `${code} right`);
    // The expressions can stay the same while the node kind behind them changes, as when a
    // validator is followed as 'SchemaProperty' instead of 'Symbol'. The kinds the source
    // names are compared too.
    assert.deepEqual(
      referencedKindsIn(source),
      [...REFERENCED_KINDS[code]].sort(),
      `${code} kinds`,
    );
  }
});

test('every committed mutant puts its leftMatch and rightMatch on the side the detector reports them', async () => {
  const corpus = await loadCorpus(path.join(ROOT, 'eval', 'corpus.json'));
  const mutants = parseMutants(await readJsonFile(path.join(ROOT, 'eval', 'mutants.json')), corpus);
  for (const m of mutants) {
    for (const side of ['left', 'right'] as const) {
      const match = side === 'left' ? m.expect.leftMatch : m.expect.rightMatch;
      if (match === undefined) continue;
      assert.equal(roleProblem(m.detector, side, match), null, `${m.id} ${side}Match`);
    }
  }
  const byId = new Map(mutants.map((m) => [m.id, m.expect]));
  // The two sides the first version of this file got wrong.
  assert.equal(byId.get('x4-user-one-phantom-property')?.leftMatch, 'evalPhantomField');
  assert.equal(byId.get('x4-user-one-phantom-property')?.rightMatch, undefined);
  assert.equal(byId.get('x10-untested-user-email-write')?.rightMatch, 'user.email');
  assert.equal(byId.get('x10-untested-user-email-write')?.leftMatch, undefined);
});

test('mutants edit JSON documents by pointer, so they hold no text from the third-party file', async () => {
  const corpus = await loadCorpus(path.join(ROOT, 'eval', 'corpus.json'));
  const mutants = parseMutants(await readJsonFile(path.join(ROOT, 'eval', 'mutants.json')), corpus);
  for (const m of mutants) {
    for (const edit of m.edits) {
      if (edit.path.endsWith('.json')) {
        assert.ok('pointer' in edit, `${m.id} edits ${edit.path} by text`);
      }
      if ('find' in edit) {
        assert.ok(edit.find.length <= 60, `${m.id}: find is ${edit.find.length} characters`);
      }
    }
  }
});
