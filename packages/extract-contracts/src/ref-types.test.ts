import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractContracts } from './extract.ts';
import { makeEmptyRepo, nodeById, prop } from './test-harness.ts';

const REPO = 'testrepo';
const RUN = 'run-1';

const SPEC = [
  'openapi: 3.0.3',
  'info: { title: Typed Ref API, version: 1.0.0 }',
  'paths: {}',
  'components:',
  '  schemas:',
  '    Thing:',
  '      type: object',
  '      properties:',
  "        note: { $ref: './notes.txt#/Note' }",
  "        sibling: { $ref: './other.yaml#/Note' }",
  '',
].join('\n');

test('a $ref to a file that is not a contract document is refused, and the file is never read', () => {
  const repo = makeEmptyRepo();
  try {
    writeFileSync(join(repo.root, 'spec.yaml'), SPEC);
    // Parsed as YAML this would yield a property, and any parse error would quote it.
    writeFileSync(
      join(repo.root, 'notes.txt'),
      'Note:\n  type: string\n  description: SECRET-CANARY-FROM-A-TEXT-FILE\n',
    );
    writeFileSync(join(repo.root, 'other.yaml'), 'Note:\n  type: integer\n');

    const { result, nodes } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });

    assert.equal(result.status, 'PASS', 'one unsupported ref does not fail the whole extraction');
    assert.ok(
      result.diagnostics.some((d) => d.startsWith('REF_UNSUPPORTED_TYPE: notes.txt')),
      result.diagnostics.join('\n'),
    );
    assert.ok(
      !JSON.stringify({ nodes, result }).includes('SECRET-CANARY'),
      'the text file was read',
    );
    const note = nodeById(
      nodes,
      `${REPO}:SchemaProperty:Typed Ref API#/components/schemas/Thing/properties/note`,
    );
    assert.equal(prop(note, 'typeCategory'), 'unknown');
    // A $ref to a real document still resolves.
    const sibling = nodeById(
      nodes,
      `${REPO}:SchemaProperty:Typed Ref API#/components/schemas/Thing/properties/sibling`,
    );
    assert.notEqual(prop(sibling, 'typeCategory'), 'unknown');
  } finally {
    repo.dispose();
  }
});

test('a $ref to a document is followed whatever the case of its extension', () => {
  const repo = makeEmptyRepo();
  try {
    writeFileSync(join(repo.root, 'spec.yaml'), SPEC.replace('./other.yaml', './OTHER.YAML'));
    writeFileSync(join(repo.root, 'OTHER.YAML'), 'Note:\n  type: integer\n');
    const { nodes } = extractContracts({ repoRoot: repo.root, repo: REPO, runId: RUN });
    const sibling = nodeById(
      nodes,
      `${REPO}:SchemaProperty:Typed Ref API#/components/schemas/Thing/properties/sibling`,
    );
    assert.notEqual(prop(sibling, 'typeCategory'), 'unknown');
  } finally {
    repo.dispose();
  }
});
