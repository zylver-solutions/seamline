/**
 * The wedge: infer the cross-domain join from extracted facts, with zero
 * declarations (design v3 §1).
 *
 * Input is a `GraphView` holding `Column` nodes from `extract-data`, `CodeField`
 * nodes from `extract-code-ts` and `SchemaProperty` nodes from
 * `extract-contracts`. Output is a sorted, deterministic set of `INFERRED`
 * edges plus an explicit record of everything that was too ambiguous to emit.
 *
 * ## The four passes
 *
 *   1. `MAPS_TO_FIELD`  Column      -> CodeField
 *   2. `EXPOSED_AS`     CodeField   -> SchemaProperty
 *   3. `EXPOSED_AS`     Column      -> SchemaProperty, and its inverse
 *      `BACKED_BY`      SchemaProperty -> Column
 *   4. `VALIDATED_BY`   CodeField | SchemaProperty | Column -> Symbol
 *
 * Pass 3 runs after 1 and 2 so it can use them as transitive corroboration: a
 * column that maps to a field which is exposed as a property is very likely the
 * property's backing column. That corroboration is *evidence* only - the pair
 * still has to clear the name and container gates on its own, so a wrong hop in
 * pass 1 cannot conjure a pass-3 edge out of nothing.
 *
 * Passes 1-3 treat the relation as exclusive (at most one target per source);
 * pass 4 does not, because one validator legitimately validates many fields.
 *
 * ## Candidate generation
 *
 * Scoring every source against every target is quadratic in repository size and
 * unnecessary. Targets are indexed by name key and by container key, and a
 * source only ever meets targets that share one of those. The container gate in
 * `score.ts` then does the real filtering. This is what keeps the matcher from
 * joining `id` to every `id` in the codebase.
 */

import type {
  EdgeKind, ExtractorResult, ExtractorStatus, GraphView, NodeId, SeamlineEdge,
} from '@seamline/ontology';
import type { AmbiguityRecord, Candidate, Decision } from './ambiguity.ts';
import { resolveCandidates } from './ambiguity.ts';
import type { Facet } from './facets.ts';
import { customFacet, eligibleForAutomaticJoin, facetFor, facetsOfKind } from './facets.ts';
import type { SignalWeights, Thresholds } from './score.ts';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, normalizeWeights, scorePair } from './score.ts';
import type { StructureIndex } from './structure.ts';
import {
  buildStructureIndex, corroborateColumnField, corroborateColumnProperty,
  corroborateFieldProperty, corroborateValidator,
} from './structure.ts';
import {
  indexLoweredSchemas, isValidatorDecorator, isValidatorSymbol, loweredSchemaMembers, validatorMembers,
  validatorSubject,
} from './validators.ts';
import { buildEdge, finalizeEdges } from './emit.ts';
import type { PropValue } from './emit.ts';
import { normalizeType } from './typecat.ts';
import { INFER_JOIN_SCOPE, INFER_JOIN_VERSION, REQUIRED_SCOPES } from './manifest.ts';

export const MATCHER_VERSION = `infer-join/${INFER_JOIN_VERSION}`;

export interface InferJoinOptions {
  /** Run id written to `firstSeenRun`/`lastSeenRun`. Required: edges are run-scoped (v3 §2.2). */
  readonly runId: string;
  readonly weights?: Partial<SignalWeights>;
  readonly thresholds?: Partial<Thresholds>;
}

/** An ambiguity, tagged with the relation it arose in. */
export interface TaggedAmbiguity extends AmbiguityRecord {
  readonly edgeKind: EdgeKind;
}

