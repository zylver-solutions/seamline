# Atlas v2 — Licensing + External-Reality Review (Round 1)
Reviewer lens: licensing / external reality. Method: refute-by-default, web-verified.
Date: 2026-08-30. Artifact: an internal predecessor design document (485 lines), not published in this repository.

> **Redaction note.** This document is redacted: organization-internal operational
> details (internal rule citations, internal npm-scope planning notes) have been
> removed or generalized; the third-party license research below is otherwise
> complete and unmodified. "Atlas" was this project's pre-rename working name at the
> time of this review; the project has since been renamed Seamline.

## 1. DEFAULT GRAPH STORE — LadybugDB

### Provenance
- Kuzu (Kùzu Inc., UWaterloo) GitHub repo **archived 2025-10-10**, same day v0.11.3 shipped as final release.
  https://www.theregister.com/2025/10/14/kuzudb_abandoned/
  https://biggo.com/news/202510130126_KuzuDB-embedded-graph-database-archived
- Cause: Apple acqui-hired the Kuzu team (confirmed via European Commission filing).
- Two community forks emerged: **LadybugDB** (LadybugDB/ladybug) and **bighorn** (Kineviz).
  https://thedataquarry.com/blog/from-kuzu-to-ladybug/
  https://gdotv.com/blog/kuzu-legacy-embedded-graph-database-landscape/

### LadybugDB hard facts (GitHub API, fetched 2026-08-30)
- Repo: https://github.com/LadybugDB/ladybug
- License: **MIT** (spdx_id MIT) — CLAIM CONFIRMED.
- created_at: 2025-10-07 (repo is ~11 months old as an independent project)
- stars: 1,685 | open_issues: 77 | archived: false
- pushed_at / updated_at: 2026-08-30 (actively worked on TODAY)
- Releases: v0.19.0 (2026-07-30), v0.19.1 (2026-08-04), v0.20.0 (2026-08-29).
  All three published by a single author: `adsharma`.
  https://github.com/LadybugDB/ladybug/releases

### Bus factor — THE REAL RISK
- Top-15 contributor list is dominated by the ORIGINAL Kuzu team (andyfengHKU 1238,
  acquamarin 970, ray6080 884, mewim 507, semihsalihoglu-uw 128). These are INHERITED
  git-history contributions from the fork, NOT active Ladybug maintainers — those people
  went to Apple.
- Commits since 2026-06-01: **adsharma 19, Moisan 1, Mrhs121 1**.
- Conclusion: LadybugDB is effectively a **one-maintainer project (Arun Sharma / adsharma)**
  with drive-by contributors. Bus factor = 1. Pre-1.0 (v0.20.0).

### Feature claims in §7
- "embedded" — CONFIRMED. https://docs.ladybugdb.com/
- "Cypher" — CONFIRMED (openCypher).
- "Arrow/Parquet attach" — CONFIRMED, and stronger than claimed: ATTACH for
  Parquet/Arrow/DuckDB/SQLite/Postgres with SQL pushdown. https://ladybugdb.com/
- **"Bolt server mode available" — NOT VERIFIED / LIKELY FALSE.** docs.ladybugdb.com
  documents ONLY embedded, in-process deployment: "Ladybug does not require installing any
  external dependencies or managing it as a DBMS server." No Bolt, no server mode, no Neo4j
  driver compatibility found anywhere in docs or search. Upstream Kuzu never had Bolt either.
  This matters because §7 lists a `bolt` adapter ("optional; any Bolt server") and §9/§1 say
  the Neo4j *driver* is the Apache-2.0 escape hatch. The Bolt path does not connect to the
  default store.

### Apache AGE (stated alternative)
- ACTIVE. Release 2026-01-21 (Row Level Security, index on id columns, bug fixes).
  https://age.apache.org/release-notes/
- Supports PostgreSQL 11–18; 2026 roadmap explicitly covers finalizing PG18 and moving
  master to PG18. https://github.com/apache/age/discussions/2305
- License Apache-2.0 — CONFIRMED. ASF-governed, so bus factor is structurally better
  than LadybugDB's.
- CAVEAT: AGE implements a **subset** of openCypher, not full parity with Ladybug's Cypher.
  The doc's §7 claim "Cypher (both stores)" papers over real dialect divergence
  (AGE requires cypher() function wrapping in SQL, different type system, no MATCH on
  multiple labels in the same way). Portability of lens `path_pattern` across both stores
  is NOT free.

### RECOMMENDATION
Invert the defaults. Ship **Apache AGE as the supported/default server store** and
LadybugDB as the fast embedded option, OR keep Ladybug default but (a) pin an exact
version, (b) vendor/fork-mirror it, (c) treat the GraphStore interface as a real
portability contract with a conformance suite, (d) delete the Bolt claim until verified.
Also evaluate `bighorn` (Kineviz fork) as a second escape hatch.

