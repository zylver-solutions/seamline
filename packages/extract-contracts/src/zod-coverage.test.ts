import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileSelector } from '@seamline/core';
import { extractContracts } from './extract.ts';
import { makeEmptyRepo } from './test-harness.ts';

function extract(source: string, file = 'src/schema.ts') {
  const repo = makeEmptyRepo();
  try {
    writeFileSync(join(repo.root, file), `import { z } from 'zod';\n${source}`, 'utf8');
    return extractContracts({ repoRoot: repo.root, repo: 'coverage', runId: 'r1', files: [file] });
  } finally {
    repo.dispose();
  }
}

/**
 * The same source beside a second, fully supported contract in its own file, so
 * that withholding the first leaves a scope that still has something to
 * certify. Returns the result of the run over both files.
 */
function extractWithControl(source: string, file = 'src/schema.ts') {
  const repo = makeEmptyRepo();
  try {
    writeFileSync(join(repo.root, file), `import { z } from 'zod';\n${source}`, 'utf8');
    writeFileSync(
      join(repo.root, 'src/control.ts'),
      `import { z } from 'zod';\nexport const Control = z.object({ id: z.string() });`,
      'utf8',
    );
    return extractContracts({
      repoRoot: repo.root,
      repo: 'coverage',
      runId: 'r1',
      files: [file, 'src/control.ts'],
    });
  } finally {
    repo.dispose();
  }
}

function contractNames(result: ReturnType<typeof extract>) {
  return result.nodes
    .filter((node) => node.kind === 'Contract')
    .map((node) => node.name)
    .sort();
}

function assertSelectedFileAuthority(result: ReturnType<typeof extract>): void {
  const selector = result.result.authoritative[0]?.selector;
  assert.equal(selector, 'src/schema.ts', 'explicit selection cannot authorize an unselected file');
  const selected = compileSelector(selector as string);
  assert.equal(selected.matches('src/schema.ts'), true);
  assert.equal(selected.matches('src/unselected.ts'), false);
}

/**
 * A shape-level gap: the contract is not emitted at all (neither it nor any of
 * its properties), the rest of the scope still passes, and the claim no longer
 * covers the file the contract was declared in.
 */
function assertWithheld(
  result: ReturnType<typeof extract>,
  reason: string,
  contract = 'Input',
  file = 'src/schema.ts',
) {
  assert.equal(result.result.status, 'PASS');
  assert.ok(!contractNames(result).includes(contract), `${contract} must not be emitted`);
  assert.ok(contractNames(result).includes('Control'), 'the supported contract is still emitted');
  assert.deepEqual(fields(result, contract), []);
  assert.equal(result.result.authoritative[0]?.selector, 'src/control.ts');
  assert.ok(
    result.result.diagnostics.some((value) => value.startsWith(`${reason}:`)),
    `${reason} is reported`,
  );
  assert.ok(
    result.result.diagnostics.includes(`ZOD_CONTRACT_WITHHELD: ${file} contract ${contract}`),
  );
}

function fields(result: ReturnType<typeof extract>, contract = 'Input') {
  return result.nodes.filter(
    (node) => node.kind === 'SchemaProperty' && node.props['contract'] === contract,
  );
}

function property(result: ReturnType<typeof extract>, contract: string, pointer: string) {
  return fields(result, contract).find(
    (node) => node.id === `coverage:SchemaProperty:${contract}#/properties${pointer}`,
  );
}

test('literal shape spreads include fields and preserve last assignment optionality', () => {
  const result = extract(`
    const base = { value: z.string(), first: z.number() } as const;
    const middle = { ...base, value: z.number().optional() };
    export const Input = z.object({ ...middle, last: z.boolean(), first: z.string().nullish() });
  `);
  assert.equal(result.result.status, 'PASS');
  assert.deepEqual(
    fields(result).map((node) => [
      node.name,
      node.props['typeCategory'],
      node.props['required'],
      node.props['nullable'],
    ]),
    [
      ['first', 'text', false, true],
      ['last', 'boolean', true, false],
      ['value', 'numeric', false, false],
    ],
  );
});

test('unresolved wrappers cannot manufacture required properties', () => {
  const result = extractWithControl(`const wrap = (schema: unknown) => schema;
    export const Input = z.object({ uncertain: wrap(z.string()), known: z.string().optional() });`);
  assertWithheld(result, 'ZOD_UNSUPPORTED_EXPRESSION');
});

