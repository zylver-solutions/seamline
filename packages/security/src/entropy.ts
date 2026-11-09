/**
 * Shannon-entropy heuristic for credential-shaped strings that match no known
 * pattern. Design v3 §2.5: the Redactor runs an "entropy and pattern scan".
 *
 * ## Calibration (reproducible)
 *
 * The threshold was chosen by measuring observed per-character Shannon entropy
 * over two corpora rather than by taste:
 *
 * | population                         | observed H (bits/char)      |
 * |------------------------------------|-----------------------------|
 * | random hex, any length             | <= 4.000 by construction    |
 * | git SHA-1 / SHA-256 / UUID samples | 3.39 – 4.00                 |
 * | camelCase / snake_case identifiers | 3.55 – 4.02                 |
 * | MIME types, short repo paths       | 3.87 – 3.95                 |
 * | random base62 secret, len 32       | mean 4.55, p-min 4.05       |
 * | random base64 secret, len 40       | mean 4.78, p-min 4.29       |
 * | random base64 secret, len 64       | mean 5.18, p-min 4.80       |
 *
 * `ENTROPY_THRESHOLD = 4.2` sits in the empty band between the two. The upper
 * edge is structural, not tuned: a hex string cannot exceed log2(16) = 4.0
 * bits/char no matter how long, so **every hash and every UUID is immune by
 * arithmetic**, not by a lucky constant.
 *
 * **The band does not hold for long paths.** Entropy over a string grows with
 * its length and its number of distinct characters, and `/` is in the token
 * class, so a path is one token. Measured over this repository's tracked paths
 * (235 tokens of 32..128 characters): median 3.76 bits/char at 32..40 characters
 * and 4.13 at 61 or more, with a tail to 4.37. Nine paths of 42..79 characters
 * scored 4.2..4.4 and were flagged (reported against the redactor). No threshold separates them from
 * a secret, so the heuristic is not applied to identity and locator fields at
 * all (ADR-0013). It still runs on free text, where a false positive costs a
 * reference that the redaction report can explain, not an id that breaks a join.
 *
 * `ENTROPY_MIN_LENGTH = 32` is the length floor. At 24 characters the base62
 * and identifier distributions overlap (random-b62 p-min 3.66 vs identifier max
 * 4.02); at 32 they separate. Measured detection rate at (32, 4.2) over 6000
 * synthetic secrets per cell: 98.4% at length 32, 99.9% at 40, 100% at 64.
 *
 * `ENTROPY_MAX_LENGTH = 128` is the ceiling. Above it a token is a blob (an
 * inlined image, a bundled source map, a certificate body), not a credential;
 * credentials in the wild top out well under this. Blob shapes that *are* short
 * enough to reach the threshold are excluded by `KNOWN_ENCODING_PREFIXES`.
 *
 * Structural guards run before the threshold so that a rejection is explainable
 * by name in `redactionReport()` rather than by a bare score.
 */

/** Bits per character. See the calibration table above. */
export const ENTROPY_THRESHOLD = 4.2;

/** Length floor, in characters. Below this the distributions overlap. */
export const ENTROPY_MIN_LENGTH = 32;

/** Length ceiling. Above this a token is a blob, not a credential. */
export const ENTROPY_MAX_LENGTH = 128;

/**
 * Candidate tokenizer. Deliberately excludes `.` so that dotted paths, version
 * strings and package coordinates split into short, harmless pieces, and `:`
 * `@` `;` so URLs and NodeIds split at their structural separators.
 */
export const ENTROPY_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;

/**
 * Magic prefixes of base64-encoded media and integrity digests. These are high
 * entropy and are never credentials. Checked as a prefix, so a credential that
 * happens to begin with one of these is missed; that is a deliberate, narrow
 * trade recorded here rather than hidden.
 */
