# ADR-0003: The run lifecycle, `run_id`, tombstones, authoritative scope, and PASS/FAIL/UNAVAILABLE

- **Status:** Accepted. Extended by [ADR-0018](ADR-0018-canonical-name-authority.md): an authoritative scope's selector may also be a canonical selector, which confines authority to named canonical identities within one source file, and the SQLite store's schema version is 2 (`authority_claims_v2` in `packages/core/src/store/schema.ts`). The decision below is unchanged.
- **Date:** 2026-08-29
- **Design reference:** `docs/design/v3.md` §2.2
- **Council findings:** C2 (CONFIRMED CRITICAL; data D1/D2, architect A2, QA F4, grill-me) and C7 (CONFIRMED CRITICAL; platform P2, architect A5).
- **Corroborating prior art:** an earlier internal project reached the same tombstoning design independently. That project is not published, so a reader cannot check this; it is context, and the decision does not rest on it (see the note in the [index](README.md)).
- **Contract:** `packages/ontology/src/contract.ts` (`RunRecord`, `AuthoritativeScope`, `ExtractorResult`, `ExtractorStatus`, `Maybe<T>`, `edgeKey()`)

## Context

Two separate defects in v2 share one root cause: the design had no concept of a _run_ as a first-class thing, so it could not distinguish the three states a fact can be in.

**C2, the graph can never forget.** v2's store interface exposed only `upsertNodes` and `upsertEdges`. It was append/upsert-only, with no tombstone, no generation marker, and no edge identity at all. A node whose source was deleted is never removed. The practical result is that stale verification edges keep the CI gate green forever, and every coverage, blast-radius, and lineage answer degrades monotonically toward wrong while continuing to look authoritative. v2 declared a `REMOVED_IN` relation in §4 and wired it to nothing. Snapshotting, `diff`, and the suspicious-links mechanism all require a versioning primitive that the design did not have.

**C7, a failed extractor is indistinguishable from a clean repo.** v2 carried no per-extractor status. When an extractor crashed, timed out, or lacked credentials, the edges it would have produced were simply absent, and absence was read by the rules engine as "this thing does not exist", and reported as a finding. Infrastructure flakiness therefore _manufactures_ false CI failures. The inverse is equally bad: a silently skipped extractor masks real findings. v2 had an `ExtractorRun.stats` field that no rule consumed.

The false-positive direction is the one that kills adoption. A CI gate that fails because a network blip made an extractor time out is a gate that gets switched off within two weeks, and it never gets switched back on.

## Decision

**Every extraction is a run with a declared authoritative scope; nodes and edges are tombstoned, never hard-deleted; and every extractor reports PASS, FAIL, or UNAVAILABLE, where UNAVAILABLE is never PASS.**

### Run and scope

1. A run has a `runId`, a `startedAt`, the repo, the commit, the ontology version, and a set of `ExtractorResult` records.
2. Each extractor declares an **authoritative scope**: the `(kind, selector)` pairs this run is the authority for. An extractor is authoritative only over what it declares. This is what makes partial extraction safe: `extract-data` failing says nothing about the truth of `extract-code-ts`'s symbols.
3. Every node and edge carries `firstSeenRun`, `lastSeenRun`, `deletedAt`, and a non-null run id.

### Tombstoning

4. After a run, core diffs the run's authoritative scope against the previous run for **that same scope**, and tombstones what vanished by setting `deletedAt`. It never hard-deletes: history is the point.
5. **`deletedAt` must be cleared on re-insert.** A tombstoned node that reappears is _resurrected_, not shadowed by a second row. This is called out explicitly because an earlier internal project shipped exactly this bug, and an implementation that re-derives the design without reading this line will ship it again.
6. Edge identity is `UNIQUE(scope, src, dst, kind)`; `edgeKey()` in the contract is the canonical form. v2 had no edge identity at all, which is why it could not express edge deletion.

### Status

