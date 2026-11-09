# ADR-0009: Determinism is a release gate, not an aspiration

- **Status:** Accepted
- **Date:** 2026-08-29
- **Design reference:** `docs/design/v3.md` §2.3, §7
- **Council findings:** C11 (CONFIRMED CRITICAL; QA F1/F2/F3, platform P4) and H3 (CONFIRMED HIGH; QA F3, platform P4).
- **Contract:** `packages/ontology/src/contract.ts` (`SeamlineNode`, `SeamlineEdge`, `SifLine`, `SIF_VERSION`)

## Context

v2 asserted determinism in three places and defended it in none. `seamline diff`, a git merge driver for the graph file, and "byte-identical output" were all promised, with no defence against iteration order, wall-clock timestamps, absolute paths, seed-sensitive community-detection algorithms, parallel writes, or toolchain drift (finding H3).

Worse, and this is the finding that makes the ADR necessary rather than merely useful: **v2 put `created_at` and `updated_at` on every node.** That single decision makes byte-identical output impossible, in principle, regardless of how carefully everything else is implemented. Two extractions of an unchanged repository differ in every row.

The consequences compound, because determinism is not a feature here; it is a precondition for the test strategy:

- **Golden-file testing is worthless without it.** v2's entire stated test strategy for 15 extractors, an ontology, a rules engine, and a query compiler was one sentence: an example repo that is "also the conformance test". C11 found zero test deliverables across seven phases.
- **`seamline diff` is meaningless without it.** If a re-extraction of an unchanged repo produces a diff, every diff is noise and the feature does nothing.
- **A merge driver is impossible without it.** Merging two nondeterministic serializations of the same graph has no defined result.
- **Rebuild-from-scratch equivalence depends on it.** ADR-0002 and ADR-0004 both rest on the claim that deleting the store and re-extracting is equivalent to incremental extraction. That claim is only checkable if both paths produce the same bytes.

The council also observed that v2's own needs matrix would have failed v2 at `Feature(shipped)`. A verification tool that cannot pass its own gate has a marketing problem and an engineering problem at the same time.

## Decision

**Byte-identical output across two consecutive runs is a CI gate that blocks release. Time belongs to the run, never to the fact.**

### 1. No wall-clock time in a node or edge body

This is the non-negotiable one, and it is enforced in the contract by omission: `SeamlineNode` and `SeamlineEdge` have **no `createdAt` and no `updatedAt`**, with the reason recorded as a comment at the declaration so it survives a reader who never opens this ADR. The ontology carries the same note.

Time lives on the `RunRecord` (`startedAt`, `finishedAt`), where it belongs: a fact is not created at a time, it is *observed* at a time, and the observation is the run. Node and edge lifecycle is expressed in run ids instead: `firstSeenRun`, `lastSeenRun`, `deletedAt`. This composes with ADR-0003 rather than fighting it, because a run id is already the lifecycle key.

Immutable source dates are data, not observation time. The existing Git history extractor emits only `Commit.props.authorDate`, `Commit.props.committerDate`, and `RENAMED_FROM.props.authorDate` as canonical second-resolution UTC ISO strings derived from Git epochs. SIF validates their commit hash and identity context as well as their textual form. This does not establish Git provenance from a hash alone; producer tests and consecutive-run byte comparisons remain required. No other timestamp-like prop, generated clock reading, or `Date` object is permitted by this exception.

### 2. Canonical SIF serialization

- Object keys sorted.
- Arrays sorted by stable id, which ADR-0002's natural keys make possible; a synthetic id would have made "stable sort order" circular.
- **Repo-relative POSIX paths only.** Never an absolute path, never a backslash. This also removes the H13 class of leak, where a design document shipped a maintainer's local paths and internal identifiers into a public repository.
- This rule covers filesystem locators. The existing `RouteHandler.props.routePath` and `Operation.props.path` are HTTP domain values, validated as literal leading-slash paths without controls, backslashes or lone surrogates, and must agree with the uppercase method and canonical identity. They are never normalized into filesystem paths. Source locations and all other path-bearing fields retain the filesystem rule.
- Fixed float formatting, and `\n` line endings.
- `SIF_VERSION` is emitted so a consumer can tell which serialization it is reading.

### 3. Determinism hygiene, stated as rules an author can follow

- No `Math.random()`.
- No unseeded iteration over a `Set` or `Map` whose insertion order depends on filesystem traversal order, which is the most common way this breaks in practice and the least visible.
- Merge must be **associative, commutative, and idempotent** over randomized orderings; this is asserted with property-based tests (`fast-check`), not spot-checked. The total provenance precedence order in ADR-0007 is what makes it achievable.
- Seed-sensitive algorithms (community detection, PageRank) run only in the in-memory graphology projection (ADR-0004) and their output is not part of canonical SIF.
- `SEAMLINE_DETERMINISTIC=1` freezes the clock and normalizes emission order, so a test can pin the small amount of legitimately time-varying data on the `Run` record.

