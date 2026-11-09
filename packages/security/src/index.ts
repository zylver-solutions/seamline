/**
 * @seamline/security: the primitives that keep secrets out of the graph and
 * third-party text from instructing an agent. Design v3 sections 2.5 and 2.6.
 *
 * - The **redactor** (`createRedactor`, `SECRET_RULES`, entropy scanning,
 *   `RedactionError`): credential-shaped text in free-text fields becomes a
 *   stable reference; in identity and path fields it refuses the record
 *   (ADR-0013).
 * - **Untrusted-content delimiting** for text rendered into an agent's context,
 *   in two renderers: `wrapUntrusted` (a nonce-fenced block, what the MCP server
 *   serves) and `delimit` (a fixed-sentinel block with a richer neutraliser and a
 *   length cap), plus the `untrusted` node tagging they pair with.
 *
 * The public injection corpus that tests both is data in `corpus/`, loaded with
 * `@seamline/security/corpus`. This entry point has no file-system access.
 *
 * This package depends on `@seamline/ontology` only. `@seamline/core` re-exports
 * the redactor and the `delimit` family from here, so existing importers of
 * `@seamline/core` keep working.
 */

export {
  ENTROPY_MAX_LENGTH,
  ENTROPY_MIN_LENGTH,
  ENTROPY_THRESHOLD,
  ENTROPY_TOKEN_RE,
  KNOWN_ENCODING_PREFIXES,
  classifyToken,
  isCasedIdentifier,
  sequentialRunRatio,
  shannonEntropy,
} from './entropy.ts';
export type { EntropyRejection, EntropyVerdict } from './entropy.ts';

export {
  REDACTION_MARKER_RE,
  REDACTION_PREFIX,
  REDACTION_SUFFIX,
  SECRET_RULES,
} from './patterns.ts';
export type { SecretRule } from './patterns.ts';

export {
  ENTROPY_RULE_ID,
  LOCATOR_PROP_KEYS,
  RedactionError,
  createRedactor,
  redactGraph,
  redactionRef,
} from './redactor.ts';
export type {
  RedactedGraph,
  RedactionFinding,
  RedactionReport,
  RedactionRuleSummary,
  Redactor,
  RedactorOptions,
} from './redactor.ts';

export {
  DEFAULT_MAX_CHARS,
  NEUTRALISATION_RULES,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  UNTRUSTED_SENTINEL,
  UNTRUSTED_SOURCES,
  delimit,
  delimitForAgent,
  isUntrusted,
  neutraliseUntrusted,
  neutralizeUntrusted,
  renderNodeField,
  tagUntrusted,
  tagUntrustedNodes,
} from './untrusted.ts';
export type {
  DelimitOptions,
  DelimitedResult,
  NeutralisationHit,
  NeutralisationRule,
  NeutralisedText,
  NeutraliseOptions,
  UntrustedSource,
} from './untrusted.ts';

export {
  NEUTRALIZED,
  UNTRUSTED_CLOSE_TOKEN,
  UNTRUSTED_OPEN_TOKEN,
  UNTRUSTED_PREAMBLE,
  attemptedEscape,
  makeNonce,
  neutralize,
  wrapUntrusted,
} from './fence.ts';

export { printable, printableLines, terminalText } from './printable.ts';
