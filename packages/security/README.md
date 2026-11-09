# @seamline/security
> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

The security primitives behind Seamline, as a package you can use on its own: a secret redactor, the delimiting that keeps third-party text from instructing an agent, and a public corpus of canary secrets and injection payloads that tests both.

Use it if you serve any of Seamline's output (or your own repository text) into a model's context, or if you store extracted facts and need credential-shaped text kept out of them. If you are running Seamline itself, you want `@seamline/cli`; it uses this package for you.

It depends on `@seamline/ontology` and nothing else. `@seamline/core` re-exports the redactor and the `delimit` family from here, name for name, so importers of `@seamline/core` are unaffected.

## The redactor

```ts
import { createRedactor, RedactionError } from '@seamline/security';

const redactor = createRedactor();
const { nodes, edges, report } = redactor.redactGraph(rawNodes, rawEdges);
```

Free-text fields are scanned with the published credential rules (`SECRET_RULES`) and an entropy heuristic. A match is replaced by a stable reference, `«redacted:sha256:xxxxxxxx»`, never by the value; the same secret gets the same reference everywhere, and redacting twice is a no-op. Identity and path fields (node ids, edge endpoints, `path`, `sourceRef`, `srcFile`, `dstFile`) are never rewritten: a closed-format credential in one of them makes `redactGraph` throw `RedactionError`, because rewriting an id would break path-free identity (ADR-0013). The error names the rule and the field and never contains the credential.

The redactor is a heuristic. It catches what it was taught and nothing else; see R1 in [THREATMODEL.md](../../THREATMODEL.md).

## Untrusted-content delimiting

Text that came from a third party is tagged `untrusted` and delimited when it is rendered into an agent's context. Two renderers are exported:

|             | `wrapUntrusted(source, text, nonce)`                                                                                                             | `delimit(text, options)`                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Block       | `<<<BEGIN-UNTRUSTED-DATA id=NONCE ...>>>` ... `<<<END-UNTRUSTED-DATA id=NONCE>>>`                                                                | `<<<SEAMLINE-UNTRUSTED ...>>>` ... `<<<END-SEAMLINE-UNTRUSTED>>>`                                                                                          |
| Terminator  | per-response nonce from `makeNonce()`; an attacker cannot write it                                                                               | fixed sentinel, neutralised wherever it appears in the body                                                                                                |
| Neutralises | delimiter-shaped tokens in any case and spacing, runs of three or more `<` or `>`, control characters, and the invisible characters listed below | the sentinel in any spelling, turn markers at line start (`System:`), chat-template tokens, closing tags of common wrappers, the same invisible characters |
| Length      | not capped; the caller bounds it (the MCP server does)                                                                                           | capped in code points, with a `[truncated: ...]` note                                                                                                      |
| Used by     | `@seamline/mcp`                                                                                                                                  | available to any caller; re-exported by `@seamline/core`                                                                                                   |

Neither renderer tries to recognise malicious intent. A phrase blocklist is bypassable and would corrupt legitimate text that discusses prompt injection, so "ignore all previous instructions" is kept verbatim inside the block, and the block is the control. (`delimit` can rewrite such phrases with `neutraliseInjectionPhrases: true`; it is off by default.)

### Threat model for the delimiting

This is distinct from the repository-level [THREATMODEL.md](../../THREATMODEL.md) (threat T4, control C6, residual risk R4).

- **Asset:** the integrity of the agent's instruction channel. Text from a dependency, an issue, a commit or a comment must stay data.
- **Adversary:** anyone who can put text in a field Seamline serves. They can read this source, so they know both wire formats; they do not know the nonce of a response in flight. They can write any Unicode, of any length, into one field.
- **What the layer defends:** ending the block early or forging a terminator; opening a nested block that looks trusted; impersonating a conversation turn or a tool result (`delimit`); hiding text from a human reviewer, or splitting a delimiter so a matcher misses it, with zero-width, bidirectional or control characters (the set under "Invisible characters"); flooding the context with one very long line (`delimit` caps; for `wrapUntrusted` the caller must); and a field built to make the neutraliser itself slow. Matching is linear in the length of the text, so 100,000 characters of whitespace cost milliseconds, and a test enforces it.
- **What it does not defend, and says so:** a model choosing to follow an instruction that sits correctly inside a block (R4: delimiting is not neutralisation; treat the tag as a signal to a policy layer you write); paraphrase, translation, homoglyph or encoding tricks that carry an instruction rather than a delimiter; a consumer that ignores the block; any text that reaches the model without passing through these functions.

### Invisible characters

