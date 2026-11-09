/**
 * Credential shapes with a known, published format. Design v3 §2.5.
 *
 * These run before the entropy heuristic because a named rule is diagnosable:
 * `redactionReport()` can say "aws-access-key-id" rather than "4.71 bits/char".
 *
 * Every pattern carries `d` (hasIndices) and `g` so the redactor can locate the
 * exact capture-group span without re-searching the text. Rules are applied in
 * declaration order and earlier rules win an overlap, so multi-line block rules
 * (PEM) precede token rules, which precede the generic assignment rule.
 */

export interface SecretRule {
  /** Stable identifier reported by `redactionReport()`. Never renamed lightly. */
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
  /**
   * Capture group to redact. 0 redacts the whole match. `'first-defined'`
   * picks the first of groups 1..3 that matched, for rules whose value has
   * several quoting alternates.
   */
  readonly group?: number | 'first-defined';
  /** Cheap precondition over the whole field, for context-dependent rules. */
  readonly guard?: (text: string) => boolean;
  /** Discards a match whose captured value is structurally not a secret. */
  readonly reject?: (value: string) => boolean;
  /**
   * True when the rule matches a self-delimiting token with a published prefix
   * and charset (an AWS key id, a GitHub token, a JWT). Only these rules also
   * run over identity and locator fields (a node id, an edge endpoint, a
   * repository path), where a match is refused rather than rewritten. A rule
   * that needs surrounding syntax (`key=value`, `Bearer ...`) or has a loose
   * prefix (`sk-` followed by any kebab-case word) must leave this unset: it
   * would fire on route templates like `POST /v1/tokens:refresh` and on file
   * names like `sk-learn-notes.md`, and refusing a record over that is worse
   * than the false positive was. Unset means free-text fields only.
   */
  readonly closedFormat?: boolean;
}

/** Marker prefix. Re-redacting an already-redacted graph must be a no-op. */
export const REDACTION_PREFIX = '\u00abredacted:sha256:';
export const REDACTION_SUFFIX = '\u00bb';
export const REDACTION_MARKER_RE = /\u00abredacted:sha256:[0-9a-f]{8}\u00bb/g;

const NON_VALUES = new Set([
  'null', 'true', 'false', 'undefined', 'none', 'nil', 'empty', 'todo',
  'changeme', 'xxx', 'redacted', 'placeholder', '...',
]);

/** A captured value that is plainly not a live credential. */
function isNonValue(v: string): boolean {
  const t = v.trim().replace(/^["'`]|["'`]$/g, '');
  if (t.length === 0) return true;
  if (NON_VALUES.has(t.toLowerCase())) return true;
  if (t.startsWith(REDACTION_PREFIX)) return true;
  // Interpolation / indirection, not a literal: ${X}, $X, %X%, {{X}}, <X>
  if (/^(\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[^%]*%|\{\{[^}]*\}\}|<[^>]*>)$/.test(t)) return true;
  // A reference to a variable rather than a value.
  if (/^(process\.env|os\.environ|System\.getenv|env)\b/.test(t)) return true;
  if (/^(sops|vault|arn|secretref|file):/i.test(t)) return true;
  if (/^\*+$/.test(t)) return true;
  return false;
}

export const SECRET_RULES: ReadonlyArray<SecretRule> = [
  {
    id: 'private-key-pem',
    description: 'PEM private key block (RSA, EC, DSA, OPENSSH, PGP, PKCS#8, encrypted)',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/gd,
    closedFormat: true,
  },
  {
    id: 'age-secret-key',
    description: 'age / SOPS recipient secret key',
    pattern: /\bAGE-SECRET-KEY-1[0-9A-Z]{50,70}\b/gd,
    closedFormat: true,
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id (AKIA/ASIA/ABIA/ACCA/AIDA/AROA/ANPA/ANVA/AGPA/APKA)',
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA|AIDA|AROA|ANPA|ANVA|AGPA|APKA)[A-Z0-9]{16}\b/gd,
    closedFormat: true,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key, by adjacent key name',
    pattern: /\b(?:aws[_-]?secret[_-]?access[_-]?key|awsSecretAccessKey)\b\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gid,
    group: 1,
  },
  {
    id: 'github-token',
    description: 'GitHub personal access / OAuth / app / refresh token (ghp_, gho_, ghu_, ghs_, ghr_)',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/gd,
    closedFormat: true,
  },
  {
    id: 'github-fine-grained-pat',
    description: 'GitHub fine-grained personal access token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/gd,
    closedFormat: true,
  },
  {
    id: 'gitlab-token',
    description: 'GitLab personal / project / runner token',
    pattern: /\b(?:glpat|glrt|gldt|glsoat|glptt)-[A-Za-z0-9_-]{20,64}\b/gd,
    closedFormat: true,
  },
  {
    id: 'slack-token',
    description: 'Slack bot / user / app / refresh token',
    pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/gd,
    closedFormat: true,
  },
  {
    id: 'slack-webhook',
    description: 'Slack incoming-webhook URL (bearer-equivalent)',
    pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/gd,
    closedFormat: true,
  },
  {
    id: 'stripe-secret-key',
    description: 'Stripe live or test secret key',
    pattern: /\bsk_(?:live|test)_[0-9a-zA-Z]{16,}\b/gd,
    closedFormat: true,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gd,
    closedFormat: true,
  },
  {
    id: 'npm-token',
    description: 'npm automation / publish token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/gd,
    closedFormat: true,
  },
  {
    id: 'openai-key',
    description: 'OpenAI-style API key',
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/gd,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token (header.payload[.signature])',
    pattern: /\beyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}(?:\.[A-Za-z0-9_=-]+)?/gd,
    closedFormat: true,
  },
  {
    id: 'connection-string-password',
    description: 'Inline password in a scheme://user:password@host connection string',
    pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/?#@]+:([^\s/?#@]{3,})@[^\s/?#]+/gd,
    group: 1,
    reject: isNonValue,
  },
  {
    id: 'bearer-header',
    description: 'Authorization: Bearer <token>',
    pattern: /\bBearer\s+([A-Za-z0-9\-._~+/]{16,}={0,2})/gd,
    group: 1,
    reject: isNonValue,
  },
  {
    id: 'basic-auth-header',
    description: 'Authorization: Basic <base64(user:pass)>',
    pattern: /\bBasic\s+([A-Za-z0-9+/]{16,}={0,2})/gd,
    group: 1,
    reject: isNonValue,
  },
  {
    id: 'k8s-secret-data',
    description: 'base64 value inside a Kubernetes Secret data/stringData block',
    // Only fires when the field really is a Secret manifest, so an ordinary
    // YAML map of base64-looking values elsewhere is left alone.
    guard: (text) => /^\s*kind:\s*["']?Secret["']?\s*$/m.test(text),
    pattern: /^[ \t]+[A-Za-z0-9._-]+:[ \t]+([A-Za-z0-9+/]{12,}={0,2})[ \t]*$/gmd,
    group: 1,
    reject: isNonValue,
  },
  {
    id: 'secret-assignment',
    description: 'Assignment whose key names a credential (password, token, api_key, secret, ...)',
    pattern: /\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|client[_-]?secret|auth[_-]?key)[A-Za-z0-9_.-]*\s*[:=]{1,2}\s*(?:"([^"\n]{6,})"|'([^'\n]{6,})'|([^\s"'`,;{}()\[\]]{6,}))/gid,
    // Three alternates so a quoted value keeps its quotes out of the digest.
    group: 'first-defined',
    reject: isNonValue,
  },
];

export { isNonValue };
