# Seamline codebase intelligence: comprehensive requirements

Status: proposed target requirements, 2026-09-09. Companion specification to [the semantic engine](semantic-engine.md). This catalog defines what comprehensive codebase intelligence needs to represent, ask and substantiate. It is not a claim that the current repository implements the catalog.

**Software intelligence is a family of first-class Seamline domain packs.** It should explain a software system from intent through implementation, verification, delivery and observed operation, with traceable evidence across repositories and time. The same engine primitives used for worlds—identity, contextual claims, timelines, events, artifacts and relationships—support this domain without forcing software into physical-world metaphors.

## 1. Current baseline and target boundary

The inspected repository has a focused starting point: TypeScript/JavaScript extraction, static data-schema and contract extraction, Git change extraction, inferred field joins, contradiction detectors, SQLite graph storage and CLI/MCP query surfaces. See [README](../../../README.md), [v3](../v3.md), [the shared contract](../../../packages/ontology/src/contract.ts), and [the TS extractor manifest](../../../packages/extract-code-ts/src/manifest.ts).

Those capabilities are the compatibility baseline, not the ceiling of the requested design. Current language support does not include equivalent Python extraction. The README explicitly identifies missing column-write evidence for X5 on real repositories. Existing node names such as `TestRun` do not by themselves establish complete test-run ingestion. Runtime/deployment facts and the wider domains below require new sources, adapters and conformance work.

Every capability must have an implementation status: `specified`, `implemented-unverified`, `verified-on-fixtures`, or `verified-on-real-inputs`, with supported sources, limitations and fixture references. Do not label a whole domain “supported” merely because its object definitions exist.

## 2. Requirements catalog

Each row defines a capability family. A supporting pack must model the named objects and relations, deliver the stated questions, and meet its evidence contract. Optional declarations can enrich answers; absence of those declarations is not automatically an error.