### 3a. Run identity under `SEAMLINE_DETERMINISTIC=1`

A run id is a lifecycle key (§1), so freezing it to a constant is not free: with one id for every run, a consumer that records or compares runs cannot tell two apart, and a second run into the same store looks like a duplicate of the first. The id is therefore **derived from the run's inputs**, not frozen: `run-det-` followed by the first 16 hex digits of a SHA-256 digest (`packages/cli/src/run-id.ts`, `run-inputs.ts`). It is a function of the inputs and of nothing else, so two runs over the same tree, config and extractor versions still produce identical bytes, and runs over different inputs get different ids.

What the digest covers:

- **The content of every file under the repository root**, keyed by repo-relative POSIX path. A content digest rather than the git commit, because the tree may be dirty or not a git repository. It is all files, not only those the config's `include`/`exclude` select, because those globs bound `extract-code-ts` alone and the other extractors walk the root themselves. Left out: `.git`, `node_modules` (the lockfile and manifests stand for dependencies, which is an approximation: what is installed, and what module resolution reads from it, can change without them), the output directory, the root `seamline.config.json` (replaced by the next item), and file modes and times. A symbolic link is hashed by its target and not followed.
- **The effective config**: the repo name, `include`, `exclude`, and each run extractor's options. Export profiles, query limits and `outDir` are not extraction inputs and are not in it.
- **The extractors run, their versions and the order they run in**, which includes the `--only` selection. The order is hashed as planned (the config's order), not sorted, because an extractor reads what the earlier ones stored (`infer-join` does): the same extractors in another order can extract different facts. The keys of an extractor's options are a set and are canonicalised. An extractor that reads something the tree does not hold reports an `inputIdentity`; `extract-change` reports the commits it walks between, so two histories over identical files get different ids.
- The authoritative scopes are not hashed separately. Each is determined by the extractor, its options and the tree, all of which are covered, and they are known only after extraction, whereas the id is stamped into the facts extraction produces.

The digest errs towards covering too much. An id that changes when no extractor could have noticed costs nothing, and a changed input that changes the id gives a separate run on record. It cannot be complete: installed dependencies, the TypeScript version an extractor links, a change to Seamline's own extraction rules, and anything else outside the tree and the extractor versions can change what is extracted without changing the id. Nothing relies on it being complete, as the last paragraph of this section says.

**The id is an identity, not an order.** It says which inputs a run saw, never which run came first, and no code may compare ids with `<`. The store orders runs by its own insertion sequence (`runs.seq`), tombstones by equality with the finalizing run's id, and `started_at` stays frozen. The pure merge layer's string comparison of run ids (`compareRuns`) needs ids that sort chronologically, which these do not, and is for callers that supply such ids.

**The same inputs run twice into one store are one run, repeated.** The store would refuse a duplicate `beginRun`, so `seamline extract` re-opens the run instead (`SqliteStore.restartRun`): the run becomes the newest in the store, its earlier results are replaced, and its writes re-stamp the facts it sees. The second pass is idempotent: nothing is duplicated, nothing is buried, one run stays on record. The same holds when a run was cut short and is retried, and when the tree returns to a state an earlier run saw after a different one in between (X, Y, X): the repeat is the newest run, restores what it sees and buries what it does not.

**A repeated id is sound whatever the digest covers.** The sweep identifies "seen by this run" by comparing a row's `last_seen_run` with the run id, and a row stored by an earlier pass already carries that id. `restartRun` therefore sets the earlier pass's sighting aside: every live node and edge stamped with the id gets a `last_seen_run` that is no run's id (`!superseded:<run id>`, which `beginRun` and `restartRun` refuse as a run id), so for the sweep the new pass starts from a graph nobody has seen. The pass's writes re-stamp what it sees, and at finalize, inside each PASS result's authoritative scope and within its selector exactly as for any run, every fact the pass did not re-observe is buried, including a fact the earlier pass stored under this very id. That is what happens when the id left out an input an extractor reads (a dependency under `node_modules`, a new TypeScript version), the case where one id carries different facts. Facts outside every PASS scope (an extractor that FAILed or was UNAVAILABLE, a scope the pass did not declare, files outside a selector) stay live with the stamp they had, because an extractor that did not look has not shown that anything vanished (AGENTS.md invariant 3). When the pass finalizes no set-aside stamp remains: a fact that stays live has this run's id again, and a buried one has an empty `last_seen_run` (no run on record has seen it) with `deleted_at` set to the run id. No reader is ever shown the set-aside stamp: the store reports a set-aside row as last seen by the run whose id the stamp carries (`visibleLastSeen`), so `why`, export and the traversals say `<run id>`. A crash between `restartRun` and `finalizeRun` leaves the stamp on the rows the pass had not re-observed, and it stays on disk until a pass at the same id finalizes and settles it. If the next run has another id (the usual case, since the tree changed) its finalize does not settle another run's stamps: a row it covers and did not see is buried as usual (`deleted_at` is that run, and the old stamp stays on a row no reader is given), and a row it does not cover stays live, read as last seen by the crashed run, which is what happened to it. The in-memory merge models the same rule (`applyRestartedRun`), and `store/sweep-agreement.test.ts` pins that it and the SQLite sweep bury the same facts, including for a repeated id. A wider digest is still worth having, since it keeps distinct inputs in distinct runs, but it is a convenience and not a safety condition.

### 4. The gates

- **Determinism gate:** extract twice, assert byte-identical SIF. Blocks release.
- **Golden-file snapshots** over canonical SIF for every extractor: structural match plus byte-identical output across two consecutive runs.
- **Rename gate (ADR-0002):** `git mv` a file, re-extract, assert every node id and every edge is unchanged.
- **Dogfood gate:** `seamline extract && seamline why` on Seamline itself, diffed against a committed baseline, asserting no unreviewed regression. This is the credibility test. An open-source project selling verification that does not pass its own gate is not shippable.

## Consequences

### Positive

- Golden-file testing becomes possible, which is what makes an extractor's behaviour reviewable in a pull-request diff instead of only in prose.
- `seamline diff` produces signal rather than noise, and a graph merge driver becomes definable.
- Rebuild-from-scratch is provably equivalent to incremental extraction, which is what lets the store stay genuinely disposable and what makes "registries are truth, the graph is derived" an operational fact rather than a slogan.
- A regression in an extractor shows up as a diff in a committed baseline, caught by the dogfood gate, rather than as a support question six weeks later.
- The gate is a *test of output*, not a review of intent. It cannot be satisfied by a maintainer believing they were careful.

### Negative

- **Parallel extraction is constrained.** Emission order must be normalized, which either serializes writes or requires a deterministic merge of parallel outputs. This is a standing performance ceiling against the 10-minute acceptance test (ADR-0005), and the two requirements pull against each other directly.
- **No timestamps on nodes means some questions get harder.** "When did this symbol first appear" is answerable through `firstSeenRun` plus the run's own `startedAt`, which is a join rather than a column read, and only at run granularity.
- **The gate is brittle in a specific, annoying way.** A dependency that changes its iteration order, or a Node release that changes `Object.keys` ordering in some edge case, fails the build with a diff that looks like our bug. Some of these will be genuine upstream drift and will cost real debugging time.
- The dogfood baseline must be regenerated and reviewed on every intentional change to extractor behaviour, which is friction on exactly the changes that most need review. That is the intended trade; it is still friction.
- Determinism hygiene rules are the kind of thing that is easy to violate in a new extractor and invisible until the gate fails. The gate catches it, but it catches it late.

## Alternatives considered

**Keep timestamps and exclude them from comparison (normalize before diffing).** Rejected. It splits the artifact into a real one and a comparison-only one, and every consumer must then know which fields are "not really data". It also does not fix the underlying problem: the stored bytes still differ, so the store is not content-addressable, a git merge driver still has nothing to work with, and rebuild-from-scratch equivalence is still uncheckable.

**Structural comparison instead of byte comparison (parse both, compare object graphs).** Rejected as the primary gate. A structural comparator is itself code that can be wrong, and it is code we would have to write and test, which makes the gate depend on the thing it is testing. Byte comparison is `diff`. Structural comparison is retained as a *secondary* assertion in golden-file tests, where its job is to produce a readable failure message.

**Determinism as a guideline with a nightly check.** Rejected: a nightly check that nobody's pull request depends on is switched off within a quarter, and by then the violations are load-bearing. C11 exists because v2 treated testing as something to schedule rather than to gate.

**Content-hash the graph and compare hashes rather than bytes.** Rejected as insufficient on its own: a hash mismatch tells you the run was nondeterministic and nothing about where. Byte comparison hands the maintainer the offending line. The hash is fine as a fast pre-check.

**Allow nondeterminism in inferred edges only, since confidence scores are approximate anyway.** Rejected: the confidence *value* may be approximate, but its computation must still be reproducible, or the same repository yields different findings on consecutive runs, which is the single fastest way to lose a user's trust in a tool that reports bugs in their code.
