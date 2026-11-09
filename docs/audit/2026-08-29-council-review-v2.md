# Council review of Atlas design v2

"Atlas" was this project's working name before the 2026-08-29 rename to Seamline; it is unrelated to Apache Atlas or ariga/atlas.

- **Date:** 2026-08-29
- **Artifact reviewed:** an internal predecessor design document (485 lines, 44 KB), superseded and not published in this repository
- **Mode:** Tier 2 adversarial council (`new-project`), 9 lenses, refute-by-default, Round 1
- **Consolidation rule:** a finding is CONFIRMED when >= 2 lenses raise it independently, or one lens raises it and none refutes it. Single-lens findings rebutted by another lens are downgraded to PLAUSIBLE and do not block.
- **Outcome:** **BLOCKED for implementation as written.** 11 CONFIRMED CRITICAL findings. The design proceeds only under the re-cut in `docs/design/v3.md`.

## Lenses

| Lens | Role | Verdict |
|---|---|---|
| Architect | judge | REJECT as written; salvageable by rebasing onto in-house prior art |
| Devil's advocate | refute the premise | BUILD-SMALLER (by ~95%) |
| Grill-me | unverified assumptions | Strong vocabulary survey, weak engineering specification |
| Security | adversarial | **BLOCK** — no security architecture exists |
| Data | ontology + storage | Store strategy does not survive scrutiny; lifecycle model is broken |
| Platform/SRE | operability | Operational design not production-ready |
| DevEx/product | adoption | Enterprise artifact wearing a solo-founder distribution model |
| QA | verifiability | Untestable as specified |
| Licensing | external reality | See §6 |

## 1. The finding that reframes everything

**A1 (CRITICAL, architect).** This organization already shipped an implementation of Atlas's D4 code layer, ten days before the v2 design was written, and the v2 prior-art survey (§1, 23 external projects) does not mention it.

- An internal package: 4,342 LOC across 20 TypeScript files with 7 test files and fixtures. Verified present.
- Its internal decision record — status *Proposed*, council Round 1 applied 2026-08-19, **32 findings, 2 of which REFUTED the original composition claims by direct file inspection**. Verified present.
- That decision record's "Alternatives considered" section records: *ship the original 10-stage design as scoped — **rejected by council, fatal-severity***. Atlas v2 is a strict superset of that rejected design at roughly 17x the vocabulary.

That earlier project's accepted decisions independently resolve five of the CRITICALs this council raised today. They are adopted verbatim in v3 rather than re-derived:

| Earlier internal decision | Atlas v2 defect it fixes |
|---|---|
| D6: `run_id` on every node/edge, `deleted_at` tombstoning (never hard-delete), `UNIQUE(project_id, src_id, dst_id, kind)`, explicit re-run invalidation | C2 (deletion is undefined) |
| D5: annotations table insert-only, never mutates facts; separation is structural, not convention | C6 (LLM/declared provenance is a filter you must remember) |
| D4: Postgres-native, no new extension, a tenant-id `NOT NULL` column + `FORCE ROW LEVEL SECURITY` from the first migration | C4 (store choice), C8 (no tenancy model) |
| D3: symbol resolution via type-checker-backed API, resolving through re-exports/barrels to the canonical declaration | C3 (identity), partially |
| D7: depth cap + `statement_timeout`; no externally-reachable query surface without a named consumer | C5 (unbounded query surface) |
| D1: deterministic facts layer ONLY; every further stage separately gated and requiring a *named consumer* | C1 (scope) |

An earlier internal project's own council reached, ten days earlier and on a smaller design, the same conclusion this council reached today: ship a deterministic facts layer, gate everything else on a named consumer. That is independent corroboration, not an echo.

## 2. Confirmed CRITICAL findings

Ordered by rework cost if not fixed before code.

