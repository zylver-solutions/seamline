import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SifLine } from '@seamline/ontology';

import { CanonicalizationError } from './canonicalize.ts';
import { makeEdge, makeNode, makeResult, makeRun, shuffle } from './test-fixtures.ts';
import { canonicalSifOrder, streamSif, writeSif, writeSifAsync, writeSifTo } from './writer.ts';
import { SIF_FRAME } from './framing.ts';

function bodyLines(text: string): string[] {
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.shift(), SIF_FRAME);
  return lines;
}

function sample(): SifLine[] {
  const fileA = makeNode('File', 'src/a.ts', { path: 'src/a.ts' });
  const fileB = makeNode('File', 'src/b.ts', { path: 'src/b.ts' });
  const sym = makeNode('Symbol', 'src/a.ts#User', { path: 'src/a.ts' });
  const column = makeNode('Column', 'main.public.users.email');
  const codeField = makeNode('CodeField', 'src/a.ts#User.email', { path: 'src/a.ts' });
  return [
    { t: 'edge', edge: makeEdge('MAPS_TO_FIELD', column, codeField) },
    { t: 'node', node: sym },
    { t: 'status', result: makeResult() },
    { t: 'node', node: fileB },
    { t: 'edge', edge: makeEdge('IMPORTS', fileA, fileB) },
    { t: 'run', run: makeRun({ results: [makeResult()] }) },
    { t: 'node', node: fileA },
    { t: 'node', node: column },
    { t: 'node', node: codeField },
    { t: 'edge', edge: makeEdge('EXPORTS', fileA, sym) },
  ];
}

function types(text: string): string[] {
  return bodyLines(text)
    .map((l) => (JSON.parse(l) as { t: string }).t);
}

describe('writeSif — group order', () => {
  it('emits run, then status, then nodes, then edges', () => {
    assert.deepEqual(types(writeSif(sample())), [
      'run',
      'status',
      'node', 'node', 'node', 'node', 'node',
      'edge', 'edge', 'edge',
    ]);
  });

  it('orders nodes by id and edges by (src, dst, kind) within their group', () => {
    const lines = bodyLines(writeSif(sample()));
    const nodeIds = lines
      .map((l) => JSON.parse(l) as { t: string; node?: { id: string } })
      .filter((l) => l.t === 'node')
      .map((l) => l.node?.id ?? '');
    assert.deepEqual(nodeIds, [...nodeIds].sort());

    const edgeKeys = lines
      .map((l) => JSON.parse(l) as { t: string; edge?: { src: string; dst: string; kind: string } })
      .filter((l) => l.t === 'edge')
      .map((l) => `${l.edge?.src}|${l.edge?.dst}|${l.edge?.kind}`);
    assert.deepEqual(edgeKeys, [...edgeKeys].sort());
  });
});

describe('writeSif — determinism', () => {
  it('serializes two logically identical inputs presented in shuffled order to identical bytes', () => {
    const lines = sample();
    const baseline = writeSif(lines);
    for (let seed = 1; seed <= 20; seed++) {
      assert.equal(
        writeSif(shuffle(lines, seed)),
        baseline,
        `shuffle seed ${seed} produced different bytes`,
      );
    }
  });

  it('is unaffected by the key insertion order inside a node body', () => {
    const ordered = makeNode('File', 'src/a.ts', { path: 'src/a.ts', name: 'a.ts' });
    const reordered = JSON.parse(
      JSON.stringify({
        deletedAt: ordered.deletedAt,
        props: ordered.props,
        lastSeenRun: ordered.lastSeenRun,
        firstSeenRun: ordered.firstSeenRun,
        confidence: ordered.confidence,
        provenance: ordered.provenance,
        sensitivity: ordered.sensitivity,
        path: ordered.path,
        name: ordered.name,
        kind: ordered.kind,
        id: ordered.id,
      }),
    ) as typeof ordered;
    assert.equal(
      writeSif([{ t: 'node', node: reordered }]),
      writeSif([{ t: 'node', node: ordered }]),
    );
  });

  it('terminates every line with \\n, including the last', () => {
    const text = writeSif(sample());
    assert.ok(text.endsWith('\n'));
    assert.ok(!text.includes('\r'));
    assert.equal(text.split('\n').length - 1, sample().length + 1);
  });

  it('frames an empty document without inventing a record', () => {
    assert.equal(writeSif([]), `${SIF_FRAME}\n`);
  });
});

describe('writeSif — rejection', () => {
  it('rejects an absolute path and writes nothing', () => {
    const sink: string[] = [];
    assert.throws(
      () =>
        writeSif([
          { t: 'node', node: makeNode('File', 'src/a.ts') },
          { t: 'node', node: makeNode('File', 'src/b.ts', { path: '/home/example/repo/src/b.ts' }) },
        ]),
      (e: unknown) => e instanceof CanonicalizationError && e.field === 'node.path',
    );
    assert.equal(sink.length, 0);
  });

  it('rejects a stray timestamp before emitting a partial file', async () => {
    const sink: string[] = [];
    await assert.rejects(
      writeSifTo({ write: (c: string) => sink.push(c) }, [
        { t: 'node', node: makeNode('File', 'src/a.ts') },
        { t: 'node', node: makeNode('File', 'src/b.ts', { updatedAt: '2026-01-01' }) },
      ]),
      (e: unknown) => e instanceof CanonicalizationError && e.field === 'node.updatedAt',
    );
    assert.equal(sink.length, 0, 'nothing may be written when any line is invalid');
  });
});

describe('writeSif — alternative entry points', () => {
  it('writeSifAsync over an async iterable matches writeSif', async () => {
    async function* source(): AsyncGenerator<SifLine> {
      for (const line of shuffle(sample(), 7)) yield line;
    }
    assert.equal(await writeSifAsync(source()), writeSif(sample()));
  });

  it('streamSif yields the same bytes chunk by chunk', async () => {
    const chunks: string[] = [];
    for await (const chunk of streamSif(shuffle(sample(), 3))) chunks.push(chunk);
    assert.equal(chunks.join(''), writeSif(sample()));
    assert.equal(chunks.length, sample().length + 1);
  });

  it('writeSifTo writes into a sink and returns the line count', async () => {
    const sink: string[] = [];
    const count = await writeSifTo({ write: (c: string) => sink.push(c) }, sample());
    assert.equal(count, sample().length);
    assert.equal(sink.join(''), writeSif(sample()));
  });

  it('canonicalSifOrder returns line texts without terminators', () => {
    const ordered = canonicalSifOrder(sample());
    assert.equal(ordered.length, sample().length);
    assert.ok(ordered.every((l) => !l.includes('\n')));
  });
});
