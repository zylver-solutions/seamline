import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError } from './errors.ts';
import {
  applyEdits,
  applyEditToContent,
  checkMutants,
  countOccurrences,
  isSafeRelativePath,
  judgeMutant,
  matchesExpectation,
  MutantEditError,
  parseMutants,
  replaceExactlyOnce,
} from './mutants.ts';
import { finding, makeTempDir, removeDir } from './testing.ts';

const REPOS = [
  { name: 'umami', partition: 'dev' as const },
  { name: 'rallly', partition: 'sealed' as const },
  { name: 'dokploy', partition: 'dev' as const },
];

function mutant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'umami-x1-board-description',
    repo: 'umami',
    detector: 'X1_NULLABILITY',
    description: 'Make the board description optional in the Zod schema.',
    edits: [{ path: 'src/lib/schema.ts', find: 'a', replace: 'b' }],
    expect: { code: 'X1_NULLABILITY' },
    ...overrides,
  };
}

test('replaceExactlyOnce replaces a single occurrence', () => {
  assert.equal(replaceExactlyOnce('one two three', 'two', '2', 'e'), 'one 2 three');
});

test('replaceExactlyOnce fails loudly when the text is not found', () => {
  assert.throws(
    () => replaceExactlyOnce('one two three', 'four', '4', 'edit 1 (a.ts)'),
    (e: unknown) => e instanceof MutantEditError && /edit 1 \(a\.ts\).*found 0/.test(e.message),
  );
});

test('replaceExactlyOnce fails loudly when the text occurs more than once', () => {
  assert.throws(
    () => replaceExactlyOnce('x = 1; x = 1;', 'x = 1', 'x = 2', 'e'),
    (e: unknown) => e instanceof MutantEditError && /found 2/.test(e.message),
  );
});

test('overlapping occurrences count as more than one', () => {
  assert.equal(countOccurrences('aaa', 'aa'), 2);
  assert.throws(() => replaceExactlyOnce('aaa', 'aa', 'b', 'e'), MutantEditError);
});

test('the replacement is inserted literally, not as a replacement pattern', () => {
  assert.equal(replaceExactlyOnce('price: X', 'X', '$& and $1', 'e'), 'price: $& and $1');
});

test('applyEdits applies replace and append edits in order', async () => {
  const root = await makeTempDir();
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'const a = 1;\n', 'utf8');
    await applyEdits(root, [
      { path: 'src/a.ts', find: 'const a = 1;', replace: 'const a = 2;' },
      { path: 'src/a.ts', append: 'export { a };\n' },
      { path: 'src/new/created.ts', append: 'export const created = true;\n' },
    ]);
    assert.equal(
      await readFile(path.join(root, 'src', 'a.ts'), 'utf8'),
      'const a = 2;\nexport { a };\n',
    );
    assert.equal(
      await readFile(path.join(root, 'src', 'new', 'created.ts'), 'utf8'),
      'export const created = true;\n',
    );
  } finally {
    await removeDir(root);
  }
});

test('applyEdits fails the mutant when a find string matches twice, and does not edit that file', async () => {
  const root = await makeTempDir();
  try {
    await writeFile(path.join(root, 'a.ts'), 'x = 1;\nx = 1;\n', 'utf8');
    await assert.rejects(
      applyEdits(root, [{ path: 'a.ts', find: 'x = 1;', replace: 'x = 2;' }]),
      /found 2/,
    );
    assert.equal(await readFile(path.join(root, 'a.ts'), 'utf8'), 'x = 1;\nx = 1;\n');
  } finally {
    await removeDir(root);
  }
});

test('applyEdits fails the mutant when the file does not exist', async () => {
  const root = await makeTempDir();
  try {
    await assert.rejects(
      applyEdits(root, [{ path: 'missing.ts', find: 'a', replace: 'b' }]),
      /does not exist/,
    );
  } finally {
    await removeDir(root);
  }
});

test('applyEdits refuses paths that leave the working tree', async () => {
  const root = await makeTempDir();
  try {
    for (const bad of ['../outside.ts', '/etc/passwd', 'a/../../b.ts', 'a\\b.ts', '']) {
      await assert.rejects(applyEdits(root, [{ path: bad, append: 'x' }]), MutantEditError, bad);
    }
  } finally {
    await removeDir(root);
  }
});