### C1 — Platform-first sequencing is the primary defect *(architect A7/A10, devil's advocate DA-05, DevEx W-1, grill-me F6, QA F1)*
§11 freezes a 120-kind ontology and spends 14 weeks before any external user touches it, front-loading the most irreversible decision at the moment of minimum information. The counts are also wrong: §4 claims "~150 edge types" but lists **193 unique**; §12 claims 120 node kinds but §3 lists **~235**. The "core profile ~35 kinds" mitigation §12's architect demanded exists only as prose — there is no `profile` field in §3, no gated rules, and §11 phase 0 still ships all 16 domains in week one. The mitigation is calibrated against a denominator that is wrong by ~2x.

### C2 — The graph can never forget *(data D1/D2, architect A2, QA F4, grill-me)*
`GraphStore` exposes only `upsertNodes`/`upsertEdges`. AIF is append/upsert-only with no tombstone, epoch, or generation marker, and no edge identity. A node that no longer exists is never removed, so stale `VERIFIES` edges keep `atlas check` green forever and every Gap, coverage, and blast-radius answer degrades monotonically toward wrong. `REMOVED_IN` exists in §4 and is wired to nothing. Snapshot, `atlas diff`, and the suspicious-links mechanism all require a versioning primitive that does not exist.

### C3 — Node identity does not survive a rename *(architect A3, data D3, grill-me F2, QA F9, devil's advocate DA-11)*
IDs embed the file path (of the redacted shape shown in H13 below) with no alias, `SAME_AS`, or rename-detection mechanism anywhere in §3 or §4. One `git mv` orphans every edge and duplicates every symbol; every hand-written annotation, every `TESTS`/`COVERS`/`TOUCHES` edge, every stored lens, and all Gap history is invalidated. The same defect fires again at the phase-1→phase-5 tree-sitter→SCIP extractor swap. Refactoring becomes taxed by the tool that exists to make refactoring safe.

### C4 — The two-store abstraction is not implementable, and the default store does not exist *(architect A6, data D4/D5/D6, grill-me F3, devil's advocate DA-12, DevEx S-1)*
`GraphStore.cypher` cannot be implemented on two of its four named adapters: graphology has no query language, and Apache AGE requires a static `AS (col type, ...)` column list per query. AGE and an embedded engine differ in data model and openCypher coverage (MERGE idempotency, agtype coercion, variable-length paths) enough that identical lens output is not achievable — that is a compatibility project, not an adapter. Independently: **`ladybugdb`, the stated default store, returns 404 on npm under five name variants.** Separately, all 24 lenses are bounded-hop; the one unbounded workload (communities/PageRank) already routes around the primary store via a graphology/NetworkX export by §7's own plan. No lens justifies a graph database.

### C5 — No security architecture exists *(security S1–S6, devil's advocate DA-08/DA-09, grill-me, architect A9)*
A keyword sweep of all 485 lines finds **zero occurrences** of authentication, authorization, redaction, sanitization, sandboxing, rate limiting, TLS, RBAC, tenancy isolation, or prompt injection *as controls*. Every hit for `auth`, `rate_limit`, and `Boundary (trust/network/tenancy)` is a property Atlas indexes **about other systems**. Atlas models trust boundaries it does not enforce. The entire security assertion of the document is the four-word parenthetical `(values never stored)` at §3 D8, with no mechanism behind it and no `Redactor` in the §7 package list.

This matters disproportionately because of what the artifact is. §3 concentrates into one queryable file: every entry point, every endpoint's auth mode *including the null ones*, every secret reference plus the function that reads it, every pinned dependency with its CVEs, pre-computed taint source→sink paths, every IAM role, certificate expiries, image digests, the under-tested high-risk features, incident history, the on-call rotation, the ownership map, and the tenant list. **§7 instructs the user to commit it to git.**