## 2. GRASPOLOGIC / LEIDEN — the GPL question (§7)

Doc claim: "Leiden via graspologic MIT", while §9 excludes `leidenalg`/`igraph` as GPL.

### The stated worry is UNFOUNDED — but a different, real defect sits underneath.
- graspologic's Leiden comes from `graspologic-native`, a **self-contained Rust**
  implementation (PyO3/maturin) by Microsoft Research + JHU. It does **NOT** wrap or
  vendor leidenalg, and has **no igraph dependency**.
  https://github.com/graspologic-org/graspologic-native
  https://github.com/graspologic-org/graspologic/blob/main/graspologic/partition/leiden.py
- So the GPL exclusion is NOT defeated by the Leiden algorithm itself. Good.

### BUT: graspologic transitively pulls LGPL-2.1.
- graspologic 3.4.4 `requires_dist` includes **`gensim<5.0.0,>=4.3.3`**.
  https://pypi.org/pypi/graspologic/json
- gensim license field is verbatim **"LGPL-2.1-only"**.
  https://pypi.org/pypi/gensim/json
- §9 explicitly excludes "GPL/AGPL/**LGPL**-linked libs". The doc's own recommended
  Leiden path therefore violates the doc's own allow-list, and the §9 CI
  `license-checker` gate would fail on first run.
- Mitigating nuance: Python extractors run as **subprocess plugins** (§7), so this is
  aggregation-by-process, not linking, and LGPL obligations are weak here. But the
  allow-list as WRITTEN is violated, and a naive `pip install graspologic` in the
  analyze package puts LGPL in the dependency tree and the SBOM.

### Also: graspologic release staleness
- Latest PyPI release **3.4.4, 2024-02-26** — ~2.5 years with no release.
- Repo NOT archived; pushed_at 2026-06-18. So: maintained-ish but not shipping.
- Depending on it for a headline feature (Leiden) is a supply-chain risk.

### FIX
Use `graspologic-native` directly (Rust/PyO3, no gensim), or call the Rust
`network_partitions` crate, or use graphology-communities-louvain (already chosen) and
drop Leiden from MVP. Alternatively pin graspologic with `--no-deps` + explicit deps.

## 3. NAME COLLISION — `atlas`

SEVERE. The space is saturated, including inside the doc's own prior-art table.
- **Apache Atlas** — data governance + metadata framework, Apache-2.0, 2,138 stars,
  NOT archived. Cited in the doc's OWN §1 table as prior art. Same category
  (metadata catalog / graph). Direct semantic collision.
  https://atlas.apache.org/ | https://github.com/apache/atlas
- **ariga/atlas** (atlasgo.io) — "Declarative schema migrations, schema-as-code",
  Apache-2.0 open-core, **8,690 stars**. Dominant "atlas" in dev tooling.
  https://atlasgo.io/ | https://github.com/ariga/atlas
- **MongoDB Atlas** — cloud DB service. A standalone USPTO "ATLAS" registration by
  MongoDB Inc. was **UNVERIFIED** in my search, but the mark is famous in the database
  category regardless.
- **ThoughtSpot, Inc. holds a registered ATLAS mark** (USPTO serial 88817271) —
  analytics/BI, adjacent goods. https://uspto.report/TM/88817271
  Multiple other registered ATLAS marks exist (TDC Development 97864790, Atlas Group
  86555150). The mark is crowded in software/data.
- Same-space GitHub projects: `pacifio/atlas` (source control for coding agents),
  `styler-ai/ProjectAtlas` (code graph for coding agents, token reduction),
  `syahiidkamil/Software-Engineer-AI-Agent-Atlas`, `itigges22/ATLAS`.
- npm: bare `atlas` is **TAKEN** (Apache-2.0, last publish 2017-03-20, alpha, dead but
  squatting the name). https://registry.npmjs.org/atlas

VERDICT: "Atlas" as the **OSS project name is not defensible** — it collides with a
project the design itself lists as prior art, and with an 8.7k-star tool in the same
developer-tooling category. Rename.

## 4. MPL-2.0 HANDLING (§9)

§9 allows "MPL-2.0 (unmodified dependency only, with notice)". **This reading is
CORRECT** but the doc understates the operational obligations.
Source: https://www.mozilla.org/en-US/MPL/2.0/FAQ/
- (1) File-level copyleft is correct. Copyleft attaches to the MPL-licensed FILES, not
  to your work. Q1.