test('applyEdits refuses to write through a symbolic link', async () => {
  const root = await makeTempDir();
  const outside = await makeTempDir();
  try {
    await writeFile(path.join(outside, 'target.ts'), 'secret\n', 'utf8');
    await symlink(path.join(outside, 'target.ts'), path.join(root, 'link.ts'));
    await symlink(outside, path.join(root, 'linkdir'));
    await assert.rejects(applyEdits(root, [{ path: 'link.ts', append: 'x' }]), /symbolic link/);
    await assert.rejects(
      applyEdits(root, [{ path: 'linkdir/target.ts', append: 'x' }]),
      /symbolic link/,
    );
    assert.equal(await readFile(path.join(outside, 'target.ts'), 'utf8'), 'secret\n');
  } finally {
    await removeDir(root);
    await removeDir(outside);
  }
});

test('isSafeRelativePath accepts ordinary repository paths', () => {
  assert.equal(isSafeRelativePath('apps/web/src/app/api/v1/[...route]/route.ts'), true);
  assert.equal(isSafeRelativePath('packages/db/schema.ts'), true);
  assert.equal(isSafeRelativePath('./a.ts'), false);
  assert.equal(isSafeRelativePath('a//b.ts'), false);
  assert.equal(isSafeRelativePath('C:/x'), false);
});

test('parseMutants accepts a well-formed mutant and sorts by id', () => {
  const parsed = parseMutants(
    [
      mutant({ id: 'b-one' }),
      mutant({ id: 'a-two', edits: [{ path: 'new.sql', append: '\nALTER;' }] }),
    ],
    REPOS,
  );
  assert.deepEqual(
    parsed.map((m) => m.id),
    ['a-two', 'b-one'],
  );
});

test('parseMutants reports each configuration mistake by name', () => {
  assert.throws(
    () =>
      parseMutants(
        [
          mutant({ id: 'bad-repo', repo: 'nonexistent' }),
          mutant({ id: 'bad-code', detector: 'X99', expect: { code: 'X99' } }),
          mutant({ id: 'mismatch', expect: { code: 'X2_TYPE' } }),
          mutant({ id: 'noop', edits: [{ path: 'a.ts', find: 'same', replace: 'same' }] }),
          mutant({ id: 'both', edits: [{ path: 'a.ts', find: 'a', replace: 'b', append: 'c' }] }),
          mutant({ id: 'traversal', edits: [{ path: '../x.ts', append: 'c' }] }),
          mutant({ id: 'no-edits', edits: [] }),
          mutant({ id: 'dup' }),
          mutant({ id: 'dup' }),
        ],
        REPOS,
      ),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      for (const id of [
        'bad-repo',
        'bad-code',
        'mismatch',
        'noop',
        'both',
        'traversal',
        'no-edits',
        'dup',
      ]) {
        assert.ok(e.message.includes(id), `no complaint about ${id}: ${e.message}`);
      }
      return true;
    },
  );
});

test('a matching finding that the unmodified run already had is not a detection', () => {
  const existing = finding(
    'umami',
    'X1_NULLABILITY',
    'umami:Column:public.board.description',
    'umami:SchemaProperty:p',
  );
  const verdict = judgeMutant([existing], [existing], { code: 'X1_NULLABILITY' });
  assert.equal(verdict.detected, false);
  assert.equal(verdict.matched, null);
  assert.equal(verdict.newFindings.length, 0);
});

test('a new finding with the expected code is a detection', () => {
  const added = finding(
    'umami',
    'X1_NULLABILITY',
    'umami:Column:public.board.description',
    'umami:SchemaProperty:p',
  );
  const verdict = judgeMutant([], [added], { code: 'X1_NULLABILITY' });
  assert.equal(verdict.detected, true);
  assert.equal(verdict.matched?.id, added.id);
});

test('a new finding with a different code is not a detection', () => {
  const other = finding('umami', 'X2_TYPE', 'umami:Column:a', 'umami:SchemaProperty:b');
  const verdict = judgeMutant([], [other], { code: 'X1_NULLABILITY' });
  assert.equal(verdict.detected, false);
  assert.equal(verdict.newFindings.length, 1, 'the side effect is still visible');
});

test('leftMatch and rightMatch narrow which new finding counts', () => {
  const wrongColumn = finding(
    'umami',
    'X1_NULLABILITY',
    'umami:Column:public.user.email',
    'umami:SchemaProperty:p',
  );
  const rightColumn = finding(
    'umami',
    'X1_NULLABILITY',
    'umami:Column:public.board.description',
    'umami:SchemaProperty:q',
  );
  const expect = {
    code: 'X1_NULLABILITY' as const,
    leftMatch: 'board.description',
    rightMatch: ':q',
  };
  assert.equal(judgeMutant([], [wrongColumn], expect).detected, false);
  assert.equal(judgeMutant([], [wrongColumn, rightColumn], expect).detected, true);
  assert.equal(
    matchesExpectation(rightColumn, { code: 'X1_NULLABILITY', rightMatch: ':other' }),
    false,
  );
});

