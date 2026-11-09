/**
 * Extractor scope names a detector may depend on.
 *
 * These strings must match the `scope` field of the `AuthoritativeScope`
 * records the v0.1 extractors declare (design v3 section 6), because
 * `GraphView.scopeStatus` is keyed by exactly that string and an unrecognized
 * scope reads as UNAVAILABLE. A typo here does not fail loudly; it makes every
 * detector that uses it permanently UNKNOWN.
 *
 * Kept in step with the producing packages, which own the canonical constants:
 *
 * | here | producer |
 * |---|---|
 * | `code.ts` | `extract-code-ts` `CODE_TS_SCOPE` |
 * | `data` | `extract-data` `DATA_SCOPE` |
 * | `contracts` | `extract-contracts` `CONTRACTS_SCOPE` |
 * | `change` | `extract-change` `CHANGE_SCOPE` |
 * | `infer-join` | `infer-join` `INFER_JOIN_SCOPE` |
 *
 * They are duplicated rather than imported because this package depends on
 * `@seamline/ontology` alone; the cross-package agreement check lives in
 * `packages/integration/src/scopes.test.ts`, which imports both sides and
 * asserts they still agree.
 */
export const SCOPE_CODE = 'code.ts';
export const SCOPE_DATA = 'data';
export const SCOPE_CONTRACTS = 'contracts';
export const SCOPE_CHANGE = 'change';
export const SCOPE_JOIN = 'infer-join';

export const SCOPES = [
  SCOPE_CODE,
  SCOPE_DATA,
  SCOPE_CONTRACTS,
  SCOPE_CHANGE,
  SCOPE_JOIN,
] as const;

export type Scope = (typeof SCOPES)[number];
