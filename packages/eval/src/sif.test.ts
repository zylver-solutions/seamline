import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { countSifFile, countSifLines, readSifNodeLines } from './sif.ts';
import { makeTempDir, removeDir } from './testing.ts';

async function* lines(items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item;
}

test('evaluation counters retain v2 node counts and refuse unsupported or misplaced framing', async () => {
  const node = '{"node":{"id":"app:Table:x","kind":"Table","path":"db.sql"},"t":"node"}';
  assert.deepEqual((await countSifLines(lines(['seamline-sif/2.0.0', node]))).nodes, { Table: 1 });
  assert.deepEqual([...await readSifNodeLines(lines(['seamline-sif/2.0.0', node]), new Set(['app:Table:x']))], [['app:Table:x', 'db.sql']]);
  for (const input of [['seamline-sif/9.0.0', node], [node, 'seamline-sif/2.0.0'], ['seamline-sif/2.0.0', node, 'seamline-sif/2.0.0']]) {
    await assert.rejects(countSifLines(lines(input)), /framing/);
    await assert.rejects(readSifNodeLines(lines(input), new Set(['app:Table:x'])), /framing/);
  }
});

test('countSifLines counts nodes and edges by kind, with sorted keys', async () => {
  const counts = await countSifLines(
    lines([
      '{"t":"sif","version":"1","runId":"r"}',
      '{"t":"status","result":{"extractor":"x"}}',
      '{"t":"node","node":{"id":"a","kind":"Table"}}',
      '{"t":"node","node":{"id":"b","kind":"Column"}}',
      '{"t":"node","node":{"id":"c","kind":"Column"}}',
      '',
      '{"t":"edge","edge":{"kind":"CONTAINS"}}',
      '{"t":"edge","edge":{"kind":"CONTAINS"}}',
      '{"t":"edge","edge":{"kind":"BACKED_BY"}}',
    ]),
  );
  assert.deepEqual(counts.nodes, { Column: 2, Table: 1 });
  assert.deepEqual(Object.keys(counts.nodes), ['Column', 'Table']);
  assert.deepEqual(counts.edges, { BACKED_BY: 1, CONTAINS: 2 });
});

test('countSifLines refuses a line that is not JSON instead of undercounting', async () => {
  await assert.rejects(
    countSifLines(lines(['{"t":"node","node":{"kind":"Table"}}', '{broken'])),
    /line 2/,
  );
});

test('countSifFile streams a file from disk', async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir, 'run.sif');
    await writeFile(
      file,
      '{"t":"node","node":{"kind":"Symbol"}}\n{"t":"node","node":{"kind":"Symbol"}}\n',
      'utf8',
    );
    assert.deepEqual((await countSifFile(file)).nodes, { Symbol: 2 });
  } finally {
    await removeDir(dir);
  }
});

test('readSifNodeLines finds the wanted nodes only, preferring sourceRef over path', async () => {
  const found = await readSifNodeLines(
    lines([
      '{"runId":"r","t":"sif","version":"1"}',
      '{"node":{"id":"a:Column:x","kind":"Column","path":"p.sql","sourceRef":"p.sql:7"},"t":"node"}',
      '{"node":{"id":"a:Table:y","kind":"Table","path":"q.sql"},"t":"node"}',
      '{"node":{"id":"a:Table:other","kind":"Table","sourceRef":"z.sql:1"},"t":"node"}',
      '{"edge":{"kind":"CONTAINS","src":"a:Table:y","dst":"a:Column:x"},"t":"edge"}',
      'not json at all',
    ]),
    new Set(['a:Column:x', 'a:Table:y', 'a:Table:missing']),
  );
  assert.deepEqual([...found.entries()].sort(), [
    ['a:Column:x', 'p.sql:7'],
    ['a:Table:y', 'q.sql'],
  ]);
});