export const KNOWN_ENCODING_PREFIXES: ReadonlyArray<string> = [
  'iVBORw0KGgo', // PNG
  '/9j/', // JPEG
  'R0lGOD', // GIF
  'JVBERi0', // PDF
  'UklGR', // WebP / RIFF
  'PHN2Zw', // "<svg"
  'AAAAIGZ0eXA', // MP4 ftyp
  'sha256-', // Subresource Integrity
  'sha384-',
  'sha512-',
  'md5-',
];

export const ENTROPY_REJECTIONS = [
  'below-floor',
  'above-ceiling',
  'hex-or-uuid',
  'known-encoding-prefix',
  'single-char-class',
  'sequential-alphabet',
  'cased-identifier',
  'below-threshold',
] as const;
export type EntropyRejection = (typeof ENTROPY_REJECTIONS)[number];

/** Observed Shannon entropy of `s` in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Fraction of adjacent character pairs whose code points differ by exactly one.
 * A declared alphabet constant (`'ABCDEFGH...z0123456789'`) scores ~1.0; a
 * random secret scores ~1/62. This is what keeps charset constants (which
 * reach 5.95 bits/char, higher than any real secret in the corpus) out.
 */
export function sequentialRunRatio(s: string): number {
  if (s.length < 2) return 0;
  let runs = 0;
  for (let i = 1; i < s.length; i += 1) {
    if (s.charCodeAt(i) - s.charCodeAt(i - 1) === 1) runs += 1;
  }
  return runs / (s.length - 1);
}

/**
 * True when the token reads as a separator-delimited identifier: three or more
 * `_`/`-` separated parts, each of which is internally single-cased
 * (`MIGRATION_0032_add_org_id_to_projects_table_v2`). A random base64url secret
 * reaches this shape with probability well under 1e-4, because it needs two or
 * more separators *and* every resulting run to be accidentally single-cased.
 */
export function isCasedIdentifier(s: string): boolean {
  const parts = s.split(/[_-]+/).filter((p) => p.length > 0);
  if (parts.length < 3) return false;
  return parts.every((p) => /^[a-z0-9]+$/.test(p) || /^[A-Z0-9]+$/.test(p));
}

export interface EntropyVerdict {
  readonly isSecret: boolean;
  readonly entropy: number;
  /** Present when `isSecret` is false. Names the guard that rejected it. */
  readonly rejectedBy: EntropyRejection | null;
}

/**
 * Classify one candidate token. Guards run before the threshold so a rejection
 * carries a name, not just a number.
 */
export function classifyToken(
  token: string,
  threshold: number = ENTROPY_THRESHOLD,
): EntropyVerdict {
  const reject = (r: EntropyRejection): EntropyVerdict => ({
    isSecret: false,
    entropy: 0,
    rejectedBy: r,
  });

  if (token.length < ENTROPY_MIN_LENGTH) return reject('below-floor');
  if (token.length > ENTROPY_MAX_LENGTH) return reject('above-ceiling');
  // Hex and UUID: alphabet of 16 (+ separators) caps entropy at 4.0 bits/char.
  if (/^[0-9a-fA-F_-]+$/.test(token)) return reject('hex-or-uuid');
  if (KNOWN_ENCODING_PREFIXES.some((p) => token.startsWith(p))) {
    return reject('known-encoding-prefix');
  }
  // A credential mixes letters and digits. A pure-letter or pure-digit run of
  // this length is a sentence fragment, an id sequence or a padding run.
  if (!/[0-9]/.test(token) || !/[A-Za-z]/.test(token)) return reject('single-char-class');
  if (sequentialRunRatio(token) >= 0.5) return reject('sequential-alphabet');
  if (isCasedIdentifier(token)) return reject('cased-identifier');

  const entropy = shannonEntropy(token);
  if (entropy < threshold) {
    return { isSecret: false, entropy, rejectedBy: 'below-threshold' };
  }
  return { isSecret: true, entropy, rejectedBy: null };
}
