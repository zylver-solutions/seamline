import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError } from './errors.ts';
import type { Measured } from './analyse.ts';
import { buildLabelSheet, renderLabelSheet } from './label-sheet.ts';
import { finding, makeTempDir, removeDir } from './testing.ts';
import type { FreezeState } from './freeze.ts';
import type { CorpusEntry } from './types.ts';

const SHA = 'c'.repeat(40);

const FROZEN: FreezeState = { state: 'frozen', sha: 'f'.repeat(40), changed: [] };

/** The sources and the build being measured now, which the fixture baseline was made by. */
const CURRENT: Measured = {
  codeId: 'code-a',
  identified: true,
  cli: { path: 'packages/cli/dist/index.js', ownBuild: true, distDigest: 'd'.repeat(64) },
};

const ENTRY: CorpusEntry = {
  name: 'alpha',
  url: 'https://example.invalid/alpha',
  sha: SHA,
  license: 'MIT',
  partition: 'sealed',
  stacks: ['prisma'],
  why: 'fixture',
};

const A = finding(
  'alpha',
  'X1_NULLABILITY',
  'alpha:Column:public.t.a',
  'alpha:SchemaProperty:T.a',
  0.8765,
);
const B = finding(
  'alpha',
  'X2_TYPE',
  'alpha:Column:public.t.b',
  'alpha:SchemaProperty:T.b',
  0.4321,
);

function node(id: string, sourceRef: string): string {
  return JSON.stringify({
    node: { id, kind: id.split(':')[1], sourceRef, path: sourceRef.split(':')[0] },
    t: 'node',
  });
}

async function fixture(
  sha = SHA,
  outcome = 'complete',
  made: Record<string, unknown> = { codeId: CURRENT.codeId, cli: CURRENT.cli },
): Promise<{ root: string; out: string }> {
  const root = await makeTempDir();
  const out = path.join(root, 'alpha');
  await mkdir(path.join(out, 'store', 'runs'), { recursive: true });
  await writeFile(
    path.join(out, 'baseline.json'),
    JSON.stringify({ sha, ...made, pipeline: { outcome, findings: [B, A] } }),
    'utf8',
  );
  await writeFile(
    path.join(out, 'store', 'runs', 'run-fixture-0001.sif'),
    [
      '{"runId":"run-fixture-0001","t":"sif","version":"1.0.0"}',
      node('alpha:Column:public.t.a', 'prisma/schema.prisma:10'),
      node('alpha:SchemaProperty:T.a', 'src/schema.ts:20'),
      node('alpha:Column:public.t.b', 'prisma/schema.prisma:11'),
      node('alpha:Other:unrelated', 'src/unrelated.ts:1'),
    ].join('\n'),
    'utf8',
  );
  return { root, out };
}

test('the sheet lists id, code, and the two subjects with their locations', async () => {
  const f = await fixture();
  try {
    const sheet = await buildLabelSheet(ENTRY, f.out, FROZEN, CURRENT);
    assert.ok(sheet.includes(`${A.id}  X1_NULLABILITY`));
    assert.ok(sheet.includes('left:  alpha:Column:public.t.a  prisma/schema.prisma:10'));
    assert.ok(sheet.includes('right: alpha:SchemaProperty:T.a  src/schema.ts:20'));
    assert.ok(sheet.includes(`${B.id}  X2_TYPE`));
    assert.ok(
      sheet.includes('(no location recorded)'),
      'a subject with no recorded location says so',
    );
  } finally {
    await removeDir(f.root);
  }
});

test('the sheet withholds the claim, the facts, the confidence, and the severity', async () => {
  const f = await fixture();
  try {
    const sheet = await buildLabelSheet(ENTRY, f.out, FROZEN, CURRENT);
    for (const secret of [
      A.claim,
      A.leftFact,
      A.rightFact,
      '0.8765',
      '0.4321',
      'high',
      'disagrees',
    ]) {
      assert.ok(!sheet.includes(secret), `the sheet must not contain ${secret}`);
    }
  } finally {
    await removeDir(f.root);
  }
});

test('the sheet is a pure function of the findings: order of input does not matter', () => {
  const locations = new Map<string, string>();
  assert.equal(
    renderLabelSheet(ENTRY, [A, B], locations),
    renderLabelSheet(ENTRY, [B, A], locations),
  );
});

test('the sheet refuses a baseline made for another commit than the pin', async () => {
  const f = await fixture('d'.repeat(40));
  try {
    await assert.rejects(buildLabelSheet(ENTRY, f.out, FROZEN, CURRENT), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /not the pinned/);
      return true;
    });
  } finally {
    await removeDir(f.root);
  }
});

