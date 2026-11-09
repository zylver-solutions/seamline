/**
 * `@seamline/infer-join` - the zero-declaration cross-domain join.
 *
 * Public surface only; every implementation lives in a sibling module.
 */

export {
  INFER_JOIN_MANIFEST, INFER_JOIN_SCOPE, INFER_JOIN_VERSION, REQUIRED_SCOPES, guardProvenance,
} from './manifest.ts';

export {
  DECORATOR_RULE_CONFIDENCE, MATCHER_VERSION, inferJoins, toExtractorResult,
} from './infer.ts';
export type { InferJoinOptions, InferJoinResult, TaggedAmbiguity } from './infer.ts';

export {
  DEFAULT_MAX_CHAINS, DEFAULT_MAX_DEPTH, JOIN_EDGE_KINDS, lineage, lineageBetween,
} from './lineage.ts';
export type {
  LineageChain, LineageHop, LineageOptions, LineageResult, WalkDirection,
} from './lineage.ts';

export {
  AGGREGATION_MODELS, DEFAULT_AGGREGATION, aggregateConfidence, pathConfidence, roundTo,
} from './confidence.ts';
export type { AggregateOptions, AggregationModel } from './confidence.ts';

export {
  DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, TYPE_SIGNAL, calibrate, normalizeWeights, scorePair,
} from './score.ts';
export type { PairScore, SignalWeights, Thresholds } from './score.ts';

export {
  AMBIGUITY_REASONS, RESOLUTIONS, resolveCandidates,
} from './ambiguity.ts';
export type {
  AmbiguityReason, AmbiguityRecord, Candidate, Decision, ResolutionResult, ResolveOptions, Resolution,
} from './ambiguity.ts';

export {
  ABBREVIATIONS, AFFIX_PENALTY, CONTAINER_PREFIXES, CONTAINER_SUFFIXES, FUZZY_CEILING,
  NAME_VARIANTS, canonicalKey, canonicalToken, canonicalTokens, containerCore, containerCoreKey,
  editSimilarity, expandAbbrev, jaccard, levenshtein, literalKey, matchContainer, matchName,
  matchNameInContainer, singularize, splitTokens, stripContainerPrefix,
} from './naming.ts';
export type { NameMatch, NameVariant } from './naming.ts';

export { TYPE_AGREEMENTS, TYPE_CATEGORIES, compareTypes, normalizeType } from './typecat.ts';
export type { TypeAgreement, TypeCategory } from './typecat.ts';

export { boolProp, containerFromDottedName, containerFromPointer, customFacet, facetFor, facetsOfKind } from './facets.ts';
export type { Facet } from './facets.ts';

export {
  ORM_DECORATORS, buildStructureIndex, corroborateColumnField, corroborateColumnProperty,
  corroborateFieldProperty, corroborateValidator,
} from './structure.ts';
export type { StructureIndex } from './structure.ts';

export {
  VALIDATOR_DECORATORS, VALIDATOR_LIBRARIES, isValidatorDecorator, isValidatorSymbol,
  validatorMembers, validatorSubject,
} from './validators.ts';

export { buildEdge, canonicalProps, compareEdges, finalizeEdges } from './emit.ts';
export type { BuildEdgeInput, PropValue } from './emit.ts';
