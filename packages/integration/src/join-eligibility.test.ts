import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { memoryGraphIndex } from '@seamline/core';
import { extractCodeTs } from '@seamline/extract-code-ts';
import { extractContracts } from '@seamline/extract-contracts';
import { extractData } from '@seamline/extract-data';
import { inferJoins } from '@seamline/infer-join';

test('application moves preserve identities and joins; a fixture move changes only join eligibility', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seamline-join-move-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@fixture/app', version: '1' }));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ESNext', module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['src/**/*.ts'] }));
    writeFileSync(join(root, 'schema.sql'), 'CREATE TABLE posts (title text);\n');
    writeFileSync(join(root, 'empty.schema.json'), JSON.stringify({ title: 'Empty', type: 'object', properties: {} }));
    writeFileSync(join(root, 'src/post.ts'), 'export interface Post { title: string }\n');
    const snapshot = async () => {
      const code = extractCodeTs({ repoRoot: root, repo: 'moves', runId: 'run', deterministic: true });
      const data = await extractData({ root, repo: 'moves', runId: 'run', deterministic: true });
      const contracts = extractContracts({ repoRoot: root, repo: 'moves', runId: 'run' });
      const index = memoryGraphIndex();
      for (const output of [code, data, contracts]) {
        assert.equal(output.result.status, 'PASS', output.result.diagnostics.join('\n'));
        for (const node of output.nodes) index.addNode(node);
        for (const edge of output.edges) index.addEdge(edge);
      }
      const inferred = inferJoins({ ...index, scopeStatus: () => 'PASS' }, { runId: 'run' });
      assert.equal(inferred.status, 'PASS');
      assert.ok(code.nodes.some((n) => n.kind === 'CodeField' && n.name === 'title'));
      return {
        ids: index.allNodes.filter((n) => n.kind !== 'File').map((n) => n.id).sort(),
        joins: inferred.edges.map((e) => `${e.kind} ${e.src} -> ${e.dst}`).sort(),
      };
    };
    const before = await snapshot();
    assert.equal(before.joins.length, 1);
    assert.match(before.joins[0]!, /^MAPS_TO_FIELD /);
    const move = (from: string, to: string) => {
      mkdirSync(dirname(join(root, to)), { recursive: true });
      renameSync(join(root, from), join(root, to));
    };
    move('src/post.ts', 'src/models/post.ts');
    const application = await snapshot();
    assert.deepEqual(application, before);
    move('src/models/post.ts', 'src/fixtures/post.ts');
    const fixture = await snapshot();
    assert.deepEqual(fixture.ids, before.ids, 'membership policy never changes a semantic id');
    assert.deepEqual(fixture.joins, [], 'extracted fixture declarations cannot supply application joins');
    move('src/fixtures/post.ts', 'src/post.ts');
    assert.deepEqual(await snapshot(), before, 'returning to application scope restores the same edge keys');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
