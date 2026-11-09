import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCleanEdgeBody,
  assertCleanNodeBody,
  assertRepoRelativePosix,
  CanonicalizationError,
  canonicalPath,
  canonicalSifLine,
  canonicalStringify,
  compareCodeUnits,
  formatNumber,
  isPathField,
  isTimestampField,
  quoteString,
  sortEdges,
  sortNodes,
} from './canonicalize.ts';
import { makeEdge, makeNode, shuffle } from './test-fixtures.ts';

describe('canonicalStringify — key order', () => {
  it('sorts object keys at every depth', () => {
    const value = { b: 1, a: { z: 1, y: { n: 2, m: 3 } }, c: [{ q: 1, p: 2 }] };
    assert.equal(canonicalStringify(value), '{"a":{"y":{"m":3,"n":2},"z":1},"b":1,"c":[{"p":2,"q":1}]}');
  });

  it('produces identical bytes for the same object built in a different key order', () => {
    const left = { alpha: 1, beta: { x: true, y: null }, gamma: 'g' };
    const right = { gamma: 'g', beta: { y: null, x: true }, alpha: 1 };
    assert.equal(canonicalStringify(left), canonicalStringify(right));
  });

  it('preserves array order, because an array order is data', () => {
    assert.equal(canonicalStringify([3, 1, 2]), '[3,1,2]');
  });

  it('drops undefined properties and rejects undefined array elements', () => {
    assert.equal(canonicalStringify({ a: 1, b: undefined }), '{"a":1}');
    assert.throws(
      () => canonicalStringify({ a: [1, undefined] }),
      (e: unknown) => e instanceof CanonicalizationError && e.field === 'a[1]',
    );
  });
});

describe('canonicalStringify — numbers', () => {
  it('gives 1.0 and 1 the same text', () => {
    assert.equal(canonicalStringify({ c: 1.0 }), canonicalStringify({ c: 1 }));
    assert.equal(canonicalStringify({ c: 1.0 }), '{"c":1}');
  });

  it('normalizes negative zero', () => {
    assert.equal(formatNumber(-0, 'x'), '0');
    assert.equal(canonicalStringify(-0), '0');
  });

  it('never uses exponent notation for representable integers', () => {
    assert.equal(formatNumber(1e20, 'x'), '100000000000000000000');
    assert.equal(formatNumber(-1234567, 'x'), '-1234567');
  });

  it('keeps fractional values in shortest round-trip form', () => {
    assert.equal(formatNumber(0.85, 'x'), '0.85');
    assert.equal(Number(formatNumber(0.1 + 0.2, 'x')), 0.1 + 0.2);
  });

  it('rejects NaN and Infinity instead of silently emitting null', () => {
    assert.equal(JSON.stringify({ x: NaN }), '{"x":null}');
    assert.throws(() => canonicalStringify({ x: NaN }), CanonicalizationError);
    assert.throws(() => canonicalStringify({ x: Infinity }), CanonicalizationError);
  });
});

describe('canonicalStringify — strings', () => {
  it('escapes controls, quotes and backslashes exactly as JSON requires', () => {
    assert.equal(quoteString('a"b\\c\nd\te\u0001'), '"a\\"b\\\\c\\nd\\te\\u0001"');
  });

  it('emits non-ASCII literally rather than as \\u escapes', () => {
    assert.equal(quoteString('café ✓ 😀'), '"café ✓ 😀"');
  });

  it('escapes lone surrogates so the output is always well-formed UTF-8', () => {
    assert.equal(quoteString('\ud800'), '"\\ud800"');
    assert.equal(quoteString('a\udfffb'), '"a\\udfffb"');
    assert.equal(quoteString('\ud83d\ude00'), '"😀"');
  });
});

describe('canonicalStringify — values with no deterministic JSON form', () => {
  it('rejects a Date, which is how wall-clock time gets back into a fact', () => {
    assert.throws(
      () => canonicalStringify({ x: new Date(0) }),
      (e: unknown) => e instanceof CanonicalizationError && /Run record/.test(e.message),
    );
  });

  it('rejects Map and Set, which JSON.stringify silently empties', () => {
    assert.equal(JSON.stringify({ m: new Map([['a', 1]]) }), '{"m":{}}');
    assert.throws(() => canonicalStringify({ m: new Map([['a', 1]]) }), CanonicalizationError);
    assert.throws(() => canonicalStringify({ s: new Set([1]) }), CanonicalizationError);
  });

  it('reports a circular reference instead of overflowing the stack', () => {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle['self'] = cycle;
    assert.throws(
      () => canonicalStringify(cycle),
      (e: unknown) => e instanceof CanonicalizationError && e.field === 'self',
    );
  });
});

