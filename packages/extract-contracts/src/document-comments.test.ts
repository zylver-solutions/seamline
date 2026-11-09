import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { parseDocument } from './document.ts';
import { extractContracts } from './extract.ts';
import { makeEmptyRepo } from './test-harness.ts';

test('JSON comments are whitespace, including line comments terminated by LF, CRLF, CR or EOF', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = `/* leading */{ // line${newline}"value" /* key */: /* value */ 7 } // end`;
    assert.deepEqual(parseDocument('settings.json', text), { ok: true, value: { value: 7 } });
  }
  assert.deepEqual(parseDocument('settings.json', '/* a\n b */[1,/* c */2]'), {
    ok: true, value: [1, 2],
  });
});

test('comment markers, escaped quotes and backslashes inside JSON strings keep their exact values', () => {
  const value = { url: 'https://example.test/a//b', text: 'quote " backslash \\ /* data */' };
  const text = `// preface\n${JSON.stringify(value)}/* trailing */`;
  assert.deepEqual(parseDocument('settings.json', text), { ok: true, value });
});

test('a comment cannot join tokens or repair any other malformed JSON syntax', () => {
  for (const text of [
    '1/* split */2', 'tr/* split */ue', '{"x":1/* split */2}',
    '{"x":1,}', '[1,]', '{unquoted: 1}', "{'x':1}",
    '{"x":undefined}', '{"x":NaN}', '# comment\n{}',
    '{} /* unterminated', '/* unterminated',
    '/* outer /* inner */ remaining */ {}', '{"x":"unterminated /* text */}',
  ]) {
    assert.deepEqual(parseDocument('settings.json', text), { ok: false, error: 'JSON_PARSE_ERROR' }, text);
  }
});

test('JSON extension matching is case insensitive and never falls back to YAML', () => {
  for (const name of ['settings.json', 'settings.JSON', 'settings.JsOn']) {
    assert.deepEqual(parseDocument(name, '/* note */{"value":1}'), { ok: true, value: { value: 1 } });
    assert.deepEqual(parseDocument(name, 'value: 1'), { ok: false, error: 'JSON_PARSE_ERROR' });
  }
});

test('a malformed comment diagnostic never releases the comment or document body', () => {
  const canary = 'COMMENT_DIAGNOSTIC_' + 'q'.repeat(32);
  assert.deepEqual(parseDocument('settings.json', `{} /* ${canary}`), {
    ok: false, error: 'JSON_PARSE_ERROR',
  });
});

const api = JSON.stringify({
  openapi: '3.0.3', info: { title: 'Comment API', version: '1' },
  paths: { '/items': { get: { responses: { '200': { description: 'ok' } } } } },
});

function extract(files: Readonly<Record<string, string>>) {
  const repo = makeEmptyRepo();
  try {
    for (const [name, text] of Object.entries(files)) {
      const file = join(repo.root, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return extractContracts({ repoRoot: repo.root, repo: 'comments', runId: 'run-1' });
  } finally {
    repo.dispose();
  }
}

test('reading ordinary commented configuration measures zero unread structured documents', () => {
  const result = extract({
    'openapi.json': api,
    'apps/web/tsconfig.json': '{"compilerOptions":{/* base options */"strict":true}}',
    'packages/server/tsconfig.json': '{// base options\n"compilerOptions":{"strict":true}}',
  });
  assert.equal(result.result.status, 'PASS');
  const operations = result.nodes.filter(node => node.kind === 'Operation');
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.name, 'GET /items');
  assert.equal(operations[0]?.props['unreadStructuredDocuments'], 0);
  assert.ok(!result.result.diagnostics.some(diagnostic => diagnostic.startsWith('CONTRACTS_PARTIAL_COVERAGE:')));
});

test('a commented OpenAPI document under a config filename still emits its operation', () => {
  const result = extract({ 'tsconfig.json': `/* ordinary filename is not an exemption */${api}` });
  assert.equal(result.result.status, 'PASS');
  const operation = result.nodes.find(node => node.kind === 'Operation');
  assert.equal(operation?.name, 'GET /items');
  assert.equal(operation?.props['unreadStructuredDocuments'], 0);
  assert.equal(operation?.provenance, 'EXTRACTED');
});

test('a malformed commented config remains unread and a strict contract remains a failure', () => {
  const result = extract({ 'openapi.json': api, 'tsconfig.json': '{/* truncated */"compilerOptions":' });
  assert.equal(result.result.status, 'PASS');
  assert.equal(result.nodes.find(node => node.kind === 'Operation')?.props['unreadStructuredDocuments'], 1);
  assert.ok(result.result.diagnostics.some(diagnostic => diagnostic.startsWith('CONTRACTS_PARTIAL_COVERAGE: 1 file(s)')));
  assert.equal(extract({ 'openapi.json': `/* truncated */${api.slice(0, -1)}` }).result.status, 'FAIL');
});

test('comments do not change extracted contract identities or fact bytes', () => {
  const plain = extract({ 'openapi.json': api });
  const commented = extract({ 'openapi.json': `/* preface */${api}// suffix` });
  assert.equal(plain.result.status, 'PASS');
  assert.equal(commented.result.status, 'PASS');
  assert.deepEqual(commented.nodes, plain.nodes);
  assert.deepEqual(commented.edges, plain.edges);
});
