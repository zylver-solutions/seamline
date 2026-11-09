import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colourEnabled, makeStyle, stripAnsi } from './colour.ts';

const base = { isTty: true, env: {} as Record<string, string | undefined>, noColorFlag: false, json: false };

test('colour is on for a TTY with a permissive environment', () => {
  assert.equal(colourEnabled(base), true);
});

test('colour is off when stdout is not a TTY', () => {
  assert.equal(colourEnabled({ ...base, isTty: false }), false);
});

test('NO_COLOR with any non-empty value disables colour, even on a TTY', () => {
  for (const value of ['1', '0', 'false', 'yes', 'anything']) {
    assert.equal(colourEnabled({ ...base, env: { NO_COLOR: value } }), false, `NO_COLOR=${value}`);
  }
});

test('an empty NO_COLOR does not disable colour (no-color.org)', () => {
  assert.equal(colourEnabled({ ...base, env: { NO_COLOR: '' } }), true);
});

test('NO_COLOR beats FORCE_COLOR', () => {
  assert.equal(colourEnabled({ ...base, env: { NO_COLOR: '1', FORCE_COLOR: '1' } }), false);
});

test('FORCE_COLOR enables colour on a non-TTY', () => {
  assert.equal(colourEnabled({ ...base, isTty: false, env: { FORCE_COLOR: '1' } }), true);
  assert.equal(colourEnabled({ ...base, isTty: false, env: { FORCE_COLOR: '0' } }), false);
});

test('--no-color beats a TTY and FORCE_COLOR', () => {
  assert.equal(colourEnabled({ ...base, noColorFlag: true, env: { FORCE_COLOR: '1' } }), false);
});

test('--json is never coloured', () => {
  assert.equal(colourEnabled({ ...base, json: true, env: { FORCE_COLOR: '1' } }), false);
});

test('TERM=dumb disables colour', () => {
  assert.equal(colourEnabled({ ...base, env: { TERM: 'dumb' } }), false);
});

test('a disabled style emits the string unchanged', () => {
  const style = makeStyle(false);
  const painted = `${style.red('a')}${style.bold('b')}${style.dim('c')}${style.green('d')}${style.cyan('e')}${style.magenta('f')}${style.yellow('g')}`;
  assert.equal(painted, 'abcdefg');
});

test('an enabled style emits escapes that stripAnsi removes exactly', () => {
  const style = makeStyle(true);
  const painted = style.red('danger');
  assert.notEqual(painted, 'danger', 'colour was actually applied');
  assert.equal(stripAnsi(painted), 'danger');
});
