import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SeamlineNode } from '@seamline/ontology';
import { extractContracts } from './extract.ts';
import { makeEmptyRepo } from './test-harness.ts';
import type { ExtractLimits } from './types.ts';

const BASE = 'https://spec.openapis.org/oas/3.1/dialect/base';
const VALUE = '/paths/~1orders/post/responses/200/content/application~1json/schema/properties/value';
const shape = (value: unknown = {}, required = true): Record<string, unknown> => ({
  type: 'object', required: required ? ['value'] : [], properties: { value },
});
function document(schema: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { openapi: '3.1.0', info: { title: 'Orders', version: '1' },
    paths: { '/orders': { post: { responses: { '200': {
      description: 'Order', content: { 'application/json': { schema } },
    } } } } }, ...extra };
}
function extract(value: unknown, limits?: Partial<ExtractLimits>) {
  const repo = makeEmptyRepo();
  try {
    writeFileSync(join(repo.root, 'api.json'), JSON.stringify(value));
    return extractContracts({ repoRoot: repo.root, repo: 'empty-schema', runId: 'r1',
      files: ['api.json'], ...(limits === undefined ? {} : { limits }) });
  } finally { repo.dispose(); }
}
function at(result: ReturnType<typeof extract>, pointer = VALUE): SeamlineNode {
  const nodes = result.nodes.filter(n => n.kind === 'SchemaProperty' && n.props['jsonPointer'] === pointer);
  assert.equal(nodes.length, 1, `actual declared property at ${pointer} must survive`);
  return nodes[0]!;
}
function emptyFact(node: SeamlineNode, nullable: boolean | undefined, pointer = VALUE, required = true,
  extra: Readonly<Record<string, string>> = {}): void {
  assert.deepEqual(node, {
    id: `empty-schema:SchemaProperty:Orders#${pointer}`, kind: 'SchemaProperty', name: 'value',
    path: 'api.json', sourceRef: `api.json#${pointer}`, sensitivity: 'internal',
    provenance: 'EXTRACTED', confidence: 1, firstSeenRun: 'r1', lastSeenRun: 'r1', deletedAt: null,
    props: { contract: 'Orders', hasDefault: false, isArray: false, jsonPointer: pointer,
      ...(nullable === undefined ? {} : { nullable }), required, typeCategory: 'unknown', ...extra },
  });
}

for (const version of ['3.1.0', '3.1.1', '3.1.2', '3.1.27']) {
  test(`literal empty schema permits null in canonical OpenAPI ${version}`, () => {
    const result = extract(document(shape(), { openapi: version }));
    assert.equal(result.result.status, 'PASS'); emptyFact(at(result), true);
  });
}
for (const version of [3, '3.1', '3.1.01', '3.1.0-alpha', '3.1.0+build', '3.1.0\n', '3.1.0\r', '3.10.0', '3.2.0']) {
  test(`unsupported version spelling gains no new empty-schema authority: ${JSON.stringify(version)}`, () => {
    const result = extract(document(shape(), { openapi: version }));
    assert.equal(result.result.status, 'PASS'); emptyFact(at(result), false);
  });
}
for (const required of [true, false]) {
  test(`empty value allowance is independent of required=${required}`, () => {
    emptyFact(at(extract(document(shape({}, required)))), true, VALUE, required);
  });
}
for (const dialect of [BASE, null, '', false, BASE + '#', BASE + '/', 'http://spec.openapis.org/oas/3.1/dialect/base', 'https://example.invalid/dialect']) {
  test(`document dialect presence is authoritative: ${JSON.stringify(dialect)}`, () => {
    emptyFact(at(extract(document(shape(), { jsonSchemaDialect: dialect }))), dialect === BASE ? true : undefined);
  });
}
test('an independent schema root can state the supported dialect over a custom document default', () => {
  emptyFact(at(extract(document({ ...shape(), $schema: BASE }, { jsonSchemaDialect: 'https://example.invalid/dialect' }))), true);
});
test('an unsupported schema-root dialect withholds only the empty nullable facet', () => {
  emptyFact(at(extract(document({ ...shape(), $schema: 'https://example.invalid/dialect' }))), undefined);
});

