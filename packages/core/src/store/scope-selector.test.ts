import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';

import fc from 'fast-check';

import { globToRegExp as readsGlobToRegExp } from '../security/sandbox.ts';
import {
  MAX_SELECTOR_PATTERNS,
  SelectorError,
  compileSelector,
  selectorHasExclusions,
  selectorParam,
  selectorPredicateSql,
  selectorProblem,
} from './scope-selector.ts';

const RUNS = 300;

function selects(selector: string, path: string): boolean {
  return compileSelector(selector).matches(path);
}

/** Evaluate a selector in real SQLite, through the predicate the store's sweep uses. */
function sqliteSelects(db: DatabaseSync, selector: string, paths: ReadonlyArray<string>): string[] {
  db.exec('DELETE FROM nodes');
  const insert = db.prepare('INSERT INTO nodes (path) VALUES (:path)');
  for (const path of paths) insert.run({ path });
  const rows = db
    .prepare(
      `SELECT path FROM nodes WHERE ${selectorPredicateSql('nodes.path', ':selector', selectorHasExclusions(compileSelector(selector)))} ORDER BY path`,
    )
    .all({ selector: selectorParam(compileSelector(selector)) }) as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

function scratchDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE nodes (path TEXT)');
  return db;
}

describe('compileSelector: brace expansion and lists', () => {
  test('a brace group expands to one pattern, and one clause, per alternative', () => {
    const compiled = compileSelector('**/*.{ts,tsx}');
    assert.deepEqual(compiled.patterns, ['**/*.ts', '**/*.tsx']);
    assert.deepEqual(compiled.clauses, [
      { glob: '*.ts', slashes: null, negated: false },
      { glob: '*.tsx', slashes: null, negated: false },
    ]);
  });

  test('several groups in one pattern expand to every combination', () => {
    assert.deepEqual(compileSelector('{src,lib}/**/*.{ts,js}').patterns, [
      'src/**/*.ts',
      'src/**/*.js',
      'lib/**/*.ts',
      'lib/**/*.js',
    ]);
  });

  test('top-level commas separate patterns; duplicates collapse', () => {
    const compiled = compileSelector('**/*.sql,**/*.prisma,**/*.sql');
    assert.deepEqual(compiled.patterns, ['**/*.sql', '**/*.prisma']);
    assert.equal(selects('**/*.sql,**/*.prisma', 'prisma/schema.prisma'), true);
  });

  test('a long brace group of literal paths selects exactly those paths', () => {
    const listed = Array.from({ length: 5000 }, (_, i) => `src/m${i}.ts`);
    const compiled = compileSelector(`{${[...listed, 'app/[id]/page.tsx'].join(',')}}`);
    assert.equal(compiled.patterns.length, 5001);
    assert.equal(compiled.matches('src/m0.ts'), true);
    assert.equal(compiled.matches('src/m4999.ts'), true);
    assert.equal(compiled.matches('app/[id]/page.tsx'), true);
    assert.equal(compiled.matches('src/m5000.ts'), false);
    assert.equal(
      compiled.matches('app/i/page.tsx'),
      false,
      '[id] is a literal, not a character class',
    );
  });
});

