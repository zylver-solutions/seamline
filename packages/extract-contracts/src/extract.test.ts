import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidEdge, parseNodeId, assertWithinCeiling } from '@seamline/ontology';
import { extractContracts } from './extract.ts';
import { MANIFEST, CONTRACTS_SCOPE } from './manifest.ts';
import { makeEmptyRepo, makeTempRepo, nodeById, prop } from './test-harness.ts';

const REPO = 'testrepo';
const RUN = 'run-1';

test('the manifest declares an EXTRACTED ceiling and no network', () => {
  assert.equal(MANIFEST.provenanceCeiling, 'EXTRACTED');
  assert.equal(MANIFEST.net, false);
  assert.deepEqual(MANIFEST.produces[0]?.kinds, [
    'Contract', 'Operation', 'SchemaProperty', 'RouteHandler',
  ]);
  assert.doesNotThrow(() => assertWithinCeiling(MANIFEST, 'EXTRACTED'));
  assert.doesNotThrow(() => assertWithinCeiling(MANIFEST, 'INFERRED'));
});

test('no contract source yields UNAVAILABLE with zero nodes, never PASS', () => {
  const repo = makeEmptyRepo();
  try {
    const { result, nodes, edges } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(nodes.length, 0);
    assert.equal(edges.length, 0);
    assert.equal(result.nodeCount, 0);
    assert.notEqual(result.status, 'PASS');
    assert.deepEqual(result.authoritative, [
      { scope: CONTRACTS_SCOPE, kinds: MANIFEST.produces[0]?.kinds },
    ]);
  } finally {
    repo.dispose();
  }
});

test('every emitted edge satisfies isValidEdge, and only the declared kinds appear', () => {
  const repo = makeTempRepo();
  try {
    const { nodes, edges } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
    assert.ok(edges.length > 0, 'the fixture set produces edges');
    const kindOf = new Map(nodes.map((n) => [n.id as string, n.kind]));

    for (const edge of edges) {
      const src = kindOf.get(edge.src as string);
      const dst = kindOf.get(edge.dst as string);
      assert.ok(src !== undefined, `dangling src ${edge.src}`);
      assert.ok(dst !== undefined, `dangling dst ${edge.dst}`);
      assert.ok(isValidEdge(edge.kind, src, dst), `${edge.kind}: ${src} -> ${dst}`);
      assert.equal(edge.provenance, 'EXTRACTED');
      assert.equal(edge.deletedAt, null);
      assert.equal(edge.firstSeenRun, RUN);
    }
    assert.deepEqual(
      [...new Set(edges.map((e) => e.kind))].sort(),
      ['CONTAINS', 'IMPLEMENTED_BY'],
    );
    for (const node of nodes) {
      assert.ok(['Contract', 'Operation', 'SchemaProperty', 'RouteHandler'].includes(node.kind));
      assert.equal(node.provenance, 'EXTRACTED');
    }
  } finally {
    repo.dispose();
  }
});

test('identity is path-free and carries the json pointer', () => {
  const repo = makeTempRepo();
  try {
    const { nodes } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
    for (const node of nodes) {
      const parsed = parseNodeId(node.id);
      assert.equal(parsed.repo, REPO);
      assert.equal(parsed.kind, node.kind);
      assert.ok(!parsed.canonicalName.startsWith('api/'), `${node.id} leaks a path`);
      assert.ok(!parsed.canonicalName.includes('\\'), `${node.id} has a backslash`);
      if (node.path !== undefined) {
        assert.ok(!node.path.startsWith('/'), `${node.path} is absolute`);
        assert.ok(!node.path.includes('\\'), `${node.path} is not POSIX`);
      }
      if (node.kind === 'SchemaProperty') {
        const pointer = node.props['jsonPointer'];
        assert.equal(typeof pointer, 'string');
        assert.equal(
          parsed.canonicalName,
          `${String(node.props['contract'])}#${String(pointer)}`,
          'the pointer is the identity component',
        );
      }
    }
  } finally {
    repo.dispose();
  }
});

test('two runs are byte-identical', () => {
  const repo = makeTempRepo();
  const previous = process.env['SEAMLINE_DETERMINISTIC'];
  process.env['SEAMLINE_DETERMINISTIC'] = '1';
  try {
    const first = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
    const second = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
    assert.equal(JSON.stringify(first.nodes), JSON.stringify(second.nodes));
    assert.equal(JSON.stringify(first.edges), JSON.stringify(second.edges));
    assert.equal(JSON.stringify(first.result), JSON.stringify(second.result));
    assert.ok(first.nodes.length > 0);

    // Sorted by construction, so the serialization is stable rather than
    // accidentally stable.
    const ids = first.nodes.map((n) => n.id as string);
    assert.deepEqual(ids, [...ids].sort());
    const edgeKeys = first.edges.map((e) => `${e.kind} ${e.src} ${e.dst}`);
    assert.deepEqual(edgeKeys, [...edgeKeys].sort());
    for (const node of first.nodes) {
      const keys = Object.keys(node.props);
      assert.deepEqual(keys, [...keys].sort(), `${node.id} props are unsorted`);
    }
    // No wall-clock time on a node or edge body (v3 2.3).
    const serialized = JSON.stringify(first.nodes) + JSON.stringify(first.edges);
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(serialized), 'a timestamp leaked into a body');
  } finally {
    if (previous === undefined) delete process.env['SEAMLINE_DETERMINISTIC'];
    else process.env['SEAMLINE_DETERMINISTIC'] = previous;
    repo.dispose();
  }
});