describe('compareCodeUnits', () => {
  it('orders by UTF-16 code unit, not by locale', () => {
    assert.equal(compareCodeUnits('Z', 'a'), -1);
    assert.equal(compareCodeUnits('a', 'a'), 0);
    assert.equal(compareCodeUnits('b', 'a'), 1);
  });
});

describe('canonicalPath', () => {
  it('converts Windows separators to POSIX', () => {
    assert.equal(canonicalPath('src\\lib\\a.ts'), 'src/lib/a.ts');
  });

  it('makes an absolute path relative to repoRoot', () => {
    assert.equal(canonicalPath('/home/example/repo/src/a.ts', '/home/example/repo'), 'src/a.ts');
    assert.equal(canonicalPath('D:\\work\\repo\\src\\a.ts', 'D:/work/repo'), 'src/a.ts');
  });

  it('refuses an absolute path with no repoRoot, rather than guessing', () => {
    assert.throws(() => canonicalPath('/etc/passwd'), CanonicalizationError);
  });

  it('refuses an absolute path outside repoRoot', () => {
    assert.throws(() => canonicalPath('/other/a.ts', '/home/example/repo'), CanonicalizationError);
  });

  it('collapses . and .. within the root and refuses to escape it', () => {
    assert.equal(canonicalPath('./src/./lib/../a.ts'), 'src/a.ts');
    assert.throws(() => canonicalPath('../outside/a.ts'), CanonicalizationError);
    assert.throws(() => canonicalPath('src/../../a.ts'), CanonicalizationError);
  });

  it('strips doubled and trailing separators', () => {
    assert.equal(canonicalPath('src//lib///a.ts'), 'src/lib/a.ts');
    assert.equal(canonicalPath('src/lib/'), 'src/lib');
  });

  it('is idempotent', () => {
    const once = canonicalPath('.\\src\\a.ts');
    assert.equal(canonicalPath(once), once);
  });
});

describe('assertRepoRelativePosix', () => {
  it('rejects an absolute POSIX path', () => {
    assert.throws(
      () => assertRepoRelativePosix('/etc/passwd', 'node.path'),
      (e: unknown) => e instanceof CanonicalizationError && /absolute/.test(e.message) && e.field === 'node.path',
    );
  });

  it('rejects a Windows drive path and a UNC path', () => {
    assert.throws(() => assertRepoRelativePosix('C:/repo/a.ts', 'node.path'), CanonicalizationError);
    assert.throws(() => assertRepoRelativePosix('\\\\server\\share\\a.ts', 'node.path'), CanonicalizationError);
  });

  it('rejects any backslash', () => {
    assert.throws(
      () => assertRepoRelativePosix('src\\a.ts', 'node.path'),
      (e: unknown) => e instanceof CanonicalizationError && /backslash/.test(e.message),
    );
  });

  it('rejects a .. segment while allowing .. inside a name', () => {
    assert.throws(() => assertRepoRelativePosix('../a.ts', 'node.path'), CanonicalizationError);
    assert.throws(() => assertRepoRelativePosix('src/../a.ts', 'node.path'), CanonicalizationError);
    assert.doesNotThrow(() => assertRepoRelativePosix('src/a..b.ts', 'node.path'));
  });

  it('rejects a home-relative path', () => {
    assert.throws(() => assertRepoRelativePosix('~/repo/a.ts', 'node.path'), CanonicalizationError);
  });
});

describe('timestamp and path field detection', () => {
  it('treats deletedAt as the one contract-sanctioned time field', () => {
    assert.equal(isTimestampField('deletedAt'), false);
    assert.equal(isTimestampField('createdAt'), true);
    assert.equal(isTimestampField('updatedAt'), true);
    assert.equal(isTimestampField('extracted_at'), true);
    assert.equal(isTimestampField('timestamp'), true);
    assert.equal(isTimestampField('mtime'), true);
  });

  it('does not flag ordinary fields that happen to end in "at"', () => {
    assert.equal(isTimestampField('format'), false);
    assert.equal(isTimestampField('repeat'), false);
    assert.equal(isTimestampField('runtime'), false);
  });

  it('detects path fields on a word boundary, so "profile" is not a path', () => {
    assert.equal(isPathField('path'), true);
    assert.equal(isPathField('srcFile'), true);
    assert.equal(isPathField('src_file'), true);
    assert.equal(isPathField('profile'), false);
    assert.equal(isPathField('name'), false);
  });
});

