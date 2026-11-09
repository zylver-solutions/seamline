/**
 * PII classification for columns.
 *
 * This drives X6 (PII reachable without auth), the one `critical`-severity
 * detector in design v3 §5, so it is deliberately conservative in two ways.
 *
 * 1. **It is never asserted as fact.** The `Column` node is `EXTRACTED` — the
 *    column really is declared in the file. The PII label on it is a guess
 *    from a name, so it carries `piiProvenance: 'INFERRED'` and a confidence
 *    below 1. Downstream must treat it as inference, and `isFact()` in the
 *    contract is what separates the two.
 * 2. **The declared type gates every rule.** `email_verified_at` is a
 *    `timestamp`: it records *that* an address was confirmed, it does not
 *    contain one. A name-only heuristic fires on it and produces a critical
 *    finding about a boolean flag, which is exactly how a security gate earns
 *    a reputation for noise and gets switched off.
 */

import type { TypeCategory } from './normalize-type.ts';

export const PII_CATEGORIES = [
  'none',
  'email',
  'phone',
  'ssn',
  'national_id',
  'passport',
  'dob',
  'address',
  'ip_address',
  'person_name',
  'credit_card',
  'geo',
  'credential',
  'health',
] as const;
export type PiiCategory = (typeof PII_CATEGORIES)[number];

export interface PiiVerdict {
  readonly category: PiiCategory;
  /** 0 for `none`; otherwise a calibrated confidence below 1. */
  readonly confidence: number;
  /** Which signal fired, so a false positive can be traced without re-running. */
  readonly evidence: string;
}

export const NOT_PII: PiiVerdict = Object.freeze({ category: 'none', confidence: 0, evidence: '' });

/**
 * Tokens that turn a PII-shaped name into a fact *about* the datum rather than
 * the datum. `email_verified`, `phone_confirmed_at`, `address_template`.
 */
const SUPPRESSING_TOKENS: ReadonlySet<string> = new Set([
  'verified',
  'verification',
  'verify',
  'confirmed',
  'confirmation',
  'unconfirmed',
  'validated',
  'count',
  'total',
  'enabled',
  'disabled',
  'template',
  'subject',
  'policy',
  'consent',
  'optin',
  'optout',
  'sent',
  'masked',
  'redacted',
  'required',
  'visible',
  'public',
]);

interface PiiRule {
  readonly category: PiiCategory;
  /** Contiguous token sequences that identify the datum. */
  readonly patterns: readonly (readonly string[])[];
  /** Declared type categories in which the datum can plausibly live. */
  readonly types: readonly TypeCategory[];
  /** Tokens that disqualify this rule specifically. */
  readonly notTokens?: readonly string[];
}

/**
 * Order is significant: the first matching rule wins, so the more specific
 * compound (`ip_address`, `email_address`) is tested before the bare
 * `address`.
 */
