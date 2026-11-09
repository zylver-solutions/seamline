import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDocument } from './document.ts';

test('YAML recovery is not a successful parse of a truncated contract', () => {
  for (const text of [
    'openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths: [\n',
    'info: [',
    'name: "unterminated',
    'name: first\nname: second',
    'openapi: 3.0.3\npaths: {}\n---\npaths: [\n',
  ]) {
    const parsed = parseDocument('data.yaml', text);
    assert.equal(parsed.ok, false, text);
    if (!parsed.ok) assert.ok(parsed.error.length > 0);
  }
});

test('parse diagnostics never include malformed source values or alias names', () => {
  const canary = 'DIAGNOSTIC_CANARY_' + 'q'.repeat(32);
  for (const [name, text] of [
    ['data.yaml', `token: "${canary}`],
    ['data.yaml', `${canary}: first\n${canary}: second`],
    ['data.yaml', `token: *${canary}`],
    ['data.yaml', `%YAML ${canary}\n---\na: b`],
    ['data.yaml', `a: !${canary}!thing b`],
    ['data.yaml', `a: |${canary}\n  b`],
    ['data.json', `{"token":"${canary}`],
  ]) {
    const parsed = parseDocument(name as string, text as string);
    assert.equal(parsed.ok, false);
    assert.equal(JSON.stringify(parsed).includes(canary), false);
  }
});

test('valid YAML, bounded aliases and warning-only tags keep reading', () => {
  assert.deepEqual(parseDocument('data.yaml', 'name: example\n'), {
    ok: true,
    value: { name: 'example' },
  });
  assert.deepEqual(parseDocument('data.yaml', 'a: &a [value]\nb: [*a, *a]\n'), {
    ok: true,
    value: { a: ['value'], b: [['value'], ['value']] },
  });
  assert.deepEqual(parseDocument('data.yaml', 'name: !unknown example\n'), {
    ok: true,
    value: { name: 'example' },
  });
});

test('alias expansion still respects its bound', () => {
  const aliases = Array(11).fill('*a').join(', ');
  const parsed = parseDocument(
    'data.yaml',
    `a: &a [value]\nb: &b [${aliases}]\nc: [${Array(11).fill('*b').join(', ')}]\n`,
  );
  assert.equal(parsed.ok, false);
});

test('JSON keeps strict JSON syntax even when YAML could recover', () => {
  assert.equal(parseDocument('data.json', '{"name":').ok, false);
  assert.equal(parseDocument('data.json', 'name: example').ok, false);
  assert.deepEqual(parseDocument('data.json', '{"name":"example"}'), {
    ok: true,
    value: { name: 'example' },
  });
});