test('findings that the mutation made disappear are counted', () => {
  const gone = finding('umami', 'X2_TYPE', 'umami:Column:a', 'umami:SchemaProperty:b');
  const kept = finding('umami', 'X2_TYPE', 'umami:Column:c', 'umami:SchemaProperty:d');
  const verdict = judgeMutant([gone, kept], [kept], { code: 'X1_NULLABILITY' });
  assert.equal(verdict.lostFindings, 1);
});

test('checkMutants reports which mutants would fail to apply, without writing anything', async () => {
  const root = await makeTempDir();
  try {
    await mkdir(path.join(root, 'umami', 'src'), { recursive: true });
    await writeFile(path.join(root, 'umami', 'src', 'a.ts'), 'one two two\nthree\n', 'utf8');
    const parsed = parseMutants(
      [
        mutant({ id: 'applies', edits: [{ path: 'src/a.ts', find: 'three', replace: '3' }] }),
        mutant({ id: 'twice', edits: [{ path: 'src/a.ts', find: 'two', replace: '2' }] }),
        mutant({ id: 'absent', edits: [{ path: 'src/a.ts', find: 'four', replace: '4' }] }),
        mutant({ id: 'no-file', edits: [{ path: 'src/b.ts', find: 'x', replace: 'y' }] }),
        mutant({
          id: 'sequential',
          edits: [
            { path: 'src/a.ts', find: 'three', replace: '3' },
            { path: 'src/a.ts', find: '3', replace: 'III' },
            { path: 'src/new.ts', append: 'export {};\n' },
          ],
        }),
      ],
      REPOS,
    );
    const checks = await checkMutants(parsed, () => path.join(root, 'umami'));
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.problem]));
    assert.equal(byId['applies'], null);
    assert.match(byId['twice'] ?? '', /found 2/);
    assert.match(byId['absent'] ?? '', /found 0/);
    assert.match(byId['no-file'] ?? '', /does not exist/);
    assert.equal(
      byId['sequential'],
      null,
      'a later edit sees the result of an earlier one; append may create a file',
    );
    assert.equal(
      await readFile(path.join(root, 'umami', 'src', 'a.ts'), 'utf8'),
      'one two two\nthree\n',
    );
  } finally {
    await removeDir(root);
  }
});

const label = 'edit 1 (doc.json)';
const DOC = JSON.stringify({
  paths: { '/a/b': { get: { security: [{ key: [] }] } }, '/c': {} },
});

test('a pointer edit sets, removes, and renames by JSON Pointer, decoding ~1 and ~0', () => {
  const set = JSON.parse(
    applyEditToContent(
      DOC,
      { path: 'doc.json', pointer: '/paths/~1a~1b/get/security', set: [] },
      label,
    ),
  ) as { paths: Record<string, { get: { security: unknown[] } }> };
  assert.deepEqual(set.paths['/a/b']?.get.security, []);
  const removed = JSON.parse(
    applyEditToContent(DOC, { path: 'doc.json', pointer: '/paths/~1c', remove: true }, label),
  ) as { paths: Record<string, unknown> };
  assert.deepEqual(Object.keys(removed.paths), ['/a/b']);
  const renamed = JSON.parse(
    applyEditToContent(
      DOC,
      { path: 'doc.json', pointer: '/paths/~1a~1b', renameKey: '/a/z' },
      label,
    ),
  ) as { paths: Record<string, unknown> };
  assert.deepEqual(Object.keys(renamed.paths), ['/a/z', '/c'], 'the key is renamed in place');
  const text = applyEditToContent(
    DOC,
    { path: 'doc.json', pointer: '/paths/~1c', remove: true },
    label,
  );
  assert.ok(text.endsWith('\n'));
});