const RULES: readonly PiiRule[] = [
  {
    category: 'ssn',
    patterns: [['ssn'], ['social', 'security'], ['social', 'security', 'number'], ['sin']],
    types: ['text'],
  },
  {
    category: 'credit_card',
    patterns: [['credit', 'card'], ['card', 'number'], ['cardnumber'], ['ccnum'], ['pan']],
    types: ['text', 'integer'],
  },
  {
    category: 'passport',
    patterns: [['passport'], ['passport', 'number']],
    types: ['text'],
  },
  {
    category: 'national_id',
    patterns: [['national', 'id'], ['tax', 'id'], ['taxid'], ['nin'], ['curp'], ['rfc'], ['nif'], ['vat', 'number']],
    types: ['text'],
  },
  {
    category: 'email',
    patterns: [['email'], ['e', 'mail'], ['emails'], ['email', 'address']],
    types: ['text'],
  },
  {
    category: 'ip_address',
    patterns: [['ip'], ['ip', 'address'], ['ipaddr'], ['client', 'ip'], ['remote', 'addr'], ['remote', 'ip']],
    types: ['text', 'other'],
  },
  {
    category: 'phone',
    patterns: [
      ['phone'],
      ['telephone'],
      ['phone', 'number'],
      ['mobile', 'number'],
      ['msisdn'],
      ['fax'],
      ['whatsapp'],
    ],
    types: ['text'],
  },
  {
    category: 'dob',
    patterns: [['dob'], ['birth', 'date'], ['birthdate'], ['birthday'], ['date', 'of', 'birth'], ['born', 'on']],
    types: ['timestamp', 'text'],
  },
  {
    category: 'geo',
    patterns: [['latitude'], ['longitude'], ['lat', 'lng'], ['lat', 'lon'], ['geo', 'location'], ['home', 'coords']],
    types: ['numeric'],
  },
  {
    category: 'person_name',
    patterns: [
      ['first', 'name'],
      ['last', 'name'],
      ['full', 'name'],
      ['given', 'name'],
      ['family', 'name'],
      ['middle', 'name'],
      ['maiden', 'name'],
      ['surname'],
      ['forename'],
    ],
    types: ['text'],
  },
  {
    category: 'address',
    patterns: [
      ['address'],
      ['street'],
      ['street', 'address'],
      ['address', 'line'],
      ['postal', 'code'],
      ['postcode'],
      ['zip', 'code'],
      ['zipcode'],
      ['billing', 'address'],
      ['shipping', 'address'],
    ],
    types: ['text', 'json'],
    // Blockchain, network and messaging "addresses" are a different datum.
    notTokens: ['ip', 'mac', 'wallet', 'contract', 'eth', 'btc', 'url', 'web', 'host', 'peer', 'email', 'e'],
  },
  {
    category: 'credential',
    patterns: [
      ['password'],
      ['passwd'],
      ['password', 'hash'],
      ['secret'],
      ['api', 'key'],
      ['access', 'token'],
      ['refresh', 'token'],
      ['session', 'token'],
      ['private', 'key'],
      ['totp', 'secret'],
      ['recovery', 'code'],
    ],
    types: ['text'],
  },
  {
    category: 'health',
    patterns: [['diagnosis'], ['icd', 'code'], ['medical', 'record'], ['blood', 'type'], ['allergies']],
    types: ['text', 'json'],
  },
];

/** Splits `email_address`, `emailAddress` and `Email-Address` the same way. */
export function tokenizeName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);
}

function containsSequence(tokens: readonly string[], seq: readonly string[]): boolean {
  if (seq.length === 0 || seq.length > tokens.length) return false;
  for (let i = 0; i + seq.length <= tokens.length; i += 1) {
    let hit = true;
    for (let k = 0; k < seq.length; k += 1) {
      if (tokens[i + k] !== seq[k]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

function ruleMatches(rule: PiiRule, tokens: readonly string[]): { exact: boolean } | null {
  if (rule.notTokens !== undefined && rule.notTokens.some((t) => tokens.includes(t))) return null;
  let best: { exact: boolean } | null = null;
  for (const pattern of rule.patterns) {
    if (!containsSequence(tokens, pattern)) continue;
    const exact = pattern.length === tokens.length;
    if (exact) return { exact: true };
    best = { exact: false };
  }
  return best;
}

/**
 * Classifies one column.
 *
 * @param columnName the physical column name.
 * @param category   the normalized declared type category; gates every rule.
 * @param comment    a `COMMENT ON COLUMN` / Prisma `///` doc, when present.
 */
export function classifyPii(
  columnName: string,
  category: TypeCategory,
  comment: string | null = null,
): PiiVerdict {
  const nameTokens = tokenizeName(columnName);
  if (nameTokens.some((t) => SUPPRESSING_TOKENS.has(t))) return NOT_PII;

  for (const rule of RULES) {
    if (!rule.types.includes(category)) continue;
    const hit = ruleMatches(rule, nameTokens);
    if (hit === null) continue;
    return {
      category: rule.category,
      confidence: hit.exact ? 0.9 : 0.75,
      evidence: `column-name:${columnName}`,
    };
  }

  if (comment !== null && comment.trim().length > 0) {
    const commentTokens = tokenizeName(comment);
    if (commentTokens.some((t) => SUPPRESSING_TOKENS.has(t))) return NOT_PII;
    for (const rule of RULES) {
      if (!rule.types.includes(category)) continue;
      const hit = ruleMatches(rule, commentTokens);
      if (hit === null) continue;
      return { category: rule.category, confidence: 0.6, evidence: 'column-comment' };
    }
  }

  return NOT_PII;
}