| ID / family | Information to model | Questions and outcomes | Evidence and limits |
|---|---|---|---|
| CI-01 Repository and workspace structure | Repositories, workspaces, packages, modules, files, generated/vendor sources, languages, submodules, source roots and ownership boundaries | What comprises this system? Which packages are built together or independently? Where is the authoritative source? | Manifest/build/project configuration plus source enumeration at a pinned revision; distinguish ignored/unreadable/unindexed files |
| CI-02 Symbols and type semantics | Definitions, references, overloads, generics, aliases, re-exports, inheritance, interfaces, annotations and resolved types | What defines this symbol? Which implementation or field does this reference mean? What changes if its type changes? | Language-aware resolution with explicit unresolved dynamic cases; never claim regex matching equals semantic resolution |
| CI-03 Control flow and behavior | Calls, dispatch, branches, guards, loops, exceptions, async continuations, cancellation and resource lifetime | What paths can reach this operation? Which guard runs first? What happens on failure? | CFG/call analysis or observed execution, labeled separately; potential paths are not proof they execute |
| CI-04 Data flow and transformations | Definitions/uses, assignments, reads/writes, serialization, transformations, sinks, sanitizers, aggregates and lineage | Where did this value come from, how is it transformed, and where can it go? | Field-sensitive paths where supported; aliasing/reflection/native boundaries remain unknown; summarize conservatively |
| CI-05 Persistence and data lifecycle | Databases, schemas, tables, columns, keys, indexes, constraints, views, ORM mappings, migrations, retention and deletion paths | Do code, contracts and storage agree? What reads/writes this field? Which data survives a deletion? | Distinguish static declarations, migration histories and actual database observations; column-write conclusions require column-write evidence |
| CI-06 APIs and inter-service contracts | Operations, routes, handlers, request/response types, validators, errors, auth requirements, pagination, versioning and client bindings | Does the implementation honor its contract? Which clients are affected by a change? | Join actual route bindings and schemas; infer matches with uncertainty; examples and documentation are not executable behavior |
| CI-07 Events, jobs and workflows | Topics, queues, producers, consumers, payloads, schedules, steps, retries, deduplication, ordering, checkpoints and compensation | What triggers this work? Can replay duplicate an effect? Where can progress stall? | Config/code bindings and execution receipts; timeout declarations alone do not prove enforcement |
| CI-08 Domain behavior and state machines | Domain types, aggregates, business events, commands, invariants, transitions, transaction boundaries and domain-to-code mappings | What does this business operation mean? Which transition changes ownership or status? Where is its invariant enforced? | Authored domain definitions plus independently extracted implementation links; naming similarity alone does not establish enforcement |
| CI-09 Product intent and requirements | Features, use cases, actors, acceptance conditions, constraints, non-goals, requirements and supersession | Why does this behavior exist? Which accepted requirement has implementation and verification evidence? | Authored intent remains normative; linking a feature to a file or test name does not prove satisfaction |
| CI-10 Architecture and boundaries | Systems, services, components, layers, dependencies, communication paths, trust boundaries and allowed dependency policies | What is the architecture? Where do observed dependencies violate an explicit boundary? | Separate declared architecture from extracted structure and runtime topology; absence of architecture annotations is not a failing gate |
| CI-11 Configuration and environments | Config keys, defaults, precedence, environment variables, flags, secret references, profiles and effective configuration | Which configuration activates this path? Why does staging differ from production? Which required input is unresolved? | Source/config plus scoped runtime observations when available; model secret references without storing secret values |
| CI-12 Dependencies and supply chain | Package versions, lock resolution, transitive dependencies, vendoring, build tools, artifact hashes, provenance and advisories | What exactly is used? Which release contains this dependency? Which findings apply to the deployed artifact? | Lockfiles/SBOM/build evidence; advisory match is evidence of relevance, not proof of reachable exploitability; source freshness explicit |
| CI-13 Build and artifact lineage | Build targets, task DAGs, inputs, outputs, compiler flags, toolchains, caches, reproducibility and generated code | How was this artifact produced? Which inputs invalidate it? Is the deployed output built from this commit? | Build receipts, hashes and provenance; declared build scripts do not prove a build ran or produced particular bytes |
| CI-14 Version control and change history | Commits, parents, diffs, renames/copies, pull requests, reviews, merges, reverts, tags and release inclusion | When and why did behavior change? Which changes reached this release? What does this revert undo? | Git object graph and review records; copy/rename matches can be inferred; commit timestamps are not causal order |
| CI-15 Tests and verification | Test definitions, fixtures, assertions, mocks, runs, results, coverage, mutation results, property checks and environments | What behavior is actually checked? Did it pass against these inputs/revision? Does a mock hide the integration risk? | Test presence, execution, coverage and behavioral assertion are different evidence levels; preserve failures, skips, flakiness and missing runs |
| CI-16 Delivery and deployment | Pipelines, stages, approvals, deployments, rollout cohorts, replicas, runtime artifacts, rollbacks and release state | What runs where? Which users receive which version? Can an incident map to a release or flag change? | Control-plane/runtime observations and artifact identity; repository `main` is not deployment evidence |
| CI-17 Infrastructure and runtime resources | Compute, services, networks, domains, storage, identity bindings, resource relationships and desired/observed state | What infrastructure does this service require? Which resources share a failure boundary? Where has desired state drifted? | IaC describes intent; control-plane discovery describes observations; unavailable access must not imply no resource exists |
| CI-18 Runtime behavior and observability | Executions, traces, spans, logs, metrics, errors, incidents, retries and correlation to code/artifacts | Which path failed? Which build served this request? What correlates with the regression? | Observed window, sampling, timestamps and instrumentation coverage; correlation is not automatically causation |
| CI-19 Security, identity and trust | Principals, roles, permissions, authn/authz checks, data sensitivity, trust crossings, findings and mitigations | Can this actor reach this sensitive operation under this configuration? Which control is demonstrated? | Explicit rule inputs and code/runtime evidence; static reachability and confirmed exploitation are different claims |
| CI-20 Performance, capacity and cost | Hot paths, complexity observations, query plans, budgets, load measurements, resource usage, provider calls and cost records | What became slower or more expensive? Which dependency dominates latency? Which budget was exceeded? | Measured workload/environment/time window and units; estimated costs/complexity remain labeled estimates |
| CI-21 Concurrency and consistency | Locks, transactions, isolation assumptions, idempotency keys, races, ordering, caches and invalidation | Can two writers lose an update? Can a retry duplicate an external effect? Is stale data observable? | Analysis assumptions plus adversarial/concurrent execution fixtures; one sequential test is not concurrency proof |
| CI-22 User interfaces and interaction flows | Routes, screens, components, state, events, forms, validation, accessibility semantics and API bindings | Which user action triggers this backend path? Does the whole user journey work and remain accessible? | Component source plus actual browser/device observations; HTTP 200 or DOM presence is not proof of visible usable UI |
| CI-23 Documentation and decisions | Documents, ADRs, claims, authorship, source citations, versions, deprecation, alternatives and decisions | Which decision explains this design? Which documentation claim conflicts with current behavior? | Documents remain attributable statements; extract claims conservatively; approved decisions can be superseded |
| CI-24 People and operational responsibility | Teams, maintainers, CODEOWNERS, review roles, service responsibility and escalation mappings | Who is responsible for changing or operating this capability? Are two ownership sources inconsistent? | Declared responsibility is distinct from Git authorship or file-edit frequency; protect personal data |
| CI-25 AI and agent systems | Prompts, model/config revisions, tools, permissions, memory sources, context assembly, generations, evaluations and cost | Which inputs/tools produced this output? Which prompt change caused an evaluated regression? Can a tool exceed its intended scope? | Generation receipts, prompt/input hashes, tool traces and eval results; preserve stochasticity and unavailable provider details |
| CI-26 Compatibility and evolution | Schema/API/profile versions, deprecated contracts, migration maps, rollout order and compatibility constraints | Can these two versions interoperate? Is rolling deployment safe? What information would migration lose? | Directional reader/writer compatibility and explicit assumptions; syntactically valid JSON alone is insufficient |
| CI-27 Cross-repository system joins | Client/server bindings, shared packages, schemas, generated clients, build dependencies and deployed version associations | How does a change in repository A affect B and the deployed system? | Pinned revisions for every repository and artifact; same name across repos is a candidate, not automatic identity |
| CI-28 Impact, investigation and repair planning | Dependency paths, affected capabilities, candidate tests, risk evidence, proposed changes and outcomes | What might break? What should we inspect/test first? What is a justified minimal repair? | Explain graph paths and unknown boundaries; suggestions remain proposals; observed test outcomes validate repairs rather than intention |