Both renderers remove every Unicode default-ignorable code point (zero-width and bidirectional characters, the soft hyphen, the combining grapheme joiner, the Arabic letter mark, the Hangul fillers, the Khmer inherent vowels U+17B4 and U+17B5, every variation selector including the supplement block U+E0100 to U+E01EF, the deprecated format characters U+206A to U+206F, the interlinear annotation characters, the Unicode tag block and the reserved ranges around them) and the C0 and C1 control characters. The one exception depends on its neighbours: U+FE0F (variation selector-16) is kept where it makes an emoji, that is directly after a non-ASCII pictograph (`Extended_Pictographic`: a heart, a copyright sign) or in the middle of a keycap sequence (a digit, `#` or `*`, then U+FE0F, then U+20E3). Anywhere else it is removed, so it cannot split a delimiter, a role word or the `###` of a heading. A regional indicator or an emoji modifier is not a pictograph in this sense, so a U+FE0F after one of those is removed too. The set of pictographs is the runtime's own Unicode data (this exception does not follow the written-out ranges), so whether a non-emoji symbol such as U+2605 keeps its selector may differ between Unicode versions (Node 22.22, with Unicode 16, keeps it); only a symbol whose `Extended_Pictographic` value differs between versions is affected. `src/invisible.test.ts` walks every code point and compares both renderers with the runtime's own Unicode tables, and walks every short string over a small alphabet to check that a U+FE0F that survives always belongs to an emoji sequence, so the list cannot drift from the property it follows.

Removing them has effects beyond "the character is gone". They are by design, and a consumer should know them:

- `attemptedEscape` is true for any text that contains one of these characters, a soft hyphen or a tag character included, not only for text that contains a delimiter. `@seamline/mcp` turns that into the notice that an untrusted string "contained delimiter-escape sequences", so ordinary prose with a soft hyphen raises it.
- The England, Scotland and Wales flag emoji are a black flag followed by tag characters. Both renderers drop the tags, so the flag renders as the plain black flag.
- The zero-width joiner and non-joiner are in the set (both renderers already removed them), which breaks emoji ZWJ sequences into their parts and drops the ZWNJ that Persian and some Indic text uses.
- The strip costs real text a little, never more than the invisible character itself (no letter of modern text is removed; the four Hangul fillers U+115F, U+1160, U+3164 and U+FFA0 have General_Category L, but they are placeholders, not letters used in modern Hangul text): the Mongolian free variation selectors and vowel separator (U+180B to U+180F), the selector that picks a CJK ideographic variation (the base character stays), the text-presentation selector U+FE0E, the Arabic letter mark and the Hebrew right-to-left mark, the combining grapheme joiner, the zero-width joiner in Hindi and other Indic conjuncts, and the two Khmer inherent vowels. The text still reads; the shaping or orthography hint is lost.

### Known limits of the neutraliser

Each of these passes through unchanged. The block is still the control; none of them lets text end it.

- **Blank-looking characters that are not default-ignorable.** U+2800 (braille blank), the no-break space and the other space characters (U+1680, U+2000 to U+200A, U+202F, U+205F, U+3000). Removing them would damage legitimate text. A space character in front of a turn marker is handled (`delimit` treats any indentation that is not a line break as indentation); elsewhere it is ordinary text.
- **Turn markers in disguise.** `delimit` matches ASCII role words (`Human`, `Assistant`, `System`, `User`, `AI`, `Developer`) at the start of a line, ending in `:` or the fullwidth colon U+FF1A. Fullwidth or homoglyph spellings of the word, other colon-like characters (U+FE55, U+A789, U+2236), role words in other languages, and a marker in the middle of a line are not matched. `wrapUntrusted` has no turn-marker rule at all: its control is the nonce.
- **Format characters that are not default-ignorable.** U+0600 to U+0605, U+06DD, U+070F, U+0890 to U+0891, U+08E2, U+110BD, U+110CD and U+13430 to U+1343F (the Arabic number and verse signs, the Syriac abbreviation mark, the Kaithi number signs and the Egyptian hieroglyph layout controls) pass through. Unicode does not mark them ignorable and each belongs to the writing system that uses it, so removing them would damage legitimate text. No way to hide an instruction with them is known, but one placed inside a delimiter splits it for a lexical matcher: `delimit`'s fixed sentinel is then not rewritten. The nonce fence does not rely on that matching.
- **Phrases.** "Ignore previous instructions" and its paraphrases are kept verbatim. `neutraliseInjectionPhrases: true` rewrites a short list; it is bypassable and off by default.
- **Line breaks other than LF, CR, CRLF, U+2028 and U+2029.** The vertical tab, form feed and U+0085 are removed as control characters, not treated as line breaks, so a marker after one of them is joined to the text before it rather than starting a line.

## Terminal-safe text

`printable(text)` returns one line of outside text that is safe to write to a terminal. It replaces C0 and C1 controls, DEL, bidirectional overrides and isolates, zero-width and other format characters, the line and paragraph separators and lone surrogates with their escaped form (`\x1b`, `\u202e`, `\u{e0041}`), and LF, CR and TAB with `\n`, `\r` and `\t`, so a name cannot recolour the screen, move the cursor, set the window title or start a line of its own. `printableLines` keeps LF and TAB for text that is meant to span lines. `terminalText(text, allowStyle)` is a backstop for a finished block: it escapes everything except LF, TAB and (when `allowStyle`) the SGR colour codes the CLI emits itself. Use these for human output only; machine output is encoded, not escaped. A literal backslash is not changed, so a name that already reads `\x1b` cannot be told apart from an escaped ESC.

