/**
 * Which characters the two renderers remove, checked against Unicode itself.
 *
 * The set in `invisible.ts` is the default-ignorable code points, written out as
 * ranges. Writing the ranges out keeps the result independent of the runtime's
 * Unicode version, but it means a hand-maintained list could drift from the
 * property it claims to follow. This test walks every code point and compares
 * the renderers with the runtime's own tables, so a range that is too narrow,
 * or a character that Unicode adds to a reserved range, fails here.
 *
 * U+FE0F is the one default-ignorable code point whose removal depends on its
 * neighbours (it is kept inside an emoji presentation sequence); the second
 * block of tests covers it, including an exhaustive walk over short strings.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attemptedEscape, neutralize } from './fence.ts';
import { neutraliseUntrusted } from './untrusted.ts';

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

function* codePoints(): Generator<number> {
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates are not characters
    yield cp;
  }
}

/** Both renderers, as a function from text to text. */
const RENDERERS: ReadonlyArray<[string, (text: string) => string]> = [
  ['wrapUntrusted / neutralize', neutralize],
  ['delimit / neutraliseUntrusted', (text) => neutraliseUntrusted(text).text],
];

describe('invisible / default-ignorable code points', () => {
  for (const [name, render] of RENDERERS) {
    it(`${name} removes every default-ignorable code point between two letters`, () => {
      const survivors: string[] = [];
      let checked = 0;
      for (const cp of codePoints()) {
        const ch = String.fromCodePoint(cp);
        if (!DEFAULT_IGNORABLE.test(ch)) continue;
        checked += 1;
        if (render(`a${ch}b`) !== 'ab') survivors.push(`U+${cp.toString(16).toUpperCase()}`);
      }
      assert.deepEqual(survivors, [], 'default-ignorable code points that survive');
      assert.ok(checked > 4000, `only ${checked} code points checked; the property table changed`);
    });

    it(`${name} removes U+FE0F, U+17B4 and U+17B5 wherever they could split ASCII text`, () => {
      for (const cp of [0xfe0f, 0x17b4, 0x17b5]) {
        const ch = String.fromCodePoint(cp);
        assert.ok(
          DEFAULT_IGNORABLE.test(ch),
          `U+${cp.toString(16)} is no longer default-ignorable`,
        );
        for (const text of [`a${ch}b`, `${ch}a`, `a${ch}`, ` ${ch} `, `#${ch}##`, `1${ch}2`]) {
          assert.equal(render(text), text.replace(ch, ''), `U+${cp.toString(16)} in ${text}`);
        }
      }
    });

    it(`${name} removes the tag block from its first code point to its last, and what follows`, () => {
      for (const cp of [
        0xe0000, 0xe0001, 0xe0020, 0xe007e, 0xe007f, 0xe0080, 0xe00ff, 0xe0100, 0xe01ef, 0xe0fff,
      ]) {
        assert.equal(render(`a${String.fromCodePoint(cp)}b`), 'ab', `U+${cp.toString(16)}`);
      }
      assert.equal(
        render(`a${String.fromCodePoint(0xe1000)}b`),
        `a${String.fromCodePoint(0xe1000)}b`,
      );
    });

    it(`${name} leaves the characters it documents as out of scope`, () => {
      // Blank-looking but not ignorable: a braille blank and the space characters. See the README.
      // In order: braille blank, no-break space, ideographic space, em space, narrow no-break space.
      for (const ch of ['\u2800', '\u00A0', '\u3000', '\u2003', '\u202F']) {
        assert.equal(render(`a${ch}b`), `a${ch}b`, `U+${ch.codePointAt(0)?.toString(16)}`);
      }
    });

    it(`${name} passes the format characters that are not default-ignorable`, () => {
      // The "Known limits" list in the README: the Arabic number signs and marks, the Syriac
      // abbreviation mark, the Kaithi number signs and the Egyptian hieroglyph format controls.
      // None is default-ignorable, so none is removed.
      const ranges: ReadonlyArray<readonly [number, number]> = [
        [0x600, 0x605],
        [0x6dd, 0x6dd],
        [0x70f, 0x70f],
        [0x890, 0x891],
        [0x8e2, 0x8e2],
        [0x110bd, 0x110bd],
        [0x110cd, 0x110cd],
        [0x13430, 0x1343f],
      ];
      for (const [first, last] of ranges) {
        for (let cp = first; cp <= last; cp++) {
          const text = `a${String.fromCodePoint(cp)}b`;
          assert.equal(render(text), text, `U+${cp.toString(16).toUpperCase()}`);
        }
      }
    });
  }
});