- (2) The Larger Work MAY be MIT. Per Q11, "New files containing no MPL-licensed code
  are not Modifications, and therefore do not need to be distributed under the terms of
  the MPL, even if you create a Larger Work". §3.3 governs Larger Work.
- (3) Notice: §3.2(a) — recipients must be informed **where the Source Code form is
  available** and that it is available under MPL terms. §3.4 forbids removing or
  altering notices. Exhibit A headers must stay in the files.
- (4) Trigger: **distribution outside your organization**. Internal use imposes nothing.
  Shipping to npm IS distribution.
- (5) If you MODIFY an MPL file (§1.10 "Modifications"), those modified files must be
  released under MPL and you must grant §2 rights. This is what "unmodified" must mean
  operationally: **never patch vendored MPL sources**; no forked/patched copies in the
  tree; no build step that rewrites MPL files.
- OPERATIONAL GAP: the doc says "with notice" but defines no mechanism. Needs a
  generated THIRD-PARTY-NOTICES file listing each MPL dep + a source URL, plus a CI
  check that no MPL file is modified in-tree.

## 5. OSS RELEASE MECHANICS (solo maintainer)

### npm provenance — HARD CONFLICT WITH THE MAINTAINING ORGANIZATION'S CI POLICY
- npm provenance attestations are supported ONLY from **GitHub Actions** and
  **GitLab CI/CD**, and ONLY on **cloud-hosted runners**.
  https://docs.npmjs.com/generating-provenance-statements
  "To publish a package with provenance, you must build your package with a supported
  cloud CI/CD provider using a cloud-hosted runner."
- Self-hosted CI is explicitly NOT supported. Provenance is also NOT supported for
  private repos. Trusted publishing (OIDC) GA'd 2025-07-31 for GH Actions + GitLab.
  https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
- The maintaining organization's internal CI policy forbids GitHub Actions entirely
  and mandates in-cluster ArgoCD/Argo Workflows. **Argo Workflows cannot produce npm
  provenance.**
- OPTIONS: (a) use **GitLab CI/CD cloud-hosted** for the publish step ONLY — satisfies
  npm, does not use GitHub Actions, but adds a plane; (b) ship without provenance and
  compensate with Sigstore cosign signatures + a published SBOM + reproducible builds;
  (c) narrow policy exception for a publish-only GH Actions workflow. Must be an
  explicit operator decision, not discovered at release time.

### §7 internal contradiction
`packages/ci/  GitHub Action + generic runner` — the design ships a GitHub Action as a
product artifact. For OSS *consumers* that is defensible (they use GH). For the
maintaining organization's own repo it collides with the "`.github/workflows/` is a
forbidden path" rule. Resolve explicitly: build the GH Action as a deliverable for
users, but never wire it into the maintaining organization's own repo CI.

### Other mechanics
- **DCO over CLA.** For a solo maintainer + MIT, DCO (`git commit -s`, Developer
  Certificate of Origin 1.1) is the low-friction correct choice. A CLA only pays off if
  relicensing or selling an exception is a future option; it measurably depresses
  drive-by contribution. If any commercial/open-core future is contemplated, take a CLA
  from day one — retrofitting one is near-impossible.
- **SPDX headers.** Put `// SPDX-License-Identifier: MIT` at the top of every source
  file. Cheap, machine-readable, makes the §9 dogfooding gate real.
- **NOTICE file.** MIT itself needs no NOTICE. But Apache-2.0 §4(d) requires that if a
  dependency ships a NOTICE file, you **propagate its contents** in your distribution.
  With CALM, Backstage, Joern, SCIP, Cartography, OpenLineage, OpenFeature, CycloneDX,
  LinkML (Apache-2.0), ArchUnit, DataHub etc. in scope, a generated
  THIRD-PARTY-NOTICES.txt is mandatory, not optional. Generate it in CI from the SBOM.
- **SECURITY.md** + GitHub private vulnerability reporting enabled + a stated response
  SLA. For a solo maintainer, state the SLA honestly (e.g. best-effort, 90-day
  disclosure) rather than promising 24h.
- **Trademark posture.** MIT grants NO trademark rights. State plainly: "The project
  name and logo are trademarks of the maintaining organization; the code is MIT."
  Given §3, the safer move is picking a name you can actually own.

