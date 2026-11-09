/**
 * Zod coverage degrades per schema, never per scope.
 *
 * An unsupported construct makes exactly the facts it hides unknown: a
 * facet-level gap leaves one property fact short, a shape-level gap withholds
 * that one contract and takes its file out of the run's claim. Neither fails
 * the scope, and neither lets "could not read it" look like "it is not there".
 * The two-run behaviour against a real store lives in
 * `packages/integration/src/partial-contracts.test.ts`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { claimSelector, extractContracts } from './extract.ts';
import { makeEmptyRepo } from './test-harness.ts';

const ZOD = `import { z } from 'zod';\n`;

function run(files: Readonly<Record<string, string>>, limits?: { maxFileBytes: number }) {
  const repo = makeEmptyRepo();
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo.root, rel)), { recursive: true });
      writeFileSync(join(repo.root, rel), text, 'utf8');
    }
    return extractContracts({
      repoRoot: repo.root,
      repo: 'partial',
      runId: 'r1',
      ...(limits === undefined ? {} : { limits }),
    });
  } finally {
    repo.dispose();
  }
}

type Run = ReturnType<typeof run>;

const contractNames = (r: Run) =>
  r.nodes
    .filter((n) => n.kind === 'Contract')
    .map((n) => n.name)
    .sort();

const properties = (r: Run, contract: string) =>
  r.nodes.filter((n) => n.kind === 'SchemaProperty' && n.props['contract'] === contract);

test('one supported and one unsupported-shape schema: PASS, the supported one is emitted, the other is not', () => {
  const r = run({
    'src/a/supported.ts': `${ZOD}export const Supported = z.object({ id: z.string(), age: z.number().optional() });`,
    'src/b/broken.ts': `${ZOD}export const Broken = z.object({ ...imported, name: z.string() });`,
    'src/b/sibling.ts': `${ZOD}export const Sibling = z.object({ ok: z.boolean() });`,
  });
  assert.equal(r.result.status, 'PASS');
  assert.deepEqual(contractNames(r), ['Sibling', 'Supported']);
  assert.deepEqual(properties(r, 'Broken'), []);
  assert.equal(properties(r, 'Supported').length, 2);

  // The claim vouches for every file it read to the end and for none it could not.
  const claim = r.result.authoritative[0];
  assert.equal(claim?.scope, 'contracts');
  assert.equal(claim?.selector, '{src/a/**,src/b/sibling.ts,src/main.ts}');
  assert.ok(!claim?.selector?.includes('broken'));
  assert.ok(
    r.result.diagnostics.includes('ZOD_CONTRACT_WITHHELD: src/b/broken.ts contract Broken'),
  );
});

test('a run that reads every file to the end keeps the whole-scope claim', () => {
  const r = run({
    'src/a/supported.ts': `${ZOD}export const Supported = z.object({ id: z.string() });`,
  });
  assert.equal(r.result.status, 'PASS');
  assert.equal(r.result.authoritative[0]?.selector, undefined);
});

test('the claim is byte-reproducible and sorted by code unit', () => {
  const files = {
    'z/last.ts': `${ZOD}export const Last = z.object({ id: z.string() });`,
    'a/first.ts': `${ZOD}export const First = z.object({ id: z.string() });`,
    'a/broken.ts': `${ZOD}export const Broken = z.object({ ...imported });`,
    'm/mid.ts': `${ZOD}export const Mid = z.object({ id: z.string() });`,
  };
  const first = run(files);
  const second = run(files);
  assert.deepEqual({ ...first.result, durationMs: 0 }, { ...second.result, durationMs: 0 });
  assert.deepEqual(first.nodes, second.nodes);
  assert.equal(first.result.authoritative[0]?.selector, '{a/first.ts,m/**,src/**,z/**}');
});

test('claimSelector names a clean subtree whole and a mixed one file by file', () => {
  const candidates = [
    'a/x.ts',
    'a/b/y.ts',
    'a/b/c/bad.ts',
    'a/b/c/z.ts',
    'a/d/w.json',
    'top.ts',
    'README.md',
  ];
  assert.equal(
    claimSelector(candidates, new Set(['a/b/c/bad.ts'])),
    '{a/b/c/z.ts,a/b/y.ts,a/d/**,a/x.ts,top.ts}',
  );
  assert.equal(claimSelector(candidates, new Set()), undefined);
  // Everything unvouched claims nothing, rather than everything.
  assert.equal(claimSelector(['a.ts'], new Set(['a.ts'])), '**/*,!**/*');
});

test('a path the selector syntax cannot write is left out of the claim, never claimed loosely', () => {
  const sel = claimSelector(
    [
      'ok.ts',
      'we,ird.ts',
      'br{ace}.ts',
      'wild*.ts',
      'dir with space/x.ts',
      'bad.ts',
      './dot.ts',
      'a//b.ts',
      '../up.ts',
    ],
    new Set(['bad.ts']),
  );
  assert.equal(sel, '{dir with space/**,ok.ts}');
});

test('a file too large to read is not vouched for, though discovery mode would otherwise skip it silently', () => {
  const r = run(
    {
      'src/big.ts': `${ZOD}export const Big = z.object({ id: z.string() });\n${'// padding\n'.repeat(400)}`,
      'src/small.ts': `${ZOD}export const Small = z.object({ id: z.string() });`,
    },
    { maxFileBytes: 400 },
  );
  assert.equal(r.result.status, 'PASS');
  assert.deepEqual(contractNames(r), ['Small']);
  assert.equal(r.result.authoritative[0]?.selector, '{src/main.ts,src/small.ts}');
});

test('same-named schemas in two files never merge: both are withheld, with a diagnostic', () => {
  const r = run({
    'src/users/schema.ts': `${ZOD}export const FormSchema = z.object({ email: z.string(), age: z.number() });`,
    'src/orders/schema.ts': `${ZOD}export const FormSchema = z.object({ total: z.number(), note: z.string().optional() });`,
    'src/other.ts': `${ZOD}export const Other = z.object({ id: z.string() });`,
  });
  assert.equal(r.result.status, 'PASS');
  assert.deepEqual(contractNames(r), ['Other']);
  assert.deepEqual(properties(r, 'FormSchema'), []);
  assert.deepEqual(
    r.nodes.filter((n) => n.kind === 'SchemaProperty').map((n) => n.name),
    ['id'],
  );
  assert.ok(
    r.result.diagnostics.includes(
      'CONTRACT_NAME_COLLISION: FormSchema is declared in src/orders/schema.ts, src/users/schema.ts; every declaration is withheld',
    ),
  );
  // Neither colliding file is in the claim, so neither can bury what an earlier run read.
  assert.equal(r.result.authoritative[0]?.selector, '{src/main.ts,src/other.ts}');
});

test('a declaration whose shape cannot be read still holds its name against a readable twin', () => {
  const r = run({
    'src/a.ts': `${ZOD}export const Shared = z.object({ id: z.string() });`,
    'src/b.ts': `${ZOD}export const Shared = z.object({ ...imported });`,
    'src/c.ts': `${ZOD}export const Fine = z.object({ id: z.string() });`,
  });
  assert.deepEqual(contractNames(r), ['Fine']);
  assert.deepEqual(properties(r, 'Shared'), []);
  assert.ok(r.result.diagnostics.some((d) => d.startsWith('CONTRACT_NAME_COLLISION: Shared ')));
  assert.equal(r.result.authoritative[0]?.selector, '{src/c.ts,src/main.ts}');
});

test('a schema parsed at module level is a value, not a second copy of the contract', () => {
  const r = run({
    'src/env.ts': `${ZOD}export const Input = z.object({ id: z.string() });\nexport const parsed = Input.parse(process.env);`,
  });
  assert.equal(r.result.status, 'PASS');
  assert.deepEqual(contractNames(r), ['Input']);
  assert.deepEqual(properties(r, 'parsed'), []);
});

test('a modifier that reshapes an object withholds it instead of emitting the unreshaped property set', () => {
  const r = run({
    'src/a.ts': `${ZOD}export const Picked = z.object({ a: z.string(), b: z.string() }).pick({ a: true });`,
    'src/b.ts': `${ZOD}export const Fine = z.object({ id: z.string() });`,
  });
  assert.deepEqual(contractNames(r), ['Fine']);
  assert.deepEqual(properties(r, 'Picked'), []);
});

test('an unrecognised modifier on a scalar leaves only that property short', () => {
  const r = run({
    'src/a.ts': `${ZOD}export const Input = z.object({
      note: z.string().nullable().refine((s) => s.length > 1),
      tags: z.array(z.string().transform(Number)),
      role: z.nativeEnum(Role),
      kept: z.string().optional(),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  assert.equal(r.result.authoritative[0]?.selector, undefined);
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));
  assert.deepEqual([...byName.keys()].sort(), ['kept', 'note', 'role', 'tags']);

  // `note`: the .nullable() sits beside an unread refinement, so nothing is claimed.
  for (const facet of ['type', 'typeCategory', 'nullable', 'required', 'isArray', 'hasDefault'])
    assert.equal(byName.get('note')?.[facet], undefined, `note.${facet}`);

  // `tags`: that it is an array is read; what it holds is not.
  assert.equal(byName.get('tags')?.['isArray'], true);
  assert.equal(byName.get('tags')?.['required'], true);
  for (const facet of ['type', 'typeCategory', 'format'])
    assert.equal(byName.get('tags')?.[facet], undefined, `tags.${facet}`);

  // `role`: an enum whose members live elsewhere. The raw type is not declared
  // (native enums may be numeric), the category and presence are.
  assert.equal(byName.get('role')?.['typeCategory'], 'enum');
  assert.equal(byName.get('role')?.['type'], undefined);
  assert.equal(byName.get('role')?.['required'], true);
  assert.equal(byName.get('role')?.['enumValues'], undefined);

  // The sibling is untouched.
  assert.equal(byName.get('kept')?.['required'], false);
  assert.equal(byName.get('kept')?.['nullable'], false);
  assert.equal(byName.get('kept')?.['typeCategory'], 'text');
});

test('a union or intersection with a branch it cannot read states no null-ness and no presence', () => {
  // Each branch below hides something the property's own facets depend on: an
  // `.or(z.null())` is a nullable, a `.refine` may sit beside one. Reading the
  // remaining branches would have recomputed `nullable: false` from nothing.
  const r = run({
    'src/a.ts': `${ZOD}const OPTIONS = [z.string(), z.null()] as const;
    function make() { return [z.string(), z.null()] as const; }
    export const Input = z.object({
      orNull: z.union([z.string().or(z.null()), z.number()]),
      refined: z.union([z.string().refine(f), z.number()]),
      both: z.intersection(z.string().refine(f), z.string()),
      named: z.union(OPTIONS),
      discriminated: z.discriminatedUnion('kind', OPTIONS),
      called: z.union(make()),
      optionalUnion: z.union([z.string().refine(f), z.number()]).optional(),
      optionalNamed: z.union(OPTIONS).optional(),
      readable: z.union([z.string(), z.number()]),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  assert.equal(r.result.authoritative[0]?.selector, undefined);
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));
  assert.deepEqual([...byName.keys()].sort(), [
    'both',
    'called',
    'discriminated',
    'named',
    'optionalNamed',
    'optionalUnion',
    'orNull',
    'readable',
    'refined',
  ]);

  // `named`, `discriminated` and `called` take their branches from a binding or
  // a call, so none is enumerated and none is lowered: nothing in the union is
  // read, and that must not look like a union of nothing that states `false`.
  for (const name of ['orNull', 'refined', 'both', 'named', 'discriminated', 'called'])
    for (const facet of ['type', 'typeCategory', 'nullable', 'required'])
      assert.equal(byName.get(name)?.[facet], undefined, `${name}.${facet}`);

  // The union's own `.optional()` is read, and it is a fact; the rest stays unknown.
  for (const name of ['optionalUnion', 'optionalNamed']) {
    assert.equal(byName.get(name)?.['required'], false, `${name}.required`);
    assert.equal(byName.get(name)?.['nullable'], undefined, `${name}.nullable`);
    assert.equal(byName.get(name)?.['type'], undefined, `${name}.type`);
  }

  // A union whose every branch is readable still states its facets.
  assert.equal(byName.get('readable')?.['nullable'], false);
  assert.equal(byName.get('readable')?.['required'], true);
});

test('a literal null is a null, and a literal argument it cannot read states no null-ness', () => {
  // `z.literal(null)` accepts null. The Zod 4 list form, a binding and a call
  // may too; the extractor reads none of them as a scalar, so none of them can
  // be recorded as a value that rejects null.
  const r = run({
    'src/a.ts': `${ZOD}const NUL = null;
    function make() { return 'a'; }
    export const Input = z.object({
      nullLiteral: z.literal(null),
      nullBranch: z.union([z.string(), z.literal(null)]),
      zod4List: z.literal(['a', null]),
      named: z.literal(NUL),
      called: z.literal(make()),
      namedBranch: z.union([z.literal(NUL), z.number()]),
      namedIntersection: z.intersection(z.literal(NUL), z.string()),
      namedOptional: z.literal(NUL).optional(),
      stringLiteral: z.literal('a'),
      numberLiteral: z.literal(1),
      booleanLiteral: z.literal(false),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));
  assert.equal(byName.size, 11);

  // A null the extractor reads is a nullable value.
  assert.equal(byName.get('nullLiteral')?.['nullable'], true);
  assert.equal(byName.get('nullLiteral')?.['type'], 'null');
  assert.equal(byName.get('nullBranch')?.['nullable'], true);

  // An argument that is not a scalar leaves null-ness unknown, in the schema
  // itself and in a union or intersection that holds one.
  for (const name of [
    'zod4List',
    'named',
    'called',
    'namedOptional',
    'namedBranch',
    'namedIntersection',
  ])
    assert.equal(byName.get(name)?.['nullable'], undefined, `${name}.nullable`);
  // Presence is a separate fact and is still read.
  assert.equal(byName.get('namedOptional')?.['required'], false);

  // A scalar literal still states what it is.
  for (const name of ['stringLiteral', 'numberLiteral', 'booleanLiteral']) {
    assert.equal(byName.get(name)?.['nullable'], false, `${name}.nullable`);
    assert.equal(byName.get(name)?.['required'], true, `${name}.required`);
  }
});

test('an intersection of branches that accept null never states non-nullable', () => {
  // `nullable` is recomputed from the intersection's own schema, which says
  // nothing about its branches, so a stated `false` would be a default.
  const r = run({
    'src/a.ts': `${ZOD}export const Input = z.object({
      bothStrings: z.intersection(z.string().nullable(), z.string().nullable()),
      bothObjects: z.intersection(
        z.object({ a: z.string() }).nullable(),
        z.object({ b: z.string() }).nullable(),
      ),
      oneBranch: z.intersection(z.string().nullable(), z.string()),
      nullish: z.intersection(z.string().nullish(), z.string()),
      viaUnion: z.intersection(z.union([z.string(), z.null()]), z.string()),
      viaLiteral: z.intersection(z.literal(null), z.literal(null)),
      nested: z.intersection(z.intersection(z.string().nullable(), z.string()), z.string()),
      plainObjects: z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })),
      plainNullable: z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })).nullable(),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));

  for (const name of [
    'bothStrings',
    'bothObjects',
    'oneBranch',
    'nullish',
    'viaUnion',
    'viaLiteral',
    'nested',
  ]) {
    assert.equal(byName.get(name)?.['nullable'], undefined, `${name}.nullable`);
    // Presence is a separate fact and is still read.
    assert.equal(byName.get(name)?.['required'], true, `${name}.required`);
  }

  // Branches that say nothing about null keep the stated facets.
  assert.equal(byName.get('plainObjects')?.['nullable'], false);
  assert.equal(byName.get('plainObjects')?.['required'], true);
  assert.equal(byName.get('plainNullable')?.['nullable'], true);
});

test('a union with an optional branch never states the property required', () => {
  // A union accepts what any branch accepts, a missing key included. An
  // intersection never accepts one unless every branch does.
  const r = run({
    'src/a.ts': `${ZOD}export const Input = z.object({
      optionalBranch: z.union([z.string().optional(), z.number()]),
      undefinedBranch: z.union([z.undefined(), z.string()]),
      defaultBranch: z.union([z.string().default('x'), z.number()]),
      discriminated: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a') }).optional(),
        z.object({ kind: z.literal('b') }),
      ]),
      optionalAndUnread: z.union([z.string().optional(), z.string().refine(f)]),
      allOptional: z.intersection(z.string().optional(), z.string().optional()),
      oneOptional: z.intersection(z.string().optional(), z.string()),
      readable: z.union([z.string(), z.number()]),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));

  for (const name of ['optionalBranch', 'defaultBranch', 'discriminated'])
    assert.equal(byName.get(name)?.['required'], false, `${name}.required`);

  // An intersection of optional branches is unread, not false: Zod 3.25 accepts
  // a missing key and current Zod 4 rejects it, even for two `.optional()`.
  assert.equal(byName.get('allOptional')?.['required'], undefined);

  // A `z.undefined()` branch is not an `.optional()`: Zod 3.25 accepts a missing
  // key for it and current Zod 4 does not, so the union's presence is unread.
  assert.equal(byName.get('undefinedBranch')?.['required'], undefined);

  // Unknown, not false: one branch is unread, so the union's presence is not.
  assert.equal(byName.get('optionalAndUnread')?.['required'], undefined);

  // The controls: nothing optional, or an intersection that still needs a value.
  assert.equal(byName.get('oneOptional')?.['required'], true);
  assert.equal(byName.get('readable')?.['required'], true);
  assert.equal(byName.get('readable')?.['nullable'], false);
});

test('a catch or a coercion accepts a null, so the property states no null-ness', () => {
  // `.catch(v)` swallows whatever fails to parse and `z.coerce.*` turns a null
  // into a value ('null', 0, the epoch, false), so each accepts a null. Neither
  // is a value that rejects it, and neither may be recorded as one. A catch takes
  // the presence of its receiver on Zod 4.4.0 to 4.4.2 (`z.string().catch('x')`
  // rejects a missing key there and accepts one on every other release), so a
  // bare catch leaves presence unread and a catch after `.optional()` or
  // `.default(v)` states `false`. A coercion accepts a missing key only for some
  // bases (`z.coerce.string()` on Zod 3.25 and up to 4.3, `z.coerce.number()` on
  // none) and for none from Zod 4.4.0, so its presence is unread too.
  const r = run({
    'src/a.ts': `${ZOD}export const Input = z.object({
      caught: z.string().catch('x'),
      caughtDate: z.string().datetime().catch('1970-01-01T00:00:00Z'),
      caughtArray: z.array(z.string()).catch([]),
      caughtOptional: z.string().optional().catch('x'),
      caughtDefault: z.string().default('d').catch('x'),
      caughtThenOptional: z.string().catch('x').optional(),
      coerceString: z.coerce.string(),
      coerceNumber: z.coerce.number(),
      coerceDate: z.coerce.date(),
      coerceBoolean: z.coerce.boolean(),
      unionOfCatch: z.union([z.string().catch('x'), z.number()]),
      intersectionOfCatch: z.intersection(z.string().catch('x'), z.string()),
      coerceOptional: z.coerce.number().optional(),
      coerceDefault: z.coerce.number().default(0),
      catchNullish: z.intersection(z.bigint().nullish(), z.null().catch(null)).nullable(),
      catchAndCatch: z.intersection(z.string().catch('x'), z.string().catch('y')),
      defaultAndDefault: z.intersection(z.string().default('a'), z.string().default('b')),
      defaultAndOptional: z.intersection(z.string().optional(), z.string().default('a')),
      optionalAndOptional: z.intersection(z.string().optional(), z.string().optional()),
      plainString: z.string(),
      plainNumber: z.number(),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));
  assert.equal(byName.size, 21);

  for (const name of [
    'caught',
    'caughtDate',
    'caughtArray',
    'caughtOptional',
    'caughtDefault',
    'caughtThenOptional',
    'coerceString',
    'coerceNumber',
    'coerceDate',
    'coerceBoolean',
    'unionOfCatch',
    'intersectionOfCatch',
  ])
    assert.equal(byName.get(name)?.['nullable'], undefined, `${name}.nullable`);

  // A bare catch accepts a missing key on every release except Zod 4.4.0 to
  // 4.4.2, which reject it, so its presence is unread; so is the presence of a
  // union or an intersection that holds one as a branch.
  for (const name of ['caught', 'caughtDate', 'caughtArray', 'unionOfCatch', 'intersectionOfCatch'])
    assert.equal(byName.get(name)?.['required'], undefined, `${name}.required`);
  // A catch whose receiver already accepts a missing key (`.optional()`,
  // `.default(v)`) accepts one on every release, and so does an `.optional()`
  // written after the catch.
  for (const name of ['caughtOptional', 'caughtDefault', 'caughtThenOptional'])
    assert.equal(byName.get(name)?.['required'], false, `${name}.required`);

  // A coercion's presence depends on the base type and is not read.
  for (const name of ['coerceString', 'coerceNumber', 'coerceDate', 'coerceBoolean'])
    assert.equal(byName.get(name)?.['required'], undefined, `${name}.required`);
  // An explicit presence modifier after it is still read.
  assert.equal(byName.get('coerceOptional')?.['required'], false);
  assert.equal(byName.get('coerceOptional')?.['nullable'], undefined);
  assert.equal(byName.get('coerceDefault')?.['required'], false);

  // What the base says about the output type is still a fact.
  assert.equal(byName.get('caught')?.['type'], 'string');
  assert.equal(byName.get('caughtOptional')?.['type'], 'string');
  assert.equal(byName.get('caughtDate')?.['format'], 'date-time');
  assert.equal(byName.get('coerceString')?.['type'], 'string');
  assert.equal(byName.get('coerceNumber')?.['type'], 'number');
  assert.equal(byName.get('coerceBoolean')?.['type'], 'boolean');

  // An intersection of branches that are all optional is not stated `false`.
  // Zod 3.25 accepts a missing key only when the branches agree on the value it
  // parses to (`undefined` under `.optional()`, the fallback under a catch or a
  // default: `z.intersection(z.bigint().nullish(), z.null().catch(null))`
  // rejects one), and current Zod 4 rejects it even for two `.optional()`.
  for (const name of [
    'catchNullish',
    'catchAndCatch',
    'defaultAndDefault',
    'defaultAndOptional',
    'optionalAndOptional',
  ])
    assert.equal(byName.get(name)?.['required'], undefined, `${name}.required`);

  // The controls: no catch and no coercion.
  for (const name of ['plainString', 'plainNumber']) {
    assert.equal(byName.get(name)?.['nullable'], false, `${name}.nullable`);
    assert.equal(byName.get(name)?.['required'], true, `${name}.required`);
  }
});

test('a catch on a union with one non-null branch still states no null-ness', () => {
  // `analyzeSchema` collapses a union with exactly one non-null branch to that
  // branch, so a marker set on the union by a chain link has to survive the
  // collapse or the branch's own `nullable: false` is read instead.
  const r = run({
    'src/a.ts': `${ZOD}const NUL = null;
    export const Input = z.object({
      oneLiteral: z.union([z.literal('a')]).catch(null),
      oneString: z.union([z.string()]).catch('x'),
      stringOrNull: z.union([z.string(), z.null()]).catch('x'),
      unreadOne: z.union([z.literal(NUL)]).catch('x'),
      optionalThenCatch: z.union([z.string()]).optional().catch('x'),
      control: z.union([z.string()]),
      controlOrNull: z.union([z.string(), z.null()]),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));
  assert.equal(byName.size, 7);

  // A bare catch leaves presence unread (Zod 4.4.0 to 4.4.2 reject a missing key
  // there); a catch after `.optional()` accepts one on every release.
  for (const name of [
    'oneLiteral',
    'oneString',
    'stringOrNull',
    'unreadOne',
    'optionalThenCatch',
  ]) {
    assert.equal(byName.get(name)?.['nullable'], undefined, `${name}.nullable`);
    assert.equal(
      byName.get(name)?.['required'],
      name === 'optionalThenCatch' ? false : undefined,
      `${name}.required`,
    );
  }
  // Without the catch the same unions state what they say.
  assert.equal(byName.get('control')?.['nullable'], false);
  assert.equal(byName.get('control')?.['required'], true);
  assert.equal(byName.get('controlOrNull')?.['nullable'], true);
});

test('a coercion switched on by a constructor option accepts a null like z.coerce.*', () => {
  // `z.number({ coerce: true })` is `z.coerce.number()` spelled with an option
  // (Zod 3.25 and Zod 4 both read it), so it takes a null and, for some bases,
  // a missing key. An options argument that is not read could say the same.
  const r = run({
    'src/a.ts': `${ZOD}const OPTS = { coerce: true };
    const OFF = { coerce: false };
    declare function options(): { coerce: boolean };
    export const Input = z.object({
      optNumber: z.number({ coerce: true }),
      optString: z.string({ coerce: true }),
      optBoolean: z.boolean({ coerce: true }),
      optDate: z.date({ coerce: true }),
      optBigint: z.bigint({ coerce: true }),
      optQuoted: z.number({ 'coerce': true, error: 'n' }),
      optMixed: z.number({ error: 'n', coerce: true }),
      optNamedTrue: z.number(OPTS),
      optNamedFalse: z.number(OFF),
      optCall: z.number(options()),
      optSpread: z.number({ ...OPTS }),
      optShorthand: z.number({ coerce }),
      optComputed: z.number({ ['coerce']: true }),
      optFlag: z.number({ coerce: Boolean(1) }),
      optChained: z.string({ coerce: true }).min(1).optional(),
      optArray: z.array(z.number({ coerce: true })),
      offLiteral: z.number({ coerce: false }),
      offMessages: z.string({ required_error: 'r', invalid_type_error: 'i' }),
      offError: z.string({ error: (issue) => 'bad' }),
      offString: z.string('message'),
      offNone: z.number(),
      offTemplate: z.string(\`message\`),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));
  assert.equal(byName.size, 22);

  // Null-ness and presence are not read, whatever the option says. A binding
  // handed to a constructor is not followed (the callee could change it), so
  // `z.number(OFF)` is as unread as `z.number(OPTS)`.
  for (const name of [
    'optNumber',
    'optString',
    'optBoolean',
    'optDate',
    'optBigint',
    'optQuoted',
    'optMixed',
    'optNamedTrue',
    'optNamedFalse',
    'optCall',
    'optSpread',
    'optShorthand',
    'optComputed',
    'optFlag',
  ]) {
    assert.equal(byName.get(name)?.['nullable'], undefined, `${name}.nullable`);
    assert.equal(byName.get(name)?.['required'], undefined, `${name}.required`);
  }
  // What the base says about the output type is still a fact.
  assert.equal(byName.get('optNumber')?.['type'], 'number');
  assert.equal(byName.get('optString')?.['type'], 'string');
  assert.equal(byName.get('optBoolean')?.['type'], 'boolean');
  assert.equal(byName.get('optDate')?.['format'], 'date-time');

  // A presence modifier after it is still read; its null-ness is not.
  assert.equal(byName.get('optChained')?.['nullable'], undefined);
  assert.equal(byName.get('optChained')?.['required'], false);
  // An array is not null, whatever its element coerces.
  assert.equal(byName.get('optArray')?.['nullable'], false);
  assert.equal(byName.get('optArray')?.['type'], 'array<number>');

  // The controls: an options argument that cannot coerce changes nothing.
  for (const name of [
    'offLiteral',
    'offMessages',
    'offError',
    'offString',
    'offNone',
    'offTemplate',
  ]) {
    assert.equal(byName.get(name)?.['nullable'], false, `${name}.nullable`);
    assert.equal(byName.get(name)?.['required'], true, `${name}.required`);
  }
});

test('z.undefined() and z.void() leave presence unread: Zod 3.25 and Zod 4 disagree', () => {
  // Zod 3.25 accepts a missing key for `z.undefined()` and `z.void()` and for a
  // union that holds one; current Zod 4 rejects it. The extractor does not know
  // which release the code runs on, so it states no `required` for them. An
  // explicit `.optional()` (or a default) accepts a missing key on both.
  const r = run({
    'src/a.ts': `${ZOD}export const Input = z.object({
      undef: z.undefined(),
      nothing: z.void(),
      undefOrString: z.union([z.string(), z.undefined()]),
      voidOnly: z.union([z.void()]),
      viaOr: z.string().or(z.undefined()),
      undefOptional: z.undefined().optional(),
      voidDefault: z.void().default(undefined),
      undefNullish: z.undefined().nullish(),
      plain: z.string(),
      plainOptional: z.string().optional(),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));
  assert.equal(byName.size, 10);

  for (const name of ['undef', 'nothing', 'undefOrString', 'voidOnly', 'viaOr'])
    assert.equal(byName.get(name)?.['required'], undefined, `${name}.required`);
  // z.undefined() and z.void() reject a null on both releases, and say so.
  for (const name of ['undef', 'nothing'])
    assert.equal(byName.get(name)?.['nullable'], false, `${name}.nullable`);

  // A presence modifier after it is read on every release.
  for (const name of ['undefOptional', 'voidDefault', 'undefNullish', 'plainOptional'])
    assert.equal(byName.get(name)?.['required'], false, `${name}.required`);
  assert.equal(byName.get('plain')?.['required'], true);
});

test('a catch on something with nested properties withholds the contract', () => {
  // A catch swallows a failure anywhere below it, so `{ a: null }` is accepted
  // by `z.object({ a: z.string() }).catch(...)`: no nested property's
  // `nullable`, `required` or `type` is a fact. Like any modifier on a receiver
  // with nested properties, it is shape-level.
  const r = run({
    'src/a.ts': `${ZOD}export const Nested = z.object({
      inner: z.object({ a: z.string() }).catch({ a: 'x' }),
    });
    export const Listed = z.object({ rows: z.array(z.object({ a: z.string() })).catch([]) });
    export const Unioned = z.object({ one: z.union([z.looseObject({ a: z.string() })]).catch('x') });
    export const Scalars = z.object({
      id: z.string().catch('x'),
      tags: z.array(z.string()).catch([]),
      search: z.string().optional().catch(undefined),
      page: z.array(z.string()).default([]).catch([]),
    });
    export const Sibling = z.object({ ok: z.boolean() });`,
  });
  assert.equal(r.result.status, 'PASS');
  assert.deepEqual(contractNames(r), ['Scalars', 'Sibling']);
  assert.ok(
    r.result.diagnostics.some((d) => d.startsWith('ZOD_UNSUPPORTED_MODIFIER')),
    r.result.diagnostics.join('; '),
  );
  const scalars = new Map(properties(r, 'Scalars').map((n) => [n.name, n.props]));
  for (const name of ['id', 'tags', 'search', 'page']) {
    assert.equal(scalars.get(name)?.['nullable'], undefined, `${name}.nullable`);
    // Presence is stated only where the receiver already accepts a missing key.
    assert.equal(
      scalars.get(name)?.['required'],
      name === 'search' || name === 'page' ? false : undefined,
      `${name}.required`,
    );
  }
  assert.equal(scalars.get('tags')?.['isArray'], true);
});

test('an unread literal argument may be undefined, so the property is not stated required', () => {
  // `z.literal(undefined)` and the Zod 4 list form `z.literal(['a', undefined])`
  // accept a missing key. A binding or a call that holds `undefined` does too.
  const r = run({
    'src/a.ts': `${ZOD}const UND = undefined;
    function make() { return 'a'; }
    export const Input = z.object({
      named: z.literal(UND),
      direct: z.literal(undefined),
      zod4List: z.literal(['a', undefined]),
      called: z.literal(make()),
      namedOptional: z.literal(UND).optional(),
      stringLiteral: z.literal('a'),
      nullLiteral: z.literal(null),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));
  assert.equal(byName.size, 7);

  for (const name of ['named', 'direct', 'zod4List', 'called'])
    assert.equal(byName.get(name)?.['required'], undefined, `${name}.required`);
  // An explicit presence modifier after it is still read.
  assert.equal(byName.get('namedOptional')?.['required'], false);
  // A literal that is read still states what it is.
  assert.equal(byName.get('stringLiteral')?.['required'], true);
  assert.equal(byName.get('nullLiteral')?.['required'], true);
});

test('an intersection states an object type only when every branch is an object', () => {
  // The shared schema walk reads a bare `allOf` as an object, which is right
  // for an intersection of objects and states a type nobody read for the rest.
  const r = run({
    'src/a.ts': `${ZOD}export const Input = z.object({
      twoStrings: z.intersection(z.string(), z.string()),
      bounded: z.intersection(z.string().min(1), z.string().max(9)),
      mixed: z.intersection(z.object({ a: z.string() }), z.string()),
      numbers: z.intersection(z.number(), z.number().int()),
      lists: z.intersection(z.array(z.string()), z.array(z.string())),
      viaUnion: z.intersection(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]), z.object({ c: z.string() })),
      objects: z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })),
      nullableObjects: z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })).nullable(),
      records: z.intersection(z.record(z.string(), z.string()), z.object({ a: z.string() })),
      threeObjects: z.intersection(z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })), z.object({ c: z.string() })),
      scalarInside: z.intersection(z.intersection(z.string(), z.string()), z.object({ c: z.string() })),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));

  for (const name of [
    'twoStrings',
    'bounded',
    'mixed',
    'numbers',
    'lists',
    'viaUnion',
    'scalarInside',
  ]) {
    for (const facet of ['type', 'typeCategory', 'format'])
      assert.equal(byName.get(name)?.[facet], undefined, `${name}.${facet}`);
    // Presence and null-ness are separate facts and are still read.
    assert.equal(byName.get(name)?.['required'], true, `${name}.required`);
  }
  // `nullable` is unaffected: the branches say nothing about null.
  assert.equal(byName.get('twoStrings')?.['nullable'], false);

  for (const name of ['objects', 'nullableObjects', 'records', 'threeObjects']) {
    assert.equal(byName.get(name)?.['type'], 'object', `${name}.type`);
    assert.equal(byName.get(name)?.['typeCategory'], 'json', `${name}.typeCategory`);
  }
});

test('an array of coerced elements keeps its element type', () => {
  // A coercion leaves the element's presence unread, but an array's own type
  // and presence do not depend on whether its element may be omitted.
  const r = run({
    'src/a.ts': `${ZOD}export const Input = z.object({
      viaCall: z.array(z.coerce.number()),
      viaChain: z.coerce.number().array(),
      viaSet: z.set(z.coerce.string()),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));
  assert.equal(byName.get('viaCall')?.['type'], 'array<number>');
  assert.equal(byName.get('viaChain')?.['type'], 'array<number>');
  assert.equal(byName.get('viaSet')?.['type'], 'array<string>');
  for (const name of ['viaCall', 'viaChain', 'viaSet']) {
    assert.equal(byName.get(name)?.['required'], true, `${name}.required`);
    assert.equal(byName.get(name)?.['nullable'], false, `${name}.nullable`);
  }
});

test('an array of an unread union leaves the element type unknown, however the array is written', () => {
  // `.array()` rebuilds the property from scratch around the readable part of
  // the union. That must not turn one readable branch into a stated element type.
  const r = run({
    'src/a.ts': `${ZOD}const OPTIONS = [z.string(), z.null()] as const;
    export const Input = z.object({
      viaChain: z.union([z.string().refine(f), z.number()]).array(),
      viaCall: z.array(z.union([z.string().refine(f), z.number()])),
      named: z.union(OPTIONS).array(),
      optionalElement: z.array(z.union(OPTIONS).optional()),
      optionalChain: z.union(OPTIONS).optional().array(),
      readableChain: z.union([z.string(), z.number()]).array(),
      readableCall: z.array(z.union([z.string(), z.number()])),
    });`,
  });
  assert.equal(r.result.status, 'PASS');
  const byName = new Map(properties(r, 'Input').map((n) => [n.name, n.props]));

  for (const name of ['viaChain', 'viaCall', 'named', 'optionalElement', 'optionalChain']) {
    // That it is an array, and that the array itself is present and not null, is read.
    assert.equal(byName.get(name)?.['isArray'], true, `${name}.isArray`);
    assert.equal(byName.get(name)?.['required'], true, `${name}.required`);
    assert.equal(byName.get(name)?.['nullable'], false, `${name}.nullable`);
    // What it holds is not.
    for (const facet of ['type', 'typeCategory', 'format'])
      assert.equal(byName.get(name)?.[facet], undefined, `${name}.${facet}`);
  }

  // The same arrays over a union that is fully read still state their type.
  for (const name of ['readableChain', 'readableCall'])
    assert.equal(byName.get(name)?.['type'], 'array<number|string>', `${name}.type`);
});

test('a scope whose only contracts were withheld for a name collision is UNAVAILABLE, not a PASS with none', () => {
  const r = run({
    'src/users/schema.ts': `${ZOD}export const FormSchema = z.object({ email: z.string() });`,
    'src/orders/schema.ts': `${ZOD}export const FormSchema = z.object({ total: z.number() });`,
  });
  assert.equal(r.result.status, 'UNAVAILABLE');
  assert.deepEqual(contractNames(r), []);
  assert.equal(r.nodes.length, 0);
  // The same repository with one more readable schema has a certain source.
  const withOther = run({
    'src/users/schema.ts': `${ZOD}export const FormSchema = z.object({ email: z.string() });`,
    'src/orders/schema.ts': `${ZOD}export const FormSchema = z.object({ total: z.number() });`,
    'src/other.ts': `${ZOD}export const Other = z.object({ id: z.string() });`,
  });
  assert.equal(withOther.result.status, 'PASS');
});

test('a withheld OpenAPI contract keeps its operations and route handlers but is no longer their container', () => {
  const api = (path: string, id: string) =>
    `openapi: 3.0.3\ninfo: { title: Shared API, version: 1.0.0 }\npaths:\n  ${path}:\n    get: { operationId: ${id}, responses: { '200': { description: ok } } }\n`;
  const r = run({
    'a/openapi.yaml': api('/users', 'listUsers'),
    'b/openapi.yaml': api('/orders', 'listOrders'),
  });
  // Both documents are read to the end, so the scope has sources, but neither
  // can own the contract name.
  assert.equal(r.result.status, 'PASS');
  assert.deepEqual(contractNames(r), []);
  assert.deepEqual(
    r.nodes.filter((n) => n.kind === 'Operation').length,
    2,
    'operations are keyed by method and path, not by contract',
  );
  assert.equal(r.nodes.filter((n) => n.kind === 'RouteHandler').length, 2);
  assert.equal(r.edges.filter((e) => e.kind === 'IMPLEMENTED_BY').length, 2);
  assert.equal(r.edges.filter((e) => e.kind === 'CONTAINS').length, 0);
  assert.ok(r.result.diagnostics.some((d) => d.startsWith('CONTRACT_NAME_COLLISION: Shared API ')));
});

// Truncated mid-edit: JSON.parse rejects it, and the text still reads like OpenAPI.
const BROKEN_OPENAPI = '{ "openapi": "3.0.3", "info": { "title": "Docs API", "version": "1.0.0" },';
const FINE = `${ZOD}export const Fine = z.object({ id: z.string() });`;

test('a document that reads like a contract but does not parse leaves the claim, whatever it is named', () => {
  const r = run({ 'docs/api.json': BROKEN_OPENAPI, 'src/fine.ts': FINE });
  assert.equal(r.result.status, 'PASS');
  assert.equal(r.result.authoritative[0]?.selector, 'src/**');
  assert.ok(
    r.result.diagnostics.some((d) => d.startsWith('CONTRACTS_PARTIAL_COVERAGE: 1 file(s)')),
    r.result.diagnostics.join('\n'),
  );
  // The same text under a strict contract name is still a failure of the scope.
  assert.equal(
    run({ 'docs/openapi.json': BROKEN_OPENAPI, 'src/fine.ts': FINE }).result.status,
    'FAIL',
  );
});

test('JSON that does not parse but names a JSON Schema dialect leaves the claim', () => {
  const r = run({
    'docs/user.json':
      '{ "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object",',
    'src/fine.ts': FINE,
  });
  assert.equal(r.result.status, 'PASS');
  assert.equal(r.result.authoritative[0]?.selector, 'src/**');
});

test('a JSON parse failure narrows the claim even when no contract header survives', () => {
  // A comment is readable; a truncated value after it still cannot prove absence.
  const r = run({
    'tsconfig.json': '{\n  // compiler options\n  "compilerOptions": { "strict":\n',
    'src/fine.ts': FINE,
  });
  assert.equal(r.result.status, 'PASS');
  assert.equal(r.result.authoritative[0]?.selector, 'src/**');
  assert.ok(
    r.result.diagnostics.some((d) => d.startsWith('CONTRACTS_PARTIAL_COVERAGE: 1 file(s)')),
  );
});

test('a discovered document too large to read leaves the claim, whatever it is named', () => {
  const r = run(
    {
      'docs/api.yaml': `openapi: 3.0.3\ninfo: { title: Big API, version: 1.0.0 }\n${'# padding\n'.repeat(400)}`,
      'src/fine.ts': FINE,
    },
    { maxFileBytes: 600 },
  );
  assert.equal(r.result.status, 'PASS');
  assert.equal(r.result.authoritative[0]?.selector, 'src/**');
});
