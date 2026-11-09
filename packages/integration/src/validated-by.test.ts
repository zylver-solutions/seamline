/**
 * Cross-package regression coverage for validator recognition.
 *
 * `infer-join` used to call any `Symbol` a validator when its name ended in a
 * validation-shaped word (`schema`, `rule`, `constraint`, ...). On real code
 * that admitted ordinary interfaces: `interface RowConstraints { nullable:
 * boolean }` next to `interface Row { nullable: boolean }` produced `Row.nullable
 * VALIDATED_BY RowConstraints`, and no unit test caught it because the unit
 * tests build their graphs by hand. Recognition now needs two extracted facts
 * instead: the Symbol is a runtime value (`symbolKind`), and `extract-code-ts`
 * found it built through a validation library (`library`).
 *
 * A recognized schema value gets its members from the schema
 * `extract-contracts` lowered it to (the Contract of the same name, in the
 * same file, whose dialect is the value's library), since `extract-code-ts`
 * emits no member CodeFields for an object literal.
 *
 * Each case runs the real extractors over a small fixture repo, persists them
 * to a real `SqliteStore` the way `seamline extract` does, and runs
 * `inferJoins` over that store. The suite also holds the two hand-kept copies
 * of the validation-library list equal, since `extract-code-ts` may not import
 * `infer-join`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { NodeId } from '@seamline/ontology';
import { SqliteStore } from '@seamline/core';
import { CODE_TS_SCOPE, VALIDATION_LIBRARIES, extractCodeTs } from '@seamline/extract-code-ts';
import { CONTRACTS_SCOPE, extractContracts } from '@seamline/extract-contracts';
import { DATA_SCOPE, extractData } from '@seamline/extract-data';
import { VALIDATOR_LIBRARIES, inferJoins } from '@seamline/infer-join';
import type { InferJoinResult } from '@seamline/infer-join';

const VALIDATOR_REPO = 'validatorfixture';
const VALIDATOR_RUN = 'run-1';

const VALIDATOR_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src'],
  },
  null,
  2,
);

/** A table whose column matches the model field, so the data scope PASSes and a column is in play. */
const ROWS_SQL = `CREATE TABLE rows (
    id        bigserial PRIMARY KEY,
    nullable  boolean NOT NULL
);
`;

const ROW_INTERFACE = `export interface Row {
  nullable: boolean;
}
`;

/** `row.ts` with a Zod object value whose member matches `Row.nullable`. */
const MATCHING_SCHEMA_TS = `import { z } from 'zod';

${ROW_INTERFACE}
export const RowSchema = z.object({ nullable: z.boolean() });
`;

/** `row.ts` with a Zod object value that shares no member with `Row`. */
const UNRELATED_SCHEMA_TS = `import { z } from 'zod';

${ROW_INTERFACE}
export const RowSchema = z.object({ title: z.string() });
`;

/**
 * `row.ts` with an interface named like a validator. The unrelated Zod value
 * is there so the contracts scope has a source and PASSes.
 */
const LOOKALIKE_INTERFACE_TS = `import { z } from 'zod';

${ROW_INTERFACE}
export interface RowConstraints {
  nullable: boolean;
}

export const AuditSchema = z.object({ actor: z.string() });
`;

const node = (kind: string, canonicalName: string): NodeId =>
  `${VALIDATOR_REPO}:${kind}:${canonicalName}` as NodeId;
const rowSchemaId = node('Symbol', '@fixture/validators#RowSchema');
const rowNullableId = node('CodeField', '@fixture/validators#Row.nullable');

/** Extract `rowTs` with every real extractor, persist it, and infer joins over the store. */
async function inferOver(rowTs: string): Promise<InferJoinResult> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'seamline-validators-repo-'));
  const storeDir = await mkdtemp(join(tmpdir(), 'seamline-validators-db-'));
  try {
    const files: Record<string, string> = {
      'db/schema.sql': ROWS_SQL,
      'package.json': JSON.stringify({ name: '@fixture/validators', version: '1.0.0', type: 'module' }, null, 2),
      'src/row.ts': rowTs,
      'tsconfig.json': VALIDATOR_TSCONFIG,
    };
    for (const rel of Object.keys(files)) {
      const abs = join(fixtureRoot, rel);
      await mkdir(join(abs, '..'), { recursive: true });
      await writeFile(abs, files[rel] as string, 'utf8');
    }

    const run = { repo: VALIDATOR_REPO, runId: VALIDATOR_RUN };
    const code = extractCodeTs({ ...run, repoRoot: fixtureRoot, deterministic: true });
    const contracts = extractContracts({ ...run, repoRoot: fixtureRoot });
    const data = await extractData({ ...run, root: fixtureRoot, deterministic: true });
    for (const result of [code.result, contracts.result, data.result]) {
      assert.equal(result.status, 'PASS', `${result.extractor}: ${result.diagnostics.join('; ')}`);
    }

    const store = new SqliteStore({ path: join(storeDir, 'graph.db'), ontologyVersion: '1.0.0' });
    try {
      await store.beginRun({
        runId: VALIDATOR_RUN,
        repo: VALIDATOR_REPO,
        commit: null,
        startedAt: '2026-01-01T00:00:00.000Z',
        ontologyVersion: '1.0.0',
      });
      await store.upsertNodes(VALIDATOR_RUN, [...code.nodes, ...contracts.nodes, ...data.nodes]);
      await store.upsertEdges(VALIDATOR_RUN, CODE_TS_SCOPE, code.edges);
      await store.upsertEdges(VALIDATOR_RUN, CONTRACTS_SCOPE, contracts.edges);
      await store.upsertEdges(VALIDATOR_RUN, DATA_SCOPE, data.edges);
      await store.finalizeRun(VALIDATOR_RUN, [code.result, contracts.result, data.result]);
      const inferred = inferJoins(store, { runId: 'run-2' });
      // Every scope PASSed, so an absent edge means absent, not unknown.
      assert.equal(inferred.status, 'PASS');
      assert.deepEqual(inferred.degradedScopes, []);
      return inferred;
    } finally {
      await store.close();
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
}

function validatedBy(result: InferJoinResult): string[] {
  return result.edges.filter((e) => e.kind === 'VALIDATED_BY').map((e) => `${e.src} -> ${e.dst}`).sort();
}

test('a Zod object value validates the model field and the column its member matches', async () => {
  const result = await inferOver(MATCHING_SCHEMA_TS);
  assert.deepEqual(validatedBy(result), [
    `${node('Column', 'public.rows.nullable')} -> ${rowSchemaId}`,
    `${rowNullableId} -> ${rowSchemaId}`,
  ].sort());
  for (const edge of result.edges.filter((e) => e.kind === 'VALIDATED_BY')) {
    assert.equal(edge.props['rule'], 'validator-correspondence');
    assert.equal(edge.provenance, 'INFERRED');
  }
});

test('a Zod object value with no matching member validates nothing', async () => {
  const result = await inferOver(UNRELATED_SCHEMA_TS);
  assert.deepEqual(validatedBy(result), []);
  assert.equal(result.diagnostics.some((d) => d.includes(rowSchemaId)), false,
    'the value has members (from its lowered schema); they just match nothing');
});

test('an interface named like a validator validates nothing', async () => {
  const result = await inferOver(LOOKALIKE_INTERFACE_TS);
  assert.deepEqual(validatedBy(result), [], 'Row.nullable must not be VALIDATED_BY the interface RowConstraints');
});

test('extract-code-ts and infer-join agree on the validation libraries', () => {
  assert.deepEqual([...VALIDATION_LIBRARIES].sort(), [...VALIDATOR_LIBRARIES].sort());
});
