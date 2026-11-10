import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractContracts } from './extract.ts';
import { extractZod, mentionsZod } from './zod.ts';
import { DocumentLoader } from './document.ts';
import { DEFAULT_LIMITS } from './types.ts';
import { FIXTURES_DIR, makeTempRepo, nodeById, prop } from './test-harness.ts';

const REPO = 'testrepo';

test('the zod pre-filter matches real import forms only', () => {
  assert.equal(mentionsZod("import { z } from 'zod';"), true);
  assert.equal(mentionsZod('import * as z from "zod/v4";'), true);
  assert.equal(mentionsZod("const z = require('zod');"), true);
  assert.equal(mentionsZod("import { z } from './zodiac.ts';"), false);
  assert.equal(mentionsZod('// zod is great'), false);
});

test('a zod schema yields properties without the module ever being executed', () => {
  const source = readFileSync(join(FIXTURES_DIR, 'zod-schemas.ts.txt'), 'utf8');
  assert.match(
    source,
    /^throw new Error\('extract-contracts must never execute project code'\);$/m,
    'the fixture aborts on evaluation, so extracting it proves nothing was evaluated',
  );

  const repo = makeTempRepo();
  try {
    const { nodes, result } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: 'run-1' });
    assert.equal(result.status, 'PASS');

    const at = (name: string) => nodeById(nodes, `${REPO}:SchemaProperty:UserInput#/properties/${name}`);

    assert.equal(prop(at('id'), 'typeCategory'), 'uuid');
    assert.equal(prop(at('email'), 'typeCategory'), 'text');
    assert.equal(prop(at('email'), 'format'), 'email');
    assert.equal(prop(at('email'), 'maxLength'), 255);
    assert.equal(prop(at('age'), 'typeCategory'), 'integer');
    assert.equal(prop(at('age'), 'minimum'), 0);
    assert.equal(prop(at('age'), 'maximum'), 150);
    assert.equal(prop(at('balance'), 'typeCategory'), 'numeric');
    assert.equal(prop(at('role'), 'typeCategory'), 'enum');
    assert.equal(prop(at('role'), 'enumCount'), 2);
    assert.equal(prop(at('createdAt'), 'typeCategory'), 'timestamp');
    assert.equal(prop(at('tags'), 'typeCategory'), 'text');
    assert.equal(prop(at('tags'), 'isArray'), true);
    assert.equal(prop(at('tags'), 'maxItems'), 10);
    assert.equal(prop(at('address'), 'typeCategory'), 'json');
  } finally {
    repo.dispose();
  }
});

test('zod optionality and nullability stay independent axes', () => {
  const repo = makeTempRepo();
  try {
    const { nodes } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: 'run-1' });
    const at = (name: string) => nodeById(nodes, `${REPO}:SchemaProperty:UserInput#/properties/${name}`);

    // required, not nullable
    assert.equal(prop(at('id'), 'required'), true);
    assert.equal(prop(at('id'), 'nullable'), false);

    // .optional() -> optional, and NOT nullable
    assert.equal(prop(at('displayName'), 'required'), false);
    assert.equal(prop(at('displayName'), 'nullable'), false);

    // .nullable() -> still required, and nullable
    assert.equal(prop(at('nickname'), 'required'), true);
    assert.equal(prop(at('nickname'), 'nullable'), true);

    // .nullish() -> optional AND nullable
    assert.equal(prop(at('bio'), 'required'), false);
    assert.equal(prop(at('bio'), 'nullable'), true);

    // .default() makes the input optional and records the default, so a
    // NOT NULL column with a default is not an X1 contradiction.
    assert.equal(prop(at('active'), 'required'), false);
    assert.equal(prop(at('active'), 'hasDefault'), true);
    assert.equal(prop(at('active'), 'default'), true);
    assert.equal(prop(at('active'), 'nullable'), false);
  } finally {
    repo.dispose();
  }
});

test('an in-file schema reference is followed and nested properties get real pointers', () => {
  const repo = makeTempRepo();
  try {
    const { nodes } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: 'run-1' });

    const city = nodeById(nodes, `${REPO}:SchemaProperty:UserInput#/properties/address/properties/city`);
    assert.equal(prop(city, 'required'), true);
    assert.equal(prop(city, 'minLength'), 1);
    assert.equal(prop(city, 'maxLength'), 120);

    // The referenced schema is also a contract in its own right.
    const zip = nodeById(nodes, `${REPO}:SchemaProperty:Address#/properties/zip`);
    assert.equal(prop(zip, 'pattern'), '^[0-9]{5}$');

    const contract = nodeById(nodes, `${REPO}:Contract:UserInput`);
    assert.equal(prop(contract, 'dialect'), 'zod');
    assert.equal(contract.path, 'api/zod-schemas.ts');
  } finally {
    repo.dispose();
  }
});

// `typescript` is an optional peer dependency of this package.
// `extractZod`'s fifth parameter is the injection seam that lets this test
// simulate "not installed" without actually uninstalling it from the
// monorepo, which would break every other package's build.
test('a missing typescript peer dependency degrades to a diagnostic, not a crash or a FAIL', () => {
  const repo = makeTempRepo();
  try {
    const loader = new DocumentLoader(repo.root, DEFAULT_LIMITS);
    const facts = extractZod(
      loader,
      'src/schema.ts',
      "import { z } from 'zod';\nexport const X = z.object({ a: z.string() });\n",
      DEFAULT_LIMITS,
      () => null,
    );
    assert.deepEqual(facts.contracts, []);
    assert.equal(facts.failed, false, 'a missing optional dependency is not a failure');
    assert.deepEqual(facts.diagnostics, [
      'TYPESCRIPT_UNAVAILABLE: the optional typescript peer dependency is not installed; Zod schema extraction is skipped',
    ]);
  } finally {
    repo.dispose();
  }
});
