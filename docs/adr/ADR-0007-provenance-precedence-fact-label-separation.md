# ADR-0007: Provenance precedence, and a structural fact/label separation enforced at the GRANT level

- **Status:** Accepted
- **Date:** 2026-08-29
- **Design reference:** `docs/design/v3.md` §2.4
- **Council finding:** C6 (CONFIRMED CRITICAL). Also §5 of the review, "what survived refutation": the provenance model was attacked as bookkeeping bloat by three lenses and held every time.
- **Corroborating prior art:** an earlier internal project reached the same insert-only annotations design independently.
- **Contract:** `packages/ontology/src/contract.ts` (`PROVENANCE`, `PROVENANCE_RANK`, `outranks()`, `isFact()`, `assertWithinCeiling()`)

## Context

v2 got the *model* right and the *enforcement* wrong.

The model, `{EXTRACTED, INFERRED, DECLARED, LLM_SUGGESTED}` plus confidence plus a source reference on every edge, was attacked by three lenses as bookkeeping bloat and survived every attack. The council's assessment is that it is the mechanism that lets agents write to the graph without corrupting it, that nothing in the 2024 to 2026 crop of AI codebase-graph tools has it, and that v2 buried it as principle 1 when it should have been the headline claim.

The enforcement was the problem, and C6 states it precisely: **provenance was a filter you had to remember to apply.** Concretely:

- A `provenance` column on a shared table means every read path must filter it. One code path that forgets, and a machine guess is served as a fact. The failure is silent and it is permanent, because by then the guess is persisted next to the facts and indistinguishable from them by anything except that column.
- Nothing stopped an extractor from labelling its own guess `EXTRACTED`. Provenance was self-asserted by the producer, with no ceiling.
- v2's merge had **no stated precedence rule for conflicting provenance claims** (finding C11/QA). Two extractors disagreeing about the same edge resolved by input order, which means merge was not deterministic, which means the determinism gate in ADR-0009 could not pass.
- Promotion of an `LLM_SUGGESTED` fact to `DECLARED` via a merged pull request **lost the attribution**. The record that a machine originally proposed the claim disappeared at exactly the moment it became authoritative.

The related structural finding is in ADR-0005: contradiction detection is a gate, and a gate fed by inference reports a machine's guess as the user's bug.

## Decision

**Provenance has a total precedence order, a per-extractor ceiling the host enforces, and a storage separation that is structural rather than conventional. On Postgres the separation is enforced at the GRANT level, not by application code.**

### 1. Total precedence order

`EXTRACTED > DECLARED > INFERRED > LLM_SUGGESTED`, encoded as `PROVENANCE_RANK` in the contract and exposed only through `outranks(a, b)`, which is strict (it never returns true for equal provenance).

Ties are broken by `(extractorPriority, runId)`. Because the order is total and the tiebreak is total, **merge produces the same winner regardless of the order the inputs arrive in**, which is exactly the property ADR-0009's determinism gate needs and which the property-based tests in v3 §7 assert (merge is associative, commutative, and idempotent over randomized orderings).

`EXTRACTED` outranks `DECLARED` deliberately. A human annotation that disagrees with the compiler is wrong, and a tool that lets a stale comment override the type checker is a tool that reports on comments.

### 2. A ceiling the host enforces

An extractor **may not assert a provenance level above the ceiling in its manifest**. `assertWithinCeiling()` throws. `infer-join`, the component that produces the field-level join that is the entire wedge of the product, has a ceiling of `INFERRED` and therefore **cannot emit `EXTRACTED`**. That is a runtime error, not a code-review question, and not a plugin author's good intentions.

### 3. Structural separation of facts from labels

`INFERRED` and `LLM_SUGGESTED` rows live in a **separate, insert-only annotations table**. They never mutate the facts tables. The separation is structural, not a convention.

