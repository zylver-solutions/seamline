import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AliasTable } from './alias.ts';
import { fileName, makeNodeId, symbolName } from './canonical.ts';
import {
  DEFAULT_RENAME_SIMILARITY,
  applyRenames,
  ingestColumnRenames,
  ingestFileRenames,
  ingestSymbolRenames,
  parseGitRenameStatus,
  retiredKind,
  type GitRenameRecord,
} from './rename.ts';

const OPTS = { repo: 'seamline', runId: 'r02' } as const;

describe('parseGitRenameStatus', () => {
  test('normalizes git 0-100 similarity into [0, 1]', () => {
    assert.deepEqual(parseGitRenameStatus('R096\tsrc/a.ts\tlib/a.ts'), {
      from: 'src/a.ts',
      to: 'lib/a.ts',
      similarity: 0.96,
    });
    assert.deepEqual(parseGitRenameStatus('R100\ta\tb')?.similarity, 1);
  });

  test('returns null for a non-rename status line', () => {
    assert.equal(parseGitRenameStatus('M\tsrc/a.ts'), null);
    assert.equal(parseGitRenameStatus('A\tsrc/a.ts'), null);
    assert.equal(parseGitRenameStatus(''), null);
  });

  test('throws on a similarity git could not have produced', () => {
    assert.throws(() => parseGitRenameStatus('R101\ta\tb'), /malformed git rename status/);
  });
});

describe('ingestFileRenames', () => {
  test('a high-similarity rename becomes an alias row', () => {
    const { aliases, rejected } = ingestFileRenames([{ from: 'src/a.ts', to: 'lib/a.ts', similarity: 0.96 }], OPTS);
    assert.equal(rejected.length, 0);
    assert.equal(aliases.length, 1);
    assert.deepEqual(aliases[0], {
      from: makeNodeId('seamline', 'File', 'src/a.ts'),
      to: makeNodeId('seamline', 'File', 'lib/a.ts'),
      runId: 'r02',
      confidence: 0.96,
      reason: 'git-rename',
    });
    assert.equal(retiredKind(aliases[0]!.from), 'File');
  });

  test('a rename below the similarity threshold is not an alias', () => {
    const record: GitRenameRecord = { from: 'src/a.ts', to: 'lib/z.ts', similarity: 0.2 };
    const { aliases, rejected } = ingestFileRenames([record], OPTS);
    assert.equal(aliases.length, 0);
    assert.deepEqual(rejected, [{ record, reason: 'below-threshold' }]);
    assert.equal(DEFAULT_RENAME_SIMILARITY, 0.6);
  });

  test('the threshold is overridable per call', () => {
    const record: GitRenameRecord = { from: 'src/a.ts', to: 'lib/z.ts', similarity: 0.2 };
    const { aliases } = ingestFileRenames([record], { ...OPTS, similarityThreshold: 0.1 });
    assert.equal(aliases.length, 1);
    assert.equal(aliases[0]?.confidence, 0.2);
  });

  test('identical content promotes a low-similarity pair and raises confidence to 1', () => {
    const hashes = new Map([
      ['src/a.ts', 'sha256:abc'],
      ['lib/a.ts', 'sha256:abc'],
    ]);
    const { aliases, rejected } = ingestFileRenames(
      [{ from: 'src/a.ts', to: 'lib/a.ts', similarity: 0.1 }],
      { ...OPTS, contentHashes: hashes },
    );
    assert.equal(rejected.length, 0);
    assert.equal(aliases[0]?.confidence, 1);
    assert.equal(aliases[0]?.reason, 'content-hash');
  });

  test('a differing content hash does not demote a high-similarity rename', () => {
    const hashes = new Map([
      ['src/a.ts', 'sha256:abc'],
      ['lib/a.ts', 'sha256:def'],
    ]);
    const { aliases } = ingestFileRenames(
      [{ from: 'src/a.ts', to: 'lib/a.ts', similarity: 0.9 }],
      { ...OPTS, contentHashes: hashes },
    );
    assert.equal(aliases[0]?.reason, 'git-rename');
    assert.equal(aliases[0]?.confidence, 0.9);
  });

  test('a no-op rename is rejected rather than producing a self-alias', () => {
    const record: GitRenameRecord = { from: 'src/a.ts', to: 'src/a.ts', similarity: 1 };
    const { aliases, rejected } = ingestFileRenames([record], OPTS);
    assert.equal(aliases.length, 0);
    assert.deepEqual(rejected, [{ record, reason: 'identical-endpoints' }]);
  });

  test('output order does not depend on input order', () => {
    const records: GitRenameRecord[] = [
      { from: 'z.ts', to: 'z2.ts', similarity: 0.9 },
      { from: 'a.ts', to: 'a2.ts', similarity: 0.9 },
      { from: 'm.ts', to: 'm2.ts', similarity: 0.9 },
    ];
    const forward = ingestFileRenames(records, OPTS).aliases;
    const backward = ingestFileRenames([...records].reverse(), OPTS).aliases;
    assert.deepEqual(forward, backward);
  });

  test('an out-of-range similarity is a hard error, not a silent clamp', () => {
    assert.throws(
      () => ingestFileRenames([{ from: 'a.ts', to: 'b.ts', similarity: 96 }], OPTS),
      /use parseGitRenameStatus to normalize/,
    );
  });
});

describe('ingestSymbolRenames and ingestColumnRenames', () => {
  test('a symbol rename produces a Symbol alias, and a same-name move produces none', () => {
    const { aliases } = ingestSymbolRenames(
      [
        {
          from: { module: '@seamline/core', qualifiedName: ['UserService', 'find'] },
          to: { module: '@seamline/core', qualifiedName: ['UserService', 'findById'] },
        },
      ],
      OPTS,
    );
    assert.equal(aliases.length, 1);
    assert.equal(
      aliases[0]?.from,
      makeNodeId('seamline', 'Symbol', symbolName({ module: '@seamline/core', qualifiedName: ['UserService', 'find'] })),
    );

    const moved = ingestSymbolRenames(
      [
        {
          from: { module: '@seamline/core', qualifiedName: ['UserService'] },
          to: { module: '@seamline/core', qualifiedName: ['UserService'] },
        },
      ],
      OPTS,
    );
    assert.equal(moved.aliases.length, 0);
    assert.equal(moved.rejected[0]?.reason, 'identical-endpoints');
  });

  test('a column rename produces a Column alias', () => {
    const { aliases } = ingestColumnRenames(
      [
        {
          from: { schema: 'public', table: 'users', column: 'email' },
          to: { schema: 'public', table: 'users', column: 'email_address' },
        },
      ],
      OPTS,
    );
    assert.equal(aliases[0]?.from, makeNodeId('seamline', 'Column', 'public.users.email'));
    assert.equal(aliases[0]?.to, makeNodeId('seamline', 'Column', 'public.users.email_address'));
  });
});

describe('applyRenames', () => {
  test('a two-run rename chain resolves the original path to the current one', () => {
    const table = new AliasTable();
    applyRenames(table, ingestFileRenames([{ from: 'a.ts', to: 'b.ts', similarity: 1 }], { ...OPTS, runId: 'r02' }));
    applyRenames(table, ingestFileRenames([{ from: 'b.ts', to: 'c.ts', similarity: 1 }], { ...OPTS, runId: 'r03' }));
    assert.equal(table.resolveId(makeNodeId('seamline', 'File', fileName('a.ts'))), makeNodeId('seamline', 'File', 'c.ts'));
    assert.equal(table.size, 2);
  });
});