test('extend replacement removes the earlier required obligation', () => {
  const result = extract(
    `export const Input = z.object({ value: z.string() }).extend({ value: z.number().optional() });`,
  );
  assert.equal(result.result.status, 'PASS');
  assert.deepEqual(
    fields(result).map((node) => [node.name, node.props['typeCategory'], node.props['required']]),
    [['value', 'numeric', false]],
  );
});

for (const [name, prefix, member, reason] of [
  [
    'import',
    `import { shape } from './external.ts';`,
    '...shape',
    'ZOD_UNSUPPORTED_SHAPE_REFERENCE',
  ],
  ['dynamic', 'const shape = getShape();', '...shape', 'ZOD_UNSUPPORTED_SHAPE'],
  ['cycle', 'const a = { ...b }; const b = { ...a };', '...a', 'ZOD_UNSUPPORTED_CYCLE'],
  ['computed', '', '[getKey()]: z.string()', 'ZOD_UNSUPPORTED_COMPUTED_KEY'],
  [
    'mutable',
    'let shape = { unknown: z.string() };',
    '...shape',
    'ZOD_UNSUPPORTED_SHAPE_REFERENCE',
  ],
  [
    'getter',
    '',
    'get unknown() { throw new Error("do not execute"); }',
    'ZOD_UNSUPPORTED_SHAPE_MEMBER',
  ],
] as const) {
  test(`unsupported ${name} composition withholds the contract instead of emitting a short one`, () => {
    const result = extractWithControl(
      `${prefix} export const Input = z.object({ before: z.string(), ${member}, after: z.number() });`,
    );
    assertWithheld(result, reason);
  });
}

test('empty complete shapes retain their contract and do not become unavailable', () => {
  const result = extract(`const shape = {}; export const Input = z.object(shape);`);
  assert.equal(result.result.status, 'PASS');
  assert.equal(
    result.nodes.filter((node) => node.kind === 'Contract' && node.name === 'Input').length,
    1,
  );
  assert.deepEqual(fields(result), []);
});

test('known composition is reproducible and property identities survive file movement', () => {
  const source = `throw new Error('never execute'); const shape = { a: z.string().optional() }; export const Input = z.object({ ...shape });`;
  const first = extract(source);
  const replay = extract(source);
  const renamed = extract(source, 'src/renamed.ts');
  assert.equal(first.result.status, 'PASS');
  assert.deepEqual(first.nodes, replay.nodes);
  assert.deepEqual(first.edges, replay.edges);
  assert.deepEqual(
    first.nodes.map((node) => node.id),
    renamed.nodes.map((node) => node.id),
  );
  assert.deepEqual(
    first.edges.map((edge) => [edge.kind, edge.src, edge.dst]),
    renamed.edges.map((edge) => [edge.kind, edge.src, edge.dst]),
  );
});

test('imported enum members leave only the member set unknown, and the scope passes', () => {
  const result = extract(
    `import { values } from './values.ts'; export const Input = z.object({ state: z.enum(values) });`,
  );
  assert.equal(result.result.status, 'PASS');
  assertSelectedFileAuthority(result);
  assert.deepEqual(
    fields(result).map((node) => [
      node.name,
      node.props['typeCategory'],
      node.props['type'],
      node.props['required'],
      node.props['enumValues'],
    ]),
    [['state', 'enum', 'string', true, undefined]],
  );
  assert.ok(
    result.result.diagnostics.some((value) => value.startsWith('ZOD_UNSUPPORTED_ENUM_MEMBERS')),
  );
});

test('same-file schema aliases and constant enum members compose without evaluation', () => {
  const result =
    extract(`const values = ['one', 'two'] as const; const Base = z.object({ value: z.string() });
    export const Input = Base.extend({ value: z.number().optional(), state: z.enum(values) });`);
  assert.equal(result.result.status, 'PASS');
  assert.deepEqual(
    fields(result).map((node) => [node.name, node.props['required']]),
    [
      ['state', true],
      ['value', false],
    ],
  );
  assert.equal(fields(result)[0]?.props['enumCount'], 2);
});

test('a partly dynamic enum never exports the known subset as the complete set', () => {
  const result = extract(`export const Input = z.object({ state: z.enum(['one', external]) });`);
  assert.equal(result.result.status, 'PASS');
  assert.equal(fields(result)[0]?.props['enumValues'], undefined);
  assert.equal(fields(result)[0]?.props['enumCount'], undefined);
});