describe('invisible / emoji presentation selector', () => {
  const VS16 = '\uFE0F';
  const KEYCAP = '\u20E3';

  /** Text with U+FE0F in an emoji presentation sequence: it must come through unchanged. */
  const EMOJI_TEXT: ReadonlyArray<string> = [
    `\u2764${VS16}`, // red heart
    `Shipped \u2764${VS16} today`,
    `\u00A9${VS16} \u00AE${VS16} \u2122${VS16}`, // copyright, registered, trade mark
    `\u25B6${VS16}`, // play button
    `\u{1F3F3}${VS16}`, // white flag
    `\u{1F441}${VS16}`, // eye
    `1${VS16}${KEYCAP}`, // keycap digit one
    `0${VS16}${KEYCAP} 9${VS16}${KEYCAP}`,
    `#${VS16}${KEYCAP} *${VS16}${KEYCAP}`, // keycap number sign and asterisk
    `Press #${VS16}${KEYCAP} then 1${VS16}${KEYCAP}.`,
  ];

  for (const [name, render] of RENDERERS) {
    it(`${name} renders emoji presentation sequences unchanged`, () => {
      for (const text of EMOJI_TEXT) {
        assert.equal(render(text), text, JSON.stringify(text));
      }
    });

    it(`${name} removes U+FE0F that does not follow a pictograph or sit inside a keycap`, () => {
      const cases: ReadonlyArray<readonly [string, string]> = [
        [`a${VS16}b`, 'ab'],
        [`${VS16}`, ''],
        [`${VS16}\u2764`, '\u2764'],
        [` ${VS16}`, ' '],
        [`#${VS16}##`, '###'], // would otherwise split the "###" heading prefix
        [`*${VS16}*`, '**'],
        [`1${VS16}2`, '12'], // a digit that is not followed by the keycap
        [`1${VS16}`, '1'],
        [`${KEYCAP}${VS16}`, KEYCAP], // after the keycap itself, not before it
        [`\u2764${VS16}${VS16}`, `\u2764${VS16}`], // a second selector is not emoji presentation
        [`1${VS16}${VS16}${KEYCAP}`, `1${KEYCAP}`],
        [`\u{1F1E6}${VS16}`, '\u{1F1E6}'], // after a regional indicator, which is not a pictograph
        [`\u2764\u200B${VS16}`, '\u2764'], // cut off from the pictograph by an invisible character
        [`1${VS16}\u200B${KEYCAP}`, `1${KEYCAP}`],
      ];
      for (const [text, expected] of cases) {
        assert.equal(render(text), expected, JSON.stringify(text));
      }
    });

    it(`${name} leaves a U+FE0F only after a non-ASCII pictograph or before a keycap, and is idempotent`, () => {
      // Every string of up to four characters from an alphabet that holds the neighbours that
      // matter: ASCII, a keycap base, an invisible character, a control, the selector, the
      // keycap, a pictograph, a supplementary pictograph and an emoji modifier.
      const alphabet = [
        'a',
        '#',
        '1',
        ' ',
        '\u200B', // zero-width space
        '\u0001', // a control character
        VS16,
        KEYCAP,
        '\u2764', // heart, a pictograph
        '\u{1F600}', // grinning face, a pictograph
        '\u{1F3FB}', // skin tone modifier, not a pictograph
      ];
      const pictograph = /^\p{Extended_Pictographic}$/u;
      let strings = 0;
      let selectors = 0;
      const visit = (prefix: string, depth: number): void => {
        if (prefix !== '') {
          strings += 1;
          const out = render(prefix);
          assert.equal(render(out), out, `not idempotent: ${JSON.stringify(prefix)}`);
          const chars = [...out];
          chars.forEach((ch, i) => {
            if (ch !== VS16) return;
            selectors += 1;
            const before = chars[i - 1] ?? '';
            const afterPictograph = pictograph.test(before) && (before.codePointAt(0) ?? 0) > 0x7f;
            const insideKeycap = /^[0-9#*]$/.test(before) && chars[i + 1] === KEYCAP;
            assert.ok(
              afterPictograph || insideKeycap,
              `U+FE0F survived in ${JSON.stringify(out)} from ${JSON.stringify(prefix)}`,
            );
          });
        }
        if (depth === 0) return;
        for (const ch of alphabet) visit(prefix + ch, depth - 1);
      };
      visit('', 4);
      assert.ok(strings > 16000 && selectors > 500, `${strings} strings, ${selectors} selectors`);
    });
  }
});

describe('invisible / what removing them changes', () => {
  it('turns a soft hyphen or a tag character into a delimiter-escape attempt', () => {
    assert.equal(attemptedEscape('co\u00ADoperate'), true);
    assert.equal(attemptedEscape(`ordinary${String.fromCodePoint(0xe0041)}`), true);
    assert.equal(attemptedEscape('cooperate'), false);
  });

  it('turns the England, Scotland and Wales flags into the plain black flag', () => {
    const tags = (word: string): string =>
      [...word].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    for (const subdivision of ['gbeng', 'gbsct', 'gbwls']) {
      const flag = `\u{1f3f4}${tags(subdivision)}${String.fromCodePoint(0xe007f)}`;
      for (const [name, render] of RENDERERS) {
        assert.equal(render(flag), '\u{1f3f4}', name);
      }
    }
  });

  it('removes the zero-width joiner from an emoji sequence but keeps the emoji presentation selector', () => {
    for (const [name, render] of RENDERERS) {
      assert.equal(render('\u{1f468}\u200D\u{1f469}'), '\u{1f468}\u{1f469}', name);
      assert.equal(render('\u2764\uFE0F'), '\u2764\uFE0F', name);
      // A joined sequence that carries a presentation selector keeps it and loses the joiner.
      assert.equal(render('\u{1f3f3}\uFE0F\u200D\u{1f308}'), '\u{1f3f3}\uFE0F\u{1f308}', name);
    }
  });

  it('changes the real text the README lists, and only by the invisible character', () => {
    // Each case is the text as written and what both renderers return. The letters stay.
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['Mongolian free variation selector', '\u1820\u180B', '\u1820'],
      ['Mongolian vowel separator', '\u1820\u180E\u1821', '\u1820\u1821'],
      ['CJK ideographic variation sequence', '\u845B\u{E0100}', '\u845B'],
      ['CJK standardized variation sequence', '\u8FBB\uFE00', '\u8FBB'],
      ['text presentation selector', '\u2764\uFE0E', '\u2764'],
      ['Arabic letter mark', 'a\u061Cb', 'ab'],
      ['right-to-left mark', '\u05D0\u200F\u05D1', '\u05D0\u05D1'],
      ['combining grapheme joiner', 'a\u034Fb', 'ab'],
      ['Hindi conjunct with a zero-width joiner', '\u0915\u094D\u200D\u0937', '\u0915\u094D\u0937'],
      ['Persian zero-width non-joiner', '\u0645\u06CC\u200C\u062E', '\u0645\u06CC\u062E'],
      ['Khmer inherent vowel', '\u1780\u17B6\u17B4', '\u1780\u17B6'],
    ];
    for (const [label, text, expected] of cases) {
      for (const [name, render] of RENDERERS) {
        assert.equal(render(text), expected, `${label} (${name})`);
      }
    }
  });
});