describe('compileSelector: matching', () => {
  test('a leading **/ compiles to a bare * and so matches root-level files', () => {
    assert.deepEqual(compileSelector('**/*.ts').clauses, [
      { glob: '*.ts', slashes: null, negated: false },
    ]);
    assert.equal(selects('**/*.ts', 'a.ts'), true, 'root level');
    assert.equal(selects('**/*.ts', 'src/a.ts'), true);
    assert.equal(selects('**/*.ts', 'src/deep/er/a.ts'), true);
  });

  test('no false match across unrelated extensions', () => {
    const code = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';
    for (const path of [
      'a.tsx.snap',
      'a.json',
      'README.md',
      'db/a.sql',
      'src/a.ts.map',
      'src/ts',
      'jsx',
    ]) {
      assert.equal(selects(code, path), false, path);
    }
    assert.equal(selects('**/*.ts', 'a.tsx'), false);
    assert.equal(selects('**/*.ts', 'a.mts'), false);
    assert.equal(selects('**/*.sql', 'data.sqlite'), false);
    assert.equal(selects('**/*.sql', 'a.psql'), false);
  });

  test('* and ? stay inside one segment, exactly as in a reads glob', () => {
    assert.deepEqual(compileSelector('src/app/*').clauses, [
      { glob: 'src/app/*', slashes: 2, negated: false },
    ]);
    assert.equal(selects('src/app/*', 'src/app/a.ts'), true);
    assert.equal(selects('src/app/*', 'src/app/deep/a.ts'), false);
    assert.equal(selects('*.ts', 'a.ts'), true);
    assert.equal(
      selects('*.ts', 'src/a.ts'),
      false,
      'without **, a root pattern stays at the root',
    );
    assert.equal(selects('src/?.ts', 'src/a.ts'), true);
    assert.equal(selects('src/?.ts', 'src/ab.ts'), false);
  });

  test('dir/** covers everything under dir and nothing that merely shares its prefix', () => {
    assert.equal(selects('src/**', 'src/a/b.ts'), true);
    assert.equal(selects('src/**', 'srcx/a.ts'), false);
    assert.equal(selects('**', 'anything/at/all'), true);
  });

  test('**/ before a literal path matches it at any depth, and only as whole segments', () => {
    assert.deepEqual(compileSelector('**/schema.prisma').clauses, [
      { glob: 'schema.prisma', slashes: null, negated: false },
      { glob: '*/schema.prisma', slashes: null, negated: false },
    ]);
    assert.equal(selects('**/schema.prisma', 'schema.prisma'), true);
    assert.equal(selects('**/schema.prisma', 'db/prisma/schema.prisma'), true);
    assert.equal(selects('**/schema.prisma', 'myschema.prisma'), false);
    assert.equal(selects('**/schema.prisma', 'db/myschema.prisma'), false);
  });

  test('matching is case-sensitive and literal outside the wildcards', () => {
    assert.equal(selects('**/*.ts', 'A.TS'), false);
    assert.equal(selects('a.b', 'axb'), false);
    assert.equal(selects('src/[id].ts', 'src/[id].ts'), true);
    assert.equal(selects('src/[id].ts', 'src/i.ts'), false);
  });
});

