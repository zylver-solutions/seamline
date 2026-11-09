/**
 * Security surface for @seamline/core. Design v3 sections 2.5, 2.6 and 2.7.
 *
 * A 9-lens council returned BLOCK on the previous design: a keyword sweep of
 * all 485 lines of v2 found zero occurrences of authentication, authorization,
 * redaction, sanitization, sandboxing or rate limiting as controls. These are
 * the controls.
 *
 * The redactor (entropy scanning, secret rules, `createRedactor`,
 * `RedactionError`) and the untrusted-text delimiting (`delimit`, tagging) live
 * in `@seamline/security`, which has its own public injection corpus. They are
 * re-exported from here, name for name, so importers of `@seamline/core` are
 * unaffected. The store decorator (`wrapWithRedaction`), the export profiles and
 * sensitivity rules, and the extractor sandbox stay in core: each is bound to the
 * store, the export policy or the extractor manifest rather than to content.
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
} from '@seamline/security';
export type { EntropyRejection, EntropyVerdict } from '@seamline/security';

export { REDACTION_MARKER_RE, REDACTION_PREFIX, REDACTION_SUFFIX, SECRET_RULES } from '@seamline/security';
export { printable, printableLines, terminalText } from '@seamline/security';
export type { SecretRule } from '@seamline/security';

export {
  ENTROPY_RULE_ID,
  LOCATOR_PROP_KEYS,
  RedactionError,
  createRedactor,
  redactGraph,
  redactionRef,
} from '@seamline/security';
export type {
  RedactedGraph,
  RedactionFinding,
  RedactionReport,
  RedactionRuleSummary,
  Redactor,
  RedactorOptions,
} from '@seamline/security';

export { wrapWithRedaction } from './redacting-store.ts';
export type { RedactingGraphStore } from './redacting-store.ts';

export {
  SENSITIVITY_RANK,
  defaultSensitivityFor,
  effectiveEdgeSensitivity,
  effectiveSensitivity,
  isAtLeastAsRestrictive,
  kindsAtLeast,
  moreRestrictive,
  sensitivityRank,
} from './sensitivity.ts';

export {
  AUDIT_PROFILE,
  PROFILES,
  PUBLIC_PROFILE,
  TEAM_PROFILE,
  WITHHOLD_REASONS,
  applyProfile,
  getProfile,
  pairs,
  parseDeclaredProfiles,
  profileNames,
  profileView,
} from './export-policy.ts';
export {
  EXPORT_PROFILE_FIELDS,
  EXPORT_PROFILE_VERSION,
  ExportPolicyError,
  FORMAT_DOC_URL,
  LIFECYCLE_FIELDS,
  LOCATION_FIELDS,
  PACKET_KINDS,
  PRE_VERSION_FIELDS,
  PROFILE_DESCRIPTION_MAX,
  PROFILE_NAME_PATTERN,
  RECORD_FIELDS,
  parseExportProfile,
} from './export-profile.ts';
export type {
  ExportResult,
  ReleasedEdge,
  ReleasedNode,
  WithheldItem,
  WithheldSummary,
  WithholdReason,
} from './export-policy.ts';
export type { ExportProfile, PacketKind, PropAllowance, RecordField } from './export-profile.ts';

export {
  DEFAULT_HOST_LIMITS,
  DEFAULT_SAMPLE_MS,
  FORBIDDEN_ENV_PATTERNS,
  SANDBOX_BASE_ENV,
  SANDBOX_VIOLATIONS,
  SandboxViolation,
  // `globToRegExp` is deliberately NOT re-exported: merge/tombstone.ts exports a
  // helper of the same name, and both are internal utilities rather than public
  // API. The duplication is real and tracked for consolidation; exposing both
  // through one barrel would only force consumers to disambiguate a private detail.
  createAccessChecker,
  guardProvenance,
  isForbiddenEnvName,
  matchesReads,
  pathOutsideRepo,
  resolveHostLimits,
  resolveReadPath,
  runWithinBudget,
  sandboxSpawnOptions,
  scrubEnvironment,
  sealExtractorOutput,
  systemProbe,
  validateManifest,
} from './sandbox.ts';
export type {
  AccessChecker,
  AccessDecision,
  AccessIo,
  AccessKind,
  AccessPolicy,
  BudgetOptions,
  BudgetProbe,
  HostLimits,
  SandboxSpawnOptions,
  SandboxViolationCode,
  ScrubbedEnv,
  StrippedVar,
} from './sandbox.ts';

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
} from '@seamline/security';
export type {
  DelimitOptions,
  DelimitedResult,
  NeutralisationHit,
  NeutralisationRule,
  NeutralisedText,
  NeutraliseOptions,
  UntrustedSource,
} from '@seamline/security';

export {
  UNTRUSTED_GIT_CONFIG,
  spawnUntrustedGit,
  untrustedGitCommand,
  untrustedGitEnv,
} from './untrusted-git.ts';
export type { UntrustedGitCommand, UntrustedGitOptions } from './untrusted-git.ts';