Sub-findings, each independently confirmed:
- **S3.** "Values never stored" is unenforceable — inputs are `.env`, compose, Helm, and K8s Secrets (base64 is encoding, not encryption). §12's "index the plan, never state" is also factually wrong: Terraform *plan* files contain sensitive values, and §7 `extract-env` lists state anyway, contradicting §12.
- **S4.** Untrusted text (review comments, issue text, commit messages, dependency metadata, `# WHY:` annotations) is served verbatim to the Builder agent via `context`/`explain`. Agent-written `Lesson` nodes (D15) make an injection into *persistent memory poisoning*.
- **S5.** Third-party and Python-subprocess extractors are arbitrary code execution by design, with no sandbox, inheriting `AWS_*`, `KUBECONFIG`, and SOPS keys.
- **S6.** `lenses/*.yaml` carry raw Cypher and ADR `constraints[]` are an expression DSL — a fork PR executes them in a CI job that §5 forces to hold prod secret-store credentials.
- **S2.** The MCP server specifies no authn, authz, transport, TLS, rate limit, audit, or tenancy; `cypher` is unrestricted arbitrary query, executing *inside Postgres* on the AGE adapter.

### C6 — The needs matrix checks link presence, not truth *(devil's advocate DA-02/DA-03/DA-04, DevEx V-1/G-1, grill-me F5, QA F6)*
- **DA-03 is the sharpest finding in the review.** `VERIFIES` is satisfied by a substring in a test name (§8). `it('[F-042] works', () => expect(true).toBe(true))` clears an **error-severity CI gate**. This is a direct violation of the org's own rule 15 (*assert authoritative state, not presence*): the matrix asserts that a link exists, not that anything was verified.
- **DA-02.** Per-column and per-schema-property rules yield an estimated 3,000–4,500 day-one gaps on a modest repo, mostly `error` severity. `Gap` becomes the largest domain in the graph, zero-gap is unreachable, and the gate is therefore permanently red or permanently ignored.
- **DA-04.** Every §5 rule has an unaudited escape hatch (`technical`, `transient`, `derived`, `external`, `public`, self-set `risk_class`, `enforce: []`). Readiness can move 0.08 → 0.94 in an afternoon with zero facts changed — and then be exported as GDPR Art. 30 evidence.
- **F5.** The stated rule schema (`kind × status → required edges`) cannot express ~8 of its own rules, which need temporal windows (`>30d`), negation, property predicates (`auth declared`, `expiry > 30d`), and aggregation (`COVERS ≥ threshold(risk_class)`).

