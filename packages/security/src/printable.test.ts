import assert from 'node:assert/strict';
import { test } from 'node:test';
import { printable, printableLines, terminalText } from './printable.ts';

/** Anything a terminal could act on or a reader could not see, except LF and TAB. */
const UNSAFE_OUTPUT =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff0-\ufffc\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2\u{110bd}\u{110cd}\u{13430}-\u{1343f}\u{e0000}-\u{e0fff}]/u;

test('the issue repro: ESC, CSI and OSC with BEL are escaped and the rest of the name stays', () => {
  const out = printable('packages/x\u001b[31mRED\u001b]0;pwned\u0007');
  assert.equal(out, 'packages/x\\x1b[31mRED\\x1b]0;pwned\\x07');
});

test('C0 controls become \\xNN, with LF, CR and TAB named', () => {
  assert.equal(printable('a\u0000b\u0008c\u001fd'), 'a\\x00b\\x08c\\x1fd');
  assert.equal(printable('a\nb\rc\td'), 'a\\nb\\rc\\td');
  assert.equal(printable('a\u000bb\u000cc'), 'a\\x0bb\\x0cc');
});

test('DEL is escaped', () => {
  assert.equal(printable('a\u007fb'), 'a\\x7fb');
});

test('C1 controls are escaped, including the one-byte CSI, OSC and DCS introducers', () => {
  assert.equal(printable('a\u009b2Jb'), 'a\\x9b2Jb');
  assert.equal(printable('a\u009d0;t\u0007'), 'a\\x9d0;t\\x07');
  assert.equal(printable('a\u0090qb\u0085c\u009fd'), 'a\\x90qb\\x85c\\x9fd');
});

test('bidirectional overrides, embeddings, isolates and marks are escaped', () => {
  for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]) {
    const ch = String.fromCodePoint(cp);
    assert.equal(printable(`a${ch}b`), `a\\u${cp.toString(16).padStart(4, '0')}b`, `U+${cp.toString(16)}`);
  }
});

test('zero-width and other format characters are escaped', () => {
  for (const cp of [0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x206f, 0xfeff, 0x00ad, 0x034f, 0x3164, 0xffa0, 0xfff9, 0xfffc, 0x600, 0x605, 0x6dd, 0x70f, 0x890, 0x891, 0x8e2, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0xfff0]) {
    const ch = String.fromCodePoint(cp);
    assert.doesNotMatch(printable(`a${ch}b`), UNSAFE_OUTPUT, `U+${cp.toString(16)}`);
    assert.match(printable(`a${ch}b`), /^a\\(?:x[0-9a-f]{2}|u[0-9a-f]{4})b$/);
  }
});

test('Tags-block characters (invisible ASCII smuggling) are escaped as \\u{...}', () => {
  assert.equal(printable(`a${String.fromCodePoint(0xe0041)}b`), 'a\\u{e0041}b');
});

test('line and paragraph separators cannot start a line', () => {
  assert.equal(printable('a\u2028b\u2029c\u0085d'), 'a\\u2028b\\u2029c\\x85d');
});

test('lone surrogates are escaped; a valid pair is kept', () => {
  assert.equal(printable('a\ud800b'), 'a\\ud800b');
  assert.equal(printable('a\udc00b'), 'a\\udc00b');
  assert.equal(printable('a\u{1f600}b'), 'a\u{1f600}b');
});

test('ordinary text, non-ASCII letters, emoji and backslashes pass through unchanged', () => {
  const s = 'src/módulo/ñandú \u{1f980} 日本語 C:\\dir\\file.ts [31m (a, b)';
  assert.equal(printable(s), s);
});

test('printable is idempotent', () => {
  const once = printable('x\u001b[31m\n\u202e\u0007');
  assert.equal(printable(once), once);
});

test('printableLines keeps LF and TAB and escapes the rest, CR included', () => {
  assert.equal(printableLines('a\nb\tc\rd\u001be\u009bf\u202eg'), 'a\nb\tc\\rd\\x1be\\x9bf\\u202eg');
});

test('terminalText without style escapes every ESC', () => {
  const out = terminalText('plain \u001b[31mred\u001b[0m\nnext', false);
  assert.equal(out, 'plain \\x1b[31mred\\x1b[0m\nnext');
});

test('terminalText with style keeps only the SGR codes the CLI style emits', () => {
  const ours = '\u001b[31mx\u001b[0m \u001b[1m\u001b[2my\u001b[0m \u001b[32ma\u001b[33mb\u001b[35mc\u001b[36md';
  assert.equal(terminalText(ours, true), ours);
  assert.equal(
    terminalText('a\u001b[2Jb\u001b]0;t\u0007c\u001b[38;5;9md\u009b2Je', true),
    'a\\x1b[2Jb\\x1b]0;t\\x07c\\x1b[38;5;9md\\x9b2Je',
  );
});

test('terminalText with style passes only the SGR codes the CLI emits: no conceal, reverse, blink, black or custom colours', () => {
  // bold, dim, reset and the red, green, yellow, magenta and cyan foregrounds. None hides text.
  const ours = new Set(['0', '1', '2', '31', '32', '33', '35', '36']);
  for (let n = 0; n <= 255; n++) {
    const seq = `\u001b[${n}m`;
    const out = terminalText(seq, true);
    if (ours.has(String(n))) assert.equal(out, seq, `SGR ${n} is ours`);
    else assert.equal(out, `\\x1b[${n}m`, `SGR ${n} must be escaped`);
  }
  const hostile = [
    '\u001b[m', '\u001b[08m', '\u001b[8;1m', '\u001b[1;8m', '\u001b[0;8m', '\u001b[8;0m', '\u001b[1;2m', '\u001b[31;8m', '\u001b[1:8m', '\u001b[30;30m',
    '\u001b[38;5;0m', '\u001b[38;2;0;0;0m', '\u001b[48;5;1m', '\u001b[7;31m', '\u001b[ 8m', '\u001b[8 m', '\u001b[?8m', '\u001b[8mhidden\u001b[0m',
  ];
  for (const seq of hostile) {
    const out = terminalText(`a${seq}b`, true);
    assert.doesNotMatch(out, /\u001b\[[0-9;:? ]*8[0-9;:]*m/u, `a conceal survived in ${JSON.stringify(seq)}`);
  }
  assert.equal(terminalText('\u001b[8mhidden\u001b[0m', true), '\\x1b[8mhidden\u001b[0m');
});

test('astral format characters (Kaithi number signs, Egyptian hieroglyph format controls) are escaped as \\u{...}', () => {
  for (const cp of [0x110bd, 0x110cd, 0x13430, 0x1343f]) {
    assert.equal(printable(`a${String.fromCodePoint(cp)}b`), `a\\u{${cp.toString(16)}}b`, `U+${cp.toString(16)}`);
  }
});
