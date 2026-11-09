/**
 * Lint over every shipped authoritative-scope selector.
 *
 * Two shipped selectors once parsed as nothing the store could evaluate: a
 * POSIX brace glob and a prose description. Both silently matched no path, so
 * the sweep for their scopes never buried anything. The checks here make that
 * class of mistake a failing test at the source:
 *
 * 1. every selector a shipped manifest declares compiles;
 * 2. every pattern in a path selector matches at least one plausible fixture
 *    path (a dead list item, such as a sentence, matches none), and none of
 *    the fixture paths the scope must never claim;
 * 3. every node a real extractor emits with a path, over a real example
 *    repository, lies inside its own selector, so it can be forgotten.
 *
 * A selector over kinds that carry no path is a label rather than a path
 * filter; each one is listed with the reason, so a new selector cannot slip
 * through unclassified.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import type { AuthoritativeScope, ExtractorManifest, SeamlineNode } from '@seamline/ontology';
import { compileSelector, selectorProblem } from '@seamline/core';
import { manifest as codeTsManifest, extractCodeTs } from '@seamline/extract-code-ts';
import { MANIFEST as dataManifest, extractData } from '@seamline/extract-data';
import { MANIFEST as contractsManifest } from '@seamline/extract-contracts';
import { CHANGE_MANIFEST } from '@seamline/extract-change';
import { INFER_JOIN_MANIFEST } from '@seamline/infer-join';

const SHIPPED: ReadonlyArray<ExtractorManifest> = [
  codeTsManifest,
  dataManifest,
  contractsManifest,
  CHANGE_MANIFEST,
  INFER_JOIN_MANIFEST,
];

const EXAMPLE_ROOT = fileURLToPath(new URL('../../../examples/harbor-books', import.meta.url));

/** Paths each path selector must cover, pattern by pattern, and paths it must never claim. */
const PATH_FIXTURES: Readonly<
  Record<string, { readonly covers: readonly string[]; readonly never: readonly string[] }>
> = {
  'code.ts': {
    covers: [
      'a.ts',
      'src/a.ts',
      'src/b.tsx',
      'lib/c.mts',
      'lib/d.cts',
      'e.js',
      'web/f.jsx',
      'g.mjs',
      'bin/h.cjs',
    ],
    never: ['README.md', 'db/schema.sql', 'package.json', 'src/a.ts.map', 'src/b.tsx.snap'],
  },
  data: {
    covers: [
      'schema.sql',
      'db/migrations/0001_init.sql',
      'prisma/schema.prisma',
      'src/db/schema.ts',
      'a.tsx',
      'a.mts',
      'a.cts',
      'db/schema.js',
      'a.jsx',
      'a.mjs',
      'a.cjs',
    ],
    never: ['README.md', 'db/data.sqlite', 'prisma/schema.prisma.bak', 'docs/erd.md'],
  },
};

/** Selectors over kinds that carry no path: recorded, never matched against one. */
const LABEL_SELECTORS: Readonly<
  Record<string, { readonly kinds: readonly string[]; readonly why: string }>
> = {
  change: {
    kinds: ['Changeset', 'Commit'],
    why: 'a revision range; commits and changesets have no path',
  },
  'infer-join': { kinds: [], why: 'claims no node kinds, so its sweep never runs' },
};

function selected(): Array<{
  readonly manifest: ExtractorManifest;
  readonly scope: AuthoritativeScope & { selector: string };
}> {
  return SHIPPED.flatMap((manifest) =>
    manifest.produces
      .filter(
        (scope): scope is AuthoritativeScope & { selector: string } => scope.selector !== undefined,
      )
      .map((scope) => ({ manifest, scope })),
  );
}

describe('shipped authoritative-scope selectors', () => {
  test('every selector compiles', () => {
    const problems = selected()
      .map(
        ({ manifest, scope }) =>
          [manifest.name, scope.scope, selectorProblem(scope.selector)] as const,
      )
      .filter(([, , problem]) => problem !== undefined);
    assert.deepEqual(problems, []);
  });

  test('every selector is classified as a path filter or a label', () => {
    for (const { manifest, scope } of selected()) {
      const isPath = scope.scope in PATH_FIXTURES;
      const isLabel = scope.scope in LABEL_SELECTORS;
      assert.ok(
        isPath !== isLabel,
        `${manifest.name} scope ${scope.scope} must be classified exactly once`,
      );
      const label = LABEL_SELECTORS[scope.scope];
      if (label !== undefined) assert.deepEqual([...scope.kinds].sort(), label.kinds, label.why);
    }
  });

  test('every pattern of a path selector covers a fixture path, and no selector claims a path it must not', () => {
    const checked = new Set<string>();
    for (const { manifest, scope } of selected()) {
      const fixture = PATH_FIXTURES[scope.scope];
      if (fixture === undefined) continue;
      checked.add(scope.scope);
      const compiled = compileSelector(scope.selector);
      for (const pattern of compiled.patterns) {
        const one = compileSelector(pattern);
        assert.ok(
          fixture.covers.some((path) => one.matches(path)),
          `${manifest.name}: pattern ${pattern} covers none of ${fixture.covers.join(', ')}`,
        );
      }
      for (const path of fixture.covers)
        assert.equal(compiled.matches(path), true, `${scope.scope} covers ${path}`);
      for (const path of fixture.never)
        assert.equal(compiled.matches(path), false, `${scope.scope} never claims ${path}`);
    }
    assert.deepEqual(
      [...checked].sort(),
      Object.keys(PATH_FIXTURES).sort(),
      'every path fixture is exercised',
    );
  });
});

describe('real extraction stays inside its own selector', () => {
  function assertForgettable(
    authoritative: ReadonlyArray<AuthoritativeScope>,
    nodes: ReadonlyArray<SeamlineNode>,
  ): number {
    let checked = 0;
    for (const scope of authoritative) {
      if (scope.selector === undefined) continue;
      const compiled = compileSelector(scope.selector);
      for (const node of nodes) {
        if (!scope.kinds.includes(node.kind) || node.path === undefined) continue;
        assert.ok(
          compiled.matches(node.path),
          `${node.id} at ${node.path} is outside ${scope.scope}'s selector`,
        );
        checked += 1;
      }
    }
    return checked;
  }

  test('extract-code-ts over the bundled example', () => {
    const out = extractCodeTs({
      repoRoot: EXAMPLE_ROOT,
      repo: 'harbor-books',
      runId: 'r1',
      deterministic: true,
    });
    assert.equal(out.result.status, 'PASS');
    assert.ok(
      assertForgettable(out.result.authoritative, out.nodes) > 0,
      'some path-bearing node was checked',
    );
  });

  test('extract-data over the bundled example', async () => {
    const out = await extractData({
      root: EXAMPLE_ROOT,
      repo: 'harbor-books',
      runId: 'r1',
      deterministic: true,
    });
    assert.equal(out.result.status, 'PASS');
    assert.ok(
      assertForgettable(out.result.authoritative, out.nodes) > 0,
      'some path-bearing node was checked',
    );
  });
});