test('a $ref cycle terminates and still yields the properties around it', () => {
  const repo = makeTempRepo();
  try {
    const { nodes, result } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
    // Reaching this line at all is the assertion: an unguarded allOf cycle
    // (A composes B composes A) would not return.
    const a = nodeById(nodes, `${REPO}:SchemaProperty:Cycle API#/components/schemas/A/properties/a`);
    const b = nodeById(nodes, `${REPO}:SchemaProperty:Cycle API#/components/schemas/B/properties/b`);
    assert.equal(prop(a, 'required'), true);
    assert.equal(prop(b, 'required'), true);
    // `required` merged across the composition, without recursing forever.
    assert.equal(prop(nodeById(nodes, `${REPO}:SchemaProperty:Cycle API#/components/schemas/A/properties/a`), 'required'), true);

    // A self-referential property is emitted once and never descended into.
    const next = nodeById(nodes, `${REPO}:SchemaProperty:Cycle API#/components/schemas/Node/properties/next`);
    assert.equal(prop(next, 'typeCategory'), 'json');
    const deeper = nodes.filter((n) =>
      (n.id as string).includes('Node/properties/next/properties'),
    );
    assert.equal(deeper.length, 0, 'recursion must not cross a $ref');
    assert.ok(result.diagnostics.some((d) => d.startsWith('REF_CYCLE:')), 'the cycle is reported');
  } finally {
    repo.dispose();
  }
});

test('a remote $ref is refused and never fetched', () => {
  const repo = makeTempRepo();
  try {
    const { nodes, result } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
    const refused = result.diagnostics.filter((d) => d.startsWith('REMOTE_REF_REFUSED:'));
    assert.equal(refused.length, 2, 'both the https and the protocol-relative ref are refused');
    assert.ok(refused.some((d) => d.includes('https://evil.example.com/schema.json')));
    assert.ok(refused.some((d) => d.includes('//evil.example.com/schema.json')));

    // The property still exists, with an honest undetermined category rather
    // than anything sourced from the network.
    const remote = nodeById(
      nodes,
      `${REPO}:SchemaProperty:Remote Ref API#/components/schemas/Thing/properties/remote`,
    );
    assert.equal(prop(remote, 'typeCategory'), 'unknown');
    assert.equal(prop(remote, 'required'), true);
  } finally {
    repo.dispose();
  }
});

test('a $ref escaping the repo root is refused even though the file exists', () => {
  const repo = makeTempRepo();
  try {
    const { nodes, result } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
    assert.ok(
      result.diagnostics.some((d) => d.startsWith('REF_ESCAPES_REPO_ROOT:')),
      `expected an escape refusal, got: ${result.diagnostics.join(' | ')}`,
    );
    const outside = nodeById(
      nodes,
      `${REPO}:SchemaProperty:Escape Ref API#/components/schemas/Thing/properties/outside`,
    );
    assert.equal(prop(outside, 'typeCategory'), 'unknown');
    // Nothing from the out-of-tree document reached the graph.
    assert.ok(nodes.every((n) => n.name !== 'secret'), 'out-of-tree content must not be read');
  } finally {
    repo.dispose();
  }
});

test('every contract contains its operations and properties', () => {
  const repo = makeTempRepo();
  try {
    const { nodes, edges } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
    const contains = edges.filter((e) => e.kind === 'CONTAINS');
    const contract = nodeById(nodes, `${REPO}:Contract:Petstore API`);
    assert.equal(prop(contract, 'dialect'), 'openapi');
    assert.equal(prop(contract, 'version'), '1.4.0');

    const fromPetstore = contains.filter((e) => e.src === contract.id);
    const operations = fromPetstore.filter((e) => (e.dst as string).includes(':Operation:'));
    assert.equal(operations.length, 4, 'four operations in the petstore fixture');
    assert.ok(
      fromPetstore.some((e) => (e.dst as string).includes(':SchemaProperty:')),
      'properties are contained too',
    );
    for (const edge of fromPetstore) {
      assert.equal(edge.srcFile, 'api/petstore.yaml');
    }
  } finally {
    repo.dispose();
  }
});

test('an explicitly named file that is not a contract is a FAIL, not a silent PASS', () => {
  const repo = makeTempRepo();
  try {
    const { result } = extractContracts({
      repoRoot: repo.root,
      repo: REPO,
      runId: RUN,
      files: ['api/package.json'],
    });
    assert.equal(result.status, 'FAIL');
    assert.ok(result.diagnostics.some((d) => d.startsWith('NOT_A_CONTRACT:')));
  } finally {
    repo.dispose();
  }
});

test('an explicitly named file outside the repo root is refused', () => {
  const repo = makeTempRepo();
  try {
    const { result, nodes } = extractContracts({
      repoRoot: repo.root,
      repo: REPO,
      runId: RUN,
      files: ['../outside.yaml'],
    });
    assert.equal(result.status, 'FAIL');
    assert.equal(nodes.length, 0);
    assert.ok(result.diagnostics.some((d) => d.startsWith('REF_ESCAPES_REPO_ROOT:')));
  } finally {
    repo.dispose();
  }
});

test('an oversized document is refused rather than parsed', () => {
  const repo = makeTempRepo();
  try {
    const { result } = extractContracts({
      repoRoot: repo.root,
      repo: REPO,
      runId: RUN,
      files: ['api/petstore.yaml'],
      limits: { maxFileBytes: 64 },
    });
    assert.equal(result.status, 'FAIL');
    assert.ok(result.diagnostics.some((d) => d.startsWith('FILE_TOO_LARGE:')));
  } finally {
    repo.dispose();
  }
});
