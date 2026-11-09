# Seamline: the aspirational state

- **Status:** Design. Subordinate to [`docs/design/v3.md`](v3.md), which is authoritative. Where this document and v3 disagree, v3 wins and this document is wrong.
- **Date:** 2026-08-30
- **Scope:** the end state of the library **strictly inside v3's cut**. Nothing here undefers an item from v3 §9, and nothing here adds a node kind, an extractor, a lens, or a store adapter.

v3 answers *what Seamline is*. This document answers *what "finished" looks like for the thing v3 describes*, so that "finished" is a checkable condition rather than a feeling. It exists because the failure mode this project has already survived once is scope re-growth: a design that answers "what could this become" instead of "what does this owe its users". Section 6 restates the boundary in the terms a reader outside the project can check.

---

## 0. What "done" means

Seamline is done, at 1.0, when all seven of the following hold at the same time on a tagged release:

1. The ten-minute acceptance test in v3 §1 passes on a repository the maintainers did not write, with zero declarations.
2. Every published package carries a stability promise that this document names, and a consumer can tell from the package alone which tier they are in.
3. The security controls in v3 §2.5 to §2.7 are a **conformance suite an outside extractor author can run**, not an implementation detail of this repo.
4. `pnpm verify` is green on every supported Node lane, and the determinism and dogfood gates are release blockers rather than advisory checks.
5. Every published artifact carries npm provenance, and the publish pipeline verifies the artifacts it actually published.
6. The non-goals in 6A are still non-goals, and every 6B exception on the books cleared 5.3's admission test.
7. Condition 1's acceptance test has passed on at least 3 repositories the maintainers do not control, each run reported by a named person outside the maintaining organization, with the result (pass, fail, or partial) recorded in the documentation set (5.1).

Condition 7 exists because the other six are internal quality properties: a tool that meets all of them can still be declared finished by its own authors with nobody outside the project ever having depended on it. Who this is for: a maintainer of an unrelated TypeScript service who already owns a schema-to-contract drift incident of their own, most plausibly reached the same way this project already sources its adversarial review, not through a distribution effort this project does not fund. Until three such reports exist, section 0 is unsatisfied regardless of how green every gate is.

Anything else is a feature, and features are governed by v3 §9.

---

## 1. The published surface, and what it promises

### 1.1 Four tiers, and a consumer can always tell which one they are in

| Tier | What it is | Promise |
|---|---|---|
| **Agent and operator surface** | the CLI (`init`, `extract`, `why`, `check`, `export`, `diff`, `blast-radius`) and the MCP server's tool set | semver-governed. A breaking change needs a major bump and a deprecation window. |
| **Library surface** | `@seamline/core`, `@seamline/ontology`, the extractors, `@seamline/infer-join`, `@seamline/contradictions` | published, importable, and documented as **unstable below 1.0**. The exported names are curated (1.4), so a change is deliberate, but it is not yet a promise. |
| **Specification surface** | `ontology/seamline.yaml`, the canonical SIF serialization, the contradiction catalog X1 to X10 | CC-BY-4.0, versioned independently of the code, adoptable without adopting the code. Breaking the ontology requires the evolution test in v3 §7 to flag it and a major bump to carry it. |
| **Internal** | the integration test harness, the repo-root gate scripts | never published, never in a `files` allowlist, no promise of any kind. |

The line that matters is the third one. The ontology is the part of this project most likely to outlive the tooling, and it is licensed and versioned so that it can.

### 1.2 Package naming, decided differently than first drafted here

This section originally resolved on one installable name for humans (`seamline`, unscoped, carrying the CLI directly) and scoped names for everything else, reasoning that a wrapper package re-exporting `@seamline/cli` cannot reach that package's bin through its published `exports` map and is not portably resolvable across pnpm's isolated layout, npm hoisting, and Yarn PnP. That reasoning about *wrapper packages specifically* still holds — do not build one.