**On the Postgres adapter this is enforced at the GRANT level.** The database role that writes inference has `INSERT` on the annotations table and **no `UPDATE` and no `DELETE` anywhere**. The reason to spend a role and a migration on this, rather than trusting the enum column, is stated plainly: *a `provenance` enum column alone is a weaker control, because a single bug in one code path defeats it.* A `GRANT` is not defeated by a bug in a code path; it is defeated only by a deliberate privilege change, which is a reviewable event in a migration.

Keep the enum **and** segregate the storage. They fail differently: the enum catches logic errors at read time, the GRANT catches them at write time, and neither subsumes the other.

### 4. Attribution survives promotion

Promotion to `DECLARED` writes a **new row** that retains PROV-O `wasAttributedTo`. The original machine attribution is never overwritten. Promotion is an append, like everything else in this design.

### 5. Gates read facts only

`isFact(p)` is `EXTRACTED || DECLARED`. Contradiction detectors read facts only; inference never feeds a gate. The join used to *locate* a candidate pair may be `INFERRED`, and the resulting contradiction inherits that confidence, but the two facts being compared are always facts.

## Consequences

### Positive

- Agents can write to the graph without corrupting it. This is the property that makes the tool safe to point an LLM at, and the council's judgment is that nothing comparable exists in the current crop of tools.
- Merge is deterministic by construction, which is a precondition for ADR-0009 rather than a nice property.
- A plugin cannot launder a guess into a fact. The ceiling is checked by the host at the moment of assertion.
- The GRANT-level separation converts an entire class of bug (a forgotten `WHERE provenance = ...`) from a silent correctness failure into an impossible write. Depth of defence here is cheap: one role, one migration.
- Attribution surviving promotion means the audit trail answers "who claimed this first", which is the question that matters after a bad claim ships.

### Negative

- **Two write paths, forever.** Facts and annotations are separate tables with separate roles, so every query that wants both must union them, and every schema change must be applied twice. That is a permanent structural cost, accepted in exchange for the failure mode it removes.
- The GRANT-level control **exists only on the Postgres adapter**. SQLite has no role system, so the default store enforces the separation by table boundary and application code alone. This is a real asymmetry between adapters and it must be stated rather than glossed: on SQLite, the enum-plus-separate-table is the whole control.
- `EXTRACTED > DECLARED` means a human cannot override an extractor by annotation. When an extractor is *wrong*, the user's only remedy is to fix the extractor or suppress the finding, and there is currently no suppression mechanism (waivers are deferred with the needs matrix, ADR-0005). This is a known sharp edge.
- Insert-only annotations grow without bound, on top of the tombstone growth from ADR-0003. Compaction is deferred and named as debt in both places.
- Carrying provenance, confidence, and a source reference on every node and edge is real storage and real serialization cost on a large graph. Three lenses called this bloat. They were overruled, and they were not obviously unreasonable.

## Alternatives considered

**A `provenance` enum column on one shared table, and filter on read (v2).** Rejected: this is C6. One forgotten filter serves a guess as a fact, silently and permanently. Kept as a *second* layer precisely because it is useful, just not sufficient.

**Separate stores (a facts database and an annotations database) rather than separate tables.** Rejected: it makes the union query a cross-database join and doubles the operational surface, for a stronger boundary than the threat requires. The threat is a bug in our own code path, not a hostile writer with database credentials.

**Let extractors self-assert provenance with no ceiling.** Rejected: `infer-join` is the highest-value and lowest-certainty component in the system. If anything must be prevented from asserting `EXTRACTED`, it is that. A convention would be honoured by our own code and by nobody else's.

**Confidence scores instead of discrete provenance levels.** Rejected: a continuous score has no total order that is meaningful across producers (one extractor's 0.8 is not another's), so merge stops being deterministic, and there is no principled threshold at which a gate should fire. Confidence is retained *alongside* provenance for ranking within a level, which is what it is actually good for.

**Overwrite on promotion to `DECLARED`, keeping one row per fact.** Rejected: it loses `wasAttributedTo` at the exact moment attribution starts to matter, which is v2's specific defect. Append is also consistent with every other lifecycle decision in this record.