test('the sheet refuses a baseline that did not complete, and a missing baseline', async () => {
  const f = await fixture(SHA, 'crashed');
  try {
    await assert.rejects(buildLabelSheet(ENTRY, f.out, FROZEN, CURRENT), /did not complete/);
    await assert.rejects(
      buildLabelSheet(ENTRY, path.join(f.root, 'absent'), FROZEN, CURRENT),
      /no stored baseline/,
    );
  } finally {
    await removeDir(f.root);
  }
});

test('the sheet for a sealed repository is refused before eval/FREEZE exists, and prints nothing', async () => {
  const f = await fixture();
  try {
    const none: FreezeState = { state: 'none', sha: null, changed: [] };
    await assert.rejects(buildLabelSheet(ENTRY, f.out, none, null), (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /sealed partition and eval\/FREEZE does not exist/);
      assert.ok(!e.message.includes(A.id) && !e.message.includes('Column'));
      return true;
    });
  } finally {
    await removeDir(f.root);
  }
});

test('the sheet for a sealed repository is refused when the partition is burned', async () => {
  const f = await fixture();
  try {
    const burned: FreezeState = {
      state: 'burned',
      sha: 'f'.repeat(40),
      changed: ['packages/core/src/store/scope.ts'],
    };
    await assert.rejects(
      buildLabelSheet(ENTRY, f.out, burned, null),
      /burned: 1 detector or extractor/,
    );
  } finally {
    await removeDir(f.root);
  }
});

test('a dev repository has a sheet whatever the freeze says', async () => {
  const f = await fixture();
  try {
    const dev: CorpusEntry = { ...ENTRY, partition: 'dev' };
    const none: FreezeState = { state: 'none', sha: null, changed: [] };
    const burned: FreezeState = { state: 'burned', sha: 'f'.repeat(40), changed: ['x'] };
    for (const freeze of [none, burned, FROZEN]) {
      assert.ok((await buildLabelSheet(dev, f.out, freeze, null)).includes(A.id));
    }
  } finally {
    await removeDir(f.root);
  }
});

test('the sheet for a sealed repository shows only a baseline that the current sources and build made', async () => {
  const cases: ReadonlyArray<[string, Record<string, unknown>, RegExp]> = [
    [
      'other sources',
      { codeId: 'code-old', cli: CURRENT.cli },
      /cannot be used for this sheet: it was made by other detector or extractor sources/,
    ],
    [
      'a harness that recorded no sources',
      { cli: CURRENT.cli },
      /cannot be used for this sheet: it was made by other detector or extractor sources/,
    ],
    [
      'another build of the CLI',
      { codeId: CURRENT.codeId, cli: { ...CURRENT.cli, distDigest: '0'.repeat(64) } },
      /cannot be used for this sheet: it was made by another build of the CLI/,
    ],
    [
      'a harness that recorded no build',
      { codeId: CURRENT.codeId },
      /cannot be used for this sheet: it was made by another build of the CLI/,
    ],
  ];
  for (const [name, made, message] of cases) {
    const f = await fixture(SHA, 'complete', made);
    try {
      await assert.rejects(buildLabelSheet(ENTRY, f.out, FROZEN, CURRENT), (e: unknown) => {
        assert.ok(e instanceof ConfigError, name);
        assert.match(e.message, message, name);
        assert.ok(!e.message.includes(A.id), `${name}: no finding id in the refusal`);
        return true;
      });
    } finally {
      await removeDir(f.root);
    }
  }
});

test("the sheet for a sealed repository needs the current sources, and a CLI that is this repository's own build", async () => {
  const f = await fixture();
  try {
    await assert.rejects(buildLabelSheet(ENTRY, f.out, FROZEN, null), /built only for the sources/);
    const elsewhere: Measured = {
      ...CURRENT,
      cli: { path: '/tmp/other-cli.js', ownBuild: false, distDigest: CURRENT.cli.distDigest },
    };
    await assert.rejects(
      buildLabelSheet(ENTRY, f.out, FROZEN, elsewhere),
      /measured only with this repository's own built CLI/,
    );
    await assert.rejects(
      buildLabelSheet(ENTRY, f.out, FROZEN, { ...CURRENT, identified: false }),
      /not measured outside a git checkout/,
    );
  } finally {
    await removeDir(f.root);
  }
});

test('a dev sheet does not look at what made the baseline', async () => {
  const f = await fixture(SHA, 'complete', {});
  try {
    const dev: CorpusEntry = { ...ENTRY, partition: 'dev' };
    assert.ok((await buildLabelSheet(dev, f.out, FROZEN, null)).includes(A.id));
  } finally {
    await removeDir(f.root);
  }
});