describe('compileSelector: what it refuses', () => {
  const invalid: ReadonlyArray<readonly [string, string]> = [
    ['', 'empty selector'],
    ['**/*.sql, **/*.prisma, Drizzle schema modules', 'whitespace at an end'],
    ['{a.ts, b.ts}', 'whitespace at an end'],
    ['a.ts,', 'empty pattern'],
    ['*.{ts,}', 'empty brace alternative'],
    ['{a,{b,c}}', 'braces do not nest'],
    ['a}', 'unbalanced'],
    ['{a,b', 'unclosed'],
    ['/src/a.ts', 'repo-relative'],
    ['src//a.ts', 'empty segment'],
    ['src/', 'empty segment'],
    ['../a.ts', '`..` segment'],
    ['./a.ts', '`.` segment'],
    ['src\\a.ts', 'backslash'],
    ['src/a\n.ts', 'control character'],
    ['src/**.ts', 'inside a segment'],
    ['**/src/**/*.ts', 'more than once'],
    ['*/**/*.ts', 'wildcard before'],
    ['**/a*b.ts', 'follows `**`'],
    ['**/*/index.ts', 'follows `**`'],
  ];
  for (const [selector, reason] of invalid) {
    test(`${JSON.stringify(selector)}: ${reason}`, () => {
      assert.throws(
        () => compileSelector(selector),
        (e: unknown) => {
          assert.ok(e instanceof SelectorError);
          assert.match(e.message, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          return true;
        },
      );
      assert.equal(typeof selectorProblem(selector), 'string');
    });
  }

  test('brace expansion is capped', () => {
    const group = `{${Array.from({ length: 400 }, (_, i) => `d${i}`).join(',')}}`;
    assert.ok(400 * 400 > MAX_SELECTOR_PATTERNS);
    assert.throws(() => compileSelector(`${group}/${group}.ts`), /more than 100000 patterns/);
  });

  test('a selector over path-less kinds, such as a revision range label, still parses', () => {
    assert.equal(selectorProblem('HEAD max=500'), undefined);
    assert.equal(selectorProblem('v1.0..origin/main max=3'), undefined);
    assert.equal(selectorProblem('MAPS_TO_FIELD|BACKED_BY'), undefined);
  });
});

// ---------------------------------------------------------------------------
// Properties: the compiled form means what the pattern says, and SQLite agrees.
// ---------------------------------------------------------------------------

const LITERAL = fc.constantFrom('a', 'b', 'ab', 'x.ts', '.ts', 'src', '[i]');
const SEGMENT_TOKEN = fc.oneof(LITERAL, fc.constant('*'), fc.constant('?'));
/** Adjacent stars collapse: `**` inside a segment is refused, and means `*` anyway. */
const WILD_SEGMENT = fc
  .array(SEGMENT_TOKEN, { minLength: 1, maxLength: 3 })
  .map((t) => t.join('').replace(/\*+/g, '*'));
const LITERAL_SEGMENTS = fc.array(LITERAL, { minLength: 0, maxLength: 2 });

/** Every form the grammar accepts, with no braces: the reads glob has no nesting either. */
const PATTERN = fc.oneof(
  fc.array(WILD_SEGMENT, { minLength: 1, maxLength: 3 }).map((s) => s.join('/')),
  fc
    .tuple(
      LITERAL_SEGMENTS,
      fc.oneof(
        fc.constant<string[]>([]),
        LITERAL.map((suffix) => [`*${suffix}`]),
        fc.array(LITERAL, { minLength: 1, maxLength: 2 }),
      ),
    )
    .map(([head, tail]) => [...head, '**', ...tail].join('/')),
);

const PATH_SEGMENT = fc.constantFrom(
  'a',
  'b',
  'ab',
  'x.ts',
  'a.ts',
  '.ts',
  'src',
  '[i]',
  'i',
  'srcx',
);
const PATH = fc.array(PATH_SEGMENT, { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));

describe('compiled selectors: properties', () => {
  test('a compiled pattern selects exactly what the same reads glob matches', () => {
    fc.assert(
      fc.property(PATTERN, fc.array(PATH, { minLength: 1, maxLength: 12 }), (pattern, paths) => {
        // The reads glob treats `[..]` as a class; the selector treats it as text.
        fc.pre(!pattern.includes('['));
        const compiled = compileSelector(pattern);
        const reads = readsGlobToRegExp(pattern);
        for (const path of paths)
          assert.equal(compiled.matches(path), reads.test(path), `${pattern} vs ${path}`);
      }),
      { numRuns: RUNS * 3 },
    );
  });

  test('SQLite evaluates the compiled clauses exactly as the in-memory matcher does', () => {
    const db = scratchDb();
    try {
      fc.assert(
        fc.property(
          fc.array(PATTERN, { minLength: 1, maxLength: 3 }),
          fc.array(PATH, { minLength: 1, maxLength: 12 }),
          (patterns, paths) => {
            const selector = patterns.join(',');
            const compiled = compileSelector(selector);
            const expected = [...new Set(paths)].filter((p) => compiled.matches(p)).sort();
            const actual = [...new Set(sqliteSelects(db, selector, paths))].sort();
            assert.deepEqual(actual, expected, selector);
          },
        ),
        { numRuns: RUNS },
      );
    } finally {
      db.close();
    }
  });

  test('a long literal list evaluates in SQLite, where an OR chain would exceed the depth limit', () => {
    const db = scratchDb();
    try {
      const listed = Array.from({ length: 3000 }, (_, i) => `src/m${i}.ts`);
      const selector = `{${listed.join(',')}}`;
      assert.deepEqual(sqliteSelects(db, selector, ['src/m2999.ts', 'src/m3000.ts', 'src/m0.ts']), [
        'src/m0.ts',
        'src/m2999.ts',
      ]);
    } finally {
      db.close();
    }
  });
});

describe('compileSelector: exclusions', () => {
  test('a path is selected when a positive pattern matches it and no exclusion does', () => {
    const selector = '**/*.{sql,prisma},!db/b.sql,!vendor/**';
    assert.equal(selects(selector, 'db/a.sql'), true);
    assert.equal(selects(selector, 'schema.prisma'), true);
    assert.equal(selects(selector, 'db/b.sql'), false);
    assert.equal(selects(selector, 'vendor/x/y.sql'), false);
    assert.equal(selects(selector, 'vendor.sql'), true);
    assert.equal(selects(selector, 'other/db/b.sql'), true);
  });

  test('item order does not matter, and brace groups work in an exclusion', () => {
    assert.equal(selects('!{a.sql,b.sql},**/*.sql', 'a.sql'), false);
    assert.equal(selects('!{a.sql,b.sql},**/*.sql', 'c.sql'), true);
    assert.equal(selects('**/*.sql,!{a.sql,b.sql}', 'b.sql'), false);
  });

  test('exclusions are not positive patterns', () => {
    assert.deepEqual(compileSelector('**/*.sql,!a.sql').patterns, ['**/*.sql']);
  });

  test('a selector that is only exclusions, or an empty exclusion, is refused', () => {
    assert.match(selectorProblem('!a.sql') ?? '', /no positive pattern/);
    assert.match(selectorProblem('**/*.sql,!') ?? '', /empty/);
    assert.match(selectorProblem('**/*.sql,! a.sql') ?? '', /whitespace/);
  });

  test('only an item that begins with `!` is an exclusion; `!` inside a brace group is a literal positive', () => {
    const inBrace = '{**/*.sql,!a.sql}';
    assert.deepEqual(compileSelector(inBrace).patterns, ['**/*.sql', '!a.sql']);
    assert.equal(selects(inBrace, 'a.sql'), true, 'a.sql is still selected by **/*.sql');
    assert.equal(selects(inBrace, '!a.sql'), true, 'the literal !a.sql is a positive pattern');
    // `!!a.sql` is the exclusion of the literal path `!a.sql`.
    assert.equal(selects('**/*.sql,!!a.sql', '!a.sql'), false);
    assert.equal(selects('**/*.sql,!!a.sql', 'a.sql'), true);
    // Before exclusions existed `!a.sql` alone was a literal positive; it is now refused.
    assert.match(selectorProblem('!a.sql') ?? '', /no positive pattern/);
  });

  test('a selector with no exclusion binds the SQL it always had, byte for byte', () => {
    const compiled = compileSelector('**/*.sql,db/x.ts');
    assert.equal(selectorHasExclusions(compiled), false);
    assert.equal(
      selectorPredicateSql('nodes.path', ':selector', false),
      `(nodes.path IS NOT NULL AND EXISTS (
    SELECT 1 FROM json_each(:selector) AS clause
    WHERE nodes.path GLOB json_extract(clause.value, '$[0]')
      AND (json_extract(clause.value, '$[1]') IS NULL
        OR length(nodes.path) - length(replace(nodes.path, '/', '')) = json_extract(clause.value, '$[1]'))))`,
    );
    assert.equal(selectorParam(compiled), '[["*.sql",null],["db/x.ts",1]]');
    assert.doesNotMatch(selectorPredicateSql('nodes.path', ':selector', false), /NOT EXISTS/);
    const withExclusion = compileSelector('**/*.sql,!db/x.sql');
    assert.equal(selectorHasExclusions(withExclusion), true);
    assert.match(selectorPredicateSql('nodes.path', ':selector', true), /NOT EXISTS/);
  });

  test('SQLite evaluates exclusions exactly as the in-memory matcher does', () => {
    const db = scratchDb();
    try {
      fc.assert(
        fc.property(
          fc.array(PATTERN, { minLength: 1, maxLength: 2 }),
          fc.array(PATTERN, { minLength: 0, maxLength: 2 }),
          fc.array(PATH, { minLength: 1, maxLength: 12 }),
          (positive, excluded, paths) => {
            const selector = [...positive, ...excluded.map((p) => `!${p}`)].join(',');
            const compiled = compileSelector(selector);
            const expected = [...new Set(paths)].filter((p) => compiled.matches(p)).sort();
            const actual = [...new Set(sqliteSelects(db, selector, paths))].sort();
            assert.deepEqual(actual, expected, selector);
          },
        ),
        { numRuns: RUNS },
      );
    } finally {
      db.close();
    }
  });
});