test('an unsupported later field or extend cannot retain an earlier required value', () => {
  for (const source of [
    `const shape = { value: z.string() }; export const Input = z.object({ ...shape, value: wrap(z.number()), known: z.string() });`,
    `export const Input = z.object({ value: z.string() }).extend({ value: wrap(z.number()), known: z.string() });`,
  ]) {
    const result = extractWithControl(source);
    assertWithheld(result, 'ZOD_UNSUPPORTED_EXPRESSION');
  }
});

test('unsupported nested composition withholds the whole contract, siblings included', () => {
  const result = extractWithControl(
    `export const Input = z.object({ nested: z.object({ ...external }), sibling: z.boolean() });`,
  );
  assertWithheld(result, 'ZOD_UNSUPPORTED_SHAPE_REFERENCE');
});

test('repeated shape aliases exhaust a deterministic work bound instead of expanding without limit', () => {
  const aliases = Array.from(
    { length: 17 },
    (_, index) => `const s${index + 1} = { ...s${index}, ...s${index} };`,
  ).join('\n');
  const result = extractWithControl(
    `const s0 = { value: z.string() }; ${aliases} export const Input = z.object({ ...s17 });`,
  );
  assertWithheld(result, 'ZOD_UNSUPPORTED_WORK_LIMIT');
});

for (const mutation of [
  'shape.value = z.number().optional();',
  'const alias = shape; alias.value = z.number().optional();',
  'Object.assign(shape, { value: z.number().optional() });',
  'change(shape);',
]) {
  test(`mutable or escaped literal shape is not authoritative: ${mutation}`, () => {
    const result = extractWithControl(`const shape = { value: z.string() }; ${mutation}
      export const Input = z.object({ ...shape, known: z.boolean() });`);
    assertWithheld(result, 'ZOD_UNSUPPORTED_SHAPE_REFERENCE');
    assert.equal(property(result, 'Input', '/value'), undefined);
    assert.equal(property(result, 'Input', '/known'), undefined);
  });
}

test('mutated enum aliases do not publish stale member sets', () => {
  const result = extract(`const values = ['one']; const alias = values;
    alias.push('two'); export const Input = z.object({ state: z.enum(values) });`);
  assert.equal(result.result.status, 'PASS');
  assert.equal(property(result, 'Input', '/state')?.props['typeCategory'], 'enum');
  assert.equal(property(result, 'Input', '/state')?.props['enumValues'], undefined);
});

for (const expression of [
  'z.string().unknownWrapper().optional()',
  'z.string().transform(Number).optional()',
]) {
  test(`unsupported wrappers keep the property and leave every facet unknown: ${expression}`, () => {
    const result = extract(
      `export const Input = z.object({ value: ${expression}, known: z.boolean() });`,
    );
    assert.equal(result.result.status, 'PASS');
    assertSelectedFileAuthority(result);
    const value = property(result, 'Input', '/value');
    assert.ok(value !== undefined, 'the property is declared, so it is listed');
    // Not defaulted: no type, category, requiredness, nullability, arrayness or default.
    for (const facet of [
      'type',
      'format',
      'typeCategory',
      'required',
      'nullable',
      'isArray',
      'hasDefault',
      'default',
    ])
      assert.equal(value.props[facet], undefined, `${facet} is not extracted`);
    assert.equal(property(result, 'Input', '/known')?.props['required'], true);
    assert.equal(property(result, 'Input', '/known')?.props['nullable'], false);
    assert.ok(
      result.result.diagnostics.includes('ZOD_UNSUPPORTED_MODIFIER: src/schema.ts contract Input'),
    );
  });
}

test('array wrapper resets outer presence after inner optional', () => {
  const result = extract(
    `export const Input = z.object({ value: z.string().optional().array() });`,
  );
  assert.equal(result.result.status, 'PASS');
  assert.equal(property(result, 'Input', '/value')?.props['required'], true);
});

for (const mutation of [
  'const holder = { nested: shape }; holder.nested.value = z.number();',
  'const holder = [shape]; holder[0].value = z.number();',
]) {
  test(`raw shapes stored through unmodeled nested aliases stay unknown: ${mutation}`, () => {
    const result = extractWithControl(`const shape = { value: z.string() }; ${mutation}
      export const Input = z.object({ ...shape, known: z.boolean() });`);
    assertWithheld(result, 'ZOD_UNSUPPORTED_SHAPE_REFERENCE');
  });
}