## 3. Cross-domain joins are the main value

An extensive vocabulary alone does not create intelligence. The engine needs explicit, inspectable mappings between the domains above. These chains are required examples:

```text
Requirement → domain command → handler → symbol → field write
            → persistence constraint → behavioral test → test-run result

UI action → client operation → API route → authentication/authorization
          → business command → transaction → emitted event → consumer

Commit → source tree → build inputs → artifact hash → deployment
       → runtime instance → observed trace → incident interval

Column → ORM field → serializer → response property → generated client
       → UI usage → affected user journey

Prompt revision → context sources → model/tool configuration → generation
                → evaluation case → observed score/failure → release decision
```

Each arrow needs a declared signature and an evidence source. Some mappings are extracted, some inferred, some authored. Traversal must preserve that difference and uncertainty through the answer. A missing arrow can be unknown rather than a defect; a contradictory pair of facts can support a finding when their contexts are comparable.

For the present repositories, a named early chain is:

`Seamline world command schema → TypeScript reducer → Python client payload → bot state projection → Atelier shot binding → export contract`.

A contract fixture can test payload compatibility without pretending Python source has been semantically indexed. Later Python extraction improves navigation and impact analysis independently of runtime integration.

## 4. Common evidence contract

Every source adapter or analysis pass declares:

- Supported language/framework/source versions and artifact formats.
- Source revision, relevant configuration and observation time/window.
- Authoritative scope, kinds/relationships/properties covered and known exclusions.
- Completeness: complete within scope, partial, unavailable, failed or stale.
- Origin/provenance ceiling, identity resolution method and confidence semantics.
- Resource limits, read/network capabilities, incremental invalidation and deletion behavior.
- Output schemas, deterministic serialization rules and conformance fixtures.

Completeness must be property-level where needed. An extractor can establish a table write while leaving column writes unknown. A trace can establish an invocation without exposing its payload. A tests adapter can know a test failed while coverage is unavailable. Collapsing these into one project-wide green/red status discards critical information.

Freshness requirements depend on the question. Immutable source facts pinned to a commit do not expire because a week passed. A current deployment observation may become stale quickly. A historical query uses the appropriate retained evidence, not whichever artifact was indexed most recently.

Origin, authority, confidence and correspondence certainty stay separate. “The source literally declares this” is an extracted fact about the source; it may contradict observed runtime behavior without either record being deleted. An inferred identity join must not silently turn two unrelated fields into one entity.

## 5. Required query and agent experiences

Expose typed, bounded operations with understandable answers:

| Operation | Required answer |
|---|---|
| Explore | Relevant objects, definitions and relations at a selected revision/context, with coverage |
| Explain | Claim, source anchors, derivation path, authority, assumptions and unknowns |
| Trace | Value/call/event/deployment lineage across declared supported boundaries |
| Compare | Source vs source, desired vs observed, environment vs environment, or branch vs branch with matching semantics |
| Impact | Candidate affected consumers and verification targets, ranked by evidence and path relevance |
| Verify | Rule-specific satisfied/violated/unknown/not-applicable, with actual evidence |
| Investigate | A navigable causal hypothesis with supporting/conflicting observations; no unsupported certainty |
| Assemble context | Minimal useful source/evidence bundle under a token budget, with omitted-scope manifest |
| Propose | Candidate mapping, repair, domain definition or command, held outside accepted facts until adoption |

Source citations must identify the revision and stable object plus file/line/span where relevant; moving a file must not silently redirect a historical citation to unrelated current content. Model-facing responses separate untrusted source text from executable instructions. Sensitive source bodies are not automatically included in broad graph traversals.

Graph, text, symbol and vector retrieval can cooperate. Exact identity and structured dependencies should lead when known; semantic search can discover candidates. Search similarity cannot authorize a mutation, establish field identity, or prove requirements coverage.

## 6. Verification semantics

Maintain three distinct assessment categories:

1. **Contradictions:** comparable authoritative facts disagree—for example a database permits null while the mapped output contract forbids it.
2. **Explicit policy violations:** an adopted policy is violated—for example a verified dependency crosses an explicitly prohibited layer boundary.
3. **Coverage or unknowns:** the system lacks required evidence to answer—for example no runtime observation is available, or no column-level write analysis exists.

Do not turn category 3 into an error by default, and do not turn it into a pass. An organization can explicitly require evidence for a release, but the resulting block should say “required evidence unavailable,” not falsely report a code contradiction.

For behavioral verification, distinguish these levels:

`test declared → test selected → test executed → assertion evaluated → behavior demonstrated under recorded conditions`.

Coverage is a separate axis: executing a line does not prove its behavior. Passing mocked tests does not prove a production integration. A positive claim must name its fixture/workload/environment/commit. A negative claim must state the completeness that makes absence meaningful.

Static analysis findings carry assumptions and supported precision. Dynamic evidence establishes observed behavior. Formal or bounded proofs are scoped to their model. Neither the engine nor an LLM should summarize all of these as simply “verified.”

## 7. Platform obligations

Comprehensive intelligence also requires operational capabilities:

- **Incremental updates:** update affected source scopes and invalidate dependent joins/answers; avoid full re-ingestion for every edit.
- **Reproducibility:** identical pinned inputs yield equivalent canonical facts; record nondeterministic observations explicitly.
- **Polyglot evolution:** language adapters expose capabilities independently; mixed-language projects retain useful partial answers.
- **Versioned interoperability:** schemas, extractor contracts, queries and persisted data have compatibility/migration rules.
- **Multi-repository identity:** revisions are pinned per repository; generated/copied/vendored artifacts retain provenance.
- **Performance controls:** bounded work, pagination, cancellation, indexed queries, source caching and measurable latency/memory budgets.
- **Retention:** preserve useful history and explain when source artifacts or execution evidence have expired.
- **Scope enforcement:** authorize traversal, derived results, exports and source fetching consistently.
- **Robust ingestion:** failures report unavailable scopes; malformed sources cannot silently wipe unrelated data.
- **Auditability:** explain changes to claims, mappings, policies and accepted model-generated proposals.
- **Evaluation:** representative real repositories plus targeted adversarial fixtures; measure false positives, missed cases and unresolved cases separately.
- **Human correction:** accept/reject mappings and record rationale without disguising a declaration as extracted evidence.

## 8. Conformance scenarios

These tests demonstrate integrated capability rather than the existence of vocabulary:

| Scenario | Must establish | Must not falsely conclude |
|---|---|---|
| Rename a source file and re-export a symbol | Stable supported symbol identity and correct reference paths | Every similarly named symbol is the same symbol |
| Change a nullable database field | Matched contract/client effects and source evidence | Unknown column-write behavior passed validation |
| Remove a file during a partial failed extraction | Failure/unknown scope and preserved unrelated facts | Every absent result was deleted |
| Deploy an older artifact than current source | Actual deployment points to that artifact's build/source revision | Production runs `main` |
| Run a failing integration behind passing mocks | Both results with distinct environments and scopes | “Tests passed” for the complete integration |
| Retry a workflow after process failure | Persisted checkpoint, deduplicated intended effect and execution evidence | A declared idempotency key proves exactly-once external behavior |
| Follow a sensitive field across a queue boundary | Supported lineage and explicit missing boundaries | An uninstrumented downstream service cannot receive the field |
| Change an AI prompt and rerun a fixed evaluation set | Generation/evaluation lineage and measured outcome changes | A model's self-review proves improvement |
| Compare staging and production | Environment-scoped config/artifact/observation differences | Every difference is a contradiction |
| Trace a UI journey through an event consumer | Browser interaction, API, event and resulting state joined by actual evidence | A successful HTTP status proves the journey worked |

Every detector or query family requires positive, negative and unknown fixtures. Where concurrency, time, identity or migration is involved, add adversarial cases rather than merely checking returned object shape.

## 9. Implementation strategy for comprehensive coverage

The requirements catalog stays broad; implementation proceeds through demonstrable capability groups:

1. Preserve and accurately inventory the existing code/data/contract/change capabilities under the engine's profile system.
2. Deliver the shared world-state slice while using code intelligence to inspect its contracts, persistence and cross-language fixture boundaries.
3. Extend software lineage across builds, artifacts and deployments so “what runs?” has evidence separate from “what is written?”.
4. Add behavioral analysis, tests and workflow/runtime evidence around real questions in the three repositories.
5. Expand polyglot, product/domain, security, AI and operational packs using their own capability manifests and conformance suites.

These stages do not shrink the desired model or make other domains second-class. They prevent a schema catalog from being mistaken for implemented intelligence. A new domain object definition should be possible without kernel changes; a new extraction or reasoning capability still needs real implementation and evidence.

The architectural objective is one engine that can answer both **“who owned this item in this timeline?”** and **“which code, schema, test and deployed artifact establish this behavior?”**, using the same identity, context, temporal and evidence machinery with the appropriate domain semantics.