## 6. PRIOR-ART TABLE — corrections I verified directly
- **LinkML** → doc says "CC0/permissive". Reality: **Apache-2.0**
  (https://github.com/linkml/linkml). Still permissive, still allowed, but it is an
  Apache-2.0 NOTICE obligation, not a public-domain dedication. Correct the table.
- **Structurizr Lite** → doc says "Apache-2.0 (structurizr-java, Lite)". Reality:
  `structurizr/lite` is **MIT** (https://github.com/structurizr/lite). Both permissive;
  the headline license is wrong.
- **FINOS CALM** → Apache-2.0. CONFIRMED (finos/architecture-as-code).
- **CodeQL CLI** → doc excludes it on "CodeQL CLI terms". CONFIRMED and the exclusion is
  correct and important: the CodeQL CLI binary license permits use only for academic
  research, demos, OSI-licensed queries, and **Open Source Codebases**; using it in
  CI/CD or against non-open-source codebases requires a paid GitHub Advanced Security
  license. https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md
  Note this is a USER-FACING constraint too: any Atlas docs suggesting CodeQL would
  push users into a license breach.

## 7. THE KUZU SUCCESSOR IS NOT SETTLED — fork fragmentation

There are at least THREE competing MIT forks of archived Kuzu. Betting the default
store on one of them, 11 months in, is a real bet:
- **LadybugDB** (LadybugDB/ladybug) — most active; 1 real maintainer; v0.20.0;
  graph-lakehouse direction (DuckDB/Parquet/Arrow attach, SQL pushdown).
- **bighorn** (Kineviz/bighorn) — MIT; announced 2025-10-10 but "the only contribution
  provided until August 2026 being a rename of the project and a README.md update";
  new commits from 2026-08-05 described as heavily AI-assisted. Effectively dormant,
  though GraphXR now supports it embedded AND in **stand-alone server mode**.
  https://github.com/Kineviz/bighorn
- **Vela-Engineering/kuzu** (Vela Partners) — MIT; markets concurrent multi-writer
  support. https://github.com/Vela-Engineering/kuzu
- Neutral survey: https://szarnyasg.org/posts/kuzu-forks/ (Gabor Szarnyas)
- Ecosystem framing: https://gdotv.com/blog/kuzu-legacy-embedded-graph-database-landscape/

Implication: the `GraphStore` interface in §7 is doing far more load-bearing work than
the doc admits. It is the ONLY thing that makes a wrong fork bet survivable. It must
ship in Phase 1 with a conformance test suite, not be assumed.

## 8. §7 ANALYSIS LIBRARIES — verified
- `graphology-communities-louvain` **2.0.2, MIT** — CONFIRMED. Last publish 2024-12-17.
  https://registry.npmjs.org/graphology-communities-louvain
- `NetworkX` — BSD-3-Clause. CONFIRMED (PyPI metadata parse was inconclusive; license is
  BSD-3-Clause per https://github.com/networkx/networkx/blob/main/LICENSE.txt).
  Doc says "NetworkX BSD" — correct.
- `graspologic` MIT — headline license CONFIRMED, but see §2: transitively LGPL-2.1 via
  gensim, and no PyPI release since 2024-02-26.
- **`graspologic-native` 1.3.1 requires ONLY `numpy>=1.24` and `scipy>=1.10`** —
  https://pypi.org/pypi/graspologic-native/json — i.e. the clean Leiden path with no
  gensim and no igraph exists and is one dependency away. This is the recommended fix.

## 9. §6 VISUALIZATION STACK — verified (delegated deep-check)

### Wrong / stale
- **Graphviz** → doc says EPL-1.0. Reality: **EPL-2.0**, relicensed 2026-03-07
  ("Change Eclipse Public License from version 1.0 to 2.0"), shipping 14.1.5+ through
  16.0.0. The commonly-cited CPL-1.0 is two generations stale.
  https://graphviz.org/license/ | https://gitlab.com/graphviz/graphviz/-/raw/main/LICENSE
  Doc's "keep it external" decision is still CORRECT (EPL is weak copyleft).
- **ELK / elkjs** → doc says EPL-2.0. Reality: **dual "EPL-2.0 OR GPL-3.0-or-later"**
  (npm license field for elkjs 0.12.0 and master 0.13.0; LICENSE.md Exhibit A names
  GPLv3+ as secondary license).
  https://registry.npmjs.org/elkjs/latest | https://github.com/kieler/elkjs/blob/master/LICENSE.md
  Doc's exclusion is CORRECT but for a stronger reason than stated. §9's line
  "Allowed as optional, user-installed externals: EPL (Graphviz, ELK)" should say
  EPL-2.0 for both and note ELK's GPL-3.0+ secondary option.
- **dagre / dagre-d3** → doc says MIT and lists them in the bundled stack. MIT is
  correct; **both are abandoned**. `dagre` 0.8.5 published 2019-12-03 (no release in
  ~6.7y). `dagre-d3` 0.6.4 same date; last repo commit 2024-03-13; 217 open issues.
  Upstream README: "only the one in the DagreJs org is receiving updates."
  Maintained successor: **`@dagrejs/dagre` 3.1.1 (2026-08-08)**. For the D3 renderer
  there is NO maintained first-party successor (`@dagrejs/dagre-d3` is 0.5.3 from 2017);
  the live fork is **`dagre-d3-es` 7.0.14 (MIT)**, which Mermaid itself migrated to.
  https://registry.npmjs.org/dagre | https://github.com/dagrejs/dagre-d3
  This matters: lenses 7 and 15 both specify dagre layout.
- **ECharts** → Apache-2.0 correct for echarts 6.1.0, but it hard-depends on and bundles
  **zrender 6.1.0, which is BSD-3-Clause**. Allowed, but it is a separate attribution +
  no-endorsement clause the NOTICE generation must capture.
  https://registry.npmjs.org/zrender/latest

### React Flow / xyflow — MIT confirmed, with one trap
- Core is genuinely MIT today: `@xyflow/react` 12.11.5, `@xyflow/svelte` 1.6.5, legacy
  `reactflow` 11.11.4 all declare `"license":"MIT"`; monorepo LICENSE is plain MIT
  ("Copyright (c) 2019-2025 webkid GmbH"). No dual-license, no BSL.
  https://github.com/xyflow/xyflow/blob/main/LICENSE
- Attribution watermark is a **courtesy, not a license term**. The MIT text imposes no
  display obligation and `proOptions={{ hideAttribution: true }}` ships in the
  MIT-licensed source. Docs frame removal as an honor-system trade tied to a Pro
  subscription. Legally removable; ethically flagged.
  https://reactflow.dev/learn/troubleshooting/remove-attribution
- **TRAP: Pro/Team content is proprietary.** "xyflow Pro License v1.0" (updated
  2026-08-19) — perpetual non-transferable license to acquired Pro examples/templates;
  xyflow retains title; redistributing them as standalone examples/templates is
  PROHIBITED. **Never vendor a Pro example into the MIT repo.** https://xyflow.com/pro-license
- No 2025–2026 license change to the core. The 2023-12-06 "Pro Platform goes open
  source" event moved the Pro *platform* to MIT; Pro *content* license persists.

### Confirmed correct as written
Cytoscape.js (MIT 3.34.2) · Sigma.js (MIT 3.0.3) · Graphology (MIT 0.26.0) ·
**D3 = ISC — the doc is RIGHT** (d3 switched BSD-3-Clause → ISC at v7.0.0) ·
Mermaid (MIT 11.17.2) · ECharts core (Apache-2.0 6.1.0).
No recent license changes found for ECharts, Cytoscape.js, or Mermaid (confidence
MEDIUM — absence-of-announcement, not proof).

## 10. §7 RUNTIME DEPS — spot-verified via npm registry (2026-08-30)
- `neo4j-driver` **6.2.0 = Apache-2.0** — CONFIRMED. §1's "Neo4j *driver* is Apache-2.0
  and may be an optional adapter; the server is the user's choice" is CORRECT.
  https://registry.npmjs.org/neo4j-driver/latest
  BUT see §1 of this review: with LadybugDB having no Bolt server mode, the Bolt adapter
  only reaches Neo4j/Memgraph-class servers the user supplies — it is not a path to the
  default store.
- `isomorphic-git` 1.41.9 MIT · `simple-git` 3.36.0 MIT — CONFIRMED (§7 claim correct).
- `nx` 23.1.2 MIT — CONFIRMED.
- `dependency-cruiser` 18.2.0 MIT — CONFIRMED.

## 11. THE BIGGEST STRUCTURAL RISK — "Adopt / borrow / reuse" is undefined,
##     and Apache-2.0 -> MIT is a ONE-WAY DOOR THAT DOES NOT OPEN

§1's "Reuse decision" column is written in verbs that hide a licensing fork in the road:
"**Adopt** as the L2/L3 interchange format", "**Adopt vocabulary + export**",
"**Adopt traceability semantics**", "**Borrow** the environment/infra ontology and module
pattern", "**Borrow** *affected* semantics and boundary-rule DSL", "**Borrow** rule
expression shape", "**Reuse** as an extractor via adapter; **borrow** provenance tagging
and the **graph.json merge driver**".

Each of those is one of two very different acts:
- (A) **Implement an interoperable format from its public specification.** Formats,
  field names, protocols and ideas are not copyrightable. UNCONSTRAINED. Fine under MIT.
- (B) **Copy source files, JSON schemas, or a merge-driver implementation.**
  CONSTRAINED by the source license.

**You cannot relicense Apache-2.0 material as MIT.** Apache-2.0 §4 requires retaining
the license, copyright, and NOTICE, and carries a patent grant and termination clause
MIT does not have. Incorporating Apache-2.0 files into Atlas means those files stay
Apache-2.0 inside an otherwise-MIT repo, with NOTICE propagation. The reverse direction
(MIT into Apache-2.0) is the easy one; this design needs the hard one. §1 lists at least
nine Apache-2.0 sources under "adopt/borrow/reuse": CALM, Backstage, Joern, SCIP,
Cartography, OpenLineage, OpenFeature, CycloneDX, ArchUnit, DataHub/OpenMetadata/Atlas.

This is exactly the class of error §12 congratulates itself for catching once
(FalkorDB/SSPL), reappearing in a subtler form. The FalkorDB catch was about a
*dependency*; this one is about *derivation*, and no `license-checker` allow-list in §9
will detect it — a copied schema file has no package.json entry.

### REQUIRED FIX
Add a column or an explicit legend to §1 distinguishing **SPEC-COMPATIBLE
(clean-room, from published spec)** from **CODE-DERIVED (carries upstream license)**.
For every CODE-DERIVED row, keep the upstream LICENSE header in the derived file and add
it to THIRD-PARTY-NOTICES. Default every row to SPEC-COMPATIBLE and require a deliberate
decision to move one to CODE-DERIVED. Two rows that look CODE-DERIVED today and need a
ruling before Phase 0:
- Graphify's **graph.json merge driver** ("borrow" = almost certainly copy code).
- Backstage's **catalog-info.yaml entity model** (if the JSON schemas are vendored
  rather than re-expressed in LinkML).

### Adjacent spec-IPR items the doc treats as settled but are not
- **ArchiMate / The Open Group** — "ArchiMate" is a registered trademark of The Open
  Group and the specification carries its own usage terms. §1 lists the license as
  "Open Group spec" with no further detail. The doc's stance ("vocabulary alignment
  ... not implemented") is the safe one; keep it, and avoid claiming ArchiMate
  conformance or using the mark in the product name. UNVERIFIED: exact current terms.
- **OSLC (OASIS)** — §1 says "Open spec". OASIS specifications carry OASIS IPR-policy
  terms that vary by mode (RF on Limited Terms vs RAND). Reusing OSLC *verb names*
  (implements, validatedBy, satisfies) is naming, not copying, and is fine. UNVERIFIED:
  exact OSLC IPR mode.
- **W3C PROV-O** — §1 says license "W3C". PROV-O's vocabulary URIs are intended for
  reuse; the *document* is under a W3C license whose derivative-works permissions differ
  between the older W3C Document License and the newer W3C Software and Document
  License. Using the property names (`wasDerivedFrom` etc.) is fine; copying spec prose
  into docs may not be. UNVERIFIED: which W3C license variant applies to PROV-O today.
- **SPDX** — §1 pairs it with CycloneDX as "Apache-2.0 / CC-BY". SPDX is really three
  things with three licenses (the specification, the license list data, and the tools).
  Ingesting SBOMs is unaffected; embedding the SPDX license list into Atlas is the part
  that needs the right attribution. See delegated check.

## 12. Independent double-checks via PyPI (2026-08-30)
- `sphinx-needs` **8.4.0**, classifier "License :: OSI Approved :: MIT License" — MIT
  CONFIRMED. §1 row is correct.
- `linkml` **1.11.1**, `license_expression: Apache-2.0` — CONFIRMS the correction above.
  §1's "CC0/permissive" is WRONG on two independent sources (PyPI metadata + GitHub
  repo license). Apache-2.0 is still allowed by §9, but it changes the obligations:
  NOTICE propagation + patent-grant terms, not a public-domain dedication. It also
  matters because §7 makes LinkML the *generator* of the ontology package — output of a
  generator is normally not a derivative work, but the generator's own templates and any
  vendored runtime are.

## 13. EXCLUSION LIST — spot-verified (the ones most likely to have gone stale)
- **FalkorDB** → doc says SSPL. **STILL SSPLv1 as of 2026**; no license change, even
  through the 2026 C-to-Rust rewrite. §12's FalkorDB story and the §9 exclusion both
  STAND. https://github.com/FalkorDB/FalkorDB
  https://atlan.com/know/ai-agent/knowledge-graph/falkordb-graph-database-for-graphrag/
- **SurrealDB** → doc says BSL. CONFIRMED: BSL 1.1 with a 4-year change date to
  Apache-2.0. https://github.com/surrealdb/license
  NUANCE (LOW): SurrealDB's BSL explicitly permits embedding in applications you ship
  and running it internally; the only prohibition is offering it as a managed
  DBaaS. So a blanket exclusion is slightly over-broad for a *user-supplied, optional*
  adapter — though correct for anything bundled or defaulted. If the doc wants the
  option back, it belongs in the "optional, user-installed externals" line, not
  "Excluded". Same logic does NOT rescue FalkorDB (SSPL §13 is far more aggressive).
- **CodeQL CLI** → exclusion CONFIRMED CORRECT and more important than the doc conveys;
  see §6 above. Free use is limited to academic research, demos, OSI-licensed queries
  and Open Source Codebases; CI/CD use or non-open-source codebases require paid GitHub
  Advanced Security. https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md

## 14. TREE-SITTER GRAMMARS — the doc's parenthetical is a risk, not a policy

§1 says "tree-sitter + grammars | **MIT (most grammars MIT)** | ... ~100 grammars".
The word "most" is doing dangerous work. tree-sitter itself is MIT; each grammar is a
SEPARATE repository with its OWN license, and they are NOT uniformly MIT — the corpus
spans MIT, Apache-2.0, BSD, ISC, and in some community grammars, copyleft.

Evidence that this is a real, actively-managed problem in the ecosystem: curated
distributions explicitly gate on it. `tree-sitter-language-pack` (371 languages) states
it is limited to permissively licensed grammars (MIT, Apache-2.0, BSD, ISC or similar)
and that copyleft licenses (GPL, AGPL, LGPL, MPL) are NOT accepted.
https://github.com/Goldziher/tree-sitter-language-pack
Official org: https://github.com/tree-sitter-grammars/

UNVERIFIED: I did not confirm a specific GPL-licensed grammar by name. The finding is
not "grammar X is GPL"; it is that **the design has no per-grammar license gate** and
"most grammars MIT" is an assumption the §9 CI check will not catch, because grammars
are often vendored as source/WASM rather than as npm dependencies with license metadata.

### FIX
Do not depend on "most". Either (a) adopt a curated, license-gated pack such as
tree-sitter-language-pack and inherit its policy, or (b) maintain an explicit
per-grammar allow-list in the repo with the SPDX id and source URL for each grammar
shipped, enforced by the same CI gate as §9. Ship a small set (the languages this
project actually uses) rather than ~100 by default.

## 15. §1 PRIOR-ART TABLE — full delegated verification results

### CRITICAL
- **Structurizr** → doc: "Apache-2.0 (structurizr-java, Lite)". Reality: `structurizr/lite`
  is **MIT and ARCHIVED 2026-02-01**; `structurizr/java` and `structurizr/cli` also
  ARCHIVED; `structurizr/dsl` now 404s. All superseded by `structurizr/structurizr`
  (Apache-2.0) whose **`server` command requires a PAID LICENSE** for prebuilt binaries;
  on-prem and cloud are commercial.
  https://github.com/structurizr/lite/blob/master/LICENSE | https://docs.structurizr.com/
  IMPACT: lens 24 (C4 levels) and the §7 `lens` exporter "export Structurizr DSL" and
  §11 Phase 6 "exports (… Structurizr …)" all rest on archived repos. Exporting the DSL
  *text format* is still fine (format, not code), but any plan to embed or ship
  structurizr-java / Lite must be re-planned.

### HIGH
- **tree-sitter grammars** → doc: "most grammars MIT". Headline true for the core orgs,
  but **named copyleft grammars exist**: `LhKipp/tree-sitter-nu` GPL-3.0,
  `hanazuki/tree-sitter-nftables` GPL-2.0, `foxyseta/tree-sitter-prolog` **AGPL-3.0**,
  `vala-lang/tree-sitter-vala` LGPL-2.1, `alephium/tree-sitter-ralph` LGPL-3.0,
  `alaviss/tree-sitter-nim` MPL-2.0, `oxidecomputer/tree-sitter-p4` MPL-2.0.
  Confirms §14 above: vendoring grammars blind is a real exposure, and AGPL-3.0 in a
  bundled parser is the worst case in the whole design.
- **Graphify** → doc: "Apache-2.0 / MIT". Reality: **at least 3 different projects named
  graphify and MIT applies to NONE of them.** `Graphify-Labs/graphify` (ex
  `safishamsi/graphify`, code-KG for AI agents) = Apache-2.0; `kbastani/graphify`
  (Neo4j text classification) = Apache-2.0 and ARCHIVED; `neo4j-contrib/graphify` = **no
  license file at all**. The design references Graphify in 3 places (§1, §7
  `extract-graphify`, the graph.json merge driver) without saying which one.
- **CodeQL CLI** → exclusion correct; see §6/§13. Note query packs at `github/codeql`
  are MIT — a different license from the CLI binary.

### MEDIUM
- **scip-python** → doc: all SCIP indexers Apache-2.0. Reality: **scip-python is MIT**
  (Pyright fork, (c) Microsoft). Also `scip`, `scip-java`, `scip-go`, `scip-rust`
  **moved org `sourcegraph` → `scip-code`** (still Apache-2.0); `scip-typescript` stayed.
  Update all repo URLs before Phase 5.
  https://github.com/sourcegraph/scip-python/blob/main/LICENSE.txt | https://github.com/scip-code/scip-java
- **SPDX** → doc: "CC-BY". Reality: spec LICENSE is **Community Specification License
  1.0**, CC-BY-3.0 only for pre-existing non-CSL contributions; SPDX *tools*
  (`spdx/tools-java`) are Apache-2.0. https://github.com/spdx/spdx-spec/blob/development/v3.0.1/LICENSE
- **LinkML** → doc: "CC0/permissive". Reality is a **split**: `linkml/linkml` (the
  tooling you actually depend on) = **Apache-2.0**; `linkml-model` + `linkml-runtime` =
  CC0-1.0. Triple-confirmed (GitHub API, PyPI license_expression, LICENSE file).
- **Archi / ArchiMate** → doc: "Open Group spec / MIT". Archi tool MIT CONFIRMED. But
  the **ArchiMate specification is NOT open**: Open Group 90-day Evaluation /
  Non-Commercial / Commercial / Member licenses, **redistribution NOT permitted**,
  registered trademark. https://www.opengroup.org/archimate-4-evaluation-license
  The doc's "vocabulary alignment ... not implemented" stance remains correct; do not
  copy spec text or claim conformance.
- **Sourcetrail** → doc excludes as GPL. Reality: GPL-3.0 **and discontinued** — repo
  ARCHIVED, last push 2021-12-13. It is a dead project, not merely a license exclusion.

### LOW
- **Lyft Cartography** → moved to **`cartography-cncf/cartography`** (now CNCF).
  License unchanged Apache-2.0. Update the name/URL.
- **igraph** → doc groups it as "GPL". Precisely **GPL-2.0** (both C `igraph/igraph` and
  `python-igraph`); leidenalg is correctly GPL-3.0.
- **Neo4j Python driver** → Apache-2.0 **plus parts under Python Software Foundation
  License v2** (hence GitHub's NOASSERTION). Java/JS/Go/.NET drivers are clean
  Apache-2.0 (npm `neo4j-driver` 6.2.0 = Apache-2.0, verified independently).
- **OSLC** → doc: "Open spec". Precisely **CC-BY-4.0 with portions Apache-2.0**, OASIS
  Open Project, "RF on Limited Terms" IPR mode.
- **W3C PROV-O** → PROV-O REC is under **W3C Document use rules** (document license,
  NO derivative-works grant), *not* the W3C Software and Document License. Using
  property names is fine; copying spec prose is not.
- **SonarQube** → Community Build LGPL-3.0 confirmed; Server Developer/Enterprise/Data
  Center and SonarQube Cloud are proprietary/commercial.
- **Memgraph** → BSL 1.1 **plus a Memgraph Enterprise License (MEL)** on some files.
- **SurrealDB** → BSL 1.1; current text scoped to SurrealDB 3.0, Change Date
  **2030-01-01** → Apache-2.0; Additional Use Grant rewritten around a "Database
  Service" definition.
- **Nx** → MIT confirmed (23.1.2); **Nx Powerpack / Nx Cloud Enterprise are commercial**
  paid add-ons.
- **Sphinx-Needs** → MIT confirmed (8.4.0); `useblocks/sphinx-needs-enterprise` is
  **BSL 1.1** — do not pull the enterprise package in.

### CONFIRMED CORRECT AS WRITTEN
FINOS CALM · Backstage (+ community-plugins) · Sphinx-Needs core · Joern +
`ShiftLeftSecurity/codepropertygraph` · SCIP protocol + scip-typescript/java/go/rust ·
tree-sitter core · GitNexus (PolyForm Noncommercial 1.0.0) · OpenLineage · Marquez ·
OpenFeature (spec + SDKs) · CycloneDX · Nx · dependency-cruiser · ArchUnit · Archi tool ·
DataHub · OpenMetadata · Apache Atlas · OpenSLO · leidenalg (GPL-3.0) ·
jQAssistant (GPL-3.0) · FalkorDB (SSPLv1, unchanged) · Neo4j server (GPL-3.0/commercial).

### UNVERIFIED
The SPDX **License List's own** license: no standalone LICENSE file exists in
`spdx/license-list-XML` or `spdx/license-list-data`; presumed covered by the spec's
Community-Spec-1.0 / CC-BY-3.0, but no authoritative statement located. If Atlas embeds
the SPDX license list as data (likely, for the `License` node kind in D10), resolve this
before shipping.