describe('assertCleanNodeBody / assertCleanEdgeBody', () => {
  it('accepts a well-formed node', () => {
    assert.doesNotThrow(() => assertCleanNodeBody(makeNode('File', 'src/a.ts', { path: 'src/a.ts' })));
  });

  it('rejects a node carrying a stray createdAt', () => {
    assert.throws(
      () => assertCleanNodeBody(makeNode('File', 'src/a.ts', { createdAt: '2026-01-01T00:00:00Z' })),
      (e: unknown) =>
        e instanceof CanonicalizationError &&
        e.field === 'node.createdAt' &&
        /belongs to the Run record/.test(e.message),
    );
  });

  it('rejects a timestamp hidden inside props', () => {
    assert.throws(
      () => assertCleanNodeBody(makeNode('File', 'src/a.ts', { props: { scannedAt: '2026-01-01' } })),
      (e: unknown) => e instanceof CanonicalizationError && e.field === 'node.props.scannedAt',
    );
  });

  it('rejects an absolute node path', () => {
    assert.throws(
      () => assertCleanNodeBody(makeNode('File', 'src/a.ts', { path: '/home/example/repo/src/a.ts' })),
      (e: unknown) => e instanceof CanonicalizationError && e.field === 'node.path',
    );
  });

  it('rejects a backslash path on an edge endpoint file', () => {
    const a = makeNode('File', 'src/a.ts');
    const b = makeNode('File', 'src/b.ts');
    assert.throws(
      () => assertCleanEdgeBody(makeEdge('IMPORTS', a, b, { srcFile: 'src\\a.ts' })),
      (e: unknown) => e instanceof CanonicalizationError && e.field === 'edge.srcFile',
    );
  });

  it('allows deletedAt, which the run lifecycle owns', () => {
    assert.doesNotThrow(() =>
      assertCleanNodeBody(makeNode('File', 'src/a.ts', { deletedAt: '2026-01-01T00:00:00.000Z' })),
    );
  });
});

describe('canonicalSifLine', () => {
  it('is the enforcement point for the determinism rules', () => {
    assert.throws(
      () => canonicalSifLine({ t: 'node', node: makeNode('File', 'src/a.ts', { path: '/abs/a.ts' }) }),
      CanonicalizationError,
    );
  });

  it('emits sorted keys for a node line', () => {
    const text = canonicalSifLine({ t: 'node', node: makeNode('File', 'src/a.ts') });
    assert.ok(text.startsWith('{"node":{"confidence":1,"deletedAt":null,'), text);
    assert.ok(text.endsWith(',"t":"node"}'), text);
  });
});

describe('sortNodes / sortEdges', () => {
  it('is a total order: nodes with the same id but different bodies still order stably', () => {
    const a = makeNode('File', 'src/a.ts', { name: 'first' });
    const b = makeNode('File', 'src/a.ts', { name: 'second' });
    const forwards = sortNodes([a, b]).map((n) => n.name);
    const backwards = sortNodes([b, a]).map((n) => n.name);
    assert.deepEqual(forwards, backwards);
  });

  it('orders nodes by id and edges by (src, dst, kind) regardless of input order', () => {
    const nodes = [
      makeNode('File', 'src/c.ts'),
      makeNode('File', 'src/a.ts'),
      makeNode('File', 'src/b.ts'),
    ];
    const expected = sortNodes(nodes).map((n) => n.id);
    for (let seed = 1; seed <= 5; seed++) {
      assert.deepEqual(sortNodes(shuffle(nodes, seed)).map((n) => n.id), expected);
    }

    const a = makeNode('File', 'src/a.ts');
    const b = makeNode('File', 'src/b.ts');
    const sym = makeNode('Symbol', 'src/a.ts#T');
    const edges = [
      makeEdge('EXPORTS', a, sym),
      makeEdge('IMPORTS', a, b),
      makeEdge('RENAMED_FROM', a, b),
    ];
    const expectedEdges = sortEdges(edges).map((e) => `${e.src}|${e.dst}|${e.kind}`);
    for (let seed = 1; seed <= 5; seed++) {
      assert.deepEqual(
        sortEdges(shuffle(edges, seed)).map((e) => `${e.src}|${e.dst}|${e.kind}`),
        expectedEdges,
      );
    }
    assert.deepEqual(expectedEdges, [
      'demo:File:src/a.ts|demo:File:src/b.ts|IMPORTS',
      'demo:File:src/a.ts|demo:File:src/b.ts|RENAMED_FROM',
      'demo:File:src/a.ts|demo:Symbol:src/a.ts#T|EXPORTS',
    ]);
  });
});