## The public injection corpus

`corpus/` is data, shipped in the package and importable without any JavaScript:

- `corpus/secrets.json`: credential-shaped strings, one or more for every redactor rule. Each states whether it must be `redacted` (a free-text field) or `refused` (an identity or path field), why it cannot be live (`fakeBecause`), and the rule it exercises.
- `corpus/injections.json`: prompt-injection payloads (instruction overrides, fake turn markers and chat templates, fake tool results, forged and split delimiters, zero-width, bidirectional and control characters, bracket runs, very long lines, and benign lookalikes that must survive unchanged). Each states the rule it exercises and, per renderer, what must (`present`) and must not (`absent`) be in the block body.

`src/conformance.test.ts` runs every entry through the redactor and both renderers and asserts the outcome the entry states, plus structural invariants for every payload: exactly one opening and one closing delimiter, nothing in the body that could be read as either, no control or invisible character, a header the payload cannot influence, idempotent neutralisation, and independence from the nonce. `src/corpus.test.ts` keeps the corpus and the code in step: every redactor rule has a canary, every closed-format rule has a refused-in-identity canary, every default `delimit` neutralisation rule is expected to fire on some payload.

Coverage is checked per rule, not per alternative inside a rule, so the payloads are chosen to reach the alternatives: each role word, each wrapper tag, each optional part of the sentinel, both ends of the tag range, a hostile `source` and `origin`. The one rule with no corpus payload is `injection-phrase`, which is opt-in (`neutraliseInjectionPhrases: true`) and therefore exempt from the per-rule test, which runs the defaults; it is covered in `src/untrusted.test.ts`. Gaps were found by mutating the two renderers' source and running the tests, and the payloads above exist because mutants survived without them.

```ts
import { loadSecretCanaries, loadInjectionCorpus } from '@seamline/security/corpus';

for (const e of loadInjectionCorpus().entries) {
  const rendered = yourRenderer(e.payload); // run your own renderer against the same payloads
}
```

or read `@seamline/security/corpus/secrets.json` and `@seamline/security/corpus/injections.json` directly from any language.

### Nothing in the corpus is a live credential

Every value is invented. Documented examples (AWS's published example key id and secret key) are used where they exist; the rest are built from the word `CANARY`, zeros, or bytes drawn once from a random source, and each says why it cannot be live. A GitHub token's trailing checksum, for example, is deliberately wrong. Values are stored as `parts` that are joined at load time, so no credential appears contiguously in the files: a repository secret scanner, or a scanner reading your `node_modules`, finds nothing. A test scans the raw files with this package's own redactor and fails if it finds anything.

### Adding a case

Edit the JSON; no TypeScript is needed. Run `node --test 'packages/security/src/**/*.test.ts'`.

```jsonc
// corpus/secrets.json
{
  "id": "jwt/my-new-case", // "<group>/<slug>", lower-case kebab-case, unique
  "category": "secret",
  "rule": "jwt", // a SECRET_RULES id, or "high-entropy-string"
  "surface": "free-text", // or "identity"
  "expect": "redacted", // "redacted" for free-text, "refused" for identity
  "fakeBecause": "why no service could have issued this value",
  "template": ["cached session {{secret}}"], // {{secret}} exactly once
  "secret": ["ey", "Jh...", "..."] // split so no part is credential-shaped by itself
}

// corpus/injections.json
{
  "id": "forged-delimiter/my-new-case",
  "category": "forged-delimiter",
  "rule": "token-neutralisation", // one of INJECTION_RULES
  "expect": "delimited",
  "description": "what the attack tries",
  "payload": ["text", "\u200b", { "repeat": "x", "times": 50000 }], // strings, or a repeated unit
  "checks": {
    "fence": { "absent": ["END-UNTRUSTED-DATA"], "present": ["[neutralized-delimiter]"] },
    "delimit": { "absent": ["System:"], "hits": ["role-marker"], "truncated": false }
  }
}
```

Write invisible and control characters as `\uXXXX` escapes; a test rejects raw non-ASCII so nothing can hide in review. If a payload shows that a renderer lets something through, that is a finding: open a security report (see [SECURITY.md](../../SECURITY.md)) rather than weakening the entry.

**Every entry must be written from scratch.** Do not derive a case from a private codebase, from a customer's data, or from a third-party attack list whose license you have not checked. A minimized repro of something real is still a published description of it.

## What is not here

The extractor sandbox, the export profiles and the sensitivity rules, and the store decorator that makes the redactor the sole writer (`wrapWithRedaction`) stay in `@seamline/core`: each is bound to the store, the export policy or the extractor manifest rather than to content. The corpus covers the redactor and the two renderers only.

**Stability tier: library surface.** Published, importable, documented as unstable below 1.0. The corpus is append-only in spirit: entries may be added at any time, and an entry is changed or removed only when the behavior it records changes, in a release that says so.