test('a pointer edit that does not resolve, or would overwrite, fails loudly', () => {
  const edit = (e: Record<string, unknown>) => () =>
    applyEditToContent(DOC, { path: 'doc.json', ...e } as never, label);
  assert.throws(edit({ pointer: '/paths/~1missing/get', set: 1 }), MutantEditError);
  assert.throws(edit({ pointer: '/paths/~1missing', remove: true }), /cannot be removed/);
  assert.throws(edit({ pointer: '/paths/~1missing', renameKey: 'x' }), /cannot be renamed/);
  assert.throws(edit({ pointer: '/paths/~1c', renameKey: '/a/b' }), /already exists/);
  assert.throws(
    () => applyEditToContent('not json', { path: 'doc.json', pointer: '/a', set: 1 }, label),
    /not valid JSON/,
  );
  assert.throws(
    () => applyEditToContent(undefined, { path: 'doc.json', pointer: '/a', set: 1 }, label),
    /does not exist/,
  );
});

test('parseMutants accepts pointer edits and refuses malformed ones', () => {
  const ok = parseMutants(
    [mutant({ edits: [{ path: 'a.json', pointer: '/x/y', set: null }] })],
    REPOS,
  );
  assert.deepEqual(ok[0]?.edits, [{ path: 'a.json', pointer: '/x/y', set: null }]);
  for (const edit of [
    { path: 'a.json', pointer: 'x/y', set: 1 },
    { path: 'a.json', pointer: '/x' },
    { path: 'a.json', pointer: '/x', set: 1, remove: true },
    { path: 'a.json', pointer: '/x', remove: false },
    { path: 'a.json', pointer: '/x', renameKey: '' },
    { path: 'a.json', pointer: '/x', find: 'a', replace: 'b' },
  ]) {
    assert.throws(
      () => parseMutants([mutant({ edits: [edit] })], REPOS),
      ConfigError,
      JSON.stringify(edit),
    );
  }
});

test('a pointer edit is applied to a real file and checked in memory the same way', async () => {
  const root = await makeTempDir();
  try {
    await writeFile(path.join(root, 'doc.json'), DOC, 'utf8');
    await applyEdits(root, [{ path: 'doc.json', pointer: '/paths/~1c', set: { x: 1 } }]);
    const after = JSON.parse(await readFile(path.join(root, 'doc.json'), 'utf8')) as {
      paths: Record<string, unknown>;
    };
    assert.deepEqual(after.paths['/c'], { x: 1 });
    const checks = await checkMutants(
      parseMutants([mutant({ edits: [{ path: 'doc.json', pointer: '/nope/x', set: 1 }] })], REPOS),
      () => root,
    );
    assert.match(checks[0]?.problem ?? '', /does not resolve/);
  } finally {
    await removeDir(root);
  }
});

test('a match on the wrong side of the finding is refused when the file is loaded', () => {
  // X4 reports the unbacked property on the left and a backed sibling's column on the right.
  assert.throws(
    () =>
      parseMutants(
        [
          mutant({
            detector: 'X4_UNBACKED_PROPERTY',
            expect: { code: 'X4_UNBACKED_PROPERTY', rightMatch: 'evalPhantomField' },
          }),
        ],
        REPOS,
      ),
    /rightMatch.*evalPhantomField.*wrong side/s,
  );
  // X10 reports the writing symbol on the left and the PII column on the right.
  assert.throws(
    () =>
      parseMutants(
        [
          mutant({
            detector: 'X10_UNTESTED_PII_WRITE',
            expect: { code: 'X10_UNTESTED_PII_WRITE', leftMatch: 'user.email' },
          }),
        ],
        REPOS,
      ),
    /leftMatch.*user\.email.*wrong side/s,
  );
  const ok = parseMutants(
    [
      mutant({
        id: 'a',
        detector: 'X4_UNBACKED_PROPERTY',
        expect: { code: 'X4_UNBACKED_PROPERTY', leftMatch: 'evalPhantomField' },
      }),
      mutant({
        id: 'b',
        detector: 'X10_UNTESTED_PII_WRITE',
        expect: { code: 'X10_UNTESTED_PII_WRITE', rightMatch: 'user.email' },
      }),
      mutant({
        id: 'c',
        detector: 'X1_NULLABILITY',
        expect: { code: 'X1_NULLABILITY', leftMatch: 'public.board.name' },
      }),
    ],
    REPOS,
  );
  assert.equal(ok.length, 3);
});

test('a mutant against a sealed repository is refused, and so is an unknown one', () => {
  assert.throws(() => parseMutants([mutant({ repo: 'rallly' })], REPOS), /sealed partition/);
  assert.throws(() => parseMutants([mutant({ repo: 'nowhere' })], REPOS), /corpus repository/);
  assert.equal(parseMutants([mutant({ repo: 'dokploy' })], REPOS).length, 1);
});