const nestedValue = VALUE.replace('/properties/value', '/properties/outer/properties/value');
for (const key of ['$schema', '$id']) {
  test(`nested ${key} has the declared conservative inheritance boundary`, () => {
    const child = { ...shape(), [key]: key === '$schema' ? BASE : 'https://example.invalid/inner' };
    const schema = { type: 'object', properties: { outer: child } };
    emptyFact(at(extract(document(schema)), nestedValue), key === '$id' ? true : undefined, nestedValue);
  });
}
for (const reverse of [false, true]) {
  test(`independent roots do not share mutable dialect state, reverse=${reverse}`, () => {
    const custom = { ...shape(), $schema: 'https://example.invalid/dialect' };
    const result = extract(document(shape(), { components: { schemas: {
      A: reverse ? shape() : custom, B: reverse ? custom : shape(),
    } } }));
    emptyFact(at(result, '/components/schemas/A/properties/value'), reverse ? true : undefined, '/components/schemas/A/properties/value');
    emptyFact(at(result, '/components/schemas/B/properties/value'), reverse ? undefined : true, '/components/schemas/B/properties/value');
    emptyFact(at(result), true);
  });
}
for (const [name, schema, pointer] of [
  ['items', { type: 'array', items: shape() }, VALUE.replace('/properties/value', '/items/properties/value')],
  ['$defs', { $defs: { Entry: shape() } }, VALUE.replace('/properties/value', '/$defs/Entry/properties/value')],
  ['definitions', { definitions: { Entry: shape() } }, VALUE.replace('/properties/value', '/definitions/Entry/properties/value')],
] as const) {
  test(`ordinary ${name} descent retains source null allowance`, () => {
    emptyFact(at(extract(document(schema)), pointer), true, pointer);
  });
}
const opaque: Readonly<Record<string, unknown>> = {
  allOf: [{ properties: { value: { type: 'string' } } }], anyOf: [], oneOf: false,
  patternProperties: { '^value$': { type: 'string' } }, dependentSchemas: {},
  enum: [{ value: 'fixed' }], const: { value: 'fixed' }, not: {}, if: {}, then: {}, else: {},
  $dynamicRef: '#shape', additionalProperties: false, 'x-other-constraint': true,
};
for (const [key, value] of Object.entries(opaque)) {
  test(`opaque sibling ${key} is considered before own property emission`, () => {
    emptyFact(at(extract(document({ ...shape(), [key]: value }))), undefined);
  });
}
test('opacity stays sticky through branches and definitions', () => {
  const result = extract(document({ ...shape(), allOf: [{ ...shape(), $schema: BASE }], $defs: { Entry: shape() } }));
  emptyFact(at(result), undefined);
  const branch = VALUE.replace('/properties/value', '/allOf/0/properties/value');
  emptyFact(at(result, branch), undefined, branch);
  const def = VALUE.replace('/properties/value', '/$defs/Entry/properties/value');
  emptyFact(at(result, def), undefined, def);
});
for (const [key, value] of Object.entries({ type: 'invalid', required: ['value', 'value'], items: [], $id: '', title: 7 })) {
  test(`malformed allowed wrapper ${key} cannot supply new true authority`, () => {
    emptyFact(at(extract(document({ ...shape(), [key]: value }))), undefined);
  });
}
for (const extra of [
  { type: ['object', 'object'] }, { properties: { value: {}, invalid: 7 } },
  { $defs: { Invalid: 7 } }, { definitions: false }, { description: 7 },
]) {
  test(`malformed structural metadata withholds literal nullability: ${JSON.stringify(extra)}`, () => {
    emptyFact(at(extract(document({ ...shape(), ...extra }))), undefined);
  });
}
test('an emitted child at the limit permits null; one beyond the limit is unobserved', () => {
  emptyFact(at(extract(document(shape()), { maxSchemaDepth: 2 })), true);
  const exceeded = extract(document(shape()), { maxSchemaDepth: 1 });
  emptyFact(at(exceeded), undefined);
  assert.ok(exceeded.result.diagnostics.some(x => x.startsWith('SCHEMA_DEPTH_EXCEEDED:')));
});
for (const schema of [{ $ref: '#/components/schemas/Empty' }, { anyOf: [{}] }, { title: 'not literally empty' }]) {
  test(`effective or metadata-only emptiness is outside this correction: ${JSON.stringify(schema)}`, () => {
    const result = extract(document(shape(schema), { components: { schemas: { Empty: {} } } }));
    assert.equal(at(result).props['nullable'], false, 'existing nonliteral behavior is retained, not endorsed as complete semantics');
  });
}
for (const ref of ['#/missing', 'https://example.invalid/schema', '#/components/schemas/Cycle']) {
  test(`reference fallback cannot manufacture literal authority: ${ref}`, () => {
    const result = extract(document(shape({ $ref: ref }), { components: { schemas: { Cycle: { $ref: '#/components/schemas/Cycle' } } } }));
    assert.equal(at(result).props['nullable'], false);
    assert.ok(result.result.diagnostics.length > 0);
  });
}
test('a reference-depth fallback is not source-declared empty authority', () => {
  const result = extract(document(shape({ $ref: '#/components/schemas/First' }), { components: { schemas: {
    First: { $ref: '#/components/schemas/Second' }, Second: { $ref: '#/components/schemas/Empty' }, Empty: {},
  } } }), { maxRefDepth: 1 });
  assert.equal(at(result).props['nullable'], false);
  assert.ok(result.result.diagnostics.some(x => x.startsWith('REF_DEPTH_EXCEEDED:')));
});
for (const schema of [{}, undefined, null, true, false, 'string', []]) {
  test(`actual parameter schema is distinct from a synthetic fallback: ${JSON.stringify(schema)}`, () => {
    const parameter = { name: 'value', in: 'query', ...(schema === undefined ? {} : { schema }) };
    const doc = document(shape());
    doc['paths'] = { '/orders': { post: { parameters: [parameter], responses: { '200': { description: 'No shape' } } } } };
    const pointer = '/paths/~1orders/post/parameters/0/schema';
    emptyFact(at(extract(doc), pointer), schema === true || (schema !== null && typeof schema === 'object' && !Array.isArray(schema)) ? true : false,
      pointer, false, { in: 'query' });
  });
}
test('request and component literal declarations use the same value semantics', () => {
  const doc = document(shape(), { components: { schemas: { Entry: shape() } } });
  doc['paths'] = { '/orders': { post: { requestBody: { content: { 'application/json': { schema: shape() } } }, responses: { '200': { description: 'No shape' } } } } };
  const request = VALUE.replace('/responses/200', '/requestBody');
  emptyFact(at(extract(doc), request), true, request);
  const component = '/components/schemas/Entry/properties/value';
  emptyFact(at(extract(doc), component), true, component);
});