### C7 — A failed extractor is indistinguishable from a clean repo *(platform P2, architect A5)*
AIF carries no per-extractor status. When an extractor crashes, times out, or lacks credentials, the edges it would have produced are simply absent — which the rules engine reads as "the edge does not exist" and reports as a Gap. Infrastructure flakiness therefore manufactures false-positive CI failures, and, in the inverse case, a silently-skipped extractor masks real gaps. `ExtractorRun.stats` exists in §3 D16 and is consumed by no rule. An earlier internal project already solved this with PASS/FAIL/**UNAVAILABLE** status, where UNAVAILABLE is never PASS.

### C8 — The committed snapshot is a reconnaissance artifact *(security S1, devil's advocate DA-09, grill-me, architect A9)*
Aggregation makes the union strictly more sensitive than any part, and union-merge only accumulates — it never filters. There is no `sensitivity` field on `AtlasNode`, no export policy, no default-deny, and `atlas init` does not gitignore its output directory. Publishing `SecurityFinding` source→sink paths, `TAINT_FLOWS_TO`, and open `vex_status` is itself a disclosure incident, and §12 asks that lens 7 (full PII lineage) be *exported as evidence*.

### C9 — Zero-declaration value is absent, so nobody reaches the value *(devil's advocate DA-01/DA-06, DevEx V-1/W-1)*
Every high-value cross-domain edge (`REALIZED_BY`, `SATISFIES`, `VERIFIES`, `STORED_IN`, `EXPOSED_AS`) is DECLARED — hand-written by a human as an annotation. By per-lens audit, **only 5 of the 24 lenses render anything without hand-authored edges** (13 partially, 17, 18, 20, 21), and all five are already served by mature free tools. The flagship lens 7, offered as GDPR Art. 30 evidence, is 100% declared, which means the evidence is a developer's comment.

This produces an inescapable fork: annotations optional (§12's DevEx resolution) means the graph holds only extracted edges and Atlas is a worse Sourcegraph plus a worse Backstage plus a worse Cartography maintained by one person; annotations mandatory means a wall of red on day one and uninstall in week one. §11's "contributors matter in phases 4–7" is circular: contributors arrive because of value, and value arrives in phase 4.

### C10 — There is no D3→D4 edge *(grill-me F1)*
Nothing in §4 connects `Component`/`Service`/`Module` to `File`/`Function`/`Symbol`. `CONTAINS` is declared "all domains" with no domain or range. Lenses 1, 4, 5, and 13 all traverse this join, and the `Feature(shipped)` rule's "`COVERS` on realizing functions" depends on it. The single most-traversed edge in the design is missing. Raised by one lens, refuted by none, and verifiable by inspection.

### C11 — Atlas is untestable as specified, and would fail its own gate *(QA F1/F2/F3, platform P4)*
Testing is mentioned exactly once in 485 lines: `examples/` is "a sample repo with every layer populated (also the conformance test)". That is the entire strategy for 15 extractors, an ontology, a rules engine, and a query compiler. §11 has **zero test deliverables across seven phases**. The highest-risk component — core merge and ID resolution, on which everything downstream depends — has no stated invariants and no precedence rule for conflicting provenance claims. Golden-file testing is impossible without determinism controls (timestamps, absolute paths, iteration order, parallel emission are all unaddressed), and §3 puts `created_at`/`updated_at` on every node. Atlas's own needs matrix would fail Atlas at `Feature(shipped)`.

## 3. Confirmed HIGH findings

| ID | Finding | Lenses |
|---|---|---|
| H1 | Name collides with a direct semantic competitor cited in the design's own §1 (Apache Atlas), and with an `atlas` CLI binary already on many developers' PATH (Ariga). Search is the only distribution channel a solo OSS project has. | DevEx N-1, grill-me |
| H2 | No ontology versioning policy. Breaking the ontology simultaneously invalidates persisted graphs, third-party extractors, lens YAML, and needs rules, with no pin escape because the graph lives in the user's repo. §13 Q5 is the only mention. | DevEx O-1, platform P3 |
| H3 | Determinism is asserted (`atlas diff`, git merge driver, byte-identical AIF) with no defense against iteration order, timestamps, absolute paths, seed-sensitive Louvain/Leiden, parallel writes, or toolchain drift. | QA F3, platform P4 |
| H4 | Live Postgres introspection, cluster reads, and Terraform state reads have no credential, RBAC, or least-privilege design. | security S10, platform P5, architect A11 |
| H5 | ~110 of 193 edge types (~57%) are referenced by no needs rule and no lens — including `TESTS`, the only *extracted* verification edge. Every verification gate depends on `VERIFIES`, which is declared. | grill-me F7 |
| H6 | §5 uses 9+ edges outside their §4 declared range (`MITIGATES` on Adapter, `HOSTS`/`MIGRATED_BY` on Table, `EXPOSED_AS` on DomainEvent, `BOUND_TO`→Contract, ...). | grill-me F4 |
| H7 | Committing `graph.json` fails at scale: ~5M edges is ~1 GB of JSONL regenerated per commit, and union-merging a derived artifact is meaningless. | devil's advocate DA-07 |
| H8 | Lens schema has no node budget and no aggregation operator. Cytoscape cose is unusable past ~5k nodes; lens 17 is the pathological compound-layout case. "The viewer renders any lens" is a hope. | devil's advocate DA-10 |
| H9 | Six of 24 lenses need bespoke renderers no listed library provides (hexagonal, DSM, concentric rings, hierarchical edge bundling, RTM matrix, BPMN-with-lanes) — inside a 3-week phase that also carries 8 exporters, docs, and release. | grill-me F12 |
| H10 | Schedule dependency inversion: the declared MVP (phases 0–3) cannot evaluate its *only* error-severity rule, which needs `DEPLOYED_TO(prod)` and `SLO_FOR` from phase 4. | architect A4, grill-me F13 |
| H11 | XXE and `$ref` resolution give arbitrary file read and SSRF (BPMN XML, GraphML, OpenAPI, remote Helm/Kustomize bases). Stored XSS via "rendered SVG" built from PR titles and dependency names. | security S11, S12 |
| H12 | Reification is required but never designed: `CROSSES` (edge→Boundary), `PROPOSED` (AgentRun→edge), `PROJECTS` (Lens→kinds) put edges and types in node positions, which no property-graph store supports. | grill-me F10 |
| H13 | The design leaks Zylver internals that would ship verbatim into a public repo, of the shape `col:{db}.{schema}.{table}.{column}`, `env:{environment-name}`, `sym:{repo}:{path}#{Class}.{method}` — a real database/schema/table/column, a real production environment name, and a real internal source path and class name. (Redacted here; the original identifiers are not reproduced in this public document.) | DevEx Z-1 |
| H14 | 12+ extractors across Terraform, Helm, Temporal, Prisma, Playwright, OTel, and SBOM create a triage surface only the maintainer can service, in 12 stacks he does not run. Carry cost estimated 1–2 person-weeks/month, forever. | DevEx T-1, devil's advocate DA-05 |
| H15 | MIT with no declared open-core boundary lets a funded incumbent absorb the ontology and interop mappings and ship hosted first; MIT also gives no trademark hook to defend a new name. | DevEx L-1 |
| H16 | Six node-kind names are defined twice with different semantics (`Interface`, `Control`, `Policy`, `Constraint`, `Release`, `Job`); `GATED_BY` and `MEMBER_OF` are each defined twice in §4. | grill-me F14 |
| H17 | OpenLineage is miscited as lens 7's automated input. Column-level lineage is emitted in practice by Spark-class integrations, not by TypeScript/Python services on Postgres. Lens 7 therefore has no automated input at all. | data D8, grill-me F8 |
| H18 | Cartography has no documented stable JSONL output; it writes into Neo4j via its intel modules. "Write a JSONL adapter" assumes an interface that does not exist. | grill-me F9 |
| H19 | Effort understated 4–6x. Realistic MVP is 25–38 weeks against the 7 claimed. | devil's advocate DA-05 |
| H20 | Atlas indexes contributor commit activity (D14, lens 21) — personal data with no legal basis, retention policy, or pseudonymization stated. No audit log of queries or exports. | security S14 |

## 4. Process finding

§12 of v2 records council dissent and then discards it. The architect asked for a ~35-kind core profile "or adoption dies on day one" — §11 phase 0 still ships all 16 domains. The product lens dissented on D1; the resolution was to keep D1. The DevEx lens dissented on annotation burden; the resolution was a one-line `enforce: []` with no mechanics anywhere in §5. **Dissent recorded and then discarded is worse than dissent never raised**, because it produces a document that looks reviewed.

This review is therefore delivered with an explicit application record: every CONFIRMED CRITICAL is either applied in `docs/design/v3.md`, or listed in that document's "Rejected findings" section with a stated reason.

## 5. What survived refutation

Each lens was required to state what it attacked and failed to break. These are the load-bearing parts of v2 and they carry into v3 unchanged.

- **The provenance model (§2.1)** — `{EXTRACTED, INFERRED, DECLARED, LLM_SUGGESTED}` + `confidence` + `source_ref` on every edge. Attacked as bookkeeping bloat by three lenses; held every time. It is the mechanism that lets agents write to the graph without corrupting it, and nothing in the 2024–2026 AI-codebase-graph crop has it. It is buried as principle 1 and should be the headline claim. One defect: §10 promotes `LLM_SUGGESTED` to `DECLARED` via merged PR with no surviving attribution — PROV-O `wasAttributedTo` must persist through promotion.
- **"Registries are the source of truth, the graph is derived" (§2.2)** — attacked as fragile; held decisively. A disposable store rebuildable from git sidesteps the CMDB-rot failure mode that killed enterprise metadata tooling, puts every trust-relevant change through PR review, and makes graph poisoning recoverable. It needs one restatement ("every node has an authoritative upstream that is not the graph") and one carve-out for human-judgment state (suspicious-link acks, `Verdict`, `Approval`, Gap suppression).
- **Field-level cross-domain traceability (§2.4, lens 7)** — attacked as over-engineering by three lenses; held every time, and the architect named it "the wedge and the MVP's center". No surveyed project joins DomainProperty → Column → SchemaProperty → CodeField → UIControl → validation → test in one traversal. Backstage stops at the component, CALM at the architecture node, DataHub has no domain or contract layer, SCIP stops at symbols. GDPR Art. 30 records fall out as a byproduct. The defect is H17 (the automated input was miscited), not the concept.
- **The license audit (§1, §9)** — attacked as compliance theater by three lenses; held every time, and was independently re-verified in part. Dropping FalkorDB for SSPLv1 before any code existed prevented a distribution defect that would have been discovered at the worst possible moment. The bundled-vs-user-installed line for EPL components, "MPL-2.0 as unmodified dependency only, with notice", and the Neo4j driver-vs-server distinction are legal nuances most projects get wrong. A CI-enforced allow-list from commit one is nearly free and is retained.
- **The needs-rule *shape* (§5)** — `kind × status → required edges (min, target kinds, condition)` as *data, not code*, with status-dependent tightening (planned → in-progress → shipped), mirrors Sphinx-Needs link validation plus Backstage scorecards. C6 and H6 are fixes to the model, not refutations of it.
- **The embedded default store is not a network-exposure finding** — embedded means no listener and no default network surface. Exposure appears only in opt-in Bolt/AGE server mode, whose auth and TLS are unspecified. That is the finding; the default is fine.
- **Modelling `pii` does not create compliance liability** — field-level lineage genuinely satisfies GDPR Art. 30. The liability is entirely in export handling (C8), not in the ontology.

## 6. Licensing and external-reality verification

The licensing lens verified every claim in §1 and §9 against sources and found v2 **wrong or stale on 14 rows**. The full record is in `docs/audit/2026-08-29-license-verification.md`; the corrections are applied in `docs/design/v3.md` §10.2.

Three findings rise to the level of the CRITICALs above:

- **L1 (CRITICAL).** §1's "adopt", "borrow", and "reuse" verbs never distinguish implementing a published format from copying source, across nine Apache-2.0 projects — and **Apache-2.0 code cannot be relicensed as MIT**. No license-checker allow-list catches this, because the offending code arrives as a copy-paste rather than as a dependency. This is the FalkorDB class of error in a subtler and harder-to-detect form. Fix: every row tagged `SPEC-COMPATIBLE` or `CODE-DERIVED`, defaulting to spec-compatible.
- **L4 (HIGH).** §7's "Leiden via graspologic (MIT)" — chosen specifically to avoid GPL `leidenalg` and `igraph` — pulls `gensim`, which is **LGPL-2.1-only**. §9's own exclusion list is violated on first install. The diligence was real; the transitive check was not done.
- **L10 (HIGH).** npm provenance attestation is issuable **only from GitHub Actions or GitLab CI on cloud-hosted runners**. Under an Argo-only CI policy the package cannot carry provenance at all. This makes the OSS CI exception load-bearing rather than cosmetic.

**Correction to a Round-1 claim.** The architect lens reported that `ladybugdb` returns 404 on npm under five name variants and inferred the project does not exist. The licensing lens, with web access, established that it **does** exist and is MIT (`LadybugDB/ladybug`, ~1,685 stars, v0.20.0 released 2026-08-29). The reconciled finding is weaker than "does not exist" but still disqualifying as a default: it is an 11-month-old fork of **Kuzu, archived 2025-10-10** after an acqui-hire, with a **bus factor of 1**, pre-1.0, and **three competing MIT forks contesting the succession**. v2's claim that it offers "Bolt server mode" is false — it is embedded-only, and upstream Kuzu never had Bolt — which orphans v2's `bolt` adapter.

Verified correct as claimed: `graphology` (MIT), `@finos/calm-cli` (Apache-2.0), D3's ISC license, and every exclusion in §9 — including **FalkorDB, still SSPLv1 in 2026**, which vindicates the v1→v2 catch.
