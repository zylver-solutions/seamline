/**
 * What binding a raw-SQL `QUERIES` edge to the real `Table` does to join inference.
 *
 * `infer-join` scores a candidate pair partly by structure: a class that is read
 * from a table, through a `QUERIES` edge, is a better candidate for that table's
 * columns (`docs/design/real-world-inputs.md`, 3.4). Before the data-model index,
 * `FROM "Invitation"` pointed at `public.invitation`, which is not a table
 * `extract-data` emitted (a Prisma model without `@@map` is the quoted, mixed-case
 * table `"Invitation"`), so the structure signal was lost. With the index the edge
 * lands on the real table and the same pairs score higher.
 *
 * This is a consequence of the alignment, not a goal of it, and it moves a number
 * that a reader of the graph can see: a `MAPS_TO_FIELD` confidence rises where a
 * mixed-case or non-default-schema table is now bound. This suite pins that, so it
 * is a recorded behaviour. The real extractors, the real store and the real
 * inference run twice over the same tree: once handed the index, once without it.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '@seamline/core';
import { CODE_TS_SCOPE, extractCodeTs } from '@seamline/extract-code-ts';
import { DATA_SCOPE, buildDataModelIndex, extractData } from '@seamline/extract-data';
import { INFER_JOIN_SCOPE, inferJoins, toExtractorResult } from '@seamline/infer-join';

const REPO = 'ij';
const RUN_EXTRACT = 'run-1';
const RUN_JOIN = 'run-2';

const FILES: Readonly<Record<string, string>> = {
  'prisma/schema.prisma': `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Invitation {
  id         Int    @id
  inviteCode String
  email      String
}
`,
  'src/invitation.ts': `export class Invitation {
  id!: number;
  inviteCode!: string;
  email!: string;

  static load(db: { query(sql: string): unknown }): unknown {
    return db.query('SELECT id, "inviteCode", email FROM "Invitation" WHERE id = $1');
  }
}
`,
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src'],
  }),
  'package.json': JSON.stringify({ name: '@ij/app', version: '1.0.0', type: 'module' }),
};

interface Joined {
  /** Where the `QUERIES` edge points. */
  readonly queriesTo: readonly string[];
  /** `field -> column`, with the confidence of the `MAPS_TO_FIELD` edge between them. */
  readonly mapped: ReadonlyMap<string, number>;
}

async function inferWith(withIndex: boolean): Promise<Joined> {
  const root = await mkdtemp(join(tmpdir(), 'seamline-ij-repo-'));
  const storeDir = await mkdtemp(join(tmpdir(), 'seamline-ij-db-'));
  try {
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text, 'utf8');
    }
    const run = { repo: REPO, runId: RUN_EXTRACT };
    const data = await extractData({ ...run, root, deterministic: true });
    assert.equal(data.result.status, 'PASS');
    const code = extractCodeTs({
      ...run,
      repoRoot: root,
      deterministic: true,
      ...(withIndex ? { dataModelIndex: buildDataModelIndex(data.nodes) } : {}),
    });
    // Without the index the run is UNAVAILABLE (it reads a raw-SQL reference); the facts are
    // still returned, which is what this comparison needs: the edge as it was before the index.
    assert.equal(code.result.status, withIndex ? 'PASS' : 'UNAVAILABLE');

    const store = new SqliteStore({ path: join(storeDir, 'graph.db'), ontologyVersion: '1.0.0' });
    try {
      await store.beginRun({
        runId: RUN_EXTRACT,
        repo: REPO,
        commit: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        ontologyVersion: '1.0.0',
      });
      await store.upsertNodes(RUN_EXTRACT, [...code.nodes, ...data.nodes]);
      await store.upsertEdges(RUN_EXTRACT, CODE_TS_SCOPE, code.edges);
      await store.upsertEdges(RUN_EXTRACT, DATA_SCOPE, data.edges);
      await store.finalizeRun(RUN_EXTRACT, [code.result, data.result]);

      const inferred = inferJoins(store, { runId: RUN_JOIN });
      const mapped = new Map<string, number>();
      for (const e of inferred.edges.filter((x) => x.kind === 'MAPS_TO_FIELD')) {
        mapped.set(`${e.src} -> ${e.dst}`, e.confidence);
      }
      await store.beginRun({
        runId: RUN_JOIN,
        repo: REPO,
        commit: null,
        startedAt: '2026-01-01T00:00:01.000Z',
        ontologyVersion: '1.0.0',
      });
      await store.upsertEdges(RUN_JOIN, INFER_JOIN_SCOPE, inferred.edges);
      await store.finalizeRun(RUN_JOIN, [toExtractorResult(inferred, 0)]);

      return {
        queriesTo: code.edges.filter((e) => e.kind === 'QUERIES').map((e) => String(e.dst)),
        mapped,
      };
    } finally {
      await store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
}

test('a mixed-case Prisma table that a raw statement now binds raises the MAPS_TO_FIELD confidence of its columns', async () => {
  const before = await inferWith(false);
  const after = await inferWith(true);

  assert.deepEqual(before.queriesTo, ['ij:Table:public.invitation'], 'a table nobody declared');
  assert.deepEqual(after.queriesTo, ['ij:Table:public.Invitation'], 'the Prisma table');

  // The same three field-to-column pairs are inferred either way; only their confidence moves.
  assert.deepEqual([...after.mapped.keys()], [...before.mapped.keys()]);
  assert.equal(after.mapped.size, 3, [...after.mapped.keys()].join('; '));
  for (const [pair, confidence] of after.mapped) {
    const was = before.mapped.get(pair);
    assert.ok(was !== undefined && confidence > was, `${pair}: ${was} -> ${confidence}`);
  }
});