7. Every extractor reports `status ∈ {PASS, FAIL, UNAVAILABLE}` plus node, edge, and duration counts. **UNAVAILABLE is never PASS.**
8. **A non-PASS extractor tombstones nothing.** This is the load-bearing half of the rule and it follows directly from the definition of authoritative scope: a run that did not complete is not the authority for what it did not observe. Tombstoning on a failed run converts a transient failure into permanent data loss, which the next successful run then has to resurrect, producing a spurious delete-and-recreate in every diff.
9. Any query whose answer depends on a scope whose producing extractor did not PASS returns `UNKNOWN` for that portion, and **never a negative finding**. The contract expresses this in the type system: `traverse()` returns `Maybe<T>`, which is `Known<T> | Unknown`, and `Unknown` carries the reason and the offending scopes. A caller cannot accidentally read an unknown as an empty result, because it does not typecheck.

**Conformance gates (CI, not guidance):**

- Delete a source file, re-extract; assert the symbol is tombstoned and its edges stop being returned.
- Kill an extractor mid-run; assert zero contradictions are reported from its scope, that the affected queries return `UNKNOWN`, and that **nothing was tombstoned**.

The second gate is the one that matters, and it is the gate v2 could not have written.

## Consequences

### Positive

- The three states a fact can be in are now distinguishable: present, known-absent, and unknown. Almost every downstream correctness property depends on that distinction existing.
- Infrastructure flakiness produces `UNKNOWN`, not a false finding. This is what makes a CI gate survivable long enough to be trusted.
- Tombstones rather than deletes give `seamline diff`, blast radius, and historical queries a real substrate, and make graph poisoning recoverable by re-running rather than by restoring a backup.
- Scoping tombstones to the authoritative scope means a partial extraction is genuinely partial. Running only `extract-code-ts` does not delete every column in the graph.

### Negative

- **The store grows monotonically.** Nothing is ever hard-deleted, so a long-lived graph over a churning repo accumulates tombstones indefinitely. A compaction or retention policy is required and is deliberately **not** specified in v0.1; that is deferred debt, and it is named here so it is not discovered later.
- Every query must filter `deletedAt IS NULL` (or explicitly opt into history). A query that forgets is silently wrong, which is precisely the class of bug the fact/label separation in ADR-0007 avoids structurally. Here we accept a convention because the alternative (separate live and tombstone tables) doubles the write path.
- `Maybe<T>` propagates through every consumer signature. That is deliberate friction: the type is the enforcement. It does make the API less pleasant than one returning a bare array.
- Declaring an authoritative scope is real work for an extractor author, and getting it wrong is subtle in both directions. Too broad and the extractor tombstones facts it never observed; too narrow and stale facts survive forever.

## Alternatives considered

**Full rebuild on every run: drop the store and re-extract everything.** Rejected as the only mechanism, though it remains supported and is the reference semantics. It does not scale to incremental extraction on large repos, and it loses `firstSeenRun`, which is needed for age-based questions and for diffing. Notably, ADR-0002's path-free identity is what makes full rebuild _equivalent_ to incremental extraction, so this is a performance choice rather than a correctness one.

**Hard-delete what vanished.** Rejected: it destroys the diff and blast-radius substrate, makes an erroneous extraction unrecoverable without a backup, and gives no way to distinguish "was never here" from "was removed in run 47".

**Timestamp-based staleness (delete anything not seen in N days).** Rejected: it depends on wall-clock time, which ADR-0009 forbids in a fact body, and it deletes correct data whenever an extractor is disabled for a while.

**Treat UNAVAILABLE as PASS with zero results.** Rejected: this _is_ C7. It is the defect, restated as a policy.

**Treat UNAVAILABLE as FAIL and abort the whole run.** Rejected as too brittle. A repo with no OpenAPI files should get code and data findings, not a hard failure. Partial results with honest `UNKNOWN` markers are strictly more useful than no results, provided (and only provided) the markers are enforced by the type system rather than by discipline.
