/**
 * `@seamline/contradictions` - the ten detectors of design v3 section 5.
 *
 * A contradiction is two extracted, authoritative facts that disagree. It is
 * never the absence of a declaration: that was v2's `Gap`, which a council
 * estimated at 3,000-4,500 findings on a modest repository, and whose flagship
 * rule was satisfiable by putting a substring in a test name.
 *
 * Three properties hold across every detector here:
 *
 * - **Facts only.** Both endpoints of a finding are nodes whose provenance is
 *   EXTRACTED or DECLARED. INFERRED and LLM_SUGGESTED nodes never justify one.
 * - **The join is inferred, and it is priced.** The edge connecting the two
 *   facts usually comes from `infer-join`, so its confidence multiplies through
 *   the path and caps the severity of the finding. A weak join cannot produce a
 *   loud finding, and below 0.35 it produces nothing.
 * - **A failed scope yields UNKNOWN, never a finding.** Enforced in the runner
 *   and again inside every detector, so infrastructure flakiness cannot
 *   manufacture a false failure.
 */

export {
  blockedScopes,
  compareContradictions,
  defineDetector,
  gateSeverity,
  severityCeiling,
  CONFIDENCE_FLOOR,
  SEVERITY_CONFIDENCE_FLOOR,
  SEVERITY_RANK,
  type DetectorSpec,
  type FindingDraft,
  type SeamlineDetector,
} from './detector.ts';

export {
  ALL_DETECTORS,
  DETECTORS_BY_CODE,
  x1Nullability,
  x2Type,
  x3Constraint,
  x4UnbackedProperty,
  x5UnwrittenColumn,
  x6PiiUnauthenticated,
  x7ValidatorDivergence,
  x8OrphanedMigration,
  x9ContractDrift,
  x10UntestedPiiWrite,
} from './detectors/index.ts';

export {
  runDetectors,
  summarize,
  SCOPE_NOT_PASS,
  type DetectorOutcome,
  type DetectorReport,
  type RunReport,
} from './runner.ts';

export { explain, explainReport, recoverPath } from './explain.ts';

export {
  SCOPES,
  SCOPE_CHANGE,
  SCOPE_CODE,
  SCOPE_CONTRACTS,
  SCOPE_DATA,
  SCOPE_JOIN,
  type Scope,
} from './scopes.ts';

/**
 * The fact vocabulary, exported so an extractor author can see, and test,
 * exactly which property names make a detector able to speak.
 */
export {
  CONSTRAINT_DIMENSIONS,
  TYPE_CLASSES,
  classifyContractType,
  classifyType,
  columnConstraints,
  columnHasDefault,
  columnNullable,
  columnPii,
  fieldOptional,
  isPiiColumn,
  operationAuth,
  piiWeight,
  propertyDirection,
  propertyNullable,
  propertyRequired,
  queryColumns,
  queryInsertColumns,
  queryInsertComplete,
  queryInterpolated,
  queryOperations,
  queryUpdateColumns,
  queryUpdateComplete,
  queryWrites,
  typesCompatible,
  unknownWriterTables,
  validatorConstraints,
  validatorIsEnumerated,
  type ConstraintDimension,
  type TypeClass,
} from './props.ts';

export { pathConfidence, type Joined, type JoinHop, type Step } from './graph.ts';