test('parser recovery cannot certify a truncated source', () => {
  const result = extractWithControl(`export const Input = z.object({ value: z.string()`);
  assert.equal(result.result.status, 'PASS');
  assert.deepEqual(fields(result), []);
  assert.deepEqual(contractNames(result), ['Control']);
  assert.equal(result.result.authoritative[0]?.selector, 'src/control.ts');
  assert.ok(result.result.diagnostics.includes('ZOD_UNSUPPORTED_PARSE: src/schema.ts'));
});

test('nested helper wrappers are discovered through non-expression syntax nodes', () => {
  const result = extract(`import { build } from './external.ts';
    export const Input = build({ value: z.string() }); export const Known = z.object({ known: z.boolean() });`);
  assert.equal(result.result.status, 'PASS');
  assert.deepEqual(fields(result), []);
  assert.equal(fields(result, 'Known').length, 1);
  // The file is not vouched for, and no other file was read: the claim is empty.
  assert.equal(result.result.authoritative[0]?.selector, '**/*,!**/*');
});

for (const expression of [
  'z.lazy(function () { return z.string().optional(); })',
  'z.lazy(() => { return z.string(); })',
]) {
  test(`unmodeled lazy blocks cannot manufacture a required field: ${expression}`, () => {
    const result = extractWithControl(`export const Input = z.object({ value: ${expression} });`);
    assertWithheld(result, 'ZOD_UNSUPPORTED_LAZY');
  });
}

test('supported lazy expression keeps its own presence obligation', () => {
  const result = extract(
    `export const Input = z.object({ value: z.lazy(() => z.string().optional()) });`,
  );
  assert.equal(result.result.status, 'PASS');
  assert.equal(property(result, 'Input', '/value')?.props['required'], false);
});

test('masked partial keeps the properties and does not pretend to know which are optional', () => {
  const result = extract(
    `export const Input = z.object({ a: z.string(), b: z.string() }).partial({ a: true });`,
  );
  assert.equal(result.result.status, 'PASS');
  assert.deepEqual(
    fields(result).map((node) => [
      node.name,
      node.props['typeCategory'],
      node.props['nullable'],
      node.props['required'],
    ]),
    [
      ['a', 'text', false, undefined],
      ['b', 'text', false, undefined],
    ],
  );
  assert.ok(
    result.result.diagnostics.includes(
      'ZOD_UNSUPPORTED_PARTIAL_MASK: src/schema.ts contract Input',
    ),
  );
});

test('prototype-setting literal keys are not declared as own schema fields', () => {
  const result = extractWithControl(
    `export const Input = z.object({ __proto__: z.string(), known: z.boolean() });`,
  );
  assertWithheld(result, 'ZOD_UNSUPPORTED_PROTOTYPE_KEY');
  assert.equal(property(result, 'Input', '/__proto__'), undefined);
});

for (const escape of [
  'let alias = shape; alias.value = z.number();',
  'var alias = shape; alias.value = z.number();',
  'const { nested: alias } = { nested: shape }; alias.value = z.number();',
  'function getter() { return shape; } getter().value = z.number();',
  'const getter = () => shape; getter().value = z.number();',
  'function local() { const alias = shape; alias.value = z.number(); } local();',
]) {
  test(`unmodeled aliases and return escapes cannot preserve stale shapes: ${escape}`, () => {
    const result = extractWithControl(`const shape = { value: z.string() }; ${escape}
      export const Input = z.object({ ...shape, known: z.boolean() });`);
    assertWithheld(result, 'ZOD_UNSUPPORTED_SHAPE_REFERENCE');
    assert.equal(property(result, 'Input', '/value'), undefined);
  });
}

for (const escape of [
  'mutate(Base);',
  'let alias = Base; alias.shape.value = z.number();',
  'Base.shape.value = z.number();',
  'Base = z.object({ value: z.number() });',
]) {
  test(`schema-value writes and escapes invalidate aliases: ${escape}`, () => {
    const result = extractWithControl(`const Base = z.object({ value: z.string() }); ${escape}
      export const Input = Base.extend({ known: z.boolean() });`);
    assertWithheld(result, 'ZOD_UNSUPPORTED_EXPRESSION');
    assert.equal(property(result, 'Input', '/value'), undefined);
  });
}

