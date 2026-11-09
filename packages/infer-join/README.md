# @seamline/infer-join
> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

The zero-declaration cross-domain join: name, type, and structure matching across code, schema, and contract facts, producing `INFERRED` edges with a heuristic confidence score. This is the wedge that lets Seamline answer cross-domain questions without any hand-written annotation.

Most users should not import this directly — `seamline extract` in `@seamline/cli` runs join inference as part of the normal pipeline. Import it directly only if you are building a tool that needs to run or tune the matcher itself.

It exports:

- `INFER_JOIN_MANIFEST`, `INFER_JOIN_SCOPE`, `INFER_JOIN_VERSION`, `REQUIRED_SCOPES`, `guardProvenance` — the extractor manifest and its provenance ceiling (this extractor can never claim `EXTRACTED`).
- `DECORATOR_RULE_CONFIDENCE`, `MATCHER_VERSION`, `inferJoins`, `toExtractorResult`, and the `InferJoinOptions`, `InferJoinResult`, `TaggedAmbiguity` types — the matcher entry point.
- `DEFAULT_MAX_CHAINS`, `DEFAULT_MAX_DEPTH`, `JOIN_EDGE_KINDS`, `lineage`, `lineageBetween`, and the `LineageChain`, `LineageHop`, `LineageOptions`, `LineageResult`, `WalkDirection` types — bounded lineage traversal over inferred joins.
- `AGGREGATION_MODELS`, `DEFAULT_AGGREGATION`, `aggregateConfidence`, `pathConfidence`, `roundTo`, and the `AggregateOptions`, `AggregationModel` types — confidence aggregation along a path.
- `DEFAULT_THRESHOLDS`, `DEFAULT_WEIGHTS`, `TYPE_SIGNAL`, `calibrate`, `normalizeWeights`, `scorePair`, and the `PairScore`, `SignalWeights`, `Thresholds` types — pairwise scoring and calibration.
- `AMBIGUITY_REASONS`, `RESOLUTIONS`, `resolveCandidates`, and the `AmbiguityReason`, `AmbiguityRecord`, `Candidate`, `Decision`, `ResolutionResult`, `ResolveOptions`, `Resolution` types — ambiguous-match resolution.

**Stability tier: library surface.** Published, importable, documented as unstable below 1.0. A confidence score moving is expected as calibration improves and is not a breaking change.

Automatic name-based joins require nonempty convention/plural-normalized container equality; affixed and fuzzy container names are withheld even with permissive score thresholds or maximal structural corroboration. Field-name prefix normalization still permits `posts.post_id` to match `Post.id`. Test, fixture, mock, component and vendor paths are excluded by bounded segments and test-file suffixes, checking both member and owner paths. Extracted facts remain available. A move changes no semantic id unless it changes an identity input listed in ADR-0016. Join membership can change when a move crosses an eligibility boundary, or when existing path corroboration changes scores across a threshold or ambiguity boundary. The source fixture pins one ordinary move with stable join keys and a fixture move with unchanged semantic ids but removed joins. These conservative limits can withhold legitimate mappings; eligibility itself does not establish a stored-row role. See `docs/design/precision-boundaries.md` for detector and evaluation limits.
