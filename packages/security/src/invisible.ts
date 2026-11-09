/**
 * The invisible characters both untrusted-text renderers remove.
 *
 * They are the characters that render as nothing (or reorder what a reviewer
 * sees) and that a language model still reads: a person reviewing the text sees
 * nothing wrong, and a delimiter or an instruction can be split or hidden with
 * them. The set is Unicode's `Default_Ignorable_Code_Point` property, written
 * out as ranges so the set of removed characters does not depend on the Unicode
 * version of the runtime. Every default-ignorable code point is removed,
 * reserved ranges included, so a character that Unicode adds to one of those
 * ranges later is already covered. `invisible.test.ts` checks this against the
 * runtime's own property tables.
 *
 * One of them is removed only where it does no harm: U+FE0F (variation
 * selector-16), which makes an emoji an emoji. It is kept when it directly
 * follows a non-ASCII `Extended_Pictographic` character (a heart, a copyright
 * sign) or is the middle of a keycap sequence (a digit, `#` or `*`, U+FE0F,
 * U+20E3). Anywhere else it is removed, because next to an ASCII letter or `#`
 * it splits a delimiter, a role word or a heading prefix without showing, the
 * same as a zero-width space. A U+FE0F that survives follows a non-ASCII
 * pictograph or precedes U+20E3 (which is not removed), so it never sits
 * between two ASCII characters. Only the removal set is pinned as ranges: the
 * pictograph test uses the runtime's `Extended_Pictographic` table, so a
 * non-emoji symbol such as U+2605 keeps its selector where the runtime's table
 * lists it (Node 22.22, Unicode 16, does) and may lose it on a runtime whose
 * Unicode version does not. Only a symbol whose Extended_Pictographic value
 * differs between the two versions is affected.
 *
 * The zero-width joiner and non-joiner (U+200C, U+200D) are in the set. That
 * damages emoji ZWJ sequences, the England, Scotland and Wales flags (which are
 * tag sequences) and Persian or Indic text that uses ZWNJ. For a renderer of
 * untrusted text that is the intended trade.
 *
 * Not in the set, because they are not default-ignorable: U+2800 (braille
 * blank), the many space characters, homoglyphs, and format characters such as
 * U+0600 to U+0605. See the package README.
 */
const FORMAT_CHARACTERS: string = [
  '\\u00AD', // soft hyphen
  '\\u034F', // combining grapheme joiner
  '\\u061C', // Arabic letter mark (a bidirectional control)
  '\\u115F\\u1160', // Hangul choseong and jungseong fillers
  '\\u17B4\\u17B5', // Khmer inherent vowels
  '\\u180B-\\u180F', // Mongolian free variation selectors and vowel separator
  '\\u200B-\\u200F', // zero-width space, joiners, direction marks
  '\\u202A-\\u202E', // bidirectional embeddings and overrides
  '\\u2060-\\u206F', // word joiner, invisible operators, isolates, deprecated formats
  '\\u3164', // Hangul filler
  '\\uFE00-\\uFE0E', // variation selectors 1 to 15
  '\\uFEFF', // byte order mark / zero-width no-break space
  '\\uFFA0', // halfwidth Hangul filler
  '\\uFFF0-\\uFFFB', // reserved, and the interlinear annotation characters
  '\\u{1BCA0}-\\u{1BCA3}', // shorthand format controls
  '\\u{1D173}-\\u{1D17A}', // musical symbol format controls
  '\\u{E0000}-\\u{E0FFF}', // tag characters, variation selectors supplement, reserved
].join('');

/**
 * U+FE0F where it is not part of an emoji presentation sequence. The test is
 * made on the text as given, and every character it looks at (a pictograph, a
 * keycap base, U+20E3) survives the removal, so the answer does not change when
 * the other invisible characters are removed in the same pass. Each position
 * costs a bounded look at its neighbours, so matching is linear.
 */
const STRAY_EMOJI_SELECTOR =
  '\\uFE0F(?<!\\p{Extended_Pictographic}\\uFE0F)(?:(?<![0-9#*]\\uFE0F)|(?!\\u20E3))';

/**
 * A global, Unicode-mode expression for every character this module removes.
 * `extraClassBody` is more characters for the same character class (the C0 and
 * C1 controls, for a renderer that wants them gone in the same pass).
 */
export function invisibleCharacters(extraClassBody = ''): RegExp {
  return new RegExp(`[${extraClassBody}${FORMAT_CHARACTERS}]|${STRAY_EMOJI_SELECTOR}`, 'gu');
}