export interface InferJoinResult {
  readonly edges: ReadonlyArray<SeamlineEdge>;
  readonly ambiguities: ReadonlyArray<TaggedAmbiguity>;
  readonly diagnostics: ReadonlyArray<string>;
  /** Required scopes whose producing extractor did not PASS (v3 §2.2). */
  readonly degradedScopes: ReadonlyArray<string>;
  readonly status: ExtractorStatus;
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

interface TargetIndex {
  readonly byName: ReadonlyMap<string, ReadonlyArray<Facet>>;
  readonly byContainer: ReadonlyMap<string, ReadonlyArray<Facet>>;
}

function buildTargetIndex(targets: ReadonlyArray<Facet>): TargetIndex {
  const byName = new Map<string, Facet[]>();
  const byContainer = new Map<string, Facet[]>();
  for (const target of targets) {
    for (const key of target.nameKeys) {
      const bucket = byName.get(key);
      if (bucket === undefined) byName.set(key, [target]);
      else bucket.push(target);
    }
    for (const key of target.containerKeys) {
      const bucket = byContainer.get(key);
      if (bucket === undefined) byContainer.set(key, [target]);
      else bucket.push(target);
    }
  }
  return { byName, byContainer };
}

function candidatesFor(source: Facet, index: TargetIndex): ReadonlyArray<Facet> {
  const seen = new Set<string>();
  const out: Facet[] = [];
  const push = (facets: ReadonlyArray<Facet> | undefined): void => {
    if (facets === undefined) return;
    for (const facet of facets) {
      const key = `${facet.id}\0${facet.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(facet);
    }
  };
  for (const key of source.containerKeys) push(index.byContainer.get(key));
  for (const key of source.nameKeys) push(index.byName.get(key));
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

interface PassOutput {
  readonly decisions: ReadonlyArray<Decision>;
  readonly ambiguities: ReadonlyArray<AmbiguityRecord>;
  readonly facetById: ReadonlyMap<NodeId, Facet>;
}

function runPass(
  sources: ReadonlyArray<Facet>,
  targets: ReadonlyArray<Facet>,
  corroborate: (source: Facet, target: Facet) => number,
  weights: SignalWeights,
  thresholds: Thresholds,
  exclusive: boolean,
): PassOutput {
  const index = buildTargetIndex(targets);
  const facetById = new Map<NodeId, Facet>();
  for (const facet of [...sources, ...targets]) {
    if (!facetById.has(facet.id)) facetById.set(facet.id, facet);
  }

  const candidates: Candidate[] = [];
  for (const source of sources) {
    // Several synthetic facets can share one target id (validator members);
    // keep only the best-scoring one per (source, target) pair.
    const bestByTarget = new Map<NodeId, Candidate>();
    for (const target of candidatesFor(source, index)) {
      if (target.id === source.id) continue;
      const score = scorePair(source, target, corroborate(source, target), weights, thresholds);
      if (!score.admissible) continue;
      const existing = bestByTarget.get(target.id);
      if (existing === undefined || score.confidence > existing.score.confidence) {
        bestByTarget.set(target.id, { src: source.id, dst: target.id, score });
      }
    }
    for (const candidate of bestByTarget.values()) candidates.push(candidate);
  }

  const resolved = resolveCandidates(candidates, thresholds, { exclusive });
  return { decisions: resolved.decisions, ambiguities: resolved.ambiguities, facetById };
}

// ---------------------------------------------------------------------------
// Edge props
// ---------------------------------------------------------------------------

function decisionProps(decision: Decision, rule: string, source: Facet, target: Facet): Record<string, PropValue> {
  const { score } = decision;
  return {
    ambiguous: decision.resolution === 'ambiguous',
    candidateCount: decision.group.length,
    contended: decision.contended,
    claimants: decision.claimants,
    dstContainer: target.container,
    dstType: target.typeCategory,
    matcher: MATCHER_VERSION,
    nameVariant: score.name.variant,
    rawScore: score.raw,
    rule,
    signalContainer: score.container,
    signalName: score.name.score,
    signalStructure: score.structure,
    signalType: score.typeSignal,
    srcContainer: source.container,
    srcType: source.typeCategory,
    typeAgreement: score.typeAgreement,
    // The flag X2_TYPE reads: this join holds on name and structure while the
    // two sides disagree about the type of the value they carry.
    typeConflict: score.typeAgreement === 'conflict',
    ...(decision.group.length > 1 ? { ambiguityGroup: decision.group.join(' ') } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function inferJoins(graph: GraphView, options: InferJoinOptions): InferJoinResult {
  const weights = normalizeWeights({ ...DEFAULT_WEIGHTS, ...options.weights });
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const { runId } = options;

  const degradedScopes = REQUIRED_SCOPES.filter((scope) => graph.scopeStatus(scope) !== 'PASS').slice().sort();
  const diagnostics: string[] = [];
  for (const scope of degradedScopes) {
    diagnostics.push(`scope ${scope} is ${graph.scopeStatus(scope)}; joins touching it are incomplete, not absent`);
  }

  const columns = facetsOfKind(graph, 'Column').filter((f) => eligibleForAutomaticJoin(graph, f));
  const properties = facetsOfKind(graph, 'SchemaProperty').filter((f) => eligibleForAutomaticJoin(graph, f));
  const index = buildStructureIndex(graph);

  // A validation schema (`PostSchema`, a Zod object) is a Symbol whose members,
  // when an extractor supplies them, are CodeFields, so its members would
  // otherwise compete with the real model's fields for every column. They are
  // excluded from the data passes on purpose: a validator member is a
  // constraint on the value, not the field that carries it. They re-enter as
  // VALIDATED_BY targets in pass 4. The SchemaProperties a contracts extractor
  // lowered from such a value do stay in the data passes, because that
  // extractor reports them as a contract in their own right; pass 4 reads them
  // as the value's members only when it declares none itself.
  const fields = facetsOfKind(graph, 'CodeField').filter((facet) => {
    if (!eligibleForAutomaticJoin(graph, facet)) return false;
    if (facet.containerId === undefined) return true;
    const owner = graph.node(facet.containerId);
    return owner === undefined || !isValidatorSymbol(owner);
  });

  const edges: SeamlineEdge[] = [];
  const ambiguities: TaggedAmbiguity[] = [];

  // -- Pass 1: Column -> CodeField -----------------------------------------
  const pass1 = runPass(
    columns, fields,
    (column, field) => corroborateColumnField(index, column, field),
    weights, thresholds, true,
  );
  const columnToFields = new Map<NodeId, Set<NodeId>>();
  for (const decision of pass1.decisions) {
    const source = pass1.facetById.get(decision.src);
    const target = pass1.facetById.get(decision.dst);
    if (source === undefined || target === undefined) continue;
    edges.push(buildEdge({
      kind: 'MAPS_TO_FIELD',
      src: source.node,
      dst: target.node,
      confidence: decision.confidence,
      props: decisionProps(decision, 'column-field', source, target),
      runId,
    }));
    const bucket = columnToFields.get(decision.src);
    if (bucket === undefined) columnToFields.set(decision.src, new Set([decision.dst]));
    else bucket.add(decision.dst);
  }
  for (const record of pass1.ambiguities) ambiguities.push({ ...record, edgeKind: 'MAPS_TO_FIELD' });

  // -- Pass 2: CodeField -> SchemaProperty ---------------------------------
  const pass2 = runPass(
    fields, properties,
    (field, property) => corroborateFieldProperty(index, field, property),
    weights, thresholds, true,
  );
  const fieldToProperties = new Map<NodeId, Set<NodeId>>();
  for (const decision of pass2.decisions) {
    const source = pass2.facetById.get(decision.src);
    const target = pass2.facetById.get(decision.dst);
    if (source === undefined || target === undefined) continue;
    edges.push(buildEdge({
      kind: 'EXPOSED_AS',
      src: source.node,
      dst: target.node,
      confidence: decision.confidence,
      props: decisionProps(decision, 'field-property', source, target),
      runId,
    }));
    const bucket = fieldToProperties.get(decision.src);
    if (bucket === undefined) fieldToProperties.set(decision.src, new Set([decision.dst]));
    else bucket.add(decision.dst);
  }
  for (const record of pass2.ambiguities) ambiguities.push({ ...record, edgeKind: 'EXPOSED_AS' });

  // -- Pass 3: Column <-> SchemaProperty -----------------------------------
  // EXPOSED_AS and BACKED_BY are the same relation read in opposite
  // directions; the ontology declares both, so one decision emits both, at
  // identical confidence.
  const pass3 = runPass(
    columns, properties,
    (column, property) => corroborateColumnProperty(index, column, property, columnToFields, fieldToProperties),
    weights, thresholds, true,
  );
  for (const decision of pass3.decisions) {
    const source = pass3.facetById.get(decision.src);
    const target = pass3.facetById.get(decision.dst);
    if (source === undefined || target === undefined) continue;
    const props = decisionProps(decision, 'column-property', source, target);
    edges.push(buildEdge({
      kind: 'EXPOSED_AS',
      src: source.node,
      dst: target.node,
      confidence: decision.confidence,
      props,
      runId,
    }));
    edges.push(buildEdge({
      kind: 'BACKED_BY',
      src: target.node,
      dst: source.node,
      confidence: decision.confidence,
      props: { ...props, inverseOf: 'EXPOSED_AS' },
      runId,
    }));
  }
  for (const record of pass3.ambiguities) {
    ambiguities.push({ ...record, edgeKind: 'EXPOSED_AS' });
    ambiguities.push({ ...record, edgeKind: 'BACKED_BY' });
  }

  // -- Pass 4: VALIDATED_BY ------------------------------------------------
  const validated = inferValidatedBy(graph, index, [...fields, ...properties, ...columns], weights, thresholds, runId);
  edges.push(...validated.edges);
  ambiguities.push(...validated.ambiguities);
  diagnostics.push(...validated.diagnostics);

  const status: ExtractorStatus = degradedScopes.length === 0 ? 'PASS' : 'UNAVAILABLE';

  return {
    edges: finalizeEdges(edges),
    ambiguities: ambiguities.slice().sort((a, b) =>
      (a.edgeKind < b.edgeKind ? -1 : a.edgeKind > b.edgeKind ? 1 : 0) ||
      (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0) ||
      (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0)),
    diagnostics: diagnostics.slice().sort(),
    degradedScopes,
    status,
  };
}

// ---------------------------------------------------------------------------
// VALIDATED_BY
// ---------------------------------------------------------------------------

/** Confidence of the decorator rule. High, because the DECORATED_WITH edge is a fact. */
export const DECORATOR_RULE_CONFIDENCE = 0.9;

interface ValidatedByOutput {
  readonly edges: ReadonlyArray<SeamlineEdge>;
  readonly ambiguities: ReadonlyArray<TaggedAmbiguity>;
  readonly diagnostics: ReadonlyArray<string>;
}

function inferValidatedBy(
  graph: GraphView,
  index: StructureIndex,
  targets: ReadonlyArray<Facet>,
  weights: SignalWeights,
  thresholds: Thresholds,
  runId: string,
): ValidatedByOutput {
  const edges: SeamlineEdge[] = [];
  const diagnostics: string[] = [];

  // R1: a validation decorator on a code field.
  for (const facet of targets) {
    if (facet.kind !== 'CodeField') continue;
    const decorators = (index.decoratorsOf.get(facet.id) ?? [])
      .filter((d) => isValidatorDecorator(d.name) && eligibleForAutomaticJoin(graph, facetFor(graph, d)))
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const decorator of decorators) {
      edges.push(buildEdge({
        kind: 'VALIDATED_BY',
        src: facet.node,
        dst: decorator,
        confidence: Math.min(DECORATOR_RULE_CONFIDENCE, thresholds.maxConfidence),
        props: {
          ambiguous: false,
          contended: false,
          decorator: decorator.name,
          matcher: MATCHER_VERSION,
          rule: 'validator-decorator',
        },
        runId,
      }));
    }
  }

  // R2: a validation schema whose members correspond to the target's fields.
  const validatorFacets: Facet[] = [];
  const lowered = indexLoweredSchemas(graph);
  // Lowered schema properties taken as a validator's members. They are the
  // validator's own shape, so they are not also targets it could validate.
  const adopted = new Set<NodeId>();
  for (const symbol of graph.nodesByKind('Symbol')) {
    if (symbol.deletedAt !== null || !isValidatorSymbol(symbol) ||
      !eligibleForAutomaticJoin(graph, customFacet({ node: symbol, name: symbol.name, container: symbol.name }))) continue;
    const subject = validatorSubject(symbol.name);
    if (subject.length === 0) continue;
    const declared = validatorMembers(graph, symbol.id);
    const members = declared.length > 0 ? declared : loweredSchemaMembers(graph, lowered, symbol);
    if (members.length === 0) {
      diagnostics.push(`validator ${symbol.id} declares no members; VALIDATED_BY not inferable from it`);
      continue;
    }
    for (const member of members) {
      if (!eligibleForAutomaticJoin(graph, facetFor(graph, member))) continue;
      if (member.kind === 'SchemaProperty') adopted.add(member.id);
      const rawType = member.props['type'];
      validatorFacets.push(customFacet({
        node: symbol,
        name: member.name,
        container: subject,
        typeCategory: normalizeType(member.props['typeCategory'] ?? rawType, member.props['format']),
        ...(typeof rawType === 'string' ? { rawType } : {}),
      }));
    }
  }

  const pass = runPass(
    targets.filter((target) => !adopted.has(target.id)), validatorFacets,
    (target, validator) => corroborateValidator(index, target, validator.node),
    weights, thresholds, false,
  );

  for (const decision of pass.decisions) {
    const source = pass.facetById.get(decision.src);
    const target = pass.facetById.get(decision.dst);
    if (source === undefined || target === undefined) continue;
    edges.push(buildEdge({
      kind: 'VALIDATED_BY',
      src: source.node,
      dst: target.node,
      confidence: decision.confidence,
      props: decisionProps(decision, 'validator-correspondence', source, target),
      runId,
    }));
  }

  return {
    edges,
    ambiguities: pass.ambiguities.map((record) => ({ ...record, edgeKind: 'VALIDATED_BY' as EdgeKind })),
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// Extractor result
// ---------------------------------------------------------------------------

/** Package an inference run as the `ExtractorResult` the host records (v3 §2.2). */
export function toExtractorResult(result: InferJoinResult, durationMs = 0): ExtractorResult {
  return {
    extractor: 'infer-join',
    version: INFER_JOIN_VERSION,
    status: result.status,
    authoritative: [{
      scope: INFER_JOIN_SCOPE,
      kinds: [],
      selector: 'MAPS_TO_FIELD|BACKED_BY|EXPOSED_AS|VALIDATED_BY',
    }],
    nodeCount: 0,
    edgeCount: result.edges.length,
    durationMs,
    diagnostics: result.diagnostics,
  };
}