// Boolean true is an original schema declaration, equivalent to literal {} in the admitted dialect.
for (const version of ['3.1.0', '3.1.1', '3.1.2', '3.1.27']) {
  test(`literal true permits null in canonical OpenAPI ${version}`, () => {
    const result = extract(document(shape(true), { openapi: version }));
    assert.equal(result.result.status, 'PASS'); emptyFact(at(result), true);
  });
}
for (const version of [3, '3.1', '3.1.01', '3.1.0-alpha', '3.1.0+build', '3.1.0\n', '3.1.0\r', '3.10.0', '3.2.0', '3.0.3']) {
  test(`literal true adds no authority for unsupported version ${JSON.stringify(version)}`, () => {
    emptyFact(at(extract(document(shape(true), { openapi: version }))), false);
  });
}
for (const required of [true, false]) {
  test(`literal true null allowance is independent of required=${required}`, () => {
    emptyFact(at(extract(document(shape(true, required)))), true, VALUE, required);
  });
}
for (const dialect of [BASE, null, '', false, BASE + '#', BASE + '/', 'http://spec.openapis.org/oas/3.1/dialect/base', 'https://example.invalid/dialect']) {
  test(`literal true retains document dialect authority: ${JSON.stringify(dialect)}`, () => {
    emptyFact(at(extract(document(shape(true), { jsonSchemaDialect: dialect }))), dialect === BASE ? true : undefined);
  });
}
test('literal true retains independent root dialect selection', () => {
  emptyFact(at(extract(document({ ...shape(true), $schema: BASE }, { jsonSchemaDialect: 'https://example.invalid/dialect' }))), true);
  emptyFact(at(extract(document({ ...shape(true), $schema: 'https://example.invalid/dialect' }))), undefined);
});
for (const key of ['$schema', '$id']) {
  test(`literal true retains nested ${key} boundary`, () => {
    const child = { ...shape(true), [key]: key === '$schema' ? BASE : 'https://example.invalid/inner' };
    emptyFact(at(extract(document({ type: 'object', properties: { outer: child } })), nestedValue),
      key === '$id' ? true : undefined, nestedValue);
  });
}
for (const reverse of [false, true]) {
  test(`literal true root contexts stay independent, reverse=${reverse}`, () => {
    const custom = { ...shape(true), $schema: 'https://example.invalid/dialect' };
    const result = extract(document(shape(true), { components: { schemas: {
      A: reverse ? shape(true) : custom, B: reverse ? custom : shape(true),
    } } }));
    emptyFact(at(result, '/components/schemas/A/properties/value'), reverse ? true : undefined, '/components/schemas/A/properties/value');
    emptyFact(at(result, '/components/schemas/B/properties/value'), reverse ? undefined : true, '/components/schemas/B/properties/value');
    emptyFact(at(result), true);
  });
}
for (const [name, schema, pointer] of [
  ['items', { type: 'array', items: shape(true) }, VALUE.replace('/properties/value', '/items/properties/value')],
  ['$defs', { $defs: { Entry: shape(true) } }, VALUE.replace('/properties/value', '/$defs/Entry/properties/value')],
  ['definitions', { definitions: { Entry: shape(true) } }, VALUE.replace('/properties/value', '/definitions/Entry/properties/value')],
] as const) {
  test(`literal true inherits ordinary ${name} context`, () => {
    emptyFact(at(extract(document(schema)), pointer), true, pointer);
  });
}
for (const [key, value] of Object.entries(opaque)) {
  test(`literal true under opaque ${key} withholds nullability`, () => {
    emptyFact(at(extract(document({ ...shape(true), [key]: value }))), undefined);
  });
}
test('literal true opacity stays sticky through branches and definitions', () => {
  const result = extract(document({ ...shape(true), allOf: [{ ...shape(true), $schema: BASE }], $defs: { Entry: shape(true) } }));
  emptyFact(at(result), undefined);
  for (const branch of ['/allOf/0/properties/value', '/$defs/Entry/properties/value']) {
    const pointer = VALUE.replace('/properties/value', branch);
    emptyFact(at(result, pointer), undefined, pointer);
  }
});
for (const extra of [
  { type: 'invalid' }, { required: ['value', 'value'] }, { items: [] }, { $id: '' }, { title: 7 },
  { type: ['object', 'object'] }, { properties: { value: true, invalid: 7 } },
  { $defs: { Invalid: 7 } }, { definitions: false }, { description: 7 },
]) {
  test(`literal true under malformed wrapper is unobserved: ${JSON.stringify(extra)}`, () => {
    emptyFact(at(extract(document({ ...shape(true), ...extra }))), undefined);
  });
}
test('literal true obeys the emission depth bound', () => {
  emptyFact(at(extract(document(shape(true)), { maxSchemaDepth: 2 })), true);
  const exceeded = extract(document(shape(true)), { maxSchemaDepth: 1 });
  emptyFact(at(exceeded), undefined);
  assert.ok(exceeded.result.diagnostics.some(x => x.startsWith('SCHEMA_DEPTH_EXCEEDED:')));
});
test('literal false and reference-derived true gain no new nullable authority', () => {
  emptyFact(at(extract(document(shape(false)))), false);
  const result = extract(document(shape({ $ref: '#/components/schemas/Any' }), { components: { schemas: { Any: true } } }));
  assert.equal(at(result).props['nullable'], false, 'resolved true is outside the original-literal correction');
});
test('literal true request and component declarations retain value semantics without response roles', () => {
  const doc = document(shape(true), { components: { schemas: { Entry: shape(true) } } });
  doc['paths'] = { '/orders': { post: { requestBody: { content: { 'application/json': { schema: shape(true) } } }, responses: { '200': { description: 'No shape' } } } } };
  const request = VALUE.replace('/responses/200', '/requestBody');
  emptyFact(at(extract(doc), request), true, request);
  const component = '/components/schemas/Entry/properties/value';
  emptyFact(at(extract(doc), component), true, component);
});
test('typed and unknown facets retain their independent authority', () => {
  assert.equal(at(extract(document(shape({ type: 'string' })))).props['nullable'], false);
  assert.equal(at(extract(document(shape({ type: ['string', 'null'] })))).props['nullable'], true);
  const unknown = extract(document(shape({ type: 'string', 'x-seamline-unknown-facets': ['nullable'] })));
  assert.equal(at(unknown).props['nullable'], undefined);
  assert.equal(at(unknown).props['type'], 'string');
});
test('OpenAPI 3.0, standalone JSON Schema and Zod retain existing empty/unknown behavior', () => {
  emptyFact(at(extract(document(shape(), { openapi: '3.0.3' }))), false);
  const repo = makeEmptyRepo();
  try {
    writeFileSync(join(repo.root, 'schema.json'), JSON.stringify({ title: 'Standalone', type: 'object', properties: { value: {} } }));
    writeFileSync(join(repo.root, 'src/input.ts'), "import { z } from 'zod';\nexport const Input = z.object({ plain: z.string(), nullable: z.string().nullable(), unknown: z.string().unknownWrapper() });\n");
    const result = extractContracts({ repoRoot: repo.root, repo: 'legacy', runId: 'r1', files: ['schema.json', 'src/input.ts'] });
    assert.equal(result.result.status, 'PASS');
    const field = (name: string) => {
      const found = result.nodes.find(n => n.kind === 'SchemaProperty' && n.name === name);
      assert.ok(found); assert.equal(found.provenance, 'EXTRACTED'); return found;
    };
    assert.equal(field('value').props['nullable'], false, 'standalone empty behavior is preserved, not newly validated');
    assert.equal(field('plain').props['nullable'], false);
    assert.equal(field('nullable').props['nullable'], true);
    assert.equal(field('unknown').props['nullable'], undefined);
  } finally { repo.dispose(); }
});
