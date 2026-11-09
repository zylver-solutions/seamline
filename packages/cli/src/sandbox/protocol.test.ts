import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROTOCOL_VERSION, isResponse, outputProblem } from './protocol.ts';
import { tidy } from './host.ts';

const node = { id: 'r:File:a', kind: 'File', provenance: 'EXTRACTED' };
const edge = { provenance: 'INFERRED' };
const result = {
  extractor: 'x',
  version: '1',
  status: 'PASS',
  authoritative: [{ scope: 's', kinds: ['File'] }],
  nodeCount: 1,
  edgeCount: 1,
  durationMs: 0,
  diagnostics: [],
};
const good = { result, nodes: [node], edges: [{ scope: 's', edges: [edge] }] };

describe('sandbox protocol / what the host accepts from a child', () => {
  it('accepts a well-formed output', () => {
    assert.equal(outputProblem(good), undefined);
  });

  const bad: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['not an object', 'PASS', /not an object/],
    ['no result', { nodes: [], edges: [] }, /result is missing/],
    ['an invented status', { ...good, result: { ...result, status: 'GREAT' } }, /status/],
    [
      'a count that is not a number',
      { ...good, result: { ...result, nodeCount: '1' } },
      /nodeCount/,
    ],
    [
      'diagnostics that are not strings',
      { ...good, result: { ...result, diagnostics: [1] } },
      /diagnostics/,
    ],
    [
      'a malformed scope claim',
      { ...good, result: { ...result, authoritative: [{ scope: 's' }] } },
      /malformed scope/,
    ],
    // An unknown provenance would sail through `PROVENANCE_RANK[p] > PROVENANCE_RANK[ceiling]`
    // (undefined > n is false), which is why it is refused before the ceiling is consulted.
    [
      'a node with an invented provenance',
      { ...good, nodes: [{ ...node, provenance: 'VERIFIED' }] },
      /nodes\[0\] has no valid provenance/,
    ],
    ['a node with no provenance', { ...good, nodes: [{ id: 'r:File:a' }] }, /nodes\[0\]/],
    [
      'a node with no kind',
      { ...good, nodes: [{ id: 'r:File:a', provenance: 'EXTRACTED' }] },
      /nodes\[0\] has no string id and kind/,
    ],
    [
      'a node whose id is not a string',
      { ...good, nodes: [{ ...node, id: 7 }] },
      /nodes\[0\] has no string id and kind/,
    ],
    [
      'an edge with an invented provenance',
      { ...good, edges: [{ scope: 's', edges: [{ provenance: 'GUESSED' }] }] },
      /edges\[0\]\.edges\[0\]/,
    ],
    [
      'an edge group without a scope',
      { ...good, edges: [{ edges: [] }] },
      /edges\[0\] has no scope/,
    ],
    ['nodes that are not an array', { ...good, nodes: {} }, /nodes is not an array/],
  ];
  for (const [name, output, pattern] of bad) {
    it(`refuses ${name}`, () => {
      assert.match(outputProblem(output) ?? 'accepted', pattern);
    });
  }

  it('recognises a response envelope, and nothing else', () => {
    assert.ok(isResponse({ v: PROTOCOL_VERSION, ok: true, output: good, denials: [] }));
    assert.ok(
      isResponse({
        v: PROTOCOL_VERSION,
        ok: false,
        failure: { kind: 'error', name: 'Error', message: 'x' },
        denials: [],
      }),
    );
    assert.ok(!isResponse({ v: 1, ok: true, output: good, denials: [] }));
    assert.ok(!isResponse({ v: PROTOCOL_VERSION, ok: true, denials: [] }));
    assert.ok(
      !isResponse({ v: PROTOCOL_VERSION, ok: false, failure: { kind: 'bogus' }, denials: [] }),
    );
    assert.ok(!isResponse(null));
  });

  it('takes the flag that says the guard log was full as a boolean or not at all', () => {
    const base = { v: PROTOCOL_VERSION, ok: true, output: good, denials: [] };
    assert.ok(isResponse({ ...base, denialsTruncated: true }));
    assert.ok(isResponse({ ...base, denialsTruncated: false }));
    assert.ok(!isResponse({ ...base, denialsTruncated: 'yes' }));
    assert.ok(!isResponse({ ...base, denialsTruncated: 1 }));
  });

  it('refuses malformed denial records before the host can dereference or rank them', () => {
    const denial = { code: 'path-not-declared', message: 'refused', fatal: true, access: 'content', count: 1 };
    const base = { v: PROTOCOL_VERSION, ok: true, output: good, denials: [denial] };
    assert.equal(isResponse(base), true);
    for (const malformed of [null, {}, { ...denial, code: 'invented' }, { ...denial, message: 1 },
      { ...denial, fatal: 'yes' }, { ...denial, access: 'write' }, { ...denial, count: 0 },
      { ...denial, count: 0.5 }, { ...denial, count: Number.MAX_SAFE_INTEGER + 1 }])
      assert.equal(isResponse({ ...base, denials: [malformed] }), false);
    for (const failure of [{ kind: 'violation', code: 'invented', message: 'refused' },
      { kind: 'error', message: 'refused' }, { kind: 'protocol', message: 1 }])
      assert.equal(isResponse({ ...base, ok: false, failure }), false);
  });
});

describe('sandbox host / diagnostics', () => {
  it("removes this machine's paths, control characters and excess length before a diagnostic is stored", () => {
    const line = tidy(
      'failed in /work/repo/src/a.ts\u0007\nsecond line\u001b[31m red',
      '/work/repo',
    );
    assert.equal(line, 'failed in <repo>/src/a.ts second line [31m red');
    assert.ok(tidy('x'.repeat(5000), '/work/repo').length <= 403);
  });
});