test('modeled array and lazy schema reads keep constant aliases supported', () => {
  const result = extract(`const Value = z.string().optional();
    export const Input = z.object({ values: z.array(Value), lazy: z.lazy(() => Value) });`);
  assert.equal(result.result.status, 'PASS');
  assert.equal(property(result, 'Input', '/values')?.props['required'], true);
  assert.equal(property(result, 'Input', '/lazy')?.props['required'], false);
});

test('missing optional TypeScript coverage cannot make mixed scope pass', () => {
  const repo = makeEmptyRepo();
  try {
    writeFileSync(
      join(repo.root, 'src/input.ts'),
      `import { z } from 'zod'; export const Input = z.object({ value: z.string() });`,
    );
    writeFileSync(
      join(repo.root, 'input.schema.json'),
      JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'Known',
        type: 'object',
        properties: { known: { type: 'string' } },
      }),
    );
    const script = `
      import * as module from 'node:module';
      const refuse = () => { throw new Error('fixture optional peer unavailable'); };
      if (typeof module.registerHooks === 'function') {
        module.registerHooks({ resolve(specifier, context, nextResolve) {
          if (specifier === 'typescript') return refuse();
          return nextResolve(specifier, context);
        } });
      } else {
        // Test-only fallback for the older supported Node baseline. The hook
        // affects only this fresh child, never this process or dependencies.
        const original = module.default._resolveFilename;
        module.default._resolveFilename = function (specifier, ...args) {
          if (specifier === 'typescript') return refuse();
          return original.call(this, specifier, ...args);
        };
      }
      const { extractContracts } = await import(process.argv[1]);
      const options = { repoRoot: process.argv[2], repo: 'missing-peer', runId: 'r1' };
      const mixed = extractContracts({ ...options, files: ['input.schema.json', 'src/input.ts'] });
      const standalone = extractContracts({ ...options, files: ['src/input.ts'] });
      const known = extractContracts({ ...options, files: ['input.schema.json'] });
      console.log(JSON.stringify({ mixed: mixed.result, standalone: standalone.result, known: known.result,
        mixedKnown: mixed.nodes.filter(node => node.kind === 'SchemaProperty').map(node => node.name) }));
    `;
    const child = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        script,
        new URL('./extract.ts', import.meta.url).href,
        repo.root,
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.mixed.status, 'FAIL');
    assert.equal(result.standalone.status, 'UNAVAILABLE');
    assert.equal(result.known.status, 'PASS');
    assert.deepEqual(result.mixedKnown, ['known']);
    assert.ok(
      result.mixed.diagnostics.some((value: string) => value.startsWith('TYPESCRIPT_UNAVAILABLE:')),
    );
  } finally {
    repo.dispose();
  }
});

for (const escape of [
  'const holder = { shape }; holder.shape.value = z.number().optional();',
  'const holder = {}; holder.shape = shape; holder.shape.value = z.number().optional();',
  'for (const alias of [shape]) { alias.value = z.number().optional(); }',
]) {
  test(`container assignment and iteration escapes remain unknown: ${escape}`, () => {
    const result = extractWithControl(`const shape = { value: z.string() }; ${escape}
      export const Input = z.object({ ...shape, known: z.boolean() });`);
    assertWithheld(result, 'ZOD_UNSUPPORTED_SHAPE_REFERENCE');
    assert.equal(property(result, 'Input', '/value'), undefined);
  });
}

test('schema shorthand stored in an escaped container is not authoritative', () => {
  const result =
    extractWithControl(`const Base = z.object({ value: z.string() }); const holder = { Base };
    mutate(holder); export const Input = Base.extend({ known: z.boolean() });`);
  assertWithheld(result, 'ZOD_UNSUPPORTED_EXPRESSION');
  assert.equal(property(result, 'Input', '/value'), undefined);
});

test('modeled parse reads and type-only references do not escape schemas', () => {
  const result = extract(`const shape = { value: z.string().optional() };
    export const Input = z.object({ ...shape });
    function handle(raw: unknown) { const parsed = Input.safeParse(raw);
      const data = parsed as z.infer<typeof Input>; return data; }
    function validate(data: Partial<Record<keyof typeof shape, unknown>>) { return data; }`);
  assert.equal(result.result.status, 'PASS');
  assert.equal(property(result, 'Input', '/value')?.props['required'], false);
});
