/**
 * Cross-package agreement on identity: canonical names and the rename threshold.
 *
 * `extract-code-ts` mints the `Symbol`, `CodeField` and `Parameter` ids that
 * end up in the store; `@seamline/core`'s identity builders mint the ids the
 * alias layer retires and resolves. If the two disagree on the shape of a
 * canonical name, an alias built by core points at an id no extractor ever
 * stores, and the chain resolves to nothing.
 *
 * This suite extracts a small fixture with the real extractor and rebuilds
 * every such id from the node's own structured props with core's builders.
 * It also pins core's default rename threshold to `extract-change`'s, since
 * the two decide together which renames become aliases.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import type { SeamlineNode } from '@seamline/ontology';
import {
  codeFieldName,
  DEFAULT_RENAME_SIMILARITY,
  ingestFileRenames,
  makeNodeId,
  parameterName,
  symbolName,
} from '@seamline/core';
import { DEFAULT_RENAME_THRESHOLD } from '@seamline/extract-change';
import { extractCodeTs } from '@seamline/extract-code-ts';

const AGREEMENT_REPO = 'agreement';

const AGREEMENT_FILES: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify({ name: '@fixture/agreement', version: '1.0.0', type: 'module' })}\n`,
  'tsconfig.json': `${JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
    },
    include: ['src'],
  })}\n`,
  'src/user.ts': [
    'export interface User {',
    '  id: string;',
    '  email: string;',
    '}',
    '',
    'export class UserService {',
    '  private readonly cache = new Map<string, User>();',
    '',
    '  findById(id: string, fresh?: boolean): User | undefined {',
    '    return fresh === true ? undefined : this.cache.get(id);',
    '  }',
    '}',
    '',
    'export function normalize(email: string): string {',
    '  return email.toLowerCase();',
    '}',
    '',
  ].join('\n'),
};

let agreementRoot: string;
let extractedNodes: ReadonlyArray<SeamlineNode>;

before(() => {
  agreementRoot = mkdtempSync(join(tmpdir(), 'seamline-canonical-agreement-'));
  for (const [rel, body] of Object.entries(AGREEMENT_FILES)) {
    const abs = join(agreementRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  }
  const out = extractCodeTs({
    repoRoot: agreementRoot,
    repo: AGREEMENT_REPO,
    runId: 'run-1',
    deterministic: true,
  });
  assert.equal(out.result.status, 'PASS');
  extractedNodes = out.nodes;
});

after(() => {
  rmSync(agreementRoot, { recursive: true, force: true });
});

function extractedOfKind(kind: SeamlineNode['kind']): ReadonlyArray<SeamlineNode> {
  const found = extractedNodes.filter((n) => n.kind === kind);
  assert.ok(found.length > 0, `precondition: the fixture yields ${kind} nodes`);
  return found;
}

function stringProp(node: SeamlineNode, key: string): string {
  const value = node.props[key];
  assert.equal(typeof value, 'string', `${node.id} props.${key}`);
  return value as string;
}

test("core's symbolName rebuilds every Symbol id extract-code-ts stores", () => {
  for (const node of extractedOfKind('Symbol')) {
    const name = symbolName({
      module: stringProp(node, 'module'),
      qualifiedName: stringProp(node, 'qualifiedName').split('.'),
    });
    assert.equal(makeNodeId(AGREEMENT_REPO, 'Symbol', name), node.id);
  }
});

test("core's codeFieldName rebuilds every CodeField id extract-code-ts stores", () => {
  for (const node of extractedOfKind('CodeField')) {
    const name = codeFieldName({ symbol: stringProp(node, 'owner'), field: node.name });
    assert.equal(makeNodeId(AGREEMENT_REPO, 'CodeField', name), node.id);
  }
});

test("core's parameterName rebuilds every Parameter id extract-code-ts stores", () => {
  for (const node of extractedOfKind('Parameter')) {
    const index = node.props['index'];
    assert.equal(typeof index, 'number', `${node.id} props.index`);
    const name = parameterName({
      symbol: stringProp(node, 'owner'),
      index: index as number,
      parameter: node.name,
    });
    assert.equal(makeNodeId(AGREEMENT_REPO, 'Parameter', name), node.id);
  }
});

test("core's default rename threshold is extract-change's, so a rename git reports below it is never aliased", () => {
  assert.equal(DEFAULT_RENAME_SIMILARITY, DEFAULT_RENAME_THRESHOLD);
  const below = { from: 'src/a.ts', to: 'src/b.ts', similarity: DEFAULT_RENAME_THRESHOLD - 0.05 };
  const { aliases, rejected } = ingestFileRenames([below], {
    repo: AGREEMENT_REPO,
    runId: 'run-1',
  });
  assert.equal(aliases.length, 0);
  assert.deepEqual(rejected, [{ record: below, reason: 'below-threshold' }]);
});
