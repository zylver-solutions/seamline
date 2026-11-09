import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { INFER_JOIN_MANIFEST, INFER_JOIN_SCOPE, REQUIRED_SCOPES } from './manifest.ts';
import { containerFromDottedName, containerFromPointer, facetFor, facetsOfKind } from './facets.ts';
import { isValidatorDecorator, isValidatorSymbol, validatorMembers, validatorSubject } from './validators.ts';
import { canonicalProps, compareEdges, finalizeEdges } from './emit.ts';
import {
  addBareSymbol, addContract, addSymbol, addTable, makeEdge, makeNode, memoryGraph, type MemoryGraph,
} from './test-graph.ts';

describe('INFER_JOIN_MANIFEST', () => {
  it('declares INFERRED as its ceiling and takes no capabilities it does not need', () => {
    assert.equal(INFER_JOIN_MANIFEST.provenanceCeiling, 'INFERRED');
    assert.equal(INFER_JOIN_MANIFEST.net, false);
    assert.deepEqual(INFER_JOIN_MANIFEST.env, []);
    assert.deepEqual(INFER_JOIN_MANIFEST.reads, []);
  });

  it('claims authority over its own edge scope and over no node kind', () => {
    const scope = INFER_JOIN_MANIFEST.produces[0];
    assert.equal(scope?.scope, INFER_JOIN_SCOPE);
    assert.deepEqual(scope?.kinds, []);
    assert.equal(scope?.selector, 'MAPS_TO_FIELD|BACKED_BY|EXPOSED_AS|VALIDATED_BY');
  });

  it('names the three extractor scopes it reads from', () => {
    assert.deepEqual(REQUIRED_SCOPES.slice().sort(), ['code.ts', 'contracts', 'data']);
  });
});

describe('container resolution', () => {
  it('reads a column container off the CONTAINS edge', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const facet = facetsOfKind(graph, 'Column')[0];
    assert.ok(facet !== undefined);
    assert.equal(facet.container, 'posts');
    assert.equal(facet.containerId, table.table.id);
    assert.equal(facet.typeCategory, 'text');
  });

  it('reads a schema property container from the JSON pointer, not the document', () => {
    const graph = memoryGraph();
    const contract = addContract(graph, {
      document: 'openapi.yaml', object: 'Post', properties: [{ name: 'title', type: 'string' }],
    });
    const facet = facetsOfKind(graph, 'SchemaProperty')[0];
    assert.ok(facet !== undefined);
    assert.equal(facet.container, 'Post');
    assert.equal(facet.containerId, contract.contract.id);
  });

  it('parses pointers without treating structural segments as containers', () => {
    assert.equal(containerFromPointer('api.yaml#/components/schemas/Post/properties/title'), 'Post');
    assert.equal(containerFromPointer('api.yaml#/definitions/Invoice/properties/total'), 'Invoice');
    assert.equal(containerFromPointer('api.yaml#/components/schemas/Post/properties/author/properties/name'), 'author');
    assert.equal(containerFromPointer('api.yaml#/components/schemas/Post/properties/tags/items'), 'tags');
    assert.equal(containerFromPointer('api.yaml#/'), undefined);
  });

  it('falls back to the dotted canonical name when there is no CONTAINS edge', () => {
    assert.equal(containerFromDottedName('main.public.orders.ship_at'), 'orders');
    assert.equal(containerFromDottedName('src/post.ts::Post.title'), 'Post');
    assert.equal(containerFromDottedName('bare'), undefined);
  });

  it('prefers an explicit container prop when the graph has no structure', () => {
    const graph = memoryGraph();
    const node = graph.addNode(makeNode({
      kind: 'CodeField',
      canonicalName: 'orphan',
      name: 'title',
      props: { container: 'Post', typeCategory: 'text' },
    }));
    const facet = facetFor(graph, node);
    assert.equal(facet.container, 'Post');
    assert.equal(facet.typeCategory, 'text');
  });

  it('lets an extractor-supplied typeCategory win over a raw type', () => {
    const graph = memoryGraph();
    const node = graph.addNode(makeNode({
      kind: 'Column', canonicalName: 'db.public.posts.status', name: 'status',
      props: { typeCategory: 'enum', type: 'post_status' },
    }));
    assert.equal(facetFor(graph, node).typeCategory, 'enum');
  });
});

