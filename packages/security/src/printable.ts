/**
 * Terminal-safe rendering of text that a repository or another outside source
 * controls (terminal escaping of repository text).
 *
 * A workspace directory name can hold any byte except `/` and NUL, and a
 * config, a ref, a diagnostic or a finding can carry any string. Written to a
 * terminal raw, such text can recolour the screen, move the cursor, set the
 * window title (OSC), or start a new line that reads like a finding of its own.
 * Every text-mode renderer (the CLI's, the alignment summary's) therefore passes outside text through `printable`
 * (one line) or `printableLines` (keeps LF and TAB) before it is interpolated.
 * Machine output (`--json`, exports, packets, SARIF) never goes through this
 * module: JSON encoding is a different concern and those bytes are pinned.
 *
 * The rule is per character, so an escape sequence is defanged by replacing its
 * leading ESC (or C1 CSI, OSC and DCS introducer) and the rest stays readable:
 * `x<ESC>[31mRED` prints as `x\x1b[31mRED`.
 *
 * What is replaced, each by its escaped form:
 *   - C0 controls (U+0000..U+001F), DEL (U+007F) and C1 controls
 *     (U+0080..U+009F): `\xNN`. LF, CR and TAB are `\n`, `\r` and `\t`.
 *   - Bidirectional overrides, embeddings and isolates (U+202A..U+202E,
 *     U+2066..U+2069), the direction marks (U+200E, U+200F, U+061C), the
 *     line and paragraph separators (U+2028, U+2029), zero-width and other
 *     format characters (U+200B..U+200D, U+2060..U+206F, U+00AD, U+034F,
 *     U+FEFF, the Hangul and Khmer fillers, U+FFF0..U+FFFB) and the Tags block
 *     (U+E0000..U+E0FFF): `\uNNNN` or `\u{N}`.
 *   - Lone surrogates: `\uNNNN`.
 *
 * Not changed: a literal backslash, so a name that already reads `\x1b` is not
 * told apart from an escaped ESC. That is ambiguity in what a human reads, not
 * a way to run anything. The invisible-character ranges mirror
 * `packages/security/src/invisible.ts` (variation selectors excepted, since
 * they only change how an emoji looks).
 */

/** Characters replaced in every mode: controls, format, bidi, separators. */
const UNSAFE =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF0-\uFFFC\u{110BD}\u{110CD}\u{13430}-\u{1343F}\u{E0000}-\u{E0FFF}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

const NAMED: Readonly<Record<string, string>> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

function escapeOne(ch: string): string {
  const named = NAMED[ch];
  if (named !== undefined) return named;
  const cp = ch.codePointAt(0) as number;
  if (cp <= 0xff) return `\\x${cp.toString(16).padStart(2, '0')}`;
  if (cp > 0xffff) return `\\u{${cp.toString(16)}}`;
  return `\\u${cp.toString(16).padStart(4, '0')}`;
}

/**
 * One line of outside text, safe to write to a terminal. Line breaks of every
 * kind (LF, CR, U+0085, U+2028, U+2029) are escaped, so a value cannot start a
 * line of its own.
 */
export function printable(text: string): string {
  return text.replace(UNSAFE, escapeOne);
}

/**
 * Outside text that is meant to span lines (a hint, a stack trace). LF and TAB
 * survive; everything `printable` replaces is still replaced, CR included. Use
 * it only where the line structure comes from our own message, not from a name.
 */
export function printableLines(text: string): string {
  return text.replace(UNSAFE, (ch) => (ch === '\n' || ch === '\t' ? ch : escapeOne(ch)));
}

/**
 * The SGR sequences `makeStyle` emits and nothing else: bold, dim, the five
 * colours and reset. They are the only escape bytes a renderer is allowed to
 * produce itself.
 */
const OWN_SGR = /(\u001b\[(?:0|1|2|31|32|33|35|36)m)/;

/**
 * Last line of defence for a rendered text block: escape every control
 * character in it except LF, TAB and (when `allowStyle`) our own SGR codes.
 * Field-level `printable` calls are the primary control, because this cannot
 * tell a name's `ESC[31m` from ours when colour is on and it lets LF through.
 * It exists so a field that a renderer forgot still cannot move the cursor or
 * set the window title.
 */
export function terminalText(text: string, allowStyle: boolean): string {
  if (!allowStyle) return printableLines(text);
  return text
    .split(OWN_SGR)
    .map((part, i) => (i % 2 === 1 ? part : printableLines(part)))
    .join('');
}