**The operator decided otherwise for this release: the CLI ships as `@seamline/cli`, not bare `seamline`.** The two real defects that resolution actually fixed are fixed on their own terms, independent of which name wins:

- **Documented install commands name a package that exists.** README now reads `npm install -g @seamline/cli`. `bin: {"seamline": "./dist/bin.js"}` in that package's own `package.json` already means the installed shell command is `seamline` either way — this only ever affected the *install* line, never the commands a user types afterward.
- **The publish pipeline's post-publish verification enumerates every artifact the run actually publishes and asserts provenance on each.** The reviewed list in `release.yml` includes `@seamline/security` and `@seamline/align`. Its "Verify every published package carries provenance" step audits a fresh installation of the exact release versions with lifecycle scripts disabled and rejects missing verified provenance for any listed package. See npm's [attestation verification documentation](https://docs.npmjs.com/cli/v11/commands/npm-audit/#audit-signatures).

One residual point, now resolved by a finding rather than a decision: the unscoped `seamline` name on the npm registry was unclaimed as of 2026-09-08, and `@seamline/*` are libraries, `@seamline/cli` and `@seamline/mcp` (its own `seamline-mcp` bin) are the two installable entry points — no package occupies the bare name. A live publish attempt against it that day was rejected by the registry itself (`403 Package name too similar to existing package readline`, an edit distance of 2 on an 8-character name) — npm's own anti-abuse policy blocks anyone from claiming that name, not just this organization, which closes the typosquat concern this paragraph used to flag. Tracked as checklist item C5.

### 1.3 Stability tiers, stated as what breaks a promise

For the agent and operator surface, these are breaking:

- removing or renaming a CLI command, flag, or exit code;
- changing the meaning of an exit code, including making a previously-clean condition non-zero;
- removing a field from a command's JSON output, or changing a field's type;
- removing or renaming an MCP tool, or removing or tightening one of its parameters;
- removing a contradiction code, or changing what an existing code means.

These are **not** breaking, and consumers must tolerate them:

- adding a command, a flag, an MCP tool, an output field, or a contradiction code;
- a new code firing on a repository where it previously stayed silent, because a new extraction capability gave it facts to read;
- a confidence score moving, since confidence is calibrated and recalibration is expected.

That last pair is the honest half. A contradiction detector that gains real inputs will report more, and a tool whose whole purpose is finding disagreements cannot promise that its output count never grows.

### 1.4 Every published entry point curates its exports

A package's public surface is the set of names its barrel deliberately re-exports, and nothing else. `export * from './implementation.ts'` straight through to an implementation file publishes every helper in that file, permanently, without anyone having decided to.

The end state: every published package's top-level `index.ts` lists named exports, or re-exports only from a submodule barrel that itself lists named exports. Today `@seamline/core` does this for four of its six submodules and passes two through, which is the whole cost of the pattern visible in one file: the inconsistency is invisible until a helper someone assumed was private turns out to be someone's dependency.

This is a **pre-1.0 obligation**, because it is the one class of surface mistake that a major version cannot cleanly undo. You can remove an exported name at a major bump; you cannot find out who was importing it.

### 1.5 Every published package has its own README

`npm pack` silently drops a `files` entry that matches nothing. A package whose `files` array lists `README.md` and which has no `README.md` publishes without one, with no error, and renders as a blank page on the registry. Nine of these are one command away from being published today.

The end state is one README per published package, each answering four questions in this order: what this package is, whether you should be using it directly (for most packages the answer is "use the CLI or the MCP server instead"), what it exports, and what its stability tier is. The tier line is what keeps 1.2's promise honest at the point a consumer actually reads it.

---

## 2. Security posture as a headline capability, not a section at the end

v3 §1's differentiator is the join: field-level cross-domain identity across a codebase's schema, contracts, and code, at a granularity the adjacent tools in this space do not attempt. Security is not what makes that differentiator; it is what makes the differentiator shippable. Seamline's output is a concentrated map of a codebase's attack surface, and it is served into agent context, so a join without a security spine to match would hand out a followable map of every weak point alongside a promise that the map is worth trusting. The end state treats the security spine as a **feature with a public conformance suite**, not as internal hygiene: the join is the reason to adopt Seamline, and the security posture is the reason the join is safe to run against a repository this project does not control and safe to serve into a fleet of agents that do not control it either.

### 2.1 The extractor sandbox is enforced at runtime, and provable from outside

Every extractor declares a capability manifest, and six controls are enforced against it rather than documented for it - a 1.0 release gate: no build ships while any of the six is unwired:

| Control | Enforcement |
|---|---|
| Environment | an allow-list intersected with the manifest, then a deny-pass over credential-shaped names. `HOME` is deliberately excluded, so home-directory credential stores are not reachable even by path. |
| Read paths | repo-relative declared globs, with realpath containment so a symlink cannot escape the repo root. |
| Network | denied by default and asserted at the type level, not requested politely. |
| Wallclock | an abort signal at the manifest's timeout. |
| Memory | in-process sampling with abort, and a real hard cap available via a child process limit. |
| Provenance ceiling | every emitted node and edge is gated against the manifest's declared ceiling before it reaches the store, so an inference pass cannot label a guess as extracted. |

Two properties of that list are the aspiration, beyond the controls existing:

- **The enforcement path must not be defeatable by the absence of other work.** A budget timer that only fires if something else keeps the runtime awake is not a budget. This class of defect is invisible in tests that run alongside other activity and appears only when a sandboxed task hangs alone, which is precisely when the control is load-bearing.
- **The bounded-traversal budget must stay non-elidable.** The step and time budget on the query surface counts through a callback the query planner must not be free to hoist out of the loop it is guarding. When a budget can be optimized away, it stops counting and nothing reports that it stopped.

Both are conformance tests at 1.0, not code comments.

### 2.2 Untrusted content is delimited in independent layers, and becomes its own package

Text that arrived from a third party (dependency metadata, commit messages, issue text, code comments) is tagged `untrusted` and delimited before it is rendered into an agent's context. The delimiting is layered so that no single trick defeats it: an unguessable per-response terminator so content cannot forge its own closing token, neutralization of any delimiter-shaped text regardless of case or spacing, and collapsing of bracket runs so the opening shape cannot be constructed at all. Control characters and bidirectional overrides are stripped separately.

The end state extracts this into **`@seamline/security`**, published, with three things the current interim implementation does not have:

1. a documented threat model for the delimiting specifically, distinct from the repo-level threat model;
2. a **public test corpus** of injection attempts, which outside contributors can add to, and which the package runs as its own gate;
3. a stable API, so a downstream tool that serves any of Seamline's output into a model context uses this rather than reimplementing it.

Point 2 is the one that compounds. A defense against prompt injection whose test corpus only contains attacks its own author thought of is a defense against that author.

### 2.3 The query surface stays bounded, typed, and consumer-gated

No query language, no raw query tool, no escape hatch, at any version. Depth is bounded by construction, results are capped, and a step-and-time budget bounds work even inside a single traversal. The MCP server stays stdio-only with parameterized tools until §5.3's admission test is cleared, and an externally-reachable query surface is not a feature this project grows on its own initiative.

This is the invariant most likely to be argued against by a well-meaning contributor ("just let me run one query"), and the answer is fixed: an endpoint that accepts a query language is arbitrary code execution with a friendly name, and this project's own output is the worst possible thing to point one at.

### 2.4 Export stays default-deny, and the redactor stays the sole writer

No profile, no output. There is no "export everything" flag, and adding one is a non-goal (section 6). The redactor runs post-merge as the only writer to the store, so a secret cannot enter the store through a path that skipped redaction; a matched secret becomes a reference, never a value. The canary-secret corpus that asserts this is a release gate, and grows with every reported near-miss.

### 2.5 The conformance suite is the deliverable

At 1.0, a third party writing an extractor can run a published suite that asserts their extractor: honours its declared read globs, cannot reach the network, cannot exceed its declared ceiling, terminates within its declared budget, and reports `UNAVAILABLE` rather than `PASS` when it cannot do its job. Community extractors stay in `contrib/`, unsigned by default, and refused unless explicitly enabled. A signing and trust story for community extractors is **deferred behind §5.3's admission test**; until it is cleared, "explicitly enabled by the operator" is the whole trust model and the documentation says so rather than implying more.

Status: the suite exists as `seamline conformance` and as exports of `@seamline/cli`; [`docs/conformance.md`](../conformance.md) says how to run it and what a pass does not promise, and [`docs/design/conformance-suite.md`](conformance-suite.md) is its design record. It asserts the five clauses above on generated fixtures; it adds no signing or trust story.

### 2.6 What is not promised

`THREATMODEL.md` carries the residual risks that this version does not mitigate, and that document is maintained as part of the release, not as a one-time artifact. A security posture that only lists its controls is marketing; the list of what is still exposed is what makes the control list believable.

---

## 3. Determinism and dogfood as a released quality bar

### 3.1 The gates are release blockers, and `UNAVAILABLE` is never `PASS`

Extraction is byte-reproducible: canonical serialization, repo-relative paths only, no wall-clock timestamp inside any node or edge body, and a deterministic mode that freezes the clock and normalizes emission order. The gate extracts twice and asserts byte-identical output.

The dogfood gate runs the tool on itself and diffs against a committed baseline. v3 §7 states why this one is not optional: a project selling verification that does not pass its own gate is not shippable.

The aspiration adds one rule to both: **a gate that could not run is a failed release, not a skipped check.** An extractor that reports `UNAVAILABLE` never contributes a finding, and never contributes a pass either. This is the same rule that keeps false findings out of the product, applied to the release pipeline.

### 3.2 What a release artifact carries

Every tagged release publishes, alongside the packages:

- the determinism proof for that commit (both runs' digests, and their equality);
- the dogfood baseline diff, empty or reviewed;
- a CycloneDX SBOM;
- the license allow-list gate result, including any identifier the gate did not recognize;
- provenance attestation for each published package (section 4.4).

The license gate **fails closed on an unrecognized identifier** rather than passing it through. Two allowed licenses were added to this project's allow-list only because the gate refused to guess, which is the behaviour that makes the allow-list worth having.

### 3.3 The baseline is reviewed, never regenerated to make a build pass

Regenerating a golden baseline to clear a red build converts the only regression detector in the pipeline into a formality. The end state is a documented review step: a baseline change lands in its own commit, with the reason, and never inside a change that also alters extraction behaviour.

---

## 4. Versioning, engines, and provenance

### 4.1 semver, and what 0.x actually promises

Below 1.0 the promise is narrower than semver's default reading, and stating it is better than implying it:

- **0.x minor bumps may break the library surface.** They may not break the agent and operator surface (1.3) without a note in the changelog and a deprecation shim where one is possible.
- **The ontology and the contradiction catalog are treated as already stable**, because they are the specification surface and third parties are invited to adopt them independently. A breaking ontology change requires the evolution test to flag it and a major bump on the ontology's own version to carry it.
- 1.0 is declared when section 0's seven conditions hold, not on a date.

### 4.2 Deprecation window

After 1.0: anything removed is deprecated for at least one minor release first, with the deprecation visible where the consumer will actually see it (a CLI warning on stderr, never on stdout, so JSON output stays parseable; an MCP tool description; a changelog entry). A removal with no prior deprecated release is a bug in the release process, not a judgement call.

### 4.3 engines

The supported runtime floor is declared at the root and enforced by the CI matrix across the supported lanes. The gap to close: **every published package repeats the `engines` field.** A consumer who installs one package standalone gets no version guard from the repository's root manifest, because they never see it. Repeating the field is redundant inside the monorepo and load-bearing outside it.

### 4.4 npm provenance, and the CI exception it depends on

Publishing runs from GitHub Actions specifically because **npm provenance attestation is only issuable from a cloud-hosted GitHub Actions or GitLab CI runner**. There is no self-hosted path, and the fallback (detached signatures plus an SBOM) is not verified by any npm client by default. The policy exception that permits this is scoped to open-source publishing and is recorded in `docs/adr/ADR-0008-oss-github-actions-exception.md`.

The end-state publish policy, in full:

1. every action pinned to a 40-character commit SHA, never a tag or a branch;
2. the release job holds the OIDC token permission and nothing more;
3. the git tag and the package versions must agree, checked before publish;
4. `--provenance` on the publish command;
5. publishing happens from a protected environment;
6. **after publishing, the pipeline enumerates the packages that this run actually published and asserts a verifiable attestation on each**, failing the release if any is missing (see 1.2 for why a hardcoded single name does not satisfy this);
7. an SBOM is attached to the release.

### 4.5 CHANGELOG

There is no changelog today, which is defensible for a pre-release and indefensible for a tagged one. The end state: a `CHANGELOG.md` maintained per release with a Breaking / Added / Fixed / Security split, where the Security section names the reported issue class rather than only crediting the reporter.

---

## 5. Documentation and community

### 5.1 The documentation set at 1.0

| Document | Job |
|---|---|
| `README.md` | the ten-minute path, real captured output, and an unflinching "what does not work" section. |
| Per-package `README.md` | what this package is, whether to use it directly, what it exports, and its stability tier (1.5). |
| `docs/design/v3.md` | the authoritative design. |
| This document | the end state and the promises. |
| `docs/adr/` | one record per decision that is expensive to reverse. |
| `THREATMODEL.md` | assets, boundaries, adversaries, controls, and unmitigated residual risk. |
| The council review record | what has already been argued and lost, so it is not re-argued from scratch. |
| An ontology reference | generated from the LinkML source, published under CC-BY-4.0, adoptable without the code. |
| A contradiction reference | one page per code X1 to X10: what it means, what facts it reads, what a true positive looks like, and how to fix it rather than silence it. |

The contradiction reference is the highest-leverage missing document. Every code the tool emits is a claim about the reader's codebase, and a claim with no explanation gets suppressed rather than fixed.

### 5.2 Governance and contribution

- **DCO sign-off, no CLA**, checked in CI on every pull request.
- A maintainers team of at least two people with explicit code ownership, so review is not a single point of failure.
- A published security contact and a disclosure policy with a stated response window.
- A published conduct contact.
- Reviewed contribution paths, ordered by how much context they need: a contradiction reference page, a test case for the injection corpus (2.2), a fixture repository for a detector, a `contrib/` extractor, then core. The two fixture-shaped paths carry one standing condition, stated where a contributor reads rather than only in the non-goals: the content is synthesized from scratch and is never derived from a private codebase (6A.7).

The first three are **human-owned release preconditions**. They cannot be satisfied by tooling, they block first publish, and naming them here keeps them from being discovered at tag time.

### 5.3 The only roadmap this project is allowed to have

Everything in v3 §9, and everything in §6B, is deferred behind an **admission test**, not a request, and this document does not reopen any of it by itself. "Named consumer" alone conflated two things that only coincide in the normal case: that the demand is real rather than speculative, and that somebody absorbs the false-positive triage cost a new capability creates. Organizational separateness is evidence for neither, so self-nomination without evidence is what deserves suspicion, not shared ownership. The test has three legs, all required, and no shortcut:

1. **A cited instance.** A specific commit, incident, or tracked issue in a real repository where the defect this item would address actually shipped, not a synthetic fixture and not a hypothetical. Requester identity drops out here: a real repository anywhere counts, this project's own included.
2. **A named owner.** A person who commits to running the new capability against that repository and triaging what it finds, for a stated window. Triage cost, not stated demand, is the real expense, and this leg is what a self-nomination with no evidence behind it fails to clear.
3. **The design-spec pass**, unchanged from before.

The worked example is contradiction **X5_UNWRITTEN_COLUMN** (a required column with no default that no traced write path writes). Its detector is implemented and tested against a synthetic fixture, and it cannot fire on any real repository today, because code extraction records which *table* a symbol writes and not which *columns*. Emitting column-level writes is a new extraction capability spanning several distinct write paths, so it is a v3 §9 item, not a bug fix. It stays silent rather than guessing, the README says so, and the unblock is a cited instance plus a named owner for a specific write path (raw SQL, Prisma, Drizzle, or another ORM). This is what the gate looks like when it is working: a known, documented, non-secret gap that nobody quietly closed by writing a heuristic, and that a plausible-sounding volunteer does not open on principle alone.

---

## 6. Non-goals

These are the boundary. Each one was reached by an adversarial review of an earlier, much larger design for this project, which was blocked for implementation with eleven confirmed critical findings. The thirteen items split into two classes that carry different weight, and treating them identically is itself a defect this section used to have: an invariant and a backlog item read the same way and invited the same form for opening either.

### 6A. Invariants — the admission test does not apply

These do not reopen through §5.3's admission test. For 5, the fact does not change no matter who asks: infrastructure state and plan files contain resolved secrets regardless of the requester. For 7, no requester and no cited instance can make a derived fixture stop being derived. For the rest, opening them changes what kind of tool this is or what it is safe to point at, rather than adding coverage a consumer is waiting on. Reopening any of these requires a new design-spec pass that itself gets adversarial review, the same weight that closed them the first time, not the lighter §5.3 gate.

1. **No web viewer, no hosted service, no server component, no telemetry, and no network calls.**
2. **No live introspection of databases, clusters, or cloud accounts.** Extraction reads static files. Infrastructure state and plan files are never read, at any version, because they contain resolved secrets.
3. **No query language and no raw query surface**, including through the MCP server. See 2.3.
4. **No inference feeding a gate.** Contradiction detection reads facts only. Inferred and model-suggested rows live in separate insert-only storage and never mutate the facts tables. No language model is in the extraction path or the gate path.
5. **No export by default.** There is no "export everything" profile, and `seamline-out/` stays gitignored by `init`. Aggregation makes the whole strictly more sensitive than any part.
6. **No vendored third-party code.** Implementing a published specification is fine; copying source is a license event, requires a recorded compatibility decision and notice propagation before it lands, and an allow-list gate cannot detect it because the code arrives as a copy-paste rather than a dependency.
7. **No contributed fixture, repro repository, or injection-corpus case derived from a private codebase.** Everything in the public injection corpus (2.2) and in every detector fixture repository is synthesized from scratch, or it does not go in. A minimized repro of a real contradiction in a private repository is still a published description of that repository's schema and of the disagreement sitting in it, and a contributor who has just watched the tool find something real is exactly the person most tempted to attach it. This is a whole-class refusal rather than a review step because "derived from" is not a property a reviewer can reliably see in a shrunk fixture: by the time a repro is small enough to read, the evidence of where it came from has usually been minimized away too. The rule protects contributors from this project rather than the other way round. A corpus that quietly accumulates real structure from the repositories it was tested against becomes a liability to everyone who contributed to it, and the one thing this project cannot offer is to un-publish it later.

### 6B. Deferred — behind §5.3's admission test

**A proposal that re-expands any of these is a design regression, not a feature request**, and the burden is on the proposal to clear all three legs of §5.3's admission test and pass its own design-spec review first.

1. **No platform.** Seamline joins fields across a codebase's schema, contracts, and code, and reports where they disagree. It is not a catalog, a portal, a compliance suite, or a system of record.
2. **No declaration-driven gaps.** The output is contradictions between facts the user already wrote. A report that says "you failed to annotate this" is not shipped, at any version. Gaps were measured at thousands per fresh repository, were gameable through documented escape hatches, and asserted the absence of a declaration rather than the presence of a defect. **Amended by [ADR-0014](../adr/ADR-0014-alignment-drift-classes-and-finding-packet.md):** this prohibits reporting that code, schema or a contract has no document, annotation or declaration, and it still does, at any version. It does not prohibit a non-gating report that a claim a document already makes is unsupported by implementation facts. That report (the classes Observed drift, Unexplained gap, Planned gap, Unknown and Resolved in [`alignment.md`](alignment.md)) is bounded by the claims a closed set of structural anchors and sentence templates extracts, has no suppression flag or score, and never gates.
3. **No lens gallery, no diagram catalog, no scorecards, no readiness matrix as a CI gate.** The CLI prints human-readable text, and `--json` gives JSON; CSV and Mermaid output are not implemented. A readiness gate that a substring in a test name can satisfy is worse than no gate, and any future version of it must cite authoritative evidence rather than a link's existence.
4. **No graph database.** Every traversal in the design is bounded-hop and does not justify one. Additional store adapters return only when the admission test is cleared, and only under the parity rule: two stores are "supported" only when both pass the identical traversal conformance suite.
5. **No extractor sprawl.** Three source extractors plus a git change extractor plus one inference pass. Each additional extractor is a permanent maintenance obligation in a stack the maintainers may not run, and is gated accordingly.
6. **No language support added by lowering the bar.** Join quality depends on type-checker-backed resolution. A regex-grade parser for a new language would produce confident nonsense, which is worse than the current honest silence.

---

## 7. Items that gate 1.0 and are not engineering work

Stated separately because engineering effort will not move any of them, and a plan that hides them inside a task list will slip on all of them at once:

1. A published security contact, a conduct contact, and a code-ownership team of at least two people (5.2).
2. A written provenance confirmation for the code-derivation question that this project's own license standard raises about its TypeScript extractor: not because a lift is known to have happened, but because the standard requires confirmation rather than an assumption in either direction.
3. Registry ownership of the package names in 1.2, before anything is published under them.
4. The one-way-door decisions that belong to publish time and are deliberately not made early.
5. A human review pass over every publicly tracked file for organization-identifying detail that `internal-leak-scan.mjs`'s denylist does not catch. Confirmed instances on file today: `docs/adr/ADR-0008`, `docs/adr/ADR-0004`, and `docs/design/v3.md` (its deployment-target and tooling references, plus the internal tracker id it names); an internal deployment path, found twice in `ADR-0008` and once in `v3.md` (now fixed by a concurrent stream); two stale `docs/internal/toolchain.md` references left over from the A1 path move, in `ADR-0004` and `scripts/license-gate.mjs` (now fixed); and the `seamline-xxx` internal issue-tracker ID format, cited in 14+ tracked files including production source comments (now being swept by a concurrent stream). The gate's own green run is not evidence for this class; it is a narrow denylist, not a correctness check, and this item exists so nobody reads the scan as having covered it. A council-reviewed pass fixed the instances named above (roughly a dozen files) on 2026-09-08, but this was keyword-driven, not the systematic line-by-line read every tracked file this item calls for; item 5 stays open.

---

## 8. How this document stays honest

This document is a promise ledger, and a promise ledger that drifts is worse than none. Three rules keep it checkable:

- **Every claim here is either enforced by a gate or listed in section 7 as human-owned.** A claim that is neither does not belong in this document.
- **v3 wins every conflict.** If this document describes something v3 does not permit, this document is edited, not v3.
- **Section 6B is append-only in spirit; 6A does not open through this document at all.** A 6B item leaves the list only after clearing every leg of 5.3's admission test, and with a record of the citation and the owner. A 6A item never leaves through a named consumer, cited instance, or design-spec pass at any strength; it leaves only through a new adversarial review at the weight that closed it, recorded as an edit to 6A itself. Removing either quietly is the exact failure this project already had reviewed out of it once.