describe('validator recognition', () => {
  it('recognizes the class-validator decorator family', () => {
    for (const name of ['IsString', 'IsEmail', 'MinLength', 'Max', 'Matches', 'ValidateNested']) {
      assert.ok(isValidatorDecorator(name), name);
    }
  });

  it('does not treat an arbitrary decorator as a validator', () => {
    for (const name of ['Memoize', 'Injectable', 'Column', 'Entity']) {
      assert.equal(isValidatorDecorator(name), false, name);
    }
  });

  type Props = Readonly<Record<string, string | boolean>>;
  function recognized(graph: MemoryGraph, name: string, props: Props, path: string): boolean {
    return isValidatorSymbol(addBareSymbol(graph, name, props, path));
  }

  it('recognizes a value built through a validation library, or one an extractor flags explicitly', () => {
    const graph = memoryGraph();
    assert.ok(recognized(graph, 'PostSchema', { symbolKind: 'variable', library: 'zod' }, 'src/a.ts'));
    assert.ok(recognized(graph, 'postShape', { symbolKind: 'variable', library: 'yup' }, 'src/b.ts'));
    assert.ok(recognized(graph, 'Post', { symbolKind: 'variable', library: 'zod' }, 'src/d.ts'));
    assert.ok(recognized(graph, 'checkPost', { symbolKind: 'function', validator: true }, 'src/c.ts'));
  });

  it('does not treat a type declaration as a validator, whatever its name or props', () => {
    const graph = memoryGraph();
    for (const symbolKind of ['interface', 'type-alias', 'class', 'enum', 'namespace', 'method']) {
      for (const name of ['RowConstraints', 'PostSchema', 'PostValidator', 'postRules', 'validatePost']) {
        const path = `src/${symbolKind}/${name}.ts`;
        assert.equal(recognized(graph, name, { symbolKind }, path), false, `${symbolKind} ${name}`);
      }
      const flagged = { symbolKind, library: 'zod', validator: true };
      assert.equal(recognized(graph, 'Flagged', flagged, `src/${symbolKind}/f.ts`), false, `${symbolKind} flagged`);
    }
  });

  it('does not treat a value as a validator on its name alone', () => {
    const graph = memoryGraph();
    assert.equal(recognized(graph, 'PostSchema', { symbolKind: 'variable' }, 'src/a.ts'), false);
    assert.equal(recognized(graph, 'validatePost', { symbolKind: 'function' }, 'src/b.ts'), false);
    assert.equal(recognized(graph, 'postRules', { symbolKind: 'variable', library: 'lodash' }, 'src/c.ts'), false);
    assert.equal(recognized(graph, 'PostSchema', { library: 'zod' }, 'src/e.ts'), false,
      'a Symbol with no symbolKind is not known to be a value');
  });

  it('does not treat a domain type as a validator', () => {
    const graph = memoryGraph();
    assert.equal(recognized(graph, 'Post', { symbolKind: 'class' }, 'src/post.ts'), false);
    assert.equal(recognized(graph, 'PostRepository', { symbolKind: 'class' }, 'src/repo.ts'), false);
  });

  it('derives the subject a validator constrains', () => {
    assert.equal(validatorSubject('PostSchema'), 'post');
    assert.equal(validatorSubject('CreatePostSchema'), 'create_post');
    assert.equal(validatorSubject('PostRowSchema'), 'post_row');
    assert.equal(validatorSubject('CreatePostInputSchema'), 'create_post_input');
    assert.equal(validatorSubject('PostResponseSchema'), 'post_response');
    assert.equal(validatorSubject('validatePostRules'), 'post');
    assert.equal(validatorSubject('Schema'), 'schema');
  });

  it('lists a validator schema members', () => {
    const graph = memoryGraph();
    const validator = addSymbol(graph, {
      name: 'PostSchema', path: 'src/post.schema.ts', props: { symbolKind: 'variable', library: 'zod' },
      fields: [{ name: 'title', type: 'string' }, { name: 'body', type: 'string' }],
    });
    const members = validatorMembers(graph, validator.symbol.id).map((m) => m.name);
    assert.deepEqual(members.slice().sort(), ['body', 'title']);
  });
});

describe('emit', () => {
  it('sorts prop keys and fixes float precision', () => {
    const props = canonicalProps({ zeta: 1, alpha: 1 / 3, flag: true });
    assert.deepEqual(Object.keys(props), ['alpha', 'flag', 'zeta']);
    assert.equal(props['alpha'], 0.3333);
  });

  it('deduplicates a repeated edge, keeping the stronger claim and recording the weaker rule', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'title', type: 'text' }] });
    const model = addSymbol(graph, { name: 'Post', fields: [{ name: 'title', type: 'string' }] });
    const column = table.columns.get('title');
    const field = model.fields.get('title');
    assert.ok(column !== undefined && field !== undefined);

    const weak = makeEdge({ kind: 'MAPS_TO_FIELD', src: column, dst: field, provenance: 'INFERRED', confidence: 0.4 });
    const strong = makeEdge({ kind: 'MAPS_TO_FIELD', src: column, dst: field, provenance: 'INFERRED', confidence: 0.8 });
    const merged = finalizeEdges([
      { ...weak, props: { rule: 'weak-rule' } },
      { ...strong, props: { rule: 'strong-rule' } },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.confidence, 0.8);
    assert.equal(merged[0]?.props['rule'], 'strong-rule');
    assert.equal(merged[0]?.props['alsoFrom'], 'weak-rule');
  });

  it('orders edges by kind then source then target', () => {
    const graph = memoryGraph();
    const table = addTable(graph, { name: 'posts', columns: [{ name: 'a', type: 'text' }, { name: 'b', type: 'text' }] });
    const model = addSymbol(graph, { name: 'Post', fields: [{ name: 'a', type: 'string' }] });
    const a = table.columns.get('a');
    const b = table.columns.get('b');
    const field = model.fields.get('a');
    assert.ok(a !== undefined && b !== undefined && field !== undefined);
    const first = makeEdge({ kind: 'MAPS_TO_FIELD', src: a, dst: field });
    const second = makeEdge({ kind: 'MAPS_TO_FIELD', src: b, dst: field });
    assert.ok(compareEdges(first, second) < 0);
    assert.deepEqual(finalizeEdges([second, first]), [first, second]);
  });
});
